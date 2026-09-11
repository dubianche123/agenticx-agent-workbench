"""Small, stateful policy for human-like group-chat turns.

The group router owns *why* a member is relevant and this module owns only the
social-turn mechanics that are useful to keep in one place:

* candidate ordering is stable for a ``(group_id, turn_id)`` pair;
* a new turn gets a new deterministic shuffle seed, so tied candidates can
  take turns without relying on process randomness;
* only visible, non-skipped replies consume the room/member message budgets.

This module intentionally does not import :mod:`group_router`.  ``GroupReply``
is a router implementation detail and importing it here would make the
router/policy dependency graph circular.  ``record_reply`` consequently uses a
small duck-typed/``Mapping`` adapter and accepts any GroupReply-like object.
"""

from __future__ import annotations

import hashlib
import math
from collections.abc import Callable, Mapping, Sequence
from typing import Any, Protocol, TypeVar


class GroupReplyLike(Protocol):
    """The part of a group reply needed by :class:`SocialTurnPolicy`.

    The protocol is structural on purpose.  The concrete ``GroupReply`` lives
    in ``group_router.py`` and must not be imported by this low-level policy.
    Implementations may expose additional fields such as ``event_type`` or
    ``action``; those are inspected defensively at runtime.
    """

    agent_id: str
    content: str
    skipped: bool


CandidateT = TypeVar("CandidateT")
ScoreProvider = Mapping[Any, float] | Callable[[Any], float] | None


_PASS_ACTIONS = frozenset(
    {
        "pass",
        "skip",
        "skipped",
        "no_reply",
        "no-reply",
        "no response",
        "no_response",
        "decline",
    }
)
_NON_PUBLIC_EVENT_TYPES = frozenset(
    {
        "group_pass",
        "group_skip",
        "group_skipped",
        "group_progress",
        "group_token",
        "pass",
        "skip",
        "skipped",
    }
)
_PASS_TEXT = frozenset(
    {
        "__skip__",
        "__pass__",
        "(pass)",
        "[pass]",
        "pass",
        "skip",
        "skipped",
    }
)


def _value(obj: Any, name: str, default: Any = None) -> Any:
    """Read ``name`` from a mapping or object without assuming a concrete type."""

    if isinstance(obj, Mapping):
        return obj.get(name, default)
    return getattr(obj, name, default)


def _normalise_member_id(value: Any) -> str:
    return str(value or "").strip()


def _candidate_id(candidate: Any) -> str:
    """Return a stable member identifier for common candidate shapes.

    Routing normally passes strings.  Supporting mappings and light objects is
    useful in tests and lets callers sort registry records without first
    rebuilding a list of ids.  The final ``str`` fallback is deliberately
    conservative; callers that need cross-process stability should provide an
    ``id``/``agent_id`` field rather than relying on an object's repr.
    """

    if isinstance(candidate, str):
        return candidate.strip()
    if isinstance(candidate, Mapping):
        for key in ("agent_id", "avatar_id", "member_id", "id", "name"):
            value = _normalise_member_id(candidate.get(key))
            if value:
                return value
    else:
        for attr in ("agent_id", "avatar_id", "member_id", "id", "name"):
            value = _normalise_member_id(getattr(candidate, attr, None))
            if value:
                return value
    return str(candidate).strip()


def _coerce_score(value: Any) -> float:
    """Convert a caller-provided score into a sortable finite number."""

    try:
        score = float(value)
    except (TypeError, ValueError):
        return 0.0
    return score if math.isfinite(score) else 0.0


class SocialTurnPolicy:
    """Track social-turn ordering and visible-message budgets.

    ``turn_id`` and ``group_id`` are required seed material.  SHA-256 is used
    instead of Python's built-in ``hash`` because the latter is salted per
    process.  Consequently the same pair produces the same order across
    processes and restarts, while changing ``turn_id`` normally rotates tied
    candidates.

    The policy does not decide who *should* speak; callers provide candidates
    (and optional relevance scores) to :meth:`order_candidates`.  It does,
    however, enforce the hard room/member caps when visible replies are
    recorded.
    """

    MAX_PUBLIC_MESSAGES = 10
    MAX_MESSAGES_PER_MEMBER = 2
    DEFAULT_MAX_PUBLIC_MESSAGES = MAX_PUBLIC_MESSAGES
    DEFAULT_MAX_MESSAGES_PER_MEMBER = MAX_MESSAGES_PER_MEMBER

    def __init__(
        self,
        turn_id: str,
        group_id: str,
        max_public_messages: int = MAX_PUBLIC_MESSAGES,
        max_messages_per_member: int = MAX_MESSAGES_PER_MEMBER,
    ) -> None:
        self.turn_id = self._require_seed("turn_id", turn_id)
        self.group_id = self._require_seed("group_id", group_id)
        self.max_public_messages = self._require_limit(
            "max_public_messages", max_public_messages
        )
        self.max_messages_per_member = self._require_limit(
            "max_messages_per_member", max_messages_per_member
        )
        self._public_message_count = 0
        self._messages_by_member: dict[str, int] = {}
        self._visible_replies: list[Any] = []
        self._non_public_replies: list[Any] = []
        self._rejected_replies: list[Any] = []

    @staticmethod
    def _require_seed(name: str, value: Any) -> str:
        seed = str(value or "").strip()
        if not seed:
            raise ValueError(f"{name} must be a non-empty string")
        return seed

    @staticmethod
    def _require_limit(name: str, value: Any) -> int:
        # bool is an int subclass but is not a meaningful quota.
        if isinstance(value, bool) or not isinstance(value, int) or value < 1:
            raise ValueError(f"{name} must be a positive integer")
        return value

    @property
    def seed(self) -> str:
        """The canonical seed prefix used for deterministic candidate hashes."""

        return f"{self.group_id}:{self.turn_id}"

    def digest_for(self, candidate: Any) -> str:
        """Return the SHA-256 ordering digest for ``candidate``.

        The payload is intentionally human-readable and unambiguous for the
        common id shapes: ``group_id:turn_id:member_id``.
        """

        member_id = _candidate_id(candidate)
        payload = f"{self.seed}:{member_id}".encode("utf-8")
        return hashlib.sha256(payload).hexdigest()

    # Names useful to callers/tests that want to inspect the deterministic
    # primitive without depending on the implementation's private methods.
    sha256_for = digest_for
    ordering_digest = digest_for
    ordering_key = digest_for

    def _score_for(self, candidate: Any, scores: ScoreProvider) -> float:
        if scores is None:
            return 0.0
        if callable(scores):
            try:
                return _coerce_score(scores(candidate))
            except (TypeError, ValueError, KeyError):
                return 0.0
        member_id = _candidate_id(candidate)
        value: Any = scores.get(member_id, None)
        if value is None:
            try:
                value = scores.get(candidate, 0.0)
            except (TypeError, KeyError):
                value = 0.0
        return _coerce_score(value)

    def order_candidates(
        self,
        candidates: Sequence[CandidateT] | Any,
        scores: ScoreProvider = None,
    ) -> list[CandidateT]:
        """Order candidates by score, then deterministic SHA-256 tie-break.

        Relevance is intentionally a caller concern.  Candidates with a
        higher score come first; candidates with equal scores are ordered by
        ``sha256(group_id + turn_id + candidate_id)``.  The original object is
        returned, not just its id, and duplicate entries retain input order.
        """

        indexed = list(enumerate(candidates))
        indexed.sort(
            key=lambda item: (
                -self._score_for(item[1], scores),
                self.digest_for(item[1]),
                item[0],
            )
        )
        return [candidate for _, candidate in indexed]

    # Friendly aliases for integrations that describe this operation as a
    # ranking rather than ordering.
    rank_candidates = order_candidates
    ordered_candidates = order_candidates

    def select_candidates(
        self,
        candidates: Sequence[CandidateT] | Any,
        *,
        limit: int | None = None,
        scores: ScoreProvider = None,
    ) -> list[CandidateT]:
        """Return an ordered prefix, bounded by remaining room capacity.

        ``limit`` is optional and is never allowed to exceed the number of
        public messages still available in this turn.  This is a convenience
        for a router selecting potential speakers; recording remains the final
        source of truth for the per-member cap.
        """

        if limit is not None:
            if isinstance(limit, bool) or not isinstance(limit, int) or limit < 0:
                raise ValueError("limit must be a non-negative integer or None")
        room_limit = self.remaining_public_messages
        effective_limit = room_limit if limit is None else min(limit, room_limit)
        ordered = self.order_candidates(candidates, scores=scores)
        # Do not offer a member who has already used its per-member quota.  A
        # caller may still use ``order_candidates`` when it wants the raw
        # ranking and leave admission to ``record_reply``.
        eligible = [
            candidate
            for candidate in ordered
            if self.can_publish(self.member_id_for(candidate))
        ]
        return eligible[:effective_limit]

    def member_id_for(self, reply_or_member: Any) -> str:
        """Resolve the member id from a reply-like object or an id value."""

        if isinstance(reply_or_member, str):
            return reply_or_member.strip()
        for field in ("agent_id", "avatar_id", "member_id", "speaker_id"):
            value = _normalise_member_id(_value(reply_or_member, field, ""))
            if value:
                return value
        return _candidate_id(reply_or_member)

    @staticmethod
    def is_public_reply(reply: Any) -> bool:
        """Whether a GroupReply-like object is a visible room message.

        Progress/token events, explicit pass/skip actions, skipped replies and
        empty/sentinel bodies are private control flow and do not consume a
        public-message budget.
        """

        if reply is None:
            return False
        if bool(_value(reply, "skipped", False)):
            return False

        event_type = str(_value(reply, "event_type", "") or "").strip().lower()
        if event_type in _NON_PUBLIC_EVENT_TYPES:
            return False
        for field in ("action", "decision", "disposition", "status"):
            action = str(_value(reply, field, "") or "").strip().lower()
            if action in _PASS_ACTIONS:
                return False

        content = str(_value(reply, "content", "") or "").strip()
        if not content or content.lower() in _PASS_TEXT:
            return False
        return True

    # Alternate spelling useful for callers that use the noun "message".
    is_public_message = is_public_reply

    @property
    def public_message_count(self) -> int:
        return self._public_message_count

    @property
    def message_count(self) -> int:
        return self.public_message_count

    @property
    def total_public_messages(self) -> int:
        return self.public_message_count

    @property
    def remaining_public_messages(self) -> int:
        return max(0, self.max_public_messages - self._public_message_count)

    @property
    def remaining_capacity(self) -> int:
        return self.remaining_public_messages

    @property
    def messages_by_member(self) -> dict[str, int]:
        """A copy of visible-message counts keyed by member id."""

        return dict(self._messages_by_member)

    @property
    def member_message_counts(self) -> dict[str, int]:
        return self.messages_by_member

    @property
    def visible_replies(self) -> tuple[Any, ...]:
        return tuple(self._visible_replies)

    @property
    def public_replies(self) -> tuple[Any, ...]:
        return self.visible_replies

    @property
    def non_public_replies(self) -> tuple[Any, ...]:
        return tuple(self._non_public_replies)

    @property
    def rejected_replies(self) -> tuple[Any, ...]:
        return tuple(self._rejected_replies)

    def member_message_count(self, member_id: Any) -> int:
        return self._messages_by_member.get(_normalise_member_id(member_id), 0)

    count_for_member = member_message_count

    def remaining_messages_for(self, member_id: Any) -> int:
        member = _normalise_member_id(member_id)
        if not member:
            return 0
        return max(0, self.max_messages_per_member - self.member_message_count(member))

    def can_publish(self, member_id: Any) -> bool:
        """Whether ``member_id`` can publish another visible message."""

        member = _normalise_member_id(member_id)
        return (
            bool(member)
            and self.remaining_public_messages > 0
            and self.remaining_messages_for(member) > 0
        )

    can_send = can_publish
    should_publish = can_publish

    def allows(self, reply: Any) -> bool:
        """Check a reply before publishing it.

        Non-public pass/progress events are always allowed through the private
        stream; they simply do not consume quotas.  A visible reply is allowed
        only while both room and member budgets remain.
        """

        if not self.is_public_reply(reply):
            return True
        return self.can_publish(self.member_id_for(reply))

    should_allow = allows

    def record_reply(self, reply: GroupReplyLike | Any) -> bool:
        """Record a reply-like object and return whether it was published.

        ``False`` means either the object was a private/skipped/pass event or
        it was rejected because a quota was exhausted.  Private events are
        retained in ``non_public_replies`` for diagnostics, while rejected
        visible replies are retained separately and never affect counts.
        """

        if not self.is_public_reply(reply):
            self._non_public_replies.append(reply)
            return False

        member_id = self.member_id_for(reply)
        if not self.can_publish(member_id):
            self._rejected_replies.append(reply)
            return False

        self._public_message_count += 1
        self._messages_by_member[member_id] = self.member_message_count(member_id) + 1
        self._visible_replies.append(reply)
        return True

    record = record_reply
    record_message = record_reply
    record_public_reply = record_reply

    def record_pass(self, member_id: Any, *, reply: Any = None) -> bool:
        """Record a pass/non-public action without consuming a quota."""

        if reply is None:
            reply = {
                "agent_id": _normalise_member_id(member_id),
                "action": "pass",
                "skipped": True,
            }
        self._non_public_replies.append(reply)
        return False

    def reset(self) -> None:
        """Clear recorded events while retaining this turn's seed and limits."""

        self._public_message_count = 0
        self._messages_by_member.clear()
        self._visible_replies.clear()
        self._non_public_replies.clear()
        self._rejected_replies.clear()


__all__ = ["GroupReplyLike", "SocialTurnPolicy"]
