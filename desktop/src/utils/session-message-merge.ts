import type { Message } from "../store";
import { isOrphanFormattedToolResultMessage } from "./orphan-formatted-tool";
import { isEphemeralConfirmReceiptMessage } from "./noisy-chat-messages";
import { mapLoadedSessionMessage, type LoadedSessionMessage } from "./session-message-map";
import { assistantVisibleBodyForUi } from "./assistant-output";
import {
  canonicalizeUserReferenceMentions,
  stableAttachmentSetIdentity,
} from "./reference-attachment";
import { FEEDBACK_MESSAGE_ID_METADATA_KEY } from "./feedback-message-id";

const norm = (s: unknown) => String(s ?? "").trim();
const contentKey = (role: string, content: unknown) => `${role}::${norm(content)}`;
const reconciliationContentKey = (message: Message) =>
  message.role === "user"
    ? `user::${canonicalizeUserReferenceMentions(
        String(message.content ?? ""),
        message.attachments,
      ).trim()}`
    : contentKey(message.role, message.content);
const userRowsMatch = (memory: Message, disk: Message) => {
  if (reconciliationContentKey(memory) !== reconciliationContentKey(disk)) {
    return false;
  }
  const memoryAttachments = stableAttachmentSetIdentity(memory.attachments);
  const diskAttachments = stableAttachmentSetIdentity(disk.attachments);
  if (!memoryAttachments.key || !diskAttachments.key) return true;
  if (!memoryAttachments.strong || !diskAttachments.strong) return false;
  return memoryAttachments.key === diskAttachments.key;
};
const clientTurnId = (message: Message) =>
  String(message.metadata?.client_turn_id ?? "").trim();
const groupMessageIdOf = (message: Message) =>
  String(message.groupMessageId ?? "").trim();
const isGroupFeedMessage = (message: Message) =>
  Boolean(
    groupMessageIdOf(message) ||
      String(message.metadata?.group_publication_source ?? "").trim(),
  );

/**
 * Compare canonical visible bodies so live streamed rows (with think/followups
 * tags) reconcile with disk rows that already store the sanitized final body.
 */
const assistantBodyKey = (content: unknown) =>
  assistantVisibleBodyForUi(String(content ?? "")).trim();

const toolCallIdOf = (message: Message) => String(message.toolCallId ?? "").trim();

/**
 * Associate every timeline row with the nearest preceding user request.
 * Assistant rows do not currently carry `client_turn_id` themselves, so this
 * is the durable context needed to reconcile two identical answers from
 * different turns without choosing one by text alone.
 */
function clientTurnIdByTimelineRow(messages: Message[]): Map<Message, string> {
  const result = new Map<Message, string>();
  let current = "";
  for (const message of messages) {
    if (message.role === "user") current = clientTurnId(message);
    result.set(message, current);
  }
  return result;
}

/**
 * Group-workflow narration is intentionally UI-only: it explains who is being
 * assigned/reviewed without polluting the agents' durable conversation context.
 * These rows therefore have no disk counterpart, but their live position among
 * persisted member replies is still authoritative.
 */
const isTransientTimelineRow = (message: Message) =>
  String(message.metadata?.kind ?? "").trim() === "group_workflow_event";

const TERMINAL_TOOL_STATUSES = new Set<NonNullable<Message["toolStatus"]>>([
  "done",
  "error",
  "cancelled",
]);

/**
 * Disk terminal status wins over a stale live `running`/`pending` card.
 * Live streams often keep args-only rows as running after the server already
 * persisted the result; preferring memory here left orphan "正在调用" rows.
 */
function resolveMergedToolStatus(
  diskStatus: Message["toolStatus"],
  memoryStatus: Message["toolStatus"],
): Message["toolStatus"] {
  if (diskStatus && TERMINAL_TOOL_STATUSES.has(diskStatus)) return diskStatus;
  if (memoryStatus && TERMINAL_TOOL_STATUSES.has(memoryStatus)) return memoryStatus;
  return memoryStatus ?? diskStatus;
}

function overlayMemoryEnrichment(diskRow: Message, memory: Message): Message {
  const metadata = {
    ...(diskRow.metadata ?? {}),
    ...(memory.metadata ?? {}),
  };
  // The persisted row's positional address is authoritative.  Live rows use
  // uid() ids and usually have no feedback address yet; allowing their
  // metadata to overwrite this value would make an immediate post-merge vote
  // target the wrong row after a session switch.
  const diskFeedbackId = String(
    diskRow.metadata?.[FEEDBACK_MESSAGE_ID_METADATA_KEY] ?? "",
  ).trim();
  if (diskFeedbackId) metadata[FEEDBACK_MESSAGE_ID_METADATA_KEY] = diskFeedbackId;
  return {
    ...diskRow,
    id: memory.id,
    timestamp:
      typeof diskRow.timestamp === "number" && diskRow.timestamp > 0
        ? diskRow.timestamp
        : memory.timestamp,
    attachments: memory.attachments ?? diskRow.attachments,
    toolStreamLines: memory.toolStreamLines ?? diskRow.toolStreamLines,
    suggestedQuestions: memory.suggestedQuestions ?? diskRow.suggestedQuestions,
    references: memory.references ?? diskRow.references,
    searchedQueries: memory.searchedQueries ?? diskRow.searchedQueries,
    reasoning: memory.reasoning ?? diskRow.reasoning,
    reasoningSeconds: memory.reasoningSeconds ?? diskRow.reasoningSeconds,
    toolStatus: resolveMergedToolStatus(diskRow.toolStatus, memory.toolStatus),
    toolElapsedSec: memory.toolElapsedSec ?? diskRow.toolElapsedSec,
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    groupMessageId: memory.groupMessageId ?? diskRow.groupMessageId,
    // Persisted reaction aggregates are authoritative after reconnect; keep
    // the optimistic live value only while disk has not written one yet.
    reactions: diskRow.reactions ?? memory.reactions,
  };
}

/**
 * Reconcile in-memory rows (uid ids, streaming enrichments) with disk history.
 * Output follows disk chronological order; unmatched in-memory tail rows append last.
 */
export function mergeSessionMessagesTail(
  existing: Message[],
  diskRows: LoadedSessionMessage[],
  sessionId: string
): Message[] {
  if (!diskRows.length) return existing;
  // A reconnect can replay the same persisted group publication more than
  // once. Stable group ids make de-duplication safe without collapsing two
  // ordinary same-text turns.
  const mapped: Message[] = [];
  const seenGroupMessageIds = new Set<string>();
  diskRows.forEach((row, idx) => {
    const mappedRow = mapLoadedSessionMessage(row, sessionId, idx);
    const groupMessageId = groupMessageIdOf(mappedRow);
    if (groupMessageId) {
      if (seenGroupMessageIds.has(groupMessageId)) return;
      seenGroupMessageIds.add(groupMessageId);
    }
    mapped.push(mappedRow);
  });
  if (!existing.length) return mapped;

  const memoryById = new Map(existing.map((m) => [m.id, m]));
  const consumedMemory = new Set<Message>();
  const memoryTurnIds = clientTurnIdByTimelineRow(existing);
  const diskTurnIds = clientTurnIdByTimelineRow(mapped);

  const findMemoryMatch = (diskRow: Message): Message | null => {
    const diskClientTurnId =
      diskRow.role === "user" ? clientTurnId(diskRow) : "";
    if (diskClientTurnId) {
      const byClientTurn = existing.find(
        (memory) =>
          !consumedMemory.has(memory) &&
          memory.role === "user" &&
          clientTurnId(memory) === diskClientTurnId,
      );
      if (byClientTurn) {
        consumedMemory.add(byClientTurn);
        return byClientTurn;
      }
    }
    // Live tool cards keep JSON args as content while disk stores the result
    // body — content equality never hits. Align on toolCallId first.
    const diskToolCallId = diskRow.role === "tool" ? toolCallIdOf(diskRow) : "";
    if (diskToolCallId) {
      const byToolCallId = existing.find(
        (memory) =>
          !consumedMemory.has(memory) &&
          memory.role === "tool" &&
          toolCallIdOf(memory) === diskToolCallId,
      );
      if (byToolCallId) {
        consumedMemory.add(byToolCallId);
        return byToolCallId;
      }
    }
    const diskGroupMessageId = groupMessageIdOf(diskRow);
    if (diskGroupMessageId) {
      const byGroupMessageId = existing.find(
        (memory) =>
          !consumedMemory.has(memory) &&
          groupMessageIdOf(memory) === diskGroupMessageId,
      );
      if (byGroupMessageId) {
        consumedMemory.add(byGroupMessageId);
        return byGroupMessageId;
      }
      // A stable group id is authoritative. Never fall back to same-text
      // matching when a live row belongs to another publication.
      return null;
    }
    if (!diskClientTurnId) {
      const byId = memoryById.get(diskRow.id);
      if (byId && !consumedMemory.has(byId)) {
        consumedMemory.add(byId);
        return byId;
      }
    }
    const diskBody =
      diskRow.role === "assistant" ? assistantBodyKey(diskRow.content) : "";
    const diskAssistantTurnId =
      diskRow.role === "assistant" ? diskTurnIds.get(diskRow) ?? "" : "";
    const assistantCandidates =
      diskRow.role === "assistant" && diskAssistantTurnId
        ? existing.filter(
            (memory) =>
              !consumedMemory.has(memory) &&
              memory.role === "assistant" &&
              memoryTurnIds.get(memory) === diskAssistantTurnId,
          )
        : [];
    // A user turn id is authoritative.  If it is present on the persisted
    // row, never fall back to an assistant from another turn merely because
    // its visible body happens to be identical.
    const candidates =
      diskRow.role === "assistant" && diskAssistantTurnId
        ? assistantCandidates
        : existing;
    const matchingMemoryRows: Message[] = [];
    for (const memory of candidates) {
      if (consumedMemory.has(memory)) continue;
      if (memory.role !== diskRow.role) continue;
      const memoryClientTurnId =
        memory.role === "user" ? clientTurnId(memory) : "";
      if (
        diskClientTurnId &&
        memoryClientTurnId &&
        memoryClientTurnId !== diskClientTurnId
      ) {
        continue;
      }
      const exactMatch =
        norm(diskRow.content).length > 0 &&
        (diskRow.role === "user"
          ? userRowsMatch(memory, diskRow)
          : reconciliationContentKey(memory) === reconciliationContentKey(diskRow));
      const bodyMatch =
        diskRow.role === "assistant" &&
        diskBody.length > 0 &&
        assistantBodyKey(memory.content) === diskBody &&
        // Two group members may intentionally publish the same sentence. If
        // one side is marked as a group feed row, require the same author
        // identity before considering a text-only reconciliation.
        (!isGroupFeedMessage(memory) && !isGroupFeedMessage(diskRow)
          ? true
          : isGroupFeedMessage(memory) &&
            isGroupFeedMessage(diskRow) &&
            String(memory.agentId ?? "").trim() === String(diskRow.agentId ?? "").trim());
      if (!exactMatch && !bodyMatch) continue;
      matchingMemoryRows.push(memory);
    }
    // Text-only reconciliation is safe only when there is one possible live
    // row.  An ambiguous legacy history remains disk-backed and gets no
    // guessed live uid; this preserves the correct durable feedback address.
    if (matchingMemoryRows.length !== 1) return null;
    const [memory] = matchingMemoryRows;
    consumedMemory.add(memory);
    return memory;
  };

  const out: Message[] = [];
  const outputRowByMemory = new Map<Message, Message>();
  const placedAssistantBodies = new Set<string>();
  const placedToolCallIds = new Set<string>();
  for (const diskRow of mapped) {
    const memory = findMemoryMatch(diskRow);
    const row = memory ? overlayMemoryEnrichment(diskRow, memory) : diskRow;
    out.push(row);
    if (memory) outputRowByMemory.set(memory, row);
    if (row.role === "assistant") {
      const body = assistantBodyKey(row.content);
      if (body) placedAssistantBodies.add(body);
    }
    if (row.role === "tool") {
      const callId = toolCallIdOf(row);
      if (callId) placedToolCallIds.add(callId);
    }
  }

  const transientTimelineRows: Message[] = [];

  // Append in-memory rows that disk hasn't persisted yet (缺失自愈), but never
  // re-append an assistant row whose body already appears above — those are the
  // accumulated duplicate "思考了 N 秒" copies left by earlier failed merges.
  // Also never re-append a live tool card whose toolCallId already landed from
  // disk (stale running args-only rows used to appear after the final answer).
  //
  // UI-only group workflow rows are handled separately below. Appending those
  // as a tail made a correctly streamed timeline flip into "final answer first,
  // assignment/decomposition afterwards" every time disk reconciliation ran.
  for (const memory of existing) {
    if (consumedMemory.has(memory)) continue;
    if (isOrphanFormattedToolResultMessage(memory)) continue;
    if (isEphemeralConfirmReceiptMessage(memory)) continue;
    if (memory.role === "assistant") {
      const body = assistantBodyKey(memory.content);
      if (body && placedAssistantBodies.has(body)) continue;
      if (body) placedAssistantBodies.add(body);
    }
    if (memory.role === "tool") {
      const callId = toolCallIdOf(memory);
      if (callId && placedToolCallIds.has(callId)) continue;
    }
    if (isTransientTimelineRow(memory)) {
      transientTimelineRows.push(memory);
      continue;
    }
    out.push(memory);
    outputRowByMemory.set(memory, memory);
  }

  // Reinsert each transient row immediately before the next durable row that
  // followed it in the live array. This preserves causal SSE order without
  // weakening the general rule that disk chronology is authoritative. When a
  // transient row has no later durable anchor it genuinely belongs at the tail.
  for (const transient of transientTimelineRows) {
    const memoryIndex = existing.indexOf(transient);
    let nextOutput: Message | undefined;
    for (let idx = memoryIndex + 1; idx < existing.length; idx += 1) {
      const candidate = outputRowByMemory.get(existing[idx]);
      if (candidate) {
        nextOutput = candidate;
        break;
      }
    }
    if (!nextOutput) {
      out.push(transient);
      continue;
    }
    const insertAt = out.indexOf(nextOutput);
    if (insertAt < 0) out.push(transient);
    else out.splice(insertAt, 0, transient);
  }

  return out;
}
