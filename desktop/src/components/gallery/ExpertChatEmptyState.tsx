import type { Avatar } from "../../store";
import { GroupMemberAvatar } from "../groups/GroupMemberAvatar";

type Props = {
  avatar: Pick<Avatar, "id" | "name" | "role" | "avatarUrl" | "color" | "description">;
};

/** Identify the selected expert before the first one-to-one message. */
export function ExpertChatEmptyState({ avatar }: Props) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 px-4 text-center">
      <GroupMemberAvatar
        avatar={avatar}
        size="xl"
        className="ring-1 ring-border shadow-[0_14px_36px_rgba(var(--theme-color-rgb,59,130,246),0.18)]"
      />
      <div className="max-w-md space-y-1.5 select-none">
        <h3 className="text-xl font-semibold tracking-tight text-text-strong">{avatar.name}</h3>
        {avatar.role ? <p className="text-xs font-medium text-text-muted">{avatar.role}</p> : null}
        {avatar.description ? (
          <p className="pt-1 text-xs leading-relaxed text-text-faint">{avatar.description}</p>
        ) : null}
      </div>
      <p className="text-xs text-text-faint">向 {avatar.name} 发消息，开始一对一对话。</p>
    </div>
  );
}
