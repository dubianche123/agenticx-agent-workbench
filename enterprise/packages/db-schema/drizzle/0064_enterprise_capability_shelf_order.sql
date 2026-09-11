CREATE TABLE IF NOT EXISTS "enterprise_capability_shelf_order" (
  "tenant_id" varchar(26) NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "capability_id" varchar(64) NOT NULL,
  "position" integer NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "enterprise_capability_shelf_order_pk" PRIMARY KEY ("tenant_id", "capability_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "enterprise_capability_shelf_order_tenant_position_idx"
  ON "enterprise_capability_shelf_order" ("tenant_id", "position", "capability_id");
