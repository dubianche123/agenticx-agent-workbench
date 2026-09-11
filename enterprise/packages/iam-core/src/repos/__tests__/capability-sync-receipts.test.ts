import { MySqlDialect } from "drizzle-orm/mysql-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getMysqlRepositoryDb: vi.fn() }));

vi.mock("../mysql/db", () => ({
  getMysqlRepositoryDb: (...args: unknown[]) => mocks.getMysqlRepositoryDb(...args),
}));

import { insertMysqlCapabilitySyncReceipt } from "../mysql/capability-sync-receipts";

const now = new Date("2026-09-02T03:00:00.000Z");
const currentRow = {
  id: "01JQMZ8K3N4P5Q6R7S8T9VWXYZ",
  tenantId: "tenant-a",
  userId: "user-a",
  apiTokenId: 42,
  capabilityId: "skill:01JQMZ8K3N4P5Q6R7S8T9VWXY0",
  kind: "skill" as const,
  status: "pending" as const,
  version: "1.0.0",
  digest: "a".repeat(64),
  errorCode: null,
  message: null,
  attemptedAt: now,
  appliedAt: null,
  createdAt: now,
  updatedAt: now,
};

function input() {
  return {
    tenantId: currentRow.tenantId,
    userId: currentRow.userId,
    apiTokenId: currentRow.apiTokenId,
    capabilityId: currentRow.capabilityId,
    kind: currentRow.kind,
    status: currentRow.status,
    version: currentRow.version,
    digest: currentRow.digest,
    errorCode: null,
    message: null,
    attemptedAt: now,
    appliedAt: null,
  };
}

describe("MySQL capability sync receipt upsert", () => {
  beforeEach(() => {
    mocks.getMysqlRepositoryDb.mockReset();
  });

  it("returns the existing current row after a duplicate POST instead of selecting the new id", async () => {
    const whereClauses: unknown[] = [];
    const insertBuilder = {
      values: vi.fn().mockReturnThis(),
      onDuplicateKeyUpdate: vi.fn().mockResolvedValue(undefined),
    };
    const selectBuilder = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn((clause: unknown) => {
        whereClauses.push(clause);
        return selectBuilder;
      }),
      limit: vi.fn(async () => {
        const clause = whereClauses.at(-1);
        const sql = new MySqlDialect().sqlToQuery(clause as never).sql;
        // A lookup by the generated id is the pre-fix bug: duplicate-key
        // update retains the old row id and would return an empty result.
        return sql.includes("`id`") ? [] : [currentRow];
      }),
    };
    const db = {
      insert: vi.fn(() => insertBuilder),
      select: vi.fn(() => selectBuilder),
    };
    mocks.getMysqlRepositoryDb.mockResolvedValue(db);

    await expect(insertMysqlCapabilitySyncReceipt(input())).resolves.toMatchObject({
      id: currentRow.id,
      capabilityId: currentRow.capabilityId,
    });
    await expect(insertMysqlCapabilitySyncReceipt(input())).resolves.toMatchObject({
      id: currentRow.id,
      capabilityId: currentRow.capabilityId,
    });
    expect(insertBuilder.onDuplicateKeyUpdate).toHaveBeenCalledTimes(2);
    expect(whereClauses).toHaveLength(2);
    expect(new MySqlDialect().sqlToQuery(whereClauses[0] as never).sql).toContain("`capability_id`");
  });
});
