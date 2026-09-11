import { sql } from "drizzle-orm";
import {
  datetime,
  index,
  mysqlTable,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";

import { ulid } from "./_shared";
import { enterpriseConfigMarketItems, enterpriseConfigMarketReleases } from "./config-market-items";
import { tenants } from "./tenants";

/** MySQL counterpart of the immutable market download/import receipt log. */
export const enterpriseConfigMarketDownloadReceipts = mysqlTable(
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
    createdAt: datetime("created_at", { fsp: 6 })
      .default(sql`(UTC_TIMESTAMP(6))`)
      .notNull(),
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
