"""Regression coverage for failure-aware Studio turn finalization."""

from __future__ import annotations

import json
from typing import Any

from fastapi.testclient import TestClient

from agenticx.runtime.events import RuntimeEvent
from agenticx.studio.server import create_studio_app


class _FakeLLM:
    def invoke(self, *_args: Any, **_kwargs: Any):
        return type("Response", (), {"content": "标题", "tool_calls": []})()


class _FinalRuntime:
    def __init__(self, *_args: Any, **_kwargs: Any) -> None:
        pass

    async def run_turn(self, *_args: Any, **_kwargs: Any):
        yield RuntimeEvent(type="final", data={"text": "本轮完成"}, agent_id="meta")


def _events(lines: list[str]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for line in lines:
        if not line.startswith("data: "):
            continue
        try:
            value = json.loads(line[6:])
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            result.append(value)
    return result


def _stream_chat(client: TestClient, session_id: str, text: str) -> list[dict[str, Any]]:
    with client.stream(
        "POST",
        "/api/chat",
        json={"session_id": session_id, "user_input": text},
    ) as response:
        lines = list(response.iter_lines())
        assert response.status_code == 200, lines
    return _events(lines)


def _assert_finalization_error(events: list[dict[str, Any]], detail: str) -> None:
    error = next(item for item in events if item.get("type") == "error")
    data = error.get("data") or {}
    assert data.get("code") == "turn_finalization_failed"
    assert data.get("checkpoint_available") is False
    assert detail in str(data.get("text") or "")
    assert any(item.get("type") == "done" for item in events)


def _assert_failed_checkpoint(manager: Any, session_id: str, detail: str) -> str:
    rows = manager.list_turns(session_id)
    assert rows
    failed_turn_id = rows[0]["turn_id"]
    assert rows[0]["status"] == "failed"
    assert rows[0]["can_undo"] is False
    manifest = manager.turn_lifecycle._read_manifest(session_id, failed_turn_id)
    assert manifest is not None
    assert manifest["status"] == "failed"
    assert manifest["checkpoint_complete"] is False
    assert detail in str(manifest.get("reason") or "")
    return failed_turn_id


def _make_app(monkeypatch: Any):
    from agenticx.studio import server as server_module

    monkeypatch.setattr(server_module, "live_reattach_enabled", lambda: False)
    monkeypatch.setattr(server_module.ProviderResolver, "resolve", lambda **_kwargs: _FakeLLM())
    monkeypatch.setattr(server_module, "AgentRuntime", _FinalRuntime)
    app = create_studio_app()
    return app, TestClient(app)


def test_chat_persist_failure_emits_error_marks_checkpoint_unavailable_and_allows_next_turn(
    monkeypatch: Any,
) -> None:
    app, client = _make_app(monkeypatch)
    session_id = client.get("/api/session").json()["session_id"]
    manager = app.state.session_manager
    original_persist_async = manager.persist_async
    calls = {"count": 0}

    async def _fail_once(sid: str) -> bool:
        calls["count"] += 1
        if calls["count"] == 1:
            raise RuntimeError("injected persist failure")
        return await original_persist_async(sid)

    monkeypatch.setattr(manager, "persist_async", _fail_once)
    first_events = _stream_chat(client, session_id, "触发持久化失败")

    _assert_finalization_error(first_events, "injected persist failure")
    _assert_failed_checkpoint(manager, session_id, "injected persist failure")
    assert manager.get(session_id, touch=False).execution_state == "failed"

    second_events = _stream_chat(client, session_id, "失败后继续")
    assert any(item.get("type") == "final" for item in second_events)
    assert any(item.get("type") == "done" for item in second_events)
    assert manager.list_turns(session_id)[0]["status"] == "completed"


def test_chat_finalize_failure_emits_error_marks_checkpoint_unavailable_and_allows_next_turn(
    monkeypatch: Any,
) -> None:
    app, client = _make_app(monkeypatch)
    session_id = client.get("/api/session").json()["session_id"]
    manager = app.state.session_manager
    original_finalize = manager.turn_lifecycle.finalize
    calls = {"count": 0}

    def _fail_once(*args: Any, **kwargs: Any):
        calls["count"] += 1
        if calls["count"] == 1:
            raise RuntimeError("injected finalize failure")
        return original_finalize(*args, **kwargs)

    monkeypatch.setattr(manager.turn_lifecycle, "finalize", _fail_once)
    first_events = _stream_chat(client, session_id, "触发 finalize 失败")

    _assert_finalization_error(first_events, "injected finalize failure")
    _assert_failed_checkpoint(manager, session_id, "injected finalize failure")
    assert manager.get(session_id, touch=False).execution_state == "failed"

    second_events = _stream_chat(client, session_id, "失败后继续")
    assert any(item.get("type") == "final" for item in second_events)
    assert any(item.get("type") == "done" for item in second_events)
    assert manager.list_turns(session_id)[0]["status"] == "completed"
