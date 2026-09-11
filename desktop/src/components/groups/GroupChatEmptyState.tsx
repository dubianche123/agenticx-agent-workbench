import type { Avatar, GroupChat } from "../../store";
import { GROUP_META_MEMBER_ID } from "../../utils/group-meta-member";
import { GroupIdentityIcon, GroupMemberAvatar } from "./GroupMemberAvatar";

type Props = {
  group: GroupChat;
  members: Avatar[];
  onOpenMember?: (avatarId: string) => void;
};

/** Identify a fresh group conversation before its first message. */
export function GroupChatEmptyState({ group, members, onOpenMember }: Props) {
  const visibleMembers = members.slice(0, 4);
  const remaining = Math.max(0, group.avatarIds.length - visibleMembers.length);
  const host = members.find((member) => member.id === group.hostAvatarId);

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 px-4 text-center">
      <GroupIdentityIcon
        identity={group.portableArtifactId || group.id}
        avatarUrl={group.avatarUrl}
        size="lg"
        iconBg="rgb(var(--theme-color-rgb, 59, 130, 246))"
        className="shadow-[0_12px_30px_rgba(var(--theme-color-rgb,59,130,246),0.2)]"
      />
      <div className="space-y-1.5 select-none">
        <h3 className="text-xl font-semibold tracking-tight text-text-strong">{group.name}</h3>
        <p className="text-xs text-text-muted">
          {group.avatarIds.length} 位成员 · 主持人：{host?.name || "首位成员"}
        </p>
      </div>
      {visibleMembers.length > 0 ? (
        <div className="flex items-center gap-2" aria-label={`${group.avatarIds.length} 位群成员`}>
          {visibleMembers.map((member) => (
            onOpenMember && member.id !== GROUP_META_MEMBER_ID ? (
              <button
                key={member.id}
                type="button"
                className="rounded-lg transition hover:ring-2 hover:ring-[rgba(var(--theme-color-rgb,59,130,246),0.45)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(var(--theme-color-rgb,59,130,246),0.55)]"
                aria-label={`打开${member.name}专家详情`}
                title={`打开${member.name}专家详情`}
                onClick={() => onOpenMember(member.id)}
              >
                <GroupMemberAvatar
                  avatar={member}
                  size="sm"
                  className="ring-1 ring-border"
                />
              </button>
            ) : (
              <GroupMemberAvatar
                key={member.id}
                avatar={member}
                size="sm"
                className="ring-1 ring-border"
              />
            )
          ))}
          {remaining > 0 ? (
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-surface-panel text-[10px] font-medium text-text-subtle ring-1 ring-border">
              +{remaining}
            </span>
          ) : null}
        </div>
      ) : null}
      <p className="text-xs text-text-faint">
        直接发消息由主持人先回应；成员可通过 @ 自然接力，你也可以直接 @指定成员。
      </p>
    </div>
  );
}
