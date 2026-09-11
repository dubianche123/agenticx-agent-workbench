#!/usr/bin/env python3
"""Studio API coverage for data-only expert/group sharing packages."""

from __future__ import annotations

import json
from pathlib import Path

from fastapi.testclient import TestClient

from agenticx.avatar.portable_package import MAX_PACKAGE_BYTES
from agenticx.studio.server import create_studio_app


def _v2_expert_document(
    *,
    name: str,
    description: str = "",
    artifact_id: str = "expert:01HZX2N9FTM7E5V7Y7C3A8D2Q9",
) -> dict:
    return {
        "schema_version": 2,
        "artifact_id": artifact_id,
        "release_version": "1.0.0",
        "kind": "expert",
        "title": name,
        "description": description,
        "recommended_permission_mode": "ask",
        "dependencies": {"skills": [], "mcps": []},
        "resources": [],
        "workspace_slots": [],
        "payload": {
            "name": name,
            "role": "",
            "description": description,
            "tags": [],
            "system_prompt": "",
            "color": "blue",
            "default_permission_mode": "ask",
        },
    }


def _inspect_ticket(client: TestClient, raw: str) -> tuple[dict, str]:
    inspected = client.post(
        "/api/portable-packages/inspect",
        json={"raw": raw},
    )
    assert inspected.status_code == 200
    body = inspected.json()
    token = str(body.get("confirmation_token", ""))
    assert len(token) == 32
    return body["preview"], token


def test_expert_package_round_trip_uses_a_fresh_isolated_expert() -> None:
    app = create_studio_app()
    client = TestClient(app)
    source = app.state.avatar_registry.create_avatar(
        name="环境配置专家",
        role="开发环境诊断",
        system_prompt="先检查依赖清单，再提出最小修改。",
        description="帮助同事配置可复现的开发环境。",
        tags=["环境配置", "依赖诊断"],
        default_provider="private-provider",
        default_model="private-model",
        tools_enabled={"bash_exec": True},
        skills_enabled={"secret-skill": False},
        brains_enabled=["private-brain"],
        color="black",
    )
    source_workspace = source.workspace_dir

    exported = client.post(
        "/api/portable-packages/export",
        json={"kind": "expert", "id": source.id},
    )
    assert exported.status_code == 200, exported.text
    package = exported.json()["package"]
    assert set(package) == {
        "schema_version",
        "artifact_id",
        "release_version",
        "kind",
        "title",
        "description",
        "recommended_permission_mode",
        "dependencies",
        "resources",
        "workspace_slots",
        "payload",
    }
    assert package["schema_version"] == 2
    assert package["release_version"] == "1.0.0"
    assert package["kind"] == "expert"
    assert package["recommended_permission_mode"] == "ask"
    assert package["dependencies"] == {"skills": [], "mcps": []}
    assert package["resources"] == []
    assert package["workspace_slots"] == []
    assert set(package["payload"]) == {
        "name",
        "role",
        "description",
        "tags",
        "system_prompt",
        "color",
        "default_permission_mode",
    }
    serialized = json.dumps(package, ensure_ascii=False, separators=(",", ":"))
    for forbidden in (
        source.id,
        source_workspace,
        "private-provider",
        "private-model",
        "secret-skill",
        "private-brain",
        "bash_exec",
    ):
        assert forbidden not in serialized

    preview, confirmation_token = _inspect_ticket(client, serialized)
    assert preview == {
        "schema_version": 2,
        "artifact_id": package["artifact_id"],
        "release_version": "1.0.0",
        "kind": "expert",
        "title": "环境配置专家",
        "description": "帮助同事配置可复现的开发环境。",
        "summary": "帮助同事配置可复现的开发环境。",
        "byte_size": len(serialized.encode("utf-8")),
        "recommended_permission_mode": "ask",
        "skill_dependencies": [],
        "mcp_dependencies": [],
        "resource_paths": [],
        "workspace_slots": [],
        "scan_report": {
            "scanner_version": "1",
            "has_findings": False,
            "should_block": False,
            "findings": [],
        },
        "role": "开发环境诊断",
        "tags": ["环境配置", "依赖诊断"],
        "system_prompt": "先检查依赖清单，再提出最小修改。",
        "member_count": 0,
        "member_names": [],
        "member_roles": [],
        "member_system_prompts": [],
        "host_member_name": "",
        "routing": "",
        "name": "环境配置专家",
        "members": [],
    }

    imported = client.post(
        "/api/portable-packages/import",
        json={"raw": serialized, "confirmation_token": confirmation_token},
    )
    assert imported.status_code == 200
    body = imported.json()
    assert body["kind"] == "expert"
    imported_id = body["avatar"]["id"]
    assert imported_id != source.id
    installed = app.state.avatar_registry.get_avatar(imported_id)
    assert installed is not None
    assert installed.name == "环境配置专家（导入）"
    assert installed.system_prompt == source.system_prompt
    assert installed.workspace_dir != source_workspace
    assert installed.default_provider == ""
    assert installed.default_model == ""
    assert installed.tools_enabled == {}
    assert installed.skills_enabled is None
    assert installed.brains_enabled is None


def test_export_api_carries_selected_release_dependencies_resources_and_slots() -> None:
    app = create_studio_app()
    client = TestClient(app)
    source = app.state.avatar_registry.create_avatar(
        name="环境配置专家",
        role="环境维护",
    )
    workspace = Path(source.workspace_dir)
    (workspace / "SOUL.md").write_text("# 行为基线\n\n先验证，再修改。", encoding="utf-8")
    (workspace / "MEMORY.md").write_text("不应默认上传的本地记忆", encoding="utf-8")
    dependencies = {
        "skills": [
            {
                "capability_id": "skill:01ARZ3NDEKTSV4RRFFQ69G5FAV",
                "version": "2.1.0",
                "digest": "a" * 64,
                "required": True,
            }
        ],
        "mcps": [
            {
                "capability_id": "mcp:01ARZ3NDEKTSV4RRFFQ69G5FAW",
                "version": "1.4.0",
                "required": False,
            }
        ],
    }
    exported = client.post(
        "/api/portable-packages/export",
        json={
            "kind": "expert",
            "id": source.id,
            "release_version": "2.3.0",
            "recommended_permission_mode": "plan",
            "dependencies": dependencies,
            "resource_files": ["IDENTITY.md", "SOUL.md"],
            "workspace_slots": [
                {"name": "project_root", "access": "read-only", "required": False}
            ],
        },
    )
    assert exported.status_code == 200
    package = exported.json()["package"]
    assert package["release_version"] == "2.3.0"
    assert package["recommended_permission_mode"] == "plan"
    assert package["dependencies"] == dependencies
    assert [item["path"] for item in package["resources"]] == [
        "IDENTITY.md",
        "SOUL.md",
    ]
    assert "不应默认上传" not in json.dumps(package, ensure_ascii=False)
    assert package["workspace_slots"] == [
        {"name": "project_root", "access": "read-only", "required": False}
    ]

    marked = client.post(
        "/api/portable-packages/mark-published",
        json={"kind": "expert", "id": source.id, "release_version": "2.3.0"},
    )
    assert marked.status_code == 200
    default_export = client.post(
        "/api/portable-packages/export",
        json={"kind": "expert", "id": source.id},
    )
    assert default_export.json()["package"]["release_version"] == "2.3.0"


def test_export_api_rescans_selected_memory_and_does_not_advance_version() -> None:
    app = create_studio_app()
    client = TestClient(app)
    source = app.state.avatar_registry.create_avatar(name="安全审查专家")
    workspace = Path(source.workspace_dir)
    (workspace / "MEMORY.md").write_text(
        "CLIENT_SECRET=ABC_def-1234567890-secret",
        encoding="utf-8",
    )
    blocked = client.post(
        "/api/portable-packages/export",
        json={
            "kind": "expert",
            "id": source.id,
            "release_version": "1.1.0",
            "resource_files": ["MEMORY.md"],
        },
    )
    assert blocked.status_code == 400
    assert "credential_assignment" in blocked.json()["detail"]
    assert app.state.avatar_registry.get_avatar(source.id).portable_release_version == "1.0.0"


def test_market_preflight_returns_findings_without_releasing_or_persisting_them() -> None:
    app = create_studio_app()
    client = TestClient(app)
    source = app.state.avatar_registry.create_avatar(name="市场预检专家")
    workspace = Path(source.workspace_dir)
    (workspace / "MEMORY.md").write_text(
        "CLIENT_SECRET=ABC_def-1234567890-secret",
        encoding="utf-8",
    )
    preflight = client.post(
        "/api/portable-packages/export",
        json={
            "kind": "expert",
            "id": source.id,
            "release_version": "1.1.0",
            "resource_files": ["MEMORY.md"],
            "allow_scan_findings": True,
        },
    )
    assert preflight.status_code == 200, preflight.text
    body = preflight.json()
    assert body["ok"] is True
    assert "CLIENT_SECRET" in body["package"]["resources"][0]["content"]
    assert body["scan_report"]["has_findings"] is True
    assert body["scan_report"]["findings"]
    assert all(
        "CLIENT_SECRET" not in json.dumps(finding, ensure_ascii=False)
        for finding in body["scan_report"]["findings"]
    )
    assert app.state.avatar_registry.get_avatar(source.id).portable_release_version == "1.0.0"


def test_group_package_import_recreates_members_and_host_mapping() -> None:
    app = create_studio_app()
    client = TestClient(app)
    first = app.state.avatar_registry.create_avatar(
        name="实现专家",
        role="Engineer",
        system_prompt="负责实现。",
    )
    host = app.state.avatar_registry.create_avatar(
        name="审查专家",
        role="Reviewer",
        system_prompt="负责审查。",
    )
    source_group = app.state.group_registry.create_group(
        name="交付小组",
        avatar_ids=[first.id, host.id],
        routing="round-robin",
        host_avatar_id=host.id,
    )

    exported = client.post(
        "/api/portable-packages/export",
        json={"kind": "group", "id": source_group.id},
    )
    assert exported.status_code == 200
    package = exported.json()["package"]
    assert package["payload"]["host_member_index"] == 1
    assert package["payload"]["routing"] == "round-robin"
    assert first.id not in json.dumps(package, ensure_ascii=False)
    assert host.id not in json.dumps(package, ensure_ascii=False)

    serialized = json.dumps(package, ensure_ascii=False, separators=(",", ":"))
    _preview, confirmation_token = _inspect_ticket(client, serialized)
    imported = client.post(
        "/api/portable-packages/import",
        json={"raw": serialized, "confirmation_token": confirmation_token},
    )
    assert imported.status_code == 200
    body = imported.json()
    assert body["kind"] == "group"
    assert len(body["avatars"]) == 2
    created_group = body["group"]
    assert created_group["id"] != source_group.id
    assert created_group["routing"] == "round-robin"
    assert created_group["avatar_ids"] == [row["id"] for row in body["avatars"]]
    assert created_group["host_avatar_id"] == body["avatars"][1]["id"]
    assert set(created_group["avatar_ids"]).isdisjoint({first.id, host.id})


def test_portable_api_rejects_duplicate_and_unknown_fields_without_mutation() -> None:
    app = create_studio_app()
    client = TestClient(app)
    before = len(app.state.avatar_registry.list_avatars())
    duplicate_name = (
        '{"schema_version":2,"kind":"expert","title":"A","description":"",'
        '"payload":{"name":"A","name":"B","role":"","description":"",'
        '"tags":[],"system_prompt":"","color":"blue"}}'
    )
    rejected = client.post(
        "/api/portable-packages/inspect",
        json={"raw": duplicate_name},
    )
    assert rejected.status_code == 400
    assert "duplicate JSON key" in rejected.json()["detail"]

    unknown_field = _v2_expert_document(name="A")
    unknown_field["payload"]["workspace_dir"] = "/tmp/escape"
    rejected = client.post(
        "/api/portable-packages/inspect",
        json={"raw": json.dumps(unknown_field)},
    )
    assert rejected.status_code == 400
    assert "unknown field" in rejected.json()["detail"]
    assert len(app.state.avatar_registry.list_avatars()) == before


def test_portable_import_requires_matching_one_time_confirmation_ticket() -> None:
    app = create_studio_app()
    client = TestClient(app)
    raw = json.dumps(
        _v2_expert_document(name="一次性确认专家"),
        ensure_ascii=False,
        separators=(",", ":"),
    )

    missing = client.post(
        "/api/portable-packages/import",
        json={"raw": raw, "confirmation_token": ""},
    )
    assert missing.status_code == 409
    assert app.state.avatar_registry.list_avatars() == []

    _preview, token = _inspect_ticket(client, raw)
    first = client.post(
        "/api/portable-packages/import",
        json={"raw": raw, "confirmation_token": token},
    )
    assert first.status_code == 200
    replay = client.post(
        "/api/portable-packages/import",
        json={"raw": raw, "confirmation_token": token},
    )
    assert replay.status_code == 409
    assert len(app.state.avatar_registry.list_avatars()) == 1


def test_portable_routes_reject_object_shortcut_and_unsafe_export_id() -> None:
    app = create_studio_app()
    client = TestClient(app)
    package = _v2_expert_document(name="A")

    object_shortcut = client.post(
        "/api/portable-packages/inspect",
        json={"package": package},
    )
    assert object_shortcut.status_code == 400
    assert "exactly: raw" in object_shortcut.json()["detail"]

    traversal = client.post(
        "/api/portable-packages/export",
        json={"kind": "expert", "id": "../../outside"},
    )
    assert traversal.status_code == 404

    duplicate_wrapper = client.post(
        "/api/portable-packages/inspect",
        content=b'{"raw":"{}","raw":"{}"}',
        headers={"content-type": "application/json"},
    )
    assert duplicate_wrapper.status_code == 400
    assert "duplicate request field" in duplicate_wrapper.json()["detail"]

    oversized = client.post(
        "/api/portable-packages/inspect",
        content=b"x" * (MAX_PACKAGE_BYTES * 8 + 4097),
        headers={"content-type": "application/json"},
    )
    assert oversized.status_code == 413
