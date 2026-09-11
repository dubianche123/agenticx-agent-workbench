#!/usr/bin/env python3
"""Studio HTTP contract for authenticated managed portable reconciliation."""

from __future__ import annotations

import hashlib
import json

from fastapi.testclient import TestClient

from agenticx.avatar.portable_package import MAX_PACKAGE_BYTES
from agenticx.studio.server import create_studio_app


CAPABILITY_ID = "expert:01ARZ3NDEKTSV4RRFFQ69G5FAV"
GROUP_CAPABILITY_ID = "group:01ARZ3NDEKTSV4RRFFQ69G5FAW"


def _raw(name: str = "企业专家") -> str:
    declaration = {
        "name": name,
        "role": "分析师",
        "description": "企业下发专家。",
        "tags": ["企业"],
        "system_prompt": "先核对证据。",
        "color": "blue",
        "default_permission_mode": "ask",
    }
    return json.dumps(
        {
            "schema_version": 2,
            "artifact_id": CAPABILITY_ID,
            "release_version": "1.0.0",
            "kind": "expert",
            "title": name,
            "description": declaration["description"],
            "recommended_permission_mode": "ask",
            "dependencies": {"skills": [], "mcps": []},
            "resources": [],
            "workspace_slots": [],
            "payload": declaration,
        },
        ensure_ascii=False,
        separators=(",", ":"),
    )


def _package(raw: str) -> dict[str, str]:
    return {
        "id": CAPABILITY_ID,
        "digest": hashlib.sha256(raw.encode("utf-8")).hexdigest(),
        "raw": raw,
    }


def _group_raw() -> str:
    members = [
        {
            "name": "实现专家",
            "role": "工程师",
            "description": "负责实现。",
            "tags": ["实现"],
            "system_prompt": "完成实现。",
            "color": "blue",
            "default_permission_mode": "ask",
        },
        {
            "name": "复核专家",
            "role": "审查人",
            "description": "负责复核。",
            "tags": ["复核"],
            "system_prompt": "先找阻断问题。",
            "color": "white",
            "default_permission_mode": "ask",
        },
    ]
    return json.dumps(
        {
            "schema_version": 2,
            "artifact_id": GROUP_CAPABILITY_ID,
            "release_version": "1.0.0",
            "kind": "group",
            "title": "企业交付组",
            "description": "企业受管项目群。",
            "recommended_permission_mode": "ask",
            "dependencies": {"skills": [], "mcps": []},
            "resources": [],
            "workspace_slots": [],
            "payload": {
                "name": "企业交付组",
                "members": members,
                "host_member_index": 1,
                "routing": "round-robin",
            },
        },
        ensure_ascii=False,
        separators=(",", ":"),
    )


def test_managed_reconcile_requires_desktop_auth_and_is_idempotent(
    monkeypatch,
) -> None:
    monkeypatch.setenv("AGX_DESKTOP_TOKEN", "desktop-secret")
    app = create_studio_app()
    client = TestClient(app)
    raw = _raw()
    payload = {"packages": [_package(raw)]}

    unauthorized = client.post("/api/portable-packages/managed/reconcile", json=payload)
    assert unauthorized.status_code == 401

    headers = {"x-agx-desktop-token": "desktop-secret"}
    installed = client.post(
        "/api/portable-packages/managed/reconcile",
        json=payload,
        headers=headers,
    )
    assert installed.status_code == 200
    body = installed.json()
    assert body["ok"] is True
    assert body["installed"] == [CAPABILITY_ID]
    assert body["updated"] == []
    assert body["removed"] == []
    assert body["unchanged"] == []
    assert body["errors"] == []
    managed_id = body["managed"][0]["avatar_ids"][0]

    repeated = client.post(
        "/api/portable-packages/managed/reconcile",
        json=payload,
        headers=headers,
    )
    assert repeated.status_code == 200
    assert repeated.json()["unchanged"] == [CAPABILITY_ID]
    assert repeated.json()["managed"][0]["avatar_ids"] == [managed_id]
    assert len(app.state.avatar_registry.list_avatars()) == 1

    removed = client.post(
        "/api/portable-packages/managed/reconcile",
        json={"packages": []},
        headers=headers,
    )
    assert removed.status_code == 200
    assert removed.json()["removed"] == [CAPABILITY_ID]
    assert app.state.avatar_registry.get_avatar(managed_id) is None


def test_managed_reconcile_rejects_non_exact_or_invalid_desired_state_without_mutation() -> None:
    app = create_studio_app()
    client = TestClient(app)
    raw = _raw()
    valid = _package(raw)

    installed = client.post(
        "/api/portable-packages/managed/reconcile",
        json={"packages": [valid]},
    )
    assert installed.status_code == 200
    installed_id = installed.json()["managed"][0]["avatar_ids"][0]

    unknown_top = client.post(
        "/api/portable-packages/managed/reconcile",
        json={"packages": [], "unexpected": True},
    )
    assert unknown_top.status_code == 400
    assert "exactly: packages" in unknown_top.json()["detail"]

    invalid_item = dict(valid)
    invalid_item["extra"] = True
    rejected = client.post(
        "/api/portable-packages/managed/reconcile",
        json={"packages": [invalid_item]},
    )
    assert rejected.status_code == 400
    assert "contain exactly" in rejected.json()["detail"]

    bad_digest = dict(valid)
    bad_digest["digest"] = "0" * 64
    rejected = client.post(
        "/api/portable-packages/managed/reconcile",
        json={"packages": [bad_digest]},
    )
    assert rejected.status_code == 400
    assert "does not match raw" in rejected.json()["detail"]

    duplicate_wrapper = client.post(
        "/api/portable-packages/managed/reconcile",
        content=b'{"packages":[],"packages":[]}',
        headers={"content-type": "application/json"},
    )
    assert duplicate_wrapper.status_code == 400
    assert "duplicate request field" in duplicate_wrapper.json()["detail"]
    assert app.state.avatar_registry.get_avatar(installed_id) is not None


def test_managed_reconcile_enforces_package_size_and_capability_id() -> None:
    app = create_studio_app()
    client = TestClient(app)
    oversized = "x" * (MAX_PACKAGE_BYTES + 1)
    oversized_response = client.post(
        "/api/portable-packages/managed/reconcile",
        json={"packages": [_package(oversized)]},
    )
    assert oversized_response.status_code == 400
    assert "byte limit" in oversized_response.json()["detail"]

    raw = _raw()
    invalid_id = _package(raw)
    invalid_id["id"] = "expert:../../manual"
    invalid_response = client.post(
        "/api/portable-packages/managed/reconcile",
        json={"packages": [invalid_id]},
    )
    assert invalid_response.status_code == 400
    assert "expert:<ULID>" in invalid_response.json()["detail"]


def test_managed_reconcile_rejects_surrogate_prompt_without_poisoning_avatar_list() -> None:
    app = create_studio_app()
    client = TestClient(app)
    document = json.loads(_raw())
    document["payload"]["system_prompt"] = "unsafe-\ud800-tail"
    # Keep the package transport valid ASCII while exercising the post-unescape validator.
    raw = json.dumps(document, ensure_ascii=True, separators=(",", ":"))

    response = client.post(
        "/api/portable-packages/managed/reconcile",
        json={"packages": [_package(raw)]},
    )
    assert response.status_code == 400
    assert "surrogate" in response.json()["detail"]
    avatar_list = client.get("/api/avatars")
    assert avatar_list.status_code == 200
    assert avatar_list.json() == {"ok": True, "avatars": []}


def test_managed_group_api_returns_member_ids_and_remapped_host() -> None:
    app = create_studio_app()
    client = TestClient(app)
    raw = _group_raw()
    package = _package(raw)
    package["id"] = GROUP_CAPABILITY_ID

    response = client.post(
        "/api/portable-packages/managed/reconcile",
        json={"packages": [package]},
    )
    assert response.status_code == 200
    managed = response.json()["managed"][0]
    assert managed["id"] == GROUP_CAPABILITY_ID
    assert len(managed["avatar_ids"]) == 2
    group = app.state.group_registry.get_group(managed["group_id"])
    assert group is not None
    assert group.avatar_ids == managed["avatar_ids"]
    assert group.host_avatar_id == managed["avatar_ids"][1]
    assert group.routing == "round-robin"
