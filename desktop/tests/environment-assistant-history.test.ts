import { describe, expect, it } from "vitest";

import {
  classifyEnterpriseAuthorizationPreflight,
  canSetEnvironmentAssistantIdleAfterClarification,
  consumeEnvironmentAssistantSse,
  EnvironmentAssistantStreamTerminalError,
  environmentAssistantReattachCompletionStatus,
  environmentAssistantReattachFailureStatus,
  environmentAssistantReattachKeyAfterFailure,
  type EnvironmentAssistantStreamState,
  historyEnterpriseAuthorizationVersion,
  historyHasEnterpriseContext,
  isEnvironmentAssistantConfirmResponseForPending,
  isEnvironmentAssistantClarificationResponseForPending,
  isEnvironmentAssistantDecisionCurrent,
  isEnvironmentAssistantHistoryLoadCurrent,
  isEnterpriseContextStaleError,
  parseHistoryRows,
  pendingClarificationFromHistory,
  shouldReuseEnvironmentAssistantSession,
  streamErrorForCompletion,
} from "../src/components/EnvironmentAssistantPanel";

function sseFrame(type: string, data: Record<string, unknown> = {}): string {
  return `data: ${JSON.stringify({ type, data })}\n\n`;
}

function responseFromSse(frames: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  }));
}

function responseThatErrorsAfterSse(
  frames: string[],
  cause: Error,
): Response {
  const encoder = new TextEncoder();
  let index = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < frames.length) {
        controller.enqueue(encoder.encode(frames[index++] || ""));
        return;
      }
      controller.error(cause);
    },
  }));
}

describe("environment assistant history projection", () => {
  it("does not trust a warm SID after close/reopen or identity changes", () => {
    const reusable = {
      sessionId: "assistant-session",
      currentScope: "enterprise:scope-a",
      nextScope: "enterprise:scope-a",
      forceNewSession: false,
      needsValidation: false,
    };

    expect(shouldReuseEnvironmentAssistantSession(reusable)).toBe(true);
    expect(shouldReuseEnvironmentAssistantSession({
      ...reusable,
      needsValidation: true,
    })).toBe(false);
    expect(shouldReuseEnvironmentAssistantSession({
      ...reusable,
      nextScope: "enterprise:scope-b",
    })).toBe(false);
    expect(shouldReuseEnvironmentAssistantSession({
      ...reusable,
      forceNewSession: true,
    })).toBe(false);
  });

  it("filters internal rows and does not restore stale progress text", () => {
    const messages = parseHistoryRows([
      { role: "system", content: "internal setup" },
      {
        role: "tool",
        tool_name: "bash_exec",
        tool_status: "running",
        tool_result_preview: `stdout:\n${"x".repeat(2_000)}`,
      },
      { role: "assistant", content: "检查已完成" },
    ]);

    expect(messages).toHaveLength(2);
    expect(messages[0]?.role).toBe("tool");
    expect(messages[0]?.content).toContain("已记录：bash_exec");
    expect(messages[0]?.content).not.toContain("正在处理");
    expect(messages[0]?.content.length).toBeLessThan(500);
    expect(messages[1]?.content).toBe("检查已完成");
  });

  it("keeps persisted confirmation rows actionable and compact", () => {
    const messages = parseHistoryRows([
      {
        role: "tool",
        content: "安装依赖",
        metadata: {
          kind: "action_confirmation",
          request_id: "confirm-1",
          prompt: "是否安装依赖？",
          options: ["确认", "取消"],
        },
      },
    ]);

    expect(messages).toEqual([
      expect.objectContaining({
        role: "tool",
        content: "需要确认：是否安装依赖？\n可选：确认、取消",
      }),
    ]);
  });

  it("restores a pending enterprise confirmation and tracks its authorization version", () => {
    const history = [
      {
        role: "tool",
        tool_name: "enterprise_action",
        content: JSON.stringify({
          status: "succeeded",
          authorizationVersion: "role-version-7",
          result: { quota: 3 },
        }),
      },
      {
        role: "tool",
        content: "确认修改配额",
        metadata: {
          kind: "clarification",
          request_id: "clarify-enterprise-1",
          prompt: "确认修改配额？",
          options: ["确认执行", "取消"],
          allow_free_text: false,
          context: {
            enterprise_confirmation: true,
            operation_id: "operation-1",
            session_id: "session-1",
            auth_generation: 2,
          },
        },
      },
    ];

    expect(historyHasEnterpriseContext(history)).toBe(true);
    expect(historyEnterpriseAuthorizationVersion(history)).toBe("role-version-7");
    expect(pendingClarificationFromHistory(history)).toEqual({
      requestId: "clarify-enterprise-1",
      prompt: "确认修改配额？",
      options: ["确认执行", "取消"],
      allowFreeText: false,
      context: {
        enterprise_confirmation: true,
        operation_id: "operation-1",
        session_id: "session-1",
        auth_generation: 2,
      },
    });
  });

  it("does not restore an answered confirmation card", () => {
    expect(pendingClarificationFromHistory([
      {
        role: "tool",
        content: "确认修改配额",
        metadata: {
          kind: "clarification",
          request_id: "clarify-enterprise-1",
          prompt: "确认修改配额？",
          clarification_answered: true,
        },
      },
    ])).toBeNull();
  });

  it("blocks a transient authorization failure without rotating the session", () => {
    expect(classifyEnterpriseAuthorizationPreflight(
      { ok: false, code: "ENTERPRISE_PORTAL_UNAVAILABLE" },
      "role-version-7",
      2,
    )).toEqual({
      action: "block",
      reason: "unavailable",
      observedVersion: "",
      observedGeneration: null,
    });
  });

  it("rotates only when the fresh authorization version changes", () => {
    expect(classifyEnterpriseAuthorizationPreflight(
      { ok: true, authorizationVersion: "role-version-8", authGeneration: 2 },
      "role-version-7",
      2,
    )).toEqual({
      action: "rotate",
      reason: "authorization_changed",
      observedVersion: "role-version-8",
      observedGeneration: 2,
    });
  });

  it("rotates a legacy enterprise context whose authorization version is missing", () => {
    expect(classifyEnterpriseAuthorizationPreflight(
      { ok: true, authorizationVersion: "role-version-7", authGeneration: 2 },
      "",
      null,
    )).toEqual({
      action: "rotate",
      reason: "authorization_changed",
      observedVersion: "role-version-7",
      observedGeneration: 2,
    });
  });

  it("keeps a healthy enterprise context when its authorization version is unchanged", () => {
    expect(classifyEnterpriseAuthorizationPreflight(
      { ok: true, authorizationVersion: "role-version-7", authGeneration: 3 },
      "role-version-7",
      3,
    ).action).toBe("keep");
  });

  it("recognizes the stale-context response by code while preserving other errors", () => {
    expect(isEnterpriseContextStaleError("enterprise_context_stale: 旧企业上下文缺少可恢复的权限版本")).toBe(true);
    expect(isEnterpriseContextStaleError({ detail: { code: "ENTERPRISE_CONTEXT_STALE" } })).toBe(true);
    expect(isEnterpriseContextStaleError("enterprise_context_unavailable: 稍后重试")).toBe(false);
  });

  it("clears an SSE error when a later non-empty final answer arrives before done", () => {
    const streamError = "暂时连接失败";
    let finalSeen = false;
    expect(streamErrorForCompletion(streamError, finalSeen)).toBe(streamError);

    // error → final(answer) → done: the successful final owns completion.
    finalSeen = "已恢复并完成".trim().length > 0;
    expect(streamErrorForCompletion(streamError, finalSeen)).toBe("");
  });

  it("keeps an unrecovered SSE error when the stream ends without a final answer", () => {
    expect(streamErrorForCompletion("模型流中断", false)).toBe("模型流中断");
    expect(streamErrorForCompletion("   ", false)).toBe("模型流未返回完整答案");
    expect(streamErrorForCompletion("   ", false, true)).toBe("模型流未返回可见答案");
  });

  it("consumes error → visible final → done as a successful terminal stream", async () => {
    const states: EnvironmentAssistantStreamState[] = [];
    const result = await consumeEnvironmentAssistantSse(
      responseFromSse([
        sseFrame("error", { text: "暂时连接失败" }),
        sseFrame("final", { text: "<think>内部恢复</think>已恢复并完成" }),
        sseFrame("done"),
      ]),
      (_frame, state) => states.push(state),
    );

    expect(states[0]).toEqual({ finalSeen: false, finalReceived: false, streamError: "暂时连接失败" });
    expect(states[1]).toEqual({ finalSeen: true, finalReceived: true, streamError: "" });
    expect(result).toEqual({ finalSeen: true, finalReceived: true, streamError: "" });
  });

  it("keeps an error when the final contains only think text and rejects empty visible finals", async () => {
    const states: EnvironmentAssistantStreamState[] = [];
    const terminalFailure = consumeEnvironmentAssistantSse(
      responseFromSse([
        sseFrame("error", { text: "模型错误" }),
        sseFrame("final", { text: "<think>仍在思考</think>" }),
        sseFrame("done"),
      ]),
      (_frame, state) => states.push(state),
    );
    await expect(terminalFailure).rejects.toBeInstanceOf(EnvironmentAssistantStreamTerminalError);
    await expect(terminalFailure).rejects.toThrow("模型错误");
    expect(states[1]).toEqual({ finalSeen: false, finalReceived: true, streamError: "模型错误" });

    await expect(consumeEnvironmentAssistantSse(
      responseFromSse([sseFrame("final", { text: "<think>只有思考</think>" }), sseFrame("done")]),
      () => undefined,
    )).rejects.toThrow("模型流未返回可见答案");
  });

  it("does not downgrade a visible final when the reader fails afterward", async () => {
    const result = await consumeEnvironmentAssistantSse(
      responseThatErrorsAfterSse(
        [sseFrame("final", { text: "答案" })],
        new Error("network disconnected"),
      ),
      () => undefined,
    );

    expect(result).toEqual({ finalSeen: true, finalReceived: true, streamError: "" });
  });

  it("allows a done-only reattach when the backend reports no active runtime", async () => {
    const result = await consumeEnvironmentAssistantSse(
      responseFromSse([sseFrame("done", { reason: "not_running" })]),
      () => undefined,
      { allowDoneWithoutFinal: true },
    );

    expect(result).toEqual({ finalSeen: false, finalReceived: false, streamError: "" });
    expect(environmentAssistantReattachCompletionStatus(false, false)).toBe("idle");
  });

  it("preserves AbortError so the component can report a stopped turn", async () => {
    const abortError = new DOMException("stream aborted", "AbortError");
    await expect(consumeEnvironmentAssistantSse(
      responseThatErrorsAfterSse([sseFrame("error", { text: "等待执行" })], abortError),
      () => undefined,
    )).rejects.toHaveProperty("name", "AbortError");
  });

  it("settles a clarification after a completed reattach reader", () => {
    expect(canSetEnvironmentAssistantIdleAfterClarification(true, false, false)).toBe(true);
    expect(canSetEnvironmentAssistantIdleAfterClarification(true, true, false)).toBe(false);
    expect(canSetEnvironmentAssistantIdleAfterClarification(true, false, true)).toBe(false);
    expect(canSetEnvironmentAssistantIdleAfterClarification(false, false, false)).toBe(false);
  });

  it("clears a failed reattach key and classifies terminal failures as error", () => {
    expect(environmentAssistantReattachKeyAfterFailure("7:session", "7:session")).toBe("");
    expect(environmentAssistantReattachKeyAfterFailure("8:session", "7:session")).toBe("8:session");
    expect(environmentAssistantReattachFailureStatus(false, false, false, true)).toBe("error");
    expect(environmentAssistantReattachFailureStatus(false, false, true, false)).toBe("error");
    expect(environmentAssistantReattachFailureStatus(false, false, false, false)).toBe("streaming");
    expect(environmentAssistantReattachFailureStatus(true, false, false, true)).toBe("awaiting_confirm");
    expect(environmentAssistantReattachFailureStatus(false, true, false, true)).toBe("awaiting_input");
    expect(environmentAssistantReattachCompletionStatus(true, false)).toBe("awaiting_confirm");
    expect(environmentAssistantReattachCompletionStatus(false, true)).toBe("awaiting_input");
  });

  it("invalidates confirmation and clarification responses after stop or card replacement", () => {
    expect(isEnvironmentAssistantDecisionCurrent(7, 7, 7, 7, "request-1", "request-1", false)).toBe(true);
    expect(isEnvironmentAssistantDecisionCurrent(7, 7, 8, 9, "request-1", "request-1", false)).toBe(false);
    expect(isEnvironmentAssistantDecisionCurrent(7, 8, 7, 7, "request-1", "request-1", false)).toBe(false);
    expect(isEnvironmentAssistantDecisionCurrent(7, 7, 7, 7, "request-1", "request-2", false)).toBe(false);
    expect(isEnvironmentAssistantDecisionCurrent(7, 7, 7, 7, "request-1", "request-1", true)).toBe(false);
  });

  it("fences deferred history after Stop for foreground and reattach owners", async () => {
    let resolveResponse!: () => void;
    const deferredResponse = new Promise<void>((resolve) => {
      resolveResponse = resolve;
    });
    const foregroundController = new AbortController();
    const reattachController = new AbortController();
    let currentTurnGeneration = 12;
    let currentRequestId = "history-foreground";
    let currentController: AbortController | null = foregroundController;

    expect(isEnvironmentAssistantHistoryLoadCurrent(
      4,
      4,
      12,
      currentTurnGeneration,
      "history-foreground",
      currentRequestId,
      foregroundController,
      currentController,
      false,
    )).toBe(true);

    const shouldApplyDeferredHistory = deferredResponse.then(() => isEnvironmentAssistantHistoryLoadCurrent(
      4,
      4,
      12,
      currentTurnGeneration,
      "history-foreground",
      currentRequestId,
      foregroundController,
      currentController,
      foregroundController.signal.aborted,
    ));

    // Stop owns the same session but invalidates the turn and request slot.
    currentTurnGeneration += 1;
    currentRequestId = "";
    currentController = null;
    foregroundController.abort();
    resolveResponse();
    await expect(shouldApplyDeferredHistory).resolves.toBe(false);

    // A delayed reattach response is fenced by its reader owner as well.
    currentTurnGeneration = 20;
    currentRequestId = "history-reattach";
    currentController = reattachController;
    expect(isEnvironmentAssistantHistoryLoadCurrent(
      4,
      4,
      20,
      currentTurnGeneration,
      "history-reattach",
      currentRequestId,
      reattachController,
      currentController,
      false,
    )).toBe(true);
    currentRequestId = "";
    currentController = null;
    reattachController.abort();
    expect(isEnvironmentAssistantHistoryLoadCurrent(
      4,
      4,
      20,
      currentTurnGeneration,
      "history-reattach",
      currentRequestId,
      reattachController,
      currentController,
      true,
    )).toBe(false);
  });

  it("requires a non-empty matching request id for a confirm response", () => {
    const pendingRequestId = "confirm-1";
    expect(isEnvironmentAssistantConfirmResponseForPending(pendingRequestId, undefined)).toBe(false);
    expect(isEnvironmentAssistantConfirmResponseForPending(pendingRequestId, "   ")).toBe(false);
    expect(isEnvironmentAssistantConfirmResponseForPending(pendingRequestId, "confirm-other")).toBe(false);
    expect(isEnvironmentAssistantConfirmResponseForPending(pendingRequestId, pendingRequestId)).toBe(true);
  });

  it("settles a clarification response only for the current card", () => {
    let pendingRequestId = "clarify-1";
    const applyResponse = (responseRequestId: string | undefined) => {
      if (isEnvironmentAssistantClarificationResponseForPending(pendingRequestId, responseRequestId)) {
        pendingRequestId = "";
      }
    };

    // clarification_required → missing/mismatched response must remain
    // actionable; the exact response then clears the card for the next frame.
    applyResponse(undefined);
    expect(pendingRequestId).toBe("clarify-1");
    applyResponse("clarify-old");
    expect(pendingRequestId).toBe("clarify-1");
    applyResponse("clarify-1");
    expect(pendingRequestId).toBe("");
  });

  it("blocks an incomplete snapshot instead of treating a missing version as a change", () => {
    expect(classifyEnterpriseAuthorizationPreflight(
      { ok: true, authGeneration: 2 },
      "role-version-7",
      2,
    ).action).toBe("block");
  });
});
