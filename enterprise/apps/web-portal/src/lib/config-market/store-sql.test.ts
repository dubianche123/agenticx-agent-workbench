import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createMysqlDb: vi.fn(),
  getIamDb: vi.fn(),
  resolveDatabaseConfig: vi.fn(),
}));

vi.mock("@agenticx/iam-core", () => ({
  createMysqlDb: (...args: unknown[]) => mocks.createMysqlDb(...args),
  getIamDb: (...args: unknown[]) => mocks.getIamDb(...args),
  listDepartmentAncestorIds: vi.fn(),
  resolveDatabaseConfig: (...args: unknown[]) => mocks.resolveDatabaseConfig(...args),
}));

import { v2ExpertManifest } from "../config-share-test-fixtures";
import {
  ConfigMarketAudienceConflictError,
  ConfigMarketOwnershipConflictError,
  ConfigMarketTrackStableDependencyConflictError,
  createSqlStore,
  type CreateConfigMarketItemInput,
} from "./store";
import { configMarketManifestDigest } from "./types";

const manifest = v2ExpertManifest("投研专家", { systemPrompt: "内部分析指令" });
const input: CreateConfigMarketItemInput = {
  tenantId: "tenant-a",
  userId: "01JQMZ8K3N4P5Q6R7S8T9VWXYZ",
  ownerDisplayName: "Alice",
  manifest,
  audience: {
    visibility: "users",
    visibleDepartmentIds: [],
    visibleUserIds: ["01JQMZ8K3N4P5Q6R7S8T9VWXY0"],
  },
};
const now = new Date("2026-08-28T00:00:00.000Z");

function existingArtifact() {
  return {
    id: "01JQMZ8K3N4P5Q6R7S8T9VWXY1",
    tenantId: input.tenantId,
    userId: input.userId,
    ownerDisplayName: input.ownerDisplayName,
    kind: manifest.kind,
    sourceArtifactId: manifest.artifact_id,
    title: manifest.title,
    description: manifest.description,
    currentReleaseId: "01JQMZ8K3N4P5Q6R7S8T9VWXY2",
    visibility: "company",
    visibleDepartmentIds: [],
    visibleUserIds: [],
    status: "published",
    publishedAt: now,
    unlistedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

function currentRelease() {
  return {
    id: existingArtifact().currentReleaseId,
    tenantId: input.tenantId,
    artifactId: existingArtifact().id,
    version: manifest.release_version,
    manifestVersion: 2,
    manifestDigest: configMarketManifestDigest(manifest),
    manifest,
    releaseNotes: "",
    publishedAt: now,
    createdAt: now,
    updatedAt: now,
  };
}

function transactionFixture(results: unknown[][]) {
  const queue = [...results];
  const select = vi.fn(() => {
    const chain: Record<string, any> = {};
    for (const method of ["from", "innerJoin", "where", "for"] as const) {
      chain[method] = vi.fn(() => chain);
    }
    chain.limit = vi.fn(async () => queue.shift() ?? []);
    chain.then = (
      resolve: (value: unknown[]) => unknown,
      reject?: (reason: unknown) => unknown,
    ) => Promise.resolve(queue.shift() ?? []).then(resolve, reject);
    return chain;
  });
  const insertValues = vi.fn().mockResolvedValue(undefined);
  return {
    tx: {
      execute: vi.fn().mockResolvedValue(undefined),
      select,
      insert: vi.fn(() => ({ values: insertValues })),
      update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })) })),
    },
    insertValues,
  };
}

function useDialectTransaction(dialect: "postgresql" | "mysql", transaction: ReturnType<typeof vi.fn>) {
  mocks.resolveDatabaseConfig.mockReturnValue({ dialect, url: `${dialect}://localhost/agenticx` });
  if (dialect === "mysql") mocks.createMysqlDb.mockResolvedValue({ raw: { transaction } });
  else mocks.getIamDb.mockReturnValue({ transaction });
}

describe.each(["postgresql", "mysql"] as const)("%s config market release transaction", (dialect) => {
  beforeEach(() => Object.values(mocks).forEach((mock) => mock.mockReset()));

  it("creates the stable artifact and immutable first release in one transaction", async () => {
    const fixture = transactionFixture([[]]);
    const transaction = vi.fn(async (callback: (tx: typeof fixture.tx) => Promise<unknown>) => callback(fixture.tx));
    useDialectTransaction(dialect, transaction);
    const result = await createSqlStore().create(input);
    expect(result).toMatchObject({ version: "1.0.0", sourceArtifactId: manifest.artifact_id });
    expect(fixture.insertValues).toHaveBeenCalledTimes(2);
  });

  it("persists a personal audience with no target ids", async () => {
    const fixture = transactionFixture([[]]);
    const transaction = vi.fn(async (callback: (tx: typeof fixture.tx) => Promise<unknown>) => callback(fixture.tx));
    useDialectTransaction(dialect, transaction);

    const result = await createSqlStore().create({
      ...input,
      audience: { visibility: "personal", visibleDepartmentIds: [], visibleUserIds: [] },
    });

    expect(result).toMatchObject({
      visibility: "personal",
      visibleDepartmentIds: [],
      visibleUserIds: [],
    });
    expect(fixture.insertValues).toHaveBeenNthCalledWith(1, expect.objectContaining({
      visibility: "personal",
      visibleDepartmentIds: [],
      visibleUserIds: [],
    }));
  });

  it("rejects an audience change without inserting a release", async () => {
    const fixture = transactionFixture([[existingArtifact()]]);
    const transaction = vi.fn(async (callback: (tx: typeof fixture.tx) => Promise<unknown>) => callback(fixture.tx));
    useDialectTransaction(dialect, transaction);
    await expect(createSqlStore().create(input)).rejects.toBeInstanceOf(ConfigMarketAudienceConflictError);
    expect(fixture.insertValues).not.toHaveBeenCalled();
  });

  it("treats artifact identity as tenant-wide and rejects a second uploader", async () => {
    const fixture = transactionFixture([[{ ...existingArtifact(), userId: "another-user" }]]);
    const transaction = vi.fn(async (callback: (tx: typeof fixture.tx) => Promise<unknown>) => callback(fixture.tx));
    useDialectTransaction(dialect, transaction);
    await expect(createSqlStore().create({
      ...input,
      audience: { visibility: "company", visibleDepartmentIds: [], visibleUserIds: [] },
    })).rejects.toBeInstanceOf(ConfigMarketOwnershipConflictError);
    expect(fixture.insertValues).not.toHaveBeenCalled();
  });

  it("returns the current immutable release for an exact retry", async () => {
    const fixture = transactionFixture([[existingArtifact()], [currentRelease()]]);
    const transaction = vi.fn(async (callback: (tx: typeof fixture.tx) => Promise<unknown>) => callback(fixture.tx));
    useDialectTransaction(dialect, transaction);
    const result = await createSqlStore().create({
      ...input,
      audience: { visibility: "company", visibleDepartmentIds: [], visibleUserIds: [] },
    });
    expect(result).toMatchObject({ id: existingArtifact().id, releaseId: currentRelease().id });
    expect(fixture.insertValues).not.toHaveBeenCalled();
  });

  it("rejects a new stable release that would break an existing tracking pack", async () => {
    const skillId = "skill:01JQMZ8K3N4P5Q6R7S8T9VWX03";
    const nextManifest = v2ExpertManifest("投研专家", {
      artifactId: manifest.artifact_id,
      version: "1.1.0",
      systemPrompt: "新版内部分析指令",
    });
    nextManifest.dependencies.skills = [{
      capability_id: skillId,
      version: "1.0.0",
      digest: "a".repeat(64),
      required: true,
    }];
    const fixture = transactionFixture([
      [existingArtifact()],
      [currentRelease()],
      [],
      [{ packId: "pack-a" }],
      [{ packId: "pack-a", capabilityId: `expert:${existingArtifact().id}` }],
    ]);
    const transaction = vi.fn(async (callback: (tx: typeof fixture.tx) => Promise<unknown>) => callback(fixture.tx));
    useDialectTransaction(dialect, transaction);
    await expect(createSqlStore().create({
      ...input,
      manifest: nextManifest,
      audience: { visibility: "company", visibleDepartmentIds: [], visibleUserIds: [] },
    })).rejects.toMatchObject({
      name: ConfigMarketTrackStableDependencyConflictError.name,
      missingCapabilityIds: [skillId],
      packIds: ["pack-a"],
    });
    expect(fixture.insertValues).not.toHaveBeenCalled();
  });

  it("lists a bounded metadata page without selecting manifest bytes", async () => {
    const limit = vi.fn().mockResolvedValue([{ artifact: existingArtifact(), release: currentRelease() }]);
    const chain: Record<string, any> = {};
    for (const method of ["from", "innerJoin", "where", "orderBy"] as const) {
      chain[method] = vi.fn(() => chain);
    }
    chain.limit = limit;
    const select = vi.fn((_fields: unknown) => chain);
    const db = { select };
    mocks.resolveDatabaseConfig.mockReturnValue({ dialect, url: `${dialect}://localhost/agenticx` });
    if (dialect === "mysql") mocks.createMysqlDb.mockResolvedValue({ raw: db });
    else mocks.getIamDb.mockReturnValue(db);

    const page = await createSqlStore().listVisibleMetadata(
      { tenantId: input.tenantId, userId: input.userId, deptId: null },
      { limit: 2 },
    );
    expect(page.items).toHaveLength(1);
    expect(limit).toHaveBeenCalledWith(51);
    const fields = select.mock.calls[0]![0] as { release: Record<string, unknown> };
    expect(fields.release).not.toHaveProperty("manifest");
  });

  it("continues bounded metadata batches until it fills the visible page", async () => {
    const hidden = {
      ...existingArtifact(),
      userId: "another-user",
      visibility: "users",
      visibleUserIds: ["01JQMZ8K3N4P5Q6R7S8T9VWX04"],
    };
    const visible = { ...existingArtifact(), visibility: "company" };
    const limitQuery = vi.fn()
      .mockResolvedValueOnce(Array.from({ length: 51 }, () => ({ artifact: hidden, release: currentRelease() })))
      .mockResolvedValueOnce([{ artifact: visible, release: currentRelease() }]);
    const chain: Record<string, any> = {};
    for (const method of ["from", "innerJoin", "where", "orderBy"] as const) {
      chain[method] = vi.fn(() => chain);
    }
    chain.limit = limitQuery;
    const db = { select: vi.fn((_fields: unknown) => chain) };
    mocks.resolveDatabaseConfig.mockReturnValue({ dialect, url: `${dialect}://localhost/agenticx` });
    if (dialect === "mysql") mocks.createMysqlDb.mockResolvedValue({ raw: db });
    else mocks.getIamDb.mockReturnValue(db);

    const page = await createSqlStore().listVisibleMetadata(
      { tenantId: input.tenantId, userId: input.userId, deptId: null },
      { limit: 1 },
    );
    expect(page.items).toHaveLength(1);
    expect(limitQuery).toHaveBeenCalledTimes(2);
  });
});
