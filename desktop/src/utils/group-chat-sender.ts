import { META_AGENT_DISPLAY_NAME } from "../constants/branding";
import type { Avatar, Message } from "../store";
import { isMetaLeaderIdentity, resolveMetaDisplayName } from "./display-name";

export type GroupChatSender = {
  name: string;
  url?: string;
  avatarId?: string;
};

/**
 * Resolve a group message's persisted sender without replacing historical
 * identities with the group's current host. The active member registry is
 * authoritative only when it contains the message's agent id; otherwise the
 * message's own display fields remain the source of truth.
 */
export function resolveGroupChatSender(
  message: Pick<Message, "role" | "avatarName" | "avatarUrl" | "agentId">,
  opts: {
    groupMembers: Avatar[];
    host?: Avatar;
    userLabel: string;
    userAvatarUrl: string;
  },
): GroupChatSender {
  if (message.role === "user") {
    return {
      name: opts.userLabel.trim() || "用户",
      url: opts.userAvatarUrl.trim() || undefined,
    };
  }

  const agentId = String(message.agentId ?? "").trim();
  const rawName = String(message.avatarName ?? "").trim();
  const member = agentId ? opts.groupMembers.find((avatar) => avatar.id === agentId) : undefined;
  if (member) {
    const url = String(message.avatarUrl ?? "").trim() || undefined;
    return {
      name: member.name || rawName || agentId,
      url: url || member.avatarUrl || undefined,
      avatarId: member.id,
    };
  }

  if (isMetaLeaderIdentity(agentId, rawName)) {
    // A historical Meta row can outlive the current group's membership. Do
    // not infer the current host from it: that changes who appears to have
    // authored the old message. Normalize only known legacy product labels.
    const historicalName =
      rawName && rawName !== "分身" ? resolveMetaDisplayName(rawName) : META_AGENT_DISPLAY_NAME;
    return {
      name: historicalName,
      url: String(message.avatarUrl ?? "").trim() || undefined,
    };
  }

  const url = String(message.avatarUrl ?? "").trim() || undefined;
  const name = rawName && rawName !== "分身" ? rawName : agentId || resolveMetaDisplayName(null);
  return { name, url, avatarId: agentId || undefined };
}

/**
 * MessageRenderer historically infers every `meta` row as the current Meta
 * leader. Mark a historical Meta row that is no longer an active member with
 * a render-only id so that the renderer keeps the message's own name/avatar.
 * ChatPane restores the original object before invoking message actions.
 */
export const HISTORICAL_GROUP_META_RENDER_ID = "__historical_group_meta__";

export function messageForGroupRenderer(
  message: Message,
  sender: GroupChatSender,
): Message {
  if (
    message.role === "assistant" &&
    !sender.avatarId &&
    isMetaLeaderIdentity(message.agentId, message.avatarName)
  ) {
    return { ...message, agentId: HISTORICAL_GROUP_META_RENDER_ID };
  }
  return message;
}
