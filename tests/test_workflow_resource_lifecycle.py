"""Workflow service construction and persistence resource lifecycle tests."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from agenticx.runtime.graph import store as graph_store_module
from agenticx.runtime.graph.store import GraphRunStore
from agenticx.runtime.workflow import WorkflowRuntimeService, WorkflowStore
from agenticx.studio.workflow_routes import register_workflow_routes


def _register_test_app(token: str = "workflow-token") -> FastAPI:
    app = FastAPI()

    def check_token(value: str | None) -> None:
        if value != token:
            raise HTTPException(status_code=401, detail="unauthorized")

    register_workflow_routes(
        app,
        check_token=check_token,
        require_ordinary_session=lambda _session_id: object(),
        owner_scope="workflow-owner",
    )
    return app


def test_default_workflow_service_is_lazy_and_single_instance(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    workflow_root = tmp_path / "workflows"
    graph_root = tmp_path / "graph-runs"
    monkeypatch.setenv("AGX_WORKFLOWS_ROOT", str(workflow_root))
    monkeypatch.setenv("AGX_GRAPH_RUNS_ROOT", str(graph_root))
    monkeypatch.setattr(graph_store_module, "_default_store", None)

    app = _register_test_app()
    assert not workflow_root.exists()
    assert not graph_root.exists()
    assert not hasattr(app.state, "workflow_runtime_service")

    client = TestClient(app)
    assert client.get("/api/workflows").status_code == 401
    assert not workflow_root.exists()
    assert not graph_root.exists()
    assert not hasattr(app.state, "workflow_runtime_service")

    headers = {"X-AGX-Desktop-Token": "workflow-token"}
    first = client.get("/api/workflows", headers=headers)
    assert first.status_code == 200, first.text
    service = app.state.workflow_runtime_service
    assert workflow_root.is_dir()
    assert graph_root.is_dir()

    second = client.get("/api/workflows", headers=headers)
    assert second.status_code == 200, second.text
    assert app.state.workflow_runtime_service is service


def test_failed_default_service_initialization_can_retry_without_partial_state(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    workflow_root = tmp_path / "workflows"
    graph_root = tmp_path / "graph-runs"
    monkeypatch.setenv("AGX_WORKFLOWS_ROOT", str(workflow_root))
    monkeypatch.setenv("AGX_GRAPH_RUNS_ROOT", str(graph_root))
    monkeypatch.setattr(graph_store_module, "_default_store", None)

    import agenticx.runtime.workflow as workflow_package

    real_service = workflow_package.WorkflowRuntimeService
    attempts = 0

    class FailOnceService(real_service):
        def __init__(self, *args, **kwargs):
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                raise RuntimeError("injected workflow initialization failure")
            super().__init__(*args, **kwargs)

    monkeypatch.setattr(workflow_package, "WorkflowRuntimeService", FailOnceService)
    app = _register_test_app()
    client = TestClient(app)
    headers = {"X-AGX-Desktop-Token": "workflow-token"}

    failed = client.get("/api/workflows", headers=headers)
    assert failed.status_code == 400
    assert not hasattr(app.state, "workflow_runtime_service")

    monkeypatch.setattr(workflow_package, "WorkflowRuntimeService", real_service)
    retried = client.get("/api/workflows", headers=headers)
    assert retried.status_code == 200, retried.text
    assert hasattr(app.state, "workflow_runtime_service")
    assert attempts == 1


@pytest.mark.parametrize("injected", ["workflow_store", "graph_store"])
def test_explicit_store_injection_keeps_eager_service_return_contract(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    injected: str,
) -> None:
    monkeypatch.setenv("AGX_WORKFLOWS_ROOT", str(tmp_path / "default-workflows"))
    monkeypatch.setenv("AGX_GRAPH_RUNS_ROOT", str(tmp_path / "default-graph-runs"))
    monkeypatch.setattr(graph_store_module, "_default_store", None)
    kwargs = {}
    if injected == "workflow_store":
        supplied = WorkflowStore(tmp_path / "injected-workflows")
        kwargs[injected] = supplied
    else:
        supplied = GraphRunStore(tmp_path / "injected-graph-runs")
        kwargs[injected] = supplied

    app = FastAPI()
    returned = register_workflow_routes(
        app,
        check_token=lambda _value: None,
        require_ordinary_session=lambda _session_id: object(),
        owner_scope="workflow-owner",
        **kwargs,
    )

    assert returned is app.state.workflow_runtime_service
    assert app.state.workflow_runtime_service is not None
    assert getattr(app.state.workflow_runtime_service, injected) is supplied


def test_cancel_signals_executor_only_after_durable_version_cas(
    tmp_path: Path,
) -> None:
    workflows = WorkflowStore(tmp_path / "workflows")
    snapshot = workflows.create(
        "workflow-owner",
        {
            "title": "Cancel race workflow",
            "objective": "Exercise cancellation ordering",
            "completion_criteria": ["the task is recorded"],
            "nodes": [
                {"id": "trigger", "kind": "trigger", "label": "Start"},
                {
                    "id": "task",
                    "kind": "agent_task",
                    "label": "Task",
                    "objective": "Do the task",
                    "deliverable": "A result",
                    "acceptance_criteria": ["Recorded"],
                },
                {"id": "end", "kind": "end", "label": "End"},
            ],
            "edges": [
                {"id": "e1", "source": "trigger", "target": "task"},
                {"id": "e2", "source": "task", "target": "end"},
            ],
        },
    )
    workflows.publish(snapshot.workflow_id, "workflow-owner", 1, 1)
    service = WorkflowRuntimeService(
        workflows,
        GraphRunStore(tmp_path / "graph-runs"),
        owner_scope="workflow-owner",
    )
    run = service.create_run(snapshot.workflow_id, 1, "session").run
    claim = service.claim_node(
        run.run_id,
        "task",
        "session",
        claim_owner="executor",
        owner_scope="workflow-owner",
        lease_seconds=30,
    )

    class _ExecutorProbe:
        def __init__(self) -> None:
            self.cancelled: list[str] = []

        def request_cancel(self, run_id: str) -> None:
            self.cancelled.append(run_id)

    probe = _ExecutorProbe()
    app = FastAPI()

    def check_token(value: str | None) -> None:
        if value != "workflow-token":
            raise HTTPException(status_code=401, detail="unauthorized")

    register_workflow_routes(
        app,
        check_token=check_token,
        require_ordinary_session=lambda _session_id: object(),
        owner_scope="workflow-owner",
        runtime_service=service,
        workflow_executor=probe,  # type: ignore[arg-type]
    )
    client = TestClient(app)
    headers = {"X-AGX-Desktop-Token": "workflow-token"}

    # The claim increments the run version.  A stale owner request must fail
    # before touching the executor signal or the live claim.
    stale = client.post(
        f"/api/workflow-runs/{run.run_id}/cancel",
        headers=headers,
        json={"session_id": "session", "expected_version": claim.run_version - 1},
    )
    assert stale.status_code == 409, stale.text
    assert probe.cancelled == []
    assert service.get_node_claim(run.run_id, "task", "session", owner_scope="workflow-owner") is not None

    current = service.get_run(run.run_id, "session", owner_scope="workflow-owner")
    cancelled = client.post(
        f"/api/workflow-runs/{run.run_id}/cancel",
        headers=headers,
        json={"session_id": "session", "expected_version": current.version},
    )
    assert cancelled.status_code == 200, cancelled.text
    assert probe.cancelled == [run.run_id]
    assert service.get_run(run.run_id, "session", owner_scope="workflow-owner").status == "cancelled"
    assert service.get_node_claim(run.run_id, "task", "session", owner_scope="workflow-owner") is None
