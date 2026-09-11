import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatSession } from "@agenticx/core-api";
import type { ChatChunk, ChatClient, ChatRequest, SendMessageResult } from "@agenticx/sdk-ts";
import { parseAssistantContent } from "./assistant-content";

const historyClientMocks = vi.hoisted(() => ({
  appendMessages: vi.fn().mockResolvedValue(undefined),
  replaceMessages: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./history-client", () => ({
  createPortalChatHistoryClient: () => ({
    listSessions: vi.fn().mockResolvedValue([]),
    createSession: vi.fn(),
    getMessages: vi.fn().mockResolvedValue([]),
    appendMessages: historyClientMocks.appendMessages,
    replaceMessages: historyClientMocks.replaceMessages,
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

import { STREAM_LENGTH_ERROR, useChatStore } from "./store";

function session(): ChatSession {
  const timestamp = "2026-08-20T00:00:00.000Z";
  return {
    id: "A",
    tenant_id: "01J00000000000000000000001",
    user_id: "01J00000000000000000000004",
    title: "finish reason",
    message_count: 0,
    created_at: timestamp,
    updated_at: timestamp,
  };
}

class LengthClient implements ChatClient {
  private sequence = 0;

  constructor(private readonly finishReason = "length") {}

  async sendMessage(_request: ChatRequest): Promise<SendMessageResult> {
    this.sequence += 1;
    return {
      requestId: `length-request-${this.sequence}`,
      traceId: `length-trace-${this.sequence}`,
    };
  }

  async *stream(requestId: string): AsyncIterable<ChatChunk> {
    // The SDK closes Qwen3.8's implicit think block before the terminal chunk,
    // so the finished bubble does not keep a spinner.
    yield { requestId, done: false, delta: "<think>先检查约束</think>" };
    yield {
      requestId,
      done: false,
      finishReason: this.finishReason,
    };
    // Trailers must still reach the store after the finish reason.
    yield {
      requestId,
      done: false,
      webSearchSources: [{ title: "来源", url: "https://example.com", snippet: "摘要" }],
    };
    yield { requestId, done: true, finishReason: this.finishReason };
  }

  async cancel(_requestId: string): Promise<void> {
    // no-op
  }
}

describe("chat store finish_reason handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useChatStore.setState({
      sessions: [session()],
      activeSessionId: "A",
      messages: [],
      hydrated: true,
      historyLoading: false,
      historyError: null,
      sessionMessagesLoading: false,
      status: "idle",
      activeModel: "qwen-local/qwen3.8",
      activeRequestId: null,
      streamingSessionId: null,
      streamStateBySessionId: {},
      errorMessage: null,
      quotaError: null,
      sessionTokens: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        lastInputTokens: 0,
        lastOutputTokens: 0,
        lastUpdatedAt: null,
      },
      sessionTokensBySessionId: {},
      draftSessionId: null,
      responseVersionsByUserMessageId: {},
      pendingMessages: [],
      lastWebSearchBySessionId: {},
      lastDeepResearchBySessionId: {},
      lastDeepResearchAutoBySessionId: {},
    });
  });

  it("surfaces a recoverable error while retaining incomplete reasoning and trailers", async () => {
    await useChatStore.getState().sendMessage(new LengthClient(), { content: "hello" });

    const state = useChatStore.getState();
    const assistant = state.messages.find((message) => message.role === "assistant");
    expect(state.status).toBe("error");
    expect(state.errorMessage).toBe(STREAM_LENGTH_ERROR);
    expect(assistant?.content).toBe(`<think>先检查约束</think>\n\n${STREAM_LENGTH_ERROR}`);
    expect(assistant?.content).toContain("</think>");
    expect(assistant?.content).toContain(STREAM_LENGTH_ERROR);
    expect(assistant?.web_search_sources).toEqual([
      { title: "来源", url: "https://example.com", snippet: "摘要" },
    ]);
    const parsed = parseAssistantContent(assistant!);
    expect(parsed.thinkingInProgress).toBe(false);
    expect(parsed.displayContent).toContain(STREAM_LENGTH_ERROR);
    expect(parsed.reasoningContent).toContain("先检查约束");
    const userMessage = state.messages.find((message) => message.role === "user");
    expect(userMessage).toBeTruthy();
    const versionState = state.responseVersionsByUserMessageId[userMessage!.id];
    expect(versionState?.versions[versionState.activeIndex]?.content).toContain(STREAM_LENGTH_ERROR);
  });

  it("keeps edit and regenerate recovery paths usable after a truncated stream", async () => {
    const client = new LengthClient();
    await useChatStore.getState().sendMessage(client, { content: "first" });

    const userId = useChatStore.getState().messages.find((message) => message.role === "user")?.id;
    expect(userId).toBeTruthy();
    await useChatStore.getState().editUserMessageAndResend(client, {
      messageId: userId!,
      content: "edited",
    });

    let state = useChatStore.getState();
    let assistant = state.messages.filter((message) => message.role === "assistant").at(-1);
    expect(state.errorMessage).toBe(STREAM_LENGTH_ERROR);
    expect(assistant?.content).toBe(`<think>先检查约束</think>\n\n${STREAM_LENGTH_ERROR}`);
    expect(parseAssistantContent(assistant!).thinkingInProgress).toBe(false);
    const editedVersionState = state.responseVersionsByUserMessageId[userId!];
    expect(editedVersionState?.versions[editedVersionState.activeIndex]?.content).toContain(STREAM_LENGTH_ERROR);
    expect(state.status).toBe("error");

    expect(assistant?.id).toBeTruthy();
    await useChatStore.getState().regenerateAssistantResponse(client, assistant!.id);

    state = useChatStore.getState();
    assistant = state.messages.filter((message) => message.role === "assistant").at(-1);
    expect(state.errorMessage).toBe(STREAM_LENGTH_ERROR);
    expect(assistant?.content).toBe(`<think>先检查约束</think>\n\n${STREAM_LENGTH_ERROR}`);
    expect(parseAssistantContent(assistant!).thinkingInProgress).toBe(false);
    const regeneratedVersionState = state.responseVersionsByUserMessageId[userId!];
    expect(regeneratedVersionState?.versions[regeneratedVersionState.activeIndex]?.content).toContain(STREAM_LENGTH_ERROR);
    expect(state.status).toBe("error");
    expect(historyClientMocks.replaceMessages).toHaveBeenCalled();
  });

  it.each(["max_tokens", "max_output_tokens", "token_limit", "token_limit_exceeded"])(
    "treats %s as a truncated response",
    async (finishReason) => {
      await useChatStore.getState().sendMessage(new LengthClient(finishReason), { content: "hello" });

      const state = useChatStore.getState();
      const assistant = state.messages.find((message) => message.role === "assistant");
      expect(state.status).toBe("error");
      expect(state.errorMessage).toBe(STREAM_LENGTH_ERROR);
      expect(assistant?.content).toContain(STREAM_LENGTH_ERROR);
      expect(parseAssistantContent(assistant!).thinkingInProgress).toBe(false);
    },
  );
});
