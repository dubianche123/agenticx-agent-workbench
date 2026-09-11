import type { Message } from "../store";

/**
 * Markers shared with the durable feedback resolver for an interrupted
 * stream.  A partial body can remain visible after Stop, but it is not a
 * completed assistant answer and must not expose a feedback action.
 */
export function isCompletedAssistantForFeedback(
  message: Pick<Message, "role" | "id" | "metadata"> | undefined | null,
): boolean {
  if (!message || message.role !== "assistant" || message.id === "__stream__") return false;
  const metadata = message.metadata;
  if (!metadata || typeof metadata !== "object") return true;
  const normalizeMarker = (value: unknown): string =>
    String(value ?? "")
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/g, "_");
  const status = normalizeMarker(metadata.status);
  if (
    status !== undefined &&
    status !== null &&
    status.length > 0 &&
    !["complete", "completed"].includes(status)
  ) {
    return false;
  }

  // Local stop/barge-in rows and backend truncation rows use several metadata
  // shapes. Treat every explicit interruption/partial marker as authoritative,
  // even if a stale final payload also reports `turn_terminal: true`.
  const turnTerminal = normalizeMarker(metadata.turn_terminal);
  if (metadata.turn_terminal === false || turnTerminal === "false" || turnTerminal === "0") {
    return false;
  }
  const incompleteBooleanKeys = [
    "partial",
    "interrupted",
    "aborted",
    "cancelled",
    "canceled",
    "truncated",
    "suspected_truncated_final",
  ];
  const isExplicitIncompleteMarker = (value: unknown): boolean => {
    if (value === true) return true;
    if (value === false || value === null || value === undefined) return false;
    const marker = normalizeMarker(value);
    return Boolean(marker) && !["false", "no", "none", "null", "off", "0"].includes(marker);
  };
  if (
    incompleteBooleanKeys.some((key) => isExplicitIncompleteMarker(metadata[key]))
  ) {
    return false;
  }
  const incompleteMarker = (value: unknown): boolean => {
    const marker = normalizeMarker(value);
    if (!marker || marker === "false" || marker === "0") return false;
    return /(interrupt|partial|truncat|barge_in|abort|cancel)/.test(marker);
  };
  for (const key of [
    "source",
    "kind",
    "status",
    "terminal_reason",
    "terminalReason",
    "reason",
    "cause",
    "termination_reason",
    "terminationReason",
    "completion_reason",
  ]) {
    if (incompleteMarker(metadata[key])) return false;
  }
  return true;
}
