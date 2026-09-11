"""Versioned, editable Workflow definition core.

The compiler/runtime modules are optional consumers of this package.  Keeping
the definition models, validation and store exports here gives Studio and API
code one stable import surface while preserving the existing graph runtime.
"""

from .connectors import (
    ConnectorAction,
    ConnectorCatalogEntry,
    connector_catalog_to_dict,
    get_connector_catalog,
    resolve_connector_action,
)
from .models import (
    JSONValue,
    MAX_ACCEPTANCE_CRITERIA,
    MAX_CONFIG_BYTES,
    MAX_CONFIG_DEPTH,
    MAX_EDGES,
    MAX_NODE_CONFIG_BYTES,
    MAX_NODES,
    MAX_PAYLOAD_BYTES,
    MAX_WORKFLOW_EDGES,
    MAX_WORKFLOW_NODES,
    MAX_WORKFLOW_PAYLOAD_BYTES,
    WorkflowEdge,
    WorkflowManifest,
    WorkflowModelError,
    WorkflowNode,
    WorkflowNodeKind,
    WorkflowPosition,
    WorkflowSnapshot,
    canonical_digest,
    canonical_payload_size,
    snapshot_from_draft,
    validate_identifier,
    validate_revision,
    validate_workflow_id,
    verify_snapshot_digest,
)
from .store import (
    WorkflowCorruptError,
    WorkflowNotFound,
    WorkflowOwnershipError,
    WorkflowStore,
    WorkflowStoreError,
    WorkflowVersionConflict,
    default_workflows_root,
)
from .validation import (
    MAX_APPROVAL_TTL_SECONDS,
    MIN_APPROVAL_TTL_SECONDS,
    SUPPORTED_APPROVER_POLICY_KINDS,
    WorkflowValidationError,
    WorkflowValidationIssue,
    topological_sort,
    validate_workflow,
)
from .approval import (
    ApprovalConflict,
    ApprovalCorruptError,
    ApprovalError,
    ApprovalExpired,
    ApprovalExternalGrantorUnsupported,
    ApprovalIntentMismatch,
    ApprovalNotFound,
    ApprovalPolicyUnsupported,
    ApprovalRequest,
    ApprovalService,
    ApprovalStatus,
    ApprovalStore,
)
from .compiler import bounded_json_value, compile_workflow_run
from .execution import (
    AdapterAvailability,
    AdapterContext,
    AdapterResult,
    MAX_EXECUTOR_EVIDENCE_ITEMS,
    MAX_EXECUTOR_EVENTS,
    MAX_EXECUTOR_EVENT_CHARS,
    MAX_EXECUTOR_OUTPUT_CHARS,
    MAX_EXECUTOR_PROMPT_CHARS,
    WorkflowExecutionAdapter,
    WorkflowExecutionBlocked,
    WorkflowNodeClaim,
    WorkflowUncertainExternalEffect,
    coerce_adapter_availability,
    coerce_adapter_result,
)
from .runtime import (
    WorkflowApprovalResult,
    WorkflowClaimConflict,
    WorkflowExecutorError,
    WorkflowRevisionNotPublished,
    WorkflowRunConflict,
    WorkflowRunCancelled,
    WorkflowRunCreation,
    WorkflowRunNotFound,
    WorkflowRunOwnershipError,
    WorkflowRuntimeError,
    WorkflowRuntimeService,
    workflow_execution_envelope,
)
from .executor import WorkflowExecutor


# Concrete CLI/MCP adapters are loaded only when a caller asks for one (the
# executor itself imports the builder on first connector-node demand).  This
# keeps importing the definition/runtime package from a cold Studio route from
# touching subprocess, connector-home, or MCP implementation modules.
_LAZY_CONNECTOR_EXPORTS = frozenset(
    {
        "AsyncSubprocessRunner",
        "CommandConnectorAdapter",
        "CommandResult",
        "CommandRunner",
        "FeishuConnectorAdapter",
        "McpConnectorAdapter",
        "UnavailableConnectorAdapter",
        "build_connector_adapters",
    }
)


def __getattr__(name: str):
    if name in _LAZY_CONNECTOR_EXPORTS:
        import importlib

        connector_execution = importlib.import_module(f"{__name__}.connector_execution")

        value = getattr(connector_execution, name)
        globals()[name] = value
        return value
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")

__all__ = [
    "ConnectorAction",
    "ConnectorCatalogEntry",
    "JSONValue",
    "MAX_ACCEPTANCE_CRITERIA",
    "MAX_APPROVAL_TTL_SECONDS",
    "MAX_CONFIG_BYTES",
    "MAX_CONFIG_DEPTH",
    "MAX_EDGES",
    "MAX_NODE_CONFIG_BYTES",
    "MAX_NODES",
    "MAX_PAYLOAD_BYTES",
    "MAX_WORKFLOW_EDGES",
    "MAX_WORKFLOW_NODES",
    "MAX_WORKFLOW_PAYLOAD_BYTES",
    "MIN_APPROVAL_TTL_SECONDS",
    "SUPPORTED_APPROVER_POLICY_KINDS",
    "WorkflowCorruptError",
    "WorkflowEdge",
    "WorkflowManifest",
    "WorkflowModelError",
    "WorkflowNode",
    "WorkflowNodeKind",
    "WorkflowNotFound",
    "WorkflowOwnershipError",
    "WorkflowPosition",
    "WorkflowSnapshot",
    "WorkflowStore",
    "WorkflowStoreError",
    "WorkflowValidationError",
    "WorkflowValidationIssue",
    "WorkflowVersionConflict",
    "canonical_digest",
    "canonical_payload_size",
    "bounded_json_value",
    "connector_catalog_to_dict",
    "default_workflows_root",
    "get_connector_catalog",
    "resolve_connector_action",
    "snapshot_from_draft",
    "topological_sort",
    "validate_identifier",
    "validate_revision",
    "validate_workflow",
    "validate_workflow_id",
    "verify_snapshot_digest",
    "ApprovalConflict",
    "ApprovalCorruptError",
    "ApprovalError",
    "ApprovalExpired",
    "ApprovalExternalGrantorUnsupported",
    "ApprovalIntentMismatch",
    "ApprovalNotFound",
    "ApprovalPolicyUnsupported",
    "ApprovalRequest",
    "ApprovalService",
    "ApprovalStatus",
    "ApprovalStore",
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
    "WorkflowClaimConflict",
    "WorkflowApprovalResult",
    "WorkflowExecutorError",
    "WorkflowRevisionNotPublished",
    "WorkflowRunConflict",
    "WorkflowRunCancelled",
    "WorkflowRunCreation",
    "WorkflowRunNotFound",
    "WorkflowRunOwnershipError",
    "WorkflowRuntimeError",
    "WorkflowRuntimeService",
    "WorkflowExecutor",
    "workflow_execution_envelope",
    "coerce_adapter_availability",
    "coerce_adapter_result",
    "AsyncSubprocessRunner",
    "CommandConnectorAdapter",
    "CommandResult",
    "CommandRunner",
    "FeishuConnectorAdapter",
    "McpConnectorAdapter",
    "UnavailableConnectorAdapter",
    "build_connector_adapters",
    "compile_workflow_run",
]
