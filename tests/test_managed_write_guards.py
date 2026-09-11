"""Regression coverage for public writes against enterprise-managed entities."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from agenticx.studio.server import create_studio_app


def _memory_path(workspace_dir: str) -> Path:
    path = Path(workspace_dir) / "MEMORY.md"
    path.write_text(
        "# MEMORY.md\n\n## Managed anchors\n- keep this exact file\n",
        encoding="utf-8",
    )
    return path


def test_public_delete_rejects_managed_group_without_changing_entity_or_files() -> None:
    app = create_studio_app()
    client = TestClient(app)
    member = app.state.avatar_registry.create_avatar(name="群成员")
    group = app.state.group_registry.create_group(
        name="企业托管群",
        avatar_ids=[member.id],
        created_by="enterprise_managed",
        managed_capability_id="group:01ARZ3NDEKTSV4RRFFQ69G5FAW",
        managed_digest="a" * 64,
    )
    config_path = app.state.group_registry.root / group.id / "group.yaml"
    memory_path = _memory_path(group.workspace_dir)
    config_before = config_path.read_bytes()
    memory_before = memory_path.read_bytes()
    group_before = group.to_dict()

    response = client.delete(f"/api/groups/{group.id}")

    assert response.status_code == 403
    assert "enterprise-managed" in response.json()["detail"]
    assert config_path.read_bytes() == config_before
    assert memory_path.read_bytes() == memory_before
    assert app.state.group_registry.get_group(group.id).to_dict() == group_before


@pytest.mark.parametrize("subject_kind", ["expert", "group"])
def test_public_memory_writes_reject_managed_subjects_without_changing_memory(
    subject_kind: str,
) -> None:
    app = create_studio_app()
    client = TestClient(app)
    member = app.state.avatar_registry.create_avatar(name="托管群成员")
    if subject_kind == "expert":
        subject = app.state.avatar_registry.create_avatar(
            name="企业托管专家",
            created_by="enterprise_managed",
            managed_capability_id="expert:01ARZ3NDEKTSV4RRFFQ69G5FAV",
            managed_digest="b" * 64,
        )
        subject_id = subject.id
        workspace_dir = subject.workspace_dir
    else:
        group = app.state.group_registry.create_group(
            name="企业托管群",
            avatar_ids=[member.id],
            created_by="enterprise_managed",
            managed_capability_id="group:01ARZ3NDEKTSV4RRFFQ69G5FAW",
            managed_digest="c" * 64,
        )
        subject_id = f"group:{group.id}"
        workspace_dir = group.workspace_dir

    memory_path = _memory_path(workspace_dir)
    memory_before = memory_path.read_bytes()
    requests = [
        (
            "post",
            "/api/memory/workspace/entry",
            {"avatar_id": subject_id, "section": "Managed anchors", "text": "must not append"},
        ),
        (
            "patch",
            "/api/memory/workspace/entry",
            {
                "avatar_id": subject_id,
                "section": "Managed anchors",
                "index": 0,
                "text": "must not replace",
            },
        ),
        (
            "delete",
            "/api/memory/workspace/entry",
            {"avatar_id": subject_id, "section": "Managed anchors", "index": 0},
        ),
        (
            "post",
            "/api/memory/workspace/entries/batch-delete",
            {"avatar_id": subject_id, "entries": [{"section": "Managed anchors", "index": 0}]},
        ),
    ]

    for method, path, payload in requests:
        if method == "delete":
            response = client.request("DELETE", path, json=payload)
        else:
            response = getattr(client, method)(path, json=payload)
        assert response.status_code == 403, response.text
        assert "enterprise-managed" in response.json()["detail"]
        assert memory_path.read_bytes() == memory_before


def test_public_delete_still_removes_manual_group() -> None:
    app = create_studio_app()
    client = TestClient(app)
    member = app.state.avatar_registry.create_avatar(name="普通群成员")
    group = app.state.group_registry.create_group(
        name="普通群",
        avatar_ids=[member.id],
    )

    response = client.delete(f"/api/groups/{group.id}")

    assert response.status_code == 200
    assert app.state.group_registry.get_group(group.id) is None
