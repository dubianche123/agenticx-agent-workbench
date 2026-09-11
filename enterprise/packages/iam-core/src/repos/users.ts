import type { AuthUser } from "@agenticx/auth";
import { hashPassword } from "@agenticx/auth";
import {
  departments,
  enterpriseRuntimeUserVisibleModels,
  principalRoleBindings,
  principals,
  roles,
  userRoles,
  users,
} from "@agenticx/db-schema";
import { and, asc, desc, eq, exists, inArray, ilike, isNull, like, not, or, sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { ulid } from "ulid";
import { getIamDb, type IamDb } from "../db";
import { resolveDatabaseConfig } from "../database/config";
import { insertAuditEvent } from "./audit";
import type { UsersRepository } from "./contracts";
import { mysqlUsersRepository as mysqlUsersRepo } from "./mysql/users";
import { getRoleByCode, getUserRolesDetail, resolveRoleIdsFromCodes } from "./roles";
import { assertUserDeletionSafe, assertUserRoleCodesGrantable } from "../authorization/grantability";
import { getPrincipalRepository } from "../authorization/repository";
import { roleCodeSnapshotsMatch } from "../authorization/types";
import type { GrantabilitySnapshot } from "../authorization/types";
import { expandRoleScopes } from "../scope-registry";

export type AdminUserStatus = "active" | "disabled" | "locked";

export type AdminUserDto = {
  id: string;
  tenantId: string;
  deptId: string | null;
  email: string;
  displayName: string;
  status: AdminUserStatus;
  scopes: string[];
  /** 当前绑定的系统/自定义角色 code，便于管理端编辑回显。 */
  roleCodes: string[];
  phone: string | null;
  employeeNo: string | null;
  jobTitle: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ListUsersFilter = {
  q?: string;
  status?: AdminUserStatus;
  deptId?: string;
  /** direct=仅直属部门；subtree=含子部门（默认，兼容用户管理页筛选） */
  deptScope?: "direct" | "subtree";
  roleCode?: string;
  limit?: number;
  offset?: number;
  /** Server-resolved visibility predicate; omitted only for trusted internal callers. */
  visibility?: UserListVisibility;
};

export type UserListVisibility = {
  tenantWide: boolean;
  userIds: string[];
  departmentIds: string[];
};

export type ListUsersResult = { items: AdminUserDto[]; total: number };

/** Minimal public-directory projection; intentionally excludes phone, employee number, roles, and scopes. */
export type AudienceUserDto = {
  id: string;
  displayName: string;
  email: string;
  deptId: string | null;
};

export type ListAudienceUsersFilter = {
  q?: string;
  limit?: number;
  offset?: number;
};

function mapDbStatus(row: typeof users.$inferSelect): AdminUserStatus {
  const lockedUntil = row.lockedUntil?.getTime() ?? 0;
  if (lockedUntil > Date.now()) return "locked";
  if (row.status === "disabled") return "disabled";
  return row.status === "locked" ? "locked" : "active";
}

async function toDto(row: typeof users.$inferSelect): Promise<AdminUserDto> {
  const { scopes, roleCodes } = await getUserRolesDetail(row.tenantId, row.id);
  return {
    id: row.id,
    tenantId: row.tenantId,
    deptId: row.deptId,
    email: row.email,
    displayName: row.displayName,
    status: mapDbStatus(row),
    scopes,
    roleCodes,
    phone: row.phone ?? null,
    employeeNo: row.employeeNo ?? null,
    jobTitle: row.jobTitle ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function generateInitialPassword(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%";
  let out = "";
  const buf = randomBytes(12);
  for (let i = 0; i < 12; i++) out += chars[buf[i]! % chars.length];
  return out;
}

function elevatedRoleCodes(roleCodes: string[]): string[] {
  return roleCodes.filter((code) => code.trim().toLowerCase() !== "member");
}

function normalizeAdminEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("invalid email");
  return email;
}

async function listDepartmentSubtreeIdsLocal(tenantId: string, deptId: string): Promise<string[]> {
  const db = getIamDb();
  const self = await db
    .select({ path: departments.path })
    .from(departments)
    .where(and(eq(departments.tenantId, tenantId), eq(departments.id, deptId)))
    .limit(1);
  if (!self[0]) return [];
  const base = self[0].path;
  const rows = await db
    .select({ id: departments.id })
    .from(departments)
    .where(and(eq(departments.tenantId, tenantId), like(departments.path, `${base}%`)));
  return rows.map((r) => r.id);
}

export async function loadAuthUserByEmail(tenantId: string, email: string): Promise<AuthUser | null> {
  if (resolveDatabaseConfig().dialect === "mysql") {
    return mysqlUsersRepo.loadAuthUserByEmail(tenantId, email);
  }
  const db = getIamDb();
  const row = await db
    .select()
    .from(users)
    .where(
      and(
        eq(users.tenantId, tenantId),
        eq(users.email, email.toLowerCase()),
        eq(users.isDeleted, false),
        isNull(users.deletedAt)
      )
    )
    .limit(1);
  if (!row[0]) return null;
  const { scopes } = await getUserRolesDetail(tenantId, row[0].id);
  const lockedUntil = row[0].lockedUntil?.getTime() ?? null;
  return {
    id: row[0].id,
    tenantId: row[0].tenantId,
    deptId: row[0].deptId,
    email: row[0].email.toLowerCase(),
    displayName: row[0].displayName,
    passwordHash: row[0].passwordHash,
    mustChangePassword: row[0].mustChangePassword,
    status: mapDbStatus(row[0]),
    failedLoginCount: row[0].failedLoginCount ?? 0,
    lockedUntil,
    scopes,
  };
}

export async function updateFailedLoginPg(
  tenantId: string,
  email: string,
  nextFailedCount: number,
  lockedUntilMs: number | null
): Promise<void> {
  const db = getIamDb();
  const lu = lockedUntilMs === null ? null : new Date(lockedUntilMs);
  const locking = Boolean(lu && lu.getTime() > Date.now());
  await db
    .update(users)
    .set({
      failedLoginCount: nextFailedCount,
      lockedUntil: lu,
      ...(locking ? { status: "locked" as const } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(users.tenantId, tenantId), eq(users.email, email.toLowerCase())));
}

export async function resetFailedLoginPg(tenantId: string, email: string): Promise<void> {
  const db = getIamDb();
  const row = await db
    .select({ status: users.status })
    .from(users)
    .where(and(eq(users.tenantId, tenantId), eq(users.email, email.toLowerCase())))
    .limit(1);
  const nextStatus = row[0]?.status === "locked" ? "active" : row[0]?.status ?? "active";
  await db
    .update(users)
    .set({
      failedLoginCount: 0,
      lockedUntil: null,
      status: nextStatus,
      updatedAt: new Date(),
    })
    .where(and(eq(users.tenantId, tenantId), eq(users.email, email.toLowerCase())));
}

async function applyUserFilters(
  tenantId: string,
  filter: ListUsersFilter
): Promise<ReturnType<typeof and> | undefined> {
  const db = getIamDb();
  const parts = [
    eq(users.tenantId, tenantId),
    eq(users.isDeleted, false),
    isNull(users.deletedAt),
  ] as const;

  const extra: Parameters<typeof and>[number][] = [];

  if (filter.status) {
    if (filter.status === "locked") {
      extra.push(sql`${users.lockedUntil} is not null and ${users.lockedUntil} > now()`);
    } else if (filter.status === "disabled") {
      extra.push(eq(users.status, "disabled"));
    } else if (filter.status === "active") {
      extra.push(
        and(eq(users.status, "active"), or(isNull(users.lockedUntil), sql`${users.lockedUntil} <= now()`)!)!
      );
    }
  }

  const q = filter.q?.trim();
  if (q) {
    const pattern = `%${q}%`;
    extra.push(
      or(
        ilike(users.email, pattern),
        ilike(users.displayName, pattern),
        ilike(sql`coalesce(${users.employeeNo}, '')`, pattern),
        ilike(sql`coalesce(${users.phone}, '')`, pattern)
      )!
    );
  }

  if (filter.deptId) {
    if (filter.deptScope === "direct") {
      extra.push(eq(users.deptId, filter.deptId));
    } else {
      const subtree = await listDepartmentSubtreeIdsLocal(tenantId, filter.deptId);
      if (subtree.length) {
        extra.push(inArray(users.deptId, subtree));
      } else {
        extra.push(sql`false`);
      }
    }
  }

  if (filter.roleCode) {
    const explicitRole = exists(
      db
        .select({ x: sql`1` })
        .from(principals)
        .innerJoin(
          principalRoleBindings,
          and(
            eq(principalRoleBindings.principalId, principals.id),
            eq(principalRoleBindings.tenantId, principals.tenantId),
          ),
        )
        .innerJoin(roles, and(eq(roles.id, principalRoleBindings.roleId), eq(roles.tenantId, principalRoleBindings.tenantId)))
        .where(and(
          eq(principals.tenantId, tenantId),
          eq(principals.userId, users.id),
          eq(principals.kind, "user"),
          eq(principals.status, "active"),
          eq(principalRoleBindings.status, "active"),
          eq(principalRoleBindings.resolution, "resolved"),
          eq(roles.code, filter.roleCode),
          sql`(${principalRoleBindings.expiresAt} is null or ${principalRoleBindings.expiresAt} > now())`,
        )),
    );
    const legacyRole = and(
      exists(
        db
          .select({ x: sql`1` })
          .from(userRoles)
          .innerJoin(roles, and(eq(roles.id, userRoles.roleId), eq(roles.tenantId, userRoles.tenantId)))
          .where(and(eq(userRoles.userId, users.id), eq(userRoles.tenantId, tenantId), eq(roles.code, filter.roleCode))),
      ),
      not(exists(
        db
          .select({ x: sql`1` })
          .from(principals)
          .where(and(eq(principals.tenantId, tenantId), eq(principals.userId, users.id), eq(principals.kind, "user"))),
      )),
    );
    extra.push(or(explicitRole, legacyRole)!);
  }

  if (filter.visibility && !filter.visibility.tenantWide) {
    const visible: Parameters<typeof and>[number][] = [];
    if (filter.visibility.userIds.length) {
      visible.push(inArray(users.id, filter.visibility.userIds));
    }
    if (filter.visibility.departmentIds.length) {
      visible.push(inArray(users.deptId, filter.visibility.departmentIds));
    }
    extra.push(visible.length ? or(...visible)! : sql`false`);
  }

  return and(...parts, ...extra);
}

export async function listAdminUsers(tenantId: string, filter: ListUsersFilter = {}): Promise<ListUsersResult> {
  if (resolveDatabaseConfig().dialect === "mysql") {
    return mysqlUsersRepo.listAdminUsers(tenantId, filter);
  }
  const db = getIamDb();
  const where = await applyUserFilters(tenantId, filter);
  const limit = Math.max(1, Math.min(200, filter.limit ?? 50));
  const offset = Math.max(0, filter.offset ?? 0);

  const totalRow = await db.select({ c: sql<number>`count(*)::int` }).from(users).where(where);
  const total = totalRow[0]?.c ?? 0;

  const rows = await db
    .select()
    .from(users)
    .where(where)
    .orderBy(desc(users.createdAt))
    .limit(limit)
    .offset(offset);

  const items = await Promise.all(rows.map((r) => toDto(r)));
  return { items, total };
}

/**
 * Search the active employee directory using public identity fields only.
 * Keep this separate from admin search so phone/employee-number values cannot act as lookup oracles.
 */
export async function listAudienceUsers(
  tenantId: string,
  filter: ListAudienceUsersFilter = {},
): Promise<AudienceUserDto[]> {
  if (resolveDatabaseConfig().dialect === "mysql") {
    return mysqlUsersRepo.listAudienceUsers(tenantId, filter);
  }
  const q = filter.q?.trim();
  const search = q
    ? or(ilike(users.displayName, `%${q}%`), ilike(users.email, `%${q}%`))
    : undefined;
  const where = and(
    eq(users.tenantId, tenantId),
    eq(users.isDeleted, false),
    isNull(users.deletedAt),
    eq(users.status, "active"),
    or(isNull(users.lockedUntil), sql`${users.lockedUntil} <= now()`),
    search,
  );
  const limit = Math.max(1, Math.min(100, filter.limit ?? 50));
  const offset = Math.max(0, filter.offset ?? 0);
  const rows = await getIamDb()
    .select({
      id: users.id,
      displayName: users.displayName,
      email: users.email,
      deptId: users.deptId,
    })
    .from(users)
    .where(where)
    .orderBy(asc(users.displayName), asc(users.email), asc(users.id))
    .limit(limit)
    .offset(offset);
  return rows.map((row) => ({ ...row, deptId: row.deptId ?? null }));
}

export async function getAdminUser(tenantId: string, id: string): Promise<AdminUserDto | null> {
  if (resolveDatabaseConfig().dialect === "mysql") {
    return mysqlUsersRepo.getAdminUser(tenantId, id);
  }
  const db = getIamDb();
  const row = await db
    .select()
    .from(users)
    .where(
      and(
        eq(users.tenantId, tenantId),
        eq(users.id, id),
        eq(users.isDeleted, false),
        isNull(users.deletedAt)
      )
    )
    .limit(1);
  if (!row[0]) return null;
  return toDto(row[0]);
}

function isActiveUserRow(row: typeof users.$inferSelect): boolean {
  return !row.isDeleted && row.deletedAt == null;
}

async function findUserRowByTenantEmail(
  dbOrTx: IamDb,
  tenantId: string,
  email: string
): Promise<typeof users.$inferSelect | null> {
  const row = await dbOrTx
    .select()
    .from(users)
    .where(and(eq(users.tenantId, tenantId), eq(users.email, email)))
    .limit(1);
  return row[0] ?? null;
}

function buildNewUserFields(input: {
  displayName: string;
  deptId?: string | null;
  status?: AdminUserStatus;
  phone?: string | null;
  employeeNo?: string | null;
  jobTitle?: string | null;
  passwordHash: string;
  mustChangePassword?: boolean;
}): Omit<typeof users.$inferInsert, "id" | "tenantId" | "email" | "createdAt"> & {
  updatedAt: Date;
} {
  const now = new Date();
  const rowStatus: "active" | "disabled" = input.status === "disabled" ? "disabled" : "active";
  return {
    deptId: input.deptId ?? null,
    displayName: input.displayName.trim(),
    passwordHash: input.passwordHash,
    mustChangePassword: input.mustChangePassword ?? false,
    status: rowStatus,
    phone: input.phone ?? null,
    employeeNo: input.employeeNo ?? null,
    jobTitle: input.jobTitle ?? null,
    failedLoginCount: 0,
    lockedUntil: null,
    isDeleted: false,
    deletedAt: null,
    updatedAt: now,
  };
}

/** Serialize authorization mutations for one tenant before last-admin checks. */
async function lockTenantRow(db: IamDb, tenantId: string): Promise<void> {
  await db.execute(sql`select id from tenants where id = ${tenantId} for update`);
}

async function lockActorForUserMutation(
  tx: IamDb,
  tenantId: string,
  actorUserId: string | null | undefined,
  snapshot: GrantabilitySnapshot | undefined,
): Promise<string | null> {
  if (!actorUserId) return null;
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
      eq(principals.tenantId, tenantId),
      eq(principals.kind, "user"),
      eq(principals.userId, actorUserId),
    ))
    .for("update")
    .limit(1);
  const actor = actorRows[0];
  if (!actor || actor.kind !== "user" || actor.userId !== actorUserId || actor.status !== "active") {
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
    .where(and(eq(users.tenantId, tenantId), eq(users.id, actorUserId)))
    .for("update")
    .limit(1);
  const user = userRows[0];
  if (!user || user.status !== "active" || user.isDeleted || user.deletedAt !== null) {
    throw new Error("actor principal is disabled or missing");
  }
  return actor.id;
}

async function replaceUserRoles(
  input: {
    tenantId: string;
    userId: string;
    roleIds: string[];
    defaultOrgId: string | null;
    defaultDeptId: string | null;
  },
  dbOrTx: IamDb = getIamDb(),
  inTransaction = false,
  authorizationSnapshot?: GrantabilitySnapshot,
): Promise<void> {
  const apply = async (db: IamDb): Promise<void> => {
    await lockTenantRow(db, input.tenantId);
    const explicitBinding = await db
      .select({ id: principalRoleBindings.id })
      .from(principalRoleBindings)
      .innerJoin(
        principals,
        and(eq(principals.id, principalRoleBindings.principalId), eq(principals.tenantId, principalRoleBindings.tenantId)),
      )
      .where(and(
        eq(principalRoleBindings.tenantId, input.tenantId),
        eq(principals.kind, "user"),
        eq(principals.userId, input.userId),
        eq(principalRoleBindings.source, "explicit"),
      ))
      .for("update")
      .limit(1);
    if (explicitBinding[0]) {
      throw new Error("explicit bindings require the principal binding service");
    }
    if (authorizationSnapshot?.roleSnapshots.length) {
      const roleIds = authorizationSnapshot.roleSnapshots.map((role) => role.roleId);
      const lockedRoles = await db
        .select({ roleId: roles.id, roleCode: roles.code, scopes: roles.scopes })
        .from(roles)
        .where(and(eq(roles.tenantId, input.tenantId), inArray(roles.id, roleIds)))
        .orderBy(asc(roles.id))
        .for("update");
      const actual = lockedRoles.map((role) => ({
        roleId: role.roleId,
        roleCode: role.roleCode,
        scopes: expandRoleScopes(Array.isArray(role.scopes) ? role.scopes.filter((value): value is string => typeof value === "string") : []),
      }));
      if (!roleCodeSnapshotsMatch(authorizationSnapshot.roleSnapshots, actual)) {
        throw new Error("authorization context is stale");
      }
    }
    const [currentSuperAdmin] = await db
      .select({ id: userRoles.roleId })
      .from(userRoles)
      .innerJoin(roles, and(eq(roles.id, userRoles.roleId), eq(roles.tenantId, userRoles.tenantId)))
      .where(and(eq(userRoles.tenantId, input.tenantId), eq(userRoles.userId, input.userId), eq(roles.code, "super_admin")))
      .limit(1);
    const nextSuperAdmin = input.roleIds.length
      ? await db
        .select({ id: roles.id })
        .from(roles)
        .where(and(eq(roles.tenantId, input.tenantId), eq(roles.code, "super_admin"), inArray(roles.id, input.roleIds)))
        .limit(1)
      : [];
    if (currentSuperAdmin && !nextSuperAdmin[0] && await getPrincipalRepository().countActiveUsersWithRole(input.tenantId, "super_admin") <= 1) {
      throw new Error("last_superadmin_protected");
    }
    await db.delete(userRoles).where(and(eq(userRoles.tenantId, input.tenantId), eq(userRoles.userId, input.userId)));
    const now = new Date();
    for (const roleId of input.roleIds) {
      await db.insert(userRoles).values({
        tenantId: input.tenantId,
        userId: input.userId,
        roleId,
        scopeOrgId: input.defaultOrgId,
        scopeDeptId: input.defaultDeptId,
        createdAt: now,
        updatedAt: now,
      });
    }
  };
  if (inTransaction) {
    await apply(dbOrTx);
  } else {
    await dbOrTx.transaction((tx) => apply(tx));
  }
}

export async function createAdminUser(input: {
  tenantId: string;
  email: string;
  displayName: string;
  deptId?: string | null;
  status?: AdminUserStatus;
  phone?: string | null;
  employeeNo?: string | null;
  jobTitle?: string | null;
  roleCodes?: string[];
  initialPassword?: string | null;
  defaultOrgId: string | null;
  actorUserId?: string | null;
}): Promise<{ user: AdminUserDto; initialPassword: string }> {
  if (resolveDatabaseConfig().dialect === "mysql") {
    return mysqlUsersRepo.createAdminUser(input);
  }
  const db = getIamDb();
  const email = input.email.trim().toLowerCase();
  if (!email) throw new Error("email is required");

  const existing = await findUserRowByTenantEmail(db, input.tenantId, email);
  if (existing && isActiveUserRow(existing)) {
    throw new Error("email already exists");
  }

  const suppliedInitialPassword = input.initialPassword?.trim();
  const initialPassword = suppliedInitialPassword || generateInitialPassword();
  const mustChangePassword = !suppliedInitialPassword;
  const passwordHash = await hashPassword(initialPassword);
  const now = new Date();
  const userFields = buildNewUserFields({
    displayName: input.displayName,
    deptId: input.deptId,
    status: input.status,
    phone: input.phone,
    employeeNo: input.employeeNo,
    jobTitle: input.jobTitle,
    passwordHash,
    mustChangePassword,
  });
  const codes = input.roleCodes?.length ? input.roleCodes : ["member"];
  const id = existing?.id ?? ulid();
  // A new user has no row yet.  The guard still evaluates the complete role
  // intent, while the transaction below locks the actor and creates the
  // target before persisting any role/principal state.
  const snapshot = input.actorUserId && codes.some((code) => code.trim().toLowerCase() !== "member")
    ? await assertUserRoleCodesGrantable({
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      targetUserId: id,
      targetMayBeNew: true,
      roleCodes: elevatedRoleCodes(codes),
      defaultOrgId: input.defaultOrgId,
      defaultDeptId: input.deptId ?? null,
    })
    : undefined;
  let restored = false;
  let actorPrincipalId: string | null = null;
  await db.transaction(async (tx) => {
    await lockTenantRow(tx, input.tenantId);
    const lockedExisting = await findUserRowByTenantEmail(tx, input.tenantId, email);
    if (lockedExisting && isActiveUserRow(lockedExisting)) {
      throw new Error("email already exists");
    }
    if (lockedExisting) {
      if (lockedExisting.id !== id) throw new Error("email already exists");
      restored = true;
      await tx
        .update(users)
        .set(userFields)
        .where(and(eq(users.tenantId, input.tenantId), eq(users.id, id)));
    } else {
      await tx.insert(users).values({
        id,
        tenantId: input.tenantId,
        email,
        createdAt: now,
        ...userFields,
      });
    }

    actorPrincipalId = await lockActorForUserMutation(tx, input.tenantId, input.actorUserId, snapshot);
    const roleRows = codes.length
      ? await tx.select({ id: roles.id, code: roles.code }).from(roles).where(and(eq(roles.tenantId, input.tenantId), inArray(roles.code, codes)))
      : [];
    const roleByCode = new Map(roleRows.map((role) => [role.code, role.id]));
    const roleIds = codes.map((code) => roleByCode.get(code)).filter((roleId): roleId is string => Boolean(roleId));
    if (roleIds.length === 0) {
      const memberRows = await tx.select({ id: roles.id }).from(roles).where(and(eq(roles.tenantId, input.tenantId), eq(roles.code, "member"))).limit(1);
      if (memberRows[0]) roleIds.push(memberRows[0].id);
    }
    await replaceUserRoles({
      tenantId: input.tenantId,
      userId: id,
      roleIds,
      defaultOrgId: input.defaultOrgId,
      defaultDeptId: input.deptId ?? null,
    }, tx, true, snapshot);
    await getPrincipalRepository().syncUserRoleCodes({
      tenantId: input.tenantId,
      userId: id,
      roleCodes: codes,
      defaultOrgId: input.defaultOrgId,
      defaultDeptId: input.deptId ?? null,
    }, tx);

    await insertAuditEvent({
      tenantId: input.tenantId,
      actorUserId: input.actorUserId ?? null,
      actorPrincipalId,
      eventType: restored ? "iam.user.restore" : "iam.user.create",
      targetKind: "user",
      targetId: id,
      detail: { email, roleCodes: codes, restored },
    }, tx);
  });

  const user = await getAdminUser(input.tenantId, id);
  return { user: user!, initialPassword };
}

export type UpdateAdminUserInput = {
  email?: string;
  displayName?: string;
  deptId?: string | null;
  status?: AdminUserStatus;
  phone?: string | null;
  employeeNo?: string | null;
  jobTitle?: string | null;
  roleCodes?: string[];
};

export async function updateAdminUser(
  tenantId: string,
  id: string,
  patch: UpdateAdminUserInput,
  ctx: { actorUserId?: string | null; defaultOrgId: string | null }
): Promise<AdminUserDto> {
  if (resolveDatabaseConfig().dialect === "mysql") {
    return mysqlUsersRepo.updateAdminUser(tenantId, id, patch, ctx);
  }
  const db = getIamDb();
  const row = await db
    .select()
    .from(users)
    .where(and(eq(users.tenantId, tenantId), eq(users.id, id), eq(users.isDeleted, false), isNull(users.deletedAt)))
    .limit(1);
  if (!row[0]) throw new Error("user not found");

  const now = new Date();
  const next: Partial<typeof users.$inferInsert> = { updatedAt: now };
  if (patch.email !== undefined) {
    const email = normalizeAdminEmail(patch.email);
    next.email = email;
  }
  if (patch.displayName !== undefined) next.displayName = patch.displayName.trim();
  if (patch.deptId !== undefined) next.deptId = patch.deptId;
  if (patch.phone !== undefined) next.phone = patch.phone;
  if (patch.employeeNo !== undefined) next.employeeNo = patch.employeeNo;
  if (patch.jobTitle !== undefined) next.jobTitle = patch.jobTitle;
  if (patch.status !== undefined) {
    next.status = patch.status === "locked" ? "locked" : patch.status;
    if (patch.status === "active") {
      next.lockedUntil = null;
      next.failedLoginCount = 0;
    }
    if (patch.status !== "locked") {
      next.lockedUntil = null;
    }
  }

  const deptId = patch.deptId !== undefined ? patch.deptId : row[0].deptId;
  const roleSnapshot = patch.roleCodes && ctx.actorUserId
    ? await assertUserRoleCodesGrantable({
      tenantId,
      actorUserId: ctx.actorUserId,
      targetUserId: id,
      roleCodes: patch.roleCodes,
      defaultOrgId: ctx.defaultOrgId,
      defaultDeptId: deptId ?? null,
    })
    : undefined;
  let actorPrincipalId: string | null = null;
  await db.transaction(async (tx) => {
    // All user, legacy role, principal projection and audit writes share one
    // transaction.  The tenant lock is the common first lock for role and
    // binding mutations, while the actor snapshot is checked after locking.
    await lockTenantRow(tx, tenantId);
    actorPrincipalId = await lockActorForUserMutation(tx, tenantId, ctx.actorUserId, roleSnapshot);
    const lockedTarget = await tx
      .select()
      .from(users)
      .where(and(eq(users.tenantId, tenantId), eq(users.id, id), eq(users.isDeleted, false), isNull(users.deletedAt)))
      .for("update")
      .limit(1);
    if (!lockedTarget[0]) throw new Error("user not found");
    if (next.email && next.email !== lockedTarget[0].email) {
      const duplicate = await findUserRowByTenantEmail(tx, tenantId, next.email);
      if (duplicate && duplicate.id !== id && isActiveUserRow(duplicate)) {
        throw new Error("email already exists");
      }
    }
    if (patch.status !== undefined && patch.status !== "active") {
      await assertUserDeletionSafe({ tenantId, userId: id });
    }
    await tx.update(users).set(next).where(and(eq(users.tenantId, tenantId), eq(users.id, id)));

    if (patch.roleCodes) {
      const idMap = await resolveRoleIdsFromCodes(tenantId, patch.roleCodes, tx);
      const roleIds = patch.roleCodes.map((c) => idMap.get(c)).filter((x): x is string => Boolean(x));
      await replaceUserRoles({
        tenantId,
        userId: id,
        roleIds,
        defaultOrgId: ctx.defaultOrgId,
        defaultDeptId: deptId ?? null,
      }, tx, true, roleSnapshot);
      await getPrincipalRepository().syncUserRoleCodes({
        tenantId,
        userId: id,
        roleCodes: patch.roleCodes,
        defaultOrgId: ctx.defaultOrgId,
        defaultDeptId: deptId ?? null,
      }, tx);
    }

    await insertAuditEvent({
      tenantId,
      actorUserId: ctx.actorUserId ?? null,
      actorPrincipalId,
      eventType: "iam.user.update",
      targetKind: "user",
      targetId: id,
      detail: patch as Record<string, unknown>,
    }, tx);
  });

  return (await getAdminUser(tenantId, id))!;
}

export async function softDeleteUser(
  tenantId: string,
  id: string,
  actorUserId?: string | null
): Promise<void> {
  if (actorUserId && actorUserId === id) throw new Error("不能删除当前登录用户");
  if (resolveDatabaseConfig().dialect === "mysql") {
    return mysqlUsersRepo.softDeleteUser(tenantId, id, actorUserId);
  }
  const db = getIamDb();
  const { roleCodes } = await getUserRolesDetail(tenantId, id);
  let row: { email: string; displayName: string } | undefined;

  // Keep the soft-delete and both model aliases in one transaction. The user
  // row lock also serializes email reuse and concurrent model writes: a new
  // member cannot observe the old email alias until this cleanup commits.
  await db.transaction(async (tx) => {
    await lockTenantRow(tx, tenantId);
    await assertUserDeletionSafe({ tenantId, userId: id });
    // Serialize destructive authorization changes per tenant.  The last
    // super-admin check is repeated after this lock, because a preflight check
    // alone allows two concurrent demotions/deletions to both pass.
    const rows = await tx
      .select({ email: users.email, displayName: users.displayName })
      .from(users)
      .where(and(eq(users.tenantId, tenantId), eq(users.id, id), eq(users.isDeleted, false), isNull(users.deletedAt)))
      .for("update")
      .limit(1);
    row = rows[0];

    const now = new Date();
    await tx
      .update(users)
      .set({ isDeleted: true, deletedAt: now, updatedAt: now })
      .where(and(eq(users.tenantId, tenantId), eq(users.id, id)));

    await tx.delete(userRoles).where(and(eq(userRoles.tenantId, tenantId), eq(userRoles.userId, id)));

    const assignmentKeys = [id];
    const normalizedEmail = row?.email.trim().toLowerCase();
    if (normalizedEmail) assignmentKeys.push(`email:${normalizedEmail}`);
    await tx
      .delete(enterpriseRuntimeUserVisibleModels)
      .where(
        and(
          eq(enterpriseRuntimeUserVisibleModels.tenantId, tenantId),
          inArray(enterpriseRuntimeUserVisibleModels.assignmentKey, assignmentKeys),
        ),
      );
  });

  await insertAuditEvent({
    tenantId,
    actorUserId: actorUserId ?? null,
    eventType: "iam.user.delete",
    targetKind: "user",
    targetId: id,
    detail: {
      email: row?.email,
      displayName: row?.displayName,
      roleCodes,
    },
  });
}

export async function resetUserPassword(input: {
  tenantId: string;
  userId: string;
  actorUserId?: string | null;
}): Promise<{ initialPassword: string }> {
  if (resolveDatabaseConfig().dialect === "mysql") {
    return mysqlUsersRepo.resetUserPassword(input);
  }
  const initialPassword = generateInitialPassword();
  const passwordHash = await hashPassword(initialPassword);
  const db = getIamDb();
  await db
    .update(users)
    .set({
      passwordHash,
      mustChangePassword: true,
      lockedUntil: null,
      failedLoginCount: 0,
      status: "active",
      updatedAt: new Date(),
    })
    .where(and(eq(users.tenantId, input.tenantId), eq(users.id, input.userId), eq(users.isDeleted, false)));

  await insertAuditEvent({
    tenantId: input.tenantId,
    actorUserId: input.actorUserId ?? null,
    eventType: "iam.user.reset_password",
    targetKind: "user",
    targetId: input.userId,
  });

  return { initialPassword };
}

export async function updatePasswordAndClearRequirementPg(
  tenantId: string,
  email: string,
  passwordHash: string,
): Promise<AuthUser | null> {
  if (resolveDatabaseConfig().dialect === "mysql") {
    return mysqlUsersRepo.updatePasswordAndClearRequirement(tenantId, email, passwordHash);
  }
  const db = getIamDb();
  await db
    .update(users)
    .set({
      passwordHash,
      mustChangePassword: false,
      failedLoginCount: 0,
      lockedUntil: null,
      status: "active",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(users.tenantId, tenantId),
        eq(users.email, email.toLowerCase()),
        eq(users.isDeleted, false),
        isNull(users.deletedAt),
      ),
    );
  return loadAuthUserByEmail(tenantId, email);
}

/**
 * Upsert 用户行（portal 同步 / dev bootstrap）；不自动分配角色（由调用方处理）。
 */
export async function upsertUserRowFromAuthUser(user: AuthUser): Promise<void> {
  if (resolveDatabaseConfig().dialect === "mysql") {
    return mysqlUsersRepo.upsertUserRowFromAuthUser(user);
  }
  const db = getIamDb();
  const now = new Date();
  await db.transaction(async (tx) => {
    await lockTenantRow(tx, user.tenantId);
    await tx
      .insert(users)
      .values({
        id: user.id,
        tenantId: user.tenantId,
        deptId: user.deptId ?? null,
        email: user.email.toLowerCase(),
        displayName: user.displayName,
        passwordHash: user.passwordHash,
        mustChangePassword: user.mustChangePassword,
        status: user.status === "locked" ? "active" : user.status,
        failedLoginCount: user.failedLoginCount ?? 0,
        lockedUntil: user.lockedUntil ? new Date(user.lockedUntil) : null,
        isDeleted: false,
        deletedAt: null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: users.id,
        set: {
          email: user.email.toLowerCase(),
          displayName: user.displayName,
          passwordHash: user.passwordHash,
          mustChangePassword: user.mustChangePassword,
          deptId: user.deptId ?? null,
          status: user.status === "locked" ? "active" : user.status,
          failedLoginCount: user.failedLoginCount ?? 0,
          lockedUntil: user.lockedUntil ? new Date(user.lockedUntil) : null,
          isDeleted: false,
          deletedAt: null,
          updatedAt: now,
        },
      });
  });
}

export async function assignRolesIfNone(input: {
  tenantId: string;
  userId: string;
  roleCodes: string[];
  defaultOrgId: string | null;
  defaultDeptId: string | null;
}): Promise<void> {
  if (resolveDatabaseConfig().dialect === "mysql") {
    return mysqlUsersRepo.assignRolesIfNone(input);
  }
  const db = getIamDb();
  const existing = await db
    .select({ r: userRoles.roleId })
    .from(userRoles)
    .where(and(eq(userRoles.tenantId, input.tenantId), eq(userRoles.userId, input.userId)))
    .limit(1);
  if (existing[0]) return;
  const idMap = await resolveRoleIdsFromCodes(input.tenantId, input.roleCodes);
  const roleIds = input.roleCodes.map((c) => idMap.get(c)).filter((x): x is string => Boolean(x));
  if (!roleIds.length) return;
  await replaceUserRoles({
    tenantId: input.tenantId,
    userId: input.userId,
    roleIds,
    defaultOrgId: input.defaultOrgId,
    defaultDeptId: input.defaultDeptId,
  });
  await getPrincipalRepository().syncUserRoleCodes(input);
}

/** 批量导入等场景：在既有事务内 upsert，与部门路径创建共用同一事务 */
export async function upsertUserByEmailInTx(
  tx: IamDb,
  input: {
    tenantId: string;
    email: string;
    displayName: string;
    deptId: string | null;
    phone?: string | null;
    employeeNo?: string | null;
    jobTitle?: string | null;
    passwordHash: string;
    mustChangePassword?: boolean;
    status?: AdminUserStatus;
    roleCodes: string[];
    defaultOrgId: string | null;
    actorUserId?: string | null;
  },
  authorizationSnapshot?: GrantabilitySnapshot,
): Promise<string> {
  const email = input.email.trim().toLowerCase();
  await lockTenantRow(tx, input.tenantId);
  const existingRows = await tx
    .select()
    .from(users)
    .where(and(eq(users.tenantId, input.tenantId), eq(users.email, email)))
    .for("update")
    .limit(1);
  const existing = existingRows[0] ?? null;

  const now = new Date();
  let userId: string;

  if (existing && isActiveUserRow(existing)) {
    userId = existing.id;
    await tx
      .update(users)
      .set({
        displayName: input.displayName.trim(),
        deptId: input.deptId,
        phone: input.phone ?? null,
        employeeNo: input.employeeNo ?? null,
        jobTitle: input.jobTitle ?? null,
        passwordHash: input.passwordHash,
        mustChangePassword: input.mustChangePassword ?? existing.mustChangePassword,
        status: input.status && input.status !== "locked" ? input.status : existing.status,
        updatedAt: now,
      })
      .where(and(eq(users.tenantId, input.tenantId), eq(users.id, userId)));
  } else if (existing) {
    userId = existing.id;
    await tx
      .update(users)
      .set({
        ...buildNewUserFields({
          displayName: input.displayName,
          deptId: input.deptId,
          status: input.status,
          phone: input.phone,
          employeeNo: input.employeeNo,
          jobTitle: input.jobTitle,
          passwordHash: input.passwordHash,
          mustChangePassword: input.mustChangePassword,
        }),
      })
      .where(and(eq(users.tenantId, input.tenantId), eq(users.id, userId)));
  } else {
    userId = ulid();
    await tx.insert(users).values({
      id: userId,
      tenantId: input.tenantId,
      deptId: input.deptId,
      email,
      displayName: input.displayName.trim(),
      passwordHash: input.passwordHash,
      mustChangePassword: input.mustChangePassword ?? false,
      status: input.status && input.status !== "locked" ? input.status! : "active",
      phone: input.phone ?? null,
      employeeNo: input.employeeNo ?? null,
      jobTitle: input.jobTitle ?? null,
      failedLoginCount: 0,
      lockedUntil: null,
      isDeleted: false,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  const actorPrincipalId = await lockActorForUserMutation(
    tx,
    input.tenantId,
    input.actorUserId,
    authorizationSnapshot,
  );

  const idMap = await resolveRoleIdsFromCodes(input.tenantId, input.roleCodes, tx);
  const roleIds = input.roleCodes.map((c) => idMap.get(c)).filter((x): x is string => Boolean(x));
  await replaceUserRoles(
    {
      tenantId: input.tenantId,
      userId,
      roleIds,
      defaultOrgId: input.defaultOrgId,
      defaultDeptId: input.deptId,
    },
    tx,
    true,
    authorizationSnapshot,
  );

  await getPrincipalRepository().syncUserRoleCodes({
    tenantId: input.tenantId,
    userId,
    roleCodes: input.roleCodes,
    defaultOrgId: input.defaultOrgId,
    defaultDeptId: input.deptId,
  }, tx);

  await insertAuditEvent(
    {
      tenantId: input.tenantId,
      actorUserId: input.actorUserId ?? null,
      actorPrincipalId,
      eventType: "iam.bulk_import.user_upsert",
      targetKind: "user",
      targetId: userId,
      detail: { email },
    },
    tx
  );

  return userId;
}

/** 批量导入：按 email 幂等 upsert（存在则更新基础字段与密码可选） */
export async function upsertUserByEmail(input: {
  tenantId: string;
  email: string;
  displayName: string;
  deptId: string | null;
  phone?: string | null;
  employeeNo?: string | null;
  jobTitle?: string | null;
  passwordHash: string;
  mustChangePassword?: boolean;
  status?: AdminUserStatus;
  roleCodes: string[];
  defaultOrgId: string | null;
  actorUserId?: string | null;
}): Promise<AdminUserDto> {
  if (resolveDatabaseConfig().dialect === "mysql") {
    return mysqlUsersRepo.upsertUserByEmail(input);
  }
  const db = getIamDb();
  const email = input.email.trim().toLowerCase();
  const existing = await findUserRowByTenantEmail(db, input.tenantId, email);
  const authorizationSnapshot = input.actorUserId && input.roleCodes.some((code) => code.trim().toLowerCase() !== "member")
    ? await assertUserRoleCodesGrantable({
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      targetUserId: existing?.id ?? ulid(),
      targetMayBeNew: !existing,
      roleCodes: elevatedRoleCodes(input.roleCodes),
      defaultOrgId: input.defaultOrgId,
      defaultDeptId: input.deptId,
    })
    : undefined;
  let userId = "";
  await db.transaction(async (tx) => {
    userId = await upsertUserByEmailInTx(tx, input, authorizationSnapshot);
  });
  return (await getAdminUser(input.tenantId, userId))!;
}

export async function replaceUserRoleAssignments(input: {
  tenantId: string;
  userId: string;
  roleCodes: string[];
  defaultOrgId: string | null;
  defaultDeptId: string | null;
  actorUserId?: string | null;
}): Promise<void> {
  if (resolveDatabaseConfig().dialect === "mysql") {
    return mysqlUsersRepo.replaceUserRoleAssignments(input);
  }
  const db = getIamDb();
  const authorizationSnapshot = input.actorUserId
    ? await assertUserRoleCodesGrantable({
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      targetUserId: input.userId,
      roleCodes: input.roleCodes,
      defaultOrgId: input.defaultOrgId,
      defaultDeptId: input.defaultDeptId,
    })
    : undefined;
  let actorPrincipalId: string | null = null;
  await db.transaction(async (tx) => {
    await lockTenantRow(tx, input.tenantId);
    actorPrincipalId = await lockActorForUserMutation(tx, input.tenantId, input.actorUserId, authorizationSnapshot);
    const lockedTarget = await tx
      .select({ id: users.id, status: users.status, isDeleted: users.isDeleted, deletedAt: users.deletedAt })
      .from(users)
      .where(and(eq(users.tenantId, input.tenantId), eq(users.id, input.userId)))
      .for("update")
      .limit(1);
    const target = lockedTarget[0];
    if (!target || target.status !== "active" || target.isDeleted || target.deletedAt !== null) {
      throw new Error("user not found");
    }
    const idMap = await resolveRoleIdsFromCodes(input.tenantId, input.roleCodes, tx);
    const roleIds = input.roleCodes.map((c) => idMap.get(c)).filter((x): x is string => Boolean(x));
    await replaceUserRoles({
      tenantId: input.tenantId,
      userId: input.userId,
      roleIds,
      defaultOrgId: input.defaultOrgId,
      defaultDeptId: input.defaultDeptId,
      }, tx, true, authorizationSnapshot);
    await getPrincipalRepository().syncUserRoleCodes(input, tx);
    await insertAuditEvent({
      tenantId: input.tenantId,
      actorUserId: input.actorUserId ?? null,
      actorPrincipalId,
      eventType: "iam.user.role_assignments.replace",
      targetKind: "user",
      targetId: input.userId,
      detail: { roleCodes: input.roleCodes },
    }, tx);
  });
}

const usersRepositoryMethods = {
  loadAuthUserByEmail,
  updateFailedLogin: updateFailedLoginPg,
  resetFailedLogin: resetFailedLoginPg,
  updatePasswordAndClearRequirement: updatePasswordAndClearRequirementPg,
  listAdminUsers,
  listAudienceUsers,
  getAdminUser,
  createAdminUser,
  updateAdminUser,
  softDeleteUser,
  resetUserPassword,
  upsertUserRowFromAuthUser,
  assignRolesIfNone,
  upsertUserByEmail,
  replaceUserRoleAssignments,
};

const postgresqlUsersRepository: UsersRepository = {
  dialect: "postgresql",
  ...usersRepositoryMethods,
};

export function getUsersRepository(): UsersRepository {
  return resolveDatabaseConfig().dialect === "mysql"
    ? mysqlUsersRepo
    : postgresqlUsersRepository;
}
