import { principalRoleBindings, principals, roles, tenants, userRoles, users } from "@agenticx/db-schema";
import { and, asc, eq, exists, inArray, isNull, not, sql } from "drizzle-orm";
import { ulid } from "ulid";
import { ALL_REGISTERED_SCOPES, expandRoleScopes, mergeUserScopes } from "../scope-registry";
import { getIamDb, type IamDb } from "../db";
import { resolveDatabaseConfig } from "../database/config";
import { insertAuditEvent } from "./audit";
import type { RolesRepository } from "./contracts";
import { getMysqlUserRolesDetail, mysqlRolesRepository as mysqlRolesRepo } from "./mysql/roles";
import { assertGrantable } from "../authorization/grantability";
import { getPrincipalRepository } from "../authorization/repository";
import { roleMutationSnapshotMatches, roleScopeFingerprint } from "../authorization/types";
import type { GrantabilitySnapshot } from "../authorization/types";

export type RoleRow = {
  id: string;
  tenantId: string;
  code: string;
  name: string;
  scopes: string[];
  immutable: boolean;
  createdAt: string;
  updatedAt: string;
  memberCount: number;
  agentCount: number;
};

type PgDb = IamDb;

function mapRole(r: typeof roles.$inferSelect, memberCount = 0, agentCount = 0): RoleRow {
  return {
    id: r.id,
    tenantId: r.tenantId,
    code: r.code,
    name: r.name,
    scopes: (r.scopes as string[]) ?? [],
    immutable: r.immutable,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    memberCount,
    agentCount,
  };
}

export const SYSTEM_ROLE_SEED: Array<{ code: string; name: string; scopes: string[] }> = [
  { code: "super_admin", name: "超级管理员", scopes: ["*"] },
  {
    code: "personal_assistant",
    name: "个人助手能力上限",
    scopes: [
      "assistant:use",
      "user:read",
      "user:quota:update",
      "user:models:update",
      "audit:read:all",
      "audit:read:dept",
      "gateway:read",
      "metering:read",
    ],
  },
  {
    code: "owner",
    name: "企业拥有者",
    scopes: [
      "admin:enter",
      "workspace:chat",
      "user:create",
      "user:read",
      "user:update",
      "user:delete",
      "user:manage",
      "user:quota:update",
      "user:models:update",
      "dept:create",
      "dept:read",
      "dept:update",
      "dept:delete",
      "dept:manage",
      "role:create",
      "role:read",
      "role:update",
      "role:delete",
      "role:manage",
      "role:assign",
      "audit:read:all",
      "audit:export",
      "metering:read",
      "policy:read",
      "policy:create",
      "policy:update",
      "policy:delete",
      "policy:publish",
      "policy:disable",
      "policy:manage",
      "model:read",
      "provider:read",
      "provider:update",
      "sso:manage",
      "agent:read",
      "agent:create",
      "agent:update",
      "agent:delete",
      "agent:manage",
      "assistant:use",
    ],
  },
  {
    code: "admin",
    name: "管理员",
    scopes: [
      "admin:enter",
      "workspace:chat",
      "user:create",
      "user:read",
      "user:update",
      "user:quota:update",
      "user:models:update",
      "dept:read",
      "dept:create",
      "role:read",
      "role:assign",
      "audit:read:all",
      "audit:export",
      "metering:read",
      "provider:read",
      "provider:update",
      "agent:read",
      "agent:create",
      "agent:update",
      "agent:delete",
      "agent:manage",
      "assistant:use",
    ],
  },
  {
    code: "dept_admin",
    name: "部门审计",
    scopes: ["admin:enter", "audit:read:dept", "audit:export", "metering:read", "user:read", "dept:read", "assistant:use"],
  },
  {
    code: "auditor",
    name: "审计员",
    scopes: ["admin:enter", "audit:read:all", "audit:export", "metering:read", "assistant:use"],
  },
  {
    code: "sso_admin",
    name: "SSO 管理员",
    scopes: ["admin:enter", "sso:read", "sso:create", "sso:update", "sso:delete", "sso:manage", "assistant:use"],
  },
  {
    code: "policy_admin",
    name: "策略管理员",
    scopes: [
      "admin:enter",
      "policy:read",
      "policy:create",
      "policy:update",
      "policy:delete",
      "policy:disable",
      "assistant:use",
    ],
  },
  {
    code: "policy_publisher",
    name: "策略发布员",
    scopes: ["admin:enter", "policy:read", "policy:publish", "assistant:use"],
  },
  {
    code: "policy_auditor",
    name: "策略审阅员",
    scopes: ["admin:enter", "policy:read", "assistant:use"],
  },
  { code: "member", name: "成员", scopes: ["workspace:chat", "user:read", "assistant:use"] },
];

async function memberCounts(tenantId: string): Promise<{ users: Map<string, number>; agents: Map<string, number> }> {
  const db = getIamDb();
  const legacyRows = await db
    .select({
      roleId: userRoles.roleId,
      c: sql<number>`count(*)::int`,
    })
    .from(userRoles)
    .innerJoin(users, and(eq(users.id, userRoles.userId), eq(users.tenantId, userRoles.tenantId)))
    .where(and(
      eq(userRoles.tenantId, tenantId),
      eq(users.isDeleted, false),
      isNull(users.deletedAt),
      not(exists(
        db
          .select({ id: principals.id })
          .from(principals)
          .where(and(eq(principals.tenantId, tenantId), eq(principals.kind, "user"), eq(principals.userId, users.id))),
      )),
    ))
    .groupBy(userRoles.roleId);
  const principalRows = await db
    .select({
      roleId: principalRoleBindings.roleId,
      kind: principals.kind,
      c: sql<number>`count(distinct ${principalRoleBindings.principalId})::int`,
    })
    .from(principalRoleBindings)
    .innerJoin(
      principals,
      and(eq(principals.id, principalRoleBindings.principalId), eq(principals.tenantId, principalRoleBindings.tenantId)),
    )
    .where(and(
      eq(principalRoleBindings.tenantId, tenantId),
      eq(principals.status, "active"),
      eq(principalRoleBindings.status, "active"),
      eq(principalRoleBindings.resolution, "resolved"),
      sql`(${principalRoleBindings.expiresAt} is null or ${principalRoleBindings.expiresAt} > now())`,
    ))
    .groupBy(principalRoleBindings.roleId, principals.kind);
  const userCounts = new Map<string, number>();
  const agentCounts = new Map<string, number>();
  for (const row of legacyRows) userCounts.set(row.roleId, row.c);
  for (const row of principalRows) {
    const counts = row.kind === "agent" ? agentCounts : userCounts;
    counts.set(row.roleId, (counts.get(row.roleId) ?? 0) + row.c);
  }
  return { users: userCounts, agents: agentCounts };
}

export async function ensureSystemRoles(tenantId: string): Promise<void> {
  if (resolveDatabaseConfig().dialect === "mysql") {
    return mysqlRolesRepo.ensureSystemRoles(tenantId);
  }
  const db = getIamDb();
  await db.transaction(async (tx) => {
    const now = new Date();
    await tx
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .for("update");
    for (const seed of SYSTEM_ROLE_SEED) {
      const existingRows = await tx
        .select()
        .from(roles)
        .where(and(eq(roles.tenantId, tenantId), eq(roles.code, seed.code)))
        .for("update")
        .limit(1);
      const existing = existingRows[0];
      if (!existing) {
        const id = ulid();
        await tx.insert(roles).values({
          id,
          tenantId,
          code: seed.code,
          name: seed.name,
          scopes: seed.scopes,
          immutable: true,
          createdAt: now,
          updatedAt: now,
        });
        await insertAuditEvent({
          tenantId,
          actorUserId: null,
          eventType: "iam.role.system_seed.create",
          targetKind: "role",
          targetId: id,
          detail: { code: seed.code, scopes: seed.scopes, source: "system_seed" },
        }, tx);
        continue;
      }
      const scopeChanged = roleScopeFingerprint((existing.scopes as string[]) ?? []) !== roleScopeFingerprint(seed.scopes);
      const metadataChanged = existing.name !== seed.name || !existing.immutable;
      if (!scopeChanged && !metadataChanged) continue;
      await tx
        .update(roles)
        .set({
          name: seed.name,
          scopes: seed.scopes,
          immutable: true,
          updatedAt: now,
        })
        .where(and(eq(roles.tenantId, tenantId), eq(roles.id, existing.id)));
      if (scopeChanged) {
        const affectedBindings = await tx
          .select({ principalId: principalRoleBindings.principalId })
          .from(principalRoleBindings)
          .where(and(eq(principalRoleBindings.tenantId, tenantId), eq(principalRoleBindings.roleId, existing.id)))
          .orderBy(asc(principalRoleBindings.principalId))
          .for("update");
        const affectedPrincipalIds = [...new Set(affectedBindings.map((binding) => binding.principalId))];
        if (affectedPrincipalIds.length) {
          await tx
            .update(principals)
            .set({ authzVersion: sql`${principals.authzVersion} + 1`, updatedAt: now })
            .where(and(eq(principals.tenantId, tenantId), inArray(principals.id, affectedPrincipalIds)));
        }
      }
      await insertAuditEvent({
        tenantId,
        actorUserId: null,
        eventType: "iam.role.system_seed.reconcile",
        targetKind: "role",
        targetId: existing.id,
        detail: { code: seed.code, scopes: seed.scopes, scopeChanged, source: "system_seed" },
      }, tx);
    }
  });
}

export async function listRoles(tenantId: string): Promise<RoleRow[]> {
  if (resolveDatabaseConfig().dialect === "mysql") {
    return mysqlRolesRepo.listRoles(tenantId);
  }
  const db = getIamDb();
  const rows = await db.select().from(roles).where(eq(roles.tenantId, tenantId)).orderBy(roles.code);
  const mc = await memberCounts(tenantId);
  return rows.map((r) => mapRole(r, mc.users.get(r.id) ?? 0, mc.agents.get(r.id) ?? 0));
}

export async function getRoleById(tenantId: string, id: string): Promise<RoleRow | null> {
  if (resolveDatabaseConfig().dialect === "mysql") {
    return mysqlRolesRepo.getRoleById(tenantId, id);
  }
  const db = getIamDb();
  const row = await db
    .select()
    .from(roles)
    .where(and(eq(roles.tenantId, tenantId), eq(roles.id, id)))
    .limit(1);
  if (!row[0]) return null;
  const mc = await memberCounts(tenantId);
  return mapRole(row[0], mc.users.get(row[0].id) ?? 0, mc.agents.get(row[0].id) ?? 0);
}

export async function getRoleByCode(tenantId: string, code: string): Promise<RoleRow | null> {
  if (resolveDatabaseConfig().dialect === "mysql") {
    return mysqlRolesRepo.getRoleByCode(tenantId, code);
  }
  const db = getIamDb();
  const row = await db
    .select()
    .from(roles)
    .where(and(eq(roles.tenantId, tenantId), eq(roles.code, code)))
    .limit(1);
  if (!row[0]) return null;
  return mapRole(row[0], 0);
}

type LockedRoleActor = {
  id: string;
  kind: string;
  userId: string | null;
  status: string;
  authzVersion: number;
};

function storedRoleScopes(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function assertRoleMutationSnapshot(
  role: { id: string; scopes: unknown },
  snapshot: GrantabilitySnapshot | undefined,
): void {
  if (!snapshot) return;
  const resolvedScopes = expandRoleScopes(storedRoleScopes(role.scopes));
  if (!roleMutationSnapshotMatches(snapshot, role.id, resolvedScopes)) {
    throw new Error("authorization context is stale");
  }
}

async function lockRoleMutationActor(
  tx: PgDb,
  input: { tenantId: string; actorUserId?: string | null },
  snapshot: GrantabilitySnapshot | undefined,
): Promise<string | null> {
  if (!input.actorUserId) return null;
  const actorRows = await tx
    .select({
      id: principals.id,
      kind: principals.kind,
      userId: principals.userId,
      status: principals.status,
      authzVersion: principals.authzVersion,
    })
    .from(principals)
    .where(and(
      eq(principals.tenantId, input.tenantId),
      eq(principals.kind, "user"),
      eq(principals.userId, input.actorUserId),
    ))
    .for("update")
    .limit(1);
  const actor = actorRows[0] as LockedRoleActor | undefined;
  if (!actor || actor.kind !== "user" || actor.userId !== input.actorUserId || actor.status !== "active") {
    throw new Error("actor principal is disabled or missing");
  }
  if (snapshot) {
    if (actor.id !== snapshot.actorPrincipalId || actor.authzVersion !== snapshot.actorAuthzVersion) {
      throw new Error("authorization context is stale");
    }
    if (snapshot.actorPermissionExpiresAt) {
      const expiry = new Date(snapshot.actorPermissionExpiresAt).getTime();
      if (!Number.isFinite(expiry) || expiry <= Date.now()) throw new Error("authorization context is stale");
    }
  }
  const userRows = await tx
    .select({ id: users.id, status: users.status, isDeleted: users.isDeleted, deletedAt: users.deletedAt })
    .from(users)
    .where(and(eq(users.tenantId, input.tenantId), eq(users.id, input.actorUserId)))
    .for("update")
    .limit(1);
  const user = userRows[0];
  if (!user || user.status !== "active" || user.isDeleted || user.deletedAt !== null) {
    throw new Error("actor principal is disabled or missing");
  }
  return actor.id;
}

export async function createCustomRole(input: {
  tenantId: string;
  code: string;
  name: string;
  scopes: string[];
  actorUserId?: string | null;
}): Promise<RoleRow> {
  if (resolveDatabaseConfig().dialect === "mysql") {
    return mysqlRolesRepo.createCustomRole(input);
  }
  const db = getIamDb();
  const code = input.code.trim().toLowerCase().replace(/\s+/g, "_");
  if (!code) throw new Error("角色代码不能为空");
  if (SYSTEM_ROLE_SEED.some((seed) => seed.code === code)) throw new Error("系统角色代码受保护");
  const snapshot = input.actorUserId
    ? await assertGrantable({
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      requiredScopes: ["role:create"],
      candidateScopes: input.scopes,
      dataScope: "tenant",
    })
    : undefined;

  const id = ulid();
  const now = new Date();
  let actorPrincipalId: string | null = null;
  await db.transaction(async (tx) => {
    // Serialize role and binding mutations for this tenant before taking
    // principal/role locks.  This gives both adapters one lock order and
    // prevents a role update from racing a concurrent assignment.
    await tx
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.id, input.tenantId))
      .for("update");
    actorPrincipalId = await lockRoleMutationActor(tx, input, snapshot);
    const existed = await tx
      .select({ id: roles.id })
      .from(roles)
      .where(and(eq(roles.tenantId, input.tenantId), eq(roles.code, code)))
      .for("update")
      .limit(1);
    if (existed[0]) throw new Error("角色代码已存在");
    await tx.insert(roles).values({
      id,
      tenantId: input.tenantId,
      code,
      name: input.name.trim(),
      scopes: input.scopes,
      immutable: false,
      createdAt: now,
      updatedAt: now,
    });
    await insertAuditEvent({
      tenantId: input.tenantId,
      actorUserId: input.actorUserId ?? null,
      actorPrincipalId,
      eventType: "iam.role.create",
      targetKind: "role",
      targetId: id,
      detail: { code, scopes: input.scopes },
    }, tx);
  });

  return (await getRoleById(input.tenantId, id))!;
}

export async function updateRole(input: {
  tenantId: string;
  actorUserId?: string | null;
  id: string;
  name?: string;
  scopes?: string[];
}): Promise<RoleRow> {
  if (resolveDatabaseConfig().dialect === "mysql") {
    return mysqlRolesRepo.updateRole(input);
  }
  const db = getIamDb();
  const row = await db
    .select()
    .from(roles)
    .where(and(eq(roles.tenantId, input.tenantId), eq(roles.id, input.id)))
    .limit(1);
  if (!row[0]) throw new Error("角色不存在");
  const snapshot = input.actorUserId
    ? await assertGrantable({
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      roleSnapshotId: input.id,
      requiredScopes: ["role:update"],
      candidateScopes: input.scopes,
      dataScope: "tenant",
    })
    : undefined;

  const now = new Date();
  let actorPrincipalId: string | null = null;
  await db.transaction(async (tx) => {
    await tx
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.id, input.tenantId))
      .for("update");
    actorPrincipalId = await lockRoleMutationActor(tx, input, snapshot);
    const lockedRows = await tx
      .select()
      .from(roles)
      .where(and(eq(roles.tenantId, input.tenantId), eq(roles.id, input.id)))
      .for("update")
      .limit(1);
    const lockedRole = lockedRows[0];
    if (!lockedRole) throw new Error("角色不存在");
    if (lockedRole.immutable) throw new Error("系统内置角色不可编辑");
    assertRoleMutationSnapshot(lockedRole, snapshot);
    await tx
      .update(roles)
      .set({
        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
        ...(input.scopes !== undefined ? { scopes: input.scopes } : {}),
        updatedAt: now,
      })
      .where(and(eq(roles.tenantId, input.tenantId), eq(roles.id, input.id)));
    const affectedBindings = await tx
      .select({ principalId: principalRoleBindings.principalId })
      .from(principalRoleBindings)
          .where(and(eq(principalRoleBindings.tenantId, input.tenantId), eq(principalRoleBindings.roleId, input.id)))
          .orderBy(asc(principalRoleBindings.principalId))
          .for("update")
          .limit(100000);
    const affectedPrincipalIds = [...new Set(affectedBindings.map((binding) => binding.principalId))];
    if (affectedPrincipalIds.length) {
      await tx
        .update(principals)
        .set({ authzVersion: sql`${principals.authzVersion} + 1`, updatedAt: now })
        .where(and(eq(principals.tenantId, input.tenantId), inArray(principals.id, affectedPrincipalIds)));
    }
    await insertAuditEvent({
      tenantId: input.tenantId,
      actorUserId: input.actorUserId ?? null,
      actorPrincipalId,
      eventType: "iam.role.update",
      targetKind: "role",
      targetId: input.id,
      detail: { name: input.name, scopes: input.scopes },
    }, tx);
  });

  return (await getRoleById(input.tenantId, input.id))!;
}

export async function deleteRole(input: {
  tenantId: string;
  id: string;
  actorUserId?: string | null;
}): Promise<void> {
  if (resolveDatabaseConfig().dialect === "mysql") {
    return mysqlRolesRepo.deleteRole(input);
  }
  const db = getIamDb();
  const row = await db
    .select()
    .from(roles)
    .where(and(eq(roles.tenantId, input.tenantId), eq(roles.id, input.id)))
    .limit(1);
  if (!row[0]) throw new Error("角色不存在");
  const snapshot = input.actorUserId
    ? await assertGrantable({
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      roleSnapshotId: input.id,
      requiredScopes: ["role:delete"],
      dataScope: "tenant",
    })
    : undefined;
  let actorPrincipalId: string | null = null;
  await db.transaction(async (tx) => {
    await tx
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.id, input.tenantId))
      .for("update");
    actorPrincipalId = await lockRoleMutationActor(tx, input, snapshot);
    const lockedRows = await tx
      .select()
      .from(roles)
      .where(and(eq(roles.tenantId, input.tenantId), eq(roles.id, input.id)))
      .for("update")
      .limit(1);
    const lockedRole = lockedRows[0];
    if (!lockedRole) throw new Error("角色不存在");
    if (lockedRole.immutable) throw new Error("系统内置角色不可删除");
    assertRoleMutationSnapshot(lockedRole, snapshot);
    const used = await tx
      .select({ u: userRoles.userId })
      .from(userRoles)
      .where(and(eq(userRoles.tenantId, input.tenantId), eq(userRoles.roleId, input.id)))
      .limit(1);
    if (used[0]) throw new Error("role_in_use");
    const explicitUsed = await tx
      .select({ id: principalRoleBindings.id })
      .from(principalRoleBindings)
      .where(and(eq(principalRoleBindings.tenantId, input.tenantId), eq(principalRoleBindings.roleId, input.id)))
      .limit(1);
    if (explicitUsed[0]) throw new Error("role_in_use");
    await tx.delete(roles).where(and(eq(roles.tenantId, input.tenantId), eq(roles.id, input.id)));
    await insertAuditEvent({
      tenantId: input.tenantId,
      actorUserId: input.actorUserId ?? null,
      actorPrincipalId,
      eventType: "iam.role.delete",
      targetKind: "role",
      targetId: input.id,
      detail: { code: lockedRole.code },
    }, tx);
  });
}

export async function duplicateRole(input: {
  tenantId: string;
  sourceId: string;
  newCode: string;
  newName: string;
  actorUserId?: string | null;
}): Promise<RoleRow> {
  if (resolveDatabaseConfig().dialect === "mysql") {
    return mysqlRolesRepo.duplicateRole(input);
  }
  const db = getIamDb();
  const sourceRows = await db
    .select()
    .from(roles)
    .where(and(eq(roles.tenantId, input.tenantId), eq(roles.id, input.sourceId)))
    .limit(1);
  if (!sourceRows[0]) throw new Error("源角色不存在");
  const sourceScopes = storedRoleScopes(sourceRows[0].scopes);
  const snapshot = input.actorUserId
    ? await assertGrantable({
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      roleSnapshotId: input.sourceId,
      requiredScopes: ["role:create"],
      candidateScopes: sourceScopes,
      dataScope: "tenant",
    })
    : undefined;
  const code = input.newCode.trim().toLowerCase().replace(/\s+/g, "_");
  if (!code) throw new Error("角色代码不能为空");
  if (SYSTEM_ROLE_SEED.some((seed) => seed.code === code)) throw new Error("系统角色代码受保护");
  const id = ulid();
  const now = new Date();
  let actorPrincipalId: string | null = null;
  await db.transaction(async (tx) => {
    await tx
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.id, input.tenantId))
      .for("update");
    actorPrincipalId = await lockRoleMutationActor(tx, input, snapshot);
    const lockedRows = await tx
      .select()
      .from(roles)
      .where(and(eq(roles.tenantId, input.tenantId), eq(roles.id, input.sourceId)))
      .for("update")
      .limit(1);
    const source = lockedRows[0];
    if (!source) throw new Error("源角色不存在");
    assertRoleMutationSnapshot(source, snapshot);
    const existed = await tx
      .select({ id: roles.id })
      .from(roles)
      .where(and(eq(roles.tenantId, input.tenantId), eq(roles.code, code)))
      .for("update")
      .limit(1);
    if (existed[0]) throw new Error("角色代码已存在");
    const scopes = storedRoleScopes(source.scopes);
    await tx.insert(roles).values({
      id,
      tenantId: input.tenantId,
      code,
      name: input.newName.trim(),
      scopes,
      immutable: false,
      createdAt: now,
      updatedAt: now,
    });
    await insertAuditEvent({
      tenantId: input.tenantId,
      actorUserId: input.actorUserId ?? null,
      actorPrincipalId,
      eventType: "iam.role.create",
      targetKind: "role",
      targetId: id,
      detail: { code, scopes, duplicatedFromRoleId: input.sourceId },
    }, tx);
  });
  return (await getRoleById(input.tenantId, id))!;
}

export async function resolveRoleIdsFromCodes(
  tenantId: string,
  codes: string[],
  dbOrTx?: unknown
): Promise<Map<string, string>> {
  if (resolveDatabaseConfig().dialect === "mysql") {
    return mysqlRolesRepo.resolveRoleIdsFromCodes(tenantId, codes);
  }
  const db = (dbOrTx as IamDb | undefined) ?? getIamDb();
  const clean = [...new Set(codes.map((c) => c.trim()).filter(Boolean))];
  if (!clean.length) return new Map();
  const rows = await db
    .select({ id: roles.id, code: roles.code })
    .from(roles)
    .where(and(eq(roles.tenantId, tenantId), inArray(roles.code, clean)));
  const m = new Map<string, string>();
  for (const r of rows) m.set(r.code, r.id);
  return m;
}

export async function listUsersForRole(tenantId: string, roleId: string): Promise<
  Array<{ userId: string; email: string; displayName: string }>
> {
  if (resolveDatabaseConfig().dialect === "mysql") {
    return mysqlRolesRepo.listUsersForRole(tenantId, roleId);
  }
  const db = getIamDb();
  const principalRows = await db
    .select({ userId: principals.userId })
    .from(principals)
    .where(and(eq(principals.tenantId, tenantId), eq(principals.kind, "user")));
  const authoritativeUserIds = new Set(
    principalRows.map((row) => row.userId).filter((userId): userId is string => Boolean(userId)),
  );
  const legacyRows = await db
    .select({
      userId: users.id,
      email: users.email,
      displayName: users.displayName,
    })
    .from(userRoles)
    .innerJoin(users, and(eq(users.id, userRoles.userId), eq(users.tenantId, userRoles.tenantId)))
    .where(
      and(
        eq(userRoles.tenantId, tenantId),
        eq(userRoles.roleId, roleId),
        eq(users.isDeleted, false),
        isNull(users.deletedAt)
      )
    )
    .orderBy(users.email);
  const explicitRows = await db
    .select({ userId: users.id, email: users.email, displayName: users.displayName })
    .from(principalRoleBindings)
    .innerJoin(
      principals,
      and(eq(principals.id, principalRoleBindings.principalId), eq(principals.tenantId, principalRoleBindings.tenantId)),
    )
    .innerJoin(users, and(eq(users.id, principals.userId), eq(users.tenantId, principals.tenantId)))
    .where(and(
      eq(principalRoleBindings.tenantId, tenantId),
      eq(principalRoleBindings.roleId, roleId),
      eq(principals.kind, "user"),
      eq(principals.status, "active"),
      eq(principalRoleBindings.status, "active"),
      eq(principalRoleBindings.resolution, "resolved"),
      eq(users.isDeleted, false),
      isNull(users.deletedAt),
      sql`(${principalRoleBindings.expiresAt} is null or ${principalRoleBindings.expiresAt} > now())`,
    ))
    .orderBy(users.email);
  const byId = new Map<string, { userId: string; email: string; displayName: string }>();
  for (const row of legacyRows) {
    if (!authoritativeUserIds.has(row.userId)) byId.set(row.userId, row);
  }
  for (const row of explicitRows) byId.set(row.userId, row);
  return [...byId.values()].sort((a, b) => a.email.localeCompare(b.email));
}

export async function aggregateScopesForUser(tenantId: string, userId: string): Promise<string[]> {
  const { scopes } = await getUserRolesDetail(tenantId, userId);
  return scopes;
}

/** 单次查询返回用户角色 code 列表与合并后的 scopes（用于 Admin DTO）。 */
export async function getUserRolesDetail(
  tenantId: string,
  userId: string
): Promise<{ scopes: string[]; roleCodes: string[] }> {
  if (resolveDatabaseConfig().dialect === "mysql") {
    return getMysqlUserRolesDetail(tenantId, userId);
  }
  const principal = await getPrincipalRepository().getPrincipalForUser(tenantId, userId);
  if (principal) {
    const bindings = await getPrincipalRepository().getPrincipalEffectivePermissions({
      tenantId,
      principalId: principal.id,
    });
    return {
      roleCodes: [...new Set(bindings.map((binding) => binding.roleCode))],
      scopes: mergeUserScopes(bindings.map((binding) => binding.scopes)),
    };
  }
  const db = getIamDb();
  const roleRows = await db
    .select({ scopes: roles.scopes, code: roles.code })
    .from(userRoles)
    .innerJoin(roles, and(eq(roles.id, userRoles.roleId), eq(roles.tenantId, userRoles.tenantId)))
    .where(and(eq(userRoles.tenantId, tenantId), eq(userRoles.userId, userId)));
  const roleCodes = roleRows.map((r) => r.code);
  const scopes = mergeUserScopes(roleRows.map((r) => (r.scopes as string[]) ?? []));
  return { scopes, roleCodes };
}

export function superAdminScopesFallback(): string[] {
  return [...ALL_REGISTERED_SCOPES];
}

const roleRepositoryMethods = {
  ensureSystemRoles,
  listRoles,
  getRoleById,
  getRoleByCode,
  createCustomRole,
  updateRole,
  deleteRole,
  duplicateRole,
  resolveRoleIdsFromCodes,
  listUsersForRole,
  getUserRolesDetail,
};

const postgresqlRolesRepository: RolesRepository = {
  dialect: "postgresql",
  ...roleRepositoryMethods,
};

export function getRolesRepository(): RolesRepository {
  return resolveDatabaseConfig().dialect === "mysql"
    ? mysqlRolesRepo
    : postgresqlRolesRepository;
}
