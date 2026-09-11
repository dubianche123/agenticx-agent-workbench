"""Persistent, group-scoped relationship memory for project group chats.

This module deliberately has a narrow ingestion boundary.  It never accepts a
session, a chat-history list, or a private-chat store; callers must pass one
public group message at a time.  The boundary is important because a group
relationship memory is useful precisely when it can be safely shown back to
the whole room.

The memory is intentionally descriptive rather than semantic-search based.  It
keeps bounded, JSON-compatible summaries of:

* the names a user uses for members;
* the most recent owner of a topic;
* public disagreement records;
* public reply-to edges;
* public reaction aggregates;
* the room's observed expression style; and
* topics that are still open.

The default file is ``$AGX_HOME/groups/<safe-group-id>/social_memory.json``.
Writes use the repository's atomic JSON writer, and the group id is written
into the payload and checked again on restore.  A copied file therefore cannot
silently become another group's memory.
"""

from __future__ import annotations

import copy
import hashlib
import json
import re
import threading
from contextlib import contextmanager
from collections.abc import Mapping
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from agenticx.utils.agx_home import lazy_home_path
from agenticx.utils.atomic_writer import atomic_write_json

SCHEMA_VERSION = 1
DEFAULT_MAX_ITEMS = 100
DEFAULT_MAX_MESSAGE_IDS = 500
DEFAULT_MAX_TOPIC_HISTORY = 100
DEFAULT_MAX_REPLY_RELATIONS = 200
DEFAULT_MAX_REACTION_RELATIONS = 200
DEFAULT_MAX_DISAGREEMENTS = 100
DEFAULT_MAX_TEXT_CHARS = 500

_NON_PUBLIC_EVENT_TYPES = frozenset(
    {
        "group_pass",
        "group_skip",
        "group_skipped",
        "group_progress",
        "group_token",
        "group_typing",
        "group_handoff",
        "group_workflow_detail",
        "group_action_complete",
        "group_draft",
        "group_tool",
        "group_tool_call",
        "group_tool_result",
        "group_reaction",
        "group_reaction_added",
        "group_reaction_removed",
        "group_workflow_progress",
        "group_workflow_candidate",
        "group_workflow_review",
        "typing",
        "progress",
        "token",
        "draft",
        "tool",
        "tool_call",
        "tool_result",
        "workflow_detail",
        "workflow_progress",
        "workflow_candidate",
        "workflow_review",
        "workflow_private",
        "workflow_reaction",
        "pass",
        "skip",
        "skipped",
        "reaction",
    }
)
_WORKFLOW_FEED_EVENT_TYPES = frozenset(
    {
        "task_assigned",
        "task_failed",
        "decompose_failed",
        "final_delivery",
        "workflow_final_delivery",
        "workflow_final",
    }
)
_PRIVATE_VALUES = frozenset(
    {
        "private",
        "direct",
        "dm",
        "one_to_one",
        "one-to-one",
        "1:1",
        "one2one",
        "personal",
        "private_chat",
        "direct_message",
        "direct_chat",
        "dm_chat",
        "one-to-one-chat",
        "panel",
        "draft",
        "tool",
        "workflow",
        "workflow_detail",
        "workflow_progress",
        "workflow_candidate",
        "workflow_review",
        "workflow_private",
    }
)
_PRIVATE_SOURCE_VALUES = frozenset(
    {
        "workflow_private",
        "workflow_candidate",
        "workflow_review",
        "workflow_detail",
        "workflow_progress",
        "panel",
        "draft",
        "tool",
        "tool_call",
        "tool_result",
    }
)
_PASS_VALUES = frozenset(
    {
        "pass",
        "skip",
        "skipped",
        "no_reply",
        "no-reply",
        "no response",
        "no_response",
        "decline",
    }
)
_PASS_TEXT = frozenset({"__skip__", "__pass__", "(pass)", "[pass]", "pass", "skip"})
_LOW_SIGNAL_UNRESOLVED_TEXT = frozenset(
    {
        "好",
        "好的",
        "收到",
        "了解",
        "明白",
        "明白了",
        "谢谢",
        "谢谢你",
        "好的谢谢",
        "收到谢谢",
        "感谢",
        "多谢",
        "辛苦",
        "辛苦了",
        "确认",
        "确认了",
        "可以",
        "行",
        "没问题",
        "嗯",
        "嗯嗯",
        "你好",
        "嗨",
        "在吗",
        "早",
        "早上好",
        "晚上好",
        "晚安",
        "ok",
        "okay",
        "thanks",
        "thankyou",
        "hello",
        "hi",
    }
)
_EXPLICIT_RESOLUTION_TEXT = frozenset(
    {
        "已解决",
        "已完成",
        "已关闭",
        "完成",
        "完成了",
        "解决了",
        "关闭了",
        "搞定了",
        "resolved",
        "completed",
        "closed",
        "done",
    }
)
_MENTION_RE = re.compile(
    r"@([^\s@,，。！？!?、:：;；()（）\[\]【】{}<>「」『』]+)"
)
_SAFE_GROUP_COMPONENT_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$")
_SPACE_RE = re.compile(r"\s+")
_EMOJI_RANGES = (
    (0x1F300, 0x1FAFF),
    (0x2600, 0x27BF),
    (0x2300, 0x23FF),
)


def _field(value: Any, name: str, default: Any = None) -> Any:
    """Read a field from a mapping or a light GroupReply-like object."""

    if isinstance(value, Mapping):
        return value.get(name, default)
    try:
        return getattr(value, name, default)
    except Exception:
        return default


def _normalise_text(value: Any, limit: int = DEFAULT_MAX_TEXT_CHARS) -> str:
    text = str(value or "").strip()
    if len(text) > limit:
        return text[:limit]
    return text


def _normalise_id(value: Any) -> str:
    return _normalise_text(value, 256)


def _normalise_key(value: Any) -> str:
    return _SPACE_RE.sub(" ", _normalise_text(value, 256)).strip().casefold()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _as_bool(value: Any) -> bool | None:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)) and value in (0, 1):
        return bool(value)
    if isinstance(value, str):
        normalized = value.strip().casefold()
        if normalized in {"true", "yes", "y", "1", "是", "有"}:
            return True
        if normalized in {"false", "no", "n", "0", "否", "无"}:
            return False
    return None


def _private_marker(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return False
    return str(value).strip().casefold() in _PRIVATE_VALUES


def _private_source(value: Any) -> bool:
    return str(value or "").strip().casefold() in _PRIVATE_SOURCE_VALUES


def _scope_is_private(value: Mapping[str, Any]) -> bool:
    """Check explicit scope markers without traversing arbitrary payloads."""

    for name in (
        "is_private",
        "private",
        "private_chat",
        "is_direct",
        "is_one_to_one",
        "one_to_one",
        "is_dm",
        "direct_message",
        "private_message",
        "is_draft",
        "draft",
        "is_tool",
        "tool",
        "is_panel",
    ):
        if _as_bool(value.get(name)) is True:
            return True
    if _as_bool(value.get("is_public")) is False or _as_bool(value.get("public")) is False:
        return True
    for name in (
        "scope",
        "feed_visibility",
        "visibility",
        "conversation_scope",
        "conversation_type",
        "chat_type",
        "room_type",
        "message_type",
        "source",
        "channel_type",
        "chat_scope",
        "visibility_scope",
        "conversation_kind",
        "kind",
        "type",
        "workflow_event_type",
        "workflow_status",
        "workflow_stage",
    ):
        if _private_marker(value.get(name)):
            return True
    if any(
        _private_source(value.get(name))
        for name in ("publication_source", "group_publication_source", "source")
    ):
        return True
    event_type = str(value.get("event_type") or "").strip().casefold()
    if event_type in _NON_PUBLIC_EVENT_TYPES or event_type in _PRIVATE_VALUES:
        return True
    for name in ("workflow_event_type", "workflow_status", "workflow_stage"):
        marker = str(value.get(name) or "").strip().casefold()
        if marker in _WORKFLOW_FEED_EVENT_TYPES:
            continue
        if marker in _NON_PUBLIC_EVENT_TYPES or marker in _PRIVATE_VALUES:
            return True
        if marker.startswith(("workflow_", "workforce_", "task_", "review_")):
            return True
    for name in ("action", "decision", "disposition", "status"):
        marker = str(value.get(name) or "").strip().casefold()
        if marker in _PASS_VALUES or marker in _PRIVATE_VALUES:
            return True
    return False


def _scope_is_explicitly_public(value: Mapping[str, Any]) -> bool:
    """Require an affirmative Feed marker; absence never means public."""

    if _as_bool(value.get("is_public")) is True or _as_bool(value.get("public")) is True:
        return True
    for name in (
        "feed_visibility",
        "visibility",
        "scope",
        "conversation_scope",
        "chat_scope",
    ):
        if str(value.get(name) or "").strip().casefold() in {
            "feed",
            "public",
            "group",
            "group_feed",
            "room",
        }:
            return True
    return False


_SCOPE_FIELD_NAMES = (
    "is_private",
    "private",
    "private_chat",
    "is_direct",
    "is_one_to_one",
    "one_to_one",
    "is_dm",
    "direct_message",
    "private_message",
    "is_public",
    "public",
    "scope",
    "feed_visibility",
    "visibility",
    "conversation_scope",
    "conversation_type",
    "chat_type",
    "room_type",
    "message_type",
    "source",
    "channel_type",
    "chat_scope",
    "visibility_scope",
    "conversation_kind",
    "kind",
    "type",
    "publication_source",
    "group_publication_source",
    "event_type",
    "workflow_event_type",
    "workflow_status",
    "workflow_stage",
    "action",
    "decision",
    "disposition",
    "status",
)


def _scope_mapping(value: Any) -> Mapping[str, Any]:
    if isinstance(value, Mapping):
        return value
    return {
        name: _field(value, name, None)
        for name in _SCOPE_FIELD_NAMES
        if _field(value, name, None) is not None
    }


def _fact_scope_is_private(value: Mapping[str, Any]) -> bool:
    """Check a structured fact and its explicit metadata envelope."""

    if _scope_is_private(value):
        return True
    for container_name in ("metadata", "event_data"):
        nested = value.get(container_name)
        if isinstance(nested, Mapping) and _scope_is_private(nested):
            return True
    return False


def _message_content(message: Any) -> str:
    return _normalise_text(_field(message, "content", ""), DEFAULT_MAX_TEXT_CHARS)


def _is_low_signal_unresolved_text(value: Any) -> bool:
    """Avoid turning acknowledgements or emoji-only turns into open work."""

    text = _normalise_text(value, DEFAULT_MAX_TEXT_CHARS)
    chars = [char for char in text if not char.isspace()]
    if not chars:
        return True
    if not any(char.isalnum() or "\u4e00" <= char <= "\u9fff" for char in chars):
        return True
    compact = re.sub(r"[^\w\u4e00-\u9fff]+", "", text.casefold())
    return compact in _LOW_SIGNAL_UNRESOLVED_TEXT


def _has_explicit_resolution_text(value: Any) -> bool:
    text = _normalise_text(value, DEFAULT_MAX_TEXT_CHARS)
    compact = re.sub(r"[^\w\u4e00-\u9fff]+", "", text.casefold())
    if compact in _EXPLICIT_RESOLUTION_TEXT:
        return True
    return any(
        marker in compact
        for marker in ("已解决", "已完成", "已关闭", "完成了", "解决了", "关闭了", "搞定了")
    )


def is_public_group_message(message: Any, *, group_id: str | None = None) -> bool:
    """Return whether ``message`` is safe to add to a public group memory.

    Admission is fail-closed: a message must carry the matching ``group_id``
    and an affirmative public-Feed marker.  Merely looking like a user or
    assistant row never makes a draft, panel record, or one-to-one message
    eligible for shared relationship memory.
    """

    if message is None or isinstance(message, (str, bytes, bytearray)):
        return False

    expected_group = _normalise_id(group_id)
    # Explicit private/draft/tool/workflow markers always win, including when
    # a malformed producer also asserts ``is_public=true``.
    top_level = _scope_mapping(message)
    if _scope_is_private(top_level):
        return False
    if _as_bool(_field(message, "is_group")) is False:
        return False

    # Some adapters put delivery scope under metadata/event_data.  Inspect
    # only these explicit scope markers; never walk arbitrary nested values or
    # a session/history field looking for messages.
    public_marked = _scope_is_explicitly_public(top_level)
    for container_name in ("metadata", "event_data"):
        nested = _field(message, container_name)
        if not isinstance(nested, Mapping):
            continue
        if _scope_is_private(nested):
            return False
        public_marked = public_marked or _scope_is_explicitly_public(nested)
    if not public_marked:
        return False

    event_type = str(_field(message, "event_type", "") or "").strip().casefold()
    if event_type in _NON_PUBLIC_EVENT_TYPES or event_type in _PRIVATE_VALUES:
        return False
    for name in ("action", "decision", "disposition", "status"):
        marker = str(_field(message, name, "") or "").strip().casefold()
        if marker in _PASS_VALUES:
            return False

    supplied_group_ids = []
    group_sources: list[Any] = [message]
    for container_name in ("metadata", "event_data"):
        nested = _field(message, container_name)
        if isinstance(nested, Mapping):
            group_sources.append(nested)
    for source in group_sources:
        for name in ("group_id", "group", "group_chat_id", "room_group_id"):
            raw = _field(source, name, None)
            if raw is not None and not isinstance(raw, (Mapping, list, tuple, set)):
                value = _normalise_id(raw)
                if value:
                    supplied_group_ids.append(value)
    if expected_group and any(value != expected_group for value in supplied_group_ids):
        return False
    if expected_group and not supplied_group_ids:
        return False

    content = _message_content(message)
    if not content or content.casefold() in _PASS_TEXT:
        return False
    if _as_bool(_field(message, "skipped")) is True:
        return False
    return True


class GroupSocialMemory:
    """Bounded relationship memory for one public group.

    ``GroupSocialMemory`` does not inspect sessions or histories.  The only
    ingestion method, :meth:`record_public_message`, receives one message-like
    object and first applies :func:`is_public_group_message`.  A caller may
    enable ``auto_persist`` when a durable update is desired after every
    accepted message; the default keeps tests and high-volume streams cheap.
    """

    # A session gets its own in-memory object, but all objects for one group
    # normally point at the same file.  Serialising only ``atomic_write_json``
    # is not enough: the second writer could still be holding an older full
    # snapshot.  Keep one re-entrant lock per (group, canonical path) so the
    # read/merge/write transaction is serialized within a process.  A separate
    # lock-file transaction below covers writers in different processes.
    _PERSIST_LOCKS: dict[tuple[str, str], threading.RLock] = {}
    _PERSIST_LOCKS_GUARD = threading.Lock()

    def __init__(
        self,
        group_id: str,
        *,
        storage_path: str | Path | None = None,
        storage_dir: str | Path | None = None,
        auto_persist: bool = False,
        max_items: int = DEFAULT_MAX_ITEMS,
        max_message_ids: int = DEFAULT_MAX_MESSAGE_IDS,
        max_topic_history: int = DEFAULT_MAX_TOPIC_HISTORY,
        max_reply_relations: int = DEFAULT_MAX_REPLY_RELATIONS,
        max_reaction_relations: int = DEFAULT_MAX_REACTION_RELATIONS,
        max_disagreements: int = DEFAULT_MAX_DISAGREEMENTS,
    ) -> None:
        self.group_id = _normalise_id(group_id)
        if not self.group_id:
            raise ValueError("group_id must be a non-empty string")
        if storage_path is not None and storage_dir is not None:
            raise ValueError("pass storage_path or storage_dir, not both")
        self.auto_persist = bool(auto_persist)
        self.max_items = self._positive_limit("max_items", max_items)
        self.max_message_ids = self._positive_limit("max_message_ids", max_message_ids)
        self.max_topic_history = self._positive_limit("max_topic_history", max_topic_history)
        self.max_reply_relations = self._positive_limit("max_reply_relations", max_reply_relations)
        self.max_reaction_relations = self._positive_limit(
            "max_reaction_relations", max_reaction_relations
        )
        self.max_disagreements = self._positive_limit("max_disagreements", max_disagreements)
        self._storage_path = self._resolve_storage_path(storage_path, storage_dir)
        self._lock = threading.RLock()
        self._addressing_habits: dict[str, dict[str, Any]] = {}
        self._topic_owners: dict[str, dict[str, Any]] = {}
        self._topic_history: list[dict[str, Any]] = []
        self._disagreements: list[dict[str, Any]] = []
        self._reply_relations: list[dict[str, Any]] = []
        self._reaction_relations: list[dict[str, Any]] = []
        self._style_profile: dict[str, Any] = self._empty_style_profile()
        self._unresolved_topics: dict[str, dict[str, Any]] = {}
        self._observed_message_ids: list[str] = []
        # The last snapshot known to be persisted for each target path.  A
        # persistence transaction applies only the local delta since this
        # baseline to the latest on-disk snapshot, avoiding duplicate counts
        # when one instance persists repeatedly while another instance writes.
        self._persisted_snapshots: dict[str, dict[str, Any]] = {}
        # Resolution is a deletion operation and therefore cannot be inferred
        # from a snapshot diff alone (bounded maps can also lose old keys).
        self._pending_unresolved_resolutions: set[str] = set()

    @staticmethod
    def _positive_limit(name: str, value: Any) -> int:
        if isinstance(value, bool) or not isinstance(value, int) or value < 1:
            raise ValueError(f"{name} must be a positive integer")
        return value

    def _trim_state_map(self, values: dict[str, dict[str, Any]]) -> None:
        """Keep the descriptive maps bounded by their configured item limit."""

        while len(values) > self.max_items:
            oldest_key = min(
                values,
                key=lambda key: str(
                    values[key].get("last_seen_at")
                    or values[key].get("last_used_at")
                    or values[key].get("first_seen_at")
                    or ""
                ),
            )
            values.pop(oldest_key, None)

    @staticmethod
    def _safe_group_component(group_id: str) -> str:
        if _SAFE_GROUP_COMPONENT_RE.fullmatch(group_id) and group_id not in {".", ".."}:
            return group_id
        digest = hashlib.sha256(group_id.encode("utf-8")).hexdigest()
        return f"group-{digest}"

    def _resolve_storage_path(
        self,
        storage_path: str | Path | None,
        storage_dir: str | Path | None,
    ) -> Path:
        if storage_path is not None:
            return Path(storage_path).expanduser()
        root = (
            Path(storage_dir).expanduser()
            if storage_dir is not None
            else lazy_home_path(__name__, "SOCIAL_MEMORY_ROOT", "groups")
        )
        return root / self._safe_group_component(self.group_id) / "social_memory.json"

    @property
    def storage_path(self) -> Path:
        return self._storage_path

    @staticmethod
    def _empty_style_profile() -> dict[str, Any]:
        return {
            "message_count": 0,
            "emoji_message_count": 0,
            "emoji_count": 0,
            "avg_chars": 0.0,
            "short_message_ratio": 0.0,
            "tone_counts": {},
            "verbosity_counts": {},
            "format_counts": {},
            "uses_emoji": False,
            "preferred_tone": "",
            "preferred_verbosity": "",
            "preferred_format": "",
            "last_updated_at": "",
        }

    # ------------------------------------------------------------------
    # Read-only views
    # ------------------------------------------------------------------
    @property
    def addressing_habits(self) -> dict[str, dict[str, Any]]:
        with self._lock:
            return copy.deepcopy(self._addressing_habits)

    @property
    def topic_owners(self) -> dict[str, dict[str, Any]]:
        with self._lock:
            return copy.deepcopy(self._topic_owners)

    @property
    def disagreements(self) -> list[dict[str, Any]]:
        with self._lock:
            return copy.deepcopy(self._disagreements)

    @property
    def reply_relations(self) -> list[dict[str, Any]]:
        with self._lock:
            return copy.deepcopy(self._reply_relations)

    @property
    def reaction_relations(self) -> list[dict[str, Any]]:
        with self._lock:
            return copy.deepcopy(self._reaction_relations)

    @property
    def style_profile(self) -> dict[str, Any]:
        with self._lock:
            return copy.deepcopy(self._style_profile)

    @property
    def unresolved_topics(self) -> dict[str, dict[str, Any]]:
        with self._lock:
            return copy.deepcopy(self._unresolved_topics)

    @property
    def observed_message_ids(self) -> tuple[str, ...]:
        with self._lock:
            return tuple(self._observed_message_ids)

    def preferred_name(self, member_id: str) -> str:
        member = _normalise_id(member_id)
        with self._lock:
            item = self._addressing_habits.get(member, {})
            return str(item.get("preferred_label") or item.get("member_name") or "")

    def record_addressing_preference(
        self,
        member_id: str,
        label: str,
        *,
        source_message: Any = None,
        turn_id: str = "",
        timestamp: str = "",
    ) -> bool:
        """Record one public user-facing name for a member.

        This is a convenience for adapters that already extracted a mention
        from one public group message.  The source message is mandatory so a
        private conversation cannot be asserted into this memory directly.
        """

        if source_message is None or not is_public_group_message(source_message, group_id=self.group_id):
            return False
        member = _normalise_id(member_id)
        name = _normalise_text(label, 256)
        if not member or not name:
            return False
        with self._lock:
            self._update_addressing_habits(
                {
                    "sender_id": "user",
                    "role": "user",
                    "is_user": True,
                    "addressed_member_id": member,
                    "addressed_member_name": name,
                    "turn_id": _normalise_id(turn_id),
                    "timestamp": _normalise_text(timestamp, 80) or _now_iso(),
                }
            )
        if self.auto_persist:
            self.persist()
        return True

    def get_topic_owner(self, topic: str) -> dict[str, Any] | None:
        key = _normalise_key(topic)
        with self._lock:
            item = self._topic_owners.get(key)
            return copy.deepcopy(item) if item is not None else None

    def record_topic_owner(
        self,
        topic: str,
        owner_id: str,
        *,
        owner_name: str = "",
        source_message: Any = None,
        source_message_id: str = "",
        timestamp: str = "",
    ) -> bool:
        """Record a topic owner already derived from public room context."""

        if source_message is None or not is_public_group_message(source_message, group_id=self.group_id):
            return False
        topic_text = _normalise_text(topic, 256)
        owner = _normalise_id(owner_id)
        if not topic_text or not owner:
            return False
        with self._lock:
            self._update_topics(
                {
                    "sender_id": owner,
                    "sender_name": _normalise_text(owner_name, 256) or owner,
                    "topic": topic_text,
                    "message_id": _normalise_id(source_message_id),
                    "timestamp": _normalise_text(timestamp, 80) or _now_iso(),
                }
            )
        if self.auto_persist:
            self.persist()
        return True

    def style_hint(self) -> dict[str, Any]:
        """Return a compact style hint suitable for a group prompt."""

        style = self.style_profile
        return {
            "tone": style.get("preferred_tone", ""),
            "verbosity": style.get("preferred_verbosity", ""),
            "format": style.get("preferred_format", ""),
            "uses_emoji": bool(style.get("uses_emoji", False)),
            "short_message_ratio": style.get("short_message_ratio", 0.0),
        }

    # ------------------------------------------------------------------
    # Public ingestion boundary
    # ------------------------------------------------------------------
    def record_public_message(self, message: Any = None, **fields: Any) -> bool:
        """Observe one public group message and update relationship memory.

        ``message`` may be a mapping or a GroupReply-like object.  Keyword
        fields override values on that object, which keeps this method useful
        for adapters that attach ``message_id`` or ``reply_to`` externally.
        Private, direct, skipped, pass, progress and cross-group inputs return
        ``False`` and do not update any state.  A repeated explicit
        ``message_id`` is also ignored, making retries idempotent.
        """

        payload = self._merge_message(message, fields)
        if not is_public_group_message(payload, group_id=self.group_id):
            return False
        normalized = self._normalise_public_message(payload)
        message_id = normalized["message_id"]
        # Public Feed rows have stable ids.  Refuse anonymous observations so
        # retries/reconnect replays cannot inflate relationship counts.
        if not message_id:
            return False
        with self._lock:
            if message_id in self._observed_message_ids:
                return False
            self._observed_message_ids.append(message_id)
            self._observed_message_ids = self._observed_message_ids[-self.max_message_ids :]
            self._update_addressing_habits(normalized)
            self._update_topics(normalized)
            self._update_reply_relation(normalized)
            self._update_reactions_from_message(normalized)
            self._update_disagreements_from_message(normalized)
            self._update_unresolved_topics_from_message(normalized)
            self._update_style(normalized)
        if self.auto_persist:
            self.persist()
        return True

    @staticmethod
    def _merge_message(message: Any, fields: Mapping[str, Any]) -> dict[str, Any]:
        payload: dict[str, Any] = {}
        if isinstance(message, Mapping):
            payload.update(message)
        elif message is not None:
            # Only copy known message attributes.  We deliberately do not call
            # ``vars`` on arbitrary objects, which could expose private session
            # state to the memory layer.
            known_fields = {
                "agent_id",
                "avatar_id",
                "avatar_name",
                "avatar_url",
                "sender_id",
                "sender_name",
                "role",
                "is_user",
                "content",
                "message_id",
                "id",
                "event_id",
                "group_id",
                "scope",
                "visibility",
                "is_public",
                "is_private",
                "is_group",
                "is_dm",
                "direct_message",
                "private_message",
                "skipped",
                "event_type",
                "chat_scope",
                "visibility_scope",
                "action",
                "reply_to_message_id",
                "quoted_message_id",
                "in_reply_to_message_id",
                "reply_to_agent_id",
                "reply_to_avatar_id",
                "mentioned_avatar_ids",
                "mention_labels",
                "topic",
                "topics",
                "topic_owner_id",
                "topic_owner_name",
                "disagreement",
                "disagreements",
                "unresolved_topics",
                "resolved_topic",
                "resolved_topics",
                "resolution_signal",
                "resolution",
                "workflow_final",
                "workflow_event_type",
                "workflow_status",
                "publication_source",
                "group_publication_source",
                "feed_visibility",
                "reactions",
                "reaction",
                "style",
                "tone",
                "verbosity",
                "format",
                "use_emoji",
                "uses_emoji",
                "emoji",
                "timestamp",
                "created_at",
                "turn_id",
                "reply_to",
                "metadata",
                "event_data",
            }
            for name in known_fields:
                try:
                    value = getattr(message, name)
                except Exception:
                    continue
                if value is not None:
                    payload[name] = value
        payload.update({str(key): value for key, value in fields.items()})
        return payload

    @staticmethod
    def _normalise_public_message(message: Mapping[str, Any]) -> dict[str, Any]:
        sender_id = _normalise_id(
            message.get("agent_id")
            or message.get("avatar_id")
            or message.get("sender_id")
        )
        sender_name = _normalise_text(
            message.get("avatar_name")
            or message.get("sender_name")
            or sender_id,
            256,
        )
        message_id = _normalise_id(
            message.get("message_id") or message.get("event_id") or message.get("id")
        )
        reply_to = message.get("reply_to")
        reply_to_value = (
            reply_to
            if isinstance(reply_to, (str, int))
            else _field(reply_to, "message_id", _field(reply_to, "id", ""))
        )
        reply_message_id = _normalise_id(
            message.get("reply_to_message_id")
            or message.get("quoted_message_id")
            or message.get("in_reply_to_message_id")
            or reply_to_value
        )
        reply_agent_id = _normalise_id(
            message.get("reply_to_agent_id")
            or message.get("reply_to_avatar_id")
            or _field(reply_to, "agent_id", _field(reply_to, "avatar_id", ""))
        )
        timestamp = _normalise_text(message.get("timestamp") or message.get("created_at") or "", 80)
        if not timestamp:
            timestamp = _now_iso()
        normalized = {
            "raw": message,
            "sender_id": sender_id,
            "sender_name": sender_name,
            "role": _normalise_text(message.get("role") or "", 40).casefold(),
            "is_user": message.get("is_user"),
            "content": _message_content(message),
            "message_id": message_id,
            "reply_to_message_id": reply_message_id,
            "reply_to_agent_id": reply_agent_id,
            "timestamp": timestamp,
            "turn_id": _normalise_id(message.get("turn_id") or ""),
        }
        # Preserve only the structured fields consumed by the update routines.
        # The original mapping stays under ``raw`` for optional style metadata;
        # arbitrary nested session attributes are never traversed.
        for key in (
            "mentioned_avatar_ids",
            "mention_labels",
            "topic",
            "topics",
            "topic_owner_id",
            "topic_owner_name",
            "disagreement",
            "disagreements",
            "positions",
            "unresolved_topics",
            "resolved_topic",
            "resolved_topics",
            "resolved",
            "resolution_signal",
            "resolution",
            "workflow_final",
            "workflow_event_type",
            "workflow_status",
            "publication_source",
            "group_publication_source",
            "feed_visibility",
            "reactions",
            "reaction",
            "reaction_emoji",
            "reaction_actor_id",
            "actor_id",
            "active",
            "style",
            "tone",
            "verbosity",
            "format",
            "use_emoji",
            "uses_emoji",
            "emoji",
            "addressed_member_id",
            "addressed_member_name",
        ):
            if key in message:
                normalized[key] = message[key]
        return normalized

    @staticmethod
    def _is_user_message(message: Mapping[str, Any]) -> bool:
        explicit = _as_bool(message.get("is_user"))
        if explicit is not None:
            return explicit
        role = str(message.get("role") or "").strip().casefold()
        sender = str(message.get("sender_id") or "").strip().casefold()
        return role in {"user", "human", "customer"} or sender in {"user", "human", "me"} or sender.startswith("user:")

    @staticmethod
    def _mention_items(message: Mapping[str, Any]) -> list[tuple[str, str]]:
        explicit_ids = message.get("mentioned_avatar_ids")
        if isinstance(explicit_ids, (list, tuple, set)):
            ids = [_normalise_id(item) for item in explicit_ids if _normalise_id(item)]
        elif explicit_ids:
            ids = [_normalise_id(explicit_ids)]
        else:
            ids = []
        labels_value = message.get("mention_labels")
        labels: list[str] = []
        if isinstance(labels_value, Mapping):
            for member_id, label_value in labels_value.items():
                label = _normalise_text(label_value, 256)
                if label:
                    labels.append(label)
        elif isinstance(labels_value, (list, tuple, set)):
            labels.extend(
                _normalise_text(item, 256)
                for item in labels_value
                if _normalise_text(item, 256)
            )
        elif labels_value:
            labels.append(_normalise_text(labels_value, 256))
        labels.extend(match.group(1).strip() for match in _MENTION_RE.finditer(str(message.get("content") or "")))
        labels = [label for label in labels if label]
        items = [
            (member_id, labels[index] if index < len(labels) else member_id)
            for index, member_id in enumerate(ids)
        ]
        out: list[tuple[str, str]] = []
        seen: set[tuple[str, str]] = set()
        for item in items:
            key = (_normalise_key(item[0]), _normalise_key(item[1]))
            if key not in seen:
                seen.add(key)
                out.append(item)
        return out

    def _update_addressing_habits(self, message: Mapping[str, Any]) -> None:
        if not self._is_user_message(message):
            return
        mentions = self._mention_items(message)
        addressed_id = _normalise_id(message.get("addressed_member_id") or "")
        addressed_name = _normalise_text(message.get("addressed_member_name") or "", 256)
        if addressed_id:
            mentions.append((addressed_id, addressed_name or addressed_id))
        for member_id, label in mentions:
            member_key = _normalise_id(member_id)
            label = _normalise_text(label or member_id, 256)
            if not member_key or not label:
                continue
            item = self._addressing_habits.setdefault(
                member_key,
                {
                    "member_id": member_key,
                    "member_name": label,
                    "labels": {},
                    "preferred_label": label,
                    "count": 0,
                    "last_used_turn_id": "",
                    "last_seen_at": "",
                },
            )
            labels = item.setdefault("labels", {})
            labels[label] = int(labels.get(label, 0) or 0) + 1
            item["count"] = int(item.get("count", 0) or 0) + 1
            item["member_name"] = label
            item["last_used_turn_id"] = str(message.get("turn_id") or "")
            item["last_seen_at"] = str(message.get("timestamp") or _now_iso())
            item["preferred_label"] = max(
                labels,
                key=lambda candidate: (int(labels.get(candidate, 0) or 0), candidate == label, candidate),
            )
        self._trim_state_map(self._addressing_habits)

    @staticmethod
    def _topic_items(
        message: Mapping[str, Any], *, group_id: str = ""
    ) -> list[tuple[str, str, str]]:
        values: list[Any] = []
        for key in ("topics", "topic"):
            value = message.get(key)
            if value is not None and value != "":
                values.append(value)
        items: list[tuple[str, str, str]] = []
        for value in values:
            if isinstance(value, Mapping):
                if _fact_scope_is_private(value):
                    continue
                nested_group_id = _normalise_id(value.get("group_id") or "")
                if group_id and nested_group_id and nested_group_id != _normalise_id(group_id):
                    continue
                topic = value.get("topic") or value.get("key") or value.get("name") or value.get("id")
                owner_id = value.get("owner_id") or value.get("topic_owner_id") or ""
                owner_name = value.get("owner_name") or value.get("topic_owner_name") or ""
                if topic:
                    items.append((_normalise_text(topic, 256), _normalise_id(owner_id), _normalise_text(owner_name, 256)))
            elif isinstance(value, (list, tuple, set)):
                for item in value:
                    if item:
                        text = _normalise_text(item, 256)
                        items.append((text, "", ""))
            else:
                items.append((_normalise_text(value, 256), "", ""))
        return [(topic, owner_id, owner_name) for topic, owner_id, owner_name in items if topic]

    def _update_topics(self, message: Mapping[str, Any]) -> None:
        sender_id = str(message.get("sender_id") or "")
        if self._is_user_message(message):
            sender_id = ""
        explicit_owner_id = _normalise_id(message.get("topic_owner_id") or "")
        explicit_owner_name = _normalise_text(message.get("topic_owner_name") or "", 256)
        for topic, owner_id, owner_name in self._topic_items(message, group_id=self.group_id):
            owner_id = owner_id or explicit_owner_id or sender_id
            if not owner_id or owner_id.casefold() in {"user", "human", "me"}:
                continue
            owner_name = owner_name or explicit_owner_name or (
                "" if owner_id == sender_id and not message.get("sender_name") else str(message.get("sender_name") or "")
            )
            key = _normalise_key(topic)
            entry = self._topic_owners.setdefault(
                key,
                {
                    "topic": topic,
                    "owner_id": owner_id,
                    "owner_name": owner_name or owner_id,
                    "count": 0,
                    "last_message_id": "",
                    "last_seen_at": "",
                },
            )
            entry.update(
                {
                    "topic": topic,
                    "owner_id": owner_id,
                    "owner_name": owner_name or owner_id,
                    "count": int(entry.get("count", 0) or 0) + 1,
                    "last_message_id": str(message.get("message_id") or ""),
                    "last_seen_at": str(message.get("timestamp") or _now_iso()),
                }
            )
            self._topic_history.append(
                {
                    "topic": topic,
                    "topic_key": key,
                    "owner_id": owner_id,
                    "owner_name": owner_name or owner_id,
                    "message_id": str(message.get("message_id") or ""),
                    "seen_at": str(message.get("timestamp") or _now_iso()),
                }
            )
        self._topic_history = self._topic_history[-self.max_topic_history :]
        self._trim_state_map(self._topic_owners)

    def _update_reply_relation(self, message: Mapping[str, Any]) -> None:
        target_message_id = _normalise_id(message.get("reply_to_message_id") or "")
        target_agent_id = _normalise_id(message.get("reply_to_agent_id") or "")
        source_agent_id = _normalise_id(message.get("sender_id") or "")
        if not source_agent_id or (not target_message_id and not target_agent_id):
            return
        target_key = target_message_id or f"agent:{target_agent_id}"
        existing = next(
            (
                item
                for item in reversed(self._reply_relations)
                if item.get("from_agent_id") == source_agent_id and item.get("target_key") == target_key
            ),
            None,
        )
        if existing is None:
            existing = {
                "from_agent_id": source_agent_id,
                "from_agent_name": str(message.get("sender_name") or source_agent_id),
                "to_message_id": target_message_id,
                "to_agent_id": target_agent_id,
                "target_key": target_key,
                "count": 0,
                "message_ids": [],
                "last_message_id": "",
                "last_seen_at": "",
            }
            self._reply_relations.append(existing)
        existing["count"] = int(existing.get("count", 0) or 0) + 1
        source_message_id = _normalise_id(message.get("message_id") or "")
        if source_message_id:
            ids = existing.setdefault("message_ids", [])
            ids.append(source_message_id)
            existing["message_ids"] = ids[-20:]
            existing["last_message_id"] = source_message_id
        existing["last_seen_at"] = str(message.get("timestamp") or _now_iso())
        self._reply_relations = self._reply_relations[-self.max_reply_relations :]

    def record_reply_relation(
        self,
        from_agent_id: str,
        *,
        to_message_id: str = "",
        to_agent_id: str = "",
        message_id: str = "",
        source_message: Any = None,
        timestamp: str = "",
    ) -> bool:
        """Record a reply edge derived from one public room message."""

        if source_message is None or not is_public_group_message(source_message, group_id=self.group_id):
            return False
        source = _normalise_id(from_agent_id)
        target_message = _normalise_id(to_message_id)
        target_agent = _normalise_id(to_agent_id)
        if not source or (not target_message and not target_agent):
            return False
        with self._lock:
            self._update_reply_relation(
                {
                    "sender_id": source,
                    "sender_name": source,
                    "reply_to_message_id": target_message,
                    "reply_to_agent_id": target_agent,
                    "message_id": _normalise_id(message_id),
                    "timestamp": _normalise_text(timestamp, 80) or _now_iso(),
                }
            )
        if self.auto_persist:
            self.persist()
        return True

    @staticmethod
    def _reaction_items(message: Mapping[str, Any]) -> list[dict[str, Any]]:
        """Normalize reaction aggregates or one reaction action.

        The public-feed adapters use both ``reactions=[{emoji, actor_ids}]``
        aggregates and ``reaction={emoji, actor_id, active}`` action payloads.
        This parser only reads those explicit fields; it never walks arbitrary
        session/history objects.
        """

        values: list[Any] = []
        for key in ("reactions", "reaction"):
            value = message.get(key)
            if value is not None:
                values.append(value)
        raw = message.get("raw")
        if isinstance(raw, Mapping):
            metadata = raw.get("metadata")
            if isinstance(metadata, Mapping) and metadata.get("group_reactions") is not None:
                values.append(metadata.get("group_reactions"))

        # Support a compact top-level reaction action without making every
        # ordinary emoji-containing message a reaction update.
        if message.get("reaction_emoji") or message.get("reaction_actor_id"):
            values.append(
                {
                    "emoji": message.get("reaction_emoji") or message.get("emoji"),
                    "actor_id": message.get("reaction_actor_id") or message.get("actor_id"),
                    "active": message.get("active", True),
                    "message_id": message.get("message_id"),
                }
            )

        out: list[dict[str, Any]] = []

        def append_item(value: Any, *, default_target: str) -> None:
            if isinstance(value, Mapping):
                if _fact_scope_is_private(value):
                    return
                # A mapping may be either one reaction object or emoji ->
                # actor(s) aggregate.  Prefer the explicit object shape.
                has_object_shape = any(
                    value.get(key) not in (None, "")
                    for key in (
                        "emoji",
                        "reaction_emoji",
                        "actor_id",
                        "actor_ids",
                        "actors",
                        "user_ids",
                        "active",
                    )
                )
                if has_object_shape:
                    emoji = _normalise_text(
                        value.get("emoji") or value.get("reaction_emoji") or "",
                        80,
                    )
                    target = _normalise_id(
                        value.get("message_id")
                        or value.get("target_message_id")
                        or default_target
                    )
                    active = _as_bool(value.get("active"))
                    if active is None:
                        active = True
                    actor_values = value.get("actor_ids")
                    if actor_values is None:
                        actor_values = value.get("actors")
                    if actor_values is None:
                        actor_values = value.get("user_ids")
                    if actor_values is None:
                        actor_values = value.get("actor_id") or value.get("user_id") or ""
                    if isinstance(actor_values, Mapping):
                        actor_values = list(actor_values)
                    if not isinstance(actor_values, (list, tuple, set)):
                        actor_values = [actor_values]
                    actors = [
                        _normalise_id(actor)
                        for actor in actor_values
                        if _normalise_id(actor)
                    ]
                    if emoji and actors:
                        for actor in dict.fromkeys(actors):
                            out.append(
                                {
                                    "message_id": target,
                                    "emoji": emoji,
                                    "actor_id": actor,
                                    "active": bool(active),
                                    "timestamp": _normalise_text(
                                        value.get("timestamp") or value.get("created_at") or "",
                                        80,
                                    ),
                                }
                            )
                    return
                for emoji, actors in value.items():
                    append_item(
                        {"emoji": emoji, "actor_ids": actors},
                        default_target=default_target,
                    )
                return
            if isinstance(value, (list, tuple, set)):
                for item in value:
                    append_item(item, default_target=default_target)

        default_target = _normalise_id(message.get("message_id") or "")
        for value in values:
            append_item(value, default_target=default_target)
        return out

    def _upsert_reaction(
        self,
        *,
        message_id: str,
        actor_id: str,
        emoji: str,
        active: bool = True,
        timestamp: str = "",
    ) -> bool:
        target = _normalise_id(message_id)
        actor = _normalise_id(actor_id)
        reaction_emoji = _normalise_text(emoji, 80)
        if not target or not actor or not reaction_emoji:
            return False
        existing = next(
            (
                item
                for item in self._reaction_relations
                if item.get("message_id") == target and item.get("emoji") == reaction_emoji
            ),
            None,
        )
        changed = False
        if existing is None and active:
            existing = {
                "message_id": target,
                "emoji": reaction_emoji,
                "actor_ids": [],
                "count": 0,
                "last_actor_id": "",
                "last_active": True,
                "last_seen_at": "",
            }
            self._reaction_relations.append(existing)
        if existing is None:
            return False
        actor_ids = [
            _normalise_id(value)
            for value in existing.get("actor_ids", [])
            if _normalise_id(value)
        ]
        actor_ids = list(dict.fromkeys(actor_ids))
        if active:
            if actor not in actor_ids:
                actor_ids.append(actor)
                changed = True
        elif actor in actor_ids:
            actor_ids.remove(actor)
            changed = True
        if not actor_ids:
            if existing in self._reaction_relations:
                self._reaction_relations.remove(existing)
            return changed
        existing["actor_ids"] = actor_ids
        existing["count"] = len(actor_ids)
        existing["last_actor_id"] = actor
        existing["last_active"] = bool(active)
        existing["last_seen_at"] = timestamp or _now_iso()
        self._reaction_relations = self._reaction_relations[-self.max_reaction_relations :]
        return changed

    def _update_reactions_from_message(self, message: Mapping[str, Any]) -> None:
        public_message_id = _normalise_id(message.get("message_id") or "")
        for item in self._reaction_items(message):
            if _fact_scope_is_private(item):
                continue
            target = _normalise_id(item.get("message_id") or public_message_id)
            if target != public_message_id and target not in self._observed_message_ids:
                continue
            self._upsert_reaction(
                message_id=target,
                actor_id=str(item.get("actor_id") or ""),
                emoji=str(item.get("emoji") or ""),
                active=bool(item.get("active", True)),
                timestamp=str(item.get("timestamp") or message.get("timestamp") or _now_iso()),
            )

    def record_public_reaction(
        self,
        message_id: str,
        actor_id: str,
        emoji: str,
        *,
        active: bool = True,
        source_message: Any = None,
        timestamp: str = "",
    ) -> bool:
        """Record one reaction on a message already admitted to this group.

        Reactions are actions, not feed messages, so a ``group_reaction`` event
        is intentionally not accepted by :func:`is_public_group_message`.
        The target must either have been observed as a public message or be
        supplied as an explicitly public ``source_message``.
        """

        target = _normalise_id(message_id)
        actor = _normalise_id(actor_id)
        reaction_emoji = _normalise_text(emoji, 80)
        active_value = _as_bool(active)
        if not target or not actor or not reaction_emoji or active_value is None:
            return False
        if source_message is not None:
            source_payload = self._merge_message(source_message, {})
            if not is_public_group_message(source_payload, group_id=self.group_id):
                return False
            source_id = _normalise_id(
                source_payload.get("message_id")
                or source_payload.get("event_id")
                or source_payload.get("id")
            )
            if source_id != target:
                return False
        with self._lock:
            if source_message is None and target not in self._observed_message_ids:
                return False
            changed = self._upsert_reaction(
                message_id=target,
                actor_id=actor,
                emoji=reaction_emoji,
                active=bool(active_value),
                timestamp=_normalise_text(timestamp, 80) or _now_iso(),
            )
        if changed and self.auto_persist:
            self.persist()
        return changed

    @staticmethod
    def _safe_json_value(value: Any, *, limit: int = DEFAULT_MAX_TEXT_CHARS) -> Any:
        if value is None or isinstance(value, (str, int, float, bool)):
            return _normalise_text(value, limit) if isinstance(value, str) else value
        if isinstance(value, Mapping):
            return {
                _normalise_text(key, 100): GroupSocialMemory._safe_json_value(item, limit=limit)
                for key, item in list(value.items())[:50]
            }
        if isinstance(value, (list, tuple, set)):
            return [GroupSocialMemory._safe_json_value(item, limit=limit) for item in list(value)[:50]]
        return _normalise_text(value, limit)

    @classmethod
    def _disagreement_items(cls, message: Mapping[str, Any]) -> list[dict[str, Any]]:
        values: list[Any] = []
        for key in ("disagreements", "disagreement"):
            for value in cls._field_values(message, key):
                if value is not None and value is not False:
                    values.extend(value if isinstance(value, list) else [value])
        out: list[dict[str, Any]] = []
        for value in values:
            if isinstance(value, Mapping):
                if _fact_scope_is_private(value):
                    continue
                item = dict(value)
            elif isinstance(value, str):
                item = {"topic": message.get("topic") or "", "summary": value}
            elif value is True:
                item = {"topic": message.get("topic") or "", "summary": message.get("content") or ""}
            else:
                continue
            topic = _normalise_text(item.get("topic") or item.get("topic_key") or message.get("topic") or "", 256)
            participants_raw = item.get("participants") or item.get("members") or item.get("member_ids") or []
            if isinstance(participants_raw, Mapping):
                participants = [_normalise_id(key) for key in participants_raw]
            elif isinstance(participants_raw, (list, tuple, set)):
                participants = [_normalise_id(participant) for participant in participants_raw if _normalise_id(participant)]
            else:
                participants = [_normalise_id(participants_raw)] if _normalise_id(participants_raw) else []
            positions = cls._safe_json_value(item.get("positions") or item.get("stances") or item.get("position") or {}, limit=300)
            summary = _normalise_text(item.get("summary") or item.get("description") or message.get("content") or "", DEFAULT_MAX_TEXT_CHARS)
            status = _normalise_key(item.get("status") or "open")
            out.append(
                {
                    "topic": topic,
                    "participants": participants,
                    "positions": positions,
                    "summary": summary,
                    "status": "resolved" if status in {"resolved", "closed", "done"} else "open",
                }
            )
        return out

    def _update_disagreements_from_message(self, message: Mapping[str, Any]) -> None:
        for item in self._disagreement_items(message):
            self._upsert_disagreement(item, source_message_id=str(message.get("message_id") or ""), timestamp=str(message.get("timestamp") or _now_iso()))

    def _upsert_disagreement(self, item: Mapping[str, Any], *, source_message_id: str = "", timestamp: str = "") -> bool:
        topic = _normalise_text(item.get("topic") or "", 256)
        participants = [_normalise_id(value) for value in item.get("participants", []) if _normalise_id(value)]
        if not topic and not participants:
            return False
        key = (_normalise_key(topic), tuple(sorted(set(participants))))
        existing = next(
            (row for row in self._disagreements if (_normalise_key(row.get("topic")), tuple(sorted(set(row.get("participants", []))))) == key),
            None,
        )
        if existing is None:
            existing = {
                "topic": topic,
                "participants": participants,
                "positions": self._safe_json_value(item.get("positions") or {}, limit=300),
                "summary": _normalise_text(item.get("summary") or "", DEFAULT_MAX_TEXT_CHARS),
                "status": "open",
                "count": 0,
                "source_message_ids": [],
                "last_seen_at": "",
            }
            self._disagreements.append(existing)
        existing["count"] = int(existing.get("count", 0) or 0) + 1
        if item.get("positions"):
            existing["positions"] = self._safe_json_value(item.get("positions"), limit=300)
        if item.get("summary"):
            existing["summary"] = _normalise_text(item.get("summary"), DEFAULT_MAX_TEXT_CHARS)
        if item.get("status") == "resolved":
            existing["status"] = "resolved"
        if source_message_id:
            ids = existing.setdefault("source_message_ids", [])
            ids.append(source_message_id)
            existing["source_message_ids"] = ids[-20:]
        existing["last_seen_at"] = timestamp or _now_iso()
        self._disagreements = self._disagreements[-self.max_disagreements :]
        return True

    def record_disagreement(
        self,
        disagreement: Mapping[str, Any] | str,
        *,
        source_message: Any = None,
        source_message_id: str = "",
    ) -> bool:
        """Add a structured disagreement known to come from public data.

        ``source_message`` is mandatory and must pass the same public-group
        gate as normal ingestion.  The structured fact is also checked for
        explicit private/direct markers.
        """

        if source_message is None or not is_public_group_message(source_message, group_id=self.group_id):
            return False
        fact = dict(disagreement) if isinstance(disagreement, Mapping) else {"summary": disagreement}
        if not self._fact_is_eligible(fact):
            return False
        if not is_public_group_message(
            {
                "content": fact.get("summary") or fact.get("topic") or "public disagreement",
                "group_id": fact.get("group_id", self.group_id),
                "is_private": fact.get("is_private", fact.get("private", False)),
                "is_public": fact.get("is_public", fact.get("public", True)),
                "scope": fact.get("scope", fact.get("visibility", "public")),
                "skipped": False,
            },
            group_id=self.group_id,
        ):
            return False
        with self._lock:
            changed = self._upsert_disagreement(
                fact,
                source_message_id=source_message_id or _normalise_id(_field(source_message, "message_id", "")),
            )
        if changed and self.auto_persist:
            self.persist()
        return changed

    @classmethod
    def _unresolved_items(cls, message: Mapping[str, Any]) -> list[dict[str, Any]]:
        values: list[Any] = []
        for key in ("unresolved_topics",):
            for value in cls._field_values(message, key):
                if value is not None and value is not False:
                    values.extend(value if isinstance(value, list) else [value])
        out: list[dict[str, Any]] = []
        for value in values:
            if isinstance(value, Mapping):
                if _fact_scope_is_private(value):
                    continue
                topic = value.get("topic") or value.get("key") or value.get("name") or ""
                description = value.get("description") or value.get("summary") or value.get("question") or ""
                status = _normalise_key(value.get("status") or "open")
                owner_id = value.get("owner_id") or value.get("assignee_id") or ""
                owner_name = value.get("owner_name") or value.get("assignee_name") or ""
            else:
                topic = value
                description = ""
                status = "open"
                owner_id = ""
                owner_name = ""
            topic = _normalise_text(topic, 256)
            if topic:
                out.append(
                    {
                        "topic": topic,
                        "description": _normalise_text(description, DEFAULT_MAX_TEXT_CHARS),
                        "status": "resolved" if status in {"resolved", "closed", "done"} else "open",
                        "owner_id": _normalise_id(owner_id),
                        "owner_name": _normalise_text(owner_name, 256),
                    }
                )
        return out

    @staticmethod
    def _field_values(message: Mapping[str, Any], name: str) -> list[Any]:
        """Read one explicitly supported field from the normalized message.

        Adapters may put publication metadata in ``metadata`` or
        ``event_data``.  We inspect those two containers only; arbitrary nested
        values (including session/history payloads) remain outside the memory
        boundary.
        """

        sources: list[Mapping[str, Any]] = [message]
        raw = message.get("raw")
        if isinstance(raw, Mapping) and raw is not message:
            sources.append(raw)
        values: list[Any] = []
        # Normalized fields shadow their raw counterparts.  Without this
        # guard, a field copied into the normalized envelope would be observed
        # twice and inflate counts.
        if name in message:
            values.append(message.get(name))
        elif isinstance(raw, Mapping) and name in raw:
            values.append(raw.get(name))
        for source in sources:
            for container_name in ("metadata", "event_data"):
                nested = source.get(container_name)
                if isinstance(nested, Mapping) and name in nested:
                    values.append(nested.get(name))
        return values

    @classmethod
    def _is_workflow_final(cls, message: Mapping[str, Any]) -> bool:
        for value in cls._field_values(message, "workflow_final"):
            if _as_bool(value) is True:
                return True
        source_values = cls._field_values(message, "publication_source") + cls._field_values(
            message, "group_publication_source"
        )
        if any(
            str(value or "").strip().casefold()
            in {"workflow_final_delivery", "workflow_final", "final_delivery"}
            for value in source_values
        ):
            return True
        event_values = cls._field_values(message, "workflow_event_type")
        return any(
            str(value or "").strip().casefold()
            in {"workflow_final_delivery", "workflow_final", "final_delivery"}
            for value in event_values
        )

    @classmethod
    def _explicit_resolution_topics(
        cls, message: Mapping[str, Any], *, group_id: str = ""
    ) -> list[str]:
        """Return topics closed by an explicit signal, never by reply text."""

        values: list[Any] = []
        for name in ("resolved_topics", "resolved_topic"):
            values.extend(cls._field_values(message, name))
        topics: list[str] = []

        def consume(value: Any) -> None:
            if isinstance(value, Mapping):
                if _fact_scope_is_private(value):
                    return
                nested_group_id = _normalise_id(value.get("group_id") or "")
                if group_id and nested_group_id and nested_group_id != _normalise_id(group_id):
                    return
                nested_topic = (
                    value.get("topic")
                    or value.get("topic_key")
                    or value.get("name")
                    or value.get("id")
                )
                if nested_topic:
                    topics.append(_normalise_text(nested_topic, 256))
                return
            if isinstance(value, (list, tuple, set)):
                for item in value:
                    consume(item)
                return
            if value not in (None, ""):
                topics.append(_normalise_text(value, 256))

        for value in values:
            consume(value)

        resolved_values = cls._field_values(message, "resolved")
        if any(_as_bool(value) is True for value in resolved_values):
            for topic, _owner_id, _owner_name in cls._topic_items(message, group_id=group_id):
                topics.append(topic)

        out: list[str] = []
        seen: set[str] = set()
        for topic in topics:
            normalized = _normalise_text(topic, 256)
            key = _normalise_key(normalized)
            if key and key not in seen:
                seen.add(key)
                out.append(normalized)
        return out

    def _update_unresolved_topics_from_message(self, message: Mapping[str, Any]) -> None:
        timestamp = str(message.get("timestamp") or _now_iso())
        source_id = str(message.get("message_id") or "")
        low_signal = _is_low_signal_unresolved_text(message.get("content", ""))
        resolution_signal = _has_explicit_resolution_text(message.get("content", ""))
        for item in self._unresolved_items(message):
            if item["status"] == "resolved":
                topic_key = _normalise_key(item["topic"])
                if topic_key in self._unresolved_topics:
                    self._unresolved_topics.pop(topic_key, None)
                    self._pending_unresolved_resolutions.add(topic_key)
                continue
            if low_signal or resolution_signal:
                continue
            self._upsert_unresolved_topic(item, source_message_id=source_id, timestamp=timestamp)
        # A normal assistant reply only carries ``topic`` and must leave the
        # existing open item untouched.  Removal is reserved for explicit
        # resolved fields or an explicitly marked workflow final delivery.
        resolution_topics = self._explicit_resolution_topics(message, group_id=self.group_id)
        if not resolution_topics and resolution_signal:
            content_key = _normalise_key(message.get("content", ""))
            resolution_topics = [
                str(item.get("topic") or topic_key)
                for topic_key, item in self._unresolved_topics.items()
                if topic_key in content_key
            ]
            if not resolution_topics and len(self._unresolved_topics) == 1:
                resolution_topics = list(self._unresolved_topics)
        if self._is_workflow_final(message) and not resolution_topics:
            # A final delivery may carry only the active topic.  If the
            # adapter omitted it, close the sole open item rather than
            # guessing that unrelated open work is complete.
            resolution_topics = [
                topic
                for topic, _owner_id, _owner_name in self._topic_items(message, group_id=self.group_id)
            ]
            if not resolution_topics and len(self._unresolved_topics) == 1:
                resolution_topics = list(self._unresolved_topics)
        for topic in resolution_topics:
            topic_key = _normalise_key(topic)
            if topic_key in self._unresolved_topics:
                self._unresolved_topics.pop(topic_key, None)
                self._pending_unresolved_resolutions.add(topic_key)

    def _upsert_unresolved_topic(self, item: Mapping[str, Any], *, source_message_id: str = "", timestamp: str = "") -> bool:
        topic = _normalise_text(item.get("topic") or "", 256)
        key = _normalise_key(topic)
        if not key:
            return False
        existing = self._unresolved_topics.setdefault(
            key,
            {
                "topic": topic,
                "description": "",
                "owner_id": "",
                "owner_name": "",
                "count": 0,
                "source_message_ids": [],
                "first_seen_at": timestamp or _now_iso(),
                "last_seen_at": "",
            },
        )
        existing["topic"] = topic
        if item.get("description"):
            existing["description"] = _normalise_text(item.get("description"), DEFAULT_MAX_TEXT_CHARS)
        if item.get("owner_id"):
            existing["owner_id"] = _normalise_id(item.get("owner_id"))
        if item.get("owner_name"):
            existing["owner_name"] = _normalise_text(item.get("owner_name"), 256)
        existing["count"] = int(existing.get("count", 0) or 0) + 1
        if source_message_id:
            ids = existing.setdefault("source_message_ids", [])
            ids.append(source_message_id)
            existing["source_message_ids"] = ids[-20:]
        existing["last_seen_at"] = timestamp or _now_iso()
        self._trim_state_map(self._unresolved_topics)
        return True

    def add_unresolved_topic(
        self,
        topic: str | Mapping[str, Any],
        *,
        source_message: Any = None,
        source_message_id: str = "",
    ) -> bool:
        if source_message is None or not is_public_group_message(source_message, group_id=self.group_id):
            return False
        item = dict(topic) if isinstance(topic, Mapping) else {"topic": topic}
        if not self._fact_is_eligible(item):
            return False
        with self._lock:
            changed = self._upsert_unresolved_topic(
                item,
                source_message_id=source_message_id or _normalise_id(_field(source_message, "message_id", "")),
                timestamp=_normalise_text(_field(source_message, "timestamp", ""), 80),
            )
        if changed and self.auto_persist:
            self.persist()
        return changed

    def resolve_topic(self, topic: str, *, source_message: Any = None) -> bool:
        if source_message is None or not is_public_group_message(source_message, group_id=self.group_id):
            return False
        with self._lock:
            topic_key = _normalise_key(topic)
            changed = self._unresolved_topics.pop(topic_key, None) is not None
            if changed:
                self._pending_unresolved_resolutions.add(topic_key)
        if changed and self.auto_persist:
            self.persist()
        return changed

    def record_style(self, style: Mapping[str, Any] | str, *, source_message: Any = None) -> bool:
        if source_message is None or not is_public_group_message(source_message, group_id=self.group_id):
            return False
        if isinstance(style, Mapping) and (
            not self._fact_is_eligible(style)
        ):
            return False
        if isinstance(style, str) and (_private_marker(style) or _private_source(style)):
            return False
        with self._lock:
            self._apply_style_labels(style)
        if self.auto_persist:
            self.persist()
        return True

    @staticmethod
    def _fact_is_private(value: Mapping[str, Any]) -> bool:
        """Reject an explicitly private structured fact before storing it."""
        return _fact_scope_is_private(value)

    def _fact_matches_group(self, value: Mapping[str, Any]) -> bool:
        containers: list[Mapping[str, Any]] = [value]
        for container_name in ("metadata", "event_data"):
            nested = value.get(container_name)
            if isinstance(nested, Mapping):
                containers.append(nested)
        for container in containers:
            for name in ("group_id", "group", "group_chat_id", "room_group_id"):
                raw = container.get(name)
                if isinstance(raw, (Mapping, list, tuple, set)):
                    continue
                if raw is not None and _normalise_id(raw) and _normalise_id(raw) != self.group_id:
                    return False
        return True

    def _fact_is_eligible(self, value: Mapping[str, Any]) -> bool:
        """Apply message-like scope checks to direct structured updates."""

        if self._fact_is_private(value) or not self._fact_matches_group(value):
            return False
        if _as_bool(value.get("skipped")) is True:
            return False
        event_type = str(value.get("event_type") or "").strip().casefold()
        if event_type in _NON_PUBLIC_EVENT_TYPES or event_type in _PRIVATE_VALUES:
            return False
        for name in ("action", "decision", "disposition"):
            if str(value.get(name) or "").strip().casefold() in _PASS_VALUES:
                return False
        return True

    # ------------------------------------------------------------------
    # Style extraction
    # ------------------------------------------------------------------
    @staticmethod
    def _emoji_count(text: str) -> int:
        return sum(any(start <= ord(char) <= end for start, end in _EMOJI_RANGES) for char in text)

    @staticmethod
    def _dominant_count(values: Mapping[str, Any]) -> str:
        if not values:
            return ""
        return max(values, key=lambda key: (int(values.get(key, 0) or 0), str(key)))

    def _apply_style_labels(
        self,
        style: Mapping[str, Any] | str,
        *,
        count_emoji_message: bool = True,
    ) -> None:
        if isinstance(style, Mapping):
            labels = {
                "tone": style.get("tone") or style.get("mood"),
                "verbosity": style.get("verbosity") or style.get("length"),
                "format": style.get("format") or style.get("message_format"),
            }
            explicit_emoji = _as_bool(style.get("uses_emoji", style.get("use_emoji", style.get("emoji"))))
        else:
            labels = {"tone": style, "verbosity": "", "format": ""}
            explicit_emoji = None
        for key, value in labels.items():
            label = _normalise_text(value, 80)
            if label:
                counts = self._style_profile.setdefault(f"{key}_counts", {})
                counts[label] = int(counts.get(label, 0) or 0) + 1
        if explicit_emoji is True and count_emoji_message:
            self._style_profile["emoji_message_count"] = int(self._style_profile.get("emoji_message_count", 0) or 0) + 1
        self._style_profile["preferred_tone"] = self._dominant_count(self._style_profile.get("tone_counts", {}))
        self._style_profile["preferred_verbosity"] = self._dominant_count(self._style_profile.get("verbosity_counts", {}))
        self._style_profile["preferred_format"] = self._dominant_count(self._style_profile.get("format_counts", {}))
        self._style_profile["uses_emoji"] = bool(self._style_profile.get("emoji_count", 0) or self._style_profile.get("emoji_message_count", 0))

    def _update_style(self, message: Mapping[str, Any]) -> None:
        text = str(message.get("content") or "")
        profile = self._style_profile
        old_count = int(profile.get("message_count", 0) or 0)
        new_count = old_count + 1
        length = len(text)
        profile["message_count"] = new_count
        profile["avg_chars"] = ((float(profile.get("avg_chars", 0.0) or 0.0) * old_count) + length) / new_count
        if length <= 120:
            profile["short_message_ratio"] = (
                (float(profile.get("short_message_ratio", 0.0) or 0.0) * old_count) + 1
            ) / new_count
            verbosity = "short"
        elif length <= 500:
            profile["short_message_ratio"] = (
                float(profile.get("short_message_ratio", 0.0) or 0.0) * old_count
            ) / new_count
            verbosity = "medium"
        else:
            profile["short_message_ratio"] = (
                float(profile.get("short_message_ratio", 0.0) or 0.0) * old_count
            ) / new_count
            verbosity = "long"
        emoji_count = self._emoji_count(text)
        profile["emoji_count"] = int(profile.get("emoji_count", 0) or 0) + emoji_count
        if emoji_count:
            profile["emoji_message_count"] = int(profile.get("emoji_message_count", 0) or 0) + 1
        profile.setdefault("verbosity_counts", {})[verbosity] = int(profile["verbosity_counts"].get(verbosity, 0) or 0) + 1
        style = message.get("raw")
        if isinstance(style, Mapping):
            nested_style = style.get("style")
            raw_style = (
                nested_style
                if isinstance(nested_style, Mapping) and not _fact_scope_is_private(nested_style)
                else style
            )
            if isinstance(nested_style, Mapping) and _fact_scope_is_private(nested_style):
                raw_style = {}
            self._apply_style_labels(
                raw_style
                or {
                    "tone": style.get("tone"),
                    "verbosity": style.get("verbosity"),
                    "format": style.get("format"),
                    "uses_emoji": style.get("uses_emoji", style.get("use_emoji")),
                },
                count_emoji_message=False,
            )
            explicit_emoji = _as_bool(
                raw_style.get("uses_emoji", raw_style.get("use_emoji", raw_style.get("emoji")))
                if isinstance(raw_style, Mapping)
                else None
            )
            if explicit_emoji is True and not emoji_count:
                profile["emoji_message_count"] = int(profile.get("emoji_message_count", 0) or 0) + 1
        profile["preferred_verbosity"] = self._dominant_count(profile.get("verbosity_counts", {}))
        profile["preferred_tone"] = self._dominant_count(profile.get("tone_counts", {}))
        profile["preferred_format"] = self._dominant_count(profile.get("format_counts", {}))
        profile["uses_emoji"] = bool(profile.get("emoji_count", 0) or profile.get("emoji_message_count", 0))
        profile["last_updated_at"] = str(message.get("timestamp") or _now_iso())

    # ------------------------------------------------------------------
    # Persistence and rendering
    # ------------------------------------------------------------------
    def _snapshot_unlocked(self) -> dict[str, Any]:
        return {
            "schema_version": SCHEMA_VERSION,
            "group_id": self.group_id,
            "addressing_habits": copy.deepcopy(self._addressing_habits),
            "topic_owners": copy.deepcopy(self._topic_owners),
            "topic_history": copy.deepcopy(self._topic_history[-self.max_topic_history :]),
            "disagreements": copy.deepcopy(self._disagreements[-self.max_disagreements :]),
            "reply_relations": copy.deepcopy(self._reply_relations[-self.max_reply_relations :]),
            "reaction_relations": copy.deepcopy(
                self._reaction_relations[-self.max_reaction_relations :]
            ),
            "style_profile": copy.deepcopy(self._style_profile),
            "unresolved_topics": copy.deepcopy(self._unresolved_topics),
            "observed_message_ids": list(self._observed_message_ids[-self.max_message_ids :]),
        }

    def _empty_snapshot(self) -> dict[str, Any]:
        """Return an empty, schema-complete snapshot for this configuration."""

        return {
            "schema_version": SCHEMA_VERSION,
            "group_id": self.group_id,
            "addressing_habits": {},
            "topic_owners": {},
            "topic_history": [],
            "disagreements": [],
            "reply_relations": [],
            "reaction_relations": [],
            "style_profile": self._empty_style_profile(),
            "unresolved_topics": {},
            "observed_message_ids": [],
        }

    @classmethod
    def _canonical_storage_path(cls, path: Path) -> str:
        """Return a stable in-process lock key for a storage path."""

        try:
            return str(path.expanduser().resolve(strict=False))
        except (OSError, RuntimeError):
            # ``absolute`` does not require the path to exist and is a useful
            # fallback for unusual filesystems or a concurrently removed cwd.
            return str(path.expanduser().absolute())

    @classmethod
    def _persistence_lock(cls, group_id: str, path: Path) -> threading.RLock:
        key = (_normalise_id(group_id), cls._canonical_storage_path(path))
        with cls._PERSIST_LOCKS_GUARD:
            lock = cls._PERSIST_LOCKS.get(key)
            if lock is None:
                lock = threading.RLock()
                cls._PERSIST_LOCKS[key] = lock
            return lock

    @staticmethod
    @contextmanager
    def _cross_process_lock(path: Path):
        """Lock a sidecar file when the platform provides ``fcntl``.

        The dependency is part of the POSIX standard library, so this keeps
        separate worker processes from interleaving the read/merge/write
        transaction without adding a third-party lock package.  On platforms
        without ``fcntl`` the in-process lock still protects the supported
        runtime, and ``atomic_write_json`` continues to provide atomic replace.
        """

        lock_path = path.with_name(f"{path.name}.lock")
        lock_path.parent.mkdir(parents=True, exist_ok=True)
        with lock_path.open("a+") as handle:
            try:
                import fcntl  # POSIX only
            except ImportError:
                yield
                return
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)

    @staticmethod
    def _nonnegative_int(value: Any) -> int:
        if isinstance(value, bool):
            return 0
        try:
            number = int(value or 0)
        except (TypeError, ValueError, OverflowError):
            return 0
        return max(number, 0)

    @classmethod
    def _sequence_delta(cls, current: Any, baseline: Any) -> list[str]:
        """Return values newly appended to one bounded id sequence."""

        current_values = current if isinstance(current, list) else []
        baseline_values = baseline if isinstance(baseline, list) else []
        remaining: dict[str, int] = {}
        for value in baseline_values:
            normalized = _normalise_id(value)
            if normalized:
                remaining[normalized] = remaining.get(normalized, 0) + 1
        delta: list[str] = []
        for value in current_values:
            normalized = _normalise_id(value)
            if not normalized:
                continue
            count = remaining.get(normalized, 0)
            if count:
                remaining[normalized] = count - 1
            else:
                delta.append(normalized)
        return delta

    @staticmethod
    def _item_identity(item: Any, *, kind: str = "") -> str:
        if isinstance(item, Mapping):
            message_id = _normalise_id(item.get("message_id") or "")
            if message_id and kind == "topic":
                return f"topic:{message_id}:{_normalise_key(item.get('topic_key') or item.get('topic') or '')}"
            if message_id and kind == "reply":
                return f"reply:{message_id}"
            if message_id and kind == "disagreement":
                return f"disagreement:{message_id}"
            try:
                return json.dumps(
                    item,
                    ensure_ascii=False,
                    sort_keys=True,
                    separators=(",", ":"),
                    default=str,
                )
            except (TypeError, ValueError):
                return repr(item)
        return repr(item)

    @classmethod
    def _merge_topic_history(
        cls,
        latest: Any,
        local: Any,
        baseline: Any,
        limit: int,
    ) -> list[dict[str, Any]]:
        latest_values = [item for item in latest if isinstance(item, Mapping)] if isinstance(latest, list) else []
        local_values = [item for item in local if isinstance(item, Mapping)] if isinstance(local, list) else []
        baseline_values = [item for item in baseline if isinstance(item, Mapping)] if isinstance(baseline, list) else []
        pending = cls._pending_list_items(local_values, baseline_values, kind="topic")
        output = copy.deepcopy(latest_values)
        seen = {cls._item_identity(item, kind="topic") for item in output}
        for item in pending:
            identity = cls._item_identity(item, kind="topic")
            if identity not in seen:
                output.append(copy.deepcopy(item))
                seen.add(identity)
        return output[-limit:]

    @classmethod
    def _pending_list_items(
        cls,
        current: list[Mapping[str, Any]],
        baseline: list[Mapping[str, Any]],
        *,
        kind: str = "",
    ) -> list[Mapping[str, Any]]:
        remaining: dict[str, int] = {}
        for item in baseline:
            identity = cls._item_identity(item, kind=kind)
            remaining[identity] = remaining.get(identity, 0) + 1
        pending: list[Mapping[str, Any]] = []
        for item in current:
            identity = cls._item_identity(item, kind=kind)
            count = remaining.get(identity, 0)
            if count:
                remaining[identity] = count - 1
            else:
                pending.append(item)
        return pending

    @classmethod
    def _merge_latest_fields(
        cls,
        target: dict[str, Any],
        candidate: Mapping[str, Any],
        fields: tuple[str, ...],
        *,
        timestamp_fields: tuple[str, ...] = ("last_seen_at", "last_updated_at"),
    ) -> None:
        """Copy latest descriptive fields when the candidate is newer."""

        candidate_time = max(
            (str(candidate.get(field) or "") for field in timestamp_fields),
            default="",
        )
        target_time = max(
            (str(target.get(field) or "") for field in timestamp_fields),
            default="",
        )
        if candidate_time and target_time and candidate_time < target_time:
            return
        for field in fields:
            if field in candidate:
                target[field] = copy.deepcopy(candidate[field])

    def _merge_addressing(
        self,
        latest: Any,
        local: Any,
        baseline: Any,
    ) -> dict[str, dict[str, Any]]:
        output = copy.deepcopy(latest) if isinstance(latest, Mapping) else {}
        local_values = local if isinstance(local, Mapping) else {}
        baseline_values = baseline if isinstance(baseline, Mapping) else {}
        for member_id, value in local_values.items():
            if not isinstance(value, Mapping):
                continue
            key = _normalise_id(member_id)
            if not key:
                continue
            old = baseline_values.get(member_id, baseline_values.get(key, {}))
            old = old if isinstance(old, Mapping) else {}
            local_labels = value.get("labels") if isinstance(value.get("labels"), Mapping) else {}
            old_labels = old.get("labels") if isinstance(old.get("labels"), Mapping) else {}
            label_delta: dict[str, int] = {}
            for label, count in local_labels.items():
                label_key = _normalise_text(label, 256)
                delta = self._nonnegative_int(count) - self._nonnegative_int(old_labels.get(label))
                if label_key and delta > 0:
                    label_delta[label_key] = delta
            count_delta = self._nonnegative_int(value.get("count")) - self._nonnegative_int(old.get("count"))
            if member_id not in baseline_values and key not in baseline_values:
                count_delta = max(self._nonnegative_int(value.get("count")), sum(label_delta.values()))
            count_delta = max(count_delta, sum(label_delta.values()))
            if count_delta <= 0:
                continue
            target = output.get(key)
            if not isinstance(target, Mapping):
                target = copy.deepcopy(dict(value))
                # ``value`` represents the complete local state, while the
                # merged target starts empty.  Seed metadata only; counters
                # below are applied from the computed local delta exactly
                # once.
                target["labels"] = {}
                target["count"] = 0
                output[key] = target
            else:
                target = dict(target)
                output[key] = target
            target_labels = target.get("labels") if isinstance(target.get("labels"), Mapping) else {}
            merged_labels = {
                _normalise_text(label, 256): self._nonnegative_int(count)
                for label, count in target_labels.items()
                if _normalise_text(label, 256)
            }
            for label, delta in label_delta.items():
                merged_labels[label] = merged_labels.get(label, 0) + delta
            target["labels"] = merged_labels
            target["count"] = self._nonnegative_int(target.get("count")) + count_delta
            self._merge_latest_fields(
                target,
                value,
                ("member_id", "member_name", "last_used_turn_id", "last_seen_at"),
            )
            if merged_labels:
                target["preferred_label"] = max(
                    merged_labels,
                    key=lambda candidate: (
                        self._nonnegative_int(merged_labels.get(candidate)),
                        candidate == value.get("preferred_label"),
                        candidate,
                    ),
                )
        self._trim_state_map(output)
        return output

    def _merge_topic_owners(
        self,
        latest: Any,
        local: Any,
        baseline: Any,
    ) -> dict[str, dict[str, Any]]:
        output = copy.deepcopy(latest) if isinstance(latest, Mapping) else {}
        local_values = local if isinstance(local, Mapping) else {}
        baseline_values = baseline if isinstance(baseline, Mapping) else {}
        for topic, value in local_values.items():
            if not isinstance(value, Mapping):
                continue
            key = _normalise_key(topic)
            if not key:
                continue
            old = baseline_values.get(topic, baseline_values.get(key, {}))
            old = old if isinstance(old, Mapping) else {}
            count_delta = self._nonnegative_int(value.get("count")) - self._nonnegative_int(old.get("count"))
            if topic not in baseline_values and key not in baseline_values:
                count_delta = self._nonnegative_int(value.get("count"))
            if count_delta <= 0:
                continue
            target = output.get(key)
            if not isinstance(target, Mapping):
                target = copy.deepcopy(dict(value))
                target["count"] = count_delta
                output[key] = target
            else:
                target = dict(target)
                output[key] = target
                target["count"] = self._nonnegative_int(target.get("count")) + count_delta
                self._merge_latest_fields(
                    target,
                    value,
                    ("topic", "owner_id", "owner_name", "last_message_id", "last_seen_at"),
                )
        self._trim_state_map(output)
        return output

    @staticmethod
    def _reply_key(value: Mapping[str, Any]) -> tuple[str, str]:
        source = _normalise_id(value.get("from_agent_id") or "")
        target = _normalise_id(value.get("target_key") or "")
        if not target:
            target = _normalise_id(value.get("to_message_id") or "") or (
                f"agent:{_normalise_id(value.get('to_agent_id') or '')}"
            )
        return source, target

    def _merge_reply_relations(
        self,
        latest: Any,
        local: Any,
        baseline: Any,
    ) -> list[dict[str, Any]]:
        latest_values = [dict(item) for item in latest if isinstance(item, Mapping)] if isinstance(latest, list) else []
        local_values = [item for item in local if isinstance(item, Mapping)] if isinstance(local, list) else []
        baseline_values = [item for item in baseline if isinstance(item, Mapping)] if isinstance(baseline, list) else []
        baseline_by_key = {self._reply_key(item): item for item in baseline_values}
        output_by_key = {self._reply_key(item): item for item in latest_values}
        output_order = [self._reply_key(item) for item in latest_values]
        for value in local_values:
            key = self._reply_key(value)
            if not key[0] or not key[1]:
                continue
            old = baseline_by_key.get(key, {})
            old_count = self._nonnegative_int(old.get("count"))
            local_count = self._nonnegative_int(value.get("count"))
            count_delta = max(0, local_count - old_count)
            if key not in baseline_by_key:
                count_delta = local_count
            pending_ids = self._sequence_delta(value.get("message_ids"), old.get("message_ids"))
            target = output_by_key.get(key)
            target_ids = target.get("message_ids", []) if isinstance(target, Mapping) else []
            target_id_set = {
                _normalise_id(item) for item in target_ids if _normalise_id(item)
            }
            new_ids = [item for item in pending_ids if item not in target_id_set]
            effective_delta = len(new_ids) + max(0, count_delta - len(pending_ids))
            if effective_delta <= 0:
                continue
            if target is None:
                target = copy.deepcopy(dict(value))
                target["count"] = effective_delta
                output_by_key[key] = target
                output_order.append(key)
            else:
                target = dict(target)
                output_by_key[key] = target
                target["count"] = self._nonnegative_int(target.get("count")) + effective_delta
                merged_ids = [
                    _normalise_id(item)
                    for item in target.get("message_ids", [])
                    if _normalise_id(item)
                ]
                for item in new_ids:
                    if item not in merged_ids:
                        merged_ids.append(item)
                target["message_ids"] = merged_ids[-20:]
                self._merge_latest_fields(
                    target,
                    value,
                    (
                        "from_agent_id",
                        "from_agent_name",
                        "to_message_id",
                        "to_agent_id",
                        "target_key",
                        "last_message_id",
                        "last_seen_at",
                    ),
                )
        return [output_by_key[key] for key in output_order if key in output_by_key][-self.max_reply_relations :]

    @staticmethod
    def _disagreement_key(value: Mapping[str, Any]) -> tuple[str, tuple[str, ...]]:
        topic = _normalise_key(value.get("topic") or "")
        participants = tuple(
            sorted(
                {
                    _normalise_id(item)
                    for item in value.get("participants", [])
                    if _normalise_id(item)
                }
            )
        )
        return topic, participants

    def _merge_disagreements(
        self,
        latest: Any,
        local: Any,
        baseline: Any,
    ) -> list[dict[str, Any]]:
        latest_values = [dict(item) for item in latest if isinstance(item, Mapping)] if isinstance(latest, list) else []
        local_values = [item for item in local if isinstance(item, Mapping)] if isinstance(local, list) else []
        baseline_values = [item for item in baseline if isinstance(item, Mapping)] if isinstance(baseline, list) else []
        baseline_by_key = {self._disagreement_key(item): item for item in baseline_values}
        output_by_key = {self._disagreement_key(item): item for item in latest_values}
        output_order = [self._disagreement_key(item) for item in latest_values]
        for value in local_values:
            key = self._disagreement_key(value)
            old = baseline_by_key.get(key, {})
            old_count = self._nonnegative_int(old.get("count"))
            local_count = self._nonnegative_int(value.get("count"))
            count_delta = max(0, local_count - old_count)
            if key not in baseline_by_key:
                count_delta = local_count
            pending_ids = self._sequence_delta(value.get("source_message_ids"), old.get("source_message_ids"))
            target = output_by_key.get(key)
            target_ids = target.get("source_message_ids", []) if isinstance(target, Mapping) else []
            target_id_set = {_normalise_id(item) for item in target_ids if _normalise_id(item)}
            new_ids = [item for item in pending_ids if item not in target_id_set]
            effective_delta = len(new_ids) + max(0, count_delta - len(pending_ids))
            if effective_delta <= 0:
                continue
            if target is None:
                target = copy.deepcopy(dict(value))
                target["count"] = effective_delta
                output_by_key[key] = target
                output_order.append(key)
            else:
                target = dict(target)
                output_by_key[key] = target
                target["count"] = self._nonnegative_int(target.get("count")) + effective_delta
                merged_ids = [
                    _normalise_id(item)
                    for item in target.get("source_message_ids", [])
                    if _normalise_id(item)
                ]
                for item in new_ids:
                    if item not in merged_ids:
                        merged_ids.append(item)
                target["source_message_ids"] = merged_ids[-20:]
                self._merge_latest_fields(
                    target,
                    value,
                    ("topic", "participants", "positions", "summary", "status", "last_seen_at"),
                )
        return [output_by_key[key] for key in output_order if key in output_by_key][-self.max_disagreements :]

    def _merge_reactions(
        self,
        latest: Any,
        local: Any,
        baseline: Any,
    ) -> list[dict[str, Any]]:
        def key(value: Mapping[str, Any]) -> tuple[str, str]:
            return (_normalise_id(value.get("message_id") or ""), _normalise_text(value.get("emoji") or "", 80))

        def actor_list(value: Any) -> list[str]:
            raw = value.get("actor_ids", []) if isinstance(value, Mapping) else []
            if not isinstance(raw, list):
                return []
            return list(dict.fromkeys(_normalise_id(item) for item in raw if _normalise_id(item)))

        def actors(value: Any) -> set[str]:
            return set(actor_list(value))

        latest_values = [dict(item) for item in latest if isinstance(item, Mapping)] if isinstance(latest, list) else []
        local_values = [item for item in local if isinstance(item, Mapping)] if isinstance(local, list) else []
        baseline_values = [item for item in baseline if isinstance(item, Mapping)] if isinstance(baseline, list) else []
        latest_by_key = {key(item): item for item in latest_values}
        baseline_by_key = {key(item): item for item in baseline_values}
        order = [key(item) for item in latest_values]
        local_by_key = {key(item): item for item in local_values}
        # Include keys omitted from the local bounded snapshot so an explicit
        # removal (e.g. toggling the last actor off) can be applied to disk.
        for reaction_key in list(baseline_by_key):
            if reaction_key not in local_by_key:
                local_by_key[reaction_key] = {}
        for reaction_key, value in local_by_key.items():
            if not reaction_key[0] or not reaction_key[1]:
                continue
            old = baseline_by_key.get(reaction_key)
            old_actors = actors(old)
            local_actors = actors(value)
            added = local_actors - old_actors
            removed = old_actors - local_actors
            if old is None:
                added = local_actors
            elif not value:
                removed = old_actors
            if not added and not removed:
                continue
            target = latest_by_key.get(reaction_key)
            target_actor_list = actor_list(target)
            target_actor_list = [item for item in target_actor_list if item not in removed]
            target_actor_set = set(target_actor_list)
            for item in actor_list(value):
                if item in added and item not in target_actor_set:
                    target_actor_list.append(item)
                    target_actor_set.add(item)
            if not target_actor_list:
                latest_by_key.pop(reaction_key, None)
                continue
            if target is None:
                target = copy.deepcopy(dict(value))
                latest_by_key[reaction_key] = target
                order.append(reaction_key)
            else:
                target = dict(target)
                latest_by_key[reaction_key] = target
            target["actor_ids"] = target_actor_list
            target["count"] = len(target["actor_ids"])
            self._merge_latest_fields(
                target,
                value,
                ("message_id", "emoji", "last_actor_id", "last_active", "last_seen_at"),
            )
        return [latest_by_key[item] for item in order if item in latest_by_key][-self.max_reaction_relations :]

    def _merge_unresolved(
        self,
        latest: Any,
        local: Any,
        baseline: Any,
    ) -> dict[str, dict[str, Any]]:
        output = copy.deepcopy(latest) if isinstance(latest, Mapping) else {}
        local_values = local if isinstance(local, Mapping) else {}
        baseline_values = baseline if isinstance(baseline, Mapping) else {}
        # Apply explicit resolutions first.  A concurrent reopen increments its
        # count beyond the baseline and is retained below.
        for topic in self._pending_unresolved_resolutions:
            old = baseline_values.get(topic)
            current = output.get(topic)
            old_count = self._nonnegative_int(old.get("count")) if isinstance(old, Mapping) else 0
            current_count = self._nonnegative_int(current.get("count")) if isinstance(current, Mapping) else 0
            if current is not None and current_count <= old_count:
                output.pop(topic, None)
        for topic, value in local_values.items():
            if not isinstance(value, Mapping):
                continue
            key = _normalise_key(topic)
            if not key:
                continue
            old = baseline_values.get(topic, baseline_values.get(key, {}))
            old = old if isinstance(old, Mapping) else {}
            count_delta = self._nonnegative_int(value.get("count")) - self._nonnegative_int(old.get("count"))
            if topic not in baseline_values and key not in baseline_values:
                count_delta = self._nonnegative_int(value.get("count"))
            if count_delta <= 0:
                continue
            target = output.get(key)
            if not isinstance(target, Mapping):
                target = copy.deepcopy(dict(value))
                target["count"] = count_delta
                output[key] = target
            else:
                target = dict(target)
                output[key] = target
                target["count"] = self._nonnegative_int(target.get("count")) + count_delta
                source_ids = [
                    _normalise_id(item)
                    for item in target.get("source_message_ids", [])
                    if _normalise_id(item)
                ]
                for item in self._sequence_delta(value.get("source_message_ids"), old.get("source_message_ids")):
                    if item not in source_ids:
                        source_ids.append(item)
                target["source_message_ids"] = source_ids[-20:]
                self._merge_latest_fields(
                    target,
                    value,
                    (
                        "topic",
                        "description",
                        "owner_id",
                        "owner_name",
                        "first_seen_at",
                        "last_seen_at",
                    ),
                )
        self._trim_state_map(output)
        return output

    def _merge_style(
        self,
        latest: Any,
        local: Any,
        baseline: Any,
    ) -> dict[str, Any]:
        output = self._empty_style_profile()
        if isinstance(latest, Mapping):
            output.update(copy.deepcopy(dict(latest)))
        local_values = local if isinstance(local, Mapping) else {}
        baseline_values = baseline if isinstance(baseline, Mapping) else {}
        local_count = self._nonnegative_int(local_values.get("message_count"))
        baseline_count = self._nonnegative_int(baseline_values.get("message_count"))
        count_delta = max(0, local_count - baseline_count)
        if not baseline_values:
            count_delta = local_count
        latest_count = self._nonnegative_int(output.get("message_count"))
        latest_avg = float(output.get("avg_chars", 0.0) or 0.0)
        latest_short = float(output.get("short_message_ratio", 0.0) or 0.0)
        if count_delta:
            local_avg = float(local_values.get("avg_chars", 0.0) or 0.0)
            baseline_avg = float(baseline_values.get("avg_chars", 0.0) or 0.0)
            local_short = float(local_values.get("short_message_ratio", 0.0) or 0.0)
            baseline_short = float(baseline_values.get("short_message_ratio", 0.0) or 0.0)
            added_chars = local_avg * local_count - baseline_avg * baseline_count
            added_short = local_short * local_count - baseline_short * baseline_count
            output_count = latest_count + count_delta
            output["message_count"] = output_count
            output["avg_chars"] = ((latest_avg * latest_count) + added_chars) / output_count if output_count else 0.0
            output["short_message_ratio"] = (
                ((latest_short * latest_count) + added_short) / output_count if output_count else 0.0
            )
        else:
            output["message_count"] = latest_count
            output["avg_chars"] = latest_avg
            output["short_message_ratio"] = latest_short
        for name in ("emoji_message_count", "emoji_count"):
            local_value = self._nonnegative_int(local_values.get(name))
            baseline_value = self._nonnegative_int(baseline_values.get(name))
            delta = max(0, local_value - baseline_value)
            if not baseline_values:
                delta = local_value
            output[name] = self._nonnegative_int(output.get(name)) + delta
        for name in ("tone_counts", "verbosity_counts", "format_counts"):
            target_counts = output.get(name) if isinstance(output.get(name), Mapping) else {}
            merged_counts = {
                str(label): self._nonnegative_int(count)
                for label, count in target_counts.items()
                if str(label).strip()
            }
            local_counts = local_values.get(name) if isinstance(local_values.get(name), Mapping) else {}
            baseline_counts = baseline_values.get(name) if isinstance(baseline_values.get(name), Mapping) else {}
            for label, count in local_counts.items():
                label_key = str(label)
                delta = self._nonnegative_int(count) - self._nonnegative_int(baseline_counts.get(label))
                if not baseline_values:
                    delta = self._nonnegative_int(count)
                if label_key.strip() and delta > 0:
                    merged_counts[label_key] = merged_counts.get(label_key, 0) + delta
            output[name] = merged_counts
        output["preferred_tone"] = self._dominant_count(output.get("tone_counts", {}))
        output["preferred_verbosity"] = self._dominant_count(output.get("verbosity_counts", {}))
        output["preferred_format"] = self._dominant_count(output.get("format_counts", {}))
        output["uses_emoji"] = bool(output.get("emoji_count", 0) or output.get("emoji_message_count", 0))
        local_last = str(local_values.get("last_updated_at") or "")
        baseline_last = str(baseline_values.get("last_updated_at") or "")
        if local_last and local_last != baseline_last:
            current_last = str(output.get("last_updated_at") or "")
            output["last_updated_at"] = max(current_last, local_last)
        return output

    def _merge_snapshots(
        self,
        latest: Mapping[str, Any],
        local: Mapping[str, Any],
        baseline: Mapping[str, Any],
    ) -> dict[str, Any]:
        """Apply this instance's changes to the latest durable snapshot."""

        return {
            "schema_version": SCHEMA_VERSION,
            "group_id": self.group_id,
            "addressing_habits": self._merge_addressing(
                latest.get("addressing_habits"),
                local.get("addressing_habits"),
                baseline.get("addressing_habits"),
            ),
            "topic_owners": self._merge_topic_owners(
                latest.get("topic_owners"),
                local.get("topic_owners"),
                baseline.get("topic_owners"),
            ),
            "topic_history": self._merge_topic_history(
                latest.get("topic_history"),
                local.get("topic_history"),
                baseline.get("topic_history"),
                self.max_topic_history,
            ),
            "disagreements": self._merge_disagreements(
                latest.get("disagreements"),
                local.get("disagreements"),
                baseline.get("disagreements"),
            ),
            "reply_relations": self._merge_reply_relations(
                latest.get("reply_relations"),
                local.get("reply_relations"),
                baseline.get("reply_relations"),
            ),
            "reaction_relations": self._merge_reactions(
                latest.get("reaction_relations"),
                local.get("reaction_relations"),
                baseline.get("reaction_relations"),
            ),
            "style_profile": self._merge_style(
                latest.get("style_profile"),
                local.get("style_profile"),
                baseline.get("style_profile"),
            ),
            "unresolved_topics": self._merge_unresolved(
                latest.get("unresolved_topics"),
                local.get("unresolved_topics"),
                baseline.get("unresolved_topics"),
            ),
            "observed_message_ids": list(
                dict.fromkeys(
                    [
                        _normalise_id(item)
                        for item in (latest.get("observed_message_ids") or [])
                        if _normalise_id(item)
                    ]
                    + [
                        _normalise_id(item)
                        for item in self._sequence_delta(
                            local.get("observed_message_ids"),
                            baseline.get("observed_message_ids"),
                        )
                        if _normalise_id(item)
                    ]
                )
            )[-self.max_message_ids :],
        }

    def _read_valid_snapshot(self, path: Path) -> dict[str, Any] | None:
        """Read and normalize a durable snapshot while a storage lock is held."""

        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError, TypeError):
            return None
        if not isinstance(raw, Mapping):
            return None
        if _normalise_id(raw.get("group_id")) != self.group_id:
            return None
        version = raw.get("schema_version", SCHEMA_VERSION)
        if isinstance(version, bool) or not isinstance(version, int) or version < 1 or version > SCHEMA_VERSION:
            return None
        state = self._state_from_payload(raw)
        if state is None:
            return None
        temporary = self._empty_snapshot()
        (
            temporary["addressing_habits"],
            temporary["topic_owners"],
            temporary["topic_history"],
            temporary["disagreements"],
            temporary["reply_relations"],
            temporary["reaction_relations"],
            temporary["style_profile"],
            temporary["unresolved_topics"],
            temporary["observed_message_ids"],
        ) = copy.deepcopy(state)
        # Apply the same configured bounds as ``load`` before merging.
        for name, limit in (
            ("topic_history", self.max_topic_history),
            ("disagreements", self.max_disagreements),
            ("reply_relations", self.max_reply_relations),
            ("reaction_relations", self.max_reaction_relations),
            ("observed_message_ids", self.max_message_ids),
        ):
            temporary[name] = temporary[name][-limit:]
        self._trim_state_map(temporary["addressing_habits"])
        self._trim_state_map(temporary["topic_owners"])
        self._trim_state_map(temporary["unresolved_topics"])
        return temporary

    def _apply_state_unlocked(self, state: tuple[Any, ...]) -> None:
        (
            self._addressing_habits,
            self._topic_owners,
            self._topic_history,
            self._disagreements,
            self._reply_relations,
            self._reaction_relations,
            self._style_profile,
            self._unresolved_topics,
            self._observed_message_ids,
        ) = copy.deepcopy(state)
        self._topic_history = self._topic_history[-self.max_topic_history :]
        self._disagreements = self._disagreements[-self.max_disagreements :]
        self._reply_relations = self._reply_relations[-self.max_reply_relations :]
        self._reaction_relations = self._reaction_relations[-self.max_reaction_relations :]
        self._observed_message_ids = self._observed_message_ids[-self.max_message_ids :]
        self._trim_state_map(self._addressing_habits)
        self._trim_state_map(self._topic_owners)
        self._trim_state_map(self._unresolved_topics)

    def to_dict(self) -> dict[str, Any]:
        with self._lock:
            return self._snapshot_unlocked()

    def persist(self, path: str | Path | None = None) -> Path:
        target = Path(path).expanduser() if path is not None else self._storage_path
        target_key = self._canonical_storage_path(target)
        process_lock = self._persistence_lock(self.group_id, target)
        with process_lock:
            with self._cross_process_lock(target):
                # Hold the instance lock for the complete transaction.  This
                # prevents a same-instance mutation from landing between the
                # local snapshot and the baseline update below.
                with self._lock:
                    local = self._snapshot_unlocked()
                    baseline = copy.deepcopy(
                        self._persisted_snapshots.get(target_key) or self._empty_snapshot()
                    )
                    latest = self._read_valid_snapshot(target) or self._empty_snapshot()
                    payload = self._merge_snapshots(latest, local, baseline)
                    atomic_write_json(target, payload)
                    state = self._state_from_payload(payload)
                    if state is None:  # pragma: no cover - defensive invariant
                        raise ValueError("merged social memory snapshot is invalid")
                    self._apply_state_unlocked(state)
                    self._persisted_snapshots[target_key] = self._snapshot_unlocked()
                    self._pending_unresolved_resolutions.clear()
                    if path is not None:
                        self._storage_path = target
        return target

    def load(self, path: str | Path | None = None) -> bool:
        """Restore a matching snapshot into this instance.

        Missing, malformed, or cross-group files are rejected without changing
        the current in-memory state.  This makes a stale file safe to retry.
        """

        candidate_path = Path(path).expanduser() if path is not None else self._storage_path
        target_key = self._canonical_storage_path(candidate_path)
        process_lock = self._persistence_lock(self.group_id, candidate_path)
        with process_lock:
            with self._cross_process_lock(candidate_path):
                try:
                    raw = json.loads(candidate_path.read_text(encoding="utf-8"))
                except (OSError, ValueError, TypeError):
                    return False
                if not isinstance(raw, Mapping):
                    return False
                if _normalise_id(raw.get("group_id")) != self.group_id:
                    return False
                version = raw.get("schema_version", SCHEMA_VERSION)
                if isinstance(version, bool) or not isinstance(version, int) or version < 1 or version > SCHEMA_VERSION:
                    return False
                state = self._state_from_payload(raw)
                if state is None:
                    return False
                with self._lock:
                    self._apply_state_unlocked(state)
                    if path is not None:
                        self._storage_path = candidate_path
                    self._persisted_snapshots[target_key] = self._snapshot_unlocked()
                    self._pending_unresolved_resolutions.clear()
        return True

    @classmethod
    def open(
        cls,
        group_id: str,
        *,
        storage_path: str | Path | None = None,
        storage_dir: str | Path | None = None,
        **kwargs: Any,
    ) -> "GroupSocialMemory":
        """Construct a memory instance and restore its existing snapshot."""

        memory = cls(
            group_id,
            storage_path=storage_path,
            storage_dir=storage_dir,
            **kwargs,
        )
        memory.load()
        return memory

    @staticmethod
    def _state_from_payload(raw: Mapping[str, Any]) -> tuple[Any, ...] | None:
        try:
            required = {
                "schema_version",
                "group_id",
                "addressing_habits",
                "topic_owners",
                "topic_history",
                "disagreements",
                "reply_relations",
                "reaction_relations",
                "style_profile",
                "unresolved_topics",
                "observed_message_ids",
            }
            if set(raw) != required:
                return None
            addressing = raw.get("addressing_habits", {})
            owners = raw.get("topic_owners", {})
            history = raw.get("topic_history", [])
            disagreements = raw.get("disagreements", [])
            relations = raw.get("reply_relations", [])
            reactions = raw.get("reaction_relations", [])
            style = raw.get("style_profile", {})
            unresolved = raw.get("unresolved_topics", {})
            observed = raw.get("observed_message_ids", [])
            if not isinstance(addressing, Mapping) or not isinstance(owners, Mapping):
                return None
            if (
                not isinstance(history, list)
                or not isinstance(disagreements, list)
                or not isinstance(relations, list)
                or not isinstance(reactions, list)
            ):
                return None
            if not isinstance(style, Mapping) or not isinstance(unresolved, Mapping):
                return None
            if not isinstance(observed, list):
                return None
            clean_addressing = {
                _normalise_id(key): GroupSocialMemory._safe_json_value(value)
                for key, value in addressing.items()
                if _normalise_id(key) and isinstance(value, Mapping)
            }
            clean_owners = {
                _normalise_key(key): GroupSocialMemory._safe_json_value(value)
                for key, value in owners.items()
                if _normalise_key(key) and isinstance(value, Mapping)
            }
            clean_unresolved = {
                _normalise_key(key): GroupSocialMemory._safe_json_value(value)
                for key, value in unresolved.items()
                if _normalise_key(key) and isinstance(value, Mapping)
            }
            clean_style = GroupSocialMemory._empty_style_profile()
            for key, value in style.items():
                clean_style[str(key)] = GroupSocialMemory._safe_json_value(value, limit=300)
            for key in ("tone_counts", "verbosity_counts", "format_counts"):
                counts = clean_style.get(key, {})
                if not isinstance(counts, Mapping):
                    return None
                clean_style[key] = {
                    str(label): max(0, int(count))
                    for label, count in counts.items()
                    if str(label).strip()
                }
            for key in ("message_count", "emoji_message_count", "emoji_count"):
                value = clean_style.get(key, 0)
                if isinstance(value, bool) or not isinstance(value, (int, float)) or value < 0:
                    return None
                clean_style[key] = int(value)
            for key in ("avg_chars", "short_message_ratio"):
                value = clean_style.get(key, 0.0)
                if isinstance(value, bool) or not isinstance(value, (int, float)) or value < 0:
                    return None
                clean_style[key] = float(value)
            if not isinstance(clean_style.get("uses_emoji"), bool):
                clean_style["uses_emoji"] = bool(clean_style.get("uses_emoji"))
            clean_reactions: list[dict[str, Any]] = []
            for value in reactions:
                if not isinstance(value, Mapping):
                    continue
                target = _normalise_id(value.get("message_id") or "")
                emoji = _normalise_text(value.get("emoji") or "", 80)
                actor_values = value.get("actor_ids", [])
                if not target or not emoji or not isinstance(actor_values, list):
                    continue
                actors = list(dict.fromkeys(
                    _normalise_id(actor)
                    for actor in actor_values
                    if _normalise_id(actor)
                ))
                if not actors:
                    continue
                clean_reactions.append(
                    {
                        "message_id": target,
                        "emoji": emoji,
                        "actor_ids": actors,
                        "count": len(actors),
                        "last_actor_id": _normalise_id(value.get("last_actor_id") or actors[-1]),
                        "last_active": _as_bool(value.get("last_active", True)) is not False,
                        "last_seen_at": _normalise_text(value.get("last_seen_at") or "", 80),
                    }
                )
            clean_observed = [
                _normalise_id(value)
                for value in observed
                if not isinstance(value, bool) and isinstance(value, (str, int)) and _normalise_id(value)
            ]
            return (
                clean_addressing,
                clean_owners,
                [GroupSocialMemory._safe_json_value(value) for value in history if isinstance(value, Mapping)],
                [GroupSocialMemory._safe_json_value(value) for value in disagreements if isinstance(value, Mapping)],
                [GroupSocialMemory._safe_json_value(value) for value in relations if isinstance(value, Mapping)],
                clean_reactions,
                clean_style,
                clean_unresolved,
                clean_observed,
            )
        except Exception:
            return None

    def render_context(
        self,
        *,
        max_topics: int = 8,
        max_relations: int = 8,
        max_members: int = 12,
    ) -> str:
        """Render a compact, non-private summary for a group prompt."""

        if isinstance(max_topics, bool) or not isinstance(max_topics, int) or max_topics < 0:
            raise ValueError("max_topics must be a non-negative integer")
        if isinstance(max_relations, bool) or not isinstance(max_relations, int) or max_relations < 0:
            raise ValueError("max_relations must be a non-negative integer")
        if isinstance(max_members, bool) or not isinstance(max_members, int) or max_members < 0:
            raise ValueError("max_members must be a non-negative integer")
        with self._lock:
            preferred_names = [
                (member_id, str(item.get("preferred_label") or ""))
                for member_id, item in self._addressing_habits.items()
                if str(item.get("preferred_label") or "")
            ]
            unresolved = list(self._unresolved_topics.items())
            payload = {
                "group_id": self.group_id,
                "addressing_habits": dict(
                    preferred_names[-max_members:] if max_members else []
                ),
                "recent_topic_owners": list(reversed(self._topic_history[-max_topics:] if max_topics else [])),
                "disagreements": self._disagreements[-max_topics:] if max_topics else [],
                "reply_relations": self._reply_relations[-max_relations:] if max_relations else [],
                "reaction_relations": self._reaction_relations[-max_relations:] if max_relations else [],
                "style": self.style_hint(),
                "unresolved_topics": dict(
                    unresolved[-max_topics:] if max_topics else []
                ),
            }
        return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))

__all__ = [
    "SCHEMA_VERSION",
    "GroupSocialMemory",
    "is_public_group_message",
]
