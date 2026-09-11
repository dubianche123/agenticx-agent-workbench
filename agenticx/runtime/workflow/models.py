"""Immutable, JSON-safe data models for versioned Workflow definitions.

The high-level Workflow model deliberately has a smaller vocabulary than the
existing graph runtime.  It describes business intent and dependencies; the
runtime compiler is responsible for translating a validated snapshot into
``GraphRun`` nodes later.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple, TypeAlias, Union


# Keep all limits in this module so the parser, validator and store share one
# conservative budget.  They are deliberately modest because a Workflow is an
# editable business document, not an arbitrary data container.
MAX_NODES = 200
MAX_EDGES = 600
MAX_ACCEPTANCE_CRITERIA = 200
MAX_CONFIG_BYTES = 64 * 1024
MAX_PAYLOAD_BYTES = 2 * 1024 * 1024
MAX_CONFIG_DEPTH = 12
MAX_STRING_LENGTH = 8 * 1024
MAX_ID_LENGTH = 128
MAX_LABEL_LENGTH = 512
MAX_ROUTE_LENGTH = 256
MAX_TIMESTAMP_LENGTH = 128

# Descriptive aliases used by callers that prefer the domain name in a
# constant.  Keep the short names above as the canonical definitions.
MAX_WORKFLOW_NODES = MAX_NODES
MAX_WORKFLOW_EDGES = MAX_EDGES
MAX_WORKFLOW_PAYLOAD_BYTES = MAX_PAYLOAD_BYTES
MAX_NODE_CONFIG_BYTES = MAX_CONFIG_BYTES


JSONValue: TypeAlias = Union[
    None,
    bool,
    int,
    float,
    str,
    List["JSONValue"],
    Dict[str, "JSONValue"],
]


_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$")
_WORKFLOW_ID_RE = re.compile(r"^wf_[A-Za-z0-9_-]{1,80}$")
_DIGEST_RE = re.compile(r"^[0-9a-f]{64}$")


class WorkflowModelError(ValueError):
    """Raised when a JSON model cannot be parsed safely.

    ``code`` and ``path`` make errors useful to callers that parse a draft
    outside the graph validator.  Graph validation uses its own structured
    exception because it can report multiple issues at once.
    """

    def __init__(self, message: str, *, code: str = "invalid_workflow", path: str = "") -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.path = path

    def to_dict(self) -> Dict[str, str]:
        return {"code": self.code, "message": self.message, "path": self.path}


class WorkflowNodeKind(str, Enum):
    """The only definition-level node kinds supported by the MVP."""

    TRIGGER = "trigger"
    AGENT_TASK = "agent_task"
    CONNECTOR_ACTION = "connector_action"
    DECISION = "decision"
    APPROVAL_GATE = "approval_gate"
    REVIEW = "review"
    JOIN = "join"
    END = "end"


def _path_join(path: str, part: str) -> str:
    return f"{path}.{part}" if path else part


def _require_mapping(raw: Any, *, path: str) -> Dict[str, Any]:
    if not isinstance(raw, dict):
        raise WorkflowModelError(
            f"expected an object at {path or '<root>'}",
            code="unexpected_container",
            path=path,
        )
    # JSON object keys are strings.  Rejecting non-string keys also prevents a
    # caller from smuggling values that serialize differently across runtimes.
    for key in raw:
        if not isinstance(key, str):
            raise WorkflowModelError(
                f"object key must be a string at {path or '<root>'}",
                code="invalid_object_key",
                path=path,
            )
    return dict(raw)


def _string(
    value: Any,
    *,
    path: str,
    required: bool = True,
    max_length: int = MAX_STRING_LENGTH,
    strip: bool = True,
) -> str:
    if not isinstance(value, str):
        if not required and value is None:
            return ""
        raise WorkflowModelError(
            f"expected a string at {path}", code="invalid_string", path=path
        )
    result = value.strip() if strip else value
    if required and not result:
        raise WorkflowModelError(
            f"string must not be empty at {path}", code="empty_string", path=path
        )
    if len(result) > max_length:
        raise WorkflowModelError(
            f"string exceeds {max_length} characters at {path}",
            code="string_too_large",
            path=path,
        )
    return result


def validate_identifier(value: Any, *, path: str = "id") -> str:
    result = _string(value, path=path, max_length=MAX_ID_LENGTH)
    if not _ID_RE.fullmatch(result):
        raise WorkflowModelError(
            f"invalid identifier at {path}", code="invalid_identifier", path=path
        )
    return result


def validate_workflow_id(value: Any, *, path: str = "workflow_id") -> str:
    result = _string(value, path=path, max_length=MAX_ID_LENGTH)
    if not _WORKFLOW_ID_RE.fullmatch(result):
        raise WorkflowModelError(
            f"invalid workflow identifier at {path}",
            code="invalid_workflow_id",
            path=path,
        )
    return result


def validate_revision(value: Any, *, path: str = "revision") -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise WorkflowModelError(
            f"revision must be an integer at {path}", code="invalid_revision", path=path
        )
    if value < 1:
        raise WorkflowModelError(
            f"revision must be positive at {path}", code="invalid_revision", path=path
        )
    return int(value)


def _json_value(value: Any, *, path: str, depth: int = 0) -> JSONValue:
    """Validate and copy one JSON-compatible value.

    Tuples, sets and arbitrary Mapping implementations are intentionally not
    accepted at the wire boundary.  This keeps canonical JSON identical for
    all clients and makes the payload limits enforceable before persistence.
    """

    if depth > MAX_CONFIG_DEPTH:
        raise WorkflowModelError(
            f"JSON nesting exceeds {MAX_CONFIG_DEPTH} levels at {path}",
            code="config_too_deep",
            path=path,
        )
    if value is None or isinstance(value, (bool, str, int, float)):
        if isinstance(value, float) and not math.isfinite(value):
            raise WorkflowModelError(
                f"non-finite number at {path}", code="non_finite_number", path=path
            )
        if isinstance(value, str) and len(value) > MAX_STRING_LENGTH:
            raise WorkflowModelError(
                f"string exceeds {MAX_STRING_LENGTH} characters at {path}",
                code="string_too_large",
                path=path,
            )
        return value
    if isinstance(value, list):
        return [
            _json_value(item, path=f"{path}[{index}]", depth=depth + 1)
            for index, item in enumerate(value)
        ]
    if isinstance(value, dict):
        result: Dict[str, JSONValue] = {}
        for key, item in value.items():
            if not isinstance(key, str):
                raise WorkflowModelError(
                    f"object key must be a string at {path}",
                    code="invalid_object_key",
                    path=path,
                )
            if len(key) > MAX_STRING_LENGTH:
                raise WorkflowModelError(
                    f"object key exceeds {MAX_STRING_LENGTH} characters at {path}",
                    code="string_too_large",
                    path=path,
                )
            result[key] = _json_value(item, path=_path_join(path, key), depth=depth + 1)
        return result
    raise WorkflowModelError(
        f"value is not JSON-compatible at {path}",
        code="invalid_json_value",
        path=path,
    )


def _canonical_json(payload: Any) -> str:
    try:
        return json.dumps(
            payload,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        )
    except RecursionError as exc:
        raise WorkflowModelError(
            f"JSON nesting exceeds {MAX_CONFIG_DEPTH} levels",
            code="config_too_deep",
            path="",
        ) from exc
    except (TypeError, ValueError) as exc:
        raise WorkflowModelError(
            f"value cannot be canonically serialized: {exc}",
            code="invalid_json_value",
            path="",
        ) from exc


def canonical_digest(payload: Any) -> str:
    """Return the SHA-256 digest of a canonical JSON payload."""

    encoded = _canonical_json(payload).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def canonical_payload_size(payload: Any) -> int:
    return len(_canonical_json(payload).encode("utf-8"))


def _finite_position_coordinate(value: Any, *, path: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise WorkflowModelError(
            f"position coordinate must be numeric at {path}",
            code="invalid_position",
            path=path,
        )
    try:
        result = float(value)
    except (OverflowError, ValueError) as exc:
        raise WorkflowModelError(
            f"position coordinate must be finite at {path}",
            code="non_finite_position",
            path=path,
        ) from exc
    if not math.isfinite(result):
        raise WorkflowModelError(
            f"position coordinate must be finite at {path}",
            code="non_finite_position",
            path=path,
        )
    return result


@dataclass(frozen=True)
class WorkflowPosition:
    x: float
    y: float

    def __post_init__(self) -> None:
        _finite_position_coordinate(self.x, path="position.x")
        _finite_position_coordinate(self.y, path="position.y")

    def to_dict(self) -> Dict[str, float]:
        return {"x": float(self.x), "y": float(self.y)}

    @classmethod
    def from_dict(cls, raw: Any, *, path: str = "position") -> "WorkflowPosition":
        data = _require_mapping(raw, path=path)
        if "x" not in data or "y" not in data:
            raise WorkflowModelError(
                f"position requires x and y at {path}",
                code="invalid_position",
                path=path,
            )
        x = _finite_position_coordinate(data["x"], path=f"{path}.x")
        y = _finite_position_coordinate(data["y"], path=f"{path}.y")
        return cls(x, y)


@dataclass(frozen=True)
class WorkflowNode:
    id: str
    kind: WorkflowNodeKind
    label: str
    objective: str = ""
    deliverable: str = ""
    acceptance_criteria: Tuple[str, ...] = ()
    required: bool = True
    position: WorkflowPosition = field(default_factory=lambda: WorkflowPosition(0, 0))
    config: Mapping[str, JSONValue] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        # A fresh recursive copy prevents callers from mutating the object
        # retained by an immutable snapshot through a nested config value.
        config = _json_value(dict(self.config), path="config")
        return {
            "id": self.id,
            "kind": self.kind.value,
            "label": self.label,
            "objective": self.objective,
            "deliverable": self.deliverable,
            "acceptance_criteria": list(self.acceptance_criteria),
            "required": bool(self.required),
            "position": self.position.to_dict(),
            "config": config,
        }

    @classmethod
    def from_dict(cls, raw: Any, *, path: str = "nodes[0]") -> "WorkflowNode":
        data = _require_mapping(raw, path=path)
        node_id = validate_identifier(data.get("id"), path=f"{path}.id")
        kind_value = data.get("kind")
        try:
            kind = kind_value if isinstance(kind_value, WorkflowNodeKind) else WorkflowNodeKind(str(kind_value))
        except (TypeError, ValueError) as exc:
            raise WorkflowModelError(
                f"unknown workflow node kind at {path}.kind",
                code="invalid_node_kind",
                path=f"{path}.kind",
            ) from exc
        label = _string(data.get("label"), path=f"{path}.label", max_length=MAX_LABEL_LENGTH)
        objective = _string(
            data.get("objective", ""), path=f"{path}.objective", required=False
        )
        deliverable = _string(
            data.get("deliverable", ""), path=f"{path}.deliverable", required=False
        )
        criteria_raw = data.get("acceptance_criteria", [])
        if not isinstance(criteria_raw, list):
            raise WorkflowModelError(
                f"acceptance_criteria must be an array at {path}.acceptance_criteria",
                code="unexpected_container",
                path=f"{path}.acceptance_criteria",
            )
        if len(criteria_raw) > MAX_ACCEPTANCE_CRITERIA:
            raise WorkflowModelError(
                f"too many acceptance criteria at {path}.acceptance_criteria",
                code="too_many_acceptance_criteria",
                path=f"{path}.acceptance_criteria",
            )
        criteria = tuple(
            _string(
                value,
                path=f"{path}.acceptance_criteria[{index}]",
                max_length=MAX_STRING_LENGTH,
            )
            for index, value in enumerate(criteria_raw)
        )
        required = data.get("required", True)
        if not isinstance(required, bool):
            raise WorkflowModelError(
                f"required must be a boolean at {path}.required",
                code="invalid_boolean",
                path=f"{path}.required",
            )
        position = WorkflowPosition.from_dict(
            data.get("position", {"x": 0, "y": 0}), path=f"{path}.position"
        )
        config_raw = data.get("config", {})
        if not isinstance(config_raw, dict):
            raise WorkflowModelError(
                f"config must be an object at {path}.config",
                code="unexpected_container",
                path=f"{path}.config",
            )
        # Preserve the total-config budget's precedence over leaf limits, but
        # turn a deeply nested sizing failure into the same bounded-depth
        # model error instead of leaking RecursionError.
        try:
            raw_config_size = len(
                json.dumps(
                    config_raw,
                    ensure_ascii=False,
                    sort_keys=True,
                    separators=(",", ":"),
                    # Sizing must not mask the more precise non-finite-number
                    # issue reported by the leaf validators below.
                    allow_nan=True,
                ).encode("utf-8")
            )
        except RecursionError as exc:
            raise WorkflowModelError(
                f"JSON nesting exceeds {MAX_CONFIG_DEPTH} levels at {path}.config",
                code="config_too_deep",
                path=f"{path}.config",
            ) from exc
        except (TypeError, ValueError) as exc:
            raise WorkflowModelError(
                f"config is not JSON-compatible: {exc}",
                code="invalid_json_value",
                path=f"{path}.config",
            ) from exc
        if raw_config_size > MAX_CONFIG_BYTES:
            raise WorkflowModelError(
                f"node config exceeds {MAX_CONFIG_BYTES} bytes at {path}.config",
                code="config_too_large",
                path=f"{path}.config",
            )
        try:
            config = _json_value(config_raw, path=f"{path}.config")
        except RecursionError as exc:
            raise WorkflowModelError(
                f"JSON nesting exceeds {MAX_CONFIG_DEPTH} levels at {path}.config",
                code="config_too_deep",
                path=f"{path}.config",
            ) from exc
        assert isinstance(config, dict)
        if canonical_payload_size(config) > MAX_CONFIG_BYTES:
            raise WorkflowModelError(
                f"node config exceeds {MAX_CONFIG_BYTES} bytes at {path}.config",
                code="config_too_large",
                path=f"{path}.config",
            )
        return cls(
            id=node_id,
            kind=kind,
            label=label,
            objective=objective,
            deliverable=deliverable,
            acceptance_criteria=criteria,
            required=required,
            position=position,
            config=config,
        )


@dataclass(frozen=True)
class WorkflowEdge:
    id: str
    source: str
    target: str
    route: str = ""
    label: str = ""

    def to_dict(self) -> Dict[str, str]:
        return {
            "id": self.id,
            "source": self.source,
            "target": self.target,
            "route": self.route,
            "label": self.label,
        }

    @classmethod
    def from_dict(cls, raw: Any, *, path: str = "edges[0]") -> "WorkflowEdge":
        data = _require_mapping(raw, path=path)
        return cls(
            id=validate_identifier(data.get("id"), path=f"{path}.id"),
            source=validate_identifier(data.get("source"), path=f"{path}.source"),
            target=validate_identifier(data.get("target"), path=f"{path}.target"),
            route=_string(
                data.get("route", ""),
                path=f"{path}.route",
                required=False,
                max_length=MAX_ROUTE_LENGTH,
            ),
            label=_string(
                data.get("label", ""),
                path=f"{path}.label",
                required=False,
                max_length=MAX_LABEL_LENGTH,
            ),
        )


@dataclass(frozen=True)
class WorkflowSnapshot:
    workflow_id: str
    revision: int
    title: str
    description: str
    objective: str
    completion_criteria: Tuple[str, ...]
    nodes: Tuple[WorkflowNode, ...]
    edges: Tuple[WorkflowEdge, ...]
    digest: str
    created_at: str

    def semantic_dict(self) -> Dict[str, Any]:
        """Return the exact digest input, excluding digest and created_at."""

        return {
            "workflow_id": self.workflow_id,
            "revision": int(self.revision),
            "title": self.title,
            "description": self.description,
            "objective": self.objective,
            "completion_criteria": list(self.completion_criteria),
            "nodes": [node.to_dict() for node in self.nodes],
            "edges": [edge.to_dict() for edge in self.edges],
        }

    def calculated_digest(self) -> str:
        return canonical_digest(self.semantic_dict())

    def canonical_json(self) -> str:
        return _canonical_json(self.semantic_dict())

    def to_dict(self) -> Dict[str, Any]:
        return {
            **self.semantic_dict(),
            "digest": self.digest,
            "created_at": self.created_at,
        }

    def with_digest(self) -> "WorkflowSnapshot":
        return WorkflowSnapshot(
            workflow_id=self.workflow_id,
            revision=self.revision,
            title=self.title,
            description=self.description,
            objective=self.objective,
            completion_criteria=tuple(self.completion_criteria),
            nodes=tuple(self.nodes),
            edges=tuple(self.edges),
            digest=self.calculated_digest(),
            created_at=self.created_at,
        )

    @classmethod
    def from_dict(cls, raw: Any, *, path: str = "") -> "WorkflowSnapshot":
        data = _require_mapping(raw, path=path)
        # Check the incoming object before normalization so a giant request
        # cannot evade the total budget by relying on omitted defaults.
        try:
            incoming_size = len(
                json.dumps(
                    data,
                    ensure_ascii=False,
                    sort_keys=True,
                    separators=(",", ":"),
                    allow_nan=True,
                ).encode("utf-8")
            )
        except RecursionError as exc:
            raise WorkflowModelError(
                f"JSON nesting exceeds {MAX_CONFIG_DEPTH} levels",
                code="config_too_deep",
                path=path,
            ) from exc
        except (TypeError, ValueError) as exc:
            raise WorkflowModelError(
                f"workflow payload is not JSON-compatible: {exc}",
                code="invalid_json_value",
                path=path,
            ) from exc
        if incoming_size > MAX_PAYLOAD_BYTES:
            raise WorkflowModelError(
                f"workflow payload exceeds {MAX_PAYLOAD_BYTES} bytes",
                code="payload_too_large",
                path=path,
            )
        workflow_id = _string(
            data.get("workflow_id", ""),
            path=_path_join(path, "workflow_id"),
            required=False,
            max_length=MAX_ID_LENGTH,
        )
        revision_value = data.get("revision", 1)
        revision = validate_revision(revision_value, path=_path_join(path, "revision"))
        title = _string(
            data.get("title", ""),
            path=_path_join(path, "title"),
            max_length=MAX_LABEL_LENGTH,
        )
        description = _string(
            data.get("description", ""),
            path=_path_join(path, "description"),
            required=False,
        )
        objective = _string(
            data.get("objective", ""),
            path=_path_join(path, "objective"),
            required=False,
        )
        criteria_raw = data.get("completion_criteria", [])
        if not isinstance(criteria_raw, list):
            raise WorkflowModelError(
                "completion_criteria must be an array",
                code="unexpected_container",
                path=_path_join(path, "completion_criteria"),
            )
        if len(criteria_raw) > MAX_ACCEPTANCE_CRITERIA:
            raise WorkflowModelError(
                f"too many completion criteria (maximum {MAX_ACCEPTANCE_CRITERIA})",
                code="too_many_acceptance_criteria",
                path=_path_join(path, "completion_criteria"),
            )
        completion_criteria = tuple(
            _string(
                value,
                path=f"{_path_join(path, 'completion_criteria')}[{index}]",
            )
            for index, value in enumerate(criteria_raw)
        )
        nodes_raw = data.get("nodes", [])
        edges_raw = data.get("edges", [])
        if not isinstance(nodes_raw, list):
            raise WorkflowModelError(
                "nodes must be an array",
                code="unexpected_container",
                path=_path_join(path, "nodes"),
            )
        if not isinstance(edges_raw, list):
            raise WorkflowModelError(
                "edges must be an array",
                code="unexpected_container",
                path=_path_join(path, "edges"),
            )
        if len(nodes_raw) > MAX_NODES:
            raise WorkflowModelError(
                f"too many workflow nodes (maximum {MAX_NODES})",
                code="too_many_nodes",
                path=_path_join(path, "nodes"),
            )
        if len(edges_raw) > MAX_EDGES:
            raise WorkflowModelError(
                f"too many workflow edges (maximum {MAX_EDGES})",
                code="too_many_edges",
                path=_path_join(path, "edges"),
            )
        nodes = tuple(
            WorkflowNode.from_dict(node, path=f"{_path_join(path, 'nodes')}[{index}]")
            for index, node in enumerate(nodes_raw)
        )
        edges = tuple(
            WorkflowEdge.from_dict(edge, path=f"{_path_join(path, 'edges')}[{index}]")
            for index, edge in enumerate(edges_raw)
        )
        digest = _string(
            data.get("digest", ""),
            path=_path_join(path, "digest"),
            required=False,
            max_length=64,
            strip=False,
        )
        if digest and not _DIGEST_RE.fullmatch(digest):
            raise WorkflowModelError(
                "digest must be a lowercase SHA-256 hex string",
                code="invalid_digest",
                path=_path_join(path, "digest"),
            )
        created_at = _string(
            data.get("created_at", ""),
            path=_path_join(path, "created_at"),
            required=False,
            max_length=MAX_TIMESTAMP_LENGTH,
            strip=False,
        )
        return cls(
            workflow_id=workflow_id,
            revision=revision,
            title=title,
            description=description,
            objective=objective,
            completion_criteria=completion_criteria,
            nodes=nodes,
            edges=edges,
            digest=digest,
            created_at=created_at,
        )


@dataclass
class WorkflowManifest:
    workflow_id: str
    owner_scope: str
    title: str
    head_revision: int
    published_revisions: List[int]
    active_published_revision: Optional[int]
    created_at: str
    updated_at: str

    def to_dict(self) -> Dict[str, Any]:
        return {
            "workflow_id": self.workflow_id,
            "owner_scope": self.owner_scope,
            "title": self.title,
            "head_revision": int(self.head_revision),
            "published_revisions": [int(value) for value in self.published_revisions],
            "active_published_revision": (
                int(self.active_published_revision)
                if self.active_published_revision is not None
                else None
            ),
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }

    @classmethod
    def from_dict(cls, raw: Any, *, path: str = "manifest") -> "WorkflowManifest":
        data = _require_mapping(raw, path=path)
        workflow_id = validate_workflow_id(data.get("workflow_id"), path=f"{path}.workflow_id")
        owner_scope = _string(data.get("owner_scope"), path=f"{path}.owner_scope")
        title = _string(data.get("title"), path=f"{path}.title", max_length=MAX_LABEL_LENGTH)
        head_revision = validate_revision(data.get("head_revision"), path=f"{path}.head_revision")
        published_raw = data.get("published_revisions", [])
        if not isinstance(published_raw, list):
            raise WorkflowModelError(
                "published_revisions must be an array",
                code="unexpected_container",
                path=f"{path}.published_revisions",
            )
        published = [
            validate_revision(value, path=f"{path}.published_revisions[{index}]")
            for index, value in enumerate(published_raw)
        ]
        if published != sorted(set(published)) or any(value > head_revision for value in published):
            raise WorkflowModelError(
                "published revisions must be unique and sorted",
                code="invalid_publications",
                path=f"{path}.published_revisions",
            )
        active_raw = data.get("active_published_revision")
        active = (
            validate_revision(active_raw, path=f"{path}.active_published_revision")
            if active_raw is not None
            else None
        )
        if active is not None and active not in published:
            raise WorkflowModelError(
                "active revision must be published",
                code="invalid_publications",
                path=f"{path}.active_published_revision",
            )
        created_at = _string(
            data.get("created_at"), path=f"{path}.created_at", max_length=MAX_TIMESTAMP_LENGTH, strip=False
        )
        updated_at = _string(
            data.get("updated_at"), path=f"{path}.updated_at", max_length=MAX_TIMESTAMP_LENGTH, strip=False
        )
        return cls(
            workflow_id=workflow_id,
            owner_scope=owner_scope,
            title=title,
            head_revision=head_revision,
            published_revisions=published,
            active_published_revision=active,
            created_at=created_at,
            updated_at=updated_at,
        )


def snapshot_from_draft(
    draft: Any,
    *,
    workflow_id: str,
    revision: int,
    created_at: str,
) -> WorkflowSnapshot:
    """Build a server-bound snapshot from a draft mapping or snapshot.

    Workflow IDs, revisions, timestamps and digests are server-owned.  Draft
    values for those fields are ignored after the remaining document has been
    parsed, so a client cannot choose a historical revision or carry a stale
    digest into a new immutable record.
    """

    if isinstance(draft, WorkflowSnapshot):
        data = draft.to_dict()
    else:
        data = _require_mapping(draft, path="draft")
    data = dict(data)
    data["workflow_id"] = validate_workflow_id(workflow_id)
    data["revision"] = validate_revision(revision)
    data["created_at"] = _string(
        created_at, path="created_at", max_length=MAX_TIMESTAMP_LENGTH, strip=False
    )
    data["digest"] = ""
    return WorkflowSnapshot.from_dict(data, path="draft")


def verify_snapshot_digest(snapshot: WorkflowSnapshot) -> bool:
    """Check whether the stored digest is present and matches the semantics."""

    return bool(snapshot.digest) and snapshot.digest == snapshot.calculated_digest()


__all__ = [
    "JSONValue",
    "MAX_ACCEPTANCE_CRITERIA",
    "MAX_CONFIG_BYTES",
    "MAX_CONFIG_DEPTH",
    "MAX_EDGES",
    "MAX_LABEL_LENGTH",
    "MAX_NODE_CONFIG_BYTES",
    "MAX_NODES",
    "MAX_PAYLOAD_BYTES",
    "MAX_WORKFLOW_EDGES",
    "MAX_WORKFLOW_NODES",
    "MAX_WORKFLOW_PAYLOAD_BYTES",
    "WorkflowEdge",
    "WorkflowManifest",
    "WorkflowModelError",
    "WorkflowNode",
    "WorkflowNodeKind",
    "WorkflowPosition",
    "WorkflowSnapshot",
    "canonical_digest",
    "canonical_payload_size",
    "snapshot_from_draft",
    "validate_identifier",
    "validate_revision",
    "validate_workflow_id",
    "verify_snapshot_digest",
]
