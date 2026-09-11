import type { GraphSsePayload } from "../components/graph/graph-types";

export const GROUP_COORDINATOR_AGENT_ID = "__meta__";

export type GroupRunningResumeAction = "restart" | "keep-running" | "reattach";

export type GroupWorkflowDetailEffect =
  | {
      kind: "show_processing";
      agentId: string;
      avatarName: string;
      activity: string;
    }
  | { kind: "clear_member"; agentId: string }
  | { kind: "clear_all" }
  | null;

const text = (value: unknown) => String(value ?? "").trim();
const normalizedEventToken = (value: unknown) =>
  text(value).toLowerCase().replace(/[\s.-]+/g, "_");

const GROUP_WORKFLOW_CLEAR_EVENTS = new Set([
  "candidate_output",
  "review_output",
  "task_completed",
  "task_failed",
  "task_skipped",
]);

/**
 * Normalize the event envelope emitted by the group stream's graph bridge.
 * Graph events are intentionally kept on their `graph.*` lane so the existing
 * Graph Store can consume them; only the transport wrapper is unwrapped here.
 */
export function normalizeGroupGraphPayload(
  type: string,
  rawData: unknown,
): GraphSsePayload {
  const normalizedType = text(type);
  const data =
    rawData && typeof rawData === "object" && !Array.isArray(rawData)
      ? (rawData as Record<string, unknown>)
      : undefined;
  const rawContent = data?.content;
  if (typeof rawContent === "string" && rawContent.trim().startsWith("{")) {
    try {
      const inner = JSON.parse(rawContent) as unknown;
      if (inner && typeof inner === "object" && !Array.isArray(inner)) {
        const payload = inner as Record<string, unknown>;
        return {
          ...payload,
          type: normalizedType || text(payload.type),
        } as GraphSsePayload;
      }
    } catch {
      // Keep the original content below when the bridge payload is partial.
    }
    return { type: normalizedType, content: rawContent };
  }
  return {
    ...(data ?? {}),
    type: normalizedType || text(data?.type),
  } as GraphSsePayload;
}

/**
 * Classify the private `group_workflow_detail` lane for the lightweight room
 * status row.  The detail event is deliberately not a chat message: candidate
 * and review bodies stay in the project panel while the room only reflects
 * whether its corresponding member is still working.
 */
export function resolveGroupWorkflowDetailEffect(
  raw: unknown,
): GroupWorkflowDetailEffect {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const data = raw as Record<string, unknown>;
  const detailKind = normalizedEventToken(data.detail_kind ?? data.detailKind);
  const workflowEvent = normalizedEventToken(
    data.workflow_event_type ??
      data.workflowEventType ??
      data.workflow_event ??
      data.event_type ??
      data.action_type ??
      data.action,
  );
  const agentId = text(data.agent_id ?? data.agentId);

  if (workflowEvent === "workforce_stopped" || detailKind === "workforce_stopped") {
    return { kind: "clear_all" };
  }

  if (GROUP_WORKFLOW_CLEAR_EVENTS.has(detailKind) || GROUP_WORKFLOW_CLEAR_EVENTS.has(workflowEvent)) {
    return agentId ? { kind: "clear_member", agentId } : null;
  }

  if (
    workflowEvent === "task_started" ||
    workflowEvent === "runtime_progress" ||
    detailKind === "task_started" ||
    detailKind === "runtime_progress"
  ) {
    if (!agentId) return null;
    const avatarName = text(data.avatar_name ?? data.avatarName) || agentId;
    const workflowRole = text(data.workflow_role ?? data.workflowRole).toLowerCase();
    const rolePrefix =
      workflowRole === "reviewer"
        ? "审核中："
        : workflowRole === "executor"
          ? "执行中："
          : "";
    const progress = text(
      data.content ?? data.text ?? data.progress_text ?? data.progressText,
    );
    const activity =
      workflowEvent === "task_started" || detailKind === "task_started"
        ? "正在处理…"
        : progress && !/^开始处理任务/.test(progress) && !/^已接收任务/.test(progress)
          ? `${rolePrefix}${progress}`
          : `${rolePrefix}正在处理…`;
    return { kind: "show_processing", agentId, avatarName, activity };
  }

  return null;
}

/**
 * A member starting to speak is an explicit hand-off from the coordinator.
 * Keeping both rows active makes a sequential room look parallel and leaves
 * the coordinator spinner behind after the discussion has already moved on.
 */
export function shouldHandoffGroupCoordinator(activeAgentId: string): boolean {
  const normalized = String(activeAgentId || "").trim();
  return Boolean(normalized && normalized !== GROUP_COORDINATOR_AGENT_ID);
}

export function withoutGroupAgent<T>(
  state: Record<string, T>,
  agentId: string,
): Record<string, T> {
  if (!(agentId in state)) return state;
  const next = { ...state };
  delete next[agentId];
  return next;
}

/**
 * Planning/decomposition events are room status, not things the host actually
 * said. Keep them in the single ephemeral activity row instead of turning every
 * state transition into a durable-looking chat bubble.
 */
export function groupCoordinatorActivityText(
  action: string,
  discussionMode: boolean,
): string | null {
  switch (String(action || "").trim()) {
    case "workforce_started":
      return discussionMode ? "正在组织讨论…" : "正在规划团队任务…";
    case "decompose_start":
      return discussionMode ? "正在整理讨论视角…" : "正在拆解任务…";
    case "decompose_complete":
    case "task_created":
    case "task_assigned":
      return "正在安排合适的成员…";
    default:
      return null;
  }
}

/** A visible assignment must read like a real room hand-off and never clip it. */
export function formatGroupWorkforceHandoff(
  memberName: string,
  description: string,
): string {
  const name = String(memberName || "").trim() || "成员";
  const task = String(description || "").trim() || "请开始处理这个工作项。";
  return `按职责分工，@${name}：${task}`;
}

/**
 * "Resume" must never restart an active group turn. Reconnect when possible;
 * otherwise leave the backend run untouched and let the normal disk poll catch
 * up. An explicit Stop remains the only way to replace a running discussion.
 */
export function resolveGroupRunningResumeAction(input: {
  isGroupPane: boolean;
  executionState: string;
  hasForegroundStream: boolean;
  liveReattachEnabled: boolean;
}): GroupRunningResumeAction {
  if (!input.isGroupPane || input.executionState !== "running") return "restart";
  if (!input.hasForegroundStream && input.liveReattachEnabled) return "reattach";
  return "keep-running";
}
