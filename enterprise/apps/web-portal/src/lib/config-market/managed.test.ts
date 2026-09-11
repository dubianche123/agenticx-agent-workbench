import { describe, expect, it } from "vitest";
import { ulid } from "ulid";

import { ENTERPRISE_ASSISTANT_CAPABILITY_ID } from "@agenticx/config";
import { v2ExpertManifest } from "../config-share-test-fixtures";
import type { ConfigMarketArtifactRow, ConfigMarketReleaseRow } from "./store";
import { configMarketManifestDigest } from "./types";
import {
  managedPackagesFromCandidates,
  MAX_MANAGED_PORTABLE_PACKAGES,
  resolveManagedPackagesFromCandidates,
  type ManagedPortableMember,
} from "./managed";

const now = new Date("2026-08-28T00:00:00.000Z");

function release(id: string, artifactId: string, version = "1.0.0"): ConfigMarketReleaseRow {
  const manifest = v2ExpertManifest("投研专家", {
    artifactId: `expert:${artifactId}`,
    version,
  });
  return {
    id,
    tenantId: "tenant-a",
    artifactId,
    version,
    manifestVersion: 2,
    manifestDigest: configMarketManifestDigest(manifest),
    manifest,
    releaseNotes: "",
    publishedAt: now,
    createdAt: now,
    updatedAt: now,
  };
}

function artifact(
  id: string,
  currentReleaseId: string,
  status: "published" | "unlisted" = "published",
): ConfigMarketArtifactRow {
  return {
    id,
    tenantId: "tenant-a",
    userId: "user-a",
    ownerDisplayName: "Alice",
    kind: "expert",
    sourceArtifactId: `expert:${id}`,
    title: "投研专家",
    description: "分析公告",
    currentReleaseId,
    visibility: "company",
    visibleDepartmentIds: [],
    visibleUserIds: [],
    status,
    publishedAt: now,
    unlistedAt: status === "unlisted" ? now : null,
    createdAt: now,
    updatedAt: now,
  };
}

function member(
  artifactId: string,
  mode: "pinned" | "track_stable",
  pinnedReleaseId: string | null,
  packId = "pack-a",
): ManagedPortableMember {
  return { packId, capabilityId: `expert:${artifactId}`, releasePolicy: mode, pinnedReleaseId };
}

describe("managed portable release resolution", () => {
  it("does not resolve the built-in enterprise assistant as a market package", () => {
    const artifactId = ulid();
    const releaseId = ulid();
    const resolution = resolveManagedPackagesFromCandidates(
      [{
        packId: "pack-a",
        capabilityId: ENTERPRISE_ASSISTANT_CAPABILITY_ID,
        releasePolicy: "pinned",
        pinnedReleaseId: releaseId,
      }],
      [artifact(artifactId, releaseId)],
      [release(releaseId, artifactId)],
    );

    expect(resolution).toEqual({ packages: [], errors: [] });
  });

  it("keeps pinned bytes while track_stable follows the artifact current release", () => {
    const artifactId = ulid();
    const v1Id = ulid();
    const v2Id = ulid();
    const releases = [release(v1Id, artifactId, "1.0.0"), release(v2Id, artifactId, "1.1.0")];
    const item = artifact(artifactId, v2Id);

    expect(managedPackagesFromCandidates([member(artifactId, "pinned", v1Id)], [item], releases)[0])
      .toMatchObject({ id: `expert:${artifactId}`, releaseId: v1Id, version: "1.0.0" });
    expect(managedPackagesFromCandidates([member(artifactId, "track_stable", null)], [item], releases)[0])
      .toMatchObject({ id: `expert:${artifactId}`, releaseId: v2Id, version: "1.1.0" });
  });

  it("keeps unlisted artifacts in delivery and rejects dangling or cross-artifact pinned releases", () => {
    const artifactId = ulid();
    const releaseId = ulid();
    const item = artifact(artifactId, releaseId, "unlisted");
    expect(managedPackagesFromCandidates(
      [member(artifactId, "pinned", releaseId)],
      [item],
      [release(releaseId, artifactId)],
    )).toMatchObject([{ id: `expert:${artifactId}`, version: "1.0.0" }]);
    expect(managedPackagesFromCandidates(
      [member(artifactId, "pinned", releaseId)],
      [{ ...item, deliveryState: "revoked" }],
      [release(releaseId, artifactId)],
    )).toEqual([]);

    const published = artifact(artifactId, releaseId);
    expect(() =>
      managedPackagesFromCandidates(
        [member(artifactId, "pinned", releaseId)],
        [published],
        [release(releaseId, ulid())],
      ),
    ).toThrow(/ownership mismatch/);
  });

  it("resolves an admins-only market Skill as a managed portable package after admin review", () => {
    const artifactId = ulid();
    const releaseId = ulid();
    const skillName = "public-research";
    const manifest = {
      ...v2ExpertManifest(skillName, { artifactId: `skill:${artifactId}`, version: "1.0.0" }),
      kind: "skill" as const,
      title: skillName,
      description: "查找公开资料",
      payload: {
        name: skillName,
        description: "查找公开资料",
        skill_md: "---\nname: public-research\ndescription: 查找公开资料\n---\n\n# Research\n",
      },
      resources: [],
      workspace_slots: [],
    };
    const skillRelease: ConfigMarketReleaseRow = {
      id: releaseId,
      tenantId: "tenant-a",
      artifactId,
      version: "1.0.0",
      manifestVersion: 2,
      manifestDigest: configMarketManifestDigest(manifest),
      manifest,
      releaseNotes: "",
      publishedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    const skillArtifact: ConfigMarketArtifactRow = {
      id: artifactId,
      tenantId: "tenant-a",
      userId: "user-a",
      ownerDisplayName: "Alice",
      kind: "skill",
      sourceArtifactId: `skill:${artifactId}`,
      title: skillName,
      description: "查找公开资料",
      currentReleaseId: releaseId,
      visibility: "admins_only",
      visibleDepartmentIds: [],
      visibleUserIds: [],
      status: "unlisted",
      deliveryState: "active",
      publishedAt: now,
      unlistedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    const result = managedPackagesFromCandidates(
      [{ packId: "pack-a", capabilityId: `skill:${artifactId}`, releasePolicy: "pinned", pinnedReleaseId: releaseId }],
      [skillArtifact],
      [skillRelease],
    );
    expect(result).toMatchObject([{
      id: `skill:${artifactId}`,
      kind: "skill",
      version: "1.0.0",
      raw: expect.stringContaining("public-research"),
    }]);
  });

  it("accepts 64 packages but rejects 65 without truncating desired state", () => {
    const ids = Array.from({ length: MAX_MANAGED_PORTABLE_PACKAGES + 1 }, () => ulid());
    const releaseIds = ids.map(() => ulid());
    const members = ids.map((id, index) => member(id, "pinned", releaseIds[index]!));
    const artifacts = ids.map((id, index) => artifact(id, releaseIds[index]!));
    const releases = ids.map((id, index) => release(releaseIds[index]!, id));
    expect(managedPackagesFromCandidates(members.slice(0, 64), artifacts.slice(0, 64), releases.slice(0, 64)))
      .toHaveLength(64);
    expect(() => managedPackagesFromCandidates(members, artifacts, releases)).toThrow(
      "managed portable package limit exceeded: 65/64",
    );
  });

  it("requires dependencies in the same pack and revalidates Skill version/digest", () => {
    const artifactId = ulid();
    const releaseId = ulid();
    const skillId = ulid();
    const skillCapabilityId = `skill:${skillId}`;
    const itemRelease = release(releaseId, artifactId);
    (itemRelease.manifest as ReturnType<typeof v2ExpertManifest>).dependencies.skills = [{
      capability_id: skillCapabilityId,
      version: "1.2.3",
      digest: "a".repeat(64),
      required: true,
    }];
    itemRelease.manifestDigest = configMarketManifestDigest(
      itemRelease.manifest as ReturnType<typeof v2ExpertManifest>,
    );
    const expertMember = member(artifactId, "pinned", releaseId, "pack-a");
    const dependencyMember: ManagedPortableMember = {
      packId: "pack-a",
      capabilityId: skillCapabilityId,
      releasePolicy: null,
      pinnedReleaseId: null,
    };
    const registry = [{
      capabilityId: skillCapabilityId,
      status: "active",
      version: "1.2.3",
      digest: "a".repeat(64),
    }];

    expect(() => managedPackagesFromCandidates(
      [expertMember, { ...dependencyMember, packId: "pack-b" }],
      [artifact(artifactId, releaseId)],
      [itemRelease],
      registry,
    )).toThrow(/missing required dependency in the same pack/);
    expect(() => managedPackagesFromCandidates(
      [expertMember, dependencyMember],
      [artifact(artifactId, releaseId)],
      [itemRelease],
      [{ ...registry[0]!, version: "1.2.4" }],
    )).toThrow(/version or digest mismatch/);
    expect(managedPackagesFromCandidates(
      [expertMember, dependencyMember],
      [artifact(artifactId, releaseId)],
      [itemRelease],
      registry,
    )).toHaveLength(1);
  });

  it("revalidates the exact MCP registry version before managed delivery", () => {
    const artifactId = ulid();
    const releaseId = ulid();
    const mcpId = ulid();
    const mcpCapabilityId = `mcp:${mcpId}`;
    const itemRelease = release(releaseId, artifactId);
    (itemRelease.manifest as ReturnType<typeof v2ExpertManifest>).dependencies.mcps = [{
      capability_id: mcpCapabilityId,
      version: "2.0.0",
      required: true,
    }];
    itemRelease.manifestDigest = configMarketManifestDigest(
      itemRelease.manifest as ReturnType<typeof v2ExpertManifest>,
    );
    const expertMember = member(artifactId, "pinned", releaseId, "pack-a");
    const dependencyMember: ManagedPortableMember = {
      packId: "pack-a",
      capabilityId: mcpCapabilityId,
      releasePolicy: null,
      pinnedReleaseId: null,
    };
    const registry = [{
      capabilityId: mcpCapabilityId,
      status: "active",
      version: "2.0.0",
      digest: null,
    }];

    expect(() => managedPackagesFromCandidates(
      [expertMember, dependencyMember],
      [artifact(artifactId, releaseId)],
      [itemRelease],
      [{ ...registry[0]!, version: "2.0.1" }],
    )).toThrow(/required MCP version mismatch/);
    expect(managedPackagesFromCandidates(
      [expertMember, dependencyMember],
      [artifact(artifactId, releaseId)],
      [itemRelease],
      registry,
    )).toHaveLength(1);
  });

  it("isolates a dangling package while preserving other authoritative packages", () => {
    const goodArtifactId = ulid();
    const goodReleaseId = ulid();
    const badArtifactId = ulid();
    const badReleaseId = ulid();
    const goodArtifact = artifact(goodArtifactId, goodReleaseId);
    const badArtifact = artifact(badArtifactId, badReleaseId);
    const resolution = resolveManagedPackagesFromCandidates(
      [
        member(goodArtifactId, "pinned", goodReleaseId, "pack-good"),
        member(badArtifactId, "pinned", badReleaseId, "pack-bad"),
      ],
      [goodArtifact, badArtifact],
      [release(goodReleaseId, goodArtifactId)],
    );

    expect(resolution.packages).toHaveLength(1);
    expect(resolution.packages[0]).toMatchObject({ id: `expert:${goodArtifactId}` });
    expect(resolution.errors).toEqual([
      {
        capabilityId: `expert:${badArtifactId}`,
        packIds: ["pack-bad"],
        message: expect.stringContaining("dangling release"),
      },
    ]);
  });
});
