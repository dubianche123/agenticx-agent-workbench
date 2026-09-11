from __future__ import annotations

from fastapi.testclient import TestClient

from agenticx.cli.config_manager import ConfigManager
from agenticx.studio.enterprise_capability_policy import (
    enterprise_skill_marketplace_approved,
    registry_skill_install_allowed,
)


def _managed_config(*capabilities: dict, allow_local: bool = False) -> dict:
    return {
        "enterprise": {
            "enabled": True,
            "token": "enterprise-test-token",
            "policy": {
                "capability_policy": {
                    "allow_local_skill_install": allow_local,
                }
            },
            "capabilities": list(capabilities),
        }
    }


def _use_config(monkeypatch, config: dict) -> None:
    monkeypatch.setattr(
        ConfigManager,
        "_load_yaml",
        classmethod(lambda _cls, _path: config),
    )


def test_locked_registry_allows_only_the_exact_scoped_capability(monkeypatch) -> None:
    _use_config(
        monkeypatch,
        _managed_config(
            {"id": "skill:1", "kind": "skill", "name": "@finance/report-reader"},
            {"id": "mcp:1", "kind": "mcp", "name": "report-reader"},
        ),
    )

    assert enterprise_skill_marketplace_approved("report-reader", "finance") is True
    assert registry_skill_install_allowed("@finance/report-reader") is True
    assert registry_skill_install_allowed("report-reader", "another") is False
    assert registry_skill_install_allowed("report-reader") is False


def test_bare_capability_approves_the_same_slug(monkeypatch) -> None:
    _use_config(
        monkeypatch,
        _managed_config(
            {"id": "skill:1", "kind": "skill", "name": "plain-skill"},
        ),
    )

    assert registry_skill_install_allowed("plain-skill") is True
    assert registry_skill_install_allowed("plain-skill", "publisher") is True
    assert registry_skill_install_allowed("different-skill") is False


def test_unlocked_registry_preserves_existing_self_service(monkeypatch) -> None:
    _use_config(monkeypatch, _managed_config(allow_local=True))

    assert registry_skill_install_allowed("anything") is True


def test_registry_route_rechecks_capability_before_writing(monkeypatch) -> None:
    _use_config(
        monkeypatch,
        _managed_config(
            {"id": "skill:1", "kind": "skill", "name": "@finance/report-reader"},
        ),
    )
    from agenticx.extensions import skill_market_install
    from agenticx.studio.server import create_studio_app

    installed: list[tuple[str, str]] = []

    def _fake_install(skill_name: str, **kwargs):
        installed.append((skill_name, str(kwargs.get("namespace", ""))))
        return {"ok": True, "name": skill_name}

    monkeypatch.setattr(skill_market_install, "install_market_skill", _fake_install)
    client = TestClient(create_studio_app())

    denied = client.post(
        "/api/registry/install",
        json={"name": "report-reader", "namespace": "another"},
    )
    assert denied.status_code == 403
    assert installed == []

    approved = client.post(
        "/api/registry/install",
        json={"name": "report-reader", "namespace": "finance"},
    )
    assert approved.status_code == 200
    assert approved.json()["ok"] is True
    assert installed == [("report-reader", "finance")]

    removed: list[str] = []

    def _fake_uninstall(skill_name: str):
        removed.append(skill_name)
        return {"ok": True, "removed": True, "name": skill_name}

    monkeypatch.setattr(skill_market_install, "uninstall_market_skill", _fake_uninstall)
    deleted = client.request(
        "DELETE",
        "/api/registry/install",
        json={"name": "report-reader"},
    )
    assert deleted.status_code == 200
    assert deleted.json()["removed"] is True
    assert removed == ["report-reader"]
