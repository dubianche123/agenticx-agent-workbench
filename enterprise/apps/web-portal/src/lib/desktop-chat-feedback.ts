import { and, desc, eq, inArray } from "drizzle-orm";
import {
  chatMessageFeedback as pgFeedbackTable,
} from "@agenticx/db-schema";
import {
  chatMessageFeedback as mysqlFeedbackTable,
} from "@agenticx/db-schema/mysql";
import { createMysqlDb, getIamDb, resolveDatabaseConfig } from "@agenticx/iam-core";
import { ulid } from "ulid";

export const DESKTOP_FEEDBACK_SOURCE = "desktop" as const;
export const DESKTOP_FEEDBACK_VALUES = ["like", "dislike"] as const;
export type DesktopFeedbackValue = (typeof DESKTOP_FEEDBACK_VALUES)[number];

const ULID_RE = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const EXTERNAL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const MAX_EXTERNAL_SESSION_ID_CHARS = 128;
const MAX_EXTERNAL_MESSAGE_ID_CHARS = 128;
const MAX_ANSWER_EXCERPT_CHARS = 16_384;
const MAX_PROVIDER_CHARS = 128;
const MAX_MODEL_CHARS = 160;
const MAX_TRACE_ID_CHARS = 128;

export type DesktopFeedbackActor = {
  tenantId: string;
  userId: string;
  departmentId?: string | null;
};

export type DesktopFeedbackRecord = {
  id: string;
  externalSessionId: string;
  externalMessageId: string;
  value: DesktopFeedbackValue;
  updatedAt: string;
};

export class DesktopFeedbackValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "DesktopFeedbackValidationError";
  }
}

type DesktopFeedbackDb = {
  dialect: "postgresql" | "mysql";
  db: any;
  feedback: any;
};

function id(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 64 || !ULID_RE.test(normalized)) {
    throw new DesktopFeedbackValidationError(`invalid ${field}`);
  }
  return normalized;
}

function externalId(value: unknown, field: string, maxChars: number): string {
  if (typeof value !== "string") {
    throw new DesktopFeedbackValidationError(`${field} must be a string`);
  }
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > maxChars ||
    !EXTERNAL_ID_RE.test(normalized) ||
    normalized.includes("..")
  ) {
    throw new DesktopFeedbackValidationError(`invalid ${field}`);
  }
  return normalized;
}

function boundedText(
  value: unknown,
  field: string,
  maxChars: number,
  options: { allowLineBreaks?: boolean } = {},
): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new DesktopFeedbackValidationError(`${field} must be a string`);
  }
  const normalized = value.trim();
  if (!normalized) return null;
  if (Array.from(normalized).length > maxChars) {
    throw new DesktopFeedbackValidationError(`${field} is too long`);
  }
  const controlPattern = options.allowLineBreaks
    ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/
    : /[\u0000-\u001f\u007f]/;
  if (controlPattern.test(normalized)) {
    throw new DesktopFeedbackValidationError(`${field} contains control characters`);
  }
  return normalized;
}

function valueOf(value: unknown): DesktopFeedbackValue {
  if (value === "like" || value === "dislike") return value;
  throw new DesktopFeedbackValidationError("value must be like or dislike");
}

async function getDesktopFeedbackDb(): Promise<DesktopFeedbackDb> {
  const config = resolveDatabaseConfig();
  if (config.dialect === "mysql") {
    const db = (await createMysqlDb(config)).raw;
    return { dialect: "mysql", db, feedback: mysqlFeedbackTable };
  }
  return { dialect: "postgresql", db: getIamDb(), feedback: pgFeedbackTable };
}

function actorIds(actor: DesktopFeedbackActor): { tenantId: string; userId: string; departmentId: string | null } {
  const tenantId = id(actor.tenantId, "tenant_id");
  const userId = id(actor.userId, "user_id");
  const departmentId = actor.departmentId == null ? null : id(actor.departmentId, "department_id");
  return { tenantId, userId, departmentId };
}

function asIso(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
}

function mapRecord(row: Record<string, unknown>): DesktopFeedbackRecord {
  return {
    id: String(row.id),
    externalSessionId: String(row.externalSessionId ?? row.external_session_id),
    externalMessageId: String(row.externalMessageId ?? row.external_message_id),
    value: valueOf(row.value),
    updatedAt: asIso(row.updatedAt ?? row.updated_at),
  };
}

function actorWhere(store: DesktopFeedbackDb, actor: DesktopFeedbackActor) {
  const { tenantId, userId } = actorIds(actor);
  return [
    eq(store.feedback.tenantId, tenantId),
    eq(store.feedback.userId, userId),
    eq(store.feedback.source, DESKTOP_FEEDBACK_SOURCE),
  ];
}

/** Persist one desktop-local assistant vote without creating chat history rows. */
export async function upsertDesktopChatFeedback(input: {
  actor: DesktopFeedbackActor;
  source: typeof DESKTOP_FEEDBACK_SOURCE;
  externalSessionId: string;
  externalMessageId: string;
  value: DesktopFeedbackValue;
  answerExcerpt?: string | null;
  provider?: string | null;
  model?: string | null;
  traceId?: string | null;
}): Promise<DesktopFeedbackRecord> {
  if (input.source !== DESKTOP_FEEDBACK_SOURCE) {
    throw new DesktopFeedbackValidationError("invalid feedback source");
  }
  const store = await getDesktopFeedbackDb();
  const { tenantId, userId, departmentId } = actorIds(input.actor);
  const externalSessionId = externalId(
    input.externalSessionId,
    "external_session_id",
    MAX_EXTERNAL_SESSION_ID_CHARS,
  );
  const externalMessageId = externalId(
    input.externalMessageId,
    "external_message_id",
    MAX_EXTERNAL_MESSAGE_ID_CHARS,
  );
  const value = valueOf(input.value);
  const answerExcerpt = boundedText(
    input.answerExcerpt,
    "answer_excerpt",
    MAX_ANSWER_EXCERPT_CHARS,
    { allowLineBreaks: true },
  );
  const provider = boundedText(input.provider, "provider", MAX_PROVIDER_CHARS);
  const model = boundedText(input.model, "model", MAX_MODEL_CHARS);
  const traceId = boundedText(input.traceId, "trace_id", MAX_TRACE_ID_CHARS);
  const now = new Date();
  const values = {
    id: ulid(),
    tenantId,
    userId,
    departmentId,
    sessionId: null,
    messageId: null,
    value,
    source: DESKTOP_FEEDBACK_SOURCE,
    externalSessionId,
    externalMessageId,
    answerExcerpt,
    provider,
    model,
    traceId,
    createdAt: now,
    updatedAt: now,
  };
  if (store.dialect === "mysql") {
    await store.db.insert(store.feedback).values(values).onDuplicateKeyUpdate({
      set: {
        value,
        departmentId,
        answerExcerpt,
        provider,
        model,
        traceId,
        updatedAt: now,
      },
    });
  } else {
    await store.db.insert(store.feedback).values(values).onConflictDoUpdate({
      target: [
        store.feedback.tenantId,
        store.feedback.userId,
        store.feedback.source,
        store.feedback.externalSessionId,
        store.feedback.externalMessageId,
      ],
      set: {
        value,
        departmentId,
        answerExcerpt,
        provider,
        model,
        traceId,
        updatedAt: now,
      },
    });
  }
  const rows = await store.db
    .select()
    .from(store.feedback)
    .where(
      and(
        ...actorWhere(store, input.actor),
        eq(store.feedback.externalSessionId, externalSessionId),
        eq(store.feedback.externalMessageId, externalMessageId),
      ),
    )
    .limit(1);
  if (!rows[0]) throw new Error("desktop feedback write did not persist");
  return mapRecord(rows[0] as Record<string, unknown>);
}

/** Delete one desktop-local vote. Deletion is intentionally idempotent. */
export async function deleteDesktopChatFeedback(input: {
  actor: DesktopFeedbackActor;
  source: typeof DESKTOP_FEEDBACK_SOURCE;
  externalSessionId: string;
  externalMessageId: string;
}): Promise<void> {
  if (input.source !== DESKTOP_FEEDBACK_SOURCE) {
    throw new DesktopFeedbackValidationError("invalid feedback source");
  }
  const store = await getDesktopFeedbackDb();
  const externalSessionId = externalId(
    input.externalSessionId,
    "external_session_id",
    MAX_EXTERNAL_SESSION_ID_CHARS,
  );
  const externalMessageId = externalId(
    input.externalMessageId,
    "external_message_id",
    MAX_EXTERNAL_MESSAGE_ID_CHARS,
  );
  await store.db.delete(store.feedback).where(
    and(
      ...actorWhere(store, input.actor),
      eq(store.feedback.externalSessionId, externalSessionId),
      eq(store.feedback.externalMessageId, externalMessageId),
    ),
  );
}

/** List only the authenticated user's desktop votes for one external session. */
export async function listDesktopChatFeedback(input: {
  actor: DesktopFeedbackActor;
  source: typeof DESKTOP_FEEDBACK_SOURCE;
  externalSessionId: string;
  externalMessageIds?: string[];
}): Promise<DesktopFeedbackRecord[]> {
  if (input.source !== DESKTOP_FEEDBACK_SOURCE) {
    throw new DesktopFeedbackValidationError("invalid feedback source");
  }
  const store = await getDesktopFeedbackDb();
  const externalSessionId = externalId(
    input.externalSessionId,
    "external_session_id",
    MAX_EXTERNAL_SESSION_ID_CHARS,
  );
  const externalMessageIds = [...new Set((input.externalMessageIds ?? []).map((item) =>
    externalId(item, "external_message_id", MAX_EXTERNAL_MESSAGE_ID_CHARS),
  ))];
  if (externalMessageIds.length > 100) {
    throw new DesktopFeedbackValidationError("external_message_ids must contain at most 100 items");
  }
  const filters = [
    ...actorWhere(store, input.actor),
    eq(store.feedback.externalSessionId, externalSessionId),
  ];
  if (externalMessageIds.length > 0) {
    filters.push(inArray(store.feedback.externalMessageId, externalMessageIds));
  }
  const rows = await store.db
    .select()
    .from(store.feedback)
    .where(and(...filters))
    .orderBy(desc(store.feedback.updatedAt));
  return (rows as Array<Record<string, unknown>>).map(mapRecord);
}
