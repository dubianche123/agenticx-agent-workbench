#!/usr/bin/env python3
"""Conversational import tool for shared expert/group packages."""

from __future__ import annotations

import json
import hashlib
from pathlib import Path

import pytest

from agenticx.avatar.registry import AvatarRegistry
from agenticx.cli.agent_tools import STUDIO_TOOLS, dispatch_tool_async
from agenticx.cli.studio import StudioSession

from .conftest import ApprovingConfirmGate


def _expert_package(
    name: str = "环境配置专家",
    system_prompt: str = "先只读检查，再建议最小变更。",
) -> str:
    return json.dumps(
        {
            "schema_version": 2,
            "artifact_id": "expert:01HZX2N9FTM7E5V7Y7C3A8D2Q9",
            "release_version": "1.0.0",
            "kind": "expert",
            "title": name,
            "description": "检查依赖并给出最小配置方案。",
            "recommended_permission_mode": "ask",
            "dependencies": {"skills": [], "mcps": []},
            "resources": [],
            "workspace_slots": [],
            "payload": {
                "name": name,
                "role": "环境配置",
                "description": "检查依赖并给出最小配置方案。",
                "tags": ["环境配置"],
                "system_prompt": system_prompt,
                "color": "blue",
                "default_permission_mode": "ask",
            },
        },
        ensure_ascii=False,
    )


def test_install_portable_package_is_registered_for_digital_experts() -> None:
    names = {
        str(row.get("function", {}).get("name", ""))
        for row in STUDIO_TOOLS
        if isinstance(row, dict)
    }
    assert "install_portable_package" in names


@pytest.mark.asyncio
async def test_install_portable_package_requires_confirmation(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    package_path = workspace / "env.agx-expert.json"
    package_path.write_text(_expert_package(), encoding="utf-8")
    session = StudioSession(workspace_dir=str(workspace))
    gate = ApprovingConfirmGate(approve=False)

    result = json.loads(
        await dispatch_tool_async(
            "install_portable_package",
            {"path": str(package_path)},
            session,
            confirm_gate=gate,
        )
    )
    assert result["ok"] is False
    assert result["error"] == "user_cancelled"
    assert gate.requests
    question, context = gate.requests[0]
    assert "环境配置专家" in question
    assert "不会导入聊天记录" in question
    assert "package_resources" in question
    assert "不会自动安装或授权" in question
    assert "建议运行权限：ask（仅建议，不授权）" in question
    assert context["approval_reuse"] == "none"
    assert AvatarRegistry().list_avatars() == []


@pytest.mark.asyncio
async def test_install_portable_package_blocks_scanner_findings_before_confirmation(
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    package = json.loads(_expert_package())
    secret_content = "OPENAI_API_KEY=" + "sk-" + "A" * 48
    package["resources"] = [
        {
            "path": "SOUL.md",
            "content": secret_content,
            "digest": hashlib.sha256(secret_content.encode("utf-8")).hexdigest(),
        }
    ]
    package_path = workspace / "blocked.agx-expert.json"
    package_path.write_text(json.dumps(package, ensure_ascii=False), encoding="utf-8")
    gate = ApprovingConfirmGate()

    result = json.loads(
        await dispatch_tool_async(
            "install_portable_package",
            {"path": str(package_path)},
            StudioSession(workspace_dir=str(workspace)),
            confirm_gate=gate,
        )
    )

    assert result["ok"] is False
    assert "unsafe package content" in result["error"]
    assert "resources[0].content" in result["error"]
    assert gate.requests == []
    assert AvatarRegistry().list_avatars() == []


@pytest.mark.asyncio
async def test_install_portable_package_creates_a_fresh_expert(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    package_path = workspace / "env.agx-expert.json"
    package_path.write_text(_expert_package(), encoding="utf-8")
    session = StudioSession(workspace_dir=str(workspace))

    result = json.loads(
        await dispatch_tool_async(
            "install_portable_package",
            {"path": str(package_path)},
            session,
            confirm_gate=ApprovingConfirmGate(),
        )
    )
    assert result["ok"] is True
    assert result["kind"] == "expert"
    installed = AvatarRegistry().get_avatar(result["avatar_id"])
    assert installed is not None
    assert installed.name == "环境配置专家"
    assert installed.created_by == "portable_import"
    assert installed.workspace_dir != str(workspace)
    assert installed.tools_enabled == {}
    assert installed.skills_enabled is None
    assert installed.brains_enabled is None
    assert "avatar" not in result
    assert "system_prompt" not in json.dumps(result, ensure_ascii=False)


@pytest.mark.asyncio
async def test_install_portable_group_shows_full_untrusted_prompts_but_never_returns_them(
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    hidden_tail = "尾部安全核对标记-不得回灌给模型"
    long_prompt = "A" * 1_100 + hidden_tail
    package = {
        "schema_version": 2,
        "artifact_id": "group:01HZX2N9FTM7E5V7Y7C3A8D2Q9",
        "release_version": "1.0.0",
        "kind": "group",
        "title": "环境排障群",
        "description": "",
        "recommended_permission_mode": "ask",
        "dependencies": {"skills": [], "mcps": []},
        "resources": [],
        "workspace_slots": [],
        "payload": {
            "name": "环境排障群",
            "members": [
                {
                    "name": "环境配置专家",
                    "role": "环境配置",
                    "description": "检查环境",
                    "tags": ["环境"],
                    "system_prompt": long_prompt,
                    "color": "blue",
                    "default_permission_mode": "ask",
                },
                {
                    "name": "复核专家",
                    "role": "复核",
                    "description": "复核结论",
                    "tags": ["复核"],
                    "system_prompt": "只复核，不执行变更。",
                    "color": "white",
                    "default_permission_mode": "ask",
                },
            ],
            "host_member_index": 0,
            "routing": "team",
        },
    }
    package_path = workspace / "env.agx-group.json"
    package_path.write_text(json.dumps(package, ensure_ascii=False), encoding="utf-8")
    gate = ApprovingConfirmGate()

    raw_result = await dispatch_tool_async(
        "install_portable_package",
        {"path": str(package_path)},
        StudioSession(workspace_dir=str(workspace)),
        confirm_gate=gate,
    )
    result = json.loads(raw_result)

    assert result["ok"] is True
    assert result["kind"] == "group"
    assert len(result["member_ids"]) == 2
    assert hidden_tail in gate.requests[0][0]
    assert hidden_tail not in raw_result
    assert "system_prompt" not in raw_result
    assert "avatars" not in result


@pytest.mark.asyncio
async def test_install_portable_package_rejects_renamed_json(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    package_path = workspace / "looks-harmless.json"
    package_path.write_text(_expert_package(), encoding="utf-8")
    result = json.loads(
        await dispatch_tool_async(
            "install_portable_package",
            {"path": str(package_path)},
            StudioSession(workspace_dir=str(workspace)),
            confirm_gate=ApprovingConfirmGate(),
        )
    )
    assert result["ok"] is False
    assert ".agx-expert.json" in result["error"]
    assert AvatarRegistry().list_avatars() == []


@pytest.mark.asyncio
async def test_install_portable_package_rejects_suffix_kind_mismatch(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    package_path = workspace / "disguised.agx-group.json"
    package_path.write_text(_expert_package(), encoding="utf-8")

    result = json.loads(
        await dispatch_tool_async(
            "install_portable_package",
            {"path": str(package_path)},
            StudioSession(workspace_dir=str(workspace)),
            confirm_gate=ApprovingConfirmGate(),
        )
    )

    assert result["ok"] is False
    assert "package kind does not match" in result["error"]
    assert AvatarRegistry().list_avatars() == []
