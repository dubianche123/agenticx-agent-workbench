import { Trash2 } from "lucide-react";
import type { Avatar } from "../../store";
import { avatarBgClass, avatarFgClass } from "../../utils/avatar-color";
import { isMetaLeaderAgentId } from "../../utils/display-name";
import {
  crewPhaseLabel,
  type CrewSlot,
} from "../../utils/group-member-activity";
import { Shimmer } from "../ds/Shimmer";
import { formatDuration } from "../graph/span-derive";
import { memberInitials } from "./member-avatar";

type Props = {
  slots: CrewSlot[];
  avatarById: Map<string, Avatar>;
  metaLeaderLabel: string;
  onAppendDirective?: (agentId: string) => void;
  onOpenMember?: (agentId: string) => void;
  onSwitchModel?: (agentId: string) => void;
  onInterrupt?: (agentId: string) => void;
  onRemoveMember?: (agentId: string) => void;
  removeDisabled?: boolean;
};

function phaseDotClass(phase: CrewSlot["phase"]): string {
  if (phase === "running") return "bg-[var(--status-warning)] agx-dot-pulse";
  if (phase === "waiting") return "bg-[var(--status-warning)]";
  if (phase === "failed") return "bg-[var(--status-danger)]";
  if (phase === "replied") return "bg-[var(--status-success)]";
  return "border border-current bg-transparent text-text-faint";
}

function cardClass(phase: CrewSlot["phase"]): string {
  const base = "flex items-center gap-2 rounded-lg px-2 py-1.5";
  if (phase === "idle") return `${base} bg-transparent`;
  if (phase === "running") {
    return `${base} bg-surface-card ring-1 ring-[var(--status-warning)]/30`;
  }
  return `${base} bg-surface-card`;
}

function ActionRow({
  slot,
  onAppendDirective,
  onSwitchModel,
  onInterrupt,
}: {
  slot: CrewSlot;
  onAppendDirective?: (agentId: string) => void;
  onSwitchModel?: (agentId: string) => void;
  onInterrupt?: (agentId: string) => void;
}) {
  if (slot.phase === "running") {
    const text = slot.actionText || crewPhaseLabel(slot);
    return (
      <div className="flex min-w-0 items-baseline gap-1.5">
        <Shimmer variant="status" text={text} className="min-w-0 truncate text-[10px]" />
        {slot.elapsedMs > 0 ? (
          <span className="shrink-0 text-[10px] text-text-faint">{formatDuration(slot.elapsedMs)}</span>
        ) : null}
      </div>
    );
  }

  if (slot.phase === "waiting" || slot.phase === "failed") {
    const tone =
      slot.phase === "failed" ? "text-[var(--status-danger)]" : "text-[var(--status-warning)]";
    const showActions = Boolean(onAppendDirective || onSwitchModel || onInterrupt);
    return (
      <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
        <span className={`truncate text-[10px] ${tone}`}>
          {slot.actionText || crewPhaseLabel(slot)}
        </span>
        {showActions ? (
          <span className="flex shrink-0 items-center gap-1">
            {onAppendDirective ? (
              <button
                type="button"
                className="text-[10px] text-text-subtle transition hover:text-text-strong"
                onClick={() => onAppendDirective(slot.agentId)}
              >
                追加指令
              </button>
            ) : null}
            {onSwitchModel ? (
              <button
                type="button"
                className="text-[10px] text-text-subtle transition hover:text-text-strong"
                onClick={() => onSwitchModel(slot.agentId)}
              >
                换模型
              </button>
            ) : null}
            {onInterrupt ? (
              <button
                type="button"
                className="text-[10px] text-text-subtle transition hover:text-text-strong"
                onClick={() => onInterrupt(slot.agentId)}
              >
                打断
              </button>
            ) : null}
          </span>
        ) : null}
      </div>
    );
  }

  return (
    <span className="truncate text-[10px] text-text-faint">{crewPhaseLabel(slot)}</span>
  );
}

export function CrewWorkstationWall({
  slots,
  avatarById,
  metaLeaderLabel,
  onAppendDirective,
  onOpenMember,
  onSwitchModel,
  onInterrupt,
  onRemoveMember,
  removeDisabled = false,
}: Props) {
  return (
    <div className="space-y-1.5">
      {slots.map((slot) => {
        const isMeta = isMetaLeaderAgentId(slot.agentId);
        const avatar = avatarById.get(slot.agentId);
        const label = isMeta
          ? avatar?.name || metaLeaderLabel
          : avatar?.name || slot.agentId.slice(0, 8);
        const canOpenMember = Boolean(onOpenMember && !isMeta && avatar);
        const openMember = () => onOpenMember?.(slot.agentId);
        const avatarVisual = avatar?.avatarUrl && !isMeta ? (
          <img src={avatar.avatarUrl} alt="" className="h-8 w-8 rounded-xl object-cover" />
        ) : (
          <div
            className={`flex h-8 w-8 items-center justify-center rounded-xl text-[10px] font-bold ${avatarBgClass(
              avatar?.color,
            )} ${avatarFgClass(avatar?.color)}`}
          >
            {memberInitials(label)}
          </div>
        );
        return (
          <div key={slot.agentId} className={cardClass(slot.phase)}>
            {canOpenMember ? (
              <button
                type="button"
                className="relative h-8 w-8 shrink-0 rounded-xl outline-none transition hover:ring-2 hover:ring-[rgba(var(--theme-color-rgb,59,130,246),0.45)] focus-visible:ring-2 focus-visible:ring-[rgba(var(--theme-color-rgb,59,130,246),0.55)]"
                aria-label={`打开${label}专家详情`}
                title={`打开${label}专家详情`}
                onClick={openMember}
              >
                {avatarVisual}
                <span
                  className={`absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full ${phaseDotClass(slot.phase)}`}
                  title={crewPhaseLabel(slot)}
                />
              </button>
            ) : (
              <div className="relative h-8 w-8 shrink-0">
                {avatarVisual}
                <span
                  className={`absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full ${phaseDotClass(slot.phase)}`}
                  title={crewPhaseLabel(slot)}
                />
              </div>
            )}
            <div className="min-w-0 flex-1">
              {canOpenMember ? (
                <button
                  type="button"
                  className="block max-w-full truncate rounded px-0.5 text-left text-[12px] text-text-primary outline-none transition hover:text-text-strong hover:underline focus-visible:ring-2 focus-visible:ring-[rgba(var(--theme-color-rgb,59,130,246),0.45)]"
                  aria-label={`打开${label}专家详情`}
                  title={`打开${label}专家详情`}
                  onClick={openMember}
                >
                  {label}
                </button>
              ) : (
                <div className="truncate text-[12px] text-text-primary">{label}</div>
              )}
              <ActionRow
                slot={slot}
                onAppendDirective={isMeta ? undefined : onAppendDirective}
                onSwitchModel={isMeta ? undefined : onSwitchModel}
                onInterrupt={onInterrupt}
              />
            </div>
            {slot.toolCalls > 0 ? (
              <span className="shrink-0 text-[10px] text-text-faint">{slot.toolCalls} 次调用</span>
            ) : null}
            {onRemoveMember ? (
              <button
                type="button"
                disabled={removeDisabled}
                className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[10px] text-text-faint transition hover:bg-rose-500/10 hover:text-rose-400 disabled:cursor-not-allowed disabled:opacity-35"
                aria-label={`移出成员 ${label}`}
                title={removeDisabled ? "群聊至少需要保留 1 位成员" : `移出 ${label}`}
                onClick={(event) => {
                  event.stopPropagation();
                  onRemoveMember(slot.agentId);
                }}
              >
                <Trash2 className="h-3 w-3" strokeWidth={1.8} aria-hidden />
                移出
              </button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
