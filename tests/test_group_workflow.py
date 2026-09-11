#!/usr/bin/env python3
"""Tests for the reviewed project-group collaboration workflow.

Author: Damon Li
"""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from agenticx.core.task import Task
from agenticx.runtime.graph.models import NodeStatus
from agenticx.runtime.graph.store import GraphRunStore
from agenticx.runtime.group_context import GroupChatContext
from agenticx.runtime.harden_flags import group_review_max_retries
from agenticx.runtime.group_router import GroupChatRouter, GroupReply
from agenticx.runtime.group_workflow import (
    MEMBER_HISTORY_MAX_CHARS,
    MEMBER_HISTORY_MAX_MESSAGES,
    ReviewStatus,
    WorkflowMember,
    WorkflowStageRecord,
    parse_review_decision,
    persist_member_runtime_state,
    render_execution_dossier,
    restore_member_runtime_state,
    select_reviewer,
    write_group_deliverable,
)


def test_parse_review_json_and_fenced_json() -> None:
    raw = (
        '{"status":"pass_with_risk","summary":"可交付",'
        '"issues":[{"severity":"P2","problem":"缺少次要样例","fix":"后续补充"}],'
        '"strengths":["结构完整"]}'
    )
    plain = parse_review_decision(raw)
    fenced = parse_review_decision(f"```json\n{raw}\n```")

    assert plain.status == ReviewStatus.PASS_WITH_RISK
    assert fenced.status == ReviewStatus.PASS_WITH_RISK
    assert plain.accepted is True
    assert plain.issues[0].severity == "P2"


def test_p0_issue_overrides_false_pass() -> None:
    decision = parse_review_decision(
        '{"status":"pass","summary":"看起来可以",'
        '"issues":[{"severity":"P0","problem":"核心数据无来源","fix":"补证据"}]}'
    )

    assert decision.status == ReviewStatus.REVISE
    assert decision.accepted is False


def test_plain_text_p1_overrides_false_pass() -> None:
    decision = parse_review_decision("审核通过\nP1: 关键结论没有证据来源")

    assert decision.status == ReviewStatus.REVISE
    assert decision.issues[0].severity == "P1"


def test_unparseable_review_fails_closed() -> None:
    decision = parse_review_decision("我大概看了一下，应该还行。")

    assert decision.status == ReviewStatus.REVISE
    assert decision.accepted is False
    assert decision.issues[0].severity == "P1"
    assert "无法解析" in decision.issues[0].problem


def test_review_retry_limit_reads_env_and_clamps(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AGX_GROUP_REVIEW_MAX_RETRIES", "99")
    assert group_review_max_retries() == 4

    monkeypatch.setenv("AGX_GROUP_REVIEW_MAX_RETRIES", "-3")
    assert group_review_max_retries() == 0


def test_select_reviewer_excludes_executor_and_prefers_quality_role() -> None:
    members = [
        WorkflowMember("dev", "开发", "开发工程师"),
        WorkflowMember("research", "研究", "行业研究员"),
        WorkflowMember("qa", "质检", "质量审核与验收负责人"),
    ]

    reviewer = select_reviewer(members, executor_id="dev", task_index=0)

    assert reviewer is not None
    assert reviewer.avatar_id == "qa"
    assert reviewer.avatar_id != "dev"


def test_member_state_round_trip_is_isolated_and_bounded() -> None:
    owner = SimpleNamespace(scratchpad={})
    local_a = SimpleNamespace(
        agent_messages=[
            {"role": "system", "content": "hidden"},
            *[
                {"role": "user" if i % 2 == 0 else "assistant", "content": f"A-{i}-" + "x" * 1800}
                for i in range(30)
            ],
            {"role": "tool", "content": "tool-chain-must-not-persist"},
        ],
        chat_history=[],
    )
    local_b = SimpleNamespace(
        agent_messages=[
            {"role": "user", "content": "B-question"},
            {"role": "assistant", "content": "B-answer"},
        ],
        chat_history=[],
    )
    persist_member_runtime_state(owner, local_a, group_id="g1", avatar_id="a")
    persist_member_runtime_state(owner, local_b, group_id="g1", avatar_id="b")

    restored_a = SimpleNamespace(agent_messages=[], chat_history=[])
    restored_b = SimpleNamespace(agent_messages=[], chat_history=[])
    rows_a = restore_member_runtime_state(owner, restored_a, group_id="g1", avatar_id="a")
    rows_b = restore_member_runtime_state(owner, restored_b, group_id="g1", avatar_id="b")

    assert 0 < len(rows_a) <= MEMBER_HISTORY_MAX_MESSAGES
    assert sum(len(row["content"]) for row in rows_a) <= MEMBER_HISTORY_MAX_CHARS
    assert all(row["role"] in {"user", "assistant"} for row in rows_a)
    assert all("B-" not in row["content"] for row in rows_a)
    assert [row["content"] for row in rows_b] == ["B-question", "B-answer"]
    assert restored_a.chat_history == restored_a.agent_messages


def test_render_execution_dossier_contains_handoffs_and_gate_state() -> None:
    decision = parse_review_decision(
        '{"status":"pass","summary":"审核通过","issues":[],"strengths":["完整"]}'
    )
    record = WorkflowStageRecord(
        task_id="t2",
        description="整合方案",
        executor_id="dev",
        executor_name="开发",
        reviewer_id="qa",
        reviewer_name="质检",
        dependency_outputs={"t1": "已审核调研结论"},
        attempts=["最终方案正文"],
        reviews=[decision],
        final_output="最终方案正文",
        status="pass",
    )

    dossier = render_execution_dossier([record])

    assert "整合方案" in dossier
    assert "开发 (dev)" in dossier
    assert "质检 (qa)" in dossier
    assert "已接收上游: t1" in dossier
    assert "最终方案正文" in dossier
    assert "结论: pass" in dossier


def test_write_group_deliverable_creates_markdown(tmp_path: Path) -> None:
    record = WorkflowStageRecord(
        task_id="t1",
        description="调研",
        executor_id="a",
        executor_name="成员A",
        status="failed",
        failure_reason="缺少可访问数据源",
    )

    path = write_group_deliverable(
        group_id="g/path/../unsafe",
        group_name="方案组",
        original_request="调研 A/B 并给方案",
        run_id="run/../1",
        records=[record],
        final_answer="当前未完全闭环。",
        workspace_root=tmp_path,
    )

    assert path.is_file()
    assert path.parent == tmp_path / "deliverables"
    assert ".." not in path.name
    text = path.read_text(encoding="utf-8")
    assert "调研 A/B 并给方案" in text
    assert "缺少可访问数据源" in text
    assert "当前未完全闭环" in text


def _router_with_two_members() -> GroupChatRouter:
    avatars = {
        "executor": SimpleNamespace(
            id="executor",
            name="执行者",
            role="方案工程师",
            system_prompt="完成分配的方案任务",
            avatar_url="executor.png",
            default_provider="",
            default_model="",
        ),
        "reviewer": SimpleNamespace(
            id="reviewer",
            name="审核者",
            role="质量审核与验收负责人",
            system_prompt="独立审核交付质量",
            avatar_url="reviewer.png",
            default_provider="",
            default_model="",
        ),
    }
    registry = MagicMock()
    registry.get_avatar.side_effect = lambda avatar_id: avatars.get(avatar_id)
    return GroupChatRouter(
        avatar_registry=registry,
        llm_factory=MagicMock(return_value=MagicMock()),
        max_tool_rounds=3,
        host_avatar_id="executor",
    )


class _FakeCoordinator:
    async def assign_tasks(self, *, tasks, workers):
        return {str(task.id): "executor" for task in tasks}


class _FakeWorkforcePattern:
    def __init__(self, *, workers, **kwargs):
        self.worker_instances = [SimpleNamespace(id=worker.id) for worker in workers]
        self.coordinator = _FakeCoordinator()

    async def decompose_task(self, task):
        return [
            Task(
                id="stage-1",
                description="产出一份可交付方案",
                expected_output="完整方案",
                dependencies=[],
            )
        ]


class _ManyTaskWorkforcePattern:
    """Planner fixture that fills the room quota before final delivery."""

    def __init__(self, *, workers, **kwargs):
        self.worker_instances = [SimpleNamespace(id=worker.id) for worker in workers]

        class _Coordinator:
            async def assign_tasks(inner_self, *, tasks, workers):
                return {
                    str(task.id): str(workers[index % len(workers)].id)
                    for index, task in enumerate(tasks)
                }

        self.coordinator = _Coordinator()

    async def decompose_task(self, task):
        return [
            Task(
                id=f"stage-{index}",
                description=f"完成第 {index} 项交付",
                expected_output="完整结果",
                dependencies=[],
            )
            for index in range(10)
        ]


def _owner_session() -> SimpleNamespace:
    return SimpleNamespace(
        session_id="group-session",
        _session_id="group-session",
        _usage_owner_session_id="group-session",
        provider_name="openai",
        model_name="model",
        workspace_dir=None,
        context_files={},
        taskspaces=[],
        scratchpad={},
        chat_history=[],
    )


@pytest.mark.asyncio
async def test_delivery_mode_treats_execution_dossier_as_authoritative() -> None:
    router = _router_with_two_members()
    session = _owner_session()
    setattr(session, "__group_avatar_ids", ["executor", "reviewer"])
    context = GroupChatContext(session, max_items=20)
    captured: dict[str, object] = {}

    async def fake_llm(**kwargs):
        captured.update(kwargs)
        return "负责人交付"

    router._call_llm_text = fake_llm  # type: ignore[assignment]
    reply = await router._run_meta_project_manager_reply(
        base_session=session,
        context=context,
        group_name="交付群",
        user_input="团队执行档案：stage-1 已审核通过",
        delivery_mode=True,
    )

    prompt = str(captured["prompt"])
    assert "共同构成本轮权威事实" in prompt
    assert "以带 task_id、审核状态和产出的执行档案为准" in prompt
    assert int(captured["max_tokens"]) >= 4_000
    assert reply.content == "负责人交付"


@pytest.mark.asyncio
async def test_discussion_mode_project_manager_uses_read_only_scope() -> None:
    """Discussion turns must reach the real PM prompt without a runtime error."""
    router = _router_with_two_members()
    session = _owner_session()
    setattr(session, "__group_avatar_ids", ["executor", "reviewer"])
    setattr(session, "_group_analysis_only", True)
    context = GroupChatContext(session, max_items=20)
    captured: dict[str, object] = {}

    async def fake_llm(**kwargs):
        captured.update(kwargs)
        return "只读讨论结论"

    router._call_llm_text = fake_llm  # type: ignore[assignment]
    reply = await router._run_meta_project_manager_reply(
        base_session=session,
        context=context,
        group_name="讨论群",
        user_input="比较两个方案的优缺点",
    )

    prompt = str(captured["prompt"])
    assert "本轮范围：只做分析讨论" in prompt
    assert "不得把分析自行扩展成实施任务" in prompt
    assert "确实需要另一位成员补充时，只自然 @ 一位并写清具体问题" in prompt
    assert "不要求放在最后一行，也不要先写会议式交接理由" in prompt
    assert "正式交棒" not in prompt
    assert "先说明为什么需要对方" not in prompt
    assert "不需要别人接棒时不要 @" in prompt
    assert reply.content == "只读讨论结论"


@pytest.mark.asyncio
async def test_explicit_collaboration_expands_single_plan_across_members(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    router = _router_with_two_members()
    session = _owner_session()
    context = GroupChatContext(session, max_items=50)
    store = GraphRunStore(root=tmp_path / "graphs")
    executor_identities: list[str] = []

    async def fake_target_stream(**kwargs):
        avatar_id = str(kwargs["avatar_id"])
        user_input = str(kwargs["user_input"])
        if "独立质量审核者" not in user_input:
            executor_identities.append(avatar_id)
            content = f"{avatar_id} 的独立专业意见"
        else:
            content = (
                '{"status":"pass","summary":"独立意见可交付",'
                '"issues":[],"strengths":["角色视角明确"]}'
            )
        yield GroupReply(avatar_id, avatar_id, "", content, False, event_type="group_reply")

    async def fake_pm(**kwargs):
        kwargs["context"].append_agent(
            agent_id="__meta__",
            agent_name="Near",
            text="团队终稿",
        )
        return GroupReply("__meta__", "Near", "", "团队终稿", False, event_type="group_reply")

    def fake_deliverable(**kwargs):
        path = tmp_path / "collaboration.md"
        path.write_text("collaboration", encoding="utf-8")
        return path

    router._run_one_target_stream = fake_target_stream  # type: ignore[assignment]
    router._run_meta_project_manager_reply = fake_pm  # type: ignore[assignment]
    monkeypatch.setattr("agenticx.runtime.graph.store.get_default_store", lambda: store)
    monkeypatch.setattr(
        "agenticx.runtime.group_router.write_group_deliverable",
        fake_deliverable,
    )

    with patch(
        "agenticx.collaboration.workforce.workforce_pattern.WorkforcePattern",
        _FakeWorkforcePattern,
    ):
        replies = [
            reply
            async for reply in router._run_team_turn(
                base_session=session,
                context=context,
                group_id="g-independent",
                group_name="独立讨论群",
                group_avatar_ids=["executor", "reviewer"],
                user_input="请大家分别分析这个方案并交叉评审",
                quoted_content="",
                should_stop=lambda: False,
                user_display_name="我",
                # 「要不要多人分头出意见」现在是本轮编排计划的结论，由调用方传入，
                # 不再从提示词里查关键词。
                collaboration=True,
            )
        ]

    assert set(executor_identities) == {"executor", "reviewer"}
    assert sum(
        reply.event_type == "group_workflow_detail"
        and reply.event_data.get("workflow_event_type") == "task_completed"
        and reply.event_data.get("feed_visibility") == "panel"
        for reply in replies
    ) == 2
    run = store.list_by_session("group-session")[0]
    assert len(run.nodes) == 2
    assert {node.agent_id for node in run.nodes.values()} == {"executor", "reviewer"}
    assert all(node.status == NodeStatus.DONE for node in run.nodes.values())
    assert run.meta["collaborative_request"] is True
    assert run.meta["independent_first_passes"] is True


@pytest.mark.asyncio
async def test_team_stage_revises_then_passes_and_completes_once(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    router = _router_with_two_members()
    session = _owner_session()
    context = GroupChatContext(session, max_items=50)
    store = GraphRunStore(root=tmp_path / "graphs")
    persisted_attempts: list[tuple[int, int]] = []
    original_save = store.save

    def recording_save(run, *, bump_version=True):
        saved = original_save(run, bump_version=bump_version)
        persisted = store.load(run.run_id)
        if persisted is not None:
            attempts = persisted.nodes["stage-1"].meta.get("workflow_attempts")
            persisted_attempts.append(
                (
                    persisted.version,
                    len(attempts) if isinstance(attempts, list) else 0,
                )
            )
        return saved

    monkeypatch.setattr(store, "save", recording_save)
    calls: list[tuple[str, bool, str]] = []
    executor_calls = 0
    reviewer_calls = 0

    async def fake_target_stream(**kwargs):
        nonlocal executor_calls, reviewer_calls
        avatar_id = str(kwargs["avatar_id"])
        append_to_context = bool(kwargs.get("append_to_context", True))
        user_input = str(kwargs["user_input"])
        calls.append((avatar_id, append_to_context, user_input))
        if avatar_id == "executor":
            executor_calls += 1
            content = "候选方案 v1" if executor_calls == 1 else "修订方案 v2（已补证据）"
        else:
            reviewer_calls += 1
            content = (
                '{"status":"revise","summary":"关键依据缺失",'
                '"issues":[{"severity":"P1","problem":"没有证据",'
                '"fix":"补充证据边界"}],"strengths":[]}'
                if reviewer_calls == 1
                else '{"status":"pass","summary":"修改后可交付","issues":[],"strengths":["证据边界清晰"]}'
            )
        yield GroupReply(
            agent_id=avatar_id,
            avatar_name="执行者" if avatar_id == "executor" else "审核者",
            avatar_url="",
            content=content,
            skipped=False,
            event_type="group_reply",
        )

    async def fake_pm(**kwargs):
        kwargs["context"].append_agent(
            agent_id="__meta__",
            agent_name="Near",
            text="负责人终稿",
        )
        return GroupReply("__meta__", "Near", "", "负责人终稿", False, event_type="group_reply")

    def fake_deliverable(**kwargs):
        path = tmp_path / "deliverable.md"
        path.write_text("deliverable", encoding="utf-8")
        return path

    router._run_one_target_stream = fake_target_stream  # type: ignore[assignment]
    router._run_meta_project_manager_reply = fake_pm  # type: ignore[assignment]
    monkeypatch.setattr("agenticx.runtime.graph.store.get_default_store", lambda: store)
    monkeypatch.setattr("agenticx.runtime.group_router.group_review_max_retries", lambda: 2)
    monkeypatch.setattr("agenticx.runtime.group_router.write_group_deliverable", fake_deliverable)

    with patch(
        "agenticx.collaboration.workforce.workforce_pattern.WorkforcePattern",
        _FakeWorkforcePattern,
    ):
        replies = [
            reply
            async for reply in router._run_team_turn(
                base_session=session,
                context=context,
                group_id="g-reviewed",
                group_name="评审群",
                group_avatar_ids=["executor", "reviewer"],
                user_input="请按步骤产出一份可交付方案",
                quoted_content="",
                should_stop=lambda: False,
                user_display_name="我",
            )
        ]

    assert executor_calls == 2
    assert reviewer_calls == 2
    assert all(append is False for avatar, append, _ in calls if avatar == "executor")
    assert all(append is False for avatar, append, _ in calls if avatar == "reviewer")
    visible_replies = [
        reply.content
        for reply in replies
        if reply.event_type == "group_reply"
    ]
    assert "候选方案 v1" not in visible_replies
    assert visible_replies.count("修订方案 v2（已补证据）") == 0
    detail_replies = [
        reply for reply in replies if reply.event_type == "group_workflow_detail"
    ]
    assert any(
        reply.event_data.get("detail_kind") == "candidate_output"
        and reply.event_data.get("candidate_output") == "候选方案 v1"
        and reply.event_data.get("review_status") == "revise"
        for reply in detail_replies
    )
    assert any(
        reply.event_data.get("detail_kind") == "candidate_output"
        and reply.event_data.get("candidate_output") == "修订方案 v2（已补证据）"
        and reply.event_data.get("review_status") == "pass"
        for reply in detail_replies
    )
    assert any(
        reply.event_data.get("detail_kind") == "review_output"
        and "需要返工" in reply.content
        and reply.event_data.get("review_output")
        for reply in detail_replies
    )
    assert any(
        reply.event_data.get("detail_kind") == "review_output"
        and "审核通过" in reply.content
        and reply.event_data.get("review_output")
        for reply in detail_replies
    )
    graph_replies = [
        reply for reply in replies if reply.event_type.startswith("graph.")
    ]
    assert graph_replies
    assert any(reply.event_type == "graph.run_created" for reply in graph_replies)
    assert all(reply.skipped for reply in graph_replies)
    assert all(
        reply.event_data.get("feed_visibility") == "panel"
        and reply.event_data.get("detail_kind") == "graph_event"
        for reply in graph_replies
    )
    assert sum(
        reply.event_type == "group_workflow_detail"
        and reply.event_data.get("workflow_event_type") == "task_completed"
        for reply in replies
    ) == 1
    assert all(
        reply.event_data.get("feed_visibility") == "panel"
        for reply in detail_replies
    )
    assert all(reply.event_data.get("is_public") is False for reply in detail_replies)
    persisted_contents = [str(row.get("content") or "") for row in session.chat_history]
    assert "候选方案 v1" not in persisted_contents
    assert "修订方案 v2（已补证据）" not in persisted_contents
    assert not any("关键依据缺失" in content for content in persisted_contents)
    assert not any('"status":"revise"' in str(row.get("content")) for row in session.chat_history)

    runs = store.list_by_session("group-session")
    assert len(runs) == 1
    run = runs[0]
    assert run.nodes["stage-1"].status == NodeStatus.DONE
    assert run.nodes["stage-1"].retry_count == 1
    assert run.nodes["stage-1"].meta["review_status"] == "pass"
    attempts = run.nodes["stage-1"].meta["workflow_attempts"]
    assert [item["candidate_output"] for item in attempts] == [
        "候选方案 v1",
        "修订方案 v2（已补证据）",
    ]
    assert attempts[0]["review_output"].startswith('{"status":"revise"')
    assert attempts[1]["review_output"].startswith('{"status":"pass"')

    # Each completed candidate/review round must be durable before the node
    # finishes.  A final-only save would expose only attempt 2 after refresh.
    attempt_saves = [(version, count) for version, count in persisted_attempts if count]
    assert [count for _version, count in attempt_saves[:2]] == [1, 2]
    first_saved_versions: dict[int, int] = {}
    for version, count in attempt_saves:
        first_saved_versions.setdefault(count, version)

    graph_attempt_updates: dict[int, dict] = {}
    for reply in replies:
        if reply.event_type != "graph.node_updated":
            continue
        payload = json.loads(reply.content)
        node = payload.get("node")
        node_attempts = (
            node.get("meta", {}).get("workflow_attempts")
            if isinstance(node, dict)
            else None
        )
        if isinstance(node_attempts, list) and node_attempts:
            graph_attempt_updates.setdefault(len(node_attempts), payload)

    assert set(graph_attempt_updates) >= {1, 2}
    assert graph_attempt_updates[1]["node"]["meta"]["workflow_attempts"][0][
        "candidate_output"
    ] == "候选方案 v1"
    assert graph_attempt_updates[2]["node"]["meta"]["workflow_attempts"][1][
        "candidate_output"
    ] == "修订方案 v2（已补证据）"
    assert [
        graph_attempt_updates[count]["version"] for count in (1, 2)
    ] == [first_saved_versions[1], first_saved_versions[2]]

    assert run.meta["workflow_complete"] is True
    assert run.artifacts[0].path_or_uri == str(tmp_path / "deliverable.md")


@pytest.mark.asyncio
async def test_team_feed_quota_reserves_final_delivery_slot(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    avatars = {
        f"worker-{index}": SimpleNamespace(
            id=f"worker-{index}",
            name=f"成员 {index}",
            role="执行成员",
            system_prompt="完成分配的方案任务",
            avatar_url="",
            default_provider="",
            default_model="",
        )
        for index in range(5)
    }
    avatars["leader"] = SimpleNamespace(
        id="leader",
        name="负责人",
        role="项目负责人",
        system_prompt="完成团队收口",
        avatar_url="",
        default_provider="",
        default_model="",
    )
    registry = MagicMock()
    registry.get_avatar.side_effect = lambda avatar_id: avatars.get(avatar_id)
    router = GroupChatRouter(
        avatar_registry=registry,
        llm_factory=MagicMock(return_value=MagicMock()),
        max_tool_rounds=3,
        host_avatar_id="leader",
    )
    session = _owner_session()
    context = GroupChatContext(session, max_items=50)
    store = GraphRunStore(root=tmp_path / "graphs")

    async def fake_target_stream(**kwargs):
        avatar_id = str(kwargs["avatar_id"])
        user_input = str(kwargs["user_input"])
        is_review = "审核" in user_input
        yield GroupReply(
            agent_id=avatar_id,
            avatar_name=avatars[avatar_id].name,
            avatar_url="",
            content=(
                '{"status":"pass","summary":"可交付","issues":[]}'
                if is_review
                else f"{avatar_id} 的结果"
            ),
            skipped=False,
            event_type="group_reply",
        )

    async def fake_pm(**kwargs):
        publication_source = str(
            kwargs.get("publication_source", "host_reply") or "host_reply"
        )
        reply = GroupReply(
            "leader",
            "负责人",
            "",
            "最终交付",
            False,
            event_type="group_reply",
            event_data={"publication_source": publication_source},
        )
        router._append_public_reply_to_context(kwargs["context"], reply)
        return reply

    def fake_deliverable(**kwargs):
        path = tmp_path / "quota-deliverable.md"
        path.write_text("quota", encoding="utf-8")
        return path

    router._run_one_target_stream = fake_target_stream  # type: ignore[assignment]
    router._run_meta_project_manager_reply = fake_pm  # type: ignore[assignment]
    monkeypatch.setattr("agenticx.runtime.graph.store.get_default_store", lambda: store)
    monkeypatch.setattr(
        "agenticx.runtime.group_router.write_group_deliverable",
        fake_deliverable,
    )

    with patch(
        "agenticx.collaboration.workforce.workforce_pattern.WorkforcePattern",
        _ManyTaskWorkforcePattern,
    ):
        replies = [
            reply
            async for reply in router._run_team_turn(
                base_session=session,
                context=context,
                group_id="g-quota",
                group_name="限流验证群",
                group_avatar_ids=list(avatars)[:5],
                user_input="请完成十项交付",
                quoted_content="",
                should_stop=lambda: False,
                user_display_name="我",
            )
        ]

    feed = [
        reply
        for reply in replies
        if reply.event_type == "group_reply"
        and reply.event_data.get("feed_visibility") == "feed"
    ]
    overflow = [
        reply
        for reply in replies
        if reply.event_type == "group_workflow_detail"
        and reply.event_data.get("detail_kind") == "feed_quota_overflow"
    ]
    assert len(feed) == 10  # nine acceptance messages plus final delivery
    assert feed[-1].event_data["publication_source"] == "workflow_final_delivery"
    policy = getattr(session, "__group_social_turn_policy")
    assert policy.public_message_count == len(feed) == len(context.public_message_summaries())
    assert all(
        reply.event_data.get("group_id") == "g-quota"
        and reply.event_data.get("is_public") is True
        and reply.event_data.get("feed_visibility") == "feed"
        for reply in feed
    )
    assert all(
        str(reply.event_data.get("message_id") or "").startswith("gmsg_")
        for reply in feed
    )
    assert len(overflow) == 1
    assert overflow[0].event_data["workflow_event_type"] == "task_assigned"
    assert overflow[0].event_data["feed_visibility"] == "panel"
    assert len(context.public_message_summaries()) == 10
    final_row = next(
        row
        for row in reversed(session.chat_history)
        if str(row.get("content") or "").startswith("最终交付")
    )
    assert final_row["metadata"]["group_publication_source"] == (
        "workflow_final_delivery"
    )
    assert final_row["group_id"] == "g-quota"
    assert final_row["is_public"] is True
    assert final_row["feed_visibility"] == "feed"
    assert final_row["metadata"]["group_id"] == "g-quota"
    assert final_row["metadata"]["is_public"] is True
    assert final_row["metadata"]["feed_visibility"] == "feed"


@pytest.mark.asyncio
async def test_team_stage_review_failure_does_not_emit_completed(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    router = _router_with_two_members()
    session = _owner_session()
    context = GroupChatContext(session, max_items=50)
    store = GraphRunStore(root=tmp_path / "graphs")
    captured_pm_input: list[str] = []

    async def fake_target_stream(**kwargs):
        avatar_id = str(kwargs["avatar_id"])
        content = (
            "候选方案"
            if avatar_id == "executor"
            else '{"status":"fail","summary":"核心产物不可用",'
            '"issues":[{"severity":"P0","problem":"缺少核心结果","fix":"重做"}]}'
        )
        yield GroupReply(avatar_id, avatar_id, "", content, False, event_type="group_reply")

    async def fake_pm(**kwargs):
        captured_pm_input.append(str(kwargs["user_input"]))
        kwargs["context"].append_agent(
            agent_id="__meta__",
            agent_name="Near",
            text="存在未闭环项",
        )
        return GroupReply("__meta__", "Near", "", "存在未闭环项", False, event_type="group_reply")

    def fake_deliverable(**kwargs):
        path = tmp_path / "failed-deliverable.md"
        path.write_text("failed", encoding="utf-8")
        return path

    router._run_one_target_stream = fake_target_stream  # type: ignore[assignment]
    router._run_meta_project_manager_reply = fake_pm  # type: ignore[assignment]
    monkeypatch.setattr("agenticx.runtime.graph.store.get_default_store", lambda: store)
    monkeypatch.setattr("agenticx.runtime.group_router.group_review_max_retries", lambda: 0)
    monkeypatch.setattr("agenticx.runtime.group_router.write_group_deliverable", fake_deliverable)

    with patch(
        "agenticx.collaboration.workforce.workforce_pattern.WorkforcePattern",
        _FakeWorkforcePattern,
    ):
        replies = [
            reply
            async for reply in router._run_team_turn(
                base_session=session,
                context=context,
                group_id="g-failed",
                group_name="失败门控群",
                group_avatar_ids=["executor", "reviewer"],
                user_input="请按步骤产出一份可交付方案",
                quoted_content="",
                should_stop=lambda: False,
                user_display_name="我",
            )
        ]

    assert not any(
        reply.event_type == "group_workflow_detail"
        and reply.event_data.get("workflow_event_type") == "task_completed"
        for reply in replies
    )
    assert any(
        reply.event_type == "group_reply"
        and reply.event_data.get("publication_source") == "workflow_task_failed"
        and "遇到阻塞" in reply.content
        for reply in replies
    )
    assert any(
        reply.event_type == "group_workflow_detail"
        and reply.event_data.get("detail_kind") == "candidate_output"
        and reply.event_data.get("candidate_output") == "候选方案"
        for reply in replies
    )
    assert not any(
        str(row.get("content") or "") == "候选方案"
        for row in session.chat_history
    )
    assert captured_pm_input and "状态: failed" in captured_pm_input[0]
    run = store.list_by_session("group-session")[0]
    assert run.nodes["stage-1"].status == NodeStatus.FAILED
    assert run.meta["workflow_complete"] is False
