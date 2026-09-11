import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  pgTable,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";

import { apiTokens } from "./api-tokens";
import { auditColumns, ulid } from "./_shared";
import { tenants } from "./tenants";
import { users } from "./users";

/**
 * Desktop capability synchronisation receipts.
 *
 * `apiTokenId` is the trusted device instance: Desktop PATs are issued per
 * device login and the API derives this value from the verified bearer token.
 * It is deliberately not accepted from the request body.
 */
export const enterpriseCapabilitySyncReceipts = pgTable(
  "enterprise_capability_sync_receipts",
  {
    id: ulid("id").primaryKey(),
    tenantId: ulid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    userId: ulid("user_id").notNull(),
    apiTokenId: bigint("api_token_id", { mode: "number" })
      .notNull()
      .references(() => apiTokens.id, { onDelete: "cascade" }),
    capabilityId: varchar("capability_id", { length: 64 }).notNull(),
    kind: varchar("kind", { length: 8 }).$type<"skill" | "mcp">().notNull(),
    status: varchar("status", { length: 16 })
      .$type<"pending" | "applied" | "failed">()
      .notNull(),
    version: varchar("version", { length: 64 }),
    digest: varchar("digest", { length: 64 }),
    errorCode: varchar("error_code", { length: 64 }),
    message: varchar("message", { length: 1024 }),
    attemptedAt: timestamp("attempted_at", { withTimezone: true }).notNull(),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    ...auditColumns,
  },
  (table) => ({
    kindCheck: check(
      "cap_sync_receipts_kind_check",
      sql`${table.kind} in ('skill', 'mcp')`,
    ),
    statusCheck: check(
      "cap_sync_receipts_status_check",
      sql`${table.status} in ('pending', 'applied', 'failed')`,
    ),
    digestCheck: check(
      "cap_sync_receipts_digest_check",
      sql`${table.digest} is null or ${table.digest} ~ '^[0-9A-Fa-f]{64}$'`,
    ),
    userTenantFk: foreignKey({
      name: "cap_sync_receipts_user_tenant_fk",
      columns: [table.userId, table.tenantId],
      foreignColumns: [users.id, users.tenantId],
    }).onDelete("restrict"),
    identityCapabilityUq: uniqueIndex("cap_sync_receipts_identity_capability_uq").on(
      table.tenantId,
      table.userId,
      table.apiTokenId,
      table.capabilityId,
    ),
    identityTimeIdx: index("cap_sync_receipts_identity_time_idx").on(
      table.tenantId,
      table.userId,
      table.apiTokenId,
      table.capabilityId,
      table.updatedAt,
    ),
    tenantTimeIdx: index("cap_sync_receipts_tenant_time_idx").on(
      table.tenantId,
      table.updatedAt,
    ),
  }),
);

export type EnterpriseCapabilitySyncReceiptRow =
  typeof enterpriseCapabilitySyncReceipts.$inferSelect;
export type NewEnterpriseCapabilitySyncReceiptRow =
  typeof enterpriseCapabilitySyncReceipts.$inferInsert;
