from __future__ import annotations

from pathlib import Path

import pytest

from agenticx.studio.feedback_experiences import (
    FeedbackExperienceError,
    FeedbackExperienceStore,
)
from agenticx.studio.feedback_learning import (
    CanonicalFeedbackMessage,
    FeedbackCaseStore,
    FeedbackIdentity,
)


def _identity() -> FeedbackIdentity:
    return FeedbackIdentity(scope_id="scope-a", user_id="user-a", tenant_id="tenant-a")


def _message(index: int, *, value_route: str | None = "route-a") -> CanonicalFeedbackMessage:
    return CanonicalFeedbackMessage(
        session_id=f"session-{index}",
        message_id=f"message-{index}",
        question=f"如何制定电池充电策略 {index}",
        answer=f"请说明充电上限和温度控制 {index}",
        subject_id="meta",
        routing_key=value_route,
    )


def _batch(tmp_path: Path, count: int = 5):
    case_store = FeedbackCaseStore(tmp_path / "cases")
    identity = _identity()
    for index in range(count):
        case_store.record_vote(
            identity=identity,
            message=_message(index),
            value="like",
            now=float(index),
        )
    due_now = 86_401.0 if count < 5 else 100.0
    return case_store, identity, case_store.due_batches(identity, now=due_now)[0]


def _candidate(batch, *, confidence: float = 0.99, guidance: str = "说明充电上限和温度控制。"):
    return {
        "applicability": "电池充电策略",
        "guidance": guidance,
        "keywords": ["充电上限", "充电方案"],
        "confidence": confidence,
        "source_feedback_ids": list(batch.source_feedback_ids),
    }


def test_publish_caps_single_vote_and_recall_needs_verified_route_and_live_validator(tmp_path: Path) -> None:
    case_store, identity, batch = _batch(tmp_path, 1)
    experience_store = FeedbackExperienceStore(tmp_path / "experiences")
    case = batch.cases[0]
    published = experience_store.publish_batch(
        identity_key=identity.key,
        subject_id="meta",
        routing_key="route-a",
        candidates=[_candidate(batch)],
        source_cases=batch.cases,
        source_refs=batch.snapshots,
        now=100.0,
    )
    assert published[0].confidence <= 0.35
    assert published[0].tentative is True
    assert experience_store.recall(
        identity=identity,
        query="充电方案",
        subject_id="meta",
        routing_key=None,
        evidence_validator=case_store.validate_evidence,
    ) == ()
    assert experience_store.recall(
        identity=identity,
        query="充电方案",
        subject_id="meta",
        routing_key="route-a",
        evidence_validator=None,
    ) == ()
    assert experience_store.recall(
        identity=identity,
        query="充电方案",
        subject_id="meta",
        routing_key="route-a",
        evidence_validator=case_store.validate_evidence,
    )
    assert case.answer not in experience_store.recall_context(
        identity=identity,
        query="充电方案",
        subject_id="meta",
        routing_key="route-a",
        evidence_validator=case_store.validate_evidence,
    ).text


def test_conflicting_sources_are_downweighted_on_publish_and_recall(tmp_path: Path) -> None:
    case_store = FeedbackCaseStore(tmp_path / "cases")
    experience_store = FeedbackExperienceStore(tmp_path / "experiences")
    identity = _identity()
    for index, value in enumerate(("like", "dislike")):
        case_store.record_vote(identity=identity, message=_message(index), value=value, now=float(index))
    # Age makes a two-case group due without weakening the threshold in the store.
    batch = case_store.due_batches(identity, now=86_401.0)[0]
    published = experience_store.publish_batch(
        identity_key=identity.key,
        subject_id=batch.subject_id,
        routing_key=batch.routing_key,
        candidates=[_candidate(batch)],
        source_cases=batch.cases,
        source_refs=batch.snapshots,
        now=86_401.0,
    )
    assert published[0].signal == "mixed"
    assert published[0].confidence <= 0.45
    assert published[0].tentative is True
    assert published[0].conflict_penalty >= 0.5


def test_publish_validates_all_candidates_before_mutating_and_rolls_back_persist_failure(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    case_store, identity, batch = _batch(tmp_path, 5)
    experience_store = FeedbackExperienceStore(tmp_path / "experiences")
    invalid = _candidate(batch, guidance="x" * 421)
    with pytest.raises(FeedbackExperienceError):
        experience_store.publish_batch(
            identity_key=identity.key,
            subject_id=batch.subject_id,
            routing_key=batch.routing_key,
            candidates=[_candidate(batch), invalid],
            source_cases=batch.cases,
            source_refs=batch.snapshots,
            now=100.0,
        )
    assert experience_store.experiences == ()

    original_persist = experience_store._persist_locked

    def fail_persist() -> None:
        raise FeedbackExperienceError("disk full")

    monkeypatch.setattr(experience_store, "_persist_locked", fail_persist)
    with pytest.raises(FeedbackExperienceError):
        experience_store.publish_batch(
            identity_key=identity.key,
            subject_id=batch.subject_id,
            routing_key=batch.routing_key,
            candidates=[_candidate(batch)],
            source_cases=batch.cases,
            source_refs=batch.snapshots,
            now=100.0,
        )
    assert experience_store.experiences == ()
    monkeypatch.setattr(experience_store, "_persist_locked", original_persist)


def test_experience_eviction_is_bounded(tmp_path: Path) -> None:
    case_store = FeedbackCaseStore(tmp_path / "cases")
    experience_store = FeedbackExperienceStore(tmp_path / "experiences", max_experiences=1)
    identity = _identity()
    for index in range(5):
        case_store.record_vote(identity=identity, message=_message(index), value="like", now=float(index))
    batch = case_store.due_batches(identity, now=100.0)[0]
    experience_store.publish_batch(
        identity_key=identity.key,
        subject_id=batch.subject_id,
        routing_key=batch.routing_key,
        candidates=[_candidate(batch)],
        source_cases=batch.cases,
        source_refs=batch.snapshots,
        now=100.0,
    )
    # Same sources but changed guidance create a second deterministic row.
    experience_store.publish_batch(
        identity_key=identity.key,
        subject_id=batch.subject_id,
        routing_key=batch.routing_key,
        candidates=[_candidate(batch, guidance="只给出三条简短建议。")],
        source_cases=batch.cases,
        source_refs=batch.snapshots,
        now=101.0,
    )
    assert len(experience_store.experiences) == 1


def test_recall_ignores_guidance_and_short_unrelated_overlap(tmp_path: Path) -> None:
    case_store, identity, batch = _batch(tmp_path, 5)
    experience_store = FeedbackExperienceStore(tmp_path / "experiences")
    experience_store.publish_batch(
        identity_key=identity.key,
        subject_id=batch.subject_id,
        routing_key=batch.routing_key,
        candidates=[{
            "applicability": "季度销售报告",
            "guidance": "保留地区维度并使用表格比较变化。",
            "keywords": ["地区", "季度"],
            "confidence": 0.99,
            "source_feedback_ids": list(batch.source_feedback_ids),
        }],
        source_cases=batch.cases,
        source_refs=batch.snapshots,
        now=100.0,
    )

    recall_args = {
        "identity": identity,
        "subject_id": "meta",
        "routing_key": "route-a",
        "evidence_validator": case_store.validate_evidence,
    }
    assert experience_store.recall(query="请设计用户注册表单", **recall_args) == ()
    assert experience_store.recall(query="表", **recall_args) == ()
    assert experience_store.recall(query="请整理季度销售报告", **recall_args)


def test_recall_keeps_complete_chinese_and_english_keyword_hits(tmp_path: Path) -> None:
    case_store, identity, batch = _batch(tmp_path, 5)
    experience_store = FeedbackExperienceStore(tmp_path / "experiences")
    common = {
        "identity_key": identity.key,
        "subject_id": batch.subject_id,
        "routing_key": batch.routing_key,
        "source_cases": batch.cases,
        "source_refs": batch.snapshots,
        "now": 100.0,
    }
    experience_store.publish_batch(
        **common,
        candidates=[{
            "applicability": "电池充电策略",
            "guidance": "回答时说明充电上限与温度控制。",
            "keywords": ["充电方案"],
            "confidence": 0.99,
            "source_feedback_ids": list(batch.source_feedback_ids),
        }],
    )
    experience_store.publish_batch(
        **common,
        candidates=[{
            "applicability": "deployment checklist",
            "guidance": "Keep this advice concise.",
            "keywords": ["rollback"],
            "confidence": 0.99,
            "source_feedback_ids": list(batch.source_feedback_ids),
        }],
    )

    recall_args = {
        "identity": identity,
        "subject_id": "meta",
        "routing_key": "route-a",
        "evidence_validator": case_store.validate_evidence,
    }
    chinese = experience_store.recall(query="请给出充电方案", **recall_args)
    english = experience_store.recall(
        query="Please review the rollback checklist", **recall_args
    )
    assert chinese and chinese[0].keywords == ("充电方案",)
    assert english and english[0].keywords == ("rollback",)
