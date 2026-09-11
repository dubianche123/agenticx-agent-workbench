import { formatToolDisplayName } from "../components/messages/tool-display-name";

export type GroupMemberActivityState = "idle" | "running" | "replied";

export type GroupMemberActivity = {
  state: GroupMemberActivityState;
  replies: number;
  toolCalls: number;
  lastTs: number;
};

type ActivityMessage = {
  role: string;
  agentId?: string;
  toolName?: string;
  timestamp?: number;
};

type MemberStats = {
  replies: number;
  toolCalls: number;
  lastTs: number;
};

/** `__meta__` is a visible member identity, never an alias for another host. */
export function groupDisplayAgentId(agentId: string, _hostAvatarId?: string): string {
  return String(agentId || "").trim();
}

/** Resolve legacy groups without a persisted host to their first real member. */
export function resolveGroupHostAvatarId(
  avatarIds: string[],
  configuredHostAvatarId?: string,
): string {
  const ids = avatarIds.map((id) => String(id || "").trim()).filter(Boolean);
  const configured = String(configuredHostAvatarId || "").trim();
  return configured && ids.includes(configured) ? configured : ids[0] || "";
}

/** Persistent identity label for the real member selected as group host. */
export function resolveGroupSenderRoleLabel(
  senderAvatarId?: string,
  hostAvatarId?: string,
): string | undefined {
  const senderId = String(senderAvatarId || "").trim();
  const hostId = String(hostAvatarId || "").trim();
  return senderId && hostId && senderId === hostId ? "主持人" : undefined;
}

function aliasesForDisplayAgent(agentId: string, hostAvatarId?: string): string[] {
  void hostAvatarId;
  return [agentId];
}

function tallyMemberStats(
  messages: ActivityMessage[],
  hostAvatarId?: string,
): Map<string, MemberStats> {
  const replies = new Map<string, number>();
  const toolCalls = new Map<string, number>();
  const lastTs = new Map<string, number>();

  for (const msg of messages) {
    const agentId = groupDisplayAgentId(String(msg.agentId ?? ""), hostAvatarId);
    if (!agentId) continue;
    const ts = typeof msg.timestamp === "number" ? msg.timestamp : 0;
    if (msg.role === "assistant") {
      replies.set(agentId, (replies.get(agentId) ?? 0) + 1);
      if (ts >= (lastTs.get(agentId) ?? 0)) lastTs.set(agentId, ts);
    } else if (msg.role === "tool") {
      toolCalls.set(agentId, (toolCalls.get(agentId) ?? 0) + 1);
      if (ts >= (lastTs.get(agentId) ?? 0)) lastTs.set(agentId, ts);
    }
  }

  const out = new Map<string, MemberStats>();
  const ids = new Set([...replies.keys(), ...toolCalls.keys(), ...lastTs.keys()]);
  for (const id of ids) {
    out.set(id, {
      replies: replies.get(id) ?? 0,
      toolCalls: toolCalls.get(id) ?? 0,
      lastTs: lastTs.get(id) ?? 0,
    });
  }
  return out;
}

function statsFor(all: Map<string, MemberStats>, agentId: string): MemberStats {
  return all.get(agentId) ?? { replies: 0, toolCalls: 0, lastTs: 0 };
}

/** 从窗格消息推导每位群成员的真实活动状态（不依赖 LLM 文案）。 */
export function resolveGroupMemberActivity(
  messages: ActivityMessage[],
  avatarIds: string[],
  activeAgentIds?: string[],
  hostAvatarId?: string,
): Map<string, GroupMemberActivity> {
  const active = new Set(
    (activeAgentIds ?? [])
      .map((id) => groupDisplayAgentId(id, hostAvatarId))
      .filter(Boolean),
  );
  const tallied = tallyMemberStats(messages, hostAvatarId);

  const out = new Map<string, GroupMemberActivity>();
  for (const id of avatarIds) {
    const { replies, toolCalls, lastTs } = statsFor(tallied, id);
    let state: GroupMemberActivityState = "idle";
    if (active.has(id)) state = "running";
    else if (replies > 0) state = "replied";
    out.set(id, { state, replies, toolCalls, lastTs });
  }
  return out;
}

export function groupMemberActivityTitle(activity: GroupMemberActivity): string {
  if (activity.state === "running") return "执行中";
  if (activity.state === "replied") return `已回复 ${activity.replies} 次`;
  return "未执行";
}

export type CrewPhase = "idle" | "running" | "waiting" | "replied" | "failed";

export type CrewSlot = {
  agentId: string;
  phase: CrewPhase;
  /** 当前/最近一次动作的人话描述，例如「正在读取 group_router.py」；idle 时为空串 */
  actionText: string;
  /** running 时为「已进行毫秒数」；其余相位为 0 */
  elapsedMs: number;
  replies: number;
  toolCalls: number;
  lastTs: number;
};

export type CrewSlotInput = {
  avatarIds: string[];
  /** 群主持人的可见成员 id。 */
  hostAvatarId?: string;
  messages: ActivityMessage[];
  /** ChatPane groupTyping / groupActivityHint 的并集 key */
  activeAgentIds?: string[];
  /** ChatPane groupActivityHint：agentId → 一行进度文案 */
  activityHintById?: Record<string, string>;
  /** 图 store toolStepsByNode 派生：agentId → 未闭合工具 span */
  runningToolByAgent?: Record<string, { toolName: string; startMs: number }>;
  /** group_blocked / group_error 产生的显式相位覆盖 */
  phaseOverrideById?: Record<string, "waiting" | "failed">;
  /** 便于测试注入 */
  nowMs?: number;
};

function resolveActionText(
  phase: CrewPhase,
  runningTool: { toolName: string; startMs: number } | undefined,
  activityHint: string,
): string {
  if (runningTool) return `正在调用 ${formatToolDisplayName(runningTool.toolName)}`;
  const hint = String(activityHint || "").trim();
  if (hint) return hint;
  if (phase === "waiting") return "等待确认后继续";
  if (phase === "failed") return "执行失败";
  return "";
}

export function resolveCrewSlots(input: CrewSlotInput): CrewSlot[] {
  const active = new Set(
    (input.activeAgentIds ?? [])
      .map((id) => groupDisplayAgentId(id, input.hostAvatarId))
      .filter(Boolean),
  );
  const tallied = tallyMemberStats(input.messages, input.hostAvatarId);
  const nowMs = typeof input.nowMs === "number" ? input.nowMs : Date.now();

  return input.avatarIds.map((agentId) => {
    const { replies, toolCalls, lastTs } = statsFor(tallied, agentId);
    const aliases = aliasesForDisplayAgent(agentId, input.hostAvatarId);
    const runningTool = aliases
      .map((id) => input.runningToolByAgent?.[id])
      .filter((item): item is { toolName: string; startMs: number } => Boolean(item))
      .sort((a, b) => b.startMs - a.startMs)[0];
    const overrides = aliases
      .map((id) => input.phaseOverrideById?.[id])
      .filter((item): item is "waiting" | "failed" => Boolean(item));
    const override = overrides.includes("failed")
      ? "failed"
      : overrides.includes("waiting")
        ? "waiting"
        : undefined;
    const activityHint = aliases
      .map((id) => String(input.activityHintById?.[id] ?? "").trim())
      .find(Boolean) ?? "";

    let phase: CrewPhase = "idle";
    if (override === "waiting" || override === "failed") {
      phase = override;
    } else if (active.has(agentId) || runningTool) {
      phase = "running";
    } else if (replies > 0) {
      phase = "replied";
    }

    const elapsedMs =
      phase === "running" && runningTool
        ? Math.max(0, nowMs - runningTool.startMs)
        : 0;

    return {
      agentId,
      phase,
      actionText: resolveActionText(phase, runningTool, activityHint),
      elapsedMs,
      replies,
      toolCalls,
      lastTs,
    };
  });
}

export function crewPhaseLabel(slot: CrewSlot): string {
  if (slot.phase === "running") return "执行中";
  if (slot.phase === "waiting") return "等待确认";
  if (slot.phase === "failed") return "执行失败";
  if (slot.phase === "replied") return `已回复 ${slot.replies} 次`;
  return "未执行";
}

/** 渲染层覆盖运行图节点状态；idle 返回 null，调用方保留后端原值。 */
export function crewPhaseToGraphStatus(
  phase: CrewPhase,
): "running" | "blocked" | "failed" | "done" | null {
  if (phase === "running") return "running";
  if (phase === "waiting") return "blocked";
  if (phase === "failed") return "failed";
  if (phase === "replied") return "done";
  return null;
}
