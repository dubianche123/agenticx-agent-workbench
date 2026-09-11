"""Permission-mode resolution shared by the Studio server and tool runtime.

The value in ``permissions.mode`` is the global default used when a session is
first created.  Once a session has a mode, runtime decisions must use that
session value instead of reading the global setting again.
"""

from __future__ import annotations

from typing import Any

from agenticx.cli.config_manager import ConfigManager


SUPPORTED_PERMISSION_MODES = frozenset({"plan", "ask", "auto"})
DEFAULT_PERMISSION_MODE = "ask"


def normalize_permission_mode(raw: Any, fallback: str = DEFAULT_PERMISSION_MODE) -> str:
    """Return a supported permission mode, or ``fallback`` when unknown."""

    text = str(raw or "").strip().lower()
    if text in SUPPORTED_PERMISSION_MODES:
        return text
    return fallback


def global_permission_mode() -> str:
    """Read the Settings-owned global default, failing closed to ``ask``."""

    try:
        raw = ConfigManager.get_value("permissions.mode")
    except Exception:
        return DEFAULT_PERMISSION_MODE
    return normalize_permission_mode(raw)


def permission_mode_for_session(session: Any | None = None) -> str:
    """Resolve the effective mode for a runtime session.

    A missing value is only expected for old in-memory/test sessions.  They use
    the global default as a compatibility fallback; materialized Studio
    sessions are initialized with and persist an explicit value.
    """

    raw = getattr(session, "permission_mode", None) if session is not None else None
    mode = normalize_permission_mode(raw, fallback="")
    return mode or global_permission_mode()
