#!/usr/bin/env python3
"""Smoke tests for Graph DAG scheduler: deps block + parallel ready set.

Author: Damon Li
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any, AsyncIterator, List

import pytest

from agenticx.runtime.graph.compiler import compile_workforce_run
from agenticx.runtime.graph.models import GraphNode, NodeStatus
from agenticx.runtime.graph.scheduler import execute_group_run
from agenticx.runtime.graph.store import GraphRunStore


@pytest.mark.asyncio
async def test_dependency_blocks_until_done(tmp_path: Path) -> None:
    store = GraphRunStore(root=tmp_path)
    run = compile_workforce_run(
        session_id="s",
        group_id="g",
        subtasks=[
            {"id": "t1", "description": "first", "dependencies": []},
            {"id": "t2", "description": "second", "dependencies": ["t1"]},
        ],
        assignment_map={"t1": "a", "t2": "b"},
        run_id="gr_dep",
    )
    order: List[str] = []
    running_while_t1: List[str] = []

    async def runner(node: GraphNode) -> AsyncIterator[str]:
        order.append(f"start:{node.id}")
        if node.id == "t1":
            # t2 must not be RUNNING while t1 runs
            for n in run.nodes.values():
                if n.id != "t1":
                    running_while_t1.append(f"{n.id}:{n.status.value}")
            await asyncio.sleep(0.05)
        order.append(f"end:{node.id}")
        yield node.id

    events: List[str] = []

    def on_event(etype: str, data: dict) -> None:
        events.append(etype)

    out: List[Any] = []
    async for item in execute_group_run(
        run,
        runner=runner,
        on_event=on_event,
        store=store,
        max_parallel=4,
    ):
        out.append(item)

    assert out == ["t1", "t2"]
    assert order == ["start:t1", "end:t1", "start:t2", "end:t2"]
    assert all(not s.startswith("t2:running") for s in running_while_t1)
    assert run.nodes["t1"].status == NodeStatus.DONE
    assert run.nodes["t2"].status == NodeStatus.DONE
    assert "graph.run_created" in events
    assert "graph.node_updated" in events


@pytest.mark.asyncio
async def test_independent_nodes_run_in_parallel(tmp_path: Path) -> None:
    store = GraphRunStore(root=tmp_path)
    run = compile_workforce_run(
        session_id="s",
        group_id="g",
        subtasks=[
            {"id": "t1", "description": "a", "dependencies": []},
            {"id": "t2", "description": "b", "dependencies": []},
        ],
        assignment_map={"t1": "a", "t2": "b"},
        run_id="gr_par",
    )
    started = asyncio.Event()
    both_running = asyncio.Event()
    gate = asyncio.Event()
    seen_running: set[str] = set()

    async def runner(node: GraphNode) -> AsyncIterator[str]:
        seen_running.add(node.id)
        if len(seen_running) >= 2:
            both_running.set()
        started.set()
        await gate.wait()
        yield node.id

    async def release() -> None:
        await started.wait()
        await asyncio.sleep(0.02)
        # If sequential, both_running would never set before gate
        assert both_running.is_set(), "expected overlapping RUNNING nodes"
        gate.set()

    releaser = asyncio.create_task(release())
    out: List[str] = []
    async for item in execute_group_run(
        run,
        runner=runner,
        store=store,
        max_parallel=4,
    ):
        out.append(str(item))
    await releaser
    assert set(out) == {"t1", "t2"}
    assert run.nodes["t1"].status == NodeStatus.DONE
    assert run.nodes["t2"].status == NodeStatus.DONE


@pytest.mark.asyncio
async def test_single_node_lifecycle(tmp_path: Path) -> None:
    store = GraphRunStore(root=tmp_path)
    run = compile_workforce_run(
        session_id="s",
        group_id=None,
        subtasks=[{"id": "t1", "description": "solo"}],
        assignment_map={"t1": "x"},
        run_id="gr_one",
    )
    statuses: List[str] = []

    def on_event(etype: str, data: dict) -> None:
        if etype == "graph.node_updated":
            statuses.append(str(data["node"]["status"]))

    async def runner(node: GraphNode) -> AsyncIterator[str]:
        yield "ok"

    async for _ in execute_group_run(run, runner=runner, on_event=on_event, store=store):
        pass
    assert "running" in statuses
    assert statuses[-1] == "done"
    assert run.status == "closed"


@pytest.mark.asyncio
async def test_skipped_dependency_unblocks_downstream(tmp_path: Path) -> None:
    store = GraphRunStore(root=tmp_path)
    run = compile_workforce_run(
        session_id="s",
        group_id="g",
        subtasks=[
            {"id": "optional", "description": "optional"},
            {
                "id": "delivery",
                "description": "delivery",
                "dependencies": ["optional"],
            },
        ],
        assignment_map={"optional": "a", "delivery": "b"},
        run_id="gr_skip_dependency",
    )
    run.nodes["optional"].status = NodeStatus.SKIPPED

    async def runner(node: GraphNode) -> AsyncIterator[str]:
        yield node.id

    output: List[str] = []
    async for item in execute_group_run(run, runner=runner, store=store):
        output.append(item)

    assert output == ["delivery"]
    assert run.nodes["delivery"].status == NodeStatus.DONE


@pytest.mark.asyncio
async def test_external_stop_cancels_every_unfinished_node(tmp_path: Path) -> None:
    store = GraphRunStore(root=tmp_path)
    run = compile_workforce_run(
        session_id="s",
        group_id="g",
        subtasks=[
            {"id": "ready", "description": "ready"},
            {"id": "blocked", "description": "blocked", "dependencies": ["ready"]},
        ],
        assignment_map={"ready": "a", "blocked": "b"},
        run_id="gr_external_stop",
    )
    events: List[tuple[str, dict[str, Any]]] = []

    async def runner(node: GraphNode) -> AsyncIterator[str]:
        yield node.id

    output = [
        item
        async for item in execute_group_run(
            run,
            runner=runner,
            store=store,
            should_stop=lambda: True,
            on_event=lambda event_type, data: events.append((event_type, data)),
        )
    ]

    assert output == []
    assert run.status == "closed"
    assert {node.status for node in run.nodes.values()} == {NodeStatus.CANCELLED}
    assert run.run_state.current_nodes == []
    assert events[-1][0] == "graph.run_status"
    assert events[-1][1]["status"] == "closed"


@pytest.mark.asyncio
async def test_last_inflight_completion_closes_a_paused_run(tmp_path: Path) -> None:
    store = GraphRunStore(root=tmp_path)
    run = compile_workforce_run(
        session_id="s",
        group_id="g",
        subtasks=[{"id": "last", "description": "last"}],
        assignment_map={"last": "a"},
        run_id="gr_pause_last",
    )

    async def runner(node: GraphNode) -> AsyncIterator[str]:
        run.status = "paused"
        yield node.id

    output = [
        item
        async for item in execute_group_run(run, runner=runner, store=store)
    ]

    assert output == ["last"]
    assert run.nodes["last"].status == NodeStatus.DONE
    assert run.status == "closed"


@pytest.mark.asyncio
async def test_team_completion_waits_for_resume_before_finalizing(tmp_path: Path) -> None:
    store = GraphRunStore(root=tmp_path)
    run = compile_workforce_run(
        session_id="s",
        group_id="g",
        subtasks=[{"id": "last", "description": "last"}],
        assignment_map={"last": "a"},
        run_id="gr_pause_before_finalizing",
    )
    run.nodes["last"].status = NodeStatus.DONE
    run.status = "paused"

    async def runner(node: GraphNode) -> AsyncIterator[str]:
        yield node.id

    async def resume() -> None:
        await asyncio.sleep(0.02)
        run.status = "open"

    resume_task = asyncio.create_task(resume())
    output = [
        item
        async for item in execute_group_run(
            run,
            runner=runner,
            store=store,
            pause_poll_seconds=0.005,
            completion_status="finalizing",
        )
    ]
    await resume_task

    assert output == []
    assert run.status == "finalizing"


@pytest.mark.asyncio
@pytest.mark.parametrize("terminal_status", [NodeStatus.SKIPPED, NodeStatus.CANCELLED])
async def test_terminal_control_wins_before_runner_admission(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    terminal_status: NodeStatus,
) -> None:
    store = GraphRunStore(root=tmp_path)
    run = compile_workforce_run(
        session_id="s",
        group_id="g",
        subtasks=[{"id": "controlled", "description": "controlled"}],
        assignment_map={"controlled": "a"},
        run_id=f"gr_admission_{terminal_status.value}",
    )
    node = run.nodes["controlled"]
    runner_calls: List[str] = []
    real_create_task = asyncio.create_task

    def control_before_start(coro):
        node.status = terminal_status
        return real_create_task(coro)

    monkeypatch.setattr(asyncio, "create_task", control_before_start)

    async def runner(candidate: GraphNode) -> AsyncIterator[str]:
        runner_calls.append(candidate.id)
        yield candidate.id

    output = [
        item
        async for item in execute_group_run(run, runner=runner, store=store)
    ]

    assert output == []
    assert runner_calls == []
    assert node.status is terminal_status


@pytest.mark.asyncio
async def test_cancelled_node_wins_over_late_runner_error(tmp_path: Path) -> None:
    """A STOP decision must survive an ordinary runner exception."""
    store = GraphRunStore(root=tmp_path)
    run = compile_workforce_run(
        session_id="s",
        group_id="g",
        subtasks=[{"id": "controlled", "description": "controlled"}],
        assignment_map={"controlled": "a"},
        run_id="gr_cancelled_runner_error",
    )
    node = run.nodes["controlled"]
    entered = asyncio.Event()
    release = asyncio.Event()

    async def runner(candidate: GraphNode) -> AsyncIterator[str]:
        entered.set()
        await release.wait()
        raise RuntimeError("late runner failure")
        yield candidate.id

    async def stop_before_runner_unwinds() -> None:
        await entered.wait()
        run.status = "closed"
        node.status = NodeStatus.CANCELLED
        release.set()

    stopper = asyncio.create_task(stop_before_runner_unwinds())
    output = [
        item
        async for item in execute_group_run(run, runner=runner, store=store)
    ]
    await stopper

    assert output == []
    assert run.status == "closed"
    assert node.status == NodeStatus.CANCELLED
    persisted = store.load(run.run_id)
    assert persisted is not None
    assert persisted.nodes[node.id].status == NodeStatus.CANCELLED


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "terminal_status", ["closed", "finalizing", "stopped", "cancelled"]
)
async def test_terminal_run_status_wins_before_runner_admission(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    terminal_status: str,
) -> None:
    """A run becoming terminal after selection must not start its READY node."""
    store = GraphRunStore(root=tmp_path)
    run = compile_workforce_run(
        session_id="s",
        group_id="g",
        subtasks=[{"id": "controlled", "description": "controlled"}],
        assignment_map={"controlled": "a"},
        run_id=f"gr_terminal_run_{terminal_status}",
    )
    node = run.nodes["controlled"]
    runner_calls: List[str] = []
    real_create_task = asyncio.create_task

    def terminal_before_start(coro):
        run.status = terminal_status
        return real_create_task(coro)

    monkeypatch.setattr(asyncio, "create_task", terminal_before_start)

    async def runner(candidate: GraphNode) -> AsyncIterator[str]:
        runner_calls.append(candidate.id)
        yield candidate.id

    output = [
        item
        async for item in execute_group_run(run, runner=runner, store=store)
    ]

    assert output == []
    assert runner_calls == []
    assert run.status == terminal_status
    assert node.status == NodeStatus.READY
