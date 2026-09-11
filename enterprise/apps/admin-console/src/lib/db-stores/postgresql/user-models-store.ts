/**
 * admin-console · 用户 ↔ 模型可见性映射（PostgreSQL）。
 * 原为 enterprise/.runtime/admin/user-models.json。
 */

import {
  departments as departmentsTable,
  enterpriseRuntimeModelProviders as providersTable,
  enterpriseRuntimeUserVisibleModels as uvmTable,
  enterpriseUserGroupMembers as groupMembersTable,
  enterpriseUserGroups as groupsTable,
  enterpriseUserOptOuts as optOutsTable,
  users as usersTable,
} from "@agenticx/db-schema";
import {
  getDepartment,
  getIamDb,
  listDepartmentAncestorIds,
  migrateLegacyUserVisibleModelsIfNeeded,
  resolveRuntimeAdminDir,
} from "@agenticx/iam-core";
import * as path from "node:path";
import { eq, and, inArray } from "drizzle-orm";

import {
  clipToAllowed,
  computeEffectiveDeptAllowed,
  computePrunedModelIds,
  mergeUserStoredSet,
  collectUserAssignmentKeys,
} from "../../effective-models";
import { listAllEnabledModelIds } from "../../model-providers-store";

const LEGACY_PATH = path.join(resolveRuntimeAdminDir(), "user-models.json");

function requiredTenant(explicitTenantId?: string): string {
  const t = explicitTenantId?.trim() || process.env.DEFAULT_TENANT_ID?.trim();
  if (!t) throw new Error("DEFAULT_TENANT_ID is required for user-visible model assignments.");
  return t;
}

type Mapping = Record<string, string[]>;

function chunked<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function migrateLegacyIfNeeded(tid: string): Promise<void> {
  await migrateLegacyUserVisibleModelsIfNeeded(tid);
}

export type UserModelsEditPayload = {
  userId: string;
  modelIds: string[];
  parentAllowedIds: string[];
  parentLabel: string;
  prunedModelIds: string[];
  /** @deprecated 兼容旧前端，等同 parentAllowedIds */
  inheritedDeptModelIds: string[];
};

export type SetUserModelsResult = {
  modelIds: string[];
  prunedModelIds: string[];
};

export type SetUserModelsForAliasesInput = {
  userId: string;
  email: string;
  modelIds: readonly string[];
  deptId: string | null;
  /** The authenticated tenant. Falling back to DEFAULT_TENANT_ID is retained for old callers. */
  tenantId?: string;
  /** Union read at preview time, used as a compare-and-swap precondition. */
  expectedModelIds: readonly string[];
  /** Exact rows read for each alias, including an explicitly empty alias. */
  expectedModelIdsByKey?: Readonly<Record<string, readonly string[]>>;
  /** Department/provider ceiling read at preview time. */
  expectedParentAllowedIds?: readonly string[];
  /** Group grants read at preview time; checked under the write transaction. */
  expectedGroupModelIds?: readonly string[];
  /** Group model opt-outs read at preview time; checked under the write transaction. */
  expectedExcludedGroupModelIds?: readonly string[];
  /** Re-check the live mutation authorization after all policy reads and before writes. */
  beforeWrite?: () => Promise<void>;
};

/** Raised before any delete/insert when the preview no longer describes the live state. */
export class UserModelsPreconditionError extends Error {
  public readonly code = "USER_MODELS_PRECONDITION";

  public constructor(message = "user model assignments changed since the support preview") {
    super(message);
    this.name = "UserModelsPreconditionError";
  }
}

function sameModelSet(left: readonly string[], right: readonly string[]): boolean {
  const a = [...new Set(left.map((id) => id.trim()).filter(Boolean))].sort();
  const b = [...new Set(right.map((id) => id.trim()).filter(Boolean))].sort();
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

function isTransactionConflict(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = String((error as Error & { code?: unknown }).code ?? "");
  return (
    ["40001", "40P01", "1213", "1205"].includes(code) ||
    error.name === "SerializationFailure" ||
    error.name === "DeadlockDetected"
  );
}

function enabledModelIdsFromRows(
  rows: readonly { providerId: string; enabled: boolean; models: unknown }[],
): string[] {
  const ids: string[] = [];
  for (const row of rows) {
    if (!row.enabled || !Array.isArray(row.models)) continue;
    for (const model of row.models) {
      if (!model || typeof model !== "object") continue;
      const name = (model as { name?: unknown }).name;
      if (typeof name === "string" && name.trim() && (model as { enabled?: unknown }).enabled === true) {
        ids.push(`${row.providerId}/${name.trim()}`);
      }
    }
  }
  return [...new Set(ids)];
}

async function computeUserParentAllowedInTransaction(
  tx: any,
  deptId: string | null,
  tenantId: string,
): Promise<{ parentAllowedIds: string[]; parentLabel: string }> {
  const providerRows = await tx
    .select({
      providerId: providersTable.providerId,
      enabled: providersTable.enabled,
      models: providersTable.models,
    })
    .from(providersTable)
    .where(eq(providersTable.tenantId, tenantId))
    .for("update");
  const allEnabled = enabledModelIdsFromRows(providerRows);
  if (!deptId) return { parentAllowedIds: allEnabled, parentLabel: "__ALL_ENABLED__" };

  const chain: Array<{ id: string; parentId: string | null; name: string; path: string }> = [];
  const seen = new Set<string>();
  let currentId: string | null = deptId;
  while (currentId && !seen.has(currentId)) {
    seen.add(currentId);
    const rows: Array<{ id: string; parentId: string | null; name: string; path: string }> = await tx
      .select({
        id: departmentsTable.id,
        parentId: departmentsTable.parentId,
        name: departmentsTable.name,
        path: departmentsTable.path,
      })
      .from(departmentsTable)
      .where(and(eq(departmentsTable.tenantId, tenantId), eq(departmentsTable.id, currentId)))
      .for("update")
      .limit(1);
    const row: { id: string; parentId: string | null; name: string; path: string } | undefined = rows[0];
    if (!row) break;
    chain.push(row);
    currentId = row.parentId;
  }

  const assignmentKeys = chain.map((row) => `dept:${row.id}`);
  const assignmentRows = assignmentKeys.length
    ? await tx
        .select({ assignmentKey: uvmTable.assignmentKey, modelId: uvmTable.modelId })
        .from(uvmTable)
        .where(and(eq(uvmTable.tenantId, tenantId), inArray(uvmTable.assignmentKey, assignmentKeys)))
        .for("update")
    : [];
  const userVisibleMap: Mapping = {};
  for (const row of assignmentRows) {
    (userVisibleMap[row.assignmentKey] ??= []).push(row.modelId);
  }
  const parentAllowedIds = computeEffectiveDeptAllowed({
    allEnabledIds: allEnabled,
    userVisibleMap,
    ancestorChain: chain.map((row) => row.id),
  });
  const leaf = chain[0];
  return {
    parentAllowedIds,
    parentLabel: leaf ? `${leaf.name}（${leaf.path}）` : deptId,
  };
}

async function computeUserParentAllowed(deptId: string | null, explicitTenantId?: string): Promise<{
  parentAllowedIds: string[];
  parentLabel: string;
}> {
  const tid = requiredTenant(explicitTenantId);
  const allEnabled = await listAllEnabledModelIds(tid);
  const userVisibleMap = await listAllAssignments(tid);
  if (!deptId) {
    return { parentAllowedIds: allEnabled, parentLabel: "__ALL_ENABLED__" };
  }
  const chain = await listDepartmentAncestorIds(tid, deptId);
  const parentAllowedIds = computeEffectiveDeptAllowed({
    allEnabledIds: allEnabled,
    userVisibleMap,
    ancestorChain: chain,
  });
  const dept = await getDepartment(tid, deptId);
  const parentLabel = dept ? `${dept.name}（${dept.path}）` : deptId;
  return { parentAllowedIds, parentLabel };
}

export async function readUserEditPayload(
  userId: string,
  email: string,
  deptId: string | null,
  explicitTenantId?: string,
): Promise<UserModelsEditPayload> {
  const modelIds = await getUserModels(userId, explicitTenantId);
  const { parentAllowedIds, parentLabel } = await computeUserParentAllowed(deptId, explicitTenantId);
  const prunedModelIds = computePrunedModelIds(modelIds, new Set(parentAllowedIds));
  return {
    userId,
    modelIds,
    parentAllowedIds,
    parentLabel,
    prunedModelIds,
    inheritedDeptModelIds: parentAllowedIds,
  };
}

export async function getUserModels(userId: string, explicitTenantId?: string): Promise<string[]> {
  const tid = requiredTenant(explicitTenantId);
  await migrateLegacyIfNeeded(tid);
  const db = getIamDb();
  const rows = await db
    .select({ modelId: uvmTable.modelId })
    .from(uvmTable)
    .where(and(eq(uvmTable.tenantId, tid), eq(uvmTable.assignmentKey, userId)));
  return [...new Set(rows.map((r) => r.modelId))];
}

export async function setUserModels(
  userId: string,
  modelIds: string[],
  deptId: string | null = null,
  explicitTenantId?: string,
): Promise<SetUserModelsResult> {
  const tid = requiredTenant(explicitTenantId);
  await migrateLegacyIfNeeded(tid);
  const db = getIamDb();
  const { parentAllowedIds } = await computeUserParentAllowed(deptId, tid);
  const parentAllowed = new Set(parentAllowedIds);
  const { saved, prunedModelIds } = clipToAllowed(modelIds, parentAllowed);

  await db.delete(uvmTable).where(and(eq(uvmTable.tenantId, tid), eq(uvmTable.assignmentKey, userId)));
  if (saved.length > 0) {
    const rows = saved.map((modelId) => ({ tenantId: tid, assignmentKey: userId, modelId }));
    for (const chunk of chunked(rows, 100)) {
      await db.insert(uvmTable).values(chunk).onConflictDoNothing();
    }
  }
  return { modelIds: saved, prunedModelIds };
}

/**
 * Replace the user-id and email aliases as one compare-and-swap transaction.
 *
 * The stable users row is locked immediately before deleting the aliases. This
 * matters when one or both aliases have no rows: row locks on the mapping table
 * alone cannot serialize an insert into an absent alias. Group and department
 * assignments are never part of the delete predicate.
 */
export async function setUserModelsForAliases(
  input: SetUserModelsForAliasesInput,
): Promise<SetUserModelsResult> {
  const tid = requiredTenant(input.tenantId);
  const userId = input.userId.trim();
  const keys = collectUserAssignmentKeys(userId, input.email);
  if (!userId || keys.length === 0) throw new UserModelsPreconditionError("user identity is required");
  await migrateLegacyIfNeeded(tid);
  const db = getIamDb();

  return db.transaction(async (tx) => {
    const targetRows = await tx
      .select({
        id: usersTable.id,
        email: usersTable.email,
        deptId: usersTable.deptId,
        status: usersTable.status,
      })
      .from(usersTable)
      .where(
        and(
          eq(usersTable.tenantId, tid),
          eq(usersTable.id, userId),
          eq(usersTable.isDeleted, false),
        ),
      )
      .limit(1);
    const targetRow = targetRows[0];
    if (!targetRow) throw new UserModelsPreconditionError("target user no longer exists");
    if (
      targetRow.status !== "active" ||
      targetRow.email.trim().toLowerCase() !== input.email.trim().toLowerCase() ||
      (targetRow.deptId ?? null) !== (input.deptId ?? null)
    ) {
      throw new UserModelsPreconditionError("target user identity changed since the support preview");
    }

    // Read all policy rows through this transaction. Provider rows,
    // department ancestors, and their assignment rows are locked before the
    // snapshot is compared so a policy update cannot slip in between the
    // validation and the alias replacement.
    const latestParent = await computeUserParentAllowedInTransaction(tx, input.deptId, tid);
    if (
      input.expectedParentAllowedIds !== undefined &&
      !sameModelSet(latestParent.parentAllowedIds, input.expectedParentAllowedIds)
    ) {
      throw new UserModelsPreconditionError("parent model ceiling changed since the support preview");
    }

    const currentRows = await tx
      .select({ assignmentKey: uvmTable.assignmentKey, modelId: uvmTable.modelId })
      .from(uvmTable)
      .where(and(eq(uvmTable.tenantId, tid), inArray(uvmTable.assignmentKey, keys)))
      .for("update");
    const currentModelIds = [...new Set(currentRows.map((row) => row.modelId))];
    if (!sameModelSet(currentModelIds, input.expectedModelIds)) {
      throw new UserModelsPreconditionError();
    }
    if (input.expectedModelIdsByKey !== undefined) {
      const currentByKey = new Map<string, string[]>();
      for (const key of keys) currentByKey.set(key, []);
      for (const row of currentRows) currentByKey.get(row.assignmentKey)?.push(row.modelId);
      for (const key of keys) {
        if (!sameModelSet(currentByKey.get(key) ?? [], input.expectedModelIdsByKey[key] ?? [])) {
          throw new UserModelsPreconditionError();
        }
      }
    }

    if (input.expectedGroupModelIds !== undefined || input.expectedExcludedGroupModelIds !== undefined) {
      // Group and opt-out rows are part of the policy snapshot. Lock the
      // current rows while reading them and use a serializable transaction so
      // a concurrent insert into an empty group/opt-out set cannot slip
      // between this validation and the alias replacement.
      const groupRows = await tx
        .select({ id: groupsTable.id })
        .from(groupsTable)
        .where(eq(groupsTable.tenantId, tid))
        .for("update");
      const groupIds = groupRows.map((row) => row.id);
      const memberRows = groupIds.length
        ? await tx
            .select({ groupId: groupMembersTable.groupId })
            .from(groupMembersTable)
            .where(
              and(
                eq(groupMembersTable.userId, userId),
                inArray(groupMembersTable.groupId, groupIds),
              ),
            )
            .for("update")
        : [];
      const memberGroupIds = [...new Set(memberRows.map((row) => row.groupId))];
      const groupKeys = memberGroupIds.map((groupId) => `group:${groupId}`);
      const groupModelRows = groupKeys.length
        ? await tx
            .select({ assignmentKey: uvmTable.assignmentKey, modelId: uvmTable.modelId })
            .from(uvmTable)
            .where(
              and(
                eq(uvmTable.tenantId, tid),
                inArray(uvmTable.assignmentKey, groupKeys),
              ),
            )
            .for("update")
        : [];
      const parentAllowed = new Set(latestParent.parentAllowedIds);
      const groupModelIds = [
        ...new Set(
          groupModelRows
            .map((row) => row.modelId)
            .filter((modelId) => parentAllowed.has(modelId)),
        ),
      ];
      if (
        input.expectedGroupModelIds !== undefined &&
        !sameModelSet(groupModelIds, input.expectedGroupModelIds)
      ) {
        throw new UserModelsPreconditionError("group model grants changed since the support preview");
      }

      const optOutRows = await tx
        .select({ subject: optOutsTable.subject })
        .from(optOutsTable)
        .where(
          and(
            eq(optOutsTable.tenantId, tid),
            eq(optOutsTable.userId, userId),
          ),
        )
        .for("update");
      const groupModelSet = new Set(groupModelIds);
      const excludedGroupModelIds = [
        ...new Set(
          optOutRows
            .map((row) => row.subject)
            .filter((subject) => subject.startsWith("model:"))
            .map((subject) => subject.slice("model:".length))
            .filter((modelId) => groupModelSet.has(modelId)),
        ),
      ];
      if (
        input.expectedExcludedGroupModelIds !== undefined &&
        !sameModelSet(excludedGroupModelIds, input.expectedExcludedGroupModelIds)
      ) {
        throw new UserModelsPreconditionError("group model opt-outs changed since the support preview");
      }
    }

    // This callback is deliberately after every policy/alias read and before
    // the first delete. The target row is locked only after the callback so a
    // support actor may also be the target without a second connection
    // deadlocking on its own row; the locked re-read below is authoritative.
    await input.beforeWrite?.();
    const lockedTargetRows = await tx
      .select({
        id: usersTable.id,
        email: usersTable.email,
        deptId: usersTable.deptId,
        status: usersTable.status,
      })
      .from(usersTable)
      .where(
        and(
          eq(usersTable.tenantId, tid),
          eq(usersTable.id, userId),
          eq(usersTable.isDeleted, false),
        ),
      )
      .for("update")
      .limit(1);
    const lockedTarget = lockedTargetRows[0];
    if (!lockedTarget) throw new UserModelsPreconditionError("target user no longer exists");
    if (
      lockedTarget.status !== "active" ||
      lockedTarget.email.trim().toLowerCase() !== input.email.trim().toLowerCase() ||
      (lockedTarget.deptId ?? null) !== (input.deptId ?? null)
    ) {
      throw new UserModelsPreconditionError("target user identity changed since the support preview");
    }

    const { saved, prunedModelIds } = clipToAllowed(input.modelIds, new Set(latestParent.parentAllowedIds));
    await tx
      .delete(uvmTable)
      .where(and(eq(uvmTable.tenantId, tid), inArray(uvmTable.assignmentKey, keys)));
    if (saved.length > 0) {
      const rows = keys.flatMap((assignmentKey) =>
        saved.map((modelId) => ({ tenantId: tid, assignmentKey, modelId })),
      );
      for (const chunk of chunked(rows, 100)) {
        await tx.insert(uvmTable).values(chunk).onConflictDoNothing();
      }
    }
    return { modelIds: saved, prunedModelIds };
  }, { isolationLevel: "serializable" }).catch((error) => {
    if (isTransactionConflict(error)) {
      throw new UserModelsPreconditionError("policy changed concurrently; retry from a fresh preview");
    }
    throw error;
  });
}

export async function listAllAssignments(tenantId?: string): Promise<Mapping> {
  const tid = requiredTenant(tenantId);
  await migrateLegacyIfNeeded(tid);
  const db = getIamDb();
  const rows = await db.select().from(uvmTable).where(eq(uvmTable.tenantId, tid));
  const map: Mapping = {};
  for (const r of rows) {
    if (!map[r.assignmentKey]) map[r.assignmentKey] = [];
    map[r.assignmentKey]!.push(r.modelId);
  }
  for (const k of Object.keys(map)) {
    map[k] = [...new Set(map[k]!)];
  }
  return map;
}

export async function deleteUserAssignment(
  userId: string,
  explicitTenantId?: string,
  explicitEmail?: string,
): Promise<void> {
  const tid = requiredTenant(explicitTenantId);
  await migrateLegacyIfNeeded(tid);
  const db = getIamDb();
  const normalizedUserId = userId.trim();
  if (!normalizedUserId) return;
  await db.transaction(async (tx) => {
    const targetRows = await tx
      .select({ email: usersTable.email })
      .from(usersTable)
      .where(and(eq(usersTable.tenantId, tid), eq(usersTable.id, normalizedUserId)))
      .for("update")
      .limit(1);
    const email = explicitEmail?.trim() || targetRows[0]?.email;
    const keys = collectUserAssignmentKeys(normalizedUserId, email);
    await tx
      .delete(uvmTable)
      .where(and(eq(uvmTable.tenantId, tid), inArray(uvmTable.assignmentKey, keys)));
  });
}

export function userModelsFilePath(): string {
  return LEGACY_PATH;
}

export function __resetUserModelsCache(): void {
  /* legacy in-process flag removed; kept for tests that reset module state */
}

export { collectUserAssignmentKeys, mergeUserStoredSet };
