"""Stable, server-owned purpose markers for Studio sessions.

The Desktop environment assistant uses a dedicated session so its history and
runtime state can survive a restart without becoming an ordinary chat.  Keep
the marker deliberately small and validated here; callers must not use a
client supplied title or actor label as the isolation boundary.
"""

from __future__ import annotations

import re
from typing import Any

ENVIRONMENT_ASSISTANT_PURPOSE = "environment-assistant"
_MAX_SCOPE_LENGTH = 160
_SCOPE_RE = re.compile(r"^[A-Za-z0-9._:-]{1,160}$")


def normalize_session_purpose(value: Any) -> str:
    """Return the supported purpose marker, or an empty string.

    Unknown purpose values are intentionally treated as ordinary by existing
    code paths until a server release understands them.  A future purpose can
    opt into the same listing boundary by extending this function.
    """

    value = str(value or "").strip().lower()
    if value == ENVIRONMENT_ASSISTANT_PURPOSE:
        return value
    return ""


def normalize_session_purpose_scope(value: Any) -> str:
    """Normalize the opaque identity/workspace scope used by a dedicated session."""

    value = str(value or "").strip()
    if not value or len(value) > _MAX_SCOPE_LENGTH or not _SCOPE_RE.fullmatch(value):
        return ""
    return value


def session_has_purpose(
    session_or_metadata: Any,
    purpose: Any,
    purpose_scope: Any = None,
) -> bool:
    """Check a managed session or metadata mapping against purpose and scope."""

    wanted = normalize_session_purpose(purpose)
    if not wanted:
        return False
    if isinstance(session_or_metadata, dict):
        actual = normalize_session_purpose(session_or_metadata.get("purpose"))
        actual_scope = normalize_session_purpose_scope(
            session_or_metadata.get("purpose_scope")
        )
    else:
        actual = normalize_session_purpose(getattr(session_or_metadata, "purpose", None))
        actual_scope = normalize_session_purpose_scope(
            getattr(session_or_metadata, "purpose_scope", None)
        )
    wanted_scope = normalize_session_purpose_scope(purpose_scope)
    return actual == wanted and (not wanted_scope or actual_scope == wanted_scope)

