export type PrincipalKind = "user" | "agent";
export type PrincipalStatus = "active" | "disabled";
export type AgentMode = "delegated" | "service";
export type DataScope = "self" | "department" | "department_subtree" | "tenant";
export type PrincipalBindingStatus = "active" | "revoked";
export type BindingResolution = "resolved" | "unresolved";
export type PrincipalBindingSource = "legacy" | "explicit";

/**
 * Server-side verification hook for authority that lives outside IAM (for
 * example a future connector/resource-owner approval).  HTTP input must
 * never be allowed to provide this function or treat an opaque reference as
 * proof by itself.
 */
/**
 * The verifier is called from both the authorization guard and the persistence
 * boundary. Implementations must therefore be idempotent and replay-safe for
 * the same complete intent; an approval must not be consumed on the first
 * call. The persistence boundary still requires the verifier for direct
 * repository callers, so skipping the guard never skips resource approval.
 */
export type GrantorApprovalVerifier = (input: {
  tenantId: string;
  actorUserId: string;
  grantorPrincipalId: string;
  approvalRef: string;
  targetPrincipalId: string | null;
  roleId: string | null;
  roleCode: string | null;
  dataScope: DataScope | null;
  scopeOrgId: string | null;
  scopeDeptId: string | null;
  expiresAt: string | null;
  canDelegate: boolean;
}) => boolean | Promise<boolean>;

export type AgentProfileDto = {
  principalId: string;
  tenantId: string;
  mode: AgentMode;
  ownerUserId: string | null;
  definitionRef: string | null;
  definitionVersion: number;
};

export type PrincipalDto = {
  id: string;
  tenantId: string;
  kind: PrincipalKind;
  userId: string | null;
  displayName: string | null;
  status: PrincipalStatus;
  authzVersion: number;
  agentProfile: AgentProfileDto | null;
  createdAt: string;
  updatedAt: string;
};

export type PrincipalRoleBindingDto = {
  id: string;
  tenantId: string;
  principalId: string;
  roleId: string;
  roleCode: string;
  scopes: string[];
  dataScope: DataScope;
  scopeOrgId: string | null;
  scopeDeptId: string | null;
  expiresAt: string | null;
  status: PrincipalBindingStatus;
  resolution: BindingResolution;
  resolutionReason: string | null;
  source: PrincipalBindingSource;
  createdByUserId: string | null;
  /** Principal whose authority was used to grant this binding. */
  grantedByPrincipalId: string | null;
  /** Whether this binding is allowed to be used as a delegation source. */
  canDelegate: boolean;
  /** Future connector/resource approval reference; no connector is implied. */
  grantorApprovalRef: string | null;
  createdAt: string;
  updatedAt: string;
};

export type EffectivePermission = {
  scope: string;
  roleCode: string;
  bindingId: string;
  dataScope: DataScope;
  scopeOrgId: string | null;
  scopeDeptId: string | null;
  expiresAt: string | null;
  resolution: BindingResolution;
  grantedByPrincipalId: string | null;
  canDelegate: boolean;
  grantorApprovalRef: string | null;
};

export type AuthorizationTarget = {
  /** Stable object type, for example `user`, `member`, `department`, or `tenant`. */
  kind: string;
  id: string;
  /** These are hints only.  The authorization repository resolves trusted values server-side. */
  deptId?: string | null;
  ownerUserId?: string | null;
};

export type AuthorizationContext = {
  tenantId: string;
  userId: string;
  userPrincipal: PrincipalDto | null;
  agentPrincipal: PrincipalDto | null;
  userStatus: "active" | "disabled" | "locked" | "missing";
  roleCodes: string[];
  scopes: string[];
  bindings: PrincipalRoleBindingDto[];
  effectivePermissions: EffectivePermission[];
  authzVersion: number;
  unresolvedBindingIds: string[];
};

export type AuthorizationDecision = {
  allowed: boolean;
  reason:
    | "allowed"
    | "invalid_scope"
    | "principal_missing"
    | "principal_disabled"
    | "user_disabled"
    | "target_missing"
    | "target_cross_tenant"
    | "binding_unresolved"
    | "binding_expired"
    | "missing_scope"
    | "invalid_request";
  publicReason: string;
  requiredScopes: string[];
  deniedScopes: string[];
  matchedPermissions: EffectivePermission[];
  target: AuthorizationTarget;
};

/**
 * Freshness facts captured by the authorization wrapper before a principal
 * mutation enters the repository.  The repository compares these facts after
 * taking row locks; callers cannot turn a preflight decision into a write
 * after the actor or target has been revoked/disabled in the meantime.
 */
export type PrincipalMutationSnapshot = {
  actorPrincipalId: string;
  actorAuthzVersion: number;
  actorPermissionExpiresAt: string | null;
  targetPrincipalId?: string | null;
  targetAuthzVersion?: number | null;
  targetStatus?: PrincipalStatus | null;
};

export type GrantabilityInput = {
  tenantId: string;
  actorUserId: string;
  targetPrincipalId?: string;
  targetUserId?: string;
  /** Internal create path: the target row is inserted in the same tx. */
  targetMayBeNew?: boolean;
  roleId?: string;
  roleCode?: string;
  /**
   * Role row to include in the persistence freshness snapshot for a role
   * mutation.  Unlike roleId/roleCode this does not make the role's scopes
   * part of the requested grant; role:update/delete still require their
   * dedicated operation scope.
   */
  roleSnapshotId?: string;
  /** Proposed role scopes for role create/update/duplicate guards. */
  candidateScopes?: string[];
  /** Proposed role codes for the compatibility user roleCodes write path. */
  roleCodes?: string[];
  requiredScopes?: string[];
  dataScope?: DataScope;
  scopeOrgId?: string | null;
  scopeDeptId?: string | null;
  defaultOrgId?: string | null;
  defaultDeptId?: string | null;
  expiresAt?: Date | string | null;
  /** Resource authority principal; defaults to the actor's user principal. */
  grantedByPrincipalId?: string | null;
  /** Allow the resulting binding to be used as a delegation source. */
  canDelegate?: boolean;
  /** External/resource-side approval reference, when applicable. */
  grantorApprovalRef?: string | null;
  /** Internal-only verifier for a grantor outside the current user. */
  grantorApprovalVerifier?: GrantorApprovalVerifier;
};

/**
 * Version facts captured by the grantability guard.  The binding repository
 * compares these values after taking row locks so a revoke/disable that wins
 * the race cannot be followed by an authorization write based on stale
 * permissions.
 */
export type GrantabilitySnapshot = {
  actorPrincipalId: string;
  actorAuthzVersion: number;
  actorPermissionExpiresAt: string | null;
  grantorPrincipalId: string;
  grantorAuthzVersion: number;
  grantorPermissionExpiresAt: string | null;
  targetPrincipalId: string | null;
  targetAuthzVersion: number | null;
  /** Resolved role state captured before the persistence transaction. */
  roleId: string | null;
  roleScopes: string[];
  roleScopeFingerprint: string | null;
  /** All role definitions resolved by the compatibility roleCodes path. */
  roleSnapshots: Array<{
    roleId: string;
    roleCode: string;
    scopes: string[];
    scopeFingerprint: string;
  }>;
};

/** Stable comparison key for a resolved role's effective scope set. */
export function roleScopeFingerprint(scopes: readonly string[]): string {
  return JSON.stringify([...new Set(scopes)].sort());
}

/**
 * Pure CAS contract shared by both SQL adapters.  Callers pass the role's
 * locked, expanded scope set; a mutation may proceed only when it is the
 * same role and the exact scope set captured by the authorization guard.
 */
export function roleMutationSnapshotMatches(
  snapshot: Pick<GrantabilitySnapshot, "roleId" | "roleScopeFingerprint"> & {
    roleScopes: readonly string[];
  },
  roleId: string,
  resolvedScopes: readonly string[],
): boolean {
  if (snapshot.roleId !== null && roleId !== snapshot.roleId) return false;
  const fingerprint = roleScopeFingerprint(resolvedScopes);
  return (snapshot.roleScopeFingerprint === null || fingerprint === snapshot.roleScopeFingerprint) &&
    fingerprint === roleScopeFingerprint(snapshot.roleScopes);
}

/** Compare the complete role set captured for a user roleCodes mutation. */
export function roleCodeSnapshotsMatch(
  expected: ReadonlyArray<GrantabilitySnapshot["roleSnapshots"][number]>,
  actual: ReadonlyArray<{ roleId: string; roleCode: string; scopes: readonly string[] }>,
): boolean {
  if (expected.length !== actual.length) return false;
  const actualById = new Map(actual.map((role) => [role.roleId, role]));
  return expected.every((role) => {
    const current = actualById.get(role.roleId);
    if (!current) return false;
    return current.roleCode === role.roleCode &&
      roleScopeFingerprint(current.scopes) === role.scopeFingerprint;
  });
}

export type CreateAgentPrincipalInput = {
  tenantId: string;
  displayName: string;
  mode: AgentMode;
  ownerUserId?: string | null;
  definitionRef?: string | null;
  definitionVersion?: number;
  actorUserId?: string | null;
  /** Internal freshness facts emitted by the authorization wrapper. */
  authorizationSnapshot?: PrincipalMutationSnapshot;
};

export type UpdateAgentPrincipalInput = {
  tenantId: string;
  principalId: string;
  displayName?: string;
  mode?: AgentMode;
  ownerUserId?: string | null;
  status?: PrincipalStatus;
  definitionRef?: string | null;
  definitionVersion?: number;
  actorUserId?: string | null;
  /** Internal freshness facts emitted by the authorization wrapper. */
  authorizationSnapshot?: PrincipalMutationSnapshot;
};

export type AssignPrincipalRoleBindingInput = {
  tenantId: string;
  principalId: string;
  roleId?: string;
  roleCode?: string;
  dataScope: DataScope;
  scopeOrgId?: string | null;
  scopeDeptId?: string | null;
  expiresAt?: Date | string | null;
  actorUserId: string;
  grantedByPrincipalId?: string | null;
  canDelegate?: boolean;
  grantorApprovalRef?: string | null;
  grantorApprovalVerifier?: GrantorApprovalVerifier;
  /** Internal CAS values emitted by the grantability wrapper. */
  expectedActorAuthzVersion?: number;
  expectedGrantorAuthzVersion?: number;
  expectedTargetAuthzVersion?: number;
  expectedActorPermissionExpiresAt?: string | null;
  expectedGrantorPermissionExpiresAt?: string | null;
  expectedRoleId?: string;
  expectedRoleScopes?: string[];
  expectedRoleScopeFingerprint?: string;
};

export type BindingManageabilitySnapshot = {
  actorPrincipalId: string;
  actorAuthzVersion: number;
  actorPermissionExpiresAt: string | null;
};

export type RemovePrincipalRoleBindingInput = {
  tenantId: string;
  bindingId: string;
  actorUserId: string;
  /** Internal freshness facts emitted by assertBindingManageable. */
  expectedActorPrincipalId?: string;
  expectedActorAuthzVersion?: number;
  expectedActorPermissionExpiresAt?: string | null;
};

export type EffectivePermissionsInput = {
  tenantId: string;
  principalId: string;
  at?: Date;
};

export type LegacyUserRoleBinding = PrincipalRoleBindingDto;
