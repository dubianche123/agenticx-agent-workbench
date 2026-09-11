#!/usr/bin/env python3
"""Persistence for GraphRun snapshots under $AGX_HOME/graph_runs.

Author: Damon Li
"""

from __future__ import annotations

import contextlib
import json
import logging
import os
import tempfile
import threading
import time
from pathlib import Path
from typing import List, Optional

if os.name == "nt":
    import msvcrt
else:
    import fcntl

from agenticx.runtime.graph.models import GraphRun
from agenticx.utils.agx_home import agx_home

_log = logging.getLogger(__name__)
_STORE_LOCKS_GUARD = threading.Lock()
_STORE_LOCKS: dict[str, threading.RLock] = {}


class GraphRunVersionConflict(RuntimeError):
    """Raised when a caller tries to persist an outdated GraphRun snapshot."""

    def __init__(self, run_id: str, *, expected: int, actual: int) -> None:
        super().__init__(
            f"graph run {run_id!r} version conflict: expected {expected}, actual {actual}"
        )
        self.run_id = run_id
        self.expected = expected
        self.actual = actual


def _store_lock(path: Path) -> threading.RLock:
    key = str(path.resolve())
    with _STORE_LOCKS_GUARD:
        return _STORE_LOCKS.setdefault(key, threading.RLock())


@contextlib.contextmanager
def _interprocess_lock(path: Path):
    """Hold a lock file while checking and replacing one run snapshot.

    The lock lives beside ``run.json`` so replacing the snapshot cannot
    replace the lock itself.  ``flock`` is used on POSIX platforms and the
    standard-library ``msvcrt`` byte-range lock is used on Windows.
    """

    lock_path = path.with_name(".run.lock")
    with lock_path.open("a+b") as lock_file:
        lock_file.seek(0, os.SEEK_END)
        if lock_file.tell() == 0:
            lock_file.write(b"\0")
            lock_file.flush()
        lock_file.seek(0)
        if os.name == "nt":
            # ``LK_LOCK`` retries only a bounded number of times on some
            # Windows runtimes.  Poll the non-blocking mode instead so a
            # slow writer cannot spuriously fail a valid CAS operation.
            while True:
                try:
                    msvcrt.locking(lock_file.fileno(), msvcrt.LK_NBLCK, 1)
                    break
                except OSError:
                    time.sleep(0.01)
        else:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            lock_file.seek(0)
            if os.name == "nt":
                with contextlib.suppress(OSError):
                    msvcrt.locking(lock_file.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)


def default_graph_runs_root() -> Path:
    override = str(os.environ.get("AGX_GRAPH_RUNS_ROOT") or "").strip()
    if override:
        return Path(override).expanduser()
    return agx_home() / "graph_runs"


class GraphRunStore:
    """Atomic JSON persistence for WorkGraph runs."""

    def __init__(self, root: Optional[Path] = None) -> None:
        self.root = Path(root) if root is not None else default_graph_runs_root()
        self.root.mkdir(parents=True, exist_ok=True)

    def _run_dir(self, run_id: str) -> Path:
        safe = str(run_id).strip().replace("/", "_").replace("..", "_")
        return self.root / safe

    def _run_path(self, run_id: str) -> Path:
        return self._run_dir(run_id) / "run.json"

    def save(
        self,
        run: GraphRun,
        *,
        bump_version: bool = True,
        expected_version: Optional[int] = None,
    ) -> GraphRun:
        path = self._run_path(run.run_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        with _store_lock(path):
            with _interprocess_lock(path):
                actual_version = 0
                if path.is_file():
                    try:
                        current = json.loads(path.read_text(encoding="utf-8"))
                        actual_version = int(current.get("version") or 0)
                    except (OSError, ValueError, TypeError, json.JSONDecodeError):
                        actual_version = 0
                if (
                    expected_version is not None
                    and int(expected_version) != actual_version
                ):
                    raise GraphRunVersionConflict(
                        run.run_id,
                        expected=int(expected_version),
                        actual=actual_version,
                    )
                if bump_version:
                    run.version = max(int(run.version or 0), actual_version) + 1
                payload = json.dumps(run.to_dict(), ensure_ascii=False, indent=2)
                fd, tmp_name = tempfile.mkstemp(
                    prefix=".run.",
                    suffix=".json",
                    dir=str(path.parent),
                )
                try:
                    with os.fdopen(fd, "w", encoding="utf-8") as fh:
                        fh.write(payload)
                        fh.flush()
                        os.fsync(fh.fileno())
                    os.replace(tmp_name, path)
                except Exception:
                    try:
                        os.unlink(tmp_name)
                    except OSError:
                        pass
                    raise
        return run

    def load(self, run_id: str) -> Optional[GraphRun]:
        path = self._run_path(run_id)
        if not path.is_file():
            return None
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            _log.warning("Failed to load graph run %s: %s", run_id, exc)
            return None
        if not isinstance(raw, dict):
            return None
        return GraphRun.from_dict(raw)

    def list_by_session(self, session_id: str) -> List[GraphRun]:
        sid = str(session_id or "").strip()
        if not sid or not self.root.is_dir():
            return []
        found: List[GraphRun] = []
        for child in sorted(self.root.iterdir()):
            if not child.is_dir():
                continue
            path = child / "run.json"
            if not path.is_file():
                continue
            run = self.load(child.name)
            if run is not None and run.session_id == sid:
                found.append(run)
        found.sort(key=lambda r: r.version, reverse=True)
        return found

    def list_by_group_id(self, group_id: str) -> List[GraphRun]:
        """List runs for a group, including legacy mis-bound session_id==group_id."""
        gid = str(group_id or "").strip()
        if not gid or not self.root.is_dir():
            return []
        found: List[GraphRun] = []
        for child in sorted(self.root.iterdir()):
            if not child.is_dir():
                continue
            path = child / "run.json"
            if not path.is_file():
                continue
            run = self.load(child.name)
            if run is None:
                continue
            if str(run.group_id or "").strip() == gid or str(run.session_id or "").strip() == gid:
                found.append(run)
        found.sort(key=lambda r: r.version, reverse=True)
        return found


_default_store: Optional[GraphRunStore] = None


def get_default_store() -> GraphRunStore:
    global _default_store
    if _default_store is None:
        _default_store = GraphRunStore()
    return _default_store
