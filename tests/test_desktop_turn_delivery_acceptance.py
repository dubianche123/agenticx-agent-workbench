"""Independent acceptance for per-turn file/chat rewind.

These scenarios exercise user-visible recovery guarantees rather than mirroring
the checkpoint implementation. All repositories and session state are temporary.
"""

from __future__ import annotations

import asyncio
import copy
import json
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest

from agenticx.runtime.turn_lifecycle import (
    TurnAlreadyRunning,
    TurnCheckpointMissing,
    TurnConflictError,
    TurnLifecycleError,
    TurnLifecycleStore,
)


def _git(workspace: Path, *args: str) -> bytes:
    return subprocess.check_output(
        ["git", "-C", str(workspace), *args], stderr=subprocess.STDOUT
    )


def _setup(tmp_path: Path, *, git: bool = False, **limits):
    workspace = tmp_path / "selected"
    workspace.mkdir()
    if git:
        _git(workspace, "init", "-q")
        (workspace / "source.py").write_text("baseline\n")
        (workspace / "notes.md").write_text("original notes\n")
        _git(workspace, "add", ".")
        _git(
            workspace,
            "-c", "user.name=Acceptance",
            "-c", "user.email=acceptance@example.invalid",
            "-c", "commit.gpgsign=false",
            "commit", "-qm", "baseline",
        )
    session = SimpleNamespace(
        workspace_dir=str(workspace), taskspaces=[], chat_history=[],
        agent_messages=[], artifacts={}, scratchpad={}, context_files={},
    )
    store = TurnLifecycleStore(tmp_path / "sessions", **limits)
    return workspace, session, store


def _begin(store, session, turn_id="turn-1", **kwargs):
    handle = store.begin(
        "session-qa", turn_id, client_turn_id=turn_id, session=session, **kwargs
    )
    session.chat_history.append({
        "role": "user", "content": turn_id,
        "metadata": {"client_turn_id": turn_id},
    })
    session.agent_messages.append({"role": "user", "content": turn_id})
    return handle


def _finish(store, session, turn_id="turn-1"):
    session.chat_history.append({"role": "assistant", "content": "done"})
    session.agent_messages.append({"role": "assistant", "content": "done"})
    return store.finalize("session-qa", turn_id, session=session)


def test_only_latest_turn_restores_dirty_bytes_and_index(tmp_path):
    workspace, session, store = _setup(tmp_path, git=True)
    source = workspace / "source.py"
    source.write_text("staged user work\n")
    _git(workspace, "add", "source.py")
    source.write_text("unstaged user work\n")
    index_before = (workspace / ".git/index").read_bytes()
    _begin(store, session, "t1")
    source.write_text("agent first turn\n")
    (workspace / "notes.md").unlink()
    (workspace / "first.md").write_text("first deliverable")
    _finish(store, session, "t1")
    after_first_chat = copy.deepcopy(session.chat_history)
    _begin(store, session, "t2")
    source.write_text("agent second turn\n")
    (workspace / "second.html").write_text("<p>second deliverable</p>")
    _finish(store, session, "t2")

    with pytest.raises(TurnCheckpointMissing, match="most recent"):
        store.rewind("session-qa", "t1", session=session, persist=lambda: True)

    result = store.rewind("session-qa", "t2", session=session, persist=lambda: True)

    assert result["ok"] is True
    assert source.read_text() == "agent first turn\n"
    assert (workspace / ".git/index").read_bytes() == index_before
    assert not (workspace / "notes.md").exists()
    assert (workspace / "first.md").read_text() == "first deliverable"
    assert not (workspace / "second.html").exists()
    assert session.chat_history == after_first_chat
    assert session.agent_messages[-1]["content"] == "done"


def test_empty_non_git_workspace_can_undo_first_document_turn(tmp_path):
    workspace, session, store = _setup(tmp_path)
    _begin(store, session)
    for suffix in ("md", "html", "doc"):
        path = workspace / f"delivered.{suffix}"
        path.write_text("generated document")
        session.artifacts[path] = "generated document"
    _finish(store, session)

    assert store.list_turns("session-qa")[0]["can_undo"]
    store.rewind("session-qa", "turn-1", session=session, persist=lambda: True)

    assert list(workspace.iterdir()) == []
    assert session.chat_history == []
    assert session.artifacts == {}


@pytest.mark.parametrize("output_directory", ["exports", "build"])
def test_existing_generated_format_ignored_by_git_is_never_deleted_on_undo(tmp_path, output_directory):
    workspace, session, store = _setup(tmp_path, git=True)
    (workspace / ".gitignore").write_text(f"{output_directory}/\n")
    target = workspace / output_directory / "report.doc"
    target.parent.mkdir()
    target.write_text("user's existing exported document\n")
    _begin(store, session)
    target.write_text("agent's replacement document\n")
    session.artifacts[target] = "agent's replacement document\n"
    _finish(store, session)

    try:
        store.rewind("session-qa", "turn-1", session=session, persist=lambda: True)
    except TurnLifecycleError:
        assert target.read_text() == "agent's replacement document\n"
        assert session.chat_history
    else:
        assert target.exists(), "a pre-existing ignored document was mistaken for a new output"
        assert target.read_text() == "user's existing exported document\n"


def test_second_private_document_turn_can_undo_without_losing_first_delivery(tmp_path):
    _workspace, session, store = _setup(tmp_path)
    first = _begin(store, session, "first-turn")
    first_doc = first.outputs / "first.md"
    first_doc.write_text("first delivery\n")
    session.artifacts[first_doc] = "first delivery\n"
    _finish(store, session, "first-turn")
    first_history = copy.deepcopy(session.chat_history)
    second = _begin(store, session, "second-turn")
    second_doc = second.outputs / "second.doc"
    second_doc.write_text("second delivery\n")
    session.artifacts[second_doc] = "second delivery\n"
    _finish(store, session, "second-turn")

    assert store.list_turns("session-qa")[0]["can_undo"], "an earlier valid private output must not disable the next turn's undo"
    store.rewind("session-qa", "second-turn", session=session, persist=lambda: True)

    assert first_doc.read_text() == "first delivery\n"
    assert not second_doc.exists()
    assert session.chat_history == first_history
    assert set(session.artifacts) == {first_doc}


@pytest.mark.asyncio
async def test_rewind_blocks_new_writer_until_restored_chat_is_persisted(tmp_path):
    workspace, session, store = _setup(tmp_path, git=True)
    _begin(store, session)
    (workspace / "source.py").write_text("agent edit\n")
    _finish(store, session)
    persistence_started = asyncio.Event()
    finish_persistence = asyncio.Event()

    async def persist():
        persistence_started.set()
        await finish_persistence.wait()
        return True

    rewind = asyncio.create_task(store.rewind_async(
        "session-qa", "turn-1", session=session, persist_async=persist,
    ))
    try:
        await asyncio.wait_for(persistence_started.wait(), timeout=5)
        with pytest.raises(TurnAlreadyRunning):
            store.begin("another-session", "another-turn", session=session)
    finally:
        finish_persistence.set()
        await rewind


@pytest.mark.asyncio
async def test_failed_manifest_commit_compensates_durable_chat_and_prior_manifests(tmp_path, monkeypatch):
    workspace, session, store = _setup(tmp_path, git=True)
    for turn_id in ("turn-1", "turn-2"):
        _begin(store, session, turn_id)
        (workspace / "source.py").write_text(f"{turn_id}\n")
        _finish(store, session, turn_id)
    prior_chat = copy.deepcopy(session.chat_history)
    durable_chat = tmp_path / "durable-chat.json"
    durable_chat.write_text(json.dumps(prior_chat))
    original_write = store._write_manifest
    failed_once = False

    def fail_second_manifest(manifest):
        nonlocal failed_once
        if manifest.get("turn_id") == "turn-2" and manifest.get("status") == "rewound" and not failed_once:
            failed_once = True
            raise OSError("injected checkpoint commit failure")
        return original_write(manifest)

    async def persist():
        durable_chat.write_text(json.dumps(session.chat_history))
        return True

    monkeypatch.setattr(store, "_write_manifest", fail_second_manifest)
    with pytest.raises((OSError, TurnLifecycleError)):
        await store.rewind_async("session-qa", "turn-1", session=session, persist_async=persist)

    assert session.chat_history == prior_chat
    assert json.loads(durable_chat.read_text()) == prior_chat
    assert (workspace / "source.py").read_text() == "turn-2\n"
    assert all(row["status"] == "completed" for row in store.list_turns("session-qa"))


def test_background_writer_registered_during_rewind_preflight_rejects_without_changes(tmp_path, monkeypatch):
    workspace, session, store = _setup(tmp_path, git=True)
    _begin(store, session)
    (workspace / "source.py").write_text("agent edit\n")
    _finish(store, session)
    prior_chat = copy.deepcopy(session.chat_history)
    active = False
    store.set_active_writer_checker(
        lambda _scope: [{"job_id": "other-session-writer"}] if active else []
    )
    read_manifest = store._read_manifest

    def concurrent_job_registration(*args, **kwargs):
        nonlocal active
        # Another managed process can finish starting while preflight reads
        # checkpoint files, after the initial active-writer observation.
        active = True
        return read_manifest(*args, **kwargs)

    monkeypatch.setattr(store, "_read_manifest", concurrent_job_registration)
    with pytest.raises(TurnAlreadyRunning):
        store.rewind("session-qa", "turn-1", session=session, persist=lambda: True)

    assert (workspace / "source.py").read_text() == "agent edit\n"
    assert session.chat_history == prior_chat
    active = False
    monkeypatch.setattr(store, "_read_manifest", read_manifest)
    # Rejection must release the transaction so a normal next turn can run.
    _begin(store, session, "next-turn")
    _finish(store, session, "next-turn")


def test_manual_change_after_turn_rejects_without_losing_chat(tmp_path):
    workspace, session, store = _setup(tmp_path, git=True)
    source = workspace / "source.py"
    _begin(store, session)
    source.write_text("agent edit\n")
    _finish(store, session)
    source.write_text("manual edit AFTER turn\n")
    old_chat = copy.deepcopy(session.chat_history)

    with pytest.raises(TurnConflictError):
        store.rewind("session-qa", "turn-1", session=session, persist=lambda: True)

    assert source.read_text() == "manual edit AFTER turn\n"
    assert session.chat_history == old_chat


def test_older_turn_rewind_is_rejected_and_latest_manual_conflict_is_preserved(tmp_path):
    workspace, session, store = _setup(tmp_path, git=True)
    _begin(store, session, "t1")
    (workspace / "source.py").write_text("agent first turn\n")
    _finish(store, session, "t1")
    (workspace / "notes.md").write_text("manual edit BETWEEN turns\n")
    _begin(store, session, "t2")
    (workspace / "source.py").write_text("agent second turn\n")
    _finish(store, session, "t2")
    old_chat = copy.deepcopy(session.chat_history)

    with pytest.raises(TurnCheckpointMissing, match="most recent"):
        store.rewind("session-qa", "t1", session=session, persist=lambda: True)
    assert session.chat_history == old_chat

    # A manual edit after the latest turn still fences the valid undo target.
    (workspace / "notes.md").write_text("manual edit AFTER latest turn\n")
    with pytest.raises(TurnConflictError):
        store.rewind("session-qa", "t2", session=session, persist=lambda: True)
    assert session.chat_history == old_chat

    assert (workspace / "notes.md").read_text() == "manual edit AFTER latest turn\n"


@pytest.mark.parametrize("limits", [
    {"max_file_bytes": 4},
    {"max_total_bytes": 1},
    {"max_files": 1},
])
def test_uncovered_existing_file_must_not_be_deleted_or_partially_rewound(tmp_path, limits):
    workspace, session, store = _setup(tmp_path, **limits)
    (workspace / "a.md").write_text("first existing document\n")
    target = workspace / "z.md"
    target.write_text("existing content larger than the snapshot byte cap\n")
    handle = _begin(store, session)
    manifest = json.loads((handle.private.checkpoint / "manifest.json").read_text())
    records = manifest["before_files"]
    # File enumeration order is filesystem dependent. Select an actual
    # uncovered file rather than assuming that alphabetic order controls caps.
    uncovered = [
        path for path in (workspace / "a.md", target)
        if not records.get(str(path.resolve()), {}).get("snapshot")
    ]
    assert uncovered, "the test's deliberately small limit should omit snapshot bytes"
    target = uncovered[-1]
    # Shrinking an uncovered file must not reclassify it as a newly-created file.
    target.write_text("x")
    _finish(store, session)
    old_chat = copy.deepcopy(session.chat_history)
    turn = store.list_turns("session-qa")[0]

    assert turn["can_undo"] is False
    assert turn["reason"]
    with pytest.raises(TurnLifecycleError):
        store.rewind("session-qa", "turn-1", session=session, persist=lambda: True)

    assert target.read_text() == "x"
    assert session.chat_history == old_chat


def test_persistence_failure_compensates_files_and_chat_and_allows_retry(tmp_path):
    workspace, session, store = _setup(tmp_path, git=True)
    source = workspace / "source.py"
    _begin(store, session)
    source.write_text("agent result\n")
    _finish(store, session)
    old_chat = copy.deepcopy(session.chat_history)

    with pytest.raises(TurnLifecycleError):
        store.rewind("session-qa", "turn-1", session=session, persist=lambda: False)

    assert source.read_text() == "agent result\n"
    assert session.chat_history == old_chat
    store.rewind("session-qa", "turn-1", session=session, persist=lambda: True)
    assert source.read_text() == "baseline\n"


def test_legacy_missing_chat_checkpoint_never_advertises_undo(tmp_path):
    _, session, store = _setup(tmp_path)
    handle = _begin(store, session)
    _finish(store, session)
    manifest_path = handle.private.checkpoint / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    manifest.pop("chat_before", None)
    manifest_path.write_text(json.dumps(manifest))
    old_chat = copy.deepcopy(session.chat_history)

    assert store.list_turns("session-qa")[0]["can_undo"] is False
    with pytest.raises(TurnCheckpointMissing):
        store.rewind("session-qa", "turn-1", session=session, persist=lambda: True)
    assert session.chat_history == old_chat


def test_replaced_artifact_symlink_never_modifies_its_external_target(tmp_path):
    workspace, session, store = _setup(tmp_path)
    artifact = workspace / "report.doc"
    artifact.write_text("original document")
    outside = tmp_path / "outside.doc"
    outside.write_text("external user content")
    session.artifacts[artifact] = "original document"
    _begin(store, session, explicit_paths=[artifact])
    artifact.unlink()
    artifact.symlink_to(outside)
    _finish(store, session)
    old_chat = copy.deepcopy(session.chat_history)

    with pytest.raises(TurnLifecycleError):
        store.rewind("session-qa", "turn-1", session=session, persist=lambda: True)

    assert outside.read_text() == "external user content"
    assert artifact.is_symlink()
    assert session.chat_history == old_chat


def test_checkpoints_survive_store_restart(tmp_path):
    workspace, session, store = _setup(tmp_path, git=True)
    _begin(store, session)
    (workspace / "source.py").write_text("agent result\n")
    _finish(store, session)
    restarted = TurnLifecycleStore(tmp_path / "sessions")

    assert restarted.list_turns("session-qa")[0]["can_undo"]
    restarted.rewind("session-qa", "turn-1", session=session, persist=lambda: True)

    assert (workspace / "source.py").read_text() == "baseline\n"
    assert session.chat_history == []


def test_parent_child_workspace_roots_cannot_have_concurrent_turn_writers(tmp_path):
    workspace, session, store = _setup(tmp_path)
    child = workspace / "child"
    child.mkdir()
    _begin(store, session)
    try:
        with pytest.raises(TurnAlreadyRunning):
            store.begin("another-session", "another-turn", workspace_roots=[child])
    finally:
        _finish(store, session)
