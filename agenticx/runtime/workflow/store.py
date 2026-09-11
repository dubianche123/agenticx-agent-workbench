"""SQLite-backed immutable Workflow revision store.

Each mutating operation opens its own connection and starts ``BEGIN
IMMEDIATE``.  The head check and revision insert therefore form one database
transaction even when independent service instances race on the same file.
"""

from __future__ import annotations

import contextlib
import json
import os
import secrets
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator, List, Optional, Sequence, Tuple

from agenticx.utils.agx_home import agx_home

from .connectors import get_connector_catalog
from .models import (
    MAX_LABEL_LENGTH,
    MAX_STRING_LENGTH,
    WorkflowManifest,
    WorkflowModelError,
    WorkflowSnapshot,
    snapshot_from_draft,
    validate_revision,
    validate_workflow_id,
    verify_snapshot_digest,
)
from .validation import WorkflowValidationError, validate_workflow


class WorkflowStoreError(RuntimeError):
    """Base class for typed Workflow persistence errors."""


class WorkflowVersionConflict(WorkflowStoreError):
    def __init__(self, workflow_id: str, *, expected: int, actual: int) -> None:
        self.workflow_id = workflow_id
        self.expected = int(expected)
        self.actual = int(actual)
        self.expected_head_revision = self.expected
        self.actual_head_revision = self.actual
        super().__init__(
            f"workflow {workflow_id!r} head version conflict: expected {expected}, actual {actual}"
        )


class WorkflowNotFound(WorkflowStoreError):
    def __init__(self, workflow_id: str, revision: Optional[int] = None) -> None:
        self.workflow_id = workflow_id
        self.revision = revision
        detail = f" revision {revision}" if revision is not None else ""
        super().__init__(f"workflow {workflow_id!r}{detail} was not found")


class WorkflowOwnershipError(WorkflowStoreError):
    def __init__(self, workflow_id: str, owner_scope: str) -> None:
        self.workflow_id = workflow_id
        self.owner_scope = owner_scope
        self.requested_owner_scope = owner_scope
        super().__init__(f"workflow {workflow_id!r} is not owned by the requested scope")


class WorkflowCorruptError(WorkflowStoreError):
    def __init__(self, workflow_id: str, revision: Optional[int], message: str) -> None:
        self.workflow_id = workflow_id
        self.revision = revision
        self.reason = message
        detail = f" revision {revision}" if revision is not None else ""
        super().__init__(f"corrupt workflow {workflow_id!r}{detail}: {message}")


def default_workflows_root() -> Path:
    override = str(os.environ.get("AGX_WORKFLOWS_ROOT") or "").strip()
    if override:
        return Path(override).expanduser()
    return agx_home() / "workflows"


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _owner_scope(value: Any) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError("owner_scope must be a non-empty string")
    result = value.strip()
    if len(result) > MAX_STRING_LENGTH:
        raise ValueError("owner_scope is too large")
    return result


class WorkflowStore:
    """Persist immutable Workflow snapshots and publication metadata."""

    def __init__(self, root: Optional[Path] = None, *, db_path: Optional[Path] = None) -> None:
        if db_path is not None:
            self.db_path = Path(db_path).expanduser().resolve(strict=False)
            self.root = self.db_path.parent
        else:
            self.root = Path(root) if root is not None else default_workflows_root()
            self.root = self.root.expanduser().resolve(strict=False)
            self.db_path = self.root / "workflows.sqlite3"
        self.root.mkdir(parents=True, exist_ok=True)
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
            # WAL is a file-level optimization.  A deployment on a filesystem
            # that does not support it still remains correct under the same
            # immediate transactions, so this is intentionally best-effort.
            with contextlib.suppress(sqlite3.Error):
                conn.execute("PRAGMA journal_mode=WAL")
                conn.execute("PRAGMA synchronous=NORMAL")
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS workflow_heads(
                    workflow_id TEXT PRIMARY KEY,
                    owner_scope TEXT NOT NULL,
                    title TEXT NOT NULL,
                    head_revision INTEGER NOT NULL CHECK(head_revision > 0),
                    active_published_revision INTEGER,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS workflow_revisions(
                    workflow_id TEXT NOT NULL,
                    revision INTEGER NOT NULL CHECK(revision > 0),
                    digest TEXT NOT NULL,
                    snapshot_json TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    PRIMARY KEY(workflow_id, revision),
                    UNIQUE(workflow_id, digest),
                    FOREIGN KEY(workflow_id) REFERENCES workflow_heads(workflow_id)
                );

                CREATE TABLE IF NOT EXISTS workflow_publications(
                    workflow_id TEXT NOT NULL,
                    revision INTEGER NOT NULL CHECK(revision > 0),
                    digest TEXT NOT NULL,
                    published_at TEXT NOT NULL,
                    PRIMARY KEY(workflow_id, revision),
                    FOREIGN KEY(workflow_id, revision)
                        REFERENCES workflow_revisions(workflow_id, revision)
                );

                CREATE INDEX IF NOT EXISTS idx_workflow_heads_owner
                    ON workflow_heads(owner_scope, updated_at);
                CREATE INDEX IF NOT EXISTS idx_workflow_publications_workflow
                    ON workflow_publications(workflow_id, revision);
                """
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
    def _safe_id(workflow_id: Any) -> str:
        return validate_workflow_id(workflow_id)

    @staticmethod
    def _safe_revision(revision: Any) -> int:
        return validate_revision(revision)

    @staticmethod
    def _safe_expected_revision(revision: Any) -> int:
        # A zero expected head is a useful stale-CAS sentinel for callers that
        # have not observed a newly-created revision yet.  Actual stored
        # revisions remain strictly positive.
        if isinstance(revision, bool) or not isinstance(revision, int) or revision < 0:
            raise WorkflowModelError("expected head revision must be a non-negative integer", code="invalid_revision", path="expected_head_revision")
        return int(revision)

    def _head_row(
        self, conn: sqlite3.Connection, workflow_id: str, owner_scope: str
    ) -> sqlite3.Row:
        row = conn.execute(
            "SELECT * FROM workflow_heads WHERE workflow_id = ?", (workflow_id,)
        ).fetchone()
        if row is None:
            raise WorkflowNotFound(workflow_id)
        if str(row["owner_scope"]) != owner_scope:
            raise WorkflowOwnershipError(workflow_id, owner_scope)
        return row

    def _snapshot_row(self, row: sqlite3.Row, *, workflow_id: str, revision: int) -> WorkflowSnapshot:
        try:
            raw = json.loads(str(row["snapshot_json"]))
            if not isinstance(raw, dict):
                raise ValueError("snapshot JSON must be an object")
            snapshot = WorkflowSnapshot.from_dict(raw, path="snapshot")
        except (OSError, ValueError, TypeError, json.JSONDecodeError, WorkflowModelError, RecursionError) as exc:
            raise WorkflowCorruptError(workflow_id, revision, f"invalid snapshot JSON: {exc}") from exc
        if snapshot.workflow_id != workflow_id or snapshot.revision != revision:
            raise WorkflowCorruptError(workflow_id, revision, "snapshot identity does not match its row")
        row_digest = str(row["digest"])
        if snapshot.digest != row_digest or not verify_snapshot_digest(snapshot):
            raise WorkflowCorruptError(workflow_id, revision, "snapshot digest mismatch")
        if snapshot.created_at != str(row["created_at"]):
            raise WorkflowCorruptError(workflow_id, revision, "snapshot timestamp does not match its row")
        try:
            normalized = validate_workflow(snapshot, connector_catalog=get_connector_catalog())
        except WorkflowValidationError as exc:
            raise WorkflowCorruptError(workflow_id, revision, f"snapshot validation failed: {exc.message}") from exc
        if normalized.digest != row_digest:
            raise WorkflowCorruptError(workflow_id, revision, "normalized snapshot digest mismatch")
        return normalized

    def _manifest_from_row(
        self,
        conn: sqlite3.Connection,
        row: sqlite3.Row,
        *,
        head_snapshot: Optional[WorkflowSnapshot] = None,
    ) -> WorkflowManifest:
        workflow_id = str(row["workflow_id"])
        head_revision = int(row["head_revision"])
        head_snapshot_row = conn.execute(
            "SELECT * FROM workflow_revisions WHERE workflow_id = ? AND revision = ?",
            (workflow_id, head_revision),
        ).fetchone()
        if head_snapshot_row is None:
            raise WorkflowCorruptError(workflow_id, head_revision, "head has no revision")
        if head_snapshot is None:
            head_snapshot = self._snapshot_row(
                head_snapshot_row, workflow_id=workflow_id, revision=head_revision
            )
        elif head_snapshot.workflow_id != workflow_id or head_snapshot.revision != head_revision:
            raise WorkflowCorruptError(workflow_id, head_revision, "head snapshot identity does not match its row")
        if head_snapshot.title != str(row["title"]):
            raise WorkflowCorruptError(workflow_id, head_revision, "head title does not match snapshot")
        published_rows = conn.execute(
            "SELECT revision, digest FROM workflow_publications WHERE workflow_id = ? ORDER BY revision",
            (workflow_id,),
        ).fetchall()
        published = [int(item["revision"]) for item in published_rows]
        active = row["active_published_revision"]
        active_revision = int(active) if active is not None else None
        if active_revision is not None and active_revision not in published:
            raise WorkflowCorruptError(workflow_id, active_revision, "active publication is missing")
        for publication in published_rows:
            revision = int(publication["revision"])
            revision_row = conn.execute(
                "SELECT * FROM workflow_revisions WHERE workflow_id = ? AND revision = ?",
                (workflow_id, revision),
            ).fetchone()
            if revision_row is None:
                raise WorkflowCorruptError(workflow_id, revision, "publication has no revision")
            if str(publication["digest"]) != str(revision_row["digest"]):
                raise WorkflowCorruptError(workflow_id, revision, "publication digest mismatch")
            if head_snapshot is None or revision != head_snapshot.revision:
                self._snapshot_row(revision_row, workflow_id=workflow_id, revision=revision)
            elif head_snapshot.digest != str(revision_row["digest"]):
                raise WorkflowCorruptError(workflow_id, revision, "publication digest mismatch")
        return WorkflowManifest(
            workflow_id=workflow_id,
            owner_scope=str(row["owner_scope"]),
            title=str(row["title"]),
            head_revision=head_revision,
            published_revisions=published,
            active_published_revision=active_revision,
            created_at=str(row["created_at"]),
            updated_at=str(row["updated_at"]),
        )

    def create(self, owner_scope: str, draft: Any) -> WorkflowSnapshot:
        """Create a server-IDed workflow at immutable revision 1."""

        owner = _owner_scope(owner_scope)
        workflow_id = f"wf_{secrets.token_urlsafe(18).replace('-', '_').replace('=', '')}"
        created_at = _utc_now()
        try:
            candidate = snapshot_from_draft(
                draft,
                workflow_id=workflow_id,
                revision=1,
                created_at=created_at,
            )
            snapshot = validate_workflow(candidate, connector_catalog=get_connector_catalog())
        except WorkflowValidationError:
            raise
        except (WorkflowModelError, ValueError) as exc:
            raise WorkflowValidationError(
                [{"code": getattr(exc, "code", "invalid_workflow"), "message": str(exc), "path": getattr(exc, "path", "")}]
            ) from exc
        payload = json.dumps(snapshot.to_dict(), ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        with self._transaction() as conn:
            try:
                conn.execute(
                    """
                    INSERT INTO workflow_heads(
                        workflow_id, owner_scope, title, head_revision,
                        active_published_revision, created_at, updated_at
                    ) VALUES (?, ?, ?, 1, NULL, ?, ?)
                    """,
                    (workflow_id, owner, snapshot.title, created_at, created_at),
                )
                conn.execute(
                    """
                    INSERT INTO workflow_revisions(
                        workflow_id, revision, digest, snapshot_json, created_at
                    ) VALUES (?, 1, ?, ?, ?)
                    """,
                    (workflow_id, snapshot.digest, payload, created_at),
                )
            except sqlite3.IntegrityError as exc:
                # A random collision is extraordinarily unlikely, but exposing
                # the database error would make callers retry with no typed
                # outcome.  Keep the error explicit and bounded.
                raise WorkflowStoreError("failed to create workflow revision") from exc
        return snapshot

    def append_revision(
        self,
        workflow_id: str,
        owner_scope: str,
        expected_head_revision: int,
        draft: Any,
    ) -> WorkflowSnapshot:
        """Append a complete immutable revision under a cross-connection CAS."""

        workflow_id = self._safe_id(workflow_id)
        owner = _owner_scope(owner_scope)
        expected = self._safe_expected_revision(expected_head_revision)
        with self._transaction() as conn:
            head = self._head_row(conn, workflow_id, owner)
            actual = int(head["head_revision"])
            if actual != expected:
                raise WorkflowVersionConflict(workflow_id, expected=expected, actual=actual)
            next_revision = actual + 1
            created_at = _utc_now()
            try:
                candidate = snapshot_from_draft(
                    draft,
                    workflow_id=workflow_id,
                    revision=next_revision,
                    created_at=created_at,
                )
                snapshot = validate_workflow(candidate, connector_catalog=get_connector_catalog())
            except WorkflowValidationError:
                raise
            except (WorkflowModelError, ValueError) as exc:
                raise WorkflowValidationError(
                    [{"code": getattr(exc, "code", "invalid_workflow"), "message": str(exc), "path": getattr(exc, "path", "")}]
                ) from exc
            payload = json.dumps(snapshot.to_dict(), ensure_ascii=False, sort_keys=True, separators=(",", ":"))
            conn.execute(
                """
                INSERT INTO workflow_revisions(
                    workflow_id, revision, digest, snapshot_json, created_at
                ) VALUES (?, ?, ?, ?, ?)
                """,
                (workflow_id, next_revision, snapshot.digest, payload, created_at),
            )
            updated_at = _utc_now()
            updated = conn.execute(
                """
                UPDATE workflow_heads
                SET title = ?, head_revision = ?, updated_at = ?
                WHERE workflow_id = ? AND owner_scope = ? AND head_revision = ?
                """,
                (snapshot.title, next_revision, updated_at, workflow_id, owner, expected),
            )
            if updated.rowcount != 1:
                # BEGIN IMMEDIATE should make this unreachable, but retaining a
                # conditional update guards future schema/driver changes.
                current = conn.execute(
                    "SELECT head_revision FROM workflow_heads WHERE workflow_id = ?", (workflow_id,)
                ).fetchone()
                actual_after = int(current[0]) if current else 0
                raise WorkflowVersionConflict(workflow_id, expected=expected, actual=actual_after)
        return snapshot

    def publish(
        self,
        workflow_id: str,
        owner_scope: str,
        revision: int,
        expected_head_revision: int,
    ) -> WorkflowManifest:
        """Publish one exact stored revision under a head CAS."""

        workflow_id = self._safe_id(workflow_id)
        owner = _owner_scope(owner_scope)
        revision = self._safe_revision(revision)
        expected = self._safe_expected_revision(expected_head_revision)
        with self._transaction() as conn:
            head = self._head_row(conn, workflow_id, owner)
            actual = int(head["head_revision"])
            if actual != expected:
                raise WorkflowVersionConflict(workflow_id, expected=expected, actual=actual)
            row = conn.execute(
                "SELECT * FROM workflow_revisions WHERE workflow_id = ? AND revision = ?",
                (workflow_id, revision),
            ).fetchone()
            if row is None:
                raise WorkflowNotFound(workflow_id, revision)
            validated_snapshot = self._snapshot_row(row, workflow_id=workflow_id, revision=revision)
            existing = conn.execute(
                "SELECT digest FROM workflow_publications WHERE workflow_id = ? AND revision = ?",
                (workflow_id, revision),
            ).fetchone()
            row_digest = str(row["digest"])
            if existing is not None and str(existing["digest"]) != row_digest:
                raise WorkflowCorruptError(workflow_id, revision, "publication digest mismatch")
            if existing is None:
                conn.execute(
                    """
                    INSERT INTO workflow_publications(workflow_id, revision, digest, published_at)
                    VALUES (?, ?, ?, ?)
                    """,
                    (workflow_id, revision, row_digest, _utc_now()),
                )
                conn.execute(
                    """
                    UPDATE workflow_heads SET active_published_revision = ?, updated_at = ?
                    WHERE workflow_id = ? AND owner_scope = ? AND head_revision = ?
                    """,
                    (revision, _utc_now(), workflow_id, owner, expected),
                )
            else:
                active = head["active_published_revision"]
                if active is None or int(active) != revision:
                    conn.execute(
                        """
                        UPDATE workflow_heads SET active_published_revision = ?, updated_at = ?
                        WHERE workflow_id = ? AND owner_scope = ? AND head_revision = ?
                        """,
                        (revision, _utc_now(), workflow_id, owner, expected),
                    )
            updated_head = conn.execute(
                "SELECT * FROM workflow_heads WHERE workflow_id = ?", (workflow_id,)
            ).fetchone()
            assert updated_head is not None
            # ``revision`` was fully validated above.  Reuse that object when
            # it is the current head, while the manifest path still performs
            # full publication JSON/digest/semantic validation before commit.
            return self._manifest_from_row(
                conn,
                updated_head,
                head_snapshot=(
                    validated_snapshot
                    if revision == int(updated_head["head_revision"])
                    else None
                ),
            )

    def load_revision(
        self, workflow_id: str, revision: int, owner_scope: str
    ) -> WorkflowSnapshot:
        workflow_id = self._safe_id(workflow_id)
        revision = self._safe_revision(revision)
        owner = _owner_scope(owner_scope)
        conn = self._connect()
        try:
            self._head_row(conn, workflow_id, owner)
            row = conn.execute(
                "SELECT * FROM workflow_revisions WHERE workflow_id = ? AND revision = ?",
                (workflow_id, revision),
            ).fetchone()
            if row is None:
                raise WorkflowNotFound(workflow_id, revision)
            return self._snapshot_row(row, workflow_id=workflow_id, revision=revision)
        finally:
            conn.close()

    def load_published_revision(
        self, workflow_id: str, owner_scope: str, revision: Optional[int] = None
    ) -> WorkflowSnapshot:
        workflow_id = self._safe_id(workflow_id)
        owner = _owner_scope(owner_scope)
        conn = self._connect()
        try:
            head = self._head_row(conn, workflow_id, owner)
            selected = (
                self._safe_revision(revision)
                if revision is not None
                else (int(head["active_published_revision"]) if head["active_published_revision"] is not None else None)
            )
            if selected is None:
                raise WorkflowNotFound(workflow_id)
            publication = conn.execute(
                "SELECT digest FROM workflow_publications WHERE workflow_id = ? AND revision = ?",
                (workflow_id, selected),
            ).fetchone()
            if publication is None:
                raise WorkflowNotFound(workflow_id, selected)
            row = conn.execute(
                "SELECT * FROM workflow_revisions WHERE workflow_id = ? AND revision = ?",
                (workflow_id, selected),
            ).fetchone()
            if row is None:
                raise WorkflowCorruptError(workflow_id, selected, "publication has no revision")
            if str(publication["digest"]) != str(row["digest"]):
                raise WorkflowCorruptError(workflow_id, selected, "publication digest mismatch")
            return self._snapshot_row(row, workflow_id=workflow_id, revision=selected)
        finally:
            conn.close()

    def is_published(self, workflow_id: str, owner_scope: str, revision: int) -> bool:
        workflow_id = self._safe_id(workflow_id)
        revision = self._safe_revision(revision)
        owner = _owner_scope(owner_scope)
        conn = self._connect()
        try:
            self._head_row(conn, workflow_id, owner)
            return (
                conn.execute(
                    "SELECT 1 FROM workflow_publications WHERE workflow_id = ? AND revision = ?",
                    (workflow_id, revision),
                ).fetchone()
                is not None
            )
        finally:
            conn.close()

    def load_head(self, workflow_id: str, owner_scope: str) -> WorkflowManifest:
        workflow_id = self._safe_id(workflow_id)
        owner = _owner_scope(owner_scope)
        conn = self._connect()
        try:
            row = self._head_row(conn, workflow_id, owner)
            return self._manifest_from_row(conn, row)
        finally:
            conn.close()

    def list_revisions(self, workflow_id: str, owner_scope: str) -> List[WorkflowSnapshot]:
        workflow_id = self._safe_id(workflow_id)
        owner = _owner_scope(owner_scope)
        conn = self._connect()
        try:
            self._head_row(conn, workflow_id, owner)
            rows = conn.execute(
                "SELECT * FROM workflow_revisions WHERE workflow_id = ? ORDER BY revision",
                (workflow_id,),
            )
            result: List[WorkflowSnapshot] = []
            for row in rows:
                result.append(self._snapshot_row(row, workflow_id=workflow_id, revision=int(row["revision"])))
            return result
        finally:
            conn.close()

    def list_manifests(self, owner_scope: str) -> List[WorkflowManifest]:
        owner = _owner_scope(owner_scope)
        conn = self._connect()
        try:
            rows = conn.execute(
                "SELECT * FROM workflow_heads WHERE owner_scope = ? ORDER BY updated_at DESC, workflow_id",
                (owner,),
            )
            return [
                self._manifest_from_row(conn, row)
                for row in rows
            ]
        finally:
            conn.close()

    # Compatibility aliases make the service boundary explicit without
    # introducing a second persistence abstraction.
    get_head = load_head
    get_revision = load_revision


__all__ = [
    "WorkflowCorruptError",
    "WorkflowNotFound",
    "WorkflowOwnershipError",
    "WorkflowStore",
    "WorkflowStoreError",
    "WorkflowVersionConflict",
    "default_workflows_root",
]
