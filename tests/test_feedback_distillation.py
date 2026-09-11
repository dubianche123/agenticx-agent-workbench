from __future__ import annotations

import asyncio
import time
from pathlib import Path

import pytest

from agenticx.studio.feedback_distillation import (
    FeedbackDistillationError,
    build_distillation_request,
    distill_one,
    parse_distillation_response,
    retry_delay,
)
from agenticx.studio.feedback_learning import CanonicalFeedbackMessage, FeedbackCaseStore, FeedbackIdentity


def _identity() -> FeedbackIdentity:
    return FeedbackIdentity(scope_id="scope-a", user_id="user-a", tenant_id="tenant-a")


def _batch(tmp_path: Path, count: int = 32):
    store = FeedbackCaseStore(tmp_path)
    identity = _identity()
    for index in range(count):
        store.record_vote(
            identity=identity,
            message=CanonicalFeedbackMessage(
                session_id=f"session-{index}",
                message_id=f"message-{index}",
                question="问题 " + "q" * 4_000,
                answer="答案 " + "a" * 4_000,
                subject_id="meta",
                routing_key="route-a",
            ),
            value="like",
            now=0.0,
        )
    return store.due_batches(identity, now=1.0, batch_limit=32)[0]


def test_distillation_request_truncates_long_cases_and_has_hard_aggregate_cap(tmp_path: Path) -> None:
    batch = _batch(tmp_path)
    request = build_distillation_request(batch)
    assert request.input_chars <= 24_000
    assert 1 <= len(request.evidence) < len(batch.cases)
    assert all(len(item.question) <= 1_200 and len(item.answer) <= 2_200 for item in request.evidence)
    assert set(request.source_feedback_ids).issubset(set(batch.source_feedback_ids))


def test_distillation_response_is_strict_and_allows_empty_output() -> None:
    assert parse_distillation_response({"experiences": []}, allowed_feedback_ids=["f1"]).experiences == ()
    parsed = parse_distillation_response(
        {
            "experiences": [{
                "application": "电池充电问题",
                "guidance": "先给出充电上限建议。",
                "keywords": ["充电策略"],
                "confidence": 0.9,
                "source_feedback_ids": ["f1"],
            }]
        },
        allowed_feedback_ids=["f1"],
    )
    assert parsed.experiences[0].applicability == "电池充电问题"
    invalid_responses = (
        {"experiences": [{"applicability": "x", "guidance": "y", "confidence": 0.5, "source_feedback_ids": ["unknown"]}]},
        {"experiences": [{"applicability": "x", "guidance": "y", "confidence": 0.5, "source_feedback_ids": ["f1"], "extra": 1}]},
        {"experiences": [{"applicability": "x" * 241, "guidance": "y", "confidence": 0.5, "source_feedback_ids": ["f1"]}]},
        {"experiences": [{"applicability": "x", "guidance": "y", "confidence": 0.5, "source_feedback_ids": ["f1", "f1"]}]},
    )
    for payload in invalid_responses:
        with pytest.raises(FeedbackDistillationError):
            parse_distillation_response(payload, allowed_feedback_ids=["f1"])


def test_distillation_provider_timeout_does_not_block_for_sync_callable() -> None:
    def slow_provider(_payload):
        time.sleep(0.4)
        return {"experiences": []}

    started = time.monotonic()
    with pytest.raises(FeedbackDistillationError, match="timed out"):
        asyncio.run(
            distill_one(
                # Small synthetic request is enough to exercise timeout path.
                type("Request", (), {
                    "source_feedback_ids": ("f1",),
                    "as_payload": lambda self: {"evidence": [{"feedback_id": "f1"}]},
                })(),
                slow_provider,
                timeout_seconds=0.05,
            )
        )
    # asyncio.run waits for the executor thread to wind down after the
    # timeout; the event loop itself is never blocked by provider execution.
    assert time.monotonic() - started < 0.7


def test_retry_delay_is_bounded_exponential() -> None:
    assert retry_delay(1) == 60.0
    assert retry_delay(2) == 120.0
    assert retry_delay(100) == 6 * 60 * 60.0
