#!/usr/bin/env python3
"""Regression tests for the bundled digital-expert portrait collection."""

from __future__ import annotations

from agenticx.avatar.portrait import (
    PORTRAIT_STYLE,
    curated_portrait_paths,
    generate_avatar_portrait_url,
    needs_portrait_refresh,
)
from agenticx.avatar.registry import AvatarRegistry


def test_curated_portrait_pack_is_complete() -> None:
    paths = curated_portrait_paths()
    assert len(paths) == 20
    assert len({path.name for path in paths}) == 20
    for path in paths:
        data = path.read_bytes()
        assert data.startswith(b"\x89PNG\r\n\x1a\n")
        assert 32 < len(data) < 180_000


def test_generated_portrait_is_bundled_png_and_stable() -> None:
    first = generate_avatar_portrait_url(name="专业审核官", avatar_id="same-id")
    second = generate_avatar_portrait_url(name="专业审核官", avatar_id="same-id")
    other = generate_avatar_portrait_url(name="专业审核官", avatar_id="id-a")

    assert first.startswith("data:image/png;base64,")
    assert first == second
    assert first != other


def test_refreshes_old_generated_styles_but_preserves_custom_images() -> None:
    assert needs_portrait_refresh(
        "data:image/png;base64,old-generated",
        portrait_style="notionists-v1",
        created_by="ai",
    )
    assert not needs_portrait_refresh(
        "data:image/png;base64,user-upload",
        portrait_style="custom",
        created_by="manual",
    )
    assert not needs_portrait_refresh(
        "data:image/png;base64,current",
        portrait_style=PORTRAIT_STYLE,
        created_by="ai",
    )


def test_registry_upgrades_generated_portrait_without_touching_custom(tmp_path) -> None:
    registry = AvatarRegistry(root=tmp_path / "avatars")
    generated = registry.create_avatar(
        name="架构专家",
        role="系统架构",
        created_by="ai",
    )
    generated.avatar_url = "data:image/png;base64,old-generated"
    generated.portrait_style = "notionists-v1"
    registry._write_config(generated)

    custom = registry.create_avatar(
        name="自定义专家",
        avatar_url="data:image/png;base64,user-upload",
        created_by="manual",
    )

    listed = {item.id: item for item in registry.list_avatars()}
    assert listed[generated.id].portrait_style == PORTRAIT_STYLE
    assert listed[generated.id].avatar_url.startswith("data:image/png;base64,")
    assert listed[generated.id].avatar_url != "data:image/png;base64,old-generated"
    assert listed[custom.id].portrait_style == "custom"
    assert listed[custom.id].avatar_url == "data:image/png;base64,user-upload"
