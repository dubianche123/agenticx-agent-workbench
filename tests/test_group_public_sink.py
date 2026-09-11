"""Integration tests for the router-owned public group-message sink."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from agenticx.runtime.group_context import GroupChatContext
from agenticx.runtime.events import EventType
from agenticx.runtime.group_public_actions import (
    dispatch_group_public_action,
    prepare_group_public_action_state,
)
from agenticx.runtime.group_router import (
    GroupChatRouter,
    GroupPublicActionSink,
    GroupReply,
    _group_chat_tools,
    _tool_result_succeeded,
)
from agenticx.runtime.group_social_memory import GroupSocialMemory
from agenticx.runtime.group_social_turn import SocialTurnPolicy


class _Registry:
    def __init__(self, member_ids: list[str]) -> None:
        self._items = {
            member_id: SimpleNamespace(
                name=f"成员-{member_id}",
                avatar_url=f"https://example.test/{member_id}.png",
            )
            for member_id in member_ids
        }

    def get_avatar(self, member_id: str) -> object | None:
        return self._items.get(str(member_id))


def _setup(
    *,
    max_public_messages: int = 10,
    max_messages_per_member: int = 2,
) -> tuple[GroupChatRouter, GroupChatContext, SocialTurnPolicy, GroupPublicActionSink]:
    session = SimpleNamespace(
        session_id="sink-session",
        _session_id="sink-session",
        chat_history=[],
        scratchpad={},
    )
    context = GroupChatContext(session)
    router = GroupChatRouter(
        avatar_registry=_Registry(["a1", "a2"]),
        llm_factory=lambda *_args: None,
        max_tool_rounds=2,
        host_avatar_id="a1",
    )
    policy = SocialTurnPolicy(
        "turn-sink",
        "room-sink",
        max_public_messages=max_public_messages,
        max_messages_per_member=max_messages_per_member,
    )
    sink = GroupPublicActionSink(
        router=router,
        context=context,
        group_id="room-sink",
        group_avatar_ids=["a1", "a2"],
        policy=policy,
    )
    return router, context, policy, sink


@pytest.mark.parametrize(
    ("event_data", "expected"),
    [
        ({"name": "web_search", "result": "ERROR: search timed out"}, False),
        (
            {"name": "web_search", "result": '{"ok": false, "error": "timeout"}'},
            False,
        ),
        ({"name": "web_search", "result": {"success": False}}, False),
        ({"name": "web_search", "result": "No results found."}, True),
        ({"name": "web_search", "success": False}, False),
        ({"name": "web_search", "success": True}, True),
        ({"name": "web_search", "result": {"is_error": False}}, True),
        ({"name": "web_search", "result": {"is_error": True}}, False),
        ({"name": "web_search", "is_error": False}, True),
        ({"name": "web_search", "is_error": True}, False),
    ],
)
def test_tool_result_success_requires_non_error_payload(
    event_data: dict[str, object],
    expected: bool,
) -> None:
    """A failed/serialized web result must not authorize a search claim."""

    assert _tool_result_succeeded(event_data) is expected


def test_group_tools_hide_local_search_when_disabled(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "agenticx.cli.config_manager.ConfigManager.get_value",
        lambda _key: {"enabled": False},
    )
    monkeypatch.setattr(
        "agenticx.studio.web_search.enterprise.enterprise_managed_search_active",
        lambda: False,
    )
    names = {
        str((tool.get("function") or {}).get("name") or "").strip()
        for tool in _group_chat_tools()
        if isinstance(tool, dict)
    }
    assert "web_search" not in names


def test_group_tools_keep_managed_search_when_local_toggle_is_disabled(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "agenticx.cli.config_manager.ConfigManager.get_value",
        lambda _key: {"enabled": False},
    )
    monkeypatch.setattr(
        "agenticx.studio.web_search.enterprise.enterprise_managed_search_active",
        lambda: True,
    )
    names = {
        str((tool.get("function") or {}).get("name") or "").strip()
        for tool in _group_chat_tools()
        if isinstance(tool, dict)
    }
    assert "web_search" in names


@pytest.mark.asyncio
async def test_public_dispatch_gates_search_claim_without_router_sink() -> None:
    """Legacy callers without the router sink still receive safe content."""

    session = SimpleNamespace(scratchpad={})
    prepare_group_public_action_state(
        session,
        group_id="room-sink",
        actor_id="a1",
        allowed_member_ids=["a1"],
        message_summaries={},
    )
    events: list[dict[str, object]] = []
    result = await dispatch_group_public_action(
        "publish_group_message",
        {"content": "我搜了中英文多个来源，目前只是传闻。"},
        session,
        event_callback=events.append,
    )

    assert result and not result.startswith("ERROR:")
    assert events
    assert "检索陈述未被确认" in str(events[0]["data"]["content"])


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("search_result", "expect_unverified"),
    [
        ("web result: https://example.test/source", False),
        ("ERROR: web_search timed out", True),
    ],
)
async def test_search_evidence_is_scoped_through_public_repair(
    monkeypatch: pytest.MonkeyPatch,
    search_result: str,
    expect_unverified: bool,
) -> None:
    """The repair turn inherits only real web_search evidence from the first turn."""

    router, context, policy, sink = _setup()
    setattr(context.session, "__group_avatar_ids", ["a1", "a2"])
    setattr(context.session, "__group_public_action_sink", sink)
    calls = 0
    claim = "我搜了中英文多个来源，结论是当前信息仍需核实。"

    class FakeRuntime:
        def __init__(self, *_args: object, **_kwargs: object) -> None:
            pass

        async def run_turn(self, _user_input: str, session: object, **_kwargs: object):
            nonlocal calls
            calls += 1
            if calls == 1:
                yield SimpleNamespace(
                    type=EventType.TOOL_RESULT.value,
                    data={"name": "web_search", "result": search_result},
                )
                yield SimpleNamespace(
                    type=EventType.FINAL.value,
                    data={"text": claim},
                )
                return
            emitted: list[dict[str, object]] = []

            async def collect(event: dict[str, object]) -> None:
                emitted.append(event)

            await dispatch_group_public_action(
                "publish_group_message",
                {"content": claim},
                session,
                event_callback=collect,
            )
            for event in emitted:
                yield SimpleNamespace(
                    type=str(event["type"]),
                    data=dict(event["data"]),
                )

    monkeypatch.setattr("agenticx.runtime.group_router.AgentRuntime", FakeRuntime)
    reply = await router._run_one_target(
        base_session=context.session,
        context=context,
        group_id="room-sink",
        group_name="Room",
        avatar_id="a1",
        user_input="请查一下最新情况",
        quoted_content="",
        should_stop=lambda: False,
        force_reply=True,
        progress_queue=asyncio.Queue(),
    )

    assert calls == 2
    assert reply.event_type == "group_action_complete"
    assert policy.public_message_count == 1
    content = str(context.session.chat_history[0]["content"])
    assert ("检索陈述未被确认" in content) is expect_unverified
    if not expect_unverified:
        assert content == claim


@pytest.mark.asyncio
async def test_explicit_private_final_gets_one_sink_bounded_public_repair(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    router, context, policy, sink = _setup()
    setattr(context.session, "__group_avatar_ids", ["a1", "a2"])
    setattr(context.session, "__group_public_action_sink", sink)
    runtime_calls: list[tuple[object, list[str]]] = []

    class FakeRuntime:
        def __init__(self, *_args: object, **_kwargs: object) -> None:
            pass

        async def run_turn(self, user_input: str, session: object, **kwargs: object):
            tools = kwargs.get("tools") or []
            names = [
                str(tool.get("function", {}).get("name", ""))
                for tool in tools
                if isinstance(tool, dict)
            ]
            runtime_calls.append((session, names))
            if len(runtime_calls) == 1:
                yield SimpleNamespace(
                    type=EventType.FINAL.value,
                    data={"text": "已有答案"},
                )
                return
            emitted: list[dict[str, object]] = []

            async def collect(event: dict[str, object]) -> None:
                emitted.append(event)

            await dispatch_group_public_action(
                "publish_group_message",
                {"content": "已有答案"},
                session,
                event_callback=collect,
            )
            # A malformed/parallel model response must not turn one repair
            # round into two public side effects.
            duplicate = await dispatch_group_public_action(
                "publish_group_message",
                {"content": "重复发布"},
                session,
                event_callback=collect,
            )
            assert duplicate and duplicate.startswith("ERROR:")
            for event in emitted:
                yield SimpleNamespace(
                    type=str(event["type"]),
                    data=dict(event["data"]),
                )

    monkeypatch.setattr("agenticx.runtime.group_router.AgentRuntime", FakeRuntime)
    reply = await router._run_one_target(
        base_session=context.session,
        context=context,
        group_id="room-sink",
        group_name="Room",
        avatar_id="a1",
        user_input="请回答",
        quoted_content="",
        should_stop=lambda: False,
        force_reply=True,
        progress_queue=asyncio.Queue(),
    )

    assert reply.event_type == "group_action_complete"
    assert reply.skipped is True
    assert len(runtime_calls) == 2
    assert runtime_calls[0][0] is runtime_calls[1][0]
    assert runtime_calls[1][1] == ["publish_group_message"]
    assert policy.public_message_count == 1
    assert len(context.session.chat_history) == 1
    row = context.session.chat_history[0]
    assert row["content"] == "已有答案"
    assert row["group_id"] == "room-sink"
    assert row["is_public"] is True
    assert row["feed_visibility"] == "feed"
    assert row["metadata"]["group_id"] == "room-sink"
    assert row["metadata"]["is_public"] is True
    assert row["metadata"]["feed_visibility"] == "feed"
    assert context.public_message_summaries() == {row["id"]: "已有答案"}


@pytest.mark.asyncio
async def test_visible_mention_private_final_uses_one_canonical_compatibility_publish(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    router, context, policy, sink = _setup()
    setattr(context.session, "__group_avatar_ids", ["a1", "a2"])
    setattr(context.session, "__group_public_action_sink", sink)
    runtime_calls = 0

    class FakeRuntime:
        def __init__(self, *_args: object, **_kwargs: object) -> None:
            pass

        async def run_turn(self, *_args: object, **_kwargs: object):
            nonlocal runtime_calls
            runtime_calls += 1
            if runtime_calls % 2 == 1:
                yield SimpleNamespace(
                    type=EventType.ERROR.value,
                    data={
                        "text": "已自动切换精简模式（这不是报错）。",
                        "severity": "warning",
                        "detector": "context_budget_compact",
                    },
                )
                yield SimpleNamespace(
                    type=EventType.TOKEN.value,
                    data={"text": "思考与工具过程不应公开"},
                )
                yield SimpleNamespace(
                    type=EventType.FINAL.value,
                    data={"text": "原始可见答案"},
                )
                return
            # The repair model may emit ordinary text, tool traces, or an
            # error while failing to call the public action; none of those
            # private repair artifacts may replace the original FINAL or enter
            # the Feed through the compatibility path.
            yield SimpleNamespace(
                type=EventType.TOKEN.value,
                data={"text": "工具过程不应公开"},
            )
            yield SimpleNamespace(
                type=EventType.TOOL_CALL.value,
                data={"name": "private_tool", "arguments": "{}"},
            )
            yield SimpleNamespace(
                type=EventType.ERROR.value,
                data={"text": "repair 错误不应公开"},
            )

    monkeypatch.setattr("agenticx.runtime.group_router.AgentRuntime", FakeRuntime)
    reply = await router._run_one_target(
        base_session=context.session,
        context=context,
        group_id="room-sink",
        group_name="Room",
        avatar_id="a1",
        user_input="@成员-a1 请直接回答",
        quoted_content="",
        should_stop=lambda: False,
        force_reply=True,
        progress_queue=asyncio.Queue(),
    )

    assert runtime_calls == 2
    assert reply.event_type == "group_reply"
    assert reply.skipped is False
    assert reply.content == "原始可见答案"
    assert reply.error == ""
    assert reply.event_data["publication_source"] == (
        "server_compat_fallback_after_repair"
    )
    assert reply.event_data["compatibility_fallback"] is True
    assert reply.event_data["repair_attempted"] is True
    assert reply.event_data["repair_failed"] is True
    assert policy.public_message_count == 1
    assert len(context.session.chat_history) == 1
    row = context.session.chat_history[0]
    assert row["content"] == "原始可见答案"
    assert row["metadata"]["group_publication_source"] == (
        "server_compat_fallback_after_repair"
    )
    assert row["metadata"]["audit_metadata"] == {
        "kind": "group_member_final_after_repair",
        "reason": "publish_only_repair_did_not_publish",
        "source_event": "final",
        "repair_attempted": True,
        "repair_failed": True,
        "server_fallback": True,
    }

    # A second compatibility attempt in the same room/turn must be rejected
    # by the sink's exact-content de-duplication, leaving one Feed row.
    second = await router._run_one_target(
        base_session=context.session,
        context=context,
        group_id="room-sink",
        group_name="Room",
        avatar_id="a1",
        user_input="@成员-a1 请直接回答",
        quoted_content="",
        should_stop=lambda: False,
        force_reply=True,
        progress_queue=asyncio.Queue(),
    )
    assert second.content == ""
    assert "duplicate public message" in second.error
    assert policy.public_message_count == 1
    assert len(context.session.chat_history) == 1


@pytest.mark.asyncio
async def test_explicit_private_final_repair_without_publish_stops_without_feed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    router, context, policy, sink = _setup()
    setattr(context.session, "__group_avatar_ids", ["a1", "a2"])
    setattr(context.session, "__group_public_action_sink", sink)
    calls = 0

    class FakeRuntime:
        def __init__(self, *_args: object, **_kwargs: object) -> None:
            pass

        async def run_turn(self, *_args: object, **_kwargs: object):
            nonlocal calls
            calls += 1
            yield SimpleNamespace(
                type=EventType.FINAL.value,
                data={"text": "仍是私域草稿"},
            )

    monkeypatch.setattr("agenticx.runtime.group_router.AgentRuntime", FakeRuntime)
    reply = await router._run_one_target(
        base_session=context.session,
        context=context,
        group_id="room-sink",
        group_name="Room",
        avatar_id="a1",
        user_input="请回答",
        quoted_content="",
        should_stop=lambda: False,
        force_reply=True,
        progress_queue=asyncio.Queue(),
    )

    assert calls == 2
    assert reply.event_type == "group_reply"
    assert reply.skipped is False
    assert "publish_group_message" in reply.error
    assert reply.event_data["repair_attempted"] is True
    assert reply.event_data["repair_failed"] is True
    assert reply.event_data["compatibility_fallback_attempted"] is False
    assert policy.public_message_count == 0
    assert context.session.chat_history == []
    assert context.public_message_summaries() == {}


@pytest.mark.asyncio
async def test_optional_member_private_final_does_not_trigger_public_repair(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    router, context, policy, sink = _setup()
    setattr(context.session, "__group_avatar_ids", ["a1", "a2"])
    setattr(context.session, "__group_public_action_sink", sink)
    calls = 0

    class FakeRuntime:
        def __init__(self, *_args: object, **_kwargs: object) -> None:
            pass

        async def run_turn(self, *_args: object, **_kwargs: object):
            nonlocal calls
            calls += 1
            yield SimpleNamespace(
                type=EventType.FINAL.value,
                data={"text": "可选回复草稿"},
            )

    monkeypatch.setattr("agenticx.runtime.group_router.AgentRuntime", FakeRuntime)
    reply = await router._run_one_target(
        base_session=context.session,
        context=context,
        group_id="room-sink",
        group_name="Room",
        avatar_id="a1",
        user_input="开放讨论",
        quoted_content="",
        should_stop=lambda: False,
        force_reply=False,
        progress_queue=asyncio.Queue(),
    )

    assert calls == 1
    assert reply.event_type == "group_skipped"
    assert reply.skipped is True
    assert policy.public_message_count == 0
    assert context.session.chat_history == []
    assert context.public_message_summaries() == {}


@pytest.mark.asyncio
async def test_open_floor_mention_never_uses_compatibility_fallback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    router, context, policy, sink = _setup()
    setattr(context.session, "__group_avatar_ids", ["a1", "a2"])
    setattr(context.session, "__group_public_action_sink", sink)
    calls = 0

    class FakeRuntime:
        def __init__(self, *_args: object, **_kwargs: object) -> None:
            pass

        async def run_turn(self, *_args: object, **_kwargs: object):
            nonlocal calls
            calls += 1
            yield SimpleNamespace(
                type=EventType.FINAL.value,
                data={"text": "开放楼层草稿"},
            )

    monkeypatch.setattr("agenticx.runtime.group_router.AgentRuntime", FakeRuntime)
    reply = await router._run_one_target(
        base_session=context.session,
        context=context,
        group_id="room-sink",
        group_name="Room",
        avatar_id="a1",
        user_input="@所有人 请各自给一个判断",
        quoted_content="",
        should_stop=lambda: False,
        # Deliberately pass force_reply to prove the visible @所有人 guard is
        # independent from the caller's generic force flag.
        force_reply=True,
        progress_queue=asyncio.Queue(),
    )

    assert calls == 2
    assert reply.event_data["compatibility_fallback_attempted"] is False
    assert policy.public_message_count == 0
    assert context.session.chat_history == []


@pytest.mark.asyncio
async def test_initial_runtime_error_never_enters_compatibility_publish(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    router, context, policy, sink = _setup()
    setattr(context.session, "__group_avatar_ids", ["a1", "a2"])
    setattr(context.session, "__group_public_action_sink", sink)
    calls = 0

    class FakeRuntime:
        def __init__(self, *_args: object, **_kwargs: object) -> None:
            pass

        async def run_turn(self, *_args: object, **_kwargs: object):
            nonlocal calls
            calls += 1
            yield SimpleNamespace(
                type=EventType.ERROR.value,
                data={"text": "provider error must stay private"},
            )

    monkeypatch.setattr("agenticx.runtime.group_router.AgentRuntime", FakeRuntime)
    reply = await router._run_one_target(
        base_session=context.session,
        context=context,
        group_id="room-sink",
        group_name="Room",
        avatar_id="a1",
        user_input="@成员-a1 请回答",
        quoted_content="",
        should_stop=lambda: False,
        force_reply=True,
        progress_queue=asyncio.Queue(),
    )

    assert calls == 1
    assert "provider error must stay private" in reply.error
    assert policy.public_message_count == 0
    assert context.session.chat_history == []


@pytest.mark.asyncio
@pytest.mark.parametrize("final_text", ["", "__SKIP__"])
async def test_visible_mention_without_usable_final_stays_private_error(
    monkeypatch: pytest.MonkeyPatch,
    final_text: str,
) -> None:
    router, context, policy, sink = _setup()
    setattr(context.session, "__group_avatar_ids", ["a1", "a2"])
    setattr(context.session, "__group_public_action_sink", sink)

    class FakeRuntime:
        def __init__(self, *_args: object, **_kwargs: object) -> None:
            pass

        async def run_turn(self, *_args: object, **_kwargs: object):
            yield SimpleNamespace(
                type=EventType.FINAL.value,
                data={"text": final_text},
            )

    monkeypatch.setattr("agenticx.runtime.group_router.AgentRuntime", FakeRuntime)
    reply = await router._run_one_target(
        base_session=context.session,
        context=context,
        group_id="room-sink",
        group_name="Room",
        avatar_id="a1",
        user_input="@成员-a1 请回答",
        quoted_content="",
        should_stop=lambda: False,
        force_reply=True,
        progress_queue=asyncio.Queue(),
    )

    assert reply.skipped is False
    assert reply.error == "member ended without publish_group_message"
    assert reply.event_data["is_public"] is False
    assert reply.event_data["feed_visibility"] == "panel"
    assert policy.public_message_count == 0
    assert context.session.chat_history == []


@pytest.mark.asyncio
async def test_explicit_error_visibility_preserves_private_publication_audit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    router, context, _policy, _sink = _setup()
    setattr(context.session, "__group_avatar_ids", ["a1", "a2"])

    async def _decision(**_kwargs: object) -> object:
        return SimpleNamespace(
            action="route_to",
            target_ids=["a1"],
            reason="explicit_member_override",
        )

    async def _failed_stream(**_kwargs: object):
        yield GroupReply(
            agent_id="a1",
            avatar_name="成员-a1",
            avatar_url="",
            content="",
            skipped=True,
            error="member ended without publish_group_message",
            event_type="group_skipped",
            event_data={
                "publication_source": "private_final_discarded",
                "is_public": False,
                "feed_visibility": "panel",
                "group_id": "room-sink",
                "compatibility_fallback_attempted": False,
            },
        )

    monkeypatch.setattr(router, "_analyze_intent", _decision)
    monkeypatch.setattr(router, "_run_one_target_stream", _failed_stream)
    monkeypatch.setattr(router, "_project_h2a_fanout", lambda **_kwargs: [])

    replies = [
        reply
        async for reply in router._run_intelligent_turn(
            base_session=context.session,
            context=context,
            group_id="room-sink",
            group_name="Room",
            group_avatar_ids=["a1", "a2"],
            mentioned_avatar_ids=["a1"],
            user_input="@成员-a1 请回答",
            quoted_content="",
            should_stop=lambda: False,
        )
    ]

    terminal = [reply for reply in replies if reply.event_type == "group_reply"]
    assert len(terminal) == 1
    assert terminal[0].skipped is False
    assert terminal[0].error == "member ended without publish_group_message"
    assert terminal[0].event_data == {
        "publication_source": "private_final_discarded",
        "is_public": False,
        "feed_visibility": "panel",
        "group_id": "room-sink",
        "compatibility_fallback_attempted": False,
    }


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("max_public_messages", "max_messages_per_member", "expected_error"),
    [
        (1, 2, "public message limit reached"),
        (10, 1, "public message limit reached"),
    ],
)
async def test_compatibility_fallback_respects_sink_room_and_member_quotas(
    monkeypatch: pytest.MonkeyPatch,
    max_public_messages: int,
    max_messages_per_member: int,
    expected_error: str,
) -> None:
    router, context, policy, sink = _setup(
        max_public_messages=max_public_messages,
        max_messages_per_member=max_messages_per_member,
    )
    setattr(context.session, "__group_avatar_ids", ["a1", "a2"])
    setattr(context.session, "__group_public_action_sink", sink)
    # Consume the selected quota using the same canonical sink before the
    # compatibility attempt.  The fallback must fail closed without writing.
    quota_actor = "a2" if max_public_messages == 1 else "a1"
    admitted = await sink.handle(
        "publish",
        {
            "group_id": "room-sink",
            "agent_id": quota_actor,
            "content": "已有配额消息",
        },
        {"actor_id": quota_actor, "force_reply": False, "passed": False},
    )
    assert admitted["ok"] is True
    calls = 0

    class FakeRuntime:
        def __init__(self, *_args: object, **_kwargs: object) -> None:
            pass

        async def run_turn(self, *_args: object, **_kwargs: object):
            nonlocal calls
            calls += 1
            yield SimpleNamespace(
                type=EventType.FINAL.value,
                data={"text": "超出配额的原始答案"},
            )

    monkeypatch.setattr("agenticx.runtime.group_router.AgentRuntime", FakeRuntime)
    reply = await router._run_one_target(
        base_session=context.session,
        context=context,
        group_id="room-sink",
        group_name="Room",
        avatar_id="a1",
        user_input="@成员-a1 请回答",
        quoted_content="",
        should_stop=lambda: False,
        force_reply=True,
        progress_queue=asyncio.Queue(),
    )

    assert calls == 2
    assert expected_error in reply.error
    assert policy.public_message_count == 1
    assert len(context.session.chat_history) == 1
    assert context.session.chat_history[0]["content"] == "已有配额消息"


@pytest.mark.asyncio
async def test_meta_reply_is_admitted_before_history_and_memory_persistence(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    router, context, policy, _sink = _setup(max_public_messages=1)
    setattr(context.session, "__group_social_turn_policy", policy)
    memory = GroupSocialMemory("room-sink")
    setattr(context.session, "__group_social_memory", memory)

    async def fake_llm(**_kwargs: object) -> str:
        return "负责人公开回复"

    router._call_llm_text = fake_llm  # type: ignore[assignment]
    first = await router._run_meta_project_manager_reply(
        base_session=context.session,
        context=context,
        group_name="Room",
        user_input="第一问",
    )
    second = await router._run_meta_project_manager_reply(
        base_session=context.session,
        context=context,
        group_name="Room",
        user_input="第二问",
    )

    assert first.skipped is False
    assert first.event_data["group_id"] == "room-sink"
    assert first.event_data["is_public"] is True
    assert first.event_data["feed_visibility"] == "feed"
    assert second.skipped is True
    assert second.event_data["public_admission_rejected"] is True
    assert policy.public_message_count == 1
    assert len(context.public_message_summaries()) == 1
    assert len(context.session.chat_history) == 1
    assert memory.style_profile["message_count"] == 1
    row = context.session.chat_history[0]
    assert row["metadata"]["group_id"] == "room-sink"
    assert row["metadata"]["is_public"] is True
    assert row["metadata"]["feed_visibility"] == "feed"


@pytest.mark.asyncio
async def test_explicit_publication_is_persisted_once_when_router_sees_it_again() -> None:
    router, context, policy, sink = _setup()

    admitted = await sink.handle(
        "publish",
        {
            "group_id": "room-sink",
            "agent_id": "a1",
            "content": "这条消息通过显式公开动作发布。",
            "publication_source": "publish_group_message",
        },
        {"actor_id": "a1", "force_reply": False, "passed": False},
    )
    assert admitted["ok"] is True
    payload = dict(admitted["payload"])
    reply = GroupReply(
        agent_id="a1",
        avatar_name="成员-a1",
        avatar_url="",
        content="这条消息通过显式公开动作发布。",
        event_data=payload,
    )
    message_id = str(payload["message_id"])
    assert message_id.startswith("gmsg_")
    assert payload["context_persisted"] is True
    assert payload["publication_source"] == "publish_group_message"
    assert policy.public_message_count == 1
    assert len(context.session.chat_history) == 1

    # The normal router path may see the returned GroupReply again.  The sink
    # marker must prevent a second history row or a second social admission.
    assert router._append_public_reply_to_context(context, reply) == message_id
    assert policy.public_message_count == 1
    assert len(context.session.chat_history) == 1
    row = context.session.chat_history[0]
    assert row["id"] == message_id
    assert row["metadata"]["group_message_id"] == message_id


@pytest.mark.asyncio
async def test_only_admitted_public_replies_update_social_memory(tmp_path) -> None:
    router, context, policy, sink = _setup(max_public_messages=1)
    memory = GroupSocialMemory(
        "room-sink",
        storage_path=tmp_path / "social-memory.json",
    )
    setattr(context.session, "__group_social_memory", memory)
    setattr(context.session, "__group_current_social_topic", "权限边界")

    accepted = await sink.handle(
        "publish",
        {
            "group_id": "room-sink",
            "agent_id": "a1",
            "content": "我来回答权限边界。",
        },
        {"actor_id": "a1", "force_reply": True, "passed": False},
    )
    assert accepted["ok"] is True
    assert memory.style_profile["message_count"] == 1
    assert len(memory.observed_message_ids) == 1

    rejected = await sink.handle(
        "publish",
        {
            "group_id": "room-sink",
            "agent_id": "a2",
            "content": "这条超过本轮群配额，不应该进入记忆。",
        },
        {"actor_id": "a2", "force_reply": False, "passed": False},
    )
    assert rejected["ok"] is False
    assert policy.public_message_count == 1
    assert memory.style_profile["message_count"] == 1
    assert len(memory.observed_message_ids) == 1

    # Workforce candidate/review details are private runtime output.  They
    # may be retained by the workflow's own store, but must not become social
    # relationship memory merely because they contain text.
    context.append_agent(
        agent_id="a2",
        agent_name="成员-a2",
        text="私域工作流候选稿：不应被群关系记忆看到。",
        metadata={
            "group_publication_source": "workflow_private",
            "feed_visibility": "panel",
            "is_public": False,
        },
    )
    assert memory.style_profile["message_count"] == 1
    assert "私域工作流候选稿" not in memory.render_context()


@pytest.mark.asyncio
async def test_admitted_agent_reactions_update_social_memory(tmp_path) -> None:
    _router, context, _policy, sink = _setup()
    memory = GroupSocialMemory(
        "room-sink",
        storage_path=tmp_path / "social-memory.json",
        auto_persist=True,
    )
    setattr(context.session, "__group_social_memory", memory)
    target_id = context.append_user("请对这条公开消息做一个回应。")

    added = await sink.handle(
        "reaction",
        {
            "group_id": "room-sink",
            "agent_id": "a1",
            "message_id": target_id,
            "emoji": "👍",
        },
        {"actor_id": "a1", "force_reply": False, "passed": False},
    )
    assert added["ok"] is True
    assert memory.reaction_relations[0]["actor_ids"] == ["a1"]

    removed = await sink.handle(
        "reaction",
        {
            "group_id": "room-sink",
            "agent_id": "a1",
            "message_id": target_id,
            "emoji": "👍",
        },
        {"actor_id": "a1", "force_reply": False, "passed": False},
    )
    assert removed["ok"] is True
    assert memory.reaction_relations == []


def test_rejected_or_private_reply_is_not_socially_admitted() -> None:
    router, context, _policy, _sink = _setup()
    memory = GroupSocialMemory("room-sink")
    setattr(context.session, "__group_social_memory", memory)
    private = GroupReply(
        agent_id="a1",
        avatar_name="成员-a1",
        avatar_url="",
        content="审核过程细节",
        event_type="group_reply",
        event_data={
            "publication_source": "workflow_private",
            "feed_visibility": "panel",
            "is_public": False,
        },
    )

    # This is the memory adapter's explicit public-only boundary; a private
    # workflow event must not be recorded even when it looks like a reply.
    router._record_public_social_reply(
        context=context,
        reply=private,
        message_id="private-message",
    )
    assert memory.style_profile["message_count"] == 0
    assert memory.observed_message_ids == ()


def test_workflow_final_reply_without_topic_closes_the_single_open_topic() -> None:
    router, context, _policy, _sink = _setup()
    memory = GroupSocialMemory("room-sink")
    setattr(context.session, "__group_social_memory", memory)
    source = {
        "group_id": "room-sink",
        "message_id": "topic-source",
        "agent_id": "a1",
        "content": "请确认权限边界",
        "event_type": "group_reply",
        "is_public": True,
        "role": "assistant",
    }
    assert memory.add_unresolved_topic("权限边界", source_message=source) is True

    router._record_public_social_reply(
        context=context,
        reply=GroupReply(
            agent_id="a1",
            avatar_name="成员-a1",
            avatar_url="",
            content="最终交付已完成",
            event_type="group_reply",
            event_data={
                "feed_visibility": "feed",
                "publication_source": "workflow_final_delivery",
            },
        ),
        message_id="workflow-final-without-topic",
    )
    assert memory.unresolved_topics == {}
