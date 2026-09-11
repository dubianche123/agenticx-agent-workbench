"""Strict, bounded model I/O for feedback experience distillation.

This module turns an immutable :class:`FeedbackBatch` into a small provider
request and validates the provider response before it reaches the case or
experience stores.  Provider construction, route authorization, scheduling,
and actual network access belong to the runtime worker.  The helpers here are
usable with a fake callable in tests and make no model request themselves.
"""

from __future__ import annotations

import asyncio
import inspect
import json
import math
import re
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Iterable, Mapping, Protocol, Sequence

from agenticx.studio.feedback_learning import (
    MAX_BATCH_CASES,
    MAX_CASE_CHARS,
    MAX_EXCERPT_CHARS,
    FeedbackBatch,
    FeedbackCase,
    FeedbackEvidenceRef,
    FeedbackLearningError,
)


MAX_DISTILLATION_INPUT_CHARS = 24_000
MAX_DISTILLATION_CASE_CHARS = 3_500
MAX_DISTILLATION_QUESTION_CHARS = 1_200
MAX_DISTILLATION_ANSWER_CHARS = 2_200
MAX_DISTILLATION_REASON_CHARS = 320
MAX_DISTILLATION_OUTPUTS = 8
MAX_APPLICABILITY_CHARS = 240
MAX_GUIDANCE_CHARS = 420
MAX_KEYWORDS = 8
MAX_KEYWORD_CHARS = 32
RETRY_BASE_SECONDS = 60.0
RETRY_MAX_SECONDS = 6 * 60 * 60.0

_CONTROL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


class FeedbackDistillationError(ValueError):
    """Raised when model input/output violates the distillation contract."""


@dataclass(frozen=True)
class DistillationEvidence:
    """Bounded raw evidence supplied to the background model only."""

    feedback_id: str
    revision: int
    evidence_hash: str
    value: str
    subject_id: str
    question: str
    answer: str
    question_digest: str
    answer_digest: str
    turn_id: str | None
    routing_key: str | None
    feedback_reason: str | None = None

    def as_payload(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "feedback_id": self.feedback_id,
            "revision": self.revision,
            "evidence_hash": self.evidence_hash,
            "value": self.value,
            "subject_id": self.subject_id,
            "question": self.question,
            "answer": self.answer,
            "question_digest": self.question_digest,
            "answer_digest": self.answer_digest,
            "turn_id": self.turn_id,
            "routing_key": self.routing_key,
        }
        # An absent reason is intentionally omitted.  A dislike button alone
        # is not evidence for a specific reason.
        if self.feedback_reason:
            payload["feedback_reason"] = self.feedback_reason
        return payload


@dataclass(frozen=True)
class FeedbackDistillationRequest:
    """Provider input with no account identifier and a hard total bound."""

    batch_id: str
    subject_id: str
    routing_key: str | None
    evidence: tuple[DistillationEvidence, ...]
    input_chars: int

    @property
    def source_feedback_ids(self) -> tuple[str, ...]:
        return tuple(item.feedback_id for item in self.evidence)

    @property
    def cases(self) -> tuple[DistillationEvidence, ...]:
        """Compatibility alias for callers that call model input cases."""

        return self.evidence

    def as_payload(self) -> dict[str, Any]:
        return {
            "batch_id": self.batch_id,
            "subject_id": self.subject_id,
            "routing_key": self.routing_key,
            "evidence": [item.as_payload() for item in self.evidence],
            "constraints": {
                "output_key": "experiences",
                "max_experiences": MAX_DISTILLATION_OUTPUTS,
                "max_keywords": MAX_KEYWORDS,
                "max_keyword_chars": MAX_KEYWORD_CHARS,
                "no_permanent_preference": True,
                "do_not_infer_dislike_reason": True,
            },
        }


# Shorter public alias for worker code.
DistillationRequest = FeedbackDistillationRequest


@dataclass(frozen=True)
class DistilledExperienceCandidate:
    applicability: str
    guidance: str
    keywords: tuple[str, ...]
    confidence: float
    source_feedback_ids: tuple[str, ...]

    @property
    def application(self) -> str:
        """Compatibility spelling used by the original design draft."""

        return self.applicability

    def as_payload(self) -> dict[str, Any]:
        return {
            "applicability": self.applicability,
            "guidance": self.guidance,
            "keywords": list(self.keywords),
            "confidence": self.confidence,
            "source_feedback_ids": list(self.source_feedback_ids),
        }


@dataclass(frozen=True)
class DistillationResult:
    experiences: tuple[DistilledExperienceCandidate, ...]

    def as_payload(self) -> dict[str, Any]:
        return {"experiences": [item.as_payload() for item in self.experiences]}


def _clean_text(value: Any, limit: int, field: str, *, allow_empty: bool = False) -> str:
    if not isinstance(value, str):
        raise FeedbackDistillationError(f"{field} must be a string")
    text = _CONTROL_RE.sub(" ", value).strip()
    if not text and allow_empty:
        return ""
    if not text:
        raise FeedbackDistillationError(f"{field} is empty")
    if len(text) > limit:
        raise FeedbackDistillationError(f"{field} is too long")
    return text


def _bounded_model_text(value: Any, limit: int, field: str) -> str:
    """Sanitize trusted case text and truncate only for provider input."""

    if not isinstance(value, str):
        raise FeedbackDistillationError(f"{field} must be a string")
    text = _CONTROL_RE.sub(" ", value).strip()
    if not text:
        raise FeedbackDistillationError(f"{field} is empty")
    return text[:limit]


def _clean_id(value: Any, field: str) -> str:
    text = _clean_text(value, 512, field)
    return text


def _clean_digest(value: Any, field: str) -> str:
    text = _clean_text(value, 128, field)
    if len(text) != 64 or any(char not in "0123456789abcdefABCDEF" for char in text):
        raise FeedbackDistillationError(f"invalid {field}")
    return text.lower()


def _finite_confidence(value: Any) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise FeedbackDistillationError("confidence must be a number")
    confidence = float(value)
    if not math.isfinite(confidence) or confidence < 0.0 or confidence > 1.0:
        raise FeedbackDistillationError("confidence must be between 0 and 1")
    return confidence


def _keywords(raw: Any) -> tuple[str, ...]:
    if raw is None:
        return ()
    if not isinstance(raw, list) or len(raw) > MAX_KEYWORDS:
        raise FeedbackDistillationError("keywords must contain at most eight strings")
    values: list[str] = []
    seen: set[str] = set()
    for value in raw:
        keyword = _clean_text(value, MAX_KEYWORD_CHARS, "keyword")
        marker = keyword.casefold()
        if marker in seen:
            raise FeedbackDistillationError("keywords must be unique")
        seen.add(marker)
        values.append(keyword)
    return tuple(values)


def _case_evidence(case: FeedbackCase) -> DistillationEvidence:
    question = _bounded_model_text(case.question, MAX_DISTILLATION_QUESTION_CHARS, "question")
    answer = _bounded_model_text(case.answer, MAX_DISTILLATION_ANSWER_CHARS, "answer")
    reason = None
    if case.feedback_reason:
        reason = _bounded_model_text(case.feedback_reason, MAX_DISTILLATION_REASON_CHARS, "feedback_reason")
    evidence = DistillationEvidence(
        feedback_id=_clean_id(case.id, "feedback_id"),
        revision=int(case.revision),
        evidence_hash=_clean_digest(case.evidence_hash, "evidence_hash"),
        value=case.value,
        subject_id=str(case.subject_id or "meta"),
        question=question,
        answer=answer,
        question_digest=_clean_digest(case.question_digest, "question_digest"),
        answer_digest=_clean_digest(case.answer_digest, "answer_digest"),
        turn_id=case.turn_id,
        routing_key=case.routing_key,
        feedback_reason=reason,
    )
    # Keep an individual row bounded as well as the aggregate request.  The
    # immutable digests still identify the complete pre-truncation evidence.
    while _payload_chars({"evidence": [evidence.as_payload()]}) > MAX_DISTILLATION_CASE_CHARS and len(answer) > 256:
        answer = answer[: max(256, len(answer) - 256)]
        evidence = DistillationEvidence(
            feedback_id=evidence.feedback_id,
            revision=evidence.revision,
            evidence_hash=evidence.evidence_hash,
            value=evidence.value,
            subject_id=evidence.subject_id,
            question=evidence.question,
            answer=answer,
            question_digest=evidence.question_digest,
            answer_digest=evidence.answer_digest,
            turn_id=evidence.turn_id,
            routing_key=evidence.routing_key,
            feedback_reason=evidence.feedback_reason,
        )
    if _payload_chars({"evidence": [evidence.as_payload()]}) > MAX_DISTILLATION_CASE_CHARS:
        raise FeedbackDistillationError("one evidence case exceeds bound")
    return evidence


def _payload_chars(payload: Mapping[str, Any]) -> int:
    return len(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))


def build_distillation_request(
    batch: FeedbackBatch,
    *,
    max_input_chars: int = MAX_DISTILLATION_INPUT_CHARS,
    max_cases: int = MAX_BATCH_CASES,
) -> FeedbackDistillationRequest:
    """Create bounded raw model input from an immutable batch snapshot."""

    if not isinstance(batch, FeedbackBatch):
        raise FeedbackDistillationError("batch is invalid")
    bound = max(1, min(int(max_input_chars), MAX_DISTILLATION_INPUT_CHARS))
    case_bound = max(1, min(int(max_cases), MAX_BATCH_CASES))
    if len(batch.cases) != len(batch.snapshots):
        raise FeedbackDistillationError("batch snapshot is invalid")
    if any(
        case.id != ref.feedback_id
        or case.revision != ref.revision
        or case.evidence_hash != ref.evidence_hash
        or case.identity_key != batch.identity_key
        or (case.subject_id or "meta") != batch.subject_id
        or case.routing_key != batch.routing_key
        or not case.is_pending
        for case, ref in zip(batch.cases, batch.snapshots)
    ):
        raise FeedbackDistillationError("batch evidence revision is invalid")
    evidence: list[DistillationEvidence] = []
    for case in batch.cases[:case_bound]:
        current = _case_evidence(case)
        candidate = tuple(evidence + [current])
        request_probe = {
            "batch_id": batch.id,
            "subject_id": batch.subject_id,
            "routing_key": batch.routing_key,
            "evidence": [item.as_payload() for item in candidate],
        }
        # Keep every retained row complete.  A row that would cross the
        # aggregate cap is omitted; the source revision remains in the batch
        # snapshot and the worker can retry with a smaller configured bound.
        if _payload_chars(request_probe) > bound:
            break
        evidence.append(current)
    if not evidence:
        raise FeedbackDistillationError("batch has no bounded evidence")
    # The user-facing constraints add bytes that are absent from the probe.
    # Trim whole evidence rows until the *actual* serialized provider payload
    # fits the caller's hard bound.
    while evidence:
        request = FeedbackDistillationRequest(
            batch_id=batch.id,
            subject_id=batch.subject_id,
            routing_key=batch.routing_key,
            evidence=tuple(evidence),
            input_chars=0,
        )
        actual = _payload_chars(request.as_payload())
        if actual <= bound:
            return FeedbackDistillationRequest(
                batch_id=request.batch_id,
                subject_id=request.subject_id,
                routing_key=request.routing_key,
                evidence=request.evidence,
                input_chars=actual,
            )
        evidence.pop()
    raise FeedbackDistillationError("distillation input exceeds bound")


def _response_mapping(payload: Any) -> Mapping[str, Any]:
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except (TypeError, ValueError, json.JSONDecodeError) as exc:
            raise FeedbackDistillationError("model response is not JSON") from exc
    if not isinstance(payload, Mapping):
        raise FeedbackDistillationError("model response must be an object")
    if set(payload) != {"experiences"}:
        raise FeedbackDistillationError("model response has unknown fields")
    return payload


def parse_distillation_response(
    payload: Any,
    *,
    allowed_feedback_ids: Iterable[str],
    max_experiences: int = MAX_DISTILLATION_OUTPUTS,
) -> DistillationResult:
    """Strictly parse provider output and reject unknown source evidence."""

    response = _response_mapping(payload)
    raw_experiences = response.get("experiences")
    if not isinstance(raw_experiences, list):
        raise FeedbackDistillationError("experiences must be a list")
    output_bound = max(0, min(int(max_experiences), MAX_DISTILLATION_OUTPUTS))
    if len(raw_experiences) > output_bound:
        raise FeedbackDistillationError("too many experiences")
    allowed = {str(value).strip() for value in allowed_feedback_ids}
    if not allowed and raw_experiences:
        raise FeedbackDistillationError("no allowed evidence")
    parsed: list[DistilledExperienceCandidate] = []
    allowed_fields = {
        "applicability",
        "application",
        "guidance",
        "keywords",
        "confidence",
        "source_feedback_ids",
    }
    for raw in raw_experiences:
        if not isinstance(raw, Mapping) or not set(raw).issubset(allowed_fields):
            raise FeedbackDistillationError("experience has unknown fields")
        if "applicability" in raw and "application" in raw:
            raise FeedbackDistillationError("duplicate applicability fields")
        applicability = _clean_text(
            raw.get("applicability", raw.get("application")),
            MAX_APPLICABILITY_CHARS,
            "applicability",
        )
        guidance = _clean_text(raw.get("guidance"), MAX_GUIDANCE_CHARS, "guidance")
        keywords = _keywords(raw.get("keywords", []))
        confidence = _finite_confidence(raw.get("confidence"))
        source_raw = raw.get("source_feedback_ids")
        if not isinstance(source_raw, list) or not source_raw or len(source_raw) > MAX_BATCH_CASES:
            raise FeedbackDistillationError("source_feedback_ids is invalid")
        source_ids = tuple(_clean_id(value, "source_feedback_id") for value in source_raw)
        if len(source_ids) != len(set(source_ids)) or any(value not in allowed for value in source_ids):
            raise FeedbackDistillationError("unknown or duplicate source feedback id")
        parsed.append(
            DistilledExperienceCandidate(
                applicability=applicability,
                guidance=guidance,
                keywords=keywords,
                confidence=confidence,
                source_feedback_ids=source_ids,
            )
        )
    return DistillationResult(tuple(parsed))


def retry_delay(attempt: int, *, base_seconds: float = RETRY_BASE_SECONDS, max_seconds: float = RETRY_MAX_SECONDS) -> float:
    """Return bounded exponential delay for an attempt number starting at 1."""

    try:
        attempt_number = max(1, int(attempt))
        base = max(0.0, float(base_seconds))
        cap = max(0.0, float(max_seconds))
    except (TypeError, ValueError, OverflowError):
        return RETRY_BASE_SECONDS
    return min(cap, base * (2 ** min(attempt_number - 1, 16)))


class DistillationProvider(Protocol):
    def __call__(self, request: Mapping[str, Any]) -> Any: ...


async def distill_one(
    request: FeedbackDistillationRequest,
    provider: DistillationProvider | Callable[[Mapping[str, Any]], Awaitable[Any]],
    *,
    timeout_seconds: float = 30.0,
) -> DistillationResult:
    """Invoke a supplied provider with timeout, then validate its response."""

    timeout = max(0.1, float(timeout_seconds))
    try:
        payload = request.as_payload()
        provider_call = getattr(provider, "__call__", provider)
        if inspect.iscoroutinefunction(provider_call):
            result = await asyncio.wait_for(provider(payload), timeout=timeout)
        else:
            # A synchronous provider must run off the event loop; wait_for
            # bounds the await even while the worker thread is still winding
            # down after cancellation.
            result = await asyncio.wait_for(asyncio.to_thread(provider, payload), timeout=timeout)
            if inspect.isawaitable(result):
                result = await asyncio.wait_for(result, timeout=timeout)
    except asyncio.TimeoutError as exc:
        raise FeedbackDistillationError("distillation timed out") from exc
    except FeedbackDistillationError:
        raise
    except Exception as exc:
        raise FeedbackDistillationError("distillation provider failed") from exc
    return parse_distillation_response(result, allowed_feedback_ids=request.source_feedback_ids)


__all__ = [
    "DistillationEvidence",
    "DistillationProvider",
    "DistillationRequest",
    "DistillationResult",
    "DistilledExperienceCandidate",
    "FeedbackDistillationError",
    "FeedbackDistillationRequest",
    "MAX_DISTILLATION_ANSWER_CHARS",
    "MAX_DISTILLATION_CASE_CHARS",
    "MAX_DISTILLATION_INPUT_CHARS",
    "MAX_DISTILLATION_OUTPUTS",
    "MAX_DISTILLATION_QUESTION_CHARS",
    "build_distillation_request",
    "distill_one",
    "parse_distillation_response",
    "retry_delay",
]
