import {
  check,
  bigint,
  datetime,
  foreignKey,
  index,
  int,
  json,
  mysqlTable,
  primaryKey,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";
import { sql } from "drizzle-orm";

import { auditColumns, ulid } from "./_shared";
import { apiTokens } from "./api-tokens";
import { principals } from "./principals";
import { tenants } from "./tenants";
import { users } from "./users";

export type AssistantPermissionMode = "plan" | "ask" | "auto";
export type AssistantSessionStatus = "active" | "revoked" | "expired";
/**
 * The surface that owns an assistant session.  Cookie-authenticated web
 * sessions deliberately have no PAT provenance; keeping this discriminator in
 * the row prevents a server-owned session from ever being treated as a
 * desktop PAT bearer.
 */
export type AssistantSessionOriginKind = "desktop_pat" | "admin_cookie" | "portal_cookie";
export type ActionOperationStatus =
  | "prepared"
  | "awaiting_confirmation"
  | "ready"
  | "executing"
  | "succeeded"
  | "failed"
  | "stale"
  | "cancelled"
  | "expired"
  | "outcome_unknown";

export const assistantSessions = mysqlTable(
  "assistant_sessions",
  {
    id: ulid("id").primaryKey(),
    tenantId: ulid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    userId: ulid("user_id").notNull(),
    agentPrincipalId: ulid("agent_principal_id").notNull(),
    originatingPatId: bigint("originating_pat_id", { mode: "number" }),
    originKind: varchar("origin_kind", { length: 24 })
      .$type<AssistantSessionOriginKind>()
      .notNull()
      .default("desktop_pat"),
    studioSessionId: varchar("studio_session_id", { length: 160 }).notNull(),
    permissionMode: varchar("permission_mode", { length: 16 })
      .$type<AssistantPermissionMode>()
      .notNull(),
    tokenHash: varchar("token_hash", { length: 64 }).notNull(),
    authorizationVersion: varchar("authorization_version", { length: 128 }).notNull(),
    expiresAt: datetime("expires_at", { fsp: 6 }).notNull(),
    status: varchar("status", { length: 16 }).$type<AssistantSessionStatus>().notNull().default("active"),
    ...auditColumns,
  },
  (table) => ({
    tokenHashUq: uniqueIndex("assistant_sessions_token_hash_uq").on(table.tokenHash),
    idTenantUq: uniqueIndex("assistant_sessions_id_tenant_uq").on(table.id, table.tenantId),
    tenantUserStudioIdx: index("assistant_sessions_tenant_user_studio_idx").on(
      table.tenantId,
      table.userId,
      table.studioSessionId,
      table.status,
    ),
    expiresIdx: index("assistant_sessions_expires_idx").on(table.expiresAt, table.status),
    modeCheck: check(
      "assistant_sessions_permission_mode_check",
      sql`${table.permissionMode} in ('plan', 'ask', 'auto')`,
    ),
    statusCheck: check(
      "assistant_sessions_status_check",
      sql`${table.status} in ('active', 'revoked', 'expired')`,
    ),
    originCheck: check(
      "assistant_sessions_origin_check",
      sql`(
        (${table.originKind} = 'desktop_pat' and ${table.originatingPatId} is not null)
        or (${table.originKind} in ('admin_cookie', 'portal_cookie') and ${table.originatingPatId} is null)
      )`,
    ),
    userTenantFk: foreignKey({
      name: "assistant_sessions_user_tenant_fk",
      columns: [table.userId, table.tenantId],
      foreignColumns: [users.id, users.tenantId],
    }).onDelete("cascade"),
    agentTenantFk: foreignKey({
      name: "assistant_sessions_agent_tenant_fk",
      columns: [table.agentPrincipalId, table.tenantId],
      foreignColumns: [principals.id, principals.tenantId],
    }).onDelete("cascade"),
    originatingPatTenantFk: foreignKey({
      name: "assistant_sessions_originating_pat_tenant_fk",
      columns: [table.originatingPatId, table.tenantId],
      foreignColumns: [apiTokens.id, apiTokens.tenantId],
    }).onDelete("restrict"),
  }),
);

export const actionOperations = mysqlTable(
  "action_operations",
  {
    id: ulid("id").primaryKey(),
    tenantId: ulid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    sessionId: ulid("session_id").notNull(),
    actorUserId: ulid("actor_user_id").notNull(),
    agentPrincipalId: ulid("agent_principal_id").notNull(),
    representedUserId: ulid("represented_user_id").notNull(),
    actionId: varchar("action_id", { length: 96 }).notNull(),
    actionVersion: int("action_version").notNull(),
    effect: varchar("effect", { length: 16 }).notNull(),
    permissionMode: varchar("permission_mode", { length: 16 })
      .$type<AssistantPermissionMode>()
      .notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 160 }).notNull(),
    argumentsHash: varchar("arguments_hash", { length: 64 }).notNull(),
    arguments: json("arguments").notNull().$type<Record<string, unknown>>(),
    targets: json("targets").notNull().$type<Array<Record<string, unknown>>>(),
    beforeState: json("before_state").$type<Record<string, unknown> | null>(),
    afterState: json("after_state").$type<Record<string, unknown> | null>(),
    expectedVersions: json("expected_versions").$type<Record<string, unknown> | null>(),
    authorizationSnapshot: json("authorization_snapshot").notNull().$type<Record<string, unknown>>(),
    authorizationVersion: varchar("authorization_version", { length: 128 }).notNull(),
    runId: varchar("run_id", { length: 160 }),
    status: varchar("status", { length: 32 }).$type<ActionOperationStatus>().notNull(),
    proposal: json("proposal").$type<Record<string, unknown> | null>(),
    result: json("result").$type<Record<string, unknown> | null>(),
    errorCode: varchar("error_code", { length: 64 }),
    errorMessage: varchar("error_message", { length: 512 }),
    confirmationExpiresAt: datetime("confirmation_expires_at", { fsp: 6 }),
    expiresAt: datetime("expires_at", { fsp: 6 }).notNull(),
    confirmedByUserId: ulid("confirmed_by_user_id"),
    executedAt: datetime("executed_at", { fsp: 6 }),
    ...auditColumns,
  },
  (table) => ({
    idTenantUq: uniqueIndex("action_operations_id_tenant_uq").on(table.id, table.tenantId),
    idempotencyUq: uniqueIndex("action_operations_idempotency_uq").on(
      table.tenantId,
      table.sessionId,
      table.idempotencyKey,
    ),
    lookupIdx: index("action_operations_tenant_actor_idx").on(
      table.tenantId,
      table.actorUserId,
      table.sessionId,
      table.createdAt,
    ),
    statusIdx: index("action_operations_status_expiry_idx").on(table.status, table.expiresAt),
    actionCheck: check(
      "action_operations_effect_check",
      sql`${table.effect} in ('query', 'mutation')`,
    ),
    permissionModeCheck: check(
      "action_operations_permission_mode_check",
      sql`${table.permissionMode} in ('plan', 'ask', 'auto')`,
    ),
    statusCheck: check(
      "action_operations_status_check",
      sql`${table.status} in ('prepared', 'awaiting_confirmation', 'ready', 'executing', 'succeeded', 'failed', 'stale', 'cancelled', 'expired', 'outcome_unknown')`,
    ),
    sessionTenantFk: foreignKey({
      name: "action_operations_session_tenant_fk",
      columns: [table.sessionId, table.tenantId],
      foreignColumns: [assistantSessions.id, assistantSessions.tenantId],
    }).onDelete("cascade"),
    actorUserTenantFk: foreignKey({
      name: "action_operations_actor_user_tenant_fk",
      columns: [table.actorUserId, table.tenantId],
      foreignColumns: [users.id, users.tenantId],
    }).onDelete("restrict"),
    agentTenantFk: foreignKey({
      name: "action_operations_agent_tenant_fk",
      columns: [table.agentPrincipalId, table.tenantId],
      foreignColumns: [principals.id, principals.tenantId],
    }).onDelete("restrict"),
    representedUserTenantFk: foreignKey({
      name: "action_operations_represented_user_tenant_fk",
      columns: [table.representedUserId, table.tenantId],
      foreignColumns: [users.id, users.tenantId],
    }).onDelete("restrict"),
    confirmedByUserTenantFk: foreignKey({
      name: "action_operations_confirmed_by_user_tenant_fk",
      columns: [table.confirmedByUserId, table.tenantId],
      foreignColumns: [users.id, users.tenantId],
    }).onDelete("restrict"),
  }),
);

export const actionOperationEvents = mysqlTable(
  "action_operation_events",
  {
    operationId: ulid("operation_id").notNull(),
    tenantId: ulid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    sequence: int("sequence").notNull(),
    eventType: varchar("event_type", { length: 48 }).notNull(),
    payload: json("payload").notNull().$type<Record<string, unknown>>(),
    createdAt: datetime("created_at", { fsp: 6 }).notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.operationId, table.sequence] }),
    tenantTimeIdx: index("action_operation_events_tenant_time_idx").on(table.tenantId, table.createdAt),
    operationTenantFk: foreignKey({
      name: "action_operation_events_operation_tenant_fk",
      columns: [table.operationId, table.tenantId],
      foreignColumns: [actionOperations.id, actionOperations.tenantId],
    }).onDelete("cascade"),
  }),
);

export type AssistantSession = typeof assistantSessions.$inferSelect;
export type NewAssistantSession = typeof assistantSessions.$inferInsert;
export type ActionOperation = typeof actionOperations.$inferSelect;
export type NewActionOperation = typeof actionOperations.$inferInsert;
export type ActionOperationEvent = typeof actionOperationEvents.$inferSelect;
export type NewActionOperationEvent = typeof actionOperationEvents.$inferInsert;
