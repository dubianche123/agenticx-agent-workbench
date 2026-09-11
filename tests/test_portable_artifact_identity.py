from __future__ import annotations

import uuid

from agenticx.avatar.group_chat import GroupChatRegistry
from agenticx.avatar.registry import AvatarRegistry


def test_new_expert_and_group_receive_distinct_portable_artifact_ids(tmp_path):
    avatars = AvatarRegistry(root=tmp_path / "avatars")
    groups = GroupChatRegistry(root=tmp_path / "groups")

    expert = avatars.create_avatar(name="分析专家")
    group = groups.create_group(
        name="分析团队",
        avatar_ids=[expert.id],
        host_avatar_id=expert.id,
    )

    assert str(uuid.UUID(expert.portable_artifact_id)) == expert.portable_artifact_id
    assert str(uuid.UUID(group.portable_artifact_id)) == group.portable_artifact_id
    assert expert.portable_artifact_id != group.portable_artifact_id
    assert expert.portable_release_version == "1.0.0"
    assert group.portable_release_version == "1.0.0"


def test_existing_entities_receive_one_stable_identity_lazily(tmp_path):
    avatars = AvatarRegistry(root=tmp_path / "avatars")
    groups = GroupChatRegistry(root=tmp_path / "groups")
    expert = avatars.create_avatar(name="研究专家")
    group = groups.create_group(
        name="研究团队",
        avatar_ids=[expert.id],
        host_avatar_id=expert.id,
    )

    expert_config_path = avatars._config_path(expert.id)
    group_config_path = groups._config_path(group.id)
    expert_config_path.write_text(
        expert_config_path.read_text(encoding="utf-8").replace(
            f"portable_artifact_id: {expert.portable_artifact_id}\n",
            "",
        ),
        encoding="utf-8",
    )
    group_config_path.write_text(
        group_config_path.read_text(encoding="utf-8").replace(
            f"portable_artifact_id: {group.portable_artifact_id}\n",
            "",
        ),
        encoding="utf-8",
    )

    repaired_expert = avatars.ensure_portable_identity(expert.id)
    repaired_group = groups.ensure_portable_identity(group.id)
    assert repaired_expert is not None
    assert repaired_group is not None
    first_expert_id = repaired_expert.portable_artifact_id
    first_group_id = repaired_group.portable_artifact_id

    assert avatars.ensure_portable_identity(expert.id).portable_artifact_id == first_expert_id
    assert groups.ensure_portable_identity(group.id).portable_artifact_id == first_group_id


def test_release_version_is_updated_only_by_explicit_release_method(tmp_path):
    avatars = AvatarRegistry(root=tmp_path / "avatars")
    groups = GroupChatRegistry(root=tmp_path / "groups")
    expert = avatars.create_avatar(name="交付专家")
    group = groups.create_group(
        name="交付团队",
        avatar_ids=[expert.id],
        host_avatar_id=expert.id,
    )

    assert avatars.update_avatar(expert.id, {"portable_release_version": "9.9.9"}).portable_release_version == "1.0.0"
    assert groups.update_group(group.id, {"portable_release_version": "9.9.9"}).portable_release_version == "1.0.0"
    assert avatars.set_portable_release_version(expert.id, "1.1.0").portable_release_version == "1.1.0"
    assert groups.set_portable_release_version(group.id, "2.0.0").portable_release_version == "2.0.0"
