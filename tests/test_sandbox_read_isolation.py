#!/usr/bin/env python3
"""Shell 的**读取**必须被限制在工作区内。

在这之前三个后端都只隔离写：macOS 是 ``(allow default)`` 后拒写，Linux 把整个 ``/``
以 ``--ro-bind`` 挂进来，Windows 为了工具链能跑把 ``USERPROFILE`` 放进了 readonlyPaths。
于是 ``cat ~/.ssh/id_rsa``、``rg`` 扫一遍 home 全都读得到，而且**不产生任何确认请求**
——这些命令解析出来是只读的，风险清单为空。写边界做得再严也拦不住把东西读出去。

本轮只做 macOS 与 Linux，Windows 后延；差别由
:func:`shell_read_isolation_for_host` 如实报出来，界面据此措辞。

两类用例缺一不可：

- **实跑**：唯一能证明规则真的生效的东西。写规则那轮就是靠实跑才发现
  ``_scheme_string`` 复用导致正则静默失配；这轮靠实跑才发现一条 ``subpath "/"``
  把整个读隔离作废了。
- **形状**：可读名单不能悄悄变宽。一条过宽的条目不报错、不降级、日志里什么都没有。

Author: Damon Li
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest

from agenticx.runtime.command_sandbox import (
    READ_ONLY,
    _macos_profile,
    _over_broad_read_roots,
    _toolchain_read_roots,
    build_command_sandbox_plan,
    shell_read_isolation_for_host,
)

darwin_only = pytest.mark.skipif(
    sys.platform != "darwin", reason="seatbelt is macOS-only"
)


def _run(workspace: Path, command: str, **kwargs) -> subprocess.CompletedProcess:
    plan = build_command_sandbox_plan(
        ["/bin/sh", "-c", command],
        writable_roots=[workspace],
        cwd=workspace,
        scope_id="read-isolation",
        **kwargs,
    )
    return subprocess.run(
        plan.argv, env=dict(plan.env), cwd=workspace, capture_output=True, text=True
    )


@pytest.fixture()
def workspace(tmp_path: Path) -> Path:
    ws = tmp_path / "ws"
    ws.mkdir()
    (ws / "inside.txt").write_text("hello\n", encoding="utf-8")
    # 种一个假的凭据文件。**不要用真实的 ~/.ssh / ~/.aws 做被拒用例**——用例会把
    # 读到的内容打进失败输出里，那一步本身就是一次泄露。
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "id_rsa").write_text("PLANTED-FAKE-KEY\n", encoding="utf-8")
    return ws


# --------------------------------------------------------------------------
# 实跑
# --------------------------------------------------------------------------


@darwin_only
def test_the_workspace_is_readable_and_writable(workspace: Path) -> None:
    assert _run(workspace, "cat inside.txt").stdout.strip() == "hello"
    assert _run(workspace, "echo x > new.txt && cat new.txt").returncode == 0


@darwin_only
def test_a_file_outside_the_workspace_cannot_be_read(workspace: Path) -> None:
    planted = workspace.parent / "outside" / "id_rsa"
    proc = _run(workspace, f"cat {planted}")
    assert proc.returncode != 0
    assert "PLANTED-FAKE-KEY" not in proc.stdout


@darwin_only
def test_the_home_directory_cannot_be_listed(workspace: Path) -> None:
    """``ls ~`` 也要挡住。

    只挡住读文件内容、放行列目录，等于把「这台机器上有哪些仓、哪些客户、哪些项目」
    整个交出去。目录名本身就是信息。
    """
    proc = _run(workspace, "ls ~ > /dev/null")
    assert proc.returncode != 0


@darwin_only
def test_read_only_tier_is_confined_the_same_way(workspace: Path) -> None:
    """``read-only`` 档同样受读隔离。

    那一档的意思是「不给写」，不是「可以随便读别人的仓和 ~/.ssh」。调研型任务全程
    跑在这一档上，如果它反而是读得最宽的，隔离就形同虚设。
    """
    planted = workspace.parent / "outside" / "id_rsa"
    proc = _run(workspace, f"cat {planted}", permissions=READ_ONLY)
    assert proc.returncode != 0
    assert "PLANTED-FAKE-KEY" not in proc.stdout


@darwin_only
def test_an_explicit_read_only_mount_is_readable(workspace: Path, tmp_path: Path) -> None:
    """显式挂进来的只读引用要能读——否则「引用挂载」这个功能就没有了。

    这也是用户绕开读隔离的**正当**出口：需要读工作区外的东西，就把那个目录挂成
    只读引用。比让他去开 danger-full-access 好得多。
    """
    reference = tmp_path / "reference"
    reference.mkdir()
    (reference / "notes.md").write_text("shared\n", encoding="utf-8")
    proc = _run(
        workspace, f"cat {reference / 'notes.md'}", readable_roots=[reference]
    )
    assert proc.returncode == 0
    assert proc.stdout.strip() == "shared"


@darwin_only
@pytest.mark.parametrize(
    "command",
    [
        "python3 -c 'print(1+1)'",
        "python3 -m json.tool --help",
        "git --version",
        "git init -q sub && cd sub && git status --short",
        "touch $TMPDIR/probe",
    ],
)
def test_the_usual_toolchain_still_runs(workspace: Path, command: str) -> None:
    """读隔离最容易失败的方式不是漏了一个洞，是把常用命令全弄挂。

    python / git 在动态链接阶段就死掉的话，用户看到的是一堆无法归因的报错（退出码
    134，stdout 和 stderr 一个字都没有），然后他会把整个功能关掉——那比不做读隔离更糟。
    """
    proc = _run(workspace, command)
    assert proc.returncode == 0, proc.stdout + proc.stderr


# --------------------------------------------------------------------------
# 形状：可读名单不能悄悄变宽
# --------------------------------------------------------------------------


def test_the_home_directory_is_never_a_read_root() -> None:
    """一条过宽的条目就能让整个功能失效，而且**没有任何症状**。

    这不是假想：``/bin/sh`` 的前缀推导（``parent.name == "bin"`` → 上一级）算出来
    是 ``/``，于是名单里多了一条 ``(allow file-read-data (subpath "/"))``。其余三十条
    规则一条都没错，写规则照常生效，沙箱表面上完全正常——只有实跑一次外部读取才看
    得出来。所以这一层挡必须在代码里，不能靠改动时记得检查。
    """
    home = str(Path.home())
    environ = {
        "HOME": home,
        # 全都是能算出过宽结果的输入。
        "PATH": os.pathsep.join(["/bin", "/usr/bin", home, "/"]),
        "GOPATH": "/",
        "CARGO_HOME": home,
    }
    roots = _toolchain_read_roots(environ, ["/bin/sh"], host=sys.platform)
    texts = {str(path) for path in roots}
    assert "/" not in texts
    assert home not in texts
    assert "/Users" not in texts and "/home" not in texts


def test_the_block_list_covers_the_home_from_the_environment() -> None:
    blocked = _over_broad_read_roots({"HOME": "/Users/someone"})
    assert os.path.normcase("/Users/someone") in blocked
    assert os.path.normcase("/") in blocked


@darwin_only
def test_the_profile_denies_read_data_but_allows_metadata() -> None:
    """拒的是 ``file-read-data``，元数据放行——这是个有意的取舍，不是漏写。

    ``(deny file-read*)`` 连 stat 一起拒，而要访问 ``/a/b/c`` 就得先 stat 它的每一级
    祖先。祖先不在放行名单里，于是**允许的路径也访问不了**，沙箱变成什么都跑不动。
    代价是泄露「某个路径存不存在、多大」；内容拿不到。
    """
    profile = _macos_profile([Path("/w")], [], readable_roots=[Path("/usr")])
    assert "(deny file-read-data file-write*)" in profile
    assert "(allow file-read-metadata)" in profile
    assert "(deny file-read*)" not in profile


@darwin_only
def test_the_profile_allows_reading_the_root_directory() -> None:
    """``(allow file-read-data (literal "/"))`` 少了的话任何进程都起不来。

    dyld 解析路径时要读 ``/``，读不到就直接 abort：退出码 134，stdout / stderr 一个字
    都没有。这个用例存在的意义就是不让下一个人再二分一次。
    """
    profile = _macos_profile([Path("/w")], [], readable_roots=[Path("/usr")])
    assert '(allow file-read-data (literal "/"))' in profile


@darwin_only
def test_a_writable_root_is_also_readable() -> None:
    profile = _macos_profile([Path("/w")], [])
    assert '(allow file-read-data (subpath "/w"))' in profile
    assert '(allow file-write* (subpath "/w"))' in profile


def test_the_host_reports_read_isolation_honestly() -> None:
    """Windows 还没做，不能跟着 macOS / Linux 一起报 full。

    和 ``path_deny_enforcement_for_host`` 分开正是为了这个：Windows 上 deny 能挡住
    写（partial），读却仍然放得很开。合成一个字段就必然在某个平台上说一句不成立的话。
    """
    assert shell_read_isolation_for_host("darwin") == "full"
    assert shell_read_isolation_for_host("linux") == "full"
    assert shell_read_isolation_for_host("win32") == "none"
    assert shell_read_isolation_for_host("freebsd") == "none"


def test_linux_does_not_bind_the_whole_root_filesystem(tmp_path: Path, monkeypatch) -> None:
    """以前第一条是 ``--ro-bind / /``——读边界根本不存在。

    现在逐条绑，家目录不在其中，所以工作区之外的东西在命名空间里根本不出现。
    """
    monkeypatch.setattr("shutil.which", lambda name, **_kw: "/usr/bin/bwrap")
    workspace = tmp_path / "ws"
    workspace.mkdir()
    plan = build_command_sandbox_plan(
        ["true"],
        writable_roots=[workspace],
        cwd=workspace,
        scope_id="linux-read",
        platform_name="linux",
    )
    argv = list(plan.argv)
    triples = [
        (argv[i], argv[i + 1], argv[i + 2])
        for i, token in enumerate(argv[:-2])
        if token in {"--ro-bind", "--ro-bind-try", "--bind"}
    ]
    assert ("--ro-bind", "/", "/") not in triples
    assert ("--ro-bind-try", "/", "/") not in triples
    # 不存在的源路径必须用 -try：名单里一半路径在任一台具体机器上都不存在，
    # 用 --ro-bind 会让整个 bwrap 失败,把「没装 rust」变成「所有命令都跑不了」。
    assert "--ro-bind-try" in argv


# --------------------------------------------------------------------------
# 被拒之后模型要知道该干什么
# --------------------------------------------------------------------------


def test_a_sandbox_denial_tells_the_model_the_boundary_is_not_in_the_command() -> None:
    """没有这段提示，模型会去试 sudo、试相对路径、试 find——一轮全烧在这上面。

    读隔离上线之后「读不到那个文件」是一类新的常见失败，而模型看到的只有一句
    ``Operation not permitted``。它无从判断这是命令写错了还是边界拦下的。
    """
    from agenticx.cli.agent_tools import _sandbox_denial_hint

    hint = _sandbox_denial_hint("cat: /etc/x: Operation not permitted", "workspace-write")
    assert "sudo" in hint  # 明确劝阻
    assert "只读引用" in hint


def test_the_hint_puts_the_read_only_mount_before_full_access() -> None:
    """出口的顺序不能反。

    先提 ``danger-full-access``，模型每次读不到东西就会先申请一次全主机访问——而那一档
    是不可持久化的、每次都要用户点。把「挂成只读引用」放前面，是因为它长期有效、
    在设置页里看得见、也撤得掉。
    """
    from agenticx.cli.agent_tools import _sandbox_denial_hint

    hint = _sandbox_denial_hint("Read-only file system", "workspace-write")
    assert hint.index("只读引用") < hint.index("danger-full-access")


def test_no_hint_when_the_command_simply_failed() -> None:
    """普通的命令错误不该被套上一段权限说明——那会把模型往错误的方向推。"""
    from agenticx.cli.agent_tools import _sandbox_denial_hint

    assert _sandbox_denial_hint("syntax error near unexpected token", "workspace-write") == ""


def test_no_hint_in_full_access_where_there_is_no_boundary_to_explain() -> None:
    from agenticx.cli.agent_tools import _sandbox_denial_hint

    assert _sandbox_denial_hint("Operation not permitted", "danger-full-access") == ""


@darwin_only
def test_read_only_still_lets_you_read_the_workspace(workspace: Path) -> None:
    """``read-only`` 档要把工作区**降级成可读**，不能整个丢掉。

    加上读隔离之前这条没有后果：那时读是全开的，丢不丢工作区根都一样。现在丢掉它，
    连 shell 自己的 getcwd 都会失败（``error retrieving current directory``）——而调研型
    任务全程跑在这一档上，等于这一档整个不可用。

    这里故意只传 ``writable_roots``：调用方把工作区当「要调研的那个目录」传进来是最
    自然的写法，不该因为档位是 read-only 就悄悄变成什么都读不到。
    """
    proc = _run(workspace, "cat inside.txt", permissions=READ_ONLY)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert proc.stdout.strip() == "hello"
    # 读得到不等于写得进去。
    assert _run(workspace, "echo x > blocked.txt", permissions=READ_ONLY).returncode != 0
    assert not (workspace / "blocked.txt").exists()
