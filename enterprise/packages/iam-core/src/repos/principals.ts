import {
  agentProfiles,
  departments,
  organizations,
  principals,
  principalRoleBindings,
  roles,
  tenants,
  userRoles,
  users,
} from "@agenticx/db-schema";
import { and, asc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { ulid } from "ulid";

import { expandRoleScopes } from "../scope-registry";
import { roleScopeFingerprint } from "../authorization/types";
import type {
  AgentMode,
  AssignPrincipalRoleBindingInput,
  BindingResolution,
  CreateAgentPrincipalInput,
  DataScope,
  EffectivePermissionsInput,
  LegacyUserRoleBinding,
  PrincipalDto,
  PrincipalMutationSnapshot,
  PrincipalRoleBindingDto,
  PrincipalStatus,
  RemovePrincipalRoleBindingInput,
  UpdateAgentPrincipalInput,
} from "../authorization/types";
import { insertAuditEvent } from "./audit";
import type {
  PrincipalListFilter,
  PrincipalsRepository,
  ResolvedAuthorizationTarget,
  RoleDefinition,
} from "./principal-contracts";
import { getIamDb, type IamDb } from "../db";

type PgDb = IamDb;

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

function activeUserPredicate() {
  return and(eq(users.isDeleted, false), isNull(users.deletedAt));
}

function enabledUserPredicate() {
  return and(
    activeUserPredicate(),
    eq(users.status, "active"),
    or(isNull(users.lockedUntil), sql`${users.lockedUntil} <= now()`),
  );
}

/**
 * Only the compatibility rows created by the old personal-assistant
 * bootstrap may be removed while ensuring an existing assistant.  A current
 * administrator grant is also an `explicit` binding, but it carries the
 * granting user and therefore must remain a durable ceiling.
 */
function legacyPersonalAssistantBindingPredicate() {
  return or(
    eq(principalRoleBindings.source, "legacy"),
    and(eq(principalRoleBindings.source, "explicit"), isNull(principalRoleBindings.createdByUserId)),
  );
}

type LockedMutationPrincipal = {
  id: string;
  kind: "user" | "agent";
  userId: string | null;
  status: PrincipalStatus;
  authzVersion: number;
};

type LockedMutationUser = {
  id: string;
  status: string;
  isDeleted: boolean;
  deletedAt: Date | null;
  lockedUntil: Date | null;
};

function assertEnabledMutationUser(user: LockedMutationUser | undefined, errorMessage: string): void {
  if (!user || user.status !== "active" || user.isDeleted || user.deletedAt !== null ||
    (user.lockedUntil !== null && user.lockedUntil.getTime() > Date.now())) {
    throw new Error(errorMessage);
  }
}

async function lockMutationUsers(
  tx: PgDb,
  tenantId: string,
  userIds: Array<string | null | undefined>,
): Promise<Map<string, LockedMutationUser>> {
  const ids = [...new Set(userIds.filter((id): id is string => Boolean(id)))].sort();
  if (!ids.length) return new Map();
  const rows = await tx
    .select({
      id: users.id,
      status: users.status,
      isDeleted: users.isDeleted,
      deletedAt: users.deletedAt,
      lockedUntil: users.lockedUntil,
    })
    .from(users)
    .where(and(eq(users.tenantId, tenantId), inArray(users.id, ids)))
    .orderBy(asc(users.id))
    .for("update");
  return new Map(rows.map((row) => [row.id, row]));
}

async function lockPrincipalMutationRows(
  tx: PgDb,
  tenantId: string,
  actorUserId: string | null | undefined,
  targetPrincipalId: string | null | undefined,
  snapshot: PrincipalMutationSnapshot | undefined,
): Promise<{ actor: LockedMutationPrincipal | undefined; target: LockedMutationPrincipal | undefined }> {
  if (actorUserId && !snapshot) throw new Error("authorization context is required");
  if (!actorUserId && snapshot) throw new Error("authorization context is stale");
  const principalIds = [...new Set([
    snapshot?.actorPrincipalId,
    targetPrincipalId,
  ].filter((id): id is string => Boolean(id)))].sort();
  const rows = principalIds.length
    ? await tx
      .select({
        id: principals.id,
        kind: principals.kind,
        userId: principals.userId,
        status: principals.status,
        authzVersion: principals.authzVersion,
      })
      .from(principals)
      .where(and(eq(principals.tenantId, tenantId), inArray(principals.id, principalIds)))
      .orderBy(asc(principals.id))
      .for("update")
    : [];
  const byId = new Map(rows.map((row) => [row.id, row as LockedMutationPrincipal]));
  const actor = snapshot?.actorPrincipalId ? byId.get(snapshot.actorPrincipalId) : undefined;
  if (actorUserId) {
    if (!actor || actor.kind !== "user" || actor.userId !== actorUserId || actor.status !== "active" ||
      actor.authzVersion !== snapshot!.actorAuthzVersion || freshnessExpired(snapshot!.actorPermissionExpiresAt)) {
      throw new Error("authorization context is stale");
    }
  }
  if (targetPrincipalId && !byId.has(targetPrincipalId)) throw new Error("agent principal not found");
  const target = targetPrincipalId ? byId.get(targetPrincipalId) : undefined;
  if (snapshot && snapshot.targetPrincipalId !== undefined) {
    if ((snapshot.targetPrincipalId ?? null) !== (targetPrincipalId ?? null) ||
      (snapshot.targetPrincipalId && (!target || target.authzVersion !== snapshot.targetAuthzVersion ||
        (snapshot.targetStatus !== undefined && snapshot.targetStatus !== null && target.status !== snapshot.targetStatus)))) {
      throw new Error("authorization context is stale");
    }
  }
  return { actor, target };
}

function mapProfile(row: typeof agentProfiles.$inferSelect): import("../authorization/types").AgentProfileDto {
  return {
    principalId: row.principalId,
    tenantId: row.tenantId,
    mode: row.mode as AgentMode,
    ownerUserId: row.ownerUserId ?? null,
    definitionRef: row.definitionRef ?? null,
    definitionVersion: row.definitionVersion,
  };
}

function mapPrincipal(
  row: typeof principals.$inferSelect,
  profile?: typeof agentProfiles.$inferSelect | null,
): PrincipalDto {
  return {
    id: row.id,
    tenantId: row.tenantId,
    kind: row.kind as "user" | "agent",
    userId: row.userId ?? null,
    displayName: row.displayName ?? null,
    status: row.status as PrincipalStatus,
    authzVersion: row.authzVersion,
    agentProfile: profile ? mapProfile(profile) : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapBinding(
  row: typeof principalRoleBindings.$inferSelect,
  role: { code: string; scopes: unknown },
): PrincipalRoleBindingDto {
  return {
    id: row.id,
    tenantId: row.tenantId,
    principalId: row.principalId,
    roleId: row.roleId,
    roleCode: role.code,
    scopes: expandRoleScopes(Array.isArray(role.scopes) ? role.scopes.filter((v): v is string => typeof v === "string") : []),
    dataScope: row.dataScope as DataScope,
    scopeOrgId: row.scopeOrgId ?? null,
    scopeDeptId: row.scopeDeptId ?? null,
    expiresAt: iso(row.expiresAt),
    status: row.status as "active" | "revoked",
    resolution: row.resolution as BindingResolution,
    resolutionReason: row.resolutionReason ?? null,
    source: (row.source ?? "legacy") as "legacy" | "explicit",
    createdByUserId: row.createdByUserId ?? null,
    grantedByPrincipalId: row.grantedByPrincipalId ?? null,
    canDelegate: Boolean(row.canDelegate),
    grantorApprovalRef: row.grantorApprovalRef ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function normalizedRoleCodes(roleCodes: string[]): string[] {
  return [...new Set(roleCodes.map((code) => code.trim().toLowerCase()).filter(Boolean))];
}

function parseExpiry(value: Date | string | null | undefined): Date | null {
  if (value === undefined || value === null) return null;
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("expiresAt must be a valid date");
  if (date.getTime() <= Date.now()) throw new Error("expiresAt must be in the future");
  return date;
}

function freshnessExpired(value: string | null | undefined): boolean {
  if (!value) return false;
  const timestamp = new Date(value).getTime();
  return !Number.isFinite(timestamp) || timestamp <= Date.now();
}

function legacyScope(
  roleCode: string,
  scopeDeptId: string | null,
  departmentExists: boolean,
): {
  dataScope: DataScope;
  scopeDeptId: string | null;
  resolution: BindingResolution;
  resolutionReason: string | null;
} {
  if (["super_admin", "owner", "admin", "auditor"].includes(roleCode)) {
    // Historical default department fields on tenant-wide system roles are
    // metadata, not an authorization restriction.
    return { dataScope: "tenant", scopeDeptId: null, resolution: "resolved", resolutionReason: null };
  }
  if (roleCode === "dept_admin" && scopeDeptId && departmentExists) {
    return { dataScope: "department", scopeDeptId, resolution: "resolved", resolutionReason: null };
  }
  if (roleCode === "member") {
    return { dataScope: "self", scopeDeptId: null, resolution: "resolved", resolutionReason: null };
  }
  if (scopeDeptId && departmentExists) {
    return {
      dataScope: "department",
      scopeDeptId,
      resolution: "unresolved",
      resolutionReason: "legacy custom role scope requires explicit confirmation",
    };
  }
  return {
    dataScope: "self",
    scopeDeptId: null,
    resolution: "unresolved",
    resolutionReason: "legacy custom role scope is ambiguous; explicit data scope required",
  };
}

async function getPrincipalInternal(tenantId: string, principalId: string, db: PgDb = getIamDb()): Promise<PrincipalDto | null> {
  const rows = await db
    .select({ principal: principals, profile: agentProfiles })
    .from(principals)
    .leftJoin(
      agentProfiles,
      and(eq(agentProfiles.principalId, principals.id), eq(agentProfiles.tenantId, principals.tenantId)),
    )
    .where(and(eq(principals.tenantId, tenantId), eq(principals.id, principalId)))
    .limit(1);
  const row = rows[0];
  return row ? mapPrincipal(row.principal, row.profile) : null;
}

async function getPrincipalForUserInternal(tenantId: string, userId: string, db: PgDb = getIamDb()): Promise<PrincipalDto | null> {
  const rows = await db
    .select({ principal: principals, profile: agentProfiles })
    .from(principals)
    .leftJoin(
      agentProfiles,
      and(eq(agentProfiles.principalId, principals.id), eq(agentProfiles.tenantId, principals.tenantId)),
    )
    .where(and(eq(principals.tenantId, tenantId), eq(principals.userId, userId), eq(principals.kind, "user")))
    .limit(1);
  const row = rows[0];
  return row ? mapPrincipal(row.principal, row.profile) : null;
}

async function ensureUserPrincipalInternal(tenantId: string, userId: string, db: PgDb = getIamDb()): Promise<PrincipalDto | null> {
  const userRows = await db
    .select({ id: users.id, displayName: users.displayName, status: users.status, isDeleted: users.isDeleted, deletedAt: users.deletedAt })
    .from(users)
    .where(and(eq(users.tenantId, tenantId), eq(users.id, userId), activeUserPredicate()))
    .limit(1);
  const user = userRows[0];
  if (!user) return null;
  const now = new Date();
  await db
    .insert(principals)
    .values({
      id: ulid(),
      tenantId,
      kind: "user",
      userId,
      displayName: user.displayName,
      status: user.status === "disabled" ? "disabled" : "active",
      authzVersion: 1,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [principals.tenantId, principals.userId],
      set: {
        displayName: user.displayName,
        // User principal status mirrors the authoritative user account. Agent
        // identities are never touched by this compatibility upsert.
        status: user.status === "disabled" ? "disabled" : "active",
        updatedAt: now,
      },
    });
  return getPrincipalForUserInternal(tenantId, userId, db);
}

async function getUserStatusInternal(tenantId: string, userId: string): Promise<"active" | "disabled" | "locked" | "missing"> {
  const db = getIamDb();
  const rows = await db
    .select({ status: users.status, lockedUntil: users.lockedUntil, isDeleted: users.isDeleted, deletedAt: users.deletedAt })
    .from(users)
    .where(and(eq(users.tenantId, tenantId), eq(users.id, userId)))
    .limit(1);
  const row = rows[0];
  if (!row || row.isDeleted || row.deletedAt !== null) return "missing";
  if (row.status === "disabled") return "disabled";
  if (row.status === "locked" || (row.lockedUntil && row.lockedUntil.getTime() > Date.now())) return "locked";
  return "active";
}

async function listPrincipalsInternal(tenantId: string, filter: PrincipalListFilter = {}): Promise<PrincipalDto[]> {
  const db = getIamDb();
  const predicates: SQL[] = [eq(principals.tenantId, tenantId)];
  // A soft-deleted user principal remains for audit/history, but it must not
  // appear in the live principal directory. Agent rows have no backing user
  // and remain listable (the owner may be absent or soft-deleted).
  predicates.push(or(eq(principals.kind, "agent"), and(eq(principals.kind, "user"), activeUserPredicate()))!);
  if (filter.kind) predicates.push(eq(principals.kind, filter.kind));
  if (filter.principalIds) {
    predicates.push(filter.principalIds.length ? inArray(principals.id, filter.principalIds) : sql`false`);
  }
  if (filter.userIds || filter.userDepartmentIds) {
    const userVisibility: SQL[] = [];
    if (filter.userIds) {
      userVisibility.push(filter.userIds.length ? inArray(principals.userId, filter.userIds) : sql`false`);
    }
    if (filter.userDepartmentIds) {
      userVisibility.push(filter.userDepartmentIds.length ? inArray(users.deptId, filter.userDepartmentIds) : sql`false`);
    }
    predicates.push(userVisibility.length > 1 ? sql`(${userVisibility[0]} or ${userVisibility[1]})` : userVisibility[0]!);
  }
  if (filter.agentOwnerUserIds || filter.agentOwnerDepartmentIds) {
    const ownerPredicates: SQL[] = [];
    if (filter.agentOwnerUserIds) {
      ownerPredicates.push(
        filter.agentOwnerUserIds.length
          ? inArray(agentProfiles.ownerUserId, filter.agentOwnerUserIds)
          : sql`false`,
      );
    }
    if (filter.agentOwnerDepartmentIds) {
      ownerPredicates.push(
        filter.agentOwnerDepartmentIds.length
          ? inArray(users.deptId, filter.agentOwnerDepartmentIds)
          : sql`false`,
      );
    }
    predicates.push(ownerPredicates.length ? sql`(${ownerPredicates[0]}${ownerPredicates[1] ? sql` or ${ownerPredicates[1]}` : sql``})` : sql`false`);
  }
  const rows = await db
    .select({ principal: principals, profile: agentProfiles })
    .from(principals)
    .leftJoin(
      agentProfiles,
      and(eq(agentProfiles.principalId, principals.id), eq(agentProfiles.tenantId, principals.tenantId)),
    )
    .leftJoin(
      users,
      and(
        eq(users.tenantId, principals.tenantId),
        or(eq(users.id, principals.userId), eq(users.id, agentProfiles.ownerUserId)),
      ),
    )
    .where(and(...predicates))
    .orderBy(asc(principals.kind), asc(principals.displayName), asc(principals.id));
  return rows.map((row) => mapPrincipal(row.principal, row.profile));
}

async function createAgentPrincipalInternal(input: CreateAgentPrincipalInput): Promise<PrincipalDto> {
  const displayName = input.displayName.trim();
  if (!displayName) throw new Error("agent displayName is required");
  if (input.mode !== "delegated" && input.mode !== "service") throw new Error("invalid agent mode");
  const ownerUserId = input.ownerUserId || null;
  if (input.mode === "delegated" && !ownerUserId) throw new Error("delegated agent requires ownerUserId");
  const definitionVersion = input.definitionVersion ?? 1;
  if (!Number.isInteger(definitionVersion) || definitionVersion < 1) throw new Error("definitionVersion must be a positive integer");

  const db = getIamDb();
  const now = new Date();
  const id = ulid();
  const transactionResult = await db.transaction(async (tx) => {
    await tx
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.id, input.tenantId))
      .for("update");
    const { actor } = await lockPrincipalMutationRows(
      tx,
      input.tenantId,
      input.actorUserId,
      null,
      input.authorizationSnapshot,
    );
    const lockedUsers = await lockMutationUsers(tx, input.tenantId, [input.actorUserId, ownerUserId]);
    if (input.actorUserId) {
      assertEnabledMutationUser(lockedUsers.get(input.actorUserId), "authorization context is stale");
    }
    if (ownerUserId) {
      assertEnabledMutationUser(lockedUsers.get(ownerUserId), "agent owner not found or disabled");
    }
    const definitionRef = input.definitionRef?.trim() || null;
    const isPersonalAssistant = input.mode === "delegated" && definitionRef === "personal_assistant" && Boolean(ownerUserId);
    if (isPersonalAssistant) {
      const existingRows = await tx
        .select({ id: principals.id, status: principals.status })
        .from(principals)
        .innerJoin(
          agentProfiles,
          and(eq(agentProfiles.principalId, principals.id), eq(agentProfiles.tenantId, principals.tenantId)),
        )
        .where(and(
          eq(principals.tenantId, input.tenantId),
          eq(principals.kind, "agent"),
          eq(agentProfiles.mode, "delegated"),
          eq(agentProfiles.ownerUserId, ownerUserId!),
          eq(agentProfiles.definitionRef, definitionRef!),
        ))
        .orderBy(principals.id)
        .for("update");
      const disabledExisting = existingRows.find((row) => row.status !== "active");
      if (disabledExisting) throw new Error("personal assistant agent is disabled");
      if (existingRows[0]) {
        // Older versions provisioned a fixed personal_assistant role binding.
        // Personal assistants now inherit the owner's permissions unless an
        // explicit agent binding is present, so remove that legacy ceiling.
        const legacyBindings = await tx
          .select({ id: principalRoleBindings.id })
          .from(principalRoleBindings)
          .innerJoin(roles, and(
            eq(roles.id, principalRoleBindings.roleId),
            eq(roles.tenantId, principalRoleBindings.tenantId),
          ))
          .where(and(
            eq(principalRoleBindings.tenantId, input.tenantId),
            eq(principalRoleBindings.principalId, existingRows[0].id),
            eq(roles.code, "personal_assistant"),
            eq(principalRoleBindings.status, "active"),
            legacyPersonalAssistantBindingPredicate(),
          ));
        if (legacyBindings.length) {
          await tx
            .update(principalRoleBindings)
            .set({ status: "revoked", updatedAt: now })
            .where(and(
              eq(principalRoleBindings.tenantId, input.tenantId),
              eq(principalRoleBindings.principalId, existingRows[0].id),
              eq(principalRoleBindings.status, "active"),
              inArray(principalRoleBindings.id, legacyBindings.map((binding) => binding.id)),
            ));
          await tx
            .update(principals)
            .set({ authzVersion: sql`${principals.authzVersion} + 1`, updatedAt: now })
            .where(and(eq(principals.tenantId, input.tenantId), eq(principals.id, existingRows[0].id)));
        }
        return { id: existingRows[0].id, created: false };
      }
    }
    await tx.insert(principals).values({
      id,
      tenantId: input.tenantId,
      kind: "agent",
      userId: null,
      displayName,
      status: "active",
      authzVersion: 1,
      createdAt: now,
      updatedAt: now,
    });
    await tx.insert(agentProfiles).values({
      principalId: id,
      tenantId: input.tenantId,
      mode: input.mode,
      ownerUserId,
      definitionRef,
      definitionVersion,
      createdAt: now,
      updatedAt: now,
    });

    await insertAuditEvent({
      tenantId: input.tenantId,
      actorUserId: input.actorUserId ?? null,
      actorPrincipalId: actor?.id ?? null,
      eventType: "iam.principal.agent.create",
      targetKind: "agent",
      targetId: id,
      detail: { mode: input.mode, ownerUserId, definitionRef },
    }, tx);
    return { id, created: true };
  });
  const created = await getPrincipalInternal(input.tenantId, transactionResult.id);
  if (!created) throw new Error("agent create failed");
  return created;
}

async function updateAgentPrincipalInternal(input: UpdateAgentPrincipalInput): Promise<PrincipalDto> {
  const db = getIamDb();
  const nextDisplayName = input.displayName === undefined ? undefined : input.displayName.trim();
  if (nextDisplayName !== undefined && !nextDisplayName) throw new Error("agent displayName is required");
  if (input.definitionVersion !== undefined &&
    (!Number.isInteger(input.definitionVersion) || input.definitionVersion < 1)) {
    throw new Error("definitionVersion must be a positive integer");
  }
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.id, input.tenantId))
      .for("update");
    const { actor, target } = await lockPrincipalMutationRows(
      tx,
      input.tenantId,
      input.actorUserId,
      input.principalId,
      input.authorizationSnapshot,
    );
    if (!target || target.kind !== "agent") throw new Error("agent principal not found");
    const profileRows = await tx
      .select()
      .from(agentProfiles)
      .where(and(eq(agentProfiles.tenantId, input.tenantId), eq(agentProfiles.principalId, input.principalId)))
      .for("update");
    const currentProfile = profileRows[0];
    if (!currentProfile) throw new Error("agent profile is missing");
    const nextMode = input.mode ?? (currentProfile.mode as AgentMode);
    const nextOwner = input.ownerUserId !== undefined
      ? (input.ownerUserId || null)
      : (currentProfile.ownerUserId ?? null);
    if (nextMode === "delegated" && !nextOwner) throw new Error("delegated agent requires ownerUserId");
    const nextVersion = input.definitionVersion ?? currentProfile.definitionVersion;
    const nextDefinitionRef = input.definitionRef !== undefined
      ? input.definitionRef?.trim() || null
      : currentProfile.definitionRef;
    const lockedUsers = await lockMutationUsers(tx, input.tenantId, [input.actorUserId, nextOwner]);
    if (input.actorUserId) {
      assertEnabledMutationUser(lockedUsers.get(input.actorUserId), "authorization context is stale");
    }
    if (nextOwner) {
      assertEnabledMutationUser(lockedUsers.get(nextOwner), "agent owner not found or disabled");
    }
    await tx
      .update(principals)
      .set({
        ...(nextDisplayName !== undefined ? { displayName: nextDisplayName } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        authzVersion: sql`${principals.authzVersion} + 1`,
        updatedAt: now,
      })
      .where(and(eq(principals.tenantId, input.tenantId), eq(principals.id, input.principalId)));
    await tx
      .update(agentProfiles)
      .set({
        mode: nextMode,
        ownerUserId: nextOwner,
        definitionRef: nextDefinitionRef,
        definitionVersion: nextVersion,
        updatedAt: now,
      })
      .where(and(eq(agentProfiles.tenantId, input.tenantId), eq(agentProfiles.principalId, input.principalId)));

    // Remove the legacy fixed ceiling when an agent is edited. Explicit
    // bindings created by an administrator remain untouched.
    const templateRows = await tx
      .select({ id: roles.id })
      .from(roles)
      .where(and(eq(roles.tenantId, input.tenantId), eq(roles.code, "personal_assistant")))
      .limit(1);
    const template = templateRows[0];
    if (template) {
      await tx
        .update(principalRoleBindings)
        .set({ status: "revoked", updatedAt: now })
          .where(and(
            eq(principalRoleBindings.tenantId, input.tenantId),
            eq(principalRoleBindings.principalId, input.principalId),
            eq(principalRoleBindings.roleId, template.id),
            eq(principalRoleBindings.status, "active"),
            legacyPersonalAssistantBindingPredicate(),
          ));
    }
    await insertAuditEvent({
      tenantId: input.tenantId,
      actorUserId: input.actorUserId ?? null,
      actorPrincipalId: actor?.id ?? null,
      eventType: "iam.principal.agent.update",
      targetKind: "agent",
      targetId: input.principalId,
      detail: {
        displayName: nextDisplayName,
        mode: nextMode,
        ownerUserId: nextOwner,
        status: input.status,
        definitionRef: nextDefinitionRef,
        definitionVersion: nextVersion,
      },
    }, tx);
  });
  const updated = await getPrincipalInternal(input.tenantId, input.principalId);
  if (!updated) throw new Error("agent update failed");
  return updated;
}

async function listBindingsInternal(tenantId: string, principalId: string): Promise<PrincipalRoleBindingDto[]> {
  const db = getIamDb();
  const rows = await db
    .select({ binding: principalRoleBindings, code: roles.code, scopes: roles.scopes })
    .from(principalRoleBindings)
    .innerJoin(
      roles,
      and(eq(roles.id, principalRoleBindings.roleId), eq(roles.tenantId, principalRoleBindings.tenantId)),
    )
    .where(and(eq(principalRoleBindings.tenantId, tenantId), eq(principalRoleBindings.principalId, principalId)))
    .orderBy(asc(principalRoleBindings.createdAt), asc(principalRoleBindings.id));
  return rows.map((row) => mapBinding(row.binding, { code: row.code, scopes: row.scopes }));
}

async function listBindingsForRoleInternal(tenantId: string, roleId: string): Promise<PrincipalRoleBindingDto[]> {
  const db = getIamDb();
  const rows = await db
    .select({ binding: principalRoleBindings, code: roles.code, scopes: roles.scopes })
    .from(principalRoleBindings)
    .innerJoin(
      roles,
      and(eq(roles.id, principalRoleBindings.roleId), eq(roles.tenantId, principalRoleBindings.tenantId)),
    )
    .where(and(eq(principalRoleBindings.tenantId, tenantId), eq(principalRoleBindings.roleId, roleId)))
    .orderBy(asc(principalRoleBindings.createdAt), asc(principalRoleBindings.id));
  return rows.map((row) => mapBinding(row.binding, { code: row.code, scopes: row.scopes }));
}

async function getPrincipalRoleBindingInternal(
  tenantId: string,
  bindingId: string,
): Promise<PrincipalRoleBindingDto | null> {
  const db = getIamDb();
  const rows = await db
    .select({ binding: principalRoleBindings, code: roles.code, scopes: roles.scopes })
    .from(principalRoleBindings)
    .innerJoin(
      roles,
      and(eq(roles.id, principalRoleBindings.roleId), eq(roles.tenantId, principalRoleBindings.tenantId)),
    )
    .where(and(eq(principalRoleBindings.tenantId, tenantId), eq(principalRoleBindings.id, bindingId)))
    .limit(1);
  const row = rows[0];
  return row ? mapBinding(row.binding, { code: row.code, scopes: row.scopes }) : null;
}

async function getRoleDefinitionInternal(
  tenantId: string,
  input: { roleId?: string; roleCode?: string },
): Promise<RoleDefinition | null> {
  if ((input.roleId ? 1 : 0) + (input.roleCode ? 1 : 0) !== 1) return null;
  const db = getIamDb();
  const rows = await db
    .select({ id: roles.id, tenantId: roles.tenantId, code: roles.code, scopes: roles.scopes, immutable: roles.immutable })
    .from(roles)
    .where(
      and(
        eq(roles.tenantId, tenantId),
        input.roleId ? eq(roles.id, input.roleId) : eq(roles.code, input.roleCode!),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    tenantId: row.tenantId,
    code: row.code,
    scopes: expandRoleScopes(
      Array.isArray(row.scopes) ? row.scopes.filter((value): value is string => typeof value === "string") : [],
    ),
    immutable: row.immutable,
  };
}

async function listRoleDefinitionsInternal(tenantId: string): Promise<RoleDefinition[]> {
  const db = getIamDb();
  const rows = await db
    .select({ id: roles.id, tenantId: roles.tenantId, code: roles.code, scopes: roles.scopes, immutable: roles.immutable })
    .from(roles)
    .where(eq(roles.tenantId, tenantId))
    .orderBy(asc(roles.code));
  return rows.map((row) => ({
    id: row.id,
    tenantId: row.tenantId,
    code: row.code,
    scopes: expandRoleScopes(
      Array.isArray(row.scopes) ? row.scopes.filter((value): value is string => typeof value === "string") : [],
    ),
    immutable: row.immutable,
  }));
}

async function countActiveUsersWithRoleDb(db: PgDb, tenantId: string, roleCode: string): Promise<number> {
  const liveUsers = and(
    activeUserPredicate(),
    eq(users.status, "active"),
    sql`(${users.lockedUntil} is null or ${users.lockedUntil} <= now())`,
  );
  // Once a durable user principal exists, its explicit binding set is the
  // source of truth.  Do not let stale user_roles rows resurrect a revoked
  // super-admin (or any other role) after migration.
  const principalRows = await db
    .select({ userId: principals.userId })
    .from(principals)
    .where(and(eq(principals.tenantId, tenantId), eq(principals.kind, "user")));
  const authoritativeUserIds = new Set(
    principalRows.map((row) => row.userId).filter((id): id is string => Boolean(id)),
  );
  const legacyRows = await db
    .select({ userId: users.id })
    .from(users)
    .innerJoin(userRoles, and(eq(userRoles.userId, users.id), eq(userRoles.tenantId, users.tenantId)))
    .innerJoin(roles, and(eq(roles.id, userRoles.roleId), eq(roles.tenantId, userRoles.tenantId)))
    .where(and(eq(users.tenantId, tenantId), liveUsers, eq(roles.code, roleCode)));
  const explicitRows = await db
    .select({ userId: principals.userId })
    .from(principals)
    .innerJoin(principalRoleBindings, and(eq(principalRoleBindings.principalId, principals.id), eq(principalRoleBindings.tenantId, principals.tenantId)))
    .innerJoin(roles, and(eq(roles.id, principalRoleBindings.roleId), eq(roles.tenantId, principalRoleBindings.tenantId)))
    .innerJoin(users, and(eq(users.id, principals.userId), eq(users.tenantId, principals.tenantId)))
    .where(and(
      eq(principals.tenantId, tenantId),
      eq(principals.kind, "user"),
      eq(principals.status, "active"),
      eq(principalRoleBindings.status, "active"),
      eq(principalRoleBindings.resolution, "resolved"),
      eq(roles.code, roleCode),
      liveUsers,
      sql`(${principalRoleBindings.expiresAt} is null or ${principalRoleBindings.expiresAt} > now())`,
      ...(roleCode === "super_admin" ? [eq(principalRoleBindings.dataScope, "tenant")] : []),
    ));
  return new Set([
    ...legacyRows
      .map((row) => row.userId)
      .filter((id): id is string => Boolean(id) && !authoritativeUserIds.has(id)),
    ...explicitRows.map((row) => row.userId).filter((id): id is string => Boolean(id)),
  ]).size;
}

async function countActiveUsersWithRoleInternal(tenantId: string, roleCode: string): Promise<number> {
  return countActiveUsersWithRoleDb(getIamDb(), tenantId, roleCode);
}

async function roleForBinding(tenantId: string, input: { roleId?: string; roleCode?: string }, db: PgDb) {
  if ((input.roleId ? 1 : 0) + (input.roleCode ? 1 : 0) !== 1) throw new Error("roleId or roleCode is required");
  const rows = await db
    .select()
    .from(roles)
    .where(and(eq(roles.tenantId, tenantId), input.roleId ? eq(roles.id, input.roleId) : eq(roles.code, input.roleCode!)))
    .limit(1);
  if (!rows[0]) throw new Error("role not found");
  return rows[0];
}

async function validateScopeInput(input: AssignPrincipalRoleBindingInput, db: PgDb): Promise<{ scopeOrgId: string | null; scopeDeptId: string | null; expiresAt: Date | null }> {
  const expiresAt = parseExpiry(input.expiresAt);
  const scopeDeptId = input.scopeDeptId ?? null;
  const scopeOrgId = input.scopeOrgId ?? null;
  if (input.dataScope === "department" || input.dataScope === "department_subtree") {
    if (!scopeDeptId) throw new Error("department scope requires scopeDeptId");
    const deptRows = await db
      .select({ id: departments.id, orgId: departments.orgId })
      .from(departments)
      .where(and(eq(departments.tenantId, input.tenantId), eq(departments.id, scopeDeptId)))
      .limit(1);
    const department = deptRows[0];
    if (!department) throw new Error("scope department not found");
    if (scopeOrgId) {
      const orgRows = await db
        .select({ id: organizations.id })
        .from(organizations)
        .where(and(eq(organizations.tenantId, input.tenantId), eq(organizations.id, scopeOrgId)))
        .limit(1);
      if (!orgRows[0] || orgRows[0].id !== department.orgId) throw new Error("scope organization does not contain department");
    }
    return { scopeOrgId: scopeOrgId ?? department.orgId, scopeDeptId, expiresAt };
  }
  if (scopeDeptId || scopeOrgId) throw new Error("scopeDeptId/scopeOrgId are invalid for self or tenant scope");
  return { scopeOrgId: null, scopeDeptId: null, expiresAt };
}

async function assignBindingInternal(input: AssignPrincipalRoleBindingInput): Promise<PrincipalRoleBindingDto> {
  const db = getIamDb();
  const principalRows = await db
    .select({ id: principals.id, kind: principals.kind, status: principals.status, agentMode: agentProfiles.mode })
    .from(principals)
    .leftJoin(
      agentProfiles,
      and(eq(agentProfiles.principalId, principals.id), eq(agentProfiles.tenantId, principals.tenantId)),
    )
    .where(and(eq(principals.tenantId, input.tenantId), eq(principals.id, input.principalId)))
    .limit(1);
  const principal = principalRows[0];
  if (!principal) throw new Error("principal not found");
  if (principal.status !== "active") throw new Error("principal is disabled");
  if (principal.kind === "agent" && principal.agentMode === "service" && input.dataScope === "self") {
    throw new Error("service agents cannot use self range");
  }
  const actorRows = await db
    .select({ id: principals.id, status: principals.status })
    .from(principals)
    .where(and(
      eq(principals.tenantId, input.tenantId),
      eq(principals.kind, "user"),
      eq(principals.userId, input.actorUserId),
    ))
    .limit(1);
  const actorPrincipal = actorRows[0];
  if (!actorPrincipal || actorPrincipal.status !== "active") throw new Error("actor principal is disabled or missing");
  const requestedGrantorId = input.grantedByPrincipalId ?? actorPrincipal.id;
  const grantorRows = await db
    .select({ id: principals.id, status: principals.status })
    .from(principals)
    .where(and(eq(principals.tenantId, input.tenantId), eq(principals.id, requestedGrantorId)))
    .limit(1);
  const grantor = grantorRows[0];
  if (!grantor || grantor.status !== "active") throw new Error("grantor principal is disabled or missing");
  const role = await roleForBinding(input.tenantId, input, db);
  const scope = await validateScopeInput(input, db);
  const grantorApprovalRef = input.grantorApprovalRef?.trim() || null;
  if (grantor.id !== actorPrincipal.id) {
    if (!grantorApprovalRef) throw new Error("grantor approval is required");
    if (!input.grantorApprovalVerifier) throw new Error("resource approval is unverified");
    const verified = await input.grantorApprovalVerifier({
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      grantorPrincipalId: grantor.id,
      approvalRef: grantorApprovalRef,
      targetPrincipalId: input.principalId,
      roleId: role.id,
      roleCode: role.code,
      dataScope: input.dataScope,
      scopeOrgId: scope.scopeOrgId,
      scopeDeptId: scope.scopeDeptId,
      expiresAt: iso(scope.expiresAt),
      canDelegate: input.canDelegate ?? false,
    });
    if (!verified) throw new Error("resource approval is unverified");
  }
  const id = ulid();
  const now = new Date();
  // Lock all principals involved in a deterministic order.  Apart from
  // preventing deadlocks when two operators delegate in opposite directions,
  // this lets the transaction re-check status/version after the guard ran.
  const principalLockIds = [...new Set([actorPrincipal.id, grantor.id, input.principalId])].sort();
  await db.transaction(async (tx) => {
    // Role updates take the tenant lock before touching role/principal rows.
    // Use the same first lock here so a scope change cannot deadlock with a
    // concurrent assignment and both operations serialize their snapshots.
    await tx
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.id, input.tenantId))
      .for("update");
    const lockedRows = await tx
      .select({ id: principals.id, kind: principals.kind, userId: principals.userId, status: principals.status, authzVersion: principals.authzVersion })
      .from(principals)
      .where(and(
      eq(principals.tenantId, input.tenantId),
        inArray(principals.id, principalLockIds),
      ))
      .orderBy(asc(principals.id))
      .for("update");
    const lockedById = new Map(lockedRows.map((row) => [row.id, row]));
    const lockedActor = lockedById.get(actorPrincipal.id);
    const lockedGrantor = lockedById.get(grantor.id);
    const lockedTarget = lockedById.get(input.principalId);
    if (!lockedActor || lockedActor.kind !== "user" || lockedActor.userId !== input.actorUserId || lockedActor.status !== "active") {
      throw new Error("actor principal is disabled or missing");
    }
    if (!lockedGrantor || lockedGrantor.status !== "active") {
      throw new Error("grantor principal is disabled or missing");
    }
    if (!lockedTarget || lockedTarget.status !== "active") {
      throw new Error("principal is disabled");
    }
    if (input.expectedActorAuthzVersion !== undefined && lockedActor.authzVersion !== input.expectedActorAuthzVersion) {
      throw new Error("authorization context is stale");
    }
    if (input.expectedGrantorAuthzVersion !== undefined && lockedGrantor.authzVersion !== input.expectedGrantorAuthzVersion) {
      throw new Error("authorization context is stale");
    }
    if (input.expectedTargetAuthzVersion !== undefined && lockedTarget.authzVersion !== input.expectedTargetAuthzVersion) {
      throw new Error("authorization context is stale");
    }
    if (freshnessExpired(input.expectedActorPermissionExpiresAt) || freshnessExpired(input.expectedGrantorPermissionExpiresAt)) {
      throw new Error("authorization context is stale");
    }

    const agentLockIds = [...new Set([
      lockedTarget.kind === "agent" ? lockedTarget.id : null,
      lockedGrantor.kind === "agent" ? lockedGrantor.id : null,
    ].filter((id): id is string => Boolean(id)))].sort();
    const profileRows = agentLockIds.length
      ? await tx
        .select({ principalId: agentProfiles.principalId, mode: agentProfiles.mode, ownerUserId: agentProfiles.ownerUserId })
        .from(agentProfiles)
        .where(and(eq(agentProfiles.tenantId, input.tenantId), inArray(agentProfiles.principalId, agentLockIds)))
        .orderBy(asc(agentProfiles.principalId))
        .for("update")
      : [];
    const profileById = new Map(profileRows.map((profile) => [profile.principalId, profile]));
    const targetProfile = lockedTarget.kind === "agent" ? profileById.get(lockedTarget.id) : null;
    const grantorProfile = lockedGrantor.kind === "agent" ? profileById.get(lockedGrantor.id) : null;
    if (lockedTarget.kind === "agent" && !targetProfile) throw new Error("agent profile is missing");
    if (lockedGrantor.kind === "agent" && !grantorProfile) throw new Error("agent profile is missing");
    const lockedAgentMode = targetProfile?.mode as AgentMode | undefined;
    if (lockedTarget.kind === "agent" && lockedAgentMode === "service" && input.dataScope === "self") {
      throw new Error("service agents cannot use self range");
    }

    const grantorOwnerUserId = lockedGrantor.kind === "user"
      ? lockedGrantor.userId
      : grantorProfile?.ownerUserId ?? null;
    // A user principal is backed by its account; an agent principal is backed
    // by its owner.  Lock and re-check that account in this transaction so an
    // account disable/lock cannot race a new binding into existence.
    const targetBackingUserId = lockedTarget.kind === "user"
      ? lockedTarget.userId
      : targetProfile?.ownerUserId ?? null;
    const userLockIds = [...new Set([
      input.actorUserId,
      grantorOwnerUserId,
      targetBackingUserId,
    ].filter((id): id is string => Boolean(id)))].sort();
    const lockedUsers = await tx
      .select({
        id: users.id,
        status: users.status,
        isDeleted: users.isDeleted,
        deletedAt: users.deletedAt,
        lockedUntil: users.lockedUntil,
      })
      .from(users)
      .where(and(eq(users.tenantId, input.tenantId), inArray(users.id, userLockIds)))
      .orderBy(asc(users.id))
      .for("update");
    const userById = new Map(lockedUsers.map((user) => [user.id, user]));
    assertEnabledMutationUser(userById.get(input.actorUserId), "actor principal is disabled or missing");
    if (grantorOwnerUserId) {
      assertEnabledMutationUser(userById.get(grantorOwnerUserId), "grantor principal is disabled or missing");
    } else if (lockedGrantor.kind === "user") {
      throw new Error("grantor principal is disabled or missing");
    }
    if (targetBackingUserId) {
      assertEnabledMutationUser(userById.get(targetBackingUserId), "principal is disabled or missing");
    }

    const lockedRoleRows = await tx
      .select()
      .from(roles)
      .where(and(eq(roles.tenantId, input.tenantId), eq(roles.id, role.id)))
      .for("update");
    const lockedRole = lockedRoleRows[0];
    if (!lockedRole) throw new Error("role not found");
    const lockedRoleScopes = expandRoleScopes(Array.isArray(lockedRole.scopes)
      ? lockedRole.scopes.filter((value): value is string => typeof value === "string")
      : []);
    if (input.expectedRoleId !== undefined && lockedRole.id !== input.expectedRoleId) {
      throw new Error("authorization context is stale");
    }
    if (input.expectedRoleScopeFingerprint !== undefined && roleScopeFingerprint(lockedRoleScopes) !== input.expectedRoleScopeFingerprint) {
      throw new Error("authorization context is stale");
    }
    if (input.expectedRoleScopes !== undefined && roleScopeFingerprint(lockedRoleScopes) !== roleScopeFingerprint(input.expectedRoleScopes)) {
      throw new Error("authorization context is stale");
    }
    const lockedScope = await validateScopeInput(input, tx);
    await tx.insert(principalRoleBindings).values({
      id,
      tenantId: input.tenantId,
      principalId: input.principalId,
      roleId: lockedRole.id,
      dataScope: input.dataScope,
      scopeOrgId: lockedScope.scopeOrgId,
      scopeDeptId: lockedScope.scopeDeptId,
      expiresAt: lockedScope.expiresAt,
      grantedByPrincipalId: grantor.id,
      canDelegate: input.canDelegate ?? false,
      grantorApprovalRef,
      status: "active",
      resolution: "resolved",
      resolutionReason: null,
      source: "explicit",
      createdByUserId: input.actorUserId,
      createdAt: now,
      updatedAt: now,
    });
    await tx
      .update(principals)
      .set({ authzVersion: sql`${principals.authzVersion} + 1`, updatedAt: now })
      .where(and(eq(principals.tenantId, input.tenantId), eq(principals.id, input.principalId)));
    await insertAuditEvent({
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      actorPrincipalId: lockedActor.id,
      grantorPrincipalId: lockedGrantor.id,
      eventType: "iam.principal.role_binding.assign",
      targetKind: "principal_role_binding",
      targetId: id,
      detail: {
        principalId: input.principalId,
        roleId: lockedRole.id,
        dataScope: input.dataScope,
        scopeOrgId: lockedScope.scopeOrgId,
        scopeDeptId: lockedScope.scopeDeptId,
        expiresAt: iso(lockedScope.expiresAt),
        grantedByPrincipalId: lockedGrantor.id,
        canDelegate: input.canDelegate ?? false,
        grantorApprovalRef,
      },
    }, tx);
  });
  const rows = await db
    .select({ binding: principalRoleBindings, code: roles.code, scopes: roles.scopes })
    .from(principalRoleBindings)
    .innerJoin(roles, and(eq(roles.id, principalRoleBindings.roleId), eq(roles.tenantId, principalRoleBindings.tenantId)))
    .where(and(eq(principalRoleBindings.tenantId, input.tenantId), eq(principalRoleBindings.id, id)))
    .limit(1);
  const row = rows[0];
  if (!row) throw new Error("role binding create failed");
  return mapBinding(row.binding, { code: row.code, scopes: row.scopes });
}

async function removeBindingInternal(input: RemovePrincipalRoleBindingInput): Promise<void> {
  const db = getIamDb();
  const rows = await db
    .select({ id: principalRoleBindings.id, principalId: principalRoleBindings.principalId, status: principalRoleBindings.status, roleCode: roles.code, grantedByPrincipalId: principalRoleBindings.grantedByPrincipalId })
    .from(principalRoleBindings)
    .innerJoin(roles, and(eq(roles.id, principalRoleBindings.roleId), eq(roles.tenantId, principalRoleBindings.tenantId)))
    .where(and(eq(principalRoleBindings.tenantId, input.tenantId), eq(principalRoleBindings.id, input.bindingId)))
    .limit(1);
  const row = rows[0];
  if (!row) throw new Error("role binding not found");
  if (row.status === "revoked") return;
  const actorRows = await db
    .select({ id: principals.id, kind: principals.kind, userId: principals.userId, status: principals.status })
    .from(principals)
    .where(and(
      eq(principals.tenantId, input.tenantId),
      eq(principals.kind, "user"),
      eq(principals.userId, input.actorUserId),
    ))
    .limit(1);
  let revokedByThisCall = false;
  const now = new Date();
  const principalLockIds = [...new Set([actorRows[0]?.id, row.principalId].filter((id): id is string => Boolean(id)))].sort();
  await db.transaction(async (tx) => {
    await tx
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.id, input.tenantId))
      .for("update");
    const lockedRows = await tx
      .select({ id: principalRoleBindings.id, principalId: principalRoleBindings.principalId, status: principalRoleBindings.status, roleCode: roles.code, grantedByPrincipalId: principalRoleBindings.grantedByPrincipalId })
      .from(principalRoleBindings)
      .innerJoin(roles, and(eq(roles.id, principalRoleBindings.roleId), eq(roles.tenantId, principalRoleBindings.tenantId)))
      .where(and(eq(principalRoleBindings.tenantId, input.tenantId), eq(principalRoleBindings.id, input.bindingId)))
      .for("update");
    const locked = lockedRows[0];
    if (!locked || locked.status === "revoked") {
      revokedByThisCall = false;
      return;
    }
    const lockedPrincipalRows = await tx
      .select({ id: principals.id, kind: principals.kind, userId: principals.userId, status: principals.status, authzVersion: principals.authzVersion })
      .from(principals)
      .where(and(eq(principals.tenantId, input.tenantId), inArray(principals.id, principalLockIds)))
      .orderBy(asc(principals.id))
      .for("update");
    const lockedPrincipals = new Map(lockedPrincipalRows.map((item) => [item.id, item]));
    const lockedActor = actorRows[0]?.id ? lockedPrincipals.get(actorRows[0].id) : undefined;
    const lockedTarget = lockedPrincipals.get(locked.principalId);
    if (!lockedActor || lockedActor.kind !== "user" || lockedActor.userId !== input.actorUserId || lockedActor.status !== "active") {
      throw new Error("actor principal is disabled or missing");
    }
    if (input.expectedActorPrincipalId !== undefined && lockedActor.id !== input.expectedActorPrincipalId) {
      throw new Error("authorization context is stale");
    }
    if (input.expectedActorAuthzVersion !== undefined && lockedActor.authzVersion !== input.expectedActorAuthzVersion) {
      throw new Error("authorization context is stale");
    }
    if (freshnessExpired(input.expectedActorPermissionExpiresAt)) {
      throw new Error("authorization context is stale");
    }
    if (!lockedTarget) throw new Error("target principal missing");
    const lockedActorUsers = await tx
      .select({ id: users.id, status: users.status, isDeleted: users.isDeleted, deletedAt: users.deletedAt })
      .from(users)
      .where(and(eq(users.tenantId, input.tenantId), eq(users.id, input.actorUserId)))
      .for("update");
    const lockedActorUser = lockedActorUsers[0];
    if (!lockedActorUser || lockedActorUser.status !== "active" || lockedActorUser.isDeleted || lockedActorUser.deletedAt !== null) {
      throw new Error("actor principal is disabled or missing");
    }
    await tx
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.id, input.tenantId))
      .for("update");
    if (locked.roleCode === "super_admin") {
      const [principal] = await tx
        .select({ kind: principals.kind, userId: principals.userId })
        .from(principals)
        .where(and(eq(principals.tenantId, input.tenantId), eq(principals.id, locked.principalId)))
        .limit(1);
      if (principal?.kind === "user" && principal.userId) {
        const remaining = await tx
          .select({ id: principalRoleBindings.id })
          .from(principalRoleBindings)
          .innerJoin(roles, and(eq(roles.id, principalRoleBindings.roleId), eq(roles.tenantId, principalRoleBindings.tenantId)))
          .where(and(
            eq(principalRoleBindings.tenantId, input.tenantId),
            eq(principalRoleBindings.principalId, locked.principalId),
            ne(principalRoleBindings.id, input.bindingId),
            eq(principalRoleBindings.status, "active"),
            eq(principalRoleBindings.resolution, "resolved"),
            eq(roles.code, "super_admin"),
            sql`(${principalRoleBindings.expiresAt} is null or ${principalRoleBindings.expiresAt} > now())`,
          ))
          .limit(1);
        if (!remaining[0] && await countActiveUsersWithRoleDb(tx, input.tenantId, "super_admin") <= 1) {
          throw new Error("last_superadmin_protected");
        }
      }
    }
    await tx
      .update(principalRoleBindings)
      .set({ status: "revoked", updatedAt: now })
      .where(and(eq(principalRoleBindings.tenantId, input.tenantId), eq(principalRoleBindings.id, input.bindingId)));
    await tx
      .update(principals)
      .set({ authzVersion: sql`${principals.authzVersion} + 1`, updatedAt: now })
      .where(and(eq(principals.tenantId, input.tenantId), eq(principals.id, locked.principalId)));
    await insertAuditEvent({
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      actorPrincipalId: lockedActor.id,
      grantorPrincipalId: locked.grantedByPrincipalId ?? null,
      eventType: "iam.principal.role_binding.remove",
      targetKind: "principal_role_binding",
      targetId: input.bindingId,
    }, tx);
    revokedByThisCall = true;
  });
  if (!revokedByThisCall) return;
}

async function effectiveBindingsInternal(input: EffectivePermissionsInput): Promise<PrincipalRoleBindingDto[]> {
  const at = input.at ?? new Date();
  const bindings = await listBindingsInternal(input.tenantId, input.principalId);
  return bindings.filter((binding) =>
    binding.status === "active" &&
    binding.resolution === "resolved" &&
    (binding.expiresAt === null || new Date(binding.expiresAt).getTime() > at.getTime()),
  );
}

async function listLegacyBindingsInternal(tenantId: string, userId: string): Promise<LegacyUserRoleBinding[]> {
  const db = getIamDb();
  const rows = await db
    .select({
      binding: userRoles,
      roleCode: roles.code,
      roleScopes: roles.scopes,
      departmentId: departments.id,
      organizationId: organizations.id,
    })
    .from(userRoles)
    .innerJoin(roles, and(eq(roles.id, userRoles.roleId), eq(roles.tenantId, userRoles.tenantId)))
    .leftJoin(departments, and(eq(departments.id, userRoles.scopeDeptId), eq(departments.tenantId, userRoles.tenantId)))
    .leftJoin(organizations, and(eq(organizations.id, userRoles.scopeOrgId), eq(organizations.tenantId, userRoles.tenantId)))
    .where(and(eq(userRoles.tenantId, tenantId), eq(userRoles.userId, userId)))
    .orderBy(asc(userRoles.createdAt), asc(userRoles.roleId));
  return rows.map((row) => {
    const legacy = legacyScope(row.roleCode, row.binding.scopeDeptId ?? null, Boolean(row.departmentId));
    const scopes = expandRoleScopes(Array.isArray(row.roleScopes) ? row.roleScopes.filter((v): v is string => typeof v === "string") : []);
    return {
      id: `legacy:${tenantId}:${userId}:${row.binding.roleId}`,
      tenantId,
      principalId: `user:${tenantId}:${userId}`,
      roleId: row.binding.roleId,
      roleCode: row.roleCode,
      scopes,
      dataScope: legacy.dataScope,
      scopeOrgId: row.organizationId ?? null,
      scopeDeptId: legacy.scopeDeptId,
      expiresAt: null,
      status: "active",
      resolution: legacy.resolution,
      resolutionReason: legacy.resolutionReason,
      source: "legacy",
      createdByUserId: null,
      grantedByPrincipalId: null,
      canDelegate: scopes.includes("role:assign"),
      grantorApprovalRef: null,
      createdAt: row.binding.createdAt.toISOString(),
      updatedAt: row.binding.updatedAt.toISOString(),
    };
  });
}

async function syncUserRoleCodesInternal(input: {
  tenantId: string;
  userId: string;
  roleCodes: string[];
  defaultOrgId: string | null;
  defaultDeptId: string | null;
}, dbOrTx?: unknown): Promise<void> {
  const suppliedDb = dbOrTx as PgDb | undefined;
  const db = suppliedDb ?? getIamDb();
  const apply = async (tx: PgDb): Promise<void> => {
    // The user row is locked by the enclosing user mutation when this is
    // called with a transaction.  Keep the principal upsert and legacy
    // binding replacement on that same connection so a failure rolls back
    // the whole user/role change.
    const principal = await ensureUserPrincipalInternal(input.tenantId, input.userId, tx);
    if (!principal) return;
    const codes = normalizedRoleCodes(input.roleCodes);
    const roleRows = codes.length
      ? await tx.select().from(roles).where(and(eq(roles.tenantId, input.tenantId), inArray(roles.code, codes)))
      : [];
    const roleByCode = new Map(roleRows.map((role) => [role.code, role]));
    const deptRows = input.defaultDeptId
      ? await tx.select({ id: departments.id, orgId: departments.orgId }).from(departments).where(and(eq(departments.tenantId, input.tenantId), eq(departments.id, input.defaultDeptId))).limit(1)
      : [];
    const departmentExists = Boolean(deptRows[0]);
    const trustedOrgId = deptRows[0]?.orgId ?? null;
    const now = new Date();
    await tx.delete(principalRoleBindings).where(and(eq(principalRoleBindings.tenantId, input.tenantId), eq(principalRoleBindings.principalId, principal.id), eq(principalRoleBindings.source, "legacy")));
    for (const code of codes) {
      const role = roleByCode.get(code);
      if (!role) continue;
      const legacy = legacyScope(code, input.defaultDeptId, departmentExists);
      await tx.insert(principalRoleBindings).values({
        id: ulid(),
        tenantId: input.tenantId,
        principalId: principal.id,
        roleId: role.id,
        dataScope: legacy.dataScope,
        scopeOrgId: legacy.dataScope === "department" ? trustedOrgId : null,
        scopeDeptId: legacy.scopeDeptId,
        expiresAt: null,
        status: "active",
        resolution: legacy.resolution,
        resolutionReason: legacy.resolutionReason,
        source: "legacy",
        createdByUserId: null,
        grantedByPrincipalId: null,
        canDelegate: expandRoleScopes(Array.isArray(role.scopes) ? role.scopes.filter((v): v is string => typeof v === "string") : []).includes("role:assign"),
        grantorApprovalRef: null,
        createdAt: now,
        updatedAt: now,
      });
    }
    await tx
      .update(principals)
      .set({ authzVersion: sql`${principals.authzVersion} + 1`, updatedAt: now })
      .where(and(eq(principals.tenantId, input.tenantId), eq(principals.id, principal.id)));
  };
  if (suppliedDb) await apply(db);
  else await db.transaction(apply);
}

async function resolveAuthorizationTargetInternal(tenantId: string, target: { kind: string; id: string }): Promise<ResolvedAuthorizationTarget | null> {
  const db = getIamDb();
  const kind = target.kind.trim().toLowerCase();
  if (!target.id.trim()) return null;
  if (kind === "tenant") {
    const rows = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
    return rows[0] && rows[0].id === target.id ? { kind: "tenant", id: target.id, tenantId, deptId: null, ownerUserId: null } : null;
  }
  if (["user", "member", "employee"].includes(kind)) {
    const rows = await db
      .select({ id: users.id, tenantId: users.tenantId, deptId: users.deptId })
      .from(users)
      .where(and(eq(users.tenantId, tenantId), eq(users.id, target.id), enabledUserPredicate()))
      .limit(1);
    const row = rows[0];
    return row ? { kind: "user", id: row.id, tenantId: row.tenantId, deptId: row.deptId ?? null, ownerUserId: row.id } : null;
  }
  if (["department", "dept"].includes(kind)) {
    const rows = await db.select({ id: departments.id }).from(departments).where(and(eq(departments.tenantId, tenantId), eq(departments.id, target.id))).limit(1);
    return rows[0] ? { kind: "department", id: rows[0].id, tenantId, deptId: rows[0].id, ownerUserId: null } : null;
  }
  if (kind === "agent") {
    const rows = await db
      .select({ id: principals.id, ownerUserId: agentProfiles.ownerUserId, deptId: users.deptId })
      .from(principals)
      .innerJoin(
        agentProfiles,
        and(eq(agentProfiles.principalId, principals.id), eq(agentProfiles.tenantId, principals.tenantId)),
      )
      .leftJoin(users, and(eq(users.tenantId, principals.tenantId), eq(users.id, agentProfiles.ownerUserId)))
      .where(and(eq(principals.tenantId, tenantId), eq(principals.id, target.id), eq(principals.kind, "agent")))
      .limit(1);
    const row = rows[0];
    return row
      ? { kind: "agent", id: row.id, tenantId, deptId: row.deptId ?? null, ownerUserId: row.ownerUserId ?? null }
      : null;
  }
  if (kind === "role") {
    const rows = await db.select({ id: roles.id }).from(roles).where(and(eq(roles.tenantId, tenantId), eq(roles.id, target.id))).limit(1);
    return rows[0] ? { kind: "role", id: rows[0].id, tenantId, deptId: null, ownerUserId: null } : null;
  }
  // Unknown object kinds cannot be trusted from a client.  Register a domain
  // resolver before allowing them; tenant-scope is not a bypass.
  return null;
}

async function departmentScopeContainsInternal(
  tenantId: string,
  scopeDeptId: string,
  targetDeptId: string,
  subtree: boolean,
): Promise<boolean> {
  const db = getIamDb();
  if (!subtree) {
    const rows = await db
      .select({ id: departments.id })
      .from(departments)
      .where(and(eq(departments.tenantId, tenantId), eq(departments.id, scopeDeptId), eq(departments.id, targetDeptId)))
      .limit(1);
    return Boolean(rows[0]);
  }
  const rows = await db
    .select({ id: departments.id, path: departments.path })
    .from(departments)
    .where(and(eq(departments.tenantId, tenantId), inArray(departments.id, [scopeDeptId, targetDeptId])));
  const scope = rows.find((row) => row.id === scopeDeptId);
  const target = rows.find((row) => row.id === targetDeptId);
  // Compare trusted path values in memory.  SQL LIKE treats '%' and '_' in
  // department names as wildcards and could otherwise widen a subtree.
  return Boolean(scope && target && target.path.startsWith(scope.path));
}

export const postgresqlPrincipalsRepository: PrincipalsRepository = {
  dialect: "postgresql",
  getPrincipal: getPrincipalInternal,
  getPrincipalForUser: getPrincipalForUserInternal,
  getUserStatus: getUserStatusInternal,
  ensureUserPrincipal: ensureUserPrincipalInternal,
  listPrincipals: listPrincipalsInternal,
  createAgentPrincipal: createAgentPrincipalInternal,
  updateAgentPrincipal: updateAgentPrincipalInternal,
  listPrincipalRoleBindings: listBindingsInternal,
  listPrincipalRoleBindingsForRole: listBindingsForRoleInternal,
  getPrincipalRoleBinding: getPrincipalRoleBindingInternal,
  assignPrincipalRoleBinding: assignBindingInternal,
  removePrincipalRoleBinding: removeBindingInternal,
  getPrincipalEffectivePermissions: effectiveBindingsInternal,
  getRoleDefinition: getRoleDefinitionInternal,
  listRoleDefinitions: listRoleDefinitionsInternal,
  countActiveUsersWithRole: countActiveUsersWithRoleInternal,
  listLegacyUserRoleBindings: listLegacyBindingsInternal,
  syncUserRoleCodes: syncUserRoleCodesInternal,
  resolveAuthorizationTarget: resolveAuthorizationTargetInternal,
  departmentScopeContains: departmentScopeContainsInternal,
};

export function getPrincipalsRepository(): PrincipalsRepository {
  return postgresqlPrincipalsRepository;
}
