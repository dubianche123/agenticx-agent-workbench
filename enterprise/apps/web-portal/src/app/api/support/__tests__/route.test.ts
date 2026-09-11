import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSessionAuthFromCookies: vi.fn(),
  passwordChangeRequiredResponse: vi.fn(() => Response.json({ code: "40302", message: "password_change_required" }, { status: 403 })),
  listAvailableModelsForUser: vi.fn(),
  getQuotaSummaryForSession: vi.fn(),
}));

vi.mock("../../../../lib/session", () => ({
  getSessionAuthFromCookies: mocks.getSessionAuthFromCookies,
  passwordChangeRequiredResponse: mocks.passwordChangeRequiredResponse,
}));
vi.mock("../../../../lib/admin-providers-reader", () => ({
  listAvailableModelsForUser: mocks.listAvailableModelsForUser,
}));
vi.mock("@agenticx/iam-core", () => ({
  getQuotaSummaryForSession: mocks.getQuotaSummaryForSession,
}));

import { GET } from "../route";
import { POST } from "../chat/route";
import { supportStorageKey } from "../../../../lib/support-assistant/server";

const session = {
  userId: "user-a",
  tenantId: "tenant-a",
  email: "a@example.com",
  scopes: ["workspace:chat"],
  mustChangePassword: false,
  deptId: "dept-a",
  sessionId: "session-a",
};

const auth = { session, accessToken: "access-token", refreshToken: null };

const model = {
  id: "private/assistant",
  provider: "private",
  providerLabel: "Private",
  model: "assistant",
  label: "Private Assistant",
  route: "private-cloud" as const,
  isDefault: true,
};

describe("Portal contextual support routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionAuthFromCookies.mockResolvedValue(auth);
    mocks.listAvailableModelsForUser.mockResolvedValue([model]);
    mocks.getQuotaSummaryForSession.mockResolvedValue({
      daily: { remaining: 10, used: 0, limit: 10, unlimited: false },
      weekly: { remaining: null, used: 0, limit: 0, unlimited: true },
      monthly: { remaining: 100, used: 0, limit: 100, unlimited: false },
      user: { remaining: 100, used: 0, limit: 100, unlimited: false },
      dept: null,
      unlimited: false,
    });
  });

  it("authenticates bootstrap and returns only identity-scoped model ids", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.storageKey).toContain("tenant-a");
    expect(body.data.storageKey).toContain("user-a");
    expect(body.data.models).toEqual([{ id: "private/assistant", label: "Private Assistant" }]);
    expect(body.data).not.toHaveProperty("accessToken");
    expect(body.data).not.toHaveProperty("links");
    expect(mocks.listAvailableModelsForUser).toHaveBeenCalledWith(session);
  });

  it("serves static contextual help without calling the Gateway when no model is configured", async () => {
    mocks.listAvailableModelsForUser.mockResolvedValueOnce([]);
    const gateway = vi.spyOn(globalThis, "fetch");
    const response = await POST(new Request("http://localhost/api/support/chat", {
      method: "POST",
      body: JSON.stringify({
        messages: [{ role: "user", content: "我现在可以做什么？" }],
        page: { path: "/workspace", tab: "chat" },
      }),
      headers: { "content-type": "application/json", "x-agenticx-support-scope": supportStorageKey(session) },
    }));
    expect(response.status).toBe(200);
    expect((await response.json()).data.message).toContain("没有可用的授权模型");
    expect(gateway).not.toHaveBeenCalled();
    gateway.mockRestore();
  });

  it("rejects a model outside the current effective model list", async () => {
    const response = await POST(new Request("http://localhost/api/support/chat", {
      method: "POST",
      body: JSON.stringify({
        messages: [{ role: "user", content: "回答问题" }],
        page: { path: "/workspace" },
        model: "third-party/not-visible",
      }),
      headers: { "x-agenticx-support-scope": supportStorageKey(session) },
    }));
    expect(response.status).toBe(403);
  });

  it("forwards support context through the Gateway with the session identity", async () => {
    const gateway = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ choices: [{ message: { content: "请在输入区开始新的对话。" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const response = await POST(new Request("http://localhost/api/support/chat", {
      method: "POST",
      body: JSON.stringify({
        messages: [{ role: "user", content: "如何开始？" }],
        page: { path: "/workspace", tab: "chat" },
        model: model.id,
      }),
      headers: { "x-agenticx-support-scope": supportStorageKey(session) },
    }));
    expect(response.status).toBe(200);
    expect((await response.json()).data.message).toContain("输入区");
    expect(gateway).toHaveBeenCalledTimes(1);
    const [url, init] = gateway.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/v1/chat/completions");
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer access-token");
    expect(headers.get("x-tenant-id")).toBe("tenant-a");
    expect(headers.get("x-user-id")).toBe("user-a");
    expect(headers.get("x-session-id")).toBe("support:session-a");
    expect(headers.get("x-agenticx-trace-stage")).toBe("support.answer");
    const forwarded = JSON.parse(String(init.body)) as { model: string; messages: Array<{ role: string; content: string }> };
    expect(forwarded.model).toBe("assistant");
    expect(forwarded.messages.at(-1)?.content).toBe("如何开始？");
    expect(forwarded.messages[0]?.role).toBe("system");
    gateway.mockRestore();
  });

  it("removes provider reasoning from the reply and prior assistant context", async () => {
    const gateway = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({
        choices: [{ message: { content: "<think>Page is not in the registry.</think>实际答案" } }],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const response = await POST(new Request("http://localhost/api/support/chat", {
      method: "POST",
      body: JSON.stringify({
        messages: [
          { role: "user", content: "前一个问题" },
          { role: "assistant", content: "<analysis>历史内部推理</analysis>历史答案" },
          { role: "user", content: "继续说明" },
        ],
        page: { path: "/workspace", tab: "settings" },
        model: model.id,
      }),
      headers: { "x-agenticx-support-scope": supportStorageKey(session) },
    }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.message).toBe("实际答案");
    expect(body.data.message).not.toContain("<think>");
    const [, init] = gateway.mock.calls[0] as [string, RequestInit];
    const forwarded = JSON.parse(String(init.body)) as { messages: Array<{ role: string; content: string }> };
    expect(forwarded.messages[0]?.content).toContain("界面主题");
    expect(forwarded.messages[0]?.content).toContain("跟随系统");
    expect(forwarded.messages[0]?.content).toContain("/workspace#settings");
    expect(forwarded.messages.find((message) => message.role === "assistant")?.content).toBe("历史答案");
    expect(JSON.stringify(forwarded.messages)).not.toContain("历史内部推理");
    gateway.mockRestore();
  });

  it("adds the registered settings facts for a cross-page theme and language question", async () => {
    const gateway = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ choices: [{ message: { content: "请打开工作区设置。" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const response = await POST(new Request("http://localhost/api/support/chat", {
      method: "POST",
      body: JSON.stringify({
        messages: [{ role: "user", content: "如何切换界面主题和语言？" }],
        page: { path: "/workspace", tab: "chat" },
        model: model.id,
      }),
      headers: { "x-agenticx-support-scope": supportStorageKey(session) },
    }));
    expect(response.status).toBe(200);
    const [, init] = gateway.mock.calls[0] as [string, RequestInit];
    const forwarded = JSON.parse(String(init.body)) as { messages: Array<{ role: string; content: string }> };
    const systemInstruction = forwarded.messages[0]?.content ?? "";
    expect(systemInstruction).toContain("界面主题");
    expect(systemInstruction).toContain("跟随系统");
    expect(systemInstruction).toContain("浅色");
    expect(systemInstruction).toContain("深色");
    expect(systemInstruction).toContain("显示语言");
    expect(systemInstruction).toContain("中文");
    expect(systemInstruction).toContain("English");
    expect(systemInstruction).toContain("/workspace#settings");
    gateway.mockRestore();
  });

  it("does not add workspace navigation when the question is about the active chat model", async () => {
    const gateway = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ choices: [{ message: { content: "请从模型菜单选择已授权模型。" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const response = await POST(new Request("http://localhost/api/support/chat", {
      method: "POST",
      body: JSON.stringify({
        messages: [{ role: "user", content: "如何选择当前可用的模型？" }],
        page: { path: "/workspace", tab: "chat" },
        model: model.id,
      }),
      headers: { "x-agenticx-support-scope": supportStorageKey(session) },
    }));
    expect(response.status).toBe(200);
    const [, init] = gateway.mock.calls[0] as [string, RequestInit];
    const forwarded = JSON.parse(String(init.body)) as { messages: Array<{ role: string; content: string }> };
    expect(forwarded.messages[0]?.content).not.toContain("回到对话工作区");
    expect(forwarded.messages[0]?.content).not.toContain("/workspace#settings");
    gateway.mockRestore();
  });

  it("does not add settings facts for an unrelated theme question", async () => {
    const gateway = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ choices: [{ message: { content: "我无法确认该入口。" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const response = await POST(new Request("http://localhost/api/support/chat", {
      method: "POST",
      body: JSON.stringify({
        messages: [{ role: "user", content: "如何切换通知主题？" }],
        page: { path: "/workspace", tab: "chat" },
        model: model.id,
      }),
      headers: { "x-agenticx-support-scope": supportStorageKey(session) },
    }));
    expect(response.status).toBe(200);
    const [, init] = gateway.mock.calls[0] as [string, RequestInit];
    const forwarded = JSON.parse(String(init.body)) as { messages: Array<{ role: string; content: string }> };
    const systemInstruction = forwarded.messages[0]?.content ?? "";
    expect(systemInstruction).not.toContain("与当前问题直接相关的已注册跨页帮助");
    expect(systemInstruction).not.toContain("界面主题");
    expect(systemInstruction).not.toContain("跟随系统");
    expect(systemInstruction).not.toContain("显示语言");
    gateway.mockRestore();
  });

  it("adds the registered history guide for a cross-page history question", async () => {
    const gateway = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ choices: [{ message: { content: "请查看左侧对话列表。" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const response = await POST(new Request("http://localhost/api/support/chat", {
      method: "POST",
      body: JSON.stringify({
        messages: [{ role: "user", content: "查历史" }],
        page: { path: "/workspace", tab: "chat" },
        model: model.id,
      }),
      headers: { "x-agenticx-support-scope": supportStorageKey(session) },
    }));
    expect(response.status).toBe(200);
    const [, init] = gateway.mock.calls[0] as [string, RequestInit];
    const forwarded = JSON.parse(String(init.body)) as { messages: Array<{ role: string; content: string }> };
    const systemInstruction = forwarded.messages[0]?.content ?? "";
    expect(systemInstruction).toContain("历史记录");
    expect(systemInstruction).toContain("左侧对话列表");
    expect(systemInstruction).toContain("打开此前会话");
    expect(systemInstruction).toContain("查看全部");
    expect(systemInstruction).toContain("历史管理");
    expect(systemInstruction).not.toContain("仅供回答界面主题或显示语言问题");
    gateway.mockRestore();
  });

  it("turns the Gateway development mock into a readable static-help failure", async () => {
    const gateway = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({
        id: "chatcmpl_mock_123",
        choices: [{ message: { content: "（开发模式 mock 回复，未配置真实模型 Key）来自 glm-5-2" } }],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const response = await POST(new Request("http://localhost/api/support/chat", {
      method: "POST",
      body: JSON.stringify({
        messages: [{ role: "user", content: "如何开始？" }],
        page: { path: "/workspace", tab: "chat" },
        model: model.id,
      }),
      headers: { "x-agenticx-support-scope": supportStorageKey(session) },
    }));
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.message).toContain("开发模式");
    expect(body.message).toContain("尚未配置真实模型 Key");
    expect(body.data.message).toContain("静态指引");
    expect(body.data.message).not.toContain("来自 glm-5-2");
    gateway.mockRestore();
  });

  it("rejects executable fields before any model lookup", async () => {
    const response = await POST(new Request("http://localhost/api/support/chat", {
      method: "POST",
      body: JSON.stringify({
        messages: [{ role: "user", content: "help" }],
        page: { path: "/workspace" },
        execute: { proposalId: "p1" },
      }),
      headers: { "x-agenticx-support-scope": supportStorageKey(session) },
    }));
    expect(response.status).toBe(400);
    expect(mocks.listAvailableModelsForUser).not.toHaveBeenCalled();
  });
});
