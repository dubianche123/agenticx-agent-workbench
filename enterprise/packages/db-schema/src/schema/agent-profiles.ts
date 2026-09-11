import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, pgTable, timestamp, uniqueIndex, varchar } from "drizzle-orm/pg-core";

import { auditColumns, ulid } from "./_shared";
import { principals } from "./principals";
import { tenants } from "./tenants";
import { users } from "./users";

export type AgentMode = "delegated" | "service";

/** Additional durable metadata for agent principals.  Authority comes from
 * principal role bindings; ownerUserId is an audit/delegation relationship
 * and never causes owner permissions to be inherited. */
export const agentProfiles = pgTable(
  "agent_profiles",
  {
    principalId: ulid("principal_id").primaryKey(),
    tenantId: ulid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    mode: varchar("mode", { length: 16 }).$type<AgentMode>().notNull(),
    ownerUserId: ulid("owner_user_id"),
    definitionRef: varchar("definition_ref", { length: 128 }),
    definitionVersion: integer("definition_version").notNull().default(1),
    ...auditColumns,
  },
  (table) => ({
    modeCheck: check("agent_profiles_mode_check", sql`${table.mode} in ('delegated', 'service')`),
    principalTenantUq: uniqueIndex("agent_profiles_principal_tenant_uq").on(table.principalId, table.tenantId),
    tenantModeIdx: index("agent_profiles_tenant_mode_idx").on(table.tenantId, table.mode),
    principalTenantFk: foreignKey({
      name: "agent_profiles_principal_tenant_fk",
      columns: [table.principalId, table.tenantId],
      foreignColumns: [principals.id, principals.tenantId],
    }).onDelete("cascade"),
    ownerTenantFk: foreignKey({
      name: "agent_profiles_owner_tenant_fk",
      columns: [table.ownerUserId, table.tenantId],
      foreignColumns: [users.id, users.tenantId],
    }).onDelete("restrict"),
  }),
);

export type AgentProfile = typeof agentProfiles.$inferSelect;
export type NewAgentProfile = typeof agentProfiles.$inferInsert;
