import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  pgTable,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";

import { auditColumns, ulid } from "./_shared";
import { departments } from "./departments";
import { organizations } from "./organizations";
import { principals } from "./principals";
import { roles } from "./roles";
import { tenants } from "./tenants";
import { users } from "./users";

export type DataScope = "self" | "department" | "department_subtree" | "tenant";
export type PrincipalBindingStatus = "active" | "revoked";
export type BindingResolution = "resolved" | "unresolved";
export type PrincipalBindingSource = "legacy" | "explicit";

/**
 * Explicit role-to-principal grant.  Scope and action stay on the same row;
 * authorization must never union all actions and all departments separately.
 */
export const principalRoleBindings = pgTable(
  "principal_role_bindings",
  {
    id: ulid("id").primaryKey(),
    tenantId: ulid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    principalId: ulid("principal_id").notNull(),
    roleId: ulid("role_id").notNull(),
    dataScope: varchar("data_scope", { length: 24 }).$type<DataScope>().notNull(),
    scopeOrgId: ulid("scope_org_id"),
    scopeDeptId: ulid("scope_dept_id"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    /** Principal that owns the authority being granted.  Null is retained
     * only for historical legacy rows whose original grantor is unknown. */
    grantedByPrincipalId: ulid("granted_by_principal_id"),
    /** Whether this binding may be used as an upstream delegation source. */
    canDelegate: boolean("can_delegate").notNull().default(false),
    /** Connector/approval reference for a grant approved outside this app. */
    grantorApprovalRef: varchar("grantor_approval_ref", { length: 160 }),
    status: varchar("status", { length: 16 }).$type<PrincipalBindingStatus>().notNull().default("active"),
    resolution: varchar("resolution", { length: 16 })
      .$type<BindingResolution>()
      .notNull()
      .default("resolved"),
    resolutionReason: varchar("resolution_reason", { length: 512 }),
    source: varchar("source", { length: 16 }).$type<PrincipalBindingSource>().notNull().default("explicit"),
    createdByUserId: ulid("created_by_user_id"),
    ...auditColumns,
  },
  (table) => ({
    dataScopeCheck: check(
      "principal_role_bindings_data_scope_check",
      sql`${table.dataScope} in ('self', 'department', 'department_subtree', 'tenant')`,
    ),
    statusCheck: check(
      "principal_role_bindings_status_check",
      sql`${table.status} in ('active', 'revoked')`,
    ),
    resolutionCheck: check(
      "principal_role_bindings_resolution_check",
      sql`${table.resolution} in ('resolved', 'unresolved')`,
    ),
    sourceCheck: check(
      "principal_role_bindings_source_check",
      sql`${table.source} in ('legacy', 'explicit')`,
    ),
    departmentScopeCheck: check(
      "principal_role_bindings_department_scope_check",
      sql`(${table.dataScope} in ('department', 'department_subtree') and ${table.scopeDeptId} is not null) or (${table.dataScope} in ('self', 'tenant') and ${table.scopeDeptId} is null)`,
    ),
    tenantPrincipalFk: foreignKey({
      name: "principal_role_bindings_principal_tenant_fk",
      columns: [table.principalId, table.tenantId],
      foreignColumns: [principals.id, principals.tenantId],
    }).onDelete("cascade"),
    grantedByPrincipalTenantFk: foreignKey({
      name: "principal_role_bindings_granted_by_principal_tenant_fk",
      columns: [table.grantedByPrincipalId, table.tenantId],
      foreignColumns: [principals.id, principals.tenantId],
    }).onDelete("restrict"),
    roleTenantFk: foreignKey({
      name: "principal_role_bindings_role_tenant_fk",
      columns: [table.roleId, table.tenantId],
      foreignColumns: [roles.id, roles.tenantId],
    }).onDelete("restrict"),
    scopeOrgFk: foreignKey({
      name: "principal_role_bindings_scope_org_fk",
      columns: [table.scopeOrgId, table.tenantId],
      foreignColumns: [organizations.id, organizations.tenantId],
    }).onDelete("restrict"),
    scopeDeptFk: foreignKey({
      name: "principal_role_bindings_scope_dept_fk",
      columns: [table.scopeDeptId, table.tenantId],
      foreignColumns: [departments.id, departments.tenantId],
    }).onDelete("restrict"),
    createdByUserFk: foreignKey({
      name: "principal_role_bindings_created_by_user_fk",
      columns: [table.createdByUserId, table.tenantId],
      foreignColumns: [users.id, users.tenantId],
    }).onDelete("restrict"),
    tenantPrincipalIdx: index("principal_role_bindings_tenant_principal_idx").on(
      table.tenantId,
      table.principalId,
      table.status,
      table.expiresAt,
    ),
    tenantRoleIdx: index("principal_role_bindings_tenant_role_idx").on(table.tenantId, table.roleId),
    grantorIdx: index("principal_role_bindings_grantor_idx").on(table.tenantId, table.grantedByPrincipalId),
  }),
);

export type PrincipalRoleBinding = typeof principalRoleBindings.$inferSelect;
export type NewPrincipalRoleBinding = typeof principalRoleBindings.$inferInsert;
