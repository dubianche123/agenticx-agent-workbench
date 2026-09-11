import { beforeEach, describe, expect, it, vi } from "vitest";
import { ENTERPRISE_ASSISTANT_CAPABILITY_ID } from "@agenticx/config";
import { v2ExpertManifest } from "../config-share-test-fixtures";
import { configMarketManifestDigest } from "./types";

const mocks = vi.hoisted(() => ({
  queryResults: [] as unknown[][],
  resolveAssignmentKeysForManagedDelivery: vi.fn(),
}));

vi.mock("@agenticx/iam-core", () => ({
  resolveAssignmentKeysForManagedDelivery: (...args: unknown[]) =>
    mocks.resolveAssignmentKeysForManagedDelivery(...args),
}));

vi.mock("../capability-tables", async () => {
  const schema = await vi.importActual<typeof import("@agenticx/db-schema")>("@agenticx/db-schema");
  const nextRows = async () => mocks.queryResults.shift() ?? [];
  const db = {
    select: () => ({
      from: () => ({
        innerJoin: () => ({ where: nextRows }),
        where: nextRows,
      }),
    }),
  };
  return {
    dialectCapabilityTables: async () => ({
      db,
      packs: schema.enterpriseCapabilityPacks,
      assignments: schema.enterpriseCapabilityAssignments,
      members: schema.enterpriseCapabilityPackMembers,
      skills: schema.enterpriseSkills,
      mcp: schema.mcpServers,
      configMarketItems: schema.enterpriseConfigMarketItems,
      configMarketReleases: schema.enterpriseConfigMarketReleases,
    }),
  };
});

const itemId = "01JQMZ8K3N4P5Q6R7S8T9VWXYZ";
const manifest = v2ExpertManifest("投研专家", { artifactId: `expert:${itemId}` });

describe("assigned capability-pack portable delivery", () => {
  beforeEach(() => {
    mocks.queryResults = [];
    mocks.resolveAssignmentKeysForManagedDelivery
      .mockReset()
      .mockResolvedValue(["all", "dept:dept-a"]);
  });

  it("resolves assignment keys and returns the referenced published market artifact", async () => {
    const { configMarketCanonicalRaw, configMarketManifestDigest } = await import("./types");
    mocks.queryResults = [
      [{ id: "pack-a" }],
      [{ packId: "pack-a", capabilityId: `expert:${itemId}`, releasePolicy: "pinned", pinnedReleaseId: "01JQMZ8K3N4P5Q6R7S8T9VWXY1" }],
      [
        {
          id: itemId,
          tenantId: "tenant-a",
          userId: "author-a",
          ownerDisplayName: "Alice",
          kind: "expert",
          sourceArtifactId: manifest.artifact_id,
          currentReleaseId: "01JQMZ8K3N4P5Q6R7S8T9VWXY1",
          title: manifest.title,
          description: manifest.description,
          visibility: "users",
          visibleDepartmentIds: [],
          visibleUserIds: ["01JQMZ8K3N4P5Q6R7S8T9VWXY0"],
          status: "published",
          publishedAt: new Date("2026-08-28T00:00:00.000Z"),
          unlistedAt: null,
          createdAt: new Date("2026-08-28T00:00:00.000Z"),
          updatedAt: new Date("2026-08-28T00:00:00.000Z"),
        },
      ],
      [
        {
          id: "01JQMZ8K3N4P5Q6R7S8T9VWXY1",
          tenantId: "tenant-a",
          artifactId: itemId,
          version: "1.0.0",
          manifestVersion: 2,
          manifestDigest: configMarketManifestDigest(manifest),
          manifest,
          releaseNotes: "",
          publishedAt: new Date("2026-08-28T00:00:00.000Z"),
          createdAt: new Date("2026-08-28T00:00:00.000Z"),
          updatedAt: new Date("2026-08-28T00:00:00.000Z"),
        },
      ],
    ];

    const { listManagedPortablePackagesForUser } = await import("./managed");
    const result = await listManagedPortablePackagesForUser({
      tenantId: "tenant-a",
      userId: "user-a",
      email: "user@example.invalid",
      deptId: "dept-a",
    });
    expect(mocks.resolveAssignmentKeysForManagedDelivery).toHaveBeenCalledWith(
      "tenant-a",
      "user-a",
      "user@example.invalid",
      "dept-a",
    );
    expect(result).toEqual([
      expect.objectContaining({
        id: `expert:${itemId}`,
        title: "投研专家",
        version: "1.0.0",
        raw: configMarketCanonicalRaw(manifest),
      }),
    ]);
    expect(mocks.queryResults).toHaveLength(0);
  });

  it("returns an empty portable snapshot for a built-in assistant-only pack", async () => {
    mocks.queryResults = [
      [{ id: "pack-a" }],
      [{
        packId: "pack-a",
        capabilityId: ENTERPRISE_ASSISTANT_CAPABILITY_ID,
        releasePolicy: null,
        pinnedReleaseId: null,
      }],
    ];

    const { listManagedPortablePackagesForUser } = await import("./managed");
    await expect(listManagedPortablePackagesForUser({ tenantId: "tenant-a", userId: "user-a" }))
      .resolves.toEqual([]);
    // No config-market or release lookup is needed for a platform entry point.
    expect(mocks.queryResults).toHaveLength(0);
  });

  it("keeps a real portable package when the same pack also grants the built-in assistant", async () => {
    const releaseId = "01JQMZ8K3N4P5Q6R7S8T9VWXY1";
    mocks.queryResults = [
      [{ id: "pack-a" }],
      [
        {
          packId: "pack-a",
          capabilityId: ENTERPRISE_ASSISTANT_CAPABILITY_ID,
          releasePolicy: null,
          pinnedReleaseId: null,
        },
        {
          packId: "pack-a",
          capabilityId: `expert:${itemId}`,
          releasePolicy: "pinned",
          pinnedReleaseId: releaseId,
        },
      ],
      [{
        id: itemId,
        tenantId: "tenant-a",
        userId: "author-a",
        ownerDisplayName: "Alice",
        kind: "expert",
        sourceArtifactId: manifest.artifact_id,
        currentReleaseId: releaseId,
        title: manifest.title,
        description: manifest.description,
        visibility: "company",
        visibleDepartmentIds: [],
        visibleUserIds: [],
        status: "published",
        publishedAt: new Date("2026-08-28T00:00:00.000Z"),
        unlistedAt: null,
        createdAt: new Date("2026-08-28T00:00:00.000Z"),
        updatedAt: new Date("2026-08-28T00:00:00.000Z"),
      }],
      [{
        id: releaseId,
        tenantId: "tenant-a",
        artifactId: itemId,
        version: "1.0.0",
        manifestVersion: 2,
        manifestDigest: configMarketManifestDigest(manifest),
        manifest,
        releaseNotes: "",
        publishedAt: new Date("2026-08-28T00:00:00.000Z"),
        createdAt: new Date("2026-08-28T00:00:00.000Z"),
        updatedAt: new Date("2026-08-28T00:00:00.000Z"),
      }],
    ];

    const { listManagedPortablePackagesForUser } = await import("./managed");
    await expect(listManagedPortablePackagesForUser({ tenantId: "tenant-a", userId: "user-a" }))
      .resolves.toEqual([expect.objectContaining({ id: `expert:${itemId}` })]);
    expect(mocks.queryResults).toHaveLength(0);
  });

  it("fails closed for a missing assigned expert while ignoring a legacy Skill member", async () => {
    const legacySkillId = "01JQMZ8K3N4P5Q6R7S8T9VWXY0";
    mocks.queryResults = [
      [{ id: "pack-a" }],
      [
        {
          packId: "pack-a",
          capabilityId: `expert:${itemId}`,
          releasePolicy: "pinned",
          pinnedReleaseId: "01JQMZ8K3N4P5Q6R7S8T9VWXY1",
        },
        {
          packId: "pack-a",
          capabilityId: `skill:${legacySkillId}`,
          releasePolicy: null,
          pinnedReleaseId: null,
        },
      ],
      [],
    ];

    const { listManagedPortablePackagesForUser } = await import("./managed");
    await expect(listManagedPortablePackagesForUser({ tenantId: "tenant-a", userId: "user-a" }))
      .rejects.toThrow(`assigned portable market item is missing: expert:${itemId}`);
    expect(mocks.queryResults).toHaveLength(0);
  });

  it("does not treat a legacy-only Skill assignment as a missing market item", async () => {
    const legacySkillId = "01JQMZ8K3N4P5Q6R7S8T9VWXY0";
    mocks.queryResults = [
      [{ id: "pack-a" }],
      [{
        packId: "pack-a",
        capabilityId: `skill:${legacySkillId}`,
        releasePolicy: null,
        pinnedReleaseId: null,
      }],
      [],
    ];

    const { listManagedPortablePackagesForUser } = await import("./managed");
    await expect(listManagedPortablePackagesForUser({ tenantId: "tenant-a", userId: "user-a" }))
      .resolves.toEqual([]);
    expect(mocks.queryResults).toHaveLength(0);
  });

  it("treats an explicit delivery revoke as a normal empty snapshot", async () => {
    const releaseId = "01JQMZ8K3N4P5Q6R7S8T9VWXY1";
    mocks.queryResults = [
      [{ id: "pack-a" }],
      [{
        packId: "pack-a",
        capabilityId: `expert:${itemId}`,
        releasePolicy: "pinned",
        pinnedReleaseId: releaseId,
      }],
      [{
        id: itemId,
        kind: "expert",
        deliveryState: "revoked",
        currentReleaseId: releaseId,
      }],
      [],
    ];

    const { listManagedPortablePackagesForUser } = await import("./managed");
    await expect(listManagedPortablePackagesForUser({ tenantId: "tenant-a", userId: "user-a" }))
      .resolves.toEqual([]);
    expect(mocks.queryResults).toHaveLength(0);
  });

  it("fails closed for a missing market Skill but does not misclassify a legacy Skill", async () => {
    const marketSkillId = "01JQMZ8K3N4P5Q6R7S8T9VWXY2";
    mocks.queryResults = [
      [{ id: "pack-a" }],
      [{
        packId: "pack-a",
        capabilityId: `skill:${marketSkillId}`,
        releasePolicy: "pinned",
        pinnedReleaseId: "01JQMZ8K3N4P5Q6R7S8T9VWXY3",
      }],
      [],
    ];

    const { listManagedPortablePackagesForUser } = await import("./managed");
    await expect(listManagedPortablePackagesForUser({ tenantId: "tenant-a", userId: "user-a" }))
      .rejects.toThrow(`assigned portable market item is missing: skill:${marketSkillId}`);
    expect(mocks.queryResults).toHaveLength(0);
  });

  it("delivers an expert when required Skill and MCP versions are active and selected in the same pack", async () => {
    const { configMarketManifestDigest } = await import("./types");
    const skillId = "01JQMZ8K3N4P5Q6R7S8T9VWX03";
    const mcpId = "01JQMZ8K3N4P5Q6R7S8T9VWX04";
    const requiredManifest = v2ExpertManifest("投研专家", { artifactId: `expert:${itemId}` });
    requiredManifest.dependencies.skills = [{
      capability_id: `skill:${skillId}`,
      version: "1.2.3",
      digest: "a".repeat(64),
      required: true,
    }];
    requiredManifest.dependencies.mcps = [{
      capability_id: `mcp:${mcpId}`,
      version: "2.0.0",
      required: true,
    }];
    mocks.queryResults = [
      [{ id: "pack-a" }],
      [
        { packId: "pack-a", capabilityId: `expert:${itemId}`, releasePolicy: "pinned", pinnedReleaseId: "01JQMZ8K3N4P5Q6R7S8T9VWXY1" },
        { packId: "pack-a", capabilityId: `skill:${skillId}`, releasePolicy: null, pinnedReleaseId: null },
        { packId: "pack-a", capabilityId: `mcp:${mcpId}`, releasePolicy: null, pinnedReleaseId: null },
      ],
      [{
        id: itemId,
        tenantId: "tenant-a",
        userId: "author-a",
        ownerDisplayName: "Alice",
        kind: "expert",
        sourceArtifactId: requiredManifest.artifact_id,
        currentReleaseId: "01JQMZ8K3N4P5Q6R7S8T9VWXY1",
        title: requiredManifest.title,
        description: requiredManifest.description,
        visibility: "company",
        visibleDepartmentIds: [],
        visibleUserIds: [],
        status: "published",
        publishedAt: new Date("2026-08-28T00:00:00.000Z"),
        unlistedAt: null,
        createdAt: new Date("2026-08-28T00:00:00.000Z"),
        updatedAt: new Date("2026-08-28T00:00:00.000Z"),
      }],
      [{
        id: "01JQMZ8K3N4P5Q6R7S8T9VWXY1",
        tenantId: "tenant-a",
        artifactId: itemId,
        version: "1.0.0",
        manifestVersion: 2,
        manifestDigest: configMarketManifestDigest(requiredManifest),
        manifest: requiredManifest,
        releaseNotes: "",
        publishedAt: new Date("2026-08-28T00:00:00.000Z"),
        createdAt: new Date("2026-08-28T00:00:00.000Z"),
        updatedAt: new Date("2026-08-28T00:00:00.000Z"),
      }],
      [{ id: skillId, status: "active", version: "1.2.3", digest: "a".repeat(64) }],
      [{ id: mcpId, status: "active", version: "2.0.0" }],
    ];

    const { listManagedPortablePackagesForUser } = await import("./managed");
    await expect(listManagedPortablePackagesForUser({
      tenantId: "tenant-a",
      userId: "user-a",
    })).resolves.toEqual([expect.objectContaining({ id: `expert:${itemId}` })]);
    expect(mocks.queryResults).toHaveLength(0);
  });

  it("propagates assignment resolution failures instead of returning an authoritative empty state", async () => {
    const failure = new Error("user-group query timed out");
    mocks.resolveAssignmentKeysForManagedDelivery.mockRejectedValue(failure);

    const { listManagedPortablePackagesForUser } = await import("./managed");
    await expect(
      listManagedPortablePackagesForUser({
        tenantId: "tenant-a",
        userId: "user-a",
      }),
    ).rejects.toBe(failure);
    expect(mocks.queryResults).toHaveLength(0);
  });

  it("fails closed when one assigned package has a dangling release", async () => {
    const goodItemId = itemId;
    const goodReleaseId = "01JQMZ8K3N4P5Q6R7S8T9VWXY1";
    const badItemId = "01JQMZ8K3N4P5Q6R7S8T9VWXY2";
    const badReleaseId = "01JQMZ8K3N4P5Q6R7S8T9VWXY3";
    const goodManifest = v2ExpertManifest("可用专家", { artifactId: `expert:${goodItemId}` });
    const goodArtifact = {
      id: goodItemId,
      tenantId: "tenant-a",
      userId: "author-a",
      ownerDisplayName: "Alice",
      kind: "expert",
      sourceArtifactId: goodManifest.artifact_id,
      currentReleaseId: goodReleaseId,
      title: goodManifest.title,
      description: goodManifest.description,
      visibility: "company",
      visibleDepartmentIds: [],
      visibleUserIds: [],
      status: "published",
      publishedAt: new Date("2026-08-28T00:00:00.000Z"),
      unlistedAt: null,
      createdAt: new Date("2026-08-28T00:00:00.000Z"),
      updatedAt: new Date("2026-08-28T00:00:00.000Z"),
    };
    const badManifest = v2ExpertManifest("坏专家", { artifactId: `expert:${badItemId}` });
    mocks.queryResults = [
      [{ id: "pack-good" }, { id: "pack-bad" }],
      [
        { packId: "pack-good", capabilityId: `expert:${goodItemId}`, releasePolicy: "pinned", pinnedReleaseId: goodReleaseId },
        { packId: "pack-bad", capabilityId: `expert:${badItemId}`, releasePolicy: "pinned", pinnedReleaseId: badReleaseId },
      ],
      [
        goodArtifact,
        {
          ...goodArtifact,
          id: badItemId,
          sourceArtifactId: badManifest.artifact_id,
          currentReleaseId: badReleaseId,
          title: badManifest.title,
          description: badManifest.description,
        },
      ],
      [{
        id: goodReleaseId,
        tenantId: "tenant-a",
        artifactId: goodItemId,
        version: "1.0.0",
        manifestVersion: 2,
        manifestDigest: configMarketManifestDigest(goodManifest),
        manifest: goodManifest,
        releaseNotes: "",
        publishedAt: new Date("2026-08-28T00:00:00.000Z"),
        createdAt: new Date("2026-08-28T00:00:00.000Z"),
        updatedAt: new Date("2026-08-28T00:00:00.000Z"),
      }],
    ];
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const { listManagedPortablePackagesForUser } = await import("./managed");
      await expect(listManagedPortablePackagesForUser({ tenantId: "tenant-a", userId: "user-a" }))
        .rejects.toThrow("portable pack member expert:");
      expect(consoleError).toHaveBeenCalledWith(
        "[desktop/bootstrap] managed portable package resolution failed:",
        `expert:${badItemId}`,
        expect.stringContaining("dangling release"),
        { packIds: ["pack-bad"] },
      );
    } finally {
      consoleError.mockRestore();
    }
  });
});
