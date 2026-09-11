import {
  ENTERPRISE_ASSISTANT_CAPABILITY_ID,
  formatCapabilityId,
  groupCapabilityIdsByKind,
  MAX_MANAGED_PORTABLE_PACKAGES,
  parseCapabilityId,
} from "@agenticx/config";
import { resolveAssignmentKeysForManagedDelivery } from "@agenticx/iam-core";
import { and, eq, inArray } from "drizzle-orm";

import { compareConfigShareVersions } from "../config-share-types";
import { dialectCapabilityTables, type DialectQuery } from "../capability-tables";
import {
  mapConfigMarketRow,
  type ConfigMarketArtifactRow,
  type ConfigMarketReleaseRow,
} from "./store";
import {
  configMarketCapabilityId,
  requiredConfigMarketDependencies,
  toManagedPortablePackage,
  type ManagedPortablePackage,
} from "./types";

/** Must stay aligned with agenticx.avatar.managed_portable.MAX_MANAGED_PACKAGES. */
export { MAX_MANAGED_PORTABLE_PACKAGES } from "@agenticx/config";

export type ManagedPortableMember = {
  packId: string;
  capabilityId: string;
  releasePolicy: "pinned" | "track_stable" | null;
  pinnedReleaseId: string | null;
};

export type ManagedDependencyCapability = {
  capabilityId: string;
  status: string;
  version: string | null;
  digest: string | null;
};

export type ManagedPortableResolutionError = {
  capabilityId: string;
  packIds: string[];
  message: string;
};

export type ManagedPortableResolution = {
  packages: ManagedPortablePackage[];
  errors: ManagedPortableResolutionError[];
};

function isBuiltinEnterpriseAssistantCapabilityId(value: unknown): boolean {
  const parsed = parseCapabilityId(String(value ?? ""));
  return Boolean(
    parsed &&
      parsed.kind === "expert" &&
      formatCapabilityId(parsed.kind, parsed.rowId) === ENTERPRISE_ASSISTANT_CAPABILITY_ID,
  );
}

function managedPortableCapabilityKey(value: unknown): string | null {
  const parsed = parseCapabilityId(String(value ?? ""));
  if (!parsed || (parsed.kind !== "expert" && parsed.kind !== "group" && parsed.kind !== "skill")) {
    return null;
  }
  const capabilityId = formatCapabilityId(parsed.kind, parsed.rowId);
  // The enterprise assistant is a built-in entry point granted through packs,
  // but it has no Config Market artifact or portable release.
  return capabilityId === ENTERPRISE_ASSISTANT_CAPABILITY_ID ? null : capabilityId;
}

/** Resolve one stable capability id to the exact immutable release approved by its pack members. */
export function resolveManagedPackagesFromCandidates(
  members: readonly ManagedPortableMember[],
  artifacts: readonly ConfigMarketArtifactRow[],
  releases: readonly ConfigMarketReleaseRow[],
  dependencyCapabilities: readonly ManagedDependencyCapability[] = [],
): ManagedPortableResolution {
  const membersByCapability = new Map<string, ManagedPortableMember[]>();
  for (const member of members) {
    const capabilityKey = managedPortableCapabilityKey(member.capabilityId);
    if (!capabilityKey) continue;
    const list = membersByCapability.get(capabilityKey) ?? [];
    list.push(member);
    membersByCapability.set(capabilityKey, list);
  }
  const releaseById = new Map(releases.map((release) => [release.id, release] as const));
  const membersByPack = new Map<string, Set<string>>();
  for (const member of members) {
    const capabilityKey = managedPortableCapabilityKey(member.capabilityId);
    if (!capabilityKey && isBuiltinEnterpriseAssistantCapabilityId(member.capabilityId)) continue;
    const selected = membersByPack.get(member.packId) ?? new Set<string>();
    selected.add(capabilityKey ?? member.capabilityId);
    membersByPack.set(member.packId, selected);
  }
  const dependencyById = new Map(
    dependencyCapabilities.map((dependency) => [dependency.capabilityId, dependency] as const),
  );
  const packages: ManagedPortablePackage[] = [];
  const errors: ManagedPortableResolutionError[] = [];

  for (const artifact of artifacts) {
    if (artifact.kind !== "expert" && artifact.kind !== "group" && artifact.kind !== "skill") continue;
    const capabilityId = configMarketCapabilityId(artifact.kind, artifact.id);
    const candidateMembers = membersByCapability.get(capabilityId)?.filter((member) => {
      // Legacy registry Skills use a null release policy and are delivered by
      // capability-packs-reader, not by this portable market snapshot. A
      // market Skill member always selects an immutable release.
      return artifact.kind !== "skill"
        || (member.releasePolicy !== null && member.releasePolicy !== undefined);
    });
    if (!candidateMembers?.length) continue;

    // An explicit emergency revoke is the only normal omission. Any other
    // invalid stored state must remain visible as a resolution error so the
    // caller can retain Desktop's last-known-good snapshot.
    if (artifact.deliveryState === "revoked") continue;
    if (artifact.deliveryState !== undefined && artifact.deliveryState !== "active") {
      errors.push({
        capabilityId,
        packIds: [...new Set(candidateMembers.map((member) => member.packId))].sort(),
        message: `portable market item ${capabilityId} has an invalid delivery state`,
      });
      continue;
    }
    if (artifact.status !== "published" && artifact.status !== "unlisted") {
      errors.push({
        capabilityId,
        packIds: [...new Set(candidateMembers.map((member) => member.packId))].sort(),
        message: `portable market item ${capabilityId} has an invalid status`,
      });
      continue;
    }

    try {
      const approved = candidateMembers.map((member) => {
        let release: ConfigMarketReleaseRow | undefined;
        if (member.releasePolicy === "track_stable") {
          release = releaseById.get(artifact.currentReleaseId);
        } else if (member.releasePolicy === "pinned" && member.pinnedReleaseId) {
          release = releaseById.get(member.pinnedReleaseId);
        } else {
          throw new Error(`portable pack member ${capabilityId} has no release policy`);
        }
        if (!release) {
          throw new Error(`portable pack member ${capabilityId} has a dangling release`);
        }
        if (release.tenantId !== artifact.tenantId || release.artifactId !== artifact.id) {
          throw new Error(`portable pack member ${capabilityId} release ownership mismatch`);
        }
        const packCapabilities = membersByPack.get(member.packId) ?? new Set<string>();
        for (const dependency of requiredConfigMarketDependencies(release.manifest)) {
          if (!packCapabilities.has(dependency.capabilityId)) {
            throw new Error(
              `portable pack member ${capabilityId} is missing required dependency in the same pack: ${dependency.capabilityId}`,
            );
          }
          const registered = dependencyById.get(dependency.capabilityId);
          if (!registered || registered.status !== "active") {
            throw new Error(
              `portable pack member ${capabilityId} required dependency is missing or disabled: ${dependency.capabilityId}`,
            );
          }
          if (
            dependency.kind === "skill" &&
            (registered.version !== dependency.version ||
              registered.digest?.toLowerCase() !== dependency.digest)
          ) {
            throw new Error(
              `portable pack member ${capabilityId} required Skill version or digest mismatch: ${dependency.capabilityId}`,
            );
          }
          if (dependency.kind === "mcp" && registered.version !== dependency.version) {
            throw new Error(
              `portable pack member ${capabilityId} required MCP version mismatch: ${dependency.capabilityId}`,
            );
          }
        }
        return { member, release };
      });

      let selected: ConfigMarketReleaseRow | undefined;
      const tracking = approved.find(({ member }) => member.releasePolicy === "track_stable");
      if (tracking) {
        selected = tracking.release;
      } else {
        const pinned = approved.map(({ release }) => release);
        // Multiple assigned packs can pin different versions. Deliver the highest approved version,
        // never whichever row the database happened to return first.
        selected = pinned.sort((left, right) => compareConfigShareVersions(right.version, left.version))[0];
      }
      if (!selected) throw new Error(`portable pack member ${capabilityId} has no approved release`);
      packages.push(
        toManagedPortablePackage(mapConfigMarketRow(artifact, selected, { requireCurrent: false })),
      );
    } catch (error) {
      // A malformed or drifted artifact makes the complete desired snapshot
      // uncertain. Keep the diagnostic separate from package contents; the
      // caller below fails closed instead of returning a partial snapshot that
      // could revoke a valid Desktop LKG.
      errors.push({
        capabilityId,
        packIds: [...new Set(candidateMembers.map((member) => member.packId))].sort(),
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  packages.sort((left, right) => left.id.localeCompare(right.id));
  if (packages.length > MAX_MANAGED_PORTABLE_PACKAGES) {
    throw new Error(
      `managed portable package limit exceeded: ${packages.length}/${MAX_MANAGED_PORTABLE_PACKAGES}`,
    );
  }
  return { packages, errors };
}

export function managedPackagesFromCandidates(
  members: readonly ManagedPortableMember[],
  artifacts: readonly ConfigMarketArtifactRow[],
  releases: readonly ConfigMarketReleaseRow[],
  dependencyCapabilities: readonly ManagedDependencyCapability[] = [],
): ManagedPortablePackage[] {
  const resolution = resolveManagedPackagesFromCandidates(
    members,
    artifacts,
    releases,
    dependencyCapabilities,
  );
  if (resolution.errors.length > 0) {
    throw new Error(resolution.errors[0]!.message);
  }
  return resolution.packages;
}

/** Portable packages referenced by active capability packs assigned to this user. */
export async function listManagedPortablePackagesForUser(input: {
  tenantId: string;
  userId: string;
  email?: string;
  deptId?: string | null;
}): Promise<ManagedPortablePackage[]> {
  const t = await dialectCapabilityTables();
  const query = t.db as unknown as DialectQuery;
  const assignmentKeys = await resolveAssignmentKeysForManagedDelivery(
    input.tenantId,
    input.userId,
    input.email,
    input.deptId,
  );

  const packRows = (await query
    .select({ id: t.packs.id })
    .from(t.packs)
    .innerJoin(t.assignments, eq(t.assignments.packId, t.packs.id))
    .where(
      and(
        eq(t.packs.tenantId, input.tenantId),
        eq(t.packs.status, "active"),
        eq(t.assignments.tenantId, input.tenantId),
        inArray(t.assignments.assignmentKey, assignmentKeys),
      ),
    )) as Array<{ id: string }>;
  const packIds = [...new Set(packRows.map((row) => row.id))];
  if (packIds.length === 0) return [];

  const memberRows = (await query
    .select({
      packId: t.members.packId,
      capabilityId: t.members.capabilityId,
      releasePolicy: t.members.releasePolicy,
      pinnedReleaseId: t.members.pinnedReleaseId,
    })
    .from(t.members)
    .where(inArray(t.members.packId, packIds))) as ManagedPortableMember[];
  const candidateCapabilityIds = [...new Set(
    memberRows
      .map((row) => managedPortableCapabilityKey(row.capabilityId))
      .filter((capabilityId): capabilityId is string => capabilityId !== null),
  )];
  const grouped = groupCapabilityIdsByKind(candidateCapabilityIds);
  const itemIds = [...new Set([...grouped.expert, ...grouped.group, ...grouped.skill])];
  if (itemIds.length === 0) return [];

  // Forced delivery is controlled by delivery_state. Market unlisting is an
  // employee visibility change and must not revoke an existing pack member.
  // Query both active and revoked rows: only an explicit revoked row is a
  // normal withdrawal. A missing assigned expert/group row is a failed,
  // unknown snapshot and must not delete Desktop's LKG.
  const artifacts = (await query
    .select()
    .from(t.configMarketItems)
    .where(
      and(
        eq(t.configMarketItems.tenantId, input.tenantId),
        inArray(t.configMarketItems.id, itemIds),
      ),
    )) as ConfigMarketArtifactRow[];

  const artifactByCapability = new Map<string, ConfigMarketArtifactRow>();
  for (const artifact of artifacts) {
    const key = managedPortableCapabilityKey(`${artifact.kind}:${artifact.id}`);
    if (key) artifactByCapability.set(key, artifact);
  }
  const missingAssignedPortable = new Map<string, Set<string>>();
  for (const member of memberRows) {
    const key = managedPortableCapabilityKey(member.capabilityId);
    if (!key) continue;
    const parsed = parseCapabilityId(key);
    if (!parsed) continue;
    // A null release policy identifies a legacy registry Skill. It is not a
    // market item and must not be reported as a missing market row.
    const isPortableMarketMember = parsed.kind !== "skill"
      || (member.releasePolicy !== null && member.releasePolicy !== undefined);
    if (!isPortableMarketMember || artifactByCapability.has(key)) continue;
    const packIds = missingAssignedPortable.get(key) ?? new Set<string>();
    packIds.add(member.packId);
    missingAssignedPortable.set(key, packIds);
  }
  if (missingAssignedPortable.size > 0) {
    const details = [...missingAssignedPortable.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([capabilityId, packIds]) => `${capabilityId} (${[...packIds].sort().join(",")})`)
      .join("; ");
    throw new Error(`assigned portable market item is missing: ${details}`);
  }
  if (artifacts.length === 0) return [];

  const artifactIds = new Set(artifacts.map((artifact) => artifact.id.toUpperCase()));
  const relevantMembers = memberRows.filter((member) => {
    const key = managedPortableCapabilityKey(member.capabilityId);
    const parsed = key ? parseCapabilityId(key) : null;
    return parsed ? artifactIds.has(parsed.rowId) : false;
  });
  const releaseIds = new Set<string>();
  for (const artifact of artifacts) releaseIds.add(artifact.currentReleaseId);
  for (const member of relevantMembers) {
    if (member.pinnedReleaseId) releaseIds.add(member.pinnedReleaseId);
  }
  const releases = (await query
    .select()
    .from(t.configMarketReleases)
    .where(
      and(
        eq(t.configMarketReleases.tenantId, input.tenantId),
        inArray(t.configMarketReleases.id, [...releaseIds]),
      ),
    )) as ConfigMarketReleaseRow[];

  const required = releases.flatMap((release) => {
    try {
      return requiredConfigMarketDependencies(release.manifest);
    } catch (error) {
      // The artifact-level resolver below records this release as invalid. Do not let one bad
      // manifest prevent us from looking up dependencies for every other assigned artifact.
      console.error(
        "[desktop/bootstrap] managed portable release dependency scan failed:",
        release.id,
        error,
      );
      return [];
    }
  });
  const requiredSkillIds = [...new Set(required.filter((item) => item.kind === "skill").map((item) => item.capabilityId.slice("skill:".length)))];
  const requiredMcpIds = [...new Set(required.filter((item) => item.kind === "mcp").map((item) => item.capabilityId.slice("mcp:".length)))];
  const dependencyCapabilities: ManagedDependencyCapability[] = [];
  if (requiredSkillIds.length > 0) {
    const rows = (await query
      .select({ id: t.skills.id, status: t.skills.status, version: t.skills.version, digest: t.skills.bundleDigest })
      .from(t.skills)
      .where(and(eq(t.skills.tenantId, input.tenantId), inArray(t.skills.id, requiredSkillIds)))) as Array<{
        id: string;
        status: string;
        version: string;
        digest: string | null;
      }>;
    dependencyCapabilities.push(...rows.map((row) => ({
      capabilityId: formatCapabilityId("skill", row.id),
      status: row.status,
      version: row.version,
      digest: row.digest,
    })));
  }
  if (requiredMcpIds.length > 0) {
    const rows = (await query
      .select({ id: t.mcp.id, status: t.mcp.status, version: t.mcp.version })
      .from(t.mcp)
      .where(and(eq(t.mcp.tenantId, input.tenantId), inArray(t.mcp.id, requiredMcpIds)))) as Array<{
        id: string;
        status: string;
        version: string;
      }>;
    dependencyCapabilities.push(...rows.map((row) => ({
      capabilityId: formatCapabilityId("mcp", row.id),
      status: row.status,
      version: row.version,
      digest: null,
    })));
  }
  // Keep every assigned member here: portable members select releases, while Skill/MCP members
  // prove that each required dependency is explicitly present in the same pack. Resolution errors
  // are handled as a whole below; a partial result must never become authoritative.
  const resolution = resolveManagedPackagesFromCandidates(
    memberRows,
    artifacts,
    releases,
    dependencyCapabilities,
  );
  for (const diagnostic of resolution.errors) {
    console.error(
      "[desktop/bootstrap] managed portable package resolution failed:",
      diagnostic.capabilityId,
      diagnostic.message,
      { packIds: diagnostic.packIds },
    );
  }
  if (resolution.errors.length > 0) {
    // Never publish a partial authoritative snapshot. The bootstrap route
    // catches this rejection and omits `managedPortablePackages`, allowing the
    // Desktop client to retain its last-known-good managed installation. An
    // actual successful empty resolution still returns [] and therefore means
    // an explicit revoke of all managed portable packages.
    throw new Error(resolution.errors[0]!.message);
  }
  return resolution.packages;
}
