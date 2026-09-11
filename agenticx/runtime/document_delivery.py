"""Bounded document publication primitives used by Studio turns.

The document tool is intentionally a thin adapter around this module.  The
adapter knows how to ask for a confirmation and how to resolve a session's
workspace roots; this module owns the small, format-neutral transaction pieces
that make a publication auditable:

* supported document extensions and deterministic metadata;
* streaming, size-bounded hashing and copying;
* private archival of a superseded generated file;
* coalescing the current turn's explicit publication rows.

No chat/session implementation is imported here.  Keeping this module free of
the tool dispatcher avoids an import cycle and makes the filesystem contract
unit-testable with temporary workspaces.
"""

from __future__ import annotations

import hashlib
import mimetypes
import os
import stat
import tempfile
import uuid
from pathlib import Path
from typing import Any, Iterable, Mapping, MutableSequence


DOCUMENT_MAX_BYTES = 32 * 1024 * 1024
"""Maximum size of one document that may be published or archived."""


SUPPORTED_DOCUMENT_EXTENSIONS = frozenset(
    {".md", ".markdown", ".html", ".htm", ".doc", ".docx"}
)

_FORMAT_EXTENSIONS = {
    "md": frozenset({".md", ".markdown"}),
    "html": frozenset({".html", ".htm"}),
    "doc": frozenset({".doc"}),
    "docx": frozenset({".docx"}),
}

_MIME_TYPES = {
    ".md": "text/markdown",
    ".markdown": "text/markdown",
    ".html": "text/html",
    ".htm": "text/html",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
}

# macOS exposes these as aliases on some hosts.  They are the only symlink
# components that may be crossed by a private temporary path; every other
# symlink is rejected before any read or write.
_SYSTEM_ALIAS_TARGETS = {
    "/var": "/private/var",
    "/tmp": "/private/tmp",
}


class DocumentDeliveryError(ValueError):
    """A publication or archive failed its bounded safety contract."""


def document_format_for_path(path: str | os.PathLike[str] | Path) -> str | None:
    """Return the public document format for *path*, or ``None``."""

    suffix = Path(path).suffix.lower()
    for document_format, suffixes in _FORMAT_EXTENSIONS.items():
        if suffix in suffixes:
            return document_format
    return None


def document_mime_type(path: str | os.PathLike[str] | Path) -> str:
    """Return a stable MIME type for a supported document path."""

    suffix = Path(path).suffix.lower()
    return _MIME_TYPES.get(suffix) or mimetypes.guess_type(str(path))[0] or "application/octet-stream"


def is_supported_document_path(path: str | os.PathLike[str] | Path) -> bool:
    return document_format_for_path(path) is not None


def _safe_stat(path: Path) -> os.stat_result:
    try:
        if path.is_symlink():
            raise DocumentDeliveryError(f"document path may not be a symlink: {path}")
        info = path.stat()
    except OSError as exc:
        raise DocumentDeliveryError(f"cannot inspect document path: {path}") from exc
    if not stat.S_ISREG(info.st_mode):
        raise DocumentDeliveryError(f"document path is not a regular file: {path}")
    return info


def fingerprint_document(
    path: str | os.PathLike[str] | Path,
    *,
    max_bytes: int = DOCUMENT_MAX_BYTES,
) -> dict[str, Any]:
    """Hash a regular document with a fixed memory bound.

    The result carries the inode and mtime observed at both ends so callers
    can reject a manual/concurrent write that happened while the file was
    being read.
    """

    candidate = Path(path)
    if not is_supported_document_path(candidate):
        raise DocumentDeliveryError(f"unsupported document format: {candidate}")
    limit = max(1, int(max_bytes))
    first = _safe_stat(candidate)
    size = int(first.st_size)
    if size > limit:
        raise DocumentDeliveryError(
            f"document exceeds the supported size limit ({size} > {limit} bytes): {candidate}"
        )
    digest = hashlib.sha256()
    try:
        with candidate.open("rb") as handle:
            remaining = limit + 1
            while remaining > 0:
                chunk = handle.read(min(64 * 1024, remaining))
                if not chunk:
                    break
                digest.update(chunk)
                remaining -= len(chunk)
            if remaining <= 0:
                raise DocumentDeliveryError(
                    f"document exceeds the supported size limit ({limit} bytes): {candidate}"
                )
        last = _safe_stat(candidate)
    except OSError as exc:
        raise DocumentDeliveryError(f"cannot read document path: {candidate}") from exc
    stable = (
        int(last.st_size) == size
        and int(getattr(last, "st_ino", 0)) == int(getattr(first, "st_ino", 0))
        and int(getattr(last, "st_mtime_ns", 0)) == int(getattr(first, "st_mtime_ns", 0))
    )
    if not stable:
        raise DocumentDeliveryError(f"document changed while being read: {candidate}")
    return {
        "path": str(candidate),
        "size": size,
        "sha256": digest.hexdigest(),
        "mode": stat.S_IMODE(first.st_mode),
        "inode": int(getattr(first, "st_ino", 0)),
        "mtime_ns": int(getattr(first, "st_mtime_ns", 0)),
        "format": document_format_for_path(candidate),
        "mimeType": document_mime_type(candidate),
    }


def fingerprint_bytes(
    data: bytes,
    *,
    max_bytes: int = DOCUMENT_MAX_BYTES,
) -> dict[str, Any]:
    """Return bounded metadata for already-rendered bytes."""

    if not isinstance(data, bytes):
        raise DocumentDeliveryError("document bytes must be bytes")
    limit = max(1, int(max_bytes))
    if len(data) > limit:
        raise DocumentDeliveryError(
            f"document exceeds the supported size limit ({len(data)} > {limit} bytes)"
        )
    return {"size": len(data), "sha256": hashlib.sha256(data).hexdigest()}


def verify_document_fingerprint(
    path: str | os.PathLike[str] | Path,
    expected: Mapping[str, Any],
    *,
    max_bytes: int = DOCUMENT_MAX_BYTES,
) -> dict[str, Any]:
    """Fingerprint *path* and require the expected size/hash."""

    observed = fingerprint_document(path, max_bytes=max_bytes)
    if (
        int(observed.get("size", -1)) != int(expected.get("size", -2))
        or str(observed.get("sha256", "")) != str(expected.get("sha256", ""))
    ):
        raise DocumentDeliveryError(f"document fingerprint changed: {path}")
    return observed


def _absolute_path(path: str | os.PathLike[str] | Path) -> Path:
    """Return an absolute lexical path without following symlinks."""

    candidate = Path(path).expanduser()
    if not candidate.is_absolute():
        candidate = Path.cwd() / candidate
    return Path(os.path.abspath(os.fspath(candidate)))


def _validate_path_components(path: str | os.PathLike[str] | Path) -> Path:
    """Reject symlink components before a path is used for I/O.

    ``Path.resolve`` is deliberately not used here: resolving first would
    turn a malicious destination symlink into its external target and make
    the later check ineffective.  Missing components are allowed because
    callers may be creating the private archive directory.
    """

    candidate = _absolute_path(path)
    current = Path(candidate.anchor) if candidate.anchor else Path()
    parts = candidate.parts[1:] if candidate.anchor else candidate.parts
    for part in parts:
        current = current / part
        try:
            info = os.lstat(current)
        except FileNotFoundError:
            continue
        except OSError as exc:
            raise DocumentDeliveryError(f"cannot inspect document path component: {current}") from exc
        if stat.S_ISLNK(info.st_mode):
            expected = _SYSTEM_ALIAS_TARGETS.get(str(current))
            if expected and str(current.resolve(strict=False)) == expected:
                continue
            raise DocumentDeliveryError(f"document path may not contain a symlink: {current}")
    return candidate


def fsync_directory(path: str | os.PathLike[str] | Path) -> None:
    """Durably sync one directory, retaining platform errors as delivery errors."""

    directory = _validate_path_components(path)
    try:
        info = directory.stat()
    except OSError as exc:
        raise DocumentDeliveryError(f"cannot inspect document directory: {directory}") from exc
    if not stat.S_ISDIR(info.st_mode) or directory.is_symlink():
        raise DocumentDeliveryError(f"document path is not a safe directory: {directory}")
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
    try:
        fd = os.open(os.fspath(directory), flags)
    except OSError as exc:
        raise DocumentDeliveryError(f"could not open document directory for sync: {directory}") from exc
    try:
        os.fsync(fd)
    except OSError as exc:
        raise DocumentDeliveryError(f"could not fsync document directory: {directory}") from exc
    finally:
        try:
            os.close(fd)
        except OSError as exc:
            raise DocumentDeliveryError(f"could not close document directory after sync: {directory}") from exc


def _ensure_private_directory(path: Path) -> None:
    """Create and lock down a private archive directory."""

    directory = _validate_path_components(path)
    existed = directory.exists()
    try:
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        if directory.is_symlink() or not directory.is_dir():
            raise DocumentDeliveryError(f"document archive path is not a directory: {directory}")
        os.chmod(directory, 0o700)
    except DocumentDeliveryError:
        raise
    except OSError as exc:
        raise DocumentDeliveryError(f"could not create private document directory: {directory}") from exc
    if not existed:
        fsync_directory(directory.parent)
    fsync_directory(directory)


def _copy_file_bounded(
    source: Path,
    destination: Path,
    *,
    max_bytes: int,
    mode: int | None = None,
) -> dict[str, Any]:
    """Copy *source* to *destination* through a bounded temporary file."""

    source = _validate_path_components(source)
    destination = _validate_path_components(destination)
    expected = fingerprint_document(source, max_bytes=max_bytes)
    try:
        destination.parent.mkdir(parents=True, exist_ok=True)
        if destination.parent.is_symlink() or not destination.parent.is_dir():
            raise DocumentDeliveryError(f"document destination parent is not a directory: {destination.parent}")
        if destination.exists() or destination.is_symlink():
            raise DocumentDeliveryError(f"document archive destination already exists: {destination}")
        fd, temp_name = tempfile.mkstemp(
            prefix=f".{destination.name}.",
            # Keep a supported document suffix so the post-copy fingerprint uses
            # the same document validation path as the source.
            suffix=destination.suffix or ".tmp",
            dir=str(destination.parent),
        )
    except DocumentDeliveryError:
        raise
    except OSError as exc:
        raise DocumentDeliveryError(f"could not prepare document copy destination: {destination}") from exc
    temp_path = Path(temp_name)
    try:
        total = 0
        with source.open("rb") as src, os.fdopen(fd, "wb") as dst:
            while True:
                chunk = src.read(64 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                if total > max(1, int(max_bytes)):
                    raise DocumentDeliveryError(
                        f"document exceeds the supported size limit while copying: {source}"
                    )
                dst.write(chunk)
            dst.flush()
            os.fsync(dst.fileno())
        if mode is not None:
            try:
                os.chmod(temp_path, stat.S_IMODE(mode))
            except OSError as exc:
                raise DocumentDeliveryError(f"could not preserve document permissions: {destination}") from exc
        copied = fingerprint_document(temp_path, max_bytes=max_bytes)
        if (
            copied.get("size") != expected.get("size")
            or copied.get("sha256") != expected.get("sha256")
        ):
            raise DocumentDeliveryError(f"document copy verification failed: {source}")
        # A random archive path must never replace a file that appeared after
        # the initial check.  This also protects future restore callers from
        # accidentally clobbering a manual file.
        if destination.exists() or destination.is_symlink():
            raise DocumentDeliveryError(f"document archive destination changed during copy: {destination}")
        os.replace(temp_path, destination)
        fsync_directory(destination.parent)
        return expected
    except DocumentDeliveryError:
        raise
    except OSError as exc:
        raise DocumentDeliveryError(f"could not copy document to private archive: {destination}") from exc
    finally:
        try:
            temp_path.unlink()
        except FileNotFoundError:
            pass
        except OSError:
            pass


def _same_document_state(observed: Mapping[str, Any], expected: Mapping[str, Any]) -> bool:
    """Compare bytes and, when available, mode for rollback ownership."""

    if int(observed.get("size", -1)) != int(expected.get("size", -2)):
        return False
    if str(observed.get("sha256", "")) != str(expected.get("sha256", "")):
        return False
    if "mode" in expected and expected.get("mode") is not None:
        return int(observed.get("mode", -1)) == int(expected.get("mode"))
    return True


def remove_document_if_unchanged(
    path: str | os.PathLike[str] | Path,
    expected: Mapping[str, Any],
    *,
    max_bytes: int = DOCUMENT_MAX_BYTES,
) -> None:
    """Remove a file only when it still has the bytes/mode owned by a caller."""

    candidate = _validate_path_components(path)
    if not candidate.exists():
        return
    observed = fingerprint_document(candidate, max_bytes=max_bytes)
    if not _same_document_state(observed, expected):
        raise DocumentDeliveryError(f"document changed during rollback; refusing to remove: {candidate}")
    try:
        candidate.unlink()
    except OSError as exc:
        raise DocumentDeliveryError(f"could not remove generated document during rollback: {candidate}") from exc
    fsync_directory(candidate.parent)


def restore_archived_document(
    archive_path: str | os.PathLike[str] | Path,
    target_path: str | os.PathLike[str] | Path,
    expected: Mapping[str, Any],
    *,
    max_bytes: int = DOCUMENT_MAX_BYTES,
) -> dict[str, Any]:
    """Restore a private archive without overwriting a manual target change."""

    archive = _validate_path_components(archive_path)
    target = _validate_path_components(target_path)
    if archive == target:
        raise DocumentDeliveryError("a document archive cannot restore onto itself")
    archived = verify_document_fingerprint(archive, expected, max_bytes=max_bytes)
    if target.exists() or target.is_symlink():
        current = fingerprint_document(target, max_bytes=max_bytes)
        if _same_document_state(current, expected):
            return current
        raise DocumentDeliveryError(f"document changed during rollback; refusing to overwrite: {target}")
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.parent.is_symlink() or not target.parent.is_dir():
            raise DocumentDeliveryError(f"document restore parent is not a directory: {target.parent}")
    except DocumentDeliveryError:
        raise
    except OSError as exc:
        raise DocumentDeliveryError(f"could not prepare document restore target: {target}") from exc
    copied = _copy_file_bounded(
        archive,
        target,
        max_bytes=max_bytes,
        mode=expected.get("mode"),
    )
    restored = verify_document_fingerprint(target, expected, max_bytes=max_bytes)
    if expected.get("mode") is not None and int(restored.get("mode", -1)) != int(expected.get("mode")):
        raise DocumentDeliveryError(f"document restore permissions do not match archive: {target}")
    return {**archived, **copied, **restored}


def archive_superseded_document(
    source: str | os.PathLike[str] | Path,
    archive_root: str | os.PathLike[str] | Path,
    *,
    max_bytes: int = DOCUMENT_MAX_BYTES,
) -> dict[str, Any]:
    """Archive one generated document under a validated private root.

    The source remains visible until the private copy is fully written and
    verified.  A second source fingerprint is required before unlinking it.
    The returned row keeps the original logical path and hash for rollback;
    it does not expose any file contents.
    """

    source_path = _validate_path_components(source)
    archive_base = _validate_path_components(archive_root)
    try:
        source_resolved = source_path.resolve(strict=False)
        archive_resolved = archive_base.resolve(strict=False)
    except (OSError, RuntimeError) as exc:
        raise DocumentDeliveryError("could not resolve document archive relationship") from exc
    if (
        source_path == archive_base
        or archive_base in source_path.parents
        or source_resolved == archive_resolved
        or archive_resolved in source_resolved.parents
    ):
        raise DocumentDeliveryError("a document cannot supersede a file in its archive root")
    before = fingerprint_document(source_path, max_bytes=max_bytes)
    archive_dir = archive_base / "superseded"
    _ensure_private_directory(archive_base)
    _ensure_private_directory(archive_dir)
    safe_name = re_safe_filename(source_path.name)
    archive_path = archive_dir / f"{uuid.uuid4().hex}-{safe_name}"
    try:
        copied = _copy_file_bounded(
            source_path,
            archive_path,
            max_bytes=max_bytes,
            mode=before.get("mode"),
        )
        # ``_copy_file_bounded`` verifies the source before and after its read.
        # A final independent check closes the window immediately before removal.
        verify_document_fingerprint(source_path, before, max_bytes=max_bytes)
        try:
            source_path.unlink()
        except OSError as exc:
            raise DocumentDeliveryError(f"could not archive superseded document: {source_path}") from exc
        try:
            fsync_directory(source_path.parent)
        except DocumentDeliveryError:
            # The source was removed but the archive is an exact copy.  Move it
            # back so a failed directory sync cannot turn a failed publication
            # into data loss.  Keep the original error as the visible failure.
            with_target = False
            try:
                if not source_path.exists() and not source_path.is_symlink():
                    os.replace(archive_path, source_path)
                    with_target = True
                    try:
                        fsync_directory(source_path.parent)
                    except DocumentDeliveryError:
                        pass
            except OSError:
                pass
            if not with_target:
                raise
            raise
        return {
            "path": str(source_path),
            "archive_path": str(archive_path),
            "size": int(copied.get("size", before.get("size", 0))),
            "sha256": str(copied.get("sha256", before.get("sha256", ""))),
            "mode": int(before.get("mode", 0) or 0),
            "format": before.get("format"),
            "mimeType": before.get("mimeType"),
        }
    except Exception as exc:
        # The archive path is random and owned by this invocation.  Clean it
        # only while the source is still present; after a successful move-back
        # the archive path no longer exists and after an uncertain rollback it
        # is safer to retain the private copy than to risk losing bytes.
        if source_path.exists() and archive_path.exists():
            try:
                archive_state = fingerprint_document(archive_path, max_bytes=max_bytes)
                expected_archive = {
                    "size": before.get("size", 0),
                    "sha256": before.get("sha256", ""),
                    "mode": before.get("mode"),
                }
                if _same_document_state(archive_state, expected_archive):
                    archive_path.unlink()
                    fsync_directory(archive_path.parent)
            except (OSError, DocumentDeliveryError):
                pass
        if isinstance(exc, OSError):
            raise DocumentDeliveryError(
                f"could not archive superseded document: {source_path}: {exc}"
            ) from exc
        raise


def re_safe_filename(value: str) -> str:
    """Keep archive names flat and portable across Windows/macOS."""

    raw = str(value or "").strip()
    safe = "".join(ch if ch.isalnum() or ch in {".", "-", "_"} else "_" for ch in raw)
    safe = safe.strip(".")
    return (safe or "document")[:180]


def append_current_turn_publication(
    session: Any,
    row: Mapping[str, Any],
    *,
    replaced_path: str | None = None,
) -> dict[str, Any]:
    """Record a bounded publication row and coalesce stale card entries.

    ``_turn_deliverables`` is deliberately an explicit publication channel;
    callers must not reconstruct it from the cumulative ``session.artifacts``
    map.  The lineage registry is an in-memory convenience. Durable manifests
    remain the source of truth after a restart.
    """

    clean = {
        str(key): value
        for key, value in row.items()
        if str(key)
        in {
            "path",
            "title",
            "format",
            "filename",
            "mimeType",
            "size",
            "sha256",
            "private",
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
        }
    }
    path = str(clean.get("path", "") or "").strip()
    if not path:
        raise DocumentDeliveryError("published document path is empty")
    old = str(replaced_path or clean.get("replaces_path", "") or "").strip()
    clean["path"] = path
    if old:
        clean["replaces_path"] = old
    pending = getattr(session, "_turn_deliverables", None)
    if not isinstance(pending, list):
        pending = []
        setattr(session, "_turn_deliverables", pending)
    kept: list[Any] = []
    for item in pending:
        if not isinstance(item, Mapping):
            continue
        item_path = str(item.get("path", "") or "").strip()
        if item_path == path or (old and item_path == old and old != path):
            continue
        kept.append(dict(item))
    kept.append(clean)
    pending[:] = kept

    registry = getattr(session, "_document_lineage", None)
    if not isinstance(registry, dict):
        registry = {}
        setattr(session, "_document_lineage", registry)
    if old and old != path:
        registry.pop(old, None)
    registry[path] = dict(clean)
    return clean


def current_publication_rows(session: Any) -> list[dict[str, Any]]:
    """Return a defensive copy of rows published during the current turn."""

    raw = getattr(session, "_turn_deliverables", None)
    if not isinstance(raw, list):
        return []
    return [dict(item) for item in raw if isinstance(item, Mapping)]


__all__ = [
    "DOCUMENT_MAX_BYTES",
    "DocumentDeliveryError",
    "SUPPORTED_DOCUMENT_EXTENSIONS",
    "append_current_turn_publication",
    "archive_superseded_document",
    "current_publication_rows",
    "document_format_for_path",
    "document_mime_type",
    "fingerprint_bytes",
    "fingerprint_document",
    "fsync_directory",
    "is_supported_document_path",
    "remove_document_if_unchanged",
    "re_safe_filename",
    "restore_archived_document",
    "verify_document_fingerprint",
]
