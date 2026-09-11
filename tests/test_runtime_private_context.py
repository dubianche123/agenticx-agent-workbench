"""Regression coverage for parent/child private execution context."""

from __future__ import annotations

from pathlib import Path

from agenticx.cli.studio import StudioSession
from agenticx.runtime.team_manager import AgentTeamManager


def test_child_inherits_private_turn_and_returns_new_deliverables(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    base = StudioSession(workspace_dir=str(workspace))
    base.artifacts = {}
    base._session_id = "parent-session"
    base._active_turn_id = "turn-1"
    base._private_workspace_root = str(tmp_path / "private" / "turn-1")
    base._private_execution_root = str(tmp_path / "private" / "turn-1" / "scratch")

    # The output handoff is deliberately tested without starting an LLM task.
    manager = AgentTeamManager.__new__(AgentTeamManager)
    manager.base_session = base
    child = manager._build_isolated_session(workspace_dir=str(workspace))

    assert child._session_id == base._session_id
    assert child._active_turn_id == base._active_turn_id
    assert child._private_workspace_root == base._private_workspace_root
    assert child._private_execution_root == base._private_execution_root

    output = Path(base._private_workspace_root) / "outputs" / "child.md"
    child.artifacts[output] = "child document"
    child._turn_deliverables = [{"path": str(output), "format": "md"}]
    manager._merge_child_turn_outputs(child, {})

    assert base.artifacts[output] == "child document"
    assert base._turn_deliverables == [{"path": str(output), "format": "md"}]
    assert child._turn_deliverables == []
