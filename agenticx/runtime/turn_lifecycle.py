"""Durable turn checkpoints and safe rewind for Studio sessions.

Turn checkpoints are intentionally independent of Git history.  A checkpoint
records the ordinary files that were visible to a session, plus the chat and
agent message boundary.  Rewind validates the *current* state before applying
the checkpoint, so an edit made after the turn cannot be silently overwritten.
The real Git index and refs are never written by this module.
"""

from __future__ import annotations

import asyncio
import copy
import difflib
import hashlib
import json
import logging
import mimetypes
import os
import re
import selectors
import shutil
import stat
import subprocess
import tempfile
import threading
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Awaitable, Callable, Iterable, Mapping, Sequence

from agenticx.runtime.private_workspace import (
    PrivateWorkspace,
    ensure_private_workspace,
    private_session_root,
    private_sessions_root,
    validate_private_identifier,
)
from agenticx.runtime.document_delivery import (
    SUPPORTED_DOCUMENT_EXTENSIONS,
    document_format_for_path,
    document_mime_type,
    is_supported_document_path,
)

_log = logging.getLogger(__name__)

TURN_MANIFEST_VERSION = 1
DEFAULT_MAX_FILE_BYTES = 4 * 1024 * 1024
# Keep ordinary repositories useful by default while retaining per-file and
# streaming observation caps.  Snapshot bytes are written to disk; file
# contents are never accumulated beyond the per-file limit in memory.
DEFAULT_MAX_TOTAL_BYTES = 128 * 1024 * 1024
DEFAULT_MAX_FILES = 8192
# Oversized files are never copied into a checkpoint.  We may still hash a
# bounded amount of one in fixed chunks to prove that a skipped path did not
# change; larger files remain explicitly incomplete instead of being treated
# as a newly-created file during rewind.
DEFAULT_MAX_OBSERVATION_BYTES = 64 * 1024 * 1024
DEFAULT_MAX_CHAT_SNAPSHOT_BYTES = 8 * 1024 * 1024
DEFAULT_MAX_ARTIFACT_CHARS = 500_000
# Discovery and skipped-path observations run on user-selected workspace
# roots, which may be a home directory or another very large tree.  Keep the
# amount of directory metadata retained by one turn finite.  A truncated
# discovery is recorded as incomplete, so a later rewind cannot guess about
# paths that were not visited.
DEFAULT_MAX_DISCOVERY_ENTRIES = 32_768
DEFAULT_MAX_DISCOVERY_CANDIDATES = 16_384
DEFAULT_MAX_DISCOVERY_SECONDS = 2.0
DEFAULT_MAX_GIT_OUTPUT_BYTES = 32 * 1024 * 1024
DEFAULT_MAX_SKIPPED_OBSERVATIONS = 128
DEFAULT_MAX_SKIPPED_OBSERVATION_BYTES = 64 * 1024 * 1024
DEFAULT_MAX_SKIPPED_OBSERVATION_SECONDS = 2.0
DEFAULT_MAX_SKIPPED_MESSAGES = 256
# A manifest is metadata, not a file snapshot.  Keep both its on-disk write
# and its read bounded; an oversized legacy checkpoint is reported as an
# unusable checkpoint rather than being loaded into the Studio event loop.
MAX_MANIFEST_BYTES = 4 * 1024 * 1024
MAX_MANIFEST_SCAN_ENTRIES = 4096
# Bound the total manifest bytes read while looking for the latest turn.  The
# per-file limit above prevents one oversized JSON document from being loaded;
# this aggregate limit also prevents many individually-valid manifests from
# consuming unbounded memory during one session lookup.
MAX_MANIFEST_SCAN_BYTES = 32 * 1024 * 1024
_SAFE_DOC_EXTENSIONS = SUPPORTED_DOCUMENT_EXTENSIONS
_SYSTEM_ALIAS_TARGETS = {
    "/var": "/private/var",
    "/tmp": "/private/tmp",
}
_EXCLUDED_DIRS = frozenset(
    {
        ".git",
        "node_modules",
        "build",
        "dist",
        ".next",
        "target",
        "__pycache__",
        ".venv",
        "venv",
        ".agenticx",
        ".cache",
        "cache",
        "coverage",
    }
)

_DISCOVERY_TRUNCATED_MARKER = "<discovery-budget-exhausted>"
_SKIPPED_OBSERVATION_TRUNCATED_MARKER = "<skipped-observation-budget-exhausted>"
_MANIFEST_SCAN_TRUNCATED_MARKER = "<manifest-scan-truncated>"
_MANIFEST_SCAN_ERROR_MARKER = "<manifest-scan-error>"


class _ManifestTooLarge(ValueError):
    """Raised internally when a JSON payload crosses the manifest byte cap."""


class _BoundedTextWriter:
    """Text writer that refuses to write more than a UTF-8 byte budget."""

    def __init__(self, handle: Any, limit: int) -> None:
        self.handle = handle
        self.limit = max(1, int(limit))
        self.bytes_written = 0

    def write(self, value: str) -> int:
        encoded = str(value).encode("utf-8")
        if self.bytes_written + len(encoded) > self.limit:
            raise _ManifestTooLarge(
                f"manifest exceeds safe metadata limit ({self.limit} bytes)"
            )
        self.handle.write(encoded)
        self.bytes_written += len(encoded)
        return len(value)

    def flush(self) -> None:
        self.handle.flush()


@dataclass
class _DiscoveryBudget:
    """Shared budget for one begin/finalize discovery pass."""

    max_entries: int
    max_candidates: int
    deadline: float
    visited_entries: int = 0
    candidates: int = 0
    truncated: bool = False

    def visit(self) -> bool:
        if self.visited_entries >= self.max_entries or time.monotonic() >= self.deadline:
            self.truncated = True
            return False
        self.visited_entries += 1
        return True

    def add_candidate(self) -> bool:
        if self.candidates >= self.max_candidates or time.monotonic() >= self.deadline:
            self.truncated = True
            return False
        self.candidates += 1
        return True


@dataclass
class _ObservationBudget:
    """Shared bound for skipped-path metadata probes."""

    max_count: int
    max_bytes: int
    deadline: float
    count: int = 0
    bytes_read: int = 0
    exhausted: bool = False

    def reserve(self) -> bool:
        if (
            self.count >= self.max_count
            or self.bytes_read >= self.max_bytes
            or time.monotonic() >= self.deadline
        ):
            self.exhausted = True
            return False
        self.count += 1
        return True

    @property
    def remaining_bytes(self) -> int:
        return max(0, self.max_bytes - self.bytes_read)


class TurnLifecycleError(RuntimeError):
    """Base class for checkpoint errors."""


class TurnAlreadyRunning(TurnLifecycleError):
    """A different writer already owns one of the workspace roots."""


class TurnConflictError(TurnLifecycleError):
    """The current workspace differs from the checkpoint's recorded after state."""

    def __init__(self, message: str, *, conflict_paths: Iterable[str] = ()) -> None:
        super().__init__(message)
        self.conflict_paths = tuple(str(p) for p in conflict_paths if str(p))


class TurnCheckpointMissing(TurnLifecycleError):
    """The requested turn has no usable durable checkpoint."""


@dataclass(frozen=True)
class TurnHandle:
    """The small amount of turn identity tools need while a turn runs."""

    session_id: str
    turn_id: str
    private: PrivateWorkspace
    resumed: bool = False

    @property
    def scratch(self) -> Path:
        return self.private.scratch

    @property
    def outputs(self) -> Path:
        return self.private.outputs

    @property
    def logs(self) -> Path:
        return self.private.logs


def _atomic_write_json(
    path: Path,
    payload: Mapping[str, Any],
    *,
    max_bytes: int | None = None,
) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "wb") as handle:
            if max_bytes is None:
                writer: Any = handle
                # ``iterencode`` avoids building a second full JSON string.
                encoder = json.JSONEncoder(
                    ensure_ascii=False,
                    separators=(",", ":"),
                    default=_json_default,
                )
                bytes_written = 0
                for piece in encoder.iterencode(payload):
                    encoded = piece.encode("utf-8")
                    handle.write(encoded)
                    bytes_written += len(encoded)
            else:
                writer = _BoundedTextWriter(handle, max_bytes)
                encoder = json.JSONEncoder(
                    ensure_ascii=False,
                    separators=(",", ":"),
                    default=_json_default,
                )
                for piece in encoder.iterencode(payload):
                    writer.write(piece)
                bytes_written = writer.bytes_written
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(name, path)
        try:
            path.chmod(0o600)
        except OSError:
            pass
    finally:
        try:
            os.unlink(name)
        except FileNotFoundError:
            pass
    return bytes_written


def _atomic_write_bytes(path: Path, data: bytes, *, mode: int | None = None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        if mode is not None:
            try:
                os.chmod(name, stat.S_IMODE(mode))
            except OSError:
                pass
        os.replace(name, path)
    finally:
        try:
            os.unlink(name)
        except FileNotFoundError:
            pass


def _json_default(value: Any) -> str:
    if isinstance(value, Path):
        return str(value)
    return str(value)


def _manifest_payload_fits(payload: Mapping[str, Any], limit: int) -> bool:
    """Conservatively estimate JSON size without materializing JSON bytes.

    ``JSONEncoder.iterencode`` is streaming for ordinary values, but a single
    giant string can still be handed to it as one giant chunk.  Inspect the
    payload first and stop as soon as the UTF-8 budget is impossible.  The
    traversal itself is iterative and bounded by the same byte limit.
    """

    remaining = max(1, int(limit))
    pending: list[tuple[str, Any]] = [("value", payload)]
    visited = 0
    while pending:
        kind, value = pending.pop()
        if kind == "mapping":
            try:
                key, item = next(value)
            except StopIteration:
                continue
            except Exception:
                return False
            pending.append(("mapping", value))
            pending.append(("value", item))
            pending.append(("value", str(key)))
            continue
        if kind == "sequence":
            try:
                item = next(value)
            except StopIteration:
                continue
            except Exception:
                return False
            pending.append(("sequence", value))
            pending.append(("value", item))
            continue
        visited += 1
        if visited > remaining:
            return False
        if isinstance(value, Mapping):
            remaining -= 2  # object delimiters
            if remaining <= 0:
                return False
            try:
                iterator = iter(value.items())
            except Exception:
                return False
            pending.append(("mapping", iterator))
            continue
        if isinstance(value, (list, tuple)):
            remaining -= 2  # array delimiters
            if remaining <= 0:
                return False
            pending.append(("sequence", iter(value)))
            continue
        if isinstance(value, str):
            # Avoid encoding a multi-hundred-megabyte string merely to learn
            # that it cannot fit.  A string length of ``limit`` is already a
            # sufficient rejection even for one-byte characters once JSON
            # quoting is included.
            if len(value) > limit:
                return False
            try:
                size = len(value.encode("utf-8")) + 2
            except UnicodeError:
                return False
            remaining -= size
        elif value is None or isinstance(value, (bool, int, float)):
            remaining -= 16
        else:
            try:
                text = str(value)
                if len(text) > limit:
                    return False
                remaining -= len(text.encode("utf-8")) + 2
            except (OSError, UnicodeError, ValueError):
                return False
        if remaining <= 0:
            return False
    return True


def _safe_copy_rows(rows: Any) -> list[dict[str, Any]]:
    if not isinstance(rows, list):
        return []
    return [copy.deepcopy(item) for item in rows if isinstance(item, dict)]


def _content_text(row: Mapping[str, Any]) -> str:
    value = row.get("content", "")
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return "".join(
            str(item.get("text", ""))
            for item in value
            if isinstance(item, dict) and item.get("type") == "text"
        )
    return str(value or "")


def _line_delta(before: bytes | None, after: bytes | None) -> tuple[int, int]:
    """Return added/removed text lines without loading anything above snapshot caps."""

    if before is None or after is None:
        return (len((after or b"").splitlines()), len((before or b"").splitlines()))
    try:
        old = before.decode("utf-8").splitlines()
        new = after.decode("utf-8").splitlines()
    except UnicodeDecodeError:
        return (0, 0)
    added = removed = 0
    for line in difflib.ndiff(old, new):
        if line.startswith("+ "):
            added += 1
        elif line.startswith("- "):
            removed += 1
    return added, removed


class TurnLifecycleStore:
    """Own manifests, bounded byte snapshots and rewind transactions."""

    _locks_guard = threading.Lock()
    _workspace_locks: dict[str, str] = {}
    # A rewind also mutates durable session/chat state. Keep a session-scoped
    # transaction owner in addition to root leases so a same-session begin
    # cannot escape through a disjoint explicitly supplied workspace root.
    _session_transactions: dict[str, str] = {}
    # ``bash_bg_start`` reserves a slot before awaiting process creation.  A
    # rewind must see that reservation as a writer too; otherwise it could
    # pass its preflight between the reservation check and job registration.
    _background_writer_reservations: dict[str, set[str]] = {}

    def __init__(
        self,
        root: str | os.PathLike[str] | None = None,
        *,
        max_file_bytes: int = DEFAULT_MAX_FILE_BYTES,
        max_total_bytes: int = DEFAULT_MAX_TOTAL_BYTES,
        max_files: int = DEFAULT_MAX_FILES,
        max_chat_snapshot_bytes: int = DEFAULT_MAX_CHAT_SNAPSHOT_BYTES,
        max_discovery_entries: int = DEFAULT_MAX_DISCOVERY_ENTRIES,
        max_discovery_candidates: int = DEFAULT_MAX_DISCOVERY_CANDIDATES,
        max_discovery_seconds: float = DEFAULT_MAX_DISCOVERY_SECONDS,
        max_skipped_observations: int = DEFAULT_MAX_SKIPPED_OBSERVATIONS,
        max_skipped_observation_bytes: int = DEFAULT_MAX_SKIPPED_OBSERVATION_BYTES,
        max_skipped_observation_seconds: float = DEFAULT_MAX_SKIPPED_OBSERVATION_SECONDS,
        max_skipped_messages: int = DEFAULT_MAX_SKIPPED_MESSAGES,
        active_writer_checker: Callable[[str | None], Any] | None = None,
    ) -> None:
        self.root = private_sessions_root(root)
        self.max_file_bytes = max(1, int(max_file_bytes))
        self.max_total_bytes = max(1, int(max_total_bytes))
        self.max_files = max(1, int(max_files))
        self.max_chat_snapshot_bytes = max(1024, int(max_chat_snapshot_bytes))
        self.max_discovery_entries = max(1, int(max_discovery_entries))
        self.max_discovery_candidates = max(1, int(max_discovery_candidates))
        self.max_discovery_seconds = max(0.01, float(max_discovery_seconds))
        self.max_skipped_observations = max(1, int(max_skipped_observations))
        self.max_skipped_observation_bytes = max(1, int(max_skipped_observation_bytes))
        self.max_skipped_observation_seconds = max(
            0.01,
            float(max_skipped_observation_seconds),
        )
        self.max_skipped_messages = max(1, int(max_skipped_messages))
        self._session_guard = threading.RLock()
        # The callback is intentionally injected rather than imported here:
        # the CLI background process registry imports runtime helpers too.
        # A lazy fallback keeps older SessionManager instances safe without a
        # module import cycle, while tests can inject a deterministic checker.
        self._active_writer_checker = active_writer_checker

    def set_active_writer_checker(
        self,
        checker: Callable[[str | None], Any] | None,
    ) -> None:
        """Install the session-owned background writer checker.

        The checker must be synchronous and return a truthy bool, mapping, or
        iterable of metadata rows for active writers.  It receives ``None``
        when the caller asks for the process-wide view, so a writer owned by a
        different session also blocks undo.  It is consulted only by turn
        listing/rewind; ordinary turns remain able to stop a background
        service and start their next chat turn.
        """

        self._active_writer_checker = checker

    @classmethod
    def reserve_background_writer(cls, session_id: str, token: str) -> None:
        """Reserve an owned background writer before an async process spawn.

        This shares the lifecycle lock with rewind.  A reservation is short
        lived and is replaced by the CLI's registered job immediately after
        spawn; it never becomes a workspace lease and therefore does not block
        a normal next chat turn.
        """

        sid = str(session_id or "").strip()
        reservation = str(token or "").strip()
        if not sid or not reservation:
            raise ValueError("session_id and background writer token are required")
        with cls._locks_guard:
            # A rewind mutates shared process state (and may cover a workspace
            # shared by another session).  Do not let any managed background
            # writer start after *any* session has entered that transaction.
            if cls._session_transactions:
                raise TurnAlreadyRunning("turn rewind is in progress")
            cls._background_writer_reservations.setdefault(sid, set()).add(reservation)

    @classmethod
    def release_background_writer(cls, session_id: str, token: str) -> None:
        sid = str(session_id or "").strip()
        reservation = str(token or "").strip()
        if not sid or not reservation:
            return
        with cls._locks_guard:
            rows = cls._background_writer_reservations.get(sid)
            if not rows:
                return
            rows.discard(reservation)
            if not rows:
                cls._background_writer_reservations.pop(sid, None)

    @classmethod
    def _background_writer_reservations_for_session(cls, session_id: str) -> tuple[str, ...]:
        sid = str(session_id or "").strip()
        if not sid:
            return ()
        with cls._locks_guard:
            return tuple(sorted(cls._background_writer_reservations.get(sid, set())))

    @classmethod
    def _background_writer_reservations_all(cls) -> tuple[tuple[str, str], ...]:
        """Return all pending managed-writer reservations process-wide."""

        with cls._locks_guard:
            return tuple(
                sorted(
                    (sid, token)
                    for sid, tokens in cls._background_writer_reservations.items()
                    for token in tokens
                )
            )

    @classmethod
    def session_transaction_active(cls, session_id: str) -> bool:
        """Return whether an async rewind currently owns this session."""

        sid = str(session_id or "").strip()
        if not sid:
            return False
        with cls._locks_guard:
            return sid in cls._session_transactions

    def _active_writer_details(self, session_id: str) -> list[dict[str, str]]:
        """Normalize active writer checker output for UI and rewind guards."""

        sid = str(session_id or "").strip()
        # Reservations are process-wide.  Keeping the check global closes the
        # race where session B is preparing a writer while session A lists or
        # rewinds a checkpoint in the same process.
        details: list[dict[str, str]] = [
            {
                "job_id": token,
                "reason": "background writer is starting",
                "session_id": owner_sid,
            }
            for owner_sid, token in self._background_writer_reservations_all()
        ]
        checker = self._active_writer_checker
        if checker is None:
            # Import lazily so this module remains independent of the CLI.
            try:
                from agenticx.cli.agent_tools import active_background_writers

                checker = active_background_writers
            except Exception:
                checker = None
        if checker is None:
            return details
        try:
            # ``None`` asks the checker for its process-wide view.  The
            # built-in CLI registry supports that view; injected checkers use
            # the same contract so tests and alternate registries cannot
            # accidentally reintroduce session-only admission.
            raw = checker(None)
        except Exception as exc:  # fail closed when writer state is unknown
            details.append(
                {
                    "job_id": "",
                    "reason": f"background writer status unavailable: {exc}",
                }
            )
            return details
        if raw is None or raw is False:
            return details
        if raw is True:
            details.append({"job_id": "", "reason": "owned background writer is active"})
            return details
        values: Iterable[Any]
        if isinstance(raw, Mapping):
            values = [raw]
        elif isinstance(raw, (str, bytes)):
            values = [{"job_id": str(raw)}]
        else:
            try:
                values = list(raw)
            except TypeError:
                values = [{"job_id": str(raw)}]
        for item in values:
            if isinstance(item, Mapping):
                job_id = str(item.get("job_id", "") or item.get("id", "") or "").strip()
                reason = str(item.get("reason", "") or "owned background writer is active").strip()
                cwd = str(item.get("cwd", "") or "").strip()
                owner_sid = str(item.get("session_id", "") or "").strip()
                if cwd and not job_id:
                    job_id = cwd
                details.append(
                    {
                        "job_id": job_id,
                        "reason": reason,
                        **({"session_id": owner_sid} if owner_sid else {}),
                    }
                )
            elif item:
                details.append({"job_id": str(item), "reason": "owned background writer is active"})
        return details

    # ------------------------------------------------------------------
    # Path and manifest helpers
    # ------------------------------------------------------------------

    def _session_root(self, session_id: str) -> Path:
        return private_session_root(session_id, root=self.root)

    def _turn_root(self, session_id: str, turn_id: str) -> Path:
        return ensure_private_workspace(session_id, turn_id, root=self.root).root

    def _manifest_path(self, session_id: str, turn_id: str) -> Path:
        return self._turn_root(session_id, turn_id) / "checkpoint" / "manifest.json"

    def _read_manifest(self, session_id: str, turn_id: str) -> dict[str, Any] | None:
        try:
            sid = validate_private_identifier(session_id, field="session_id")
            tid = validate_private_identifier(turn_id, field="turn_id")
            path = self._manifest_path(sid, tid)
            size = path.stat().st_size
            if size > MAX_MANIFEST_BYTES:
                return self._unreadable_manifest_marker(sid, tid, path, size)
            with path.open("rb") as handle:
                # The size check above closes the normal path; bounded reading
                # also handles a file that grows between stat() and open().
                content = handle.read(MAX_MANIFEST_BYTES + 1)
                if len(content) > MAX_MANIFEST_BYTES:
                    return self._unreadable_manifest_marker(
                        sid,
                        tid,
                        path,
                        MAX_MANIFEST_BYTES + 1,
                    )
                raw = json.loads(content.decode("utf-8"))
        except (OSError, UnicodeError, ValueError, json.JSONDecodeError, TypeError):
            return None
        return dict(raw) if isinstance(raw, dict) else None

    @staticmethod
    def _unreadable_manifest_marker(
        session_id: str,
        turn_id: str,
        path: Path,
        size: int,
    ) -> dict[str, Any]:
        """Return a small fail-closed row for an oversized checkpoint."""

        _log.warning(
            "turn checkpoint manifest exceeds %d bytes; marking unavailable "
            "session=%s turn=%s size=%d",
            MAX_MANIFEST_BYTES,
            session_id,
            turn_id,
            size,
        )
        try:
            updated_at = path.stat().st_mtime
        except OSError:
            updated_at = 0.0
        return {
            "version": TURN_MANIFEST_VERSION,
            "session_id": session_id,
            "turn_id": turn_id,
            "status": "aborted",
            "created_at": updated_at,
            "updated_at": updated_at,
            "checkpoint_complete": False,
            "manifest_unreadable": True,
            "manifest_truncated": True,
            "manifest_size_bytes": size,
            "incomplete_reason": (
                "checkpoint manifest exceeds the safe metadata limit "
                f"({size} > {MAX_MANIFEST_BYTES} bytes)"
            ),
        }

    def _write_manifest(self, manifest: Mapping[str, Any]) -> None:
        sid = validate_private_identifier(str(manifest.get("session_id", "")), field="session_id")
        tid = validate_private_identifier(str(manifest.get("turn_id", "")), field="turn_id")
        path = self._manifest_path(sid, tid)
        payload = dict(manifest)
        if _manifest_payload_fits(payload, MAX_MANIFEST_BYTES):
            try:
                _atomic_write_json(path, payload, max_bytes=MAX_MANIFEST_BYTES)
                return
            except _ManifestTooLarge:
                # A concurrently-mutated mapping or a non-standard JSON
                # encoder value can cross the cap after the estimate.  Fall
                # through to the same compact fail-closed marker.
                pass

        marker = self._manifest_budget_marker(
            payload,
            reason=(
                "checkpoint manifest exceeded the safe metadata limit; "
                "checkpoint is incomplete"
            ),
        )
        if isinstance(manifest, dict):
            manifest.clear()
            manifest.update(marker)
        # The marker is deliberately tiny and contains no file maps, chat
        # rows, or unbounded path lists.  It is therefore safe to write with
        # the same hard cap.
        try:
            _atomic_write_json(path, marker, max_bytes=MAX_MANIFEST_BYTES)
        except _ManifestTooLarge:
            # Tests and recovery tooling may temporarily lower the cap below
            # the normal diagnostic marker size.  Retain the minimum state
            # needed for fail-closed reads even under that small cap.
            minimal = {
                "session_id": sid[:32],
                "turn_id": tid[:32],
                "status": "aborted",
                "checkpoint_complete": False,
                "manifest_unreadable": True,
            }
            if isinstance(manifest, dict):
                manifest.clear()
                manifest.update(minimal)
            _atomic_write_json(path, minimal, max_bytes=MAX_MANIFEST_BYTES)

    @staticmethod
    def _manifest_budget_marker(
        manifest: Mapping[str, Any],
        *,
        reason: str,
    ) -> dict[str, Any]:
        """Create a compact durable sentinel for a budget-exhausted write."""

        def bounded_text(value: Any, limit: int = 256) -> str:
            try:
                return str(value or "")[:limit]
            except Exception:
                return ""

        def safe_time(value: Any) -> float:
            try:
                result = float(value)
                return result if result >= 0 else 0.0
            except (TypeError, ValueError, OverflowError):
                return 0.0

        return {
            "version": TURN_MANIFEST_VERSION,
            "session_id": bounded_text(manifest.get("session_id"), 128),
            "turn_id": bounded_text(manifest.get("turn_id"), 128),
            "client_turn_id": bounded_text(manifest.get("client_turn_id"), 256),
            "status": "aborted",
            "created_at": safe_time(manifest.get("created_at")),
            "updated_at": safe_time(manifest.get("updated_at")) or time.time(),
            "checkpoint_complete": False,
            "manifest_unreadable": True,
            "manifest_truncated": True,
            "incomplete_reason": bounded_text(reason, 512),
        }

    def _iter_manifests(self, session_id: str) -> list[dict[str, Any]]:
        sid = validate_private_identifier(session_id, field="session_id")
        turns_root = self._session_root(sid) / "turns"
        entries: list[tuple[Path, int]] = []
        scan_truncated = False
        scan_error: str | None = None
        scanned_manifest_bytes = 0
        try:
            # ``iterdir`` is intentionally consumed incrementally.  A corrupt
            # session directory must not turn one metadata read into an
            # unbounded list allocation during every new turn.
            for index, entry in enumerate(turns_root.iterdir()):
                if index >= MAX_MANIFEST_SCAN_ENTRIES:
                    scan_truncated = True
                    break
                try:
                    if not entry.is_dir() or entry.is_symlink():
                        continue
                except OSError as exc:
                    scan_error = f"cannot inspect checkpoint turn entry: {exc}"[:512]
                    break
                manifest_path = entry / "checkpoint" / "manifest.json"
                try:
                    manifest_size = manifest_path.stat().st_size
                except OSError as exc:
                    scan_error = f"cannot inspect checkpoint manifest: {exc}"[:512]
                    break
                if manifest_size > MAX_MANIFEST_BYTES:
                    # The marker is generated from stat metadata only, so an
                    # oversized legacy manifest remains visible as incomplete
                    # without consuming the aggregate read budget.
                    entries.append((entry, manifest_size))
                    continue
                if scanned_manifest_bytes + manifest_size > MAX_MANIFEST_SCAN_BYTES:
                    scan_truncated = True
                    break
                entries.append((entry, manifest_size))
                scanned_manifest_bytes += manifest_size
        except OSError as exc:
            scan_error = f"checkpoint manifest history scan failed: {exc}"[:512]
        if scan_truncated or scan_error:
            _log.warning(
                "turn checkpoint manifest scan incomplete for session=%s: %s",
                sid,
                scan_error
                or f"capped at {MAX_MANIFEST_SCAN_ENTRIES} entries or {MAX_MANIFEST_SCAN_BYTES} bytes",
            )
        rows: list[dict[str, Any]] = []
        for entry, manifest_size in entries:
            if manifest_size > MAX_MANIFEST_BYTES:
                row = self._unreadable_manifest_marker(
                    sid,
                    entry.name,
                    entry / "checkpoint" / "manifest.json",
                    manifest_size,
                )
            else:
                try:
                    row = self._read_manifest(sid, entry.name)
                except OSError as exc:
                    scan_error = f"cannot read checkpoint manifest: {exc}"[:512]
                    row = None
                if row is None and scan_error is None:
                    scan_error = (
                        f"checkpoint manifest could not be read: {entry.name}"
                    )
            if row is not None:
                rows.append(row)
            if scan_error:
                # A missing or unreadable row means the prefix is not a
                # complete history.  Stop reading further rows and expose a
                # compact fail-closed marker instead of silently treating it
                # as an empty/shorter history.
                break
        def manifest_sort_key(row: Mapping[str, Any]) -> tuple[float, str]:
            try:
                created_at = float(row.get("created_at", 0.0) or 0.0)
            except (TypeError, ValueError, OverflowError):
                created_at = 0.0
            return created_at, str(row.get("turn_id", ""))

        rows.sort(key=manifest_sort_key)
        if scan_truncated or scan_error:
            # Do not return a prefix that callers could mistake for complete
            # history.  Consumers that need a latest/rewind decision fail
            # closed when this compact sentinel is present.
            rows.append(
                {
                    "version": TURN_MANIFEST_VERSION,
                    "session_id": sid,
                    "turn_id": (
                        _MANIFEST_SCAN_ERROR_MARKER
                        if scan_error
                        else _MANIFEST_SCAN_TRUNCATED_MARKER
                    ),
                    "status": "aborted",
                    "created_at": float("inf"),
                    "updated_at": time.time(),
                    "checkpoint_complete": False,
                    "manifest_scan_truncated": True,
                    "manifest_scan_error": bool(scan_error),
                    "incomplete_reason": (
                        scan_error
                        or "checkpoint manifest history scan was truncated by a safety budget"
                    ),
                }
            )
        return rows

    @staticmethod
    def _roots_from_session(session: Any) -> list[Path]:
        values: list[str] = []
        workspace = str(getattr(session, "workspace_dir", "") or "").strip() if session is not None else ""
        if workspace:
            values.append(workspace)
        if session is not None:
            raw_spaces = getattr(session, "taskspaces", None)
            if isinstance(raw_spaces, list):
                for item in raw_spaces:
                    if not isinstance(item, dict):
                        continue
                    value = str(item.get("path", "") or item.get("source_path", "") or "").strip()
                    if value:
                        values.append(value)
        if not values:
            values.append(os.getcwd())
        roots: list[Path] = []
        seen: set[str] = set()
        for value in values:
            try:
                path = Path(value).expanduser().resolve(strict=False)
            except (OSError, RuntimeError, ValueError):
                continue
            key = str(path)
            if key not in seen:
                seen.add(key)
                roots.append(path)
        return roots

    @staticmethod
    def _is_excluded(path: Path) -> bool:
        return any(part in _EXCLUDED_DIRS for part in path.parts)

    @staticmethod
    def _has_symlink_component(path: Path) -> bool:
        """Check the lexical path with ``lstat`` before resolving it.

        Calling ``resolve`` first turns an output symlink into its external
        target and makes the later ``is_symlink`` check meaningless.  Every
        explicit artifact path therefore goes through this check both during
        discovery and immediately before snapshot/restore.
        """

        candidate = Path(path).expanduser()
        current = Path(candidate.anchor) if candidate.anchor else Path()
        parts = candidate.parts[1:] if candidate.anchor else candidate.parts
        for part in parts:
            current = current / part
            try:
                if current.is_symlink():
                    expected = _SYSTEM_ALIAS_TARGETS.get(str(current))
                    if expected and str(current.resolve(strict=False)) == expected:
                        continue
                    return True
            except OSError:
                # An inaccessible path is handled by the normal snapshot
                # error path; it must not be followed optimistically.
                return True
        return False

    @staticmethod
    def _git_root(root: Path) -> Path | None:
        probe = root if root.is_dir() else root.parent
        try:
            result = subprocess.run(
                ["git", "-C", str(probe), "rev-parse", "--show-toplevel"],
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                check=False,
                text=True,
                timeout=3,
            )
        except (OSError, subprocess.SubprocessError):
            return None
        if result.returncode != 0:
            return None
        value = str(result.stdout or "").strip()
        if not value:
            return None
        try:
            return Path(value).resolve(strict=False)
        except (OSError, RuntimeError, ValueError):
            return None

    @classmethod
    def _git_files(
        cls,
        root: Path,
        git_root: Path,
        *,
        budget: _DiscoveryBudget | None = None,
        max_output_bytes: int = DEFAULT_MAX_GIT_OUTPUT_BYTES,
    ) -> list[Path]:
        """Read ``git ls-files`` incrementally under discovery limits.

        ``subprocess.run(..., stdout=PIPE)`` materializes the complete index
        listing before this module can apply any file cap.  A streaming pipe
        keeps both the subprocess output and the path list bounded for a
        repository with a very large untracked set.
        """

        if budget is None:
            budget = _DiscoveryBudget(
                max_entries=DEFAULT_MAX_DISCOVERY_ENTRIES,
                max_candidates=DEFAULT_MAX_DISCOVERY_CANDIDATES,
                deadline=time.monotonic() + DEFAULT_MAX_DISCOVERY_SECONDS,
            )
        try:
            process = subprocess.Popen(
                [
                    "git",
                    "-C",
                    str(git_root),
                    "ls-files",
                    "-c",
                    "-o",
                    "--exclude-standard",
                    "-z",
                ],
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                close_fds=True,
            )
        except (OSError, subprocess.SubprocessError):
            return []
        output = process.stdout
        if output is None:
            try:
                process.kill()
                process.wait(timeout=1)
            except (OSError, subprocess.SubprocessError):
                pass
            return []

        out: list[Path] = []
        pending = b""
        output_bytes = 0
        stopped = False
        try:
            root_resolved = root.resolve(strict=False)
            while not stopped:
                if time.monotonic() >= budget.deadline:
                    budget.truncated = True
                    stopped = True
                    break
                chunk = output.read(64 * 1024)
                if not chunk:
                    break
                chunk = bytes(chunk)
                output_bytes += len(chunk)
                if output_bytes > max(1, int(max_output_bytes)):
                    budget.truncated = True
                    stopped = True
                    break
                pending += chunk
                # A NUL-delimited pathname cannot legitimately be larger than
                # this bound in a useful workspace.  Avoid retaining a single
                # malformed record indefinitely when git output is corrupt.
                if len(pending) > 4096 and b"\0" not in pending:
                    budget.truncated = True
                    stopped = True
                    break
                while b"\0" in pending:
                    raw, pending = pending.split(b"\0", 1)
                    if not raw:
                        continue
                    if not budget.visit():
                        stopped = True
                        break
                    try:
                        lexical = git_root / os.fsdecode(raw)
                        if cls._has_symlink_component(lexical):
                            continue
                        candidate = lexical.resolve(strict=False)
                        if cls._is_excluded(candidate):
                            continue
                        candidate.relative_to(root_resolved)
                    except (OSError, RuntimeError, ValueError, UnicodeError):
                        continue
                    if not budget.add_candidate():
                        stopped = True
                        break
                    out.append(candidate)
        except (OSError, RuntimeError, ValueError):
            budget.truncated = True
            stopped = True
        finally:
            try:
                output.close()
            except OSError:
                pass
            try:
                if stopped:
                    process.kill()
                process.wait(timeout=1)
            except subprocess.TimeoutExpired:
                # A killed git process can still take a scheduling turn to
                # exit.  Reap it a second time so a timed-out discovery pass
                # never leaks a child process or keeps the pipe alive.
                try:
                    process.kill()
                except OSError:
                    pass
                try:
                    process.wait(timeout=1)
                except (OSError, subprocess.SubprocessError):
                    pass
            except (OSError, subprocess.SubprocessError):
                try:
                    process.kill()
                except OSError:
                    pass
        if pending:
            # A final non-NUL fragment is a malformed/incomplete git record;
            # do not turn it into a candidate.
            budget.truncated = True
        if process.returncode not in (0, None) and not out:
            return []
        return out

    @classmethod
    def _git_ignored(cls, path: Path, git_root: Path) -> bool:
        """Return whether an existing path is ignored by the repository."""

        try:
            root = git_root.resolve(strict=False)
            candidate = path.resolve(strict=False)
            relative = candidate.relative_to(root)
            result = subprocess.run(
                ["git", "-C", str(root), "check-ignore", "-q", "--", str(relative)],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
                timeout=3,
            )
            return result.returncode == 0
        except (OSError, RuntimeError, ValueError, subprocess.SubprocessError):
            return False

    @classmethod
    def _walk_files(
        cls,
        root: Path,
        *,
        budget: _DiscoveryBudget | None = None,
    ) -> list[Path]:
        """Enumerate regular files without materializing ``os.walk`` lists."""

        if budget is None:
            budget = _DiscoveryBudget(
                max_entries=DEFAULT_MAX_DISCOVERY_ENTRIES,
                max_candidates=DEFAULT_MAX_DISCOVERY_CANDIDATES,
                deadline=time.monotonic() + DEFAULT_MAX_DISCOVERY_SECONDS,
            )
        try:
            if not root.exists() or root.is_symlink():
                return []
            if root.is_file():
                if not budget.visit() or not budget.add_candidate():
                    return []
                return [root]
        except (OSError, RuntimeError, ValueError):
            return []

        out: list[Path] = []
        pending: list[Path] = [root]
        while pending:
            if time.monotonic() >= budget.deadline:
                budget.truncated = True
                break
            current = pending.pop()
            try:
                entries = os.scandir(current)
            except OSError:
                continue
            try:
                for entry in entries:
                    if not budget.visit():
                        pending.clear()
                        break
                    try:
                        name = entry.name
                        if name in _EXCLUDED_DIRS:
                            continue
                        candidate = Path(entry.path)
                        if entry.is_symlink():
                            continue
                        if entry.is_dir(follow_symlinks=False):
                            pending.append(candidate)
                            continue
                        if not entry.is_file(follow_symlinks=False):
                            continue
                        if cls._is_excluded(candidate):
                            continue
                        if not budget.add_candidate():
                            pending.clear()
                            break
                        out.append(candidate)
                    except (OSError, RuntimeError, ValueError):
                        continue
            finally:
                try:
                    entries.close()
                except OSError:
                    pass
        return out

    @staticmethod
    def _lexical_absolute(path: str | os.PathLike[str] | Path) -> Path:
        """Make an absolute lexical path without following symlinks."""

        expanded = Path(path).expanduser()
        if not expanded.is_absolute():
            expanded = Path.cwd() / expanded
        return Path(os.path.abspath(os.fspath(expanded)))

    @classmethod
    def _path_inside_roots(
        cls,
        path: str | os.PathLike[str] | Path,
        roots: Sequence[Path],
    ) -> Path | None:
        """Validate a path lexically, then resolve it under one allowed root."""

        try:
            lexical = cls._lexical_absolute(path)
            # The lexical check must happen before resolve; otherwise a
            # replaced artifact/scratch component can hide an external target.
            if cls._has_symlink_component(lexical):
                return None
            resolved = lexical.resolve(strict=False)
        except (OSError, RuntimeError, ValueError):
            return None
        for raw_root in roots:
            try:
                root = cls._lexical_absolute(raw_root)
                if cls._has_symlink_component(root):
                    continue
                root_resolved = root.resolve(strict=False)
                resolved.relative_to(root_resolved)
                return resolved
            except (OSError, RuntimeError, ValueError):
                continue
        return None

    def _validated_internal_history_roots(
        self,
        session_id: str,
        roots: Sequence[str | os.PathLike[str]] | None,
    ) -> list[Path]:
        """Accept only this session's trusted ``subagent_runs`` directory."""

        if not roots:
            return []
        sid = validate_private_identifier(session_id, field="session_id")
        expected = self._session_root(sid) / "subagent_runs"
        try:
            expected_lexical = self._lexical_absolute(expected)
            if self._has_symlink_component(expected_lexical):
                raise ValueError("internal history root contains a symlink")
            expected_resolved = expected_lexical.resolve(strict=False)
        except (OSError, RuntimeError, ValueError) as exc:
            raise TurnCheckpointMissing("internal history root is not safe") from exc
        accepted: list[Path] = []
        for raw in roots:
            try:
                lexical = self._lexical_absolute(raw)
                if self._has_symlink_component(lexical):
                    raise ValueError("internal history root contains a symlink")
                resolved = lexical.resolve(strict=False)
                if resolved != expected_resolved:
                    raise ValueError("internal history root is not this session's subagent_runs")
            except (OSError, RuntimeError, ValueError) as exc:
                raise TurnCheckpointMissing(
                    "internal history root must be this session's private subagent_runs directory"
                ) from exc
            if not any(str(path) == str(expected_resolved) for path in accepted):
                accepted.append(expected_resolved)
        return accepted

    @classmethod
    def _internal_history_paths(
        cls,
        roots: Sequence[Path],
        *,
        budget: _DiscoveryBudget | None = None,
    ) -> list[Path]:
        """Enumerate durable SubAgentRunStore metadata under the same budget."""

        if budget is None:
            budget = _DiscoveryBudget(
                max_entries=DEFAULT_MAX_DISCOVERY_ENTRIES,
                max_candidates=DEFAULT_MAX_DISCOVERY_CANDIDATES,
                deadline=time.monotonic() + DEFAULT_MAX_DISCOVERY_SECONDS,
            )
        paths: list[Path] = []
        for root in roots:
            try:
                if cls._has_symlink_component(root) or root.is_symlink() or not root.is_dir():
                    continue
            except (OSError, RuntimeError, ValueError):
                continue
            pending: list[Path] = [root]
            while pending:
                if time.monotonic() >= budget.deadline:
                    budget.truncated = True
                    return paths
                current = pending.pop()
                try:
                    entries = os.scandir(current)
                except OSError:
                    continue
                try:
                    for entry in entries:
                        if not budget.visit():
                            return paths
                        try:
                            if entry.name in _EXCLUDED_DIRS or entry.is_symlink():
                                continue
                            candidate = Path(entry.path)
                            if entry.is_dir(follow_symlinks=False):
                                pending.append(candidate)
                                continue
                            if not entry.is_file(follow_symlinks=False):
                                continue
                            # Store metadata is JSON/index plus JSONL activity.
                            # Do not snapshot transient editor/lock files.
                            name = entry.name
                            if not (
                                name == "index.json"
                                or name.endswith(".json")
                                or name.endswith(".activity.jsonl")
                            ):
                                continue
                            if not budget.add_candidate():
                                return paths
                            paths.append(candidate)
                        except (OSError, RuntimeError, ValueError):
                            continue
                finally:
                    try:
                        entries.close()
                    except OSError:
                        pass
        return paths

    @classmethod
    def _explicit_candidate(
        cls,
        raw: str | os.PathLike[str],
        roots: Sequence[Path],
        private_roots: Sequence[Path],
    ) -> Path | None:
        """Resolve one explicit artifact only after root/symlink validation."""

        try:
            lexical = Path(raw).expanduser()
            candidates = (
                [lexical]
                if lexical.is_absolute()
                else [root / lexical for root in (*roots, *private_roots)]
            )
            allowed_roots = [*roots, *private_roots]
            for possible in candidates:
                checked = cls._path_inside_roots(possible, allowed_roots)
                if checked is not None:
                    return checked
        except (OSError, RuntimeError, ValueError, TypeError):
            pass
        return None

    @classmethod
    def _manifest_allowed_roots(
        cls,
        manifest: Mapping[str, Any],
        private: PrivateWorkspace | None = None,
    ) -> list[Path]:
        roots: list[Path] = []
        for key in ("covered_roots", "internal_history_roots"):
            raw = manifest.get(key)
            if not isinstance(raw, list):
                continue
            roots.extend(Path(str(item)) for item in raw if str(item).strip())
        if private is not None:
            roots.append(private.root)
        return roots

    @classmethod
    def _validate_manifest_path(
        cls,
        manifest: Mapping[str, Any],
        raw_path: str | os.PathLike[str] | Path,
        *,
        private: PrivateWorkspace | None = None,
    ) -> Path:
        allowed = cls._manifest_allowed_roots(manifest, private)
        path = cls._path_inside_roots(raw_path, allowed)
        if path is None:
            # A replacement may intentionally cover a previously published
            # file in another turn's private output directory.  Keep that
            # exception path exact and bounded: the manifest records the
            # registered path, and the current turn's PrivateWorkspace gives
            # us the containing session root.  Never admit the whole session
            # root as a covered root.
            registered = manifest.get("registered_private_paths")
            if private is not None and isinstance(registered, list):
                try:
                    wanted = str(cls._lexical_absolute(raw_path))
                    session_root = private.root.parents[1]
                    candidate = cls._path_inside_roots(raw_path, [session_root])
                    if candidate is not None and any(
                        wanted == str(cls._lexical_absolute(value))
                        for value in registered
                    ):
                        return candidate
                except (OSError, RuntimeError, ValueError, TypeError, IndexError):
                    pass
            raise TurnCheckpointMissing(
                f"checkpoint path is outside covered/private roots: {raw_path}"
            )
        return path

    def _new_discovery_budget(self) -> _DiscoveryBudget:
        return _DiscoveryBudget(
            max_entries=self.max_discovery_entries,
            max_candidates=self.max_discovery_candidates,
            deadline=time.monotonic() + self.max_discovery_seconds,
        )

    def _new_observation_budget(self) -> _ObservationBudget:
        return _ObservationBudget(
            max_count=self.max_skipped_observations,
            max_bytes=self.max_skipped_observation_bytes,
            deadline=time.monotonic() + self.max_skipped_observation_seconds,
        )

    @staticmethod
    def _append_bounded_message(
        values: list[str],
        value: str,
        *,
        limit: int,
        marker: str,
    ) -> None:
        text = str(value)
        if text in values or marker in values:
            return
        if len(values) >= max(1, int(limit)):
            values.append(marker)
            return
        values.append(text)

    def _discover_paths(
        self,
        roots: Sequence[Path],
        explicit_paths: Iterable[str | os.PathLike[str]] = (),
        *,
        private_roots: Sequence[Path] = (),
        registered_private_paths: Iterable[str | os.PathLike[str]] = (),
        registered_private_roots: Sequence[Path] = (),
        budget: _DiscoveryBudget | None = None,
    ) -> tuple[list[Path], list[str], list[str], dict[str, Path]]:
        if budget is None:
            budget = self._new_discovery_budget()
        paths: dict[str, Path] = {}
        skipped: list[str] = []
        unsupported: list[str] = []
        git_roots: dict[str, Path] = {}
        # Only paths returned by the explicit publication registry may use the
        # session-wide private root.  A caller supplied path under another
        # turn's scratch directory must remain rejected even though it is
        # lexically below this session's private root.
        registered_private: dict[str, Path] = {}
        for raw in registered_private_paths:
            try:
                candidate = Path(raw)
                key = str(self._lexical_absolute(candidate))
                registered_private[key] = candidate
            except (OSError, RuntimeError, ValueError, TypeError):
                continue

        def add_candidate(candidate: Path, *, already_counted: bool = False) -> bool:
            key = str(candidate)
            if key in paths:
                return True
            if not already_counted and not budget.add_candidate():
                return False
            paths[key] = candidate
            return True

        for root in roots:
            try:
                resolved = Path(root).expanduser().resolve(strict=False)
            except (OSError, RuntimeError, ValueError):
                self._append_bounded_message(
                    skipped,
                    str(root),
                    limit=self.max_skipped_messages,
                    marker=_DISCOVERY_TRUNCATED_MARKER,
                )
                continue
            git_root = self._git_root(resolved)
            if git_root is not None:
                git_roots[str(git_root)] = git_root
                candidates = self._git_files(resolved, git_root, budget=budget)
                if not candidates:
                    candidates = self._walk_files(resolved, budget=budget)
                else:
                    # Git's tracked/untracked listing intentionally omits
                    # ignored files.  A pre-existing supported document can
                    # still be overwritten and registered as a deliverable;
                    # include only the document formats this lifecycle owns so
                    # an unknown-before file is never mistaken for a new
                    # output during rewind.  ``_walk_files`` keeps the
                    # existing excluded-directory and no-follow-links rules.
                    candidates.extend(
                        path
                        for path in self._walk_files(resolved, budget=budget)
                        if path.suffix.lower() in _SAFE_DOC_EXTENSIONS
                    )
            else:
                candidates = self._walk_files(resolved, budget=budget)
            for candidate in candidates:
                if candidate.is_symlink():
                    self._append_bounded_message(
                        skipped,
                        f"{candidate}: symlink",
                        limit=self.max_skipped_messages,
                        marker=_DISCOVERY_TRUNCATED_MARKER,
                    )
                    continue
                if not add_candidate(candidate, already_counted=True):
                    break
            if budget.truncated:
                break
        for raw in explicit_paths:
            if budget.truncated:
                break
            candidate = self._explicit_candidate(raw, roots, private_roots)
            if candidate is None:
                registered_key = self._canonical_document_path(raw)
                registered_candidate = registered_private.get(registered_key)
                if registered_candidate is not None:
                    candidate = self._explicit_candidate(
                        registered_candidate,
                        (),
                        [*private_roots, *registered_private_roots],
                    )
            if candidate is None:
                # Keep this out of skipped observations: the path is not
                # trusted, so snapshot/rewind must not read or delete it.
                self._append_bounded_message(
                    unsupported,
                    f"{raw}: outside covered/private roots",
                    limit=self.max_skipped_messages,
                    marker=_DISCOVERY_TRUNCATED_MARKER,
                )
                continue
            if candidate.suffix.lower() not in _SAFE_DOC_EXTENSIONS and not candidate.exists():
                self._append_bounded_message(
                    unsupported,
                    str(candidate),
                    limit=self.max_skipped_messages,
                    marker=_DISCOVERY_TRUNCATED_MARKER,
                )
                continue
            if not add_candidate(candidate):
                break
        # A registered private publication is itself an explicit coverage
        # request for the next turn.  It has no reason to appear in the
        # caller's ``explicit_paths`` iterable, so admit each exact path after
        # processing caller supplied paths.  The path still passes the same
        # no-follow-links and private-root checks; the registry never grants a
        # broad session-root walk.
        for registered_candidate in registered_private.values():
            if budget.truncated:
                break
            candidate = self._explicit_candidate(
                registered_candidate,
                (),
                [*private_roots, *registered_private_roots],
            )
            if candidate is None:
                continue
            if candidate.suffix.lower() not in _SAFE_DOC_EXTENSIONS and not candidate.exists():
                continue
            if not add_candidate(candidate):
                break
        if budget.truncated:
            self._append_bounded_message(
                skipped,
                _DISCOVERY_TRUNCATED_MARKER,
                limit=self.max_skipped_messages,
                marker=_DISCOVERY_TRUNCATED_MARKER,
            )
        return list(paths.values()), skipped, unsupported, git_roots

    @classmethod
    def _paths_overlap(cls, left: str, right: str) -> bool:
        try:
            a = Path(left).resolve(strict=False)
            b = Path(right).resolve(strict=False)
            a.relative_to(b)
            return True
        except ValueError:
            try:
                b.relative_to(a)
                return True
            except ValueError:
                return False

    def _acquire_workspace_locks(
        self,
        roots: Iterable[str | os.PathLike[str]],
        owner: str,
        *,
        session_id: str | None = None,
        reserve_session: bool = False,
    ) -> tuple[str, ...]:
        keys = tuple(sorted({str(Path(root).expanduser().resolve(strict=False)) for root in roots if str(root)}))
        with self._locks_guard:
            conflicts: list[str] = []
            session_key = str(session_id or "").strip()
            if session_key:
                held_transaction = self._session_transactions.get(session_key)
                if held_transaction is not None and held_transaction != owner:
                    conflicts.append(f"session:{session_key}")
                if reserve_session and self._background_writer_reservations:
                    conflicts.append("background-writer:process")
            for key in keys:
                for held, held_owner in self._workspace_locks.items():
                    if held_owner != owner and self._paths_overlap(key, held):
                        conflicts.append(held)
            if conflicts:
                raise TurnAlreadyRunning(f"workspace turn already running: {conflicts[0]}")
            for key in keys:
                self._workspace_locks[key] = owner
            if reserve_session and session_key:
                self._session_transactions[session_key] = owner
        return keys

    @classmethod
    def _release_workspace_locks(
        cls,
        keys: Iterable[str],
        owner: str,
        *,
        session_id: str | None = None,
    ) -> None:
        """Release only the exact lease entries owned by one transaction."""

        with cls._locks_guard:
            for key in keys:
                if cls._workspace_locks.get(str(key)) == owner:
                    cls._workspace_locks.pop(str(key), None)
            session_key = str(session_id or "").strip()
            if session_key and cls._session_transactions.get(session_key) == owner:
                cls._session_transactions.pop(session_key, None)

    @staticmethod
    def _git_identity(
        git_root: Path,
        *,
        max_output_bytes: int | None = None,
    ) -> dict[str, Any]:
        """Return a bounded Git identity, marking failures as unknown.

        ``git ls-files`` output scales with the repository and must never be
        collected in a ``subprocess.run(..., stdout=PIPE)`` result.  Hash the
        stream incrementally and discard the digest when the command times
        out, fails, or crosses the byte budget; a partial digest is not a
        usable identity for rewind safety.
        """

        output_limit = (
            DEFAULT_MAX_GIT_OUTPUT_BYTES
            if max_output_bytes is None
            else max(1, int(max_output_bytes))
        )

        def run_limited(
            args: list[str],
            *,
            limit: int,
            hash_output: bool,
            timeout: float = 5.0,
        ) -> tuple[str, bool]:
            try:
                process = subprocess.Popen(
                    args,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.DEVNULL,
                    close_fds=True,
                )
            except (OSError, subprocess.SubprocessError):
                return "", False

            stream = process.stdout

            def reap(*, force: bool) -> bool:
                if force:
                    try:
                        process.kill()
                    except OSError:
                        pass
                try:
                    process.wait(timeout=1)
                    return True
                except subprocess.TimeoutExpired:
                    # A first wait may race process termination.  Kill and
                    # wait again so the child and its pipe are always reaped.
                    try:
                        process.kill()
                    except OSError:
                        pass
                    try:
                        process.wait(timeout=1)
                        return True
                    except (OSError, subprocess.SubprocessError):
                        return False
                except (OSError, subprocess.SubprocessError):
                    return False

            if stream is None:
                reap(force=True)
                return "", False

            selector: selectors.BaseSelector | None = None
            complete = False
            wait_ok = False
            output_bytes = 0
            payload = bytearray()
            digest = hashlib.sha256()
            try:
                selector = selectors.DefaultSelector()
                selector.register(stream, selectors.EVENT_READ)
                deadline = time.monotonic() + max(0.01, float(timeout))
                while True:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        break
                    if not selector.select(min(remaining, 0.25)):
                        continue
                    reader = getattr(stream, "read1", None)
                    chunk = reader(64 * 1024) if callable(reader) else stream.read(64 * 1024)
                    if not chunk:
                        complete = True
                        break
                    chunk = bytes(chunk)
                    output_bytes += len(chunk)
                    if output_bytes > max(1, int(limit)):
                        break
                    if hash_output:
                        digest.update(chunk)
                    else:
                        payload.extend(chunk)
            except (OSError, ValueError, RuntimeError, selectors.SelectorError):
                complete = False
            finally:
                if selector is not None:
                    try:
                        selector.unregister(stream)
                    except (KeyError, OSError, ValueError):
                        pass
                    selector.close()
                try:
                    stream.close()
                except OSError:
                    pass
                wait_ok = reap(force=not complete)

            if not complete or not wait_ok or process.returncode != 0:
                return "", False
            if hash_output:
                return digest.hexdigest(), True
            return bytes(payload).decode("utf-8", errors="replace").strip(), True

        head, head_ok = run_limited(
            ["git", "-C", str(git_root), "rev-parse", "HEAD"],
            limit=4096,
            hash_output=False,
        )
        index, index_ok = run_limited(
            ["git", "-C", str(git_root), "ls-files", "-s", "-z"],
            limit=output_limit,
            hash_output=True,
        )
        reliable = bool(head and head_ok and index_ok)
        return {
            "root": str(git_root),
            "head": head if head_ok else "",
            "index": index if index_ok else "",
            "reliable": reliable,
        }

    def _snapshot_files(
        self,
        private: PrivateWorkspace,
        paths: Sequence[Path],
        *,
        label: str,
        skipped: list[str],
        unsupported: list[str],
        skipped_records: dict[str, dict[str, Any]] | None = None,
        observation_budget: _ObservationBudget | None = None,
    ) -> tuple[dict[str, dict[str, Any]], int]:
        if observation_budget is None:
            observation_budget = self._new_observation_budget()

        def note_skipped(
            path: Path,
            reason: str,
            *,
            observation: Mapping[str, Any] | None = None,
        ) -> None:
            key = str(path)
            self._append_bounded_message(
                skipped,
                f"{key}: {reason}",
                limit=self.max_skipped_messages,
                marker=_SKIPPED_OBSERVATION_TRUNCATED_MARKER,
            )
            if skipped_records is None or key in skipped_records:
                return
            if isinstance(observation, Mapping):
                skipped_records[key] = dict(observation)
                return
            if not observation_budget.reserve():
                self._append_bounded_message(
                    skipped,
                    _SKIPPED_OBSERVATION_TRUNCATED_MARKER,
                    limit=self.max_skipped_messages,
                    marker=_SKIPPED_OBSERVATION_TRUNCATED_MARKER,
                )
                return
            observed = self._observe_state(path, observation_budget=observation_budget)
            if isinstance(observed, Mapping):
                skipped_records[key] = dict(observed)

        records: dict[str, dict[str, Any]] = {}
        total_bytes = 0
        snapshot_dir = private.checkpoint / "snapshots"
        snapshot_dir.mkdir(parents=True, exist_ok=True)
        for index, path in enumerate(paths):
            if index >= self.max_discovery_candidates:
                self._append_bounded_message(
                    skipped,
                    _DISCOVERY_TRUNCATED_MARKER,
                    limit=self.max_skipped_messages,
                    marker=_DISCOVERY_TRUNCATED_MARKER,
                )
                observation_budget.exhausted = True
                break
            key = str(path)
            if len(records) >= self.max_files:
                note_skipped(path, "file limit")
                continue
            try:
                if self._has_symlink_component(path) or path.is_symlink():
                    note_skipped(path, "symlink")
                    continue
                if not path.exists():
                    records[key] = {
                        "path": key,
                        "kind": "file",
                        "exists": False,
                        "size": 0,
                        "sha256": "",
                        "mode": None,
                        "snapshot": None,
                    }
                    continue
                if not path.is_file():
                    unsupported.append(f"{key}: not a regular file")
                    continue
                first_stat = path.stat()
                size = int(first_stat.st_size)
                if size > self.max_file_bytes:
                    note_skipped(path, f"{size} bytes exceeds per-file limit")
                    continue
                if total_bytes + size > self.max_total_bytes:
                    note_skipped(path, "total snapshot limit")
                    continue
                data = path.read_bytes()
                last_stat = path.stat()
                stable = (
                    len(data) == size
                    and not self._has_symlink_component(path)
                    and not path.is_symlink()
                    and
                    int(last_stat.st_size) == size
                    and int(getattr(last_stat, "st_ino", 0))
                    == int(getattr(first_stat, "st_ino", 0))
                    and int(getattr(last_stat, "st_mtime_ns", 0))
                    == int(getattr(first_stat, "st_mtime_ns", 0))
                )
                if not stable:
                    # Never retain bytes read from a file that changed while
                    # it was being copied.  Mark the observation unreliable so
                    # finalize cannot advertise an undoable checkpoint.
                    note_skipped(
                        path,
                        "changed while snapshotting",
                        observation={
                            "path": key,
                            "kind": "file",
                            "exists": True,
                            "size": int(last_stat.st_size),
                            "mode": stat.S_IMODE(last_stat.st_mode),
                            "sha256": "",
                            "reliable": False,
                            "unstable": True,
                        },
                    )
                    continue
                digest = hashlib.sha256(data).hexdigest()
                snapshot_name = (
                    f"{label}-"
                    + hashlib.sha256(key.encode("utf-8", "surrogatepass")).hexdigest()
                    + ".bin"
                )
                snapshot_path = snapshot_dir / snapshot_name
                if not snapshot_path.exists():
                    _atomic_write_bytes(snapshot_path, data, mode=stat.S_IMODE(first_stat.st_mode))
                records[key] = {
                    "path": key,
                    "kind": "file",
                    "exists": True,
                    "size": size,
                    "sha256": digest,
                    "mode": stat.S_IMODE(first_stat.st_mode),
                    "inode": int(getattr(first_stat, "st_ino", 0)),
                    "mtime_ns": int(getattr(first_stat, "st_mtime_ns", 0)),
                    "snapshot": str(snapshot_path.relative_to(private.root)),
                }
                total_bytes += size
            except (OSError, ValueError) as exc:
                note_skipped(path, str(exc))
                if key not in unsupported:
                    self._append_bounded_message(
                        unsupported,
                        f"{key}: {exc}",
                        limit=self.max_skipped_messages,
                        marker=_SKIPPED_OBSERVATION_TRUNCATED_MARKER,
                    )
        if observation_budget.exhausted:
            self._append_bounded_message(
                skipped,
                _SKIPPED_OBSERVATION_TRUNCATED_MARKER,
                limit=self.max_skipped_messages,
                marker=_SKIPPED_OBSERVATION_TRUNCATED_MARKER,
            )
        return records, total_bytes

    @classmethod
    def _observe_state(
        cls,
        path: Path,
        *,
        observation_budget: _ObservationBudget | None = None,
    ) -> dict[str, Any]:
        """Record a skipped path with bounded memory and a reliable fingerprint.

        A skipped file has no rollback bytes, so rewind must never infer
        ``before == missing`` from the absence of a normal snapshot.  Hash
        regular files in fixed chunks when they are reasonably bounded; for a
        larger file, or a path whose type/metadata changes while hashing,
        return ``reliable=False`` so the checkpoint is marked incomplete.
        """

        raw = Path(path).expanduser()
        base: dict[str, Any] = {"path": str(raw)}
        try:
            if cls._has_symlink_component(raw) or raw.is_symlink():
                return {**base, "kind": "symlink", "exists": True, "reliable": False}
            if not raw.exists():
                return {
                    **base,
                    "kind": "file",
                    "exists": False,
                    "size": 0,
                    "sha256": "",
                    "mode": None,
                    "reliable": True,
                }
            if not raw.is_file():
                return {**base, "kind": "other", "exists": True, "reliable": False}
            first = raw.stat()
            size = int(first.st_size)
            mode = stat.S_IMODE(first.st_mode)
            if size > DEFAULT_MAX_OBSERVATION_BYTES:
                return {
                    **base,
                    "kind": "file",
                    "exists": True,
                    "size": size,
                    "mode": mode,
                    "sha256": "",
                    "reliable": False,
                    "too_large": True,
                }
            if observation_budget is not None and size > observation_budget.remaining_bytes:
                observation_budget.exhausted = True
                return {
                    **base,
                    "kind": "file",
                    "exists": True,
                    "size": size,
                    "mode": mode,
                    "sha256": "",
                    "reliable": False,
                    "observation_budget_exhausted": True,
                }
            digest = hashlib.sha256()
            with raw.open("rb") as handle:
                while True:
                    if (
                        observation_budget is not None
                        and time.monotonic() >= observation_budget.deadline
                    ):
                        observation_budget.exhausted = True
                        return {
                            **base,
                            "kind": "file",
                            "exists": True,
                            "size": size,
                            "mode": mode,
                            "sha256": "",
                            "reliable": False,
                            "observation_budget_exhausted": True,
                        }
                    chunk_size = 64 * 1024
                    if observation_budget is not None:
                        chunk_size = min(chunk_size, observation_budget.remaining_bytes)
                        if chunk_size <= 0:
                            observation_budget.exhausted = True
                            return {
                                **base,
                                "kind": "file",
                                "exists": True,
                                "size": size,
                                "mode": mode,
                                "sha256": "",
                                "reliable": False,
                                "observation_budget_exhausted": True,
                            }
                    chunk = handle.read(chunk_size)
                    if not chunk:
                        break
                    digest.update(chunk)
                    if observation_budget is not None:
                        observation_budget.bytes_read += len(chunk)
            last = raw.stat()
            stable = (
                int(last.st_size) == size
                and int(getattr(last, "st_ino", 0)) == int(getattr(first, "st_ino", 0))
                and int(getattr(last, "st_mtime_ns", 0)) == int(getattr(first, "st_mtime_ns", 0))
            )
            return {
                **base,
                "kind": "file",
                "exists": True,
                "size": size,
                "mode": mode,
                "sha256": digest.hexdigest(),
                "reliable": bool(stable),
            }
        except (OSError, RuntimeError, ValueError) as exc:
            return {**base, "kind": "error", "exists": True, "reliable": False, "error": str(exc)}

    @staticmethod
    def _observation_matches(
        left: Mapping[str, Any] | None,
        right: Mapping[str, Any] | None,
    ) -> bool | None:
        """Compare skipped-path observations; ``None`` means unknown."""

        if not isinstance(left, Mapping) or not isinstance(right, Mapping):
            return None
        if not bool(left.get("reliable")) or not bool(right.get("reliable")):
            return None
        if bool(left.get("exists")) != bool(right.get("exists")):
            return False
        if not bool(left.get("exists")):
            return True
        return (
            str(left.get("kind", "file")) == str(right.get("kind", "file"))
            and int(left.get("size", 0) or 0) == int(right.get("size", 0) or 0)
            and str(left.get("sha256", "")) == str(right.get("sha256", ""))
            and left.get("mode") == right.get("mode")
        )

    def _skipped_observation_status(
        self,
        manifest: Mapping[str, Any],
    ) -> tuple[set[str], set[str]]:
        """Return changed and unknown paths outside normal snapshots."""

        before = manifest.get("skipped_before")
        after = manifest.get("skipped_after")
        before_rows = before if isinstance(before, Mapping) else {}
        after_rows = after if isinstance(after, Mapping) else {}
        changed: set[str] = set()
        unknown: set[str] = set()
        seen: set[str] = set()
        exhausted = False
        for source in (before_rows, after_rows):
            try:
                keys = source.keys()
            except AttributeError:
                continue
            for raw_path in keys:
                key = str(raw_path)
                if key in seen:
                    continue
                if len(seen) >= self.max_skipped_observations:
                    exhausted = True
                    break
                seen.add(key)
                left = before_rows.get(raw_path)
                right = after_rows.get(raw_path)
                result = self._observation_matches(left, right)
                if result is True:
                    continue
                if result is False:
                    changed.add(key)
                else:
                    unknown.add(key)
            if exhausted:
                break
        if exhausted:
            unknown.add(_SKIPPED_OBSERVATION_TRUNCATED_MARKER)
        if bool(manifest.get("unobserved_skips_before")) or bool(
            manifest.get("unobserved_skips_after")
        ):
            unknown.add(_SKIPPED_OBSERVATION_TRUNCATED_MARKER)
        return changed, unknown

    @staticmethod
    def _current_state(
        path: Path,
        *,
        max_file_bytes: int = DEFAULT_MAX_FILE_BYTES,
    ) -> dict[str, Any]:
        try:
            if TurnLifecycleStore._has_symlink_component(path) or path.is_symlink():
                return {"path": str(path), "kind": "symlink", "exists": True}
            if not path.exists():
                return {"path": str(path), "kind": "file", "exists": False, "sha256": "", "mode": None, "size": 0}
            if not path.is_file():
                return {"path": str(path), "kind": "other", "exists": True}
            info = path.stat()
            size = int(info.st_size)
            mode = stat.S_IMODE(info.st_mode)
            # Rewind conflict checks must never turn a user-controlled giant
            # file into a multi-gigabyte allocation.  A bounded state is still
            # enough to reject it against any ordinary checkpoint hash.
            if size > max(1, int(max_file_bytes)):
                return {
                    "path": str(path),
                    "kind": "file",
                    "exists": True,
                    "sha256": "",
                    "mode": mode,
                    "size": size,
                    "too_large": True,
                }
            digest = hashlib.sha256()
            with path.open("rb") as handle:
                while True:
                    chunk = handle.read(64 * 1024)
                    if not chunk:
                        break
                    digest.update(chunk)
            last = path.stat()
            stable = (
                not TurnLifecycleStore._has_symlink_component(path)
                and not path.is_symlink()
                and
                int(last.st_size) == size
                and int(getattr(last, "st_ino", 0)) == int(getattr(info, "st_ino", 0))
                and int(getattr(last, "st_mtime_ns", 0))
                == int(getattr(info, "st_mtime_ns", 0))
            )
            return {
                "path": str(path),
                "kind": "file",
                "exists": True,
                "sha256": digest.hexdigest(),
                "mode": mode,
                "size": size,
                "unstable": not stable,
            }
        except OSError as exc:
            return {"path": str(path), "kind": "error", "exists": True, "error": str(exc)}

    @staticmethod
    def _state_matches(current: Mapping[str, Any], expected: Mapping[str, Any]) -> bool:
        if bool(current.get("unstable")):
            return False
        if bool(current.get("exists")) != bool(expected.get("exists")):
            return False
        if not current.get("exists"):
            return True
        return (
            current.get("kind") == expected.get("kind", "file")
            and current.get("sha256", "") == expected.get("sha256", "")
            and current.get("mode") == expected.get("mode")
            and (
                "size" not in expected
                or int(current.get("size", 0) or 0) == int(expected.get("size", 0) or 0)
            )
        )

    @staticmethod
    def _snapshot_records_match(
        left: Mapping[str, Any] | None,
        right: Mapping[str, Any] | None,
    ) -> bool:
        """Compare two bounded checkpoint records without reading their bytes."""

        a = left if isinstance(left, Mapping) else {"exists": False}
        b = right if isinstance(right, Mapping) else {"exists": False}
        if bool(a.get("exists")) != bool(b.get("exists")):
            return False
        if not bool(a.get("exists")):
            return True
        return (
            str(a.get("kind", "file")) == str(b.get("kind", "file"))
            and str(a.get("sha256", "")) == str(b.get("sha256", ""))
            and a.get("mode") == b.get("mode")
        )

    @staticmethod
    def _git_identity_is_reliable(identity: Any) -> bool:
        """Return whether one persisted Git identity is safe to compare."""

        if not isinstance(identity, Mapping):
            return False
        marker = identity.get("reliable")
        if marker is not None:
            if isinstance(marker, bool):
                return marker
            return str(marker).strip().lower() in {"1", "true", "yes"}
        # Manifests written before the explicit marker remain usable when
        # both complete hashes are present.  An empty hash is always unknown.
        return bool(str(identity.get("head", "") or "").strip()) and bool(
            str(identity.get("index", "") or "").strip()
        )

    @classmethod
    def _git_identities_are_reliable(cls, manifest: Mapping[str, Any]) -> bool:
        """Check both Git checkpoints without treating missing hashes as equal."""

        for field in ("git_before", "git_after"):
            identities = manifest.get(field)
            if identities is None:
                continue
            if not isinstance(identities, list):
                return False
            if any(not cls._git_identity_is_reliable(identity) for identity in identities):
                return False
        return True

    @staticmethod
    def _snapshot_record_shape_valid(
        path: str,
        record: Any,
    ) -> bool:
        """Validate metadata before a snapshot can drive a restore/delete."""

        if not isinstance(record, Mapping):
            return False
        required = {"path", "kind", "exists", "size", "sha256", "mode", "snapshot"}
        if not required.issubset(record):
            return False
        if not isinstance(record.get("path"), str) or record.get("path") != path:
            return False
        if record.get("kind") != "file" or not isinstance(record.get("exists"), bool):
            return False
        size = record.get("size")
        if not isinstance(size, int) or isinstance(size, bool) or size < 0:
            return False
        if not isinstance(record.get("sha256"), str):
            return False
        if not isinstance(record.get("mode"), (int, type(None))) or isinstance(
            record.get("mode"), bool
        ):
            return False
        snapshot = record.get("snapshot")
        if record.get("exists"):
            if size < 0 or not re.fullmatch(r"[0-9a-fA-F]{64}", str(record.get("sha256"))):
                return False
            if not isinstance(snapshot, str) or not snapshot or Path(snapshot).is_absolute():
                return False
            if record.get("mode") is None:
                return False
            return True
        return size == 0 and record.get("sha256") == "" and snapshot is None and record.get("mode") is None

    def _validate_snapshot_record(
        self,
        path: str,
        record: Any,
        *,
        private: PrivateWorkspace,
        field: str,
    ) -> None:
        """Fully preflight one manifest snapshot record before rewind writes."""

        if not self._snapshot_record_shape_valid(path, record):
            raise TurnCheckpointMissing(
                f"turn checkpoint {field} record is malformed: {path}"
            )
        if not bool(record.get("exists")):
            return
        relative = str(record["snapshot"])
        try:
            source = private.path(relative)
            if self._has_symlink_component(source) or source.is_symlink() or not source.is_file():
                raise ValueError("snapshot bytes are not a regular private file")
            state = self._current_state(source, max_file_bytes=self.max_file_bytes)
        except (OSError, RuntimeError, ValueError) as exc:
            raise TurnCheckpointMissing(
                f"turn checkpoint {field} snapshot is unavailable: {path}"
            ) from exc
        if (
            not bool(state.get("exists"))
            or state.get("kind") != "file"
            or bool(state.get("unstable"))
            or bool(state.get("too_large"))
            or int(state.get("size", -1)) != int(record.get("size", -2))
            or str(state.get("sha256", "")) != str(record.get("sha256", ""))
            or state.get("mode") != record.get("mode")
        ):
            raise TurnCheckpointMissing(
                f"turn checkpoint {field} snapshot does not match metadata: {path}"
            )

    def _preflight_snapshot_records(
        self,
        rows: Sequence[Mapping[str, Any]],
    ) -> None:
        """Validate all before/after records before any restore-side effect."""

        for row in rows:
            row_private = self._private_for_manifest(row)
            for field in ("before_files", "after_files"):
                if field not in row:
                    # A missing map means there were no recorded paths.  A
                    # present key with a malformed value must fail closed.
                    continue
                values = row.get(field)
                if not isinstance(values, Mapping):
                    raise TurnCheckpointMissing(f"turn checkpoint {field} map is malformed")
                for raw_path, record in values.items():
                    path = self._validate_manifest_path(
                        row,
                        str(raw_path),
                        private=row_private,
                    )
                    self._validate_snapshot_record(
                        str(path),
                        record,
                        private=row_private,
                        field=field,
                    )

    @classmethod
    def _manifest_snapshot_shapes_valid(cls, manifest: Mapping[str, Any]) -> bool:
        """Cheap listing-time shape check; rewind performs the full preflight."""

        for field in ("before_files", "after_files"):
            if field not in manifest:
                continue
            values = manifest.get(field)
            if not isinstance(values, Mapping):
                return False
            for raw_path, record in values.items():
                if not cls._snapshot_record_shape_valid(str(raw_path), record):
                    return False
        return True

    @classmethod
    def _changed_snapshot_paths(cls, manifest: Mapping[str, Any]) -> set[str]:
        """Return paths actually changed by one turn.

        A checkpoint covers a workspace so that it can detect conflicts, but a
        rewind must not restore every covered path: doing so would erase a
        user's edit to an unrelated file between two turns.
        """

        before = manifest.get("before_files") if isinstance(manifest.get("before_files"), Mapping) else {}
        after = manifest.get("after_files") if isinstance(manifest.get("after_files"), Mapping) else {}
        changed: set[str] = set()
        for path in set(before) | set(after):
            if not cls._snapshot_records_match(before.get(path), after.get(path)):
                changed.add(str(path))
        return changed

    def _record_snapshot_chat(
        self,
        private: PrivateWorkspace,
        *,
        session: Any,
        manifest: dict[str, Any],
    ) -> None:
        chat_rows = _safe_copy_rows(getattr(session, "chat_history", None))
        agent_rows = _safe_copy_rows(getattr(session, "agent_messages", None))
        boundary = {
            "chat_messages": len(chat_rows),
            "agent_messages": len(agent_rows),
            "user_messages": sum(1 for row in chat_rows if row.get("role") == "user"),
        }
        manifest["user_message_boundary"] = boundary
        for name, rows in (("chat_before.json", chat_rows), ("agent_before.json", agent_rows)):
            payload = json.dumps(rows, ensure_ascii=False, default=_json_default, separators=(",", ":"))
            encoded = payload.encode("utf-8")
            if len(encoded) > self.max_chat_snapshot_bytes:
                manifest.setdefault("skipped_paths", []).append(f"{name}: chat snapshot limit")
                continue
            path = private.checkpoint / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(encoded)
            try:
                path.chmod(0o600)
            except OSError:
                pass
            manifest[name.removesuffix(".json")] = str(path.relative_to(private.root))
        artifacts: list[dict[str, Any]] = []
        raw_artifacts = getattr(session, "artifacts", None)
        if isinstance(raw_artifacts, dict):
            for raw_path, raw_content in raw_artifacts.items():
                text = str(raw_content or "")
                row = {"path": str(raw_path), "content": text[:DEFAULT_MAX_ARTIFACT_CHARS]}
                row["truncated"] = len(text) > DEFAULT_MAX_ARTIFACT_CHARS
                encoded = text.encode("utf-8", errors="replace")
                row["content_length"] = len(encoded)
                row["content_sha256"] = hashlib.sha256(encoded).hexdigest()
                artifacts.append(row)
                if len(artifacts) >= 500:
                    break
        manifest["artifacts_before"] = artifacts

    @staticmethod
    def _load_rows(private: PrivateWorkspace, relative: str | None) -> list[dict[str, Any]] | None:
        if not relative:
            return None
        try:
            path = private.path(relative)
            with path.open("r", encoding="utf-8") as handle:
                raw = json.load(handle)
        except (OSError, ValueError, json.JSONDecodeError):
            return None
        return _safe_copy_rows(raw)

    def _private_for_manifest(self, manifest: Mapping[str, Any]) -> PrivateWorkspace:
        return ensure_private_workspace(
            str(manifest.get("session_id", "")),
            str(manifest.get("turn_id", "")),
            root=self.root,
        )

    @staticmethod
    def _canonical_document_path(value: Any) -> str:
        """Return a lexical absolute document path for identity comparisons."""

        try:
            return str(TurnLifecycleStore._lexical_absolute(str(value or "").strip()))
        except (OSError, RuntimeError, ValueError, TypeError):
            return ""

    @classmethod
    def _document_row_is_public(cls, row: Mapping[str, Any]) -> bool:
        """Whether one publication row can participate in future lineage."""

        raw_path = str(row.get("path", "") or "").strip()
        if not raw_path or not cls._business_document_path(raw_path):
            return False
        if "published" in row and not bool(row.get("published")):
            return False
        return str(row.get("source", "") or "").strip().lower() != "changed-document"

    def _document_lineage_rows(
        self,
        session_id: str,
        session: Any | None = None,
    ) -> dict[str, dict[str, Any]]:
        """Collect current registered documents for one session.

        Durable manifests are authoritative after a restart.  The in-memory
        session registry is merged last so a publication made in the current
        turn cannot be overwritten by an older durable row; rows whose path
        was explicitly superseded by a later publication are removed from the
        active set.  No filename similarity or workspace scan is used here.
        """

        sid = validate_private_identifier(session_id, field="session_id")
        rows: dict[str, dict[str, Any]] = {}
        try:
            manifests = self._iter_manifests(sid)
        except (OSError, RuntimeError, ValueError):
            manifests = []
        for manifest in manifests:
            status = str(manifest.get("status", "") or "").strip().lower()
            if status in {"aborted", "rewound"}:
                continue
            raw_deliverables = manifest.get("deliverables")
            if not isinstance(raw_deliverables, list):
                continue
            turn_id = str(manifest.get("turn_id", "") or "").strip()
            for raw in raw_deliverables:
                if not isinstance(raw, Mapping):
                    continue
                path = self._canonical_document_path(raw.get("path"))
                row = {str(key): value for key, value in raw.items()}
                if path and self._is_runtime_bookkeeping_path(manifest, path):
                    continue
                if not path or not self._document_row_is_public({**row, "path": path}):
                    continue
                row["path"] = path
                row.setdefault("session_id", sid)
                row.setdefault("turn_id", turn_id)
                old = self._canonical_document_path(
                    row.get("replaces_path") or row.get("superseded_path")
                )
                if old and old != path:
                    rows.pop(old, None)
                rows[path] = row

        # The registry contains successful publications from the currently
        # running turn before its manifest is finalized.  Merge it after the
        # durable rows so that a current publication wins over a stale row
        # loaded from an earlier checkpoint.
        if session is not None:
            raw_registry = getattr(session, "_document_lineage", None)
            if isinstance(raw_registry, Mapping):
                for raw_path, raw_row in raw_registry.items():
                    if not isinstance(raw_row, Mapping):
                        continue
                    row = {str(key): value for key, value in raw_row.items()}
                    path = self._canonical_document_path(row.get("path") or raw_path)
                    if (
                        not path
                        or self._is_runtime_bookkeeping_path_for_session(sid, path)
                        or not self._document_row_is_public({**row, "path": path})
                    ):
                        continue
                    row["path"] = path
                    row.setdefault("session_id", sid)
                    old = self._canonical_document_path(
                        row.get("replaces_path") or row.get("superseded_path")
                    )
                    if old and old != path:
                        rows.pop(old, None)
                    rows[path] = row
        return rows

    def registered_document_paths(
        self,
        session_id: str,
        session: Any | None = None,
    ) -> list[str]:
        """Return explicitly published document paths eligible for replacement.

        This list is intentionally narrow: it contains only the active rows
        from publication metadata and never arbitrary historical artifacts or
        similarly named files.
        """

        return list(self._document_lineage_rows(session_id, session).keys())

    def find_registered_document(
        self,
        session_id: str,
        path: str | os.PathLike[str] | Path,
        session: Any | None = None,
    ) -> dict[str, Any] | None:
        """Look up one explicitly published document by exact path."""

        key = self._canonical_document_path(path)
        if not key:
            return None
        row = self._document_lineage_rows(session_id, session).get(key)
        return copy.deepcopy(row) if isinstance(row, Mapping) else None

    def _superseded_document_paths(self, session_id: str) -> set[str]:
        """Return document paths replaced by a later active publication.

        This is a projection concern for the history endpoint.  Durable
        manifests retain their original rows for audit, while the UI receives
        explicit superseded/current flags so an old path cannot be revived by
        the changed-file fallback.
        """

        paths: set[str] = set()
        for manifest in self._iter_manifests(session_id):
            if (
                manifest.get("manifest_scan_truncated")
                or manifest.get("manifest_scan_error")
                or manifest.get("manifest_unreadable")
            ):
                return set()
            if str(manifest.get("status", "") or "").strip().lower() in {
                "aborted",
                "rewound",
            }:
                continue
            raw_rows = manifest.get("deliverables")
            if not isinstance(raw_rows, list):
                continue
            for raw in raw_rows:
                if not isinstance(raw, Mapping):
                    continue
                current = self._canonical_document_path(raw.get("path"))
                old = self._canonical_document_path(
                    raw.get("replaces_path") or raw.get("superseded_path")
                )
                if current and old and old != current:
                    paths.add(old)
        return paths

    @classmethod
    def _project_superseded_rows(
        cls,
        rows: Any,
        superseded_paths: set[str],
    ) -> list[Any]:
        """Copy history rows while marking replaced document paths."""

        if not isinstance(rows, list):
            return []
        projected: list[Any] = []
        for raw in rows:
            if not isinstance(raw, Mapping):
                projected.append(raw)
                continue
            row = dict(raw)
            path = cls._canonical_document_path(row.get("path"))
            if path and path in superseded_paths:
                row["superseded"] = True
                row["current"] = False
            projected.append(row)
        return projected

    @staticmethod
    def _business_document_path(path: str | os.PathLike[str] | Path) -> bool:
        """Accept supported document paths before runtime-root filtering."""

        candidate = Path(path)
        return is_supported_document_path(candidate)

    _RUNTIME_BOOKKEEPING_BASENAMES = frozenset(
        {
            "identity.md",
            "memory.md",
            "soul.md",
            "runtime.md",
            "messages.json",
            "agent_messages.json",
            "manifest.json",
            "checkpoint.json",
            "runtime.jsonl",
        }
    )

    def _managed_runtime_taskspace_roots(self, manifest: Mapping[str, Any]) -> list[Path]:
        """Return the store-owned default taskspace when it is covered.

        A session may attach arbitrary workspaces, so runtime bookkeeping is
        only trusted below this lifecycle store's own
        ``<AGX_HOME>/taskspaces/<session_id>/default`` root.  Requiring that
        root to be one of the manifest's covered roots prevents a similarly
        named user directory from being treated as runtime state.
        """

        sid = str(manifest.get("session_id", "") or "").strip()
        if not sid:
            return []
        try:
            validate_private_identifier(sid, field="session_id")
            managed = self._lexical_absolute(
                self.root.parent / "taskspaces" / sid / "default"
            )
            covered = [
                Path(str(value))
                for value in manifest.get("covered_roots", [])
                if str(value).strip()
            ]
            if self._path_inside_roots(managed, covered) is None:
                return []
            return [managed]
        except (OSError, RuntimeError, ValueError, TypeError):
            return []

    @classmethod
    def _runtime_bookkeeping_path_under_root(
        cls,
        path: str | os.PathLike[str] | Path,
        root: str | os.PathLike[str] | Path,
    ) -> bool:
        """Whether a path is a direct runtime file or managed memory child."""

        contained = cls._path_inside_roots(path, [Path(root)])
        if contained is None:
            return False
        try:
            lexical_path = cls._lexical_absolute(path)
            lexical_root = cls._lexical_absolute(root)
            relative = lexical_path.relative_to(lexical_root)
        except (OSError, RuntimeError, ValueError, TypeError):
            return False
        parts = relative.parts
        if not parts:
            return False
        if parts[0].casefold() == "memory":
            return True
        return len(parts) == 1 and parts[0].casefold() in cls._RUNTIME_BOOKKEEPING_BASENAMES

    def _is_runtime_bookkeeping_path(
        self,
        manifest: Mapping[str, Any],
        path: str | os.PathLike[str] | Path,
    ) -> bool:
        """Whether *path* belongs to a trusted runtime taskspace surface."""

        return any(
            self._runtime_bookkeeping_path_under_root(path, root)
            for root in self._managed_runtime_taskspace_roots(manifest)
        )

    def _is_runtime_bookkeeping_path_for_session(
        self,
        session_id: str,
        path: str | os.PathLike[str] | Path,
    ) -> bool:
        """Filter current in-memory lineage using the same trusted layout."""

        try:
            sid = validate_private_identifier(session_id, field="session_id")
            root = self._lexical_absolute(self.root.parent / "taskspaces" / sid / "default")
        except (OSError, RuntimeError, ValueError, TypeError):
            return False
        return self._runtime_bookkeeping_path_under_root(path, root)

    def _managed_memory_roots(self, manifest: Mapping[str, Any]) -> list[Path]:
        """Return only the runtime-owned default taskspace memory root.

        User-attached workspaces may also contain a directory named
        ``memory``.  A basename filter would hide legitimate business files,
        so the exclusion is tied to the private store's own managed layout:
        ``<AGX_HOME>/taskspaces/<session_id>/default/memory``.  The same
        derivation also protects manifests written before this marker was
        introduced.
        """

        sid = str(manifest.get("session_id", "") or "").strip()
        if not sid:
            return []
        try:
            validate_private_identifier(sid, field="session_id")
            return [root / "memory" for root in self._managed_runtime_taskspace_roots(manifest)]
        except (OSError, RuntimeError, ValueError, TypeError):
            return []

    def _is_managed_memory_path(
        self,
        manifest: Mapping[str, Any],
        path: str | os.PathLike[str] | Path,
    ) -> bool:
        """Whether *path* is below the trusted runtime memory directory."""

        return self._path_inside_roots(path, self._managed_memory_roots(manifest)) is not None

    def _filter_managed_memory_rows(
        self,
        manifest: Mapping[str, Any],
        rows: Any,
    ) -> list[Any]:
        """Filter trusted runtime rows in legacy and current projections."""

        if not isinstance(rows, list):
            return []
        filtered: list[Any] = []
        for row in rows:
            if isinstance(row, Mapping):
                raw_path = str(row.get("path", "") or "").strip()
                if raw_path and self._is_runtime_bookkeeping_path(manifest, raw_path):
                    continue
            filtered.append(row)
        return filtered

    def _normalize_deliverable_row(
        self,
        manifest: Mapping[str, Any],
        raw: Mapping[str, Any],
        *,
        private: PrivateWorkspace,
    ) -> dict[str, Any] | None:
        """Validate one explicit publication row for the current manifest."""

        raw_path = str(raw.get("path", "") or "").strip()
        if not raw_path:
            return None
        if "published" in raw and not bool(raw.get("published")):
            return None
        try:
            path = self._validate_manifest_path(manifest, raw_path, private=private)
        except TurnCheckpointMissing:
            return None
        if not self._business_document_path(path):
            return None
        if self._is_runtime_bookkeeping_path(manifest, path):
            return None
        # The current turn's outputs directory is intentionally a visible
        # publication surface.  Keep only checkpoint/scratch/logs private;
        # marking the whole private turn root as private hides the default
        # document_generate result in Desktop.
        if self._path_inside_roots(
            path,
            [private.root / name for name in ("scratch", "logs", "checkpoint")],
        ) is not None:
            return None
        after_rows = manifest.get("after_files")
        after = after_rows.get(str(path)) if isinstance(after_rows, Mapping) else None
        if not isinstance(after, Mapping) or not bool(after.get("exists")):
            return None
        document_format = document_format_for_path(path)
        if not document_format:
            return None
        row: dict[str, Any] = {
            "path": str(path),
            "title": str(raw.get("title", "") or Path(path).stem).strip()[:500]
            or Path(path).stem,
            "format": document_format,
            "filename": Path(path).name,
            "mimeType": str(raw.get("mimeType", "") or document_mime_type(path)),
            "private": False,
        }
        for key in (
            "size",
            "sha256",
            "published",
            "source",
            "lineage_id",
            "replaces_path",
            "superseded_path",
            "superseded_sha256",
            "superseded_size",
            "superseded_archive_path",
            "lineage_ambiguous",
            "needs_source_path",
            "warning",
        ):
            if key not in raw:
                continue
            value = raw.get(key)
            if key in {"replaces_path", "superseded_path"} and value:
                try:
                    # Keep logical replacement metadata exact and bounded;
                    # do not resolve it to an arbitrary external target here.
                    value = str(value)[:4096]
                except Exception:
                    continue
            elif key == "warning" and value:
                value = str(value)[:1000]
            row[key] = value
        return row

    def _derive_changed_document_rows(
        self,
        manifest: Mapping[str, Any],
        *,
        private: PrivateWorkspace,
        explicit_paths: set[str],
    ) -> list[dict[str, Any]]:
        """Derive workspace document rows from actual before/after changes."""

        before = manifest.get("before_files")
        after = manifest.get("after_files")
        if not isinstance(before, Mapping) or not isinstance(after, Mapping):
            return []
        rows: list[dict[str, Any]] = []
        for raw_path in sorted(self._changed_snapshot_paths(manifest)):
            try:
                path = self._validate_manifest_path(manifest, raw_path, private=private)
            except TurnCheckpointMissing:
                continue
            key = str(path)
            if key in explicit_paths or not self._business_document_path(path):
                continue
            if self._is_runtime_bookkeeping_path(manifest, path):
                continue
            # Private scratch files are only deliverables when a publication
            # explicitly registered them.  This prevents helper scripts and
            # checkpoint copies from becoming gallery cards.
            if private.contains(path):
                continue
            record = after.get(raw_path)
            if not isinstance(record, Mapping) or not bool(record.get("exists")):
                continue
            fmt = document_format_for_path(path)
            if not fmt:
                continue
            rows.append(
                {
                    "path": key,
                    "title": Path(path).stem,
                    "format": fmt,
                    "filename": Path(path).name,
                    "mimeType": document_mime_type(path),
                    "private": False,
                    "published": False,
                    "source": "changed-document",
                    "size": int(record.get("size", 0) or 0),
                    "sha256": str(record.get("sha256", "") or ""),
                }
            )
        return rows

    @staticmethod
    def _artifact_content_fingerprint(value: Any) -> tuple[int, str]:
        """Return bounded, deterministic metadata for one session artifact value."""

        text = str(value or "")
        encoded = text.encode("utf-8", errors="replace")
        return len(encoded), hashlib.sha256(encoded).hexdigest()

    @staticmethod
    def _business_artifact_path(path: Path) -> bool:
        """Filter known internal directories while retaining user names."""

        return not any(
            part.casefold() in {
                ".git",
                "node_modules",
                "site-packages",
                "__pycache__",
                ".venv",
                "venv",
                "virtualenv",
            }
            for part in path.parts
        )

    def _derive_current_artifact_rows(
        self,
        manifest: Mapping[str, Any],
        *,
        session: Any | None,
        private: PrivateWorkspace,
        internal_roots: Sequence[Path],
        explicit_document_paths: set[str],
    ) -> list[dict[str, Any]]:
        """Project changed current-turn session artifacts into the manifest.

        ``session.artifacts`` is cumulative for the lifetime of a session.  A
        turn manifest must therefore compare its values with the bounded
        ``artifacts_before`` snapshot and expose only new/changed paths.  This
        keeps image/PDF and other non-document handoffs working while stale
        historical entries remain out of the authoritative list.
        """

        raw_artifacts = getattr(session, "artifacts", None) if session is not None else None
        if not isinstance(raw_artifacts, dict):
            return []
        before_rows = manifest.get("artifacts_before")
        before_by_path: dict[str, Mapping[str, Any]] = {}
        if isinstance(before_rows, list):
            for raw in before_rows:
                if not isinstance(raw, Mapping):
                    continue
                key = self._canonical_document_path(raw.get("path"))
                if key:
                    before_by_path[key] = raw
        allowed_roots = [
            *(
                Path(str(value))
                for value in manifest.get("covered_roots", [])
                if str(value).strip()
            ),
            private.root,
            *internal_roots,
        ]
        after_files = manifest.get("after_files")
        if not isinstance(after_files, Mapping):
            return []
        rows: list[dict[str, Any]] = []
        for index, (raw_path, raw_content) in enumerate(raw_artifacts.items()):
            if index >= self.max_discovery_candidates:
                break
            try:
                path = self._path_inside_roots(raw_path, allowed_roots)
            except (OSError, RuntimeError, ValueError, TypeError):
                path = None
            if path is None:
                continue
            if self._path_inside_roots(
                path,
                [private.root / name for name in ("scratch", "logs", "checkpoint")],
            ) is not None:
                continue
            if self._is_runtime_bookkeeping_path(manifest, path):
                continue
            if not self._business_artifact_path(path):
                continue
            key = str(path)
            if key in explicit_document_paths and is_supported_document_path(path):
                continue
            after = after_files.get(key)
            if not isinstance(after, Mapping) or not bool(after.get("exists")):
                # Artifact metadata without a verified on-disk file cannot be
                # opened by the handoff card and must not become authoritative.
                continue
            length, digest = self._artifact_content_fingerprint(raw_content)
            before = before_by_path.get(key)
            if before is not None:
                old_length = before.get("content_length")
                old_digest = str(before.get("content_sha256", "") or "")
                if old_digest and old_length is not None:
                    try:
                        if int(old_length) == length and old_digest == digest:
                            continue
                    except (TypeError, ValueError, OverflowError):
                        pass
                elif not bool(before.get("truncated")) and str(before.get("content", "")) == str(raw_content or ""):
                    continue
            suffix = path.suffix.lower().lstrip(".") or "file"
            mime_type, _encoding = mimetypes.guess_type(str(path))
            rows.append(
                {
                    "path": key,
                    "title": path.stem or path.name,
                    "format": suffix,
                    "filename": path.name,
                    "mimeType": mime_type or "application/octet-stream",
                    "size": int(after.get("size", 0) or 0),
                    "sha256": str(after.get("sha256", "") or ""),
                    "private": False,
                    "published": True,
                    "current": True,
                    "source": "session-artifacts",
                }
            )
        return rows

    # ------------------------------------------------------------------
    # Public lifecycle API
    # ------------------------------------------------------------------

    def begin(
        self,
        session_id: str,
        turn_id: str | None = None,
        *,
        client_turn_id: str | None = None,
        session: Any | None = None,
        workspace_roots: Sequence[str | os.PathLike[str]] | None = None,
        explicit_paths: Iterable[str | os.PathLike[str]] = (),
        internal_history_roots: Sequence[str | os.PathLike[str]] | None = None,
        metadata_roots: Sequence[str | os.PathLike[str]] | None = None,
    ) -> TurnHandle:
        sid = validate_private_identifier(session_id, field="session_id")
        tid = validate_private_identifier(turn_id or uuid.uuid4().hex, field="turn_id")
        with self._session_guard:
            # A repeated continuation of a logical user request keeps its
            # original checkpoint.  Matching both ids prevents a random turn
            # id collision from attaching to another request.
            existing_manifests = self._iter_manifests(sid)
            history_scan_truncated = any(
                row.get("manifest_scan_truncated")
                or row.get("manifest_scan_error")
                or row.get("manifest_unreadable")
                for row in existing_manifests
            )
            for existing in existing_manifests:
                if history_scan_truncated or existing.get("manifest_scan_truncated") or existing.get("manifest_scan_error"):
                    continue
                if (
                    client_turn_id
                    and str(existing.get("client_turn_id", "")) == str(client_turn_id)
                    and existing.get("status") not in {"rewound", "aborted"}
                ):
                    self._acquire_workspace_locks(
                        existing.get("covered_roots", []),
                        f"{sid}:{existing.get('turn_id', '')}",
                        session_id=sid,
                    )
                    private = self._private_for_manifest(existing)
                    return TurnHandle(sid, str(existing["turn_id"]), private, resumed=True)
                if str(existing.get("turn_id", "")) == tid:
                    self._acquire_workspace_locks(
                        existing.get("covered_roots", []),
                        f"{sid}:{tid}",
                        session_id=sid,
                    )
                    private = self._private_for_manifest(existing)
                    return TurnHandle(sid, tid, private, resumed=True)

            roots = [Path(value).expanduser().resolve(strict=False) for value in (workspace_roots or self._roots_from_session(session))]
            # Read prior manifests before creating this turn's directory.  A
            # newly created, still-empty turn directory is intentionally not a
            # valid manifest and can otherwise make the bounded history scan
            # fail closed before prior private publications are admitted.
            registered_document_paths = self.registered_document_paths(sid, session)
            private = ensure_private_workspace(sid, tid, root=self.root)
            supplied_history_roots = internal_history_roots
            if supplied_history_roots is None:
                supplied_history_roots = metadata_roots
            if supplied_history_roots is None:
                # SessionManager normally supplies this explicitly.  The
                # deterministic fallback is still scoped to this lifecycle
                # store's own sessions root, so a custom test store never
                # consults the process user's real home directory.
                supplied_history_roots = [self._session_root(sid) / "subagent_runs"]
            internal_roots = self._validated_internal_history_roots(sid, supplied_history_roots)
            deduped_roots: list[Path] = []
            seen_roots: set[str] = set()
            for root in roots:
                key = str(root)
                if key not in seen_roots:
                    seen_roots.add(key)
                    deduped_roots.append(root)
            lock_owner = f"{sid}:{tid}"
            lock_keys = self._acquire_workspace_locks(
                deduped_roots,
                lock_owner,
                session_id=sid,
            )

            try:
                discovery_budget = self._new_discovery_budget()
                paths, skipped, unsupported, git_roots = self._discover_paths(
                    deduped_roots,
                    explicit_paths,
                    private_roots=[private.root, *internal_roots],
                    registered_private_paths=registered_document_paths,
                    registered_private_roots=[self._session_root(sid)],
                    budget=discovery_budget,
                )
                paths_by_key = {str(path): path for path in paths}
                for path in self._internal_history_paths(
                    internal_roots,
                    budget=discovery_budget,
                ):
                    paths_by_key.setdefault(str(path), path)
                paths = list(paths_by_key.values())
                skipped_before: dict[str, dict[str, Any]] = {}
                discovery_skip_count = len(skipped)
                if discovery_budget.truncated:
                    self._append_bounded_message(
                        skipped,
                        _DISCOVERY_TRUNCATED_MARKER,
                        limit=self.max_skipped_messages,
                        marker=_DISCOVERY_TRUNCATED_MARKER,
                    )
                observation_budget = self._new_observation_budget()
                before_files, snap_bytes = self._snapshot_files(
                    private,
                    paths,
                    label="before",
                    skipped=skipped,
                    unsupported=unsupported,
                    skipped_records=skipped_before,
                    observation_budget=observation_budget,
                )
                unobserved_skips_before = (
                    bool(discovery_skip_count)
                    or bool(discovery_budget.truncated)
                    or bool(observation_budget.exhausted)
                )
                manifest: dict[str, Any] = {
                    "version": TURN_MANIFEST_VERSION,
                    "session_id": sid,
                    "turn_id": tid,
                    "client_turn_id": str(client_turn_id or "").strip(),
                    "created_at": time.time(),
                    "updated_at": time.time(),
                    "status": "running",
                    "covered_roots": [str(path) for path in deduped_roots],
                    "managed_memory_roots": [
                        str(path) for path in self._managed_memory_roots(
                            {
                                "session_id": sid,
                                "covered_roots": [str(path) for path in deduped_roots],
                            }
                        )
                    ],
                    "internal_history_roots": [str(path) for path in internal_roots],
                    # These are exact prior published private outputs admitted
                    # for replacement coverage.  Keeping paths rather than a
                    # broad session root preserves the cross-turn privacy
                    # fence during finalize and rewind.
                    "registered_private_paths": [
                        str(path)
                        for path in registered_document_paths[: self.max_discovery_candidates]
                    ],
                    "covered_paths": list(before_files),
                    "before_files": before_files,
                    "after_files": {},
                    "git_before": [self._git_identity(path) for path in git_roots.values()],
                    "git_after": [],
                    "skipped_paths": skipped,
                    "skipped_before": skipped_before,
                    "skipped_after": {},
                    "skipped_changed_paths": [],
                    "skipped_unknown_paths": [],
                    "unobserved_skips_before": unobserved_skips_before,
                    "unobserved_skips_after": False,
                    "discovery_complete": not discovery_budget.truncated,
                    "discovery_visited_entries": discovery_budget.visited_entries,
                    "discovery_candidates": discovery_budget.candidates,
                    "skipped_observation_budget_exhausted": observation_budget.exhausted,
                    "checkpoint_complete": False,
                    "unavailable_paths": [],
                    "unsupported_paths": unsupported,
                    "snapshot_bytes": snap_bytes,
                    "deliverables": [],
                }
                if session is not None:
                    self._record_snapshot_chat(private, session=session, manifest=manifest)
                self._write_manifest(manifest)
            except Exception:
                with self._locks_guard:
                    for key in lock_keys:
                        if self._workspace_locks.get(key) == f"{sid}:{tid}":
                            self._workspace_locks.pop(key, None)
                raise
            return TurnHandle(sid, tid, private, resumed=False)

    def finalize(
        self,
        session_id: str,
        turn_id: str,
        *,
        session: Any | None = None,
        status: str = "completed",
        reason: str | None = None,
        deliverables: Iterable[Mapping[str, Any] | str] = (),
    ) -> dict[str, Any]:
        sid = validate_private_identifier(session_id, field="session_id")
        tid = validate_private_identifier(turn_id, field="turn_id")
        with self._session_guard:
            manifest = self._read_manifest(sid, tid)
            if manifest is None:
                raise TurnCheckpointMissing(f"turn checkpoint not found: {tid}")
            if manifest.get("manifest_unreadable"):
                raise TurnCheckpointMissing(
                    str(manifest.get("incomplete_reason") or "turn checkpoint manifest is unavailable")
                )
            if manifest.get("status") == "rewound":
                return manifest
            private = self._private_for_manifest(manifest)
            # Materialize the explicit publication channel once under the
            # same candidate budget used for filesystem discovery.  A tool
            # result is allowed to be authoritative even when its caller did
            # not mirror the path into ``session.artifacts``; adding these
            # exact paths here lets after-state capture verify that contract
            # without reviving the cumulative-artifact fallback.
            deliverable_items: list[Mapping[str, Any] | str] = []
            deliverables_truncated = False
            for index, item in enumerate(deliverables):
                if index >= self.max_discovery_candidates:
                    deliverables_truncated = True
                    break
                if isinstance(item, Mapping):
                    deliverable_items.append(item)
                elif str(item).strip():
                    deliverable_items.append(str(item).strip())
            roots = [Path(str(value)).expanduser().resolve(strict=False) for value in manifest.get("covered_roots", [])]
            internal_roots = self._validated_internal_history_roots(
                sid,
                [str(value) for value in manifest.get("internal_history_roots", [])]
                if isinstance(manifest.get("internal_history_roots"), list)
                else None,
            )
            before_paths: list[Path] = []
            before_paths_truncated = deliverables_truncated
            raw_before_paths = manifest.get("covered_paths")
            if isinstance(raw_before_paths, list):
                for value in raw_before_paths:
                    if len(before_paths) >= self.max_discovery_candidates:
                        before_paths_truncated = True
                        break
                    before_paths.append(Path(str(value)))
            if not before_paths and isinstance(manifest.get("before_files"), Mapping):
                for value in manifest.get("before_files", {}):
                    if len(before_paths) >= self.max_discovery_candidates:
                        before_paths_truncated = True
                        break
                    before_paths.append(Path(str(value)))
            explicit_paths: list[str] = []
            if session is not None and isinstance(getattr(session, "artifacts", None), dict):
                for path in session.artifacts.keys():
                    if len(explicit_paths) >= self.max_discovery_candidates:
                        before_paths_truncated = True
                        break
                    explicit_paths.append(str(path))
            for item in deliverable_items:
                raw_path = (
                    str(item.get("path", "") or "").strip()
                    if isinstance(item, Mapping)
                    else str(item).strip()
                )
                if raw_path and len(explicit_paths) < self.max_discovery_candidates:
                    explicit_paths.append(raw_path)
            discovery_budget = self._new_discovery_budget()
            discovered, discovered_skipped, discovered_unsupported, git_roots = self._discover_paths(
                roots,
                explicit_paths,
                private_roots=[private.root, *internal_roots],
                budget=discovery_budget,
            )
            discovered.extend(
                self._internal_history_paths(
                    internal_roots,
                    budget=discovery_budget,
                )
            )
            paths_by_key = {str(path): path for path in before_paths}
            for path in discovered:
                key = str(path)
                if key in paths_by_key:
                    continue
                if len(paths_by_key) >= self.max_discovery_candidates:
                    before_paths_truncated = True
                    break
                paths_by_key[key] = path
            paths = list(paths_by_key.values())
            skipped: list[str] = []
            for item in manifest.get("skipped_paths", []) if isinstance(manifest.get("skipped_paths"), list) else []:
                self._append_bounded_message(
                    skipped,
                    str(item),
                    limit=self.max_skipped_messages,
                    marker=_SKIPPED_OBSERVATION_TRUNCATED_MARKER,
                )
            unsupported: list[str] = []
            for item in manifest.get("unsupported_paths", []) if isinstance(manifest.get("unsupported_paths"), list) else []:
                self._append_bounded_message(
                    unsupported,
                    str(item),
                    limit=self.max_skipped_messages,
                    marker=_SKIPPED_OBSERVATION_TRUNCATED_MARKER,
                )
            for item in discovered_skipped:
                self._append_bounded_message(
                    skipped,
                    item,
                    limit=self.max_skipped_messages,
                    marker=_SKIPPED_OBSERVATION_TRUNCATED_MARKER,
                )
            for item in discovered_unsupported:
                self._append_bounded_message(
                    unsupported,
                    item,
                    limit=self.max_skipped_messages,
                    marker=_SKIPPED_OBSERVATION_TRUNCATED_MARKER,
                )
            if before_paths_truncated or discovery_budget.truncated:
                self._append_bounded_message(
                    skipped,
                    _DISCOVERY_TRUNCATED_MARKER,
                    limit=self.max_skipped_messages,
                    marker=_DISCOVERY_TRUNCATED_MARKER,
                )
            skipped_after: dict[str, dict[str, Any]] = {}
            observation_budget = self._new_observation_budget()
            safe_paths: list[Path] = []
            for path in paths:
                try:
                    self._validate_manifest_path(manifest, path, private=private)
                except TurnCheckpointMissing:
                    # A path that is now a symlink remains observable as an
                    # unsafe skipped path, making the checkpoint incomplete;
                    # an external/forged path is discarded without reading it.
                    if self._has_symlink_component(path) or path.is_symlink():
                        key = str(path)
                        if not any(key == item.split(":", 1)[0] for item in skipped):
                            self._append_bounded_message(
                                skipped,
                                f"{key}: symlink",
                                limit=self.max_skipped_messages,
                                marker=_SKIPPED_OBSERVATION_TRUNCATED_MARKER,
                            )
                        if observation_budget.reserve():
                            observed = self._observe_state(
                                path,
                                observation_budget=observation_budget,
                            )
                            if isinstance(observed, Mapping):
                                skipped_after[key] = dict(observed)
                        else:
                            self._append_bounded_message(
                                skipped,
                                _SKIPPED_OBSERVATION_TRUNCATED_MARKER,
                                limit=self.max_skipped_messages,
                                marker=_SKIPPED_OBSERVATION_TRUNCATED_MARKER,
                            )
                    else:
                        self._append_bounded_message(
                            unsupported,
                            f"{path}: outside covered/private roots",
                            limit=self.max_skipped_messages,
                            marker=_SKIPPED_OBSERVATION_TRUNCATED_MARKER,
                        )
                    continue
                safe_paths.append(path)
            paths = safe_paths
            before_files = manifest.get("before_files")
            before_files = before_files if isinstance(before_files, Mapping) else {}
            unavailable_paths: list[str] = []
            if isinstance(manifest.get("unavailable_paths"), list):
                for item in manifest.get("unavailable_paths", []):
                    if not str(item).strip():
                        continue
                    self._append_bounded_message(
                        unavailable_paths,
                        str(item),
                        limit=self.max_skipped_messages,
                        marker=_SKIPPED_OBSERVATION_TRUNCATED_MARKER,
                    )
            private_and_internal = [private.root, *internal_roots]
            for raw in explicit_paths:
                candidate = self._explicit_candidate(raw, roots, private_and_internal)
                if candidate is None:
                    continue
                key = str(candidate)
                if key in before_files:
                    continue
                # Private runtime outputs are already covered by their own
                # turn directory and must remain undoable when newly created.
                if self._path_inside_roots(candidate, private_and_internal) is not None:
                    continue
                ignored = any(self._git_ignored(candidate, git_root) for git_root in git_roots.values())
                if not self._is_excluded(candidate) and not ignored:
                    continue
                marker = f"{key}: before state was not captured"
                if marker not in unavailable_paths:
                    self._append_bounded_message(
                        unavailable_paths,
                        marker,
                        limit=self.max_skipped_messages,
                        marker=_SKIPPED_OBSERVATION_TRUNCATED_MARKER,
                    )
            after_files, snap_bytes = self._snapshot_files(
                private,
                paths,
                label="after",
                skipped=skipped,
                unsupported=unsupported,
                skipped_records=skipped_after,
                observation_budget=observation_budget,
            )
            # A path that was skipped before may fit within the cap now.  Keep
            # a fresh observation anyway; otherwise ``before missing + after
            # present`` would be mistaken for a safely-created file and undo
            # could delete it without having its original bytes.
            skipped_before = manifest.get("skipped_before")
            if isinstance(skipped_before, Mapping):
                for index, raw_path in enumerate(skipped_before):
                    if index >= self.max_skipped_observations:
                        observation_budget.exhausted = True
                        break
                    key = str(raw_path)
                    if key not in skipped_after:
                        if not observation_budget.reserve():
                            break
                        observed = self._observe_state(
                            Path(key),
                            observation_budget=observation_budget,
                        )
                        if isinstance(observed, Mapping):
                            skipped_after[key] = dict(observed)
            if observation_budget.exhausted:
                self._append_bounded_message(
                    skipped,
                    _SKIPPED_OBSERVATION_TRUNCATED_MARKER,
                    limit=self.max_skipped_messages,
                    marker=_SKIPPED_OBSERVATION_TRUNCATED_MARKER,
                )
            unobserved_after = bool(discovered_skipped) or bool(discovery_budget.truncated)
            unobserved_after = unobserved_after or bool(before_paths_truncated)
            unobserved_after = unobserved_after or bool(observation_budget.exhausted)
            if not skipped_after and skipped and not isinstance(skipped_before, Mapping):
                unobserved_after = True
            skip_probe_manifest = {
                "skipped_before": skipped_before if isinstance(skipped_before, Mapping) else {},
                "skipped_after": skipped_after,
                "unobserved_skips_before": bool(manifest.get("unobserved_skips_before")),
                "unobserved_skips_after": unobserved_after,
            }
            skipped_changed, skipped_unknown = self._skipped_observation_status(skip_probe_manifest)
            git_roots: dict[str, Path] = {}
            for root in roots:
                git_root = self._git_root(root)
                if git_root is not None:
                    git_roots[str(git_root)] = git_root
            manifest["after_files"] = after_files
            covered_paths: list[str] = []
            covered_seen: set[str] = set()
            raw_covered_paths = (
                manifest.get("covered_paths")
                if isinstance(manifest.get("covered_paths"), list)
                else []
            )
            for path_source in (raw_covered_paths, after_files):
                for raw_path in path_source:
                    key = str(raw_path)
                    if key in covered_seen:
                        continue
                    if len(covered_paths) >= self.max_discovery_candidates:
                        before_paths_truncated = True
                        break
                    covered_seen.add(key)
                    covered_paths.append(key)
                if before_paths_truncated:
                    break
            manifest["covered_paths"] = covered_paths
            manifest["git_after"] = [self._git_identity(path) for path in git_roots.values()]
            git_identity_complete = self._git_identities_are_reliable(manifest)
            manifest["skipped_paths"] = skipped
            manifest["skipped_after"] = skipped_after
            manifest["skipped_changed_paths"] = sorted(skipped_changed)
            manifest["skipped_unknown_paths"] = sorted(skipped_unknown)
            manifest["unobserved_skips_after"] = unobserved_after
            manifest["discovery_complete"] = not (
                bool(discovery_budget.truncated) or bool(before_paths_truncated)
            )
            manifest["discovery_visited_entries"] = discovery_budget.visited_entries
            manifest["discovery_candidates"] = discovery_budget.candidates
            manifest["skipped_observation_budget_exhausted"] = observation_budget.exhausted
            manifest["unavailable_paths"] = sorted(unavailable_paths)
            manifest["checkpoint_complete"] = (
                not skipped_changed
                and not skipped_unknown
                and not unavailable_paths
                and not discovery_budget.truncated
                and not before_paths_truncated
                and not observation_budget.exhausted
                and git_identity_complete
            )
            if not manifest["checkpoint_complete"]:
                if unavailable_paths:
                    manifest["incomplete_reason"] = (
                        "before state was unavailable for explicit artifact paths"
                    )
                elif skipped_changed:
                    manifest["incomplete_reason"] = "skipped paths changed without rollback snapshots"
                elif discovery_budget.truncated or before_paths_truncated:
                    manifest["incomplete_reason"] = (
                        "workspace discovery was truncated by a safety budget"
                    )
                elif not git_identity_complete:
                    manifest["incomplete_reason"] = "Git identity could not be reliably recorded"
                else:
                    manifest["incomplete_reason"] = "skipped paths could not be reliably observed"
            manifest["unsupported_paths"] = unsupported
            manifest["after_snapshot_bytes"] = snap_bytes
            clean_status = str(status or "completed").strip().lower()
            if clean_status not in {"completed", "failed", "interrupted", "aborted"}:
                clean_status = "completed"
            manifest["status"] = clean_status
            manifest["reason"] = str(reason or "").strip()
            rows: list[dict[str, Any]] = []
            for item in deliverable_items:
                if isinstance(item, Mapping):
                    normalized = self._normalize_deliverable_row(
                        manifest,
                        item,
                        private=private,
                    )
                    if normalized is not None:
                        rows.append(normalized)
                elif str(item).strip():
                    raw_path = str(item).strip()
                    normalized = self._normalize_deliverable_row(
                        manifest,
                        {"path": raw_path},
                        private=private,
                    )
                    if normalized is not None:
                        rows.append(normalized)
            # Explicit successful publication rows are authoritative for
            # private outputs.  For workspace files edited by a script or
            # file_edit, add only actual changed supported documents; never
            # fall back to the cumulative session.artifacts map.
            explicit_paths = {str(row.get("path", "")) for row in rows}
            rows.extend(
                self._derive_changed_document_rows(
                    manifest,
                    private=private,
                    explicit_paths=explicit_paths,
                )
            )
            document_paths = {
                str(row.get("path", ""))
                for row in rows
                if is_supported_document_path(str(row.get("path", "")))
            }
            rows.extend(
                self._derive_current_artifact_rows(
                    manifest,
                    session=session,
                    private=private,
                    internal_roots=internal_roots,
                    explicit_document_paths=document_paths,
                )
            )
            manifest["deliverables"] = rows
            manifest["updated_at"] = time.time()
            manifest["files"] = self._file_changes(manifest, private)
            self._write_manifest(manifest)
            self._release_manifest_locks(manifest)
            return manifest

    def abort(
        self,
        session_id: str,
        turn_id: str,
        *,
        session: Any | None = None,
        reason: str | None = None,
        status: str = "failed",
    ) -> dict[str, Any]:
        """Terminalize an unusable checkpoint and always release its lease.

        This is the small failure hook for callers that could not durably
        persist chat or complete ``finalize``.  It deliberately does not take a
        post-turn snapshot and never marks a partial checkpoint completed.
        """

        sid = validate_private_identifier(session_id, field="session_id")
        tid = validate_private_identifier(turn_id, field="turn_id")
        with self._session_guard:
            manifest = self._read_manifest(sid, tid)
            if manifest is None:
                raise TurnCheckpointMissing(f"turn checkpoint not found: {tid}")
            clean_status = str(status or "failed").strip().lower()
            if clean_status not in {"failed", "interrupted", "aborted"}:
                clean_status = "failed"
            manifest["status"] = clean_status
            manifest["reason"] = str(reason or "turn finalization failed").strip()
            manifest["checkpoint_complete"] = False
            manifest["incomplete_reason"] = manifest["reason"]
            manifest["updated_at"] = time.time()
            try:
                self._write_manifest(manifest)
            finally:
                # Even a manifest write error must not leave a stale writer
                # lease preventing all future turns in this workspace.
                self._release_manifest_locks(manifest)
            return manifest

    def _release_manifest_locks(self, manifest: Mapping[str, Any]) -> None:
        owner = f"{manifest.get('session_id', '')}:{manifest.get('turn_id', '')}"
        with self._locks_guard:
            for root in manifest.get("covered_roots", []):
                key = str(root)
                if self._workspace_locks.get(key) == owner:
                    self._workspace_locks.pop(key, None)
            # An oversized/corrupt manifest deliberately carries no parsed
            # ``covered_roots``.  Still release a lease created earlier in the
            # same process so a failed finalization cannot permanently block
            # future turns for this session.
            if not manifest.get("covered_roots"):
                for key, current_owner in list(self._workspace_locks.items()):
                    if current_owner == owner:
                        self._workspace_locks.pop(key, None)

    @staticmethod
    def _snapshot_bytes(private: PrivateWorkspace, record: Mapping[str, Any]) -> bytes | None:
        if not bool(record.get("exists")):
            return None
        relative = record.get("snapshot")
        if not relative:
            return None
        try:
            return private.path(str(relative)).read_bytes()
        except (OSError, ValueError):
            return None

    def _file_changes(self, manifest: Mapping[str, Any], private: PrivateWorkspace) -> list[dict[str, Any]]:
        before = manifest.get("before_files") if isinstance(manifest.get("before_files"), dict) else {}
        after = manifest.get("after_files") if isinstance(manifest.get("after_files"), dict) else {}
        internal_roots = [
            Path(str(item))
            for item in manifest.get("internal_history_roots", [])
            if str(item).strip()
        ] if isinstance(manifest.get("internal_history_roots"), list) else []
        rows: list[dict[str, Any]] = []
        for path in sorted(set(before) | set(after)):
            # Private runtime files and SubAgentRunStore's internal history are
            # transactional state, not user-facing deliverables.
            if self._path_inside_roots(path, [private.root, *internal_roots]) is not None:
                continue
            if self._is_runtime_bookkeeping_path(manifest, path):
                continue
            old = before.get(path) if isinstance(before.get(path), dict) else {"exists": False}
            new = after.get(path) if isinstance(after.get(path), dict) else {"exists": False}
            old_exists = bool(old.get("exists"))
            new_exists = bool(new.get("exists"))
            if old_exists and new_exists and old.get("sha256") == new.get("sha256") and old.get("mode") == new.get("mode"):
                continue
            change = "modified" if old_exists and new_exists else "added" if new_exists else "deleted"
            added, removed = _line_delta(self._snapshot_bytes(private, old), self._snapshot_bytes(private, new))
            rows.append({"path": path, "change": change, "added_lines": added, "removed_lines": removed})
        return rows

    def list_turns(self, session_id: str) -> list[dict[str, Any]]:
        sid = validate_private_identifier(session_id, field="session_id")
        active_writers = self._active_writer_details(sid)
        manifests = self._iter_manifests(sid)
        history_incomplete = any(
            row.get("manifest_scan_truncated")
            or row.get("manifest_scan_error")
            or row.get("manifest_unreadable")
            for row in manifests
        )
        latest = None if history_incomplete else self._latest_active_manifest(sid)
        latest_turn_id = str(latest.get("turn_id", "")) if isinstance(latest, Mapping) else ""
        superseded_document_paths = self._superseded_document_paths(sid)
        rows: list[dict[str, Any]] = []
        for manifest in reversed(manifests):
            if manifest.get("manifest_scan_truncated") or manifest.get("manifest_scan_error"):
                # The sentinel is an internal fail-closed signal, not a user
                # turn row.  Hiding it avoids exposing a synthetic turn id in
                # the history panel while rewind/latest checks still reject
                # the incomplete scan.
                continue
            unreadable = bool(manifest.get("manifest_unreadable"))
            private = None if unreadable else self._private_for_manifest(manifest)
            files = [] if unreadable else manifest.get("files")
            if not isinstance(files, list):
                files = self._file_changes(manifest, private) if manifest.get("after_files") and private is not None else []
            files = self._project_superseded_rows(files, superseded_document_paths)
            files = self._filter_managed_memory_rows(manifest, files)
            deliverables = [] if unreadable else manifest.get("deliverables")
            deliverables = self._project_superseded_rows(
                deliverables,
                superseded_document_paths,
            )
            deliverables = self._filter_managed_memory_rows(manifest, deliverables)
            status = str(manifest.get("status", "legacy") or "legacy")
            snapshots_valid = (
                not unreadable
                and self._manifest_snapshot_shapes_valid(manifest)
                and self._git_identities_are_reliable(manifest)
            )
            can_undo = (
                snapshots_valid
                and status in {"completed", "failed", "interrupted"}
                and isinstance(manifest.get("before_files"), Mapping)
                and bool(manifest.get("chat_before"))
                and bool(manifest.get("agent_before"))
                and bool(manifest.get("checkpoint_complete", not manifest.get("skipped_paths")))
                # The public contract exposes one undo action for the latest
                # actual turn only.  Older checkpoints remain in the audit
                # history but are deliberately unavailable for direct rewind.
                and str(manifest.get("turn_id", "")) == latest_turn_id
            )
            if active_writers or history_incomplete:
                can_undo = False
            reason = str(manifest.get("reason", "") or "")
            if not can_undo and not reason:
                reason = str(manifest.get("incomplete_reason", "") or "")
            if not snapshots_valid and not reason:
                reason = "cannot undo: checkpoint metadata is unavailable"
            if active_writers:
                writer_hint = ", ".join(
                    item["job_id"] or item["reason"]
                    for item in active_writers[:5]
                )
                active_reason = f"cannot undo while an owned background writer is active ({writer_hint})"
                reason = f"{reason}; {active_reason}" if reason else active_reason
            elif history_incomplete and not reason:
                reason = "cannot undo while checkpoint history is incomplete"
            rows.append(
                {
                    "turn_id": str(manifest.get("turn_id", "")),
                    "status": status,
                    "created_at": float(manifest.get("created_at", 0.0) or 0.0),
                    "can_undo": can_undo,
                    "reason": reason,
                    "files": files,
                    "artifacts": deliverables,
                    "client_turn_id": str(manifest.get("client_turn_id", "") or ""),
                }
            )
        return rows

    def _latest_active_manifest(self, session_id: str) -> dict[str, Any] | None:
        rows = self._iter_manifests(session_id)
        if any(
            row.get("manifest_scan_truncated")
            or row.get("manifest_scan_error")
            or row.get("manifest_unreadable")
            for row in rows
        ):
            return None
        # A successful undo is a durable barrier.  Older rows stay available
        # for audit/history, while they can no longer become the next undo
        # target.  A later fresh turn starts a new one-turn undo window.
        last_rewound = -1
        for index, row in enumerate(rows):
            if str(row.get("status", "") or "").strip().lower() == "rewound":
                last_rewound = index
        if last_rewound >= 0:
            rows = rows[last_rewound + 1 :]
        rows = [row for row in rows if row.get("status") not in {"rewound", "aborted"}]
        return rows[-1] if rows else None

    def _check_current_state(self, manifest: Mapping[str, Any]) -> list[str]:
        conflicts: list[str] = []
        private = self._private_for_manifest(manifest)
        after = manifest.get("after_files") if isinstance(manifest.get("after_files"), dict) else {}
        for path, expected in after.items():
            if not isinstance(expected, Mapping):
                continue
            self._validate_manifest_path(manifest, str(path), private=private)
            current = self._current_state(
                Path(str(path)),
                max_file_bytes=self.max_file_bytes,
            )
            if not self._state_matches(current, expected):
                conflicts.append(str(path))
        skipped_after = manifest.get("skipped_after")
        if isinstance(skipped_after, Mapping):
            observation_budget = _ObservationBudget(
                max_count=DEFAULT_MAX_SKIPPED_OBSERVATIONS,
                max_bytes=DEFAULT_MAX_SKIPPED_OBSERVATION_BYTES,
                deadline=time.monotonic() + DEFAULT_MAX_SKIPPED_OBSERVATION_SECONDS,
            )
            for raw_path, expected in skipped_after.items():
                self._validate_manifest_path(manifest, str(raw_path), private=private)
                if not isinstance(expected, Mapping):
                    conflicts.append(str(raw_path))
                    continue
                if not observation_budget.reserve():
                    conflicts.append(str(raw_path))
                    continue
                current = self._observe_state(
                    Path(str(raw_path)),
                    observation_budget=observation_budget,
                )
                match = self._observation_matches(expected, current)
                if match is not True:
                    conflicts.append(str(raw_path))
        before_git = manifest.get("git_after")
        if isinstance(before_git, list):
            for row in before_git:
                if not isinstance(row, Mapping):
                    conflicts.append("git:unknown")
                    continue
                root = str(row.get("root", "") or "")
                if not root:
                    conflicts.append("git:unknown")
                    continue
                if not self._git_identity_is_reliable(row):
                    conflicts.append(f"git:{root}")
                    continue
                current = self._git_identity(Path(root))
                if not self._git_identity_is_reliable(current):
                    conflicts.append(f"git:{root}")
                    continue
                if current.get("head") != str(row.get("head", "") or "") or current.get("index") != str(row.get("index", "") or ""):
                    conflicts.append(f"git:{root}")
        return conflicts

    def _backup_for_rollback(
        self,
        manifest: Mapping[str, Any],
        paths: Iterable[str],
    ) -> dict[str, dict[str, Any]]:
        backup_root = self._private_for_manifest(manifest).checkpoint / "rewind-backup" / uuid.uuid4().hex
        backup_root.mkdir(parents=True, exist_ok=True)
        out: dict[str, dict[str, Any]] = {}
        total_bytes = 0
        for raw_path in paths:
            path = Path(raw_path)
            state = self._current_state(path, max_file_bytes=self.max_file_bytes)
            record = dict(state)
            if state.get("exists") and state.get("kind") == "file":
                size = int(state.get("size", 0) or 0)
                if bool(state.get("too_large")) or size > self.max_file_bytes:
                    raise TurnConflictError(
                        f"cannot safely rewind oversized file: {path}",
                        conflict_paths=[str(path)],
                    )
                if total_bytes + size > self.max_total_bytes:
                    raise TurnConflictError(
                        "cannot safely rewind: rollback backup exceeds size limit",
                        conflict_paths=[str(path)],
                    )
                try:
                    first = path.stat()
                    data = path.read_bytes()
                    last = path.stat()
                    if (
                        self._has_symlink_component(path)
                        or path.is_symlink()
                        or
                        len(data) != int(first.st_size)
                        or int(last.st_size) != int(first.st_size)
                        or int(getattr(last, "st_ino", 0))
                        != int(getattr(first, "st_ino", 0))
                        or int(getattr(last, "st_mtime_ns", 0))
                        != int(getattr(first, "st_mtime_ns", 0))
                    ):
                        raise TurnConflictError(
                            f"file changed while preparing rewind backup: {path}",
                            conflict_paths=[str(path)],
                        )
                    if len(data) > self.max_file_bytes or total_bytes + len(data) > self.max_total_bytes:
                        raise TurnConflictError(
                            f"file changed beyond rollback limit while backing up: {path}",
                            conflict_paths=[str(path)],
                        )
                    backup_path = backup_root / (hashlib.sha256(raw_path.encode()).hexdigest() + ".bin")
                    _atomic_write_bytes(backup_path, data, mode=int(state.get("mode") or 0o600))
                    record["snapshot"] = str(backup_path)
                    total_bytes += len(data)
                except OSError:
                    record["kind"] = "error"
            out[raw_path] = record
        return out

    @staticmethod
    def _restore_path(path: Path, record: Mapping[str, Any], *, private: PrivateWorkspace | None = None) -> None:
        if not isinstance(record, Mapping) or "exists" not in record or not isinstance(
            record.get("exists"), bool
        ):
            raise TurnCheckpointMissing(f"malformed snapshot record: {path}")
        if TurnLifecycleStore._has_symlink_component(path):
            raise TurnConflictError(
                f"cannot rewind through symlink path: {path}",
                conflict_paths=[str(path)],
            )
        if not bool(record.get("exists")):
            if record.get("kind") not in (None, "file"):
                raise TurnCheckpointMissing(f"malformed snapshot record: {path}")
            if path.exists() or path.is_symlink():
                if path.is_dir() and not path.is_symlink():
                    raise TurnConflictError(f"cannot remove directory during rewind: {path}", conflict_paths=[str(path)])
                path.unlink()
            return
        if record.get("kind") != "file":
            raise TurnConflictError(f"unsupported checkpoint path: {path}", conflict_paths=[str(path)])
        relative = record.get("snapshot")
        if not isinstance(relative, str) or not relative:
            raise TurnCheckpointMissing(f"snapshot bytes missing: {path}")
        source = Path(str(relative))
        if private is not None and not source.is_absolute():
            source = private.path(str(relative))
        mode = record.get("mode")
        if not isinstance(mode, int) or isinstance(mode, bool):
            raise TurnCheckpointMissing(f"malformed snapshot mode: {path}")
        data = source.read_bytes()
        _atomic_write_bytes(path, data, mode=mode)

    @staticmethod
    def _clear_rewound_execution_cache(session: Any) -> None:
        """Drop volatile subagent/turn state that must not survive an undo."""

        scratchpad = getattr(session, "scratchpad", None)
        if isinstance(scratchpad, dict):
            for key in list(scratchpad):
                name = str(key)
                if (
                    name in {"__pending_subagent_summaries__", "__last_turn_failure__"}
                    or name.startswith("subagent_result::")
                    or name.startswith("delegation_result::")
                ):
                    scratchpad.pop(key, None)
        # Runtime event summaries are volatile prompt input.  The durable
        # chat/agent snapshots above are the source of truth after rewind.
        if hasattr(session, "last_agent_events"):
            session.last_agent_events = []

        # Finished subagent contexts are an in-memory status cache.  Remove
        # only terminal entries whose task is no longer running; an active
        # task is left intact so undo cannot become a cancellation primitive.
        team_manager = getattr(session, "_team_manager", None)
        if team_manager is None:
            return
        terminal = {"completed", "failed", "cancelled", "paused"}
        active_ids = set()
        tasks = getattr(team_manager, "_tasks", {})
        for mapping_name in ("_agents", "_archived_agents"):
            mapping = getattr(team_manager, mapping_name, None)
            if not isinstance(mapping, dict):
                continue
            for agent_id, context in list(mapping.items()):
                status = getattr(getattr(context, "status", None), "value", None)
                task = tasks.get(agent_id) if isinstance(tasks, dict) else None
                if status not in terminal or (task is not None and not task.done()):
                    active_ids.add(agent_id)
                    continue
                mapping.pop(agent_id, None)
        agent_sessions = getattr(team_manager, "_agent_sessions", None)
        if isinstance(agent_sessions, dict):
            active_agents = getattr(team_manager, "_agents", {})
            for agent_id in list(agent_sessions):
                if agent_id not in active_ids and agent_id not in active_agents:
                    agent_sessions.pop(agent_id, None)

    def _apply_chat_snapshot(self, manifest: Mapping[str, Any], session: Any) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        private = self._private_for_manifest(manifest)
        chat_rows = self._load_rows(private, str(manifest.get("chat_before", "") or ""))
        agent_rows = self._load_rows(private, str(manifest.get("agent_before", "") or ""))
        if chat_rows is None or agent_rows is None:
            raise TurnCheckpointMissing("chat checkpoint is missing or unreadable")
        session.chat_history = chat_rows
        session.agent_messages = agent_rows
        artifacts: dict[Path, str] = {}
        for row in manifest.get("artifacts_before", []) if isinstance(manifest.get("artifacts_before"), list) else []:
            if not isinstance(row, Mapping):
                continue
            path = str(row.get("path", "") or "").strip()
            if not path:
                continue
            artifacts[Path(path)] = str(row.get("content", "") or "")
        if hasattr(session, "artifacts"):
            session.artifacts = artifacts
        # Publication rows from the rewound turn describe files that have just
        # been removed/restored.  Drop that volatile registry so a subsequent
        # turn cannot treat the rewound revision as a live replacement source;
        # durable manifests for earlier active turns remain available through
        # ``_document_lineage_rows``.
        if hasattr(session, "_document_lineage"):
            session._document_lineage = {}
        self._clear_rewound_execution_cache(session)
        return chat_rows, agent_rows

    def rewind(
        self,
        session_id: str,
        turn_id: str,
        *,
        session: Any | None = None,
        persist: Callable[[], bool] | None = None,
    ) -> dict[str, Any]:
        """Synchronously rewind a turn and persist via a synchronous callback."""

        return self._rewind_apply(session_id, turn_id, session=session, persist=persist)

    async def rewind_async(
        self,
        session_id: str,
        turn_id: str,
        *,
        session: Any | None = None,
        persist_async: Callable[[], Awaitable[bool]] | None = None,
    ) -> dict[str, Any]:
        """Rewind files/chat, await persistence, and compensate on failure."""

        sid = validate_private_identifier(session_id, field="session_id")
        tid = validate_private_identifier(turn_id, field="turn_id")
        # A rewind crosses an await while files and session state are at the
        # target boundary.  Use a unique owner for the existing process-wide
        # workspace lease so every other begin (including another store
        # instance, a parent/child root, or the same session) is rejected until
        # persistence and any compensation have both finished.  Do not hold
        # the thread RLock across the await: the lease is the async exclusion.
        lease_owner = f"rewind:{sid}:{tid}:{uuid.uuid4().hex}"
        lease_keys: tuple[str, ...] = ()

        active_writers = self._active_writer_details(sid)
        if active_writers:
            writer_hint = ", ".join(
                item["job_id"] or item["reason"]
                for item in active_writers[:5]
            )
            raise TurnAlreadyRunning(
                f"cannot rewind while an owned background writer is active ({writer_hint})"
            )

        def _note_compensation_failure(
            original: BaseException,
            phase: str,
            failure: BaseException,
        ) -> None:
            detail = f"rewind compensation failed ({phase}): {failure}"
            _log.warning(
                detail,
                exc_info=(type(failure), failure, failure.__traceback__),
            )
            add_note = getattr(original, "add_note", None)
            if callable(add_note):
                try:
                    add_note(detail)
                except Exception:
                    pass
            try:
                notes = getattr(original, "_agx_compensation_failures", None)
                if not isinstance(notes, list):
                    notes = []
                    setattr(original, "_agx_compensation_failures", notes)
                notes.append(detail)
            except Exception:
                pass

        try:
            with self._session_guard:
                target = self._read_manifest(sid, tid)
                if target is None:
                    raise TurnCheckpointMissing(f"turn checkpoint not found: {tid}")
                if target.get("manifest_unreadable"):
                    raise TurnCheckpointMissing(
                        str(target.get("incomplete_reason") or "turn checkpoint manifest is unavailable")
                    )
                latest = self._latest_active_manifest(sid)
                if latest is None or "before_files" not in target or not target.get("chat_before"):
                    raise TurnCheckpointMissing(f"turn checkpoint is incomplete: {tid}")
                if str(latest.get("turn_id", "") or "") != tid:
                    raise TurnCheckpointMissing(
                        "only the most recent completed turn can be undone"
                    )
                manifests = self._iter_manifests(sid)
                try:
                    target_index = next(i for i, row in enumerate(manifests) if str(row.get("turn_id")) == tid)
                except StopIteration as exc:
                    raise TurnCheckpointMissing(f"turn checkpoint not found: {tid}") from exc
                if str(target.get("status", "") or "").strip().lower() in {"rewound", "aborted", "running"}:
                    raise TurnCheckpointMissing(f"turn checkpoint is not undoable: {tid}")
                active_range = [
                    row
                    for row in manifests[target_index:]
                    if str(row.get("status", "") or "").strip().lower() not in {"rewound", "aborted"}
                ]
                if any(str(row.get("status", "") or "").strip().lower() == "running" for row in active_range):
                    raise TurnAlreadyRunning("cannot rewind while a turn checkpoint is still running")
                if any(
                    isinstance(row.get("unavailable_paths"), list)
                    and any(str(item).strip() for item in row.get("unavailable_paths", []))
                    for row in active_range
                ):
                    raise TurnCheckpointMissing(
                        "turn checkpoint is incomplete: explicit artifact before state was unavailable"
                    )

                # Re-validate the trusted metadata root from disk before using
                # it as a mutation root.  A manifest is durable input and may
                # be stale or tampered with after finalize; accepting an
                # arbitrary ``internal_history_roots`` value here would turn
                # the rollback path into an external-file writer.
                validated_internal_roots: dict[str, list[Path]] = {}
                for row in active_range:
                    raw_internal = row.get("internal_history_roots")
                    if raw_internal is None:
                        validated_internal_roots[str(row.get("turn_id", ""))] = []
                        continue
                    if not isinstance(raw_internal, list):
                        raise TurnCheckpointMissing("internal history root metadata is invalid")
                    validated_internal_roots[str(row.get("turn_id", ""))] = (
                        self._validated_internal_history_roots(sid, [str(value) for value in raw_internal])
                    )

                mutation_roots = [
                    str(root)
                    for row in active_range
                    for root in (
                        [
                            *(row.get("covered_roots", []) if isinstance(row.get("covered_roots"), list) else []),
                            *[
                                str(value)
                                for value in validated_internal_roots.get(str(row.get("turn_id", "")), [])
                            ],
                        ]
                    )
                    if str(root).strip()
                ]
                if not mutation_roots:
                    mutation_roots = [str(root) for root in self._roots_from_session(session)]
                # Acquire before checking current state so a new writer cannot
                # change the workspace between the conflict check and restore.
                lease_keys = self._acquire_workspace_locks(
                    mutation_roots,
                    lease_owner,
                    session_id=sid,
                    reserve_session=True,
                )

                # A writer may have registered between the initial admission
                # check and acquiring this transaction lease.  Re-check the
                # process-wide registry while the lease is held, before any
                # file or chat mutation.  Once this point succeeds, the
                # reservation gate above prevents a later managed writer from
                # starting until the transaction's finally block releases it.
                active_writers_after_lease = self._active_writer_details(sid)
                if active_writers_after_lease:
                    writer_hint = ", ".join(
                        item["job_id"] or item["reason"]
                        for item in active_writers_after_lease[:5]
                    )
                    raise TurnAlreadyRunning(
                        "cannot rewind while an owned background writer is active "
                        f"({writer_hint})"
                    )

                # Validate every manifest path while the rewind lease is held.
                # This covers newly-created artifact/child-pending paths as
                # well as ordinary before/after rows, so a forged or stale
                # external path can never reach the deletion branch below.
                for row in active_range:
                    row_private = self._private_for_manifest(row)
                    for field in ("before_files", "after_files"):
                        values = row.get(field)
                        if isinstance(values, Mapping):
                            for raw_path in values:
                                self._validate_manifest_path(
                                    row,
                                    str(raw_path),
                                    private=row_private,
                                )
                    for field in ("skipped_before", "skipped_after"):
                        values = row.get(field)
                        if isinstance(values, Mapping):
                            for raw_path in values:
                                self._validate_manifest_path(
                                    row,
                                    str(raw_path),
                                    private=row_private,
                                )

                # Every persisted before/after record is validated before
                # building a restore plan.  A present path with malformed
                # metadata must never fall through to ``exists=False`` and
                # delete the live file; only a path absent from before_files
                # is the intentional new-file deletion case.
                self._preflight_snapshot_records(active_range)
                if any(
                    not self._git_identities_are_reliable(row)
                    for row in active_range
                ):
                    raise TurnCheckpointMissing(
                        "turn checkpoint is incomplete: Git identity is unknown"
                    )

                conflicts = self._check_current_state(latest)
                if conflicts:
                    raise TurnConflictError(
                        "workspace changed after the latest recorded turn",
                        conflict_paths=conflicts,
                    )

                skipped_changed_all: set[str] = set()
                skipped_unknown_all: set[str] = set()
                for row in active_range:
                    row_changed, row_unknown = self._skipped_observation_status(row)
                    skipped_changed_all.update(row_changed)
                    skipped_unknown_all.update(row_unknown)
                if skipped_changed_all:
                    raise TurnConflictError(
                        "skipped workspace paths changed without rollback snapshots",
                        conflict_paths=sorted(skipped_changed_all),
                    )
                if skipped_unknown_all:
                    raise TurnCheckpointMissing(
                        "turn checkpoint is incomplete: skipped workspace paths were not reliably observed"
                    )

                # Build a per-file rollback plan from paths that a turn
                # actually changed. A covered-but-unchanged file is context
                # for conflict detection, never a reason to restore an older
                # byte snapshot.
                restore_plan: dict[str, tuple[dict[str, Any], PrivateWorkspace]] = {}
                previous_after: dict[str, Mapping[str, Any]] = {}
                continuity_conflicts: set[str] = set()
                for row in active_range:
                    before_rows = row.get("before_files") if isinstance(row.get("before_files"), Mapping) else {}
                    after_rows = row.get("after_files") if isinstance(row.get("after_files"), Mapping) else {}
                    changed = self._changed_snapshot_paths(row)
                    row_private = self._private_for_manifest(row)
                    row_skipped_before = row.get("skipped_before")
                    skipped_before_paths = (
                        {str(path) for path in row_skipped_before}
                        if isinstance(row_skipped_before, Mapping)
                        else set()
                    )
                    for raw_path in changed:
                        # The row has no before bytes for this path. Its
                        # observation was checked above; if it is unchanged,
                        # the path must remain untouched, and if it changed
                        # rewind was rejected before this plan was built.
                        if str(raw_path) in skipped_before_paths:
                            continue
                        if raw_path in before_rows:
                            before_record = before_rows[raw_path]
                            if not isinstance(before_record, Mapping):
                                # Defensive redundancy: the complete
                                # preflight above should already reject this
                                # before any restore-side effect.
                                raise TurnCheckpointMissing(
                                    f"turn checkpoint before_files record is malformed: {raw_path}"
                                )
                        else:
                            # A path absent from before_files is the only
                            # intentional missing-before sentinel: this turn
                            # created a new output and rewind may remove it.
                            before_record = {
                                "path": raw_path,
                                "kind": "file",
                                "exists": False,
                                "size": 0,
                                "sha256": "",
                                "mode": None,
                                "snapshot": None,
                            }
                        if raw_path in previous_after and not self._snapshot_records_match(
                            previous_after[raw_path], before_record
                        ):
                            # The file changed outside the recorded turn
                            # chain between two turns. Refuse to guess which
                            # bytes the user intended to keep.
                            continuity_conflicts.add(raw_path)
                        if raw_path not in restore_plan:
                            restore_plan[raw_path] = (
                                dict(before_record),
                                row_private,
                            )
                    # Keep the latest recorded state for continuity checks
                    # even on a turn that did not change a path. This lets us
                    # preserve an unrelated user edit while still detecting
                    # an edit to a file that a later turn tries to overwrite.
                    for raw_path in set(before_rows) | set(after_rows):
                        previous_after[str(raw_path)] = (
                            after_rows.get(raw_path)
                            if isinstance(after_rows.get(raw_path), Mapping)
                            else {"exists": False}
                        )
                if continuity_conflicts:
                    raise TurnConflictError(
                        "workspace changed between recorded turns",
                        conflict_paths=sorted(continuity_conflicts),
                    )

                affected = set(restore_plan)
                backup = self._backup_for_rollback(target, affected)
                old_chat = copy.deepcopy(getattr(session, "chat_history", None)) if session is not None else None
                old_agent = copy.deepcopy(getattr(session, "agent_messages", None)) if session is not None else None
                old_artifacts = copy.deepcopy(getattr(session, "artifacts", None)) if session is not None else None
                old_document_lineage = (
                    copy.deepcopy(getattr(session, "_document_lineage", None))
                    if session is not None
                    else None
                )
                old_scratchpad = copy.deepcopy(getattr(session, "scratchpad", None)) if session is not None else None
                old_last_agent_events = copy.deepcopy(getattr(session, "last_agent_events", None)) if session is not None else None
                team_manager = getattr(session, "_team_manager", None) if session is not None else None
                old_team_agents = dict(getattr(team_manager, "_agents", {}) or {}) if team_manager is not None else None
                old_team_archived = dict(getattr(team_manager, "_archived_agents", {}) or {}) if team_manager is not None else None
                old_team_sessions = dict(getattr(team_manager, "_agent_sessions", {}) or {}) if team_manager is not None else None
                old_manifests = [
                    copy.deepcopy(row)
                    for row in active_range
                    if str(row.get("turn_id", "")).strip()
                ]
                private = self._private_for_manifest(target)

            # The lease remains held after the session guard is released, so
            # same-loop and cross-store writers cannot enter during await.
            try:
                for path in sorted(affected):
                    record, source_private = restore_plan[path]
                    self._restore_path(Path(path), record, private=source_private)
                if session is not None:
                    self._apply_chat_snapshot(target, session)
                if persist_async is not None:
                    persisted = await persist_async()
                    if persisted is False:
                        raise TurnLifecycleError("session persistence failed during rewind")

                # Commit each manifest from a fresh copy. If a later write
                # fails, the original rows below can restore every row that
                # was already written as ``rewound``.
                for row in active_range:
                    committed = copy.deepcopy(row)
                    committed["status"] = "rewound"
                    committed["reason"] = f"rewound to before turn {tid}"
                    committed["updated_at"] = time.time()
                    self._write_manifest(committed)
                    if committed.get("manifest_unreadable"):
                        raise TurnCheckpointMissing(
                            "turn checkpoint manifest exceeded the safe metadata limit"
                        )
                    self._release_manifest_locks(committed)
                messages = _safe_copy_rows(getattr(session, "chat_history", None)) if session is not None else []
                artifacts = list(target.get("artifacts_before") or []) if isinstance(target.get("artifacts_before"), list) else []
                return {"ok": True, "turn_id": tid, "messages": messages, "artifacts": artifacts}
            except BaseException as original_error:
                # A failed persist or partial manifest commit is a logical
                # transaction failure. Restore every changed surface while
                # retaining the original error for the caller.
                for path, record in backup.items():
                    try:
                        self._restore_path(Path(path), record)
                    except BaseException as compensation_exc:
                        _note_compensation_failure(original_error, f"file {path}", compensation_exc)

                if session is not None:
                    try:
                        session.chat_history = old_chat
                        session.agent_messages = old_agent
                        if hasattr(session, "artifacts"):
                            session.artifacts = old_artifacts
                        if hasattr(session, "_document_lineage"):
                            session._document_lineage = old_document_lineage
                        if hasattr(session, "scratchpad"):
                            session.scratchpad = old_scratchpad
                        if hasattr(session, "last_agent_events"):
                            session.last_agent_events = old_last_agent_events
                    except BaseException as compensation_exc:
                        _note_compensation_failure(original_error, "in-memory session", compensation_exc)
                if team_manager is not None:
                    try:
                        if isinstance(old_team_agents, dict):
                            team_manager._agents = old_team_agents
                        if isinstance(old_team_archived, dict):
                            team_manager._archived_agents = old_team_archived
                        if isinstance(old_team_sessions, dict):
                            team_manager._agent_sessions = old_team_sessions
                    except BaseException as compensation_exc:
                        _note_compensation_failure(original_error, "in-memory team state", compensation_exc)

                # Restore all manifests, including ones successfully written
                # before the injected failure. This keeps the durable journal
                # retryable after a recoverable commit error.
                for old_manifest in old_manifests:
                    try:
                        self._write_manifest(old_manifest)
                    except BaseException as compensation_exc:
                        _note_compensation_failure(
                            original_error,
                            f"manifest {old_manifest.get('turn_id', '')}",
                            compensation_exc,
                        )

                # The first persistence call may already have written the
                # rewound chat. Persist the restored in-memory chat again so
                # durable state matches the compensated manifests and files.
                if persist_async is not None:
                    try:
                        persisted = await persist_async()
                        if persisted is False:
                            _note_compensation_failure(
                                original_error,
                                "durable chat returned false",
                                TurnLifecycleError("session persistence compensation returned false"),
                            )
                    except BaseException as compensation_exc:
                        _note_compensation_failure(original_error, "durable chat", compensation_exc)
                raise
        finally:
            if lease_keys:
                self._release_workspace_locks(lease_keys, lease_owner, session_id=sid)

    def _rewind_apply(
        self,
        session_id: str,
        turn_id: str,
        *,
        session: Any | None,
        persist: Callable[[], bool] | None,
    ) -> dict[str, Any]:
        """Synchronous counterpart used by small CLI/test integrations."""

        async def run() -> dict[str, Any]:
            async def persist_async() -> bool:
                return True if persist is None else bool(persist())

            return await self.rewind_async(
                session_id,
                turn_id,
                session=session,
                persist_async=persist_async,
            )

        try:
            asyncio.get_running_loop()
        except RuntimeError:
            return asyncio.run(run())
        # This path is only for callers already inside an event loop.  Run the
        # blocking transaction in a worker thread with no event-loop affinity.
        result: list[dict[str, Any]] = []
        error: list[BaseException] = []

        def worker() -> None:
            try:
                result.append(asyncio.run(run()))
            except BaseException as exc:  # pragma: no cover - defensive bridge
                error.append(exc)

        thread = threading.Thread(target=worker, name="agx-turn-rewind", daemon=True)
        thread.start()
        thread.join()
        if error:
            raise error[0]
        return result[0]


# Friendly aliases for callers and integrations that use the plan's shorter
# terminology.
TurnStore = TurnLifecycleStore
TurnLifecycle = TurnLifecycleStore


__all__ = [
    "TurnAlreadyRunning",
    "TurnCheckpointMissing",
    "TurnConflictError",
    "TurnHandle",
    "TurnLifecycle",
    "TurnLifecycleError",
    "TurnLifecycleStore",
    "TurnStore",
]
