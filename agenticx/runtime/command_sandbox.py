"""OS-enforced filesystem isolation for Studio shell commands.

The command approval UI is intentionally not the security boundary. In the
default mode every child process is started under an operating-system sandbox
that can write only to the session's workspace roots and a private temporary
directory. Unrestricted execution is a separate, explicit permission level
and is approved by the caller before this module is invoked.

**macOS 与 Linux 上读和写都被隔离。** 可读的是:工作区根、会话显式挂进来的只读
引用、这次执行专属的临时目录,以及系统与工具链前缀(见 :func:`_toolchain_read_roots`)。
家目录不在其中——``cat ~/.ssh/id_rsa`` 会被拒。``permissions.path_rules`` 的 deny
条目同样读写一起拒:用户写下 ``**/.env`` 时想的是「别碰这个文件」,一条只挡住 ``rm``
却挡不住 ``cat`` 的规则保护的是错误的那一半。

**Windows 还没有读隔离。** ProcessContainer 本身是 read-deny-by-default,但为了让
常用工具链能跑,``_windows_readonly_paths`` 把 ``USERPROFILE`` 整个放进了
readonlyPaths,所以家目录仍然读得到。:func:`shell_read_isolation_for_host` 会如实
报出这个差别,界面据此措辞——三个平台说同一句话必然有一个平台在过度承诺。

两个平台字段不要合并::

    shell_read_isolation_for_host()   工作区之外能不能读       full / none
    path_deny_enforcement_for_host()  path_rules 的 deny 能挡多严  full / partial / none

Windows 现在是 read=none 而 deny=partial,合成一个字段就必然有一个说错。
"""

from __future__ import annotations

import base64
import hashlib
import json
import logging
import os
import shutil
import subprocess
import sys
import tempfile
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Mapping, Optional, Sequence

_log = logging.getLogger(__name__)

#: 只读：拒绝一切文件写入，只留 shell 自己需要的空设备与一块私有临时目录。
#: 调研型任务全程用这一档，命令改不了任何东西，文件类的确认框可以整体消失。
#:
#: **「只读」说的是不给写，不是「可以随便读」。** 读的范围和 workspace-write 完全
#: 一样（macOS / Linux 上），工作区之外照样读不到。调研型任务全程跑在这一档上，
#: 如果它反而是读得最宽的那一档，读隔离就形同虚设。
#:
#: **注意这不是网络隔离**——文件沙箱只管文件效果，联网与进程操作照旧要问。
READ_ONLY = "read-only"
#: 工作区可写：只有工作区根（与私有临时目录）可写，其余全部拒绝；
#: macOS / Linux 上读也限制在工作区、只读引用挂载、临时目录与工具链前缀之内。
WORKSPACE_WRITE = "workspace-write"
#: 完全访问：不做任何约束，不走 OS 后端。
DANGER_FULL_ACCESS = "danger-full-access"

COMMAND_SANDBOX_PERMISSIONS = frozenset(
    {READ_ONLY, WORKSPACE_WRITE, DANGER_FULL_ACCESS}
)
#: 真正交给 OS 后端强制的档位。
CONFINED_PERMISSIONS = frozenset({READ_ONLY, WORKSPACE_WRITE})
WINDOWS_MXC_SCHEMA_VERSION = "0.7.0-alpha"
WINDOWS_MXC_EXECUTABLE_ENV = "AGX_WINDOWS_SANDBOX_EXECUTABLE"
# Windows CreateProcess command lines are limited to 32,767 UTF-16 code units.
# Leave room for the runner path and the ``--config-base64`` argument itself.
WINDOWS_MXC_MAX_CONFIG_BASE64_CHARS = 30_000


class CommandSandboxError(RuntimeError):
    """Base error for an invalid or unavailable command sandbox."""


class CommandSandboxUnavailable(CommandSandboxError):
    """Raised when the host cannot enforce the requested permission level."""


@dataclass(frozen=True)
class CommandSandboxPlan:
    """A fully resolved subprocess launch plan."""

    argv: tuple[str, ...]
    env: Mapping[str, str]
    permissions: str
    backend: str
    writable_roots: tuple[Path, ...] = ()
    #: 除可写根之外还能被读到的目录：会话的只读引用挂载 + 系统与工具链前缀。
    #: 家目录**不在其中**——工作区之外的东西读不到，这是读隔离的全部内容。
    #:
    #: 只在 ``read_isolation == "full"`` 时是完整的。Windows 上实际可读的范围更大
    #: （``_windows_readonly_paths`` 另外放行了 ``USERPROFILE``），那一档不要拿这个
    #: 字段当准确清单用——``read_isolation`` 已经说了那里没有读隔离。
    readable_roots: tuple[Path, ...] = ()
    temp_dir: Optional[Path] = None
    #: ``permissions.path_rules`` 里的拒绝模式，已下沉到 OS 后端的那些。
    deny_patterns: tuple[str, ...] = ()
    #: Linux / Windows 上被逐条挂成只读的具体路径（macOS 用正则，不需要枚举）。
    denied_write_paths: tuple[Path, ...] = ()
    #: 这个后端有没有隔离**读取**。``"full"`` = 工作区、只读挂载、临时目录、
    #: 工具链之外读不到；``"none"`` = 只隔离了写。
    #:
    #: 和 ``deny_enforcement`` 是两件事,别合并:前者说的是「工作区外能不能读」,
    #: 后者说的是「path_rules 的 deny 能挡多严」。Windows 现在是 read=none 而
    #: deny=partial——两个字段各自都对,合成一个就必然有一个平台被说错。
    read_isolation: str = "none"
    #: ``"none"`` 没有拒绝规则；``"full"`` 后端能完整表达它们；
    #: ``"partial"`` 只挡住了启动时**已经存在**的匹配路径。
    #:
    #: 这个字段存在的唯一理由是不许再过度承诺。macOS 的 seatbelt 收正则，
    #: 一条 glob 能原样表达，运行中新建的文件也照样挡；bubblewrap 和 Windows
    #: ProcessContainer 只认具体路径，只能在启动前枚举一次。差别必须能被上层看见，
    #: 而不是让界面在三个平台上说同一句办不到的话。
    deny_enforcement: str = "none"


def normalize_command_permissions(value: object) -> str:
    """Return a supported permission value, defaulting to workspace isolation."""

    if value is None:
        return WORKSPACE_WRITE
    text = str(value).strip().lower()
    if not text:
        return WORKSPACE_WRITE
    if text not in COMMAND_SANDBOX_PERMISSIONS:
        supported = ", ".join(sorted(COMMAND_SANDBOX_PERMISSIONS))
        raise CommandSandboxError(
            f"unsupported sandbox_permissions={text!r}; expected one of: {supported}"
        )
    return text


def path_deny_enforcement_for_host(platform_name: Optional[str] = None) -> str:
    """这台机器上，``path_rules`` 的拒绝规则能被沙箱执行到什么程度。

    界面拿它来决定怎么措辞。硬编码一句话在三个平台上都说,必然有两个平台是在
    过度承诺——这正是这轮之前那版文案的问题。

    Returns:
        ``"full"``    macOS:seatbelt 收正则,glob 原样表达,运行中新建的文件也挡。
        ``"partial"`` Linux / Windows:只认具体路径,只能挡住启动时已存在的匹配。
        ``"none"``    没有可用后端,这台机器上根本没有强制。
    """
    host = (platform_name or sys.platform).strip().lower()
    if host == "darwin":
        return "full"
    if host.startswith("linux") or host == "win32" or host.startswith("win"):
        return "partial"
    return "none"


def shell_read_isolation_for_host(platform_name: Optional[str] = None) -> str:
    """这台机器上，Shell 的**读取**有没有被限制在工作区内。

    界面据此措辞。和 :func:`path_deny_enforcement_for_host` 分开是因为两者会不一致:
    Windows 上 deny 规则能挡住写(partial),但读仍然放得很开——``_windows_readonly_paths``
    为了让工具链能跑，把 ``USERPROFILE`` 整个放进了 readonlyPaths。合成一个字段就必然
    要在某个平台上说一句不成立的话。

    Returns:
        ``"full"``  macOS / Linux:工作区、只读挂载、临时目录、系统与工具链之外读不到。
        ``"none"``  其余(含 Windows):只隔离了写。
    """
    host = (platform_name or sys.platform).strip().lower()
    if host == "darwin" or host.startswith("linux"):
        return "full"
    return "none"


def build_command_sandbox_plan(
    argv: Sequence[str],
    *,
    permissions: object = WORKSPACE_WRITE,
    writable_roots: Iterable[Path] = (),
    readable_roots: Iterable[Path] = (),
    scope_id: str = "default",
    cwd: Optional[Path] = None,
    environ: Optional[Mapping[str, str]] = None,
    platform_name: Optional[str] = None,
    denied_path_patterns: Iterable[str] = (),
) -> CommandSandboxPlan:
    """Wrap ``argv`` in the host sandbox required by ``permissions``.

    ``workspace-write`` never degrades to unrestricted execution. A missing
    backend raises :class:`CommandSandboxUnavailable`; the caller may then ask
    the user to approve a new invocation with ``danger-full-access``.
    """

    raw_argv = tuple(str(part) for part in argv)
    if not raw_argv or not raw_argv[0]:
        raise CommandSandboxError("command argv must not be empty")

    resolved_permissions = normalize_command_permissions(permissions)
    base_env = dict(os.environ if environ is None else environ)
    if resolved_permissions == DANGER_FULL_ACCESS:
        # 这一档**不套任何沙箱**，因此 ``denied_path_patterns`` 在这里不生效——
        # 这是定义，不是遗漏。名字就是这个意思：一次性突破全部文件隔离。
        #
        # 造一个「几乎 full access、但还保留路径规则」的第四档只会让人更难判断自己
        # 到底放行了什么。代价用另外两条约束兜住：
        #   1. 确认框明说会绕过路径规则（见 ConfirmDialog 的 full-access 分支）；
        #   2. 永远不能被持久化——``host_full_access`` 在
        #      NEVER_AUTO_APPROVED_CATEGORIES 里，且 protectedConfirmReuseMode 只对
        #      workspace-write 提供复用。每一次都得重新点。
        return CommandSandboxPlan(
            argv=raw_argv,
            env=base_env,
            permissions=resolved_permissions,
            backend="none",
        )

    if resolved_permissions == READ_ONLY:
        # 只读档不需要工作区可写根：唯一可写的是这次执行专属的临时目录。给它是因为 shell
        # 与常见工具（git、python）没有可写 temp 会直接坏掉，而这块目录在工作区之外、
        # 用完即弃，写进去的东西不构成任何持久影响。
        roots: tuple[Path, ...] = ()
        # 但工作区必须**降级成可读**，不能整个丢掉。「只读」的意思是不给写，不是
        # 「连要调研的那个目录也看不见」。加上读隔离之后这条才有后果：丢掉它，
        # 连 shell 自己的 getcwd 都会失败（``error retrieving current directory``），
        # 而调研型任务全程跑在这一档上。
        readable_roots = (*readable_roots, *writable_roots)
    else:
        roots = _normalize_writable_roots(writable_roots)
        if not roots:
            raise CommandSandboxUnavailable(
                "workspace-write requires at least one existing writable workspace root"
            )

    deny_patterns = tuple(
        text for raw in denied_path_patterns if (text := str(raw or "").strip())
    )

    temp_dir = _private_temp_dir(scope_id)
    allowed_roots = _normalize_writable_roots((*roots, temp_dir))
    base_env["TMPDIR"] = str(temp_dir)

    host = (platform_name or sys.platform).strip().lower()
    # 可读集合 = 会话给的只读引用 + 工具链/系统目录。工作区根不在这里——它可写，
    # 各后端自己把「可写必然可读」表达出来。**家目录不在其中**，这正是读隔离的全部
    # 意义：工作区之外的东西读不到。
    #
    # read-only 档也走同一套：那一档只是不给写，不代表可以随便读别人的仓和 ~/.ssh。
    allowed_read_roots = _normalize_writable_roots(readable_roots)
    toolchain_read_roots = _toolchain_read_roots(base_env, raw_argv, host=host)
    toolchain_read_files = _toolchain_read_files(base_env)
    confined_read_roots = _normalize_writable_roots(
        (*allowed_read_roots, *toolchain_read_roots)
    )
    # 枚举 deny 路径时要走的根。
    #
    # 只用 ``allowed_roots``（工作区 + 临时目录）会漏掉**只读引用挂载**:那些目录被
    # ro-bind 进来因而可读,里面命中拒绝规则的文件却一条都没被覆盖,于是 Linux 上
    # ``cat reference/.env`` 照样读得到。macOS 没这个问题——它下沉的是正则,天然覆盖
    # 所有路径;只认具体路径的后端必须自己把范围补齐。
    #
    # **不含工具链与系统前缀**（``/usr``、``/etc``、各语言的安装目录）。那不是保守,
    # 是必须:每条命令都去遍历 ``/usr`` 一次,既慢到不可接受,又会瞬间撞满 512 条的
    # 枚举上限,把本来枚举得全的工作区那部分挤掉——**保护面反而更小**。
    deny_scan_roots = _normalize_writable_roots((*allowed_roots, *allowed_read_roots))
    if host == "darwin":
        executable = Path("/usr/bin/sandbox-exec")
        if not executable.is_file() or not os.access(executable, os.X_OK):
            raise CommandSandboxUnavailable("macOS sandbox-exec is not available")
        profile = _macos_profile(
            allowed_roots,
            deny_patterns,
            readable_roots=confined_read_roots,
            readable_files=toolchain_read_files,
        )
        wrapped = (str(executable), "-p", profile, *raw_argv)
        backend = "macos-sandbox-exec"
        # seatbelt 收正则，一条 glob 能原样表达：运行过程中新建的文件也照样被挡。
        deny_enforcement = "full" if deny_patterns else "none"
        denied_paths: tuple[Path, ...] = ()
    elif host.startswith("linux"):
        executable_text = shutil.which("bwrap")
        if not executable_text:
            raise CommandSandboxUnavailable(
                "bubblewrap (bwrap) is required for workspace-write on Linux"
            )
        denied_paths, complete = (
            _enumerate_denied_paths(deny_scan_roots, deny_patterns)
            if deny_patterns
            else ((), True)
        )
        wrapped = _bubblewrap_argv(
            executable_text,
            raw_argv,
            allowed_roots,
            cwd=cwd,
            denied_paths=denied_paths,
            readable_roots=confined_read_roots,
            readable_files=toolchain_read_files,
        )
        backend = "linux-bubblewrap"
        # bubblewrap 只认具体路径,没有 glob。只能在启动前枚举一次,所以运行过程中
        # 新建的匹配文件挡不住——如实报 partial,别让界面在这里说和 macOS 一样的话。
        deny_enforcement = "none" if not deny_patterns else "partial"
        if deny_patterns and not complete:
            # 撞到枚举上限:连**启动时已存在**的匹配路径都没挡全。仍然是 partial,
            # 但性质更糟,值得留一条日志——否则这是一次完全无声的降级。
            _log.warning(
                "path_rules deny enumeration hit the %d-path cap in %s; "
                "some existing matches are still writable",
                MAX_ENUMERATED_DENY_PATHS,
                ", ".join(str(root) for root in deny_scan_roots),
            )
    elif host == "win32" or host.startswith("win"):
        executable = _windows_mxc_executable(base_env)
        base_env["TEMP"] = str(temp_dir)
        base_env["TMP"] = str(temp_dir)
        denied_paths, complete = (
            _enumerate_denied_paths(deny_scan_roots, deny_patterns)
            if deny_patterns
            else ((), True)
        )
        if deny_patterns and not complete:
            _log.warning(
                "path_rules deny enumeration hit the %d-path cap in %s; "
                "some existing matches are still writable",
                MAX_ENUMERATED_DENY_PATHS,
                ", ".join(str(root) for root in deny_scan_roots),
            )
        wrapped = _windows_mxc_argv(
            executable,
            raw_argv,
            allowed_roots,
            readable_roots=allowed_read_roots,
            cwd=cwd,
            scope_id=scope_id,
            environ=base_env,
            denied_paths=denied_paths,
        )
        backend = "windows-mxc-process-container"
        # 与 Linux 同理:ProcessContainer 的 readonlyPaths 是具体路径列表。
        deny_enforcement = "none" if not deny_patterns else "partial"
    else:
        raise CommandSandboxUnavailable(
            f"workspace-write has no supported OS sandbox backend on {host or 'this host'}"
        )

    return CommandSandboxPlan(
        argv=wrapped,
        env=base_env,
        permissions=resolved_permissions,
        backend=backend,
        writable_roots=allowed_roots,
        readable_roots=confined_read_roots,
        temp_dir=temp_dir,
        deny_patterns=deny_patterns,
        denied_write_paths=denied_paths,
        deny_enforcement=deny_enforcement,
        read_isolation=shell_read_isolation_for_host(host),
    )


def _normalize_writable_roots(roots: Iterable[Path]) -> tuple[Path, ...]:
    out: list[Path] = []
    seen: set[str] = set()
    for raw in roots:
        try:
            path = Path(raw).expanduser().resolve(strict=False)
        except (OSError, RuntimeError, TypeError, ValueError):
            continue
        if not path.is_dir():
            continue
        key = os.path.normcase(str(path))
        if key in seen:
            continue
        seen.add(key)
        out.append(path)
    return tuple(out)


def _private_temp_dir(scope_id: str) -> Path:
    raw_scope = str(scope_id or "default").encode("utf-8", errors="replace")
    digest = hashlib.sha256(raw_scope).hexdigest()[:20]
    root = Path(tempfile.gettempdir()).resolve(strict=False) / "agenticx-command-sandbox"
    target = root / digest
    target.mkdir(mode=0o700, parents=True, exist_ok=True)
    try:
        target.chmod(0o700)
    except OSError:
        pass
    return target.resolve(strict=False)


def _scheme_string(value: str) -> str:
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


#: 枚举拒绝路径时的上限。工作区可以很大（node_modules 之类），而这段代码跑在**每条
#: 命令**的启动路径上。撞到上限不是失败，是把 deny_enforcement 降级成 "partial"
#: 并如实报出去——静悄悄地少挡几条才是真正的问题。
MAX_ENUMERATED_DENY_PATHS = 512


def _scheme_regex_literal(regex: str) -> str:
    """Quote a regex for SBPL's ``#"…"`` literal.

    **不能复用** :func:`_scheme_string`。它按 Scheme 字符串的规矩把 ``\\`` 翻倍，
    而在正则字面量里 ``\\.`` 的意思是「一个反斜杠再跟任意字符」——本来想表达的
    「字面的点」就没了，规则静悄悄地匹配不到任何东西。实测过：``deny */.env``
    在翻倍之后完全不生效，``rm .env`` 照样删掉。
    """
    return '"' + regex.replace('"', '\\"') + '"'


def _glob_to_posix_regex(pattern: str) -> str:
    """Translate one ``path_rules`` glob into a seatbelt-compatible regex.

    必须和 :func:`agenticx.runtime.path_policy.match_path_rules` 判一样的路径，
    否则「设置里写了拒绝」在弹框那关和在沙箱那关会得出两个答案。那里用的是
    :func:`fnmatch.fnmatch`，所以 ``*`` **跨 ``/``**——不是 shell 里那个不跨目录的
    ``*``。这里照搬这个语义，别自作主张收紧。

    不能直接用 ``fnmatch.translate``：它生成的是 Python 正则（``(?s:…)\\Z``），
    seatbelt 收的是 POSIX 扩展正则。
    """
    text = pattern.replace("\\", "/")
    out = ["^"]
    index = 0
    length = len(text)
    while index < length:
        char = text[index]
        index += 1
        if char == "*":
            out.append(".*")
        elif char == "?":
            out.append(".")
        elif char == "[":
            # fnmatch 的字符类要原样保留。把 [ 一律转义会让 ``secret[0-9].key``
            # 在弹框那关是字符类、在沙箱那关变成字面量——两处判定分叉。
            close = text.find("]", index + 1 if index < length and text[index] in "!]" else index)
            if close < 0:
                out.append("\\[")  # 没有闭合，fnmatch 视作字面量
                continue
            body = text[index:close]
            index = close + 1
            if body.startswith("!"):
                body = "^" + body[1:]
            out.append("[" + body.replace("\\", "\\\\") + "]")
        elif char in ".^$+(){}]|\\":
            out.append("\\" + char)
        else:
            out.append(char)
    out.append("$")
    return "".join(out)


def _enumerate_denied_paths(
    writable_roots: Sequence[Path],
    patterns: Sequence[str],
) -> tuple[tuple[Path, ...], bool]:
    """Concrete paths under ``writable_roots`` that a deny rule matches.

    只在可写根里找。工作区之外本来就写不进去——沙箱已经拒了——所以一条
    ``deny /etc/*`` 不需要这里做任何事。这个约束把「遍历整个磁盘」缩成
    「遍历工作区」，也是这套做法能跑在命令启动路径上的原因。

    Returns:
        ``(paths, complete)``。``complete`` 为 False 表示撞到了枚举上限，
        调用方必须把 deny_enforcement 降级。
    """
    from agenticx.runtime.path_policy import match_path_rules

    rules = [(pattern, False) for pattern in patterns]
    found: list[Path] = []
    seen: set[str] = set()
    complete = True
    for root in writable_roots:
        for current, dirnames, filenames in os.walk(root, followlinks=False):
            if len(found) >= MAX_ENUMERATED_DENY_PATHS:
                complete = False
                break
            base = Path(current)
            # 目录被拒时整棵子树都不必再进——挂成只读之后里面本来也写不了。
            kept: list[str] = []
            for name in dirnames:
                child = base / name
                decision, _ = match_path_rules(child, rules)
                if decision is False:
                    key = os.path.normcase(str(child))
                    if key not in seen:
                        seen.add(key)
                        found.append(child)
                else:
                    kept.append(name)
            dirnames[:] = kept
            for name in filenames:
                child = base / name
                decision, _ = match_path_rules(child, rules)
                if decision is False:
                    key = os.path.normcase(str(child))
                    if key not in seen:
                        seen.add(key)
                        found.append(child)
                if len(found) >= MAX_ENUMERATED_DENY_PATHS:
                    complete = False
                    break
        if not complete:
            break
    return tuple(found), complete


#: 读隔离下仍然必须可读的系统目录（POSIX 共有的部分）。
#:
#: 读隔离的价值在于「工作区之外的东西读不到」，不是「什么都读不到」。后者会让
#: python / node / git 在动态链接阶段就死掉，用户看到一堆无法归因的报错，然后把整个
#: 功能关掉——那比不做读隔离更糟。所以系统与工具链目录是显式放行的，名单写在这里，
#: 而不是散在两个后端各写一份。
_POSIX_SYSTEM_READ_ROOTS: tuple[str, ...] = (
    "/bin",
    "/sbin",
    "/usr",
    "/etc",
    "/opt",
    "/lib",
    "/lib64",
    "/var/lib",
    "/var/db",
    "/var/select",
)
#: macOS 特有：系统库、开发者工具、dyld 缓存。缺了它们连 /bin/sh 都起不来。
_MACOS_SYSTEM_READ_ROOTS: tuple[str, ...] = (
    # Linux 那边不列 /dev：bwrap 用 ``--dev /dev`` 挂一块最小的私有 devtmpfs，
    # 再 ro-bind 宿主的 /dev 会把它整个盖回去，等于白挂。seatbelt 没有这层，
    # 所以 /dev 只出现在 macOS 这一侧。
    "/dev",
    "/System",
    "/Library",
    "/private/etc",
    "/private/var/db",
    "/private/var/select",
    "/private/var/run",
    "/Applications/Xcode.app",
)
#: Linux 特有：Nix / Flatpak 之类的自带前缀，存在才绑。
_LINUX_SYSTEM_READ_ROOTS: tuple[str, ...] = (
    "/nix",
    "/snap",
    "/run/current-system",
)

#: 指向工具链安装位置的环境变量。与 :func:`_windows_readonly_paths` 用的是同一张表——
#: 「工具链装在哪」这个问题不该在三个平台上有三种答案。
_TOOLCHAIN_PATH_ENV_KEYS: tuple[str, ...] = (
    "PATH",
    "PYTHONPATH",
    "PYTHONHOME",
    "VIRTUAL_ENV",
    "CONDA_PREFIX",
    "NODE_PATH",
    "NVM_DIR",
    "PNPM_HOME",
    "BUN_INSTALL",
    "DENO_DIR",
    "GOPATH",
    "GOROOT",
    "CARGO_HOME",
    "RUSTUP_HOME",
    "JAVA_HOME",
    "SDKMAN_DIR",
    "GEM_HOME",
    "RBENV_ROOT",
    "PYENV_ROOT",
    "ASDF_DIR",
    "ASDF_DATA_DIR",
)

#: 家目录下按名字放行的少数几个工具配置。**每一条都要能说清为什么。**
#:
#: 这里是读隔离最容易被悄悄掏空的地方:每加一条,保护面就少一块。所以只收「不加就
#: 明显坏掉、而且本身不是凭据」的:git 不读 ``~/.gitconfig`` 就没有 user.name,
#: 提交直接失败,用户只会觉得是产品坏了。
#:
#: 明确**不放行**、且不要因为「某某命令报错了」就加进来的:``~/.ssh``、``~/.aws``、
#: ``~/.netrc``、``~/.npmrc``、``~/.config/gh``、``~/.kube``、``~/.docker``——
#: 它们装的正是这轮要防住的东西。真需要,让用户把那个目录显式挂成只读引用,
#: 或者用一次 ``danger-full-access``:两条路都留着,而且都会留下痕迹。
_HOME_TOOL_CONFIG_NAMES: tuple[str, ...] = (
    ".gitconfig",
    ".gitignore_global",
    ".config/git",
)


def _existing_dirs(candidates: Iterable[Path]) -> tuple[Path, ...]:
    """Resolve, de-duplicate, and drop anything that is not an existing directory.

    两个后端都需要这一步:bwrap 绑一个不存在的源路径会直接失败,seatbelt 里一条指向
    不存在目录的 subpath 只是噪音。
    """
    out: list[Path] = []
    seen: set[str] = set()
    for raw in candidates:
        try:
            path = Path(raw).expanduser().resolve(strict=False)
        except (OSError, RuntimeError, TypeError, ValueError):
            continue
        if not path.is_dir():
            continue
        key = os.path.normcase(str(path))
        if key in seen:
            continue
        seen.add(key)
        out.append(path)
    return tuple(out)


def _over_broad_read_roots(environ: Mapping[str, str]) -> frozenset[str]:
    """放进可读名单就等于把读隔离整个作废的那些路径。

    这不是防御性编程,是修一个已经发生过的 bug:``/bin/sh`` 的前缀推导
    (``parent.name == "bin"`` → 上一级)算出来是 ``/``,于是名单里多了一条
    ``(allow file-read-data (subpath "/"))``——**其余三十条规则一条都没错,
    整个功能却完全失效**,而且写规则照常生效,表面上沙箱在正常工作。

    这类失效没有任何症状:不报错、不降级、日志里什么都没有,只有实跑一次外部读取
    才看得出来。所以必须在这里挡一道,而不是靠每次改动都记得检查。
    """
    blocked = {"/", "/Users", "/home", "/root", "/private", "/Volumes"}
    for key in ("HOME", "USERPROFILE"):
        value = str(environ.get(key, "") or "").strip()
        if value:
            try:
                blocked.add(str(Path(value).expanduser().resolve(strict=False)))
            except (OSError, RuntimeError, ValueError):
                continue
    return frozenset(os.path.normcase(text) for text in blocked)


def _toolchain_read_roots(
    environ: Mapping[str, str],
    argv: Sequence[str],
    *,
    host: str,
) -> tuple[Path, ...]:
    """Directories a confined command must still be able to read from.

    三个来源，都是「不给就跑不起来」而不是「给了方便」：

    1. 系统目录——``/usr``、``/etc``、macOS 的 ``/System`` 之类。
    2. ``PATH`` 与工具链环境变量指向的前缀。虚拟环境、pyenv、nvm、cargo 装在哪
       完全取决于用户，写死一份猜测的清单必然漏，读环境变量才是唯一可靠的问法。
    3. 被执行的那个可执行文件所在的前缀。``/some/venv/bin/python`` 要能读到
       ``/some/venv/lib``，所以 ``bin/`` 结尾时连它的上一级一起放行。

    **不包含家目录。** 这正是这轮要挡住的东西：``~/.ssh``、``~/.aws``、别的仓库、
    文稿。少数几个工具配置按名字单独放行，见 :data:`_HOME_TOOL_CONFIG_NAMES`。
    """
    candidates: list[Path] = [Path(text) for text in _POSIX_SYSTEM_READ_ROOTS]
    if host == "darwin":
        candidates.extend(Path(text) for text in _MACOS_SYSTEM_READ_ROOTS)
    elif host.startswith("linux"):
        candidates.extend(Path(text) for text in _LINUX_SYSTEM_READ_ROOTS)

    for key in _TOOLCHAIN_PATH_ENV_KEYS:
        value = str(environ.get(key, "") or "").strip()
        if not value:
            continue
        for part in value.split(os.pathsep):
            text = part.strip()
            if text:
                candidates.append(Path(text))

    # 解释器自己的前缀。子代理经常就用同一个 python 跑东西，而它可能装在一个
    # 上面几条都覆盖不到的地方（uv、pyenv、系统外的 framework 目录）。
    for prefix in (sys.prefix, sys.base_prefix, sys.exec_prefix):
        text = str(prefix or "").strip()
        if text:
            candidates.append(Path(text))

    if argv:
        first = str(argv[0] or "").strip()
        resolved = shutil.which(first, path=str(environ.get("PATH", "") or "")) or (
            first if first and Path(first).is_absolute() else ""
        )
        if resolved:
            binary = Path(resolved)
            candidates.append(binary.parent)
            # ``/some/venv/bin/python`` 要能读到 ``/some/venv/lib``,所以 bin/ 结尾时
            # 连上一级前缀一起放行。但 ``/bin/sh`` 的上一级是 ``/``——那一条会把整个
            # 读隔离作废,见 :func:`_over_broad_read_roots`,那里会兜住。
            if binary.parent.name == "bin":
                candidates.append(binary.parent.parent)

    home_text = str(environ.get("HOME", "") or "").strip()
    if home_text:
        home = Path(home_text)
        for name in _HOME_TOOL_CONFIG_NAMES:
            candidates.append(home / name)

    blocked = _over_broad_read_roots(environ)
    return tuple(
        path
        for path in _existing_dirs(candidates)
        if os.path.normcase(str(path)) not in blocked
    )


def _toolchain_read_files(environ: Mapping[str, str]) -> tuple[Path, ...]:
    """家目录下按名字放行的工具配置里，**是文件**的那些。

    分开返回是因为 seatbelt 对文件和目录的写法不同（``literal`` / ``subpath``），
    而把一个文件写成 subpath 会连带放开它的兄弟节点——``~/.gitconfig`` 写错成
    ``~`` 的 subpath，这轮做的事就整个白做了。
    """
    home_text = str(environ.get("HOME", "") or "").strip()
    if not home_text:
        return ()
    out: list[Path] = []
    seen: set[str] = set()
    for name in _HOME_TOOL_CONFIG_NAMES:
        try:
            path = (Path(home_text) / name).expanduser().resolve(strict=False)
        except (OSError, RuntimeError, ValueError):
            continue
        if not path.is_file():
            continue
        key = os.path.normcase(str(path))
        if key not in seen:
            seen.add(key)
            out.append(path)
    return tuple(out)


def _macos_profile(
    writable_roots: Sequence[Path],
    deny_patterns: Sequence[str] = (),
    readable_roots: Sequence[Path] = (),
    readable_files: Sequence[Path] = (),
) -> str:
    """Build the seatbelt profile: reads and writes are both confined.

    读边界的形状和写边界不一样,有两处值得单独说明。

    **拒的是 ``file-read-data``,不是 ``file-read*``。** 后者连元数据一起拒,而要访问
    ``/Users/me/proj/x`` 就得先 stat 它的每一级祖先——``/``、``/Users``、``/Users/me``
    都不在放行名单里,于是**允许的路径也访问不了**,沙箱变成什么都跑不动。放行元数据
    的代价是泄露「某个路径存不存在、多大、什么时候改的」;拿不到内容。这个取舍要写在
    这里,不然下一个人只会看到一个没解释的 ``file-read-metadata`` 然后把它删掉。

    **``/dev`` 整个放行。** shell 自己要 ``/dev/null``、``/dev/tty``、``/dev/urandom``,
    少一个就是一类无法归因的失败。

    规则顺序:seatbelt 里后面的覆盖前面的,所以 deny 一律排在 allow 之后。这条在写
    规则上踩过一次——deny 写在前面会被工作区那条 subpath 整个盖掉,规则等于没写。
    """
    lines = [
        "(version 1)",
        "(allow default)",
        "(deny file-read-data file-write*)",
        # 见 docstring:祖先目录的 stat 必须放行,否则允许的路径也走不到。
        "(allow file-read-metadata)",
        '(allow file-read-data file-write* (literal "/dev/null"))',
        '(allow file-read-data (subpath "/dev"))',
        # 根目录本身。**少了这一行，任何进程都起不来**——dyld 在解析路径时要读 "/"，
        # 读不到就直接 abort：退出码 134，stdout / stderr 一个字都没有。
        # 花了一轮二分才定位到它，所以写在这里而不是指望下一个人也二分一次。
        '(allow file-read-data (literal "/"))',
    ]
    lines.extend(
        f"(allow file-read-data (subpath {_scheme_string(str(root))}))"
        for root in readable_roots
    )
    lines.extend(
        f"(allow file-read-data (literal {_scheme_string(str(path))}))"
        for path in readable_files
    )
    # 可写必然可读:工作区根不重复写进上面那一组,这里一并给。
    for root in writable_roots:
        quoted = _scheme_string(str(root))
        lines.append(f"(allow file-read-data (subpath {quoted}))")
        lines.append(f"(allow file-write* (subpath {quoted}))")
    # 拒绝规则必须排在允许之后:seatbelt 里后面的规则覆盖前面的。放在前面会被
    # 工作区那条 (allow … subpath) 整个盖掉,规则等于没写。
    #
    # 读写一起拒。用户写下 `**/.env` 时想的是「别碰这个文件」,不是「别写这个文件」——
    # 一条只挡住 rm 却挡不住 cat 的规则,保护的是错误的那一半。
    lines.extend(
        f"(deny file-read-data file-write* "
        f"(regex #{_scheme_regex_literal(_glob_to_posix_regex(pattern))}))"
        for pattern in deny_patterns
    )
    return "\n".join(lines)


def _bubblewrap_argv(
    executable: str,
    argv: tuple[str, ...],
    writable_roots: Sequence[Path],
    *,
    cwd: Optional[Path],
    denied_paths: Sequence[Path] = (),
    readable_roots: Sequence[Path] = (),
    readable_files: Sequence[Path] = (),
) -> tuple[str, ...]:
    """Build the bubblewrap argv: nothing is visible unless it is bound in.

    以前第一条是 ``--ro-bind / /``——整个根文件系统原样挂进来,于是读边界根本不存在:
    ``cat ~/.ssh/id_rsa`` 照读不误。现在改成逐条绑,**家目录不在其中**,所以工作区
    之外的东西在命名空间里根本不出现(报 ENOENT,不是 EACCES)。

    用 ``--ro-bind-try`` 而不是 ``--ro-bind``:名单里有一半路径在任一台具体机器上都
    不存在(``/nix``、``/snap``、没装的工具链前缀),而 ``--ro-bind`` 撞到不存在的源
    路径会让整个 bwrap 失败——那会把「这台机器上没装 rust」变成「所有命令都跑不了」。

    顺序有两处不能动:
    - 可写绑定排在只读之后。后一次绑定覆盖前一次,反了工作区就成只读的了。
    - 拒绝规则排在最后,理由同上。
    """
    wrapped: list[str] = [
        executable,
        "--die-with-parent",
        "--new-session",
        "--proc",
        "/proc",
        "--dev",
        "/dev",
    ]
    for root in readable_roots:
        path = str(root)
        wrapped.extend(("--ro-bind-try", path, path))
    for path_obj in readable_files:
        path = str(path_obj)
        wrapped.extend(("--ro-bind-try", path, path))
    for root in writable_roots:
        path = str(root)
        wrapped.extend(("--bind", path, path))
    # 排在可写绑定之后:bwrap 里后一次绑定覆盖前一次,顺序反了这些路径仍然可写。
    #
    # 读也要挡住,所以不能只是把它重新挂成只读。文件用 /dev/null 盖掉(读到空、
    # 写被拒),目录用一块只读 tmpfs 盖掉(看到空目录)。两种都不是「报错」而是
    # 「什么都没有」——内容确实拿不到了,这是这条规则真正要的效果。
    for denied in denied_paths:
        path = str(denied)
        if denied.is_dir():
            wrapped.extend(("--tmpfs", path, "--remount-ro", path))
        else:
            wrapped.extend(("--ro-bind", "/dev/null", path))
    # 最后一步:把命名空间的根重挂成只读。
    #
    # bwrap 的新根是一块 tmpfs,而绑定目标的父目录会被自动创建。于是没有被绑进来的
    # 路径**依然可写**——写 ``/work/outside.txt`` 会成功,只是落在那块用完即弃的
    # tmpfs 上,宿主毫发无损。安全属性是对的,可模型拿到的是一次**假的成功**:
    # 它以为文件写出去了,后面的步骤全建立在这个误解上。实跑 Linux 验收时就是这么
    # 露出来的(rc=0、没有任何输出)。
    #
    # 重挂之后同一条命令报 ``Read-only file system``,而工作区那条 bind 是独立的挂载,
    # 不受影响,照常可写。
    wrapped.append("--remount-ro")
    wrapped.append("/")
    if cwd is not None:
        wrapped.extend(("--chdir", str(cwd.resolve(strict=False))))
    wrapped.extend(("--", *argv))
    return tuple(wrapped)


def _windows_mxc_executable(environ: Mapping[str, str]) -> str:
    """Resolve the bundled Microsoft MXC runner without unsafe fallback."""

    configured = str(environ.get(WINDOWS_MXC_EXECUTABLE_ENV, "") or "").strip()
    if configured:
        candidate = Path(configured).expanduser()
        if candidate.is_file():
            return str(candidate.resolve(strict=False))
        raise CommandSandboxUnavailable(
            f"configured Windows sandbox runner does not exist: {candidate}"
        )

    discovered = shutil.which("wxc-exec.exe") or shutil.which("wxc-exec")
    if discovered and Path(discovered).is_file():
        return str(Path(discovered).resolve(strict=False))
    raise CommandSandboxUnavailable(
        "Microsoft MXC wxc-exec.exe is required for workspace-write on Windows; "
        f"install the bundled desktop runtime or set {WINDOWS_MXC_EXECUTABLE_ENV}"
    )


def _path_is_within(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def _windows_readonly_paths(
    writable_roots: Sequence[Path],
    *,
    readable_roots: Sequence[Path],
    argv: Sequence[str],
    cwd: Optional[Path],
    environ: Mapping[str, str],
) -> tuple[Path, ...]:
    """Grant compatibility reads without granting another writable tree.

    Windows ProcessContainer is read-deny-by-default. Session read mounts, the
    user's existing profile, and discovered toolchain directories keep normal
    development commands working while the deeper workspace grants remain the
    only writable host paths. Windows/system program directories normally
    already carry ``ALL APPLICATION PACKAGES`` read ACLs and are deliberately
    not mutated here.
    """

    candidates: list[Path] = list(readable_roots)
    for key in ("USERPROFILE",):
        value = str(environ.get(key, "") or "").strip()
        if value:
            candidates.append(Path(value))
    for key in (
        "PYTHONPATH",
        "PYTHONHOME",
        "VCINSTALLDIR",
        "VSINSTALLDIR",
        "PSModulePath",
        "VCPKG_ROOT",
        "GOPATH",
        "GOROOT",
        "CARGO_HOME",
        "RUSTUP_HOME",
        "JAVA_HOME",
        "NVM_HOME",
        "NVM_SYMLINK",
        "NODE_PATH",
        "DOTNET_ROOT",
        "CONDA_PREFIX",
        "VIRTUAL_ENV",
    ):
        value = str(environ.get(key, "") or "").strip()
        if not value:
            continue
        candidates.extend(Path(part) for part in value.split(os.pathsep) if part.strip())
    for value in str(environ.get("PATH", "") or "").split(os.pathsep):
        if value.strip():
            candidates.append(Path(value.strip()))
    if cwd is not None:
        candidates.append(cwd)
    if argv and Path(argv[0]).is_absolute():
        candidates.append(Path(argv[0]).parent)

    normalized = _normalize_writable_roots(candidates)
    implicit_system_reads = _normalize_writable_roots(
        Path(value)
        for key in ("SystemRoot", "WINDIR", "ProgramFiles", "ProgramFiles(x86)")
        if (value := str(environ.get(key, "") or "").strip())
    )
    return tuple(
        path
        for path in normalized
        if not any(_path_is_within(path, writable) for writable in writable_roots)
        and not any(_path_is_within(path, system) for system in implicit_system_reads)
    )


def _windows_mxc_argv(
    executable: str,
    argv: tuple[str, ...],
    writable_roots: Sequence[Path],
    *,
    readable_roots: Sequence[Path],
    cwd: Optional[Path],
    scope_id: str,
    environ: Mapping[str, str],
    denied_paths: Sequence[Path] = (),
) -> tuple[str, ...]:
    """Encode a one-shot ProcessContainer request for the native MXC runner."""

    readonly_paths = _windows_readonly_paths(
        writable_roots,
        readable_roots=readable_roots,
        argv=argv,
        cwd=cwd,
        environ=environ,
    )
    scope_digest = hashlib.sha256(
        str(scope_id or "default").encode("utf-8", errors="replace")
    ).hexdigest()[:12]
    config: dict[str, object] = {
        "version": WINDOWS_MXC_SCHEMA_VERSION,
        "containerId": f"agenticx-{scope_digest}-{uuid.uuid4().hex}",
        "containment": "processcontainer",
        "lifecycle": {"destroyOnExit": True, "preservePolicy": False},
        "process": {
            "commandLine": subprocess.list2cmdline(list(argv)),
            **({"cwd": str(cwd.resolve(strict=False))} if cwd is not None else {}),
        },
        "filesystem": {
            "readwritePaths": [str(path) for path in writable_roots],
            # 被拒的工作区内路径和兼容性读路径合到同一张只读表里。它们比
            # readwritePaths 更具体,ProcessContainer 按最长前缀匹配,所以工作区
            # 整体可写的同时这几条仍然是只读。
            "readonlyPaths": [
                *(str(path) for path in readonly_paths),
                *(str(path) for path in denied_paths),
            ],
        },
        # This change is write isolation only. Explicitly preserve the current
        # unrestricted network and UI behavior instead of accepting MXC's
        # default-deny settings for those independent capabilities.
        "network": {"defaultPolicy": "allow", "allowLocalNetwork": True},
        "ui": {"disable": False, "clipboard": "all", "injection": True},
        "processContainer": {
            "ui": {
                "isolation": "desktop",
                "desktopSystemControl": True,
                "systemSettings": "all",
                "ime": True,
            }
        },
        "fallback": {"allowDaclMutation": True},
    }
    payload = json.dumps(config, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    encoded = base64.b64encode(payload).decode("ascii")
    if len(encoded) > WINDOWS_MXC_MAX_CONFIG_BASE64_CHARS:
        raise CommandSandboxUnavailable(
            "Windows sandbox request is too long for CreateProcess; split the command "
            "into a script inside the workspace and run that script instead"
        )
    return (executable, "--config-base64", encoded)
