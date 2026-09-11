import { describe, expect, it, vi } from "vitest";
import {
  commitSupportBootstrapState,
  commitSupportProposalState,
  buildSupportChatBody,
  persistSupportMessagesIfCurrent,
  preserveSupportModelSelection,
  readStoredMessages,
  responseMessage,
  supportRetryInput,
} from "./SupportAssistantPanel";
import { SupportAssistantLifecycle } from "./lifecycle";
import type { SupportBootstrap, SupportMessage, SupportProposal } from "./contracts";

type StateAction<T> = T | ((current: T) => T);
type PanelMessage = SupportMessage & { proposal?: SupportProposal };

/**
 * React batches state setters and evaluates functional updaters when it
 * flushes the batch. Keeping that timing here catches fences that are valid
 * when queued but invalid by the time React evaluates them.
 */
function batchedState<T>(initial: T) {
  let value = initial;
  const pending: StateAction<T>[] = [];
  return {
    set(action: StateAction<T>): void {
      pending.push(action);
    },
    flush(): void {
      while (pending.length > 0) {
        const action = pending.shift()!;
        value = typeof action === "function"
          ? (action as (current: T) => T)(value)
          : action;
      }
    },
    get value(): T {
      return value;
    },
  };
}

function supportBootstrap(storageKey: string): SupportBootstrap {
  return {
    storageKey,
    title: "页面指引与配置助手",
    suggestions: ["怎样查看当前状态？"],
    models: [{ id: "model-a", label: "模型 A" }],
  };
}

describe("SupportAssistantPanel React state timing", () => {
  it("keeps bootstrap state when sendMessage starts before the bootstrap batch flushes", () => {
    const lifecycle = new SupportAssistantLifecycle();
    const bootstrapRequest = lifecycle.beginBootstrap();
    const principal = lifecycle.adoptScope(bootstrapRequest.token, "scope-a");
    expect(principal).not.toBeNull();

    const bootstrap = batchedState<SupportBootstrap | null>(null);
    const messages = batchedState<PanelMessage[]>([]);
    const hydrated = batchedState(false);
    const messagesRef = { current: [] as PanelMessage[] };
    const hydratedScopeRef = { current: "" };

    expect(commitSupportBootstrapState(
      lifecycle,
      principal!,
      supportBootstrap("scope-a"),
      [{ role: "assistant", content: "已保存的回答" }],
      bootstrap.set,
      messages.set,
      hydrated.set,
      messagesRef,
      hydratedScopeRef,
    )).toBe(true);

    // This is the requestId transition that used to make the queued React
    // updaters call `isCurrent(adoptedToken)` and discard the bootstrap.
    const chatRequest = lifecycle.beginRequest();
    expect(lifecycle.isCurrent(chatRequest.token)).toBe(true);
    bootstrap.flush();
    messages.flush();
    hydrated.flush();

    expect(bootstrap.value).toMatchObject({ storageKey: "scope-a", models: [{ id: "model-a" }] });
    expect(messages.value).toEqual([{ role: "assistant", content: "已保存的回答" }]);
    expect(messagesRef.current).toEqual(messages.value);
    expect(hydrated.value).toBe(true);
    expect(hydratedScopeRef.current).toBe("scope-a");
  });

  it("drops queued bootstrap state after a principal generation changes", () => {
    const lifecycle = new SupportAssistantLifecycle();
    const bootstrapRequest = lifecycle.beginBootstrap();
    const principal = lifecycle.adoptScope(bootstrapRequest.token, "scope-a");
    expect(principal).not.toBeNull();

    const bootstrap = batchedState<SupportBootstrap | null>(null);
    const messages = batchedState<PanelMessage[]>([]);
    const hydrated = batchedState(false);
    const messagesRef = { current: [] as PanelMessage[] };
    const hydratedScopeRef = { current: "" };

    expect(commitSupportBootstrapState(
      lifecycle,
      principal!,
      supportBootstrap("scope-a"),
      [{ role: "assistant", content: "账号 A 的回答" }],
      bootstrap.set,
      messages.set,
      hydrated.set,
      messagesRef,
      hydratedScopeRef,
    )).toBe(true);

    const nextBootstrap = lifecycle.beginBootstrap();
    expect(lifecycle.adoptScope(nextBootstrap.token, "scope-b")).not.toBeNull();
    bootstrap.flush();
    messages.flush();
    hydrated.flush();

    expect(bootstrap.value).toBeNull();
    expect(messages.value).toEqual([]);
    expect(hydrated.value).toBe(false);
  });

  it("keeps a proposal result queued before a newer same-account request", () => {
    const lifecycle = new SupportAssistantLifecycle();
    const bootstrapRequest = lifecycle.beginBootstrap();
    const principal = lifecycle.adoptScope(bootstrapRequest.token, "scope-a");
    expect(principal).not.toBeNull();
    lifecycle.finish(principal!);

    const proposalRequest = lifecycle.beginRequest();
    const executed = batchedState(new Set<string>());
    const messages = batchedState<PanelMessage[]>([]);
    const messagesRef = { current: [] as PanelMessage[] };
    commitSupportProposalState(
      lifecycle,
      proposalRequest.token,
      "proposal-1",
      { role: "assistant", content: "额度已更新" },
      executed.set,
      messages.set,
      messagesRef,
    );

    lifecycle.beginRequest();
    executed.flush();
    messages.flush();

    expect(executed.value).toEqual(new Set(["proposal-1"]));
    expect(messages.value).toEqual([{ role: "assistant", content: "额度已更新" }]);
    expect(messagesRef.current).toEqual(messages.value);
  });

  it("does not let a queued proposal result cross a principal generation", () => {
    const lifecycle = new SupportAssistantLifecycle();
    const bootstrapRequest = lifecycle.beginBootstrap();
    const principal = lifecycle.adoptScope(bootstrapRequest.token, "scope-a");
    expect(principal).not.toBeNull();
    lifecycle.finish(principal!);

    const proposalRequest = lifecycle.beginRequest();
    const executed = batchedState(new Set<string>());
    const messages = batchedState<PanelMessage[]>([]);
    const messagesRef = { current: [] as PanelMessage[] };
    commitSupportProposalState(
      lifecycle,
      proposalRequest.token,
      "proposal-a",
      { role: "assistant", content: "账号 A 的执行结果" },
      executed.set,
      messages.set,
      messagesRef,
    );

    const nextBootstrap = lifecycle.beginBootstrap();
    expect(lifecycle.adoptScope(nextBootstrap.token, "scope-b")).not.toBeNull();
    executed.flush();
    messages.flush();

    expect(executed.value).toEqual(new Set());
    expect(messages.value).toEqual([]);
  });

  it("persists sent messages for close and reopen under the same scope", () => {
    const records = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => records.get(key) ?? null,
        setItem: (key: string, value: string) => records.set(key, value),
        removeItem: (key: string) => records.delete(key),
      },
    });

    try {
      const lifecycle = new SupportAssistantLifecycle();
      const bootstrapRequest = lifecycle.beginBootstrap();
      const principal = lifecycle.adoptScope(bootstrapRequest.token, "scope-a");
      expect(principal).not.toBeNull();

      const sentMessages: PanelMessage[] = [
        { role: "user", content: "额度还剩多少？" },
        { role: "assistant", content: "当前还剩 80%。" },
      ];
      expect(persistSupportMessagesIfCurrent(
        lifecycle,
        "scope-a",
        true,
        "scope-a",
        sentMessages,
      )).toBe(true);
      expect(JSON.parse(records.get("scope-a")!)).toMatchObject({ messages: sentMessages });

      lifecycle.setOpen(false);
      lifecycle.setOpen(true);
      const reopenRequest = lifecycle.beginBootstrap();
      expect(lifecycle.adoptScope(reopenRequest.token, "scope-a")).not.toBeNull();
      expect(JSON.parse(records.get("scope-a")!)).toMatchObject({ messages: sentMessages });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("sanitizes legacy assistant localStorage history but preserves user literal tags", () => {
    const records = new Map<string, string>([
      ["scope-legacy", JSON.stringify({
        messages: [
          { role: "assistant", content: "<think>old provider reasoning</think>旧回答" },
          { role: "user", content: "用户问题：<think>这是字面标签</think>" },
          { role: "assistant", content: "<analysis>only old reasoning" },
        ],
      })],
    ]);
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => records.get(key) ?? null,
        setItem: (key: string, value: string) => records.set(key, value),
        removeItem: (key: string) => records.delete(key),
      },
    });

    try {
      expect(readStoredMessages("scope-legacy")).toEqual([
        { role: "assistant", content: "旧回答" },
        { role: "user", content: "用户问题：<think>这是字面标签</think>" },
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("sanitizes model replies and execute replies at the assistant boundary", () => {
    expect(responseMessage({ data: { message: "<think>model reasoning</think>模型回答" } })).toBe("模型回答");
    expect(responseMessage({ data: { message: "<think>model reasoning only" } })).toBe("支持助手暂时没有返回内容。");

    const lifecycle = new SupportAssistantLifecycle();
    const bootstrapRequest = lifecycle.beginBootstrap();
    const principal = lifecycle.adoptScope(bootstrapRequest.token, "scope-a");
    expect(principal).not.toBeNull();
    lifecycle.finish(principal!);
    const request = lifecycle.beginRequest();
    const executed = batchedState(new Set<string>());
    const messages = batchedState<PanelMessage[]>([]);
    const messagesRef = { current: [] as PanelMessage[] };
    commitSupportProposalState(
      lifecycle,
      request.token,
      "proposal-a",
      { role: "assistant", content: "<analysis>execute reasoning</analysis>额度已更新" },
      executed.set,
      messages.set,
      messagesRef,
    );
    executed.flush();
    messages.flush();
    expect(messages.value).toEqual([{ role: "assistant", content: "额度已更新" }]);
  });

  it("sanitizes assistant context before sending while preserving user literal tags", () => {
    const body = JSON.parse(buildSupportChatBody([
      { role: "user", content: "请解释 <think> 标签" },
      { role: "assistant", content: "<think>internal context</think>可见上下文" },
    ], { path: "/workspace" }, "")) as { messages: Array<{ role: string; content: string }> };
    expect(body.messages).toEqual([
      { role: "user", content: "请解释 <think> 标签" },
      { role: "assistant", content: "可见上下文" },
    ]);
  });

  it("preserves a selected model only when the refreshed scope still authorizes it", () => {
    const models = [{ id: "glm/answer" }, { id: "local/fallback" }];
    expect(preserveSupportModelSelection("scope-a", "scope-a", "glm/answer", models)).toBe("glm/answer");
    expect(preserveSupportModelSelection("scope-a", "scope-a", "revoked/model", models)).toBe("");
    expect(preserveSupportModelSelection("scope-a", "scope-b", "glm/answer", models)).toBe("");
  });

  it("reuses the last failed user turn without appending a duplicate", () => {
    const history: PanelMessage[] = [
      { role: "user", content: "第一次问题" },
      { role: "assistant", content: "第一次回答" },
      { role: "user", content: "失败的问题" },
    ];
    expect(supportRetryInput(history)).toEqual({
      content: "失败的问题",
      requestMessages: history,
    });
    expect(supportRetryInput(history)?.requestMessages.filter((message) => message.role === "user")).toHaveLength(2);
  });

  it("excludes a stale assistant response when retrying the latest user turn", () => {
    const history: PanelMessage[] = [
      { role: "user", content: "失败的问题" },
      { role: "assistant", content: "旧错误结果" },
    ];
    expect(supportRetryInput(history)).toEqual({
      content: "失败的问题",
      requestMessages: [{ role: "user", content: "失败的问题" }],
    });
  });
});
