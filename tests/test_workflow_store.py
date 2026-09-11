from __future__ import annotations

import json
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from threading import Barrier

import pytest

from agenticx.runtime.workflow import (
    MAX_CONFIG_BYTES,
    WorkflowCorruptError,
    WorkflowOwnershipError,
    WorkflowStore,
    WorkflowValidationError,
    WorkflowVersionConflict,
    canonical_payload_size,
)



def workflow_raw() -> dict:
    return {
        "workflow_id": "wf_fixture",
        "revision": 1,
        "title": "Release workflow",
        "description": "A complete definition fixture",
        "objective": "Ship a reviewed release",
        "completion_criteria": ["release is recorded"],
        "nodes": [
            {"id": "trigger", "kind": "trigger", "label": "Start"},
            {"id": "task", "kind": "agent_task", "label": "Prepare", "objective": "Prepare release", "deliverable": "Package", "acceptance_criteria": ["Complete"]},
            {"id": "action", "kind": "connector_action", "label": "Read", "objective": "Read release doc", "deliverable": "Summary", "acceptance_criteria": ["Clear"], "config": {"connector_id": "feishu", "action_id": "read_document", "document_ref": "doc-1"}},
            {"id": "decision", "kind": "decision", "label": "Ready?"},
            {"id": "approval", "kind": "approval_gate", "label": "Approve", "objective": "Approve release", "config": {"summary": "Publish release", "approver_policy_kind": "any", "target_action_description": "Publish release", "ttl_seconds": 3600}},
            {"id": "review", "kind": "review", "label": "Review", "objective": "Review release", "deliverable": "Review result", "acceptance_criteria": ["Recorded"]},
            {"id": "join", "kind": "join", "label": "Join", "config": {"mode": "all"}},
            {"id": "end", "kind": "end", "label": "End"},
        ],
        "edges": [
            {"id": "e1", "source": "trigger", "target": "task"},
            {"id": "e2", "source": "task", "target": "action"},
            {"id": "e3", "source": "action", "target": "decision"},
            {"id": "e4", "source": "decision", "target": "approval", "route": "yes"},
            {"id": "e5", "source": "decision", "target": "review", "route": "no"},
            {"id": "e6", "source": "approval", "target": "join"},
            {"id": "e7", "source": "review", "target": "join"},
            {"id": "e8", "source": "join", "target": "end"},
        ],
        "digest": "",
        "created_at": "2026-09-10T00:00:00Z",
    }


def test_create_append_and_historical_revision_are_immutable(tmp_path) -> None:
    store = WorkflowStore(tmp_path)
    created = store.create("owner-a", workflow_raw())
    assert created.revision == 1
    assert created.workflow_id.startswith("wf_")
    assert store.load_revision(created.workflow_id, 1, "owner-a").digest == created.digest

    edited = deepcopy(workflow_raw())
    edited["title"] = "Edited release"
    second = store.append_revision(created.workflow_id, "owner-a", 1, edited)
    assert second.revision == 2
    assert store.load_revision(created.workflow_id, 1, "owner-a").title == "Release workflow"
    assert store.load_revision(created.workflow_id, 2, "owner-a").title == "Edited release"
    assert store.load_head(created.workflow_id, "owner-a").head_revision == 2


def test_stale_append_cas_and_cross_owner_isolation(tmp_path) -> None:
    first = WorkflowStore(tmp_path).create("owner-a", workflow_raw())
    store = WorkflowStore(tmp_path)
    with pytest.raises(WorkflowVersionConflict) as caught:
        store.append_revision(first.workflow_id, "owner-a", 0, workflow_raw())
    assert caught.value.expected == 0
    assert caught.value.actual == 1

    with pytest.raises(WorkflowOwnershipError):
        store.load_head(first.workflow_id, "owner-b")
    assert store.list_manifests("owner-b") == []


def test_publish_idempotency_and_old_publication_survives_new_draft(tmp_path) -> None:
    store = WorkflowStore(tmp_path)
    first = store.create("owner-a", workflow_raw())
    first_manifest = store.publish(first.workflow_id, "owner-a", 1, 1)
    assert first_manifest.active_published_revision == 1
    assert store.publish(first.workflow_id, "owner-a", 1, 1).published_revisions == [1]

    edited = deepcopy(workflow_raw())
    edited["title"] = "Edited release"
    second = store.append_revision(first.workflow_id, "owner-a", 1, edited)
    assert store.load_published_revision(first.workflow_id, "owner-a").revision == 1
    second_manifest = store.publish(first.workflow_id, "owner-a", 2, 2)
    assert second_manifest.published_revisions == [1, 2]
    assert second_manifest.active_published_revision == 2
    assert store.load_revision(first.workflow_id, 1, "owner-a").digest == first.digest
    assert store.load_published_revision(first.workflow_id, "owner-a", 1).digest == first.digest
    assert second.digest != first.digest


def test_publish_manifest_reuses_validated_head_snapshot_in_strict_manifest(
    tmp_path, monkeypatch
) -> None:
    store = WorkflowStore(tmp_path)
    first = store.create("owner-a", workflow_raw())
    second_raw = deepcopy(workflow_raw())
    second_raw["title"] = "Revision 2"
    second = store.append_revision(first.workflow_id, "owner-a", 1, second_raw)
    third_raw = deepcopy(workflow_raw())
    third_raw["title"] = "Revision 3"
    third = store.append_revision(first.workflow_id, "owner-a", 2, third_raw)
    store.publish(first.workflow_id, "owner-a", 1, 3)
    store.publish(first.workflow_id, "owner-a", second.revision, 3)

    decoded = 0
    original_snapshot_row = store._snapshot_row

    def counted_snapshot_row(*args, **kwargs):
        nonlocal decoded
        decoded += 1
        return original_snapshot_row(*args, **kwargs)

    monkeypatch.setattr(store, "_snapshot_row", counted_snapshot_row)
    manifest = store.publish(first.workflow_id, "owner-a", third.revision, 3)
    assert manifest.active_published_revision == third.revision
    # The target/head snapshot is validated once, then reused as the newest
    # publication; the two older publications still receive strict checks.
    assert decoded == 3


def test_corrupt_snapshot_json_and_digest_fail_closed(tmp_path) -> None:
    store = WorkflowStore(tmp_path)
    created = store.create("owner-a", workflow_raw())
    with sqlite3.connect(store.db_path) as conn:
        conn.execute(
            "UPDATE workflow_revisions SET snapshot_json = ? WHERE workflow_id = ? AND revision = 1",
            ("{not-json", created.workflow_id),
        )
    with pytest.raises(WorkflowCorruptError):
        store.load_revision(created.workflow_id, 1, "owner-a")


    store = WorkflowStore(tmp_path / "other")
    created = store.create("owner-a", workflow_raw())
    with sqlite3.connect(store.db_path) as conn:
        raw = json.loads(conn.execute("SELECT snapshot_json FROM workflow_revisions WHERE workflow_id = ?", (created.workflow_id,)).fetchone()[0])
        raw["title"] = "tampered"
        conn.execute(
            "UPDATE workflow_revisions SET snapshot_json = ? WHERE workflow_id = ? AND revision = 1",
            (json.dumps(raw), created.workflow_id),
        )
    with pytest.raises(WorkflowCorruptError):
        store.load_revision(created.workflow_id, 1, "owner-a")


def test_manifest_listing_rejects_retargeted_publication(tmp_path) -> None:
    store = WorkflowStore(tmp_path)
    first = store.create("owner-a", workflow_raw())
    edited = deepcopy(workflow_raw())
    edited["title"] = "Edited release"
    store.append_revision(first.workflow_id, "owner-a", 1, edited)
    store.publish(first.workflow_id, "owner-a", 1, 2)

    with sqlite3.connect(store.db_path) as conn:
        conn.execute(
            "UPDATE workflow_publications SET digest = ? WHERE workflow_id = ? AND revision = 1",
            ("f" * 64, first.workflow_id),
        )
    with pytest.raises(WorkflowCorruptError, match="publication digest mismatch"):
        store.list_manifests("owner-a")


def test_manifest_listing_rejects_corrupt_published_snapshot_json(tmp_path) -> None:
    store = WorkflowStore(tmp_path)
    first = store.create("owner-a", workflow_raw())
    edited = deepcopy(workflow_raw())
    edited["title"] = "Edited release"
    store.append_revision(first.workflow_id, "owner-a", 1, edited)
    store.publish(first.workflow_id, "owner-a", 1, 2)
    with sqlite3.connect(store.db_path) as conn:
        conn.execute(
            "UPDATE workflow_revisions SET snapshot_json = ? WHERE workflow_id = ? AND revision = 1",
            ("{not-json", first.workflow_id),
        )

    with pytest.raises(WorkflowCorruptError, match="invalid snapshot JSON"):
        store.list_manifests("owner-a")


def test_publish_rejects_corrupt_historical_snapshot_and_rolls_back(tmp_path) -> None:
    store = WorkflowStore(tmp_path)
    first = store.create("owner-a", workflow_raw())
    edited = deepcopy(workflow_raw())
    edited["title"] = "Edited release"
    second = store.append_revision(first.workflow_id, "owner-a", 1, edited)
    store.publish(first.workflow_id, "owner-a", 1, 2)
    with sqlite3.connect(store.db_path) as conn:
        conn.execute(
            "UPDATE workflow_revisions SET snapshot_json = ? WHERE workflow_id = ? AND revision = 1",
            ("{not-json", first.workflow_id),
        )

    with pytest.raises(WorkflowCorruptError, match="invalid snapshot JSON"):
        store.publish(first.workflow_id, "owner-a", second.revision, 2)

    with sqlite3.connect(store.db_path) as conn:
        publications = [
            row[0]
            for row in conn.execute(
                "SELECT revision FROM workflow_publications WHERE workflow_id = ? ORDER BY revision",
                (first.workflow_id,),
            )
        ]
        active = conn.execute(
            "SELECT active_published_revision FROM workflow_heads WHERE workflow_id = ?",
            (first.workflow_id,),
        ).fetchone()[0]
    assert publications == [1]
    assert active == 1


def test_create_rejects_approval_config_that_grows_during_normalization(tmp_path) -> None:
    raw = workflow_raw()
    config = {
        "summary": "S",
        "approver_policy": {"kind": "any", "value": ""},
        "target_action": "T",
        "ttl_seconds": 1,
        "padding": ["x" * 8170 for _ in range(8)],
    }
    raw["nodes"][4]["config"] = config
    assert canonical_payload_size(config) < MAX_CONFIG_BYTES

    with pytest.raises(WorkflowValidationError) as caught:
        WorkflowStore(tmp_path).create("owner-a", raw)
    assert "config_too_large" in {issue.code for issue in caught.value.issues}


def test_independent_store_instances_allow_only_one_same_head_append(tmp_path) -> None:
    first = WorkflowStore(tmp_path).create("owner-a", workflow_raw())
    stores = [WorkflowStore(tmp_path), WorkflowStore(tmp_path)]
    barrier = Barrier(2)

    def append(store: WorkflowStore):
        barrier.wait(timeout=10)
        try:
            return store.append_revision(first.workflow_id, "owner-a", 1, workflow_raw())
        except WorkflowVersionConflict as exc:
            return exc

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(append, stores))
    assert sum(isinstance(result, WorkflowVersionConflict) for result in results) == 1
    assert sum(getattr(result, "revision", None) == 2 for result in results) == 1
    assert WorkflowStore(tmp_path).load_head(first.workflow_id, "owner-a").head_revision == 2
