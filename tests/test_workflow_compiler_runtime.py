from __future__ import annotations

import sqlite3
from copy import deepcopy

import pytest

from agenticx.runtime.graph.models import NodeKind, NodeStatus
from agenticx.runtime.graph.store import GraphRunStore
from agenticx.runtime.workflow import (
    WorkflowExecutorError,
    WorkflowNotFound,
    WorkflowRevisionNotPublished,
    WorkflowRunConflict,
    WorkflowRuntimeService,
    WorkflowStore,
    compile_workflow_run,
)


def workflow_raw() -> dict:
    return {
        "title": "Release workflow",
        "description": "",
        "objective": "Ship a reviewed release",
        "completion_criteria": ["release is recorded"],
        "nodes": [
            {"id": "trigger", "kind": "trigger", "label": "Start"},
            {
                "id": "task",
                "kind": "agent_task",
                "label": "Prepare",
                "objective": "Prepare release",
                "deliverable": "Package",
                "acceptance_criteria": ["Complete"],
            },
            {
                "id": "action",
                "kind": "connector_action",
                "label": "Read document",
                "objective": "Read release document",
                "deliverable": "Summary",
                "acceptance_criteria": ["Clear"],
                "config": {"connector_id": "feishu", "action_id": "read_document", "document_ref": "doc-1"},
            },
            {"id": "decision", "kind": "decision", "label": "Ready?"},
            {
                "id": "review",
                "kind": "review",
                "label": "Review",
                "objective": "Review release",
                "deliverable": "Review result",
                "acceptance_criteria": ["Recorded"],
            },
            {"id": "end", "kind": "end", "label": "End"},
        ],
        "edges": [
            {"id": "e1", "source": "trigger", "target": "task"},
            {"id": "e2", "source": "task", "target": "action"},
            {"id": "e3", "source": "action", "target": "decision"},
            {"id": "e4", "source": "decision", "target": "review", "route": "yes"},
            {"id": "e5", "source": "decision", "target": "end", "route": "no"},
            {"id": "e6", "source": "review", "target": "end"},
        ],
    }


def test_compiler_binds_exact_revision_and_uses_existing_node_kinds(tmp_path) -> None:
    store = WorkflowStore(tmp_path / "workflows")
    snapshot = store.create("owner", workflow_raw())
    store.publish(snapshot.workflow_id, "owner", 1, 1)
    runtime = WorkflowRuntimeService(
        workflow_store=store,
        graph_store=GraphRunStore(tmp_path / "graph-runs"),
        owner_scope="owner",
    )
    created = runtime.create_run(snapshot.workflow_id, 1, "session")
    run = created.run

    assert (run.workflow_id, run.workflow_revision, run.workflow_digest) == (
        snapshot.workflow_id,
        1,
        snapshot.digest,
    )
    assert run.meta["source"] == "workflow"
    for node in run.nodes.values():
        assert node.meta["workflow_id"] == snapshot.workflow_id
        assert node.meta["workflow_revision"] == 1
        assert node.meta["workflow_digest"] == snapshot.digest
        assert node.meta["workflow_node_id"] == node.id
    assert run.nodes["trigger"].kind is NodeKind.HUMAN
    assert run.nodes["task"].kind is NodeKind.TASK
    assert run.nodes["action"].kind is NodeKind.TASK
    assert run.nodes["review"].kind is NodeKind.REVIEW


def test_unpublished_revision_cannot_start_and_executor_result_advances(tmp_path) -> None:
    store = WorkflowStore(tmp_path / "workflows")
    snapshot = store.create("owner", workflow_raw())
    runtime = WorkflowRuntimeService(
        workflow_store=store,
        graph_store=GraphRunStore(tmp_path / "graph-runs"),
        owner_scope="owner",
    )
    with pytest.raises(WorkflowRevisionNotPublished):
        runtime.create_run(snapshot.workflow_id, 1, "session")
    with pytest.raises(WorkflowNotFound):
        runtime.create_run("wf_missing", 1, "session")
    with pytest.raises(WorkflowNotFound):
        runtime.create_run(snapshot.workflow_id, 2, "session")

    store.publish(snapshot.workflow_id, "owner", 1, 1)
    created = runtime.create_run(snapshot.workflow_id, 1, "session")
    run = created.run
    assert created.ready_node_ids == ["task"]
    run = runtime.report_node_result(run.run_id, "task", "session", run.version, "done", "package")
    assert run.nodes["action"].status is NodeStatus.READY
    run = runtime.report_node_result(run.run_id, "action", "session", run.version, "done", "summary")
    assert run.nodes["decision"].status is NodeStatus.READY
    run = runtime.report_node_result(
        run.run_id,
        "decision",
        "session",
        run.version,
        "done",
        "yes",
        selected_route="yes",
    )
    assert run.nodes["review"].status is NodeStatus.READY
    assert run.nodes["end"].status is NodeStatus.PENDING
    run = runtime.report_node_result(run.run_id, "review", "session", run.version, "done", "approved")
    assert run.nodes["end"].status is NodeStatus.DONE
    assert run.status == "closed"


def test_selected_decision_route_skips_non_selected_branch_and_duplicate_digest_is_idempotent(tmp_path) -> None:
    raw = workflow_raw()
    raw["nodes"].append(
        {
            "id": "optional",
            "kind": "agent_task",
            "label": "Optional",
            "objective": "Optional task",
            "deliverable": "Optional output",
            "acceptance_criteria": ["Recorded"],
            "required": False,
        }
    )
    raw["edges"].append({"id": "e7", "source": "decision", "target": "optional", "route": "maybe"})
    raw["edges"].append({"id": "e8", "source": "optional", "target": "end"})
    # The decision still has three catalogued routes; choose the direct end.
    store = WorkflowStore(tmp_path / "workflows")
    snapshot = store.create("owner", raw)
    store.publish(snapshot.workflow_id, "owner", 1, 1)
    runtime = WorkflowRuntimeService(store, GraphRunStore(tmp_path / "graph-runs"), owner_scope="owner")
    run = runtime.create_run(snapshot.workflow_id, 1, "session").run
    for node_id in ("task", "action"):
        run = runtime.report_node_result(run.run_id, node_id, "session", run.version, "done", "ok")
    run = runtime.report_node_result(run.run_id, "decision", "session", run.version, "done", "no", selected_route="no")
    assert run.nodes["review"].status is NodeStatus.SKIPPED
    assert run.nodes["optional"].status is NodeStatus.SKIPPED
    assert run.nodes["end"].status is NodeStatus.DONE
    assert run.status == "closed"
    # Replaying the exact result is safe even though the caller has an old
    # version after the structural propagation.
    replay = runtime.report_node_result(run.run_id, "decision", "session", 1, "done", "no", selected_route="no")
    assert replay.version == run.version


def test_optional_failure_still_reaches_end(tmp_path) -> None:
    raw = {
        "title": "Optional work",
        "nodes": [
            {"id": "trigger", "kind": "trigger", "label": "Start"},
            {
                "id": "task",
                "kind": "agent_task",
                "label": "Best effort",
                "objective": "Try it",
                "deliverable": "Attempt",
                "acceptance_criteria": ["Recorded"],
                "required": False,
            },
            {"id": "end", "kind": "end", "label": "End"},
        ],
        "edges": [
            {"id": "e1", "source": "trigger", "target": "task"},
            {"id": "e2", "source": "task", "target": "end"},
        ],
    }
    store = WorkflowStore(tmp_path / "workflows")
    snapshot = store.create("owner", raw)
    store.publish(snapshot.workflow_id, "owner", 1, 1)
    runtime = WorkflowRuntimeService(store, GraphRunStore(tmp_path / "graph-runs"), owner_scope="owner")
    run = runtime.create_run(snapshot.workflow_id, 1, "session").run
    run = runtime.report_node_result(run.run_id, "task", "session", run.version, "failed", "best effort failed")
    assert run.nodes["end"].status is NodeStatus.DONE
    assert run.status == "closed"


def test_failed_decision_has_no_route_and_required_failure_is_fail_fast(tmp_path) -> None:
    store = WorkflowStore(tmp_path / "workflows")
    snapshot = store.create("owner", workflow_raw())
    store.publish(snapshot.workflow_id, "owner", 1, 1)
    runtime = WorkflowRuntimeService(store, GraphRunStore(tmp_path / "graph-runs"), owner_scope="owner")
    run = runtime.create_run(snapshot.workflow_id, 1, "session").run
    for node_id in ("task", "action"):
        run = runtime.report_node_result(run.run_id, node_id, "session", run.version, "done", "ok")
    run = runtime.report_node_result(run.run_id, "decision", "session", run.version, "failed", "decision failed")
    assert run.status == "failed"
    assert run.nodes["review"].status is NodeStatus.SKIPPED
    assert run.nodes["end"].status is NodeStatus.SKIPPED
    with pytest.raises(WorkflowExecutorError):
        runtime.report_node_result(run.run_id, "review", "session", run.version, "done", "late result")

    parallel = {
        "title": "Fail fast",
        "nodes": [
            {"id": "trigger", "kind": "trigger", "label": "Start"},
            {
                "id": "required",
                "kind": "agent_task",
                "label": "Required",
                "objective": "Required work",
                "deliverable": "Required output",
                "acceptance_criteria": ["Recorded"],
            },
            {
                "id": "optional",
                "kind": "agent_task",
                "label": "Optional",
                "objective": "Best effort",
                "deliverable": "Optional output",
                "acceptance_criteria": ["Recorded"],
                "required": False,
            },
            {"id": "end", "kind": "end", "label": "End"},
        ],
        "edges": [
            {"id": "e1", "source": "trigger", "target": "required"},
            {"id": "e2", "source": "trigger", "target": "optional"},
            {"id": "e3", "source": "required", "target": "end"},
            {"id": "e4", "source": "optional", "target": "end"},
        ],
    }
    parallel_snapshot = store.create("owner", parallel)
    store.publish(parallel_snapshot.workflow_id, "owner", 1, 1)
    parallel_run = runtime.create_run(parallel_snapshot.workflow_id, 1, "session-2").run
    assert set(parallel_run.run_state.current_nodes) == {"required", "optional"}
    failed = runtime.report_node_result(
        parallel_run.run_id,
        "required",
        "session-2",
        parallel_run.version,
        "failed",
        "required failed",
    )
    assert failed.status == "failed"
    assert failed.nodes["optional"].status is NodeStatus.SKIPPED
    assert failed.nodes["end"].status is NodeStatus.SKIPPED
    with pytest.raises(WorkflowExecutorError):
        runtime.report_node_result(
            failed.run_id,
            "optional",
            "session-2",
            failed.version,
            "done",
            "must not execute",
        )


def test_compiler_and_executor_reject_unbounded_result_values(tmp_path) -> None:
    store = WorkflowStore(tmp_path / "workflows")
    snapshot = store.create("owner", workflow_raw())
    store.publish(snapshot.workflow_id, "owner", 1, 1)
    runtime = WorkflowRuntimeService(store, GraphRunStore(tmp_path / "graph-runs"), owner_scope="owner")
    with pytest.raises(ValueError, match="nesting"):
        compile_workflow_run(snapshot, "session", inputs={"deep": [[[[[[[[[[[[[[0]]]]]]]]]]]]]]})

    run = runtime.create_run(snapshot.workflow_id, 1, "session").run
    with pytest.raises(WorkflowExecutorError, match="non-finite"):
        runtime.report_node_result(run.run_id, "task", "session", run.version, "done", float("nan"))
    with pytest.raises(WorkflowExecutorError, match="exceeds"):
        runtime.report_node_result(run.run_id, "task", "session", run.version, "done", "x" * (2 * 1024 * 1024 + 1))


def test_runtime_strips_nested_sensitive_inputs_and_executor_evidence(tmp_path) -> None:
    store = WorkflowStore(tmp_path / "workflows")
    snapshot = store.create("owner", workflow_raw())
    store.publish(snapshot.workflow_id, "owner", 1, 1)
    runtime = WorkflowRuntimeService(store, GraphRunStore(tmp_path / "graph-runs"), owner_scope="owner")
    run = runtime.create_run(
        snapshot.workflow_id,
        1,
        "session",
        inputs={
            "safe": {"request": "keep"},
            "nested": {
                "Authorization": "Bearer secret",
                "Cookie": "sid=secret",
                "Authentication": "Bearer secret",
                "authentication_header": "Bearer secret",
                "auth": "secret",
                "author": "release owner",
                "authority": "release editor",
            },
        },
    ).run
    assert run.meta["inputs"] == {
        "safe": {"request": "keep"},
        "nested": {"author": "release owner", "authority": "release editor"},
    }

    output = {
        "safe": {"result": "ok"},
        "nested": {
            "authorization": "secret",
            "Set-Cookie": "secret",
            "Authentication": "secret",
            "authentication_header": "secret",
            "auth": "secret",
            "author": "release owner",
            "authority": "release editor",
        },
    }
    evidence = {
        "safe": ["recorded"],
        "nested": {
            "COOKIE": "secret",
            "authentication": "secret",
            "authentication_header": "secret",
            "author": "release owner",
            "authority": "release editor",
        },
    }
    updated = runtime.report_node_result(
        run.run_id,
        "task",
        "session",
        run.version,
        "done",
        output,
        evidence,
    )
    persisted = updated.nodes["task"].meta
    assert persisted["workflow_output_summary"] == {
        "safe": {"result": "ok"},
        "nested": {"author": "release owner", "authority": "release editor"},
    }
    assert persisted["workflow_evidence"] == {
        "safe": ["recorded"],
        "nested": {"author": "release owner", "authority": "release editor"},
    }


def test_optional_decision_failure_fails_run_before_end_completion(tmp_path) -> None:
    raw = deepcopy(workflow_raw())
    raw["nodes"][3]["required"] = False
    store = WorkflowStore(tmp_path / "workflows")
    snapshot = store.create("owner", raw)
    store.publish(snapshot.workflow_id, "owner", 1, 1)
    runtime = WorkflowRuntimeService(store, GraphRunStore(tmp_path / "graph-runs"), owner_scope="owner")
    run = runtime.create_run(snapshot.workflow_id, 1, "session").run
    for node_id in ("task", "action"):
        run = runtime.report_node_result(run.run_id, node_id, "session", run.version, "done", "ok")
    failed = runtime.report_node_result(run.run_id, "decision", "session", run.version, "failed", "decision failed")
    assert failed.status == "failed"
    assert failed.nodes["decision"].status is NodeStatus.FAILED
    assert failed.nodes["review"].status is NodeStatus.SKIPPED
    assert failed.nodes["end"].status is NodeStatus.SKIPPED
    assert failed.run_state.current_nodes == []


def test_corrupt_publication_digest_invalidates_bound_run(tmp_path) -> None:
    store = WorkflowStore(tmp_path / "workflows")
    snapshot = store.create("owner", workflow_raw())
    store.publish(snapshot.workflow_id, "owner", 1, 1)
    graph = GraphRunStore(tmp_path / "graph-runs")
    runtime = WorkflowRuntimeService(store, graph, owner_scope="owner")
    run = runtime.create_run(snapshot.workflow_id, 1, "session").run
    with sqlite3.connect(store.db_path) as conn:
        conn.execute(
            "UPDATE workflow_publications SET digest = ? WHERE workflow_id = ? AND revision = 1",
            ("0" * 64, snapshot.workflow_id),
        )
    with pytest.raises(WorkflowRunConflict, match="bound workflow revision is unavailable"):
        runtime.get_run(run.run_id, "session", owner_scope="owner")
