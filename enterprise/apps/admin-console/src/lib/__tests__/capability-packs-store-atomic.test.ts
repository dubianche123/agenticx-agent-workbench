import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getIamDb: vi.fn(),
  getAdminMysqlDb: vi.fn(),
}));

vi.mock("@agenticx/iam-core", () => ({
  getIamDb: (...args: unknown[]) => mocks.getIamDb(...args),
}));
vi.mock("../db-stores/mysql/database", () => ({
  getAdminMysqlDb: (...args: unknown[]) => mocks.getAdminMysqlDb(...args),
}));

import * as mysqlStore from "../db-stores/mysql/capability-packs-store";
import * as pgStore from "../db-stores/postgresql/capability-packs-store";
import { CapabilityPackVersionConflictError } from "../capability-pack-concurrency";

const TENANT_ID = "01JQMZ8K3N4P5Q6R7S8T9VWXY1";
const PACK_ID = "01JQMZ8K3N4P5Q6R7S8T9VWXY2";
const EXPERT_ID = "01JQMZ8K3N4P5Q6R7S8T9VWXYZ";
const RELEASE_ID = "01JQMZ8K3N4P5Q6R7S8T9VWX01";
const OTHER_EXPERT_ID = "01JQMZ8K3N4P5Q6R7S8T9VWXY0";
const SKILL_ID = "01JQMZ8K3N4P5Q6R7S8T9VWX02";
const UPDATED_AT = "2026-08-28T08:00:00.000Z";

function releaseManifest(requiredSkill = false) {
  return {
    schema_version: 2,
    kind: "expert",
    recommended_permission_mode: "ask",
    payload: { name: "能力包专家", default_permission_mode: "auto" },
    dependencies: {
      skills: requiredSkill
        ? [{ capability_id: `skill:${SKILL_ID}`, version: "1.0.0", digest: "a".repeat(64), required: true }]
        : [],
      mcps: [],
    },
    resources: [],
  };
}

function skillReleaseManifest() {
  return {
    schema_version: 2,
    kind: "skill",
    recommended_permission_mode: "ask",
    payload: { name: "市场 Skill", description: "管理员托管的 Skill", skill_md: "---\nname: 市场 Skill\n---" },
    dependencies: { skills: [], mcps: [] },
    resources: [],
  };
}

/**
 * 模拟数据库的事务缓冲：回调成功才把 staged 操作提交；中途抛错则全部丢弃。
 * 这让测试能区分「三次独立写」与「同一事务里的三次写」。
 */
function failingTransactionalDb(
  failOnInsert: number,
  actualUpdatedAt = UPDATED_AT,
  options: {
    artifactStatus?: "published" | "unlisted";
    artifactKind?: "expert" | "group" | "skill";
    artifactId?: string;
    artifactDeliveryState?: "active" | "revoked";
    releaseArtifactId?: string;
    releaseManifest?: unknown;
    skillRow?: { id: string; status: string; version: string; digest: string | null };
    shelfCapabilityIds?: string[];
    existingMemberRows?: Array<{
      capabilityId: string;
      releasePolicy: "pinned" | "track_stable" | null;
      pinnedReleaseId: string | null;
    }>;
  } = {},
) {
  const committed: string[] = [];
  const attempted: string[] = [];
  const insertedValues: unknown[] = [];
  let capabilityIdOnlySelectionCount = 0;
  const transaction = vi.fn(async (callback: (tx: Record<string, unknown>) => Promise<unknown>) => {
    const staged: string[] = [];
    let insertCount = 0;
    const rowsForSelection = (fields: Record<string, unknown> | undefined): unknown[] => {
      const keys = Object.keys(fields ?? {});
      if (keys.includes("updatedAt")) {
        return [{ id: PACK_ID, updatedAt: new Date(actualUpdatedAt) }];
      }
      if (keys.includes("currentReleaseId")) {
        return [{
          id: options.artifactId ?? EXPERT_ID,
          kind: options.artifactKind ?? "expert",
          currentReleaseId: RELEASE_ID,
          status: options.artifactStatus ?? "published",
          deliveryState: options.artifactDeliveryState ?? "active",
        }];
      }
      if (keys.includes("releasePolicy") && keys.includes("pinnedReleaseId")) {
        return options.existingMemberRows ?? [];
      }
      if (keys.includes("version") && keys.includes("digest")) {
        return options.skillRow ? [options.skillRow] : [];
      }
      if (keys.includes("artifactId")) {
        return [{
          id: RELEASE_ID,
          artifactId: options.releaseArtifactId ?? options.artifactId ?? EXPERT_ID,
          manifest: options.releaseManifest ?? releaseManifest(),
        }];
      }
      if (keys.length === 1 && keys.includes("capabilityId")) {
        capabilityIdOnlySelectionCount += 1;
        if (capabilityIdOnlySelectionCount === 1) {
          return (options.shelfCapabilityIds ?? [`expert:${EXPERT_ID}`]).map((capabilityId) => ({
            capabilityId,
          }));
        }
      }
      // Existing members and the post-write delivery-limit query do not need rows
      // for these rollback tests. The published artifact query may safely be empty.
      return [];
    };
    const selection = (fields: Record<string, unknown> | undefined) => {
      const rows = rowsForSelection(fields);
      const terminal = {
        then: (resolve: (value: unknown[]) => unknown, reject?: (reason: unknown) => unknown) =>
          Promise.resolve(rows).then(resolve, reject),
        for: () => ({
          limit: async () => {
            staged.push("select-pack");
            return rows;
          },
        }),
        limit: async () => rows,
      };
      const query = {
        where: () => terminal,
        innerJoin: () => query,
      };
      return query;
    };
    const tx = {
      execute: async () => {
        staged.push("lock-tenant");
      },
      select: (fields?: Record<string, unknown>) => ({
        from: () => selection(fields),
      }),
      update: () => ({
        set: () => ({
          where: async () => {
            staged.push("update-pack");
          },
        }),
      }),
      delete: () => ({
        where: async () => {
          staged.push("delete-relations");
        },
      }),
      insert: () => ({
        values: async (values: unknown) => {
          insertCount += 1;
          insertedValues.push(values);
          staged.push(`insert-${insertCount}`);
          if (insertCount === failOnInsert) throw new Error("injected relation failure");
        },
      }),
    };

    try {
      const result = await callback(tx);
      committed.push(...staged);
      return result;
    } finally {
      attempted.push(...staged);
    }
  });

  return { db: { transaction }, transaction, attempted, committed, insertedValues };
}

describe.each([
  ["PostgreSQL", pgStore, mocks.getIamDb],
  ["MySQL", mysqlStore, mocks.getAdminMysqlDb],
] as const)("%s capability pack atomicity", (_dialect, store, getDb) => {
  beforeEach(() => {
    mocks.getIamDb.mockReset();
    mocks.getAdminMysqlDb.mockReset();
  });

  it("rolls back the pack row and members when assignment insertion fails during create", async () => {
    const runtime = failingTransactionalDb(3);
    getDb.mockReturnValue(runtime.db);

    await expect(
      store.createCapabilityPack(TENANT_ID, {
        slug: "portable",
        capabilityIds: [`expert:${EXPERT_ID.toLowerCase()}`],
        assignmentKeys: ["all"],
      }),
    ).rejects.toThrow("injected relation failure");

    expect(runtime.transaction).toHaveBeenCalledOnce();
    expect(runtime.attempted).toEqual(["lock-tenant", "insert-1", "insert-2", "insert-3"]);
    expect(runtime.committed).toEqual([]);
    expect(runtime.insertedValues[1]).toEqual([
      expect.objectContaining({
        capabilityId: `expert:${EXPERT_ID}`,
        releasePolicy: "pinned",
        pinnedReleaseId: RELEASE_ID,
      }),
    ]);
  });

  it("rolls back pack and member replacement when assignment replacement fails during update", async () => {
    const runtime = failingTransactionalDb(2);
    getDb.mockReturnValue(runtime.db);

    await expect(
      store.updateCapabilityPack(TENANT_ID, PACK_ID, {
        expectedUpdatedAt: UPDATED_AT,
        displayName: "Updated",
        capabilityIds: [`expert:${EXPERT_ID.toLowerCase()}`],
        assignmentKeys: ["all"],
      }),
    ).rejects.toThrow("injected relation failure");

    expect(runtime.transaction).toHaveBeenCalledOnce();
    expect(runtime.attempted).toEqual([
      "lock-tenant",
      "select-pack",
      "update-pack",
      "delete-relations",
      "insert-1",
      "delete-relations",
      "insert-2",
    ]);
    expect(runtime.committed).toEqual([]);
  });

  it("rejects an unlisted portable artifact before writing the pack", async () => {
    const runtime = failingTransactionalDb(Number.POSITIVE_INFINITY, UPDATED_AT, {
      artifactStatus: "unlisted",
    });
    getDb.mockReturnValue(runtime.db);

    await expect(
      store.createCapabilityPack(TENANT_ID, {
        slug: "unlisted",
        capabilityIds: [`expert:${EXPERT_ID}`],
      }),
    ).rejects.toThrow("missing, unlisted, or belongs to another tenant");

    expect(runtime.attempted).toEqual(["lock-tenant"]);
    expect(runtime.committed).toEqual([]);
    expect(runtime.insertedValues).toEqual([]);
  });

  it("rejects a published portable artifact that is not explicitly on the capability shelf", async () => {
    const runtime = failingTransactionalDb(Number.POSITIVE_INFINITY, UPDATED_AT, {
      shelfCapabilityIds: [],
    });
    getDb.mockReturnValue(runtime.db);

    await expect(
      store.createCapabilityPack(TENANT_ID, {
        slug: "not-on-shelf",
        capabilityIds: [`expert:${EXPERT_ID}`],
      }),
    ).rejects.toThrow("portable capability is not in the capability shelf");
    expect(runtime.attempted).toEqual(["lock-tenant"]);
    expect(runtime.committed).toEqual([]);
    expect(runtime.insertedValues).toEqual([]);
  });

  it("materializes a market Skill only when it is on the shelf and keeps the pinned/track-stable policy", async () => {
    const capabilityId = `skill:${SKILL_ID}`;
    const runtime = failingTransactionalDb(3, UPDATED_AT, {
      artifactKind: "skill",
      artifactId: SKILL_ID,
      releaseManifest: skillReleaseManifest(),
      shelfCapabilityIds: [capabilityId],
    });
    getDb.mockReturnValue(runtime.db);

    await expect(
      store.createCapabilityPack(TENANT_ID, {
        slug: "market-skill",
        capabilityIds: [capabilityId],
        portableReleasePolicies: {
          [capabilityId]: { mode: "track_stable" },
        },
        assignmentKeys: ["all"],
      }),
    ).rejects.toThrow("injected relation failure");
    expect(runtime.insertedValues[1]).toEqual([
      expect.objectContaining({
        capabilityId,
        releasePolicy: "track_stable",
        pinnedReleaseId: null,
      }),
    ]);
  });

  it("does not allow a new market Skill to bypass the shelf gate, while legacy Skill remains ordinary", async () => {
    const marketCapabilityId = `skill:${SKILL_ID}`;
    const notOnShelf = failingTransactionalDb(Number.POSITIVE_INFINITY, UPDATED_AT, {
      artifactKind: "skill",
      artifactId: SKILL_ID,
      releaseManifest: skillReleaseManifest(),
      shelfCapabilityIds: [],
    });
    getDb.mockReturnValue(notOnShelf.db);
    await expect(
      store.createCapabilityPack(TENANT_ID, {
        slug: "market-skill-not-on-shelf",
        capabilityIds: [marketCapabilityId],
      }),
    ).rejects.toThrow("portable capability is not in the capability shelf");
    expect(notOnShelf.insertedValues).toEqual([]);

    const legacy = failingTransactionalDb(3, UPDATED_AT, {
      shelfCapabilityIds: [],
    });
    getDb.mockReturnValue(legacy.db);
    await expect(
      store.createCapabilityPack(TENANT_ID, {
        slug: "legacy-skill",
        capabilityIds: [marketCapabilityId],
        assignmentKeys: ["all"],
      }),
    ).rejects.toThrow("injected relation failure");
    expect(legacy.insertedValues[1]).toEqual([
      expect.objectContaining({
        capabilityId: marketCapabilityId,
        releasePolicy: null,
        pinnedReleaseId: null,
      }),
    ]);
  });

  it("allows a reviewed market Skill on the shelf to enter a capability pack", async () => {
    const capabilityId = `skill:${SKILL_ID}`;
    const runtime = failingTransactionalDb(3, UPDATED_AT, {
      artifactKind: "skill",
      artifactId: SKILL_ID,
      releaseManifest: skillReleaseManifest(),
      shelfCapabilityIds: [capabilityId],
    });
    getDb.mockReturnValue(runtime.db);

    await expect(
      store.createCapabilityPack(TENANT_ID, {
        slug: "reviewed-admin-submission",
        capabilityIds: [capabilityId],
        assignmentKeys: ["all"],
      }),
    ).rejects.toThrow("injected relation failure");
    expect(runtime.insertedValues[1]).toEqual([
      expect.objectContaining({ capabilityId, releasePolicy: "pinned" }),
    ]);
  });

  it("retains an existing unlisted or revoked market Skill when an unrelated pack field changes", async () => {
    const capabilityId = `skill:${SKILL_ID}`;
    for (const deliveryState of ["active", "revoked"] as const) {
      const runtime = failingTransactionalDb(2, UPDATED_AT, {
        artifactKind: "skill",
        artifactId: SKILL_ID,
        artifactStatus: "unlisted",
        artifactDeliveryState: deliveryState,
        releaseManifest: skillReleaseManifest(),
        shelfCapabilityIds: [],
        existingMemberRows: [{
          capabilityId,
          releasePolicy: "pinned",
          pinnedReleaseId: RELEASE_ID,
        }],
      });
      getDb.mockReturnValue(runtime.db);
      await expect(
        store.updateCapabilityPack(TENANT_ID, PACK_ID, {
          expectedUpdatedAt: UPDATED_AT,
          displayName: `保留 ${deliveryState}`,
          assignmentKeys: ["all"],
          capabilityIds: [capabilityId],
        }),
      ).rejects.toThrow("injected relation failure");
      expect(runtime.insertedValues[0]).toEqual([
        expect.objectContaining({ capabilityId, releasePolicy: "pinned" }),
      ]);
    }
  });

  it("rejects a pinned release owned by another artifact before writing the pack", async () => {
    const runtime = failingTransactionalDb(Number.POSITIVE_INFINITY, UPDATED_AT, {
      releaseArtifactId: OTHER_EXPERT_ID,
    });
    getDb.mockReturnValue(runtime.db);

    await expect(
      store.createCapabilityPack(TENANT_ID, {
        slug: "wrong-release",
        capabilityIds: [`expert:${EXPERT_ID}`],
        portableReleasePolicies: {
          [`expert:${EXPERT_ID}`]: { mode: "pinned", pinnedReleaseId: RELEASE_ID },
        },
      }),
    ).rejects.toThrow("release does not belong to portable capability");

    expect(runtime.attempted).toEqual(["lock-tenant"]);
    expect(runtime.committed).toEqual([]);
    expect(runtime.insertedValues).toEqual([]);
  });

  it("rejects a portable release whose required Skill is not explicitly in the same pack", async () => {
    const runtime = failingTransactionalDb(Number.POSITIVE_INFINITY, UPDATED_AT, {
      releaseManifest: releaseManifest(true),
    });
    getDb.mockReturnValue(runtime.db);

    await expect(
      store.createCapabilityPack(TENANT_ID, {
        slug: "missing-required-skill",
        capabilityIds: [`expert:${EXPERT_ID}`],
      }),
    ).rejects.toMatchObject({
      missingCapabilityIds: [`skill:${SKILL_ID}`],
    });

    expect(runtime.attempted).toEqual(["lock-tenant"]);
    expect(runtime.committed).toEqual([]);
    expect(runtime.insertedValues).toEqual([]);
  });

  it("rejects an explicitly selected Skill whose active registry bytes do not match", async () => {
    const runtime = failingTransactionalDb(Number.POSITIVE_INFINITY, UPDATED_AT, {
      releaseManifest: releaseManifest(true),
      skillRow: { id: SKILL_ID, status: "active", version: "1.0.1", digest: "a".repeat(64) },
    });
    getDb.mockReturnValue(runtime.db);

    await expect(
      store.createCapabilityPack(TENANT_ID, {
        slug: "mismatched-required-skill",
        capabilityIds: [`expert:${EXPERT_ID}`, `skill:${SKILL_ID}`],
      }),
    ).rejects.toMatchObject({
      dependencyCapabilityIds: [`skill:${SKILL_ID}`],
    });

    expect(runtime.attempted).toEqual(["lock-tenant"]);
    expect(runtime.committed).toEqual([]);
    expect(runtime.insertedValues).toEqual([]);
  });

  it("rejects a stale version under the row lock before replacing either full set", async () => {
    const actualUpdatedAt = "2026-08-28T08:01:00.000Z";
    const runtime = failingTransactionalDb(Number.POSITIVE_INFINITY, actualUpdatedAt);
    getDb.mockReturnValue(runtime.db);

    await expect(
      store.updateCapabilityPack(TENANT_ID, PACK_ID, {
        expectedUpdatedAt: UPDATED_AT,
        status: "disabled",
        capabilityIds: [],
        assignmentKeys: [],
      }),
    ).rejects.toMatchObject({
      name: CapabilityPackVersionConflictError.name,
      expectedUpdatedAt: UPDATED_AT,
      actualUpdatedAt,
    });

    expect(runtime.transaction).toHaveBeenCalledOnce();
    expect(runtime.attempted).toEqual(["lock-tenant", "select-pack"]);
    expect(runtime.committed).toEqual([]);
  });
});
