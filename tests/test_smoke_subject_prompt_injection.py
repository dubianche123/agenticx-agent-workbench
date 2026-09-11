#!/usr/bin/env python3
"""Smoke tests for subject-scoped workspace prompt injection.

Author: Damon Li
"""

from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock

import pytest

from agenticx.avatar.registry import AvatarRegistry
from agenticx.avatar.group_chat import GroupChatRegistry
from agenticx.avatar.portable_package import (
    export_expert_package,
    export_group_package,
    import_portable_package,
    make_portable_resource,
)
from agenticx.runtime.prompts.meta_agent import _build_workspace_context_block


def test_prompt_includes_global_user_and_avatar_memory(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    global_ws = tmp_path / "global"
    global_ws.mkdir()
    (global_ws / "USER.md").write_text("全局偏好：简洁中文", encoding="utf-8")
    (global_ws / "IDENTITY.md").write_text("Meta identity", encoding="utf-8")
    (global_ws / "MEMORY.md").write_text("Meta memory anchor", encoding="utf-8")

    monkeypatch.setattr("agenticx.workspace.loader.resolve_workspace_dir", lambda: global_ws)

    reg = AvatarRegistry()
    avatar = reg.create_avatar("Coder", role="dev")
    avatar_ws = Path(avatar.workspace_dir)
    (avatar_ws / "MEMORY.md").write_text("分身记忆：只用 Rust", encoding="utf-8")

    session = MagicMock()
    session.bound_avatar_id = avatar.id

    block = _build_workspace_context_block(avatar.id, session=session, subject_label="Coder")
    assert "全局用户偏好（只读基线）" in block
    assert "简洁中文" in block
    assert "只用 Rust" in block
    assert "Meta memory anchor" not in block


def test_meta_prompt_dedupes_global_workspace(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    global_ws = tmp_path / "global"
    global_ws.mkdir()
    (global_ws / "USER.md").write_text("全局偏好", encoding="utf-8")
    (global_ws / "MEMORY.md").write_text("元智能体记忆", encoding="utf-8")
    monkeypatch.setattr("agenticx.workspace.loader.resolve_workspace_dir", lambda: global_ws)

    block = _build_workspace_context_block(None, subject_label="元智能体")
    assert block.count("元智能体记忆") == 1
    assert "全局用户偏好（只读基线）" in block


def test_imported_expert_runtime_uses_verified_package_baseline_separately(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    global_ws = tmp_path / "global"
    global_ws.mkdir()
    (global_ws / "USER.md").write_text("全局偏好", encoding="utf-8")
    monkeypatch.setattr("agenticx.workspace.loader.resolve_workspace_dir", lambda: global_ws)

    source = AvatarRegistry(root=tmp_path / "source-avatars")
    expert = source.create_avatar("环境配置专家", role="环境维护")
    raw = export_expert_package(
        expert.id,
        avatar_registry=source,
        resources=[make_portable_resource("guides/ENV.md", "只读环境基线")],
    )
    imported = import_portable_package(raw)
    assert imported.expert is not None
    workspace = Path(imported.expert.workspace_dir)
    (workspace / "MEMORY.md").write_text("员工本地经验", encoding="utf-8")

    block = _build_workspace_context_block(
        imported.expert.id,
        subject_label=imported.expert.name,
    )
    assert "发布包附带资料（只读基线）" in block
    assert "guides/ENV.md" in block
    assert "只读环境基线" in block
    assert "本主体" in block and "员工本地经验" in block


def test_imported_group_runtime_uses_group_package_baseline(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    global_ws = tmp_path / "global"
    global_ws.mkdir()
    (global_ws / "USER.md").write_text("全局偏好", encoding="utf-8")
    monkeypatch.setattr("agenticx.workspace.loader.resolve_workspace_dir", lambda: global_ws)

    source_avatars = AvatarRegistry(root=tmp_path / "source-avatars")
    member = source_avatars.create_avatar("交付专家", role="交付")
    source_groups = GroupChatRegistry(root=tmp_path / "source-groups")
    group = source_groups.create_group(
        name="交付团队",
        avatar_ids=[member.id],
        host_avatar_id=member.id,
    )
    raw = export_group_package(
        group.id,
        avatar_registry=source_avatars,
        group_registry=source_groups,
        resources=[make_portable_resource("playbooks/DELIVERY.md", "团队交付基线")],
    )
    imported = import_portable_package(raw)
    assert imported.group is not None
    workspace = Path(imported.group.workspace_dir)
    (workspace / "MEMORY.md").write_text("本群本地复盘", encoding="utf-8")

    block = _build_workspace_context_block(
        f"group:{imported.group.id}",
        subject_label=imported.group.name,
    )
    assert "发布包附带资料（只读基线）" in block
    assert "playbooks/DELIVERY.md" in block
    assert "团队交付基线" in block
    assert "本群本地复盘" in block
