#!/usr/bin/env python3
"""Studio API coverage for expert SOUL files in canonical workspaces."""

from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from agenticx.studio.server import create_studio_app


def test_avatar_soul_round_trip_uses_registry_workspace(tmp_path: Path) -> None:
    app = create_studio_app()
    client = TestClient(app)
    custom_workspace = tmp_path / "custom-expert-workspace"
    avatar = app.state.avatar_registry.create_avatar(
        name="自定义工作区专家",
        workspace_dir=str(custom_workspace),
    )
    canonical_soul = custom_workspace / "SOUL.md"
    legacy_soul = app.state.avatar_registry.root / avatar.id / "SOUL.md"

    missing = client.get(f"/api/avatars/{avatar.id}/soul")
    assert missing.status_code == 200
    assert missing.json() == {"ok": True, "content": ""}

    content = "# SOUL.md\n\n始终从证据出发。\n"
    saved = client.put(
        f"/api/avatars/{avatar.id}/soul",
        json={"content": content},
    )
    assert saved.status_code == 200
    assert saved.json() == {"ok": True}
    assert canonical_soul.read_text(encoding="utf-8") == content
    assert not legacy_soul.exists()

    loaded = client.get(f"/api/avatars/{avatar.id}/soul")
    assert loaded.status_code == 200
    assert loaded.json() == {"ok": True, "content": content}


def test_avatar_soul_api_rejects_unknown_avatar() -> None:
    client = TestClient(create_studio_app())

    loaded = client.get("/api/avatars/does-not-exist/soul")
    assert loaded.status_code == 404
    assert loaded.json()["detail"] == "avatar not found"

    saved = client.put(
        "/api/avatars/does-not-exist/soul",
        json={"content": "should not be written"},
    )
    assert saved.status_code == 404
    assert saved.json()["detail"] == "avatar not found"


def test_avatar_core_memory_api_round_trip_and_rejects_arbitrary_paths(tmp_path: Path) -> None:
    app = create_studio_app()
    client = TestClient(app)
    avatar = app.state.avatar_registry.create_avatar(
        name="核心资料专家",
        workspace_dir=str(tmp_path / "workspace"),
    )

    loaded = client.get(f"/api/avatars/{avatar.id}/core-memory")
    assert loaded.status_code == 200
    assert set(loaded.json()["documents"]) == {"IDENTITY.md", "SOUL.md", "MEMORY.md"}

    documents = {
        "IDENTITY.md": "# 身份\n核心资料专家\n",
        "SOUL.md": "# 风格\n先验证再行动。\n",
        "MEMORY.md": "# 记忆\n只保留可复用经验。\n",
    }
    saved = client.put(
        f"/api/avatars/{avatar.id}/core-memory",
        json={"documents": documents},
    )
    assert saved.status_code == 200
    assert saved.json()["documents"] == documents
    assert client.get(f"/api/avatars/{avatar.id}/core-memory").json()["documents"] == documents

    rejected = client.put(
        f"/api/avatars/{avatar.id}/core-memory",
        json={"documents": {"../../outside.md": "escape"}},
    )
    assert rejected.status_code == 400
    assert "only IDENTITY.md" in rejected.json()["detail"]


def test_avatar_default_permission_mode_is_normalized_and_persisted() -> None:
    app = create_studio_app()
    client = TestClient(app)

    created = client.post(
        "/api/avatars",
        json={"name": "权限专家", "default_permission_mode": "auto"},
    )
    assert created.status_code == 200
    avatar_id = created.json()["avatar"]["id"]
    assert created.json()["avatar"]["default_permission_mode"] == "auto"

    updated = client.put(
        f"/api/avatars/{avatar_id}",
        json={"default_permission_mode": "not-a-mode"},
    )
    assert updated.status_code == 200
    assert updated.json()["avatar"]["default_permission_mode"] == "ask"


def test_avatar_workspace_can_be_changed_only_to_an_existing_directory(tmp_path: Path) -> None:
    app = create_studio_app()
    client = TestClient(app)
    avatar = app.state.avatar_registry.create_avatar(name="工作区专家")
    selected = tmp_path / "selected-workspace"
    selected.mkdir()

    updated = client.put(
        f"/api/avatars/{avatar.id}",
        json={"workspace_dir": str(selected)},
    )
    assert updated.status_code == 200
    assert updated.json()["avatar"]["workspace_dir"] == str(selected.resolve())
    assert app.state.avatar_registry.get_avatar(avatar.id).workspace_dir == str(selected.resolve())

    missing = client.put(
        f"/api/avatars/{avatar.id}",
        json={"workspace_dir": str(tmp_path / "does-not-exist")},
    )
    assert missing.status_code == 400

    blank = client.put(
        f"/api/avatars/{avatar.id}",
        json={"workspace_dir": ""},
    )
    assert blank.status_code == 400
    assert app.state.avatar_registry.get_avatar(avatar.id).workspace_dir == str(selected.resolve())

    outside = tmp_path / "outside"
    outside.mkdir()
    symlink = tmp_path / "workspace-link"
    symlink.symlink_to(outside, target_is_directory=True)
    rejected = client.put(
        f"/api/avatars/{avatar.id}",
        json={"workspace_dir": str(symlink)},
    )
    assert rejected.status_code == 400


def test_enterprise_managed_avatar_is_viewable_but_not_writable(tmp_path: Path) -> None:
    app = create_studio_app()
    client = TestClient(app)
    avatar = app.state.avatar_registry.create_avatar(
        name="企业托管专家",
        created_by="enterprise_managed",
        workspace_dir=str(tmp_path / "managed-workspace"),
        default_permission_mode="auto",
    )

    loaded = client.get(f"/api/avatars/{avatar.id}/core-memory")
    assert loaded.status_code == 200
    assert "IDENTITY.md" in loaded.json()["documents"]

    assert client.put(
        f"/api/avatars/{avatar.id}",
        json={"name": "不应修改"},
    ).status_code == 403
    assert client.put(
        f"/api/avatars/{avatar.id}/core-memory",
        json={"documents": {"SOUL.md": "不应修改"}},
    ).status_code == 403
    assert client.put(
        f"/api/avatars/{avatar.id}/soul",
        json={"content": "不应修改"},
    ).status_code == 403
    assert client.delete(f"/api/avatars/{avatar.id}").status_code == 403
    reordered = client.post(
        "/api/avatars/reorder",
        json={"orders": {avatar.id: 99}},
    )
    assert reordered.status_code == 200
    assert reordered.json()["updated"] == 0
