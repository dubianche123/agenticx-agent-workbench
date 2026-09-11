from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from agenticx.runtime.group_router import (
    META_LEADER_AGENT_ID,
    GroupChatRouter,
    GroupReply,
    IntentDecision,
    TurnPlan,
    expand_mentions_with_meta_leader,
)
from agenticx.runtime.group_social_turn import SocialTurnPolicy


def _router_with_avatars(
    avatars: dict[str, SimpleNamespace],
    *,
    host_enabled: bool = False,
) -> GroupChatRouter:
    registry = MagicMock()
    registry.get_avatar.side_effect = lambda avatar_id: avatars.get(avatar_id)
    return GroupChatRouter(
        avatar_registry=registry,
        llm_factory=MagicMock(return_value=MagicMock()),
        max_tool_rounds=3,
        host_avatar_id=next(iter(avatars), "") if host_enabled else "",
    )


def test_visible_mentions_match_complete_names_and_all_members() -> None:
    avatars = {
        "product": SimpleNamespace(name="产品需求全流程 · 产品策划师"),
        "tech": SimpleNamespace(name="技术负责人"),
        "qa": SimpleNamespace(name="质量专家"),
    }
    router = _router_with_avatars(avatars)

    assert router._mention_targets_in_text(
        "@产品需求全流程 · 产品策划师 请先梳理；再请 @技术负责人 接着说。",
        speaker_id="qa",
        group_avatar_ids=list(avatars),
    ) == ["product", "tech"]
    assert router._mention_targets_in_text(
        "@所有人 依次给一个判断",
        speaker_id="tech",
        group_avatar_ids=list(avatars),
    ) == ["product", "qa"]


def test_expand_all_members_keeps_room_order_without_including_coordinator() -> None:
    assert expand_mentions_with_meta_leader(
        "@所有人 请依次回答",
        [],
        "个人助手",
        ["product", "tech", "qa"],
    ) == ["product", "tech", "qa"]


def test_disabled_host_filters_even_forged_meta_mentions() -> None:
    assert expand_mentions_with_meta_leader(
        "@主持人 请编排",
        [META_LEADER_AGENT_ID],
        "个人助手",
        ["product", "tech"],
        include_meta=False,
        require_visible_meta_mention=True,
    ) == []


def test_visible_host_control_does_not_resurrect_unlisted_product_meta() -> None:
    assert expand_mentions_with_meta_leader(
        "@个人助手 请回答",
        [],
        "产品经理",
        ["product", "tech"],
        include_meta=True,
        require_visible_meta_mention=True,
    ) == []
    assert expand_mentions_with_meta_leader(
        "@主持人 请回答",
        [],
        "产品经理",
        ["product", "tech"],
        include_meta=True,
        require_visible_meta_mention=True,
    ) == [META_LEADER_AGENT_ID]


def test_member_prompt_exposes_natural_visible_mentions() -> None:
    avatars = {
        "product": SimpleNamespace(name="产品经理"),
        "tech": SimpleNamespace(name="技术负责人"),
    }
    router = _router_with_avatars(avatars)

    rules = router._group_user_addressing_rules(
        "用户",
        group_avatar_ids=list(avatars),
        speaker_id="product",
    )

    assert "自然点名" in rules
    assert "具体问题" in rules
    assert "@技术负责人" in rules
    assert "@产品经理" not in rules
    assert "@主持人" not in rules
    assert "必须先说清楚为什么" not in rules
    assert "不需要主持会议、宣布轮次或正式交棒" in rules

    hosted_rules = _router_with_avatars(avatars, host_enabled=True)._group_user_addressing_rules(
        "用户",
        group_avatar_ids=list(avatars),
        speaker_id="tech",
    )
    assert "@主持人" in hosted_rules
    assert "具体问题" in hosted_rules
    assert "为什么需要对方" not in hosted_rules


@pytest.mark.asyncio
async def test_agent_handoff_requires_concrete_question_and_wakes_only_one_member() -> None:
    avatars = {
        f"member-{index}": SimpleNamespace(name=f"成员{index}")
        for index in range(1, 7)
    }
    router = _router_with_avatars(avatars)
    called: list[str] = []
    received_inputs: list[str] = []

    async def fake_target_stream(**kwargs):
        avatar_id = str(kwargs["avatar_id"])
        called.append(avatar_id)
        received_inputs.append(str(kwargs["user_input"]))
        yield GroupReply(
            agent_id=avatar_id,
            avatar_name=avatars[avatar_id].name,
            avatar_url="",
            content=f"{avatars[avatar_id].name} 的补充",
            skipped=False,
            event_type="group_reply",
        )

    router._run_one_target_stream = fake_target_stream  # type: ignore[assignment]
    router._project_a2a_message_edge = lambda **_kwargs: []  # type: ignore[method-assign]
    router._maybe_yield_debate_nudge = lambda _session: []  # type: ignore[method-assign]

    group_avatar_ids = list(avatars)
    initial = GroupReply(
        agent_id="starter",
        avatar_name="发起者",
        avatar_url="",
        content=(
            "前端边界已经明确。\n\n"
            + " ".join(f"@成员{index}" for index in range(1, 7))
            + "：请先检查测试门禁。"
        ),
        skipped=False,
        event_type="group_reply",
    )
    responded = {"starter"}

    replies = [
        reply
        async for reply in router._emit_mention_follow_ups(
            reply=initial,
            group_avatar_ids=group_avatar_ids,
            base_session=SimpleNamespace(scratchpad={}),
            context=MagicMock(),
            group_id="group-1",
            group_name="项目群",
            should_stop=lambda: False,
            user_display_name="我",
            hops=1,
            responded_this_turn=responded,
        )
    ]

    assert called == ["member-1"]
    assert len(received_inputs) == 1
    assert "前端边界已经明确" in received_inputs[0]
    assert "点名给你的具体问题（优先回答）" in received_inputs[0]
    assert "@成员1" in received_inputs[0]
    assert "明确交接" not in received_inputs[0]
    assert "不得另起炉灶" in received_inputs[0]
    assert responded == {"starter", "member-1"}
    assert not any(reply.agent_id == "member-2" for reply in replies)


def test_bare_agent_mention_is_not_a_handoff() -> None:
    avatars = {"qa": SimpleNamespace(name="质量官")}
    router = _router_with_avatars(avatars)

    assert router._handoff_targets_in_reply(
        "我说完了。\n\n@质量官 请继续。",
        speaker_id="product",
        group_avatar_ids=["qa"],
    ) == []
    assert router._handoff_targets_in_reply(
        "实现边界已经明确，还需要核验回归风险，@质量官：请补充测试门禁。",
        speaker_id="product",
        group_avatar_ids=["qa"],
    ) == ["qa"]
    assert router._handoff_targets_in_reply(
        "我先给产品结论。\n@质量官：中间帮我看下回归风险。\n最后补一句发布范围不变。",
        speaker_id="product",
        group_avatar_ids=["qa"],
    ) == ["qa"]


def test_followup_prompt_preserves_long_reply_tail_and_requires_continuity() -> None:
    router = _router_with_avatars({"qa": SimpleNamespace(name="质量官")})
    head = "已经确认的产品结论。" + ("边界证据" * 4_000)
    handoff = "实现边界已经明确，还需要核验回归风险，@质量官：请接着补齐测试门禁。"

    prompt = router._followup_prompt_for_mention(
        speaker_name="产品策划师",
        cited_body=f"{head}\n\n{handoff}",
        user_display_name="我",
    )

    assert "不得另起炉灶" in prompt
    assert "先明确承接上一位成员的一个具体结论" in prompt
    assert f"--- 点名给你的具体问题（优先回答）---\n{handoff}" in prompt
    assert "明确交接" not in prompt
    assert prompt.endswith(handoff)
    assert "[中间内容因上下文长度省略]" in prompt


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("content", "event_data", "expected_called"),
    [
        (
            "结论已经明确。",
            {"mentioned_avatar_ids": ["tech"]},
            [],
        ),
        (
            "结论已经明确，需要补充实现风险。\n\n"
            "@技术负责人：请补充回归门禁。",
            {},
            ["tech"],
        ),
    ],
)
async def test_followup_wakeup_requires_a_visible_member_mention(
    content: str,
    event_data: dict[str, object],
    expected_called: list[str],
) -> None:
    avatars = {
        "product": SimpleNamespace(name="产品经理"),
        "tech": SimpleNamespace(name="技术负责人"),
    }
    router = _router_with_avatars(avatars)
    called: list[str] = []

    async def fake_target_stream(**kwargs):
        avatar_id = str(kwargs["avatar_id"])
        called.append(avatar_id)
        yield GroupReply(
            agent_id=avatar_id,
            avatar_name=avatars[avatar_id].name,
            avatar_url="",
            content="技术结论。",
            skipped=False,
            event_type="group_reply",
        )

    router._run_one_target_stream = fake_target_stream  # type: ignore[assignment]
    router._project_a2a_message_edge = lambda **_kwargs: []  # type: ignore[method-assign]
    initial = GroupReply(
        agent_id="product",
        avatar_name="产品经理",
        avatar_url="",
        content=content,
        skipped=False,
        event_type="group_reply",
        event_data=event_data,
    )

    _events = [
        event
        async for event in router._emit_mention_follow_ups(
            reply=initial,
            group_avatar_ids=["product", "tech"],
            base_session=SimpleNamespace(scratchpad={}),
            context=MagicMock(),
            group_id="group-1",
            group_name="项目群",
            should_stop=lambda: False,
            user_display_name="我",
            hops=1,
            responded_this_turn={"product"},
        )
    ]

    assert called == expected_called


@pytest.mark.asyncio
async def test_visible_mentions_override_team_routing_in_textual_order() -> None:
    avatars = {
        "product": SimpleNamespace(name="产品经理"),
        "tech": SimpleNamespace(name="技术负责人"),
    }
    router = _router_with_avatars(avatars)
    captured: list[list[str]] = []
    team_called = False

    async def fake_plan(**_kwargs):
        return TurnPlan(scope="discussion", collaboration=True, reason="stub")

    async def fake_intelligent(**kwargs):
        captured.append(list(kwargs["mentioned_avatar_ids"]))
        yield GroupReply(
            agent_id="tech",
            avatar_name="技术负责人",
            avatar_url="",
            content="先说技术判断。",
            skipped=False,
            event_type="group_reply",
        )

    async def fake_team(**_kwargs):
        nonlocal team_called
        team_called = True
        if False:
            yield  # pragma: no cover

    router._plan_turn = fake_plan  # type: ignore[assignment]
    router._run_intelligent_turn = fake_intelligent  # type: ignore[assignment]
    router._run_team_turn = fake_team  # type: ignore[assignment]
    session = SimpleNamespace(
        session_id="mention-order",
        provider_name="openai",
        model_name="test",
        workspace_dir=None,
        context_files={},
        taskspaces=[],
        scratchpad={},
        chat_history=[],
    )

    replies = [
        reply
        async for reply in router.run_group_turn(
            base_session=session,
            group_id="group-1",
            group_name="项目群",
            routing="team",
            group_avatar_ids=["product", "tech"],
            mentioned_avatar_ids=["tech", "product"],
            user_input="@技术负责人 先说，再由 @产品经理 补充",
            quoted_content="",
            should_stop=lambda: False,
        )
    ]

    public_replies = [reply for reply in replies if reply.event_type == "group_reply"]
    assert [reply.agent_id for reply in public_replies] == ["tech"]
    assert captured == [["tech", "product"]]
    assert team_called is False


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("host_enabled", "user_input", "expected_path", "expected_mentions"),
    [
        (False, "请给一个判断", "intelligent", []),
        (True, "请给一个判断", "intelligent", []),
        (True, "@主持人 请组织团队评审", "intelligent", ["product"]),
    ],
)
async def test_optional_host_uses_intelligent_route_and_explicit_host_target(
    host_enabled: bool,
    user_input: str,
    expected_path: str,
    expected_mentions: list[str],
) -> None:
    avatars = {
        "product": SimpleNamespace(name="产品经理"),
        "tech": SimpleNamespace(name="技术负责人"),
    }
    router = _router_with_avatars(avatars, host_enabled=host_enabled)
    calls: list[tuple[str, list[str], bool]] = []

    async def fake_plan(**_kwargs):
        return TurnPlan(scope="discussion", collaboration=True, reason="stub")

    async def fake_intelligent(**kwargs):
        calls.append((
            "intelligent",
            list(kwargs["mentioned_avatar_ids"]),
            False,
        ))
        yield GroupReply(
            agent_id="product",
            avatar_name="产品经理",
            avatar_url="",
            content="产品判断。",
            skipped=False,
            event_type="group_reply",
        )

    async def fake_discussion(**_kwargs):
        calls.append(("discussion", [], False))
        yield GroupReply(
            agent_id="tech",
            avatar_name="技术负责人",
            avatar_url="",
            content="团队评审完成。",
            skipped=False,
            event_type="group_reply",
        )

    router._plan_turn = fake_plan  # type: ignore[assignment]
    router._run_intelligent_turn = fake_intelligent  # type: ignore[assignment]
    router._run_collaborative_discussion_turn = fake_discussion  # type: ignore[assignment]
    session = SimpleNamespace(
        session_id="optional-host",
        provider_name="openai",
        model_name="test",
        workspace_dir=None,
        context_files={},
        taskspaces=[],
        scratchpad={},
        chat_history=[],
    )

    replies = [
        reply
        async for reply in router.run_group_turn(
            base_session=session,
            group_id="group-1",
            group_name="项目群",
            routing="team",
            group_avatar_ids=["product", "tech"],
            mentioned_avatar_ids=[],
            user_input=user_input,
            quoted_content="",
            should_stop=lambda: False,
        )
    ]

    assert calls == [(expected_path, expected_mentions, False)]
    public_replies = [reply for reply in replies if reply.event_type == "group_reply"]
    assert len(public_replies) == 1


def test_backend_role_alias_routes_only_when_unique() -> None:
    unique_router = _router_with_avatars(
        {
            "product": SimpleNamespace(name="产品需求全流程 · 产品策划师"),
            "tech": SimpleNamespace(name="产品需求全流程 · 技术负责人"),
        }
    )
    assert unique_router._mention_targets_in_text(
        "@产品策划师 请先给出用户故事。",
        speaker_id="",
        group_avatar_ids=["product", "tech"],
    ) == ["product"]

    ambiguous_router = _router_with_avatars(
        {
            "product-a": SimpleNamespace(name="产品需求全流程 · 产品策划师"),
            "product-b": SimpleNamespace(name="增长需求全流程 · 产品策划师"),
        }
    )
    assert ambiguous_router._mention_targets_in_text(
        "@产品策划师 请先给出用户故事。",
        speaker_id="",
        group_avatar_ids=["product-a", "product-b"],
    ) == []


@pytest.mark.asyncio
async def test_visible_mention_chain_allows_second_reply_and_obeys_social_caps() -> None:
    names = {
        "product": "产品策划师",
        "tech": "技术负责人",
        "rd": "研发负责人",
        "design": "设计负责人",
        "qa": "质量负责人",
        "docs": "文档负责人",
    }
    avatars = {avatar_id: SimpleNamespace(name=name) for avatar_id, name in names.items()}
    router = _router_with_avatars(avatars)
    policy = SocialTurnPolicy(turn_id="mention-chain", group_id="group-chain")
    router._new_social_turn_policy = lambda *_args: policy  # type: ignore[method-assign]
    router._project_h2a_fanout = lambda **_kwargs: []  # type: ignore[method-assign]
    router._project_a2a_message_edge = lambda **_kwargs: []  # type: ignore[method-assign]

    async def analyze(**_kwargs):
        return IntentDecision(action="route_to", target_ids=["product"], reason="stub")

    router._analyze_intent = analyze  # type: ignore[assignment]
    chain = [
        ("product", "tech"),
        ("tech", "rd"),
        ("rd", "product"),
        ("product", "design"),
        ("design", "qa"),
        ("qa", "docs"),
        ("docs", "design"),
        ("design", "qa"),
        ("qa", "docs"),
        ("docs", ""),
    ]
    call_order: list[str] = []

    async def fake_target_stream(**kwargs):
        avatar_id = str(kwargs["avatar_id"])
        position = len(call_order)
        assert position < len(chain)
        expected_speaker, next_target = chain[position]
        assert avatar_id == expected_speaker
        call_order.append(avatar_id)
        content = f"{names[avatar_id]} 的增量判断。"
        if next_target:
            content += f"\n\n@{names[next_target]}：请补充你的具体判断。"
        yield GroupReply(
            agent_id=avatar_id,
            avatar_name=names[avatar_id],
            avatar_url="",
            content=content,
            skipped=False,
            event_type="group_reply",
        )

    router._run_one_target_stream = fake_target_stream  # type: ignore[assignment]
    events = [
        event
        async for event in router._run_intelligent_turn(
            base_session=SimpleNamespace(scratchpad={}, _group_turn_collaboration=False),
            context=MagicMock(),
            group_id="group-chain",
            group_name="项目群",
            group_avatar_ids=list(names),
            mentioned_avatar_ids=["product"],
            user_input="@产品策划师 请先给出产品判断。",
            quoted_content="",
            should_stop=lambda: False,
            user_display_name="我",
        )
    ]

    visible = [event for event in events if event.event_type == "group_reply"]
    assert call_order == [speaker for speaker, _ in chain]
    assert [event.agent_id for event in visible] == call_order
    assert call_order[:4] == ["product", "tech", "rd", "product"]
    assert policy.messages_by_member == {
        "product": 2,
        "tech": 1,
        "rd": 1,
        "design": 2,
        "qa": 2,
        "docs": 2,
    }
    assert policy.public_message_count == 10
    assert max(policy.messages_by_member.values()) <= 2


@pytest.mark.asyncio
async def test_visible_handoff_does_not_make_an_explicit_target_answer_twice() -> None:
    avatars = {
        "product": SimpleNamespace(name="产品经理"),
        "tech": SimpleNamespace(name="技术负责人"),
    }
    router = _router_with_avatars(avatars)
    called: list[str] = []

    async def fake_target_stream(**kwargs):
        avatar_id = str(kwargs["avatar_id"])
        called.append(avatar_id)
        content = "需求已经明确。\n\n@技术负责人 请接着评估实现。" if avatar_id == "product" else "实现可行。"
        yield GroupReply(
            agent_id=avatar_id,
            avatar_name=avatars[avatar_id].name,
            avatar_url="",
            content=content,
            skipped=False,
            event_type="group_reply",
        )

    router._run_one_target_stream = fake_target_stream  # type: ignore[assignment]
    router._project_h2a_fanout = lambda **_kwargs: []  # type: ignore[method-assign]
    router._project_a2a_message_edge = lambda **_kwargs: []  # type: ignore[method-assign]
    router._maybe_yield_debate_nudge = lambda _session: []  # type: ignore[method-assign]
    context = MagicMock()

    replies = [
        reply
        async for reply in router._run_intelligent_turn(
            base_session=SimpleNamespace(scratchpad={}, _group_turn_collaboration=False),
            context=context,
            group_id="group-1",
            group_name="项目群",
            group_avatar_ids=["product", "tech"],
            mentioned_avatar_ids=["product", "tech"],
            user_input="@产品经理 和 @技术负责人 请依次回答",
            quoted_content="",
            should_stop=lambda: False,
            user_display_name="我",
        )
    ]

    assert called == ["product", "tech"]
    assert [reply.agent_id for reply in replies if reply.event_type == "group_reply"] == [
        "product",
        "tech",
    ]
