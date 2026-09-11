"""Pure tests for the group-scoped social relationship memory."""

from __future__ import annotations

from types import SimpleNamespace

from agenticx.runtime.group_social_memory import (
    GroupSocialMemory,
    is_public_group_message,
)


def _reply(
    agent_id: str,
    content: str,
    *,
    message_id: str = "",
    group_id: str = "room-1",
    **extra: object,
) -> dict[str, object]:
    return {
        "agent_id": agent_id,
        "avatar_name": agent_id,
        "content": content,
        "message_id": message_id,
        "group_id": group_id,
        "is_public": True,
        "event_type": "group_reply",
        "skipped": False,
        **extra,
    }


def test_public_gate_rejects_private_and_cross_group_inputs() -> None:
    public = _reply("a1", "公开判断", message_id="m1")
    assert is_public_group_message(public, group_id="room-1") is True
    assert is_public_group_message(
        {key: value for key, value in public.items() if key != "is_public"},
        group_id="room-1",
    ) is False
    assert is_public_group_message(
        {**public, "is_draft": True}, group_id="room-1"
    ) is False
    assert is_public_group_message({**public, "scope": "direct"}, group_id="room-1") is False
    assert is_public_group_message({**public, "is_private": True}, group_id="room-1") is False
    assert is_public_group_message({**public, "group_id": "room-2"}, group_id="room-1") is False
    assert is_public_group_message({**public, "skipped": True}, group_id="room-1") is False
    assert is_public_group_message({**public, "content": "pass"}, group_id="room-1") is False
    assert is_public_group_message({**public, "event_type": "group_tool_result"}, group_id="room-1") is False
    assert is_public_group_message(
        {**public, "workflow_event_type": "workflow_detail"}, group_id="room-1"
    ) is False
    assert is_public_group_message(
        {**public, "workflow_event_type": "task_completed"}, group_id="room-1"
    ) is False
    assert is_public_group_message(
        {**public, "workflow_event_type": "task_assigned"}, group_id="room-1"
    ) is True
    assert is_public_group_message(
        {**public, "workflow_status": "task_failed"}, group_id="room-1"
    ) is True
    assert is_public_group_message(
        {**public, "workflow_status": "workflow_progress"}, group_id="room-1"
    ) is False
    assert is_public_group_message(
        {**public, "event_type": "group_reaction"}, group_id="room-1"
    ) is False
    assert is_public_group_message(
        {**public, "metadata": {"feed_visibility": "panel"}}, group_id="room-1"
    ) is False
    assert is_public_group_message(
        {**public, "event_data": {"publication_source": "workflow_private"}},
        group_id="room-1",
    ) is False
    memory = GroupSocialMemory("room-1", storage_dir="/tmp/agx-social-memory-test")
    assert memory.record_public_message({**public, "message_id": ""}) is False


def test_public_message_updates_all_relationship_dimensions() -> None:
    memory = GroupSocialMemory("room-1", storage_dir="/tmp/agx-social-memory-test")
    accepted = memory.record_public_message(
        {
            "group_id": "room-1",
            "is_public": True,
            "role": "user",
            "sender_id": "user",
            "content": "@产品策划师 看看 roadmap 👍",
            "message_id": "u1",
            "mentioned_avatar_ids": ["a1"],
            "topic": "roadmap",
            "unresolved_topics": [{"topic": "权限边界", "description": "还没定"}],
            "style": {"tone": "轻松", "format": "短句"},
            "turn_id": "turn-1",
        }
    )
    assert accepted is True
    assert memory.preferred_name("a1") == "产品策划师"
    # A user message is not a topic owner, but it can establish a public open topic.
    assert memory.get_topic_owner("roadmap") is None
    assert "权限边界" in memory.unresolved_topics
    assert memory.style_profile["message_count"] == 1
    assert memory.style_profile["uses_emoji"] is True

    accepted = memory.record_public_message(
        _reply(
            "a1",
            "roadmap 我来负责，先确认权限。",
            message_id="a2",
            topic="roadmap",
            reply_to_message_id="u1",
            timestamp="2026-08-29T10:00:00+00:00",
        )
    )
    assert accepted is True
    assert memory.get_topic_owner("ROADMAP")["owner_id"] == "a1"  # type: ignore[index]
    assert memory.reply_relations[0]["to_message_id"] == "u1"
    assert memory.reply_relations[0]["from_agent_id"] == "a1"


def test_user_addressing_preference_counts_and_deduplicates_message_id() -> None:
    memory = GroupSocialMemory("room-1", storage_dir="/tmp/agx-social-memory-test")
    message = {
        "group_id": "room-1",
        "is_public": True,
        "role": "user",
        "sender_id": "user",
        "content": "@产品 看一下",
        "mentioned_avatar_ids": ["a1"],
        "mention_labels": ["产品"],
        "message_id": "u1",
    }
    assert memory.record_public_message(message) is True
    assert memory.record_public_message(message) is False
    assert memory.addressing_habits["a1"]["labels"] == {"产品": 1}

    memory.record_public_message(
        {
            **message,
            "message_id": "u2",
            "content": "@产品策划师 再看一下",
            "mention_labels": ["产品策划师"],
        }
    )
    # Equal-frequency labels use the latest observed form as the tie-breaker.
    assert memory.addressing_habits["a1"]["preferred_label"] == "产品策划师"
    assert memory.addressing_habits["a1"]["count"] == 2


def test_private_message_never_enters_any_dimension() -> None:
    memory = GroupSocialMemory("room-1", storage_dir="/tmp/agx-social-memory-test")
    private = _reply(
        "a1",
        "这是私聊秘密",
        message_id="private-1",
        scope="direct",
        topic="秘密项目",
        disagreement={"topic": "秘密项目", "participants": ["a1", "a2"]},
        unresolved_topics=["私聊未决"],
        reply_to_message_id="private-parent",
    )
    assert memory.record_public_message(private) is False
    assert memory.to_dict()["addressing_habits"] == {}
    assert memory.topic_owners == {}
    assert memory.disagreements == []
    assert memory.reply_relations == []
    assert memory.unresolved_topics == {}
    assert memory.style_profile["message_count"] == 0


def test_disagreement_and_unresolved_topic_lifecycle_is_public_only() -> None:
    memory = GroupSocialMemory("room-1", storage_dir="/tmp/agx-social-memory-test")
    source = _reply("a1", "我们对上线范围有不同判断", message_id="m1", topic="上线范围")
    assert memory.record_disagreement(
        {
            "topic": "上线范围",
            "participants": ["a1", "a2"],
            "positions": {"a1": "全量", "a2": "灰度"},
            "summary": "先灰度还是直接全量",
        },
        source_message=source,
        source_message_id="m1",
    ) is True
    assert memory.disagreements[0]["status"] == "open"
    assert memory.record_disagreement(
        {"topic": "私聊争议", "private": True},
        source_message=source,
    ) is False

    assert memory.add_unresolved_topic(
        {"topic": "验收口径", "description": "还需确认负责人"},
        source_message=source,
    ) is True
    assert "验收口径" in memory.unresolved_topics
    assert memory.resolve_topic("验收口径", source_message=source) is True
    assert "验收口径" not in memory.unresolved_topics

    private_source = {**source, "scope": "private"}
    assert memory.add_unresolved_topic("不应进入", source_message=private_source) is False
    assert "不应进入" not in memory.unresolved_topics


def test_normal_reply_does_not_close_topic_but_explicit_and_workflow_final_do() -> None:
    memory = GroupSocialMemory("room-1", storage_dir="/tmp/agx-social-memory-test")
    assert memory.record_public_message(
        _reply(
            "user",
            "请确认权限边界",
            message_id="u-topic",
            role="user",
            topic="权限边界",
            unresolved_topics=[{"topic": "权限边界", "description": "还没有结论"}],
        )
    ) is True

    # Merely answering in the same topic is not a resolution signal.
    assert memory.record_public_message(
        _reply("a1", "我先补充一个方案，仍需产品确认。", message_id="a-partial", topic="权限边界")
    ) is True
    assert "权限边界" in memory.unresolved_topics

    # A structured resolved_topic is an explicit close operation.
    assert memory.record_public_message(
        _reply(
            "a1",
            "方案已确认。",
            message_id="a-resolved",
            topic="权限边界",
            resolved_topic="权限边界",
        )
    ) is True
    assert "权限边界" not in memory.unresolved_topics

    assert memory.add_unresolved_topic("交付验收", source_message=_reply("user", "还要验收", message_id="u-final")) is True
    # A workflow final is allowed to close the active topic even when the
    # adapter does not duplicate it into resolved_topic.
    assert memory.record_public_message(
        _reply(
            "__meta__",
            "最终交付已完成",
            message_id="workflow-final",
            topic="交付验收",
            publication_source="workflow_final_delivery",
            feed_visibility="feed",
        )
    ) is True
    assert "交付验收" not in memory.unresolved_topics


def test_low_signal_public_messages_do_not_open_unresolved_topics() -> None:
    memory = GroupSocialMemory("room-1", storage_dir="/tmp/agx-social-memory-test")
    for index, content in enumerate(("谢谢", "好的", "确认", "👍👍"), start=1):
        assert memory.record_public_message(
            _reply(
                "user",
                content,
                message_id=f"low-signal-{index}",
                role="user",
                topic=f"闲聊-{index}",
                unresolved_topics=[f"闲聊-{index}"],
            )
        ) is True
    assert memory.unresolved_topics == {}

    assert memory.record_public_message(
        _reply(
            "user",
            "请继续跟进权限边界",
            message_id="open-topic-for-resolution",
            role="user",
            topic="权限边界",
            unresolved_topics=["权限边界"],
        )
    ) is True
    assert "权限边界" in memory.unresolved_topics
    assert memory.record_public_message(
        _reply(
            "user",
            "已完成",
            message_id="explicit-resolution",
            role="user",
            topic="已完成",
            unresolved_topics=["已完成"],
        )
    ) is True
    assert memory.unresolved_topics == {}


def test_nested_private_structured_facts_never_enter_memory() -> None:
    memory = GroupSocialMemory("room-1", storage_dir="/tmp/agx-social-memory-test")
    source = _reply("a1", "公开争议", message_id="public-source")
    assert memory.record_disagreement(
        {
            "topic": "panel-only",
            "participants": ["a1", "a2"],
            "summary": "内部审核细节",
            "metadata": {"feed_visibility": "panel"},
        },
        source_message=source,
    ) is False
    assert memory.add_unresolved_topic(
        {
            "topic": "private-workflow",
            "event_data": {"publication_source": "workflow_private"},
        },
        source_message=source,
    ) is False
    assert memory.record_style(
        {"tone": "内部草稿", "metadata": {"feed_visibility": "draft"}},
        source_message=source,
    ) is False
    assert memory.disagreements == []
    assert memory.unresolved_topics == {}
    assert memory.style_profile["message_count"] == 0


def test_public_message_does_not_admit_private_nested_facts() -> None:
    memory = GroupSocialMemory("room-1", storage_dir="/tmp/agx-social-memory-test")
    accepted = memory.record_public_message(
        _reply(
            "a1",
            "公开消息",
            message_id="nested-private-message",
            topic={
                "topic": "panel-topic",
                "group_id": "room-1",
                "metadata": {"feed_visibility": "panel"},
            },
            disagreement={
                "topic": "private-disagreement",
                "participants": ["a1", "a2"],
                "metadata": {"feed_visibility": "panel"},
            },
            unresolved_topics=[
                {
                    "topic": "private-workflow",
                    "event_data": {"publication_source": "workflow_private"},
                }
            ],
            reactions=[
                {
                    "emoji": "👍",
                    "actor_ids": ["a2"],
                    "metadata": {"feed_visibility": "panel"},
                }
            ],
            style={"tone": "private", "metadata": {"feed_visibility": "draft"}},
        )
    )
    assert accepted is True
    assert memory.topic_owners == {}
    assert memory.disagreements == []
    assert memory.unresolved_topics == {}
    assert memory.reaction_relations == []
    assert memory.style_profile["tone_counts"] == {}


def test_public_reactions_are_recorded_toggled_and_restored(tmp_path) -> None:
    path = tmp_path / "social.json"
    memory = GroupSocialMemory("room-1", storage_path=path)
    target = _reply("a1", "公开结论", message_id="m-reaction")
    assert memory.record_public_message(
        {**target, "reactions": [{"emoji": "👍", "actor_ids": ["user", "a2"]}]}
    ) is True
    assert memory.reaction_relations[0]["message_id"] == "m-reaction"
    assert memory.reaction_relations[0]["actor_ids"] == ["user", "a2"]

    assert memory.record_public_reaction("m-reaction", "a2", "👍", active=False) is True
    assert memory.reaction_relations[0]["actor_ids"] == ["user"]
    assert memory.record_public_reaction("m-reaction", "user", "👍", active=False) is True
    assert memory.reaction_relations == []
    assert memory.record_public_reaction("unknown", "user", "👍") is False

    assert memory.record_public_reaction(
        "m-reaction", "user", "🔥", source_message={**target, "scope": "direct"}
    ) is False

    # Aggregated reactions on a public message survive the JSON round-trip.
    assert memory.record_public_reaction("m-reaction", "a2", "✅") is True
    memory.persist()
    restored = GroupSocialMemory("room-1", storage_path=path)
    assert restored.load() is True
    assert restored.reaction_relations[0]["emoji"] == "✅"
    assert restored.reaction_relations[0]["actor_ids"] == ["a2"]


def test_persist_restore_is_group_isolated_and_atomic(tmp_path) -> None:
    root = tmp_path / "groups"
    first = GroupSocialMemory("room-1", storage_dir=root)
    first.record_public_message(
        _reply(
            "a1",
            "我负责支付链路。",
            message_id="m1",
            topic="支付",
            disagreement={"topic": "支付", "participants": ["a1", "a2"], "summary": "两种方案"},
        )
    )
    first.persist()
    assert first.storage_path.exists()

    restored = GroupSocialMemory("room-1", storage_dir=root)
    assert restored.load() is True
    assert restored.get_topic_owner("支付")["owner_id"] == "a1"  # type: ignore[index]
    assert restored.disagreements[0]["summary"] == "两种方案"

    other = GroupSocialMemory("room-2", storage_dir=root)
    assert other.storage_path != first.storage_path
    assert other.load() is False
    assert other.topic_owners == {}
    assert other.disagreements == []

    # Even if a caller points another group at room-1's file, the embedded id
    # check prevents cross-group restoration.
    forged = GroupSocialMemory("room-2", storage_path=first.storage_path)
    assert forged.load() is False
    assert forged.to_dict()["group_id"] == "room-2"


def test_interleaved_instances_merge_topics_relations_and_style(tmp_path) -> None:
    """Separate session snapshots must not overwrite one another."""

    path = tmp_path / "social.json"
    first = GroupSocialMemory("room-1", storage_path=path, auto_persist=True)
    second = GroupSocialMemory("room-1", storage_path=path, auto_persist=True)

    assert first.record_public_message(
        _reply(
            "a1",
            "支付链路由我负责。",
            message_id="first-message",
            topic="支付链路",
            reply_to_message_id="user-question",
            style={"tone": "稳健"},
        )
    ) is True
    assert second.record_public_message(
        _reply(
            "a2",
            "权限边界我来跟进。",
            message_id="second-message",
            topic="权限边界",
            reply_to_message_id="user-question",
            style={"tone": "直接"},
        )
    ) is True

    restored = GroupSocialMemory.open("room-1", storage_path=path)
    assert restored.get_topic_owner("支付链路")["owner_id"] == "a1"  # type: ignore[index]
    assert restored.get_topic_owner("权限边界")["owner_id"] == "a2"  # type: ignore[index]
    assert {item["from_agent_id"] for item in restored.reply_relations} == {"a1", "a2"}
    assert restored.style_profile["message_count"] == 2
    assert restored.style_profile["tone_counts"] == {"稳健": 1, "直接": 1}


def test_restore_rejects_corrupt_or_private_scope_without_partial_mutation(tmp_path) -> None:
    path = tmp_path / "social.json"
    memory = GroupSocialMemory("room-1", storage_path=path)
    memory.record_public_message(_reply("a1", "保留的公开内容", message_id="m1"))
    path.write_text("not json", encoding="utf-8")
    assert memory.load() is False
    assert memory.style_profile["message_count"] == 1

    path.write_text(
        '{"schema_version":1,"group_id":"room-2","style_profile":{"message_count":99}}',
        encoding="utf-8",
    )
    assert memory.load() is False
    assert memory.style_profile["message_count"] == 1


def test_object_input_does_not_scan_or_import_private_session_state() -> None:
    memory = GroupSocialMemory("room-1", storage_dir="/tmp/agx-social-memory-test")
    obj = SimpleNamespace(
        agent_id="a1",
        content="公开消息",
        skipped=False,
        event_type="group_reply",
        group_id="room-1",
        is_public=True,
        message_id="object-public-1",
        # This is deliberately not an accepted input field.  The memory layer
        # must not walk it looking for extra messages.
        chat_history=[{"content": "一对一私聊秘密", "scope": "direct"}],
    )
    assert memory.record_public_message(obj) is True
    assert "私聊秘密" not in memory.render_context()
