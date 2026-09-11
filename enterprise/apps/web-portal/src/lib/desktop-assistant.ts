import {
  ActionRegistry,
  ActionRuntime,
  AssistantSessionError,
  ASSISTANT_AUTH_REVOKED,
  ASSISTANT_CAPABILITY_DENIED,
  ASSISTANT_REAUTH_REQUIRED,
  ASSISTANT_SESSION_REVOKED,
  ENTERPRISE_CONTEXT_STALE,
  authenticateAssistantSession,
  hashAssistantSessionToken,
  issueAssistantSession,
  requestContextFromSession,
  sessionTokenFromRequest,
  staleContextError,
  SqlActionStore,
  type ActionRequestContext,
  type ActionSession,
  type ActionStoreTransaction,
  type AssistantPermissionMode,
} from "@agenticx/action-runtime";
import { ENTERPRISE_ASSISTANT_CAPABILITY_ID } from "@agenticx/config";
import { createEnterpriseActionDefinitions } from "@agenticx/enterprise-domain";
import {
  createAgentPrincipal,
  ensureSystemRoles,
  ensureUserPrincipal,
  getAdminUser,
  getPrincipalForUser,
  getUserAuthorizationContext,
  listPrincipalRoleBindings,
  listPrincipals,
  listPats,
  authorizePrincipalAction,
  resolveDatabaseConfig,
  type PrincipalDto,
} from "@agenticx/iam-core";
import { createHash } from "node:crypto";
import { resolveDesktopIdentity, type DesktopIdentity } from "./desktop-auth";
import {
  capabilityAuthorizationRevision,
  isCapabilityAllowedForUser,
  isCapabilityAllowedForUserInTransaction,
} from "./capability-packs-reader";

export type DesktopAssistantPrincipal = {
  id: string;
  userId: string;
  tenantId: string;
  displayName: string;
  roleCodes: string[];
};

export type DesktopAssistantContext = {
  identity: DesktopIdentity;
  session: ActionSession;
  sessionToken?: string;
  request: ActionRequestContext;
  principal: DesktopAssistantPrincipal;
};

const assistantStore = new SqlActionStore();
const assistantRegistry = new ActionRegistry(createEnterpriseActionDefinitions());
const assistantRuntime = new ActionRuntime({
  registry: assistantRegistry,
  store: assistantStore,
  authorization: {
    authorize: async ({ request, action, target }) => authorizePrincipalAction({
      tenantId: request.tenantId,
      userId: request.userId,
      agentPrincipalId: request.agentPrincipalId,
      requiredScopes: [...action.requiredScopes],
      target,
    }),
    authorizationVersion: computeAuthorizationVersion,
    capability: {
      authorize: async ({ request, capabilityId, transaction }) => {
        const user = await getAdminUser(request.tenantId, request.userId);
        if (!user || user.status !== "active") {
          return {
            allowed: false,
            reason: "user_disabled",
            publicReason: "enterprise user is not active",
          };
        }
        const allowed = transaction
          ? await isCapabilityAllowedForUserInTransaction({
              transaction,
              tenantId: request.tenantId,
              userId: request.userId,
              capabilityId,
              email: user.email,
              deptId: user.deptId,
            })
          : await isCapabilityAllowedForUser(
              request.tenantId,
              request.userId,
              capabilityId,
              user.email,
              user.deptId,
            );
        return {
          allowed,
          reason: allowed ? "allowed" : "capability_not_granted",
          publicReason: allowed ? "allowed" : "enterprise capability is not enabled for this user",
        };
      },
      prepareDispatch: async ({ request, capabilityId, transaction }) => {
        const user = await getAdminUser(request.tenantId, request.userId);
        if (!user || user.status !== "active") {
          return {
            allowed: false,
            reason: "user_disabled",
            publicReason: "enterprise user is not active",
          };
        }
        const allowed = await isCapabilityAllowedForUserInTransaction({
          transaction,
          tenantId: request.tenantId,
          userId: request.userId,
          capabilityId,
          email: user.email,
          deptId: user.deptId,
        });
        if (!allowed) {
          return {
            allowed: false,
            reason: "capability_not_granted",
            publicReason: "enterprise capability is not enabled for this user",
          };
        }
        return { allowed: true };
      },
      requiresTransactionalDispatch: true,
    },
  },
});

const agentLocks = new Map<string, Promise<PrincipalDto>>();

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stable(object[key])}`).join(",")}}`;
}

function hashVersion(value: unknown): string {
  return createHash("sha256").update(stable(value), "utf8").digest("hex");
}

function activeBinding(binding: { status: string; resolution: string; expiresAt: string | null }, now: number): boolean {
  return binding.status === "active" && binding.resolution === "resolved" && (!binding.expiresAt || new Date(binding.expiresAt).getTime() > now);
}

/**
 * Resolve the durable per-user personal-assistant identity.  The in-process
 * promise only coalesces local callers; createAgentPrincipal also locks the
 * owner row in the database, so the identity remains stable across workers.
 */
export async function ensurePersonalAssistantAgent(tenantId: string, userId: string): Promise<PrincipalDto> {
  const key = `${tenantId}:${userId}`;
  const current = agentLocks.get(key);
  if (current) return current;
  const run = (async () => {
    await ensureSystemRoles(tenantId);
    const principals = await listPrincipals(tenantId);
    const existingMatches = principals
      .filter((principal) => principal.kind === "agent" && principal.agentProfile?.mode === "delegated" && principal.agentProfile.ownerUserId === userId && principal.agentProfile.definitionRef === "personal_assistant")
      .sort((left, right) => left.id.localeCompare(right.id));
    const existing = existingMatches[0];
    if (existing) {
      if (existingMatches.some((principal) => principal.status !== "active")) {
        throw new AssistantSessionError(ASSISTANT_AUTH_REVOKED, "personal assistant authorization is disabled", 401);
      }
      // Re-enter through the repository so agents created before delegated
      // owner inheritance was introduced lose their fixed role ceiling.
      return createAgentPrincipal({
        tenantId,
        displayName: existing.displayName || "Personal Assistant",
        mode: "delegated",
        ownerUserId: userId,
        definitionRef: "personal_assistant",
        definitionVersion: existing.agentProfile?.definitionVersion ?? 1,
        actorUserId: null,
      });
    }
    return createAgentPrincipal({
      tenantId,
      displayName: "Personal Assistant",
      mode: "delegated",
      ownerUserId: userId,
      definitionRef: "personal_assistant",
      definitionVersion: 1,
      actorUserId: null,
    });
  })();
  agentLocks.set(key, run);
  try {
    return await run;
  } finally {
    if (agentLocks.get(key) === run) agentLocks.delete(key);
  }
}

export async function computeAuthorizationVersion(
  request: Pick<ActionRequestContext, "tenantId" | "userId" | "agentPrincipalId">,
  transaction?: ActionStoreTransaction,
): Promise<string> {
  const userContext = await getUserAuthorizationContext(request.tenantId, request.userId);
  const user = await getAdminUser(request.tenantId, request.userId);
  const capabilityRevision = await capabilityAuthorizationRevision(
    request.tenantId,
    request.userId,
    user?.email,
    user?.deptId,
    transaction,
  );
  const agent = await (async () => {
    const rows = await listPrincipals(request.tenantId);
    return rows.find((principal) => principal.id === request.agentPrincipalId) ?? null;
  })();
  const agentBindings = agent ? await listPrincipalRoleBindings({ tenantId: request.tenantId, principalId: agent.id }) : [];
  const now = Date.now();
  return hashVersion({
    user: {
      id: userContext.userPrincipal?.id ?? null,
      authzVersion: userContext.userPrincipal?.authzVersion ?? 0,
      status: userContext.userStatus,
      deptId: user?.deptId ?? null,
      bindings: userContext.bindings.map((binding) => ({
        id: binding.id,
        principalId: binding.principalId,
        roleId: binding.roleId,
        roleCode: binding.roleCode,
        scopes: [...binding.scopes].sort(),
        dataScope: binding.dataScope,
        scopeOrgId: binding.scopeOrgId,
        scopeDeptId: binding.scopeDeptId,
        expiresAt: binding.expiresAt,
        active: activeBinding(binding, now),
        status: binding.status,
        resolution: binding.resolution,
        source: binding.source,
        createdByUserId: binding.createdByUserId,
        grantedByPrincipalId: binding.grantedByPrincipalId,
        canDelegate: binding.canDelegate,
        grantorApprovalRef: binding.grantorApprovalRef,
      })),
    },
    agent: agent
      ? {
          id: agent.id,
          status: agent.status,
          authzVersion: agent.authzVersion,
          profile: agent.agentProfile,
          bindings: agentBindings.map((binding) => ({
            id: binding.id,
            roleId: binding.roleId,
            roleCode: binding.roleCode,
            scopes: [...binding.scopes].sort(),
            dataScope: binding.dataScope,
            scopeOrgId: binding.scopeOrgId,
            scopeDeptId: binding.scopeDeptId,
            expiresAt: binding.expiresAt,
            active: activeBinding(binding, now),
            status: binding.status,
            resolution: binding.resolution,
            source: binding.source,
            createdByUserId: binding.createdByUserId,
            grantedByPrincipalId: binding.grantedByPrincipalId,
            canDelegate: binding.canDelegate,
            grantorApprovalRef: binding.grantorApprovalRef,
          })),
        }
      : null,
    capabilities: capabilityRevision,
  });
}

function principalDto(userPrincipal: PrincipalDto, roleCodes: string[]): DesktopAssistantPrincipal {
  return {
    id: userPrincipal.id,
    userId: userPrincipal.userId ?? "",
    tenantId: userPrincipal.tenantId,
    displayName: userPrincipal.displayName ?? "",
    roleCodes,
  };
}

async function requireIdentity(request: Request): Promise<DesktopIdentity> {
  const identity = await resolveDesktopIdentity(request);
  if (!identity) throw new AssistantSessionError(ASSISTANT_REAUTH_REQUIRED, "enterprise PAT is invalid or expired", 401);
  if (!identity.scopes.includes("assistant:delegate")) {
    throw new AssistantSessionError(ASSISTANT_REAUTH_REQUIRED, "this PAT must be reissued with assistant:delegate", 403);
  }
  return identity;
}

/**
 * Action requests carry the short-lived assistant token as their bearer.  The
 * originating PAT therefore cannot be recovered from the Authorization
 * header; resolve it from the persisted session binding and re-read the PAT
 * row before every request.  This keeps revocation/expiry effective without
 * putting a second long-lived credential in the model-visible protocol.
 */
async function identityForAssistantSession(session: ActionSession): Promise<DesktopIdentity> {
  if (session.originKind !== "desktop_pat" || session.originatingPatId === null) {
    throw new AssistantSessionError(
      ASSISTANT_REAUTH_REQUIRED,
      "cookie-owned assistant sessions cannot be used by the desktop PAT endpoint",
      401,
    );
  }
  const pats = await listPats({ tenantId: session.tenantId, userId: session.userId });
  const pat = pats.find((candidate) => candidate.id === session.originatingPatId);
  if (!pat || pat.status !== "active") {
    throw new AssistantSessionError(ASSISTANT_AUTH_REVOKED, "the originating PAT is no longer active", 401);
  }
  if (pat.expireAt && new Date(pat.expireAt).getTime() <= Date.now()) {
    throw new AssistantSessionError(ASSISTANT_AUTH_REVOKED, "the originating PAT has expired", 401);
  }
  if (!pat.scopes.includes("assistant:delegate")) {
    // A session must never turn an older, narrower PAT into a delegated one.
    throw new AssistantSessionError(ASSISTANT_REAUTH_REQUIRED, "this PAT must be reissued with assistant:delegate", 403);
  }
  const user = await getAdminUser(session.tenantId, session.userId);
  if (!user || user.status !== "active") {
    throw new AssistantSessionError(ASSISTANT_AUTH_REVOKED, "enterprise user is no longer active", 401);
  }
  return {
    userId: user.id,
    tenantId: user.tenantId,
    deptId: user.deptId ?? null,
    email: user.email,
    displayName: user.displayName ?? "",
    tokenId: pat.id,
    patExpiresAt: pat.expireAt,
    scopes: [...pat.scopes],
  };
}

async function loadPrincipalContext(identity: DesktopIdentity): Promise<{ userPrincipal: PrincipalDto; agent: PrincipalDto; roleCodes: string[]; authorizationVersion: string }> {
  const entryAllowed = await isCapabilityAllowedForUser(
    identity.tenantId,
    identity.userId,
    ENTERPRISE_ASSISTANT_CAPABILITY_ID,
    identity.email,
    identity.deptId,
  );
  if (!entryAllowed) {
    throw new AssistantSessionError(
      ASSISTANT_CAPABILITY_DENIED,
      "enterprise assistant is not enabled for this user",
      403,
    );
  }
  // Check the built-in entry pack before provisioning a principal.  A denied
  // user should not receive an empty durable principal as a side effect; that
  // row would otherwise become an explicit ceiling and hide later legacy role
  // backfills when an administrator enables the assistant.
  const userPrincipal = await ensureUserPrincipal(identity.tenantId, identity.userId);
  if (!userPrincipal || userPrincipal.status !== "active") throw new AssistantSessionError(ASSISTANT_AUTH_REVOKED, "enterprise user principal is not active", 401);
  const agent = await ensurePersonalAssistantAgent(identity.tenantId, identity.userId);
  if (agent.status !== "active" || agent.agentProfile?.ownerUserId !== identity.userId || agent.agentProfile.mode !== "delegated") throw new AssistantSessionError(ASSISTANT_AUTH_REVOKED, "personal assistant authorization is no longer active", 401);
  const authorizationVersion = await computeAuthorizationVersion({ tenantId: identity.tenantId, userId: identity.userId, agentPrincipalId: agent.id });
  const context = await getUserAuthorizationContext(identity.tenantId, identity.userId);
  return { userPrincipal, agent, roleCodes: context.roleCodes, authorizationVersion };
}

export async function createDesktopAssistantSession(input: {
  request: Request;
  studioSessionId: string;
  permissionMode: AssistantPermissionMode;
}): Promise<DesktopAssistantContext> {
  const identity = await requireIdentity(input.request);
  const { userPrincipal, agent, roleCodes, authorizationVersion } = await loadPrincipalContext(identity);
  const issued = await issueAssistantSession({
    store: assistantStore,
    tenantId: identity.tenantId,
    userId: identity.userId,
    agentPrincipalId: agent.id,
    originatingPatId: identity.tokenId,
    originKind: "desktop_pat",
    studioSessionId: input.studioSessionId,
    permissionMode: input.permissionMode,
    authorizationVersion,
    patExpiresAt: identity.patExpiresAt,
  });
  return {
    identity,
    session: issued.session,
    sessionToken: issued.token,
    request: requestContextFromSession({ session: issued.session, principal: userPrincipal, authorizationVersion }),
    principal: principalDto(userPrincipal, roleCodes),
  };
}

export async function authenticateDesktopAssistantRequest(request: Request): Promise<DesktopAssistantContext> {
  const token = sessionTokenFromRequest(request);
  if (!token) throw new AssistantSessionError(ASSISTANT_REAUTH_REQUIRED, "assistant session bearer is required", 401);
  // Resolve the session first.  Its tenant/user/PAT binding is server-owned,
  // so a caller cannot select another identity by supplying headers or body
  // fields.  A revoked/expired session is reported distinctly before PAT
  // lookup; an active session then revalidates the originating PAT live.
  const candidate = await assistantStore.getSessionByTokenHash(
    hashAssistantSessionToken(token),
  );
  if (!candidate) throw new AssistantSessionError(ASSISTANT_REAUTH_REQUIRED, "assistant session is invalid", 401);
  if (candidate.status === "revoked" || candidate.status === "expired" || new Date(candidate.expiresAt).getTime() <= Date.now()) {
    throw new AssistantSessionError(ASSISTANT_SESSION_REVOKED, "assistant session has expired or was revoked", 401);
  }
  const identity = await identityForAssistantSession(candidate);
  const session = await authenticateAssistantSession({ store: assistantStore, token, identity });
  const { userPrincipal, agent, roleCodes, authorizationVersion } = await loadPrincipalContext(identity);
  if (agent.id !== session.agentPrincipalId) throw new AssistantSessionError(ASSISTANT_AUTH_REVOKED, "personal assistant principal changed", 401);
  if (authorizationVersion !== session.authorizationVersion) throw staleContextError(authorizationVersion);
  return {
    identity,
    session,
    request: requestContextFromSession({ session, principal: userPrincipal, authorizationVersion: session.authorizationVersion }),
    principal: principalDto(userPrincipal, roleCodes),
  };
}

export function assistantActionRuntime(): ActionRuntime {
  return assistantRuntime;
}

export function assistantActionRegistry(): ActionRegistry {
  return assistantRegistry;
}

export function assistantErrorResponse(error: unknown): { body: Record<string, unknown>; status: number } {
  if (error instanceof AssistantSessionError) return { body: { code: error.code, message: error.message, ...(error.stale ? { stale: true } : {}) }, status: error.status };
  const candidate = error as { code?: unknown; status?: unknown; details?: unknown; message?: unknown };
  const code = typeof candidate?.code === "string" ? candidate.code : "ACTION_EXECUTION_FAILED";
  const status = typeof candidate?.status === "number" && candidate.status >= 400 && candidate.status <= 599 ? candidate.status : code === "ACTION_FORBIDDEN" ? 403 : 400;
  return { body: { code, message: typeof candidate?.message === "string" ? candidate.message : "action request failed", ...(candidate?.details && typeof candidate.details === "object" ? { details: candidate.details } : {}) }, status };
}
