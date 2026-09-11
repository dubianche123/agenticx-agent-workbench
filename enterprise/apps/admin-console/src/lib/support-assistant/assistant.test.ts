import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AssistantActionInvocationResult,
  AssistantLoopMessage,
  AssistantLoopRequestModel,
  AssistantModelResponse,
  PublicAction,
} from "@agenticx/action-runtime";
import type { SupportActionAdapter } from "./action-runtime";

const mocks = vi.hoisted(() => ({
  getAdminUser: vi.fn(),
  aggregateScopesForUser: vi.fn(),
  createSessionGrant: vi.fn(),
  signContexts: [] as unknown[],
  resolveSupportModel: vi.fn(),
  listSupportModelsForUser: vi.fn(),
  splitSupportModelId: vi.fn(),
  createSupportActionAdapter: vi.fn(),
  confirmSupportAction: vi.fn(),
  scopes: [] as string[],
}));

vi.mock("@agenticx/iam-core", () => ({
  getAdminUser: (...args: unknown[]) => mocks.getAdminUser(...args),
  aggregateScopesForUser: (...args: unknown[]) => mocks.aggregateScopesForUser(...args),
  createSessionGrant: (...args: unknown[]) => mocks.createSessionGrant(...args),
  hasEveryScope: (granted: string[], required: string[]) =>
    granted.includes("*") || required.every((scope) => granted.includes(scope)),
}));

vi.mock("@agenticx/auth", () => ({
  JwtService: class FakeJwtService {
    public async signAccessToken(context: unknown) {
      mocks.signContexts.push(context);
      return { token: "ephemeral-support-token", expiresInSeconds: 300 };
    }
  },
}));

vi.mock("./model-access", () => ({
  resolveSupportModel: (...args: unknown[]) => mocks.resolveSupportModel(...args),
  listSupportModelsForUser: (...args: unknown[]) => mocks.listSupportModelsForUser(...args),
  splitSupportModelId: (...args: unknown[]) => mocks.splitSupportModelId(...args),
}));

// The production module remains lazy in assistant.ts. Mock only the two
// server-owned seams needed by this boundary test; the shared action loop is
// the real implementation imported from @agenticx/action-runtime.
vi.mock("./action-runtime", () => ({
  createSupportActionAdapter: (...args: unknown[]) => mocks.createSupportActionAdapter(...args),
  confirmSupportAction: (...args: unknown[]) => mocks.confirmSupportAction(...args),
}));

import {
  executeSupportProposal,
  handleSupportChat,
  supportErrorResponseMessage,
  supportStorageKey,
} from "./assistant";

const actor = { tenantId: "tenant-a", userId: "admin-a", email: "admin@example.com" };
const admin = {
  ...actor,
  displayName: "Admin A",
  deptId: "dept-admin",
  status: "active" as const,
  roleCodes: ["admin"],
  scopes: [],
};
const target = {
  id: "member-a",
  tenantId: "tenant-a",
  email: "member@example.com",
  displayName: "Member A",
  deptId: "dept-a",
  status: "active" as const,
  roleCodes: ["member"],
  scopes: ["workspace:chat"],
};
const selectedModel = {
  id: "provider/assistant",
  label: "Assistant",
  provider: "provider",
  model: "assistant",
  isDefault: true,
};

function publicAction(input: {
  id: string;
  label: string;
  description: string;
  effect: PublicAction["effect"];
  inputSchema?: Record<string, unknown>;
}): PublicAction {
  return {
    id: input.id,
    label: input.label,
    description: input.description,
    effect: input.effect,
    inputSchema: input.inputSchema ?? { type: "object", additionalProperties: false },
  };
}

const quotaWrite = publicAction({
  id: "member.quota.set",
  label: "调整成员额度",
  description: "准备并确认一名成员的额度调整。",
  effect: "mutation",
  inputSchema: {
    type: "object",
    required: ["userId", "monthlyTokens"],
    properties: {
      userId: { type: "string", minLength: 1 },
      monthlyTokens: { type: "number", minimum: 0 },
    },
    additionalProperties: false,
  },
});

const memberSearch = publicAction({
  id: "member.search",
  label: "搜索企业成员",
  description: "按公开身份字段搜索当前企业成员。",
  effect: "query",
  inputSchema: {
    type: "object",
    required: ["q"],
    properties: { q: { type: "string", minLength: 1 } },
    additionalProperties: false,
  },
});

const gatewayHealth = publicAction({
  id: "gateway.health.read",
  label: "查看网关状态",
  description: "查看企业网关的受限健康探测结果。",
  effect: "query",
});

function adapterFor(
  actions: readonly PublicAction[],
  result: AssistantActionInvocationResult = { status: "succeeded", output: {} },
): SupportActionAdapter {
  return {
    discover: vi.fn(async () => actions),
    invoke: vi.fn(async () => result),
  };
}

function toolResponse(actionId: string, args: unknown, id = "call-1"): AssistantModelResponse {
  return {
    toolCalls: [{
      id,
      name: "enterprise_action",
      arguments: { actionId, arguments: args },
    }],
  };
}

function transportSequence(...responses: AssistantModelResponse[]): {
  transport: AssistantLoopRequestModel;
  calls: Array<{ messages: readonly AssistantLoopMessage[] }>;
} {
  let index = 0;
  const calls: Array<{ messages: readonly AssistantLoopMessage[] }> = [];
  const transport = vi.fn(async (input: Parameters<AssistantLoopRequestModel>[0]) => {
    calls.push({ messages: input.messages });
    return responses[Math.min(index++, Math.max(0, responses.length - 1))] ?? { content: "" };
  }) as unknown as AssistantLoopRequestModel;
  return { transport, calls };
}

function chatInput(input: Partial<Parameters<typeof handleSupportChat>[0]> = {}): Parameters<typeof handleSupportChat>[0] {
  return {
    actor,
    scopes: [],
    storageKey: supportStorageKey(actor),
    messages: [{ role: "user", content: "请说明当前页面可以做什么？" }],
    page: { path: "/iam/roles" },
    ...input,
  };
}

beforeEach(() => {
  mocks.signContexts.length = 0;
  mocks.scopes = ["admin:enter", "workspace:chat", "user:read", "user:update"];
  mocks.getAdminUser.mockImplementation(async (...args: unknown[]) => {
    const [tenantId, userId] = args as [string, string];
    if (tenantId !== actor.tenantId) return null;
    if (userId === actor.userId) return admin;
    if (userId === target.id) return target;
    return null;
  });
  mocks.aggregateScopesForUser.mockImplementation(async () => [...mocks.scopes]);
  mocks.createSessionGrant.mockResolvedValue({ id: "grant-1" });
  mocks.resolveSupportModel.mockResolvedValue({ selected: selectedModel, available: [selectedModel] });
  mocks.listSupportModelsForUser.mockResolvedValue([selectedModel]);
  mocks.splitSupportModelId.mockReturnValue({ provider: "provider", model: "assistant" });
  mocks.createSupportActionAdapter.mockResolvedValue(adapterFor([]));
  mocks.confirmSupportAction.mockResolvedValue({});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("admin intelligent assistant action-loop boundary", () => {
  it("runs the real shared loop with injected server adapter and model transport", async () => {
    const adapter = adapterFor([quotaWrite], {
      status: "awaiting_confirmation",
      operationId: "op-loop-1",
      proposal: {
        title: "调整成员额度",
        changes: [{ label: "月额度", before: "1000", after: "9000" }],
        expiresAt: "2026-09-11T12:00:00.000Z",
      },
    });
    const { transport, calls } = transportSequence(toolResponse(quotaWrite.id, {
      userId: target.id,
      monthlyTokens: 9_000,
    }));

    const response = await handleSupportChat(chatInput({
      messages: [{ role: "user", content: "把 Member A 的月额度改为 9000" }],
      actionAdapterOverride: adapter,
      modelTransportOverride: transport,
    }));

    expect(response.proposal).toMatchObject({
      id: "op-loop-1",
      title: "调整成员额度",
      changes: [{ label: "月额度", before: "1000", after: "9000" }],
    });
    expect(adapter.invoke).toHaveBeenCalledWith(expect.objectContaining({
      actionId: quotaWrite.id,
      arguments: { userId: target.id, monthlyTokens: 9_000 },
    }));
    expect(calls[0]?.messages[0]?.role).toBe("system");
  });

  it("uses the server-owned Gateway transport when no model override is supplied", async () => {
    const adapter = adapterFor([quotaWrite], {
      status: "awaiting_confirmation",
      operationId: "op-gateway-1",
      proposal: { title: "额度调整", changes: { monthlyTokens: 9000 } },
    });
    const fetchSpy = vi.fn(async (url: unknown, init?: RequestInit) => {
      expect(url).toBe("http://127.0.0.1:8088/v1/chat/completions");
      const body = JSON.parse(String(init?.body)) as { model?: string; tools?: unknown[]; messages?: unknown[]; max_tokens?: number };
      expect(body.model).toBe("assistant");
      expect(body.max_tokens).toBe(32_768);
      expect(body.tools?.[0]).toMatchObject({ type: "function", function: { name: "enterprise_action" } });
      expect(body.messages?.[0]).toMatchObject({ role: "system" });
      return new Response(JSON.stringify({
        id: "chatcmpl-real-answer",
        choices: [{ message: { tool_calls: [{
          id: "gateway-call-1",
          type: "function",
          function: { name: "enterprise_action", arguments: JSON.stringify({ actionId: quotaWrite.id, arguments: { userId: target.id, monthlyTokens: 9_000 } }) },
        }] } }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const response = await handleSupportChat(chatInput({
      messages: [{ role: "user", content: "把 Member A 的月额度改为 9000" }],
      actionAdapterOverride: adapter,
    }));

    expect(response.proposal?.id).toBe("op-gateway-1");
    expect(mocks.signContexts).toHaveLength(1);
    expect(mocks.signContexts[0]).toMatchObject({
      userId: actor.userId,
      tenantId: actor.tenantId,
      deptId: admin.deptId,
      scopes: ["workspace:chat"],
    });
  });

  it("answers the health shortcut only through the discovered action and forwards cancellation", async () => {
    mocks.scopes = ["admin:enter", "workspace:chat", "gateway:read"];
    const adapter = adapterFor([gatewayHealth], { status: "succeeded", output: { status: "healthy" } });
    const signal = new AbortController().signal;

    const response = await handleSupportChat(chatInput({
      messages: [{ role: "user", content: "当前网关是否健康？" }],
      signal,
      actionAdapterOverride: adapter,
    }));

    expect(response.message).toContain("网关健康");
    expect(response.links).toEqual([
      { label: "打开网关工作区", href: "/admin/gateway" },
      { label: "打开诊断", href: "/admin/diagnostics" },
    ]);
    expect(adapter.discover).toHaveBeenCalledWith(signal);
    expect(adapter.invoke).toHaveBeenCalledWith(expect.objectContaining({ actionId: gatewayHealth.id, signal }));
  });

  it("fails closed when the health action is not discovered", async () => {
    mocks.scopes = ["admin:enter", "workspace:chat", "gateway:read"];
    const adapter = adapterFor([]);
    const response = await handleSupportChat(chatInput({
      messages: [{ role: "user", content: "当前网关是否健康？" }],
      actionAdapterOverride: adapter,
    }));

    expect(response.message).toContain("没有网关读取操作权限");
    expect(adapter.invoke).not.toHaveBeenCalled();
  });

  it("keeps reviewed help when the model transport returns a development placeholder", async () => {
    const transport = vi.fn(async () => {
      throw new Error("gateway returned a development mock response");
    }) as unknown as AssistantLoopRequestModel;
    const response = await handleSupportChat(chatInput({
      actionAdapterOverride: adapterFor([]),
      modelTransportOverride: transport,
    }));

    expect(response.message).toContain("没有可用的真实模型推理");
    expect(response.message).not.toContain("开发模式 mock");
    expect(response.proposal).toBeUndefined();
  });

  it("returns grounded prose and refuses an unverified mutation claim", async () => {
    const grounded = transportSequence({ content: "当前页面可以查看成员的模型和额度状态。" });
    const answer = await handleSupportChat(chatInput({
      actionAdapterOverride: adapterFor([]),
      modelTransportOverride: grounded.transport,
    }));
    expect(answer.message).toContain("当前页面可以查看成员的模型和额度状态");

    const claim = transportSequence({ content: "配置已生效，模型已经设置完成。" });
    const refused = await handleSupportChat(chatInput({
      actionAdapterOverride: adapterFor([]),
      modelTransportOverride: claim.transport,
    }));
    expect(refused.message).toContain("服务端没有验证配置变更，未执行任何写入");
    expect(refused.message).not.toContain("配置已生效");
  });

  it("feeds malformed tool arguments back to the real loop and never invokes the adapter", async () => {
    const adapter = adapterFor([memberSearch]);
    const { transport, calls } = transportSequence(
      { toolCalls: [{ id: "bad-call", name: "enterprise_action", arguments: { actionId: memberSearch.id, arguments: "not-json" } }] },
      { content: "无法使用无效参数完成成员搜索。" },
    );

    const response = await handleSupportChat(chatInput({
      messages: [{ role: "user", content: "搜索 Alice" }],
      actionAdapterOverride: adapter,
      modelTransportOverride: transport,
    }));

    expect(response.message).toContain("服务端未完成请求中的一项操作");
    expect(adapter.invoke).not.toHaveBeenCalled();
    expect(calls[1]?.messages.some((message) => message.role === "tool" && message.content?.includes("ACTION_VALIDATION_FAILED"))).toBe(true);
  });

  it("does not revive the removed typed-intent protocol and strips prior reasoning from context", async () => {
    const adapter = adapterFor([quotaWrite]);
    const { transport, calls } = transportSequence({
      content: JSON.stringify({ kind: "prepare_quota_change", targetQuery: target.email, monthlyTokens: 9_000 }),
    });

    const response = await handleSupportChat(chatInput({
      messages: [
        { role: "user", content: "先查看 Member A" },
        { role: "assistant", content: '<think>previous internal plan</think>{"kind":"member_quota","targetQuery":"member@example.com"}' },
        { role: "user", content: "把 Member A 月额度设为 9000" },
      ],
      actionAdapterOverride: adapter,
      modelTransportOverride: transport,
    }));

    expect(response.proposal).toBeUndefined();
    expect(response.message).toContain("没有执行任何配置变更");
    expect(adapter.invoke).not.toHaveBeenCalled();
    expect(calls[0]?.messages.some((message) => message.role === "assistant" && message.content?.includes("<think>"))).toBe(false);
    expect(calls[0]?.messages).toContainEqual({
      role: "assistant",
      content: '{"kind":"member_quota","targetQuery":"member@example.com"}',
    });
  });

  it("confirms only through the exported server-owned confirmation seam", async () => {
    const adapter = adapterFor([quotaWrite], {
      status: "awaiting_confirmation",
      operationId: "op-confirm-1",
      proposal: { title: "额度调整", changes: { monthlyTokens: 9000 } },
    });
    const { transport } = transportSequence(toolResponse(quotaWrite.id, { userId: target.id, monthlyTokens: 9_000 }));
    const response = await handleSupportChat(chatInput({
      messages: [{ role: "user", content: "把 Member A 的月额度改为 9000" }],
      actionAdapterOverride: adapter,
      modelTransportOverride: transport,
    }));

    mocks.confirmSupportAction.mockResolvedValueOnce({ userId: target.id, status: "succeeded" });
    const result = await executeSupportProposal({ actor, proposalId: response.proposal!.id });

    expect(mocks.confirmSupportAction).toHaveBeenCalledWith({ actor, operationId: "op-confirm-1" });
    expect(result).toContain("Member A");
  });
});

describe("admin intelligent assistant authorization boundary", () => {
  it("rejects a changed storage principal before model or action access", async () => {
    await expect(handleSupportChat(chatInput({ storageKey: "agenticx-support:v1:admin:tenant-a:other" })))
      .rejects.toMatchObject({ code: "40903" });
    expect(mocks.resolveSupportModel).not.toHaveBeenCalled();
  });

  it("keeps page help when the live session lacks model inference scope", async () => {
    mocks.scopes = ["admin:enter", "user:read", "user:update"];
    const { transport } = transportSequence({ content: "should not be called" });
    const response = await handleSupportChat(chatInput({
      actionAdapterOverride: adapterFor([]),
      modelTransportOverride: transport,
    }));

    expect(response.message).toContain("没有模型会话权限");
    expect(transport).not.toHaveBeenCalled();
  });

  it("maps durable stale and uncertain outcomes at the route boundary", () => {
    expect(supportErrorResponseMessage({ code: "ENTERPRISE_CONTEXT_STALE", status: 409 })).toMatchObject({
      status: 409,
      code: "ENTERPRISE_CONTEXT_STALE",
    });
    expect(supportErrorResponseMessage({ code: "ACTION_OUTCOME_UNKNOWN", status: 503 })).toMatchObject({
      status: 503,
      code: "ACTION_OUTCOME_UNKNOWN",
      message: expect.stringContaining("无法确认"),
    });
  });
});
