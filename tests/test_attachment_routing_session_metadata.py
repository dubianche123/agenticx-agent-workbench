#!/usr/bin/env python3
"""Session API exposure for the sticky private attachment route."""

from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from agenticx.memory.session_store import SessionStore
from agenticx.studio.attachment_routing import RoutingModelRef, remember_lock
from agenticx.studio.server import create_studio_app
from agenticx.studio.session_manager import SessionManager


PRIVATE_TARGET = RoutingModelRef(
    id="private-route/private-model",
    provider="private-route",
    model="private-model",
    label="企业私有模型",
)


def test_session_detail_and_list_return_only_safe_attachment_lock_fields() -> None:
    app = create_studio_app()
    client = TestClient(app)
    session_id = client.get("/api/session").json()["session_id"]
    manager = app.state.session_manager
    managed = manager.get(session_id, touch=False)
    assert managed is not None
    managed.studio_session.chat_history = [{"role": "user", "content": "已锁定"}]
    remember_lock(managed.studio_session, PRIVATE_TARGET)
    assert manager.persist(session_id) is True

    detail = client.get("/api/session", params={"session_id": session_id})
    assert detail.status_code == 200
    assert detail.json()["attachment_routing_lock"] == {
        "id": PRIVATE_TARGET.id,
        "provider": PRIVATE_TARGET.provider,
        "model": PRIVATE_TARGET.model,
        "label": PRIVATE_TARGET.label,
    }

    listed = client.get("/api/sessions")
    assert listed.status_code == 200
    row = next(item for item in listed.json()["sessions"] if item["session_id"] == session_id)
    assert row["attachment_routing_lock"] == detail.json()["attachment_routing_lock"]
    assert "api_key" not in row["attachment_routing_lock"]


def test_invalid_persisted_attachment_lock_is_hidden_from_session_api() -> None:
    app = create_studio_app()
    client = TestClient(app)
    session_id = client.get("/api/session").json()["session_id"]
    manager = app.state.session_manager
    managed = manager.get(session_id, touch=False)
    assert managed is not None
    managed.studio_session.chat_history = [{"role": "user", "content": "corrupt"}]
    managed.studio_session.__dict__["_attachment_routing_lock"] = {
        "provider": "",
        "model": "private-model",
        "api_key": "must-not-leak",
    }
    assert manager.persist(session_id) is True

    detail = client.get("/api/session", params={"session_id": session_id})
    assert detail.status_code == 200
    assert detail.json()["attachment_routing_lock"] is None

    listed = client.get("/api/sessions")
    row = next(item for item in listed.json()["sessions"] if item["session_id"] == session_id)
    assert row["attachment_routing_lock"] is None


def test_persisted_session_list_rehydrates_the_safe_lock_marker(tmp_path: Path) -> None:
    store = SessionStore(tmp_path / "sessions.sqlite")
    sessions_root = tmp_path / "sessions"
    manager = SessionManager()
    manager._session_store = store
    manager._sessions_root = str(sessions_root)
    managed = manager.create(session_id="persisted-lock")
    managed.studio_session.chat_history = [{"role": "user", "content": "persist"}]
    remember_lock(managed.studio_session, PRIVATE_TARGET)
    assert manager.persist(managed.session_id) is True

    fresh = SessionManager()
    fresh._session_store = store
    fresh._sessions_root = str(sessions_root)
    row = next(item for item in fresh.list_sessions() if item["session_id"] == managed.session_id)
    assert row["attachment_routing_lock"] == {
        "id": PRIVATE_TARGET.id,
        "provider": PRIVATE_TARGET.provider,
        "model": PRIVATE_TARGET.model,
        "label": PRIVATE_TARGET.label,
    }
