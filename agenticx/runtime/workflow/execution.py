"""Contracts shared by managed Workflow executors and Connector adapters.

The Workflow definition contains business intent only.  This module describes
the small, serializable boundary used by the service-owned executor when it
hands a claimed node to an Agent or a Connector implementation.  Adapter
implementations must remain outside the persisted graph: credentials, command
paths and live clients belong to the authenticated server session.
"""

from __future__ import annotations

import asyncio
import math
from dataclasses import dataclass, field
from typing import Any, Awaitable, Dict, Mapping, Optional, Protocol, Sequence


MAX_EXECUTOR_PROMPT_CHARS = 32 * 1024
MAX_EXECUTOR_OUTPUT_CHARS = 64 * 1024
MAX_EXECUTOR_EVIDENCE_ITEMS = 32
MAX_EXECUTOR_EVENTS = 48
MAX_EXECUTOR_EVENT_CHARS = 4 * 1024


def _bounded_text(value: Any, limit: int = MAX_EXECUTOR_OUTPUT_CHARS) -> str:
    text = str(value or "")
    if len(text) <= limit:
        return text
    return text[: max(0, limit - 32)] + "\n[… output truncated …]"


def _bounded_evidence_value(value: Any, *, depth: int = 0) -> Any:
    """Keep adapter evidence structured while bounding untrusted values."""

    if depth > 6:
        return "[… evidence depth truncated …]"
    if value is None or isinstance(value, bool):
        return value
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else "[… non-finite value …]"
    if isinstance(value, str):
        return _bounded_text(value, MAX_EXECUTOR_EVENT_CHARS)
    if isinstance(value, Mapping):
        result: Dict[str, Any] = {}
        for key, child in list(value.items())[:MAX_EXECUTOR_EVIDENCE_ITEMS]:
            result[_bounded_text(key, 256)] = _bounded_evidence_value(child, depth=depth + 1)
        return result
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return [_bounded_evidence_value(child, depth=depth + 1) for child in list(value)[:MAX_EXECUTOR_EVIDENCE_ITEMS]]
    return _bounded_text(value, MAX_EXECUTOR_EVENT_CHARS)


@dataclass(frozen=True)
class WorkflowNodeClaim:
    """A durable ownership lease for one executable node attempt."""

    run_id: str
    node_id: str
    attempt_id: str
    claim_owner: str
    fencing_token: int
    lease_expires_at: float
    claimed_at: float
    run_version: int

    # Wire aliases make the contract explicit for the Desktop and workers.
    @property
    def owner(self) -> str:
        return self.claim_owner

    def to_dict(self) -> Dict[str, Any]:
        return {
            "run_id": self.run_id,
            "node_id": self.node_id,
            "attempt_id": self.attempt_id,
            "claim_owner": self.claim_owner,
            "owner": self.claim_owner,
            "fencing_token": int(self.fencing_token),
            "lease_expires_at": float(self.lease_expires_at),
            "claimed_at": float(self.claimed_at),
            "run_version": int(self.run_version),
        }


@dataclass
class AdapterContext:
    """Trusted execution context passed to a connector adapter.

    ``inputs`` and ``upstream`` have already been resolved and bounded by the
    executor.  An adapter must treat them as data and pass arguments to its
    CLI/API using structured calls; it must never derive authority from these
    values.  ``session`` is the server-resolved managed Studio session.
    """

    run_id: str
    node_id: str
    attempt_id: str
    fencing_token: int
    session_id: str
    workflow_id: str
    workflow_revision: int
    workflow_digest: str
    owner_scope: str
    session: Any
    inputs: Mapping[str, Any]
    upstream: Mapping[str, Any]
    node_config: Mapping[str, Any]
    cancellation: asyncio.Event
    confirmation: Any = None


@dataclass(frozen=True)
class AdapterAvailability:
    """Actionable availability result for one exact connector/action ID."""

    available: bool
    reason: str = ""
    adapter_id: str = ""
    details: Mapping[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "available": bool(self.available),
            "reason": _bounded_text(self.reason, 2 * 1024),
            "adapter_id": self.adapter_id,
            "details": dict(self.details),
        }


@dataclass
class AdapterResult:
    """Bounded adapter result consumed by the managed runtime."""

    outcome: str = "done"  # done | failed | blocked | uncertain
    output: Any = ""
    evidence: Sequence[Any] = field(default_factory=tuple)
    artifacts: Sequence[Mapping[str, Any]] = field(default_factory=tuple)
    reason: str = ""
    side_effect_state: str = "none"  # none | applied | uncertain
    usage_metadata: Mapping[str, Any] = field(default_factory=dict)

    def normalized_outcome(self) -> str:
        value = str(self.outcome or "").strip().lower()
        if value in {"success", "succeeded", "complete", "completed", "ok"}:
            return "done"
        if value in {"error", "failure", "rejected"}:
            return "failed"
        if value in {"pause", "paused", "waiting"}:
            return "blocked"
        return value

    def to_bounded_dict(self) -> Dict[str, Any]:
        evidence = list(self.evidence or ())[:MAX_EXECUTOR_EVIDENCE_ITEMS]
        artifacts = [dict(item) for item in (self.artifacts or ()) if isinstance(item, Mapping)][:MAX_EXECUTOR_EVIDENCE_ITEMS]
        return {
            "outcome": self.normalized_outcome(),
            "output": _bounded_text(self.output),
            "evidence": [_bounded_evidence_value(item) for item in evidence],
            "artifacts": artifacts,
            "reason": _bounded_text(self.reason, 4 * 1024),
            "side_effect_state": str(self.side_effect_state or "none").strip().lower(),
            "usage_metadata": dict(self.usage_metadata or {}),
        }


class WorkflowExecutionAdapter(Protocol):
    """Protocol implemented by a real connector/action adapter.

    Adapter IDs must be stable and match the service catalog.  Implementations
    may expose either async or regular methods; the executor awaits an
    awaitable result and treats a missing availability method as unavailable.
    """

    adapter_id: str

    def availability(
        self,
        context: AdapterContext,
    ) -> AdapterAvailability | Awaitable[AdapterAvailability]:
        ...

    def execute(
        self,
        context: AdapterContext,
    ) -> AdapterResult | Mapping[str, Any] | Awaitable[AdapterResult | Mapping[str, Any]]:
        ...


class WorkflowExecutionBlocked(RuntimeError):
    """Adapter/runtime availability is missing and needs user action."""

    def __init__(self, reason: str, *, code: str = "execution_blocked", details: Optional[Mapping[str, Any]] = None) -> None:
        self.code = str(code or "execution_blocked")
        self.reason = _bounded_text(reason, 4 * 1024)
        self.details = dict(details or {})
        super().__init__(self.reason)


class WorkflowUncertainExternalEffect(RuntimeError):
    """An external write may have happened and must be reconciled manually."""

    def __init__(self, reason: str, *, details: Optional[Mapping[str, Any]] = None) -> None:
        self.reason = _bounded_text(reason, 4 * 1024)
        self.details = dict(details or {})
        super().__init__(self.reason)


def coerce_adapter_availability(value: Any, *, adapter_id: str = "") -> AdapterAvailability:
    if isinstance(value, AdapterAvailability):
        return value
    if isinstance(value, Mapping):
        return AdapterAvailability(
            available=bool(value.get("available", False)),
            reason=_bounded_text(value.get("reason", ""), 2 * 1024),
            adapter_id=str(value.get("adapter_id") or adapter_id),
            details=dict(value.get("details") or {}) if isinstance(value.get("details"), Mapping) else {},
        )
    return AdapterAvailability(False, "adapter returned no availability result", adapter_id=adapter_id)


def coerce_adapter_result(value: Any) -> AdapterResult:
    if isinstance(value, AdapterResult):
        return value
    if isinstance(value, Mapping):
        return AdapterResult(
            outcome=str(value.get("outcome") or value.get("status") or ""),
            output=value.get("output", value.get("output_summary", "")),
            evidence=value.get("evidence") if isinstance(value.get("evidence"), Sequence) and not isinstance(value.get("evidence"), (str, bytes)) else (),
            artifacts=value.get("artifacts") if isinstance(value.get("artifacts"), Sequence) and not isinstance(value.get("artifacts"), (str, bytes)) else (),
            reason=str(value.get("reason") or ""),
            side_effect_state=str(value.get("side_effect_state") or "none"),
            usage_metadata=value.get("usage_metadata") if isinstance(value.get("usage_metadata"), Mapping) else {},
        )
    return AdapterResult(output=value)


__all__ = [
    "AdapterAvailability",
    "AdapterContext",
    "AdapterResult",
    "MAX_EXECUTOR_EVIDENCE_ITEMS",
    "MAX_EXECUTOR_EVENTS",
    "MAX_EXECUTOR_EVENT_CHARS",
    "MAX_EXECUTOR_OUTPUT_CHARS",
    "MAX_EXECUTOR_PROMPT_CHARS",
    "WorkflowExecutionAdapter",
    "WorkflowExecutionBlocked",
    "WorkflowNodeClaim",
    "WorkflowUncertainExternalEffect",
    "coerce_adapter_availability",
    "coerce_adapter_result",
]
