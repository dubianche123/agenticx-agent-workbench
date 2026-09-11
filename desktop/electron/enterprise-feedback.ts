import crypto from "node:crypto";

import { isSafeSessionId } from "./session-messages-disk";

export {
  desktopFeedbackAccountStampsEqual,
  desktopFeedbackScopeHandshakeMatches,
  normalizeDesktopFeedbackAccountScope,
  normalizeDesktopFeedbackAccountStamp,
  shouldApplyDesktopFeedbackAccountStamp,
} from "./feedback-scope";

/** Values accepted by the desktop feedback bridge. */
export const DESKTOP_FEEDBACK_VALUES = ["like", "dislike"] as const;
export type DesktopFeedbackValue = (typeof DESKTOP_FEEDBACK_VALUES)[number];
/** Opaque stable scope emitted by the authenticated Electron host. */
export const DESKTOP_FEEDBACK_SCOPE_ID_MAX = 512;

/**
 * The portal stores external identifiers in a bounded varchar.  The
 * renderer-facing message id is normally `session-i<index>-<stored id>`; a
 * digest is used for the unusual case where that display id is too long.
 */
export const DESKTOP_FEEDBACK_EXTERNAL_MESSAGE_ID_MAX = 128;
export const DESKTOP_FEEDBACK_ANSWER_EXCERPT_MAX = 16_384;

const SAFE_EXTERNAL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
// Renderer ids include the session prefix and persisted id.  Permit a
// bounded-but-larger local value so it can still be resolved and hashed into
// the portal's 128-character canonical column.
const MAX_INCOMING_MESSAGE_ID_CHARS = 1_024;

export type DesktopFeedbackTarget = {
  sessionId: string;
  /** Canonical id sent to the portal and returned by the list endpoint. */
  externalMessageId: string;
  answerExcerpt: string | null;
  provider: string | null;
  model: string | null;
  traceId: string | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function boundedText(value: unknown, maxChars: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized) return null;
  // Preserve line breaks in an answer snapshot, but never send NUL or other
  // invisible control bytes to a remote audit/feedback store.
  const safe = normalized.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ");
  return Array.from(safe).slice(0, maxChars).join("") || null;
}

function metadataRecord(value: unknown): Record<string, unknown> {
  const direct = asRecord(value);
  if (direct) return direct;
  if (typeof value !== "string") return {};
  try {
    return asRecord(JSON.parse(value)) ?? {};
  } catch {
    return {};
  }
}

/** Validate a local session id before it is used in a path or URL query. */
export function normalizeDesktopFeedbackSessionId(value: unknown): string | null {
  const normalized = typeof value === "string" ? value.trim() : "";
  return isSafeSessionId(normalized) ? normalized : null;
}

/** Validate an incoming renderer message id without treating it as a path. */
export function normalizeDesktopFeedbackMessageId(value: unknown): string | null {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (
    !normalized ||
    normalized.length > MAX_INCOMING_MESSAGE_ID_CHARS ||
    !SAFE_EXTERNAL_ID.test(normalized) ||
    normalized.includes("..")
  ) {
    return null;
  }
  return normalized;
}

export function normalizeDesktopFeedbackValue(value: unknown): DesktopFeedbackValue | null {
  return value === "like" || value === "dislike" ? value : null;
}

/**
 * Validate a client supplied scope only as an opaque comparison token.
 * Authorization always comes from the current main-process identity; this
 * helper never derives or accepts an identity from renderer input.
 */
export function normalizeDesktopFeedbackScopeId(value: unknown): string | null {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (
    !normalized ||
    normalized.length > DESKTOP_FEEDBACK_SCOPE_ID_MAX ||
    Array.from(normalized).some((char) => char.charCodeAt(0) < 0x20)
  ) {
    return null;
  }
  return normalized;
}

/**
 * Verify that a feedback list response still belongs to the account that was
 * captured before its GET started.  A supplied expected scope is the strict
 * renderer stale-request check; the captured/current comparison keeps older
 * callers from accepting a response across an account transition.
 */
export function desktopFeedbackListScopeMatches(
  capturedScopeId: unknown,
  currentScopeId: unknown,
  expectedScopeId?: unknown,
): boolean {
  const current = normalizeDesktopFeedbackScopeId(currentScopeId);
  if (!current) return false;
  if (expectedScopeId !== undefined) {
    const expected = normalizeDesktopFeedbackScopeId(expectedScopeId);
    return Boolean(expected && current === expected);
  }
  const captured = normalizeDesktopFeedbackScopeId(capturedScopeId);
  return Boolean(captured && captured === current);
}

/**
 * Build a deterministic source-scoped id from the local row identity.  The
 * readable form is retained for normal rows, while the digest prevents a
 * pathological local id from overflowing the portal column.
 */
export function canonicalDesktopExternalMessageId(
  sessionId: string,
  index: number,
  storedId: string,
): string {
  const readable = desktopRendererMessageId(sessionId, index, storedId);
  if (readable.length <= DESKTOP_FEEDBACK_EXTERNAL_MESSAGE_ID_MAX && SAFE_EXTERNAL_ID.test(readable)) {
    return readable;
  }
  const digest = crypto
    .createHash("sha256")
    .update(`${sessionId}\u0000${index}\u0000${storedId}`)
    .digest("hex");
  return `desktop-message-${digest}`;
}

/** The exact id used by mapLoadedSessionMessage for a persisted row. */
export function desktopRendererMessageId(
  sessionId: string,
  index: number,
  storedId: string,
): string {
  return `${sessionId}-i${index}${storedId ? `-${storedId}` : ""}`;
}

function rowStoredId(row: Record<string, unknown>): string {
  // `id` is what mapLoadedSessionMessage uses for the visible id.  The other
  // names are accepted for old/session-forwarding snapshots but never trust
  // arbitrary client-supplied ids here.
  return String(row.id ?? row.message_id ?? "").trim();
}

function rowStatusIsComplete(row: Record<string, unknown>): boolean {
  const status = row.status;
  if (
    status !== undefined &&
    status !== null &&
    !["complete", "completed"].includes(String(status).trim().toLowerCase())
  ) {
    return false;
  }
  const metadata = metadataRecord(row.metadata);
  if (metadata.turn_terminal === false || metadata.source === "interrupted-partial") return false;
  return true;
}

/**
 * Resolve a renderer id to one persisted assistant row.  This is the local
 * ownership boundary: user/tool/stream rows and ids from another session are
 * rejected before any Bearer request leaves the main process.
 */
export function resolveDesktopAssistantMessage(
  sessionIdInput: unknown,
  messageIdInput: unknown,
  messages: unknown[],
): DesktopFeedbackTarget | null {
  const sessionId = normalizeDesktopFeedbackSessionId(sessionIdInput);
  const messageId = normalizeDesktopFeedbackMessageId(messageIdInput);
  if (!sessionId || !messageId || !Array.isArray(messages)) return null;

  for (let index = 0; index < messages.length; index += 1) {
    const row = asRecord(messages[index]);
    if (!row || row.role !== "assistant" || !rowStatusIsComplete(row)) continue;
    const storedId = rowStoredId(row);
    if (!boundedText(row.content, DESKTOP_FEEDBACK_ANSWER_EXCERPT_MAX)) continue;
    const rendererId = desktopRendererMessageId(sessionId, index, storedId);
    const externalMessageId = canonicalDesktopExternalMessageId(sessionId, index, storedId);
    // Accept the persisted raw id for callers that have not passed through
    // mapLoadedSessionMessage, but always persist/return the canonical id.
    if (messageId !== rendererId && (!storedId || messageId !== storedId)) continue;

    const metadata = metadataRecord(row.metadata);
    const model = boundedText(row.model ?? metadata.model, 160);
    const provider = boundedText(
      row.provider ?? metadata.provider ?? metadata.provider_id,
      128,
    ) ?? (model?.includes("/") ? model.slice(0, model.indexOf("/")) : null);
    const traceId = boundedText(
      row.trace_id ?? row.traceId ?? metadata.trace_id ?? metadata.traceId,
      128,
    );
    return {
      sessionId,
      externalMessageId,
      answerExcerpt: boundedText(row.content, DESKTOP_FEEDBACK_ANSWER_EXCERPT_MAX),
      provider,
      model,
      traceId,
    };
  }
  return null;
}

/** Translate portal canonical ids back to the renderer's visible ids. */
export function rendererMessageIdForCanonicalExternalId(
  sessionIdInput: unknown,
  externalMessageIdInput: unknown,
  messages: unknown[],
): string | null {
  const sessionId = normalizeDesktopFeedbackSessionId(sessionIdInput);
  const externalMessageId = normalizeDesktopFeedbackMessageId(externalMessageIdInput);
  if (!sessionId || !externalMessageId || !Array.isArray(messages)) return null;
  for (let index = 0; index < messages.length; index += 1) {
    const row = asRecord(messages[index]);
    if (!row || row.role !== "assistant" || !rowStatusIsComplete(row)) continue;
    const storedId = rowStoredId(row);
    if (!boundedText(row.content, DESKTOP_FEEDBACK_ANSWER_EXCERPT_MAX)) continue;
    if (canonicalDesktopExternalMessageId(sessionId, index, storedId) !== externalMessageId) continue;
    return desktopRendererMessageId(sessionId, index, storedId);
  }
  return null;
}
