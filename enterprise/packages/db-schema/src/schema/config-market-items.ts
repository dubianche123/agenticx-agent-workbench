import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";

import { auditColumns, ulid } from "./_shared";
import { tenants } from "./tenants";

/** PostgreSQL parity mirror; production source of truth is the MySQL schema. */
export const enterpriseConfigMarketItems = pgTable(
  "enterprise_config_market_items",
  {
    id: ulid("id").primaryKey(),
    tenantId: ulid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    userId: ulid("user_id").notNull(),
    ownerDisplayName: varchar("owner_display_name", { length: 160 }).notNull(),
    kind: varchar("kind", { length: 16 }).notNull(),
    sourceArtifactId: varchar("source_artifact_id", { length: 128 }).notNull(),
    title: varchar("title", { length: 160 }).notNull(),
    description: text("description").notNull(),
    currentReleaseId: ulid("current_release_id").notNull(),
    visibility: varchar("visibility", { length: 16 })
      .$type<"company" | "departments" | "users" | "personal" | "admins_only">()
      .notNull(),
    visibleDepartmentIds: jsonb("visible_department_ids").$type<string[]>().notNull(),
    visibleUserIds: jsonb("visible_user_ids").$type<string[]>().notNull(),
    status: varchar("status", { length: 16 }).notNull().default("published"),
    /** Market listing status and forced delivery are independent administrator controls. */
    deliveryState: varchar("delivery_state", { length: 16 })
      .$type<"active" | "revoked">()
      .notNull()
      .default("active"),
    publishedAt: timestamp("published_at", { withTimezone: true }).defaultNow().notNull(),
    unlistedAt: timestamp("unlisted_at", { withTimezone: true }),
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

export const enterpriseConfigMarketReleases = pgTable(
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
    manifestVersion: integer("manifest_version").notNull(),
    manifestDigest: varchar("manifest_digest", { length: 64 }).notNull(),
    manifest: jsonb("manifest").$type<Record<string, unknown>>().notNull(),
    releaseNotes: text("release_notes").notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }).defaultNow().notNull(),
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
