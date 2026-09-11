CREATE TABLE IF NOT EXISTS "enterprise_config_share_snapshots" (
  "token" varchar(64) PRIMARY KEY NOT NULL,
  "tenant_id" varchar(26) NOT NULL,
  "user_id" varchar(26) NOT NULL,
  "owner_display_name" varchar(160) NOT NULL,
  "kind" varchar(16) NOT NULL,
  "manifest_version" integer NOT NULL,
  "title" varchar(160) NOT NULL,
  "manifest" jsonb NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "revoked_at" timestamptz
);
