"""Narrow regressions for turn safety boundaries and internal history."""

from __future__ import annotations

import asyncio
import json
import subprocess
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

from agenticx.cli import agent_tools
from agenticx.runtime.private_workspace import ensure_private_workspace
from agenticx.runtime import turn_lifecycle as turn_lifecycle_module
from agenticx.runtime.turn_lifecycle import (
    TurnAlreadyRunning,
    TurnCheckpointMissing,
    TurnLifecycleStore,
)


def _session(workspace: Path) -> SimpleNamespace:
    return SimpleNamespace(
        workspace_dir=str(workspace),
        taskspaces=[],
        chat_history=[],
        agent_messages=[],
        artifacts={},
        scratchpad={},
    )


def _complete_turn(store: TurnLifecycleStore, session: SimpleNamespace, turn_id: str = "turn-1"):
    handle = store.begin("sid", turn_id, session=session)
    session.chat_history.append({"role": "user", "content": turn_id})
    session.agent_messages.append({"role": "user", "content": turn_id})
    session.chat_history.append({"role": "assistant", "content": "done"})
    session.agent_messages.append({"role": "assistant", "content": "done"})
    store.finalize("sid", handle.turn_id, session=session)
    return handle


@pytest.mark.asyncio
async def test_owned_background_writer_disables_listing_and_rewind(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    source = workspace / "source.md"
    source.write_text("before\n", encoding="utf-8")
    session = _session(workspace)
    active = [{"job_id": "job-1", "reason": "owned background writer is active"}]
    store = TurnLifecycleStore(
        tmp_path / "sessions",
        active_writer_checker=lambda _sid: active,
    )

    _complete_turn(store, session)

    row = store.list_turns("sid")[0]
    assert row["can_undo"] is False
    assert "background writer" in row["reason"]
    with pytest.raises(TurnAlreadyRunning, match="background writer"):
        await store.rewind_async("sid", "turn-1", session=session, persist_async=lambda: asyncio.sleep(0, result=True))


def test_background_reservation_blocks_rewind_but_not_next_begin(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    session = _session(workspace)
    store = TurnLifecycleStore(tmp_path / "sessions")
    _complete_turn(store, session)

    TurnLifecycleStore.reserve_background_writer("sid", "pending-job")
    try:
        assert store.list_turns("sid")[0]["can_undo"] is False
        # A normal next turn remains available so it can call bash_bg_stop.
        next_handle = store.begin("sid", "turn-2", session=session)
        store.finalize("sid", next_handle.turn_id, session=session, status="failed")
    finally:
        TurnLifecycleStore.release_background_writer("sid", "pending-job")


def test_background_writer_gate_is_process_wide_across_sessions(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    session_a = _session(workspace)
    active_rows = [
        {
            "job_id": "session-b-job",
            "session_id": "sid-b",
            "cwd": str(workspace),
            "reason": "owned background writer is active",
        }
    ]
    store = TurnLifecycleStore(
        tmp_path / "sessions",
        active_writer_checker=lambda requested_sid: active_rows if requested_sid is None else [],
    )
    handle = store.begin("sid-a", "turn-1", session=session_a)
    session_a.chat_history.extend(
        [
            {"role": "user", "content": "turn-1"},
            {"role": "assistant", "content": "done"},
        ]
    )
    session_a.agent_messages.extend(session_a.chat_history)
    store.finalize("sid-a", handle.turn_id, session=session_a)

    listed = store.list_turns("sid-a")
    assert listed[0]["can_undo"] is False
    assert "session-b-job" in listed[0]["reason"]
    with pytest.raises(TurnAlreadyRunning, match="background writer"):
        store.rewind(
            "sid-a",
            "turn-1",
            session=session_a,
            persist=lambda: True,
        )

    # A normal turn still needs to be able to call bash_bg_stop.
    next_handle = store.begin("sid-a", "turn-2", session=session_a)
    store.finalize("sid-a", next_handle.turn_id, session=session_a, status="failed")


def test_background_start_is_rejected_during_any_session_rewind(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    other_workspace = tmp_path / "other-workspace"
    other_workspace.mkdir()
    store = TurnLifecycleStore(tmp_path / "sessions")
    owner = "rewind:sid-a:turn-1"
    keys = store._acquire_workspace_locks(
        [workspace],
        owner,
        session_id="sid-a",
        reserve_session=True,
    )
    try:
        with pytest.raises(TurnAlreadyRunning, match="turn rewind"):
            TurnLifecycleStore.reserve_background_writer("sid-b", "pending-job")
        # The transaction still does not consume the ordinary next-turn path;
        # a non-overlapping workspace may begin while the rewind is active.
        other_session = _session(other_workspace)
        next_handle = store.begin("sid-b", "turn-1", session=other_session)
        store.finalize("sid-b", next_handle.turn_id, session=other_session, status="failed")
    finally:
        store._release_workspace_locks(keys, owner, session_id="sid-a")


def test_unstable_snapshot_is_incomplete(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    target = workspace / "source.md"
    target.write_text("before\n", encoding="utf-8")
    store = TurnLifecycleStore(tmp_path / "sessions")
    private = ensure_private_workspace("sid", "turn-1", root=tmp_path / "sessions")
    original_read_bytes = Path.read_bytes

    def race_read(path: Path) -> bytes:
        if path == target:
            target.write_text("changed while read\n", encoding="utf-8")
        return original_read_bytes(path)

    monkeypatch.setattr(Path, "read_bytes", race_read)
    skipped: list[str] = []
    observations: dict[str, dict[str, object]] = {}
    records, _ = store._snapshot_files(
        private,
        [target],
        label="before",
        skipped=skipped,
        unsupported=[],
        skipped_records=observations,
    )

    assert str(target) not in records
    assert any("changed while snapshotting" in item for item in skipped)
    assert observations[str(target)]["reliable"] is False


def test_external_explicit_artifact_is_never_snapshotted_or_deleted(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    outside = tmp_path / "outside.md"
    outside.write_text("external", encoding="utf-8")
    session = _session(workspace)
    session.artifacts[outside] = "external"
    store = TurnLifecycleStore(tmp_path / "sessions")

    handle = store.begin("sid", "turn-1", session=session, explicit_paths=[outside])
    manifest = json.loads(handle.private.manifest_path.read_text(encoding="utf-8"))
    assert str(outside) not in manifest["before_files"]
    outside.write_text("changed external", encoding="utf-8")
    store.finalize("sid", handle.turn_id, session=session)
    assert outside.read_text(encoding="utf-8") == "changed external"


def test_private_execution_symlink_is_rejected_before_resolve(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    private = ensure_private_workspace("sid", "turn-1", root=tmp_path / "sessions")
    private.scratch.rmdir()
    private.scratch.symlink_to(outside, target_is_directory=True)
    session = _session(workspace)
    session._private_execution_root = str(private.scratch)

    with pytest.raises(ValueError, match="symlink|safe"):
        agent_tools._resolve_workspace_path("new.md", session, for_write=True)


def test_abort_marks_checkpoint_unavailable_and_releases_writer(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    session = _session(workspace)
    store = TurnLifecycleStore(tmp_path / "sessions")
    handle = store.begin("sid", "turn-1", session=session)

    failed = store.abort("sid", handle.turn_id, reason="persist failed")
    assert failed["status"] == "failed"
    assert failed["checkpoint_complete"] is False
    assert store.list_turns("sid")[0]["can_undo"] is False

    next_handle = store.begin("sid", "turn-2", session=session)
    store.finalize("sid", next_handle.turn_id, session=session, status="failed")


def test_oversized_manifest_is_bounded_and_never_undoable(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """A legacy giant manifest must not be loaded or silently made undoable."""

    workspace = tmp_path / "workspace"
    workspace.mkdir()
    session = _session(workspace)
    store = TurnLifecycleStore(tmp_path / "sessions")
    private = ensure_private_workspace("sid", "legacy-turn", root=tmp_path / "sessions")
    monkeypatch.setattr(turn_lifecycle_module, "MAX_MANIFEST_BYTES", 128)
    oversized = b"{" + b"\"before_files\":{\"x\":\"" + b"a" * 256
    private.manifest_path.write_bytes(oversized)

    marker = store._read_manifest("sid", "legacy-turn")
    assert marker is not None
    assert marker["manifest_unreadable"] is True
    assert marker["checkpoint_complete"] is False
    assert marker["manifest_size_bytes"] == len(oversized)

    row = store.list_turns("sid")[0]
    assert row["turn_id"] == "legacy-turn"
    assert row["can_undo"] is False
    assert "safe metadata limit" in row["reason"]
    with pytest.raises(TurnCheckpointMissing, match="safe metadata limit"):
        store.rewind("sid", "legacy-turn", session=session, persist=lambda: True)


def test_unreadable_later_manifest_blocks_rewind_of_earlier_turn(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    session = _session(workspace)
    store = TurnLifecycleStore(tmp_path / "sessions")
    _complete_turn(store, session, "first")
    private = ensure_private_workspace("sid", "later", root=tmp_path / "sessions")
    monkeypatch.setattr(turn_lifecycle_module, "MAX_MANIFEST_BYTES", 128)
    private.manifest_path.write_bytes(b"{" + b"\"before_files\":{\"x\":\"" + b"a" * 256)

    row = next(item for item in store.list_turns("sid") if item["turn_id"] == "first")
    assert row["can_undo"] is False
    with pytest.raises(TurnCheckpointMissing):
        store.rewind("sid", "first", session=session, persist=lambda: True)


def test_manifest_scan_has_aggregate_byte_budget(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """Many valid manifests cannot turn one metadata lookup into an unbounded read."""

    store = TurnLifecycleStore(tmp_path / "sessions")
    for turn_id in ("first", "second", "third"):
        private = ensure_private_workspace("sid", turn_id, root=tmp_path / "sessions")
        private.manifest_path.write_text(
            json.dumps({
                "session_id": "sid",
                "turn_id": turn_id,
                "status": "completed",
                "created_at": 1,
            }),
            encoding="utf-8",
        )

    monkeypatch.setattr(turn_lifecycle_module, "MAX_MANIFEST_SCAN_BYTES", 100)
    calls: list[str] = []

    def _read_manifest(_session_id: str, turn_id: str) -> dict[str, object]:
        calls.append(turn_id)
        return {"session_id": "sid", "turn_id": turn_id, "status": "completed", "created_at": 1}

    monkeypatch.setattr(store, "_read_manifest", _read_manifest)
    store._iter_manifests("sid")
    assert len(calls) <= 1


def test_workspace_discovery_is_bounded_and_marks_truncation(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    for index in range(20):
        (workspace / f"file-{index}.txt").write_text(str(index), encoding="utf-8")
    store = TurnLifecycleStore(
        tmp_path / "sessions",
        max_discovery_entries=8,
        max_discovery_candidates=4,
        max_discovery_seconds=5,
    )

    paths, skipped, _unsupported, _git_roots = store._discover_paths([workspace])

    assert len(paths) <= 4
    assert "<discovery-budget-exhausted>" in skipped


def test_skipped_observation_budget_uses_unknown_sentinel(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    paths = []
    for index in range(8):
        path = workspace / f"file-{index}.txt"
        path.write_text(str(index), encoding="utf-8")
        paths.append(path)
    store = TurnLifecycleStore(
        tmp_path / "sessions",
        max_files=1,
        max_skipped_observations=2,
        max_skipped_observation_seconds=5,
        max_discovery_candidates=32,
    )
    private = ensure_private_workspace("sid", "turn-1", root=tmp_path / "sessions")
    skipped: list[str] = []
    unsupported: list[str] = []
    observations: dict[str, dict[str, object]] = {}
    calls = 0
    original_observe = store._observe_state

    def observe(path: Path, **kwargs: object) -> dict[str, object]:
        nonlocal calls
        calls += 1
        return original_observe(path, **kwargs)

    monkeypatch.setattr(store, "_observe_state", observe)
    budget = store._new_observation_budget()
    store._snapshot_files(
        private,
        paths,
        label="before",
        skipped=skipped,
        unsupported=unsupported,
        skipped_records=observations,
        observation_budget=budget,
    )

    assert calls <= 2
    assert budget.exhausted is True
    assert "<skipped-observation-budget-exhausted>" in skipped
    assert len(observations) <= 2


def test_manifest_write_overflow_becomes_compact_incomplete_marker(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    store = TurnLifecycleStore(tmp_path / "sessions")
    private = ensure_private_workspace("sid", "turn-1", root=tmp_path / "sessions")
    monkeypatch.setattr(turn_lifecycle_module, "MAX_MANIFEST_BYTES", 128)
    manifest: dict[str, object] = {
        "session_id": "sid",
        "turn_id": "turn-1",
        "status": "completed",
        "before_files": {"/tmp/file": "x" * 1024},
    }

    store._write_manifest(manifest)

    assert private.manifest_path.stat().st_size <= 128
    written = json.loads(private.manifest_path.read_text(encoding="utf-8"))
    assert written["checkpoint_complete"] is False
    assert written["manifest_unreadable"] is True
    assert manifest["checkpoint_complete"] is False


def test_subagent_history_is_restored_by_same_turn_transaction(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    history = tmp_path / "sessions" / "sid" / "subagent_runs"
    history.mkdir(parents=True)
    index = history / "index.json"
    activity = history / "run-1.activity.jsonl"
    record = history / "run-1.json"
    index.write_text('{"runs":{"run-1":{"summary":"old"}}}\n', encoding="utf-8")
    record.write_text('{"run_id":"run-1","result_summary":"old"}\n', encoding="utf-8")
    activity.write_text('{"detail":"old"}\n', encoding="utf-8")
    session = _session(workspace)
    store = TurnLifecycleStore(tmp_path / "sessions")

    handle = store.begin("sid", "turn-1", session=session)
    index.write_text('{"runs":{"run-1":{"summary":"new"},"run-2":{}}}\n', encoding="utf-8")
    record.write_text('{"run_id":"run-1","result_summary":"new"}\n', encoding="utf-8")
    activity.write_text('{"detail":"new"}\n', encoding="utf-8")
    store.finalize("sid", handle.turn_id, session=session)
    store.rewind("sid", handle.turn_id, session=session, persist=lambda: True)

    assert json.loads(index.read_text(encoding="utf-8"))["runs"]["run-1"]["summary"] == "old"
    assert json.loads(record.read_text(encoding="utf-8"))["result_summary"] == "old"
    assert activity.read_text(encoding="utf-8") == '{"detail":"old"}\n'


def test_malformed_before_record_preserves_live_file(
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    first = workspace / "a.md"
    malformed = workspace / "z.md"
    first.write_text("before-a\n", encoding="utf-8")
    malformed.write_text("before-z\n", encoding="utf-8")
    session = _session(workspace)
    store = TurnLifecycleStore(tmp_path / "sessions")

    handle = store.begin("sid", "turn-1", session=session)
    first.write_text("after-a\n", encoding="utf-8")
    malformed.write_text("after-z\n", encoding="utf-8")
    session.chat_history.extend(
        [
            {"role": "user", "content": "turn-1"},
            {"role": "assistant", "content": "done"},
        ]
    )
    session.agent_messages.extend(session.chat_history)
    store.finalize("sid", handle.turn_id, session=session)

    manifest = store._read_manifest("sid", handle.turn_id)
    assert manifest is not None
    manifest["before_files"][str(malformed)] = {"kind": "file"}
    store._write_manifest(manifest)

    with pytest.raises(TurnCheckpointMissing, match="before_files record is malformed"):
        store.rewind("sid", handle.turn_id, session=session, persist=lambda: True)
    assert first.read_text(encoding="utf-8") == "after-a\n"
    assert malformed.read_text(encoding="utf-8") == "after-z\n"


def test_git_identity_overflow_is_unknown_and_not_partial_hash(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "init", "-q", str(repo)], check=True)
    tracked = repo / "tracked.md"
    tracked.write_text("tracked\n", encoding="utf-8")
    subprocess.run(["git", "-C", str(repo), "add", "tracked.md"], check=True)
    subprocess.run(
        [
            "git",
            "-C",
            str(repo),
            "-c",
            "user.name=AgenticX Test",
            "-c",
            "user.email=agenticx@example.invalid",
            "commit",
            "-qm",
            "initial",
        ],
        check=True,
    )
    store = TurnLifecycleStore(tmp_path / "sessions")

    complete = store._git_identity(repo, max_output_bytes=1024 * 1024)
    assert complete["reliable"] is True
    capped = store._git_identity(repo, max_output_bytes=1)
    assert capped["reliable"] is False
    assert capped["index"] == ""


def test_git_files_reaps_process_after_timeout(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    class FakeStdout:
        def close(self) -> None:
            return None

    class FakeProcess:
        def __init__(self) -> None:
            self.stdout = FakeStdout()
            self.returncode: int | None = None
            self.kills = 0
            self.waits = 0

        def kill(self) -> None:
            self.kills += 1

        def wait(self, timeout: float) -> int:
            self.waits += 1
            if self.waits == 1:
                raise subprocess.TimeoutExpired("git", timeout)
            self.returncode = -9
            return self.returncode

    process = FakeProcess()
    monkeypatch.setattr(
        turn_lifecycle_module.subprocess,
        "Popen",
        lambda *args, **kwargs: process,
    )
    budget = turn_lifecycle_module._DiscoveryBudget(
        max_entries=8,
        max_candidates=8,
        deadline=time.monotonic() - 1,
    )

    paths = TurnLifecycleStore._git_files(tmp_path, tmp_path, budget=budget)

    assert paths == []
    assert process.kills >= 1
    assert process.waits == 2


def test_manifest_scan_oserror_marks_history_incomplete(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    store = TurnLifecycleStore(tmp_path / "sessions")
    turns_root = store._session_root("sid") / "turns"
    turns_root.mkdir(parents=True)
    original_iterdir = Path.iterdir

    def fail_scan(path: Path):
        if path == turns_root:
            raise OSError("simulated manifest directory failure")
        return original_iterdir(path)

    monkeypatch.setattr(Path, "iterdir", fail_scan)
    rows = store._iter_manifests("sid")

    assert rows[-1]["manifest_scan_error"] is True
    assert rows[-1]["manifest_scan_truncated"] is True
    assert store._latest_active_manifest("sid") is None
    assert store.list_turns("sid") == []
