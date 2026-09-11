"""Group runtime tests for per-expert permission and core-memory isolation."""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from agenticx.avatar.group_chat import GroupChatRegistry
from agenticx.avatar.registry import AvatarRegistry
from agenticx.avatar.portable_package import (
    export_group_package,
    export_expert_package,
    import_portable_package,
    make_portable_resource,
)
from agenticx.cli.studio import StudioSession
from agenticx.runtime import SessionPermissionConfirmGate
from agenticx.runtime.events import EventType
from agenticx.runtime.group_context import GroupChatContext
from agenticx.runtime.group_router import GroupChatRouter


@pytest.mark.asyncio
async def test_group_members_keep_their_own_permission_and_core_memory(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    registry = AvatarRegistry(root=tmp_path / "avatars")
    auto_avatar = registry.create_avatar(
        name="自动专家",
        role="执行",
        default_permission_mode="auto",
        workspace_dir=str(tmp_path / "auto-workspace"),
    )
    plan_avatar = registry.create_avatar(
        name="计划专家",
        role="复核",
        default_permission_mode="plan",
        workspace_dir=str(tmp_path / "plan-workspace"),
    )
    registry.update_core_memory(
        auto_avatar.id,
        {
            "IDENTITY.md": "自动专家自己的身份",
            "SOUL.md": "自动专家自己的风格",
            "MEMORY.md": "自动专家自己的记忆",
        },
    )
    registry.update_core_memory(
        plan_avatar.id,
        {
            "IDENTITY.md": "计划专家自己的身份",
            "SOUL.md": "计划专家自己的风格",
            "MEMORY.md": "计划专家自己的记忆",
        },
    )
    published_resource = make_portable_resource(
        "published/IDENTITY.md",
        "发布包基线：由企业发布的可复用身份说明",
    )
    imported = import_portable_package(
        export_expert_package(
            auto_avatar.id,
            avatar_registry=registry,
            artifact_id="expert:01HZX2N9FTM7E5V7Y7C3A8D2Q9",
            release_version="1.0.0",
            resources=[published_resource],
        ),
        avatar_registry=registry,
    ).expert
    assert imported is not None
    registry.update_core_memory(
        imported.id,
        {
            "IDENTITY.md": "导入自动专家自己的身份",
            "SOUL.md": "导入自动专家自己的风格",
            "MEMORY.md": "导入自动专家自己的记忆",
        },
    )

    captured: list[dict[str, object]] = []

    class FakeRuntime:
        def __init__(self, _llm, confirm_gate, **kwargs):
            captured.append({"gate": confirm_gate, **kwargs})

        async def run_turn(self, *args, **kwargs):
            captured[-1]["system_prompt"] = kwargs.get("system_prompt", "")
            captured[-1]["session"] = args[1]
            yield SimpleNamespace(type=EventType.FINAL.value, data={"text": "完成"})

    monkeypatch.setattr("agenticx.runtime.group_router.AgentRuntime", FakeRuntime)
    router = GroupChatRouter(
        avatar_registry=registry,
        llm_factory=lambda _provider, _model: MagicMock(),
        max_tool_rounds=5,
    )
    shared_workspace = tmp_path / "group-workspace"
    shared_workspace.mkdir()
    base = StudioSession(
        provider_name="fake",
        model_name="fake",
        workspace_dir=str(shared_workspace),
        permission_mode="ask",
    )
    base.scratchpad = {}
    context = GroupChatContext(base)

    async def run_member(avatar_id: str) -> None:
        await router._run_one_target(
            base_session=base,
            context=context,
            group_id="group-1",
            group_name="测试群",
            avatar_id=avatar_id,
            user_input="请处理",
            quoted_content="",
            should_stop=lambda: False,
            force_reply=True,
        )

    await run_member(imported.id)
    auto_runtime = captured[-1]
    await run_member(plan_avatar.id)
    plan_runtime = captured[-1]

    assert isinstance(auto_runtime["gate"], SessionPermissionConfirmGate)
    assert isinstance(plan_runtime["gate"], SessionPermissionConfirmGate)
    assert auto_runtime["gate"].mode_resolver() == "auto"  # type: ignore[union-attr]
    assert plan_runtime["gate"].mode_resolver() == "plan"  # type: ignore[union-attr]
    assert auto_runtime["gate"].mode_resolver() != permission_mode_of(base)  # type: ignore[union-attr]
    assert auto_runtime["session"].workspace_dir == imported.workspace_dir  # type: ignore[union-attr]
    assert plan_runtime["session"].workspace_dir == plan_avatar.workspace_dir  # type: ignore[union-attr]
    assert auto_runtime["session"].workspace_dir != shared_workspace.as_posix()  # type: ignore[union-attr]
    assert any(  # type: ignore[union-attr]
        row.get("path") == shared_workspace.as_posix()
        for row in auto_runtime["session"].taskspaces  # type: ignore[union-attr]
    )
    auto_prompt = str(auto_runtime["system_prompt"])
    plan_prompt = str(plan_runtime["system_prompt"])
    assert "导入自动专家自己的身份" in auto_prompt
    assert "发布包基线：由企业发布的可复用身份说明" in auto_prompt
    assert "计划专家自己的身份" not in auto_prompt
    assert "计划专家自己的身份" in plan_prompt
    assert "自动专家自己的身份" not in plan_prompt


@pytest.mark.asyncio
async def test_group_members_read_verified_baseline_from_durable_group_workspace(
    tmp_path: Path,
) -> None:
    source_avatars = AvatarRegistry(root=tmp_path / "source-avatars")
    source_member = source_avatars.create_avatar(
        name="交付专家",
        role="交付",
        system_prompt="负责交付",
    )
    source_groups = GroupChatRegistry(root=tmp_path / "source-groups")
    source_group = source_groups.create_group(
        name="交付团队",
        avatar_ids=[source_member.id],
        host_avatar_id=source_member.id,
    )
    package = export_group_package(
        source_group.id,
        avatar_registry=source_avatars,
        group_registry=source_groups,
        resources=[
            make_portable_resource("IDENTITY.md", "群发布身份基线"),
            make_portable_resource("SOUL.md", "群发布风格基线"),
            make_portable_resource("MEMORY.md", "群发布记忆基线"),
        ],
    )

    avatars = AvatarRegistry(root=tmp_path / "destination-avatars")
    groups = GroupChatRegistry(root=tmp_path / "destination-groups")
    imported = import_portable_package(
        package,
        avatar_registry=avatars,
        group_registry=groups,
    )
    assert imported.group is not None
    assert len(imported.members) == 1
    group = imported.group
    member = imported.members[0]
    group_workspace = Path(group.workspace_dir)
    assert (
        group_workspace / "package_resources" / "IDENTITY.md"
    ).read_text(encoding="utf-8") == "群发布身份基线"
    assert not (
        Path(member.workspace_dir) / "package_resources" / "IDENTITY.md"
    ).exists()
    avatars.update_core_memory(
        member.id,
        {
            "IDENTITY.md": "成员自己的身份",
            "SOUL.md": "成员自己的风格",
            "MEMORY.md": "成员自己的记忆",
        },
    )

    captured: list[dict[str, object]] = []

    class FakeRuntime:
        def __init__(self, _llm, _confirm_gate, **kwargs):
            captured.append(dict(kwargs))

        async def run_turn(self, *args, **kwargs):
            captured[-1]["system_prompt"] = kwargs.get("system_prompt", "")
            captured[-1]["session"] = args[1]
            yield SimpleNamespace(type=EventType.FINAL.value, data={"text": "完成"})

    import agenticx.runtime.group_router as group_router_module

    original_runtime = group_router_module.AgentRuntime
    group_router_module.AgentRuntime = FakeRuntime
    try:
        router = GroupChatRouter(
            avatar_registry=avatars,
            group_registry=groups,
            llm_factory=lambda _provider, _model: MagicMock(),
            max_tool_rounds=5,
        )
        base = StudioSession(
            provider_name="fake",
            model_name="fake",
            workspace_dir=str(tmp_path / "session-workspace"),
            permission_mode="ask",
        )
        base.scratchpad = {}
        setattr(base, "__group_avatar_ids", [member.id])
        context = GroupChatContext(base)
        await router._run_one_target(
            base_session=base,
            context=context,
            group_id=group.id,
            group_name=group.name,
            avatar_id=member.id,
            user_input="请处理",
            quoted_content="",
            should_stop=lambda: False,
            force_reply=True,
        )
    finally:
        group_router_module.AgentRuntime = original_runtime

    prompt = str(captured[-1]["system_prompt"])
    assert "成员自己的身份" in prompt
    assert "群发布身份基线" in prompt
    assert "群发布风格基线" in prompt
    assert "群发布记忆基线" in prompt
    runtime_session = captured[-1]["session"]
    assert runtime_session.workspace_dir == member.workspace_dir
    assert any(
        row.get("path") == str(group_workspace)
        for row in runtime_session.taskspaces
    )

    # A tampered group-owned resource fails closed through the existing
    # metadata/resource digest check; no stale or unverified baseline enters a
    # member prompt.
    (
        group_workspace / "package_resources" / "IDENTITY.md"
    ).write_text("篡改后的群身份", encoding="utf-8")
    captured.clear()
    group_router_module.AgentRuntime = FakeRuntime
    try:
        await router._run_one_target(
            base_session=base,
            context=context,
            group_id=group.id,
            group_name=group.name,
            avatar_id=member.id,
            user_input="再次处理",
            quoted_content="",
            should_stop=lambda: False,
            force_reply=True,
        )
    finally:
        group_router_module.AgentRuntime = original_runtime
    tampered_prompt = str(captured[-1]["system_prompt"])
    assert "篡改后的群身份" not in tampered_prompt
    assert "群发布风格基线" not in tampered_prompt
    assert "群发布记忆基线" not in tampered_prompt
    assert "成员自己的身份" in tampered_prompt


def permission_mode_of(session: StudioSession) -> str:
    return str(getattr(session, "permission_mode", ""))
