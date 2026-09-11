-- This feature was not deployed. Replace the unpublished v1 rows instead of carrying a
-- compatibility/backfill path into production.
-- MySQL DDL commits implicitly. Disable FK checks only for this connection while replacing the
-- unpublished tables so a retry can recover even when a previous run already added the pack FK.
SET FOREIGN_KEY_CHECKS = 0;
--> statement-breakpoint
DROP TABLE IF EXISTS `enterprise_config_market_releases`;
--> statement-breakpoint
DROP TABLE IF EXISTS `enterprise_config_market_items`;
--> statement-breakpoint
SET FOREIGN_KEY_CHECKS = 1;
--> statement-breakpoint
CREATE TABLE `enterprise_config_market_items` (
  `id` varchar(26) NOT NULL,
  `tenant_id` varchar(26) NOT NULL,
  `user_id` varchar(26) NOT NULL,
  `owner_display_name` varchar(160) NOT NULL,
  `kind` varchar(16) NOT NULL,
  `source_artifact_id` varchar(128) NOT NULL,
  `title` varchar(160) NOT NULL,
  `description` text NOT NULL,
  `current_release_id` varchar(26) NOT NULL,
  `visibility` varchar(16) NOT NULL,
  `visible_department_ids` json NOT NULL,
  `visible_user_ids` json NOT NULL,
  `status` varchar(16) NOT NULL DEFAULT 'published',
  `published_at` datetime(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  `unlisted_at` datetime(6),
  `created_at` datetime(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  `updated_at` datetime(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  CONSTRAINT `enterprise_config_market_items_id` PRIMARY KEY (`id`),
  CONSTRAINT `enterprise_config_market_items_tenant_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE,
  UNIQUE INDEX `enterprise_config_market_tenant_current_release_uq` (`tenant_id`, `current_release_id`),
  UNIQUE INDEX `enterprise_config_market_tenant_source_artifact_uq` (`tenant_id`, `kind`, `source_artifact_id`),
  INDEX `enterprise_config_market_tenant_status_created_idx` (`tenant_id`, `status`, `created_at`),
  INDEX `enterprise_config_market_tenant_kind_status_idx` (`tenant_id`, `kind`, `status`)
);
--> statement-breakpoint
CREATE TABLE `enterprise_config_market_releases` (
  `id` varchar(26) NOT NULL,
  `tenant_id` varchar(26) NOT NULL,
  `artifact_id` varchar(26) NOT NULL,
  `version` varchar(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `manifest_version` int NOT NULL,
  `manifest_digest` varchar(64) NOT NULL,
  `manifest` json NOT NULL,
  `release_notes` text NOT NULL,
  `published_at` datetime(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  `created_at` datetime(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  `updated_at` datetime(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  CONSTRAINT `enterprise_config_market_releases_id` PRIMARY KEY (`id`),
  CONSTRAINT `enterprise_config_market_releases_tenant_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE,
  CONSTRAINT `enterprise_config_market_releases_artifact_fk` FOREIGN KEY (`artifact_id`) REFERENCES `enterprise_config_market_items`(`id`) ON DELETE CASCADE,
  UNIQUE INDEX `enterprise_config_market_release_artifact_version_uq` (`tenant_id`, `artifact_id`, `version`),
  UNIQUE INDEX `enterprise_config_market_release_artifact_digest_uq` (`tenant_id`, `artifact_id`, `manifest_digest`),
  INDEX `enterprise_config_market_release_artifact_published_idx` (`tenant_id`, `artifact_id`, `published_at`)
);
--> statement-breakpoint
ALTER TABLE `enterprise_capability_pack_members`
  ADD COLUMN `release_policy` varchar(16);
--> statement-breakpoint
ALTER TABLE `enterprise_capability_pack_members`
  ADD COLUMN `pinned_release_id` varchar(26);
--> statement-breakpoint
ALTER TABLE `enterprise_capability_pack_members`
  ADD CONSTRAINT `enterprise_capability_pack_members_pinned_release_fk`
    FOREIGN KEY (`pinned_release_id`) REFERENCES `enterprise_config_market_releases`(`id`) ON DELETE RESTRICT;
