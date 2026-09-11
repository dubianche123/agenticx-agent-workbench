import http from "node:http";
import crypto from "node:crypto";

import { proxyAwareFetch } from "./proxy-fetch";

/**
 * The broker is the only process that is allowed to put an enterprise PAT on
 * the wire for Desktop assistant actions.  The Python Studio process receives
 * only the random loopback credential returned by this host.
 */

export type EnterpriseActionAuth = {
  portalOrigin: string;
  token: string;
  identityKey: string;
  scopeId: string | null;
  authGeneration: number;
};

export type ResolveEnterpriseActionAuth = () =>
  | EnterpriseActionAuth
  | null
  | Promise<EnterpriseActionAuth | null>;

export type EnterpriseAssistantSessionBinding = {
  sessionId: string;
  purpose: "environment-assistant";
  purposeScope: string;
  permissionMode: "plan" | "ask" | "auto";
};

export type ResolveEnterpriseAssistantSession = (
  sessionId: string,
) => EnterpriseAssistantSessionBinding | null | Promise<EnterpriseAssistantSessionBinding | null>;

export type EnterpriseActionBinding = {
  sessionId: string;
  authGeneration: number;
  permissionMode: "plan" | "ask" | "auto";
};

export type EnterpriseActionBroker = {
  url: string;
  token: string;
  close: () => Promise<void>;
  preflightAuthorization: (
    sessionId: string,
    permissionMode: EnterpriseActionBinding["permissionMode"],
  ) => Promise<EnterpriseBrokerResult>;
  confirmOperation: (
    operationId: string,
    binding: EnterpriseActionBinding,
  ) => Promise<EnterpriseBrokerResult>;
  getOperation: (
    operationId: string,
    binding: EnterpriseActionBinding,
  ) => Promise<EnterpriseBrokerResult>;
};

type BrokerCapability = {
  id: string;
  label: string;
  description: string;
  inputSchema: Record<string, unknown>;
  effect: string;
};

export type EnterpriseBrokerResult = {
  ok: boolean;
  status?: "succeeded" | "awaiting_confirmation" | "pending" | "failed";
  operationId?: string;
  result?: unknown;
  proposal?: { title: string; changes: unknown; expiresAt?: string | number | null };
  capabilities?: BrokerCapability[];
  authorizationVersion?: string | number | null;
  authGeneration?: number;
  code?: string;
  message?: string;
};

type PortalSession = {
  sessionToken: string;
  expiresAtMs: number;
  identityKey: string;
  authGeneration: number;
};

type PendingOperation = {
  sessionId: string;
  permissionMode: "plan" | "ask" | "auto";
  operationId: string;
  sessionToken: string;
  identityKey: string;
  authGeneration: number;
  expiresAtMs: number;
};

class BrokerRequestError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const MAX_REQUEST_BYTES = 128 * 1024;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_OVERSIZE_DRAIN_BYTES = MAX_REQUEST_BYTES * 2;
const OVERSIZE_DRAIN_TIMEOUT_MS = 1_000;
const PORTAL_REQUEST_TIMEOUT_MS = 20_000;
const SESSION_REFRESH_SKEW_MS = 30_000;
const MAX_PENDING_OPERATIONS = 128;
const MAX_JSON_DEPTH = 6;
const MAX_JSON_KEYS = 48;
const MAX_JSON_ARRAY = 32;
const MAX_JSON_STRING = 8_000;

const OPERATION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const ACTION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

const CREDENTIAL_RESULT_KEYS = new Set([
  "token",
  "bearer",
  "bearertoken",
  "sessiontoken",
  "session_token",
  "pat",
  "accesstoken",
  "access_token",
  "idtoken",
  "id_token",
  "jwttoken",
  "jwt_token",
  "authorization",
  "refreshtoken",
  "refresh_token",
  "apikey",
  "api_key",
  "providerapikey",
  "provider_api_key",
  "credential",
  "credentials",
  "clientsecret",
  "client_secret",
  "password",
  "passwordhash",
  "password_hash",
  "secret",
  "secretvalue",
  "secretkey",
  "secret_key",
  "signingsecret",
  "signing_secret",
  "privatekey",
  "private_key",
  "sshprivatekey",
  "ssh_private_key",
  "privatepem",
  "private_pem",
  "signingkey",
  "signing_key",
  "encryptionkey",
  "encryption_key",
  "cookie",
  "setcookie",
  "set_cookie",
]);

// These keys can turn a legitimate target argument into an impersonation or
// credential override.  `memberId` and `userId` remain valid target selectors;
// authorization of those targets belongs to the Portal on every action.
const FORBIDDEN_ARGUMENT_KEYS = new Set([
  "actorid",
  "actor_id",
  "actor",
  "principalid",
  "principal_id",
  "principal",
  "tenantid",
  "tenant_id",
  "tenant",
  "identity",
  "subject",
  "onbehalfof",
  "on_behalf_of",
  "authorization",
  "sessiontoken",
  "session_token",
  "pat",
  "accesstoken",
  "access_token",
  "baseurl",
  "base_url",
  "portalurl",
  "portal_url",
  "url",
  "uri",
  "endpoint",
  "host",
  "origin",
  "targeturl",
  "target_url",
  "gatewayurl",
  "gateway_url",
  "confirmed",
  "confirm",
  "approved",
  "approval",
  "confirmedbyuser",
  "confirmed_by_user",
  "authorizationversion",
  "authorization_version",
  "authgeneration",
  "auth_generation",
  "operationid",
  "operation_id",
  "runid",
  "run_id",
  "idempotencykey",
  "idempotency_key",
]);

function writeJson(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.end(body);
}

function safeMessage(value: unknown, secrets: readonly string[] = []): string {
  let text = String(value ?? "").replace(/[\r\n]+/g, " ");
  for (const secret of secrets) {
    const value = String(secret ?? "");
    if (value) text = text.split(value).join("[redacted]");
  }
  return text.slice(0, 400).trim();
}

function redactString(value: string, secrets: readonly string[] = []): string {
  let text = value.slice(0, MAX_JSON_STRING);
  for (const secret of secrets) {
    const candidate = String(secret ?? "");
    if (candidate) text = text.split(candidate).join("[redacted]");
  }
  return text;
}

function isLoopbackAddress(value: string | undefined): boolean {
  const host = String(value ?? "").trim().toLowerCase();
  return host === "127.0.0.1"
    || host === "::1"
    || host === "[::1]"
    || host === "::ffff:127.0.0.1";
}

function hasValidToken(req: http.IncomingMessage, expectedToken: string): boolean {
  const expected = Buffer.from(expectedToken, "utf8");
  const authorization = String(req.headers.authorization ?? "").trim();
  const bearer = authorization.replace(/^Bearer\s+/i, "").trim();
  const header = String(req.headers["x-agx-enterprise-action-broker-token"] ?? "").trim();
  return [header, bearer].some((candidate) => {
    const actual = Buffer.from(candidate, "utf8");
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  });
}

type RequestBody = { raw: Buffer; oversized: boolean; drained: boolean };

function readRequestBody(req: http.IncomingMessage): Promise<RequestBody> {
  const declared = Number(req.headers["content-length"] ?? 0);
  const declaredOversized = Number.isFinite(declared) && declared > MAX_REQUEST_BYTES;
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let drainBytes = 0;
    let oversized = declaredOversized;
    let drained = !declaredOversized;
    let settled = false;
    let drainTimer: NodeJS.Timeout | null = null;

    const cleanup = () => {
      if (drainTimer) clearTimeout(drainTimer);
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("aborted", onAborted);
      req.off("error", onError);
    };
    const finish = (complete: boolean) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ raw: Buffer.concat(chunks), oversized, drained: complete });
    };
    const stopDrain = () => {
      drained = false;
      req.pause();
      finish(false);
    };
    const beginDrain = () => {
      if (!drainTimer) drainTimer = setTimeout(stopDrain, OVERSIZE_DRAIN_TIMEOUT_MS);
    };
    const onData = (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      if (oversized) {
        drainBytes += bytes.length;
        if (drainBytes > MAX_OVERSIZE_DRAIN_BYTES) stopDrain();
        return;
      }
      total += bytes.length;
      if (total > MAX_REQUEST_BYTES) {
        oversized = true;
        drained = true;
        drainBytes = total;
        chunks.length = 0;
        beginDrain();
        if (drainBytes > MAX_OVERSIZE_DRAIN_BYTES) stopDrain();
        return;
      }
      chunks.push(bytes);
    };
    const onEnd = () => finish(!oversized || drained);
    const onAborted = () => {
      if (settled) return;
      cleanup();
      reject(new Error("broker request was aborted"));
    };
    const onError = (error: Error) => {
      if (settled) return;
      cleanup();
      reject(error);
    };

    if (declaredOversized) beginDrain();
    req.on("data", onData);
    req.once("end", onEnd);
    req.once("aborted", onAborted);
    req.once("error", onError);
    req.resume();
  });
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const body = await readRequestBody(req);
  if (body.oversized) {
    throw Object.assign(new Error("broker request is too large"), {
      statusCode: 413,
      closeRequest: !body.drained,
    });
  }
  try {
    return JSON.parse(body.raw.toString("utf8"));
  } catch {
    throw Object.assign(new Error("broker request must be valid JSON"), { statusCode: 400 });
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function containsForbiddenArgumentKey(value: unknown, depth = 0): string | null {
  if (depth > MAX_JSON_DEPTH || value === null || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = containsForbiddenArgumentKey(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_ARGUMENT_KEYS.has(key.replace(/[-\s]/g, "").toLowerCase())) return key;
    const found = containsForbiddenArgumentKey(item, depth + 1);
    if (found) return found;
  }
  return null;
}

function jsonByteLength(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function sanitizeValue(value: unknown, depth = 0, secrets: readonly string[] = []): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return redactString(value, secrets);
  if (depth >= MAX_JSON_DEPTH) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, MAX_JSON_ARRAY).map((item) => sanitizeValue(item, depth + 1, secrets));
  if (!isPlainObject(value)) return String(value).slice(0, MAX_JSON_STRING);
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value).slice(0, MAX_JSON_KEYS)) {
    const normalized = key.replace(/[-\s]/g, "").toLowerCase();
    // Credentials and session material must never reach Python/model output,
    // even if a Portal accidentally includes them in result metadata.
    if (CREDENTIAL_RESULT_KEYS.has(normalized)) continue;
    out[key] = sanitizeValue(item, depth + 1, secrets);
  }
  return out;
}

function normalizeDateMs(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 10_000_000_000 ? Math.round(value * 1000) : Math.round(value);
  }
  const raw = String(value ?? "").trim();
  if (!raw) return fallback;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeOperationId(value: unknown): string {
  const id = String(value ?? "").trim();
  return OPERATION_ID_RE.test(id) ? id : "";
}

function normalizeSessionId(value: unknown): string {
  const id = String(value ?? "").trim();
  return SESSION_ID_RE.test(id) ? id : "";
}

function normalizeActionId(value: unknown): string {
  const id = String(value ?? "").trim();
  return ACTION_ID_RE.test(id) ? id : "";
}

function normalizeRunId(value: unknown): string {
  const id = String(value ?? "").trim();
  return RUN_ID_RE.test(id) ? id : "";
}

function normalizePermissionMode(value: unknown): "plan" | "ask" | "auto" | "" {
  const mode = String(value ?? "").trim().toLowerCase();
  return mode === "plan" || mode === "ask" || mode === "auto" ? mode : "";
}

// Portal's current response contract uses the five-zero string.  Keep the
// small compatibility set for older local Portal builds, but never treat an
// arbitrary HTTP 200 response or an unknown code as successful.
const PORTAL_SUCCESS_CODES = new Set(["00000", "0", "200", "ok", "success", "succeeded"]);
const PORTAL_TERMINAL_FAILURE_STATUSES = new Set([
  "failed",
  "expired",
  "rejected",
  "stale",
  "cancelled",
  "outcome_unknown",
]);
const PORTAL_IN_FLIGHT_STATUSES = new Set(["prepared", "ready", "executing"]);

function isSuccessEnvelopeCode(value: unknown): boolean {
  return PORTAL_SUCCESS_CODES.has(String(value ?? "").trim().toLowerCase());
}

function isFailureEnvelopeCode(value: unknown): boolean {
  const code = String(value ?? "").trim();
  return Boolean(code) && !isSuccessEnvelopeCode(code);
}

function extractEnvelope(value: unknown): { data: Record<string, unknown>; code: string; message: string } {
  const root = isPlainObject(value) ? value : {};
  const rawData = root.data;
  const data = isPlainObject(rawData) ? rawData : {};
  return {
    data,
    code: safeMessage(root.code),
    message: safeMessage(root.message || root.error),
  };
}

function assertSuccessfulEnvelope(
  envelope: ReturnType<typeof extractEnvelope>,
  fallbackMessage: string,
  secrets: readonly string[] = [],
): void {
  if (isSuccessEnvelopeCode(envelope.code)) return;
  const code = envelope.code || "ASSISTANT_PROTOCOL_INVALID";
  const status = isFailureEnvelopeCode(envelope.code) ? 403 : 502;
  throw new BrokerRequestError(
    status,
    code,
    safeMessage(
      envelope.message || (status === 403 ? fallbackMessage : "企业服务返回了无法识别的响应。"),
      secrets,
    ),
  );
}

function normalizeCapabilities(data: Record<string, unknown>, secrets: readonly string[] = []): BrokerCapability[] {
  const raw = Array.isArray(data.capabilities)
    ? data.capabilities
    : Array.isArray(data.actions)
      ? data.actions
      : [];
  const out: BrokerCapability[] = [];
  for (const value of raw.slice(0, 128)) {
    if (!isPlainObject(value)) continue;
    const id = normalizeActionId(value.id);
    const label = safeMessage(value.label || value.name, secrets);
    if (!id || !label) continue;
    const schema = isPlainObject(value.inputSchema)
      ? sanitizeValue(value.inputSchema, 0, secrets) as Record<string, unknown>
      : {};
    out.push({
      id,
      label,
      description: safeMessage(value.description, secrets),
      inputSchema: schema,
      effect: safeMessage(value.effect || "unknown", secrets) || "unknown",
    });
  }
  return out;
}

async function readBoundedResponseText(response: Response): Promise<string> {
  if (!response.body) return (await response.text()).slice(0, MAX_RESPONSE_BYTES);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total <= MAX_RESPONSE_BYTES) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = next.value;
      if (!chunk || chunk.byteLength === 0) continue;
      const remaining = MAX_RESPONSE_BYTES - total;
      chunks.push(chunk.byteLength <= remaining ? chunk : chunk.slice(0, remaining));
      total += Math.min(chunk.byteLength, remaining);
      if (chunk.byteLength > remaining) {
        await reader.cancel().catch(() => undefined);
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

function normalizePortalResult(
  value: unknown,
  currentGeneration: number,
  secrets: readonly string[] = [],
): EnterpriseBrokerResult {
  const envelope = extractEnvelope(value);
  const data = envelope.data;
  const rawStatus = String(data.status ?? "").trim().toLowerCase();
  const status = rawStatus === "succeeded" || rawStatus === "awaiting_confirmation"
    ? rawStatus
    : rawStatus === "pending"
      ? "pending"
      : PORTAL_TERMINAL_FAILURE_STATUSES.has(rawStatus)
        ? "failed"
        : PORTAL_IN_FLIGHT_STATUSES.has(rawStatus)
          ? "pending"
          : undefined;
  const operationId = normalizeOperationId(data.operationId ?? data.operation_id);
  const proposalRaw = isPlainObject(data.proposal) ? data.proposal : null;
  const expiresAtRaw = proposalRaw?.expiresAt ?? proposalRaw?.expires_at;
  const expiresAt = typeof expiresAtRaw === "string" || typeof expiresAtRaw === "number"
    ? expiresAtRaw
    : null;
  const authorizationVersionRaw = data.authorizationVersion ?? data.authorization_version;
  const authorizationVersion = typeof authorizationVersionRaw === "string"
    || typeof authorizationVersionRaw === "number"
    ? authorizationVersionRaw
    : null;
  const proposal = proposalRaw
    ? {
        title: safeMessage(proposalRaw.title, secrets) || "请确认企业操作",
        changes: sanitizeValue(proposalRaw.changes ?? proposalRaw.change ?? proposalRaw.summary, 0, secrets),
        expiresAt,
      }
    : undefined;
  const protocolValid = isSuccessEnvelopeCode(envelope.code) && status !== undefined;
  const businessFailure = protocolValid && PORTAL_TERMINAL_FAILURE_STATUSES.has(rawStatus);
  const businessErrorCode = safeMessage(
    data.errorCode ?? data.error_code,
    secrets,
  );
  const businessErrorMessage = safeMessage(
    data.errorMessage ?? data.error_message ?? data.error,
    secrets,
  );
  const normalizedCode = !protocolValid
    ? isFailureEnvelopeCode(envelope.code)
      ? envelope.code
      : "ASSISTANT_PROTOCOL_INVALID"
    : businessFailure
      ? businessErrorCode || "ENTERPRISE_ACTION_FAILED"
      : envelope.code || undefined;
  const result: EnterpriseBrokerResult = {
    // A successful HTTP status is not enough.  Require the Portal's explicit
    // success code and a recognized action status before exposing data to
    // Python/model context; malformed responses fail closed.
    ok: protocolValid && status !== "failed",
    status: protocolValid ? status : "failed",
    operationId: operationId || undefined,
    result: data.result === undefined ? undefined : sanitizeValue(data.result, 0, secrets),
    proposal,
    authorizationVersion,
    authGeneration: currentGeneration,
    code: normalizedCode,
    message: !protocolValid
      ? safeMessage(envelope.message, secrets) || "企业服务返回了无法识别的响应。"
      : businessFailure
        ? businessErrorMessage || safeMessage(envelope.message, secrets) || "企业操作未完成。"
        : safeMessage(envelope.message, secrets) || undefined,
  };
  return result;
}

export async function startEnterpriseActionBroker(
  resolveAuth: ResolveEnterpriseActionAuth,
  resolveAssistantSession: ResolveEnterpriseAssistantSession,
): Promise<EnterpriseActionBroker> {
  const token = crypto.randomBytes(32).toString("hex");
  const sessions = new Map<string, PortalSession>();
  const pending = new Map<string, PendingOperation>();
  let closed = false;

  const getAuth = async (): Promise<EnterpriseActionAuth> => {
    const auth = await resolveAuth();
    if (!auth || !auth.portalOrigin || !auth.token || !auth.identityKey) {
      throw new BrokerRequestError(401, "ENTERPRISE_REAUTH_REQUIRED", "请先登录企业账户，再使用个人助手企业能力。" );
    }
    for (const [key, session] of sessions) {
      if (session.identityKey !== auth.identityKey || session.authGeneration !== auth.authGeneration) {
        sessions.delete(key);
      }
    }
    for (const [operationId, operation] of pending) {
      if (operation.identityKey !== auth.identityKey || operation.authGeneration !== auth.authGeneration) {
        pending.delete(operationId);
      }
    }
    return auth;
  };

  const portalRequest = async (
    auth: EnterpriseActionAuth,
    pathname: string,
    init: RequestInit,
  ): Promise<{ value: unknown; status: number }> => {
    // `pathname` is assembled only by broker code. It must never originate from
    // Python/model input; this is the URL injection boundary.
    const url = `${auth.portalOrigin}${pathname}`;
    let response: Response;
    try {
      response = await proxyAwareFetch(url, {
        ...init,
        headers: {
          accept: "application/json",
          ...(init.body ? { "content-type": "application/json" } : {}),
          authorization: `Bearer ${auth.token}`,
          ...(init.headers ?? {}),
        },
        redirect: "error",
        signal: init.signal ?? AbortSignal.timeout(PORTAL_REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new BrokerRequestError(502, "ENTERPRISE_PORTAL_UNAVAILABLE", "企业服务暂时不可用，请稍后重试。" );
    }
    let value: unknown = {};
    try {
      const text = await readBoundedResponseText(response);
      value = text ? JSON.parse(text) : {};
    } catch {
      value = {};
    }
    if (!response.ok) {
      const envelope = extractEnvelope(value);
      const code = envelope.code || (response.status === 403 ? "ENTERPRISE_ACTION_FORBIDDEN" : `HTTP_${response.status}`);
      const message = safeMessage(envelope.message || "企业服务拒绝了该请求。", [auth.token]);
      throw new BrokerRequestError(response.status, code, message);
    }
    return { value, status: response.status };
  };

  const ensurePortalSession = async (
    auth: EnterpriseActionAuth,
    sessionId: string,
    permissionMode: string,
  ): Promise<PortalSession> => {
    const key = `${auth.identityKey}\u0000${auth.authGeneration}\u0000${sessionId}\u0000${permissionMode}`;
    const cached = sessions.get(key);
    if (cached && cached.identityKey === auth.identityKey
      && cached.authGeneration === auth.authGeneration
      && cached.expiresAtMs > Date.now() + SESSION_REFRESH_SKEW_MS) {
      return cached;
    }
    const created = await portalRequest(auth, "/api/desktop/assistant/sessions", {
      method: "POST",
      body: JSON.stringify({ sessionId, permissionMode }),
    });
    const envelope = extractEnvelope(created.value);
    const data = envelope.data;
    assertSuccessfulEnvelope(envelope, "企业助手会话创建被拒绝。", [auth.token]);
    const sessionToken = String(data.sessionToken ?? data.session_token ?? "").trim();
    if (!sessionToken) {
      throw new BrokerRequestError(502, "ASSISTANT_SESSION_INVALID", "企业助手会话响应无有效令牌。" );
    }
    const expiresAtMs = normalizeDateMs(data.expiresAt ?? data.expires_at, Date.now() + 5 * 60_000);
    const entry: PortalSession = {
      sessionToken,
      expiresAtMs,
      identityKey: auth.identityKey,
      authGeneration: auth.authGeneration,
    };
    // The key includes identity/generation/session/mode. Remove stale entries
    // for the same session so a role/tenant switch cannot keep a token alive.
    for (const [existingKey, existing] of sessions) {
      if (existingKey.startsWith(`${auth.identityKey}\u0000`) && existingKey.includes(`\u0000${sessionId}\u0000`)) {
        sessions.delete(existingKey);
      }
    }
    sessions.set(key, entry);
    return entry;
  };

  const validateAssistantSession = async (
    sessionId: string,
    requestedMode: string,
  ): Promise<"plan" | "ask" | "auto"> => {
    const actual = await resolveAssistantSession(sessionId);
    if (!actual
      || actual.purpose !== "environment-assistant"
      || actual.sessionId !== sessionId
      || !actual.purposeScope
      || !normalizePermissionMode(actual.permissionMode)) {
      throw new BrokerRequestError(403, "ASSISTANT_SESSION_FORBIDDEN", "企业动作只允许当前个人助手会话。" );
    }
    const mode = normalizePermissionMode(actual.permissionMode);
    if (!mode || mode !== normalizePermissionMode(requestedMode)) {
      throw new BrokerRequestError(409, "ASSISTANT_PERMISSION_CHANGED", "个人助手权限模式已变化，请重新发起操作。" );
    }
    return mode;
  };

  const capabilities = async (
    sessionId: string,
    permissionMode: string,
  ): Promise<EnterpriseBrokerResult> => {
    const auth = await getAuth();
    const actualMode = await validateAssistantSession(sessionId, permissionMode);
    const session = await ensurePortalSession(auth, sessionId, actualMode);
    // The Portal rechecks the authenticated role on this snapshot. The
    // short-lived session token stays in this broker and never crosses IPC.
    const response = await portalRequestWithSession(auth, session, "/api/desktop/assistant/capabilities", { method: "GET" });
    const envelope = extractEnvelope(response.value);
    assertSuccessfulEnvelope(envelope, "企业能力快照被拒绝。", [auth.token, session.sessionToken]);
    const authorizationVersionRaw = envelope.data.authorizationVersion ?? envelope.data.authorization_version;
    const authorizationVersion = typeof authorizationVersionRaw === "string"
      || typeof authorizationVersionRaw === "number"
      ? authorizationVersionRaw
      : null;
    // A capability response is the authorization preflight snapshot. Never
    // substitute a cached session value when the Portal omitted the required
    // version: that would make an old authorization state look freshly
    // verified after a role/tenant change.
    if (authorizationVersion === null) {
      return {
        ok: false,
        capabilities: normalizeCapabilities(envelope.data, [auth.token, session.sessionToken]),
        authGeneration: auth.authGeneration,
        code: "ASSISTANT_AUTH_VERSION_UNAVAILABLE",
        message: "企业权限版本无法核验，请稍后重试。",
      };
    }
    return {
      ok: true,
      capabilities: normalizeCapabilities(envelope.data, [auth.token, session.sessionToken]),
      authorizationVersion,
      authGeneration: auth.authGeneration,
    };
  };

  const preflightAuthorization = async (
    sessionId: string,
    permissionMode: EnterpriseActionBinding["permissionMode"],
  ): Promise<EnterpriseBrokerResult> => {
    // Reuse the existing capability snapshot contract.  This remains lazy at
    // the Desktop boundary: callers invoke it only for sessions that already
    // contain enterprise results, while ordinary environment turns never
    // create a Portal session or perform a remote request.
    const snapshot = await capabilities(sessionId, permissionMode);
    if (!snapshot.authorizationVersion) {
      return {
        ok: false,
        authGeneration: snapshot.authGeneration,
        code: "ASSISTANT_AUTH_VERSION_UNAVAILABLE",
        message: "企业权限版本无法核验，当前会话已保留，请稍后重试。",
      };
    }
    return {
      ok: snapshot.ok,
      authorizationVersion: snapshot.authorizationVersion,
      authGeneration: snapshot.authGeneration,
      code: snapshot.code,
      message: snapshot.message,
    };
  };

  const action = async (
    sessionId: string,
    permissionMode: string,
    actionId: string,
    args: Record<string, unknown>,
    idempotencyKey: string,
    runId: string,
  ): Promise<EnterpriseBrokerResult> => {
    const auth = await getAuth();
    const actualMode = await validateAssistantSession(sessionId, permissionMode);
    const session = await ensurePortalSession(auth, sessionId, actualMode);
    const response = await portalRequestWithSession(auth, session, "/api/desktop/assistant/actions", {
      method: "POST",
      body: JSON.stringify({ actionId, arguments: args, idempotencyKey, runId }),
    });
    const normalized = normalizePortalResult(
      response.value,
      auth.authGeneration,
      [auth.token, session.sessionToken],
    );
    if (normalized.operationId && normalized.status === "awaiting_confirmation") {
      const expiry = normalizeDateMs(normalized.proposal?.expiresAt, Date.now() + 5 * 60_000);
      pending.set(normalized.operationId, {
        sessionId,
        permissionMode: actualMode,
        operationId: normalized.operationId,
        sessionToken: session.sessionToken,
        identityKey: auth.identityKey,
        authGeneration: auth.authGeneration,
        expiresAtMs: expiry,
      });
      while (pending.size > MAX_PENDING_OPERATIONS) {
        const oldest = pending.keys().next().value as string | undefined;
        if (!oldest) break;
        pending.delete(oldest);
      }
    }
    return normalized;
  };

  const validateBinding = async (
    operationId: string,
    binding: EnterpriseActionBinding,
  ): Promise<{ auth: EnterpriseActionAuth; operation: PendingOperation; session: PortalSession }> => {
    if (!OPERATION_ID_RE.test(operationId)) {
      throw new BrokerRequestError(400, "INVALID_OPERATION_ID", "企业操作编号无效。" );
    }
    const auth = await getAuth();
    if (!Number.isInteger(binding.authGeneration) || binding.authGeneration !== auth.authGeneration) {
      throw new BrokerRequestError(409, "ENTERPRISE_AUTH_CHANGED", "企业登录身份已变化，请重新发起操作。" );
    }
    const sessionId = normalizeSessionId(binding.sessionId);
    if (!sessionId) throw new BrokerRequestError(400, "INVALID_SESSION_ID", "个人助手会话编号无效。" );
    const permissionMode = normalizePermissionMode(binding.permissionMode);
    if (!permissionMode) throw new BrokerRequestError(400, "INVALID_PERMISSION_MODE", "个人助手权限模式无效。" );
    const actualMode = await validateAssistantSession(sessionId, permissionMode);
    if (actualMode !== permissionMode) {
      throw new BrokerRequestError(409, "ASSISTANT_PERMISSION_CHANGED", "个人助手权限模式已变化，请重新发起操作。" );
    }
    let operation = pending.get(operationId);
    if (operation
      && (operation.sessionId !== sessionId
        || operation.permissionMode !== permissionMode
        || operation.identityKey !== auth.identityKey
        || operation.authGeneration !== auth.authGeneration
        || operation.expiresAtMs <= Date.now())) {
      pending.delete(operationId);
      operation = undefined;
    }
    if (!operation) {
      // The in-memory broker map is deliberately short-lived. After Desktop
      // restarts, recover a history card by obtaining a fresh, same-session
      // Portal token and asking the Portal whether this operation belongs to
      // that session. The operation id alone never grants access.
      const recoveredSession = await ensurePortalSession(auth, sessionId, actualMode);
      let recovered: { value: unknown; status: number };
      try {
        recovered = await portalRequestWithSession(
          auth,
          recoveredSession,
          `/api/desktop/assistant/operations/${encodeURIComponent(operationId)}`,
          { method: "GET" },
        );
      } catch (error) {
        // Only an actual HTTP 404 means that the operation cannot be
        // recovered.  Preserve authentication, stale-context, expiry, and
        // execution errors from the trusted Portal response.
        if (error instanceof BrokerRequestError && error.status === 404) {
          throw new BrokerRequestError(404, "ENTERPRISE_OPERATION_NOT_FOUND", "企业操作不存在或已失效，请重新生成预览。" );
        }
        throw error;
      }
      const recoveredResult = normalizePortalResult(
        recovered.value,
        auth.authGeneration,
        [auth.token, recoveredSession.sessionToken],
      );
      if (recoveredResult.code === "ASSISTANT_PROTOCOL_INVALID" || !recoveredResult.status) {
        throw new BrokerRequestError(
          502,
          "ASSISTANT_PROTOCOL_INVALID",
          recoveredResult.message || "企业服务返回了无法识别的操作状态。",
        );
      }
      if (!recoveredResult.ok) {
        throw new BrokerRequestError(
          409,
          recoveredResult.code || "ENTERPRISE_ACTION_FAILED",
          recoveredResult.message || "企业操作未完成。",
        );
      }
      const expiry = normalizeDateMs(
        recoveredResult.proposal?.expiresAt,
        Date.now() + 120_000,
      );
      operation = {
        sessionId,
        permissionMode: actualMode,
        operationId,
        sessionToken: recoveredSession.sessionToken,
        identityKey: auth.identityKey,
        authGeneration: auth.authGeneration,
        expiresAtMs: expiry,
      };
      pending.set(operationId, operation);
    }
    const session: PortalSession = {
      sessionToken: operation.sessionToken,
      expiresAtMs: operation.expiresAtMs,
      identityKey: operation.identityKey,
      authGeneration: operation.authGeneration,
    };
    return { auth, operation, session };
  };

  const getOperation = async (
    operationId: string,
    binding: EnterpriseActionBinding,
  ): Promise<EnterpriseBrokerResult> => {
    const { auth, operation, session } = await validateBinding(operationId, binding);
    const response = await portalRequestWithSession(
      auth,
      session,
      `/api/desktop/assistant/operations/${encodeURIComponent(operation.operationId)}`,
      { method: "GET" },
    );
    const result = normalizePortalResult(
      response.value,
      auth.authGeneration,
      [auth.token, session.sessionToken],
    );
    if (result.status === "succeeded" || result.status === "failed") {
      // Keep a short-lived, bounded completion record so the waiting Python
      // turn can read the same authoritative result after the UI has already
      // performed its confirm/get IPC. The Portal remains the source of truth
      // and validateBinding still rechecks the current session/auth binding.
      operation.expiresAtMs = Math.max(operation.expiresAtMs, Date.now() + 60_000);
    }
    return result;
  };

  const confirmOperation = async (
    operationId: string,
    binding: EnterpriseActionBinding,
  ): Promise<EnterpriseBrokerResult> => {
    const { auth, operation, session } = await validateBinding(operationId, binding);
    const response = await portalRequestWithSession(
      auth,
      session,
      `/api/desktop/assistant/operations/${encodeURIComponent(operation.operationId)}/confirm`,
      { method: "POST", body: JSON.stringify({}) },
    );
    const result = normalizePortalResult(
      response.value,
      auth.authGeneration,
      [auth.token, session.sessionToken],
    );
    if (result.status === "succeeded") {
      // Keep the binding briefly so the waiting Python turn can read the
      // authoritative result after the UI releases its clarify gate. The
      // Portal remains the source of truth and may still report expiry.
      operation.expiresAtMs = Math.max(operation.expiresAtMs, Date.now() + 60_000);
    }
    return result;
  };

  const portalRequestWithSession = async (
    auth: EnterpriseActionAuth,
    session: PortalSession,
    pathname: string,
    init: RequestInit,
  ): Promise<{ value: unknown; status: number }> => {
    if (session.identityKey !== auth.identityKey || session.authGeneration !== auth.authGeneration) {
      throw new BrokerRequestError(409, "ENTERPRISE_AUTH_CHANGED", "企业登录身份已变化，请重新发起操作。" );
    }
    // Use a separate bearer header for the short-lived assistant token. The PAT
    // is still attached by portalRequest only to establish the session. Portal
    // endpoints in this contract accept the assistant token as Bearer.
    const url = `${auth.portalOrigin}${pathname}`;
    let response: Response;
    try {
      response = await proxyAwareFetch(url, {
        ...init,
        headers: {
          accept: "application/json",
          ...(init.body ? { "content-type": "application/json" } : {}),
          authorization: `Bearer ${session.sessionToken}`,
        },
        redirect: "error",
        signal: init.signal ?? AbortSignal.timeout(PORTAL_REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new BrokerRequestError(502, "ENTERPRISE_PORTAL_UNAVAILABLE", "企业服务暂时不可用，请稍后重试。" );
    }
    let value: unknown = {};
    try {
      const text = await readBoundedResponseText(response);
      value = text ? JSON.parse(text) : {};
    } catch {
      value = {};
    }
    if (!response.ok) {
      const envelope = extractEnvelope(value);
      const code = envelope.code || (response.status === 403 ? "ENTERPRISE_ACTION_FORBIDDEN" : `HTTP_${response.status}`);
      throw new BrokerRequestError(
        response.status,
        code,
        safeMessage(envelope.message || "企业服务拒绝了该请求。", [auth.token, session.sessionToken]),
      );
    }
    return { value, status: response.status };
  };

  const server = http.createServer((req, res) => {
    if (!isLoopbackAddress(req.socket.remoteAddress)) {
      writeJson(res, 403, { code: "LOOPBACK_ONLY", message: "企业动作 broker 仅接受本机请求。" });
      return;
    }
    if (!hasValidToken(req, token)) {
      writeJson(res, 401, { code: "BROKER_UNAUTHORIZED", message: "broker authentication required" });
      return;
    }
    const pathname = String(req.url ?? "").split("?", 1)[0];
    const run = async () => {
      if (req.method === "GET" && pathname === "/health") {
        writeJson(res, 200, { ok: true });
        return;
      }
      if (req.method === "POST" && pathname === "/capabilities") {
        const payload = await readJsonBody(req);
        if (!isPlainObject(payload)) throw new BrokerRequestError(400, "INVALID_REQUEST", "请求体必须是对象。" );
        const sessionId = normalizeSessionId(payload.sessionId ?? payload.session_id);
        const permissionMode = String(payload.permissionMode ?? payload.permission_mode ?? "").trim().toLowerCase();
        if (!sessionId || !["plan", "ask", "auto"].includes(permissionMode)) {
          throw new BrokerRequestError(400, "INVALID_REQUEST", "sessionId 和 permissionMode 无效。" );
        }
        writeJson(res, 200, await capabilities(sessionId, permissionMode));
        return;
      }
      if (req.method === "POST" && pathname === "/preflight") {
        const payload = await readJsonBody(req);
        if (!isPlainObject(payload)) throw new BrokerRequestError(400, "INVALID_REQUEST", "请求体必须是对象。" );
        const sessionId = normalizeSessionId(payload.sessionId ?? payload.session_id);
        const permissionMode = String(payload.permissionMode ?? payload.permission_mode ?? "").trim().toLowerCase();
        if (!sessionId || !["plan", "ask", "auto"].includes(permissionMode)) {
          throw new BrokerRequestError(400, "INVALID_REQUEST", "sessionId 和 permissionMode 无效。" );
        }
        writeJson(res, 200, await preflightAuthorization(sessionId, permissionMode as EnterpriseActionBinding["permissionMode"]));
        return;
      }
      if (req.method === "POST" && pathname === "/actions") {
        const payload = await readJsonBody(req);
        if (!isPlainObject(payload)) throw new BrokerRequestError(400, "INVALID_REQUEST", "请求体必须是对象。" );
        const sessionId = normalizeSessionId(payload.sessionId ?? payload.session_id);
        const permissionMode = String(payload.permissionMode ?? payload.permission_mode ?? "").trim().toLowerCase();
        const actionId = normalizeActionId(payload.actionId ?? payload.action_id);
        const args = isPlainObject(payload.arguments) ? payload.arguments : null;
        const idempotencyKey = String(payload.idempotencyKey ?? payload.idempotency_key ?? "").trim();
        const runId = normalizeRunId(payload.runId ?? payload.run_id);
        if (!sessionId || !["plan", "ask", "auto"].includes(permissionMode) || !actionId || !args || !idempotencyKey || !runId) {
          throw new BrokerRequestError(400, "INVALID_REQUEST", "企业动作参数无效。" );
        }
        const forbidden = containsForbiddenArgumentKey(args);
        if (forbidden) throw new BrokerRequestError(400, "ARGUMENT_IDENTITY_OVERRIDE", `禁止覆盖身份字段：${forbidden}`);
        if (jsonByteLength(args) > 64 * 1024 || jsonByteLength(payload) > MAX_REQUEST_BYTES) {
          throw new BrokerRequestError(413, "ARGUMENTS_TOO_LARGE", "企业动作参数过大。" );
        }
        writeJson(res, 200, await action(sessionId, permissionMode, actionId, args, idempotencyKey.slice(0, 160), runId));
        return;
      }
      const operationMatch = pathname.match(/^\/operations\/([^/]+)$/);
      if (req.method === "GET" && operationMatch) {
        // The Python process can read a pending operation after the UI event,
        // but it cannot call the POST confirm route through this host.
        const operationId = decodeURIComponent(operationMatch[1]);
        const operation = pending.get(operationId);
        if (!operation) throw new BrokerRequestError(404, "ENTERPRISE_OPERATION_NOT_FOUND", "企业操作已失效。" );
        writeJson(res, 200, await getOperation(operationId, {
          sessionId: operation.sessionId,
          permissionMode: operation.permissionMode,
          authGeneration: operation.authGeneration,
        }));
        return;
      }
      writeJson(res, 404, { code: "NOT_FOUND", message: "not found" });
    };
    void run().catch((error: unknown) => {
      const status = Number((error as { statusCode?: unknown })?.statusCode ?? (error as BrokerRequestError)?.status);
      const code = error instanceof BrokerRequestError ? error.code : "BROKER_ERROR";
      const message = error instanceof BrokerRequestError ? safeMessage(error.message) : "企业动作 broker 请求失败。";
      if (status === 413) {
        res.setHeader("Connection", "close");
        if ((error as { closeRequest?: unknown }).closeRequest) res.once("finish", () => req.destroy());
      }
      if (!res.headersSent) writeJson(res, Number.isInteger(status) && status >= 400 ? status : 400, { code, message });
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("enterprise action broker did not expose a loopback address");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    token,
    close: async () => {
      if (closed) return;
      closed = true;
      sessions.clear();
      pending.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
    preflightAuthorization,
    confirmOperation,
    getOperation,
  };
}
