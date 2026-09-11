import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveDesktopIdentity: vi.fn(),
  listDesktopChatFeedback: vi.fn(),
  upsertDesktopChatFeedback: vi.fn(),
  deleteDesktopChatFeedback: vi.fn(),
}));

vi.mock("../../../../../../lib/desktop-auth", () => ({
  resolveDesktopIdentity: (...args: unknown[]) => mocks.resolveDesktopIdentity(...args),
}));
vi.mock("../../../../../../lib/desktop-chat-feedback", () => ({
  DESKTOP_FEEDBACK_SOURCE: "desktop",
  DesktopFeedbackValidationError: class DesktopFeedbackValidationError extends Error {},
  listDesktopChatFeedback: (...args: unknown[]) => mocks.listDesktopChatFeedback(...args),
  upsertDesktopChatFeedback: (...args: unknown[]) => mocks.upsertDesktopChatFeedback(...args),
  deleteDesktopChatFeedback: (...args: unknown[]) => mocks.deleteDesktopChatFeedback(...args),
}));

import { DELETE, GET, PUT } from "../route";

function identity(overrides: Record<string, unknown> = {}) {
  return {
    userId: "01JQMZ8K3N4P5Q6R7S8T9VWXYZ",
    tenantId: "01JQMZ8K3N4P5Q6R7S8T9VWXY0",
    deptId: "01JQMZ8K3N4P5Q6R7S8T9VWXY1",
    email: "user@example.invalid",
    displayName: "User",
    tokenId: 7,
    scopes: ["workspace:chat", "desktop:managed"],
    ...overrides,
  };
}

function record(overrides: Record<string, unknown> = {}) {
  return {
    id: "01JQMZ8K3N4P5Q6R7S8T9VWXY2",
    externalSessionId: "session-1",
    externalMessageId: "session-1-i1-answer",
    value: "like" as const,
    updatedAt: "2026-09-02T00:00:00.000Z",
    ...overrides,
  };
}

function request(
  method: string,
  body?: unknown,
  url = "https://portal.example.invalid/api/desktop/chat/feedback",
) {
  return new Request(url, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("/api/desktop/chat/feedback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveDesktopIdentity.mockResolvedValue(identity());
    mocks.listDesktopChatFeedback.mockResolvedValue([record()]);
    mocks.upsertDesktopChatFeedback.mockResolvedValue(record());
    mocks.deleteDesktopChatFeedback.mockResolvedValue(undefined);
  });

  it("requires a managed Desktop PAT scope", async () => {
    mocks.resolveDesktopIdentity.mockResolvedValue(identity({ scopes: ["workspace:chat"] }));
    const response = await PUT(request("PUT", {
      external_session_id: "session-1",
      external_message_id: "session-1-i1-answer",
      value: "like",
    }));
    expect(response.status).toBe(403);
    expect(mocks.upsertDesktopChatFeedback).not.toHaveBeenCalled();
  });

  it("rejects client identity/source fields before persistence", async () => {
    const response = await PUT(request("PUT", {
      external_session_id: "session-1",
      external_message_id: "session-1-i1-answer",
      value: "like",
      tenant_id: "attacker-tenant",
      source: "web",
    }));
    expect(response.status).toBe(400);
    expect(mocks.upsertDesktopChatFeedback).not.toHaveBeenCalled();
  });

  it("persists only the authenticated identity and allows multiline answer snapshots", async () => {
    const response = await PUT(request("PUT", {
      external_session_id: "session-1",
      external_message_id: "session-1-i1-answer",
      value: "dislike",
      answer_excerpt: "first line\nsecond line\r\nthird line",
      provider: "openai",
      model: "openai/gpt",
      trace_id: "trace-1",
    }));
    expect(response.status).toBe(200);
    expect(mocks.upsertDesktopChatFeedback).toHaveBeenCalledWith({
      actor: {
        tenantId: identity().tenantId,
        userId: identity().userId,
        departmentId: identity().deptId,
      },
      source: "desktop",
      externalSessionId: "session-1",
      externalMessageId: "session-1-i1-answer",
      value: "dislike",
      answerExcerpt: "first line\nsecond line\r\nthird line",
      provider: "openai",
      model: "openai/gpt",
      traceId: "trace-1",
    });
  });

  it("lists only the requested external session and message ids", async () => {
    const response = await GET(request(
      "GET",
      undefined,
      "https://portal.example.invalid/api/desktop/chat/feedback?external_session_id=session-1&external_message_id=session-1-i1-answer",
    ));
    expect(response.status).toBe(200);
    expect(mocks.listDesktopChatFeedback).toHaveBeenCalledWith({
      actor: {
        tenantId: identity().tenantId,
        userId: identity().userId,
        departmentId: identity().deptId,
      },
      source: "desktop",
      externalSessionId: "session-1",
      externalMessageIds: ["session-1-i1-answer"],
    });
    const json = await response.json();
    expect(json.data.items[0]).toMatchObject({
      external_session_id: "session-1",
      external_message_id: "session-1-i1-answer",
      message_id: "session-1-i1-answer",
      value: "like",
    });
  });

  it("clears a vote idempotently and keeps the source server-controlled", async () => {
    const response = await DELETE(request("DELETE", {
      external_session_id: "session-1",
      external_message_id: "session-1-i1-answer",
    }));
    expect(response.status).toBe(200);
    expect(mocks.deleteDesktopChatFeedback).toHaveBeenCalledWith({
      actor: {
        tenantId: identity().tenantId,
        userId: identity().userId,
        departmentId: identity().deptId,
      },
      source: "desktop",
      externalSessionId: "session-1",
      externalMessageId: "session-1-i1-answer",
    });
  });

  it("does not expose database errors", async () => {
    mocks.upsertDesktopChatFeedback.mockRejectedValue(new Error("postgres password=secret"));
    const response = await PUT(request("PUT", {
      external_session_id: "session-1",
      external_message_id: "session-1-i1-answer",
      value: "like",
    }));
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("password");
  });
});
