#!/usr/bin/env python3
"""Acceptance tests for the Ontology product's private user-data root."""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from agenticx.cli.config_manager import ConfigManager
from agenticx.memory.workspace_memory import WorkspaceMemoryStore
from agenticx.runtime.session_summary_store import summary_path
from agenticx.studio.chat_attachments import (
    materialize_session_text_context_files,
    session_uploads_dir,
)
from agenticx.studio.feedback_learning import (
    CanonicalFeedbackMessage,
    FeedbackCaseStore,
    FeedbackIdentity,
)
from agenticx.studio.session_manager import SessionManager
from agenticx.utils.agx_home import agx_home


def test_agx_home_is_lazy_and_does_not_rewrite_home(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    original_home = os.environ.get("HOME")
    monkeypatch.delenv("AGX_HOME", raising=False)
    assert agx_home() == Path.home() / ".agenticx-ontology"

    first = (tmp_path / "ontology-a").resolve()
    second = (tmp_path / "ontology-b").resolve()
    monkeypatch.setenv("AGX_HOME", str(first))
    assert agx_home() == first
    monkeypatch.setenv("AGX_HOME", str(second))
    assert agx_home() == second

    monkeypatch.setenv("AGX_HOME", "relative-ontology-root")
    with pytest.raises(ValueError, match="absolute"):
        agx_home()
    assert os.environ.get("HOME") == original_home


def test_config_manager_reads_ontology_config_without_hc_fallback(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Model the two product roots under a throwaway host home.  The explicit
    # AGX_HOME below must win even if an HC config exists beside it.
    host_home = tmp_path / "host-home"
    hc_config = host_home / ".agenticx" / "config.yaml"
    hc_config.parent.mkdir(parents=True)
    hc_config.write_text(
        "default_provider: hc\nproviders:\n  hc:\n    api_key: hc-only\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(Path, "home", lambda: host_home)
    monkeypatch.chdir(tmp_path)

    ontology_root = (tmp_path / "ontology").resolve()
    monkeypatch.setenv("AGX_HOME", str(ontology_root))
    ontology_config = ontology_root / "config.yaml"
    ontology_config.parent.mkdir(parents=True)
    ontology_config.write_text(
        "default_provider: ontology\nproviders:\n  ontology:\n    api_key: ontology-only\n",
        encoding="utf-8",
    )

    loaded = ConfigManager.load_scope("global")
    assert ConfigManager.GLOBAL_CONFIG_PATH == ontology_config
    assert loaded.default_provider == "ontology"
    assert loaded.providers["ontology"]["api_key"] == "ontology-only"
    assert "hc" not in loaded.providers

    other_root = (tmp_path / "ontology-other").resolve()
    monkeypatch.setenv("AGX_HOME", str(other_root))
    assert ConfigManager.load_scope("global").providers == {}


def test_home_cwd_cannot_overlay_or_modify_other_product_config(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    host_home = tmp_path / "host-home"
    legacy = host_home / ".agenticx" / "config.yaml"
    legacy.parent.mkdir(parents=True)
    original = "workspace_dir: /hc-only\nproviders:\n  hc:\n    api_key: synthetic-hc-only\ncc_bridge:\n  enabled: true\n"
    legacy.write_text(original)
    monkeypatch.setattr(Path, "home", lambda: host_home)
    monkeypatch.chdir(host_home)
    root = tmp_path / "ontology"
    root.mkdir()
    monkeypatch.setenv("AGX_HOME", str(root))
    (root / "config.yaml").write_text("workspace_dir: /ontology-only\n")

    assert ConfigManager.load().workspace_dir == "/ontology-only"
    assert "hc" not in ConfigManager.load().providers
    assert ConfigManager.get_value("providers.hc.api_key") is None
    assert "hc" not in ConfigManager.load_scope("project").providers
    ConfigManager.set_cc_bridge_field("enabled", False)
    with pytest.raises(ValueError, match="Project config"):
        ConfigManager.set_value("workspace_dir", "/wrong", scope="project")
    assert legacy.read_text() == original

    project = tmp_path / "selected-project"
    (project / ".agenticx").mkdir(parents=True)
    (project / ".agenticx" / "config.yaml").write_text("workspace_dir: /project-only\n")
    monkeypatch.chdir(project)
    assert ConfigManager.load().workspace_dir == "/project-only"
    ConfigManager.set_value("workspace_dir", "/updated-project", scope="project")
    assert ConfigManager.load().workspace_dir == "/updated-project"


def test_session_memory_feedback_and_attachments_are_root_scoped_and_restartable(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)
    root_a = (tmp_path / "ontology-a").resolve()
    root_b = (tmp_path / "ontology-b").resolve()
    session_id = "ontology-isolation-session"

    monkeypatch.setenv("AGX_HOME", str(root_a))
    manager = SessionManager()
    managed = manager.create(session_id=session_id)
    managed.studio_session.chat_history.append(
        {"role": "user", "content": "root-a session message"}
    )
    assert manager.persist(session_id) is True

    messages_path = root_a / "sessions" / session_id / "messages.json"
    assert messages_path.exists()
    assert manager._session_store.db_path == (root_a / "memory" / "sessions.sqlite").resolve()

    summary = summary_path(session_id)
    summary.parent.mkdir(parents=True, exist_ok=True)
    summary.write_text("# root-a summary\n", encoding="utf-8")

    memory_source = tmp_path / "root-a-memory.md"
    memory_source.write_text("# Ontology memory\nontologyonlymemory\n", encoding="utf-8")
    memory_a = WorkspaceMemoryStore()
    assert memory_a.db_path == (root_a / "memory" / "main.sqlite").resolve()
    assert memory_a.index_file_sync(memory_source) > 0
    assert memory_a.search_sync("ontologyonlymemory", mode="fts")

    feedback_a = FeedbackCaseStore()
    feedback_a.record_vote(
        identity=FeedbackIdentity(scope_id="scope-a", user_id="user-a"),
        message=CanonicalFeedbackMessage(
            session_id=session_id,
            message_id="message-a",
            question="question-a",
            answer="answer-a",
        ),
        value="like",
        now=1.0,
    )
    assert feedback_a.state_path == root_a / "feedback-learning" / "state.json"
    assert feedback_a.state_path.exists()

    materialized = materialize_session_text_context_files(
        session_id,
        {"notes.md": "root-a attachment"},
    )
    attachment_path = Path(next(iter(materialized)))
    assert attachment_path.parent == session_uploads_dir(session_id)
    assert attachment_path.is_relative_to(root_a / "sessions")

    # A fresh process root sees none of the previous product's persisted data.
    monkeypatch.setenv("AGX_HOME", str(root_b))
    manager_b = SessionManager()
    assert manager_b.get(session_id) is None
    assert not summary_path(session_id).exists()
    assert not session_uploads_dir(session_id).exists()
    assert WorkspaceMemoryStore().db_path == (root_b / "memory" / "main.sqlite").resolve()
    assert WorkspaceMemoryStore().search_sync("ontologyonlymemory", mode="fts") == []
    assert FeedbackCaseStore().cases == ()

    # Switching back emulates a restart against the original product root.
    monkeypatch.setenv("AGX_HOME", str(root_a))
    manager_restart = SessionManager()
    restored = manager_restart.get(session_id)
    assert restored is not None
    assert restored.studio_session.chat_history[0]["content"] == "root-a session message"
    assert summary_path(session_id).read_text(encoding="utf-8") == "# root-a summary\n"
    assert FeedbackCaseStore().cases[0].value == "like"
    assert materialize_session_text_context_files(
        session_id, {"notes.md": "root-a attachment"}
    )
