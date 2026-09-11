import { sql } from "drizzle-orm";
import { datetime, int, json, mysqlTable, varchar } from "drizzle-orm/mysql-core";

/**
 * Immutable expert/group configuration snapshots behind opaque share tokens.
 *
 * There is deliberately no discovery metadata or listing index: these records
 * are reachable only when an authenticated member already knows the token.
 */
export const enterpriseConfigShareSnapshots = mysqlTable(
  "enterprise_config_share_snapshots",
  {
    token: varchar("token", { length: 64 }).primaryKey(),
    tenantId: varchar("tenant_id", { length: 26 }).notNull(),
    userId: varchar("user_id", { length: 26 }).notNull(),
    ownerDisplayName: varchar("owner_display_name", { length: 160 }).notNull(),
    kind: varchar("kind", { length: 16 }).notNull(),
    manifestVersion: int("manifest_version").notNull(),
    title: varchar("title", { length: 160 }).notNull(),
    manifest: json("manifest").$type<Record<string, unknown>>().notNull(),
    createdAt: datetime("created_at", { fsp: 6 }).default(sql`(UTC_TIMESTAMP(6))`).notNull(),
    revokedAt: datetime("revoked_at", { fsp: 6 }),
  },
);

export type EnterpriseConfigShareSnapshotRow =
  typeof enterpriseConfigShareSnapshots.$inferSelect;
export type NewEnterpriseConfigShareSnapshotRow =
  typeof enterpriseConfigShareSnapshots.$inferInsert;
