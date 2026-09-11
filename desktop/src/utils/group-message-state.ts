import type { GroupReaction, Message } from "../store";

/** Reactions offered by the group-chat public voice layer. */
export const GROUP_REACTION_EMOJIS = ["👍", "😂", "❤️", "🎉", "👀", "🤔"] as const;

const text = (value: unknown) => String(value ?? "").trim();

/**
 * Stable group ids are also attached to the optimistic human row.  Keep the
 * reaction affordance limited to public feed rows so a private workflow detail
 * can never become reactable if it is accidentally present in memory.
 */
export function isPublicGroupMessage(
  message: Pick<Message, "groupMessageId" | "metadata"> &
    Partial<Pick<Message, "role">>,
): boolean {
  if (!text(message.groupMessageId)) return false;
  if (message.role && message.role !== "user" && message.role !== "assistant") return false;
  const metadata = message.metadata;
  if (!metadata || typeof metadata !== "object") return false;
  const falseFlag = (value: unknown) =>
    value === false || text(value).toLowerCase() === "false";
  if (
    falseFlag(metadata.is_public) ||
    falseFlag(metadata.public) ||
    metadata.is_private === true ||
    metadata.private === true ||
    metadata.skipped === true
  ) {
    return false;
  }
  const privateScopes = new Set(["panel", "private", "direct", "dm", "one_to_one"]);
  for (const key of [
    "feed_visibility",
    "visibility",
    "scope",
    "conversation_scope",
    "chat_scope",
  ]) {
    if (privateScopes.has(text(metadata[key]).toLowerCase())) return false;
  }
  const eventType = text(metadata.event_type).toLowerCase();
  if (
    [
      "group_workflow_detail",
      "group_progress",
      "group_token",
      "group_pass",
      "group_skipped",
      "group_action_complete",
    ].includes(eventType)
  ) {
    return false;
  }
  const publicationSource = text(
    metadata.publication_source ?? metadata.group_publication_source,
  ).toLowerCase();
  if (publicationSource === "workflow_private") return false;
  const trueFlag = (value: unknown) =>
    value === true || text(value).toLowerCase() === "true";
  const explicitPublic =
    trueFlag(metadata.is_public) ||
    trueFlag(metadata.public) ||
    ["feed", "public", "group", "group_feed", "room"].some((scope) =>
      [
        metadata.feed_visibility,
        metadata.visibility,
        metadata.scope,
        metadata.conversation_scope,
        metadata.chat_scope,
      ].some((value) => text(value).toLowerCase() === scope),
    );
  return explicitPublic;
}

export type GroupReactionEvent = {
  message_id?: unknown;
  group_message_id?: unknown;
  emoji?: unknown;
  active?: unknown;
  actor_id?: unknown;
  actor_ids?: unknown;
  reactions?: unknown;
};

/**
 * Normalize backend reaction aggregates into the desktop's camel-case shape.
 * Unknown emojis/actors are ignored so malformed event data cannot break the
 * message renderer or create an unbounded list of pills.
 */
export function normalizeGroupReactions(
  raw: unknown,
  activeActorId?: string,
): GroupReaction[] {
  if (!Array.isArray(raw)) return [];
  const out: GroupReaction[] = [];
  const seen = new Set<string>();
  for (const value of raw) {
    if (!value || typeof value !== "object") continue;
    const row = value as Record<string, unknown>;
    const emoji = text(row.emoji);
    if (!GROUP_REACTION_EMOJIS.includes(emoji as (typeof GROUP_REACTION_EMOJIS)[number])) {
      continue;
    }
    const actorsRaw = row.actor_ids ?? row.actorIds;
    const actors = Array.isArray(actorsRaw)
      ? Array.from(new Set(actorsRaw.map(text).filter(Boolean))).slice(0, 100)
      : [];
    if (seen.has(emoji)) {
      const existing = out.find((item) => item.emoji === emoji);
      if (existing) {
        existing.actorIds = Array.from(new Set([...existing.actorIds, ...actors])).slice(0, 100);
        if (activeActorId && existing.actorIds.includes(activeActorId)) existing.active = true;
      }
      continue;
    }
    seen.add(emoji);
    out.push({
      emoji,
      actorIds: actors,
      ...(activeActorId ? { active: actors.includes(activeActorId) } : {}),
    });
  }
  return out;
}

/** Resolve the stable id carried by a live or persisted group message row. */
export function groupMessageIdFromRecord(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const row = raw as Record<string, unknown>;
  const metadata = row.metadata && typeof row.metadata === "object"
    ? row.metadata as Record<string, unknown>
    : undefined;
  const direct = text(
    row.group_message_id ??
      row.message_id ??
      metadata?.group_message_id ??
      metadata?.message_id,
  );
  if (direct) return direct;
  const rowId = text(row.id);
  // New group context ids use the gmsg_ namespace. Do not promote arbitrary
  // session/message ids into group ids: one-to-one rows may have the same shape.
  if (rowId.startsWith("gmsg_")) return rowId;
  if (text(metadata?.group_publication_source) && rowId) return rowId;
  return undefined;
}

/** Apply one authoritative reaction event to a message's aggregate. */
export function applyGroupReactionEvent(
  message: Message,
  event: GroupReactionEvent,
  activeActorId?: string,
): Message {
  const reactions = Array.isArray(event.reactions)
    ? normalizeGroupReactions(event.reactions, activeActorId)
    : (() => {
        const actor = text(event.actor_id) || activeActorId;
        const prior = message.reactions?.find((item) => item.emoji === text(event.emoji));
        const actorIsCurrent = !activeActorId || !text(event.actor_id) || actor === activeActorId;
        const next = toggleGroupReaction(
          message.reactions ?? [],
          text(event.emoji),
          Boolean(event.active),
          actor,
        );
        // A reaction event emitted by another member changes the count but
        // must not make the pill look active for the current desktop user.
        if (!actorIsCurrent) {
          const current = next.find((item) => item.emoji === text(event.emoji));
          if (current) {
            if (prior?.active) current.active = true;
            else delete current.active;
          }
        }
        return next;
      })();
  return { ...message, reactions: reactions.length > 0 ? reactions : undefined };
}

/** Local fallback used for an event that carries only emoji/active state. */
export function toggleGroupReaction(
  current: GroupReaction[],
  emoji: string,
  active: boolean,
  actorId?: string,
): GroupReaction[] {
  if (!GROUP_REACTION_EMOJIS.includes(emoji as (typeof GROUP_REACTION_EMOJIS)[number])) {
    return normalizeGroupReactions(current);
  }
  const next = normalizeGroupReactions(current);
  // ``normalizeGroupReactions`` only marks an active actor when it is given an
  // actor id.  Keep the per-user active state already present on the bubble;
  // toggling one emoji must not make the user's other reactions look inactive.
  const previouslyActive = new Set(
    current.filter((item) => item.active === true).map((item) => item.emoji),
  );
  for (const item of next) {
    if (previouslyActive.has(item.emoji)) item.active = true;
  }
  const index = next.findIndex((item) => item.emoji === emoji);
  const actor = text(actorId);
  if (index < 0) {
    if (!active) return next;
    next.push({ emoji, actorIds: actor ? [actor] : [], ...(actor ? { active: true } : {}) });
    return next;
  }
  const target = next[index];
  if (actor) {
    target.actorIds = active
      ? Array.from(new Set([...target.actorIds, actor])).slice(0, 100)
      : target.actorIds.filter((id) => id !== actor);
  }
  if (active) target.active = true;
  else delete target.active;
  if (target.actorIds.length === 0 && !active) next.splice(index, 1);
  return next;
}

export function applyGroupReactionToMessages(
  messages: Message[],
  groupMessageId: string,
  event: GroupReactionEvent,
  activeActorId?: string,
): Message[] {
  const target = text(groupMessageId);
  if (!target) return messages;
  let changed = false;
  const next = messages.map((message) => {
    if (message.groupMessageId !== target) return message;
    const updated = applyGroupReactionEvent(message, event, activeActorId);
    if (updated.reactions !== message.reactions) changed = true;
    return updated;
  });
  return changed ? next : messages;
}
