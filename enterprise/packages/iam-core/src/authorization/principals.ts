import type {
  AuthorizationContext,
  AuthorizationDecision,
  CreateAgentPrincipalInput,
  EffectivePermissionsInput,
  PrincipalDto,
  PrincipalMutationSnapshot,
  UpdateAgentPrincipalInput,
} from "./types";
import { getPrincipalRepository } from "./repository";
import { authorizePrincipalAction } from "./authorize";
import { getUserAuthorizationContext } from "./context";
import type { PrincipalListFilter } from "../repos/principal-contracts";

function earliestPermissionExpiry(decision: AuthorizationDecision): string | null {
  const expiries = decision.matchedPermissions
    .map((permission) => permission.expiresAt)
    .filter((value): value is string => Boolean(value))
    .map((value) => ({ value, timestamp: new Date(value).getTime() }))
    .filter(({ timestamp }) => Number.isFinite(timestamp))
    .sort((left, right) => left.timestamp - right.timestamp);
  return expiries[0]?.value ?? null;
}

function samePermission(left: AuthorizationDecision["matchedPermissions"][number], right: AuthorizationContext["effectivePermissions"][number]): boolean {
  return left.bindingId === right.bindingId &&
    left.scope === right.scope &&
    left.roleCode === right.roleCode &&
    left.dataScope === right.dataScope &&
    left.scopeOrgId === right.scopeOrgId &&
    left.scopeDeptId === right.scopeDeptId &&
    left.expiresAt === right.expiresAt &&
    left.resolution === right.resolution &&
    left.grantedByPrincipalId === right.grantedByPrincipalId &&
    left.canDelegate === right.canDelegate &&
    left.grantorApprovalRef === right.grantorApprovalRef;
}

/**
 * Keep the repository CAS tied to the same live permission set that produced
 * the allow decision.  A second read is deliberate: if the actor changed
 * between the initial context and authorization, this fails closed rather
 * than handing the repository a context that was never authorized.
 */
function principalMutationSnapshot(
  context: AuthorizationContext,
  decision: AuthorizationDecision,
  target: PrincipalDto | null,
): PrincipalMutationSnapshot {
  if (!context.userPrincipal || context.userStatus !== "active" || context.userPrincipal.status !== "active") {
    throw new Error("authorization context is stale");
  }
  if (!decision.matchedPermissions.every((permission) => {
    return context.effectivePermissions.some((current) => samePermission(permission, current));
  })) {
    throw new Error("authorization context is stale");
  }
  return {
    actorPrincipalId: context.userPrincipal.id,
    actorAuthzVersion: context.userPrincipal.authzVersion,
    actorPermissionExpiresAt: earliestPermissionExpiry(decision),
    targetPrincipalId: target?.id ?? null,
    targetAuthzVersion: target?.authzVersion ?? null,
    targetStatus: target?.status ?? null,
  };
}

/** Resolve one principal inside the supplied tenant. */
export function getPrincipal(tenantId: string, principalId: string): Promise<PrincipalDto | null>;
export function getPrincipal(input: { tenantId: string; principalId: string }): Promise<PrincipalDto | null>;
export function getPrincipal(
  tenantOrInput: string | { tenantId: string; principalId: string },
  principalId?: string,
): Promise<PrincipalDto | null> {
  const tenantId = typeof tenantOrInput === "string" ? tenantOrInput : tenantOrInput.tenantId;
  const resolvedPrincipalId = typeof tenantOrInput === "string" ? principalId : tenantOrInput.principalId;
  if (!resolvedPrincipalId) return Promise.resolve(null);
  return getPrincipalRepository().getPrincipal(tenantId, resolvedPrincipalId);
}

/** Resolve the durable user principal without exposing another tenant's row. */
export function getPrincipalForUser(tenantId: string, userId: string): Promise<PrincipalDto | null>;
export function getPrincipalForUser(input: { tenantId: string; userId: string }): Promise<PrincipalDto | null>;
export function getPrincipalForUser(
  tenantOrInput: string | { tenantId: string; userId: string },
  userId?: string,
): Promise<PrincipalDto | null> {
  const tenantId = typeof tenantOrInput === "string" ? tenantOrInput : tenantOrInput.tenantId;
  const resolvedUserId = typeof tenantOrInput === "string" ? userId : tenantOrInput.userId;
  if (!resolvedUserId) return Promise.resolve(null);
  return getPrincipalRepository().getPrincipalForUser(tenantId, resolvedUserId);
}

/** Ensure the migration-compatible user principal exists and return it. */
export function ensureUserPrincipal(tenantId: string, userId: string): Promise<PrincipalDto | null>;
export function ensureUserPrincipal(input: { tenantId: string; userId: string }): Promise<PrincipalDto | null>;
export function ensureUserPrincipal(
  tenantOrInput: string | { tenantId: string; userId: string },
  userId?: string,
): Promise<PrincipalDto | null> {
  const tenantId = typeof tenantOrInput === "string" ? tenantOrInput : tenantOrInput.tenantId;
  const resolvedUserId = typeof tenantOrInput === "string" ? userId : tenantOrInput.userId;
  if (!resolvedUserId) return Promise.resolve(null);
  return getPrincipalRepository().ensureUserPrincipal(tenantId, resolvedUserId);
}

export function listPrincipals(tenantId: string, filter?: PrincipalListFilter): Promise<PrincipalDto[]> {
  return getPrincipalRepository().listPrincipals(tenantId, filter);
}

export async function createAgentPrincipal(input: CreateAgentPrincipalInput): Promise<PrincipalDto> {
  if (input.actorUserId) {
    const context = await getUserAuthorizationContext(input.tenantId, input.actorUserId);
    const decision = await authorizePrincipalAction({
      tenantId: input.tenantId,
      userId: input.actorUserId,
      requiredScopes: ["agent:create"],
      target: input.ownerUserId
        ? { kind: "user", id: input.ownerUserId }
        : { kind: "tenant", id: input.tenantId },
    });
    if (!decision.allowed) throw new Error("agent:create is outside the current range");
    input = {
      ...input,
      authorizationSnapshot: principalMutationSnapshot(context, decision, null),
    };
  }
  return getPrincipalRepository().createAgentPrincipal(input);
}

export async function updateAgentPrincipal(input: UpdateAgentPrincipalInput): Promise<PrincipalDto> {
  if (input.actorUserId) {
    const context = await getUserAuthorizationContext(input.tenantId, input.actorUserId);
    const target = await getPrincipalRepository().getPrincipal(input.tenantId, input.principalId);
    if (!target || target.kind !== "agent") throw new Error("agent principal not found");
    const decision = await authorizePrincipalAction({
      tenantId: input.tenantId,
      userId: input.actorUserId,
      requiredScopes: ["agent:update"],
      target: { kind: "agent", id: input.principalId },
    });
    if (!decision.allowed) throw new Error("agent:update is outside the current range");
    input = {
      ...input,
      authorizationSnapshot: principalMutationSnapshot(context, decision, target),
    };
  }
  return getPrincipalRepository().updateAgentPrincipal(input);
}

export function getPrincipalEffectivePermissions(input: EffectivePermissionsInput) {
  return getPrincipalRepository().getPrincipalEffectivePermissions(input).then((bindings) =>
    bindings.flatMap((binding) =>
      binding.scopes.map((scope) => ({
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
      })),
    ),
  );
}
