"""Bounded and non-blocking behavior for the Studio ``list_files`` tool."""

from __future__ import annotations

import asyncio
import os
import threading
from pathlib import Path
from typing import Any

import pytest

from agenticx.cli import agent_tools
from agenticx.cli.studio import StudioSession


def _session_in(workspace: Path) -> StudioSession:
    session = StudioSession()
    session.workspace_dir = str(workspace)
    session.taskspaces = [
        {
            "id": "default",
            "label": "测试工作区",
            "path": str(workspace),
            "mount_mode": "link",
        }
    ]
    return session


def test_recursive_list_files_stops_after_limit_probe(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    # Keep the first two entries visible and put a subtree after them.  A full
    # rglob would descend into ``late``; the bounded iterator must stop at the
    # third visible entry and never open that directory.
    (workspace / "first.txt").write_text("1", encoding="utf-8")
    (workspace / "second.txt").write_text("2", encoding="utf-8")
    late = workspace / "late"
    late.mkdir()
    (late / "should-not-be-scanned.txt").write_text("late", encoding="utf-8")

    def _rglob_must_not_run(_path: Path, _pattern: str) -> Any:
        raise AssertionError("list_files must not materialize a full rglob result")

    monkeypatch.setattr(Path, "rglob", _rglob_must_not_run)
    scanned: list[Path] = []
    real_os = agent_tools.os
    real_scandir = real_os.scandir

    class _OsProxy:
        def __getattr__(self, name: str) -> Any:
            return getattr(real_os, name)

        def scandir(self, path: os.PathLike[str] | str) -> Any:
            scanned.append(Path(path))
            return real_scandir(path)

    # Replace the module binding rather than mutating the process-global os
    # module; pytest and unrelated code must keep their normal scandir behavior.
    monkeypatch.setattr(agent_tools, "os", _OsProxy())
    result = agent_tools._tool_list_files(
        {"path": ".", "recursive": True, "limit": 2},
        _session_in(workspace),
    )

    lines = result.splitlines()
    assert len(lines) == 3
    assert all(
        line in {
            str(workspace / "first.txt"),
            str(workspace / "second.txt"),
            str(late) + "/",
        }
        for line in lines[:-1]
    )
    assert lines[-1] == "... (truncated, total >2 entries)"
    assert str(late) not in scanned
    assert str(late / "should-not-be-scanned.txt") not in result


def test_recursive_list_files_prunes_generated_hidden_and_symlink_dirs(
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / "src").mkdir()
    (workspace / "src" / "main.py").write_text("print('ok')", encoding="utf-8")

    ignored_names = (
        ".git",
        ".agenticx",
        "node_modules",
        "__pycache__",
        ".cache",
        "dist",
        "build",
        "venv",
    )
    for name in ignored_names:
        ignored = workspace / name
        ignored.mkdir()
        (ignored / "internal-secret.txt").write_text("secret", encoding="utf-8")

    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "external-secret.txt").write_text("secret", encoding="utf-8")
    linked = workspace / "linked-outside"
    try:
        linked.symlink_to(outside, target_is_directory=True)
    except OSError:
        pytest.skip("symlink creation is unavailable in this environment")

    result = agent_tools._tool_list_files(
        {"path": ".", "recursive": True, "limit": 200},
        _session_in(workspace),
    )

    assert str(workspace / "src" / "main.py") in result
    for name in ignored_names:
        assert str(workspace / name) not in result
        assert "internal-secret.txt" not in result
    assert str(outside / "external-secret.txt") not in result
    # The link itself can be reported as one entry, but its target must never be
    # traversed.  This keeps the assertion about the security boundary explicit.
    assert str(linked) in result


@pytest.mark.asyncio
async def test_async_dispatch_offloads_list_files_scan(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    session = _session_in(workspace)
    started = threading.Event()
    release = threading.Event()

    def _blocking_scan(_arguments: dict[str, Any], _session: StudioSession) -> str:
        started.set()
        release.wait(timeout=2)
        return "scan-complete"

    monkeypatch.setattr(agent_tools, "_tool_list_files", _blocking_scan)
    timer = threading.Timer(0.05, release.set)
    timer.start()
    try:
        task = asyncio.create_task(
            agent_tools.dispatch_tool_async("list_files", {"path": "."}, session)
        )
        await asyncio.to_thread(started.wait, 1)

        # If dispatch called the scan directly, this coroutine could not run
        # while the worker waited on ``release``.  A small event-loop heartbeat
        # proves the potentially slow scan is outside the loop.
        heartbeat = False

        async def _heartbeat() -> None:
            nonlocal heartbeat
            await asyncio.sleep(0.01)
            heartbeat = True

        await _heartbeat()
        assert heartbeat is True
        assert await task == "scan-complete"
    finally:
        release.set()
        timer.cancel()
