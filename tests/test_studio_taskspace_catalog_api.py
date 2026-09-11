from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from agenticx.studio.server import create_studio_app


def test_taskspace_catalog_api_registers_and_attaches_explicitly(
    tmp_path: Path,
    monkeypatch,
) -> None:
    monkeypatch.setenv("AGX_DESKTOP_TOKEN", "catalog-test-token")
    monkeypatch.setenv("HOME", str(tmp_path))

    app = create_studio_app()
    with TestClient(app) as client:
        headers = {"X-AGX-Desktop-Token": "catalog-test-token"}
        # Cold app construction must keep the core Desktop boot APIs alive.
        assert client.get("/api/avatars", headers=headers).status_code == 200
        assert client.get("/api/sessions", headers=headers).status_code == 200
        session_id = client.get("/api/session", headers=headers).json()["session_id"]
        folder = tmp_path / "picked-repo"
        folder.mkdir()

        registered = client.post(
            "/api/taskspace/workspaces/register",
            headers=headers,
            json={"path": str(folder), "label": "picked-repo"},
        )
        assert registered.status_code == 200
        assert registered.json()["workspace"]["available"] is True

        listed = client.get(
            "/api/taskspace/workspaces",
            headers=headers,
            params={"session_id": session_id},
        )
        assert listed.status_code == 200
        body = listed.json()
        assert [row["id"] for row in body["workspaces"]] == ["default"]
        assert any(row["path"] == str(folder.resolve()) for row in body["available_workspaces"])

        attached = client.post(
            "/api/taskspace/workspaces",
            headers=headers,
            json={"session_id": session_id, "path": str(folder)},
        )
        assert attached.status_code == 200
        assert attached.json()["workspace"]["path"] == str(folder.resolve())

        after_attach = client.get(
            "/api/taskspace/workspaces",
            headers=headers,
            params={"session_id": session_id},
        ).json()
        assert not after_attach["available_workspaces"]


def test_taskspace_catalog_api_requires_token_and_valid_path(
    tmp_path: Path,
    monkeypatch,
) -> None:
    monkeypatch.setenv("AGX_DESKTOP_TOKEN", "catalog-test-token")
    monkeypatch.setenv("HOME", str(tmp_path))
    app = create_studio_app()
    with TestClient(app) as client:
        assert client.post(
            "/api/taskspace/workspaces/register",
            json={"path": str(tmp_path)},
        ).status_code == 401
        response = client.post(
            "/api/taskspace/workspaces/register",
            headers={"X-AGX-Desktop-Token": "catalog-test-token"},
            json={"path": ""},
        )
        assert response.status_code == 400
        missing = client.post(
            "/api/taskspace/workspaces/register",
            headers={"X-AGX-Desktop-Token": "catalog-test-token"},
            json={"path": str(tmp_path / "missing")},
        )
        assert missing.status_code == 400

        session_id = client.get(
            "/api/session",
            headers={"X-AGX-Desktop-Token": "catalog-test-token"},
        ).json()["session_id"]
        file_path = tmp_path / "not-a-workspace.txt"
        file_path.write_text("not a directory", encoding="utf-8")
        file_attach = client.post(
            "/api/taskspace/workspaces",
            headers={"X-AGX-Desktop-Token": "catalog-test-token"},
            json={"session_id": session_id, "path": str(file_path)},
        )
        assert file_attach.status_code == 400

        missing_attach_path = tmp_path / "missing-attach"
        missing_attach = client.post(
            "/api/taskspace/workspaces",
            headers={"X-AGX-Desktop-Token": "catalog-test-token"},
            json={"session_id": session_id, "path": str(missing_attach_path)},
        )
        assert missing_attach.status_code == 400
        assert not missing_attach_path.exists()

        default_attach = client.post(
            "/api/taskspace/workspaces",
            headers={"X-AGX-Desktop-Token": "catalog-test-token"},
            json={"session_id": session_id},
        )
        assert default_attach.status_code == 200
        assert default_attach.json()["workspace"]["id"] == "default"
