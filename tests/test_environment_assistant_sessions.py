"""Dedicated Desktop environment assistant session boundaries."""

from __future__ import annotations

import json
from types import SimpleNamespace
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from agenticx.memory import session_store as session_store_module
from agenticx.cli.config_manager import ConfigManager
from agenticx.runtime.agent_runtime import AgentRuntime
from agenticx.runtime.hooks.memory_hook import MemoryHook
from agenticx.studio.environment_assistant import ENVIRONMENT_ASSISTANT_PURPOSE
from agenticx.studio.server import create_studio_app
from agenticx.studio.session_manager import SessionManager


def _manager(tmp_path: Path, monkeypatch) -> tuple[SessionManager, object, Path]:
    db_path = tmp_path / "sessions.sqlite"
    sessions_root = tmp_path / "sessions"
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setattr(session_store_module, "DEFAULT_SESSION_DB_PATH", db_path)
    manager = SessionManager()
    manager._sessions_root = str(sessions_root)
    return manager, manager._session_store, sessions_root


def test_purpose_persists_and_is_excluded_from_ordinary_history(
    tmp_path: Path,
    monkeypatch,
) -> None:
    manager, store, sessions_root = _manager(tmp_path, monkeypatch)
    dedicated = manager.create(
        session_id="environment-assistant-a",
        purpose=ENVIRONMENT_ASSISTANT_PURPOSE,
        purpose_scope="scope-a",
    )
    dedicated.studio_session.chat_history = [{"role": "user", "content": "诊断"}]
    assert manager.persist(dedicated.session_id) is True

    assert dedicated.session_id not in {
        row["session_id"] for row in manager.list_sessions()
    }
    listed = manager.list_sessions(
        purpose=ENVIRONMENT_ASSISTANT_PURPOSE,
        purpose_scope="scope-a",
    )
    assert [row["session_id"] for row in listed] == [dedicated.session_id]

    fresh = SessionManager()
    fresh._session_store = store
    fresh._sessions_root = str(sessions_root)
    assert fresh.find_purpose_session_id(
        ENVIRONMENT_ASSISTANT_PURPOSE,
        purpose_scope="scope-a",
    ) == dedicated.session_id
    assert dedicated.session_id not in {
        row["session_id"] for row in fresh.list_sessions()
    }


def test_purpose_lookup_and_explicit_listing_are_scope_isolated(
    tmp_path: Path,
    monkeypatch,
) -> None:
    manager, _store, _sessions_root = _manager(tmp_path, monkeypatch)
    for sid, scope in (("environment-a", "scope-a"), ("environment-b", "scope-b")):
        session = manager.create(
            session_id=sid,
            purpose=ENVIRONMENT_ASSISTANT_PURPOSE,
            purpose_scope=scope,
        )
        session.studio_session.chat_history = [{"role": "user", "content": sid}]
        assert manager.persist(sid) is True

    assert manager.find_purpose_session_id(
        ENVIRONMENT_ASSISTANT_PURPOSE,
        purpose_scope="scope-a",
    ) == "environment-a"
    assert manager.find_purpose_session_id(
        ENVIRONMENT_ASSISTANT_PURPOSE,
        purpose_scope="scope-b",
    ) == "environment-b"
    assert manager.list_sessions(
        purpose=ENVIRONMENT_ASSISTANT_PURPOSE,
        purpose_scope="scope-a",
    )[0]["session_id"] == "environment-a"


def test_environment_session_binds_selected_workspace_taskspace(
    tmp_path: Path,
    monkeypatch,
) -> None:
    selected_workspace = tmp_path / "selected-project"
    monkeypatch.setattr(
        "agenticx.workspace.loader.resolve_workspace_dir",
        lambda **_kwargs: selected_workspace,
    )
    manager, _store, _sessions_root = _manager(tmp_path, monkeypatch)
    managed = manager.create(
        session_id="environment-workspace",
        purpose=ENVIRONMENT_ASSISTANT_PURPOSE,
        purpose_scope="scope-a",
    )
    assert Path(managed.studio_session.workspace_dir) == selected_workspace.resolve()
    default = next(item for item in managed.taskspaces if item["id"] == "default")
    assert Path(default["path"]) == selected_workspace.resolve()

    # The same persisted session follows the selected workspace on materialize,
    # while ordinary Meta sessions retain their per-session scratch root.
    other_workspace = tmp_path / "selected-project-2"
    monkeypatch.setattr(
        "agenticx.workspace.loader.resolve_workspace_dir",
        lambda **_kwargs: other_workspace,
    )
    assert manager.persist(managed.session_id) is True
    fresh = SessionManager()
    fresh._session_store = manager._session_store
    fresh._sessions_root = manager._sessions_root
    restored = fresh.get(managed.session_id)
    assert restored is not None
    assert Path(restored.studio_session.workspace_dir) == other_workspace.resolve()
    assert Path(next(item for item in restored.taskspaces if item["id"] == "default")["path"]) == other_workspace.resolve()


def test_environment_session_prefers_live_config_over_stale_process_workspace_override(
    tmp_path: Path,
    monkeypatch,
) -> None:
    """A running backend follows saved config after its startup env goes stale."""

    selected_workspace = tmp_path / "selected-project"
    ontology_home = tmp_path / ".agenticx-ontology"
    ontology_home.mkdir(parents=True)
    (ontology_home / "config.yaml").write_text(
        json.dumps({"workspace_dir": str(selected_workspace)}),
        encoding="utf-8",
    )
    monkeypatch.setenv("AGX_HOME", str(ontology_home))
    monkeypatch.setenv("AGX_WORKSPACE_ROOT", str(tmp_path / "stale-startup-root"))
    manager, _store, _sessions_root = _manager(tmp_path, monkeypatch)
    managed = manager.create(
        session_id="environment-process-workspace",
        purpose=ENVIRONMENT_ASSISTANT_PURPOSE,
        purpose_scope="scope-a",
    )

    assert Path(managed.studio_session.workspace_dir) == selected_workspace.resolve()
    default = next(item for item in managed.taskspaces if item["id"] == "default")
    assert Path(default["path"]) == selected_workspace.resolve()


def test_existing_environment_session_persists_live_workspace_on_reopen(
    tmp_path: Path,
    monkeypatch,
) -> None:
    """Reopening a persisted panel updates its marker before the next restart."""

    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("AGX_DESKTOP_TOKEN", "desktop-test-token")
    monkeypatch.setattr(
        session_store_module,
        "DEFAULT_SESSION_DB_PATH",
        tmp_path / "sessions.sqlite",
    )
    selected_one = tmp_path / "selected-one"
    selected_two = tmp_path / "selected-two"
    monkeypatch.setattr(
        "agenticx.workspace.loader.resolve_workspace_dir",
        lambda **_kwargs: selected_one,
    )
    app = create_studio_app()
    client = TestClient(app)
    headers = {
        "x-agx-desktop-token": "desktop-test-token",
        "x-agx-session-scope": "scope-a",
    }
    created = client.get(
        "/api/session",
        params={"purpose": ENVIRONMENT_ASSISTANT_PURPOSE},
        headers=headers,
    )
    assert created.status_code == 200
    session_id = created.json()["session_id"]

    monkeypatch.setattr(
        "agenticx.workspace.loader.resolve_workspace_dir",
        lambda **_kwargs: selected_two,
    )
    reopened = client.get(
        "/api/session",
        params={
            "session_id": session_id,
            "purpose": ENVIRONMENT_ASSISTANT_PURPOSE,
        },
        headers=headers,
    )
    assert reopened.status_code == 200

    metadata = app.state.session_manager._session_store._load_latest_session_metadata_sync(
        session_id
    )
    default = next(item for item in metadata["taskspaces"] if item["id"] == "default")
    assert default["path"] == str(selected_two.resolve())


def test_purpose_only_request_cannot_read_another_scope(
    tmp_path: Path,
    monkeypatch,
) -> None:
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("AGX_DESKTOP_TOKEN", "desktop-test-token")
    monkeypatch.setattr(
        session_store_module,
        "DEFAULT_SESSION_DB_PATH",
        tmp_path / "sessions.sqlite",
    )
    app = create_studio_app()
    client = TestClient(app)
    base_headers = {
        "x-agx-desktop-token": "desktop-test-token",
        "x-agx-session-purpose": ENVIRONMENT_ASSISTANT_PURPOSE,
    }
    created = client.get(
        "/api/session",
        params={"purpose": ENVIRONMENT_ASSISTANT_PURPOSE},
        headers={**base_headers, "x-agx-session-scope": "scope-a"},
    )
    assert created.status_code == 200
    session_id = created.json()["session_id"]

    messages = client.get(
        "/api/session/messages",
        params={"session_id": session_id},
        headers={**base_headers, "x-agx-session-scope": "scope-b"},
    )
    assert messages.status_code == 403

    purpose_only = client.get(
        "/api/session/messages",
        params={"session_id": session_id},
        headers=base_headers,
    )
    assert purpose_only.status_code == 403

    invalid_scope = client.get(
        "/api/session/messages",
        params={"session_id": session_id},
        headers={**base_headers, "x-agx-session-scope": "scope with spaces"},
    )
    assert invalid_scope.status_code == 403

    ordinary = client.get(
        "/api/session/messages",
        params={"session_id": session_id},
        headers={"x-agx-desktop-token": "desktop-test-token"},
    )
    assert ordinary.status_code == 403


def test_environment_permission_mode_is_independent_and_persistent(
    tmp_path: Path,
    monkeypatch,
) -> None:
    """The private picker starts in ask and never mutates ordinary defaults."""

    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("AGX_DESKTOP_TOKEN", "desktop-test-token")
    monkeypatch.setattr(
        session_store_module,
        "DEFAULT_SESSION_DB_PATH",
        tmp_path / "sessions.sqlite",
    )
    monkeypatch.setattr(ConfigManager, "GLOBAL_CONFIG_PATH", tmp_path / "config.yaml")
    monkeypatch.setattr(ConfigManager, "PROJECT_CONFIG_PATH", tmp_path / "project.yaml")
    ConfigManager.set_value("permissions.mode", "plan")
    app = create_studio_app()
    client = TestClient(app)
    token_headers = {"x-agx-desktop-token": "desktop-test-token"}
    private_headers = {
        **token_headers,
        "x-agx-session-purpose": ENVIRONMENT_ASSISTANT_PURPOSE,
        "x-agx-session-scope": "scope-a",
    }

    ordinary = client.get("/api/session", headers=token_headers)
    assert ordinary.status_code == 200
    assert ordinary.json()["permission_mode"] == "plan"

    dedicated = client.get(
        "/api/session",
        params={"purpose": ENVIRONMENT_ASSISTANT_PURPOSE},
        headers=private_headers,
    )
    assert dedicated.status_code == 200
    session_id = dedicated.json()["session_id"]
    assert dedicated.json()["permission_mode"] == "ask"

    current = client.get(
        f"/api/sessions/{session_id}/permissions", headers=private_headers
    )
    assert current.status_code == 200
    assert current.json()["mode"] == "ask"
    assert current.json()["global_default"] == "plan"

    changed = client.put(
        f"/api/sessions/{session_id}/permissions",
        headers=private_headers,
        json={"mode": "auto"},
    )
    assert changed.status_code == 200, changed.text
    assert changed.json()["mode"] == "auto"
    assert client.get(
        f"/api/sessions/{session_id}/permissions", headers=private_headers
    ).json()["mode"] == "auto"
    assert client.get("/api/permissions", headers=token_headers).json()["mode"] == "plan"


def test_environment_permission_mode_persist_failure_rolls_back_and_returns_error(
    tmp_path: Path,
    monkeypatch,
) -> None:
    """A failed session snapshot cannot be reported as a successful write."""

    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("AGX_DESKTOP_TOKEN", "desktop-test-token")
    monkeypatch.setattr(
        session_store_module,
        "DEFAULT_SESSION_DB_PATH",
        tmp_path / "sessions.sqlite",
    )
    monkeypatch.setattr(ConfigManager, "GLOBAL_CONFIG_PATH", tmp_path / "config.yaml")
    monkeypatch.setattr(ConfigManager, "PROJECT_CONFIG_PATH", tmp_path / "project.yaml")
    ConfigManager.set_value("permissions.mode", "plan")
    app = create_studio_app()
    client = TestClient(app)
    token_headers = {"x-agx-desktop-token": "desktop-test-token"}
    private_headers = {
        **token_headers,
        "x-agx-session-purpose": ENVIRONMENT_ASSISTANT_PURPOSE,
        "x-agx-session-scope": "scope-a",
    }
    created = client.get(
        "/api/session",
        params={"purpose": ENVIRONMENT_ASSISTANT_PURPOSE},
        headers=private_headers,
    )
    assert created.status_code == 200
    session_id = created.json()["session_id"]
    endpoint = f"/api/sessions/{session_id}/permissions"
    manager = app.state.session_manager
    managed = manager.get(session_id, touch=False)
    assert managed is not None
    assert managed.studio_session.permission_mode == "ask"

    monkeypatch.setattr(manager, "_persist_session_state", lambda *_args, **_kwargs: False)
    failed = client.put(endpoint, headers=private_headers, json={"mode": "auto"})
    assert failed.status_code == 500
    assert "mode unchanged" in failed.json()["detail"]
    assert client.get(endpoint, headers=private_headers).json()["mode"] == "ask"
    assert manager.get(session_id, touch=False).studio_session.permission_mode == "ask"
    assert client.get("/api/permissions", headers=token_headers).json()["mode"] == "plan"


def test_environment_permission_mode_summary_failure_rolls_back_after_core_snapshot(
    tmp_path: Path,
    monkeypatch,
) -> None:
    """A summary failure cannot make a permission change survive a restart."""

    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("AGX_DESKTOP_TOKEN", "desktop-test-token")
    monkeypatch.setattr(
        session_store_module,
        "DEFAULT_SESSION_DB_PATH",
        tmp_path / "sessions.sqlite",
    )
    monkeypatch.setattr(ConfigManager, "GLOBAL_CONFIG_PATH", tmp_path / "config.yaml")
    monkeypatch.setattr(ConfigManager, "PROJECT_CONFIG_PATH", tmp_path / "project.yaml")
    app = create_studio_app()
    client = TestClient(app)
    private_headers = {
        "x-agx-desktop-token": "desktop-test-token",
        "x-agx-session-purpose": ENVIRONMENT_ASSISTANT_PURPOSE,
        "x-agx-session-scope": "scope-a",
    }
    created = client.get(
        "/api/session",
        params={"purpose": ENVIRONMENT_ASSISTANT_PURPOSE},
        headers=private_headers,
    )
    assert created.status_code == 200
    session_id = created.json()["session_id"]
    endpoint = f"/api/sessions/{session_id}/permissions"
    manager = app.state.session_manager
    managed = manager.get(session_id, touch=False)
    assert managed is not None
    previous_updated_at = managed.updated_at
    managed.studio_session.chat_history = [
        {"role": "user", "content": "core snapshot survives"}
    ]

    core_results: list[bool] = []
    original_persist_core_snapshots = manager._persist_core_snapshots

    def _persist_core_snapshots(*args, **kwargs) -> bool:
        result = original_persist_core_snapshots(*args, **kwargs)
        core_results.append(result)
        return result

    monkeypatch.setattr(manager, "_persist_core_snapshots", _persist_core_snapshots)

    def _fail_summary(*_args, **_kwargs) -> None:
        raise OSError("summary saver unavailable")

    monkeypatch.setattr(
        manager._session_store,
        "_save_session_summary_sync",
        _fail_summary,
    )

    failed = client.put(endpoint, headers=private_headers, json={"mode": "auto"})
    assert failed.status_code == 500
    assert "mode unchanged" in failed.json()["detail"]
    assert core_results == [True]
    assert managed.studio_session.permission_mode == "ask"
    assert managed.updated_at == previous_updated_at

    messages_path = Path(manager._messages_path(session_id))
    messages = json.loads(messages_path.read_text(encoding="utf-8"))
    assert messages[0]["content"] == "core snapshot survives"
    assert manager._session_store._load_latest_session_metadata_sync(session_id)[
        "permission_mode"
    ] == "ask"

    fresh = SessionManager()
    fresh._session_store = manager._session_store
    fresh._sessions_root = manager._sessions_root
    restored = fresh.get(session_id)
    assert restored is not None
    assert restored.studio_session.permission_mode == "ask"


def test_environment_permission_mode_rejects_bad_scope_and_mode(
    tmp_path: Path,
    monkeypatch,
) -> None:
    """Permission reads/writes require the exact purpose scope and a real mode."""

    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("AGX_DESKTOP_TOKEN", "desktop-test-token")
    monkeypatch.setattr(
        session_store_module,
        "DEFAULT_SESSION_DB_PATH",
        tmp_path / "sessions.sqlite",
    )
    app = create_studio_app()
    client = TestClient(app)
    token_headers = {"x-agx-desktop-token": "desktop-test-token"}
    private_headers = {
        **token_headers,
        "x-agx-session-purpose": ENVIRONMENT_ASSISTANT_PURPOSE,
        "x-agx-session-scope": "scope-a",
    }
    created = client.get(
        "/api/session",
        params={"purpose": ENVIRONMENT_ASSISTANT_PURPOSE},
        headers=private_headers,
    )
    assert created.status_code == 200
    session_id = created.json()["session_id"]
    endpoint = f"/api/sessions/{session_id}/permissions"

    assert client.get(endpoint, headers=token_headers).status_code == 403
    assert client.get(
        endpoint,
        headers={**private_headers, "x-agx-session-scope": "scope-b"},
    ).status_code == 403
    invalid = client.put(endpoint, headers=private_headers, json={"mode": "default"})
    assert invalid.status_code == 400
    assert client.get(endpoint, headers=private_headers).json()["mode"] == "ask"

    managed = client.app.state.session_manager.get(session_id)
    assert managed is not None
    managed.execution_state = "running"
    busy = client.put(endpoint, headers=private_headers, json={"mode": "auto"})
    assert busy.status_code == 409
    assert client.get(endpoint, headers=private_headers).json()["mode"] == "ask"

    # The stop path records an interrupted/stopped execution state.  It is
    # still safe to edit the private session's mode once no turn is running.
    managed.execution_state = "interrupted"
    stopped = client.put(endpoint, headers=private_headers, json={"mode": "plan"})
    assert stopped.status_code == 200, stopped.text
    assert stopped.json()["mode"] == "plan"


def test_dedicated_runtime_marker_skips_automatic_memory_but_ordinary_still_registers() -> None:
    """The server-owned purpose reaches AgentRuntime without title/prompt inference."""

    private = AgentRuntime(
        object(),
        object(),
        session_purpose=ENVIRONMENT_ASSISTANT_PURPOSE,
    )
    child = AgentRuntime(
        object(),
        object(),
        team_manager=SimpleNamespace(
            base_session=SimpleNamespace(
                _session_purpose=ENVIRONMENT_ASSISTANT_PURPOSE,
            )
        ),
    )
    ordinary = AgentRuntime(object(), object())
    private_hooks = {type(hook).__name__ for _priority, hook in private.hooks._entries}
    child_hooks = {type(hook).__name__ for _priority, hook in child.hooks._entries}
    ordinary_hooks = {type(hook).__name__ for _priority, hook in ordinary.hooks._entries}
    assert "MemoryHook" not in private_hooks
    assert "MemoryHook" not in child_hooks
    assert "SessionSummaryHook" not in private_hooks
    assert "TurnArchiveHook" not in private_hooks
    assert "MemoryHook" in ordinary_hooks


@pytest.mark.asyncio
async def test_memory_hook_does_not_write_dedicated_session_memory(tmp_path: Path) -> None:
    """A dedicated session cannot pollute the workspace Markdown memory files."""

    history = [
        {"role": "user", "content": "请记住这条环境诊断偏好"},
        {"role": "assistant", "content": "已完成环境检查"},
    ] * 3
    private_session = SimpleNamespace(
        _session_purpose=ENVIRONMENT_ASSISTANT_PURPOSE,
        workspace_dir=str(tmp_path),
        chat_history=history,
        scratchpad={},
    )
    await MemoryHook().on_agent_end("已完成", private_session)
    assert not (tmp_path / "MEMORY.md").exists()
    assert not (tmp_path / "memory").exists()

    ordinary_workspace = tmp_path / "ordinary"
    ordinary_session = SimpleNamespace(
        workspace_dir=str(ordinary_workspace),
        chat_history=history,
        scratchpad={},
    )
    await MemoryHook().on_agent_end("已完成", ordinary_session)
    assert (ordinary_workspace / "memory").is_dir()
    assert any((ordinary_workspace / "memory").iterdir())


@pytest.mark.asyncio
async def test_finalize_skips_graph_ingest_for_dedicated_session(monkeypatch) -> None:
    """Finalization keeps ordinary graph ingest while excluding private turns."""

    scheduled: list[str] = []

    def _schedule(session_id: str, **_kwargs) -> None:
        scheduled.append(session_id)

    monkeypatch.setattr(
        "agenticx.memory.graph.writer.schedule_turn_ingest_from_session",
        _schedule,
    )
    monkeypatch.setattr("agenticx.studio.server._flush_taskspace_hint", lambda *a, **k: None)
    monkeypatch.setattr(
        "agenticx.studio.server._resolve_chat_end_execution_state",
        lambda *a, **k: "idle",
    )

    class _Manager:
        def __init__(self, purpose: str | None) -> None:
            self.purpose = purpose

        def clear_interrupt(self, _sid: str) -> None:
            pass

        def set_execution_state(self, _sid: str, _state: str, **_kwargs) -> None:
            pass

        async def persist_and_finalize_turn(self, _sid: str, **_kwargs) -> dict:
            return {"ok": True, "checkpoint_available": True}

        def get(self, _sid: str, touch: bool = False):
            return SimpleNamespace(purpose=self.purpose, avatar_id=None)

    class _Session:
        chat_history = [
            {"role": "user", "content": "检查环境"},
            {"role": "assistant", "content": "已完成检查"},
        ]

    from agenticx.studio.server import _finalize_chat_runtime

    await _finalize_chat_runtime(
        _Manager(ENVIRONMENT_ASSISTANT_PURPOSE),
        "private-session",
        _Session(),
        saw_final=True,
        had_runtime_failure=False,
    )
    await _finalize_chat_runtime(
        _Manager(None),
        "ordinary-session",
        _Session(),
        saw_final=True,
        had_runtime_failure=False,
    )
    assert scheduled == ["ordinary-session"]


def test_clarify_response_persists_on_managed_studio_session(
    tmp_path: Path,
    monkeypatch,
) -> None:
    """A clarification answer updates the durable session through its manager."""

    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("AGX_DESKTOP_TOKEN", "desktop-test-token")
    monkeypatch.setattr(
        session_store_module,
        "DEFAULT_SESSION_DB_PATH",
        tmp_path / "sessions.sqlite",
    )
    app = create_studio_app()
    client = TestClient(app)
    headers = {
        "x-agx-desktop-token": "desktop-test-token",
        "x-agx-session-purpose": ENVIRONMENT_ASSISTANT_PURPOSE,
        "x-agx-session-scope": "scope-a",
    }
    created = client.get(
        "/api/session",
        params={"purpose": ENVIRONMENT_ASSISTANT_PURPOSE},
        headers=headers,
    )
    assert created.status_code == 200
    session_id = created.json()["session_id"]
    managed = app.state.session_manager.get(session_id)
    assert managed is not None

    request_id = "clarify-persist-1"
    managed.studio_session.chat_history = [
        {
            "role": "tool",
            "content": "请选择工作区",
            "metadata": {"kind": "clarification", "request_id": request_id},
        }
    ]

    class _RecordingGate:
        def resolve(self, received_id: str, answer: dict) -> bool:
            assert received_id == request_id
            assert answer == {"answer_text": "项目目录", "selected_options": ["项目目录"]}
            return True

    managed.clarify_gate = _RecordingGate()  # type: ignore[assignment]
    persisted: list[str] = []

    async def _persist(session_id_to_save: str) -> bool:
        persisted.append(session_id_to_save)
        return True

    monkeypatch.setattr(app.state.session_manager, "persist_async", _persist)
    response = client.post(
        "/api/clarify",
        headers=headers,
        json={
            "session_id": session_id,
            "request_id": request_id,
            "answer_text": "项目目录",
            "selected_options": ["项目目录"],
        },
    )

    assert response.status_code == 200
    assert persisted == [session_id]
    metadata = managed.studio_session.chat_history[0]["metadata"]
    assert metadata["clarification_answered"] is True
    assert metadata["clarification_answer"] == {
        "answer_text": "项目目录",
        "selected_options": ["项目目录"],
    }


def test_dedicated_headers_cannot_retarget_an_ordinary_session(
    tmp_path: Path,
    monkeypatch,
) -> None:
    """A private panel must not turn an ordinary sid into its own surface."""

    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("AGX_DESKTOP_TOKEN", "desktop-test-token")
    monkeypatch.setattr(
        session_store_module,
        "DEFAULT_SESSION_DB_PATH",
        tmp_path / "sessions.sqlite",
    )
    app = create_studio_app()
    client = TestClient(app)
    token_headers = {"x-agx-desktop-token": "desktop-test-token"}
    ordinary = client.get("/api/session", headers=token_headers)
    assert ordinary.status_code == 200
    session_id = ordinary.json()["session_id"]

    dedicated_headers = {
        **token_headers,
        "x-agx-session-purpose": ENVIRONMENT_ASSISTANT_PURPOSE,
        "x-agx-session-scope": "scope-a",
    }
    response = client.get(
        "/api/session/messages",
        params={"session_id": session_id},
        headers=dedicated_headers,
    )
    assert response.status_code == 403

    dedicated = client.get(
        "/api/session",
        params={"purpose": ENVIRONMENT_ASSISTANT_PURPOSE},
        headers={**token_headers, "x-agx-session-scope": "scope-a"},
    )
    assert dedicated.status_code == 200
    dedicated_id = dedicated.json()["session_id"]

    # Unsupported ordinary-only endpoints reject a dedicated sid, even when a
    # caller supplies the dedicated headers.
    for path, method, kwargs in (
        ("/api/session/context_usage", "get", {"params": {"session_id": dedicated_id}}),
        ("/api/session/summary", "post", {"json": {"session_id": dedicated_id}}),
        ("/api/session", "delete", {"params": {"session_id": dedicated_id}}),
        ("/api/voice/tool_call", "post", {"json": {
            "session_id": dedicated_id,
            "call_id": "private-call",
            "name": "list_files",
            "arguments": {},
        }}),
        ("/api/session/messages/append", "post", {"json": {
            "session_id": dedicated_id,
            "messages": [{"role": "user", "content": "private"}],
        }}),
        ("/api/memory/graph/overview", "get", {"params": {"session_id": dedicated_id}}),
    ):
        route = path.format(sid=session_id)
        result = getattr(client, method)(route, headers=dedicated_headers, **kwargs)
        assert result.status_code == 403, (method, route, result.text)

    # The read-only stream endpoint also validates purpose/scope before it
    # reports that the optional reattach feature is disabled.
    reattach = client.get(
        f"/api/sessions/{dedicated_id}/stream",
        headers={**dedicated_headers, "x-agx-session-scope": "scope-b"},
    )
    assert reattach.status_code == 403
