import { foreignKey, index, mysqlTable, primaryKey } from "drizzle-orm/mysql-core";
import { auditColumns, ulid } from "./_shared";
import { departments } from "./departments";
import { organizations } from "./organizations";
import { roles } from "./roles";
import { tenants } from "./tenants";
import { users } from "./users";

export const userRoles = mysqlTable(
  "user_roles",
  {
    tenantId: ulid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    userId: ulid("user_id").notNull(),
    roleId: ulid("role_id").notNull(),
    scopeOrgId: ulid("scope_org_id"),
    scopeDeptId: ulid("scope_dept_id"),
    ...auditColumns,
  },
  (table) => ({
    pk: primaryKey({ columns: [table.tenantId, table.userId, table.roleId], name: "user_roles_pk" }),
    tenantUserIdx: index("user_roles_tenant_user_idx").on(table.tenantId, table.userId),
    userTenantFk: foreignKey({
      name: "user_roles_user_tenant_fk",
      columns: [table.userId, table.tenantId],
      foreignColumns: [users.id, users.tenantId],
    }).onDelete("cascade"),
    roleTenantFk: foreignKey({
      name: "user_roles_role_tenant_fk",
      columns: [table.roleId, table.tenantId],
      foreignColumns: [roles.id, roles.tenantId],
    }).onDelete("restrict"),
    scopeOrgTenantFk: foreignKey({
      name: "user_roles_scope_org_tenant_fk",
      columns: [table.scopeOrgId, table.tenantId],
      foreignColumns: [organizations.id, organizations.tenantId],
    }).onDelete("restrict"),
    scopeDeptTenantFk: foreignKey({
      name: "user_roles_scope_dept_tenant_fk",
      columns: [table.scopeDeptId, table.tenantId],
      foreignColumns: [departments.id, departments.tenantId],
    }).onDelete("restrict"),
  })
);

export type UserRole = typeof userRoles.$inferSelect;
export type NewUserRole = typeof userRoles.$inferInsert;
