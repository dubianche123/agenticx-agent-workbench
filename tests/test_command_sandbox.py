"""Focused tests for the OS-enforced Studio command sandbox."""

from __future__ import annotations

import base64
import json
import os
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from agenticx.cli import agent_tools
from agenticx.runtime import command_sandbox
from agenticx.runtime.command_sandbox import (
    COMMAND_SANDBOX_PERMISSIONS,
    DANGER_FULL_ACCESS,
    READ_ONLY,
    WORKSPACE_WRITE,
    CommandSandboxError,
    CommandSandboxUnavailable,
    build_command_sandbox_plan,
    normalize_command_permissions,
)
from agenticx.cli.studio import StudioSession


def test_permissions_default_to_workspace_write() -> None:
    assert normalize_command_permissions(None) == WORKSPACE_WRITE
    assert normalize_command_permissions("") == WORKSPACE_WRITE


def test_unknown_permissions_are_rejected() -> None:
    with pytest.raises(CommandSandboxError, match="unsupported sandbox_permissions"):
        normalize_command_permissions("unrestricted")


@pytest.mark.parametrize(
    ("parts", "expected"),
    [
        (["git", "status", "--short"], "git status"),
        (["git", "-C", "repo", "diff", "--stat"], "git diff"),
        (["npm", "run", "test", "--", "--watch"], "npm run test"),
        (["python", "-m", "pytest", "tests"], "python -m pytest"),
        (["node", "script.mjs", "--check"], "node script.mjs"),
    ],
)
def test_command_approval_prefix_is_semantic(parts: list[str], expected: str) -> None:
    assert agent_tools._command_approval_prefix(parts[0], parts) == expected


def test_danger_full_access_keeps_raw_argv_and_environment(tmp_path: Path) -> None:
    plan = build_command_sandbox_plan(
        ["echo", "ok"],
        permissions=DANGER_FULL_ACCESS,
        writable_roots=[tmp_path],
        environ={"EXAMPLE": "1"},
        platform_name="unsupported-test-host",
    )
    assert plan.argv == ("echo", "ok")
    assert plan.env == {"EXAMPLE": "1"}
    assert plan.backend == "none"
    assert plan.writable_roots == ()


def test_macos_plan_denies_global_writes_and_allows_workspace(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    plan = build_command_sandbox_plan(
        ["/usr/bin/touch", "marker"],
        permissions=WORKSPACE_WRITE,
        writable_roots=[workspace],
        scope_id="session-a",
        cwd=workspace,
        environ={"PATH": "/usr/bin:/bin"},
        platform_name="darwin",
    )

    assert plan.argv[:2] == ("/usr/bin/sandbox-exec", "-p")
    assert plan.argv[-2:] == ("/usr/bin/touch", "marker")
    profile = plan.argv[2]
    # 读和写都是默认拒，工作区再单独放行。
    assert "(deny file-read-data file-write*)" in profile
    assert f'(allow file-write* (subpath "{workspace}"))' in profile
    assert f'(allow file-read-data (subpath "{workspace}"))' in profile
    assert plan.temp_dir is not None
    assert f'(subpath "{plan.temp_dir}")' in profile
    assert plan.env["TMPDIR"] == str(plan.temp_dir)
    assert plan.backend == "macos-sandbox-exec"


def test_macos_profile_escapes_workspace_path(tmp_path: Path) -> None:
    workspace = tmp_path / 'quote"slash\\path'
    workspace.mkdir()
    plan = build_command_sandbox_plan(
        ["true"],
        writable_roots=[workspace],
        scope_id="escaped-path",
        platform_name="darwin",
    )
    profile = plan.argv[2]
    assert '\\"' in profile
    assert "\\\\" in profile


def test_linux_workspace_write_fails_closed_without_bubblewrap(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    # ``_toolchain_read_roots`` 也调 which（带 path= 关键字）去解析被执行的那个二进制，
    # 所以替身必须收 **kwargs——不然这里挂掉的是「解析工具链」，不是「找不到后端」。
    monkeypatch.setattr(command_sandbox.shutil, "which", lambda _name, **_kw: None)
    with pytest.raises(CommandSandboxUnavailable, match="bubblewrap"):
        build_command_sandbox_plan(
            ["true"],
            writable_roots=[tmp_path],
            platform_name="linux",
        )


def test_windows_plan_uses_mxc_process_container(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    runner = tmp_path / "wxc-exec.exe"
    runner.touch()
    readonly = tmp_path / "readonly"
    readonly.mkdir()
    monkeypatch.setattr(
        command_sandbox,
        "_windows_readonly_paths",
        lambda *_args, **_kwargs: (readonly,),
    )

    plan = build_command_sandbox_plan(
        [r"C:\Windows\System32\cmd.exe", "/d", "/s", "/c", "echo hello"],
        writable_roots=[workspace],
        scope_id="session-windows",
        cwd=workspace,
        environ={
            "PATH": "",
            command_sandbox.WINDOWS_MXC_EXECUTABLE_ENV: str(runner),
        },
        platform_name="win32",
    )

    assert plan.backend == "windows-mxc-process-container"
    assert plan.argv[:2] == (str(runner.resolve()), "--config-base64")
    config = json.loads(base64.b64decode(plan.argv[2]).decode("utf-8"))
    assert config["version"] == command_sandbox.WINDOWS_MXC_SCHEMA_VERSION
    assert config["containment"] == "processcontainer"
    assert config["containerId"].startswith("agenticx-")
    assert config["process"]["cwd"] == str(workspace.resolve())
    assert "cmd.exe" in config["process"]["commandLine"]
    assert str(workspace.resolve()) in config["filesystem"]["readwritePaths"]
    assert str(plan.temp_dir) in config["filesystem"]["readwritePaths"]
    assert config["filesystem"]["readonlyPaths"] == [str(readonly)]
    assert config["network"] == {
        "defaultPolicy": "allow",
        "allowLocalNetwork": True,
    }
    assert config["ui"]["disable"] is False
    assert config["fallback"]["allowDaclMutation"] is True
    assert plan.env["TMPDIR"] == str(plan.temp_dir)
    assert plan.env["TEMP"] == str(plan.temp_dir)
    assert plan.env["TMP"] == str(plan.temp_dir)


def test_windows_read_grants_exclude_nested_writable_roots(tmp_path: Path) -> None:
    profile = tmp_path / "profile"
    workspace = profile / "project"
    reference = tmp_path / "reference"
    tool_bin = tmp_path / "tools" / "bin"
    system_root = tmp_path / "windows"
    system_bin = system_root / "System32"
    workspace.mkdir(parents=True)
    reference.mkdir()
    tool_bin.mkdir(parents=True)
    system_bin.mkdir(parents=True)

    readonly = command_sandbox._windows_readonly_paths(
        (workspace.resolve(),),
        readable_roots=(reference.resolve(), workspace.resolve()),
        argv=(str(tool_bin / "tool.exe"),),
        cwd=workspace,
        environ={
            "USERPROFILE": str(profile),
            "SystemRoot": str(system_root),
            "PATH": os.pathsep.join((str(tool_bin), str(system_bin))),
        },
    )

    assert profile.resolve() in readonly
    assert reference.resolve() in readonly
    assert tool_bin.resolve() in readonly
    assert system_bin.resolve() not in readonly
    assert workspace.resolve() not in readonly


def test_windows_workspace_write_fails_closed_without_mxc(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    # ``_toolchain_read_roots`` 也调 which（带 path= 关键字）去解析被执行的那个二进制，
    # 所以替身必须收 **kwargs——不然这里挂掉的是「解析工具链」，不是「找不到后端」。
    monkeypatch.setattr(command_sandbox.shutil, "which", lambda _name, **_kw: None)
    with pytest.raises(CommandSandboxUnavailable, match="Microsoft MXC"):
        build_command_sandbox_plan(
            ["cmd.exe", "/c", "echo ok"],
            writable_roots=[tmp_path],
            environ={"PATH": ""},
            platform_name="win32",
        )


def test_windows_workspace_write_rejects_missing_configured_runner(tmp_path: Path) -> None:
    missing = tmp_path / "missing-wxc-exec.exe"
    with pytest.raises(CommandSandboxUnavailable, match="does not exist"):
        build_command_sandbox_plan(
            ["cmd.exe", "/c", "echo ok"],
            writable_roots=[tmp_path],
            environ={command_sandbox.WINDOWS_MXC_EXECUTABLE_ENV: str(missing)},
            platform_name="win32",
        )


def test_unsupported_host_workspace_write_fails_closed(tmp_path: Path) -> None:
    with pytest.raises(CommandSandboxUnavailable, match="no supported OS sandbox"):
        build_command_sandbox_plan(
            ["true"],
            writable_roots=[tmp_path],
            platform_name="plan9",
        )


@pytest.mark.asyncio
async def test_danger_full_access_always_requires_escalation_confirmation(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    calls: list[tuple[str, dict]] = []

    async def _approve(question: str, **kwargs: object) -> bool:
        calls.append((question, dict(kwargs.get("context") or {})))
        return True

    monkeypatch.setattr(agent_tools, "_confirm", _approve)
    session = StudioSession(workspace_dir=str(tmp_path))
    prepared = await agent_tools._bash_exec_prepare(
        "ls",
        {"command": "ls", "sandbox_permissions": DANGER_FULL_ACCESS},
        session,
        tool_name="bash_exec",
        confirm_gate=MagicMock(),
        emit_event=None,
    )

    assert not isinstance(prepared, str)
    assert prepared.argv == ["ls"]
    assert prepared.sandbox_permissions == DANGER_FULL_ACCESS
    assert prepared.sandbox_backend == "none"
    assert len(calls) == 1
    assert calls[0][1]["risk"] == "permission_escalation"
    assert calls[0][1]["command_prefix"] == "ls"
    assert calls[0][1]["workspace_roots"] == [str(tmp_path)]
    assert calls[0][1]["sandbox_permissions"] == DANGER_FULL_ACCESS
    assert calls[0][1]["approval_reuse"] == "none"
    assert calls[0][1]["risk_categories"] == [
        {
            "code": "host_full_access",
            "evidence": "danger-full-access 会退出工作区写入隔离",
        }
    ]


@pytest.mark.asyncio
async def test_contained_high_risk_command_emits_structured_exact_reuse_scope(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    calls: list[tuple[str, dict]] = []

    async def _approve(question: str, **kwargs: object) -> bool:
        calls.append((question, dict(kwargs.get("context") or {})))
        return True

    def _passthrough_plan(argv: list[str], *, permissions: str, **_kwargs: object) -> object:
        return SimpleNamespace(
            argv=tuple(argv),
            env={},
            permissions=normalize_command_permissions(permissions),
            backend="test-passthrough",
        )

    monkeypatch.setattr(agent_tools, "_confirm", _approve)
    monkeypatch.setattr(agent_tools, "build_command_sandbox_plan", _passthrough_plan)
    session = StudioSession(workspace_dir=str(tmp_path))
    prepared = await agent_tools._bash_exec_prepare(
        "python -c 'print(1)'",
        {"command": "python -c 'print(1)'"},
        session,
        tool_name="bash_exec",
        confirm_gate=MagicMock(),
        emit_event=None,
    )

    assert not isinstance(prepared, str)
    assert len(calls) == 1
    context = calls[0][1]
    assert context["risk"] == "high"
    assert context["approval_reuse"] == "exact-command"
    assert context["sandbox_permissions"] == WORKSPACE_WRITE
    assert context["risk_categories"] == [
        {
            "code": "arbitrary_code_execution",
            "evidence": "python -c/-m 可执行任意 Python 代码",
        }
    ]


def test_remote_publish_and_system_operations_never_offer_reusable_approval() -> None:
    push_findings = agent_tools._collect_command_risk_findings(
        "git",
        ["git", "push", "--force"],
        "git push --force",
    )
    assert {finding["code"] for finding in push_findings} == {
        "version_control_change",
        "external_publish",
    }
    assert agent_tools._protected_command_reuse_mode(push_findings) == "none"

    reboot_findings = agent_tools._collect_command_risk_findings(
        "reboot",
        ["reboot"],
        "reboot",
    )
    assert {finding["code"] for finding in reboot_findings} == {"system_disruption"}
    assert agent_tools._protected_command_reuse_mode(reboot_findings) == "none"


@pytest.mark.asyncio
async def test_danger_full_access_denial_never_builds_launch_plan(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    async def _deny(*_args: object, **_kwargs: object) -> bool:
        return False

    def _must_not_build(*_args: object, **_kwargs: object) -> object:
        raise AssertionError("denied escalation must not build a subprocess plan")

    monkeypatch.setattr(agent_tools, "_confirm", _deny)
    monkeypatch.setattr(agent_tools, "build_command_sandbox_plan", _must_not_build)
    session = StudioSession(workspace_dir=str(tmp_path))
    result = await agent_tools._bash_exec_prepare(
        "ls",
        {"command": "ls", "sandbox_permissions": DANGER_FULL_ACCESS},
        session,
        tool_name="bash_exec",
        confirm_gate=MagicMock(),
        emit_event=None,
    )
    assert isinstance(result, str)
    assert result.startswith("CANCELLED: 未批准 danger-full-access")


def test_bash_tool_schemas_expose_every_permission_level() -> None:
    """模型能选到的档位必须与沙箱真正支持的一致。

    2026-08-24 加了第三档 read-only：调研型任务全程只读，写全被拒，文件类的确认框
    整体消失。档位藏着不给模型选，等于这一档不存在。
    """
    by_name = {
        item["function"]["name"]: item["function"]["parameters"]
        for item in agent_tools.STUDIO_TOOLS
        if item.get("type") == "function"
    }
    for name in ("bash_exec", "bash_bg_start"):
        schema = by_name[name]["properties"]["sandbox_permissions"]
        assert schema["enum"] == [READ_ONLY, WORKSPACE_WRITE, DANGER_FULL_ACCESS]
        assert set(schema["enum"]) == set(COMMAND_SANDBOX_PERMISSIONS), (
            "工具 schema 与 COMMAND_SANDBOX_PERMISSIONS 不一致——"
            "要么模型选不到某一档，要么会选到沙箱不认的值。"
        )
