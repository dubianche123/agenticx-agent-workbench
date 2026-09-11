#!/usr/bin/env python3
"""Security and lifecycle tests for group Team control endpoints."""

from __future__ import annotations

from fastapi.testclient import TestClient

from agenticx.collaboration.task_lock import (
    get_or_create_task_lock,
    remove_task_lock,
)
from agenticx.runtime.graph.models import GraphNode, GraphRun, NodeKind, NodeStatus
from agenticx.runtime.graph.store import GraphRunStore
from agenticx.runtime.group_team_control import GroupTeamController
from agenticx.studio.server import create_studio_app


def _bound_team_session():
    app = create_studio_app()
    client = TestClient(app)
    manager = app.state.session_manager
    avatars = app.state.avatar_registry
    groups = app.state.group_registry
    session_id = client.get("/api/session").json()["session_id"]
    member = avatars.create_avatar(name="Team 成员", role="Engineer")
    group = groups.create_group(
        name="Team 控制测试群",
        avatar_ids=[member.id],
        routing="team",
    )
    managed = manager.get(session_id, touch=False)
    assert managed is not None
    manager.apply_avatar_binding(
        managed,
        avatar_id=f"group:{group.id}",
        avatar_name=group.name,
    )
    manager.set_execution_state(session_id, "running")
    project_id = f"group::{group.id}::{session_id}"
    task_lock = get_or_create_task_lock(project_id)
    run = GraphRun(
        run_id="run-team-action-api",
        session_id=session_id,
        group_id=group.id,
        nodes={
            "existing": GraphNode(
                id="existing",
                kind=NodeKind.TASK,
                label="existing",
                status=NodeStatus.READY,
                agent_id=member.id,
            )
        },
        edges=[],
    )

    def inject_task(data: dict) -> GraphNode:
        node = GraphNode(
            id=f"added-{len(run.nodes)}",
            kind=NodeKind.TASK,
            label=str(data["task_description"]),
            status=NodeStatus.READY,
            agent_id=member.id,
            task_text=str(data["task_description"]),
        )
        run.nodes[node.id] = node
        return node

    setattr(
        managed.studio_session,
        "_group_team_controller",
        GroupTeamController(
            task_lock,
            graph_run=run,
            inject_task=inject_task,
        ),
    )
    return app, client, manager, groups, session_id, group, task_lock, project_id


def test_group_team_action_requires_bound_active_session() -> None:
    app, client, manager, groups, session_id, group, _lock, project_id = (
        _bound_team_session()
    )
    try:
        other = groups.create_group(
            name="另一个 Team 群",
            avatar_ids=list(group.avatar_ids),
            routing="team",
        )
        cross = client.post(
            f"/api/groups/{other.id}/action",
            json={"session_id": session_id, "action": "pause"},
        )
        assert cross.status_code == 403

        missing = client.post(
            "/api/groups/does-not-exist/action",
            json={"session_id": session_id, "action": "pause"},
        )
        assert missing.status_code == 404

        manager.set_execution_state(session_id, "idle")
        inactive = client.post(
            f"/api/groups/{group.id}/action",
            json={"session_id": session_id, "action": "pause"},
        )
        assert inactive.status_code == 409
        assert inactive.json()["detail"] == "no active team session"
    finally:
        remove_task_lock(project_id)


def test_group_team_action_validates_payload_and_mutates_live_runtime(
    monkeypatch,
    tmp_path,
) -> None:
    monkeypatch.setattr(
        "agenticx.runtime.graph.store.get_default_store",
        lambda: GraphRunStore(root=tmp_path),
    )
    _app, client, manager, _groups, session_id, group, task_lock, project_id = (
        _bound_team_session()
    )
    try:
        controller = getattr(
            manager.get(session_id, touch=False).studio_session,
            "_group_team_controller",
        )
        controller.graph_run.group_id = "wrong-group"
        mismatched_graph = client.post(
            f"/api/groups/{group.id}/action",
            json={"session_id": session_id, "action": "pause"},
        )
        assert mismatched_graph.status_code == 409
        controller.graph_run.group_id = group.id

        empty_add = client.post(
            f"/api/groups/{group.id}/action",
            json={"session_id": session_id, "action": "add_task", "data": {}},
        )
        assert empty_add.status_code == 400

        unsupported = client.post(
            f"/api/groups/{group.id}/action",
            json={"session_id": session_id, "action": "start"},
        )
        assert unsupported.status_code == 400

        accepted = client.post(
            f"/api/groups/{group.id}/action",
            json={
                "session_id": session_id,
                "action": "add_task",
                "data": {"task_description": "补充断线恢复验收"},
            },
        )
        assert accepted.status_code == 200
        body = accepted.json()
        assert body["task_count"] == 2
        assert body["graph_event"]["type"] == "graph.node_updated"
        assert body["graph_event"]["node"]["task_text"] == "补充断线恢复验收"
        assert any(
            node.task_text == "补充断线恢复验收"
            for node in controller.graph_run.nodes.values()
        )
        assert task_lock.queue.empty()

        paused = client.post(
            f"/api/groups/{group.id}/action",
            json={"session_id": session_id, "action": "pause"},
        )
        assert paused.status_code == 200
        assert paused.json()["paused"] is True
        assert paused.json()["graph_event"]["status"] == "paused"
        assert controller.graph_run.status == "paused"

        unknown_task = client.post(
            f"/api/groups/{group.id}/action",
            json={
                "session_id": session_id,
                "action": "skip_task",
                "data": {"task_id": "does-not-exist"},
            },
        )
        assert unknown_task.status_code == 409
        audit = controller.graph_run.meta["team_control_audit"]
        assert [entry["action"] for entry in audit] == [
            "add_task",
            "pause",
            "skip_task",
        ]
        assert [entry["status"] for entry in audit] == [
            "accepted",
            "accepted",
            "rejected",
        ]
        assert {entry["run_id"] for entry in audit} == {
            controller.graph_run.run_id
        }
        assert (
            manager.get(session_id, touch=False)
            .studio_session.scratchpad["group_team_control_audit"]
            == audit
        )
        persisted = GraphRunStore(root=tmp_path).load(controller.graph_run.run_id)
        assert persisted is not None
        assert persisted.meta["team_control_audit"] == audit

        # A later Team run in the same chat keeps a separate control log.
        next_run = GraphRun(
            run_id="run-team-action-api-next",
            session_id=session_id,
            group_id=group.id,
            nodes={},
            edges=[],
        )
        next_controller = GroupTeamController(task_lock, graph_run=next_run)
        managed = manager.get(session_id, touch=False)
        assert managed is not None
        setattr(managed.studio_session, "_group_team_controller", next_controller)
        next_pause = client.post(
            f"/api/groups/{group.id}/action",
            json={"session_id": session_id, "action": "pause"},
        )
        assert next_pause.status_code == 200
        current_audit = managed.studio_session.scratchpad[
            "group_team_control_audit"
        ]
        assert len(current_audit) == 1
        assert current_audit[0]["run_id"] == next_run.run_id
        assert current_audit[0]["control_scope_id"] != audit[0][
            "control_scope_id"
        ]
    finally:
        remove_task_lock(project_id)


def test_group_team_events_reject_cross_group_session() -> None:
    _app, client, _manager, groups, session_id, group, _lock, project_id = (
        _bound_team_session()
    )
    try:
        other = groups.create_group(
            name="事件越权测试群",
            avatar_ids=list(group.avatar_ids),
            routing="team",
        )
        cross = client.get(
            f"/api/groups/{other.id}/events",
            params={"session_id": session_id},
        )
        assert cross.status_code == 403

        no_session = client.get(f"/api/groups/{group.id}/events")
        assert no_session.status_code == 400
    finally:
        remove_task_lock(project_id)
