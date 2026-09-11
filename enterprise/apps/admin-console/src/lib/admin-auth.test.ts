import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cookies: vi.fn(),
  verifyAdminSessionToken: vi.fn(),
  getAdminUser: vi.fn(),
  aggregateScopesForUser: vi.fn(),
  getUserAuthorizationContext: vi.fn(),
  authorizePrincipalAction: vi.fn(),
}));

vi.mock("next/headers", () => ({
  cookies: (...args: unknown[]) => mocks.cookies(...args),
}));
vi.mock("./admin-session", () => ({
  ADMIN_SESSION_COOKIE: "agenticx_admin_session",
  verifyAdminSessionToken: (...args: unknown[]) => mocks.verifyAdminSessionToken(...args),
}));
vi.mock("@agenticx/iam-core", () => ({
  getAdminUser: (...args: unknown[]) => mocks.getAdminUser(...args),
  aggregateScopesForUser: (...args: unknown[]) => mocks.aggregateScopesForUser(...args),
  getUserAuthorizationContext: (...args: unknown[]) => mocks.getUserAuthorizationContext(...args),
  authorizePrincipalAction: (...args: unknown[]) => mocks.authorizePrincipalAction(...args),
  expandRoleScopes: (scopes: string[]) => scopes,
  hasEveryScope: (granted: string[], required: string[]) =>
    required.every((scope) => granted.includes(scope)),
  hasSomeScope: (granted: string[], candidates: string[]) =>
    candidates.some((scope) => granted.includes(scope)),
}));

import { getAdminSession, requireAdminScope } from "./admin-auth";

describe("admin auth live revocation", () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
    mocks.cookies.mockResolvedValue({ get: () => ({ value: "signed-cookie" }) });
    mocks.verifyAdminSessionToken.mockReturnValue({
      tenantId: "tenant-a",
      userId: "admin-a",
      email: "old@example.com",
    });
    mocks.getAdminUser.mockResolvedValue({
      id: "admin-a",
      tenantId: "tenant-a",
      email: "live@example.com",
      displayName: "管理员",
      status: "active",
    });
    mocks.aggregateScopesForUser.mockResolvedValue(["provider:update"]);
    mocks.getUserAuthorizationContext.mockResolvedValue({
      userStatus: "active",
      userPrincipal: { status: "active" },
      scopes: ["provider:update"],
      effectivePermissions: [],
    });
    mocks.authorizePrincipalAction.mockResolvedValue({ allowed: true });
  });

  it("checks the live user and returns current directory identity", async () => {
    await expect(getAdminSession()).resolves.toEqual({
      tenantId: "tenant-a",
      userId: "admin-a",
      email: "live@example.com",
    });
    expect(mocks.getAdminUser).toHaveBeenCalledWith("tenant-a", "admin-a");
  });

  it.each(["locked", "disabled"])("rejects a %s administrator's signed cookie", async (status) => {
    mocks.getAdminUser.mockResolvedValueOnce({
      id: "admin-a",
      tenantId: "tenant-a",
      email: "admin@example.com",
      status,
    });
    const result = await requireAdminScope(["provider:update"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(401);
    expect(mocks.aggregateScopesForUser).not.toHaveBeenCalled();
  });
});
