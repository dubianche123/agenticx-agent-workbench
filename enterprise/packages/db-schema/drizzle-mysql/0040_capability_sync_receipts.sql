-- Desktop PAT capability synchronisation receipts (MySQL 8).
-- api_token_id is the server-derived device instance, never a client field.

CREATE TABLE IF NOT EXISTS `enterprise_capability_sync_receipts` (
  `id` varchar(26) NOT NULL,
  `tenant_id` varchar(26) NOT NULL,
  `user_id` varchar(26) NOT NULL,
  `api_token_id` bigint NOT NULL,
  `capability_id` varchar(64) NOT NULL,
  `kind` varchar(8) NOT NULL,
  `status` varchar(16) NOT NULL,
  `version` varchar(64),
  `digest` varchar(64),
  `error_code` varchar(64),
  `message` varchar(1024),
  `attempted_at` datetime(6) NOT NULL,
  `applied_at` datetime(6),
  `created_at` datetime(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  `updated_at` datetime(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  CONSTRAINT `cap_sync_receipts_id` PRIMARY KEY (`id`),
  CONSTRAINT `cap_sync_receipts_tenant_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE,
  CONSTRAINT `cap_sync_receipts_user_tenant_fk` FOREIGN KEY (`user_id`, `tenant_id`) REFERENCES `users`(`id`, `tenant_id`) ON DELETE RESTRICT,
  CONSTRAINT `cap_sync_receipts_api_token_fk` FOREIGN KEY (`api_token_id`) REFERENCES `api_tokens`(`id`) ON DELETE CASCADE,
  CONSTRAINT `cap_sync_receipts_kind_check` CHECK (`kind` IN ('skill', 'mcp')),
  CONSTRAINT `cap_sync_receipts_status_check` CHECK (`status` IN ('pending', 'applied', 'failed')),
  CONSTRAINT `cap_sync_receipts_digest_check` CHECK (`digest` IS NULL OR `digest` REGEXP '^[0-9A-Fa-f]{64}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cap_sync_receipts_identity_capability_uq`
  ON `enterprise_capability_sync_receipts` (`tenant_id`, `user_id`, `api_token_id`, `capability_id`);
--> statement-breakpoint
CREATE INDEX `cap_sync_receipts_identity_time_idx`
  ON `enterprise_capability_sync_receipts` (`tenant_id`, `user_id`, `api_token_id`, `capability_id`, `updated_at`);
--> statement-breakpoint
CREATE INDEX `cap_sync_receipts_tenant_time_idx`
  ON `enterprise_capability_sync_receipts` (`tenant_id`, `updated_at`);
