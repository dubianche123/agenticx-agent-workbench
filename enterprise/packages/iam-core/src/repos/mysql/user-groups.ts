import {
  enterpriseRuntimeTokenQuotas,
  enterpriseRuntimeUserVisibleModels,
  enterpriseUserGroupMembers,
  enterpriseUserGroups,
  tenants,
  users,
} from "@agenticx/db-schema/mysql";
import { and, eq, inArray, sql } from "drizzle-orm";

import { getMysqlRepositoryDb } from "./db";

async function lockTenantRow(db: any, tenantId: string): Promise<void> {
  await db.execute(sql`select ${tenants.id} from ${tenants} where ${tenants.id} = ${tenantId} for update`);
}

async function replaceMembersInTransaction(
  db: any,
  groupId: string,
  rows: Array<typeof enterpriseUserGroupMembers.$inferInsert>,
): Promise<void> {
  await db.delete(enterpriseUserGroupMembers).where(eq(enterpriseUserGroupMembers.groupId, groupId));
  if (rows.length > 0) await db.insert(enterpriseUserGroupMembers).values(rows);
}

export async function mysqlListUserGroups(tenantId: string) {
  const db = await getMysqlRepositoryDb();
  return db.select().from(enterpriseUserGroups).where(eq(enterpriseUserGroups.tenantId, tenantId));
}

export async function mysqlListMembers(groupIds: readonly string[]) {
  if (groupIds.length === 0) return [];
  const db = await getMysqlRepositoryDb();
  return db
    .select()
    .from(enterpriseUserGroupMembers)
    .where(inArray(enterpriseUserGroupMembers.groupId, [...groupIds]));
}

export async function mysqlListGroupIdsForUser(tenantId: string, userId: string) {
  const db = await getMysqlRepositoryDb();
  return db
    .select({ groupId: enterpriseUserGroupMembers.groupId })
    .from(enterpriseUserGroupMembers)
    .innerJoin(enterpriseUserGroups, eq(enterpriseUserGroups.id, enterpriseUserGroupMembers.groupId))
    .where(
      and(eq(enterpriseUserGroups.tenantId, tenantId), eq(enterpriseUserGroupMembers.userId, userId)),
    );
}

export async function mysqlInsertUserGroup(
  row: typeof enterpriseUserGroups.$inferInsert,
): Promise<void> {
  const db = await getMysqlRepositoryDb();
  await db.insert(enterpriseUserGroups).values(row);
}

export async function mysqlCreateUserGroup(
  row: typeof enterpriseUserGroups.$inferInsert,
  memberIds: readonly string[],
): Promise<void> {
  const db = await getMysqlRepositoryDb();
  await db.transaction(async (tx) => {
    await lockTenantRow(tx, row.tenantId);
    await tx.insert(enterpriseUserGroups).values(row);
    const now = new Date();
    await replaceMembersInTransaction(
      tx,
      row.id,
      memberIds.map((userId) => ({ groupId: row.id, userId, createdAt: now, updatedAt: now })),
    );
  });
}

export async function mysqlUpdateUserGroup(
  tenantId: string,
  id: string,
  patch: Partial<typeof enterpriseUserGroups.$inferInsert>,
  memberIds?: readonly string[],
): Promise<void> {
  const db = await getMysqlRepositoryDb();
  await db.transaction(async (tx) => {
    await lockTenantRow(tx, tenantId);
    const rows = await tx
      .select({ id: enterpriseUserGroups.id })
      .from(enterpriseUserGroups)
      .where(and(eq(enterpriseUserGroups.tenantId, tenantId), eq(enterpriseUserGroups.id, id)))
      .for("update")
      .limit(1);
    if (!rows[0]) throw new Error("user group not found");
    await tx
      .update(enterpriseUserGroups)
      .set(patch)
      .where(and(eq(enterpriseUserGroups.tenantId, tenantId), eq(enterpriseUserGroups.id, id)));
    if (memberIds !== undefined) {
      const now = new Date();
      await replaceMembersInTransaction(
        tx,
        id,
        memberIds.map((userId) => ({ groupId: id, userId, createdAt: now, updatedAt: now })),
      );
    }
  });
}

export async function mysqlDeleteUserGroup(tenantId: string, id: string): Promise<boolean> {
  const db = await getMysqlRepositoryDb();
  return db.transaction(async (tx) => {
    await lockTenantRow(tx, tenantId);
    const rows = await tx
      .select({ id: enterpriseUserGroups.id })
      .from(enterpriseUserGroups)
      .where(and(eq(enterpriseUserGroups.tenantId, tenantId), eq(enterpriseUserGroups.id, id)))
      .for("update")
      .limit(1);
    if (!rows[0]) return false;
    await tx
      .delete(enterpriseUserGroups)
      .where(and(eq(enterpriseUserGroups.tenantId, tenantId), eq(enterpriseUserGroups.id, id)));
    return true;
  });
}

export async function mysqlReplaceMembers(
  tenantId: string,
  groupId: string,
  rows: Array<typeof enterpriseUserGroupMembers.$inferInsert>,
): Promise<void> {
  const db = await getMysqlRepositoryDb();
  await db.transaction(async (tx) => {
    await lockTenantRow(tx, tenantId);
    await replaceMembersInTransaction(tx, groupId, rows);
  });
}

export async function mysqlReadQuotaConfig(tenantId: string) {
  const db = await getMysqlRepositoryDb();
  return db
    .select({ config: enterpriseRuntimeTokenQuotas.config })
    .from(enterpriseRuntimeTokenQuotas)
    .where(eq(enterpriseRuntimeTokenQuotas.tenantId, tenantId))
    .limit(1);
}

export async function mysqlListExistingUserIds(tenantId: string, candidateIds: readonly string[]) {
  if (candidateIds.length === 0) return [];
  const db = await getMysqlRepositoryDb();
  return db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.tenantId, tenantId), inArray(users.id, [...candidateIds])));
}

export async function mysqlListVisibleModels(tenantId: string, keys: readonly string[]) {
  if (keys.length === 0) return [];
  const db = await getMysqlRepositoryDb();
  return db
    .select({
      assignmentKey: enterpriseRuntimeUserVisibleModels.assignmentKey,
      modelId: enterpriseRuntimeUserVisibleModels.modelId,
    })
    .from(enterpriseRuntimeUserVisibleModels)
    .where(
      and(
        eq(enterpriseRuntimeUserVisibleModels.tenantId, tenantId),
        inArray(enterpriseRuntimeUserVisibleModels.assignmentKey, [...keys]),
      ),
    );
}

export async function mysqlReplaceVisibleModels(
  tenantId: string,
  assignmentKey: string,
  modelIds: readonly string[],
): Promise<void> {
  const db = await getMysqlRepositoryDb();
  await db
    .delete(enterpriseRuntimeUserVisibleModels)
    .where(
      and(
        eq(enterpriseRuntimeUserVisibleModels.tenantId, tenantId),
        eq(enterpriseRuntimeUserVisibleModels.assignmentKey, assignmentKey),
      ),
    );
  if (modelIds.length === 0) return;
  await db
    .insert(enterpriseRuntimeUserVisibleModels)
    .values(modelIds.map((modelId) => ({ tenantId, assignmentKey, modelId })));
}
