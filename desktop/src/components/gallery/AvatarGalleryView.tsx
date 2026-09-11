import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Download,
  FolderOpen,
  GripVertical,
  Link2,
  Loader2,
  MoreHorizontal,
  Pencil,
  Plus,
  Sparkles,
  Star,
  Trash2,
  Upload,
} from "lucide-react";
import { MainViewShell } from "../ds/MainViewShell";
import { Toast } from "../ds/Toast";
import {
  ContextMenu,
  type ContextMenuAnchorRect,
  type ContextMenuItem,
} from "../ContextMenu";
import { useAppStore } from "../../store";
import { avatarBgClass, avatarFgClass } from "../../utils/avatar-color";
import { AvatarCreateDialog } from "../AvatarCreateDialog";
import { AvatarSettingsPanel } from "../AvatarSettingsPanel";
import { usePaneNavigation } from "../../hooks/usePaneNavigation";
import { buildAiExpertCreationDraft } from "./avatar-ai-creation";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  rectSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  choosePortablePackageFile,
  PortablePackageImportDialog,
  type PortablePackageCandidate,
} from "../portable/PortablePackageImportDialog";
import {
  PortableMarketPublishDialog,
  type PortableMarketPublishTarget,
} from "../portable/PortableMarketPublishDialog";

function avatarInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

type CardMenuState = { avatarId: string; anchorRect: ContextMenuAnchorRect } | null;

/** Gallery cards: idle / focus / selected borders follow --theme-color-rgb. */
const GALLERY_CARD_BASE =
  "group relative flex cursor-pointer flex-col rounded-xl border bg-surface-card p-4 transition-all outline-none hover:bg-surface-card-strong";
const GALLERY_CARD_IDLE =
  "border-border hover:border-[rgba(var(--theme-color-rgb,59,130,246),0.35)] focus-visible:border-[rgba(var(--theme-color-rgb,59,130,246),0.5)] focus-visible:ring-1 focus-visible:ring-[rgba(var(--theme-color-rgb,59,130,246),0.22)]";
const GALLERY_CARD_SELECTED =
  "border-[rgba(var(--theme-color-rgb,59,130,246),0.5)] bg-surface-card-strong ring-1 ring-[rgba(var(--theme-color-rgb,59,130,246),0.22)]";

const GALLERY_CREATE_BASE =
  "flex min-h-[168px] flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed text-text-faint outline-none transition";
const GALLERY_CREATE_IDLE =
  "border-border hover:border-[rgba(var(--theme-color-rgb,59,130,246),0.35)] hover:text-[rgb(var(--theme-color-fg-rgb,59,130,246))] focus-visible:border-[rgba(var(--theme-color-rgb,59,130,246),0.5)] focus-visible:text-[rgb(var(--theme-color-fg-rgb,59,130,246))] focus-visible:ring-1 focus-visible:ring-[rgba(var(--theme-color-rgb,59,130,246),0.22)]";
const GALLERY_CREATE_ACTIVE =
  "border-[rgba(var(--theme-color-rgb,59,130,246),0.5)] text-[rgb(var(--theme-color-fg-rgb,59,130,246))] ring-1 ring-[rgba(var(--theme-color-rgb,59,130,246),0.22)]";
const RESPONSIVE_CARD_GRID_STYLE = {
  gridTemplateColumns: "repeat(auto-fit, minmax(min(300px, 100%), 1fr))",
};

export function AvatarGalleryView() {
  const avatars = useAppStore((s) => s.avatars);
  const setAvatars = useAppStore((s) => s.setAvatars);
  const panes = useAppStore((s) => s.panes);
  const corePreloadAttempted = useAppStore((s) => s.corePreloadAttempted);
  const removePane = useAppStore((s) => s.removePane);
  const activeAvatarId = useAppStore((s) => s.activeAvatarId);
  const setActiveAvatarId = useAppStore((s) => s.setActiveAvatarId);
  const avatarSettingsTargetId = useAppStore((s) => s.avatarSettingsTargetId);
  const setAvatarSettingsTargetId = useAppStore((s) => s.setAvatarSettingsTargetId);
  const enterpriseLoggedIn = useAppStore((s) => s.userAccount.loggedIn);

  const { openMetaOrAvatarPane, newMetaTask } = usePaneNavigation();

  const [createOpen, setCreateOpen] = useState(false);
  const [settingsAvatarId, setSettingsAvatarId] = useState<string | null>(null);
  const [cardMenu, setCardMenu] = useState<CardMenuState>(null);
  const [importCandidate, setImportCandidate] = useState<PortablePackageCandidate | null>(null);
  const [publishTarget, setPublishTarget] = useState<PortableMarketPublishTarget | null>(null);
  const [notice, setNotice] = useState("");

  const avatarsLoaded = corePreloadAttempted || avatars.length > 0;

  useEffect(() => {
    if (!avatarSettingsTargetId || !avatarsLoaded) return;
    const targetExists = avatars.some((avatar) => avatar.id === avatarSettingsTargetId);
    setSettingsAvatarId(targetExists ? avatarSettingsTargetId : null);
    setAvatarSettingsTargetId(null);
  }, [avatarSettingsTargetId, avatars, avatarsLoaded, setAvatarSettingsTargetId]);

  const sortedAvatars = useMemo(() => {
    return [...avatars].sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      const sa = a.sortOrder ?? 0;
      const sb = b.sortOrder ?? 0;
      if (sa !== sb) return sa - sb;
      return a.name.localeCompare(b.name);
    });
  }, [avatars]);

  const [localOrder, setLocalOrder] = useState<string[] | null>(null);
  const displayAvatars = useMemo(() => {
    if (!localOrder) return sortedAvatars;
    const map = new Map(sortedAvatars.map((a) => [a.id, a]));
    const ordered = localOrder.map((id) => map.get(id)).filter(Boolean) as typeof sortedAvatars;
    // append any avatars not in localOrder (e.g. newly created)
    for (const a of sortedAvatars) {
      if (!localOrder.includes(a.id)) ordered.push(a);
    }
    return ordered;
  }, [sortedAvatars, localOrder]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );

  const handleDragEnd = useCallback(async (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const ids = displayAvatars.map((a) => a.id);
    const oldIndex = ids.indexOf(String(active.id));
    const newIndex = ids.indexOf(String(over.id));
    if (oldIndex < 0 || newIndex < 0) return;
    const newOrder = arrayMove(ids, oldIndex, newIndex);
    setLocalOrder(newOrder);
    // Persist sort_order to backend via IPC.
    // Use idx+1 so 0 remains "unset" and -1 remains "built-in default".
    const orders: Record<string, number> = {};
    newOrder.forEach((id, idx) => { orders[id] = idx + 1; });
    try {
      await window.agenticxDesktop.reorderAvatars(orders);
    } catch {
      // non-fatal: local order is already updated
    }
  }, [displayAvatars]);

  const refreshAvatars = async () => {
    window.dispatchEvent(
      new CustomEvent("agenticx:avatars:changed", { detail: { openPane: false } })
    );
  };

  const handleCreate = async (data: {
    name: string;
    role: string;
    systemPrompt: string;
    blurb?: string;
    tags?: string[];
    toolsEnabled: Record<string, boolean>;
    skillsEnabled?: Record<string, boolean>;
    defaultProvider?: string;
    defaultModel?: string;
    workspaceDir?: string;
  }) => {
    const se = data.skillsEnabled;
    const falses =
      se && typeof se === "object"
        ? Object.fromEntries(Object.entries(se).filter(([, v]) => v === false))
        : {};
    const skillsPayload = Object.keys(falses).length > 0 ? falses : undefined;
    const dp = (data.defaultProvider || "").trim();
    const dm = (data.defaultModel || "").trim();
    const ws = (data.workspaceDir || "").trim();
    const blurb = (data.blurb || "").trim();
    const tags = (data.tags || []).filter(Boolean);
    await window.agenticxDesktop.createAvatar({
      name: data.name,
      role: data.role,
      system_prompt: data.systemPrompt,
      tools_enabled: data.toolsEnabled,
      ...(skillsPayload !== undefined ? { skills_enabled: skillsPayload } : {}),
      ...(dp ? { default_provider: dp } : {}),
      ...(dm ? { default_model: dm } : {}),
      ...(ws ? { workspace_dir: ws } : {}),
      ...(blurb ? { description: blurb } : {}),
      ...(tags.length > 0 ? { tags } : {}),
    });
    await refreshAvatars();
  };

  const handleCreateViaChat = (description: string) => {
    newMetaTask(buildAiExpertCreationDraft(description));
  };

  const handlePinToggle = async (avatarId: string) => {
    setCardMenu(null);
    const avatar = avatars.find((a) => a.id === avatarId);
    if (!avatar) return;
    await window.agenticxDesktop.updateAvatar({ id: avatarId, pinned: !avatar.pinned });
    await refreshAvatars();
  };

  const handleImportExpert = async () => {
    const selection = await choosePortablePackageFile("expert");
    if (selection.status === "selected") {
      setImportCandidate(selection.candidate);
    } else if (selection.status === "error") {
      setNotice(selection.error);
    }
  };

  const handleExportAvatar = async (avatarId: string) => {
    setCardMenu(null);
    const avatar = avatars.find((item) => item.id === avatarId);
    if (!avatar) return;
    try {
      const result = await window.agenticxDesktop.exportPortablePackage({
        kind: "expert",
        id: avatar.id,
        name: avatar.name,
      });
      if (result.canceled) return;
      setNotice(
        result.ok
          ? `已导出数字专家「${avatar.name}」。`
          : result.error || "导出数字专家失败，请稍后重试。",
      );
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "导出数字专家失败，请稍后重试。");
    }
  };

  const handleShareAvatarLink = async (avatarId: string) => {
    setCardMenu(null);
    const avatar = avatars.find((item) => item.id === avatarId);
    if (!avatar) return;
    try {
      const result = await window.agenticxDesktop.createPortablePackageShareLink({
        kind: "expert",
        id: avatar.id,
      });
      setNotice(
        result.ok
          ? `数字专家「${avatar.name}」的公司链接已复制。`
          : result.error || "创建公司链接失败，请稍后重试。",
      );
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "创建公司链接失败，请稍后重试。");
    }
  };

  const handlePublishAvatar = (avatarId: string) => {
    setCardMenu(null);
    const avatar = avatars.find((item) => item.id === avatarId);
    if (!avatar) return;
    setPublishTarget({
      kind: "expert",
      id: avatar.id,
      name: avatar.name,
      currentVersion: avatar.portableReleaseVersion,
    });
  };

  const handleDelete = async (avatarId: string) => {
    setCardMenu(null);
    const avatar = avatars.find((a) => a.id === avatarId);
    if (!avatar) return;
    const api = window.agenticxDesktop;
    const confirmResult =
      typeof api.confirmDialog === "function"
        ? await api.confirmDialog({
            title: "确认删除专家",
            message: `确定删除专家「${avatar.name}」吗？`,
            detail: "此操作不可恢复。",
            confirmText: "删除",
            cancelText: "取消",
            destructive: true,
          })
        : { ok: true, confirmed: window.confirm(`确定删除专家「${avatar.name}」吗？此操作不可恢复。`) };
    if (!confirmResult.confirmed) return;
    panes.filter((item) => item.avatarId === avatarId).forEach((item) => removePane(item.id));
    if (activeAvatarId === avatarId) setActiveAvatarId(null);
    setAvatars(avatars.filter((a) => a.id !== avatarId));
    await api.deleteAvatar(avatarId);
    await refreshAvatars();
  };

  const settingsAvatar = settingsAvatarId
    ? avatars.find((a) => a.id === settingsAvatarId)
    : undefined;
  const menuAvatar = cardMenu
    ? avatars.find((avatar) => avatar.id === cardMenu.avatarId)
    : undefined;
  const cardMenuItems: ContextMenuItem[] = menuAvatar
    ? [
        {
          label: menuAvatar.createdBy === "enterprise_managed" ? "管理设置（只读）" : "管理设置",
          icon: <Pencil className="h-3.5 w-3.5" />,
          onSelect: () => {
            setSettingsAvatarId(menuAvatar.id);
          },
        },
        {
          label: menuAvatar.pinned ? "取消关注" : "关注",
          icon: <Star className="h-3.5 w-3.5" />,
          onSelect: () => void handlePinToggle(menuAvatar.id),
        },
        { separator: true },
        {
          label: "导出分享文件",
          icon: <Download className="h-3.5 w-3.5" />,
          onSelect: () => void handleExportAvatar(menuAvatar.id),
        },
        ...(enterpriseLoggedIn
          ? [
              {
                label: "复制公司链接",
                icon: <Link2 className="h-3.5 w-3.5" />,
                onSelect: () => void handleShareAvatarLink(menuAvatar.id),
              },
              {
                label: "发布到公司市场",
                icon: <Upload className="h-3.5 w-3.5" />,
                onSelect: () => handlePublishAvatar(menuAvatar.id),
              },
            ] satisfies ContextMenuItem[]
          : []),
        ...(menuAvatar.workspaceDir
          ? [
              {
                label: "打开文件夹",
                icon: <FolderOpen className="h-3.5 w-3.5" />,
                onSelect: () => void window.agenticxDesktop.shellOpenPath(menuAvatar.workspaceDir || ""),
              },
            ] satisfies ContextMenuItem[]
          : []),
        ...(!menuAvatar.tags?.some((tag) => tag.startsWith("builtin:"))
          && menuAvatar.createdBy !== "enterprise_managed"
          ? [
              { separator: true },
              {
                label: "删除专家",
                icon: <Trash2 className="h-3.5 w-3.5" />,
                danger: true,
                onSelect: () => void handleDelete(menuAvatar.id),
              },
            ] satisfies ContextMenuItem[]
          : []),
      ]
    : [];

  return (
    <MainViewShell>
      {/* Sticky title row only; 关注分身仍靠排序置顶，不钉死 */}
      <div className="sticky top-0 z-10 -mx-6 -mt-6 mb-5 border-b border-border bg-surface-base px-6 pb-4 pt-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-[min(100%,24rem)] flex-1">
            <h2 className="text-lg font-semibold text-text-strong">数字专家</h2>
            <p className="mt-1 text-sm text-text-muted">
              为你的团队召集专精专家；点击卡片查看资料，点「立即对话」开始对话。
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2 whitespace-nowrap">
            <button
              type="button"
              className="flex items-center gap-1.5 rounded-lg border border-border bg-surface-card px-3 py-2 text-[13px] font-medium text-text-muted transition hover:bg-surface-hover hover:text-text-strong"
              onClick={() => void handleImportExpert()}
            >
              <Upload className="h-4 w-4" aria-hidden />
              导入专家
            </button>
            <button
              type="button"
              className="flex items-center gap-1.5 rounded-lg bg-btnPrimary px-3 py-2 text-[13px] font-medium text-btnPrimary-text transition hover:bg-btnPrimary-hover"
              onClick={() => setCreateOpen(true)}
            >
              <Plus className="h-4 w-4" />
              新建专家
            </button>
          </div>
        </div>
      </div>

      {!avatarsLoaded ? (
        <div className="flex items-center justify-center gap-2 py-16 text-sm text-text-faint">
          <Loader2 className="h-4 w-4 animate-spin" />
          正在加载专家…
        </div>
      ) : displayAvatars.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border py-16 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-surface-card text-text-faint">
            <Sparkles className="h-5 w-5" />
          </div>
          <div className="text-[15px] font-semibold text-text-strong">还没有数字专家</div>
          <p className="text-sm text-text-muted">创建属于你的数字专家，处理专精任务</p>
          <button
            type="button"
            className="mt-1 flex items-center gap-1.5 rounded-lg bg-btnPrimary px-3 py-2 text-[13px] font-medium text-btnPrimary-text transition hover:bg-btnPrimary-hover"
            onClick={() => setCreateOpen(true)}
          >
            <Plus className="h-4 w-4" />
            新建专家
          </button>
        </div>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={displayAvatars.map((a) => a.id)} strategy={rectSortingStrategy}>
            <div className="grid gap-3" style={RESPONSIVE_CARD_GRID_STYLE}>
              {displayAvatars.map((avatar) => (
                <SortableAvatarCard
                  key={avatar.id}
                  avatar={avatar}
                  hasPane={panes.some((p) => p.avatarId === avatar.id)}
                  isCardSelected={settingsAvatarId === avatar.id}
                  onOpenSettings={() => setSettingsAvatarId(avatar.id)}
                  onOpenPane={() => openMetaOrAvatarPane(avatar.id, avatar.name)}
                  onCardMenu={(rect) => setCardMenu((current) => current?.avatarId === avatar.id
                    ? null
                    : {
                        avatarId: avatar.id,
                        anchorRect: {
                          left: rect.left,
                          top: rect.top,
                          right: rect.right,
                          bottom: rect.bottom,
                        },
                      })}
                />
              ))}
              <button
                type="button"
                className={`${GALLERY_CREATE_BASE} ${createOpen ? GALLERY_CREATE_ACTIVE : GALLERY_CREATE_IDLE}`}
                onClick={() => setCreateOpen(true)}
              >
                <Plus className="h-5 w-5" />
                <span className="text-[13px] font-medium">创建专家</span>
              </button>
            </div>
          </SortableContext>
        </DndContext>
      )}

      <ContextMenu
        open={Boolean(cardMenu && menuAvatar)}
        x={cardMenu?.anchorRect.left ?? 0}
        y={cardMenu?.anchorRect.bottom ?? 0}
        anchorRect={cardMenu?.anchorRect}
        items={cardMenuItems}
        onClose={() => setCardMenu(null)}
      />

      <AvatarCreateDialog
        open={createOpen}
        onClose={() => {
          setCreateOpen(false);
          void refreshAvatars();
        }}
        onCreate={handleCreate}
        onCreateViaChat={handleCreateViaChat}
      />

      <PortablePackageImportDialog
        candidate={importCandidate}
        onClose={() => setImportCandidate(null)}
        onImported={(result) => {
          const name = result.avatar?.name || importCandidate?.preview.name || "数字专家";
          setNotice(`已导入数字专家「${name}」。`);
        }}
      />

      <PortableMarketPublishDialog
        target={publishTarget}
        onClose={() => setPublishTarget(null)}
        onPublished={(target, result) => {
          setNotice(result.notice || result.warning || `数字专家「${target.name}」已发布到公司市场。`);
          void refreshAvatars();
          window.dispatchEvent(new Event("portable-market-changed"));
        }}
      />

      {settingsAvatar && (
        <AvatarSettingsPanel
          mode="avatar"
          avatar={settingsAvatar}
          onClose={() => setSettingsAvatarId(null)}
          onSaved={() => void refreshAvatars()}
        />
      )}

      <Toast open={Boolean(notice)} message={notice} onClose={() => setNotice("")} />
    </MainViewShell>
  );
}

function SortableAvatarCard({
  avatar,
  hasPane,
  isCardSelected,
  onOpenSettings,
  onOpenPane,
  onCardMenu,
}: {
  avatar: ReturnType<typeof useAppStore.getState>["avatars"][number];
  hasPane: boolean;
  isCardSelected: boolean;
  onOpenSettings: () => void;
  onOpenPane: () => void;
  onCardMenu: (rect: DOMRect) => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: avatar.id });
  const publicTags = (avatar.tags ?? []).filter((tag) => !tag.startsWith("builtin:"));
  const visibleTags = publicTags.slice(0, 3);
  const hiddenTagCount = Math.max(0, publicTags.length - visibleTags.length);

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : 1,
        zIndex: isDragging ? 50 : undefined,
      }}
      role="button"
      tabIndex={0}
      className={`${GALLERY_CARD_BASE} ${isCardSelected ? GALLERY_CARD_SELECTED : GALLERY_CARD_IDLE} ${isDragging ? "shadow-xl ring-2 ring-[rgb(var(--theme-color-rgb,59,130,246))]" : ""}`}
      onClick={onOpenSettings}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpenSettings();
        }
      }}
    >
      <div className="flex items-start gap-3">
        <div
          className="shrink-0 cursor-grab pt-0.5 text-text-faint opacity-40 transition hover:opacity-80 active:cursor-grabbing"
          {...attributes}
          {...listeners}
          title="拖动排序"
        >
          <GripVertical className="h-4 w-4" />
        </div>
        <div className="relative shrink-0">
          {avatar.avatarUrl ? (
            <img
              src={avatar.avatarUrl}
              alt={avatar.name}
              className="h-14 w-14 rounded-2xl object-cover"
            />
          ) : (
            <div
              className={`flex h-14 w-14 items-center justify-center rounded-2xl text-base font-bold ${avatarBgClass(avatar.color)} ${avatarFgClass(avatar.color)}`}
            >
              {avatarInitials(avatar.name)}
            </div>
          )}
          {hasPane && (
            <span className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-surface-card bg-emerald-500" />
          )}
        </div>
        <div className="min-w-0 flex-1 pt-0.5">
          <div className="flex items-center gap-1">
            <span className="truncate text-[15px] font-semibold text-text-strong">
              {avatar.name}
            </span>
            {avatar.createdBy === "enterprise_managed" ? (
              <span className="shrink-0 rounded-full border border-[rgba(var(--theme-color-rgb,59,130,246),0.28)] px-1.5 py-0.5 text-[9px] font-medium text-text-subtle">
                企业下发
              </span>
            ) : null}
            {avatar.pinned && <Star className="h-3.5 w-3.5 shrink-0 fill-amber-400 text-amber-400" />}
          </div>
          {avatar.role && (
            <p className="mt-0.5 truncate text-xs text-text-muted">{avatar.role}</p>
          )}
        </div>
      </div>
      {avatar.description ? (
        <p className="mt-3 line-clamp-2 text-xs leading-relaxed text-text-muted">
          {avatar.description}
        </p>
      ) : null}
      {visibleTags.length > 0 ? (
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {visibleTags.map((tag) => (
            <span
              key={tag}
              className="max-w-[10rem] truncate rounded-md bg-surface-hover px-2 py-0.5 text-[11px] text-text-subtle"
              title={tag}
            >
              {tag}
            </span>
          ))}
          {hiddenTagCount > 0 ? (
            <span
              className="rounded-md bg-surface-hover px-2 py-0.5 text-[11px] text-text-faint"
              title={publicTags.slice(3).join("、")}
            >
              +{hiddenTagCount}
            </span>
          ) : null}
        </div>
      ) : null}
      <div className="mt-3 flex items-center gap-2 border-t border-border pt-3">
        <button
          type="button"
          className="flex-1 rounded-md border border-border bg-surface-panel px-3 py-2 text-xs font-medium text-text-strong transition hover:border-[rgb(var(--theme-color-rgb,59,130,246))] hover:text-[rgb(var(--theme-color-fg-rgb,59,130,246))] hover:ring-1 hover:ring-[rgba(var(--theme-color-rgb,59,130,246),0.25)]"
          onClick={(e) => {
            e.stopPropagation();
            onOpenPane();
          }}
        >
          立即对话
        </button>
        <button
          type="button"
          className="shrink-0 rounded-md border border-border p-2 text-text-faint transition hover:bg-surface-hover hover:text-text-strong"
          aria-label={`管理${avatar.name}`}
          title="管理与分享"
          onClick={(e) => {
            e.stopPropagation();
            onCardMenu(e.currentTarget.getBoundingClientRect());
          }}
        >
          <MoreHorizontal className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
