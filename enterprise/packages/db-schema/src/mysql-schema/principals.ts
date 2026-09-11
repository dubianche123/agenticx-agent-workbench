import { sql } from "drizzle-orm";
import { check, foreignKey, index, int, mysqlTable, uniqueIndex, varchar } from "drizzle-orm/mysql-core";

import { auditColumns, ulid } from "./_shared";
import { tenants } from "./tenants";
import { users } from "./users";

export type PrincipalKind = "user" | "agent";
export type PrincipalStatus = "active" | "disabled";

/** MySQL counterpart of the durable authorization principal table. */
export const principals = mysqlTable(
  "principals",
  {
    id: ulid("id").primaryKey(),
    tenantId: ulid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    kind: varchar("kind", { length: 16 }).$type<PrincipalKind>().notNull(),
    userId: ulid("user_id"),
    displayName: varchar("display_name", { length: 128 }),
    status: varchar("status", { length: 16 }).$type<PrincipalStatus>().notNull().default("active"),
    authzVersion: int("authz_version").notNull().default(1),
    ...auditColumns,
  },
  (table) => ({
    kindCheck: check("principals_kind_check", sql`${table.kind} in ('user', 'agent')`),
    statusCheck: check("principals_status_check", sql`${table.status} in ('active', 'disabled')`),
    kindUserCheck: check(
      "principals_kind_user_check",
      sql`(${table.kind} = 'user' and ${table.userId} is not null) or (${table.kind} = 'agent' and ${table.userId} is null)`,
    ),
    tenantKindIdx: index("principals_tenant_kind_idx").on(table.tenantId, table.kind, table.status),
    tenantUserUq: uniqueIndex("principals_tenant_user_uq").on(table.tenantId, table.userId),
    idTenantUq: uniqueIndex("principals_id_tenant_uq").on(table.id, table.tenantId),
    userTenantFk: foreignKey({
      name: "principals_user_tenant_fk",
      columns: [table.userId, table.tenantId],
      foreignColumns: [users.id, users.tenantId],
    }).onDelete("restrict"),
  }),
);

export type Principal = typeof principals.$inferSelect;
export type NewPrincipal = typeof principals.$inferInsert;
