#!/usr/bin/env python3
"""Shared context helpers for group-chat routing.

Author: Damon Li
"""

from __future__ import annotations

import hashlib
import json
import time
import uuid
from dataclasses import asdict, dataclass
from typing import Any, List, Mapping, Sequence

from agenticx.llms.request_context import current_llm_turn_id


# ``chat_history`` is also used for private panels, draft candidates, and
# direct/one-to-one turns.  Keep the public-feed marker deliberately small and
# exact so a row cannot become public merely by having a user/assistant role.
GROUP_FEED_VISIBILITY = "feed"


@dataclass
class GroupMessage:
    message_id: str
    role: str
    content: str
    sender_id: str
    sender_name: str
    reply_to_message_id: str = ""


@dataclass
class ActiveThread:
    partner_id: str
    partner_name: str
    turn_count: int
    last_topic: str


class GroupChatContext:
    """Read/write normalized group-chat history on top of StudioSession."""

    def __init__(
        self,
        session: Any,
        *,
        max_items: int = 20,
        group_id: str | None = None,
    ) -> None:
        self.session = session
        self.max_items = max(1, int(max_items))
        self._explicit_group_id = str(group_id or "").strip()

    def _bound_group_id(self) -> str:
        """Resolve an actual room binding, without a synthetic fallback."""

        if self._explicit_group_id:
            return self._explicit_group_id
        sink = getattr(self.session, "__group_public_action_sink", None)
        sink_group_id = str(getattr(sink, "group_id", "") or "").strip()
        if sink_group_id:
            return sink_group_id
        for attr in (
            "__group_id",
            "_group_id",
            "group_id",
            "bound_group_id",
        ):
            value = str(getattr(self.session, attr, "") or "").strip()
            if value:
                return value
        # Some callers only expose the managed binding on the StudioSession.
        for attr in ("bound_avatar_id", "avatar_id"):
            value = str(getattr(self.session, attr, "") or "").strip()
            if value.startswith("group:") and value.split(":", 1)[1].strip():
                return value.split(":", 1)[1].strip()
        return ""

    def group_id(self) -> str:
        """Return the active room id used for newly admitted feed rows.

        The router creates this context before it installs the public-action
        sink, so resolve the sink lazily as well as accepting an explicit id.
        Standalone unit callers get a non-empty synthetic room id; persisted
        rows are still required to carry all three canonical feed markers, and
        production group requests always provide their real id from the sink.
        """

        return self._bound_group_id() or "local-group"

    def _is_public_context_row(self, row: Mapping[str, Any] | Any) -> bool:
        return self._is_public_history_row(row, group_id=self._bound_group_id() or None)

    @classmethod
    def _canonical_public_fields(cls, group_id: str) -> dict[str, Any]:
        normalized_group_id = str(group_id or "").strip()
        return {
            "group_id": normalized_group_id,
            "feed_visibility": GROUP_FEED_VISIBILITY,
            "is_public": True,
        }

    @staticmethod
    def _row_group_id(row: Mapping[str, Any], metadata: Mapping[str, Any]) -> str:
        # The top-level fields are the canonical persisted contract.  Metadata
        # is read only for diagnostics/compatibility checks below; it must not
        # be enough to promote an otherwise unmarked row into the Feed.
        return str(row.get("group_id", "") or "").strip()

    def _history(self) -> list[dict[str, Any]]:
        history = getattr(self.session, "chat_history", None)
        if not isinstance(history, list):
            history = []
            setattr(self.session, "chat_history", history)
        return history

    @staticmethod
    def _is_public_history_row(
        row: Mapping[str, Any] | Any,
        *,
        group_id: str | None = None,
    ) -> bool:
        """Return whether a persisted row belongs to the shared group feed.

        Group sessions also carry private workflow/runtime records.  Role alone
        is therefore not a visibility boundary: every read path used for
        prompts, replies, reactions, and attachment re-sharing must apply the
        same explicit scope checks.
        """

        if not isinstance(row, Mapping):
            return False
        role = str(row.get("role", "") or "").strip().casefold()
        if role not in {"user", "assistant"}:
            return False
        metadata = row.get("metadata")
        meta = metadata if isinstance(metadata, Mapping) else {}
        event_data = row.get("event_data")
        event_meta = event_data if isinstance(event_data, Mapping) else {}

        # Fail closed: only rows explicitly admitted to this group's shared
        # Feed may be read by summaries, prompts, quote lookup, attachments or
        # reactions.  No legacy role-only row is accepted (old data migration
        # is intentionally out of scope for this branch).
        if row.get("is_public") is not True:
            return False
        if str(row.get("feed_visibility", "") or "").strip().casefold() != GROUP_FEED_VISIBILITY:
            return False
        row_group_id = GroupChatContext._row_group_id(row, meta)
        if not row_group_id:
            return False
        expected_group_id = str(group_id or "").strip()
        if expected_group_id and row_group_id != expected_group_id:
            return False

        private_boolean_fields = (
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
            "panel",
        )
        private_scope_values = {
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
            "tool_call",
            "tool_result",
            "workflow",
            "workflow_detail",
            "workflow_progress",
            "workflow_candidate",
            "workflow_review",
            "workflow_private",
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
            "reaction",
            "pass",
            "skip",
            "skipped",
            "no_reply",
            "no-reply",
            "no response",
            "no_response",
            "decline",
        }
        private_scope_fields = (
            "feed_visibility",
            "visibility",
            "scope",
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

        for source in (row, meta, event_meta):
            if _as_bool(source.get("is_public")) is False or _as_bool(source.get("public")) is False:
                return False
            if _as_bool(source.get("is_group")) is False:
                return False
            if any(_as_bool(source.get(key)) is True for key in private_boolean_fields):
                return False
            source_group_id = str(source.get("group_id", "") or "").strip()
            if source_group_id and source_group_id != row_group_id:
                return False
            for key in private_scope_fields:
                value = str(source.get(key, "") or "").strip().casefold()
                if value in private_scope_values:
                    return False

        if any(_as_bool(source.get("skipped")) is True for source in (row, meta, event_meta)):
            return False
        return True

    @staticmethod
    def _new_message_id() -> str:
        return f"gmsg_{uuid.uuid4().hex}"

    @classmethod
    def _ensure_message_identity(cls, row: dict[str, Any]) -> str:
        message_id = str(row.get("id", "") or "").strip()
        if not message_id:
            message_id = cls._new_message_id()
            row["id"] = message_id
        if row.get("timestamp") is None:
            row["timestamp"] = int(time.time() * 1000)
        return message_id

    def _scratchpad(self) -> dict[str, Any]:
        scratchpad = getattr(self.session, "scratchpad", None)
        if not isinstance(scratchpad, dict):
            scratchpad = {}
            setattr(self.session, "scratchpad", scratchpad)
        return scratchpad

    def append_user(
        self,
        text: str,
        *,
        sender_name: str = "我",
        quoted_message_id: str = "",
        quoted_content: str = "",
        attachments: Sequence[Mapping[str, Any]] = (),
    ) -> str:
        label = str(sender_name or "").strip() or "我"
        row: dict[str, Any] = {
            **self._canonical_public_fields(self.group_id()),
            "role": "user",
            "content": str(text or ""),
            "sender_id": "user",
            "sender_name": label,
            "agent_id": "user",
            "reply_to_message_id": str(quoted_message_id or ""),
            "quoted_message_id": str(quoted_message_id or ""),
            "quoted_content": str(quoted_content or ""),
        }
        safe_attachments: list[dict[str, Any]] = []
        for attachment in attachments:
            if not isinstance(attachment, Mapping):
                continue
            item = dict(attachment)
            attachment_id = str(
                item.get("id") or item.get("artifact_id") or ""
            ).strip()
            if not attachment_id:
                fingerprint_source = {
                    key: item.get(key)
                    for key in (
                        "name",
                        "mime_type",
                        "size",
                        "storage_path",
                        "source_path",
                        "data_url",
                        "kind",
                    )
                    if item.get(key) not in (None, "")
                }
                digest = hashlib.sha256(
                    json.dumps(
                        fingerprint_source,
                        ensure_ascii=False,
                        sort_keys=True,
                        default=str,
                    ).encode("utf-8")
                ).hexdigest()[:24]
                attachment_id = f"gatt_{digest}"
            item["id"] = attachment_id
            safe_attachments.append(item)
        if safe_attachments:
            row["attachments"] = safe_attachments
        turn_id = current_llm_turn_id().strip()
        metadata: dict[str, Any] = {"group_publication_source": "user"}
        # A real router/sink binding is available in production group turns.
        # Mirror the canonical scope in metadata for downstream adapters while
        # keeping standalone unit contexts' synthetic room out of it.
        bound_group_id = self._bound_group_id()
        if bound_group_id:
            metadata.update(self._canonical_public_fields(bound_group_id))
        row["metadata"] = metadata
        if turn_id:
            row["metadata"]["client_turn_id"] = turn_id
        message_id = self._ensure_message_identity(row)
        metadata = row.get("metadata")
        if not isinstance(metadata, dict):
            metadata = {}
            row["metadata"] = metadata
        metadata.setdefault("group_message_id", message_id)
        self._history().append(row)
        return message_id

    def append_agent(
        self,
        *,
        agent_id: str,
        agent_name: str,
        text: str,
        avatar_url: str = "",
        message_id: str = "",
        reply_to_message_id: str = "",
        quoted_content: str = "",
        metadata: Mapping[str, Any] | None = None,
        attachments: Sequence[Mapping[str, Any]] = (),
    ) -> str:
        supplied_metadata = dict(metadata) if isinstance(metadata, Mapping) else {}
        # The router admits a public reply through its sink before this helper
        # is called, and passes the authoritative room id in event metadata.
        # Honour that id only when this context has not already been bound; an
        # explicit context/sink binding always wins.
        bound_group_id = self._bound_group_id()
        metadata_group_id = str(supplied_metadata.get("group_id", "") or "").strip()
        row_group_id = bound_group_id or metadata_group_id or self.group_id()
        row: dict[str, Any] = {
            **self._canonical_public_fields(row_group_id),
            "id": str(message_id or "").strip(),
            "role": "assistant",
            "content": str(text or ""),
            "sender_id": str(agent_id or ""),
            "sender_name": str(agent_name or "") or str(agent_id or ""),
            "agent_id": str(agent_id or ""),
            "avatar_name": str(agent_name or "") or str(agent_id or ""),
            "avatar_url": str(avatar_url or ""),
            "reply_to_message_id": str(reply_to_message_id or ""),
            "quoted_message_id": str(reply_to_message_id or ""),
            "quoted_content": str(quoted_content or ""),
        }
        if supplied_metadata:
            row["metadata"] = supplied_metadata
        elif bound_group_id:
            row["metadata"] = self._canonical_public_fields(row_group_id)
        else:
            row["metadata"] = {}
        # Caller-supplied event metadata can describe the publication source.
        # Explicit private metadata remains private; the canonical top-level
        # fields are still written so every row has an auditable group scope.
        row["group_id"] = row_group_id
        row["feed_visibility"] = GROUP_FEED_VISIBILITY
        row["is_public"] = True
        row_metadata = row["metadata"]
        safe_attachments = [dict(item) for item in attachments if isinstance(item, Mapping)]
        if safe_attachments:
            row["attachments"] = safe_attachments
        stable_id = self._ensure_message_identity(row)
        row_metadata = row["metadata"]
        row_metadata.setdefault("group_message_id", stable_id)
        self._history().append(row)
        return stable_id

    def public_message_summaries(self, *, limit: int = 30) -> dict[str, str]:
        """Return recent public message ids and bounded text for reply/react tools."""

        recent: list[tuple[str, str]] = []
        public_limit = max(1, int(limit))
        for row in reversed(self._history()):
            if not self._is_public_context_row(row):
                continue
            role = str(row.get("role", "") or "").strip()
            content = str(row.get("content", "") or "").strip()
            if role not in {"user", "assistant"} or not content:
                continue
            message_id = self._ensure_message_identity(row)
            recent.append((message_id, content[:320]))
            if len(recent) >= public_limit:
                break
        return dict(reversed(recent))

    def allowed_attachment_ids(self, *, limit: int = 30) -> list[str]:
        out: list[str] = []
        public_rows = 0
        for row in reversed(self._history()):
            if not self._is_public_context_row(row):
                continue
            public_rows += 1
            if public_rows > max(1, int(limit)):
                break
            attachments = row.get("attachments")
            if not isinstance(attachments, list):
                continue
            for attachment in attachments:
                if not isinstance(attachment, Mapping):
                    continue
                attachment_id = str(
                    attachment.get("id") or attachment.get("artifact_id") or ""
                ).strip()
                if attachment_id and attachment_id not in out:
                    out.append(attachment_id)
        return out

    def attachments_for_ids(
        self,
        attachment_ids: Sequence[str],
        *,
        limit: int = 30,
    ) -> list[dict[str, Any]]:
        """Resolve existing public attachment descriptors without inventing paths."""

        wanted = {
            str(attachment_id or "").strip()
            for attachment_id in attachment_ids
            if str(attachment_id or "").strip()
        }
        if not wanted:
            return []
        resolved: list[dict[str, Any]] = []
        seen: set[str] = set()
        public_rows = 0
        for row in reversed(self._history()):
            if not self._is_public_context_row(row):
                continue
            public_rows += 1
            if public_rows > max(1, int(limit)):
                break
            attachments = row.get("attachments")
            if not isinstance(attachments, list):
                continue
            for attachment in attachments:
                if not isinstance(attachment, Mapping):
                    continue
                attachment_id = str(
                    attachment.get("id") or attachment.get("artifact_id") or ""
                ).strip()
                if attachment_id in wanted and attachment_id not in seen:
                    resolved.append(dict(attachment))
                    seen.add(attachment_id)
        return resolved

    def public_attachment_manifest(self, *, limit: int = 30) -> list[dict[str, Any]]:
        """Return bounded descriptors the model may safely re-share publicly."""

        attachment_ids = self.allowed_attachment_ids(limit=limit)
        rows = self.attachments_for_ids(attachment_ids, limit=limit)
        out: list[dict[str, Any]] = []
        for row in rows:
            attachment_id = str(
                row.get("id") or row.get("artifact_id") or ""
            ).strip()
            if not attachment_id:
                continue
            try:
                size = max(0, int(row.get("size", 0) or 0))
            except (TypeError, ValueError):
                size = 0
            out.append(
                {
                    "id": attachment_id,
                    "name": str(row.get("name", "") or "").strip() or "附件",
                    "mime_type": str(row.get("mime_type", "") or "").strip(),
                    "size": size,
                    "kind": str(row.get("kind", "") or "").strip(),
                }
            )
        return out

    def sender_for_message(self, message_id: str) -> str:
        target_id = str(message_id or "").strip()
        if not target_id:
            return ""
        for row in reversed(self._history()):
            if not self._is_public_context_row(row):
                continue
            if self._ensure_message_identity(row) != target_id:
                continue
            return str(
                row.get("agent_id")
                or row.get("sender_id")
                or ("user" if row.get("role") == "user" else "")
            ).strip()
        return ""

    def toggle_reaction(
        self,
        *,
        message_id: str,
        actor_id: str,
        emoji: str,
    ) -> tuple[bool, list[dict[str, Any]]]:
        """Toggle one actor's emoji on a public message and return new state."""

        target_id = str(message_id or "").strip()
        actor = str(actor_id or "").strip()
        reaction_emoji = str(emoji or "").strip()
        if not target_id or not actor or not reaction_emoji:
            return False, []
        for row in reversed(self._history()):
            if not self._is_public_context_row(row):
                continue
            if self._ensure_message_identity(row) != target_id:
                continue
            metadata = row.get("metadata")
            if not isinstance(metadata, dict):
                metadata = {}
                row["metadata"] = metadata
            raw_reactions = metadata.get("group_reactions")
            reactions = [
                dict(item)
                for item in raw_reactions
                if isinstance(item, Mapping)
            ] if isinstance(raw_reactions, list) else []
            target = next(
                (
                    item
                    for item in reactions
                    if str(item.get("emoji", "") or "") == reaction_emoji
                ),
                None,
            )
            if target is None:
                target = {"emoji": reaction_emoji, "actor_ids": [actor]}
                reactions.append(target)
                active = True
            else:
                actors = [
                    str(item).strip()
                    for item in target.get("actor_ids", [])
                    if str(item).strip()
                ]
                if actor in actors:
                    actors = [item for item in actors if item != actor]
                    active = False
                else:
                    actors.append(actor)
                    active = True
                target["actor_ids"] = actors
                if not actors:
                    reactions.remove(target)
            metadata["group_reactions"] = reactions
            return active, reactions
        return False, []

    def recent(self) -> List[GroupMessage]:
        out: List[GroupMessage] = []
        public_rows = [
            msg
            for msg in self._history()
            if self._is_public_context_row(msg)
        ][-self.max_items :]
        for msg in public_rows:
            role = str(msg.get("role", "") or "").strip() or "assistant"
            content = str(msg.get("content", "") or "")
            if not content.strip():
                continue
            sender_id = str(msg.get("sender_id", "") or "").strip()
            sender_name = str(msg.get("sender_name", "") or "").strip()
            if not sender_name:
                sender_name = "我" if role == "user" else (sender_id or "assistant")
            if not sender_id:
                sender_id = "user" if role == "user" else "assistant"
            message_id = self._ensure_message_identity(msg)
            out.append(
                GroupMessage(
                    message_id=message_id,
                    role=role,
                    content=content,
                    sender_id=sender_id,
                    sender_name=sender_name,
                    reply_to_message_id=str(
                        msg.get("reply_to_message_id")
                        or msg.get("quoted_message_id", "")
                        or ""
                    ).strip(),
                )
            )
        return out

    def render_recent_dialogue(self) -> str:
        rows = self.recent()
        if not rows:
            return "(暂无历史消息)"
        lines: list[str] = []
        for row in rows:
            if row.role == "user":
                prefix = row.sender_name or "用户"
            else:
                prefix = f"{row.sender_name}({row.sender_id})"
            reply_hint = (
                f" 回复[{row.reply_to_message_id}]"
                if row.reply_to_message_id
                else ""
            )
            lines.append(f"- [{row.message_id}]{reply_hint} {prefix}: {row.content}")
        return "\n".join(lines)

    def get_active_thread(self) -> ActiveThread | None:
        raw = self._scratchpad().get("group_active_thread")
        if not isinstance(raw, dict):
            return None
        partner_id = str(raw.get("partner_id", "") or "").strip()
        if not partner_id:
            return None
        partner_name = str(raw.get("partner_name", "") or "").strip() or partner_id
        try:
            turn_count = max(1, int(raw.get("turn_count", 1) or 1))
        except (TypeError, ValueError):
            turn_count = 1
        last_topic = str(raw.get("last_topic", "") or "").strip()
        return ActiveThread(
            partner_id=partner_id,
            partner_name=partner_name,
            turn_count=turn_count,
            last_topic=last_topic,
        )

    def set_active_thread(self, *, partner_id: str, partner_name: str, last_topic: str) -> ActiveThread:
        thread = ActiveThread(
            partner_id=str(partner_id or "").strip(),
            partner_name=str(partner_name or "").strip() or str(partner_id or "").strip(),
            turn_count=1,
            last_topic=str(last_topic or "").strip(),
        )
        self._scratchpad()["group_active_thread"] = asdict(thread)
        return thread

    def bump_active_thread(self, *, partner_id: str, partner_name: str, last_topic: str = "") -> ActiveThread:
        existing = self.get_active_thread()
        normalized_id = str(partner_id or "").strip()
        normalized_name = str(partner_name or "").strip() or normalized_id
        normalized_topic = str(last_topic or "").strip()
        if existing is None or existing.partner_id != normalized_id:
            return self.set_active_thread(
                partner_id=normalized_id,
                partner_name=normalized_name,
                last_topic=normalized_topic,
            )
        updated = ActiveThread(
            partner_id=normalized_id,
            partner_name=normalized_name,
            turn_count=max(1, existing.turn_count + 1),
            last_topic=normalized_topic or existing.last_topic,
        )
        self._scratchpad()["group_active_thread"] = asdict(updated)
        return updated

    def clear_active_thread(self) -> None:
        self._scratchpad().pop("group_active_thread", None)

    @staticmethod
    def render_members_summary(members: List[dict[str, str]]) -> str:
        if not members:
            return "(no members)"
        lines: list[str] = []
        for item in members:
            avatar_id = str(item.get("id", "") or "").strip()
            avatar_name = str(item.get("name", "") or "").strip() or avatar_id
            avatar_role = str(item.get("role", "") or "").strip() or "General Assistant"
            lines.append(f"- {avatar_name}({avatar_id}): {avatar_role}")
        return "\n".join(lines)
