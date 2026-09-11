import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { v2ExpertManifest } from "../../../../../lib/config-share-test-fixtures";
import {
  configMarketCanonicalRaw,
  configMarketManifestDigest,
} from "../../../../../lib/config-market/types";

const resolveDesktopIdentity = vi.fn();
const listAvailableModelsForUser = vi.fn();
const loadDesktopSessionTokenLimits = vi.fn();
const listAvailableCapabilitiesForUser = vi.fn();
const isPlatformFeatureAllowedOnSurface = vi.fn();
const listManagedPortablePackagesForUser = vi.fn();
const manifest = v2ExpertManifest();

vi.mock("../../../../../lib/config-market/managed", () => ({
  listManagedPortablePackagesForUser: (...args: unknown[]) =>
    listManagedPortablePackagesForUser(...args),
}));

vi.mock("../../../../../lib/capability-packs-reader", async () => {
  const actual = await vi.importActual<
    typeof import("../../../../../lib/capability-packs-reader")
  >("../../../../../lib/capability-packs-reader");
  return {
    ...actual,
    listAvailableCapabilitiesForUser: (...args: unknown[]) =>
      listAvailableCapabilitiesForUser(...args),
    isPlatformFeatureAllowedOnSurface: (...args: unknown[]) =>
      isPlatformFeatureAllowedOnSurface(...args),
  };
});

vi.mock("../../../../../lib/desktop-auth", () => ({
  resolveDesktopIdentity: (...args: unknown[]) => resolveDesktopIdentity(...args),
}));

vi.mock("../../../../../lib/admin-providers-reader", () => ({
  listAvailableModelsForUser: (...args: unknown[]) => listAvailableModelsForUser(...args),
}));

vi.mock("../../../../../lib/desktop-token-policy", () => ({
  loadDesktopManagedPolicy: async (...args: unknown[]) => ({
    tokenLimits: await loadDesktopSessionTokenLimits(...args),
    capabilities: {
      allowLocalSkillInstall: true,
      allowLocalMcpInstall: true,
      allowMcpAutoDiscovery: true,
    },
  }),
  loadDesktopSessionTokenLimits: (...args: unknown[]) =>
    loadDesktopSessionTokenLimits(...args),
}));

describe("GET /api/desktop/bootstrap", { timeout: 30_000 }, () => {
  beforeEach(() => {
    resolveDesktopIdentity.mockReset();
    listAvailableModelsForUser.mockReset();
    loadDesktopSessionTokenLimits.mockReset();
    listAvailableModelsForUser.mockResolvedValue([]);
    listAvailableCapabilitiesForUser.mockReset().mockResolvedValue([]);
    isPlatformFeatureAllowedOnSurface.mockReset().mockResolvedValue(false);
    listManagedPortablePackagesForUser.mockReset().mockResolvedValue([]);
    loadDesktopSessionTokenLimits.mockResolvedValue({
      warningTokensPerSession: 500_000,
      maxTokensPerSession: 1_000_000,
    });
    process.env.NEXT_PUBLIC_GATEWAY_PUBLIC_BASE_URL = "https://gateway.example.invalid";
    vi.stubEnv("NODE_ENV", "test");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns gateway-direct transport for managed scopes", async () => {
    resolveDesktopIdentity.mockResolvedValue({
      userId: "u1",
      tenantId: "t1",
      deptId: "d1",
      email: "a@example.invalid",
      displayName: "A",
      tokenId: 1,
      scopes: ["workspace:chat", "desktop:managed"],
    });
    const { GET } = await import("../route");
    const res = await GET(new Request("http://localhost:3000/api/desktop/bootstrap"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.apiBaseUrl).toBe("http://localhost:3000/api/desktop/v1");
    expect(json.data.inferenceApiBaseUrl).toBe("https://gateway.example.invalid/v1");
    expect(json.data.inferenceTransport).toBe("gateway-direct-v1");
    expect(json.data.reauthRequiredForDirect).toBe(false);
    expect(json.data.policy.tokenBudget).toEqual({
      warningTokensPerSession: 500_000,
      maxTokensPerSession: 1_000_000,
    });
    expect(loadDesktopSessionTokenLimits).toHaveBeenCalledWith("t1");
  });

  it("returns the authenticated tenant's configured conversation alert thresholds", async () => {
    resolveDesktopIdentity.mockResolvedValue({
      userId: "u2",
      tenantId: "tenant-policy",
      deptId: null,
      email: "b@example.invalid",
      displayName: "B",
      tokenId: 2,
      scopes: ["workspace:chat", "desktop:managed"],
    });
    loadDesktopSessionTokenLimits.mockResolvedValue({
      warningTokensPerSession: 750_000,
      maxTokensPerSession: 1_500_000,
    });

    const { GET } = await import("../route");
    const res = await GET(new Request("http://localhost:3000/api/desktop/bootstrap"));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(loadDesktopSessionTokenLimits).toHaveBeenCalledWith("tenant-policy");
    expect(json.data.policy.tokenBudget).toEqual({
      warningTokensPerSession: 750_000,
      maxTokensPerSession: 1_500_000,
    });
  });

  it("returns the user's effective capability package with delivery metadata", async () => {
    resolveDesktopIdentity.mockResolvedValue({
      userId: "u-capability",
      tenantId: "t1",
      deptId: "d1",
      email: "capability@example.invalid",
      displayName: "Capability User",
      tokenId: 3,
      scopes: ["workspace:chat", "desktop:managed"],
    });
    listAvailableCapabilitiesForUser.mockResolvedValue([
      {
        id: "skill:01JQMZ8K3N4P5Q6R7S8T9VWXY0",
        kind: "skill",
        name: "@finance/report-reader",
        displayName: "报告阅读",
        requires: [],
        version: "1.2.3",
        bundleUri: "https://portal.example.invalid/skills/report-reader/SKILL.md",
        bundleDigest: "abc123",
      },
      {
        id: "mcp:01JQMZ8K3N4P5Q6R7S8T9VWXYZ",
        kind: "mcp",
        name: "market-data",
        displayName: "行情数据",
        requires: [],
      },
    ]);

    const { GET } = await import("../route");
    const response = await GET(
      new Request("https://portal.example.invalid/api/desktop/bootstrap"),
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data.capabilities).toEqual([
      expect.objectContaining({
        id: "skill:01JQMZ8K3N4P5Q6R7S8T9VWXY0",
        name: "@finance/report-reader",
        bundleUri: "https://portal.example.invalid/skills/report-reader/SKILL.md",
        bundleDigest: "abc123",
      }),
      expect.objectContaining({
        id: "mcp:01JQMZ8K3N4P5Q6R7S8T9VWXYZ",
        endpointUrl: "https://gateway.example.invalid/mcp/market-data/streamable-http",
      }),
    ]);
  });

  it("includes an explicit empty capability list after a successful lookup", async () => {
    resolveDesktopIdentity.mockResolvedValue({
      userId: "u-capability-empty",
      tenantId: "t1",
      deptId: null,
      email: "capability-empty@example.invalid",
      displayName: "Empty Capability User",
      tokenId: 4,
      scopes: ["workspace:chat", "desktop:managed"],
    });
    listAvailableCapabilitiesForUser.mockResolvedValue([]);

    const { GET } = await import("../route");
    const response = await GET(
      new Request("https://portal.example.invalid/api/desktop/bootstrap"),
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data).toHaveProperty("capabilities");
    expect(json.data.capabilities).toEqual([]);
    expect(json.data.unmetCapabilityDependencies).toEqual([]);
  });

  it("omits the capability snapshot when its lookup fails", async () => {
    resolveDesktopIdentity.mockResolvedValue({
      userId: "u-capability-lkg",
      tenantId: "t1",
      deptId: null,
      email: "capability-lkg@example.invalid",
      displayName: "Capability LKG User",
      tokenId: 5,
      scopes: ["workspace:chat", "desktop:managed"],
    });
    listAvailableCapabilitiesForUser.mockRejectedValue(new Error("database unavailable"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const { GET } = await import("../route");
      const response = await GET(
        new Request("https://portal.example.invalid/api/desktop/bootstrap"),
      );
      const json = await response.json();

      expect(response.status).toBe(200);
      expect(json.data).not.toHaveProperty("capabilities");
      expect(json.data).not.toHaveProperty("unmetCapabilityDependencies");
      expect(consoleError).toHaveBeenCalledWith(
        "[desktop/bootstrap] capability query failed:",
        expect.any(Error),
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it("returns managed portable packages from assigned packs outside opt-out capabilities", async () => {
    resolveDesktopIdentity.mockResolvedValue({
      userId: "u-portable",
      tenantId: "tenant-portable",
      deptId: "dept-portable",
      email: "portable@example.invalid",
      displayName: "Portable User",
      tokenId: 9,
      scopes: ["workspace:chat", "desktop:managed"],
    });
    const managed = {
      id: "expert:01JQMZ8K3N4P5Q6R7S8T9VWXYZ",
      kind: "expert",
      title: "投研专家",
      releaseId: "01JQMZ8K3N4P5Q6R7S8T9VWXY0",
      version: "1.0.0",
      digest: configMarketManifestDigest(manifest),
      raw: configMarketCanonicalRaw(manifest),
    };
    listManagedPortablePackagesForUser.mockResolvedValue([managed]);

    const { GET } = await import("../route");
    const response = await GET(
      new Request("https://portal.example.invalid/api/desktop/bootstrap"),
    );
    const json = await response.json();
    expect(json.data.managedPortablePackages).toEqual([managed]);
    expect(json.data.capabilities).toEqual([]);
    expect(listManagedPortablePackagesForUser).toHaveBeenCalledWith({
      tenantId: "tenant-portable",
      userId: "u-portable",
      email: "portable@example.invalid",
      deptId: "dept-portable",
    });
  });

  it("includes an empty managed list on success so Desktop can withdraw stale packages", async () => {
    resolveDesktopIdentity.mockResolvedValue({
      userId: "u-empty",
      tenantId: "tenant-empty",
      deptId: null,
      email: "empty@example.invalid",
      displayName: "Empty User",
      tokenId: 10,
      scopes: ["workspace:chat", "desktop:managed"],
    });
    listManagedPortablePackagesForUser.mockResolvedValue([]);
    const { GET } = await import("../route");
    const json = await (
      await GET(new Request("https://portal.example.invalid/api/desktop/bootstrap"))
    ).json();
    expect(json.data).toHaveProperty("managedPortablePackages");
    expect(json.data.managedPortablePackages).toEqual([]);
  });

  it("omits managedPortablePackages on query failure so Desktop keeps last-known-good", async () => {
    resolveDesktopIdentity.mockResolvedValue({
      userId: "u-lkg",
      tenantId: "tenant-lkg",
      deptId: null,
      email: "lkg@example.invalid",
      displayName: "LKG User",
      tokenId: 11,
      scopes: ["workspace:chat", "desktop:managed"],
    });
    listManagedPortablePackagesForUser.mockRejectedValue(new Error("database unavailable"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { GET } = await import("../route");
    const response = await GET(
      new Request("https://portal.example.invalid/api/desktop/bootstrap"),
    );
    const json = await response.json();
    expect(response.status).toBe(200);
    expect(json.data).not.toHaveProperty("managedPortablePackages");
    expect(consoleError).toHaveBeenCalledWith(
      "[desktop/bootstrap] managed portable package query failed:",
      expect.any(Error),
    );
    consoleError.mockRestore();
  });

  it("keeps proxy transport for old PAT without desktop:managed", async () => {
    resolveDesktopIdentity.mockResolvedValue({
      userId: "u1",
      tenantId: "t1",
      deptId: "d1",
      email: "a@example.invalid",
      displayName: "A",
      tokenId: 1,
      scopes: ["workspace:chat"],
    });
    const { GET } = await import("../route");
    const res = await GET(new Request("http://localhost:3000/api/desktop/bootstrap"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.apiBaseUrl).toBe("http://localhost:3000/api/desktop/v1");
    expect(json.data.inferenceApiBaseUrl).toBeUndefined();
    expect(json.data.reauthRequiredForDirect).toBe(true);
  });

  it("falls back to portal proxy when direct gateway base is not configured", async () => {
    vi.stubEnv("NODE_ENV", "production");
    delete process.env.NEXT_PUBLIC_GATEWAY_PUBLIC_BASE_URL;
    resolveDesktopIdentity.mockResolvedValue({
      userId: "u1",
      tenantId: "t1",
      deptId: "d1",
      email: "a@example.invalid",
      displayName: "A",
      tokenId: 1,
      scopes: ["workspace:chat", "desktop:managed"],
    });
    const { GET } = await import("../route");
    const res = await GET(new Request("https://portal.example.com/api/desktop/bootstrap"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.apiBaseUrl).toBe("https://portal.example.com/api/desktop/v1");
    expect(json.data.inferenceApiBaseUrl).toBeUndefined();
    expect(json.data.inferenceTransport).toBeUndefined();
    expect(json.data.reauthRequiredForDirect).toBe(true);
  });

  it("uses the configured public portal base and ignores forged forwarding headers", async () => {
    vi.stubEnv("NODE_ENV", "production");
    delete process.env.NEXT_PUBLIC_GATEWAY_PUBLIC_BASE_URL;
    vi.stubEnv("WEB_PORTAL_PUBLIC_BASE_URL", "https://portal.example.com:3000");
    resolveDesktopIdentity.mockResolvedValue({
      userId: "u1",
      tenantId: "t1",
      deptId: "d1",
      email: "a@example.invalid",
      displayName: "A",
      tokenId: 1,
      scopes: ["workspace:chat", "desktop:managed"],
    });
    const { GET } = await import("../route");
    const res = await GET(new Request("http://0.0.0.0:3000/api/desktop/bootstrap", {
      headers: {
        host: "attacker.example",
        "x-forwarded-host": "attacker.example",
        "x-forwarded-proto": "https",
      },
    }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.apiBaseUrl).toBe("https://portal.example.com:3000/api/desktop/v1");
    expect(json.data.inferenceApiBaseUrl).toBeUndefined();
    expect(json.data.reauthRequiredForDirect).toBe(true);
  });

  it("does not trust forwarding headers when no public portal base is configured", async () => {
    vi.stubEnv("NODE_ENV", "production");
    delete process.env.NEXT_PUBLIC_GATEWAY_PUBLIC_BASE_URL;
    delete process.env.WEB_PORTAL_PUBLIC_BASE_URL;
    delete process.env.PORTAL_PUBLIC_BASE_URL;
    delete process.env.NEXT_PUBLIC_WEB_PORTAL_PUBLIC_BASE_URL;
    resolveDesktopIdentity.mockResolvedValue({
      userId: "u1",
      tenantId: "t1",
      deptId: "d1",
      email: "a@example.invalid",
      displayName: "A",
      tokenId: 1,
      scopes: ["workspace:chat"],
    });
    const { GET } = await import("../route");
    const response = await GET(
      new Request("https://portal.example.com/api/desktop/bootstrap", {
        headers: {
          host: "attacker.example",
          "x-forwarded-host": "attacker.example",
          "x-forwarded-proto": "https",
        },
      }),
    );
    const json = await response.json();
    expect(json.data.apiBaseUrl).toBe("https://portal.example.com/api/desktop/v1");
  });
});


const PRIVATE_QWEN = {
  id: "qwen_local/qwen3.8-27b",
  provider: "qwen_local",
  providerLabel: "本地推理",
  model: "qwen3.8-27b",
  label: "本地推理/Qwen3.8 27B",
  route: "local" as const,
  isDefault: false,
  capabilities: ["text", "vision", "private-deployment"],
};

describe("GET /api/desktop/bootstrap · 附件路由", { timeout: 30_000 }, () => {
  beforeEach(() => {
    resolveDesktopIdentity.mockReset().mockResolvedValue({
      userId: "u1",
      tenantId: "t1",
      email: "u1@example.invalid",
      deptId: null,
      displayName: "U1",
      scopes: ["desktop:managed"],
    });
    listAvailableModelsForUser.mockReset().mockResolvedValue([PRIVATE_QWEN]);
    loadDesktopSessionTokenLimits.mockReset().mockResolvedValue({
      warningTokensPerSession: 500_000,
      maxTokensPerSession: 1_000_000,
    });
    listAvailableCapabilitiesForUser.mockReset().mockResolvedValue([]);
    isPlatformFeatureAllowedOnSurface.mockReset();
    process.env.NEXT_PUBLIC_GATEWAY_PUBLIC_BASE_URL = "https://gateway.example.invalid";
    vi.stubEnv("NODE_ENV", "test");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function bootstrapPayload() {
    const { GET } = await import("../route");
    const response = await GET(
      new Request("https://portal.example.invalid/api/desktop/bootstrap"),
    );
    return (await response.json()).data as Record<string, any>;
  }

  it("ships the policy when the user is authorized and a private model is visible", async () => {
    isPlatformFeatureAllowedOnSurface.mockImplementation(
      async (_tenantId: string, feature: string) => feature === "attachment_routing",
    );
    const data = await bootstrapPayload();
    expect(data.attachmentRouting.enabled).toBe(true);
    expect(data.attachmentRouting.documentTarget).toEqual({
      id: "qwen_local/qwen3.8-27b",
      provider: "qwen_local",
      model: "qwen3.8-27b",
      label: "本地推理/Qwen3.8 27B",
    });
    // 图片不锁会话模型：截图是高频动作，切一次模型整段历史的 prefix cache 就废了。
    expect(data.attachmentRouting.imageStrategy).toBe("vision-fallback");
    expect(data.attachmentRouting.visionFallback.provider).toBe("qwen_local");
    expect(data.attachmentRouting.allowPublicOverride).toBe(false);
  });

  it("only exposes the public-model choice when the capability pack allows it", async () => {
    isPlatformFeatureAllowedOnSurface.mockImplementation(
      async (_tenantId: string, feature: string) =>
        feature === "attachment_routing" || feature === "attachment_public_override",
    );
    const data = await bootstrapPayload();
    expect(data.attachmentRouting.enabled).toBe(true);
    expect(data.attachmentRouting.allowPublicOverride).toBe(true);

    isPlatformFeatureAllowedOnSurface.mockImplementation(
      async (_tenantId: string, feature: string) => feature === "attachment_routing",
    );
    const forced = await bootstrapPayload();
    expect(forced.attachmentRouting.enabled).toBe(true);
    expect(forced.attachmentRouting.allowPublicOverride).toBe(false);
  });

  it("ships a disabled policy when the user is not authorized", async () => {
    isPlatformFeatureAllowedOnSurface.mockResolvedValue(false);
    const data = await bootstrapPayload();
    expect(data.attachmentRouting.enabled).toBe(false);
    expect(data.attachmentRouting.documentTarget).toBeNull();
  });

  it("fails closed when the authorization lookup throws", async () => {
    // 与 deep_research 的 fail-open 相反：这是新功能，没有存量租户在依赖它，查不动
    // 时保持原样远好过把会话锁到某个模型。
    isPlatformFeatureAllowedOnSurface.mockRejectedValue(new Error("db down"));
    const data = await bootstrapPayload();
    expect(data.attachmentRouting.enabled).toBe(false);
  });

  it("only asks for desktop-surface capabilities", async () => {
    isPlatformFeatureAllowedOnSurface.mockResolvedValue(true);
    await bootstrapPayload();
    expect(listAvailableCapabilitiesForUser).toHaveBeenCalledWith(
      "t1",
      "u1",
      "u1@example.invalid",
      null,
      "desktop",
    );
  });
});
