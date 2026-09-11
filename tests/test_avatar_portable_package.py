#!/usr/bin/env python3
"""Tests for strict v2 expert and expert-team packages."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

import pytest

from agenticx.avatar.group_chat import GroupChatRegistry
from agenticx.avatar.portable_package import (
    MAX_GROUP_MEMBERS,
    MAX_PACKAGE_BYTES,
    MAX_RESOURCE_BYTES,
    PortablePackageError,
    PortablePackageImportError,
    PortablePackageSecurityError,
    export_expert_package,
    export_group_package,
    import_portable_package,
    make_portable_resource,
    preview_portable_package,
    scan_portable_package,
)
from agenticx.avatar.registry import AvatarRegistry


SKILL_CAPABILITY_ID = "skill:01ARZ3NDEKTSV4RRFFQ69G5FAV"
MCP_CAPABILITY_ID = "mcp:01ARZ3NDEKTSV4RRFFQ69G5FAW"


def _expert_declaration(name: str = "分析专家") -> dict[str, Any]:
    return {
        "name": name,
        "role": "业务分析师",
        "description": "负责把复杂问题整理成可执行结论。",
        "tags": ["分析", "复核"],
        "system_prompt": "先核对证据，再给出结论。",
        "color": "blue",
        "default_permission_mode": "ask",
    }


def _expert_envelope(name: str = "分析专家") -> dict[str, Any]:
    payload = _expert_declaration(name)
    return {
        "schema_version": 2,
        "artifact_id": "expert:01HZX2N9FTM7E5V7Y7C3A8D2Q9",
        "release_version": "1.0.0",
        "kind": "expert",
        "title": name,
        "description": payload["description"],
        "recommended_permission_mode": "ask",
        "dependencies": {"skills": [], "mcps": []},
        "resources": [],
        "workspace_slots": [],
        "payload": payload,
    }


def _group_envelope(member_count: int = 2) -> dict[str, Any]:
    members = [_expert_declaration(f"成员 {index + 1}") for index in range(member_count)]
    return {
        "schema_version": 2,
        "artifact_id": "group:01HZX2N9FTM7E5V7Y7C3A8D2Q9",
        "release_version": "1.0.0",
        "kind": "group",
        "title": "交付小组",
        "description": "一组经过复核的协作专家。",
        "recommended_permission_mode": "ask",
        "dependencies": {"skills": [], "mcps": []},
        "resources": [],
        "workspace_slots": [],
        "payload": {
            "name": "交付小组",
            "members": members,
            "host_member_index": 0,
            "routing": "intelligent",
        },
    }


def _dump(document: dict[str, Any]) -> str:
    return json.dumps(document, ensure_ascii=False, separators=(",", ":"))


def _all_keys(value: Any) -> set[str]:
    if isinstance(value, dict):
        keys = set(value)
        for nested in value.values():
            keys.update(_all_keys(nested))
        return keys
    if isinstance(value, list):
        keys: set[str] = set()
        for nested in value:
            keys.update(_all_keys(nested))
        return keys
    return set()


def test_expert_export_is_strict_and_redacts_local_runtime_state(tmp_path: Path) -> None:
    source = AvatarRegistry(root=tmp_path / "source-avatars")
    custom_workspace = tmp_path / "private-project"
    expert = source.create_avatar(
        name="财务复核专家",
        role="财务分析师",
        description="复核财务口径和关键结论。",
        tags=["财务", "复核"],
        system_prompt="所有数字必须可追溯。",
        default_provider="private-provider",
        default_model="private-model",
        tools_enabled={"shell": True},
        skills_enabled={"internal-skill": False},
        brains_enabled=["private-brain-id"],
        workspace_dir=str(custom_workspace),
        color="black",
    )
    (custom_workspace / "MEMORY.md").write_text("不得外发的客户记忆", encoding="utf-8")
    (custom_workspace / "report.xlsx").write_bytes(b"private-file")

    raw = export_expert_package(expert.id, avatar_registry=source)
    document = json.loads(raw)

    assert set(document) == {
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
    assert set(document["payload"]) == {
        "name",
        "role",
        "description",
        "tags",
        "system_prompt",
        "color",
        "default_permission_mode",
    }
    assert document["title"] == "财务复核专家"
    assert document["schema_version"] == 2
    assert document["artifact_id"] == expert.portable_artifact_id
    assert document["release_version"] == "1.0.0"
    assert document["recommended_permission_mode"] == "ask"
    assert document["dependencies"] == {"skills": [], "mcps": []}
    assert document["resources"] == []
    assert document["workspace_slots"] == []
    assert document["payload"]["color"] == "black"
    forbidden_keys = {
        "id",
        "avatar_id",
        "workspace_dir",
        "created_at",
        "updated_at",
        "pinned",
        "sort_order",
        "default_provider",
        "default_model",
        "tools_enabled",
        "skills_enabled",
        "brains_enabled",
        "mcp",
        "files",
        "memory",
        "chat_history",
    }
    assert _all_keys(document).isdisjoint(forbidden_keys)
    assert expert.id not in raw
    assert str(custom_workspace) not in raw
    assert "不得外发的客户记忆" not in raw
    assert "private-model" not in raw
    assert "private-file" not in raw

    preview = preview_portable_package(raw)
    assert preview.kind == "expert"
    assert preview.schema_version == 2
    assert preview.release_version == "1.0.0"
    assert preview.title == "财务复核专家"
    assert preview.role == "财务分析师"
    assert preview.tags == ("财务", "复核")
    assert preview.summary == "复核财务口径和关键结论。"
    assert preview.byte_size == len(raw.encode("utf-8"))


def test_expert_import_allocates_new_identity_workspace_and_safe_defaults(tmp_path: Path) -> None:
    source = AvatarRegistry(root=tmp_path / "source-avatars")
    original = source.create_avatar(
        name="质量专家",
        role="质量负责人",
        description="独立复核交付质量。",
        tags=["验收"],
        system_prompt="发现高风险问题必须明确指出。",
        default_provider="source-provider",
        default_model="source-model",
        tools_enabled={"shell": True},
        skills_enabled={"source-skill": False},
        brains_enabled="*",
        color="white",
    )
    source_memory = Path(original.workspace_dir) / "MEMORY.md"
    source_memory.write_text("客户甲的内部信息", encoding="utf-8")
    raw = export_expert_package(original.id, avatar_registry=source)

    destination = AvatarRegistry(root=tmp_path / "destination-avatars")
    destination.create_avatar(name="质量专家")
    result = import_portable_package(raw, avatar_registry=destination)

    assert result.kind == "expert"
    assert result.expert is not None
    imported = result.expert
    assert imported.id != original.id
    assert imported.name == "质量专家（导入）"
    assert imported.role == "质量负责人"
    assert imported.system_prompt == "发现高风险问题必须明确指出。"
    assert imported.description == "独立复核交付质量。"
    assert imported.tags == ["验收"]
    assert imported.color == "white"
    assert imported.created_by == "portable_import"
    assert imported.default_provider == ""
    assert imported.default_model == ""
    assert imported.tools_enabled == {}
    assert imported.skills_enabled is None
    assert imported.brains_enabled is None
    assert Path(imported.workspace_dir) == destination.root / imported.id / "workspace"
    assert (Path(imported.workspace_dir) / "IDENTITY.md").is_file()
    metadata = json.loads(
        (Path(imported.workspace_dir) / ".agenticx-package.json").read_text(
            encoding="utf-8"
        )
    )
    assert metadata["schema_version"] == 2
    assert metadata["release_version"] == "1.0.0"
    assert imported.portable_artifact_id != metadata["artifact_id"]
    assert "客户甲的内部信息" not in (
        Path(imported.workspace_dir) / "MEMORY.md"
    ).read_text(encoding="utf-8")
    assert result.created_avatar_ids == (imported.id,)


def test_v2_carries_references_resources_version_and_workspace_requests(
    tmp_path: Path,
) -> None:
    source = AvatarRegistry(root=tmp_path / "source-avatars")
    expert = source.create_avatar(
        name="环境配置专家",
        role="开发环境维护",
        description="帮助同事配置一致的开发环境。",
        system_prompt="先检查环境，再给出最小变更。",
    )
    dependencies = {
        "skills": [
            {
                "capability_id": SKILL_CAPABILITY_ID,
                "version": "2.1.0",
                "digest": "a" * 64,
                "required": True,
            }
        ],
        "mcps": [
            {
                "capability_id": MCP_CAPABILITY_ID,
                "version": "1.4.0-beta.1+build.7",
                "required": False,
            }
        ],
    }
    resource = make_portable_resource(
        "guides/ENVIRONMENT.md",
        "# 环境基线\n\n只包含可公开给同事的配置说明。\n",
    )
    raw = export_expert_package(
        expert.id,
        avatar_registry=source,
        artifact_id="expert:environment-config",
        release_version="2.3.0-rc.1+desktop.5",
        recommended_permission_mode="plan",
        dependencies=dependencies,
        resources=[resource],
        workspace_slots=[
            {"name": "project_root", "access": "read-only", "required": True}
        ],
    )
    document = json.loads(raw)
    assert document["artifact_id"] == "expert:environment-config"
    assert document["release_version"] == "2.3.0-rc.1+desktop.5"
    assert document["dependencies"] == dependencies
    assert document["resources"] == [resource]

    preview = preview_portable_package(raw)
    assert preview.recommended_permission_mode == "plan"
    assert preview.skill_dependencies == (SKILL_CAPABILITY_ID,)
    assert preview.mcp_dependencies == (MCP_CAPABILITY_ID,)
    assert preview.resource_paths == ("guides/ENVIRONMENT.md",)
    assert preview.workspace_slots == ("project_root",)

    destination = AvatarRegistry(root=tmp_path / "destination-avatars")
    result = import_portable_package(raw, avatar_registry=destination)
    assert result.expert is not None
    workspace = Path(result.expert.workspace_dir)
    assert (
        workspace / "package_resources" / "guides" / "ENVIRONMENT.md"
    ).read_text(encoding="utf-8") == resource["content"]
    assert "环境基线" not in (workspace / "MEMORY.md").read_text(encoding="utf-8")
    metadata = json.loads(
        (workspace / ".agenticx-package.json").read_text(encoding="utf-8")
    )
    assert metadata["artifact_id"] == "expert:environment-config"
    assert metadata["release_version"] == "2.3.0-rc.1+desktop.5"
    # Declarations never grant capabilities or the recommended runtime mode.
    assert result.expert.skills_enabled is None
    assert result.expert.tools_enabled == {}


@pytest.mark.parametrize(
    ("mutate", "message"),
    [
        (
            lambda doc: doc["dependencies"]["mcps"].append(
                {
                    "capability_id": MCP_CAPABILITY_ID,
                    "version": "1.0.0",
                    "required": True,
                    "headers": {"Authorization": "secret"},
                }
            ),
            "unknown field",
        ),
        (
            lambda doc: doc["dependencies"]["skills"].append(
                {
                    "capability_id": SKILL_CAPABILITY_ID,
                    "version": "01.0.0",
                    "digest": "a" * 64,
                    "required": True,
                }
            ),
            "SemVer",
        ),
        (
            lambda doc: doc["workspace_slots"].append(
                {"name": "/private/path", "access": "read-write", "required": True}
            ),
            "logical workspace slot",
        ),
    ],
)
def test_dependency_and_workspace_declarations_are_reference_only(
    mutate, message: str
) -> None:
    document = _expert_envelope()
    mutate(document)
    with pytest.raises(PortablePackageError, match=message):
        preview_portable_package(_dump(document))


def test_artifact_identifier_cannot_hide_api_keys() -> None:
    document = _expert_envelope()
    document["artifact_id"] = "expert:sk-proj-abcdefghijklmnopqrstuvwxyz012345"
    with pytest.raises(PortablePackageSecurityError, match="openai_api_key"):
        preview_portable_package(_dump(document))


def test_uuid_artifact_identifier_is_not_reported_as_payment_card() -> None:
    document = _expert_envelope()
    document["artifact_id"] = "expert:fa772152-5755-4297-be31-c5ba1a6c18f7"

    report = scan_portable_package(_dump(document))

    assert not any(
        finding.rule_id == "pii.payment_card" for finding in report.findings
    )


@pytest.mark.parametrize(
    "capability_id",
    [
        "skill:environment-audit",
        "skill:01arz3ndektsv4rrffq69g5fav",
        "mcp:internal-docs",
    ],
)
def test_dependency_ids_require_canonical_enterprise_ulids(
    capability_id: str,
) -> None:
    document = _expert_envelope()
    kind = capability_id.split(":", 1)[0]
    dependency = {
        "capability_id": capability_id,
        "version": "1.0.0",
        "required": True,
    }
    if kind == "skill":
        dependency["digest"] = "a" * 64
        document["dependencies"]["skills"].append(dependency)
    else:
        document["dependencies"]["mcps"].append(dependency)
    with pytest.raises(PortablePackageError, match="canonical .*<ULID>"):
        preview_portable_package(_dump(document))


def test_markdown_resources_are_digest_bound_relative_and_bounded() -> None:
    document = _expert_envelope()
    resource = make_portable_resource("docs/README.md", "safe")
    document["resources"] = [resource]

    damaged = json.loads(_dump(document))
    damaged["resources"][0]["content"] = "changed"
    with pytest.raises(PortablePackageError, match="does not match content"):
        preview_portable_package(_dump(damaged))

    traversal = json.loads(_dump(document))
    traversal["resources"][0]["path"] = "../MEMORY.md"
    with pytest.raises(PortablePackageError, match="safe relative"):
        preview_portable_package(_dump(traversal))

    duplicate_target = json.loads(_dump(document))
    noncanonical = make_portable_resource("docs/a/b2.md", "second")
    noncanonical["path"] = "docs/a//b.md"
    duplicate_target["resources"] = [
        make_portable_resource("docs/a/b.md", "first"),
        noncanonical,
    ]
    with pytest.raises(PortablePackageError, match="canonical POSIX path"):
        preview_portable_package(_dump(duplicate_target))

    unicode_alias = json.loads(_dump(document))
    unicode_alias["resources"] = [
        make_portable_resource("docs/caf\u00e9.md", "first"),
        {
            "path": "docs/cafe\u0301.md",
            "content": "second",
            "digest": hashlib.sha256(b"second").hexdigest(),
        },
    ]
    with pytest.raises(PortablePackageError, match="Unicode NFC normalization"):
        preview_portable_package(_dump(unicode_alias))

    wrong_type = json.loads(_dump(document))
    wrong_type["resources"][0]["path"] = "payload.txt"
    with pytest.raises(PortablePackageError, match="Markdown"):
        preview_portable_package(_dump(wrong_type))

    with pytest.raises(PortablePackageError, match="byte limit"):
        make_portable_resource("large.md", "x" * (MAX_RESOURCE_BYTES + 1))


def test_import_re_scans_and_blocks_before_creating_any_entity(tmp_path: Path) -> None:
    document = _expert_envelope()
    document["resources"] = [
        make_portable_resource(
            "notes.md",
            "credential: sk-proj-abcdefghijklmnopqrstuvwxyz012345",
        )
    ]
    destination = AvatarRegistry(root=tmp_path / "destination-avatars")
    with pytest.raises(PortablePackageSecurityError, match="openai_api_key"):
        import_portable_package(_dump(document), avatar_registry=destination)
    assert destination.list_avatars() == []


@pytest.mark.parametrize(
    "mutate",
    [
        lambda doc: doc.update({"author": "unexpected"}),
        lambda doc: doc["payload"].update({"workspace_dir": "/tmp/private"}),
        lambda doc: doc["payload"].update({"default_model": "private"}),
        lambda doc: doc["payload"].update({"skills_enabled": {"x": True}}),
        lambda doc: doc["payload"].update({"mcp": {"servers": []}}),
    ],
)
def test_unknown_or_runtime_fields_are_rejected(mutate) -> None:
    document = _expert_envelope()
    mutate(document)
    with pytest.raises(PortablePackageError, match="unknown field"):
        preview_portable_package(_dump(document))


def test_strict_json_rejects_duplicate_keys_constants_versions_and_oversize() -> None:
    duplicate = (
        '{"schema_version":2,"schema_version":2,"kind":"expert",'
        '"title":"x","description":"","payload":{"name":"x"}}'
    )
    with pytest.raises(PortablePackageError, match="duplicate JSON key"):
        preview_portable_package(duplicate)

    non_standard = _dump(_expert_envelope()).replace(
        '"schema_version":2', '"schema_version":NaN', 1
    )
    with pytest.raises(PortablePackageError, match="non-standard JSON constant"):
        preview_portable_package(non_standard)

    wrong_version = _expert_envelope()
    wrong_version["schema_version"] = 1
    with pytest.raises(PortablePackageError, match="schema_version"):
        preview_portable_package(_dump(wrong_version))

    for malformed_kind in ([], {}):
        malformed = _expert_envelope()
        malformed["kind"] = malformed_kind
        with pytest.raises(PortablePackageError, match="kind must be"):
            preview_portable_package(_dump(malformed))

    with pytest.raises(PortablePackageError, match="byte limit"):
        preview_portable_package(" " * (MAX_PACKAGE_BYTES + 1))


def test_declared_limits_and_cross_field_consistency_are_enforced() -> None:
    too_many_tags = _expert_envelope()
    too_many_tags["payload"]["tags"] = [f"t{i}" for i in range(9)]
    with pytest.raises(PortablePackageError, match="tag limit"):
        preview_portable_package(_dump(too_many_tags))

    mismatched_title = _expert_envelope()
    mismatched_title["title"] = "误导标题"
    with pytest.raises(PortablePackageError, match="must match payload.name"):
        preview_portable_package(_dump(mismatched_title))

    mismatched_description = _expert_envelope()
    mismatched_description["description"] = "误导简介"
    with pytest.raises(PortablePackageError, match="must match payload.description"):
        preview_portable_package(_dump(mismatched_description))

    too_many_members = _group_envelope(MAX_GROUP_MEMBERS + 1)
    with pytest.raises(PortablePackageError, match="member limit"):
        preview_portable_package(_dump(too_many_members))

    bad_host = _group_envelope(2)
    bad_host["payload"]["host_member_index"] = 2
    with pytest.raises(PortablePackageError, match="existing member"):
        preview_portable_package(_dump(bad_host))


@pytest.mark.parametrize(
    ("field", "value", "message"),
    [
        ("name", "可信专家\n确认导入", "single line"),
        ("name", "可信专家\u2028确认导入", "single line"),
        ("role", "审核员\x1b[2J", "control characters"),
        ("name", "财务\u202eexe.json", "direction controls"),
    ],
)
def test_identity_fields_reject_confirmation_ui_spoofing(
    field: str,
    value: str,
    message: str,
) -> None:
    document = _expert_envelope()
    document["payload"][field] = value
    if field == "name":
        document["title"] = value
    with pytest.raises(PortablePackageError, match=message):
        preview_portable_package(_dump(document))


def test_lone_unicode_surrogate_is_rejected_after_json_unescape() -> None:
    document = _expert_envelope()
    document["payload"]["system_prompt"] = "unsafe-\ud800-tail"
    # Default ensure_ascii=True keeps the transport itself valid; the strict parser must
    # reject the surrogate after JSON unescaping instead of persisting it in the registry.
    with pytest.raises(PortablePackageError, match="surrogate"):
        preview_portable_package(json.dumps(document, separators=(",", ":")))


def test_export_rejects_unsafe_registry_ids_before_path_lookup(tmp_path: Path) -> None:
    avatars = AvatarRegistry(root=tmp_path / "avatars")
    groups = GroupChatRegistry(root=tmp_path / "groups")

    with pytest.raises(PortablePackageError, match="expert not found"):
        export_expert_package("../../outside", avatar_registry=avatars)
    with pytest.raises(PortablePackageError, match="group not found"):
        export_group_package(
            "../outside",
            avatar_registry=avatars,
            group_registry=groups,
        )

    damaged_group = groups.create_group(
        name="损坏群聊",
        avatar_ids=["../outside"],
    )
    with pytest.raises(PortablePackageError, match="group member not found"):
        export_group_package(
            damaged_group.id,
            avatar_registry=avatars,
            group_registry=groups,
        )


def test_group_round_trip_recreates_members_and_remaps_host(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # GroupChatRegistry delegates workspace setup to the normal home root.  It
    # is orthogonal to this serializer test, so keep source/destination roots
    # explicit and make the workspace hook side-effect free here.
    monkeypatch.setattr(
        "agenticx.workspace.loader.ensure_group_workspace",
        lambda *args, **kwargs: tmp_path / "group-workspace",
    )
    source_avatars = AvatarRegistry(root=tmp_path / "source-avatars")
    lead = source_avatars.create_avatar(
        name="方案专家",
        role="方案负责人",
        system_prompt="负责整合。",
        default_model="must-not-travel",
    )
    reviewer = source_avatars.create_avatar(
        name="审核专家",
        role="质量审核",
        system_prompt="独立审核。",
        tools_enabled={"shell": True},
    )
    source_groups = GroupChatRegistry(root=tmp_path / "source-groups")
    source_group = source_groups.create_group(
        name="交付小组",
        avatar_ids=[lead.id, reviewer.id],
        routing="team",
        host_avatar_id=reviewer.id,
        description="一起把需求交付到可复核结果。",
        avatar_url="data:image/png;base64,AA==",
    )

    raw = export_group_package(
        source_group.id,
        avatar_registry=source_avatars,
        group_registry=source_groups,
    )
    document = json.loads(raw)
    assert document["description"] == "一起把需求交付到可复核结果。"
    # Custom local portraits stay local; the portable package uses the stable
    # generated group identity as its safe fallback instead of copying image bytes.
    assert "data:image/png;base64,AA==" not in raw
    assert document["payload"]["host_member_index"] == 1
    assert document["payload"]["routing"] == "team"
    assert lead.id not in raw
    assert reviewer.id not in raw
    assert "must-not-travel" not in raw

    destination_avatars = AvatarRegistry(root=tmp_path / "destination-avatars")
    destination_avatars.create_avatar(name="方案专家")
    destination_groups = GroupChatRegistry(root=tmp_path / "destination-groups")
    destination_groups.create_group(
        name="交付小组",
        avatar_ids=[destination_avatars.list_avatars()[0].id],
    )
    result = import_portable_package(
        raw,
        avatar_registry=destination_avatars,
        group_registry=destination_groups,
    )

    assert result.kind == "group"
    assert result.group is not None
    assert result.group.name == "交付小组（导入）"
    assert result.group.description == "一起把需求交付到可复核结果。"
    assert result.group.avatar_url == ""
    assert result.group.routing == "team"
    assert len(result.members) == 2
    assert result.members[0].name == "方案专家（导入）"
    assert result.members[1].name == "审核专家"
    assert result.group.avatar_ids == [member.id for member in result.members]
    assert result.group.host_avatar_id == result.members[1].id
    assert all(member.id not in {lead.id, reviewer.id} for member in result.members)
    assert all(member.default_model == "" for member in result.members)
    assert all(member.tools_enabled == {} for member in result.members)
    assert result.preview.member_names == ("方案专家", "审核专家")
    assert result.preview.host_member_name == "审核专家"
    assert result.created_avatar_ids == tuple(member.id for member in result.members)


def test_group_member_failure_rolls_back_only_returned_members_and_keeps_other_work(
    tmp_path: Path,
) -> None:
    class FailingAvatarRegistry(AvatarRegistry):
        calls = 0

        def create_avatar(self, name: str, role: str = "", **kwargs):
            self.calls += 1
            if self.calls == 2:
                # Simulate unrelated work landing while this import is active.
                super().create_avatar(name="并发新增专家")
                raise RuntimeError("second member failed")
            return super().create_avatar(name=name, role=role, **kwargs)

    avatars = FailingAvatarRegistry(root=tmp_path / "avatars")
    existing = AvatarRegistry.create_avatar(avatars, name="原有专家")
    groups = GroupChatRegistry(root=tmp_path / "groups")

    with pytest.raises(PortablePackageImportError, match="second member failed"):
        import_portable_package(
            _dump(_group_envelope(2)),
            avatar_registry=avatars,
            group_registry=groups,
        )

    remaining = {avatar.name: avatar.id for avatar in avatars.list_avatars()}
    assert remaining == {
        "原有专家": existing.id,
        "并发新增专家": remaining["并发新增专家"],
    }
    assert groups.list_groups() == []


def test_group_creation_failure_rolls_back_members_but_preserves_existing_group(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    avatars = AvatarRegistry(root=tmp_path / "avatars")
    existing_avatar = avatars.create_avatar(name="原有成员")
    groups = GroupChatRegistry(root=tmp_path / "groups")
    monkeypatch.setattr(
        "agenticx.workspace.loader.ensure_group_workspace",
        lambda *args, **kwargs: tmp_path / "workspace",
    )
    existing_group = groups.create_group(
        name="原有群聊",
        avatar_ids=[existing_avatar.id],
    )

    def fail_workspace(*args, **kwargs):
        raise RuntimeError("workspace bootstrap failed")

    monkeypatch.setattr(
        "agenticx.workspace.loader.ensure_group_workspace",
        fail_workspace,
    )
    with pytest.raises(PortablePackageImportError, match="workspace bootstrap failed"):
        import_portable_package(
            _dump(_group_envelope(2)),
            avatar_registry=avatars,
            group_registry=groups,
        )

    assert [(avatar.id, avatar.name) for avatar in avatars.list_avatars()] == [
        (existing_avatar.id, "原有成员")
    ]
    assert [(group.id, group.name) for group in groups.list_groups()] == [
        (existing_group.id, "原有群聊")
    ]
