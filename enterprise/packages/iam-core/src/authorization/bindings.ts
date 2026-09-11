import type {
  AssignPrincipalRoleBindingInput,
  PrincipalRoleBindingDto,
  RemovePrincipalRoleBindingInput,
} from "./types";
import { assertGrantable, assertBindingManageable } from "./grantability";
import { getPrincipalRepository } from "./repository";

export function listPrincipalRoleBindings(input: {
  tenantId: string;
  principalId: string;
}): Promise<PrincipalRoleBindingDto[]>;

/**
 * Positional overload retained for the existing admin routes.  Both forms
 * resolve through the same tenant-scoped repository method.
 */
export function listPrincipalRoleBindings(tenantId: string, principalId: string): Promise<PrincipalRoleBindingDto[]>;
export function listPrincipalRoleBindings(
  tenantOrInput: string | { tenantId: string; principalId: string },
  principalId?: string,
): Promise<PrincipalRoleBindingDto[]> {
  const tenantId = typeof tenantOrInput === "string" ? tenantOrInput : tenantOrInput.tenantId;
  const resolvedPrincipalId = typeof tenantOrInput === "string" ? principalId : tenantOrInput.principalId;
  if (!resolvedPrincipalId) return Promise.resolve([]);
  return getPrincipalRepository().listPrincipalRoleBindings(tenantId, resolvedPrincipalId);
}

export function listPrincipalRoleBindingsForRole(tenantId: string, roleId: string): Promise<PrincipalRoleBindingDto[]> {
  return getPrincipalRepository().listPrincipalRoleBindingsForRole(tenantId, roleId);
}

export async function assignPrincipalRoleBinding(
  input: AssignPrincipalRoleBindingInput,
): Promise<PrincipalRoleBindingDto> {
  // The repository input names the subject `principalId`; grantability uses
  // the same target field for role and agent mutations.  Keep this mapping at
  // the typed boundary so the guard cannot accidentally authorize an unbound
  // target with an empty owner/range.
  const snapshot = await assertGrantable({ ...input, targetPrincipalId: input.principalId });
  return getPrincipalRepository().assignPrincipalRoleBinding({
    ...input,
    expectedActorAuthzVersion: snapshot.actorAuthzVersion,
    expectedGrantorAuthzVersion: snapshot.grantorAuthzVersion,
    expectedTargetAuthzVersion: snapshot.targetAuthzVersion ?? undefined,
    expectedActorPermissionExpiresAt: snapshot.actorPermissionExpiresAt,
    expectedGrantorPermissionExpiresAt: snapshot.grantorPermissionExpiresAt,
    expectedRoleId: snapshot.roleId ?? undefined,
    expectedRoleScopes: snapshot.roleScopes,
    expectedRoleScopeFingerprint: snapshot.roleScopeFingerprint ?? undefined,
  });
}

export async function removePrincipalRoleBinding(input: RemovePrincipalRoleBindingInput): Promise<void> {
  const snapshot = await assertBindingManageable(input);
  return getPrincipalRepository().removePrincipalRoleBinding({
    ...input,
    ...(snapshot ? {
      expectedActorPrincipalId: snapshot.actorPrincipalId,
      expectedActorAuthzVersion: snapshot.actorAuthzVersion,
      expectedActorPermissionExpiresAt: snapshot.actorPermissionExpiresAt,
    } : {}),
  });
}
