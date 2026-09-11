import { beforeEach, describe, expect, it, vi } from "vitest";

import { assertManagedPortableDeliveryLimit } from "../../../../../../lib/capability-pack-form";
import { parseCapabilityId } from "@agenticx/config";

const mocks = vi.hoisted(() => ({
  requireAdminScope: vi.fn(),
  getConfigMarketItemDetail: vi.fn(),
  setConfigMarketStatus: vi.fn(),
  setConfigMarketDeliveryState: vi.fn(),
  listPublishedConfigMarketCapabilityIds: vi.fn(),
  listCapabilityPacks: vi.fn(),
  insertAuditEvent: vi.fn(),
}));

vi.mock("@agenticx/iam-core", () => ({
  insertAuditEvent: (...args: unknown[]) => mocks.insertAuditEvent(...args),
}));
vi.mock("../../../../../../lib/admin-auth", () => ({
  requireAdminScope: (...args: unknown[]) => mocks.requireAdminScope(...args),
}));
vi.mock("../../../../../../lib/config-market-store", () => ({
  getConfigMarketItemDetail: (...args: unknown[]) => mocks.getConfigMarketItemDetail(...args),
  listPublishedConfigMarketCapabilityIds: (...args: unknown[]) => mocks.listPublishedConfigMarketCapabilityIds(...args),
  setConfigMarketStatus: (...args: unknown[]) => mocks.setConfigMarketStatus(...args),
  setConfigMarketDeliveryState: (...args: unknown[]) => mocks.setConfigMarketDeliveryState(...args),
}));
vi.mock("../../../../../../lib/capability-packs-store", () => ({
  listCapabilityPacks: (...args: unknown[]) => mocks.listCapabilityPacks(...args),
}));

const id = "01JQMZ8K3N4P5Q6R7S8T9VWXYZ";

describe("PATCH /api/admin/config-market/[id]", () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
    mocks.requireAdminScope.mockResolvedValue({
      ok: true,
      session: { tenantId: "tenant-admin", userId: "admin-a" },
    });
    mocks.setConfigMarketStatus.mockResolvedValue({
      id,
      kind: "expert",
      status: "unlisted",
    });
    mocks.setConfigMarketDeliveryState.mockResolvedValue({
      id,
      kind: "expert",
      status: "published",
      deliveryState: "revoked",
    });
    mocks.getConfigMarketItemDetail.mockResolvedValue({
      item: {
        id,
        capabilityId: `expert:${id}`,
        kind: "expert",
        title: "合同专家",
        description: "检查合同",
        ownerUserId: "user-a",
        ownerDisplayName: "成员甲",
        status: "published",
        createdAt: "2026-08-20T00:00:00.000Z",
        updatedAt: "2026-08-20T00:00:00.000Z",
      },
      promptPreview: {
        kind: "expert",
        name: "合同专家",
        role: "法务",
        systemPrompt: "完整提示词",
      },
      runtimeReview: {
        recommendedPermissionMode: "ask",
        expertPermissions: [{ name: "合同专家", defaultPermissionMode: "auto" }],
        dependencies: [{
          kind: "skill",
          capabilityId: "skill:01JQMZ8K3N4P5Q6R7S8T9VWX03",
          version: "1.0.0",
          digest: "a".repeat(64),
          required: true,
        }],
        resources: [{ path: "SOUL.md", content: "完整资源规则", digest: "b".repeat(64) }],
      },
    });
    mocks.insertAuditEvent.mockResolvedValue(undefined);
    mocks.listPublishedConfigMarketCapabilityIds.mockResolvedValue(new Set());
    mocks.listCapabilityPacks.mockResolvedValue([]);
  });

  it("returns a full prompt preview from the authenticated tenant with read scope", async () => {
    const { GET } = await import("../route");
    const response = await GET(
      new Request(`https://admin.example.invalid/api/admin/config-market/${id}`),
      { params: Promise.resolve({ id: id.toLowerCase() }) },
    );
    expect(response.status).toBe(200);
    expect(mocks.requireAdminScope).toHaveBeenCalledWith(["provider:read"]);
    expect(mocks.getConfigMarketItemDetail).toHaveBeenCalledWith("tenant-admin", id);
    const payload = (await response.json()) as {
      data: {
        promptPreview: { systemPrompt: string };
        runtimeReview: {
          recommendedPermissionMode: string;
          expertPermissions: Array<{ name: string; defaultPermissionMode: string }>;
          resources: Array<{ content: string }>;
        };
      };
    };
    expect(payload.data.promptPreview.systemPrompt).toBe("完整提示词");
    expect(payload.data.runtimeReview).toMatchObject({
      recommendedPermissionMode: "ask",
      expertPermissions: [{ name: "合同专家", defaultPermissionMode: "auto" }],
      resources: [{ content: "完整资源规则" }],
    });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("unlists inside the cookie-derived tenant and audits the action", async () => {
    const { PATCH } = await import("../route");
    const response = await PATCH(
      new Request(`https://admin.example.invalid/api/admin/config-market/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "unlist" }),
      }),
      { params: Promise.resolve({ id }) },
    );
    expect(response.status).toBe(200);
    expect(mocks.setConfigMarketStatus).toHaveBeenCalledWith("tenant-admin", id, "unlisted");
    expect(mocks.insertAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "tenant-admin",
        actorUserId: "admin-a",
        eventType: "config_market.unlist",
        targetId: id,
      }),
    );
  });

  it("restores with published capability ids without loading the market listing", async () => {
    mocks.setConfigMarketStatus.mockResolvedValue({
      id,
      kind: "expert",
      status: "published",
    });
    const { PATCH } = await import("../route");
    const response = await PATCH(
      new Request(`https://admin.example.invalid/api/admin/config-market/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "restore" }),
      }),
      { params: Promise.resolve({ id }) },
    );
    expect(response.status).toBe(200);
    expect(mocks.listPublishedConfigMarketCapabilityIds).toHaveBeenCalledWith("tenant-admin");
    expect(mocks.setConfigMarketStatus).toHaveBeenCalledWith("tenant-admin", id, "published");
  });

  it("rejects arbitrary status patches", async () => {
    const { PATCH } = await import("../route");
    const response = await PATCH(
      new Request(`https://admin.example.invalid/api/admin/config-market/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "published" }),
      }),
      { params: Promise.resolve({ id }) },
    );
    expect(response.status).toBe(400);
    expect(mocks.setConfigMarketStatus).not.toHaveBeenCalled();
  });

  it("revokes managed delivery independently from market listing and audits it", async () => {
    const { PATCH } = await import("../route");
    const response = await PATCH(
      new Request(`https://admin.example.invalid/api/admin/config-market/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "revoke_delivery" }),
      }),
      { params: Promise.resolve({ id }) },
    );
    expect(response.status).toBe(200);
    expect(mocks.setConfigMarketDeliveryState).toHaveBeenCalledWith("tenant-admin", id, "revoked");
    expect(mocks.setConfigMarketStatus).not.toHaveBeenCalled();
    expect(mocks.insertAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "config_market.revoke_delivery",
        detail: expect.objectContaining({ deliveryState: "revoked" }),
      }),
    );
  });

  it("allows an admins-only submission to be restored for reviewed capability-pack delivery", async () => {
    mocks.getConfigMarketItemDetail.mockResolvedValue({
      item: {
        id,
        capabilityId: `skill:${id}`,
        kind: "skill",
        title: "企业复盘 Skill",
        description: "仅提交给管理员核对",
        ownerUserId: "user-a",
        ownerDisplayName: "成员甲",
        visibility: "admins_only",
        status: "published",
        deliveryState: "revoked",
        createdAt: "2026-08-20T00:00:00.000Z",
        updatedAt: "2026-08-20T00:00:00.000Z",
      },
      promptPreview: {
        kind: "skill",
        name: "企业复盘 Skill",
        description: "仅提交给管理员核对",
        skillMd: "---\nname: enterprise-review\ndescription: 复盘\n---\n",
      },
      runtimeReview: {
        recommendedPermissionMode: null,
        expertPermissions: [],
        dependencies: [],
        resources: [],
      },
    });
    mocks.setConfigMarketDeliveryState.mockResolvedValueOnce({
      id,
      kind: "skill",
      visibility: "admins_only",
      status: "published",
      deliveryState: "active",
    });

    const { PATCH } = await import("../route");
    const response = await PATCH(
      new Request(`https://admin.example.invalid/api/admin/config-market/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "restore_delivery" }),
      }),
      { params: Promise.resolve({ id }) },
    );

    expect(response.status).toBe(200);
    expect(mocks.setConfigMarketDeliveryState).toHaveBeenCalledWith("tenant-admin", id, "active");
    expect(mocks.setConfigMarketStatus).not.toHaveBeenCalled();
  });

  it("checks the managed-package limit before restoring revoked delivery", async () => {
    const otherIds = Array.from({ length: 64 }, (_value, index) =>
      `${id.slice(0, -3)}${String(index).padStart(3, "0")}`,
    );
    mocks.getConfigMarketItemDetail.mockResolvedValueOnce({
      item: {
        id,
        capabilityId: `expert:${id}`,
        kind: "expert",
        title: "合同专家",
        description: "检查合同",
        ownerUserId: "user-a",
        ownerDisplayName: "成员甲",
        status: "published",
        deliveryState: "revoked",
        createdAt: "2026-08-20T00:00:00.000Z",
        updatedAt: "2026-08-20T00:00:00.000Z",
      },
      promptPreview: {
        kind: "expert",
        name: "合同专家",
        role: "法务",
        systemPrompt: "完整提示词",
      },
      runtimeReview: {
        recommendedPermissionMode: "ask",
        expertPermissions: [{ name: "合同专家", defaultPermissionMode: "auto" }],
        dependencies: [],
        resources: [],
      },
    });
    mocks.listCapabilityPacks.mockResolvedValueOnce([{
      status: "active",
      capabilityIds: [...otherIds.map((otherId) => `expert:${otherId}`), `expert:${id}`],
    }]);
    mocks.listPublishedConfigMarketCapabilityIds.mockResolvedValueOnce(
      new Set(otherIds.map((otherId) => `expert:${otherId}`)),
    );
    const candidateSet = new Set(otherIds.map((otherId) => `expert:${otherId}`));
    candidateSet.add(`expert:${id}`);
    expect(parseCapabilityId(`expert:${otherIds[0]}`)).not.toBeNull();
    expect(() => assertManagedPortableDeliveryLimit([{
      status: "active",
      capabilityIds: [...otherIds.map((otherId) => `expert:${otherId}`), `expert:${id}`],
    }], candidateSet)).toThrow(/65\/64/);

    const { PATCH } = await import("../route");
    const response = await PATCH(
      new Request(`https://admin.example.invalid/api/admin/config-market/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "restore_delivery" }),
      }),
      { params: Promise.resolve({ id }) },
    );
    expect(response.status).toBe(500);
    expect(mocks.setConfigMarketDeliveryState).not.toHaveBeenCalled();
  });

  it("does not report a failed mutation when only the follow-up audit write fails", async () => {
    mocks.insertAuditEvent.mockRejectedValueOnce(new Error("audit unavailable"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { PATCH } = await import("../route");
    const response = await PATCH(
      new Request(`https://admin.example.invalid/api/admin/config-market/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "unlist" }),
      }),
      { params: Promise.resolve({ id }) },
    );
    expect(response.status).toBe(200);
    expect(mocks.setConfigMarketStatus).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });
});
