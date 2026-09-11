-- Successful employee downloads/imports of immutable configuration-market releases.
-- The identity unique key makes retries and concurrent reports idempotent; counts
-- are derived from this receipt set rather than a mutable counter.

CREATE TABLE IF NOT EXISTS `enterprise_config_market_download_receipts` (
  `id` varchar(26) NOT NULL,
  `tenant_id` varchar(26) NOT NULL,
  `item_id` varchar(26) NOT NULL,
  `release_id` varchar(26) NOT NULL,
  `user_id` varchar(26) NOT NULL,
  `created_at` datetime(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  CONSTRAINT `enterprise_config_market_download_receipts_id` PRIMARY KEY (`id`),
  CONSTRAINT `enterprise_config_market_download_receipts_tenant_fk`
    FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE,
  CONSTRAINT `enterprise_config_market_download_receipts_item_fk`
    FOREIGN KEY (`item_id`) REFERENCES `enterprise_config_market_items`(`id`) ON DELETE CASCADE,
  CONSTRAINT `enterprise_config_market_download_receipts_release_fk`
    FOREIGN KEY (`release_id`) REFERENCES `enterprise_config_market_releases`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX `enterprise_config_market_download_receipts_identity_uq`
  ON `enterprise_config_market_download_receipts` (`tenant_id`, `item_id`, `release_id`, `user_id`);
--> statement-breakpoint
CREATE INDEX `enterprise_config_market_download_receipts_tenant_item_idx`
  ON `enterprise_config_market_download_receipts` (`tenant_id`, `item_id`);
