"""Security boundaries for group-feed history and managed sessions."""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from agenticx.runtime.group_context import GroupChatContext
from agenticx.studio.server import create_studio_app


def _group_pair(app: object) -> tuple[object, object, object]:
    registry = app.state.avatar_registry  # type: ignore[attr-defined]
    groups = app.state.group_registry  # type: ignore[attr-defined]
    avatar = registry.create_avatar(name="群成员", role="测试")
    first = groups.create_group(name="群 A", avatar_ids=[avatar.id])
    second = groups.create_group(name="群 B", avatar_ids=[avatar.id])
    return first, second, avatar


def _row(
    message_id: str,
    content: str,
    *,
    group_id: str,
    attachment_id: str,
    **markers: object,
) -> dict[str, object]:
    return {
        "id": message_id,
        "role": "assistant",
        "content": content,
        "sender_id": "member",
        "sender_name": "成员",
        "group_id": group_id,
        "feed_visibility": "feed",
        "is_public": True,
        "attachments": [{"id": attachment_id, "name": f"{attachment_id}.txt"}],
        **markers,
    }


def test_group_feed_is_fail_closed_for_history_attachments_and_reactions() -> None:
    session = SimpleNamespace(chat_history=[], scratchpad={})
    context = GroupChatContext(session, group_id="room-a")
    public_id = context.append_user(
        "公开消息",
        attachments=[{"id": "public-attachment", "name": "公开.txt"}],
    )
    public_row = session.chat_history[0]
    assert public_row["group_id"] == "room-a"
    assert public_row["feed_visibility"] == "feed"
    assert public_row["is_public"] is True

    # These rows intentionally carry realistic-looking user/assistant roles and
    # even canonical public fields.  Explicit DM/panel/draft markers must still
    # keep them out of every shared-feed read path.
    session.chat_history.extend(
        [
            _row(
                "dm-message",
                "一对一秘密",
                group_id="room-a",
                attachment_id="dm-attachment",
                is_dm=True,
            ),
            _row(
                "panel-message",
                "面板细节",
                group_id="room-a",
                attachment_id="panel-attachment",
                feed_visibility="panel",
            ),
            _row(
                "draft-message",
                "候选草稿",
                group_id="room-a",
                attachment_id="draft-attachment",
                is_draft=True,
            ),
            {
                "id": "unmarked-message",
                "role": "assistant",
                "content": "没有 Feed 标记的旧式行",
                "attachments": [{"id": "unmarked-attachment"}],
            },
            _row(
                "cross-group-message",
                "群 B 的消息",
                group_id="room-b",
                attachment_id="cross-attachment",
            ),
        ]
    )

    assert context.public_message_summaries(limit=50) == {
        public_id: "公开消息",
    }
    assert context.allowed_attachment_ids(limit=50) == ["public-attachment"]
    assert context.attachments_for_ids(
        ["public-attachment", "dm-attachment", "panel-attachment", "draft-attachment"]
    ) == [{"id": "public-attachment", "name": "公开.txt"}]
    assert context.sender_for_message("dm-message") == ""
    assert context.sender_for_message("panel-message") == ""
    assert context.sender_for_message("draft-message") == ""
    assert context.toggle_reaction(
        message_id="dm-message", actor_id="user", emoji="👍"
    ) == (False, [])
    assert context.toggle_reaction(
        message_id="panel-message", actor_id="user", emoji="👍"
    ) == (False, [])
    assert context.toggle_reaction(
        message_id="draft-message", actor_id="user", emoji="👍"
    ) == (False, [])
    assert [item.message_id for item in context.recent()] == [public_id]


def test_group_chat_rejects_cross_group_session_rebind() -> None:
    app = create_studio_app()
    client = TestClient(app)
    session_id = client.get("/api/session").json()["session_id"]
    first, second, _avatar = _group_pair(app)
    manager = app.state.session_manager
    managed = manager.get(session_id, touch=False)
    assert managed is not None
    managed.avatar_id = f"group:{first.id}"

    response = client.post(
        "/api/chat",
        json={
            "session_id": session_id,
            "group_id": second.id,
            "user_input": "不应静默切换群聊",
        },
    )

    assert response.status_code == 403
    assert managed.avatar_id == f"group:{first.id}"


def test_group_quote_requires_public_id_and_uses_server_canonical_text(monkeypatch) -> None:
    from agenticx.studio import server as server_module

    captured: list[dict[str, object]] = []

    class _CaptureGroupRouter:
        def __init__(self, **_kwargs: object) -> None:
            pass

        async def run_group_turn(self, **kwargs: object):
            captured.append(dict(kwargs))
            if False:  # pragma: no cover - keeps this an async generator
                yield None

    monkeypatch.setattr(server_module, "GroupChatRouter", _CaptureGroupRouter)
    app = create_studio_app()
    client = TestClient(app)
    session_id = client.get("/api/session").json()["session_id"]
    group, _other_group, _avatar = _group_pair(app)
    manager = app.state.session_manager
    managed = manager.get(session_id, touch=False)
    assert managed is not None
    managed.avatar_id = f"group:{group.id}"
    context = GroupChatContext(managed.studio_session, group_id=group.id)
    canonical_text = "服务端保存的公开原文" + "。" * 400
    public_id = context.append_agent(
        agent_id="member",
        agent_name="成员",
        text=canonical_text,
    )

    response = client.post(
        "/api/chat",
        json={
            "session_id": session_id,
            "group_id": group.id,
            "user_input": "请基于这条消息继续",
            "quoted_message_id": public_id,
            "quoted_content": "客户端伪造的私有内容",
        },
    )

    assert response.status_code == 200
    assert captured
    assert captured[-1]["quoted_message_id"] == public_id
    assert captured[-1]["quoted_content"] == canonical_text

    # A text-only quote has no message-id authorization boundary.
    text_only = client.post(
        "/api/chat",
        json={
            "session_id": session_id,
            "group_id": group.id,
            "user_input": "不要接受无 id 引用",
            "quoted_content": "伪造的面板/私聊内容",
        },
    )
    assert text_only.status_code == 400


def test_group_quote_rejects_private_and_cross_group_history(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from agenticx.studio import server as server_module

    captured: list[dict[str, object]] = []

    class _CaptureGroupRouter:
        def __init__(self, **_kwargs: object) -> None:
            pass

        async def run_group_turn(self, **kwargs: object):
            captured.append(dict(kwargs))
            if False:  # pragma: no cover - keeps this an async generator
                yield None

    monkeypatch.setattr(server_module, "GroupChatRouter", _CaptureGroupRouter)
    app = create_studio_app()
    client = TestClient(app)
    session_id = client.get("/api/session").json()["session_id"]
    group, other_group, _avatar = _group_pair(app)
    manager = app.state.session_manager
    managed = manager.get(session_id, touch=False)
    assert managed is not None
    managed.avatar_id = f"group:{group.id}"
    context = GroupChatContext(managed.studio_session, group_id=group.id)
    public_id = context.append_agent(
        agent_id="member",
        agent_name="成员",
        text="公开内容",
    )
    context._history().extend(
        [
            _row(
                "dm-message",
                "一对一秘密",
                group_id=group.id,
                attachment_id="dm",
                is_dm=True,
            ),
            _row(
                "panel-message",
                "面板秘密",
                group_id=group.id,
                attachment_id="panel",
                feed_visibility="panel",
            ),
            _row(
                "draft-message",
                "草稿秘密",
                group_id=group.id,
                attachment_id="draft",
                is_draft=True,
            ),
            _row(
                "cross-group-message",
                "另一群公开内容",
                group_id=other_group.id,
                attachment_id="cross",
            ),
        ]
    )

    for message_id in (
        "dm-message",
        "panel-message",
        "draft-message",
        "cross-group-message",
        "unknown-message",
    ):
        response = client.post(
            "/api/chat",
            json={
                "session_id": session_id,
                "group_id": group.id,
                "user_input": "引用测试",
                "quoted_message_id": message_id,
                "quoted_content": "客户端不可信内容",
            },
        )
        assert response.status_code == 404, response.text
        assert all(
            str(turn.get("status", "")).strip().lower() != "running"
            for turn in manager.list_turns(session_id)
        )
        assert not any(
            str(owner).startswith(f"{session_id}:")
            for owner in type(manager.turn_lifecycle)._workspace_locks.values()
        )

    valid = client.post(
        "/api/chat",
        json={
            "session_id": session_id,
            "group_id": group.id,
            "user_input": "引用测试",
            "quoted_message_id": public_id,
            "quoted_content": "客户端不可信内容",
        },
    )
    assert valid.status_code == 200, valid.text
    assert captured
    assert captured[-1]["group_id"] == group.id
    assert captured[-1]["quoted_message_id"] == public_id
    assert captured[-1]["quoted_content"] == "公开内容"


def test_group_quote_ids_are_canonicalized_individually(monkeypatch) -> None:
    from agenticx.studio import server as server_module

    captured: list[dict[str, object]] = []

    class _CaptureGroupRouter:
        def __init__(self, **_kwargs: object) -> None:
            pass

        async def run_group_turn(self, **kwargs: object):
            captured.append(dict(kwargs))
            if False:  # pragma: no cover - keeps this an async generator
                yield None

    monkeypatch.setattr(server_module, "GroupChatRouter", _CaptureGroupRouter)
    app = create_studio_app()
    client = TestClient(app)
    session_id = client.get("/api/session").json()["session_id"]
    group, _other_group, _avatar = _group_pair(app)
    manager = app.state.session_manager
    managed = manager.get(session_id, touch=False)
    assert managed is not None
    managed.avatar_id = f"group:{group.id}"
    context = GroupChatContext(managed.studio_session, group_id=group.id)
    first_text = "第一条服务端原文"
    second_text = "第二条服务端原文"
    first_id = context.append_agent(agent_id="member", agent_name="成员", text=first_text)
    second_id = context.append_agent(agent_id="member", agent_name="成员", text=second_text)

    response = client.post(
        "/api/chat",
        json={
            "session_id": session_id,
            "group_id": group.id,
            "user_input": "按这两条继续",
            "quote_message_ids": [first_id, second_id],
            "quoted_message_id": "attacker-id",
            "quoted_content": "客户端伪造的引用正文",
        },
    )

    assert response.status_code == 200
    assert captured
    assert captured[-1]["quoted_message_id"] == f"{first_id},{second_id}"
    assert captured[-1]["quoted_content"] == (
        f"{first_text}\n\n<<<agx-quote>>>\n\n{second_text}"
    )
    assert "客户端伪造的引用正文" not in str(captured[-1]["quoted_content"])


def test_same_group_session_reconnect_is_allowed(monkeypatch) -> None:
    from agenticx.studio import server as server_module

    class _NoopGroupRouter:
        def __init__(self, **_kwargs: object) -> None:
            pass

        async def run_group_turn(self, **_kwargs: object):
            if False:  # pragma: no cover - keeps this an async generator
                yield None

    monkeypatch.setattr(server_module, "GroupChatRouter", _NoopGroupRouter)
    app = create_studio_app()
    client = TestClient(app)
    session_id = client.get("/api/session").json()["session_id"]
    group, _other_group, _avatar = _group_pair(app)
    manager = app.state.session_manager
    managed = manager.get(session_id, touch=False)
    assert managed is not None

    payload = {
        "session_id": session_id,
        "group_id": group.id,
        "user_input": "首次连接",
    }
    first = client.post("/api/chat", json=payload)
    second = client.post(
        "/api/chat",
        json={**payload, "user_input": "同群重连"},
    )

    assert first.status_code == 200
    assert second.status_code == 200
    assert managed.avatar_id == f"group:{group.id}"
