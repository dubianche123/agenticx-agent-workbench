from __future__ import annotations

import json
from pathlib import Path

from agenticx.studio.feedback_experiences import FeedbackExperienceStore
from agenticx.studio.feedback_learning import (
    CanonicalFeedbackMessage,
    FeedbackCaseStore,
    FeedbackEvidenceRef,
    FeedbackIdentity,
)


def _identity() -> FeedbackIdentity:
    return FeedbackIdentity(scope_id='["desktop","tenant-a","user-a"]', user_id="user-a", tenant_id="tenant-a")


def _message(index: int, *, route: str | None = "private-a", subject: str = "meta") -> CanonicalFeedbackMessage:
    return CanonicalFeedbackMessage(
        session_id=f"session-{index}",
        message_id=f"message-{index}",
        question=f"电池健康管理方案问题 {index}",
        answer=f"充电策略与温度控制建议 {index}",
        subject_id=subject,
        routing_key=route,
        turn_id=f"turn-{index}",
    )


def _add_cases(store: FeedbackCaseStore, count: int, *, start: int = 0, now: float = 0.0) -> None:
    for index in range(start, start + count):
        store.record_vote(identity=_identity(), message=_message(index), value="like", now=now)


def test_cancel_readd_has_monotonic_revision_and_survives_restart(tmp_path: Path) -> None:
    store = FeedbackCaseStore(tmp_path, max_cases=2)
    identity = _identity()
    message = _message(0)
    first = store.record_vote(identity=identity, message=message, value="like", now=1.0)
    first_ref = (first.id, first.revision, first.evidence_hash)
    store.cancel_vote(identity=identity, session_id=message.session_id, message_id=message.message_id, now=2.0)
    second = store.record_vote(identity=identity, message=message, value="like", now=3.0)

    assert second.revision > first.revision
    assert not store.validate_evidence([FeedbackEvidenceRef(*first_ref)])
    assert store.validate_evidence([FeedbackEvidenceRef(second.id, second.revision, second.evidence_hash)])
    restarted = FeedbackCaseStore(tmp_path, max_cases=2)
    assert restarted.cases[0].revision == second.revision


def test_same_value_repeated_click_is_idempotent_and_does_not_count_twice(tmp_path: Path) -> None:
    store = FeedbackCaseStore(tmp_path)
    identity = _identity()
    message = _message(1)
    first = store.record_vote(identity=identity, message=message, value="like", now=1.0)
    repeated = store.record_vote(identity=identity, message=message, value="like", now=99.0)
    assert repeated == first
    assert len(store.pending_cases) == 1


def test_due_threshold_uses_distinct_cases_and_group_cooldown(tmp_path: Path) -> None:
    store = FeedbackCaseStore(tmp_path)
    identity = _identity()
    message = _message(0)
    store.record_vote(identity=identity, message=message, value="like", now=0.0)
    # Repeated click on the same case remains one pending case.
    store.record_vote(identity=identity, message=message, value="like", now=1.0)
    _add_cases(store, 3, start=1, now=0.0)
    assert store.due_batches(identity, now=10.0) == ()
    _add_cases(store, 1, start=4, now=0.0)
    batch = store.due_batches(identity, now=10.0, batch_limit=2)[0]
    assert len(batch.cases) == 2
    assert store.claim_batch(identity=identity, batch=batch, worker_id="worker-a", now=10.0)
    result = store.finish_batch(
        identity=identity,
        batch=batch,
        result={"experiences": []},
        experience_store=None,
        processed_feedback_ids=batch.source_feedback_ids,
        now=10.0,
    )
    assert result.status == "committed"
    assert store.due_batches(identity, now=11.0, batch_limit=2) == ()
    _add_cases(store, 2, start=5, now=10.0)
    assert store.due_batches(identity, now=311.0, batch_limit=2)


def test_old_batch_only_finishes_evidence_sent_to_bounded_request(tmp_path: Path) -> None:
    store = FeedbackCaseStore(tmp_path)
    identity = _identity()
    _add_cases(store, 32, now=0.0)
    batch = store.due_batches(identity, now=1.0, batch_limit=32)[0]
    sent = batch.source_feedback_ids[:5]
    assert store.claim_batch(identity=identity, batch=batch, worker_id="worker-a", now=1.0)
    finished = store.finish_batch(
        identity=identity,
        batch=batch,
        result={"experiences": []},
        experience_store=None,
        processed_feedback_ids=sent,
        now=2.0,
    )
    assert finished.status == "committed"
    assert len(store.pending_cases) == 27
    assert {case.id for case in store.pending_cases} == set(batch.source_feedback_ids[5:])


def test_finish_persist_failure_restores_pending_case_state(tmp_path: Path, monkeypatch) -> None:
    store = FeedbackCaseStore(tmp_path)
    identity = _identity()
    _add_cases(store, 5, now=0.0)
    batch = store.due_batches(identity, now=1.0)[0]
    assert store.claim_batch(identity=identity, batch=batch, worker_id="worker-a", now=1.0)

    def fail_persist(*, now=None):
        raise OSError("disk full")

    monkeypatch.setattr(store, "_persist_locked", fail_persist)
    try:
        store.finish_batch(
            identity=identity,
            batch=batch,
            result={"experiences": []},
            experience_store=None,
            processed_feedback_ids=batch.source_feedback_ids,
            now=2.0,
        )
    except OSError:
        pass
    else:
        raise AssertionError("finish must report the persistence error")
    assert len(store.pending_cases) == 5


def test_group_backoff_cannot_be_bypassed_by_new_batch_id(tmp_path: Path) -> None:
    store = FeedbackCaseStore(tmp_path)
    identity = _identity()
    _add_cases(store, 5, now=0.0)
    batch = store.due_batches(identity, now=1.0)[0]
    assert store.claim_batch(identity=identity, batch=batch, worker_id="worker-a", now=1.0)
    failed = store.fail_batch(identity=identity, batch=batch, error="provider down", now=1.0)
    assert failed.status == "retry"
    store.record_vote(identity=identity, message=_message(5), value="like", now=2.0)
    assert store.due_batches(identity, now=2.0) == ()
    assert store.due_batches(identity, now=61.0)


def test_ledger_tombstones_are_bounded_and_old_jsonl_cannot_revive_cancelled_case(tmp_path: Path) -> None:
    store = FeedbackCaseStore(tmp_path, max_cases=2)
    identity = _identity()
    for index in range(10):
        message = _message(index)
        store.record_vote(identity=identity, message=message, value="like", now=float(index))
        store.cancel_vote(identity=identity, session_id=message.session_id, message_id=message.message_id, now=float(index) + 0.5)
    assert len(store.cases) == 0
    assert len(store._ledger) <= 4

    # A stale legacy row must not be loaded once the canonical state exists.
    message = _message(100)
    store.record_vote(identity=identity, message=message, value="like", now=20.0)
    store.cancel_vote(identity=identity, session_id=message.session_id, message_id=message.message_id, now=21.0)
    with store.path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps({
            "id": "stale",
            "identity_key": identity.key,
            "session_id": message.session_id,
            "message_id": message.message_id,
            "subject_id": "meta",
            "question": "stale q",
            "answer": "stale a",
            "value": "like",
            "created_at": 1,
        }) + "\n")
    assert FeedbackCaseStore(tmp_path).cases == ()


def test_live_evidence_validation_invalidates_experience_after_cancel(tmp_path: Path) -> None:
    case_root = tmp_path / "cases"
    experience_root = tmp_path / "experiences"
    case_store = FeedbackCaseStore(case_root)
    experience_store = FeedbackExperienceStore(experience_root)
    identity = _identity()
    _add_cases(case_store, 5, now=0.0)
    batch = case_store.due_batches(identity, now=1.0)[0]
    published = experience_store.publish_batch(
        identity_key=identity.key,
        subject_id=batch.subject_id,
        routing_key=batch.routing_key,
        candidates=[{
            "applicability": "电池健康管理",
            "guidance": "回答时说明充电上限与温度控制。",
            "keywords": ["充电策略", "电池保养"],
            "confidence": 0.99,
            "source_feedback_ids": list(batch.source_feedback_ids),
        }],
        source_cases=batch.cases,
        source_refs=batch.snapshots,
        now=1.0,
    )
    assert published[0].confidence < 0.99
    validator = case_store.validate_evidence
    assert experience_store.recall(
        identity=identity,
        query="电池保养充电策略",
        subject_id="meta",
        routing_key="private-a",
        evidence_validator=validator,
    )
    case_store.cancel_vote(
        identity=identity,
        session_id=batch.cases[0].session_id,
        message_id=batch.cases[0].message_id,
        now=2.0,
    )
    assert experience_store.recall(
        identity=identity,
        query="电池保养充电策略",
        subject_id="meta",
        routing_key="private-a",
        evidence_validator=validator,
    ) == ()
    assert experience_store.recall_context(
        identity=identity,
        query="电池保养充电策略",
        subject_id="meta",
        routing_key=None,
        evidence_validator=validator,
    ).count == 0
