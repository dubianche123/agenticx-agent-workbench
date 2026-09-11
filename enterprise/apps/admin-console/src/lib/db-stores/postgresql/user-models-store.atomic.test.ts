import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Column = {
  table: "users" | "models" | "groups" | "members" | "optOuts" | "providers" | "departments";
  name: string;
};
type Row = Record<string, unknown>;

const TENANT = "tenant-a";
const USER_ID = "user-a";
const EMAIL = "member@example.com";

const columns = {
  users: {
    id: { table: "users", name: "id" } as Column,
    tenantId: { table: "users", name: "tenantId" } as Column,
    isDeleted: { table: "users", name: "isDeleted" } as Column,
    email: { table: "users", name: "email" } as Column,
    deptId: { table: "users", name: "deptId" } as Column,
    status: { table: "users", name: "status" } as Column,
  },
  models: {
    tenantId: { table: "models", name: "tenantId" } as Column,
    assignmentKey: { table: "models", name: "assignmentKey" } as Column,
    modelId: { table: "models", name: "modelId" } as Column,
  },
  groups: {
    id: { table: "groups", name: "id" } as Column,
    tenantId: { table: "groups", name: "tenantId" } as Column,
  },
  members: {
    groupId: { table: "members", name: "groupId" } as Column,
    userId: { table: "members", name: "userId" } as Column,
  },
  optOuts: {
    tenantId: { table: "optOuts", name: "tenantId" } as Column,
    userId: { table: "optOuts", name: "userId" } as Column,
    subject: { table: "optOuts", name: "subject" } as Column,
  },
  providers: {
    providerId: { table: "providers", name: "providerId" } as Column,
    tenantId: { table: "providers", name: "tenantId" } as Column,
    enabled: { table: "providers", name: "enabled" } as Column,
    models: { table: "providers", name: "models" } as Column,
  },
  departments: {
    id: { table: "departments", name: "id" } as Column,
    tenantId: { table: "departments", name: "tenantId" } as Column,
    parentId: { table: "departments", name: "parentId" } as Column,
    name: { table: "departments", name: "name" } as Column,
    path: { table: "departments", name: "path" } as Column,
  },
};

const state = vi.hoisted(() => ({
  users: [{
    id: "user-a",
    tenantId: "tenant-a",
    isDeleted: false,
    email: "member@example.com",
    deptId: null,
    status: "active",
  }] as Row[],
  groups: [{ id: "g-a", tenantId: "tenant-a" }] as Row[],
  members: [{ groupId: "g-a", userId: "user-a" }] as Row[],
  optOuts: [{ tenantId: "tenant-a", userId: "user-a", subject: "model:provider/group" }] as Row[],
  assignments: [
    { tenantId: "tenant-a", assignmentKey: "user-a", modelId: "provider/old" },
    { tenantId: "tenant-a", assignmentKey: "email:member@example.com", modelId: "provider/old" },
    { tenantId: "tenant-a", assignmentKey: "group:g-a", modelId: "provider/group" },
  ] as Row[],
  enabled: ["provider/old", "provider/new", "provider/other", "provider/group"],
  departments: [] as Row[],
}));

function matches(condition: unknown, row: Row): boolean {
  if (!condition || typeof condition !== "object") return true;
  const value = condition as { kind?: string; column?: Column; value?: unknown; values?: unknown[]; conditions?: unknown[] };
  if (value.kind === "eq" && value.column) return row[value.column.name] === value.value;
  if (value.kind === "in" && value.column) return value.values?.includes(row[value.column.name]) ?? false;
  if (value.kind === "and") return (value.conditions ?? []).every((child) => matches(child, row));
  return true;
}

function projectedRows(rows: Row[], projection: Record<string, Column> | undefined): Row[] {
  if (!projection) return rows.map((row) => ({ ...row }));
  return rows.map((row) =>
    Object.fromEntries(Object.entries(projection).map(([key, column]) => [key, row[column.name]])),
  );
}

function selectChain(rows: Row[]) {
  const chain = {
    for: vi.fn(() => chain),
    limit: vi.fn((count: number) => Promise.resolve(rows.slice(0, count))),
    then: (resolve: (value: Row[]) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve, reject),
  };
  return chain;
}

function createDb() {
  const db = {
    select: vi.fn((projection?: Record<string, Column>) => ({
      from: vi.fn((table: unknown) => ({
        where: vi.fn((condition: unknown) => {
          const source = table === columns.users
            ? state.users
            : table === columns.groups
              ? state.groups
              : table === columns.members
                ? state.members
                  : table === columns.optOuts
                    ? state.optOuts
                    : table === columns.providers
                      ? [{
                          providerId: "provider",
                          tenantId: TENANT,
                          enabled: true,
                          models: state.enabled
                            .filter((id) => id.startsWith("provider/"))
                            .map((id) => ({ name: id.slice("provider/".length), enabled: true })),
                        }]
                      : table === columns.departments
                        ? state.departments
                        : state.assignments;
          return selectChain(projectedRows(source.filter((row) => matches(condition, row)), projection));
        }),
      })),
    })),
    delete: vi.fn((table: unknown) => ({
      where: vi.fn(async (condition: unknown) => {
        if (table === columns.models) state.assignments = state.assignments.filter((row) => !matches(condition, row));
      }),
    })),
    insert: vi.fn((table: unknown) => ({
      values: vi.fn((rows: Row[]) => ({
        onConflictDoNothing: vi.fn(async () => {
          if (table !== columns.models) return;
          for (const row of rows) {
            const exists = state.assignments.some(
              (current) =>
                current.tenantId === row.tenantId &&
                current.assignmentKey === row.assignmentKey &&
                current.modelId === row.modelId,
            );
            if (!exists) state.assignments.push({ ...row });
          }
        }),
      })),
    })),
    transaction: vi.fn(),
  };
  const tx = db;
  let queue = Promise.resolve();
  db.transaction.mockImplementation(<T>(callback: (transaction: typeof tx) => Promise<T>) => {
    const next = queue.then(() => callback(tx));
    queue = next.then(() => undefined, () => undefined);
    return next;
  });
  return db;
}

const db = createDb();

vi.mock("drizzle-orm", () => ({
  and: (...conditions: unknown[]) => ({ kind: "and", conditions }),
  eq: (column: Column, value: unknown) => ({ kind: "eq", column, value }),
  inArray: (column: Column, values: unknown[]) => ({ kind: "in", column, values }),
}));

vi.mock("@agenticx/db-schema", () => ({
  departments: columns.departments,
  enterpriseRuntimeModelProviders: columns.providers,
  enterpriseRuntimeUserVisibleModels: columns.models,
  enterpriseUserGroups: columns.groups,
  enterpriseUserGroupMembers: columns.members,
  enterpriseUserOptOuts: columns.optOuts,
  users: columns.users,
}));

vi.mock("@agenticx/iam-core", () => ({
  getDepartment: vi.fn(async () => null),
  getIamDb: () => db,
  listDepartmentAncestorIds: vi.fn(async () => ["dept-a"]),
  migrateLegacyUserVisibleModelsIfNeeded: vi.fn(async () => undefined),
  resolveRuntimeAdminDir: vi.fn(() => "/tmp"),
}));

vi.mock("../../model-providers-store", () => ({
  listAllEnabledModelIds: vi.fn(async () => [...state.enabled]),
}));

describe("setUserModelsForAliases", () => {
  beforeEach(() => {
    state.users = [{
      id: USER_ID,
      tenantId: TENANT,
      isDeleted: false,
      email: EMAIL,
      deptId: null,
      status: "active",
    }];
    state.groups = [{ id: "g-a", tenantId: TENANT }];
    state.members = [{ groupId: "g-a", userId: USER_ID }];
    state.optOuts = [{ tenantId: TENANT, userId: USER_ID, subject: "model:provider/group" }];
    state.assignments = [
      { tenantId: TENANT, assignmentKey: USER_ID, modelId: "provider/old" },
      { tenantId: TENANT, assignmentKey: `email:${EMAIL}`, modelId: "provider/old" },
      { tenantId: TENANT, assignmentKey: "group:g-a", modelId: "provider/group" },
    ];
    state.enabled = ["provider/old", "provider/new", "provider/other", "provider/group"];
    state.departments = [];
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("writes both aliases atomically and preserves group assignments", async () => {
    const { setUserModelsForAliases } = await import("./user-models-store");
    const result = await setUserModelsForAliases({
      userId: USER_ID,
      email: EMAIL,
      modelIds: ["provider/new"],
      deptId: null,
      tenantId: TENANT,
      expectedModelIds: ["provider/old"],
      expectedModelIdsByKey: {
        [USER_ID]: ["provider/old"],
        [`email:${EMAIL}`]: ["provider/old"],
      },
      expectedParentAllowedIds: state.enabled,
    });

    expect(result).toEqual({ modelIds: ["provider/new"], prunedModelIds: [] });
    expect(state.assignments.filter((row) => row.assignmentKey === USER_ID).map((row) => row.modelId)).toEqual([
      "provider/new",
    ]);
    expect(
      state.assignments.filter((row) => row.assignmentKey === `email:${EMAIL}`).map((row) => row.modelId),
    ).toEqual(["provider/new"]);
    expect(state.assignments).toContainEqual({
      tenantId: TENANT,
      assignmentKey: "group:g-a",
      modelId: "provider/group",
    });
  });

  it("serializes confirmations and rejects the second stale preview before either alias is changed", async () => {
    const { setUserModelsForAliases } = await import("./user-models-store");
    const expected = {
      userId: USER_ID,
      email: EMAIL,
      deptId: null,
      tenantId: TENANT,
      expectedModelIds: ["provider/old"],
      expectedModelIdsByKey: {
        [USER_ID]: ["provider/old"],
        [`email:${EMAIL}`]: ["provider/old"],
      },
      expectedParentAllowedIds: state.enabled,
    } as const;
    const [first, second] = await Promise.allSettled([
      setUserModelsForAliases({ ...expected, modelIds: ["provider/new"] }),
      setUserModelsForAliases({ ...expected, modelIds: ["provider/other"] }),
    ]);

    expect([first.status, second.status].filter((status) => status === "fulfilled" as const)).toHaveLength(1);
    const rejected = [first, second].find((result) => result.status === "rejected");
    expect(rejected?.status === "rejected" && (rejected.reason as { code?: string }).code).toBe(
      "USER_MODELS_PRECONDITION",
    );
    const userRows = state.assignments.filter((row) => row.assignmentKey === USER_ID || row.assignmentKey === `email:${EMAIL}`);
    expect(userRows).toHaveLength(2);
    expect(new Set(userRows.map((row) => row.modelId))).toEqual(new Set(["provider/new"]));
  });

  it("compares alias ownership separately even when the union is unchanged", async () => {
    state.assignments = [
      { tenantId: TENANT, assignmentKey: `email:${EMAIL}`, modelId: "provider/old" },
      { tenantId: TENANT, assignmentKey: "group:g-a", modelId: "provider/group" },
    ];
    const { setUserModelsForAliases } = await import("./user-models-store");
    // An intervening editor moved the same model from the id alias to the
    // email alias. The merged union is still [old], but the per-key CAS must
    // reject instead of overwriting that edit.
    await expect(
      setUserModelsForAliases({
        userId: USER_ID,
        email: EMAIL,
        modelIds: ["provider/new"],
        deptId: null,
        tenantId: TENANT,
        expectedModelIds: ["provider/old"],
        expectedModelIdsByKey: { [USER_ID]: ["provider/old"], [`email:${EMAIL}`]: [] },
        expectedParentAllowedIds: state.enabled,
      }),
    ).rejects.toMatchObject({ code: "USER_MODELS_PRECONDITION" });
    expect(state.assignments.filter((row) => row.assignmentKey === `email:${EMAIL}`)).toHaveLength(1);
  });

  it("rejects a changed parent ceiling before deleting aliases", async () => {
    const { setUserModelsForAliases } = await import("./user-models-store");
    state.enabled = ["provider/old"];
    await expect(
      setUserModelsForAliases({
        userId: USER_ID,
        email: EMAIL,
        modelIds: ["provider/new"],
        deptId: null,
        tenantId: TENANT,
        expectedModelIds: ["provider/old"],
        expectedParentAllowedIds: ["provider/old", "provider/new"],
      }),
    ).rejects.toMatchObject({ code: "USER_MODELS_PRECONDITION" });
    expect(state.assignments.filter((row) => row.assignmentKey === USER_ID).map((row) => row.modelId)).toEqual([
      "provider/old",
    ]);
  });

  it("reads provider and department policy rows inside the write transaction", async () => {
    state.users[0] = { ...state.users[0], deptId: "dept-child" };
    state.departments = [
      {
        id: "dept-child",
        tenantId: TENANT,
        parentId: "dept-root",
        name: "Child",
        path: "/Root/Child",
      },
      {
        id: "dept-root",
        tenantId: TENANT,
        parentId: null,
        name: "Root",
        path: "/Root",
      },
    ];
    state.assignments.push({
      tenantId: TENANT,
      assignmentKey: "dept:dept-root",
      modelId: "provider/old",
    });
    const { setUserModelsForAliases } = await import("./user-models-store");
    const result = await setUserModelsForAliases({
      userId: USER_ID,
      email: EMAIL,
      modelIds: ["provider/new"],
      deptId: "dept-child",
      tenantId: TENANT,
      expectedModelIds: ["provider/old"],
      expectedParentAllowedIds: ["provider/old"],
    });

    expect(result).toEqual({ modelIds: [], prunedModelIds: ["provider/new"] });
    expect(state.assignments.filter((row) => row.assignmentKey === USER_ID).map((row) => row.modelId)).toEqual([]);
  });

  it("checks group grants and opt-outs before replacing aliases", async () => {
    const { setUserModelsForAliases } = await import("./user-models-store");
    const result = await setUserModelsForAliases({
      userId: USER_ID,
      email: EMAIL,
      modelIds: ["provider/new"],
      deptId: null,
      tenantId: TENANT,
      expectedModelIds: ["provider/old"],
      expectedModelIdsByKey: { [USER_ID]: ["provider/old"], [`email:${EMAIL}`]: ["provider/old"] },
      expectedParentAllowedIds: state.enabled,
      expectedGroupModelIds: ["provider/group"],
      expectedExcludedGroupModelIds: ["provider/group"],
    });

    expect(result.modelIds).toEqual(["provider/new"]);
    expect(state.assignments.filter((row) => row.assignmentKey === "group:g-a")).toEqual([
      { tenantId: TENANT, assignmentKey: "group:g-a", modelId: "provider/group" },
    ]);
    expect(state.optOuts).toEqual([
      { tenantId: TENANT, userId: USER_ID, subject: "model:provider/group" },
    ]);
  });

  it("rejects a changed group grant before deleting aliases", async () => {
    const { setUserModelsForAliases } = await import("./user-models-store");
    const expected = {
      userId: USER_ID,
      email: EMAIL,
      modelIds: ["provider/new"],
      deptId: null,
      tenantId: TENANT,
      expectedModelIds: ["provider/old"],
      expectedParentAllowedIds: state.enabled,
      expectedGroupModelIds: ["provider/group"],
      expectedExcludedGroupModelIds: ["provider/group"],
    } as const;
    state.assignments = state.assignments.map((row) =>
      row.assignmentKey === "group:g-a" ? { ...row, modelId: "provider/changed" } : row,
    );

    await expect(setUserModelsForAliases(expected)).rejects.toMatchObject({ code: "USER_MODELS_PRECONDITION" });
    expect(state.assignments.filter((row) => row.assignmentKey === USER_ID).map((row) => row.modelId)).toEqual([
      "provider/old",
    ]);
    expect(state.assignments.filter((row) => row.assignmentKey === `email:${EMAIL}`).map((row) => row.modelId)).toEqual([
      "provider/old",
    ]);
  });

  it("rejects an email, department, or active-status change under the user lock", async () => {
    const { setUserModelsForAliases } = await import("./user-models-store");
    const expected = {
      userId: USER_ID,
      email: EMAIL,
      modelIds: ["provider/new"],
      deptId: null,
      tenantId: TENANT,
      expectedModelIds: ["provider/old"],
      expectedParentAllowedIds: state.enabled,
    } as const;
    state.users[0] = {
      ...state.users[0],
      email: "renamed@example.com",
      deptId: "dept-new",
      status: "disabled",
    };

    await expect(setUserModelsForAliases(expected)).rejects.toMatchObject({ code: "USER_MODELS_PRECONDITION" });
    expect(state.assignments.filter((row) => row.assignmentKey === USER_ID).map((row) => row.modelId)).toEqual([
      "provider/old",
    ]);
  });

  it("deletes both same-tenant user aliases when a soft-deleted user is cleaned up", async () => {
    const { deleteUserAssignment } = await import("./user-models-store");
    state.assignments.push(
      { tenantId: "tenant-b", assignmentKey: USER_ID, modelId: "provider/other" },
      { tenantId: "tenant-b", assignmentKey: `email:${EMAIL}`, modelId: "provider/other" },
    );

    await deleteUserAssignment(USER_ID, TENANT);

    expect(
      state.assignments.filter(
        (row) => row.tenantId === TENANT &&
          (row.assignmentKey === USER_ID || row.assignmentKey === `email:${EMAIL}`),
      ),
    ).toEqual([]);
    expect(state.assignments).toContainEqual({
      tenantId: TENANT,
      assignmentKey: "group:g-a",
      modelId: "provider/group",
    });
    expect(state.assignments).toContainEqual({
      tenantId: "tenant-b",
      assignmentKey: USER_ID,
      modelId: "provider/other",
    });
    expect(state.assignments).toContainEqual({
      tenantId: "tenant-b",
      assignmentKey: `email:${EMAIL}`,
      modelId: "provider/other",
    });
  });
});
