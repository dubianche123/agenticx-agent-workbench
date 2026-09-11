import type { GraphNodeSnapshot } from "./graph-types";

/**
 * The workflow dossier is intentionally treated as untrusted snapshot data.
 * Keep this type open so older/newer API versions can add fields without
 * making the panel fail to render.
 */
export type WorkflowAttemptSnapshot = Record<string, unknown> & {
  attempt?: unknown;
  candidate_output?: unknown;
  review_output?: unknown;
  review_status?: unknown;
  review_feedback?: unknown;
  failure_reason?: unknown;
};

export type WorkflowTaskSelection = {
  node: GraphNodeSnapshot;
  /** The projection node that led to this task, when selected in expert view. */
  sourceAgent?: GraphNodeSnapshot;
};

export const WORKFLOW_TEXT_LIMIT = 24_000;
export const WORKFLOW_PREVIEW_LIMIT = 720;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asMeta(node: GraphNodeSnapshot): Record<string, unknown> {
  return isRecord(node.meta) ? node.meta : {};
}

/** Remove an optional graph-node prefix before looking up an avatar id. */
export function normalizeWorkflowAgentId(value: unknown): string {
  return String(value ?? "")
    .trim()
    .replace(/^agent:/, "");
}

/**
 * Convert snapshot values to display text without ever rendering them as
 * React/HTML. Circular or otherwise unserialisable values get a safe marker.
 */
export function formatWorkflowValue(
  value: unknown,
  maxChars = WORKFLOW_TEXT_LIMIT,
): string {
  if (value === null || value === undefined) return "";
  let text = "";
  if (typeof value === "string") {
    text = value;
  } else if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    text = String(value);
  } else {
    try {
      text = JSON.stringify(value, null, 2) ?? "";
    } catch {
      text = "[该内容暂无法展开]";
    }
  }
  return truncateWorkflowText(text, maxChars);
}

/** Keep both the DOM and the visual card bounded for unexpectedly large text. */
export function truncateWorkflowText(
  text: string,
  maxChars = WORKFLOW_TEXT_LIMIT,
): string {
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : WORKFLOW_TEXT_LIMIT;
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n…（内容过长，已截断）`;
}

/** Read only well-formed attempt records from the private node metadata. */
export function readWorkflowAttempts(node: GraphNodeSnapshot): WorkflowAttemptSnapshot[] {
  const raw = asMeta(node).workflow_attempts;
  if (!Array.isArray(raw)) return [];
  return raw.filter(isRecord) as WorkflowAttemptSnapshot[];
}

/**
 * Map selected task nodes, or selected agent projection nodes, back to the
 * actual task snapshots. Projection nodes are not dossiers themselves: their
 * `task_ids` identify the durable task records in the run snapshot.
 */
export function selectWorkflowTaskNodes(
  selectedNodes: GraphNodeSnapshot[],
  taskNodes: GraphNodeSnapshot[],
): WorkflowTaskSelection[] {
  const byId = new Map(
    taskNodes
      .filter((node) => isWorkflowTaskNode(node))
      .map((node) => [node.id, node] as const),
  );
  const seen = new Set<string>();
  const out: WorkflowTaskSelection[] = [];

  const add = (node: GraphNodeSnapshot | undefined, sourceAgent?: GraphNodeSnapshot) => {
    if (!node || !isWorkflowTaskNode(node) || seen.has(node.id)) return;
    seen.add(node.id);
    out.push({ node, sourceAgent });
  };

  for (const selected of selectedNodes) {
    if (isWorkflowTaskNode(selected)) {
      add(selected);
      continue;
    }
    const ids = Array.isArray(selected.task_ids) ? selected.task_ids : [];
    for (const taskId of ids) add(byId.get(String(taskId)), selected);
  }
  return out;
}

export function isWorkflowTaskNode(node: GraphNodeSnapshot | null | undefined): boolean {
  return String(node?.kind || "").toLowerCase() === "task";
}

/** Return a human-readable executor name with id/avatar fallbacks. */
export function resolveWorkflowExecutor(
  node: GraphNodeSnapshot,
  sourceAgent?: GraphNodeSnapshot,
  avatarNames: Record<string, string> = {},
): string {
  const meta = asMeta(node);
  const explicitNameKeys = [
    "executor_name",
    "executorName",
    "worker_name",
    "workerName",
    "assignee_name",
    "assigned_name",
    "executor",
  ];
  for (const key of explicitNameKeys) {
    const name = formatWorkflowValue(meta[key], 240);
    if (name.trim()) return name.trim();
  }

  const rawAgentId =
    meta.executor_id ??
    meta.executorId ??
    meta.worker_id ??
    meta.workerId ??
    meta.assignee_id ??
    node.agent_id;
  const agentId = normalizeWorkflowAgentId(rawAgentId);
  if (agentId) {
    const mapped =
      avatarNames[agentId] ||
      avatarNames[String(rawAgentId ?? "").trim()] ||
      avatarNames[`agent:${agentId}`];
    if (mapped) return mapped;
  }

  const projectionLabel = formatWorkflowValue(sourceAgent?.label, 240).trim();
  if (projectionLabel) return projectionLabel;
  return agentId || "未分配";
}

export function workflowAttemptNumber(
  attempt: WorkflowAttemptSnapshot,
  fallback: number,
): string {
  const raw = formatWorkflowValue(attempt.attempt, 40).trim();
  return raw || String(fallback);
}

/**
 * Newer snapshots may call this field `review_feedback`; older workflow
 * records carry the same information as summary/issues. Preserve both forms.
 */
export function resolveWorkflowReviewFeedback(attempt: WorkflowAttemptSnapshot): string {
  const explicit = formatWorkflowValue(attempt.review_feedback).trim();
  if (explicit) return explicit;

  const summary = formatWorkflowValue(attempt.review_summary).trim();
  const issues = formatWorkflowValue(attempt.review_issues).trim();
  if (summary && issues) return `${summary}\n\n问题与修订建议：\n${issues}`;
  return summary || issues;
}

export function resolveWorkflowFailureReason(
  attempt: WorkflowAttemptSnapshot,
  node: GraphNodeSnapshot,
): string {
  const attemptReason = formatWorkflowValue(attempt.failure_reason).trim();
  if (attemptReason) return attemptReason;
  return formatWorkflowValue(asMeta(node).failure_reason).trim();
}

export function resolveWorkflowTaskText(node: GraphNodeSnapshot): string {
  const taskText = formatWorkflowValue(node.task_text).trim();
  return taskText || formatWorkflowValue(node.label).trim();
}

export function resolveWorkflowStatus(node: GraphNodeSnapshot): string {
  return formatWorkflowValue(node.status || "pending", 120).trim() || "pending";
}

/** Present runtime/review states as product language instead of raw protocol values. */
export function workflowStatusLabel(value: unknown): string {
  const status = formatWorkflowValue(value, 120).trim();
  const normalized = status.toLowerCase();
  const labels: Record<string, string> = {
    pending: "待开始",
    ready: "待开始",
    queued: "排队中",
    running: "进行中",
    paused: "已暂停",
    blocked: "等待处理",
    done: "已完成",
    completed: "已完成",
    success: "已完成",
    failed: "失败",
    cancelled: "已取消",
    canceled: "已取消",
    approved: "审核通过",
    accepted: "审核通过",
    pass: "审核通过",
    passed: "审核通过",
    revise: "需要修改",
    revision_required: "需要修改",
    rejected: "未通过",
  };
  return labels[normalized] || status || "未知状态";
}

/** Used by compact summaries; long task names never widen the dock. */
export function workflowPreviewText(text: string, maxChars = 120): string {
  return truncateWorkflowText(text, maxChars).replace(/\n…（内容过长，已截断）$/, "…");
}
