import { describe, expect, it, vi } from "vitest";
import type { PortalModelOption } from "../admin-providers-reader";
import {
  answerWithPortalGateway,
  choosePermittedModel,
  isRegisteredHistoryQuestion,
  isDevelopmentMockGatewayResponse,
  sanitizeSupportContent,
  safeQuotaFacts,
  staticSupportResponse,
  supportStorageKey,
  type PortalSupportActionAdapter,
} from "./server";
import type { PublicAction } from "@agenticx/action-runtime";

const models: PortalModelOption[] = [
  {
    id: "local/assistant",
    provider: "local",
    providerLabel: "本地",
    model: "assistant",
    label: "本地助手",
    route: "local",
    isDefault: false,
  },
  {
    id: "private/answer",
    provider: "private",
    providerLabel: "私有",
    model: "answer",
    label: "私有回答",
    route: "private-cloud",
    isDefault: true,
  },
];

describe("Portal support server helpers", () => {
  it("namespaces independent support history by tenant and user", () => {
    expect(supportStorageKey({ tenantId: "tenant/a", userId: "user 1" })).toContain("portal");
    expect(supportStorageKey({ tenantId: "tenant/a", userId: "user 1" })).not.toBe(
      supportStorageKey({ tenantId: "tenant/a", userId: "user 2" }),
    );
  });

  it("honors an exact permitted model and otherwise uses the configured default", () => {
    expect(choosePermittedModel(models)?.id).toBe("private/answer");
    expect(choosePermittedModel(models, "local/assistant")?.id).toBe("local/assistant");
    expect(choosePermittedModel(models, "other/model")).toBeNull();
  });

  it("formats only safe self quota facts and keeps static help available", () => {
    expect(safeQuotaFacts({
      daily: { remaining: 9, used: 1, limit: 10, unlimited: false, scope: "user", scopeId: "u", period: "d" },
      weekly: { remaining: null, used: 0, limit: 0, unlimited: true, scope: "user", scopeId: "u", period: "w" },
      monthly: { remaining: 99, used: 1, limit: 100, unlimited: false, scope: "user", scopeId: "u", period: "m" },
      user: { remaining: 99, used: 1, limit: 100, unlimited: false, scope: "user", scopeId: "u", period: "m" },
      dept: null,
      unlimited: false,
    })).toContain("今日剩余 9");
    expect(staticSupportResponse({ path: "/workspace", tab: "chat" }, false).message).toContain("没有可用的授权模型");
  });

  it("only classifies the Gateway's explicit development marker as a mock response", () => {
    expect(isDevelopmentMockGatewayResponse(
      { id: "chatcmpl_mock_123" },
      "模型返回了普通内容",
    )).toBe(true);
    expect(isDevelopmentMockGatewayResponse(
      { id: "chatcmpl_live_123" },
      "这里提到 mock 作为示例",
    )).toBe(false);
  });

  it("recognizes natural old-chat history questions without matching unrelated notification history", () => {
    expect(isRegisteredHistoryQuestion("更早的聊天历史从哪里找？")).toBe(true);
    expect(isRegisteredHistoryQuestion("历史会话从哪里打开？")).toBe(true);
    expect(isRegisteredHistoryQuestion("我想查看聊天记录")).toBe(true);
    expect(isRegisteredHistoryQuestion("Where can I find my old previous chats?")).toBe(true);
    expect(isRegisteredHistoryQuestion("如何查看通知历史？")).toBe(false);
    expect(isRegisteredHistoryQuestion("unrelatedhistory")).toBe(false);
  });

  it("removes complete and unfinished provider reasoning before support replies or context", () => {
    expect(sanitizeSupportContent("<think>Page is not in the registry.</think>请打开设置。"))
      .toBe("请打开设置。");
    expect(sanitizeSupportContent("答案前缀<think>尚未完成的内部分析"))
      .toBe("答案前缀");
    expect(sanitizeSupportContent("<analysis>内部分析</analysis>正文<think>第二段思考</think>结论"))
      .toBe("正文结论");
    expect(sanitizeSupportContent("隐式推理内容</think>最终答案"))
      .toBe("最终答案");
    expect(sanitizeSupportContent("<analysis>只有推理，没有正文"))
      .toBe("");
  });

  it("runs an authorized read through enterprise_action and grounds the next model turn", async () => {
    const principal = {
      tenantId: "tenant-a",
      userId: "user-a",
      email: "a@example.com",
      deptId: "dept-a",
      sessionId: "session-a",
      mustChangePassword: false,
    };
    const actionAdapter: PortalSupportActionAdapter = {
      discover: vi.fn(async (): Promise<readonly PublicAction[]> => [{
        id: "usage.analytics.read",
        label: "分析企业用量",
        description: "按授权范围聚合用量。",
        effect: "query",
        inputSchema: {
          type: "object",
          required: ["groupBy", "metric"],
          properties: { groupBy: { type: "string" }, metric: { type: "string" } },
          additionalProperties: false,
        },
      }]),
      invoke: vi.fn(async () => ({
        status: "succeeded" as const,
        output: { rows: [{ department: "演示研发部", totalTokens: 1200 }] },
      })),
    };
    const gateway = vi.spyOn(globalThis, "fetch");
    gateway
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { tool_calls: [{ id: "call-1", type: "function", function: {
          name: "enterprise_action",
          arguments: JSON.stringify({ actionId: "usage.analytics.read", arguments: { groupBy: "department", metric: "totalTokens" } }),
        } }] } }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: "本月演示研发部用量最高，共 1200 Token。" } }],
      }), { status: 200 }));
    try {
      const response = await answerWithPortalGateway(
        new Request("http://localhost/api/support/chat"),
        principal,
        { path: "/workspace", tab: "chat" },
        [{ role: "user", content: "本月哪个部门用量最高？" }],
        models[1]!,
        "trusted-cookie-access-token",
        actionAdapter,
      );
      expect(response.ok).toBe(true);
      if (response.ok) expect(response.response.message).toContain("演示研发部");
      expect(actionAdapter.invoke).toHaveBeenCalledWith(expect.objectContaining({
        actionId: "usage.analytics.read",
        arguments: { groupBy: "department", metric: "totalTokens" },
      }));
      const secondBody = JSON.parse(String(gateway.mock.calls[1]?.[1]?.body)) as { messages?: Array<{ role?: string; content?: string }> };
      expect(secondBody.messages?.at(-1)?.role).toBe("tool");
      expect(secondBody.messages?.at(-1)?.content).toContain("演示研发部");
    } finally {
      gateway.mockRestore();
    }
  });

  it("does not expose a portal model's unverified mutation claim", async () => {
    const principal = {
      tenantId: "tenant-a",
      userId: "user-a",
      email: "a@example.com",
      deptId: "dept-a",
      sessionId: "session-a",
      mustChangePassword: false,
    };
    const actionAdapter: PortalSupportActionAdapter = {
      discover: vi.fn(async (): Promise<readonly PublicAction[]> => [{
        id: "member.quota.set",
        label: "调整成员额度",
        description: "准备成员额度调整。",
        effect: "mutation",
        inputSchema: { type: "object", required: ["userId"], additionalProperties: false },
      }]),
      invoke: vi.fn(),
    };
    const gateway = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({
      choices: [{ message: { content: "已把额度改为 1，配置已生效。" } }],
    }), { status: 200 }));
    try {
      const response = await answerWithPortalGateway(
        new Request("http://localhost/api/support/chat"),
        principal,
        { path: "/workspace", tab: "chat" },
        [{ role: "user", content: "把额度改成 1" }],
        models[1]!,
        "trusted-cookie-access-token",
        actionAdapter,
      );
      expect(response.ok).toBe(true);
      if (response.ok) {
        expect(response.response.message).toContain("未执行任何写入");
        expect(response.response.message).not.toContain("已把额度改为 1");
      }
      expect(actionAdapter.invoke).not.toHaveBeenCalled();
    } finally {
      gateway.mockRestore();
    }
  });
});
