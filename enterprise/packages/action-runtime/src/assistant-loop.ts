import type { JsonObject, PublicAction } from "./types";

/**
 * Provider-neutral messages used by the support assistant loop.  Adapters are
 * responsible for translating these messages to their provider wire format;
 * the loop itself never imports a model SDK or a UI contract.
 */
export type AssistantLoopMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: readonly AssistantLoopWireToolCall[];
};

export type AssistantLoopWireToolCall = {
  id: string;
  type: "function";
  function: {
    /** Tool responses are untrusted; the loop accepts the provider name and validates it. */
    name: string;
    arguments: string;
  };
};

export type AssistantActionToolDefinition = {
  type: "function";
  function: {
    name: "enterprise_action";
    description: string;
    parameters: JsonObject;
  };
};

export type AssistantLoopToolCall = {
  id?: string;
  name: string;
  /** A provider may return JSON text or an already decoded object. */
  arguments: unknown;
};

export type AssistantModelResponse = {
  content?: string | null;
  toolCalls?: readonly AssistantLoopToolCall[];
  finishReason?: string | null;
};

export type AssistantActionInvocation = {
  actionId: string;
  arguments: JsonObject;
  idempotencyKey: string;
  signal: AbortSignal;
};

export type AssistantActionInvocationResult =
  | {
      status: "succeeded";
      output?: unknown;
      operationId?: string;
    }
  | {
      status: "awaiting_confirmation";
      proposal: JsonObject;
      operationId: string;
    }
  | {
      status: "invalid" | "denied" | "failed";
      error: {
        code: string;
        message: string;
      };
    };

export type AssistantLoopLimits = {
  maxTurns: number;
  maxActions: number;
  maxMutationProposals: number;
  maxObservationChars: number;
  maxObservationCount: number;
  overallTimeoutMs: number;
  maxOutputTokens: number;
};

export const DEFAULT_ASSISTANT_LOOP_LIMITS: Readonly<AssistantLoopLimits> = Object.freeze({
  maxTurns: 6,
  maxActions: 12,
  maxMutationProposals: 1,
  maxObservationChars: 8_192,
  maxObservationCount: 24,
  overallTimeoutMs: 30_000,
  maxOutputTokens: 32_768,
});

export type AssistantLoopRequestModel = (input: {
  messages: readonly AssistantLoopMessage[];
  tools: readonly AssistantActionToolDefinition[];
  signal: AbortSignal;
  maxOutputTokens: number;
}) => Promise<AssistantModelResponse>;

export type AssistantLoopInput = {
  messages: readonly AssistantLoopMessage[];
  discover: (signal: AbortSignal) => Promise<readonly PublicAction[]>;
  invoke: (input: AssistantActionInvocation) => Promise<AssistantActionInvocationResult>;
  requestModel: AssistantLoopRequestModel;
  signal?: AbortSignal;
  limits?: Partial<AssistantLoopLimits>;
  /** Prefix used to make every invocation idempotent inside one loop. */
  requestId?: string;
};

export type AssistantActionObservation = {
  actionId: string | null;
  status: AssistantActionInvocationResult["status"] | "invalid";
  code?: string;
  message: string;
  output?: unknown;
  operationId?: string;
};

export type AssistantLoopResult = {
  status: "completed" | "awaiting_confirmation" | "limit_reached" | "timed_out" | "aborted" | "failed";
  message: string;
  messages: readonly AssistantLoopMessage[];
  observations: readonly AssistantActionObservation[];
  actionsInvoked: number;
  turns: number;
  mutationProposals: number;
  proposal?: JsonObject;
  operationId?: string;
};

const ENTERPRISE_ACTION_NAME = "enterprise_action" as const;
const DEFAULT_OBSERVATION_MESSAGE = "action observation unavailable";
/**
 * These forms claim that this assistant performed a mutation.  A sentence
 * that merely reports an existing state is handled separately below so a
 * successful read can ground it without allowing a fabricated write result.
 */
const UNVERIFIED_MUTATION_CLAIM_RE = /(?:(?:已(?:经)?\s*)?(?:为你|帮你|替你)[\s\S]{0,32}(?:设置|配置|修改|更新|变更|写入|保存|应用|生成|创建|分配|调整|改为)|已(?:经)?\s*(?:把|将)[\s\S]{0,32}(?:设置|配置|修改|更新|变更|写入|保存|应用|生成|创建|分配|调整|改为)|已(?:经)?\s*(?:成功(?:地)?\s*)?(?:完成|执行|生成|创建|设置|配置|分配|写入|保存|更新|变更|应用)[\s\S]{0,24}(?:额度|配置|设置|模型|预览|变更|修改|更新|写入|保存|操作)|(?:预览|变更|修改|更新|写入|保存|操作)[\s\S]{0,12}(?:生成|创建|成功|完成|已生效|应用)|(?:我|我们|助手|智能助手)[\s\S]{0,24}(?:已(?:经)?\s*)?(?:设置|配置|修改|更新|变更|写入|保存|应用|生成|创建|分配|调整|改为|configured|assigned|updated|saved|changed|applied|created|generated|set)|(?:successfully|already|I have|we have|I just|we just)\s+(?:configured|assigned|updated|saved|changed|applied|created|generated|set)\b|(?:I|we|the assistant)\s+(?:have|has|just|successfully)?\s*(?:configured|assigned|updated|saved|changed|applied|created|generated|set)\b)/iu;
const EXISTING_STATE_CLAIM_RE = /(?:(?:当前|目前|现在|现有|已有)?[\s\S]{0,24}(?:配置|模型|额度|设置)[\s\S]{0,12}(?:已(?:经)?|目前(?:已)?|当前(?:已)?|现在(?:已)?)(?:生成|创建|完成|设置|配置|分配|写入|保存|更新|生效|应用)|(?:配置|模型|额度|设置)[\s\S]{0,12}(?:成功|完成|已生效)|(?:configuration|model|quota|settings?)\s+(?:(?:is|was|has been|are|were)\s+)?(?:ready|complete|completed|applied|saved|updated|configured|set|done)\b)/iu;

/**
 * Model prose cannot prove a configuration mutation. The only trusted write
 * result is the ActionRuntime confirmation operation, which the loop projects
 * as `awaiting_confirmation` and returns immediately.
 */
export function isUnverifiedMutationClaim(message: string): boolean {
  return UNVERIFIED_MUTATION_CLAIM_RE.test(message);
}

function hasUnverifiedExistingStateClaim(message: string, hasSuccessfulQueryEvidence: boolean): boolean {
  return !hasSuccessfulQueryEvidence && EXISTING_STATE_CLAIM_RE.test(message);
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function limitsFrom(input?: Partial<AssistantLoopLimits>): AssistantLoopLimits {
  const source = input ?? {};
  return {
    maxTurns: positiveInteger(source.maxTurns, DEFAULT_ASSISTANT_LOOP_LIMITS.maxTurns),
    maxActions: positiveInteger(source.maxActions, DEFAULT_ASSISTANT_LOOP_LIMITS.maxActions),
    maxMutationProposals: positiveInteger(source.maxMutationProposals, DEFAULT_ASSISTANT_LOOP_LIMITS.maxMutationProposals),
    maxObservationChars: positiveInteger(source.maxObservationChars, DEFAULT_ASSISTANT_LOOP_LIMITS.maxObservationChars),
    maxObservationCount: positiveInteger(source.maxObservationCount, DEFAULT_ASSISTANT_LOOP_LIMITS.maxObservationCount),
    overallTimeoutMs: positiveInteger(source.overallTimeoutMs, DEFAULT_ASSISTANT_LOOP_LIMITS.overallTimeoutMs),
    maxOutputTokens: positiveInteger(source.maxOutputTokens, DEFAULT_ASSISTANT_LOOP_LIMITS.maxOutputTokens),
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asJsonObject(value: unknown): JsonObject | null {
  return isObject(value) ? value : null;
}

function boundedText(value: unknown, maxChars: number): string {
  if (typeof value === "string") return value.slice(0, maxChars);
  try {
    const serialized = JSON.stringify(value);
    return (serialized ?? DEFAULT_OBSERVATION_MESSAGE).slice(0, maxChars);
  } catch {
    return DEFAULT_OBSERVATION_MESSAGE;
  }
}

function boundedOutput(value: unknown, maxChars: number): unknown {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value.length <= maxChars ? value : value.slice(0, maxChars);
  try {
    const serialized = JSON.stringify(value);
    if (serialized && serialized.length <= maxChars) return value;
    return { truncated: true, preview: (serialized ?? DEFAULT_OBSERVATION_MESSAGE).slice(0, maxChars) };
  } catch {
    return { truncated: true, preview: DEFAULT_OBSERVATION_MESSAGE };
  }
}

function modelContent(response: AssistantModelResponse): string {
  return typeof response.content === "string" ? response.content.trim() : "";
}

function errorMessage(error: unknown): string {
  if (error && typeof error === "object") {
    const candidate = error as { message?: unknown; code?: unknown };
    if (typeof candidate.message === "string" && candidate.message.trim()) return candidate.message.trim();
    if (typeof candidate.code === "string" && candidate.code.trim()) return candidate.code.trim();
  }
  return "action failed";
}

function randomRequestId(): string {
  const cryptoObject = globalThis.crypto as Crypto | undefined;
  if (cryptoObject && typeof cryptoObject.randomUUID === "function") return cryptoObject.randomUUID();
  return `assistant-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function actionTools(actions: readonly PublicAction[]): AssistantActionToolDefinition[] {
  const boundedActions = actions.slice(0, 100);
  const actionIds = boundedActions.map((action) => action.id);
  if (!actionIds.length) return [];
  const actionSchemas = boundedActions.map((action) => ({
    ...action.inputSchema,
    ...(typeof action.inputSchema.description === "string"
      ? {}
      : { description: action.description }),
  }));
  // Keep one provider-compatible function, but bind each action id to its
  // exact argument schema at the envelope level.  This matters when multiple
  // actions accept the same (including empty) object: an argument-only oneOf
  // would otherwise reject a valid object because it matches more than one
  // branch.
  const envelopeVariants = boundedActions.map((action, index) => ({
    type: "object",
    additionalProperties: false,
    properties: {
      actionId: { type: "string", enum: [action.id] },
      arguments: actionSchemas[index] ?? { type: "object" },
    },
    required: ["actionId", "arguments"],
  }));
  const actionGuide = boundedActions
    .map((action) => `${action.id}: ${action.label}。${action.description}`)
    .join("\n")
    .slice(0, 12_000);
  return [{
    type: "function",
    function: {
      name: ENTERPRISE_ACTION_NAME,
      description: `调用当前身份已获授权的企业动作。arguments 必须符合所选 actionId 的真实参数 schema。\n${actionGuide}`.slice(0, 16_000),
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          actionId: { type: "string", enum: actionIds },
          // All ActionRuntime public actions accept object arguments.  The
          // envelope variants below provide the action-specific constraints.
          arguments: { type: "object" },
        },
        required: ["actionId", "arguments"],
        oneOf: envelopeVariants,
      },
    },
  }];
}

function observationPayload(observation: AssistantActionObservation, maxChars: number): string {
  return boundedText({
    actionId: observation.actionId,
    status: observation.status,
    ...(observation.code ? { code: observation.code } : {}),
    message: observation.message,
    ...(observation.output === undefined ? {} : { output: observation.output }),
    ...(observation.operationId ? { operationId: observation.operationId } : {}),
  }, maxChars);
}

function wireToolCall(call: AssistantLoopToolCall): AssistantLoopWireToolCall {
  const id = typeof call.id === "string" && call.id.trim() ? call.id.trim() : `call-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let args: string;
  if (typeof call.arguments === "string") args = call.arguments;
  else {
    try {
      args = JSON.stringify(call.arguments) ?? "";
    } catch {
      args = "";
    }
  }
  return {
    id,
    type: "function",
    // The conversation sent back to the provider must contain the one tool
    // name advertised in `actionTools`. Preserve the untrusted source name in
    // the local call record so it can still be rejected below.
    function: { name: ENTERPRISE_ACTION_NAME, arguments: args },
  };
}

function awaitAbortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("assistant loop cancelled"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error("assistant loop cancelled"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function parseToolArguments(value: unknown): { ok: true; value: JsonObject } | { ok: false; message: string } {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return { ok: false, message: "arguments must be valid JSON" };
    }
  }
  const object = asJsonObject(parsed);
  return object ? { ok: true, value: object } : { ok: false, message: "arguments must be a JSON object" };
}

function abortedStatus(signal: AbortSignal, deadlineExpired: boolean): "timed_out" | "aborted" | null {
  if (!signal.aborted) return null;
  return deadlineExpired ? "timed_out" : "aborted";
}

function terminalAbortResult(
  status: "timed_out" | "aborted",
  messages: readonly AssistantLoopMessage[],
  observations: readonly AssistantActionObservation[],
  actionsInvoked: number,
  turns: number,
  mutationProposals: number,
): AssistantLoopResult {
  return {
    status,
    message: status === "timed_out" ? "智能助手回答超时，尚未完成请求。" : "智能助手请求已取消，尚未完成请求。",
    messages,
    observations,
    actionsInvoked,
    turns,
    mutationProposals,
  };
}

/**
 * Run one bounded model/action exchange.  The callback boundaries are the
 * security boundary: discovery and invocation stay server-owned while model
 * output is treated as untrusted input and is validated again by ActionRuntime.
 */
export async function runAssistantActionLoop(input: AssistantLoopInput): Promise<AssistantLoopResult> {
  const limits = limitsFrom(input.limits);
  const parentSignal = input.signal ?? new AbortController().signal;
  const deadline = new AbortController();
  const onParentAbort = () => deadline.abort(parentSignal.reason);
  let deadlineExpired = false;
  const timer = setTimeout(() => {
    deadlineExpired = true;
    deadline.abort(new Error("assistant loop deadline exceeded"));
  }, limits.overallTimeoutMs);
  if (parentSignal.aborted) deadline.abort(parentSignal.reason);
  else parentSignal.addEventListener("abort", onParentAbort, { once: true });

  const conversation: AssistantLoopMessage[] = [...input.messages];
  const observations: AssistantActionObservation[] = [];
  let actionsInvoked = 0;
  let turns = 0;
  let mutationProposals = 0;
  let successfulQueryEvidence = false;
  const unresolved = new Map<string, AssistantActionObservation>();
  const requestId = input.requestId?.trim() || randomRequestId();

  try {
    const initialAbort = abortedStatus(deadline.signal, deadlineExpired);
    if (initialAbort) return terminalAbortResult(initialAbort, conversation, observations, actionsInvoked, turns, mutationProposals);

    let actions: readonly PublicAction[];
    try {
      actions = await awaitAbortable(input.discover(deadline.signal), deadline.signal);
    } catch (error) {
      return {
        status: abortedStatus(deadline.signal, deadlineExpired) ?? "failed",
        message: abortedStatus(deadline.signal, deadlineExpired) === "timed_out" ? "智能助手回答超时，尚未读取可用操作。" : `当前无法读取可用操作：${boundedText(errorMessage(error), 240)}`,
        messages: conversation,
        observations,
        actionsInvoked,
        turns,
        mutationProposals,
      };
    }
    const permittedActions = Array.isArray(actions)
      ? actions.filter((action) => Boolean(action && typeof action.id === "string" && action.id.trim()))
      : [];
    const permittedIds = new Set(permittedActions.map((action) => action.id));
    const permittedById = new Map(permittedActions.map((action) => [action.id, action]));
    const tools = actionTools(permittedActions);

    while (turns < limits.maxTurns) {
      const abortBeforeModel = abortedStatus(deadline.signal, deadlineExpired);
      if (abortBeforeModel) return terminalAbortResult(abortBeforeModel, conversation, observations, actionsInvoked, turns, mutationProposals);
      if (actionsInvoked >= limits.maxActions) {
        return {
          status: "limit_reached",
          message: "智能助手已达到本次操作次数上限，请缩小问题范围后重试。",
          messages: conversation,
          observations,
          actionsInvoked,
          turns,
          mutationProposals,
        };
      }

      turns += 1;
      let response: AssistantModelResponse;
      try {
        response = await awaitAbortable(input.requestModel({
          messages: conversation,
          tools,
          signal: deadline.signal,
          maxOutputTokens: limits.maxOutputTokens,
        }), deadline.signal);
      } catch (error) {
        const abortStatus = abortedStatus(deadline.signal, deadlineExpired);
        if (abortStatus) return terminalAbortResult(abortStatus, conversation, observations, actionsInvoked, turns, mutationProposals);
        return {
          status: "failed",
          message: `智能助手暂时无法获取模型回答：${boundedText(errorMessage(error), 240)}`,
          messages: conversation,
          observations,
          actionsInvoked,
          turns,
          mutationProposals,
        };
      }

      const toolCalls = Array.isArray(response.toolCalls) ? response.toolCalls : [];
      const text = modelContent(response);
      if (!toolCalls.length) {
        if (unresolved.size) {
          const failures = [...unresolved.values()]
            .slice(-3)
            .map((item) => `${item.actionId ?? "enterprise_action"}：${item.message}`)
            .join("；");
          return {
            status: "completed",
            message: `服务端未完成请求中的一项操作。${boundedText(failures, 800)}`,
            messages: conversation,
            observations,
            actionsInvoked,
            turns,
            mutationProposals,
          };
        }
        if (isUnverifiedMutationClaim(text) || hasUnverifiedExistingStateClaim(text, successfulQueryEvidence)) {
          return {
            status: "completed",
            message: "服务端没有验证配置变更，未执行任何写入。",
            messages: conversation,
            observations,
            actionsInvoked,
            turns,
            mutationProposals,
          };
        }
        const finalMessage = text || "智能助手没有返回可读答案，请换一种方式描述问题。";
        conversation.push({ role: "assistant", content: finalMessage });
        return {
          status: "completed",
          message: finalMessage,
          messages: conversation,
          observations,
          actionsInvoked,
          turns,
          mutationProposals,
        };
      }

      const calls = toolCalls.map((call) => ({ wire: wireToolCall(call), sourceName: call.name }));
      conversation.push({ role: "assistant", content: text || null, tool_calls: calls.map(({ wire }) => wire) });

      for (const { wire: call, sourceName } of calls) {
        if (actionsInvoked >= limits.maxActions) break;
        actionsInvoked += 1;
        let observation: AssistantActionObservation;
        let parsedEnvelope: JsonObject | null = null;
        try {
          const envelopeResult = parseToolArguments(call.function.arguments);
          if (!envelopeResult.ok) {
            observation = { actionId: null, status: "invalid", code: "ACTION_VALIDATION_FAILED", message: envelopeResult.message };
          } else {
            parsedEnvelope = envelopeResult.value;
            const actionId = parsedEnvelope.actionId;
            const parsedArguments = parseToolArguments(parsedEnvelope.arguments);
            if (sourceName !== ENTERPRISE_ACTION_NAME) {
              observation = { actionId: typeof actionId === "string" ? actionId : null, status: "invalid", code: "ACTION_TOOL_INVALID", message: "unknown action tool" };
            } else if (typeof actionId !== "string" || !permittedIds.has(actionId)) {
              observation = { actionId: typeof actionId === "string" ? actionId : null, status: "denied", code: "ACTION_FORBIDDEN", message: "该操作不在当前身份可用范围内" };
            } else if (!parsedArguments.ok) {
              observation = { actionId, status: "invalid", code: "ACTION_VALIDATION_FAILED", message: parsedArguments.message };
            } else {
              const result = await awaitAbortable(input.invoke({
                actionId,
                arguments: parsedArguments.value,
                idempotencyKey: `${requestId}:turn-${turns}:call-${actionsInvoked}`,
                signal: deadline.signal,
              }), deadline.signal);
              if (result.status === "succeeded" && permittedById.get(actionId)?.effect === "mutation") {
                observation = {
                  actionId,
                  status: "denied",
                  code: "ACTION_CONFIRMATION_REQUIRED",
                  message: "写入动作必须先生成待确认预览",
                };
              } else if (result.status === "succeeded") {
                observation = {
                  actionId,
                  status: result.status,
                  message: "action completed",
                  output: boundedOutput(result.output, limits.maxObservationChars),
                  ...(result.operationId ? { operationId: result.operationId } : {}),
                };
                if (permittedById.get(actionId)?.effect === "query" && observation.output !== undefined) {
                  successfulQueryEvidence = true;
                }
                unresolved.delete(actionId);
              } else if (result.status === "awaiting_confirmation") {
                mutationProposals += 1;
                observation = {
                  actionId,
                  status: result.status,
                  message: "action is waiting for user confirmation",
                  output: boundedOutput(result.proposal, limits.maxObservationChars),
                  operationId: result.operationId,
                };
                observations.push(observation);
                conversation.push({
                  role: "tool",
                  name: ENTERPRISE_ACTION_NAME,
                  tool_call_id: call.id,
                  content: observationPayload(observation, limits.maxObservationChars),
                });
                return {
                  status: "awaiting_confirmation",
                  message: "已生成待确认预览，请核对变更内容后决定是否执行。",
                  messages: conversation,
                  observations,
                  actionsInvoked,
                  turns,
                  mutationProposals,
                  proposal: result.proposal,
                  operationId: result.operationId,
                };
              } else {
                observation = {
                  actionId,
                  status: result.status,
                  code: result.error.code,
                  message: boundedText(result.error.message, 512),
                };
              }
            }
          }
        } catch (error) {
          const abortStatus = abortedStatus(deadline.signal, deadlineExpired);
          if (abortStatus) return terminalAbortResult(abortStatus, conversation, observations, actionsInvoked, turns, mutationProposals);
            observation = {
            actionId: typeof parsedEnvelope?.actionId === "string" ? parsedEnvelope.actionId : null,
            status: "failed",
            code: typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : "ACTION_EXECUTION_FAILED",
            message: boundedText(errorMessage(error), 512),
          };
        }

        observations.push(observation);
        if (observation.status !== "succeeded") {
          unresolved.set(observation.actionId ?? `call-${actionsInvoked}`, observation);
        }
        if (observations.length > limits.maxObservationCount) observations.splice(0, observations.length - limits.maxObservationCount);
        conversation.push({
          role: "tool",
          name: ENTERPRISE_ACTION_NAME,
          tool_call_id: call.id,
          content: observationPayload(observation, limits.maxObservationChars),
        });
      }
    }

    return {
      status: "limit_reached",
      message: "智能助手已达到本次对话轮数上限，请缩小问题范围后重试。",
      messages: conversation,
      observations,
      actionsInvoked,
      turns,
      mutationProposals,
    };
  } finally {
    clearTimeout(timer);
    parentSignal.removeEventListener("abort", onParentAbort);
  }
}
