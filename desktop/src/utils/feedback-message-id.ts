import type { Message } from "../store";

/**
 * The feedback APIs address a persisted row as `<session>-i<index>[-<id>]`.
 * Renderer messages deliberately keep their uid() React key when a disk tail
 * is merged, so this canonical address lives in metadata instead of replacing
 * the visible id and remounting the bubble.
 */
export const FEEDBACK_MESSAGE_ID_METADATA_KEY = "feedback_message_id";

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : String(value ?? "").trim();
}

function storedRowId(raw: Record<string, unknown>): string {
  const metadata = raw.metadata;
  const metadataId =
    metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>).message_id ??
        (metadata as Record<string, unknown>).messageId
      : "";
  return clean(raw.id ?? raw.message_id ?? raw.messageId ?? metadataId);
}

/** Build the exact id accepted by the local desktop/Python durable resolver. */
export function feedbackMessageIdForSessionRow(
  sessionId: string,
  index: number,
  raw: unknown,
): string {
  const sid = clean(sessionId);
  const row = raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
  const storedId = storedRowId(row);
  return `${sid}-i${Math.max(0, Math.floor(Number(index) || 0))}${storedId ? `-${storedId}` : ""}`;
}

/** Resolve the canonical feedback address while preserving the UI message id. */
export function feedbackMessageIdForMessage(message: Message | undefined | null): string {
  if (!message) return "";
  const metadata = message.metadata;
  const canonical =
    metadata && typeof metadata === "object"
      ? clean(metadata[FEEDBACK_MESSAGE_ID_METADATA_KEY])
      : "";
  return canonical || clean(message.id);
}

/**
 * Feedback controls must wait for the durable row address.  The renderer id
 * is intentionally a UI key and is not accepted by the Electron/Python
 * feedback resolvers, so callers should use this predicate before wiring a
 * feedback action to a live assistant row.
 */
export function hasCanonicalFeedbackMessageId(message: Message | undefined | null): boolean {
  if (!message?.metadata || typeof message.metadata !== "object") return false;
  return clean(message.metadata[FEEDBACK_MESSAGE_ID_METADATA_KEY]).length > 0;
}
