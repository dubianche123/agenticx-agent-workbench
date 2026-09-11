"""Structural and semantic validation for high-level Workflow snapshots."""

from __future__ import annotations

from dataclasses import dataclass
import re
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

from .models import (
    MAX_ACCEPTANCE_CRITERIA,
    MAX_CONFIG_BYTES,
    MAX_EDGES,
    MAX_NODES,
    MAX_PAYLOAD_BYTES,
    WorkflowEdge,
    WorkflowModelError,
    WorkflowNode,
    WorkflowNodeKind,
    WorkflowSnapshot,
    canonical_payload_size,
)


MIN_APPROVAL_TTL_SECONDS = 60
MAX_APPROVAL_TTL_SECONDS = 7 * 24 * 60 * 60
SUPPORTED_APPROVER_POLICY_KINDS = frozenset({"any", "user", "role", "group", "session_owner"})

# Definition config is persisted as an immutable business document and must
# never become a credential container.  Runtime payloads use the same key
# family when stripping values before writing a GraphRun.
_SENSITIVE_KEY_RE = re.compile(
    r"(?:secret|token|password|passwd|credential|api[_-]?key|access[_-]?key|private[_-]?key)",
    re.IGNORECASE,
)
_SENSITIVE_HEADER_KEY_RE = re.compile(
    r"^(?:authorization|set[-_]?cookie|cookie|auth)(?:$|[_\-.])",
    re.IGNORECASE,
)
_USAGE_COUNTER_KEYS = frozenset({"input_tokens", "output_tokens", "total_tokens"})


def _is_sensitive_key(key: str) -> bool:
    if _SENSITIVE_KEY_RE.search(key) or _SENSITIVE_HEADER_KEY_RE.search(key):
        return True
    compact = re.sub(r"[^a-z0-9]", "", key.casefold())
    if compact.startswith(("authorization", "setcookie", "cookie")):
        return True
    if compact.startswith("auth") and not compact.startswith(("author", "authority")):
        return True
    return compact in {
        "auth",
        "authheader",
        "authtoken",
        "authkey",
    }


def _is_safe_usage_counter(key: str, value: Any) -> bool:
    """Permit only numeric usage counters through token-key redaction."""

    return (
        key in _USAGE_COUNTER_KEYS
        and isinstance(value, int)
        and not isinstance(value, bool)
        and value >= 0
    )


def _sensitive_config_paths(value: Any, path: str) -> Iterable[str]:
    """Yield credential-like config paths without recursing on caller data."""

    stack: list[tuple[Any, str]] = [(value, path)]
    while stack:
        current, current_path = stack.pop()
        if isinstance(current, Mapping):
            for key, child in current.items():
                key_text = str(key)
                child_path = f"{current_path}.{key_text}"
                if key_text in _USAGE_COUNTER_KEYS:
                    if not _is_safe_usage_counter(key_text, child):
                        yield child_path
                elif _is_sensitive_key(key_text):
                    yield child_path
                # Still inspect descendants so one unsafe sibling cannot hide
                # another unsafe key in a nested object/list.
                if isinstance(child, (Mapping, list, tuple)):
                    stack.append((child, child_path))
        elif isinstance(current, (list, tuple)):
            for index, child in enumerate(current):
                if isinstance(child, (Mapping, list, tuple)):
                    stack.append((child, f"{current_path}[{index}]"))


@dataclass(frozen=True)
class WorkflowValidationIssue:
    code: str
    message: str
    path: str

    def to_dict(self) -> Dict[str, str]:
        return {"code": self.code, "message": self.message, "path": self.path}

    # Keep the issue pleasant to consume for both typed Python callers and
    # route code that treats structured issues as ordinary dictionaries.
    def __getitem__(self, key: str) -> str:
        if key not in {"code", "message", "path"}:
            raise KeyError(key)
        return getattr(self, key)

    def get(self, key: str, default: Optional[str] = None) -> Optional[str]:
        return self[key] if key in {"code", "message", "path"} else default


class WorkflowValidationError(ValueError):
    """Validation failure carrying stable, renderer-friendly issues."""

    def __init__(self, issues: Iterable[WorkflowValidationIssue | Mapping[str, Any]]) -> None:
        normalized: List[WorkflowValidationIssue] = []
        for issue in issues:
            if isinstance(issue, WorkflowValidationIssue):
                normalized.append(issue)
            else:
                normalized.append(
                    WorkflowValidationIssue(
                        code=str(issue.get("code") or "invalid_workflow"),
                        message=str(issue.get("message") or "workflow is invalid"),
                        path=str(issue.get("path") or ""),
                    )
                )
        if not normalized:
            normalized.append(
                WorkflowValidationIssue(
                    code="invalid_workflow", message="workflow is invalid", path=""
                )
            )
        self.issues: Tuple[WorkflowValidationIssue, ...] = tuple(normalized)
        self.code = self.issues[0].code
        self.message = self.issues[0].message
        self.path = self.issues[0].path
        super().__init__(self.message)

    def to_dict(self) -> Dict[str, Any]:
        return {"issues": [issue.to_dict() for issue in self.issues]}

    @property
    def structured_issues(self) -> List[Dict[str, str]]:
        return [issue.to_dict() for issue in self.issues]


def _issue(code: str, message: str, path: str) -> WorkflowValidationIssue:
    return WorkflowValidationIssue(code=code, message=message, path=path)


def _as_snapshot(value: Any) -> WorkflowSnapshot:
    if isinstance(value, WorkflowSnapshot):
        # Re-parse through the wire representation.  This catches mutable or
        # non-JSON config values supplied by direct Python callers too.
        return WorkflowSnapshot.from_dict(value.to_dict())
    return WorkflowSnapshot.from_dict(value)


def _catalog_action(catalog: Any, connector_id: str, action_id: str) -> Any:
    """Resolve an action from tuple or mapping forms of the service catalog."""

    if catalog is None:
        from .connectors import get_connector_catalog, resolve_connector_action

        return resolve_connector_action(
            connector_id, action_id, catalog=get_connector_catalog()
        )
    if isinstance(catalog, Mapping):
        entry = catalog.get(connector_id)
        if entry is None:
            return None
        if isinstance(entry, Mapping):
            actions = entry.get("actions")
        else:
            actions = getattr(entry, "actions", None)
        if isinstance(actions, Mapping):
            return actions.get(action_id)
        if isinstance(actions, (list, tuple)):
            for action in actions:
                candidate = (
                    action.get("action_id", action.get("id"))
                    if isinstance(action, Mapping)
                    else getattr(action, "action_id", getattr(action, "id", None))
                )
                if candidate == action_id:
                    return action
        return None
    for entry in catalog or ():
        candidate_id = (
            entry.get("connector_id", entry.get("id"))
            if isinstance(entry, Mapping)
            else getattr(entry, "connector_id", getattr(entry, "id", None))
        )
        if candidate_id != connector_id:
            continue
        actions = entry.get("actions") if isinstance(entry, Mapping) else getattr(entry, "actions", ())
        if isinstance(actions, Mapping):
            return actions.get(action_id)
        for action in actions or ():
            candidate = (
                action.get("action_id", action.get("id"))
                if isinstance(action, Mapping)
                else getattr(action, "action_id", getattr(action, "id", None))
            )
            if candidate == action_id:
                return action
    return None


def _copy_node(node: WorkflowNode, *, config: Optional[Mapping[str, Any]] = None) -> WorkflowNode:
    return WorkflowNode(
        id=node.id,
        kind=node.kind,
        label=node.label,
        objective=node.objective,
        deliverable=node.deliverable,
        acceptance_criteria=tuple(node.acceptance_criteria),
        required=node.required,
        position=node.position,
        config=dict(config if config is not None else node.config),
    )


def topological_sort(snapshot: WorkflowSnapshot | Mapping[str, Any]) -> List[str]:
    """Return a deterministic Kahn ordering of snapshot node IDs.

    Ties are resolved lexicographically by node ID.  A ``ValueError`` is
    raised for a malformed edge or cycle; callers that need user-facing
    structured issues should call :func:`validate_workflow` first.
    """

    snap = snapshot if isinstance(snapshot, WorkflowSnapshot) else WorkflowSnapshot.from_dict(snapshot)
    node_ids = {node.id for node in snap.nodes}
    indegree = {node_id: 0 for node_id in node_ids}
    outgoing: Dict[str, List[str]] = {node_id: [] for node_id in node_ids}
    for edge in snap.edges:
        if edge.source not in node_ids or edge.target not in node_ids or edge.source == edge.target:
            raise ValueError("edge references an invalid node")
        indegree[edge.target] += 1
        outgoing[edge.source].append(edge.target)
    ready = sorted(node_id for node_id, degree in indegree.items() if degree == 0)
    result: List[str] = []
    while ready:
        current = ready.pop(0)
        result.append(current)
        for target in sorted(outgoing[current]):
            indegree[target] -= 1
            if indegree[target] == 0:
                ready.append(target)
        ready.sort()
    if len(result) != len(node_ids):
        raise ValueError("workflow graph contains a cycle")
    return result


def _normalize_approval_config(
    node: WorkflowNode, issues: List[WorkflowValidationIssue]
) -> Dict[str, Any]:
    config = dict(node.config)
    path = f"nodes[{node.id}].config"

    # Accept both the wire-level flat form and a compact nested policy object,
    # but normalize valid input to the flat contract used by ApprovalRequest.
    policy = config.get("approver_policy")
    if isinstance(policy, dict):
        if "approver_policy_kind" not in config:
            config["approver_policy_kind"] = policy.get("kind")
        if "approver_policy_value" not in config:
            config["approver_policy_value"] = policy.get("value")
    policy_kind = config.get("approver_policy_kind")
    if not isinstance(policy_kind, str) or not policy_kind.strip():
        issues.append(_issue("approval_policy_required", "approver policy kind is required", f"{path}.approver_policy_kind"))
    else:
        policy_kind = policy_kind.strip()
        config["approver_policy_kind"] = policy_kind
        if policy_kind not in SUPPORTED_APPROVER_POLICY_KINDS:
            issues.append(_issue("unsupported_approver_policy", "approver policy kind is not supported", f"{path}.approver_policy_kind"))
    policy_value = config.get("approver_policy_value")
    if policy_kind not in {"any", "session_owner"}:
        if not isinstance(policy_value, str) or not policy_value.strip():
            issues.append(_issue("approval_policy_value_required", "approver policy value is required", f"{path}.approver_policy_value"))
        elif isinstance(policy_value, str):
            config["approver_policy_value"] = policy_value.strip()
    elif policy_value is not None and not isinstance(policy_value, (str, list)):
        issues.append(_issue("invalid_approver_policy_value", "approver policy value must be text or an array", f"{path}.approver_policy_value"))

    summary = config.get("summary")
    if not isinstance(summary, str) or not summary.strip():
        issues.append(_issue("approval_summary_required", "approval summary is required", f"{path}.summary"))
    elif isinstance(summary, str):
        config["summary"] = summary.strip()

    target = config.get("target_action_description", config.get("target_action"))
    if not isinstance(target, str) or not target.strip():
        issues.append(_issue("approval_target_required", "target action description is required", f"{path}.target_action_description"))
    else:
        config["target_action_description"] = target.strip()

    ttl = config.get("ttl_seconds")
    if isinstance(ttl, bool) or not isinstance(ttl, int):
        issues.append(_issue("approval_ttl_required", "ttl_seconds must be an integer", f"{path}.ttl_seconds"))
    else:
        config["ttl_seconds"] = min(MAX_APPROVAL_TTL_SECONDS, max(MIN_APPROVAL_TTL_SECONDS, ttl))

    grantor = config.get("resource_grantor_ref")
    if grantor is not None:
        issues.append(_issue("external_grantor_not_supported", "resource grantor resolution is not supported", f"{path}.resource_grantor_ref"))
    return config


def validate_workflow(
    snapshot: WorkflowSnapshot | Mapping[str, Any],
    connector_catalog: Any = None,
) -> WorkflowSnapshot:
    """Validate and normalize a complete Workflow definition.

    The returned snapshot owns a fresh tuple/list-free representation of the
    node configs and has a deterministic digest.  The input is never mutated.
    """

    try:
        snap = _as_snapshot(snapshot)
    except WorkflowModelError as exc:
        raise WorkflowValidationError([_issue(exc.code, exc.message, exc.path)]) from exc

    issues: List[WorkflowValidationIssue] = []
    if len(snap.nodes) > MAX_NODES:
        issues.append(_issue("too_many_nodes", f"workflow has more than {MAX_NODES} nodes", "nodes"))
    if len(snap.edges) > MAX_EDGES:
        issues.append(_issue("too_many_edges", f"workflow has more than {MAX_EDGES} edges", "edges"))
    total_criteria = len(snap.completion_criteria) + sum(len(node.acceptance_criteria) for node in snap.nodes)
    if total_criteria > MAX_ACCEPTANCE_CRITERIA:
        issues.append(_issue("too_many_acceptance_criteria", f"workflow has more than {MAX_ACCEPTANCE_CRITERIA} acceptance criteria", ""))

    node_by_id: Dict[str, WorkflowNode] = {}
    duplicate_node_ids: set[str] = set()
    for index, node in enumerate(snap.nodes):
        if node.id in node_by_id:
            duplicate_node_ids.add(node.id)
        else:
            node_by_id[node.id] = node
        if canonical_payload_size(node.config) > MAX_CONFIG_BYTES:
            issues.append(_issue("config_too_large", f"node config exceeds {MAX_CONFIG_BYTES} bytes", f"nodes[{index}].config"))
    for node_id in sorted(duplicate_node_ids):
        issues.append(_issue("duplicate_node_id", f"node ID {node_id!r} is duplicated", "nodes"))

    edge_ids: set[str] = set()
    valid_edges: List[WorkflowEdge] = []
    for index, edge in enumerate(snap.edges):
        path = f"edges[{index}]"
        if edge.id in edge_ids:
            issues.append(_issue("duplicate_edge_id", f"edge ID {edge.id!r} is duplicated", f"{path}.id"))
        edge_ids.add(edge.id)
        if edge.source not in node_by_id:
            issues.append(_issue("unknown_edge_source", "edge source does not reference a node", f"{path}.source"))
        if edge.target not in node_by_id:
            issues.append(_issue("unknown_edge_target", "edge target does not reference a node", f"{path}.target"))
        if edge.source == edge.target:
            issues.append(_issue("self_edge", "an edge cannot connect a node to itself", path))
        if edge.source in node_by_id and edge.target in node_by_id and edge.source != edge.target:
            valid_edges.append(edge)

    trigger_nodes = [node for node in snap.nodes if node.kind is WorkflowNodeKind.TRIGGER]
    end_nodes = [node for node in snap.nodes if node.kind is WorkflowNodeKind.END]
    if len(trigger_nodes) != 1:
        issues.append(_issue("trigger_count", "workflow must contain exactly one trigger", "nodes"))
    if not end_nodes:
        issues.append(_issue("end_required", "workflow must contain at least one end node", "nodes"))

    inbound: Dict[str, List[WorkflowEdge]] = {node_id: [] for node_id in node_by_id}
    outbound: Dict[str, List[WorkflowEdge]] = {node_id: [] for node_id in node_by_id}
    for edge in valid_edges:
        inbound.setdefault(edge.target, []).append(edge)
        outbound.setdefault(edge.source, []).append(edge)
    if trigger_nodes and inbound.get(trigger_nodes[0].id):
        issues.append(_issue("trigger_has_inbound", "trigger must not have inbound edges", f"nodes[{trigger_nodes[0].id}]"))
    for end in end_nodes:
        if outbound.get(end.id):
            issues.append(_issue("end_has_outbound", "end must not have outbound edges", f"nodes[{end.id}]"))

    # Semantic node checks and normalized approval configuration.
    normalized_nodes: List[WorkflowNode] = []
    for node in snap.nodes:
        path = f"nodes[{node.id}]"
        if node.kind in {
            WorkflowNodeKind.AGENT_TASK,
            WorkflowNodeKind.CONNECTOR_ACTION,
            WorkflowNodeKind.REVIEW,
            WorkflowNodeKind.APPROVAL_GATE,
        } and not node.objective:
            issues.append(_issue("objective_required", "this node kind requires an objective", f"{path}.objective"))
        if node.kind in {
            WorkflowNodeKind.AGENT_TASK,
            WorkflowNodeKind.CONNECTOR_ACTION,
            WorkflowNodeKind.REVIEW,
        }:
            if not node.deliverable:
                issues.append(_issue("deliverable_required", "this node kind requires a deliverable", f"{path}.deliverable"))
            if not node.acceptance_criteria:
                issues.append(_issue("acceptance_criteria_required", "at least one acceptance criterion is required", f"{path}.acceptance_criteria"))

        config: Mapping[str, Any] = node.config
        for sensitive_path in _sensitive_config_paths(config, f"{path}.config"):
            leaf = sensitive_path.rsplit(".", 1)[-1]
            if leaf in _USAGE_COUNTER_KEYS:
                issues.append(
                    _issue(
                        "invalid_usage_counter",
                        "usage counters must be non-negative integers",
                        sensitive_path,
                    )
                    )
            else:
                issues.append(
                    _issue(
                        "sensitive_config_key",
                        "credential-like config keys are not allowed in a persisted workflow definition",
                        sensitive_path,
                    )
                )
        if node.kind is WorkflowNodeKind.CONNECTOR_ACTION:
            connector_id = config.get("connector_id")
            action_id = config.get("action_id")
            if not isinstance(connector_id, str) or not connector_id.strip():
                issues.append(_issue("connector_id_required", "connector_id is required", f"{path}.config.connector_id"))
            if not isinstance(action_id, str) or not action_id.strip():
                issues.append(_issue("action_id_required", "action_id is required", f"{path}.config.action_id"))
            if isinstance(connector_id, str) and isinstance(action_id, str) and connector_id.strip() and action_id.strip():
                connector_id = connector_id.strip()
                action_id = action_id.strip()
                if _catalog_action(connector_catalog, connector_id, action_id) is None:
                    issues.append(_issue("unknown_connector_action", "connector/action pair is not in the service catalog", f"{path}.config"))
                else:
                    normalized_config = dict(config)
                    normalized_config["connector_id"] = connector_id
                    normalized_config["action_id"] = action_id
                    config = normalized_config

        if node.kind is WorkflowNodeKind.DECISION:
            outgoing_edges = outbound.get(node.id, [])
            if len(outgoing_edges) < 2:
                issues.append(_issue("decision_routes_required", "decision must have at least two outgoing edges", f"{path}.edges"))
            routes: set[str] = set()
            for edge in outgoing_edges:
                route = edge.route.strip()
                if not route:
                    issues.append(_issue("decision_route_required", "every decision route must be non-empty", f"edges[{edge.id}].route"))
                elif route in routes:
                    issues.append(_issue("duplicate_decision_route", "decision routes must be unique", f"edges[{edge.id}].route"))
                routes.add(route)
        else:
            for edge in outbound.get(node.id, []):
                if edge.route:
                    issues.append(_issue("unexpected_edge_route", "only decision outgoing edges may declare a route", f"edges[{edge.id}].route"))

        if node.kind is WorkflowNodeKind.JOIN:
            mode = config.get("mode")
            if mode != "all":
                issues.append(_issue("unsupported_join_mode", "join mode must be 'all' in this MVP", f"{path}.config.mode"))
            elif len(inbound.get(node.id, [])) < 2:
                issues.append(_issue("join_inputs_required", "an all-join must have at least two inbound edges", f"{path}.edges"))

        if node.kind is WorkflowNodeKind.APPROVAL_GATE:
            config = _normalize_approval_config(node, issues)
            if len(outbound.get(node.id, [])) != 1:
                issues.append(_issue("approval_downstream_required", "approval gate must have exactly one outgoing edge", f"{path}.edges"))

        # Node-specific normalization can add compatibility aliases (for
        # example, approval policy fields).  Enforce the config budget on the
        # resulting representation as well as on the wire input parsed by the
        # model, otherwise an oversized normalized config can be persisted and
        # fail only when it is loaded again.
        try:
            normalized_config_size = canonical_payload_size(config)
        except WorkflowModelError as exc:
            issues.append(_issue(exc.code, exc.message, f"{path}.config"))
        except RecursionError:
            issues.append(_issue("config_too_deep", "node config nesting exceeds the configured depth", f"{path}.config"))
        else:
            if normalized_config_size > MAX_CONFIG_BYTES:
                issues.append(_issue("config_too_large", f"node config exceeds {MAX_CONFIG_BYTES} bytes after normalization", f"{path}.config"))

        normalized_nodes.append(_copy_node(node, config=config))

    # Non-decision routes are checked above per source node.  A malformed edge
    # whose source is unknown still gets a stable issue rather than a crash.

    topological: List[str] = []
    if node_by_id:
        try:
            topological = topological_sort(
                WorkflowSnapshot(
                    workflow_id=snap.workflow_id,
                    revision=snap.revision,
                    title=snap.title,
                    description=snap.description,
                    objective=snap.objective,
                    completion_criteria=snap.completion_criteria,
                    nodes=tuple(node_by_id.values()),
                    edges=tuple(valid_edges),
                    digest="",
                    created_at=snap.created_at,
                )
            )
        except ValueError:
            issues.append(_issue("cycle", "workflow graph must be acyclic", "edges"))

    if trigger_nodes and trigger_nodes[0].id in node_by_id:
        trigger_id = trigger_nodes[0].id
        reachable: set[str] = set()
        pending = [trigger_id]
        while pending:
            current = pending.pop()
            if current in reachable:
                continue
            reachable.add(current)
            pending.extend(edge.target for edge in outbound.get(current, []))
        for node in snap.nodes:
            if node.id not in reachable:
                issues.append(_issue("unreachable_node", "node is not reachable from the trigger", f"nodes[{node.id}]"))

        reverse: Dict[str, List[str]] = {node_id: [] for node_id in node_by_id}
        for edge in valid_edges:
            reverse.setdefault(edge.target, []).append(edge.source)
        can_reach_end: set[str] = set()
        pending = [node.id for node in end_nodes if node.id in node_by_id]
        while pending:
            current = pending.pop()
            if current in can_reach_end:
                continue
            can_reach_end.add(current)
            pending.extend(reverse.get(current, []))
        for node in snap.nodes:
            if node.id not in can_reach_end:
                issues.append(_issue("dead_end_node", "node cannot reach an end node", f"nodes[{node.id}]"))

    normalized = WorkflowSnapshot(
        workflow_id=snap.workflow_id,
        revision=snap.revision,
        title=snap.title,
        description=snap.description,
        objective=snap.objective,
        completion_criteria=tuple(snap.completion_criteria),
        nodes=tuple(normalized_nodes),
        edges=tuple(snap.edges),
        digest="",
        created_at=snap.created_at,
    )
    calculated = normalized.calculated_digest()
    validated_snapshot = WorkflowSnapshot(
        workflow_id=normalized.workflow_id,
        revision=normalized.revision,
        title=normalized.title,
        description=normalized.description,
        objective=normalized.objective,
        completion_criteria=normalized.completion_criteria,
        nodes=normalized.nodes,
        edges=normalized.edges,
        digest=calculated,
        created_at=normalized.created_at,
    )
    if canonical_payload_size(validated_snapshot.to_dict()) > MAX_PAYLOAD_BYTES:
        issues.append(_issue("payload_too_large", f"workflow payload exceeds {MAX_PAYLOAD_BYTES} bytes", ""))
    if snap.digest and snap.digest != calculated:
        issues.append(_issue("digest_mismatch", "workflow digest does not match its semantic snapshot", "digest"))
    if issues:
        raise WorkflowValidationError(issues)
    return validated_snapshot


__all__ = [
    "MAX_APPROVAL_TTL_SECONDS",
    "MIN_APPROVAL_TTL_SECONDS",
    "SUPPORTED_APPROVER_POLICY_KINDS",
    "WorkflowValidationError",
    "WorkflowValidationIssue",
    "topological_sort",
    "validate_workflow",
]
