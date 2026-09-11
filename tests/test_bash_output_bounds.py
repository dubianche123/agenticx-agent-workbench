"""Real subprocess coverage for bounded bash output and cancellation cleanup."""

from __future__ import annotations

import asyncio
import os
import shlex
import signal
import sys
import time
import tracemalloc
from pathlib import Path
from types import SimpleNamespace

import pytest

from agenticx.cli import agent_tools
from agenticx.cli.studio import StudioSession
from agenticx.runtime.private_workspace import ensure_private_workspace


@pytest.fixture
def real_passthrough_runtime(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Path:
    """Use the real subprocess reader with a deterministic test sandbox plan."""

    async def _yes(*_args: object, **_kwargs: object) -> bool:
        return True

    monkeypatch.setattr(agent_tools, "_confirm", _yes)
    monkeypatch.setattr(
        agent_tools,
        "build_command_sandbox_plan",
        lambda argv, *, permissions, **_kwargs: SimpleNamespace(
            argv=tuple(argv),
            env=os.environ.copy(),
            permissions=agent_tools.normalize_command_permissions(permissions),
            backend="test-passthrough",
        ),
    )
    monkeypatch.setenv("AGX_HOME", str(tmp_path / "agx-home"))
    return tmp_path


def _managed_test_session(root: Path) -> tuple[StudioSession, Path]:
    session = StudioSession()
    session.workspace_dir = str(root / "workspace")
    Path(session.workspace_dir).mkdir(parents=True, exist_ok=True)
    session_id = "bash-output-stress"
    turn_id = "stress-turn"
    private = ensure_private_workspace(session_id, turn_id)
    setattr(session, "_session_id", session_id)
    setattr(session, "_active_turn_id", turn_id)
    setattr(session, "_private_workspace_root", str(private.root))
    setattr(session, "_private_execution_root", str(private.scratch))
    return session, private.scratch


@pytest.mark.asyncio
async def test_bash_exec_keeps_complete_16mb_streams_in_log_and_bounded_return(
    real_passthrough_runtime: Path,
) -> None:
    session, scratch = _managed_test_session(real_passthrough_runtime)
    size = 16 * 1024 * 1024
    # There are deliberately no newlines.  A readline/async-for reader would
    # allocate one giant line; the production path must consume fixed chunks.
    code = (
        "import sys;"
        f"sys.stdout.write('o' * {size});"
        f"sys.stderr.write('e' * {size})"
    )
    command = f"{shlex.quote(sys.executable)} -c {shlex.quote(code)}"

    tracemalloc.start()
    before_current, before_peak = tracemalloc.get_traced_memory()
    result = await agent_tools._tool_bash_exec(
        {"command": command, "timeout_sec": 30},
        session,
        confirm_gate=SimpleNamespace(),
    )
    after_current, after_peak = tracemalloc.get_traced_memory()
    tracemalloc.stop()
    peak_delta = max(0, after_peak - before_current)
    print(
        f"bash_output_stress peak_bytes={after_peak} peak_delta={peak_delta} "
        f"current_delta={after_current - before_current} prior_peak={before_peak}"
    )

    assert "exit_code=0" in result
    assert len(result) < 100_000
    assert "o" * 128 in result
    assert "e" * 128 in result
    # The peak is substantially below the 32 MiB emitted payload.  This is a
    # guard against accidentally reintroducing readline or ``communicate``.
    assert peak_delta < 24 * 1024 * 1024

    marker = "output_log="
    log_name = result.split(marker, 1)[1].splitlines()[0].strip()
    log_path = Path(log_name)
    assert log_path.parent == scratch.parent / "logs"
    assert log_path.stat().st_size == size * 2
    counts = {"o": 0, "e": 0}
    with log_path.open("rb") as handle:
        while chunk := handle.read(64 * 1024):
            counts["o"] += chunk.count(b"o")
            counts["e"] += chunk.count(b"e")
    assert counts == {"o": size, "e": size}


@pytest.mark.asyncio
async def test_bash_exec_cancellation_terminates_and_reaps_child(
    real_passthrough_runtime: Path,
) -> None:
    session, scratch = _managed_test_session(real_passthrough_runtime)
    grandchild = (
        "import os,pathlib,signal,time;"
        "signal.signal(signal.SIGTERM, signal.SIG_IGN);"
        "pathlib.Path('child.pid').write_text(str(os.getpid()));"
        "time.sleep(2);pathlib.Path('late.txt').write_text('late');time.sleep(10)"
    )
    # The immediate Python parent exits at once.  The grandchild inherits the
    # pipes, so the tool is still waiting when cancellation arrives even though
    # proc.returncode is already set; process-group cleanup must still stop it.
    code = f"import subprocess,sys;subprocess.Popen([sys.executable,'-c',{grandchild!r}])"
    command = f"{shlex.quote(sys.executable)} -c {shlex.quote(code)}"
    task = asyncio.create_task(
        agent_tools._tool_bash_exec(
            {"command": command, "timeout_sec": 30},
            session,
            confirm_gate=SimpleNamespace(),
        )
    )
    pid_path = scratch / "child.pid"
    deadline = time.monotonic() + 3
    while not pid_path.exists() and time.monotonic() < deadline:
        await asyncio.sleep(0.02)
    assert pid_path.exists()
    child_pid = int(pid_path.read_text(encoding="utf-8"))
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    await asyncio.sleep(0.1)
    with pytest.raises(ProcessLookupError):
        os.kill(child_pid, 0)
    assert not (scratch / "late.txt").exists()
