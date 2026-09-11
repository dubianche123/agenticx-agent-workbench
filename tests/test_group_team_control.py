"""Deterministic async tests for the Team action control plane."""

from __future__ import annotations

import asyncio

import pytest

from agenticx.collaboration.task_lock import Action, ActionData, TaskLock
from agenticx.collaboration.workforce.events import (
    WorkforceAction,
    WorkforceEvent,
    WorkforceEventBus,
)
from agenticx.runtime.graph.models import GraphNode, GraphRun, NodeKind, NodeStatus
from agenticx.runtime.graph.store import GraphRunStore
from agenticx.runtime.group_team_control import (
    CheckpointStatus,
    GroupTeamController,
    TeamControlRejected,
    UnknownTeamActionError,
)


async def _turns(n: int = 3) -> None:
    """Yield a fixed number of times so listener scheduling stays deterministic."""

    for _ in range(n):
        await asyncio.sleep(0)


def _run(*nodes: GraphNode) -> GraphRun:
    return GraphRun(
        run_id="run-control-test",
        session_id="session-control-test",
        group_id="group-control-test",
        nodes={node.id: node for node in nodes},
        edges=[],
        status="open",
        version=0,
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("terminal_status", ["closed", "cancelled"])
async def test_pause_and_resume_reject_terminal_graph_runs(terminal_status: str) -> None:
    run = _run(GraphNode("task-1", NodeKind.TASK, "task-1", NodeStatus.READY))
    run.status = terminal_status
    controller = GroupTeamController(TaskLock("group::control::session"), graph_run=run)

    for action in (Action.PAUSE, Action.RESUME):
        with pytest.raises(
            TeamControlRejected,
            match=rf"cannot {action.value} while GraphRun is {terminal_status}",
        ):
            await controller.handle_action(ActionData(action=action, data={}))

    assert controller.paused is False
    assert run.status == terminal_status
    await controller.close()


@pytest.mark.asyncio
async def test_pause_resume_skip_stop_checkpoint_and_graph_events() -> None:
    lock = TaskLock("group::control::session")
    bus = WorkforceEventBus()
    run = _run(
        GraphNode(
            id="task-1",
            kind=NodeKind.TASK,
            label="task-1",
            status=NodeStatus.READY,
        )
    )
    controller = GroupTeamController(lock, bus, graph_run=run)

    await controller.start()
    await controller.handle_action(
        ActionData(action=Action.PAUSE, data={"source": "test"})
    )
    await _turns()
    assert controller.paused is True
    assert run.status == "paused"

    waiting = asyncio.create_task(controller.checkpoint("task-1"))
    await _turns()
    assert waiting.done() is False

    await controller.handle_action(ActionData(action=Action.RESUME, data={}))
    assert await waiting == CheckpointStatus.CONTINUE
    assert controller.paused is False
    assert run.status == "open"

    await controller.handle_action(
        ActionData(action=Action.SKIP_TASK, data={"task_id": "task-1"})
    )
    await _turns()
    assert await controller.checkpoint("task-1") == CheckpointStatus.SKIPPED
    assert "task-1" in controller.skipped
    assert run.nodes["task-1"].status is NodeStatus.SKIPPED

    await controller.handle_action(
        ActionData(action=Action.STOP, data={"source": "test"})
    )
    await _turns()
    assert await controller.checkpoint("other-task") == CheckpointStatus.STOPPED
    assert controller.stopped is True
    assert run.status == "closed"

    actions = [event.action for event in bus.get_event_history()]
    assert actions == [
        WorkforceAction.WORKFORCE_PAUSED,
        WorkforceAction.WORKFORCE_RESUMED,
        WorkforceAction.TASK_SKIPPED,
        WorkforceAction.WORKFORCE_STOPPED,
    ]
    assert bus.get_event_history()[2].task_id == "task-1"

    listener = controller.listener_task
    await controller.close()
    assert listener is not None and listener.done()


@pytest.mark.asyncio
async def test_add_task_is_cached_before_graph_bind_then_injected_in_order() -> None:
    lock = TaskLock("group::control::session")
    bus = WorkforceEventBus()
    run = _run()
    calls: list[dict[str, object]] = []

    async def inject(data: dict[str, object]) -> str:
        calls.append(data)
        task_id = f"added-{len(calls)}"
        run.nodes[task_id] = GraphNode(
            id=task_id,
            kind=NodeKind.TASK,
            label=str(data["task_description"]),
            status=NodeStatus.READY,
        )
        return task_id

    controller = GroupTeamController(lock, bus)
    await controller.start()
    await controller.handle_action(
        ActionData(
            action=Action.ADD_TASK,
            data={"task_description": "first", "priority": 1},
        )
    )
    await controller.handle_action(
        ActionData(
            action=Action.ADD_TASK,
            data={"task_description": "second", "priority": 2},
        )
    )
    await _turns()

    assert len(controller.pending_add_tasks) == 2
    assert calls == []

    await controller.bind_graph(run, inject_task=inject)
    assert controller.pending_add_tasks == []
    assert [data["task_description"] for data in calls] == ["first", "second"]
    assert set(run.nodes) == {"added-1", "added-2"}

    assigned = [
        event
        for event in bus.get_event_history()
        if event.action is WorkforceAction.TASK_ASSIGNED
    ]
    assert [event.task_id for event in assigned] == ["added-1", "added-2"]
    assert [event.data["task_description"] for event in assigned] == ["first", "second"]
    await controller.close()


@pytest.mark.asyncio
async def test_prebind_control_audit_is_scoped_to_the_bound_graph_run() -> None:
    controller = GroupTeamController(TaskLock("group::control::session"))
    first = controller.record_control_audit(
        {"action": "pause", "status": "accepted"}
    )
    assert first["run_id"] == ""

    run = _run()
    await controller.bind_graph(run)
    second = controller.record_control_audit(
        {"action": "resume", "status": "accepted"}
    )

    assert [entry["run_id"] for entry in controller.control_audit] == [
        run.run_id,
        run.run_id,
    ]
    assert run.meta["team_control_audit"] == controller.control_audit
    assert second["run_id"] == run.run_id
    await controller.close()


@pytest.mark.asyncio
async def test_skip_before_bind_is_applied_to_a_later_injected_node() -> None:
    lock = TaskLock("group::control::session")
    run = _run()
    calls: list[str] = []

    def inject(data: dict[str, object]) -> GraphNode:
        calls.append(str(data["task_id"]))
        return GraphNode(
            id=str(data["task_id"]),
            kind=NodeKind.TASK,
            label="future",
            status=NodeStatus.READY,
        )

    controller = GroupTeamController(lock, graph_run=run)
    await controller.start()
    await controller.handle_action(
        ActionData(action=Action.SKIP_TASK, data={"task_id": "future"})
    )
    await controller.handle_action(
        ActionData(
            action=Action.ADD_TASK,
            data={"task_id": "future", "task_description": "future work"},
        )
    )
    await _turns()
    await controller.bind_graph(run, inject_task=inject)

    assert calls == ["future"]
    assert run.nodes["future"].status is NodeStatus.SKIPPED
    assert await controller.checkpoint("future") == CheckpointStatus.SKIPPED
    await controller.close()


@pytest.mark.asyncio
async def test_close_wakes_checkpoint_and_cancels_owned_listener_without_leak() -> None:
    lock = TaskLock("group::control::session")
    controller = GroupTeamController(lock)
    await controller.start()
    await controller.handle_action(ActionData(action=Action.PAUSE, data={}))
    await _turns()
    waiter = asyncio.create_task(controller.checkpoint("task-1"))
    await _turns()
    listener = controller.listener_task
    assert listener is not None and not listener.done()

    await controller.close()
    assert await waiter == CheckpointStatus.CLOSED
    assert listener.done() is True
    assert listener not in asyncio.all_tasks()
    assert controller.closed is True
    await controller.close()


@pytest.mark.asyncio
async def test_unknown_action_is_audited_and_does_not_kill_listener() -> None:
    lock = TaskLock("group::control::session")
    bus = WorkforceEventBus()
    run = _run(GraphNode("task-1", NodeKind.TASK, "task-1", NodeStatus.READY))
    controller = GroupTeamController(lock, bus, graph_run=run)
    await controller.start()
    await lock.put_queue(ActionData(action=Action.START, data={}))
    await _turns()

    assert controller.listener_task is not None
    assert controller.listener_task.done() is False
    assert controller.listener_error is None
    assert controller.control_audit[-1]["action"] == "start"
    assert controller.control_audit[-1]["status"] == "rejected"
    assert controller.control_audit[-1]["run_id"] == run.run_id
    assert any(
        event.action is WorkforceAction.TASK_FAILED
        and event.data["control"] == "rejected"
        and event.data["action"] == "start"
        for event in bus.get_event_history()
    )

    # A valid action after the unknown one proves the listener remains live.
    await lock.put_queue(ActionData(action=Action.PAUSE, data={}))
    await _turns()
    assert controller.paused is True
    await controller.close()


@pytest.mark.asyncio
async def test_skip_rejects_running_or_terminal_nodes_but_accepts_admission_states() -> None:
    lock = TaskLock("group::control::session")
    run = _run(
        GraphNode("pending", NodeKind.TASK, "pending", NodeStatus.PENDING),
        GraphNode("ready", NodeKind.TASK, "ready", NodeStatus.READY),
        GraphNode("paused", NodeKind.TASK, "paused", NodeStatus.PAUSED),
        GraphNode("running", NodeKind.TASK, "running", NodeStatus.RUNNING),
        GraphNode("done", NodeKind.TASK, "done", NodeStatus.DONE),
    )
    controller = GroupTeamController(lock, graph_run=run)
    await controller.start()

    for task_id in ("pending", "ready", "paused"):
        await controller.handle_action(
            ActionData(action=Action.SKIP_TASK, data={"task_id": task_id})
        )
    assert {run.nodes[task_id].status for task_id in ("pending", "ready", "paused")} == {
        NodeStatus.SKIPPED
    }
    assert controller.skipped == {"pending", "ready", "paused"}

    for task_id in ("running", "done"):
        with pytest.raises(ValueError, match="cannot skip"):
            await controller.handle_action(
                ActionData(action=Action.SKIP_TASK, data={"task_id": task_id})
            )
    assert "running" not in controller.skipped
    assert "done" not in controller.skipped
    await controller.close()


@pytest.mark.asyncio
async def test_listener_records_known_rejection_and_keeps_consuming() -> None:
    lock = TaskLock("group::control::session")
    bus = WorkforceEventBus()
    run = _run(GraphNode("running", NodeKind.TASK, "running", NodeStatus.RUNNING))
    controller = GroupTeamController(lock, bus, graph_run=run)
    await controller.start()

    await lock.put_queue(
        ActionData(action=Action.SKIP_TASK, data={"task_id": "running"})
    )
    await _turns()
    assert controller.listener_task is not None
    assert controller.listener_task.done() is False

    # The rejected action must not poison the queue consumer.
    await lock.put_queue(ActionData(action=Action.PAUSE, data={}))
    await _turns()
    assert controller.paused is True
    assert any(
        event.action is WorkforceAction.TASK_FAILED
        and event.data["control"] == "rejected"
        for event in bus.get_event_history()
    )

    await controller.handle_action(ActionData(action=Action.STOP, data={}))
    await _turns()
    await controller.close()


@pytest.mark.asyncio
async def test_listener_audits_success_and_terminal_rejection_durably(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
) -> None:
    monkeypatch.setattr(
        "agenticx.runtime.graph.store.get_default_store",
        lambda: GraphRunStore(root=tmp_path),
    )
    lock = TaskLock("group::control::session")
    run = _run(GraphNode("task-1", NodeKind.TASK, "task-1", NodeStatus.READY))
    controller = GroupTeamController(lock, graph_run=run)
    await controller.start()

    await lock.put_queue(ActionData(action=Action.PAUSE, data={"source": "queue"}))
    await _turns()
    assert controller.paused is True
    assert controller.listener_task is not None
    assert controller.listener_task.done() is False

    run.status = "closed"
    await lock.put_queue(ActionData(action=Action.RESUME, data={"source": "queue"}))
    await _turns()

    audit = controller.control_audit
    assert [entry["action"] for entry in audit] == ["pause", "resume"]
    assert [entry["status"] for entry in audit] == ["accepted", "rejected"]
    assert {entry["run_id"] for entry in audit} == {run.run_id}
    assert {entry["control_scope_id"] for entry in audit} == {
        controller._group_team_control_scope_id
    }
    assert all(entry["source"] == "task_lock_listener" for entry in audit)
    assert run.meta["team_control_audit"] == audit

    persisted = GraphRunStore(root=tmp_path).load(run.run_id)
    assert persisted is not None
    assert persisted.status == "closed"
    assert persisted.meta["team_control_audit"] == audit
    history = controller.event_bus.get_event_history()
    assert any(
        event.action is WorkforceAction.TASK_FAILED
        and event.data["control"] == "rejected"
        for event in history
    )
    await controller.close()


@pytest.mark.asyncio
async def test_add_callback_rechecks_stop_and_rolls_back_stale_node(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
) -> None:
    monkeypatch.setattr(
        "agenticx.runtime.graph.store.get_default_store",
        lambda: GraphRunStore(root=tmp_path),
    )
    run = _run(GraphNode("task-1", NodeKind.TASK, "task-1", NodeStatus.READY))
    controller = GroupTeamController(TaskLock("group::control::session"), graph_run=run)
    callback_started = asyncio.Event()
    release_callback = asyncio.Event()

    async def inject(_data: dict[str, object]) -> GraphNode:
        callback_started.set()
        await release_callback.wait()
        node = GraphNode("late", NodeKind.TASK, "late", NodeStatus.READY)
        run.nodes[node.id] = node
        return node

    controller._add_task_callback = inject
    add_task = asyncio.create_task(
        controller.handle_action(
            ActionData(action=Action.ADD_TASK, data={"task_description": "late"})
        )
    )
    await asyncio.wait_for(callback_started.wait(), timeout=1)

    # STOP must not wait for the async ADD_TASK callback to finish.
    await asyncio.wait_for(
        controller.handle_action(ActionData(action=Action.STOP, data={})),
        timeout=1,
    )
    assert controller.stopped is True
    assert run.status == "closed"

    release_callback.set()
    with pytest.raises(TeamControlRejected, match="stopped"):
        await add_task
    assert "late" not in run.nodes
    assert not any(
        event.action is WorkforceAction.TASK_ASSIGNED
        for event in controller.event_bus.get_event_history()
    )
    await controller.close()


@pytest.mark.asyncio
async def test_queue_pause_resume_persist_before_workforce_event(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
) -> None:
    store = GraphRunStore(root=tmp_path)
    monkeypatch.setattr(
        "agenticx.runtime.graph.store.get_default_store",
        lambda: store,
    )
    lock = TaskLock("group::control::session")
    bus = WorkforceEventBus()
    run = _run(GraphNode("task-1", NodeKind.TASK, "task-1", NodeStatus.READY))
    controller = GroupTeamController(lock, bus, graph_run=run)
    observed: list[tuple[WorkforceAction, str]] = []

    def observe(event: WorkforceEvent) -> None:
        if event.action not in {
            WorkforceAction.WORKFORCE_PAUSED,
            WorkforceAction.WORKFORCE_RESUMED,
        }:
            return
        persisted = store.load(run.run_id)
        observed.append((event.action, persisted.status if persisted else "missing"))

    bus.subscribe(observe)
    await controller.start()
    await lock.put_queue(ActionData(action=Action.PAUSE, data={}))
    await _turns()
    await lock.put_queue(ActionData(action=Action.RESUME, data={}))
    await _turns()

    assert observed == [
        (WorkforceAction.WORKFORCE_PAUSED, "paused"),
        (WorkforceAction.WORKFORCE_RESUMED, "open"),
    ]
    persisted = store.load(run.run_id)
    assert persisted is not None
    assert [entry["action"] for entry in persisted.meta["team_control_audit"]] == [
        "pause",
        "resume",
    ]
    await controller.close()


@pytest.mark.asyncio
async def test_stop_cancels_all_unfinished_nodes_and_publishes_once() -> None:
    lock = TaskLock("group::control::session")
    run = _run(
        GraphNode("pending", NodeKind.TASK, "pending", NodeStatus.PENDING),
        GraphNode("ready", NodeKind.TASK, "ready", NodeStatus.READY),
        GraphNode("running", NodeKind.TASK, "running", NodeStatus.RUNNING),
        GraphNode("done", NodeKind.TASK, "done", NodeStatus.DONE),
    )
    controller = GroupTeamController(lock, graph_run=run)
    await controller.handle_action(ActionData(action=Action.STOP, data={"reason": "user"}))
    await controller.handle_action(ActionData(action=Action.STOP, data={"reason": "retry"}))

    assert run.status == "closed"
    assert run.nodes["pending"].status is NodeStatus.CANCELLED
    assert run.nodes["ready"].status is NodeStatus.CANCELLED
    assert run.nodes["running"].status is NodeStatus.CANCELLED
    assert run.nodes["done"].status is NodeStatus.DONE
    assert [event.action for event in controller.event_bus.get_event_history()].count(
        WorkforceAction.WORKFORCE_STOPPED
    ) == 1
    await controller.close()


@pytest.mark.asyncio
async def test_add_task_rejects_finalizing_graph_and_enforces_total_limit() -> None:
    lock = TaskLock("group::control::session")
    run = _run(GraphNode("existing", NodeKind.TASK, "existing", NodeStatus.READY))
    controller = GroupTeamController(lock, max_tasks=2, graph_run=run)
    await controller.start()

    async def inject(_data: dict[str, object]) -> str:
        return "added"

    await controller.bind_graph(run, inject_task=inject)
    await controller.handle_action(
        ActionData(action=Action.ADD_TASK, data={"task_description": "one"})
    )
    await _turns()
    assert controller.task_count == 2
    with pytest.raises(ValueError, match="task limit"):
        await controller.handle_action(
            ActionData(action=Action.ADD_TASK, data={"task_description": "two"})
        )

    run.status = "finalizing"
    with pytest.raises(TeamControlRejected, match="GraphRun is finalizing"):
        await controller.handle_action(
            ActionData(action=Action.ADD_TASK, data={"task_description": "late"})
        )
    run.status = "closed"
    with pytest.raises(TeamControlRejected, match="GraphRun is closed"):
        await controller.handle_action(
            ActionData(action=Action.ADD_TASK, data={"task_description": "late"})
        )
    await controller.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "run_status", ["finalizing", "closed", "cancelled", "done", "failed", "stopped"]
)
async def test_all_non_stop_controls_reject_terminal_graph_status(run_status: str) -> None:
    lock = TaskLock("group::control::terminal-controls")
    run = _run(GraphNode("pending", NodeKind.TASK, "pending", NodeStatus.READY))
    run.status = run_status
    controller = GroupTeamController(lock, graph_run=run)

    actions = (
        ActionData(action=Action.PAUSE, data={}),
        ActionData(action=Action.RESUME, data={}),
        ActionData(action=Action.SKIP_TASK, data={"task_id": "pending"}),
        ActionData(action=Action.ADD_TASK, data={"task_description": "late"}),
    )
    for action_data in actions:
        with pytest.raises(TeamControlRejected, match=run_status):
            await controller.handle_action(action_data)

    # STOP remains the one terminal control: it is idempotent and still
    # normalizes any residual non-terminal nodes to CANCELLED.
    await controller.handle_action(ActionData(action=Action.STOP, data={}))
    assert controller.stopped is True
    assert run.status == "closed"
    assert run.nodes["pending"].status is NodeStatus.CANCELLED
    await controller.close()


@pytest.mark.asyncio
async def test_state_lock_caps_concurrent_adds_and_deduplicates_stop_event() -> None:
    lock = TaskLock("group::control::session")
    run = _run()
    calls: list[dict[str, object]] = []

    async def inject(data: dict[str, object]) -> str:
        calls.append(data)
        await asyncio.sleep(0)
        return f"added-{len(calls)}"

    controller = GroupTeamController(lock, max_tasks=2, graph_run=run)
    await controller.bind_graph(run, inject_task=inject)
    results = await asyncio.gather(
        *(
            controller.handle_action(
                ActionData(
                    action=Action.ADD_TASK,
                    data={"task_description": f"task-{index}"},
                )
            )
            for index in range(3)
        ),
        return_exceptions=True,
    )

    assert sum(not isinstance(result, TeamControlRejected) for result in results) == 2
    assert sum(isinstance(result, TeamControlRejected) for result in results) == 1
    assert controller.task_count == 2
    assert len(calls) == 2

    await asyncio.gather(
        controller.handle_action(ActionData(action=Action.STOP, data={})),
        controller.handle_action(ActionData(action=Action.STOP, data={})),
    )
    assert [
        event.action
        for event in controller.event_bus.get_event_history()
        if event.action is WorkforceAction.WORKFORCE_STOPPED
    ] == [WorkforceAction.WORKFORCE_STOPPED]
    await controller.close()


@pytest.mark.asyncio
async def test_pause_is_an_admission_gate_and_does_not_interrupt_running_task() -> None:
    lock = TaskLock("group::control::session")
    run = _run(GraphNode("running", NodeKind.TASK, "running", NodeStatus.RUNNING))
    controller = GroupTeamController(lock, graph_run=run)
    await controller.handle_action(ActionData(action=Action.PAUSE, data={}))

    assert run.status == "paused"
    assert run.nodes["running"].status is NodeStatus.RUNNING
    assert await controller.checkpoint("running") == CheckpointStatus.CONTINUE
    await controller.close()


@pytest.mark.asyncio
async def test_workforce_bus_callbacks_broadcast_to_each_subscriber() -> None:
    bus = WorkforceEventBus()
    first: list[WorkforceAction] = []
    second: list[WorkforceAction] = []

    def receive_first(event) -> None:
        first.append(event.action)

    def receive_second(event) -> None:
        second.append(event.action)

    bus.subscribe(receive_first)
    bus.subscribe(receive_second)
    bus.publish(WorkforceEvent(action=WorkforceAction.WORKFORCE_STOPPED, data={}))

    assert first == [WorkforceAction.WORKFORCE_STOPPED]
    assert second == [WorkforceAction.WORKFORCE_STOPPED]
