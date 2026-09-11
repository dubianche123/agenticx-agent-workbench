#!/usr/bin/env python3
"""Decide whether a shell command is already contained by the workspace sandbox.

**为什么要有这个模块。** 原来的判定是「命令名在不在 SAFE_COMMANDS」加「整条命令里有没有
shell 元字符」。这两条粒度都太粗，结果是同时又吵又漏：

- ``sed -n '1,50p' a.py``、``sort``、``jq``、``rg``、``diff``、``date``、``stat`` 全都要人批准，
  它们连一个字节都不写
- ``ls | head`` 被判成 high 级 ``shell_composition``，尽管两个组件都在白名单里
- 而 ``find . -delete`` 与 ``find . -exec rm {} +`` **一句都不问**——``find`` 在名单上，
  且没有任何参数检查

吵和漏是同一个病：粗名单没有能力表达「这条命令的哪一部分危险」。而吵的代价不只是烦——
它把人训练成闭着眼点「批准」，于是真正该拦的那次也被点过去了。**过度打扰本身就是安全失效。**

**判定的原则。** 确认框留给两种情况：效果会**越出沙箱**，或者在沙箱内**不可逆**。
workspace-write 已经兜住的事情不该再问一遍——重定向的落点由
``_ensure_bash_write_targets_allowed`` 在此之前校验过，写不出工作区。

**判定的方法**（借鉴 OpenAI Codex 的做法并加严）：把复合命令拆成若干简单命令，逐段判定，
只有每一段都安全才算安全；拆不动或看不懂就返回「不确定」，由调用方按受保护处理。
拆解只认几种确定语义的连接符，任何可能藏起另一条命令的写法（命令替换、进程替换、
后台执行）一律判为不确定——**宁可退回问一次，也不假装看懂**。

Author: Damon Li
"""

from __future__ import annotations

import re
import shlex
from dataclasses import dataclass, field
from typing import Iterable, List, Optional, Sequence

#: 纯读命令：不写盘、不联网、不改环境。整段命令只由这些组成时无需确认。
READ_ONLY_COMMANDS: frozenset[str] = frozenset({
    # 列目录与看文件
    "ls", "dir", "tree", "cat", "head", "tail", "nl", "od", "xxd", "strings",
    # 搜索
    "grep", "egrep", "fgrep", "rg", "ag", "ack",
    # 文本处理（只读方向）
    "sort", "uniq", "cut", "tr", "column", "paste", "join", "comm", "fold",
    "expand", "unexpand", "rev", "tac", "wc", "diff", "cmp", "jq", "yq",
    # 路径与元信息
    "basename", "dirname", "realpath", "readlink", "stat", "file", "du", "df",
    "pwd", "which", "type", "command", "hostname", "uname", "id", "whoami",
    "groups", "date", "cal", "env", "printenv", "locale",
    # 校验和
    "cksum", "md5sum", "sha1sum", "sha256sum", "sha512sum", "shasum", "b2sum",
    # 简单输出与判断
    "echo", "printf", "seq", "test", "true", "false", "expr", "yes",
})

#: 双用命令：安不安全取决于参数，必须逐个看。名单里加名字不会顺带放行它的全部用法。
GUARDED_COMMANDS: frozenset[str] = frozenset({
    "find", "sed", "awk", "gawk", "mawk", "git", "xargs", "env", "tar",
})

#: 已知但不只读的命令。它们有专门的风险规则（``pip install``、``python -c``、``rm -rf``…），
#: 所以不该再被报成「未归类命令」——两条理由说同一件事只会让确认卡更难读。
#: 这里只负责「认不认得」，认得之后危不危险由调用方的升级规则判定。
KNOWN_NON_READONLY_COMMANDS: frozenset[str] = frozenset({
    "python", "python3", "pip", "pip3", "node", "npm", "yarn", "pnpm", "npx",
    "brew", "apt", "apt-get", "yum", "dnf", "choco", "snap", "cargo", "go",
    "make", "cmake", "docker", "kubectl",
    "rm", "rmdir", "mv", "cp", "ln", "mkdir", "touch", "chmod", "chown",
    "dd", "mkfs", "shutdown", "reboot", "poweroff", "kill", "pkill",
    "curl", "wget", "ssh", "scp", "rsync", "sudo", "su",
})

#: 会把后续参数当成另一条命令执行的包装器。必须继续往里看，否则
#: ``timeout 5 rm -rf /`` 会因为 ``timeout`` 看着无害而放行。
DELEGATING_COMMANDS: frozenset[str] = frozenset({
    "xargs", "timeout", "time", "nice", "ionice", "nohup", "stdbuf", "env",
    "setsid", "watch",
})

#: ``find`` 上会写盘或执行命令的动作。缺了它们的检查，``find`` 在白名单上等于放行 rm。
FIND_UNSAFE_ACTIONS: frozenset[str] = frozenset({
    "-delete", "-exec", "-execdir", "-ok", "-okdir",
    "-fls", "-fprint", "-fprint0", "-fprintf",
})

#: ``git`` 只读子命令。其余一律算改动版本库状态。
GIT_READ_ONLY_SUBCOMMANDS: frozenset[str] = frozenset({
    "status", "log", "diff", "show", "branch", "remote", "config",
    "rev-parse", "describe", "blame", "shortlog", "ls-files", "ls-tree",
    "cat-file", "check-ignore", "for-each-ref",
})

#: 写进去等于丢掉的设备文件。shell 本身就依赖它们（``2>/dev/null`` 是最常见的写法），
#: 而且写它们不产生任何可留存的效果——沙箱后端也普遍单独给这些 sink 开洞。
DISCARD_SINKS: frozenset[str] = frozenset({
    "/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty", "/dev/fd/1", "/dev/fd/2",
    "NUL", "nul",
})

#: 拆解时认得的连接符。这些只决定「先后与条件」，不改变每一段自身的语义。
_SPLIT_TOKENS = ("&&", "||", ";", "|", "\n")

#: shell 自己就需要的空设备。写到这里不产生任何可读回的落点。
_NULL_SINKS: frozenset[str] = frozenset({
    "/dev/null", "/dev/stdout", "/dev/stderr", "NUL", "nul",
})

#: 任何可能在命令里再藏一条命令的写法。见到就判为不确定。
_OPAQUE_PATTERNS: tuple[tuple[str, str], ...] = (
    ("$(", "命令替换 $(...) 可以在此处执行另一条命令"),
    ("`", "反引号命令替换可以在此处执行另一条命令"),
    ("<(", "进程替换 <(...) 会执行另一条命令"),
    (">(", "进程替换 >(...) 会执行另一条命令"),
)


@dataclass(frozen=True)
class RiskFinding:
    """One reason this command needs a human decision."""

    code: str
    evidence: str

    def as_dict(self) -> dict[str, str]:
        return {"code": self.code, "evidence": self.evidence}


@dataclass(frozen=True)
class SafetyVerdict:
    """Whether the sandbox already contains this command's effects.

    Attributes:
        contained: 沙箱已兜住，不必打扰用户。
        findings: 不安全时的结构化理由；``contained`` 为真时必为空。
        undecidable: 拆不动/看不懂，调用方按受保护处理（fail closed）。
    """

    contained: bool
    findings: List[RiskFinding] = field(default_factory=list)
    undecidable: bool = False


def _tokenize(segment: str) -> Optional[List[str]]:
    """shlex 拆词；引号不闭合等情况返回 None。"""
    try:
        return shlex.split(segment)
    except ValueError:
        return None


def split_simple_commands(command: str) -> Optional[List[List[str]]]:
    """Split a compound command into its simple commands.

    只按 ``&&`` / ``||`` / ``;`` / ``|`` / 换行 拆分，并且尊重引号——``echo "a && b"``
    是一条命令而不是两条。重定向片段（``> f``、``2>&1``、``>> f``）会被剥掉：它们的落点
    由 ``_ensure_bash_write_targets_allowed`` 在更早的阶段校验过，写不出工作区。

    Returns:
        每个元素是一条简单命令的 argv；无法确定语义时返回 ``None``。
    """
    if not command or not command.strip():
        return None
    for marker, _reason in _OPAQUE_PATTERNS:
        if marker in command:
            return None
    # 后台执行：`a & b` 与 `a &` 语义上没问题，但 `&` 也可能是 `&&` 的一半或重定向
    # `2>&1` 的一部分，逐字符判别不值当。这里一律退回不确定。
    if re.search(r"(?<![&>0-9])&(?!&)", command):
        return None

    segments: List[str] = []
    buffer: List[str] = []
    quote: Optional[str] = None
    index = 0
    while index < len(command):
        char = command[index]
        if quote:
            buffer.append(char)
            if char == quote:
                quote = None
            elif char == "\\" and quote == '"' and index + 1 < len(command):
                index += 1
                buffer.append(command[index])
            index += 1
            continue
        if char in "'\"":
            quote = char
            buffer.append(char)
            index += 1
            continue
        matched = next(
            (token for token in _SPLIT_TOKENS if command.startswith(token, index)),
            None,
        )
        if matched:
            segments.append("".join(buffer))
            buffer = []
            index += len(matched)
            continue
        buffer.append(char)
        index += 1
    if quote:
        return None
    segments.append("".join(buffer))

    commands: List[List[str]] = []
    for segment in segments:
        stripped = _strip_redirections(segment)
        if stripped is None:
            return None
        if not stripped.strip():
            continue
        parts = _tokenize(stripped)
        if parts is None:
            return None
        if parts:
            commands.append(parts)
    return commands or None


def _strip_redirections(segment: str) -> Optional[str]:
    """Remove redirection clauses, honouring quotes. ``None`` when unsure."""
    out: List[str] = []
    quote: Optional[str] = None
    index = 0
    while index < len(segment):
        char = segment[index]
        if quote:
            out.append(char)
            if char == quote:
                quote = None
            index += 1
            continue
        if char in "'\"":
            quote = char
            out.append(char)
            index += 1
            continue
        if char in "<>":
            # 吃掉 >、>>、2>、&> 及其后的目标
            while index < len(segment) and segment[index] in "<>&":
                index += 1
            while index < len(segment) and segment[index].isspace():
                index += 1
            while index < len(segment) and not segment[index].isspace():
                index += 1
            continue
        out.append(char)
        index += 1
    if quote:
        return None
    return "".join(out)


def _strip_env_assignments(parts: Sequence[str]) -> List[str]:
    """``FOO=1 BAR=2 cmd …`` → ``cmd …``。前缀赋值本身不执行任何东西。"""
    index = 0
    while index < len(parts) and re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", parts[index]):
        index += 1
    return list(parts[index:])


def _first_positional(parts: Sequence[str], *, start: int = 1) -> Optional[str]:
    for token in parts[start:]:
        if not token.startswith("-"):
            return token
    return None


def classify_simple_command(parts: Sequence[str]) -> SafetyVerdict:
    """Classify one simple command (no pipes, no redirects)."""
    parts = _strip_env_assignments(parts)
    if not parts:
        return SafetyVerdict(contained=True)
    name = parts[0].rsplit("/", 1)[-1]

    if name in DELEGATING_COMMANDS:
        return _classify_delegating(name, parts)
    if name in GUARDED_COMMANDS:
        return _classify_guarded(name, parts)
    if name in READ_ONLY_COMMANDS:
        return SafetyVerdict(contained=True)
    if name in KNOWN_NON_READONLY_COMMANDS:
        # 认得它，但它不只读。这里仍然要给出理由——调用方按「这一段有没有更具体的规则」
        # 决定用哪条，绝不能靠返回空理由来表达「交给别人说」：一旦那条更具体的规则不存在
        # （chmod / ssh / sudo 就没有），空理由会直接变成静默放行。
        return SafetyVerdict(
            contained=False,
            findings=[
                RiskFinding(
                    "unrecognized_command",
                    f"{name} 不是只读命令，需要你判断这次的用途",
                )
            ],
        )
    return SafetyVerdict(
        contained=False,
        findings=[
            RiskFinding("unrecognized_command", f"{name} 不在已知只读命令集合中")
        ],
    )


def _classify_delegating(name: str, parts: Sequence[str]) -> SafetyVerdict:
    """包装器：跳过自己的选项，把剩下的当作被代理的命令继续判定。

    ``timeout 5 rm -rf /`` 里危险的是 ``rm``，不是 ``timeout``。不往里看就等于放行。
    """
    index = 1
    if name == "timeout":
        # timeout [选项] DURATION COMMAND …
        while index < len(parts) and parts[index].startswith("-"):
            index += 1
        index += 1  # DURATION
    elif name == "env":
        while index < len(parts) and (
            parts[index].startswith("-") or "=" in parts[index]
        ):
            index += 1
    elif name == "xargs":
        while index < len(parts) and parts[index].startswith("-"):
            # -I{}、-n 3 这类带值选项
            if parts[index] in {"-I", "-n", "-P", "-L", "-d", "-s", "-E", "-a"}:
                index += 1
            index += 1
    else:
        while index < len(parts) and parts[index].startswith("-"):
            index += 1

    delegated = list(parts[index:])
    if not delegated:
        # xargs 不带命令默认跑 echo；其它包装器不带命令没有意义。
        return SafetyVerdict(contained=True) if name == "xargs" else SafetyVerdict(
            contained=False,
            findings=[RiskFinding("unrecognized_command", f"{name} 后面没有可判定的命令")],
        )
    inner = classify_simple_command(delegated)
    if inner.contained:
        return inner
    return SafetyVerdict(
        contained=False,
        findings=[
            RiskFinding(
                item.code,
                f"{name} 会执行：{item.evidence}",
            )
            for item in inner.findings
        ],
        undecidable=inner.undecidable,
    )


def _classify_guarded(name: str, parts: Sequence[str]) -> SafetyVerdict:
    if name == "find":
        hits = [token for token in parts[1:] if token in FIND_UNSAFE_ACTIONS]
        if hits:
            code = (
                "destructive_filesystem"
                if "-delete" in hits
                else "arbitrary_code_execution"
            )
            return SafetyVerdict(
                contained=False,
                findings=[
                    RiskFinding(code, f"find {' '.join(hits)} 会删除文件或执行命令")
                ],
            )
        return SafetyVerdict(contained=True)

    if name == "sed":
        inplace = [
            token for token in parts[1:]
            if token == "--in-place" or token.startswith("--in-place=")
            or (token.startswith("-") and not token.startswith("--") and "i" in token[1:])
        ]
        if inplace:
            return SafetyVerdict(
                contained=False,
                findings=[
                    RiskFinding(
                        "destructive_filesystem",
                        "sed -i 会就地覆盖文件内容",
                    )
                ],
            )
        return SafetyVerdict(contained=True)

    if name in {"awk", "gawk", "mawk"}:
        program = " ".join(parts[1:])
        if "system(" in program or re.search(r'\|\s*["\']', program) or ">" in program:
            return SafetyVerdict(
                contained=False,
                findings=[
                    RiskFinding(
                        "arbitrary_code_execution",
                        "awk 程序里含 system()、管道或重定向，可执行额外命令或写文件",
                    )
                ],
            )
        return SafetyVerdict(contained=True)

    if name == "git":
        subcommand = _first_positional(
            parts, start=1
        )
        if subcommand is None:
            return SafetyVerdict(contained=True)
        if subcommand in GIT_READ_ONLY_SUBCOMMANDS:
            return SafetyVerdict(contained=True)
        return SafetyVerdict(
            contained=False,
            findings=[
                RiskFinding("version_control_change", f"git {subcommand} 会变更版本库状态")
            ],
        )

    if name == "tar":
        # tar 的动作可以写成 -x / --extract / 也可以是无横杠的 "xzf" 这种老式写法。
        # 只把「列出内容」(-t/--list) 当只读，其余一律要人看一眼：解包会写文件，
        # 打包 (-c) 也会产出新文件。
        listing = False
        writing = False
        for token in parts[1:]:
            if token in {"-t", "--list"}:
                listing = True
            elif token in {"-x", "--extract", "--get", "-c", "--create", "-u", "-r"}:
                writing = True
            elif token.startswith("--"):
                continue
            elif token.startswith("-"):
                flags = token[1:]
                if "t" in flags:
                    listing = True
                if any(flag in flags for flag in "xcur"):
                    writing = True
            elif not listing and not writing and re.fullmatch(r"[a-zA-Z]+", token):
                # 老式无横杠写法：tar xzf a.tgz
                if "t" in token:
                    listing = True
                if any(flag in token for flag in "xcur"):
                    writing = True
        if writing or not listing:
            return SafetyVerdict(
                contained=False,
                findings=[
                    RiskFinding(
                        "destructive_filesystem",
                        "tar 会写出或覆盖文件（只有 -t 列出内容是只读的）",
                    )
                ],
            )
        return SafetyVerdict(contained=True)

    return SafetyVerdict(
        contained=False,
        findings=[RiskFinding("unrecognized_command", f"{name} 需要人工判断用途")],
    )


def assess_command(command: str) -> SafetyVerdict:
    """Whether ``command`` as a whole is already contained by the sandbox.

    拆不动就返回 ``undecidable=True``，调用方按受保护处理——这是 fail closed 的一侧。
    """
    simple_commands = split_simple_commands(command)
    if simple_commands is None:
        reason = next(
            (why for marker, why in _OPAQUE_PATTERNS if marker in command),
            "命令结构无法确定地拆解，可能藏有额外命令",
        )
        return SafetyVerdict(
            contained=False,
            findings=[RiskFinding("shell_composition", reason)],
            undecidable=True,
        )

    findings: List[RiskFinding] = []
    for parts in simple_commands:
        verdict = classify_simple_command(parts)
        if verdict.contained:
            continue
        for item in verdict.findings:
            if item not in findings:
                findings.append(item)
    return SafetyVerdict(contained=not findings, findings=findings)


def absolute_redirect_targets(command: str) -> List[str]:
    """Redirection targets written as absolute paths.

    重定向到相对路径时，落点由 cwd 决定，而 cwd 一定在工作区内、且
    ``_ensure_bash_write_targets_allowed`` 会再校验一次，所以是兜住的。
    绝对路径不一样：这个模块看不到工作区边界，**证明不了**它落在里面
    （``cat secrets.env > /tmp/leak.txt`` 就是这一类），只能交回去问。
    """
    targets: List[str] = []
    quote: Optional[str] = None
    # 空设备是 shell 自己就要用的丢弃口，不构成落点问题。deepseek-harness 的沙箱
    # 对 read-only 模式也专门放行 /dev/null。
    index = 0
    while index < len(command):
        char = command[index]
        if quote:
            if char == quote:
                quote = None
            index += 1
            continue
        if char in "'\"":
            quote = char
            index += 1
            continue
        if char == ">":
            while index < len(command) and command[index] in "<>&":
                index += 1
            while index < len(command) and command[index].isspace():
                index += 1
            start = index
            while index < len(command) and not command[index].isspace():
                index += 1
            target = command[start:index].strip("'\"")
            if target in DISCARD_SINKS:
                continue
            absolute = target.startswith("/") or re.match(r"^[A-Za-z]:[\\/]", target)
            if absolute and target not in _NULL_SINKS and target not in targets:
                targets.append(target)
            continue
        index += 1
    return targets


# --------------------------------------------------------------------------
# 档位与确认的关系
# --------------------------------------------------------------------------

#: 只读档已经兜住的风险类别——它们的危害**全部落在文件写入上**，而只读档拒绝一切写。
#:
#: 没有列进来的类别不是漏了，是真的兜不住：文件沙箱只管文件效果，**不管网络**
#: （bwrap / seatbelt / mxc 都是如此，deepseek-harness 的沙箱文档也把 network 明确
#: 划在词汇表之外）。所以 ``git push``、``shutdown``、``python -c``（能开 socket）、
#: 以及认不出来的命令（可能就是 curl），在只读档下**照样要问**。
#:
#: 换句话说：**只读档不是网络隔离**。它给的保证是「这次会话改不了任何东西」，
#: 不是「这次会话传不出任何东西」。
CONTAINED_BY_READ_ONLY: frozenset[str] = frozenset({
    "destructive_filesystem",   # 删/覆盖，写被拒就不成立
    "dependency_change",        # 装包的效果就是写盘
    "version_control_change",   # 改索引/提交/工作树都是写
})


#: 无论怎样都不允许「不再询问」的类别。
#:
#: 共同点是**后果不可逆,或者落在本机与本次任务之外**：删掉的数据、推到远端的提交、
#: 动过的设备与系统服务、退出工作区隔离。它们不适合被一条规则长期豁免——用户当时
#: 同意的是那一次的上下文，不是往后所有次。前端的 ``neverReusableCategories`` 与这里
#: 必须一致（desktop/src/utils/confirm-scope.ts，有测试对账）。
#:
#: ``destructive_filesystem`` 是 2026-08-24 补进来的。界面上「代我批准」那一档写着
#: 「删除数据…仍然会问你」，而它当时不在这个集合里——``allowed_tools: ["bash_exec"]``
#: 配下去之后 ``rm -rf`` 就能免确认。**文案承诺了而代码没做**，比两者都没有更糟。
#:
#: 这比 Claude Code 更严：那边允许写下 ``Bash(git push:*)`` 之类的长期规则。
#: 本仓沿用既有立场，不因为加了持久化就放宽。
NEVER_AUTO_APPROVED_CATEGORIES: frozenset[str] = frozenset({
    "destructive_filesystem",
    "external_publish",
    "host_full_access",
    "system_disruption",
})


def categories_requiring_approval(
    permissions: str,
    codes: Iterable[str],
) -> List[str]:
    """Which risk categories still need a human decision at this tier.

    档位与确认是两个旋钮，不是一个（借鉴 deepseek-harness 把 ``sandbox/mode`` 与
    ``approval/policy`` 拆开的做法）：**执行边界由沙箱负责，确认框只覆盖沙箱覆盖不到的
    部分**。同一条命令在不同档位下该不该问，答案本来就不同。

    - ``read-only``：写全被拒，文件类风险不必再问；网络与进程类照旧。
    - ``danger-full-access``：**原样返回**。理论上进这一档时批准一次就够了，逐条再问
      接近表演；但那需要会话级的档位状态，且会真的减少一次拦截机会，属于产品决策而不是
      本函数能单方面做的事。现状是每条命令带 ``host_full_access`` 问一次，保持不变。
    - ``workspace-write``：工作区外的写被拒，但工作区内的删除与覆盖是不可逆的，照旧问。

    Args:
        permissions: ``read-only`` / ``workspace-write`` / ``danger-full-access``。
        codes: 已归类出的风险类别代码。

    Returns:
        仍然需要人来决定的类别，去重并排序。
    """
    tier = str(permissions or "").strip().lower()
    unique = sorted({str(code).strip() for code in codes if str(code).strip()})
    if tier == "read-only":
        return [code for code in unique if code not in CONTAINED_BY_READ_ONLY]
    return unique
