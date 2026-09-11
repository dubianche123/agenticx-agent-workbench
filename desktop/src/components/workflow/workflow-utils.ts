import type { Edge, Node } from "@xyflow/react";
import type {
  WorkflowDocument,
  WorkflowEdge,
  WorkflowExecutionState,
  WorkflowJsonValue,
  WorkflowManifest,
  WorkflowNode,
  WorkflowNodeKind,
  WorkflowApproval,
  WorkflowRun,
  WorkflowPosition,
  WorkflowRuntimeNode,
} from "./workflow-types";
import { WORKFLOW_NODE_KINDS } from "./workflow-types";

export type WorkflowNodeViewData = {
  workflowNode: WorkflowNode;
  outgoingRoutes?: string[];
  selected?: boolean;
};

export type WorkflowFlowNode = Node<WorkflowNodeViewData, "workflow-node">;
export type WorkflowFlowEdge = Edge<{ route: string }>;

export const WORKFLOW_NODE_LABELS: Record<WorkflowNodeKind, string> = {
  trigger: "触发器",
  agent_task: "智能体任务",
  connector_action: "连接器动作",
  decision: "决策",
  approval_gate: "审批门",
  review: "复核",
  join: "汇聚",
  end: "结束",
};

export const WORKFLOW_NODE_DESCRIPTIONS: Record<WorkflowNodeKind, string> = {
  trigger: "从一个工作请求开始",
  agent_task: "由受管执行器完成的语义任务",
  connector_action: "调用服务目录中的业务动作",
  decision: "根据结果选择一条路线",
  approval_gate: "在继续前等待明确审批",
  review: "检查交付物与验收标准",
  join: "等待所有选中的前置路线",
  end: "标记工作流完成",
};

const DEFAULT_POSITIONS: Record<WorkflowNodeKind, WorkflowPosition> = {
  trigger: { x: 80, y: 180 },
  agent_task: { x: 300, y: 180 },
  connector_action: { x: 520, y: 180 },
  decision: { x: 740, y: 180 },
  approval_gate: { x: 300, y: 380 },
  review: { x: 520, y: 380 },
  join: { x: 740, y: 380 },
  end: { x: 960, y: 180 },
};

export function workflowNodeLabel(kind: WorkflowNodeKind): string {
  return WORKFLOW_NODE_LABELS[kind];
}

export function workflowNodeDescription(kind: WorkflowNodeKind): string {
  return WORKFLOW_NODE_DESCRIPTIONS[kind];
}

function randomToken(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID().replaceAll("-", "").slice(0, 12);
    }
  } catch {
    // The fallback below is sufficient for a local editor session.
  }
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 9)}`;
}

/** Creates a client-only id while retaining the server's id format. */
export function uniqueWorkflowNodeId(existingIds: Iterable<string>, kind: WorkflowNodeKind): string {
  const used = new Set(existingIds);
  let candidate = `node_${kind}_${randomToken()}`;
  let attempt = 0;
  while (used.has(candidate)) {
    attempt += 1;
    candidate = `node_${kind}_${randomToken()}_${attempt}`;
  }
  return candidate;
}

export function uniqueWorkflowEdgeId(existingIds: Iterable<string>): string {
  const used = new Set(existingIds);
  let candidate = `edge_${randomToken()}`;
  let attempt = 0;
  while (used.has(candidate)) {
    attempt += 1;
    candidate = `edge_${randomToken()}_${attempt}`;
  }
  return candidate;
}

export function createWorkflowNode(
  kind: WorkflowNodeKind,
  existingIds: Iterable<string> = [],
  position?: WorkflowPosition,
): WorkflowNode {
  const label = WORKFLOW_NODE_LABELS[kind];
  const node: WorkflowNode = {
    id: uniqueWorkflowNodeId(existingIds, kind),
    kind,
    label,
    objective: kind === "trigger" ? "接收并开始处理业务请求" : "",
    deliverable: "",
    acceptance_criteria: [],
    required: kind !== "trigger" && kind !== "end",
    position: position || { ...DEFAULT_POSITIONS[kind] },
    config: {},
  };
  if (kind === "join") node.config = { mode: "all" };
  if (kind === "decision") node.config = { routes: [] };
  if (kind === "approval_gate") {
    node.config = {
      summary: "",
      approver_policy_kind: "session_owner",
      approver_policy_value: "",
      target_action_description: "",
      ttl_seconds: 3600,
      resource_grantor_ref: null,
    };
  }
  return node;
}

export function createEmptyWorkflowDocument(title = "未命名工作流"): WorkflowDocument {
  const trigger = createWorkflowNode("trigger", [], { x: 100, y: 180 });
  trigger.label = "开始";
  const end = createWorkflowNode("end", [trigger.id], { x: 520, y: 180 });
  end.label = "完成";
  return {
    workflow_id: "",
    revision: 1,
    title,
    description: "",
    objective: "",
    completion_criteria: [],
    nodes: [trigger, end],
    edges: [
      {
        id: uniqueWorkflowEdgeId([]),
        source: trigger.id,
        target: end.id,
        route: "",
        label: "",
      },
    ],
    digest: "",
    created_at: "",
  };
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableValue(item)]),
    );
  }
  return value;
}

/** Stable JSON used for dirty checks and the copy-local-json conflict action. */
export function serializeWorkflowDraft(document: WorkflowDocument): string {
  const payload = {
    workflow_id: document.workflow_id,
    revision: document.revision,
    title: document.title,
    description: document.description,
    objective: document.objective,
    completion_criteria: document.completion_criteria,
    nodes: document.nodes,
    edges: document.edges,
  };
  return JSON.stringify(stableValue(payload));
}

export function workflowDraftPayload(document: WorkflowDocument): Record<string, unknown> {
  return JSON.parse(serializeWorkflowDraft(document)) as Record<string, unknown>;
}

export function workflowDirtyKey(document: WorkflowDocument): string {
  return serializeWorkflowDraft(document);
}

export function workflowNodeById(document: WorkflowDocument, nodeId: string | null | undefined): WorkflowNode | null {
  if (!nodeId) return null;
  return document.nodes.find((node) => node.id === nodeId) || null;
}

function outgoingRoutes(document: WorkflowDocument, nodeId: string): string[] {
  return document.edges
    .filter((edge) => edge.source === nodeId && edge.route.trim())
    .map((edge) => edge.route.trim());
}

export function workflowToFlowNodes(document: WorkflowDocument): WorkflowFlowNode[] {
  return document.nodes.map((node) => ({
    id: node.id,
    type: "workflow-node",
    position: { ...node.position },
    data: {
      workflowNode: node,
      outgoingRoutes: outgoingRoutes(document, node.id),
    },
  }));
}

function sourceHandleFor(edge: WorkflowEdge): string | undefined {
  return edge.route.trim() ? `decision-route:${edge.route.trim()}` : undefined;
}

export function workflowToFlowEdges(document: WorkflowDocument): WorkflowFlowEdge[] {
  return document.edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    sourceHandle: sourceHandleFor(edge),
    label: edge.label || edge.route || undefined,
    data: { route: edge.route },
    type: "smoothstep",
    animated: false,
    style: {
      stroke: "var(--border-strong)",
      strokeWidth: 1.5,
    },
  }));
}

export function routeFromHandle(handle: string | null | undefined): string {
  const value = String(handle || "").trim();
  return value.startsWith("decision-route:") ? value.slice("decision-route:".length).trim() : "";
}

export function canConnectWorkflow(
  connection: { source?: string | null; target?: string | null; sourceHandle?: string | null },
  edges: WorkflowEdge[],
): { ok: true } | { ok: false; reason: string } {
  const source = String(connection.source || "").trim();
  const target = String(connection.target || "").trim();
  if (!source || !target) return { ok: false, reason: "连接需要来源和目标节点" };
  if (source === target) return { ok: false, reason: "不能连接节点自身" };
  const route = routeFromHandle(connection.sourceHandle);
  if (edges.some((edge) => edge.source === source && edge.target === target && edge.route === route)) {
    return { ok: false, reason: "相同的连接已经存在" };
  }
  if (route && edges.some((edge) => edge.source === source && edge.route === route)) {
    return { ok: false, reason: "决策路线必须唯一" };
  }
  return { ok: true };
}

export function connectionToWorkflowEdge(
  connection: { source?: string | null; target?: string | null; sourceHandle?: string | null },
  existingIds: Iterable<string>,
): WorkflowEdge | null {
  if (!connection.source || !connection.target) return null;
  const route = routeFromHandle(connection.sourceHandle);
  return {
    id: uniqueWorkflowEdgeId(existingIds),
    source: connection.source,
    target: connection.target,
    route,
    label: route,
  };
}

export function applyNodePosition(
  document: WorkflowDocument,
  nodeId: string,
  position: WorkflowPosition,
): WorkflowDocument {
  return {
    ...document,
    nodes: document.nodes.map((node) => (node.id === nodeId ? { ...node, position } : node)),
  };
}

export function updateWorkflowNode(
  document: WorkflowDocument,
  nodeId: string,
  patch: Partial<WorkflowNode>,
): WorkflowDocument {
  return {
    ...document,
    nodes: document.nodes.map((node) => (node.id === nodeId ? { ...node, ...patch } : node)),
  };
}

export function removeWorkflowNode(document: WorkflowDocument, nodeId: string): WorkflowDocument {
  return {
    ...document,
    nodes: document.nodes.filter((node) => node.id !== nodeId),
    edges: document.edges.filter((edge) => edge.source !== nodeId && edge.target !== nodeId),
  };
}

export function addWorkflowNode(
  document: WorkflowDocument,
  kind: WorkflowNodeKind,
  position?: WorkflowPosition,
): WorkflowDocument {
  const node = createWorkflowNode(kind, document.nodes.map((item) => item.id), position);
  return { ...document, nodes: [...document.nodes, node] };
}

export function addWorkflowEdge(document: WorkflowDocument, edge: WorkflowEdge): WorkflowDocument {
  return { ...document, edges: [...document.edges, edge] };
}

export function workflowRuntimeNodes(run: { nodes?: Record<string, WorkflowRuntimeNode> | WorkflowRuntimeNode[] }): WorkflowRuntimeNode[] {
  if (Array.isArray(run.nodes)) return run.nodes;
  return Object.values(run.nodes || {});
}

export const WORKFLOW_EXECUTION_STATE_LABELS: Record<WorkflowExecutionState, string> = {
  queued: "排队中",
  running: "执行中",
  blocked: "需要处理",
  failed: "执行失败",
  completed: "已完成",
  cancelled: "已取消",
};

/** Normalize the durable execution projection and historical GraphRun status. */
export function workflowExecutionState(run: {
  execution?: { state?: unknown } | null;
  status?: unknown;
} | null | undefined): WorkflowExecutionState {
  const raw = String(run?.execution?.state || run?.status || "").trim().toLowerCase();
  if (raw === "running") return "running";
  if (raw === "blocked") return "blocked";
  if (raw === "failed") return "failed";
  if (raw === "cancelled" || raw === "canceled") return "cancelled";
  if (raw === "completed" || raw === "closed" || raw === "done") return "completed";
  return "queued";
}

export function workflowExecutionStateLabel(state: WorkflowExecutionState): string {
  return WORKFLOW_EXECUTION_STATE_LABELS[state];
}

export function workflowRunIsTerminal(run: {
  execution?: { state?: unknown } | null;
  status?: unknown;
} | null | undefined): boolean {
  const state = workflowExecutionState(run);
  return state === "failed" || state === "completed" || state === "cancelled";
}

function workflowMetaText(node: WorkflowRuntimeNode, key: string): string {
  const value = node.meta?.[key];
  if (value == null || (typeof value !== "string" && typeof value !== "number")) return "";
  return String(value).trim();
}

export function workflowNodeBlockedReason(node: WorkflowRuntimeNode): string {
  return workflowMetaText(node, "workflow_blocked_reason")
    || workflowMetaText(node, "workflow_failure")
    || (String(node.status || "").trim().toLowerCase() === "blocked" ? String(node.output_summary || "").trim() : "");
}

export function workflowNodeErrorCode(node: WorkflowRuntimeNode): string {
  return workflowMetaText(node, "workflow_error_code");
}

export function workflowNodeRequiresReconciliation(node: WorkflowRuntimeNode): boolean {
  const value = node.meta?.workflow_reconciliation_required;
  return value === true || workflowNodeErrorCode(node) === "uncertain_external_side_effect";
}

export type WorkflowApprovalActionability = {
  canAct: boolean;
  reason: string;
};

function normalizedRuntimeStatus(value: unknown): string {
  return String(value || "").trim().toLowerCase();
}

/**
 * Approval actions are only meaningful while the graph is open and its gate
 * is still blocked. The server remains authoritative, but the panel should
 * explain a terminal or already-advanced gate before a user can click into a
 * guaranteed conflict.
 */
export function workflowApprovalActionability(
  run: Pick<WorkflowRun, "status" | "nodes">,
  approval: Pick<WorkflowApproval, "status" | "gate_node_id">,
): WorkflowApprovalActionability {
  const runStatus = normalizedRuntimeStatus(run.status);
  if (runStatus !== "open") {
    return {
      canAct: false,
      reason: runStatus ? `运行状态为“${runStatus}”，审批不可操作。` : "运行状态未知，审批不可操作。",
    };
  }

  const gateNodeId = String(approval.gate_node_id || "");
  const gate = workflowRuntimeNodes(run).find((node) => node.id === gateNodeId || node.workflow_node_id === gateNodeId);
  if (!gate) {
    return { canAct: false, reason: "审批门节点未返回，审批不可操作。" };
  }
  if (normalizedRuntimeStatus(gate.status) !== "blocked") {
    return {
      canAct: false,
      reason: `审批门当前状态为“${String(gate.status || "未知")}”，审批不可操作。`,
    };
  }

  const approvalStatus = normalizedRuntimeStatus(approval.status);
  if (approvalStatus === "pending" || approvalStatus === "approved") {
    return { canAct: true, reason: "" };
  }
  return {
    canAct: false,
    reason: `审批状态为“${String(approval.status || "未知")}”，审批不可操作。`,
  };
}

export function displayRevision(manifest: WorkflowManifest | null | undefined): string {
  if (!manifest) return "未保存";
  return `v${manifest.head_revision}`;
}

export function isWorkflowNodeKind(value: string): value is WorkflowNodeKind {
  return (WORKFLOW_NODE_KINDS as readonly string[]).includes(value);
}

export function normalizeWorkflowDocument(raw: Partial<WorkflowDocument> | null | undefined): WorkflowDocument {
  const input = raw || {};
  const nodes = Array.isArray(input.nodes) ? input.nodes : [];
  return {
    workflow_id: String(input.workflow_id || ""),
    revision: Number.isInteger(input.revision) && Number(input.revision) > 0 ? Number(input.revision) : 1,
    title: String(input.title || "未命名工作流"),
    description: String(input.description || ""),
    objective: String(input.objective || ""),
    completion_criteria: Array.isArray(input.completion_criteria)
      ? input.completion_criteria.map(String)
      : [],
    nodes: nodes.map((node) => ({
      id: String(node.id || ""),
      kind: node.kind || "agent_task",
      label: String(node.label || WORKFLOW_NODE_LABELS[node.kind || "agent_task"]),
      objective: String(node.objective || ""),
      deliverable: String(node.deliverable || ""),
      acceptance_criteria: Array.isArray(node.acceptance_criteria)
        ? node.acceptance_criteria.map(String)
        : [],
      required: node.required !== false,
      position: {
        x: Number(node.position?.x) || 0,
        y: Number(node.position?.y) || 0,
      },
      config: node.config && typeof node.config === "object" && !Array.isArray(node.config)
        ? { ...node.config }
        : {},
    })),
    edges: Array.isArray(input.edges)
      ? input.edges.map((edge) => ({
          id: String(edge.id || ""),
          source: String(edge.source || ""),
          target: String(edge.target || ""),
          route: String(edge.route || ""),
          label: String(edge.label || ""),
        }))
      : [],
    digest: String(input.digest || ""),
    created_at: String(input.created_at || ""),
  };
}

export function normalizeManifest(raw: Partial<WorkflowManifest> | null | undefined): WorkflowManifest {
  const input = raw || {};
  return {
    workflow_id: String(input.workflow_id || ""),
    owner_scope: input.owner_scope == null ? undefined : String(input.owner_scope),
    title: String(input.title || "未命名工作流"),
    head_revision: Number(input.head_revision) || 1,
    published_revisions: Array.isArray(input.published_revisions)
      ? input.published_revisions.map(Number).filter((value) => Number.isInteger(value) && value > 0)
      : [],
    active_published_revision:
      input.active_published_revision == null ? null : Number(input.active_published_revision),
    digest: input.digest == null ? undefined : String(input.digest),
    created_at: String(input.created_at || ""),
    updated_at: String(input.updated_at || ""),
  };
}

export function asConfigRecord(value: unknown): Record<string, WorkflowJsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return { ...(value as Record<string, WorkflowJsonValue>) };
}
