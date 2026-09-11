import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  ilike,
  like,
  or,
  lte,
  sql,
  type SQL,
} from "drizzle-orm";
import {
  chatMessageFeedback as pgFeedback,
  chatMessages as pgMessages,
  departments as pgDepartments,
  users as pgUsers,
} from "@agenticx/db-schema";
import {
  chatMessageFeedback as mysqlFeedback,
  chatMessages as mysqlMessages,
  departments as mysqlDepartments,
  users as mysqlUsers,
} from "@agenticx/db-schema/mysql";
import { getIamDb, resolveDatabaseConfig } from "@agenticx/iam-core";

import { getAdminMysqlDb } from "./db-stores/mysql/database";
import { redactFeedbackExcerpt } from "./feedback-redaction";

export type FeedbackKind = "like" | "dislike";
export const FEEDBACK_SOURCES = ["web", "desktop"] as const;
export type FeedbackSource = (typeof FEEDBACK_SOURCES)[number];

/** Why an exact feedback coverage denominator is unavailable for a filter. */
export type FeedbackCoverageUnavailableReason =
  | "provider_filter"
  | "department_snapshot_mismatch"
  | "desktop_source"
  | "mixed_sources";

export type AdminFeedbackQuery = {
  tenantId: string;
  departmentId?: string;
  feedbackType?: FeedbackKind;
  source?: FeedbackSource;
  model?: string;
  provider?: string;
  start?: Date;
  end?: Date;
  limit: number;
  offset: number;
  detailsVisible: boolean;
};

export type AdminFeedbackResult = {
  summary: {
    total: number;
    likes: number;
    dislikes: number;
    positive_rate: number | null;
    eligible_messages: number | null;
    feedback_rate: number | null;
    feedback_rate_reason: FeedbackCoverageUnavailableReason | null;
  };
  trends: Array<{ day: string; likes: number; dislikes: number }>;
  by_source: Array<{
    source: FeedbackSource;
    likes: number;
    dislikes: number;
    total: number;
    positive_rate: number | null;
  }>;
  by_model: Array<{
    source: FeedbackSource;
    model: string | null;
    provider: string | null;
    likes: number;
    dislikes: number;
    total: number;
    positive_rate: number | null;
  }>;
  by_department: Array<{
    source: FeedbackSource;
    department_id: string | null;
    department_name: string | null;
    likes: number;
    dislikes: number;
    total: number;
    positive_rate: number | null;
  }>;
  items: Array<{
    id: string;
    source: FeedbackSource;
    feedback_type: FeedbackKind;
    model: string | null;
    provider: string | null;
    department_id: string | null;
    department_name: string | null;
    created_at: string;
    updated_at: string;
    answer_excerpt: string | null;
    trace_id: string | null;
    session_id: string | null;
    message_id: string | null;
  }>;
  total: number;
};

type AggregateRow = {
  total: number | string;
  likes: number | string | null;
  dislikes: number | string | null;
};

function numberValue(value: number | string | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function rate(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

function dateString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapAggregate(row: AggregateRow | undefined) {
  const total = numberValue(row?.total);
  const likes = numberValue(row?.likes);
  const dislikes = numberValue(row?.dislikes);
  return { total, likes, dislikes, positive_rate: rate(likes, total) };
}

/**
 * Feedback stores provider and department values as write-time snapshots. A
 * provider is not present on chat messages, and a department snapshot cannot
 * be joined to today's user membership without changing the historical
 * cohort. Do not present either filtered numerator as an exact coverage rate.
 */
export function feedbackCoverageUnavailableReason(
  input: Pick<AdminFeedbackQuery, "departmentId" | "provider" | "source">,
): FeedbackCoverageUnavailableReason | null {
  if (input.source === "desktop") return "desktop_source";
  if (input.provider) return "provider_filter";
  if (input.departmentId) return "department_snapshot_mismatch";
  return null;
}

export function computeFeedbackCoverage({
  allFeedbackTotal,
  eligibleMessages,
  unavailableReason,
}: {
  allFeedbackTotal: number;
  eligibleMessages: number;
  unavailableReason: FeedbackCoverageUnavailableReason | null;
}): {
  eligible_messages: number | null;
  feedback_rate: number | null;
  feedback_rate_reason: FeedbackCoverageUnavailableReason | null;
} {
  return {
    eligible_messages: unavailableReason ? null : eligibleMessages,
    feedback_rate: unavailableReason ? null : rate(allFeedbackTotal, eligibleMessages),
    feedback_rate_reason: unavailableReason,
  };
}

function buildFeedbackSummary({
  base,
  coverageTotal,
  eligibleMessages,
  reason,
}: {
  base: ReturnType<typeof mapAggregate>;
  coverageTotal: number;
  eligibleMessages: number;
  reason: FeedbackCoverageUnavailableReason | null;
}) {
  return {
    ...base,
    // `coverageTotal` intentionally comes from all feedback values when a
    // feedback_type filter is active. The selected type is still reflected in
    // base.total/likes/dislikes, but must not turn coverage into a type share.
    ...computeFeedbackCoverage({
      allFeedbackTotal: coverageTotal,
      eligibleMessages,
      unavailableReason: reason,
    }),
  };
}

async function queryMysql(input: AdminFeedbackQuery): Promise<AdminFeedbackResult> {
  const db = getAdminMysqlDb();
  const staticCoverageReason = feedbackCoverageUnavailableReason(input);
  const conditions: SQL[] = [
    eq(mysqlFeedback.tenantId, input.tenantId),
    // Desktop feedback has no row in chat_messages. A web row must still be
    // backed by a complete assistant message; the DB source identity check
    // guarantees desktop rows carry their own external identity/snapshot.
    or(
      and(
        eq(mysqlFeedback.source, "web"),
        eq(mysqlMessages.role, "assistant"),
        eq(mysqlMessages.status, "complete"),
      ),
      eq(mysqlFeedback.source, "desktop"),
    )!,
  ];
  if (input.departmentId) conditions.push(eq(mysqlFeedback.departmentId, input.departmentId));
  if (input.feedbackType) conditions.push(eq(mysqlFeedback.value, input.feedbackType));
  if (input.model) conditions.push(like(mysqlFeedback.model, `%${input.model}%`));
  if (input.provider) conditions.push(like(mysqlFeedback.provider, `%${input.provider}%`));
  if (input.source) conditions.push(eq(mysqlFeedback.source, input.source));
  // Attribute feedback to the answer date so numerator and eligible-message
  // denominator use the same cohort. Desktop has no answer row, so its
  // feedback timestamp is the only available date.
  const answerDate = sql`coalesce(${mysqlMessages.createdAt}, ${mysqlFeedback.createdAt})`;
  if (input.start) conditions.push(gte(answerDate, input.start));
  if (input.end) conditions.push(lte(answerDate, input.end));
  const where = and(...conditions);

  // Keep this cohort independent of feedback_type. A type-filtered numerator
  // is useful for like/dislike analysis, but it is not feedback coverage.
  const coverageConditions: SQL[] = [
    eq(mysqlFeedback.tenantId, input.tenantId),
    eq(mysqlFeedback.source, "web"),
    eq(mysqlMessages.role, "assistant"),
    eq(mysqlMessages.status, "complete"),
  ];
  if (input.departmentId) coverageConditions.push(eq(mysqlFeedback.departmentId, input.departmentId));
  if (input.model) coverageConditions.push(like(mysqlFeedback.model, `%${input.model}%`));
  if (input.provider) coverageConditions.push(like(mysqlFeedback.provider, `%${input.provider}%`));
  if (input.source) coverageConditions.push(eq(mysqlFeedback.source, input.source));
  if (input.start) coverageConditions.push(gte(mysqlMessages.createdAt, input.start));
  if (input.end) coverageConditions.push(lte(mysqlMessages.createdAt, input.end));
  const coverageWhere = and(...coverageConditions);

  const messageConditions: SQL[] = [
    eq(mysqlMessages.tenantId, input.tenantId),
    eq(mysqlMessages.role, "assistant"),
    eq(mysqlMessages.status, "complete"),
  ];
  if (input.departmentId) messageConditions.push(eq(mysqlUsers.deptId, input.departmentId));
  if (input.model) messageConditions.push(like(mysqlMessages.model, `%${input.model}%`));
  if (input.start) messageConditions.push(gte(mysqlMessages.createdAt, input.start));
  if (input.end) messageConditions.push(lte(mysqlMessages.createdAt, input.end));

  const aggregateSelection = {
    total: count(),
    likes: sql<number>`sum(case when ${mysqlFeedback.value} = 'like' then 1 else 0 end)`,
    dislikes: sql<number>`sum(case when ${mysqlFeedback.value} = 'dislike' then 1 else 0 end)`,
  };
  const day = sql<string>`date_format(coalesce(${mysqlMessages.createdAt}, ${mysqlFeedback.createdAt}), '%Y-%m-%d')`;

  const joinMysqlMessage = and(
    eq(mysqlMessages.id, mysqlFeedback.messageId),
    eq(mysqlMessages.tenantId, mysqlFeedback.tenantId),
    eq(mysqlMessages.userId, mysqlFeedback.userId),
  );

  const [summaryRows, eligibleRows, coverageRows, sourceRows, trends, sources, models, departments, itemRows] = await Promise.all([
    db.select(aggregateSelection).from(mysqlFeedback).leftJoin(mysqlMessages, joinMysqlMessage).where(where),
    staticCoverageReason
      ? Promise.resolve([] as Array<{ total: number | string | null }>)
      : db
          .select({ total: count() })
          .from(mysqlMessages)
          .innerJoin(
            mysqlUsers,
            and(eq(mysqlUsers.id, mysqlMessages.userId), eq(mysqlUsers.tenantId, mysqlMessages.tenantId)),
          )
          .where(and(...messageConditions)),
    input.feedbackType && !staticCoverageReason
      ? db
          .select({ total: count() })
          .from(mysqlFeedback)
          .leftJoin(mysqlMessages, joinMysqlMessage)
          .where(coverageWhere)
      : Promise.resolve([] as Array<{ total: number | string | null }>),
    db
      .select({ source: mysqlFeedback.source })
      .from(mysqlFeedback)
      .leftJoin(mysqlMessages, joinMysqlMessage)
      .where(where)
      .groupBy(mysqlFeedback.source),
    db
      .select({ day, ...aggregateSelection })
      .from(mysqlFeedback)
      .leftJoin(mysqlMessages, joinMysqlMessage)
      .where(where)
      .groupBy(day)
      .orderBy(asc(day)),
    db
      .select({ source: mysqlFeedback.source, ...aggregateSelection })
      .from(mysqlFeedback)
      .leftJoin(mysqlMessages, joinMysqlMessage)
      .where(where)
      .groupBy(mysqlFeedback.source)
      .orderBy(desc(count())),
    db
      .select({ source: mysqlFeedback.source, model: mysqlFeedback.model, provider: mysqlFeedback.provider, ...aggregateSelection })
      .from(mysqlFeedback)
      .leftJoin(mysqlMessages, joinMysqlMessage)
      .where(where)
      .groupBy(mysqlFeedback.source, mysqlFeedback.model, mysqlFeedback.provider)
      .orderBy(desc(count()))
      .limit(50),
    db
      .select({
        source: mysqlFeedback.source,
        departmentId: mysqlFeedback.departmentId,
        departmentName: mysqlDepartments.name,
        ...aggregateSelection,
      })
      .from(mysqlFeedback)
      .leftJoin(mysqlMessages, joinMysqlMessage)
      .leftJoin(
        mysqlDepartments,
        and(
          eq(mysqlDepartments.id, mysqlFeedback.departmentId),
          eq(mysqlDepartments.tenantId, mysqlFeedback.tenantId),
        ),
      )
      .where(where)
      .groupBy(mysqlFeedback.source, mysqlFeedback.departmentId, mysqlDepartments.name)
      .orderBy(desc(count()))
      .limit(100),
    input.detailsVisible
      ? db
          .select({
            id: mysqlFeedback.id,
            source: mysqlFeedback.source,
            value: mysqlFeedback.value,
            model: mysqlFeedback.model,
            provider: mysqlFeedback.provider,
            departmentId: mysqlFeedback.departmentId,
            departmentName: mysqlDepartments.name,
            createdAt: mysqlFeedback.createdAt,
            updatedAt: mysqlFeedback.updatedAt,
            traceId: mysqlFeedback.traceId,
            sessionId: mysqlFeedback.sessionId,
            messageId: mysqlFeedback.messageId,
            content: mysqlMessages.content,
            answerExcerpt: mysqlFeedback.answerExcerpt,
          })
          .from(mysqlFeedback)
          .leftJoin(mysqlMessages, joinMysqlMessage)
          .leftJoin(
            mysqlDepartments,
            and(
              eq(mysqlDepartments.id, mysqlFeedback.departmentId),
              eq(mysqlDepartments.tenantId, mysqlFeedback.tenantId),
            ),
          )
          .where(where)
          .orderBy(desc(mysqlFeedback.updatedAt))
          .limit(input.limit)
          .offset(input.offset)
      : Promise.resolve([]),
  ]);

  const base = mapAggregate(summaryRows[0] as AggregateRow | undefined);
  const eligible = numberValue(eligibleRows[0]?.total);
  const hasDesktopRows = sourceRows.some((row) => row.source === "desktop");
  const coverageReason = staticCoverageReason ?? (hasDesktopRows ? "mixed_sources" : null);
  const coverageTotal = input.feedbackType
    ? numberValue(coverageRows[0]?.total)
    : base.total;
  return {
    summary: buildFeedbackSummary({
      base,
      coverageTotal,
      eligibleMessages: eligible,
      reason: coverageReason,
    }),
    trends: trends.map((row) => ({
      day: row.day,
      likes: numberValue(row.likes),
      dislikes: numberValue(row.dislikes),
    })),
    by_source: sources.map((row) => {
      const values = mapAggregate(row as AggregateRow);
      return { source: row.source as FeedbackSource, ...values };
    }),
    by_model: models.map((row) => {
      const values = mapAggregate(row as AggregateRow);
      return { source: row.source as FeedbackSource, model: row.model, provider: row.provider, ...values };
    }),
    by_department: departments.map((row) => {
      const values = mapAggregate(row as AggregateRow);
      return { source: row.source as FeedbackSource, department_id: row.departmentId, department_name: row.departmentName, ...values };
    }),
    items: itemRows.map((row) => ({
      id: row.id,
      source: row.source as FeedbackSource,
      feedback_type: row.value,
      model: row.model,
      provider: row.provider,
      department_id: row.departmentId,
      department_name: row.departmentName,
      created_at: dateString(row.createdAt),
      updated_at: dateString(row.updatedAt),
      answer_excerpt: redactFeedbackExcerpt(row.content ?? row.answerExcerpt ?? "") || null,
      trace_id: row.traceId,
      session_id: row.sessionId,
      message_id: row.messageId,
    })),
    total: base.total,
  };
}

async function queryPostgresql(input: AdminFeedbackQuery): Promise<AdminFeedbackResult> {
  const db = getIamDb();
  const staticCoverageReason = feedbackCoverageUnavailableReason(input);
  const conditions: SQL[] = [
    eq(pgFeedback.tenantId, input.tenantId),
    // Desktop feedback has no durable chat_messages row. Web feedback still
    // requires a complete assistant message for the joined cohort.
    or(
      and(
        eq(pgFeedback.source, "web"),
        eq(pgMessages.role, "assistant"),
        eq(pgMessages.status, "complete"),
      ),
      eq(pgFeedback.source, "desktop"),
    )!,
  ];
  if (input.departmentId) conditions.push(eq(pgFeedback.departmentId, input.departmentId));
  if (input.feedbackType) conditions.push(eq(pgFeedback.value, input.feedbackType));
  if (input.model) conditions.push(ilike(pgFeedback.model, `%${input.model}%`));
  if (input.provider) conditions.push(ilike(pgFeedback.provider, `%${input.provider}%`));
  if (input.source) conditions.push(eq(pgFeedback.source, input.source));
  const answerDate = sql`coalesce(${pgMessages.createdAt}, ${pgFeedback.createdAt})`;
  if (input.start) conditions.push(gte(answerDate, input.start));
  if (input.end) conditions.push(lte(answerDate, input.end));
  const where = and(...conditions);

  // Keep this cohort independent of feedback_type. A type-filtered numerator
  // is useful for like/dislike analysis, but it is not feedback coverage.
  const coverageConditions: SQL[] = [
    eq(pgFeedback.tenantId, input.tenantId),
    eq(pgFeedback.source, "web"),
    eq(pgMessages.role, "assistant"),
    eq(pgMessages.status, "complete"),
  ];
  if (input.departmentId) coverageConditions.push(eq(pgFeedback.departmentId, input.departmentId));
  if (input.model) coverageConditions.push(ilike(pgFeedback.model, `%${input.model}%`));
  if (input.provider) coverageConditions.push(ilike(pgFeedback.provider, `%${input.provider}%`));
  if (input.source) coverageConditions.push(eq(pgFeedback.source, input.source));
  if (input.start) coverageConditions.push(gte(answerDate, input.start));
  if (input.end) coverageConditions.push(lte(answerDate, input.end));
  const coverageWhere = and(...coverageConditions);

  const messageConditions: SQL[] = [
    eq(pgMessages.tenantId, input.tenantId),
    eq(pgMessages.role, "assistant"),
    eq(pgMessages.status, "complete"),
  ];
  if (input.departmentId) messageConditions.push(eq(pgUsers.deptId, input.departmentId));
  if (input.model) messageConditions.push(ilike(pgMessages.model, `%${input.model}%`));
  if (input.start) messageConditions.push(gte(pgMessages.createdAt, input.start));
  if (input.end) messageConditions.push(lte(pgMessages.createdAt, input.end));

  const aggregateSelection = {
    total: count(),
    likes: sql<number>`sum(case when ${pgFeedback.value} = 'like' then 1 else 0 end)`,
    dislikes: sql<number>`sum(case when ${pgFeedback.value} = 'dislike' then 1 else 0 end)`,
  };
  const day = sql<string>`to_char(coalesce(${pgMessages.createdAt}, ${pgFeedback.createdAt}), 'YYYY-MM-DD')`;

  const joinPgMessage = and(
    eq(pgMessages.id, pgFeedback.messageId),
    eq(pgMessages.tenantId, pgFeedback.tenantId),
    eq(pgMessages.userId, pgFeedback.userId),
  );

  const [summaryRows, eligibleRows, coverageRows, sourceRows, trends, sources, models, departments, itemRows] = await Promise.all([
    db.select(aggregateSelection).from(pgFeedback).leftJoin(pgMessages, joinPgMessage).where(where),
    staticCoverageReason
      ? Promise.resolve([] as Array<{ total: number | string | null }>)
      : db
          .select({ total: count() })
          .from(pgMessages)
          .innerJoin(pgUsers, and(eq(pgUsers.id, pgMessages.userId), eq(pgUsers.tenantId, pgMessages.tenantId)))
          .where(and(...messageConditions)),
    input.feedbackType && !staticCoverageReason
      ? db
          .select({ total: count() })
          .from(pgFeedback)
          .leftJoin(pgMessages, joinPgMessage)
          .where(coverageWhere)
      : Promise.resolve([] as Array<{ total: number | string | null }>),
    db
      .select({ source: pgFeedback.source })
      .from(pgFeedback)
      .leftJoin(pgMessages, joinPgMessage)
      .where(where)
      .groupBy(pgFeedback.source),
    db
      .select({ day, ...aggregateSelection })
      .from(pgFeedback)
      .leftJoin(pgMessages, joinPgMessage)
      .where(where)
      .groupBy(day)
      .orderBy(asc(day)),
    db
      .select({ source: pgFeedback.source, ...aggregateSelection })
      .from(pgFeedback)
      .leftJoin(pgMessages, joinPgMessage)
      .where(where)
      .groupBy(pgFeedback.source)
      .orderBy(desc(count())),
    db
      .select({ source: pgFeedback.source, model: pgFeedback.model, provider: pgFeedback.provider, ...aggregateSelection })
      .from(pgFeedback)
      .leftJoin(pgMessages, joinPgMessage)
      .where(where)
      .groupBy(pgFeedback.source, pgFeedback.model, pgFeedback.provider)
      .orderBy(desc(count()))
      .limit(50),
    db
      .select({
        source: pgFeedback.source,
        departmentId: pgFeedback.departmentId,
        departmentName: pgDepartments.name,
        ...aggregateSelection,
      })
      .from(pgFeedback)
      .leftJoin(pgMessages, joinPgMessage)
      .leftJoin(
        pgDepartments,
        and(
          eq(pgDepartments.id, pgFeedback.departmentId),
          eq(pgDepartments.tenantId, pgFeedback.tenantId),
        ),
      )
      .where(where)
      .groupBy(pgFeedback.source, pgFeedback.departmentId, pgDepartments.name)
      .orderBy(desc(count()))
      .limit(100),
    input.detailsVisible
      ? db
          .select({
            id: pgFeedback.id,
            source: pgFeedback.source,
            value: pgFeedback.value,
            model: pgFeedback.model,
            provider: pgFeedback.provider,
            departmentId: pgFeedback.departmentId,
            departmentName: pgDepartments.name,
            createdAt: pgFeedback.createdAt,
            updatedAt: pgFeedback.updatedAt,
            traceId: pgFeedback.traceId,
            sessionId: pgFeedback.sessionId,
            messageId: pgFeedback.messageId,
            content: pgMessages.content,
            answerExcerpt: pgFeedback.answerExcerpt,
          })
          .from(pgFeedback)
          .leftJoin(pgMessages, joinPgMessage)
          .leftJoin(
            pgDepartments,
            and(
              eq(pgDepartments.id, pgFeedback.departmentId),
              eq(pgDepartments.tenantId, pgFeedback.tenantId),
            ),
          )
          .where(where)
          .orderBy(desc(pgFeedback.updatedAt))
          .limit(input.limit)
          .offset(input.offset)
      : Promise.resolve([]),
  ]);

  const base = mapAggregate(summaryRows[0] as AggregateRow | undefined);
  const eligible = numberValue(eligibleRows[0]?.total);
  const coverageTotal = input.feedbackType
    ? numberValue(coverageRows[0]?.total)
    : base.total;
  return {
    summary: buildFeedbackSummary({
      base,
      coverageTotal,
      eligibleMessages: eligible,
      reason: staticCoverageReason ?? (sourceRows.some((row) => row.source === "desktop") ? "mixed_sources" : null),
    }),
    trends: trends.map((row) => ({
      day: row.day,
      likes: numberValue(row.likes),
      dislikes: numberValue(row.dislikes),
    })),
    by_source: sources.map((row) => {
      const values = mapAggregate(row as AggregateRow);
      return { source: row.source as FeedbackSource, ...values };
    }),
    by_model: models.map((row) => {
      const values = mapAggregate(row as AggregateRow);
      return { source: row.source as FeedbackSource, model: row.model, provider: row.provider, ...values };
    }),
    by_department: departments.map((row) => {
      const values = mapAggregate(row as AggregateRow);
      return { source: row.source as FeedbackSource, department_id: row.departmentId, department_name: row.departmentName, ...values };
    }),
    items: itemRows.map((row) => ({
      id: row.id,
      source: row.source as FeedbackSource,
      feedback_type: row.value,
      model: row.model,
      provider: row.provider,
      department_id: row.departmentId,
      department_name: row.departmentName,
      created_at: dateString(row.createdAt),
      updated_at: dateString(row.updatedAt),
      answer_excerpt: redactFeedbackExcerpt(row.content ?? row.answerExcerpt ?? "") || null,
      trace_id: row.traceId,
      session_id: row.sessionId,
      message_id: row.messageId,
    })),
    total: base.total,
  };
}

export async function queryAdminFeedback(input: AdminFeedbackQuery): Promise<AdminFeedbackResult> {
  return resolveDatabaseConfig().dialect === "mysql" ? queryMysql(input) : queryPostgresql(input);
}
