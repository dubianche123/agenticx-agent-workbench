"""Graph workflow snapshots are authorized by their Studio session and group."""

from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from agenticx.collaboration.task_lock import TaskLock
from agenticx.runtime.graph.models import GraphRun
from agenticx.runtime.graph.store import GraphRunStore
from agenticx.runtime.group_team_control import GroupTeamController
from agenticx.studio.server import create_studio_app


def _create_group_session(client: TestClient, group_id: str) -> str:
    response = client.get("/api/session", params={"avatar_id": f"group:{group_id}"})
    assert response.status_code == 200
    return str(response.json()["session_id"])


def _save_run(store: GraphRunStore, *, run_id: str, session_id: str, group_id: str) -> GraphRun:
    run = GraphRun(
        run_id=run_id,
        session_id=session_id,
        group_id=group_id,
        nodes={},
        edges=[],
        status="open",
        version=1,
    )
    store.save(run, bump_version=False)
    return run


def test_graph_detail_and_intervention_require_session_and_group_ownership(
    tmp_path: Path,
    monkeypatch,
) -> None:
    from agenticx.runtime.graph import store as graph_store_module

    store = GraphRunStore(root=tmp_path / "graph-runs")
    monkeypatch.setattr(graph_store_module, "_default_store", store)
    app = create_studio_app()
    client = TestClient(app)
    owner_sid = _create_group_session(client, "group-one")
    other_sid = _create_group_session(client, "group-two")
    _save_run(store, run_id="gr_private", session_id=owner_sid, group_id="group-one")

    detail_path = "/api/graph/runs/gr_private"
    assert client.get(detail_path).status_code == 400
    assert client.get(
        detail_path,
        params={"session_id": other_sid, "group_id": "group-two"},
    ).status_code == 403
    assert client.get(
        detail_path,
        params={"session_id": owner_sid, "group_id": "group-two"},
    ).status_code == 403

    owned = client.get(
        detail_path,
        params={"session_id": owner_sid, "group_id": "group-one"},
    )
    assert owned.status_code == 200
    assert owned.json()["run"]["run_id"] == "gr_private"

    rejected = client.post(
        f"{detail_path}/intervene",
        json={
            "session_id": other_sid,
            "group_id": "group-two",
            "op": "pause",
            "version": 1,
            "payload": {"scope": "run"},
        },
    )
    assert rejected.status_code == 403
    unchanged = store.load("gr_private")
    assert unchanged is not None
    assert unchanged.status == "open"
    assert unchanged.version == 1

    accepted = client.post(
        f"{detail_path}/intervene",
        json={
            "session_id": owner_sid,
            "group_id": "group-one",
            "op": "pause",
            "version": 1,
            "payload": {"scope": "run"},
        },
    )
    assert accepted.status_code == 200
    changed = store.load("gr_private")
    assert changed is not None
    assert changed.status == "paused"
    assert changed.version == 2


def test_graph_list_is_fail_closed_and_does_not_resurrect_legacy_group_runs(
    tmp_path: Path,
    monkeypatch,
) -> None:
    from agenticx.runtime.graph import store as graph_store_module

    store = GraphRunStore(root=tmp_path / "graph-runs")
    monkeypatch.setattr(graph_store_module, "_default_store", store)
    client = TestClient(create_studio_app())
    session_id = _create_group_session(client, "group-one")
    _save_run(store, run_id="gr_owned", session_id=session_id, group_id="group-one")
    _save_run(store, run_id="gr_wrong_group", session_id=session_id, group_id="group-two")
    _save_run(store, run_id="gr_legacy", session_id="group-one", group_id="group-one")

    response = client.get(
        "/api/graph/runs",
        params={"session_id": session_id, "group_id": "group-one"},
    )
    assert response.status_code == 200
    assert [row["run_id"] for row in response.json()["runs"]] == ["gr_owned"]

    assert client.get(
        "/api/graph/runs",
        params={"session_id": session_id, "group_id": "group-two"},
    ).status_code == 403
    assert client.get(
        "/api/graph/runs",
        params={"session_id": "missing-session"},
    ).status_code == 404


def test_graph_intervention_mutates_the_live_team_graph(
    tmp_path: Path,
    monkeypatch,
) -> None:
    from agenticx.runtime.graph import store as graph_store_module

    store = GraphRunStore(root=tmp_path / "graph-runs")
    monkeypatch.setattr(graph_store_module, "_default_store", store)
    app = create_studio_app()
    client = TestClient(app)
    session_id = _create_group_session(client, "group-live")
    live_run = _save_run(
        store,
        run_id="gr_live",
        session_id=session_id,
        group_id="group-live",
    )
    managed = app.state.session_manager.get(session_id, touch=False)
    assert managed is not None
    managed.studio_session._group_team_controller = GroupTeamController(
        TaskLock(f"group::group-live::{session_id}"),
        graph_run=live_run,
    )

    response = client.post(
        "/api/graph/runs/gr_live/intervene",
        json={
            "session_id": session_id,
            "group_id": "group-live",
            "op": "pause",
            "version": live_run.version,
            "payload": {"scope": "run"},
        },
    )

    assert response.status_code == 200
    assert live_run.status == "paused"
    assert live_run.version == response.json()["version"]
    persisted = store.load(live_run.run_id)
    assert persisted is not None
    assert persisted.status == "paused"
    assert persisted.version == live_run.version


def test_graph_intervention_cas_conflict_does_not_mutate_live_team_graph(
    tmp_path: Path,
    monkeypatch,
) -> None:
    from agenticx.runtime.graph import store as graph_store_module
    from agenticx.runtime.graph.store import GraphRunVersionConflict

    store = GraphRunStore(root=tmp_path / "graph-runs")
    monkeypatch.setattr(graph_store_module, "_default_store", store)
    app = create_studio_app()
    client = TestClient(app)
    session_id = _create_group_session(client, "group-live-conflict")
    live_run = _save_run(
        store,
        run_id="gr_live_conflict",
        session_id=session_id,
        group_id="group-live-conflict",
    )
    managed = app.state.session_manager.get(session_id, touch=False)
    assert managed is not None
    managed.studio_session._group_team_controller = GroupTeamController(
        TaskLock(f"group::group-live-conflict::{session_id}"),
        graph_run=live_run,
    )

    def reject_stale_save(run, *, bump_version=True, expected_version=None):
        assert run is not live_run
        raise GraphRunVersionConflict(
            run.run_id,
            expected=int(expected_version or 0),
            actual=int(expected_version or 0) + 1,
        )

    monkeypatch.setattr(store, "save", reject_stale_save)
    response = client.post(
        "/api/graph/runs/gr_live_conflict/intervene",
        json={
            "session_id": session_id,
            "group_id": "group-live-conflict",
            "op": "pause",
            "version": live_run.version,
            "payload": {"scope": "run"},
        },
    )

    assert response.status_code == 409
    assert response.json()["detail"]["error"] == "version_conflict"
    assert live_run.status == "open"
    assert live_run.version == 1
