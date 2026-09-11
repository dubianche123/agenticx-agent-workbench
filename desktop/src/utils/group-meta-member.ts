import { META_AGENT_DISPLAY_NAME } from "../constants/branding";
import { DEFAULT_META_AVATAR_URL } from "../constants/meta-avatar";
import type { Avatar } from "../store";

export const GROUP_META_MEMBER_ID = "__meta__";

/** The product Meta-Agent participates in a group as one visible member. */
export function createGroupMetaMember(avatarUrl = ""): Avatar {
  return {
    id: GROUP_META_MEMBER_ID,
    name: META_AGENT_DISPLAY_NAME,
    role: "群聊主持与协作统筹",
    description: "理解问题，并把需要专业补充的部分交给最合适的群成员",
    avatarUrl: avatarUrl.trim() || DEFAULT_META_AVATAR_URL,
    pinned: false,
    createdBy: "system_meta",
    color: "blue",
  };
}

export function groupMemberCandidates(
  avatars: Avatar[],
  metaAvatarUrl = "",
): Avatar[] {
  const regular = avatars.filter((avatar) => avatar.id !== GROUP_META_MEMBER_ID);
  // Meta remains available as an explicit add candidate. Callers derive the
  // actual member list from the persisted group avatarIds; this candidate list
  // must never be treated as implicit group membership.
  return [createGroupMetaMember(metaAvatarUrl), ...regular];
}

export function resolveGroupMember(
  avatarId: string,
  avatars: Avatar[],
  metaAvatarUrl = "",
): Avatar | undefined {
  if (avatarId === GROUP_META_MEMBER_ID) return createGroupMetaMember(metaAvatarUrl);
  return avatars.find((avatar) => avatar.id === avatarId);
}
