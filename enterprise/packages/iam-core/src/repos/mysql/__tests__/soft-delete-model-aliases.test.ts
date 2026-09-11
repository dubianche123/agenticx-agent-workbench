import { beforeEach, describe, expect, it, vi } from "vitest";

type Column = { table: "users" | "userRoles" | "models" | "tenants"; name: string };
type Row = Record<string, unknown>;

const TENANT = "tenant-a";
const USER_ID = "user-a";
const ADMIN_ID = "admin-a";

const tables = vi.hoisted(() => ({
  users: {
    tenantId: { table: "users", name: "tenantId" } as Column,
    id: { table: "users", name: "id" } as Column,
    isDeleted: { table: "users", name: "isDeleted" } as Column,
    deletedAt: { table: "users", name: "deletedAt" } as Column,
    email: { table: "users", name: "email" } as Column,
    displayName: { table: "users", name: "displayName" } as Column,
  },
  userRoles: {
    tenantId: { table: "userRoles", name: "tenantId" } as Column,
    userId: { table: "userRoles", name: "userId" } as Column,
  },
  models: {
    tenantId: { table: "models", name: "tenantId" } as Column,
    assignmentKey: { table: "models", name: "assignmentKey" } as Column,
  },
  tenants: {
    id: { table: "tenants", name: "id" } as Column,
  },
}));

const state = vi.hoisted(() => ({
  users: [] as Row[],
  userRoles: [] as Row[],
  assignments: [] as Row[],
  failCleanup: false,
}));

const mocks = vi.hoisted(() => ({
  getMysqlUserRolesDetail: vi.fn(),
  insertMysqlAuditEvent: vi.fn(),
}));

function matches(condition: unknown, row: Row): boolean {
  if (!condition || typeof condition !== "object") return true;
  const value = condition as {
    kind?: string;
    column?: Column;
    value?: unknown;
    values?: unknown[];
    conditions?: unknown[];
  };
  if (value.kind === "eq" && value.column) return row[value.column.name] === value.value;
  if (value.kind === "isNull" && value.column) return row[value.column.name] == null;
  if (value.kind === "in" && value.column) return value.values?.includes(row[value.column.name]) ?? false;
  if (value.kind === "and") return (value.conditions ?? []).every((child) => matches(child, row));
  return true;
}

function project(rows: Row[], projection: Record<string, Column> | undefined): Row[] {
  if (!projection) return rows.map((row) => ({ ...row }));
  return rows.map((row) =>
    Object.fromEntries(Object.entries(projection).map(([key, column]) => [key, row[column.name]])),
  );
}

function cloneState() {
  return structuredClone({
    users: state.users,
    userRoles: state.userRoles,
    assignments: state.assignments,
  });
}

function restoreState(snapshot: ReturnType<typeof cloneState>): void {
  state.users = snapshot.users;
  state.userRoles = snapshot.userRoles;
  state.assignments = snapshot.assignments;
}

function rowsFor(table: unknown): Row[] {
  if (table === tables.users) return state.users;
  if (table === tables.userRoles) return state.userRoles;
  return state.assignments;
}

function selectChain(rows: Row[], projection: Record<string, Column> | undefined) {
  const chain = {
    for: vi.fn(() => chain),
    limit: vi.fn((count: number) => Promise.resolve(project(rows.slice(0, count), projection))),
    then: (resolve: (value: Row[]) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(project(rows, projection)).then(resolve, reject),
  };
  return chain;
}

const db = {
  select: vi.fn((projection?: Record<string, Column>) => ({
    from: vi.fn((table: unknown) => ({
      where: vi.fn((condition: unknown) =>
        selectChain(rowsFor(table).filter((row) => matches(condition, row)), projection),
      ),
    })),
  })),
  update: vi.fn((table: unknown) => ({
    set: vi.fn((patch: Row) => ({
      where: vi.fn(async (condition: unknown) => {
        if (table !== tables.users) return;
        state.users = state.users.map((row) =>
          matches(condition, row) ? { ...row, ...patch } : row,
        );
      }),
    })),
  })),
  delete: vi.fn((table: unknown) => ({
    where: vi.fn(async (condition: unknown) => {
      if (table === tables.userRoles) {
        state.userRoles = state.userRoles.filter((row) => !matches(condition, row));
        return;
      }
      if (table === tables.models) {
        if (state.failCleanup) throw new Error("model alias cleanup failed");
        state.assignments = state.assignments.filter((row) => !matches(condition, row));
      }
    }),
  })),
  transaction: vi.fn(async <T>(callback: (tx: typeof db) => Promise<T>) => {
    const snapshot = cloneState();
    try {
      return await callback(db);
    } catch (error) {
      restoreState(snapshot);
      throw error;
    }
  }),
  execute: vi.fn(async () => []),
};

vi.mock("@agenticx/auth", () => ({ hashPassword: vi.fn() }));

vi.mock("@agenticx/db-schema/mysql", () => ({
  departments: {},
  enterpriseRuntimeUserVisibleModels: tables.models,
  roles: {},
  tenants: tables.tenants,
  userRoles: tables.userRoles,
  users: tables.users,
}));

vi.mock("drizzle-orm", () => ({
  and: (...conditions: unknown[]) => ({ kind: "and", conditions }),
  asc: vi.fn(),
  desc: vi.fn(),
  eq: (column: Column, value: unknown) => ({ kind: "eq", column, value }),
  exists: vi.fn(),
  inArray: (column: Column, values: unknown[]) => ({ kind: "in", column, values }),
  isNull: (column: Column) => ({ kind: "isNull", column }),
  like: vi.fn(),
  or: vi.fn(),
  sql: vi.fn(),
}));

vi.mock("../db", () => ({
  getMysqlRepositoryDb: async () => db,
}));

vi.mock("../audit", () => ({
  insertMysqlAuditEvent: (...args: unknown[]) => mocks.insertMysqlAuditEvent(...args),
}));

vi.mock("../roles", () => ({
  getMysqlUserRolesDetail: (...args: unknown[]) => mocks.getMysqlUserRolesDetail(...args),
  mysqlRolesRepository: {},
}));

// This fixture exercises the model/role cleanup transaction.  Authorization
// semantics are covered by the dedicated integration matrix; keep this old
// schema-shaped mock independent of the principal tables.
vi.mock("../../../authorization/grantability", () => ({
  assertUserDeletionSafe: vi.fn().mockResolvedValue(undefined),
  assertUserRoleCodesGrantable: vi.fn().mockResolvedValue(undefined),
}));

import { mysqlUsersRepository } from "../users";

describe("MySQL soft-delete model alias cleanup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.failCleanup = false;
    state.users = [{
      tenantId: TENANT,
      id: USER_ID,
      isDeleted: false,
      deletedAt: null,
      email: "Member@Example.COM",
      displayName: "Member A",
    }];
    state.userRoles = [
      { tenantId: TENANT, userId: USER_ID, roleId: "role-member" },
      { tenantId: "tenant-b", userId: USER_ID, roleId: "role-other-tenant" },
    ];
    state.assignments = [
      { tenantId: TENANT, assignmentKey: USER_ID, modelId: "provider/private" },
      { tenantId: TENANT, assignmentKey: "email:member@example.com", modelId: "provider/private" },
      { tenantId: TENANT, assignmentKey: "group:group-a", modelId: "provider/group" },
      { tenantId: "tenant-b", assignmentKey: USER_ID, modelId: "provider/other" },
      { tenantId: "tenant-b", assignmentKey: "email:member@example.com", modelId: "provider/other" },
    ];
    mocks.getMysqlUserRolesDetail.mockResolvedValue({ roleCodes: ["member"] });
    mocks.insertMysqlAuditEvent.mockResolvedValue({ id: "audit-1" });
  });

  it("soft-deletes and removes both normalized aliases without crossing tenants", async () => {
    await mysqlUsersRepository.softDeleteUser(TENANT, USER_ID, ADMIN_ID);

    expect(state.users[0]).toMatchObject({ isDeleted: true });
    expect(state.userRoles).toEqual([
      { tenantId: "tenant-b", userId: USER_ID, roleId: "role-other-tenant" },
    ]);
    expect(state.assignments).not.toContainEqual(
      expect.objectContaining({ tenantId: TENANT, assignmentKey: USER_ID }),
    );
    expect(state.assignments).not.toContainEqual(
      expect.objectContaining({ tenantId: TENANT, assignmentKey: "email:member@example.com" }),
    );
    expect(state.assignments).toContainEqual(
      expect.objectContaining({ tenantId: TENANT, assignmentKey: "group:group-a" }),
    );
    expect(state.assignments).toContainEqual(
      expect.objectContaining({ tenantId: "tenant-b", assignmentKey: USER_ID }),
    );
    expect(state.assignments).toContainEqual(
      expect.objectContaining({ tenantId: "tenant-b", assignmentKey: "email:member@example.com" }),
    );
    expect(mocks.insertMysqlAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT,
      targetId: USER_ID,
      detail: expect.objectContaining({ email: "Member@Example.COM" }),
    }));
  });

  it("rolls back the soft-delete and role cleanup when model alias cleanup fails", async () => {
    const before = cloneState();
    state.failCleanup = true;

    await expect(mysqlUsersRepository.softDeleteUser(TENANT, USER_ID, ADMIN_ID)).rejects.toThrow(
      "model alias cleanup failed",
    );

    expect({ users: state.users, userRoles: state.userRoles, assignments: state.assignments }).toEqual(before);
    expect(mocks.insertMysqlAuditEvent).not.toHaveBeenCalled();
  });
});
