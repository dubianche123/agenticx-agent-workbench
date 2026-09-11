"""Backend contract tests for the group-chat public action boundary.

The model's ordinary response is private.  These tests exercise the small,
explicit public-action protocol that is allowed to enter a group feed.  They
use the real router/context objects where the admission boundary matters and
keep the LLM out of the tests.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from agenticx.cli.agent_tools import STUDIO_TOOLS
from agenticx.runtime.events import EventType
from agenticx.runtime.group_context import GroupChatContext
from agenticx.runtime.group_public_actions import (
    ALLOWED_REACTION_EMOJIS,
    GROUP_PASS_EVENT,
    GROUP_PUBLIC_ACTION_TOOL_NAMES,
    GROUP_PUBLIC_ACTION_TOOLS,
    GROUP_PUBLIC_MESSAGE_EVENT,
    GROUP_REACTION_EVENT,
    PASS_GROUP_TURN_TOOL,
    PUBLISH_GROUP_MESSAGE_TOOL,
    REACT_GROUP_MESSAGE_TOOL,
    dispatch_group_public_action,
    group_public_actions_seen,
    group_public_message_count,
    group_public_passed,
    prepare_group_public_action_state,
)
from agenticx.runtime.group_router import (
    GroupChatRouter,
    GroupPublicActionSink,
    GroupReply,
    _group_chat_tools,
)
from agenticx.runtime.group_social_turn import SocialTurnPolicy


class _AvatarRegistry:
    def __init__(self, member_ids: list[str]) -> None:
        self._avatars = {
            member_id: SimpleNamespace(
                name=f"成员-{member_id}",
                avatar_url=f"https://example.test/{member_id}.png",
            )
            for member_id in member_ids
        }

    def get_avatar(self, member_id: str) -> object | None:
        return self._avatars.get(str(member_id))


def _router(member_ids: list[str]) -> GroupChatRouter:
    return GroupChatRouter(
        avatar_registry=_AvatarRegistry(member_ids),
        llm_factory=lambda *_args: None,
        max_tool_rounds=2,
        host_avatar_id=member_ids[0] if member_ids else "",
    )


def _session() -> SimpleNamespace:
    return SimpleNamespace(
        session_id="public-action-session",
        _session_id="public-action-session",
        chat_history=[],
        scratchpad={},
    )


def _context() -> GroupChatContext:
    return GroupChatContext(_session())


def _sink(
    member_ids: list[str] | None = None,
    *,
    max_public_messages: int = 10,
    max_messages_per_member: int = 2,
) -> tuple[GroupChatRouter, GroupChatContext, SocialTurnPolicy, GroupPublicActionSink]:
    ids = member_ids or ["a1", "a2"]
    router = _router(ids)
    context = _context()
    policy = SocialTurnPolicy(
        "turn-1",
        "room-1",
        max_public_messages=max_public_messages,
        max_messages_per_member=max_messages_per_member,
    )
    sink = GroupPublicActionSink(
        router=router,
        context=context,
        group_id="room-1",
        group_avatar_ids=ids,
        policy=policy,
    )
    return router, context, policy, sink


def _action_session(
    context: GroupChatContext,
    *,
    actor_id: str = "a1",
    member_ids: list[str] | None = None,
    force_reply: bool = False,
    sink: object | None = None,
) -> SimpleNamespace:
    session = context.session
    prepare_group_public_action_state(
        session,
        group_id="room-1",
        actor_id=actor_id,
        allowed_member_ids=member_ids or ["a1", "a2"],
        message_summaries=context.public_message_summaries(),
        force_reply=force_reply,
        action_sink=sink,
    )
    return session


def _names(tools: object) -> set[str]:
    return {
        str(tool.get("function", {}).get("name", ""))
        for tool in tools  # type: ignore[union-attr]
        if isinstance(tool, dict)
    }


def _event_collector() -> tuple[list[dict[str, object]], object]:
    events: list[dict[str, object]] = []

    async def collect(event: dict[str, object]) -> None:
        events.append(event)

    return events, collect


def test_public_action_schemas_are_group_only_not_studio_tools() -> None:
    studio_names = _names(STUDIO_TOOLS)
    assert GROUP_PUBLIC_ACTION_TOOL_NAMES.isdisjoint(studio_names)
    assert GROUP_PUBLIC_ACTION_TOOL_NAMES <= _names(GROUP_PUBLIC_ACTION_TOOLS)

    discussion_tools = _group_chat_tools(
        analysis_only=True,
        include_public_actions=True,
    )
    execution_tools = _group_chat_tools(
        analysis_only=False,
        include_public_actions=True,
    )
    assert GROUP_PUBLIC_ACTION_TOOL_NAMES <= _names(discussion_tools)
    assert GROUP_PUBLIC_ACTION_TOOL_NAMES <= _names(execution_tools)
    assert GROUP_PUBLIC_ACTION_TOOL_NAMES.isdisjoint(
        _names(_group_chat_tools(include_public_actions=False))
    )


def test_group_context_excludes_private_workflow_rows_from_every_public_capability() -> None:
    context = _context()
    public_id = context.append_user(
        "公开问题",
        attachments=[
            {
                "id": "gatt-public",
                "name": "公开方案.md",
                "mime_type": "text/markdown",
                "size": 12,
                "kind": "context_file",
            }
        ],
    )
    context.session.chat_history.append(
        {
            "id": "gmsg-private",
            "role": "assistant",
            "content": "私域审核候选全文",
            "agent_id": "a2",
            "attachments": [
                {
                    "id": "gatt-private",
                    "name": "私域草稿.md",
                    "mime_type": "text/markdown",
                    "size": 99,
                }
            ],
            "metadata": {
                "group_publication_source": "workflow_private",
                "feed_visibility": "panel",
                "is_public": False,
            },
        }
    )

    assert context.public_message_summaries() == {public_id: "公开问题"}
    assert [row.content for row in context.recent()] == ["公开问题"]
    assert context.sender_for_message("gmsg-private") == ""
    assert context.allowed_attachment_ids() == ["gatt-public"]
    assert context.attachments_for_ids(["gatt-private"]) == []
    assert context.toggle_reaction(
        message_id="gmsg-private",
        actor_id="a1",
        emoji="👍",
    ) == (False, [])
    assert context.public_attachment_manifest() == [
        {
            "id": "gatt-public",
            "name": "公开方案.md",
            "mime_type": "text/markdown",
            "size": 12,
            "kind": "context_file",
        }
    ]


@pytest.mark.asyncio
async def test_sink_only_keeps_mentions_confirmed_by_public_text_and_rejects_unknown_actors() -> None:
    _router_instance, _context_instance, _policy, sink = _sink(["a1", "a2"])
    admitted = await sink.handle(
        "publish",
        {
            "group_id": "room-1",
            "agent_id": "a1",
            "content": "请补一下风险边界。",
            "mentioned_avatar_ids": ["a2", "not-in-room", "a1"],
        },
        {"actor_id": "a1", "force_reply": False, "passed": False},
    )
    assert admitted["ok"] is True
    # A model-supplied id is metadata only; without a visible @ in the
    # message it cannot wake another member.
    assert admitted["payload"]["mentioned_avatar_ids"] == []

    visible = await sink.handle(
        "publish",
        {
            "group_id": "room-1",
            "agent_id": "a1",
            "content": "请 @成员-a2 补一下风险边界。",
            "mentioned_avatar_ids": ["a2", "not-in-room"],
        },
        {"actor_id": "a1", "force_reply": False, "passed": False},
    )
    assert visible["ok"] is True
    assert visible["payload"]["mentioned_avatar_ids"] == ["a2"]

    context = _context()
    outside = _action_session(context, actor_id="outsider", member_ids=["a1", "a2"])
    rejected = await dispatch_group_public_action(
        PUBLISH_GROUP_MESSAGE_TOOL,
        {"content": "不应发布"},
        outside,
    )
    assert rejected == "ERROR: group public action actor is not a current room member"


@pytest.mark.asyncio
async def test_member_can_publish_two_messages_but_not_a_third() -> None:
    context = _context()
    session = _action_session(context)
    events, collect = _event_collector()

    for text in ("先确认一下", "这是实际结果"):
        result = await dispatch_group_public_action(
            PUBLISH_GROUP_MESSAGE_TOOL,
            {"content": text},
            session,
            event_callback=collect,
        )
        assert result and not result.startswith("ERROR:")

    rejected = await dispatch_group_public_action(
        PUBLISH_GROUP_MESSAGE_TOOL,
        {"content": "不应该再出现"},
        session,
        event_callback=collect,
    )
    assert rejected == "ERROR: this member already published two messages in the current turn"
    assert group_public_message_count(session) == 2
    assert group_public_actions_seen(session) is True
    assert len(events) == 2
    assert [event["type"] for event in events] == [
        GROUP_PUBLIC_MESSAGE_EVENT,
        GROUP_PUBLIC_MESSAGE_EVENT,
    ]


@pytest.mark.asyncio
async def test_member_prompt_contains_document_body_and_public_attachment_ids(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: list[str] = []

    class FakeRuntime:
        def __init__(self, *_args: object, **_kwargs: object) -> None:
            pass

        async def run_turn(self, *_args: object, **kwargs: object):
            captured.append(str(kwargs.get("system_prompt", "")))
            yield SimpleNamespace(type=EventType.FINAL.value, data={"text": "__SKIP__"})

    monkeypatch.setattr("agenticx.runtime.group_router.AgentRuntime", FakeRuntime)
    router = _router(["a1"])
    session = _session()
    session.context_files = {"brief.md": "需要重点核验权限边界。"}
    session.__group_avatar_ids = ["a1"]
    context = GroupChatContext(session)
    context.append_user(
        "请看附件",
        attachments=[
            {
                "id": "gatt-brief",
                "name": "brief.md",
                "mime_type": "text/markdown",
                "size": 36,
                "kind": "context_file",
            }
        ],
    )

    await router._run_one_target(
        base_session=session,
        context=context,
        group_id="room-1",
        group_name="项目群",
        avatar_id="a1",
        user_input="请看附件",
        quoted_content="",
        should_stop=lambda: False,
        force_reply=False,
    )

    assert len(captured) == 1
    assert "## 本轮附带文档" in captured[0]
    assert "需要重点核验权限边界" in captured[0]
    assert "[gatt-brief] brief.md" in captured[0]


@pytest.mark.asyncio
async def test_public_sink_rejects_the_eleventh_room_message() -> None:
    member_ids = [f"a{i}" for i in range(11)]
    router, context, policy, sink = _sink(member_ids)

    for index, actor_id in enumerate(member_ids[:10]):
        result = await sink.handle(
            "publish",
            {
                "group_id": "room-1",
                "agent_id": actor_id,
                "content": f"公开消息 {index + 1}",
            },
            {"actor_id": actor_id, "force_reply": False, "passed": False},
        )
        assert result["ok"] is True

    rejected = await sink.handle(
        "publish",
        {
            "group_id": "room-1",
            "agent_id": member_ids[10],
            "content": "第十一条不应进入群里",
        },
        {"actor_id": member_ids[10], "force_reply": False, "passed": False},
    )
    assert rejected["ok"] is False
    assert "limit" in str(rejected["error"])
    assert policy.public_message_count == 10
    assert len(context.recent()) == 10
    assert router is not None


@pytest.mark.asyncio
async def test_direct_mention_cannot_pass_and_pass_cannot_publish_later() -> None:
    context = _context()
    forced = _action_session(context, force_reply=True)
    forced_pass = await dispatch_group_public_action(
        PASS_GROUP_TURN_TOOL,
        {"reason": "我没有补充"},
        forced,
    )
    assert forced_pass == "ERROR: a directly @mentioned member cannot pass this turn"
    assert group_public_passed(forced) is False

    target_id = context.append_user("@成员-a1 请给结论")
    forced = _action_session(context, force_reply=True)
    forced_reaction = await dispatch_group_public_action(
        REACT_GROUP_MESSAGE_TOOL,
        {"message_id": target_id, "emoji": "👍"},
        forced,
    )
    assert forced_reaction == (
        "ERROR: a directly @mentioned member must publish a text reply; "
        "a reaction cannot replace the answer"
    )

    optional = _action_session(context, force_reply=False)
    passed = await dispatch_group_public_action(
        PASS_GROUP_TURN_TOOL,
        {"reason": "没有独特信息"},
        optional,
    )
    assert passed == "Turn passed silently. End this turn without ordinary assistant text."
    assert group_public_passed(optional) is True
    rejected = await dispatch_group_public_action(
        PUBLISH_GROUP_MESSAGE_TOOL,
        {"content": "pass 后不允许补发"},
        optional,
    )
    assert rejected == "ERROR: this member already passed and cannot publish later in the same turn"
    assert group_public_message_count(optional) == 0


@pytest.mark.asyncio
async def test_reply_target_is_current_group_message_and_payload_is_bounded() -> None:
    router, context, _policy, sink = _sink()
    parent_id = context.append_user("群里的原消息", sender_name="同事")
    events, collect = _event_collector()
    session = _action_session(context, sink=sink.handle)

    result = await dispatch_group_public_action(
        PUBLISH_GROUP_MESSAGE_TOOL,
        {
            "content": "回复这条消息",
            "reply_to_message_id": parent_id,
        },
        session,
        event_callback=collect,
    )
    assert result and not result.startswith("ERROR:")
    assert events[0]["type"] == GROUP_PUBLIC_MESSAGE_EVENT
    payload = events[0]["data"]
    assert isinstance(payload, dict)
    message_id = str(payload["message_id"])
    assert message_id.startswith("gmsg_")
    assert payload["reply_to_message_id"] == parent_id
    history_row = context.session.chat_history[-1]
    assert history_row["id"] == message_id
    assert history_row["metadata"]["group_message_id"] == message_id
    assert history_row["reply_to_message_id"] == parent_id
    assert history_row["quoted_content"] == "群里的原消息"

    invalid = await dispatch_group_public_action(
        PUBLISH_GROUP_MESSAGE_TOOL,
        {
            "content": "不能引用另一个群的消息",
            "reply_to_message_id": "gmsg-from-another-room",
        },
        session,
        event_callback=collect,
    )
    assert invalid == "ERROR: reply target is not visible in this room"
    assert len(context.session.chat_history) == 2
    crossed_room = await sink.handle(
        "publish",
        {
            "group_id": "another-room",
            "agent_id": "a1",
            "content": "不能跨群发布",
            "reply_to_message_id": parent_id,
        },
        {"actor_id": "a1", "force_reply": False, "passed": False},
    )
    assert crossed_room["ok"] is False
    assert "crossed the active room boundary" in str(crossed_room["error"])
    assert len(context.session.chat_history) == 2
    assert router is not None


@pytest.mark.asyncio
async def test_reaction_toggles_without_spending_public_message_quota() -> None:
    _router_instance, context, policy, sink = _sink()
    target_id = context.append_user("值得保留的消息")
    session = _action_session(context, sink=sink.handle)
    events, collect = _event_collector()

    added = await dispatch_group_public_action(
        REACT_GROUP_MESSAGE_TOOL,
        {"message_id": target_id, "emoji": "👍"},
        session,
        event_callback=collect,
    )
    assert added == "Reaction toggled. Do not add a text reply unless you have unique information."
    assert events[-1]["type"] == GROUP_REACTION_EVENT
    assert policy.public_message_count == 0
    assert group_public_message_count(session) == 0
    assert context.session.chat_history[0]["metadata"]["group_reactions"] == [
        {"emoji": "👍", "actor_ids": ["a1"]}
    ]

    same_turn_second_reaction = await dispatch_group_public_action(
        REACT_GROUP_MESSAGE_TOOL,
        {"message_id": target_id, "emoji": "😂"},
        session,
        event_callback=collect,
    )
    assert same_turn_second_reaction == "ERROR: use at most one sparse reaction in a member turn"

    # Toggle removal happens in a later member turn with fresh action state.
    session = _action_session(context, sink=sink.handle)
    removed = await dispatch_group_public_action(
        REACT_GROUP_MESSAGE_TOOL,
        {"message_id": target_id, "emoji": "👍"},
        session,
        event_callback=collect,
    )
    assert removed.startswith("Reaction toggled")
    assert context.session.chat_history[0]["metadata"]["group_reactions"] == []

    session = _action_session(context, sink=sink.handle)
    illegal_target = await dispatch_group_public_action(
        REACT_GROUP_MESSAGE_TOOL,
        {"message_id": "gmsg-other-room", "emoji": "👍"},
        session,
        event_callback=collect,
    )
    assert illegal_target == "ERROR: reaction target is not visible in this room"
    session = _action_session(context, sink=sink.handle)
    illegal_emoji = await dispatch_group_public_action(
        REACT_GROUP_MESSAGE_TOOL,
        {"message_id": target_id, "emoji": "💣"},
        session,
        event_callback=collect,
    )
    assert illegal_emoji == "ERROR: unsupported reaction emoji"
    assert set(ALLOWED_REACTION_EMOJIS) >= {"👍", "😂", "❤️"}
    assert len(events) == 2


@pytest.mark.asyncio
async def test_reaction_and_pass_are_mutually_terminal_within_one_member_turn() -> None:
    _router_instance, context, _policy, sink = _sink()
    target_id = context.append_user("一条公开消息")
    session = _action_session(context, sink=sink.handle)
    reacted = await dispatch_group_public_action(
        REACT_GROUP_MESSAGE_TOOL,
        {"message_id": target_id, "emoji": "👍"},
        session,
    )
    assert reacted.startswith("Reaction toggled")
    passed = await dispatch_group_public_action(
        PASS_GROUP_TURN_TOOL,
        {"reason": "已经用表情回应"},
        session,
    )
    assert passed == "ERROR: the member already reacted in this turn; end the turn instead of passing"


@pytest.mark.parametrize("phase", [EventType.TOOL_CALL.value, EventType.TOOL_RESULT.value])
def test_public_action_tool_call_and_result_are_not_chat_progress_rows(phase: str) -> None:
    router = _router(["a1"])
    assert (
        router._runtime_event_to_progress_text(
            phase,
            {"name": PUBLISH_GROUP_MESSAGE_TOOL},
        )
        == ""
    )
    assert router._should_enqueue_runtime_event(phase, "") is False
    assert router._should_forward_progress(
        GroupReply(
            agent_id="a1",
            avatar_name="成员-a1",
            avatar_url="",
            content="",
            skipped=True,
            event_type="group_reaction",
        )
    ) is True
