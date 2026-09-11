#!/usr/bin/env python3
"""Group chat room-feel tests: optional speakers, dedupe and live text."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from agenticx.runtime.events import EventType
from agenticx.runtime.group_context import GroupChatContext
from agenticx.runtime.group_facts import GroupExecutionFacts
from agenticx.runtime.group_router import (
    META_LEADER_AGENT_ID,
    GroupChatRouter,
    GroupPublicActionSink,
    GroupReply,
    IntentDecision,
    _is_verbatim_duplicate,
    _restore_discussion_resume_state,
)
from agenticx.runtime.group_social_turn import SocialTurnPolicy
from agenticx.studio.continuation import resolve_continuation_prompt
from agenticx.runtime.harden_flags import (
    group_open_floor_enabled,
    group_open_floor_max_speakers,
)


def _avatar(name: str) -> MagicMock:
    avatar = MagicMock()
    avatar.name = name
    avatar.role = "成员"
    avatar.description = f"负责 {name} 方向"
    avatar.system_prompt = ""
    avatar.avatar_url = ""
    avatar.default_provider = "openai"
    avatar.default_model = "gpt-4"
    return avatar


def _router(ids: list[str] | None = None) -> GroupChatRouter:
    member_ids = ids or ["a1", "a2", "a3"]
    avatars = {member_id: _avatar(member_id) for member_id in member_ids}
    registry = MagicMock()
    registry.get_avatar = MagicMock(side_effect=lambda member_id: avatars.get(str(member_id)))
    router = GroupChatRouter(
        avatar_registry=registry,
        llm_factory=MagicMock(return_value=MagicMock()),
        max_tool_rounds=5,
        host_avatar_id=member_ids[0],
    )
    router._project_h2a_fanout = MagicMock(return_value=[])  # type: ignore[assignment]
    return router


def _session(ids: list[str] | None = None) -> MagicMock:
    session = MagicMock()
    session.session_id = "room-feel-session"
    session._session_id = "room-feel-session"
    session.provider_name = "openai"
    session.model_name = "gpt-4"
    session.workspace_dir = None
    session.context_files = {}
    session.taskspaces = []
    session.scratchpad = {}
    session.chat_history = []
    session.__group_avatar_ids = ids or ["a1", "a2", "a3"]
    return session


def _reply(
    agent_id: str,
    content: str,
    *,
    skipped: bool = False,
    event_type: str = "group_reply",
) -> GroupReply:
    return GroupReply(
        agent_id=agent_id,
        avatar_name=agent_id,
        avatar_url="",
        content=content,
        skipped=skipped,
        event_type=event_type,
    )


def _install_turn_stubs(
    router: GroupChatRouter,
    *,
    decision: IntentDecision,
    replies: dict[str, GroupReply],
    meta_reply: GroupReply | None = None,
    force_reply_calls: list[bool] | None = None,
) -> None:
    async def analyze(**_kwargs):
        return decision

    async def stream(**kwargs):
        member_id = str(kwargs.get("avatar_id") or "")
        if force_reply_calls is not None:
            force_reply_calls.append(bool(kwargs.get("force_reply")))
        yield replies.get(
            member_id,
            _reply(member_id, "", skipped=True, event_type="group_skipped"),
        )

    async def meta(**_kwargs):
        return meta_reply or _reply(META_LEADER_AGENT_ID, "我来接一句。")

    router._analyze_intent = analyze  # type: ignore[assignment]
    router._run_one_target_stream = stream  # type: ignore[assignment]
    router._run_meta_project_manager_reply = meta  # type: ignore[assignment]


async def _collect_intelligent_turn(
    router: GroupChatRouter,
    ids: list[str],
    *,
    user_input: str = "大家随便聊一句",
) -> list[GroupReply]:
    session = _session(ids)
    context = GroupChatContext(session)
    events: list[GroupReply] = []
    async for event in router._run_intelligent_turn(
        base_session=session,
        context=context,
        group_id="g-room",
        group_name="Room",
        group_avatar_ids=ids,
        mentioned_avatar_ids=[],
        user_input=user_input,
        quoted_content="",
        should_stop=lambda: False,
        user_display_name="我",
    ):
        events.append(event)
    return events


@pytest.mark.asyncio
async def test_intent_keeps_open_floor_and_bounds_candidates(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    router = _router()
    monkeypatch.setattr("agenticx.runtime.group_router.group_open_floor_enabled", lambda: True)
    monkeypatch.setattr("agenticx.runtime.group_router.group_open_floor_max_speakers", lambda: 2)

    async def call_llm(**_kwargs):
        return '{"action":"open_floor","target_ids":["a1","a2","a3"],"reason":"casual"}'

    router._call_llm_text = call_llm  # type: ignore[assignment]
    decision = await router._analyze_intent(
        base_session=_session(),
        context=GroupChatContext(_session()),
        group_name="Room",
        group_avatar_ids=["a1", "a2", "a3"],
        user_input="大家随便聊一句",
        explicit_targets=[],
    )
    assert decision.action == "open_floor"
    assert decision.target_ids == ["a1", "a2"]


@pytest.mark.asyncio
async def test_turn_planner_reserves_workflow_for_structured_collaboration() -> None:
    router = _router(["a1", "a2"])
    captured: list[str] = []

    async def call_llm(**kwargs):
        captured.append(str(kwargs.get("prompt") or ""))
        return '{"scope":"discussion","collaboration":false,"reason":"casual"}'

    router._call_llm_text = call_llm  # type: ignore[assignment]
    plan = await router._plan_turn(
        base_session=_session(["a1", "a2"]),
        group_name="Room",
        group_avatar_ids=["a1", "a2"],
        user_input="大家随便聊一句",
        previous_analysis_only=True,
    )
    assert plan.collaboration is False
    assert "普通闲聊" in captured[0]
    assert "不是结构化协作" in captured[0]


@pytest.mark.asyncio
async def test_turn_planner_promotes_explicit_brainstorm_to_visible_collaboration() -> None:
    router = _router([META_LEADER_AGENT_ID, "a2"])

    async def call_llm(**_kwargs):
        return '{"scope":"discussion","collaboration":false,"reason":"single_answer"}'

    router._call_llm_text = call_llm  # type: ignore[assignment]
    plan = await router._plan_turn(
        base_session=_session([META_LEADER_AGENT_ID, "a2"]),
        group_name="Room",
        group_avatar_ids=[META_LEADER_AGENT_ID, "a2"],
        user_input="各位，我们来头脑风暴一下企业 coding harness 最重要的是什么",
        previous_analysis_only=True,
        previous_collaboration=False,
    )

    assert plan.collaboration is True
    assert "explicit_group_collaboration" in plan.reason


@pytest.mark.asyncio
async def test_turn_planner_promotes_explicit_group_delivery_to_execution() -> None:
    router = _router([META_LEADER_AGENT_ID, "a2"])

    async def call_llm(**_kwargs):
        return '{"scope":"discussion","collaboration":false,"reason":"stale_plan"}'

    router._call_llm_text = call_llm  # type: ignore[assignment]
    plan = await router._plan_turn(
        base_session=_session([META_LEADER_AGENT_ID, "a2"]),
        group_name="Room",
        group_avatar_ids=[META_LEADER_AGENT_ID, "a2"],
        user_input="请两位成员分工推进：写一个文件、跑测试、交付审核",
        previous_analysis_only=True,
        previous_collaboration=False,
    )

    assert plan.scope == "execution"
    assert plan.collaboration is True
    assert "explicit_group_execution" in plan.reason


@pytest.mark.asyncio
async def test_turn_planner_executes_before_later_report_risk_language() -> None:
    router = _router([META_LEADER_AGENT_ID, "a2"])

    async def call_llm(**_kwargs):
        return '{"scope":"discussion","collaboration":false,"reason":"stale_plan"}'

    router._call_llm_text = call_llm  # type: ignore[assignment]
    plan = await router._plan_turn(
        base_session=_session([META_LEADER_AGENT_ID, "a2"]),
        group_name="Room",
        group_avatar_ids=[META_LEADER_AGENT_ID, "a2"],
        user_input=(
            "请两位专家分工执行并交付：分别检查后端与前端实现，"
            "再汇总一份含风险和测试建议的验收报告。"
        ),
        previous_analysis_only=True,
        previous_collaboration=False,
    )

    assert plan.scope == "execution"
    assert plan.collaboration is True
    assert "explicit_group_execution" in plan.reason


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "user_input",
    [
        "不要直接执行，先讨论方案",
        "请不要修改代码，先说明原因和风险",
    ],
)
async def test_turn_planner_keeps_negated_execution_read_only(user_input: str) -> None:
    """A prohibition must override an over-eager execution plan."""
    router = _router([META_LEADER_AGENT_ID, "a2"])

    async def call_llm(**_kwargs):
        # Deliberately return the unsafe answer to prove the local guard is
        # fail-safe instead of trusting a stale planner response.
        return '{"scope":"execution","collaboration":true,"reason":"unsafe_plan"}'

    router._call_llm_text = call_llm  # type: ignore[assignment]
    plan = await router._plan_turn(
        base_session=_session([META_LEADER_AGENT_ID, "a2"]),
        group_name="Room",
        group_avatar_ids=[META_LEADER_AGENT_ID, "a2"],
        user_input=user_input,
        previous_analysis_only=False,
        previous_collaboration=False,
    )

    assert plan.scope == "discussion"
    assert "negated_group_execution" in plan.reason


@pytest.mark.asyncio
async def test_turn_planner_keeps_explicit_delivery_when_planner_is_unavailable() -> None:
    router = _router([META_LEADER_AGENT_ID, "a2"])

    async def call_llm(**_kwargs):
        raise RuntimeError("planner unavailable")

    router._call_llm_text = call_llm  # type: ignore[assignment]
    plan = await router._plan_turn(
        base_session=_session([META_LEADER_AGENT_ID, "a2"]),
        group_name="Room",
        group_avatar_ids=[META_LEADER_AGENT_ID, "a2"],
        user_input="请两位成员分工做、执行、交付、审核",
        previous_analysis_only=True,
        previous_collaboration=False,
    )

    assert plan.scope == "execution"
    assert plan.collaboration is True
    assert "plan_llm_error|explicit_group_execution" in plan.reason


@pytest.mark.asyncio
async def test_turn_planner_does_not_force_a_simple_execution_into_workforce() -> None:
    router = _router([META_LEADER_AGENT_ID, "a2"])

    async def call_llm(**_kwargs):
        return '{"scope":"discussion","collaboration":false,"reason":"stale_plan"}'

    router._call_llm_text = call_llm  # type: ignore[assignment]
    plan = await router._plan_turn(
        base_session=_session([META_LEADER_AGENT_ID, "a2"]),
        group_name="Room",
        group_avatar_ids=[META_LEADER_AGENT_ID, "a2"],
        user_input="请帮我修改代码并跑测试",
        previous_analysis_only=True,
        previous_collaboration=False,
    )

    assert plan.scope == "execution"
    assert plan.collaboration is False
    assert "explicit_group_execution" in plan.reason


@pytest.mark.asyncio
async def test_turn_planner_keeps_execution_discussion_read_only() -> None:
    router = _router([META_LEADER_AGENT_ID, "a2"])

    async def call_llm(**_kwargs):
        return '{"scope":"discussion","collaboration":true,"reason":"design_review"}'

    router._call_llm_text = call_llm  # type: ignore[assignment]
    plan = await router._plan_turn(
        base_session=_session([META_LEADER_AGENT_ID, "a2"]),
        group_name="Room",
        group_avatar_ids=[META_LEADER_AGENT_ID, "a2"],
        user_input="请大家讨论一下如何分工推进和跑测试",
        previous_analysis_only=True,
        previous_collaboration=False,
    )

    assert plan.scope == "discussion"
    assert plan.collaboration is True
    assert "explicit_group_execution" not in plan.reason


@pytest.mark.asyncio
async def test_turn_planner_does_not_execute_a_code_howto_question() -> None:
    router = _router([META_LEADER_AGENT_ID, "a2"])

    async def call_llm(**_kwargs):
        return '{"scope":"discussion","collaboration":false,"reason":"howto"}'

    router._call_llm_text = call_llm  # type: ignore[assignment]
    plan = await router._plan_turn(
        base_session=_session([META_LEADER_AGENT_ID, "a2"]),
        group_name="Room",
        group_avatar_ids=[META_LEADER_AGENT_ID, "a2"],
        user_input="请告诉我应该如何修改代码，并说明风险",
        previous_analysis_only=True,
        previous_collaboration=False,
    )

    assert plan.scope == "discussion"
    assert plan.collaboration is False
    assert "explicit_group_execution" not in plan.reason


@pytest.mark.asyncio
async def test_turn_planner_does_not_execute_a_code_plan_discussion() -> None:
    router = _router([META_LEADER_AGENT_ID, "a2"])

    async def call_llm(**_kwargs):
        return '{"scope":"discussion","collaboration":true,"reason":"design_review"}'

    router._call_llm_text = call_llm  # type: ignore[assignment]
    plan = await router._plan_turn(
        base_session=_session([META_LEADER_AGENT_ID, "a2"]),
        group_name="Room",
        group_avatar_ids=[META_LEADER_AGENT_ID, "a2"],
        user_input="请讨论写代码的方案，并评审分工推进是否可行",
        previous_analysis_only=True,
        previous_collaboration=False,
    )

    assert plan.scope == "discussion"
    assert plan.collaboration is True
    assert "explicit_group_execution" not in plan.reason


@pytest.mark.asyncio
async def test_stopped_team_does_not_publish_a_late_final_delivery() -> None:
    router = _router([META_LEADER_AGENT_ID, "a2"])
    session = _session([META_LEADER_AGENT_ID, "a2"])
    stopped = False

    async def call_llm(**_kwargs):
        nonlocal stopped
        stopped = True
        return "这条晚到的最终交付不应进入群 Feed。"

    router._call_llm_text = call_llm  # type: ignore[assignment]
    reply = await router._run_meta_project_manager_reply(
        base_session=session,
        context=GroupChatContext(session),
        group_name="Room",
        user_input="汇总交付",
        delivery_mode=True,
        publication_source="workflow_final_delivery",
        should_stop=lambda: stopped,
    )

    assert reply.skipped is True
    assert reply.content == ""
    assert reply.event_data["control_cancelled"] is True
    assert session.chat_history == []


@pytest.mark.asyncio
async def test_turn_planner_keeps_baton_for_terse_brainstorm_clarification() -> None:
    router = _router([META_LEADER_AGENT_ID, "a2"])

    async def call_llm(**_kwargs):
        return '{"scope":"discussion","collaboration":false,"reason":"short_followup"}'

    router._call_llm_text = call_llm  # type: ignore[assignment]
    plan = await router._plan_turn(
        base_session=_session([META_LEADER_AGENT_ID, "a2"]),
        group_name="Room",
        group_avatar_ids=[META_LEADER_AGENT_ID, "a2"],
        user_input="企业内部自己用的 harness",
        previous_analysis_only=True,
        previous_collaboration=True,
    )

    assert plan.collaboration is True
    assert "continued_group_collaboration" in plan.reason


def test_collaborative_host_prompt_allows_natural_member_mentions() -> None:
    router = _router([META_LEADER_AGENT_ID, "a2"])

    rules = router._group_user_addressing_rules(
        "用户",
        group_avatar_ids=[META_LEADER_AGENT_ID, "a2"],
        speaker_id=META_LEADER_AGENT_ID,
        collaboration_expected=True,
    )

    assert "自然回应" in rules
    assert "具体问题" in rules
    assert "最后必须说明为什么需要下一位" not in rules
    assert "不需要主持会议、宣布轮次或正式交棒" in rules
    assert "@a2" in rules


@pytest.mark.asyncio
async def test_all_member_mentions_are_optional_and_allow_pass() -> None:
    router = _router(["a1", "a2"])
    force_reply_calls: list[bool] = []
    _install_turn_stubs(
        router,
        decision=IntentDecision("open_floor", ["a1", "a2"], "casual"),
        replies={
            "a1": _reply("a1", "我觉得现在更像群聊了。"),
            "a2": _reply("a2", "", skipped=True, event_type="group_skipped"),
        },
        force_reply_calls=force_reply_calls,
    )
    events = await _collect_intelligent_turn(
        router,
        ["a1", "a2"],
        user_input="@所有人 请各自说一句，想跳过也可以。",
    )
    visible = [event for event in events if event.event_type == "group_reply"]
    assert [event.agent_id for event in visible] == ["a1"]
    assert force_reply_calls == [False, False]
    assert any(event.event_type == "group_skipped" for event in events)
    assert all(event.event_type != "group_nudge" for event in events)


@pytest.mark.asyncio
async def test_all_member_passes_do_not_hide_later_members() -> None:
    member_ids = [f"a{index}" for index in range(12)]
    router = _router(member_ids)
    called: list[str] = []

    async def stream(**kwargs):
        member_id = str(kwargs.get("avatar_id") or "")
        called.append(member_id)
        yield _reply(member_id, "", skipped=True, event_type="group_skipped")

    async def meta(**_kwargs):
        return _reply(META_LEADER_AGENT_ID, "那我接一句。")

    router._run_one_target_stream = stream  # type: ignore[assignment]
    router._run_meta_project_manager_reply = meta  # type: ignore[assignment]

    events = await _collect_intelligent_turn(
        router,
        member_ids,
        user_input="@所有人 想说就说，不想说可以跳过。",
    )

    assert len(called) == len(member_ids)
    assert set(called) == set(member_ids)
    assert not any(event.event_type == "group_reply" for event in events)


@pytest.mark.asyncio
async def test_explicit_host_and_member_both_get_a_turn() -> None:
    router = _router([META_LEADER_AGENT_ID, "a2"])
    called: list[str] = []

    async def stream(**kwargs):
        member_id = str(kwargs.get("avatar_id") or "")
        called.append(member_id)
        yield _reply(member_id, f"{member_id} 的判断")

    router._run_one_target_stream = stream  # type: ignore[assignment]
    events = [
        event
        async for event in router._run_intelligent_turn(
            base_session=_session([META_LEADER_AGENT_ID, "a2"]),
            context=GroupChatContext(_session([META_LEADER_AGENT_ID, "a2"])),
            group_id="g-room",
            group_name="Room",
            group_avatar_ids=[META_LEADER_AGENT_ID, "a2"],
            mentioned_avatar_ids=[META_LEADER_AGENT_ID, "a2"],
            user_input="@个人助手 @a2 你们都说说",
            quoted_content="",
            should_stop=lambda: False,
            user_display_name="我",
        )
    ]

    assert called == [META_LEADER_AGENT_ID, "a2"]
    assert [
        event.agent_id for event in events if event.event_type == "group_reply"
    ] == [META_LEADER_AGENT_ID, "a2"]


@pytest.mark.asyncio
async def test_explicit_member_error_is_not_repeated_as_generic_failure() -> None:
    router = _router(["a1"])
    session = _session(["a1"])
    context = GroupChatContext(session)

    async def stream(**_kwargs):
        yield GroupReply(
            agent_id="a1",
            avatar_name="a1",
            avatar_url="",
            content="",
            skipped=False,
            error="模型调用失败",
            event_type="group_reply",
        )

    router._run_one_target_stream = stream  # type: ignore[assignment]
    events = [
        event
        async for event in router._run_intelligent_turn(
            base_session=session,
            context=context,
            group_id="g-room",
            group_name="Room",
            group_avatar_ids=["a1"],
            mentioned_avatar_ids=["a1"],
            user_input="@a1 回答一下",
            quoted_content="",
            should_stop=lambda: False,
            user_display_name="我",
        )
    ]

    errors = [event.error for event in events if event.error]
    assert errors == ["模型调用失败"]


@pytest.mark.asyncio
async def test_target_stream_normalizes_runtime_exception_to_member_error() -> None:
    router = _router(["a1"])

    async def fail_target(**_kwargs):
        raise RuntimeError("provider disconnected")

    router._run_one_target = fail_target  # type: ignore[assignment]
    events = [
        event
        async for event in router._run_one_target_stream(
            base_session=_session(["a1"]),
            context=GroupChatContext(_session(["a1"])),
            group_id="g-room",
            group_name="Room",
            avatar_id="a1",
            user_input="@a1 回答一下",
            quoted_content="",
            should_stop=lambda: False,
            force_reply=True,
        )
    ]

    assert len(events) == 1
    assert events[0].agent_id == "a1"
    assert events[0].event_type == "group_reply"
    assert events[0].error == "provider disconnected"


@pytest.mark.asyncio
async def test_open_floor_all_skip_uses_short_meta_fallback() -> None:
    router = _router(["a1", "a2"])
    _install_turn_stubs(
        router,
        decision=IntentDecision("open_floor", ["a1", "a2"], "casual"),
        replies={
            "a1": _reply("a1", "", skipped=True, event_type="group_skipped"),
            "a2": _reply("a2", "", skipped=True, event_type="group_skipped"),
        },
        meta_reply=_reply(META_LEADER_AGENT_ID, "那我先接一句。"),
    )
    events = await _collect_intelligent_turn(router, ["a1", "a2"])
    assert any(
        event.event_type == "group_reply" and event.agent_id == META_LEADER_AGENT_ID
        for event in events
    )
    assert all(event.event_type != "group_nudge" for event in events)


@pytest.mark.asyncio
async def test_collaborative_discussion_follows_visible_member_handoff() -> None:
    router = _router(["a1", "a2"])
    session = _session(["a1", "a2"])
    setattr(session, "_group_analysis_only", True)
    context = GroupChatContext(session, max_items=20)
    context.append_user("一起头脑风暴 coding harness", sender_name="我")
    call_order: list[str] = []
    seen_context: dict[str, str] = {}

    async def fake_target_stream(**kwargs):
        avatar_id = str(kwargs["avatar_id"])
        call_order.append(avatar_id)
        seen_context[avatar_id] = kwargs["context"].render_recent_dialogue()
        if avatar_id == "a1":
            yield _reply(
                avatar_id,
                "a1 的独立看法\n还需要验证实现风险，@a2：请接着检查边界。",
            )
        else:
            assert "a1 的独立看法" in str(kwargs["user_input"])
            yield _reply(avatar_id, "a2 承接上文后的增量判断")

    router._run_one_target_stream = fake_target_stream  # type: ignore[assignment]
    router._project_a2a_message_edge = MagicMock(return_value=[])  # type: ignore[assignment]

    events = [
        event
        async for event in router._run_collaborative_discussion_turn(
            base_session=session,
            context=context,
            group_id="g-discussion",
            group_name="讨论群",
            group_avatar_ids=["a1", "a2"],
            user_input="一起头脑风暴 coding harness",
            quoted_content="",
            should_stop=lambda: False,
        )
    ]

    assert call_order == ["a1", "a2"]
    assert "a1 的独立看法" not in seen_context["a1"]
    assert [
        event.content
        for event in events
        if event.event_type == "group_reply" and event.content
    ] == [
        "a1 的独立看法\n还需要验证实现风险，@a2：请接着检查边界。",
        "a2 承接上文后的增量判断",
    ]


def test_handoff_accepts_reason_on_line_before_named_member() -> None:
    avatars = {
        "host": _avatar("产品需求全流程 · 产品策划师"),
        "tech": _avatar("产品需求全流程 · 技术负责人"),
    }
    registry = MagicMock()
    registry.get_avatar = MagicMock(
        side_effect=lambda member_id: avatars.get(str(member_id))
    )
    router = GroupChatRouter(
        avatar_registry=registry,
        llm_factory=MagicMock(return_value=MagicMock()),
        max_tool_rounds=5,
        host_avatar_id="host",
    )

    text = (
        "先建立最小安全门禁，再并行提升开发效率。\n"
        "理由：需要技术可行性评估来确认实现边界。\n"
        "@产品需求全流程 · 技术负责人：请补充组件优先级和依赖关系。"
    )

    assert router._handoff_targets_in_reply(
        text,
        speaker_id="host",
        group_avatar_ids=["host", "tech"],
    ) == ["tech"]


def test_handoff_accepts_concrete_question_without_reason() -> None:
    avatars = {
        "host": _avatar("产品需求全流程 · 产品策划师"),
        "tech": _avatar("产品需求全流程 · 技术负责人"),
    }
    registry = MagicMock()
    registry.get_avatar = MagicMock(
        side_effect=lambda member_id: avatars.get(str(member_id))
    )
    router = GroupChatRouter(
        avatar_registry=registry,
        llm_factory=MagicMock(return_value=MagicMock()),
        max_tool_rounds=5,
        host_avatar_id="host",
    )

    assert router._handoff_targets_in_reply(
        "@产品需求全流程 · 技术负责人",
        speaker_id="host",
        group_avatar_ids=["host", "tech"],
    ) == []
    assert router._handoff_targets_in_reply(
        "@产品需求全流程 · 技术负责人：请补充组件优先级。",
        speaker_id="host",
        group_avatar_ids=["host", "tech"],
    ) == ["tech"]


@pytest.mark.asyncio
async def test_interrupted_discussion_resumes_with_next_member_and_original_request() -> None:
    router = _router(["a1", "a2"])
    session = _session(["a1", "a2"])
    session.chat_history = [
        {
            "role": "user",
            "content": "一起头脑风暴 coding harness",
            "agent_id": "user",
        },
            {
                "role": "assistant",
                "content": "a1 的独立看法",
                "agent_id": "a1",
                "avatar_name": "成员一",
                "group_id": "g-discussion",
                "is_public": True,
                "feed_visibility": "feed",
            },
        {
            "role": "tool",
            "content": "🔁 手动续跑 · 原因：中断",
            "agent_id": "meta",
        },
    ]
    setattr(session, "_group_analysis_only", True)
    setattr(session, "_group_turn_collaboration", True)
    call_order: list[str] = []
    seen_inputs: list[str] = []

    async def fail_plan(**_kwargs):
        raise AssertionError("continuation must reuse the previous turn plan")

    async def fake_target_stream(**kwargs):
        call_order.append(str(kwargs["avatar_id"]))
        seen_inputs.append(str(kwargs["user_input"]))
        yield _reply(str(kwargs["avatar_id"]), "a2 的独立看法")

    router._plan_turn = fail_plan  # type: ignore[assignment]
    router._run_one_target_stream = fake_target_stream  # type: ignore[assignment]

    events = [
        event
        async for event in router.run_group_turn(
            base_session=session,
            group_id="g-discussion",
            group_name="讨论群",
            routing="team",
            group_avatar_ids=["a1", "a2"],
            mentioned_avatar_ids=[],
            user_input=resolve_continuation_prompt("manual"),
            quoted_content="",
            should_stop=lambda: False,
            persist_user_message=False,
        )
    ]

    assert call_order == ["a2"]
    assert seen_inputs == ["一起头脑风暴 coding harness"]
    assert [
        event.content
        for event in events
        if event.event_type == "group_reply" and event.content
    ] == ["a2 的独立看法"]


@pytest.mark.asyncio
async def test_collaborative_discussion_does_not_fabricate_missing_handoff() -> None:
    router = _router(["a1", "a2"])
    session = _session(["a1", "a2"])
    setattr(session, "_group_turn_collaboration", True)
    context = GroupChatContext(session)

    async def fake_target_stream(**kwargs):
        yield _reply(str(kwargs["avatar_id"]), "相同的建议")

    router._run_one_target_stream = fake_target_stream  # type: ignore[assignment]
    events = [
        event
        async for event in router._run_collaborative_discussion_turn(
            base_session=session,
            context=context,
            group_id="g-discussion",
            group_name="讨论群",
            group_avatar_ids=["a1", "a2"],
            user_input="一起讨论",
            quoted_content="",
            should_stop=lambda: False,
        )
    ]

    replies = [event for event in events if event.event_type == "group_reply"]
    assert [event.agent_id for event in replies] == ["a1"]
    assert "@a2" not in replies[0].content
    assert "视角补上关键判断" not in replies[0].content


def test_handoff_prompt_exposes_member_descriptions_without_system_prompts() -> None:
    router = _router(["a1", "a2"])
    rules = router._group_user_addressing_rules(
        "我",
        group_avatar_ids=["a1", "a2"],
        speaker_id="a1",
    )
    assert "@a2（成员；负责 a2 方向）" in rules
    assert "群成员与职责" in rules
    assert "自然点名" in rules


def test_discussion_resume_state_stops_after_persisted_meta_summary() -> None:
    restored = _restore_discussion_resume_state(
        [
            {"role": "user", "content": "讨论一下", "agent_id": "user"},
            {
                "role": "assistant",
                "content": "成员意见",
                "agent_id": "a1",
                "group_id": "g-discussion",
                "is_public": True,
                "feed_visibility": "feed",
            },
            {
                "role": "assistant",
                "content": "最终收口",
                "agent_id": META_LEADER_AGENT_ID,
                "group_id": "g-discussion",
                "is_public": True,
                "feed_visibility": "feed",
            },
        ],
        ["a1", "a2"],
    )
    assert restored.original_user_input == "讨论一下"
    assert [reply.agent_id for reply in restored.spoken] == ["a1"]
    assert restored.summary_complete is True


@pytest.mark.asyncio
async def test_open_floor_drops_exact_duplicate_reply() -> None:
    router = _router(["a1", "a2"])
    _install_turn_stubs(
        router,
        decision=IntentDecision("open_floor", ["a1", "a2"], "casual"),
        replies={
            "a1": _reply("a1", "我也这么觉得"),
            "a2": _reply("a2", "我也这么觉得"),
        },
    )
    events = await _collect_intelligent_turn(router, ["a1", "a2"])
    visible = [event for event in events if event.event_type == "group_reply"]
    assert [event.agent_id for event in visible] == ["a1"]
    assert any(
        event.event_type == "group_skipped" and event.agent_id == "a2"
        for event in events
    )


def test_duplicate_rule_is_deliberately_literal() -> None:
    assert _is_verbatim_duplicate(" 好的\n", ["好的"]) is True
    assert _is_verbatim_duplicate("好的呀", ["好的"]) is False


def test_open_floor_flags(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("agenticx.runtime.harden_flags._config_bool", lambda _key: None)
    monkeypatch.setattr("agenticx.runtime.harden_flags._config_int", lambda _key: None)
    monkeypatch.delenv("AGX_GROUP_OPEN_FLOOR", raising=False)
    monkeypatch.delenv("AGX_GROUP_OPEN_FLOOR_MAX_SPEAKERS", raising=False)
    assert group_open_floor_enabled() is True
    assert group_open_floor_max_speakers() == 2
    monkeypatch.setenv("AGX_GROUP_OPEN_FLOOR_MAX_SPEAKERS", "9")
    assert group_open_floor_max_speakers() == 3


def test_token_event_maps_to_ephemeral_group_delta() -> None:
    event = GroupChatRouter._token_event_to_group_reply(
        agent_id="a1",
        avatar_name="成员一",
        avatar_url="",
        data={"text": "正在回答"},
    )
    assert event is not None
    assert event.event_type == "group_token"
    assert event.content == "正在回答"
    assert event.skipped is True
    assert GroupChatRouter._should_forward_progress(event) is True


@pytest.mark.asyncio
async def test_member_runtime_keeps_token_and_plain_final_out_of_public_feed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = 0

    class FakeRuntime:
        def __init__(self, *_args, **_kwargs) -> None:
            pass

        async def run_turn(self, *_args, **_kwargs):
            nonlocal calls
            calls += 1
            yield SimpleNamespace(type=EventType.TOKEN.value, data={"text": "群"})
            yield SimpleNamespace(type=EventType.TOKEN.value, data={"text": "聊"})
            yield SimpleNamespace(type=EventType.FINAL.value, data={"text": "群聊回复"})

    monkeypatch.setattr("agenticx.runtime.group_router.AgentRuntime", FakeRuntime)
    router = _router(["a1"])
    session = _session(["a1"])
    context = GroupChatContext(session)
    sink = GroupPublicActionSink(
        router=router,
        context=context,
        group_id="g-room",
        group_avatar_ids=["a1"],
        policy=SocialTurnPolicy("turn-token", "g-room"),
    )
    setattr(session, "__group_public_action_sink", sink)
    queue: asyncio.Queue[GroupReply] = asyncio.Queue()
    reply = await router._run_one_target(
        base_session=session,
        context=context,
        group_id="g-room",
        group_name="Room",
        avatar_id="a1",
        user_input="说一句",
        quoted_content="",
        should_stop=lambda: False,
        force_reply=True,
        progress_queue=queue,
    )
    queued_events = []
    while not queue.empty():
        event = queue.get_nowait()
        queued_events.append(event)
    assert all(event.event_type != "group_token" for event in queued_events)
    assert all(event.content not in {"群", "聊"} for event in queued_events)
    assert calls == 2
    assert reply.event_type == "group_reply"
    assert reply.skipped is False
    assert reply.content == ""
    assert "publish_group_message" in reply.error
    assert reply.event_data["publication_source"] == "private_final_discarded"
    assert reply.event_data["is_public"] is False
    assert reply.event_data["repair_attempted"] is True
    assert reply.event_data["repair_failed"] is True
    assert session.chat_history == []


@pytest.mark.asyncio
async def test_team_delivery_prompt_preserves_explicit_output_format() -> None:
    router = _router(["a1"])
    captured: list[str] = []

    async def call_llm(**kwargs):
        captured.append(str(kwargs.get("prompt") or ""))
        return "群聊验收通过"

    router._call_llm_text = call_llm  # type: ignore[assignment]
    session = _session(["a1"])
    reply = await router._run_meta_project_manager_reply(
        base_session=session,
        context=GroupChatContext(session),
        group_name="Room",
        user_input="最终只输出一句：群聊验收通过",
        delivery_mode=True,
        facts=GroupExecutionFacts(),
    )
    assert reply.content == "群聊验收通过"
    assert "只输出一句" in captured[0]
    assert "优先于本节全部模板要求" in captured[0]
