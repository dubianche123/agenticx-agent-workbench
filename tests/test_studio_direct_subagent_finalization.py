"""Regression coverage for direct subagent turn finalization."""

from __future__ import annotations

import json
from typing import Any

from fastapi.testclient import TestClient

from agenticx.runtime.events import RuntimeEvent
from agenticx.studio.server import create_studio_app


class _DirectSubagentTeam:
    """Small event-emitting team adapter for the direct-chat branch."""

    def __init__(self) -> None:
        self.event_emitter = None
        self._agents: dict[str, Any] = {}

    async def send_message_to_subagent(self, agent_id: str, _message: str) -> dict[str, Any]:
        emitter = self.event_emitter
        if emitter is not None:
            await emitter(
                RuntimeEvent(
                    type="subagent_completed",
                    data={"text": "子智能体已完成"},
                    agent_id=agent_id,
                )
            )
        return {"ok": True}


def _events(lines: list[str]) -> list[dict[str, Any]]:
    values: list[dict[str, Any]] = []
    for line in lines:
        if not line.startswith("data: "):
            continue
        try:
            value = json.loads(line[6:])
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            values.append(value)
    return values


def _direct_chat(client: TestClient, session_id: str, agent_id: str) -> list[dict[str, Any]]:
    with client.stream(
        "POST",
        "/api/chat",
        json={
            "session_id": session_id,
            "agent_id": agent_id,
            "user_input": "继续执行",
            # Keep retries on the same desktop id: a failed checkpoint must
            # not make request-id dedupe swallow the next attempt.
            "client_turn_id": "direct-subagent-retry",
        },
    ) as response:
        lines = list(response.iter_lines())
        assert response.status_code == 200, lines
    return _events(lines)


def _make_direct_app(monkeypatch: Any):
    from agenticx.studio import server as server_module

    monkeypatch.setattr(server_module, "live_reattach_enabled", lambda: False)
    app = create_studio_app()
    client = TestClient(app)
    session_id = client.get("/api/session").json()["session_id"]
    managed = app.state.session_manager.get(session_id, touch=False)
    assert managed is not None
    managed.team_manager = _DirectSubagentTeam()
    return app, client, session_id


def _assert_finalization_error(events: list[dict[str, Any]], detail: str) -> None:
    error_index = next(
        index
        for index, item in enumerate(events)
        if item.get("type") == "error"
        and (item.get("data") or {}).get("code") == "turn_finalization_failed"
    )
    error = events[error_index]
    data = error.get("data") or {}
    assert data.get("checkpoint_available") is False
    assert detail in str(data.get("text") or "")
    done_index = next(index for index, item in enumerate(events) if item.get("type") == "done")
    assert error_index < done_index


def test_direct_subagent_persist_failure_releases_turn_and_allows_next_chat(
    monkeypatch: Any,
) -> None:
    app, client, session_id = _make_direct_app(monkeypatch)
    manager = app.state.session_manager
    original_persist_async = manager.persist_async
    calls = {"count": 0}

    async def _fail_once(sid: str) -> bool:
        calls["count"] += 1
        if calls["count"] == 1:
            raise RuntimeError("direct persist failure")
        return await original_persist_async(sid)

    monkeypatch.setattr(manager, "persist_async", _fail_once)

    first = _direct_chat(client, session_id, "subagent-direct")
    _assert_finalization_error(first, "direct persist failure")
    assert manager.get(session_id, touch=False).execution_state != "running"

    second = _direct_chat(client, session_id, "subagent-direct")
    assert any(item.get("type") == "done" for item in second)
    assert not any(
        (item.get("data") or {}).get("code") == "turn_finalization_failed"
        for item in second
    )


def test_direct_subagent_finalize_failure_releases_turn_and_allows_next_chat(
    monkeypatch: Any,
) -> None:
    app, client, session_id = _make_direct_app(monkeypatch)
    manager = app.state.session_manager
    original_finalize = manager.turn_lifecycle.finalize
    calls = {"count": 0}

    def _fail_once(*args: Any, **kwargs: Any):
        calls["count"] += 1
        if calls["count"] == 1:
            raise RuntimeError("direct finalize failure")
        return original_finalize(*args, **kwargs)

    monkeypatch.setattr(manager.turn_lifecycle, "finalize", _fail_once)

    first = _direct_chat(client, session_id, "subagent-direct")
    _assert_finalization_error(first, "direct finalize failure")
    assert manager.get(session_id, touch=False).execution_state != "running"

    second = _direct_chat(client, session_id, "subagent-direct")
    assert any(item.get("type") == "done" for item in second)
    assert not any(
        (item.get("data") or {}).get("code") == "turn_finalization_failed"
        for item in second
    )
