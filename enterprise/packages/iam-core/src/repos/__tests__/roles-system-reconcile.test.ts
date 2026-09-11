import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getIamDb: vi.fn(),
  getMysqlRepositoryDb: vi.fn(),
  resolveDatabaseConfig: vi.fn(),
}));

vi.mock("../../db", () => ({
  getIamDb: mocks.getIamDb,
}));

vi.mock("../../database/config", () => ({
  resolveDatabaseConfig: mocks.resolveDatabaseConfig,
}));

vi.mock("../mysql/db", () => ({
  getMysqlRepositoryDb: mocks.getMysqlRepositoryDb,
}));

vi.mock("../audit", () => ({
  insertAuditEvent: vi.fn(),
}));

vi.mock("../mysql/audit", () => ({
  insertMysqlAuditEvent: vi.fn(),
}));

import { ensureSystemRoles, SYSTEM_ROLE_SEED } from "../roles";
import { MYSQL_SYSTEM_ROLE_SEED, mysqlRolesRepository } from "../mysql/roles";

type ReconcileSet = {
  name: string;
  scopes: string[];
  immutable: boolean;
  updatedAt: Date;
};

function expectSearchManagementScopes(seed: typeof SYSTEM_ROLE_SEED): void {
  const byCode = new Map(seed.map((role) => [role.code, role]));
  expect(byCode.get("owner")?.scopes).toContain("provider:read");
  expect(byCode.get("owner")?.scopes).toContain("provider:update");
  expect(byCode.get("admin")?.scopes).toContain("provider:read");
  expect(byCode.get("admin")?.scopes).toContain("provider:update");
  expect(byCode.get("auditor")?.scopes).not.toContain("provider:read");
  expect(byCode.get("auditor")?.scopes).not.toContain("provider:update");
  expect(byCode.get("dept_admin")?.scopes).not.toContain("provider:read");
  expect(byCode.get("dept_admin")?.scopes).not.toContain("provider:update");
}

describe("system role reconciliation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps PostgreSQL system roles on the canonical permission set", async () => {
    const chain = () => {
      const query = {
        from: vi.fn(() => query),
        where: vi.fn(() => query),
        orderBy: vi.fn(() => query),
        for: vi.fn(() => query),
        limit: vi.fn(async () => []),
      };
      return query;
    };
    const inserts: unknown[] = [];
    const db = {
      transaction: vi.fn(async (callback: (tx: typeof db) => Promise<void>) => callback(db)),
      select: vi.fn(() => chain()),
      insert: vi.fn(() => ({ values: vi.fn(async (values: unknown) => { inserts.push(values); }) })),
      update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(async () => undefined) })) })),
    };
    mocks.resolveDatabaseConfig.mockReturnValue({
      dialect: "postgresql",
      url: "postgresql://localhost/agenticx",
    });
    mocks.getIamDb.mockReturnValue(db);

    await ensureSystemRoles("tenant-1");

    expectSearchManagementScopes(SYSTEM_ROLE_SEED);
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(inserts).toHaveLength(SYSTEM_ROLE_SEED.length);
    expect(inserts.find((value) => (value as { code?: string }).code === "owner")).toMatchObject({
      scopes: expect.arrayContaining(["provider:read", "provider:update"]),
    });
    expect(inserts.find((value) => (value as { code?: string }).code === "auditor")).toMatchObject({
      scopes: expect.not.arrayContaining(["provider:read", "provider:update"]),
    });
  });

  it("updates existing MySQL system roles without replacing their ids", async () => {
    expect(MYSQL_SYSTEM_ROLE_SEED).toEqual(SYSTEM_ROLE_SEED);
    expectSearchManagementScopes(MYSQL_SYSTEM_ROLE_SEED);

    let selectedIndex = 0;
    const chain = () => {
      const query = {
        from: vi.fn(() => query),
        where: vi.fn(() => query),
        orderBy: vi.fn(() => query),
        for: vi.fn(() => query),
        limit: vi.fn(async () => {
          const selectedCode = MYSQL_SYSTEM_ROLE_SEED[selectedIndex]?.code ?? "";
          selectedIndex += 1;
          return selectedCode ? [{ id: `existing-${selectedCode}`, name: "old", scopes: [], immutable: true }] : [];
        }),
      };
      return query;
    };
    const updates: Array<{ set: ReconcileSet }> = [];
    const db = {
      transaction: vi.fn(async (callback: (tx: typeof db) => Promise<void>) => callback(db)),
      select: vi.fn(() => chain()),
      update: vi.fn(() => ({
        set: vi.fn((set: ReconcileSet) => ({ where: vi.fn(async () => { updates.push({ set }); }) })),
      })),
      insert: vi.fn(() => ({ values: vi.fn(async () => undefined) })),
    };
    mocks.getMysqlRepositoryDb.mockResolvedValue(db);

    await mysqlRolesRepository.ensureSystemRoles("tenant-1");

    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(updates).toHaveLength(MYSQL_SYSTEM_ROLE_SEED.length);
    expect(updates.find((update) => update.set.scopes?.includes("provider:read"))).toBeDefined();
    expect(updates.find((update) => update.set.scopes?.includes("provider:update"))).toBeDefined();
  });
});
