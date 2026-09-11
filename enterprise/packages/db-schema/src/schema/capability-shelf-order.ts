import { index, integer, pgTable, primaryKey, varchar } from "drizzle-orm/pg-core";

import { auditColumns, ulid } from "./_shared";
import { tenants } from "./tenants";

/** Tenant-scoped presentation order for the unified admin capability shelf. */
export const enterpriseCapabilityShelfOrder = pgTable(
  "enterprise_capability_shelf_order",
  {
    tenantId: ulid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    capabilityId: varchar("capability_id", { length: 64 }).notNull(),
    position: integer("position").notNull(),
    ...auditColumns,
  },
  (table) => ({
    pk: primaryKey({ columns: [table.tenantId, table.capabilityId] }),
    tenantPositionIdx: index("enterprise_capability_shelf_order_tenant_position_idx").on(
      table.tenantId,
      table.position,
      table.capabilityId,
    ),
  }),
);

export type EnterpriseCapabilityShelfOrderRow = typeof enterpriseCapabilityShelfOrder.$inferSelect;
export type NewEnterpriseCapabilityShelfOrderRow = typeof enterpriseCapabilityShelfOrder.$inferInsert;
