import { beforeEach, describe, expect, it, vi } from "vitest";
import { v2ExpertManifest } from "../../../../../lib/config-share-test-fixtures";

import { MAX_CONFIG_MARKET_REQUEST_BYTES } from "../../../../../lib/config-market/request";

const resolveDesktopIdentity = vi.fn();
const create = vi.fn();
const listVisible = vi.fn();
const listVisibleMetadata = vi.fn();
const insertAuditEvent = vi.fn();
const assertConfigMarketAudienceTargets = vi.fn();

vi.mock("@agenticx/iam-core", () => ({
  insertAuditEvent: (...args: unknown[]) => insertAuditEvent(...args),
}));

vi.mock("../../../../../lib/desktop-auth", () => ({
  resolveDesktopIdentity: (...args: unknown[]) => resolveDesktopIdentity(...args),
}));

vi.mock("../../../../../lib/config-market/store", () => ({
  ConfigMarketPublishBlockedError: class ConfigMarketPublishBlockedError extends Error {},
  ConfigMarketOwnershipConflictError: class ConfigMarketOwnershipConflictError extends Error {},
  ConfigMarketAudienceConflictError: class ConfigMarketAudienceConflictError extends Error {},
  ConfigMarketReleaseVersionConflictError: class ConfigMarketReleaseVersionConflictError extends Error {},
  ConfigMarketReleaseDigestConflictError: class ConfigMarketReleaseDigestConflictError extends Error {},
  ConfigMarketTrackStableDependencyConflictError: class ConfigMarketTrackStableDependencyConflictError extends Error {
    missingCapabilityIds: string[];
    packIds: string[];
    constructor(missingCapabilityIds: string[], packIds: string[]) {
      super("tracking packs would break");
      this.missingCapabilityIds = missingCapabilityIds;
      this.packIds = packIds;
    }
  },
  defaultConfigMarketStore: {
    create: (...args: unknown[]) => create(...args),
    listVisible: (...args: unknown[]) => listVisible(...args),
    listVisibleMetadata: (...args: unknown[]) => listVisibleMetadata(...args),
  },
}));
vi.mock("../../../../../lib/config-market/audience", () => ({
  assertConfigMarketAudienceTargets: (...args: unknown[]) =>
    assertConfigMarketAudienceTargets(...args),
}));

const manifest = v2ExpertManifest("投研专家", { systemPrompt: "secret prompt" });
const item = {
  id: "01JQMZ8K3N4P5Q6R7S8T9VWXYZ",
  tenantId: "tenant-a",
  userId: "user-a",
  ownerDisplayName: "Alice",
  kind: "expert",
  sourceArtifactId: manifest.artifact_id,
  manifestVersion: 2,
  releaseId: "01JQMZ8K3N4P5Q6R7S8T9VWXY1",
  version: "1.0.0",
  title: "投研专家",
  description: "分析公告",
  digest: "a".repeat(64),
  raw: manifest,
  releaseNotes: "首次发布",
  releasePublishedAt: "2026-08-28T00:00:00.000Z",
  status: "published",
  visibility: "company",
  visibleDepartmentIds: [],
  visibleUserIds: [],
  publishedAt: "2026-08-28T00:00:00.000Z",
  unlistedAt: null,
  createdAt: "2026-08-28T00:00:00.000Z",
  updatedAt: "2026-08-28T00:00:00.000Z",
};

function identity() {
  return {
    userId: "user-a",
    tenantId: "tenant-a",
    deptId: null,
    email: "alice@example.invalid",
    displayName: "Alice",
    tokenId: 1,
    scopes: ["workspace:chat", "desktop:managed"],
  };
}

function createRequestBody(): string {
  return JSON.stringify({
    manifest,
    visibility: { type: "company", department_ids: [], user_ids: [] },
  });
}

describe("/api/desktop/config-market", () => {
  beforeEach(() => {
    resolveDesktopIdentity.mockReset().mockResolvedValue(identity());
    create.mockReset().mockResolvedValue(item);
    listVisible.mockReset().mockResolvedValue([item]);
    listVisibleMetadata.mockReset().mockResolvedValue({
      items: [{ id: item.id, title: item.title, status: item.status }],
      nextCursor: "next-page",
    });
    insertAuditEvent.mockReset().mockResolvedValue(undefined);
    assertConfigMarketAudienceTargets.mockReset().mockResolvedValue(undefined);
  });

  it("publishes immediately using PAT-derived tenant and author", async () => {
    const { POST } = await import("../route");
    const response = await POST(
      new Request("https://portal.example.invalid/api/desktop/config-market", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          manifest,
          visibility: { type: "company", department_ids: [], user_ids: [] },
        }),
      }),
    );
    expect(response.status).toBe(201);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "tenant-a",
        userId: "user-a",
        releaseNotes: "",
        audience: { visibility: "company", visibleDepartmentIds: [], visibleUserIds: [] },
      }),
    );
    expect(assertConfigMarketAudienceTargets).toHaveBeenCalledWith("tenant-a", {
      visibility: "company",
      visibleDepartmentIds: [],
      visibleUserIds: [],
    });
    const json = await response.json();
    expect(json.data.item.status).toBe("published");
    expect(json.data.item.capabilityId).toBe(`expert:${item.id}`);
    expect(json.data.item).not.toHaveProperty("raw");
    expect(json.data.item).toMatchObject({
      visibility: "company",
      visibleDepartmentCount: 0,
      visibleUserCount: 0,
    });
    expect(json.data.item).not.toHaveProperty("visibleDepartmentIds");
    expect(json.data.item).not.toHaveProperty("visibleUserIds");
    expect(JSON.stringify(json.data.item)).not.toContain("secret prompt");
    expect(json.data.share_url).toBe(`https://portal.example.invalid/config-market/${item.id}`);
    expect(insertAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "tenant-a",
        actorUserId: "user-a",
        eventType: "config_market.publish",
        targetId: item.id,
      }),
    );
  });

  it("passes personal visibility to the store without audience targets", async () => {
    const { POST } = await import("../route");
    const response = await POST(
      new Request("https://portal.example.invalid/api/desktop/config-market", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          manifest,
          visibility: { type: "personal", department_ids: [], user_ids: [] },
        }),
      }),
    );
    expect(response.status).toBe(201);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      audience: { visibility: "personal", visibleDepartmentIds: [], visibleUserIds: [] },
    }));
    expect(assertConfigMarketAudienceTargets).toHaveBeenCalledWith("tenant-a", {
      visibility: "personal",
      visibleDepartmentIds: [],
      visibleUserIds: [],
    });
  });

  it("rejects client tenant fields through the strict share validator", async () => {
    const { POST } = await import("../route");
    const response = await POST(
      new Request("https://portal.example.invalid/api/desktop/config-market", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          manifest,
          visibility: { type: "company", department_ids: [], user_ids: [] },
          tenant_id: "tenant-b",
        }),
      }),
    );
    expect(response.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it("blocks secrets and PII in release notes before persistence", async () => {
    const { POST } = await import("../route");
    const response = await POST(
      new Request("https://portal.example.invalid/api/desktop/config-market", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          manifest,
          release_notes: "API key sk-proj-abcdefghijklmnopqrstuvwxyz123456",
          visibility: { type: "company", department_ids: [], user_ids: [] },
        }),
      }),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: "40004",
      data: { findings: [expect.objectContaining({ field: "release_notes", category: "secret" })] },
    });
    expect(create).not.toHaveBeenCalled();
  });

  it("accepts a valid raw UTF-8 body exactly at the market request limit", async () => {
    const base = createRequestBody();
    const baseBytes = new TextEncoder().encode(base).byteLength;
    const body = `${base}${" ".repeat(MAX_CONFIG_MARKET_REQUEST_BYTES - baseBytes)}`;
    expect(new TextEncoder().encode(body)).toHaveLength(MAX_CONFIG_MARKET_REQUEST_BYTES);

    const { POST } = await import("../route");
    const response = await POST(
      new Request("https://portal.example.invalid/api/desktop/config-market", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }),
    );
    expect(response.status).toBe(201);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("rejects an oversized chunked body before JSON parsing or persistence", async () => {
    const base = createRequestBody();
    const baseBytes = new TextEncoder().encode(base).byteLength;
    const bytes = new TextEncoder().encode(
      `${base}${" ".repeat(MAX_CONFIG_MARKET_REQUEST_BYTES - baseBytes + 1)}`,
    );
    const splitAt = MAX_CONFIG_MARKET_REQUEST_BYTES - 8;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, splitAt));
        controller.enqueue(bytes.slice(splitAt));
        controller.close();
      },
    });
    const request = new Request("https://portal.example.invalid/api/desktop/config-market", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    expect(request.headers.get("content-length")).toBeNull();

    const { POST } = await import("../route");
    const response = await POST(request);
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ code: "41301" });
    expect(create).not.toHaveBeenCalled();
  });

  it("returns conflict when an administrator previously unlisted the same content", async () => {
    const { ConfigMarketPublishBlockedError } = await import(
      "../../../../../lib/config-market/store"
    );
    create.mockRejectedValueOnce(new ConfigMarketPublishBlockedError("blocked"));
    const { POST } = await import("../route");
    const response = await POST(
      new Request("https://portal.example.invalid/api/desktop/config-market", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          manifest,
          visibility: { type: "company", department_ids: [], user_ids: [] },
        }),
      }),
    );
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe("40901");
  });

  it("returns conflict instead of reusing another uploader's owner or ACL", async () => {
    const { ConfigMarketOwnershipConflictError } = await import(
      "../../../../../lib/config-market/store"
    );
    create.mockRejectedValueOnce(new ConfigMarketOwnershipConflictError("owned"));
    const { POST } = await import("../route");
    const response = await POST(
      new Request("https://portal.example.invalid/api/desktop/config-market", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          manifest,
          visibility: { type: "company", department_ids: [], user_ids: [] },
        }),
      }),
    );
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe("40902");
  });

  it("returns conflict instead of silently changing the same uploader's ACL", async () => {
    const { ConfigMarketAudienceConflictError } = await import(
      "../../../../../lib/config-market/store"
    );
    create.mockRejectedValueOnce(new ConfigMarketAudienceConflictError("different audience"));
    const { POST } = await import("../route");
    const response = await POST(
      new Request("https://portal.example.invalid/api/desktop/config-market", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          manifest,
          visibility: { type: "users", department_ids: [], user_ids: [item.id] },
        }),
      }),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "40903",
      message: expect.stringContaining("本次未作任何修改"),
    });
  });

  it("rejects a stable release that adds dependencies missing from tracking packs", async () => {
    const { ConfigMarketTrackStableDependencyConflictError } = await import(
      "../../../../../lib/config-market/store"
    );
    const missing = "skill:01JQMZ8K3N4P5Q6R7S8T9VWX03";
    create.mockRejectedValueOnce(
      new ConfigMarketTrackStableDependencyConflictError([missing], ["pack-a"]),
    );
    const { POST } = await import("../route");
    const response = await POST(
      new Request("https://portal.example.invalid/api/desktop/config-market", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          manifest,
          visibility: { type: "company", department_ids: [], user_ids: [] },
        }),
      }),
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "40906",
      data: { missingCapabilityIds: [missing], packIds: ["pack-a"] },
    });
  });

  it("validates restricted targets against the authenticated tenant before persistence", async () => {
    const { ConfigShareValidationError } = await import(
      "../../../../../lib/config-share-types"
    );
    assertConfigMarketAudienceTargets.mockRejectedValueOnce(
      new ConfigShareValidationError("visible users must be active"),
    );
    const targetUser = "01JQMZ8K3N4P5Q6R7S8T9VWXY0";
    const { POST } = await import("../route");
    const response = await POST(
      new Request("https://portal.example.invalid/api/desktop/config-market", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          manifest,
          visibility: { type: "users", department_ids: [], user_ids: [targetUser] },
        }),
      }),
    );
    expect(response.status).toBe(400);
    expect(assertConfigMarketAudienceTargets).toHaveBeenCalledWith("tenant-a", {
      visibility: "users",
      visibleDepartmentIds: [],
      visibleUserIds: [targetUser],
    });
    expect(create).not.toHaveBeenCalled();
  });

  it("lists tenant-scoped metadata without raw manifests or system prompts", async () => {
    const { GET } = await import("../route");
    const response = await GET(
      new Request("https://portal.example.invalid/api/desktop/config-market?kind=expert"),
    );
    expect(listVisibleMetadata).toHaveBeenCalledWith(identity(), {
      kind: "expert",
      limit: undefined,
      cursor: null,
    });
    const json = await response.json();
    expect(json.data.items[0]).not.toHaveProperty("raw");
    expect(JSON.stringify(json)).not.toContain("secret prompt");
    expect(json.data.next_cursor).toBe("next-page");
  });

  it("derives administrator-only market visibility from a verified admin PAT scope", async () => {
    resolveDesktopIdentity.mockResolvedValueOnce({
      ...identity(),
      scopes: ["workspace:chat", "desktop:managed", "admin:enter"],
    });
    const { GET } = await import("../route");
    await GET(
      new Request("https://portal.example.invalid/api/desktop/config-market"),
    );
    expect(listVisibleMetadata).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "tenant-a",
        userId: "user-a",
        isAdmin: true,
      }),
      expect.anything(),
    );
  });
});
