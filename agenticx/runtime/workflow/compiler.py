"""Compile an immutable Workflow snapshot into the existing GraphRun model.

Workflow definitions intentionally remain separate from runtime traces.  This
module only performs the deterministic translation; :mod:`runtime` is the
service boundary that loads an exact published revision and persists the
result.  No connector, shell, or model execution happens here.
"""

from __future__ import annotations

import copy
import json
import math
import re
import uuid
from typing import Any, Dict, Mapping, Optional

from agenticx.runtime.graph.models import (
    EdgeKind,
    GraphEdge,
    GraphNode,
    GraphRun,
    NodeKind,
    NodeStatus,
    RunState,
)

from .models import (
    JSONValue,
    MAX_CONFIG_DEPTH,
    MAX_PAYLOAD_BYTES,
    WorkflowNode,
    WorkflowNodeKind,
    WorkflowSnapshot,
    canonical_digest,
)
from .validation import validate_workflow, topological_sort


_SENSITIVE_KEY_RE = re.compile(
    r"(?:secret|token|password|passwd|credential|api[_-]?key|access[_-]?key|private[_-]?key)",
    re.IGNORECASE,
)
_SENSITIVE_HEADER_KEY_RE = re.compile(
    r"^(?:authorization|set[-_]?cookie|cookie|auth)(?:$|[_\-.])",
    re.IGNORECASE,
)

_USAGE_COUNTER_KEYS = frozenset({"input_tokens", "output_tokens", "total_tokens"})


def _is_safe_usage_counter(key: str, value: Any) -> bool:
    """Allow only bounded numeric usage counters through token redaction."""

    return (
        key in _USAGE_COUNTER_KEYS
        and isinstance(value, int)
        and not isinstance(value, bool)
        and value >= 0
    )


def _is_sensitive_key(key: str) -> bool:
    """Recognize credential fields without treating ordinary ``author`` data as one."""

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


def _bounded_json_value(
    value: Any,
    *,
    depth: int = 0,
    path: str = "value",
    strip_sensitive: bool = True,
) -> JSONValue:
    """Copy one bounded JSON value and reject unsafe Python values.

    Workflow definitions are validated before compilation, but run inputs and
    executor results arrive through separate service boundaries.  Keeping the
    same finite-number, nesting, key, and canonical-size rules here prevents a
    malformed caller from turning a persisted GraphRun into an unbounded JSON
    document or triggering recursive interpreter failures.
    """

    if depth > MAX_CONFIG_DEPTH:
        raise ValueError(f"JSON nesting exceeds {MAX_CONFIG_DEPTH} levels at {path}")
    if value is None or isinstance(value, (bool, int, str, float)):
        if isinstance(value, float) and not math.isfinite(value):
            raise ValueError(f"non-finite number at {path}")
        return copy.deepcopy(value)
    if isinstance(value, Mapping):
        copied: Dict[str, JSONValue] = {}
        for key, item in value.items():
            if not isinstance(key, str):
                raise TypeError(f"object key must be a string at {path}")
            if strip_sensitive and _is_sensitive_key(key):
                if _is_safe_usage_counter(key, item):
                    copied[key] = _bounded_json_value(
                        item,
                        depth=depth + 1,
                        path=f"{path}.{key}",
                        strip_sensitive=strip_sensitive,
                    )
                elif key in _USAGE_COUNTER_KEYS:
                    raise ValueError(
                        f"usage counter {key!r} must be a non-negative integer at {path}"
                    )
                continue
            copied[key] = _bounded_json_value(
                item,
                depth=depth + 1,
                path=f"{path}.{key}",
                strip_sensitive=strip_sensitive,
            )
        return copied
    if isinstance(value, (list, tuple)):
        return [
            _bounded_json_value(
                item,
                depth=depth + 1,
                path=f"{path}[{index}]",
                strip_sensitive=strip_sensitive,
            )
            for index, item in enumerate(value)
        ]
    raise TypeError(f"value at {path} is not JSON-compatible")


def bounded_json_value(value: Any, *, strip_sensitive: bool = True) -> JSONValue:
    """Return a defensive JSON copy subject to the Workflow payload budget."""

    copied = _bounded_json_value(value, strip_sensitive=strip_sensitive)
    encoded = json.dumps(
        copied,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")
    if len(encoded) > MAX_PAYLOAD_BYTES:
        raise ValueError(f"JSON value exceeds {MAX_PAYLOAD_BYTES} bytes")
    return copied


def _safe_config(value: Any) -> JSONValue:
    """Return a bounded JSON config with credential-like keys removed.

    Config is part of the executor contract, but GraphRun is visible to the
    renderer and can be persisted for a long time.  Definition validation
    already rejects non-JSON values; this second defensive copy prevents a
    future caller from accidentally exposing a credential field in the trace.
    """

    return bounded_json_value(value, strip_sensitive=True)


def _node_kind(kind: WorkflowNodeKind) -> NodeKind:
    if kind in {WorkflowNodeKind.AGENT_TASK, WorkflowNodeKind.CONNECTOR_ACTION}:
        return NodeKind.TASK
    if kind in {WorkflowNodeKind.TRIGGER, WorkflowNodeKind.APPROVAL_GATE}:
        return NodeKind.HUMAN
    if kind is WorkflowNodeKind.REVIEW:
        return NodeKind.REVIEW
    # Decision, join and end are structural high-level nodes.  The existing
    # runtime enum has no dedicated structural values in this MVP.
    return NodeKind.TASK


def _node_label(node: WorkflowNode) -> str:
    return node.label or node.id


def _node_meta(snapshot: WorkflowSnapshot, node: WorkflowNode, config: JSONValue) -> Dict[str, Any]:
    binding = {
        "workflow_id": snapshot.workflow_id,
        "workflow_revision": int(snapshot.revision),
        "workflow_digest": snapshot.digest,
        "workflow_node_id": node.id,
        "workflow_node_kind": node.kind.value,
    }
    # Keep both names while the Desktop and API settle on one stable contract;
    # both contain the same normalized non-secret data.
    binding["workflow_config"] = config
    binding["workflow_node_config"] = config
    binding["config"] = config
    return binding


def compile_workflow_run(
    snapshot: WorkflowSnapshot | Mapping[str, Any],
    session_id: str,
    group_id: Optional[str] = None,
    inputs: Optional[Mapping[str, Any]] = None,
    run_id: Optional[str] = None,
) -> GraphRun:
    """Compile a validated Workflow snapshot into a new GraphRun.

    The runtime service must call this with a snapshot read from a published
    revision.  The compiler accepts a mapping for convenient API callers but
    always reparses and validates it, including the immutable digest.  Whether
    a revision is published is a persistence concern and is enforced by
    :class:`WorkflowRuntimeService.create_run` before this function is called.
    """

    normalized = validate_workflow(snapshot)
    if not normalized.workflow_id or not normalized.digest:
        raise ValueError("workflow snapshot must have a workflow ID and digest")

    rid = str(run_id or f"gr_wf_{uuid.uuid4().hex[:20]}").strip()
    if not rid:
        raise ValueError("run_id must not be empty")
    sid = str(session_id or "").strip()
    if not sid:
        raise ValueError("session_id must not be empty")

    node_by_id = {node.id: node for node in normalized.nodes}
    order = topological_sort(normalized)
    inbound: Dict[str, list[str]] = {node_id: [] for node_id in node_by_id}
    for edge in normalized.edges:
        inbound.setdefault(edge.target, []).append(edge.source)

    nodes: Dict[str, GraphNode] = {}
    for node_id in order:
        definition = node_by_id[node_id]
        config = _safe_config(dict(definition.config))
        if definition.kind is WorkflowNodeKind.TRIGGER:
            status = NodeStatus.DONE
        elif definition.kind is WorkflowNodeKind.APPROVAL_GATE:
            status = NodeStatus.BLOCKED
        else:
            dependencies = inbound.get(node_id, [])
            status = (
                NodeStatus.READY
                if all(nodes[source].status in {NodeStatus.DONE, NodeStatus.SKIPPED} for source in dependencies)
                else NodeStatus.PENDING
            )
        task_text = definition.objective or definition.deliverable or definition.label
        meta = _node_meta(normalized, definition, config)
        meta.update(
            {
                "workflow_acceptance_criteria": list(definition.acceptance_criteria),
                "workflow_required": bool(definition.required),
                "workflow_position": definition.position.to_dict(),
            }
        )
        if definition.kind is WorkflowNodeKind.TRIGGER:
            # A trigger is the immutable, bounded data boundary for a managed
            # run.  Template authors may provide the explicit ``inputs``
            # envelope; the input-contract fallback keeps older published
            # drafts deterministic while they are migrated.  No filesystem
            # path or expression is interpreted here.
            trigger_inputs = config.get("inputs") if isinstance(config, Mapping) else None
            if not isinstance(trigger_inputs, Mapping):
                contract = config.get("input_contract") if isinstance(config, Mapping) else None
                if isinstance(contract, Mapping):
                    rows = contract.get("rows", contract.get("example_rows"))
                    trigger_inputs = {
                        "dataset_label": contract.get("dataset_label", ""),
                        "provenance": contract.get("provenance", ""),
                        "rows": rows if isinstance(rows, list) else [],
                    }
            if isinstance(trigger_inputs, Mapping):
                meta["workflow_output_summary"] = bounded_json_value(
                    dict(trigger_inputs),
                    strip_sensitive=True,
                )
                meta["workflow_output_digest"] = canonical_digest(meta["workflow_output_summary"])
        nodes[node_id] = GraphNode(
            id=node_id,
            kind=_node_kind(definition.kind),
            label=_node_label(definition),
            status=status,
            task_text=task_text,
            meta=meta,
        )

    edges: list[GraphEdge] = []
    for definition_edge in normalized.edges:
        source = node_by_id[definition_edge.source]
        edge_meta: Dict[str, Any] = {
            "workflow_id": normalized.workflow_id,
            "workflow_revision": int(normalized.revision),
            "workflow_digest": normalized.digest,
            "workflow_edge_id": definition_edge.id,
        }
        if source.kind is WorkflowNodeKind.DECISION:
            edge_meta["workflow_route"] = definition_edge.route
        edges.append(
            GraphEdge(
                id=definition_edge.id,
                kind=EdgeKind.DEPENDS,
                source=definition_edge.source,
                target=definition_edge.target,
                label=definition_edge.label or (definition_edge.route if source.kind is WorkflowNodeKind.DECISION else "depends"),
                meta=edge_meta,
            )
        )

    binding = {
        "workflow_id": normalized.workflow_id,
        "workflow_revision": int(normalized.revision),
        "workflow_digest": normalized.digest,
        "source": "workflow",
    }
    if inputs is not None:
        # Inputs are useful for the executor but may contain arbitrary user
        # data.  Keep a defensive copy under a private runtime key and never
        # merge it into node config or credentials.
        binding["inputs"] = bounded_json_value(dict(inputs), strip_sensitive=True)

    ready_ids = [node_id for node_id, node in nodes.items() if node.status is NodeStatus.READY]
    return GraphRun(
        run_id=rid,
        session_id=sid,
        group_id=(str(group_id).strip() if group_id is not None and str(group_id).strip() else None),
        nodes=nodes,
        edges=edges,
        workflow_id=normalized.workflow_id,
        workflow_revision=int(normalized.revision),
        workflow_digest=normalized.digest,
        run_state=RunState(current_nodes=ready_ids, branch={}),
        status="open",
        version=0,
        meta=binding,
    )


__all__ = ["bounded_json_value", "compile_workflow_run"]
