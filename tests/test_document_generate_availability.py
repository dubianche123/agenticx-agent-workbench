"""Document renderer capability is advertised only with a local host."""

from __future__ import annotations

from agenticx.cli.agent_tools import studio_tools_for_session
from agenticx.cli.studio import StudioSession
from agenticx.runtime.prompts.meta_agent import _build_private_execution_context


def _names() -> set[str]:
    return {
        str((tool.get("function") or {}).get("name", ""))
        for tool in studio_tools_for_session(StudioSession())
    }


def test_document_generate_is_hidden_without_local_renderer(monkeypatch) -> None:
    monkeypatch.delenv("AGX_DOCUMENT_RENDERER_URL", raising=False)
    monkeypatch.delenv("AGX_DOCUMENT_RENDERER_TOKEN", raising=False)
    assert "document_generate" not in _names()


def test_document_generate_is_hidden_for_remote_renderer(monkeypatch) -> None:
    monkeypatch.setenv("AGX_DOCUMENT_RENDERER_URL", "http://renderer.internal:19091")
    monkeypatch.setenv("AGX_DOCUMENT_RENDERER_TOKEN", "test-token")
    assert "document_generate" not in _names()


def test_document_generate_is_advertised_for_local_renderer(monkeypatch) -> None:
    monkeypatch.setenv("AGX_DOCUMENT_RENDERER_URL", "http://127.0.0.1:19091")
    monkeypatch.setenv("AGX_DOCUMENT_RENDERER_TOKEN", "test-token")
    assert "document_generate" in _names()


def test_private_prompt_does_not_claim_remote_document_renderer(monkeypatch, tmp_path) -> None:
    session = StudioSession()
    session._private_workspace_root = str(tmp_path / "private")
    session._private_execution_root = str(tmp_path / "private" / "scratch")
    monkeypatch.setenv("AGX_DOCUMENT_RENDERER_URL", "http://renderer.internal:19091")
    monkeypatch.setenv("AGX_DOCUMENT_RENDERER_TOKEN", "test-token")
    remote_prompt = _build_private_execution_context(session)
    assert "document_generate" not in remote_prompt

    monkeypatch.setenv("AGX_DOCUMENT_RENDERER_URL", "http://127.0.0.1:19091")
    local_prompt = _build_private_execution_context(session)
    assert "document_generate" in local_prompt
