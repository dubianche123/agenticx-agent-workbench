"""Tests for the Meta-Agent persistent expert creation contract."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

from agenticx.avatar import registry as avatar_registry_module
from agenticx.avatar.registry import CORE_MEMORY_MAX_BYTES, AvatarRegistry
from agenticx.cli.studio import StudioSession
from agenticx.runtime.meta_tools import META_AGENT_TOOLS, dispatch_meta_tool_async
from agenticx.runtime.team_manager import AgentTeamManager

from .conftest import ApprovingConfirmGate


class _QuickTextLLM:
    def invoke(self, *_args, **_kwargs):
        return type("Response", (), {"content": "done", "tool_calls": []})()

    def stream(self, *_args, **_kwargs):
        yield "ok"


def _manager() -> AgentTeamManager:
    return AgentTeamManager(
        llm_factory=lambda: _QuickTextLLM(),
        base_session=StudioSession(),
    )


def _run(coro) -> str:
    return asyncio.run(coro)


def _create_avatar(arguments: dict) -> dict:
    raw = _run(
        dispatch_meta_tool_async(
            "create_avatar",
            arguments,
            team_manager=_manager(),
            confirm_gate=ApprovingConfirmGate(),
        )
    )
    return json.loads(raw)


def test_avatar_registry_follows_current_home_after_previous_fixture() -> None:
    """A prior avatar-root override must not pin later tests to its HOME."""

    expected_root = Path.home() / ".agenticx" / "avatars"
    assert AvatarRegistry().root == expected_root
    assert avatar_registry_module.__dict__.get("AVATARS_ROOT") is None


def test_create_avatar_schema_exposes_permission_and_fixed_core_memory() -> None:
    specs = {
        tool["function"]["name"]: tool["function"]
        for tool in META_AGENT_TOOLS
        if isinstance(tool, dict) and isinstance(tool.get("function"), dict)
    }
    create_spec = specs["create_avatar"]
    properties = create_spec["parameters"]["properties"]

    # Existing calls remain valid: only the original three fields are required.
    assert set(create_spec["parameters"]["required"]) == {
        "name",
        "role",
        "system_prompt",
    }
    assert properties["default_permission_mode"]["enum"] == ["plan", "ask", "auto"]
    core_properties = properties["core_memory"]["properties"]
    assert set(core_properties) == {"SOUL.md", "MEMORY.md"}
    assert all(core_properties[key]["type"] == "string" for key in core_properties)
    assert properties["core_memory"]["additionalProperties"] is False
    assert "workspace_dir" not in properties


def test_create_avatar_persists_permission_and_core_memory_in_isolated_workspace() -> None:
    result = _create_avatar(
        {
            "name": "安全审查官",
            "role": "前端质量顾问",
            "description": "先验证证据，再给出最小可执行建议。",
            "tags": ["代码审查", "安全"],
            "system_prompt": "只基于证据分析，不伪造结果。",
            "default_permission_mode": "plan",
            "core_memory": {
                "SOUL.md": "# 行为基线\n\n先验证证据，再给出最小可执行建议。\n",
                "MEMORY.md": "# 稳定记忆\n\n只保留经过确认的工作偏好。\n",
            },
        }
    )

    assert result["ok"] is True
    assert result["default_permission_mode"] == "plan"
    assert result["core_memory_files"] == ["IDENTITY.md", "SOUL.md", "MEMORY.md"]
    assert result["workspace_policy"] == "system_isolated"

    avatar = AvatarRegistry().get_avatar(result["avatar_id"])
    assert avatar is not None
    assert avatar.default_permission_mode == "plan"
    workspace = Path(avatar.workspace_dir)
    assert workspace == Path.home() / ".agenticx" / "avatars" / avatar.id / "workspace"
    assert (workspace / "IDENTITY.md").is_file()
    assert (workspace / "SOUL.md").read_text(encoding="utf-8").startswith("# 行为基线")
    assert "经过确认的工作偏好" in (workspace / "MEMORY.md").read_text(encoding="utf-8")


def test_legacy_create_avatar_call_gets_safe_defaults_and_soul_seed() -> None:
    result = _create_avatar(
        {
            "name": "兼容专家",
            "role": "通用顾问",
            "system_prompt": "先确认目标，再给出结构化回答。",
        }
    )

    assert result["ok"] is True
    assert result["default_permission_mode"] == "ask"
    assert result["core_memory_files"] == ["IDENTITY.md", "SOUL.md", "MEMORY.md"]
    avatar = AvatarRegistry().get_avatar(result["avatar_id"])
    assert avatar is not None
    assert "先确认目标，再给出结构化回答" in (
        Path(avatar.workspace_dir) / "SOUL.md"
    ).read_text(encoding="utf-8")


def test_create_avatar_rejects_model_workspace_path_without_creating() -> None:
    model_path = Path.home() / "model-selected-workspace"
    result = _create_avatar(
        {
            "name": "路径拦截专家",
            "role": "测试",
            "system_prompt": "测试",
            "workspace_dir": str(model_path),
        }
    )

    assert result["ok"] is False
    assert result["error"] == "workspace_dir_not_allowed"
    assert not model_path.exists()
    assert AvatarRegistry().list_avatars() == []


def test_create_avatar_rejects_invalid_permission_and_oversized_core_memory() -> None:
    invalid_permission = _create_avatar(
        {
            "name": "非法权限专家",
            "role": "测试",
            "system_prompt": "测试",
            "default_permission_mode": "dangerous",
        }
    )
    assert invalid_permission["ok"] is False
    assert invalid_permission["error"] == "invalid_permission_mode"
    assert AvatarRegistry().list_avatars() == []

    identity = _create_avatar(
        {
            "name": "身份资料专家",
            "role": "测试",
            "system_prompt": "测试",
            "core_memory": {"IDENTITY.md": "模型不应覆盖身份模板"},
        }
    )
    assert identity["ok"] is False
    assert identity["error"] == "invalid_core_memory"
    assert AvatarRegistry().list_avatars() == []

    oversized = _create_avatar(
        {
            "name": "超长资料专家",
            "role": "测试",
            "system_prompt": "测试",
            "core_memory": {"MEMORY.md": "x" * (CORE_MEMORY_MAX_BYTES + 1)},
        }
    )
    assert oversized["ok"] is False
    assert oversized["error"] == "invalid_core_memory"
    assert AvatarRegistry().list_avatars() == []
