"""Durable Workflow runtime advancement over the existing GraphRun store.

This service is deliberately a small state machine.  It prepares structural
nodes and exposes explicit managed-executor result handoffs for semantic work;
it never invokes an LLM, connector CLI, or external API itself.
"""

from __future__ import annotations

import copy
import json
import math
import time
import uuid
from dataclasses import dataclass
from typing import Any, Callable, Dict, Iterable, Mapping, Optional

from agenticx.runtime.graph.models import EdgeKind, GraphRun, NodeStatus
from agenticx.runtime.graph.store import (
    GraphRunStore,
    GraphRunVersionConflict,
    get_default_store,
)

from .approval import (
    ApprovalConflict,
    ApprovalError,
    ApprovalExpired,
    ApprovalIntentMismatch,
    ApprovalNotFound,
    ApprovalPolicyUnsupported,
    ApprovalRequest,
    ApprovalService,
    ApprovalStatus,
    ApprovalStore,
)
from .compiler import bounded_json_value, compile_workflow_run
from .execution import WorkflowNodeClaim
from .models import WorkflowNodeKind, WorkflowSnapshot, canonical_digest
from .store import (
    WorkflowCorruptError,
    WorkflowNotFound,
    WorkflowOwnershipError,
    WorkflowStore,
    WorkflowVersionConflict,
)
from .validation import topological_sort


class WorkflowRuntimeError(RuntimeError):
    """Base class for typed runtime failures."""


class WorkflowRunNotFound(WorkflowRuntimeError):
    def __init__(self, run_id: str) -> None:
        self.run_id = str(run_id)
        super().__init__(f"workflow run {self.run_id!r} was not found")


class WorkflowRunOwnershipError(WorkflowRuntimeError):
    def __init__(self, run_id: str, session_id: str) -> None:
        self.run_id = str(run_id)
        self.session_id = str(session_id)
        super().__init__(f"workflow run {self.run_id!r} does not belong to the session")


class WorkflowRunConflict(WorkflowRuntimeError):
    def __init__(self, run_id: str, message: str = "workflow run state conflict") -> None:
        self.run_id = str(run_id)
        super().__init__(message)


class WorkflowRevisionNotPublished(WorkflowRuntimeError):
    def __init__(self, workflow_id: str, revision: Optional[int] = None) -> None:
        self.workflow_id = str(workflow_id)
        self.revision = revision
        super().__init__("workflow revision is not published")


class WorkflowExecutorError(WorkflowRuntimeError):
    def __init__(self, run_id: str, node_id: str, message: str) -> None:
        self.run_id = str(run_id)
        self.node_id = str(node_id)
        super().__init__(message)


class WorkflowClaimConflict(WorkflowRuntimeError):
    """Raised when a worker tries to claim or complete a stale attempt."""

    def __init__(self, run_id: str, node_id: str, message: str = "workflow node claim is stale") -> None:
        self.run_id = str(run_id)
        self.node_id = str(node_id)
        super().__init__(message)


class WorkflowRunCancelled(WorkflowRuntimeError):
    """Raised when a managed run has been cancelled by its owner."""

    def __init__(self, run_id: str) -> None:
        self.run_id = str(run_id)
        super().__init__(f"workflow run {self.run_id!r} has been cancelled")


@dataclass
class WorkflowRunCreation:
    """Return value for :meth:`WorkflowRuntimeService.create_run`.

    The object supports both attribute and mapping access.  This keeps the
    service pleasant for Python callers while the Studio route can serialize a
    stable JSON object without exposing a second runtime model.
    """

    run: GraphRun
    ready_node_ids: list[str]
    approvals: list[ApprovalRequest]

    def to_dict(self) -> Dict[str, Any]:
        return {
            "run": self.run.to_dict(),
            "ready_node_ids": list(self.ready_node_ids),
            "approvals": [approval.to_dict() for approval in self.approvals],
            "execution": workflow_execution_envelope(self.run),
        }

    def __getitem__(self, key: str) -> Any:
        if key == "run":
            return self.run
        if key == "ready_node_ids":
            return self.ready_node_ids
        if key == "approvals":
            return self.approvals
        raise KeyError(key)

    def __iter__(self):
        yield self.run
        yield self.ready_node_ids
        yield self.approvals


@dataclass
class WorkflowApprovalResult:
    request: ApprovalRequest
    run: GraphRun

    def to_dict(self) -> Dict[str, Any]:
        return {
            "approval": self.request.to_dict(),
            "run": self.run.to_dict(),
            "execution": workflow_execution_envelope(self.run),
        }

    def __getitem__(self, key: str) -> Any:
        if key in {"approval", "request"}:
            return self.request
        if key == "run":
            return self.run
        raise KeyError(key)


def _as_json_value(value: Any) -> Any:
    """Make result payloads bounded and deterministic for GraphRun storage."""

    return bounded_json_value(value, strip_sensitive=True)


def _epoch_seconds(value: Any = None) -> float:
    """Normalize test/runtime clocks without trusting renderer timestamps."""

    if value is None:
        return time.time()
    if isinstance(value, bool):
        raise ValueError("clock value must not be boolean")
    if isinstance(value, (int, float)):
        number = float(value)
        if not math.isfinite(number):
            raise ValueError("clock value must be finite")
        return number
    text = str(value or "").strip()
    if not text:
        return time.time()
    # Claims are persisted as epoch seconds.  Accepting ISO strings here keeps
    # deterministic unit tests and recovery tools convenient without exposing
    # a client supplied clock on the HTTP boundary.
    try:
        return float(text)
    except ValueError:
        pass
    from datetime import datetime

    parsed = text.replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(parsed)
    except ValueError as exc:
        raise ValueError("clock value must be epoch seconds or ISO timestamp") from exc
    if dt.tzinfo is None:
        from datetime import timezone

        dt = dt.replace(tzinfo=timezone.utc)
    return dt.timestamp()


def _claim_from_node(run: GraphRun, node: Any) -> Optional[WorkflowNodeClaim]:
    raw = node.meta.get("workflow_claim") if isinstance(node.meta, Mapping) else None
    if not isinstance(raw, Mapping):
        # Keep compatibility with early managed-executor snapshots that wrote
        # flat claim fields before the nested wire envelope was introduced.
        attempt_id = str(node.meta.get("workflow_attempt_id") or "").strip()
        owner = str(node.meta.get("workflow_claim_owner") or "").strip()
        fencing = node.meta.get("workflow_fencing_token")
        lease = node.meta.get("workflow_lease_expires_at")
        claimed = node.meta.get("workflow_claimed_at")
        if not attempt_id or not owner or fencing is None or lease is None:
            return None
        raw = {
            "attempt_id": attempt_id,
            "claim_owner": owner,
            "fencing_token": fencing,
            "lease_expires_at": lease,
            "claimed_at": claimed,
        }
    try:
        return WorkflowNodeClaim(
            run_id=run.run_id,
            node_id=node.id,
            attempt_id=str(raw.get("attempt_id") or "").strip(),
            claim_owner=str(raw.get("claim_owner") or raw.get("owner") or "").strip(),
            fencing_token=int(raw.get("fencing_token")),
            lease_expires_at=float(raw.get("lease_expires_at")),
            claimed_at=float(raw.get("claimed_at") or 0),
            run_version=int(raw.get("run_version") or run.version),
        )
    except (TypeError, ValueError):
        return None


def _execution_state(run: GraphRun) -> str:
    """Project durable graph statuses into the public Workflow run state."""

    if str(run.status or "") in {"failed"}:
        return "failed"
    if str(run.status or "") in {"closed", "completed"}:
        return "completed"
    if str(run.status or "") in {"cancelled", "canceled"}:
        return "cancelled"
    if any(node.status is NodeStatus.RUNNING for node in run.nodes.values()):
        return "running"
    if any(node.status is NodeStatus.BLOCKED for node in run.nodes.values()):
        return "blocked"
    if any(node.status is NodeStatus.READY for node in run.nodes.values()):
        return "queued"
    return "open"


def workflow_execution_envelope(run: GraphRun) -> Dict[str, Any]:
    """Build the bounded execution projection shared by API and Desktop."""

    claims: Dict[str, Any] = {}
    blocked: list[str] = []
    running: list[str] = []
    for node_id, node in run.nodes.items():
        claim = _claim_from_node(run, node)
        if claim is not None:
            claims[node_id] = claim.to_dict()
        if node.status is NodeStatus.RUNNING:
            running.append(node_id)
        if node.status is NodeStatus.BLOCKED or node.meta.get("workflow_blocked_reason"):
            blocked.append(node_id)
    return {
        "state": _execution_state(run),
        "run_id": run.run_id,
        "version": int(run.version),
        "active_node_ids": running,
        "blocked_node_ids": blocked,
        "claims": claims,
        "last_error": str(run.meta.get("workflow_last_error") or ""),
    }


class WorkflowRuntimeService:
    """Prepare, advance, and authorize Workflow GraphRuns."""

    def __init__(
        self,
        workflow_store: Optional[WorkflowStore] = None,
        graph_store: Optional[GraphRunStore] = None,
        approval_store: Optional[ApprovalStore] = None,
        approval_service: Optional[ApprovalService] = None,
        *,
        owner_scope: str | Callable[[], str] = "studio-local",
        requester_principal: Optional[str | Callable[[], str]] = None,
    ) -> None:
        self.workflow_store = workflow_store or WorkflowStore()
        self.graph_store = graph_store or get_default_store()
        self.approval_store = approval_store or ApprovalStore(workflow_store=self.workflow_store)
        self.owner_scope = owner_scope
        self.requester_principal = requester_principal or owner_scope
        self.approval_service = approval_service or ApprovalService(
            self.approval_store,
            graph_store=self.graph_store,
            workflow_store=self.workflow_store,
        )

    def _owner_scope(self, override: Optional[str] = None) -> str:
        value = override if override is not None else self.owner_scope
        if callable(value):
            value = value()
        text = str(value or "").strip()
        if not text:
            raise WorkflowOwnershipError("", "")
        return text

    def _principal(self, override: Optional[str] = None) -> str:
        value = override if override is not None else self.requester_principal
        if callable(value):
            value = value()
        return str(value or self._owner_scope()).strip()

    def _load_run(self, run_id: str, session_id: str) -> GraphRun:
        rid = str(run_id or "").strip()
        sid = str(session_id or "").strip()
        if not rid:
            raise WorkflowRunNotFound(rid)
        run = self.graph_store.load(rid)
        if run is None:
            raise WorkflowRunNotFound(rid)
        if not sid or run.session_id != sid:
            raise WorkflowRunOwnershipError(rid, sid)
        return run

    def _verify_binding(self, run: GraphRun, *, owner_scope: Optional[str] = None) -> WorkflowSnapshot:
        workflow_id = str(run.workflow_id or run.meta.get("workflow_id") or "").strip()
        revision = run.workflow_revision
        if revision is None:
            revision = run.meta.get("workflow_revision")
        digest = str(run.workflow_digest or run.meta.get("workflow_digest") or "").strip()
        if not workflow_id or revision is None or not digest:
            raise WorkflowRunConflict(run.run_id, "workflow run has no exact revision binding")
        owner = self._owner_scope(owner_scope)
        try:
            snapshot = self.workflow_store.load_revision(workflow_id, int(revision), owner)
        except (WorkflowNotFound, WorkflowOwnershipError, WorkflowCorruptError) as exc:
            raise WorkflowRunConflict(run.run_id, "bound workflow revision is unavailable") from exc
        if snapshot.digest != digest:
            raise WorkflowRunConflict(run.run_id, "bound workflow digest does not match")
        # Read the publication row for this exact revision again.  A boolean
        # existence check would allow a damaged publication digest to keep a
        # run alive even though its immutable snapshot binding is no longer
        # trustworthy.
        try:
            published_snapshot = self.workflow_store.load_published_revision(
                workflow_id,
                owner,
                revision=int(revision),
            )
        except (WorkflowNotFound, WorkflowOwnershipError, WorkflowCorruptError) as exc:
            raise WorkflowRunConflict(run.run_id, "bound workflow revision is unavailable") from exc
        if published_snapshot.digest != snapshot.digest or published_snapshot.digest != digest:
            raise WorkflowRunConflict(run.run_id, "published workflow digest does not match run binding")
        return snapshot

    @staticmethod
    def _workflow_kind(node: Any) -> str:
        return str(node.meta.get("workflow_node_kind") or "").strip()

    @staticmethod
    def _selected_route(node: Any) -> str:
        return str(
            node.meta.get("workflow_selected_route")
            or node.meta.get("selected_route")
            or ""
        ).strip()

    @staticmethod
    def _refresh_execution_metadata(run: GraphRun) -> bool:
        """Persist a small bounded execution projection in the GraphRun."""

        before = dict(run.meta.get("workflow_execution") or {})
        envelope = workflow_execution_envelope(run)
        projection = {
            "state": envelope["state"],
            "active_node_ids": list(envelope["active_node_ids"]),
            "blocked_node_ids": list(envelope["blocked_node_ids"]),
            "claims": dict(envelope["claims"]),
            # GraphRunStore bumps the enclosing snapshot exactly once after
            # this projection is prepared.  Record that durable next version
            # so a persisted execution envelope is self-consistent after the
            # CAS; API responses still derive their version dynamically.
            "version": int(run.version) + 1,
        }
        if str(run.meta.get("workflow_last_error") or ""):
            projection["last_error"] = str(run.meta["workflow_last_error"])[:4096]
        run.meta["workflow_execution"] = projection
        # GraphRunStore increments ``run.version`` during the enclosing CAS
        # save.  Version is projected dynamically by the API, so changing only
        # this pre-save value must never create a second save/pump cycle.
        before_compare = dict(before)
        after_compare = dict(projection)
        before_compare.pop("version", None)
        after_compare.pop("version", None)
        return before_compare != after_compare

    @staticmethod
    def _state_digest(run: GraphRun) -> str:
        """Serialize state for advancement change detection.

        The GraphRun store assigns the next version during CAS.  Excluding
        that projection-only field prevents an idle explicit resume from
        repeatedly bumping a run version forever.
        """

        payload = run.to_dict()
        meta = payload.get("meta")
        if isinstance(meta, Mapping):
            execution = meta.get("workflow_execution")
            if isinstance(execution, Mapping):
                execution_copy = dict(execution)
                execution_copy.pop("version", None)
                meta_copy = dict(meta)
                meta_copy["workflow_execution"] = execution_copy
                payload["meta"] = meta_copy
        return json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))

    @staticmethod
    def _prepare_approval_intents(run: GraphRun) -> bool:
        """Bind reachable approval rows to the current draft and artifact contract.

        Approval gates are structural nodes, but their authorization intent is
        only complete once the preceding analysis has produced its draft.  The
        projection is kept on the run snapshot so a crash/restart cannot create
        an approval for a different draft or output basename.  It contains a
        bounded excerpt plus a digest of the complete persisted node output;
        it never contains a path supplied by a renderer or reads a file.
        """

        changed = False
        for gate in run.nodes.values():
            if str(gate.meta.get("workflow_node_kind") or "") != WorkflowNodeKind.APPROVAL_GATE.value:
                continue
            if gate.status is not NodeStatus.BLOCKED:
                continue
            incoming = [
                edge
                for edge in run.edges
                if edge.kind is EdgeKind.DEPENDS and edge.target == gate.id
            ]
            draft_sources = [
                run.nodes.get(edge.source)
                for edge in incoming
                if run.nodes.get(edge.source) is not None
                and run.nodes[edge.source].status is NodeStatus.DONE
                and "workflow_output_summary" in run.nodes[edge.source].meta
            ]
            if not draft_sources:
                continue
            draft_node = draft_sources[-1]
            draft = draft_node.meta.get("workflow_output_summary")
            try:
                draft_digest = canonical_digest(draft)
                draft_json = bounded_json_value(draft, strip_sensitive=True)
            except (TypeError, ValueError, RecursionError, OverflowError):
                continue
            if isinstance(draft_json, str):
                draft_excerpt = draft_json[:4096]
            else:
                draft_excerpt = json.dumps(
                    draft_json,
                    ensure_ascii=False,
                    sort_keys=True,
                    separators=(",", ":"),
                )[:4096]
            downstream = [
                edge.target
                for edge in run.edges
                if edge.kind is EdgeKind.DEPENDS and edge.source == gate.id
            ]
            downstream_node = run.nodes.get(downstream[0]) if len(downstream) == 1 else None
            downstream_config = (
                downstream_node.meta.get("workflow_config")
                if downstream_node is not None
                and isinstance(downstream_node.meta.get("workflow_config"), Mapping)
                else {}
            )
            contract = downstream_config.get("artifact_contract") if isinstance(downstream_config, Mapping) else None
            contract_projection: Dict[str, Any] = {}
            if isinstance(contract, Mapping):
                for key in ("directory", "output_basename", "formats", "max_bytes_each", "provenance", "kind", "schema_version"):
                    if key in contract:
                        contract_projection[key] = contract[key]
            intent = {
                "draft_source_node_id": draft_node.id,
                "draft_digest": draft_digest,
                "draft_summary": draft_excerpt,
                "artifact_contract": contract_projection,
            }
            try:
                normalized = bounded_json_value(intent, strip_sensitive=True)
            except (TypeError, ValueError, RecursionError, OverflowError):
                continue
            if gate.meta.get("workflow_approval_intent") != normalized:
                gate.meta["workflow_approval_intent"] = normalized
                changed = True
        return changed

    @staticmethod
    def _edge_route(run: GraphRun, edge: Any) -> str:
        route = edge.meta.get("workflow_route") if isinstance(edge.meta, Mapping) else ""
        if route:
            return str(route).strip()
        source = run.nodes.get(edge.source)
        if source is not None and isinstance(source.meta, Mapping):
            if str(source.meta.get("workflow_node_kind") or "") == WorkflowNodeKind.DECISION.value:
                return str(edge.label or "").strip()
        return ""

    def _edge_state(self, run: GraphRun, edge: Any) -> str:
        """Return active, inactive, or unresolved for one dependency edge."""

        source = run.nodes.get(edge.source)
        if source is None:
            return "unresolved"
        source_kind = self._workflow_kind(source)
        if source_kind == WorkflowNodeKind.DECISION.value:
            if source.status not in {
                NodeStatus.DONE,
                NodeStatus.FAILED,
                NodeStatus.CANCELLED,
                NodeStatus.SKIPPED,
            }:
                return "unresolved"
            # A decision route is an execution fact only when the decision
            # completed successfully.  Failed/cancelled/skipped decisions do
            # not get to choose a branch, even if stale metadata contains a
            # route from a prior attempt.
            if source.status is not NodeStatus.DONE:
                return "inactive"
            selected = self._selected_route(source)
            if not selected:
                return "unresolved"
            return "active" if selected and self._edge_route(run, edge) == selected else "inactive"
        if source.status is NodeStatus.DONE:
            return "active"
        if source.status is NodeStatus.FAILED and not bool(source.meta.get("workflow_required", True)):
            # Optional work can produce a failure evidence record while still
            # resolving its dependency for a downstream summary/end node.
            return "active"
        if source.status in {NodeStatus.SKIPPED, NodeStatus.CANCELLED, NodeStatus.FAILED}:
            return "inactive"
        return "unresolved"

    @staticmethod
    def _set_status(node: Any, status: NodeStatus) -> bool:
        if node.status is status:
            return False
        node.status = status
        return True

    def _advance_in_place(self, run: GraphRun) -> bool:
        """Advance structural nodes and readiness until a fixed point."""

        before = self._state_digest(run)
        order = topological_sort(
            {
                "workflow_id": run.workflow_id or "wf_runtime",
                "revision": int(run.workflow_revision or 1),
                "title": "runtime",
                "description": "",
                "objective": "",
                "completion_criteria": [],
                "nodes": [
                    {
                        "id": node.id,
                        "kind": self._workflow_kind(node) or WorkflowNodeKind.AGENT_TASK.value,
                        "label": node.label or node.id,
                        "objective": "x",
                        "deliverable": "x",
                        "acceptance_criteria": ["x"],
                        "config": (
                            node.meta.get("workflow_config")
                            if isinstance(node.meta.get("workflow_config"), Mapping)
                            else {}
                        ),
                    }
                    for node in run.nodes.values()
                ],
                "edges": [
                    {
                        "id": edge.id,
                        "source": edge.source,
                        "target": edge.target,
                        "route": self._edge_route(run, edge),
                    }
                    for edge in run.edges
                ],
            }
        )
        # ``topological_sort`` above only needs a shape; GraphRun edges are
        # already compiled from a validated DAG.  Preserve any unusual order by
        # appending nodes that are absent defensively.
        order.extend(node_id for node_id in run.nodes if node_id not in order)

        # Fail before structural progression.  A required executable failure,
        # or any decision failure (decision nodes are never optional in their
        # effect), must not allow a later join/end to become DONE in the same
        # pass.  ``_force_fail_fast`` also repairs a previously persisted
        # successful structural node if a crash/retry reaches this path.
        required_failed = any(
            node.status is NodeStatus.FAILED
            and bool(node.meta.get("workflow_required", True))
            for node in run.nodes.values()
        )
        decision_failed = any(
            node.status is NodeStatus.FAILED
            and self._workflow_kind(node) == WorkflowNodeKind.DECISION.value
            for node in run.nodes.values()
        )
        if required_failed or decision_failed:
            self._force_fail_fast(
                run,
                reason="decision_failure" if decision_failed else "required_failure",
            )
            return before != self._state_digest(run)

        for _ in range(max(1, len(order) + 1)):
            progressed = False
            for node_id in order:
                node = run.nodes[node_id]
                kind = self._workflow_kind(node)
                incoming = [
                    edge
                    for edge in run.edges
                    if edge.kind is EdgeKind.DEPENDS and edge.target == node_id
                ]
                if kind == WorkflowNodeKind.TRIGGER.value:
                    progressed |= self._set_status(node, NodeStatus.DONE)
                    continue
                if not incoming:
                    # A valid Workflow cannot have a second root (validation
                    # requires every node to be reachable from its trigger),
                    # but fail closed if a corrupt run reaches this service.
                    continue
                if node.status in {
                    NodeStatus.DONE,
                    NodeStatus.FAILED,
                    NodeStatus.CANCELLED,
                    NodeStatus.SKIPPED,
                }:
                    continue
                states = [self._edge_state(run, edge) for edge in incoming]
                if any(state == "unresolved" for state in states):
                    # Compiler starts approval gates blocked, and they remain
                    # blocked while waiting for the upstream path.
                    if kind == WorkflowNodeKind.APPROVAL_GATE.value:
                        progressed |= self._set_status(node, NodeStatus.BLOCKED)
                    continue
                active = [edge for edge, state in zip(incoming, states) if state == "active"]
                if not active:
                    progressed |= self._set_status(node, NodeStatus.SKIPPED)
                    node.meta.setdefault("workflow_skip_reason", "inactive_dependency_path")
                    continue
                if kind == WorkflowNodeKind.JOIN.value:
                    progressed |= self._set_status(node, NodeStatus.DONE)
                    node.meta["workflow_structural"] = "join_auto_completed"
                elif kind == WorkflowNodeKind.END.value:
                    progressed |= self._set_status(node, NodeStatus.DONE)
                    node.meta["workflow_structural"] = "end_auto_completed"
                elif kind == WorkflowNodeKind.APPROVAL_GATE.value:
                    progressed |= self._set_status(node, NodeStatus.BLOCKED)
                elif node.status in {NodeStatus.PENDING, NodeStatus.BLOCKED}:
                    # An executable can be durably paused for a missing
                    # connector/authentication, confirmation, timeout, or
                    # uncertain external side effect.  Do not erase that
                    # operator-visible reason during a structural advance.
                    if node.status is NodeStatus.BLOCKED and node.meta.get("workflow_blocked_reason"):
                        continue
                    progressed |= self._set_status(node, NodeStatus.READY)
            if not progressed:
                break

        required_failed = any(
            node.status is NodeStatus.FAILED
            and bool(node.meta.get("workflow_required", True))
            for node in run.nodes.values()
        )
        decision_failed = any(
            node.status is NodeStatus.FAILED
            and self._workflow_kind(node) == WorkflowNodeKind.DECISION.value
            for node in run.nodes.values()
        )
        if required_failed or decision_failed:
            # Fail fast once a required executable has failed.  Any other
            # pending/ready work is cancelled from the scheduler's point of
            # view so a managed executor cannot claim new work from a failed
            # run.  The failed node itself remains FAILED as the evidence.
            self._force_fail_fast(
                run,
                reason="decision_failure" if decision_failed else "required_failure",
            )
        elif all(
            node.status
            in {NodeStatus.DONE, NodeStatus.FAILED, NodeStatus.CANCELLED, NodeStatus.SKIPPED}
            for node in run.nodes.values()
        ) and any(
            self._workflow_kind(node) == WorkflowNodeKind.END.value and node.status is NodeStatus.DONE
            for node in run.nodes.values()
        ):
            run.status = "closed"
        elif run.status not in {"failed", "closed", "completed", "cancelled", "canceled"}:
            run.status = "open"
        run.run_state.current_nodes = [
            node_id for node_id, node in run.nodes.items() if node.status is NodeStatus.READY
        ]
        self._prepare_approval_intents(run)
        self._refresh_execution_metadata(run)
        after = self._state_digest(run)
        return before != after

    def _save_after_advance(self, run: GraphRun) -> GraphRun:
        expected = int(run.version)
        working = GraphRun.from_dict(run.to_dict())
        changed = self._advance_in_place(working)
        if not changed:
            return run
        try:
            self.graph_store.save(working, bump_version=True, expected_version=expected)
        except GraphRunVersionConflict as exc:
            raise WorkflowRunConflict(run.run_id, f"graph run version conflict: expected {expected}, actual {exc.actual}") from exc
        return working

    def _reachable_approvals(
        self,
        run: GraphRun,
        *,
        requester_principal: Optional[str] = None,
        acting_agent_id: str = "",
    ) -> list[ApprovalRequest]:
        approvals: list[ApprovalRequest] = []
        if str(run.status or "") in {"failed", "closed", "completed", "cancelled", "canceled"}:
            # Terminal runs cannot acquire fresh approval capability.  Reads
            # repair the one open-run crash window only; a malformed terminal
            # graph must fail closed rather than creating new rows.
            return approvals
        principal = self._principal(requester_principal)
        for node in run.nodes.values():
            if self._workflow_kind(node) != WorkflowNodeKind.APPROVAL_GATE.value:
                continue
            if node.status is not NodeStatus.BLOCKED:
                continue
            incoming = [edge for edge in run.edges if edge.kind is EdgeKind.DEPENDS and edge.target == node.id]
            if any(self._edge_state(run, edge) != "active" for edge in incoming):
                continue
            request = self.approval_service.ensure_for_gate(
                run,
                node.id,
                requester_principal=principal,
                acting_agent_id=acting_agent_id,
            )
            approvals.append(request)
        return approvals

    def create_run(
        self,
        workflow_id: str,
        revision: Optional[int] = None,
        session_id: str = "",
        *,
        group_id: Optional[str] = None,
        inputs: Optional[Mapping[str, Any]] = None,
        run_id: Optional[str] = None,
        owner_scope: Optional[str] = None,
        requester_principal: Optional[str] = None,
        acting_agent_id: str = "",
    ) -> WorkflowRunCreation:
        owner = self._owner_scope(owner_scope)
        sid = str(session_id or "").strip()
        if not sid:
            raise WorkflowRunOwnershipError(str(workflow_id), sid)
        # Resolve the requested definition first so a missing workflow or
        # revision remains a 404.  Only an existing revision with no
        # publication is a publication-state conflict (409).
        if revision is not None:
            self.workflow_store.load_revision(str(workflow_id), revision, owner)
        else:
            self.workflow_store.load_head(str(workflow_id), owner)
        try:
            snapshot = self.workflow_store.load_published_revision(
                str(workflow_id), owner, revision=revision
            )
        except WorkflowNotFound as exc:
            raise WorkflowRevisionNotPublished(str(workflow_id), revision) from exc
        run = compile_workflow_run(
            snapshot,
            sid,
            group_id=group_id,
            inputs=inputs,
            run_id=run_id,
        )
        try:
            self.graph_store.save(run, bump_version=True, expected_version=0)
        except GraphRunVersionConflict as exc:
            raise WorkflowRunConflict(run.run_id, "run ID already exists") from exc
        persisted = self.graph_store.load(run.run_id)
        assert persisted is not None
        run = persisted
        run = self._save_after_advance(run)
        approvals = self._reachable_approvals(
            run,
            requester_principal=requester_principal,
            acting_agent_id=acting_agent_id,
        )
        return WorkflowRunCreation(
            run=run,
            ready_node_ids=[node_id for node_id, node in run.nodes.items() if node.status is NodeStatus.READY],
            approvals=approvals,
        )

    def get_run(
        self,
        run_id: str,
        session_id: str,
        *,
        owner_scope: Optional[str] = None,
        now: Optional[str] = None,
    ) -> GraphRun:
        run = self._load_run(run_id, session_id)
        self._verify_binding(run, owner_scope=owner_scope)
        run = self._project_terminal_approvals(run, now=now)
        # Approval creation follows the GraphRun write.  A process crash in
        # that narrow window must be repairable by an authenticated read, so a
        # blocked reachable gate is deterministically re-ensured here.
        self._reachable_approvals(run)
        return run

    @staticmethod
    def _force_fail_fast(run: GraphRun, *, reason: str) -> None:
        """Make a negative or execution failure terminal and clear work."""

        for node in run.nodes.values():
            # A fail-fast pass must never leave a successful structural
            # summary/end behind the failed run.  Executable DONE evidence is
            # retained for diagnostics; only these automatically completed
            # nodes are rewritten.
            kind = str(node.meta.get("workflow_node_kind") or "").strip()
            if node.status is NodeStatus.DONE and kind in {
                WorkflowNodeKind.JOIN.value,
                WorkflowNodeKind.END.value,
            }:
                node.status = NodeStatus.SKIPPED
                node.meta["workflow_skip_reason"] = reason
                node.meta.pop("workflow_structural", None)
                continue
            if node.status in {
                NodeStatus.PENDING,
                NodeStatus.READY,
                NodeStatus.RUNNING,
                NodeStatus.BLOCKED,
            }:
                node.status = NodeStatus.SKIPPED
                node.meta.setdefault("workflow_skip_reason", reason)
        run.status = "failed"
        run.run_state.current_nodes = []

    @staticmethod
    def _is_recoverable_terminal_skip(run: GraphRun, node: Any) -> bool:
        """Recognize only skip markers written by fail-fast reconciliation."""

        return bool(
            node.status is NodeStatus.SKIPPED
            and str(run.status or "") == "failed"
            and str(node.meta.get("workflow_skip_reason") or "")
            in {"required_failure", "decision_failure", "approval_terminal", "approval_cancelled"}
        )

    @classmethod
    def _validate_approval_gate_binding(
        cls,
        run: GraphRun,
        request: ApprovalRequest,
        gate: Any,
        *,
        require_owner_cancel_marker: bool = False,
    ) -> None:
        """Validate the immutable approval intent before reconciling a gate.

        Owner cancellation writes the GraphRun first.  A crash in the small
        window before the approval row is transitioned therefore leaves a
        pending row beside an already-cancelled gate.  That state is safe to
        reconcile only when every immutable binding still matches and the
        gate carries the service-owned ``owner_cancelled`` marker.  Keeping
        this check in one helper prevents a manually edited ``CANCELLED``
        node from becoming a bearer capability during either read or cancel
        replay.
        """

        if (
            request.run_id != run.run_id
            or request.session_id != run.session_id
            or request.workflow_id != run.workflow_id
            or int(request.workflow_revision) != int(run.workflow_revision or 0)
            or request.workflow_digest != str(run.workflow_digest or "")
        ):
            raise ApprovalIntentMismatch(request.approval_id)
        try:
            calculated_digest = request.calculated_intent_digest()
        except (TypeError, ValueError, RecursionError, OverflowError) as exc:
            raise ApprovalIntentMismatch(request.approval_id) from exc
        if not request.intent_digest or request.intent_digest != calculated_digest:
            raise ApprovalIntentMismatch(request.approval_id)
        if gate is None or cls._workflow_kind(gate) != WorkflowNodeKind.APPROVAL_GATE.value:
            raise ApprovalIntentMismatch(request.approval_id)
        downstream = [
            edge.target
            for edge in run.edges
            if edge.kind is EdgeKind.DEPENDS and edge.source == request.gate_node_id
        ]
        if len(downstream) != 1 or downstream[0] != request.downstream_node_id:
            raise ApprovalIntentMismatch(request.approval_id)
        meta = gate.meta if isinstance(gate.meta, Mapping) else {}
        for key, expected in (
            ("approval_id", request.approval_id),
            ("approval_intent_digest", request.intent_digest),
            ("approval_status", request.status.value),
        ):
            actual = meta.get(key)
            if actual not in (None, "") and str(actual) != str(expected):
                raise ApprovalIntentMismatch(request.approval_id)
        if require_owner_cancel_marker and str(meta.get("workflow_cancel_reason") or "") != "owner_cancelled":
            raise ApprovalIntentMismatch(request.approval_id)

    def _project_terminal_approvals(
        self,
        run: GraphRun,
        *,
        now: Optional[str] = None,
    ) -> GraphRun:
        """Project terminal negative approval rows into the live GraphRun.

        Approval expiration is materialized by the SQLite store when a row is
        read, while rejection/cancellation may be persisted immediately before
        a process crash.  The graph must receive the same terminal fact,
        otherwise a blocked gate can leave a run open forever after its
        approval row is terminal.  This reconciliation is idempotent and uses
        the same GraphRun CAS as other runtime advancement.
        """

        approvals = self.approval_store.list_for_run(
            run.run_id,
            session_id=run.session_id,
            include_consumed=True,
            now=now,
        )
        terminal = [
            item
            for item in approvals
            if item.status
            in {ApprovalStatus.EXPIRED, ApprovalStatus.REJECTED, ApprovalStatus.CANCELLED}
        ]
        if not terminal:
            return self._cancel_pending_terminal_approvals(run)
        current = run
        for request in terminal:
            # The row is loaded from the store with its indexed columns and
            # canonical intent digest checked.  Re-check the exact run and
            # gate binding here as well because this is the recovery boundary
            # after two independent durable writes.
            for _attempt in range(3):
                latest = self.graph_store.load(current.run_id) or current
                gate = latest.nodes.get(request.gate_node_id)
                self._validate_approval_gate_binding(latest, request, gate)
                expected_gate_status = (
                    NodeStatus.CANCELLED
                    if request.status is ApprovalStatus.CANCELLED
                    else NodeStatus.FAILED
                )
                if gate.status is not NodeStatus.BLOCKED:
                    # A fail-fast pass can have skipped a sibling gate after
                    # another approval became terminal.  That skipped state
                    # is recoverable only with the exact run marker produced
                    # by this service; unrelated terminal states still fail
                    # closed below.
                    recoverable_skipped = self._is_recoverable_terminal_skip(latest, gate)
                    if not recoverable_skipped and gate.status is not expected_gate_status:
                        raise ApprovalConflict(
                            request.approval_id,
                            "terminal approval gate has an unexpected state",
                        )
                    if not recoverable_skipped:
                        # An owner cancellation may have committed the gate
                        # status and marker before this row became terminal.
                        # The metadata is filled below, but a non-owner
                        # CANCELLED gate still needs the complete exact
                        # evidence that the deciding path wrote.
                        owner_cancelled_projection = (
                            request.status is ApprovalStatus.CANCELLED
                            and str(gate.meta.get("workflow_cancel_reason") or "") == "owner_cancelled"
                        )
                        if not owner_cancelled_projection and any(
                            str(gate.meta.get(key) or "") != str(expected)
                            for key, expected in (
                                ("approval_id", request.approval_id),
                                ("approval_intent_digest", request.intent_digest),
                                ("approval_status", request.status.value),
                            )
                        ):
                            raise ApprovalIntentMismatch(request.approval_id)
                    # The approval row may have been committed just before a
                    # crash, after the gate metadata was written but before
                    # the structural fail-fast pass.  Re-run advancement on
                    # this exact, already projected gate so READY siblings
                    # cannot remain claimable and the run reaches a terminal
                    # state.  Persist any resulting changes with CAS.
                working = GraphRun.from_dict(latest.to_dict())
                working_gate = working.nodes[request.gate_node_id]
                working_gate.status = expected_gate_status
                working_gate.meta.update(
                    {
                        "approval_id": request.approval_id,
                        "approval_intent_digest": request.intent_digest,
                        "approval_status": request.status.value,
                        "approval_failure": request.status.value,
                    }
                )
                changed = self._advance_in_place(working)
                # Owner cancellation is a distinct terminal state.  A read
                # that repairs the row/graph crash window must not rewrite it
                # as a generic failed run.
                if not (
                    request.status is ApprovalStatus.CANCELLED
                    and str(working.status or "") in {"cancelled", "canceled"}
                    and str(working_gate.meta.get("workflow_cancel_reason") or "") == "owner_cancelled"
                ):
                    self._force_fail_fast(working, reason="approval_terminal")
                changed = changed or working.to_dict() != latest.to_dict()
                if not changed:
                    current = latest
                    break
                try:
                    self.graph_store.save(
                        working,
                        bump_version=True,
                        expected_version=latest.version,
                    )
                except GraphRunVersionConflict:
                    current = self.graph_store.load(current.run_id) or current
                    continue
                current = working
                break
            else:
                raise WorkflowRunConflict(current.run_id, "approval expiration reconciliation conflict")
        return self._cancel_pending_terminal_approvals(current)

    def _cancel_pending_terminal_approvals(self, run: GraphRun) -> GraphRun:
        """Cancel other pending approvals after a run reaches a terminal state."""

        if run.status not in {"failed", "closed", "completed", "cancelled", "canceled"}:
            return run
        current = run
        for request in self.approval_store.list_for_run(
            current.run_id,
            session_id=current.session_id,
            include_consumed=False,
        ):
            if request.status is not ApprovalStatus.PENDING:
                continue
            # Validate the current graph before mutating the pending row.  In
            # particular, a pre-existing CANCELLED gate must prove the
            # service-owned owner-cancel marker; otherwise a forged graph
            # status could cause this method to authorize a row transition.
            before = self.graph_store.load(current.run_id) or current
            before_gate = before.nodes.get(request.gate_node_id)
            self._validate_approval_gate_binding(
                before,
                request,
                before_gate,
                require_owner_cancel_marker=before_gate is not None and before_gate.status is NodeStatus.CANCELLED,
            )
            try:
                cancelled = self.approval_store.decide(
                    request.approval_id,
                    decision=ApprovalStatus.CANCELLED,
                    expected_version=request.version,
                    decided_by=self._principal(),
                    decision_note="run_terminal",
                )
            except (ApprovalConflict, ApprovalExpired):
                # A concurrent decision won the row CAS.  Its own graph
                # reconciliation will validate the exact resulting evidence.
                continue
            # Keep the graph metadata in lockstep with the row.  This matters
            # for sibling gates that were skipped by fail-fast before their
            # pending rows were cancelled, and leaves a recoverable CAS window
            # if the process dies between the two durable writes.
            for _attempt in range(3):
                latest = self.graph_store.load(current.run_id) or current
                gate = latest.nodes.get(cancelled.gate_node_id)
                self._validate_approval_gate_binding(
                    latest,
                    cancelled,
                    gate,
                    require_owner_cancel_marker=gate is not None and gate.status is NodeStatus.CANCELLED,
                )
                if gate.status is NodeStatus.CANCELLED:
                    has_exact_metadata = all(
                        str(gate.meta.get(key) or "") == str(expected)
                        for key, expected in (
                            ("approval_id", cancelled.approval_id),
                            ("approval_intent_digest", cancelled.intent_digest),
                            ("approval_status", cancelled.status.value),
                        )
                    )
                    if has_exact_metadata:
                        current = latest
                        break
                    # The owner-cancel marker is the authority for this
                    # narrow crash window; complete the remaining projection
                    # idempotently with a GraphRun CAS.
                    working = GraphRun.from_dict(latest.to_dict())
                    working_gate = working.nodes[cancelled.gate_node_id]
                    working_gate.meta.update(
                        {
                            "approval_id": cancelled.approval_id,
                            "approval_intent_digest": cancelled.intent_digest,
                            "approval_status": cancelled.status.value,
                            "approval_failure": cancelled.status.value,
                        }
                    )
                    if (
                        str(working.status or "") in {"cancelled", "canceled"}
                        and str(working_gate.meta.get("workflow_cancel_reason") or "") == "owner_cancelled"
                    ):
                        # Keep the owner terminal state intact.
                        self._advance_in_place(working)
                    else:
                        self._advance_in_place(working)
                        self._force_fail_fast(working, reason="approval_cancelled")
                    try:
                        self.graph_store.save(
                            working,
                            bump_version=True,
                            expected_version=latest.version,
                        )
                    except GraphRunVersionConflict:
                        current = self.graph_store.load(current.run_id) or current
                        continue
                    current = working
                    break
                recoverable_skipped = self._is_recoverable_terminal_skip(latest, gate)
                if gate.status is not NodeStatus.BLOCKED and not recoverable_skipped:
                    raise ApprovalConflict(
                        cancelled.approval_id,
                        "cancelled approval gate has an unexpected state",
                    )
                working = GraphRun.from_dict(latest.to_dict())
                working_gate = working.nodes[cancelled.gate_node_id]
                working_gate.status = NodeStatus.CANCELLED
                working_gate.meta.update(
                    {
                        "approval_id": cancelled.approval_id,
                        "approval_intent_digest": cancelled.intent_digest,
                        "approval_status": cancelled.status.value,
                        "approval_failure": cancelled.status.value,
                    }
                )
                if str(working.status or "") in {"cancelled", "canceled"}:
                    # A partially persisted owner cancellation is still
                    # identifiable by the same explicit marker used by
                    # cancel_run.  Fail-fast sibling cancellation uses no
                    # owner marker and remains a failed run.
                    working_gate.meta["workflow_cancel_reason"] = "owner_cancelled"
                self._advance_in_place(working)
                if not (
                    str(working.status or "") in {"cancelled", "canceled"}
                    and str(working_gate.meta.get("workflow_cancel_reason") or "") == "owner_cancelled"
                ):
                    self._force_fail_fast(working, reason="approval_cancelled")
                try:
                    self.graph_store.save(
                        working,
                        bump_version=True,
                        expected_version=latest.version,
                    )
                except GraphRunVersionConflict:
                    current = self.graph_store.load(current.run_id) or current
                    continue
                current = working
                break
            else:
                raise WorkflowRunConflict(current.run_id, "pending approval cancellation conflict")
        return current

    def advance(
        self,
        run_id: str,
        session_id: str,
        expected_version: int,
        *,
        owner_scope: Optional[str] = None,
        requester_principal: Optional[str] = None,
        acting_agent_id: str = "",
        now: Optional[str] = None,
    ) -> GraphRun:
        run = self._load_run(run_id, session_id)
        self._verify_binding(run, owner_scope=owner_scope)
        run = self._project_terminal_approvals(run, now=now)
        if isinstance(expected_version, bool) or not isinstance(expected_version, int) or expected_version != run.version:
            raise WorkflowRunConflict(run.run_id, "graph run version conflict")
        updated = self._save_after_advance(run)
        updated = self._cancel_pending_terminal_approvals(updated)
        self._reachable_approvals(
            updated,
            requester_principal=requester_principal,
            acting_agent_id=acting_agent_id,
        )
        return updated

    @staticmethod
    def _claim_payload(claim: WorkflowNodeClaim) -> Dict[str, Any]:
        return claim.to_dict()

    @staticmethod
    def _write_claim(node: Any, claim: WorkflowNodeClaim) -> None:
        payload = WorkflowRuntimeService._claim_payload(claim)
        # The nested object is the canonical contract.  Flat aliases are kept
        # for existing renderers and make simple SQLite/JSON inspection useful.
        node.meta["workflow_claim"] = payload
        node.meta.update(
            {
                "workflow_attempt_id": claim.attempt_id,
                "workflow_claim_owner": claim.claim_owner,
                "workflow_fencing_token": int(claim.fencing_token),
                "workflow_lease_expires_at": float(claim.lease_expires_at),
                "workflow_claimed_at": float(claim.claimed_at),
            }
        )

    @staticmethod
    def _clear_claim(node: Any) -> None:
        node.meta.pop("workflow_claim", None)
        # Retain completed/cancelled attempt evidence in separate fields; the
        # active aliases must disappear so a renderer cannot mistake a stale
        # lease for an owned attempt.
        for key in (
            "workflow_attempt_id",
            "workflow_claim_owner",
            "workflow_fencing_token",
            "workflow_lease_expires_at",
            "workflow_claimed_at",
        ):
            node.meta.pop(key, None)

    @staticmethod
    def _claim_matches(
        node: Any,
        *,
        attempt_id: str,
        fencing_token: int,
    ) -> Optional[WorkflowNodeClaim]:
        claim = _claim_from_node(
            GraphRun(
                run_id="claim-check",
                session_id="claim-check",
                group_id=None,
                nodes={},
                edges=[],
            ),
            node,
        )
        if claim is None:
            return None
        if claim.attempt_id != str(attempt_id or "").strip():
            return None
        try:
            if int(claim.fencing_token) != int(fencing_token):
                return None
        except (TypeError, ValueError):
            return None
        return claim

    def get_node_claim(
        self,
        run_id: str,
        node_id: str,
        session_id: str,
        *,
        owner_scope: Optional[str] = None,
    ) -> Optional[WorkflowNodeClaim]:
        """Read the active durable lease for one authenticated run node."""

        run = self._load_run(run_id, session_id)
        self._verify_binding(run, owner_scope=owner_scope)
        node = run.nodes.get(str(node_id))
        if node is None:
            raise WorkflowExecutorError(run.run_id, str(node_id), "workflow node was not found")
        if node.status is not NodeStatus.RUNNING:
            return None
        return _claim_from_node(run, node)

    def claim_node(
        self,
        run_id: str,
        node_id: str,
        session_id: str,
        *,
        claim_owner: str,
        lease_seconds: float = 300.0,
        expected_version: Optional[int] = None,
        owner_scope: Optional[str] = None,
        now: Any = None,
    ) -> WorkflowNodeClaim:
        """Atomically claim one READY node or recover an expired lease.

        The GraphRun snapshot is the durable claim store.  ``GraphRunStore``
        performs an inter-process lock plus version CAS, so two executor
        processes cannot both own a READY node.  An expired lease is reusable
        only when the prior attempt has no uncertain external side effect.
        """

        owner = str(claim_owner or "").strip()
        if not owner:
            raise WorkflowClaimConflict(str(run_id), str(node_id), "claim owner is required")
        try:
            lease = float(lease_seconds)
        except (TypeError, ValueError):
            raise WorkflowClaimConflict(str(run_id), str(node_id), "lease_seconds must be positive")
        if not math.isfinite(lease) or lease <= 0 or lease > 24 * 60 * 60:
            raise WorkflowClaimConflict(str(run_id), str(node_id), "lease_seconds is outside the allowed range")
        clock = _epoch_seconds(now)
        run = self._load_run(run_id, session_id)
        self._verify_binding(run, owner_scope=owner_scope)
        node = run.nodes.get(str(node_id))
        if node is None:
            raise WorkflowExecutorError(run.run_id, str(node_id), "workflow node was not found")
        if run.status in {"failed", "closed", "completed", "cancelled", "canceled"}:
            raise WorkflowRunCancelled(run.run_id) if run.status in {"cancelled", "canceled"} else WorkflowClaimConflict(run.run_id, node.id, "workflow run is terminal")

        existing = _claim_from_node(run, node)
        if node.status is NodeStatus.RUNNING:
            if existing is None:
                raise WorkflowClaimConflict(run.run_id, node.id, "running node has no valid claim")
            if existing.lease_expires_at > clock:
                raise WorkflowClaimConflict(run.run_id, node.id, "node lease is still active")
            if str(node.meta.get("workflow_side_effect_state") or "").strip().lower() in {"dispatching", "uncertain"}:
                # An expired write cannot be replayed safely.  Persist the
                # blocked state through the same CAS before returning.
                working = GraphRun.from_dict(run.to_dict())
                blocked = working.nodes[node.id]
                blocked.status = NodeStatus.BLOCKED
                blocked.meta["workflow_blocked_reason"] = "uncertain_external_side_effect"
                blocked.meta["workflow_error_code"] = "uncertain_external_side_effect"
                blocked.meta["workflow_reconciliation_required"] = True
                blocked.meta["workflow_recovered_attempt_id"] = existing.attempt_id
                self._clear_claim(blocked)
                self._refresh_execution_metadata(working)
                try:
                    self.graph_store.save(working, bump_version=True, expected_version=run.version)
                except GraphRunVersionConflict as exc:
                    raise WorkflowRunConflict(run.run_id, "graph run version conflict while recovering claim") from exc
                raise WorkflowClaimConflict(run.run_id, node.id, "expired attempt has an uncertain external side effect")
            working = GraphRun.from_dict(run.to_dict())
            recovered = working.nodes[node.id]
            recovered.status = NodeStatus.READY
            recovered.meta["workflow_recovered_attempt_id"] = existing.attempt_id
            recovered.meta["workflow_recovered_at"] = clock
            self._clear_claim(recovered)
            run = working
            node = recovered
        elif node.status is not NodeStatus.READY:
            raise WorkflowClaimConflict(run.run_id, node.id, f"node is {getattr(node.status, 'value', node.status)}, not ready")

        current_version = int(run.version)
        if expected_version is not None:
            if isinstance(expected_version, bool) or not isinstance(expected_version, int) or expected_version != current_version:
                raise WorkflowRunConflict(run.run_id, "graph run version conflict")
        working = GraphRun.from_dict(run.to_dict())
        target = working.nodes[node.id]
        previous_fence = int(target.meta.get("workflow_last_fencing_token") or target.meta.get("workflow_fencing_token") or 0)
        claim = WorkflowNodeClaim(
            run_id=working.run_id,
            node_id=target.id,
            attempt_id=f"wa_{uuid.uuid4().hex}",
            claim_owner=owner,
            fencing_token=previous_fence + 1,
            lease_expires_at=clock + lease,
            claimed_at=clock,
            run_version=current_version + 1,
        )
        target.status = NodeStatus.RUNNING
        target.meta.pop("workflow_blocked_reason", None)
        target.meta.pop("workflow_error_code", None)
        target.meta.pop("workflow_reconciliation_required", None)
        target.meta["workflow_execution_started_at"] = clock
        target.meta["workflow_last_fencing_token"] = int(claim.fencing_token)
        self._write_claim(target, claim)
        working.meta["workflow_executor_owner"] = owner
        working.meta["workflow_last_error"] = ""
        self._refresh_execution_metadata(working)
        try:
            self.graph_store.save(working, bump_version=True, expected_version=current_version)
        except GraphRunVersionConflict as exc:
            raise WorkflowRunConflict(run.run_id, "graph run version conflict while claiming node") from exc
        return WorkflowNodeClaim(
            run_id=claim.run_id,
            node_id=claim.node_id,
            attempt_id=claim.attempt_id,
            claim_owner=claim.claim_owner,
            fencing_token=claim.fencing_token,
            lease_expires_at=claim.lease_expires_at,
            claimed_at=claim.claimed_at,
            run_version=int(working.version),
        )

    def renew_node_claim(
        self,
        run_id: str,
        node_id: str,
        session_id: str,
        *,
        attempt_id: str,
        fencing_token: int,
        lease_seconds: float = 300.0,
        claim_owner: Optional[str] = None,
        expected_version: Optional[int] = None,
        owner_scope: Optional[str] = None,
        now: Any = None,
    ) -> WorkflowNodeClaim:
        """Extend one live lease while its managed node is still executing."""

        try:
            lease = float(lease_seconds)
        except (TypeError, ValueError):
            raise WorkflowClaimConflict(str(run_id), str(node_id), "lease_seconds must be positive")
        if not math.isfinite(lease) or lease <= 0 or lease > 24 * 60 * 60:
            raise WorkflowClaimConflict(str(run_id), str(node_id), "lease_seconds is outside the allowed range")
        clock = _epoch_seconds(now)
        run = self._load_run(run_id, session_id)
        self._verify_binding(run, owner_scope=owner_scope)
        node = run.nodes.get(str(node_id))
        if node is None:
            raise WorkflowExecutorError(run.run_id, str(node_id), "workflow node was not found")
        claim = self._claim_matches(node, attempt_id=attempt_id, fencing_token=fencing_token)
        if claim is None or node.status is not NodeStatus.RUNNING:
            raise WorkflowClaimConflict(run.run_id, node.id, "attempt or fencing token does not own the active node")
        if claim_owner is not None and str(claim_owner or "").strip() != claim.claim_owner:
            raise WorkflowClaimConflict(run.run_id, node.id, "claim owner does not own the active node")
        if claim.lease_expires_at <= clock:
            raise WorkflowClaimConflict(run.run_id, node.id, "node lease has expired")
        if expected_version is not None and (
            isinstance(expected_version, bool) or not isinstance(expected_version, int) or expected_version != run.version
        ):
            raise WorkflowRunConflict(run.run_id, "graph run version conflict")
        working = GraphRun.from_dict(run.to_dict())
        target = working.nodes[node.id]
        renewed = WorkflowNodeClaim(
            run_id=claim.run_id,
            node_id=claim.node_id,
            attempt_id=claim.attempt_id,
            claim_owner=claim.claim_owner,
            fencing_token=claim.fencing_token,
            lease_expires_at=clock + lease,
            claimed_at=claim.claimed_at,
            run_version=run.version + 1,
        )
        self._write_claim(target, renewed)
        self._refresh_execution_metadata(working)
        try:
            self.graph_store.save(working, bump_version=True, expected_version=run.version)
        except GraphRunVersionConflict as exc:
            raise WorkflowRunConflict(run.run_id, "graph run version conflict while renewing claim") from exc
        return WorkflowNodeClaim(
            run_id=renewed.run_id,
            node_id=renewed.node_id,
            attempt_id=renewed.attempt_id,
            claim_owner=renewed.claim_owner,
            fencing_token=renewed.fencing_token,
            lease_expires_at=renewed.lease_expires_at,
            claimed_at=renewed.claimed_at,
            run_version=working.version,
        )

    def mark_node_side_effect(
        self,
        run_id: str,
        node_id: str,
        session_id: str,
        *,
        attempt_id: str,
        fencing_token: int,
        state: str = "dispatching",
        intent_digest: str = "",
        claim_owner: Optional[str] = None,
        owner_scope: Optional[str] = None,
        now: Any = None,
    ) -> GraphRun:
        """Fence an external write before dispatch so crash recovery is safe."""

        normalized = str(state or "").strip().lower()
        if normalized not in {"dispatching", "uncertain", "applied"}:
            raise WorkflowExecutorError(str(run_id), str(node_id), "unsupported external side effect state")
        run = self._load_run(run_id, session_id)
        self._verify_binding(run, owner_scope=owner_scope)
        node = run.nodes.get(str(node_id))
        if node is None:
            raise WorkflowExecutorError(run.run_id, str(node_id), "workflow node was not found")
        claim = self._claim_matches(node, attempt_id=attempt_id, fencing_token=fencing_token)
        if claim is None or node.status is not NodeStatus.RUNNING:
            raise WorkflowClaimConflict(run.run_id, node.id, "attempt or fencing token does not own the active node")
        if claim_owner is not None and str(claim_owner or "").strip() != claim.claim_owner:
            raise WorkflowClaimConflict(run.run_id, node.id, "claim owner does not own the active node")
        if claim.lease_expires_at <= _epoch_seconds(now):
            raise WorkflowClaimConflict(run.run_id, node.id, "node lease has expired")
        working = GraphRun.from_dict(run.to_dict())
        target = working.nodes[node.id]
        target.meta["workflow_side_effect_state"] = normalized
        target.meta["workflow_side_effect_marked_at"] = _epoch_seconds(now)
        if str(intent_digest or "").strip():
            target.meta["workflow_side_effect_intent_digest"] = str(intent_digest).strip()[:128]
        self._refresh_execution_metadata(working)
        try:
            self.graph_store.save(working, bump_version=True, expected_version=run.version)
        except GraphRunVersionConflict as exc:
            raise WorkflowRunConflict(run.run_id, "graph run version conflict while marking side effect") from exc
        return working

    def complete_node_claim(
        self,
        run_id: str,
        node_id: str,
        session_id: str,
        *,
        attempt_id: str,
        fencing_token: int,
        outcome: str,
        output_summary: Any = "",
        evidence: Any = None,
        selected_route: Optional[str] = None,
        artifacts: Any = None,
        usage_metadata: Any = None,
        side_effect_state: str = "none",
        error_code: Optional[str] = None,
        claim_owner: Optional[str] = None,
        expected_version: Optional[int] = None,
        owner_scope: Optional[str] = None,
        requester_principal: Optional[str] = None,
        acting_agent_id: str = "",
        now: Any = None,
    ) -> GraphRun:
        """Complete exactly the active claim and advance dependent nodes."""

        run = self._load_run(run_id, session_id)
        self._verify_binding(run, owner_scope=owner_scope)
        node = run.nodes.get(str(node_id))
        if node is None:
            raise WorkflowExecutorError(run.run_id, str(node_id), "workflow node was not found")
        claim = self._claim_matches(node, attempt_id=attempt_id, fencing_token=fencing_token)
        if claim is None or node.status is not NodeStatus.RUNNING:
            raise WorkflowClaimConflict(run.run_id, node.id, "attempt or fencing token does not own the active node")
        if claim_owner is not None and str(claim_owner or "").strip() != claim.claim_owner:
            raise WorkflowClaimConflict(run.run_id, node.id, "claim owner does not own the active node")
        clock = _epoch_seconds(now)
        if claim.lease_expires_at <= clock:
            raise WorkflowClaimConflict(run.run_id, node.id, "node lease has expired")
        if run.status in {"failed", "closed", "completed", "cancelled", "canceled"}:
            raise WorkflowRunCancelled(run.run_id) if run.status in {"cancelled", "canceled"} else WorkflowClaimConflict(run.run_id, node.id, "workflow run is terminal")
        if expected_version is not None and (
            isinstance(expected_version, bool) or not isinstance(expected_version, int) or expected_version != run.version
        ):
            raise WorkflowRunConflict(run.run_id, "graph run version conflict")
        normalized = str(outcome or "").strip().lower()
        if normalized in {"success", "succeeded", "complete", "completed", "ok"}:
            normalized = "done"
        elif normalized in {"error", "failure", "rejected"}:
            normalized = "failed"
        if normalized not in {"done", "failed", "blocked", "uncertain"}:
            raise WorkflowExecutorError(run.run_id, node.id, "claim outcome must be done, failed, blocked, or uncertain")
        normalized_side_effect = str(side_effect_state or "none").strip().lower()
        if normalized_side_effect not in {"none", "dispatching", "applied", "uncertain"}:
            raise WorkflowExecutorError(
                run.run_id,
                node.id,
                "claim side_effect_state must be none, dispatching, applied, or uncertain",
            )
        if node.meta.get("workflow_node_kind") == WorkflowNodeKind.DECISION.value:
            route = str(selected_route or "").strip()
            routes = {
                self._edge_route(run, edge)
                for edge in run.edges
                if edge.kind is EdgeKind.DEPENDS and edge.source == node.id
            }
            if normalized == "done" and (not route or route not in routes):
                raise WorkflowExecutorError(run.run_id, node.id, "decision result must select a catalogued route")
            if normalized != "done" and route:
                raise WorkflowExecutorError(run.run_id, node.id, "failed or blocked decision cannot select a route")
        try:
            payload = bounded_json_value(
                {
                    "node_id": node.id,
                    "workflow_id": run.workflow_id,
                    "workflow_revision": run.workflow_revision,
                    "workflow_digest": run.workflow_digest,
                    "attempt_id": str(attempt_id),
                    "fencing_token": int(fencing_token),
                    "outcome": normalized,
                    "output_summary": output_summary,
                    "evidence": evidence,
                    "selected_route": str(selected_route or "").strip() or None,
                    "artifacts": artifacts,
                    "usage_metadata": usage_metadata,
                    "side_effect_state": normalized_side_effect,
                    "error_code": str(error_code or "").strip() or None,
                },
                strip_sensitive=True,
            )
        except (TypeError, ValueError, RecursionError, OverflowError) as exc:
            raise WorkflowExecutorError(run.run_id, node.id, f"managed executor result is not bounded JSON: {exc}") from exc
        result_digest = canonical_digest(payload)
        working = GraphRun.from_dict(run.to_dict())
        target = working.nodes[node.id]
        target.meta.update(
            {
                "workflow_result_digest": result_digest,
                "workflow_outcome": normalized,
                "workflow_output_summary": _as_json_value(output_summary),
                "workflow_evidence": _as_json_value(evidence),
                "workflow_artifacts": _as_json_value(artifacts),
                "workflow_usage_metadata": _as_json_value(usage_metadata),
                "workflow_completed_attempt_id": str(attempt_id),
                "workflow_completed_fencing_token": int(fencing_token),
                "workflow_completed_at": clock,
                "workflow_side_effect_state": normalized_side_effect,
            }
        )
        if selected_route:
            target.meta["workflow_selected_route"] = str(selected_route).strip()
        if normalized == "failed":
            target.meta["workflow_failure"] = True
        if normalized in {"blocked", "uncertain"}:
            target.status = NodeStatus.BLOCKED
            target.meta["workflow_blocked_reason"] = str(
                output_summary if normalized == "blocked" else "uncertain_external_side_effect"
            )[:4096]
            target.meta["workflow_error_code"] = (
                "uncertain_external_side_effect"
                if normalized == "uncertain"
                else str(error_code or "").strip()[:128] or "execution_blocked"
            )
            if normalized == "uncertain":
                target.meta["workflow_reconciliation_required"] = True
        else:
            target.status = NodeStatus.DONE if normalized == "done" else NodeStatus.FAILED
        self._clear_claim(target)
        self._advance_in_place(working)
        try:
            self.graph_store.save(working, bump_version=True, expected_version=run.version)
        except GraphRunVersionConflict as exc:
            raise WorkflowRunConflict(run.run_id, "graph run version conflict while completing node") from exc
        updated = self._cancel_pending_terminal_approvals(working)
        self._reachable_approvals(
            updated,
            requester_principal=requester_principal,
            acting_agent_id=acting_agent_id,
        )
        return updated

    def record_node_event(
        self,
        run_id: str,
        node_id: str,
        session_id: str,
        *,
        attempt_id: str,
        fencing_token: int,
        event_type: str,
        payload: Any = None,
        claim_owner: Optional[str] = None,
        owner_scope: Optional[str] = None,
    ) -> GraphRun:
        """Append one bounded progress event under the active claim."""

        run = self._load_run(run_id, session_id)
        self._verify_binding(run, owner_scope=owner_scope)
        node = run.nodes.get(str(node_id))
        if node is None:
            raise WorkflowExecutorError(run.run_id, node_id, "workflow node was not found")
        claim = self._claim_matches(node, attempt_id=attempt_id, fencing_token=fencing_token)
        if claim is None or node.status is not NodeStatus.RUNNING:
            raise WorkflowClaimConflict(run.run_id, node_id, "progress event belongs to a stale attempt")
        if claim_owner is not None and str(claim_owner or "").strip() != claim.claim_owner:
            raise WorkflowClaimConflict(run.run_id, node_id, "claim owner does not own the active node")
        try:
            safe_payload = bounded_json_value(payload, strip_sensitive=True)
        except (TypeError, ValueError, RecursionError, OverflowError) as exc:
            raise WorkflowExecutorError(run.run_id, node_id, f"progress event is not bounded JSON: {exc}") from exc
        row = {
            "type": str(event_type or "progress")[:80],
            "payload": safe_payload,
            "at": time.time(),
        }
        events = list(node.meta.get("workflow_events") or [])
        events.append(row)
        # The event log is intentionally a small tail.  Full model/tool output
        # remains in the AgentRuntime session and node result evidence, not in
        # the GraphRun hot snapshot.
        node_meta = dict(node.meta)
        node_meta["workflow_events"] = events[-48:]
        node_meta["workflow_last_event"] = row
        working = GraphRun.from_dict(run.to_dict())
        working.nodes[node_id].meta.update(node_meta)
        self._refresh_execution_metadata(working)
        try:
            self.graph_store.save(working, bump_version=True, expected_version=run.version)
        except GraphRunVersionConflict as exc:
            raise WorkflowRunConflict(run.run_id, "graph run version conflict while recording progress") from exc
        return working

    def retry_node(
        self,
        run_id: str,
        node_id: str,
        session_id: str,
        expected_version: int,
        *,
        reconcile: bool = False,
        owner_scope: Optional[str] = None,
    ) -> GraphRun:
        """Explicitly requeue a blocked/failed node after user review."""

        run = self._load_run(run_id, session_id)
        self._verify_binding(run, owner_scope=owner_scope)
        node = run.nodes.get(str(node_id))
        if node is None:
            raise WorkflowExecutorError(run.run_id, node_id, "workflow node was not found")
        if node.status not in {NodeStatus.BLOCKED, NodeStatus.FAILED}:
            raise WorkflowExecutorError(run.run_id, node.id, "only blocked or failed nodes can be retried")
        if node.status is NodeStatus.BLOCKED and node.meta.get("workflow_reconciliation_required") and not reconcile:
            raise WorkflowExecutorError(run.run_id, node.id, "reconciliation is required before retrying this node")
        if isinstance(expected_version, bool) or not isinstance(expected_version, int) or expected_version != run.version:
            raise WorkflowRunConflict(run.run_id, "graph run version conflict")
        working = GraphRun.from_dict(run.to_dict())
        target = working.nodes[node.id]
        target.status = NodeStatus.READY
        target.retry_count = int(target.retry_count or 0) + 1
        target.meta["workflow_retry_of_attempt"] = str(target.meta.get("workflow_completed_attempt_id") or target.meta.get("workflow_recovered_attempt_id") or "")
        target.meta["workflow_retry_requested_at"] = time.time()
        for key in (
            "workflow_blocked_reason",
            "workflow_error_code",
            "workflow_reconciliation_required",
            "workflow_side_effect_state",
        ):
            target.meta.pop(key, None)
        working.status = "open"
        self._advance_in_place(working)
        try:
            self.graph_store.save(working, bump_version=True, expected_version=run.version)
        except GraphRunVersionConflict as exc:
            raise WorkflowRunConflict(run.run_id, "graph run version conflict while retrying node") from exc
        return working

    def cancel_run(
        self,
        run_id: str,
        session_id: str,
        *,
        expected_version: Optional[int] = None,
        owner_scope: Optional[str] = None,
        cancelled_by: Optional[str] = None,
    ) -> GraphRun:
        """Persist owner cancellation and fence all active node attempts."""

        run = self._load_run(run_id, session_id)
        self._verify_binding(run, owner_scope=owner_scope)
        if expected_version is not None and (
            isinstance(expected_version, bool) or not isinstance(expected_version, int) or expected_version != run.version
        ):
            raise WorkflowRunConflict(run.run_id, "graph run version conflict")
        if run.status in {"failed", "closed", "completed", "cancelled", "canceled"}:
            if str(run.status or "") in {"cancelled", "canceled"}:
                # A crash can leave the owner-cancel GraphRun CAS committed
                # while one or more approval rows are still pending.  A
                # replay must reconcile those rows instead of returning the
                # half-cancelled snapshot forever.
                return self._cancel_pending_terminal_approvals(run)
            return run
        working = GraphRun.from_dict(run.to_dict())
        for node in working.nodes.values():
            if node.status in {NodeStatus.PENDING, NodeStatus.READY, NodeStatus.RUNNING, NodeStatus.BLOCKED}:
                active = _claim_from_node(working, node)
                if active is not None:
                    node.meta["workflow_cancelled_attempt_id"] = active.attempt_id
                    node.meta["workflow_cancelled_fencing_token"] = int(active.fencing_token)
                self._clear_claim(node)
                node.status = NodeStatus.CANCELLED
                node.meta["workflow_cancel_reason"] = "owner_cancelled"
        working.status = "cancelled"
        working.meta["workflow_cancelled_by"] = str(cancelled_by or self._principal())[:256]
        working.meta["workflow_cancelled_at"] = time.time()
        working.run_state.current_nodes = []
        self._refresh_execution_metadata(working)
        try:
            self.graph_store.save(working, bump_version=True, expected_version=run.version)
        except GraphRunVersionConflict as exc:
            raise WorkflowRunConflict(run.run_id, "graph run version conflict while cancelling run") from exc
        return self._cancel_pending_terminal_approvals(working)

    @staticmethod
    def _normalize_outcome(outcome: Any) -> str:
        value = str(outcome or "").strip().lower()
        if value in {"done", "success", "succeeded", "completed", "complete", "ok"}:
            return "done"
        if value in {"failed", "failure", "error", "rejected"}:
            return "failed"
        return value

    def report_node_result(
        self,
        run_id: str,
        node_id: str,
        session_id: str,
        expected_version: int,
        outcome: str,
        output_summary: Any = "",
        evidence: Any = None,
        selected_route: Optional[str] = None,
        *,
        owner_scope: Optional[str] = None,
        requester_principal: Optional[str] = None,
        acting_agent_id: str = "",
        attempt_id: Optional[str] = None,
        fencing_token: Optional[int] = None,
        artifacts: Any = None,
        usage_metadata: Any = None,
        side_effect_state: str = "none",
        now: Any = None,
    ) -> GraphRun:
        # Once the service-owned executor has claimed a node, the historical
        # result endpoint may only complete that exact fenced attempt.  This
        # keeps old READY-only callers working for unclaimed runs while making
        # renderer-submitted success unable to forge an active execution.
        if attempt_id is not None or fencing_token is not None:
            if attempt_id is None or fencing_token is None:
                raise WorkflowClaimConflict(str(run_id), str(node_id), "attempt_id and fencing_token must be supplied together")
            return self.complete_node_claim(
                run_id,
                node_id,
                session_id,
                attempt_id=attempt_id,
                fencing_token=fencing_token,
                outcome=outcome,
                output_summary=output_summary,
                evidence=evidence,
                selected_route=selected_route,
                artifacts=artifacts,
                usage_metadata=usage_metadata,
                side_effect_state=side_effect_state,
                claim_owner=None,
                owner_scope=owner_scope,
                requester_principal=requester_principal,
                acting_agent_id=acting_agent_id,
                now=now,
            )
        run = self._load_run(run_id, session_id)
        snapshot = self._verify_binding(run, owner_scope=owner_scope)
        result_outcome = self._normalize_outcome(outcome)
        if result_outcome not in {"done", "failed"}:
            raise WorkflowExecutorError(run.run_id, node_id, "outcome must be done or failed")
        node = run.nodes.get(str(node_id))
        if node is None:
            raise WorkflowExecutorError(run.run_id, node_id, "workflow node was not found")
        kind = self._workflow_kind(node)
        allowed = {
            WorkflowNodeKind.AGENT_TASK.value,
            WorkflowNodeKind.CONNECTOR_ACTION.value,
            WorkflowNodeKind.DECISION.value,
            WorkflowNodeKind.REVIEW.value,
        }
        if kind not in allowed:
            raise WorkflowExecutorError(run.run_id, node_id, "node kind does not accept managed executor results")
        normalized_route = str(selected_route or "").strip()
        if kind == WorkflowNodeKind.DECISION.value:
            routes = {
                self._edge_route(run, edge)
                for edge in run.edges
                if edge.kind is EdgeKind.DEPENDS and edge.source == node.id
            }
            if result_outcome == "done" and (not normalized_route or normalized_route not in routes):
                raise WorkflowExecutorError(run.run_id, node_id, "decision result must select a catalogued route")
            if result_outcome == "failed" and normalized_route:
                raise WorkflowExecutorError(run.run_id, node_id, "failed decision result cannot select a route")
        elif normalized_route:
            raise WorkflowExecutorError(run.run_id, node_id, "selected_route is only valid for decision nodes")
        try:
            payload = bounded_json_value(
                {
                    "node_id": node.id,
                    "workflow_id": run.workflow_id,
                    "workflow_revision": run.workflow_revision,
                    "workflow_digest": run.workflow_digest,
                    "outcome": result_outcome,
                    "output_summary": output_summary,
                    "evidence": evidence,
                    "selected_route": normalized_route or None,
                },
                strip_sensitive=True,
            )
        except (TypeError, ValueError, RecursionError, OverflowError) as exc:
            raise WorkflowExecutorError(
                run.run_id,
                node_id,
                f"managed executor result is not bounded JSON: {exc}",
            ) from exc
        result_digest = canonical_digest(payload)
        if node.status in {NodeStatus.DONE, NodeStatus.FAILED}:
            if str(node.meta.get("workflow_result_digest") or "") != result_digest:
                raise WorkflowRunConflict(run.run_id, "duplicate node result does not match")
            return run
        if run.status in {"failed", "closed", "completed", "cancelled", "canceled"}:
            raise WorkflowExecutorError(run.run_id, node_id, "workflow run is terminal")
        if node.status is NodeStatus.RUNNING:
            raise WorkflowClaimConflict(run.run_id, node.id, "active executor claim requires attempt_id and fencing_token")
        if node.status is not NodeStatus.READY:
            raise WorkflowExecutorError(run.run_id, node_id, "node is not ready for a managed executor result")
        if isinstance(expected_version, bool) or not isinstance(expected_version, int) or expected_version != run.version:
            raise WorkflowRunConflict(run.run_id, "graph run version conflict")
        working = GraphRun.from_dict(run.to_dict())
        target = working.nodes[node.id]
        target.status = NodeStatus.DONE if result_outcome == "done" else NodeStatus.FAILED
        target.meta.update(
            {
                "workflow_result_digest": result_digest,
                "workflow_outcome": result_outcome,
                "workflow_output_summary": _as_json_value(output_summary),
                "workflow_evidence": _as_json_value(evidence),
            }
        )
        if normalized_route:
            target.meta["workflow_selected_route"] = normalized_route
        if result_outcome == "failed":
            target.meta["workflow_failure"] = True
        self._advance_in_place(working)
        try:
            self.graph_store.save(
                working,
                bump_version=True,
                expected_version=int(expected_version),
            )
        except GraphRunVersionConflict as exc:
            raise WorkflowRunConflict(run.run_id, "graph run version conflict") from exc
        updated = working
        updated = self._cancel_pending_terminal_approvals(updated)
        self._reachable_approvals(
            updated,
            requester_principal=requester_principal,
            acting_agent_id=acting_agent_id,
        )
        return updated

    def list_approvals(
        self,
        run_id: str,
        session_id: str,
        *,
        owner_scope: Optional[str] = None,
        include_consumed: bool = True,
        now: Optional[str] = None,
    ) -> list[ApprovalRequest]:
        run = self._load_run(run_id, session_id)
        self._verify_binding(run, owner_scope=owner_scope)
        run = self._project_terminal_approvals(run, now=now)
        self._reachable_approvals(run)
        return self.approval_store.list_for_run(
            run.run_id,
            session_id=session_id,
            include_consumed=include_consumed,
        )

    def decide_approval(
        self,
        approval_id: str,
        session_id: str,
        decision: str,
        expected_version: int,
        *,
        decided_by: Optional[str] = None,
        decision_note: Optional[str] = None,
        expected_run_version: Optional[int] = None,
        owner_scope: Optional[str] = None,
        now: Optional[str] = None,
    ) -> WorkflowApprovalResult:
        request = self.approval_store.get(approval_id, now=now)
        if request.session_id != str(session_id or "").strip():
            raise WorkflowRunOwnershipError(request.run_id, str(session_id))
        run = self._load_run(request.run_id, session_id)
        self._verify_binding(run, owner_scope=owner_scope)
        run = self._project_terminal_approvals(run, now=now)
        gate = run.nodes.get(request.gate_node_id)
        if gate is None:
            raise ApprovalIntentMismatch(request.approval_id)
        if request.status is ApprovalStatus.PENDING and (
            run.status in {"failed", "closed", "completed", "cancelled", "canceled"} or gate.status is not NodeStatus.BLOCKED
        ):
            raise ApprovalConflict(request.approval_id, "approval gate is no longer actionable")
        self.approval_service.authorize_decision(
            request,
            approver_principal=self._principal(decided_by or owner_scope),
            session_id=session_id,
        )
        decided = self.approval_store.decide(
            approval_id,
            decision=decision,
            expected_version=expected_version,
            decided_by=decided_by,
            decision_note=decision_note,
            now=now,
        )
        if decided.status in {
            ApprovalStatus.REJECTED,
            ApprovalStatus.CANCELLED,
            ApprovalStatus.EXPIRED,
        }:
            # Terminal negative decisions are represented in the GraphRun and
            # fail the run before any downstream work may become ready.
            working = GraphRun.from_dict(run.to_dict())
            node = working.nodes.get(decided.gate_node_id)
            if node is None:
                raise ApprovalIntentMismatch(decided.approval_id)
            node.status = (
                NodeStatus.CANCELLED
                if decided.status is ApprovalStatus.CANCELLED
                else NodeStatus.FAILED
            )
            node.meta.update(
                {
                    "approval_id": decided.approval_id,
                    "approval_intent_digest": decided.intent_digest,
                    "approval_status": decided.status.value,
                    "approval_decided_by": decided.decided_by,
                    "approval_decision_note": decided.decision_note,
                }
            )
            self._advance_in_place(working)
            # A negative approval is terminal even when the gate was marked
            # optional in the definition.  Keep the run failed after the
            # structural pass while clearing any remaining ready work.
            self._force_fail_fast(working, reason="approval_terminal")
            try:
                self.graph_store.save(
                    working,
                    bump_version=True,
                    expected_version=(
                        int(expected_run_version)
                        if expected_run_version is not None
                        else int(run.version)
                    ),
                )
            except GraphRunVersionConflict as exc:
                latest = self._load_run(request.run_id, session_id)
                latest_node = latest.nodes.get(decided.gate_node_id)
                if latest_node is None or latest_node.status not in {
                    NodeStatus.FAILED,
                    NodeStatus.CANCELLED,
                }:
                    raise WorkflowRunConflict(request.run_id, "graph run version conflict") from exc
                if str(latest_node.meta.get("approval_id") or "") != decided.approval_id:
                    raise ApprovalIntentMismatch(decided.approval_id)
                if str(latest_node.meta.get("approval_intent_digest") or "") != decided.intent_digest:
                    raise ApprovalIntentMismatch(decided.approval_id)
                if str(latest_node.meta.get("approval_status") or "") != decided.status.value:
                    raise ApprovalIntentMismatch(decided.approval_id)
                # Reuse the terminal projection path so a conflict recovery
                # also persists the fail-fast cleanup and cancels sibling
                # pending rows before this API returns.
                run = self._project_terminal_approvals(latest)
            else:
                run = working
            run = self._cancel_pending_terminal_approvals(run)
        return WorkflowApprovalResult(request=decided, run=run)

    def resume_approval(
        self,
        approval_id: str,
        session_id: str,
        *,
        expected_version: Optional[int] = None,
        expected_run_version: Optional[int] = None,
        result_digest: Optional[str] = None,
        owner_scope: Optional[str] = None,
        now: Optional[str] = None,
        requester_principal: Optional[str] = None,
        acting_agent_id: str = "",
    ) -> WorkflowApprovalResult:
        request = self.approval_store.get(approval_id, now=now)
        if request.session_id != str(session_id or "").strip():
            raise WorkflowRunOwnershipError(request.run_id, str(session_id))
        run = self._load_run(request.run_id, session_id)
        self._verify_binding(run, owner_scope=owner_scope)
        run = self._project_terminal_approvals(run, now=now)
        if expected_run_version is not None and (
            isinstance(expected_run_version, bool)
            or not isinstance(expected_run_version, int)
            or expected_run_version < 1
        ):
            raise ApprovalConflict(request.approval_id, "expected run version must be a positive integer")
        resumed, graph_run = self.approval_service.resume_after_approval(
            approval_id,
            session_id=session_id,
            expected_version=expected_version,
            expected_run_version=expected_run_version,
            result_digest=result_digest,
            now=now,
        )
        # The approval service performs the gate-done CAS first and consumes
        # second.  Structural readiness is a separate CAS and is safe to retry
        # after a crash in this final step.
        latest = self.graph_store.load(graph_run.run_id) or graph_run
        latest = self._save_after_advance(latest)
        latest = self._cancel_pending_terminal_approvals(latest)
        self._reachable_approvals(
            latest,
            requester_principal=requester_principal,
            acting_agent_id=acting_agent_id,
        )
        return WorkflowApprovalResult(request=resumed, run=latest)


__all__ = [
    "WorkflowClaimConflict",
    "WorkflowApprovalResult",
    "WorkflowExecutorError",
    "WorkflowRevisionNotPublished",
    "WorkflowRunConflict",
    "WorkflowRunCancelled",
    "WorkflowRunCreation",
    "WorkflowRunNotFound",
    "WorkflowRunOwnershipError",
    "WorkflowRuntimeError",
    "WorkflowRuntimeService",
    "workflow_execution_envelope",
]
