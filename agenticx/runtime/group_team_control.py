"""Async control plane for a graph-backed Team run."""
from __future__ import annotations

import asyncio
import inspect
import logging
from collections.abc import Awaitable, Callable, Mapping
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Optional, Union
from uuid import uuid4

from agenticx.collaboration.task_lock import Action, ActionData, TaskLock
from agenticx.collaboration.workforce.events import (
    WorkforceAction,
    WorkforceEvent,
    WorkforceEventBus,
)
from agenticx.runtime.graph.models import GraphNode, GraphRun, NodeStatus

_log = logging.getLogger(__name__)
_SUPPORTED = frozenset(
    {Action.PAUSE, Action.RESUME, Action.STOP, Action.ADD_TASK, Action.SKIP_TASK}
)
_TERMINAL = frozenset(
    {
        NodeStatus.DONE.value,
        NodeStatus.FAILED.value,
        NodeStatus.CANCELLED.value,
        NodeStatus.SKIPPED.value,
    }
)
_TERMINAL_GRAPH_STATUSES = frozenset(
    {"closed", "finalizing", "cancelled", "done", "failed", "stopped"}
)

class CheckpointStatus(str, Enum):
    CONTINUE = "continue"
    STOPPED = "stopped"
    SKIPPED = "skipped"
    CLOSED = "closed"

    def __bool__(self) -> bool:
        return self is CheckpointStatus.CONTINUE

class UnknownTeamActionError(ValueError):
    pass

class TeamControlRejected(ValueError):
    pass

AddTaskCallback = Callable[[dict[str, Any]], Union[Any, Awaitable[Any]]]

class GroupTeamController:
    """Consume Team actions and coordinate graph admission/terminal state."""
    def __init__(
        self,
        task_lock: TaskLock,
        event_bus: Optional[WorkforceEventBus] = None,
        add_task_callback: Optional[AddTaskCallback] = None,
        *,
        graph_run: Optional[GraphRun] = None,
        max_tasks: int = 100,
        inject_task: Optional[AddTaskCallback] = None,
    ) -> None:
        if not hasattr(task_lock, "queue") or not hasattr(task_lock, "get_queue"):
            raise TypeError("task_lock must provide queue and get_queue()")
        callbacks = [cb for cb in (add_task_callback, inject_task) if cb is not None]
        if len(callbacks) > 1 and callbacks[0] is not callbacks[1]:
            raise ValueError("provide only one ADD_TASK callback")
        try:
            max_tasks = int(max_tasks)
        except (TypeError, ValueError) as exc:
            raise ValueError("max_tasks must be non-negative") from exc
        if max_tasks < 0:
            raise ValueError("max_tasks must be non-negative")
        self.task_lock = task_lock
        self.event_bus = event_bus or WorkforceEventBus()
        self._add_task_callback = callbacks[0] if callbacks else None
        self.max_tasks = max_tasks
        self.graph_run: Optional[GraphRun] = None
        self.paused = False
        self.stopped = False
        self.closed = False
        self.skipped: set[str] = set()
        self.pending_add_tasks: list[ActionData] = []
        self.control_audit: list[dict[str, Any]] = []
        self._base_task_count = 0
        self._accepted_add_count = 0
        self._state = asyncio.Condition()
        self._add_lock = asyncio.Lock()
        self._listener_task: Optional[asyncio.Task[None]] = None
        self._listener_error: Optional[BaseException] = None
        self._listener_error_reported = False
        # The scope id distinguishes controls for successive GraphRuns that
        # happen to share one session.  Keep it stable for pre-bind actions so
        # they can be backfilled when the first run is bound.
        self._group_team_control_scope_id = uuid4().hex
        if graph_run is not None:
            self._set_graph(graph_run)
    @property
    def listener_task(self) -> Optional[asyncio.Task[None]]:
        return self._listener_task
    @property
    def listener_error(self) -> Optional[BaseException]:
        return self._listener_error
    @property
    def should_stop(self) -> bool:
        return self.stopped or self.closed
    @property
    def task_count(self) -> int:
        nodes = getattr(self.graph_run, "nodes", None)
        graph_count = len(nodes) if isinstance(nodes, Mapping) else 0
        return max(self._base_task_count + self._accepted_add_count, graph_count)
    async def start(self) -> "GroupTeamController":
        if self.closed:
            raise RuntimeError("team controller is closed")
        if self._listener_error is not None:
            raise self._listener_error
        if self._listener_task is None:
            self._listener_task = asyncio.create_task(
                self._listen(),
                name=f"group-team-control:{getattr(self.task_lock, 'id', 'unknown')}",
            )
            self._listener_task.add_done_callback(self._capture_listener_result)
        if self.graph_run is not None and self._add_task_callback is not None:
            await self._flush_pending()
        return self
    async def close(self) -> None:
        async with self._state:
            already_closed = self.closed
            self.closed = True
            self._state.notify_all()
        listener = self._listener_task
        if listener is not None and not listener.done():
            listener.cancel()
            await asyncio.gather(listener, return_exceptions=True)
        error = self._listener_error
        if error is not None and not already_closed and not self._listener_error_reported:
            self._listener_error_reported = True
            raise error
    async def handle_action(self, action_data: ActionData) -> Action:
        action = self._normalize_action(getattr(action_data, "action", None))
        raw_data = getattr(action_data, "data", {})
        if not isinstance(raw_data, Mapping):
            raise TypeError("ActionData.data must be a mapping")
        data = dict(raw_data)
        if action is Action.PAUSE:
            await self._pause(data)
        elif action is Action.RESUME:
            await self._resume(data)
        elif action is Action.STOP:
            await self._stop(data)
        elif action is Action.ADD_TASK:
            await self._add_task(action_data, data)
        elif action is Action.SKIP_TASK:
            await self._skip_task(data)
        return action
    async def bind_graph(
        self,
        graph_run: GraphRun,
        inject_task: Optional[AddTaskCallback] = None,
    ) -> "GroupTeamController":
        if inject_task is not None:
            if self._add_task_callback is not None and self._add_task_callback is not inject_task:
                raise ValueError("provide only one ADD_TASK callback")
            self._add_task_callback = inject_task
        async with self._state:
            if self.closed:
                raise RuntimeError("team controller is closed")
            self._set_graph(graph_run)
        await self._flush_pending()
        if self.control_audit:
            self._persist_graph_run()
        return self

    def record_control_audit(self, entry: Mapping[str, Any]) -> dict[str, Any]:
        """Attach one durable control record to this exact runtime.

        A controller may accept PAUSE before decomposition has produced a
        GraphRun. Once the graph binds, backfill those early records with its
        run id so one graph never inherits another turn's audit history.
        """
        record = dict(entry)
        record.setdefault("control_scope_id", self._group_team_control_scope_id)
        run_id = str(getattr(self.graph_run, "run_id", "") or "").strip()
        if run_id:
            for existing in self.control_audit:
                if (
                    not str(existing.get("run_id") or "").strip()
                    and str(existing.get("control_scope_id") or "")
                    == str(record.get("control_scope_id") or "")
                ):
                    existing["run_id"] = run_id
        record["run_id"] = run_id
        self.control_audit.append(record)
        self.control_audit = self.control_audit[-100:]
        self._sync_control_audit_to_graph()
        return record
    async def checkpoint(self, task_id: Optional[str] = None) -> CheckpointStatus:
        task_id = str(task_id or "").strip() or None
        async with self._state:
            while True:
                if self.stopped:
                    return CheckpointStatus.STOPPED
                if task_id and task_id in self.skipped:
                    node = self._graph_node(task_id)
                    if (
                        node is None
                        or self._can_skip(node)
                        or self._status(node) == NodeStatus.SKIPPED.value
                    ):
                        return CheckpointStatus.SKIPPED
                    self.skipped.discard(task_id)
                if self.closed:
                    return CheckpointStatus.CLOSED
                run_status = str(
                    getattr(self.graph_run, "status", "") or ""
                ).strip().lower()
                if run_status in _TERMINAL_GRAPH_STATUSES:
                    return CheckpointStatus.CLOSED
                if not self.paused:
                    return CheckpointStatus.CONTINUE
                if task_id and self._in_flight(task_id):
                    return CheckpointStatus.CONTINUE
                await self._state.wait()
    async def _listen(self) -> None:
        while not self.closed and not self.stopped:
            action_data = await self.task_lock.get_queue()
            if action_data is None:
                continue
            try:
                action = await self.handle_action(action_data)
            except TeamControlRejected as exc:
                self.record_control_audit(
                    self._listener_audit_entry(
                        action_data,
                        status="rejected",
                        detail=str(exc),
                    )
                )
                self._persist_graph_run()
                raw_data = getattr(action_data, "data", {})
                self._publish(
                    WorkforceAction.TASK_FAILED,
                    task_id=self._task_id(raw_data) if isinstance(raw_data, Mapping) else None,
                    data={
                        "control": "rejected",
                        "action": str(
                            getattr(
                                getattr(action_data, "action", None),
                                "value",
                                getattr(action_data, "action", ""),
                            )
                        ),
                        "error": str(exc),
                    },
                )
                continue
            except UnknownTeamActionError as exc:
                # Unknown actions are rejected controls, not a reason to let
                # the production TaskLock consumer die silently.  Keep the
                # queue alive so a later valid STOP/RESUME/Pause still works.
                self.record_control_audit(
                    self._listener_audit_entry(
                        action_data,
                        status="rejected",
                        detail=str(exc),
                    )
                )
                self._persist_graph_run()
                self._publish(
                    WorkforceAction.TASK_FAILED,
                    task_id=self._task_id(
                        getattr(action_data, "data", {})
                    ),
                    data={
                        "control": "rejected",
                        "action": str(
                            getattr(
                                getattr(action_data, "action", None),
                                "value",
                                getattr(action_data, "action", ""),
                            )
                        ),
                        "error": str(exc),
                    },
                )
                continue
            self.record_control_audit(
                self._listener_audit_entry(action_data, status="accepted")
            )
            self._persist_graph_run()
            if action is Action.STOP:
                return

    def _listener_audit_entry(
        self,
        action_data: ActionData,
        *,
        status: str,
        detail: str = "",
    ) -> dict[str, Any]:
        raw_action = getattr(action_data, "action", "")
        action = str(getattr(raw_action, "value", raw_action) or "").strip()
        raw_data = getattr(action_data, "data", {})
        data = dict(raw_data) if isinstance(raw_data, Mapping) else {}
        timestamp = getattr(action_data, "timestamp", None)
        at = (
            timestamp.isoformat()
            if hasattr(timestamp, "isoformat")
            else datetime.now(timezone.utc).isoformat()
        )
        run = self.graph_run
        return {
            "at": at,
            "group_id": str(getattr(run, "group_id", "") or "").strip(),
            "session_id": str(getattr(run, "session_id", "") or "").strip(),
            "action": action,
            "status": str(status or "").strip() or "unknown",
            "task_id": self._task_id(data) or "",
            "task_description": str(data.get("task_description") or "")[:500],
            "detail": str(detail or "")[:500],
            "control_scope_id": self._group_team_control_scope_id,
            "source": "task_lock_listener",
        }

    def _persist_graph_run(self) -> bool:
        """Persist the current graph snapshot, including its control audit.

        GraphRunStore.save is atomic and fsyncs the replacement file. The
        listener keeps consuming actions when the local persistence backend is
        temporarily unavailable; the failure is logged rather than silently
        dropping the in-memory audit record or killing the control task.
        """
        run = self.graph_run
        if run is None:
            return True
        try:
            from agenticx.runtime.graph.store import get_default_store

            get_default_store().save(run, bump_version=True)
            return True
        except Exception as exc:
            _log.error(
                "failed to persist Team control audit run=%s: %s",
                str(getattr(run, "run_id", "") or ""),
                exc,
            )
            return False

    def _ensure_control_allowed(self, action: Action) -> None:
        """Reject non-STOP controls once the bound GraphRun is terminal."""
        run_status = str(getattr(self.graph_run, "status", "") or "").strip().lower()
        if run_status in _TERMINAL_GRAPH_STATUSES:
            raise TeamControlRejected(
                f"cannot {action.value} while GraphRun is {run_status}"
            )
        if self.closed:
            raise TeamControlRejected(
                f"cannot {action.value} after Team control closed"
            )
        if self.stopped:
            raise TeamControlRejected(
                f"cannot {action.value} after Team control stopped"
            )

    def _capture_listener_result(self, task: asyncio.Task[None]) -> None:
        if task.cancelled():
            return
        error = task.exception()
        if error is not None:
            self._listener_error = error
            _log.error("group Team control listener failed: %s", error)
    async def _pause(self, data: Mapping[str, Any]) -> None:
        async with self._state:
            self._ensure_control_allowed(Action.PAUSE)
            self.paused = True
            self._mirror_graph()
            self._state.notify_all()
        self._persist_graph_run()
        self._publish(
            WorkforceAction.WORKFORCE_PAUSED,
            data={**dict(data), "control": "pause", "paused": True},
        )
    async def _resume(self, data: Mapping[str, Any]) -> None:
        async with self._state:
            self._ensure_control_allowed(Action.RESUME)
            self.paused = False
            self._mirror_graph()
            self._state.notify_all()
        self._persist_graph_run()
        self._publish(
            WorkforceAction.WORKFORCE_RESUMED,
            data={**dict(data), "control": "resume", "paused": False},
        )
    async def _stop(self, data: Mapping[str, Any]) -> None:
        publish = False
        async with self._state:
            if not self.closed and not self.stopped:
                self.stopped = True
                self.paused = False
                self._mirror_graph()
                publish = True
            self._state.notify_all()
        if publish:
            self._persist_graph_run()
            self._publish(
                WorkforceAction.WORKFORCE_STOPPED,
                data={**dict(data), "control": "stop", "stopped": True},
            )
    async def _skip_task(self, data: Mapping[str, Any]) -> None:
        task_id = self._task_id(data)
        if not task_id:
            raise TeamControlRejected("SKIP_TASK requires data.task_id")
        async with self._state:
            self._ensure_control_allowed(Action.SKIP_TASK)
            node = self._graph_node(task_id)
            if node is not None and not self._can_skip(node):
                raise TeamControlRejected(
                    f"cannot skip task {task_id!r} in status {self._status(node)!r}"
                )
            self.skipped.add(task_id)
            self._mirror_graph(skipped_task_id=task_id)
            self._state.notify_all()
        self._persist_graph_run()
        self._publish(
            WorkforceAction.TASK_SKIPPED,
            task_id=task_id,
            data={
                **dict(data),
                "control": "skip_task",
                "task_id": task_id,
                "skipped": True,
            },
        )
    async def _add_task(self, action_data: ActionData, data: dict[str, Any]) -> None:
        async with self._add_lock:
            async with self._state:
                self._ensure_add_allowed()
                if self.task_count >= self.max_tasks:
                    raise TeamControlRejected(
                        f"Team task limit reached ({self.max_tasks})"
                    )
                self._accepted_add_count += 1
                if self.graph_run is None or self._add_task_callback is None:
                    self.pending_add_tasks.append(action_data)
                    self._state.notify_all()
                    return
                self._state.notify_all()
            try:
                await self._inject(data)
            except BaseException:
                async with self._state:
                    self._accepted_add_count = max(0, self._accepted_add_count - 1)
                    self._state.notify_all()
                raise
    def _ensure_add_allowed(self) -> None:
        if self.should_stop:
            raise TeamControlRejected("cannot add after Team control stopped/closed")
        status = str(getattr(self.graph_run, "status", "") or "").strip().lower()
        if status in _TERMINAL_GRAPH_STATUSES:
            raise TeamControlRejected(f"cannot add while GraphRun is {status or 'terminal'}")
    async def _inject(self, data: dict[str, Any]) -> None:
        callback = self._add_task_callback
        if callback is None:
            raise RuntimeError("ADD_TASK callback is not bound")
        run = self.graph_run
        nodes_before = self._graph_node_ids(run)

        # The admission check is intentionally brief.  Holding the condition
        # while awaiting a user/runtime callback would starve STOP and prevent
        # the terminal transition from winning the race.
        async with self._state:
            self._ensure_add_allowed()
        result = callback(dict(data))
        if inspect.isawaitable(result):
            result = await result

        # The callback may have awaited while STOP or GraphRun finalization
        # happened.  Re-check before committing its result and remove any new
        # graph nodes it inserted during the stale callback window.
        async with self._state:
            try:
                self._ensure_add_allowed()
            except TeamControlRejected:
                self._rollback_injected_nodes(run, nodes_before)
                raise
            if self.graph_run is not run:
                self._rollback_injected_nodes(run, nodes_before)
                raise TeamControlRejected("GraphRun changed while adding task")
            assigned_id = self._assignment_id(result) or self._task_id(data)
            node = (
                result.get("node")
                if isinstance(result, Mapping)
                else result
            ) or self._graph_node(assigned_id)
            if assigned_id in self.skipped and node is not None and not self._can_skip(node):
                self.skipped.discard(assigned_id)
                self._rollback_injected_nodes(run, nodes_before)
                raise TeamControlRejected(
                    f"cannot skip task {assigned_id!r} in status {self._status(node)!r}"
                )
            nodes = getattr(self.graph_run, "nodes", None)
            if isinstance(node, GraphNode) and isinstance(nodes, dict):
                nodes.setdefault(node.id, node)
            if assigned_id in self.skipped:
                self._mirror_graph(skipped_task_id=assigned_id)
        event_data = {**dict(data), "control": "add_task", "assigned": True}
        if assigned_id:
            event_data["task_id"] = assigned_id
        result_agent_id = (
            str(result.get("agent_id") or "").strip()
            if isinstance(result, Mapping)
            else ""
        )
        assigned_agent_id = result_agent_id or next(
            (
                str(data[key]).strip()
                for key in ("agent_id", "assignee", "worker_id")
                if str(data.get(key) or "").strip()
            ),
            "",
        )
        if assigned_agent_id:
            event_data["assignee"] = assigned_agent_id
        self._persist_graph_run()
        self._publish(
            WorkforceAction.TASK_ASSIGNED,
            task_id=assigned_id,
            agent_id=assigned_agent_id or None,
            data=event_data,
        )
    async def _flush_pending(self) -> None:
        async with self._add_lock:
            if self.graph_run is None or self._add_task_callback is None or self.should_stop:
                return
            while self.pending_add_tasks:
                action_data = self.pending_add_tasks[0]
                raw_data = getattr(action_data, "data", {})
                data = dict(raw_data) if isinstance(raw_data, Mapping) else {}
                async with self._state:
                    self._ensure_add_allowed()
                await self._inject(data)
                self.pending_add_tasks.pop(0)
    def _set_graph(self, graph_run: GraphRun) -> None:
        previous_run_id = str(getattr(self.graph_run, "run_id", "") or "").strip()
        next_run_id = str(getattr(graph_run, "run_id", "") or "").strip()
        if previous_run_id and next_run_id and previous_run_id != next_run_id:
            # A controller can be rebound by recovery code. New controls need
            # a distinct scope, while prior records remain retained for their
            # original run and are filtered out of the new graph metadata.
            self._group_team_control_scope_id = uuid4().hex
        if self.graph_run is None:
            nodes = getattr(graph_run, "nodes", None)
            self._base_task_count = len(nodes) if isinstance(nodes, Mapping) else 0
            if str(getattr(graph_run, "status", "") or "").strip().lower() == "paused":
                self.paused = True
        self.graph_run = graph_run
        run_id = str(getattr(graph_run, "run_id", "") or "").strip()
        if run_id:
            for entry in self.control_audit:
                if (
                    not str(entry.get("run_id") or "").strip()
                    and str(entry.get("control_scope_id") or "")
                    == self._group_team_control_scope_id
                ):
                    entry["run_id"] = run_id
        self._mirror_graph()
        self._sync_control_audit_to_graph()

    def _sync_control_audit_to_graph(self) -> None:
        run = self.graph_run
        meta = getattr(run, "meta", None) if run is not None else None
        if isinstance(meta, dict):
            run_id = str(getattr(run, "run_id", "") or "").strip()
            meta["team_control_audit"] = [
                dict(entry) for entry in self.control_audit
                if not run_id
                or str(entry.get("run_id") or "").strip() == run_id
            ]

    @staticmethod
    def _graph_node_ids(run: Optional[GraphRun]) -> set[str]:
        nodes = getattr(run, "nodes", None) if run is not None else None
        return {str(node_id) for node_id in nodes} if isinstance(nodes, Mapping) else set()

    @staticmethod
    def _rollback_injected_nodes(run: Optional[GraphRun], before: set[str]) -> None:
        nodes = getattr(run, "nodes", None) if run is not None else None
        if not isinstance(nodes, dict):
            return
        for node_id in tuple(nodes):
            if str(node_id) not in before:
                nodes.pop(node_id, None)

    def _mirror_graph(self, *, skipped_task_id: Optional[str] = None) -> None:
        run = self.graph_run
        if run is None:
            return
        if self.stopped:
            run.status = "closed"
            nodes = getattr(run, "nodes", None)
            if isinstance(nodes, Mapping):
                for node in nodes.values():
                    if self._status(node) not in _TERMINAL:
                        node.status = NodeStatus.CANCELLED
        elif self.paused:
            run.status = "paused"
        elif getattr(run, "status", None) == "paused":
            run.status = "open"
        nodes = getattr(run, "nodes", None)
        if isinstance(nodes, Mapping):
            ids = [skipped_task_id] if skipped_task_id else list(self.skipped)
            for task_id in ids:
                node = nodes.get(task_id)
                if node is None:
                    continue
                status = self._status(node)
                if status == NodeStatus.SKIPPED.value:
                    continue
                if status in _TERMINAL:
                    self.skipped.discard(task_id)
                elif self._can_skip(node):
                    node.status = NodeStatus.SKIPPED
                else:
                    self.skipped.discard(task_id)
        meta = getattr(run, "meta", None)
        if isinstance(meta, dict):
            meta["team_control"] = {
                "paused": self.paused,
                "stopped": self.stopped,
                "skipped_tasks": sorted(self.skipped),
            }
    def _graph_node(self, task_id: Optional[str]) -> Any:
        nodes = getattr(self.graph_run, "nodes", None) if self.graph_run else None
        return nodes.get(task_id) if task_id and isinstance(nodes, Mapping) else None
    def _in_flight(self, task_id: str) -> bool:
        node = self._graph_node(task_id)
        if node is not None and self._status(node) == NodeStatus.RUNNING.value:
            return True
        state = getattr(self.graph_run, "run_state", None)
        current = getattr(state, "current_nodes", None)
        return isinstance(current, (list, tuple, set)) and task_id in current
    @staticmethod
    def _status(node: Any) -> str:
        raw = getattr(node, "status", "")
        return str(getattr(raw, "value", raw) or "").strip().lower()
    @staticmethod
    def _can_skip(node: Any) -> bool:
        return GroupTeamController._status(node) in {
            NodeStatus.PENDING.value,
            NodeStatus.READY.value,
            NodeStatus.PAUSED.value,
        }
    @staticmethod
    def _normalize_action(raw: Any) -> Action:
        candidate = getattr(raw, "value", raw)
        try:
            action = candidate if isinstance(candidate, Action) else Action(str(candidate))
        except (TypeError, ValueError) as exc:
            raise UnknownTeamActionError(f"unknown Team action: {candidate!r}") from exc
        if action not in _SUPPORTED:
            raise UnknownTeamActionError(f"unsupported Team action: {action.value!r}")
        return action
    @staticmethod
    def _task_id(data: Any) -> Optional[str]:
        if not isinstance(data, Mapping):
            return None
        for key in ("task_id", "id", "task"):
            value = data.get(key)
            if isinstance(value, Mapping):
                value = value.get("task_id") or value.get("id")
            value = str(value or "").strip()
            if value:
                return value
        return None
    @staticmethod
    def _assignment_id(result: Any) -> Optional[str]:
        if isinstance(result, Mapping):
            nested = result.get("node")
            if nested is not None:
                result = nested
            else:
                for key in ("task_id", "id", "assigned_task_id"):
                    value = str(result.get(key) or "").strip()
                    if value:
                        return value
                return None
        if isinstance(result, str):
            return result.strip() or None
        value = str(getattr(result, "id", "") or "").strip()
        return value or None
    def _publish(
        self,
        action: WorkforceAction,
        *,
        data: Mapping[str, Any],
        task_id: Optional[str] = None,
        agent_id: Optional[str] = None,
    ) -> WorkforceEvent:
        event = WorkforceEvent(
            action=action,
            data=dict(data),
            task_id=task_id,
            agent_id=agent_id,
        )
        self.event_bus.publish(event)
        return event

__all__ = [
    "AddTaskCallback",
    "CheckpointStatus",
    "GroupTeamController",
    "TeamControlRejected",
    "UnknownTeamActionError",
]
