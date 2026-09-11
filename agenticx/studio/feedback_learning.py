"""Bounded, revisioned feedback evidence for background learning.

The Enterprise feedback row remains the source of truth for a vote.  This
module keeps a small local projection of that vote for two narrowly scoped
uses: the current conversation can resolve its own feedback labels, and a
background worker can snapshot bounded evidence for distillation.

Raw question/answer text is never returned by the cross-session context API.
Only :mod:`agenticx.studio.feedback_experiences` may turn a validated batch
into a short reusable experience.  Revision tombstones prevent cancelled,
reversed, or evicted evidence from making an old batch valid again.  The
module never reads or writes ``MEMORY.md`` / ``USER.md``.
"""

from __future__ import annotations

import hashlib
import inspect
import json
import math
import os
import re
import tempfile
import threading
import time
from dataclasses import asdict, dataclass, replace
from pathlib import Path
from typing import Any, Callable, Iterable, Literal, Mapping, Protocol, Sequence

from fastapi import FastAPI, Header, HTTPException, Request

from agenticx.utils.agx_home import agx_home


FEEDBACK_VALUES = frozenset({"like", "dislike"})
MAX_CASES = 512
MAX_CASE_CHARS = 4_000
MAX_CONTEXT_CHARS = 900
MAX_QUERY_CHARS = 4_000
MAX_SUBJECT_CHARS = 256
MAX_ID_CHARS = 512
MAX_EXCERPT_CHARS = 320
MAX_BATCH_CASES = 32
MIN_PENDING_CASES = 5
PENDING_MAX_AGE_SECONDS = 86_400.0
SUCCESS_COOLDOWN_SECONDS = 300.0
MAX_LEDGER_TOMBSTONES = MAX_CASES
DEFAULT_SUBJECT_ID = "meta"
DEFAULT_RETRY_BASE_SECONDS = 60.0
MAX_RETRY_DELAY_SECONDS = 6 * 60 * 60.0
STATE_VERSION = 2

_TOKEN_RE = re.compile(r"[A-Za-z0-9_]+|[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]")
_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$")
_DIGEST_RE = re.compile(r"^[0-9a-f]{64}$")
_STOPWORDS = frozenset(
    {
        "请",
        "继续",
        "帮",
        "我",
        "你",
        "的",
        "了",
        "和",
        "与",
        "并",
        "列出",
        "说明",
        "比较",
        "分析",
        "如何",
        "什么",
        "这个",
        "一下",
        "please",
        "the",
        "and",
        "with",
    }
)


class FeedbackLearningError(ValueError):
    """Invalid input or an unavailable local learning store."""


@dataclass(frozen=True)
class FeedbackIdentity:
    """Authenticated account boundary for feedback evidence and recall."""

    scope_id: str
    user_id: str
    tenant_id: str | None = None

    def __post_init__(self) -> None:
        # ``scope_id`` may be a canonical JSON tuple from Desktop.  It is an
        # opaque account boundary, so reject control bytes without forcing it
        # through the filename-safe identifier grammar.
        object.__setattr__(self, "scope_id", _bounded_scope(self.scope_id))
        object.__setattr__(self, "user_id", _bounded_identifier(self.user_id, "user_id"))
        tenant = _bounded_identifier(self.tenant_id, "tenant_id", allow_empty=True)
        object.__setattr__(self, "tenant_id", tenant or None)

    @property
    def key(self) -> str:
        tenant = self.tenant_id or "-"
        return f"{self.scope_id}\x00{tenant}\x00{self.user_id}"


@dataclass(frozen=True)
class CanonicalFeedbackMessage:
    """Server-resolved message pair used to create one feedback case.

    Question/answer are resolved from local persisted rows.  Optional digests
    should be computed by the runtime before any display/storage cap; the
    local store computes a bounded fallback for legacy callers.
    """

    session_id: str
    message_id: str
    question: str
    answer: str
    subject_id: str | None = None
    avatar_id: str | None = None
    question_digest: str | None = None
    answer_digest: str | None = None
    turn_id: str | None = None
    routing_key: str | None = None
    answer_excerpt: str | None = None
    feedback_reason: str | None = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "session_id", _bounded_identifier(self.session_id, "session_id"))
        object.__setattr__(self, "message_id", _bounded_identifier(self.message_id, "message_id"))
        object.__setattr__(self, "question", _bounded_text(self.question, MAX_CASE_CHARS, "question"))
        object.__setattr__(self, "answer", _bounded_text(self.answer, MAX_CASE_CHARS, "answer"))
        subject = _bounded_text(
            self.subject_id or self.avatar_id or "",
            MAX_SUBJECT_CHARS,
            "subject_id",
            allow_empty=True,
        )
        object.__setattr__(self, "subject_id", subject or None)
        avatar = _bounded_text(self.avatar_id or "", MAX_SUBJECT_CHARS, "avatar_id", allow_empty=True)
        object.__setattr__(self, "avatar_id", avatar or None)
        object.__setattr__(self, "question_digest", _coerce_digest(self.question_digest, self.question))
        object.__setattr__(self, "answer_digest", _coerce_digest(self.answer_digest, self.answer))
        object.__setattr__(self, "turn_id", _bounded_optional(self.turn_id, MAX_ID_CHARS, "turn_id"))
        object.__setattr__(self, "routing_key", _bounded_optional(self.routing_key, MAX_ID_CHARS, "routing_key"))
        excerpt = self.answer_excerpt if self.answer_excerpt is not None else self.answer
        object.__setattr__(self, "answer_excerpt", _bounded_text(excerpt, MAX_EXCERPT_CHARS, "answer_excerpt"))
        object.__setattr__(
            self,
            "feedback_reason",
            _bounded_optional(self.feedback_reason, MAX_EXCERPT_CHARS, "feedback_reason"),
        )


@dataclass(frozen=True)
class FeedbackCase:
    """Current active vote plus bounded raw evidence for backend use only."""

    id: str
    identity_key: str
    session_id: str
    message_id: str
    subject_id: str | None
    question: str
    answer: str
    value: str
    created_at: float
    revision: int = 1
    pending_since: float = 0.0
    processed_revision: int | None = None
    evidence_hash: str = ""
    question_digest: str = ""
    answer_digest: str = ""
    turn_id: str | None = None
    routing_key: str | None = None
    answer_excerpt: str = ""
    feedback_reason: str | None = None

    @property
    def feedback_id(self) -> str:
        return self.id

    @property
    def is_pending(self) -> bool:
        return self.processed_revision != self.revision

    def as_context(self) -> dict[str, Any]:
        """Return raw evidence for a backend distillation request only."""

        return {
            "case_id": self.id,
            "subject_id": self.subject_id,
            "question": self.question,
            "answer": self.answer,
            "value": self.value,
            "revision": self.revision,
            "evidence_hash": self.evidence_hash,
            "question_digest": self.question_digest,
            "answer_digest": self.answer_digest,
            "turn_id": self.turn_id,
            "routing_key": self.routing_key,
            "answer_excerpt": self.answer_excerpt,
            "feedback_reason": self.feedback_reason,
        }


@dataclass(frozen=True)
class FeedbackEvidenceRef:
    """Immutable revision/evidence token captured by a distillation batch."""

    feedback_id: str
    revision: int
    evidence_hash: str


@dataclass(frozen=True)
class FeedbackMutation:
    """Result of an upsert/cancel operation."""

    feedback_id: str
    revision: int
    value: str | None
    removed: bool
    state: Literal["active", "cancelled", "evicted"]


@dataclass(frozen=True)
class FeedbackBatch:
    """A bounded immutable snapshot passed to the background distiller."""

    id: str
    identity_key: str
    subject_id: str
    routing_key: str | None
    cases: tuple[FeedbackCase, ...]
    snapshots: tuple[FeedbackEvidenceRef, ...]
    trigger: Literal["count", "age"]
    oldest_pending_at: float
    created_at: float

    @property
    def source_feedback_ids(self) -> tuple[str, ...]:
        return tuple(item.feedback_id for item in self.snapshots)


@dataclass(frozen=True)
class FeedbackBatchResult:
    """Outcome of a finish/failure attempt."""

    status: Literal["committed", "stale", "retry", "rejected", "ignored"]
    experience_ids: tuple[str, ...] = ()
    next_retry_at: float | None = None
    reason: str | None = None


@dataclass(frozen=True)
class FeedbackLearningContext:
    """Cross-session context; ``cases`` is retained only for compatibility."""

    cases: tuple[FeedbackCase, ...] = ()
    text: str = ""
    experiences: tuple[Any, ...] = ()

    @property
    def count(self) -> int:
        return len(self.experiences) if self.experiences else len(self.cases)


def _bounded_identifier(value: Any, field: str, *, allow_empty: bool = False) -> str:
    text = str(value or "").strip()
    if not text and allow_empty:
        return ""
    if not text or len(text) > MAX_ID_CHARS or not _ID_RE.fullmatch(text):
        raise FeedbackLearningError(f"invalid {field}")
    return text


def _bounded_scope(value: Any) -> str:
    text = str(value or "").strip()
    if not text or len(text) > MAX_ID_CHARS or any(ord(char) < 0x20 for char in text):
        raise FeedbackLearningError("invalid scope_id")
    return text


def _bounded_text(value: Any, limit: int, field: str, *, allow_empty: bool = False) -> str:
    if not isinstance(value, str):
        if allow_empty and value is None:
            return ""
        raise FeedbackLearningError(f"{field} must be a string")
    text = value.replace("\x00", " ").strip()
    if not text and allow_empty:
        return ""
    if not text:
        raise FeedbackLearningError(f"{field} is empty")
    return text[:limit]


def _bounded_optional(value: Any, limit: int, field: str) -> str | None:
    if value is None:
        return None
    text = _bounded_text(value, limit, field, allow_empty=True)
    return text or None


def _digest_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _coerce_digest(value: Any, fallback: str) -> str:
    text = str(value or "").strip().lower()
    return text if _DIGEST_RE.fullmatch(text) else _digest_text(fallback)


def _tokens(value: str) -> set[str]:
    normalized = value.casefold()
    return {
        token
        for token in _TOKEN_RE.findall(normalized)
        if token.strip("_") and token not in _STOPWORDS
    }


def lexical_similarity(query: str, candidate: str) -> float:
    """Return a conservative language-neutral overlap score in ``[0, 1]``."""

    left = _tokens(query)
    right = _tokens(candidate)
    if not left or not right:
        return 0.0
    return len(left & right) / max(4, len(left), len(right))


def feedback_id_for(identity: FeedbackIdentity, session_id: str, message_id: str) -> str:
    """Return the stable local id used for every revision of one vote."""

    sid = _bounded_identifier(session_id, "session_id")
    mid = _bounded_identifier(message_id, "message_id")
    digest = _digest_text(f"{identity.key}\x00{sid}\x00{mid}")[:24]
    return f"feedback-{digest}"


def _default_store_root() -> Path:
    configured = str(os.environ.get("AGX_FEEDBACK_LEARNING_ROOT", "") or "").strip()
    return Path(configured).expanduser() if configured else agx_home() / "feedback-learning"


def _atomic_write_json(path: Path, payload: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent))
    temp_path = Path(temp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"))
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_path, path)
    finally:
        try:
            temp_path.unlink()
        except FileNotFoundError:
            pass


def _evidence_hash(
    *,
    value: str,
    subject_id: str | None,
    question_digest: str,
    answer_digest: str,
    turn_id: str | None,
    routing_key: str | None,
    feedback_reason: str | None,
) -> str:
    payload = {
        "value": value,
        "subject_id": subject_id or DEFAULT_SUBJECT_ID,
        "question_digest": question_digest,
        "answer_digest": answer_digest,
        "turn_id": turn_id,
        "routing_key": routing_key,
        "feedback_reason": feedback_reason,
    }
    return _digest_text(json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")))


def _case_from_row(raw: Mapping[str, Any]) -> FeedbackCase | None:
    try:
        value = str(raw.get("value", "")).strip()
        if value not in FEEDBACK_VALUES:
            return None
        question = _bounded_text(raw.get("question"), MAX_CASE_CHARS, "question")
        answer = _bounded_text(raw.get("answer"), MAX_CASE_CHARS, "answer")
        revision = max(1, int(raw.get("revision", 1) or 1))
        processed_raw = raw.get("processed_revision")
        processed = None if processed_raw is None else max(0, int(processed_raw))
        pending_since = float(raw.get("pending_since", raw.get("created_at", 0.0)) or 0.0)
        created_at = float(raw.get("created_at", pending_since) or pending_since)
        subject = _bounded_text(raw.get("subject_id") or "", MAX_SUBJECT_CHARS, "subject_id", allow_empty=True) or None
        turn_id = _bounded_optional(raw.get("turn_id"), MAX_ID_CHARS, "turn_id")
        routing_key = _bounded_optional(raw.get("routing_key"), MAX_ID_CHARS, "routing_key")
        excerpt = _bounded_text(raw.get("answer_excerpt") or answer, MAX_EXCERPT_CHARS, "answer_excerpt")
        feedback_reason = _bounded_optional(raw.get("feedback_reason"), MAX_EXCERPT_CHARS, "feedback_reason")
        question_digest = _coerce_digest(raw.get("question_digest"), question)
        answer_digest = _coerce_digest(raw.get("answer_digest"), answer)
        evidence_hash = str(raw.get("evidence_hash", "") or "").strip().lower()
        if not _DIGEST_RE.fullmatch(evidence_hash):
            evidence_hash = _evidence_hash(
                value=value,
                subject_id=subject,
                question_digest=question_digest,
                answer_digest=answer_digest,
                turn_id=turn_id,
                routing_key=routing_key,
                feedback_reason=feedback_reason,
            )
        return FeedbackCase(
            id=_bounded_identifier(raw.get("id"), "id"),
            identity_key=str(raw.get("identity_key", "")),
            session_id=_bounded_identifier(raw.get("session_id"), "session_id"),
            message_id=_bounded_identifier(raw.get("message_id"), "message_id"),
            subject_id=subject,
            question=question,
            answer=answer,
            value=value,
            created_at=created_at,
            revision=revision,
            pending_since=pending_since,
            processed_revision=processed,
            evidence_hash=evidence_hash,
            question_digest=question_digest,
            answer_digest=answer_digest,
            turn_id=turn_id,
            routing_key=routing_key,
            answer_excerpt=excerpt,
            feedback_reason=feedback_reason,
        )
    except (FeedbackLearningError, TypeError, ValueError, OverflowError):
        return None


class CanonicalMessageResolver(Protocol):
    def __call__(self, session_id: str, message_id: str) -> CanonicalFeedbackMessage | Mapping[str, Any] | None: ...


class IdentityResolver(Protocol):
    def __call__(self, request: Request) -> FeedbackIdentity | Mapping[str, Any] | None: ...


class FeedbackCaseStore:
    """Single-file, account-scoped projection of current feedback votes.

    ``state.json`` is the canonical v2 file.  If it does not exist, legacy
    ``cases.jsonl`` rows are imported as active pending cases with revision 1;
    they remain backend evidence and are never exposed as cross-session raw
    context.  Once a v2 state exists, a missing/corrupt state never falls back
    to the old JSONL, so cancellation and ABA protection survive restart.
    """

    def __init__(
        self,
        root: str | Path | None = None,
        *,
        max_cases: int = MAX_CASES,
        max_case_chars: int = MAX_CASE_CHARS,
    ) -> None:
        self.root = Path(root).expanduser() if root is not None else _default_store_root()
        self.root.mkdir(parents=True, exist_ok=True)
        self.path = self.root / "cases.jsonl"  # legacy public path
        self.state_path = self.root / "state.json"
        self.max_cases = max(1, min(int(max_cases), MAX_CASES))
        self.max_case_chars = max(128, min(int(max_case_chars), MAX_CASE_CHARS))
        self._lock = threading.RLock()
        self._cases: dict[tuple[str, str, str], FeedbackCase] = {}
        # Ledger rows deliberately contain no raw question/answer.
        self._ledger: dict[str, dict[str, Any]] = {}
        self._jobs: dict[str, dict[str, Any]] = {}
        # Scheduling state is keyed by the privacy group rather than the
        # immutable batch id.  A new vote changes a batch id; it must not
        # bypass a successful cooldown or a failed attempt's backoff.
        self._group_jobs: dict[str, dict[str, Any]] = {}
        self._generation = 0
        self._load()

    @property
    def cases(self) -> tuple[FeedbackCase, ...]:
        with self._lock:
            return tuple(sorted(self._cases.values(), key=lambda item: (item.created_at, item.id)))

    @property
    def pending_cases(self) -> tuple[FeedbackCase, ...]:
        with self._lock:
            return tuple(
                sorted(
                    (item for item in self._cases.values() if item.is_pending),
                    key=lambda item: (item.pending_since or item.created_at, item.id),
                )
            )

    def _load(self) -> None:
        state_existed = self.state_path.exists()
        loaded = False
        if state_existed:
            try:
                raw = json.loads(self.state_path.read_text(encoding="utf-8"))
                if isinstance(raw, Mapping) and int(raw.get("version", 0) or 0) >= STATE_VERSION:
                    self._generation = max(0, int(raw.get("generation", 0) or 0))
                    for row in raw.get("cases", []):
                        if not isinstance(row, Mapping):
                            continue
                        case = _case_from_row(row)
                        if case is not None and case.identity_key:
                            self._cases[(case.identity_key, case.session_id, case.message_id)] = case
                    ledger = raw.get("ledger")
                    if isinstance(ledger, Mapping):
                        self._ledger = {
                            str(key): dict(value)
                            for key, value in ledger.items()
                            if isinstance(value, Mapping)
                        }
                    jobs = raw.get("jobs")
                    if isinstance(jobs, Mapping):
                        self._jobs = {
                            str(key): dict(value)
                            for key, value in jobs.items()
                            if isinstance(value, Mapping)
                        }
                    groups = raw.get("groups")
                    if isinstance(groups, Mapping):
                        self._group_jobs = {
                            str(key): dict(value)
                            for key, value in groups.items()
                            if isinstance(value, Mapping)
                        }
                    loaded = True
            except (OSError, TypeError, ValueError, json.JSONDecodeError):
                loaded = False
        # Never revive an old JSONL after a v2 state has existed, even if that
        # state was truncated by a crash.  Fail closed and let the Enterprise
        # vote mirror retry.
        if not loaded and not state_existed and self.path.exists():
            self._load_legacy_jsonl()
        with self._lock:
            for case in tuple(self._cases.values()):
                self._ensure_ledger_locked(case)
            self._trim_locked(time.time())
            self._prune_ledger_locked()
            self._prune_group_jobs_locked()

    def _load_legacy_jsonl(self) -> None:
        try:
            with self.path.open("r", encoding="utf-8") as handle:
                for line in handle:
                    if not line.strip():
                        continue
                    try:
                        raw = json.loads(line)
                    except (TypeError, ValueError, json.JSONDecodeError):
                        continue
                    if not isinstance(raw, Mapping):
                        continue
                    case = _case_from_row(raw)
                    if case is not None and case.identity_key:
                        key = (case.identity_key, case.session_id, case.message_id)
                        self._cases[key] = case
        except OSError:
            self._cases.clear()

    def _ensure_ledger_locked(self, case: FeedbackCase) -> None:
        current = self._ledger.get(case.id)
        if current is not None and int(current.get("revision", 0) or 0) >= case.revision:
            return
        self._ledger[case.id] = {
            "revision": case.revision,
            "state": "active",
            "identity_key": case.identity_key,
            "session_id": case.session_id,
            "message_id": case.message_id,
            "subject_id": case.subject_id,
            "routing_key": case.routing_key,
            "value": case.value,
            "evidence_hash": case.evidence_hash,
            "updated_at": case.created_at,
        }

    def _case_key(self, identity: FeedbackIdentity, session_id: str, message_id: str) -> tuple[str, str, str]:
        sid = _bounded_identifier(session_id, "session_id")
        mid = _bounded_identifier(message_id, "message_id")
        return identity.key, sid, mid

    def _case_for_id_locked(self, feedback_id: str) -> FeedbackCase | None:
        for case in self._cases.values():
            if case.id == feedback_id:
                return case
        return None

    def _trim_locked(self, now: float) -> None:
        if len(self._cases) <= self.max_cases:
            return
        keep = sorted(
            self._cases.values(),
            key=lambda item: (item.created_at, item.revision, item.id),
            reverse=True,
        )[: self.max_cases]
        keep_keys = {(item.identity_key, item.session_id, item.message_id) for item in keep}
        for key, case in tuple(self._cases.items()):
            if key in keep_keys:
                continue
            self._ledger[case.id] = {
                "revision": case.revision,
                "state": "evicted",
                "identity_key": case.identity_key,
                "session_id": case.session_id,
                "message_id": case.message_id,
                "subject_id": case.subject_id,
                "routing_key": case.routing_key,
                "value": case.value,
                "evidence_hash": case.evidence_hash,
                "updated_at": now,
            }
            del self._cases[key]

    def _prune_ledger_locked(self) -> None:
        """Keep active rows plus a bounded recent tombstone window.

        The persisted generation is the ABA high-water mark.  Tombstones are
        retained for recent diagnostics and normal cancellation reads, but an
        arbitrarily old id does not keep the JSON state growing forever.
        """

        active_ids = {case.id for case in self._cases.values()}
        for feedback_id, row in tuple(self._ledger.items()):
            if str(row.get("state", "")) == "active" and feedback_id not in active_ids:
                del self._ledger[feedback_id]
        inactive = [
            (feedback_id, row)
            for feedback_id, row in self._ledger.items()
            if feedback_id not in active_ids
        ]
        keep_inactive = max(0, min(MAX_LEDGER_TOMBSTONES, self.max_cases))
        if len(inactive) <= keep_inactive:
            return
        inactive.sort(
            key=lambda item: float(item[1].get("updated_at", 0.0) or 0.0),
            reverse=True,
        )
        for feedback_id, _row in inactive[keep_inactive:]:
            self._ledger.pop(feedback_id, None)

    def _prune_group_jobs_locked(self) -> None:
        if len(self._group_jobs) <= self.max_cases * 2:
            return
        ordered = sorted(
            self._group_jobs.items(),
            key=lambda item: float(item[1].get("updated_at", 0.0) or 0.0),
            reverse=True,
        )[: self.max_cases * 2]
        self._group_jobs = dict(ordered)

    @staticmethod
    def _group_key(identity_key: str, subject_id: str, routing_key: str | None) -> str:
        digest = _digest_text(
            f"{identity_key}\x00{subject_id}\x00{routing_key or '-'}"
        )[:32]
        return f"feedback-group-{digest}"

    def _persist_locked(self, *, now: float | None = None) -> None:
        timestamp = time.time() if now is None else float(now)
        self._trim_locked(timestamp)
        self._prune_ledger_locked()
        self._prune_group_jobs_locked()
        if len(self._jobs) > MAX_CASES:
            ordered = sorted(
                self._jobs.items(),
                key=lambda item: float(item[1].get("updated_at", 0.0) or 0.0),
                reverse=True,
            )[:MAX_CASES]
            self._jobs = dict(ordered)
        self._generation += 1
        payload = {
            "version": STATE_VERSION,
            "generation": self._generation,
            "cases": [asdict(item) for item in self.cases],
            "ledger": self._ledger,
            "jobs": self._jobs,
            "groups": self._group_jobs,
        }
        try:
            _atomic_write_json(self.state_path, payload)
        except OSError as exc:
            raise FeedbackLearningError("feedback learning storage unavailable") from exc

    def _rollback_state_locked(
        self,
        cases: dict[tuple[str, str, str], FeedbackCase],
        ledger: dict[str, dict[str, Any]],
        jobs: dict[str, dict[str, Any]],
        group_jobs: dict[str, dict[str, Any]],
        generation: int,
    ) -> None:
        self._cases = cases
        self._ledger = ledger
        self._jobs = jobs
        self._group_jobs = group_jobs
        self._generation = generation

    def record_vote(
        self,
        *,
        identity: FeedbackIdentity,
        message: CanonicalFeedbackMessage,
        value: str,
        now: float | None = None,
    ) -> FeedbackCase:
        if value not in FEEDBACK_VALUES:
            raise FeedbackLearningError("value must be like or dislike")
        timestamp = time.time() if now is None else float(now)
        if not math.isfinite(timestamp):
            raise FeedbackLearningError("invalid timestamp")
        feedback_id = feedback_id_for(identity, message.session_id, message.message_id)
        question = message.question[: self.max_case_chars]
        answer = message.answer[: self.max_case_chars]
        question_digest = message.question_digest or _digest_text(message.question)
        answer_digest = message.answer_digest or _digest_text(message.answer)
        subject = message.subject_id or message.avatar_id or DEFAULT_SUBJECT_ID
        evidence_hash = _evidence_hash(
            value=value,
            subject_id=subject,
            question_digest=question_digest,
            answer_digest=answer_digest,
            turn_id=message.turn_id,
            routing_key=message.routing_key,
            feedback_reason=message.feedback_reason,
        )
        key = (identity.key, message.session_id, message.message_id)
        with self._lock:
            previous = self._cases.get(key)
            if (
                previous is not None
                and previous.id == feedback_id
                and previous.value == value
                and previous.evidence_hash == evidence_hash
                and previous.subject_id == subject
                and previous.question_digest == question_digest
                and previous.answer_digest == answer_digest
                and previous.turn_id == message.turn_id
                and previous.routing_key == message.routing_key
                and previous.feedback_reason == message.feedback_reason
            ):
                return previous
            ledger_previous = self._ledger.get(feedback_id, {})
            revision = max(
                int(ledger_previous.get("revision", 0) or 0),
                previous.revision if previous is not None else 0,
                self._generation,
            ) + 1
            case = FeedbackCase(
                id=feedback_id,
                identity_key=identity.key,
                session_id=message.session_id,
                message_id=message.message_id,
                subject_id=subject,
                question=question,
                answer=answer,
                value=value,
                created_at=timestamp,
                revision=revision,
                pending_since=timestamp,
                processed_revision=None,
                evidence_hash=evidence_hash,
                question_digest=question_digest,
                answer_digest=answer_digest,
                turn_id=message.turn_id,
                routing_key=message.routing_key,
                answer_excerpt=(message.answer_excerpt or message.answer)[:MAX_EXCERPT_CHARS],
                feedback_reason=message.feedback_reason,
            )
            old_cases = dict(self._cases)
            old_ledger = {item: dict(value) for item, value in self._ledger.items()}
            old_jobs = {item: dict(value) for item, value in self._jobs.items()}
            old_group_jobs = {item: dict(value) for item, value in self._group_jobs.items()}
            old_generation = self._generation
            self._cases[key] = case
            self._ledger[feedback_id] = {
                "revision": revision,
                "state": "active",
                "identity_key": identity.key,
                "session_id": message.session_id,
                "message_id": message.message_id,
                "subject_id": subject,
                "routing_key": message.routing_key,
                "value": value,
                "evidence_hash": evidence_hash,
                "updated_at": timestamp,
            }
            try:
                self._persist_locked(now=timestamp)
            except Exception:
                self._rollback_state_locked(
                    old_cases,
                    old_ledger,
                    old_jobs,
                    old_group_jobs,
                    old_generation,
                )
                raise
            return case

    def cancel_vote(
        self,
        *,
        identity: FeedbackIdentity,
        session_id: str,
        message_id: str,
        now: float | None = None,
    ) -> FeedbackMutation:
        timestamp = time.time() if now is None else float(now)
        if not math.isfinite(timestamp):
            raise FeedbackLearningError("invalid timestamp")
        key = self._case_key(identity, session_id, message_id)
        feedback_id = feedback_id_for(identity, key[1], key[2])
        with self._lock:
            previous = self._cases.get(key)
            ledger_previous = self._ledger.get(feedback_id, {})
            if previous is None and not ledger_previous:
                return FeedbackMutation(feedback_id, 0, None, False, "cancelled")
            if previous is None and str(ledger_previous.get("state", "")) == "cancelled":
                # Repeated cancellation is idempotent and must not consume a
                # new generation or extend the tombstone indefinitely.
                return FeedbackMutation(
                    feedback_id,
                    int(ledger_previous.get("revision", 0) or 0),
                    None,
                    False,
                    "cancelled",
                )
            prior_revision = max(
                int(ledger_previous.get("revision", 0) or 0),
                previous.revision if previous is not None else 0,
                self._generation,
            )
            revision = prior_revision + 1
            old_cases = dict(self._cases)
            old_ledger = {item: dict(value) for item, value in self._ledger.items()}
            old_jobs = {item: dict(value) for item, value in self._jobs.items()}
            old_group_jobs = {item: dict(value) for item, value in self._group_jobs.items()}
            old_generation = self._generation
            if previous is not None:
                del self._cases[key]
            self._ledger[feedback_id] = {
                "revision": revision,
                "state": "cancelled",
                "identity_key": identity.key,
                "session_id": key[1],
                "message_id": key[2],
                "subject_id": previous.subject_id if previous is not None else ledger_previous.get("subject_id"),
                "routing_key": previous.routing_key if previous is not None else ledger_previous.get("routing_key"),
                "value": None,
                "evidence_hash": previous.evidence_hash if previous is not None else ledger_previous.get("evidence_hash", ""),
                "updated_at": timestamp,
            }
            try:
                self._persist_locked(now=timestamp)
            except Exception:
                self._rollback_state_locked(
                    old_cases,
                    old_ledger,
                    old_jobs,
                    old_group_jobs,
                    old_generation,
                )
                raise
            return FeedbackMutation(feedback_id, revision, None, previous is not None, "cancelled")

    def remove_vote(
        self,
        *,
        identity: FeedbackIdentity,
        session_id: str,
        message_id: str,
        now: float | None = None,
    ) -> bool:
        return self.cancel_vote(
            identity=identity,
            session_id=session_id,
            message_id=message_id,
            now=now,
        ).removed

    def session_cases(
        self,
        *,
        identity: FeedbackIdentity | None,
        session_id: str,
        subject_id: str | None = None,
        routing_key: str | None = None,
    ) -> tuple[FeedbackCase, ...]:
        """Return live votes for one exact session/subject only."""

        if identity is None:
            return ()
        sid = _bounded_identifier(session_id, "session_id")
        requested_subject = _bounded_text(
            subject_id or "", MAX_SUBJECT_CHARS, "subject_id", allow_empty=True
        ) or DEFAULT_SUBJECT_ID
        requested_route = _bounded_optional(routing_key, MAX_ID_CHARS, "routing_key")
        with self._lock:
            rows = [
                case
                for case in self._cases.values()
                if case.identity_key == identity.key
                and case.session_id == sid
                and (case.subject_id or DEFAULT_SUBJECT_ID) == requested_subject
                and (routing_key is None or case.routing_key == requested_route)
                and self._ledger.get(case.id, {}).get("state", "active") == "active"
            ]
        return tuple(sorted(rows, key=lambda item: (item.created_at, item.message_id)))

    def validate_evidence(
        self,
        refs: Iterable[FeedbackEvidenceRef],
        *,
        identity_key: str | None = None,
        subject_id: str | None = None,
    ) -> bool:
        """Validate every source against the current active revision.

        Missing, cancelled, evicted, changed, or digest-mismatched sources all
        fail closed.  This method is required for every experience recall, not
        only when a batch is published.
        """

        try:
            refs_tuple = tuple(refs)
        except TypeError:
            return False
        if not refs_tuple:
            return False
        requested_subject = subject_id or None
        with self._lock:
            for ref in refs_tuple:
                feedback_id = str(getattr(ref, "feedback_id", "") or "").strip()
                try:
                    revision = int(getattr(ref, "revision", 0) or 0)
                except (TypeError, ValueError, OverflowError):
                    return False
                evidence_hash = str(getattr(ref, "evidence_hash", "") or "").strip().lower()
                if not feedback_id or revision < 1 or not evidence_hash:
                    return False
                case = self._case_for_id_locked(feedback_id)
                ledger = self._ledger.get(feedback_id)
                if case is None or ledger is None:
                    return False
                if ledger.get("state") != "active":
                    return False
                try:
                    ledger_revision = int(ledger.get("revision", 0) or 0)
                except (TypeError, ValueError, OverflowError):
                    return False
                if (
                    case.revision != revision
                    or case.evidence_hash != evidence_hash
                    or ledger_revision != case.revision
                    or str(ledger.get("evidence_hash", "") or "").strip().lower()
                    != case.evidence_hash
                ):
                    return False
                if identity_key is not None and case.identity_key != identity_key:
                    return False
                if requested_subject is not None and (case.subject_id or DEFAULT_SUBJECT_ID) != requested_subject:
                    return False
        return True

    def _batch_current_locked(self, batch: FeedbackBatch) -> bool:
        if not batch.cases or len(batch.cases) != len(batch.snapshots):
            return False
        for case, ref in zip(batch.cases, batch.snapshots):
            current = self._case_for_id_locked(ref.feedback_id)
            if current is None or current.id != case.id:
                return False
            if current.identity_key != batch.identity_key:
                return False
            if (current.subject_id or DEFAULT_SUBJECT_ID) != batch.subject_id:
                return False
            if current.routing_key != batch.routing_key:
                return False
            if not current.is_pending or not self.validate_evidence((ref,)):
                return False
        return True

    def _batch_subset_current_locked(
        self,
        batch: FeedbackBatch,
        feedback_ids: Iterable[str],
    ) -> bool:
        """Validate only evidence actually sent to the model.

        A bounded distillation request may contain fewer cases than the
        selected scheduler batch.  Unsent cases remain pending and must not
        make an otherwise valid response stale merely because they changed
        while the request was in flight.
        """

        selected = {str(value).strip() for value in feedback_ids}
        if not selected or not selected.issubset(set(batch.source_feedback_ids)):
            return False
        refs = {
            ref.feedback_id: (case, ref)
            for case, ref in zip(batch.cases, batch.snapshots)
            if ref.feedback_id in selected
        }
        if len(refs) != len(selected):
            return False
        for case, ref in refs.values():
            current = self._case_for_id_locked(ref.feedback_id)
            if current is None or current.id != case.id:
                return False
            if current.identity_key != batch.identity_key:
                return False
            if (current.subject_id or DEFAULT_SUBJECT_ID) != batch.subject_id:
                return False
            if current.routing_key != batch.routing_key or not current.is_pending:
                return False
            if not self.validate_evidence((ref,)):
                return False
        return True

    def _batch_id(
        self,
        identity_key: str,
        subject_id: str,
        routing_key: str | None,
        cases: Sequence[FeedbackCase],
    ) -> str:
        source = "\x00".join(
            f"{case.id}@{case.revision}:{case.evidence_hash}" for case in cases
        )
        digest = _digest_text(f"{identity_key}\x00{subject_id}\x00{routing_key or '-'}\x00{source}")[:32]
        return f"feedback-batch-{digest}"

    def due_batches(
        self,
        identity: FeedbackIdentity | None,
        now: float | None = None,
        *,
        limit: int = 1,
        batch_limit: int = MAX_BATCH_CASES,
        min_pending: int = MIN_PENDING_CASES,
        max_age_seconds: float = PENDING_MAX_AGE_SECONDS,
        routing_key: str | None = None,
    ) -> tuple[FeedbackBatch, ...]:
        """Select groups due by distinct case ID count or pending age.

        This is read-only.  Call :meth:`claim_batch` before invoking a model;
        the claim/lease is persisted so two workers cannot process one group.
        """

        if identity is None:
            return ()
        timestamp = time.time() if now is None else float(now)
        if not math.isfinite(timestamp):
            return ()
        bounded_limit = max(0, min(int(limit), MAX_CASES))
        bounded_batch_limit = max(1, min(int(batch_limit), MAX_BATCH_CASES))
        min_required = max(1, int(min_pending))
        age_limit = max(0.0, float(max_age_seconds))
        requested_route = _bounded_optional(routing_key, MAX_ID_CHARS, "routing_key")
        if bounded_limit == 0:
            return ()
        with self._lock:
            if any(
                str(job.get("status", "")) == "running"
                and float(job.get("lease_until", 0.0) or 0.0) > timestamp
                for job in self._jobs.values()
            ):
                return ()
            groups: dict[tuple[str, str, str | None], list[FeedbackCase]] = {}
            for case in self._cases.values():
                if case.identity_key != identity.key or not case.is_pending:
                    continue
                if requested_route is not None and case.routing_key != requested_route:
                    continue
                if self._ledger.get(case.id, {}).get("state", "active") != "active":
                    continue
                group = (case.identity_key, case.subject_id or DEFAULT_SUBJECT_ID, case.routing_key)
                groups.setdefault(group, []).append(case)
            result: list[FeedbackBatch] = []
            for (_identity_key, subject_id, group_routing_key), rows in sorted(
                groups.items(),
                key=lambda item: min(
                    (case.pending_since or case.created_at for case in item[1]),
                    default=timestamp,
                ),
            ):
                rows.sort(key=lambda item: (item.pending_since or item.created_at, item.id))
                selected = tuple(rows[:bounded_batch_limit])
                if not selected:
                    continue
                oldest = min(item.pending_since or item.created_at for item in selected)
                count_due = len(rows) >= min_required
                age_due = timestamp - oldest >= age_limit
                if not count_due and not age_due:
                    continue
                batch_id = self._batch_id(identity.key, subject_id, group_routing_key, selected)
                job = self._jobs.get(batch_id, {})
                group_id = self._group_key(identity.key, subject_id, group_routing_key)
                group_job = self._group_jobs.get(group_id, {})
                status = str(job.get("status", ""))
                if status == "running" and float(job.get("lease_until", 0.0) or 0.0) > timestamp:
                    continue
                if status == "failed" and float(job.get("next_retry_at", 0.0) or 0.0) > timestamp:
                    continue
                if float(job.get("cooldown_until", 0.0) or 0.0) > timestamp:
                    continue
                group_status = str(group_job.get("status", ""))
                if group_status == "running" and float(group_job.get("lease_until", 0.0) or 0.0) > timestamp:
                    continue
                if float(group_job.get("next_retry_at", 0.0) or 0.0) > timestamp:
                    continue
                if float(group_job.get("cooldown_until", 0.0) or 0.0) > timestamp:
                    continue
                result.append(
                    FeedbackBatch(
                        id=batch_id,
                        identity_key=identity.key,
                        subject_id=subject_id,
                        routing_key=group_routing_key,
                        cases=selected,
                        snapshots=tuple(
                            FeedbackEvidenceRef(case.id, case.revision, case.evidence_hash)
                            for case in selected
                        ),
                        trigger="count" if count_due else "age",
                        oldest_pending_at=oldest,
                        created_at=timestamp,
                    )
                )
                if len(result) >= bounded_limit:
                    break
            return tuple(result)

    def claim_batch(
        self,
        *,
        identity: FeedbackIdentity | None,
        batch: FeedbackBatch,
        worker_id: str,
        now: float | None = None,
        lease_seconds: float = 900.0,
    ) -> bool:
        """Atomically claim one due batch for one background worker."""

        if identity is None or identity.key != batch.identity_key:
            return False
        worker = _bounded_identifier(worker_id, "worker_id")
        timestamp = time.time() if now is None else float(now)
        lease = max(1.0, float(lease_seconds))
        with self._lock:
            if not self._batch_current_locked(batch):
                return False
            existing = self._jobs.get(batch.id, {})
            group_id = self._group_key(batch.identity_key, batch.subject_id, batch.routing_key)
            existing_group = self._group_jobs.get(group_id, {})
            if (
                str(existing.get("status", "")) == "running"
                and float(existing.get("lease_until", 0.0) or 0.0) > timestamp
            ):
                return str(existing.get("worker_id", "")) == worker
            if float(existing.get("next_retry_at", 0.0) or 0.0) > timestamp:
                return False
            if float(existing.get("cooldown_until", 0.0) or 0.0) > timestamp:
                return False
            for job in self._jobs.values():
                if (
                    str(job.get("status", "")) == "running"
                    and float(job.get("lease_until", 0.0) or 0.0) > timestamp
                    and str(job.get("worker_id", "")) != worker
                ):
                    return False
            if (
                str(existing_group.get("status", "")) == "running"
                and float(existing_group.get("lease_until", 0.0) or 0.0) > timestamp
            ):
                return str(existing_group.get("worker_id", "")) == worker
            if float(existing_group.get("next_retry_at", 0.0) or 0.0) > timestamp:
                return False
            if float(existing_group.get("cooldown_until", 0.0) or 0.0) > timestamp:
                return False
            self._jobs[batch.id] = {
                "status": "running",
                "worker_id": worker,
                "lease_until": timestamp + lease,
                "attempts": int(existing.get("attempts", 0) or 0),
                "updated_at": timestamp,
            }
            self._group_jobs[group_id] = {
                "status": "running",
                "worker_id": worker,
                "lease_until": timestamp + lease,
                "attempts": int(existing_group.get("attempts", 0) or 0),
                "updated_at": timestamp,
            }
            try:
                self._persist_locked(now=timestamp)
            except Exception:
                self._jobs.pop(batch.id, None)
                if existing_group:
                    self._group_jobs[group_id] = existing_group
                else:
                    self._group_jobs.pop(group_id, None)
                raise
            return True

    def _retry_delay(self, attempts: int) -> float:
        exponent = max(0, min(int(attempts) - 1, 16))
        return min(MAX_RETRY_DELAY_SECONDS, DEFAULT_RETRY_BASE_SECONDS * (2**exponent))

    def _schedule_retry_locked(self, batch: FeedbackBatch, *, timestamp: float, reason: str) -> FeedbackBatchResult:
        existing = self._jobs.get(batch.id, {})
        group_id = self._group_key(batch.identity_key, batch.subject_id, batch.routing_key)
        existing_group = self._group_jobs.get(group_id, {})
        attempts = max(
            int(existing.get("attempts", 0) or 0),
            int(existing_group.get("attempts", 0) or 0),
        ) + 1
        next_retry = timestamp + self._retry_delay(attempts)
        self._jobs[batch.id] = {
            "status": "failed",
            "attempts": attempts,
            "next_retry_at": next_retry,
            "last_error": str(reason)[:512],
            "updated_at": timestamp,
        }
        self._group_jobs[group_id] = {
            "status": "failed",
            "attempts": attempts,
            "next_retry_at": next_retry,
            "last_error": str(reason)[:512],
            "updated_at": timestamp,
        }
        self._persist_locked(now=timestamp)
        return FeedbackBatchResult("retry", next_retry_at=next_retry, reason=str(reason)[:512])

    def fail_batch(
        self,
        *,
        identity: FeedbackIdentity | None,
        batch: FeedbackBatch,
        error: str,
        now: float | None = None,
    ) -> FeedbackBatchResult:
        """Record a model/provider failure without marking votes processed."""

        if identity is None or identity.key != batch.identity_key:
            return FeedbackBatchResult("stale", reason="identity_changed")
        timestamp = time.time() if now is None else float(now)
        with self._lock:
            if not self._batch_current_locked(batch):
                self._jobs[batch.id] = {"status": "stale", "updated_at": timestamp}
                group_id = self._group_key(batch.identity_key, batch.subject_id, batch.routing_key)
                group_job = self._group_jobs.get(group_id)
                if group_job is not None and str(group_job.get("status", "")) == "running":
                    self._group_jobs[group_id] = {"status": "idle", "updated_at": timestamp}
                self._persist_locked(now=timestamp)
                return FeedbackBatchResult("stale", reason="evidence_changed")
            return self._schedule_retry_locked(batch, timestamp=timestamp, reason=error)

    def finish_batch(
        self,
        *,
        identity: FeedbackIdentity | None,
        batch: FeedbackBatch,
        result: Any,
        experience_store: Any,
        now: float | None = None,
        worker_id: str | None = None,
        processed_feedback_ids: Iterable[str] | None = None,
    ) -> FeedbackBatchResult:
        """Validate a model result and publish it only for the live snapshot."""

        if identity is None or identity.key != batch.identity_key:
            return FeedbackBatchResult("stale", reason="identity_changed")
        timestamp = time.time() if now is None else float(now)
        with self._lock:
            job = self._jobs.get(batch.id, {})
            if worker_id is not None and str(job.get("worker_id", "")) not in {"", worker_id}:
                return FeedbackBatchResult("ignored", reason="batch_owned_by_other_worker")
            processed_ids = (
                tuple(batch.source_feedback_ids)
                if processed_feedback_ids is None
                else tuple(str(value).strip() for value in processed_feedback_ids)
            )
            if (
                not processed_ids
                or len(processed_ids) != len(set(processed_ids))
                or not self._batch_subset_current_locked(batch, processed_ids)
            ):
                self._jobs[batch.id] = {"status": "stale", "updated_at": timestamp}
                group_id = self._group_key(batch.identity_key, batch.subject_id, batch.routing_key)
                group_job = self._group_jobs.get(group_id)
                if group_job is not None and str(group_job.get("status", "")) == "running":
                    self._group_jobs[group_id] = {"status": "idle", "updated_at": timestamp}
                self._persist_locked(now=timestamp)
                return FeedbackBatchResult("stale", reason="evidence_changed")
            candidates = _result_experiences(result)
            if candidates is None:
                return self._schedule_retry_locked(batch, timestamp=timestamp, reason="invalid_distillation_result")
            allowed = set(processed_ids)
            for candidate in candidates:
                source_ids = _candidate_source_ids(candidate)
                if not source_ids or any(source_id not in allowed for source_id in source_ids):
                    return self._schedule_retry_locked(batch, timestamp=timestamp, reason="unknown_feedback_evidence")
            experience_ids: tuple[str, ...] = ()
            if candidates:
                if experience_store is None or not callable(getattr(experience_store, "publish_batch", None)):
                    return self._schedule_retry_locked(batch, timestamp=timestamp, reason="experience_store_unavailable")
                try:
                    published = experience_store.publish_batch(
                        identity_key=batch.identity_key,
                        subject_id=batch.subject_id,
                        routing_key=batch.routing_key,
                        candidates=candidates,
                        source_cases=tuple(
                            case for case in batch.cases if case.id in allowed
                        ),
                        source_refs=tuple(
                            ref for ref in batch.snapshots if ref.feedback_id in allowed
                        ),
                        now=timestamp,
                    )
                    experience_ids = tuple(
                        str(item.get("id") if isinstance(item, Mapping) else getattr(item, "id", ""))
                        for item in published
                    )
                except Exception as exc:
                    return self._schedule_retry_locked(batch, timestamp=timestamp, reason=str(exc))
            # A valid empty output is a successful no-op: clear this revision's
            # pending bit so an idle worker does not spin forever.
            old_cases = dict(self._cases)
            old_jobs = {item: dict(value) for item, value in self._jobs.items()}
            old_group_jobs = {item: dict(value) for item, value in self._group_jobs.items()}
            old_generation = self._generation
            for current_key, current in tuple(self._cases.items()):
                if current.id not in allowed:
                    continue
                self._cases[current_key] = replace(
                    current,
                    processed_revision=current.revision,
                    pending_since=0.0,
                )
            self._jobs[batch.id] = {
                "status": "done",
                "worker_id": job.get("worker_id"),
                "attempts": int(job.get("attempts", 0) or 0),
                "cooldown_until": timestamp + SUCCESS_COOLDOWN_SECONDS,
                "updated_at": timestamp,
                "done_at": timestamp,
            }
            group_id = self._group_key(batch.identity_key, batch.subject_id, batch.routing_key)
            self._group_jobs[group_id] = {
                "status": "done",
                "worker_id": job.get("worker_id"),
                "attempts": int(job.get("attempts", 0) or 0),
                "cooldown_until": timestamp + SUCCESS_COOLDOWN_SECONDS,
                "updated_at": timestamp,
                "done_at": timestamp,
            }
            try:
                self._persist_locked(now=timestamp)
            except Exception:
                self._cases = old_cases
                self._jobs = old_jobs
                self._group_jobs = old_group_jobs
                self._generation = old_generation
                raise
            return FeedbackBatchResult("committed", experience_ids=experience_ids)

    def recover_inflight(self, *, now: float | None = None) -> int:
        """Requeue expired leases; call this once during startup."""

        timestamp = time.time() if now is None else float(now)
        recovered = 0
        with self._lock:
            for job in self._jobs.values():
                if str(job.get("status", "")) != "running":
                    continue
                if float(job.get("lease_until", 0.0) or 0.0) > timestamp:
                    continue
                job.update(
                    {
                        "status": "failed",
                        "next_retry_at": timestamp,
                        "last_error": "worker lease expired",
                        "updated_at": timestamp,
                    }
                )
                batch_id = next(
                    (key for key, value in self._jobs.items() if value is job),
                    None,
                )
                if batch_id is not None:
                    for group_id, group_job in self._group_jobs.items():
                        if str(group_job.get("status", "")) == "running" and str(group_job.get("worker_id", "")) == str(job.get("worker_id", "")):
                            group_job.update(
                                {
                                    "status": "failed",
                                    "next_retry_at": timestamp,
                                    "last_error": "worker lease expired",
                                    "updated_at": timestamp,
                                }
                            )
                recovered += 1
            if recovered:
                self._persist_locked(now=timestamp)
        return recovered

    def cancel_worker(self, worker_id: str, *, now: float | None = None) -> int:
        """Requeue work owned by a shutting-down worker."""

        worker = _bounded_identifier(worker_id, "worker_id")
        timestamp = time.time() if now is None else float(now)
        cancelled = 0
        with self._lock:
            for job in self._jobs.values():
                if str(job.get("status", "")) != "running" or str(job.get("worker_id", "")) != worker:
                    continue
                job.update(
                    {
                        "status": "failed",
                        "next_retry_at": timestamp,
                        "last_error": "worker stopped",
                        "updated_at": timestamp,
                    }
                )
                for group_job in self._group_jobs.values():
                    if str(group_job.get("status", "")) == "running" and str(group_job.get("worker_id", "")) == worker:
                        group_job.update(
                            {
                                "status": "failed",
                                "next_retry_at": timestamp,
                                "last_error": "worker stopped",
                                "updated_at": timestamp,
                            }
                        )
                cancelled += 1
            if cancelled:
                self._persist_locked(now=timestamp)
        return cancelled

    def recall(
        self,
        *,
        identity: FeedbackIdentity | None,
        query: str,
        subject_id: str | None = None,
        limit: int = 3,
    ) -> tuple[FeedbackCase, ...]:
        """Deprecated raw recall; always empty to prevent cross-session leaks."""

        del identity, query, subject_id, limit
        return ()

    def recall_context(
        self,
        *,
        identity: FeedbackIdentity | None,
        query: str,
        subject_id: str | None = None,
        limit: int = 3,
        max_chars: int = MAX_CONTEXT_CHARS,
        experience_store: Any | None = None,
        routing_key: str | None = None,
    ) -> FeedbackLearningContext:
        """Delegate cross-session recall to an experience store only."""

        if experience_store is None or identity is None:
            return FeedbackLearningContext()
        try:
            context = experience_store.recall_context(
                identity=identity,
                query=query,
                subject_id=subject_id,
                routing_key=routing_key,
                evidence_validator=self.validate_evidence,
                limit=limit,
                max_chars=max_chars,
            )
        except Exception:
            return FeedbackLearningContext()
        return FeedbackLearningContext(
            cases=(),
            text=str(getattr(context, "text", "") or "")[:max_chars],
            experiences=tuple(getattr(context, "experiences", ()) or ()),
        )


def _result_experiences(result: Any) -> tuple[Any, ...] | None:
    if isinstance(result, Mapping):
        raw = result.get("experiences")
    else:
        raw = getattr(result, "experiences", None)
    if raw is None or isinstance(raw, (str, bytes, Mapping)):
        return None
    try:
        values = tuple(raw)
    except TypeError:
        return None
    return values if len(values) <= 8 else None


def _candidate_source_ids(candidate: Any) -> tuple[str, ...]:
    if isinstance(candidate, Mapping):
        raw = candidate.get("source_feedback_ids")
    else:
        raw = getattr(candidate, "source_feedback_ids", None)
    if not isinstance(raw, (list, tuple)):
        return ()
    values = tuple(str(item).strip() for item in raw)
    if not values or len(values) != len(set(values)):
        return ()
    return values


def format_feedback_learning_context(
    cases: Iterable[FeedbackCase] = (),
    *,
    experiences: Iterable[Any] = (),
    max_chars: int = MAX_CONTEXT_CHARS,
) -> str:
    """Format short experiences only; raw cases are intentionally ignored."""

    del cases
    limit = max(128, min(int(max_chars), MAX_CONTEXT_CHARS))
    rows = list(experiences)
    if not rows:
        return ""
    lines = ["历史反馈仅提供局部参考，不构成永久偏好："]
    for item in rows[:3]:
        applicability = str(getattr(item, "applicability", "") or "").strip()
        guidance = str(getattr(item, "guidance", "") or "").strip()
        confidence = getattr(item, "confidence", None)
        tentative = bool(getattr(item, "tentative", False))
        if not applicability or not guidance:
            continue
        label = "临时提示" if tentative else "经验"
        confidence_text = ""
        if isinstance(confidence, (int, float)) and math.isfinite(float(confidence)):
            confidence_text = f"；置信度{float(confidence):.2f}"
        lines.append(f"- {label}（适用：{applicability}）：{guidance}{confidence_text}")
    return "\n".join(lines)[:limit]


def _coerce_identity(raw: FeedbackIdentity | Mapping[str, Any] | None) -> FeedbackIdentity | None:
    if isinstance(raw, FeedbackIdentity):
        return raw
    if not isinstance(raw, Mapping):
        return None
    try:
        return FeedbackIdentity(
            scope_id=raw.get("scope_id") or raw.get("scopeId") or "",
            user_id=raw.get("user_id") or raw.get("userId") or "",
            tenant_id=raw.get("tenant_id") or raw.get("tenantId"),
        )
    except FeedbackLearningError:
        return None


def _coerce_message(raw: CanonicalFeedbackMessage | Mapping[str, Any] | None) -> CanonicalFeedbackMessage | None:
    if isinstance(raw, CanonicalFeedbackMessage):
        return raw
    if not isinstance(raw, Mapping):
        return None
    try:
        return CanonicalFeedbackMessage(
            session_id=str(raw.get("session_id") or raw.get("sessionId") or ""),
            message_id=str(raw.get("message_id") or raw.get("messageId") or ""),
            question=str(raw.get("question") or raw.get("user_question") or ""),
            answer=str(raw.get("answer") or raw.get("answer_excerpt") or ""),
            subject_id=(raw.get("subject_id") or raw.get("subjectId") or raw.get("subject")),
            avatar_id=(raw.get("avatar_id") or raw.get("avatarId")),
            question_digest=(raw.get("question_digest") or raw.get("questionDigest")),
            answer_digest=(raw.get("answer_digest") or raw.get("answerDigest")),
            turn_id=(raw.get("turn_id") or raw.get("turnId")),
            routing_key=(raw.get("routing_key") or raw.get("routingKey")),
            answer_excerpt=(raw.get("answer_excerpt") or raw.get("answerExcerpt")),
            feedback_reason=(raw.get("feedback_reason") or raw.get("feedbackReason")),
        )
    except FeedbackLearningError:
        return None


async def _maybe_await(value: Any) -> Any:
    return await value if inspect.isawaitable(value) else value


def register_feedback_learning_routes(
    app: FastAPI,
    *,
    check_token: Callable[[str | None], Any] | None,
    resolve_identity: IdentityResolver,
    resolve_local_message: CanonicalMessageResolver,
    store: FeedbackCaseStore | None = None,
) -> FeedbackCaseStore:
    """Attach the local projection route and return its store."""

    case_store = store or FeedbackCaseStore()

    @app.post("/api/session/feedback-learning")
    async def write_feedback_learning(
        request: Request,
        x_agx_desktop_token: str | None = Header(default=None),
    ) -> dict[str, Any]:
        if check_token is not None:
            token_result = await _maybe_await(check_token(x_agx_desktop_token))
            if token_result is False:
                raise HTTPException(status_code=401, detail="无效的 Studio 令牌")
        try:
            payload = await request.json()
        except Exception as exc:
            raise HTTPException(status_code=400, detail="反馈请求必须是 JSON") from exc
        if not isinstance(payload, Mapping):
            raise HTTPException(status_code=400, detail="反馈请求格式无效")
        try:
            session_id = _bounded_identifier(payload.get("session_id"), "session_id")
            message_id = _bounded_identifier(payload.get("message_id"), "message_id")
        except FeedbackLearningError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        value = payload.get("value")
        if value is not None and (not isinstance(value, str) or value not in FEEDBACK_VALUES):
            raise HTTPException(status_code=422, detail="value must be like, dislike, or null")
        try:
            expected_scope_raw = payload.get("expected_scope_id")
            if not isinstance(expected_scope_raw, str):
                raise FeedbackLearningError("invalid expected_scope_id")
            expected_scope_id = _bounded_scope(expected_scope_raw)
        except FeedbackLearningError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

        identity = _coerce_identity(await _maybe_await(resolve_identity(request)))
        if identity is None:
            raise HTTPException(status_code=403, detail="反馈学习需要已认证账号")
        if identity.scope_id != expected_scope_id:
            raise HTTPException(
                status_code=409,
                detail={"code": "identity_changed", "message": "企业账号已切换，请刷新后重试"},
            )
        if value is None:
            mutation = case_store.cancel_vote(
                identity=identity,
                session_id=session_id,
                message_id=message_id,
            )
            return {
                "ok": True,
                "removed": mutation.removed,
                "value": None,
                "revision": mutation.revision,
            }
        resolved = _coerce_message(await _maybe_await(resolve_local_message(session_id, message_id)))
        if resolved is None:
            raise HTTPException(status_code=409, detail="本地消息不存在，暂时无法记录反馈学习")
        if resolved.session_id != session_id or resolved.message_id != message_id:
            raise HTTPException(status_code=409, detail="本地消息身份不匹配，暂时无法记录反馈学习")
        case = case_store.record_vote(identity=identity, message=resolved, value=value)
        return {
            "ok": True,
            "case_id": case.id,
            "value": case.value,
            "revision": case.revision,
        }

    return case_store


__all__ = [
    "CanonicalFeedbackMessage",
    "CanonicalMessageResolver",
    "FeedbackBatch",
    "FeedbackBatchResult",
    "FeedbackCase",
    "FeedbackCaseStore",
    "FeedbackEvidenceRef",
    "FeedbackIdentity",
    "FeedbackLearningContext",
    "FeedbackLearningError",
    "FeedbackMutation",
    "DEFAULT_SUBJECT_ID",
    "FEEDBACK_VALUES",
    "MAX_CASES",
    "MAX_BATCH_CASES",
    "MAX_CONTEXT_CHARS",
    "PENDING_MAX_AGE_SECONDS",
    "SUCCESS_COOLDOWN_SECONDS",
    "feedback_id_for",
    "format_feedback_learning_context",
    "lexical_similarity",
    "register_feedback_learning_routes",
]
