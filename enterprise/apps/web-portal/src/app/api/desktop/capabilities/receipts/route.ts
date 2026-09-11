import { canonicalizeCapabilityId, parseCapabilityId } from "@agenticx/config";
import {
  desktopDeviceInstanceId,
  insertCapabilitySyncReceipt,
  listLatestCapabilitySyncReceipts,
} from "@agenticx/iam-core";
import { NextResponse } from "next/server";

import {
  listAvailableCapabilitiesForUser,
  type PortalCapability,
} from "../../../../../lib/capability-packs-reader";
import { resolveDesktopIdentity, type DesktopIdentity } from "../../../../../lib/desktop-auth";

export const runtime = "nodejs";

const MAX_RECEIPT_REQUEST_BYTES = 16 * 1024;
const MAX_CAPABILITY_ID_CHARS = 64;
const MAX_VERSION_CHARS = 64;
const MAX_DIGEST_CHARS = 64;
const MAX_ERROR_CODE_CHARS = 64;
const MAX_MESSAGE_CHARS = 1_024;
const MAX_TIMESTAMP_CHARS = 64;
const CLIENT_RECEIPT_STATUSES = [
  "pending",
  "waiting",
  "downloading",
  "verifying",
  "applied",
  "failed",
] as const;
const RECEIPT_KEYS = [
  "appliedAt",
  "attemptedAt",
  "capabilityId",
  "digest",
  "errorCode",
  "kind",
  "message",
  "status",
  "version",
] as const;

type ReceiptBody = Record<string, unknown>;

class ReceiptRequestTooLargeError extends Error {}
class ReceiptRequestInvalidError extends Error {}

function errorResponse(status: number, code: string, message: string): NextResponse {
  return NextResponse.json({ code, message }, { status });
}

function isPlainObject(value: unknown): value is ReceiptBody {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactlyAllowedKeys(value: ReceiptBody): boolean {
  const keys = Object.keys(value).sort();
  const allowed = [...RECEIPT_KEYS].sort();
  return (
    keys.every((key) => (allowed as readonly string[]).includes(key)) &&
    keys.length <= allowed.length
  );
}

/** Read the actual request stream; Content-Length is only an early hint. */
async function readReceiptJson(request: Request): Promise<unknown> {
  const declaredLength = request.headers.get("content-length");
  if (
    declaredLength &&
    /^\d+$/.test(declaredLength) &&
    Number(declaredLength) > MAX_RECEIPT_REQUEST_BYTES
  ) {
    throw new ReceiptRequestTooLargeError();
  }
  const reader = request.body?.getReader();
  if (!reader) throw new ReceiptRequestInvalidError();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_RECEIPT_REQUEST_BYTES) {
        throw new ReceiptRequestTooLargeError();
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(decoder.decode(body)) as unknown;
  } catch {
    throw new ReceiptRequestInvalidError();
  }
}

function boundedText(
  body: ReceiptBody,
  field: string,
  maxChars: number,
  options: { required?: boolean; allowEmpty?: boolean } = {},
): string | undefined {
  const value = body[field];
  if (value === undefined) {
    if (options.required) throw new ReceiptRequestInvalidError(`${field} required`);
    return undefined;
  }
  if (typeof value !== "string") throw new ReceiptRequestInvalidError(`${field} must be a string`);
  const normalized = value.trim();
  if ((!normalized && !options.allowEmpty) || [...normalized].length > maxChars) {
    throw new ReceiptRequestInvalidError(`${field} is invalid`);
  }
  // Keep persisted diagnostics safe for logs/UI and reject rather than silently
  // changing an attested client message.
  if (/[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new ReceiptRequestInvalidError(`${field} contains control characters`);
  }
  return normalized;
}

function parseClientDate(
  body: ReceiptBody,
  field: "attemptedAt" | "appliedAt",
  now: number,
): Date | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  const text = boundedText(body, field, MAX_TIMESTAMP_CHARS);
  if (!text) throw new ReceiptRequestInvalidError(`${field} is invalid`);
  const time = Date.parse(text);
  const maxPast = 30 * 24 * 60 * 60 * 1_000;
  const maxFuture = 5 * 60 * 1_000;
  if (!Number.isFinite(time) || time < now - maxPast || time > now + maxFuture) {
    throw new ReceiptRequestInvalidError(`${field} is outside the accepted time range`);
  }
  return new Date(time);
}

function normalizeClientStatus(value: unknown): "pending" | "applied" | "failed" {
  if (typeof value !== "string") throw new ReceiptRequestInvalidError("status must be a string");
  if (!(CLIENT_RECEIPT_STATUSES as readonly string[]).includes(value)) {
    throw new ReceiptRequestInvalidError("status is invalid");
  }
  if (value === "applied" || value === "failed" || value === "pending") return value;
  return "pending";
}

function capabilityIdAndKind(body: ReceiptBody): { capabilityId: string; kind: "skill" | "mcp" } {
  const suppliedId = boundedText(body, "capabilityId", MAX_CAPABILITY_ID_CHARS, { required: true });
  const capabilityId = suppliedId ? canonicalizeCapabilityId(suppliedId) : null;
  const parsed = capabilityId ? parseCapabilityId(capabilityId) : null;
  if (!capabilityId || !parsed || (parsed.kind !== "skill" && parsed.kind !== "mcp")) {
    throw new ReceiptRequestInvalidError("capabilityId is invalid");
  }
  const suppliedKind = body.kind;
  if (suppliedKind !== undefined && suppliedKind !== parsed.kind) {
    throw new ReceiptRequestInvalidError("kind does not match capabilityId");
  }
  return { capabilityId, kind: parsed.kind };
}

function assertReceiptMetadata(
  body: ReceiptBody,
  capability: PortalCapability,
  kind: "skill" | "mcp",
  status: "pending" | "applied" | "failed",
): { version: string | null; digest: string | null; errorCode: string | null; message: string | null } {
  const suppliedVersion = boundedText(body, "version", MAX_VERSION_CHARS);
  const serverVersion = capability.version?.trim() || "";
  if (suppliedVersion !== undefined && suppliedVersion !== serverVersion) {
    throw new ReceiptRequestInvalidError("version does not match the assigned capability");
  }
  const version = serverVersion || suppliedVersion || null;

  const suppliedDigest = boundedText(body, "digest", MAX_DIGEST_CHARS);
  const serverDigest = capability.bundleDigest?.trim().toLowerCase() || "";
  if (kind === "skill") {
    if (serverDigest && !/^[0-9a-f]{64}$/.test(serverDigest)) {
      // A legacy malformed Skill must not be made to look successfully synced.
      throw new Error("assigned Skill has an invalid bundle digest");
    }
    if (suppliedDigest !== undefined && !/^[0-9a-f]{64}$/i.test(suppliedDigest)) {
      throw new ReceiptRequestInvalidError("digest must be exactly 64 hexadecimal characters");
    }
    if (serverDigest && suppliedDigest && suppliedDigest.toLowerCase() !== serverDigest) {
      throw new ReceiptRequestInvalidError("digest does not match the assigned capability");
    }
    if (!serverDigest && suppliedDigest) {
      throw new ReceiptRequestInvalidError("assigned capability has no bundle digest");
    }
  } else if (suppliedDigest !== undefined) {
    throw new ReceiptRequestInvalidError("MCP receipts must not contain a digest");
  }
  const digest = serverDigest || null;

  const errorCode = boundedText(body, "errorCode", MAX_ERROR_CODE_CHARS);
  const message = boundedText(body, "message", MAX_MESSAGE_CHARS);
  if (status === "failed" && !errorCode) {
    throw new ReceiptRequestInvalidError("failed receipts require errorCode");
  }
  if (status !== "failed" && errorCode !== undefined) {
    throw new ReceiptRequestInvalidError("errorCode is only valid for failed receipts");
  }
  return {
    version,
    digest,
    errorCode: errorCode ?? null,
    message: message ?? null,
  };
}

async function authenticate(
  request: Request,
): Promise<{ ok: true; identity: DesktopIdentity } | { ok: false; response: NextResponse }> {
  let identity: DesktopIdentity | null;
  try {
    identity = await resolveDesktopIdentity(request);
  } catch {
    // Authentication/database errors are fail-closed and never expose token details.
    return { ok: false, response: errorResponse(401, "40101", "企业登录已失效，请重新登录") };
  }
  if (!identity) {
    return { ok: false, response: errorResponse(401, "40101", "企业登录已失效，请重新登录") };
  }
  if (!identity.scopes.includes("desktop:managed")) {
    return { ok: false, response: errorResponse(403, "40301", "当前令牌不能上报企业能力回执") };
  }
  return { ok: true, identity };
}

async function assignedCapabilities(identity: DesktopIdentity): Promise<PortalCapability[]> {
  // This path deliberately uses the strict assignment lookup. A failed
  // assignment query must not be interpreted as an empty list and then allow a
  // client to write a receipt for an unknown capability.
  return listAvailableCapabilitiesForUser(
    identity.tenantId,
    identity.userId,
    identity.email,
    identity.deptId,
    "desktop",
  );
}

function publicReceipt(
  receipt: Awaited<ReturnType<typeof insertCapabilitySyncReceipt>>,
): Record<string, unknown> {
  return {
    id: receipt.id,
    capabilityId: receipt.capabilityId,
    kind: receipt.kind,
    status: receipt.status,
    version: receipt.version,
    digest: receipt.digest,
    errorCode: receipt.errorCode,
    message: receipt.message,
    attemptedAt: receipt.attemptedAt,
    appliedAt: receipt.appliedAt,
    // The token id is trusted server state and is the Desktop device instance.
    deviceId: desktopDeviceInstanceId(receipt.apiTokenId),
    createdAt: receipt.createdAt,
    updatedAt: receipt.updatedAt,
  };
}

export async function POST(request: Request): Promise<NextResponse> {
  const auth = await authenticate(request);
  if (!auth.ok) return auth.response;

  let parsedBody: unknown;
  try {
    parsedBody = await readReceiptJson(request);
  } catch (error) {
    if (error instanceof ReceiptRequestTooLargeError) {
      return errorResponse(413, "41301", "receipt request is too large");
    }
    return errorResponse(400, "40001", "invalid receipt request");
  }
  if (!isPlainObject(parsedBody) || !hasExactlyAllowedKeys(parsedBody)) {
    return errorResponse(400, "40001", "receipt request contains unsupported fields");
  }

  let identityCapabilities: PortalCapability[];
  try {
    identityCapabilities = await assignedCapabilities(auth.identity);
  } catch (error) {
    console.error("[desktop/capabilities/receipts] assignment lookup failed:", error);
    return errorResponse(503, "50301", "capability assignment is temporarily unavailable");
  }

  try {
    const { capabilityId, kind } = capabilityIdAndKind(parsedBody);
    const capability = identityCapabilities.find((item) => item.id === capabilityId);
    if (!capability) {
      return errorResponse(403, "40302", "capability is not assigned to this device user");
    }
    if (capability.kind !== kind) {
      return errorResponse(400, "40001", "capability kind does not match assignment");
    }
    const status = normalizeClientStatus(parsedBody.status);
    const metadata = assertReceiptMetadata(parsedBody, capability, kind, status);
    const now = Date.now();
    const attemptedAt = parseClientDate(parsedBody, "attemptedAt", now) ?? new Date(now);
    const appliedAt = status === "applied"
      ? parseClientDate(parsedBody, "appliedAt", now) ?? new Date(now)
      : undefined;
    if (status !== "applied" && parsedBody.appliedAt !== undefined) {
      throw new ReceiptRequestInvalidError("appliedAt is only valid for applied receipts");
    }
    const receipt = await insertCapabilitySyncReceipt({
      tenantId: auth.identity.tenantId,
      userId: auth.identity.userId,
      apiTokenId: auth.identity.tokenId,
      capabilityId,
      kind,
      status,
      version: metadata.version,
      digest: metadata.digest,
      errorCode: metadata.errorCode,
      message: metadata.message,
      attemptedAt,
      appliedAt: appliedAt ?? null,
    });
    return NextResponse.json(
      { code: "00000", message: "ok", data: { receipt: publicReceipt(receipt) } },
      { status: 201, headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    if (error instanceof ReceiptRequestInvalidError) {
      return errorResponse(400, "40001", "invalid receipt fields");
    }
    console.error("[desktop/capabilities/receipts] write failed:", error);
    return errorResponse(503, "50301", "capability receipt is temporarily unavailable");
  }
}

export async function GET(request: Request): Promise<NextResponse> {
  const auth = await authenticate(request);
  if (!auth.ok) return auth.response;

  let identityCapabilities: PortalCapability[];
  try {
    identityCapabilities = await assignedCapabilities(auth.identity);
  } catch (error) {
    console.error("[desktop/capabilities/receipts] assignment lookup failed:", error);
    return errorResponse(503, "50301", "capability assignment is temporarily unavailable");
  }
  const assignedIds = identityCapabilities.map((item) => item.id);
  const url = new URL(request.url);
  if (url.searchParams.getAll("capabilityId").length > 1) {
    return errorResponse(400, "40001", "capabilityId must be provided once");
  }
  const requestedRaw = url.searchParams.get("capabilityId");
  let requestedId: string | undefined;
  if (requestedRaw !== null) {
    const canonicalId = canonicalizeCapabilityId(requestedRaw);
    requestedId = canonicalId ?? undefined;
    const parsed = requestedId ? parseCapabilityId(requestedId) : null;
    if (!requestedId || !parsed || (parsed.kind !== "skill" && parsed.kind !== "mcp")) {
      return errorResponse(400, "40001", "capabilityId is invalid");
    }
    if (!assignedIds.includes(requestedId)) {
      return errorResponse(404, "40401", "capability receipt not found");
    }
  }
  if (assignedIds.length === 0) {
    return NextResponse.json(
      { code: "00000", message: "ok", data: { receipts: [] } },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  }

  try {
    const receipts = await listLatestCapabilitySyncReceipts({
      tenantId: auth.identity.tenantId,
      userId: auth.identity.userId,
      apiTokenId: auth.identity.tokenId,
      ...(requestedId ? { capabilityId: requestedId } : { capabilityIds: assignedIds }),
    });
    // The SQL predicate is authoritative; this final projection also prevents
    // a future repository change from leaking a row outside the effective list.
    const assignedSet = new Set(assignedIds);
    const filtered = receipts.filter(
      (receipt) =>
        receipt.tenantId === auth.identity.tenantId &&
        receipt.userId === auth.identity.userId &&
        receipt.apiTokenId === auth.identity.tokenId &&
        assignedSet.has(receipt.capabilityId),
    );
    return NextResponse.json(
      { code: "00000", message: "ok", data: { receipts: filtered.map(publicReceipt) } },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    console.error("[desktop/capabilities/receipts] read failed:", error);
    return errorResponse(503, "50301", "capability receipts are temporarily unavailable");
  }
}
