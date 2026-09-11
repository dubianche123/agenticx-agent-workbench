import type { AuthUser } from "@agenticx/auth";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  aggregateScopesForUser: vi.fn(),
  ensureSystemRoles: vi.fn(),
  hasSomeScope: vi.fn(),
  loadAuthUserByEmail: vi.fn(),
  reconcileUserPasswordHashByEmail: vi.fn(),
  verifyPassword: vi.fn(),
  PgAuthUserRepository: vi.fn(),
  resolveAdminCredentials: vi.fn(),
}));

vi.mock("@agenticx/auth", () => ({
  LOGIN_LOCK_MINUTES: 15,
  MAX_FAILED_LOGIN_ATTEMPTS: 10,
  verifyPassword: (...args: unknown[]) => mocks.verifyPassword(...args),
}));

vi.mock("@agenticx/iam-core", () => ({
  aggregateScopesForUser: (...args: unknown[]) => mocks.aggregateScopesForUser(...args),
  ensureSystemRoles: (...args: unknown[]) => mocks.ensureSystemRoles(...args),
  getDefaultOrgId: vi.fn(),
  hasSomeScope: (...args: unknown[]) => mocks.hasSomeScope(...args),
  loadAuthUserByEmail: (...args: unknown[]) => mocks.loadAuthUserByEmail(...args),
  PgAuthUserRepository: mocks.PgAuthUserRepository,
  reconcileUserPasswordHashByEmail: (...args: unknown[]) =>
    mocks.reconcileUserPasswordHashByEmail(...args),
}));

vi.mock("./admin-session", () => ({
  resolveAdminCredentials: (...args: unknown[]) => mocks.resolveAdminCredentials(...args),
}));

import { authenticateAdminConsoleUserDetailed } from "./admin-pg-auth";

function activeUser(passwordHash: string): AuthUser {
  return {
    id: "user-1",
    tenantId: "tenant-1",
    deptId: null,
    email: "admin@example.com",
    displayName: "Admin",
    passwordHash,
    mustChangePassword: false,
    status: "active",
    failedLoginCount: 0,
    lockedUntil: null,
    scopes: ["admin:enter"],
  };
}

describe("Postgres admin password authentication", () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
    mocks.resolveAdminCredentials.mockReturnValue(null);
    mocks.ensureSystemRoles.mockResolvedValue(undefined);
    mocks.reconcileUserPasswordHashByEmail.mockResolvedValue(undefined);
    mocks.hasSomeScope.mockReturnValue(true);
    mocks.verifyPassword.mockResolvedValue(false);
    mocks.PgAuthUserRepository.mockImplementation(function () {
      return {
      updateFailedLogin: vi.fn(),
      resetFailedLogin: vi.fn(),
      };
    });
  });

  it("performs one dummy hash verification for an unknown account", async () => {
    mocks.loadAuthUserByEmail.mockResolvedValue(null);

    await expect(
      authenticateAdminConsoleUserDetailed({
        tenantId: "tenant-1",
        email: "missing@example.com",
        password: "wrong-password",
      }),
    ).resolves.toEqual({ ok: false, reason: "invalid" });

    expect(mocks.verifyPassword).toHaveBeenCalledTimes(1);
    expect(mocks.verifyPassword).toHaveBeenCalledWith(
      "wrong-password",
      expect.stringMatching(/^\$2b\$12\$/),
    );
  });

  it("verifies a found active account against its stored hash", async () => {
    mocks.loadAuthUserByEmail.mockResolvedValue(activeUser("stored-password-hash"));

    await expect(
      authenticateAdminConsoleUserDetailed({
        tenantId: "tenant-1",
        email: "admin@example.com",
        password: "wrong-password",
      }),
    ).resolves.toEqual({ ok: false, reason: "invalid" });

    expect(mocks.verifyPassword).toHaveBeenCalledTimes(1);
    expect(mocks.verifyPassword).toHaveBeenCalledWith("wrong-password", "stored-password-hash");
  });
});
