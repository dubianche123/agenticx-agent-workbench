from __future__ import annotations

import asyncio
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from agenticx.cli.studio import StudioSession
from agenticx.runtime.events import RuntimeEvent
from agenticx.runtime.graph.models import NodeStatus
from agenticx.runtime.graph.store import GraphRunStore
from agenticx.runtime.workflow import (
    WorkflowClaimConflict,
    WorkflowExecutor,
    WorkflowExecutorError,
    WorkflowExecutionBlocked,
    WorkflowRunConflict,
    WorkflowRuntimeService,
    WorkflowStore,
    WorkflowValidationError,
    bounded_json_value,
    workflow_execution_envelope,
)
from agenticx.runtime.workflow.connectors import resolve_connector_action
from agenticx.runtime.workflow.execution import AdapterContext, AdapterResult
from agenticx.studio.session_manager import ManagedSession


def _runtime(tmp_path: Path, raw: dict) -> tuple[WorkflowRuntimeService, object]:
    workflows = WorkflowStore(tmp_path / "workflows")
    snapshot = workflows.create("owner", raw)
    workflows.publish(snapshot.workflow_id, "owner", 1, 1)
    graph = GraphRunStore(tmp_path / "graph-runs")
    service = WorkflowRuntimeService(workflows, graph, owner_scope="owner")
    return service, service.create_run(snapshot.workflow_id, 1, "session").run


def _linear_workflow(*, config: dict | None = None) -> dict:
    task = {
        "id": "task",
        "kind": "agent_task",
        "label": "Task",
        "objective": "Do the task",
        "deliverable": "A result",
        "acceptance_criteria": ["The result is recorded"],
    }
    if config:
        task["config"] = config
    return {
        "title": "Executor workflow",
        "objective": "Run the task",
        "completion_criteria": ["The task is recorded"],
        "nodes": [
            {"id": "trigger", "kind": "trigger", "label": "Start"},
            task,
            {"id": "end", "kind": "end", "label": "End"},
        ],
        "edges": [
            {"id": "e1", "source": "trigger", "target": "task"},
            {"id": "e2", "source": "task", "target": "end"},
        ],
    }


def _decision_workflow() -> dict:
    return {
        "title": "Decision executor workflow",
        "objective": "Choose one route",
        "completion_criteria": ["the selected route is recorded"],
        "nodes": [
            {"id": "trigger", "kind": "trigger", "label": "Start"},
            {
                "id": "decision",
                "kind": "decision",
                "label": "Choose route",
                "objective": "Choose a route",
                "deliverable": "A route decision",
                "acceptance_criteria": ["The route is explicit"],
            },
            {
                "id": "safe-task",
                "kind": "agent_task",
                "label": "Safe",
                "objective": "Run safe path",
                "deliverable": "Safe result",
                "acceptance_criteria": ["Safe path is recorded"],
            },
            {
                "id": "unsafe-task",
                "kind": "agent_task",
                "label": "Unsafe",
                "objective": "Run unsafe path",
                "deliverable": "Unsafe result",
                "acceptance_criteria": ["Unsafe path is recorded"],
            },
            {"id": "join", "kind": "join", "label": "Join", "config": {"mode": "all"}},
            {"id": "end", "kind": "end", "label": "End"},
        ],
        "edges": [
            {"id": "e1", "source": "trigger", "target": "decision"},
            {"id": "e2", "source": "decision", "target": "safe-task", "route": "safe"},
            {"id": "e3", "source": "decision", "target": "unsafe-task", "route": "unsafe"},
            {"id": "e4", "source": "safe-task", "target": "join"},
            {"id": "e5", "source": "unsafe-task", "target": "join"},
            {"id": "e6", "source": "join", "target": "end"},
        ],
    }


def test_claim_lease_recovery_and_stale_fence(tmp_path: Path) -> None:
    service, run = _runtime(tmp_path, _linear_workflow())
    claim = service.claim_node(
        run.run_id,
        "task",
        "session",
        claim_owner="worker-a",
        lease_seconds=1,
        now=100,
        owner_scope="owner",
    )
    assert claim.fencing_token == 1
    with pytest.raises(WorkflowClaimConflict):
        service.claim_node(
            run.run_id,
            "task",
            "session",
            claim_owner="worker-b",
            lease_seconds=1,
            now=100.5,
            owner_scope="owner",
        )

    recovered = service.claim_node(
        run.run_id,
        "task",
        "session",
        claim_owner="worker-b",
        lease_seconds=10,
        now=102,
        owner_scope="owner",
    )
    assert recovered.attempt_id != claim.attempt_id
    assert recovered.fencing_token == 2
    with pytest.raises(WorkflowClaimConflict):
        service.complete_node_claim(
            run.run_id,
            "task",
            "session",
            attempt_id=claim.attempt_id,
            fencing_token=claim.fencing_token,
            outcome="done",
            output_summary="stale result",
            owner_scope="owner",
            now=103,
        )
    with pytest.raises(WorkflowClaimConflict, match="claim owner"):
        service.complete_node_claim(
            run.run_id,
            "task",
            "session",
            attempt_id=recovered.attempt_id,
            fencing_token=recovered.fencing_token,
            claim_owner="renderer",
            outcome="done",
            output_summary="forged result",
            owner_scope="owner",
            now=103,
        )
    completed = service.complete_node_claim(
        run.run_id,
        "task",
        "session",
        attempt_id=recovered.attempt_id,
        fencing_token=recovered.fencing_token,
        outcome="done",
        output_summary="fresh result",
        owner_scope="owner",
        now=103,
    )
    assert completed.nodes["task"].status is NodeStatus.DONE
    assert completed.nodes["end"].status is NodeStatus.DONE
    assert completed.status == "closed"


def test_uncertain_effect_requires_reconciliation_before_retry(tmp_path: Path) -> None:
    service, run = _runtime(tmp_path, _linear_workflow())
    claim = service.claim_node(
        run.run_id,
        "task",
        "session",
        claim_owner="worker",
        owner_scope="owner",
        now=100,
    )
    blocked = service.complete_node_claim(
        run.run_id,
        "task",
        "session",
        attempt_id=claim.attempt_id,
        fencing_token=claim.fencing_token,
        outcome="uncertain",
        output_summary="write response was lost",
        side_effect_state="uncertain",
        owner_scope="owner",
        now=101,
    )
    assert blocked.nodes["task"].status is NodeStatus.BLOCKED
    assert blocked.nodes["task"].meta["workflow_reconciliation_required"] is True
    with pytest.raises(WorkflowExecutorError, match="reconciliation"):
        service.retry_node(
            run.run_id,
            "task",
            "session",
            blocked.version,
            owner_scope="owner",
        )
    retried = service.retry_node(
        run.run_id,
        "task",
        "session",
        blocked.version,
        reconcile=True,
        owner_scope="owner",
    )
    assert retried.nodes["task"].status is NodeStatus.READY


def test_expired_external_dispatch_is_recovered_to_reconciliation(tmp_path: Path) -> None:
    raw = {
        "title": "External dispatch",
        "objective": "Send a message",
        "completion_criteria": ["the message is handled"],
        "nodes": [
            {"id": "trigger", "kind": "trigger", "label": "Start"},
            {
                "id": "send",
                "kind": "connector_action",
                "label": "Send",
                "objective": "Send a message",
                "deliverable": "Message result",
                "acceptance_criteria": ["The send is evidenced"],
                "config": {
                    "connector_id": "feishu",
                    "action_id": "send_message",
                    "conversation_ref": "chat-1",
                    "message": "hello",
                },
            },
            {"id": "end", "kind": "end", "label": "End"},
        ],
        "edges": [
            {"id": "e1", "source": "trigger", "target": "send"},
            {"id": "e2", "source": "send", "target": "end"},
        ],
    }
    service, run = _runtime(tmp_path, raw)
    claim = service.claim_node(
        run.run_id,
        "send",
        "session",
        claim_owner="worker",
        lease_seconds=1,
        owner_scope="owner",
        now=100,
    )
    marked = service.mark_node_side_effect(
        run.run_id,
        "send",
        "session",
        attempt_id=claim.attempt_id,
        fencing_token=claim.fencing_token,
        state="dispatching",
        intent_digest="a" * 64,
        claim_owner="worker",
        owner_scope="owner",
        now=100.1,
    )
    assert marked.nodes["send"].meta["workflow_side_effect_state"] == "dispatching"
    with pytest.raises(WorkflowClaimConflict, match="uncertain"):
        service.claim_node(
            run.run_id,
            "send",
            "session",
            claim_owner="replacement",
            lease_seconds=1,
            owner_scope="owner",
            now=102,
        )
    recovered = service.get_run(run.run_id, "session", owner_scope="owner")
    assert recovered.nodes["send"].status is NodeStatus.BLOCKED
    assert recovered.nodes["send"].meta["workflow_reconciliation_required"] is True


class _FinalRuntime:
    def __init__(
        self,
        text: str = "runtime result",
        *,
        terminal_reason: str | None = None,
        terminal_metadata: dict[str, object] | None = None,
    ) -> None:
        self.text = text
        self.terminal_reason = terminal_reason
        self.terminal_metadata = dict(terminal_metadata or {})
        self.called = False

    async def run_turn(self, *_args, **_kwargs):
        self.called = True
        data: dict[str, object] = {"text": self.text, **self.terminal_metadata}
        if self.terminal_reason is not None:
            data["terminal_reason"] = self.terminal_reason
        yield RuntimeEvent(type="final", data=data)


class _ToolFallbackRuntime:
    def __init__(self, *, silence_kind: str) -> None:
        self.silence_kind = silence_kind

    async def run_turn(self, *_args, **_kwargs):
        yield RuntimeEvent(type="tool_call", data={"name": "verified_tool"})
        yield RuntimeEvent(type="tool_result", data={"name": "verified_tool", "result": "ok"})
        yield RuntimeEvent(
            type="final",
            data={
                "text": "工具已完成",
                "terminal_reason": "tool_turn_empty_fallback",
                "tool_silence_kind": self.silence_kind,
            },
        )


def test_decision_route_requires_exact_json_and_never_scans_prose(tmp_path: Path) -> None:
    service, run = _runtime(tmp_path, _decision_workflow())
    node = run.nodes["decision"]
    executor = WorkflowExecutor(service, session_resolver=lambda _sid: None, owner_scope="owner")

    assert WorkflowExecutor._decision_route(
        run,
        node,
        '{"selected_route":"safe","reason":"The input is verified."}',
    ) == "safe"
    assert WorkflowExecutor._decision_route(
        run,
        node,
        '{"selected_route":"unsafe","reason":"The fallback is required."}',
    ) == "unsafe"

    invalid = [
        "The unsafe route is not selected; I am still evaluating.",
        "safe",
        '{"route":"safe","reason":"legacy alias"}',
        '{"selected_route":"safe"}',
        '{"selected_route":"safe","reason":"ok","extra":"ambiguous"}',
        '{"selected_route":"SAFE","reason":"case is not exact"}',
        '{"selected_route":"safe","selected_route":"unsafe","reason":"duplicate"}',
        '{"selected_route":"missing","reason":"unknown route"}',
    ]
    assert all(WorkflowExecutor._decision_route(run, node, text) == "" for text in invalid)

    prompt = executor._agent_prompt(run, node, {}, {})
    assert '"allowed_routes":["safe","unsafe"]' in prompt
    assert "exactly one JSON object" in prompt
    assert '"selected_route"' in prompt and '"reason"' in prompt


def test_invalid_decision_output_is_actionably_blocked(tmp_path: Path) -> None:
    service, run = _runtime(tmp_path, _decision_workflow())
    claim = service.claim_node(
        run.run_id,
        "decision",
        "session",
        claim_owner="executor",
        owner_scope="owner",
    )
    managed = SimpleNamespace(
        studio_session=StudioSession(
            provider_name="local",
            model_name="test-model",
            workspace_dir=str(tmp_path / "workspace"),
        ),
        purpose="",
    )
    executor = WorkflowExecutor(
        service,
        session_resolver=lambda _sid: managed,
        llm_resolver=lambda *_args: object(),
        runtime_factory=lambda *_args, **_kwargs: _FinalRuntime(
            "The unsafe route is not selected; I am still evaluating."
        ),
        tools_resolver=lambda *_args: [],
        owner_scope="owner",
    )

    async def execute() -> None:
        with pytest.raises(WorkflowExecutionBlocked) as caught:
            await executor._execute_agent(managed, run, run.nodes["decision"], claim, asyncio.Event())
        assert caught.value.code == "decision_route_invalid"
        assert "exactly one JSON object" in caught.value.reason
        assert caught.value.details["allowed_routes"] == ["safe", "unsafe"]

    asyncio.run(execute())


def test_executor_calls_agent_runtime_and_advances_dependency(tmp_path: Path) -> None:
    service, run = _runtime(tmp_path, _linear_workflow())
    managed = SimpleNamespace(
        studio_session=StudioSession(provider_name="local", model_name="test-model", workspace_dir=str(tmp_path / "workspace")),
        purpose="",
    )
    runtime_instances: list[_FinalRuntime] = []

    def runtime_factory(_llm, _gate, **_kwargs):
        runtime = _FinalRuntime()
        runtime_instances.append(runtime)
        return runtime

    executor = WorkflowExecutor(
        service,
        session_resolver=lambda _sid: managed,
        llm_resolver=lambda *_args: object(),
        runtime_factory=runtime_factory,
        owner_scope="owner",
    )

    async def run_once() -> None:
        task = await executor.start_run(run.run_id, "session")
        assert task is not None
        await task

    asyncio.run(run_once())
    final = service.get_run(run.run_id, "session", owner_scope="owner")
    assert final.status == "closed"
    assert final.nodes["task"].meta["workflow_output_summary"] == "runtime result"
    assert runtime_instances and runtime_instances[0].called


def test_agent_runtime_empty_response_fallback_blocks_downstream(tmp_path: Path) -> None:
    service, run = _runtime(tmp_path, _linear_workflow())
    managed = SimpleNamespace(
        studio_session=StudioSession(
            provider_name="local",
            model_name="test-model",
            workspace_dir=str(tmp_path / "workspace"),
        ),
        purpose="",
    )
    executor = WorkflowExecutor(
        service,
        session_resolver=lambda _sid: managed,
        llm_resolver=lambda *_args: object(),
        runtime_factory=lambda *_args, **_kwargs: _FinalRuntime(
            "本轮模型未能生成完整的可见回复，请重新提问。",
            terminal_reason="empty_response_fallback",
        ),
        owner_scope="owner",
    )

    async def run_once() -> None:
        task = await executor.start_run(run.run_id, "session")
        assert task is not None
        await task

    asyncio.run(run_once())
    blocked = service.get_run(run.run_id, "session", owner_scope="owner")
    assert blocked.nodes["task"].status is NodeStatus.BLOCKED
    assert blocked.nodes["task"].meta["workflow_error_code"] == "agent_empty_response"
    assert blocked.nodes["task"].meta["workflow_evidence"][0]["details"]["terminal_reason"] == "empty_response_fallback"
    assert blocked.nodes["end"].status is not NodeStatus.DONE
    assert workflow_execution_envelope(blocked)["state"] == "blocked"


@pytest.mark.parametrize(
    ("silence_kind", "expected_outcome", "expected_code"),
    [
        ("success", "closed", None),
        ("error", "blocked", "agent_tool_error"),
    ],
)
def test_tool_fallback_requires_structured_success_kind(
    tmp_path: Path,
    silence_kind: str,
    expected_outcome: str,
    expected_code: str | None,
) -> None:
    service, run = _runtime(tmp_path, _linear_workflow())
    managed = SimpleNamespace(
        studio_session=StudioSession(
            provider_name="local",
            model_name="test-model",
            workspace_dir=str(tmp_path / "workspace"),
        ),
        purpose="",
    )
    executor = WorkflowExecutor(
        service,
        session_resolver=lambda _sid: managed,
        llm_resolver=lambda *_args: object(),
        runtime_factory=lambda *_args, **_kwargs: _ToolFallbackRuntime(silence_kind=silence_kind),
        owner_scope="owner",
    )

    async def run_once() -> None:
        task = await executor.start_run(run.run_id, "session")
        assert task is not None
        await task

    asyncio.run(run_once())
    final = service.get_run(run.run_id, "session", owner_scope="owner")
    if expected_outcome == "closed":
        assert final.status == "closed"
    else:
        assert final.nodes["task"].status is NodeStatus.BLOCKED
        assert workflow_execution_envelope(final)["state"] == "blocked"
    if expected_code:
        assert final.nodes["task"].meta["workflow_error_code"] == expected_code
    else:
        assert final.nodes["task"].meta["workflow_output_summary"] == "工具已完成"


def test_executor_timeout_blocks_for_recovery(tmp_path: Path) -> None:
    service, run = _runtime(tmp_path, _linear_workflow())
    managed = SimpleNamespace(
        studio_session=StudioSession(provider_name="local", model_name="test-model", workspace_dir=str(tmp_path / "workspace")),
        purpose="",
    )

    class _SlowRuntime:
        async def run_turn(self, *_args, **_kwargs):
            await asyncio.sleep(0.2)
            if False:
                yield RuntimeEvent(type="final", data={"text": "never"})

    executor = WorkflowExecutor(
        service,
        session_resolver=lambda _sid: managed,
        llm_resolver=lambda *_args: object(),
        runtime_factory=lambda *_args, **_kwargs: _SlowRuntime(),
        owner_scope="owner",
        node_timeout_seconds=0.05,
    )

    async def run_once() -> None:
        task = await executor.start_run(run.run_id, "session")
        assert task is not None
        await task

    asyncio.run(run_once())
    timed_out = service.get_run(run.run_id, "session", owner_scope="owner")
    node = timed_out.nodes["task"]
    assert node.status is NodeStatus.BLOCKED
    assert node.meta["workflow_reconciliation_required"] is True
    assert node.meta["workflow_error_code"] == "uncertain_external_side_effect"


def test_executor_renews_live_lease_during_long_agent_turn(tmp_path: Path) -> None:
    service, run = _runtime(tmp_path, _linear_workflow())
    managed = SimpleNamespace(
        studio_session=StudioSession(provider_name="local", model_name="test-model", workspace_dir=str(tmp_path / "workspace")),
        purpose="",
    )

    class _SlowFinalRuntime:
        async def run_turn(self, *_args, **_kwargs):
            await asyncio.sleep(0.15)
            yield RuntimeEvent(type="final", data={"text": "renewed result"})

    executor = WorkflowExecutor(
        service,
        session_resolver=lambda _sid: managed,
        llm_resolver=lambda *_args: object(),
        runtime_factory=lambda *_args, **_kwargs: _SlowFinalRuntime(),
        owner_scope="owner",
        lease_seconds=0.06,
        node_timeout_seconds=0.5,
    )

    async def run_once() -> None:
        task = await executor.start_run(run.run_id, "session")
        assert task is not None
        await task

    asyncio.run(run_once())
    final = service.get_run(run.run_id, "session", owner_scope="owner")
    assert final.status == "closed"
    assert final.nodes["task"].meta["workflow_output_summary"] == "renewed result"


def test_scheduler_claims_only_after_global_slot_and_cancellation_releases_waiter(tmp_path: Path) -> None:
    service, first_run = _runtime(tmp_path, _linear_workflow())
    second_run = service.create_run(first_run.workflow_id, 1, "session-2").run
    managed = SimpleNamespace(
        studio_session=StudioSession(
            provider_name="local",
            model_name="test-model",
            workspace_dir=str(tmp_path / "workspace"),
        ),
        purpose="",
    )
    first_started = asyncio.Event()
    factory_calls: list[int] = []

    class _SlowFirstRuntime:
        def __init__(self, index: int) -> None:
            self.index = index

        async def run_turn(self, *_args, **_kwargs):
            if self.index == 1:
                first_started.set()
                await asyncio.sleep(0.35)
            yield RuntimeEvent(type="final", data={"text": f"result-{self.index}"})

    def runtime_factory(*_args, **_kwargs):
        factory_calls.append(len(factory_calls) + 1)
        return _SlowFirstRuntime(factory_calls[-1])

    def resolve(session_id: str) -> object:
        assert session_id in {"session", "session-2"}
        return managed

    executor = WorkflowExecutor(
        service,
        session_resolver=resolve,
        llm_resolver=lambda *_args: object(),
        runtime_factory=runtime_factory,
        owner_scope="owner",
        max_concurrency=1,
        lease_seconds=0.15,
        node_timeout_seconds=1,
    )

    async def run_competing_pumps() -> None:
        first_task = await executor.start_run(first_run.run_id, "session")
        assert first_task is not None
        await asyncio.wait_for(first_started.wait(), timeout=1)

        second_task = await executor.start_run(second_run.run_id, "session-2")
        assert second_task is not None
        # This is longer than the waiting node's short lease.  It must remain
        # READY and unclaimed while the first run owns the sole slot.
        await asyncio.sleep(0.25)
        waiting = service.get_run(second_run.run_id, "session-2", owner_scope="owner")
        assert waiting.nodes["task"].status is NodeStatus.READY
        assert service.get_node_claim(second_run.run_id, "task", "session-2", owner_scope="owner") is None
        assert waiting.nodes["task"].retry_count == 0

        executor.request_cancel(second_run.run_id)
        cancelled = service.cancel_run(second_run.run_id, "session-2", owner_scope="owner", cancelled_by="test")
        assert cancelled.status == "cancelled"
        await second_task
        await first_task

    asyncio.run(run_competing_pumps())
    first_final = service.get_run(first_run.run_id, "session", owner_scope="owner")
    second_final = service.get_run(second_run.run_id, "session-2", owner_scope="owner")
    assert first_final.status == "closed"
    assert first_final.nodes["task"].meta["workflow_output_summary"] == "result-1"
    assert second_final.status == "cancelled"
    assert second_final.nodes["task"].retry_count == 0
    assert factory_calls == [1]
    assert executor._candidate_admission_count == 0


def test_executor_blocks_missing_model_and_cleans_run_signal(tmp_path: Path) -> None:
    service, run = _runtime(tmp_path, _linear_workflow())
    managed = SimpleNamespace(
        studio_session=StudioSession(workspace_dir=str(tmp_path / "workspace")),
        purpose="",
    )
    executor = WorkflowExecutor(
        service,
        session_resolver=lambda _sid: managed,
        owner_scope="owner",
    )

    async def run_once() -> None:
        task = await executor.start_run(run.run_id, "session")
        assert task is not None
        await task
        # Let the task done callback remove the per-run signal as well.
        await asyncio.sleep(0)

    asyncio.run(run_once())
    blocked = service.get_run(run.run_id, "session", owner_scope="owner")
    node = blocked.nodes["task"]
    assert node.status is NodeStatus.BLOCKED
    assert node.meta["workflow_error_code"] == "agent_model_unavailable"
    assert "select a provider and model" in node.meta["workflow_blocked_reason"]
    assert run.run_id not in executor._cancel_events
    executor.request_cancel("idle-historical-run")
    assert "idle-historical-run" not in executor._cancel_events


def test_missing_managed_session_persists_recoverable_block_and_resume(tmp_path: Path) -> None:
    service, run = _runtime(tmp_path, _linear_workflow())
    restored = SimpleNamespace(
        studio_session=StudioSession(
            provider_name="local",
            model_name="restored-model",
            workspace_dir=str(tmp_path / "workspace"),
        ),
        purpose="",
    )
    state: dict[str, object | None] = {"managed": None}

    def resolve(session_id: str) -> object | None:
        assert session_id == "session"
        return state["managed"]

    executor = WorkflowExecutor(
        service,
        session_resolver=resolve,
        llm_resolver=lambda *_args: object(),
        runtime_factory=lambda *_args, **_kwargs: _FinalRuntime("restored result"),
        owner_scope="owner",
    )

    async def first_attempt() -> None:
        task = await executor.start_run(run.run_id, "session")
        assert task is not None
        await task

    asyncio.run(first_attempt())
    blocked = service.get_run(run.run_id, "session", owner_scope="owner")
    blocked_node = blocked.nodes["task"]
    assert blocked_node.status is NodeStatus.BLOCKED
    assert blocked_node.meta["workflow_error_code"] == "session_unavailable"
    assert "restore the same session" in blocked_node.meta["workflow_blocked_reason"]
    assert workflow_execution_envelope(blocked)["state"] == "blocked"
    assert "task" in workflow_execution_envelope(blocked)["blocked_node_ids"]
    assert any(
        isinstance(item, dict)
        and item.get("code") == "session_unavailable"
        and item.get("recoverable") is True
        for item in blocked_node.meta["workflow_evidence"]
    )

    # The API's explicit resume advances the same owner/session binding.  The
    # executor then requeues only this exact recoverable error once the resolver
    # returns the restored authenticated session.
    state["managed"] = restored
    resumed = service.advance(
        run.run_id,
        "session",
        blocked.version,
        owner_scope="owner",
    )

    async def resumed_attempt() -> None:
        task = await executor.start_run(resumed.run_id, "session")
        assert task is not None
        await task

    asyncio.run(resumed_attempt())
    final = service.get_run(run.run_id, "session", owner_scope="owner")
    assert final.status == "closed"
    assert final.nodes["task"].meta["workflow_output_summary"] == "restored result"


def test_lease_loss_cancels_inflight_agent_body(tmp_path: Path) -> None:
    service, run = _runtime(tmp_path, _linear_workflow())
    claim = service.claim_node(
        run.run_id,
        "task",
        "session",
        claim_owner="executor",
        lease_seconds=0.5,
        owner_scope="owner",
    )
    managed = SimpleNamespace(
        studio_session=StudioSession(
            provider_name="local",
            model_name="test-model",
            workspace_dir=str(tmp_path / "workspace"),
        ),
        purpose="",
    )
    cancelled = asyncio.Event()

    class _CancellableRuntime:
        async def run_turn(self, *_args, **_kwargs):
            try:
                await asyncio.sleep(1)
            except asyncio.CancelledError:
                cancelled.set()
                raise
            if False:
                yield RuntimeEvent(type="final", data={"text": "never"})

    calls = 0
    original_renew = service.renew_node_claim

    def fail_second_renew(*args, **kwargs):
        nonlocal calls
        calls += 1
        if calls > 1:
            raise WorkflowClaimConflict(run.run_id, "task", "renewal failed")
        return original_renew(*args, **kwargs)

    service.renew_node_claim = fail_second_renew  # type: ignore[method-assign]
    executor = WorkflowExecutor(
        service,
        session_resolver=lambda _sid: managed,
        llm_resolver=lambda *_args: object(),
        runtime_factory=lambda *_args, **_kwargs: _CancellableRuntime(),
        executor_id="executor",
        owner_scope="owner",
        lease_seconds=0.06,
    )

    async def run_body() -> None:
        with pytest.raises(WorkflowClaimConflict, match="authority was lost"):
            await asyncio.wait_for(
                executor._execute_body_with_lease(
                    managed,
                    run,
                    run.nodes["task"],
                    claim,
                    asyncio.Event(),
                ),
                timeout=1,
            )

    asyncio.run(run_body())
    assert calls > 1
    assert cancelled.is_set()


def _artifact_workflow() -> dict:
    return {
        "title": "Artifact executor workflow",
        "objective": "Approve a draft and render it",
        "completion_criteria": ["the report exists"],
        "nodes": [
            {"id": "trigger", "kind": "trigger", "label": "Start"},
            {
                "id": "analysis",
                "kind": "agent_task",
                "label": "Analysis",
                "objective": "Write a report draft",
                "deliverable": "Markdown draft",
                "acceptance_criteria": ["Draft is clear"],
            },
            {
                "id": "gate",
                "kind": "approval_gate",
                "label": "Approve",
                "objective": "Approve report rendering",
                "config": {
                    "summary": "Approve report",
                    "target_action_description": "Write report files",
                    "approver_policy_kind": "session_owner",
                    "ttl_seconds": 3600,
                },
            },
            {
                "id": "artifact",
                "kind": "agent_task",
                "label": "Render report",
                "objective": "Render approved report",
                "deliverable": "Report files",
                "acceptance_criteria": ["Both formats exist"],
                "config": {
                    "input_bindings": {"report_draft": {"source_node": "analysis", "path": "output"}},
                    "artifact_contract": {
                        "schema_version": 1,
                        "kind": "workflow_artifact_bundle",
                        "directory": "workflow-artifacts",
                        "output_basename": "usage-report",
                        "formats": ["md", "html"],
                        "max_bytes_each": 200000,
                    },
                },
            },
            {"id": "end", "kind": "end", "label": "End"},
        ],
        "edges": [
            {"id": "e1", "source": "trigger", "target": "analysis"},
            {"id": "e2", "source": "analysis", "target": "gate"},
            {"id": "e3", "source": "gate", "target": "artifact"},
            {"id": "e4", "source": "artifact", "target": "end"},
        ],
    }


def test_approved_artifact_consumes_frozen_draft_without_llm(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    service, run = _runtime(tmp_path, _artifact_workflow())
    draft = "# Fictional usage report\n\n来源：fictional_demo\n"
    run = service.report_node_result(run.run_id, "analysis", "session", run.version, "done", draft, owner_scope="owner")
    approval = service.list_approvals(run.run_id, "session", owner_scope="owner")[0]
    decided = service.decide_approval(approval.approval_id, "session", "approved", approval.version, owner_scope="owner")
    resumed = service.resume_approval(
        approval.approval_id,
        "session",
        expected_version=decided.request.version,
        expected_run_version=decided.run.version,
        owner_scope="owner",
    )
    assert resumed.run.nodes["artifact"].status is NodeStatus.READY

    async def fake_renderer(_format: str, _title: str, _markdown: str) -> tuple[str, str, str]:
        return "renderer.html", "text/html", "<h1>Fictional usage report</h1>"

    monkeypatch.setattr("agenticx.cli.agent_tools.render_document_via_local_renderer", fake_renderer)
    session = StudioSession(workspace_dir=str(tmp_path / "workspace"))
    managed = SimpleNamespace(studio_session=session, purpose="")

    def should_never_call_llm(*_args, **_kwargs):
        raise AssertionError("artifact delivery must not call an AgentRuntime")

    executor = WorkflowExecutor(
        service,
        session_resolver=lambda _sid: managed,
        runtime_factory=should_never_call_llm,
        owner_scope="owner",
    )

    async def run_once() -> None:
        task = await executor.start_run(resumed.run.run_id, "session")
        assert task is not None
        await task

    asyncio.run(run_once())
    final = service.get_run(run.run_id, "session", owner_scope="owner")
    assert final.status == "closed"
    md_path = Path(session.workspace_dir) / "workflow-artifacts" / "usage-report.md"
    html_path = Path(session.workspace_dir) / "workflow-artifacts" / "usage-report.html"
    assert md_path.read_text(encoding="utf-8") == draft
    assert html_path.read_text(encoding="utf-8") == "<h1>Fictional usage report</h1>"
    artifacts = final.nodes["artifact"].meta["workflow_artifacts"]
    assert {item["format"] for item in artifacts} == {"md", "html"}


def test_artifact_without_approval_is_blocked(tmp_path: Path) -> None:
    service, run = _runtime(tmp_path, _artifact_workflow())
    run = service.report_node_result(
        run.run_id,
        "analysis",
        "session",
        run.version,
        "done",
        "# draft",
        owner_scope="owner",
    )
    managed = SimpleNamespace(studio_session=StudioSession(workspace_dir=str(tmp_path / "workspace")), purpose="")
    executor = WorkflowExecutor(
        service,
        session_resolver=lambda _sid: managed,
        executor_id="executor",
        owner_scope="owner",
    )
    with pytest.raises(WorkflowExecutionBlocked, match="approval"):
        executor._approved_artifact_draft(run, run.nodes["artifact"])


def test_artifact_path_rejects_symlink_before_creating_outside_directory(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    outside = tmp_path / "outside"
    workspace.mkdir()
    outside.mkdir()
    (workspace / "alias").symlink_to(outside, target_is_directory=True)

    with pytest.raises(WorkflowExecutionBlocked, match="escapes"):
        WorkflowExecutor._artifact_path(workspace, "alias/new-child", "report", "md")

    assert not (outside / "new-child").exists()


def test_workflow_run_gate_cleanup_uses_real_managed_session_and_preserves_other_runs(tmp_path: Path) -> None:
    service, run = _runtime(tmp_path, _linear_workflow())
    managed = ManagedSession(
        session_id="session",
        studio_session=StudioSession(workspace_dir=str(tmp_path / "workspace")),
    )
    run_agent_id = f"workflow:{run.run_id}:task"
    pending_agent_id = f"workflow:{run.run_id}:pending"
    other_agent_id = "workflow:other-run:task"
    managed.get_confirm_gate(run_agent_id)
    managed.get_clarify_gate(run_agent_id)
    pending_gate = managed.get_confirm_gate(pending_agent_id)
    managed.get_confirm_gate(other_agent_id)
    managed.get_clarify_gate(other_agent_id)
    ordinary_confirm = managed.get_confirm_gate("meta")
    ordinary_clarify = managed.get_clarify_gate("meta")

    executor = WorkflowExecutor(
        service,
        session_resolver=lambda _sid: managed,
        owner_scope="owner",
    )

    service.cancel_run(run.run_id, "session", owner_scope="owner", cancelled_by="test")

    async def run_once() -> None:
        pending_task = asyncio.create_task(pending_gate.request_confirm("pending", {"request_id": "pending"}))
        await asyncio.sleep(0)
        await executor._pump_run(run.run_id, "session")
        assert pending_agent_id in managed.sub_confirm_gates
        assert pending_gate.resolve("pending", False)
        await pending_task
        await executor._cleanup_run_gates("session", run.run_id)

    asyncio.run(run_once())
    assert service.get_run(run.run_id, "session", owner_scope="owner").status == "cancelled"
    assert run_agent_id not in managed.sub_confirm_gates
    assert run_agent_id not in managed.sub_clarify_gates
    assert pending_agent_id not in managed.sub_confirm_gates
    assert other_agent_id in managed.sub_confirm_gates
    assert other_agent_id in managed.sub_clarify_gates
    assert managed.confirm_gate is ordinary_confirm
    assert managed.clarify_gate is ordinary_clarify


def test_request_cancel_wakes_live_confirmation_and_clarification_without_cross_run_resolution(tmp_path: Path) -> None:
    """Owner cancellation must stop gate waiters immediately and fence late UI replies."""

    service, run = _runtime(tmp_path, _linear_workflow())
    managed = ManagedSession(
        session_id="session",
        studio_session=StudioSession(
            provider_name="local",
            model_name="test-model",
            workspace_dir=str(tmp_path / "workspace"),
        ),
    )
    started = asyncio.Event()
    writes: list[str] = []

    class _WaitingRuntime:
        def __init__(self, gate, clarify_gate) -> None:
            self.gate = gate
            self.clarify_gate = clarify_gate
            self.confirm_task: asyncio.Task[object] | None = None
            self.clarify_task: asyncio.Task[object] | None = None

        async def run_turn(self, *_args, **_kwargs):
            started.set()
            self.confirm_task = asyncio.create_task(
                self.gate.request_confirm(
                    "confirm write",
                    {"request_id": "live-confirm", "risk": "high"},
                )
            )
            self.clarify_task = asyncio.create_task(
                self.clarify_gate.request_clarification(
                    "clarify write",
                    context={"request_id": "live-clarify"},
                )
            )
            try:
                approved, _answer = await asyncio.gather(self.confirm_task, self.clarify_task)
                if approved:
                    writes.append("external-write")
                yield RuntimeEvent(type="final", data={"text": "written"})
            finally:
                await asyncio.gather(self.confirm_task, self.clarify_task, return_exceptions=True)

    runtime_instances: list[_WaitingRuntime] = []

    def runtime_factory(_llm, gate, **_kwargs):
        clarify_gate = managed.get_clarify_gate(f"workflow:{run.run_id}:task")
        runtime = _WaitingRuntime(gate, clarify_gate)
        runtime_instances.append(runtime)
        return runtime

    executor = WorkflowExecutor(
        service,
        session_resolver=lambda _sid: managed,
        llm_resolver=lambda *_args: object(),
        runtime_factory=runtime_factory,
        tools_resolver=lambda *_args: [],
        owner_scope="owner",
        max_concurrency=1,
        node_timeout_seconds=5,
    )

    async def run_once() -> None:
        task = await executor.start_run(run.run_id, "session")
        assert task is not None
        await asyncio.wait_for(started.wait(), timeout=1)
        runtime_instance = runtime_instances[0]
        for _ in range(20):
            if runtime_instance.gate._pending and runtime_instance.clarify_gate._pending:
                break
            await asyncio.sleep(0)
        assert runtime_instance.gate._pending
        assert runtime_instance.clarify_gate._pending

        other_gate = managed.get_confirm_gate("workflow:other-run:task")
        other_waiter = asyncio.create_task(
            other_gate.request_confirm(
                "other run",
                {"request_id": "other-confirm", "risk": "high"},
            )
        )
        await asyncio.sleep(0)
        assert other_gate._pending

        current = service.get_run(run.run_id, "session", owner_scope="owner")
        cancelled = service.cancel_run(
            run.run_id,
            "session",
            expected_version=current.version,
            owner_scope="owner",
            cancelled_by="owner",
        )
        assert cancelled.status == "cancelled"
        executor.request_cancel(run.run_id)
        await asyncio.wait_for(task, timeout=1)

        assert not runtime_instance.gate._pending
        assert not runtime_instance.clarify_gate._pending
        assert runtime_instance.gate.resolve("live-confirm", True) is False
        assert runtime_instance.clarify_gate.resolve("live-clarify", {"answer_text": "late"}) is False
        assert writes == []
        assert other_gate._pending
        assert other_gate.resolve("other-confirm", False) is True
        await other_waiter

    asyncio.run(run_once())
    assert service.get_run(run.run_id, "session", owner_scope="owner").status == "cancelled"


def test_external_write_confirmation_exposes_redacted_bounded_input_preview(tmp_path: Path) -> None:
    service, run = _runtime(tmp_path, _linear_workflow())
    claim = service.claim_node(
        run.run_id,
        "task",
        "session",
        claim_owner="executor",
        owner_scope="owner",
    )
    managed = ManagedSession(
        session_id="session",
        studio_session=StudioSession(workspace_dir=str(tmp_path / "workspace")),
    )

    class _CaptureGate:
        def __init__(self) -> None:
            self.context: dict[str, object] | None = None

        async def request_confirm(self, _question: str, context: dict[str, object]) -> bool:
            self.context = context
            return False

    gate = _CaptureGate()
    action = resolve_connector_action("feishu", "send_message")
    assert action is not None
    context = AdapterContext(
        run_id=run.run_id,
        node_id="task",
        attempt_id=claim.attempt_id,
        fencing_token=claim.fencing_token,
        session_id="session",
        workflow_id=run.workflow_id,
        workflow_revision=run.workflow_revision,
        workflow_digest=run.workflow_digest,
        owner_scope="owner",
        session=managed.studio_session,
        inputs={
            "conversation_ref": "chat-1",
            "message": "Deploy the approved report",
            "access_token": "must-not-be-shown",
            "nested": {"api_key": "also-hidden", "visible": "yes"},
        },
        upstream={},
        node_config={"connector_id": "feishu", "action_id": "send_message"},
        cancellation=asyncio.Event(),
        confirmation=gate,
    )
    executor = WorkflowExecutor(
        service,
        session_resolver=lambda _sid: managed,
        executor_id="executor",
        owner_scope="owner",
    )

    async def request_confirmation() -> object:
        return await executor._confirm_external_write(managed, run.nodes["task"], claim, context, action)

    result = asyncio.run(request_confirmation())
    assert isinstance(result, AdapterResult)
    assert result.outcome == "blocked"
    assert gate.context is not None
    preview = gate.context["input_preview"]
    assert isinstance(preview, dict)
    assert preview["conversation_ref"] == "chat-1"
    assert preview["nested"] == {"visible": "yes"}
    assert "access_token" not in preview
    assert "api_key" not in json.dumps(preview)
    assert gate.context["intent_digest"] == getattr(context, "intent_digest")


def test_usage_counters_are_the_only_token_fields_kept(tmp_path: Path) -> None:
    raw = _linear_workflow()
    raw["nodes"][0]["config"] = {
        "inputs": {
            "rows": [{"input_tokens": 1, "output_tokens": 2, "total_tokens": 3, "access_token": "hidden"}]
        }
    }
    workflows = WorkflowStore(tmp_path / "workflows")
    with pytest.raises(WorkflowValidationError, match="credential-like"):
        workflows.create("owner", raw)
    raw["nodes"][0]["config"]["inputs"]["rows"][0].pop("access_token")
    snapshot = workflows.create("owner", raw)
    counters = snapshot.nodes[0].config["inputs"]["rows"][0]
    assert counters == {"input_tokens": 1, "output_tokens": 2, "total_tokens": 3}
    with pytest.raises(ValueError, match="usage counter"):
        bounded_json_value({"input_tokens": True})
