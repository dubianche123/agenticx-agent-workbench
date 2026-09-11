import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAdminScopedCapability: vi.fn(),
  requireAdminTarget: vi.fn(),
  getPrincipal: vi.fn(),
  getDepartmentsRepository: vi.fn(),
  getGrantableRoleOptions: vi.fn(),
  assignPrincipalRoleBinding: vi.fn(),
  hasSomeScope: vi.fn(),
  listPrincipalRoleBindings: vi.fn(),
  listRoles: vi.fn(),
  assertGrantable: vi.fn(),
}));

vi.mock("server-only", () => ({}));

vi.mock("@agenticx/iam-core", () => ({
  getPrincipal: (...args: unknown[]) => mocks.getPrincipal(...args),
  getDepartmentsRepository: (...args: unknown[]) => mocks.getDepartmentsRepository(...args),
  getGrantableRoleOptions: (...args: unknown[]) => mocks.getGrantableRoleOptions(...args),
  assignPrincipalRoleBinding: (...args: unknown[]) => mocks.assignPrincipalRoleBinding(...args),
  hasSomeScope: (...args: unknown[]) => mocks.hasSomeScope(...args),
  listPrincipalRoleBindings: (...args: unknown[]) => mocks.listPrincipalRoleBindings(...args),
  listRoles: (...args: unknown[]) => mocks.listRoles(...args),
}));

vi.mock("../../../../../../../lib/admin-auth", () => ({
  requireAdminScopedCapability: (...args: unknown[]) => mocks.requireAdminScopedCapability(...args),
  requireAdminTarget: (...args: unknown[]) => mocks.requireAdminTarget(...args),
}));

vi.mock("../../../../iam/authorization", () => ({
  assertGrantable: (...args: unknown[]) => mocks.assertGrantable(...args),
  errorEnvelope: (error: unknown) => ({ code: "40000", message: error instanceof Error ? error.message : "invalid request" }),
  errorStatus: () => 400,
}));

describe("principal role-binding route", () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
    mocks.requireAdminScopedCapability.mockResolvedValue({
      ok: true,
      session: { tenantId: "tenant-a", userId: "admin-a", email: "admin@example.com" },
      scopes: ["role:assign"],
      context: { effectivePermissions: [] },
    });
    mocks.requireAdminTarget.mockResolvedValue({ ok: true });
    mocks.getPrincipal.mockResolvedValue({ id: "principal-a", tenantId: "tenant-a", kind: "user", status: "active", userId: "user-a", agentProfile: null });
    mocks.getDepartmentsRepository.mockReturnValue({ listDepartmentsFlat: vi.fn().mockResolvedValue([{ id: "dept-a", name: "研发部" }]) });
    mocks.getGrantableRoleOptions.mockResolvedValue([]);
    mocks.hasSomeScope.mockReturnValue(true);
    mocks.listPrincipalRoleBindings.mockResolvedValue([]);
    mocks.listRoles.mockResolvedValue([
      { id: "role-a", code: "operator", name: "Operator", scopes: ["user:read"], immutable: false },
    ]);
    mocks.assertGrantable.mockResolvedValue(undefined);
    mocks.assignPrincipalRoleBinding.mockResolvedValue({
      id: "binding-a",
      tenantId: "tenant-a",
      principalId: "principal-a",
      roleId: "role-a",
      roleCode: "operator",
      scopes: ["user:read"],
      dataScope: "department",
      scopeOrgId: null,
      scopeDeptId: "dept-a",
      expiresAt: "2030-01-01T00:00:00.000Z",
      status: "active",
      resolution: "resolved",
      resolutionReason: null,
      createdByUserId: "admin-a",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("maps the explicit data scope and expiry into the shared grantability guard", async () => {
    const { POST } = await import("../route");
    const response = await POST(
      new Request("https://admin.example.com/api/admin/principals/principal-a/role-bindings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          roleId: "role-a",
          dataScope: "department",
          scopeDeptId: "dept-a",
          expiresAt: "2030-01-01",
        }),
      }),
      { params: Promise.resolve({ id: "principal-a" }) },
    );

    expect(response.status).toBe(200);
    expect(mocks.requireAdminTarget).toHaveBeenCalledWith(["role:assign"], { kind: "user", id: "user-a" });
    expect(mocks.assertGrantable).toHaveBeenCalledWith({
      tenantId: "tenant-a",
      actorUserId: "admin-a",
      targetPrincipalId: "principal-a",
      roleId: "role-a",
      dataScope: "department",
      scopeOrgId: null,
      scopeDeptId: "dept-a",
      expiresAt: "2030-01-01T00:00:00.000Z",
    });
    expect(mocks.assignPrincipalRoleBinding).toHaveBeenCalledWith({
      tenantId: "tenant-a",
      principalId: "principal-a",
      roleId: "role-a",
      dataScope: "department",
      scopeOrgId: null,
      scopeDeptId: "dept-a",
      expiresAt: "2030-01-01T00:00:00.000Z",
      actorUserId: "admin-a",
    });
  });

  it("rejects department bindings without a department id before the guard", async () => {
    const { POST } = await import("../route");
    const response = await POST(
      new Request("https://admin.example.com/api/admin/principals/principal-a/role-bindings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ roleId: "role-a", dataScope: "department" }),
      }),
      { params: Promise.resolve({ id: "principal-a" }) },
    );

    expect(response.status).toBe(400);
    expect(mocks.assertGrantable).not.toHaveBeenCalled();
    expect(mocks.assignPrincipalRoleBinding).not.toHaveBeenCalled();
  });

  it("preserves an explicit null expiry as a permanent binding", async () => {
    const { POST } = await import("../route");
    const response = await POST(
      new Request("https://admin.example.com/api/admin/principals/principal-a/role-bindings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ roleId: "role-a", dataScope: "tenant", expiresAt: null }),
      }),
      { params: Promise.resolve({ id: "principal-a" }) },
    );
    expect(response.status).toBe(200);
    expect(mocks.assertGrantable).toHaveBeenCalledWith(expect.objectContaining({ expiresAt: null }));
    expect(mocks.assignPrincipalRoleBinding).toHaveBeenCalledWith(expect.objectContaining({ expiresAt: null }));
  });

  it("keeps an omitted expiry distinct from an explicit permanent expiry", async () => {
    const { POST } = await import("../route");
    const response = await POST(
      new Request("https://admin.example.com/api/admin/principals/principal-a/role-bindings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ roleId: "role-a", dataScope: "tenant" }),
      }),
      { params: Promise.resolve({ id: "principal-a" }) },
    );
    expect(response.status).toBe(200);
    expect(mocks.assertGrantable).toHaveBeenCalledWith(expect.objectContaining({ expiresAt: undefined }));
    expect(mocks.assignPrincipalRoleBinding).toHaveBeenCalledWith(expect.objectContaining({ expiresAt: undefined }));
  });

  it("passes a future expiry through as an ISO instant and rejects a past expiry", async () => {
    const { POST } = await import("../route");
    const future = new Date(Date.now() + 60 * 60 * 1000);
    const futureResponse = await POST(
      new Request("https://admin.example.com/api/admin/principals/principal-a/role-bindings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ roleId: "role-a", dataScope: "tenant", expiresAt: future.toISOString() }),
      }),
      { params: Promise.resolve({ id: "principal-a" }) },
    );
    expect(futureResponse.status).toBe(200);
    expect(mocks.assertGrantable).toHaveBeenCalledWith(expect.objectContaining({ expiresAt: future.toISOString() }));

    const pastResponse = await POST(
      new Request("https://admin.example.com/api/admin/principals/principal-a/role-bindings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ roleId: "role-a", dataScope: "tenant", expiresAt: "2020-01-01T00:00:00.000Z" }),
      }),
      { params: Promise.resolve({ id: "principal-a" }) },
    );
    expect(pastResponse.status).toBe(400);
  });

  it("rejects malformed and non-string expiry values", async () => {
    const { POST } = await import("../route");
    for (const expiresAt of ["not-a-date", 123]) {
      const response = await POST(
        new Request("https://admin.example.com/api/admin/principals/principal-a/role-bindings", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ roleId: "role-a", dataScope: "tenant", expiresAt }),
        }),
        { params: Promise.resolve({ id: "principal-a" }) },
      );
      expect(response.status).toBe(400);
    }
  });

  it("does not accept an opaque client grantor or approval reference", async () => {
    const { POST } = await import("../route");
    const response = await POST(
      new Request("https://admin.example.com/api/admin/principals/principal-a/role-bindings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          roleId: "role-a",
          dataScope: "tenant",
          grantedByPrincipalId: "superadmin-principal",
          grantorApprovalRef: "forged-approval",
        }),
      }),
      { params: Promise.resolve({ id: "principal-a" }) },
    );

    expect(response.status).toBe(400);
    expect(mocks.assertGrantable).not.toHaveBeenCalled();
    expect(mocks.assignPrincipalRoleBinding).not.toHaveBeenCalled();
  });
});
