import { NextResponse } from "next/server";

import {
  deleteDesktopChatFeedback,
  DESKTOP_FEEDBACK_SOURCE,
  listDesktopChatFeedback,
  type DesktopFeedbackRecord,
  type DesktopFeedbackValue,
  DesktopFeedbackValidationError,
  upsertDesktopChatFeedback,
} from "../../../../../lib/desktop-chat-feedback";
import { resolveDesktopIdentity, type DesktopIdentity } from "../../../../../lib/desktop-auth";

export const runtime = "nodejs";

const MAX_REQUEST_BYTES = 32 * 1024;
const MAX_ANSWER_EXCERPT_CHARS = 16_384;
const MAX_PROVIDER_CHARS = 128;
const MAX_MODEL_CHARS = 160;
const MAX_TRACE_ID_CHARS = 128;
const SET_KEYS = [
  "external_session_id",
  "external_message_id",
  "value",
  "answer_excerpt",
  "provider",
  "model",
  "trace_id",
] as const;
const CLEAR_KEYS = ["external_session_id", "external_message_id"] as const;

type JsonObject = Record<string, unknown>;

function errorResponse(status: number, code: string, message: string): NextResponse {
  return NextResponse.json(
    { code, message },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

function isPlainObject(value: unknown): value is JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(value: JsonObject, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function boundedText(
  value: unknown,
  field: string,
  maxChars: number,
  options: { required?: boolean; allowEmpty?: boolean; allowLineBreaks?: boolean } = {},
): string | null {
  if (value === undefined) {
    if (options.required) throw new DesktopFeedbackValidationError(`${field} is required`);
    return null;
  }
  if (typeof value !== "string") throw new DesktopFeedbackValidationError(`${field} must be a string`);
  const normalized = value.trim();
  if ((!normalized && !options.allowEmpty) || Array.from(normalized).length > maxChars) {
    throw new DesktopFeedbackValidationError(`${field} is invalid`);
  }
  const controlPattern = options.allowLineBreaks
    ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/
    : /[\u0000-\u001f\u007f]/;
  if (controlPattern.test(normalized)) {
    throw new DesktopFeedbackValidationError(`${field} contains control characters`);
  }
  return normalized || null;
}

function externalId(value: unknown, field: string): string {
  const normalized = boundedText(value, field, 128, { required: true });
  if (!normalized || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(normalized) || normalized.includes("..")) {
    throw new DesktopFeedbackValidationError(`${field} is invalid`);
  }
  return normalized;
}

function feedbackValue(value: unknown): DesktopFeedbackValue {
  if (value === "like" || value === "dislike") return value;
  throw new DesktopFeedbackValidationError("value must be like or dislike");
}

async function readJsonBody(request: Request): Promise<JsonObject> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > MAX_REQUEST_BYTES) {
    throw new DesktopFeedbackValidationError("request body too large");
  }
  const reader = request.body?.getReader();
  if (!reader) throw new DesktopFeedbackValidationError("request body is required");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_REQUEST_BYTES) throw new DesktopFeedbackValidationError("request body too large");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  let parsed: unknown;
  try {
    const body = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    parsed = JSON.parse(decoder.decode(body)) as unknown;
  } catch {
    throw new DesktopFeedbackValidationError("invalid json body");
  }
  if (!isPlainObject(parsed)) throw new DesktopFeedbackValidationError("json body must be an object");
  return parsed;
}

async function authenticate(
  request: Request,
): Promise<{ ok: true; identity: DesktopIdentity } | { ok: false; response: NextResponse }> {
  let identity: DesktopIdentity | null;
  try {
    identity = await resolveDesktopIdentity(request);
  } catch {
    return { ok: false, response: errorResponse(401, "40101", "企业登录已失效，请重新登录") };
  }
  if (!identity) {
    return { ok: false, response: errorResponse(401, "40101", "企业登录已失效，请重新登录") };
  }
  if (!identity.scopes.includes("desktop:managed")) {
    return { ok: false, response: errorResponse(403, "40301", "当前令牌不能提交桌面反馈") };
  }
  return { ok: true, identity };
}

function actor(identity: DesktopIdentity) {
  return {
    tenantId: identity.tenantId,
    userId: identity.userId,
    departmentId: identity.deptId,
  };
}

function publicRecord(record: DesktopFeedbackRecord) {
  return {
    external_session_id: record.externalSessionId,
    external_message_id: record.externalMessageId,
    // Keep the existing desktop renderer parser/API vocabulary available while
    // making the canonical external ids explicit for non-renderer clients.
    session_id: record.externalSessionId,
    message_id: record.externalMessageId,
    value: record.value,
    updated_at: record.updatedAt,
  };
}

function handleError(error: unknown): NextResponse {
  if (error instanceof DesktopFeedbackValidationError) {
    return errorResponse(400, "40001", error.message);
  }
  // Never return database errors, SQL, or token-bearing upstream text to a
  // desktop client.  The server log remains available for operators.
  console.error("[desktop/chat/feedback] request failed:", error);
  return errorResponse(503, "50301", "桌面反馈暂时无法保存");
}

function queryValues(request: Request): { sessionId: string; messageIds?: string[] } {
  const url = new URL(request.url);
  const allowed = new Set(["external_session_id", "external_message_id"]);
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key)) throw new DesktopFeedbackValidationError("invalid query parameter");
  }
  const sessionValues = url.searchParams.getAll("external_session_id");
  if (sessionValues.length !== 1) {
    throw new DesktopFeedbackValidationError("external_session_id is required exactly once");
  }
  const sessionId = externalId(sessionValues[0], "external_session_id");
  const values = url.searchParams
    .getAll("external_message_id")
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  const messageIds = values.length > 0
    ? [...new Set(values.map((value) => externalId(value, "external_message_id")))]
    : undefined;
  if (messageIds && messageIds.length > 100) {
    throw new DesktopFeedbackValidationError("external_message_id accepts at most 100 values");
  }
  return { sessionId, messageIds };
}

function setInput(body: JsonObject) {
  if (!hasOnlyKeys(body, SET_KEYS)) {
    throw new DesktopFeedbackValidationError("unknown feedback field");
  }
  return {
    externalSessionId: externalId(body.external_session_id, "external_session_id"),
    externalMessageId: externalId(body.external_message_id, "external_message_id"),
    value: feedbackValue(body.value),
    answerExcerpt: boundedText(
      body.answer_excerpt,
      "answer_excerpt",
      MAX_ANSWER_EXCERPT_CHARS,
      { allowLineBreaks: true },
    ),
    provider: boundedText(body.provider, "provider", MAX_PROVIDER_CHARS),
    model: boundedText(body.model, "model", MAX_MODEL_CHARS),
    traceId: boundedText(body.trace_id, "trace_id", MAX_TRACE_ID_CHARS),
  };
}

function clearInput(body: JsonObject) {
  if (!hasOnlyKeys(body, CLEAR_KEYS)) {
    throw new DesktopFeedbackValidationError("unknown feedback field");
  }
  return {
    externalSessionId: externalId(body.external_session_id, "external_session_id"),
    externalMessageId: externalId(body.external_message_id, "external_message_id"),
  };
}

export async function GET(request: Request): Promise<Response> {
  const auth = await authenticate(request);
  if (!auth.ok) return auth.response;
  try {
    const query = queryValues(request);
    const records = await listDesktopChatFeedback({
      actor: actor(auth.identity),
      source: DESKTOP_FEEDBACK_SOURCE,
      externalSessionId: query.sessionId,
      externalMessageIds: query.messageIds,
    });
    return NextResponse.json(
      { code: "00000", message: "ok", data: { items: records.map(publicRecord) } },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return handleError(error);
  }
}

export async function PUT(request: Request): Promise<Response> {
  const auth = await authenticate(request);
  if (!auth.ok) return auth.response;
  try {
    const input = setInput(await readJsonBody(request));
    const record = await upsertDesktopChatFeedback({
      actor: actor(auth.identity),
      source: DESKTOP_FEEDBACK_SOURCE,
      ...input,
    });
    return NextResponse.json(
      { code: "00000", message: "ok", data: { feedback: publicRecord(record), viewer_value: record.value } },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return handleError(error);
  }
}

export async function DELETE(request: Request): Promise<Response> {
  const auth = await authenticate(request);
  if (!auth.ok) return auth.response;
  try {
    const input = clearInput(await readJsonBody(request));
    await deleteDesktopChatFeedback({
      actor: actor(auth.identity),
      source: DESKTOP_FEEDBACK_SOURCE,
      ...input,
    });
    return NextResponse.json(
      {
        code: "00000",
        message: "ok",
        data: {
          feedback: {
            external_session_id: input.externalSessionId,
            external_message_id: input.externalMessageId,
            session_id: input.externalSessionId,
            message_id: input.externalMessageId,
            value: null,
          },
          viewer_value: null,
        },
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return handleError(error);
  }
}
