"""Security and persistence tests for expert core-memory documents."""

from __future__ import annotations

import os
from pathlib import Path

import pytest

import agenticx.avatar.registry as registry_module
from agenticx.avatar.registry import (
    CORE_MEMORY_MAX_BYTES,
    AvatarCoreMemoryError,
    AvatarRegistry,
)


def test_core_memory_round_trip_is_limited_to_three_documents(tmp_path: Path) -> None:
    registry = AvatarRegistry(root=tmp_path / "avatars")
    avatar = registry.create_avatar(name="核心记忆专家")

    initial = registry.read_core_memory(avatar.id)
    assert set(initial) == {"IDENTITY.md", "SOUL.md", "MEMORY.md"}
    assert "核心记忆专家" in initial["IDENTITY.md"]

    saved = registry.update_core_memory(
        avatar.id,
        {
            "IDENTITY.md": "# 身份\n只做证据核验。\n",
            "SOUL.md": "# 风格\n简洁、明确。\n",
            "MEMORY.md": "# 经验\n保留可复用结论。\n",
        },
    )
    assert saved["SOUL.md"] == "# 风格\n简洁、明确。\n"
    assert registry.read_core_memory(avatar.id) == saved
    assert not (Path(avatar.workspace_dir) / "report.txt").exists()

    with pytest.raises(AvatarCoreMemoryError, match="only IDENTITY.md"):
        registry.update_core_memory(avatar.id, {"report.txt": "不要写入"})


def test_core_memory_rejects_symlinks_and_oversized_files(tmp_path: Path) -> None:
    registry = AvatarRegistry(root=tmp_path / "avatars")
    avatar = registry.create_avatar(name="安全边界专家")
    workspace = Path(avatar.workspace_dir)
    outside = tmp_path / "outside.md"
    outside.write_text("outside", encoding="utf-8")

    soul = workspace / "SOUL.md"
    soul.symlink_to(outside)
    with pytest.raises(AvatarCoreMemoryError, match="SOUL.md.*regular file"):
        registry.read_core_memory(avatar.id)
    with pytest.raises(AvatarCoreMemoryError, match="SOUL.md.*regular file"):
        registry.update_core_memory(avatar.id, {"SOUL.md": "safe"})
    assert outside.read_text(encoding="utf-8") == "outside"

    soul.unlink()
    soul.write_bytes(b"x" * (CORE_MEMORY_MAX_BYTES + 1))
    with pytest.raises(AvatarCoreMemoryError, match="SOUL.md exceeds"):
        registry.read_core_memory(avatar.id)


def test_core_memory_restores_original_after_failed_replacement(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    registry = AvatarRegistry(root=tmp_path / "avatars")
    avatar = registry.create_avatar(name="原子保存专家")
    workspace = Path(avatar.workspace_dir)
    original_identity = (workspace / "IDENTITY.md").read_text(encoding="utf-8")
    original_soul = "原始灵魂\n"
    (workspace / "SOUL.md").write_text(original_soul, encoding="utf-8")

    real_replace = registry_module.os.replace

    def fail_after_backup(source: os.PathLike[str] | str, target: os.PathLike[str] | str) -> None:
        source_path = Path(source)
        target_path = Path(target)
        if (
            source_path.parent.name.startswith(".agenticx-core-stage-")
            and target_path == workspace / "IDENTITY.md"
        ):
            raise OSError("injected staged replacement failure")
        real_replace(source, target)

    monkeypatch.setattr(registry_module.os, "replace", fail_after_backup)
    with pytest.raises(AvatarCoreMemoryError, match="injected staged replacement failure"):
        registry.update_core_memory(
            avatar.id,
            {"IDENTITY.md": "新身份\n", "SOUL.md": "新灵魂\n"},
        )

    assert (workspace / "IDENTITY.md").read_text(encoding="utf-8") == original_identity
    assert (workspace / "SOUL.md").read_text(encoding="utf-8") == original_soul
    assert not list(workspace.glob(".agenticx-core-backup-*"))
