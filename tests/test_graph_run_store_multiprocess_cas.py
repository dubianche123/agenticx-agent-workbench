from __future__ import annotations

import multiprocessing
from pathlib import Path
from typing import Any

from agenticx.runtime.graph.models import GraphNode, GraphRun, NodeKind, RunState
from agenticx.runtime.graph.store import GraphRunStore, GraphRunVersionConflict


def _run_for_writer(run_id: str, writer: str, *, version: int) -> GraphRun:
    return GraphRun(
        run_id=run_id,
        session_id="session-cas-multiprocess",
        group_id="group-cas-multiprocess",
        nodes={
            "task": GraphNode(
                id="task",
                kind=NodeKind.TASK,
                label="CAS task",
                task_text=f"payload from {writer}",
                meta={"writer": writer},
            )
        },
        edges=[],
        run_state=RunState(current_nodes=["task"], branch={"writer": writer}),
        status=f"written-by-{writer}",
        version=version,
        meta={"writer": writer, "payload": [writer, "complete"]},
    )


def _save_in_process(
    root: str,
    expected_version: int,
    writer: str,
    barrier: Any,
    results: Any,
) -> None:
    store = GraphRunStore(Path(root))
    run = _run_for_writer("run-cas-multiprocess", writer, version=expected_version)
    try:
        barrier.wait(timeout=15)
        saved = store.save(run, expected_version=expected_version)
    except GraphRunVersionConflict as exc:
        results.put(
            {
                "kind": "conflict",
                "writer": writer,
                "expected": exc.expected,
                "actual": exc.actual,
            }
        )
    except BaseException as exc:  # pragma: no cover - surfaced by parent assertion
        results.put({"kind": "error", "writer": writer, "error": repr(exc)})
    else:
        results.put(
            {
                "kind": "saved",
                "writer": writer,
                "version": saved.version,
                "payload": saved.to_dict(),
            }
        )


def test_independent_processes_compare_and_swap_one_winner(tmp_path: Path) -> None:
    root = tmp_path / "graph-runs"
    store = GraphRunStore(root)
    initial = _run_for_writer("run-cas-multiprocess", "initial", version=0)
    store.save(initial)
    expected_version = initial.version

    context = multiprocessing.get_context("spawn")
    barrier = context.Barrier(2)
    results = context.Queue()
    processes = [
        context.Process(
            target=_save_in_process,
            args=(str(root), expected_version, writer, barrier, results),
        )
        for writer in ("left", "right")
    ]
    for process in processes:
        process.start()
    for process in processes:
        process.join(timeout=20)
    for process in processes:
        if process.is_alive():
            process.terminate()
            process.join(timeout=5)
        assert process.exitcode == 0

    outcomes = [results.get(timeout=5) for _ in processes]
    assert {outcome["kind"] for outcome in outcomes} == {"saved", "conflict"}
    winner = next(outcome for outcome in outcomes if outcome["kind"] == "saved")
    conflict = next(outcome for outcome in outcomes if outcome["kind"] == "conflict")
    assert conflict["expected"] == expected_version
    assert conflict["actual"] == expected_version + 1
    assert winner["version"] == expected_version + 1

    persisted = GraphRunStore(root).load("run-cas-multiprocess")
    assert persisted is not None
    assert persisted.to_dict() == winner["payload"]
