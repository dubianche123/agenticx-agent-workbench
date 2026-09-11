import { useEffect, useMemo, useState } from "react";
import { Plus, Search, UsersRound, X } from "lucide-react";
import { useAppStore, type Avatar, type Message } from "../../store";
import {
  resolveCrewSlots,
  resolveGroupHostAvatarId,
} from "../../utils/group-member-activity";
import { GROUP_META_MEMBER_ID, groupMemberCandidates } from "../../utils/group-meta-member";
import {
  EMPTY_PANE_GRAPH_STATE,
  selectGraphStateForOwner,
} from "../graph/graph-types";
import { deriveRunningToolByAgent } from "../graph/span-derive";
import { useGraphRunStore } from "../graph/useGraphRun";
import { GroupMemberAvatar } from "../groups/GroupMemberAvatar";
import { CrewWorkstationWall } from "./CrewWorkstationWall";

/**
 * Group workbench member surface.
 *
 * Each visible member owns one row that answers both「谁在执行什么」and
 * 「群里有哪些人」. Removing a member is a direct action on that row; there
 * is no second management list or selection mode.
 */
export function GroupMembersSummaryList({
  groupId,
  paneId,
  sessionId,
  activeGraphRunId = null,
  avatarList,
  messages = [],
  activeAgentIds = [],
  activityHintById = {},
  phaseOverrideById = {},
  onAppendDirective,
  onOpenMember,
  onSwitchModel,
  onInterrupt,
}: {
  groupId: string;
  paneId: string;
  /** Session scope that owns the WorkPanel instance. */
  sessionId: string;
  /** Optional run selection used to reject stale same-session graph rows. */
  activeGraphRunId?: string | null;
  avatarList: Avatar[];
  messages?: Array<Pick<Message, "role" | "agentId" | "toolName" | "timestamp">>;
  activeAgentIds?: string[];
  activityHintById?: Record<string, string>;
  phaseOverrideById?: Record<string, "waiting" | "failed">;
  onAppendDirective?: (agentId: string) => void;
  onOpenMember?: (agentId: string) => void;
  onSwitchModel?: (agentId: string) => void;
  onInterrupt?: (agentId: string) => void;
}) {
  const groups = useAppStore((s) => s.groups);
  const setGroups = useAppStore((s) => s.setGroups);
  const metaAvatarUrl = useAppStore((s) => s.metaAvatarUrl);
  const group = groups.find((item) => item.id === groupId);
  const [addOpen, setAddOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [errorText, setErrorText] = useState("");
  const [dialogSearch, setDialogSearch] = useState("");

  const candidateAvatarList = useMemo(
    () => groupMemberCandidates(avatarList, metaAvatarUrl),
    [avatarList, metaAvatarUrl],
  );
  const avatarById = useMemo(() => {
    const map = new Map<string, Avatar>();
    for (const item of candidateAvatarList) map.set(item.id, item);
    return map;
  }, [candidateAvatarList]);

  const dialogCandidates = useMemo(() => {
    if (!addOpen || !group) return [];
    const existing = new Set(group.avatarIds);
    const query = dialogSearch.trim().toLocaleLowerCase();
    return candidateAvatarList.filter((avatar) => {
      if (existing.has(avatar.id)) return false;
      if (!query) return true;
      return (
        avatar.name.toLocaleLowerCase().includes(query) ||
        avatar.role.toLocaleLowerCase().includes(query) ||
        (avatar.description ?? "").toLocaleLowerCase().includes(query)
      );
    });
  }, [addOpen, candidateAvatarList, dialogSearch, group]);

  const graphOwner = useMemo(
    () => ({
      sessionId: String(sessionId || "").trim(),
      groupId: String(groupId || "").trim(),
    }),
    [groupId, sessionId],
  );
  const graphState = useGraphRunStore(
    (state) =>
      selectGraphStateForOwner(
        state.byPane[paneId] ?? EMPTY_PANE_GRAPH_STATE,
        graphOwner,
        activeGraphRunId,
      ).state,
  );
  const toolStepsByNode = graphState.toolStepsByNode;
  const runningToolByAgent = useMemo(
    () => deriveRunningToolByAgent(toolStepsByNode),
    [toolStepsByNode],
  );
  const hasLiveWork = useMemo(
    () =>
      activeAgentIds.length > 0 ||
      Object.keys(runningToolByAgent).length > 0 ||
      Object.keys(phaseOverrideById).length > 0,
    [activeAgentIds, phaseOverrideById, runningToolByAgent],
  );
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!hasLiveWork) return;
    setNowMs(Date.now());
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [hasLiveWork]);

  const wallIds = useMemo(() => group?.avatarIds ?? [], [group?.avatarIds]);
  const displayHostAvatarId = resolveGroupHostAvatarId(wallIds, group?.hostAvatarId);
  const slots = useMemo(
    () =>
      resolveCrewSlots({
        avatarIds: wallIds,
        hostAvatarId: displayHostAvatarId,
        messages,
        activeAgentIds,
        activityHintById,
        runningToolByAgent,
        phaseOverrideById,
        nowMs,
      }),
    [
      activeAgentIds,
      activityHintById,
      messages,
      nowMs,
      phaseOverrideById,
      runningToolByAgent,
      wallIds,
      displayHostAvatarId,
    ],
  );
  const executedCount = useMemo(
    () => slots.filter((slot) => slot.phase !== "idle").length,
    [slots],
  );
  if (!group) {
    return <p className="text-xs text-text-faint">未找到该群配置，可刷新群列表后重试。</p>;
  }

  const isManaged = group.createdBy === "enterprise_managed";
  const hostLabel = avatarById.get(displayHostAvatarId)?.name || "首位成员";

  const persistMembers = async (nextAvatarIds: string[]): Promise<boolean> => {
    if (isManaged) {
      setErrorText("企业能力包托管群聊的成员由管理员统一维护。");
      return false;
    }
    if (saving) return false;
    setSaving(true);
    setErrorText("");
    const previous = group.avatarIds;
    const previousHostAvatarId = group.hostAvatarId;
    const nextHostAvatarId = nextAvatarIds.includes(group.hostAvatarId)
      ? group.hostAvatarId
      : nextAvatarIds[0] || "";
    setGroups(
      groups.map((item) => (
        item.id === group.id
          ? { ...item, avatarIds: nextAvatarIds, hostAvatarId: nextHostAvatarId }
          : item
      )),
    );
    try {
      const result = await window.agenticxDesktop.updateGroup({
        id: group.id,
        avatar_ids: nextAvatarIds,
        host_avatar_id: nextHostAvatarId,
      });
      if (!result.ok) throw new Error(result.error || "更新群成员失败");
      return true;
    } catch (error) {
      setGroups(
        groups.map((item) => (
          item.id === group.id
            ? { ...item, avatarIds: previous, hostAvatarId: previousHostAvatarId }
            : item
        )),
      );
      setErrorText(error instanceof Error ? error.message : "更新群成员失败");
      return false;
    } finally {
      setSaving(false);
    }
  };

  const handleRemoveMember = async (avatarId: string) => {
    if (isManaged) {
      setErrorText("企业能力包托管群聊的成员由管理员统一维护。");
      return;
    }
    if (!group.avatarIds.includes(avatarId) || group.avatarIds.length <= 1) {
      setErrorText("群聊至少需要保留 1 位成员。");
      return;
    }
    const avatar = avatarById.get(avatarId);
    const api = window.agenticxDesktop;
    if (typeof api.confirmDialog === "function") {
      const result = await api.confirmDialog({
        title: "移出群成员",
        message: `确定将「${avatar?.name || "该成员"}」移出群聊吗？`,
        detail: "只会解除群聊关联，不会删除该数字专家。",
        confirmText: "移出成员",
        cancelText: "取消",
        destructive: true,
      });
      if (!result.confirmed) return;
    }
    await persistMembers(group.avatarIds.filter((id) => id !== avatarId));
  };

  const handleAddMember = async (avatarId: string) => {
    if (isManaged) {
      setErrorText("企业能力包托管群聊的成员由管理员统一维护。");
      return;
    }
    if (group.avatarIds.includes(avatarId)) return;
    await persistMembers([...group.avatarIds, avatarId]);
  };

  const closeAddDialog = () => {
    if (saving) return;
    setAddOpen(false);
    setDialogSearch("");
  };

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3 rounded-xl border border-border bg-surface-card px-3 py-2.5">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <UsersRound className="h-4 w-4 shrink-0 text-text-subtle" strokeWidth={1.8} aria-hidden />
            <span className="text-xs font-semibold text-text-primary">{isManaged ? "成员列表" : "群聊成员"}</span>
            <span className="rounded-full bg-surface-panel px-1.5 py-0.5 text-[10px] tabular-nums text-text-faint">
              {group.avatarIds.length}
            </span>
          </div>
          <p className="mt-1 text-[10px] leading-relaxed text-text-faint">
            {isManaged ? "成员由管理员通过能力包统一维护。" : "移出成员不会删除数字专家。"} · 本轮已执行 {executedCount}/{group.avatarIds.length} 位成员 · 主持人：{hostLabel}
          </p>
        </div>
        {!isManaged ? (
          <button
            type="button"
            disabled={saving}
            className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-[rgba(var(--theme-color-rgb,59,130,246),0.12)] px-2 py-1.5 text-[11px] font-medium text-[rgb(var(--theme-color-fg-rgb,59,130,246))] transition hover:bg-[rgba(var(--theme-color-rgb,59,130,246),0.2)] disabled:opacity-40"
            onClick={() => {
              setDialogSearch("");
              setErrorText("");
              setAddOpen(true);
            }}
          >
            <Plus className="h-3 w-3" strokeWidth={2} aria-hidden />
            添加
          </button>
        ) : null}
      </div>

      <div>
        <CrewWorkstationWall
          slots={slots}
          avatarById={avatarById}
          metaLeaderLabel={hostLabel}
          onAppendDirective={onAppendDirective}
          onOpenMember={onOpenMember}
          onSwitchModel={onSwitchModel}
          onInterrupt={onInterrupt}
          onRemoveMember={isManaged ? undefined : (avatarId) => void handleRemoveMember(avatarId)}
          removeDisabled={group.avatarIds.length <= 1}
        />
      </div>

      {saving ? <p className="text-[10px] text-text-faint">成员变更同步中…</p> : null}

      {errorText ? (
        <p className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-2.5 py-2 text-[10px] leading-relaxed text-rose-300" role="alert">
          {errorText}
        </p>
      ) : null}

      {addOpen && !isManaged ? (
        <div
          className="fixed inset-0 z-modal flex items-center justify-center bg-black/50 p-4"
          onClick={(event) => {
            if (event.target === event.currentTarget) closeAddDialog();
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="group-member-add-title"
            className="flex max-h-[min(560px,calc(100vh-2rem))] w-[min(440px,calc(100vw-2rem))] flex-col overflow-hidden rounded-2xl border border-border bg-surface-panel shadow-2xl"
          >
            <div className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-3">
              <div className="min-w-0 flex-1">
                <h3 id="group-member-add-title" className="text-sm font-semibold text-text-strong">添加成员</h3>
                <p className="mt-0.5 text-[11px] text-text-faint">直接点击某一行的「加入」，不需要勾选。</p>
              </div>
              <button
                type="button"
                className="agx-topbar-btn agx-topbar-btn--icon-only"
                aria-label="关闭添加成员"
                title="关闭"
                disabled={saving}
                onClick={closeAddDialog}
              >
                <X className="h-4 w-4" strokeWidth={2} />
              </button>
            </div>
            <label className="relative shrink-0 px-4 py-3">
              <Search className="pointer-events-none absolute left-7 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-faint" strokeWidth={1.8} aria-hidden />
              <input
                type="search"
                autoFocus
                value={dialogSearch}
                onChange={(event) => setDialogSearch(event.target.value)}
                placeholder="搜索名称或职责"
                disabled={saving}
                className="w-full rounded-lg border border-border bg-surface-card py-2 pl-9 pr-3 text-xs text-text-primary outline-none placeholder:text-text-faint focus:border-border-strong disabled:opacity-60"
              />
            </label>
            <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
              {dialogCandidates.length === 0 ? (
                <div className="rounded-xl border border-dashed border-border px-3 py-10 text-center text-xs leading-relaxed text-text-faint">
                  {dialogSearch.trim() ? "没有匹配的可加入成员" : "所有数字专家都已在群里"}
                </div>
              ) : (
                <div className="space-y-1">
                  {dialogCandidates.map((avatar) => (
                    <div key={avatar.id} className="flex items-center gap-2.5 rounded-xl px-2.5 py-2 transition hover:bg-surface-hover">
                      <GroupMemberAvatar avatar={avatar} size="sm" />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-xs font-medium text-text-primary">{avatar.name}</div>
                        <div className="mt-0.5 truncate text-[10px] text-text-faint">{avatar.role || "数字专家"}</div>
                      </div>
                      <button
                        type="button"
                        disabled={saving}
                        className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-[rgba(var(--theme-color-rgb,59,130,246),0.12)] px-2 py-1.5 text-[11px] font-medium text-[rgb(var(--theme-color-fg-rgb,59,130,246))] transition hover:bg-[rgba(var(--theme-color-rgb,59,130,246),0.2)] disabled:opacity-40"
                        onClick={() => void handleAddMember(avatar.id)}
                      >
                        <Plus className="h-3 w-3" strokeWidth={2} aria-hidden />
                        加入
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
