CREATE TABLE IF NOT EXISTS `enterprise_config_share_snapshots` (
  `token` varchar(64) NOT NULL,
  `tenant_id` varchar(26) NOT NULL,
  `user_id` varchar(26) NOT NULL,
  `owner_display_name` varchar(160) NOT NULL,
  `kind` varchar(16) NOT NULL,
  `manifest_version` int NOT NULL,
  `title` varchar(160) NOT NULL,
  `manifest` json NOT NULL,
  `created_at` datetime(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  `revoked_at` datetime(6),
  CONSTRAINT `enterprise_config_share_snapshots_token` PRIMARY KEY(`token`)
);
