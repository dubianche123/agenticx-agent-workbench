import {
  aggregateScopesForUser,
  createSessionGrant,
  getAdminUser,
  hasEveryScope,
} from "@agenticx/iam-core";
import { JwtService } from "@agenticx/auth";
import {
  isUnverifiedMutationClaim,
  runAssistantActionLoop,
  type AssistantLoopMessage,
  type AssistantLoopResult,
  type AssistantLoopRequestModel,
} from "@agenticx/action-runtime";
import type { AdminSession } from "../admin-auth";
import { findSupportGuide, linksForSupportPage, suggestionsForSupportPage } from "@agenticx/ui/support/guides";
import { sanitizeSupportContent, SUPPORT_MAX_MESSAGE_CHARS } from "@agenticx/ui/support/contracts";
import type { SupportPageContext } from "@agenticx/ui/support/contracts";
import { sanitizeSupportText } from "./limits";
import {
  listSupportModelsForUser,
  resolveSupportModel,
  splitSupportModelId,
} from "./model-access";
import { ProposalActorMismatchError, ProposalBusyError, ProposalNotFoundError } from "./proposals";
import type { SupportActionAdapter } from "./action-runtime";
import type {
  SupportActor,
  SupportBootstrap,
  SupportChatResponse,
  SupportLink,
  SupportMessage,
  SupportModelOption,
  SupportPage,
  SupportProposal,
} from "./types";

const SUPPORT_TITLE = "后台智能助手";
const MODEL_OUTPUT_MAX_CHARS = SUPPORT_MAX_MESSAGE_CHARS;
const SUPPORT_ACTION_LOOP_TIMEOUT_MS = 30_000;
const DEVELOPMENT_MOCK_MARKERS = ["（开发模式 mock 回复", "(开发模式 mock 回复", "（mock 流式", "(mock 流式"] as const;
const GATEWAY_HEALTH_QUESTION_RE = /(?:网关|gateway).*(?:健康|状态|在线|正常|health|status|up)|(?:健康|状态|在线|正常).*(?:网关|gateway)/iu;
const GATEWAY_HEALTH_LINKS: SupportLink[] = [
  { label: "打开网关工作区", href: "/admin/gateway" },
  { label: "打开诊断", href: "/admin/diagnostics" },
];

async function durableSupportActions() {
  // Keep the server-owned action runtime lazy. Page-help requests should stay
  // available when durable action dependencies are not configured.
  return import("./action-runtime");
}

export class SupportModelNotAllowedError extends Error {
  public readonly code = "40301";
  public constructor() {
    super("selected support model is not available to this administrator");
    this.name = "SupportModelNotAllowedError";
  }
}

export class SupportPermissionError extends Error {
  public readonly code = "40300";
  public constructor(message = "administrator lacks the required support scope") {
    super(message);
    this.name = "SupportPermissionError";
  }
}

export class SupportPrincipalMismatchError extends Error {
  public readonly code = "40903";
  public constructor() {
    super("support assistant identity changed; refresh the support session");
    this.name = "SupportPrincipalMismatchError";
  }
}

export class SupportStaleProposalError extends Error {
  public readonly code = "40901";
  public constructor() {
    super("support proposal is stale; refresh current state and prepare it again");
    this.name = "SupportStaleProposalError";
  }
}

function currentGuide(page: SupportPage) {
  return findSupportGuide(page as SupportPageContext);
}

function boundedChatResponse(response: SupportChatResponse): SupportChatResponse {
  return {
    ...response,
    message: sanitizeSupportText(response.message, SUPPORT_MAX_MESSAGE_CHARS),
  };
}

function hasScope(scopes: readonly string[], required: string[]): boolean {
  return hasEveryScope([...scopes], required);
}

function safeLinkSet(links: readonly SupportLink[]): SupportLink[] {
  return links.slice(0, 6).map((link) => ({ label: sanitizeSupportText(link.label, 100), href: link.href }));
}

export function isGatewayHealthQuestion(question: string): boolean {
  return GATEWAY_HEALTH_QUESTION_RE.test(question.trim());
}

async function answerGatewayHealthAction(
  adapter: SupportActionAdapter,
  signal?: AbortSignal,
): Promise<SupportChatResponse> {
  const actions = await adapter.discover(signal);
  if (!actions.some((action) => action.id === "gateway.health.read" && action.effect === "query")) {
    return boundedChatResponse({
      message: "当前管理员没有网关读取操作权限，无法确认实时健康状态。",
      links: safeLinkSet(GATEWAY_HEALTH_LINKS),
    });
  }
  const result = await adapter.invoke({
    actionId: "gateway.health.read",
    arguments: {},
    idempotencyKey: `support-health-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    ...(signal ? { signal } : {}),
  });
  if (result.status !== "succeeded") {
    return boundedChatResponse({
      message: result.status === "denied"
        ? "当前管理员没有网关读取操作权限，无法确认实时健康状态。"
        : "当前无法确认网关健康状态，请稍后重试。",
      links: safeLinkSet(GATEWAY_HEALTH_LINKS),
    });
  }
  const output = result.output && typeof result.output === "object" && !Array.isArray(result.output)
    ? result.output as Record<string, unknown>
    : {};
  const status = output.status;
  const message = status === "healthy"
    ? "当前网关健康，健康探测返回正常。"
    : status === "unhealthy"
      ? "当前网关处于降级状态，健康探测返回异常。建议打开网关工作区和诊断查看具体通道。"
      : "当前无法连接网关，健康探测超时或失败。建议打开网关工作区和诊断继续排查。";
  return boundedChatResponse({ message, links: safeLinkSet(GATEWAY_HEALTH_LINKS) });
}

export function supportStorageKey(actor: Pick<AdminSession, "tenantId" | "userId">): string {
  return `agenticx-support:v1:admin:${encodeURIComponent(actor.tenantId)}:${encodeURIComponent(actor.userId)}`;
}

function staticHelp(page: SupportPage, reason?: string): SupportChatResponse {
  const match = currentGuide(page);
  const summary = match.tab?.summary ?? match.guide.summary;
  const prefix = reason ? `${reason}\n\n` : "";
  return boundedChatResponse({
    message: `${prefix}${match.guide.title}：${summary}\n\n你可以继续询问当前页面的使用方式，或让我搜索成员、读取成员的模型与额度状态。涉及写入时，我会先给出明确的变更预览。`,
    links: safeLinkSet(linksForSupportPage(page as SupportPageContext)),
  });
}

export async function getSupportBootstrap(session: AdminSession): Promise<SupportBootstrap> {
  const page: SupportPage = { path: "/dashboard" };
  let models: SupportModelOption[] = [];
  try {
    const admin = await getAdminUser(session.tenantId, session.userId);
    if (admin) {
      models = (await listSupportModelsForUser(session.tenantId, admin)).map(({ id, label }) => ({ id, label }));
    }
  } catch (error) {
    console.warn("[support-assistant] bootstrap model list unavailable:", error instanceof Error ? error.message : error);
  }
  const suggestions = suggestionsForSupportPage(page as SupportPageContext);
  return {
    storageKey: supportStorageKey(session),
    title: SUPPORT_TITLE,
    suggestions,
    ...(models.length ? { models } : {}),
  };
}

function safeVisibleModelContent(text: unknown): string {
  const raw = typeof text === "string" ? text : "";
  return sanitizeSupportText(sanitizeSupportContent(raw), MODEL_OUTPUT_MAX_CHARS);
}

function safeMalformedModelResponse(page: SupportPage): SupportChatResponse {
  return staticHelp(page, "模型没有返回可验证的结构化响应；没有执行任何配置变更。");
}

function extractJsonObject(text: string): Record<string, unknown> | null {
  // Providers may wrap an otherwise valid object in an internal reasoning
  // block, which has already been removed by the sanitizer. Accept only an
  // object that occupies the complete visible response, or a complete
  // Markdown fence around that object. Never recover JSON from arbitrary
  // prefix/suffix prose.
  const normalized = sanitizeSupportContent(text).trim();
  const fenced = normalized.match(/^```(?:json)?[ \t]*(?:\r?\n)?([\s\S]*?)(?:\r?\n)?[ \t]*```$/i);
  const candidates = [fenced ? fenced[1]!.trim() : normalized];
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      // Try the next bounded candidate.
    }
  }
  return null;
}

function isDevelopmentMockResponse(text: string, responseId?: unknown): boolean {
  const id = typeof responseId === "string" ? responseId.trim().toLowerCase() : "";
  // Gateway's MockProvider marks completion responses structurally. Prefer
  // that invariant so a real answer discussing mocks is never discarded.
  if (id) return id.startsWith("chatcmpl_mock_") || id.startsWith("chatcmpl_stream_");
  const normalized = text.trim().toLowerCase();
  // Keep a narrow fallback for malformed/local test responses that omit the
  // OpenAI id; require the known placeholder at the beginning rather than
  // searching arbitrary user-visible prose.
  return DEVELOPMENT_MOCK_MARKERS.some((marker) => normalized.startsWith(marker));
}

function rejectDevelopmentMock(text: string, responseId?: unknown): string {
  const normalized = safeVisibleModelContent(text);
  if (isDevelopmentMockResponse(normalized, responseId)) {
    throw new Error("gateway returned a development mock response");
  }
  return normalized;
}

function actionLoopSystemPrompt(page: SupportPage): string {
  const match = currentGuide(page);
  const currentTab = match.tab ? `当前标签：${match.tab.label}。${match.tab.summary}` : "";
  return [
    `你是 AgenticX 企业管理后台的后台智能助手。当前页面是${match.guide.title}（${match.guide.id}），${match.guide.summary} ${currentTab}`,
    "先理解用户问题，再使用当前身份已发现的 enterprise_action；动作结果是唯一事实来源。可以连续查询并根据工具观察补充参数。",
    "任何写入动作只能生成待确认预览，收到 awaiting_confirmation 后立即停止；不得自行确认、声称写入成功，也不得执行删除、密码、角色或权限变更。",
    "页面只是上下文，不要把与当前页面无关的问题强行回答成页面帮助。不得泄露凭据、token、租户或其他成员的未授权信息。",
    "最终回答保持 Markdown 简洁清楚；如果服务端拒绝或报错，明确说明没有完成该操作。",
  ].join("\n");
}

async function issueGatewayAccessToken(
  actor: SupportActor,
  scopes: readonly string[],
): Promise<{ token: string; sessionId: string }> {
  if (!hasScope(scopes, ["workspace:chat"])) throw new SupportPermissionError("当前管理员没有可用于助手推理的模型会话权限");
  const sessionId = `support-${actor.userId}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const jwtService = new JwtService({
    issuer: "agenticx-enterprise-web-portal",
    audience: "agenticx-web-users",
    accessTtlSeconds: 300,
    refreshTtlSeconds: 300,
  });
  const access = await jwtService.signAccessToken({
    userId: actor.userId,
    tenantId: actor.tenantId,
    deptId: actor.deptId ?? null,
    email: actor.email,
    sessionId,
    // The inference credential is deliberately narrower than the admin's
    // complete scope set. The live admin scope check above authorizes issuing
    // it, while Gateway sees only the one capability needed for this request.
    scopes: ["workspace:chat"],
    mustChangePassword: false,
  });
  // With a configured Gateway database this grant is required for the same
  // sid to pass the server's live session-grant check. In file-only dev mode,
  // the JWT's existing workspace:chat scope remains sufficient.
  if (process.env.DATABASE_URL?.trim()) {
    await createSessionGrant({
      tenantId: actor.tenantId,
      sessionId,
      scopes: ["workspace:chat"],
      ttlSeconds: 300,
      createdBy: actor.userId,
      description: "admin support assistant inference",
    });
  }
  return { token: access.token, sessionId };
}

function supportLoopMessages(messages: readonly SupportMessage[]): AssistantLoopMessage[] {
  return messages.flatMap((message) => {
    const content = sanitizeSupportText(
      message.role === "assistant" ? sanitizeSupportContent(message.content) : message.content,
      MODEL_OUTPUT_MAX_CHARS,
    );
    return content ? [{ role: message.role, content } satisfies AssistantLoopMessage] : [];
  });
}

/** OpenAI-compatible transport used only by the server-owned action loop. */
async function createGatewayActionModel(input: {
  actor: SupportActor;
  scopes: readonly string[];
  model: { id: string; model: string; provider: string };
}): Promise<AssistantLoopRequestModel> {
  const { token, sessionId } = await issueGatewayAccessToken(input.actor, input.scopes);
  const gatewayUrl = process.env.GATEWAY_COMPLETIONS_URL?.trim() || "http://127.0.0.1:8088/v1/chat/completions";
  const traceId = `support-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return async ({ messages, tools, signal, maxOutputTokens }) => {
    const response = await fetch(gatewayUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        "x-tenant-id": input.actor.tenantId,
        "x-user-id": input.actor.userId,
        "x-user-email": input.actor.email,
        "x-dept-id": input.actor.deptId ?? "",
        "x-session-id": sessionId,
        "x-agenticx-trace-id": traceId,
        "x-agenticx-trace-stage": "admin.support.action-loop",
        "x-agenticx-provider": input.model.provider,
      },
      body: JSON.stringify({
        model: input.model.model,
        messages,
        tools,
        tool_choice: "auto",
        temperature: 0,
        max_tokens: maxOutputTokens,
        stream: false,
      }),
      signal,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`gateway status ${response.status}`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { content: rejectDevelopmentMock(text) };
    }
    if (!parsed || typeof parsed !== "object") return { content: rejectDevelopmentMock(text) };
    const responseId = (parsed as { id?: unknown }).id;
    const choices = (parsed as { choices?: unknown }).choices;
    const first = Array.isArray(choices) ? choices[0] : null;
    const message = first && typeof first === "object" && (first as { message?: unknown }).message && typeof (first as { message: unknown }).message === "object"
      ? (first as { message: { content?: unknown; tool_calls?: unknown; function_call?: unknown } }).message
      : null;
    if (!message) throw new Error("gateway response missing assistant message");
    const content = typeof message.content === "string" ? safeVisibleModelContent(message.content) : "";
    const rawToolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : message.function_call ? [message.function_call] : [];
    const toolCalls = rawToolCalls.flatMap((raw): Array<{ id?: string; name: string; arguments: unknown }> => {
      if (!raw || typeof raw !== "object") return [];
      const candidate = raw as { id?: unknown; function?: unknown; name?: unknown; arguments?: unknown };
      const fn = candidate.function && typeof candidate.function === "object"
        ? candidate.function as { name?: unknown; arguments?: unknown }
        : candidate;
      if (typeof fn.name !== "string") return [];
      return [{
        ...(typeof candidate.id === "string" ? { id: candidate.id } : {}),
        name: fn.name,
        arguments: fn.arguments,
      }];
    });
    if (isDevelopmentMockResponse(content, responseId)) throw new Error("gateway returned a development mock response");
    if (!content && !toolCalls.length) throw new Error("gateway response missing assistant content");
    return { content, toolCalls };
  };
}

async function currentScopes(actor: SupportActor): Promise<string[]> {
  return aggregateScopesForUser(actor.tenantId, actor.userId);
}

function supportProposalFromActionLoop(result: AssistantLoopResult): SupportProposal | undefined {
  if (result.status !== "awaiting_confirmation" || !result.operationId) return undefined;
  const raw = result.proposal ?? {};
  const title = typeof raw.title === "string" && raw.title.trim() ? raw.title.trim() : "确认企业变更";
  const expiresAt = typeof raw.expiresAt === "string" && raw.expiresAt.trim()
    ? raw.expiresAt
    : new Date(Date.now() + 5 * 60_000).toISOString();
  const value = raw.changes;
  const changes: SupportProposal["changes"] = Array.isArray(value)
    ? value.filter((item): item is SupportProposal["changes"][number] => Boolean(
      item && typeof item === "object"
        && typeof (item as { label?: unknown }).label === "string"
        && typeof (item as { before?: unknown }).before === "string"
        && typeof (item as { after?: unknown }).after === "string",
    ))
    : value && typeof value === "object"
      ? Object.entries(value as Record<string, unknown>).slice(0, 20).map(([label, after]) => ({
        label,
        before: "当前值",
        after: typeof after === "string" ? after : JSON.stringify(after),
      }))
      : [];
  return { id: result.operationId, title, changes, expiresAt };
}

function actionLoopFailureHelp(page: SupportPage, result: AssistantLoopResult): SupportChatResponse {
  const message = result.message.toLowerCase();
  const reason = message.includes("development mock")
    ? "当前没有可用的真实模型推理，以下帮助来自已审核的后台页面指南；没有执行任何配置变更。"
    : result.status === "timed_out"
      ? "智能助手回答超时，以下帮助来自已审核的后台页面指南；没有执行任何配置变更。"
      : result.status === "aborted"
        ? "智能助手请求已取消，以下帮助来自已审核的后台页面指南；没有执行任何配置变更。"
        : "智能助手暂时无法完成请求，以下帮助来自已审核的后台页面指南；没有执行任何配置变更。";
  return staticHelp(page, reason);
}

export async function handleSupportChat(input: {
  actor: AdminSession;
  scopes: readonly string[];
  storageKey: string;
  messages: SupportMessage[];
  page: SupportPage;
  model?: string;
  signal?: AbortSignal;
  actionAdapterOverride?: SupportActionAdapter;
  /** Narrow seam for deterministic server-side transport tests. */
  modelTransportOverride?: AssistantLoopRequestModel;
}): Promise<SupportChatResponse> {
  if (input.storageKey !== supportStorageKey(input.actor)) throw new SupportPrincipalMismatchError();
  const admin = await getAdminUser(input.actor.tenantId, input.actor.userId);
  if (!admin) throw new SupportPermissionError("管理员身份已失效，请重新登录");
  const actor: SupportActor = { ...input.actor, deptId: admin.deptId };
  if (input.storageKey !== supportStorageKey(actor)) throw new SupportPrincipalMismatchError();
  let liveScopes: string[];
  try {
    liveScopes = await currentScopes(actor);
  } catch (error) {
    console.warn("[support-assistant] live scope check unavailable:", error instanceof Error ? error.message : error);
    return staticHelp(input.page, "当前管理员权限暂时无法校验，先提供页面指引；没有执行任何配置变更。");
  }
  const latestQuestion = [...input.messages].reverse().find((message) => message.role === "user")?.content ?? "";
  if (isGatewayHealthQuestion(latestQuestion)) {
    try {
      const adapter = input.actionAdapterOverride
        ?? await (await durableSupportActions()).createSupportActionAdapter(actor);
      return await answerGatewayHealthAction(adapter, input.signal);
    } catch (error) {
      console.warn("[support-assistant] gateway health action unavailable:", error instanceof Error ? error.message : error);
      return staticHelp(input.page, "当前网关读取操作暂时无法校验，以下帮助来自已审核的后台页面指南；没有执行任何配置变更。");
    }
  }
  let resolved: Awaited<ReturnType<typeof resolveSupportModel>>;
  try {
    resolved = await resolveSupportModel(input.actor.tenantId, admin, input.model);
  } catch (error) {
    console.warn("[support-assistant] model policy unavailable:", error instanceof Error ? error.message : error);
    return staticHelp(input.page, "当前模型配置暂时无法读取，先提供页面指引。涉及成员状态的读取请稍后重试。");
  }
  if (input.model && !resolved.selected) throw new SupportModelNotAllowedError();
  if (!resolved.selected) {
    return staticHelp(input.page, "当前管理员没有可用的模型推理配置，以下帮助来自已审核的后台页面指南。");
  }
  if (!hasScope(liveScopes, ["workspace:chat"])) {
    return staticHelp(input.page, "当前管理员没有模型会话权限，以下帮助来自已审核的后台页面指南。");
  }

  const split = splitSupportModelId(resolved.selected.id);
  if (!split) return staticHelp(input.page, "当前模型标识无法解析，以下帮助来自已审核的后台页面指南。");
  let generated = "";
  try {
    // The model may only reach enterprise actions through this server-owned
    // adapter. If capability discovery is unavailable, return reviewed page
    // help instead of falling back to the old typed-intent transport.
    const adapter = input.actionAdapterOverride
      ?? await (await durableSupportActions()).createSupportActionAdapter(actor);
    const requestModel = input.modelTransportOverride ?? await createGatewayActionModel({
      actor,
      scopes: liveScopes,
      model: { ...resolved.selected, ...split },
    });
    const loop = await runAssistantActionLoop({
      messages: [
        { role: "system", content: actionLoopSystemPrompt(input.page) },
        ...supportLoopMessages(input.messages),
      ],
      discover: (signal) => adapter.discover(signal),
      invoke: ({ actionId, arguments: args, idempotencyKey, signal }) => adapter.invoke({
        actionId,
        arguments: args,
        idempotencyKey,
        signal,
      }),
      requestModel,
      ...(input.signal ? { signal: input.signal } : {}),
      limits: { overallTimeoutMs: SUPPORT_ACTION_LOOP_TIMEOUT_MS },
    });

    if (loop.status === "awaiting_confirmation") {
      return boundedChatResponse({
        message: loop.message,
        proposal: supportProposalFromActionLoop(loop),
        links: safeLinkSet(linksForSupportPage(input.page as SupportPageContext)),
      });
    } else if (loop.status === "completed") {
      generated = safeVisibleModelContent(loop.message);
    } else {
      return actionLoopFailureHelp(input.page, loop);
    }
  } catch (error) {
    console.warn("[support-assistant] action loop unavailable:", error instanceof Error ? error.message : error);
    return staticHelp(
      input.page,
      error instanceof Error && error.message === "gateway returned a development mock response"
        ? "当前没有可用的真实模型推理，以下帮助来自已审核的后台页面指南；没有执行任何配置变更。"
        : "智能助手暂时无法连接模型，下面是当前页面的已审核指引；没有执行任何配置变更。",
    );
  }

  // A provider returning the pre-loop JSON intent format is treated as an
  // unverifiable model response. Structured actions must arrive as the
  // enterprise_action function and therefore pass discovery, schema, IAM, and
  // capability-pack checks before this point.
  if (!generated || extractJsonObject(generated)) return boundedChatResponse(safeMalformedModelResponse(input.page));
  if (isUnverifiedMutationClaim(generated)) {
    return staticHelp(input.page, "模型没有返回可验证的响应；没有执行任何配置变更。");
  }
  return boundedChatResponse({
    message: generated,
    links: safeLinkSet(linksForSupportPage(input.page as SupportPageContext)),
  });
}

export async function executeSupportProposal(input: {
  actor: AdminSession;
  proposalId: string;
}): Promise<string> {
  const result = await (await durableSupportActions()).confirmSupportAction({
    actor: input.actor,
    operationId: input.proposalId,
  });
  if (typeof result.userId === "string" && result.userId.trim()) {
    const target = await getAdminUser(input.actor.tenantId, result.userId);
    if (target) return `已完成 ${target.displayName} 的企业配置变更。`;
  }
  return "企业配置变更已完成，并已写入持久化操作记录。";
}

export function supportErrorResponseMessage(error: unknown): { status: number; code: string; message: string } {
  // Keep durable runtime codes stable at this route boundary so callers can
  // distinguish stale authorization from an outcome that needs readback.
  const durableCode = error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code ?? "")
    : "";
  if (durableCode === "ENTERPRISE_CONTEXT_STALE") {
    return { status: 409, code: durableCode, message: "企业授权上下文已变化，请刷新后重试。" };
  }
  if (durableCode === "ASSISTANT_REAUTH_REQUIRED" || durableCode === "ASSISTANT_AUTH_REVOKED" || durableCode === "ASSISTANT_SESSION_REVOKED") {
    const status = error && typeof error === "object" && typeof (error as { status?: unknown }).status === "number"
      ? Number((error as { status: number }).status)
      : 401;
    return { status, code: durableCode, message: "智能助手身份已失效，请重新登录后重试。" };
  }
  if (durableCode.startsWith("ACTION_")) {
    const status = error && typeof error === "object" && typeof (error as { status?: unknown }).status === "number"
      ? Number((error as { status: number }).status)
      : durableCode === "ACTION_FORBIDDEN" ? 403 : durableCode === "ACTION_OPERATION_NOT_FOUND" ? 404 : 400;
    const message = durableCode === "ACTION_OUTCOME_UNKNOWN"
      ? "操作结果暂时无法确认，请先读取当前成员状态后再决定下一步。"
      : durableCode === "ACTION_CONFIRMATION_EXPIRED"
        ? "预览已过期，请重新生成后确认。"
        : durableCode === "ACTION_OPERATION_NOT_FOUND"
          ? "预览已过期或不存在，请重新生成。"
          : durableCode === "ACTION_FORBIDDEN"
            ? "当前管理员没有该成员的操作权限。"
            : "操作请求无效，请刷新后重试。";
    return { status, code: durableCode, message };
  }
  if (error instanceof SupportModelNotAllowedError) return { status: 403, code: error.code, message: "所选模型不在当前管理员的可见范围内，请刷新后重试。" };
  if (error instanceof SupportPrincipalMismatchError) return { status: 409, code: error.code, message: "智能助手身份已变化，请刷新后重试。" };
  if (error instanceof SupportPermissionError) return { status: 403, code: error.code, message: error.message };
  if (error instanceof SupportStaleProposalError) return { status: 409, code: error.code, message: "当前状态已发生变化，请重新读取成员状态并生成预览。" };
  if (error instanceof ProposalActorMismatchError) return { status: 403, code: "40301", message: "该预览属于另一位管理员，不能执行。" };
  if (error instanceof ProposalBusyError) return { status: 409, code: "40902", message: "该预览正在被确认，请稍候查看结果。" };
  if (error instanceof ProposalNotFoundError) return { status: 404, code: "40401", message: "预览已过期、已执行或服务已重启，请重新生成。" };
  return { status: 500, code: "50000", message: "智能助手暂时不可用，请稍后重试。" };
}
