import type {
  AssignPrincipalRoleBindingInput,
  CreateAgentPrincipalInput,
  EffectivePermissionsInput,
  LegacyUserRoleBinding,
  PrincipalDto,
  PrincipalKind,
  PrincipalRoleBindingDto,
  RemovePrincipalRoleBindingInput,
  UpdateAgentPrincipalInput,
} from "../authorization/types";

export type ResolvedAuthorizationTarget = {
  kind: string;
  id: string;
  tenantId: string;
  deptId: string | null;
  ownerUserId: string | null;
};

export type RoleDefinition = {
  id: string;
  tenantId: string;
  code: string;
  scopes: string[];
  immutable: boolean;
};

export type PrincipalListFilter = {
  kind?: PrincipalKind;
  /** Restrict a role-detail projection to its already-resolved bindings. */
  principalIds?: string[];
  /** User principal visibility predicate, resolved by the admin route. */
  userIds?: string[];
  /** User principal visibility by the user's current department. */
  userDepartmentIds?: string[];
  /** Delegated-agent visibility by its owner user. */
  agentOwnerUserIds?: string[];
  /** Delegated-agent visibility by the owner's department. */
  agentOwnerDepartmentIds?: string[];
};

export interface PrincipalsRepository {
  readonly dialect: "postgresql" | "mysql";
  getPrincipal(tenantId: string, principalId: string): Promise<PrincipalDto | null>;
  getPrincipalForUser(tenantId: string, userId: string): Promise<PrincipalDto | null>;
  getUserStatus(tenantId: string, userId: string): Promise<"active" | "disabled" | "locked" | "missing">;
  ensureUserPrincipal(tenantId: string, userId: string): Promise<PrincipalDto | null>;
  listPrincipals(tenantId: string, filter?: PrincipalListFilter): Promise<PrincipalDto[]>;
  createAgentPrincipal(input: CreateAgentPrincipalInput): Promise<PrincipalDto>;
  updateAgentPrincipal(input: UpdateAgentPrincipalInput): Promise<PrincipalDto>;
  listPrincipalRoleBindings(tenantId: string, principalId: string): Promise<PrincipalRoleBindingDto[]>;
  listPrincipalRoleBindingsForRole(tenantId: string, roleId: string): Promise<PrincipalRoleBindingDto[]>;
  getPrincipalRoleBinding(tenantId: string, bindingId: string): Promise<PrincipalRoleBindingDto | null>;
  assignPrincipalRoleBinding(input: AssignPrincipalRoleBindingInput): Promise<PrincipalRoleBindingDto>;
  removePrincipalRoleBinding(input: RemovePrincipalRoleBindingInput): Promise<void>;
  getPrincipalEffectivePermissions(input: EffectivePermissionsInput): Promise<PrincipalRoleBindingDto[]>;
  getRoleDefinition(
    tenantId: string,
    input: { roleId?: string; roleCode?: string },
  ): Promise<RoleDefinition | null>;
  listRoleDefinitions(tenantId: string): Promise<RoleDefinition[]>;
  countActiveUsersWithRole(tenantId: string, roleCode: string): Promise<number>;
  listLegacyUserRoleBindings(tenantId: string, userId: string): Promise<LegacyUserRoleBinding[]>;
  syncUserRoleCodes(input: {
    tenantId: string;
    userId: string;
    roleCodes: string[];
    defaultOrgId: string | null;
    defaultDeptId: string | null;
  }, dbOrTx?: unknown): Promise<void>;
  resolveAuthorizationTarget(
    tenantId: string,
    target: { kind: string; id: string },
  ): Promise<ResolvedAuthorizationTarget | null>;
  departmentScopeContains(
    tenantId: string,
    scopeDeptId: string,
    targetDeptId: string,
    subtree: boolean,
  ): Promise<boolean>;
}
