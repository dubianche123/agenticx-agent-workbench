#!/usr/bin/env python3
"""Tests for CC bridge Studio client URL policy.

Author: Damon Li
"""

from __future__ import annotations

import uuid

import pytest
from fastapi.testclient import TestClient

from agenticx.cc_bridge.settings import (
    cc_bridge_log_dir,
    cc_bridge_log_path,
    cc_bridge_mode,
    ensure_cc_bridge_token_persisted,
    validate_bridge_url_for_studio,
)
from agenticx.cli.config_manager import ConfigManager
from agenticx.cc_bridge.session_manager import BridgeSessionManager
from agenticx.studio.server import create_studio_app


@pytest.mark.parametrize(
    ("url", "expect_err"),
    [
        ("http://127.0.0.1:9742", False),
        ("http://localhost:9/x", False),
        ("http://[::1]:9742", False),
        ("http://example.com:9742", True),
    ],
)
def test_validate_loopback(url: str, expect_err: bool, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("AGX_CC_BRIDGE_ALLOW_NONLOCAL", raising=False)
    err = validate_bridge_url_for_studio(url)
    if expect_err:
        assert err is not None
    else:
        assert err is None


def test_validate_nonlocal_allowed(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AGX_CC_BRIDGE_ALLOW_NONLOCAL", "1")
    assert validate_bridge_url_for_studio("http://10.0.0.5:9742") is None


@pytest.fixture()
def isolated_config(monkeypatch: pytest.MonkeyPatch, tmp_path):
    monkeypatch.setattr(ConfigManager, "GLOBAL_CONFIG_PATH", tmp_path / "global.yaml")
    monkeypatch.setattr(ConfigManager, "PROJECT_CONFIG_PATH", tmp_path / "project.yaml")
    return tmp_path


def test_ensure_cc_bridge_token_persisted_generates_and_stable(
    monkeypatch: pytest.MonkeyPatch,
    isolated_config,
) -> None:
    monkeypatch.delenv("AGX_CC_BRIDGE_TOKEN", raising=False)
    t1 = ensure_cc_bridge_token_persisted()
    assert len(t1) >= 16
    t2 = ensure_cc_bridge_token_persisted()
    assert t1 == t2


def test_ensure_cc_bridge_token_respects_env(
    monkeypatch: pytest.MonkeyPatch,
    isolated_config,
) -> None:
    monkeypatch.setenv("AGX_CC_BRIDGE_TOKEN", "env-only-token")
    assert ensure_cc_bridge_token_persisted() == "env-only-token"


@pytest.fixture()
def studio_client_no_desktop_token(monkeypatch: pytest.MonkeyPatch, tmp_path) -> TestClient:
    monkeypatch.setattr(ConfigManager, "GLOBAL_CONFIG_PATH", tmp_path / "global.yaml")
    monkeypatch.setattr(ConfigManager, "PROJECT_CONFIG_PATH", tmp_path / "project.yaml")
    monkeypatch.delenv("AGX_DESKTOP_TOKEN", raising=False)
    return TestClient(create_studio_app())


def test_api_cc_bridge_config_get_generates_token(
    studio_client_no_desktop_token: TestClient,
) -> None:
    r = studio_client_no_desktop_token.get("/api/cc-bridge/config")
    assert r.status_code == 200
    data = r.json()
    assert data.get("ok") is True
    assert data.get("url")
    tok = data.get("token", "")
    assert len(tok) >= 16
    assert data.get("idle_stop_seconds") == 600
    assert data.get("mode") in ("headless", "visible_tui")


def test_api_cc_bridge_config_put_and_regenerate(
    studio_client_no_desktop_token: TestClient,
) -> None:
    g = studio_client_no_desktop_token.get("/api/cc-bridge/config")
    tok0 = g.json()["token"]
    r = studio_client_no_desktop_token.put(
        "/api/cc-bridge/config",
        json={"url": "http://127.0.0.1:9742", "token": tok0, "idle_stop_seconds": 321},
    )
    assert r.status_code == 200
    assert r.json().get("ok") is True
    assert r.json().get("idle_stop_seconds") == 321

    reg = studio_client_no_desktop_token.post("/api/cc-bridge/token/regenerate")
    assert reg.status_code == 200
    body = reg.json()
    assert body.get("ok") is True
    new_tok = body.get("token", "")
    assert len(new_tok) >= 16
    assert new_tok != tok0


def test_api_cc_bridge_config_put_mode(
    studio_client_no_desktop_token: TestClient,
) -> None:
    g = studio_client_no_desktop_token.get("/api/cc-bridge/config")
    tok = g.json()["token"]
    r = studio_client_no_desktop_token.put(
        "/api/cc-bridge/config",
        json={"url": "http://127.0.0.1:9742", "token": tok, "mode": "visible_tui"},
    )
    assert r.status_code == 200
    assert r.json().get("mode") == "visible_tui"
    r2 = studio_client_no_desktop_token.put(
        "/api/cc-bridge/config",
        json={"url": "http://127.0.0.1:9742", "token": tok, "mode": "headless"},
    )
    assert r2.status_code == 200
    assert r2.json().get("mode") == "headless"


def test_api_cc_bridge_put_mode_syncs_project_overlay(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
) -> None:
    """Project .agenticx/config.yaml must not win over Studio after a save."""
    gpath = tmp_path / "global.yaml"
    ppath = tmp_path / "project.yaml"
    monkeypatch.setattr(ConfigManager, "GLOBAL_CONFIG_PATH", gpath)
    monkeypatch.setattr(ConfigManager, "PROJECT_CONFIG_PATH", ppath)
    monkeypatch.delenv("AGX_DESKTOP_TOKEN", raising=False)
    monkeypatch.delenv("AGX_CC_BRIDGE_MODE", raising=False)

    gpath.write_text(
        "cc_bridge:\n"
        "  url: http://127.0.0.1:9742\n"
        "  token: testtok123456789012345678901234\n",
        encoding="utf-8",
    )
    ppath.write_text("cc_bridge:\n  mode: visible_tui\n", encoding="utf-8")

    assert ConfigManager.get_value("cc_bridge.mode") == "visible_tui"

    client = TestClient(create_studio_app())
    g = client.get("/api/cc-bridge/config")
    assert g.status_code == 200
    tok = g.json()["token"]
    r = client.put(
        "/api/cc-bridge/config",
        json={"url": "http://127.0.0.1:9742", "token": tok, "mode": "headless"},
    )
    assert r.status_code == 200
    assert r.json().get("mode") == "headless"
    assert ConfigManager.get_value("cc_bridge.mode") == "headless"
    proj = ConfigManager._load_yaml(ppath)
    assert proj.get("cc_bridge", {}).get("mode") == "headless"


def test_api_cc_bridge_config_put_invalid_mode(
    studio_client_no_desktop_token: TestClient,
) -> None:
    g = studio_client_no_desktop_token.get("/api/cc-bridge/config")
    tok = g.json()["token"]
    r = studio_client_no_desktop_token.put(
        "/api/cc-bridge/config",
        json={"url": "http://127.0.0.1:9742", "token": tok, "mode": "nope"},
    )
    assert r.status_code == 400


def test_cc_bridge_mode_env_overrides_config(
    monkeypatch: pytest.MonkeyPatch,
    isolated_config,
) -> None:
    ConfigManager.set_value("cc_bridge.mode", "headless", scope="global")
    monkeypatch.setenv("AGX_CC_BRIDGE_MODE", "visible_tui")
    assert cc_bridge_mode() == "visible_tui"


def test_cc_bridge_log_resolver_follows_custom_agx_home(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
) -> None:
    custom_root = (tmp_path / "custom-ontology").resolve()
    sid = str(uuid.uuid4())
    monkeypatch.setenv("AGX_HOME", str(custom_root))
    monkeypatch.delenv("CC_BRIDGE_LOG_DIR", raising=False)

    expected_dir = custom_root / "logs" / "cc-bridge"
    expected_path = expected_dir / f"{sid}.log"
    assert cc_bridge_log_dir() == expected_dir
    assert cc_bridge_log_path(sid) == expected_path
    assert BridgeSessionManager()._log_path_for_sid(sid) == str(expected_path)
    assert expected_dir.is_dir()


def test_cc_bridge_log_resolver_honors_explicit_log_dir_and_rejects_bad_id(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
) -> None:
    configured_dir = (tmp_path / "logs with spaces").resolve()
    monkeypatch.setenv("CC_BRIDGE_LOG_DIR", str(configured_dir))
    sid = str(uuid.uuid4())
    assert cc_bridge_log_path(sid).parent == configured_dir
    with pytest.raises(ValueError, match="session_id must be a UUID"):
        cc_bridge_log_path("../../outside")


def test_api_cc_bridge_config_returns_canonical_log_path_for_session(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
) -> None:
    custom_root = (tmp_path / "custom-ontology").resolve()
    monkeypatch.setenv("AGX_HOME", str(custom_root))
    monkeypatch.delenv("CC_BRIDGE_LOG_DIR", raising=False)
    monkeypatch.setattr(ConfigManager, "GLOBAL_CONFIG_PATH", custom_root / "config.yaml")
    monkeypatch.setattr(ConfigManager, "PROJECT_CONFIG_PATH", tmp_path / "project.yaml")
    monkeypatch.delenv("AGX_DESKTOP_TOKEN", raising=False)

    sid = str(uuid.uuid4())
    response = TestClient(create_studio_app()).get(
        f"/api/cc-bridge/config?session_id={sid}"
    )
    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert body["log_dir"] == str(custom_root / "logs" / "cc-bridge")
    assert body["log_path"] == str(custom_root / "logs" / "cc-bridge" / f"{sid}.log")
    assert ".agenticx-ontology" not in body["log_path"]


def test_api_cc_bridge_config_rejects_invalid_session_id(
    studio_client_no_desktop_token: TestClient,
) -> None:
    response = studio_client_no_desktop_token.get(
        "/api/cc-bridge/config?session_id=not-a-uuid"
    )
    assert response.status_code == 400
    assert response.json()["detail"] == "session_id must be a UUID"
