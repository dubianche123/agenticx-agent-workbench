import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAdminScope: vi.fn(),
  createSessionGrant: vi.fn(),
  listSessionGrants: vi.fn(),
  revokeSessionGrant: vi.fn(),
}));

vi.mock("@agenticx/iam-core", () => ({
  createSessionGrant: (...args: unknown[]) => mocks.createSessionGrant(...args),
  listSessionGrants: (...args: unknown[]) => mocks.listSessionGrants(...args),
  revokeSessionGrant: (...args: unknown[]) => mocks.revokeSessionGrant(...args),
}));

vi.mock("../../../../../lib/admin-auth", () => ({
  requireAdminScope: (...args: unknown[]) => mocks.requireAdminScope(...args),
}));

describe("admin session grants tenant isolation", () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
    mocks.requireAdminScope.mockResolvedValue({
      ok: true,
      session: { tenantId: "tenant-a", userId: "admin-a" },
    });
    mocks.listSessionGrants.mockResolvedValue([]);
    mocks.createSessionGrant.mockResolvedValue({ id: "grant-a" });
    mocks.revokeSessionGrant.mockResolvedValue({ id: "grant-a" });
  });

  it("lists only the signed-in tenant's grants", async () => {
    const { GET } = await import("../route");
    const response = await GET();

    expect(response.status).toBe(200);
    expect(mocks.listSessionGrants).toHaveBeenCalledWith(100, "tenant-a");
  });

  it("issues grants for the signed-in tenant and records the actor", async () => {
    const { POST } = await import("../route");
    const response = await POST(
      new Request("https://admin.example.com/api/admin/session-grants", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionId: "session-a",
          scopes: ["workspace:read"],
          ttlSeconds: 600,
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.createSessionGrant).toHaveBeenCalledWith({
      tenantId: "tenant-a",
      sessionId: "session-a",
      scopes: ["workspace:read"],
      ttlSeconds: 600,
      createdBy: "admin-a",
      description: undefined,
    });
  });

  it("cannot revoke a grant outside the signed-in tenant", async () => {
    const { DELETE } = await import("../route");
    const response = await DELETE(
      new Request("https://admin.example.com/api/admin/session-grants?id=grant-a", {
        method: "DELETE",
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.revokeSessionGrant).toHaveBeenCalledWith("grant-a", "tenant-a");
  });
});
