import { beforeEach, describe, expect, it, vi } from "vitest";

const requireAdminScopeMock = vi.fn();
const requireAdminScopedCapabilityMock = vi.fn();
const requireAdminTargetMock = vi.fn();
const getDefaultOrgIdMock = vi.fn();
const hashPasswordMock = vi.fn();
const findOrCreateDepartmentPathMock = vi.fn();
const getIamDbMock = vi.fn();
const upsertUserByEmailInTxMock = vi.fn();
const getUsersRepositoryMock = vi.fn();
const getDepartmentsRepositoryMock = vi.fn();
const upsertUserByEmailMock = vi.fn();
const mysqlTransactionMock = vi.fn();
const listDepartmentsFlatMock = vi.fn();
const createDepartmentMock = vi.fn();
const loadAuthUserByEmailMock = vi.fn();
const assertUserRoleCodesGrantableMock = vi.fn();

vi.mock("server-only", () => ({}));

vi.mock("../../../../../../lib/admin-auth", () => ({
  requireAdminScope: (...args: unknown[]) => requireAdminScopeMock(...args),
  requireAdminScopedCapability: (...args: unknown[]) => requireAdminScopedCapabilityMock(...args),
  requireAdminTarget: (...args: unknown[]) => requireAdminTargetMock(...args),
}));

vi.mock("@agenticx/auth", () => ({
  hashPassword: (...args: unknown[]) => hashPasswordMock(...args),
}));

vi.mock("@agenticx/iam-core", () => ({
  findOrCreateDepartmentPath: (...args: unknown[]) => findOrCreateDepartmentPathMock(...args),
  getDefaultOrgId: (...args: unknown[]) => getDefaultOrgIdMock(...args),
  getDepartmentsRepository: (...args: unknown[]) => getDepartmentsRepositoryMock(...args),
  getIamDb: (...args: unknown[]) => getIamDbMock(...args),
  getUsersRepository: (...args: unknown[]) => getUsersRepositoryMock(...args),
  upsertUserByEmailInTx: (...args: unknown[]) => upsertUserByEmailInTxMock(...args),
  loadAuthUserByEmail: (...args: unknown[]) => loadAuthUserByEmailMock(...args),
  assertUserRoleCodesGrantable: (...args: unknown[]) => assertUserRoleCodesGrantableMock(...args),
}));

describe("IAM bulk import route", () => {
  beforeEach(() => {
    requireAdminScopeMock.mockReset();
    requireAdminScopedCapabilityMock.mockReset();
    requireAdminTargetMock.mockReset();
    getDefaultOrgIdMock.mockReset();
    hashPasswordMock.mockReset();
    findOrCreateDepartmentPathMock.mockReset();
    getIamDbMock.mockReset();
    upsertUserByEmailInTxMock.mockReset();
    getUsersRepositoryMock.mockReset();
    getDepartmentsRepositoryMock.mockReset();
    upsertUserByEmailMock.mockReset();
    mysqlTransactionMock.mockReset();
    listDepartmentsFlatMock.mockReset();
    createDepartmentMock.mockReset();
    loadAuthUserByEmailMock.mockReset();
    assertUserRoleCodesGrantableMock.mockReset();
    requireAdminScopeMock.mockResolvedValue({
      ok: true,
      session: { tenantId: "tenant-a", userId: "admin-a" },
    });
    requireAdminScopedCapabilityMock.mockResolvedValue({
      ok: true,
      session: { tenantId: "tenant-a", userId: "admin-a" },
      scopes: ["user:create", "dept:create", "role:assign"],
      context: { tenantId: "tenant-a", userId: "admin-a", userStatus: "active", principalStatus: "active" },
    });
    requireAdminTargetMock.mockResolvedValue({ ok: true });
    getDefaultOrgIdMock.mockResolvedValue("org-a");
    hashPasswordMock.mockResolvedValue("hashed-password");
    findOrCreateDepartmentPathMock.mockResolvedValue({ leafDeptId: "dept-a" });
    upsertUserByEmailInTxMock.mockResolvedValue(undefined);
    getUsersRepositoryMock.mockReturnValue({ dialect: "postgresql" });
    getDepartmentsRepositoryMock.mockReturnValue({
      dialect: "postgresql",
      listDepartmentsFlat: (...args: unknown[]) => listDepartmentsFlatMock(...args),
    });
    listDepartmentsFlatMock.mockResolvedValue([]);
    loadAuthUserByEmailMock.mockResolvedValue(null);
    assertUserRoleCodesGrantableMock.mockResolvedValue({
      actorPrincipalId: "principal-admin",
      actorAuthzVersion: 1,
      actorPermissionExpiresAt: null,
      grantorPrincipalId: "principal-admin",
      grantorAuthzVersion: 1,
      grantorPermissionExpiresAt: null,
      targetPrincipalId: null,
      targetAuthzVersion: null,
      roleId: null,
      roleScopes: [],
      roleScopeFingerprint: null,
      roleSnapshots: [],
    });
    upsertUserByEmailMock.mockResolvedValue(undefined);
    getIamDbMock.mockReturnValue({
      transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({}),
    });
  });

  it("returns a JSON error when setup fails before row processing", async () => {
    getDefaultOrgIdMock.mockRejectedValue(new Error("database unavailable"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const { POST } = await import("../route");
    const response = await POST(
      new Request("https://admin.example.com/api/admin/iam/bulk-import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          rows: [{ email: "user@example.com", displayName: "User" }],
        }),
      }),
    );

    expect(response.status).toBe(500);
    expect(response.headers.get("content-type")).toContain("application/json");
    await expect(response.json()).resolves.toEqual({
      code: "50001",
      message: "批量导入失败，请稍后重试；如持续失败请联系管理员",
    });
    expect(consoleError).toHaveBeenCalledWith(
      "[admin/iam/bulk-import] request failed:",
      expect.stringContaining("database unavailable"),
    );
    consoleError.mockRestore();
  });

  it("requires one shared initial password for the batch", async () => {
    const { POST } = await import("../route");
    const response = await POST(
      new Request("https://admin.example.com/api/admin/iam/bulk-import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          rows: [{ email: "user@example.com", displayName: "User" }],
        }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      code: "40000",
      message: "initialPassword must be at least 8 chars",
    });
    expect(getIamDbMock).not.toHaveBeenCalled();
  });

  it("hashes the shared password and forces first-login rotation for every row", async () => {
    const { POST } = await import("../route");
    const response = await POST(
      new Request("https://admin.example.com/api/admin/iam/bulk-import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          initialPassword: "TempPass123!",
          rows: [
            {
              email: "USER@example.com",
              displayName: "User",
              deptPath: "总部/研发",
              roleCodes: ["member"],
            },
            {
              email: "second@example.com",
              displayName: "Second user",
            },
          ],
        }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      code: "00000",
      data: { success: 2, failed: 0 },
    });
    expect(hashPasswordMock).toHaveBeenCalledWith("TempPass123!");
    expect(hashPasswordMock).toHaveBeenCalledTimes(1);
    expect(upsertUserByEmailInTxMock).toHaveBeenCalledTimes(2);
    expect(upsertUserByEmailInTxMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        email: "user@example.com",
        passwordHash: "hashed-password",
        mustChangePassword: true,
      }),
      undefined,
    );
  });

  it("uses the MySQL repositories instead of the PostgreSQL-only database client", async () => {
    listDepartmentsFlatMock.mockResolvedValue([]);
    createDepartmentMock.mockImplementation(async ({ name, parentId }: { name: string; parentId: string | null }) => ({
      id: `dept-${name}`,
      path: parentId ? `/总部/${name}/` : `/${name}/`,
    }));
    getUsersRepositoryMock.mockReturnValue({
      dialect: "mysql",
      transaction: (...args: unknown[]) => mysqlTransactionMock(...args),
      upsertUserByEmail: (...args: unknown[]) => upsertUserByEmailMock(...args),
    });
    getDepartmentsRepositoryMock.mockReturnValue({
      dialect: "mysql",
      listDepartmentsFlat: (...args: unknown[]) => listDepartmentsFlatMock(...args),
      createDepartment: (...args: unknown[]) => createDepartmentMock(...args),
    });
    const mysqlTx = { connection: "mysql-import-tx" };
    mysqlTransactionMock.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(mysqlTx));

    const { POST } = await import("../route");
    const response = await POST(
      new Request("https://admin.example.com/api/admin/iam/bulk-import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          initialPassword: "TempPass123!",
          rows: [{
            email: "mysql@example.com",
            displayName: "MySQL user",
            deptPath: "总部/研发",
          }],
        }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      code: "00000",
      data: { success: 1, failed: 0 },
    });
    expect(getIamDbMock).not.toHaveBeenCalled();
    expect(upsertUserByEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "mysql@example.com",
        deptId: "dept-研发",
        passwordHash: "hashed-password",
        mustChangePassword: true,
      }),
      mysqlTx,
    );
    expect(createDepartmentMock).toHaveBeenCalledTimes(2);
    expect(createDepartmentMock).toHaveBeenNthCalledWith(1, expect.objectContaining({ name: "总部", parentId: null }), mysqlTx);
    expect(createDepartmentMock).toHaveBeenNthCalledWith(2, expect.objectContaining({ name: "研发", parentId: "dept-总部" }), mysqlTx);
  });

  it("reuses an unambiguous existing department when the sheet only has its leaf name", async () => {
    listDepartmentsFlatMock.mockResolvedValue([
      {
        id: "dept-platform",
        tenantId: "tenant-a",
        orgId: "org-a",
        parentId: null,
        name: "平台研发部",
        path: "/总部/平台研发部/",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    getUsersRepositoryMock.mockReturnValue({
      dialect: "mysql",
      transaction: (...args: unknown[]) => mysqlTransactionMock(...args),
      upsertUserByEmail: (...args: unknown[]) => upsertUserByEmailMock(...args),
    });
    getDepartmentsRepositoryMock.mockReturnValue({
      dialect: "mysql",
      listDepartmentsFlat: (...args: unknown[]) => listDepartmentsFlatMock(...args),
      createDepartment: (...args: unknown[]) => createDepartmentMock(...args),
    });
    const mysqlTx = { connection: "mysql-leaf-import-tx" };
    mysqlTransactionMock.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(mysqlTx));

    const { POST } = await import("../route");
    const response = await POST(
      new Request("https://admin.example.com/api/admin/iam/bulk-import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          initialPassword: "TempPass123!",
          rows: [{
            email: "leaf-name@example.com",
            displayName: "Leaf name",
            deptPath: "平台研发部",
          }],
        }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      code: "00000",
      data: { success: 1, failed: 0 },
    });
    expect(createDepartmentMock).not.toHaveBeenCalled();
    expect(upsertUserByEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({ deptId: "dept-platform" }),
      mysqlTx,
    );
  });
});
