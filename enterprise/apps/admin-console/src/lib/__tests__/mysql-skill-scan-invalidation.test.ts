import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAdminMysqlDb: vi.fn(),
}));

vi.mock("../db-stores/mysql/database", () => ({
  getAdminMysqlDb: (...args: unknown[]) => mocks.getAdminMysqlDb(...args),
}));

import * as mysqlStore from "../db-stores/mysql/capability-packs-store";
import type { UpdateSkillInput } from "../db-stores/mysql/capability-packs-store";

const TENANT_ID = "01JQMZ8K3N4P5Q6R7S8T9VWXY1";
const SKILL_ID = "01JQMZ8K3N4P5Q6R7S8T9VWXY2";
const MCP_ID = "01JQMZ8K3N4P5Q6R7S8T9VWXYZ";
const BUNDLE_URI = "s3://skills/research-1.0.0.tgz";
const BUNDLE_DIGEST = "a".repeat(64);

function skillRow() {
  return {
    id: SKILL_ID,
    tenantId: TENANT_ID,
    slug: "research",
    displayName: "Research",
    description: "Research skill",
    version: "1.0.0",
    bundleUri: BUNDLE_URI,
    bundleDigest: BUNDLE_DIGEST,
    requiredCapabilities: [`mcp:${MCP_ID}`],
    status: "active",
    scanVerdict: "safe",
    scanSource: "trusted",
    scannedAt: "2026-08-28T08:00:00.000Z",
    scannedBy: "scanner@example.com",
    scanFindings: [{ rule: "none" }],
    createdAt: new Date("2026-08-27T08:00:00.000Z"),
    updatedAt: new Date("2026-08-28T08:00:00.000Z"),
  };
}

function mockSkillDb() {
  const row = skillRow();
  const transactionUpdate = vi.fn();
  const directUpdate = vi.fn();
  const transaction = vi.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
    callback({
      select: () => ({
        from: () => ({
          where: () => ({
            for: () => ({ limit: async () => [row] }),
          }),
        }),
      }),
      update: () => ({
        set: (patch: unknown) => {
          transactionUpdate(patch);
          return { where: async () => undefined };
        },
      }),
    }),
  );
  const db = {
    transaction,
    update: () => ({
      set: (patch: unknown) => {
        directUpdate(patch);
        return { where: async () => undefined };
      },
    }),
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => [row] }),
      }),
    }),
  };
  mocks.getAdminMysqlDb.mockReturnValue(db);
  return { db, row, transaction, transactionUpdate, directUpdate };
}

describe("MySQL updateSkill scan invalidation", () => {
  beforeEach(() => {
    mocks.getAdminMysqlDb.mockReset();
  });

  it.each([
    ["version", { version: "2.0.0" }],
    ["bundleUri", { bundleUri: "s3://skills/research-2.0.0.tgz" }],
    ["bundleDigest", { bundleDigest: "b".repeat(64) }],
    ["requiredCapabilities", { requiredCapabilities: [] }],
  ] as const)("clears scan metadata atomically when %s changes", async (_field, input) => {
    const runtime = mockSkillDb();

    await mysqlStore.updateSkill(TENANT_ID, SKILL_ID, input as UpdateSkillInput);

    expect(runtime.transaction).toHaveBeenCalledOnce();
    expect(runtime.directUpdate).not.toHaveBeenCalled();
    expect(runtime.transactionUpdate).toHaveBeenCalledOnce();
    expect(runtime.transactionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        ...input,
        scanVerdict: null,
        scanFindings: [],
        scannedAt: null,
        scanSource: null,
        scannedBy: null,
      }),
    );
  });

  it("keeps the verdict when the full editor payload repeats the same bundle identity", async () => {
    const runtime = mockSkillDb();

    await mysqlStore.updateSkill(TENANT_ID, SKILL_ID, {
      version: "1.0.0",
      bundleUri: BUNDLE_URI,
      bundleDigest: BUNDLE_DIGEST,
      // Order is not part of the declared capability set.
      requiredCapabilities: [`mcp:${MCP_ID}`],
    });

    expect(runtime.transactionUpdate).toHaveBeenCalledOnce();
    const patch = runtime.transactionUpdate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(patch).not.toHaveProperty("scanVerdict");
    expect(patch).not.toHaveProperty("scanFindings");
    expect(patch).not.toHaveProperty("scannedAt");
  });

  it("does not inspect or clear scans for metadata-only edits", async () => {
    const runtime = mockSkillDb();

    await mysqlStore.updateSkill(TENANT_ID, SKILL_ID, { displayName: "Updated Research" });

    expect(runtime.transaction).not.toHaveBeenCalled();
    expect(runtime.directUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ displayName: "Updated Research" }),
    );
    const patch = runtime.directUpdate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(patch).not.toHaveProperty("scanVerdict");
    expect(patch).not.toHaveProperty("scanFindings");
    expect(patch).not.toHaveProperty("scannedAt");
  });
});
