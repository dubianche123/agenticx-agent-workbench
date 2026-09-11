"""Focused API contracts for public group-message reactions."""

from __future__ import annotations

from types import SimpleNamespace

from fastapi.testclient import TestClient

from agenticx.runtime.group_context import GroupChatContext
from agenticx.runtime.group_router import GroupChatRouter, TurnPlan
from agenticx.runtime.group_social_memory import GroupSocialMemory
from agenticx.llms.request_context import reset_current_llm_turn_id, set_current_llm_turn_id
from agenticx.studio.server import create_studio_app


def _group_session(client: TestClient, app: object) -> tuple[str, object, object]:
    session_id = client.get("/api/session").json()["session_id"]
    avatar_registry = app.state.avatar_registry  # type: ignore[attr-defined]
    group_registry = app.state.group_registry  # type: ignore[attr-defined]
    avatar = avatar_registry.create_avatar(name="回应专家", role="测试")
    group = group_registry.create_group(name="回应测试群", avatar_ids=[avatar.id])
    manager = app.state.session_manager  # type: ignore[attr-defined]
    managed = manager.get(session_id)
    assert managed is not None
    managed.avatar_id = f"group:{group.id}"
    return session_id, group, managed


def test_group_reaction_endpoint_toggles_and_persists() -> None:
    app = create_studio_app()
    client = TestClient(app)
    session_id, group, managed = _group_session(client, app)
    context = GroupChatContext(managed.studio_session, group_id=group.id)
    message_id = context.append_agent(
        agent_id="expert",
        agent_name="回应专家",
        text="可以对这条消息回应。",
    )

    first = client.post(
        f"/api/groups/{group.id}/messages/{message_id}/reaction",
        json={"session_id": session_id, "actor": "user", "emoji": "👍"},
    )
    assert first.status_code == 200
    assert first.json()["active"] is True
    assert first.json()["reactions"] == [{"emoji": "👍", "actor_ids": ["user"]}]
    memory = getattr(managed.studio_session, "__group_social_memory", None)
    assert isinstance(memory, GroupSocialMemory)
    assert memory.reaction_relations[0]["actor_ids"] == ["user"]

    # The endpoint is a toggle, not an append-only reaction API.
    second = client.post(
        f"/api/groups/{group.id}/messages/{message_id}/reaction",
        json={"session_id": session_id, "actor": "user", "emoji": "👍"},
    )
    assert second.status_code == 200
    assert second.json()["active"] is False
    assert second.json()["reactions"] == []
    assert context._history()[-1].get("metadata", {}).get("group_reactions") == []
    assert memory.reaction_relations == []


def test_group_reaction_endpoint_enforces_binding_message_and_input() -> None:
    app = create_studio_app()
    client = TestClient(app)
    session_id, group, managed = _group_session(client, app)
    context = GroupChatContext(managed.studio_session, group_id=group.id)
    message_id = context.append_user("群消息", sender_name="同事")
    path = f"/api/groups/{group.id}/messages/{message_id}/reaction"

    assert client.post(
        path,
        json={"session_id": session_id, "actor": "agent", "emoji": "👍"},
    ).status_code == 400
    assert client.post(
        path,
        json={"session_id": session_id, "actor": "user", "emoji": "🔥"},
    ).status_code == 400
    assert client.post(
        f"/api/groups/{group.id}/messages/not-a-group-message/reaction",
        json={"session_id": session_id, "actor": "user", "emoji": "👍"},
    ).status_code == 404

    managed.avatar_id = "group:another-group"
    assert client.post(
        path,
        json={"session_id": session_id, "actor": "user", "emoji": "👍"},
    ).status_code == 403


def test_group_turn_emits_accepted_event_with_stable_message_id() -> None:
    class _Registry:
        def get_avatar(self, _avatar_id: str) -> object:
            return SimpleNamespace(name="回应专家", avatar_url="")

    router = GroupChatRouter(
        avatar_registry=_Registry(),
        llm_factory=lambda *_args: None,
        max_tool_rounds=1,
        host_avatar_id="expert",
    )
    session = SimpleNamespace(
        session_id="accepted-event-session",
        _session_id="accepted-event-session",
        chat_history=[],
        scratchpad={},
    )

    async def _plan(**_kwargs: object) -> TurnPlan:
        return TurnPlan(scope="discussion", collaboration=False, reason="test")

    async def _no_replies(**_kwargs: object):
        if False:
            yield None

    router._plan_turn = _plan  # type: ignore[method-assign]
    router._run_intelligent_turn = _no_replies  # type: ignore[method-assign]
    token = set_current_llm_turn_id("client-turn-accepted")
    try:
        async def _collect():
            return [
                reply
                async for reply in router.run_group_turn(
                    base_session=session,
                    group_id="group-accepted",
                    group_name="测试群",
                    routing="intelligent",
                    group_avatar_ids=["expert"],
                    mentioned_avatar_ids=[],
                    user_input="请回答",
                    quoted_content="",
                    should_stop=lambda: False,
                )
            ]

        import asyncio

        replies = asyncio.run(_collect())
    finally:
        reset_current_llm_turn_id(token)

    assert len(replies) == 1
    accepted = replies[0]
    assert accepted.event_type == "group_user_accepted"
    assert accepted.agent_id == "user"
    assert accepted.skipped is True
    message_id = str(accepted.event_data["message_id"])
    assert message_id == accepted.event_data["group_message_id"]
    assert message_id.startswith("gmsg_")
    assert accepted.event_data["client_turn_id"] == "client-turn-accepted"
    assert session.chat_history[0]["id"] == message_id
