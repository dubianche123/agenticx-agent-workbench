import {
  datetime,
  index,
  int,
  json,
  mysqlTable,
  text,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";

import { auditColumns, ulid } from "./_shared";
import { tenants } from "./tenants";

/**
 * 企业数字专家广场中的稳定作品。
 *
 * id 是能力包引用的稳定 artifact id；发布新版本只推进 currentReleaseId，不再生成新的
 * capability id。市场上下架只影响员工货架；delivery_state 独立控制能力包的强制下发。
 */
export const enterpriseConfigMarketItems = mysqlTable(
  "enterprise_config_market_items",
  {
    id: ulid("id").primaryKey(),
    tenantId: ulid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** Keep attribution after an employee account is removed. */
    userId: ulid("user_id").notNull(),
    ownerDisplayName: varchar("owner_display_name", { length: 160 }).notNull(),
    kind: varchar("kind", { length: 16 }).notNull(),
    /** Publisher-owned portable manifest UUID; capability packs never reference this value. */
    sourceArtifactId: varchar("source_artifact_id", { length: 128 }).notNull(),
    title: varchar("title", { length: 160 }).notNull(),
    description: text("description").notNull(),
    /** Application-enforced FK to enterprise_config_market_releases; avoids a circular DDL FK. */
    currentReleaseId: ulid("current_release_id").notNull(),
    visibility: varchar("visibility", { length: 16 })
      .$type<"company" | "departments" | "users" | "personal" | "admins_only">()
      .notNull(),
    visibleDepartmentIds: json("visible_department_ids").$type<string[]>().notNull(),
    visibleUserIds: json("visible_user_ids").$type<string[]>().notNull(),
    status: varchar("status", { length: 16 }).notNull().default("published"),
    /** Market listing status and forced delivery are independent administrator controls. */
    deliveryState: varchar("delivery_state", { length: 16 })
      .$type<"active" | "revoked">()
      .notNull()
      .default("active"),
    publishedAt: datetime("published_at", { fsp: 6 }).notNull(),
    unlistedAt: datetime("unlisted_at", { fsp: 6 }),
    ...auditColumns,
  },
  (table) => ({
    tenantStatusCreatedIdx: index("enterprise_config_market_tenant_status_created_idx").on(
      table.tenantId,
      table.status,
      table.createdAt,
    ),
    tenantKindStatusIdx: index("enterprise_config_market_tenant_kind_status_idx").on(
      table.tenantId,
      table.kind,
      table.status,
    ),
    tenantCurrentReleaseUq: uniqueIndex("enterprise_config_market_tenant_current_release_uq").on(
      table.tenantId,
      table.currentReleaseId,
    ),
    tenantSourceArtifactUq: uniqueIndex("enterprise_config_market_tenant_source_artifact_uq").on(
      table.tenantId,
      table.kind,
      table.sourceArtifactId,
    ),
  }),
);

/** Immutable release bytes for one stable market artifact. */
export const enterpriseConfigMarketReleases = mysqlTable(
  "enterprise_config_market_releases",
  {
    id: ulid("id").primaryKey(),
    tenantId: ulid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    artifactId: ulid("artifact_id")
      .notNull()
      .references(() => enterpriseConfigMarketItems.id, { onDelete: "cascade" }),
    version: varchar("version", { length: 64 }).notNull(),
    manifestVersion: int("manifest_version").notNull(),
    manifestDigest: varchar("manifest_digest", { length: 64 }).notNull(),
    manifest: json("manifest").$type<Record<string, unknown>>().notNull(),
    releaseNotes: text("release_notes").notNull(),
    publishedAt: datetime("published_at", { fsp: 6 }).notNull(),
    ...auditColumns,
  },
  (table) => ({
    tenantArtifactVersionUq: uniqueIndex("enterprise_config_market_release_artifact_version_uq").on(
      table.tenantId,
      table.artifactId,
      table.version,
    ),
    tenantArtifactDigestUq: uniqueIndex("enterprise_config_market_release_artifact_digest_uq").on(
      table.tenantId,
      table.artifactId,
      table.manifestDigest,
    ),
    tenantArtifactPublishedIdx: index("enterprise_config_market_release_artifact_published_idx").on(
      table.tenantId,
      table.artifactId,
      table.publishedAt,
    ),
  }),
);

export type EnterpriseConfigMarketItemRow = typeof enterpriseConfigMarketItems.$inferSelect;
export type NewEnterpriseConfigMarketItemRow = typeof enterpriseConfigMarketItems.$inferInsert;
export type EnterpriseConfigMarketReleaseRow = typeof enterpriseConfigMarketReleases.$inferSelect;
export type NewEnterpriseConfigMarketReleaseRow = typeof enterpriseConfigMarketReleases.$inferInsert;
