#!/usr/bin/env python3
"""``permissions.path_rules`` 的拒绝规则必须由 OS 沙箱强制，而不只是弹框时检查。

第一方文件工具（file_write / file_edit / codegen）走 ``_path_denied_by_rules``，
那条路径是完整的。**Shell 不是**：``_ensure_bash_write_targets_allowed`` 只能可靠地
认出重定向和 tee 的落点，``rm -f secrets/key`` 根本不经过它。CodeX 复核时点了这个洞，
当时只把界面文案收窄了，没有真修。

真修法是把拒绝模式下沉到沙箱后端——那是进程真正写文件时的边界，不依赖我们能不能把
一条 shell 命令解析对。

三个后端的能力不一样，这个差别必须能被上层看见：

- **macOS**：seatbelt 收正则，一条 glob 能原样表达，运行中新建的文件照样挡 → ``full``
- **Linux / Windows**：bubblewrap 与 ProcessContainer 只认具体路径，只能在启动前
  枚举一次 → ``partial``

Author: Damon Li
"""

from __future__ import annotations

import base64
import json
import re
import subprocess
import sys
from fnmatch import fnmatch
from pathlib import Path

import pytest

from agenticx.runtime.command_sandbox import (
    _glob_to_posix_regex,
    _macos_profile,
    build_command_sandbox_plan,
)


# --------------------------------------------------------------------------
# glob → 正则：必须和弹框那关判一样的路径
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "pattern,path",
    [
        ("*/.env", "/w/.env"),
        ("*/.env", "/w/a/b/.env"),
        ("*/.env", "/w/env"),
        ("*/.env", "/w/.envrc"),
        ("/etc/*", "/etc/passwd"),
        ("/etc/*", "/etcx/passwd"),
        ("a.b", "a.b"),
        ("a.b", "axb"),
        ("*secret[0-9].key", "/w/secret3.key"),
        ("*secret[0-9].key", "/w/secretX.key"),
        ("*[!a].txt", "/w/b.txt"),
        ("*[!a].txt", "/w/a.txt"),
        ("*.pem", "/w/deep/nested/id.pem"),
        ("*/node_modules/*", "/w/node_modules/x/y"),
    ],
)
def test_translated_regex_agrees_with_fnmatch(pattern: str, path: str) -> None:
    """两处判定分叉是最坏的结果。

    ``match_path_rules`` 用的是 ``fnmatch``——注意它的 ``*`` **跨 ``/``**，不是 shell
    里那个不跨目录的 ``*``。沙箱这边要是自作主张收紧，用户会看到「设置里写了拒绝，
    弹框拦住了，但 shell 里没拦住」，或者反过来。
    """
    assert bool(re.match(_glob_to_posix_regex(pattern), path)) == fnmatch(path, pattern)


def test_unclosed_bracket_is_a_literal_like_fnmatch() -> None:
    assert bool(re.match(_glob_to_posix_regex("a[bc"), "a[bc")) == fnmatch("a[bc", "a[bc")


# --------------------------------------------------------------------------
# macOS：规则次序与正则字面量的转义
# --------------------------------------------------------------------------


def test_deny_rules_come_after_the_workspace_allow() -> None:
    """seatbelt 里**后面的规则覆盖前面的**。

    拒绝排在 ``(allow file-write* (subpath <workspace>))`` 前面的话，会被工作区那条
    整个盖掉，规则等于没写。
    """
    profile = _macos_profile([Path("/w")], ["*/.env"])
    allow_at = profile.index('(allow file-write* (subpath "/w"))')
    deny_at = profile.index("(deny file-read-data file-write* (regex")
    assert deny_at > allow_at


def test_regex_literal_is_not_escaped_like_a_scheme_string() -> None:
    """``#"…"`` 里的反斜杠不能翻倍。

    复用普通字符串的转义会生成 ``\\\\.``——在正则里那是「一个反斜杠再跟任意字符」，
    本来想表达的「字面的点」就没了，规则静悄悄地匹配不到任何东西。实测过：翻倍之后
    ``deny */.env`` 完全不生效，``rm .env`` 照样删掉。
    """
    profile = _macos_profile([Path("/w")], ["*/.env"])
    assert '(deny file-read-data file-write* (regex #"^.*/\\.env$"))' in profile
    assert "\\\\." not in profile


def test_no_deny_rules_means_no_deny_lines() -> None:
    profile = _macos_profile([Path("/w")], [])
    assert "(regex" not in profile


# --------------------------------------------------------------------------
# 真的跑一遍：这才是「不再过度承诺」的证据
# --------------------------------------------------------------------------


@pytest.mark.skipif(sys.platform != "darwin", reason="seatbelt is macOS-only")
def test_shell_rm_cannot_delete_a_denied_path(tmp_path: Path) -> None:
    """CodeX 点的就是这个洞：``rm -f secrets/key`` 不经过任何 shell 解析守卫。"""
    workspace = tmp_path / "ws"
    workspace.mkdir()
    secret = workspace / ".env"
    secret.write_text("TOKEN=1\n", encoding="utf-8")

    plan = build_command_sandbox_plan(
        ["/bin/sh", "-c", "rm -f .env"],
        writable_roots=[workspace],
        cwd=workspace,
        scope_id="deny-test",
        denied_path_patterns=["*/.env"],
    )
    assert plan.deny_enforcement == "full"

    proc = subprocess.run(
        plan.argv, env=dict(plan.env), cwd=workspace, capture_output=True, text=True
    )
    assert proc.returncode != 0
    assert secret.exists(), "拒绝规则没拦住 shell 里的 rm"


@pytest.mark.skipif(sys.platform != "darwin", reason="seatbelt is macOS-only")
def test_a_file_created_during_the_run_is_also_denied(tmp_path: Path) -> None:
    """正则相对「启动前枚举」的价值就在这里。

    Linux / Windows 只能挡住启动时已存在的匹配路径，所以那两个平台报 partial。
    """
    workspace = tmp_path / "ws"
    workspace.mkdir()

    plan = build_command_sandbox_plan(
        ["/bin/sh", "-c", "echo leak > fresh.env"],
        writable_roots=[workspace],
        cwd=workspace,
        scope_id="deny-test",
        denied_path_patterns=["*.env"],
    )
    proc = subprocess.run(
        plan.argv, env=dict(plan.env), cwd=workspace, capture_output=True, text=True
    )
    assert proc.returncode != 0
    assert not (workspace / "fresh.env").exists()


@pytest.mark.skipif(sys.platform != "darwin", reason="seatbelt is macOS-only")
def test_unrelated_writes_in_the_workspace_still_work(tmp_path: Path) -> None:
    """收窄不能变成把工作区整个锁死——那会让这档位没法用。"""
    workspace = tmp_path / "ws"
    workspace.mkdir()
    (workspace / "normal.txt").write_text("ok\n", encoding="utf-8")

    plan = build_command_sandbox_plan(
        ["/bin/sh", "-c", "rm -f normal.txt && echo done > out.txt"],
        writable_roots=[workspace],
        cwd=workspace,
        scope_id="deny-test",
        denied_path_patterns=["*/.env"],
    )
    proc = subprocess.run(
        plan.argv, env=dict(plan.env), cwd=workspace, capture_output=True, text=True
    )
    assert proc.returncode == 0, proc.stderr
    assert not (workspace / "normal.txt").exists()
    assert (workspace / "out.txt").exists()


# --------------------------------------------------------------------------
# Linux / Windows：只认具体路径，如实报 partial
# --------------------------------------------------------------------------


def test_linux_covers_a_denied_file_with_dev_null_after_the_writable_bind(
    tmp_path: Path, monkeypatch
) -> None:
    """拒绝的文件用 ``/dev/null`` 盖掉，而且必须排在 ``--bind`` 之后。

    两件事各自都会静悄悄地失效：
    - 顺序反了，工作区那条 ``--bind`` 会把覆盖冲掉，规则等于没写；
    - 只是把它重新挂成只读（上一版的做法）只挡住写，``cat`` 照读不误。
      盖上 ``/dev/null`` 之后读到的是空，内容确实拿不到了。
    """
    monkeypatch.setattr("shutil.which", lambda name, **_kw: "/usr/bin/bwrap")
    workspace = tmp_path / "ws"
    (workspace / "sub").mkdir(parents=True)
    secret = workspace / "sub" / ".env"
    secret.write_text("x", encoding="utf-8")

    plan = build_command_sandbox_plan(
        ["true"],
        writable_roots=[workspace],
        cwd=workspace,
        scope_id="deny-test",
        denied_path_patterns=["*/.env"],
        platform_name="linux",
    )
    argv = list(plan.argv)
    ro_at = argv.index(str(secret))
    assert argv[ro_at - 2] == "--ro-bind"
    assert argv[ro_at - 1] == "/dev/null"
    assert ro_at > argv.index(str(workspace))
    # 只挡住启动时已经存在的匹配路径——运行中新建的挡不住，所以是 partial。
    assert plan.deny_enforcement == "partial"
    assert plan.denied_write_paths == (secret,)


def test_linux_covers_a_denied_directory_with_a_read_only_tmpfs(
    tmp_path: Path, monkeypatch
) -> None:
    """目录不能用 ``/dev/null`` 盖，只能盖一块 tmpfs——但必须再 remount 成只读。

    光 ``--tmpfs`` 是可写的：写进去的东西落到那块 tmpfs 上，命令**成功**了却什么也
    没改到。「悄悄成功」比报错更难查，所以补一个 ``--remount-ro``。
    """
    monkeypatch.setattr("shutil.which", lambda name, **_kw: "/usr/bin/bwrap")
    workspace = tmp_path / "ws"
    denied_dir = workspace / "secrets"
    denied_dir.mkdir(parents=True)

    plan = build_command_sandbox_plan(
        ["true"],
        writable_roots=[workspace],
        cwd=workspace,
        scope_id="deny-dir",
        denied_path_patterns=["*/secrets"],
        platform_name="linux",
    )
    argv = list(plan.argv)
    at = argv.index("--tmpfs")
    assert argv[at + 1] == str(denied_dir)
    assert argv[at + 2] == "--remount-ro"
    assert argv[at + 3] == str(denied_dir)


def test_windows_puts_matched_paths_in_readonly_paths(tmp_path: Path, monkeypatch) -> None:
    workspace = tmp_path / "ws"
    workspace.mkdir()
    secret = workspace / ".env"
    secret.write_text("x", encoding="utf-8")
    runner = tmp_path / "mxc.exe"
    runner.write_text("", encoding="utf-8")
    monkeypatch.setenv("AGX_WINDOWS_SANDBOX_EXECUTABLE", str(runner))

    plan = build_command_sandbox_plan(
        ["cmd.exe", "/c", "echo hi"],
        writable_roots=[workspace],
        cwd=workspace,
        scope_id="deny-test",
        denied_path_patterns=["*/.env"],
        platform_name="win32",
    )
    config = json.loads(base64.b64decode(plan.argv[-1]).decode("utf-8"))
    assert str(secret) in config["filesystem"]["readonlyPaths"]
    assert str(workspace) in config["filesystem"]["readwritePaths"]
    assert plan.deny_enforcement == "partial"


def test_no_patterns_leaves_enforcement_at_none(tmp_path: Path) -> None:
    workspace = tmp_path / "ws"
    workspace.mkdir()
    plan = build_command_sandbox_plan(
        ["/bin/sh", "-c", "true"],
        writable_roots=[workspace],
        cwd=workspace,
        scope_id="deny-test",
    )
    assert plan.deny_enforcement == "none"
    assert plan.denied_write_paths == ()
    assert plan.deny_patterns == ()


def test_allow_rules_are_never_pushed_into_the_sandbox(monkeypatch) -> None:
    """allow 的语义是**免确认**，不是「放开沙箱」。

    把它下沉等于让一条配置项有拆掉工作区隔离的能力——一条手滑写成 ``/**`` 的 allow
    就把整个隔离作废了。
    """
    from agenticx.cli import agent_tools
    from agenticx.cli.config_manager import ConfigManager

    monkeypatch.setattr(
        ConfigManager,
        "get_value",
        staticmethod(
            lambda key, *a, **k: [
                {"pattern": "/**", "allow": True},
                {"pattern": "*/.env", "allow": False},
            ]
            if key == "permissions.path_rules"
            else None
        ),
    )
    assert agent_tools.denied_path_patterns_for_sandbox() == ["*/.env"]


# --------------------------------------------------------------------------
# deny 规则读写一起挡
# --------------------------------------------------------------------------


@pytest.mark.skipif(sys.platform != "darwin", reason="seatbelt is macOS-only")
def test_a_denied_path_cannot_be_read_from_the_shell(tmp_path: Path) -> None:
    """``rm .env`` 挡得住而 ``cat .env`` 挡不住，保护的是错误的那一半。

    用户在 ``permissions.path_rules`` 里写下 ``*/.env``，想的是「别碰这个文件」。
    上一版把它只翻译成 ``deny file-write*``，于是这条规则挡住了删除、挡住了覆盖，
    唯独没挡住把内容读出来——而对一个装密钥的文件来说，读出来才是最坏的结果。
    """
    workspace = tmp_path / "ws"
    workspace.mkdir()
    (workspace / ".env").write_text("TOKEN=planted\n", encoding="utf-8")

    plan = build_command_sandbox_plan(
        ["/bin/sh", "-c", "cat .env"],
        writable_roots=[workspace],
        cwd=workspace,
        scope_id="read-deny",
        denied_path_patterns=["*/.env"],
    )
    proc = subprocess.run(
        plan.argv, env=dict(plan.env), cwd=workspace, capture_output=True, text=True
    )
    assert proc.returncode != 0
    assert "planted" not in proc.stdout


def test_the_file_tools_deny_reads_too(tmp_path: Path, monkeypatch) -> None:
    """文件工具那一侧一直是读写都拒的。两侧现在终于一致。"""
    from agenticx.cli import agent_tools
    from agenticx.cli.config_manager import ConfigManager

    secret = tmp_path / ".env"
    secret.write_text("TOKEN=1\n", encoding="utf-8")
    monkeypatch.setattr(
        ConfigManager,
        "get_value",
        staticmethod(
            lambda key, *a, **k: [{"pattern": "*/.env", "allow": False}]
            if key == "permissions.path_rules"
            else None
        ),
    )
    assert agent_tools._path_denied_by_rules(secret) is not None


# --------------------------------------------------------------------------
# 只读引用挂载也要受 deny 约束
# --------------------------------------------------------------------------
#
# 引用挂载被 ro-bind / allow-read 进来因而可读，但 Linux 的 deny 是「启动前枚举具体
# 路径」，而枚举只走了工作区和临时目录——于是 `cat reference/.env` 照读不误。
# macOS 下沉的是正则，天然覆盖所有路径，没有这个洞。只认具体路径的后端必须自己把
# 枚举范围补齐。


@pytest.mark.skipif(sys.platform != "darwin", reason="seatbelt is macOS-only")
def test_a_denied_file_in_a_reference_mount_cannot_be_read(tmp_path: Path) -> None:
    workspace = tmp_path / "ws"
    workspace.mkdir()
    reference = tmp_path / "reference"
    reference.mkdir()
    (reference / ".env").write_text("TOKEN=in-reference\n", encoding="utf-8")
    (reference / "notes.md").write_text("shared\n", encoding="utf-8")

    def _run(command: str) -> subprocess.CompletedProcess:
        plan = build_command_sandbox_plan(
            ["/bin/sh", "-c", command],
            writable_roots=[workspace],
            readable_roots=[reference],
            cwd=workspace,
            scope_id="ref-deny",
            denied_path_patterns=["*/.env"],
        )
        return subprocess.run(
            plan.argv, env=dict(plan.env), cwd=workspace, capture_output=True, text=True
        )

    denied = _run(f"cat {reference / '.env'}")
    assert denied.returncode != 0
    assert "in-reference" not in denied.stdout
    # 同一个挂载里没命中规则的文件照常可读——收紧不能把引用挂载整个废掉。
    assert _run(f"cat {reference / 'notes.md'}").stdout.strip() == "shared"


def test_linux_enumerates_deny_patterns_inside_reference_mounts(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setattr("shutil.which", lambda name, **_kw: "/usr/bin/bwrap")
    workspace = tmp_path / "ws"
    workspace.mkdir()
    (workspace / ".env").write_text("x", encoding="utf-8")
    reference = tmp_path / "reference"
    reference.mkdir()
    (reference / ".env").write_text("x", encoding="utf-8")

    plan = build_command_sandbox_plan(
        ["true"],
        writable_roots=[workspace],
        readable_roots=[reference],
        cwd=workspace,
        scope_id="ref-deny",
        denied_path_patterns=["*/.env"],
        platform_name="linux",
    )
    assert set(plan.denied_write_paths) == {workspace / ".env", reference / ".env"}


def test_the_deny_scan_never_walks_the_toolchain_roots(tmp_path: Path, monkeypatch) -> None:
    """枚举范围只加**会话的只读引用**，不加工具链与系统前缀。

    这不是保守，是必须：每条命令都遍历一次 ``/usr`` 既慢到不可接受，又会瞬间撞满
    512 条的枚举上限，把本来枚举得全的工作区那部分挤掉——**保护面反而更小**。
    """
    monkeypatch.setattr("shutil.which", lambda name, **_kw: "/usr/bin/bwrap")
    workspace = tmp_path / "ws"
    workspace.mkdir()
    (workspace / ".env").write_text("x", encoding="utf-8")

    plan = build_command_sandbox_plan(
        ["/usr/bin/env", "true"],
        writable_roots=[workspace],
        cwd=workspace,
        scope_id="no-walk",
        denied_path_patterns=["*"],
        platform_name="linux",
    )
    assert all(
        not str(path).startswith(("/usr", "/etc", "/opt", "/System"))
        for path in plan.denied_write_paths
    )
