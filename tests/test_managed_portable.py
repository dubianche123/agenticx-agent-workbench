#!/usr/bin/env python3
"""Enterprise desired-state coverage for portable experts/project groups."""

from __future__ import annotations

import hashlib
import json
import stat
from pathlib import Path
from typing import Any

import pytest

import agenticx.avatar.managed_portable as managed_portable_module
from agenticx.avatar.group_chat import GroupChatRegistry
from agenticx.avatar.managed_portable import (
    MANAGED_CREATED_BY,
    MAX_MANAGED_PACKAGES,
    MAX_MANAGED_REQUEST_BYTES,
    ManagedPortableLedgerError,
    ManagedPortableRequestError,
    reconcile_managed_portable_packages,
)
from agenticx.avatar.portable_package import MAX_PACKAGE_BYTES
from agenticx.avatar.registry import AvatarRegistry


EXPERT_CAPABILITY_ID = "expert:01ARZ3NDEKTSV4RRFFQ69G5FAV"
GROUP_CAPABILITY_ID = "group:01ARZ3NDEKTSV4RRFFQ69G5FAW"


def _declaration(name: str, *, prompt: str = "先核对事实。") -> dict[str, Any]:
    return {
        "name": name,
        "role": "分析师",
        "description": "负责给出可复核的结论。",
        "tags": ["分析"],
        "system_prompt": prompt,
        "color": "blue",
        "default_permission_mode": "ask",
    }


def _expert_raw(name: str = "企业分析专家", *, prompt: str = "先核对事实。") -> str:
    declaration = _declaration(name, prompt=prompt)
    return json.dumps(
        {
            "schema_version": 2,
            "artifact_id": EXPERT_CAPABILITY_ID,
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


def _group_raw(*, prompt: str = "复核实现。") -> str:
    return json.dumps(
        {
            "schema_version": 2,
            "artifact_id": GROUP_CAPABILITY_ID,
            "release_version": "1.0.0",
            "kind": "group",
            "title": "企业交付组",
            "description": "受管项目协作组。",
            "recommended_permission_mode": "ask",
            "dependencies": {"skills": [], "mcps": []},
            "resources": [],
            "workspace_slots": [],
            "payload": {
                "name": "企业交付组",
                "members": [
                    _declaration("实现专家", prompt="负责实现。"),
                    _declaration("复核专家", prompt=prompt),
                ],
                "host_member_index": 1,
                "routing": "team",
            },
        },
        ensure_ascii=False,
        separators=(",", ":"),
    )


def _package(capability_id: str, raw: str) -> dict[str, str]:
    return {
        "id": capability_id,
        "digest": hashlib.sha256(raw.encode("utf-8")).hexdigest(),
        "raw": raw,
    }


def _with_resource(
    raw: str,
    *,
    release_version: str,
    path: str,
    content: str,
) -> str:
    document = json.loads(raw)
    document["release_version"] = release_version
    document["resources"] = [
        {
            "path": path,
            "content": content,
            "digest": hashlib.sha256(content.encode("utf-8")).hexdigest(),
        }
    ]
    return json.dumps(document, ensure_ascii=False, separators=(",", ":"))


def _registries(tmp_path: Path) -> tuple[AvatarRegistry, GroupChatRegistry, Path]:
    return (
        AvatarRegistry(root=tmp_path / "avatars"),
        GroupChatRegistry(root=tmp_path / "groups"),
        tmp_path / "enterprise" / "managed-portable-packages.json",
    )


def test_managed_http_limit_covers_worst_case_json_string_escaping() -> None:
    # Desktop wraps every raw package in JSON once more. Quotes/backslashes can
    # double on the wire, so the aggregate transport cap must not contradict
    # the documented 64 x 256 KiB desired-state limits.
    minimum_wrapper_bytes = MAX_MANAGED_PACKAGES * (MAX_PACKAGE_BYTES * 2)
    assert MAX_MANAGED_REQUEST_BYTES > minimum_wrapper_bytes


def test_managed_expert_is_idempotent_preserves_name_and_withdraws_only_owned(
    tmp_path: Path,
) -> None:
    avatars, groups, ledger = _registries(tmp_path)
    manual = avatars.create_avatar(name="企业分析专家", created_by="manual")
    package = _package(EXPERT_CAPABILITY_ID, _expert_raw())

    first = reconcile_managed_portable_packages(
        [package],
        avatar_registry=avatars,
        group_registry=groups,
        ledger_path=ledger,
    )
    assert first.ok
    assert first.installed == [EXPERT_CAPABILITY_ID]
    managed_id = first.to_dict()["managed"][0]["avatar_ids"][0]
    managed = avatars.get_avatar(managed_id)
    assert managed is not None
    assert managed.name == "企业分析专家"  # managed installs do not add （导入）
    assert managed.created_by == MANAGED_CREATED_BY
    assert managed.managed_capability_id == EXPERT_CAPABILITY_ID
    assert managed.managed_digest == package["digest"]
    assert managed.default_provider == ""
    assert managed.default_model == ""
    assert managed.tools_enabled == {}
    assert managed.skills_enabled is None
    assert managed.brains_enabled is None
    assert stat.S_IMODE(ledger.stat().st_mode) == 0o600

    second = reconcile_managed_portable_packages(
        [package],
        avatar_registry=avatars,
        group_registry=groups,
        ledger_path=ledger,
    )
    assert second.ok
    assert second.unchanged == [EXPERT_CAPABILITY_ID]
    assert second.to_dict()["managed"][0]["avatar_ids"] == [managed_id]
    assert len(avatars.list_avatars()) == 2

    removed = reconcile_managed_portable_packages(
        [],
        avatar_registry=avatars,
        group_registry=groups,
        ledger_path=ledger,
    )
    assert removed.ok
    assert removed.removed == [EXPERT_CAPABILITY_ID]
    assert avatars.get_avatar(managed_id) is None
    assert avatars.get_avatar(manual.id) is not None
    assert removed.to_dict()["managed"] == []


def test_managed_group_updates_in_place_and_preserves_local_workspaces(
    tmp_path: Path,
) -> None:
    avatars, groups, ledger = _registries(tmp_path)
    first_package = _package(GROUP_CAPABILITY_ID, _group_raw())
    first = reconcile_managed_portable_packages(
        [first_package],
        avatar_registry=avatars,
        group_registry=groups,
        ledger_path=ledger,
    )
    assert first.ok
    first_managed = first.to_dict()["managed"][0]
    first_group_id = first_managed["group_id"]
    first_member_ids = first_managed["avatar_ids"]
    group = groups.get_group(first_group_id)
    assert group is not None
    assert group.created_by == MANAGED_CREATED_BY
    assert group.managed_capability_id == GROUP_CAPABILITY_ID
    assert group.avatar_ids == first_member_ids
    assert group.host_avatar_id == first_member_ids[1]
    assert group.routing == "team"
    assert [avatars.get_avatar(item).name for item in first_member_ids] == [
        "实现专家",
        "复核专家",
    ]
    group_memory = Path(group.workspace_dir) / "MEMORY.md"
    reviewer_before = avatars.get_avatar(first_member_ids[1])
    assert reviewer_before is not None
    reviewer_memory = Path(reviewer_before.workspace_dir) / "MEMORY.md"
    group_memory.write_text("本地群协作记忆", encoding="utf-8")
    reviewer_memory.write_text("本地专家记忆", encoding="utf-8")

    updated_package = _package(GROUP_CAPABILITY_ID, _group_raw(prompt="先找出阻断问题。"))
    updated = reconcile_managed_portable_packages(
        [updated_package],
        avatar_registry=avatars,
        group_registry=groups,
        ledger_path=ledger,
    )
    assert updated.ok
    assert updated.updated == [GROUP_CAPABILITY_ID]
    current = updated.to_dict()["managed"][0]
    assert current["group_id"] == first_group_id
    assert current["avatar_ids"] == first_member_ids
    current_group = groups.get_group(current["group_id"])
    assert current_group is not None
    assert current_group.host_avatar_id == current["avatar_ids"][1]
    assert current_group.routing == "team"
    reviewer = avatars.get_avatar(current["avatar_ids"][1])
    assert reviewer is not None
    assert reviewer.system_prompt == "先找出阻断问题。"
    assert group_memory.read_text(encoding="utf-8") == "本地群协作记忆"
    assert reviewer_memory.read_text(encoding="utf-8") == "本地专家记忆"


def test_managed_expert_installs_updates_and_repairs_package_baseline(
    tmp_path: Path,
) -> None:
    avatars, groups, ledger = _registries(tmp_path)
    first_raw = _with_resource(
        _expert_raw(),
        release_version="1.0.0",
        path="guides/BASELINE.md",
        content="第一版企业基线",
    )
    first = reconcile_managed_portable_packages(
        [_package(EXPERT_CAPABILITY_ID, first_raw)],
        avatar_registry=avatars,
        group_registry=groups,
        ledger_path=ledger,
    )
    managed_id = first.to_dict()["managed"][0]["avatar_ids"][0]
    managed = avatars.get_avatar(managed_id)
    assert managed is not None
    workspace = Path(managed.workspace_dir)
    resource = workspace / "package_resources" / "guides" / "BASELINE.md"
    memory = workspace / "MEMORY.md"
    memory.write_text("员工本地记忆", encoding="utf-8")
    assert resource.read_text(encoding="utf-8") == "第一版企业基线"

    second_raw = _with_resource(
        _expert_raw(prompt="使用第二版基线。"),
        release_version="1.1.0",
        path="guides/BASELINE.md",
        content="第二版企业基线",
    )
    second = reconcile_managed_portable_packages(
        [_package(EXPERT_CAPABILITY_ID, second_raw)],
        avatar_registry=avatars,
        group_registry=groups,
        ledger_path=ledger,
    )
    assert second.ok
    assert second.updated == [EXPERT_CAPABILITY_ID]
    assert second.to_dict()["managed"][0]["avatar_ids"] == [managed_id]
    assert resource.read_text(encoding="utf-8") == "第二版企业基线"
    assert memory.read_text(encoding="utf-8") == "员工本地记忆"

    resource.write_text("本地篡改", encoding="utf-8")
    repaired = reconcile_managed_portable_packages(
        [_package(EXPERT_CAPABILITY_ID, second_raw)],
        avatar_registry=avatars,
        group_registry=groups,
        ledger_path=ledger,
    )
    assert repaired.ok
    assert repaired.updated == [EXPERT_CAPABILITY_ID]
    assert resource.read_text(encoding="utf-8") == "第二版企业基线"

    (workspace / ".agenticx-package.json").write_text(
        '{"dependencies":' + ("[" * 1100) + "0" + ("]" * 1100) + "}",
        encoding="utf-8",
    )
    metadata_repaired = reconcile_managed_portable_packages(
        [_package(EXPERT_CAPABILITY_ID, second_raw)],
        avatar_registry=avatars,
        group_registry=groups,
        ledger_path=ledger,
    )
    assert metadata_repaired.ok
    assert metadata_repaired.updated == [EXPERT_CAPABILITY_ID]
    metadata = json.loads(
        (workspace / ".agenticx-package.json").read_text(encoding="utf-8")
    )
    assert metadata["release_version"] == "1.1.0"


def test_managed_group_structural_release_rotates_generation_safely(
    tmp_path: Path,
) -> None:
    avatars, groups, ledger = _registries(tmp_path)
    installed = reconcile_managed_portable_packages(
        [_package(GROUP_CAPABILITY_ID, _group_raw())],
        avatar_registry=avatars,
        group_registry=groups,
        ledger_path=ledger,
    )
    first = installed.to_dict()["managed"][0]
    group_id = first["group_id"]
    original_ids = first["avatar_ids"]
    first_member = avatars.get_avatar(original_ids[0])
    assert first_member is not None
    first_memory = Path(first_member.workspace_dir) / "MEMORY.md"
    first_memory.write_text("必须保留的本地记忆", encoding="utf-8")

    expanded_document = json.loads(_group_raw())
    expanded_document["release_version"] = "1.1.0"
    expanded_document["payload"]["members"].append(
        _declaration("发布协调专家", prompt="协调发布。")
    )
    expanded_raw = json.dumps(
        expanded_document,
        ensure_ascii=False,
        separators=(",", ":"),
    )
    expanded = reconcile_managed_portable_packages(
        [_package(GROUP_CAPABILITY_ID, expanded_raw)],
        avatar_registry=avatars,
        group_registry=groups,
        ledger_path=ledger,
    )
    expanded_managed = expanded.to_dict()["managed"][0]
    assert expanded.ok
    assert expanded.updated == [GROUP_CAPABILITY_ID]
    assert expanded_managed["group_id"] != group_id
    assert set(expanded_managed["avatar_ids"]).isdisjoint(original_ids)
    assert len(expanded_managed["avatar_ids"]) == 3
    assert groups.get_group(group_id) is None
    assert all(avatars.get_avatar(avatar_id) is None for avatar_id in original_ids)
    current_group = groups.get_group(expanded_managed["group_id"])
    assert current_group is not None
    assert current_group.avatar_ids == expanded_managed["avatar_ids"]
    assert not first_memory.exists()


def test_failed_update_keeps_last_known_good_generation(tmp_path: Path) -> None:
    class FailingRegistry(AvatarRegistry):
        fail_name = "会失败的新版本"

        def _write_config(self, config):
            if config.name == self.fail_name:
                raise OSError("simulated update failure")
            return super()._write_config(config)

    avatars = FailingRegistry(root=tmp_path / "avatars")
    groups = GroupChatRegistry(root=tmp_path / "groups")
    ledger = tmp_path / "managed.json"
    original = _package(EXPERT_CAPABILITY_ID, _expert_raw("稳定版本"))
    installed = reconcile_managed_portable_packages(
        [original],
        avatar_registry=avatars,
        group_registry=groups,
        ledger_path=ledger,
    )
    original_id = installed.to_dict()["managed"][0]["avatar_ids"][0]

    failing = _package(EXPERT_CAPABILITY_ID, _expert_raw("会失败的新版本"))
    result = reconcile_managed_portable_packages(
        [failing],
        avatar_registry=avatars,
        group_registry=groups,
        ledger_path=ledger,
    )
    assert not result.ok
    assert result.updated == []
    assert avatars.get_avatar(original_id) is not None
    assert avatars.get_avatar(original_id).name == "稳定版本"
    managed = result.to_dict()["managed"][0]
    assert managed["digest"] == original["digest"]
    assert managed["avatar_ids"] == [original_id]
    assert len(avatars.list_avatars()) == 1


def test_update_transition_ledger_failure_rolls_back_new_copy_and_keeps_old(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    avatars, groups, ledger = _registries(tmp_path)
    original = _package(EXPERT_CAPABILITY_ID, _expert_raw("稳定版本"))
    installed = reconcile_managed_portable_packages(
        [original],
        avatar_registry=avatars,
        group_registry=groups,
        ledger_path=ledger,
    )
    original_id = installed.to_dict()["managed"][0]["avatar_ids"][0]
    workspace = Path(avatars.get_avatar(original_id).workspace_dir)

    def fail_write(_path, _entries) -> None:
        raise ManagedPortableLedgerError("simulated ledger failure")

    monkeypatch.setattr(managed_portable_module, "_write_ledger", fail_write)
    updated_raw = _with_resource(
        _expert_raw("新版本"),
        release_version="2.0.0",
        path="NEW.md",
        content="不得在失败后残留",
    )
    result = reconcile_managed_portable_packages(
        [_package(EXPERT_CAPABILITY_ID, updated_raw)],
        avatar_registry=avatars,
        group_registry=groups,
        ledger_path=ledger,
    )
    assert not result.ok
    assert "simulated ledger failure" in result.errors[0].message
    assert result.updated == []
    assert avatars.get_avatar(original_id) is not None
    metadata = json.loads(
        (workspace / ".agenticx-package.json").read_text(encoding="utf-8")
    )
    assert metadata["release_version"] == "1.0.0"
    assert not (workspace / "package_resources" / "NEW.md").exists()
    assert [item.id for item in avatars.list_avatars()] == [original_id]


def test_structural_group_ledger_failure_removes_replacement_and_keeps_old(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    avatars, groups, ledger = _registries(tmp_path)
    installed = reconcile_managed_portable_packages(
        [_package(GROUP_CAPABILITY_ID, _group_raw())],
        avatar_registry=avatars,
        group_registry=groups,
        ledger_path=ledger,
    )
    original = installed.to_dict()["managed"][0]
    expanded = json.loads(_group_raw())
    expanded["release_version"] = "1.1.0"
    expanded["payload"]["members"].append(_declaration("新增专家"))
    expanded_raw = json.dumps(expanded, ensure_ascii=False, separators=(",", ":"))

    def fail_write(_path, _entries) -> None:
        raise ManagedPortableLedgerError("simulated structural ledger failure")

    monkeypatch.setattr(managed_portable_module, "_write_ledger", fail_write)
    result = reconcile_managed_portable_packages(
        [_package(GROUP_CAPABILITY_ID, expanded_raw)],
        avatar_registry=avatars,
        group_registry=groups,
        ledger_path=ledger,
    )
    assert not result.ok
    assert result.updated == []
    assert groups.get_group(original["group_id"]) is not None
    assert {avatar.id for avatar in avatars.list_avatars()} == set(original["avatar_ids"])
    assert result.to_dict()["managed"][0]["group_id"] == original["group_id"]


@pytest.mark.parametrize("created_by", ["manual", "portable_import"])
def test_forged_ledger_never_deletes_unowned_expert(
    tmp_path: Path,
    created_by: str,
) -> None:
    avatars, groups, ledger = _registries(tmp_path)
    unowned = avatars.create_avatar(name="不能误删", created_by=created_by)
    digest = "a" * 64
    ledger.parent.mkdir(parents=True, exist_ok=True)
    ledger.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "packages": {
                    EXPERT_CAPABILITY_ID: {
                        "kind": "expert",
                        "active": {
                            "digest": digest,
                            "avatar_ids": [unowned.id],
                            "group_id": "",
                        },
                        "stale": [],
                    }
                },
            }
        ),
        encoding="utf-8",
    )

    result = reconcile_managed_portable_packages(
        [],
        avatar_registry=avatars,
        group_registry=groups,
        ledger_path=ledger,
    )
    assert not result.ok
    assert "refused to delete unowned expert" in result.errors[0].message
    assert avatars.get_avatar(unowned.id) is not None
    assert result.removed == [EXPERT_CAPABILITY_ID]


def test_group_withdrawal_deletes_group_before_its_members(tmp_path: Path) -> None:
    events: list[str] = []

    class RecordingAvatars(AvatarRegistry):
        def delete_avatar(self, avatar_id: str) -> bool:
            events.append(f"avatar:{avatar_id}")
            return super().delete_avatar(avatar_id)

    class RecordingGroups(GroupChatRegistry):
        def delete_group(self, group_id: str) -> bool:
            events.append(f"group:{group_id}")
            return super().delete_group(group_id)

    avatars = RecordingAvatars(root=tmp_path / "avatars")
    groups = RecordingGroups(root=tmp_path / "groups")
    ledger = tmp_path / "managed.json"
    reconcile_managed_portable_packages(
        [_package(GROUP_CAPABILITY_ID, _group_raw())],
        avatar_registry=avatars,
        group_registry=groups,
        ledger_path=ledger,
    )
    events.clear()

    result = reconcile_managed_portable_packages(
        [],
        avatar_registry=avatars,
        group_registry=groups,
        ledger_path=ledger,
    )
    assert result.ok
    assert events[0].startswith("group:")
    assert all(item.startswith("avatar:") for item in events[1:])


@pytest.mark.parametrize(
    "mutate, match",
    [
        (lambda item: item.update({"id": "expert:not-a-ulid"}), "expert:<ULID>"),
        (lambda item: item.update({"digest": "0" * 64}), "does not match raw"),
        (lambda item: item.update({"extra": True}), "contain exactly"),
    ],
)
def test_invalid_desired_state_is_rejected_before_withdrawal(
    tmp_path: Path,
    mutate,
    match: str,
) -> None:
    avatars, groups, ledger = _registries(tmp_path)
    valid = _package(EXPERT_CAPABILITY_ID, _expert_raw())
    installed = reconcile_managed_portable_packages(
        [valid],
        avatar_registry=avatars,
        group_registry=groups,
        ledger_path=ledger,
    )
    installed_id = installed.to_dict()["managed"][0]["avatar_ids"][0]
    invalid = dict(valid)
    mutate(invalid)

    with pytest.raises(ManagedPortableRequestError, match=match):
        reconcile_managed_portable_packages(
            [invalid],
            avatar_registry=avatars,
            group_registry=groups,
            ledger_path=ledger,
        )
    assert avatars.get_avatar(installed_id) is not None


def test_package_byte_limit_and_id_kind_mismatch_are_rejected(tmp_path: Path) -> None:
    avatars, groups, ledger = _registries(tmp_path)
    oversized_raw = "x" * (MAX_PACKAGE_BYTES + 1)
    with pytest.raises(ManagedPortableRequestError, match="byte limit"):
        reconcile_managed_portable_packages(
            [_package(EXPERT_CAPABILITY_ID, oversized_raw)],
            avatar_registry=avatars,
            group_registry=groups,
            ledger_path=ledger,
        )

    expert_raw = _expert_raw()
    with pytest.raises(ManagedPortableRequestError, match="id kind"):
        reconcile_managed_portable_packages(
            [_package(GROUP_CAPABILITY_ID, expert_raw)],
            avatar_registry=avatars,
            group_registry=groups,
            ledger_path=ledger,
        )
