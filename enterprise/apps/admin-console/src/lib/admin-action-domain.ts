import {
  ActionRegistry,
  type ActionOperation,
  type ActionRequestContext,
  type JsonObject,
} from "@agenticx/action-runtime";
import {
  createEnterpriseActionDefinitions,
  createEnterpriseDomain,
  type EnterpriseDomain,
} from "@agenticx/enterprise-domain";
import type { AdminAuthSuccess } from "./admin-auth";
import { ulid } from "ulid";

type AdminMutationContext = {
  request: ActionRequestContext;
  action: ReturnType<ActionRegistry["require"]>;
  operation: ActionOperation;
};

/**
 * Shared domain/action metadata for legacy admin object routes.  The routes
 * still authenticate the human admin through admin-auth, while all quota and
 * model business writes go through the same tenant-explicit domain handlers as
 * delegated assistant actions.
 */
export function createAdminActionServices(): {
  domain: EnterpriseDomain;
  registry: ActionRegistry;
} {
  const domain = createEnterpriseDomain();
  return { domain, registry: new ActionRegistry(createEnterpriseActionDefinitions(domain)) };
}

export function adminActionRequest(auth: AdminAuthSuccess): ActionRequestContext {
  const principal = auth.context.userPrincipal;
  if (!principal) throw new Error("admin principal is unavailable");
  return {
    tenantId: auth.session.tenantId,
    userId: auth.session.userId,
    // An admin route acts as the authenticated human principal.  Empty means
    // no delegated agent in authorizePrincipalAction; it is not a client
    // supplied principal identifier.
    agentPrincipalId: "",
    sessionId: `admin:${auth.session.tenantId}:${auth.session.userId}`,
    permissionMode: "ask",
    authorizationVersion: String(auth.context.authzVersion),
    principal,
  };
}

export function adminMutationContext(
  auth: AdminAuthSuccess,
  actionId: string,
  targetId: string,
  expectedVersions: JsonObject,
  registry: ActionRegistry,
): AdminMutationContext {
  const request = adminActionRequest(auth);
  const action = registry.require(actionId);
  return {
    request,
    action,
    operation: {
      id: ulid(),
      tenantId: request.tenantId,
      sessionId: request.sessionId,
      actorUserId: request.userId,
      agentPrincipalId: request.principal.id,
      representedUserId: targetId,
      actionId: action.id,
      actionVersion: action.version,
      effect: action.effect,
      permissionMode: request.permissionMode,
      idempotencyKey: `admin:${ulid()}`,
      argumentsHash: "",
      arguments: {},
      targets: [{ kind: "user", id: targetId }],
      beforeState: null,
      afterState: null,
      expectedVersions,
      authorizationSnapshot: {},
      authorizationVersion: request.authorizationVersion,
      runId: null,
      status: "executing",
      proposal: null,
      result: null,
      errorCode: null,
      errorMessage: null,
      confirmationExpiresAt: null,
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      confirmedByUserId: request.userId,
      executedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  };
}
