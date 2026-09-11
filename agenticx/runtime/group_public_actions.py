"""Explicit public actions for social group-chat members.

An expert's ordinary model text, reasoning and tool trace belong to its private
runtime.  Only the actions defined here are eligible for the shared group feed.
The state is turn-local and is installed on each member's temporary
``StudioSession`` by :mod:`agenticx.runtime.group_router`.
"""

from __future__ import annotations

import inspect
from collections.abc import Awaitable, Callable, Mapping, Sequence
from typing import Any


GROUP_PUBLIC_ACTION_STATE_KEY = "__group_public_action_state"
GROUP_PUBLIC_MESSAGE_EVENT = "group_public_message"
GROUP_REACTION_EVENT = "group_reaction"
GROUP_PASS_EVENT = "group_pass"

PUBLISH_GROUP_MESSAGE_TOOL = "publish_group_message"
REACT_GROUP_MESSAGE_TOOL = "react_group_message"
PASS_GROUP_TURN_TOOL = "pass_group_turn"
GROUP_PUBLIC_ACTION_TOOL_NAMES = frozenset(
    {
        PUBLISH_GROUP_MESSAGE_TOOL,
        REACT_GROUP_MESSAGE_TOOL,
        PASS_GROUP_TURN_TOOL,
    }
)

MAX_PUBLIC_MESSAGES_PER_MEMBER_TURN = 2
MAX_PUBLIC_MESSAGE_CHARS = 6_000
MAX_QUOTED_SUMMARY_CHARS = 320
ALLOWED_REACTION_EMOJIS = ("👍", "😂", "❤️", "🎉", "👀", "🤔")

_UNVERIFIED_SEARCH_NOTE = (
    "\n\n（系统核验：本轮没有成功的 web_search 结果，以上检索陈述未被确认。）"
)
_SEARCH_CLAIM_MARKERS = (
    # Chinese claims that imply an actual online lookup.
    "搜了",
    "搜索了",
    "检索了",
    "查了一圈",
    "搜了一圈",
    "网上搜",
    "上网搜",
    "查了网上",
    "网上查",
    "网上查找",
    "在线检索",
    "联网检索",
    "多个来源",
    "中英文多个",
    "查看了多个来源",
    "参考了多个来源",
    "根据多个来源",
    # Keep the gate effective when an English-model response is used.
    "i searched",
    "i looked up",
    "i browsed",
    "searched online",
    "searched the web",
    "according to online sources",
    "according to multiple sources",
    "multiple sources confirm",
)


def looks_like_search_claim(text: str) -> bool:
    """Return whether text claims that an online search was performed."""

    normalized = " ".join(str(text or "").lower().split())
    return any(marker in normalized for marker in _SEARCH_CLAIM_MARKERS)


def gate_unverified_search_claim(content: str, *, searched_web: bool) -> str:
    """Annotate a public claim unless this turn has a successful web search."""

    text = str(content or "").strip()
    if searched_web or not looks_like_search_claim(text):
        return text
    if "检索陈述未被确认" in text:
        return text
    return text.rstrip() + _UNVERIFIED_SEARCH_NOTE


GROUP_PUBLIC_ACTION_TOOLS: tuple[dict[str, Any], ...] = (
    {
        "type": "function",
        "function": {
            "name": PUBLISH_GROUP_MESSAGE_TOOL,
            "description": (
                "Publish your only public voice into the group chat. Ordinary assistant text, "
                "reasoning, and tool output stay private. Use this once for a normal reply, or "
                "at most twice when a short acknowledgement must be followed by a real result. "
                "Do not publish empty progress chatter."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "content": {
                        "type": "string",
                        "description": "Natural group message text; concise unless the user requested a full deliverable.",
                    },
                    "reply_to_message_id": {
                        "type": "string",
                        "description": "Optional id of a visible recent group message being replied to.",
                    },
                    "quoted_summary": {
                        "type": "string",
                        "description": "Optional short quote shown above the reply; normally inferred from reply_to_message_id.",
                    },
                    "mentioned_avatar_ids": {
                        "type": "array",
                        "items": {"type": "string"},
                        "maxItems": 8,
                        "description": "Optional stable ids of members naturally @mentioned in content.",
                    },
                    "attachment_ids": {
                        "type": "array",
                        "items": {"type": "string"},
                        "maxItems": 8,
                        "description": "Optional ids of already-created, allowed group artifacts. Never invent paths or URLs.",
                    },
                },
                "required": ["content"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": REACT_GROUP_MESSAGE_TOOL,
            "description": (
                "React sparsely to a visible group message when a full reply would add no value. "
                "A reaction does not start another speaking round. Calling the same emoji on the "
                "same message toggles your reaction."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "message_id": {"type": "string"},
                    "emoji": {
                        "type": "string",
                        "enum": list(ALLOWED_REACTION_EMOJIS),
                    },
                },
                "required": ["message_id", "emoji"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": PASS_GROUP_TURN_TOOL,
            "description": (
                "Stay silent because you have no unique, useful contribution. This is the correct "
                "choice for optional/open-floor turns; never use it when the user explicitly @mentioned you."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "reason": {
                        "type": "string",
                        "description": "Private diagnostic reason; it is not shown as a chat message.",
                    }
                },
                "additionalProperties": False,
            },
        },
    },
)


def is_group_public_action_tool(name: str) -> bool:
    return str(name or "").strip() in GROUP_PUBLIC_ACTION_TOOL_NAMES


def _clean_ids(values: Sequence[Any] | Any) -> list[str]:
    if not isinstance(values, Sequence) or isinstance(values, (str, bytes, bytearray)):
        return []
    out: list[str] = []
    for value in values:
        item = str(value or "").strip()
        if item and item not in out:
            out.append(item)
    return out


def prepare_group_public_action_state(
    session: Any,
    *,
    group_id: str,
    actor_id: str,
    allowed_member_ids: Sequence[str],
    message_summaries: Mapping[str, str],
    allowed_attachment_ids: Sequence[str] = (),
    force_reply: bool = False,
    successful_web_search: bool = False,
    action_sink: Callable[[str, Mapping[str, Any], Mapping[str, Any]], Any] | None = None,
) -> dict[str, Any]:
    """Install fresh, bounded action state on one member's private session."""

    scratchpad = getattr(session, "scratchpad", None)
    if not isinstance(scratchpad, dict):
        scratchpad = {}
        setattr(session, "scratchpad", scratchpad)
    summaries = {
        str(message_id).strip(): str(summary or "").strip()[:MAX_QUOTED_SUMMARY_CHARS]
        for message_id, summary in message_summaries.items()
        if str(message_id).strip()
    }
    state: dict[str, Any] = {
        "group_id": str(group_id or "").strip(),
        "actor_id": str(actor_id or "").strip(),
        "allowed_member_ids": _clean_ids(allowed_member_ids),
        "message_summaries": summaries,
        "allowed_attachment_ids": _clean_ids(allowed_attachment_ids),
        "published_count": 0,
        "actions_seen": 0,
        "reaction_count": 0,
        "passed": False,
        "successful_web_search": bool(successful_web_search),
        "force_reply": bool(force_reply),
        "action_sink": action_sink,
    }
    scratchpad[GROUP_PUBLIC_ACTION_STATE_KEY] = state
    return state


def group_public_actions_seen(session: Any) -> bool:
    scratchpad = getattr(session, "scratchpad", None)
    state = scratchpad.get(GROUP_PUBLIC_ACTION_STATE_KEY) if isinstance(scratchpad, dict) else None
    return isinstance(state, dict) and int(state.get("actions_seen", 0) or 0) > 0


def group_public_passed(session: Any) -> bool:
    scratchpad = getattr(session, "scratchpad", None)
    state = scratchpad.get(GROUP_PUBLIC_ACTION_STATE_KEY) if isinstance(scratchpad, dict) else None
    return isinstance(state, dict) and state.get("passed") is True


def group_public_message_count(session: Any) -> int:
    scratchpad = getattr(session, "scratchpad", None)
    state = scratchpad.get(GROUP_PUBLIC_ACTION_STATE_KEY) if isinstance(scratchpad, dict) else None
    if not isinstance(state, dict):
        return 0
    return max(0, int(state.get("published_count", 0) or 0))


async def _emit(
    callback: Callable[[dict[str, Any]], Any] | None,
    event_type: str,
    data: dict[str, Any],
) -> None:
    if callback is None:
        return
    result = callback({"type": event_type, "data": data})
    if inspect.isawaitable(result):
        await result


async def _admit_with_sink(
    state: dict[str, Any],
    action: str,
    payload: Mapping[str, Any],
) -> tuple[bool, dict[str, Any], str]:
    """Run the router-owned public sink before any action reaches SSE."""

    sink = state.get("action_sink")
    if not callable(sink):
        return True, dict(payload), ""
    result = sink(action, dict(payload), state)
    if inspect.isawaitable(result):
        result = await result
    if not isinstance(result, Mapping):
        return False, {}, "group public action sink returned an invalid result"
    ok = result.get("ok") is True
    admitted_payload = result.get("payload")
    safe_payload = dict(admitted_payload) if isinstance(admitted_payload, Mapping) else {}
    return ok, safe_payload, str(result.get("error", "") or "").strip()


async def dispatch_group_public_action(
    name: str,
    arguments: Mapping[str, Any],
    session: Any,
    *,
    event_callback: Callable[[dict[str, Any]], Awaitable[None] | None] | None = None,
    publication_source: str = "publish_group_message",
    audit_metadata: Mapping[str, Any] | None = None,
) -> str | None:
    """Execute one group-public tool, or return ``None`` for unrelated tools.

    ``publication_source`` and ``audit_metadata`` are server-owned annotations
    for compatibility paths.  Model tool calls use the defaults and cannot
    supply these values through the tool arguments/schema.
    """

    tool_name = str(name or "").strip()
    if tool_name not in GROUP_PUBLIC_ACTION_TOOL_NAMES:
        return None
    scratchpad = getattr(session, "scratchpad", None)
    state = scratchpad.get(GROUP_PUBLIC_ACTION_STATE_KEY) if isinstance(scratchpad, dict) else None
    if not isinstance(state, dict):
        return "ERROR: group public actions are available only inside an active group-member turn"

    actor_id = str(state.get("actor_id", "") or "").strip()
    group_id = str(state.get("group_id", "") or "").strip()
    if not actor_id or not group_id:
        return "ERROR: invalid group public action state"
    allowed_members = set(_clean_ids(state.get("allowed_member_ids", [])))
    if actor_id not in allowed_members:
        return "ERROR: group public action actor is not a current room member"

    if tool_name == PASS_GROUP_TURN_TOOL:
        if state.get("force_reply") is True:
            return "ERROR: a directly @mentioned member cannot pass this turn"
        if int(state.get("published_count", 0) or 0) > 0:
            return "ERROR: the member already published in this turn; end the turn instead of passing"
        if int(state.get("reaction_count", 0) or 0) > 0:
            return "ERROR: the member already reacted in this turn; end the turn instead of passing"
        if state.get("passed") is True:
            return "Turn already passed silently. End this turn."
        pass_payload = {
            "group_id": group_id,
            "agent_id": actor_id,
            "reason": str(arguments.get("reason", "") or "").strip()[:240],
        }
        admitted, pass_payload, sink_error = await _admit_with_sink(
            state,
            "pass",
            pass_payload,
        )
        if not admitted:
            return f"ERROR: {sink_error or 'group pass was rejected'}"
        state["actions_seen"] = int(state.get("actions_seen", 0) or 0) + 1
        state["passed"] = True
        await _emit(
            event_callback,
            GROUP_PASS_EVENT,
            pass_payload,
        )
        return "Turn passed silently. End this turn without ordinary assistant text."

    summaries = state.get("message_summaries")
    message_summaries = summaries if isinstance(summaries, dict) else {}
    allowed_message_ids = set(str(key) for key in message_summaries)
    has_router_sink = callable(state.get("action_sink"))

    if tool_name == REACT_GROUP_MESSAGE_TOOL:
        if state.get("passed") is True:
            return "ERROR: this member already passed and cannot react later in the same turn"
        if (
            state.get("force_reply") is True
            and int(state.get("published_count", 0) or 0) == 0
        ):
            return (
                "ERROR: a directly @mentioned member must publish a text reply; "
                "a reaction cannot replace the answer"
            )
        if int(state.get("reaction_count", 0) or 0) >= 1:
            return "ERROR: use at most one sparse reaction in a member turn"
        message_id = str(arguments.get("message_id", "") or "").strip()
        emoji = str(arguments.get("emoji", "") or "").strip()
        if message_id not in allowed_message_ids and not has_router_sink:
            return "ERROR: reaction target is not a visible recent group message"
        if emoji not in ALLOWED_REACTION_EMOJIS:
            return "ERROR: unsupported reaction emoji"
        reaction_payload = {
            "group_id": group_id,
            "message_id": message_id,
            "agent_id": actor_id,
            "emoji": emoji,
            "toggle": True,
        }
        admitted, reaction_payload, sink_error = await _admit_with_sink(
            state,
            "reaction",
            reaction_payload,
        )
        if not admitted:
            return f"ERROR: {sink_error or 'group reaction was rejected'}"
        state["actions_seen"] = int(state.get("actions_seen", 0) or 0) + 1
        state["reaction_count"] = int(state.get("reaction_count", 0) or 0) + 1
        await _emit(
            event_callback,
            GROUP_REACTION_EVENT,
            reaction_payload,
        )
        return "Reaction toggled. Do not add a text reply unless you have unique information."

    content = str(arguments.get("content", "") or "").strip()
    if not content:
        return "ERROR: publish_group_message requires non-empty content"
    if state.get("passed") is True:
        return "ERROR: this member already passed and cannot publish later in the same turn"
    published_count = int(state.get("published_count", 0) or 0)
    if published_count >= MAX_PUBLIC_MESSAGES_PER_MEMBER_TURN:
        return "ERROR: this member already published two messages in the current turn"
    if len(content) > MAX_PUBLIC_MESSAGE_CHARS:
        return f"ERROR: public message exceeds {MAX_PUBLIC_MESSAGE_CHARS} characters"

    # The router sink repeats this check before persistence, but keep the
    # dispatch layer safe for legacy/test callers that do not install a sink.
    # This also ensures the quoted summary cache never receives the unverified
    # source text below.
    content = gate_unverified_search_claim(
        content,
        searched_web=state.get("successful_web_search") is True,
    )

    reply_to_message_id = str(arguments.get("reply_to_message_id", "") or "").strip()
    if (
        reply_to_message_id
        and reply_to_message_id not in allowed_message_ids
        and not has_router_sink
    ):
        return "ERROR: reply target is not a visible recent group message"
    quoted_summary = str(arguments.get("quoted_summary", "") or "").strip()
    if not quoted_summary and reply_to_message_id:
        quoted_summary = str(message_summaries.get(reply_to_message_id, "") or "").strip()
    quoted_summary = quoted_summary[:MAX_QUOTED_SUMMARY_CHARS]

    mentioned_avatar_ids = [
        member_id
        for member_id in _clean_ids(arguments.get("mentioned_avatar_ids", []))
        if member_id in allowed_members and member_id != actor_id
    ]
    allowed_attachments = set(_clean_ids(state.get("allowed_attachment_ids", [])))
    attachment_ids = _clean_ids(arguments.get("attachment_ids", []))
    if (
        any(attachment_id not in allowed_attachments for attachment_id in attachment_ids)
        and not has_router_sink
    ):
        return "ERROR: attachment_ids must reference allowed artifacts from this group turn"

    payload = {
        "group_id": group_id,
        "agent_id": actor_id,
        "content": content,
        "reply_to_message_id": reply_to_message_id,
        "quoted_content": quoted_summary,
        "mentioned_avatar_ids": mentioned_avatar_ids,
        "attachment_ids": attachment_ids,
        "publication_source": str(publication_source or "publish_group_message").strip()
        or "publish_group_message",
    }
    if isinstance(audit_metadata, Mapping):
        payload["audit_metadata"] = dict(audit_metadata)
    admitted, payload, sink_error = await _admit_with_sink(
        state,
        "publish",
        payload,
    )
    if not admitted:
        return f"ERROR: {sink_error or 'group message was rejected'}"
    state["published_count"] = published_count + 1
    state["actions_seen"] = int(state.get("actions_seen", 0) or 0) + 1
    state["passed"] = False
    message_id = str(payload.get("message_id", "") or "").strip()
    if message_id:
        admitted_content = str(payload.get("content", "") or content)
        message_summaries[message_id] = admitted_content[:MAX_QUOTED_SUMMARY_CHARS]
    await _emit(event_callback, GROUP_PUBLIC_MESSAGE_EVENT, payload)
    remaining = MAX_PUBLIC_MESSAGES_PER_MEMBER_TURN - int(state["published_count"])
    return (
        "Message published to the group feed. End the turn now."
        if remaining <= 0
        else "Message published. You may publish one final result later only if it adds real value."
    )


__all__ = [
    "ALLOWED_REACTION_EMOJIS",
    "GROUP_PASS_EVENT",
    "GROUP_PUBLIC_ACTION_TOOL_NAMES",
    "GROUP_PUBLIC_ACTION_TOOLS",
    "GROUP_PUBLIC_MESSAGE_EVENT",
    "GROUP_REACTION_EVENT",
    "dispatch_group_public_action",
    "gate_unverified_search_claim",
    "group_public_actions_seen",
    "group_public_message_count",
    "group_public_passed",
    "is_group_public_action_tool",
    "looks_like_search_claim",
    "prepare_group_public_action_state",
]
