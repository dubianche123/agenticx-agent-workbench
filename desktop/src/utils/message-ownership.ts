import { dedupeSupervisorNotices } from "./supervisor-notice";
import { dedupeContinuationNotices } from "./continuation-notice";
import type { Message } from "../store";

/**
 * Cross-session message ownership invariant.
 *
 * Root cause of the recurring "session A's content shows in session B" bug:
 * `pane.messages` was keyed only by the UI slot (`paneId`), so a message had no
 * record of which session it belonged to. Every guard against cross-session
 * leakage was an ad-hoc `latestSid === sid` check scattered across call sites —
 * miss one path and a foreign message renders under the wrong session.
 *
 * The structural fix: every message carries `ownerSessionId`, and the render
 * layer only shows messages whose owner matches the pane's current session.
 * Even if a stray write lands in `pane.messages` while the pane shows another
 * session, it can never be displayed there.
 */

/** A message-like object that may carry its owning session id. */
export interface OwnedMessage {
  ownerSessionId?: string;
}

type NoticePick = Pick<Message, "role" | "content" | "metadata">;

function messageRole(message: OwnedMessage): string | undefined {
  if ("role" in message && typeof message.role === "string") return message.role;
  return undefined;
}

function messageContent(message: OwnedMessage): unknown {
  return "content" in message ? message.content : undefined;
}

function isNoticePick<T extends OwnedMessage>(message: T): message is T & NoticePick {
  return (
    "role" in message &&
    typeof message.role === "string" &&
    "content" in message &&
    typeof message.content === "string"
  );
}

/**
 * Whether *msg* may render while the pane is showing *sessionId*.
 *
 * When the pane is bound to a real session, only rows stamped with that
 * `ownerSessionId` render. Untagged rows are hidden — callers must stamp via
 * `setPaneMessages` / `addPaneMessage` extras before display.
 *
 * Important for "全新对话" lazy mode: when the pane has no bound session
 * (`""`), only show rows that are also unbound. This prevents any late async
 * write from the previous real session from bleeding into the fresh composer.
 */
export function messageBelongsToSession(
  msg: OwnedMessage,
  sessionId: string | undefined | null,
): boolean {
  const sid = String(sessionId ?? "").trim();
  if (!sid) {
    const ownerWhenUnbound = String(msg.ownerSessionId ?? "").trim();
    return ownerWhenUnbound.length === 0;
  }
  const owner = String(msg.ownerSessionId ?? "").trim();
  if (!owner) return false;
  return owner === sid;
}

/**
 * Collapse back-to-back duplicate user messages that share the same trimmed
 * content. These can appear transiently when an optimistic write races with a
 * disk-reload path that both land in pane.messages before reconciliation runs.
 * Keeping only the last occurrence preserves any richer metadata (attachments,
 * ownerSessionId) that the disk copy may carry while dropping the bare
 * optimistic duplicate.
 */
function dedupeConsecutiveUserMessages<T extends OwnedMessage>(messages: T[]): T[] {
  const out: T[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const next = messages[i + 1];
    const content = messageContent(m);
    const nextContent = next ? messageContent(next) : undefined;
    if (
      messageRole(m) === "user" &&
      next &&
      messageRole(next) === "user" &&
      String(content ?? "").trim() === String(nextContent ?? "").trim() &&
      String(content ?? "").trim().length > 0
    ) {
      // Skip this copy; the next one will be included (or itself deduplicated).
      continue;
    }
    out.push(m);
  }
  return out;
}

/**
 * Filter a message list down to those that belong to *sessionId*.
 * Pure; preserves order; never mutates the input.
 */
export function visibleMessagesForSession<T extends OwnedMessage>(
  messages: readonly T[],
  sessionId: string | undefined | null,
): T[] {
  const filtered = messages.filter((m) => messageBelongsToSession(m, sessionId));
  const deduped = dedupeConsecutiveUserMessages(filtered);
  const noticeMessages: Array<T & NoticePick> = [];
  for (const message of deduped) {
    if (!isNoticePick(message)) return deduped;
    noticeMessages.push(message);
  }
  return dedupeContinuationNotices(dedupeSupervisorNotices(noticeMessages));
}
