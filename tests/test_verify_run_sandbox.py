#!/usr/bin/env python3
"""``verify_run`` 的每一步都要走和 ``bash_exec`` 同一个 OS 沙箱。

以前 :func:`run_verify` 里是裸的 ``subprocess.run``。于是 verify.yaml 里的一行
``cmd`` 可以读写主机上任何地方——**绕过工作区边界、绕过 path_rules、也绕过 plan
模式**。而 verify.yaml 是仓库里的文件：谁能改这个仓，谁就能借 verify_run 拿到工作区
之外的东西。一次 PR 就够了。

这类洞的共同点是「有一条路没汇进那个咽喉」。``denied_tools`` 那次是 meta 工具绕过
``dispatch_tool_async``，这次是 verify 绕过命令沙箱。所以用例盯的是**汇流**，不是
某一条具体规则。

Author: Damon Li
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

from agenticx.project_state.store import ProjectStore
from agenticx.project_state.verify import run_verify

darwin_only = pytest.mark.skipif(
    sys.platform != "darwin", reason="needs a real OS sandbox backend"
)


@pytest.fixture()
def project(tmp_path: Path):
    """一个最小的 project_state 仓，外加一个工作区外的假凭据文件。"""
    workspace = tmp_path / "ws"
    workspace.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "id_rsa").write_text("PLANTED-FAKE-KEY\n", encoding="utf-8")
    store = ProjectStore(workspace)
    store.verify_yaml_path.parent.mkdir(parents=True, exist_ok=True)
    return store, workspace, outside


def _write_steps(store: ProjectStore, cmd: str) -> None:
    store.verify_yaml_path.write_text(
        "version: 1\nsteps:\n  - name: probe\n    type: shell\n    cmd: "
        f"{cmd!r}\n",
        encoding="utf-8",
    )


@darwin_only
def test_a_verify_step_cannot_read_outside_the_workspace(project) -> None:
    store, workspace, outside = project
    _write_steps(store, f"cat {outside / 'id_rsa'}")
    result = run_verify(store, workspace_root=workspace)
    assert result.passed is False
    assert "PLANTED-FAKE-KEY" not in (result.steps[0].log_excerpt or "")


@darwin_only
def test_a_verify_step_cannot_write_outside_the_workspace(project) -> None:
    store, workspace, outside = project
    target = outside / "planted.txt"
    _write_steps(store, f"echo pwned > {target}")
    result = run_verify(store, workspace_root=workspace)
    assert result.passed is False
    assert not target.exists()


@darwin_only
def test_a_verify_step_still_works_inside_the_workspace(project) -> None:
    """收紧不能把功能弄没了——verify 的正常用途是在工作区里跑测试。"""
    store, workspace, _ = project
    _write_steps(store, "echo ok > built.txt && cat built.txt")
    result = run_verify(store, workspace_root=workspace)
    assert result.passed is True, result.steps[0].log_excerpt
    assert (workspace / "built.txt").read_text(encoding="utf-8").strip() == "ok"


@darwin_only
def test_path_rules_deny_applies_to_verify_steps_too(project) -> None:
    """path_rules 的 deny 在这条路径上也要生效，不然它就是一条绕过入口。"""
    store, workspace, _ = project
    (workspace / ".env").write_text("TOKEN=planted\n", encoding="utf-8")
    _write_steps(store, "cat .env")
    result = run_verify(
        store, workspace_root=workspace, denied_path_patterns=["*/.env"]
    )
    assert result.passed is False
    assert "planted" not in (result.steps[0].log_excerpt or "")


def test_a_missing_sandbox_backend_fails_the_step(project, monkeypatch) -> None:
    """拿不到边界就不跑。

    退回裸执行等于让 verify.yaml 里的一行 cmd 决定自己有多大权限——而那个文件是
    仓库内容，不是用户的设置。这条和 ``bash_exec`` 的立场一致：**「拿不到边界」
    不能等于「那就不要边界了」**。
    """
    store, workspace, _ = project
    _write_steps(store, "echo should-not-run > ran.txt")
    monkeypatch.setattr(
        "agenticx.project_state.verify.build_command_sandbox_plan",
        lambda *a, **k: (_ for _ in ()).throw(
            __import__(
                "agenticx.runtime.command_sandbox", fromlist=["CommandSandboxUnavailable"]
            ).CommandSandboxUnavailable("no backend here")
        ),
    )
    result = run_verify(store, workspace_root=workspace)
    assert result.passed is False
    assert result.steps[0].exit_code == 126
    assert "sandbox unavailable" in (result.steps[0].log_excerpt or "").lower()
    assert not (workspace / "ran.txt").exists()


# --------------------------------------------------------------------------
# 命令风险确认：文件沙箱之外的另一条线
# --------------------------------------------------------------------------
#
# 上一轮只给 verify_run 接了**文件沙箱**——工作区边界有了、path_rules 也生效了，但
# 命令风险这条线完全没接：ask / auto 档下，verify.yaml 里一行
# `cmd: rm -rf dist && git push` 照跑不误，一次都不问。plan 档整体拦住了 verify_run，
# 别的档没有。两条线都接上才算收口。


class _Gate:
    def __init__(self, approve: bool = True) -> None:
        self.approve = approve
        self.asked: list[tuple[str, dict]] = []
        self.last_denial_note = ""

    async def request_confirm(self, question: str, context: dict | None = None) -> bool:
        self.asked.append((question, dict(context or {})))
        return self.approve

    def should_emit_prompt(self, context: dict | None = None) -> bool:
        return False

    def is_service_mode(self) -> bool:
        return True


class _Session:
    def __init__(self, workspace: Path) -> None:
        self.taskspaces = [
            {"id": "default", "path": str(workspace), "mount": "link"}
        ]
        self.active_taskspace_id = "default"


@pytest.fixture()
def verify_project(tmp_path: Path):
    workspace = tmp_path / "ws"
    workspace.mkdir()
    ProjectStore.open(workspace, create=True)
    return _Session(workspace), workspace


def _set_steps(workspace: Path, cmd: str, *, name: str = "s1") -> None:
    ProjectStore.open(workspace).verify_yaml_path.write_text(
        f"version: 1\nsteps:\n  - name: {name}\n    type: shell\n    cmd: {cmd!r}\n",
        encoding="utf-8",
    )


@pytest.mark.parametrize(
    "cmd",
    ["rm -rf dist", "git push origin main", "curl -X POST https://example.com"],
)
def test_a_risky_verify_step_is_confirmed(verify_project, cmd: str) -> None:
    import asyncio

    from agenticx.cli.agent_tools import confirm_verify_steps

    session, workspace = verify_project
    _set_steps(workspace, cmd)
    gate = _Gate(approve=True)
    refusal = asyncio.run(
        confirm_verify_steps(session, {}, confirm_gate=gate)
    )
    assert refusal is None
    assert len(gate.asked) == 1, f"{cmd} 没有被问"
    # 问的那句话里要有真正要跑的命令，不能只说「有一个步骤有风险」。
    assert cmd in gate.asked[0][0]


def test_refusing_one_step_stops_the_whole_run(verify_project) -> None:
    """先全部问完再开跑，任何一步被拒就整个不跑。

    边跑边问会让用户在一次运行里被打断好几次，而且第三步被拒时前两步已经落地了——
    verify 的步骤在执行前就全知道，没有理由把它变成一路走一路问。
    """
    import asyncio

    from agenticx.cli.agent_tools import confirm_verify_steps

    session, workspace = verify_project
    ProjectStore.open(workspace).verify_yaml_path.write_text(
        "version: 1\nsteps:\n"
        "  - name: safe\n    type: shell\n    cmd: 'echo hi'\n"
        "  - name: risky\n    type: shell\n    cmd: 'rm -rf dist'\n",
        encoding="utf-8",
    )
    gate = _Gate(approve=False)
    refusal = asyncio.run(confirm_verify_steps(session, {}, confirm_gate=gate))
    assert refusal is not None and refusal.startswith("CANCELLED")
    assert "risky" in refusal


def test_a_plain_step_is_not_confirmed(verify_project) -> None:
    """收紧不能变成每一步都问——那样用户会学会一路点同意。"""
    import asyncio

    from agenticx.cli.agent_tools import confirm_verify_steps

    session, workspace = verify_project
    _set_steps(workspace, "echo hi")
    gate = _Gate()
    assert asyncio.run(confirm_verify_steps(session, {}, confirm_gate=gate)) is None
    assert gate.asked == []


def test_the_shell_command_is_classified_not_the_bash_wrapper(verify_project) -> None:
    """分类看的是用户写的 ``cmd``，不是 ``["bash", "-lc", cmd]``。

    看 argv 的话分类器只会得出「bash 是白名单命令」，真正危险的那一串在参数里，
    等于没分类——这是这类包装最容易出的错。
    """
    import asyncio

    from agenticx.cli.agent_tools import confirm_verify_steps

    session, workspace = verify_project
    _set_steps(workspace, "rm -rf build")
    gate = _Gate()
    asyncio.run(confirm_verify_steps(session, {}, confirm_gate=gate))
    assert gate.asked, "包装成 bash -lc 之后分类失效了"
    assert gate.asked[0][1].get("command") == "rm -rf build"


def test_it_reuses_the_same_allowed_commands_rule_as_bash_exec(
    verify_project, monkeypatch
) -> None:
    """「以后都不再问这条命令」在两处必须是同一个意思。

    另写一套判定就是另一套语义：用户在确认框里按下的那次豁免，如果只对 bash_exec
    生效而对 verify 步骤无效，他会以为自己配错了。
    """
    import asyncio

    from agenticx.cli import agent_tools
    from agenticx.cli.config_manager import ConfigManager

    session, workspace = verify_project
    _set_steps(workspace, "pytest -q")

    original = ConfigManager.get_value

    def _fake(key, *args, **kwargs):
        if key == "permissions.allowed_commands":
            return [{"pattern": "pytest -q", "workspace": str(workspace)}]
        if str(key).startswith("permissions."):
            return None
        return original(key, *args, **kwargs)

    monkeypatch.setattr(ConfigManager, "get_value", staticmethod(_fake))
    gate = _Gate()
    assert (
        asyncio.run(agent_tools.confirm_verify_steps(session, {}, confirm_gate=gate))
        is None
    )
    assert gate.asked == []


def test_destructive_steps_stay_unexemptible(verify_project, monkeypatch) -> None:
    """四类高危永不豁免，在这条路径上也一样。

    否则 ``allowed_commands`` 就成了绕过 verify 确认的后门——而它是用户在别处按
    「不再询问」时顺手写下的。
    """
    import asyncio

    from agenticx.cli import agent_tools
    from agenticx.cli.config_manager import ConfigManager

    session, workspace = verify_project
    _set_steps(workspace, "rm -rf dist")

    original = ConfigManager.get_value

    def _fake(key, *args, **kwargs):
        if key == "permissions.allowed_commands":
            return [{"pattern": "rm -rf dist", "workspace": str(workspace)}]
        if str(key).startswith("permissions."):
            return None
        return original(key, *args, **kwargs)

    monkeypatch.setattr(ConfigManager, "get_value", staticmethod(_fake))
    gate = _Gate()
    asyncio.run(agent_tools.confirm_verify_steps(session, {}, confirm_gate=gate))
    assert len(gate.asked) == 1


def test_denied_commands_block_a_step_outright(verify_project, monkeypatch) -> None:
    """``denied_commands`` 是绝对的，不提供「批准一次」。"""
    import asyncio

    from agenticx.cli import agent_tools
    from agenticx.cli.config_manager import ConfigManager

    session, workspace = verify_project
    _set_steps(workspace, "curl https://example.com")

    original = ConfigManager.get_value

    def _fake(key, *args, **kwargs):
        if key == "permissions.denied_commands":
            return ["curl *"]
        if str(key).startswith("permissions."):
            return None
        return original(key, *args, **kwargs)

    monkeypatch.setattr(ConfigManager, "get_value", staticmethod(_fake))
    gate = _Gate()
    refusal = asyncio.run(
        agent_tools.confirm_verify_steps(session, {}, confirm_gate=gate)
    )
    assert refusal is not None and refusal.startswith("ERROR:")
    assert gate.asked == []


def test_an_unexpected_preflight_failure_fails_closed(verify_project, monkeypatch) -> None:
    """预检自己出岔子时必须挡下来，不能静默放行。

    写成 ``except Exception: return None`` 的话，确认闸会**静默消失**而命令照跑——
    这一整轮修的就是这种失效。
    """
    import asyncio

    from agenticx.cli import agent_tools

    session, workspace = verify_project
    _set_steps(workspace, "rm -rf dist")
    monkeypatch.setattr(
        "agenticx.project_state.verify.verify_step_commands",
        lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom")),
    )
    refusal = asyncio.run(
        agent_tools.confirm_verify_steps(session, {}, confirm_gate=_Gate())
    )
    assert refusal is not None and refusal.startswith("ERROR:")
    assert "boom" in refusal
