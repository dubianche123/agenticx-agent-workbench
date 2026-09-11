-- Successful employee downloads/imports of immutable configuration-market releases.
-- The identity unique key makes retries and concurrent reports idempotent; counts
-- are derived from this receipt set rather than a mutable counter.

CREATE TABLE IF NOT EXISTS "enterprise_config_market_download_receipts" (
  "id" varchar(26) PRIMARY KEY NOT NULL,
  "tenant_id" varchar(26) NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "item_id" varchar(26) NOT NULL REFERENCES "enterprise_config_market_items"("id") ON DELETE CASCADE,
  "release_id" varchar(26) NOT NULL REFERENCES "enterprise_config_market_releases"("id") ON DELETE CASCADE,
  "user_id" varchar(26) NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "enterprise_config_market_download_receipts_identity_uq"
  ON "enterprise_config_market_download_receipts" ("tenant_id", "item_id", "release_id", "user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "enterprise_config_market_download_receipts_tenant_item_idx"
  ON "enterprise_config_market_download_receipts" ("tenant_id", "item_id");
