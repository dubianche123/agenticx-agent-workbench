import { foreignKey, index, json, mysqlTable, varchar } from "drizzle-orm/mysql-core";
import { auditColumns, ulid } from "./_shared";
import { principals } from "./principals";
import { tenants } from "./tenants";
import { users } from "./users";

export const auditEvents = mysqlTable(
  "audit_events",
  {
    id: ulid("id").primaryKey(),
    tenantId: ulid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    actorUserId: ulid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    actorPrincipalId: ulid("actor_principal_id"),
    grantorPrincipalId: ulid("grantor_principal_id"),
    eventType: varchar("event_type", { length: 64 }).notNull(),
    targetKind: varchar("target_kind", { length: 32 }).notNull(),
    targetId: varchar("target_id", { length: 64 }),
    detail: json("detail").$type<Record<string, unknown>>(),
    ...auditColumns,
  },
  (table) => ({
    tenantTimeIdx: index("audit_events_tenant_time_idx").on(table.tenantId, table.createdAt),
    targetIdx: index("audit_events_target_idx").on(table.tenantId, table.targetKind, table.targetId),
    actorPrincipalTenantFk: foreignKey({
      name: "audit_events_actor_principal_tenant_fk",
      columns: [table.actorPrincipalId, table.tenantId],
      foreignColumns: [principals.id, principals.tenantId],
    }).onDelete("restrict"),
    grantorPrincipalTenantFk: foreignKey({
      name: "audit_events_grantor_principal_tenant_fk",
      columns: [table.grantorPrincipalId, table.tenantId],
      foreignColumns: [principals.id, principals.tenantId],
    }).onDelete("restrict"),
    principalsIdx: index("audit_events_principals_idx").on(table.tenantId, table.grantorPrincipalId, table.actorPrincipalId),
  })
);

export type AuditEvent = typeof auditEvents.$inferSelect;
export type NewAuditEvent = typeof auditEvents.$inferInsert;
