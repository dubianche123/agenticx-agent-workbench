#!/usr/bin/env python3
"""Per-task isolated workspace paths with safety invariants.

Author: Damon Li
"""

from __future__ import annotations

import re
import shutil
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Optional

from agenticx.utils.agx_home import agx_home

# Kept as a test/configuration override for callers that used to monkeypatch
# this public module attribute.  Production defaults are resolved lazily so a
# process can switch AGX_HOME without an import-time path leak.
DEFAULT_TASK_WORKSPACE_ROOT: Optional[Path] = None


def _default_task_workspace_root() -> Path:
    override = DEFAULT_TASK_WORKSPACE_ROOT
    return Path(override) if override is not None else agx_home() / "task-workspaces"


class TaskWorkspaceSecurityError(Exception):
    """Resolved workspace path is invalid or escapes configured root."""


class TaskWorkspaceHookError(Exception):
    """A fatal lifecycle hook failed."""


@dataclass
class TaskWorkspaceConfig:
    root: Path = field(default_factory=_default_task_workspace_root)
    hook_timeout_sec: float = 60.0
    cleanup_on_remove: bool = True


class TaskWorkspace:
    """One disposable directory under ``root`` per logical ``task_id``.

    Mirrors Symphony ``workspace.ex`` path checks (must stay under root, cannot equal root).
    """

    def __init__(
        self,
        task_id: str,
        config: Optional[TaskWorkspaceConfig] = None,
        *,
        _resolve_root: Optional[Callable[[Path], Path]] = None,
    ) -> None:
        self.task_id = str(task_id or "").strip()
        self.config = config or TaskWorkspaceConfig()
        self._resolve_root = _resolve_root or (lambda p: p.expanduser().resolve(strict=False))
        self.path = self._resolve_path()

    def _resolve_path(self) -> Path:
        safe_id = re.sub(r"[^A-Za-z0-9._-]", "_", self.task_id).strip("._-")
        if not safe_id:
            raise TaskWorkspaceSecurityError(f"task_id sanitizes to empty: {self.task_id!r}")
        root = self._resolve_root(Path(self.config.root))
        root.mkdir(parents=True, exist_ok=True)
        canonical_root = self._resolve_root(root)
        ws_joined = canonical_root / safe_id
        canonical_ws = self._resolve_root(ws_joined)
        if canonical_ws == canonical_root:
            raise TaskWorkspaceSecurityError(f"workspace equals root: {canonical_ws}")
        try:
            canonical_ws.relative_to(canonical_root)
        except ValueError as exc:
            raise TaskWorkspaceSecurityError(
                f"workspace outside root: {canonical_ws} not under {canonical_root}"
            ) from exc
        return canonical_ws

    def create(self) -> TaskWorkspace:
        is_new = not self.path.exists()
        self.path.mkdir(parents=True, exist_ok=True)
        if is_new:
            from agenticx.longrun import task_hooks

            task_hooks.dispatch_task_workspace_event(
                "after_create",
                task_id=self.task_id,
                path=self.path,
                timeout_sec=self.config.hook_timeout_sec,
                fatal=False,
            )
        return self

    def prepare_for_run(self) -> None:
        if not self.path.exists():
            self.path.mkdir(parents=True, exist_ok=True)
        from agenticx.longrun import task_hooks

        task_hooks.dispatch_task_workspace_event(
            "before_run",
            task_id=self.task_id,
            path=self.path,
            timeout_sec=self.config.hook_timeout_sec,
            fatal=True,
        )

    def cleanup_after_run(self) -> None:
        if not self.path.exists():
            return
        from agenticx.longrun import task_hooks

        task_hooks.dispatch_task_workspace_event(
            "after_run",
            task_id=self.task_id,
            path=self.path,
            timeout_sec=self.config.hook_timeout_sec,
            fatal=False,
        )

    def remove(self) -> None:
        from agenticx.longrun import task_hooks

        task_hooks.dispatch_task_workspace_event(
            "before_remove",
            task_id=self.task_id,
            path=self.path,
            timeout_sec=self.config.hook_timeout_sec,
            fatal=False,
        )
        if self.config.cleanup_on_remove and self.path.exists():
            shutil.rmtree(self.path, ignore_errors=True)
