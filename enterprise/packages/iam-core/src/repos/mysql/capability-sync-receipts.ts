import { enterpriseCapabilitySyncReceipts } from "@agenticx/db-schema/mysql";
import { and, desc, eq, inArray } from "drizzle-orm";
import { ulid } from "ulid";

import type {
  CapabilitySyncReceiptInsert,
  CapabilitySyncReceiptRecord,
  CapabilitySyncReceiptQuery,
} from "../../capability-sync-receipt-service";
import { getMysqlRepositoryDb } from "./db";

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toRecord(
  row: typeof enterpriseCapabilitySyncReceipts.$inferSelect,
): CapabilitySyncReceiptRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    userId: row.userId,
    apiTokenId: row.apiTokenId,
    capabilityId: row.capabilityId,
    kind: row.kind,
    status: row.status,
    version: row.version ?? null,
    digest: row.digest ?? null,
    errorCode: row.errorCode ?? null,
    message: row.message ?? null,
    attemptedAt: iso(row.attemptedAt),
    appliedAt: row.appliedAt ? iso(row.appliedAt) : null,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

export async function insertMysqlCapabilitySyncReceipt(
  input: CapabilitySyncReceiptInsert,
): Promise<CapabilitySyncReceiptRecord> {
  const db = await getMysqlRepositoryDb();
  const now = new Date();
  const id = ulid();
  await db
    .insert(enterpriseCapabilitySyncReceipts)
    .values({
      id,
      tenantId: input.tenantId,
      userId: input.userId,
      apiTokenId: input.apiTokenId,
      capabilityId: input.capabilityId,
      kind: input.kind,
      status: input.status,
      version: input.version,
      digest: input.digest,
      errorCode: input.errorCode,
      message: input.message,
      attemptedAt: input.attemptedAt,
      appliedAt: input.appliedAt,
      createdAt: now,
      updatedAt: now,
    })
    .onDuplicateKeyUpdate({
      set: {
        kind: input.kind,
        status: input.status,
        version: input.version,
        digest: input.digest,
        errorCode: input.errorCode,
        message: input.message,
        attemptedAt: input.attemptedAt,
        appliedAt: input.appliedAt,
        updatedAt: now,
      },
    });
  const rows = await db
    .select()
    .from(enterpriseCapabilitySyncReceipts)
    .where(
      and(
        eq(enterpriseCapabilitySyncReceipts.tenantId, input.tenantId),
        eq(enterpriseCapabilitySyncReceipts.userId, input.userId),
        eq(enterpriseCapabilitySyncReceipts.apiTokenId, input.apiTokenId),
        eq(enterpriseCapabilitySyncReceipts.capabilityId, input.capabilityId),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) throw new Error("create capability sync receipt failed");
  return toRecord(row);
}

export async function listMysqlCapabilitySyncReceipts(
  query: CapabilitySyncReceiptQuery,
): Promise<CapabilitySyncReceiptRecord[]> {
  const db = await getMysqlRepositoryDb();
  const conditions = [
    eq(enterpriseCapabilitySyncReceipts.tenantId, query.tenantId),
    eq(enterpriseCapabilitySyncReceipts.userId, query.userId),
    eq(enterpriseCapabilitySyncReceipts.apiTokenId, query.apiTokenId),
  ];
  if (query.capabilityId) {
    conditions.push(eq(enterpriseCapabilitySyncReceipts.capabilityId, query.capabilityId));
  }
  if (query.capabilityIds && query.capabilityIds.length > 0) {
    conditions.push(inArray(enterpriseCapabilitySyncReceipts.capabilityId, [...query.capabilityIds]));
  }
  const queryBuilder = db
    .select()
    .from(enterpriseCapabilitySyncReceipts)
    .where(and(...conditions))
    .orderBy(desc(enterpriseCapabilitySyncReceipts.updatedAt), desc(enterpriseCapabilitySyncReceipts.id));
  const rows = query.limit === undefined ? await queryBuilder : await queryBuilder.limit(query.limit);
  return rows.map(toRecord);
}
