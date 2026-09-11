"""Server-side fail-closed behavior for sticky attachment route sessions."""

from __future__ import annotations

from fastapi.testclient import TestClient

from agenticx.studio.attachment_routing import RoutingModelRef, remember_lock
from agenticx.studio.server import create_studio_app


PRIVATE_TARGET = RoutingModelRef(
    provider="private-route",
    model="private-model",
    label="企业私有模型",
    id="private-route/private-model",
)


def test_locked_missing_model_does_not_try_a_public_fallback(monkeypatch) -> None:
    """A missing private target config is visible, not repaired by switching providers."""
    from agenticx.studio import server as server_module

    resolve_calls: list[dict] = []

    def _missing_private_model(**kwargs):
        resolve_calls.append(kwargs)
        raise ValueError("Provider 'private-route' is missing model configuration")

    monkeypatch.setattr(server_module.ProviderResolver, "resolve", _missing_private_model)

    class _ProviderConfig:
        model = "public-model"

    class _Config:
        default_provider = "openai"
        providers = {"openai": {"model": "public-model", "enabled": True}}

        def get_provider(self, _name):
            return _ProviderConfig()

    # If the locked-session guard regresses, the missing-model repair below
    # will invoke the resolver repeatedly for public candidates.
    monkeypatch.setattr(server_module.ConfigManager, "load", classmethod(lambda _cls: _Config()))

    app = create_studio_app()
    with TestClient(app) as client:
        session_id = client.get("/api/session").json()["session_id"]
        managed = app.state.session_manager.get(session_id, touch=False)
        assert managed is not None
        remember_lock(managed.studio_session, PRIVATE_TARGET)

        response = client.post(
            "/api/chat",
            json={
                "session_id": session_id,
                "provider": "openai",
                "model": "public-model",
                "user_input": "继续处理已锁定会话",
            },
        )

    # The existing Studio contract reports initialization failures in the SSE
    # body; importantly, it never invokes a public candidate after the first
    # private resolution failure.
    assert response.status_code == 200
    assert "LLM init failed" in response.text
    assert len(resolve_calls) == 1
    assert resolve_calls[0]["provider_name"] == PRIVATE_TARGET.provider
    assert resolve_calls[0]["model"] == PRIVATE_TARGET.model
