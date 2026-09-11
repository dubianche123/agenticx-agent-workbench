import {
  index,
  pgTable,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";

import { ulid } from "./_shared";
import { enterpriseConfigMarketItems, enterpriseConfigMarketReleases } from "./config-market-items";
import { tenants } from "./tenants";

/**
 * One successful employee download/import of one immutable market release.
 *
 * The identity unique key is the idempotency boundary.  Counts are derived
 * from this append-only receipt set instead of a mutable counter so retries,
 * concurrent reports, and release history remain auditable.
 */
export const enterpriseConfigMarketDownloadReceipts = pgTable(
  "enterprise_config_market_download_receipts",
  {
    id: ulid("id").primaryKey(),
    tenantId: ulid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    itemId: ulid("item_id")
      .notNull()
      .references(() => enterpriseConfigMarketItems.id, { onDelete: "cascade" }),
    releaseId: ulid("release_id")
      .notNull()
      .references(() => enterpriseConfigMarketReleases.id, { onDelete: "cascade" }),
    userId: ulid("user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    identityReleaseUserUq: uniqueIndex(
      "enterprise_config_market_download_receipts_identity_uq",
    ).on(table.tenantId, table.itemId, table.releaseId, table.userId),
    tenantItemIdx: index("enterprise_config_market_download_receipts_tenant_item_idx").on(
      table.tenantId,
      table.itemId,
    ),
  }),
);

export type EnterpriseConfigMarketDownloadReceiptRow =
  typeof enterpriseConfigMarketDownloadReceipts.$inferSelect;
export type NewEnterpriseConfigMarketDownloadReceiptRow =
  typeof enterpriseConfigMarketDownloadReceipts.$inferInsert;
