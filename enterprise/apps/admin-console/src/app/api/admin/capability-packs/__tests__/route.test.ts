import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MissingPortableDependenciesError,
  UnresolvablePortableDependenciesError,
} from "../../../../../lib/portable-pack-dependencies";

const mocks = vi.hoisted(() => ({
  requireAdminScope: vi.fn(),
  listCapabilityPacks: vi.fn(),
  createCapabilityPack: vi.fn(),
  listPublishedConfigMarketCapabilityIds: vi.fn(),
  insertAuditEvent: vi.fn(),
}));

vi.mock("@agenticx/iam-core", () => ({
  insertAuditEvent: (...args: unknown[]) => mocks.insertAuditEvent(...args),
}));

vi.mock("../../../../../lib/admin-auth", () => ({
  requireAdminScope: (...args: unknown[]) => mocks.requireAdminScope(...args),
}));
vi.mock("../../../../../lib/capability-packs-store", () => ({
  listCapabilityPacks: (...args: unknown[]) => mocks.listCapabilityPacks(...args),
  createCapabilityPack: (...args: unknown[]) => mocks.createCapabilityPack(...args),
}));
vi.mock("../../../../../lib/config-market-store", () => ({
  listPublishedConfigMarketCapabilityIds: (...args: unknown[]) =>
    mocks.listPublishedConfigMarketCapabilityIds(...args),
}));

const existingPack = {
  id: "01JQMZ8K3N4P5Q6R7S8T9VWXYZ",
  tenantId: "tenant-session",
  slug: "existing",
};

describe("/api/admin/capability-packs tenant binding", () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
    mocks.requireAdminScope.mockResolvedValue({
      ok: true,
      session: { tenantId: "tenant-session", userId: "admin-a" },
    });
    mocks.listCapabilityPacks.mockResolvedValue([existingPack]);
    mocks.createCapabilityPack.mockResolvedValue(existingPack);
    mocks.listPublishedConfigMarketCapabilityIds.mockResolvedValue(new Set());
    mocks.insertAuditEvent.mockResolvedValue(undefined);
  });

  it("lists only through the authenticated session tenant", async () => {
    const { GET } = await import("../route");
    const response = await GET();

    expect(response.status).toBe(200);
    expect(mocks.listCapabilityPacks).toHaveBeenCalledWith("tenant-session");
  });

  it("creates the pack inside the authenticated session tenant", async () => {
    const { POST } = await import("../route");
    const response = await POST(
      new Request("https://admin.example.invalid/api/admin/capability-packs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug: "portable", capabilityIds: [] }),
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.createCapabilityPack).toHaveBeenCalledWith(
      "tenant-session",
      expect.objectContaining({ slug: "portable" }),
    );
    expect(mocks.insertAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "tenant-session",
        actorUserId: "admin-a",
        eventType: "capability_pack.create",
        targetId: existingPack.id,
      }),
    );
  });

  it("rejects a 65th active managed expert before writing the pack", async () => {
    mocks.listCapabilityPacks.mockResolvedValueOnce([]);
    const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    const capabilityIds = Array.from({ length: 65 }, (_, index) =>
      `expert:${"0".repeat(24)}${alphabet[Math.floor(index / 32)]}${alphabet[index % 32]}`,
    );
    mocks.listPublishedConfigMarketCapabilityIds.mockResolvedValueOnce(new Set(capabilityIds));
    const { POST } = await import("../route");
    const response = await POST(
      new Request("https://admin.example.invalid/api/admin/capability-packs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug: "too-large", capabilityIds }),
      }),
    );
    expect(response.status).toBe(400);
    expect(mocks.createCapabilityPack).not.toHaveBeenCalled();
  });

  it("returns the missing required dependency ids from the transactional store", async () => {
    const missing = "skill:01JQMZ8K3N4P5Q6R7S8T9VWX03";
    mocks.createCapabilityPack.mockRejectedValueOnce(new MissingPortableDependenciesError([missing]));
    const { POST } = await import("../route");
    const response = await POST(
      new Request("https://admin.example.invalid/api/admin/capability-packs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug: "missing-dependency", capabilityIds: [] }),
      }),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: "40002",
      data: { missingCapabilityIds: [missing] },
    });
  });

  it("returns registry mismatch ids instead of accepting a broken managed package", async () => {
    const dependency = "skill:01JQMZ8K3N4P5Q6R7S8T9VWX03";
    mocks.createCapabilityPack.mockRejectedValueOnce(
      new UnresolvablePortableDependenciesError([dependency]),
    );
    const { POST } = await import("../route");
    const response = await POST(
      new Request("https://admin.example.invalid/api/admin/capability-packs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug: "mismatched-dependency", capabilityIds: [] }),
      }),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: "40003",
      data: { dependencyCapabilityIds: [dependency] },
    });
  });

  it("surfaces the shelf membership rejection from the transactional store", async () => {
    mocks.createCapabilityPack.mockRejectedValueOnce(
      new Error("portable capability is not in the capability shelf: expert:01JQMZ8K3N4P5Q6R7S8T9VWX01"),
    );
    const { POST } = await import("../route");
    const response = await POST(
      new Request("https://admin.example.invalid/api/admin/capability-packs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          slug: "shelf-required",
          capabilityIds: ["expert:01JQMZ8K3N4P5Q6R7S8T9VWX01"],
        }),
      }),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: "40000",
      message: expect.stringContaining("not in the capability shelf"),
    });
    expect(mocks.insertAuditEvent).not.toHaveBeenCalled();
  });
});
