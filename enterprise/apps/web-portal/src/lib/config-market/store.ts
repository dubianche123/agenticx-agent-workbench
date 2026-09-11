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
import { formatCapabilityId } from "@agenticx/config";
import { createMysqlDb, getIamDb, resolveDatabaseConfig } from "@agenticx/iam-core";
import { and, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import { ulid } from "ulid";

import {
  compareConfigShareVersions,
  CONFIG_SHARE_MANIFEST_VERSION,
  type ConfigShareKind,
  type ConfigShareManifest,
  validateConfigShareManifest,
} from "../config-share-types";
import {
  configMarketManifestDigest,
  normalizeConfigMarketAudience,
  requiredConfigMarketDependencies,
  sameConfigMarketAudience,
  toConfigMarketMetadata,
  type ConfigMarketAudience,
  type ConfigMarketItem,
  type ConfigMarketMetadata,
  type ConfigMarketDeliveryState,
  type ConfigMarketStatus,
} from "./types";
import {
  configMarketViewerDepartmentIds,
  isConfigMarketItemVisible,
  type ConfigMarketViewer,
} from "./visibility";

export type CreateConfigMarketItemInput = {
  tenantId: string;
  userId: string;
  ownerDisplayName: string;
  manifest: ConfigShareManifest;
  audience: ConfigMarketAudience;
  releaseNotes?: string;
};

export class ConfigMarketPublishBlockedError extends Error {
  public constructor(message = "this artifact was unlisted by an administrator") {
    super(message);
    this.name = "ConfigMarketPublishBlockedError";
  }
}
export class ConfigMarketOwnershipConflictError extends Error {
  public constructor(message = "artifact ownership does not match the publisher") {
    super(message);
    this.name = "ConfigMarketOwnershipConflictError";
  }
}
export class ConfigMarketAudienceConflictError extends Error {
  public constructor(message = "artifact audience cannot change while publishing a release") {
    super(message);
    this.name = "ConfigMarketAudienceConflictError";
  }
}
export class ConfigMarketReleaseVersionConflictError extends Error {
  public constructor(message = "release version must be greater than the current release") {
    super(message);
    this.name = "ConfigMarketReleaseVersionConflictError";
  }
}
export class ConfigMarketReleaseDigestConflictError extends Error {
  public constructor(message = "the same release content already exists under another version") {
    super(message);
    this.name = "ConfigMarketReleaseDigestConflictError";
  }
}
export class ConfigMarketTrackStableDependencyConflictError extends Error {
  public readonly missingCapabilityIds: string[];
  public readonly packIds: string[];

  public constructor(missingCapabilityIds: readonly string[], packIds: readonly string[]) {
    const missing = [...new Set(missingCapabilityIds)].sort();
    const packs = [...new Set(packIds)].sort();
    super(`new stable release requires capabilities missing from tracking packs: ${missing.join(", ")}`);
    this.name = "ConfigMarketTrackStableDependencyConflictError";
    this.missingCapabilityIds = missing;
    this.packIds = packs;
  }
}

export type ConfigMarketDownloadResult = {
  downloadCount: number;
  counted: boolean;
};

export type ConfigMarketStore = {
  create(input: CreateConfigMarketItemInput): Promise<ConfigMarketItem>;
  list(
    tenantId: string,
    options?: { includeUnlisted?: boolean; kind?: ConfigShareManifest["kind"] },
  ): Promise<ConfigMarketItem[]>;
  listVisible(
    viewer: ConfigMarketViewer,
    options?: { kind?: ConfigShareManifest["kind"] },
  ): Promise<ConfigMarketItem[]>;
  listVisibleMetadata(
    viewer: ConfigMarketViewer,
    options?: { kind?: ConfigShareManifest["kind"]; limit?: number; cursor?: string | null },
  ): Promise<{ items: ConfigMarketMetadata[]; nextCursor: string | null }>;
  get(id: string, tenantId: string, options?: { includeUnlisted?: boolean }): Promise<ConfigMarketItem | null>;
  getVisible(id: string, viewer: ConfigMarketViewer): Promise<ConfigMarketItem | null>;
  recordDownload(
    id: string,
    viewer: ConfigMarketViewer,
    releaseId: string,
  ): Promise<ConfigMarketDownloadResult | null>;
  setStatus(id: string, tenantId: string, status: ConfigMarketStatus): Promise<ConfigMarketItem | null>;
  /** Emergency stop for forced delivery, independent from the employee market listing. */
  setDeliveryState(
    id: string,
    tenantId: string,
    deliveryState: ConfigMarketDeliveryState,
  ): Promise<ConfigMarketItem | null>;
};

export const MAX_CONFIG_MARKET_LIST_PAGE_SIZE = 50;
export const MAX_CONFIG_MARKET_LIST_SCAN_ROWS = 500;

export class ConfigMarketCursorError extends Error {
  public constructor() {
    super("invalid config market cursor");
    this.name = "ConfigMarketCursorError";
  }
}

type ConfigMarketListCursor = { updatedAt: Date; id: string };

export function encodeConfigMarketListCursor(value: ConfigMarketListCursor): string {
  return Buffer.from(JSON.stringify([value.updatedAt.toISOString(), value.id]), "utf8").toString("base64url");
}

export function decodeConfigMarketListCursor(value: string | null | undefined): ConfigMarketListCursor | null {
  if (!value) return null;
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (!Array.isArray(decoded) || decoded.length !== 2 || typeof decoded[0] !== "string" || typeof decoded[1] !== "string") {
      throw new Error("shape");
    }
    const updatedAt = new Date(decoded[0]);
    if (!Number.isFinite(updatedAt.getTime()) || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(decoded[1])) {
      throw new Error("value");
    }
    return { updatedAt, id: decoded[1] };
  } catch {
    throw new ConfigMarketCursorError();
  }
}

export type ConfigMarketArtifactRow = {
  id: string;
  tenantId: string;
  userId: string;
  ownerDisplayName: string;
  kind: string;
  sourceArtifactId: string;
  title: string;
  description: string;
  currentReleaseId: string;
  visibility: unknown;
  visibleDepartmentIds: unknown;
  visibleUserIds: unknown;
  status: string;
  deliveryState?: string;
  publishedAt: Date | string;
  unlistedAt: Date | string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
};
export type ConfigMarketReleaseRow = {
  id: string;
  tenantId: string;
  artifactId: string;
  version: string;
  manifestVersion: number;
  manifestDigest: string;
  manifest: unknown;
  releaseNotes: string;
  publishedAt: Date | string;
  createdAt: Date | string;
  updatedAt: Date | string;
};

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
function nullableIso(value: Date | string | null): string | null {
  return value === null ? null : iso(value);
}

function normalizeDownloadCount(value: unknown): number {
  const count = typeof value === "number" ? value : Number(value ?? 0);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error("stored config market download count is inconsistent");
  }
  return count;
}

function normalizeDeliveryState(value: unknown): ConfigMarketDeliveryState {
  // A missing value is the pre-emergency-revoke shape and therefore means active.
  if (value === undefined || value === null) return "active";
  if (value === "active" || value === "revoked") return value;
  throw new Error("stored config market delivery state is inconsistent");
}

export function mapConfigMarketRow(
  artifact: ConfigMarketArtifactRow,
  release: ConfigMarketReleaseRow,
  options: { requireCurrent?: boolean; downloadCount?: unknown } = {},
): ConfigMarketItem {
  const raw = validateConfigShareManifest(release.manifest);
  const digest = configMarketManifestDigest(raw);
  const audience = normalizeConfigMarketAudience(artifact);
  const deliveryState = normalizeDeliveryState(artifact.deliveryState);
  if (
    !audience ||
    ((options.requireCurrent ?? true) && artifact.currentReleaseId !== release.id) ||
    artifact.id !== release.artifactId ||
    artifact.tenantId !== release.tenantId ||
    artifact.sourceArtifactId !== raw.artifact_id ||
    artifact.kind !== raw.kind ||
    ((options.requireCurrent ?? true) && artifact.title !== raw.title) ||
    ((options.requireCurrent ?? true) && artifact.description !== raw.description) ||
    release.version !== raw.release_version ||
    release.manifestVersion !== CONFIG_SHARE_MANIFEST_VERSION ||
    release.manifestVersion !== raw.schema_version ||
    release.manifestDigest !== digest ||
    (artifact.status !== "published" && artifact.status !== "unlisted")
  ) {
    throw new Error("stored config market artifact/release is inconsistent");
  }
  return {
    id: artifact.id,
    tenantId: artifact.tenantId,
    userId: artifact.userId,
    ownerDisplayName: artifact.ownerDisplayName,
    kind: raw.kind,
    sourceArtifactId: artifact.sourceArtifactId,
    title: raw.title,
    description: raw.description,
    releaseId: release.id,
    version: release.version,
    manifestVersion: CONFIG_SHARE_MANIFEST_VERSION,
    digest,
    raw,
    releaseNotes: release.releaseNotes,
    releasePublishedAt: iso(release.publishedAt),
    downloadCount: normalizeDownloadCount(options.downloadCount),
    status: artifact.status,
    deliveryState,
    ...audience,
    publishedAt: iso(artifact.publishedAt),
    unlistedAt: nullableIso(artifact.unlistedAt),
    createdAt: iso(artifact.createdAt),
    updatedAt: iso(artifact.updatedAt),
  };
}

type ConfigMarketMetadataReleaseRow = {
  id: string;
  artifactId: string;
  version: string;
  manifestVersion: number;
  manifestDigest: string;
  releaseNotes: string;
  publishedAt: Date | string;
};

function mapConfigMarketMetadataRow(
  artifact: ConfigMarketArtifactRow,
  release: ConfigMarketMetadataReleaseRow,
  downloadCount: unknown = 0,
): ConfigMarketMetadata {
  const audience = normalizeConfigMarketAudience(artifact);
  if (
    !audience ||
    (artifact.kind !== "expert" && artifact.kind !== "group" && artifact.kind !== "skill") ||
    artifact.status !== "published" ||
    artifact.currentReleaseId !== release.id ||
    artifact.id !== release.artifactId ||
    release.manifestVersion !== CONFIG_SHARE_MANIFEST_VERSION ||
    !/^[0-9a-f]{64}$/.test(release.manifestDigest)
  ) throw new Error("stored config market metadata is inconsistent");
  return toConfigMarketMetadata({
    id: artifact.id,
    kind: artifact.kind,
    sourceArtifactId: artifact.sourceArtifactId,
    manifestVersion: CONFIG_SHARE_MANIFEST_VERSION,
    releaseId: release.id,
    version: release.version,
    title: artifact.title,
    description: artifact.description,
    ownerDisplayName: artifact.ownerDisplayName,
    deliveryState: normalizeDeliveryState(artifact.deliveryState),
    status: "published",
    ...audience,
    digest: release.manifestDigest,
    releaseNotes: release.releaseNotes,
    releasePublishedAt: iso(release.publishedAt),
    downloadCount: normalizeDownloadCount(downloadCount),
    publishedAt: iso(artifact.publishedAt),
    createdAt: iso(artifact.createdAt),
    updatedAt: iso(artifact.updatedAt),
  });
}

function metadataVisibleTo(
  artifact: ConfigMarketArtifactRow,
  viewer: ConfigMarketViewer,
  departmentIds: readonly string[],
): boolean {
  const audience = normalizeConfigMarketAudience(artifact);
  if (!audience) throw new Error("stored config market visibility is inconsistent");
  if (audience.visibility === "admins_only") return viewer.isAdmin === true;
  if (artifact.userId === viewer.userId) return true;
  if (audience.visibility === "personal") return false;
  if (audience.visibility === "company") return true;
  if (audience.visibility === "users") return audience.visibleUserIds.includes(viewer.userId);
  return audience.visibleDepartmentIds.some((id) => departmentIds.includes(id));
}

/**
 * Keep the list/detail query single-round-trip while deriving the count from
 * immutable receipts.  The correlated scalar is deliberately dialect-neutral;
 * Drizzle renders the table/column identifiers for PostgreSQL and MySQL.
 */
function downloadCountExpression(items: any, receipts: any) {
  return sql<number>`coalesce((select count(*) from ${receipts} where ${receipts.tenantId} = ${items.tenantId} and ${receipts.itemId} = ${items.id}), 0)`;
}

async function listSqlMetadataPage(
  db: any,
  tables: { items: any; releases: any; receipts: any },
  viewer: ConfigMarketViewer,
  options: { kind?: ConfigShareKind; limit?: number; cursor?: string | null },
): Promise<{ items: ConfigMarketMetadata[]; nextCursor: string | null }> {
  const limit = Math.max(1, Math.min(MAX_CONFIG_MARKET_LIST_PAGE_SIZE, options.limit ?? 24));
  let scanCursor = decodeConfigMarketListCursor(options.cursor);
  const items: ConfigMarketMetadata[] = [];
  let scanned = 0;
  let hasMore = false;
  let departmentIds: string[] | null = null;

  while (items.length < limit && scanned < MAX_CONFIG_MARKET_LIST_SCAN_ROWS) {
    const batchSize = Math.min(50, MAX_CONFIG_MARKET_LIST_SCAN_ROWS - scanned);
    const predicates = [
      eq(tables.items.tenantId, viewer.tenantId),
      eq(tables.items.status, "published"),
    ];
    if (options.kind) predicates.push(eq(tables.items.kind, options.kind));
    if (scanCursor) {
      predicates.push(or(
        lt(tables.items.updatedAt, scanCursor.updatedAt),
        and(eq(tables.items.updatedAt, scanCursor.updatedAt), lt(tables.items.id, scanCursor.id)),
      )!);
    }
    const rows = (await db
      .select({
        artifact: tables.items,
        release: {
          id: tables.releases.id,
          artifactId: tables.releases.artifactId,
          version: tables.releases.version,
          manifestVersion: tables.releases.manifestVersion,
          manifestDigest: tables.releases.manifestDigest,
          releaseNotes: tables.releases.releaseNotes,
          publishedAt: tables.releases.publishedAt,
        },
        downloadCount: downloadCountExpression(tables.items, tables.receipts),
      })
      .from(tables.items)
      .innerJoin(tables.releases, eq(tables.releases.id, tables.items.currentReleaseId))
      .where(and(...predicates))
      .orderBy(desc(tables.items.updatedAt), desc(tables.items.id))
      .limit(batchSize + 1)) as Array<{
        artifact: ConfigMarketArtifactRow;
        release: ConfigMarketMetadataReleaseRow;
        downloadCount: unknown;
      }>;
    const batch = rows.slice(0, batchSize);
    hasMore = rows.length > batchSize;
    if (batch.length === 0) break;

    for (let index = 0; index < batch.length; index += 1) {
      const row = batch[index]!;
      scanned += 1;
      scanCursor = { updatedAt: new Date(row.artifact.updatedAt), id: row.artifact.id };
      if (
        row.artifact.userId !== viewer.userId &&
        row.artifact.visibility === "departments" &&
        departmentIds === null
      ) {
        departmentIds = await configMarketViewerDepartmentIds(viewer);
      }
      if (metadataVisibleTo(row.artifact, viewer, departmentIds ?? [])) {
        items.push(mapConfigMarketMetadataRow(row.artifact, row.release, row.downloadCount));
      }
      if (items.length === limit) {
        hasMore = hasMore || index < batch.length - 1;
        break;
      }
    }
    if (items.length === limit || !hasMore) break;
  }

  return {
    items,
    nextCursor: (hasMore || scanned >= MAX_CONFIG_MARKET_LIST_SCAN_ROWS) && scanCursor
      ? encodeConfigMarketListCursor(scanCursor)
      : null,
  };
}

function cloneItem(item: ConfigMarketItem): ConfigMarketItem {
  return JSON.parse(JSON.stringify(item)) as ConfigMarketItem;
}

type PublishTables = {
  items: any;
  releases: any;
  receipts: any;
  tenants: any;
  packs: any;
  members: any;
};

async function countDownloadsInTransaction(
  tx: any,
  receipts: any,
  tenantId: string,
  itemId: string,
): Promise<number> {
  const rows = (await tx
    .select({ count: sql<number>`count(*)` })
    .from(receipts)
    .where(and(eq(receipts.tenantId, tenantId), eq(receipts.itemId, itemId)))) as Array<{ count: unknown }>;
  return normalizeDownloadCount(rows[0]?.count);
}

async function assertTrackStablePackDependencyClosure(
  tx: any,
  tables: PublishTables,
  tenantId: string,
  capabilityId: string,
  manifest: ConfigShareManifest,
): Promise<void> {
  const required = requiredConfigMarketDependencies(manifest);
  if (required.length === 0) return;
  const tracking = (await tx
    .select({ packId: tables.members.packId })
    .from(tables.members)
    .innerJoin(tables.packs, eq(tables.packs.id, tables.members.packId))
    .where(
      and(
        eq(tables.packs.tenantId, tenantId),
        eq(tables.members.capabilityId, capabilityId),
        eq(tables.members.releasePolicy, "track_stable"),
      ),
    )) as Array<{ packId: string }>;
  const packIds = [...new Set(tracking.map((row) => row.packId))];
  if (packIds.length === 0) return;
  const members = (await tx
    .select({ packId: tables.members.packId, capabilityId: tables.members.capabilityId })
    .from(tables.members)
    .where(inArray(tables.members.packId, packIds))) as Array<{ packId: string; capabilityId: string }>;
  const selectedByPack = new Map<string, Set<string>>();
  for (const member of members) {
    const selected = selectedByPack.get(member.packId) ?? new Set<string>();
    selected.add(member.capabilityId);
    selectedByPack.set(member.packId, selected);
  }
  const missing: string[] = [];
  const brokenPacks: string[] = [];
  for (const packId of packIds) {
    const selected = selectedByPack.get(packId) ?? new Set<string>();
    const packMissing = required.filter((dependency) => !selected.has(dependency.capabilityId));
    if (packMissing.length > 0) {
      brokenPacks.push(packId);
      missing.push(...packMissing.map((dependency) => dependency.capabilityId));
    }
  }
  if (missing.length > 0) {
    throw new ConfigMarketTrackStableDependencyConflictError(missing, brokenPacks);
  }
}

async function publishInTransaction(
  tx: any,
  tables: PublishTables,
  input: CreateConfigMarketItemInput,
): Promise<ConfigMarketItem> {
  await tx.execute(
    sql`select ${tables.tenants.id} from ${tables.tenants} where ${tables.tenants.id} = ${input.tenantId} for update`,
  );
  const manifest = input.manifest;
  const digest = configMarketManifestDigest(manifest);
  const now = new Date();
  const existingRows = (await tx
    .select()
    .from(tables.items)
    .where(
      and(
        eq(tables.items.tenantId, input.tenantId),
        eq(tables.items.kind, manifest.kind),
        eq(tables.items.sourceArtifactId, manifest.artifact_id),
      ),
    )
    .for("update")
    .limit(1)) as ConfigMarketArtifactRow[];
  const existing = existingRows[0];

  if (!existing) {
    const artifactId = ulid();
    const releaseId = ulid();
    const artifact: ConfigMarketArtifactRow = {
      id: artifactId,
      tenantId: input.tenantId,
      userId: input.userId,
      ownerDisplayName: input.ownerDisplayName,
      kind: manifest.kind,
      sourceArtifactId: manifest.artifact_id,
      title: manifest.title,
      description: manifest.description,
      currentReleaseId: releaseId,
      visibility: input.audience.visibility,
      visibleDepartmentIds: input.audience.visibleDepartmentIds,
      visibleUserIds: input.audience.visibleUserIds,
      status: "published",
      deliveryState: "active",
      publishedAt: now,
      unlistedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    const release: ConfigMarketReleaseRow = {
      id: releaseId,
      tenantId: input.tenantId,
      artifactId,
      version: manifest.release_version,
      manifestVersion: CONFIG_SHARE_MANIFEST_VERSION,
      manifestDigest: digest,
      manifest,
      releaseNotes: input.releaseNotes ?? "",
      publishedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    await tx.insert(tables.items).values(artifact);
    await tx.insert(tables.releases).values(release);
    return mapConfigMarketRow(artifact, release, {
      downloadCount: await countDownloadsInTransaction(tx, tables.receipts, input.tenantId, artifactId),
    });
  }

  if (existing.userId !== input.userId) throw new ConfigMarketOwnershipConflictError();
  if (existing.status === "unlisted") throw new ConfigMarketPublishBlockedError();
  const audience = normalizeConfigMarketAudience(existing);
  if (!audience || !sameConfigMarketAudience(audience, input.audience)) {
    throw new ConfigMarketAudienceConflictError();
  }
  const currentRows = (await tx
    .select()
    .from(tables.releases)
    .where(
      and(
        eq(tables.releases.tenantId, input.tenantId),
        eq(tables.releases.id, existing.currentReleaseId),
        eq(tables.releases.artifactId, existing.id),
      ),
    )
    .limit(1)) as ConfigMarketReleaseRow[];
  const current = currentRows[0];
  if (!current) throw new Error("current market release is dangling");

  if (manifest.release_version === current.version) {
    if (digest === current.manifestDigest) {
      return mapConfigMarketRow(existing, current, {
        downloadCount: await countDownloadsInTransaction(tx, tables.receipts, input.tenantId, existing.id),
      });
    }
    throw new ConfigMarketReleaseVersionConflictError("release version already exists with different content");
  }
  if (compareConfigShareVersions(manifest.release_version, current.version) <= 0) {
    throw new ConfigMarketReleaseVersionConflictError();
  }
  const conflicts = (await tx
    .select({ version: tables.releases.version, digest: tables.releases.manifestDigest })
    .from(tables.releases)
    .where(
      and(
        eq(tables.releases.tenantId, input.tenantId),
        eq(tables.releases.artifactId, existing.id),
        or(
          eq(tables.releases.version, manifest.release_version),
          eq(tables.releases.manifestDigest, digest),
        ),
      ),
    )) as Array<{ version: string; digest: string }>;
  if (conflicts.some((row) => row.version === manifest.release_version)) {
    throw new ConfigMarketReleaseVersionConflictError("release version already exists");
  }
  if (conflicts.some((row) => row.digest === digest)) {
    throw new ConfigMarketReleaseDigestConflictError();
  }

  await assertTrackStablePackDependencyClosure(
    tx,
    tables,
    input.tenantId,
    formatCapabilityId(manifest.kind, existing.id),
    manifest,
  );

  const release: ConfigMarketReleaseRow = {
    id: ulid(),
    tenantId: input.tenantId,
    artifactId: existing.id,
    version: manifest.release_version,
    manifestVersion: CONFIG_SHARE_MANIFEST_VERSION,
    manifestDigest: digest,
    manifest,
    releaseNotes: input.releaseNotes ?? "",
    publishedAt: now,
    createdAt: now,
    updatedAt: now,
  };
  await tx.insert(tables.releases).values(release);
  const artifact: ConfigMarketArtifactRow = {
    ...existing,
    ownerDisplayName: input.ownerDisplayName,
    title: manifest.title,
    description: manifest.description,
    currentReleaseId: release.id,
    updatedAt: now,
  };
  await tx
    .update(tables.items)
    .set({
      ownerDisplayName: artifact.ownerDisplayName,
      title: artifact.title,
      description: artifact.description,
      currentReleaseId: artifact.currentReleaseId,
      updatedAt: now,
    })
    .where(and(eq(tables.items.tenantId, input.tenantId), eq(tables.items.id, existing.id)));
  return mapConfigMarketRow(artifact, release, {
    downloadCount: await countDownloadsInTransaction(tx, tables.receipts, input.tenantId, artifact.id),
  });
}

type DownloadTables = { items: any; releases: any; receipts: any };

function isDuplicateEntryError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    const candidate = current as { code?: unknown; errno?: unknown; cause?: unknown };
    if (candidate.code === "ER_DUP_ENTRY" || candidate.errno === 1062) return true;
    current = candidate.cause;
  }
  return false;
}

async function recordSqlDownload(
  db: any,
  tables: DownloadTables,
  id: string,
  viewer: ConfigMarketViewer,
  releaseId: string,
  dialect: "postgresql" | "mysql",
): Promise<ConfigMarketDownloadResult | null> {
  return db.transaction(async (tx: any) => {
    const currentRows = (await tx
      .select({ artifact: tables.items, release: tables.releases })
      .from(tables.items)
      .innerJoin(tables.releases, eq(tables.releases.id, tables.items.currentReleaseId))
      .where(and(eq(tables.items.id, id), eq(tables.items.tenantId, viewer.tenantId)))
      .for("update")
      .limit(1)) as Array<{ artifact: ConfigMarketArtifactRow; release: ConfigMarketReleaseRow }>;
    const current = currentRows[0];
    if (!current) return null;

    const item = mapConfigMarketRow(current.artifact, current.release);
    const departmentIds =
      item.userId !== viewer.userId && item.visibility === "departments"
        ? await configMarketViewerDepartmentIds(viewer)
        : [];
    if (!isConfigMarketItemVisible(item, viewer, departmentIds)) return null;

    const releaseRows = (await tx
      .select({ id: tables.releases.id })
      .from(tables.releases)
      .where(
        and(
          eq(tables.releases.id, releaseId),
          eq(tables.releases.tenantId, viewer.tenantId),
          eq(tables.releases.artifactId, item.id),
        ),
      )
      .limit(1)) as Array<{ id: string }>;
    if (!releaseRows[0]) return null;

    const receiptId = ulid();
    const receipt = {
      id: receiptId,
      tenantId: viewer.tenantId,
      itemId: item.id,
      releaseId,
      userId: viewer.userId,
      createdAt: new Date(),
    };
    const insertQuery = tx.insert(tables.receipts).values(receipt);
    let duplicateError: unknown = null;
    if (dialect === "postgresql") {
      // Target the identity key explicitly.  A malformed receipt (or an id
      // collision) must still fail loudly instead of being ignored broadly.
      await insertQuery.onConflictDoNothing({
        target: [
          tables.receipts.tenantId,
          tables.receipts.itemId,
          tables.receipts.releaseId,
          tables.receipts.userId,
        ],
      });
    } else {
      try {
        await insertQuery;
      } catch (error) {
        // MySQL keeps the transaction usable after a duplicate-key error.  Do
        // not use INSERT IGNORE: verify the exact identity below and rethrow
        // unrelated duplicate errors (for example a ULID primary-key clash).
        if (!isDuplicateEntryError(error)) throw error;
        duplicateError = error;
      }
    }

    const matchingReceipts = (await tx
      .select({ id: tables.receipts.id })
      .from(tables.receipts)
      .where(
        and(
          eq(tables.receipts.tenantId, viewer.tenantId),
          eq(tables.receipts.itemId, item.id),
          eq(tables.receipts.releaseId, releaseId),
          eq(tables.receipts.userId, viewer.userId),
        ),
      )
      .limit(1)) as Array<{ id: string }>;
    if (!matchingReceipts[0]) {
      // A duplicate error that does not have the expected identity is not an
      // idempotent retry.  This protects against a primary-key collision and
      // any other unexpected unique constraint.
      if (duplicateError) throw duplicateError;
      throw new Error("market download receipt insert did not produce a receipt");
    }
    const counted = matchingReceipts[0].id === receiptId;
    const countRows = (await tx
      .select({ count: sql<number>`count(*)` })
      .from(tables.receipts)
      .where(and(eq(tables.receipts.tenantId, viewer.tenantId), eq(tables.receipts.itemId, item.id)))) as Array<{
      count: unknown;
    }>;
    return {
      counted,
      downloadCount: normalizeDownloadCount(countRows[0]?.count),
    };
  });
}

export function createSqlStore(): ConfigMarketStore {
  const store: ConfigMarketStore = {
    async create(input) {
      const config = resolveDatabaseConfig();
      if (config.dialect === "mysql") {
        const { raw: db } = await createMysqlDb(config);
        return db.transaction((tx) =>
          publishInTransaction(tx, {
            items: mysqlItems,
            releases: mysqlReleases,
            receipts: mysqlDownloadReceipts,
            tenants: mysqlTenants,
            packs: mysqlPacks,
            members: mysqlMembers,
          }, input),
        );
      }
      return getIamDb().transaction((tx) =>
        publishInTransaction(tx, {
          items: pgItems,
          releases: pgReleases,
          receipts: pgDownloadReceipts,
          tenants: pgTenants,
          packs: pgPacks,
          members: pgMembers,
        }, input),
      );
    },

    async list(tenantId, options = {}) {
      const config = resolveDatabaseConfig();
      if (config.dialect === "mysql") {
        const { raw: db } = await createMysqlDb(config);
        const predicates = [eq(mysqlItems.tenantId, tenantId)];
        if (!options.includeUnlisted) predicates.push(eq(mysqlItems.status, "published"));
        if (options.kind) predicates.push(eq(mysqlItems.kind, options.kind));
        const rows = await db
          .select({
            artifact: mysqlItems,
            release: mysqlReleases,
            downloadCount: downloadCountExpression(mysqlItems, mysqlDownloadReceipts),
          })
          .from(mysqlItems)
          .innerJoin(mysqlReleases, eq(mysqlReleases.id, mysqlItems.currentReleaseId))
          .where(and(...predicates))
          .orderBy(desc(mysqlItems.updatedAt));
        return rows.map((row) => mapConfigMarketRow(row.artifact, row.release, {
          downloadCount: row.downloadCount,
        }));
      }
      const predicates = [eq(pgItems.tenantId, tenantId)];
      if (!options.includeUnlisted) predicates.push(eq(pgItems.status, "published"));
      if (options.kind) predicates.push(eq(pgItems.kind, options.kind));
      const rows = await getIamDb()
        .select({
          artifact: pgItems,
          release: pgReleases,
          downloadCount: downloadCountExpression(pgItems, pgDownloadReceipts),
        })
        .from(pgItems)
        .innerJoin(pgReleases, eq(pgReleases.id, pgItems.currentReleaseId))
        .where(and(...predicates))
        .orderBy(desc(pgItems.updatedAt));
      return rows.map((row) => mapConfigMarketRow(row.artifact, row.release, {
        downloadCount: row.downloadCount,
      }));
    },

    async listVisible(viewer, options = {}) {
      const items = await store.list(viewer.tenantId, { kind: options.kind });
      const needsDepartmentChain = items.some(
        (item) => item.userId !== viewer.userId && item.visibility === "departments",
      );
      const departmentIds = needsDepartmentChain ? await configMarketViewerDepartmentIds(viewer) : [];
      return items.filter((item) => isConfigMarketItemVisible(item, viewer, departmentIds));
    },

    async listVisibleMetadata(viewer, options = {}) {
      const config = resolveDatabaseConfig();
      if (config.dialect === "mysql") {
        const { raw: db } = await createMysqlDb(config);
        return listSqlMetadataPage(
          db,
          { items: mysqlItems, releases: mysqlReleases, receipts: mysqlDownloadReceipts },
          viewer,
          options,
        );
      }
      return listSqlMetadataPage(
        getIamDb(),
        { items: pgItems, releases: pgReleases, receipts: pgDownloadReceipts },
        viewer,
        options,
      );
    },

    async get(id, tenantId, options = {}) {
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
          .where(
            and(
              eq(mysqlItems.id, id),
              eq(mysqlItems.tenantId, tenantId),
              ...(options.includeUnlisted ? [] : [eq(mysqlItems.status, "published")]),
            ),
          )
          .limit(1);
        return rows[0]
          ? mapConfigMarketRow(rows[0].artifact, rows[0].release, {
              downloadCount: rows[0].downloadCount,
            })
          : null;
      }
      const rows = await getIamDb()
        .select({
          artifact: pgItems,
          release: pgReleases,
          downloadCount: downloadCountExpression(pgItems, pgDownloadReceipts),
        })
        .from(pgItems)
        .innerJoin(pgReleases, eq(pgReleases.id, pgItems.currentReleaseId))
        .where(
          and(
            eq(pgItems.id, id),
            eq(pgItems.tenantId, tenantId),
            ...(options.includeUnlisted ? [] : [eq(pgItems.status, "published")]),
          ),
        )
        .limit(1);
      return rows[0]
        ? mapConfigMarketRow(rows[0].artifact, rows[0].release, {
            downloadCount: rows[0].downloadCount,
          })
        : null;
    },

    async getVisible(id, viewer) {
      const item = await store.get(id, viewer.tenantId);
      if (!item) return null;
      const departmentIds =
        item.userId !== viewer.userId && item.visibility === "departments"
          ? await configMarketViewerDepartmentIds(viewer)
          : [];
      return isConfigMarketItemVisible(item, viewer, departmentIds) ? item : null;
    },

    async recordDownload(id, viewer, releaseId) {
      const config = resolveDatabaseConfig();
      if (config.dialect === "mysql") {
        const { raw: db } = await createMysqlDb(config);
        return recordSqlDownload(
          db,
          { items: mysqlItems, releases: mysqlReleases, receipts: mysqlDownloadReceipts },
          id,
          viewer,
          releaseId,
          "mysql",
        );
      }
      return recordSqlDownload(
        getIamDb(),
        { items: pgItems, releases: pgReleases, receipts: pgDownloadReceipts },
        id,
        viewer,
        releaseId,
        "postgresql",
      );
    },

    async setStatus(id, tenantId, status) {
      const target = await store.get(id, tenantId, { includeUnlisted: true });
      if (!target) return null;
      const now = new Date();
      const patch = {
        status,
        updatedAt: now,
        ...(status === "published" ? { publishedAt: now, unlistedAt: null } : { unlistedAt: now }),
      };
      const config = resolveDatabaseConfig();
      if (config.dialect === "mysql") {
        const { raw: db } = await createMysqlDb(config);
        await db.update(mysqlItems).set(patch).where(and(eq(mysqlItems.tenantId, tenantId), eq(mysqlItems.id, id)));
      } else {
        const rows = await getIamDb()
          .update(pgItems)
          .set(patch)
          .where(and(eq(pgItems.tenantId, tenantId), eq(pgItems.id, id)))
          .returning({ id: pgItems.id });
        if (rows.length === 0) return null;
      }
      return store.get(id, tenantId, { includeUnlisted: true });
    },

    async setDeliveryState(id, tenantId, deliveryState) {
      if (deliveryState !== "active" && deliveryState !== "revoked") {
        throw new Error("invalid config market delivery state");
      }
      const target = await store.get(id, tenantId, { includeUnlisted: true });
      if (!target) return null;
      const patch = { deliveryState, updatedAt: new Date() };
      const config = resolveDatabaseConfig();
      if (config.dialect === "mysql") {
        const { raw: db } = await createMysqlDb(config);
        await db
          .update(mysqlItems)
          .set(patch)
          .where(and(eq(mysqlItems.tenantId, tenantId), eq(mysqlItems.id, id)));
      } else {
        const rows = await getIamDb()
          .update(pgItems)
          .set(patch)
          .where(and(eq(pgItems.tenantId, tenantId), eq(pgItems.id, id)))
          .returning({ id: pgItems.id });
        if (rows.length === 0) return null;
      }
      return store.get(id, tenantId, { includeUnlisted: true });
    },
  };
  return store;
}

/** In-memory implementation with the same stable-artifact/immutable-release rules. */
export function createMemoryConfigMarketStore(
  dependencies: { viewerDepartmentIds?: (viewer: ConfigMarketViewer) => Promise<string[]> } = {},
): ConfigMarketStore {
  const rows = new Map<string, ConfigMarketItem>();
  const releaseHistory = new Map<string, Array<{ version: string; digest: string }>>();
  const releaseIds = new Map<string, Set<string>>();
  const downloadReceipts = new Set<string>();
  const viewerDepartmentIds = dependencies.viewerDepartmentIds ?? configMarketViewerDepartmentIds;
  const downloadCountFor = (tenantId: string, itemId: string): number => {
    const prefix = `${tenantId}\u0000${itemId}\u0000`;
    let count = 0;
    for (const key of downloadReceipts) if (key.startsWith(prefix)) count += 1;
    return count;
  };
  const cloneMemoryItem = (item: ConfigMarketItem): ConfigMarketItem => cloneItem({
    ...item,
    downloadCount: downloadCountFor(item.tenantId, item.id),
  });
  const store: ConfigMarketStore = {
    async create(input) {
      const digest = configMarketManifestDigest(input.manifest);
      const existing = [...rows.values()].find(
        (item) =>
          item.tenantId === input.tenantId &&
          item.kind === input.manifest.kind &&
          item.sourceArtifactId === input.manifest.artifact_id,
      );
      const now = new Date().toISOString();
      if (!existing) {
        const item: ConfigMarketItem = {
          id: ulid(),
          tenantId: input.tenantId,
          userId: input.userId,
          ownerDisplayName: input.ownerDisplayName,
          kind: input.manifest.kind,
          sourceArtifactId: input.manifest.artifact_id,
          title: input.manifest.title,
          description: input.manifest.description,
          releaseId: ulid(),
          version: input.manifest.release_version,
          manifestVersion: CONFIG_SHARE_MANIFEST_VERSION,
          digest,
          raw: input.manifest,
          releaseNotes: input.releaseNotes ?? "",
          releasePublishedAt: now,
          downloadCount: 0,
          status: "published",
          deliveryState: "active",
          ...input.audience,
          publishedAt: now,
          unlistedAt: null,
          createdAt: now,
          updatedAt: now,
        };
        rows.set(item.id, cloneItem(item));
        releaseHistory.set(item.id, [{ version: item.version, digest: item.digest }]);
        releaseIds.set(item.id, new Set([item.releaseId]));
        return cloneMemoryItem(item);
      }
      if (existing.userId !== input.userId) throw new ConfigMarketOwnershipConflictError();
      if (existing.status === "unlisted") throw new ConfigMarketPublishBlockedError();
      if (!sameConfigMarketAudience(existing, input.audience)) throw new ConfigMarketAudienceConflictError();
      if (input.manifest.release_version === existing.version) {
        if (digest === existing.digest) return cloneMemoryItem(existing);
        throw new ConfigMarketReleaseVersionConflictError("release version already exists with different content");
      }
      if (compareConfigShareVersions(input.manifest.release_version, existing.version) <= 0) {
        throw new ConfigMarketReleaseVersionConflictError();
      }
      const history = releaseHistory.get(existing.id) ?? [];
      if (history.some((release) => release.version === input.manifest.release_version)) {
        throw new ConfigMarketReleaseVersionConflictError("release version already exists");
      }
      if (history.some((release) => release.digest === digest)) throw new ConfigMarketReleaseDigestConflictError();
      const updated: ConfigMarketItem = {
        ...existing,
        ownerDisplayName: input.ownerDisplayName,
        title: input.manifest.title,
        description: input.manifest.description,
        releaseId: ulid(),
        version: input.manifest.release_version,
        digest,
        raw: input.manifest,
        releaseNotes: input.releaseNotes ?? "",
        releasePublishedAt: now,
        updatedAt: now,
      };
      rows.set(updated.id, cloneItem(updated));
      history.push({ version: updated.version, digest: updated.digest });
      releaseHistory.set(updated.id, history);
      const itemReleaseIds = releaseIds.get(updated.id) ?? new Set<string>();
      itemReleaseIds.add(updated.releaseId);
      releaseIds.set(updated.id, itemReleaseIds);
      return cloneMemoryItem(updated);
    },
    async list(tenantId, options = {}) {
      return [...rows.values()]
        .filter(
          (item) =>
            item.tenantId === tenantId &&
            (options.includeUnlisted || item.status === "published") &&
            (!options.kind || item.kind === options.kind),
        )
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .map(cloneMemoryItem);
    },
    async listVisible(viewer, options = {}) {
      const items = await store.list(viewer.tenantId, { kind: options.kind });
      const needsDepartmentChain = items.some(
        (item) => item.userId !== viewer.userId && item.visibility === "departments",
      );
      const departmentIds = needsDepartmentChain ? await viewerDepartmentIds(viewer) : [];
      return items.filter((item) => isConfigMarketItemVisible(item, viewer, departmentIds));
    },
    async listVisibleMetadata(viewer, options = {}) {
      const limit = Math.max(1, Math.min(MAX_CONFIG_MARKET_LIST_PAGE_SIZE, options.limit ?? 24));
      const cursor = decodeConfigMarketListCursor(options.cursor);
      const sorted = (await store.list(viewer.tenantId, { kind: options.kind })).sort((left, right) =>
        right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id)
      );
      const afterCursor = cursor
        ? sorted.filter((item) =>
            item.updatedAt < cursor.updatedAt.toISOString() ||
            (item.updatedAt === cursor.updatedAt.toISOString() && item.id < cursor.id)
          )
        : sorted;
      const candidates = afterCursor.slice(0, MAX_CONFIG_MARKET_LIST_SCAN_ROWS);
      const needsDepartments = candidates.some(
        (item) => item.userId !== viewer.userId && item.visibility === "departments",
      );
      const departmentIds = needsDepartments ? await viewerDepartmentIds(viewer) : [];
      const visible: ConfigMarketItem[] = [];
      let scanned = 0;
      for (const item of candidates) {
        scanned += 1;
        if (isConfigMarketItemVisible(item, viewer, departmentIds)) visible.push(item);
        if (visible.length === limit) break;
      }
      const last = candidates[scanned - 1];
      return {
        items: visible.map((item) => toConfigMarketMetadata({
          ...item,
          downloadCount: downloadCountFor(item.tenantId, item.id),
        })),
        nextCursor: afterCursor.length > scanned && last
          ? encodeConfigMarketListCursor({
              updatedAt: new Date(last.updatedAt),
              id: last.id,
            })
          : null,
      };
    },
    async get(id, tenantId, options = {}) {
      const item = rows.get(id);
      if (!item || item.tenantId !== tenantId || (!options.includeUnlisted && item.status !== "published")) return null;
      return cloneMemoryItem(item);
    },
    async getVisible(id, viewer) {
      const item = await store.get(id, viewer.tenantId);
      if (!item) return null;
      const departmentIds = item.userId !== viewer.userId && item.visibility === "departments"
        ? await viewerDepartmentIds(viewer)
        : [];
      return isConfigMarketItemVisible(item, viewer, departmentIds) ? item : null;
    },
    async recordDownload(id, viewer, releaseId) {
      const item = rows.get(id);
      if (!item || item.tenantId !== viewer.tenantId) return null;
      const departmentIds = item.userId !== viewer.userId && item.visibility === "departments"
        ? await viewerDepartmentIds(viewer)
        : [];
      if (!isConfigMarketItemVisible(item, viewer, departmentIds)) return null;
      if (!releaseIds.get(id)?.has(releaseId)) return null;

      const receiptKey = `${viewer.tenantId}\u0000${id}\u0000${releaseId}\u0000${viewer.userId}`;
      const counted = !downloadReceipts.has(receiptKey);
      downloadReceipts.add(receiptKey);
      return { counted, downloadCount: downloadCountFor(viewer.tenantId, id) };
    },
    async setStatus(id, tenantId, status) {
      const item = rows.get(id);
      if (!item || item.tenantId !== tenantId) return null;
      const now = new Date().toISOString();
      item.status = status;
      item.updatedAt = now;
      if (status === "published") {
        item.publishedAt = now;
        item.unlistedAt = null;
      } else {
        item.unlistedAt = now;
      }
      return cloneMemoryItem(item);
    },
    async setDeliveryState(id, tenantId, deliveryState) {
      if (deliveryState !== "active" && deliveryState !== "revoked") {
        throw new Error("invalid config market delivery state");
      }
      const item = rows.get(id);
      if (!item || item.tenantId !== tenantId) return null;
      item.deliveryState = deliveryState;
      item.updatedAt = new Date().toISOString();
      return cloneMemoryItem(item);
    },
  };
  return store;
}

export const defaultConfigMarketStore = createSqlStore();
