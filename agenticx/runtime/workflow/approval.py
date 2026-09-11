"""Durable, one-time Approval Gate records for Workflow runs.

Approval rows live beside Workflow revisions in the same SQLite database.  A
decision and a consumption are guarded by a per-record version CAS.  The
service deliberately stores authorization intent separately from mutable
status so an approval ID can never be used as a bearer capability.
"""

from __future__ import annotations

import contextlib
import json
import os
import secrets
import sqlite3
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from enum import Enum
from pathlib import Path
from typing import Any, Dict, Iterator, Mapping, Optional

from agenticx.runtime.graph.models import EdgeKind, GraphRun, NodeStatus
from agenticx.runtime.graph.store import GraphRunStore, GraphRunVersionConflict

from .models import canonical_digest, validate_revision, validate_workflow_id
from .validation import (
    MAX_APPROVAL_TTL_SECONDS,
    MIN_APPROVAL_TTL_SECONDS,
    SUPPORTED_APPROVER_POLICY_KINDS,
)


class ApprovalStatus(str, Enum):
    PENDING = "pending"
    APPROVED = "approved"
    REJECTED = "rejected"
    EXPIRED = "expired"
    CONSUMED = "consumed"
    CANCELLED = "cancelled"


class ApprovalError(RuntimeError):
    """Base class for typed Approval persistence/service failures."""


class ApprovalCorruptError(ApprovalError):
    """Raised when JSON and indexed approval columns disagree."""

    def __init__(self, approval_id: str, message: str = "corrupt approval record") -> None:
        self.approval_id = str(approval_id)
        super().__init__(message)


class ApprovalNotFound(ApprovalError):
    def __init__(self, approval_id: str) -> None:
        self.approval_id = str(approval_id)
        super().__init__(f"approval {self.approval_id!r} was not found")


class ApprovalConflict(ApprovalError):
    def __init__(self, approval_id: str, message: str = "approval state conflict") -> None:
        self.approval_id = str(approval_id)
        super().__init__(message)


class ApprovalExpired(ApprovalConflict):
    def __init__(self, approval_id: str) -> None:
        super().__init__(approval_id, "approval has expired")


class ApprovalIntentMismatch(ApprovalConflict):
    def __init__(self, approval_id: str) -> None:
        super().__init__(approval_id, "approval intent binding mismatch")


class ApprovalExternalGrantorUnsupported(ApprovalError):
    def __init__(self) -> None:
        super().__init__("external resource grantors are not supported")


class ApprovalPolicyUnsupported(ApprovalError):
    """Raised when a policy needs an identity/role resolver not wired in MVP."""

    def __init__(self, policy_kind: str) -> None:
        self.policy_kind = str(policy_kind)
        super().__init__(f"approver policy {self.policy_kind!r} cannot be verified")


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _parse_time(value: str) -> datetime:
    text = str(value or "").strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    parsed = datetime.fromisoformat(text)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _approval_id(value: Any) -> str:
    text = str(value or "").strip()
    if not text or len(text) > 128 or any(char not in "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-:." for char in text):
        raise ValueError("invalid approval_id")
    return text


def _optional_text(value: Any) -> Optional[str]:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


@dataclass
class ApprovalRequest:
    """Immutable authorization intent plus its durable mutable state."""

    approval_id: str
    workflow_id: str
    workflow_revision: int
    workflow_digest: str
    run_id: str
    graph_run_version_at_request: int
    gate_node_id: str
    downstream_node_id: str
    session_id: str
    requester_principal: str
    acting_agent_id: str
    approver_policy_kind: str
    approver_policy_value: Any = None
    connector_id: Optional[str] = None
    action_id: Optional[str] = None
    action_params_digest: str = ""
    resource_ref: Optional[str] = None
    resource_version: Optional[str] = None
    policy_version: Optional[str] = None
    intent_digest: str = ""
    status: ApprovalStatus = ApprovalStatus.PENDING
    version: int = 1
    requested_at: str = ""
    expires_at: str = ""
    decided_at: Optional[str] = None
    decided_by: Optional[str] = None
    decision_note: Optional[str] = None
    consumed_at: Optional[str] = None
    result_digest: Optional[str] = None
    resource_grantor_ref: Optional[str] = None
    target_action_description: str = ""
    summary: str = ""

    def intent_payload(self) -> Dict[str, Any]:
        """Canonical immutable authorization fields, excluding state/time."""

        return {
            "workflow_id": self.workflow_id,
            "workflow_revision": int(self.workflow_revision),
            "workflow_digest": self.workflow_digest,
            "run_id": self.run_id,
            "graph_run_version_at_request": int(self.graph_run_version_at_request),
            "gate_node_id": self.gate_node_id,
            "downstream_node_id": self.downstream_node_id,
            "session_id": self.session_id,
            "requester_principal": self.requester_principal,
            "acting_agent_id": self.acting_agent_id,
            "approver_policy_kind": self.approver_policy_kind,
            "approver_policy_value": self.approver_policy_value,
            "connector_id": self.connector_id,
            "action_id": self.action_id,
            "action_params_digest": self.action_params_digest,
            "resource_ref": self.resource_ref,
            "resource_version": self.resource_version,
            "policy_version": self.policy_version,
            "resource_grantor_ref": self.resource_grantor_ref,
            "target_action_description": self.target_action_description,
            "summary": self.summary,
        }

    def calculated_intent_digest(self) -> str:
        return canonical_digest(self.intent_payload())

    def to_dict(self) -> Dict[str, Any]:
        return {
            "approval_id": self.approval_id,
            "workflow_id": self.workflow_id,
            "workflow_revision": int(self.workflow_revision),
            "workflow_digest": self.workflow_digest,
            "run_id": self.run_id,
            "graph_run_version_at_request": int(self.graph_run_version_at_request),
            "gate_node_id": self.gate_node_id,
            "downstream_node_id": self.downstream_node_id,
            "session_id": self.session_id,
            "requester_principal": self.requester_principal,
            "acting_agent_id": self.acting_agent_id,
            "approver_policy_kind": self.approver_policy_kind,
            "approver_policy_value": self.approver_policy_value,
            "connector_id": self.connector_id,
            "action_id": self.action_id,
            "action_params_digest": self.action_params_digest,
            "resource_ref": self.resource_ref,
            "resource_version": self.resource_version,
            "policy_version": self.policy_version,
            "intent_digest": self.intent_digest,
            "status": self.status.value,
            "version": int(self.version),
            "requested_at": self.requested_at,
            "expires_at": self.expires_at,
            "decided_at": self.decided_at,
            "decided_by": self.decided_by,
            "decision_note": self.decision_note,
            "consumed_at": self.consumed_at,
            "result_digest": self.result_digest,
            "resource_grantor_ref": self.resource_grantor_ref,
            "target_action_description": self.target_action_description,
            "summary": self.summary,
        }

    @classmethod
    def from_dict(cls, raw: Mapping[str, Any]) -> "ApprovalRequest":
        if not isinstance(raw, Mapping):
            raise ValueError("approval request must be an object")
        status_raw = raw.get("status", ApprovalStatus.PENDING.value)
        try:
            status = status_raw if isinstance(status_raw, ApprovalStatus) else ApprovalStatus(str(status_raw))
        except ValueError as exc:
            raise ValueError("invalid approval status") from exc
        request = cls(
            approval_id=_approval_id(raw.get("approval_id")),
            workflow_id=validate_workflow_id(raw.get("workflow_id")),
            workflow_revision=validate_revision(raw.get("workflow_revision")),
            workflow_digest=str(raw.get("workflow_digest") or ""),
            run_id=str(raw.get("run_id") or "").strip(),
            graph_run_version_at_request=int(raw.get("graph_run_version_at_request") or 0),
            gate_node_id=str(raw.get("gate_node_id") or "").strip(),
            downstream_node_id=str(raw.get("downstream_node_id") or "").strip(),
            session_id=str(raw.get("session_id") or "").strip(),
            requester_principal=str(raw.get("requester_principal") or "").strip(),
            acting_agent_id=str(raw.get("acting_agent_id") or "").strip(),
            approver_policy_kind=str(raw.get("approver_policy_kind") or "").strip(),
            approver_policy_value=raw.get("approver_policy_value"),
            connector_id=_optional_text(raw.get("connector_id")),
            action_id=_optional_text(raw.get("action_id")),
            action_params_digest=str(raw.get("action_params_digest") or ""),
            resource_ref=_optional_text(raw.get("resource_ref")),
            resource_version=_optional_text(raw.get("resource_version")),
            policy_version=_optional_text(raw.get("policy_version")),
            intent_digest=str(raw.get("intent_digest") or ""),
            status=status,
            version=int(raw.get("version") or 1),
            requested_at=str(raw.get("requested_at") or ""),
            expires_at=str(raw.get("expires_at") or ""),
            decided_at=_optional_text(raw.get("decided_at")),
            decided_by=_optional_text(raw.get("decided_by")),
            decision_note=_optional_text(raw.get("decision_note")),
            consumed_at=_optional_text(raw.get("consumed_at")),
            result_digest=_optional_text(raw.get("result_digest")),
            resource_grantor_ref=_optional_text(raw.get("resource_grantor_ref")),
            target_action_description=str(raw.get("target_action_description") or ""),
            summary=str(raw.get("summary") or ""),
        )
        if request.version < 1 or request.graph_run_version_at_request < 0:
            raise ValueError("invalid approval version")
        return request


class ApprovalStore:
    """SQLite persistence for ApprovalRequest rows."""

    _UNIQUE_GATE_INDEX = "uq_workflow_approvals_run_gate"

    @classmethod
    def _has_unique_gate_index(cls, conn: sqlite3.Connection) -> bool:
        """Return whether the approval gate uniqueness migration is complete.

        ``CREATE INDEX IF NOT EXISTS`` is deliberately not used as the probe:
        SQLite treats an existing index with the same name as satisfied even
        when it is non-unique or covers the wrong columns.  Inspecting the
        catalog keeps the expensive duplicate scan on the migration path only
        while still failing closed for a malformed index definition.
        """

        index = conn.execute(
            """
            SELECT "unique", partial
            FROM pragma_index_list(?)
            WHERE name = ?
            """,
            ("workflow_approvals", cls._UNIQUE_GATE_INDEX),
        ).fetchone()
        if index is None or int(index["unique"]) != 1 or int(index["partial"]) != 0:
            return False
        columns = conn.execute(
            """
            SELECT name
            FROM pragma_index_info(?)
            ORDER BY seqno
            """,
            (cls._UNIQUE_GATE_INDEX,),
        ).fetchall()
        return [str(column["name"]) for column in columns] == ["run_id", "gate_node_id"]

    def __init__(
        self,
        db_path: Optional[Path | str] = None,
        *,
        workflow_store: Any = None,
        root: Optional[Path | str] = None,
    ) -> None:
        if workflow_store is not None:
            path = getattr(workflow_store, "db_path", None)
            if path is None:
                raise ValueError("workflow_store must expose db_path")
            self.db_path = Path(path).expanduser().resolve(strict=False)
        elif db_path is not None:
            candidate = Path(db_path).expanduser()
            # A caller passing a directory gets the same conventional filename
            # as WorkflowStore(root=...).
            self.db_path = (candidate / "workflows.sqlite3" if candidate.suffix == "" else candidate).resolve(strict=False)
        else:
            base = Path(root).expanduser() if root is not None else None
            if base is None:
                from .store import default_workflows_root

                base = default_workflows_root()
            self.db_path = (base / "workflows.sqlite3").resolve(strict=False)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._ensure_schema()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(
            str(self.db_path),
            timeout=10.0,
            isolation_level=None,
            check_same_thread=False,
        )
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys=ON")
        conn.execute("PRAGMA busy_timeout=10000")
        return conn

    def _ensure_schema(self) -> None:
        conn = self._connect()
        try:
            with contextlib.suppress(sqlite3.Error):
                conn.execute("PRAGMA journal_mode=WAL")
                conn.execute("PRAGMA synchronous=NORMAL")
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS workflow_approvals(
                    approval_id TEXT PRIMARY KEY,
                    workflow_id TEXT NOT NULL,
                    workflow_revision INTEGER NOT NULL,
                    workflow_digest TEXT NOT NULL,
                    run_id TEXT NOT NULL,
                    gate_node_id TEXT NOT NULL,
                    session_id TEXT NOT NULL,
                    intent_digest TEXT NOT NULL,
                    status TEXT NOT NULL,
                    version INTEGER NOT NULL,
                    request_json TEXT NOT NULL,
                    decision_json TEXT,
                    requested_at TEXT NOT NULL,
                    expires_at TEXT NOT NULL,
                    decided_at TEXT,
                    consumed_at TEXT
                )
                """
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_workflow_approvals_run_gate ON workflow_approvals(run_id, gate_node_id)"
            )
            if not self._has_unique_gate_index(conn):
                # One gate represents one immutable authorization intent for
                # the lifetime of a GraphRun.  Older MVP databases only had
                # the non-unique lookup index above; fail closed when such a
                # database already contains ambiguous duplicate rows instead
                # of silently picking one during recovery.  Valid current
                # databases skip this historical-table scan entirely.
                duplicate = conn.execute(
                    """
                    SELECT run_id, gate_node_id, COUNT(*) AS row_count
                    FROM workflow_approvals
                    GROUP BY run_id, gate_node_id
                    HAVING COUNT(*) > 1
                    LIMIT 1
                    """
                ).fetchone()
                if duplicate is not None:
                    raise ApprovalCorruptError(
                        f"{duplicate['run_id']}:{duplicate['gate_node_id']}",
                        "duplicate approval rows exist for one workflow gate",
                    )
                try:
                    conn.execute(
                        """
                        CREATE UNIQUE INDEX IF NOT EXISTS
                            uq_workflow_approvals_run_gate
                        ON workflow_approvals(run_id, gate_node_id)
                        """
                    )
                except sqlite3.IntegrityError as exc:
                    # Keep migration failures typed even if another process
                    # inserted a duplicate between the explicit check and
                    # index creation.
                    raise ApprovalCorruptError(
                        "workflow_approvals",
                        "cannot enforce unique approval gate rows",
                    ) from exc
                if not self._has_unique_gate_index(conn):
                    # SQLite's IF NOT EXISTS is name-based.  If a damaged
                    # database already contains an index with this name but
                    # the wrong uniqueness/columns/partial predicate, the
                    # CREATE above is a silent no-op.  Never claim the
                    # invariant is enforced in that case, and never drop the
                    # user's index automatically.
                    raise ApprovalCorruptError(
                        "workflow_approvals",
                        "cannot enforce unique approval gate rows",
                    )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_workflow_approvals_session ON workflow_approvals(session_id, requested_at)"
            )
        finally:
            conn.close()

    @contextlib.contextmanager
    def _transaction(self) -> Iterator[sqlite3.Connection]:
        conn = self._connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            try:
                yield conn
            except BaseException:
                with contextlib.suppress(sqlite3.Error):
                    conn.rollback()
                raise
            else:
                conn.commit()
        finally:
            conn.close()

    @staticmethod
    def _decode(row: sqlite3.Row) -> ApprovalRequest:
        approval_id = str(row["approval_id"])
        try:
            raw = json.loads(str(row["request_json"]))
            if not isinstance(raw, Mapping):
                raise ValueError("request JSON must be an object")
            request = ApprovalRequest.from_dict(raw)
        except (TypeError, ValueError, json.JSONDecodeError, RecursionError, OverflowError) as exc:
            raise ApprovalCorruptError(approval_id) from exc
        if request.approval_id != approval_id:
            raise ApprovalCorruptError(approval_id, "approval identity column does not match JSON")
        # The request JSON is the durable immutable intent projection.  Every
        # indexed identity/binding column must agree with it; otherwise a
        # partial SQLite edit could retarget an approved record while leaving
        # its old digest in place.
        expected_columns = {
            "workflow_id": request.workflow_id,
            "workflow_revision": int(request.workflow_revision),
            "workflow_digest": request.workflow_digest,
            "run_id": request.run_id,
            "gate_node_id": request.gate_node_id,
            "session_id": request.session_id,
            "intent_digest": request.intent_digest,
            "requested_at": request.requested_at,
            "expires_at": request.expires_at,
        }
        for column, expected in expected_columns.items():
            actual = row[column]
            if column in {"workflow_revision"}:
                try:
                    actual = int(actual)
                except (TypeError, ValueError) as exc:
                    raise ApprovalCorruptError(approval_id) from exc
            elif actual is not None:
                actual = str(actual)
            if actual != expected:
                raise ApprovalCorruptError(approval_id, f"approval {column} does not match request JSON")
        try:
            calculated_intent_digest = request.calculated_intent_digest()
        except (TypeError, ValueError, RecursionError) as exc:
            raise ApprovalCorruptError(approval_id, "approval intent cannot be canonically decoded") from exc
        if not request.intent_digest or request.intent_digest != calculated_intent_digest:
            raise ApprovalCorruptError(approval_id, "approval intent digest mismatch")
        # Mutable state is duplicated in columns so operators can inspect the
        # table without parsing the JSON.  Columns are authoritative on load.
        try:
            request.status = ApprovalStatus(str(row["status"]))
        except ValueError as exc:
            raise ApprovalCorruptError(approval_id, "invalid approval status") from exc
        try:
            request.version = int(row["version"])
        except (TypeError, ValueError) as exc:
            raise ApprovalCorruptError(approval_id, "invalid approval version") from exc
        if request.version < 1:
            raise ApprovalCorruptError(approval_id, "approval version must be positive")
        request.intent_digest = str(row["intent_digest"])
        request.requested_at = str(row["requested_at"])
        request.expires_at = str(row["expires_at"])
        request.decided_at = _optional_text(row["decided_at"])
        request.consumed_at = _optional_text(row["consumed_at"])
        decision_json = row["decision_json"]
        if decision_json:
            try:
                decision = json.loads(str(decision_json))
            except (TypeError, ValueError, json.JSONDecodeError) as exc:
                raise ApprovalCorruptError(approval_id, "invalid decision JSON") from exc
            if isinstance(decision, Mapping):
                request.decided_by = _optional_text(decision.get("decided_by"))
                request.decision_note = _optional_text(decision.get("decision_note"))
                request.result_digest = _optional_text(decision.get("result_digest"))
            else:
                raise ApprovalCorruptError(approval_id, "decision JSON must be an object")
        if request.status is ApprovalStatus.PENDING:
            if decision_json or request.decided_at or request.consumed_at:
                raise ApprovalCorruptError(approval_id, "pending approval has terminal state fields")
        elif request.status is ApprovalStatus.CONSUMED:
            if not decision_json or not request.decided_at or not request.consumed_at or not request.result_digest:
                raise ApprovalCorruptError(approval_id, "consumed approval is missing terminal evidence")
        else:
            if not decision_json or not request.decided_at or request.consumed_at:
                raise ApprovalCorruptError(approval_id, "decided approval has inconsistent terminal fields")
        return request

    def _fetch(self, conn: sqlite3.Connection, approval_id: str) -> Optional[ApprovalRequest]:
        row = conn.execute(
            "SELECT * FROM workflow_approvals WHERE approval_id = ?", (approval_id,)
        ).fetchone()
        return self._decode(row) if row is not None else None

    def create(self, request: ApprovalRequest) -> ApprovalRequest:
        if request.resource_grantor_ref is not None:
            raise ApprovalExternalGrantorUnsupported()
        if request.status is not ApprovalStatus.PENDING:
            raise ValueError("new approval must be pending")
        if not request.intent_digest:
            request.intent_digest = request.calculated_intent_digest()
        if request.intent_digest != request.calculated_intent_digest():
            raise ApprovalIntentMismatch(request.approval_id)
        payload = json.dumps(request.to_dict(), ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        try:
            with self._transaction() as conn:
                conn.execute(
                    """
                    INSERT INTO workflow_approvals(
                        approval_id, workflow_id, workflow_revision, workflow_digest,
                        run_id, gate_node_id, session_id, intent_digest, status,
                        version, request_json, decision_json, requested_at, expires_at,
                        decided_at, consumed_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, NULL)
                    """,
                    (
                        request.approval_id,
                        request.workflow_id,
                        int(request.workflow_revision),
                        request.workflow_digest,
                        request.run_id,
                        request.gate_node_id,
                        request.session_id,
                        request.intent_digest,
                        request.status.value,
                        int(request.version),
                        payload,
                        request.requested_at,
                        request.expires_at,
                    ),
                )
        except sqlite3.IntegrityError as exc:
            # Concurrent ensure_for_gate callers may construct different
            # random approval IDs for the same immutable intent.  The unique
            # (run_id, gate_node_id) index elects one row; return it only when
            # every binding digest agrees, and fail closed for a retargeted
            # insert.
            existing = self.find_for_gate(
                request.run_id,
                request.gate_node_id,
                session_id=request.session_id,
            )
            if existing is not None:
                if (
                    existing.intent_digest == request.intent_digest
                    and existing.calculated_intent_digest() == request.intent_digest
                    and existing.workflow_id == request.workflow_id
                    and int(existing.workflow_revision) == int(request.workflow_revision)
                    and existing.workflow_digest == request.workflow_digest
                    and existing.run_id == request.run_id
                    and existing.gate_node_id == request.gate_node_id
                    and existing.session_id == request.session_id
                ):
                    return existing
                raise ApprovalIntentMismatch(existing.approval_id) from exc
            # A primary-key collision with an unrelated gate remains a normal
            # state conflict; do not expose the SQLite error to API clients.
            raise ApprovalConflict(request.approval_id, "approval already exists") from exc
        return request

    def load(self, approval_id: str, *, now: Optional[str] = None) -> Optional[ApprovalRequest]:
        aid = _approval_id(approval_id)
        conn = self._connect()
        try:
            request = self._fetch(conn, aid)
        finally:
            conn.close()
        if request is None:
            return None
        if request.status is ApprovalStatus.PENDING and request.expires_at:
            try:
                expired = _parse_time(now or _utc_now()) >= _parse_time(request.expires_at)
            except (TypeError, ValueError, OverflowError):
                expired = True
            if expired:
                try:
                    return self.expire(aid, expected_version=request.version, now=now)
                except ApprovalConflict:
                    latest = self.load(aid, now=None)
                    return latest
        return request

    def get(self, approval_id: str, *, now: Optional[str] = None) -> ApprovalRequest:
        request = self.load(approval_id, now=now)
        if request is None:
            raise ApprovalNotFound(str(approval_id))
        return request

    def list_for_run(
        self,
        run_id: str,
        *,
        session_id: Optional[str] = None,
        include_consumed: bool = True,
        now: Optional[str] = None,
    ) -> list[ApprovalRequest]:
        conn = self._connect()
        try:
            rows = conn.execute(
                "SELECT * FROM workflow_approvals WHERE run_id = ? ORDER BY requested_at, approval_id",
                (str(run_id),),
            )
            # Keep the cursor open while decoding, but do not retain every
            # SQLite row alongside the result objects returned to the caller.
            result: list[ApprovalRequest] = []
            pending_indexes: list[int] = []
            for row in rows:
                request = self._decode(row)
                if session_id is not None and request.session_id != str(session_id):
                    continue
                if not include_consumed and request.status is ApprovalStatus.CONSUMED:
                    continue
                # Defer lazy expiration until after the read cursor closes;
                # expiry may write through a second connection and a live
                # cursor would otherwise hold a SQLite read lock.
                if request.status is ApprovalStatus.PENDING:
                    pending_indexes.append(len(result))
                result.append(request)
        finally:
            conn.close()
        for index in pending_indexes:
            result[index] = self.get(result[index].approval_id, now=now)
        if not include_consumed:
            result = [request for request in result if request.status is not ApprovalStatus.CONSUMED]
        return result

    def find_for_gate(self, run_id: str, gate_node_id: str, *, session_id: Optional[str] = None) -> Optional[ApprovalRequest]:
        conn = self._connect()
        try:
            row = conn.execute(
                "SELECT * FROM workflow_approvals WHERE run_id = ? AND gate_node_id = ? ORDER BY requested_at DESC LIMIT 1",
                (str(run_id), str(gate_node_id)),
            ).fetchone()
        finally:
            conn.close()
        if row is None:
            return None
        request = self._decode(row)
        if session_id is not None and request.session_id != str(session_id):
            return None
        return self.get(request.approval_id)

    def _transition(
        self,
        approval_id: str,
        *,
        expected_version: int,
        from_status: ApprovalStatus,
        to_status: ApprovalStatus,
        decided_by: Optional[str] = None,
        decision_note: Optional[str] = None,
        result_digest: Optional[str] = None,
        now: Optional[str] = None,
    ) -> ApprovalRequest:
        aid = _approval_id(approval_id)
        if isinstance(expected_version, bool) or not isinstance(expected_version, int) or expected_version < 1:
            raise ValueError("expected approval version must be a positive integer")
        decided_at = now or _utc_now()
        decision = {
            "decided_by": _optional_text(decided_by),
            "decision_note": _optional_text(decision_note),
            "result_digest": _optional_text(result_digest),
        }
        decision_json = json.dumps(decision, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        with self._transaction() as conn:
            current = self._fetch(conn, aid)
            if current is None:
                raise ApprovalNotFound(aid)
            if current.status is to_status:
                # Replaying the same decision is explicitly idempotent.  A
                # different note/actor is not allowed to rewrite the record.
                if (
                    _optional_text(decided_by) == current.decided_by
                    and _optional_text(decision_note) == current.decision_note
                ) or to_status is ApprovalStatus.CONSUMED:
                    return current
                raise ApprovalConflict(aid, "approval decision replay does not match")
            if current.version != expected_version or current.status is not from_status:
                if current.status is ApprovalStatus.EXPIRED:
                    raise ApprovalExpired(aid)
                raise ApprovalConflict(aid, "approval version or state conflict")
            decided_value = decided_at if to_status is not ApprovalStatus.CONSUMED else current.decided_at
            consumed_value = decided_at if to_status is ApprovalStatus.CONSUMED else current.consumed_at
            updated = conn.execute(
                """
                UPDATE workflow_approvals
                SET status = ?, version = version + 1, decision_json = ?,
                    decided_at = ?, consumed_at = ?
                WHERE approval_id = ? AND version = ? AND status = ?
                """,
                (
                    to_status.value,
                    decision_json if to_status is not ApprovalStatus.CONSUMED else json.dumps(
                        {
                            "decided_by": current.decided_by,
                            "decision_note": current.decision_note,
                            "result_digest": _optional_text(result_digest),
                        },
                        ensure_ascii=False,
                        sort_keys=True,
                        separators=(",", ":"),
                    ),
                    decided_value,
                    consumed_value,
                    aid,
                    expected_version,
                    from_status.value,
                ),
            )
            if updated.rowcount != 1:
                raise ApprovalConflict(aid, "approval version or state conflict")
            result = self._fetch(conn, aid)
            assert result is not None
            return result

    def decide(
        self,
        approval_id: str,
        *,
        decision: str | ApprovalStatus,
        expected_version: int,
        decided_by: Optional[str] = None,
        decision_note: Optional[str] = None,
        now: Optional[str] = None,
    ) -> ApprovalRequest:
        raw = decision.value if isinstance(decision, ApprovalStatus) else str(decision).strip().lower()
        aliases = {"approve": "approved", "reject": "rejected", "cancel": "cancelled", "expire": "expired"}
        raw = aliases.get(raw, raw)
        try:
            target = ApprovalStatus(raw)
        except ValueError as exc:
            raise ValueError("unsupported approval decision") from exc
        if target not in {
            ApprovalStatus.APPROVED,
            ApprovalStatus.REJECTED,
            ApprovalStatus.CANCELLED,
            ApprovalStatus.EXPIRED,
        }:
            raise ValueError("approval decision must be approved, rejected, cancelled, or expired")
        current = self.get(approval_id, now=now)
        if target is not ApprovalStatus.EXPIRED and current.status is ApprovalStatus.PENDING:
            try:
                if _parse_time(now or _utc_now()) >= _parse_time(current.expires_at):
                    current = self.expire(approval_id, expected_version=current.version, now=now)
            except (TypeError, ValueError, OverflowError):
                current = self.expire(approval_id, expected_version=current.version, now=now)
        return self._transition(
            approval_id,
            expected_version=expected_version,
            from_status=ApprovalStatus.PENDING,
            to_status=target,
            decided_by=decided_by,
            decision_note=decision_note,
            now=now,
        )

    def expire(self, approval_id: str, *, expected_version: int, now: Optional[str] = None) -> ApprovalRequest:
        return self._transition(
            approval_id,
            expected_version=expected_version,
            from_status=ApprovalStatus.PENDING,
            to_status=ApprovalStatus.EXPIRED,
            now=now,
        )

    def consume(
        self,
        approval_id: str,
        *,
        expected_version: int,
        result_digest: str,
        now: Optional[str] = None,
    ) -> ApprovalRequest:
        current = self.get(approval_id, now=now)
        if current.status is ApprovalStatus.CONSUMED:
            if current.result_digest == str(result_digest):
                return current
            raise ApprovalConflict(str(approval_id), "approval result replay does not match")
        if current.status is ApprovalStatus.EXPIRED:
            raise ApprovalExpired(str(approval_id))
        if current.status is not ApprovalStatus.APPROVED:
            raise ApprovalConflict(str(approval_id), "only approved approvals can be consumed")
        return self._transition(
            approval_id,
            expected_version=expected_version,
            from_status=ApprovalStatus.APPROVED,
            to_status=ApprovalStatus.CONSUMED,
            result_digest=str(result_digest),
            now=now,
        )

    # Explicit aliases make the state transition surface easy to discover.
    approve = lambda self, approval_id, *, expected_version, decided_by=None, decision_note=None, now=None: self.decide(
        approval_id,
        decision=ApprovalStatus.APPROVED,
        expected_version=expected_version,
        decided_by=decided_by,
        decision_note=decision_note,
        now=now,
    )
    reject = lambda self, approval_id, *, expected_version, decided_by=None, decision_note=None, now=None: self.decide(
        approval_id,
        decision=ApprovalStatus.REJECTED,
        expected_version=expected_version,
        decided_by=decided_by,
        decision_note=decision_note,
        now=now,
    )


class ApprovalService:
    """Build and reconcile approvals for a compiled Workflow run."""

    def __init__(
        self,
        store: ApprovalStore,
        *,
        graph_store: Optional[GraphRunStore] = None,
        workflow_store: Any = None,
        policy_resolver: Any = None,
    ) -> None:
        self.store = store
        self.graph_store = graph_store
        self.workflow_store = workflow_store
        self.policy_resolver = policy_resolver

    def authorize_decision(
        self,
        request: ApprovalRequest,
        *,
        approver_principal: str,
        session_id: str,
    ) -> None:
        """Fail closed for policies that lack a real identity resolver.

        ``any`` and ``session_owner`` are verifiable in this local service
        because the server supplies the authenticated owner/session binding.
        User/role/group policies need an account directory callback; silently
        treating a local token as every role would make approval meaningless.
        """

        policy_kind = str(request.approver_policy_kind or "").strip()
        principal = str(approver_principal or "").strip()
        if not principal or not str(session_id or "").strip():
            raise ApprovalPolicyUnsupported(policy_kind or "unknown")
        if policy_kind == "any":
            return
        if policy_kind == "session_owner":
            if principal == request.requester_principal and str(session_id) == request.session_id:
                return
            raise ApprovalConflict(request.approval_id, "approver is not the session owner")
        if self.policy_resolver is None:
            raise ApprovalPolicyUnsupported(policy_kind)
        try:
            allowed = self.policy_resolver(
                policy_kind,
                request.approver_policy_value,
                principal,
                request,
            )
        except Exception as exc:
            raise ApprovalPolicyUnsupported(policy_kind) from exc
        if not allowed:
            raise ApprovalConflict(request.approval_id, "approver does not satisfy policy")

    @staticmethod
    def _downstream_node_id(run: GraphRun, gate_node_id: str) -> str:
        targets = [edge.target for edge in run.edges if edge.source == gate_node_id]
        if len(targets) != 1:
            raise ApprovalConflict("unknown", "approval gate must have one downstream node")
        return targets[0]

    def build_request(
        self,
        run: GraphRun,
        gate_node_id: str,
        *,
        requester_principal: str,
        acting_agent_id: str = "",
        now: Optional[str] = None,
        approval_id: Optional[str] = None,
    ) -> ApprovalRequest:
        node = run.nodes.get(str(gate_node_id))
        if node is None:
            raise ApprovalNotFound(str(gate_node_id))
        if str(node.meta.get("workflow_node_kind") or "") != "approval_gate":
            raise ApprovalConflict(str(gate_node_id), "node is not an approval gate")
        workflow_id = str(run.workflow_id or run.meta.get("workflow_id") or "").strip()
        workflow_revision = run.workflow_revision or run.meta.get("workflow_revision")
        workflow_digest = str(run.workflow_digest or run.meta.get("workflow_digest") or "").strip()
        if not workflow_id or workflow_revision is None or not workflow_digest:
            raise ApprovalConflict(str(gate_node_id), "run has no exact workflow binding")
        config = node.meta.get("workflow_config")
        if not isinstance(config, Mapping):
            config = node.meta.get("config") if isinstance(node.meta.get("config"), Mapping) else {}
        grantor = config.get("resource_grantor_ref")
        if grantor is not None:
            raise ApprovalExternalGrantorUnsupported()
        policy_kind = str(config.get("approver_policy_kind") or "").strip()
        if policy_kind not in SUPPORTED_APPROVER_POLICY_KINDS:
            raise ApprovalConflict(str(gate_node_id), "unsupported approver policy")
        ttl_raw = config.get("ttl_seconds", MIN_APPROVAL_TTL_SECONDS)
        if isinstance(ttl_raw, bool) or not isinstance(ttl_raw, int):
            raise ValueError("approval ttl must be an integer")
        ttl = min(MAX_APPROVAL_TTL_SECONDS, max(MIN_APPROVAL_TTL_SECONDS, ttl_raw))
        requested_at = now or _utc_now()
        expires_at = (
            _parse_time(requested_at) + timedelta(seconds=ttl)
        ).isoformat().replace("+00:00", "Z")
        downstream = self._downstream_node_id(run, str(gate_node_id))
        connector_id = _optional_text(config.get("connector_id"))
        action_id = _optional_text(config.get("action_id"))
        action_params = config.get("action_params", config.get("params", {}))
        # A gate's immutable definition describes the business operation, but
        # a reachable approval must also bind the exact upstream draft and the
        # constrained artifact contract it will authorize.  Runtime stores
        # this projection after the draft node completes; it is already
        # bounded JSON and never comes from a renderer path or a file read.
        approval_intent = node.meta.get("workflow_approval_intent")
        if isinstance(approval_intent, Mapping):
            action_params = {
                "configured": action_params,
                "workflow_draft": {
                    "source_node_id": approval_intent.get("draft_source_node_id"),
                    "digest": approval_intent.get("draft_digest"),
                    "summary": approval_intent.get("draft_summary"),
                },
                "artifact_contract": approval_intent.get("artifact_contract", {}),
            }
        calculated_action_params_digest = canonical_digest(action_params)
        supplied_action_params_digest = config.get("action_params_digest")
        if supplied_action_params_digest is not None and str(supplied_action_params_digest).strip():
            if str(supplied_action_params_digest).strip() != calculated_action_params_digest:
                raise ApprovalIntentMismatch(str(gate_node_id))
        # Always derive this digest from the exact operation parameters.  A
        # caller supplied summary may be checked as an assertion, but never
        # allowed to redefine the operation that the approval represents.
        action_params_digest = calculated_action_params_digest
        draft_summary = ""
        artifact_contract = approval_intent.get("artifact_contract") if isinstance(approval_intent, Mapping) else None
        if isinstance(approval_intent, Mapping):
            draft_summary = str(approval_intent.get("draft_summary") or "").strip()
        contract_basename = ""
        contract_formats: list[str] = []
        if isinstance(artifact_contract, Mapping):
            contract_basename = str(artifact_contract.get("output_basename") or "").strip()
            raw_formats = artifact_contract.get("formats")
            if isinstance(raw_formats, (list, tuple)):
                contract_formats = [str(item).strip() for item in raw_formats if str(item).strip()][:8]
        configured_summary = str(config.get("summary") or "")
        configured_action = str(config.get("target_action_description") or config.get("target_action") or "")
        if draft_summary:
            configured_summary = f"{configured_summary} · 草稿摘要：{draft_summary}"[:4096]
        if contract_basename or contract_formats:
            contract_text = "basename=" + contract_basename
            if contract_formats:
                contract_text += "; formats=" + ",".join(contract_formats)
            configured_action = f"{configured_action}（{contract_text}）"[:4096]
        request = ApprovalRequest(
            approval_id=str(approval_id or f"ap_{uuid.uuid4().hex[:20]}"),
            workflow_id=validate_workflow_id(workflow_id),
            workflow_revision=validate_revision(workflow_revision),
            workflow_digest=workflow_digest,
            run_id=str(run.run_id),
            graph_run_version_at_request=int(run.version),
            gate_node_id=str(gate_node_id),
            downstream_node_id=downstream,
            session_id=str(run.session_id),
            requester_principal=str(requester_principal or "").strip(),
            acting_agent_id=str(acting_agent_id or "").strip(),
            approver_policy_kind=policy_kind,
            approver_policy_value=config.get("approver_policy_value"),
            connector_id=connector_id,
            action_id=action_id,
            action_params_digest=action_params_digest,
            resource_ref=_optional_text(config.get("resource_ref")),
            resource_version=_optional_text(config.get("resource_version")),
            policy_version=_optional_text(config.get("policy_version")),
            requested_at=requested_at,
            expires_at=expires_at,
            resource_grantor_ref=None,
            target_action_description=configured_action,
            summary=configured_summary,
        )
        request.intent_digest = request.calculated_intent_digest()
        return request

    def ensure_for_gate(
        self,
        run: GraphRun,
        gate_node_id: str,
        *,
        requester_principal: str,
        acting_agent_id: str = "",
        now: Optional[str] = None,
    ) -> ApprovalRequest:
        existing = self.store.find_for_gate(run.run_id, gate_node_id, session_id=run.session_id)
        if existing is not None:
            if (
                existing.workflow_id != run.workflow_id
                or existing.workflow_revision != run.workflow_revision
                or existing.workflow_digest != run.workflow_digest
                or existing.session_id != run.session_id
            ):
                raise ApprovalIntentMismatch(existing.approval_id)
            return existing
        return self.store.create(
            self.build_request(
                run,
                gate_node_id,
                requester_principal=requester_principal,
                acting_agent_id=acting_agent_id,
                now=now,
            )
        )

    def resume_after_approval(
        self,
        approval_id: str,
        *,
        session_id: str,
        expected_version: Optional[int] = None,
        expected_run_version: Optional[int] = None,
        result_digest: Optional[str] = None,
        now: Optional[str] = None,
    ) -> tuple[ApprovalRequest, GraphRun]:
        """Mark the exact gate done via GraphRun CAS, then consume the row.

        The order is deliberate.  If the process dies after the graph save,
        the next retry observes the exact completed gate and only finishes the
        one-time consume transition.
        """
        request = self.store.get(approval_id, now=now)
        if (
            isinstance(expected_version, bool)
            or expected_version is None
            or not isinstance(expected_version, int)
            or expected_version < 1
        ):
            raise ApprovalConflict(request.approval_id, "expected approval version is required")
        sid = str(session_id or "").strip()
        if not sid or request.session_id != sid:
            raise ApprovalIntentMismatch(request.approval_id)
        if request.status is ApprovalStatus.EXPIRED:
            raise ApprovalExpired(request.approval_id)
        if request.status is not ApprovalStatus.APPROVED and request.status is not ApprovalStatus.CONSUMED:
            raise ApprovalConflict(request.approval_id, "approval is not approved")
        if request.status is ApprovalStatus.APPROVED and request.version != expected_version:
            raise ApprovalConflict(request.approval_id, "approval version conflict")
        if request.status is ApprovalStatus.CONSUMED and expected_version not in {
            request.version,
            max(1, request.version - 1),
        }:
            raise ApprovalConflict(request.approval_id, "approval version conflict")
        if self.graph_store is None:
            raise ApprovalError("graph store is required to resume an approval")
        run = self.graph_store.load(request.run_id)
        if run is None:
            raise ApprovalNotFound(request.run_id)
        run_binding = (
            str(run.workflow_id or ""),
            int(run.workflow_revision or 0),
            str(run.workflow_digest or ""),
        )
        expected_binding = (
            request.workflow_id,
            int(request.workflow_revision),
            request.workflow_digest,
        )
        if run.session_id != request.session_id or run_binding != expected_binding:
            raise ApprovalIntentMismatch(request.approval_id)
        node = run.nodes.get(request.gate_node_id)
        if node is None:
            raise ApprovalIntentMismatch(request.approval_id)
        if str(node.meta.get("workflow_node_kind") or "") != "approval_gate":
            raise ApprovalIntentMismatch(request.approval_id)
        downstream = [
            edge.target
            for edge in run.edges
            if edge.kind is EdgeKind.DEPENDS and edge.source == request.gate_node_id
        ]
        if len(downstream) != 1 or downstream[0] != request.downstream_node_id:
            raise ApprovalIntentMismatch(request.approval_id)
        # A terminal run may only be replayed when this exact gate was already
        # marked DONE.  In particular, an approved sibling gate must not be
        # resumed after another parallel gate rejected the run: the approval
        # row is durable, but the GraphRun is no longer actionable.
        if node.status is not NodeStatus.DONE and str(run.status or "") in {
            "failed",
            "closed",
            "completed",
        }:
            raise ApprovalConflict(request.approval_id, "workflow run is terminal")
        default_result_digest = canonical_digest(
            {"approval_id": request.approval_id, "intent_digest": request.intent_digest}
        )
        supplied_result_digest = str(result_digest or default_result_digest)
        if node.status is NodeStatus.DONE:
            if str(node.meta.get("approval_id") or "") != request.approval_id:
                raise ApprovalIntentMismatch(request.approval_id)
            if str(node.meta.get("approval_intent_digest") or "") != request.intent_digest:
                raise ApprovalIntentMismatch(request.approval_id)
            existing = str(node.meta.get("approval_result_digest") or "")
            if not existing:
                raise ApprovalIntentMismatch(request.approval_id)
            # A retry after the graph CAS may omit the optional result digest;
            # in that crash window the persisted node digest is authoritative.
            if existing:
                if result_digest is not None and existing != supplied_result_digest:
                    raise ApprovalConflict(request.approval_id, "completed approval result does not match")
                supplied_result_digest = existing
        elif request.status is ApprovalStatus.APPROVED:
            working = GraphRun.from_dict(run.to_dict())
            working_node = working.nodes[request.gate_node_id]
            working_node.status = NodeStatus.DONE
            working_node.meta.update(
                {
                    "approval_id": request.approval_id,
                    "approval_intent_digest": request.intent_digest,
                    "approval_result_digest": supplied_result_digest,
                    "approval_status": "approved",
                    "approval_evidence": {
                        "decided_by": request.decided_by,
                        "decided_at": request.decided_at,
                    },
                }
            )
            working.run_state.current_nodes = [
                node_id
                for node_id, candidate in working.nodes.items()
                if candidate.status is NodeStatus.READY
            ]
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
            except GraphRunVersionConflict:
                latest = self.graph_store.load(request.run_id)
                if latest is None:
                    raise ApprovalNotFound(request.run_id)
                latest_node = latest.nodes.get(request.gate_node_id)
                if latest_node is None or latest_node.status is not NodeStatus.DONE:
                    raise
                if str(latest_node.meta.get("approval_id") or "") != request.approval_id:
                    raise ApprovalIntentMismatch(request.approval_id)
                if str(latest_node.meta.get("approval_intent_digest") or "") != request.intent_digest:
                    raise ApprovalIntentMismatch(request.approval_id)
                existing = str(latest_node.meta.get("approval_result_digest") or "")
                if not existing:
                    raise ApprovalIntentMismatch(request.approval_id)
                if result_digest is not None and existing != supplied_result_digest:
                    raise ApprovalConflict(request.approval_id, "completed approval result does not match")
                supplied_result_digest = existing
                run = latest
            else:
                run = working

        elif request.status is ApprovalStatus.CONSUMED:
            # A consumed row is only a valid replay after the matching gate
            # evidence has already been durably recorded.  Returning success
            # for a manually consumed row would detach the approval state from
            # the GraphRun it authorized.
            raise ApprovalIntentMismatch(request.approval_id)

        if request.status is ApprovalStatus.APPROVED:
            consumed = self.store.consume(
                request.approval_id,
                expected_version=request.version,
                result_digest=supplied_result_digest,
                now=now,
            )
            request = consumed
        return request, run


__all__ = [
    "ApprovalConflict",
    "ApprovalError",
    "ApprovalExpired",
    "ApprovalExternalGrantorUnsupported",
    "ApprovalIntentMismatch",
    "ApprovalNotFound",
    "ApprovalPolicyUnsupported",
    "ApprovalRequest",
    "ApprovalService",
    "ApprovalStatus",
    "ApprovalStore",
]
