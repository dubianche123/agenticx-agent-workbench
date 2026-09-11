#!/usr/bin/env python3
"""Smoke tests for skill duplicate conflict resolution."""

from __future__ import annotations

import shutil
from pathlib import Path

from agenticx.tools import skill_bundle as skill_bundle_module
from agenticx.tools.skill_bundle import SkillBundleLoader, infer_skill_source, resolve_skill_source


def _write_skill(
    root: Path,
    name: str,
    description: str,
    body: str,
    *,
    skill_name: str | None = None,
    source: str | None = None,
    managed_marker: bool = False,
) -> None:
    skill_dir = root / name
    skill_dir.mkdir(parents=True, exist_ok=True)
    metadata_name = skill_name or name
    source_line = f"source: {source}\n" if source else ""
    content = (
        "---\n"
        f"name: {metadata_name}\n"
        f"description: {description}\n"
        f"{source_line}"
        "---\n\n"
        f"{body}\n"
    )
    (skill_dir / "SKILL.md").write_text(content, encoding="utf-8")
    if managed_marker:
        (skill_dir / ".near-managed").write_text(
            "managed by enterprise capability pack\n",
            encoding="utf-8",
        )


def _force_presets_enabled(monkeypatch) -> None:
    monkeypatch.setattr(
        skill_bundle_module,
        "get_skill_scan_settings_from_config",
        lambda: (
            [
                {"id": "cursor_skills", "label": "Cursor Skills", "path": "~/.cursor/skills", "enabled": True},
                {"id": "claude_skills_home", "label": "Claude Skills", "path": "~/.claude/skills", "enabled": True},
                {"id": "agents_home", "label": "Agents Global", "path": "~/.agents/skills", "enabled": True},
            ],
            [],
            {},
            [],
        ),
    )


def test_duplicate_skill_prefers_higher_source_priority(tmp_path: Path, monkeypatch) -> None:
    _force_presets_enabled(monkeypatch)
    cursor_root = tmp_path / ".cursor" / "skills"
    claude_root = tmp_path / ".claude" / "skills"
    _write_skill(cursor_root, "tech-daily-news", "cursor variant", "# Cursor version")
    _write_skill(claude_root, "tech-daily-news", "claude variant", "# Claude version")

    loader = SkillBundleLoader(search_paths=[claude_root, cursor_root])
    skills = loader.scan()
    assert len(skills) == 1
    assert skills[0].name == "tech-daily-news"
    assert skills[0].source == "cursor"


def test_duplicate_skill_respects_user_preferred_source(tmp_path: Path, monkeypatch) -> None:
    _force_presets_enabled(monkeypatch)
    cursor_root = tmp_path / ".cursor" / "skills"
    claude_root = tmp_path / ".claude" / "skills"
    _write_skill(cursor_root, "tech-daily-news", "cursor variant", "# Cursor version")
    _write_skill(claude_root, "tech-daily-news", "claude variant", "# Claude version")

    loader = SkillBundleLoader(
        search_paths=[cursor_root, claude_root],
        preferred_sources={"tech-daily-news": "claude"},
    )
    skills = loader.scan()
    assert len(skills) == 1
    assert skills[0].source == "claude"
    assert "Claude version" in skills[0].skill_md_path.read_text(encoding="utf-8")


def test_duplicate_skill_keeps_variants_with_content_hashes(tmp_path: Path, monkeypatch) -> None:
    _force_presets_enabled(monkeypatch)
    cursor_root = tmp_path / ".cursor" / "skills"
    agents_root = tmp_path / ".agents" / "skills"
    _write_skill(cursor_root, "tech-daily-news", "cursor variant", "# Cursor version")
    _write_skill(agents_root, "tech-daily-news", "agents variant", "# Agents version")

    loader = SkillBundleLoader(search_paths=[cursor_root, agents_root])
    loader.scan()

    variants = loader.get_skill_variants("tech-daily-news")
    assert len(variants) == 2
    hashes = {v.content_hash for v in variants}
    assert len(hashes) == 2
    assert all(len(h) == 64 for h in hashes)


def test_managed_market_skill_wins_and_withdrawal_restores_voluntary_market(
    tmp_path: Path,
    monkeypatch,
) -> None:
    """Managed market content wins by path, then voluntary content returns."""
    home = tmp_path / "home"
    monkeypatch.setattr(skill_bundle_module.Path, "home", lambda: home)

    local_root = tmp_path / "local-skills"
    voluntary_root = home / ".agenticx" / "skills" / "market"
    managed_root = home / ".agenticx" / "skills" / "enterprise-market"
    managed_dir = "market-01JABCDEF0123456789ABCDEFG"

    _write_skill(local_root, "same-name", "local version", "# Local")
    _write_skill(voluntary_root, "same-name", "voluntary version", "# Voluntary")
    # Preserve an upstream source field to prove path provenance does not
    # require rewriting signed managed content.
    _write_skill(
        managed_root,
        managed_dir,
        "managed version",
        "# Managed",
        skill_name="same-name",
        source="skillhub",
        managed_marker=True,
    )

    # Put managed last to make the assertion independent of scan order.
    loader = SkillBundleLoader(search_paths=[local_root, voluntary_root, managed_root])
    selected = loader.scan()
    assert len(selected) == 1
    assert selected[0].source == "managed"
    assert selected[0].base_dir == managed_root / managed_dir
    assert "source: skillhub" in selected[0].skill_md_path.read_text(encoding="utf-8")
    assert "# Managed" in selected[0].skill_md_path.read_text(encoding="utf-8")

    shutil.rmtree(managed_root / managed_dir)
    restored = loader.refresh()
    assert len(restored) == 1
    assert restored[0].base_dir == voluntary_root / "same-name"
    assert restored[0].source != "managed"
    assert "# Voluntary" in restored[0].skill_md_path.read_text(encoding="utf-8")


def test_legacy_enterprise_skill_path_is_managed_and_restores_local(
    tmp_path: Path,
    monkeypatch,
) -> None:
    """The legacy ``skills/enterprise`` root has the same managed semantics."""
    home = tmp_path / "home"
    monkeypatch.setattr(skill_bundle_module.Path, "home", lambda: home)

    for group in ("enterprise-market", "enterprise"):
        local_root = tmp_path / f"local-{group}"
        managed_root = home / ".agenticx" / "skills" / group
        managed_dir = "managed-entry"
        _write_skill(local_root, "same-name", "local version", "# Local")
        _write_skill(
            managed_root,
            managed_dir,
            "managed version",
            "# Managed",
            skill_name="same-name",
            managed_marker=True,
        )

        loader = SkillBundleLoader(search_paths=[local_root, managed_root])
        selected = loader.scan()
        assert len(selected) == 1
        assert selected[0].source == "managed"
        assert selected[0].base_dir == managed_root / managed_dir

        shutil.rmtree(managed_root / managed_dir)
        restored = loader.refresh()
        assert len(restored) == 1
        assert restored[0].base_dir == local_root / "same-name"
        assert restored[0].source != "managed"


def test_project_path_that_only_looks_managed_has_no_enterprise_precedence(
    tmp_path: Path,
    monkeypatch,
) -> None:
    home = tmp_path / "home"
    monkeypatch.setattr(skill_bundle_module.Path, "home", lambda: home)
    lookalike = tmp_path / "project" / ".agenticx" / "skills" / "enterprise-market" / "fake"
    lookalike.mkdir(parents=True)

    assert infer_skill_source(lookalike) != "managed"


def test_unmarked_directory_in_real_managed_root_has_no_enterprise_precedence(
    tmp_path: Path,
    monkeypatch,
) -> None:
    home = tmp_path / "home"
    monkeypatch.setattr(skill_bundle_module.Path, "home", lambda: home)
    unmarked = home / ".agenticx" / "skills" / "enterprise-market" / "manual-copy"
    _write_skill(unmarked.parent, unmarked.name, "manual copy", "# Manual")

    assert infer_skill_source(unmarked) != "managed"


def test_frontmatter_cannot_self_declare_managed_precedence(tmp_path: Path) -> None:
    skill_root = tmp_path / "skills"
    _write_skill(
        skill_root,
        "manual-copy",
        "manual copy",
        "# Manual",
        source="managed",
    )

    assert resolve_skill_source(
        skill_root / "manual-copy",
        "---\nname: manual-copy\nsource: managed\n---",
    ) != "managed"


def test_infer_skill_source_recognizes_skillhub_home_path(tmp_path: Path, monkeypatch) -> None:
    home = tmp_path / "home"
    skill_dir = home / "skills" / "frontend-slides"
    skill_dir.mkdir(parents=True)
    monkeypatch.setattr(skill_bundle_module.Path, "home", lambda: home)

    source = infer_skill_source(skill_dir)

    assert source == "skillhub"


def test_infer_skill_source_keeps_cursor_label_for_symlinked_skillhub_dir(
    tmp_path: Path,
    monkeypatch,
) -> None:
    home = tmp_path / "home"
    real_skill_dir = home / "skills" / "frontend-slides"
    cursor_root = home / ".cursor" / "skills"
    cursor_root.mkdir(parents=True)
    real_skill_dir.mkdir(parents=True)
    linked_skill_dir = cursor_root / "frontend-slides"
    linked_skill_dir.symlink_to(real_skill_dir, target_is_directory=True)
    monkeypatch.setattr(skill_bundle_module.Path, "home", lambda: home)

    source = infer_skill_source(linked_skill_dir)

    assert source == "cursor"


def test_resolve_skill_source_prefers_frontmatter_over_path(tmp_path: Path) -> None:
    skill_dir = tmp_path / ".agenticx" / "skills" / "ui-design"
    skill_dir.mkdir(parents=True)
    content = (
        "---\n"
        "name: ui-design\n"
        "description: third-party ui skill\n"
        "source: skillhub\n"
        "---\n\n"
        "# UI design\n"
    )
    (skill_dir / "SKILL.md").write_text(content, encoding="utf-8")

    loader = SkillBundleLoader(search_paths=[skill_dir.parent])
    meta = loader._parse_skill_md(skill_dir / "SKILL.md", skill_dir, "global")

    assert meta is not None
    assert meta.source == "skillhub"
    assert resolve_skill_source(skill_dir, "---\nname: ui-design\nsource: skillhub\n---") == "skillhub"


def test_resolve_skill_source_reads_provenance_sidecar(tmp_path: Path) -> None:
    from agenticx.skills.frontmatter import write_skill_provenance

    skill_dir = tmp_path / ".agenticx" / "skills" / "tencent-meeting-mcp"
    skill_dir.mkdir(parents=True)
    content = (
        "---\n"
        "name: tencent-meeting-mcp\n"
        "description: meeting skill\n"
        "---\n\n"
        "# Meeting\n"
    )
    (skill_dir / "SKILL.md").write_text(content, encoding="utf-8")
    write_skill_provenance(skill_dir, "skillhub")

    loader = SkillBundleLoader(search_paths=[skill_dir.parent])
    meta = loader._parse_skill_md(skill_dir / "SKILL.md", skill_dir, "global")

    assert meta is not None
    assert meta.source == "skillhub"
