import {
  authorizePrincipalAction,
  expandRoleScopes,
  getDepartmentsRepository,
  getUserAuthorizationContext,
  getAdminUser,
  hasEveryScope,
  hasSomeScope,
  type AuthorizationContext,
  type AuthorizationDecision,
  type AuthorizationTarget,
} from "@agenticx/iam-core";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { ADMIN_SESSION_COOKIE, verifyAdminSessionToken } from "./admin-session";

export type AdminSession = {
  email: string;
  userId: string;
  tenantId: string;
};

export type AdminScopedCapabilityOptions = {
  /** Optional server-resolved target. Never use a client supplied tenantId. */
  target?: AuthorizationTarget;
  /** Reserved for delegated assistant calls; admin routes normally omit it. */
  agentPrincipalId?: string;
};

export type AdminAuthSuccess = {
  ok: true;
  session: AdminSession;
  context: AuthorizationContext;
  scopes: string[];
  decision?: AuthorizationDecision;
};

export type AdminUserVisibility = {
  tenantWide: boolean;
  userIds: string[];
  departmentIds: string[];
};

export async function getAdminSession(): Promise<AdminSession | null> {
  const store = await cookies();
  const token = store.get(ADMIN_SESSION_COOKIE)?.value;
  const payload = verifyAdminSessionToken(token);
  if (!payload) return null;
  // Cookie 签名只证明它曾经签发过；禁用、锁定和删除必须在下一次请求立即生效。
  const user = await getAdminUser(payload.tenantId, payload.userId);
  if (!user || user.status !== "active") return null;
  return { email: user.email, userId: payload.userId, tenantId: payload.tenantId };
}

export async function requireAdminSession() {
  const session = await getAdminSession();
  if (!session) {
    return {
      ok: false as const,
      response: NextResponse.json({ code: "40101", message: "unauthorized" }, { status: 401 }),
    };
  }
  return { ok: true as const, session };
}

function unauthorizedResponse() {
  return NextResponse.json({ code: "40101", message: "unauthorized" }, { status: 401 });
}

function forbiddenResponse() {
  return NextResponse.json({ code: "40300", message: "forbidden" }, { status: 403 });
}

function hasCapability(scopes: string[], required: string[], some: boolean): boolean {
  const expanded = expandRoleScopes(scopes);
  return some ? hasSomeScope(expanded, required) : hasEveryScope(expanded, required);
}

type ScopedCapabilityRequest = {
  requiredScopes: string[];
  options?: AdminScopedCapabilityOptions;
};

/**
 * Authenticate an admin request and check a capability.  With no target this
 * intentionally performs only the capability check; callers must subsequently
 * filter or authorize each target.  Supplying a target performs the complete
 * action+target check using the shared IAM core resolver.
 */
export async function requireAdminScopedCapability(
  requiredScopes: string[],
  options?: AdminScopedCapabilityOptions,
): Promise<AdminAuthSuccess | { ok: false; response: NextResponse }>;
export async function requireAdminScopedCapability(
  request: ScopedCapabilityRequest,
): Promise<AdminAuthSuccess | { ok: false; response: NextResponse }>;
export async function requireAdminScopedCapability(
  requiredOrRequest: string[] | ScopedCapabilityRequest,
  options?: AdminScopedCapabilityOptions,
): Promise<AdminAuthSuccess | { ok: false; response: NextResponse }> {
  const requiredScopes = Array.isArray(requiredOrRequest)
    ? requiredOrRequest
    : requiredOrRequest.requiredScopes;
  const resolvedOptions = Array.isArray(requiredOrRequest)
    ? options
    : requiredOrRequest.options;
  const session = await getAdminSession();
  if (!session) return { ok: false, response: unauthorizedResponse() };

  const context = await getUserAuthorizationContext(session.tenantId, session.userId);
  if (context.userStatus !== "active" || context.userPrincipal?.status !== "active") {
    return { ok: false, response: unauthorizedResponse() };
  }
  const scopes = context.scopes;
  if (!hasCapability(scopes, requiredScopes, false)) {
    return { ok: false, response: forbiddenResponse() };
  }

  if (resolvedOptions?.target) {
    const decision = await authorizePrincipalAction({
      tenantId: session.tenantId,
      userId: session.userId,
      agentPrincipalId: resolvedOptions.agentPrincipalId,
      requiredScopes,
      target: resolvedOptions.target,
    });
    if (!decision.allowed) return { ok: false, response: forbiddenResponse() };
    return { ok: true, session, context, scopes, decision };
  }
  return { ok: true, session, context, scopes };
}

/**
 * Legacy tenant-level guard.  It deliberately authorizes the tenant target so
 * a department/self binding cannot silently use an unscoped old endpoint.
 */
export async function requireAdminScope(required: string[]) {
  const session = await getAdminSession();
  if (!session) return { ok: false as const, response: unauthorizedResponse() };
  const result = await requireAdminScopedCapability(required, {
    target: { kind: "tenant", id: session.tenantId },
  });
  if (!result.ok) return result;
  return result;
}

/** Target-aware route helper for a single object. */
export async function requireAdminTarget(
  requiredScopes: string[],
  target: AuthorizationTarget,
) {
  return requireAdminScopedCapability(requiredScopes, { target });
}

/** Authenticate an admin request when any one of several capabilities is sufficient. */
export async function requireAdminSomeScopedCapability(
  candidates: string[],
  options?: AdminScopedCapabilityOptions,
): Promise<AdminAuthSuccess | { ok: false; response: NextResponse }> {
  const session = await getAdminSession();
  if (!session) return { ok: false, response: unauthorizedResponse() };
  const context = await getUserAuthorizationContext(session.tenantId, session.userId);
  if (context.userStatus !== "active" || context.userPrincipal?.status !== "active") {
    return { ok: false, response: unauthorizedResponse() };
  }
  const scopes = context.scopes;
  if (!hasCapability(scopes, candidates, true)) return { ok: false, response: forbiddenResponse() };
  if (!options?.target) return { ok: true, session, context, scopes };
  const decisions = await Promise.all(candidates.map((scope) => authorizePrincipalAction({
    tenantId: session.tenantId,
    userId: session.userId,
    agentPrincipalId: options.agentPrincipalId,
    requiredScopes: [scope],
    target: options.target!,
  })));
  const decision = decisions.find((item) => item.allowed);
  return decision
    ? { ok: true, session, context, scopes, decision }
    : { ok: false, response: forbiddenResponse() };
}

/**
 * Resolve the set of users visible for a scope without loading users first.
 * Department subtree expansion is bounded to one directory read and is then
 * passed to the repository as a parameterized IN predicate.
 */
export async function resolveAdminUserVisibility(
  tenantId: string,
  context: AuthorizationContext,
  requiredScope = "user:read",
): Promise<AdminUserVisibility> {
  const permissions = context.effectivePermissions.filter(
    (permission) => permission.scope === requiredScope && permission.resolution === "resolved",
  );
  if (permissions.some((permission) => permission.dataScope === "tenant")) {
    return { tenantWide: true, userIds: [], departmentIds: [] };
  }

  const userIds = new Set<string>();
  const directDepartmentIds = new Set<string>();
  const subtreeRoots = new Set<string>();
  for (const permission of permissions) {
    if (permission.dataScope === "self") userIds.add(context.userId);
    if (permission.dataScope === "department" && permission.scopeDeptId) {
      directDepartmentIds.add(permission.scopeDeptId);
    }
    if (permission.dataScope === "department_subtree" && permission.scopeDeptId) {
      subtreeRoots.add(permission.scopeDeptId);
    }
  }

  if (subtreeRoots.size) {
    const departments = await getDepartmentsRepository().listDepartmentsFlat(tenantId);
    const byId = new Map(departments.map((department) => [department.id, department]));
    for (const rootId of subtreeRoots) {
      const root = byId.get(rootId);
      if (!root) continue;
      for (const department of departments) {
        if (department.path === root.path || department.path.startsWith(root.path)) {
          directDepartmentIds.add(department.id);
        }
      }
    }
  }
  return {
    tenantWide: false,
    userIds: [...userIds],
    departmentIds: [...directDepartmentIds],
  };
}

/** Same range resolution for agent listings (service agents need tenant scope). */
export async function resolveAdminAgentVisibility(
  tenantId: string,
  context: AuthorizationContext,
  requiredScope = "agent:read",
): Promise<{ tenantWide: boolean; ownerUserIds: string[]; ownerDepartmentIds: string[] }> {
  const permissions = context.effectivePermissions.filter(
    (permission) => permission.scope === requiredScope && permission.resolution === "resolved",
  );
  if (permissions.some((permission) => permission.dataScope === "tenant")) {
    return { tenantWide: true, ownerUserIds: [], ownerDepartmentIds: [] };
  }
  const ownerUserIds = new Set<string>();
  const ownerDepartmentIds = new Set<string>();
  const subtreeRoots = new Set<string>();
  for (const permission of permissions) {
    if (permission.dataScope === "self") ownerUserIds.add(context.userId);
    if (permission.dataScope === "department" && permission.scopeDeptId) ownerDepartmentIds.add(permission.scopeDeptId);
    if (permission.dataScope === "department_subtree" && permission.scopeDeptId) subtreeRoots.add(permission.scopeDeptId);
  }
  if (subtreeRoots.size) {
    const departments = await getDepartmentsRepository().listDepartmentsFlat(tenantId);
    const byId = new Map(departments.map((department) => [department.id, department]));
    for (const rootId of subtreeRoots) {
      const root = byId.get(rootId);
      if (!root) continue;
      for (const department of departments) {
        if (department.path === root.path || department.path.startsWith(root.path)) ownerDepartmentIds.add(department.id);
      }
    }
  }
  return { tenantWide: false, ownerUserIds: [...ownerUserIds], ownerDepartmentIds: [...ownerDepartmentIds] };
}

/** Some-scope tenant guard retained for read-only legacy endpoints. */
export async function requireAdminSomeScope(candidates: string[]) {
  const session = await getAdminSession();
  if (!session) return { ok: false as const, response: unauthorizedResponse() };
  return requireAdminSomeScopedCapability(candidates, {
    target: { kind: "tenant", id: session.tenantId },
  });
}
