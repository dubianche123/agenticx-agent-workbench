"""Authenticated Workflow definition, run, and approval API contracts."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from agenticx.runtime.graph import store as graph_store_module
from agenticx.runtime.graph.store import GraphRunStore
from agenticx.studio.server import create_studio_app


def _headers(token: str) -> dict[str, str]:
    return {"X-AGX-Desktop-Token": token}


def _task_workflow() -> dict:
    return {
        "title": "API workflow",
        "description": "",
        "objective": "Run a managed task",
        "completion_criteria": ["the task is recorded"],
        "nodes": [
            {"id": "trigger", "kind": "trigger", "label": "Start"},
            {
                "id": "task",
                "kind": "agent_task",
                "label": "Task",
                "objective": "Do the task",
                "deliverable": "Task result",
                "acceptance_criteria": ["Recorded"],
            },
            {"id": "end", "kind": "end", "label": "End"},
        ],
        "edges": [
            {"id": "e1", "source": "trigger", "target": "task"},
            {"id": "e2", "source": "task", "target": "end"},
        ],
    }


def _approval_workflow(*, policy_kind: str = "any") -> dict:
    config = {
        "summary": "Publish the result",
        "target_action_description": "Publish externally",
        "approver_policy_kind": policy_kind,
        "ttl_seconds": 3600,
    }
    if policy_kind not in {"any", "session_owner"}:
        config["approver_policy_value"] = "release-approvers"
    return {
        "title": "Approval API workflow",
        "description": "",
        "objective": "Require an approval",
        "completion_criteria": ["approval is recorded"],
        "nodes": [
            {"id": "trigger", "kind": "trigger", "label": "Start"},
            {
                "id": "gate",
                "kind": "approval_gate",
                "label": "Approve",
                "objective": "Approve publication",
                "config": config,
            },
            {"id": "end", "kind": "end", "label": "End"},
        ],
        "edges": [
            {"id": "e1", "source": "trigger", "target": "gate"},
            {"id": "e2", "source": "gate", "target": "end"},
        ],
    }


@pytest.fixture()
def api_client(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> tuple[TestClient, dict[str, str]]:
    token = "workflow-api-token-a"
    monkeypatch.setenv("AGX_DESKTOP_TOKEN", token)
    monkeypatch.setenv("AGX_HOME", str(tmp_path / "agx-home"))
    monkeypatch.setenv("AGX_WORKFLOWS_ROOT", str(tmp_path / "workflows"))
    monkeypatch.setenv("AGX_GRAPH_RUNS_ROOT", str(tmp_path / "graph-runs"))
    monkeypatch.setattr(graph_store_module, "_default_store", GraphRunStore(tmp_path / "graph-runs"))
    client = TestClient(create_studio_app())
    return client, _headers(token)


def test_workflow_api_returns_snapshot_and_manifest_and_enforces_revision_cas(api_client) -> None:
    client, headers = api_client

    assert client.get("/api/workflows", headers=headers).status_code == 200
    assert client.get("/api/workflows", headers={}).status_code == 401
    connectors = client.get("/api/workflows/connectors", headers=headers)
    assert connectors.status_code == 200
    assert {item["connector_id"] for item in connectors.json()["connectors"]} == {
        "feishu",
        "wecom",
        "github",
        "tapd",
        "tencent-meeting",
        "qqmail",
    }

    created = client.post("/api/workflows", headers=headers, json=_task_workflow())
    assert created.status_code == 200, created.text
    body = created.json()
    assert {"snapshot", "manifest"}.issubset(body)
    workflow_id = body["snapshot"]["workflow_id"]
    assert body["snapshot"]["revision"] == 1
    assert body["manifest"]["head_revision"] == 1

    fetched = client.get(f"/api/workflows/{workflow_id}", headers=headers)
    assert fetched.status_code == 200
    assert fetched.json()["snapshot"]["digest"] == body["snapshot"]["digest"]
    assert fetched.json()["manifest"]["head_revision"] == 1

    updated_draft = _task_workflow()
    updated_draft["title"] = "API workflow v2"
    updated = client.put(
        f"/api/workflows/{workflow_id}",
        headers=headers,
        json={**updated_draft, "expected_head_revision": 1},
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["snapshot"]["revision"] == 2
    assert updated.json()["manifest"]["head_revision"] == 2
    stale = client.put(
        f"/api/workflows/{workflow_id}",
        headers=headers,
        json={**updated_draft, "expected_head_revision": 1},
    )
    assert stale.status_code == 409

    published = client.post(
        f"/api/workflows/{workflow_id}/publish",
        headers=headers,
        json={"revision": 2, "expected_head_revision": 2},
    )
    assert published.status_code == 200, published.text
    published_body = published.json()
    assert {"snapshot", "manifest", "published_revision"}.issubset(published_body)
    assert published_body["published_revision"] == 2
    assert published_body["snapshot"]["revision"] == 2
    assert published_body["manifest"]["active_published_revision"] == 2

    session = client.get("/api/session", headers=headers)
    assert session.status_code == 200, session.text
    session_id = session.json()["session_id"]
    started = client.post(
        f"/api/workflows/{workflow_id}/runs",
        headers=headers,
        json={"revision": 2, "session_id": session_id, "owner_scope": "forged-client-owner"},
    )
    assert started.status_code == 200, started.text
    run = started.json()["run"]
    assert (run["workflow_id"], run["workflow_revision"], run["workflow_digest"]) == (
        workflow_id,
        2,
        published_body["snapshot"]["digest"],
    )
    assert started.json()["ready_node_ids"] == ["task"]

    forged_group = client.post(
        f"/api/workflows/{workflow_id}/runs",
        headers=headers,
        json={"revision": 2, "session_id": session_id, "group_id": "forged-group"},
    )
    assert forged_group.status_code == 403

    missing_workflow = client.post(
        "/api/workflows/wf_missing/runs",
        headers=headers,
        json={"revision": 1, "session_id": session_id},
    )
    assert missing_workflow.status_code == 404, missing_workflow.text

    missing_revision = client.post(
        f"/api/workflows/{workflow_id}/runs",
        headers=headers,
        json={"revision": 99, "session_id": session_id},
    )
    assert missing_revision.status_code == 404, missing_revision.text

    unpublished = client.post("/api/workflows", headers=headers, json=_task_workflow())
    assert unpublished.status_code == 200, unpublished.text
    unpublished_id = unpublished.json()["snapshot"]["workflow_id"]
    unpublished_run = client.post(
        f"/api/workflows/{unpublished_id}/runs",
        headers=headers,
        json={"revision": 1, "session_id": session_id},
    )
    assert unpublished_run.status_code == 409, unpublished_run.text
    assert unpublished_run.json()["detail"]["error"] == "revision_not_published"

    sensitive = _task_workflow()
    sensitive["nodes"][1]["config"] = {"nested": {"Authorization": "Bearer secret", "auth": "secret"}}
    rejected_sensitive = client.post("/api/workflows", headers=headers, json=sensitive)
    assert rejected_sensitive.status_code == 422, rejected_sensitive.text
    assert "sensitive_config_key" in {
        issue["code"] for issue in rejected_sensitive.json()["detail"]["issues"]
    }

    bounded = client.post(
        f"/api/workflow-runs/{run['run_id']}/nodes/task/result",
        headers=headers,
        json={
            "session_id": session_id,
            "expected_version": run["version"],
            "outcome": "done",
            "output_summary": [[[[[[[[[[[[[[0]]]]]]]]]]]]]],
        },
    )
    assert bounded.status_code == 400

    result = client.post(
        f"/api/workflow-runs/{run['run_id']}/nodes/task/result",
        headers=headers,
        json={
            "session_id": session_id,
            "expected_version": run["version"],
            "outcome": "done",
            "output_summary": "managed executor result",
        },
    )
    # Once a run has been explicitly started, the managed executor owns the
    # active claim.  A renderer cannot inject a result over that attempt.
    assert result.status_code in {400, 409}, result.text
    detail = result.json()["detail"]
    if result.status_code == 409:
        assert detail["error"] == "executor_owned_attempt"
    else:
        assert detail["error"] == "execution_error"


def test_workflow_api_uses_stable_owner_and_approval_version_and_fails_closed_policy(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setenv("AGX_HOME", str(tmp_path / "agx-home"))
    monkeypatch.setenv("AGX_WORKFLOWS_ROOT", str(tmp_path / "workflows"))
    monkeypatch.setenv("AGX_GRAPH_RUNS_ROOT", str(tmp_path / "graph-runs"))
    graph_store = GraphRunStore(tmp_path / "graph-runs")
    monkeypatch.setattr(graph_store_module, "_default_store", graph_store)

    token_a = "workflow-api-token-a"
    monkeypatch.setenv("AGX_DESKTOP_TOKEN", token_a)
    first = TestClient(create_studio_app())
    created = first.post("/api/workflows", headers=_headers(token_a), json=_approval_workflow())
    assert created.status_code == 200, created.text
    workflow_id = created.json()["snapshot"]["workflow_id"]
    published = first.post(
        f"/api/workflows/{workflow_id}/publish",
        headers=_headers(token_a),
        json={"revision": 1, "expected_head_revision": 1},
    )
    assert published.status_code == 200, published.text
    session_id = first.get("/api/session", headers=_headers(token_a)).json()["session_id"]
    started = first.post(
        f"/api/workflows/{workflow_id}/runs",
        headers=_headers(token_a),
        json={"revision": 1, "session_id": session_id},
    )
    assert started.status_code == 200, started.text
    run = started.json()["run"]
    approval = started.json()["approvals"][0]
    assert approval["version"] == 1

    approved = first.post(
        f"/api/workflow-approvals/{approval['approval_id']}/decision",
        headers=_headers(token_a),
        json={"session_id": session_id, "expected_version": 1, "decision": "approved", "decided_by": "forged"},
    )
    assert approved.status_code == 200, approved.text
    assert approved.json()["approval"]["version"] == 2
    stale_resume = first.post(
        f"/api/workflow-approvals/{approval['approval_id']}/resume",
        headers=_headers(token_a),
        json={"session_id": session_id, "expected_version": 1},
    )
    assert stale_resume.status_code == 409
    resumed = first.post(
        f"/api/workflow-approvals/{approval['approval_id']}/resume",
        headers=_headers(token_a),
        json={"session_id": session_id, "expected_version": 2, "expected_run_version": run["version"]},
    )
    assert resumed.status_code == 200, resumed.text
    assert resumed.json()["approval"]["status"] == "consumed"
    assert resumed.json()["run"]["status"] == "closed"

    role_workflow = first.post(
        "/api/workflows",
        headers=_headers(token_a),
        json=_approval_workflow(policy_kind="role"),
    )
    role_id = role_workflow.json()["snapshot"]["workflow_id"]
    assert first.post(
        f"/api/workflows/{role_id}/publish",
        headers=_headers(token_a),
        json={"revision": 1, "expected_head_revision": 1},
    ).status_code == 200
    role_run_response = first.post(
        f"/api/workflows/{role_id}/runs",
        headers=_headers(token_a),
        json={"revision": 1, "session_id": session_id},
    )
    role_approval = role_run_response.json()["approvals"][0]
    rejected_policy = first.post(
        f"/api/workflow-approvals/{role_approval['approval_id']}/decision",
        headers=_headers(token_a),
        json={"session_id": session_id, "expected_version": 1, "decision": "approved"},
    )
    assert rejected_policy.status_code == 403
    assert rejected_policy.json()["detail"]["error"] == "approver_policy_not_verifiable"

    # A fresh server process gets a different desktop token but the same
    # AGX_HOME-derived owner scope and can still read the saved definition.
    token_b = "workflow-api-token-b"
    monkeypatch.setenv("AGX_DESKTOP_TOKEN", token_b)
    second = TestClient(create_studio_app())
    listing = second.get("/api/workflows", headers=_headers(token_b))
    assert listing.status_code == 200, listing.text
    assert workflow_id in {item["workflow_id"] for item in listing.json()["workflows"]}
    durable_run = second.get(
        f"/api/workflow-runs/{run['run_id']}",
        headers=_headers(token_b),
        params={"session_id": session_id},
    )
    assert durable_run.status_code == 200, durable_run.text
    assert durable_run.json()["run"]["workflow_digest"] == published.json()["snapshot"]["digest"]
    unknown_session = second.get(
        f"/api/workflow-runs/{run['run_id']}",
        headers=_headers(token_b),
        params={"session_id": "client-invented-session"},
    )
    assert unknown_session.status_code == 404
