import type { Message } from "../store";
import type { SessionTurn } from "./session-turns";

export function clientTurnIdForMessage(message: Message | undefined | null): string {
  if (!message?.metadata || typeof message.metadata !== "object") return "";
  const metadata = message.metadata as Record<string, unknown>;
  return String(
    metadata.client_turn_id ?? metadata.clientTurnId ?? "",
  ).trim();
}

function messageBelongsToSession(message: Message, sessionId?: string): boolean {
  const sid = String(sessionId || "").trim();
  if (!sid) return true;
  const owner = String(message.ownerSessionId || "").trim();
  if (owner && owner !== sid) return false;
  const metadata = message.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return true;
  const rawSession = String(
    (metadata as Record<string, unknown>).session_id ??
      (metadata as Record<string, unknown>).sessionId ??
      "",
  ).trim();
  return !rawSession || rawSession === sid;
}

/** Only the last assistant row before the next user row owns a turn card. */
export function isFinalAssistantForTurn(
  message: Message,
  messages: Message[] | undefined | null,
): boolean {
  if (message.role !== "assistant" || message.id === "__stream__") return false;
  const rows = messages ?? [];
  const index = rows.findIndex((row) => row.id === message.id);
  if (index < 0) return false;
  for (let i = index + 1; i < rows.length; i += 1) {
    if (rows[i]?.role === "user") break;
    if (rows[i]?.role === "assistant") return false;
  }
  return true;
}

/**
 * Bind a rendered answer to its turn through the preceding user's durable
 * client_turn_id.  The API returns newest-first, so positional ordinal
 * matching is deliberately forbidden; legacy rows without that id have no
 * safe undo target and return null.
 */
export function sessionTurnForAssistantMessage(
  turns: SessionTurn[],
  message: Message,
  messages: Message[] | undefined | null,
  sessionId?: string,
): SessionTurn | null {
  if (!isFinalAssistantForTurn(message, messages)) return null;
  if (!messageBelongsToSession(message, sessionId)) return null;
  const rows = messages ?? [];
  const index = rows.findIndex((row) => row.id === message.id);
  if (index < 0) return null;
  let userIndex = -1;
  for (let i = index - 1; i >= 0; i -= 1) {
    if (rows[i]?.role === "user") {
      userIndex = i;
      break;
    }
  }
  if (userIndex < 0) return null;
  if (!messageBelongsToSession(rows[userIndex]!, sessionId)) return null;
  const clientTurnId = clientTurnIdForMessage(rows[userIndex]);
  if (!clientTurnId) return null;
  const matched = turns.find((turn) => {
    if (turn.clientTurnId !== clientTurnId) return false;
    const turnSessionId = String(turn.sessionId || "").trim();
    return !sessionId || !turnSessionId || turnSessionId === sessionId;
  });
  return matched ?? null;
}
