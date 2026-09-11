import { mergeUserScopes } from "../scope-registry";
import type { EffectivePermission, AuthorizationContext, PrincipalRoleBindingDto } from "./types";
import { getPrincipalRepository } from "./repository";

function effectivePermissions(bindings: PrincipalRoleBindingDto[], at: Date): EffectivePermission[] {
  return bindings.flatMap((binding) => {
    if (binding.status !== "active" || binding.resolution !== "resolved") return [];
    if (binding.expiresAt && new Date(binding.expiresAt).getTime() <= at.getTime()) return [];
    return binding.scopes.map((scope) => ({
      scope,
      roleCode: binding.roleCode,
      bindingId: binding.id,
      dataScope: binding.dataScope,
      scopeOrgId: binding.scopeOrgId,
      scopeDeptId: binding.scopeDeptId,
      expiresAt: binding.expiresAt,
      resolution: binding.resolution,
      grantedByPrincipalId: binding.grantedByPrincipalId,
      canDelegate: binding.canDelegate,
      grantorApprovalRef: binding.grantorApprovalRef,
    }));
  });
}

/**
 * Build an authorization snapshot from live account state.  Explicit
 * principal bindings are authoritative once present; user_roles is used only
 * as a migration-compatible fallback for tenants that have not run the
 * principal migration yet.
 */
export async function getUserAuthorizationContext(
  tenantId: string,
  userId: string,
): Promise<AuthorizationContext> {
  const repository = getPrincipalRepository();
  const userPrincipalPromise = repository.getPrincipalForUser(tenantId, userId);
  const [userPrincipal, userStatus, explicitBindings, legacyBindings] = await Promise.all([
    userPrincipalPromise,
    repository.getUserStatus(tenantId, userId),
    userPrincipalPromise.then(async (principal) =>
      principal ? repository.listPrincipalRoleBindings(tenantId, principal.id) : [],
    ),
    repository.listLegacyUserRoleBindings(tenantId, userId),
  ]);
  // Presence of a durable user principal means the migration has taken
  // ownership of this user's bindings.  An empty binding set is an explicit
  // deny and must not resurrect stale user_roles rows.
  const bindings = userPrincipal ? explicitBindings : legacyBindings;
  const at = new Date();
  const permissions = effectivePermissions(bindings, at);
  const effectiveBindingIds = new Set(permissions.map((permission) => permission.bindingId));
  const effectiveBindings = bindings.filter((binding) => effectiveBindingIds.has(binding.id));
  const roleCodes = [...new Set(effectiveBindings.map((binding) => binding.roleCode))];
  const scopes = mergeUserScopes(effectiveBindings.map((binding) => binding.scopes));
  return {
    tenantId,
    userId,
    userPrincipal,
    agentPrincipal: null,
    userStatus,
    roleCodes,
    scopes,
    bindings,
    effectivePermissions: permissions,
    authzVersion: userPrincipal?.authzVersion ?? 0,
    unresolvedBindingIds: bindings.filter((binding) => binding.resolution !== "resolved").map((binding) => binding.id),
  };
}

export function effectivePermissionsFromBindings(
  bindings: PrincipalRoleBindingDto[],
  at = new Date(),
): EffectivePermission[] {
  return effectivePermissions(bindings, at);
}
