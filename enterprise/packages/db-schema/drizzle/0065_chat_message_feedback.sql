CREATE TABLE IF NOT EXISTS "chat_message_feedback" (
  "id" varchar(26) PRIMARY KEY NOT NULL,
  "tenant_id" varchar(26) NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "user_id" varchar(26) NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "department_id" varchar(26),
  "session_id" varchar(26) NOT NULL REFERENCES "chat_sessions"("id") ON DELETE RESTRICT,
  "message_id" varchar(26) NOT NULL REFERENCES "chat_messages"("id") ON DELETE CASCADE,
  "value" varchar(16) NOT NULL,
  "trace_id" varchar(128),
  "provider" varchar(128),
  "model" varchar(160),
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "chat_message_feedback_value_check" CHECK ("value" in ('like', 'dislike')),
  CONSTRAINT "chat_message_feedback_session_tenant_user_fk"
    FOREIGN KEY ("session_id", "tenant_id", "user_id")
    REFERENCES "chat_sessions"("id", "tenant_id", "user_id") ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "chat_message_feedback_tenant_user_message_uq"
  ON "chat_message_feedback" ("tenant_id", "user_id", "message_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_message_feedback_tenant_message_value_idx"
  ON "chat_message_feedback" ("tenant_id", "message_id", "value");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_message_feedback_tenant_department_created_idx"
  ON "chat_message_feedback" ("tenant_id", "department_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_message_feedback_tenant_model_created_idx"
  ON "chat_message_feedback" ("tenant_id", "model", "created_at");
