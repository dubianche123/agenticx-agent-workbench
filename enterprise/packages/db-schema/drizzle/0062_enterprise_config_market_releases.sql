-- Unpublished v1 data is intentionally discarded; no production compatibility/backfill path.
DROP TABLE IF EXISTS "enterprise_config_market_items" CASCADE;
--> statement-breakpoint
CREATE TABLE "enterprise_config_market_items" (
  "id" varchar(26) PRIMARY KEY NOT NULL,
  "tenant_id" varchar(26) NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "user_id" varchar(26) NOT NULL,
  "owner_display_name" varchar(160) NOT NULL,
  "kind" varchar(16) NOT NULL,
  "source_artifact_id" varchar(128) NOT NULL,
  "title" varchar(160) NOT NULL,
  "description" text NOT NULL,
  "current_release_id" varchar(26) NOT NULL,
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
CREATE UNIQUE INDEX "enterprise_config_market_tenant_current_release_uq"
  ON "enterprise_config_market_items" ("tenant_id", "current_release_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "enterprise_config_market_tenant_source_artifact_uq"
  ON "enterprise_config_market_items" ("tenant_id", "kind", "source_artifact_id");
--> statement-breakpoint
CREATE INDEX "enterprise_config_market_tenant_status_created_idx"
  ON "enterprise_config_market_items" ("tenant_id", "status", "created_at");
--> statement-breakpoint
CREATE INDEX "enterprise_config_market_tenant_kind_status_idx"
  ON "enterprise_config_market_items" ("tenant_id", "kind", "status");
--> statement-breakpoint
CREATE TABLE "enterprise_config_market_releases" (
  "id" varchar(26) PRIMARY KEY NOT NULL,
  "tenant_id" varchar(26) NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "artifact_id" varchar(26) NOT NULL REFERENCES "enterprise_config_market_items"("id") ON DELETE CASCADE,
  "version" varchar(64) NOT NULL,
  "manifest_version" integer NOT NULL,
  "manifest_digest" varchar(64) NOT NULL,
  "manifest" jsonb NOT NULL,
  "release_notes" text NOT NULL,
  "published_at" timestamptz DEFAULT now() NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "enterprise_config_market_release_artifact_version_uq"
  ON "enterprise_config_market_releases" ("tenant_id", "artifact_id", "version");
--> statement-breakpoint
CREATE UNIQUE INDEX "enterprise_config_market_release_artifact_digest_uq"
  ON "enterprise_config_market_releases" ("tenant_id", "artifact_id", "manifest_digest");
--> statement-breakpoint
CREATE INDEX "enterprise_config_market_release_artifact_published_idx"
  ON "enterprise_config_market_releases" ("tenant_id", "artifact_id", "published_at");
--> statement-breakpoint
ALTER TABLE "enterprise_capability_pack_members"
  ADD COLUMN "release_policy" varchar(16),
  ADD COLUMN "pinned_release_id" varchar(26) REFERENCES "enterprise_config_market_releases"("id") ON DELETE RESTRICT;
