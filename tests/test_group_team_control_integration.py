"""End-to-end runtime tests for Team controls against the live DAG scheduler."""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import AsyncIterator

import pytest

from agenticx.collaboration.task_lock import Action, ActionData, TaskLock
from agenticx.runtime.graph.compiler import compile_workforce_run
from agenticx.runtime.graph.models import GraphNode, NodeKind, NodeStatus
from agenticx.runtime.graph.scheduler import execute_group_run
from agenticx.runtime.graph.store import GraphRunStore
from agenticx.runtime.group_team_control import GroupTeamController


@pytest.mark.asyncio
async def test_pause_add_resume_changes_the_live_schedule(tmp_path: Path) -> None:
    store = GraphRunStore(root=tmp_path)
    run = compile_workforce_run(
        session_id="session-live-control",
        group_id="group-live-control",
        subtasks=[{"id": "initial", "description": "initial"}],
        assignment_map={"initial": "member-a"},
        run_id="run-live-pause-add-resume",
    )
    controller = GroupTeamController(
        TaskLock("group::group-live-control::session-live-control"),
        graph_run=run,
    )
    initial_started = asyncio.Event()
    release_initial = asyncio.Event()
    started: list[str] = []
    output: list[str] = []

    async def inject(data: dict[str, object]) -> dict[str, object]:
        node = GraphNode(
            id="added",
            kind=NodeKind.TASK,
            label=str(data["task_description"]),
            status=NodeStatus.READY,
            agent_id="member-b",
            task_text=str(data["task_description"]),
        )
        run.nodes[node.id] = node
        store.save(run, bump_version=True)
        return {"node": node, "agent_id": "member-b"}

    await controller.bind_graph(run, inject_task=inject)

    async def runner(node: GraphNode) -> AsyncIterator[str]:
        started.append(node.id)
        if node.id == "initial":
            initial_started.set()
            await release_initial.wait()
        yield node.id

    async def collect() -> None:
        async for item in execute_group_run(
            run,
            runner=runner,
            store=store,
            max_parallel=1,
            should_stop=lambda: controller.should_stop,
            pause_poll_seconds=0.01,
        ):
            output.append(str(item))

    execution = asyncio.create_task(collect())
    await asyncio.wait_for(initial_started.wait(), timeout=1)
    await controller.handle_action(
        ActionData(
            action=Action.ADD_TASK,
            data={"task_description": "added while running"},
        )
    )
    await controller.handle_action(ActionData(action=Action.PAUSE, data={}))
    store.save(run, bump_version=True)
    release_initial.set()

    for _ in range(100):
        if run.nodes["initial"].status is NodeStatus.DONE:
            break
        await asyncio.sleep(0.01)
    await asyncio.sleep(0.05)
    assert started == ["initial"]
    assert run.status == "paused"

    await controller.handle_action(ActionData(action=Action.RESUME, data={}))
    store.save(run, bump_version=True)
    await asyncio.wait_for(execution, timeout=2)

    assert started == ["initial", "added"]
    assert output == ["initial", "added"]
    assert run.nodes["added"].status is NodeStatus.DONE
    await controller.close()


@pytest.mark.asyncio
async def test_stop_cancels_a_quiet_inflight_runner(tmp_path: Path) -> None:
    store = GraphRunStore(root=tmp_path)
    run = compile_workforce_run(
        session_id="session-live-stop",
        group_id="group-live-stop",
        subtasks=[{"id": "slow", "description": "slow"}],
        assignment_map={"slow": "member-a"},
        run_id="run-live-stop",
    )
    controller = GroupTeamController(
        TaskLock("group::group-live-stop::session-live-stop"),
        graph_run=run,
    )
    started = asyncio.Event()
    never = asyncio.Event()
    cancelled = asyncio.Event()

    async def runner(_node: GraphNode) -> AsyncIterator[str]:
        started.set()
        try:
            await never.wait()
            yield "should-not-publish"
        finally:
            cancelled.set()

    async def collect() -> list[str]:
        return [
            str(item)
            async for item in execute_group_run(
                run,
                runner=runner,
                store=store,
                should_stop=lambda: controller.should_stop,
                pause_poll_seconds=0.01,
            )
        ]

    execution = asyncio.create_task(collect())
    await asyncio.wait_for(started.wait(), timeout=1)
    await controller.handle_action(ActionData(action=Action.STOP, data={}))
    store.save(run, bump_version=True)

    assert await asyncio.wait_for(execution, timeout=1) == []
    await asyncio.wait_for(cancelled.wait(), timeout=1)
    assert run.status == "closed"
    assert run.nodes["slow"].status is NodeStatus.CANCELLED
    await controller.close()
