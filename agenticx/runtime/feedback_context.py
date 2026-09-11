"""Ephemeral projection of scoped response feedback into model messages.

The feedback store owns the current vote.  This module only joins those live
cases to the messages that are about to be sent to a model.  It deliberately
does not know about a store, a session manager, or an LLM: callers pass the
already scoped cases and receive a fresh outbound copy.

The important distinction here is between *evidence* and *text*.  A case may
carry a stable message/turn identity, or a digest of the complete answer and
question.  A bounded answer prefix is not evidence of identity, so legacy
cases whose answer is exactly the storage cap are not content matched.
Likewise, duplicate question/answer pairs are left alone when no stable
identity disambiguates them.
"""

from __future__ import annotations

import copy
import hashlib
import re
from dataclasses import dataclass
from typing import Any, Iterable, Mapping, Sequence


DEFAULT_SUBJECT_ID = "meta"
FEEDBACK_VALUES = frozenset({"like", "dislike"})

# The current local case store bounds both fields at 4,000 characters.  A
# value at that boundary is ambiguous: it may be a complete 4,000 character
# answer or a truncated prefix.  Only an explicit full digest can validate it.
LEGACY_TEXT_CAP = 4_000
DEFAULT_MAX_ANNOTATION_CHARS = 64
DEFAULT_MAX_SUMMARY_CHARS = 240
DEFAULT_MAX_TOTAL_CHARS = 640
MAX_CASE_ID_CHARS = 512
# FeedbackIdentity.key combines three independently bounded fields and two
# NUL delimiters, so its maximum is larger than a normal message id.
MAX_IDENTITY_CHARS = 4_096
MAX_SESSION_ID_CHARS = 512
MAX_SUBJECT_CHARS = 256
MAX_DIGEST_CHARS = 64

FEEDBACK_LABELS = {
    "like": "[feedback: like]",
    "dislike": "[feedback: dislike]",
}
_SUMMARY_PREFIX = "[feedback excerpt"
_PROJECTION_KEY = "__agx_feedback_projection"
FEEDBACK_PROJECTION_KEY = _PROJECTION_KEY
_CONTROL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
_SPACE_RE = re.compile(r"\s+")
_SENTENCE_RE = re.compile(r"^(.+?(?:[。！？!?；;]|\.(?:\s|$)|!(?:\s|$)|\?(?:\s|$)))")
_HEX64_RE = re.compile(r"^[0-9a-fA-F]{64}$")


@dataclass(frozen=True)
class _CaseEvidence:
    """Normalized duck-typed feedback case used only during one projection."""

    case_id: str
    identity_key: str
    session_id: str
    subject_id: str
    message_id: str
    turn_id: str
    question: str
    answer: str
    question_digest: str
    answer_digest: str
    value: str
    revision: Any
    ordinal: int


@dataclass(frozen=True)
class _MessageView:
    index: int
    row: Mapping[str, Any]
    role: str
    text: str
    message_ids: frozenset[str]
    turn_ids: frozenset[str]
    question_before: str
    subject_id: str | None
    session_id: str | None


def answer_digest_for(answer: Any) -> str:
    """Return the canonical full-answer SHA-256 used by this projection.

    Batch workers should calculate ``answer_digest`` with this function (or
    the same ``str(answer).strip().encode('utf-8')`` rule) before persisting a
    case.  It intentionally hashes the complete text, never a storage prefix.
    """

    return hashlib.sha256(_full_text(answer).encode("utf-8")).hexdigest()


def question_digest_for(question: Any) -> str:
    """Return the canonical full-question SHA-256 used for content matching."""

    return hashlib.sha256(_full_text(question).encode("utf-8")).hexdigest()


def _full_text(value: Any) -> str:
    """Sanitize only NUL and outer whitespace for digest equality.

    The v2 store hashes its validated answer/question after the same NUL
    replacement and ``strip`` operation.  Internal spaces and line breaks are
    evidence, so collapsing them here would reject valid stored digests.
    """

    if not isinstance(value, str):
        return ""
    return value.replace("\x00", " ").strip()


def _canonical_text(value: Any) -> str:
    return _SPACE_RE.sub(" ", _CONTROL_RE.sub(" ", _full_text(value))).strip()


def _bounded(value: Any, limit: int) -> str:
    """Bound visible evidence without changing its equality semantics.

    Legacy cases may not carry a digest, so the value used for the exact
    fallback comparison must retain internal whitespace.  Formatting for a
    human-readable excerpt is handled separately by ``_canonical_text``.
    """

    text = _full_text(value)
    return text[:limit]


def _bounded_opaque(value: Any, limit: int) -> str:
    """Bound an opaque identity without rewriting delimiter/control bytes."""

    if not isinstance(value, str):
        return ""
    text = value.strip()
    return text if len(text) <= limit else ""


def _field(raw: Any, *names: str) -> Any:
    if isinstance(raw, Mapping):
        for name in names:
            if name in raw:
                return raw[name]
        return None
    for name in names:
        try:
            value = getattr(raw, name)
        except Exception:
            continue
        if value is not None:
            return value
    return None


def _revision_key(value: Any) -> tuple[int, Any]:
    """Sort numeric revisions above missing/non-numeric revisions safely."""

    if isinstance(value, bool):
        return (0, 0)
    try:
        if isinstance(value, (int, float)):
            return (2, float(value))
        text = str(value or "").strip()
        if text and re.fullmatch(r"[0-9]+", text):
            return (2, int(text))
    except (TypeError, ValueError):
        pass
    return (1, str(value or ""))


def _normalize_case(raw: Any, ordinal: int) -> _CaseEvidence | None:
    value = str(_field(raw, "value") or "").strip().lower()
    if value not in FEEDBACK_VALUES:
        return None
    # ``FeedbackIdentity.key`` intentionally uses NUL delimiters.  It is an
    # opaque equality boundary, so applying visible-text sanitization here
    # would make every trusted scoped case impossible to match.
    identity = _bounded_opaque(
        _field(raw, "identity_key", "identityKey", "scope_id", "scopeId"),
        MAX_IDENTITY_CHARS,
    )
    session = _bounded_opaque(
        _field(raw, "session_id", "sessionId", "source_session_id", "sourceSessionId"),
        MAX_SESSION_ID_CHARS,
    )
    raw_subject = _field(raw, "subject_id", "subjectId", "subject", "avatar_id", "avatarId")
    if raw_subject is None or (isinstance(raw_subject, str) and not raw_subject.strip()):
        subject = DEFAULT_SUBJECT_ID
    else:
        subject = _bounded_opaque(raw_subject, MAX_SUBJECT_CHARS)
        if not subject:
            # An explicitly supplied malformed/overlong subject must not
            # silently fall into the default ``meta`` subject.
            return None
    message_id = _bounded_opaque(_field(raw, "message_id", "messageId"), MAX_CASE_ID_CHARS)
    turn_id = _bounded_opaque(
        _field(raw, "turn_id", "turnId", "client_turn_id", "clientTurnId"),
        MAX_CASE_ID_CHARS,
    )
    question = _bounded(_field(raw, "question", "user_question", "userQuestion"), LEGACY_TEXT_CAP)
    answer = _bounded(_field(raw, "answer", "answer_excerpt", "answerExcerpt"), LEGACY_TEXT_CAP)
    question_digest = str(
        _field(raw, "question_digest", "questionDigest") or ""
    ).strip().lower()
    answer_digest = str(
        _field(raw, "answer_digest", "answerDigest") or ""
    ).strip().lower()
    # A malformed digest must never silently fall back to a bounded text.
    if question_digest and not _HEX64_RE.fullmatch(question_digest):
        return None
    if answer_digest and not _HEX64_RE.fullmatch(answer_digest):
        return None
    raw_case_id = _field(raw, "id", "case_id", "caseId", "feedback_id", "feedbackId")
    case_id = _bounded_opaque(raw_case_id, MAX_CASE_ID_CHARS)
    if not case_id:
        case_id = message_id or turn_id
    if not identity or not session or not case_id or not (message_id or turn_id):
        return None
    if not question or not answer:
        return None
    return _CaseEvidence(
        case_id=case_id,
        identity_key=identity,
        session_id=session,
        subject_id=subject,
        message_id=message_id,
        turn_id=turn_id,
        question=question,
        answer=answer,
        question_digest=question_digest,
        answer_digest=answer_digest,
        value=value,
        revision=_field(raw, "revision", "revision_id", "revisionId", "updated_at", "updatedAt"),
        ordinal=ordinal,
    )


def _dedupe_cases(cases: Iterable[Any]) -> tuple[_CaseEvidence, ...]:
    chosen: dict[tuple[str, str, str, str], _CaseEvidence] = {}
    for ordinal, raw in enumerate(cases):
        case = _normalize_case(raw, ordinal)
        if case is None:
            continue
        # A vote update normally keeps the same message id.  Include turn id
        # so malformed legacy rows with only a shared message id cannot cause
        # unrelated cases to overwrite one another.
        key = (case.identity_key, case.session_id, case.subject_id, case.message_id or case.turn_id)
        previous = chosen.get(key)
        if previous is None or (
            _revision_key(case.revision), case.ordinal
        ) >= (_revision_key(previous.revision), previous.ordinal):
            chosen[key] = case
    return tuple(chosen.values())


def _content_text(content: Any) -> str:
    if isinstance(content, str):
        return _full_text(content)
    if isinstance(content, Sequence) and not isinstance(content, (str, bytes, bytearray)):
        parts: list[str] = []
        for block in content:
            if not isinstance(block, Mapping):
                continue
            if str(block.get("type", "")).strip().lower() != "text":
                continue
            text = block.get("text")
            if isinstance(text, str) and text.strip():
                parts.append(text)
        return _full_text("\n".join(parts))
    return ""


def _metadata(row: Mapping[str, Any]) -> Mapping[str, Any]:
    raw = row.get("metadata")
    if isinstance(raw, Mapping):
        return raw
    return {}


def _row_values(row: Mapping[str, Any], metadata: Mapping[str, Any], *names: str) -> tuple[str, ...]:
    values: list[str] = []
    for source in (row, metadata):
        for name in names:
            value = source.get(name)
            if isinstance(value, str) and value.strip():
                normalized = value.strip()
                if normalized not in values:
                    values.append(normalized)
    return tuple(values)


def _subject_for_row(row: Mapping[str, Any], metadata: Mapping[str, Any]) -> str | None:
    values = _row_values(
        row,
        metadata,
        "subject_id",
        "subjectId",
        "subject",
        "avatar_id",
        "avatarId",
    )
    return values[0] if values else None


def _session_for_row(row: Mapping[str, Any], metadata: Mapping[str, Any]) -> str | None:
    values = _row_values(row, metadata, "session_id", "sessionId")
    return values[0] if values else None


def _ids_for_row(row: Mapping[str, Any], metadata: Mapping[str, Any]) -> frozenset[str]:
    return frozenset(
        _row_values(
            row,
            metadata,
            "id",
            "message_id",
            "messageId",
            "feedback_message_id",
            "feedbackMessageId",
        )
    )


def _turns_for_row(row: Mapping[str, Any], metadata: Mapping[str, Any]) -> frozenset[str]:
    return frozenset(
        _row_values(
            row,
            metadata,
            "turn_id",
            "turnId",
            "client_turn_id",
            "clientTurnId",
        )
    )


def _clear_projection_artifacts(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Remove only markers generated by this helper.

    Feedback-looking text can be legitimate answer content (for example a
    code sample that contains ``[feedback: like]``).  Therefore this routine
    never searches visible text for a magic substring.  Each generated
    annotation records its exact appended suffix/block in a private field;
    the runtime's provider-field scrubber removes that field before the model
    call.  A generated summary records its row kind, so a literal system row
    beginning with ``[feedback excerpt`` remains untouched.
    """

    result: list[dict[str, Any]] = []
    for row in messages:
        marker = row.get(_PROJECTION_KEY)
        marker_map = marker if isinstance(marker, Mapping) else {}
        kind = str(marker_map.get("kind", "")).strip()
        role = str(row.get("role", "")).strip().lower()
        if kind == "summary":
            # The whole row was appended by this helper.  Do not remove an
            # unmarked literal system message with the same visible prefix.
            continue
        if kind == "annotation" and role == "assistant":
            content = row.get("content")
            if isinstance(content, str):
                suffix = marker_map.get("suffix")
                if isinstance(suffix, str) and suffix and content.endswith(suffix):
                    row["content"] = content[: -len(suffix)]
            elif isinstance(content, (list, tuple)):
                block = marker_map.get("block")
                block_index = marker_map.get("block_index")
                original_is_tuple = isinstance(content, tuple)
                sequence = list(content)
                removed = False
                if isinstance(block_index, int) and 0 <= block_index < len(sequence):
                    if sequence[block_index] == block:
                        del sequence[block_index]
                        removed = True
                if not removed:
                    for index in range(len(sequence) - 1, -1, -1):
                        if sequence[index] == block:
                            del sequence[index]
                            break
                if sequence != list(content):
                    row["content"] = tuple(sequence) if original_is_tuple else sequence
        row.pop(_PROJECTION_KEY, None)
        result.append(row)
    return result


def _row_views(messages: Sequence[Mapping[str, Any]]) -> tuple[_MessageView, ...]:
    prior_question = ""
    prior_user_turn_ids: frozenset[str] = frozenset()
    views: list[_MessageView] = []
    for index, raw in enumerate(messages):
        if not isinstance(raw, Mapping):
            continue
        metadata = _metadata(raw)
        role = str(raw.get("role", "")).strip().lower()
        # Preserve literal feedback-looking text.  Only the private projection
        # marker is removed by ``_clear_projection_artifacts`` above.
        text = _content_text(raw.get("content"))
        row_turn_ids = _turns_for_row(raw, metadata)
        if role == "user":
            # Runtime history commonly stores ``client_turn_id`` on the user
            # row while the generated assistant row has no turn metadata.
            # Carry only the immediately preceding user's turn through tool
            # rows so a stable turn id can still identify its assistant.
            prior_user_turn_ids = row_turn_ids
            if text:
                prior_question = text
        turn_ids = row_turn_ids
        if role == "assistant" and prior_user_turn_ids:
            turn_ids = frozenset((*turn_ids, *prior_user_turn_ids))
        views.append(
            _MessageView(
                index=index,
                row=raw,
                role=role,
                text=text,
                message_ids=_ids_for_row(raw, metadata),
                turn_ids=turn_ids,
                question_before=prior_question if role == "assistant" else "",
                subject_id=_subject_for_row(raw, metadata),
                session_id=_session_for_row(raw, metadata),
            )
        )
    return tuple(views)


def _scope_matches(view: _MessageView, *, session_id: str, subject_id: str) -> bool:
    if view.session_id and view.session_id != session_id:
        return False
    if view.subject_id and view.subject_id != subject_id:
        return False
    return True


def _case_answer_digest(case: _CaseEvidence) -> str | None:
    if case.answer_digest:
        return case.answer_digest
    # A legacy value shorter than the known storage cap is a complete value.
    # At the cap, it could be a prefix and cannot be trusted.
    if len(case.answer) >= LEGACY_TEXT_CAP:
        return None
    return answer_digest_for(case.answer)


def _case_question_digest(case: _CaseEvidence) -> str | None:
    if case.question_digest:
        return case.question_digest
    if len(case.question) >= LEGACY_TEXT_CAP:
        return None
    return question_digest_for(case.question)


def _content_matches(case: _CaseEvidence, view: _MessageView) -> bool:
    answer_digest = _case_answer_digest(case)
    question_digest = _case_question_digest(case)
    if not answer_digest or not question_digest or not view.text or not view.question_before:
        return False
    return (
        answer_digest_for(view.text) == answer_digest
        and question_digest_for(view.question_before) == question_digest
    )


def _question_matches(case: _CaseEvidence, view: _MessageView) -> bool:
    digest = _case_question_digest(case)
    return bool(digest and view.question_before and question_digest_for(view.question_before) == digest)


def _stable_matches(case: _CaseEvidence, view: _MessageView) -> bool:
    if case.message_id and case.message_id in view.message_ids:
        return True
    return bool(case.turn_id and case.turn_id in view.turn_ids)


def _stable_candidates(case: _CaseEvidence, views: Sequence[_MessageView]) -> list[_MessageView]:
    return [
        view
        for view in views
        if view.role == "assistant"
        and _scope_matches(view, session_id=case.session_id, subject_id=case.subject_id)
        and _stable_matches(case, view)
    ]


def _select_stable_match(case: _CaseEvidence, views: Sequence[_MessageView]) -> _MessageView | None:
    candidates = _stable_candidates(case, views)
    if not candidates:
        return None
    with_text = [view for view in candidates if view.text]
    # A stable id normally identifies the source row, but a reused id or a
    # stale vote must not attach to a rewritten answer.  New cases can carry a
    # complete digest; validate it before allowing the id shortcut.  Legacy
    # cases have no such proof, so only a short, complete answer may be
    # compared exactly.  An answer at the storage cap may be a prefix and is
    # never accepted by the id path.
    if case.answer_digest:
        with_text = [
            view
            for view in with_text
            if answer_digest_for(view.text) == case.answer_digest
        ]
        if len(with_text) == 1:
            return with_text[0]
        # An explicit digest is authoritative.  In particular, do not fall
        # through to the legacy id-only return when the row was rewritten.
        return None
    if len(case.answer) >= LEGACY_TEXT_CAP:
        return None
    exact = [
        view
        for view in with_text
        if _full_text(view.text) == _full_text(case.answer)
    ]
    if len(exact) == 1:
        return exact[0]
    # A turn can contain an empty assistant tool-call row and one final text
    # row.  Empty rows cannot carry a visible feedback label, so they are
    # ignored when exactly one complete visible answer remains.  Two matching
    # rows are still ambiguous, and no visible row provides no identity proof.
    return None


def _content_candidates(case: _CaseEvidence, views: Sequence[_MessageView]) -> list[_MessageView]:
    return [
        view
        for view in views
        if view.role == "assistant"
        and view.text
        and _scope_matches(view, session_id=case.session_id, subject_id=case.subject_id)
        and _content_matches(case, view)
    ]


def _question_related_rows(case: _CaseEvidence, views: Sequence[_MessageView]) -> list[_MessageView]:
    """Return rows matching both the question and the voted answer.

    A same-question row with different answer text is a later response, not
    proof that the feedback source remains visible.  Keeping answer evidence
    in this helper prevents callers from accidentally reviving the old
    question-only inference.
    """

    answer_digest = _case_answer_digest(case)
    return [
        view
        for view in views
        if view.role == "assistant"
        and view.text
        and _scope_matches(view, session_id=case.session_id, subject_id=case.subject_id)
        and _question_matches(case, view)
        and answer_digest is not None
        and answer_digest_for(view.text) == answer_digest
    ]


def _answer_related_rows(case: _CaseEvidence, views: Sequence[_MessageView]) -> list[_MessageView]:
    """Return scoped visible assistant rows containing the voted answer.

    This is deliberately independent of the preceding question.  A question
    can be repeated with a different answer, while a stable answer digest is
    direct evidence that the original source is still visible somewhere in
    the outbound context.
    """

    digest = _case_answer_digest(case)
    if not digest:
        return []
    return [
        view
        for view in views
        if view.role == "assistant"
        and view.text
        and _scope_matches(view, session_id=case.session_id, subject_id=case.subject_id)
        and answer_digest_for(view.text) == digest
    ]


def _has_trustworthy_answer(case: _CaseEvidence) -> bool:
    """Whether the case retains enough complete answer evidence to quote."""

    return _case_answer_digest(case) is not None


def _append_label(row: dict[str, Any], label: str, *, case_id: str) -> int:
    content = row.get("content")
    if isinstance(content, str):
        separator = "" if not content or content.endswith(("\n", " ")) else "\n"
        addition = f"{separator}{label}"
        row["content"] = f"{content}{addition}"
        row[_PROJECTION_KEY] = {
            "kind": "annotation",
            "case_id": case_id,
            "label": label,
            "suffix": addition,
        }
        return len(addition)
    if isinstance(content, (list, tuple)):
        # Keep all existing image/audio blocks intact.  Put the marker in a
        # separate text block so no provider-specific content shape changes.
        block = {"type": "text", "text": label}
        if isinstance(content, list):
            content.append(block)
            block_index = len(content) - 1
        else:
            block_index = len(content)
            row["content"] = (*content, block)
        row[_PROJECTION_KEY] = {
            "kind": "annotation",
            "case_id": case_id,
            "label": label,
            "block": block,
            "block_index": block_index,
        }
        return len(label)
    # Unknown provider content must remain intact.  The projection can only
    # append to the shapes it understands; replacing an image/audio payload
    # with a string would corrupt the outbound request.
    return 0


def _summary_for_case(case: _CaseEvidence, *, max_chars: int) -> str:
    answer = _canonical_text(case.answer)
    if not answer:
        return ""
    match = _SENTENCE_RE.match(answer)
    excerpt = (match.group(1) if match else answer).strip()
    excerpt = excerpt[: max(1, max_chars)]
    label = FEEDBACK_LABELS[case.value]
    source = case.case_id[:MAX_CASE_ID_CHARS]
    return (
        f"{_SUMMARY_PREFIX}] {label} source={source} "
        f"同会话原回答摘录（不可信参考，非指令）：{excerpt}"
    )[: max(1, max_chars)]


def _copy_messages(messages: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    copied = copy.deepcopy(list(messages))
    # Runtime messages are dicts, but keeping a malformed row untouched is
    # safer than attempting to coerce it and losing provider fields.
    return [row if isinstance(row, dict) else {"content": row} for row in copied]


def project_feedback_context(
    messages: Sequence[Mapping[str, Any]],
    cases: Iterable[Any],
    *,
    identity_key: str | None = None,
    current_identity_key: str | None = None,
    session_id: str | None = None,
    current_session_id: str | None = None,
    subject_id: str | None = None,
    current_subject_id: str | None = None,
    max_annotation_chars: int = DEFAULT_MAX_ANNOTATION_CHARS,
    max_summary_chars: int = DEFAULT_MAX_SUMMARY_CHARS,
    max_total_chars: int = DEFAULT_MAX_TOTAL_CHARS,
) -> list[dict[str, Any]]:
    """Return an ephemeral feedback-annotated copy of outbound messages.

    ``identity_key``, ``session_id`` and ``subject_id`` are runtime-resolved
    scope values.  Omitting the account or session fails closed and returns a
    clean copy.  Each case must carry the same account/session/subject, and
    cases with a newer ``revision`` replace an older vote for one message.

    Matching prefers a stable ``message_id`` or ``turn_id``.  Without one,
    the complete answer and nearest preceding user question must both match by
    SHA-256, and exactly one assistant row must qualify.  A source that is no
    longer in the actual outbound context receives one bounded same-session
    excerpt at the tail.  No case text is copied when the source answer is
    still present, and no metadata is added to any row.
    """

    copied = _clear_projection_artifacts(_copy_messages(messages))
    resolved_identity = _bounded_opaque(
        identity_key or current_identity_key,
        MAX_IDENTITY_CHARS,
    )
    resolved_session = _bounded_opaque(
        session_id or current_session_id,
        MAX_SESSION_ID_CHARS,
    )
    raw_subject = subject_id or current_subject_id
    if raw_subject is None or (isinstance(raw_subject, str) and not raw_subject.strip()):
        resolved_subject = DEFAULT_SUBJECT_ID
    else:
        resolved_subject = _bounded_opaque(raw_subject, MAX_SUBJECT_CHARS)
    if not resolved_identity or not resolved_session:
        return copied
    normalized_cases = tuple(
        case
        for case in _dedupe_cases(cases)
        if case.identity_key == resolved_identity
        and case.session_id == resolved_session
        and case.subject_id == resolved_subject
    )
    if not normalized_cases:
        return copied

    views = _row_views(copied)
    max_annotation = max(1, int(max_annotation_chars))
    max_summary = max(1, int(max_summary_chars))
    total_budget = max(0, int(max_total_chars))
    used = 0
    summary_cases: list[_CaseEvidence] = []
    annotated_case_ids: set[str] = set()
    annotated_indexes: set[int] = set()

    for case in normalized_cases:
        stable = _select_stable_match(case, views)
        if stable is not None and stable.text:
            label = FEEDBACK_LABELS[case.value]
            if len(label) > max_annotation:
                continue
            if used + len(label) + 1 <= total_budget and stable.index not in annotated_indexes:
                used += _append_label(copied[stable.index], label, case_id=case.case_id)
                annotated_indexes.add(stable.index)
                annotated_case_ids.add(case.case_id)
            continue

        # Stable metadata is a hard boundary.  If it is present but points to
        # an empty, duplicated, or digest-mismatched row, content matching
        # another assistant in the same session would guess across turns.
        stable_rows = _stable_candidates(case, views)
        if stable_rows:
            # A stale stable id means the original row may have been rewritten
            # or compacted.  Use answer evidence to decide whether the old
            # source is still visible; a repeated question alone is not proof.
            if _answer_related_rows(case, views):
                continue
            if _has_trustworthy_answer(case):
                summary_cases.append(case)
            continue

        content_candidates = _content_candidates(case, views)
        if len(content_candidates) == 1:
            candidate = content_candidates[0]
            label = FEEDBACK_LABELS[case.value]
            if len(label) > max_annotation:
                continue
            if used + len(label) + 1 <= total_budget and candidate.index not in annotated_indexes:
                used += _append_label(copied[candidate.index], label, case_id=case.case_id)
                annotated_indexes.add(candidate.index)
                annotated_case_ids.add(case.case_id)
            continue

        # A visible matching answer proves that the source is in context even
        # when its preceding question is unavailable or has changed.  A
        # matching question with a different answer is not evidence of the
        # voted source and must still receive a bounded excerpt when the case
        # retains a trustworthy answer.
        if _answer_related_rows(case, views):
            continue
        if _has_trustworthy_answer(case) and case.case_id not in annotated_case_ids:
            summary_cases.append(case)

    for case in summary_cases:
        if used >= total_budget:
            break
        remaining = total_budget - used
        summary = _summary_for_case(case, max_chars=min(max_summary, remaining))
        if not summary:
            continue
        # A summary is one appended message and remains outside every existing
        # tool-call/result adjacency, preserving provider pairing invariants.
        copied.append(
            {
                "role": "system",
                "content": summary,
                _PROJECTION_KEY: {"kind": "summary", "case_id": case.case_id},
            }
        )
        used += len(summary)
    return copied


# Descriptive aliases keep the helper convenient for runtime call sites while
# retaining one implementation and one set of matching guarantees.
project_feedback_messages = project_feedback_context
project_feedback_projection = project_feedback_context


__all__ = [
    "DEFAULT_SUBJECT_ID",
    "DEFAULT_MAX_ANNOTATION_CHARS",
    "DEFAULT_MAX_SUMMARY_CHARS",
    "DEFAULT_MAX_TOTAL_CHARS",
    "FEEDBACK_LABELS",
    "FEEDBACK_PROJECTION_KEY",
    "answer_digest_for",
    "question_digest_for",
    "project_feedback_context",
    "project_feedback_messages",
    "project_feedback_projection",
]
