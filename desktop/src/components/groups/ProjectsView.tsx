import { useState } from "react";
import {
  ArrowUpRight,
  Download,
  Link2,
  MessageCircle,
  MoreHorizontal,
  Pencil,
  Plus,
  Upload,
  UsersRound,
} from "lucide-react";
import { MainViewShell } from "../ds/MainViewShell";
import { Toast } from "../ds/Toast";
import {
  ContextMenu,
  type ContextMenuAnchorRect,
  type ContextMenuItem,
} from "../ContextMenu";
import { useAppStore, type Avatar, type GroupChat } from "../../store";
import { groupColorByIndex } from "../../utils/avatar-color";
import { mapAvatarsFromApi, mapGroupsFromApi } from "../../utils/splash-preload-core";
import { GroupEditorInline } from "./GroupEditorInline";
import { GroupIdentityIcon, GroupMemberAvatar } from "./GroupMemberAvatar";
import { META_AGENT_DISPLAY_NAME } from "../../constants/branding";
import { usePaneNavigation } from "../../hooks/usePaneNavigation";
import { getRememberedSessionForAvatar } from "../../utils/avatar-last-session";
import { resolveGroupMember } from "../../utils/group-meta-member";
import {
  choosePortablePackageFile,
  PortablePackageImportDialog,
  type PortablePackageCandidate,
} from "../portable/PortablePackageImportDialog";
import {
  PortableMarketPublishDialog,
  type PortableMarketPublishTarget,
} from "../portable/PortableMarketPublishDialog";

type EditorState =
  | { mode: "create" }
  | { mode: "edit"; group: GroupChat }
  | null;

type GroupMenuState = { groupId: string; anchorRect: ContextMenuAnchorRect } | null;

/** Project cards: hover / focus borders follow --theme-color-rgb. */
const PROJECT_CARD_BASE =
  "rounded-xl border bg-surface-card transition-all outline-none hover:bg-surface-card-strong";
const PROJECT_CARD_IDLE =
  "border-border hover:border-[rgba(var(--theme-color-rgb,59,130,246),0.35)] focus-visible:border-[rgba(var(--theme-color-rgb,59,130,246),0.5)] focus-visible:ring-1 focus-visible:ring-[rgba(var(--theme-color-rgb,59,130,246),0.22)]";
const PROJECT_CARD_SELECTED =
  "border-[rgba(var(--theme-color-rgb,59,130,246),0.5)] bg-surface-card-strong ring-1 ring-[rgba(var(--theme-color-rgb,59,130,246),0.22)]";
const RESPONSIVE_CARD_GRID_STYLE = {
  gridTemplateColumns: "repeat(auto-fit, minmax(min(300px, 100%), 1fr))",
};

function GroupMemberStack({
  group,
  avatars,
  metaAvatarUrl,
}: {
  group: GroupChat;
  avatars: Avatar[];
  metaAvatarUrl: string;
}) {
  const members = group.avatarIds.map((id) => resolveGroupMember(id, avatars, metaAvatarUrl));
  const visibleMembers = members.slice(0, 4);
  const remaining = Math.max(0, members.length - visibleMembers.length);

  return (
    <div className="flex shrink-0 items-center gap-2" aria-label={`${group.avatarIds.length} 位群成员`}>
      {visibleMembers.map((avatar, index) => (
        <div key={avatar?.id ?? group.avatarIds[index]}>
          <GroupMemberAvatar
            avatar={avatar}
            label={avatar?.name ?? group.avatarIds[index]}
            identity={group.avatarIds[index]}
            size="xs"
            className="ring-1 ring-border"
          />
        </div>
      ))}
      {remaining > 0 ? (
        <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-surface-panel text-[10px] font-medium text-text-subtle ring-1 ring-border">
          +{remaining}
        </span>
      ) : null}
    </div>
  );
}

export function ProjectsView() {
  const groups = useAppStore((s) => s.groups);
  const avatars = useAppStore((s) => s.avatars);
  const metaAvatarUrl = useAppStore((s) => s.metaAvatarUrl);
  const setAvatars = useAppStore((s) => s.setAvatars);
  const setGroups = useAppStore((s) => s.setGroups);
  const enterpriseLoggedIn = useAppStore((s) => s.userAccount.loggedIn);
  const setMainView = useAppStore((s) => s.setMainView);
  const setAvatarSettingsTargetId = useAppStore((s) => s.setAvatarSettingsTargetId);
  const panes = useAppStore((s) => s.panes);
  const addPane = useAppStore((s) => s.addPane);
  const removePane = useAppStore((s) => s.removePane);

  const { openGroupPane } = usePaneNavigation();

  const [editorState, setEditorState] = useState<EditorState>(null);
  const [importCandidate, setImportCandidate] = useState<PortablePackageCandidate | null>(null);
  const [publishTarget, setPublishTarget] = useState<PortableMarketPublishTarget | null>(null);
  const [groupMenu, setGroupMenu] = useState<GroupMenuState>(null);
  const [notice, setNotice] = useState("");

  const refreshAvatars = async () => {
    try {
      const result = await window.agenticxDesktop.listAvatars();
      if (result.ok && Array.isArray(result.avatars)) {
        const next = mapAvatarsFromApi(result.avatars);
        setAvatars(next);
        return next;
      }
    } catch {
      /* App-level refresh remains the fallback for transient backend errors. */
    }
    return [];
  };

  const refreshGroups = async () => {
    try {
      const result = await window.agenticxDesktop.listGroups();
      if (result.ok && Array.isArray(result.groups)) {
        const next = mapGroupsFromApi(result.groups);
        setGroups(next);
        return next;
      }
    } catch {
      /* App.tsx fallback covers cold-start; ignore transient errors here. */
    }
    return [];
  };

  const handleGroupDelete = async (group: GroupChat): Promise<boolean | undefined> => {
    if (group.createdBy === "enterprise_managed") {
      setNotice("这是企业能力包下发的托管群聊，不能直接删除。管理员移出能力包后会自动撤回。");
      return false;
    }
    const api = window.agenticxDesktop;
    if (typeof api.confirmDialog !== "function") {
      setNotice("当前环境不支持删除确认，请重启 Desktop 后重试。");
      return false;
    }
    const confirmResult = await api.confirmDialog({
      title: "确认删除群聊",
      message: `确定删除群聊「${group.name}」吗？`,
      detail: "删除后群聊配置不可恢复，已有对话记录不会被自动改写。",
      confirmText: "删除群聊",
      cancelText: "取消",
      destructive: true,
    });
    if (!confirmResult.confirmed) return undefined;

    const groupPaneId = `group:${group.id}`;
    const groupPanes = panes.filter((item) => item.avatarId === groupPaneId);
    const nonGroupPanes = panes.filter((item) => item.avatarId !== groupPaneId);
    try {
      const result = await api.deleteGroup(group.id);
      if (!result.ok) throw new Error(result.error || "删除群聊失败");
      if (nonGroupPanes.length === 0 && groupPanes.length > 0) {
        addPane(null, META_AGENT_DISPLAY_NAME, "");
      }
      groupPanes.forEach((item) => removePane(item.id));
      setGroups(groups.filter((g) => g.id !== group.id));
      await refreshGroups();
      setNotice(`已删除群聊「${group.name}」。`);
      return true;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "删除群聊失败，请稍后重试。");
      return false;
    }
  };

  const handleEditMember = (avatarId: string) => {
    if (!avatars.some((avatar) => avatar.id === avatarId)) {
      setNotice("该成员已不存在，请刷新群聊成员后重试。");
      return;
    }
    setEditorState(null);
    setAvatarSettingsTargetId(avatarId);
    setMainView("avatars");
  };

  const handleOpenGroupDetails = (group: GroupChat) => {
    setGroupMenu(null);
    setEditorState({ mode: "edit", group });
  };

  const handleImportGroup = async () => {
    const selection = await choosePortablePackageFile("group");
    if (selection.status === "selected") {
      setImportCandidate(selection.candidate);
    } else if (selection.status === "error") {
      setNotice(selection.error);
    }
  };

  const handleExportGroup = async (group: GroupChat) => {
    setGroupMenu(null);
    try {
      const result = await window.agenticxDesktop.exportPortablePackage({
        kind: "group",
        id: group.id,
        name: group.name,
      });
      if (result.canceled) return;
      setNotice(
        result.ok
          ? `已导出项目群聊「${group.name}」。`
          : result.error || "导出项目群聊失败，请稍后重试。",
      );
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "导出项目群聊失败，请稍后重试。");
    }
  };

  const handleShareGroupLink = async (group: GroupChat) => {
    setGroupMenu(null);
    try {
      const result = await window.agenticxDesktop.createPortablePackageShareLink({
        kind: "group",
        id: group.id,
      });
      setNotice(
        result.ok
          ? `项目群聊「${group.name}」的公司链接已复制。`
          : result.error || "创建公司链接失败，请稍后重试。",
      );
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "创建公司链接失败，请稍后重试。");
    }
  };

  const handlePublishGroup = (group: GroupChat) => {
    setGroupMenu(null);
    setPublishTarget({
      kind: "group",
      id: group.id,
      name: group.name,
      currentVersion: group.portableReleaseVersion,
    });
  };

  const menuGroup = groupMenu
    ? groups.find((group) => group.id === groupMenu.groupId)
    : undefined;
  const groupMenuItems: ContextMenuItem[] = menuGroup
    ? [
        {
          label: menuGroup.createdBy === "enterprise_managed" ? "群聊设置（只读）" : "群聊设置",
          icon: <Pencil className="h-3.5 w-3.5" strokeWidth={1.8} />,
          onSelect: () => handleOpenGroupDetails(menuGroup),
        },
        { separator: true },
        {
          label: "导出分享文件",
          icon: <Download className="h-3.5 w-3.5" strokeWidth={1.8} />,
          onSelect: () => void handleExportGroup(menuGroup),
        },
        ...(enterpriseLoggedIn
          ? [
              {
                label: "复制公司链接",
                icon: <Link2 className="h-3.5 w-3.5" strokeWidth={1.8} />,
                onSelect: () => void handleShareGroupLink(menuGroup),
              },
              {
                label: "发布到公司市场",
                icon: <Upload className="h-3.5 w-3.5" strokeWidth={1.8} />,
                onSelect: () => handlePublishGroup(menuGroup),
              },
            ] satisfies ContextMenuItem[]
          : []),
      ]
    : [];

  return (
    <MainViewShell>
      <div className="mb-7 flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-[min(100%,28rem)] flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-xl font-semibold tracking-tight text-text-strong">项目群聊</h2>
            <span className="rounded-full bg-surface-card px-2 py-0.5 text-[11px] tabular-nums text-text-subtle">
              {groups.length} 个团队
            </span>
          </div>
          <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-text-muted">
            用一个群聊承载完整协作，每个群聊都有一位可随时更换的主持人。
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2 whitespace-nowrap">
          <button
            type="button"
            className="flex items-center gap-1.5 rounded-lg border border-border bg-surface-card px-3.5 py-2.5 text-[13px] font-medium text-text-muted transition hover:bg-surface-hover hover:text-text-strong"
            onClick={() => void handleImportGroup()}
          >
            <Upload className="h-4 w-4" aria-hidden />
            导入群聊
          </button>
          <button
            type="button"
            className="flex items-center gap-1.5 rounded-lg bg-[var(--ui-btn-primary-bg)] px-3.5 py-2.5 text-[13px] font-medium text-[var(--ui-btn-primary-text)] transition hover:bg-[var(--ui-btn-primary-bg-hover)]"
            onClick={() => {
              setEditorState({ mode: "create" });
            }}
          >
            <Plus className="h-4 w-4" />
            新建群聊
          </button>
        </div>
      </div>

      <section className="mb-8">
        <div className="mb-3">
          <h3 className="text-sm font-semibold text-text-strong">我的群聊</h3>
        </div>
        {groups.length === 0 ? (
          <div className="flex min-h-44 flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-surface-card/35 px-4 py-10 text-center">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-surface-card text-text-faint">
              <UsersRound className="h-5 w-5" strokeWidth={1.7} aria-hidden />
            </div>
            <p className="mt-3 text-sm font-medium text-text-muted">还没有项目群聊</p>
            <p className="mt-1 text-xs text-text-faint">从右上角新建，或前往专家广场添加官方团队模板。</p>
          </div>
        ) : (
          <div className="grid gap-3" style={RESPONSIVE_CARD_GRID_STYLE}>
            {groups.map((group, groupIndex) => {
              const groupAvatarId = `group:${group.id}`;
              const hasPane = panes.some((p) => p.avatarId === groupAvatarId);
              const hasRememberedConversation = Boolean(
                getRememberedSessionForAvatar(groupAvatarId),
              );
              const primaryActionLabel = "进入群聊";
              const statusText = hasPane
                ? "已打开群聊"
                : hasRememberedConversation
                  ? "有历史消息"
                  : "持久群聊";
              const { iconBg } = groupColorByIndex(groupIndex);
              const hostName = resolveGroupMember(group.hostAvatarId, avatars, metaAvatarUrl)?.name || "首位成员";
              const isGroupSelected =
                editorState?.mode === "edit" && editorState.group.id === group.id;
              return (
                <article
                  key={group.id}
                  className={`group relative flex min-h-[156px] flex-col overflow-hidden ${PROJECT_CARD_BASE} ${isGroupSelected ? PROJECT_CARD_SELECTED : PROJECT_CARD_IDLE}`}
                >
                  <button
                    type="button"
                    className="flex min-h-0 flex-1 flex-col p-4 text-left"
                    onClick={() => handleOpenGroupDetails(group)}
                    aria-label={`打开群聊详情：${group.name}`}
                  >
                    <div className="flex items-start gap-3">
                      <div className="relative shrink-0">
                        <GroupIdentityIcon
                          identity={group.portableArtifactId || group.id}
                          avatarUrl={group.avatarUrl}
                          iconBg={iconBg}
                          size="lg"
                        />
                        {hasPane ? (
                          <span className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-surface-card bg-emerald-500" />
                        ) : null}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <div className="truncate text-[15px] font-semibold text-text-strong">
                            {group.name}
                          </div>
                          {group.createdBy === "enterprise_managed" ? (
                            <span className="shrink-0 rounded-full border border-[rgba(var(--theme-color-rgb,59,130,246),0.28)] px-1.5 py-0.5 text-[9px] font-medium text-text-subtle">
                              企业下发
                            </span>
                          ) : null}
                          <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-text-faint opacity-0 transition group-hover:opacity-100" strokeWidth={1.8} aria-hidden />
                        </div>
                        <p
                          className="mt-1 truncate text-xs text-text-muted"
                          title={`${group.avatarIds.length} 位成员 · 主持人：${hostName}`}
                        >
                          {group.avatarIds.length} 位成员 · 主持人：{hostName}
                        </p>
                        {group.description ? (
                          <p className="mt-1 truncate text-[11px] text-text-faint" title={group.description}>
                            {group.description}
                          </p>
                        ) : null}
                      </div>
                    </div>
                    <div className="mt-auto flex min-w-0 items-center justify-between gap-3 pt-4">
                      <GroupMemberStack group={group} avatars={avatars} metaAvatarUrl={metaAvatarUrl} />
                      <span className="min-w-0 truncate text-xs text-text-subtle" title={statusText}>
                        {statusText}
                      </span>
                    </div>
                  </button>
                  <div className="grid shrink-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-1.5 border-t border-border px-3 py-2.5">
                    <button
                      type="button"
                      className="inline-flex min-w-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-border bg-surface-panel px-2.5 py-2 text-xs font-medium text-text-subtle transition hover:border-border-strong hover:bg-surface-hover hover:text-text-strong"
                      onClick={() => openGroupPane(group)}
                      aria-label={`${primaryActionLabel}：${group.name}`}
                    >
                      <MessageCircle className="h-3.5 w-3.5 shrink-0" strokeWidth={1.8} aria-hidden />
                      <span className="truncate">{primaryActionLabel}</span>
                    </button>
                    <button
                      type="button"
                      className="inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 py-2 text-xs text-text-subtle transition hover:bg-surface-hover hover:text-text-strong"
                      aria-label={`管理${group.name}`}
                      aria-haspopup="menu"
                      aria-expanded={groupMenu?.groupId === group.id}
                      title="管理与分享"
                      onClick={(event) => {
                        const rect = event.currentTarget.getBoundingClientRect();
                        setGroupMenu((current) => current?.groupId === group.id
                          ? null
                          : {
                              groupId: group.id,
                              anchorRect: {
                                left: rect.left,
                                top: rect.top,
                                right: rect.right,
                                bottom: rect.bottom,
                              },
                            });
                      }}
                    >
                      <MoreHorizontal className="h-3.5 w-3.5 shrink-0" strokeWidth={1.8} aria-hidden />
                      管理
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>

      <ContextMenu
        open={Boolean(groupMenu && menuGroup)}
        x={groupMenu?.anchorRect.left ?? 0}
        y={groupMenu?.anchorRect.bottom ?? 0}
        anchorRect={groupMenu?.anchorRect}
        items={groupMenuItems}
        onClose={() => setGroupMenu(null)}
      />

      {editorState && (
        <GroupEditorInline
          avatars={avatars}
          initialGroup={editorState.mode === "edit" ? editorState.group : undefined}
          onEditMember={handleEditMember}
          onDelete={
            editorState.mode === "edit"
              ? async (groupId) => {
                  const group = groups.find((g) => g.id === groupId);
                  if (!group) return false;
                  const deleted = await handleGroupDelete(group);
                  if (deleted) setEditorState(null);
                  return deleted;
                }
              : undefined
          }
          onClose={() => setEditorState(null)}
          onOpenChat={
            editorState.mode === "edit"
              ? () => {
                  setEditorState(null);
                  openGroupPane(editorState.group);
                }
              : undefined
          }
          onSaved={() => {
            void refreshGroups();
            setNotice(editorState.mode === "create" ? "群聊已创建。" : "群聊设置已保存。");
            setEditorState(null);
          }}
        />
      )}

      <PortablePackageImportDialog
        candidate={importCandidate}
        onClose={() => setImportCandidate(null)}
        onImported={async (result) => {
          await Promise.all([refreshAvatars(), refreshGroups()]);
          const name = result.group?.name || importCandidate?.preview.name || "项目群聊";
          setNotice(`已导入项目群聊「${name}」。`);
        }}
      />

      <PortableMarketPublishDialog
        target={publishTarget}
        onClose={() => setPublishTarget(null)}
        onPublished={(target, result) => {
          setNotice(result.notice || result.warning || `项目群聊「${target.name}」已发布到公司市场。`);
          void refreshGroups();
          window.dispatchEvent(new Event("portable-market-changed"));
        }}
      />

      <Toast open={Boolean(notice)} message={notice} onClose={() => setNotice("")} />
    </MainViewShell>
  );
}
