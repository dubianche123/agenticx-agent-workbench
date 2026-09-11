import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAdminScope: vi.fn(),
  getSupportBootstrap: vi.fn(),
  handleSupportChat: vi.fn(),
  executeSupportProposal: vi.fn(),
  supportStorageKey: vi.fn(),
  supportErrorResponseMessage: vi.fn((error: unknown) => ({
    status: 500,
    code: "50000",
    message: error instanceof Error ? error.message : "failed",
  })),
}));

vi.mock("../../../../lib/admin-auth", () => ({
  requireAdminScope: (...args: unknown[]) => mocks.requireAdminScope(...args),
}));
vi.mock("../../../../lib/support-assistant/assistant", () => ({
  getSupportBootstrap: (...args: unknown[]) => mocks.getSupportBootstrap(...args),
  handleSupportChat: (...args: unknown[]) => mocks.handleSupportChat(...args),
  executeSupportProposal: (...args: unknown[]) => mocks.executeSupportProposal(...args),
  supportStorageKey: (...args: unknown[]) => mocks.supportStorageKey(...args),
  supportErrorResponseMessage: (error: unknown) => mocks.supportErrorResponseMessage(error),
}));

import { GET } from "../route";
import { POST as postChat } from "../chat/route";
import { POST as postExecute } from "../execute/route";

const session = { tenantId: "tenant-a", userId: "admin-a", email: "admin@example.com" };

describe("admin support API boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.supportStorageKey.mockReturnValue("agenticx-support:v1:admin:tenant-a:admin-a");
    mocks.requireAdminScope.mockResolvedValue({ ok: true, session, scopes: ["admin:enter", "user:update"] });
    mocks.getSupportBootstrap.mockResolvedValue({
      storageKey: "agenticx-support:v1:admin:tenant-a:admin-a",
      title: "后台智能助手",
      suggestions: ["怎样查找成员？"],
      models: [{ id: "openai/gpt", label: "GPT" }],
    });
    mocks.handleSupportChat.mockResolvedValue({ message: "已回答", links: [] });
    mocks.executeSupportProposal.mockResolvedValue("已完成");
  });

  it("returns an authenticated, tenant-scoped bootstrap envelope", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      code: "00000",
      data: { storageKey: "agenticx-support:v1:admin:tenant-a:admin-a" },
    });
    expect(mocks.requireAdminScope).toHaveBeenCalledWith(["admin:enter"]);
    expect(mocks.getSupportBootstrap).toHaveBeenCalledWith(session);
  });

  it("rejects a stale or missing support principal before parsing or forwarding messages", async () => {
    const request = new Request("https://admin.example.com/api/support/chat", {
      method: "POST",
      body: JSON.stringify({ messages: [{ role: "user", content: "hello" }], page: { path: "/dashboard" } }),
    });
    const response = await postChat(request);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: "40903" });
    expect(mocks.handleSupportChat).not.toHaveBeenCalled();
  });

  it("uses the shared parser and forwards only the supported chat fields", async () => {
    const request = new Request("https://admin.example.com/api/support/chat", {
      method: "POST",
      headers: { "x-agenticx-support-scope": "agenticx-support:v1:admin:tenant-a:admin-a" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "查一下 Alice" }],
        page: { path: "/iam/roles", tab: "members" },
        model: "openai/gpt",
      }),
    });
    const response = await postChat(request);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ data: { message: "已回答" } });
    expect(mocks.handleSupportChat).toHaveBeenCalledWith(expect.objectContaining({
      actor: session,
      scopes: ["admin:enter", "user:update"],
      storageKey: "agenticx-support:v1:admin:tenant-a:admin-a",
      messages: [{ role: "user", content: "查一下 Alice" }],
      page: { path: "/iam/roles", tab: "members" },
      model: "openai/gpt",
      signal: expect.any(AbortSignal),
    }));
  });

  it("rejects executable parameters and requires both admin identity and update scope", async () => {
    mocks.requireAdminScope.mockResolvedValueOnce({
      ok: true,
      session,
      scopes: ["admin:enter", "user:update"],
    });
    const tampered = new Request("https://admin.example.com/api/support/execute", {
      method: "POST",
      body: JSON.stringify({ proposalId: "sap-one", operation: { monthlyTokens: 1 } }),
    });
    const invalid = await postExecute(tampered);
    expect(invalid.status).toBe(400);
    expect(mocks.executeSupportProposal).not.toHaveBeenCalled();

    mocks.requireAdminScope.mockResolvedValueOnce({
      ok: false,
      response: new Response(JSON.stringify({ code: "40300" }), { status: 403 }),
    });
    const denied = await postExecute(new Request("https://admin.example.com/api/support/execute", {
      method: "POST",
      body: JSON.stringify({ proposalId: "sap-one" }),
    }));
    expect(denied.status).toBe(403);
    expect(mocks.requireAdminScope).toHaveBeenLastCalledWith(["admin:enter", "user:update"]);
  });

  it("executes only the server-owned proposal id after the second auth check", async () => {
    const response = await postExecute(new Request("https://admin.example.com/api/support/execute", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ proposalId: "sap-one" }),
    }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ code: "00000", data: { message: "已完成" } });
    expect(mocks.executeSupportProposal).toHaveBeenCalledWith({ actor: session, proposalId: "sap-one" });
  });
});
