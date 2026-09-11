from __future__ import annotations

from copy import deepcopy

import pytest

from agenticx.runtime.workflow import (
    MAX_CONFIG_BYTES,
    MAX_PAYLOAD_BYTES,
    WorkflowNodeKind,
    WorkflowValidationError,
    canonical_payload_size,
    get_connector_catalog,
    topological_sort,
    validate_workflow,
)


def workflow_raw() -> dict:
    return {
        "workflow_id": "wf_fixture",
        "revision": 1,
        "title": "Release workflow",
        "description": "A complete definition fixture",
        "objective": "Ship a reviewed release",
        "completion_criteria": ["release is recorded"],
        "nodes": [
            {"id": "trigger", "kind": "trigger", "label": "Start"},
            {
                "id": "task",
                "kind": "agent_task",
                "label": "Prepare",
                "objective": "Prepare the release",
                "deliverable": "Release package",
                "acceptance_criteria": ["Package is complete"],
            },
            {
                "id": "action",
                "kind": "connector_action",
                "label": "Read document",
                "objective": "Read the release document",
                "deliverable": "Document summary",
                "acceptance_criteria": ["Summary is clear"],
                "config": {"connector_id": "feishu", "action_id": "read_document", "document_ref": "doc-1"},
            },
            {"id": "decision", "kind": "decision", "label": "Ready?"},
            {
                "id": "approval",
                "kind": "approval_gate",
                "label": "Approve",
                "objective": "Approve the release",
                "config": {
                    "summary": "Publish release",
                    "approver_policy_kind": "any",
                    "target_action_description": "Publish the release externally",
                    "ttl_seconds": 1,
                },
            },
            {
                "id": "review",
                "kind": "review",
                "label": "Review",
                "objective": "Review the release",
                "deliverable": "Review result",
                "acceptance_criteria": ["Review is recorded"],
            },
            {"id": "join", "kind": "join", "label": "Join", "config": {"mode": "all"}},
            {"id": "end", "kind": "end", "label": "End"},
        ],
        "edges": [
            {"id": "e1", "source": "trigger", "target": "task"},
            {"id": "e2", "source": "task", "target": "action"},
            {"id": "e3", "source": "action", "target": "decision"},
            {"id": "e4", "source": "decision", "target": "approval", "route": "yes"},
            {"id": "e5", "source": "decision", "target": "review", "route": "no"},
            {"id": "e6", "source": "approval", "target": "join"},
            {"id": "e7", "source": "review", "target": "join"},
            {"id": "e8", "source": "join", "target": "end"},
        ],
        "digest": "",
        "created_at": "2026-09-10T00:00:00Z",
    }


def assert_invalid(raw: dict, code: str) -> None:
    with pytest.raises(WorkflowValidationError) as caught:
        validate_workflow(raw, get_connector_catalog())
    assert code in {issue.code for issue in caught.value.issues}


def test_round_trip_and_all_eight_kinds() -> None:
    snapshot = validate_workflow(workflow_raw(), get_connector_catalog())
    assert {node.kind for node in snapshot.nodes} == set(WorkflowNodeKind)
    assert snapshot.digest == snapshot.calculated_digest()
    assert snapshot.to_dict()["digest"] == snapshot.digest
    assert snapshot.nodes[4].config["ttl_seconds"] == 60
    assert topological_sort(snapshot) == ["trigger", "task", "action", "decision", "approval", "review", "join", "end"]


def test_digest_ignores_mapping_key_order_but_not_ordered_graph_items() -> None:
    first = validate_workflow(workflow_raw(), get_connector_catalog())
    second_raw = deepcopy(workflow_raw())
    second_raw["nodes"][2]["config"] = {
        "document_ref": "doc-1",
        "action_id": "read_document",
        "connector_id": "feishu",
    }
    second = validate_workflow(second_raw, get_connector_catalog())
    assert second.digest == first.digest

    reordered = deepcopy(workflow_raw())
    reordered["edges"] = list(reversed(reordered["edges"]))
    assert validate_workflow(reordered, get_connector_catalog()).digest != first.digest


@pytest.mark.parametrize(
    ("mutator", "code"),
    [
        (lambda raw: raw["edges"].append({"id": "cycle", "source": "end", "target": "trigger"}), "end_has_outbound"),
        (lambda raw: raw["nodes"].append({"id": "orphan", "kind": "end", "label": "Orphan"}), "unreachable_node"),
        (lambda raw: raw["edges"].append({"id": "dead", "source": "decision", "target": "task", "route": "loop"}), "cycle"),
        (lambda raw: raw["nodes"].append({"id": "trigger2", "kind": "trigger", "label": "Second"}), "trigger_count"),
        (lambda raw: raw["nodes"].append({"id": "task", "kind": "end", "label": "Duplicate"}), "duplicate_node_id"),
    ],
)
def test_rejects_invalid_graphs(mutator, code: str) -> None:
    raw = workflow_raw()
    mutator(raw)
    assert_invalid(raw, code)


def test_rejects_bad_decision_routes() -> None:
    raw = workflow_raw()
    raw["edges"][3]["route"] = ""
    raw["edges"][4]["route"] = ""
    assert_invalid(raw, "decision_route_required")

    raw = workflow_raw()
    raw["edges"][4]["route"] = "yes"
    assert_invalid(raw, "duplicate_decision_route")


def test_rejects_unknown_connector_even_with_client_schema() -> None:
    raw = workflow_raw()
    raw["nodes"][2]["config"] = {
        "connector_id": "unknown",
        "action_id": "invented",
        "schema": {"type": "object"},
    }
    assert_invalid(raw, "unknown_connector_action")


def test_rejects_external_grantor_and_deep_or_oversize_config() -> None:
    raw = workflow_raw()
    raw["nodes"][4]["config"]["resource_grantor_ref"] = "external-owner"
    assert_invalid(raw, "external_grantor_not_supported")

    raw = workflow_raw()
    value = "x"
    for _ in range(20):
        value = {"nested": value}
    raw["nodes"][1]["config"] = value
    assert_invalid(raw, "config_too_deep")

    raw = workflow_raw()
    raw["nodes"][1]["config"] = {"large": "x" * (64 * 1024)}
    assert_invalid(raw, "config_too_large")


def test_rejects_nested_credential_like_definition_keys() -> None:
    raw = workflow_raw()
    raw["nodes"][1]["config"] = {
        "safe": {"display": "release"},
        "nested": {
            "Authorization": "Bearer should-not-persist",
            "Cookie": "session=secret",
            "Authentication": "Bearer should-not-persist",
            "authentication_header": "Bearer should-not-persist",
            "inner": {"auth": "credential"},
        },
        "author": "release owner",
        "authority": "release editor",
    }
    with pytest.raises(WorkflowValidationError) as caught:
        validate_workflow(raw, get_connector_catalog())
    issues = caught.value.issues
    assert "sensitive_config_key" in {issue.code for issue in issues}
    assert any(issue.path.endswith("Authorization") for issue in issues)
    assert any(issue.path.endswith("Cookie") for issue in issues)
    assert any(issue.path.endswith("Authentication") for issue in issues)
    assert any(issue.path.endswith("authentication_header") for issue in issues)
    assert any(issue.path.endswith("auth") for issue in issues)

    safe = workflow_raw()
    safe["nodes"][1]["config"] = {"author": "release owner", "authority": "release editor"}
    normalized = validate_workflow(safe, get_connector_catalog())
    assert normalized.nodes[1].config == safe["nodes"][1]["config"]


def test_rejects_approval_config_that_grows_past_limit_during_normalization() -> None:
    raw = workflow_raw()
    config = {
        "summary": "S",
        "approver_policy": {"kind": "any", "value": ""},
        "target_action": "T",
        "ttl_seconds": 1,
        "padding": ["x" * 8170 for _ in range(8)],
    }
    raw["nodes"][4]["config"] = config
    assert canonical_payload_size(config) < MAX_CONFIG_BYTES

    with pytest.raises(WorkflowValidationError) as caught:
        validate_workflow(raw, get_connector_catalog())
    assert "config_too_large" in {issue.code for issue in caught.value.issues}


def test_payload_limit_includes_the_final_digest() -> None:
    raw = workflow_raw()
    # Keep the input just below the total limit while leaving room for model
    # defaults and the digest added by validation.
    raw["completion_criteria"] = ["x" * 8192 for _ in range(197)]
    for node in raw["nodes"]:
        config = dict(node.get("config", {}))
        config["padding"] = ["x" * 8190 for _ in range(7)]
        config["extra"] = "x" * 2650
        node["config"] = config
    assert canonical_payload_size(raw) <= MAX_PAYLOAD_BYTES

    with pytest.raises(WorkflowValidationError) as caught:
        validate_workflow(raw, get_connector_catalog())
    assert "payload_too_large" in {issue.code for issue in caught.value.issues}


def test_rejects_very_deep_config_without_leaking_recursion_error() -> None:
    raw = workflow_raw()
    value = "x"
    for _ in range(1000):
        value = {"nested": value}
    raw["nodes"][1]["config"] = value

    assert_invalid(raw, "config_too_deep")


def test_rejects_position_integer_overflow_as_non_finite_position() -> None:
    raw = workflow_raw()
    raw["nodes"][0]["position"] = {"x": 10**309, "y": 0}

    assert_invalid(raw, "non_finite_position")
