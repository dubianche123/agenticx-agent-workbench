import { describe, expect, it, vi } from "vitest";
import {
  assertChatFeedbackOperationOk,
  beginChatFeedbackWrite,
  chatFeedbackValueForMessage,
  completeChatFeedbackWrite,
  createChatFeedbackState,
  failChatFeedbackWrite,
  markChatFeedbackLearningError,
  nextChatFeedbackValue,
  parseChatFeedbackAuthGeneration,
  parseChatFeedbackMap,
  parseChatFeedbackScope,
  resolveChatFeedbackApi,
  resolveChatFeedbackClick,
} from "./chat-feedback";

describe("chat feedback transitions", () => {
  it("sets, clears, and switches the selected value", () => {
    expect(nextChatFeedbackValue(undefined, "like")).toBe("like");
    expect(nextChatFeedbackValue(null, "dislike")).toBe("dislike");
    expect(nextChatFeedbackValue("like", "like")).toBeNull();
    expect(nextChatFeedbackValue("like", "dislike")).toBe("dislike");
    expect(nextChatFeedbackValue("dislike", "like")).toBe("like");
    expect(nextChatFeedbackValue("dislike", "dislike")).toBeNull();
  });

  it("keeps optimistic, saving, success, and rollback state explicit", () => {
    const sessionId = "session-a";
    const messageId = "assistant-1";
    let state = createChatFeedbackState(sessionId);

    state = beginChatFeedbackWrite(state, {
      sessionId,
      messageId,
      value: "like",
    });
    expect(chatFeedbackValueForMessage(state, sessionId, messageId)).toBe("like");
    expect(state.pending[messageId]).toBe(true);

    state = completeChatFeedbackWrite(state, {
      sessionId,
      messageId,
      value: "like",
    });
    expect(chatFeedbackValueForMessage(state, sessionId, messageId)).toBe("like");
    expect(state.pending[messageId]).toBeUndefined();
    expect(state.status[messageId]).toBe("success");

    state = beginChatFeedbackWrite(state, {
      sessionId,
      messageId,
      value: "dislike",
    });
    expect(chatFeedbackValueForMessage(state, sessionId, messageId)).toBe("dislike");
    state = failChatFeedbackWrite(state, {
      sessionId,
      messageId,
      previousValue: "like",
    });
    expect(chatFeedbackValueForMessage(state, sessionId, messageId)).toBe("like");
    expect(state.pending[messageId]).toBeUndefined();
    expect(state.status[messageId]).toBe("error");

    state = completeChatFeedbackWrite(state, {
      sessionId,
      messageId,
      value: "like",
    });
    state = markChatFeedbackLearningError(state, { sessionId, messageId });
    expect(chatFeedbackValueForMessage(state, sessionId, messageId)).toBe("like");
    expect(state.status[messageId]).toBe("learning-error");
  });

  it("does not read or write values across sessions", () => {
    const state = completeChatFeedbackWrite(
      createChatFeedbackState("session-a"),
      { sessionId: "session-a", messageId: "same-id", value: "like" },
    );
    expect(chatFeedbackValueForMessage(state, "session-b", "same-id")).toBeNull();
    expect(
      beginChatFeedbackWrite(state, {
        sessionId: "session-b",
        messageId: "same-id",
        value: "dislike",
      }),
    ).toBe(state);
  });

  it("keeps a selected vote when retrying a failed learning mirror", () => {
    expect(resolveChatFeedbackClick("like", "like", "learning-error")).toEqual({
      value: "like",
      action: { retryLearning: true },
    });
    expect(resolveChatFeedbackClick("dislike", "dislike", "learning-error")).toEqual({
      value: "dislike",
      action: { retryLearning: true },
    });
    expect(resolveChatFeedbackClick(null, "like", "learning-error")).toEqual({ value: "like" });
    expect(resolveChatFeedbackClick("like", "dislike", "learning-error")).toEqual({ value: "dislike" });
  });

  it("parses plain maps and preload list envelopes while ignoring invalid rows", () => {
    expect(parseChatFeedbackMap({ "assistant-1": "like", invalid: "other" })).toEqual({
      "assistant-1": "like",
    });
    expect(
      parseChatFeedbackMap({
        data: {
          feedback: [
            { message_id: "assistant-2", value: "dislike" },
            { messageId: "assistant-3", feedback: "like" },
            { message_id: "bad", value: "unknown" },
          ],
        },
      }),
    ).toEqual({ "assistant-2": "dislike", "assistant-3": "like" });
  });

  it("accepts only a bounded host supplied account scope", () => {
    expect(parseChatFeedbackScope({ scope_id: '["desktop","tenant-a","user-a"]' })).toBe(
      '["desktop","tenant-a","user-a"]',
    );
    expect(parseChatFeedbackScope({ data: { scopeId: "scope-b" } })).toBe("scope-b");
    expect(parseChatFeedbackScope({ scope_id: "" })).toBeNull();
    expect(parseChatFeedbackScope({ scope_id: "x".repeat(513) })).toBeNull();
    expect(parseChatFeedbackScope({ scope_id: "scope\u0000old" })).toBeNull();
  });

  it("requires the main process to return a bounded auth generation", () => {
    expect(parseChatFeedbackAuthGeneration({ auth_generation: 0 })).toBe(0);
    expect(parseChatFeedbackAuthGeneration({ data: { authGeneration: 12 } })).toBe(12);
    expect(parseChatFeedbackAuthGeneration({ auth_generation: -1 })).toBeNull();
    expect(parseChatFeedbackAuthGeneration({ auth_generation: "12" })).toBeNull();
  });

  it("requires the trusted scope operation before exposing the feedback bridge", () => {
    const host = {
      feedback: {
        scope: vi.fn(),
        list: vi.fn(),
        set: vi.fn(),
        clear: vi.fn(),
      },
    };
    vi.stubGlobal("window", { agenticxDesktop: host });
    expect(resolveChatFeedbackApi()).not.toBeNull();
    vi.stubGlobal("window", {
      agenticxDesktop: {
        feedback: { list: vi.fn(), set: vi.fn(), clear: vi.fn() },
      },
    });
    expect(resolveChatFeedbackApi()).toBeNull();
    vi.unstubAllGlobals();
  });

  it("treats an explicit preload failure as a rejected write", () => {
    expect(() => assertChatFeedbackOperationOk({ ok: true })).not.toThrow();
    expect(() => assertChatFeedbackOperationOk(undefined)).not.toThrow();
    expect(() => assertChatFeedbackOperationOk({ ok: false, error: "权限不足" })).toThrow("权限不足");
  });
});
