import type {
  ConnectorCatalogEntry,
  ConnectorCatalogResponse,
  WorkflowApiErrorShape,
  WorkflowApiIssue,
  WorkflowApproval,
  WorkflowApprovalResponse,
  WorkflowDetailResponse,
  WorkflowDocument,
  WorkflowDraft,
  WorkflowExecution,
  WorkflowListResponse,
  WorkflowManifest,
  WorkflowRun,
  WorkflowRunResponse,
} from "./workflow-types";

export type WorkflowApiOptions = {
  apiBase: string;
  apiToken: string;
  signal?: AbortSignal;
};

export type WorkflowSaveResponse = {
  snapshot: WorkflowDocument;
  manifest: WorkflowManifest;
};

export type WorkflowPublishResponse = WorkflowSaveResponse & {
  published_revision?: number;
};

export type WorkflowDecision = "approved" | "rejected";

export type WorkflowConfirmationDecision = {
  session_id: string;
  request_id: string;
  approved: boolean;
  agent_id?: string;
};

export class WorkflowApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly issues: WorkflowApiIssue[];
  readonly payload: unknown;

  constructor(
    status: number,
    message: string,
    options: {
      code?: string;
      issues?: WorkflowApiIssue[];
      payload?: unknown;
    } = {},
  ) {
    super(message);
    this.name = "WorkflowApiError";
    this.status = status;
    this.code = options.code || `http_${status}`;
    this.issues = options.issues || [];
    this.payload = options.payload;
  }

  get isConflict(): boolean {
    return this.status === 409;
  }
}

function baseUrl(apiBase: string): string {
  return String(apiBase || "").trim().replace(/\/+$/, "");
}

function requestUrl(apiBase: string, path: string): string {
  const base = baseUrl(apiBase);
  if (!base) throw new WorkflowApiError(0, "本地助手后端未就绪", { code: "missing_api_base" });
  return `${base}${path}`;
}

function readErrorShape(payload: unknown): {
  message: string;
  code: string;
  issues: WorkflowApiIssue[];
} {
  const root = payload && typeof payload === "object" ? (payload as WorkflowApiErrorShape) : {};
  const detail = root.detail && typeof root.detail === "object"
    ? (root.detail as WorkflowApiErrorShape)
    : root.detail;
  const source = (detail && typeof detail === "object" ? detail : root) as WorkflowApiErrorShape & {
    error?: unknown;
  };
  const issues = Array.isArray(source.issues)
    ? source.issues
        .filter((issue): issue is WorkflowApiIssue => Boolean(issue && typeof issue === "object"))
        .map((issue) => ({
          code: String(issue.code || "invalid_workflow"),
          message: String(issue.message || "工作流校验失败"),
          ...(issue.path ? { path: String(issue.path) } : {}),
        }))
    : [];
  const code = String(source.code || (typeof source.error === "string" ? source.error : "") || "api_error");
  const message = String(
    source.message ||
      (typeof detail === "string" ? detail : "") ||
      root.message ||
      "工作流请求失败",
  );
  return { message, code, issues };
}

async function parseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { message: text.slice(0, 500) };
  }
}

async function request<T>(
  options: WorkflowApiOptions,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("x-agx-desktop-token", options.apiToken);
  if (init.body != null && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(requestUrl(options.apiBase, path), {
    ...init,
    headers,
    signal: init.signal ?? options.signal,
  });
  const payload = await parseBody(response);
  if (!response.ok) {
    const shape = readErrorShape(payload);
    throw new WorkflowApiError(response.status, shape.message, {
      code: shape.code,
      issues: shape.issues,
      payload,
    });
  }
  return payload as T;
}

function snapshotFrom(payload: unknown): WorkflowDocument {
  if (payload && typeof payload === "object") {
    const root = payload as { snapshot?: unknown; workflow?: unknown; document?: unknown };
    const candidate = root.snapshot ?? root.workflow ?? root.document ?? payload;
    return candidate as WorkflowDocument;
  }
  return payload as WorkflowDocument;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function manifestFallback(snapshot?: WorkflowDocument, previous?: WorkflowManifest): WorkflowManifest {
  const snapshotRecord = objectRecord(snapshot);
  const published = Array.isArray(snapshotRecord?.published_revisions)
    ? snapshotRecord.published_revisions.filter((value): value is number => typeof value === "number" && Number.isFinite(value))
    : previous?.published_revisions || [];
  const active = Object.prototype.hasOwnProperty.call(snapshotRecord || {}, "active_published_revision")
    ? (typeof snapshotRecord?.active_published_revision === "number" ? snapshotRecord.active_published_revision : null)
    : (previous?.active_published_revision ?? null);
  return {
    ...(previous || {}),
    workflow_id: String(snapshot?.workflow_id || previous?.workflow_id || ""),
    title: String(snapshot?.title || previous?.title || ""),
    head_revision: numberOr(snapshot?.revision, previous?.head_revision || 1),
    published_revisions: published,
    active_published_revision: active,
    created_at: String(snapshot?.created_at || previous?.created_at || ""),
    updated_at: String(snapshotRecord?.updated_at || previous?.updated_at || snapshot?.created_at || ""),
  };
}

/**
 * The definition endpoint has two distinct objects.  Only an explicit
 * `manifest` field is eligible for manifest data; the historical `workflow`
 * alias is a snapshot and must never be interpreted as one.
 */
function manifestFrom(
  payload: unknown,
  snapshot?: WorkflowDocument,
  previous?: WorkflowManifest,
): WorkflowManifest {
  const fallback = manifestFallback(snapshot, previous);
  const explicit = objectRecord(objectRecord(payload)?.manifest);
  if (!explicit) return fallback;
  return {
    ...fallback,
    ...explicit,
    workflow_id: String(explicit.workflow_id || fallback.workflow_id),
    title: String(explicit.title || fallback.title),
    head_revision: numberOr(explicit.head_revision, fallback.head_revision),
    published_revisions: Array.isArray(explicit.published_revisions)
      ? explicit.published_revisions.filter((value): value is number => typeof value === "number" && Number.isFinite(value))
      : fallback.published_revisions,
    active_published_revision: Object.prototype.hasOwnProperty.call(explicit, "active_published_revision")
      ? (typeof explicit.active_published_revision === "number" ? explicit.active_published_revision : null)
      : fallback.active_published_revision,
    created_at: String(explicit.created_at || fallback.created_at),
    updated_at: String(explicit.updated_at || fallback.updated_at),
  } as WorkflowManifest;
}

function workflowRunFrom(value: unknown): WorkflowRun | null {
  const candidate = objectRecord(value);
  return candidate && typeof candidate.run_id === "string" ? candidate as unknown as WorkflowRun : null;
}

function approvalsFrom(value: unknown): WorkflowApproval[] {
  return Array.isArray(value)
    ? value.filter((item): item is WorkflowApproval => Boolean(objectRecord(item))) as WorkflowApproval[]
    : [];
}

function executionState(value: unknown, run: WorkflowRun): WorkflowExecution["state"] {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "running") return "running";
  if (raw === "blocked") return "blocked";
  if (raw === "failed") return "failed";
  if (raw === "cancelled" || raw === "canceled") return "cancelled";
  if (raw === "completed" || raw === "closed" || raw === "done") return "completed";
  // The historical GraphRun status is `open`; the public managed execution
  // contract intentionally exposes this as queued while the executor claims
  // the first ready node.
  return "queued";
}

function executionFrom(value: unknown, run: WorkflowRun): WorkflowExecution {
  const raw = objectRecord(value) || {};
  const claims = objectRecord(raw.claims) || {};
  const normalizeClaims = Object.fromEntries(
    Object.entries(claims).map(([nodeId, claim]) => [
      nodeId,
      objectRecord(claim) || {},
    ]),
  );
  const list = (candidate: unknown): string[] => Array.isArray(candidate)
    ? candidate.filter((item): item is string => typeof item === "string")
    : [];
  const rawVersion = Number(raw.version ?? run.version);
  return {
    state: executionState(raw.state, run),
    run_id: String(raw.run_id || run.run_id || ""),
    version: Number.isFinite(rawVersion) ? rawVersion : Number(run.version || 0),
    active_node_ids: list(raw.active_node_ids),
    blocked_node_ids: list(raw.blocked_node_ids),
    claims: normalizeClaims,
    last_error: String(raw.last_error || ""),
  };
}

/** Keep every field in the server run envelope for all run mutations. */
function normalizeRunEnvelope(payload: unknown): WorkflowRunResponse {
  const root = objectRecord(payload) || {};
  const run = workflowRunFrom(root.run) || workflowRunFrom(root) || root as unknown as WorkflowRun;
  const execution = executionFrom(root.execution ?? run.execution, run);
  const normalizedRun = { ...run, execution };
  const readyNodeIds = Object.prototype.hasOwnProperty.call(root, "ready_node_ids")
    ? (Array.isArray(root.ready_node_ids)
      ? root.ready_node_ids.filter((value): value is string => typeof value === "string")
      : [])
    : (Array.isArray(run.ready_node_ids) ? run.ready_node_ids : []);
  const hasRootApprovals = Object.prototype.hasOwnProperty.call(root, "approvals");
  const hasRunApprovals = Object.prototype.hasOwnProperty.call(run, "approvals");
  const approvals = hasRootApprovals
    ? approvalsFrom(root.approvals)
    : hasRunApprovals
      ? approvalsFrom(run.approvals)
      : undefined;
  return {
    ...root,
    ...normalizedRun,
    run: normalizedRun,
    ready_node_ids: readyNodeIds,
    ...(approvals ? { approvals } : {}),
    execution,
  } as WorkflowRunResponse;
}

function normalizeApprovalResponse(payload: unknown): WorkflowApprovalResponse {
  const root = objectRecord(payload) || {};
  const run = workflowRunFrom(root.run) || workflowRunFrom(root);
  const execution = run ? executionFrom(root.execution ?? run.execution, run) : undefined;
  const normalizedRun = run ? { ...run, ...(execution ? { execution } : {}) } : undefined;
  const approvals = Object.prototype.hasOwnProperty.call(root, "approvals")
    ? approvalsFrom(root.approvals)
    : (run?.approvals || []);
  const readyNodeIds = Object.prototype.hasOwnProperty.call(root, "ready_node_ids")
    ? (Array.isArray(root.ready_node_ids) ? root.ready_node_ids.filter((value): value is string => typeof value === "string") : [])
    : (run?.ready_node_ids || []);
  return {
    ...root,
    ...(objectRecord(root.approval) ? { approval: root.approval as WorkflowApproval } : {}),
    ...(normalizedRun ? { run: normalizedRun } : {}),
    ready_node_ids: readyNodeIds,
    approvals,
    ...(execution ? { execution } : {}),
  } as WorkflowApprovalResponse;
}

function unwrapList<T>(payload: unknown, keys: string[]): T[] {
  if (Array.isArray(payload)) return payload as T[];
  if (payload && typeof payload === "object") {
    for (const key of keys) {
      const value = (payload as Record<string, unknown>)[key];
      if (Array.isArray(value)) return value as T[];
    }
  }
  return [];
}

export async function fetchWorkflowConnectors(options: WorkflowApiOptions): Promise<ConnectorCatalogEntry[]> {
  const payload = await request<ConnectorCatalogResponse | ConnectorCatalogEntry[]>(options, "/api/workflows/connectors");
  return unwrapList<ConnectorCatalogEntry>(payload, ["connectors", "catalog", "items"]);
}

export async function fetchWorkflows(options: WorkflowApiOptions): Promise<WorkflowManifest[]> {
  const payload = await request<WorkflowListResponse | WorkflowManifest[]>(options, "/api/workflows");
  return unwrapList<WorkflowManifest>(payload, ["workflows", "manifests", "items"]);
}

export async function fetchWorkflow(
  options: WorkflowApiOptions,
  workflowId: string,
  revision?: number,
  previousManifest?: WorkflowManifest,
): Promise<WorkflowDetailResponse> {
  const query = revision == null ? "" : `?revision=${encodeURIComponent(String(revision))}`;
  const payload = await request<unknown>(options, `/api/workflows/${encodeURIComponent(workflowId)}${query}`);
  const snapshot = snapshotFrom(payload);
  return { snapshot, manifest: manifestFrom(payload, snapshot, previousManifest) };
}

export async function createWorkflow(
  options: WorkflowApiOptions,
  draft: WorkflowDraft,
  previousManifest?: WorkflowManifest,
): Promise<WorkflowDetailResponse> {
  const payload = await request<unknown>(options, "/api/workflows", {
    method: "POST",
    body: JSON.stringify(draft),
  });
  const snapshot = snapshotFrom(payload);
  return { snapshot, manifest: manifestFrom(payload, snapshot, previousManifest) };
}

export async function saveWorkflow(
  options: WorkflowApiOptions,
  workflowId: string,
  draft: WorkflowDraft,
  expectedHeadRevision: number,
  previousManifest?: WorkflowManifest,
): Promise<WorkflowSaveResponse> {
  const payload = await request<unknown>(options, `/api/workflows/${encodeURIComponent(workflowId)}`, {
    method: "PUT",
    body: JSON.stringify({ ...draft, expected_head_revision: expectedHeadRevision }),
  });
  const snapshot = snapshotFrom(payload);
  return { snapshot, manifest: manifestFrom(payload, snapshot, previousManifest) };
}

export async function publishWorkflow(
  options: WorkflowApiOptions,
  workflowId: string,
  revision: number,
  expectedHeadRevision: number,
  previousManifest?: WorkflowManifest,
): Promise<WorkflowPublishResponse> {
  const payload = await request<unknown>(options, `/api/workflows/${encodeURIComponent(workflowId)}/publish`, {
    method: "POST",
    body: JSON.stringify({ revision, expected_head_revision: expectedHeadRevision }),
  });
  const snapshot = snapshotFrom(payload);
  return {
    snapshot,
    manifest: manifestFrom(payload, snapshot, previousManifest),
    ...(payload && typeof payload === "object" && "published_revision" in payload
      ? { published_revision: Number((payload as { published_revision?: unknown }).published_revision) }
      : {}),
  };
}

export async function createWorkflowRun(
  options: WorkflowApiOptions,
  workflowId: string,
  revision: number,
  sessionId: string,
  inputs: Record<string, unknown> = {},
): Promise<WorkflowRunResponse> {
  const payload = await request<WorkflowRunResponse>(options, `/api/workflows/${encodeURIComponent(workflowId)}/runs`, {
    method: "POST",
    body: JSON.stringify({ revision, session_id: sessionId, inputs }),
  });
  return normalizeRunEnvelope(payload);
}

export async function fetchWorkflowRun(
  options: WorkflowApiOptions,
  runId: string,
  sessionId: string,
): Promise<WorkflowRunResponse> {
  const query = `?session_id=${encodeURIComponent(sessionId)}`;
  const payload = await request<WorkflowRunResponse>(options, `/api/workflow-runs/${encodeURIComponent(runId)}${query}`);
  return normalizeRunEnvelope(payload);
}

export async function reportWorkflowNodeResult(
  options: WorkflowApiOptions,
  runId: string,
  nodeId: string,
  payload: {
    session_id: string;
    expected_version: number;
    outcome: "done" | "failed";
    output_summary?: string;
    evidence?: unknown[];
    selected_route?: string;
  },
): Promise<WorkflowRunResponse> {
  const response = await request<WorkflowRunResponse>(
    options,
    `/api/workflow-runs/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(nodeId)}/result`,
    { method: "POST", body: JSON.stringify(payload) },
  );
  return normalizeRunEnvelope(response);
}

export async function fetchWorkflowApprovals(
  options: WorkflowApiOptions,
  runId: string,
  sessionId: string,
): Promise<WorkflowApproval[]> {
  const query = `?session_id=${encodeURIComponent(sessionId)}`;
  const payload = await request<unknown>(options, `/api/workflow-runs/${encodeURIComponent(runId)}/approvals${query}`);
  return unwrapList<WorkflowApproval>(payload, ["approvals", "items"]);
}

export async function decideWorkflowApproval(
  options: WorkflowApiOptions,
  approvalId: string,
  payload: { session_id: string; expected_version: number; decision: WorkflowDecision; decision_note?: string; expected_run_version?: number },
): Promise<WorkflowApprovalResponse> {
  const response = await request<unknown>(options, `/api/workflow-approvals/${encodeURIComponent(approvalId)}/decision`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
  return normalizeApprovalResponse(response);
}

export async function resumeWorkflowApproval(
  options: WorkflowApiOptions,
  approvalId: string,
  payload: { session_id: string; expected_version: number; expected_run_version?: number },
): Promise<WorkflowRunResponse> {
  const response = await request<WorkflowRunResponse>(options, `/api/workflow-approvals/${encodeURIComponent(approvalId)}/resume`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
  return normalizeRunEnvelope(response);
}

export async function resumeWorkflowRun(
  options: WorkflowApiOptions,
  runId: string,
  payload: { session_id: string; expected_version?: number },
): Promise<WorkflowRunResponse> {
  const response = await request<unknown>(options, `/api/workflow-runs/${encodeURIComponent(runId)}/resume`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
  return normalizeRunEnvelope(response);
}

export async function cancelWorkflowRun(
  options: WorkflowApiOptions,
  runId: string,
  payload: { session_id: string; expected_version?: number },
): Promise<WorkflowRunResponse> {
  const response = await request<unknown>(options, `/api/workflow-runs/${encodeURIComponent(runId)}/cancel`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
  return normalizeRunEnvelope(response);
}

export async function retryWorkflowNode(
  options: WorkflowApiOptions,
  runId: string,
  nodeId: string,
  payload: { session_id: string; expected_version: number; reconcile?: boolean },
): Promise<WorkflowRunResponse> {
  const response = await request<unknown>(
    options,
    `/api/workflow-runs/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(nodeId)}/retry`,
    { method: "POST", body: JSON.stringify(payload) },
  );
  return normalizeRunEnvelope(response);
}

/**
 * Resolve a protected tool confirmation emitted while a workflow node is
 * running. The workflow executor uses the ordinary authenticated session
 * confirmation gate, so this deliberately goes through the shared
 * `/api/confirm` transport instead of inventing a workflow-only approval.
 */
export async function resolveWorkflowConfirmation(
  options: WorkflowApiOptions,
  payload: WorkflowConfirmationDecision,
): Promise<void> {
  await request<{ ok?: boolean }>(options, "/api/confirm", {
    method: "POST",
    body: JSON.stringify({
      ...payload,
      ...(payload.agent_id ? { agent_id: payload.agent_id } : {}),
    }),
  });
}

export const workflowApi = {
  fetchWorkflowConnectors,
  fetchWorkflows,
  fetchWorkflow,
  createWorkflow,
  saveWorkflow,
  publishWorkflow,
  createWorkflowRun,
  fetchWorkflowRun,
  reportWorkflowNodeResult,
  fetchWorkflowApprovals,
  decideWorkflowApproval,
  resumeWorkflowApproval,
  resumeWorkflowRun,
  cancelWorkflowRun,
  retryWorkflowNode,
  resolveWorkflowConfirmation,
};
