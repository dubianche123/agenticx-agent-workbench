import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatChunk, ChatClient, ChatRequest, SendMessageResult } from "@agenticx/sdk-ts";
import type { ChatSession } from "@agenticx/core-api";

vi.mock("./history-client", () => ({
  createPortalChatHistoryClient: () => ({
    listSessions: vi.fn().mockResolvedValue([]),
    createSession: vi.fn(),
    getMessages: vi.fn().mockResolvedValue([]),
    appendMessages: vi.fn().mockResolvedValue(undefined),
    replaceMessages: vi.fn().mockResolvedValue(undefined),
    renameSession: vi.fn(),
    patchSession: vi.fn(),
    deleteSession: vi.fn(),
    deleteSessions: vi.fn(),
    pinSession: vi.fn(),
  }),
  ChatHistoryHttpError: class ChatHistoryHttpError extends Error {
    status = 500;
  },
}));

import { useChatStore } from "./store";

const SESSION: ChatSession = {
  id: "session-1",
  tenant_id: "tenant-1",
  user_id: "user-1",
  title: "attachment routing",
  active_model: "cloud/model",
  message_count: 0,
  created_at: "2026-08-27T00:00:00.000Z",
  updated_at: "2026-08-27T00:00:00.000Z",
};

class CapturingClient implements ChatClient {
  request: ChatRequest | null = null;
  routedModel = "";

  async sendMessage(request: ChatRequest): Promise<SendMessageResult> {
    this.request = request;
    return { requestId: "request-1", traceId: "01J0000000000000000000000A" };
  }

  async *stream(requestId: string): AsyncIterable<ChatChunk> {
    if (this.routedModel) {
      yield { requestId, done: false, routedModel: this.routedModel };
    }
    yield { requestId, done: true };
  }

  async cancel(): Promise<void> {}
}

describe("chat store attachment routing metadata", () => {
  beforeEach(() => {
    useChatStore.setState({
      sessions: [SESSION],
      activeSessionId: SESSION.id,
      messages: [],
      hydrated: false,
      historyLoading: false,
      historyError: null,
      sessionMessagesLoading: false,
      status: "idle",
      activeModel: "cloud/model",
      activeRequestId: null,
      streamingSessionId: null,
      streamStateBySessionId: {},
      errorMessage: null,
      draftSessionId: null,
      responseVersionsByUserMessageId: {},
      pendingMessages: [],
      lastWebSearchBySessionId: {},
      lastDeepResearchBySessionId: {},
      lastDeepResearchAutoBySessionId: {},
    });
  });

  it("keeps document names on the SDK request while injecting parsed text into content", async () => {
    const client = new CapturingClient();
    await useChatStore.getState().sendMessage(client, {
      content: "总结附件",
      attachments: [{
        name: "report.pdf",
        mime_type: "application/pdf",
        parsed_text: "confidential report body",
        kind: "document",
      }],
    });

    const user = client.request?.messages.find((message) => message.role === "user");
    expect(user?.content).toContain("--- 附件: report.pdf ---");
    expect(user?.content).toContain("confidential report body");
    expect(user?.attachments?.[0]).toMatchObject({
      name: "report.pdf",
      mimeType: "application/pdf",
      kind: "document",
    });
    expect(user?.attachments?.[0]?.dataUrl).toBeUndefined();
  });

  it("uses the server-routed model for the session and assistant message", async () => {
    const client = new CapturingClient();
    client.routedModel = "qwen-local/qwen3.8";

    await useChatStore.getState().sendMessage(client, {
      content: "总结附件",
      attachments: [{
        name: "report.pdf",
        mime_type: "application/pdf",
        parsed_text: "confidential report body",
        kind: "document",
      }],
    });

    const state = useChatStore.getState();
    expect(state.activeModel).toBe("qwen-local/qwen3.8");
    expect(state.sessions.find((item) => item.id === SESSION.id)?.active_model).toBe(
      "qwen-local/qwen3.8",
    );
    expect(state.messages.find((message) => message.role === "assistant")?.model).toBe(
      "qwen-local/qwen3.8",
    );
  });

  it("forwards the member's attachment routing choice to the SDK request", async () => {
    const client = new CapturingClient();
    await useChatStore.getState().sendMessage(client, {
      content: "总结附件",
      attachments: [{
        name: "report.pdf",
        mime_type: "application/pdf",
        parsed_text: "confidential report body",
        kind: "document",
      }],
      attachmentRoutingDecision: "public",
    });

    expect(client.request?.attachmentRoutingDecision).toBe("public");
  });
});
