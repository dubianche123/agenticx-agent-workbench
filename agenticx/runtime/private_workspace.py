"""Private per-session workspace paths used by turn execution.

The desktop workspace is user data and must remain a clean, intentional
deliverable surface.  Runtime scratch files, process logs and checkpoint byte
snapshots therefore live below the AgenticX home directory instead.  This
module contains only path construction and validation; it deliberately does
not interpret prompt text as a path or permission grant.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from pathlib import Path

from agenticx.utils.agx_home import agx_home


_IDENTIFIER_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$")
_SYSTEM_ALIAS_TARGETS = {
    "/var": "/private/var",
    "/tmp": "/private/tmp",
}


def _lexical_absolute(path: str | os.PathLike[str] | Path) -> Path:
    """Return an absolute lexical path without following symlinks.

    ``Path.resolve`` is deliberately kept out of this helper.  Callers use it
    before resolving a private path so a replaced ``scratch``/``outputs``
    component cannot disappear into an external target first.
    """

    expanded = Path(path).expanduser()
    if not expanded.is_absolute():
        expanded = Path.cwd() / expanded
    return Path(os.path.abspath(os.fspath(expanded)))


def _ensure_no_symlink_components(path: str | os.PathLike[str] | Path) -> Path:
    """Validate every existing lexical component before any resolution.

    Missing leaves are allowed because the workspace constructors create them
    later.  An inaccessible component is rejected fail-closed instead of
    optimistically following it.
    """

    candidate = _lexical_absolute(path)
    current = Path(candidate.anchor) if candidate.anchor else Path()
    parts = candidate.parts[1:] if candidate.anchor else candidate.parts
    for part in parts:
        current = current / part
        try:
            if current.is_symlink():
                # macOS exposes /var and /tmp as stable system aliases. They
                # are outside the user-controlled private tree, so accepting
                # only their known canonical targets avoids rejecting normal
                # tempfile roots while still rejecting replaced private
                # components.
                expected = _SYSTEM_ALIAS_TARGETS.get(str(current))
                if expected and str(current.resolve(strict=False)) == expected:
                    continue
                raise ValueError(f"private path may not be a symlink: {current}")
        except OSError as exc:
            raise ValueError(f"private path cannot be inspected: {current}") from exc
    return candidate


def _validated_private_path(path: str | os.PathLike[str] | Path) -> Path:
    """Check lexical components, then resolve a private path safely."""

    lexical = _ensure_no_symlink_components(path)
    try:
        return lexical.resolve(strict=False)
    except (OSError, RuntimeError) as exc:
        raise ValueError(f"private path cannot be resolved: {lexical}") from exc


def _agenticx_root() -> Path:
    """Return the configured private AgenticX root.

    ``AGX_HOME`` is useful for packaged Desktop and tests.  The shared helper
    also gives direct CLI/runtime code and private workspace validation the
    same product root without rewriting ``HOME``.
    """
    return _validated_private_path(agx_home())


def validate_private_identifier(value: str, *, field: str = "identifier") -> str:
    """Validate a session/turn identifier and return its stripped value."""

    clean = str(value or "").strip()
    if not clean or not _IDENTIFIER_RE.fullmatch(clean):
        raise ValueError(f"invalid {field}")
    return clean


def private_sessions_root(root: str | os.PathLike[str] | None = None) -> Path:
    """Return the private sessions root, optionally under a test root."""

    if root is None:
        return _validated_private_path(_agenticx_root() / "sessions")
    return _validated_private_path(root)


def private_session_root(
    session_id: str,
    *,
    root: str | os.PathLike[str] | None = None,
) -> Path:
    sid = validate_private_identifier(session_id, field="session_id")
    base = private_sessions_root(root)
    raw_target = base / sid
    lexical_target = _ensure_no_symlink_components(raw_target)
    target = _validated_private_path(lexical_target)
    try:
        target.relative_to(_validated_private_path(base))
    except ValueError as exc:  # defensive even though the identifier is strict
        raise ValueError("session path escapes private root") from exc
    return target


@dataclass(frozen=True)
class PrivateWorkspace:
    """Paths owned by one logical turn."""

    session_id: str
    turn_id: str
    root: Path
    scratch: Path
    outputs: Path
    logs: Path
    checkpoint: Path

    @property
    def manifest_path(self) -> Path:
        return self.checkpoint / "manifest.json"

    def contains(self, path: str | os.PathLike[str]) -> bool:
        """Whether *path* is safely inside this private turn directory."""

        try:
            lexical = _ensure_no_symlink_components(path)
            candidate = _validated_private_path(lexical)
            root = _validated_private_path(self.root)
        except (OSError, RuntimeError, ValueError):
            return False
        try:
            candidate.relative_to(root)
        except ValueError:
            return False
        return True

    def path(self, relative: str | os.PathLike[str]) -> Path:
        """Resolve a relative private path and reject traversal."""

        raw = Path(relative)
        if raw.is_absolute():
            raise ValueError("private path must be relative")
        current = _validated_private_path(self.root)
        for part in raw.parts:
            current = current / part
            _ensure_no_symlink_components(current)
        candidate = _validated_private_path(current)
        if not self.contains(candidate):
            raise ValueError("private path escapes turn root")
        return candidate


def ensure_private_workspace(
    session_id: str,
    turn_id: str,
    *,
    root: str | os.PathLike[str] | None = None,
) -> PrivateWorkspace:
    """Create and return the private directories for a logical turn."""

    sid = validate_private_identifier(session_id, field="session_id")
    tid = validate_private_identifier(turn_id, field="turn_id")
    session_root = private_session_root(sid, root=root)
    base = _validated_private_path(private_sessions_root(root))
    try:
        session_root.relative_to(base)
    except ValueError as exc:
        raise ValueError("session path escapes private root") from exc

    def _mkdir_real(path: Path, anchor: Path) -> None:
        # Do not follow attacker/user supplied links anywhere below the
        # private root.  ``resolve()`` containment alone is insufficient when
        # the anchor itself is a symlink to an external directory.
        lexical_path = _ensure_no_symlink_components(path)
        if path.exists():
            if not path.is_dir():
                raise ValueError(f"private path is not a directory: {path}")
        else:
            path.mkdir(parents=False, exist_ok=True)
        # Re-check after creation to catch a concurrent replacement before the
        # caller receives a path that would later be followed by a writer.
        _ensure_no_symlink_components(lexical_path)
        resolved = _validated_private_path(lexical_path)
        try:
            resolved.relative_to(anchor)
        except ValueError as exc:
            raise ValueError(f"private path escapes private root: {path}") from exc

    _ensure_no_symlink_components(base)
    if not base.exists():
        base.mkdir(parents=True, exist_ok=True)
    if not base.is_dir():
        raise ValueError(f"private root is not a directory: {base}")
    _mkdir_real(session_root, base)
    turns_root = session_root / "turns"
    _mkdir_real(turns_root, _validated_private_path(session_root))
    turn_root = turns_root / tid
    _mkdir_real(turn_root, _validated_private_path(turns_root))
    scratch = turn_root / "scratch"
    outputs = turn_root / "outputs"
    logs = turn_root / "logs"
    checkpoint = turn_root / "checkpoint"
    for path in (scratch, outputs, logs, checkpoint):
        _mkdir_real(path, _validated_private_path(turn_root))
        try:
            path.chmod(0o700)
        except OSError:
            pass
    return PrivateWorkspace(
        session_id=sid,
        turn_id=tid,
        root=turn_root,
        scratch=scratch,
        outputs=outputs,
        logs=logs,
        checkpoint=checkpoint,
    )


def session_private_execution_root(
    session_id: str,
    turn_id: str | None = None,
    *,
    root: str | os.PathLike[str] | None = None,
) -> Path:
    """Return a private cwd for session-level work or a specific turn."""

    sid = validate_private_identifier(session_id, field="session_id")
    if turn_id:
        return ensure_private_workspace(sid, turn_id, root=root).scratch
    session_root = private_session_root(sid, root=root)
    base = _validated_private_path(private_sessions_root(root))
    target = session_root / "runtime"
    _ensure_no_symlink_components(target)
    if not target.exists():
        target.mkdir(parents=True, exist_ok=True)
    if not target.is_dir():
        raise ValueError(f"private path is not a directory: {target}")
    try:
        _validated_private_path(target).relative_to(base)
    except ValueError as exc:
        raise ValueError("private path escapes private root") from exc
    try:
        target.chmod(0o700)
    except OSError:
        pass
    return target


def private_log_path(
    session_id: str,
    turn_id: str | None,
    name: str,
    *,
    root: str | os.PathLike[str] | None = None,
) -> Path:
    """Return a validated log path for a process/tool name."""

    safe_name = re.sub(r"[^A-Za-z0-9_.-]+", "_", str(name or "process"))[:120]
    if turn_id:
        return ensure_private_workspace(session_id, turn_id, root=root).logs / f"{safe_name}.log"
    session_root = private_session_root(session_id, root=root)
    target = session_root / "logs"
    _ensure_no_symlink_components(target)
    if not target.exists():
        target.mkdir(parents=True, exist_ok=True)
    if not target.is_dir():
        raise ValueError(f"private path is not a directory: {target}")
    try:
        target.chmod(0o700)
    except OSError:
        pass
    log_path = target / f"{safe_name}.log"
    _ensure_no_symlink_components(log_path)
    return log_path


__all__ = [
    "PrivateWorkspace",
    "_ensure_no_symlink_components",
    "_validated_private_path",
    "ensure_private_workspace",
    "private_log_path",
    "private_session_root",
    "private_sessions_root",
    "session_private_execution_root",
    "validate_private_identifier",
]
