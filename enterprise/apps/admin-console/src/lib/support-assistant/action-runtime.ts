import {
  ActionRegistry,
  ActionRuntime,
  ActionForbiddenError,
  ActionValidationError,
  issueAssistantSession,
  requestContextFromSession,
  SqlActionStore,
  type ActionRequestContext,
  type ActionSession,
  type ActionStoreTransaction,
  type AssistantActionInvocationResult,
  type PublicAction,
} from "@agenticx/action-runtime";
import { createEnterpriseActionDefinitions } from "@agenticx/enterprise-domain";
import {
  authorizePrincipalAction,
  createAgentPrincipal,
  ensureSystemRoles,
  ensureUserPrincipal,
  getAdminUser,
  getUserAuthorizationContext,
  listPrincipalRoleBindings,
  listPrincipals,
  type PrincipalDto,
} from "@agenticx/iam-core";
import { ENTERPRISE_ASSISTANT_CAPABILITY_ID } from "@agenticx/config";
import { createHash, randomBytes } from "node:crypto";
import type { SupportProposalChange } from "@agenticx/ui/support/contracts";
import type { AdminSession } from "../admin-auth";
import type { SupportProposal } from "./types";

// Keep capability-pack lookup in the existing server-only reader so admin and
// Desktop use the same assignment, opt-out, and revision semantics. Loading it
// on demand also lets an unconfigured installation fail closed at adapter
// creation instead of inventing a second capability implementation here.
async function capabilityPackReader() {
  return import("../../../../web-portal/src/lib/capability-packs-reader");
}

type SupportRuntimeContext = {
  request: ActionRequestContext;
  session: ActionSession;
};

export type SupportActionAdapter = {
  discover: (signal?: AbortSignal) => Promise<readonly PublicAction[]>;
  invoke: (input: {
    actionId: string;
    arguments: Record<string, unknown>;
    idempotencyKey: string;
    signal?: AbortSignal;
  }) => Promise<AssistantActionInvocationResult>;
};

const store = new SqlActionStore();
const registry = new ActionRegistry(createEnterpriseActionDefinitions());
const agentLocks = new Map<string, Promise<PrincipalDto>>();
const sessionLocks = new Map<string, Promise<SupportRuntimeContext>>();

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stable(object[key])}`).join(",")}}`;
}

function hash(value: unknown): string {
  return createHash("sha256").update(stable(value), "utf8").digest("hex");
}

function activeBinding(binding: { status: string; resolution: string; expiresAt: string | null }, now: number): boolean {
  return binding.status === "active"
    && binding.resolution === "resolved"
    && (!binding.expiresAt || new Date(binding.expiresAt).getTime() > now);
}

async function ensureSupportAgent(tenantId: string, userId: string): Promise<PrincipalDto> {
  const key = `${tenantId}:${userId}`;
  const existing = agentLocks.get(key);
  if (existing) return existing;
  const pending = (async () => {
    await ensureSystemRoles(tenantId);
    const principals = await listPrincipals(tenantId);
    const agentMatches = principals
      .filter((principal) => principal.kind === "agent"
        && principal.agentProfile?.mode === "delegated"
        && principal.agentProfile.ownerUserId === userId
        && principal.agentProfile.definitionRef === "personal_assistant")
      .sort((left, right) => left.id.localeCompare(right.id));
    const agent = agentMatches[0];
    if (agent) {
      if (agentMatches.some((principal) => principal.status !== "active")) {
        throw Object.assign(new Error("support assistant authorization is disabled"), {
          code: "ASSISTANT_AUTH_REVOKED",
          status: 401,
        });
      }
      return agent;
    }
    return createAgentPrincipal({
      tenantId,
      displayName: "Personal Assistant",
      mode: "delegated",
      ownerUserId: userId,
      definitionRef: "personal_assistant",
      definitionVersion: 1,
      // This is an internal assistant subject.  It is never a user-grantable
      // agent:create path and receives only the immutable action ceiling.
      actorUserId: null,
    });
  })();
  agentLocks.set(key, pending);
  try {
    return await pending;
  } finally {
    if (agentLocks.get(key) === pending) agentLocks.delete(key);
  }
}

async function authorizationVersion(
  tenantId: string,
  userId: string,
  agent: PrincipalDto,
  transaction?: ActionStoreTransaction,
): Promise<string> {
  const userContext = await getUserAuthorizationContext(tenantId, userId);
  const user = await getAdminUser(tenantId, userId);
  const capabilityReader = await capabilityPackReader();
  const capabilityRevision = await capabilityReader.capabilityAuthorizationRevision(
    tenantId,
    userId,
    user?.email,
    user?.deptId,
    transaction,
  );
  const bindings = await listPrincipalRoleBindings(tenantId, agent.id);
  const now = Date.now();
  return hash({
    user: {
      id: userContext.userPrincipal?.id ?? null,
      authzVersion: userContext.userPrincipal?.authzVersion ?? 0,
      status: userContext.userStatus,
      deptId: user?.deptId ?? null,
      bindings: userContext.bindings.map((binding) => ({
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
      })),
    },
    agent: {
      id: agent.id,
      status: agent.status,
      authzVersion: agent.authzVersion,
      profile: agent.agentProfile,
      bindings: bindings.map((binding) => ({
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
      })),
    },
    capabilities: capabilityRevision,
  });
}

function supportSessionId(actor: AdminSession): string {
  return `support:${actor.tenantId}:${actor.userId}`;
}

async function getSupportContext(actor: AdminSession): Promise<SupportRuntimeContext> {
  const key = `${actor.tenantId}:${actor.userId}`;
  const existing = sessionLocks.get(key);
  if (existing) return existing;
  const pending = (async () => {
    const principal = await ensureUserPrincipal(actor.tenantId, actor.userId);
    if (!principal || principal.status !== "active") throw new Error("support administrator is no longer active");
    const user = await getAdminUser(actor.tenantId, actor.userId);
    if (!user || user.status !== "active") throw new Error("support administrator is no longer active");
    const capabilityReader = await capabilityPackReader();
    const entryAllowed = await capabilityReader.isCapabilityAllowedForUser(
      actor.tenantId,
      actor.userId,
      ENTERPRISE_ASSISTANT_CAPABILITY_ID,
      user.email,
      user.deptId,
    );
    if (!entryAllowed) throw new Error("enterprise assistant is not enabled for this administrator");
    const agent = await ensureSupportAgent(actor.tenantId, actor.userId);
    if (agent.status !== "active" || agent.agentProfile?.ownerUserId !== actor.userId || agent.agentProfile.mode !== "delegated") {
      throw new Error("support assistant principal is no longer active");
    }
    const version = await authorizationVersion(actor.tenantId, actor.userId, agent);
    const issued = await issueAssistantSession({
      store,
      tenantId: actor.tenantId,
      userId: actor.userId,
      agentPrincipalId: agent.id,
      // Cookie-authenticated support has no PAT provenance.  Keep that fact
      // explicit in the durable session instead of manufacturing a token id.
      originatingPatId: null,
      originKind: "admin_cookie",
      studioSessionId: supportSessionId(actor),
      permissionMode: "ask",
      authorizationVersion: version,
    });
    return {
      session: issued.session,
      request: requestContextFromSession({ session: issued.session, principal, authorizationVersion: version }),
    };
  })();
  sessionLocks.set(key, pending);
  try {
    return await pending;
  } finally {
    if (sessionLocks.get(key) === pending) sessionLocks.delete(key);
  }
}

function supportActionError(error: unknown): AssistantActionInvocationResult {
  const candidate = error as { code?: unknown; message?: unknown };
  const code = typeof candidate?.code === "string" ? candidate.code : "ACTION_EXECUTION_FAILED";
  const message = typeof candidate?.message === "string" && candidate.message.trim()
    ? candidate.message.trim().slice(0, 512)
    : "action failed";
  const status = error instanceof ActionValidationError
    ? "invalid"
    : error instanceof ActionForbiddenError || code === "ACTION_FORBIDDEN"
      ? "denied"
      : "failed";
  return { status, error: { code, message } };
}

/**
 * Server-owned support transport.  The model receives only the capability
 * snapshot and structured action results; it never receives this context,
 * the durable session token, or a database handle.
 */
export async function createSupportActionAdapter(actor: AdminSession): Promise<SupportActionAdapter> {
  const context = await getSupportContext(actor);
  return {
    discover: async (signal) => {
      if (signal?.aborted) throw signal.reason ?? new Error("support action discovery cancelled");
      const actions = await runtime.capabilities(context.request);
      if (signal?.aborted) throw signal.reason ?? new Error("support action discovery cancelled");
      return actions;
    },
    invoke: async ({ actionId, arguments: args, idempotencyKey, signal }) => {
      try {
        if (signal?.aborted) throw signal.reason ?? new Error("support action cancelled");
        const result = await runtime.run({
          request: context.request,
          actionId,
          arguments: args,
          idempotencyKey,
        });
        if (signal?.aborted) throw signal.reason ?? new Error("support action cancelled");
        if (result.status === "awaiting_confirmation") {
          return {
            status: "awaiting_confirmation",
            operationId: result.operationId ?? "",
            proposal: result.proposal ?? {},
          };
        }
        return {
          status: "succeeded",
          operationId: result.operationId,
          output: result.result ?? {},
        };
      } catch (error) {
        return supportActionError(error);
      }
    },
  };
}

export async function discoverSupportActions(actor: AdminSession): Promise<readonly PublicAction[]> {
  return (await createSupportActionAdapter(actor)).discover();
}

export async function invokeSupportAction(input: {
  actor: AdminSession;
  actionId: string;
  arguments: Record<string, unknown>;
  idempotencyKey: string;
  signal?: AbortSignal;
}): Promise<AssistantActionInvocationResult> {
  return (await createSupportActionAdapter(input.actor)).invoke(input);
}

const runtime = new ActionRuntime({
  registry,
  store,
  authorization: {
    authorize: async ({ request, action, target }) => authorizePrincipalAction({
      tenantId: request.tenantId,
      userId: request.userId,
      agentPrincipalId: request.agentPrincipalId,
      requiredScopes: [...action.requiredScopes],
      target,
    }),
    authorizationVersion: async (request, transaction) => {
      const agent = (await listPrincipals(request.tenantId)).find((principal) => principal.id === request.agentPrincipalId);
      if (!agent) return hash({ tenantId: request.tenantId, userId: request.userId, agentPrincipalId: request.agentPrincipalId, missing: true });
      return authorizationVersion(request.tenantId, request.userId, agent, transaction);
    },
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
        const capabilityReader = await capabilityPackReader();
        const allowed = transaction
          ? await capabilityReader.isCapabilityAllowedForUserInTransaction({
              transaction,
              tenantId: request.tenantId,
              userId: request.userId,
              capabilityId,
              email: user.email,
              deptId: user.deptId,
            })
          : await capabilityReader.isCapabilityAllowedForUser(
              request.tenantId,
              request.userId,
              capabilityId,
              user.email,
              user.deptId,
            );
        return {
          allowed,
          reason: allowed ? "allowed" : "capability_not_granted",
          publicReason: allowed ? "allowed" : "enterprise capability is not enabled for this administrator",
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
        const capabilityReader = await capabilityPackReader();
        const allowed = await capabilityReader.isCapabilityAllowedForUserInTransaction({
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
            publicReason: "enterprise capability is not enabled for this administrator",
          };
        }
        return { allowed: true };
      },
      requiresTransactionalDispatch: true,
    },
  },
});

/**
 * Create a durable action operation for the legacy support assistant.  The
 * UI still receives its historical proposal shape, while the source of truth
 * is action_operations and the confirmation endpoint can run on any replica.
 */
export async function prepareSupportAction(input: {
  actor: AdminSession;
  actionId: "member.quota.set" | "member.models.set";
  arguments: Record<string, unknown>;
  idempotencyKey?: string;
}): Promise<{ proposal: SupportProposal; operationId: string }> {
  const context = await getSupportContext(input.actor);
  const result = await runtime.run({
    request: context.request,
    actionId: input.actionId,
    arguments: input.arguments,
    idempotencyKey: input.idempotencyKey ?? `support-${randomBytes(16).toString("hex")}`,
  });
  if (result.status !== "awaiting_confirmation" || !result.operationId) {
    throw new Error("support action did not produce a confirmation proposal");
  }
  const raw = result.proposal ?? {};
  const title = typeof raw.title === "string" ? raw.title : "Confirm enterprise change";
  const expiresAt = typeof raw.expiresAt === "string" ? raw.expiresAt : new Date(Date.now() + 5 * 60_000).toISOString();
  const changes = supportChanges(raw.changes);
  return { proposal: { id: result.operationId, title, changes, expiresAt }, operationId: result.operationId };
}

function supportChanges(value: unknown): SupportProposalChange[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is SupportProposalChange => Boolean(item && typeof item === "object" && typeof (item as SupportProposalChange).label === "string" && typeof (item as SupportProposalChange).before === "string" && typeof (item as SupportProposalChange).after === "string"));
  }
  if (!value || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>).slice(0, 20).map(([label, after]) => ({
    label,
    before: "当前值",
    after: typeof after === "string" ? after : JSON.stringify(after),
  }));
}

export async function confirmSupportAction(input: { actor: AdminSession; operationId: string }): Promise<Record<string, unknown>> {
  const context = await getSupportContext(input.actor);
  const result = await runtime.confirm({ request: context.request, operationId: input.operationId });
  return result.result ?? {};
}

export function __supportRuntimeForTests(): { store: SqlActionStore; registry: ActionRegistry; runtime: ActionRuntime } {
  return { store, registry, runtime };
}
