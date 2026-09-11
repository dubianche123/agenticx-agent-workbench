#!/usr/bin/env python3
"""Smoke tests for Meta-Agent create_avatar tool.

Covers tool registration in META_AGENT_TOOLS and dispatch_meta_tool_async
landing into AvatarRegistry (with tmp root via monkeypatch).

Author: Damon Li
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from agenticx.avatar.registry import AvatarRegistry
from agenticx.runtime.meta_tools import META_AGENT_TOOLS, dispatch_meta_tool_async
from agenticx.runtime.team_manager import AgentTeamManager

from .conftest import ApprovingConfirmGate


def _tool_names() -> set[str]:
    names: set[str] = set()
    for item in META_AGENT_TOOLS:
        if not isinstance(item, dict):
            continue
        fn = item.get("function")
        if isinstance(fn, dict):
            name = str(fn.get("name") or "").strip()
            if name:
                names.add(name)
    return names


def test_create_avatar_registered_in_meta_tools() -> None:
    names = _tool_names()
    assert "create_avatar" in names
    assert "delegate_to_avatar" in names
    assert "read_avatar_workspace" in names
    assert "chat_with_avatar" in names


def test_create_avatar_schema_includes_description_and_tags() -> None:
    create_fn: dict[str, Any] | None = None
    for item in META_AGENT_TOOLS:
        if not isinstance(item, dict):
            continue
        fn = item.get("function")
        if isinstance(fn, dict) and fn.get("name") == "create_avatar":
            create_fn = fn
            break
    assert create_fn is not None
    props = create_fn["parameters"]["properties"]
    assert "description" in props
    assert "tags" in props
    assert props["tags"]["type"] == "array"
    assert props["tags"]["items"]["type"] == "string"


@pytest.mark.asyncio
async def test_create_avatar_dispatch_persists(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    root = tmp_path / "avatars"

    class _TmpRegistry(AvatarRegistry):
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            super().__init__(root=root)

    monkeypatch.setattr("agenticx.avatar.registry.AvatarRegistry", _TmpRegistry)

    team = AgentTeamManager.__new__(AgentTeamManager)
    result_raw = await dispatch_meta_tool_async(
        "create_avatar",
        {
            "name": "飞廉",
            "role": "进取型全市场交易分析师",
            "description": "专注全市场机会扫描与风险提示的交易分析分身。",
            "tags": ["交易分析", "风险管理", "市场扫描"],
            "system_prompt": "你是飞廉，专注全市场交易分析。",
        },
        team_manager=team,
        session=None,
        confirm_gate=ApprovingConfirmGate(),
    )
    result = json.loads(result_raw)
    assert result["ok"] is True
    assert result["name"] == "飞廉"
    assert result["role"] == "进取型全市场交易分析师"
    assert result["description"] == "专注全市场机会扫描与风险提示的交易分析分身。"
    assert result["tags"] == ["交易分析", "风险管理", "市场扫描"]
    avatar_id = str(result["avatar_id"]).strip()
    assert avatar_id

    registry = _TmpRegistry()
    loaded = registry.get_avatar(avatar_id)
    assert loaded is not None
    assert loaded.name == "飞廉"
    assert loaded.description == "专注全市场机会扫描与风险提示的交易分析分身。"
    assert list(loaded.tags or []) == ["交易分析", "风险管理", "市场扫描"]
    assert loaded.created_by == "meta"
    assert (root / avatar_id / "avatar.yaml").is_file()


@pytest.mark.asyncio
async def test_create_avatar_dispatch_rejects_duplicate_name(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = tmp_path / "avatars"

    class _TmpRegistry(AvatarRegistry):
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            super().__init__(root=root)

    monkeypatch.setattr("agenticx.avatar.registry.AvatarRegistry", _TmpRegistry)

    team = AgentTeamManager.__new__(AgentTeamManager)
    first = json.loads(
        await dispatch_meta_tool_async(
            "create_avatar",
            {
                "name": "飞廉",
                "role": "分析师",
                "system_prompt": "prompt-a",
            },
            team_manager=team,
            session=None,
            confirm_gate=ApprovingConfirmGate(),
        )
    )
    assert first["ok"] is True

    second = json.loads(
        await dispatch_meta_tool_async(
            "create_avatar",
            {
                "name": "飞廉",
                "role": "另一角色",
                "system_prompt": "prompt-b",
            },
            team_manager=team,
            session=None,
            confirm_gate=ApprovingConfirmGate(),
        )
    )
    assert second["ok"] is False
    assert second["error"] == "avatar_exists"
    assert second["avatar_id"] == first["avatar_id"]


@pytest.mark.asyncio
async def test_create_avatar_requires_name(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    root = tmp_path / "avatars"

    class _TmpRegistry(AvatarRegistry):
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            super().__init__(root=root)

    monkeypatch.setattr("agenticx.avatar.registry.AvatarRegistry", _TmpRegistry)

    team = AgentTeamManager.__new__(AgentTeamManager)
    result = json.loads(
        await dispatch_meta_tool_async(
            "create_avatar",
            {"name": "  ", "role": "x", "system_prompt": "y"},
            team_manager=team,
            session=None,
            confirm_gate=ApprovingConfirmGate(),
        )
    )
    assert result["ok"] is False
    assert result["error"] == "missing_name"


@pytest.mark.asyncio
async def test_create_avatar_is_not_persisted_when_the_user_refuses(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """拒绝之后注册表里不能多出东西。

    在加上确认闸之前，这个工具从头到尾不问：一句 ``dispatch_meta_tool_async(...)``
    就能把一个分身写进注册表。它的 schema 里确实写着「必须先调
    request_action_confirmation 拿到 [ACTION_CONFIRMED] 再调用本工具」——但运行时对此
    **没有任何强制**。那是一句写给模型看的话，权限模型不能建立在「模型会遵守描述文字」上。

    上面几个用例现在都显式传了一个「用户点了同意」的闸；这一个走另一侧，确认拒绝
    真的挡住了副作用，而不只是把返回值改成一句话。
    """
    root = tmp_path / "avatars"

    class _TmpRegistry(AvatarRegistry):
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            super().__init__(root=root)

    monkeypatch.setattr("agenticx.avatar.registry.AvatarRegistry", _TmpRegistry)

    gate = ApprovingConfirmGate(approve=False)
    team = AgentTeamManager.__new__(AgentTeamManager)
    out = await dispatch_meta_tool_async(
        "create_avatar",
        {"name": "飞廉", "role": "分析师", "system_prompt": "prompt"},
        team_manager=team,
        session=None,
        confirm_gate=gate,
    )

    assert out.startswith("CANCELLED"), out
    assert gate.requests, "拒绝路径上根本没问过"
    # 问的那句话里要有对象，不能只有工具名。
    assert "飞廉" in gate.requests[0][0]
    assert not root.exists() or not list(root.iterdir())
