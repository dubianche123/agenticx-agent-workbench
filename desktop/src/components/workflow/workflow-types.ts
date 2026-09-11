/**
 * The editable Workflow contract.  This deliberately does not import the
 * runtime graph types: a Workflow is a mutable business definition while a
 * GraphRun is an immutable execution snapshot.
 */

export type WorkflowJsonValue =
  | null
  | boolean
  | number
  | string
  | WorkflowJsonValue[]
  | { [key: string]: WorkflowJsonValue };

export type WorkflowNodeKind =
  | "trigger"
  | "agent_task"
  | "connector_action"
  | "decision"
  | "approval_gate"
  | "review"
  | "join"
  | "end";

export const WORKFLOW_NODE_KINDS: readonly WorkflowNodeKind[] = [
  "trigger",
  "agent_task",
  "connector_action",
  "decision",
  "approval_gate",
  "review",
  "join",
  "end",
] as const;

export type WorkflowPosition = { x: number; y: number };

export type WorkflowNode = {
  id: string;
  kind: WorkflowNodeKind;
  label: string;
  objective: string;
  deliverable: string;
  acceptance_criteria: string[];
  required: boolean;
  position: WorkflowPosition;
  config: Record<string, WorkflowJsonValue>;
};

export type WorkflowEdge = {
  id: string;
  source: string;
  target: string;
  route: string;
  label: string;
};

export type WorkflowDocument = {
  workflow_id: string;
  revision: number;
  title: string;
  description: string;
  objective: string;
  completion_criteria: string[];
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  digest: string;
  created_at: string;
};

export type WorkflowDraft = Omit<WorkflowDocument, "digest" | "created_at"> & {
  digest?: string;
  created_at?: string;
};

export type WorkflowManifest = {
  workflow_id: string;
  owner_scope?: string;
  title: string;
  head_revision: number;
  published_revisions: number[];
  active_published_revision: number | null;
  digest?: string;
  created_at: string;
  updated_at: string;
};

export type WorkflowApproverPolicyKind = "any" | "user" | "role" | "group" | "session_owner";

export type WorkflowListResponse = {
  workflows: WorkflowManifest[];
};

export type WorkflowDetailResponse = {
  snapshot: WorkflowDocument;
  manifest: WorkflowManifest;
};

export type ConnectorRisk = "read" | "write" | "external_write";

export type ConnectorAction = {
  action_id: string;
  label: string;
  description: string;
  risk: ConnectorRisk;
  input_schema: Record<string, WorkflowJsonValue>;
};

export type ConnectorCatalogEntry = {
  connector_id: string;
  label: string;
  description: string;
  actions: ConnectorAction[];
};

export type ConnectorCatalogResponse = {
  connectors: ConnectorCatalogEntry[];
};

export type WorkflowRuntimeNode = {
  id: string;
  workflow_node_id?: string;
  workflow_node_kind?: WorkflowNodeKind | string;
  kind?: string;
  label?: string;
  status: string;
  objective?: string;
  output_summary?: string;
  evidence?: WorkflowJsonValue[];
  selected_route?: string;
  meta?: Record<string, WorkflowJsonValue>;
};

export type WorkflowArtifactRef = {
  id?: string;
  node_id?: string;
  kind?: string;
  path?: string;
  path_or_uri?: string;
  summary?: string;
  format?: string;
  [key: string]: unknown;
};

export type WorkflowEvidenceRef = {
  id?: string;
  node_id?: string;
  kind?: string;
  payload?: WorkflowJsonValue;
  [key: string]: unknown;
};

export type WorkflowExecutionState =
  | "queued"
  | "running"
  | "blocked"
  | "failed"
  | "completed"
  | "cancelled";

export type WorkflowExecutionClaim = {
  run_id?: string;
  node_id?: string;
  attempt_id?: string;
  claim_owner?: string;
  fencing_token?: number;
  lease_expires_at?: number;
  claimed_at?: number;
  run_version?: number;
  [key: string]: unknown;
};

/** Durable executor projection returned beside every run mutation/read. */
export type WorkflowExecution = {
  state: WorkflowExecutionState;
  run_id: string;
  version: number;
  active_node_ids: string[];
  blocked_node_ids: string[];
  claims: Record<string, WorkflowExecutionClaim>;
  last_error: string;
};

export type WorkflowRuntimeEdge = {
  id: string;
  source: string;
  target: string;
  label?: string;
  meta?: Record<string, WorkflowJsonValue>;
};

export type WorkflowApproval = {
  approval_id: string;
  workflow_id: string;
  workflow_revision: number;
  workflow_digest: string;
  run_id: string;
  gate_node_id: string;
  downstream_node_id?: string;
  session_id: string;
  intent_digest: string;
  status: "pending" | "approved" | "rejected" | "expired" | "consumed" | "cancelled" | string;
  version: number;
  request_json?: Record<string, WorkflowJsonValue>;
  summary?: string;
  target_action_description?: string;
  approver_policy_kind?: WorkflowApproverPolicyKind;
  approver_policy_value?: string;
  requested_at?: string;
  expires_at?: string;
  decided_at?: string;
  decided_by?: string;
  decision_note?: string;
  result_digest?: string;
};

export type WorkflowRun = {
  run_id: string;
  session_id: string;
  workflow_id: string;
  workflow_revision: number;
  workflow_digest: string;
  status: string;
  version: number;
  nodes: Record<string, WorkflowRuntimeNode> | WorkflowRuntimeNode[];
  edges: WorkflowRuntimeEdge[];
  artifacts?: WorkflowArtifactRef[];
  evidence?: WorkflowEvidenceRef[];
  meta?: Record<string, WorkflowJsonValue>;
  ready_node_ids?: string[];
  approvals?: WorkflowApproval[];
  execution?: WorkflowExecution;
};

/**
 * Identity captured by a run panel action before it crosses an async API
 * boundary. The request token belongs to the visible run context and makes a
 * delayed approval callback harmless after a new run or pane is selected.
 */
export type WorkflowRunRefreshContext = {
  workflowId: string;
  sessionId: string;
  runId: string;
  requestToken: number;
  /** Poll/action lifetime. The owner may abort a read when the panel closes. */
  signal?: AbortSignal;
};

export type WorkflowRunResponse = {
  /** The server envelope keeps the run beside readiness; approvals may be omitted by older routes. */
  run: WorkflowRun;
  ready_node_ids: string[];
  approvals?: WorkflowApproval[];
  approval?: WorkflowApproval;
  execution?: WorkflowExecution;
};

export type WorkflowApprovalResponse = {
  approval?: WorkflowApproval;
  run?: WorkflowRun;
  ready_node_ids?: string[];
  approvals?: WorkflowApproval[];
  execution?: WorkflowExecution;
};

export type WorkflowApiIssue = {
  code: string;
  message: string;
  path?: string;
};

export type WorkflowApiErrorShape = {
  code?: string;
  message?: string;
  issues?: WorkflowApiIssue[];
  detail?: unknown;
};
