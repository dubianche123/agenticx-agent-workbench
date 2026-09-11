import {
  enterpriseCapabilityPackMembers as pgMembers,
  enterpriseCapabilityPacks as pgPacks,
  enterpriseConfigMarketDownloadReceipts as pgDownloadReceipts,
  enterpriseConfigMarketItems as pgItems,
  enterpriseConfigMarketReleases as pgReleases,
  tenants as pgTenants,
} from "@agenticx/db-schema";
import {
  enterpriseCapabilityPackMembers as mysqlMembers,
  enterpriseCapabilityPacks as mysqlPacks,
  enterpriseConfigMarketDownloadReceipts as mysqlDownloadReceipts,
  enterpriseConfigMarketItems as mysqlItems,
  enterpriseConfigMarketReleases as mysqlReleases,
  tenants as mysqlTenants,
} from "@agenticx/db-schema/mysql";
import {
  canonicalizeCapabilityId,
  MAX_MANAGED_PORTABLE_PACKAGES,
  parseCapabilityId,
  parseSkillFrontMatter,
  portableRuntimeContractFromManifest,
  type PortableRuntimeContract,
} from "@agenticx/config";
import { createMysqlDb, getIamDb, resolveDatabaseConfig } from "@agenticx/iam-core";
import { and, desc, eq, lt, or, sql } from "drizzle-orm";

export type AdminConfigMarketStatus = "published" | "unlisted";
export type AdminConfigMarketDeliveryState = "active" | "revoked";
export type AdminConfigMarketVisibility = "company" | "departments" | "users" | "personal" | "admins_only";

export type AdminConfigMarketItem = {
  id: string;
  capabilityId: string;
  kind: "expert" | "group" | "skill";
  title: string;
  description: string;
  ownerUserId: string;
  ownerDisplayName: string;
  visibility: AdminConfigMarketVisibility;
  visibleDepartmentIds: string[];
  visibleUserIds: string[];
  status: AdminConfigMarketStatus;
  /** Separate from market listing: revoked means managed delivery stops immediately. */
  deliveryState: AdminConfigMarketDeliveryState;
  releaseId: string;
  version: string;
  digest: string;
  /** Server-authoritative count of unique successful account/release reports. */
  downloadCount: number;
  createdAt: string;
  updatedAt: string;
};

export type AdminConfigMarketPromptPreview =
  | { kind: "expert"; name: string; role: string; systemPrompt: string }
  | {
      kind: "group";
      hostMemberIndex: number;
      members: Array<{ name: string; role: string; systemPrompt: string }>;
    }
  | {
      kind: "skill";
      name: string;
      description: string;
      skillMd: string;
      checkResult: {
        status: "passed" | "needs_review" | "failed";
        findings: string[];
        frontMatter: { name: string | null; description: string | null };
      };
    };
export type AdminConfigMarketItemDetail = {
  item: AdminConfigMarketItem;
  promptPreview: AdminConfigMarketPromptPreview;
  runtimeReview: PortableRuntimeContract;
};

type ArtifactRow = {
  id: string;
  kind: string;
  title: string;
  description: string;
  userId: string;
  ownerDisplayName: string;
  visibility: unknown;
  visibleDepartmentIds: unknown;
  visibleUserIds: unknown;
  status: string;
  deliveryState: string;
  currentReleaseId: string;
  createdAt: Date | string;
  updatedAt: Date | string;
};
type ReleaseRow = {
  id: string;
  artifactId: string;
  version: string;
  manifestDigest: string;
  manifest?: unknown;
};
type JoinedRow = { artifact: ArtifactRow; release: ReleaseRow; downloadCount?: unknown };

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function normalizeDownloadCount(value: unknown): number {
  const count = typeof value === "number" ? value : Number(value ?? 0);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error("stored config market download count is inconsistent");
  }
  return count;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try { return asRecord(JSON.parse(value) as unknown); } catch { return null; }
  }
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

const AUDIENCE_ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/u;
function audienceIds(value: unknown): string[] {
  const parsed = typeof value === "string" ? (() => {
    try { return JSON.parse(value) as unknown; } catch { return null; }
  })() : value;
  if (!Array.isArray(parsed) || parsed.length > 64) {
    throw new Error("stored config market visibility is inconsistent");
  }
  const ids: string[] = [];
  for (const candidate of parsed) {
    const id = typeof candidate === "string" ? candidate.trim().toUpperCase() : "";
    if (!AUDIENCE_ID_RE.test(id)) throw new Error("stored config market visibility is inconsistent");
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

function promptMember(value: unknown): { name: string; role: string; systemPrompt: string } | null {
  const member = asRecord(value);
  if (!member || typeof member.name !== "string") return null;
  if (typeof member.role !== "string" || typeof member.system_prompt !== "string") return null;
  return { name: member.name, role: member.role, systemPrompt: member.system_prompt };
}

type SkillCheckResult = Extract<AdminConfigMarketPromptPreview, { kind: "skill" }>["checkResult"];

/** Re-check the single-file Skill shape at the admin review boundary. */
function inspectSkillMd(skillMd: string, expectedName: string): SkillCheckResult {
  const findings: string[] = [];
  const frontMatter: SkillCheckResult["frontMatter"] = { name: null, description: null };
  const parsed = parseSkillFrontMatter(skillMd);
  if (!parsed) {
    findings.push("SKILL.md front matter 结构无效");
  } else {
    frontMatter.name = parsed.name;
    frontMatter.description = parsed.description;
    if (parsed.name !== expectedName) findings.push("front matter name 与 Skill 名称不一致");
  }
  return {
    status: findings.length === 0 ? "passed" : "failed",
    findings,
    frontMatter,
  };
}

function promptPreview(row: JoinedRow): AdminConfigMarketPromptPreview {
  if (row.release.manifest === undefined) {
    throw new Error("stored config market detail is missing its manifest");
  }
  const manifest = asRecord(row.release.manifest);
  const payload = asRecord(manifest?.payload);
  if (!manifest || manifest.kind !== row.artifact.kind || !payload) {
    throw new Error("stored config market manifest is inconsistent");
  }
  if (row.artifact.kind === "expert") {
    const member = promptMember(payload);
    if (!member) throw new Error("stored expert prompt is inconsistent");
    return { kind: "expert", ...member };
  }
  if (row.artifact.kind === "group") {
    const hostMemberIndex = payload.host_member_index;
    if (typeof hostMemberIndex !== "number" || !Number.isInteger(hostMemberIndex) || !Array.isArray(payload.members)) {
      throw new Error("stored group prompt is inconsistent");
    }
    const members = payload.members.map(promptMember);
    if (
      members.length === 0 ||
      members.some((member) => member === null) ||
      hostMemberIndex < 0 ||
      hostMemberIndex >= members.length
    ) {
      throw new Error("stored group prompt is inconsistent");
    }
    return {
      kind: "group",
      hostMemberIndex,
      members: members as Array<{ name: string; role: string; systemPrompt: string }>,
    };
  }
  if (row.artifact.kind === "skill") {
    const name = payload.name;
    const description = payload.description;
    const skillMd = payload.skill_md;
    if (typeof name !== "string" || typeof description !== "string" || typeof skillMd !== "string") {
      throw new Error("stored skill prompt is inconsistent");
    }
    return {
      kind: "skill",
      name,
      description,
      skillMd,
      checkResult: inspectSkillMd(skillMd, name),
    };
  }
  throw new Error("stored config market item is inconsistent");
}

/** portable-runtime.ts models executable expert/group packages. A market Skill
 * carries the same dependency envelope but has no expert declarations/resources. */
function runtimeReviewFromManifest(value: unknown, kind: string): PortableRuntimeContract {
  if (kind !== "skill") return portableRuntimeContractFromManifest(value);
  const manifest = asRecord(value);
  const dependencies = asRecord(manifest?.dependencies);
  const permission = manifest?.recommended_permission_mode;
  if (
    !manifest ||
    manifest.schema_version !== 2 ||
    manifest.kind !== "skill" ||
    !dependencies ||
    !Array.isArray(dependencies.skills) ||
    !Array.isArray(dependencies.mcps) ||
    (permission !== "plan" && permission !== "ask" && permission !== "auto")
  ) throw new Error("stored market Skill runtime contract is inconsistent");
  const parsedDependencies = [
    ...dependencies.skills.map((item, index) => marketDependency(item, "skill", index)),
    ...dependencies.mcps.map((item, index) => marketDependency(item, "mcp", index)),
  ];
  const ids = new Set<string>();
  for (const item of parsedDependencies) {
    if (ids.has(item.capabilityId)) throw new Error(`stored portable dependency is duplicated: ${item.capabilityId}`);
    ids.add(item.capabilityId);
  }
  return { recommendedPermissionMode: permission, expertPermissions: [], dependencies: parsedDependencies, resources: [] };
}

function marketDependency(
  value: unknown,
  kind: "skill" | "mcp",
  index: number,
): PortableRuntimeContract["dependencies"][number] {
  const item = asRecord(value);
  const rawId = item?.capability_id;
  const canonical = typeof rawId === "string" ? canonicalizeCapabilityId(rawId) : null;
  const parsed = canonical ? parseCapabilityId(canonical) : null;
  if (!item || !canonical || parsed?.kind !== kind || typeof item.version !== "string" || typeof item.required !== "boolean") {
    throw new Error(`stored market ${kind} dependency ${index} is inconsistent`);
  }
  if (kind === "skill" && (typeof item.digest !== "string" || !/^[a-f0-9]{64}$/iu.test(item.digest))) {
    throw new Error(`stored market skill dependency ${index} digest is inconsistent`);
  }
  return {
    kind,
    capabilityId: canonical,
    version: item.version,
    digest: kind === "skill" ? (item.digest as string).toLowerCase() : null,
    required: item.required,
  };
}

function downloadCountExpression(items: any, receipts: any) {
  return sql<number>`coalesce((select count(*) from ${receipts} where ${receipts.tenantId} = ${items.tenantId} and ${receipts.itemId} = ${items.id}), 0)`;
}

function listSelection(items: any, releases: any, receipts: any) {
  return {
    artifact: items,
    release: {
      id: releases.id,
      artifactId: releases.artifactId,
      version: releases.version,
      manifestDigest: releases.manifestDigest,
    },
    downloadCount: downloadCountExpression(items, receipts),
  };
}

export const MAX_ADMIN_CONFIG_MARKET_PAGE_SIZE = 100;

export class AdminConfigMarketCursorError extends Error {
  public constructor() {
    super("invalid config market cursor");
    this.name = "AdminConfigMarketCursorError";
  }
}

function encodeAdminMarketCursor(updatedAt: Date | string, id: string): string {
  return Buffer.from(JSON.stringify([iso(updatedAt), id]), "utf8").toString("base64url");
}

function decodeAdminMarketCursor(value: string | null | undefined): { updatedAt: Date; id: string } | null {
  if (!value) return null;
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (!Array.isArray(decoded) || decoded.length !== 2 || typeof decoded[0] !== "string" || typeof decoded[1] !== "string") {
      throw new Error("shape");
    }
    const updatedAt = new Date(decoded[0]);
    if (!Number.isFinite(updatedAt.getTime()) || !AUDIENCE_ID_RE.test(decoded[1])) throw new Error("value");
    return { updatedAt, id: decoded[1] };
  } catch {
    throw new AdminConfigMarketCursorError();
  }
}

function assertDesiredPortableCount(
  memberRows: Array<{ capabilityId: string }>,
  marketRows: Array<{ id: string; kind: string; status?: string; deliveryState?: string | null }>,
): void {
  const published = new Set(
    marketRows
      .filter((row) =>
        (row.kind === "expert" || row.kind === "group" || row.kind === "skill") &&
        (row.status === undefined || row.status === "published" || row.status === "unlisted") &&
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
      published.has(canonical)
    ) desired.add(canonical);
  }
  if (desired.size > MAX_MANAGED_PORTABLE_PACKAGES) {
    throw new Error(`managed portable package limit exceeded: ${desired.size}/${MAX_MANAGED_PORTABLE_PACKAGES}`);
  }
}

async function assertPgManagedPortableLimit(tx: any, tenantId: string): Promise<void> {
  const memberRows = (await tx
    .select({ capabilityId: pgMembers.capabilityId })
    .from(pgPacks)
    .innerJoin(pgMembers, eq(pgMembers.packId, pgPacks.id))
    .where(and(eq(pgPacks.tenantId, tenantId), eq(pgPacks.status, "active")))) as Array<{ capabilityId: string }>;
  const marketRows = (await tx
    .select({ id: pgItems.id, kind: pgItems.kind, status: pgItems.status, deliveryState: pgItems.deliveryState })
    .from(pgItems)
    .where(eq(pgItems.tenantId, tenantId))) as Array<{ id: string; kind: string; status: string; deliveryState?: string | null }>;
  assertDesiredPortableCount(memberRows, marketRows);
}
async function assertMysqlManagedPortableLimit(tx: any, tenantId: string): Promise<void> {
  const memberRows = (await tx
    .select({ capabilityId: mysqlMembers.capabilityId })
    .from(mysqlPacks)
    .innerJoin(mysqlMembers, eq(mysqlMembers.packId, mysqlPacks.id))
    .where(and(eq(mysqlPacks.tenantId, tenantId), eq(mysqlPacks.status, "active")))) as Array<{ capabilityId: string }>;
  const marketRows = (await tx
    .select({ id: mysqlItems.id, kind: mysqlItems.kind, status: mysqlItems.status, deliveryState: mysqlItems.deliveryState })
    .from(mysqlItems)
    .where(eq(mysqlItems.tenantId, tenantId))) as Array<{ id: string; kind: string; status: string; deliveryState?: string | null }>;
  assertDesiredPortableCount(memberRows, marketRows);
}

function mapRow(row: JoinedRow): AdminConfigMarketItem {
  const artifact = row.artifact;
  const release = row.release;
  if (
    (artifact.kind !== "expert" && artifact.kind !== "group" && artifact.kind !== "skill") ||
    (artifact.status !== "published" && artifact.status !== "unlisted") ||
    artifact.currentReleaseId !== release.id ||
    artifact.id !== release.artifactId
  ) throw new Error("stored config market item is inconsistent");
  const visibleDepartmentIds = audienceIds(artifact.visibleDepartmentIds);
  const visibleUserIds = audienceIds(artifact.visibleUserIds);
  const visibility = artifact.visibility;
  if (
    (visibility !== "company" && visibility !== "departments" && visibility !== "users" && visibility !== "personal" && visibility !== "admins_only") ||
    ((visibility === "company" || visibility === "admins_only") && (visibleDepartmentIds.length > 0 || visibleUserIds.length > 0)) ||
    (visibility === "personal" && (visibleDepartmentIds.length > 0 || visibleUserIds.length > 0)) ||
    (visibility === "departments" && (visibleDepartmentIds.length === 0 || visibleUserIds.length > 0)) ||
    (visibility === "users" && (visibleUserIds.length === 0 || visibleDepartmentIds.length > 0))
  ) throw new Error("stored config market visibility is inconsistent");
  return {
    id: artifact.id,
    capabilityId: `${artifact.kind}:${artifact.id}`,
    kind: artifact.kind,
    title: artifact.title,
    description: artifact.description,
    ownerUserId: artifact.userId,
    ownerDisplayName: artifact.ownerDisplayName,
    visibility,
    visibleDepartmentIds,
    visibleUserIds,
    status: artifact.status,
    deliveryState:
      artifact.deliveryState === "active" || artifact.deliveryState === "revoked"
        ? artifact.deliveryState
        : (() => { throw new Error("stored config market delivery state is inconsistent"); })(),
    releaseId: release.id,
    version: release.version,
    digest: release.manifestDigest,
    downloadCount: normalizeDownloadCount(row.downloadCount),
    createdAt: iso(artifact.createdAt),
    updatedAt: iso(artifact.updatedAt),
  };
}

export async function listConfigMarketItems(tenantId: string): Promise<AdminConfigMarketItem[]> {
  const config = resolveDatabaseConfig();
  if (config.dialect === "mysql") {
    const { raw: db } = await createMysqlDb(config);
    const rows = (await db
      .select(listSelection(mysqlItems, mysqlReleases, mysqlDownloadReceipts) as any)
      .from(mysqlItems)
      .innerJoin(mysqlReleases, eq(mysqlReleases.id, mysqlItems.currentReleaseId))
      .where(eq(mysqlItems.tenantId, tenantId))
      .orderBy(desc(mysqlItems.updatedAt))) as unknown as JoinedRow[];
    return rows.map((row) => mapRow(row));
  }
  const rows = (await getIamDb()
    .select(listSelection(pgItems, pgReleases, pgDownloadReceipts) as any)
    .from(pgItems)
    .innerJoin(pgReleases, eq(pgReleases.id, pgItems.currentReleaseId))
    .where(eq(pgItems.tenantId, tenantId))
    .orderBy(desc(pgItems.updatedAt))) as unknown as JoinedRow[];
  return rows.map((row) => mapRow(row));
}

/**
 * Return only published capability ids for pack validation.
 *
 * This query intentionally never selects the release manifest. Pack create/update only needs
 * to reject references to an unlisted/unknown artifact; the full prompt and runtime contract are
 * read exactly once by the administrator's detail-review endpoint.
 */
export async function listPublishedConfigMarketCapabilityIds(tenantId: string): Promise<Set<string>> {
  const config = resolveDatabaseConfig();
  const run = async (db: any, items: any, releases: any): Promise<Set<string>> => {
    const rows = (await db
      .select({ id: items.id, kind: items.kind, deliveryState: items.deliveryState })
      .from(items)
      .innerJoin(releases, eq(releases.id, items.currentReleaseId))
      .where(and(eq(items.tenantId, tenantId), eq(items.status, "published")))) as Array<{
        id: string;
        kind: string;
        deliveryState?: string | null;
      }>;
    return new Set(
      rows
        .filter((row) =>
          (row.kind === "expert" || row.kind === "group" || row.kind === "skill") &&
          (row.deliveryState ?? "active") === "active",
        )
        .map((row) => `${row.kind}:${row.id.toUpperCase()}`),
    );
  };
  if (config.dialect === "mysql") {
    const { raw: db } = await createMysqlDb(config);
    return run(db, mysqlItems, mysqlReleases);
  }
  return run(getIamDb(), pgItems, pgReleases);
}

export async function listConfigMarketItemsPage(
  tenantId: string,
  options: { limit?: number; cursor?: string | null } = {},
): Promise<{ items: AdminConfigMarketItem[]; nextCursor: string | null }> {
  const limit = Math.max(1, Math.min(MAX_ADMIN_CONFIG_MARKET_PAGE_SIZE, options.limit ?? 50));
  const cursor = decodeAdminMarketCursor(options.cursor);
  const config = resolveDatabaseConfig();
  const run = async (db: any, items: any, releases: any, receipts: any) => {
    const predicates = [eq(items.tenantId, tenantId)];
    if (cursor) {
      predicates.push(or(
        lt(items.updatedAt, cursor.updatedAt),
        and(eq(items.updatedAt, cursor.updatedAt), lt(items.id, cursor.id)),
      )!);
    }
    const rows = (await db
      .select(listSelection(items, releases, receipts))
      .from(items)
      .innerJoin(releases, eq(releases.id, items.currentReleaseId))
      .where(and(...predicates))
      .orderBy(desc(items.updatedAt), desc(items.id))
      .limit(limit + 1)) as JoinedRow[];
    const page = rows.slice(0, limit);
    const last = page.at(-1)?.artifact;
    return {
      items: page.map(mapRow),
      nextCursor: rows.length > limit && last ? encodeAdminMarketCursor(last.updatedAt, last.id) : null,
    };
  };
  if (config.dialect === "mysql") {
    const { raw: db } = await createMysqlDb(config);
    return run(db, mysqlItems, mysqlReleases, mysqlDownloadReceipts);
  }
  return run(getIamDb(), pgItems, pgReleases, pgDownloadReceipts);
}

export async function getConfigMarketItemDetail(
  tenantId: string,
  id: string,
): Promise<AdminConfigMarketItemDetail | null> {
  const config = resolveDatabaseConfig();
  if (config.dialect === "mysql") {
    const { raw: db } = await createMysqlDb(config);
    const rows = await db
      .select({
        artifact: mysqlItems,
        release: mysqlReleases,
        downloadCount: downloadCountExpression(mysqlItems, mysqlDownloadReceipts),
      })
      .from(mysqlItems)
      .innerJoin(mysqlReleases, eq(mysqlReleases.id, mysqlItems.currentReleaseId))
      .where(and(eq(mysqlItems.tenantId, tenantId), eq(mysqlItems.id, id)))
      .limit(1);
    return rows[0] ? {
      item: mapRow(rows[0]),
      promptPreview: promptPreview(rows[0]),
      runtimeReview: runtimeReviewFromManifest(rows[0].release.manifest, rows[0].artifact.kind),
    } : null;
  }
  const rows = await getIamDb()
    .select({
      artifact: pgItems,
      release: pgReleases,
      downloadCount: downloadCountExpression(pgItems, pgDownloadReceipts),
    })
    .from(pgItems)
    .innerJoin(pgReleases, eq(pgReleases.id, pgItems.currentReleaseId))
    .where(and(eq(pgItems.tenantId, tenantId), eq(pgItems.id, id)))
    .limit(1);
  return rows[0] ? {
    item: mapRow(rows[0]),
    promptPreview: promptPreview(rows[0]),
    runtimeReview: runtimeReviewFromManifest(rows[0].release.manifest, rows[0].artifact.kind),
  } : null;
}

export async function setConfigMarketStatus(
  tenantId: string,
  id: string,
  status: AdminConfigMarketStatus,
): Promise<AdminConfigMarketItem | null> {
  const now = new Date();
  const patch = {
    status,
    updatedAt: now,
    ...(status === "published" ? { publishedAt: now, unlistedAt: null } : { unlistedAt: now }),
  };
  const config = resolveDatabaseConfig();
  if (config.dialect === "mysql") {
    const { raw: db } = await createMysqlDb(config);
    return db.transaction(async (tx) => {
      await tx.execute(sql`select ${mysqlTenants.id} from ${mysqlTenants} where ${mysqlTenants.id} = ${tenantId} for update`);
      const targets = await tx.select({ id: mysqlItems.id }).from(mysqlItems)
        .where(and(eq(mysqlItems.tenantId, tenantId), eq(mysqlItems.id, id))).limit(1);
      if (!targets[0]) return null;
      await tx.update(mysqlItems).set(patch).where(and(eq(mysqlItems.tenantId, tenantId), eq(mysqlItems.id, id)));
      if (status === "published") await assertMysqlManagedPortableLimit(tx, tenantId);
      const rows = await tx.select({
        artifact: mysqlItems,
        release: mysqlReleases,
        downloadCount: downloadCountExpression(mysqlItems, mysqlDownloadReceipts),
      }).from(mysqlItems)
        .innerJoin(mysqlReleases, eq(mysqlReleases.id, mysqlItems.currentReleaseId))
        .where(and(eq(mysqlItems.tenantId, tenantId), eq(mysqlItems.id, id))).limit(1);
      return rows[0] ? mapRow(rows[0]) : null;
    });
  }
  return getIamDb().transaction(async (tx) => {
    await tx.execute(sql`select ${pgTenants.id} from ${pgTenants} where ${pgTenants.id} = ${tenantId} for update`);
    const targets = await tx.select({ id: pgItems.id }).from(pgItems)
      .where(and(eq(pgItems.tenantId, tenantId), eq(pgItems.id, id))).limit(1);
    if (!targets[0]) return null;
    await tx.update(pgItems).set(patch).where(and(eq(pgItems.tenantId, tenantId), eq(pgItems.id, id)));
    if (status === "published") await assertPgManagedPortableLimit(tx, tenantId);
    const rows = await tx.select({
      artifact: pgItems,
      release: pgReleases,
      downloadCount: downloadCountExpression(pgItems, pgDownloadReceipts),
    }).from(pgItems)
      .innerJoin(pgReleases, eq(pgReleases.id, pgItems.currentReleaseId))
      .where(and(eq(pgItems.tenantId, tenantId), eq(pgItems.id, id))).limit(1);
    return rows[0] ? mapRow(rows[0]) : null;
  });
}

/**
 * Toggle the managed-delivery kill switch independently from market listing.
 * Unlisting/restoring must never mutate this field: an existing pack member may
 * continue delivering while its market card is hidden, whereas revoke must take
 * effect immediately for every managed package.
 */
export async function setConfigMarketDeliveryState(
  tenantId: string,
  id: string,
  deliveryState: AdminConfigMarketDeliveryState,
): Promise<AdminConfigMarketItem | null> {
  if (deliveryState !== "active" && deliveryState !== "revoked") {
    throw new Error("invalid config market delivery state");
  }
  const now = new Date();
  const patch = { deliveryState, updatedAt: now };
  const config = resolveDatabaseConfig();
  if (config.dialect === "mysql") {
    const { raw: db } = await createMysqlDb(config);
    return db.transaction(async (tx) => {
      await tx.execute(sql`select ${mysqlTenants.id} from ${mysqlTenants} where ${mysqlTenants.id} = ${tenantId} for update`);
      const targets = await tx.select({ id: mysqlItems.id }).from(mysqlItems)
        .where(and(eq(mysqlItems.tenantId, tenantId), eq(mysqlItems.id, id))).limit(1);
      if (!targets[0]) return null;
      await tx.update(mysqlItems).set(patch).where(and(eq(mysqlItems.tenantId, tenantId), eq(mysqlItems.id, id)));
      if (deliveryState === "active") await assertMysqlManagedPortableLimit(tx, tenantId);
      const rows = await tx.select({
        artifact: mysqlItems,
        release: mysqlReleases,
        downloadCount: downloadCountExpression(mysqlItems, mysqlDownloadReceipts),
      }).from(mysqlItems)
        .innerJoin(mysqlReleases, eq(mysqlReleases.id, mysqlItems.currentReleaseId))
        .where(and(eq(mysqlItems.tenantId, tenantId), eq(mysqlItems.id, id))).limit(1);
      return rows[0] ? mapRow(rows[0]) : null;
    });
  }
  return getIamDb().transaction(async (tx) => {
    await tx.execute(sql`select ${pgTenants.id} from ${pgTenants} where ${pgTenants.id} = ${tenantId} for update`);
    const targets = await tx.select({ id: pgItems.id }).from(pgItems)
      .where(and(eq(pgItems.tenantId, tenantId), eq(pgItems.id, id))).limit(1);
    if (!targets[0]) return null;
    await tx.update(pgItems).set(patch).where(and(eq(pgItems.tenantId, tenantId), eq(pgItems.id, id)));
    if (deliveryState === "active") await assertPgManagedPortableLimit(tx, tenantId);
    const rows = await tx.select({
      artifact: pgItems,
      release: pgReleases,
      downloadCount: downloadCountExpression(pgItems, pgDownloadReceipts),
    }).from(pgItems)
      .innerJoin(pgReleases, eq(pgReleases.id, pgItems.currentReleaseId))
      .where(and(eq(pgItems.tenantId, tenantId), eq(pgItems.id, id))).limit(1);
    return rows[0] ? mapRow(rows[0]) : null;
  });
}
