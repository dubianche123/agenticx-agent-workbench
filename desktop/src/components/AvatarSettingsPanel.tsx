import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Save, RotateCcw, X } from "lucide-react";
import type { Avatar } from "../store";
import {
  AVATAR_COLOR_LABEL,
  AVATAR_COLOR_SWATCH,
  AVATAR_PALETTE,
  normalizeAvatarColor,
} from "../utils/avatar-color";
import type { AvatarPaletteKey } from "../utils/avatar-color";
import { DefaultModelSelect } from "./DefaultModelSelect";
import { GroupMemberAvatar } from "./groups/GroupMemberAvatar";
import { LOCAL_KNOWLEDGE_ENABLED } from "../constants/desktop-feature-visibility";
import {
  normalizeRunMode,
  RUN_MODE_OPTIONS,
  type RunMode,
} from "../constants/confirm-strategy-options";
import { META_AGENT_DISPLAY_NAME } from "../constants/branding";

type SkillItem = {
  name: string;
  description: string;
  globally_disabled?: boolean;
};

/** 与全局技能列表一致：绿轨 + 白钮 */
function SettingsSwitch({
  checked,
  disabled,
  onChange,
  "aria-label": ariaLabel,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
  "aria-label"?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => {
        if (!disabled) onChange(!checked);
      }}
      className={`relative h-5 w-9 shrink-0 rounded-full transition focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(var(--theme-color-rgb,16,185,129),0.55)] disabled:opacity-40 ${
        checked ? "bg-[rgb(var(--theme-color-rgb,16,185,129))]" : "bg-surface-hover"
      }`}
    >
      <span
        className={`pointer-events-none absolute left-0.5 top-0.5 h-4 w-4 rounded-full shadow-sm transition-transform ${
          checked ? "bg-[var(--theme-color-text)]" : "bg-white"
        } ${checked ? "translate-x-4" : "translate-x-0"}`}
      />
    </button>
  );
}

type ToolItem = {
  id: string;
  name: string;
  description: string;
};

const DEFAULT_TOOLS: ToolItem[] = [
  { id: "liteparse", name: "LiteParse", description: "轻量 PDF/Office 文档解析" },
  { id: "mineru", name: "MinerU", description: "深度文档解析" },
  { id: "libreoffice", name: "LibreOffice", description: "Office 格式转换依赖" },
  { id: "imagemagick", name: "ImageMagick", description: "图像转换依赖" },
];

type Tab = "general" | "runtime" | "tools" | "skills" | "soul";

type CoreMemoryDocuments = {
  "IDENTITY.md": string;
  "SOUL.md": string;
  "MEMORY.md": string;
};

const EMPTY_CORE_MEMORY: CoreMemoryDocuments = {
  "IDENTITY.md": "",
  "SOUL.md": "",
  "MEMORY.md": "",
};

type CoreMemoryFilename = keyof CoreMemoryDocuments;

function parseTagInput(value: string): string[] {
  return value
    .split(/[,，]/)
    .map((tag) => tag.trim())
    .filter(Boolean)
    .slice(0, 8);
}

function summarizeMarkdown(value: string, readOnly = false): string {
  const summary = value.replace(/\s+/g, " ").trim();
  if (!summary) return readOnly ? "暂无内容。" : "暂未填写，点击“编辑”补充。";
  return summary.length > 180 ? `${summary.slice(0, 180)}…` : summary;
}

type Props =
  | { mode: "avatar"; avatar: Avatar; onClose: () => void; onSaved: () => void }
  | { mode: "machi"; onClose: () => void; onSaved: () => void };

export function AvatarSettingsPanel(props: Props) {
  const { mode, onClose, onSaved } = props;
  const avatar = mode === "avatar" ? (props as { avatar: Avatar }).avatar : null;
  const avatarId = avatar?.id ?? null;
  const isManagedAvatar = mode === "avatar" && avatar?.createdBy === "enterprise_managed";

  const [tab, setTab] = useState<Tab>("general");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [overviewEditing, setOverviewEditing] = useState(false);
  const [openCoreMemoryDocuments, setOpenCoreMemoryDocuments] = useState<
    Partial<Record<CoreMemoryFilename, boolean>>
  >({});

  // Expert profile fields (avatar only)
  const [name, setName] = useState(avatar?.name ?? "");
  const [role, setRole] = useState(avatar?.role ?? "");
  const [systemPrompt, setSystemPrompt] = useState(avatar?.systemPrompt ?? "");
  const [blurb, setBlurb] = useState(avatar?.description ?? "");
  const [tagsInput, setTagsInput] = useState((avatar?.tags ?? []).join(", "));
  const [avatarUrlDraft, setAvatarUrlDraft] = useState(avatar?.avatarUrl ?? "");
  const [avatarImageHint, setAvatarImageHint] = useState("");
  const [defaultProvider, setDefaultProvider] = useState(avatar?.defaultProvider ?? "");
  const [defaultModel, setDefaultModel] = useState(avatar?.defaultModel ?? "");
  const [defaultPermissionMode, setDefaultPermissionMode] = useState<RunMode>(() =>
    normalizeRunMode(avatar?.defaultPermissionMode),
  );
  const [colorDraft, setColorDraft] = useState<AvatarPaletteKey>(() => normalizeAvatarColor(avatar?.color) || "blue");
  const [workspaceDir, setWorkspaceDir] = useState(avatar?.workspaceDir ?? "");
  const [workspaceDirHint, setWorkspaceDirHint] = useState("");

  // Tools
  const [tools, setTools] = useState<ToolItem[]>(DEFAULT_TOOLS);
  const [toolsEnabled, setToolsEnabled] = useState<Record<string, boolean>>({});
  const [loadingTools, setLoadingTools] = useState(false);

  // Per-avatar skills (only `false` entries are persisted to avatar.yaml skills_enabled)
  const [skillsItems, setSkillsItems] = useState<SkillItem[]>([]);
  const [loadingSkills, setLoadingSkills] = useState(false);
  const [skillsEnabledDraft, setSkillsEnabledDraft] = useState<Record<string, boolean>>({});

  const [brainsMountMode, setBrainsMountMode] = useState<"default" | "all" | "custom">("default");
  const [brainsCustomIds, setBrainsCustomIds] = useState<string[]>([]);
  const [brainsCatalog, setBrainsCatalog] = useState<{ id: string; name: string; type: string }[]>([]);

  // SOUL
  const [soulValue, setSoulValue] = useState("");
  const [loadingSoul, setLoadingSoul] = useState(false);
  const [coreMemory, setCoreMemory] = useState<CoreMemoryDocuments>(EMPTY_CORE_MEMORY);
  const [loadingCoreMemory, setLoadingCoreMemory] = useState(false);
  const coreMemoryRequestRef = useRef(0);

  const title = mode === "avatar" ? `${avatar?.name ?? "数字专家"} · 专家资料` : `${META_AGENT_DISPLAY_NAME} · 专家资料`;

  const loadTools = useCallback(async () => {
    setLoadingTools(true);
    try {
      const result = await window.agenticxDesktop.getToolsStatus();
      if (result?.ok && Array.isArray(result.tools) && result.tools.length > 0) {
        setTools(
          result.tools.map((item) => ({
            id: String(item.id),
            name: String(item.name),
            description: String(item.description || ""),
          })),
        );
      }
    } finally {
      setLoadingTools(false);
    }
  }, []);

  const loadSoul = useCallback(async () => {
    setLoadingSoul(true);
    try {
      if (mode === "avatar" && avatarId) {
        const res = await window.agenticxDesktop.loadAvatarSoul({ avatarId });
        setSoulValue(res?.ok ? String(res.content ?? "") : "");
      } else {
        const res = await window.agenticxDesktop.loadMetaSoul();
        setSoulValue(res?.ok ? String(res.content ?? "") : "");
      }
    } finally {
      setLoadingSoul(false);
    }
  }, [mode, avatarId]);

  const loadCoreMemory = useCallback(async () => {
    if (mode !== "avatar" || !avatarId) return;
    const requestId = ++coreMemoryRequestRef.current;
    setLoadingCoreMemory(true);
    try {
      const loader = window.agenticxDesktop.loadAvatarCoreMemory;
      if (typeof loader !== "function") {
        if (requestId !== coreMemoryRequestRef.current) return;
        setCoreMemory(EMPTY_CORE_MEMORY);
        setMessage("核心记忆加载失败: 当前桌面版本不支持核心记忆");
        return;
      }
      const result = await loader({ avatarId });
      if (requestId !== coreMemoryRequestRef.current) return;
      const documents = result?.documents;
      if (result?.ok && documents && typeof documents === "object") {
        setCoreMemory({
          "IDENTITY.md": String(documents["IDENTITY.md"] ?? ""),
          "SOUL.md": String(documents["SOUL.md"] ?? ""),
          "MEMORY.md": String(documents["MEMORY.md"] ?? ""),
        });
      } else {
        setCoreMemory(EMPTY_CORE_MEMORY);
        setMessage(`核心记忆加载失败: ${result?.error ?? "未知错误"}`);
      }
    } catch (err) {
      if (requestId === coreMemoryRequestRef.current) {
        setCoreMemory(EMPTY_CORE_MEMORY);
        setMessage(`核心记忆加载失败: ${String(err)}`);
      }
    } finally {
      if (requestId === coreMemoryRequestRef.current) setLoadingCoreMemory(false);
    }
  }, [mode, avatarId]);

  useEffect(() => {
    let cancelled = false;
    if (mode === "avatar" && avatar) {
      setOverviewEditing(false);
      setOpenCoreMemoryDocuments({});
      setName(avatar.name ?? "");
      setRole(avatar.role ?? "");
      setSystemPrompt(avatar.systemPrompt ?? "");
      setBlurb(avatar.description ?? "");
      setTagsInput((avatar.tags ?? []).join(", "));
      setAvatarUrlDraft(avatar.avatarUrl ?? "");
      setAvatarImageHint("");
      setToolsEnabled({ ...(avatar.toolsEnabled ?? {}) });
      setDefaultProvider(avatar.defaultProvider ?? "");
      setDefaultModel(avatar.defaultModel ?? "");
      setDefaultPermissionMode(normalizeRunMode(avatar.defaultPermissionMode));
      setColorDraft(normalizeAvatarColor(avatar.color) || "blue");
      setWorkspaceDir(avatar.workspaceDir ?? "");
      setWorkspaceDirHint("");
      setCoreMemory(EMPTY_CORE_MEMORY);
      setMessage("");
      const raw = avatar.skillsEnabled;
      setSkillsEnabledDraft(
        raw && typeof raw === "object"
          ? Object.fromEntries(Object.entries(raw).filter(([, v]) => v === false))
          : {},
      );
      const be = avatar.brainsEnabled;
      if (be === "*") {
        setBrainsMountMode("all");
        setBrainsCustomIds([]);
      } else if (Array.isArray(be) && be.length > 0) {
        setBrainsMountMode("custom");
        setBrainsCustomIds([...be]);
      } else {
        setBrainsMountMode("default");
        setBrainsCustomIds([]);
      }
    } else {
      setOverviewEditing(false);
      setOpenCoreMemoryDocuments({});
      void (async () => {
        const policy = await window.agenticxDesktop.getToolsPolicy();
        setToolsEnabled(policy?.ok ? policy.tools_enabled ?? {} : {});
      })();
      setSkillsEnabledDraft({});
    }
    void loadTools();
    if (mode === "avatar" && avatar) {
      void loadCoreMemory();
    } else {
      void loadSoul();
    }
    if (mode === "avatar" && LOCAL_KNOWLEDGE_ENABLED) {
      void (async () => {
        try {
          const base = String((await window.agenticxDesktop.getApiBase()) || "").replace(/\/+$/, "");
          const res = await fetch(`${base}/api/brains`);
          const body = (await res.json()) as {
            brains?: { id: string; name: string; type: string; scope: string; owner_avatar_id?: string }[];
          };
          const list = (body.brains ?? []).filter(
            (b) => b.scope === "global" || b.owner_avatar_id === avatar?.id,
          );
          if (!cancelled) setBrainsCatalog(list.map((b) => ({ id: b.id, name: b.name, type: b.type })));
        } catch {
          if (!cancelled) setBrainsCatalog([]);
        }
      })();
    }
    return () => {
      cancelled = true;
      coreMemoryRequestRef.current += 1;
    };
  }, [mode, avatarId, loadTools, loadSoul, loadCoreMemory]);

  const resetOverviewDraft = useCallback(() => {
    if (!avatar) return;
    setName(avatar.name ?? "");
    setRole(avatar.role ?? "");
    setBlurb(avatar.description ?? "");
    setTagsInput((avatar.tags ?? []).join(", "));
    setAvatarUrlDraft(avatar.avatarUrl ?? "");
    setColorDraft(normalizeAvatarColor(avatar.color) || "blue");
    setWorkspaceDir(avatar.workspaceDir ?? "");
    setWorkspaceDirHint("");
    setAvatarImageHint("");
  }, [avatar]);

  const handleBeginOverviewEdit = () => {
    if (isManagedAvatar) return;
    setMessage("");
    setOverviewEditing(true);
  };

  const handleCancelOverviewEdit = () => {
    resetOverviewDraft();
    setOverviewEditing(false);
    setMessage("");
  };

  const loadSkillsList = useCallback(async () => {
    setLoadingSkills(true);
    try {
      const r = await window.agenticxDesktop.loadSkills();
      if (r?.ok) {
        const list = (r.items ?? []).filter((s) => !s.globally_disabled);
        setSkillsItems(list.map((s) => ({ name: s.name, description: s.description, globally_disabled: s.globally_disabled })));
      }
    } finally {
      setLoadingSkills(false);
    }
  }, []);

  useEffect(() => {
    if (mode === "avatar" && avatar && tab === "skills") {
      void loadSkillsList();
    }
  }, [mode, avatar, tab, loadSkillsList]);

  const handlePickAvatarImage = useCallback((file: File) => {
    const maxBytes = 1.8 * 1024 * 1024;
    if (!file.type.startsWith("image/")) {
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
      setAvatarImageHint("已选择图片，请点击「保存专家资料」写入专家资料。");
    };
    reader.onerror = () => setAvatarImageHint("读取图片失败，请重试。");
    reader.readAsDataURL(file);
  }, []);

  const handleChooseWorkspace = useCallback(async () => {
    if (isManagedAvatar) {
      setMessage("企业托管专家为只读配置，不能更换工作区。");
      return;
    }
    const picker = window.agenticxDesktop.chooseDirectory;
    if (typeof picker !== "function") {
      setWorkspaceDirHint("当前桌面版本不支持选择文件夹。");
      return;
    }
    try {
      const result = await picker();
      if (result?.ok && result.path) {
        setWorkspaceDir(result.path);
        setWorkspaceDirHint("已选择新工作区，请点击“保存专家资料”。");
      } else if (!result?.canceled && result?.error) {
        setWorkspaceDirHint(`选择失败: ${result.error}`);
      }
    } catch (err) {
      setWorkspaceDirHint(`选择失败: ${String(err)}`);
    }
  }, [isManagedAvatar]);

  const customizedCount = useMemo(
    () => Object.keys(toolsEnabled).filter((key) => toolsEnabled[key] !== undefined).length,
    [toolsEnabled],
  );

  const toolsModeHint =
    mode === "avatar"
      ? `未设置项继承${META_AGENT_DISPLAY_NAME}全局策略；如全局未设置，则默认启用。`
      : `${META_AGENT_DISPLAY_NAME}全局策略将作为所有专家默认值；未设置项默认启用。`;

  /** 专家「概览」Tab：联系人资料、签名、工作区与核心记忆。 */
  const handleSaveOverview = async () => {
    if (mode !== "avatar" || !avatar) return;
    if (isManagedAvatar) {
      setMessage("企业托管专家为只读配置，不能直接修改。");
      return;
    }
    setSaving(true);
    setMessage("");
    try {
      const res = await window.agenticxDesktop.updateAvatar({
        id: avatar.id,
        name: name.trim() || avatar.name,
        role: role.trim(),
        description: blurb.trim(),
        tags: parseTagInput(tagsInput),
        avatar_url: avatarUrlDraft.trim(),
        color: colorDraft,
        ...(workspaceDir.trim() ? { workspace_dir: workspaceDir.trim() } : {}),
      });
      if (!res?.ok) {
        setMessage(`保存失败: ${res?.error ?? "未知错误"}`);
        return;
      }
      setMessage("概览已保存。");
      setWorkspaceDirHint("");
      setAvatarImageHint("");
      setOverviewEditing(false);
      onSaved();
    } catch (err) {
      setMessage(`保存失败: ${String(err)}`);
    } finally {
      setSaving(false);
    }
  };

  const handleSaveCoreMemory = async () => {
    if (mode !== "avatar" || !avatar) return;
    if (isManagedAvatar) {
      setMessage("企业托管专家为只读配置，不能直接修改。");
      return;
    }
    const coreMemorySaver = window.agenticxDesktop.saveAvatarCoreMemory;
    if (typeof coreMemorySaver !== "function") {
      setMessage("核心记忆保存失败: 当前桌面版本不支持核心记忆");
      return;
    }
    setSaving(true);
    setMessage("");
    try {
      const result = await coreMemorySaver({ avatarId: avatar.id, documents: coreMemory });
      if (!result?.ok) {
        setMessage(`核心记忆保存失败: ${result?.error ?? "未知错误"}`);
        return;
      }
      setMessage("核心记忆已保存，下一轮对话生效。");
    } catch (err) {
      setMessage(`核心记忆保存失败: ${String(err)}`);
    } finally {
      setSaving(false);
    }
  };

  /** 专家「运行配置」Tab：行为提示、模型、默认运行模式和知识脑。 */
  const handleSaveRuntime = async () => {
    if (mode !== "avatar" || !avatar) return;
    if (isManagedAvatar) {
      setMessage("企业托管专家为只读配置，不能直接修改。");
      return;
    }
    setSaving(true);
    setMessage("");
    try {
      const brainsPayload =
        brainsMountMode === "all"
          ? "*"
          : brainsMountMode === "custom"
            ? brainsCustomIds
            : null;
      const tags = parseTagInput(tagsInput);
      const result = await window.agenticxDesktop.updateAvatar({
        id: avatar.id,
        system_prompt: systemPrompt.trim(),
        tags,
        default_provider: defaultProvider.trim(),
        default_model: defaultModel.trim(),
        default_permission_mode: defaultPermissionMode,
        ...(LOCAL_KNOWLEDGE_ENABLED ? { brains_enabled: brainsPayload } : {}),
      });
      setMessage(result?.ok ? "运行配置已保存。" : `保存失败: ${result?.error ?? "未知错误"}`);
      if (result?.ok) {
        setAvatarImageHint("");
        onSaved();
      }
    } catch (err) {
      setMessage(`保存失败: ${String(err)}`);
    } finally {
      setSaving(false);
    }
  };

  const skillsCustomizedCount = useMemo(
    () => Object.keys(skillsEnabledDraft).filter((k) => skillsEnabledDraft[k] === false).length,
    [skillsEnabledDraft],
  );

  const handleSaveSkills = async () => {
    if (mode !== "avatar" || !avatar) return;
    if (isManagedAvatar) {
      setMessage("企业托管专家为只读配置，不能直接修改。");
      return;
    }
    setSaving(true);
    setMessage("");
    try {
      const onlyFalse = Object.fromEntries(
        Object.entries(skillsEnabledDraft).filter(([, v]) => v === false),
      );
      const res = await window.agenticxDesktop.updateAvatar({
        id: avatar.id,
        skills_enabled: Object.keys(onlyFalse).length > 0 ? onlyFalse : {},
      });
      setMessage(res?.ok ? "已保存" : `保存失败: ${res?.error ?? "未知错误"}`);
      if (res?.ok) onSaved();
    } catch (err) {
      setMessage(`保存失败: ${String(err)}`);
    } finally {
      setSaving(false);
    }
  };

  const handleSaveTools = async () => {
    if (isManagedAvatar) {
      setMessage("企业托管专家为只读配置，不能直接修改。");
      return;
    }
    setSaving(true);
    setMessage("");
    try {
      if (mode === "avatar" && avatar) {
        const res = await window.agenticxDesktop.updateAvatar({
          id: avatar.id,
          tools_enabled: { ...toolsEnabled },
        });
        setMessage(res?.ok ? "已保存" : `保存失败: ${res?.error ?? "未知错误"}`);
        if (res?.ok) onSaved();
      } else {
        const res = await window.agenticxDesktop.saveToolsPolicy({ tools_enabled: { ...toolsEnabled } });
        setMessage(res?.ok ? "已保存" : `保存失败: ${res?.error ?? "未知错误"}`);
      }
    } catch (err) {
      setMessage(`保存失败: ${String(err)}`);
    } finally {
      setSaving(false);
    }
  };

  const handleSaveMetaSoul = async () => {
    if (mode !== "machi") return;
    setSaving(true);
    setMessage("");
    try {
      const res = await window.agenticxDesktop.saveMetaSoul({ content: soulValue });
      setMessage(res?.ok ? `已保存，下一轮${META_AGENT_DISPLAY_NAME}对话生效。` : `保存失败: ${res?.error ?? "未知错误"}`);
    } catch (err) {
      setMessage(`保存失败: ${String(err)}`);
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    if (mode === "avatar" && tab === "soul") {
      setTab("general");
    }
  }, [mode, tab]);

  const tabs: { id: Tab; label: string }[] =
    mode === "avatar"
      ? [
          { id: "general", label: "概览" },
          { id: "runtime", label: "运行配置" },
          { id: "tools", label: "工具权限" },
          { id: "skills", label: "技能" },
        ]
      : [
          { id: "tools", label: "工具权限（全局）" },
          { id: "soul", label: "灵魂" },
        ];

  const activeTab = tabs.find((t) => t.id === tab) ? tab : tabs[0].id;
  const tabPanelId = "expert-settings-panel";
  const profileTags = parseTagInput(tagsInput);
  const profileName = name.trim() || "未命名专家";
  const profileRole = role.trim() || "数字专家";
  const profileSignature = blurb.trim() || "还没有填写签名。";
  const profileSource = isManagedAvatar ? "企业专家" : "数字专家";

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 p-4 backdrop-blur-none">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="expert-settings-title"
        className="flex h-[min(85vh,640px)] w-[min(90vw,640px)] flex-col overflow-hidden rounded-2xl border border-border shadow-2xl"
        style={{ backgroundColor: "var(--surface-base-fallback, var(--surface-panel))" }}
      >
        {/* Header：标题 + 右上角关闭 */}
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border bg-surface-panel px-3 py-3 sm:px-4">
          <h1 id="expert-settings-title" className="min-w-0 flex-1 truncate text-sm font-semibold text-text-strong">
            {title}
          </h1>
          <button
            type="button"
            aria-label="关闭"
            className="shrink-0 rounded-md p-1.5 text-text-muted transition hover:bg-surface-hover hover:text-text-strong"
            onClick={onClose}
          >
            <X className="h-5 w-5" strokeWidth={2.25} />
          </button>
        </div>

        {/* Tab bar */}
        <div
          role="tablist"
          aria-label={mode === "avatar" ? "专家资料设置" : `${META_AGENT_DISPLAY_NAME}设置`}
          className="flex shrink-0 gap-1 border-b border-border bg-surface-sidebar px-4 pt-2"
        >
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              id={`expert-settings-tab-${t.id}`}
              role="tab"
              aria-selected={activeTab === t.id}
              aria-controls={tabPanelId}
              className={`mb-1 rounded-[10px] border px-3 py-1.5 text-xs font-medium transition ${
                activeTab === t.id
                  ? "border-transparent bg-btnPrimary text-btnPrimary-text"
                  : "border-transparent text-text-subtle hover:border-border-strong hover:bg-surface-card hover:text-text-strong"
              }`}
              onClick={() => {
                setTab(t.id);
                setMessage("");
              }}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Content */}
        <div
          id={tabPanelId}
          role="tabpanel"
          aria-labelledby={`expert-settings-tab-${activeTab}`}
          className="min-h-0 flex-1 overflow-y-auto p-4"
        >
          {activeTab === "general" && mode === "avatar" && (
            <div className="space-y-4">
              {isManagedAvatar ? (
                <p className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-xs leading-relaxed text-amber-200">
                  这是企业能力包下发的托管专家，资料、运行配置与核心记忆均为只读；如需定制，请导出后创建个人副本。
                </p>
              ) : null}

              <section
                data-testid="expert-profile-card"
                className="rounded-2xl border border-border bg-surface-card p-4 shadow-sm"
              >
                <div className="flex items-start gap-3">
                  <GroupMemberAvatar
                    avatar={
                      avatar
                        ? {
                            id: avatar.id,
                            name: profileName,
                            avatarUrl: avatarUrlDraft,
                            color: colorDraft,
                          }
                        : undefined
                    }
                    label={profileName}
                    identity={avatar?.id || profileName}
                    size="xl"
                  />
                  <div className="min-w-0 flex-1 pt-0.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="truncate text-lg font-semibold tracking-tight text-text-strong">{profileName}</h2>
                      <span className="rounded-full border border-border px-2 py-0.5 text-[10px] font-medium text-text-faint">
                        {profileSource}
                      </span>
                    </div>
                    <p className="mt-1 truncate text-xs font-medium text-text-muted">{profileRole}</p>
                    <p className="mt-2 line-clamp-3 text-xs leading-relaxed text-text-faint">{profileSignature}</p>
                  </div>
                  {!overviewEditing ? (
                    <button
                      type="button"
                      className="shrink-0 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-text-subtle transition hover:bg-surface-hover hover:text-text-strong disabled:cursor-not-allowed disabled:opacity-45"
                      disabled={isManagedAvatar || saving}
                      onClick={handleBeginOverviewEdit}
                    >
                      编辑资料
                    </button>
                  ) : null}
                </div>

                {profileTags.length > 0 ? (
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {profileTags.map((tag) => (
                      <span key={tag} className="rounded-md bg-surface-panel px-2 py-1 text-[10px] text-text-subtle">
                        {tag}
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="mt-3 text-[11px] text-text-faint">暂无标签</p>
                )}

                {overviewEditing ? (
                  <fieldset
                    disabled={isManagedAvatar || saving}
                    className="mt-4 space-y-3 border-t border-border pt-4 disabled:opacity-75"
                  >
                    <label className="block text-sm text-text-muted">
                      姓名
                      <input
                        className="mt-1 w-full rounded-lg border border-border bg-surface-panel px-3 py-2 text-sm text-text-primary"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder="专家名称"
                        autoFocus
                      />
                    </label>
                    <label className="block text-sm text-text-muted">
                      角色
                      <input
                        className="mt-1 w-full rounded-lg border border-border bg-surface-panel px-3 py-2 text-sm text-text-primary"
                        value={role}
                        onChange={(e) => setRole(e.target.value)}
                        placeholder="例：全栈开发工程师、数据分析师"
                      />
                    </label>
                    <label className="block text-sm text-text-muted">
                      签名
                      <span className="ml-1 text-xs font-normal text-text-faint">（展示在专家卡片和联系人式名片上）</span>
                      <textarea
                        className="mt-1 min-h-[72px] w-full resize-y rounded-lg border border-border bg-surface-panel px-3 py-2 text-sm text-text-primary"
                        value={blurb}
                        onChange={(e) => setBlurb(e.target.value)}
                        placeholder="一两句话说明该专家能做什么..."
                      />
                    </label>
                    <label className="block text-sm text-text-muted">
                      标签
                      <span className="ml-1 text-xs font-normal text-text-faint">（可选，逗号分隔，最多 8 个）</span>
                      <input
                        data-testid="expert-tags-input"
                        className="mt-1 w-full rounded-lg border border-border bg-surface-panel px-3 py-2 text-sm text-text-primary"
                        value={tagsInput}
                        onChange={(e) => setTagsInput(e.target.value)}
                        placeholder="例：环境、诊断、Python"
                      />
                    </label>
                    <div className="rounded-xl border border-border bg-surface-panel/60 p-3">
                      <div className="text-xs font-medium text-text-muted">头像与主题色</div>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <label className="cursor-pointer rounded-lg border border-border px-2.5 py-1.5 text-xs text-text-subtle transition hover:bg-surface-hover hover:text-text-strong">
                          更换头像
                          <input
                            type="file"
                            accept="image/*"
                            className="hidden"
                            onChange={(e) => {
                              const file = e.target.files?.[0];
                              if (file) handlePickAvatarImage(file);
                              e.currentTarget.value = "";
                            }}
                          />
                        </label>
                        <button
                          type="button"
                          className="rounded-lg border border-border px-2.5 py-1.5 text-xs text-text-subtle transition hover:bg-surface-hover hover:text-text-strong disabled:opacity-50"
                          disabled={!avatarUrlDraft}
                          onClick={() => {
                            setAvatarUrlDraft("");
                            setAvatarImageHint("已清除预览，请点击“保存专家资料”以恢复默认头像。");
                          }}
                        >
                          恢复默认头像
                        </button>
                        <div className="ml-auto flex items-center gap-1.5">
                          {AVATAR_PALETTE.map((key) => (
                            <button
                              key={key}
                              type="button"
                              aria-label={AVATAR_COLOR_LABEL[key]}
                              aria-pressed={colorDraft === key}
                              title={AVATAR_COLOR_LABEL[key]}
                              className={`h-6 w-6 rounded-full border-2 transition ${
                                colorDraft === key
                                  ? "border-text-strong ring-2 ring-[rgba(var(--theme-color-rgb,59,130,246),0.35)]"
                                  : "border-border-strong hover:scale-105 hover:border-text-faint"
                              }`}
                              style={{ background: AVATAR_COLOR_SWATCH[key] }}
                              onClick={() => setColorDraft(key)}
                            />
                          ))}
                        </div>
                      </div>
                      {avatarImageHint ? <p className="mt-2 text-[11px] text-text-faint">{avatarImageHint}</p> : null}
                    </div>
                    <div className="flex justify-end gap-2 pt-1">
                      <button
                        type="button"
                        className="rounded-lg border border-border px-3 py-1.5 text-xs text-text-subtle transition hover:bg-surface-hover hover:text-text-strong"
                        onClick={handleCancelOverviewEdit}
                      >
                        取消
                      </button>
                      <button
                        type="button"
                        className="flex items-center gap-1.5 rounded-lg bg-btnPrimary px-3 py-1.5 text-xs font-medium text-btnPrimary-text transition hover:bg-btnPrimary-hover disabled:opacity-40"
                        disabled={!name.trim()}
                        onClick={() => void handleSaveOverview()}
                      >
                        <Save className="h-3.5 w-3.5" />
                        {saving ? "保存中..." : "保存专家资料"}
                      </button>
                    </div>
                  </fieldset>
                ) : null}
              </section>

              <section
                data-testid="expert-workspace-card"
                className="rounded-xl border border-border bg-surface-card p-3.5"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-text-primary">专家工作区</div>
                    <p className="mt-1 text-xs leading-relaxed text-text-faint">
                      新建会话默认使用这里；已存在的会话保留原工作区，群聊共享目录仍会额外挂载。
                    </p>
                  </div>
                </div>
                <div className="mt-3 flex items-center gap-2">
                  <div
                    className="min-w-0 flex-1 truncate rounded-lg border border-border bg-surface-panel px-3 py-2 text-xs text-text-subtle"
                    title={workspaceDir}
                  >
                    {workspaceDir || "未设置（自动使用专家专属工作区）"}
                  </div>
                  {overviewEditing ? (
                    <button
                      type="button"
                      className="shrink-0 rounded-lg border border-border px-3 py-2 text-xs text-text-subtle transition hover:bg-surface-hover hover:text-text-strong disabled:opacity-40"
                      disabled={isManagedAvatar || saving}
                      onClick={() => void handleChooseWorkspace()}
                    >
                      选择文件夹
                    </button>
                  ) : null}
                </div>
                {workspaceDirHint ? <p className="mt-1.5 text-[11px] text-text-faint">{workspaceDirHint}</p> : null}
              </section>

              <section
                data-testid="expert-memory-card"
                className="rounded-xl border border-border bg-surface-card p-3.5"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-sm font-medium text-text-primary">专家核心记忆</div>
                    <p className="mt-1 text-xs leading-relaxed text-text-faint">
                      仅允许编辑专家工作区中的 IDENTITY.md、SOUL.md、MEMORY.md；默认只显示摘要，点击
                      {isManagedAvatar ? "“查看”展开只读内容。" : "“编辑”再展开。"}
                    </p>
                  </div>
                  <span className="shrink-0 rounded-full bg-surface-panel px-2 py-0.5 text-[10px] text-text-faint">3 份文件</span>
                </div>
                {loadingCoreMemory ? (
                  <div className="mt-3 rounded-lg border border-border bg-surface-panel px-3 py-2 text-xs text-text-faint">
                    加载核心记忆中...
                  </div>
                ) : (
                  <div className="mt-3 space-y-2">
                    {([
                      ["IDENTITY.md", "身份", "专家是谁、擅长什么、服务边界。"],
                      ["SOUL.md", "风格与策略", "长期行为风格、判断原则与协作习惯。"],
                      ["MEMORY.md", "长期记忆", "可复用的经验和用户偏好；不要写入敏感信息。"],
                    ] as const).map(([filename, label, placeholder]) => {
                      const expanded = Boolean(openCoreMemoryDocuments[filename]);
                      const documentId = `expert-core-memory-${filename.replace(".md", "").toLowerCase()}`;
                      const actionLabel = isManagedAvatar ? (expanded ? "收起" : "查看") : expanded ? "收起" : "编辑";
                      return (
                        <div key={filename} className="overflow-hidden rounded-lg border border-border bg-surface-panel/60">
                          <button
                            type="button"
                            id={`${documentId}-toggle`}
                            className="flex w-full items-start gap-3 px-3 py-2.5 text-left transition hover:bg-surface-hover"
                            aria-expanded={expanded}
                            aria-controls={documentId}
                            aria-label={`${actionLabel}${label}（${filename}）`}
                            onClick={() =>
                              setOpenCoreMemoryDocuments((previous) => ({
                                ...previous,
                                [filename]: !expanded,
                              }))
                            }
                          >
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-1.5">
                                <span className="text-xs font-medium text-text-primary">{label}</span>
                                <span className="text-[10px] text-text-faint">{filename}</span>
                              </div>
                              <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-text-faint">
                                {summarizeMarkdown(coreMemory[filename], isManagedAvatar)}
                              </p>
                            </div>
                            <span className="shrink-0 rounded-md border border-border px-2 py-1 text-[10px] font-medium text-text-subtle">
                              {actionLabel}
                            </span>
                          </button>
                          {expanded ? (
                            <div
                              id={documentId}
                              role="region"
                              aria-labelledby={`${documentId}-toggle`}
                              className="border-t border-border px-3 py-3"
                            >
                              <p className="mb-2 text-[11px] text-text-faint">{placeholder}</p>
                              <textarea
                                className="min-h-[128px] w-full resize-y rounded-lg border border-border bg-surface-panel px-3 py-2 text-sm text-text-primary read-only:opacity-80"
                                aria-label={`${label}（${filename}）`}
                                aria-readonly={isManagedAvatar || undefined}
                                value={coreMemory[filename]}
                                readOnly={isManagedAvatar}
                                onChange={(e) =>
                                  setCoreMemory((previous) => ({ ...previous, [filename]: e.target.value }))
                                }
                              />
                            </div>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                )}
                <div className="mt-3 flex items-center justify-between gap-2">
                  <span className="text-[11px] text-text-faint">三份文件会原子保存，失败时不会覆盖原内容。</span>
                  <button
                    type="button"
                    className="flex shrink-0 items-center gap-1.5 rounded-lg bg-btnPrimary px-3 py-1.5 text-xs font-medium text-btnPrimary-text transition hover:bg-btnPrimary-hover disabled:opacity-40"
                    disabled={isManagedAvatar || saving || loadingCoreMemory}
                    onClick={() => void handleSaveCoreMemory()}
                  >
                    <Save className="h-3.5 w-3.5" />
                    {saving ? "保存中..." : "保存核心记忆"}
                  </button>
                </div>
              </section>
            </div>
          )}

          {activeTab === "runtime" && mode === "avatar" && (
            <div className="space-y-4">
              <p className="rounded-xl border border-border bg-surface-card px-3 py-2.5 text-xs leading-relaxed text-text-subtle">
                这里调整专家的行为规则、默认模型、权限与知识脑；资料与运行配置分别保存，避免互相覆盖。
              </p>
              {isManagedAvatar ? (
                <p className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-xs text-amber-200">
                  企业托管专家的运行配置为只读；如需定制，请导出后创建个人副本。
                </p>
              ) : null}
              <fieldset disabled={isManagedAvatar} className={isManagedAvatar ? "opacity-80" : undefined}>
                <div className="space-y-3">
                  <label className="block text-sm text-text-muted">
                    系统提示
                    <textarea
                      className="mt-1 min-h-[120px] w-full resize-y rounded-lg border border-border bg-surface-panel px-3 py-2 text-sm text-text-primary"
                      value={systemPrompt}
                      onChange={(e) => setSystemPrompt(e.target.value)}
                      placeholder="例如：你是资深前端工程师，先给结论，再给步骤；代码优先给可直接运行版本。"
                    />
                  </label>
                  <p className="rounded-xl border border-border bg-surface-card px-3 py-2 text-xs leading-relaxed text-text-faint">
                    专家标签属于资料信息，请前往“概览 → 编辑资料”维护。
                  </p>
                  <label className="block text-sm text-text-muted">
                    默认模型
                    <span className="ml-1 text-xs text-text-faint">（新建会话或未显式选择模型时使用）</span>
                    <DefaultModelSelect
                      provider={defaultProvider}
                      model={defaultModel}
                      onChange={(p, m) => {
                        setDefaultProvider(p);
                        setDefaultModel(m);
                      }}
                    />
                  </label>
                  <label className="block text-sm text-text-muted">
                    默认运行模式
                    <span className="ml-1 text-xs text-text-faint">（新建会话和群聊中的该专家使用）</span>
                    <select
                      className="mt-1 w-full rounded-lg border border-border bg-surface-panel px-3 py-2 text-sm text-text-primary"
                      value={defaultPermissionMode}
                      onChange={(e) => setDefaultPermissionMode(normalizeRunMode(e.target.value))}
                    >
                      {RUN_MODE_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value} title={option.description}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                    <span className="mt-1 block text-xs text-text-faint">
                      {RUN_MODE_OPTIONS.find((option) => option.value === defaultPermissionMode)?.description}
                    </span>
                  </label>
                  {LOCAL_KNOWLEDGE_ENABLED ? (
                    <div className="rounded-xl border border-border bg-surface-card p-3">
                      <div className="text-sm font-medium text-text-primary">挂载知识脑</div>
                      <p className="mt-1 text-xs text-text-faint">
                        控制该专家对话时 knowledge_search 可检索的文档脑。默认仅全局脑。
                      </p>
                      <div className="mt-2 flex flex-wrap gap-3 text-xs">
                        <label className="flex items-center gap-1.5">
                          <input
                            type="radio"
                            checked={brainsMountMode === "default"}
                            onChange={() => setBrainsMountMode("default")}
                          />
                          默认（仅全局）
                        </label>
                        <label className="flex items-center gap-1.5">
                          <input
                            type="radio"
                            checked={brainsMountMode === "all"}
                            onChange={() => setBrainsMountMode("all")}
                          />
                          全部可见脑
                        </label>
                        <label className="flex items-center gap-1.5">
                          <input
                            type="radio"
                            checked={brainsMountMode === "custom"}
                            onChange={() => setBrainsMountMode("custom")}
                          />
                          自定义
                        </label>
                      </div>
                      {brainsMountMode === "custom" ? (
                        <div className="mt-2 max-h-32 space-y-1 overflow-y-auto">
                          {brainsCatalog.map((b) => (
                            <label key={b.id} className="flex items-center gap-2 text-xs text-text-subtle">
                              <input
                                type="checkbox"
                                checked={brainsCustomIds.includes(b.id)}
                                onChange={(e) => {
                                  setBrainsCustomIds((prev) =>
                                    e.target.checked ? [...prev, b.id] : prev.filter((x) => x !== b.id),
                                  );
                                }}
                              />
                              <span>
                                {b.name} <span className="text-text-faint">({b.type})</span>
                              </span>
                            </label>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                  <div className="flex justify-end">
                    <button
                      type="button"
                      className="flex items-center gap-1.5 rounded-lg bg-btnPrimary px-3 py-1.5 text-xs font-medium text-btnPrimary-text transition hover:bg-btnPrimary-hover disabled:opacity-40"
                      disabled={isManagedAvatar || saving || !name.trim()}
                      onClick={() => void handleSaveRuntime()}
                    >
                      <Save className="h-3.5 w-3.5" />
                      {saving ? "保存中..." : "保存运行配置"}
                    </button>
                  </div>
                </div>
              </fieldset>
            </div>
          )}

          {activeTab === "skills" && mode === "avatar" && (
            <div className="space-y-3">
              <p className="text-xs text-text-faint">
                已在全局技能列表中禁用的条目不会出现在此列表。未列出的技能对该专家默认启用；关闭开关表示该专家不使用此技能。
              </p>
              {loadingSkills ? (
                <div className="rounded-md border border-border bg-surface-card px-3 py-2 text-xs text-text-faint">
                  加载技能列表中...
                </div>
              ) : skillsItems.length === 0 ? (
                <div className="rounded-md border border-border bg-surface-card px-3 py-2 text-xs text-text-faint">
                  当前没有可用的技能（或全部被全局禁用）。
                </div>
              ) : (
                <div className="space-y-2">
                  {skillsItems.map((skill) => {
                    const skillOffForAvatar = skillsEnabledDraft[skill.name] === false;
                    return (
                      <div key={skill.name} className="rounded-md border border-border bg-surface-card px-2.5 py-2">
                        <div className="flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <div className="truncate text-sm text-text-primary">{skill.name}</div>
                            {skill.description ? (
                              <div className="truncate text-xs text-text-faint">{skill.description}</div>
                            ) : null}
                          </div>
                          <SettingsSwitch
                            checked={!skillOffForAvatar}
                            disabled={isManagedAvatar || saving}
                            aria-label={`${skill.name} 对该专家启用`}
                            onChange={(next) => {
                              setSkillsEnabledDraft((prev) => {
                                const draft = { ...prev };
                                if (!next) draft[skill.name] = false;
                                else delete draft[skill.name];
                                return draft;
                              });
                            }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
              <div className="flex items-center justify-between pt-2">
                <button
                  type="button"
                  className="flex items-center gap-1 rounded border border-border px-2.5 py-1 text-xs text-text-subtle transition hover:bg-surface-hover disabled:opacity-40"
                  onClick={() => setSkillsEnabledDraft({})}
                  disabled={isManagedAvatar || skillsCustomizedCount === 0 || saving}
                >
                  <RotateCcw className="h-3 w-3" />
                  重置（全部启用）
                </button>
                <button
                  type="button"
                  className="flex items-center gap-1.5 rounded-md bg-btnPrimary px-3 py-1.5 text-xs font-medium text-btnPrimary-text transition hover:bg-btnPrimary-hover disabled:opacity-40"
                  disabled={isManagedAvatar || saving}
                  onClick={() => void handleSaveSkills()}
                >
                  <Save className="h-3.5 w-3.5" />
                  {saving ? "保存中..." : "保存"}
                </button>
              </div>
            </div>
          )}

          {activeTab === "tools" && (
            <div className="space-y-3">
              <p className="text-xs text-text-faint">
                {customizedCount > 0 ? `已自定义 ${customizedCount} 项` : "未自定义（使用默认）"} · {toolsModeHint}
              </p>
              {loadingTools ? (
                <div className="rounded-md border border-border bg-surface-card px-3 py-2 text-xs text-text-faint">
                  加载工具列表中...
                </div>
              ) : (
                <div className="space-y-2">
                  {tools.map((tool) => {
                    const inherited = !(tool.id in toolsEnabled);
                    const enabled = inherited ? true : Boolean(toolsEnabled[tool.id]);
                    const stateLabel = inherited ? "默认" : enabled ? "启用" : "禁用";
                    return (
                      <div key={tool.id} className="rounded-md border border-border bg-surface-card px-2.5 py-2">
                        <div className="flex items-center justify-between gap-2">
                          <div className="min-w-0">
                            <div className="truncate text-sm text-text-primary">{tool.name}</div>
                            <div className="truncate text-xs text-text-faint">{tool.description}</div>
                          </div>
                          <button
                            type="button"
                            className={`inline-flex min-w-[72px] items-center justify-center rounded border px-2 py-0.5 text-xs transition ${
                              inherited
                                ? "border-border text-text-faint"
                                : enabled
                                  ? "border-cyan-500/40 bg-cyan-500/15 text-cyan-400"
                                  : "border-border-strong bg-surface-hover text-text-muted"
                            } disabled:cursor-not-allowed disabled:opacity-40`}
                            disabled={isManagedAvatar || saving}
                            onClick={() => {
                              if (isManagedAvatar) return;
                              setToolsEnabled((prev) => {
                                const next = { ...prev };
                                if (!(tool.id in next)) {
                                  next[tool.id] = false;
                                } else if (next[tool.id] === false) {
                                  delete next[tool.id];
                                } else {
                                  next[tool.id] = false;
                                }
                                return next;
                              });
                            }}
                          >
                            {stateLabel}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              <div className="flex items-center justify-between pt-2">
                <button
                  type="button"
                  className="flex items-center gap-1 rounded border border-border px-2.5 py-1 text-xs text-text-subtle transition hover:bg-surface-hover disabled:opacity-40"
                  onClick={() => setToolsEnabled({})}
                  disabled={isManagedAvatar || customizedCount === 0 || saving}
                >
                  <RotateCcw className="h-3 w-3" />
                  重置默认
                </button>
                <button
                  className="flex items-center gap-1.5 rounded-md bg-btnPrimary px-3 py-1.5 text-xs font-medium text-btnPrimary-text transition hover:bg-btnPrimary-hover disabled:opacity-40"
                  disabled={isManagedAvatar || saving}
                  onClick={() => void handleSaveTools()}
                >
                  <Save className="h-3.5 w-3.5" />
                  {saving ? "保存中..." : "保存"}
                </button>
              </div>
            </div>
          )}

          {activeTab === "soul" && mode === "machi" && (
            <div className="space-y-3">
              <p className="text-xs text-text-faint">
                支持自由 Markdown 文本。该配置用于塑造{META_AGENT_DISPLAY_NAME}（Meta-Agent）的长期行为风格。
              </p>
              {loadingSoul ? (
                <div className="rounded-md border border-border bg-surface-card px-3 py-2 text-xs text-text-faint">
                  加载中...
                </div>
              ) : (
                <textarea
                  className="min-h-[220px] w-full resize-y rounded-md border border-border bg-surface-panel px-3 py-2 text-sm text-text-primary"
                  aria-label={`${META_AGENT_DISPLAY_NAME}灵魂`}
                  value={soulValue}
                  onChange={(e) => setSoulValue(e.target.value)}
                  placeholder="例如：先给结论，再给证据；避免重复确认；把进度和风险讲清楚。"
                />
              )}
              <div className="flex justify-end">
                <button
                  type="button"
                  className="flex items-center gap-1.5 rounded-md bg-btnPrimary px-3 py-1.5 text-xs font-medium text-btnPrimary-text transition hover:bg-btnPrimary-hover disabled:opacity-40"
                  disabled={saving}
                  onClick={() => void handleSaveMetaSoul()}
                >
                  <Save className="h-3.5 w-3.5" />
                  {saving ? "保存中..." : "保存"}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Footer message */}
        <div className={message ? "shrink-0 border-t border-border bg-surface-panel px-4 py-2" : "sr-only"}>
          <div
            role="status"
            aria-live="polite"
            aria-atomic="true"
            className={`text-xs ${message.includes("已保存") && !message.includes("失败") ? "text-emerald-400" : "text-rose-400"}`}
          >
            {message}
          </div>
        </div>
      </div>
    </div>
  );
}
