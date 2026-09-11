"""Bounded, evidence-backed short experiences for feedback learning.

The store deliberately contains no question/answer fields.  A model may
publish a compact applicability/guidance pair, but the source ids and exact
revision/evidence hashes remain attached so every read can ask the case store
whether the source is still live.  This module is local persistence only; it
does not construct a model provider and never writes preference files.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import tempfile
import threading
import time
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any, Callable, Iterable, Literal, Mapping, Sequence

from agenticx.studio.feedback_learning import (
    DEFAULT_SUBJECT_ID,
    MAX_CASES,
    MAX_CONTEXT_CHARS,
    FeedbackCase,
    FeedbackEvidenceRef,
    FeedbackIdentity,
    FeedbackLearningError,
    lexical_similarity,
)
from agenticx.utils.agx_home import agx_home


EXPERIENCE_STATE_VERSION = 1
MAX_EXPERIENCES = MAX_CASES
MAX_EXPERIENCE_APPLICABILITY_CHARS = 240
MAX_EXPERIENCE_GUIDANCE_CHARS = 420
MAX_EXPERIENCE_KEYWORDS = 8
MAX_EXPERIENCE_KEYWORD_CHARS = 32
MAX_EXPERIENCE_CONTEXT_CHARS = MAX_CONTEXT_CHARS
MAX_EXPERIENCE_OUTPUT = 8
MIN_RECALL_LEXICAL_SIMILARITY = 0.2

# ``feedback_learning._tokens`` intentionally remains unchanged for existing
# callers.  Recall needs a small, stricter gate because a single shared CJK
# character can otherwise look like a useful match.  These local filters only
# decide whether an already-scored experience is eligible for this API.
_RECALL_CJK_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]")
_RECALL_ENGLISH_RE = re.compile(r"[A-Za-z][A-Za-z0-9_]*")
_RECALL_CJK_STOP_CHARS = frozenset(
    "请继续帮我你的了和与并列出说明比较分析如何什么这个一下"
)
_RECALL_ENGLISH_STOPWORDS = frozenset(
    {
        "a",
        "an",
        "and",
        "are",
        "as",
        "at",
        "be",
        "by",
        "for",
        "from",
        "how",
        "i",
        "in",
        "is",
        "it",
        "me",
        "my",
        "of",
        "on",
        "or",
        "please",
        "that",
        "the",
        "this",
        "to",
        "use",
        "with",
        "you",
    }
)


class FeedbackExperienceError(ValueError):
    """Raised when a candidate or source snapshot is unsafe to persist."""


@dataclass(frozen=True)
class FeedbackExperience:
    """One short reusable experience with immutable source evidence."""

    id: str
    identity_key: str
    subject_id: str
    routing_key: str | None
    applicability: str
    guidance: str
    keywords: tuple[str, ...]
    confidence: float
    source_feedback_ids: tuple[str, ...]
    source_revisions: tuple[int, ...]
    source_evidence: tuple[FeedbackEvidenceRef, ...]
    signal: Literal["like", "dislike", "mixed"]
    tentative: bool
    conflict_penalty: float
    created_at: float
    updated_at: float
    active: bool = True

    @property
    def sources(self) -> tuple[FeedbackEvidenceRef, ...]:
        """Alias used by evidence validators and integration callers."""

        return self.source_evidence

    @property
    def source_ids(self) -> tuple[str, ...]:
        return self.source_feedback_ids

    def as_context(self) -> dict[str, Any]:
        """Return only prompt-safe short text; source metadata stays backend-only."""

        return {
            "applicability": self.applicability,
            "guidance": self.guidance,
            "keywords": self.keywords,
            "confidence": self.confidence,
            "tentative": self.tentative,
        }


@dataclass(frozen=True)
class FeedbackExperienceContext:
    experiences: tuple[FeedbackExperience, ...] = ()
    text: str = ""

    @property
    def count(self) -> int:
        return len(self.experiences)


def _bounded_text(value: Any, limit: int, field: str) -> str:
    if not isinstance(value, str):
        raise FeedbackExperienceError(f"{field} must be a string")
    text = value.replace("\x00", " ").strip()
    if not text:
        raise FeedbackExperienceError(f"{field} is empty")
    if len(text) > limit:
        raise FeedbackExperienceError(f"{field} is too long")
    return text


def _bounded_optional_text(value: Any, limit: int, field: str) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise FeedbackExperienceError(f"{field} must be a string")
    text = value.replace("\x00", " ").strip()
    if len(text) > limit:
        raise FeedbackExperienceError(f"{field} is too long")
    return text or None


def _identity_key(identity: FeedbackIdentity | str | None) -> str | None:
    if isinstance(identity, FeedbackIdentity):
        return identity.key
    if isinstance(identity, str) and identity:
        return identity
    return None


def _subject(value: str | None) -> str:
    text = str(value or "").strip()
    return text or DEFAULT_SUBJECT_ID


def _normalise_keywords(raw: Any) -> tuple[str, ...]:
    if raw is None:
        return ()
    if isinstance(raw, (str, bytes, Mapping)) or not isinstance(raw, (list, tuple)):
        raise FeedbackExperienceError("keywords must be a list")
    if len(raw) > MAX_EXPERIENCE_KEYWORDS:
        raise FeedbackExperienceError("too many keywords")
    result: list[str] = []
    seen: set[str] = set()
    for item in raw:
        keyword = _bounded_text(item, MAX_EXPERIENCE_KEYWORD_CHARS, "keyword")
        key = keyword.casefold()
        if key in seen:
            continue
        seen.add(key)
        result.append(keyword)
    return tuple(result)


def _recall_cjk_chars(value: str) -> set[str]:
    return {
        char
        for char in _RECALL_CJK_RE.findall(value)
        if char not in _RECALL_CJK_STOP_CHARS
    }


def _recall_english_words(value: str) -> set[str]:
    return {
        word.casefold()
        for word in _RECALL_ENGLISH_RE.findall(value)
        if word.casefold() not in _RECALL_ENGLISH_STOPWORDS
    }


def _has_complete_cjk_keyword(query: str, keywords: Sequence[str]) -> bool:
    compact_query = "".join(_RECALL_CJK_RE.findall(query))
    if not compact_query:
        return False
    for keyword in keywords:
        if len(keyword) < 2 or not all(_RECALL_CJK_RE.fullmatch(char) for char in keyword):
            continue
        if keyword in compact_query:
            return True
    return False


def _recall_similarity(query: str, applicability: str, keywords: Sequence[str]) -> float:
    """Score an experience using only applicability and keywords.

    The lexical score remains the ranking signal, while the overlap gate
    prevents guidance prose or one accidental short CJK match from admitting
    an experience into the prompt context.
    """

    searchable = " ".join((applicability, *keywords))
    score = lexical_similarity(query, searchable)
    if score < MIN_RECALL_LEXICAL_SIMILARITY:
        return 0.0
    shared_cjk = _recall_cjk_chars(query) & _recall_cjk_chars(searchable)
    if len(shared_cjk) >= 2:
        return score
    if _has_complete_cjk_keyword(query, keywords):
        return score
    if _recall_english_words(query) & _recall_english_words(searchable):
        return score
    return 0.0


def _finite_confidence(value: Any) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise FeedbackExperienceError("confidence must be a number")
    confidence = float(value)
    if not math.isfinite(confidence) or confidence < 0.0 or confidence > 1.0:
        raise FeedbackExperienceError("confidence must be between 0 and 1")
    return confidence


def _digest(payload: Mapping[str, Any]) -> str:
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _atomic_write(path: Path, payload: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent))
    temporary = Path(temp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"))
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def _candidate_field(candidate: Any, name: str, default: Any = None) -> Any:
    if isinstance(candidate, Mapping):
        return candidate.get(name, default)
    return getattr(candidate, name, default)


def _source_ids(candidate: Any) -> tuple[str, ...]:
    raw = _candidate_field(candidate, "source_feedback_ids")
    if not isinstance(raw, (list, tuple)) or isinstance(raw, (str, bytes)) or not raw:
        raise FeedbackExperienceError("source_feedback_ids must be a non-empty list")
    values = tuple(str(item).strip() for item in raw)
    if any(not item for item in values) or len(values) != len(set(values)):
        raise FeedbackExperienceError("source_feedback_ids must be unique")
    return values


def _confidence_cap(cases: Sequence[FeedbackCase]) -> tuple[float, bool, float, str]:
    """Compute an evidence cap independent of model self-assessment."""

    if not cases:
        raise FeedbackExperienceError("experience needs source cases")
    values = {case.value for case in cases}
    sessions = len({case.session_id for case in cases})
    support = len(cases)
    if len(values) > 1:
        # A conflicting set can remain a useful local warning but can never
        # become a high-confidence general preference.
        return 0.45, True, 0.60, "mixed"
    if support <= 1:
        return 0.35, True, 0.0, next(iter(values))
    independent = max(1, sessions)
    cap = min(0.82, 0.35 + 0.14 * independent)
    return cap, independent < 2, 0.0, next(iter(values))


def _experience_from_row(raw: Mapping[str, Any]) -> FeedbackExperience | None:
    try:
        source_rows = raw.get("source_evidence", raw.get("sources", []))
        if not isinstance(source_rows, list):
            return None
        sources: list[FeedbackEvidenceRef] = []
        for source in source_rows:
            if not isinstance(source, Mapping):
                return None
            feedback_id = str(source.get("feedback_id", "")).strip()
            revision = int(source.get("revision", 0) or 0)
            evidence_hash = str(source.get("evidence_hash", "")).strip().lower()
            if (
                not feedback_id
                or revision < 1
                or len(evidence_hash) != 64
                or any(char not in "0123456789abcdef" for char in evidence_hash)
            ):
                return None
            sources.append(FeedbackEvidenceRef(feedback_id, revision, evidence_hash))
        source_ids = tuple(str(value).strip() for value in raw.get("source_feedback_ids", []))
        if source_ids != tuple(source.feedback_id for source in sources):
            return None
        source_revisions = tuple(int(value) for value in raw.get("source_revisions", []))
        if source_revisions != tuple(source.revision for source in sources):
            return None
        applicability = _bounded_text(
            raw.get("applicability", raw.get("application", "")),
            MAX_EXPERIENCE_APPLICABILITY_CHARS,
            "applicability",
        )
        guidance = _bounded_text(raw.get("guidance", ""), MAX_EXPERIENCE_GUIDANCE_CHARS, "guidance")
        keywords = _normalise_keywords(raw.get("keywords", []))
        confidence = _finite_confidence(raw.get("confidence"))
        signal = str(raw.get("signal", ""))
        if signal not in {"like", "dislike", "mixed"}:
            return None
        created_at = float(raw.get("created_at", 0.0) or 0.0)
        updated_at = float(raw.get("updated_at", 0.0) or 0.0)
        if not math.isfinite(created_at) or not math.isfinite(updated_at):
            return None
        return FeedbackExperience(
            id=str(raw.get("id", "")).strip(),
            identity_key=str(raw.get("identity_key", "")),
            subject_id=_subject(raw.get("subject_id")),
            routing_key=(str(raw["routing_key"]) if raw.get("routing_key") is not None else None),
            applicability=applicability,
            guidance=guidance,
            keywords=keywords,
            confidence=confidence,
            source_feedback_ids=source_ids,
            source_revisions=source_revisions,
            source_evidence=tuple(sources),
            signal=signal,  # type: ignore[arg-type]
            tentative=bool(raw.get("tentative", False)),
            conflict_penalty=_finite_confidence(raw.get("conflict_penalty", 0.0)),
            created_at=created_at,
            updated_at=updated_at,
            active=bool(raw.get("active", True)),
        )
    except (FeedbackExperienceError, TypeError, ValueError, OverflowError):
        return None


class FeedbackExperienceStore:
    """Atomic bounded experience persistence and live-evidence recall."""

    def __init__(self, root: str | Path | None = None, *, max_experiences: int = MAX_EXPERIENCES) -> None:
        self.root = Path(root).expanduser() if root is not None else agx_home() / "feedback-learning"
        self.root.mkdir(parents=True, exist_ok=True)
        self.path = self.root / "experiences.json"
        self.max_experiences = max(1, min(int(max_experiences), MAX_EXPERIENCES))
        self._lock = threading.RLock()
        self._experiences: dict[str, FeedbackExperience] = {}
        self._generation = 0
        self._load()

    @property
    def experiences(self) -> tuple[FeedbackExperience, ...]:
        with self._lock:
            return tuple(
                sorted(self._experiences.values(), key=lambda item: (item.updated_at, item.id), reverse=True)
            )

    def _load(self) -> None:
        if not self.path.exists():
            return
        try:
            payload = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, TypeError, ValueError, json.JSONDecodeError):
            return
        if not isinstance(payload, Mapping) or int(payload.get("version", 0) or 0) < EXPERIENCE_STATE_VERSION:
            return
        try:
            self._generation = max(0, int(payload.get("generation", 0) or 0))
        except (TypeError, ValueError):
            self._generation = 0
        rows = payload.get("experiences", [])
        if not isinstance(rows, list):
            return
        with self._lock:
            for row in rows:
                if not isinstance(row, Mapping):
                    continue
                experience = _experience_from_row(row)
                if experience is None or not experience.id or not experience.identity_key:
                    continue
                self._experiences[experience.id] = experience
            self._trim_locked()

    def _trim_locked(self) -> None:
        ordered = sorted(
            self._experiences.values(),
            key=lambda item: (item.updated_at, item.created_at, item.id),
            reverse=True,
        )[: self.max_experiences]
        self._experiences = {item.id: item for item in ordered}

    def _persist_locked(self) -> None:
        self._trim_locked()
        self._generation += 1
        payload = {
            "version": EXPERIENCE_STATE_VERSION,
            "generation": self._generation,
            "experiences": [
                {
                    "id": item.id,
                    "identity_key": item.identity_key,
                    "subject_id": item.subject_id,
                    "routing_key": item.routing_key,
                    "applicability": item.applicability,
                    "guidance": item.guidance,
                    "keywords": list(item.keywords),
                    "confidence": item.confidence,
                    "source_feedback_ids": list(item.source_feedback_ids),
                    "source_revisions": list(item.source_revisions),
                    "source_evidence": [
                        {
                            "feedback_id": source.feedback_id,
                            "revision": source.revision,
                            "evidence_hash": source.evidence_hash,
                        }
                        for source in item.source_evidence
                    ],
                    "signal": item.signal,
                    "tentative": item.tentative,
                    "conflict_penalty": item.conflict_penalty,
                    "created_at": item.created_at,
                    "updated_at": item.updated_at,
                    "active": item.active,
                }
                for item in self.experiences
            ],
        }
        try:
            _atomic_write(self.path, payload)
        except OSError as exc:
            raise FeedbackExperienceError("experience storage unavailable") from exc

    def publish_batch(
        self,
        *,
        identity_key: str,
        subject_id: str,
        routing_key: str | None,
        candidates: Iterable[Any],
        source_cases: Sequence[FeedbackCase],
        source_refs: Sequence[FeedbackEvidenceRef],
        now: float | None = None,
    ) -> tuple[FeedbackExperience, ...]:
        """Validate candidates and atomically upsert their live sources."""

        identity = str(identity_key or "").strip()
        if not identity:
            raise FeedbackExperienceError("identity_key is required")
        subject = _subject(subject_id)
        cases = tuple(source_cases)
        refs = tuple(source_refs)
        if not cases or len(cases) != len(refs):
            raise FeedbackExperienceError("source snapshot is invalid")
        case_by_id = {case.id: case for case in cases}
        ref_by_id = {ref.feedback_id: ref for ref in refs}
        if len(case_by_id) != len(cases) or len(ref_by_id) != len(refs):
            raise FeedbackExperienceError("source ids must be unique")
        for case, ref in zip(cases, refs):
            if (
                case.id != ref.feedback_id
                or case.revision != ref.revision
                or case.evidence_hash != ref.evidence_hash
                or case.identity_key != identity
                or _subject(case.subject_id) != subject
                or case.routing_key != routing_key
            ):
                raise FeedbackExperienceError("source snapshot does not match batch")
        raw_candidates = tuple(candidates)
        if len(raw_candidates) > MAX_EXPERIENCE_OUTPUT:
            raise FeedbackExperienceError("too many experiences")
        timestamp = time.time() if now is None else float(now)
        if not math.isfinite(timestamp):
            raise FeedbackExperienceError("invalid timestamp")
        published: list[FeedbackExperience] = []
        with self._lock:
            for candidate in raw_candidates:
                source_ids = _source_ids(candidate)
                if any(source_id not in case_by_id for source_id in source_ids):
                    raise FeedbackExperienceError("unknown source feedback id")
                selected_cases = tuple(case_by_id[source_id] for source_id in source_ids)
                selected_refs = tuple(ref_by_id[source_id] for source_id in source_ids)
                applicability = _bounded_text(
                    _candidate_field(candidate, "applicability", _candidate_field(candidate, "application")),
                    MAX_EXPERIENCE_APPLICABILITY_CHARS,
                    "applicability",
                )
                guidance = _bounded_text(
                    _candidate_field(candidate, "guidance"),
                    MAX_EXPERIENCE_GUIDANCE_CHARS,
                    "guidance",
                )
                keywords = _normalise_keywords(_candidate_field(candidate, "keywords", []))
                model_confidence = _finite_confidence(_candidate_field(candidate, "confidence"))
                cap, tentative, conflict_penalty, signal = _confidence_cap(selected_cases)
                confidence = min(model_confidence, cap)
                experience_payload = {
                    'identity_key': identity,
                    'subject_id': subject,
                    'routing_key': routing_key,
                    'applicability': applicability,
                    'guidance': guidance,
                    'keywords': keywords,
                    'source_evidence': [
                        (ref.feedback_id, ref.revision, ref.evidence_hash) for ref in selected_refs
                    ],
                }
                experience_id = f"feedback-experience-{_digest(experience_payload)[:32]}"
                previous = self._experiences.get(experience_id)
                experience = FeedbackExperience(
                    id=experience_id,
                    identity_key=identity,
                    subject_id=subject,
                    routing_key=routing_key,
                    applicability=applicability,
                    guidance=guidance,
                    keywords=keywords,
                    confidence=confidence,
                    source_feedback_ids=source_ids,
                    source_revisions=tuple(ref.revision for ref in selected_refs),
                    source_evidence=selected_refs,
                    signal=signal,  # type: ignore[arg-type]
                    tentative=tentative,
                    conflict_penalty=conflict_penalty,
                    created_at=previous.created_at if previous is not None else timestamp,
                    updated_at=timestamp,
                    active=True,
                )
                published.append(experience)
            previous_experiences = dict(self._experiences)
            previous_generation = self._generation
            try:
                for experience in published:
                    self._experiences[experience.id] = experience
                self._persist_locked()
            except Exception:
                self._experiences = previous_experiences
                self._generation = previous_generation
                raise
        return tuple(published)

    def invalidate_for_feedback(self, feedback_id: str) -> int:
        """Mark dependent rows inactive; recall still revalidates exact refs."""

        target = str(feedback_id or "").strip()
        if not target:
            return 0
        changed = 0
        with self._lock:
            for key, experience in tuple(self._experiences.items()):
                if target not in experience.source_feedback_ids or not experience.active:
                    continue
                self._experiences[key] = FeedbackExperience(
                    **{**experience.__dict__, "active": False, "updated_at": time.time()}
                )
                changed += 1
            if changed:
                self._persist_locked()
        return changed

    @staticmethod
    def _validator(
        validator: Callable[..., bool] | None,
        experience: FeedbackExperience,
        *,
        identity_key: str,
        subject_id: str,
    ) -> bool:
        if not callable(validator):
            return False
        try:
            return bool(
                validator(
                    experience.source_evidence,
                    identity_key=identity_key,
                    subject_id=subject_id,
                )
            )
        except TypeError:
            try:
                return bool(validator(experience.source_evidence))
            except Exception:
                return False
        except Exception:
            return False

    def recall(
        self,
        *,
        identity: FeedbackIdentity | str | None,
        query: str,
        subject_id: str | None = None,
        routing_key: str | None = None,
        evidence_validator: Callable[..., bool] | None = None,
        limit: int = 3,
    ) -> tuple[FeedbackExperience, ...]:
        """Recall only route-matched experiences with live source evidence."""

        identity_value = _identity_key(identity)
        if identity_value is None or not isinstance(query, str) or not query.strip():
            return ()
        # A verified route is mandatory.  ``None`` is intentionally not a
        # wildcard, because that would make a private experience public.
        if routing_key is None or not str(routing_key).strip():
            return ()
        requested_subject = _subject(subject_id)
        requested_route = str(routing_key).strip()
        bounded_limit = max(0, min(int(limit), 3))
        if bounded_limit == 0:
            return ()
        query_text = query.strip()[:4000]
        # Copy first, then validate outside the experience lock.  The case
        # store validator takes its own lock, while publication takes the
        # opposite CaseLock -> ExperienceLock order.
        with self._lock:
            candidates = [
                item
                for item in self._experiences.values()
                if item.active
                and item.identity_key == identity_value
                and item.subject_id == requested_subject
                and item.routing_key == requested_route
            ]
        candidates = [
            item
            for item in candidates
            if self._validator(
                evidence_validator,
                item,
                identity_key=identity_value,
                subject_id=requested_subject,
            )
        ]
        scored: list[tuple[float, FeedbackExperience]] = []
        for item in candidates:
            score = _recall_similarity(query_text, item.applicability, item.keywords)
            if score <= 0.0:
                continue
            scored.append((score * item.confidence * (1.0 - item.conflict_penalty), item))
        # Contradictory nearby experiences are both downweighted at read time.
        adjusted: list[tuple[float, FeedbackExperience]] = []
        for score, item in scored:
            contradiction = any(
                other.id != item.id
                and other.signal != item.signal
                and other.signal != "mixed"
                and item.signal != "mixed"
                and lexical_similarity(
                    " ".join((item.applicability, *item.keywords)),
                    " ".join((other.applicability, *other.keywords)),
                )
                >= 0.2
                for _other_score, other in scored
            )
            if contradiction:
                # Reweighting only the rank would still expose the model's
                # self-reported confidence to the next prompt.  Return an
                # immutable, visibly tentative projection as well.
                item = replace(
                    item,
                    confidence=min(item.confidence, 0.45),
                    tentative=True,
                    conflict_penalty=max(item.conflict_penalty, 0.5),
                )
            adjusted.append((score * (0.5 if contradiction else 1.0), item))
        adjusted.sort(key=lambda pair: (pair[0], pair[1].updated_at, pair[1].id), reverse=True)
        return tuple(item for _score, item in adjusted[:bounded_limit])

    def recall_context(
        self,
        *,
        identity: FeedbackIdentity | str | None,
        query: str,
        subject_id: str | None = None,
        routing_key: str | None = None,
        evidence_validator: Callable[..., bool] | None = None,
        limit: int = 3,
        max_chars: int = MAX_EXPERIENCE_CONTEXT_CHARS,
    ) -> FeedbackExperienceContext:
        experiences = self.recall(
            identity=identity,
            query=query,
            subject_id=subject_id,
            routing_key=routing_key,
            evidence_validator=evidence_validator,
            limit=limit,
        )
        bound = max(0, min(int(max_chars), MAX_EXPERIENCE_CONTEXT_CHARS))
        if bound == 0:
            return FeedbackExperienceContext()
        if not experiences:
            return FeedbackExperienceContext()
        lines = ["历史反馈经验仅作局部参考，不构成永久偏好："]
        for item in experiences[:3]:
            label = "临时提示" if item.tentative else "经验"
            confidence = f"；置信度{item.confidence:.2f}"
            line = f"- {label}（适用：{item.applicability}）：{item.guidance}{confidence}"
            candidate = "\n".join(lines + [line])
            if len(candidate) > bound:
                break
            lines.append(line)
        return FeedbackExperienceContext(experiences=experiences[: len(lines) - 1], text="\n".join(lines)[:bound])


__all__ = [
    "FeedbackExperience",
    "FeedbackExperienceContext",
    "FeedbackExperienceError",
    "FeedbackExperienceStore",
    "MAX_EXPERIENCE_APPLICABILITY_CHARS",
    "MAX_EXPERIENCE_CONTEXT_CHARS",
    "MAX_EXPERIENCE_GUIDANCE_CHARS",
    "MAX_EXPERIENCE_KEYWORDS",
    "MAX_EXPERIENCE_KEYWORD_CHARS",
    "MAX_EXPERIENCES",
]
