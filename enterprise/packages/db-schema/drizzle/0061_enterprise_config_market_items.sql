CREATE TABLE IF NOT EXISTS "enterprise_config_market_items" (
  "id" varchar(26) PRIMARY KEY NOT NULL,
  "tenant_id" varchar(26) NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "user_id" varchar(26) NOT NULL,
  "owner_display_name" varchar(160) NOT NULL,
  "kind" varchar(16) NOT NULL,
  "manifest_version" integer NOT NULL,
  "title" varchar(160) NOT NULL,
  "description" text NOT NULL,
  "manifest_digest" varchar(64) NOT NULL,
  "manifest" jsonb NOT NULL,
  "visibility" varchar(16) NOT NULL,
  "visible_department_ids" jsonb NOT NULL,
  "visible_user_ids" jsonb NOT NULL,
  "status" varchar(16) DEFAULT 'published' NOT NULL,
  "published_at" timestamptz DEFAULT now() NOT NULL,
  "unlisted_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "enterprise_config_market_tenant_status_created_idx"
  ON "enterprise_config_market_items" ("tenant_id", "status", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "enterprise_config_market_tenant_kind_status_idx"
  ON "enterprise_config_market_items" ("tenant_id", "kind", "status");
