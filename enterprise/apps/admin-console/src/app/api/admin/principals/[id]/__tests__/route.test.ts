import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAdminSomeScopedCapability: vi.fn(),
  requireAdminScopedCapability: vi.fn(),
  requireAdminTarget: vi.fn(),
  getPrincipal: vi.fn(),
  getDepartmentsRepository: vi.fn(),
  hasSomeScope: vi.fn(),
  listPrincipalRoleBindings: vi.fn(),
  listRoles: vi.fn(),
  updateAgentPrincipal: vi.fn(),
}));

vi.mock("server-only", () => ({}));

vi.mock("@agenticx/iam-core", () => ({
  getDepartmentsRepository: (...args: unknown[]) => mocks.getDepartmentsRepository(...args),
  getPrincipal: (...args: unknown[]) => mocks.getPrincipal(...args),
  hasSomeScope: (...args: unknown[]) => mocks.hasSomeScope(...args),
  listPrincipalRoleBindings: (...args: unknown[]) => mocks.listPrincipalRoleBindings(...args),
  listRoles: (...args: unknown[]) => mocks.listRoles(...args),
  updateAgentPrincipal: (...args: unknown[]) => mocks.updateAgentPrincipal(...args),
}));

vi.mock("../../../../../../lib/admin-auth", () => ({
  requireAdminSomeScopedCapability: (...args: unknown[]) => mocks.requireAdminSomeScopedCapability(...args),
  requireAdminScopedCapability: (...args: unknown[]) => mocks.requireAdminScopedCapability(...args),
  requireAdminTarget: (...args: unknown[]) => mocks.requireAdminTarget(...args),
}));

vi.mock("../../../iam/authorization", () => ({
  errorEnvelope: (error: unknown) => ({ code: "40000", message: error instanceof Error ? error.message : "invalid request" }),
  errorStatus: () => 400,
}));

describe("principal detail route", () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
    mocks.requireAdminSomeScopedCapability.mockResolvedValue({
      ok: true,
      session: { tenantId: "tenant-a", userId: "admin-a" },
      scopes: ["user:read"],
      context: { effectivePermissions: [] },
    });
    mocks.requireAdminTarget.mockResolvedValue({ ok: true });
    mocks.getPrincipal.mockResolvedValue({
      id: "principal-user-a",
      tenantId: "tenant-a",
      kind: "user",
      status: "active",
      userId: "backing-user-a",
      agentProfile: null,
    });
    mocks.hasSomeScope.mockReturnValue(false);
  });

  it("authorizes a user principal detail request against its backing user", async () => {
    const { GET } = await import("../route");
    const response = await GET(
      new Request("https://admin.example.com/api/admin/principals/principal-user-a"),
      { params: Promise.resolve({ id: "principal-user-a" }) },
    );

    expect(response.status).toBe(200);
    expect(mocks.requireAdminTarget).toHaveBeenCalledWith(["user:read"], {
      kind: "user",
      id: "backing-user-a",
    });
    await expect(response.json()).resolves.toMatchObject({
      data: { principal: { id: "principal-user-a", userId: "backing-user-a" } },
    });
  });
});
