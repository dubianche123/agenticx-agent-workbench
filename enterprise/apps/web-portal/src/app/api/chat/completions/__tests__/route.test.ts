import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSessionAuthFromCookies: vi.fn(),
  isChatSessionOwned: vi.fn(),
  listAvailableModelsForUser: vi.fn(),
  loadTenantWebSearchConfig: vi.fn(),
  loadTenantWebSearchConfigStrict: vi.fn(),
  planAutomaticTurn: vi.fn(),
  resolveManualDeepResearchQuery: vi.fn(),
  runDeepResearchTurn: vi.fn(),
  runWebSearchTurn: vi.fn(),
  withCalculatorContext: vi.fn(),
  isPlatformFeatureAllowedForUser: vi.fn(),
  isPlatformFeatureAllowedOnSurface: vi.fn(),
}));

vi.mock("../../../../../lib/session", () => ({
  ACCESS_COOKIE: "agx_access",
  REFRESH_COOKIE: "agx_refresh",
  getSessionAuthFromCookies: mocks.getSessionAuthFromCookies,
  isAuthCookieSecure: () => false,
  passwordChangeRequiredResponse: () => Response.json({}, { status: 403 }),
}));

vi.mock("../../../../../lib/auth-runtime", () => ({ refreshTokens: vi.fn() }));
vi.mock("../../../../../lib/chat-history", () => ({
  isChatSessionOwned: mocks.isChatSessionOwned,
}));
vi.mock("../../../../../lib/chat-history-http", () => ({
  toChatHistoryContext: (session: { tenantId: string; userId: string }) => ({
    tenantId: session.tenantId,
    userId: session.userId,
  }),
}));
vi.mock("../../../../../lib/admin-providers-reader", () => ({
  listAvailableModelsForUser: mocks.listAvailableModelsForUser,
}));
vi.mock("../../../../../lib/capability-packs-reader", () => ({
  isPlatformFeatureAllowedForUser: mocks.isPlatformFeatureAllowedForUser,
  isPlatformFeatureAllowedOnSurface: mocks.isPlatformFeatureAllowedOnSurface,
}));
vi.mock("../../../../../lib/web-search/tool-loop", () => ({
  resolveStandaloneSearchQuery: vi.fn(),
  runWebSearchTurn: mocks.runWebSearchTurn,
}));
vi.mock("../../../../../lib/web-search/tenant-config", () => ({
  loadTenantWebSearchConfig: mocks.loadTenantWebSearchConfig,
  loadTenantWebSearchConfigStrict: mocks.loadTenantWebSearchConfigStrict,
  // Not mocked away: the rollback switch is one of the things under test.
  isCalculatorEnabled: (row: { calculatorEnabled?: boolean } | null) =>
    row ? Boolean(row.calculatorEnabled) : true,
}));
vi.mock("../../../../../lib/deep-research/orchestrator", () => ({
  runDeepResearchTurn: mocks.runDeepResearchTurn,
}));
vi.mock("../../../../../lib/deep-research/artifact-store", () => ({
  defaultArtifactStore: {},
}));
vi.mock("../../../../../lib/deep-research/auto-need", () => ({
  planAutomaticTurn: mocks.planAutomaticTurn,
  resolveManualDeepResearchQuery: mocks.resolveManualDeepResearchQuery,
}));
vi.mock("../../../../../lib/calculator/chat-context", () => ({
  withCalculatorContext: mocks.withCalculatorContext,
}));

import { POST } from "../route";
import { resetChatConcurrencyForTests } from "../../../../../lib/chat-concurrency";

const session = {
  userId: "user-1",
  tenantId: "tenant-1",
  deptId: "dept-1",
  email: "user@example.com",
  scopes: [],
  mustChangePassword: false,
  sessionId: "auth-session-1",
};

function request(body: Record<string, unknown>): Request {
  return new Request("http://localhost/api/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-chat-session-id": "chat-session-1",
    },
    body: JSON.stringify({
      model: "provider-a/model-a",
      stream: true,
      messages: [{ role: "user", content: "当前问题" }],
      ...body,
    }),
  });
}

describe("POST /api/chat/completions deep-research preflight", () => {
  beforeEach(() => {
    resetChatConcurrencyForTests();
    vi.clearAllMocks();
    mocks.getSessionAuthFromCookies.mockResolvedValue({
      session,
      accessToken: "access-token",
      refreshToken: null,
    });
    mocks.isChatSessionOwned.mockResolvedValue(true);
    mocks.isPlatformFeatureAllowedForUser.mockResolvedValue(true);
    mocks.isPlatformFeatureAllowedOnSurface.mockResolvedValue(true);
    mocks.listAvailableModelsForUser.mockResolvedValue([
      { id: "provider-a/model-a", provider: "provider-a", model: "model-a" },
    ]);
    mocks.loadTenantWebSearchConfig.mockResolvedValue({
      enabled: true,
      provider: "duckduckgo",
      apiKey: "",
      maxResults: 5,
      maxSearchCalls: 3,
      deepResearchEnabled: true,
      calculatorEnabled: true,
    });
    mocks.loadTenantWebSearchConfigStrict.mockResolvedValue({
      enabled: true,
      provider: "duckduckgo",
      apiKey: "",
      maxResults: 5,
      maxSearchCalls: 3,
      deepResearchEnabled: true,
      calculatorEnabled: true,
    });
    mocks.runDeepResearchTurn.mockResolvedValue(new Response("deep"));
    mocks.runWebSearchTurn.mockResolvedValue(new Response("web"));
    mocks.planAutomaticTurn.mockResolvedValue({
      kind: "fallback",
      reason: "classifier_unavailable",
    });
    mocks.withCalculatorContext.mockResolvedValue(null);
  });

  it("counts plain, web and deep as one top-level turn each, then rejects the fourth", async () => {
    mocks.resolveManualDeepResearchQuery.mockResolvedValue({
      kind: "resolved",
      value: { query: "研究请求", confidence: 1, source: "current" },
    });
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response("plain"),
    );
    vi.stubGlobal("fetch", fetchMock);

    const responses: Response[] = [];
    try {
      responses.push(await POST(request({})));
      responses.push(await POST(request({ agenticx_web_search: true })));
      responses.push(await POST(request({ agenticx_deep_research: true })));

      const rejected = await POST(request({}));
      expect(rejected.status).toBe(429);
      await expect(rejected.json()).resolves.toMatchObject({
        error: { code: "42903", limit: 3 },
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(mocks.runWebSearchTurn).toHaveBeenCalledTimes(1);
      expect(mocks.runDeepResearchTurn).toHaveBeenCalledTimes(1);
    } finally {
      await Promise.all(responses.map((response) => response.body?.cancel()));
      vi.unstubAllGlobals();
    }
  });

  it("gives manual activation priority and skips the automatic gate", async () => {
    mocks.resolveManualDeepResearchQuery.mockResolvedValue({
      kind: "resolved",
      value: { query: "补全后的研究请求", confidence: 0.95, source: "ai" },
    });

    const response = await POST(request({
      agenticx_deep_research: true,
      agenticx_deep_research_auto: true,
    }));

    expect(await response.text()).toBe("deep");
    expect(mocks.planAutomaticTurn).not.toHaveBeenCalled();
    expect(mocks.withCalculatorContext).not.toHaveBeenCalled();
    expect(mocks.resolveManualDeepResearchQuery).toHaveBeenCalledTimes(1);
    expect(mocks.runDeepResearchTurn).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        resolvedUserQuery: "补全后的研究请求",
        intentConfidence: { routeConfidence: 1, queryConfidence: 0.95 },
      }),
    );
  });

  it("rejects a textless manual request instead of silently answering normally", async () => {
    mocks.resolveManualDeepResearchQuery.mockResolvedValue({
      kind: "unresolved",
      reason: "missing_current_query",
    });

    const response = await POST(request({ agenticx_deep_research: true }));

    expect(response.status).toBe(400);
    expect(mocks.runDeepResearchTurn).not.toHaveBeenCalled();
    expect(mocks.runWebSearchTurn).not.toHaveBeenCalled();
  });

  it("uses one automatic decision and passes its resolved query directly", async () => {
    mocks.planAutomaticTurn.mockResolvedValue({
      kind: "planned",
      plan: {
        mode: "deep",
        researchQuery: "两位人物截至当前日期的近期风评变化",
        intentConfidence: { routeConfidence: 0.94, queryConfidence: 0.96 },
        reason: "需要多源趋势核验",
      },
    });

    const response = await POST(request({ agenticx_deep_research_auto: true }));

    expect(await response.text()).toBe("deep");
    expect(mocks.planAutomaticTurn).toHaveBeenCalledTimes(1);
    expect(mocks.planAutomaticTurn).toHaveBeenCalledWith(
      expect.any(Array),
      expect.any(Object),
      { allowWebSearch: false, maxSearchCalls: 3, calculatorEnabled: true },
    );
    expect(mocks.resolveManualDeepResearchQuery).not.toHaveBeenCalled();
    expect(mocks.runDeepResearchTurn).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        resolvedUserQuery: "两位人物截至当前日期的近期风评变化",
        intentConfidence: { routeConfidence: 0.94, queryConfidence: 0.96 },
      }),
    );
  });

  it("keeps a manual fallback on the clarification-safe path", async () => {
    mocks.resolveManualDeepResearchQuery.mockResolvedValue({
      kind: "resolved",
      value: { query: "当前问题", confidence: 0, source: "fallback" },
    });

    const response = await POST(request({ agenticx_deep_research: true }));

    expect(await response.text()).toBe("deep");
    expect(mocks.runDeepResearchTurn).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        resolvedUserQuery: "当前问题",
        intentConfidence: { routeConfidence: 1, queryConfidence: 0 },
      }),
    );
  });

  it("passes an automatic web plan directly to ordinary search", async () => {
    const searchPlan = {
      query: "补全后的当前问题",
      needSearch: true as const,
      searchQueries: ["补全后的当前问题"],
      confidence: 0.98,
      source: "auto-route" as const,
    };
    mocks.planAutomaticTurn.mockResolvedValue({
      kind: "planned",
      plan: {
        mode: "web",
        searchPlan,
        reason: "单次检索足够",
      },
    });

    const response = await POST(request({
      agenticx_web_search: true,
      agenticx_deep_research_auto: true,
    }));

    expect(await response.text()).toBe("web");
    expect(mocks.planAutomaticTurn).toHaveBeenCalledTimes(1);
    expect(mocks.planAutomaticTurn).toHaveBeenCalledWith(
      expect.any(Array),
      expect.any(Object),
      { allowWebSearch: true, maxSearchCalls: 3, calculatorEnabled: true },
    );
    expect(mocks.resolveManualDeepResearchQuery).not.toHaveBeenCalled();
    expect(mocks.runDeepResearchTurn).not.toHaveBeenCalled();
    expect(mocks.withCalculatorContext).not.toHaveBeenCalled();
    expect(mocks.runWebSearchTurn).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      { preparedSearchPlan: searchPlan },
    );
  });

  it("uses plain chat directly when the automatic planner selects plain", async () => {
    mocks.planAutomaticTurn.mockResolvedValue({
      kind: "planned",
      plan: { mode: "plain", reason: "现有上下文足够" },
    });
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response("plain"),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const response = await POST(request({
        agenticx_web_search: true,
        agenticx_deep_research_auto: true,
      }));

      expect(await response.text()).toBe("plain");
      expect(mocks.planAutomaticTurn).toHaveBeenCalledTimes(1);
      expect(mocks.runWebSearchTurn).not.toHaveBeenCalled();
      expect(mocks.runDeepResearchTurn).not.toHaveBeenCalled();
      expect(mocks.withCalculatorContext).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("forwards calculator-enriched context only on the ordinary chat path", async () => {
    mocks.withCalculatorContext.mockImplementation(async (body: Record<string, unknown>) => ({
      ...body,
      messages: [
        { role: "system", content: "deterministic-result: 0.3" },
        ...(body.messages as unknown[]),
      ],
    }));
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response("plain"),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const response = await POST(request({
        messages: [{ role: "user", content: "请计算 0.1 + 0.2" }],
      }));

      expect(await response.text()).toBe("plain");
      expect(mocks.withCalculatorContext).toHaveBeenCalledWith(
        expect.objectContaining({ model: "model-a" }),
        expect.objectContaining({
          url: expect.stringContaining("/v1/chat/completions"),
          headers: expect.objectContaining({ "x-agenticx-provider": "provider-a" }),
        }),
        // No automatic routing ran for this turn, so no hint is passed and the
        // module's own gate decides. The tenant switch is read lazily, only if
        // the gate is going to plan.
        expect.objectContaining({ isEnabled: expect.any(Function) }),
      );
      const forwarded = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body ?? "{}"));
      expect(forwarded.messages[0]).toEqual({
        role: "system",
        content: "deterministic-result: 0.3",
      });
      expect(mocks.runWebSearchTurn).not.toHaveBeenCalled();
      expect(mocks.runDeepResearchTurn).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("falls back to the established ordinary web planner when automatic planning fails", async () => {
    mocks.planAutomaticTurn.mockResolvedValue({
      kind: "fallback",
      reason: "invalid_output",
    });

    const response = await POST(request({
      agenticx_web_search: true,
      agenticx_deep_research_auto: true,
    }));

    expect(await response.text()).toBe("web");
    expect(mocks.runDeepResearchTurn).not.toHaveBeenCalled();
    expect(mocks.runWebSearchTurn).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      {},
    );
  });

  it("skips the automatic model call when the tenant disables deep research", async () => {
    mocks.loadTenantWebSearchConfigStrict.mockResolvedValue({
      enabled: true,
      provider: "duckduckgo",
      apiKey: "",
      maxResults: 5,
      deepResearchEnabled: false,
      calculatorEnabled: true,
    });

    const response = await POST(request({
      agenticx_web_search: true,
      agenticx_deep_research_auto: true,
    }));

    expect(await response.text()).toBe("web");
    expect(mocks.planAutomaticTurn).not.toHaveBeenCalled();
    expect(mocks.resolveManualDeepResearchQuery).not.toHaveBeenCalled();
  });

  it("does not spend a rewrite call for a tenant-disabled manual request", async () => {
    mocks.loadTenantWebSearchConfigStrict.mockResolvedValue({
      enabled: true,
      provider: "duckduckgo",
      apiKey: "",
      maxResults: 5,
      deepResearchEnabled: false,
      calculatorEnabled: true,
    });

    const response = await POST(request({ agenticx_deep_research: true }));

    expect(await response.text()).toBe("deep");
    expect(mocks.planAutomaticTurn).not.toHaveBeenCalled();
    expect(mocks.resolveManualDeepResearchQuery).not.toHaveBeenCalled();
    expect(mocks.runDeepResearchTurn).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        tenantConfig: expect.objectContaining({ deepResearchEnabled: false }),
      }),
    );
  });

  it("rejects an ambiguous bare model before any routing call", async () => {
    mocks.listAvailableModelsForUser.mockResolvedValue([
      { id: "provider-a/model-a", provider: "provider-a", model: "model-a" },
      { id: "provider-b/model-a", provider: "provider-b", model: "model-a" },
    ]);

    const response = await POST(request({
      model: "model-a",
      agenticx_deep_research_auto: true,
    }));

    expect(response.status).toBe(403);
    expect(mocks.planAutomaticTurn).not.toHaveBeenCalled();
  });

  it("fails closed when effective model policy cannot be read", async () => {
    mocks.listAvailableModelsForUser.mockRejectedValue(new Error("database unavailable"));

    const response = await POST(request({ agenticx_deep_research_auto: true }));

    expect(response.status).toBe(503);
    expect(mocks.loadTenantWebSearchConfigStrict).not.toHaveBeenCalled();
    expect(mocks.planAutomaticTurn).not.toHaveBeenCalled();
  });

  it("skips automatic deep research when tenant policy cannot be read", async () => {
    mocks.loadTenantWebSearchConfigStrict.mockRejectedValue(
      new Error("database unavailable"),
    );

    const response = await POST(request({
      agenticx_web_search: true,
      agenticx_deep_research_auto: true,
    }));

    expect(await response.text()).toBe("web");
    expect(mocks.planAutomaticTurn).not.toHaveBeenCalled();
    expect(mocks.runWebSearchTurn).toHaveBeenCalledTimes(1);
  });

  it("rejects manual deep research when tenant policy cannot be read", async () => {
    mocks.loadTenantWebSearchConfigStrict.mockRejectedValue(
      new Error("database unavailable"),
    );

    const response = await POST(request({ agenticx_deep_research: true }));

    expect(response.status).toBe(503);
    expect(mocks.resolveManualDeepResearchQuery).not.toHaveBeenCalled();
    expect(mocks.runDeepResearchTurn).not.toHaveBeenCalled();
  });

  it("describes images privately before forwarding a custom-provider GLM text model", async () => {
    mocks.listAvailableModelsForUser.mockResolvedValue([
      {
        id: "custom_openai_moma/ZHIPU/GLM-5.2",
        provider: "custom_openai_moma",
        model: "ZHIPU/GLM-5.2",
        route: "third-party",
        capabilities: ["text"],
      },
      {
        id: "qwen-local/qwen2.5-vl",
        provider: "qwen-local",
        model: "qwen2.5-vl",
        label: "Private Qwen VL",
        route: "local",
        capabilities: ["text", "vision", "private-deployment"],
      },
    ]);
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
      if (body.model === "qwen2.5-vl") {
        return Response.json({
          choices: [{ message: { content: "截图显示错误码 1210，content.type 参数非法" } }],
        });
      }
      return new Response("plain");
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const response = await POST(request({
        model: "custom_openai_moma/ZHIPU/GLM-5.2",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "测试" },
              { type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
            ],
          },
        ],
      }));

      expect(await response.text()).toBe("plain");
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const visionCall = fetchMock.mock.calls[0]?.[1];
      expect((visionCall?.headers as Record<string, string>)["x-agenticx-provider"]).toBe(
        "qwen-local",
      );
      const finalCall = fetchMock.mock.calls[1]?.[1];
      expect((finalCall?.headers as Record<string, string>)["x-agenticx-provider"]).toBe(
        "custom_openai_moma",
      );
      const forwarded = JSON.parse(String(finalCall?.body ?? "{}")) as {
        model: string;
        messages: Array<{ role: string; content: unknown }>;
      };
      expect(forwarded.model).toBe("ZHIPU/GLM-5.2");
      expect(JSON.stringify(forwarded.messages)).not.toContain("image_url");
      expect(JSON.stringify(forwarded.messages)).toContain("错误码 1210");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("routes document prompts to the private target before any gateway call", async () => {
    mocks.listAvailableModelsForUser.mockResolvedValue([
      {
        id: "cloud/glm-5.2",
        provider: "cloud",
        providerLabel: "Cloud",
        model: "glm-5.2",
        label: "GLM 5.2",
        route: "third-party",
        isDefault: true,
        capabilities: ["text"],
      },
      {
        id: "qwen-local/qwen3.8",
        provider: "qwen-local",
        providerLabel: "Local Qwen",
        model: "qwen3.8",
        label: "Qwen Local",
        route: "local",
        isDefault: false,
        capabilities: ["text", "vision", "private-deployment"],
      },
    ]);
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response("plain"),
    );
    vi.stubGlobal("fetch", fetchMock);

    try {
      const response = await POST(request({
        model: "cloud/glm-5.2",
        agenticx_attachments: [{
          name: "quarterly-report.PDF:3-5",
          mime_type: "application/pdf",
          kind: "document",
        }],
        messages: [{
          role: "user",
          content: "总结\n\n--- 附件: quarterly-report.PDF:3-5 ---\nprivate body",
        }],
      }));

      expect(response.headers.get("x-agenticx-routed-model")).toBe(
        "qwen-local/qwen3.8",
      );
      expect(await response.text()).toBe("plain");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const gatewayCall = fetchMock.mock.calls[0]?.[1];
      expect((gatewayCall?.headers as Record<string, string>)["x-agenticx-provider"]).toBe(
        "qwen-local",
      );
      const forwarded = JSON.parse(String(gatewayCall?.body ?? "{}"));
      expect(forwarded.model).toBe("qwen3.8");
      expect(forwarded.agenticx_attachments).toBeUndefined();
      expect(JSON.stringify(forwarded.messages)).toContain("private body");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps document routing active when the legacy mock mode is set", async () => {
    vi.stubEnv("NEXT_PUBLIC_CHAT_CLIENT_MODE", "mock");
    mocks.listAvailableModelsForUser.mockResolvedValue([
      {
        id: "cloud/glm-5.2",
        provider: "cloud",
        providerLabel: "Cloud",
        model: "glm-5.2",
        label: "GLM 5.2",
        route: "third-party",
        isDefault: true,
        capabilities: ["text"],
      },
      {
        id: "private/glm-5.2-vision",
        provider: "private",
        providerLabel: "Private",
        model: "glm-5.2-vision",
        label: "GLM 5.2 Vision Private",
        route: "local",
        isDefault: false,
        capabilities: ["text", "vision", "private-deployment"],
      },
    ]);
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("plain"),
    );
    vi.stubGlobal("fetch", fetchMock);

    try {
      const response = await POST(request({
        model: "cloud/glm-5.2",
        agenticx_attachments: [{ name: "report.docx", mime_type: "application/docx" }],
      }));

      expect(response.status).toBe(200);
      expect(response.headers.get("x-agenticx-routed-model")).toBe("private/glm-5.2-vision");
      const gatewayCall = fetchMock.mock.calls[0]?.[1];
      const gatewayHeaders = gatewayCall?.headers as Record<string, string>;
      expect(gatewayHeaders["x-agenticx-attachment-route"]).toBe("private");
      expect(JSON.parse(String(gatewayCall?.body ?? "{}")).model).toBe("glm-5.2-vision");
    } finally {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  });

  it("fails closed instead of forwarding a document when routing is governed but denied", async () => {
    mocks.isPlatformFeatureAllowedOnSurface.mockResolvedValue(false);
    mocks.listAvailableModelsForUser.mockResolvedValue([
      {
        id: "cloud/glm-5.2",
        provider: "cloud",
        providerLabel: "Cloud",
        model: "glm-5.2",
        label: "GLM 5.2",
        route: "third-party",
        isDefault: true,
        capabilities: ["text"],
      },
      {
        id: "private/glm-5.2-vision",
        provider: "private",
        providerLabel: "Private",
        model: "glm-5.2-vision",
        label: "GLM 5.2 Vision Private",
        route: "local",
        isDefault: false,
        capabilities: ["text", "vision", "private-deployment"],
      },
    ]);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    try {
      const response = await POST(request({
        model: "cloud/glm-5.2",
        agenticx_attachments: [{ name: "confidential.docx", mime_type: "application/docx" }],
      }));

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        error: {
          code: "40301",
          message: expect.stringContaining("不会发送到公网模型"),
        },
      });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("allows an authorized member to keep a public model and forwards intent to Gateway", async () => {
    mocks.listAvailableModelsForUser.mockResolvedValue([
      {
        id: "cloud/glm-5.2",
        provider: "cloud",
        providerLabel: "Cloud",
        model: "glm-5.2",
        label: "GLM 5.2",
        route: "third-party",
        isDefault: true,
        capabilities: ["text"],
      },
      {
        id: "qwen-local/qwen3.8",
        provider: "qwen-local",
        providerLabel: "Local Qwen",
        model: "qwen3.8",
        label: "Qwen Local",
        route: "local",
        isDefault: false,
        capabilities: ["text", "vision", "private-deployment"],
      },
    ]);
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("plain"),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const response = await POST(request({
        model: "cloud/glm-5.2",
        agenticx_attachments: [{ name: "report.docx", mime_type: "application/docx" }],
        agenticx_current_attachments: [{ name: "report.docx", mime_type: "application/docx" }],
        agenticx_attachment_route: "public",
      }));

      expect(response.status).toBe(200);
      expect(response.headers.get("x-agenticx-routed-model")).toBeNull();
      // Gateway performs the final authorization and emits the only accepted
      // or denied routing event. The Portal must not pre-record an accepted
      // event that could become false if Gateway rejects the request.
      const gatewayCall = fetchMock.mock.calls[0]?.[1];
      expect((gatewayCall?.headers as Record<string, string>)["x-agenticx-provider"]).toBe("cloud");
      expect((gatewayCall?.headers as Record<string, string>)["x-agenticx-attachment-route"]).toBe(
        "public-override",
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("requires an explicit choice before an authorized public document turn", async () => {
    mocks.listAvailableModelsForUser.mockResolvedValue([
      {
        id: "cloud/glm-5.2",
        provider: "cloud",
        providerLabel: "Cloud",
        model: "glm-5.2",
        label: "GLM 5.2",
        route: "third-party",
        isDefault: true,
        capabilities: ["text"],
      },
      {
        id: "qwen-local/qwen3.8",
        provider: "qwen-local",
        providerLabel: "Local Qwen",
        model: "qwen3.8",
        label: "Qwen Local",
        route: "local",
        isDefault: false,
        capabilities: ["text", "vision", "private-deployment"],
      },
    ]);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    try {
      const response = await POST(request({
        model: "cloud/glm-5.2",
        agenticx_attachments: [{ name: "report.docx" }],
        agenticx_current_attachments: [{ name: "report.docx" }],
      }));
      expect(response.status).toBe(409);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("ignores a forged public choice when the member lacks the exception capability", async () => {
    mocks.isPlatformFeatureAllowedOnSurface.mockImplementation(
      async (_tenantId: string, feature: string) => feature === "attachment_routing",
    );
    mocks.listAvailableModelsForUser.mockResolvedValue([
      {
        id: "cloud/glm-5.2",
        provider: "cloud",
        providerLabel: "Cloud",
        model: "glm-5.2",
        label: "GLM 5.2",
        route: "third-party",
        isDefault: true,
        capabilities: ["text"],
      },
      {
        id: "qwen-local/qwen3.8",
        provider: "qwen-local",
        providerLabel: "Local Qwen",
        model: "qwen3.8",
        label: "Qwen Local",
        route: "local",
        isDefault: false,
        capabilities: ["text", "vision", "private-deployment"],
      },
    ]);
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("plain"),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const response = await POST(request({
        model: "cloud/glm-5.2",
        agenticx_attachments: [{ name: "report.docx" }],
        agenticx_current_attachments: [{ name: "report.docx" }],
        agenticx_attachment_route: "public",
      }));
      expect(response.headers.get("x-agenticx-routed-model")).toBe("qwen-local/qwen3.8");
      const gatewayCall = fetchMock.mock.calls[0]?.[1];
      expect((gatewayCall?.headers as Record<string, string>)["x-agenticx-provider"]).toBe(
        "qwen-local",
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not require a Portal audit write before forwarding public intent", async () => {
    mocks.listAvailableModelsForUser.mockResolvedValue([
      {
        id: "cloud/glm-5.2",
        provider: "cloud",
        providerLabel: "Cloud",
        model: "glm-5.2",
        label: "GLM 5.2",
        route: "third-party",
        isDefault: true,
        capabilities: ["text"],
      },
      {
        id: "qwen-local/qwen3.8",
        provider: "qwen-local",
        providerLabel: "Local Qwen",
        model: "qwen3.8",
        label: "Qwen Local",
        route: "local",
        isDefault: false,
        capabilities: ["text", "vision", "private-deployment"],
      },
    ]);
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("plain"),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const response = await POST(request({
        model: "cloud/glm-5.2",
        agenticx_attachments: [{ name: "report.docx" }],
        agenticx_current_attachments: [{ name: "report.docx" }],
        agenticx_attachment_route: "public",
      }));
      expect(response.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("fails closed when document routing is authorized but no private target exists", async () => {
    mocks.listAvailableModelsForUser.mockResolvedValue([
      {
        id: "cloud/glm-5.2",
        provider: "cloud",
        providerLabel: "Cloud",
        model: "glm-5.2",
        label: "GLM 5.2",
        route: "third-party",
        isDefault: true,
        capabilities: ["text"],
      },
    ]);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    try {
      const response = await POST(request({
        model: "cloud/glm-5.2",
        agenticx_attachments: [{ name: "report.docx", mime_type: "application/docx" }],
      }));
      expect(response.status).toBe(503);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
