import { createHash, randomBytes } from "node:crypto";
import { ulid } from "ulid";
import type {
  ActionRequestContext,
  ActionSession,
  ActionStore,
  AssistantPermissionMode,
  AssistantSessionOriginKind,
} from "./types";

export const ASSISTANT_REAUTH_REQUIRED = "ASSISTANT_REAUTH_REQUIRED" as const;
export const ASSISTANT_AUTH_REVOKED = "ASSISTANT_AUTH_REVOKED" as const;
export const ASSISTANT_SESSION_REVOKED = "ASSISTANT_SESSION_REVOKED" as const;
export const ASSISTANT_CAPABILITY_DENIED = "ASSISTANT_CAPABILITY_DENIED" as const;
export const ENTERPRISE_CONTEXT_STALE = "ENTERPRISE_CONTEXT_STALE" as const;

export type AssistantSessionErrorCode =
  | typeof ASSISTANT_REAUTH_REQUIRED
  | typeof ASSISTANT_AUTH_REVOKED
  | typeof ASSISTANT_SESSION_REVOKED
  | typeof ASSISTANT_CAPABILITY_DENIED
  | typeof ENTERPRISE_CONTEXT_STALE;

export class AssistantSessionError extends Error {
  public readonly code: AssistantSessionErrorCode;
  public readonly status: number;
  public readonly stale: boolean;

  public constructor(code: AssistantSessionErrorCode, message: string, status = 401, stale = false) {
    super(message);
    this.name = "AssistantSessionError";
    this.code = code;
    this.status = status;
    this.stale = stale;
  }
}

export function hashAssistantSessionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function ttlSeconds(): number {
  const configured = Number(process.env.ASSISTANT_SESSION_TTL_SECONDS ?? "1800");
  if (!Number.isFinite(configured) || configured <= 0) return 1800;
  return Math.min(Math.floor(configured), 1800);
}

function randomSessionToken(): string {
  return `agx-assistant-${randomBytes(32).toString("base64url")}`;
}

function safeDate(value: string | Date | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  const result = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isNaN(result.getTime()) ? null : result;
}

export type IssueAssistantSessionInput = {
  store: ActionStore;
  tenantId: string;
  userId: string;
  agentPrincipalId: string;
  originatingPatId: number | null;
  originKind: AssistantSessionOriginKind;
  studioSessionId: string;
  permissionMode: AssistantPermissionMode;
  authorizationVersion: string;
  /** The verified PAT expiry.  Sessions are never allowed to outlive it. */
  patExpiresAt?: string | Date | null;
  now?: Date;
};

export type IssuedAssistantSession = {
  token: string;
  session: ActionSession;
};

/** Issue or rotate one durable session for a Studio session and PAT. */
export async function issueAssistantSession(input: IssueAssistantSessionInput): Promise<IssuedAssistantSession> {
  const patId = input.originatingPatId;
  if (input.originKind !== "desktop_pat" &&
      input.originKind !== "admin_cookie" &&
      input.originKind !== "portal_cookie") {
    throw new AssistantSessionError(
      ASSISTANT_REAUTH_REQUIRED,
      "assistant session origin is invalid",
      401,
    );
  }
  if (input.originKind === "desktop_pat" &&
      (typeof patId !== "number" || !Number.isSafeInteger(patId) || patId <= 0)) {
    throw new AssistantSessionError(
      ASSISTANT_REAUTH_REQUIRED,
      "a desktop assistant session requires a valid originating PAT",
      401,
    );
  }
  if (input.originKind !== "desktop_pat" && input.originatingPatId !== null) {
    throw new AssistantSessionError(
      ASSISTANT_REAUTH_REQUIRED,
      "cookie assistant sessions cannot carry PAT provenance",
      401,
    );
  }
  if (input.originKind !== "desktop_pat" && input.patExpiresAt != null) {
    throw new AssistantSessionError(
      ASSISTANT_REAUTH_REQUIRED,
      "cookie assistant sessions cannot carry PAT expiry",
      401,
    );
  }
  const now = input.now ? new Date(input.now.getTime()) : new Date();
  const configuredExpiry = new Date(now.getTime() + ttlSeconds() * 1000);
  const patExpiry = safeDate(input.patExpiresAt);
  const requestedExpiry = patExpiry && patExpiry.getTime() < configuredExpiry.getTime() ? patExpiry : configuredExpiry;
  if (requestedExpiry.getTime() <= now.getTime()) {
    throw new AssistantSessionError(ASSISTANT_REAUTH_REQUIRED, "the originating PAT has expired", 401);
  }

  const token = randomSessionToken();
  const tokenHash = hashAssistantSessionToken(token);
  const existing = await input.store.findResumableSession({
    tenantId: input.tenantId,
    userId: input.userId,
    originatingPatId: input.originatingPatId,
    originKind: input.originKind,
    studioSessionId: input.studioSessionId,
    permissionMode: input.permissionMode,
    now,
  });
  // A session is resumable only while its identity and authorization snapshot
  // are unchanged.  If either one changed, retire the old credential and issue
  // a new row so a stale operation cannot be silently carried into the new
  // context.  This also makes a disabled/replaced delegated agent observable
  // to the caller instead of extending its old session.
  if (existing && (existing.agentPrincipalId !== input.agentPrincipalId || existing.authorizationVersion !== input.authorizationVersion)) {
    await input.store.revokeSession(existing.id, input.tenantId);
  }

  const resumable = existing && existing.agentPrincipalId === input.agentPrincipalId && existing.authorizationVersion === input.authorizationVersion
    ? existing
    : null;
  // Resuming an active session rotates only the opaque bearer.  Preserve its
  // original deadline so repeatedly reopening a Studio window cannot create an
  // unbounded rolling lease.  A newly observed, earlier PAT expiry still caps
  // the existing deadline.
  const resumedExpiry = resumable
    ? (() => {
        const priorExpiry = safeDate(resumable.expiresAt);
        if (!priorExpiry) return requestedExpiry;
        return patExpiry && patExpiry.getTime() < priorExpiry.getTime() ? patExpiry : priorExpiry;
      })()
    : requestedExpiry;
  if (resumedExpiry.getTime() <= now.getTime()) {
    throw new AssistantSessionError(ASSISTANT_REAUTH_REQUIRED, "the originating PAT has expired", 401);
  }

  const session = resumable
    ? await input.store.updateSession(resumable.id, input.tenantId, {
        agentPrincipalId: input.agentPrincipalId,
        tokenHash,
        authorizationVersion: input.authorizationVersion,
        expiresAt: resumedExpiry.toISOString(),
        status: "active",
      })
    : await input.store.createSession({
        id: ulid(),
        tenantId: input.tenantId,
        userId: input.userId,
        agentPrincipalId: input.agentPrincipalId,
        originatingPatId: input.originatingPatId,
        originKind: input.originKind,
        studioSessionId: input.studioSessionId,
        permissionMode: input.permissionMode,
        tokenHash,
        authorizationVersion: input.authorizationVersion,
        expiresAt: resumedExpiry.toISOString(),
        status: "active",
      });

  return { token, session };
}

export type AssistantSessionIdentity = {
  tenantId: string;
  userId: string;
  tokenId: number;
};

/** Validate the opaque assistant bearer and bind it to the live PAT identity. */
export async function authenticateAssistantSession(input: {
  store: ActionStore;
  token: string;
  identity: AssistantSessionIdentity;
  now?: Date;
}): Promise<ActionSession> {
  const token = input.token.trim();
  if (!token) throw new AssistantSessionError(ASSISTANT_REAUTH_REQUIRED, "assistant session is required", 401);
  const session = await input.store.getSessionByTokenHash(hashAssistantSessionToken(token));
  if (!session) throw new AssistantSessionError(ASSISTANT_REAUTH_REQUIRED, "assistant session is invalid", 401);
  if (session.status === "revoked") {
    throw new AssistantSessionError(ASSISTANT_SESSION_REVOKED, "assistant session was revoked", 401);
  }
  const now = input.now ? input.now.getTime() : Date.now();
  if (new Date(session.expiresAt).getTime() <= now || session.status === "expired") {
    throw new AssistantSessionError(ASSISTANT_SESSION_REVOKED, "assistant session has expired", 401);
  }
  if (session.originKind !== "desktop_pat" || session.originatingPatId === null) {
    throw new AssistantSessionError(
      ASSISTANT_REAUTH_REQUIRED,
      "cookie-owned assistant sessions cannot be used as a PAT bearer",
      401,
    );
  }
  if (session.originatingPatId !== input.identity.tokenId) {
    throw new AssistantSessionError(ASSISTANT_REAUTH_REQUIRED, "assistant session belongs to another PAT", 401);
  }
  if (session.tenantId !== input.identity.tenantId || session.userId !== input.identity.userId) {
    throw new AssistantSessionError(ASSISTANT_AUTH_REVOKED, "assistant identity no longer matches the session", 401);
  }
  return session;
}

export function sessionTokenFromRequest(request: Request): string | null {
  const value = request.headers.get("authorization") ?? request.headers.get("Authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  if (!match?.[1]) return null;
  const token = match[1].trim();
  return token.startsWith("agx-assistant-") ? token : null;
}

export function staleContextError(currentAuthorizationVersion: string): AssistantSessionError {
  return new AssistantSessionError(
    ENTERPRISE_CONTEXT_STALE,
    "enterprise authorization context changed; refresh capabilities",
    409,
    true,
  );
}

export function requestContextFromSession(input: {
  session: ActionSession;
  principal: ActionRequestContext["principal"];
  authorizationVersion: string;
}): ActionRequestContext {
  return {
    tenantId: input.session.tenantId,
    userId: input.session.userId,
    agentPrincipalId: input.session.agentPrincipalId,
    sessionId: input.session.id,
    permissionMode: input.session.permissionMode,
    authorizationVersion: input.authorizationVersion,
    principal: input.principal,
  };
}
