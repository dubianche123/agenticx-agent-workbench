/**
 * 个人关闭记录（能力 + 模型）的读写。
 *
 * 只记「关掉了什么」——用户无权开启企业没给的东西，所以「打开」就是删掉这一行，
 * 没有反向的表。存服务端而非本机：本机存的话换台电脑或重装就全部复原成开启，
 * 也无法审计。
 */

import {
  enterpriseRuntimeTokenQuotas as pgQuotas,
  enterpriseUserOptOuts as pgOptOuts,
  tenants as pgTenants,
} from "@agenticx/db-schema";
import { modelOptOutSubject } from "@agenticx/config";
import { and, eq, inArray, sql } from "drizzle-orm";

import { resolveDatabaseConfig } from "../database/config";
import { getIamDb } from "../db";
import { getMysqlRepositoryDb } from "./mysql/db";
import {
  mysqlInsertOptOuts,
  mysqlConsumeLegacyModelExclusions,
  mysqlListOptOuts,
  mysqlListTenantOptOuts,
  mysqlLockTenantRow,
  mysqlReadQuotaConfigRow,
  mysqlReplaceUserOptOutSubjects,
  mysqlSetUserOptOut,
} from "./mysql/user-opt-outs";

function isMysql(): boolean {
  return resolveDatabaseConfig().dialect === "mysql";
}

async function lockTenantRow(db: any, tenantId: string): Promise<void> {
  await db.execute(sql`select ${pgTenants.id} from ${pgTenants} where ${pgTenants.id} = ${tenantId} for update`);
}

function clean(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean))];
}

export async function listUserOptOuts(tenantId: string, userId: string): Promise<string[]> {
  const id = String(userId ?? "").trim();
  if (!id) return [];
  await migrateLegacyModelExclusionsIfNeeded(tenantId);
  const rows = isMysql()
    ? await mysqlListOptOuts(tenantId, id)
    : await getIamDb()
        .select({ subject: pgOptOuts.subject })
        .from(pgOptOuts)
        .where(and(eq(pgOptOuts.tenantId, tenantId), eq(pgOptOuts.userId, id)));
  return [...new Set(rows.map((row) => row.subject))].sort();
}

/** Read opt-outs from a caller-owned transaction, including legacy migration. */
export async function listUserOptOutsInTransaction(
  tenantId: string,
  userId: string,
  dbOrTx: any,
): Promise<string[]> {
  const id = String(userId ?? "").trim();
  if (!id) return [];
  if (!dbOrTx || typeof dbOrTx.select !== "function") {
    throw new Error("transactional opt-out read unavailable");
  }
  await migrateLegacyModelExclusionsIfNeeded(tenantId, dbOrTx, { strict: true });
  const rows = isMysql()
    ? await mysqlListOptOuts(tenantId, id, dbOrTx)
    : await dbOrTx
        .select({ subject: pgOptOuts.subject })
        .from(pgOptOuts)
        .where(and(eq(pgOptOuts.tenantId, tenantId), eq(pgOptOuts.userId, id)));
  return [...new Set((rows as Array<{ subject: string }>).map((row) => row.subject))].sort();
}

/**
 * 整租户的关闭记录，按用户分组。
 *
 * 概览页要为每个成员算「他关掉了什么」，逐人查会变成 N 次往返；这张表按租户很小，
 * 一次取回来在内存里分组更划算。
 */
export async function listTenantOptOuts(tenantId: string): Promise<Map<string, string[]>> {
  await migrateLegacyModelExclusionsIfNeeded(tenantId);
  const rows = isMysql()
    ? await mysqlListTenantOptOuts(tenantId)
    : await getIamDb()
        .select({ userId: pgOptOuts.userId, subject: pgOptOuts.subject })
        .from(pgOptOuts)
        .where(eq(pgOptOuts.tenantId, tenantId));
  const out = new Map<string, string[]>();
  for (const row of rows) {
    const list = out.get(row.userId) ?? [];
    list.push(row.subject);
    out.set(row.userId, list);
  }
  return out;
}

/** 关掉（disabled=true）或打开（false）一件东西。 */
export async function setUserOptOut(
  tenantId: string,
  userId: string,
  subject: string,
  disabled: boolean,
): Promise<void> {
  const id = String(userId ?? "").trim();
  const key = String(subject ?? "").trim();
  if (!id || !key) return;
  if (isMysql()) {
    const db = await getMysqlRepositoryDb();
    await db.transaction(async (tx: any) => {
      await mysqlLockTenantRow(tx, tenantId);
      await migrateLegacyModelExclusionsIfNeeded(tenantId, tx, { strict: true });
      await mysqlSetUserOptOut(tenantId, id, key, disabled, tx);
    });
    return;
  }
  // 先删后插而不是 upsert：两种方言的冲突语法不同，而这张表只有主键没有其他列。
  const db = getIamDb();
  await db.transaction(async (tx) => {
    await lockTenantRow(tx, tenantId);
    await migrateLegacyModelExclusionsIfNeeded(tenantId, tx, { strict: true });
    await removeSubjects(tx, tenantId, id, [key]);
    if (!disabled) return;
    const now = new Date();
    const rows = [{ tenantId, userId: id, subject: key, createdAt: now, updatedAt: now }];
    await tx.insert(pgOptOuts).values(rows).onConflictDoNothing();
  });
}

/** 整体替换某个用户在某一类主体下的关闭清单（模型编辑页按这个保存）。 */
export async function replaceUserOptOutSubjects(
  tenantId: string,
  userId: string,
  subjects: readonly string[],
  matches: (subject: string) => boolean,
): Promise<string[]> {
  const id = String(userId ?? "").trim();
  if (!id) return [];
  const wanted = clean(subjects).filter(matches);
  if (isMysql()) {
    const db = await getMysqlRepositoryDb();
    return db.transaction(async (tx: any) => {
      await mysqlLockTenantRow(tx, tenantId);
      await migrateLegacyModelExclusionsIfNeeded(tenantId, tx, { strict: true });
      return mysqlReplaceUserOptOutSubjects(tenantId, id, wanted, matches, tx);
    });
  }
  const db = getIamDb();
  await db.transaction(async (tx) => {
    await lockTenantRow(tx, tenantId);
    await migrateLegacyModelExclusionsIfNeeded(tenantId, tx, { strict: true });
    const currentRows = await tx
      .select({ subject: pgOptOuts.subject })
      .from(pgOptOuts)
      .where(and(eq(pgOptOuts.tenantId, tenantId), eq(pgOptOuts.userId, id)));
    const current = [...new Set(currentRows.map((row) => row.subject))];
    const stale = current.filter((subject) => matches(subject) && !wanted.includes(subject));
    if (stale.length > 0) await removeSubjects(tx, tenantId, id, stale);
    const added = wanted.filter((subject) => !current.includes(subject));
    if (added.length > 0) {
      const now = new Date();
      await tx.insert(pgOptOuts).values(added.map((subject) => ({
        tenantId,
        userId: id,
        subject,
        createdAt: now,
        updatedAt: now,
      }))).onConflictDoNothing();
    }
  });
  return wanted;
}

async function removeSubjects(
  db: any,
  tenantId: string,
  userId: string,
  subjects: readonly string[],
): Promise<void> {
  if (subjects.length === 0) return;
  await db
    .delete(pgOptOuts)
    .where(
      and(
        eq(pgOptOuts.tenantId, tenantId),
        eq(pgOptOuts.userId, userId),
        inArray(pgOptOuts.subject, [...subjects]),
      ),
    );
}

let migratedTenants = new Set<string>();

type LegacyMigrationOptions = {
  /** Transactional callers must see migration failures instead of a partial snapshot. */
  strict?: boolean;
};

async function lockMigrationTenant(db: any, tenantId: string): Promise<void> {
  if (isMysql()) {
    await mysqlLockTenantRow(db, tenantId);
    return;
  }
  await lockTenantRow(db, tenantId);
}

function nextLegacyQuotaUpdatedAt(current: unknown, now = new Date()): Date {
  const currentMs = current instanceof Date
    ? current.getTime()
    : new Date(String(current ?? "")).getTime();
  return Number.isFinite(currentMs)
    ? new Date(Math.max(now.getTime(), currentMs + 1))
    : now;
}

async function consumeLegacyModelExclusions(
  tenantId: string,
  config: Record<string, unknown>,
  expectedUpdatedAt: unknown,
  db: any,
): Promise<void> {
  if (expectedUpdatedAt === undefined || expectedUpdatedAt === null) {
    throw new Error("legacy quota version is missing");
  }
  const updatedAt = nextLegacyQuotaUpdatedAt(expectedUpdatedAt);
  const nextConfig: Record<string, unknown> = { ...config, updatedAt: updatedAt.toISOString() };
  delete nextConfig.modelExclusions;
  if (isMysql()) {
    await mysqlConsumeLegacyModelExclusions(
      tenantId,
      expectedUpdatedAt as Date | string,
      config,
      db,
    );
    return;
  }
  const updated = await db
    .update(pgQuotas)
    .set({ config: nextConfig, updatedAt })
    .where(
      and(
        eq(pgQuotas.tenantId, tenantId),
        eq(pgQuotas.updatedAt, expectedUpdatedAt as Date),
      ),
    )
    .returning({ tenantId: pgQuotas.tenantId });
  if (updated.length !== 1) {
    throw new Error("legacy quota config changed during opt-out migration");
  }
}

/** Execute the legacy transfer and source consumption inside one transaction. */
async function migrateLegacyModelExclusionsInTransaction(
  tenantId: string,
  db: any,
): Promise<void> {
  const rows = isMysql()
    ? await mysqlReadQuotaConfigRow(tenantId, db)
    : await db
        .select({ config: pgQuotas.config, updatedAt: pgQuotas.updatedAt })
        .from(pgQuotas)
        .where(eq(pgQuotas.tenantId, tenantId))
        .limit(1);
  const row = rows[0] as { config?: unknown; updatedAt?: unknown } | undefined;
  const configValue = row?.config;
  if (!configValue || typeof configValue !== "object" || Array.isArray(configValue)) return;
  const config = configValue as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(config, "modelExclusions")) return;

  const exclusionsValue = config.modelExclusions;
  if (exclusionsValue !== undefined && exclusionsValue !== null &&
      (typeof exclusionsValue !== "object" || Array.isArray(exclusionsValue))) {
    throw new Error("legacy modelExclusions config is invalid");
  }
  const exclusions = (exclusionsValue ?? {}) as Record<string, unknown>;
  const now = new Date();
  const pending: Array<{
    tenantId: string;
    userId: string;
    subject: string;
    createdAt: Date;
    updatedAt: Date;
  }> = [];
  for (const [userId, modelIds] of Object.entries(exclusions)) {
    if (!Array.isArray(modelIds)) continue;
    for (const modelId of clean(modelIds.map(String))) {
      pending.push({
        tenantId,
        userId,
        subject: modelOptOutSubject(modelId),
        createdAt: now,
        updatedAt: now,
      });
    }
  }
  if (pending.length > 0) {
    if (isMysql()) await mysqlInsertOptOuts(pending, db);
    else await db.insert(pgOptOuts).values(pending).onConflictDoNothing();
  }
  // The source is consumed only after all inserts succeed. The version CAS
  // prevents a quota writer that read the old JSON from overwriting the
  // consumed row after this transaction commits.
  await consumeLegacyModelExclusions(tenantId, config, row?.updatedAt, db);
}

/**
 * 把配额 JSON 里的 modelExclusions 搬进这张表。
 *
 * 旧字段被成功消费后，每个进程只需记住一次已完成状态；数据库里的字段清除才是
 * 跨进程/副本的持久判据，不能只看新表里是否已有 `model:` 行。
 */
export async function migrateLegacyModelExclusionsIfNeeded(
  tenantId: string,
  dbOrTx?: any,
  options: LegacyMigrationOptions = {},
): Promise<void> {
  const transactional = Boolean(dbOrTx);
  if (!transactional && migratedTenants.has(tenantId)) return;
  try {
    if (transactional) {
      // The caller owns the transaction (and normally already holds this
      // tenant lock); reusing it keeps the FK writes and source consumption
      // atomic with the dispatch snapshot.
      await lockMigrationTenant(dbOrTx, tenantId);
      await migrateLegacyModelExclusionsInTransaction(tenantId, dbOrTx);
      return;
    }

    const db = isMysql() ? await getMysqlRepositoryDb() : getIamDb();
    await db.transaction(async (tx: any) => {
      await lockMigrationTenant(tx, tenantId);
      await migrateLegacyModelExclusionsInTransaction(tenantId, tx);
    });
    // Set the process memo only after the owning transaction commits.
    migratedTenants.add(tenantId);
  } catch (error) {
    // 迁移失败不该让读取整体失败；下次进程重启再试。
    migratedTenants.delete(tenantId);
    if (transactional || options.strict) throw error;
  }
}

/** 测试用：清掉进程内的「已迁移」记忆。 */
export function resetLegacyModelExclusionMigration(): void {
  migratedTenants = new Set<string>();
}
