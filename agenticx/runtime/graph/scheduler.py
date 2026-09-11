#!/usr/bin/env python3
"""DAG scheduler for GraphRun task nodes (AgentRuntime execution layer).

Author: Damon Li
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, AsyncIterator, Awaitable, Callable, Dict, List, Optional

from agenticx.runtime.graph.models import GraphNode, GraphRun, NodeStatus
from agenticx.runtime.graph.store import GraphRunStore, get_default_store

_log = logging.getLogger(__name__)

NodeRunner = Callable[[GraphNode], AsyncIterator[Any]]
EventHook = Callable[[str, Dict[str, Any]], None]
ShouldStop = Callable[[], Any]

_SENTINEL = object()
_NON_EXECUTABLE_RUN_STATUSES = frozenset(
    {"closed", "finalizing", "stopped", "cancelled"}
)


def _run_is_non_executable(run: GraphRun) -> bool:
    return str(getattr(run, "status", "") or "").strip().lower() in (
        _NON_EXECUTABLE_RUN_STATUSES
    )


async def _should_stop(should_stop: Optional[ShouldStop]) -> bool:
    if should_stop is None:
        return False
    try:
        result = should_stop()
        if asyncio.iscoroutine(result) or isinstance(result, Awaitable):
            return bool(await result)  # type: ignore[misc]
        return bool(result)
    except Exception:
        return False


def _ready_nodes(run: GraphRun) -> List[GraphNode]:
    ready: List[GraphNode] = []
    for node in run.nodes.values():
        if node.status in (NodeStatus.PENDING, NodeStatus.READY):
            if run.deps_satisfied(node.id):
                node.status = NodeStatus.READY
                ready.append(node)
    return ready


async def execute_group_run(
    run: GraphRun,
    *,
    runner: NodeRunner,
    on_event: Optional[EventHook] = None,
    store: Optional[GraphRunStore] = None,
    max_parallel: int = 4,
    should_stop: Optional[ShouldStop] = None,
    pause_poll_seconds: float = 0.05,
    completion_status: str = "closed",
) -> AsyncIterator[Any]:
    """Execute READY task nodes in parallel waves respecting depends edges.

    Yields runner items as they arrive (merged across concurrent nodes).
    """
    store = store or get_default_store()
    max_parallel = max(1, int(max_parallel))
    completion_status = str(completion_status or "closed").strip().lower()
    if completion_status not in {"closed", "finalizing"}:
        raise ValueError("completion_status must be 'closed' or 'finalizing'")
    store.save(run, bump_version=True)
    if on_event:
        on_event(
            "graph.run_created",
            {
                "run_id": run.run_id,
                "session_id": run.session_id,
                "group_id": run.group_id,
                "version": run.version,
                "node_ids": list(run.nodes.keys()),
            },
        )

    def _close_for_stop() -> None:
        """Make an interrupt a complete terminal graph decision."""
        run.status = "closed"
        for node in run.nodes.values():
            if node.status not in {
                NodeStatus.DONE,
                NodeStatus.FAILED,
                NodeStatus.CANCELLED,
                NodeStatus.SKIPPED,
            }:
                node.status = NodeStatus.CANCELLED
        run.run_state.current_nodes = []
        store.save(run, bump_version=True)
        if on_event:
            for node in run.nodes.values():
                on_event(
                    "graph.node_updated",
                    {
                        "run_id": run.run_id,
                        "node": node.to_dict(),
                        "version": run.version,
                    },
                )
            on_event(
                "graph.run_status",
                {
                    "run_id": run.run_id,
                    "status": run.status,
                    "version": run.version,
                },
            )

    async def _run_one(node: GraphNode, out: "asyncio.Queue[Any]") -> None:
        # READY nodes are selected before their worker task gets CPU time. A
        # Team control action can skip/cancel one in that short window; the
        # terminal decision must win and the runner must never start.
        if _run_is_non_executable(run):
            await out.put(_SENTINEL)
            return
        if node.status not in (NodeStatus.PENDING, NodeStatus.READY):
            await out.put(_SENTINEL)
            return
        if await _should_stop(should_stop):
            if node.status not in (
                NodeStatus.DONE,
                NodeStatus.FAILED,
                NodeStatus.CANCELLED,
                NodeStatus.SKIPPED,
            ):
                node.status = NodeStatus.CANCELLED
            await out.put(_SENTINEL)
            return
        # There is no await between this final admission check and RUNNING, so
        # run termination or skip can no longer interleave inside the
        # transition itself.
        if _run_is_non_executable(run):
            await out.put(_SENTINEL)
            return
        if node.status not in (NodeStatus.PENDING, NodeStatus.READY):
            await out.put(_SENTINEL)
            return
        node.status = NodeStatus.RUNNING
        if node.id not in run.run_state.current_nodes:
            run.run_state.current_nodes.append(node.id)
        if on_event:
            on_event(
                "graph.node_updated",
                {"run_id": run.run_id, "node": node.to_dict(), "version": run.version},
            )
        try:
            async for item in runner(node):
                await out.put(item)
            # A concurrent Team control action may already have moved this
            # node to a terminal state (notably STOP -> CANCELLED).  Do not
            # overwrite that authoritative decision when a runner unwinds.
            if node.status == NodeStatus.RUNNING:
                node.status = NodeStatus.DONE
        except asyncio.CancelledError:
            node.status = NodeStatus.CANCELLED
            raise
        except Exception as exc:
            _log.warning("Graph node %s failed: %s", node.id, exc)
            # STOP/CANCELLED is an authoritative control decision. A runner
            # may raise while unwinding after that decision; do not replace it
            # with FAILED (or overwrite any other terminal decision).
            if node.status not in {
                NodeStatus.DONE,
                NodeStatus.FAILED,
                NodeStatus.CANCELLED,
                NodeStatus.SKIPPED,
            }:
                node.status = NodeStatus.FAILED
                node.meta["error"] = str(exc)[:500]
        finally:
            if node.id in run.run_state.current_nodes:
                run.run_state.current_nodes = [
                    x for x in run.run_state.current_nodes if x != node.id
                ]
            store.save(run, bump_version=True)
            if on_event:
                on_event(
                    "graph.node_updated",
                    {"run_id": run.run_id, "node": node.to_dict(), "version": run.version},
                )
            await out.put(_SENTINEL)

    while not run.is_finished():
        if await _should_stop(should_stop):
            _close_for_stop()
            break

        if _run_is_non_executable(run):
            break

        if run.status == "paused":
            await asyncio.sleep(pause_poll_seconds)
            fresh = store.load(run.run_id)
            if fresh is not None:
                run.status = fresh.status
            continue

        ready = _ready_nodes(run)
        batch = ready[:max_parallel]
        if not batch:
            if any(n.status == NodeStatus.RUNNING for n in run.nodes.values()):
                await asyncio.sleep(pause_poll_seconds)
                continue
            break

        queue: asyncio.Queue[Any] = asyncio.Queue()
        workers = [asyncio.create_task(_run_one(n, queue)) for n in batch]
        remaining = len(workers)
        try:
            while remaining > 0:
                if await _should_stop(should_stop):
                    for t in workers:
                        t.cancel()
                    break
                try:
                    item = await asyncio.wait_for(
                        queue.get(),
                        timeout=pause_poll_seconds,
                    )
                except asyncio.TimeoutError:
                    # Re-check STOP while a model/tool call is quiet instead
                    # of waiting indefinitely for its next output token.
                    continue
                if item is _SENTINEL:
                    remaining -= 1
                    continue
                yield item
        finally:
            for t in workers:
                if not t.done():
                    t.cancel()
            await asyncio.gather(*workers, return_exceptions=True)

        if await _should_stop(should_stop):
            _close_for_stop()
            break

    # A Team owner can reserve a final-delivery phase after the DAG.  If the
    # user paused while the last node was in flight, wait for RESUME before
    # entering that phase; otherwise the final leader call would start behind
    # a visible pause. Standalone scheduler callers keep the legacy closed
    # completion semantics.
    while run.status == "paused" and completion_status == "finalizing":
        if await _should_stop(should_stop):
            _close_for_stop()
            break
        await asyncio.sleep(pause_poll_seconds)
        fresh = store.load(run.run_id)
        if fresh is not None and fresh.status != "paused":
            run.status = fresh.status

    if run.status in {"open", "paused"}:
        run.status = completion_status
        store.save(run, bump_version=True)
        if on_event:
            on_event(
                "graph.run_status",
                {"run_id": run.run_id, "status": run.status, "version": run.version},
            )
