#!/usr/bin/env python3
"""Measure Workflow persistence allocations in isolated temporary stores.

Every fixture is created below :mod:`tempfile` and uses explicit store roots;
the benchmark never reads or writes ``AGX_HOME``.  ``tracemalloc`` reports the
Python allocations retained by each returned result and the peak temporary
allocation during that operation.  ``ru_maxrss`` is process wide, so it is
reported as context rather than as a per-operation measurement.

Examples::

    .venv/bin/python scripts/benchmark_workflow_resources.py
    .venv/bin/python scripts/benchmark_workflow_resources.py --revisions 200 --runs 500
"""

from __future__ import annotations

import argparse
import gc
import json
import platform
import resource
import tempfile
import time
import tracemalloc
from pathlib import Path
from typing import Any, Callable

from agenticx.runtime.graph.store import GraphRunStore
from agenticx.runtime.workflow.approval import ApprovalRequest, ApprovalStore
from agenticx.runtime.workflow.store import WorkflowStore


def _max_rss_mib() -> float:
    raw = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    # Darwin reports bytes while Linux reports KiB.
    return raw / (2**20 if platform.system() == "Darwin" else 1024)


def _measure(label: str, operation: Callable[[], Any]) -> dict[str, Any]:
    gc.collect()
    tracemalloc.start()
    started = time.perf_counter()
    value = operation()
    elapsed = time.perf_counter() - started
    current, peak = tracemalloc.get_traced_memory()
    tracemalloc.stop()
    if isinstance(value, (list, tuple, set, dict)):
        result_count = len(value)
    else:
        result_count = None
    # Keep the reported current allocation tied to the operation's result,
    # then release it before the next measurement.
    del value
    return {
        "operation": label,
        "result_count": result_count,
        "elapsed_s": round(elapsed, 6),
        "tracemalloc_current_mib": round(current / 2**20, 6),
        "tracemalloc_peak_mib": round(peak / 2**20, 6),
        "rss_max_mib": round(_max_rss_mib(), 3),
    }


def _workflow_draft(title: str) -> dict[str, Any]:
    return {
        "title": title,
        "description": "Benchmark fixture",
        "objective": "Measure durable Workflow reads",
        "completion_criteria": ["the fixture is recorded"],
        "nodes": [
            {"id": "trigger", "kind": "trigger", "label": "Start"},
            {
                "id": "task",
                "kind": "agent_task",
                "label": "Task",
                "objective": "Record fixture",
                "deliverable": "Fixture",
                "acceptance_criteria": ["Recorded"],
            },
            {"id": "end", "kind": "end", "label": "End"},
        ],
        "edges": [
            {"id": "e1", "source": "trigger", "target": "task"},
            {"id": "e2", "source": "task", "target": "end"},
        ],
    }


def _prepare_workflow(root: Path, revisions: int) -> tuple[WorkflowStore, str]:
    store = WorkflowStore(root)
    first = store.create("benchmark-owner", _workflow_draft("Revision 1"))
    current = first
    for revision in range(2, revisions + 1):
        current = store.append_revision(
            first.workflow_id,
            "benchmark-owner",
            revision - 1,
            _workflow_draft(f"Revision {revision}"),
        )
    return store, current.workflow_id


def _benchmark_workflow(root: Path, revisions: int) -> list[dict[str, Any]]:
    store, workflow_id = _prepare_workflow(root, revisions)
    owner = "benchmark-owner"
    publish_result = _measure(
        "workflow.publish_sequence",
        lambda: [store.publish(workflow_id, owner, revision, revisions) for revision in range(1, revisions + 1)],
    )
    strict_result = _measure(
        "workflow.list_manifests_strict",
        lambda: store.list_manifests(owner),
    )
    revisions_result = _measure(
        "workflow.list_revisions",
        lambda: store.list_revisions(workflow_id, owner),
    )
    return [publish_result, strict_result, revisions_result]


def _graph_run_payload(run_id: str, session_id: str, blob_bytes: int) -> dict[str, Any]:
    return {
        "run_id": run_id,
        "session_id": session_id,
        "group_id": None,
        "nodes": {},
        "edges": [],
        "run_state": {"current_nodes": [], "branch": {}},
        "artifacts": [],
        "evidence": [],
        "memory_pointers": [],
        "status": "open",
        "version": 1,
        "meta": {"benchmark_blob": "x" * blob_bytes},
    }


def _write_graph_runs(root: Path, count: int, blob_bytes: int) -> None:
    session_id = "benchmark-session"
    root.mkdir(parents=True, exist_ok=True)
    for index in range(count):
        run_dir = root / f"gr_{index:06d}"
        run_dir.mkdir()
        payload = _graph_run_payload(run_dir.name, session_id, blob_bytes)
        (run_dir / "run.json").write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")


def _metadata_graph_scan(root: Path, session_id: str) -> list[dict[str, Any]]:
    """Non-production reference scanner retaining only list summary fields."""

    found: list[dict[str, Any]] = []
    for child in sorted(root.iterdir()):
        path = child / "run.json"
        if not child.is_dir() or not path.is_file():
            continue
        raw = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(raw, dict) or str(raw.get("session_id") or "") != session_id:
            continue
        found.append(
            {
                "run_id": str(raw.get("run_id") or ""),
                "session_id": str(raw.get("session_id") or ""),
                "group_id": raw.get("group_id"),
                "status": str(raw.get("status") or "open"),
                "version": int(raw.get("version") or 1),
                "node_count": len(raw.get("nodes") or {}) if isinstance(raw.get("nodes"), dict) else 0,
                "edge_count": len(raw.get("edges") or []) if isinstance(raw.get("edges"), list) else 0,
            }
        )
    return found


def _benchmark_graph(root: Path, runs: int, blob_bytes: int) -> list[dict[str, Any]]:
    _write_graph_runs(root, runs, blob_bytes)
    session_id = "benchmark-session"
    store = GraphRunStore(root)
    return [
        _measure("graph.list_by_session_full_runs", lambda: store.list_by_session(session_id)),
        _measure(
            "graph.metadata_scan_reference_nonprod",
            lambda: _metadata_graph_scan(root, session_id),
        ),
    ]


def _approval_request(index: int, summary: str) -> ApprovalRequest:
    request = ApprovalRequest(
        approval_id=f"approval_{index}",
        workflow_id="wf_benchmark",
        workflow_revision=1,
        workflow_digest="d" * 64,
        run_id="gr_benchmark",
        graph_run_version_at_request=1,
        gate_node_id=f"gate_{index}",
        downstream_node_id=f"downstream_{index}",
        session_id="benchmark-session",
        requester_principal="benchmark-owner",
        acting_agent_id="",
        approver_policy_kind="any",
        summary=summary,
        target_action_description=summary,
        requested_at="2026-09-11T00:00:00Z",
        expires_at="2099-09-11T00:00:00Z",
    )
    request.intent_digest = request.calculated_intent_digest()
    return request


def _benchmark_approvals(root: Path, approvals: int, summary_bytes: int) -> dict[str, Any]:
    store = WorkflowStore(root)
    approval_store = ApprovalStore(workflow_store=store)
    summary = "s" * summary_bytes
    for index in range(approvals):
        approval_store.create(_approval_request(index, summary))
    return _measure(
        "approval.list_for_run",
        lambda: approval_store.list_for_run("gr_benchmark", session_id="benchmark-session"),
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--revisions", type=int, default=50)
    parser.add_argument("--runs", type=int, default=200)
    parser.add_argument("--run-blob-bytes", type=int, default=64 * 1024)
    parser.add_argument("--approvals", type=int, default=100)
    parser.add_argument("--approval-summary-bytes", type=int, default=16 * 1024)
    args = parser.parse_args()
    if args.revisions < 1:
        parser.error("revisions must be positive")
    for name in ("runs", "run_blob_bytes", "approvals", "approval_summary_bytes"):
        if getattr(args, name) < 0:
            parser.error(f"{name} must be non-negative")

    with tempfile.TemporaryDirectory(prefix="agx-workflow-resource-bench-") as root_raw:
        root = Path(root_raw)
        results = _benchmark_workflow(root / "workflow", args.revisions)
        results.extend(_benchmark_graph(root / "graph", args.runs, args.run_blob_bytes))
        results.append(_benchmark_approvals(root / "approvals", args.approvals, args.approval_summary_bytes))
        print(
            json.dumps(
                {
                    "fixture_root": str(root),
                    "parameters": vars(args),
                    "python": platform.python_version(),
                    "platform": platform.platform(),
                    "results": results,
                },
                indent=2,
                sort_keys=True,
            )
        )


if __name__ == "__main__":
    main()
