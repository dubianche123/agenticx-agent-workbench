import { describe, expect, it, vi } from "vitest";
import { studioFetch } from "./studio-fetch";
import { FeedbackLearningSyncError, mirrorFeedbackLearning } from "./feedback-learning";
import type { Message } from "../store";
import { mergeSessionMessagesTail } from "./session-message-merge";
import { feedbackMessageIdForMessage } from "./feedback-message-id";

vi.mock("./studio-fetch", () => ({
  studioFetch: vi.fn(),
}));

const mockedStudioFetch = vi.mocked(studioFetch);

describe("feedback learning mirror", () => {
  it("sends only the canonical learning payload after the enterprise vote settles", async () => {
    mockedStudioFetch.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await expect(mirrorFeedbackLearning({
      sessionId: "session-a",
      messageId: "message-a",
      value: "like",
      expectedScopeId: '["desktop","tenant-a","user-a"]',
      storeBase: "http://studio",
      apiToken: "token",
    })).resolves.toEqual({ ok: true });
    expect(mockedStudioFetch).toHaveBeenCalledWith(
      "/api/session/feedback-learning",
      expect.objectContaining({
        method: "POST",
        storeBase: "http://studio",
        apiToken: "token",
        body: JSON.stringify({
          session_id: "session-a",
          message_id: "message-a",
          value: "like",
          expected_scope_id: '["desktop","tenant-a","user-a"]',
        }),
      }),
    );
  });

  it("mirrors cancellation and surfaces a readable failure", async () => {
    mockedStudioFetch.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, removed: true }), { status: 200 }));
    await expect(mirrorFeedbackLearning({
      sessionId: "session-a",
      messageId: "message-a",
      value: null,
      expectedScopeId: '["desktop","tenant-a","user-a"]',
    })).resolves.toEqual({ ok: true, removed: true });
    mockedStudioFetch.mockResolvedValueOnce(new Response(JSON.stringify({ detail: { message: "本地消息不存在" } }), { status: 409 }));
    const error = await mirrorFeedbackLearning({
      sessionId: "session-a",
      messageId: "legacy",
      value: "dislike",
      expectedScopeId: '["desktop","tenant-a","user-a"]',
    }).catch((caught) => caught);
    expect(error).toBeInstanceOf(FeedbackLearningSyncError);
    expect(error).toMatchObject({ status: 409, message: "本地消息不存在" });
  });

  it("uses the durable address immediately after a live uid row is merged", async () => {
    const live: Message[] = [
      { id: "uid-u", role: "user", content: "问题" },
      { id: "uid-a", role: "assistant", content: "回答" },
    ];
    const merged = mergeSessionMessagesTail(
      live,
      [
        { id: "stored-u", role: "user", content: "问题" },
        { id: "stored-a", role: "assistant", content: "回答" },
      ],
      "session-a",
    );
    const messageId = feedbackMessageIdForMessage(merged[1]);
    expect(messageId).toBe("session-a-i1-stored-a");

    mockedStudioFetch.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await expect(mirrorFeedbackLearning({
      sessionId: "session-a",
      messageId,
      value: "like",
      expectedScopeId: '["desktop","tenant-a","user-a"]',
      storeBase: "http://studio",
      apiToken: "token",
    })).resolves.toEqual({ ok: true });
    expect(mockedStudioFetch).toHaveBeenLastCalledWith(
      "/api/session/feedback-learning",
      expect.objectContaining({
        body: JSON.stringify({
          session_id: "session-a",
          message_id: "session-a-i1-stored-a",
          value: "like",
          expected_scope_id: '["desktop","tenant-a","user-a"]',
        }),
      }),
    );
  });
});
