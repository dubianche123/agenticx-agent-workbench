-- Durable personal-assistant sessions, operations, and append-only operation events.
-- Bearer values are hashed; all rows remain tenant-scoped and resumable after a restart.

-- Composite references below require a matching unique key on the referenced
-- tenant-owned identity.  The primary key alone does not enforce that the
-- tenant column belongs to the same row.
CREATE UNIQUE INDEX IF NOT EXISTS "api_tokens_id_tenant_uq" ON "api_tokens" ("id", "tenant_id");

CREATE TABLE IF NOT EXISTS "assistant_sessions" (
  "id" varchar(26) PRIMARY KEY NOT NULL,
  "tenant_id" varchar(26) NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "user_id" varchar(26) NOT NULL,
  "agent_principal_id" varchar(26) NOT NULL,
  "originating_pat_id" bigint NOT NULL,
  "studio_session_id" varchar(160) NOT NULL,
  "permission_mode" varchar(16) NOT NULL,
  "token_hash" varchar(64) NOT NULL,
  "authorization_version" varchar(128) NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "status" varchar(16) NOT NULL DEFAULT 'active',
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "assistant_sessions_user_tenant_fk" FOREIGN KEY ("user_id", "tenant_id") REFERENCES "users"("id", "tenant_id") ON DELETE CASCADE,
  CONSTRAINT "assistant_sessions_agent_tenant_fk" FOREIGN KEY ("agent_principal_id", "tenant_id") REFERENCES "principals"("id", "tenant_id") ON DELETE CASCADE,
  CONSTRAINT "assistant_sessions_originating_pat_tenant_fk" FOREIGN KEY ("originating_pat_id", "tenant_id") REFERENCES "api_tokens"("id", "tenant_id") ON DELETE RESTRICT,
  CONSTRAINT "assistant_sessions_permission_mode_check" CHECK ("permission_mode" IN ('plan', 'ask', 'auto')),
  CONSTRAINT "assistant_sessions_status_check" CHECK ("status" IN ('active', 'revoked', 'expired'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "assistant_sessions_token_hash_uq" ON "assistant_sessions" ("token_hash");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "assistant_sessions_id_tenant_uq" ON "assistant_sessions" ("id", "tenant_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "assistant_sessions_tenant_user_studio_idx" ON "assistant_sessions" ("tenant_id", "user_id", "studio_session_id", "status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "assistant_sessions_expires_idx" ON "assistant_sessions" ("expires_at", "status");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "action_operations" (
  "id" varchar(26) PRIMARY KEY NOT NULL,
  "tenant_id" varchar(26) NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "session_id" varchar(26) NOT NULL,
  "actor_user_id" varchar(26) NOT NULL,
  "agent_principal_id" varchar(26) NOT NULL,
  "represented_user_id" varchar(26) NOT NULL,
  "action_id" varchar(96) NOT NULL,
  "action_version" integer NOT NULL,
  "effect" varchar(16) NOT NULL,
  "permission_mode" varchar(16) NOT NULL,
  "idempotency_key" varchar(160) NOT NULL,
  "arguments_hash" varchar(64) NOT NULL,
  "arguments" jsonb NOT NULL,
  "targets" jsonb NOT NULL,
  "before_state" jsonb,
  "after_state" jsonb,
  "expected_versions" jsonb,
  "authorization_snapshot" jsonb NOT NULL,
  "authorization_version" varchar(128) NOT NULL,
  "run_id" varchar(160),
  "status" varchar(32) NOT NULL,
  "proposal" jsonb,
  "result" jsonb,
  "error_code" varchar(64),
  "error_message" varchar(512),
  "confirmation_expires_at" timestamp with time zone,
  "expires_at" timestamp with time zone NOT NULL,
  "confirmed_by_user_id" varchar(26),
  "executed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "action_operations_session_tenant_fk" FOREIGN KEY ("session_id", "tenant_id") REFERENCES "assistant_sessions"("id", "tenant_id") ON DELETE CASCADE,
  CONSTRAINT "action_operations_actor_user_tenant_fk" FOREIGN KEY ("actor_user_id", "tenant_id") REFERENCES "users"("id", "tenant_id") ON DELETE RESTRICT,
  CONSTRAINT "action_operations_agent_tenant_fk" FOREIGN KEY ("agent_principal_id", "tenant_id") REFERENCES "principals"("id", "tenant_id") ON DELETE RESTRICT,
  CONSTRAINT "action_operations_represented_user_tenant_fk" FOREIGN KEY ("represented_user_id", "tenant_id") REFERENCES "users"("id", "tenant_id") ON DELETE RESTRICT,
  CONSTRAINT "action_operations_confirmed_by_user_tenant_fk" FOREIGN KEY ("confirmed_by_user_id", "tenant_id") REFERENCES "users"("id", "tenant_id") ON DELETE RESTRICT,
  CONSTRAINT "action_operations_effect_check" CHECK ("effect" IN ('query', 'mutation')),
  CONSTRAINT "action_operations_permission_mode_check" CHECK ("permission_mode" IN ('plan', 'ask', 'auto')),
  CONSTRAINT "action_operations_status_check" CHECK ("status" IN ('prepared', 'awaiting_confirmation', 'ready', 'executing', 'succeeded', 'failed', 'stale', 'cancelled', 'expired', 'outcome_unknown'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "action_operations_idempotency_uq" ON "action_operations" ("tenant_id", "session_id", "idempotency_key");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "action_operations_id_tenant_uq" ON "action_operations" ("id", "tenant_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "action_operations_tenant_actor_idx" ON "action_operations" ("tenant_id", "actor_user_id", "session_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "action_operations_status_expiry_idx" ON "action_operations" ("status", "expires_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "action_operation_events" (
  "operation_id" varchar(26) NOT NULL,
  "tenant_id" varchar(26) NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "sequence" integer NOT NULL,
  "event_type" varchar(48) NOT NULL,
  "payload" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("operation_id", "sequence"),
  CONSTRAINT "action_operation_events_operation_tenant_fk" FOREIGN KEY ("operation_id", "tenant_id") REFERENCES "action_operations"("id", "tenant_id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "action_operation_events_tenant_time_idx" ON "action_operation_events" ("tenant_id", "created_at");
