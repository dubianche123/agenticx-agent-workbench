from __future__ import annotations

import json
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

import pytest

from agenticx.runtime.graph.models import NodeStatus
from agenticx.runtime.graph.models import GraphRun
from agenticx.runtime.graph.store import GraphRunStore, GraphRunVersionConflict
from agenticx.runtime.workflow import (
    ApprovalConflict,
    ApprovalCorruptError,
    ApprovalExpired,
    ApprovalIntentMismatch,
    ApprovalRequest,
    ApprovalService,
    ApprovalStatus,
    ApprovalStore,
    canonical_digest,
    WorkflowRuntimeService,
    WorkflowStore,
)


def _request(*, expires_at: str = "2099-01-01T00:00:00Z") -> ApprovalRequest:
    request = ApprovalRequest(
        approval_id="ap_fixture",
        workflow_id="wf_fixture",
        workflow_revision=1,
        workflow_digest="a" * 64,
        run_id="gr_fixture",
        graph_run_version_at_request=1,
        gate_node_id="gate",
        downstream_node_id="end",
        session_id="session",
        requester_principal="owner",
        acting_agent_id="agent",
        approver_policy_kind="any",
        approver_policy_value=None,
        requested_at="2026-01-01T00:00:00Z",
        expires_at=expires_at,
        summary="Publish",
        target_action_description="Publish externally",
    )
    request.intent_digest = request.calculated_intent_digest()
    return request


def test_intent_digest_binding_and_one_time_cas_transitions(tmp_path) -> None:
    store = ApprovalStore(db_path=tmp_path / "workflow.sqlite3")
    request = store.create(_request())
    assert request.intent_digest == request.calculated_intent_digest()

    approved = store.decide(
        request.approval_id,
        decision="approved",
        expected_version=1,
        decided_by="owner",
        decision_note="go",
    )
    assert approved.status is ApprovalStatus.APPROVED
    assert approved.version == 2
    assert store.decide(
        request.approval_id,
        decision="approved",
        expected_version=1,
        decided_by="owner",
        decision_note="go",
    ).version == 2
    with pytest.raises(ApprovalConflict):
        store.decide(request.approval_id, decision="rejected", expected_version=1)

    consumed = store.consume(request.approval_id, expected_version=2, result_digest="result")
    assert consumed.status is ApprovalStatus.CONSUMED
    assert store.consume(request.approval_id, expected_version=3, result_digest="result").version == 3
    with pytest.raises(ApprovalConflict):
        store.consume(request.approval_id, expected_version=3, result_digest="different")


def test_expiration_and_indexed_json_tamper_fail_closed(tmp_path) -> None:
    store = ApprovalStore(db_path=tmp_path / "workflow.sqlite3")
    request = store.create(_request(expires_at="2020-01-01T00:00:00Z"))
    with pytest.raises(ApprovalExpired):
        store.decide(request.approval_id, decision="approved", expected_version=1)
    assert store.get(request.approval_id).status is ApprovalStatus.EXPIRED

    request2 = _request()
    request2.approval_id = "ap_tamper"
    request2.run_id = "gr_tamper"
    request2.intent_digest = request2.calculated_intent_digest()
    store.create(request2)
    with sqlite3.connect(store.db_path) as conn:
        raw = json.loads(conn.execute("SELECT request_json FROM workflow_approvals WHERE approval_id = ?", (request2.approval_id,)).fetchone()[0])
        raw["session_id"] = "other-session"
        conn.execute(
            "UPDATE workflow_approvals SET request_json = ? WHERE approval_id = ?",
            (json.dumps(raw), request2.approval_id),
        )
    with pytest.raises(ApprovalCorruptError):
        store.get(request2.approval_id)

    request3 = _request()
    request3.approval_id = "ap_tamper_digest"
    request3.run_id = "gr_tamper_digest"
    request3.intent_digest = request3.calculated_intent_digest()
    store.create(request3)
    with sqlite3.connect(store.db_path) as conn:
        raw = json.loads(
            conn.execute(
                "SELECT request_json FROM workflow_approvals WHERE approval_id = ?",
                (request3.approval_id,),
            ).fetchone()[0]
        )
        raw["intent_digest"] = "0" * 64
        conn.execute(
            "UPDATE workflow_approvals SET request_json = ?, intent_digest = ? WHERE approval_id = ?",
            (json.dumps(raw), "0" * 64, request3.approval_id),
        )
    with pytest.raises(ApprovalCorruptError, match="intent digest"):
        store.get(request3.approval_id)


def test_crash_window_retries_exact_done_gate_then_consumes(tmp_path) -> None:
    raw = {
        "title": "Approval workflow",
        "nodes": [
            {"id": "trigger", "kind": "trigger", "label": "Start"},
            {
                "id": "gate",
                "kind": "approval_gate",
                "label": "Approve",
                "objective": "Approve publication",
                "config": {
                    "summary": "Publish",
                    "approver_policy_kind": "any",
                    "target_action_description": "Publish externally",
                    "ttl_seconds": 3600,
                },
            },
            {"id": "end", "kind": "end", "label": "End"},
        ],
        "edges": [
            {"id": "e1", "source": "trigger", "target": "gate"},
            {"id": "e2", "source": "gate", "target": "end"},
        ],
    }
    workflows = WorkflowStore(tmp_path / "workflows")
    snapshot = workflows.create("owner", raw)
    workflows.publish(snapshot.workflow_id, "owner", 1, 1)
    graph = GraphRunStore(tmp_path / "graph-runs")
    runtime = WorkflowRuntimeService(workflows, graph, owner_scope="owner")
    run = runtime.create_run(snapshot.workflow_id, 1, "session").run
    approval = runtime.list_approvals(run.run_id, "session")[0]
    approved = runtime.decide_approval(approval.approval_id, "session", "approved", approval.version)
    request = approved.request

    # Simulate a process crash after the required GraphRun CAS and before the
    # approved -> consumed SQLite transition.
    recovered = graph.load(run.run_id)
    assert recovered is not None
    recovered.nodes["gate"].status = NodeStatus.DONE
    result_digest = runtime.approval_service.store.get(request.approval_id).calculated_intent_digest()
    recovered.nodes["gate"].meta.update(
        {
            "approval_id": request.approval_id,
            "approval_intent_digest": request.intent_digest,
            "approval_result_digest": result_digest,
        }
    )
    graph.save(recovered, bump_version=True, expected_version=recovered.version)

    service = ApprovalService(runtime.approval_store, graph_store=graph, workflow_store=workflows)
    consumed, final_run = service.resume_after_approval(
        request.approval_id,
        session_id="session",
        expected_version=request.version,
    )
    assert consumed.status is ApprovalStatus.CONSUMED
    assert final_run.nodes["gate"].status is NodeStatus.DONE
    assert service.store.get(request.approval_id).status is ApprovalStatus.CONSUMED


def test_recovery_cas_conflict_requires_exact_gate_evidence(tmp_path, monkeypatch) -> None:
    raw = {
        "title": "Approval recovery",
        "nodes": [
            {"id": "trigger", "kind": "trigger", "label": "Start"},
            {
                "id": "gate",
                "kind": "approval_gate",
                "label": "Approve",
                "objective": "Approve publication",
                "config": {
                    "summary": "Publish",
                    "approver_policy_kind": "any",
                    "target_action_description": "Publish externally",
                    "ttl_seconds": 3600,
                },
            },
            {"id": "end", "kind": "end", "label": "End"},
        ],
        "edges": [
            {"id": "e1", "source": "trigger", "target": "gate"},
            {"id": "e2", "source": "gate", "target": "end"},
        ],
    }
    workflows = WorkflowStore(tmp_path / "workflows")
    snapshot = workflows.create("owner", raw)
    workflows.publish(snapshot.workflow_id, "owner", 1, 1)
    graph = GraphRunStore(tmp_path / "graph-runs")
    runtime = WorkflowRuntimeService(workflows, graph, owner_scope="owner")
    run = runtime.create_run(snapshot.workflow_id, 1, "session").run
    approval = runtime.list_approvals(run.run_id, "session")[0]
    approved = runtime.decide_approval(approval.approval_id, "session", "approved", approval.version)
    request = approved.request
    stale = graph.load(run.run_id)
    assert stale is not None

    latest = GraphRun.from_dict(stale.to_dict())
    latest.nodes["gate"].status = NodeStatus.DONE
    latest.nodes["gate"].meta.update(
        {
            "approval_id": "different-approval",
            "approval_intent_digest": request.intent_digest,
            "approval_result_digest": "result",
            "approval_status": "approved",
        }
    )
    loads = [stale, latest]

    def fake_load(_run_id):
        return loads.pop(0) if loads else latest

    def conflict_save(_run, *, bump_version=True, expected_version=None):
        raise GraphRunVersionConflict(
            stale.run_id,
            expected=int(expected_version or 0),
            actual=int(expected_version or 0) + 1,
        )

    monkeypatch.setattr(graph, "load", fake_load)
    monkeypatch.setattr(graph, "save", conflict_save)
    service = ApprovalService(runtime.approval_store, graph_store=graph, workflow_store=workflows)
    with pytest.raises(ApprovalIntentMismatch):
        service.resume_after_approval(
            request.approval_id,
            session_id="session",
            expected_version=request.version,
            expected_run_version=stale.version,
        )

    latest.nodes["gate"].meta["approval_id"] = request.approval_id
    loads[:] = [stale, latest]
    consumed, recovered = service.resume_after_approval(
        request.approval_id,
        session_id="session",
        expected_version=request.version,
        expected_run_version=stale.version,
    )
    assert consumed.status is ApprovalStatus.CONSUMED
    assert recovered.nodes["gate"].status is NodeStatus.DONE


def test_expired_approval_projects_terminal_graph_failure(tmp_path) -> None:
    raw = {
        "title": "Expiring approval",
        "nodes": [
            {"id": "trigger", "kind": "trigger", "label": "Start"},
            {
                "id": "gate",
                "kind": "approval_gate",
                "label": "Approve",
                "objective": "Approve publication",
                "config": {
                    "summary": "Publish",
                    "approver_policy_kind": "any",
                    "target_action_description": "Publish externally",
                    "ttl_seconds": 60,
                },
            },
            {"id": "end", "kind": "end", "label": "End"},
        ],
        "edges": [
            {"id": "e1", "source": "trigger", "target": "gate"},
            {"id": "e2", "source": "gate", "target": "end"},
        ],
    }
    workflows = WorkflowStore(tmp_path / "workflows")
    snapshot = workflows.create("owner", raw)
    workflows.publish(snapshot.workflow_id, "owner", 1, 1)
    graph = GraphRunStore(tmp_path / "graph-runs")
    runtime = WorkflowRuntimeService(workflows, graph, owner_scope="owner")
    run = runtime.create_run(snapshot.workflow_id, 1, "session").run
    expired = runtime.list_approvals(run.run_id, "session", now="2099-01-01T00:00:00Z")
    assert expired[0].status is ApprovalStatus.EXPIRED
    projected = graph.load(run.run_id)
    assert projected is not None
    assert projected.status == "failed"
    assert projected.nodes["gate"].status is NodeStatus.FAILED
    assert projected.nodes["end"].status is NodeStatus.SKIPPED
    assert projected.run_state.current_nodes == []
    with pytest.raises(ApprovalExpired):
        runtime.resume_approval(
            expired[0].approval_id,
            "session",
            expected_version=expired[0].version,
            owner_scope="owner",
            now="2099-01-01T00:00:00Z",
        )


def test_action_params_digest_is_derived_and_mismatch_fails_closed(tmp_path) -> None:
    raw = {
        "title": "Parameter approval",
        "nodes": [
            {"id": "trigger", "kind": "trigger", "label": "Start"},
            {
                "id": "gate",
                "kind": "approval_gate",
                "label": "Approve",
                "objective": "Approve document action",
                "config": {
                    "summary": "Change document",
                    "approver_policy_kind": "any",
                    "target_action_description": "Apply document change",
                    "action_params": {"document_ref": "doc-1", "change_ref": "change-1"},
                    "action_params_digest": "0" * 64,
                    "ttl_seconds": 3600,
                },
            },
            {"id": "end", "kind": "end", "label": "End"},
        ],
        "edges": [
            {"id": "e1", "source": "trigger", "target": "gate"},
            {"id": "e2", "source": "gate", "target": "end"},
        ],
    }
    workflows = WorkflowStore(tmp_path / "workflows")
    snapshot = workflows.create("owner", raw)
    workflows.publish(snapshot.workflow_id, "owner", 1, 1)
    runtime = WorkflowRuntimeService(workflows, GraphRunStore(tmp_path / "graph-runs"), owner_scope="owner")
    with pytest.raises(ApprovalIntentMismatch):
        runtime.create_run(snapshot.workflow_id, 1, "session")

    raw["nodes"][1]["config"]["action_params_digest"] = canonical_digest(
        raw["nodes"][1]["config"]["action_params"]
    )
    corrected = workflows.append_revision(snapshot.workflow_id, "owner", 1, raw)
    workflows.publish(snapshot.workflow_id, "owner", corrected.revision, corrected.revision)
    created = runtime.create_run(snapshot.workflow_id, corrected.revision, "session-2")
    assert created.approvals[0].action_params_digest == canonical_digest(
        raw["nodes"][1]["config"]["action_params"]
    )


def test_negative_approval_clears_parallel_ready_work(tmp_path) -> None:
    raw = {
        "title": "Reject fail fast",
        "nodes": [
            {"id": "trigger", "kind": "trigger", "label": "Start"},
            {
                "id": "gate",
                "kind": "approval_gate",
                "label": "Approve",
                "objective": "Approve publication",
                "config": {
                    "summary": "Publish",
                    "approver_policy_kind": "any",
                    "target_action_description": "Publish externally",
                    "ttl_seconds": 3600,
                },
            },
            {
                "id": "optional",
                "kind": "agent_task",
                "label": "Best effort",
                "objective": "Try optional work",
                "deliverable": "Optional output",
                "acceptance_criteria": ["Recorded"],
                "required": False,
            },
            {"id": "end", "kind": "end", "label": "End"},
        ],
        "edges": [
            {"id": "e1", "source": "trigger", "target": "gate"},
            {"id": "e2", "source": "trigger", "target": "optional"},
            {"id": "e3", "source": "gate", "target": "end"},
            {"id": "e4", "source": "optional", "target": "end"},
        ],
    }
    workflows = WorkflowStore(tmp_path / "workflows")
    snapshot = workflows.create("owner", raw)
    workflows.publish(snapshot.workflow_id, "owner", 1, 1)
    runtime = WorkflowRuntimeService(workflows, GraphRunStore(tmp_path / "graph-runs"), owner_scope="owner")
    created = runtime.create_run(snapshot.workflow_id, 1, "session")
    assert created.ready_node_ids == ["optional"]
    rejected = runtime.decide_approval(
        created.approvals[0].approval_id,
        "session",
        "rejected",
        created.approvals[0].version,
        owner_scope="owner",
    )
    assert rejected.run.status == "failed"
    assert rejected.run.run_state.current_nodes == []
    assert rejected.run.nodes["optional"].status is NodeStatus.SKIPPED


def test_terminal_negative_row_reconciles_after_graph_write_crash(tmp_path) -> None:
    raw = {
        "title": "Rejected recovery",
        "nodes": [
            {"id": "trigger", "kind": "trigger", "label": "Start"},
            {
                "id": "gate",
                "kind": "approval_gate",
                "label": "Approve",
                "objective": "Approve publication",
                "config": {
                    "summary": "Publish",
                    "approver_policy_kind": "any",
                    "target_action_description": "Publish externally",
                    "ttl_seconds": 3600,
                },
            },
            {
                "id": "optional",
                "kind": "agent_task",
                "label": "Best effort",
                "objective": "Try optional work",
                "deliverable": "Optional output",
                "acceptance_criteria": ["Recorded"],
                "required": False,
            },
            {"id": "end", "kind": "end", "label": "End"},
        ],
        "edges": [
            {"id": "e1", "source": "trigger", "target": "gate"},
            {"id": "e2", "source": "trigger", "target": "optional"},
            {"id": "e3", "source": "gate", "target": "end"},
            {"id": "e4", "source": "optional", "target": "end"},
        ],
    }
    workflows = WorkflowStore(tmp_path / "workflows")
    snapshot = workflows.create("owner", raw)
    workflows.publish(snapshot.workflow_id, "owner", 1, 1)
    graph = GraphRunStore(tmp_path / "graph-runs")
    runtime = WorkflowRuntimeService(workflows, graph, owner_scope="owner")
    created = runtime.create_run(snapshot.workflow_id, 1, "session")
    request = created.approvals[0]
    # Simulate the SQLite decision committing before the GraphRun write.
    rejected = runtime.approval_store.decide(
        request.approval_id,
        decision="rejected",
        expected_version=request.version,
        decided_by="owner",
    )
    assert rejected.status is ApprovalStatus.REJECTED
    stale = graph.load(created.run.run_id)
    assert stale is not None and stale.nodes["gate"].status is NodeStatus.BLOCKED
    # An unrelated writer advances the run before reconciliation.  The next
    # read must use the latest version and still converge the terminal row.
    stale.meta["unrelated"] = True
    graph.save(stale, bump_version=True, expected_version=stale.version)
    projected = runtime.get_run(created.run.run_id, "session", owner_scope="owner")
    assert projected.status == "failed"
    assert projected.nodes["gate"].status is NodeStatus.FAILED
    assert projected.nodes["optional"].status is NodeStatus.SKIPPED
    assert projected.run_state.current_nodes == []


def test_negative_gate_cancels_parallel_pending_approvals_and_projects_gate_metadata(tmp_path) -> None:
    def gate(node_id: str) -> dict:
        return {
            "id": node_id,
            "kind": "approval_gate",
            "label": node_id,
            "objective": "Authorize the operation",
            "config": {
                "summary": f"Approve {node_id}",
                "approver_policy_kind": "any",
                "target_action_description": "Apply the approved operation",
                "ttl_seconds": 3600,
            },
        }

    raw = {
        "title": "Parallel approvals",
        "nodes": [
            {"id": "trigger", "kind": "trigger", "label": "Start"},
            gate("gate_a"),
            gate("gate_b"),
            {"id": "end", "kind": "end", "label": "End"},
        ],
        "edges": [
            {"id": "e1", "source": "trigger", "target": "gate_a"},
            {"id": "e2", "source": "trigger", "target": "gate_b"},
            {"id": "e3", "source": "gate_a", "target": "end"},
            {"id": "e4", "source": "gate_b", "target": "end"},
        ],
    }
    workflows = WorkflowStore(tmp_path / "workflows")
    snapshot = workflows.create("owner", raw)
    workflows.publish(snapshot.workflow_id, "owner", 1, 1)
    graph = GraphRunStore(tmp_path / "graph-runs")
    runtime = WorkflowRuntimeService(workflows, graph, owner_scope="owner")
    created = runtime.create_run(snapshot.workflow_id, 1, "session")
    assert {item.gate_node_id for item in created.approvals} == {"gate_a", "gate_b"}

    first = next(item for item in created.approvals if item.gate_node_id == "gate_a")
    second = next(item for item in created.approvals if item.gate_node_id == "gate_b")
    rejected = runtime.decide_approval(
        first.approval_id,
        "session",
        "rejected",
        first.version,
        owner_scope="owner",
    )
    assert rejected.run.status == "failed"
    assert rejected.run.run_state.current_nodes == []
    cancelled = runtime.approval_store.get(second.approval_id)
    assert cancelled.status is ApprovalStatus.CANCELLED

    recovered = runtime.get_run(created.run.run_id, "session", owner_scope="owner")
    assert recovered.status == "failed"
    assert recovered.nodes["gate_b"].status is NodeStatus.CANCELLED
    assert recovered.nodes["gate_b"].meta["approval_id"] == second.approval_id
    assert recovered.nodes["gate_b"].meta["approval_intent_digest"] == second.intent_digest
    assert recovered.nodes["gate_b"].meta["approval_status"] == ApprovalStatus.CANCELLED.value


def test_owner_cancel_reconciles_pending_gate_after_graph_cas_crash_and_restart(tmp_path, monkeypatch) -> None:
    """The owner-cancel GraphRun CAS must be replayable before row CAS."""

    workflows = WorkflowStore(tmp_path / "workflows")
    snapshot = workflows.create("owner", _parallel_approval_workflow())
    workflows.publish(snapshot.workflow_id, "owner", 1, 1)
    graph = GraphRunStore(tmp_path / "graph-runs")
    runtime = WorkflowRuntimeService(workflows, graph, owner_scope="owner")
    created = runtime.create_run(snapshot.workflow_id, 1, "session")
    request = next(item for item in created.approvals if item.gate_node_id == "gate_a")

    original_decide = runtime.approval_store.decide
    crashed = {"value": False}

    def crash_after_graph_cas(*args, **kwargs):
        if not crashed["value"]:
            crashed["value"] = True
            raise RuntimeError("simulated crash before approval row CAS")
        return original_decide(*args, **kwargs)

    monkeypatch.setattr(runtime.approval_store, "decide", crash_after_graph_cas)
    with pytest.raises(RuntimeError, match="simulated crash"):
        runtime.cancel_run(
            created.run.run_id,
            "session",
            expected_version=created.run.version,
            owner_scope="owner",
            cancelled_by="owner",
        )

    persisted = graph.load(created.run.run_id)
    assert persisted is not None
    assert persisted.status == "cancelled"
    assert persisted.nodes["gate_a"].status is NodeStatus.CANCELLED
    assert persisted.nodes["gate_a"].meta["workflow_cancel_reason"] == "owner_cancelled"
    assert runtime.approval_store.get(request.approval_id).status is ApprovalStatus.PENDING

    # A fresh service instance represents a process restart.  Replaying the
    # owner cancel must complete the pending row and exact gate metadata once.
    restarted = WorkflowRuntimeService(
        workflows,
        graph,
        approval_store=runtime.approval_store,
        owner_scope="owner",
    )
    replayed = restarted.cancel_run(
        created.run.run_id,
        "session",
        expected_version=persisted.version,
        owner_scope="owner",
        cancelled_by="owner",
    )
    assert replayed.status == "cancelled"
    assert replayed.nodes["gate_a"].status is NodeStatus.CANCELLED
    cancelled = restarted.approval_store.get(request.approval_id)
    assert cancelled.status is ApprovalStatus.CANCELLED
    assert replayed.nodes["gate_a"].meta["approval_id"] == request.approval_id
    assert replayed.nodes["gate_a"].meta["approval_intent_digest"] == request.intent_digest
    assert replayed.nodes["gate_a"].meta["approval_status"] == ApprovalStatus.CANCELLED.value

    # A second replay is idempotent and must not create another approval row
    # or rewrite the run into failed.
    replay_again = restarted.cancel_run(
        created.run.run_id,
        "session",
        expected_version=replayed.version,
        owner_scope="owner",
        cancelled_by="owner",
    )
    assert replay_again.status == "cancelled"
    assert len(restarted.approval_store.list_for_run(created.run.run_id, session_id="session")) == len(created.approvals)


def test_pending_approval_cannot_be_cancelled_from_forged_cancelled_gate(tmp_path) -> None:
    """A CANCELLED graph node without the owner marker fails closed."""

    workflows = WorkflowStore(tmp_path / "workflows")
    snapshot = workflows.create("owner", _parallel_approval_workflow())
    workflows.publish(snapshot.workflow_id, "owner", 1, 1)
    graph = GraphRunStore(tmp_path / "graph-runs")
    runtime = WorkflowRuntimeService(workflows, graph, owner_scope="owner")
    created = runtime.create_run(snapshot.workflow_id, 1, "session")
    request = next(item for item in created.approvals if item.gate_node_id == "gate_a")

    forged = graph.load(created.run.run_id)
    assert forged is not None
    forged.status = "cancelled"
    forged.nodes["gate_a"].status = NodeStatus.CANCELLED
    forged.nodes["gate_a"].meta.pop("workflow_cancel_reason", None)
    graph.save(forged, bump_version=True, expected_version=forged.version)

    with pytest.raises(ApprovalIntentMismatch):
        runtime._cancel_pending_terminal_approvals(forged)
    assert runtime.approval_store.get(request.approval_id).status is ApprovalStatus.PENDING


def _parallel_approval_workflow(*, required: bool = True) -> dict:
    def gate(node_id: str) -> dict:
        return {
            "id": node_id,
            "kind": "approval_gate",
            "label": node_id,
            "objective": "Authorize the operation",
            "required": required,
            "config": {
                "summary": f"Approve {node_id}",
                "approver_policy_kind": "any",
                "target_action_description": "Apply the approved operation",
                "ttl_seconds": 3600,
            },
        }

    return {
        "title": "Parallel approvals fixture",
        "nodes": [
            {"id": "trigger", "kind": "trigger", "label": "Start"},
            gate("gate_a"),
            gate("gate_b"),
            {"id": "end", "kind": "end", "label": "End"},
        ],
        "edges": [
            {"id": "e1", "source": "trigger", "target": "gate_a"},
            {"id": "e2", "source": "trigger", "target": "gate_b"},
            {"id": "e3", "source": "gate_a", "target": "end"},
            {"id": "e4", "source": "gate_b", "target": "end"},
        ],
    }


def test_approved_parallel_gate_cannot_resume_after_sibling_rejection(tmp_path) -> None:
    workflows = WorkflowStore(tmp_path / "workflows")
    snapshot = workflows.create("owner", _parallel_approval_workflow())
    workflows.publish(snapshot.workflow_id, "owner", 1, 1)
    runtime = WorkflowRuntimeService(workflows, GraphRunStore(tmp_path / "graph-runs"), owner_scope="owner")
    created = runtime.create_run(snapshot.workflow_id, 1, "session")
    gate_a = next(item for item in created.approvals if item.gate_node_id == "gate_a")
    gate_b = next(item for item in created.approvals if item.gate_node_id == "gate_b")
    approved = runtime.decide_approval(
        gate_b.approval_id,
        "session",
        "approved",
        gate_b.version,
        owner_scope="owner",
    )
    runtime.decide_approval(
        gate_a.approval_id,
        "session",
        "rejected",
        gate_a.version,
        owner_scope="owner",
    )
    assert runtime.approval_store.get(gate_b.approval_id).status is ApprovalStatus.APPROVED
    with pytest.raises(ApprovalConflict, match="terminal"):
        runtime.resume_approval(
            gate_b.approval_id,
            "session",
            expected_version=approved.request.version,
            owner_scope="owner",
        )
    failed = runtime.get_run(created.run.run_id, "session", owner_scope="owner")
    assert failed.status == "failed"
    assert failed.nodes["gate_b"].status is NodeStatus.SKIPPED


def test_optional_parallel_approval_rejection_cancels_sibling_without_skip_conflict(tmp_path) -> None:
    workflows = WorkflowStore(tmp_path / "workflows")
    snapshot = workflows.create("owner", _parallel_approval_workflow(required=False))
    workflows.publish(snapshot.workflow_id, "owner", 1, 1)
    runtime = WorkflowRuntimeService(workflows, GraphRunStore(tmp_path / "graph-runs"), owner_scope="owner")
    created = runtime.create_run(snapshot.workflow_id, 1, "session")
    first = next(item for item in created.approvals if item.gate_node_id == "gate_a")
    second = next(item for item in created.approvals if item.gate_node_id == "gate_b")
    runtime.decide_approval(first.approval_id, "session", "rejected", first.version, owner_scope="owner")
    sibling = runtime.approval_store.get(second.approval_id)
    assert sibling.status is ApprovalStatus.CANCELLED
    recovered = runtime.get_run(created.run.run_id, "session", owner_scope="owner")
    assert recovered.status == "failed"
    assert recovered.nodes["gate_b"].status is NodeStatus.CANCELLED
    assert recovered.nodes["gate_b"].meta["approval_status"] == ApprovalStatus.CANCELLED.value


def test_optional_parallel_approval_expiry_projects_all_terminal_gates(tmp_path) -> None:
    workflows = WorkflowStore(tmp_path / "workflows")
    snapshot = workflows.create("owner", _parallel_approval_workflow(required=False))
    workflows.publish(snapshot.workflow_id, "owner", 1, 1)
    graph = GraphRunStore(tmp_path / "graph-runs")
    runtime = WorkflowRuntimeService(workflows, graph, owner_scope="owner")
    created = runtime.create_run(snapshot.workflow_id, 1, "session")
    expired = runtime.list_approvals(
        created.run.run_id,
        "session",
        owner_scope="owner",
        now="2099-01-01T00:00:00Z",
    )
    assert {item.status for item in expired} == {ApprovalStatus.EXPIRED}
    recovered = runtime.get_run(created.run.run_id, "session", owner_scope="owner")
    assert recovered.status == "failed"
    assert recovered.nodes["gate_a"].status is NodeStatus.FAILED
    assert recovered.nodes["gate_b"].status is NodeStatus.FAILED
    assert recovered.nodes["end"].status is NodeStatus.SKIPPED


def test_get_run_repairs_missing_reachable_approval_after_graph_write(tmp_path) -> None:
    workflows = WorkflowStore(tmp_path / "workflows")
    snapshot = workflows.create("owner", _parallel_approval_workflow())
    workflows.publish(snapshot.workflow_id, "owner", 1, 1)
    graph = GraphRunStore(tmp_path / "graph-runs")
    runtime = WorkflowRuntimeService(workflows, graph, owner_scope="owner")
    created = runtime.create_run(snapshot.workflow_id, 1, "session")
    original = created.approvals[0]
    with sqlite3.connect(runtime.approval_store.db_path) as conn:
        conn.execute("DELETE FROM workflow_approvals WHERE approval_id = ?", (original.approval_id,))
    remaining = runtime.approval_store.list_for_run(created.run.run_id, session_id="session")
    assert [row.gate_node_id for row in remaining] == ["gate_b"]
    repaired = runtime.get_run(created.run.run_id, "session", owner_scope="owner")
    rows = runtime.approval_store.list_for_run(created.run.run_id, session_id="session")
    assert len(rows) == 2
    assert {row.gate_node_id for row in rows} == {"gate_a", "gate_b"}
    assert repaired.nodes["gate_a"].status is NodeStatus.BLOCKED


def test_concurrent_ensure_for_gate_returns_one_exact_row(tmp_path) -> None:
    workflows = WorkflowStore(tmp_path / "workflows")
    snapshot = workflows.create("owner", _parallel_approval_workflow())
    workflows.publish(snapshot.workflow_id, "owner", 1, 1)
    graph = GraphRunStore(tmp_path / "graph-runs")
    runtime = WorkflowRuntimeService(workflows, graph, owner_scope="owner")
    created = runtime.create_run(snapshot.workflow_id, 1, "session")
    first = next(item for item in created.approvals if item.gate_node_id == "gate_a")
    with sqlite3.connect(runtime.approval_store.db_path) as conn:
        conn.execute("DELETE FROM workflow_approvals WHERE approval_id = ?", (first.approval_id,))
    run = graph.load(created.run.run_id)
    assert run is not None
    service = ApprovalService(runtime.approval_store, graph_store=graph, workflow_store=workflows)
    barrier = Barrier(2)

    def ensure_once() -> ApprovalRequest:
        barrier.wait(timeout=10)
        return service.ensure_for_gate(run, "gate_a", requester_principal="owner")

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _index: ensure_once(), range(2)))
    assert results[0].approval_id == results[1].approval_id
    rows = runtime.approval_store.list_for_run(run.run_id, session_id="session")
    assert [row.gate_node_id for row in rows].count("gate_a") == 1


def test_duplicate_gate_rows_in_legacy_database_fail_closed_on_migration(tmp_path) -> None:
    db_path = tmp_path / "workflow.sqlite3"
    store = ApprovalStore(db_path=db_path)
    first = _request()
    store.create(first)
    with sqlite3.connect(db_path) as conn:
        conn.execute("DROP INDEX uq_workflow_approvals_run_gate")
    duplicate = _request()
    duplicate.approval_id = "ap_duplicate"
    store.create(duplicate)
    with pytest.raises(ApprovalCorruptError, match="duplicate approval rows"):
        ApprovalStore(db_path=db_path)


def test_existing_gate_unique_index_skips_legacy_duplicate_scan(tmp_path, monkeypatch) -> None:
    db_path = tmp_path / "workflow.sqlite3"
    ApprovalStore(db_path=db_path)
    statements: list[str] = []
    original_connect = ApprovalStore._connect

    def traced_connect(store):
        conn = original_connect(store)
        conn.set_trace_callback(statements.append)
        return conn

    monkeypatch.setattr(ApprovalStore, "_connect", traced_connect)
    ApprovalStore(db_path=db_path)
    assert not any("GROUP BY run_id, gate_node_id" in statement for statement in statements)


@pytest.mark.parametrize("index_kind", ["non_unique", "wrong_columns", "partial"])
def test_malformed_gate_uniqueness_index_fails_closed_without_dropping_it(tmp_path, index_kind) -> None:
    db_path = tmp_path / f"workflow-{index_kind}.sqlite3"
    ApprovalStore(db_path=db_path)
    with sqlite3.connect(db_path) as conn:
        conn.execute("DROP INDEX uq_workflow_approvals_run_gate")
        if index_kind == "non_unique":
            conn.execute(
                "CREATE INDEX uq_workflow_approvals_run_gate "
                "ON workflow_approvals(run_id, gate_node_id)"
            )
        elif index_kind == "wrong_columns":
            conn.execute(
                "CREATE UNIQUE INDEX uq_workflow_approvals_run_gate "
                "ON workflow_approvals(run_id, gate_node_id, approval_id)"
            )
        else:
            conn.execute(
                "CREATE UNIQUE INDEX uq_workflow_approvals_run_gate "
                "ON workflow_approvals(run_id, gate_node_id) WHERE gate_node_id <> ''"
            )

    with pytest.raises(ApprovalCorruptError, match="cannot enforce unique approval gate rows"):
        ApprovalStore(db_path=db_path)

    with sqlite3.connect(db_path) as conn:
        index_names = {
            row[1]
            for row in conn.execute("PRAGMA index_list(workflow_approvals)").fetchall()
        }
    assert "uq_workflow_approvals_run_gate" in index_names
