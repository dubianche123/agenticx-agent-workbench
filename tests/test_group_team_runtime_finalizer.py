#!/usr/bin/env python3
"""Regression tests for terminalizing a bound Team GraphRun on runtime exit."""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

from agenticx.collaboration.task_lock import (
    get_or_create_task_lock,
    remove_task_lock,
)
from agenticx.collaboration.workforce.events import (
    WorkforceAction,
    WorkforceEvent,
    WorkforceEventBus,
)
from agenticx.runtime.graph.models import GraphNode, GraphRun, NodeKind, NodeStatus
from agenticx.runtime.graph.store import GraphRunStore
from agenticx.runtime.group_team_control import GroupTeamController
from agenticx.studio.server import create_studio_app


@pytest.mark.parametrize("exit_mode", ["interrupt", "exception"])
def test_group_runtime_finalizer_closes_bound_graph_after_exit(
    monkeypatch: Any,
    tmp_path,
    exit_mode: str,
) -> None:
    """A Team run must not remain open when the router exits before scheduling."""
    from agenticx.studio import server as server_module

    monkeypatch.setattr(server_module, "live_reattach_enabled", lambda: False)
    store = GraphRunStore(root=tmp_path)
    monkeypatch.setattr(
        "agenticx.runtime.graph.store.get_default_store",
        lambda: store,
    )

    captured: list[tuple[GraphRun, GroupTeamController]] = []
    stop_events: list[WorkforceEvent] = []

    class _FakeGroupRouter:
        def __init__(self, **_kwargs: Any) -> None:
            pass

        async def run_group_turn(self, **kwargs: Any):
            base_session = kwargs["base_session"]
            session_id = str(getattr(base_session, "_session_id", "") or "")
            group_id = str(kwargs["group_id"])
            run = GraphRun(
                run_id=f"run-finalizer-{exit_mode}",
                session_id=session_id,
                group_id=group_id,
                nodes={
                    "ready": GraphNode(
                        id="ready",
                        kind=NodeKind.TASK,
                        label="ready",
                        status=NodeStatus.READY,
                    ),
                    "pending": GraphNode(
                        id="pending",
                        kind=NodeKind.TASK,
                        label="pending",
                        status=NodeStatus.PENDING,
                    ),
                    "running": GraphNode(
                        id="running",
                        kind=NodeKind.TASK,
                        label="running",
                        status=NodeStatus.RUNNING,
                    ),
                },
                edges=[],
            )
            run.run_state.current_nodes = ["running"]
            bus = WorkforceEventBus()

            def _on_event(event: WorkforceEvent) -> None:
                if event.action == WorkforceAction.WORKFORCE_STOPPED:
                    stop_events.append(event)
                    setattr(base_session, "_group_team_workforce_stopped", True)

            bus.subscribe(_on_event)
            controller = GroupTeamController(
                get_or_create_task_lock(f"group::{group_id}::{session_id}"),
                event_bus=bus,
                graph_run=run,
            )
            # Mirror the runtime's bus registration so the server's fallback
            # stop publication observes the same session-scoped stream.
            registry = getattr(base_session, "_group_team_event_bus_registry", None)
            key = str(getattr(base_session, "_group_team_event_bus_key", "") or "")
            if isinstance(registry, dict) and key:
                registry[key] = bus
            setattr(base_session, "_group_team_controller", controller)
            captured.append((run, controller))

            if exit_mode == "interrupt":
                # The request has been accepted and the manager interrupt is
                # already visible when the producer returns.
                manager.request_interrupt(session_id)
                return
            raise RuntimeError("simulated failure after GraphRun bind")
            yield  # pragma: no cover - keeps this function an async generator

    monkeypatch.setattr(server_module, "GroupChatRouter", _FakeGroupRouter)
    monkeypatch.setattr(server_module.ProviderResolver, "resolve", lambda **_kwargs: object())

    app = create_studio_app()
    client = TestClient(app)
    manager = app.state.session_manager
    avatars = app.state.avatar_registry
    groups = app.state.group_registry
    session_id = client.get("/api/session").json()["session_id"]
    member = avatars.create_avatar(name="Team 成员", role="Engineer")
    group = groups.create_group(
        name="Team finalizer test",
        avatar_ids=[member.id],
        routing="team",
    )
    lock_key = f"group::{group.id}::{session_id}"

    response = client.post(
        "/api/chat",
        json={
            "session_id": session_id,
            "group_id": group.id,
            "user_input": "开始团队任务",
        },
    )
    assert response.status_code == 200
    assert captured

    run, controller = captured[0]
    assert controller.closed is True
    assert controller.stopped is True
    assert run.status == "closed"
    assert run.run_state.current_nodes == []
    assert all(
        node.status is NodeStatus.CANCELLED
        for node in run.nodes.values()
    )
    persisted = store.load(run.run_id)
    assert persisted is not None
    assert persisted.status == "closed"
    assert persisted.run_state.current_nodes == []
    assert all(
        node.status is NodeStatus.CANCELLED
        for node in persisted.nodes.values()
    )
    assert len(stop_events) == 1
    expected_execution_state = "failed" if exit_mode == "exception" else "idle"
    assert manager.get(session_id, touch=False).execution_state == expected_execution_state

    remove_task_lock(lock_key)
