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
} from "@agenticx/db-schema/mysql";
import type { MySqlDrizzleDb } from "../../database/mysql";
import type { SQLWrapper } from "drizzle-orm";
import { and, asc, desc, eq, exists, inArray, isNull, like, not, or, sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { ulid } from "ulid";

import type {
  AdminUserDto,
  AdminUserStatus,
  AudienceUserDto,
  ListAudienceUsersFilter,
  ListUsersFilter,
  UpdateAdminUserInput,
} from "../users";
import type { UsersRepository } from "../contracts";
import { insertMysqlAuditEvent } from "./audit";
import { getMysqlRepositoryDb } from "./db";
import { getMysqlUserRolesDetail, mysqlRolesRepository } from "./roles";
import { assertUserDeletionSafe, assertUserRoleCodesGrantable } from "../../authorization/grantability";
import { getPrincipalRepository } from "../../authorization/repository";
import { roleCodeSnapshotsMatch } from "../../authorization/types";
import type { GrantabilitySnapshot } from "../../authorization/types";
import { expandRoleScopes, mergeUserScopes } from "../../scope-registry";
import { mysqlPrincipalsRepository } from "./principals";

function ilike(col: SQLWrapper, pattern: string) {
  return sql`lower(${col}) like lower(${pattern})`;
}

function mapDbStatus(row: typeof users.$inferSelect): AdminUserStatus {
  const lockedUntil = row.lockedUntil?.getTime() ?? 0;
  if (lockedUntil > Date.now()) return "locked";
  if (row.status === "disabled") return "disabled";
  return row.status === "locked" ? "locked" : "active";
}

type UserRoleDetail = { scopes: string[]; roleCodes: string[] };

async function roleDetailFromDb(tenantId: string, userId: string, db: MySqlDrizzleDb): Promise<UserRoleDetail> {
  const roleRows = await db
    .select({ scopes: roles.scopes, code: roles.code })
    .from(userRoles)
    .innerJoin(roles, and(eq(roles.id, userRoles.roleId), eq(roles.tenantId, userRoles.tenantId)))
    .where(and(eq(userRoles.tenantId, tenantId), eq(userRoles.userId, userId)));
  return {
    roleCodes: roleRows.map((row) => row.code),
    scopes: mergeUserScopes(roleRows.map((row) =>
      Array.isArray(row.scopes) ? row.scopes.filter((value): value is string => typeof value === "string") : [])),
  };
}

async function toDto(row: typeof users.$inferSelect, roleDetail?: UserRoleDetail): Promise<AdminUserDto> {
  const { scopes, roleCodes } = roleDetail ?? await getMysqlUserRolesDetail(row.tenantId, row.id);
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

async function listDepartmentSubtreeIdsLocal(tenantId: string, deptId: string): Promise<string[]> {
  const db = await getMysqlRepositoryDb();
  const [self] = await db
    .select({ path: departments.path })
    .from(departments)
    .where(and(eq(departments.tenantId, tenantId), eq(departments.id, deptId)))
    .limit(1);
  if (!self) return [];
  const rows = await db
    .select({ id: departments.id })
    .from(departments)
    .where(and(eq(departments.tenantId, tenantId), like(departments.path, `${self.path}%`)));
  return rows.map((r) => r.id);
}

function isActiveUserRow(row: typeof users.$inferSelect): boolean {
  return !row.isDeleted && row.deletedAt == null;
}

function normalizeAdminEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("invalid email");
  return email;
}

async function findUserRowByTenantEmail(
  db: MySqlDrizzleDb,
  tenantId: string,
  email: string,
): Promise<typeof users.$inferSelect | null> {
  const [row] = await db
    .select()
    .from(users)
    .where(and(eq(users.tenantId, tenantId), eq(users.email, email)))
    .limit(1);
  return row ?? null;
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

/** Serialize last-admin checks for all authorization mutations in a tenant. */
async function lockTenantRow(db: MySqlDrizzleDb, tenantId: string): Promise<void> {
  await db.execute(sql`select id from tenants where id = ${tenantId} for update`);
}

async function lockActorForUserMutation(
  tx: MySqlDrizzleDb,
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
  db: MySqlDrizzleDb,
  input: {
    tenantId: string;
    userId: string;
    roleIds: string[];
    defaultOrgId: string | null;
    defaultDeptId: string | null;
  },
  inTransaction = false,
  authorizationSnapshot?: GrantabilitySnapshot,
): Promise<void> {
  const apply = async (tx: MySqlDrizzleDb): Promise<void> => {
    await lockTenantRow(tx, input.tenantId);
    const explicitBinding = await tx
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
      const lockedRoles = await tx
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
    const [currentSuperAdmin] = await tx
      .select({ id: userRoles.roleId })
      .from(userRoles)
      .innerJoin(roles, and(eq(roles.id, userRoles.roleId), eq(roles.tenantId, userRoles.tenantId)))
      .where(and(eq(userRoles.tenantId, input.tenantId), eq(userRoles.userId, input.userId), eq(roles.code, "super_admin")))
      .limit(1);
    const nextSuperAdmin = input.roleIds.length
      ? await tx.select({ id: roles.id }).from(roles).where(and(eq(roles.tenantId, input.tenantId), eq(roles.code, "super_admin"), inArray(roles.id, input.roleIds))).limit(1)
      : [];
    if (currentSuperAdmin && !nextSuperAdmin[0] && await getPrincipalRepository().countActiveUsersWithRole(input.tenantId, "super_admin") <= 1) {
      throw new Error("last_superadmin_protected");
    }
    await tx.delete(userRoles).where(and(eq(userRoles.tenantId, input.tenantId), eq(userRoles.userId, input.userId)));
    const now = new Date();
    for (const roleId of input.roleIds) {
      await tx.insert(userRoles).values({
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
  if (inTransaction) await apply(db);
  else await db.transaction((tx) => apply(tx));
}

async function applyUserFilters(
  db: MySqlDrizzleDb,
  tenantId: string,
  filter: ListUsersFilter,
): Promise<ReturnType<typeof and> | undefined> {
  const parts = [
    eq(users.tenantId, tenantId),
    eq(users.isDeleted, false),
    isNull(users.deletedAt),
  ] as const;

  const extra: Parameters<typeof and>[number][] = [];

  if (filter.status) {
    if (filter.status === "locked") {
      extra.push(sql`${users.lockedUntil} is not null and ${users.lockedUntil} > UTC_TIMESTAMP(6)`);
    } else if (filter.status === "disabled") {
      extra.push(eq(users.status, "disabled"));
    } else if (filter.status === "active") {
      extra.push(
        and(
          eq(users.status, "active"),
          or(isNull(users.lockedUntil), sql`${users.lockedUntil} <= UTC_TIMESTAMP(6)`),
        )!,
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
        ilike(sql`coalesce(${users.phone}, '')`, pattern),
      )!,
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
          sql`(${principalRoleBindings.expiresAt} is null or ${principalRoleBindings.expiresAt} > UTC_TIMESTAMP(6))`,
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

async function getAdminUserInternal(tenantId: string, id: string, dbOrTx?: unknown): Promise<AdminUserDto | null> {
  const db = (dbOrTx as MySqlDrizzleDb | undefined) ?? (await getMysqlRepositoryDb());
  const [row] = await db
    .select()
    .from(users)
    .where(
      and(
        eq(users.tenantId, tenantId),
        eq(users.id, id),
        eq(users.isDeleted, false),
        isNull(users.deletedAt),
      ),
    )
    .limit(1);
  if (!row) return null;
  return toDto(row, dbOrTx ? await roleDetailFromDb(tenantId, id, db) : undefined);
}

export const mysqlUsersRepository: UsersRepository = {
  dialect: "mysql",
  async transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
    const db = await getMysqlRepositoryDb();
    return db.transaction((tx) => fn(tx));
  },
  async loadAuthUserByEmail(tenantId, email) {
    const db = await getMysqlRepositoryDb();
    const [row] = await db
      .select()
      .from(users)
      .where(
        and(
          eq(users.tenantId, tenantId),
          eq(users.email, email.toLowerCase()),
          eq(users.isDeleted, false),
          isNull(users.deletedAt),
        ),
      )
      .limit(1);
    if (!row) return null;
    const { scopes } = await getMysqlUserRolesDetail(tenantId, row.id);
    const lockedUntil = row.lockedUntil?.getTime() ?? null;
    return {
      id: row.id,
      tenantId: row.tenantId,
      deptId: row.deptId,
      email: row.email.toLowerCase(),
      displayName: row.displayName,
      passwordHash: row.passwordHash,
      mustChangePassword: row.mustChangePassword,
      status: mapDbStatus(row),
      failedLoginCount: row.failedLoginCount ?? 0,
      lockedUntil,
      scopes,
    };
  },
  async updateFailedLogin(tenantId, email, nextFailedCount, lockedUntilMs) {
    const db = await getMysqlRepositoryDb();
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
  },
  async resetFailedLogin(tenantId, email) {
    const db = await getMysqlRepositoryDb();
    const [row] = await db
      .select({ status: users.status })
      .from(users)
      .where(and(eq(users.tenantId, tenantId), eq(users.email, email.toLowerCase())))
      .limit(1);
    const nextStatus = row?.status === "locked" ? "active" : row?.status ?? "active";
    await db
      .update(users)
      .set({
        failedLoginCount: 0,
        lockedUntil: null,
        status: nextStatus,
        updatedAt: new Date(),
      })
      .where(and(eq(users.tenantId, tenantId), eq(users.email, email.toLowerCase())));
  },
  async listAdminUsers(tenantId, filter = {}) {
    const db = await getMysqlRepositoryDb();
    const where = await applyUserFilters(db, tenantId, filter);
    const limit = Math.max(1, Math.min(200, filter.limit ?? 50));
    const offset = Math.max(0, filter.offset ?? 0);

    const [totalRow] = await db
      .select({ c: sql<number>`cast(count(*) as signed)` })
      .from(users)
      .where(where);
    const total = totalRow?.c ?? 0;

    const rows = await db
      .select()
      .from(users)
      .where(where)
      .orderBy(desc(users.createdAt))
      .limit(limit)
      .offset(offset);

    const items = await Promise.all(rows.map((r) => toDto(r)));
    return { items, total };
  },
  async listAudienceUsers(
    tenantId: string,
    filter: ListAudienceUsersFilter = {},
  ): Promise<AudienceUserDto[]> {
    const db = await getMysqlRepositoryDb();
    const q = filter.q?.trim();
    const search = q
      ? or(ilike(users.displayName, `%${q}%`), ilike(users.email, `%${q}%`))
      : undefined;
    const where = and(
      eq(users.tenantId, tenantId),
      eq(users.isDeleted, false),
      isNull(users.deletedAt),
      eq(users.status, "active"),
      or(isNull(users.lockedUntil), sql`${users.lockedUntil} <= UTC_TIMESTAMP(6)`),
      search,
    );
    const limit = Math.max(1, Math.min(100, filter.limit ?? 50));
    const offset = Math.max(0, filter.offset ?? 0);
    const rows = await db
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
  },
  getAdminUser: getAdminUserInternal,
  async createAdminUser(input) {
    const db = await getMysqlRepositoryDb();
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
    const authorizationSnapshot = input.actorUserId && codes.some((code) => code.trim().toLowerCase() !== "member")
      ? await assertUserRoleCodesGrantable({
        tenantId: input.tenantId,
        actorUserId: input.actorUserId,
        targetUserId: id,
        targetMayBeNew: !existing,
        roleCodes: elevatedRoleCodes(codes),
        defaultOrgId: input.defaultOrgId,
        defaultDeptId: input.deptId ?? null,
      })
      : undefined;
    let restored = false;
    await db.transaction(async (tx) => {
      await lockTenantRow(tx, input.tenantId);
      const lockedRows = await tx
        .select()
        .from(users)
        .where(and(eq(users.tenantId, input.tenantId), eq(users.email, email)))
        .for("update")
        .limit(1);
      const lockedExisting = lockedRows[0] ?? null;
      if (lockedExisting && isActiveUserRow(lockedExisting)) {
        throw new Error("email already exists");
      }
      if (lockedExisting && lockedExisting.id !== id) {
        throw new Error("email already exists");
      }
      if (lockedExisting) {
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

      const actorPrincipalId = await lockActorForUserMutation(tx, input.tenantId, input.actorUserId, authorizationSnapshot);
      const idMap = await mysqlRolesRepository.resolveRoleIdsFromCodes(input.tenantId, codes, tx);
      const roleIds = codes.map((c) => idMap.get(c)).filter((x): x is string => Boolean(x));
      if (roleIds.length === 0) {
        const memberRows = await tx
          .select({ id: roles.id })
          .from(roles)
          .where(and(eq(roles.tenantId, input.tenantId), eq(roles.code, "member")))
          .limit(1);
        if (memberRows[0]) roleIds.push(memberRows[0].id);
      }
      await replaceUserRoles(tx, {
        tenantId: input.tenantId,
        userId: id,
        roleIds,
        defaultOrgId: input.defaultOrgId,
        defaultDeptId: input.deptId ?? null,
      }, true, authorizationSnapshot);
      await getPrincipalRepository().syncUserRoleCodes({
        tenantId: input.tenantId,
        userId: id,
        roleCodes: codes,
        defaultOrgId: input.defaultOrgId,
        defaultDeptId: input.deptId ?? null,
      }, tx);

      await insertMysqlAuditEvent({
        tenantId: input.tenantId,
        actorUserId: input.actorUserId ?? null,
        actorPrincipalId,
        eventType: restored ? "iam.user.restore" : "iam.user.create",
        targetKind: "user",
        targetId: id,
        detail: { email, roleCodes: codes, restored },
      }, tx);
    });

    const user = await getAdminUserInternal(input.tenantId, id);
    if (!user) throw new Error("user create failed");
    return { user, initialPassword };
  },
  async updateAdminUser(tenantId, id, patch, ctx) {
    const db = await getMysqlRepositoryDb();
    const [row] = await db
      .select()
      .from(users)
      .where(
        and(eq(users.tenantId, tenantId), eq(users.id, id), eq(users.isDeleted, false), isNull(users.deletedAt)),
      )
      .limit(1);
    if (!row) throw new Error("user not found");

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

    const deptId = patch.deptId !== undefined ? patch.deptId : row.deptId;
    const authorizationSnapshot = patch.roleCodes && ctx.actorUserId
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
      await lockTenantRow(tx, tenantId);
      actorPrincipalId = await lockActorForUserMutation(tx, tenantId, ctx.actorUserId, authorizationSnapshot);
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
        await assertUserDeletionSafe({ tenantId, userId: id }, mysqlPrincipalsRepository);
      }
      await tx.update(users).set(next).where(and(eq(users.tenantId, tenantId), eq(users.id, id)));

      if (patch.roleCodes) {
        const idMap = await mysqlRolesRepository.resolveRoleIdsFromCodes(tenantId, patch.roleCodes, tx);
        const roleIds = patch.roleCodes.map((c) => idMap.get(c)).filter((x): x is string => Boolean(x));
        await replaceUserRoles(tx, {
          tenantId,
          userId: id,
          roleIds,
          defaultOrgId: ctx.defaultOrgId,
          defaultDeptId: deptId ?? null,
        }, true, authorizationSnapshot);
        await getPrincipalRepository().syncUserRoleCodes({
          tenantId,
          userId: id,
          roleCodes: patch.roleCodes,
          defaultOrgId: ctx.defaultOrgId,
          defaultDeptId: deptId ?? null,
        }, tx);
      }

      await insertMysqlAuditEvent({
        tenantId,
        actorUserId: ctx.actorUserId ?? null,
        actorPrincipalId,
        eventType: "iam.user.update",
        targetKind: "user",
        targetId: id,
        detail: patch as Record<string, unknown>,
      }, tx);
    });

    const updated = await getAdminUserInternal(tenantId, id);
    if (!updated) throw new Error("user update failed");
    return updated;
  },
  async softDeleteUser(tenantId, id, actorUserId) {
    if (actorUserId && actorUserId === id) throw new Error("不能删除当前登录用户");
    const db = await getMysqlRepositoryDb();
    const { roleCodes } = await getMysqlUserRolesDetail(tenantId, id);
    let row: { email: string; displayName: string } | undefined;

    // Keep the soft-delete and both model aliases in one transaction. The
    // user row lock also serializes email reuse and concurrent model writes:
    // a new member cannot observe the old email alias until this cleanup
    // commits.
    await db.transaction(async (tx) => {
      await lockTenantRow(tx, tenantId);
      await assertUserDeletionSafe({ tenantId, userId: id }, mysqlPrincipalsRepository);
      const rows = await tx
        .select({ email: users.email, displayName: users.displayName })
        .from(users)
        .where(
          and(eq(users.tenantId, tenantId), eq(users.id, id), eq(users.isDeleted, false), isNull(users.deletedAt)),
        )
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

    await insertMysqlAuditEvent({
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
  },
  async resetUserPassword(input) {
    const initialPassword = generateInitialPassword();
    const passwordHash = await hashPassword(initialPassword);
    const db = await getMysqlRepositoryDb();
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
      .where(
        and(eq(users.tenantId, input.tenantId), eq(users.id, input.userId), eq(users.isDeleted, false)),
      );

    await insertMysqlAuditEvent({
      tenantId: input.tenantId,
      actorUserId: input.actorUserId ?? null,
      eventType: "iam.user.reset_password",
      targetKind: "user",
      targetId: input.userId,
    });

    return { initialPassword };
  },
  async updatePasswordAndClearRequirement(tenantId, email, passwordHash) {
    const db = await getMysqlRepositoryDb();
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
    return this.loadAuthUserByEmail(tenantId, email);
  },
  async upsertUserRowFromAuthUser(user) {
    const db = await getMysqlRepositoryDb();
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
        .onDuplicateKeyUpdate({
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
  },
  async assignRolesIfNone(input) {
    const db = await getMysqlRepositoryDb();
    const [existing] = await db
      .select({ r: userRoles.roleId })
      .from(userRoles)
      .where(and(eq(userRoles.tenantId, input.tenantId), eq(userRoles.userId, input.userId)))
      .limit(1);
    if (existing) return;
    const idMap = await mysqlRolesRepository.resolveRoleIdsFromCodes(input.tenantId, input.roleCodes);
    const roleIds = input.roleCodes.map((c) => idMap.get(c)).filter((x): x is string => Boolean(x));
    if (!roleIds.length) return;
    await replaceUserRoles(db, {
      tenantId: input.tenantId,
      userId: input.userId,
      roleIds,
      defaultOrgId: input.defaultOrgId,
      defaultDeptId: input.defaultDeptId,
    });
    await getPrincipalRepository().syncUserRoleCodes(input);
  },
  async upsertUserByEmail(input, dbOrTx) {
    const suppliedDb = dbOrTx as MySqlDrizzleDb | undefined;
    const db = suppliedDb ?? (await getMysqlRepositoryDb());
    const email = input.email.trim().toLowerCase();
    const existing = await findUserRowByTenantEmail(db, input.tenantId, email);
    const plannedUserId = existing?.id ?? ulid();
    const authorizationSnapshot = input.actorUserId && input.roleCodes.some((code) => code.trim().toLowerCase() !== "member")
      ? await assertUserRoleCodesGrantable({
        tenantId: input.tenantId,
        actorUserId: input.actorUserId,
        targetUserId: plannedUserId,
        targetMayBeNew: !existing,
        roleCodes: elevatedRoleCodes(input.roleCodes),
        defaultOrgId: input.defaultOrgId,
        defaultDeptId: input.deptId,
      })
      : undefined;
    const now = new Date();
    let userId = plannedUserId;
    let actorPrincipalId: string | null = null;
    const apply = async (tx: MySqlDrizzleDb): Promise<void> => {
      await lockTenantRow(tx, input.tenantId);
      const lockedRows = await tx
        .select()
        .from(users)
        .where(and(eq(users.tenantId, input.tenantId), eq(users.email, email)))
        .for("update")
        .limit(1);
      const lockedExisting = lockedRows[0] ?? null;
      userId = lockedExisting?.id ?? plannedUserId;
      if (lockedExisting && isActiveUserRow(lockedExisting)) {
        await tx
          .update(users)
          .set({
            displayName: input.displayName.trim(),
            deptId: input.deptId,
            phone: input.phone ?? null,
            employeeNo: input.employeeNo ?? null,
            jobTitle: input.jobTitle ?? null,
            passwordHash: input.passwordHash,
            mustChangePassword: input.mustChangePassword ?? lockedExisting.mustChangePassword,
            status: input.status && input.status !== "locked" ? input.status : lockedExisting.status,
            updatedAt: now,
          })
          .where(and(eq(users.tenantId, input.tenantId), eq(users.id, userId)));
      } else if (lockedExisting) {
        await tx
          .update(users)
          .set(
            buildNewUserFields({
              displayName: input.displayName,
              deptId: input.deptId,
              status: input.status,
              phone: input.phone,
              employeeNo: input.employeeNo,
              jobTitle: input.jobTitle,
              passwordHash: input.passwordHash,
              mustChangePassword: input.mustChangePassword,
            }),
          )
          .where(and(eq(users.tenantId, input.tenantId), eq(users.id, userId)));
      } else {
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

      actorPrincipalId = await lockActorForUserMutation(tx, input.tenantId, input.actorUserId, authorizationSnapshot);
      const idMap = await mysqlRolesRepository.resolveRoleIdsFromCodes(input.tenantId, input.roleCodes, tx);
      const roleIds = input.roleCodes.map((c) => idMap.get(c)).filter((x): x is string => Boolean(x));
      await replaceUserRoles(tx, {
        tenantId: input.tenantId,
        userId,
        roleIds,
        defaultOrgId: input.defaultOrgId,
        defaultDeptId: input.deptId,
      }, true, authorizationSnapshot);
      await getPrincipalRepository().syncUserRoleCodes({
        tenantId: input.tenantId,
        userId,
        roleCodes: input.roleCodes,
        defaultOrgId: input.defaultOrgId,
        defaultDeptId: input.deptId,
      }, tx);

      await insertMysqlAuditEvent({
        tenantId: input.tenantId,
        actorUserId: input.actorUserId ?? null,
        actorPrincipalId,
        eventType: "iam.bulk_import.user_upsert",
        targetKind: "user",
        targetId: userId,
        detail: { email },
      }, tx);
    };
    if (suppliedDb) {
      await apply(suppliedDb);
    } else {
      await db.transaction(apply);
    }

    const user = await getAdminUserInternal(input.tenantId, userId, suppliedDb);
    if (!user) throw new Error("user upsert failed");
    return user;
  },
  async replaceUserRoleAssignments(input) {
    const db = await getMysqlRepositoryDb();
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
      const idMap = await mysqlRolesRepository.resolveRoleIdsFromCodes(input.tenantId, input.roleCodes, tx);
      const roleIds = input.roleCodes.map((c) => idMap.get(c)).filter((x): x is string => Boolean(x));
      await replaceUserRoles(tx, {
        tenantId: input.tenantId,
        userId: input.userId,
        roleIds,
        defaultOrgId: input.defaultOrgId,
        defaultDeptId: input.defaultDeptId,
      }, true, authorizationSnapshot);
      await getPrincipalRepository().syncUserRoleCodes(input, tx);
      await insertMysqlAuditEvent({
        tenantId: input.tenantId,
        actorUserId: input.actorUserId ?? null,
        actorPrincipalId,
        eventType: "iam.user.role_assignments.replace",
        targetKind: "user",
        targetId: input.userId,
        detail: { roleCodes: input.roleCodes },
      }, tx);
    });
  },
};
