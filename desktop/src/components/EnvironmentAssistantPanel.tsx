import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bot, Check, Loader2, Send, Square, X } from "lucide-react";
import { buildConfirmRequestPresentation } from "./ConfirmDialog";
import { CitationMarkdownBody } from "./messages/CitationMarkdownBody";
import { RUN_MODE_OPTIONS, type RunMode } from "../constants/confirm-strategy-options";
import { useAppStore } from "../store";
import { assistantVisibleBodyForUi } from "../utils/assistant-output";

const PURPOSE = "environment-assistant";
const DISPLAY_NAME = "Meta-Agent · 个人助手";
const PANEL_LABEL = "个人助手";

type PanelProps = {
  open: boolean;
  apiBase: string;
  apiToken: string;
  onClose: () => void;
};

type AssistantMessage = {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  timestamp?: string;
};

type PendingConfirm = {
  requestId: string;
  question: string;
  context?: Record<string, unknown>;
};

type PendingClarification = {
  requestId: string;
  prompt: string;
  options: string[];
  allowFreeText: boolean;
  context?: Record<string, unknown>;
};

type SessionBootstrap = {
  session_id?: string;
  provider?: string | null;
  model?: string | null;
  purpose?: string | null;
  permission_mode?: string | null;
};

type HistoryRow = {
  role?: string;
  content?: unknown;
  timestamp?: unknown;
  id?: unknown;
  message_id?: unknown;
  metadata?: unknown;
  name?: unknown;
  tool_name?: unknown;
  tool_calls?: unknown;
  tool_result_preview?: unknown;
  tool_status?: unknown;
};

type SseFrame = {
  type?: string;
  data?: Record<string, unknown>;
  agent_id?: string;
};

type PanelStatus = "idle" | "loading" | "streaming" | "awaiting_confirm" | "awaiting_input" | "stopping" | "error" | "stopped";

type PersonalAssistantPreflight = {
  session: SessionBootstrap;
  rotated: boolean;
  notice?: string;
};

type EnterpriseAuthorizationPreflightResult = {
  ok?: unknown;
  stale?: unknown;
  code?: unknown;
  error?: unknown;
  message?: unknown;
  authorizationVersion?: unknown;
  authGeneration?: unknown;
};

export type EnterpriseAuthorizationPreflightDecision = {
  action: "keep" | "rotate" | "block";
  reason: "fresh" | "authorization_changed" | "authorization_revoked" | "unavailable";
  observedVersion: string;
  observedGeneration: number | null;
};

const ENTERPRISE_AUTH_REVOCATION_CODES = new Set([
  "ASSISTANT_REAUTH_REQUIRED",
  "ASSISTANT_AUTH_REVOKED",
  "ASSISTANT_SESSION_REVOKED",
  "ENTERPRISE_REAUTH_REQUIRED",
  "ENTERPRISE_AUTH_REVOKED",
  "ENTERPRISE_SESSION_REVOKED",
]);

/**
 * Decide whether an enterprise enriched transcript can be reused.
 *
 * A failed or incomplete preflight is a retryable block. It does not prove
 * that authorization changed, so callers must keep the session and history.
 * Rotation is reserved for an observed version/generation change, an
 * unrecoverable old context, an explicit stale response, or an
 * authentication revocation code.
 */
export function classifyEnterpriseAuthorizationPreflight(
  result: EnterpriseAuthorizationPreflightResult | null | undefined,
  knownVersion: string,
  knownGeneration: number | null,
): EnterpriseAuthorizationPreflightDecision {
  const observedVersion = normalizeEnterpriseAuthorizationVersion(result?.authorizationVersion);
  const rawGeneration = result?.authGeneration;
  const observedGeneration = typeof rawGeneration === "number"
    && Number.isInteger(rawGeneration)
    ? rawGeneration
    : null;
  const code = String(result?.code || "").trim().toUpperCase();
  const generationChanged = knownGeneration !== null
    && observedGeneration !== null
    && knownGeneration !== observedGeneration;
  const versionChanged = Boolean(
    knownVersion
    && observedVersion
    && knownVersion !== observedVersion,
  );
  // The server deliberately refuses to bless a persisted enterprise context
  // whose original authorization version was lost (for example after a
  // legacy restart or an over-aggressive transcript compaction).  A fresh
  // snapshot therefore proves that the old context is unrecoverable, not that
  // it may be reused.
  const unrecoverableContext = !knownVersion && Boolean(observedVersion);
  const explicitlyStale = result?.stale === true
    || code === "ENTERPRISE_CONTEXT_STALE"
    || isEnterpriseContextStaleError(result?.error)
    || isEnterpriseContextStaleError(result?.message);
  if (versionChanged || generationChanged || unrecoverableContext || explicitlyStale) {
    return {
      action: "rotate",
      reason: "authorization_changed",
      observedVersion,
      observedGeneration,
    };
  }
  if (ENTERPRISE_AUTH_REVOCATION_CODES.has(code)) {
    return {
      action: "rotate",
      reason: "authorization_revoked",
      observedVersion,
      observedGeneration,
    };
  }
  if (result?.ok !== true || !observedVersion) {
    return {
      action: "block",
      reason: "unavailable",
      observedVersion,
      observedGeneration,
    };
  }
  return {
    action: "keep",
    reason: "fresh",
    observedVersion,
    observedGeneration,
  };
}

/** Identify the server's stale-context response without trusting its prose. */
export function isEnterpriseContextStaleError(value: unknown): boolean {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const row = value as Record<string, unknown>;
    const code = String(row.code || row.error_code || "").trim().toLowerCase();
    if (code === "enterprise_context_stale") return true;
    return isEnterpriseContextStaleError(row.detail)
      || isEnterpriseContextStaleError(row.error)
      || isEnterpriseContextStaleError(row.message);
  }
  const text = value instanceof Error ? value.message : String(value || "");
  return /(?:^|[^a-z0-9])enterprise_context_stale(?:[^a-z0-9]|$)/i.test(text)
    || text.includes("旧企业上下文缺少可恢复的权限版本");
}

/** Only a stream with a visible final answer may complete successfully. */
export function streamErrorForCompletion(
  streamError: string,
  finalSeen: boolean,
  finalReceived = false,
): string {
  if (finalSeen) return "";
  const error = String(streamError || "").trim();
  if (error) return error;
  if (finalReceived) return "模型流未返回可见答案";
  return "模型流未返回完整答案";
}

export class EnvironmentAssistantStreamTerminalError extends Error {
  readonly terminal = true;

  constructor(message: string) {
    super(message);
    this.name = "EnvironmentAssistantStreamTerminalError";
  }
}

export type EnvironmentAssistantStreamState = {
  finalSeen: boolean;
  finalReceived: boolean;
  streamError: string;
};

export function isEnvironmentAssistantDecisionCurrent(
  expectedGeneration: number,
  currentGeneration: number,
  expectedTurnGeneration: number,
  currentTurnGeneration: number,
  expectedRequestId: string,
  currentRequestId: string | undefined,
  aborted: boolean,
): boolean {
  return (
    expectedGeneration === currentGeneration
    && expectedTurnGeneration === currentTurnGeneration
    && expectedRequestId.trim() !== ""
    && expectedRequestId === String(currentRequestId || "").trim()
    && !aborted
  );
}

/**
 * Keep a delayed history response from applying after its turn, request, or
 * owning controller has been replaced.  History is a state write just like a
 * stream frame, so generation alone is insufficient when Stop starts another
 * operation in the same session.
 */
export function isEnvironmentAssistantHistoryLoadCurrent(
  expectedGeneration: number,
  currentGeneration: number,
  expectedTurnGeneration: number,
  currentTurnGeneration: number,
  expectedRequestId: string,
  currentRequestId: string | undefined,
  expectedController: AbortController | null | undefined,
  currentController: AbortController | null | undefined,
  aborted: boolean,
): boolean {
  return (
    expectedGeneration === currentGeneration
    && expectedTurnGeneration === currentTurnGeneration
    && expectedRequestId.trim() !== ""
    && expectedRequestId === String(currentRequestId || "").trim()
    && expectedController != null
    && expectedController === currentController
    && !aborted
  );
}

export function isEnvironmentAssistantConfirmResponseForPending(
  pendingRequestId: string,
  responseRequestId: string | undefined,
): boolean {
  const pending = pendingRequestId.trim();
  const response = String(responseRequestId || "").trim();
  return Boolean(pending && response && pending === response);
}

export function isEnvironmentAssistantClarificationResponseForPending(
  pendingRequestId: string,
  responseRequestId: string | undefined,
): boolean {
  return isEnvironmentAssistantConfirmResponseForPending(pendingRequestId, responseRequestId);
}

/**
 * Apply the terminal parts of one SSE frame. The visible body is the success
 * signal: a final containing only reasoning tags is still incomplete.
 */
export function reduceEnvironmentAssistantStreamState(
  state: EnvironmentAssistantStreamState,
  frame: SseFrame,
): EnvironmentAssistantStreamState {
  const type = String(frame.type || "").trim();
  const data = frame.data || {};
  if (type === "final") {
    const final = eventText(data).trim();
    const visibleFinal = assistantVisibleBodyForUi(final).trim();
    const next = { ...state, finalReceived: true };
    return visibleFinal
      ? { ...next, finalSeen: true, streamError: "" }
      : next;
  }
  if (type === "error") {
    if (state.finalSeen) return state;
    return {
      ...state,
      streamError: eventText(data, "运行失败"),
    };
  }
  return state;
}

type EnvironmentAssistantStreamConsumeOptions = {
  // The reattach endpoint may legitimately report that the runtime is no
  // longer running with a done-only stream. Foreground /api/chat streams must
  // still contain a visible final answer before they can complete.
  allowDoneWithoutFinal?: boolean;
  shouldHandleFrame?: (frame: SseFrame) => boolean;
};

type EnvironmentAssistantHistoryLoadOptions = {
  signal?: AbortSignal;
  expectedTurnGeneration?: number;
  controller?: AbortController | null;
  currentController?: () => AbortController | null;
  isCurrent?: () => boolean;
};

export function canSetEnvironmentAssistantIdleAfterClarification(
  reattachCompleted: boolean,
  foregroundStreamActive: boolean,
  reattachStreamActive: boolean,
): boolean {
  return reattachCompleted && !foregroundStreamActive && !reattachStreamActive;
}

export function environmentAssistantReattachKeyAfterFailure(
  currentKey: string,
  failedKey: string,
): string {
  return currentKey === failedKey ? "" : currentKey;
}

export function environmentAssistantReattachFailureStatus(
  hasPendingConfirm: boolean,
  hasPendingClarification: boolean,
  staleContext: boolean,
  terminalFailure: boolean,
): PanelStatus {
  if (hasPendingConfirm) return "awaiting_confirm";
  if (hasPendingClarification) return "awaiting_input";
  return staleContext || terminalFailure ? "error" : "streaming";
}

export function environmentAssistantReattachCompletionStatus(
  hasPendingConfirm: boolean,
  hasPendingClarification: boolean,
): "awaiting_confirm" | "awaiting_input" | "idle" {
  if (hasPendingConfirm) return "awaiting_confirm";
  if (hasPendingClarification) return "awaiting_input";
  return "idle";
}

/** Consume the actual SSE reader used by the panel, including terminal fences. */
export async function consumeEnvironmentAssistantSse(
  response: Response,
  onFrame: (frame: SseFrame, state: EnvironmentAssistantStreamState) => void,
  options?: EnvironmentAssistantStreamConsumeOptions,
): Promise<EnvironmentAssistantStreamState> {
  if (!response.body) throw new EnvironmentAssistantStreamTerminalError("模型流没有返回内容");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let state: EnvironmentAssistantStreamState = {
    finalSeen: false,
    finalReceived: false,
    streamError: "",
  };
  let doneReceived = false;

  const dispatch = (frame: SseFrame) => {
    if (options?.shouldHandleFrame && !options.shouldHandleFrame(frame)) return;
    if (String(frame.type || "").trim() === "done") doneReceived = true;
    state = reduceEnvironmentAssistantStreamState(state, frame);
    onFrame(frame, state);
  };
  const consumeBuffer = (flush: boolean) => {
    const chunks = buffer.split(/\r?\n\r?\n/);
    buffer = flush ? "" : (chunks.pop() || "");
    for (const chunk of chunks) {
      const line = chunk
        .split(/\r?\n/)
        .find((item) => item.trimStart().startsWith("data:"));
      if (!line) continue;
      const raw = line.replace(/^\s*data:\s?/, "").trim();
      if (!raw || raw === "[DONE]") continue;
      try {
        const parsed: unknown = JSON.parse(raw);
        if (parsed && typeof parsed === "object") dispatch(parsed as SseFrame);
      } catch {
        // Ignore an incomplete/malformed frame; persisted history is
        // authoritative when the stream closes.
      }
    }
  };

  try {
    while (true) {
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await reader.read();
      } catch (cause) {
        // A successful visible final is authoritative even if the transport
        // fails before it can deliver the trailing done frame. Preserve Abort
        // semantics so an explicit Stop still reaches the caller as stopped.
        if (cause instanceof DOMException && cause.name === "AbortError") throw cause;
        if (!state.finalSeen) throw cause;
        break;
      }
      if (result.done) break;
      buffer += decoder.decode(result.value, { stream: true });
      consumeBuffer(false);
    }
    buffer += decoder.decode();
    consumeBuffer(true);
  } finally {
    reader.releaseLock();
  }
  const terminalError = streamErrorForCompletion(
    state.streamError,
    state.finalSeen,
    state.finalReceived,
  );
  if (
    terminalError
    && !(
      options?.allowDoneWithoutFinal
      && doneReceived
      && !state.streamError
      && !state.finalReceived
    )
  ) throw new EnvironmentAssistantStreamTerminalError(terminalError);
  return state;
}

/** Keep a decision card authoritative while late stream events drain. */
export function pendingFirstStatus(
  hasPendingConfirm: boolean,
  hasPendingClarification: boolean,
): "awaiting_confirm" | "awaiting_input" | "streaming" {
  if (hasPendingConfirm) return "awaiting_confirm";
  if (hasPendingClarification) return "awaiting_input";
  return "streaming";
}

export function isEnvironmentTurnCurrent(
  expectedGeneration: number,
  currentGeneration: number,
  expectedTurnGeneration: number,
  currentTurnGeneration: number,
  aborted: boolean,
): boolean {
  return (
    expectedGeneration === currentGeneration
    && expectedTurnGeneration === currentTurnGeneration
    && !aborted
  );
}

/**
 * Decide whether a cached personal-assistant session can be reused without a
 * server round trip.  Closing the panel, logging in again, or changing the
 * workspace invalidates this warm cache; the server remains authoritative for
 * finding the session belonging to the current opaque scope.
 */
export function shouldReuseEnvironmentAssistantSession({
  sessionId,
  currentScope,
  nextScope,
  forceNewSession,
  needsValidation,
}: {
  sessionId: string;
  currentScope: string;
  nextScope: string;
  forceNewSession: boolean;
  needsValidation: boolean;
}): boolean {
  return Boolean(
    sessionId.trim()
    && currentScope === nextScope
    && !forceNewSession
    && !needsValidation,
  );
}

type EnvironmentConfirmDetails = {
  presentation: ReturnType<typeof buildConfirmRequestPresentation>;
  command: string;
  cwd: string;
  summary: string;
  risk: string;
  sandboxPermissions: string;
  commandPrefix: string;
  workspaceRoots: string[];
};

const STARTERS = [
  {
    label: "诊断当前环境",
    prompt: "请先只读诊断当前工作区的开发环境，告诉我发现的问题和建议，不要修改任何文件。",
  },
  {
    label: "检查能力依赖",
    prompt: "请检查当前工作区声明的能力依赖和锁文件，指出缺失项；需要安装时先给出计划并请求确认。",
  },
  {
    label: "验证模型连接",
    prompt: "请检查当前模型连接是否可用，说明使用的配置和真实结果，不要改变普通聊天会话的模型设置。",
  },
];

const ENTERPRISE_STARTERS = [
  {
    label: "查看我的企业权限",
    prompt: "请查询我当前企业账号可用的权限和操作范围，只读说明结果；不要执行任何变更。",
  },
  {
    label: "查看我的企业额度",
    prompt: "请查询我的企业额度和使用情况，只读说明真实结果；如果当前账号无权查看，请明确告知。",
  },
  {
    label: "说明我的企业配置",
    prompt: "请根据我的企业身份说明当前可用的企业配置和服务范围，只读查询，不要修改任何设置。",
  },
];

function cleanBase(value: string): string {
  return String(value || "").trim().replace(/\/+$/, "");
}

function safeText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function boundedContextText(value: unknown, max = 4_000): string {
  const text = safeText(value).trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Build the reviewable portion of an environment confirmation from the same
 * parser used by the ordinary confirmation dialog.  The command is kept
 * whole; the card constrains its viewport with scrolling instead of silently
 * clipping an approval target.
 */
export function buildEnvironmentConfirmDetails(
  question: string,
  context?: Record<string, unknown>,
): EnvironmentConfirmDetails {
  const source = context || {};
  const roots = Array.isArray(source.workspace_roots)
    ? source.workspace_roots.map((value) => String(value).trim()).filter(Boolean)
    : [];
  return {
    presentation: buildConfirmRequestPresentation(question, source),
    command: typeof source.command === "string" ? source.command : "",
    cwd: typeof source.cwd === "string" ? source.cwd : "",
    summary: boundedContextText(source.summary),
    risk: boundedContextText(source.risk, 2_000),
    sandboxPermissions: boundedContextText(source.sandbox_permissions, 1_000),
    commandPrefix: boundedContextText(source.command_prefix, 2_000),
    workspaceRoots: roots,
  };
}

function eventText(data: Record<string, unknown> | undefined, fallback = ""): string {
  if (!data) return fallback;
  for (const key of ["text", "message", "content", "summary", "question", "prompt"]) {
    const value = data[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return fallback;
}

const MAX_HISTORY_MESSAGE_CHARS = 4_000;
const MAX_HISTORY_TOOL_OUTPUT_CHARS = 360;

function limitHistoryText(value: string, max: number): string {
  const text = String(value || "").trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function historyMetadata(row: HistoryRow): Record<string, unknown> {
  return row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
    ? row.metadata as Record<string, unknown>
    : {};
}

function isInternalHistoryRow(row: HistoryRow): boolean {
  const role = String(row.role || "").trim().toLowerCase();
  if (!["user", "assistant", "tool"].includes(role)) return true;
  const metadata = historyMetadata(row);
  if (metadata.internal === true || metadata.hidden === true) return true;
  const kind = String(metadata.kind || "").trim().toLowerCase();
  if (["system", "internal", "context", "model_context", "compaction", "subagent_summary"].includes(kind)) {
    return true;
  }
  const source = String(metadata.source || "").trim().toLowerCase();
  if (["system", "internal", "model_context"].includes(source)) return true;
  const content = typeof row.content === "string" ? row.content.trim() : "";
  return /^\[(?:system|internal|model[_ -]?context|subagent[_ -]?summary)\]/i.test(content);
}

function extractShellOutput(raw: string): string {
  const match = raw.match(/stdout:\s*\n([\s\S]*?)(?:\nstderr:|$)/i);
  if (match) {
    const stdout = match[1].trim();
    if (stdout && stdout !== "(empty)") return stdout;
    const stderr = raw.match(/stderr:\s*\n([\s\S]*)$/i)?.[1]?.trim() || "";
    if (stderr && stderr !== "(empty)") return stderr;
  }
  return raw;
}

function compactToolOutput(value: unknown): string {
  let raw = safeText(value).trim().replace(/^\[micro-compact[^\]]*\]\s*/i, "");
  if (!raw || raw === "(empty)") return "";
  raw = extractShellOutput(raw).trim();
  if (!raw || raw === "(empty)") return "";
  if (raw.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const object = parsed as Record<string, unknown>;
        for (const key of ["summary", "message", "result", "stdout", "output", "error"]) {
          if (typeof object[key] === "string" && object[key].trim()) {
            return limitHistoryText(extractShellOutput(object[key]), MAX_HISTORY_TOOL_OUTPUT_CHARS);
          }
        }
        return "工具已返回结构化结果。";
      }
    } catch {
      // Keep the bounded plain-text fallback below for partially written output.
    }
  }
  return limitHistoryText(raw, MAX_HISTORY_TOOL_OUTPUT_CHARS);
}

function compactDecisionHistoryContent(row: HistoryRow, metadata: Record<string, unknown>): string {
  const context = metadata.context && typeof metadata.context === "object" && !Array.isArray(metadata.context)
    ? metadata.context as Record<string, unknown>
    : {};
  const kind = String(metadata.kind || context.kind || "").trim().toLowerCase();
  const prompt = String(metadata.prompt || metadata.title || row.content || "").trim();
  if (kind === "clarification" || kind === "action_confirmation") {
    const options = Array.isArray(metadata.options)
      ? metadata.options.map((value) => String(value).trim()).filter(Boolean).slice(0, 8)
      : Array.isArray(context.summary)
        ? context.summary.map((value) => safeText(value).trim()).filter(Boolean).slice(0, 4)
        : [];
    const heading = kind === "action_confirmation" ? "需要确认" : "等待输入";
    const optionText = options.length > 0 ? `\n可选：${options.join("、")}` : "";
    return limitHistoryText(`${heading}：${prompt}${optionText}`, MAX_HISTORY_TOOL_OUTPUT_CHARS);
  }
  return "";
}

function compactToolHistoryContent(row: HistoryRow): string {
  const metadata = historyMetadata(row);
  const decision = compactDecisionHistoryContent(row, metadata);
  if (decision) return decision;
  const toolName = String(row.tool_name || row.name || "").trim();
  const status = String(row.tool_status || "").trim().toLowerCase();
  const label = status === "pending" || status === "running"
    ? `已记录${toolName ? `：${toolName}` : "工具步骤"}`
    : `已完成${toolName ? `：${toolName}` : "工具步骤"}`;
  const output = compactToolOutput(row.tool_result_preview || row.content);
  return output ? `${label}\n${output}` : label;
}

export function parseHistoryRows(raw: unknown): AssistantMessage[] {
  if (!Array.isArray(raw)) return [];
  const result: AssistantMessage[] = [];
  raw.forEach((item, index) => {
    if (!item || typeof item !== "object") return;
    const row = item as HistoryRow;
    if (isInternalHistoryRow(row)) return;
    const rawRole = String(row.role || "").trim().toLowerCase();
    if (rawRole !== "user" && rawRole !== "assistant" && rawRole !== "tool") return;
    const role = rawRole as AssistantMessage["role"];
    const rawContent = safeText(row.content);
    const content = role === "tool"
      ? compactToolHistoryContent(row)
      : limitHistoryText(
        role === "assistant" ? assistantVisibleBodyForUi(rawContent) : rawContent,
        MAX_HISTORY_MESSAGE_CHARS,
      );
    if (!content) return;
    result.push({
      id: String(row.id ?? row.message_id ?? `history-${index}`),
      role,
      content,
      ...(typeof row.timestamp === "string" ? { timestamp: row.timestamp } : {}),
    });
  });
  return result.slice(-120);
}

const ENTERPRISE_TOOL_NAMES = new Set(["enterprise_capabilities", "enterprise_action"]);

function isEnterpriseToolName(value: unknown): boolean {
  return ENTERPRISE_TOOL_NAMES.has(String(value || "").trim());
}

export function normalizeEnterpriseAuthorizationVersion(value: unknown): string {
  if (value == null || typeof value === "boolean") return "";
  if (typeof value !== "string" && typeof value !== "number") return "";
  return String(value).trim().slice(0, 200);
}

function enterpriseAuthorizationVersionFromValue(value: unknown): string {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const source = value as Record<string, unknown>;
    for (const key of ["authorizationVersion", "authorization_version", "authorization_version_id"]) {
      const version = normalizeEnterpriseAuthorizationVersion(source[key]);
      if (version) return version;
    }
    const nested = source.result;
    if (nested && (typeof nested === "object" || typeof nested === "string")) {
      const version = enterpriseAuthorizationVersionFromValue(nested);
      if (version) return version;
    }
  }
  if (typeof value === "string") {
    try {
      return enterpriseAuthorizationVersionFromValue(JSON.parse(value));
    } catch {
      return "";
    }
  }
  return "";
}

function isEnterpriseHistoryRow(row: HistoryRow): boolean {
  const name = String(row.tool_name || row.name || "").trim();
  if (isEnterpriseToolName(name)) return true;
  const metadata = historyMetadata(row);
  if (
    metadata.enterpriseContext === true
    || metadata.has_enterprise_context === true
    || metadata._agx_enterprise_context === true
    || (metadata._agx_enterprise_context && typeof metadata._agx_enterprise_context === "object")
  ) return true;
  const context = metadata.context && typeof metadata.context === "object" && !Array.isArray(metadata.context)
    ? metadata.context as Record<string, unknown>
    : {};
  if (context.enterprise_confirmation === true) return true;
  const calls = row.tool_calls;
  return Array.isArray(calls) && calls.some((call) => (
    call
    && typeof call === "object"
    && !Array.isArray(call)
    && (
      isEnterpriseToolName((call as Record<string, unknown>).name)
      || (
        (call as Record<string, unknown>).function
        && typeof (call as Record<string, unknown>).function === "object"
        && isEnterpriseToolName(
          ((call as Record<string, unknown>).function as Record<string, unknown>).name,
        )
      )
    )
  ));
}

/** Detect prior enterprise material without probing the Portal for pure env turns. */
export function historyHasEnterpriseContext(raw: unknown): boolean {
  if (!Array.isArray(raw)) return false;
  return raw.some((item) => item && typeof item === "object" && isEnterpriseHistoryRow(item as HistoryRow));
}

export function historyEnterpriseAuthorizationVersion(raw: unknown): string {
  if (!Array.isArray(raw)) return "";
  for (const item of [...raw].reverse()) {
    if (!item || typeof item !== "object") continue;
    const row = item as HistoryRow;
    if (!isEnterpriseHistoryRow(row)) continue;
    const metadata = historyMetadata(row);
    const version = enterpriseAuthorizationVersionFromValue(metadata);
    if (version) return version;
    const contentVersion = enterpriseAuthorizationVersionFromValue(row.content);
    if (contentVersion) return contentVersion;
  }
  return "";
}

/** Recover an unanswered, durable confirmation/clarification card after restart. */
export function pendingClarificationFromHistory(raw: unknown): PendingClarification | null {
  if (!Array.isArray(raw)) return null;
  for (const item of [...raw].reverse()) {
    if (!item || typeof item !== "object") continue;
    const row = item as HistoryRow;
    if (String(row.role || "").trim().toLowerCase() !== "tool") continue;
    const metadata = historyMetadata(row);
    const kind = String(metadata.kind || "").trim().toLowerCase();
    if (kind !== "clarification" && kind !== "action_confirmation") continue;
    if (metadata.clarification_answered === true || metadata.suspended === true) continue;
    const requestId = String(metadata.request_id || metadata.id || "").trim();
    const prompt = String(metadata.prompt || row.content || "").trim();
    if (!requestId || !prompt) continue;
    const options = Array.isArray(metadata.options)
      ? metadata.options.map((value) => String(value).trim()).filter(Boolean).slice(0, 8)
      : [];
    const context = metadata.context && typeof metadata.context === "object" && !Array.isArray(metadata.context)
      ? metadata.context as Record<string, unknown>
      : undefined;
    return {
      requestId,
      prompt,
      options,
      allowFreeText: metadata.allow_free_text !== false,
      ...(context ? { context } : {}),
    };
  }
  return null;
}

async function readJsonResponse(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text().catch(() => "");
  if (!text) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return { error: text.slice(0, 500) };
  }
}

export function parseEnvironmentPermissionMode(value: unknown): RunMode | null {
  const mode = typeof value === "string" ? value.trim().toLowerCase() : "";
  return mode === "plan" || mode === "ask" || mode === "auto" ? mode : null;
}

export function isEnvironmentPermissionChangeBlocked(status: PanelStatus): boolean {
  return [
    "loading",
    "streaming",
    "awaiting_confirm",
    "awaiting_input",
    "stopping",
  ].includes(status);
}

const ENVIRONMENT_MARKDOWN_CLASS =
  "msg-content min-w-0 max-w-full overflow-hidden break-words [&_.agx-table-block]:max-w-full [&_.agx-table-block]:min-w-0 [&_.agx-table-block>div]:max-w-full [&_.group]:max-w-full [&_.group]:min-w-0";

export function EnvironmentAssistantPanel({ open, apiBase, apiToken, onClose }: PanelProps) {
  const enterpriseLoggedIn = useAppStore((state) => state.userAccount.loggedIn);
  const accountScope = useAppStore((state) => state.userAccount.feedbackScopeId ?? "");
  const accountGeneration = useAppStore((state) => state.userAccount.feedbackAuthGeneration ?? 0);
  const [messages, setMessages] = useState<AssistantMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState<PanelStatus>("idle");
  const [error, setError] = useState("");
  const [progress, setProgress] = useState<string[]>([]);
  const [streamText, setStreamText] = useState("");
  const [session, setSession] = useState<SessionBootstrap | null>(null);
  const [permissionMode, setPermissionMode] = useState<RunMode>("ask");
  const [permissionSaving, setPermissionSaving] = useState(false);
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(null);
  const [pendingClarification, setPendingClarification] = useState<PendingClarification | null>(null);
  const [clarificationDraft, setClarificationDraft] = useState("");
  const [selectedClarification, setSelectedClarification] = useState<string[]>([]);

  const sessionRef = useRef<SessionBootstrap | null>(null);
  const scopeRef = useRef("");
  const identityRef = useRef("");
  const acquisitionRef = useRef<Promise<SessionBootstrap> | null>(null);
  const bootstrapAbortRef = useRef<AbortController | null>(null);
  const openAbortRef = useRef<AbortController | null>(null);
  const streamAbortRef = useRef<AbortController | null>(null);
  const reattachAbortRef = useRef<AbortController | null>(null);
  const reattachKeyRef = useRef("");
  const reattachCompletedRef = useRef(false);
  const streamTextRef = useRef("");
  const permissionModeRef = useRef<RunMode>("ask");
  const lastPromptRef = useRef("");
  // The panel survives close/reopen so an active backend turn can be
  // reattached.  A reopen still needs one server lookup: the cached SID may
  // have disappeared after a backend restart or may belong to a prior login.
  const sessionNeedsValidationRef = useRef(true);
  const pendingConfirmRef = useRef<PendingConfirm | null>(null);
  const pendingClarificationRef = useRef<PendingClarification | null>(null);
  // A portal confirmation may succeed immediately before the clarify POST is
  // retried after a transient local/backend error. Keep the UI event bound to
  // one operation so a retry never needs to re-confirm an already-consumed
  // operation ticket.
  const enterpriseConfirmedOperationsRef = useRef(new Set<string>());
  // A session that has returned enterprise data must pass a fresh Portal
  // authorization-version check before its next model turn or reattach. Keep
  // this marker local to the panel; pure environment conversations never
  // trigger the check.
  const hasEnterpriseContextRef = useRef(false);
  const enterpriseAuthorizationVersionRef = useRef("");
  const enterpriseAuthGenerationRef = useRef<number | null>(null);
  const forceNewSessionRef = useRef(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const generationRef = useRef(0);
  // A foreground send has its own cancellation generation.  Session bootstrap
  // may be shared with the open effect, so identity generation alone cannot
  // fence a Stop pressed while that bootstrap is still awaiting a response.
  const turnGenerationRef = useRef(0);
  const historyRequestSequenceRef = useRef(0);
  const historyRequestOwnerRef = useRef("");
  const sendAbortRef = useRef<AbortController | null>(null);
  const confirmAbortRef = useRef<AbortController | null>(null);
  const clarificationAbortRef = useRef<AbortController | null>(null);

  const base = useMemo(() => cleanBase(apiBase), [apiBase]);
  const identityKey = `${base}\u0000${apiToken}\u0000${accountScope}\u0000${accountGeneration}`;

  const pushProgress = useCallback((line: string) => {
    const value = String(line || "").trim();
    if (!value) return;
    setProgress((current) => [...current.slice(-5), value]);
  }, []);

  const interruptBackendSession = useCallback(async (sid: string, scope: string) => {
    if (!sid) return;
    try {
      const result = await window.agenticxDesktop.interruptSession(
        sid,
        PURPOSE,
        scope || undefined,
      );
      if (!result.ok) {
        console.warn("[EnvironmentAssistant] old-scope runtime stop failed:", result.error);
      }
    } catch (cause) {
      console.warn("[EnvironmentAssistant] old-scope runtime stop failed:", cause);
    }
  }, []);

  const clearSessionState = useCallback((message = "", options?: { preserveTurn?: boolean }) => {
    const preserveTurn = options?.preserveTurn === true;
    const oldSessionId = String(sessionRef.current?.session_id || "").trim();
    const oldScope = scopeRef.current;
    generationRef.current += 1;
    if (!preserveTurn) {
      turnGenerationRef.current += 1;
      sendAbortRef.current?.abort();
      sendAbortRef.current = null;
    }
    bootstrapAbortRef.current?.abort();
    bootstrapAbortRef.current = null;
    acquisitionRef.current = null;
    historyRequestOwnerRef.current = "";
    streamAbortRef.current?.abort();
    streamAbortRef.current = null;
    reattachAbortRef.current?.abort();
    reattachAbortRef.current = null;
    reattachKeyRef.current = "";
    reattachCompletedRef.current = false;
    confirmAbortRef.current?.abort();
    confirmAbortRef.current = null;
    clarificationAbortRef.current?.abort();
    clarificationAbortRef.current = null;
    acquisitionRef.current = null;
    if (oldSessionId) void interruptBackendSession(oldSessionId, oldScope);
    sessionRef.current = null;
    scopeRef.current = "";
    sessionNeedsValidationRef.current = true;
    permissionModeRef.current = "ask";
    setSession(null);
    setPermissionMode("ask");
    setPermissionSaving(false);
    setMessages([]);
    setDraft("");
    lastPromptRef.current = "";
    setStreamText("");
    streamTextRef.current = "";
    setPendingConfirm(null);
    setPendingClarification(null);
    pendingConfirmRef.current = null;
    pendingClarificationRef.current = null;
    enterpriseConfirmedOperationsRef.current.clear();
    hasEnterpriseContextRef.current = false;
    enterpriseAuthorizationVersionRef.current = "";
    enterpriseAuthGenerationRef.current = null;
    setProgress([]);
    setError(message);
    setStatus(message ? "error" : "idle");
  }, [interruptBackendSession]);

  const resolveScope = useCallback(async () => {
    try {
      const value = await window.agenticxDesktop.getEnvironmentAssistantScope();
      return String(value || "").trim();
    } catch {
      // Server derives a token-scoped fallback when the host callback is not
      // available (older preload/test harness).
      return "";
    }
  }, []);

  const requestHeaders = useCallback(
    (includePurpose = true) => ({
      "x-agx-desktop-token": apiToken,
      ...(includePurpose ? { "x-agx-session-purpose": PURPOSE } : {}),
      ...(scopeRef.current ? { "x-agx-session-scope": scopeRef.current } : {}),
    }),
    [apiToken],
  );

  const updatePermissionMode = useCallback((mode: RunMode) => {
    permissionModeRef.current = mode;
    setPermissionMode(mode);
    setSession((current) => current ? { ...current, permission_mode: mode } : current);
  }, []);

  const readSessionPermissionMode = useCallback(
    async (sid: string): Promise<RunMode> => {
      const response = await fetch(
        `${base}/api/sessions/${encodeURIComponent(sid)}/permissions`,
        { headers: requestHeaders() },
      );
      const body = await readJsonResponse(response);
      if (!response.ok) {
        throw new Error(String(body.detail || body.error || `读取个人助手权限失败（HTTP ${response.status}）`));
      }
      const mode = parseEnvironmentPermissionMode(body.mode);
      if (!mode) throw new Error("服务端返回了无效的个人助手权限模式");
      return mode;
    },
    [base, requestHeaders],
  );

  const loadHistory = useCallback(
    async (
      sid: string,
      expectedGeneration = generationRef.current,
      signal?: AbortSignal,
      options: EnvironmentAssistantHistoryLoadOptions = {},
    ): Promise<boolean> => {
      const expectedTurnGeneration = options.expectedTurnGeneration ?? turnGenerationRef.current;
      const expectedController = options.controller || null;
      const currentController = options.currentController || (() => expectedController);
      const operationIsCurrent = () => (
        generationRef.current === expectedGeneration
        && turnGenerationRef.current === expectedTurnGeneration
        && !signal?.aborted
        && (!options.isCurrent || options.isCurrent())
      );
      // Do not let a stale caller claim the shared history owner after Stop
      // (or after a newer turn has already taken it over).
      if (!operationIsCurrent()) return false;
      const requestId = `history-${++historyRequestSequenceRef.current}`;
      historyRequestOwnerRef.current = requestId;
      const canApply = () => (
        isEnvironmentAssistantHistoryLoadCurrent(
          expectedGeneration,
          generationRef.current,
          expectedTurnGeneration,
          turnGenerationRef.current,
          requestId,
          historyRequestOwnerRef.current,
          expectedController,
          currentController(),
          Boolean(signal?.aborted),
        )
        && operationIsCurrent()
      );
      if (!canApply()) return false;
      const response = await fetch(
        `${base}/api/session/messages?session_id=${encodeURIComponent(sid)}`,
        { headers: requestHeaders(), ...(signal ? { signal } : {}) },
      );
      if (!canApply()) return false;
      if (!response.ok) {
        const body = await readJsonResponse(response);
        if (!canApply()) return false;
        throw new Error(String(body.detail || body.error || `读取会话失败（HTTP ${response.status}）`));
      }
      const body = await readJsonResponse(response);
      if (!canApply()) return false;
      const history = Array.isArray(body.messages) ? body.messages : [];
      // Keep a marker observed from an earlier complete snapshot. Some
      // persistence paths return a compacted/partial history while the
      // private enterprise sidecar remains authoritative.
      hasEnterpriseContextRef.current = hasEnterpriseContextRef.current
        || historyHasEnterpriseContext(history);
      const historyVersion = historyEnterpriseAuthorizationVersion(history);
      if (historyVersion || !enterpriseAuthorizationVersionRef.current) {
        enterpriseAuthorizationVersionRef.current = historyVersion;
      }
      const restoredClarification = pendingClarificationFromHistory(history);
      if (restoredClarification && !pendingClarificationRef.current && !pendingConfirmRef.current) {
        pendingClarificationRef.current = restoredClarification;
        setPendingClarification(restoredClarification);
        setClarificationDraft("");
        setSelectedClarification([]);
        setStatus("awaiting_input");
      }
      setMessages(parseHistoryRows(history));
      return true;
    },
    [base, requestHeaders],
  );

  const ensureSession = useCallback(async (turnSignal?: AbortSignal): Promise<SessionBootstrap> => {
    if (!base || !apiToken) throw new Error("Studio 后端尚未连接");
    if (turnSignal?.aborted) throw new DOMException("environment turn aborted", "AbortError");
    let expectedGeneration = generationRef.current;
    let expectedTurnGeneration = turnGenerationRef.current;
    const nextScope = await resolveScope();
    if (
      turnSignal?.aborted
      || turnGenerationRef.current !== expectedTurnGeneration
    ) throw new DOMException("environment turn aborted", "AbortError");
    if (generationRef.current !== expectedGeneration) {
      throw new Error("登录身份或工作区已变化，请重新打开个人助手。");
    }
    const existing = sessionRef.current;
    if (existing?.session_id && shouldReuseEnvironmentAssistantSession({
      sessionId: existing.session_id,
      currentScope: scopeRef.current,
      nextScope,
      forceNewSession: forceNewSessionRef.current,
      needsValidation: sessionNeedsValidationRef.current,
    })) return existing;
    if (acquisitionRef.current) return acquisitionRef.current;

    const task = (async () => {
      if (existing?.session_id && scopeRef.current !== nextScope) {
        clearSessionState();
        expectedGeneration = generationRef.current;
        expectedTurnGeneration = turnGenerationRef.current;
      }
      if (
        generationRef.current !== expectedGeneration
        || turnGenerationRef.current !== expectedTurnGeneration
      ) {
        throw new Error("登录身份或工作区已变化，请重新打开个人助手。");
      }
      const controller = new AbortController();
      bootstrapAbortRef.current = controller;
      const isCurrentBootstrap = () => (
        generationRef.current === expectedGeneration
        && turnGenerationRef.current === expectedTurnGeneration
        && bootstrapAbortRef.current === controller
        && !controller.signal.aborted
        && !turnSignal?.aborted
      );
      const abortBootstrap = () => controller.abort();
      turnSignal?.addEventListener("abort", abortBootstrap, { once: true });
      try {
        if (!isCurrentBootstrap()) throw new DOMException("environment turn aborted", "AbortError");
        scopeRef.current = nextScope;
        const query = new URLSearchParams({ purpose: PURPOSE });
        const requestedFreshSessionId = forceNewSessionRef.current ? crypto.randomUUID() : "";
        if (requestedFreshSessionId) query.set("session_id", requestedFreshSessionId);
        const response = await fetch(`${base}/api/session?${query.toString()}`, {
          headers: requestHeaders(),
          signal: controller.signal,
        });
        if (!isCurrentBootstrap()) throw new DOMException("environment turn aborted", "AbortError");
        if (!response.ok) {
          const body = await readJsonResponse(response);
          if (!isCurrentBootstrap()) throw new DOMException("environment turn aborted", "AbortError");
          throw new Error(String(body.detail || body.error || `获取个人助手会话失败（HTTP ${response.status}）`));
        }
        const raw = (await readJsonResponse(response)) as SessionBootstrap;
        if (!isCurrentBootstrap()) throw new DOMException("environment turn aborted", "AbortError");
        const sid = String(raw.session_id || "").trim();
        if (!sid || raw.purpose !== PURPOSE) {
          throw new Error("服务端未返回有效的个人助手会话");
        }
        const bootstrapMode = parseEnvironmentPermissionMode(raw.permission_mode);
        if (!bootstrapMode) {
          throw new Error("服务端未返回有效的个人助手权限模式");
        }
        const next = {
          ...raw,
          session_id: sid,
          purpose: PURPOSE,
          permission_mode: bootstrapMode,
        };
        if (!isCurrentBootstrap()) throw new DOMException("environment turn aborted", "AbortError");
        sessionRef.current = next;
        if (requestedFreshSessionId) forceNewSessionRef.current = false;
        setSession(next);
        updatePermissionMode(bootstrapMode);
        const actualMode = await readSessionPermissionMode(sid);
        if (!isCurrentBootstrap()) throw new DOMException("environment turn aborted", "AbortError");
        updatePermissionMode(actualMode);
        const historyLoaded = await loadHistory(sid, expectedGeneration, controller.signal, {
          expectedTurnGeneration,
          controller,
          currentController: () => bootstrapAbortRef.current,
          isCurrent: isCurrentBootstrap,
        });
        if (!historyLoaded || !isCurrentBootstrap()) {
          throw new DOMException("environment turn aborted", "AbortError");
        }
        sessionNeedsValidationRef.current = false;
        return next;
      } finally {
        turnSignal?.removeEventListener("abort", abortBootstrap);
        if (bootstrapAbortRef.current === controller) bootstrapAbortRef.current = null;
      }
    })();
    acquisitionRef.current = task;
    try {
      return await task;
    } finally {
      if (acquisitionRef.current === task) acquisitionRef.current = null;
    }
  }, [
    apiToken,
    base,
    clearSessionState,
    loadHistory,
    readSessionPermissionMode,
    requestHeaders,
    resolveScope,
    updatePermissionMode,
  ]);

  const rotatePersonalSession = useCallback(
    async (
      notice: string,
      turnSignal?: AbortSignal,
      preserveTurn = false,
    ): Promise<SessionBootstrap> => {
      // A fresh server-owned SID prevents the next model context from
      // inheriting a transcript whose enterprise authorization is stale.
      forceNewSessionRef.current = true;
      clearSessionState(notice, { preserveTurn });
      return ensureSession(turnSignal);
    },
    [clearSessionState, ensureSession],
  );

  const preflightEnterpriseAuthorization = useCallback(
    async (
      current: SessionBootstrap,
      turnSignal?: AbortSignal,
    ): Promise<PersonalAssistantPreflight> => {
      const expectedTurnGeneration = turnGenerationRef.current;
      if (!hasEnterpriseContextRef.current) return { session: current, rotated: false };
      const sid = String(current.session_id || "").trim();
      const mode = permissionModeRef.current;
      if (!sid) throw new Error("个人助手企业上下文无有效会话绑定");
      if (
        turnSignal?.aborted
        || turnGenerationRef.current !== expectedTurnGeneration
      ) throw new DOMException("environment turn aborted", "AbortError");
      let result: Awaited<ReturnType<typeof window.agenticxDesktop.enterpriseAssistantPreflight>>;
      try {
        result = await window.agenticxDesktop.enterpriseAssistantPreflight({
          sessionId: sid,
          permissionMode: mode,
        });
      } catch (cause) {
        result = {
          ok: false,
          error: cause instanceof Error ? cause.message : String(cause),
        };
      }
      if (
        turnSignal?.aborted
        || turnGenerationRef.current !== expectedTurnGeneration
      ) throw new DOMException("environment turn aborted", "AbortError");
      const decision = classifyEnterpriseAuthorizationPreflight(
        result,
        enterpriseAuthorizationVersionRef.current,
        enterpriseAuthGenerationRef.current,
      );
      if (decision.action === "rotate") {
        const notice = decision.reason === "authorization_revoked"
          ? "企业登录已失效，请重新登录；旧企业上下文已隔离，已开启新个人助手会话。"
          : "企业权限已更新，旧企业上下文已隔离，已开启新个人助手会话。";
        // Both foreground sends and the open effect carry a turn signal. The
        // session rotation fences identity with generationRef; preserving the
        // turn number keeps a valid caller from invalidating itself while the
        // fresh session is being acquired.
        const preserveTurn = Boolean(turnSignal);
        const fresh = await rotatePersonalSession(notice, turnSignal, preserveTurn);
        enterpriseAuthorizationVersionRef.current = decision.observedVersion;
        enterpriseAuthGenerationRef.current = decision.observedGeneration;
        return { session: fresh, rotated: true, notice };
      }
      if (decision.action === "block") {
        const message = String(result?.message || result?.error || "当前企业权限暂时无法核验，已保留当前会话，请稍后重试。").trim();
        throw new Error(message || "当前企业权限暂时无法核验，已保留当前会话，请稍后重试。");
      }
      if (decision.observedVersion) enterpriseAuthorizationVersionRef.current = decision.observedVersion;
      if (decision.observedGeneration !== null) enterpriseAuthGenerationRef.current = decision.observedGeneration;
      return { session: current, rotated: false };
    },
    [rotatePersonalSession],
  );

  const permissionChangeBlocked = isEnvironmentPermissionChangeBlocked(status);

  const changePermissionMode = useCallback(
    async (nextMode: RunMode) => {
      const requestedMode = parseEnvironmentPermissionMode(nextMode);
      const sid = String(sessionRef.current?.session_id || "").trim();
      if (!requestedMode) {
        setError("无效的个人助手权限模式");
        return;
      }
      if (!sid) {
        setError("个人助手会话尚未就绪，暂时无法保存权限");
        return;
      }
      if (permissionChangeBlocked || permissionSaving) return;

      const expectedGeneration = generationRef.current;
      const previousMode = permissionModeRef.current;
      setPermissionSaving(true);
      setError("");
      try {
        const response = await fetch(
          `${base}/api/sessions/${encodeURIComponent(sid)}/permissions`,
          {
            method: "PUT",
            headers: { ...requestHeaders(), "Content-Type": "application/json" },
            body: JSON.stringify({ mode: requestedMode }),
          },
        );
        const body = await readJsonResponse(response);
        if (!response.ok) {
          throw new Error(String(body.detail || body.error || `保存个人助手权限失败（HTTP ${response.status}）`));
        }
        const writtenMode = parseEnvironmentPermissionMode(body.mode);
        if (!writtenMode) throw new Error("服务端返回了无效的个人助手权限模式");
        // Read back the server-owned value so a partial write or stale response
        // cannot leave the picker claiming a mode the session does not own.
        const actualMode = await readSessionPermissionMode(sid);
        if (generationRef.current !== expectedGeneration) return;
        updatePermissionMode(actualMode);
      } catch (cause: unknown) {
        if (generationRef.current !== expectedGeneration) return;
        let restoredMode = previousMode;
        try {
          restoredMode = await readSessionPermissionMode(sid);
        } catch {
          // The previous local value is the safest visible fallback when the
          // rollback read is unavailable; keep the failure visible below.
        }
        if (generationRef.current !== expectedGeneration) return;
        updatePermissionMode(restoredMode);
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (generationRef.current === expectedGeneration) setPermissionSaving(false);
      }
    },
    [base, permissionChangeBlocked, permissionSaving, readSessionPermissionMode, requestHeaders, updatePermissionMode],
  );

  useEffect(() => {
    if (!identityRef.current) {
      identityRef.current = identityKey;
      return;
    }
    if (identityRef.current !== identityKey) {
      identityRef.current = identityKey;
      // The current renderer stays mounted across an enterprise logout/login.
      // Clear the old transcript and let the open effect below acquire the
      // session for the new identity immediately; waiting for a manual reopen
      // leaves the input in a stale error state.
      clearSessionState();
    }
  }, [clearSessionState, identityKey]);

  // Recheck the host-owned scope while visible.  Workspace selection is owned
  // by Settings/ordinary panes, so it does not necessarily change a React
  // prop; polling this cheap host callback prevents old text and a running
  // old-scope task from surviving an account/workspace switch.  Closing the
  // panel removes the watcher and leaves an active task re-openable.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const checkScope = () => void resolveScope().then((nextScope) => {
      // A transient preload/config read failure returns an empty scope. Keep
      // the current panel alive until the host gives us a concrete replacement
      // rather than treating the temporary absence as a workspace switch.
      if (cancelled || !nextScope || !scopeRef.current || scopeRef.current === nextScope) return;
      clearSessionState();
    });
    checkScope();
    const timer = window.setInterval(checkScope, 1_500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [clearSessionState, open, resolveScope]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, open]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ block: "nearest" });
  }, [messages, progress, streamText, pendingConfirm, pendingClarification]);

  const appendMessage = useCallback((message: AssistantMessage) => {
    setMessages((current) => [...current, message]);
  }, []);

  const consumeStream = useCallback(
    async (
      response: Response,
      controller: AbortController,
      expectedGeneration: number,
      expectedTurnGeneration: number,
      streamOptions: Pick<EnvironmentAssistantStreamConsumeOptions, "allowDoneWithoutFinal"> = {},
    ) => {
      const setStreamStatus = () => {
        setStatus(pendingFirstStatus(
          Boolean(pendingConfirmRef.current),
          Boolean(pendingClarificationRef.current),
        ));
      };
      const handleFrame = (frame: SseFrame, streamState: EnvironmentAssistantStreamState) => {
        // Generation fences account for identity/workspace changes.  The
        // controller fence also prevents a late frame from an aborted
        // reattach/foreground reader from overwriting a newer turn in the
        // same session.
        if (
          generationRef.current !== expectedGeneration
          || turnGenerationRef.current !== expectedTurnGeneration
          || (streamAbortRef.current !== controller && reattachAbortRef.current !== controller)
        ) return;
        const type = String(frame.type || "").trim();
        const data = frame.data || {};
        if (type === "token") {
          const token = String(data.text ?? "").replace(/⏳\s*/g, "");
          if (!token) return;
          streamTextRef.current += token;
          setStreamText(streamTextRef.current);
          setStreamStatus();
          return;
        }
        if (type === "final") {
          const final = eventText(data).trim();
          if (final) {
            // A transport/runtime error can be emitted before the producer
            // recovers and sends its authoritative final answer. Only a final
            // with visible body text is the successful terminal signal.
            if (streamState.finalSeen) setError("");
            streamTextRef.current = final;
            setStreamText(final);
          }
          setStreamStatus();
          return;
        }
        if (type === "tool_call" || type === "tool_call_delta") {
          const name = String(data.name || data.tool_name || "工具").trim();
          if (ENTERPRISE_TOOL_NAMES.has(name)) hasEnterpriseContextRef.current = true;
          pushProgress(`正在执行：${name}`);
          setStreamStatus();
          return;
        }
        if (type === "tool_progress" || type === "progress" || type === "round_start") {
          const label = eventText(data, String(data.name || data.phase || "正在处理"));
          pushProgress(label);
          setStreamStatus();
          return;
        }
        if (type === "tool_result") {
          const name = String(data.name || data.tool_name || "工具").trim();
          if (ENTERPRISE_TOOL_NAMES.has(name)) {
            hasEnterpriseContextRef.current = true;
            const version = enterpriseAuthorizationVersionFromValue(data.result);
            if (version) enterpriseAuthorizationVersionRef.current = version;
          }
          pushProgress(`已完成：${name}`);
          setStreamStatus();
          return;
        }
        if (type === "confirm_required") {
          const requestId = String(data.id || data.request_id || "").trim();
          if (!requestId) return;
          const pending = {
            requestId,
            question: eventText(data, "是否确认执行？"),
            context: data.context && typeof data.context === "object" ? data.context as Record<string, unknown> : undefined,
          };
          pendingConfirmRef.current = pending;
          setPendingConfirm(pending);
          pushProgress("等待你的确认");
          setStatus("awaiting_confirm");
          return;
        }
        if (type === "clarification_required") {
          const requestId = String(data.id || data.request_id || "").trim();
          if (!requestId) return;
          const options = Array.isArray(data.options)
            ? data.options.map((value) => String(value)).filter(Boolean).slice(0, 12)
            : [];
          const pending = {
            requestId,
            prompt: eventText(data, "请补充信息"),
            options,
            allowFreeText: data.allow_free_text !== false,
            context: data.context && typeof data.context === "object" && !Array.isArray(data.context)
              ? data.context as Record<string, unknown>
              : undefined,
          };
          pendingClarificationRef.current = pending;
          setPendingClarification(pending);
          setClarificationDraft("");
          setSelectedClarification([]);
          pushProgress("等待你的输入");
          setStatus("awaiting_input");
          return;
        }
        if (type === "clarification_response") {
          // Reattach may replay a clarification_required from sequence zero
          // before its already-persisted response.  Only the exact current
          // card may be settled; a missing or mismatched id must leave the
          // card actionable rather than accepting another turn's answer.
          const responseRequestId = String(data.request_id || data.id || "").trim();
          const pending = pendingClarificationRef.current;
          if (
            !pending
            || !isEnvironmentAssistantClarificationResponseForPending(
              pending.requestId,
              responseRequestId,
            )
          ) return;
          pendingClarificationRef.current = null;
          setPendingClarification(null);
          setClarificationDraft("");
          setSelectedClarification([]);
          pushProgress("已收到回复，继续执行");
          setStreamStatus();
          return;
        }
        if (type === "confirm_response") {
          // A reattach stream can replay a terminal response from an older
          // reader after the user has already stopped the current turn.  Do
          // not turn that stale event into a visible denial, and require the
          // response to belong to the card that is currently actionable.
          const responseRequestId = String(data.id || data.request_id || "").trim();
          const pending = pendingConfirmRef.current;
          if (!pending || !isEnvironmentAssistantConfirmResponseForPending(pending.requestId, responseRequestId)) {
            return;
          }
          const approved = data.approved === true || data.approved === "true";
          pendingConfirmRef.current = null;
          setPendingConfirm(null);
          pushProgress(approved ? "确认通过，继续执行" : "确认已拒绝");
          setStatus("streaming");
          return;
        }
        if (type === "error") {
          // Ignore a late error after a successful final answer. `done` is
          // still the terminal framing event, but this cannot downgrade a
          // completed answer back into an error banner.
          if (streamState.finalSeen) return;
          const text = eventText(data, "运行失败");
          setError(text);
          if (pendingConfirmRef.current || pendingClarificationRef.current) setStreamStatus();
          else setStatus("error");
          return;
        }
        if (type === "done") {
          // Tool progress is transient.  A terminal frame must not leave the
          // small panel showing a stale "正在处理" line after completion.
          setProgress([]);
          if (!streamState.finalSeen) setStreamStatus();
        }
      };
      await consumeEnvironmentAssistantSse(response, handleFrame, {
        ...streamOptions,
        shouldHandleFrame: () => (
          generationRef.current === expectedGeneration
          && turnGenerationRef.current === expectedTurnGeneration
          && (streamAbortRef.current === controller || reattachAbortRef.current === controller)
        ),
      });
      if (
        generationRef.current !== expectedGeneration
        || turnGenerationRef.current !== expectedTurnGeneration
      ) {
        throw new Error("登录身份或工作区已变化，请重新打开个人助手。");
      }
      if (streamAbortRef.current === controller) streamAbortRef.current = null;
    },
    [pushProgress],
  );

  const reattachStream = useCallback(
    async (sid: string, expectedGeneration: number, expectedTurnGeneration: number) => {
      if (!base || !sid || generationRef.current !== expectedGeneration) return;
      if (turnGenerationRef.current !== expectedTurnGeneration) return;
      if (streamAbortRef.current || reattachAbortRef.current) return;
      const key = `${expectedGeneration}:${sid}`;
      if (reattachKeyRef.current === key) return;

      const controller = new AbortController();
      reattachAbortRef.current = controller;
      reattachCompletedRef.current = false;
      const isCurrentReattach = () => (
        generationRef.current === expectedGeneration
        && turnGenerationRef.current === expectedTurnGeneration
        && reattachAbortRef.current === controller
        && !controller.signal.aborted
      );
      setStatus(pendingFirstStatus(
        Boolean(pendingConfirmRef.current),
        Boolean(pendingClarificationRef.current),
      ));
      try {
        const response = await fetch(
          `${base}/api/sessions/${encodeURIComponent(sid)}/stream`,
          { headers: requestHeaders(), signal: controller.signal },
        );
        if (!isCurrentReattach()) return;
        if (!response.ok) {
          const body = await readJsonResponse(response);
          if (!isCurrentReattach()) return;
          throw new Error(String(body.detail || body.error || `恢复执行流失败（HTTP ${response.status}）`));
        }
        if (!isCurrentReattach()) return;
        reattachKeyRef.current = key;
        await consumeStream(
          response,
          controller,
          expectedGeneration,
          expectedTurnGeneration,
          { allowDoneWithoutFinal: true },
        );
        // consumeStream may settle after Stop (for example after a visible
        // final or done-only reattach).  Require the exact reader owner before
        // loading history or applying any terminal UI state.
        if (!isCurrentReattach()) return;
        const historyLoaded = await loadHistory(sid, expectedGeneration, controller.signal, {
          expectedTurnGeneration,
          controller,
          currentController: () => reattachAbortRef.current,
          isCurrent: isCurrentReattach,
        });
        if (!historyLoaded || !isCurrentReattach()) return;
        setStreamText("");
        streamTextRef.current = "";
        setProgress([]);
        setError("");
        setStatus(environmentAssistantReattachCompletionStatus(
          Boolean(pendingConfirmRef.current),
          Boolean(pendingClarificationRef.current),
        ));
        reattachCompletedRef.current = true;
      } catch (cause: unknown) {
        reattachKeyRef.current = environmentAssistantReattachKeyAfterFailure(
          reattachKeyRef.current,
          key,
        );
        if (!isCurrentReattach()) return;
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        const staleContext = isEnterpriseContextStaleError(cause);
        const terminalFailure = cause instanceof EnvironmentAssistantStreamTerminalError;
        if (staleContext) {
          forceNewSessionRef.current = true;
          sessionNeedsValidationRef.current = true;
        }
        if (!pendingConfirmRef.current && !pendingClarificationRef.current) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
        // A pending card is still actionable when a renderer reconnect
        // briefly fails; keep it and preserve the Stop affordance. A terminal
        // stream failure with no pending card is an error, while a transport
        // failure can keep the runtime's Stop affordance available.
        setStatus(environmentAssistantReattachFailureStatus(
          Boolean(pendingConfirmRef.current),
          Boolean(pendingClarificationRef.current),
          staleContext,
          terminalFailure,
        ));
      } finally {
        if (reattachAbortRef.current === controller) reattachAbortRef.current = null;
      }
    },
    [base, consumeStream, loadHistory, requestHeaders],
  );

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    let expectedGeneration = generationRef.current;
    let expectedTurnGeneration = turnGenerationRef.current;
    const controller = new AbortController();
    openAbortRef.current = controller;
    const isCurrentOpen = () => (
      !cancelled
      && !controller.signal.aborted
      && generationRef.current === expectedGeneration
      && turnGenerationRef.current === expectedTurnGeneration
    );
    void ensureSession(controller.signal)
      .then(async (current) => {
        if (
          cancelled
          || controller.signal.aborted
          || generationRef.current !== expectedGeneration
        ) return;
        // ensureSession may have invalidated a turn while replacing a cached
        // session for a changed scope. Accept that internal transition only
        // while this open request itself is still alive; Stop aborts this
        // controller before it can update the fence.
        expectedTurnGeneration = turnGenerationRef.current;
        if (!isCurrentOpen()) return;
        const preflight = await preflightEnterpriseAuthorization(current, controller.signal);
        if (!isCurrentOpen()) return;
        if (preflight.rotated) expectedGeneration = generationRef.current;
        if (!isCurrentOpen()) return;
        if (preflight.notice) setError(preflight.notice);
        // If the prior renderer disappeared while the backend kept the turn
        // alive, reattach to its real event hub instead of showing history as
        // an idle conversation.  The endpoint is read-only and scoped by the
        // same server-owned purpose/scope headers as chat.
        void reattachStream(
          String(preflight.session.session_id || "").trim(),
          expectedGeneration,
          expectedTurnGeneration,
        );
      })
      .catch((cause: unknown) => {
        if (!isCurrentOpen()) return;
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        if (isEnterpriseContextStaleError(cause)) {
          forceNewSessionRef.current = true;
          sessionNeedsValidationRef.current = true;
        }
        setError(cause instanceof Error ? cause.message : String(cause));
        // A transient authorization preflight failure must leave the durable
        // confirmation/input card actionable while the existing session waits
        // for a retry. Do not turn an unavailable snapshot into a new session.
        if (pendingConfirmRef.current) setStatus("awaiting_confirm");
        else if (pendingClarificationRef.current) setStatus("awaiting_input");
        else setStatus("error");
      });
    return () => {
      cancelled = true;
      controller.abort();
      if (openAbortRef.current === controller) openAbortRef.current = null;
    };
  }, [ensureSession, identityKey, open, preflightEnterpriseAuthorization, reattachStream]);

  // Keep the component mounted across close/reopen so an in-flight backend
  // run can be reattached, but force the next open to resolve the current
  // scope instead of trusting a stale renderer cache.
  useEffect(() => {
    if (!open) sessionNeedsValidationRef.current = true;
  }, [open]);

  const sendMessage = useCallback(
    async (value: string) => {
      const text = String(value || "").trim();
      if (!text || ["loading", "streaming", "awaiting_confirm", "awaiting_input", "stopping"].includes(status)) return;
      let expectedGeneration = generationRef.current;
      const turnGeneration = turnGenerationRef.current + 1;
      turnGenerationRef.current = turnGeneration;
      // Allocate this before session acquisition.  Stop can therefore abort
      // the exact send even when bootstrap has not returned a session id yet.
      const controller = new AbortController();
      sendAbortRef.current = controller;
      const isCurrentTurn = () => (
        isEnvironmentTurnCurrent(
          expectedGeneration,
          generationRef.current,
          turnGeneration,
          turnGenerationRef.current,
          controller.signal.aborted,
        )
      );
      setStatus("loading");
      try {
        let current = await ensureSession(controller.signal);
        if (!isCurrentTurn()) return;
        const preflight = await preflightEnterpriseAuthorization(current, controller.signal);
        if (preflight.rotated) {
          expectedGeneration = generationRef.current;
          current = preflight.session;
        }
        if (!isCurrentTurn()) return;
        // A reconnect stream is only a reader for an already-running turn.
        // Once a new foreground turn is accepted, close that reader so Stop
        // and progress ownership remain unambiguous.
        reattachAbortRef.current?.abort();
        reattachAbortRef.current = null;
        reattachKeyRef.current = "";
        reattachCompletedRef.current = false;
        setDraft("");
        setError(preflight.notice || "");
        setProgress([]);
        pendingConfirmRef.current = null;
        pendingClarificationRef.current = null;
        enterpriseConfirmedOperationsRef.current.clear();
        setPendingConfirm(null);
        setPendingClarification(null);
        lastPromptRef.current = text;
        appendMessage({
          id: `user-${Date.now()}-${Math.random().toString(16).slice(2)}`,
          role: "user",
          content: text,
        });
        streamTextRef.current = "";
        setStreamText("");
        streamAbortRef.current = controller;
        if (!isCurrentTurn()) return;
        const response = await fetch(`${base}/api/chat`, {
          method: "POST",
          signal: controller.signal,
          headers: { ...requestHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({
            session_id: current.session_id,
            user_input: text,
            mode: "interactive",
            client_turn_id: `environment-${crypto.randomUUID()}`,
            keep_runtime_after_disconnect: true,
            meta_leader_display_name: DISPLAY_NAME,
          }),
        });
        if (!response.ok) {
          const body = await readJsonResponse(response);
          throw new Error(String(body.detail || body.error || `发送失败（HTTP ${response.status}）`));
        }
        await consumeStream(response, controller, expectedGeneration, turnGeneration);
        if (!isCurrentTurn()) return;
        const answer = streamTextRef.current.trim();
        const visibleAnswer = assistantVisibleBodyForUi(answer).trim();
        if (visibleAnswer) {
          appendMessage({
            id: `assistant-${Date.now()}-${Math.random().toString(16).slice(2)}`,
            role: "assistant",
            content: visibleAnswer,
          });
        }
        if (!isCurrentTurn()) return;
        const historyLoaded = await loadHistory(String(current.session_id || "").trim(), expectedGeneration, controller.signal, {
          expectedTurnGeneration: turnGeneration,
          controller,
          currentController: () => sendAbortRef.current,
          isCurrent: () => isCurrentTurn() && sendAbortRef.current === controller,
        });
        if (!historyLoaded || !isCurrentTurn()) return;
        setStreamText("");
        streamTextRef.current = "";
        setStatus("idle");
      } catch (cause: unknown) {
        if (generationRef.current !== expectedGeneration || turnGenerationRef.current !== turnGeneration) return;
        if (cause instanceof DOMException && cause.name === "AbortError") {
          setStatus("stopped");
        } else {
          if (isEnterpriseContextStaleError(cause)) {
            // The next explicit user action (retry, or close/reopen) must
            // acquire a fresh session under the current opaque scope. Keep
            // the old transcript visible until that action so this failure is
            // understandable, but never submit another turn to its SID.
            forceNewSessionRef.current = true;
            sessionNeedsValidationRef.current = true;
          }
          setError(cause instanceof Error ? cause.message : String(cause));
          if (pendingConfirmRef.current) setStatus("awaiting_confirm");
          else if (pendingClarificationRef.current) setStatus("awaiting_input");
          else setStatus("error");
        }
      } finally {
        const ownsStream = streamAbortRef.current === controller;
        if (ownsStream) streamAbortRef.current = null;
        if (sendAbortRef.current === controller) sendAbortRef.current = null;
        // A renderer/network disconnect can abort this foreground reader while
        // the backend deliberately keeps the runtime alive.  If the panel was
        // closed during that small window, its open effect has already skipped
        // reattach because this reader still owned the slot.  Retry from here
        // after releasing the slot so a reopen cannot strand a pending confirm
        // or hide the backend Stop affordance.
        if (
          ownsStream
          && controller?.signal.aborted
          && generationRef.current === expectedGeneration
          && turnGenerationRef.current === turnGeneration
          && sessionRef.current?.session_id
        ) {
          void reattachStream(
            String(sessionRef.current.session_id),
            expectedGeneration,
            turnGeneration,
          );
        }
      }
    },
    [appendMessage, base, consumeStream, ensureSession, loadHistory, preflightEnterpriseAuthorization, reattachStream, requestHeaders, status],
  );

  const stop = useCallback(async () => {
    const expectedGeneration = generationRef.current;
    const sid = String(sessionRef.current?.session_id || "").trim();
    const sessionScope = scopeRef.current;
    const hasActiveOperation = Boolean(
      sendAbortRef.current
      || streamAbortRef.current
      || reattachAbortRef.current
      || ["loading", "streaming", "awaiting_confirm", "awaiting_input"].includes(status),
    );
    if (!hasActiveOperation || status === "stopping") return;
    // Invalidate the foreground send before aborting any reader.  This fence
    // also covers the window where ensureSession is still bootstrapping and
    // there is no backend SID to interrupt yet.
    turnGenerationRef.current += 1;
    sendAbortRef.current?.abort();
    sendAbortRef.current = null;
    bootstrapAbortRef.current?.abort();
    bootstrapAbortRef.current = null;
    openAbortRef.current?.abort();
    openAbortRef.current = null;
    historyRequestOwnerRef.current = "";
    setStatus("stopping");
    // Stop the renderer readers immediately, then ask the backend to interrupt
    // this exact dedicated scope.  This keeps a pending confirmation from
    // leaving the button disabled while the network request is in flight.
    streamAbortRef.current?.abort();
    streamAbortRef.current = null;
    reattachAbortRef.current?.abort();
    reattachAbortRef.current = null;
    reattachKeyRef.current = "";
    reattachCompletedRef.current = false;
    confirmAbortRef.current?.abort();
    confirmAbortRef.current = null;
    clarificationAbortRef.current?.abort();
    clarificationAbortRef.current = null;
    pendingConfirmRef.current = null;
    pendingClarificationRef.current = null;
    enterpriseConfirmedOperationsRef.current.clear();
    setPendingConfirm(null);
    setPendingClarification(null);
    setProgress([]);
    setStreamText("");
    streamTextRef.current = "";
    if (!sid) {
      if (generationRef.current === expectedGeneration) setStatus("stopped");
      return;
    }
    try {
      const result = await window.agenticxDesktop.interruptSession(sid, PURPOSE, sessionScope || undefined);
      if (!result.ok) throw new Error(result.error || "中断请求失败");
    } catch (cause: unknown) {
      if (generationRef.current === expectedGeneration) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      if (generationRef.current !== expectedGeneration) return;
      setStatus("stopped");
      // The interrupt endpoint marks the runtime immediately, while its
      // producer still has to finish the checkpoint and persist the final
      // chat snapshot.  Reloading history in this window can replace the
      // local conversation with only the accepted user row, which makes a
      // stopped turn (and any partial answer) appear to disappear.  Keep the
      // current view authoritative until the next normal reconnect reloads
      // the durable snapshot; the backend stop remains scoped to this SID.
    }
  }, [status]);

  const resolveConfirm = useCallback(
    async (approved: boolean) => {
      const expectedGeneration = generationRef.current;
      const expectedTurnGeneration = turnGenerationRef.current;
      const pending = pendingConfirm;
      const sid = String(sessionRef.current?.session_id || "").trim();
      if (!pending || !sid) return;
      if (confirmAbortRef.current) return;
      const requestId = pending.requestId;
      const controller = new AbortController();
      confirmAbortRef.current = controller;
      const isCurrentRequest = () => (
        confirmAbortRef.current === controller
        && isEnvironmentAssistantDecisionCurrent(
          expectedGeneration,
          generationRef.current,
          expectedTurnGeneration,
          turnGenerationRef.current,
          requestId,
          pendingConfirmRef.current?.requestId,
          controller.signal.aborted,
        )
      );
      if (!isCurrentRequest()) {
        if (confirmAbortRef.current === controller) confirmAbortRef.current = null;
        return;
      }
      setStatus("streaming");
      try {
        if (!isCurrentRequest()) return;
        const response = await fetch(`${base}/api/confirm`, {
          method: "POST",
          signal: controller.signal,
          headers: { ...requestHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({ session_id: sid, request_id: requestId, approved, agent_id: "meta" }),
        });
        if (!isCurrentRequest()) return;
        if (!response.ok) {
          if (!isCurrentRequest()) return;
          const body = await readJsonResponse(response);
          if (!isCurrentRequest()) return;
          throw new Error(String(body.detail || body.error || `确认失败（HTTP ${response.status}）`));
        }
        if (!isCurrentRequest()) return;
        pendingConfirmRef.current = null;
        setPendingConfirm(null);
        setError("");
        pushProgress(approved ? "确认通过，继续执行" : "确认已拒绝");
      } catch (cause: unknown) {
        if (!isCurrentRequest()) return;
        setError(cause instanceof Error ? cause.message : String(cause));
        // Keep the card visible so the user can retry or stop the waiting run.
        setStatus("awaiting_confirm");
      } finally {
        if (confirmAbortRef.current === controller) confirmAbortRef.current = null;
      }
    },
    [base, pendingConfirm, pushProgress, requestHeaders],
  );

  const resolveClarification = useCallback(
    async () => {
      const expectedGeneration = generationRef.current;
      const expectedTurnGeneration = turnGenerationRef.current;
      const pending = pendingClarification;
      const sid = String(sessionRef.current?.session_id || "").trim();
      if (!pending || !sid) return;
      if (clarificationAbortRef.current) return;
      const requestId = pending.requestId;
      const controller = new AbortController();
      clarificationAbortRef.current = controller;
      const isCurrentRequest = () => (
        clarificationAbortRef.current === controller
        && isEnvironmentAssistantDecisionCurrent(
          expectedGeneration,
          generationRef.current,
          expectedTurnGeneration,
          turnGenerationRef.current,
          requestId,
          pendingClarificationRef.current?.requestId,
          controller.signal.aborted,
        )
      );
      if (!isCurrentRequest()) {
        if (clarificationAbortRef.current === controller) clarificationAbortRef.current = null;
        return;
      }
      setStatus("streaming");
      try {
        const context = pending.context || {};
        const operationId = String(context.operation_id || "").trim();
        const contextSessionId = String(context.session_id || "").trim();
        const contextAuthGeneration = typeof context.auth_generation === "number"
          && Number.isInteger(context.auth_generation)
          ? context.auth_generation
          : Number.NaN;
        const isEnterpriseConfirmation = context.enterprise_confirmation === true
          && operationId
          && contextSessionId === sid
          && Number.isInteger(contextAuthGeneration);
        // A persisted card may outlive the Electron process that created it.
        // The open-effect preflight records the current host generation; use it
        // for the broker binding so a same-identity restart can recover the
        // operation while the broker still verifies session scope and Portal
        // ownership. If preflight has not completed, retain the card's trusted
        // generation and let main reject a stale binding fail closed.
        const authGeneration = Number.isInteger(enterpriseAuthGenerationRef.current)
          ? Number(enterpriseAuthGenerationRef.current)
          : contextAuthGeneration;
        const approveLabel = String(context.approve_label || "确认执行").trim() || "确认执行";
        const answerText = clarificationDraft.trim().toLowerCase();
        const approvedByUi = selectedClarification.some((value) => {
          const normalized = String(value || "").trim().toLowerCase();
          return normalized === approveLabel.toLowerCase()
            || normalized === "确认"
            || normalized === "同意"
            || normalized === "继续"
            || normalized === "yes"
            || normalized === "y";
        }) || ["确认", "确认执行", "同意", "继续", "yes", "y", "ok"].includes(answerText);
        if (isEnterpriseConfirmation && approvedByUi && !enterpriseConfirmedOperationsRef.current.has(operationId)) {
          // A recovered operation may already have completed while the
          // renderer was closed. Read its server-owned status first so an
          // idempotent confirmation is never assumed or retried blindly.
          if (!isCurrentRequest()) return;
          const existing = await window.agenticxDesktop.enterpriseAssistantGetOperation({
            operationId,
            sessionId: sid,
            permissionMode: permissionModeRef.current,
            authGeneration,
          });
          if (!isCurrentRequest()) return;
          if (!existing?.ok) {
            throw new Error(String(existing?.error || existing?.message || "企业操作状态读取失败"));
          }
          if (existing.status === "failed") {
            throw new Error("企业操作已失败，请重新生成操作预览");
          }
          if (existing.status !== "succeeded") {
            if (!isCurrentRequest()) return;
            const brokerResult = await window.agenticxDesktop.enterpriseAssistantConfirmOperation({
              operationId,
              sessionId: sid,
              permissionMode: permissionModeRef.current,
              authGeneration,
            });
            if (!isCurrentRequest()) return;
            if (!brokerResult?.ok) {
              throw new Error(String(brokerResult?.error || brokerResult?.message || "企业操作确认失败"));
            }
          }
          if (!isCurrentRequest()) return;
          enterpriseConfirmedOperationsRef.current.add(operationId);
        }
        if (!isCurrentRequest()) return;
        const response = await fetch(`${base}/api/clarify`, {
          method: "POST",
          signal: controller.signal,
          headers: { ...requestHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({
            session_id: sid,
            request_id: requestId,
            agent_id: "meta",
            answer_text: pending.allowFreeText ? clarificationDraft.trim() : "",
            selected_options: selectedClarification,
          }),
        });
        if (!isCurrentRequest()) return;
        if (!response.ok) {
          if (!isCurrentRequest()) return;
          const body = await readJsonResponse(response);
          if (!isCurrentRequest()) return;
          throw new Error(String(body.detail || body.error || `提交信息失败（HTTP ${response.status}）`));
        }
        if (!isCurrentRequest()) return;
        pendingClarificationRef.current = null;
        setPendingClarification(null);
        setError("");
        setClarificationDraft("");
        setSelectedClarification([]);
        pushProgress("已提交，继续执行");
        // The reattach reader can finish just before this POST resolves. In
        // that order its completion observes the old card and intentionally
        // leaves the panel waiting; settle the answered card once the completed
        // reader is no longer able to do it for us.
        const reattachHadAlreadyCompleted = canSetEnvironmentAssistantIdleAfterClarification(
          reattachCompletedRef.current,
          Boolean(streamAbortRef.current),
          Boolean(reattachAbortRef.current),
        );
        if (reattachHadAlreadyCompleted) {
          setProgress([]);
          setStatus("idle");
          // A clarification can resume a runtime after the reader that showed
          // the card has already ended. Allow one fresh reader to observe the
          // resumed turn instead of leaving the key pinned to the old stream.
          reattachKeyRef.current = "";
          void reattachStream(sid, expectedGeneration, expectedTurnGeneration);
        }
      } catch (cause: unknown) {
        if (!isCurrentRequest()) return;
        setError(cause instanceof Error ? cause.message : String(cause));
        // Keep the card visible so the user can retry or stop the waiting run.
        setStatus("awaiting_input");
      } finally {
        if (clarificationAbortRef.current === controller) clarificationAbortRef.current = null;
      }
    },
    [base, clarificationDraft, pendingClarification, pushProgress, reattachStream, requestHeaders, selectedClarification],
  );

  const retry = useCallback(() => {
    if (lastPromptRef.current) void sendMessage(lastPromptRef.current);
  }, [sendMessage]);

  if (!open) return null;

  const isBusy = ["loading", "streaming", "awaiting_confirm", "awaiting_input", "stopping"].includes(status);
  const statusLabel = {
    idle: "已就绪",
    loading: "连接中…",
    streaming: "执行中…",
    awaiting_confirm: "等待确认",
    awaiting_input: "等待输入",
    stopping: "正在停止…",
    error: "需要处理",
    stopped: "已停止",
  }[status];
  const permissionOption = RUN_MODE_OPTIONS.find((option) => option.value === permissionMode) || RUN_MODE_OPTIONS[1];
  const emptyStateStarters = enterpriseLoggedIn ? ENTERPRISE_STARTERS : STARTERS;
  const confirmDetails = pendingConfirm
    ? buildEnvironmentConfirmDetails(pendingConfirm.question, pendingConfirm.context)
    : null;

  return (
    <section
      className="agx-environment-assistant-panel fixed right-4 top-14 z-[100] flex h-[min(560px,calc(100vh-5rem))] w-[min(400px,calc(100vw-2rem))] flex-col overflow-hidden rounded-2xl border border-border shadow-2xl"
      aria-label={PANEL_LABEL}
    >
      <header className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[rgba(var(--theme-color-rgb),0.16)] text-[rgb(var(--theme-color-fg-rgb))]">
          <Bot className="h-5 w-5" strokeWidth={1.8} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold text-text-strong">{PANEL_LABEL}</h2>
          <p className="truncate text-[11px] text-text-faint">{DISPLAY_NAME}</p>
        </div>
        <span className="text-[10px] text-text-faint" role="status">{statusLabel}</span>
        <button type="button" onClick={onClose} className="rounded-md p-1.5 text-text-faint hover:bg-surface-hover hover:text-text-strong" aria-label={`关闭${PANEL_LABEL}`} title="关闭">
          <X className="h-4 w-4" />
        </button>
      </header>

      <div className="shrink-0 border-b border-border px-3 py-2.5" aria-label={`${PANEL_LABEL}权限设置`}>
        <div className="flex items-center gap-2">
          <label htmlFor="environment-assistant-permission" className="min-w-0 flex-1 text-[11px] font-medium text-text-muted">
            本个人助手权限
            <span className="ml-1 text-[10px] font-normal text-text-faint">（仅当前会话）</span>
          </label>
          <select
            id="environment-assistant-permission"
            value={permissionMode}
            onChange={(event) => {
              const nextMode = parseEnvironmentPermissionMode(event.target.value);
              if (nextMode) void changePermissionMode(nextMode);
              else setError("无效的个人助手权限模式");
            }}
            disabled={permissionChangeBlocked || permissionSaving || !session?.session_id}
            className="max-w-[7.5rem] rounded-md border border-border bg-surface-base px-2 py-1 text-[11px] text-text-primary outline-none focus:border-[rgb(var(--theme-color-outline-rgb))] disabled:cursor-not-allowed disabled:opacity-60"
            aria-describedby="environment-assistant-permission-help"
          >
            {RUN_MODE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </div>
        <p id="environment-assistant-permission-help" className="mt-1 text-[10px] leading-relaxed text-text-faint">
          {permissionOption.description}{permissionSaving ? " 保存中…" : ""}
        </p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3" aria-live="polite">
        {messages.length === 0 && !streamText && status !== "loading" ? (
          <div className="rounded-xl border border-border bg-surface-card p-3">
            <p className="text-xs leading-relaxed text-text-primary">
              {enterpriseLoggedIn
                ? `我可以根据你的企业身份查询权限、额度和可用配置。只读查询会返回当前真实结果；需要修改时会先说明范围并按“${permissionOption.label}”等待你的确认。`
                : `我可以帮助诊断和配置当前工作区环境。默认先从诊断开始；当前权限为“${permissionOption.label}”，需要修改或安装时会按此设置处理。`}
            </p>
            <div className="mt-3 grid gap-2">
              {emptyStateStarters.map((starter) => (
                <button
                  key={starter.label}
                  type="button"
                  className="rounded-lg border border-border px-3 py-2 text-left text-xs text-text-primary transition-colors hover:border-[rgb(var(--theme-color-outline-rgb))] hover:bg-surface-hover hover:text-text-strong"
                  onClick={() => void sendMessage(starter.prompt)}
                >
                  {starter.label}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        <div className="space-y-3">
          {messages.map((message) => (
            <div key={message.id} className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}>
              <div className={`agx-environment-assistant-message min-w-0 max-w-[90%] rounded-xl px-3 py-2 text-xs leading-relaxed ${message.role === "user" ? "agx-environment-assistant-user-bubble bg-[rgb(var(--theme-color-rgb))] text-[var(--theme-color-text)]" : message.role === "tool" ? "border border-border bg-surface-card text-text-muted" : "bg-surface-card text-text-primary"}`}>
                {message.role === "assistant" ? (
                  <CitationMarkdownBody
                    content={message.content}
                    className={ENVIRONMENT_MARKDOWN_CLASS}
                  />
                ) : message.role === "tool" ? (
                  <pre className="m-0 max-h-40 max-w-full overflow-auto whitespace-pre-wrap break-words text-[10px] leading-relaxed">{message.content}</pre>
                ) : (
                  <div className="whitespace-pre-wrap break-words">{message.content}</div>
                )}
              </div>
            </div>
          ))}
          {progress.length > 0 ? (
            <div className="rounded-lg border border-border bg-surface-card px-3 py-2 text-[11px] text-text-muted" role="status">
              {progress.map((line, index) => <div key={`${line}-${index}`}>{line}</div>)}
            </div>
          ) : null}
          {streamText && assistantVisibleBodyForUi(streamText).trim() ? (
            <div className="flex justify-start">
              <div className="min-w-0 max-w-[90%] rounded-xl bg-surface-card px-3 py-2 text-xs leading-relaxed text-text-primary">
                <CitationMarkdownBody
                  content={assistantVisibleBodyForUi(streamText)}
                  isStreaming={status === "streaming"}
                  className={ENVIRONMENT_MARKDOWN_CLASS}
                />
                {status === "streaming" ? <span className="ml-1 inline-block animate-pulse text-text-faint">▍</span> : null}
              </div>
            </div>
          ) : null}
          {pendingConfirm ? (
            <div className="rounded-xl border border-amber-400/40 bg-amber-400/10 p-3" role="alert">
              <p className="text-xs font-medium text-text-strong">{pendingConfirm.question}</p>
              {confirmDetails ? (
                <div className="mt-2 space-y-2 text-[10px] text-text-faint">
                  {confirmDetails.presentation.summary ? (
                    <div>
                      <div className="font-medium text-text-primary">操作</div>
                      <div>{confirmDetails.presentation.summary}</div>
                    </div>
                  ) : null}
                  {confirmDetails.summary ? (
                    <div>
                      <div className="font-medium text-text-primary">后端摘要</div>
                      <div className="max-h-28 overflow-auto whitespace-pre-wrap break-words">{confirmDetails.summary}</div>
                    </div>
                  ) : null}
                  {confirmDetails.command ? (
                    <div>
                      <div className="font-medium text-text-primary">将执行的完整命令</div>
                      <pre className="m-0 max-h-48 max-w-full overflow-auto rounded-md border border-border bg-surface-base p-2 whitespace-pre text-[10px] leading-relaxed text-text-primary">{confirmDetails.command}</pre>
                    </div>
                  ) : null}
                  {confirmDetails.cwd ? (
                    <div>
                      <div className="font-medium text-text-primary">工作目录</div>
                      <code className="block break-all text-text-primary">{confirmDetails.cwd}</code>
                    </div>
                  ) : null}
                  {confirmDetails.risk || confirmDetails.presentation.riskNotice || confirmDetails.presentation.allowlistScope ? (
                    <div>
                      <div className="font-medium text-text-primary">风险与边界</div>
                      {confirmDetails.risk ? <div className="max-h-24 overflow-auto whitespace-pre-wrap break-words">{confirmDetails.risk}</div> : null}
                      {confirmDetails.presentation.riskNotice ? <div>{confirmDetails.presentation.riskNotice}</div> : null}
                      {confirmDetails.presentation.allowlistScope ? <div className="max-h-20 overflow-auto whitespace-pre-wrap break-words">后续复用范围：{confirmDetails.presentation.allowlistScope}</div> : null}
                      {confirmDetails.sandboxPermissions ? <div>沙箱权限：{confirmDetails.sandboxPermissions}</div> : null}
                      {confirmDetails.commandPrefix ? <div className="break-all">命令范围：{confirmDetails.commandPrefix}</div> : null}
                      {confirmDetails.workspaceRoots.length > 0 ? <div className="break-all">工作区范围：{confirmDetails.workspaceRoots.join("、")}</div> : null}
                    </div>
                  ) : null}
                  {pendingConfirm.context?.diff ? <pre className="max-h-24 max-w-full overflow-auto whitespace-pre-wrap break-words" aria-label="变更摘要">{String(pendingConfirm.context.diff)}</pre> : null}
                </div>
              ) : null}
              <div className="mt-3 flex gap-2">
                <button type="button" className="inline-flex flex-1 items-center justify-center gap-1 rounded-lg bg-emerald-500 px-2 py-1.5 text-xs font-medium text-white hover:bg-emerald-600" onClick={() => void resolveConfirm(true)}><Check className="h-3.5 w-3.5" />确认执行</button>
                <button type="button" className="flex-1 rounded-lg border border-border px-2 py-1.5 text-xs text-text-muted hover:bg-surface-hover" onClick={() => void resolveConfirm(false)}>取消</button>
              </div>
            </div>
          ) : null}
          {pendingClarification ? (
            <div className="rounded-xl border border-[rgba(var(--theme-color-outline-rgb),0.45)] bg-[rgba(var(--theme-color-rgb),0.08)] p-3" role="alert">
              <p className="text-xs font-medium text-text-strong">{pendingClarification.prompt}</p>
              {pendingClarification.options.length > 0 ? (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {pendingClarification.options.map((option) => {
                    const selected = selectedClarification.includes(option);
                    return <button key={option} type="button" className={`rounded-md border px-2 py-1 text-[11px] ${selected ? "border-[rgb(var(--theme-color-outline-rgb))] bg-[rgba(var(--theme-color-rgb),0.16)] text-text-strong" : "border-border text-text-muted hover:bg-surface-hover"}`} onClick={() => setSelectedClarification((current) => selected ? current.filter((item) => item !== option) : [...current, option])}>{option}</button>;
                  })}
                </div>
              ) : null}
              {pendingClarification.allowFreeText ? <textarea value={clarificationDraft} onChange={(event) => setClarificationDraft(event.target.value)} className="mt-2 min-h-16 w-full resize-none rounded-lg border border-border bg-surface-base px-2 py-1.5 text-xs text-text-primary outline-none focus:border-[rgb(var(--theme-color-outline-rgb))]" placeholder="补充信息（可选）" /> : null}
              <button type="button" className="mt-2 w-full rounded-lg bg-[rgb(var(--theme-color-rgb))] px-2 py-1.5 text-xs font-medium text-[var(--theme-color-text)] hover:opacity-90" onClick={() => void resolveClarification()}>提交</button>
            </div>
          ) : null}
          <div ref={messagesEndRef} />
        </div>
      </div>

      {error ? (
        <div className="agx-environment-assistant-error mx-3 mb-2 rounded-lg border px-3 py-2 text-[11px]" role="alert">
          <div>{error}</div>
          {lastPromptRef.current ? <button type="button" className="mt-1 underline" onClick={retry}>重试</button> : null}
        </div>
      ) : null}
      <footer className="shrink-0 border-t border-border p-3">
        <div className="flex items-end gap-2 rounded-xl border border-border bg-surface-base p-2 focus-within:border-[rgb(var(--theme-color-outline-rgb))]">
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void sendMessage(draft);
              }
            }}
            disabled={isBusy}
            rows={2}
            className="min-h-10 flex-1 resize-none bg-transparent px-1 py-1 text-xs text-text-primary outline-none placeholder:text-text-faint disabled:opacity-60"
            placeholder="询问个人助手…"
            aria-label={`${PANEL_LABEL}输入`}
          />
          {isBusy ? (
            <button type="button" onClick={() => void stop()} className="rounded-lg bg-rose-500 p-2 text-white hover:bg-rose-600" aria-label={`停止${PANEL_LABEL}`} title="停止">
              {status === "stopping" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Square className="h-4 w-4" />}
            </button>
          ) : (
            <button type="button" onClick={() => void sendMessage(draft)} disabled={!draft.trim()} className="rounded-lg bg-[rgb(var(--theme-color-rgb))] p-2 text-[var(--theme-color-text)] hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40" aria-label="发送">
              <Send className="h-4 w-4" />
            </button>
          )}
        </div>
        <p className="mt-1.5 text-[10px] text-text-faint">Enter 发送 · Shift+Enter 换行 · 关闭后保留进度</p>
      </footer>
    </section>
  );
}
