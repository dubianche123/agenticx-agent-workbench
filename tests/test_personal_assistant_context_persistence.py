"""Durable private fencing for enterprise enriched personal-assistant sessions."""

from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace

import pytest

from agenticx.cli.studio import StudioSession
from agenticx.runtime.compactor import ContextCompactor
from agenticx.studio.enterprise_actions import (
    ENTERPRISE_ACTION_TOOL,
    enterprise_authorization_preflight,
)
from agenticx.studio.session_manager import SessionManager


class _SummaryModel:
    def invoke(self, *_args, **_kwargs):
        return SimpleNamespace(content="企业信息摘要：旧角色下的只读查询结果。")


class _VersionedBroker:
    def __init__(self, version: str, generation: int = 0) -> None:
        self.version = version
        self.generation = generation

    async def preflight(self, _session_id: str, _permission_mode: str):
        return {
            "ok": True,
            "authorizationVersion": self.version,
            "authGeneration": self.generation,
        }


def _managed_personal_session(monkeypatch: pytest.MonkeyPatch, tmp_path):
    monkeypatch.setenv("AGX_HOME", str(tmp_path / "agx-home"))
    monkeypatch.setenv("AGX_SESSION_FTS", "0")
    manager = SessionManager()
    managed = manager.create(
        session_id="personal-persisted",
        purpose="environment-assistant",
    )
    session = managed.studio_session
    session._session_id = managed.session_id
    session._session_purpose = "environment-assistant"
    return manager, managed, session


def _preflight(session: StudioSession, version: str):
    # SessionManager restores server-owned metadata; the HTTP boundary binds
    # these runtime-only routing fields immediately before preflight.
    session._session_id = getattr(session, "_session_id", "") or "personal-persisted"
    session._session_purpose = "environment-assistant"
    session._enterprise_action_broker_client = _VersionedBroker(version)
    return asyncio.run(enterprise_authorization_preflight(session))


def test_private_marker_survives_managed_save_load_and_restart(monkeypatch, tmp_path):
    manager, managed, session = _managed_personal_session(monkeypatch, tmp_path)
    session.chat_history = [
        {"role": "user", "content": "查一下我的额度"},
        {"role": "assistant", "content": "已记录查询结果"},
    ]
    # The model context has already been compacted; there is no enterprise
    # tool row left from which to rediscover the old authorization version.
    session.agent_messages = [
        {"role": "system", "content": "[compacted] 企业额度摘要"},
    ]
    session._enterprise_assistant_context = {
        "enterpriseContext": True,
        "authorizationVersion": "role-before",
        "authGeneration": 17,
        "processEpoch": "old-process",
    }

    assert manager.incremental_persist(managed.session_id) is True
    assert manager.persist(managed.session_id) is True

    marker_path = tmp_path / "agx-home" / "sessions" / managed.session_id / "enterprise_context.json"
    assert json.loads(marker_path.read_text(encoding="utf-8")) == {
        "enterpriseContext": True,
        "authorizationVersion": "role-before",
    }
    assert "_enterprise_assistant_context" not in session.scratchpad

    restored_manager = SessionManager()
    restored = restored_manager.create(session_id=managed.session_id)
    restored_session = restored.studio_session
    marker = restored_session._enterprise_assistant_context
    assert marker["authorizationVersion"] == "role-before"
    assert marker["restored"] is True
    assert "authGeneration" not in marker
    assert "processEpoch" not in marker

    same_role = _preflight(restored_session, "role-before")
    assert same_role["ok"] is True
    assert same_role["stale"] is False

    # A later role change fences the restored transcript before model admission.
    changed_role = _preflight(restored_session, "role-after")
    assert changed_role["ok"] is False
    assert changed_role["stale"] is True


def test_unknown_persisted_enterprise_version_is_stale(monkeypatch, tmp_path):
    manager, managed, session = _managed_personal_session(monkeypatch, tmp_path)
    session.chat_history = [{"role": "user", "content": "继续"}]
    session.agent_messages = [{"role": "system", "content": "[compacted] 企业信息摘要"}]
    session._enterprise_assistant_context = {"enterpriseContext": True}

    assert manager.persist(managed.session_id) is True
    restored = SessionManager().create(session_id=managed.session_id)
    decision = _preflight(restored.studio_session, "current-role")
    assert decision["ok"] is False
    assert decision["stale"] is True
    assert decision["code"] == "ENTERPRISE_CONTEXT_STALE"


def test_compaction_and_runtime_clone_keep_private_fence(monkeypatch, tmp_path):
    manager, managed, session = _managed_personal_session(monkeypatch, tmp_path)
    session._enterprise_assistant_context = {
        "enterpriseContext": True,
        "authorizationVersion": "role-before",
        "authGeneration": 3,
    }
    history = [
        {
            "role": "tool",
            "name": ENTERPRISE_ACTION_TOOL,
            "content": json.dumps(
                {
                    "status": "ok",
                    "authorizationVersion": "role-before",
                    "result": {"quota": "synthetic"},
                }
            ),
        }
    ]
    for index in range(6):
        history.extend(
            [
                {"role": "user", "content": f"问题 {index}"},
                {"role": "assistant", "content": f"回答 {index}"},
            ]
        )
    session.agent_messages = history

    compacted, did_compact, _summary, compacted_count, _pending = asyncio.run(
        ContextCompactor(
            _SummaryModel(),
            threshold_messages=8,
            threshold_chars=4_000,
            retain_recent_messages=4,
        ).maybe_compact(
            history,
            force=True,
            model="test-model",
            session=session,
        )
    )
    assert did_compact is True
    assert compacted_count > 0
    assert not any(
        row.get("name") == ENTERPRISE_ACTION_TOOL
        for row in compacted
        if isinstance(row, dict)
    )
    session.agent_messages = compacted
    assert manager.incremental_persist(managed.session_id) is True
    # The UI transcript keeps only its visible conversation after model
    # compaction; the private sidecar is what carries the enterprise fence.
    session.chat_history = [
        {"role": "user", "content": "问题 0"},
        {"role": "assistant", "content": "回答 0"},
    ]
    assert manager.persist(managed.session_id) is True

    forked = manager.fork_session(managed.session_id)
    assert forked is not None
    assert forked.purpose == "environment-assistant"
    assert forked.studio_session._enterprise_assistant_context["authorizationVersion"] == "role-before"

    restored = SessionManager().create(session_id=managed.session_id)
    decision = _preflight(restored.studio_session, "role-after")
    assert decision["ok"] is False
    assert decision["stale"] is True
