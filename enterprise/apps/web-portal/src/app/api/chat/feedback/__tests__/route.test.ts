import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class TargetNotFoundError extends Error {}
  return {
    getSessionFromCookies: vi.fn(),
    upsertChatMessageFeedback: vi.fn(),
    deleteChatMessageFeedback: vi.fn(),
    listChatMessageFeedback: vi.fn(),
    TargetNotFoundError,
  };
});

vi.mock("../../../../../lib/session", () => ({
  getSessionFromCookies: mocks.getSessionFromCookies,
  passwordChangeRequiredResponse: () => Response.json({ code: "40302" }, { status: 403 }),
}));
vi.mock("../../../../../lib/chat-feedback", () => ({
  ChatFeedbackTargetNotFoundError: mocks.TargetNotFoundError,
  ChatFeedbackValidationError: class ChatFeedbackValidationError extends Error {},
  upsertChatMessageFeedback: mocks.upsertChatMessageFeedback,
  deleteChatMessageFeedback: mocks.deleteChatMessageFeedback,
  listChatMessageFeedback: mocks.listChatMessageFeedback,
}));

import { DELETE, GET, PUT } from "../route";

const session = {
  userId: "01J00000000000000000000001",
  tenantId: "01J00000000000000000000002",
  deptId: "01J00000000000000000000003",
  email: "user@example.test",
  scopes: ["workspace:chat"],
  mustChangePassword: false,
  sessionId: "auth-session",
};

const view = {
  messageId: "01J00000000000000000000004",
  sessionId: "01J00000000000000000000005",
  value: "like" as const,
  counts: { like: 1, dislike: 0, total: 1 },
};

function request(method: string, body?: unknown, url = "http://localhost/api/chat/feedback") {
  return new Request(url, {
    method,
    ...(body === undefined ? {} : {
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  });
}

describe("/api/chat/feedback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionFromCookies.mockResolvedValue(session);
    mocks.upsertChatMessageFeedback.mockResolvedValue({
      feedback: { ...view, id: "01J00000000000000000000006" },
      view,
    });
    mocks.deleteChatMessageFeedback.mockResolvedValue({
      view: { ...view, value: null, counts: { like: 0, dislike: 0, total: 0 } },
    });
    mocks.listChatMessageFeedback.mockResolvedValue([view]);
  });

  it("uses authenticated tenant/user and accepts canonical PUT upsert", async () => {
    const response = await PUT(
      request("PUT", {
        tenant_id: "attacker-tenant",
        user_id: "attacker-user",
        session_id: view.sessionId,
        message_id: view.messageId,
        value: "like",
      }),
    );
    expect(response.status).toBe(200);
    expect(mocks.upsertChatMessageFeedback).toHaveBeenCalledWith({
      actor: {
        tenantId: session.tenantId,
        userId: session.userId,
        departmentId: session.deptId,
      },
      sessionId: view.sessionId,
      messageId: view.messageId,
      value: "like",
    });
    await expect(response.json()).resolves.toMatchObject({
      code: "00000",
      data: { feedback: { message_id: view.messageId, value: "like" }, viewer_value: "like" },
    });
  });

  it("hydrates viewer feedback by session and supports query-string cancellation", async () => {
    const listed = await GET(
      request("GET", undefined, `http://localhost/api/chat/feedback?session_id=${view.sessionId}`),
    );
    expect(listed.status).toBe(200);
    expect(mocks.listChatMessageFeedback).toHaveBeenCalledWith({
      actor: {
        tenantId: session.tenantId,
        userId: session.userId,
        departmentId: session.deptId,
      },
      sessionId: view.sessionId,
      messageIds: undefined,
    });
    await expect(listed.json()).resolves.toMatchObject({
      data: { items: [{ message_id: view.messageId, value: "like" }] },
    });

    const cleared = await DELETE(
      request(
        "DELETE",
        undefined,
        `http://localhost/api/chat/feedback?session_id=${view.sessionId}&message_id=${view.messageId}`,
      ),
    );
    expect(cleared.status).toBe(200);
    expect(mocks.deleteChatMessageFeedback).toHaveBeenCalledWith({
      actor: {
        tenantId: session.tenantId,
        userId: session.userId,
        departmentId: session.deptId,
      },
      sessionId: view.sessionId,
      messageId: view.messageId,
    });
    await expect(cleared.json()).resolves.toMatchObject({
      data: { feedback: { message_id: view.messageId, value: null }, viewer_value: null },
    });
  });

  it("rejects unauthenticated writes before touching the store", async () => {
    mocks.getSessionFromCookies.mockResolvedValue(null);
    const response = await PUT(request("PUT", {
      session_id: view.sessionId,
      message_id: view.messageId,
      value: "like",
    }));
    expect(response.status).toBe(401);
    expect(mocks.upsertChatMessageFeedback).not.toHaveBeenCalled();
  });

  it.each(["another session", "another user"])(
    "returns 404 for an assistant message from %s",
    async (scope) => {
      mocks.listChatMessageFeedback.mockRejectedValueOnce(new mocks.TargetNotFoundError());
      const response = await GET(
        request(
          "GET",
          undefined,
          `http://localhost/api/chat/feedback?session_id=${view.sessionId}&message_id=${view.messageId}`,
        ),
      );
      expect(response.status).toBe(404);
      expect(mocks.listChatMessageFeedback).toHaveBeenCalledOnce();
      expect(scope).toBeTruthy();
    },
  );
});
