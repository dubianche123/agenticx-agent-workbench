import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAdminScope: vi.fn(),
  requireAdminScopedCapability: vi.fn(),
  requireAdminTarget: vi.fn(),
  softDeleteUser: vi.fn(),
  updateAdminUser: vi.fn(),
  removeUserFromAllGroups: vi.fn(),
  getDefaultOrgId: vi.fn(),
}));

vi.mock("server-only", () => ({}));

vi.mock("@agenticx/iam-core", () => ({
  getAdminUser: vi.fn(),
  softDeleteUser: (...args: unknown[]) => mocks.softDeleteUser(...args),
  updateAdminUser: (...args: unknown[]) => mocks.updateAdminUser(...args),
}));

vi.mock("../../../../../../lib/admin-auth", () => ({
  requireAdminScope: (...args: unknown[]) => mocks.requireAdminScope(...args),
  requireAdminScopedCapability: (...args: unknown[]) => mocks.requireAdminScopedCapability(...args),
  requireAdminTarget: (...args: unknown[]) => mocks.requireAdminTarget(...args),
}));

vi.mock("../../../../../../lib/admin-pg-auth", () => ({
  getDefaultOrgId: (...args: unknown[]) => mocks.getDefaultOrgId(...args),
}));

vi.mock("../../../../../../lib/user-groups-store", () => ({
  removeUserFromAllGroups: (...args: unknown[]) => mocks.removeUserFromAllGroups(...args),
}));

describe("admin user route", () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
    mocks.requireAdminScope.mockResolvedValue({
      ok: true,
      session: { tenantId: "tenant-a", userId: "admin-a" },
    });
    mocks.requireAdminScopedCapability.mockResolvedValue({
      ok: true,
      session: { tenantId: "tenant-a", userId: "admin-a" },
      scopes: ["user:read", "user:update", "user:delete"],
      context: { tenantId: "tenant-a", userId: "admin-a", userStatus: "active", principalStatus: "active" },
    });
    mocks.requireAdminTarget.mockResolvedValue({ ok: true });
    mocks.softDeleteUser.mockResolvedValue(undefined);
    mocks.updateAdminUser.mockResolvedValue({ id: "user-a" });
    mocks.removeUserFromAllGroups.mockResolvedValue(2);
    mocks.getDefaultOrgId.mockResolvedValue("org-a");
  });

  it("persists clearing optional profile fields", async () => {
    const { PATCH } = await import("../route");
    const response = await PATCH(
      new Request("https://admin.example.com/api/admin/users/user-a", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phone: null, employeeNo: "", jobTitle: "   " }),
      }),
      { params: Promise.resolve({ id: "user-a" }) },
    );

    expect(response.status).toBe(200);
    expect(mocks.updateAdminUser).toHaveBeenCalledWith(
      "tenant-a",
      "user-a",
      { phone: null, employeeNo: null, jobTitle: null },
      { actorUserId: "admin-a", defaultOrgId: "org-a" },
    );
  });

  it("rejects legacy roleCodes updates on the profile route", async () => {
    const { PATCH } = await import("../route");
    const response = await PATCH(
      new Request("https://admin.example.com/api/admin/users/user-a", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ displayName: "User", roleCodes: ["admin"] }),
      }),
      { params: Promise.resolve({ id: "user-a" }) },
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      code: "40300",
      message: "role assignment requires role:assign",
    });
    expect(mocks.updateAdminUser).not.toHaveBeenCalled();
  });

  it("removes the deleted user from all groups after IAM deletion", async () => {
    const { DELETE } = await import("../route");
    const response = await DELETE(
      new Request("https://admin.example.com/api/admin/users/deleted", { method: "DELETE" }),
      { params: Promise.resolve({ id: "deleted" }) },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      code: "00000",
      data: { removedFromGroups: 2, groupCleanupPending: false },
    });
    expect(mocks.softDeleteUser).toHaveBeenCalledWith("tenant-a", "deleted", "admin-a");
    expect(mocks.removeUserFromAllGroups).toHaveBeenCalledWith("tenant-a", "deleted");
    expect(mocks.softDeleteUser.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.removeUserFromAllGroups.mock.invocationCallOrder[0]!,
    );
  });

  it("does not report IAM deletion as failed when best-effort group cleanup fails", async () => {
    mocks.removeUserFromAllGroups.mockRejectedValue(new Error("quota store unavailable"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { DELETE } = await import("../route");

    const response = await DELETE(
      new Request("https://admin.example.com/api/admin/users/deleted", { method: "DELETE" }),
      { params: Promise.resolve({ id: "deleted" }) },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      code: "00000",
      data: { removedFromGroups: 0, groupCleanupPending: true },
    });
    expect(consoleError).toHaveBeenCalledWith(
      "[admin/users] deleted user group cleanup failed:",
      expect.stringContaining("quota store unavailable"),
    );
    consoleError.mockRestore();
  });
});
