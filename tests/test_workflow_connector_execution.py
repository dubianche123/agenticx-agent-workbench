"""Focused safety and action-contract tests for managed connector adapters."""

from __future__ import annotations

import asyncio
import json
import os
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Dict, List, Sequence

import pytest

from agenticx.runtime.workflow.connector_execution import (
    AsyncSubprocessRunner,
    CommandConnectorAdapter,
    CommandResult,
    build_connector_adapters,
)
from agenticx.runtime.workflow.execution import AdapterContext, AdapterResult


class FakeRunner:
    def __init__(self, result: CommandResult | None = None) -> None:
        self.result = result or CommandResult(returncode=0, stdout='{"ok":true}')
        self.calls: list[tuple[str, ...]] = []

    async def run(
        self,
        argv: Sequence[str],
        *,
        timeout: float,
        cancellation: asyncio.Event | None = None,
    ) -> CommandResult:
        self.calls.append(tuple(argv))
        if cancellation is not None and cancellation.is_set():
            return CommandResult(returncode=None, cancelled=True)
        return self.result


def context(
    *,
    connector_id: str = "feishu",
    action_id: str = "read_document",
    inputs: Dict[str, Any] | None = None,
    session: Any = None,
    timeout_seconds: float | None = None,
) -> AdapterContext:
    config: Dict[str, Any] = {"connector_id": connector_id, "action_id": action_id}
    if timeout_seconds is not None:
        config["timeout_seconds"] = timeout_seconds
    return AdapterContext(
        run_id="run-1",
        node_id="node-1",
        attempt_id="attempt-1",
        fencing_token=1,
        session_id="session-1",
        workflow_id="workflow-1",
        workflow_revision=2,
        workflow_digest="digest",
        owner_scope="owner",
        session=session,
        inputs=inputs or {},
        upstream={},
        node_config=config,
        cancellation=asyncio.Event(),
    )


def test_registry_covers_every_catalog_action_without_bare_ambiguous_keys() -> None:
    registry = build_connector_adapters(
        runner=FakeRunner(),
        binary_paths={
            "feishu": "/managed/lark-cli",
            "github": "/managed/gh",
            "qqmail": "/managed/agently-cli",
        },
    )

    expected = {
        "feishu:read_document",
        "feishu:propose_document_change",
        "feishu:apply_document_change",
        "feishu:lookup_message",
        "feishu:send_message",
        "wecom:lookup_message",
        "wecom:send_message",
        "github:read_work_item",
        "github:update_work_item",
        "tapd:read_work_item",
        "tapd:update_work_item",
        "tencent-meeting:list_meetings",
        "tencent-meeting:schedule_meeting",
        "qqmail:search_mail",
        "qqmail:draft_mail",
        "qqmail:send_mail",
    }
    assert expected <= {key for key in registry if isinstance(key, str)}
    assert all(isinstance(key, tuple) or ":" in key for key in registry)
    assert registry[("feishu", "read_document")] is registry["feishu:read_document"]


@pytest.mark.asyncio
async def test_qqmail_draft_is_explicitly_unavailable_and_never_invokes_send() -> None:
    runner = FakeRunner()
    registry = build_connector_adapters(
        runner=runner,
        binary_paths={"qqmail": "/managed/agently-cli"},
    )
    draft = registry["qqmail:draft_mail"]
    send = registry["qqmail:send_mail"]
    draft_ctx = context(
        connector_id="qqmail",
        action_id="draft_mail",
        inputs={"to": ["person@example.com"], "subject": "Never sent", "body": "fixture"},
    )

    availability = await draft.availability(draft_ctx)
    result = await draft.execute(draft_ctx)
    send_availability = await send.availability(context(connector_id="qqmail", action_id="send_mail", inputs={"draft_ref": "draft-1"}))

    assert not availability.available
    assert "action_unavailable" in availability.reason
    assert availability.details["code"] == "action_unavailable"
    assert result.normalized_outcome() == "blocked"
    assert "action_unavailable" in result.reason
    assert not send_availability.available
    # A draft request must never be translated to ``message +send`` or run
    # any CLI probe/command as a side effect.
    assert runner.calls == []


@pytest.mark.asyncio
async def test_feishu_read_uses_verified_argv_and_keeps_metacharacters_as_data() -> None:
    runner = FakeRunner()
    registry = build_connector_adapters(
        runner=runner,
        binary_paths={"feishu": "/managed/lark-cli"},
    )
    adapter = registry["feishu:read_document"]
    ctx = context(inputs={"document_ref": "doc-1; touch SHOULD_NOT_EXIST"})

    available = await adapter.availability(ctx)
    result = await adapter.execute(ctx)

    assert available.available
    assert result.normalized_outcome() == "done"
    assert runner.calls[0] == ("/managed/lark-cli", "auth", "status", "--json")
    assert runner.calls[1][:4] == ("/managed/lark-cli", "docs", "+fetch", "--doc")
    assert runner.calls[1][4] == "doc-1; touch SHOULD_NOT_EXIST"
    assert "sh" not in runner.calls[1]


@pytest.mark.asyncio
async def test_feishu_proposal_is_frozen_and_apply_rejects_tampering() -> None:
    runner = FakeRunner(CommandResult(returncode=0, stdout='{"dry_run":true}'))
    registry = build_connector_adapters(
        runner=runner,
        binary_paths={"feishu": "/managed/lark-cli"},
    )
    propose = registry["feishu:propose_document_change"]
    proposal_ctx = context(
        action_id="propose_document_change",
        inputs={"document_ref": "doc-1", "change_summary": "{\"command\":\"append\",\"content\":\"fixed\"}"},
    )
    proposal_result = await propose.execute(proposal_ctx)
    assert proposal_result.normalized_outcome() == "done"
    payload = json.loads(str(proposal_result.output))
    change_ref = payload["change_ref"]
    frozen = json.loads(change_ref)
    frozen["content"] = "changed after approval"

    apply = registry["feishu:apply_document_change"]
    tampered_ctx = context(
        action_id="apply_document_change",
        inputs={"document_ref": "doc-1", "change_ref": json.dumps(frozen)},
    )
    tampered_result = await apply.execute(tampered_ctx)

    assert tampered_result.normalized_outcome() == "blocked"
    assert "changed" in tampered_result.reason or "digest" in tampered_result.reason
    # The tampered payload must fail before the real docs update command.
    assert not any("--dry-run" not in call for call in runner.calls)


@pytest.mark.asyncio
async def test_github_update_uses_catalogued_edit_flags_and_reports_external_success() -> None:
    runner = FakeRunner()
    registry = build_connector_adapters(
        runner=runner,
        binary_paths={"github": "/managed/gh"},
    )
    adapter = registry["github:update_work_item"]
    ctx = context(
        connector_id="github",
        action_id="update_work_item",
        inputs={
            "repository_ref": "acme/project",
            "work_item_ref": "pr:23",
            "change_summary": json.dumps({"title": "--keep-as-data", "labels": ["workflow"]}),
        },
    )

    result = await adapter.execute(ctx)

    assert result.normalized_outcome() == "done"
    call = runner.calls[-1]
    assert call[:7] == ("/managed/gh", "pr", "edit", "23", "--repo", "acme/project", "--title")
    assert call[7] == "--keep-as-data"
    assert call[8:] == ("--add-label", "workflow")
    assert result.side_effect_state == "applied"


@pytest.mark.asyncio
async def test_cli_failure_and_secret_like_output_are_not_reported_as_success(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GH_TOKEN", "super-secret-token-value")
    runner = FakeRunner(CommandResult(returncode=2, stdout="token=super-secret-token-value", stderr="bad input"))
    registry = build_connector_adapters(
        runner=runner,
        binary_paths={"github": "/managed/gh"},
    )
    adapter = registry["github:read_work_item"]
    ctx = context(
        connector_id="github",
        action_id="read_work_item",
        inputs={"repository_ref": "acme/project", "work_item_ref": "23"},
    )

    result = await adapter.execute(ctx)

    assert result.normalized_outcome() == "failed"
    assert "super-secret-token-value" not in str(result.output)
    assert "super-secret-token-value" not in result.reason


@pytest.mark.asyncio
async def test_tapd_uses_session_mcp_hub_dynamic_route_and_maps_schema_aliases() -> None:
    @dataclass
    class Snapshot:
        server_name: str = "tapd"
        original_name: str = "read_work_item"
        routed_name: str = "tapd__read_work_item"
        description: str = "Read TAPD work item"
        input_schema: dict[str, Any] = None  # type: ignore[assignment]
        enabled: bool = True

        def __post_init__(self) -> None:
            self.input_schema = {
                "type": "object",
                "properties": {"project_id": {"type": "string"}, "work_item_id": {"type": "string"}},
            }

    class Hub:
        def __init__(self) -> None:
            self.calls: list[tuple[str, dict[str, Any]]] = []

        def list_tool_snapshots(self) -> list[Snapshot]:
            return [Snapshot()]

        async def call_tool(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
            self.calls.append((name, arguments))
            return {"item": "real-result"}

    hub = Hub()
    registry = build_connector_adapters()
    adapter = registry["tapd:read_work_item"]
    ctx = context(
        connector_id="tapd",
        action_id="read_work_item",
        session=SimpleNamespace(mcp_hub=hub),
        inputs={"project_ref": "project-1", "work_item_ref": "story-2"},
    )

    available = await adapter.availability(ctx)
    result = await adapter.execute(ctx)

    assert available.available
    assert result.normalized_outcome() == "done"
    assert hub.calls == [("tapd__read_work_item", {"project_id": "project-1", "work_item_id": "story-2"})]
    assert "real-result" in str(result.output)


@pytest.mark.asyncio
async def test_unverified_actions_are_explicitly_unavailable() -> None:
    registry = build_connector_adapters()
    ctx = context(connector_id="tencent-meeting", action_id="list_meetings")
    tmeet = registry["tencent-meeting:list_meetings"]
    wecom = registry["wecom:lookup_message"]

    tmeet_status = await tmeet.availability(ctx)
    wecom_status = await wecom.availability(context(connector_id="wecom", action_id="lookup_message"))

    assert not tmeet_status.available
    assert "不会猜测" in tmeet_status.reason
    assert not wecom_status.available
    assert "MCP" in wecom_status.reason


@pytest.mark.asyncio
async def test_real_subprocess_fixture_bounds_output_and_reaps_on_timeout_and_cancel(tmp_path: Path) -> None:
    runner = AsyncSubprocessRunner(max_output_chars=1024)
    huge = await runner.run(
        (sys.executable, "-c", "print('x' * 100000)"),
        timeout=3,
    )
    assert huge.output_truncated
    assert len(huge.stdout) <= 1024

    timed = await runner.run(
        (sys.executable, "-c", "import time; time.sleep(5)"),
        timeout=0.1,
    )
    assert timed.timed_out

    cancellation = asyncio.Event()

    async def cancel_soon() -> None:
        await asyncio.sleep(0.05)
        cancellation.set()

    start = time.monotonic()
    task = asyncio.create_task(
        runner.run(
            (sys.executable, "-c", "import time; time.sleep(5)"),
            timeout=5,
            cancellation=cancellation,
        )
    )
    await asyncio.gather(task, cancel_soon())
    cancelled = task.result()
    assert cancelled.cancelled
    assert time.monotonic() - start < 2


async def _wait_for_child_pid(path: Path, task: asyncio.Task[Any]) -> int:
    deadline = time.monotonic() + 2
    while not path.exists() and not task.done() and time.monotonic() < deadline:
        await asyncio.sleep(0.01)
    assert path.exists(), "fixture child did not start before the runner task was cancelled"
    return int(path.read_text())


async def _assert_process_exited(pid: int) -> None:
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return
        except PermissionError:
            # The fixture is ours; retain a useful failure if the platform
            # unexpectedly denies the probe rather than treating it as dead.
            pass
        await asyncio.sleep(0.02)
    pytest.fail(f"managed connector child process {pid} survived runner cleanup")


@pytest.mark.asyncio
async def test_runner_reaps_grandchild_pipes_after_parent_exit_and_outer_cancel(tmp_path: Path) -> None:
    runner = AsyncSubprocessRunner(max_output_chars=1024)
    parent_exit_pid = tmp_path / "parent-exit-child.pid"
    parent_exit_script = (
        "import pathlib, subprocess, sys, time; "
        "child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)']); "
        "pathlib.Path(sys.argv[1]).write_text(str(child.pid)); "
        "print(child.pid, flush=True); time.sleep(0.05)"
    )

    start = time.monotonic()
    completed = await runner.run(
        (sys.executable, "-c", parent_exit_script, str(parent_exit_pid)),
        timeout=5,
    )
    assert completed.returncode == 0
    assert time.monotonic() - start < 2
    await _assert_process_exited(int(parent_exit_pid.read_text()))

    cancelled_pid_path = tmp_path / "cancelled-child.pid"
    cancelled_script = (
        "import pathlib, subprocess, sys, time; "
        "child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)']); "
        "pathlib.Path(sys.argv[1]).write_text(str(child.pid)); "
        "print(child.pid, flush=True); time.sleep(60)"
    )
    task = asyncio.create_task(
        runner.run(
            (sys.executable, "-c", cancelled_script, str(cancelled_pid_path)),
            timeout=60,
        )
    )
    child_pid = await _wait_for_child_pid(cancelled_pid_path, task)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    await _assert_process_exited(child_pid)
    leaked = [item for item in asyncio.all_tasks() if item is not asyncio.current_task() and not item.done()]
    assert not leaked, f"runner left pending cleanup tasks: {leaked!r}"


@pytest.mark.asyncio
async def test_actual_runner_never_invokes_shell_for_dangerous_argument(tmp_path: Path) -> None:
    marker = tmp_path / "should-not-exist"
    runner = AsyncSubprocessRunner()

    def argv_builder(binary: str, ctx: AdapterContext) -> Sequence[str]:
        return (binary, "-c", "import sys; print(sys.argv[1])", ctx.inputs["value"])

    adapter = CommandConnectorAdapter(
        "fixture",
        "echo",
        "read",
        lambda: sys.executable,
        argv_builder,
        runner,
    )
    ctx = context(inputs={"value": f"; touch {marker}"})
    result = await adapter.execute(ctx)

    assert result.normalized_outcome() == "done"
    assert f"touch {marker}" in str(result.output)
    assert not marker.exists()
