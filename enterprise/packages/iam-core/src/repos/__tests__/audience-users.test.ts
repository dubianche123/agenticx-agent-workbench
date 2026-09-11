import type { SQL } from "drizzle-orm";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getIamDb: vi.fn(),
  getMysqlRepositoryDb: vi.fn(),
}));

vi.mock("../../db", () => ({ getIamDb: mocks.getIamDb }));
vi.mock("../mysql/db", () => ({ getMysqlRepositoryDb: mocks.getMysqlRepositoryDb }));

import { listAudienceUsers } from "../users";

function directoryDb(rows: Array<Record<string, unknown>>) {
  const capture: {
    selection?: Record<string, unknown>;
    where?: SQL;
    limit?: number;
    offset?: number;
  } = {};
  const chain = {
    from: vi.fn(),
    where: vi.fn(),
    orderBy: vi.fn(),
    limit: vi.fn(),
    offset: vi.fn(),
  };
  chain.from.mockReturnValue(chain);
  chain.where.mockImplementation((where: SQL) => {
    capture.where = where;
    return chain;
  });
  chain.orderBy.mockReturnValue(chain);
  chain.limit.mockImplementation((limit: number) => {
    capture.limit = limit;
    return chain;
  });
  chain.offset.mockImplementation((offset: number) => {
    capture.offset = offset;
    return Promise.resolve(rows);
  });
  return {
    db: {
      select: vi.fn((selection: Record<string, unknown>) => {
        capture.selection = selection;
        return chain;
      }),
    },
    capture,
  };
}

describe.each([
  ["postgresql", "postgresql://localhost/agenticx"],
  ["mysql", "mysql://localhost/agenticx"],
] as const)("%s audience user directory", (dialect, databaseUrl) => {
  beforeEach(() => {
    mocks.getIamDb.mockReset();
    mocks.getMysqlRepositoryDb.mockReset();
    vi.stubEnv("DATABASE_DIALECT", dialect);
    vi.stubEnv("DATABASE_URL", databaseUrl);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("selects and searches only the minimal public identity fields", async () => {
    const expected = {
      id: "user-a",
      displayName: "Alice",
      email: "alice@example.invalid",
      deptId: "dept-a",
    };
    const { db, capture } = directoryDb([expected]);
    if (dialect === "mysql") {
      mocks.getMysqlRepositoryDb.mockResolvedValue(db);
    } else {
      mocks.getIamDb.mockReturnValue(db);
    }

    await expect(
      listAudienceUsers("tenant-a", { q: "private-number", limit: 20, offset: 4 }),
    ).resolves.toEqual([expected]);

    expect(Object.keys(capture.selection ?? {})).toEqual([
      "id",
      "displayName",
      "email",
      "deptId",
    ]);
    expect(capture.limit).toBe(20);
    expect(capture.offset).toBe(4);
    expect(capture.where).toBeDefined();
    const query = dialect === "mysql"
      ? new MySqlDialect().sqlToQuery(capture.where!)
      : new PgDialect().sqlToQuery(capture.where!);
    expect(query.sql).toContain("display_name");
    expect(query.sql).toContain("email");
    expect(query.sql).not.toContain("phone");
    expect(query.sql).not.toContain("employee_no");
    expect(query.params).toContain("%private-number%");
  });
});
