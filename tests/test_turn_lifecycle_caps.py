"""Coverage for incomplete checkpoints when file snapshot caps are hit."""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest

from agenticx.runtime.turn_lifecycle import TurnConflictError, TurnLifecycleStore


def _session(workspace: Path) -> SimpleNamespace:
    return SimpleNamespace(
        workspace_dir=str(workspace),
        taskspaces=[],
        chat_history=[{"role": "user", "content": "edit"}],
        agent_messages=[{"role": "user", "content": "edit"}],
        artifacts={},
    )


@pytest.mark.asyncio
async def test_skipped_before_file_is_tombstoned_and_blocks_undo_when_changed(
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    source = workspace / "source.py"
    source.write_text("baseline\n", encoding="utf-8")
    session = _session(workspace)
    store = TurnLifecycleStore(
        tmp_path / "private",
        max_file_bytes=5,
        max_total_bytes=1024,
        max_files=20,
    )

    handle = store.begin("caps", "turn-1", session=session)
    source.write_text("x", encoding="utf-8")
    manifest = store.finalize("caps", handle.turn_id, session=session)

    assert str(source) in manifest["skipped_before"]
    assert manifest["skipped_before"][str(source)]["exists"] is True
    assert manifest["skipped_before"][str(source)]["sha256"]
    assert str(source) in manifest["skipped_changed_paths"]
    row = store.list_turns("caps")[0]
    assert row["can_undo"] is False
    assert "skipped" in row["reason"]
    with pytest.raises(TurnConflictError, match="skipped workspace paths"):
        await store.rewind_async("caps", handle.turn_id, session=session)
    assert source.read_text(encoding="utf-8") == "x"


@pytest.mark.asyncio
async def test_skipped_before_file_unchanged_does_not_block_other_file_undo(
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    source = workspace / "source.py"
    source.write_text("baseline\n", encoding="utf-8")
    small = workspace / "README.md"
    small.write_text("old\n", encoding="utf-8")
    session = _session(workspace)
    store = TurnLifecycleStore(
        tmp_path / "private",
        max_file_bytes=5,
        max_total_bytes=1024,
        max_files=20,
    )

    handle = store.begin("caps", "turn-1", session=session)
    small.write_text("new\n", encoding="utf-8")
    manifest = store.finalize("caps", handle.turn_id, session=session)
    assert manifest["checkpoint_complete"] is True

    await store.rewind_async("caps", handle.turn_id, session=session)
    assert source.read_text(encoding="utf-8") == "baseline\n"
    assert small.read_text(encoding="utf-8") == "old\n"
