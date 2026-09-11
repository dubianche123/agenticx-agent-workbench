import { expandRoleScopes, isRegisteredScope } from "../scope-registry";
import { getPrincipalRepository } from "./repository";
import { effectivePermissionsFromBindings, getUserAuthorizationContext } from "./context";
import { roleScopeFingerprint } from "./types";
import type { PrincipalsRepository } from "../repos/principal-contracts";
import type {
  DataScope,
  EffectivePermission,
  GrantabilityInput,
  GrantabilitySnapshot,
  PrincipalDto,
  PrincipalRoleBindingDto,
} from "./types";

export type GrantableRoleOption = {
  id: string;
  code: string;
  scopes: string[];
  immutable: boolean;
  grantable: boolean;
  blockedScopes: string[];
  reason: string | null;
};

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function fail(code: string): never {
  throw new Error(code);
}

function activePermission(permission: EffectivePermission, at = Date.now()): boolean {
  return permission.resolution === "resolved" &&
    (permission.expiresAt === null || new Date(permission.expiresAt).getTime() > at);
}

function sameScope(permission: EffectivePermission, requested: string): boolean {
  return permission.scope === requested;
}

function earliestPermissionExpiry(permissions: EffectivePermission[]): string | null {
  const expiries = permissions
    .map((permission) => permission.expiresAt)
    .filter((value): value is string => Boolean(value))
    .map((value) => ({ value, time: new Date(value).getTime() }))
    .filter(({ time }) => Number.isFinite(time))
    .sort((left, right) => left.time - right.time);
  return expiries[0]?.value ?? null;
}

function validDataScope(value: DataScope | undefined): value is DataScope {
  return value === undefined || value === "self" || value === "department" || value === "department_subtree" || value === "tenant";
}

function requestedExpiryMs(input: GrantabilityInput): number | null {
  if (input.expiresAt === undefined || input.expiresAt === null) return null;
  const value = input.expiresAt instanceof Date ? input.expiresAt.getTime() : new Date(input.expiresAt).getTime();
  if (!Number.isFinite(value) || value <= Date.now()) fail("invalid_expiry");
  return value;
}

function principalOwnerUserId(principal: PrincipalDto | null): string | null {
  if (!principal) return null;
  return principal.kind === "user" ? principal.userId : principal.agentProfile?.ownerUserId ?? null;
}

function principalAuthorityUserId(principal: PrincipalDto | null): string | null {
  if (!principal) return null;
  return principal.kind === "user" ? principal.userId : principal.agentProfile?.ownerUserId ?? null;
}

async function targetOwnerUserId(input: GrantabilityInput): Promise<string | null> {
  const repository = getPrincipalRepository();
  if (input.targetPrincipalId) {
    return principalOwnerUserId(await repository.getPrincipal(input.tenantId, input.targetPrincipalId));
  }
  return input.targetUserId ?? null;
}

async function targetDepartmentId(input: GrantabilityInput, ownerUserId: string | null): Promise<string | null> {
  if (input.dataScope === "department" || input.dataScope === "department_subtree") return input.scopeDeptId ?? null;
  if (input.dataScope !== "self" || !ownerUserId) return null;
  const target = await getPrincipalRepository().resolveAuthorizationTarget(input.tenantId, {
    kind: "user",
    id: ownerUserId,
  });
  return target?.deptId ?? null;
}

async function validateRequestedRange(input: GrantabilityInput): Promise<void> {
  requestedExpiryMs(input);
  if (!validDataScope(input.dataScope)) fail("invalid_data_scope");
  if (input.dataScope === "tenant" || input.dataScope === "self" || input.dataScope === undefined) {
    if (input.scopeDeptId || input.scopeOrgId) fail("invalid_scope_range");
    return;
  }
  if (!input.scopeDeptId) fail("department_scope_required");
  const department = await getPrincipalRepository().resolveAuthorizationTarget(input.tenantId, {
    kind: "department",
    id: input.scopeDeptId,
  });
  if (!department || department.tenantId !== input.tenantId) fail("scope_cross_tenant");
}

/**
 * Test whether an actor permission covers a proposed role binding range.
 * The comparison is deliberately per scope and per range, so a permission
 * for `user:read` in department A cannot combine with `user:update` in B.
 */
async function permissionCoversRange(
  permission: EffectivePermission,
  requestedRange: GrantabilityInput,
  ownerUserId: string | null,
  ignoreRequestedExpiry = false,
  sourceUserId = requestedRange.actorUserId,
): Promise<boolean> {
  const requestedExpiry = ignoreRequestedExpiry ? null : requestedExpiryMs(requestedRange);
  const permissionExpiry = permission.expiresAt === null ? null : new Date(permission.expiresAt).getTime();
  // A grant cannot outlive the actor's own grant.  A null requested expiry is
  // permanent and therefore requires a permanent actor permission.
  if (requestedExpiry === null ? permissionExpiry !== null : (permissionExpiry !== null && permissionExpiry < requestedExpiry)) {
    return false;
  }
  if (permission.dataScope === "tenant") return true;
  const repository = getPrincipalRepository();
  const requested = requestedRange.dataScope;
  // A missing range is never an implicit tenant-wide grant.  Callers that
  // create tenant-scoped metadata must state that range explicitly; legacy
  // roleCodes are expanded to their concrete range before reaching here.
  if (!requested) return false;
  if (requested === "tenant") return false;

  if (requested === "self") {
    if (!ownerUserId) return false;
    if (permission.dataScope === "self") return ownerUserId === sourceUserId;
    const targetDeptId = await targetDepartmentId(requestedRange, ownerUserId);
    if (!targetDeptId || !permission.scopeDeptId) return false;
    return repository.departmentScopeContains(
      requestedRange.tenantId,
      permission.scopeDeptId,
      targetDeptId,
      permission.dataScope === "department_subtree",
    );
  }

  if (!requestedRange.scopeDeptId || !permission.scopeDeptId) return false;
  if (requested === "department") {
    if (permission.dataScope === "department") return permission.scopeDeptId === requestedRange.scopeDeptId;
    if (permission.dataScope === "department_subtree") {
      return repository.departmentScopeContains(
        requestedRange.tenantId,
        permission.scopeDeptId,
        requestedRange.scopeDeptId,
        true,
      );
    }
    return false;
  }
  if (requested === "department_subtree") {
    return permission.dataScope === "department_subtree" && repository.departmentScopeContains(
      requestedRange.tenantId,
      permission.scopeDeptId,
      requestedRange.scopeDeptId,
      true,
    );
  }
  return false;
}

async function actorHasScopes(
  permissions: EffectivePermission[],
  scopes: string[],
  requestedRange: GrantabilityInput,
  ownerUserId: string | null,
  ignoreRequestedExpiry = false,
  sourceUserId = requestedRange.actorUserId,
  requireDelegable = false,
): Promise<string[]> {
  const blocked: string[] = [];
  for (const scope of scopes) {
    let covered = false;
    for (const permission of permissions) {
      if (!activePermission(permission) || !sameScope(permission, scope)) continue;
      if (requireDelegable && !permission.canDelegate) continue;
      if (await permissionCoversRange(permission, requestedRange, ownerUserId, ignoreRequestedExpiry, sourceUserId)) {
        covered = true;
        break;
      }
    }
    if (!covered) blocked.push(scope);
  }
  return blocked;
}

type GrantAuthority = {
  principalId: string | null;
  authzVersion: number;
  permissionExpiresAt: string | null;
  sourceUserId: string | null;
  permissions: EffectivePermission[];
  differsFromActor: boolean;
};

/**
 * Resolve the principal whose resource authority is being used.  The human
 * actor remains the operator, while a different grantor requires an explicit
 * approval reference so a caller cannot self-assert another principal's
 * authority.  The referenced principal is always resolved in this tenant.
 */
async function resolveGrantAuthority(
  input: GrantabilityInput,
  context: Awaited<ReturnType<typeof getUserAuthorizationContext>>,
): Promise<GrantAuthority> {
  const repository = getPrincipalRepository();
  const actorPrincipalId = context.userPrincipal?.id ?? null;
  const requestedGrantorId = input.grantedByPrincipalId?.trim() || actorPrincipalId;
  const differsFromActor = Boolean(requestedGrantorId && requestedGrantorId !== actorPrincipalId);
  const approval = input.grantorApprovalRef;
  if (approval !== undefined && approval !== null && (typeof approval !== "string" || !approval.trim() || approval.trim().length > 160)) {
    fail("invalid_grantor_approval");
  }
  if (differsFromActor && !approval?.trim()) fail("grantor_approval_required");
  if (differsFromActor) {
    if (!input.grantorApprovalVerifier) fail("resource_approval_unverified");
    const verified = await input.grantorApprovalVerifier({
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      grantorPrincipalId: requestedGrantorId!,
      approvalRef: approval!.trim(),
      targetPrincipalId: input.targetPrincipalId ?? null,
      roleId: input.roleId ?? null,
      roleCode: input.roleCode ?? null,
      dataScope: input.dataScope ?? null,
      scopeOrgId: input.scopeOrgId ?? null,
      scopeDeptId: input.scopeDeptId ?? null,
      expiresAt: input.expiresAt instanceof Date
        ? input.expiresAt.toISOString()
        : input.expiresAt ?? null,
      canDelegate: Boolean(input.canDelegate),
    });
    if (!verified) fail("resource_approval_unverified");
  }
  if (!requestedGrantorId || !differsFromActor) {
    return {
      principalId: actorPrincipalId,
      authzVersion: context.userPrincipal?.authzVersion ?? 0,
      permissionExpiresAt: earliestPermissionExpiry(context.effectivePermissions),
      sourceUserId: input.actorUserId,
      permissions: context.effectivePermissions,
      differsFromActor: false,
    };
  }
  const grantor = await repository.getPrincipal(input.tenantId, requestedGrantorId);
  if (!grantor) fail("grantor_missing");
  if (grantor.status !== "active") fail("grantor_inactive");
  const grantorPermissions = effectivePermissionsFromBindings(
    await repository.getPrincipalEffectivePermissions({ tenantId: input.tenantId, principalId: grantor.id }),
  );
  return {
    principalId: grantor.id,
    authzVersion: grantor.authzVersion,
    permissionExpiresAt: earliestPermissionExpiry(grantorPermissions),
    sourceUserId: principalAuthorityUserId(grantor),
    permissions: grantorPermissions,
    differsFromActor: true,
  };
}

async function roleScopesForInput(
  input: GrantabilityInput,
  resolvedRole?: Awaited<ReturnType<PrincipalsRepository["getRoleDefinition"]>>,
): Promise<string[]> {
  const repository = getPrincipalRepository();
  const scopes: string[] = [];
  if (input.roleId || input.roleCode) {
    const definition = resolvedRole ?? await repository.getRoleDefinition(input.tenantId, {
      roleId: input.roleId,
      roleCode: input.roleCode,
    });
    if (!definition) fail("role_not_found");
    scopes.push(...definition.scopes);
  }
  if (input.roleCodes?.length) {
    const definitions = await Promise.all(
      unique(input.roleCodes).map((roleCode) => repository.getRoleDefinition(input.tenantId, { roleCode })),
    );
    for (const definition of definitions) {
      if (!definition) fail("role_not_found");
      scopes.push(...definition.scopes);
    }
  }
  if (input.candidateScopes) {
    const raw = unique(input.candidateScopes);
    if (raw.some((scope) => !isRegisteredScope(scope))) fail("invalid_scope");
    scopes.push(...expandRoleScopes(raw));
  }
  return unique(scopes);
}

async function roleCodeRange(input: GrantabilityInput, roleCode: string): Promise<GrantabilityInput> {
  // Preserve the historical roleCodes projection exactly.  Tenant-wide
  // system roles remain tenant-wide even when a user's profile carries a
  // default department; custom roles with a department are unresolved until
  // an explicit binding is chosen.
  if (["super_admin", "owner", "admin", "auditor"].includes(roleCode)) {
    return { ...input, dataScope: "tenant", scopeOrgId: null, scopeDeptId: null };
  }
  if (roleCode === "member") {
    return { ...input, dataScope: "self", scopeOrgId: null, scopeDeptId: null };
  }
  if (input.defaultDeptId) {
    return {
      ...input,
      dataScope: roleCode === "dept_admin" ? "department" : "department",
      scopeOrgId: input.defaultOrgId ?? null,
      scopeDeptId: input.defaultDeptId,
    };
  }
  return { ...input, dataScope: "self", scopeOrgId: null, scopeDeptId: null };
}

async function assertLastSuperAdminNotRemovedWithRepository(
  input: {
    tenantId: string;
    targetUserId: string;
    nextRoleCodes?: string[];
  },
  repository: PrincipalsRepository,
): Promise<void> {
  const current = await repository.listLegacyUserRoleBindings(input.tenantId, input.targetUserId);
  const principal = await repository.getPrincipalForUser(input.tenantId, input.targetUserId);
  const explicit = principal
    ? await repository.getPrincipalEffectivePermissions({ tenantId: input.tenantId, principalId: principal.id })
    : [];
  if (!current.some((binding) => binding.roleCode === "super_admin") && !explicit.some((binding) => binding.roleCode === "super_admin")) return;
  if (input.nextRoleCodes?.some((code) => code.trim().toLowerCase() === "super_admin")) return;
  const count = await repository.countActiveUsersWithRole(input.tenantId, "super_admin");
  if (count <= 1) fail("last_superadmin_protected");
}

/**
 * Shared guard for role assignment, role definitions, and compatibility
 * user-role-code writes.  Callers may pass candidateScopes when creating or
 * changing a role before there is a role row to resolve.
 */
export async function assertGrantable(input: GrantabilityInput): Promise<GrantabilitySnapshot> {
  if (!input.actorUserId?.trim()) fail("actor_required");
  await validateRequestedRange(input);
  const repository = getPrincipalRepository();
  const context = await getUserAuthorizationContext(input.tenantId, input.actorUserId);
  if (context.userStatus === "missing") fail("actor_missing");
  if (context.userStatus !== "active" || context.userPrincipal?.status !== "active") fail("actor_inactive");
  const grantAuthority = await resolveGrantAuthority(input, context);

  // Capture the resolved role row for the persistence CAS. A role can be
  // edited after this guard returns; the repository must reject that stale
  // authorization rather than attach a binding against a different scope set.
  const resolvedRole = input.roleId || input.roleCode || input.roleSnapshotId
    ? await repository.getRoleDefinition(input.tenantId, {
      roleId: input.roleId ?? input.roleSnapshotId,
      roleCode: input.roleCode,
    })
    : null;
  if ((input.roleId || input.roleCode || input.roleSnapshotId) && !resolvedRole) fail("role_not_found");

  const hasRoleAssignment = Boolean(input.targetPrincipalId || input.roleCodes?.length);
  const rawRequiredScopes = unique(input.requiredScopes ?? []);
  if (rawRequiredScopes.some((scope) => !isRegisteredScope(scope))) fail("invalid_scope");
  // Role rows may legitimately store `*` (notably super_admin).  Effective
  // permissions are expanded to registered scopes, so normalize the guard's
  // required set the same way before matching it.
  const requiredScopes = expandRoleScopes(rawRequiredScopes);
  if ((hasRoleAssignment || input.canDelegate) && !requiredScopes.includes("role:assign")) requiredScopes.push("role:assign");

  const targetPrincipal = input.targetPrincipalId
    ? await repository.getPrincipal(input.tenantId, input.targetPrincipalId)
    : null;
  if (input.targetPrincipalId && !targetPrincipal) fail("target_principal_missing");
  if (targetPrincipal && targetPrincipal.status !== "active" && hasRoleAssignment) fail("target_principal_inactive");
  if (input.targetUserId) {
    const targetStatus = await repository.getUserStatus(input.tenantId, input.targetUserId);
    if (targetStatus === "missing" && !input.targetMayBeNew) fail("target_user_missing");
  }
  const ownerUserId = await targetOwnerUserId(input);
  // A role mutation can capture a role row for the persistence CAS without
  // asking the actor to possess every scope currently stored on that role.
  // Role assignment still passes roleId/roleCode and therefore includes the
  // resolved role scopes in the requested authorization range.
  const roleScopes = await roleScopesForInput(
    input,
    input.roleId || input.roleCode ? resolvedRole : undefined,
  );
  const roleSnapshots: GrantabilitySnapshot["roleSnapshots"] = [];
  if (resolvedRole) {
    roleSnapshots.push({
      roleId: resolvedRole.id,
      roleCode: resolvedRole.code,
      scopes: [...resolvedRole.scopes].sort(),
      scopeFingerprint: roleScopeFingerprint(resolvedRole.scopes),
    });
  }
  if (input.roleCodes?.length) {
    const definitions = await Promise.all(
      unique(input.roleCodes).map(async (roleCode) => ({
        roleCode,
        definition: await repository.getRoleDefinition(input.tenantId, { roleCode }),
      })),
    );
    const blocked: string[] = [];
    for (const { roleCode, definition } of definitions) {
      if (!definition) fail("role_not_found");
      roleSnapshots.push({
        roleId: definition.id,
        roleCode: definition.code,
        scopes: [...definition.scopes].sort(),
        scopeFingerprint: roleScopeFingerprint(definition.scopes),
      });
      const range = await roleCodeRange(input, roleCode);
      await validateRequestedRange(range);
      const roleOwner = input.targetUserId ?? ownerUserId;
      blocked.push(...await actorHasScopes(
        grantAuthority.permissions,
        unique([...requiredScopes, ...definition.scopes]),
        range,
        roleOwner,
        false,
        grantAuthority.sourceUserId ?? input.actorUserId,
        Boolean(input.canDelegate),
      ));
      if (grantAuthority.differsFromActor) {
        blocked.push(...await actorHasScopes(
          context.effectivePermissions,
          ["role:assign"],
          range,
          roleOwner,
          false,
          input.actorUserId,
        ));
      }
    }
    if (blocked.length) fail(`grant_scope_exceeded:${unique(blocked).join(",")}`);
  } else {
    const requestedScopes = unique([...requiredScopes, ...roleScopes]);
    const blocked = await actorHasScopes(
      grantAuthority.permissions,
      requestedScopes,
      input,
      ownerUserId,
      false,
      grantAuthority.sourceUserId ?? input.actorUserId,
      Boolean(input.canDelegate),
    );
    if (grantAuthority.differsFromActor) {
      blocked.push(...await actorHasScopes(
        context.effectivePermissions,
        ["role:assign"],
        input,
        ownerUserId,
        false,
        input.actorUserId,
      ));
    }
    if (blocked.length) fail(`grant_scope_exceeded:${blocked.join(",")}`);
  }

  if (input.roleCodes && input.targetUserId) {
    await assertLastSuperAdminNotRemovedWithRepository({
      tenantId: input.tenantId,
      targetUserId: input.targetUserId,
      nextRoleCodes: input.roleCodes,
    }, repository);
  }

  return {
    actorPrincipalId: context.userPrincipal!.id,
    actorAuthzVersion: context.userPrincipal!.authzVersion,
    actorPermissionExpiresAt: earliestPermissionExpiry(context.effectivePermissions),
    grantorPrincipalId: grantAuthority.principalId ?? context.userPrincipal!.id,
    grantorAuthzVersion: grantAuthority.authzVersion,
    grantorPermissionExpiresAt: grantAuthority.permissionExpiresAt,
    targetPrincipalId: targetPrincipal?.id ?? null,
    targetAuthzVersion: targetPrincipal?.authzVersion ?? null,
    roleId: resolvedRole?.id ?? null,
    roleScopes: resolvedRole?.scopes ? [...resolvedRole.scopes].sort() : [],
    roleScopeFingerprint: resolvedRole ? roleScopeFingerprint(resolvedRole.scopes) : null,
    roleSnapshots: roleSnapshots.sort((left, right) => left.roleId.localeCompare(right.roleId)),
  };
}

/** Guard removal of a binding, including the last effective super-admin. */
export async function assertBindingManageable(input: {
  tenantId: string;
  bindingId: string;
  actorUserId: string;
}): Promise<import("./types").BindingManageabilitySnapshot | null> {
  if (!input.actorUserId?.trim()) fail("actor_required");
  const repository = getPrincipalRepository();
  const binding = await repository.getPrincipalRoleBinding(input.tenantId, input.bindingId);
  if (!binding) fail("binding_not_found");
  if (binding.status === "revoked") return null;
  const principal = await repository.getPrincipal(input.tenantId, binding.principalId);
  if (!principal) fail("target_principal_missing");
  const context = await getUserAuthorizationContext(input.tenantId, input.actorUserId);
  if (context.userStatus !== "active" || context.userPrincipal?.status !== "active") fail("actor_inactive");
  const candidate: GrantabilityInput = {
    tenantId: input.tenantId,
    actorUserId: input.actorUserId,
    targetPrincipalId: binding.principalId,
    dataScope: binding.dataScope,
    scopeOrgId: binding.scopeOrgId,
    scopeDeptId: binding.scopeDeptId,
    requiredScopes: ["role:assign"],
  };
  // Revocation is a cleanup operation.  It must still be range-authorized,
  // but an already expired target binding must not be rejected because a
  // proposed grant expiry is in the past.
  const blocked = await actorHasScopes(
    context.effectivePermissions,
    ["role:assign"],
    candidate,
    principalOwnerUserId(principal),
    true,
  );
  if (blocked.length) fail(`grant_scope_exceeded:${blocked.join(",")}`);

  if (binding.roleCode === "super_admin" && principal.kind === "user" && principal.userId) {
    const remaining = (await repository.listPrincipalRoleBindings(input.tenantId, principal.id)).some(
      (item) => item.id !== binding.id && item.roleCode === "super_admin" && item.status === "active" && item.resolution === "resolved" &&
        (item.expiresAt === null || new Date(item.expiresAt).getTime() > Date.now()),
    );
  if (!remaining && await repository.countActiveUsersWithRole(input.tenantId, "super_admin") <= 1) {
      fail("last_superadmin_protected");
    }
  }

  return {
    actorPrincipalId: context.userPrincipal!.id,
    actorAuthzVersion: context.userPrincipal!.authzVersion,
    actorPermissionExpiresAt: earliestPermissionExpiry(context.effectivePermissions),
  };
}

export async function assertUserRoleCodesGrantable(input: {
  tenantId: string;
  actorUserId: string;
  targetUserId: string;
  targetMayBeNew?: boolean;
  roleCodes: string[];
  defaultOrgId?: string | null;
  defaultDeptId?: string | null;
}): Promise<GrantabilitySnapshot> {
  return assertGrantable({
    ...input,
    targetUserId: input.targetUserId,
    defaultOrgId: input.defaultOrgId,
    defaultDeptId: input.defaultDeptId,
    candidateScopes: [],
    roleCodes: input.roleCodes,
    requiredScopes: ["role:assign"],
  });
}

export async function assertUserDeletionSafe(
  input: { tenantId: string; userId: string },
  repository = getPrincipalRepository(),
): Promise<void> {
  try {
    await assertLastSuperAdminNotRemovedWithRepository({ tenantId: input.tenantId, targetUserId: input.userId }, repository);
  } catch (error) {
    // Older embedded fixtures can run before the principal migration and do
    // not expose the new tables.  Only an explicit missing-table/mocked-export
    // error is compatibility-fallback eligible; query, connection, and
    // constraint errors remain fail-closed.
    const message = error instanceof Error ? error.message : String(error);
    const principalSchemaMissing =
      /relation ["'](?:public\.)?(?:principals|principal_role_bindings)["'] does not exist/i.test(message) ||
      /table ["']?[^"']*(?:principals|principal_role_bindings)["']? (?:doesn't|does not) exist/i.test(message) ||
      /no such table:\s*["']?(?:principals|principal_role_bindings)/i.test(message) ||
      /No "(?:principals|principal_role_bindings)" export is defined/i.test(message);
    if (principalSchemaMissing) return;
    throw error;
  }
}

/** Metadata for admin UIs; the server-side assertGrantable remains final. */
export async function getGrantableRoleOptions(input: {
  tenantId: string;
  actorUserId: string;
  targetPrincipalId?: string;
  dataScope?: DataScope;
  scopeOrgId?: string | null;
  scopeDeptId?: string | null;
}): Promise<GrantableRoleOption[]> {
  const repository = getPrincipalRepository();
  const definitions = await repository.listRoleDefinitions(input.tenantId);
  const result: GrantableRoleOption[] = [];
  for (const definition of definitions) {
    const blockedScopes: string[] = [];
    let reason: string | null = null;
    try {
      await assertGrantable({
        ...input,
        roleId: definition.id,
        requiredScopes: ["role:assign"],
      });
    } catch (error) {
      reason = error instanceof Error ? error.message : "not_grantable";
      const marker = reason.startsWith("grant_scope_exceeded:") ? reason.slice("grant_scope_exceeded:".length) : "";
      blockedScopes.push(...marker.split(",").filter(Boolean));
    }
    result.push({
      id: definition.id,
      code: definition.code,
      scopes: definition.scopes,
      immutable: definition.immutable,
      grantable: reason === null,
      blockedScopes,
      reason,
    });
  }
  return result;
}
