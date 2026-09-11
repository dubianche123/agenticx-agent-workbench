"""Focused backend coverage for document publication and latest-turn rewind."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import stat
from pathlib import Path
from types import SimpleNamespace

import pytest

from agenticx.cli import agent_tools
from agenticx.cli.studio import StudioSession
from agenticx.runtime import document_delivery
from agenticx.runtime.turn_lifecycle import TurnCheckpointMissing, TurnLifecycleStore


def _session(workspace: Path, session_id: str = "document-session") -> SimpleNamespace:
    return SimpleNamespace(
        _session_id=session_id,
        workspace_dir=str(workspace),
        taskspaces=[],
        active_taskspace_id=None,
        chat_history=[],
        agent_messages=[],
        artifacts={},
        scratchpad={},
        context_files={},
    )


def _begin(store: TurnLifecycleStore, session: SimpleNamespace, turn_id: str):
    handle = store.begin(
        session._session_id,
        turn_id,
        client_turn_id=turn_id,
        session=session,
    )
    session.chat_history.append({"role": "user", "content": turn_id})
    session.agent_messages.append({"role": "user", "content": turn_id})
    return handle


def _finish(store: TurnLifecycleStore, session: SimpleNamespace, turn_id: str):
    session.chat_history.append({"role": "assistant", "content": "done"})
    session.agent_messages.append({"role": "assistant", "content": "done"})
    pending = getattr(session, "_turn_deliverables", ())
    result = store.finalize(
        session._session_id,
        turn_id,
        session=session,
        deliverables=pending if isinstance(pending, list) else (),
    )
    # SessionManager clears this channel after durable finalization; mirror
    # that boundary so a later turn cannot inherit a prior publication row.
    if hasattr(session, "_turn_deliverables"):
        del session._turn_deliverables
    return result


def _bind_turn(session: SimpleNamespace, handle) -> None:
    session._active_turn_id = handle.turn_id
    session._private_workspace_root = str(handle.private.root)
    session._private_execution_root = str(handle.private.scratch)
    session._private_logs_root = str(handle.private.logs)


def test_non_git_docx_snapshot_restores_bytes_exactly(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    document = workspace / "report.docx"
    original = b"PK\x03\x04\x00minimal-docx-before\x00\xff"
    document.write_bytes(original)
    session = _session(workspace)
    store = TurnLifecycleStore(tmp_path / "sessions")

    first = _begin(store, session, "turn-1")
    _finish(store, session, first.turn_id)
    second = _begin(store, session, "turn-2")
    document.write_bytes(b"PK\x03\x04\x00minimal-docx-after\x00\x00")
    _finish(store, session, second.turn_id)

    assert store.list_turns(session._session_id)[0]["can_undo"] is True
    store.rewind(session._session_id, second.turn_id, session=session, persist=lambda: True)
    assert document.read_bytes() == original


def test_only_latest_turn_is_undoable_and_rewind_opens_new_window(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    document = workspace / "notes.md"
    document.write_text("baseline\n", encoding="utf-8")
    session = _session(workspace, "latest-session")
    store = TurnLifecycleStore(tmp_path / "sessions")

    for turn_id, content in (("turn-1", "first\n"), ("turn-2", "second\n")):
        handle = _begin(store, session, turn_id)
        document.write_text(content, encoding="utf-8")
        _finish(store, session, handle.turn_id)

    rows = {row["turn_id"]: row for row in store.list_turns(session._session_id)}
    assert rows["turn-2"]["can_undo"] is True
    assert rows["turn-1"]["can_undo"] is False
    with pytest.raises(TurnCheckpointMissing, match="most recent"):
        store.rewind(session._session_id, "turn-1", session=session, persist=lambda: True)

    store.rewind(session._session_id, "turn-2", session=session, persist=lambda: True)
    after_rewind = {row["turn_id"]: row for row in store.list_turns(session._session_id)}
    assert all(row["can_undo"] is False for row in after_rewind.values())

    third = _begin(store, session, "turn-3")
    document.write_text("third\n", encoding="utf-8")
    _finish(store, session, third.turn_id)
    after_new_turn = {row["turn_id"]: row for row in store.list_turns(session._session_id)}
    assert after_new_turn["turn-3"]["can_undo"] is True
    assert after_new_turn["turn-1"]["can_undo"] is False


def test_registered_private_output_is_covered_by_next_turn_only_at_exact_path(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    session = _session(workspace, "private-lineage")
    store = TurnLifecycleStore(tmp_path / "sessions")

    first = _begin(store, session, "turn-1")
    source = first.outputs / "source.docx"
    source.write_bytes(b"first private output")
    session._turn_deliverables = [
        {
            "path": str(source),
            "title": "Source",
            "format": "docx",
            "published": True,
            "lineage_id": "lineage-1",
        }
    ]
    _finish(store, session, first.turn_id)

    second = _begin(store, session, "turn-2")
    manifest = json.loads(second.private.manifest_path.read_text(encoding="utf-8"))
    assert str(source) in manifest["before_files"]
    assert manifest["registered_private_paths"] == [str(source)]


def test_finalize_does_not_republish_stale_session_artifacts(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    stale = workspace / "old.md"
    stale.write_text("old", encoding="utf-8")
    session = _session(workspace, "stale-artifact")
    session.artifacts[stale] = "old"
    store = TurnLifecycleStore(tmp_path / "sessions")

    first = _begin(store, session, "turn-1")
    _finish(store, session, first.turn_id)
    second = _begin(store, session, "turn-2")
    manifest = _finish(store, session, second.turn_id)

    assert manifest["deliverables"] == []


def test_finalize_keeps_changed_non_document_session_artifact(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    image = workspace / "chart.png"
    image.write_bytes(b"png-before")
    session = _session(workspace, "non-document-artifact")
    session.artifacts[image] = "before"
    store = TurnLifecycleStore(tmp_path / "sessions")

    first = _begin(store, session, "turn-1")
    _finish(store, session, first.turn_id)
    second = _begin(store, session, "turn-2")
    image.write_bytes(b"png-after")
    session.artifacts[image] = "after"
    manifest = _finish(store, session, second.turn_id)

    assert manifest["deliverables"] == [
        {
            "path": str(image),
            "title": "chart",
            "format": "png",
            "filename": "chart.png",
            "mimeType": "image/png",
            "size": len(b"png-after"),
            "sha256": hashlib.sha256(b"png-after").hexdigest(),
            "private": False,
            "published": True,
            "current": True,
            "source": "session-artifacts",
        }
    ]


def test_document_publish_renamed_revision_archives_and_undoes_docx(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    old_path = workspace / "draft.docx"
    old_bytes = b"PK\x03\x04\x00draft-v1"
    session = _session(workspace, "publish-lineage")
    store = TurnLifecycleStore(tmp_path / "sessions")

    first = _begin(store, session, "turn-1")
    _bind_turn(session, first)
    old_path.write_bytes(old_bytes)
    first_result = asyncio.run(
        agent_tools._tool_document_publish({"path": str(old_path), "title": "Draft"}, session)
    )
    assert json.loads(first_result)["format"] == "docx"
    _finish(store, session, first.turn_id)

    second = _begin(store, session, "turn-2")
    _bind_turn(session, second)
    new_path = workspace / "final.docx"
    new_bytes = b"PK\x03\x04\x00draft-v2"
    new_path.write_bytes(new_bytes)
    second_result = asyncio.run(
        agent_tools._tool_document_publish(
            {
                "path": str(new_path),
                "title": "Final",
                "replaces_path": str(old_path),
            },
            session,
        )
    )
    payload = json.loads(second_result)
    assert payload["replaces_path"] == str(old_path)
    assert payload["superseded_path"] == str(old_path)
    assert payload["superseded_archive_path"]
    assert not old_path.exists()
    assert new_path.read_bytes() == new_bytes
    archive_path = Path(payload["superseded_archive_path"])
    assert archive_path.read_bytes() == old_bytes
    _finish(store, session, second.turn_id)

    turns = {row["turn_id"]: row for row in store.list_turns(session._session_id)}
    old_artifact = turns["turn-1"]["artifacts"][0]
    assert old_artifact["path"] == str(old_path)
    assert old_artifact["superseded"] is True
    assert old_artifact["current"] is False
    old_file_change = next(
        item for item in turns["turn-1"]["files"] if item["path"] == str(old_path)
    )
    assert old_file_change["superseded"] is True
    assert old_file_change["current"] is False

    store.rewind(session._session_id, second.turn_id, session=session, persist=lambda: True)
    assert old_path.read_bytes() == old_bytes
    assert not new_path.exists()


def test_default_document_generate_is_visible_in_authoritative_manifest(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    session = StudioSession(workspace_dir=str(workspace))
    session._session_id = "default-generate"
    store = TurnLifecycleStore(tmp_path / "sessions")
    handle = store.begin(
        session._session_id,
        "turn-1",
        client_turn_id="turn-1",
        session=session,
    )
    session._active_turn_id = handle.turn_id
    session._private_workspace_root = str(handle.private.root)
    session._private_execution_root = str(handle.private.scratch)
    session._private_logs_root = str(handle.private.logs)

    async def fake_renderer(document_format: str, title: str, markdown: str):
        return "report.md", "text/markdown", "# Report\n"

    monkeypatch.setattr(agent_tools, "render_document_via_local_renderer", fake_renderer)
    result = asyncio.run(
        agent_tools._tool_document_generate(
            {"format": "md", "title": "Report", "markdown": "body"},
            session,
            confirm_gate=agent_tools.SyncConfirmGate(),
        )
    )
    payload = json.loads(result)
    assert payload["ok"] is True
    assert payload["private"] is False
    manifest = store.finalize(
        session._session_id,
        handle.turn_id,
        session=session,
        deliverables=getattr(session, "_turn_deliverables", []),
    )
    assert manifest["deliverables"] == [
        {
            "path": payload["path"],
            "title": "Report",
            "format": "md",
            "filename": "report.md",
            "mimeType": "text/markdown",
            "private": False,
            "published": True,
            "source": "document_generate",
            "lineage_id": payload["lineage_id"],
            "size": payload["size"],
            "sha256": payload["sha256"],
        }
    ]


def test_archive_failure_keeps_superseded_source_visible(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    source = tmp_path / "source.docx"
    source.write_bytes(b"source")
    archive_root = tmp_path / "private"

    def fail_copy(*args, **kwargs):
        raise document_delivery.DocumentDeliveryError("copy failed")

    monkeypatch.setattr(document_delivery, "_copy_file_bounded", fail_copy)
    with pytest.raises(document_delivery.DocumentDeliveryError, match="copy failed"):
        document_delivery.archive_superseded_document(source, archive_root)
    assert source.read_bytes() == b"source"


def test_generated_rename_archive_failure_restores_existing_target_exactly(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    old_path = workspace / "draft.docx"
    old_path.write_bytes(b"old revision")
    session = _session(workspace, "rename-rollback")
    store = TurnLifecycleStore(tmp_path / "sessions")

    first = _begin(store, session, "turn-1")
    _bind_turn(session, first)
    first_result = asyncio.run(
        agent_tools._tool_document_publish({"path": str(old_path), "title": "Draft"}, session)
    )
    assert json.loads(first_result)["ok"] is True
    _finish(store, session, first.turn_id)

    second = _begin(store, session, "turn-2")
    _bind_turn(session, second)
    target = workspace / "final.docx"
    original_target = b"manual target"
    target.write_bytes(original_target)
    os.chmod(target, 0o640)
    target_mode = stat.S_IMODE(target.stat().st_mode)

    def fail_archive(*args, **kwargs):
        raise document_delivery.DocumentDeliveryError("archive unavailable")

    monkeypatch.setattr(agent_tools, "archive_superseded_document", fail_archive)
    with pytest.raises(document_delivery.DocumentDeliveryError, match="archive unavailable"):
        agent_tools._publish_generated_document(
            session,
            target,
            b"generated target",
            title="Final",
            replaces_path=str(old_path),
        )

    assert old_path.read_bytes() == b"old revision"
    assert target.read_bytes() == original_target
    assert stat.S_IMODE(target.stat().st_mode) == target_mode
    assert not list(workspace.glob(".*.agenticx-backup"))


def test_generated_rename_archive_failure_removes_first_new_target(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    old_path = workspace / "draft.docx"
    old_path.write_bytes(b"old revision")
    session = _session(workspace, "new-target-rollback")
    store = TurnLifecycleStore(tmp_path / "sessions")

    first = _begin(store, session, "turn-1")
    _bind_turn(session, first)
    assert json.loads(
        asyncio.run(agent_tools._tool_document_publish({"path": str(old_path)}, session))
    )["ok"] is True
    _finish(store, session, first.turn_id)

    second = _begin(store, session, "turn-2")
    _bind_turn(session, second)
    target = workspace / "final.docx"

    def fail_archive(*args, **kwargs):
        raise document_delivery.DocumentDeliveryError("archive unavailable")

    monkeypatch.setattr(agent_tools, "archive_superseded_document", fail_archive)
    with pytest.raises(document_delivery.DocumentDeliveryError, match="archive unavailable"):
        agent_tools._publish_generated_document(
            session,
            target,
            b"generated target",
            title="Final",
            replaces_path=str(old_path),
        )

    assert old_path.read_bytes() == b"old revision"
    assert not target.exists()


def test_generated_rename_record_failure_restores_archive_and_target(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    old_path = workspace / "draft.docx"
    old_path.write_bytes(b"old revision")
    session = _session(workspace, "record-rollback")
    store = TurnLifecycleStore(tmp_path / "sessions")

    first = _begin(store, session, "turn-1")
    _bind_turn(session, first)
    assert json.loads(
        asyncio.run(agent_tools._tool_document_publish({"path": str(old_path)}, session))
    )["ok"] is True
    _finish(store, session, first.turn_id)

    second = _begin(store, session, "turn-2")
    _bind_turn(session, second)
    target = workspace / "final.docx"
    target.write_bytes(b"manual target")
    target_mode = stat.S_IMODE(target.stat().st_mode)

    def fail_record(*args, **kwargs):
        raise RuntimeError("manifest record unavailable")

    monkeypatch.setattr(agent_tools, "_record_document_publication", fail_record)
    with pytest.raises(RuntimeError, match="manifest record unavailable"):
        agent_tools._publish_generated_document(
            session,
            target,
            b"generated target",
            title="Final",
            replaces_path=str(old_path),
        )

    assert old_path.read_bytes() == b"old revision"
    assert target.read_bytes() == b"manual target"
    assert stat.S_IMODE(target.stat().st_mode) == target_mode
    superseded = second.private.checkpoint / "superseded"
    assert not superseded.exists() or list(superseded.iterdir()) == []


def test_archive_rejects_symlink_destination_and_source_parent(tmp_path: Path) -> None:
    source = tmp_path / "source.docx"
    source.write_bytes(b"source")
    outside = tmp_path / "outside"
    outside.mkdir()
    archive_root = tmp_path / "private"
    archive_root.mkdir()
    (archive_root / "superseded").symlink_to(outside, target_is_directory=True)
    with pytest.raises(document_delivery.DocumentDeliveryError, match="symlink"):
        document_delivery.archive_superseded_document(source, archive_root)
    assert source.read_bytes() == b"source"
    assert list(outside.iterdir()) == []

    real_parent = tmp_path / "real-parent"
    real_parent.mkdir()
    linked_source = real_parent / "linked.docx"
    linked_source.write_bytes(b"linked source")
    source_parent_link = tmp_path / "source-parent-link"
    source_parent_link.symlink_to(real_parent, target_is_directory=True)
    with pytest.raises(document_delivery.DocumentDeliveryError, match="symlink"):
        document_delivery.archive_superseded_document(
            source_parent_link / linked_source.name,
            tmp_path / "private-2",
        )
    assert linked_source.read_bytes() == b"linked source"


def test_archive_directory_sync_failure_is_explicit_and_preserves_source(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    source = tmp_path / "source.docx"
    source.write_bytes(b"source")

    def fail_sync(*args, **kwargs):
        raise document_delivery.DocumentDeliveryError("directory sync failed")

    monkeypatch.setattr(document_delivery, "fsync_directory", fail_sync)
    with pytest.raises(document_delivery.DocumentDeliveryError, match="directory sync failed"):
        document_delivery.archive_superseded_document(source, tmp_path / "private")
    assert source.read_bytes() == b"source"


def test_managed_default_memory_is_hidden_but_user_memory_is_retained(tmp_path: Path) -> None:
    sid = "managed-memory"
    managed_workspace = tmp_path / "taskspaces" / sid / "default"
    user_workspace = tmp_path / "selected-workspace"
    managed_workspace.mkdir(parents=True)
    user_workspace.mkdir()
    session = _session(managed_workspace, sid)
    session.taskspaces = [{"id": "default", "path": str(managed_workspace)}, {"id": "user", "path": str(user_workspace)}]
    store = TurnLifecycleStore(tmp_path / "sessions")

    handle = _begin(store, session, "turn-1")
    managed_path = managed_workspace / "memory" / "2026-09-11.md"
    user_path = user_workspace / "memory" / "customer-report.md"
    managed_identity = managed_workspace / "IDENTITY.md"
    managed_memory = managed_workspace / "MEMORY.md"
    user_identity = user_workspace / "IDENTITY.md"
    user_memory = user_workspace / "MEMORY.md"
    private_runtime = handle.private.logs / "runtime.jsonl"
    managed_path.parent.mkdir()
    user_path.parent.mkdir()
    managed_path.write_text("runtime memory", encoding="utf-8")
    user_path.write_text("business report", encoding="utf-8")
    managed_identity.write_text("runtime identity", encoding="utf-8")
    managed_memory.write_text("runtime memory index", encoding="utf-8")
    user_identity.write_text("business identity", encoding="utf-8")
    user_memory.write_text("business memory", encoding="utf-8")
    private_runtime.write_text('{"event":"runtime"}\n', encoding="utf-8")
    manifest = _finish(store, session, handle.turn_id)

    assert manifest["managed_memory_roots"] == [str(managed_workspace / "memory")]
    assert all(item["path"] != str(managed_path) for item in manifest["files"])
    assert all(item["path"] != str(managed_path) for item in manifest["deliverables"])
    for path in (managed_identity, managed_memory):
        assert all(item["path"] != str(path) for item in manifest["files"])
        assert all(item["path"] != str(path) for item in manifest["deliverables"])
    assert all(item["path"] != str(private_runtime) for item in manifest["files"])
    assert all(item["path"] != str(private_runtime) for item in manifest["deliverables"])
    assert any(item["path"] == str(user_path) for item in manifest["files"])
    assert any(item["path"] == str(user_path) for item in manifest["deliverables"])
    for path in (user_identity, user_memory):
        assert any(item["path"] == str(path) for item in manifest["files"])
        assert any(item["path"] == str(path) for item in manifest["deliverables"])


def test_same_named_business_documents_are_visible_when_created_and_changed(tmp_path: Path) -> None:
    workspace = tmp_path / "business-workspace"
    workspace.mkdir()
    session = _session(workspace, "same-named-business")
    store = TurnLifecycleStore(tmp_path / "sessions")

    first = _begin(store, session, "turn-1")
    identity = workspace / "IDENTITY.md"
    memory = workspace / "MEMORY.md"
    identity.write_text("business identity v1", encoding="utf-8")
    memory.write_text("business memory v1", encoding="utf-8")
    first_manifest = _finish(store, session, first.turn_id)
    assert {item["path"] for item in first_manifest["deliverables"]} >= {
        str(identity),
        str(memory),
    }

    second = _begin(store, session, "turn-2")
    identity.write_text("business identity v2", encoding="utf-8")
    memory.write_text("business memory v2", encoding="utf-8")
    second_manifest = _finish(store, session, second.turn_id)
    assert {item["path"] for item in second_manifest["files"]} >= {
        str(identity),
        str(memory),
    }
    assert {item["path"] for item in second_manifest["deliverables"]} >= {
        str(identity),
        str(memory),
    }
