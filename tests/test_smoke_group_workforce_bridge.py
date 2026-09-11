#!/usr/bin/env python3
"""Smoke test: GroupChatRouter routing="team" bridge to WorkforcePattern.

Tests the _run_team_turn branching logic and WorkforceEvent → GroupReply
mapping WITHOUT triggering LLM calls.

Author: Damon Li
"""

from __future__ import annotations

import asyncio
import pytest
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

from agenticx.avatar.group_chat import GroupChatConfig, GroupChatRegistry
from agenticx.runtime.group_router import (
    GroupChatRouter,
    GroupReply,
    _get_mention_hops,
    _is_open_call_question,
    _group_chat_tools,
    TurnPlan,
    EventType,
    MAX_WORKERS_PER_GROUP,
)
from agenticx.collaboration.workforce.events import WorkforceEvent, WorkforceAction
from agenticx.collaboration.task_lock import get_or_create_task_lock, remove_task_lock


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_router(*, host_enabled: bool = False) -> GroupChatRouter:
    """Build a GroupChatRouter with mocked dependencies."""
    registry = MagicMock()
    registry.get_avatar = MagicMock(
        side_effect=lambda avatar_id: (
            SimpleNamespace(
                id=avatar_id,
                name={"av1": "主持专家", "av2": "协作专家"}.get(avatar_id, str(avatar_id)),
                role="数字专家",
                system_prompt="",
                avatar_url="",
                default_provider="",
                default_model="",
            )
            if avatar_id in {"av1", "av2"}
            else None
        )
    )
    llm_factory = MagicMock(return_value=MagicMock())
    return GroupChatRouter(
        avatar_registry=registry,
        llm_factory=llm_factory,
        max_tool_rounds=5,
        host_avatar_id="av1" if host_enabled else "",
    )


def _make_session(session_id: str = "test-session") -> MagicMock:
    sess = MagicMock()
    sess.session_id = session_id
    sess.provider_name = "openai"
    sess.model_name = "gpt-4"
    sess.workspace_dir = None
    sess.context_files = {}
    sess.taskspaces = []
    sess.scratchpad = {}
    return sess


# ---------------------------------------------------------------------------
# GroupChatConfig: routing="team" accepted
# ---------------------------------------------------------------------------

class TestGroupChatConfigTeamRouting:
    def test_group_config_accepts_team_routing(self):
        cfg = GroupChatConfig(id="g1", name="Test", routing="team")
        assert cfg.routing == "team"

    def test_group_config_default_still_intelligent(self):
        cfg = GroupChatConfig(id="g1", name="Test", avatar_ids=["member-1"], host_avatar_id="member-1")
        assert cfg.routing == "intelligent"
        assert cfg.host_avatar_id == "member-1"
        assert cfg.to_dict()["host_avatar_id"] == "member-1"

    def test_group_config_persists_explicit_host(self):
        cfg = GroupChatConfig(
            id="g1",
            name="Test",
            avatar_ids=["member-1", "member-2"],
            host_avatar_id="member-2",
        )
        restored = GroupChatConfig.from_dict(cfg.to_dict())
        assert restored.host_avatar_id == "member-2"

    def test_legacy_group_defaults_first_member_as_host(self):
        restored = GroupChatConfig.from_dict(
            {"id": "g1", "name": "Test", "avatar_ids": ["member-1", "member-2"]}
        )
        assert restored.host_avatar_id == "member-1"

    def test_all_routing_values_accepted(self):
        for routing in ("intelligent", "user-directed", "meta-routed", "round-robin", "team"):
            cfg = GroupChatConfig(id="x", name="x", routing=routing)
            assert cfg.routing == routing

    def test_registry_persists_explicit_host_choice(self, tmp_path):
        registry = GroupChatRegistry(root=tmp_path)
        created = GroupChatConfig(
            id="hosted",
            name="Hosted",
            avatar_ids=["member-1"],
            host_avatar_id="member-1",
        )
        registry._write_config(created)
        restored = registry.get_group(created.id)
        assert restored is not None
        assert restored.host_avatar_id == "member-1"


# ---------------------------------------------------------------------------
# _get_mention_hops: config-based, default 9 (10 public messages including opener)
# ---------------------------------------------------------------------------

def _stub_plan(router, *, scope: str, collaboration: bool) -> None:
    """把本轮编排计划固定下来，绕开真正的 LLM 调用。"""

    async def _plan(**_kwargs):
        return TurnPlan(scope=scope, collaboration=collaboration, reason="stubbed")

    router._plan_turn = _plan  # type: ignore[assignment]


class TestTurnPlan:
    """这一轮怎么开，由模型判；这里测的是判不出来时的兜底和边界。

    原来是三组中文关键词正则。问题不在于漏词，而在于「一句话里有没有某个词」和
    「这轮该不该动手」本来就不是一回事——「继续」没有任何词，「比较已有 PoC 的
    优缺点」有 PoC 但只是在讨论。靠加词补不完，所以只保留模型判不动时的行为约束。
    """

    def test_valid_payload_is_taken_as_is(self):
        plan = TurnPlan.from_payload(
            {"scope": "discussion", "collaboration": True, "reason": "在对比两套方案"},
            previous_analysis_only=False,
        )
        assert plan.analysis_only is True
        assert plan.collaboration is True
        assert plan.reason == "在对比两套方案"

    @pytest.mark.parametrize("payload", [None, {}, {"scope": ""}, {"scope": "chat"}])
    def test_unusable_payload_keeps_the_previous_scope(self, payload):
        # 正在讨论的对话，不该因为一次调用失败就突然拿到 shell 和写文件的权限。
        assert TurnPlan.from_payload(payload, previous_analysis_only=True).analysis_only is True
        assert TurnPlan.from_payload(payload, previous_analysis_only=False).analysis_only is False

    def test_unusable_payload_never_claims_collaboration(self):
        # 兜底时不该顺带把单人问题升级成多成员协作。
        assert TurnPlan.from_payload(None, previous_analysis_only=True).collaboration is False

    def test_fallback_reason_is_machine_readable(self):
        # 前端要显示「判断依据」，兜底原因必须和模型给的理由区分得开。
        assert TurnPlan.from_payload(None, True).reason == "plan_unparsable"
        assert TurnPlan.from_payload({"scope": "nope"}, True).reason == "plan_scope_invalid"
        assert TurnPlan.fallback(True, "plan_llm_error").reason == "plan_llm_error"

    def test_missing_reason_is_labelled_rather_than_left_blank(self):
        assert TurnPlan.from_payload({"scope": "execution"}, False).reason == "llm_plan"


class TestDiscussionScope:
    def test_analysis_tools_are_read_only(self):
        names = {
            tool.get("function", {}).get("name")
            for tool in _group_chat_tools(analysis_only=True)
        }
        assert {"web_search", "web_fetch", "file_read"}.issubset(names)
        assert not names.intersection({"bash_exec", "bash_bg_start", "file_write", "skill_manage"})


class TestOpenCallHeuristic:
    """Validate the open-call broadcast question detector."""

    @pytest.mark.parametrize("text", [
        "群里谁能一句话说下 VibeVoice 主要是干啥的？",
        "哪位帮我看下这个仓库结构",
        "谁能讲讲 ASR 的关键点",
        "有人知道 VibeVoice 是干啥的吗？",
        "谁来回答下这个问题？",
        "请问群里有人熟悉 vLLM 吗",
    ])
    def test_open_call_phrases_match(self, text):
        assert _is_open_call_question(text), f"Should match open-call: {text!r}"

    @pytest.mark.parametrize("text", [
        "你好",
        "@av1 帮我看下 VibeVoice",
        "VibeVoice 是什么？",
        "machi 你怎么看",
        "再来一个例子",
        "",
    ])
    def test_non_open_call_phrases_skip(self, text):
        assert not _is_open_call_question(text), f"Should NOT match: {text!r}"


class TestMentionHopsConfig:
    def test_default_leaves_room_for_ten_public_messages(self):
        with patch("agenticx.cli.config_manager.ConfigManager._load_yaml", return_value={}):
            hops = _get_mention_hops()
        assert hops == 9

    def test_reads_from_config(self):
        with patch(
            "agenticx.cli.config_manager.ConfigManager._load_yaml",
            return_value={"group_chat": {"mention_hops": 4}},
        ):
            hops = _get_mention_hops()
        assert hops == 4

    def test_clamped_to_valid_range(self):
        with patch(
            "agenticx.cli.config_manager.ConfigManager._load_yaml",
            return_value={"group_chat": {"mention_hops": 999}},
        ):
            hops = _get_mention_hops()
        # 999 > 10, so it falls back to the bounded default.
        assert hops == 9


# ---------------------------------------------------------------------------
# _workforce_event_to_group_reply: mapping correctness
# ---------------------------------------------------------------------------

class TestWorkforceEventMapping:
    def test_task_completed_maps_to_workforce_event_type(self):
        router = _make_router()
        evt = WorkforceEvent(
            action=WorkforceAction.TASK_COMPLETED,
            task_id="t1",
            agent_id="avatar1",
            data={"result": "done"},
        )
        reply = router._workforce_event_to_group_reply(
            evt, agent_id="avatar1", avatar_name="Dev"
        )
        assert reply.event_type == "group_workflow_detail"
        assert reply.skipped
        assert reply.workflow_role == "system"
        assert reply.workflow_task_id == "t1"
        assert reply.workflow_status == "task_completed"
        assert reply.event_data["result"] == "done"
        assert reply.event_data["feed_visibility"] == "panel"
        assert reply.event_data["workflow_event_type"] == "task_completed"

    def test_task_assignment_is_a_concise_public_feed_message(self):
        router = _make_router()
        evt = WorkforceEvent(
            action=WorkforceAction.TASK_ASSIGNED,
            task_id="t1",
            agent_id="avatar1",
            data={"task_description": "先调研现状，再给出可验证的改进方案"},
        )

        reply = router._workforce_event_to_group_reply(
            evt, agent_id="avatar1", avatar_name="Dev"
        )

        assert reply.event_type == "group_reply"
        assert reply.skipped is False
        assert reply.content == "我来负责：先调研现状，再给出可验证的改进方案"
        assert reply.event_data["feed_visibility"] == "feed"
        assert reply.event_data["publication_source"] == "workflow_task_assigned"

    def test_task_failure_is_a_concise_public_blocker(self):
        router = _make_router()
        evt = WorkforceEvent(
            action=WorkforceAction.TASK_FAILED,
            task_id="t1",
            agent_id="avatar1",
            data={"error": "缺少可访问的数据源，无法继续验证"},
        )

        reply = router._workforce_event_to_group_reply(
            evt, agent_id="avatar1", avatar_name="Dev"
        )

        assert reply.event_type == "group_reply"
        assert reply.skipped is False
        assert reply.content == "这部分遇到阻塞：缺少可访问的数据源，无法继续验证"
        assert reply.event_data["feed_visibility"] == "feed"
        assert reply.event_data["publication_source"] == "workflow_task_failed"

    def test_rejected_control_failure_stays_in_project_panel(self):
        router = _make_router()
        evt = WorkforceEvent(
            action=WorkforceAction.TASK_FAILED,
            task_id="t1",
            agent_id="avatar1",
            data={"control": "rejected", "error": "cannot skip running task"},
        )

        reply = router._workforce_event_to_group_reply(
            evt, agent_id="avatar1", avatar_name="Dev"
        )

        assert reply.event_type == "group_workflow_detail"
        assert reply.skipped is True
        assert reply.event_data["feed_visibility"] == "panel"
        assert reply.event_data["is_public"] is False

    def test_workforce_started_maps_correctly(self):
        router = _make_router()
        evt = WorkforceEvent(
            action=WorkforceAction.WORKFORCE_STARTED,
            data={"mode": "execution", "mode_reason": "需要多人协作"},
        )
        reply = router._workforce_event_to_group_reply(evt)
        assert reply.event_type == "group_workflow_detail"
        assert reply.skipped
        assert reply.workflow_role == "leader"
        assert reply.event_data["mode"] == "execution"
        assert reply.event_data["mode_reason"] == "需要多人协作"
        assert reply.event_data["feed_visibility"] == "panel"
        assert reply.event_data["workflow_event_type"] == "workforce_started"

    def test_typing_event_carries_executor_or_reviewer_context(self):
        router = _make_router()
        executor = router._typing_event(
            "avatar1",
            "Dev",
            workflow_role="executor",
            workflow_task_id="task-1",
            workflow_attempt=2,
        )
        reviewer = router._typing_event(
            "avatar2",
            "Reviewer",
            workflow_role="reviewer",
            workflow_task_id="task-1",
            workflow_attempt=2,
        )
        assert executor.event_type == "group_typing"
        assert executor.workflow_role == "executor"
        assert executor.workflow_task_id == "task-1"
        assert executor.workflow_attempt == 2
        assert reviewer.workflow_role == "reviewer"

    def test_non_event_returns_unknown(self):
        router = _make_router()
        reply = router._workforce_event_to_group_reply("not-an-event")
        assert reply.event_type == "group_workflow_detail"
        assert reply.skipped
        assert reply.event_data["feed_visibility"] == "panel"

    def test_private_candidate_detail_cannot_be_admitted_to_group_feed(self):
        router = _make_router()
        detail = router._workflow_detail_from_reply(
            GroupReply(
                agent_id="av1",
                avatar_name="Dev",
                avatar_url="",
                content="完整候选方案",
                event_type="group_reply",
                workflow_role="executor",
                workflow_task_id="t1",
            ),
            detail_kind="candidate_output",
            event_data={"candidate_output": "完整候选方案"},
        )

        assert detail.event_type == "group_workflow_detail"
        assert detail.skipped is True
        assert detail.event_data == {
            "candidate_output": "完整候选方案",
            "feed_visibility": "panel",
            "detail_kind": "candidate_output",
            "is_public": False,
        }


class TestGroupProgressTextMapping:
    """群聊进度行只给一句可扫读的状态，参数和结果留给侧栏详情。

    这两条原来断言进度行里要带上参数预览（"VibeVoice"）和结果预览（"count"）。
    工具调用展示后来被有意简化了（见 group_router._runtime_event_to_progress_text
    里的注释：args/result belong in side-panel detail, not the line），所以断言反过来：
    保证正文里**不会**漏出参数和结果 —— 群聊里可能有多个人，工具参数常常带着文件路径、
    查询词这类不该在群消息流里刷屏的东西。
    """

    def test_tool_call_progress_is_a_one_line_status(self):
        text = GroupChatRouter._runtime_event_to_progress_text(
            EventType.TOOL_CALL.value,
            {"name": "knowledge_search", "arguments": {"query": "VibeVoice", "limit": 3}},
        )
        assert text == "正在调用工具：knowledge_search"
        assert "VibeVoice" not in text

    def test_tool_result_progress_is_a_one_line_status(self):
        text = GroupChatRouter._runtime_event_to_progress_text(
            EventType.TOOL_RESULT.value,
            {"name": "session_search", "result": {"count": 2, "hits": ["a", "b"]}},
        )
        assert text == "工具已完成：session_search"
        assert "count" not in text


# ---------------------------------------------------------------------------
# run_group_turn routing dispatch: hosted rooms use the social route
# ---------------------------------------------------------------------------

class TestRoutingDispatch:
    @pytest.mark.asyncio
    async def test_explicit_host_dispatches_to_social_route(self):
        """``@主持人`` addresses the real host without constructing a hidden DAG."""
        router = _make_router(host_enabled=True)
        team_called = False
        social_calls: list[list[str]] = []
        _stub_plan(router, scope="execution", collaboration=True)

        async def fake_team_turn(**kwargs):
            nonlocal team_called
            team_called = True
            yield GroupReply(
                agent_id="__meta__",
                avatar_name="Leader",
                avatar_url="",
                content="team done",
                skipped=False,
                event_type="group_reply",
            )

        router._run_team_turn = fake_team_turn  # type: ignore[assignment]

        async def fake_social_turn(**kwargs):
            social_calls.append(list(kwargs["mentioned_avatar_ids"]))
            yield GroupReply(
                agent_id="av1",
                avatar_name="主持专家",
                avatar_url="",
                content="host answered",
                skipped=False,
                event_type="group_reply",
            )

        router._run_intelligent_turn = fake_social_turn  # type: ignore[assignment]

        session = _make_session()
        replies = []
        async for r in router.run_group_turn(
            base_session=session,
            group_id="g1",
            group_name="Test Group",
            routing="team",
            group_avatar_ids=["av1", "av2"],
            mentioned_avatar_ids=[],
            user_input="@主持人 调研 X 然后写 demo",
            quoted_content="",
            should_stop=lambda: False,
        ):
            replies.append(r)

        assert social_calls == [["av1"]]
        assert not team_called
        assert len(replies) > 0

    @pytest.mark.asyncio
    async def test_intelligent_routing_simple_prompt_skips_team_turn(self):
        """When routing="intelligent" + simple prompt, _run_team_turn must NOT be called.

        With the auto-dispatch heuristic, intelligent routing only calls
        _run_team_turn for complex multi-step tasks.  A simple greeting must
        stay on the legacy path.
        """
        router = _make_router()
        team_called = False

        async def fake_team_turn(**kwargs):
            nonlocal team_called
            team_called = True
            yield GroupReply("x", "x", "", "", True, event_type="group_reply")

        router._run_team_turn = fake_team_turn  # type: ignore[assignment]

        # Stub the rest of the legacy path so the test terminates fast.
        async def stub_analyze_intent(**kwargs):
            from agenticx.runtime.group_router import IntentDecision
            return IntentDecision(action="meta_direct", target_ids=[], reason="stub")

        async def stub_meta_pm(**kwargs):
            return GroupReply("__meta__", "Machi", "", "ok", False, event_type="group_reply")

        router._analyze_intent = stub_analyze_intent  # type: ignore[assignment]
        router._run_meta_project_manager_reply = stub_meta_pm  # type: ignore[assignment]

        session = _make_session()
        async for _ in router.run_group_turn(
            base_session=session,
            group_id="g1",
            group_name="Test Group",
            routing="intelligent",
            group_avatar_ids=["av1"],
            mentioned_avatar_ids=[],
            user_input="你好",
            quoted_content="",
            should_stop=lambda: False,
        ):
            pass

        assert not team_called, (
            "Simple prompt under intelligent routing must NOT trigger _run_team_turn"
        )

    @pytest.mark.asyncio
    async def test_complex_host_prompt_stays_with_addressed_host_not_dag(self):
        """An explicit host mention wins over execution collaboration."""
        router = _make_router(host_enabled=True)
        team_called = False
        social_mentions: list[list[str]] = []
        captured_input: list[str] = []

        async def fake_team_turn(**kwargs):
            nonlocal team_called
            team_called = True
            captured_input.append(kwargs.get("user_input", ""))
            yield GroupReply(
                "__meta__", "Machi", "", "team done", False, event_type="group_reply"
            )

        router._run_team_turn = fake_team_turn  # type: ignore[assignment]

        async def fake_social_turn(**kwargs):
            social_mentions.append(list(kwargs["mentioned_avatar_ids"]))
            captured_input.append(kwargs.get("user_input", ""))
            yield GroupReply(
                "av1", "主持专家", "", "host done", False, event_type="group_reply"
            )

        router._run_intelligent_turn = fake_social_turn  # type: ignore[assignment]
        # 是否多成员协作由本轮的编排计划决定，不再由提示词里的关键词决定。
        _stub_plan(router, scope="execution", collaboration=True)

        session = _make_session()
        replies = []
        async for r in router.run_group_turn(
            base_session=session,
            group_id="g-auto",
            group_name="Auto Dispatch",
            routing="intelligent",
            group_avatar_ids=["av1", "av2"],  # ≥ 2 members
            mentioned_avatar_ids=[],
            user_input="@主持人 帮我调研一下 X 库，然后基于它写一个 hello world demo",
            quoted_content="",
            should_stop=lambda: False,
        ):
            replies.append(r)

        assert social_mentions == [["av1"]]
        assert not team_called
        assert "调研" in captured_input[0]

    @pytest.mark.asyncio
    async def test_host_mention_uses_read_only_social_route_for_discussion(self):
        router = _make_router(host_enabled=True)
        team_called = False
        social_calls: list[list[str]] = []

        async def fake_team_turn(**kwargs):
            nonlocal team_called
            team_called = True
            yield GroupReply(
                "__meta__", "Machi", "", "team done", False, event_type="group_reply"
            )

        async def fake_social_turn(**kwargs):
            social_calls.append(list(kwargs["mentioned_avatar_ids"]))
            assert getattr(kwargs["base_session"], "_group_analysis_only", False) is True
            yield GroupReply(
                "av1", "成员甲", "", "先说我的看法", False, event_type="group_reply"
            )

        router._run_team_turn = fake_team_turn  # type: ignore[assignment]
        router._run_intelligent_turn = fake_social_turn  # type: ignore[assignment]
        # 多人讨论保持只读，但不再升级成并行执行 + 独立审核 DAG。
        _stub_plan(router, scope="discussion", collaboration=True)

        async for _ in router.run_group_turn(
            base_session=_make_session(),
            group_id="g-collab",
            group_name="Collaboration Dispatch",
            routing="intelligent",
            group_avatar_ids=["av1", "av2"],
            mentioned_avatar_ids=[],
            user_input="@主持人 请大家讨论这个方案并做交叉评审",
            quoted_content="",
            should_stop=lambda: False,
        ):
            pass

        assert not team_called
        assert social_calls == [["av1"]]

    @pytest.mark.asyncio
    async def test_user_turn_is_accepted_and_persisted_before_planning(self):
        router = _make_router(host_enabled=True)
        order: list[str] = []
        session = _make_session()

        async def accepted():
            history = list(getattr(session, "chat_history", []) or [])
            assert history[-1]["role"] == "user"
            assert history[-1]["content"] == "@主持人 先记住我，再开始规划"
            order.append("persist")

        async def fake_plan(**kwargs):
            assert order == ["persist"]
            assert "先记住我" not in str(kwargs.get("recent_dialogue") or "")
            order.append("plan")
            return TurnPlan(scope="execution", collaboration=True, reason="test")

        async def fake_social_turn(**_kwargs):
            order.append("run")
            yield GroupReply(
                "av1", "主持专家", "", "done", False, event_type="group_reply"
            )

        router._plan_turn = fake_plan  # type: ignore[assignment]
        router._run_intelligent_turn = fake_social_turn  # type: ignore[assignment]

        async for _ in router.run_group_turn(
            base_session=session,
            group_id="g-durable",
            group_name="Durable",
            routing="team",
            group_avatar_ids=["av1", "av2"],
            mentioned_avatar_ids=[],
            user_input="@主持人 先记住我，再开始规划",
            quoted_content="",
            should_stop=lambda: False,
            on_user_accepted=accepted,
        ):
            pass

        assert order == ["persist", "plan", "run"]

    @pytest.mark.asyncio
    async def test_intelligent_routing_with_explicit_mention_skips_auto_dispatch(self):
        """Even with multi-step prompt, explicit @ mention skips auto-dispatch (user knows best)."""
        router = _make_router()
        team_called = False

        async def fake_team_turn(**kwargs):
            nonlocal team_called
            team_called = True
            yield GroupReply("x", "x", "", "", True, event_type="group_reply")

        router._run_team_turn = fake_team_turn  # type: ignore[assignment]

        # Stub legacy path
        async def stub_analyze_intent(**kwargs):
            from agenticx.runtime.group_router import IntentDecision
            return IntentDecision(action="route_to", target_ids=["av1"], reason="explicit")

        async def stub_one_target_stream(**kwargs):
            yield GroupReply(
                kwargs.get("avatar_id", "av1"), "Avatar1", "",
                "ok", False, event_type="group_reply"
            )

        router._analyze_intent = stub_analyze_intent  # type: ignore[assignment]
        router._run_one_target_stream = stub_one_target_stream  # type: ignore[assignment]

        session = _make_session()
        async for _ in router.run_group_turn(
            base_session=session,
            group_id="g-mention",
            group_name="Mention Test",
            routing="intelligent",
            group_avatar_ids=["av1", "av2"],
            mentioned_avatar_ids=["av1"],  # explicit @
            user_input="@av1 然后再调研一下 ChromaDB 步骤",  # has multi-step markers
            quoted_content="",
            should_stop=lambda: False,
        ):
            pass

        assert not team_called, (
            "Explicit @ mention should skip auto-dispatch even with multi-step prompt"
        )

    @pytest.mark.asyncio
    async def test_intelligent_routing_single_member_skips_auto_dispatch(self):
        """Group with only 1 avatar should skip Workforce dispatch (no point decomposing)."""
        router = _make_router()
        team_called = False

        async def fake_team_turn(**kwargs):
            nonlocal team_called
            team_called = True
            yield GroupReply("x", "x", "", "", True, event_type="group_reply")

        router._run_team_turn = fake_team_turn  # type: ignore[assignment]

        async def stub_analyze_intent(**kwargs):
            from agenticx.runtime.group_router import IntentDecision
            return IntentDecision(action="meta_direct", target_ids=[], reason="stub")

        async def stub_meta_pm(**kwargs):
            return GroupReply("__meta__", "Machi", "", "ok", False, event_type="group_reply")

        router._analyze_intent = stub_analyze_intent  # type: ignore[assignment]
        router._run_meta_project_manager_reply = stub_meta_pm  # type: ignore[assignment]

        session = _make_session()
        async for _ in router.run_group_turn(
            base_session=session,
            group_id="g-single",
            group_name="Single Member",
            routing="intelligent",
            group_avatar_ids=["av1"],  # only 1 member
            mentioned_avatar_ids=[],
            user_input="先调研 X，再写 demo 实现一下",  # complex prompt
            quoted_content="",
            should_stop=lambda: False,
        ):
            pass

        assert not team_called, (
            "Single-member group should not invoke Workforce auto-dispatch"
        )

    @pytest.mark.asyncio
    async def test_no_mention_does_not_implicitly_address_host(self):
        """Plain speech is socially routed; ``@主持人`` explicitly names the host."""
        router = _make_router(host_enabled=True)
        planned_inputs: list[str] = []
        team_inputs: list[str] = []
        social_mentions: list[list[str]] = []

        async def stub_plan(**kwargs):
            planned_inputs.append(str(kwargs.get("user_input", "")))
            return TurnPlan(scope="discussion", collaboration=True, reason="stubbed")

        async def stub_team(**kwargs):
            team_inputs.append(str(kwargs.get("user_input", "")))
            yield GroupReply(
                "__meta__", "主持专家", "", "团队答", False, event_type="group_reply"
            )

        async def stub_social(**kwargs):
            social_mentions.append(list(kwargs.get("mentioned_avatar_ids", [])))
            yield GroupReply(
                "av1", "成员甲", "", "讨论答", False, event_type="group_reply"
            )

        router._plan_turn = stub_plan  # type: ignore[assignment]
        router._run_team_turn = stub_team  # type: ignore[assignment]
        router._run_intelligent_turn = stub_social  # type: ignore[assignment]

        replies = []
        for prompt in (
            "群里谁能一句话说下 VibeVoice 主要是干啥的？",
            "@主持人 群里谁能一句话说下 VibeVoice 主要是干啥的？",
        ):
            async for reply in router.run_group_turn(
                base_session=_make_session(),
                group_id="g-open-call",
                group_name="Open Call",
                routing="intelligent",
                group_avatar_ids=["av1", "av2"],
                mentioned_avatar_ids=[],
                user_input=prompt,
                quoted_content="",
                should_stop=lambda: False,
            ):
                replies.append(reply)

        expected = [
            "群里谁能一句话说下 VibeVoice 主要是干啥的？",
            "群里谁能一句话说下 VibeVoice 主要是干啥的？",
        ]
        assert planned_inputs == expected
        assert team_inputs == []
        assert social_mentions == [[], ["av1"]]
        # ``group_user_accepted`` is a control event that binds the optimistic
        # user bubble to its stable id; it is intentionally not a Feed message.
        # Only compare actual public replies here.
        assert [
            reply.content
            for reply in replies
            if reply.event_type == "group_reply"
        ] == ["讨论答", "讨论答"]

    @pytest.mark.asyncio
    async def test_unhosted_room_never_injects_meta_when_a_member_skips(self):
        """Disabling the host also removes its retry nudge and final fallback."""
        router = _make_router(host_enabled=False)
        _stub_plan(router, scope="execution", collaboration=False)
        meta_called = False

        async def stub_analyze_intent(**_kwargs):
            from agenticx.runtime.group_router import IntentDecision

            return IntentDecision(action="route_to", target_ids=["av1"], reason="stub")

        async def stub_one_target_stream(**kwargs):
            yield GroupReply(
                kwargs.get("avatar_id", "av1"),
                "Avatar1",
                "",
                "",
                True,
                event_type="group_skipped",
            )

        async def stub_meta_pm(**_kwargs):
            nonlocal meta_called
            meta_called = True
            return GroupReply(
                "__meta__", "Machi", "", "hidden fallback", False, event_type="group_reply"
            )

        router._analyze_intent = stub_analyze_intent  # type: ignore[assignment]
        router._run_one_target_stream = stub_one_target_stream  # type: ignore[assignment]
        router._run_meta_project_manager_reply = stub_meta_pm  # type: ignore[assignment]

        replies = []
        async for reply in router.run_group_turn(
            base_session=_make_session(),
            group_id="g-unhosted-skip",
            group_name="No Host",
            routing="intelligent",
            group_avatar_ids=["av1"],
            mentioned_avatar_ids=[],
            user_input="请给一个判断",
            quoted_content="",
            should_stop=lambda: False,
        ):
            replies.append(reply)

        assert meta_called is False
        visible_meta_events = [
            (reply.event_type, reply.agent_id)
            for reply in replies
            if reply.agent_id == "__meta__"
            and reply.event_type in {"group_reply", "group_nudge", "group_typing"}
        ]
        assert visible_meta_events == []

    @pytest.mark.asyncio
    async def test_intelligent_routing_explicit_mention_overrides_open_call(self):
        """If the user @-mentions someone, even an open-call phrase shouldn't reroute to Machi."""
        router = _make_router(host_enabled=True)
        meta_called = False

        async def stub_meta_pm(**kwargs):
            nonlocal meta_called
            meta_called = True
            return GroupReply("__meta__", "Machi", "", "x", False, event_type="group_reply")

        async def stub_analyze_intent(**kwargs):
            from agenticx.runtime.group_router import IntentDecision
            return IntentDecision(action="route_to", target_ids=["av1"], reason="explicit")

        async def stub_one_target_stream(**kwargs):
            yield GroupReply(
                kwargs.get("avatar_id", "av1"), "Avatar1", "", "ok", False, event_type="group_reply"
            )

        router._run_meta_project_manager_reply = stub_meta_pm  # type: ignore[assignment]
        router._analyze_intent = stub_analyze_intent  # type: ignore[assignment]
        router._run_one_target_stream = stub_one_target_stream  # type: ignore[assignment]

        session = _make_session()
        async for _ in router.run_group_turn(
            base_session=session,
            group_id="g-open-call-mention",
            group_name="Open Call With Mention",
            routing="intelligent",
            group_avatar_ids=["av1", "av2"],
            mentioned_avatar_ids=["av1"],  # explicit @
            user_input="群里谁能 @av1 看下 VibeVoice？",
            quoted_content="",
            should_stop=lambda: False,
        ):
            pass

        assert not meta_called, (
            "Explicit @-mention must take priority over the open-call heuristic"
        )

    @pytest.mark.asyncio
    async def test_team_routing_no_avatars_yields_error_message(self):
        """When routing="team" but no avatar_ids, should yield an error reply gracefully."""
        router = _make_router(host_enabled=True)
        session = _make_session()
        from agenticx.runtime.group_context import GroupChatContext

        replies = []
        async for r in router._run_team_turn(
            base_session=session,
            context=GroupChatContext(session),
            group_id="g2",
            group_name="Empty Group",
            group_avatar_ids=[],
            user_input="hello",
            quoted_content="",
            should_stop=lambda: False,
        ):
            replies.append(r)

        assert any("成员" in (r.content or "") for r in replies), "Should emit no-member message"


# ---------------------------------------------------------------------------
# Regression: _run_team_turn must pass Agent list into WorkforcePattern
# ---------------------------------------------------------------------------

class TestTeamTurnRegression:
    @pytest.mark.asyncio
    async def test_team_turn_passes_agent_workers_not_singleagentworker(self):
        """Guard against double-wrapping SingleAgentWorker -> missing .role."""
        router = _make_router()
        session = _make_session("team-regression")
        context = MagicMock()

        captured_workers: list[object] = []

        class FakeWorkforcePattern:
            def __init__(self, *, coordinator_agent, task_agent, workers, llm_provider, event_bus, **kwargs):
                captured_workers.extend(workers)
                self.worker_instances = [SimpleNamespace(id=w.id) for w in workers]
                self.coordinator = MagicMock()

            async def decompose_task(self, task):
                return []  # Force meta-direct branch; avoid further execution path

        async def stub_meta_pm(**kwargs):
            return GroupReply("__meta__", "Machi", "", "ok", False, event_type="group_reply")

        router._run_meta_project_manager_reply = stub_meta_pm  # type: ignore[assignment]

        with patch(
            "agenticx.collaboration.workforce.workforce_pattern.WorkforcePattern",
            FakeWorkforcePattern,
        ):
            replies = []
            async for r in router._run_team_turn(
                base_session=session,
                context=context,
                group_id="g-team-reg",
                group_name="Team Regression",
                group_avatar_ids=["av1", "av2"],
                user_input="请按步骤拆分并执行",
                quoted_content="",
                should_stop=lambda: False,
                user_display_name="我",
            ):
                replies.append(r)

        assert captured_workers, "Expected workers passed into WorkforcePattern"
        assert all(
            hasattr(w, "role") and hasattr(w, "id")
            for w in captured_workers
        ), "Workers must be Agent-like objects with role/id"
        assert any(r.event_type == "group_reply" for r in replies)

    @pytest.mark.asyncio
    async def test_team_turn_stop_during_direct_pm_does_not_publish_late_final(self):
        """A STOP that arrives while the no-subtask PM is running must win."""
        router = _make_router(host_enabled=True)
        session = _make_session("team-direct-stop")
        session.chat_history = []
        from agenticx.runtime.group_context import GroupChatContext
        from agenticx.collaboration.task_lock import Action, ActionData

        context = GroupChatContext(session, group_id="g-team-direct-stop")
        received_stop_callbacks: list[object] = []

        class FakeWorkforcePattern:
            def __init__(self, *, workers, **kwargs):
                self.worker_instances = [SimpleNamespace(id=w.id) for w in workers]
                self.coordinator = MagicMock()

            async def decompose_task(self, task):
                return []

        async def stub_meta_pm(**kwargs):
            received_stop_callbacks.append(kwargs.get("should_stop"))
            # The controller action may race with the provider response.  This
            # models STOP arriving after the PM has started but before its
            # would-be public message is admitted.
            controller = getattr(session, "_group_team_controller")
            await controller.handle_action(
                ActionData(action=Action.STOP, data={"source": "test"})
            )
            return GroupReply(
                "__meta__",
                "Machi",
                "",
                "late final",
                False,
                event_type="group_reply",
            )

        router._run_meta_project_manager_reply = stub_meta_pm  # type: ignore[assignment]

        with patch(
            "agenticx.collaboration.workforce.workforce_pattern.WorkforcePattern",
            FakeWorkforcePattern,
        ):
            replies = [
                reply
                async for reply in router._run_team_turn(
                    base_session=session,
                    context=context,
                    group_id="g-team-direct-stop",
                    group_name="Team Direct Stop",
                    group_avatar_ids=["av1", "av2"],
                    user_input="请直接给出结论",
                    quoted_content="",
                    should_stop=lambda: False,
                    user_display_name="我",
                )
            ]

        assert received_stop_callbacks and callable(received_stop_callbacks[0])
        assert await received_stop_callbacks[0]() is True  # type: ignore[misc]
        assert not any(
            reply.event_type == "group_reply" and reply.content == "late final"
            for reply in replies
        )
        assert not any(
            row.get("content") == "late final"
            for row in session.chat_history
            if isinstance(row, dict)
        )

    @pytest.mark.asyncio
    @pytest.mark.parametrize("stop_phase", ["decompose", "assign"])
    async def test_team_turn_stop_after_planning_await_blocks_following_side_effects(
        self,
        stop_phase: str,
    ):
        """STOP after either planning await must prevent assignment and execution."""
        router = _make_router(host_enabled=True)
        session = _make_session(f"team-stop-{stop_phase}")
        session.chat_history = []
        from agenticx.collaboration.task_lock import Action, ActionData
        from agenticx.core.task import Task
        from agenticx.runtime.group_context import GroupChatContext

        context = GroupChatContext(session, group_id=f"g-team-stop-{stop_phase}")
        assignment_called = False

        async def request_stop() -> None:
            controller = getattr(session, "_group_team_controller")
            await controller.handle_action(
                ActionData(action=Action.STOP, data={"source": stop_phase})
            )

        async def assign_tasks(*, tasks, workers):
            nonlocal assignment_called
            assignment_called = True
            if stop_phase == "assign":
                await request_stop()
            return {task.id: workers[0].id for task in tasks}

        class FakeWorkforcePattern:
            def __init__(self, *, workers, **kwargs):
                self.worker_instances = [SimpleNamespace(id=w.id) for w in workers]
                self.coordinator = SimpleNamespace(assign_tasks=assign_tasks)

            async def decompose_task(self, task):
                if stop_phase == "decompose":
                    await request_stop()
                return [
                    Task(
                        id=f"task-{stop_phase}",
                        description="planned task",
                        expected_output="result",
                        dependencies=[],
                    )
                ]

        with patch(
            "agenticx.collaboration.workforce.workforce_pattern.WorkforcePattern",
            FakeWorkforcePattern,
        ):
            replies = [
                reply
                async for reply in router._run_team_turn(
                    base_session=session,
                    context=context,
                    group_id=f"g-team-stop-{stop_phase}",
                    group_name="Team Stop Boundary",
                    group_avatar_ids=["av1", "av2"],
                    user_input="请执行一个任务",
                    quoted_content="",
                    should_stop=lambda: False,
                    user_display_name="我",
                )
            ]

        assert assignment_called is (stop_phase == "assign")
        assert all(reply.workflow_status != "task_assigned" for reply in replies)
        assert not any(
            reply.event_type == "group_reply" and "我来负责" in reply.content
            for reply in replies
        )
        assert any(reply.workflow_status == "workforce_stopped" for reply in replies)

    @pytest.mark.asyncio
    async def test_team_turn_real_workforcepattern_init_no_double_wrap(self):
        """Use real WorkforcePattern init to guard against SingleAgentWorker double-wrap regressions."""
        router = _make_router()
        session = _make_session("team-real-init")
        context = MagicMock()

        async def stub_meta_pm(**kwargs):
            return GroupReply("__meta__", "Machi", "", "ok", False, event_type="group_reply")

        router._run_meta_project_manager_reply = stub_meta_pm  # type: ignore[assignment]

        from agenticx.collaboration.workforce.workforce_pattern import WorkforcePattern

        with patch.object(WorkforcePattern, "decompose_task", AsyncMock(return_value=[])):
            replies = []
            async for r in router._run_team_turn(
                base_session=session,
                context=context,
                group_id="g-team-real-init",
                group_name="Team Real Init",
                group_avatar_ids=["av1", "av2"],
                user_input="请按步骤拆分并执行",
                quoted_content="",
                should_stop=lambda: False,
                user_display_name="我",
            ):
                replies.append(r)

        assert any(r.event_type == "group_reply" for r in replies)


# ---------------------------------------------------------------------------
# task_experience tools: end-to-end without LLM
# ---------------------------------------------------------------------------

class TestTaskExperienceTools:
    def _make_session_with_group(self, group_id: str) -> MagicMock:
        sess = _make_session()
        sess.scratchpad = {"__group_id": group_id}
        return sess

    @pytest.mark.asyncio
    async def test_experience_learn_and_retrieve(self, tmp_path, monkeypatch):
        """learn → retrieve should return the recorded entry."""
        import agenticx.cli.agent_tools as tools_mod
        # Redirect experience storage to tmp dir.
        orig_path = tools_mod._experience_path

        def patched_path(gid: str):
            p = tmp_path / "groups" / gid
            p.mkdir(parents=True, exist_ok=True)
            return p / "experience.json"

        monkeypatch.setattr(tools_mod, "_experience_path", patched_path)

        group_id = "test-g1"
        result_learn = tools_mod._experience_learn_impl(
            content="chunked vector 需要分批 <= 10 条调用 embed API",
            group_id=group_id,
            section="api_usage",
            when_to_use="调用 embed API 时",
            title="embed API 批量限制",
        )
        import json
        learn_parsed = json.loads(result_learn)
        assert learn_parsed["status"] == "ok"
        assert learn_parsed["group_id"] == group_id

        result_retrieve = tools_mod._experience_retrieve_impl(
            query="embed API 批量调用",
            group_id=group_id,
            limit=5,
        )
        retrieve_parsed = json.loads(result_retrieve)
        assert retrieve_parsed["status"] == "ok"
        assert retrieve_parsed["count"] >= 1
        assert any("embed" in e.get("content", "").lower() for e in retrieve_parsed["results"])

    @pytest.mark.asyncio
    async def test_experience_clear_requires_confirm(self, tmp_path, monkeypatch):
        import agenticx.cli.agent_tools as tools_mod
        import json

        def patched_path(gid: str):
            p = tmp_path / "groups" / gid
            p.mkdir(parents=True, exist_ok=True)
            return p / "experience.json"

        monkeypatch.setattr(tools_mod, "_experience_path", patched_path)

        tools_mod._experience_learn_impl("test entry", group_id="g-clear-test")
        # Should abort without confirm=True
        result = tools_mod._experience_clear_impl("g-clear-test", confirm=False)
        assert json.loads(result)["status"] == "aborted"
        # Should clear with confirm=True
        result = tools_mod._experience_clear_impl("g-clear-test", confirm=True)
        assert json.loads(result)["status"] == "cleared"

    def test_studio_tools_contain_experience_tools(self):
        from agenticx.cli.agent_tools import STUDIO_TOOLS
        names = {t["function"]["name"] for t in STUDIO_TOOLS}
        assert "task_experience_retrieve" in names
        assert "task_experience_learn" in names
        assert "task_experience_clear" in names


# ---------------------------------------------------------------------------
# TaskLock isolation
# ---------------------------------------------------------------------------

class TestTaskLockIsolation:
    @pytest.mark.asyncio
    async def test_group_session_task_locks_are_isolated(self):
        pid_a = "group::ga::s1"
        pid_b = "group::gb::s1"  # different group, same session
        pid_c = "group::ga::s2"  # same group, different session
        try:
            la = get_or_create_task_lock(pid_a)
            lb = get_or_create_task_lock(pid_b)
            lc = get_or_create_task_lock(pid_c)
            assert la is not lb, "Different group_ids must not share TaskLock"
            assert la is not lc, "Different session_ids must not share TaskLock"
        finally:
            for pid in (pid_a, pid_b, pid_c):
                remove_task_lock(pid)
