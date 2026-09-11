import {
  enterpriseRuntimeTokenQuotas,
  enterpriseUserOptOuts,
  tenants,
} from "@agenticx/db-schema/mysql";
import { and, eq, inArray, sql } from "drizzle-orm";

import { getMysqlRepositoryDb } from "./db";

async function lockTenantRow(db: any, tenantId: string): Promise<void> {
  await db.execute(sql`select ${tenants.id} from ${tenants} where ${tenants.id} = ${tenantId} for update`);
}

type OptOutSubjectRow = { subject: string };

export async function mysqlListOptOuts(
  tenantId: string,
  userId: string,
  dbOrTx?: any,
): Promise<OptOutSubjectRow[]> {
  const db = dbOrTx ?? (await getMysqlRepositoryDb());
  return (await db
    .select({ subject: enterpriseUserOptOuts.subject })
    .from(enterpriseUserOptOuts)
    .where(
      and(eq(enterpriseUserOptOuts.tenantId, tenantId), eq(enterpriseUserOptOuts.userId, userId)),
    )) as OptOutSubjectRow[];
}

/** Capability/opt-out migrations share the tenant delivery lock with PG. */
export async function mysqlLockTenantRow(db: any, tenantId: string): Promise<void> {
  await lockTenantRow(db, tenantId);
}

export async function mysqlInsertOptOuts(
  rows: Array<typeof enterpriseUserOptOuts.$inferInsert>,
  dbOrTx?: any,
): Promise<void> {
  if (rows.length === 0) return;
  const db = dbOrTx ?? (await getMysqlRepositoryDb());
  for (const row of rows) {
    await db
      .insert(enterpriseUserOptOuts)
      .values(row)
      .onDuplicateKeyUpdate({ set: { updatedAt: row.updatedAt ?? new Date() } });
  }
}

export async function mysqlDeleteOptOuts(
  tenantId: string,
  userId: string,
  subjects: readonly string[],
  dbOrTx?: any,
): Promise<void> {
  if (subjects.length === 0) return;
  const db = dbOrTx ?? (await getMysqlRepositoryDb());
  await db
    .delete(enterpriseUserOptOuts)
    .where(
      and(
        eq(enterpriseUserOptOuts.tenantId, tenantId),
        eq(enterpriseUserOptOuts.userId, userId),
        inArray(enterpriseUserOptOuts.subject, [...subjects]),
      ),
    );
}

export async function mysqlSetUserOptOut(
  tenantId: string,
  userId: string,
  subject: string,
  disabled: boolean,
  dbOrTx?: any,
): Promise<void> {
  const apply = async (tx: any): Promise<void> => {
    await mysqlDeleteOptOuts(tenantId, userId, [subject], tx);
    if (disabled) {
      const now = new Date();
      await mysqlInsertOptOuts(
        [{ tenantId, userId, subject, createdAt: now, updatedAt: now }],
        tx,
      );
    }
  };
  if (dbOrTx) {
    await apply(dbOrTx);
    return;
  }
  const db = await getMysqlRepositoryDb();
  await db.transaction(async (tx) => {
    await lockTenantRow(tx, tenantId);
    await apply(tx);
  });
}

export async function mysqlReplaceUserOptOutSubjects(
  tenantId: string,
  userId: string,
  subjects: readonly string[],
  matches: (subject: string) => boolean,
  dbOrTx?: any,
): Promise<string[]> {
  const apply = async (tx: any): Promise<string[]> => {
    const currentRows = await mysqlListOptOuts(tenantId, userId, tx);
    const current = [...new Set(currentRows.map((row) => row.subject))];
    const wanted = [...new Set(subjects.map((value) => String(value ?? "").trim()).filter(Boolean))].filter(matches);
    const stale = current.filter((subject) => matches(subject) && !wanted.includes(subject));
    if (stale.length > 0) await mysqlDeleteOptOuts(tenantId, userId, stale, tx);
    const added = wanted.filter((subject) => !current.includes(subject));
    if (added.length > 0) {
      const now = new Date();
      await mysqlInsertOptOuts(
        added.map((subject) => ({ tenantId, userId, subject, createdAt: now, updatedAt: now })),
        tx,
      );
    }
    return wanted;
  };
  if (dbOrTx) return apply(dbOrTx);
  const db = await getMysqlRepositoryDb();
  return db.transaction(async (tx) => {
    await lockTenantRow(tx, tenantId);
    return apply(tx);
  });
}

export async function mysqlReadQuotaConfigRow(tenantId: string, dbOrTx?: any) {
  const db = dbOrTx ?? (await getMysqlRepositoryDb());
  return db
    .select({ config: enterpriseRuntimeTokenQuotas.config, updatedAt: enterpriseRuntimeTokenQuotas.updatedAt })
    .from(enterpriseRuntimeTokenQuotas)
    .where(eq(enterpriseRuntimeTokenQuotas.tenantId, tenantId))
    .limit(1);
}

/**
 * Consume the legacy exclusion field with a compare-and-swap on the quota
 * version. The opt-out inserts and this update must use the same transaction.
 */
export async function mysqlConsumeLegacyModelExclusions(
  tenantId: string,
  expectedUpdatedAt: Date | string,
  config: Record<string, unknown>,
  dbOrTx?: any,
): Promise<void> {
  const db = dbOrTx ?? (await getMysqlRepositoryDb());
  const current = expectedUpdatedAt instanceof Date ? expectedUpdatedAt.getTime() : new Date(expectedUpdatedAt).getTime();
  if (!Number.isFinite(current)) throw new Error("legacy quota version is invalid");
  const now = new Date();
  const updatedAt = new Date(Math.max(now.getTime(), current + 1));
  const nextConfig: Record<string, unknown> = { ...config, updatedAt: updatedAt.toISOString() };
  delete nextConfig.modelExclusions;
  const expectedVersion = new Date(current);
  const updated = await db
    .update(enterpriseRuntimeTokenQuotas)
    .set({ config: nextConfig, updatedAt })
    .where(
      and(
        eq(enterpriseRuntimeTokenQuotas.tenantId, tenantId),
        eq(enterpriseRuntimeTokenQuotas.updatedAt, expectedVersion),
      ),
    );
  if (!updated[0] || updated[0].affectedRows !== 1) {
    throw new Error("legacy quota config changed during opt-out migration");
  }
}

export async function mysqlListTenantOptOuts(tenantId: string) {
  const db = await getMysqlRepositoryDb();
  return db
    .select({ userId: enterpriseUserOptOuts.userId, subject: enterpriseUserOptOuts.subject })
    .from(enterpriseUserOptOuts)
    .where(eq(enterpriseUserOptOuts.tenantId, tenantId));
}
