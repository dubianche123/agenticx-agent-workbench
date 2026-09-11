import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateDesktopAssistantRequest: vi.fn(),
  assistantActionRuntime: vi.fn(),
  assistantErrorResponse: vi.fn(),
}));

vi.mock("../../../../../../../../lib/desktop-assistant", () => ({
  authenticateDesktopAssistantRequest: (...args: unknown[]) => mocks.authenticateDesktopAssistantRequest(...args),
  assistantActionRuntime: (...args: unknown[]) => mocks.assistantActionRuntime(...args),
  assistantErrorResponse: (...args: unknown[]) => mocks.assistantErrorResponse(...args),
}));

function request(body?: string): Request {
  return new Request("http://localhost/api/desktop/assistant/operations/op-a/confirm", {
    method: "POST",
    headers: { authorization: "Bearer session-token", ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body }),
  });
}

describe("POST /api/desktop/assistant/operations/[id]/confirm", () => {
  beforeEach(() => {
    mocks.authenticateDesktopAssistantRequest.mockReset();
    mocks.assistantActionRuntime.mockReset();
    mocks.assistantErrorResponse.mockReset();
    mocks.authenticateDesktopAssistantRequest.mockResolvedValue({ request: { tenantId: "tenant-a", userId: "user-a" } });
    mocks.assistantActionRuntime.mockReturnValue({ confirm: vi.fn().mockResolvedValue({ status: "confirmed" }) });
    mocks.assistantErrorResponse.mockImplementation((error: { code?: string; message?: string; status?: number }) => ({
      body: { code: error.code ?? "ACTION_EXECUTION_FAILED", message: error.message ?? "action request failed" },
      status: error.status ?? 400,
    }));
  });

  it("rejects model supplied confirmation fields", async () => {
    const { POST } = await import("../route");
    const response = await POST(request(JSON.stringify({ confirmed: true })) , { params: Promise.resolve({ id: "op-a" }) });
    expect(response.status).toBe(400);
    expect(mocks.authenticateDesktopAssistantRequest).not.toHaveBeenCalled();
  });

  it("surfaces a revoked-session freshness failure", async () => {
    mocks.authenticateDesktopAssistantRequest.mockRejectedValue({
      code: "ASSISTANT_SESSION_REVOKED",
      message: "assistant session has expired or was revoked",
      status: 401,
    });
    const { POST } = await import("../route");
    const response = await POST(request(), { params: Promise.resolve({ id: "op-a" }) });
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      code: "ASSISTANT_SESSION_REVOKED",
      message: "assistant session has expired or was revoked",
    });
  });

  it("uses the authenticated session request when confirming an operation", async () => {
    const runtime = { confirm: vi.fn().mockResolvedValue({ status: "confirmed" }) };
    const authenticated = { request: { tenantId: "tenant-a", userId: "user-a", agentPrincipalId: "agent-a" } };
    mocks.authenticateDesktopAssistantRequest.mockResolvedValue(authenticated);
    mocks.assistantActionRuntime.mockReturnValue(runtime);
    const { POST } = await import("../route");
    const response = await POST(request(), { params: Promise.resolve({ id: "op-a" }) });
    expect(response.status).toBe(200);
    expect(runtime.confirm).toHaveBeenCalledWith({ request: authenticated.request, operationId: "op-a" });
  });
});
