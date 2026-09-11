/**
 * admin-console · 企业能力包持久化（MySQL）
 *
 * 能力一律以稳定类型前缀 + ULID 引用，构造与校验走 @agenticx/config
 * 的 capability-id，避免各处手拼出第二种写法。
 */

import {
  enterpriseCapabilityAssignments,
  enterpriseCapabilityPackMembers,
  enterpriseCapabilityPacks,
  enterpriseCapabilityShelfOrder,
  enterpriseConfigMarketItems,
  enterpriseConfigMarketReleases,
  enterpriseSkills,
  mcpServers,
  tenants,
} from "@agenticx/db-schema/mysql";
import {
  canonicalizeCapabilityId,
  formatCapabilityId,
  isBuiltinExpertCapabilityId,
  isKnownEnterpriseActionCapabilityId,
  MAX_MANAGED_PORTABLE_PACKAGES,
  parseCapabilityId,
} from "@agenticx/config";
import { getAdminMysqlDb } from "./database";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { ulid } from "ulid";
import {
  CapabilityPackVersionConflictError,
  capabilityPackVersion,
  nextCapabilityPackUpdatedAt,
} from "../../capability-pack-concurrency";
import {
  assertPortableDependencyRegistryMatches,
  assertPortablePackRequiredDependencies,
  requiredDependenciesForPortableReleases,
  type PortableDependencyRegistryRow,
} from "../../portable-pack-dependencies";

export type CapabilityStatus = "active" | "disabled";

export interface SkillRecord {
  id: string;
  tenantId: string;
  slug: string;
  displayName: string;
  description: string;
  version: string;
  bundleUri: string;
  bundleDigest: string;
  requiredCapabilities: string[];
  status: CapabilityStatus;
  /**
   * 安全扫描结论。null 表示从未扫过——手工登记的技能就是这个状态。
   * 货架上必须和「扫过且判定安全」分开显示，否则「没查过」会被看成「查过没问题」。
   */
  scanVerdict: string | null;
  scanSource: string | null;
  scannedAt: string | null;
  scannedBy: string | null;
  scanFindings: unknown[];
  createdAt: string;
  updatedAt: string;
}

export interface CapabilityPackRecord {
  id: string;
  tenantId: string;
  slug: string;
  displayName: string;
  description: string;
  status: CapabilityStatus;
  metadata: Record<string, unknown>;
  /** MCP/Skill/platform feature/expert/group stable capability ids. */
  capabilityIds: string[];
  portableReleasePolicies: Record<
    string,
    { mode: "pinned" | "track_stable"; pinnedReleaseId: string | null }
  >;
  /** `all` / `dept:<id>` / 用户 ulid */
  assignmentKeys: string[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateSkillInput {
  slug: string;
  displayName?: string;
  description?: string;
  version?: string;
  bundleUri?: string;
  bundleDigest?: string;
  requiredCapabilities?: string[];
  status?: CapabilityStatus;
}

export interface UpdateSkillInput {
  displayName?: string;
  description?: string;
  version?: string;
  bundleUri?: string;
  bundleDigest?: string;
  requiredCapabilities?: string[];
  status?: CapabilityStatus;
}

export interface CreateCapabilityPackInput {
  slug: string;
  displayName?: string;
  description?: string;
  status?: CapabilityStatus;
  metadata?: Record<string, unknown>;
  capabilityIds?: string[];
  portableReleasePolicies?: Record<string, { mode: "pinned" | "track_stable"; pinnedReleaseId?: string | null }>;
  assignmentKeys?: string[];
}

export interface UpdateCapabilityPackInput {
  expectedUpdatedAt: string;
  displayName?: string;
  description?: string;
  status?: CapabilityStatus;
  metadata?: Record<string, unknown>;
  capabilityIds?: string[];
  portableReleasePolicies?: Record<string, { mode: "pinned" | "track_stable"; pinnedReleaseId?: string | null }>;
  assignmentKeys?: string[];
}

function requireTenantId(tenantId: string): string {
  const normalized = String(tenantId ?? "").trim();
  if (!normalized) throw new Error("tenantId is required for capability pack persistence.");
  return normalized;
}

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

async function lockTenantCapabilityDelivery(tx: any, tenantId: string): Promise<void> {
  await tx.execute(
    sql`select ${tenants.id} from ${tenants} where ${tenants.id} = ${tenantId} for update`,
  );
}

async function assertManagedPortableDeliveryLimitInTransaction(
  tx: any,
  tenantId: string,
): Promise<void> {
  const memberRows = (await tx
    .select({ capabilityId: enterpriseCapabilityPackMembers.capabilityId })
    .from(enterpriseCapabilityPacks)
    .innerJoin(
      enterpriseCapabilityPackMembers,
      eq(enterpriseCapabilityPackMembers.packId, enterpriseCapabilityPacks.id),
    )
    .where(
      and(
        eq(enterpriseCapabilityPacks.tenantId, tenantId),
        eq(enterpriseCapabilityPacks.status, "active"),
      ),
    )) as Array<{ capabilityId: string }>;
  const marketRows = (await tx
    .select({
      id: enterpriseConfigMarketItems.id,
      kind: enterpriseConfigMarketItems.kind,
      status: enterpriseConfigMarketItems.status,
      deliveryState: enterpriseConfigMarketItems.deliveryState,
    })
    .from(enterpriseConfigMarketItems)
    .where(
      and(
        eq(enterpriseConfigMarketItems.tenantId, tenantId),
      ),
    )) as Array<{ id: string; kind: string; status: string; deliveryState?: string | null }>;
  const activeMarket = new Set(
    marketRows
      .filter((row) =>
        (row.kind === "expert" || row.kind === "group" || row.kind === "skill") &&
        (row.status === "published" || row.status === "unlisted") &&
        (row.deliveryState ?? "active") === "active",
      )
      .map((row) => `${row.kind}:${row.id.toUpperCase()}`),
  );
  const desired = new Set<string>();
  for (const row of memberRows) {
    const canonical = canonicalizeCapabilityId(row.capabilityId);
    const parsed = canonical ? parseCapabilityId(canonical) : null;
    if (
      canonical &&
      (parsed?.kind === "expert" || parsed?.kind === "group" || parsed?.kind === "skill") &&
      !isBuiltinExpertCapabilityId(canonical) &&
      activeMarket.has(canonical)
    ) {
      desired.add(canonical);
    }
  }
  if (desired.size > MAX_MANAGED_PORTABLE_PACKAGES) {
    throw new Error(
      `managed portable package limit exceeded: ${desired.size}/${MAX_MANAGED_PORTABLE_PACKAGES}`,
    );
  }
}

/** 非法能力 id 直接拒绝而不是静默丢弃——静默丢弃会让管理员以为已经加进去了。 */
export function assertCapabilityIds(ids: readonly string[]): string[] {
  const cleaned: string[] = [];
  for (const raw of ids) {
    const id = String(raw ?? "").trim();
    if (!id) continue;
    const canonical = canonicalizeCapabilityId(id);
    if (!canonical) throw new Error(`invalid capability id: ${id}`);
    const parsed = parseCapabilityId(canonical);
    if (parsed?.kind === "action" && !isKnownEnterpriseActionCapabilityId(canonical)) {
      throw new Error(`unknown enterprise action capability: ${id}`);
    }
    if (!cleaned.includes(canonical)) cleaned.push(canonical);
  }
  return cleaned;
}

/** 分配键：`all`、`dept:<id>`，或用户 ulid。 */
export function normalizeAssignmentKeys(keys: readonly string[]): string[] {
  const cleaned: string[] = [];
  for (const raw of keys) {
    const key = String(raw ?? "").trim();
    if (!key) continue;
    if (!cleaned.includes(key)) cleaned.push(key);
  }
  return cleaned;
}

function rowToSkill(row: typeof enterpriseSkills.$inferSelect): SkillRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    slug: row.slug,
    displayName: row.displayName ?? "",
    description: row.description ?? "",
    version: row.version,
    bundleUri: row.bundleUri ?? "",
    bundleDigest: row.bundleDigest ?? "",
    requiredCapabilities: Array.isArray(row.requiredCapabilities)
      ? assertCapabilityIds(row.requiredCapabilities.map(String))
      : [],
    status: (row.status as CapabilityStatus) || "active",
    scanVerdict: row.scanVerdict ?? null,
    scanSource: row.scanSource ?? null,
    scannedAt: row.scannedAt ?? null,
    scannedBy: row.scannedBy ?? null,
    scanFindings: Array.isArray(row.scanFindings) ? row.scanFindings : [],
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

export async function listSkills(tenantIdInput: string): Promise<SkillRecord[]> {
  const db = getAdminMysqlDb();
  const tenantId = requireTenantId(tenantIdInput);
  const rows = await db
    .select()
    .from(enterpriseSkills)
    .where(eq(enterpriseSkills.tenantId, tenantId))
    .orderBy(desc(enterpriseSkills.updatedAt));
  return rows.map(rowToSkill);
}

export async function getSkill(tenantIdInput: string, id: string): Promise<SkillRecord | null> {
  const db = getAdminMysqlDb();
  const tenantId = requireTenantId(tenantIdInput);
  const rows = await db
    .select()
    .from(enterpriseSkills)
    .where(and(eq(enterpriseSkills.tenantId, tenantId), eq(enterpriseSkills.id, id)))
    .limit(1);
  return rows[0] ? rowToSkill(rows[0]) : null;
}

export async function createSkill(
  tenantIdInput: string,
  input: CreateSkillInput,
): Promise<SkillRecord> {
  const db = getAdminMysqlDb();
  const tenantId = requireTenantId(tenantIdInput);
  const slug = input.slug.trim();
  if (!slug) throw new Error("slug is required");
  const id = ulid();
  const now = new Date();
  await db.insert(enterpriseSkills).values({
    id,
    tenantId,
    slug,
    displayName: input.displayName?.trim() || slug,
    description: input.description ?? "",
    version: input.version?.trim() || "0.0.0",
    bundleUri: input.bundleUri ?? "",
    bundleDigest: input.bundleDigest ?? "",
    requiredCapabilities: assertCapabilityIds(input.requiredCapabilities ?? []),
    status: input.status ?? "active",
    createdAt: now,
    updatedAt: now,
  });
  const created = await getSkill(tenantId, id);
  if (!created) throw new Error("create failed");
  return created;
}

export type SkillScanResult = {
  verdict: string;
  source: string;
  findings: unknown[];
  scannedBy: string;
};

type StoredSkillScanIdentity = Pick<
  typeof enterpriseSkills.$inferSelect,
  "version" | "bundleUri" | "bundleDigest" | "requiredCapabilities"
>;

function capabilitySetKey(value: readonly unknown[] | null | undefined): string {
  const ids = Array.isArray(value) ? assertCapabilityIds(value.map(String)) : [];
  return [...new Set(ids)].sort().join("\u0000");
}

function hasSkillScanIdentityChange(
  input: UpdateSkillInput,
  existing: StoredSkillScanIdentity,
  requiredCapabilities: string[] | undefined,
): boolean {
  return (
    (input.version !== undefined && input.version !== existing.version) ||
    (input.bundleUri !== undefined && input.bundleUri !== (existing.bundleUri ?? "")) ||
    (input.bundleDigest !== undefined && input.bundleDigest !== (existing.bundleDigest ?? "")) ||
    (requiredCapabilities !== undefined &&
      capabilitySetKey(requiredCapabilities) !== capabilitySetKey(existing.requiredCapabilities))
  );
}

/**
 * 写入一次扫描的结论。
 *
 * 单独一个函数而不是并进 updateSkill：扫描结论不是管理员随手能改的字段，它记录的是
 * 「某次扫描实际扫出了什么」。混进通用 PATCH 里，等于允许把 dangerous 手动改成 safe，
 * 而这一页上点一下就发给全公司了。
 */
export async function recordSkillScan(
  tenantIdInput: string,
  id: string,
  result: SkillScanResult,
): Promise<SkillRecord> {
  const db = getAdminMysqlDb();
  const tenantId = requireTenantId(tenantIdInput);
  await db
    .update(enterpriseSkills)
    .set({
      scanVerdict: result.verdict,
      scanSource: result.source,
      scanFindings: result.findings,
      scannedBy: result.scannedBy,
      scannedAt: new Date().toISOString(),
      updatedAt: new Date(),
    })
    .where(and(eq(enterpriseSkills.tenantId, tenantId), eq(enterpriseSkills.id, id)));
  const updated = await getSkill(tenantId, id);
  if (!updated) throw new Error("skill not found");
  return updated;
}

export async function updateSkill(
  tenantIdInput: string,
  id: string,
  input: UpdateSkillInput,
): Promise<SkillRecord> {
  const db = getAdminMysqlDb();
  const tenantId = requireTenantId(tenantIdInput);
  const requiredCapabilities =
    input.requiredCapabilities === undefined
      ? undefined
      : assertCapabilityIds(input.requiredCapabilities);
  const patch: Partial<typeof enterpriseSkills.$inferInsert> = { updatedAt: new Date() };
  if (input.displayName !== undefined) patch.displayName = input.displayName;
  if (input.description !== undefined) patch.description = input.description;
  if (input.version !== undefined) patch.version = input.version;
  if (input.bundleUri !== undefined) patch.bundleUri = input.bundleUri;
  if (input.bundleDigest !== undefined) patch.bundleDigest = input.bundleDigest;
  if (requiredCapabilities !== undefined) patch.requiredCapabilities = requiredCapabilities;
  if (input.status !== undefined) patch.status = input.status;

  const hasScanIdentityInput =
    input.version !== undefined ||
    input.bundleUri !== undefined ||
    input.bundleDigest !== undefined ||
    requiredCapabilities !== undefined;

  if (!hasScanIdentityInput) {
    await db
      .update(enterpriseSkills)
      .set(patch)
      .where(and(eq(enterpriseSkills.tenantId, tenantId), eq(enterpriseSkills.id, id)));
  } else {
    await db.transaction(async (tx) => {
      const existing = await tx
        .select({
          version: enterpriseSkills.version,
          bundleUri: enterpriseSkills.bundleUri,
          bundleDigest: enterpriseSkills.bundleDigest,
          requiredCapabilities: enterpriseSkills.requiredCapabilities,
        })
        .from(enterpriseSkills)
        .where(and(eq(enterpriseSkills.tenantId, tenantId), eq(enterpriseSkills.id, id)))
        .for("update")
        .limit(1);
      if (!existing[0]) throw new Error("skill not found");

      const updatePatch: Partial<typeof enterpriseSkills.$inferInsert> = { ...patch };
      if (hasSkillScanIdentityChange(input, existing[0], requiredCapabilities)) {
        // Scan conclusions describe the exact bundle and dependency set; never carry them
        // over to a different identity. Keep the reset in this same UPDATE as the content
        // change so readers cannot observe a new bundle with an old verdict.
        updatePatch.scanVerdict = null;
        updatePatch.scanFindings = [];
        updatePatch.scannedAt = null;
        updatePatch.scanSource = null;
        updatePatch.scannedBy = null;
      }

      await tx
        .update(enterpriseSkills)
        .set(updatePatch)
        .where(and(eq(enterpriseSkills.tenantId, tenantId), eq(enterpriseSkills.id, id)));
    });
  }
  const updated = await getSkill(tenantId, id);
  if (!updated) throw new Error("skill not found");
  return updated;
}

export async function deleteSkill(tenantIdInput: string, id: string): Promise<boolean> {
  const db = getAdminMysqlDb();
  const tenantId = requireTenantId(tenantIdInput);
  const deleted = await db
    .delete(enterpriseSkills)
    .where(and(eq(enterpriseSkills.tenantId, tenantId), eq(enterpriseSkills.id, id)));
  return deleted[0].affectedRows > 0;
}

type PortablePolicyInput = {
  mode: "pinned" | "track_stable";
  pinnedReleaseId?: string | null;
};
type PersistedMember = {
  capabilityId: string;
  releasePolicy: "pinned" | "track_stable" | null;
  pinnedReleaseId: string | null;
};

function normalizePortablePolicies(
  value: Record<string, PortablePolicyInput> | undefined,
): Map<string, PortablePolicyInput> {
  const result = new Map<string, PortablePolicyInput>();
  for (const [rawId, policy] of Object.entries(value ?? {})) {
    const id = canonicalizeCapabilityId(rawId);
    const parsed = id ? parseCapabilityId(id) : null;
    if (!id || (parsed?.kind !== "expert" && parsed?.kind !== "group" && parsed?.kind !== "skill") || isBuiltinExpertCapabilityId(id)) {
      throw new Error(`portable release policy has invalid capability id: ${rawId}`);
    }
    if (!policy || (policy.mode !== "pinned" && policy.mode !== "track_stable")) {
      throw new Error(`portable release policy is invalid: ${rawId}`);
    }
    if (policy.pinnedReleaseId != null && !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(policy.pinnedReleaseId)) {
      throw new Error(`portable pinned release id is invalid: ${rawId}`);
    }
    result.set(id, policy);
  }
  return result;
}

async function materializePackMembers(
  tx: any,
  tenantId: string,
  capabilityIds: string[],
  requestedInput: Record<string, PortablePolicyInput> | undefined,
  existingRows: PersistedMember[] = [],
): Promise<Array<{
  capabilityId: string;
  releasePolicy: "pinned" | "track_stable" | null;
  pinnedReleaseId: string | null;
}>> {
  const requested = normalizePortablePolicies(requestedInput);
  const selected = new Set(capabilityIds);
  for (const id of requested.keys()) {
    if (!selected.has(id)) throw new Error(`portable release policy targets a non-member: ${id}`);
  }
  const candidateEntries = capabilityIds
    .map((capabilityId) => ({ capabilityId, parsed: parseCapabilityId(capabilityId) }))
    .filter((entry) =>
      (entry.parsed?.kind === "expert" || entry.parsed?.kind === "group" || entry.parsed?.kind === "skill") &&
      !isBuiltinExpertCapabilityId(entry.capabilityId),
    );
  const portableIds = candidateEntries.map((entry) => entry.parsed!.rowId);
  const artifactRows = portableIds.length
    ? await tx
        .select({
          id: enterpriseConfigMarketItems.id,
          kind: enterpriseConfigMarketItems.kind,
          currentReleaseId: enterpriseConfigMarketItems.currentReleaseId,
          status: enterpriseConfigMarketItems.status,
          deliveryState: enterpriseConfigMarketItems.deliveryState,
        })
        .from(enterpriseConfigMarketItems)
        .where(
          and(
            eq(enterpriseConfigMarketItems.tenantId, tenantId),
            inArray(enterpriseConfigMarketItems.id, portableIds),
          ),
        )
    : [];
  const artifacts = new Map<
    string,
    { id: string; kind: string; currentReleaseId: string; status: string; deliveryState?: string | null }
  >(artifactRows.map((row: any) => [row.id, row]));
  const existing = new Map(existingRows.map((row) => [row.capabilityId, row] as const));
  for (const id of requested.keys()) {
    const parsed = parseCapabilityId(id);
    if (parsed?.kind === "skill" && artifacts.get(parsed.rowId)?.kind !== "skill") {
      throw new Error(`portable release policy targets a legacy enterprise Skill: ${id}`);
    }
  }
  // `skill:<id>` is ambiguous by design: resolve it against the market first;
  // only a missing market Skill falls back to the legacy enterprise_skills row.
  const portable = candidateEntries.filter((entry) => {
    if (entry.parsed?.kind === "expert" || entry.parsed?.kind === "group") return true;
    return entry.parsed?.kind === "skill" && artifacts.get(entry.parsed.rowId)?.kind === "skill";
  });
  if (portable.length > 0) {
    const shelfRows = await tx
      .select({ capabilityId: enterpriseCapabilityShelfOrder.capabilityId })
      .from(enterpriseCapabilityShelfOrder)
      .where(
        and(
          eq(enterpriseCapabilityShelfOrder.tenantId, tenantId),
          inArray(
            enterpriseCapabilityShelfOrder.capabilityId,
            portable.map((entry) => entry.capabilityId),
          ),
        ),
      );
    const onShelf = new Set(
      (shelfRows as Array<{ capabilityId: string }>).map((row) => row.capabilityId),
    );
    const missing = portable
      .map((entry) => entry.capabilityId)
      .filter((capabilityId) => !existing.has(capabilityId) && !onShelf.has(capabilityId));
    if (missing.length > 0) {
      throw new Error(`portable capability is not in the capability shelf: ${missing.join(", ")}`);
    }
  }
  const memberRows: Array<{
    capabilityId: string;
    releasePolicy: "pinned" | "track_stable" | null;
    pinnedReleaseId: string | null;
  }> = [];
  const releasesToValidate: Array<{ capabilityId: string; artifactId: string; releaseId: string }> = [];

  for (const capabilityId of capabilityIds) {
    const parsed = parseCapabilityId(capabilityId);
    const artifact = parsed ? artifacts.get(parsed.rowId) : undefined;
    const isMarketPortable =
      (parsed?.kind === "expert" && !isBuiltinExpertCapabilityId(capabilityId)) ||
      parsed?.kind === "group"
        ? true
        : parsed?.kind === "skill" && artifact?.kind === "skill";
    if (!isMarketPortable) {
      // A `skill:<id>` that did not resolve to a market item is the legacy
      // enterprise_skills capability and must not inherit portable semantics.
      memberRows.push({ capabilityId, releasePolicy: null, pinnedReleaseId: null });
      continue;
    }
    if (!artifact || artifact.kind !== parsed!.kind) {
      throw new Error(`portable capability is missing, unlisted, or belongs to another tenant: ${capabilityId}`);
    }
    const previous = existing.get(capabilityId);
    // Newly added members must be both listed and live. Existing members retain
    // their persisted delivery relationship while an admin unlists/revokes the
    // market entry; the portal kill-switch still stops delivery immediately.
    if (
      (!previous && (artifact.status !== "published" || (artifact.deliveryState ?? "active") !== "active")) ||
      (previous && artifact.status !== "published" && artifact.status !== "unlisted")
    ) {
      throw new Error(`portable capability is missing, unlisted, or belongs to another tenant: ${capabilityId}`);
    }
    const requestedPolicy = requested.get(capabilityId);
    const mode = requestedPolicy?.mode ?? previous?.releasePolicy ?? "pinned";
    if (mode === "track_stable") {
      memberRows.push({ capabilityId, releasePolicy: "track_stable", pinnedReleaseId: null });
      releasesToValidate.push({
        capabilityId,
        artifactId: artifact.id,
        releaseId: artifact.currentReleaseId,
      });
      continue;
    }
    const pinnedReleaseId =
      requestedPolicy?.pinnedReleaseId ??
      (previous?.releasePolicy === "pinned" ? previous.pinnedReleaseId : null) ??
      artifact.currentReleaseId;
    if (!pinnedReleaseId) throw new Error(`portable capability has no current release: ${capabilityId}`);
    memberRows.push({ capabilityId, releasePolicy: "pinned", pinnedReleaseId });
    releasesToValidate.push({ capabilityId, artifactId: artifact.id, releaseId: pinnedReleaseId });
  }

  if (releasesToValidate.length > 0) {
    const releases = await tx
      .select({
        id: enterpriseConfigMarketReleases.id,
        artifactId: enterpriseConfigMarketReleases.artifactId,
        manifest: enterpriseConfigMarketReleases.manifest,
      })
      .from(enterpriseConfigMarketReleases)
      .where(
        and(
          eq(enterpriseConfigMarketReleases.tenantId, tenantId),
          inArray(enterpriseConfigMarketReleases.id, releasesToValidate.map((entry) => entry.releaseId)),
        ),
      );
    const releasesById = new Map<string, { artifactId: string; manifest: unknown }>(
      releases.map((row: any) => [row.id, { artifactId: row.artifactId, manifest: row.manifest }] as const),
    );
    for (const entry of releasesToValidate) {
      if (releasesById.get(entry.releaseId)?.artifactId !== entry.artifactId) {
        throw new Error(`release does not belong to portable capability: ${entry.capabilityId}`);
      }
    }
    const portableReleases = releasesToValidate.map((entry) => ({
        capabilityId: entry.capabilityId,
        manifest: releasesById.get(entry.releaseId)!.manifest,
      }));
    assertPortablePackRequiredDependencies(capabilityIds, portableReleases);
    const required = requiredDependenciesForPortableReleases(portableReleases);
    const skillIds = [...new Set(required.filter((item) => item.kind === "skill").map((item) => parseCapabilityId(item.capabilityId)!.rowId))];
    const mcpIds = [...new Set(required.filter((item) => item.kind === "mcp").map((item) => parseCapabilityId(item.capabilityId)!.rowId))];
    const registry: PortableDependencyRegistryRow[] = [];
    if (skillIds.length > 0) {
      const rows = await tx
        .select({
          id: enterpriseSkills.id,
          status: enterpriseSkills.status,
          version: enterpriseSkills.version,
          digest: enterpriseSkills.bundleDigest,
        })
        .from(enterpriseSkills)
        .where(and(eq(enterpriseSkills.tenantId, tenantId), inArray(enterpriseSkills.id, skillIds)));
      registry.push(...rows.map((row: any) => ({
        capabilityId: formatCapabilityId("skill", row.id),
        status: row.status,
        version: row.version,
        digest: row.digest,
      })));
    }
    if (mcpIds.length > 0) {
      const rows = await tx
        .select({ id: mcpServers.id, status: mcpServers.status, version: mcpServers.version })
        .from(mcpServers)
        .where(and(eq(mcpServers.tenantId, tenantId), inArray(mcpServers.id, mcpIds)));
      registry.push(...rows.map((row: any) => ({
        capabilityId: formatCapabilityId("mcp", row.id),
        status: row.status,
        version: row.version,
        digest: null,
      })));
    }
    assertPortableDependencyRegistryMatches(required, registry);
  }
  return memberRows;
}

async function loadPackRelations(tenantIdInput: string, packIds: readonly string[]): Promise<{
  members: Map<string, string[]>;
  portablePolicies: Map<string, CapabilityPackRecord["portableReleasePolicies"]>;
  assignments: Map<string, string[]>;
}> {
  const members = new Map<string, string[]>();
  const portablePolicies = new Map<string, CapabilityPackRecord["portableReleasePolicies"]>();
  const assignments = new Map<string, string[]>();
  if (packIds.length === 0) return { members, portablePolicies, assignments };
  const db = getAdminMysqlDb();
  const tenantId = requireTenantId(tenantIdInput);

  const memberRows = await db
    .select()
    .from(enterpriseCapabilityPackMembers)
    .where(inArray(enterpriseCapabilityPackMembers.packId, [...packIds]));
  for (const row of memberRows) {
    const list = members.get(row.packId) ?? [];
    const capabilityId = canonicalizeCapabilityId(row.capabilityId);
    if (!capabilityId) {
      throw new Error(`invalid persisted capability id: ${row.capabilityId}`);
    }
    if (!list.includes(capabilityId)) list.push(capabilityId);
    members.set(row.packId, list);
    if (row.releasePolicy === "pinned" || row.releasePolicy === "track_stable") {
      const policies = portablePolicies.get(row.packId) ?? {};
      policies[capabilityId] = {
        mode: row.releasePolicy,
        pinnedReleaseId: row.pinnedReleaseId ?? null,
      };
      portablePolicies.set(row.packId, policies);
    }
  }

  const assignmentRows = await db
    .select()
    .from(enterpriseCapabilityAssignments)
    .where(
      and(
        eq(enterpriseCapabilityAssignments.tenantId, tenantId),
        inArray(enterpriseCapabilityAssignments.packId, [...packIds])
      )
    );
  for (const row of assignmentRows) {
    const list = assignments.get(row.packId) ?? [];
    list.push(row.assignmentKey);
    assignments.set(row.packId, list);
  }
  return { members, portablePolicies, assignments };
}

function rowToPack(
  row: typeof enterpriseCapabilityPacks.$inferSelect,
  capabilityIds: string[],
  portableReleasePolicies: CapabilityPackRecord["portableReleasePolicies"],
  assignmentKeys: string[]
): CapabilityPackRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    slug: row.slug,
    displayName: row.displayName ?? "",
    description: row.description ?? "",
    status: (row.status as CapabilityStatus) || "active",
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    capabilityIds,
    portableReleasePolicies,
    assignmentKeys,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

export async function listCapabilityPacks(
  tenantIdInput: string,
): Promise<CapabilityPackRecord[]> {
  const db = getAdminMysqlDb();
  const tenantId = requireTenantId(tenantIdInput);
  const rows = await db
    .select()
    .from(enterpriseCapabilityPacks)
    .where(eq(enterpriseCapabilityPacks.tenantId, tenantId))
    .orderBy(desc(enterpriseCapabilityPacks.updatedAt));
  const { members, portablePolicies, assignments } = await loadPackRelations(
    tenantId,
    rows.map((r) => r.id),
  );
  return rows.map((row) =>
    rowToPack(
      row,
      (members.get(row.id) ?? []).sort(),
      portablePolicies.get(row.id) ?? {},
      (assignments.get(row.id) ?? []).sort(),
    )
  );
}

export async function getCapabilityPack(
  tenantIdInput: string,
  id: string,
): Promise<CapabilityPackRecord | null> {
  const db = getAdminMysqlDb();
  const tenantId = requireTenantId(tenantIdInput);
  const rows = await db
    .select()
    .from(enterpriseCapabilityPacks)
    .where(and(eq(enterpriseCapabilityPacks.tenantId, tenantId), eq(enterpriseCapabilityPacks.id, id)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const { members, portablePolicies, assignments } = await loadPackRelations(tenantId, [row.id]);
  return rowToPack(
    row,
    (members.get(row.id) ?? []).sort(),
    portablePolicies.get(row.id) ?? {},
    (assignments.get(row.id) ?? []).sort(),
  );
}

export async function createCapabilityPack(
  tenantIdInput: string,
  input: CreateCapabilityPackInput,
): Promise<CapabilityPackRecord> {
  const db = getAdminMysqlDb();
  const tenantId = requireTenantId(tenantIdInput);
  const slug = input.slug.trim();
  if (!slug) throw new Error("slug is required");
  const capabilityIds = assertCapabilityIds(input.capabilityIds ?? []);
  const assignmentKeys = normalizeAssignmentKeys(input.assignmentKeys ?? []);
  const id = ulid();
  const now = new Date();
  await db.transaction(async (tx) => {
    await lockTenantCapabilityDelivery(tx, tenantId);
    const memberRows = await materializePackMembers(
      tx,
      tenantId,
      capabilityIds,
      input.portableReleasePolicies,
    );
    await tx.insert(enterpriseCapabilityPacks).values({
      id,
      tenantId,
      slug,
      displayName: input.displayName?.trim() || slug,
      description: input.description ?? "",
      status: input.status ?? "active",
      metadata: input.metadata ?? {},
      createdAt: now,
      updatedAt: now,
    });
    if (memberRows.length > 0) {
      await tx.insert(enterpriseCapabilityPackMembers).values(
        memberRows.map((member) => ({
          packId: id,
          ...member,
          createdAt: now,
          updatedAt: now,
        })),
      );
    }
    if (assignmentKeys.length > 0) {
      await tx.insert(enterpriseCapabilityAssignments).values(
        assignmentKeys.map((assignmentKey) => ({
          tenantId,
          packId: id,
          assignmentKey,
          createdAt: now,
          updatedAt: now,
        })),
      );
    }
    await assertManagedPortableDeliveryLimitInTransaction(tx, tenantId);
  });
  const created = await getCapabilityPack(tenantId, id);
  if (!created) throw new Error("create failed");
  return created;
}

export async function updateCapabilityPack(
  tenantIdInput: string,
  id: string,
  input: UpdateCapabilityPackInput,
): Promise<CapabilityPackRecord> {
  const db = getAdminMysqlDb();
  const tenantId = requireTenantId(tenantIdInput);
  const capabilityIds =
    input.capabilityIds === undefined ? undefined : assertCapabilityIds(input.capabilityIds);
  const assignmentKeys =
    input.assignmentKeys === undefined
      ? undefined
      : normalizeAssignmentKeys(input.assignmentKeys);
  const expectedUpdatedAt = capabilityPackVersion(input.expectedUpdatedAt);
  const portableReleasePolicies = input.portableReleasePolicies;

  const patch: Partial<typeof enterpriseCapabilityPacks.$inferInsert> = {};
  if (input.displayName !== undefined) patch.displayName = input.displayName;
  if (input.description !== undefined) patch.description = input.description;
  if (input.status !== undefined) patch.status = input.status;
  if (input.metadata !== undefined) patch.metadata = input.metadata;
  await db.transaction(async (tx) => {
    await lockTenantCapabilityDelivery(tx, tenantId);
    const existing = await tx
      .select({
        id: enterpriseCapabilityPacks.id,
        updatedAt: enterpriseCapabilityPacks.updatedAt,
      })
      .from(enterpriseCapabilityPacks)
      .where(
        and(
          eq(enterpriseCapabilityPacks.tenantId, tenantId),
          eq(enterpriseCapabilityPacks.id, id),
        ),
      )
      .for("update")
      .limit(1);
    if (!existing[0]) throw new Error("pack not found");
    const actualUpdatedAt = existing[0].updatedAt;
    if (actualUpdatedAt.getTime() !== expectedUpdatedAt.getTime()) {
      throw new CapabilityPackVersionConflictError(
        expectedUpdatedAt.toISOString(),
        actualUpdatedAt.toISOString(),
      );
    }

    await tx
      .update(enterpriseCapabilityPacks)
      .set({
        ...patch,
        updatedAt: nextCapabilityPackUpdatedAt(actualUpdatedAt),
      })
      .where(
        and(
          eq(enterpriseCapabilityPacks.tenantId, tenantId),
          eq(enterpriseCapabilityPacks.id, id),
        ),
      );

    if (capabilityIds !== undefined || portableReleasePolicies !== undefined) {
      const existingMembers = (await tx
        .select({
          capabilityId: enterpriseCapabilityPackMembers.capabilityId,
          releasePolicy: enterpriseCapabilityPackMembers.releasePolicy,
          pinnedReleaseId: enterpriseCapabilityPackMembers.pinnedReleaseId,
        })
        .from(enterpriseCapabilityPackMembers)
        .where(eq(enterpriseCapabilityPackMembers.packId, id))) as PersistedMember[];
      const selectedIds = capabilityIds ?? assertCapabilityIds(existingMembers.map((row) => row.capabilityId));
      const memberRows = await materializePackMembers(
        tx,
        tenantId,
        selectedIds,
        portableReleasePolicies,
        existingMembers,
      );
      await tx
        .delete(enterpriseCapabilityPackMembers)
        .where(eq(enterpriseCapabilityPackMembers.packId, id));
      if (memberRows.length > 0) {
        const now = new Date();
        await tx.insert(enterpriseCapabilityPackMembers).values(
          memberRows.map((member) => ({
            packId: id,
            ...member,
            createdAt: now,
            updatedAt: now,
          })),
        );
      }
    }
    if (assignmentKeys !== undefined) {
      await tx
        .delete(enterpriseCapabilityAssignments)
        .where(
          and(
            eq(enterpriseCapabilityAssignments.tenantId, tenantId),
            eq(enterpriseCapabilityAssignments.packId, id),
          ),
        );
      if (assignmentKeys.length > 0) {
        const now = new Date();
        await tx.insert(enterpriseCapabilityAssignments).values(
          assignmentKeys.map((assignmentKey) => ({
            tenantId,
            packId: id,
            assignmentKey,
            createdAt: now,
            updatedAt: now,
          })),
        );
      }
    }
    await assertManagedPortableDeliveryLimitInTransaction(tx, tenantId);
  });
  const updated = await getCapabilityPack(tenantId, id);
  if (!updated) throw new Error("pack not found");
  return updated;
}

export async function deleteCapabilityPack(tenantIdInput: string, id: string): Promise<boolean> {
  const db = getAdminMysqlDb();
  const tenantId = requireTenantId(tenantIdInput);
  return db.transaction(async (tx) => {
    await lockTenantCapabilityDelivery(tx, tenantId);
    const deleted = await tx
      .delete(enterpriseCapabilityPacks)
      .where(and(eq(enterpriseCapabilityPacks.tenantId, tenantId), eq(enterpriseCapabilityPacks.id, id)));
    return deleted[0].affectedRows > 0;
  });
}
