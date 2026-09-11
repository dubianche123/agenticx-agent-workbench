"""Pure unit tests for the group-chat social-turn policy."""

from __future__ import annotations

import hashlib
from types import SimpleNamespace

from agenticx.runtime.group_social_turn import SocialTurnPolicy


def _reply(
    agent_id: str,
    content: str,
    *,
    skipped: bool = False,
    event_type: str = "group_reply",
    action: str = "",
) -> SimpleNamespace:
    return SimpleNamespace(
        agent_id=agent_id,
        avatar_name=agent_id,
        content=content,
        skipped=skipped,
        event_type=event_type,
        action=action,
    )


def test_order_is_sha256_deterministic_for_same_group_and_turn() -> None:
    members = ["product", "tech", "qa", "design"]
    first = SocialTurnPolicy(turn_id="turn-42", group_id="room-7")
    second = SocialTurnPolicy(turn_id="turn-42", group_id="room-7")

    assert first.order_candidates(members) == second.order_candidates(members)
    expected = hashlib.sha256(b"room-7:turn-42:product").hexdigest()
    assert first.digest_for("product") == expected
    assert first.order_candidates(members) == sorted(
        members,
        key=lambda member: hashlib.sha256(
            f"room-7:turn-42:{member}".encode("utf-8")
        ).hexdigest(),
    )


def test_new_turn_can_rotate_equal_score_candidates_but_is_reproducible() -> None:
    members = ["a", "b", "c", "d"]
    orders = [
        tuple(
            SocialTurnPolicy(turn_id=f"turn-{turn}", group_id="room").order_candidates(
                members
            )
        )
        for turn in range(20)
    ]

    # The hash seed is deterministic, but it is intentionally turn-specific;
    # at least one new turn should offer a different first speaker.
    assert len(set(orders)) > 1
    assert orders[3] == tuple(
        SocialTurnPolicy(turn_id="turn-3", group_id="room").order_candidates(members)
    )


def test_relevance_score_precedes_hash_and_hash_breaks_ties() -> None:
    policy = SocialTurnPolicy(turn_id="t", group_id="g")
    members = ["low", "tie-a", "high", "tie-b"]

    ordered = policy.order_candidates(
        members,
        scores={"low": 0.1, "tie-a": 0.5, "high": 0.9, "tie-b": 0.5},
    )
    assert ordered[0] == "high"
    assert set(ordered[1:3]) == {"tie-a", "tie-b"}
    assert ordered[-1] == "low"
    assert policy.order_candidates(members, scores=lambda member: {"high": 1}.get(member, 0)) == policy.order_candidates(
        members, scores={"high": 1}
    )


def test_room_and_member_caps_count_only_visible_replies() -> None:
    policy = SocialTurnPolicy(
        turn_id="turn-1",
        group_id="room-1",
        max_public_messages=3,
        max_messages_per_member=2,
    )

    assert policy.record_reply(_reply("a", "先说一句")) is True
    assert policy.record_reply(_reply("a", "补充一句")) is True
    assert policy.record_reply(_reply("a", "第三句")) is False
    assert policy.record_reply(_reply("b", "跳过", skipped=True)) is False
    assert policy.record_reply(_reply("b", "pass", action="pass")) is False
    assert policy.record_reply(_reply("b", "可见消息")) is True

    assert policy.public_message_count == 3
    assert policy.remaining_public_messages == 0
    assert policy.messages_by_member == {"a": 2, "b": 1}
    assert policy.member_message_count("a") == 2
    assert policy.can_publish("a") is False
    assert policy.can_publish("c") is False
    assert len(policy.visible_replies) == 3
    assert len(policy.non_public_replies) == 2


def test_skipped_pass_and_progress_objects_never_consume_capacity() -> None:
    policy = SocialTurnPolicy(turn_id="t", group_id="g")
    private_events = [
        _reply("a", "", skipped=True),
        _reply("a", "", event_type="group_skipped"),
        _reply("a", "", event_type="group_progress"),
        _reply("a", "__SKIP__"),
        _reply("a", "(pass)"),
        {"agent_id": "a", "content": "skip", "action": "skip"},
    ]

    for event in private_events:
        assert policy.is_public_reply(event) is False
        assert policy.record_reply(event) is False

    assert policy.public_message_count == 0
    assert policy.remaining_public_messages == 10
    assert policy.messages_by_member == {}
    assert policy.can_publish("a") is True


def test_reply_like_mapping_and_object_do_not_require_group_router_import() -> None:
    mapping = {"agent_id": "mapping-member", "content": "映射消息", "skipped": False}
    object_reply = _reply("object-member", "对象消息")
    policy = SocialTurnPolicy(turn_id="t", group_id="g")

    assert policy.record_reply(mapping) is True
    assert policy.record_reply(object_reply) is True
    assert [reply["agent_id"] if isinstance(reply, dict) else reply.agent_id for reply in policy.visible_replies] == [
        "mapping-member",
        "object-member",
    ]


def test_select_candidates_respects_remaining_room_capacity() -> None:
    policy = SocialTurnPolicy(
        turn_id="t",
        group_id="g",
        max_public_messages=2,
        max_messages_per_member=2,
    )
    members = ["a", "b", "c"]
    assert len(policy.select_candidates(members)) == 2
    assert len(policy.select_candidates(members, limit=99)) == 2
    assert policy.record_reply(_reply("a", "one")) is True
    assert len(policy.select_candidates(members)) == 1
    assert policy.record_reply(_reply("b", "two")) is True
    assert policy.select_candidates(members) == []

