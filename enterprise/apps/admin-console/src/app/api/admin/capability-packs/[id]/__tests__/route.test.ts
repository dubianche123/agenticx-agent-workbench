import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CAPABILITY_PACK_CONFLICT_CODE,
  CAPABILITY_PACK_CONFLICT_MESSAGE,
  CapabilityPackVersionConflictError,
} from "../../../../../../lib/capability-pack-concurrency";
import { MissingPortableDependenciesError } from "../../../../../../lib/portable-pack-dependencies";

const mocks = vi.hoisted(() => ({
  requireAdminScope: vi.fn(),
  getCapabilityPack: vi.fn(),
  listCapabilityPacks: vi.fn(),
  updateCapabilityPack: vi.fn(),
  deleteCapabilityPack: vi.fn(),
  insertAuditEvent: vi.fn(),
  listPublishedConfigMarketCapabilityIds: vi.fn(),
}));

vi.mock("@agenticx/iam-core", () => ({
  insertAuditEvent: (...args: unknown[]) => mocks.insertAuditEvent(...args),
}));

vi.mock("../../../../../../lib/admin-auth", () => ({
  requireAdminScope: (...args: unknown[]) => mocks.requireAdminScope(...args),
}));
vi.mock("../../../../../../lib/capability-packs-store", () => ({
  getCapabilityPack: (...args: unknown[]) => mocks.getCapabilityPack(...args),
  listCapabilityPacks: (...args: unknown[]) => mocks.listCapabilityPacks(...args),
  updateCapabilityPack: (...args: unknown[]) => mocks.updateCapabilityPack(...args),
  deleteCapabilityPack: (...args: unknown[]) => mocks.deleteCapabilityPack(...args),
}));
vi.mock("../../../../../../lib/config-market-store", () => ({
  listPublishedConfigMarketCapabilityIds: (...args: unknown[]) =>
    mocks.listPublishedConfigMarketCapabilityIds(...args),
}));

const id = "01JQMZ8K3N4P5Q6R7S8T9VWXYZ";
const UPDATED_AT = "2026-08-28T08:00:00.000Z";
const pack = {
  id,
  tenantId: "tenant-session",
  slug: "portable",
  status: "active",
  capabilityIds: [],
  assignmentKeys: [],
  updatedAt: UPDATED_AT,
};
const context = { params: Promise.resolve({ id }) };

describe("/api/admin/capability-packs/[id] tenant binding", () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
    mocks.requireAdminScope.mockResolvedValue({
      ok: true,
      session: { tenantId: "tenant-session", userId: "admin-a" },
    });
    mocks.getCapabilityPack.mockResolvedValue(pack);
    mocks.listCapabilityPacks.mockResolvedValue([
      { ...pack, status: "active", capabilityIds: [] },
    ]);
    mocks.updateCapabilityPack.mockResolvedValue(pack);
    mocks.deleteCapabilityPack.mockResolvedValue(true);
    mocks.insertAuditEvent.mockResolvedValue(undefined);
    mocks.listPublishedConfigMarketCapabilityIds.mockResolvedValue(new Set());
  });

  it("binds reads, writes and deletes to the authenticated tenant", async () => {
    const { DELETE, GET, PATCH } = await import("../route");

    expect(
      (await GET(new Request(`https://admin.example.invalid/api/admin/capability-packs/${id}`), context))
        .status,
    ).toBe(200);
    expect(mocks.getCapabilityPack).toHaveBeenCalledWith("tenant-session", id);

    const patchResponse = await PATCH(
      new Request(`https://admin.example.invalid/api/admin/capability-packs/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedUpdatedAt: UPDATED_AT, displayName: "Portable" }),
      }),
      context,
    );
    expect(patchResponse.status).toBe(200);
    expect(mocks.updateCapabilityPack).toHaveBeenCalledWith(
      "tenant-session",
      id,
      expect.objectContaining({ expectedUpdatedAt: UPDATED_AT, displayName: "Portable" }),
    );
    expect(mocks.insertAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "tenant-session",
        actorUserId: "admin-a",
        eventType: "capability_pack.update",
        targetId: id,
      }),
    );

    expect(
      (await DELETE(new Request(`https://admin.example.invalid/api/admin/capability-packs/${id}`), context))
        .status,
    ).toBe(200);
    expect(mocks.deleteCapabilityPack).toHaveBeenCalledWith("tenant-session", id);
    expect(mocks.insertAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "capability_pack.delete", targetId: id }),
    );
  });

  it("requires the version every PATCH is based on", async () => {
    const { PATCH } = await import("../route");
    const response = await PATCH(
      new Request(`https://admin.example.invalid/api/admin/capability-packs/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "disabled" }),
      }),
      context,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: "40000",
      message: "expectedUpdatedAt is required",
    });
    expect(mocks.getCapabilityPack).not.toHaveBeenCalled();
    expect(mocks.updateCapabilityPack).not.toHaveBeenCalled();
  });

  it("maps a stale version to a refreshable 409 instead of overwriting", async () => {
    mocks.updateCapabilityPack.mockRejectedValueOnce(
      new CapabilityPackVersionConflictError(
        UPDATED_AT,
        "2026-08-28T08:01:00.000Z",
      ),
    );
    const { PATCH } = await import("../route");
    const response = await PATCH(
      new Request(`https://admin.example.invalid/api/admin/capability-packs/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedUpdatedAt: UPDATED_AT, assignmentKeys: ["all"] }),
      }),
      context,
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: CAPABILITY_PACK_CONFLICT_CODE,
      message: CAPABILITY_PACK_CONFLICT_MESSAGE,
    });
    expect(mocks.insertAuditEvent).not.toHaveBeenCalled();
  });

  it("returns dependency closure failures without mutating the pack", async () => {
    const missing = "mcp:01JQMZ8K3N4P5Q6R7S8T9VWX03";
    mocks.updateCapabilityPack.mockRejectedValueOnce(new MissingPortableDependenciesError([missing]));
    const { PATCH } = await import("../route");
    const response = await PATCH(
      new Request(`https://admin.example.invalid/api/admin/capability-packs/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedUpdatedAt: UPDATED_AT, capabilityIds: [] }),
      }),
      context,
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: "40002",
      data: { missingCapabilityIds: [missing] },
    });
    expect(mocks.insertAuditEvent).not.toHaveBeenCalled();
  });

  it("surfaces the shelf membership rejection from the transactional store", async () => {
    const capabilityId = "expert:01JQMZ8K3N4P5Q6R7S8T9VWX01";
    mocks.listPublishedConfigMarketCapabilityIds.mockResolvedValueOnce(new Set([capabilityId]));
    mocks.updateCapabilityPack.mockRejectedValueOnce(
      new Error(`portable capability is not in the capability shelf: ${capabilityId}`),
    );
    const { PATCH } = await import("../route");
    const response = await PATCH(
      new Request(`https://admin.example.invalid/api/admin/capability-packs/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedUpdatedAt: UPDATED_AT,
          capabilityIds: [capabilityId],
        }),
      }),
      context,
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: "40000",
      message: expect.stringContaining("not in the capability shelf"),
    });
    expect(mocks.insertAuditEvent).not.toHaveBeenCalled();
  });
});
