import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateDesktopAssistantRequest: vi.fn(),
  assistantActionRuntime: vi.fn(),
  assistantErrorResponse: vi.fn(),
}));

vi.mock("../../../../../../lib/desktop-assistant", () => ({
  authenticateDesktopAssistantRequest: (...args: unknown[]) => mocks.authenticateDesktopAssistantRequest(...args),
  assistantActionRuntime: (...args: unknown[]) => mocks.assistantActionRuntime(...args),
  assistantErrorResponse: (...args: unknown[]) => mocks.assistantErrorResponse(...args),
}));

function request(body: unknown): Request {
  return new Request("http://localhost/api/desktop/assistant/actions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer session-token" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/desktop/assistant/actions", () => {
  beforeEach(() => {
    mocks.authenticateDesktopAssistantRequest.mockReset();
    mocks.assistantActionRuntime.mockReset();
    mocks.assistantErrorResponse.mockReset();
    mocks.authenticateDesktopAssistantRequest.mockResolvedValue({ request: { tenantId: "tenant-a", userId: "user-a" } });
    mocks.assistantActionRuntime.mockReturnValue({ run: vi.fn().mockResolvedValue({ operationId: "op-a" }) });
    mocks.assistantErrorResponse.mockImplementation((error: { code?: string; message?: string; status?: number }) => ({
      body: { code: error.code ?? "ACTION_EXECUTION_FAILED", message: error.message ?? "action request failed" },
      status: error.status ?? 400,
    }));
  });

  it("rejects body supplied identity fields before authentication", async () => {
    const { POST } = await import("../route");
    const response = await POST(request({
      actionId: "assistant.read",
      arguments: {},
      idempotencyKey: "idempotency-a",
      userId: "victim",
      tenantId: "other-tenant",
    }));

    expect(response.status).toBe(400);
    expect(mocks.authenticateDesktopAssistantRequest).not.toHaveBeenCalled();
    expect(mocks.assistantActionRuntime).not.toHaveBeenCalled();
  });

  it("surfaces a live revoked or disabled-session result", async () => {
    mocks.authenticateDesktopAssistantRequest.mockRejectedValue({
      code: "ASSISTANT_AUTH_REVOKED",
      message: "the originating PAT is no longer active",
      status: 401,
    });
    const { POST } = await import("../route");
    const response = await POST(request({
      actionId: "assistant.read",
      arguments: {},
      idempotencyKey: "idempotency-a",
    }));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      code: "ASSISTANT_AUTH_REVOKED",
      message: "the originating PAT is no longer active",
    });
  });

  it("derives the action request from the authenticated session context", async () => {
    const runtime = { run: vi.fn().mockResolvedValue({ operationId: "op-a" }) };
    const authenticated = { request: { tenantId: "tenant-a", userId: "user-a", agentPrincipalId: "agent-a" } };
    mocks.authenticateDesktopAssistantRequest.mockResolvedValue(authenticated);
    mocks.assistantActionRuntime.mockReturnValue(runtime);
    const { POST } = await import("../route");
    const response = await POST(request({
      actionId: "assistant.read",
      arguments: { resourceId: "resource-a" },
      idempotencyKey: "idempotency-a",
      runId: "run-a",
    }));

    expect(response.status).toBe(200);
    expect(runtime.run).toHaveBeenCalledWith({
      request: authenticated.request,
      actionId: "assistant.read",
      arguments: { resourceId: "resource-a" },
      idempotencyKey: "idempotency-a",
      runId: "run-a",
    });
  });
});
