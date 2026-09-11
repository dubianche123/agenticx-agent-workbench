import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  Crown,
  FolderOpen,
  Image,
  MessageCircle,
  Pencil,
  Plus,
  Search,
  Trash2,
  UsersRound,
  X,
} from "lucide-react";
import type { Avatar, GroupChat } from "../../store";
import {
  extractUnknownAvatarIdFromError,
  getGroupSaveErrorMessage,
  sanitizeGroupAvatarIds,
} from "../../utils/group-editor-utils";
import {
  GROUP_META_MEMBER_ID,
  groupMemberCandidates,
} from "../../utils/group-meta-member";
import { GroupIdentityIcon, GroupMemberAvatar } from "./GroupMemberAvatar";
import { META_AGENT_DISPLAY_NAME } from "../../constants/branding";

type Notice = { type: "success" | "error" | "warning"; text: string };

function GroupProfileOverview({
  group,
  avatarById,
  isReadOnly,
  description,
  avatarUrl,
  workspaceDir,
  isBusy,
  avatarFileInputRef,
  avatarImageHint,
  workspaceHint,
  onDescriptionChange,
  onPickAvatarImage,
  onResetAvatar,
  onChooseWorkspace,
  onManageMembers,
  onOpenChat,
  onOpenMember,
}: {
  group: GroupChat;
  avatarById: Map<string, Avatar>;
  isReadOnly: boolean;
  description: string;
  avatarUrl: string;
  workspaceDir: string;
  isBusy: boolean;
  avatarFileInputRef: { current: HTMLInputElement | null };
  avatarImageHint: string;
  workspaceHint: string;
  onDescriptionChange: (value: string) => void;
  onPickAvatarImage: (file: File | undefined) => void;
  onResetAvatar: () => void;
  onChooseWorkspace: () => void;
  onManageMembers?: () => void;
  onOpenChat?: () => void;
  onOpenMember?: (avatarId: string) => void;
}) {
  const hostAvatarId = group.avatarIds.includes(group.hostAvatarId)
    ? group.hostAvatarId
    : group.avatarIds[0] || "";
  const host = avatarById.get(hostAvatarId);
  const hostLabel = host?.name || "首位成员";
  const members = group.avatarIds.map((id) => ({ id, avatar: avatarById.get(id) }));

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
      <section className="rounded-xl border border-border bg-surface-card px-4 py-4">
        <div className="flex items-center gap-3">
          <GroupIdentityIcon
            identity={group.portableArtifactId || group.id}
            avatarUrl={avatarUrl}
            size="xl"
            iconBg="rgb(var(--theme-color-rgb, 59, 130, 246))"
            className="shadow-[0_12px_30px_rgba(var(--theme-color-rgb,59,130,246),0.2)]"
          />
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-lg font-semibold tracking-tight text-text-strong">
              {group.name}
            </h3>
            <p className="mt-1 text-xs text-text-muted">
              {group.avatarIds.length} 位成员 · 主持人：{hostLabel}
            </p>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-2">
            {isReadOnly ? (
              <span className="inline-flex rounded-full border border-[rgba(var(--theme-color-rgb,59,130,246),0.28)] px-2 py-1 text-[10px] text-text-subtle">
                企业能力包下发 · 只读
              </span>
            ) : null}
            {onOpenChat ? (
              <button
                type="button"
                className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--ui-btn-primary-bg)] px-3 py-1.5 text-xs font-medium text-[var(--ui-btn-primary-text)] transition hover:bg-[var(--ui-btn-primary-bg-hover)]"
                onClick={onOpenChat}
                aria-label={`进入${group.name}群聊`}
              >
                <MessageCircle className="h-3.5 w-3.5" strokeWidth={1.8} aria-hidden />
                进入群聊
              </button>
            ) : null}
          </div>
        </div>
        {!isReadOnly ? (
          <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-3">
            <input
              ref={(element) => {
                avatarFileInputRef.current = element;
              }}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              className="hidden"
              disabled={isBusy}
              onChange={(event) => {
                onPickAvatarImage(event.target.files?.[0]);
                event.currentTarget.value = "";
              }}
            />
            <button
              type="button"
              className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs text-text-subtle transition hover:bg-surface-hover hover:text-text-strong disabled:opacity-40"
              disabled={isBusy}
              onClick={() => avatarFileInputRef.current?.click()}
            >
              <Image className="h-3.5 w-3.5" strokeWidth={1.8} aria-hidden />
              选择群头像
            </button>
            <button
              type="button"
              className="rounded-lg px-2.5 py-1.5 text-xs text-text-faint transition hover:bg-surface-hover hover:text-text-subtle disabled:opacity-40"
              disabled={isBusy || !avatarUrl}
              onClick={onResetAvatar}
            >
              恢复默认
            </button>
            <span className="text-[11px] text-text-faint">PNG、JPG、WebP 或 GIF，最大 1.8MB。</span>
            {avatarImageHint ? <span className="text-[11px] text-text-faint">{avatarImageHint}</span> : null}
          </div>
        ) : null}
      </section>

      <section className="mt-3 rounded-xl border border-border bg-surface-card px-4 py-3" aria-labelledby="group-profile-description">
        <h3 id="group-profile-description" className="text-xs font-semibold text-text-strong">
          群简介
        </h3>
        {isReadOnly ? (
          <p className="mt-1.5 whitespace-pre-wrap text-xs leading-relaxed text-text-muted">
            {description || "暂无群简介。"}
          </p>
        ) : (
          <textarea
            value={description}
            onChange={(event) => onDescriptionChange(event.target.value)}
            placeholder="介绍这个群聊适合处理什么事情"
            maxLength={2000}
            rows={3}
            disabled={isBusy}
            className="mt-2 w-full resize-y rounded-lg border border-border bg-surface-panel px-3 py-2.5 text-xs leading-relaxed text-text-primary outline-none transition placeholder:text-text-faint focus:border-[rgba(var(--theme-color-rgb,59,130,246),0.6)] focus:ring-2 focus:ring-[rgba(var(--theme-color-rgb,59,130,246),0.12)] disabled:opacity-60"
          />
        )}
        {!isReadOnly ? (
          <span className="mt-1 block text-right text-[10px] text-text-faint">{description.length}/2000</span>
        ) : null}
      </section>

      <section className="mt-3 rounded-xl border border-border bg-surface-card px-4 py-3.5" aria-labelledby="group-profile-members">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <UsersRound className="h-4 w-4 shrink-0 text-text-subtle" strokeWidth={1.8} aria-hidden />
            <h3 id="group-profile-members" className="text-xs font-semibold text-text-strong">
              群成员
            </h3>
            <span className="rounded-full bg-surface-panel px-1.5 py-0.5 text-[10px] tabular-nums text-text-faint">
              {members.length}
            </span>
          </div>
          {onManageMembers ? (
            <button
              type="button"
              className="shrink-0 rounded-lg px-2 py-1 text-[11px] text-text-subtle transition hover:bg-surface-hover hover:text-text-strong"
              onClick={onManageMembers}
            >
              管理成员
            </button>
          ) : (
            <span className="shrink-0 text-[10px] text-text-faint">管理员维护</span>
          )}
        </div>
        <div className="mt-3 space-y-1.5">
          {members.map(({ id, avatar }) => {
            const label = avatar?.name || "失效成员";
            const canOpenMember = Boolean(onOpenMember && avatar && id !== GROUP_META_MEMBER_ID);
            const content = (
              <>
                <GroupMemberAvatar avatar={avatar} label={label} identity={id} size="sm" />
                <span className="min-w-0 flex-1 text-left">
                  <span className="block truncate text-xs font-medium text-text-primary">{label}</span>
                  <span className="mt-0.5 block truncate text-[10px] text-text-faint">
                    {id === hostAvatarId ? "主持人" : avatar?.role || "数字专家"}
                  </span>
                </span>
                {id === hostAvatarId ? (
                  <Crown className="h-3.5 w-3.5 shrink-0 text-[rgb(var(--theme-color-fg-rgb,59,130,246))]" strokeWidth={1.8} aria-label="主持人" />
                ) : null}
              </>
            );
            return canOpenMember ? (
              <button
                key={id}
                type="button"
                className="flex w-full items-center gap-2.5 rounded-lg px-1.5 py-1.5 text-left transition hover:bg-surface-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(var(--theme-color-rgb,59,130,246),0.45)]"
                aria-label={`打开${label}专家详情`}
                onClick={() => onOpenMember?.(id)}
              >
                {content}
              </button>
            ) : (
              <div key={id} className="flex items-center gap-2.5 rounded-lg px-1.5 py-1.5">
                {content}
              </div>
            );
          })}
        </div>
      </section>

      <section className="mt-3 rounded-xl border border-border bg-surface-card px-4 py-3" aria-labelledby="group-profile-workspace">
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[rgba(var(--theme-color-rgb,59,130,246),0.12)] text-[rgb(var(--theme-color-fg-rgb,59,130,246))]">
            <FolderOpen className="h-4 w-4" strokeWidth={1.8} aria-hidden />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-3">
              <h3 id="group-profile-workspace" className="text-xs font-semibold text-text-strong">
                共享工作区
              </h3>
              {!isReadOnly ? (
                <button
                  type="button"
                  className="shrink-0 rounded-lg px-2 py-1 text-[11px] text-text-subtle transition hover:bg-surface-hover hover:text-text-strong"
                  disabled={isBusy}
                  onClick={onChooseWorkspace}
                  aria-label="选择群共享工作区"
                >
                  选择文件夹
                </button>
              ) : null}
            </div>
            <p className="mt-1.5 text-xs leading-relaxed text-text-muted">
              专家使用各自的主工作区；群共享目录作为额外挂载提供给协作。
            </p>
            <div
              className="mt-2 truncate rounded-lg border border-border bg-surface-panel px-2.5 py-2 font-mono text-[10px] text-text-subtle"
              title={workspaceDir || "群服务默认共享目录"}
            >
              {workspaceDir || "群服务默认共享目录"}
            </div>
            {!isReadOnly && workspaceHint ? (
              <p className="mt-1.5 text-[11px] text-text-faint">{workspaceHint}</p>
            ) : null}
          </div>
        </div>
      </section>
    </div>
  );
}

/**
 * Group profile and management surface.
 *
 * Existing groups open on a contact-style profile. Members are managed only
 * after an explicit management action; adding is an explicit「加入」action and
 * removing is an explicit action on that member. The group itself has a
 * separate destructive action in the footer, so deleting the group can never
 * be confused with selecting members to remove.
 */
export function GroupEditorInline({
  avatars,
  initialGroup,
  onEditMember,
  onDelete,
  onClose,
  onSaved,
  onOpenChat,
}: {
  avatars: Avatar[];
  initialGroup?: GroupChat;
  onEditMember: (avatarId: string) => void;
  onDelete?: (groupId: string) => Promise<boolean | undefined>;
  onClose: () => void;
  onSaved: () => void;
  onOpenChat?: () => void;
}) {
  const [name, setName] = useState(initialGroup?.name ?? "");
  const [selectedIds, setSelectedIds] = useState<string[]>(
    initialGroup?.avatarIds ?? [GROUP_META_MEMBER_ID],
  );
  const [hostAvatarId, setHostAvatarId] = useState(
    initialGroup?.hostAvatarId || initialGroup?.avatarIds[0] || GROUP_META_MEMBER_ID,
  );
  const [description, setDescription] = useState(initialGroup?.description ?? "");
  const [avatarUrlDraft, setAvatarUrlDraft] = useState(initialGroup?.avatarUrl ?? "");
  const [workspaceDir, setWorkspaceDir] = useState(initialGroup?.workspaceDir ?? "");
  const [memberQuery, setMemberQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [saveNotice, setSaveNotice] = useState<Notice | null>(null);
  const [avatarImageHint, setAvatarImageHint] = useState("");
  const [workspaceHint, setWorkspaceHint] = useState("");
  const [managementOpen, setManagementOpen] = useState(!initialGroup);
  const isReadOnly = initialGroup?.createdBy === "enterprise_managed";
  const avatarFileInputRef = useRef<HTMLInputElement>(null);

  const candidateAvatars = useMemo(() => groupMemberCandidates(avatars), [avatars]);
  const validAvatarIds = useMemo(
    () => candidateAvatars.map((item) => String(item.id ?? "").trim()).filter(Boolean),
    [candidateAvatars],
  );
  const avatarById = useMemo(
    () => new Map(candidateAvatars.map((avatar) => [avatar.id, avatar] as const)),
    [candidateAvatars],
  );
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const selectedMembers = useMemo(
    () => selectedIds.map((id) => ({ id, avatar: avatarById.get(id) })).filter((item) => item.avatar),
    [avatarById, selectedIds],
  );
  const availableMembers = useMemo(() => {
    const query = memberQuery.trim().toLocaleLowerCase();
    return candidateAvatars.filter((avatar) => {
      if (selectedSet.has(avatar.id)) return false;
      if (!query) return true;
      return (
        avatar.name.toLocaleLowerCase().includes(query) ||
        avatar.role.toLocaleLowerCase().includes(query) ||
        (avatar.description ?? "").toLocaleLowerCase().includes(query)
      );
    });
  }, [candidateAvatars, memberQuery, selectedSet]);

  useEffect(() => {
    if (validAvatarIds.length === 0) return;
    const normalized = sanitizeGroupAvatarIds({
      requestedIds: selectedIds,
      validAvatarIds,
    });
    if (normalized.removedIds.length === 0) return;
    setSelectedIds(normalized.avatarIds);
    if (!normalized.avatarIds.includes(hostAvatarId)) {
      setHostAvatarId(normalized.avatarIds[0] || "");
    }
    setSaveNotice({
      type: "warning",
      text: `已隐藏 ${normalized.removedIds.length} 个失效成员，请保存后同步群聊。`,
    });
  }, [hostAvatarId, selectedIds, validAvatarIds]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !loading && !deleting) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [deleting, loading, onClose]);

  const addMember = (id: string) => {
    setSaveNotice(null);
    if (selectedIds.includes(id)) return;
    if (selectedIds.length === 0) setHostAvatarId(id);
    setSelectedIds([...selectedIds, id]);
  };

  const removeMember = (id: string) => {
    setSaveNotice(null);
    const next = selectedIds.filter((item) => item !== id);
    if (id === hostAvatarId || !next.includes(hostAvatarId)) {
      setHostAvatarId(next[0] || "");
    }
    setSelectedIds(next);
  };

  const handlePickAvatarImage = (file: File | undefined) => {
    if (!file) return;
    const maxBytes = 1.8 * 1024 * 1024;
    if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.type)) {
      setAvatarImageHint("请选择图片文件（PNG/JPG/WebP/GIF）。");
      return;
    }
    if (file.size > maxBytes) {
      setAvatarImageHint("图片过大，请选择小于 1.8MB 的文件。");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      if (!result) {
        setAvatarImageHint("读取图片失败，请重试。");
        return;
      }
      setAvatarUrlDraft(result);
      setAvatarImageHint("已选择图片，请点击“保存群聊设置”。");
      setSaveNotice(null);
    };
    reader.onerror = () => setAvatarImageHint("读取图片失败，请重试。");
    reader.readAsDataURL(file);
  };

  const handleChooseWorkspace = async () => {
    if (isReadOnly) {
      setWorkspaceHint("企业托管群聊为只读配置，不能更换共享工作区。");
      return;
    }
    const picker = window.agenticxDesktop.chooseDirectory;
    if (typeof picker !== "function") {
      setWorkspaceHint("当前桌面版本不支持选择文件夹。");
      return;
    }
    try {
      const result = await picker();
      if (result?.ok && result.path) {
        setWorkspaceDir(result.path);
        setWorkspaceHint("已选择新的共享工作区，请点击“保存群聊设置”。");
        setSaveNotice(null);
      } else if (!result?.canceled && result?.error) {
        setWorkspaceHint(`选择失败：${result.error}`);
      }
    } catch (error) {
      setWorkspaceHint(`选择失败：${String(error)}`);
    }
  };

  const handleSave = async () => {
    if (loading || deleting || isReadOnly) return;
    if (validAvatarIds.length === 0) {
      setSaveNotice({ type: "error", text: "数字专家列表尚未加载完成，请稍后再保存。" });
      return;
    }

    const normalized = sanitizeGroupAvatarIds({
      requestedIds: selectedIds,
      validAvatarIds,
    });
    if (normalized.removedIds.length > 0) setSelectedIds(normalized.avatarIds);
    if (!name.trim()) {
      setSaveNotice({ type: "error", text: "请先填写群聊名称。" });
      return;
    }
    if (normalized.avatarIds.length === 0) {
      setSaveNotice({ type: "error", text: "请至少加入 1 位成员后再保存。" });
      return;
    }
    const normalizedHostAvatarId = normalized.avatarIds.includes(hostAvatarId)
      ? hostAvatarId
      : normalized.avatarIds[0];
    if (!normalizedHostAvatarId) {
      setSaveNotice({ type: "error", text: "请选择 1 位群成员担任主持人。" });
      return;
    }
    if (normalizedHostAvatarId !== hostAvatarId) setHostAvatarId(normalizedHostAvatarId);

    setLoading(true);
    setSaveNotice(null);
    const routing = initialGroup?.routing?.trim() || "intelligent";
    try {
      const result = initialGroup
        ? await window.agenticxDesktop.updateGroup({
            id: initialGroup.id,
            name: name.trim(),
            avatar_ids: normalized.avatarIds,
            description: description.trim(),
            avatar_url: avatarUrlDraft.trim(),
            ...(workspaceDir.trim() ? { workspace_dir: workspaceDir.trim() } : {}),
            routing,
            host_avatar_id: normalizedHostAvatarId,
          })
        : await window.agenticxDesktop.createGroup({
            name: name.trim(),
            avatar_ids: normalized.avatarIds,
            description: description.trim(),
            avatar_url: avatarUrlDraft.trim(),
            ...(workspaceDir.trim() ? { workspace_dir: workspaceDir.trim() } : {}),
            routing: "intelligent",
            host_avatar_id: normalizedHostAvatarId,
          });

      if (result.ok) {
        setSaveNotice({ type: "success", text: initialGroup ? "群聊设置已保存。" : "群聊已创建。" });
        onSaved();
        return;
      }

      const staleId = extractUnknownAvatarIdFromError(result.error);
      if (staleId) removeMember(staleId);
      setSaveNotice({ type: "error", text: getGroupSaveErrorMessage(result.error) });
    } catch (error) {
      setSaveNotice({
        type: "error",
        text: error instanceof Error ? error.message : "保存失败，请稍后重试。",
      });
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async () => {
    if (isReadOnly || !initialGroup || !onDelete || loading || deleting) return;
    setDeleting(true);
    setSaveNotice(null);
    try {
      const result = await onDelete(initialGroup.id);
      if (result === false) {
        setSaveNotice({ type: "error", text: "删除群聊失败，请稍后重试。" });
      }
    } catch (error) {
      setSaveNotice({
        type: "error",
        text: error instanceof Error ? error.message : "删除群聊失败，请稍后重试。",
      });
    } finally {
      setDeleting(false);
    }
  };

  const isBusy = loading || deleting;
  const title = initialGroup ? (isReadOnly ? "群聊详情（只读）" : "群聊设置") : "新建群聊";
  const isProfileView = Boolean(initialGroup && !managementOpen);
  const visibleTitle = isProfileView ? "群资料" : title;

  return (
    <div
      className="fixed inset-0 z-modal flex items-center justify-center bg-black/65 p-4 backdrop-blur-[2px]"
      onClick={(event) => {
        if (event.target === event.currentTarget && !isBusy) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="group-editor-title"
        className="flex max-h-[min(760px,calc(100vh-2rem))] w-[min(860px,calc(100vw-2rem))] flex-col overflow-hidden rounded-2xl border border-border bg-surface-panel shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex shrink-0 items-center gap-3 border-b border-border px-5 py-4">
          {initialGroup && managementOpen ? (
            <button
              type="button"
              className="inline-flex shrink-0 items-center gap-1 rounded-lg px-2 py-1.5 text-xs text-text-subtle transition hover:bg-surface-hover hover:text-text-strong"
              aria-label="返回群资料"
              title="返回群资料"
              disabled={isBusy}
              onClick={() => setManagementOpen(false)}
            >
              <ArrowLeft className="h-3.5 w-3.5" strokeWidth={1.8} aria-hidden />
              <span className="hidden sm:inline">群资料</span>
            </button>
          ) : null}
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-[rgba(var(--theme-color-rgb,59,130,246),0.14)] text-[rgb(var(--theme-color-fg-rgb,59,130,246))]">
            <UsersRound className="h-5 w-5" strokeWidth={1.8} aria-hidden />
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="group-editor-title" className="text-base font-semibold text-text-strong">
              {visibleTitle}
            </h2>
            <p className="mt-0.5 text-xs text-text-faint">
              {isProfileView
                ? isReadOnly
                  ? "企业能力包下发的托管群聊，群资料由管理员维护"
                  : "持久群聊资料与共享工作区"
                : initialGroup
                ? isReadOnly
                  ? "这是企业能力包下发的托管群聊，不能直接修改；内容由管理员管理"
                  : "调整群聊名称和成员组成"
                : `${META_AGENT_DISPLAY_NAME}默认加入并主持，你可以随时更换或移出`}
            </p>
          </div>
          <button
            type="button"
            className="agx-topbar-btn agx-topbar-btn--icon-only shrink-0"
            aria-label={isProfileView ? "关闭群聊资料" : "关闭群聊设置"}
            title="关闭"
            disabled={isBusy}
            onClick={onClose}
          >
            <X className="h-4 w-4" strokeWidth={2} />
          </button>
        </header>

        {isProfileView ? (
          initialGroup ? (
            <GroupProfileOverview
              group={initialGroup}
              avatarById={avatarById}
              isReadOnly={isReadOnly}
              description={description}
              avatarUrl={avatarUrlDraft}
              workspaceDir={workspaceDir}
              isBusy={isBusy}
              avatarFileInputRef={avatarFileInputRef}
              avatarImageHint={avatarImageHint}
              workspaceHint={workspaceHint}
              onDescriptionChange={(value) => {
                setDescription(value);
                setSaveNotice(null);
              }}
              onPickAvatarImage={handlePickAvatarImage}
              onResetAvatar={() => {
                setAvatarUrlDraft("");
                setAvatarImageHint("已恢复默认群头像，请点击“保存群聊设置”。");
                setSaveNotice(null);
              }}
              onChooseWorkspace={() => void handleChooseWorkspace()}
              onManageMembers={isReadOnly ? undefined : () => setManagementOpen(true)}
              onOpenChat={onOpenChat}
              onOpenMember={onEditMember}
            />
          ) : null
        ) : (
        <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto md:grid-cols-[minmax(0,1.12fr)_minmax(260px,0.88fr)] md:overflow-hidden">
          <section className="min-h-0 overflow-y-auto px-5 py-5 md:border-r md:border-border">
            {isReadOnly ? (
              <div className="mb-4 rounded-xl border border-[rgba(var(--theme-color-rgb,59,130,246),0.28)] bg-[rgba(var(--theme-color-rgb,59,130,246),0.08)] px-3 py-2.5 text-xs leading-relaxed text-text-subtle" role="status">
                托管群聊只允许查看；如需定制，请导出并导入为个人副本。
              </div>
            ) : null}
            {!initialGroup ? (
            <section className="mb-5 rounded-xl border border-border bg-surface-card p-3.5" aria-labelledby="group-profile-fields">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h3 id="group-profile-fields" className="text-sm font-semibold text-text-strong">群资料</h3>
                  <p className="mt-1 text-xs text-text-faint">头像和群简介会显示在群资料与群聊入口。</p>
                </div>
                <Image className="h-4 w-4 text-text-faint" strokeWidth={1.8} aria-hidden />
              </div>
              <div className="mt-3 flex items-center gap-3">
                <GroupIdentityIcon
                  identity="new-group"
                  avatarUrl={avatarUrlDraft}
                  iconBg="rgb(var(--theme-color-rgb, 59, 130, 246))"
                  size="lg"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      ref={avatarFileInputRef}
                      type="file"
                      accept="image/png,image/jpeg,image/webp,image/gif"
                      className="hidden"
                      disabled={isBusy || isReadOnly}
                      onChange={(event) => {
                        handlePickAvatarImage(event.target.files?.[0]);
                        event.currentTarget.value = "";
                      }}
                    />
                    <button
                      type="button"
                      className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs text-text-subtle transition hover:bg-surface-hover hover:text-text-strong disabled:opacity-40"
                      disabled={isBusy || isReadOnly}
                      onClick={() => avatarFileInputRef.current?.click()}
                    >
                      <Image className="h-3.5 w-3.5" strokeWidth={1.8} aria-hidden />
                      选择群头像
                    </button>
                    <button
                      type="button"
                      className="rounded-lg px-2.5 py-1.5 text-xs text-text-faint transition hover:bg-surface-hover hover:text-text-subtle disabled:opacity-40"
                      disabled={isBusy || isReadOnly || !avatarUrlDraft}
                      onClick={() => {
                        setAvatarUrlDraft("");
                        setAvatarImageHint("已恢复默认群头像，请点击“保存群聊设置”。");
                      }}
                    >
                      恢复默认
                    </button>
                  </div>
                  <p className="mt-1.5 text-[11px] text-text-faint">PNG、JPG、WebP 或 GIF，最大 1.8MB。</p>
                  {avatarImageHint ? <p className="mt-1 text-[11px] text-text-faint">{avatarImageHint}</p> : null}
                </div>
              </div>
              <label className="mt-4 block">
                <span className="mb-1.5 block text-xs font-medium text-text-subtle">群简介</span>
                <textarea
                  value={description}
                  onChange={(event) => {
                    setDescription(event.target.value);
                    setSaveNotice(null);
                  }}
                  placeholder="介绍这个群聊适合处理什么事情"
                  maxLength={2000}
                  rows={3}
                  disabled={isBusy || isReadOnly}
                  className="w-full resize-y rounded-lg border border-border bg-surface-panel px-3 py-2.5 text-xs leading-relaxed text-text-primary outline-none transition placeholder:text-text-faint focus:border-[rgba(var(--theme-color-rgb,59,130,246),0.6)] focus:ring-2 focus:ring-[rgba(var(--theme-color-rgb,59,130,246),0.12)] disabled:opacity-60"
                />
                <span className="mt-1 block text-right text-[10px] text-text-faint">{description.length}/2000</span>
              </label>
              <div className="mt-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <span className="block text-xs font-medium text-text-subtle">群共享工作区</span>
                    <span className="mt-1 block text-[11px] text-text-faint">作为所有成员的额外挂载目录。</span>
                  </div>
                  <button
                    type="button"
                    className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs text-text-subtle transition hover:bg-surface-hover hover:text-text-strong disabled:opacity-40"
                    disabled={isBusy || isReadOnly}
                    onClick={() => void handleChooseWorkspace()}
                  >
                    <FolderOpen className="h-3.5 w-3.5" strokeWidth={1.8} aria-hidden />
                    选择文件夹
                  </button>
                </div>
                <div className="mt-2 truncate rounded-lg border border-border bg-surface-panel px-2.5 py-2 font-mono text-[10px] text-text-subtle" title={workspaceDir}>
                  {workspaceDir || "创建后使用群聊默认共享目录"}
                </div>
                {workspaceHint ? <p className="mt-1.5 text-[11px] text-text-faint">{workspaceHint}</p> : null}
              </div>
            </section>
            ) : null}

            <label className="block">
              <span className="mb-2 block text-xs font-medium text-text-subtle">群聊名称</span>
              <input
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  setSaveNotice(null);
                }}
                placeholder="例如：产品需求全流程"
                autoFocus
                disabled={isBusy || isReadOnly}
                className="w-full rounded-xl border border-border bg-surface-card px-3.5 py-3 text-[15px] text-text-primary outline-none transition placeholder:text-text-faint focus:border-[rgba(var(--theme-color-rgb,59,130,246),0.6)] focus:ring-2 focus:ring-[rgba(var(--theme-color-rgb,59,130,246),0.12)] disabled:opacity-60"
              />
            </label>

            <div className="mt-6 flex items-end justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-semibold text-text-strong">群成员</h3>
                  <span className="rounded-full bg-surface-card px-2 py-0.5 text-[11px] tabular-nums text-text-subtle">
                    {selectedMembers.length}
                  </span>
                </div>
                <p className="mt-1 text-xs leading-relaxed text-text-faint">
                  选择 1 位成员担任主持人；直接发消息或 @主持人都会由这位成员先回应。
                </p>
              </div>
            </div>

            <div className="mt-3 space-y-2">
              {selectedMembers.length === 0 ? (
                <div className="flex min-h-36 flex-col items-center justify-center rounded-xl border border-dashed border-border bg-surface-card/45 px-4 text-center">
                  <UsersRound className="h-7 w-7 text-text-faint" strokeWidth={1.5} aria-hidden />
                  <p className="mt-2 text-sm text-text-muted">还没有群成员</p>
                  <p className="mt-1 text-xs text-text-faint">从右侧选择数字专家加入群聊</p>
                </div>
              ) : (
                selectedIds.map((id) => {
                  const avatar = avatarById.get(id);
                  const label = avatar?.name || "失效成员";
                  return (
                    <div
                      key={id}
                      className="flex items-center gap-3 rounded-xl border border-border bg-surface-card px-3 py-2.5 transition hover:border-border-strong"
                    >
                      <GroupMemberAvatar avatar={avatar} label={label} size="md" />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium text-text-primary">{label}</div>
                        <div className="mt-0.5 truncate text-xs text-text-faint">
                          {avatar?.role || (avatar ? "数字专家" : "该成员已不存在")}
                        </div>
                      </div>
                      <div className="grid shrink-0 grid-cols-[2.25rem_6.75rem_2.25rem] items-center gap-1 sm:grid-cols-[5rem_7.25rem_5rem]">
                        {id !== GROUP_META_MEMBER_ID && !isReadOnly ? (
                          <button
                            type="button"
                            disabled={isBusy || isReadOnly || !avatar}
                            className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-xs text-text-faint transition hover:bg-surface-hover hover:text-text-strong disabled:opacity-40"
                            aria-label={`编辑成员 ${label}`}
                            title={`编辑 ${label}`}
                            onClick={() => onEditMember(id)}
                          >
                            <Pencil className="h-3.5 w-3.5" strokeWidth={1.8} aria-hidden />
                            <span className="hidden sm:inline">编辑</span>
                          </button>
                        ) : (
                          <span aria-hidden className="h-8 w-full" />
                        )}
                        <label
                          className={`inline-flex w-full cursor-pointer items-center justify-center gap-1.5 rounded-lg border px-2 py-1.5 text-xs transition ${
                            hostAvatarId === id
                              ? "border-[rgba(var(--theme-color-rgb,59,130,246),0.45)] bg-[rgba(var(--theme-color-rgb,59,130,246),0.12)] text-[rgb(var(--theme-color-fg-rgb,59,130,246))]"
                              : "border-border text-text-faint hover:border-border-strong hover:text-text-subtle"
                          }`}
                          title={`设 ${label} 为主持人`}
                        >
                          <input
                            type="radio"
                            name="group-host"
                            value={id}
                            checked={hostAvatarId === id}
                            disabled={isBusy || isReadOnly || !avatar}
                            onChange={() => {
                              setHostAvatarId(id);
                              setSaveNotice(null);
                            }}
                            className="h-3.5 w-3.5 accent-[rgb(var(--theme-color-rgb,59,130,246))]"
                          />
                          <Crown className="h-3.5 w-3.5" strokeWidth={1.8} aria-hidden />
                          主持人
                        </label>
                        <button
                          type="button"
                          disabled={isBusy || isReadOnly}
                          className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-xs text-text-faint transition hover:bg-rose-500/10 hover:text-rose-400 disabled:opacity-40"
                          aria-label={`移出成员 ${label}`}
                          title={`移出 ${label}`}
                          onClick={() => removeMember(id)}
                        >
                          <Trash2 className="h-3.5 w-3.5" strokeWidth={1.8} aria-hidden />
                          <span className="hidden sm:inline">移出</span>
                        </button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            {saveNotice ? (
              <div
                role={saveNotice.type === "error" ? "alert" : "status"}
                className={`mt-4 rounded-xl border px-3 py-2.5 text-xs leading-relaxed ${
                  saveNotice.type === "success"
                    ? "border-emerald-500/35 bg-emerald-500/10 text-emerald-300"
                    : saveNotice.type === "warning"
                      ? "border-amber-500/35 bg-amber-500/10 text-amber-300"
                      : "border-rose-500/35 bg-rose-500/10 text-rose-300"
                }`}
              >
                {saveNotice.text}
              </div>
            ) : null}
          </section>

          <aside className="min-h-0 bg-surface-card/35 px-5 py-5 md:overflow-y-auto">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-text-strong">{isReadOnly ? "群成员" : "添加成员"}</h3>
                <p className="mt-1 text-xs leading-relaxed text-text-faint">
                  {isReadOnly ? "托管群聊成员由管理员统一维护。" : "点击「加入」即可加入当前群聊。"}
                </p>
              </div>
              {!isReadOnly ? <Plus className="mt-0.5 h-4 w-4 text-text-faint" strokeWidth={1.8} aria-hidden /> : null}
            </div>
            <label className="relative mt-4 block">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-faint" strokeWidth={1.8} aria-hidden />
              <input
                type="search"
                value={memberQuery}
                onChange={(event) => setMemberQuery(event.target.value)}
                placeholder="搜索名称或职责"
                disabled={isBusy || isReadOnly}
                className="w-full rounded-lg border border-border bg-surface-panel py-2 pl-9 pr-3 text-xs text-text-primary outline-none placeholder:text-text-faint focus:border-border-strong disabled:opacity-60"
              />
            </label>

            {isReadOnly ? (
              <div className="mt-4 rounded-xl border border-dashed border-border px-3 py-8 text-center text-xs leading-relaxed text-text-faint">
                成员变更由管理员通过能力包统一下发。
              </div>
            ) : (
              <div className="mt-3 space-y-1.5">
                {validAvatarIds.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-border px-3 py-8 text-center text-xs leading-relaxed text-text-faint">
                    数字专家列表尚未加载完成
                  </div>
                ) : availableMembers.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-border px-3 py-8 text-center text-xs leading-relaxed text-text-faint">
                    {memberQuery.trim() ? "没有匹配的可加入成员" : "所有数字专家都已加入"}
                  </div>
                ) : (
                  availableMembers.map((avatar) => (
                    <div
                      key={avatar.id}
                      className="flex items-center gap-2.5 rounded-xl border border-transparent px-2 py-2 transition hover:border-border hover:bg-surface-panel"
                    >
                      <GroupMemberAvatar avatar={avatar} size="sm" />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-xs font-medium text-text-primary">{avatar.name}</div>
                        <div className="mt-0.5 truncate text-[11px] text-text-faint">{avatar.role || "数字专家"}</div>
                      </div>
                      <button
                        type="button"
                        disabled={isBusy || isReadOnly}
                        className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-[rgba(var(--theme-color-rgb,59,130,246),0.12)] px-2 py-1.5 text-[11px] font-medium text-[rgb(var(--theme-color-fg-rgb,59,130,246))] transition hover:bg-[rgba(var(--theme-color-rgb,59,130,246),0.2)] disabled:opacity-40"
                        onClick={() => addMember(avatar.id)}
                      >
                        <Plus className="h-3 w-3" strokeWidth={2} aria-hidden />
                        加入
                      </button>
                    </div>
                  ))
                )}
              </div>
            )}
          </aside>
        </div>
        )}

        {isProfileView ? (
          <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-border px-5 py-3.5">
            <div className="min-w-0 flex-1">
              {saveNotice ? (
                <div
                  role={saveNotice.type === "error" ? "alert" : "status"}
                  className={`rounded-xl border px-3 py-2 text-xs leading-relaxed ${
                    saveNotice.type === "success"
                      ? "border-emerald-500/35 bg-emerald-500/10 text-emerald-300"
                      : saveNotice.type === "warning"
                        ? "border-amber-500/35 bg-amber-500/10 text-amber-300"
                        : "border-rose-500/35 bg-rose-500/10 text-rose-300"
                  }`}
                >
                  {saveNotice.text}
                </div>
              ) : (
                <span className="hidden text-xs text-text-faint sm:inline">
                  {isReadOnly ? "企业能力包下发 · 由管理员管理" : "可直接编辑群头像、群简介和共享工作区"}
                </span>
              )}
            </div>
            <div className="ml-auto flex items-center gap-2">
              <button
                type="button"
                className="rounded-lg px-3.5 py-2 text-xs text-text-subtle transition hover:bg-surface-hover hover:text-text-strong"
                onClick={onClose}
              >
                关闭
              </button>
              {!isReadOnly ? (
                <button
                  type="button"
                  disabled={isBusy || !name.trim() || selectedIds.length === 0 || !selectedIds.includes(hostAvatarId)}
                  className="rounded-lg bg-[var(--ui-btn-primary-bg)] px-4 py-2 text-xs font-medium text-[var(--ui-btn-primary-text)] transition hover:bg-[var(--ui-btn-primary-bg-hover)] disabled:cursor-not-allowed disabled:opacity-40"
                  onClick={() => void handleSave()}
                >
                  {loading ? "保存中…" : "保存群聊设置"}
                </button>
              ) : null}
            </div>
          </footer>
        ) : (
        <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-border px-5 py-3.5">
          <div className="min-w-0">
            {initialGroup && onDelete && !isReadOnly ? (
              <button
                type="button"
                disabled={isBusy}
                className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs text-rose-400 transition hover:bg-rose-500/10 disabled:opacity-40"
                onClick={() => void handleDelete()}
              >
                <Trash2 className="h-3.5 w-3.5" strokeWidth={1.8} aria-hidden />
                {deleting ? "删除中…" : "删除群聊"}
              </button>
            ) : (
              <span className="hidden text-xs text-text-faint sm:inline">
                {isReadOnly ? "企业能力包下发 · 由管理员管理" : "群聊创建后可继续调整成员"}
              </span>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              disabled={isBusy}
              className="rounded-lg px-3.5 py-2 text-xs text-text-subtle transition hover:bg-surface-hover hover:text-text-strong disabled:opacity-40"
              onClick={onClose}
            >
              {isReadOnly ? "关闭" : "取消"}
            </button>
            {!isReadOnly ? (
              <button
                type="button"
                disabled={isBusy || !name.trim() || selectedIds.length === 0 || !selectedIds.includes(hostAvatarId)}
                className="rounded-lg bg-[var(--ui-btn-primary-bg)] px-4 py-2 text-xs font-medium text-[var(--ui-btn-primary-text)] transition hover:bg-[var(--ui-btn-primary-bg-hover)] disabled:cursor-not-allowed disabled:opacity-40"
                onClick={() => void handleSave()}
              >
                {loading ? "保存中…" : initialGroup ? "保存更改" : "创建群聊"}
              </button>
            ) : null}
          </div>
        </footer>
        )}
      </div>
    </div>
  );
}
