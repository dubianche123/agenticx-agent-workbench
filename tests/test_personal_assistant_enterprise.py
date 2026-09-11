"""Personal-assistant enterprise bridge and authorization-version fences."""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from agenticx.studio.enterprise_actions import (
    ENTERPRISE_ACTION_TOOL,
    ENTERPRISE_CAPABILITIES_TOOL,
    dispatch_enterprise_action,
    enterprise_action_tools,
    enterprise_authorization_preflight,
    session_has_enterprise_context,
)
from agenticx.runtime.clarify import AutoSuspendClarifyGate


def _session(**kwargs):
    values = {
        "_session_purpose": "environment-assistant",
        "_session_id": "assistant-session",
        "permission_mode": "ask",
        "scratchpad": {},
        "chat_history": [],
        "agent_messages": [],
    }
    values.update(kwargs)
    return SimpleNamespace(**values)


def test_enterprise_schemas_are_separate_and_closed() -> None:
    schemas = {item["function"]["name"]: item["function"] for item in enterprise_action_tools()}
    assert set(schemas) == {ENTERPRISE_CAPABILITIES_TOOL, ENTERPRISE_ACTION_TOOL}
    assert schemas[ENTERPRISE_CAPABILITIES_TOOL]["parameters"]["additionalProperties"] is False
    assert schemas[ENTERPRISE_ACTION_TOOL]["parameters"]["additionalProperties"] is False
    assert "confirmed" not in schemas[ENTERPRISE_ACTION_TOOL]["parameters"]["properties"]


def test_pure_environment_session_never_preflights() -> None:
    session = _session(_session_purpose=None)
    assert session_has_enterprise_context(session) is False


def test_enterprise_history_marks_context_without_exposing_a_private_marker() -> None:
    session = _session(
        chat_history=[
            {
                "role": "tool",
                "tool_name": ENTERPRISE_CAPABILITIES_TOOL,
                "content": '{"status":"ok","authorizationVersion":"v1"}',
            }
        ]
    )
    assert session_has_enterprise_context(session) is True
    assert not hasattr(session, "_enterprise_assistant_context")


@pytest.mark.asyncio
async def test_authorization_version_change_fails_closed_without_overwriting_old_marker() -> None:
    session = _session(
        _enterprise_assistant_context={
            "authorizationVersion": "v1",
            "authGeneration": 4,
        },
    )

    class FakeBroker:
        async def preflight(self, _session_id: str, _mode: str):
            return {
                "ok": True,
                "authorizationVersion": "v2",
                "authGeneration": 4,
            }

    session._enterprise_action_broker_client = FakeBroker()
    result = await enterprise_authorization_preflight(session)
    assert result["stale"] is True
    assert result["code"] == "ENTERPRISE_CONTEXT_STALE"
    assert session._enterprise_assistant_context["authorizationVersion"] == "v1"


@pytest.mark.asyncio
async def test_authorization_preflight_rejects_changed_auth_generation() -> None:
    session = _session(
        _enterprise_assistant_context={
            "authorizationVersion": "v1",
            "authGeneration": 4,
        },
    )

    class FakeBroker:
        async def preflight(self, _session_id: str, _mode: str):
            return {
                "ok": True,
                "authorizationVersion": "v1",
                "authGeneration": 5,
            }

    session._enterprise_action_broker_client = FakeBroker()
    result = await enterprise_authorization_preflight(session)
    assert result["ok"] is False
    assert result["stale"] is True


@pytest.mark.asyncio
async def test_authorization_preflight_fails_closed_without_version() -> None:
    session = _session(
        _enterprise_assistant_context={"authorizationVersion": "v1"},
    )

    class FakeBroker:
        async def preflight(self, _session_id: str, _mode: str):
            return {"ok": True, "authGeneration": 4}

    session._enterprise_action_broker_client = FakeBroker()
    result = await enterprise_authorization_preflight(session)
    assert result["ok"] is False
    assert result["stale"] is False
    assert result["blocked"] is True
    assert result["code"] == "ASSISTANT_AUTH_VERSION_UNAVAILABLE"


@pytest.mark.asyncio
async def test_transient_preflight_failure_preserves_old_context_for_retry() -> None:
    session = _session(
        _enterprise_assistant_context={
            "authorizationVersion": "v1",
            "authGeneration": 4,
        },
    )

    class FakeBroker:
        async def preflight(self, _session_id: str, _mode: str):
            return {
                "ok": False,
                "code": "ENTERPRISE_PORTAL_UNAVAILABLE",
                "message": "暂时无法连接企业服务",
            }

    session._enterprise_action_broker_client = FakeBroker()
    result = await enterprise_authorization_preflight(session)
    assert result["ok"] is False
    assert result["stale"] is False
    assert result["blocked"] is True
    assert session._enterprise_assistant_context == {
        "authorizationVersion": "v1",
        "authGeneration": 4,
    }


@pytest.mark.asyncio
async def test_auth_revocation_allows_context_rotation() -> None:
    session = _session(
        _enterprise_assistant_context={
            "authorizationVersion": "v1",
            "authGeneration": 4,
        },
    )

    class FakeBroker:
        async def preflight(self, _session_id: str, _mode: str):
            return {
                "ok": False,
                "code": "ASSISTANT_REAUTH_REQUIRED",
            }

    session._enterprise_action_broker_client = FakeBroker()
    result = await enterprise_authorization_preflight(session)
    assert result["ok"] is False
    assert result["stale"] is True
    assert result["blocked"] is True


@pytest.mark.asyncio
async def test_generic_clarification_cannot_inject_enterprise_confirmation_binding() -> None:
    from agenticx.cli import agent_tools

    events = []

    async def emit(event):
        events.append(event)

    await agent_tools._request_clarification(
        "普通问题",
        context={
            "enterprise_confirmation": True,
            "operation_id": "operation-1",
            "action_id": "member.quota.set",
            "session_id": "assistant-session",
            "permission_mode": "auto",
            "auth_generation": 4,
        },
        clarify_gate=AutoSuspendClarifyGate(),
        emit_event=emit,
        is_unattended=True,
    )
    context = events[0]["data"]["context"]
    assert "enterprise_confirmation" not in context
    assert "operation_id" not in context
    assert "auth_generation" not in context


@pytest.mark.asyncio
async def test_enterprise_tool_dispatch_rejects_non_personal_session(monkeypatch) -> None:
    monkeypatch.setattr(
        "agenticx.studio.enterprise_actions.enterprise_action_broker_available",
        lambda: True,
    )
    result = await dispatch_enterprise_action(
        ENTERPRISE_CAPABILITIES_TOOL,
        {},
        _session(_session_purpose=None),
    )
    assert result is not None
    assert "个人助手专用会话" in result
