import { integer, jsonb, pgTable, timestamp, varchar } from "drizzle-orm/pg-core";

/**
 * Immutable expert/group configuration snapshots behind opaque share tokens.
 *
 * There is deliberately no discovery metadata or listing index: these records
 * are reachable only when an authenticated member already knows the token.
 */
export const enterpriseConfigShareSnapshots = pgTable(
  "enterprise_config_share_snapshots",
  {
    token: varchar("token", { length: 64 }).primaryKey(),
    tenantId: varchar("tenant_id", { length: 26 }).notNull(),
    userId: varchar("user_id", { length: 26 }).notNull(),
    ownerDisplayName: varchar("owner_display_name", { length: 160 }).notNull(),
    kind: varchar("kind", { length: 16 }).notNull(),
    manifestVersion: integer("manifest_version").notNull(),
    title: varchar("title", { length: 160 }).notNull(),
    manifest: jsonb("manifest").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
);

export type EnterpriseConfigShareSnapshotRow =
  typeof enterpriseConfigShareSnapshots.$inferSelect;
export type NewEnterpriseConfigShareSnapshotRow =
  typeof enterpriseConfigShareSnapshots.$inferInsert;
