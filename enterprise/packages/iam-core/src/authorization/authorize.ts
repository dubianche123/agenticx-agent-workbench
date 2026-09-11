import { expandRoleScopes, isRegisteredScope } from "../scope-registry";
import { getPrincipalRepository } from "./repository";
import { effectivePermissionsFromBindings, getUserAuthorizationContext } from "./context";
import type {
  AuthorizationDecision,
  AuthorizationTarget,
  EffectivePermission,
  PrincipalDto,
  PrincipalRoleBindingDto,
} from "./types";

function denied(
  reason: AuthorizationDecision["reason"],
  publicReason: string,
  requiredScopes: string[],
  deniedScopes: string[],
  target: AuthorizationTarget,
  matchedPermissions: EffectivePermission[] = [],
): AuthorizationDecision {
  return { allowed: false, reason, publicReason, requiredScopes, deniedScopes, matchedPermissions, target };
}

function allowed(
  requiredScopes: string[],
  target: AuthorizationTarget,
  matchedPermissions: EffectivePermission[],
): AuthorizationDecision {
  return { allowed: true, reason: "allowed", publicReason: "allowed", requiredScopes, deniedScopes: [], matchedPermissions, target };
}

/**
 * The first owner-inheriting assistant rollout created a
 * `personal_assistant` binding as a compatibility template. Those rows are
 * legacy authority and must not turn owner inheritance into a deny-all
 * ceiling after reconciliation. New role assignments always carry a creator,
 * so an explicit row without one is the only compatibility shape accepted
 * here; every other explicit row remains a durable ceiling marker, including
 * revoked and expired rows.
 */
export function isLegacyPersonalAssistantBinding(binding: PrincipalRoleBindingDto): boolean {
  if (binding.source === "legacy") return true;
  return binding.source === "explicit" &&
    binding.roleCode === "personal_assistant" &&
    binding.createdByUserId === null;
}

/**
 * A delegated agent stays in ceiling mode once an explicit assignment has
 * existed. Revoke/expiry removes the usable permission but does not silently
 * widen access back to the owner's full live scope. The only way back to
 * inheritance is an intentional reset that removes the explicit ceiling
 * marker (or a compatibility migration that marks a legacy template row).
 */
export function hasDelegatedAgentExplicitCeiling(
  bindings: PrincipalRoleBindingDto[],
): boolean {
  return bindings.some((binding) => binding.source === "explicit" && !isLegacyPersonalAssistantBinding(binding));
}

async function permissionMatchesTarget(
  permission: EffectivePermission,
  principal: PrincipalDto | null,
  userId: string,
  target: Awaited<ReturnType<ReturnType<typeof getPrincipalRepository>["resolveAuthorizationTarget"]>>,
): Promise<boolean> {
  if (!target || permission.resolution !== "resolved") return false;
  // resolveAuthorizationTarget is tenant-bound; retain the explicit check so
  // this helper cannot become a cross-tenant bypass if a resolver changes.
  if (target.tenantId !== principal?.tenantId && principal) return false;
  if (permission.dataScope === "tenant") return true;
  if (permission.dataScope === "self") {
    const owner = principal?.kind === "agent"
      ? principal.agentProfile?.ownerUserId
      : principal?.userId ?? userId;
    return owner !== null && owner !== undefined && target.ownerUserId === owner;
  }
  if (!permission.scopeDeptId || !target.deptId) return false;
  return getPrincipalRepository().departmentScopeContains(
    target.tenantId,
    permission.scopeDeptId,
    target.deptId,
    permission.dataScope === "department_subtree",
  );
}

async function matchingPermission(
  scope: string,
  permissions: EffectivePermission[],
  principal: PrincipalDto | null,
  userId: string,
  target: Awaited<ReturnType<ReturnType<typeof getPrincipalRepository>["resolveAuthorizationTarget"]>>,
): Promise<EffectivePermission | null> {
  for (const permission of permissions) {
    if (permission.scope !== scope) continue;
    if (await permissionMatchesTarget(permission, principal, userId, target)) return permission;
  }
  return null;
}

/**
 * Authorize an action against a server-resolved target.  A scope is matched
 * together with the data range on the same binding; this prevents a write
 * permission in department A and a read permission in department B from
 * becoming write permission in both departments.
 */
export async function authorizePrincipalAction(input: {
  tenantId: string;
  userId: string;
  agentPrincipalId?: string;
  requiredScopes: string[];
  target: AuthorizationTarget;
}): Promise<AuthorizationDecision> {
  const rawRequiredScopes = [...new Set(input.requiredScopes.map((scope) => scope.trim()).filter(Boolean))];
  if (!rawRequiredScopes.length || rawRequiredScopes.some((scope) => !isRegisteredScope(scope))) {
    return denied("invalid_scope", "requested scope is not registered", rawRequiredScopes, rawRequiredScopes, input.target);
  }
  // System roles may store `*`; all effective permissions are expanded to
  // concrete registered scopes, so normalize an action requirement likewise.
  const requiredScopes = expandRoleScopes(rawRequiredScopes);
  const repository = getPrincipalRepository();
  const [context, target] = await Promise.all([
    getUserAuthorizationContext(input.tenantId, input.userId),
    repository.resolveAuthorizationTarget(input.tenantId, { kind: input.target.kind, id: input.target.id }),
  ]);
  if (context.userStatus === "missing") return denied("principal_missing", "user principal not found", requiredScopes, requiredScopes, input.target);
  if (context.userStatus === "disabled" || context.userStatus === "locked") return denied("user_disabled", "user is not active", requiredScopes, requiredScopes, input.target);
  if (!target) return denied("target_missing", "target object was not found in this tenant", requiredScopes, requiredScopes, input.target);

  const userPrincipal = context.userPrincipal;
  if (!userPrincipal || userPrincipal.status !== "active") {
    return denied("principal_disabled", "user principal is not active", requiredScopes, requiredScopes, input.target);
  }
  const userPermissions = context.effectivePermissions;
  let agentPrincipal: PrincipalDto | null = null;
  let agentPermissions: EffectivePermission[] = [];
  let agentHasExplicitCeiling = false;
  if (input.agentPrincipalId) {
    agentPrincipal = await repository.getPrincipal(input.tenantId, input.agentPrincipalId);
    if (!agentPrincipal || agentPrincipal.kind !== "agent" || !agentPrincipal.agentProfile) {
      return denied("principal_missing", "agent principal was not found in this tenant", requiredScopes, requiredScopes, input.target);
    }
    if (agentPrincipal.status !== "active") return denied("principal_disabled", "agent principal is disabled", requiredScopes, requiredScopes, input.target);
    if (agentPrincipal.agentProfile.mode === "service") {
      return denied(
        "invalid_request",
        "service agent requires workload authorization",
        requiredScopes,
        requiredScopes,
        input.target,
      );
    }
    if (agentPrincipal.agentProfile.mode === "delegated" && agentPrincipal.agentProfile.ownerUserId !== input.userId) {
      return denied("principal_missing", "agent is not delegated by this user", requiredScopes, requiredScopes, input.target);
    }
    const [agentBindings, effectiveAgentBindings] = await Promise.all([
      repository.listPrincipalRoleBindings(input.tenantId, agentPrincipal.id),
      repository.getPrincipalEffectivePermissions({ tenantId: input.tenantId, principalId: agentPrincipal.id }),
    ]);
    // Delegated assistants inherit the owner's live permissions by default.
    // An explicit agent binding is an optional ceiling: once one exists, the
    // agent can only use scopes/data ranges represented by that binding. Its
    // revoked/expired history remains a ceiling marker so removing the last
    // active row cannot silently broaden access. Legacy template rows are
    // excluded by the compatibility helper above.
    agentHasExplicitCeiling = hasDelegatedAgentExplicitCeiling(agentBindings);
    agentPermissions = effectivePermissionsFromBindings(effectiveAgentBindings);
  }

  const matchedPermissions: EffectivePermission[] = [];
  const deniedScopes: string[] = [];
  for (const scope of requiredScopes) {
    const userPermission = await matchingPermission(scope, userPermissions, userPrincipal, input.userId, target);
    if (!input.agentPrincipalId) {
      if (userPermission) matchedPermissions.push(userPermission);
      else deniedScopes.push(scope);
      continue;
    }
    const delegated = agentPrincipal?.agentProfile?.mode === "delegated";
    if (delegated && !agentHasExplicitCeiling) {
      // No explicit ceiling means owner inheritance. The matched user
      // permission is retained in the audit snapshot so a later revoke is
      // visible to the authorization-version fingerprint.
      if (userPermission) matchedPermissions.push(userPermission);
      else deniedScopes.push(scope);
      continue;
    }
    const agentPermission = await matchingPermission(scope, agentPermissions, agentPrincipal, input.userId, target);
    // A delegated agent with a ceiling intersects the user's currently
    // effective binding. A service agent has its own role set and does not
    // inherit its owner.
    if (agentPermission && (!delegated || userPermission)) {
      matchedPermissions.push(agentPermission);
      if (delegated && userPermission) matchedPermissions.push(userPermission);
    } else deniedScopes.push(scope);
  }
  if (deniedScopes.length) {
    const hadUnresolved = context.bindings.some((binding) => binding.resolution !== "resolved" && binding.scopes.some((scope) => deniedScopes.includes(scope)));
    const hadExpired = context.bindings.some((binding) => binding.expiresAt !== null && new Date(binding.expiresAt).getTime() <= Date.now() && binding.scopes.some((scope) => deniedScopes.includes(scope)));
    return denied(
      hadExpired ? "binding_expired" : hadUnresolved ? "binding_unresolved" : "missing_scope",
      hadExpired ? "authorization binding has expired" : hadUnresolved ? "authorization binding requires explicit scope resolution" : "required scope is not granted for this target",
      requiredScopes,
      deniedScopes,
      input.target,
      matchedPermissions,
    );
  }
  return allowed(requiredScopes, input.target, matchedPermissions);
}
