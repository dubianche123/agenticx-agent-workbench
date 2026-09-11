import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { readAttachmentRoutingPolicy } from "./utils/attachment-routing";
import { readCapabilityLocks } from "./utils/enterprise-capability-policy";
import { AvatarSidebar } from "./components/AvatarSidebar";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { ClarificationDialog, type ClarificationAnswer } from "./components/ClarificationDialog";
import { PaneManager } from "./components/PaneManager";
import { SidebarResizer } from "./components/SidebarResizer";
import { Topbar } from "./components/Topbar";
import { VoiceFocusMode } from "./components/VoiceFocusMode";
import { VOICE_UI_ENABLED } from "./constants/feature-flags";
import {
  SHOW_DESKTOP_MULTI_PANE,
  SHOW_DESKTOP_PROJECT_GROUP_CHAT,
} from "./constants/desktop-feature-visibility";
import {
  DEFAULT_CONFIRM_POLICY,
  normalizeRunMode,
  type RunMode,
} from "./constants/confirm-strategy-options";
import type { ForwardConfirmPayload } from "./components/ForwardPicker";
import { resolveForwardTarget } from "./utils/resolve-forward-target";
import { rememberSessionForAvatar } from "./utils/avatar-last-session";
import { parsePersistedThemeMode } from "./utils/theme-preference";
import {
  buildConfirmScope,
  canReuseProtectedConfirm,
  isProtectedConfirmContext,
  RunScopedConfirmApprovals,
  shouldAutoApproveConfirm,
  type ConfirmRunContext,
} from "./utils/confirm-scope";
import { mapLoadedSessionMessage, type LoadedSessionMessage } from "./utils/session-message-map";
import type { ChatPane as ChatPaneState, Message, ProviderEntry } from "./store";
import { normalizeSessionTokens, useAppStore } from "./store";
import { stopSpeak } from "./voice/tts";
import { EDITABLE_SAFE_ACTIONS, matchKeybinding } from "./core/keybinding-manager";
import { META_AGENT_DISPLAY_NAME } from "./constants/branding";
import { resolveMetaDisplayName } from "./utils/display-name";
import { readScopedLocalStorage, writeScopedLocalStorage } from "./utils/backend-scope";
import { GlobalSearchHost } from "./components/global-search/GlobalSearchPanel";
import {
  GLOBAL_SEARCH_ADD_TO_WORKSPACE,
  openGlobalSearch,
  type GlobalSearchAddToWorkspaceDetail,
} from "./components/global-search/global-search-events";
import { Toast } from "./components/ds/Toast";
import { KbDocumentOpenOverlay } from "./components/kb/KbDocumentOpenOverlay";
import { resolveSubAgentOutputPaths } from "./utils/subagent-output-files";
import { addFolderToActiveWorkspace } from "./utils/global-search-workspace";
import {
  coerceSelectableModel,
  isModelSelectable,
  normalizeAllProviders,
  normalizeProviderEntry,
} from "./utils/model-options";
import { scanAndPruneUnauthorizedVisibleModels } from "./utils/prune-unauthorized-visible-models";
import { avatarPreloadKey, fetchAvatarsWithStartupRetry, fetchGroupsWithStartupRetry, fetchSessionsWithStartupRetry, mapAvatarsFromApi, runSplashCorePreload } from "./utils/splash-preload-core";
import { normalizeGroupReactions } from "./utils/group-message-state";
import { toggleGroupMessageReaction } from "./utils/group-reaction-api";
import { normalizeEnterpriseCapabilitySyncStatuses } from "../shared/enterprise-capability-sync";
import {
  desktopFeedbackAccountStampsEqual,
  normalizeDesktopFeedbackAccountStamp,
  shouldApplyDesktopFeedbackAccountStamp,
} from "../shared/feedback-scope";

const SettingsPanel = lazy(() =>
  import("./components/SettingsPanel").then((module) => ({ default: module.SettingsPanel })),
);
const DeliveryPanel = lazy(() =>
  import("./components/delivery/DeliveryPanel").then((module) => ({ default: module.DeliveryPanel })),
);
const TokenDashboardPanel = lazy(() =>
  import("./components/TokenDashboardPanel").then((module) => ({ default: module.TokenDashboardPanel })),
);
const AvatarGalleryView = lazy(() =>
  import("./components/gallery/AvatarGalleryView").then((module) => ({ default: module.AvatarGalleryView })),
);
const ProjectsView = lazy(() =>
  import("./components/groups/ProjectsView").then((module) => ({ default: module.ProjectsView })),
);
const DigitalExpertPlazaView = lazy(() =>
  import("./components/portable/DigitalExpertPlazaView").then((module) => ({
    default: module.DigitalExpertPlazaView,
  })),
);
const AutomationView = lazy(() =>
  import("./components/automation/AutomationView").then((module) => ({ default: module.AutomationView })),
);
const WorkflowStudioView = lazy(() =>
  import("./components/workflow/WorkflowStudioView").then((module) => ({ default: module.WorkflowStudioView })),
);
const KeybindingsPanel = lazy(() =>
  import("./components/KeybindingsPanel").then((module) => ({ default: module.KeybindingsPanel })),
);
const EnvironmentAssistantPanel = lazy(() =>
  import("./components/EnvironmentAssistantPanel").then((module) => ({
    default: module.EnvironmentAssistantPanel,
  })),
);

const WORKSPACE_STATE_STORAGE_KEY = "agx-workspace-state-v1";

type PersistedPaneState = {
  id: string;
  avatarId: string | null;
  avatarName: string;
  sessionId: string;
  modelProvider?: string;
  modelName?: string;
  /** Kimi K3 reasoning_effort: low | high | max. DeepSeek V4: high | max. */
  reasoningEffort?: "low" | "high" | "max";
  /** DeepSeek V4 thinking switch; undefined = default on. */
  thinkingEnabled?: boolean;
  historyOpen: boolean;
  memoryGraphOpen?: boolean;
  contextInherited: boolean;
  taskspacePanelOpen: boolean;
  membersPanelOpen: boolean;
  graphPanelOpen?: boolean;
  activeGraphRunId?: string | null;
  sidePanelTab: "workspace" | "members" | "graph";
  activeTaskspaceId: string | null;
  spawnsColumnOpen?: boolean;
  spawnsColumnSuppressAuto?: boolean;
  spawnsColumnBaselineIds?: string[];
  runDrawerOpen?: boolean;
  runDrawerRunId?: string | null;
  sessionTokens?: {
    input: number;
    output: number;
    cached?: number;
    lastInput?: number;
    lastCached?: number;
  };
};

type PersistedWorkspaceState = {
  sessionId: string;
  activePaneId: string;
  panes: PersistedPaneState[];
};

function toProviderEntries(
  raw: Record<
    string,
    {
      api_key?: string;
      base_url?: string;
      model?: string;
      models?: string[];
      enabled?: boolean;
      drop_params?: boolean;
      display_name?: string;
      interface?: "openai" | "ollama";
      managed?: boolean;
    }
  >,
  enterpriseModelCatalog: NonNullable<ProviderEntry["modelCatalog"]> = [],
): Record<string, ProviderEntry> {
  const result: Record<string, ProviderEntry> = {};
  for (const [name, cfg] of Object.entries(raw)) {
    if (cfg == null || typeof cfg !== "object" || Array.isArray(cfg)) {
      continue;
    }
    const displayName = (cfg.display_name ?? "").trim();
    const row: ProviderEntry = {
      apiKey: cfg.api_key ?? "",
      baseUrl: cfg.base_url ?? "",
      model: cfg.model ?? "",
      models: cfg.models ?? [],
      enabled: cfg.enabled !== false,
      dropParams: cfg.drop_params === true,
    };
    if (displayName) row.displayName = displayName;
    if (cfg.interface === "openai" || cfg.interface === "ollama") row.interface = cfg.interface;
    if (cfg.managed === true) row.managed = true;
    if (name === "enterprise" && enterpriseModelCatalog.length > 0) {
      row.modelCatalog = enterpriseModelCatalog;
    }
    result[name] = normalizeProviderEntry(row);
  }
  return result;
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA") return true;
  if (target.isContentEditable) return true;
  return false;
}

/** xterm 内部（含隐藏 textarea / canvas）；避免全局快捷键抢走内嵌终端按键。 */
function isInsideXterm(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(target.closest(".xterm"));
}

function normalizePersistedWorkspaceState(raw: unknown): PersistedWorkspaceState | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const sessionId = String(obj.sessionId ?? "").trim();
  const activePaneId = String(obj.activePaneId ?? "").trim();
  const panesRaw = Array.isArray(obj.panes) ? obj.panes : [];
  const panes: PersistedPaneState[] = panesRaw
    .map((item): PersistedPaneState | null => {
      if (!item || typeof item !== "object") return null;
      const row = item as Record<string, unknown>;
      const id = String(row.id ?? "").trim();
      const avatarName = String(row.avatarName ?? "").trim();
      if (!id || !avatarName) return null;
      const baselineRaw = row.spawnsColumnBaselineIds;
      const baselineIds = Array.isArray(baselineRaw)
        ? baselineRaw.map((x) => String(x)).filter((x) => x.length > 0)
        : [];
      const sessionTokensRaw =
        row.sessionTokens && typeof row.sessionTokens === "object"
          ? (row.sessionTokens as Record<string, unknown>)
          : null;
      const tokInput = Number(sessionTokensRaw?.input ?? 0);
      const tokOutput = Number(sessionTokensRaw?.output ?? 0);
      const tokCached = Number(sessionTokensRaw?.cached ?? 0);
      const tokLastInput = Number(sessionTokensRaw?.lastInput ?? 0);
      const tokLastCached = Number(sessionTokensRaw?.lastCached ?? 0);
      return {
        id,
        avatarId: row.avatarId == null ? null : String(row.avatarId),
        avatarName,
        sessionId: String(row.sessionId ?? "").trim(),
        modelProvider: String(row.modelProvider ?? "").trim(),
        modelName: String(row.modelName ?? "").trim(),
        reasoningEffort: (() => {
          const raw = String(row.reasoningEffort ?? "").trim().toLowerCase();
          return raw === "low" || raw === "high" || raw === "max"
            ? (raw as "low" | "high" | "max")
            : undefined;
        })(),
        thinkingEnabled:
          typeof row.thinkingEnabled === "boolean" ? row.thinkingEnabled : undefined,
        historyOpen: Boolean(row.historyOpen),
        memoryGraphOpen: Boolean(row.memoryGraphOpen),
        contextInherited: Boolean(row.contextInherited),
        taskspacePanelOpen: Boolean(row.taskspacePanelOpen),
        membersPanelOpen: Boolean(row.membersPanelOpen),
        graphPanelOpen: Boolean(row.graphPanelOpen),
        activeGraphRunId:
          row.activeGraphRunId == null || row.activeGraphRunId === ""
            ? null
            : String(row.activeGraphRunId),
        sidePanelTab:
          row.sidePanelTab === "members"
            ? ("members" as const)
            : row.sidePanelTab === "graph"
              ? ("graph" as const)
              : ("workspace" as const),
        activeTaskspaceId: row.activeTaskspaceId == null ? null : String(row.activeTaskspaceId),
        spawnsColumnOpen: typeof row.spawnsColumnOpen === "boolean" ? row.spawnsColumnOpen : undefined,
        spawnsColumnSuppressAuto:
          typeof row.spawnsColumnSuppressAuto === "boolean" ? row.spawnsColumnSuppressAuto : undefined,
        spawnsColumnBaselineIds: baselineIds.length > 0 ? baselineIds : undefined,
        runDrawerOpen: typeof row.runDrawerOpen === "boolean" ? row.runDrawerOpen : undefined,
        runDrawerRunId: row.runDrawerRunId == null ? undefined : String(row.runDrawerRunId).trim() || undefined,
        sessionTokens: {
          input: Number.isFinite(tokInput) && tokInput > 0 ? Math.floor(tokInput) : 0,
          output: Number.isFinite(tokOutput) && tokOutput > 0 ? Math.floor(tokOutput) : 0,
          cached: Number.isFinite(tokCached) && tokCached > 0 ? Math.floor(tokCached) : 0,
          lastInput: Number.isFinite(tokLastInput) && tokLastInput > 0 ? Math.floor(tokLastInput) : 0,
          lastCached: Number.isFinite(tokLastCached) && tokLastCached > 0 ? Math.floor(tokLastCached) : 0,
        },
      };
    })
    .filter((item): item is PersistedPaneState => !!item);
  if (panes.length === 0) return null;
  return { sessionId, activePaneId, panes };
}

type SessionListItem = {
  session_id: string;
  avatar_id: string | null;
  updated_at: number;
  created_at?: number;
  archived?: boolean;
  provider?: string;
  model?: string;
  permission_mode?: RunMode;
  attachment_routing_lock?: unknown;
};

function isSessionItemMatchingAvatar(item: SessionListItem, avatarId?: string | null): boolean {
  const targetAvatarId = (avatarId ?? "").trim();
  const itemAvatarId = String(item.avatar_id ?? "").trim();
  if (!targetAvatarId) return itemAvatarId.length === 0;
  return itemAvatarId === targetAvatarId;
}

function pickMostRecentSessionId(
  sessions: SessionListItem[],
  avatarId?: string | null
): string | undefined {
  const sorted = [...sessions]
    .filter((item) => {
      const sid = String(item.session_id ?? "").trim();
      if (!sid) return false;
      if (item.archived === true) return false;
      return isSessionItemMatchingAvatar(item, avatarId);
    })
    .sort((a, b) => {
      const ua = Number.isFinite(a.updated_at) ? a.updated_at : 0;
      const ub = Number.isFinite(b.updated_at) ? b.updated_at : 0;
      if (ub !== ua) return ub - ua;
      const ca = Number.isFinite(a.created_at ?? NaN) ? (a.created_at as number) : 0;
      const cb = Number.isFinite(b.created_at ?? NaN) ? (b.created_at as number) : 0;
      return cb - ca;
    });
  const sid = sorted[0]?.session_id;
  return sid ? String(sid).trim() : undefined;
}

async function requestSession(
  base: string,
  token: string,
  params?: { sessionId?: string; avatarId?: string | null }
): Promise<string> {
  const query = new URLSearchParams();
  const wantedSessionId = String(params?.sessionId ?? "").trim();
  const avatarId = String(params?.avatarId ?? "").trim();
  if (wantedSessionId) query.set("session_id", wantedSessionId);
  if (avatarId) query.set("avatar_id", avatarId);
  const resp = await fetch(`${base}/api/session${query.size > 0 ? `?${query.toString()}` : ""}`, {
    headers: { "x-agx-desktop-token": token },
  });
  if (!resp.ok) throw new Error(`/api/session HTTP ${resp.status}`);
  const data = (await resp.json()) as {
    session_id?: string;
    attachment_routing_lock?: unknown;
  };
  const sid = String(data.session_id ?? "").trim();
  if (!sid) throw new Error("/api/session returned empty session_id");
  // `/api/session` is the detail endpoint used while restoring/binding a pane.
  // Apply its authoritative marker before the caller paints the session; the
  // local cache remains only a fast first render when the backend is cold.
  useAppStore.getState().hydrateAttachmentRoutingLocksFromSessions([{
    session_id: sid,
    ...(Object.prototype.hasOwnProperty.call(data, "attachment_routing_lock")
      ? { attachment_routing_lock: data.attachment_routing_lock }
      : {}),
  }]);
  return sid;
}

export function App() {
  const apiBase = useAppStore((s) => s.apiBase);
  const apiToken = useAppStore((s) => s.apiToken);
  const sessionId = useAppStore((s) => s.sessionId);
  const panes = useAppStore((s) => s.panes);
  const activePaneId = useAppStore((s) => s.activePaneId);
  const confirm = useAppStore((s) => s.confirm);
  const clarification = useAppStore((s) => s.clarification);
  const settings = useAppStore((s) => s.settings);
  const mainView = useAppStore((s) => s.mainView);
  const setApiBase = useAppStore((s) => s.setApiBase);
  const setApiToken = useAppStore((s) => s.setApiToken);
  const setSessionId = useAppStore((s) => s.setSessionId);
  const setPaneSessionId = useAppStore((s) => s.setPaneSessionId);
  const setOnboardingCompleted = useAppStore((s) => s.setOnboardingCompleted);
  const setKeybindingsPanelOpen = useAppStore((s) => s.setKeybindingsPanelOpen);
  const keybindingsPanelOpen = useAppStore((s) => s.keybindingsPanelOpen);
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed);
  const setSidebarCollapsed = useAppStore((s) => s.setSidebarCollapsed);
  const clearMessages = useAppStore((s) => s.clearMessages);
  const runMode = useAppStore((s) => s.runMode);
  const sessionRunModes = useAppStore((s) => s.sessionRunModes);
  const setSessionRunMode = useAppStore((s) => s.setSessionRunMode);
  const setPendingSessionRunMode = useAppStore((s) => s.setPendingSessionRunMode);
  /**
   * 权限类操作失败时的提示。整句由调用方给,这里只负责显示。
   *
   * 覆盖三处曾经**全部静默**的失败:切模式、写下「以后不再问这条命令」、撤销一条
   * 已保存的批准。前两个失败了顶多是白按一次;第三个失败了最糟——界面显示已经撤销,
   * 后端那条授权还在,用户以为自己收回了权限。
   */
  const [permissionError, setPermissionError] = useState("");
  const setRunMode = useAppStore((s) => s.setRunMode);
  const mcpServers = useAppStore((s) => s.mcpServers);
  const setMcpServers = useAppStore((s) => s.setMcpServers);
  const focusMode = useAppStore((s) => s.focusMode);
  const toggleFocusMode = useAppStore((s) => s.toggleFocusMode);
  const theme = useAppStore((s) => s.theme);
  const themeColor = useAppStore((s) => s.themeColor);
  const setTheme = useAppStore((s) => s.setTheme);
  const setUserAccount = useAppStore((s) => s.setUserAccount);
  const chatStyle = useAppStore((s) => s.chatStyle);
  const setChatStyle = useAppStore((s) => s.setChatStyle);
  const subAgents = useAppStore((s) => s.subAgents);
  const addSubAgent = useAppStore((s) => s.addSubAgent);
  const selectedSubAgent = useAppStore((s) => s.selectedSubAgent);
  const setSelectedSubAgent = useAppStore((s) => s.setSelectedSubAgent);
  const updateSubAgent = useAppStore((s) => s.updateSubAgent);
  const addSubAgentEvent = useAppStore((s) => s.addSubAgentEvent);
  const openConfirm = useAppStore((s) => s.openConfirm);
  const closeConfirm = useAppStore((s) => s.closeConfirm);
  const openClarification = useAppStore((s) => s.openClarification);
  const closeClarification = useAppStore((s) => s.closeClarification);
  const openSettings = useAppStore((s) => s.openSettings);
  const closeSettings = useAppStore((s) => s.closeSettings);
  const tokenDashboardOpen = useAppStore((s) => s.tokenDashboard.open);
  const closeTokenDashboard = useAppStore((s) => s.closeTokenDashboard);
  const deliveryPanelOpen = useAppStore((s) => s.deliveryPanel.open);
  const closeDeliveryPanel = useAppStore((s) => s.closeDeliveryPanel);
  const environmentAssistantOpen = useAppStore((s) => s.environmentAssistantOpen);
  const closeEnvironmentAssistant = useAppStore((s) => s.closeEnvironmentAssistant);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const setActiveModel = useAppStore((s) => s.setActiveModel);
  const setPaneModel = useAppStore((s) => s.setPaneModel);
  const confirmResolverRef = useRef<((value: boolean) => void) | null>(null);
  const confirmScopeRef = useRef<string | null>(null);
  const confirmRunRef = useRef<ConfirmRunContext | null>(null);
  const autoApproveScopesRef = useRef(new RunScopedConfirmApprovals());
  const denyScopesRef = useRef<Set<string>>(new Set());
  const clarifyResolverRef = useRef<((value: { answerText: string; selectedOptions: string[] } | null) => void) | null>(null);
  const sessionInitDoneRef = useRef(false);
  const workspaceHydratedRef = useRef(false);
  const startupRendererReadyRef = useRef(false);
  const studioReadyRefetchDoneRef = useRef(false);
  const [windowResizing, setWindowResizing] = useState(false);
  const [responsiveStage, setResponsiveStage] = useState<0 | 1 | 2>(0);
  const [startupOptimizing, setStartupOptimizing] = useState(true);
  const [configLoaded, setConfigLoaded] = useState(false);
  const [environmentAssistantMounted, setEnvironmentAssistantMounted] = useState(false);
  const [globalSearchToastOpen, setGlobalSearchToastOpen] = useState(false);
  const [globalSearchToastMessage, setGlobalSearchToastMessage] = useState("");
  const [globalSearchToastVariant, setGlobalSearchToastVariant] = useState<"default" | "warning">(
    "default"
  );
  const windowResizeTimerRef = useRef<number | null>(null);
  const responsiveStageRef = useRef<0 | 1 | 2>(0);
  const responsiveSnapshotRef = useRef<{
    sidebarOpen?: boolean;
    panes?: Record<string, { taskspace: boolean; history: boolean; members: boolean }>;
  } | null>(null);
  const subAgentsRef = useRef(subAgents);
  const subAgentSessionRef = useRef<Record<string, string>>({});
  const staleMissCountRef = useRef<Record<string, number>>({});
  const polledEventSeenRef = useRef<Record<string, Set<string>>>({});
  const completionNotifiedRef = useRef<Set<string>>(new Set());
  // Queue of terminal sub-agents waiting for Meta-Agent auto-report
  const autoReportQueueRef = useRef<Array<{
    agentId: string;
    agentName: string;
    summary: string;
    sessionId: string;
    status: "completed" | "failed" | "paused";
    attempts?: number;
  }>>([]);
  const autoReportingRef = useRef(false);
  const directNoticeSentRef = useRef<Set<string>>(new Set());

  // Keep the dedicated panel lazy while retaining its live stream/progress
  // state across close/reopen.  It is intentionally absent from panes and
  // therefore cannot affect ordinary workspace restoration.
  useEffect(() => {
    if (environmentAssistantOpen) setEnvironmentAssistantMounted(true);
  }, [environmentAssistantOpen]);
  const persistReconciledPaneModels = useCallback(async () => {
    const before = useAppStore.getState();
    const { changedPaneIds, activeChanged } = before.reconcilePaneModels();
    if (changedPaneIds.length === 0 && !activeChanged) return;
    const next = useAppStore.getState();
    if (next.activeProvider && next.activeModel) {
      await window.agenticxDesktop.saveConfig({
        activeProvider: next.activeProvider,
        activeModel: next.activeModel,
      });
    }
    for (const paneId of changedPaneIds) {
      const pane = next.panes.find((item) => item.id === paneId);
      const sid = String(pane?.sessionId ?? "").trim();
      const provider = String(pane?.modelProvider ?? "").trim();
      const model = String(pane?.modelName ?? "").trim();
      if (sid && provider && model) {
        await window.agenticxDesktop.setSessionModel({ sessionId: sid, provider, model });
      }
    }
  }, []);
  // Track live automation-triggered sessions; used to poll and refresh tool/message progress.
  const automationRunningRef = useRef<Map<string, Set<string>>>(new Map());
  const automationPollTimerRef = useRef<number | null>(null);
  const activePaneSessionId = useMemo(
    () => panes.find((pane) => pane.id === activePaneId)?.sessionId ?? sessionId,
    [activePaneId, panes, sessionId]
  );

  useEffect(() => {
    const onAddWorkspace = (event: Event) => {
      const detail = (event as CustomEvent<GlobalSearchAddToWorkspaceDetail>).detail;
      if (!detail?.folderPath) return;
      void addFolderToActiveWorkspace(detail.folderPath).then((result) => {
        if (result.ok) {
          setGlobalSearchToastMessage("已添加至工作区");
          setGlobalSearchToastVariant("default");
        } else {
          setGlobalSearchToastMessage(result.error ?? "添加工作区失败");
          setGlobalSearchToastVariant("warning");
        }
        setGlobalSearchToastOpen(true);
      });
    };
    window.addEventListener(GLOBAL_SEARCH_ADD_TO_WORKSPACE, onAddWorkspace);
    return () => window.removeEventListener(GLOBAL_SEARCH_ADD_TO_WORKSPACE, onAddWorkspace);
  }, []);

  useEffect(() => {
    const activePane = panes.find((pane) => pane.id === activePaneId);
    const sid = String(activePane?.sessionId ?? "").trim();
    if (!sid) return;
    rememberSessionForAvatar(activePane?.avatarId ?? null, sid);
  }, [activePaneId, panes]);
  const resolvePaneForSession = useCallback((sid: string, fallbackAgentId?: string) => {
    const store = useAppStore.getState();
    let pane = store.panes.find((p) => p.sessionId === sid);
    if (!pane && fallbackAgentId) {
      const mappedSid =
        subAgentSessionRef.current[fallbackAgentId] ??
        subAgentsRef.current.find((item) => item.id === fallbackAgentId)?.sessionId;
      if (mappedSid) {
        pane = store.panes.find((p) => p.sessionId === mappedSid);
      }
    }
    if (!pane) {
      const activePane = store.panes.find((p) => p.id === store.activePaneId);
      pane = activePane ?? store.panes[0];
    }
    return pane;
  }, []);

  const refreshMcpStatus = useCallback(async (sid?: string) => {
    // Allow empty sid: backend returns process-level MCP configs so the
    // Settings panel is not blocked by a not-yet-bound session (FR-3).
    const effectiveSid = sid || useAppStore.getState().sessionId || "";
    const status = await window.agenticxDesktop.loadMcpStatus(effectiveSid);
    if (status.ok && Array.isArray(status.servers)) {
      setMcpServers(
        status.servers.map((item) => ({
          name: item.name,
          connected: Boolean(item.connected),
          command: item.command,
          url: typeof item.url === "string" ? item.url : undefined,
          transport: typeof item.transport === "string" ? item.transport : undefined,
          connection_state: item.connection_state,
          tool_count: typeof item.tool_count === "number" ? item.tool_count : undefined,
          tool_names: Array.isArray(item.tool_names) ? (item.tool_names as string[]) : undefined,
          error_detail: item.error_detail,
          op_phase: typeof item.op_phase === "string" ? item.op_phase : undefined,
          op_message: typeof item.op_message === "string" ? item.op_message : undefined,
          op_updated_at: typeof item.op_updated_at === "number" ? item.op_updated_at : undefined,
        }))
      );
    }
  }, [setMcpServers]);

  const ensureMcpAutoConnectOnStartup = useCallback(async (sid?: string) => {
    const effectiveSid = (sid || useAppStore.getState().sessionId || "").trim();
    if (!effectiveSid) return;
    try {
      const [settings, status] = await Promise.all([
        window.agenticxDesktop.getMcpSettings(),
        window.agenticxDesktop.loadMcpStatus(effectiveSid),
      ]);
      if (!settings.ok || !Array.isArray(settings.auto_connect) || settings.auto_connect.length === 0) {
        return;
      }
      if (!status.ok || !Array.isArray(status.servers) || status.servers.length === 0) {
        return;
      }
      const wanted = new Set(settings.auto_connect.map((name) => String(name || "").trim()).filter(Boolean));
      if (wanted.size === 0) return;
      const toConnect = status.servers
        .filter((server) => wanted.has(server.name) && !server.connected)
        .map((server) => server.name);
      if (toConnect.length === 0) return;
      const results = await Promise.all(
        toConnect.map(async (name) => {
          try {
            const result = await window.agenticxDesktop.connectMcp({ sessionId: effectiveSid, name });
            return { name, ok: Boolean(result?.ok), error: result?.error };
          } catch (error) {
            return { name, ok: false, error: String(error) };
          }
        })
      );
      const failed = results.filter((item) => !item.ok);
      if (failed.length > 0) {
        console.warn(
          "[App init] MCP startup auto-connect partial failure:",
          failed.map((item) => ({ name: item.name, error: item.error })),
        );
      }
      await refreshMcpStatus(effectiveSid);
    } catch (error) {
      // Best effort: startup MCP auto-connect should never block app init.
      console.warn("[App init] MCP startup auto-connect failed:", error);
    }
  }, [refreshMcpStatus]);

  useEffect(() => {
    if (sessionInitDoneRef.current) return;
    sessionInitDoneRef.current = true;
    (async () => {
      try {
      const base = await window.agenticxDesktop.getApiBase();
      const token = await window.agenticxDesktop.getApiAuthToken();
      setApiBase(base);
      setApiToken(token);

      // Load basic user-config first so the UI can render ASAP.
      // 会话恢复/MCP 状态属于次要副作用，单独放后面；哪怕下面串行 /api/session 稍慢，也不会把 UI 卡在 loading。
      try {
        const cfgEarly = await window.agenticxDesktop.loadConfig();
        // 欢迎页已移除；主进程 load-config 始终返回 onboardingCompleted: true，
        // 并与旧配置中 onboarding_completed: false 做一次写回迁移。
        setOnboardingCompleted(true);
        // 旧配置里可能是已删掉的 "semi-auto"，统一迁移（见 constants 里的说明）。
        // 设置页的全局默认值由后端 permissions.mode 提供，下面单独拉一次；
        // 当前会话的实际值在 session 元数据中，不从桌面端配置读第二份。
        const entries = toProviderEntries(
          cfgEarly.providers ?? {},
          cfgEarly.enterprise?.modelCatalog ?? [],
        );
        // Strict managed mode: after enterprise login, only expose managed providers in the store.
        const ent = cfgEarly.enterprise;
        const managedOnly = ent?.enabled === true && ent?.strict !== false;
        const visibleEntries = managedOnly
          ? Object.fromEntries(Object.entries(entries).filter(([, e]) => e.managed === true))
          : entries;
        const defP = managedOnly
          ? (visibleEntries.enterprise ? "enterprise" : Object.keys(visibleEntries)[0] ?? "")
          : (cfgEarly.defaultProvider ?? "");
        const defEntry = visibleEntries[defP];
        updateSettings({
          defaultProvider: defP,
          providers: visibleEntries,
          provider: defP,
          model: defEntry?.model ?? "",
          apiKey: defEntry?.apiKey ?? "",
        });
        const savedActiveProvider = cfgEarly.activeProvider ?? "";
        const savedActiveModel = cfgEarly.activeModel ?? "";
        if (savedActiveProvider && savedActiveModel) {
          const coerced = coerceSelectableModel(
            visibleEntries,
            savedActiveProvider,
            savedActiveModel,
            savedActiveProvider,
          );
          if (coerced) {
            setActiveModel(coerced.provider, coerced.model);
            const currentPaneId = useAppStore.getState().activePaneId;
            const currentPane = useAppStore.getState().panes.find((pane) => pane.id === currentPaneId);
            const hasPaneModel = Boolean(currentPane?.modelProvider?.trim() && currentPane?.modelName?.trim());
            if (!hasPaneModel) {
              setPaneModel(currentPaneId, coerced.provider, coerced.model);
            }
          }
        } else if (defP) {
          const coerced = coerceSelectableModel(visibleEntries, defP, defEntry?.model ?? "", defP);
          if (coerced) {
            setActiveModel(coerced.provider, coerced.model);
            const currentPaneId = useAppStore.getState().activePaneId;
            const currentPane = useAppStore.getState().panes.find((pane) => pane.id === currentPaneId);
            const hasPaneModel = Boolean(currentPane?.modelProvider?.trim() && currentPane?.modelName?.trim());
            if (!hasPaneModel) {
              setPaneModel(currentPaneId, coerced.provider, coerced.model);
            }
          }
        }
      } catch (err) {
        console.error("[App init] loadConfig failed:", err);
      }

      setConfigLoaded(true);

      // Background: drop historically visible models that the current key cannot call
      // (gateway Model Auth). Must not block splash / startupRendererReady.
      void (async () => {
        try {
          const providers = useAppStore.getState().settings.providers ?? {};
          const result = await scanAndPruneUnauthorizedVisibleModels({
            providers,
            healthCheck: (payload) => window.agenticxDesktop.healthCheckModel(payload),
          });
          if (result.removed.length === 0) return;

          for (const providerId of result.changedProviderIds) {
            const entry = result.providers[providerId];
            if (!entry) continue;
            await window.agenticxDesktop.saveProvider({
              name: providerId,
              apiKey: entry.apiKey || undefined,
              baseUrl: entry.baseUrl || undefined,
              model: entry.model || undefined,
              models: entry.models,
              enabled: entry.enabled,
              dropParams: entry.dropParams,
              ...(entry.displayName !== undefined
                ? { displayName: entry.displayName.trim() }
                : {}),
              ...(entry.interface === "openai" || entry.interface === "ollama"
                ? { interface: entry.interface }
                : {}),
            });
          }

          const defP = useAppStore.getState().settings.defaultProvider ?? "";
          const defEntry = result.providers[defP];
          updateSettings({
            providers: result.providers,
            ...(defEntry
              ? {
                  model: defEntry.model ?? "",
                  apiKey: defEntry.apiKey ?? "",
                }
              : {}),
          });

          const store = useAppStore.getState();
          const activeProvider = (store.activeProvider || defP || "").trim();
          const activeModel = (store.activeModel || "").trim();
          if (
            activeProvider
            && activeModel
            && !isModelSelectable(activeProvider, activeModel, result.providers)
          ) {
            const coerced = coerceSelectableModel(
              result.providers,
              activeProvider,
              activeModel,
              activeProvider || defP,
            );
            if (coerced) {
              setActiveModel(coerced.provider, coerced.model);
            }
          }
          await persistReconciledPaneModels();

          setGlobalSearchToastMessage(
            `已移出 ${result.removed.length} 个未授权模型`,
          );
          setGlobalSearchToastVariant("warning");
          setGlobalSearchToastOpen(true);
        } catch (err) {
          console.warn("[App init] prune unauthorized visible models failed:", err);
        }
      })();

      // Splash 预加载分身 / 会话列表 / 工作区 / 活跃 session 消息，再关 splash 进主窗。
      await runSplashCorePreload();

      if (!startupRendererReadyRef.current) {
        startupRendererReadyRef.current = true;
        try {
          await window.agenticxDesktop.startupRendererReady();
        } catch (err) {
          console.warn("[App init] startupRendererReady failed:", err);
          startupRendererReadyRef.current = false;
        }
      }

      // Fallback when splash preload did not populate avatars (timeout / disabled).
      if (useAppStore.getState().avatars.length === 0) {
        try {
          const avatars = await fetchAvatarsWithStartupRetry(() =>
            window.agenticxDesktop.listAvatars()
          );
          if (avatars.length > 0) {
            useAppStore.getState().setAvatars(avatars);
          }
        } catch (err) {
          console.error("[App init] preload avatars fallback failed:", err);
        }
      }

      // Fallback when splash preload did not populate group chats (timeout / disabled).
      // Groups previously had no startup fallback at all (unlike avatars/sessions),
      // so a slow backend cold start left the 群聊 sidebar empty permanently.
      if (useAppStore.getState().groups.length === 0) {
        try {
          const groups = await fetchGroupsWithStartupRetry(() =>
            window.agenticxDesktop.listGroups()
          );
          if (groups.length > 0) {
            useAppStore.getState().setGroups(groups);
          }
        } catch (err) {
          console.error("[App init] preload groups fallback failed:", err);
        }
      }

      let recovered = false;
      try {
        const raw = readScopedLocalStorage(WORKSPACE_STATE_STORAGE_KEY);
        const parsed = raw ? JSON.parse(raw) : null;
        const saved = normalizePersistedWorkspaceState(parsed);
        const sessionsCache = new Map<string, SessionListItem[]>();
        const recentSidCache = new Map<string, string>();
        const getSessionsForAvatar = async (avatarId?: string | null): Promise<SessionListItem[]> => {
          const key = (avatarId ?? "").trim();
          if (sessionsCache.has(key)) return sessionsCache.get(key) ?? [];
          const preloadState = useAppStore.getState();
          const preloadKey = avatarPreloadKey(avatarId);
          if (
            preloadState.corePreloadAttempted &&
            Object.prototype.hasOwnProperty.call(
              preloadState.preloadedSessionsByAvatarKey,
              preloadKey
            )
          ) {
            const raw = preloadState.preloadedSessionsByAvatarKey[preloadKey];
            const normalized = (Array.isArray(raw) ? raw : []).filter((item) =>
              isSessionItemMatchingAvatar(item as SessionListItem, key || undefined)
            ) as SessionListItem[];
            sessionsCache.set(key, normalized);
            return normalized;
          }
          try {
            const rawSessions = await fetchSessionsWithStartupRetry(
              (avatarKey) => window.agenticxDesktop.listSessions(avatarKey),
              key || undefined
            );
            if (rawSessions.length === 0) {
              sessionsCache.set(key, []);
              return [];
            }
            const normalized = rawSessions.filter((item) =>
              isSessionItemMatchingAvatar(item as SessionListItem, key || undefined)
            ) as SessionListItem[];
            sessionsCache.set(key, normalized);
            return normalized;
          } catch {
            sessionsCache.set(key, []);
            return [];
          }
        };
        const isSessionCompatible = async (sid: string, avatarId?: string | null): Promise<boolean> => {
          const needle = sid.trim();
          if (!needle) return false;
          const rows = await getSessionsForAvatar(avatarId);
          return rows.some((item) => String(item.session_id ?? "").trim() === needle);
        };
        const getRecentSessionId = async (avatarId?: string | null): Promise<string | undefined> => {
          const key = (avatarId ?? "").trim();
          if (recentSidCache.has(key)) return recentSidCache.get(key) || undefined;
          const rows = await getSessionsForAvatar(key || undefined);
          if (rows.length === 0) {
            recentSidCache.set(key, "");
            return undefined;
          }
          const sid = pickMostRecentSessionId(rows, key || undefined);
          recentSidCache.set(key, sid ?? "");
          return sid;
        };
        if (saved) {
          const hydratedPanes: PersistedPaneState[] = [];
          const claimedSessionIds = new Set<string>();
          for (const pane of saved.panes) {
            try {
              const isGroupPane = String(pane.avatarId ?? "").startsWith("group:");
              const isAutomationTaskPane = String(pane.avatarId ?? "").startsWith("automation:");
              const lazyEligible = !isGroupPane && !isAutomationTaskPane;

              let wantedSid = String(pane.sessionId ?? "").trim();
              if (wantedSid && !(await isSessionCompatible(wantedSid, pane.avatarId))) {
                wantedSid = "";
              }

              if (!wantedSid && !lazyEligible) {
                const recent = await getRecentSessionId(pane.avatarId ?? undefined);
                wantedSid = String(recent ?? "").trim();
              }

              if (wantedSid && claimedSessionIds.has(wantedSid)) {
                console.warn(
                  "[App init] duplicate sessionId %s across panes — forcing new session for pane %s (avatar=%s)",
                  wantedSid,
                  pane.id,
                  pane.avatarId,
                );
                if (lazyEligible) {
                  wantedSid = "";
                } else {
                  const sid = await requestSession(base, token, { avatarId: pane.avatarId });
                  claimedSessionIds.add(sid);
                  hydratedPanes.push({ ...pane, sessionId: sid });
                  continue;
                }
              }

              if (!wantedSid) {
                if (lazyEligible) {
                  hydratedPanes.push({ ...pane, sessionId: "" });
                  continue;
                }
                const sid = await requestSession(base, token, { avatarId: pane.avatarId });
                claimedSessionIds.add(sid);
                hydratedPanes.push({ ...pane, sessionId: sid });
                continue;
              }

              // Pass sessionId and avatarId together so /api/session can validate binding and
              // create a correctly scoped session if the old sid is missing (restart / mismatch).
              const sid = await requestSession(
                base,
                token,
                { sessionId: wantedSid, avatarId: pane.avatarId }
              );
              claimedSessionIds.add(sid);
              hydratedPanes.push({ ...pane, sessionId: sid });
            } catch (err) {
              console.error("[App init] restore pane failed:", pane.id, err);
            }
          }
          if (hydratedPanes.length > 0) {
            const nextActivePaneId =
              hydratedPanes.some((pane) => pane.id === saved.activePaneId)
                ? saved.activePaneId
                : hydratedPanes[0].id;
            useAppStore.setState({
              panes: hydratedPanes.map((pane) => ({
                ...pane,
                messages: [],
                sessionTokens: normalizeSessionTokens(pane.sessionTokens),
                historySearchTerms: [],
                historyJumpMessageId: null,
                loadingMessages: false,
                // Paging state is runtime-only: restored panes start empty and
                // re-run tail-first loading, so always reset to defaults here.
                oldestLoadedIndex: 0,
                hasOlderMessages: false,
                loadingOlderMessages: false,
                modelProvider: pane.modelProvider ?? "",
                modelName: pane.modelName ?? "",
                reasoningEffort: pane.reasoningEffort,
                thinkingEnabled: pane.thinkingEnabled,
                membersPanelOpen: pane.membersPanelOpen ?? false,
                graphPanelOpen: pane.graphPanelOpen ?? false,
                activeGraphRunId: pane.activeGraphRunId ?? null,
                memoryGraphOpen: pane.memoryGraphOpen ?? false,
                sidePanelTab: pane.sidePanelTab ?? "workspace",
                spawnsColumnOpen: pane.spawnsColumnOpen ?? false,
                spawnsColumnSuppressAuto: pane.spawnsColumnSuppressAuto ?? false,
                spawnsColumnBaselineIds: pane.spawnsColumnBaselineIds ?? [],
                // 落盘 drawer 是「按 run 查看」的临时检视面板，不跨重启恢复：
                // 恢复后 runId 可能属于旧/别的会话，自动弹出会显示 "run not found"。
                // 重启后一律收起，用户点集群卡成员再打开当前会话的 run。
                runDrawerOpen: false,
                runDrawerRunId: null,
                terminalTabs: [],
                activeTerminalTabId: null,
              })),
              activePaneId: nextActivePaneId,
            });
            // Re-apply sid bindings so store can restore per-session token cache
            // and seed the model from the newly-returned session.provider/model
            // field (S1). If the session has no remembered model, the store
            // fallback chain (avatar.default > global.default) kicks in.
            for (const pane of hydratedPanes) {
              let hintProvider: string | undefined;
              let hintModel: string | undefined;
              const sid = String(pane.sessionId ?? "").trim();
              if (sid) {
                const rows = await getSessionsForAvatar(pane.avatarId ?? undefined).catch(() => []);
                const row = rows.find((r) => String(r.session_id ?? "").trim() === sid);
                hintProvider = row?.provider?.trim() || undefined;
                hintModel = row?.model?.trim() || undefined;
                if (row?.permission_mode) setSessionRunMode(sid, row.permission_mode);
              }
              setPaneSessionId(pane.id, pane.sessionId, {
                provider: hintProvider,
                model: hintModel,
              });
            }
            // After binding, ensure activeProvider/activeModel follows the active pane.
            const activeState = useAppStore.getState();
            const activePane = activeState.panes.find((p) => p.id === activeState.activePaneId);
            if (activePane?.modelProvider && activePane?.modelName) {
              activeState.setActiveModel(activePane.modelProvider, activePane.modelName);
            }
            if (activePane) {
              const activeSid = String(activePane.sessionId ?? "").trim();
              if (activeSid) {
                const cached = activeState.getCachedSessionMessages(activeSid);
                if (cached && cached.length > 0) {
                  activeState.setPaneMessages(activePane.id, cached);
                }
              }
            }
            const metaPane = hydratedPanes.find((pane) => pane.id === "pane-meta");
            const nextSessionId =
              (metaPane?.sessionId ?? "").trim() ||
              (hydratedPanes.find((pane) => pane.id === nextActivePaneId)?.sessionId ?? "").trim() ||
              saved.sessionId;
            if (nextSessionId) {
              setSessionId(nextSessionId);
              await refreshMcpStatus(nextSessionId).catch(() => {});
              await ensureMcpAutoConnectOnStartup(nextSessionId).catch(() => {});
              recovered = true;
            }
          }
        }
      } catch (err) {
        console.error("[App init] restore workspace state failed:", err);
      }

      if (!recovered) {
        let sessionBound = false;
        const latestSid = await (async () => {
          try {
            const listed = await window.agenticxDesktop.listSessions();
            if (!listed.ok || !Array.isArray(listed.sessions) || listed.sessions.length === 0) return undefined;
            useAppStore.getState().hydrateAttachmentRoutingLocksFromSessions(listed.sessions);
            return pickMostRecentSessionId(listed.sessions, null);
          } catch {
            return undefined;
          }
        })();
        if (latestSid) {
          try {
            const sid = await requestSession(base, token, { sessionId: latestSid });
            setSessionId(sid);
            setPaneSessionId("pane-meta", sid);
            await refreshMcpStatus(sid).catch(() => {});
            await ensureMcpAutoConnectOnStartup(sid).catch(() => {});
            sessionBound = true;
            recovered = true;
          } catch (err) {
            console.error("[App init] reuse latest session failed:", err);
          }
        }
        if (!sessionBound) {
          // Align with ChatPane lazy-create: no empty server session on cold start.
          setSessionId("");
          setPaneSessionId("pane-meta", "");
          await refreshMcpStatus("").catch(() => {});
          recovered = true;
        }
      }

      // Final safety net for old/bad workspace snapshots: if the active pane
      // is still model-less after all restore branches, rehydrate from
      // config-level activeProvider/activeModel.
      const bootState = useAppStore.getState();
      const bootActivePane = bootState.panes.find((p) => p.id === bootState.activePaneId);
      const paneProvider = String(bootActivePane?.modelProvider ?? "").trim();
      const paneModel = String(bootActivePane?.modelName ?? "").trim();
      const cfgProvider = String(bootState.activeProvider ?? "").trim();
      const cfgModel = String(bootState.activeModel ?? "").trim();
      if ((!paneProvider || !paneModel) && cfgProvider && cfgModel) {
        bootState.setPaneModel(bootState.activePaneId, cfgProvider, cfgModel);
      }
      await persistReconciledPaneModels();

      window.agenticxDesktop.onOpenSettings(() => openSettings());
      workspaceHydratedRef.current = true;
      } catch (err) {
        console.error("[App init] fatal", err);
      } finally {
        // 兜底：任何异常也要放行 UI。
        setConfigLoaded(true);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ensureMcpAutoConnectOnStartup, refreshMcpStatus]);

  useEffect(() => {
    const off = window.agenticxDesktop.onStudioReady(() => {
      if (studioReadyRefetchDoneRef.current) return;
      studioReadyRefetchDoneRef.current = true;

      void (async () => {
        const state = useAppStore.getState();

        if (state.avatars.length === 0) {
          try {
            const avatars = await fetchAvatarsWithStartupRetry(() =>
              window.agenticxDesktop.listAvatars()
            );
            if (avatars.length > 0) {
              useAppStore.getState().setAvatars(avatars);
            }
          } catch (err) {
            console.error("[App] studio-ready avatars refetch failed:", err);
          }
        }

        if (useAppStore.getState().groups.length === 0) {
          try {
            const groups = await fetchGroupsWithStartupRetry(() =>
              window.agenticxDesktop.listGroups()
            );
            if (groups.length > 0) {
              useAppStore.getState().setGroups(groups);
            }
          } catch (err) {
            console.error("[App] studio-ready groups refetch failed:", err);
          }
        }

        const latest = useAppStore.getState();
        const activePane = latest.panes.find((pane) => pane.id === latest.activePaneId);
        const avatarId = activePane?.avatarId ?? null;
        const sessionsKey = avatarPreloadKey(avatarId);
        const existingRaw = latest.preloadedSessionsByAvatarKey[sessionsKey];
        const sessionsEmpty = !Array.isArray(existingRaw) || existingRaw.length === 0;
        if (sessionsEmpty) {
          try {
            const rawSessions = await fetchSessionsWithStartupRetry(
              (key) => window.agenticxDesktop.listSessions(key),
              avatarId ?? undefined
            );
            const normalized = rawSessions.filter((item) =>
              isSessionItemMatchingAvatar(item as SessionListItem, avatarId ?? undefined)
            );
            if (normalized.length > 0) {
              useAppStore.getState().applyCorePreloadBundle({
                sessionsKey,
                sessions: normalized,
              });
            }
          } catch (err) {
            console.error("[App] studio-ready sessions refetch failed:", err);
          }
        }
      })();
    });
    return off;
  }, []);

  useEffect(() => {
    if (!workspaceHydratedRef.current) return;
    const snapshot: PersistedWorkspaceState = {
      sessionId,
      activePaneId,
      panes: panes.map((pane) => ({
        id: pane.id,
        avatarId: pane.avatarId,
        avatarName: pane.avatarName,
        sessionId: pane.sessionId,
        modelProvider: pane.modelProvider,
        modelName: pane.modelName,
        reasoningEffort: pane.reasoningEffort,
        thinkingEnabled: pane.thinkingEnabled,
        historyOpen: pane.historyOpen,
        memoryGraphOpen: pane.memoryGraphOpen,
        contextInherited: pane.contextInherited,
        taskspacePanelOpen: pane.taskspacePanelOpen,
        membersPanelOpen: pane.membersPanelOpen,
        graphPanelOpen: pane.graphPanelOpen ?? false,
        activeGraphRunId: pane.activeGraphRunId ?? null,
        sidePanelTab: pane.sidePanelTab,
        activeTaskspaceId: pane.activeTaskspaceId,
        spawnsColumnOpen: pane.spawnsColumnOpen,
        spawnsColumnSuppressAuto: pane.spawnsColumnSuppressAuto,
        spawnsColumnBaselineIds: pane.spawnsColumnBaselineIds,
        runDrawerOpen: pane.runDrawerOpen,
        runDrawerRunId: pane.runDrawerRunId,
        sessionTokens: pane.sessionTokens,
      })),
    };
    try {
      writeScopedLocalStorage(WORKSPACE_STATE_STORAGE_KEY, JSON.stringify(snapshot));
    } catch {
      // ignore storage failures
    }
  }, [sessionId, activePaneId, panes]);

  useEffect(() => {
    subAgentsRef.current = subAgents;
  }, [subAgents]);

  useEffect(() => {
    if (!selectedSubAgent) return;
    const selected = subAgents.find((item) => item.id === selectedSubAgent);
    if (!selected) {
      setSelectedSubAgent(null);
      return;
    }
    const selectedSid = (selected.sessionId ?? "").trim();
    if (selectedSid && activePaneSessionId && selectedSid !== activePaneSessionId) {
      setSelectedSubAgent(null);
    }
  }, [selectedSubAgent, subAgents, activePaneSessionId, setSelectedSubAgent]);

  const syncSubAgents = useCallback(async () => {
    if (!apiBase || !apiToken) return;
    const sessionIds = Array.from(
      new Set(
        [sessionId, ...panes.map((pane) => pane.sessionId)]
          .map((item) => item.trim())
          .filter((item) => item.length > 0)
      )
    );
    if (sessionIds.length === 0) return;

    const runningAgents = subAgentsRef.current.filter(
      (s) => s.status === "running" || s.status === "pending" || s.status === "awaiting_confirm"
    );

    const seenRunningOrPending = new Set<string>();
    for (const sid of sessionIds) {
      try {
        const resp = await fetch(
          `${apiBase}/api/subagents/status?session_id=${encodeURIComponent(sid)}`,
          { headers: { "x-agx-desktop-token": apiToken } }
        );
        if (!resp.ok) continue;
        const data = (await resp.json()) as {
          subagents?: Array<{
            agent_id: string;
            name?: string;
            role?: string;
            provider?: string;
            model?: string;
            task?: string;
            status?: "pending" | "running" | "paused" | "completed" | "failed" | "cancelled";
            result_summary?: string;
            result_file?: string;
            output_files?: string[];
            error_text?: string;
            recent_events?: Array<{ type?: string; data?: Record<string, unknown> }>;
            pending_confirm?: { request_id?: string; question?: string; context?: Record<string, unknown> } | null;
            pending_clarification?: {
              request_id?: string;
              prompt?: string;
              options?: string[] | null;
              allow_free_text?: boolean | null;
              context?: Record<string, unknown> | null;
            } | null;
          }>;
        };
        if (!Array.isArray(data.subagents)) continue;

        for (const item of data.subagents) {
          const id = (item.agent_id ?? "").trim();
          if (!id) continue;
          subAgentSessionRef.current[id] = sid;

          const exists = subAgentsRef.current.some((sub) => sub.id === id);
          if (!exists) {
            addSubAgent({
              id,
              name: item.name ?? id,
              role: item.role ?? "worker",
              provider: item.provider ?? undefined,
              model: item.model ?? undefined,
              task: item.task ?? "",
              sessionId: sid,
            });
          }

          const status = item.status ?? "running";
          const existing = subAgentsRef.current.find((sub) => sub.id === id);
          const hasPendingConfirm = !!(item.pending_confirm?.request_id);
          const hasPendingClarification = !!(item.pending_clarification?.request_id);
          const effectiveStatus =
            hasPendingConfirm
              ? "awaiting_confirm" as const
              : hasPendingClarification
                ? "awaiting_input" as const
                : existing?.status === "awaiting_confirm" && status === "running"
                  ? "awaiting_confirm" as const
                  : existing?.status === "awaiting_input" && status === "running"
                    ? "awaiting_input" as const
                    : status;
          if (status === "running" || status === "pending") {
            seenRunningOrPending.add(id);
            staleMissCountRef.current[id] = 0;
          }
          if (hasPendingConfirm || hasPendingClarification) {
            seenRunningOrPending.add(id);
            staleMissCountRef.current[id] = 0;
          }
          const summaryText = (item.result_summary ?? "").trim();
          const resultFile =
            typeof item.result_file === "string" && item.result_file.trim()
              ? item.result_file.trim()
              : undefined;
          const outputFiles = resolveSubAgentOutputPaths(summaryText, {
            resultFile,
            outputFiles: Array.isArray(item.output_files)
              ? item.output_files.map((p) => String(p))
              : undefined,
          });
          const currentAction =
            effectiveStatus === "awaiting_confirm"
              ? existing?.currentAction || "等待你的确认"
              : effectiveStatus === "awaiting_input"
                ? existing?.currentAction || "等待你的输入"
              : status === "completed"
              ? summaryText
                ? "已完成（查看摘要）"
                : "已完成"
              : status === "failed"
                ? item.error_text || "执行异常"
                : status === "cancelled"
                  ? "已中断"
                  : status === "paused"
                    ? summaryText || item.error_text || "已暂停，可稍后继续"
                  : "执行中";
          const pendingConfirm =
            hasPendingConfirm
              ? {
                  requestId: String(item.pending_confirm!.request_id ?? ""),
                  question: String(item.pending_confirm!.question ?? "是否确认执行？"),
                  agentId: id,
                  sessionId: sid,
                  context: item.pending_confirm!.context,
                }
              : effectiveStatus !== "awaiting_confirm"
                ? undefined
                : existing?.pendingConfirm;
          const pendingClarification =
            hasPendingClarification
              ? {
                  requestId: String(item.pending_clarification!.request_id ?? ""),
                  prompt: String(item.pending_clarification!.prompt ?? ""),
                  options: Array.isArray(item.pending_clarification!.options)
                    ? item.pending_clarification!.options.map((o: unknown) => String(o)).filter(Boolean)
                    : [],
                  allowFreeText: item.pending_clarification!.allow_free_text !== false,
                  agentId: id,
                  sessionId: sid,
                  context: item.pending_clarification!.context ?? undefined,
                }
              : effectiveStatus !== "awaiting_input"
                ? undefined
                : existing?.pendingClarification;
          updateSubAgent(id, {
            status: effectiveStatus,
            currentAction,
            provider: item.provider ?? existing?.provider,
            model: item.model ?? existing?.model,
            resultSummary: summaryText || undefined,
            resultFile,
            outputFiles,
            pendingConfirm,
            pendingClarification,
          });

          if (
            (effectiveStatus === "completed" || effectiveStatus === "failed" || effectiveStatus === "paused") &&
            !completionNotifiedRef.current.has(id)
          ) {
            completionNotifiedRef.current.add(id);
            const agentName = item.name ?? id;
            const emoji = effectiveStatus === "completed" ? "✅" : effectiveStatus === "paused" ? "⏸" : "❌";
            const statusLabel =
              effectiveStatus === "completed"
                ? "已完成"
                : effectiveStatus === "paused"
                  ? "已暂停"
                  : "执行失败";
            const summaryBody = summaryText || (
              effectiveStatus === "failed"
                ? (item.error_text || "未知错误")
                : effectiveStatus === "paused"
                  ? (item.error_text || "任务已暂停，可稍后继续")
                  : "任务已结束"
            );
            const completionMsg = `${emoji} **子智能体 ${agentName} ${statusLabel}**\n\n${summaryBody}`;
            const store = useAppStore.getState();
            const matchingPane = resolvePaneForSession(sid, id);
            if (matchingPane) {
              store.addPaneMessage(matchingPane.id, "tool", completionMsg, id);
            }
            console.debug("[auto-report] enqueue: agent=%s name=%s status=%s sid=%s", id, agentName, effectiveStatus, sid);
            autoReportQueueRef.current.push({
              agentId: id,
              agentName,
              summary: summaryBody,
              sessionId: sid,
              status:
                effectiveStatus === "completed"
                  ? "completed"
                  : effectiveStatus === "paused"
                    ? "paused"
                    : "failed",
              attempts: 0,
            });
          }

          const seen = polledEventSeenRef.current[id] ?? new Set<string>();
          polledEventSeenRef.current[id] = seen;
          for (const evt of item.recent_events ?? []) {
            const evtType = String(evt?.type ?? "");
            const evtData = (evt?.data ?? {}) as Record<string, unknown>;
            const signature = `${evtType}:${JSON.stringify(evtData)}`;
            if (seen.has(signature)) continue;
            seen.add(signature);
            if (seen.size > 300) {
              const first = seen.values().next().value as string | undefined;
              if (first) seen.delete(first);
            }
            const text =
              typeof evtData.text === "string" && evtData.text.trim()
                ? evtData.text
                : `${evtType || "event"}: ${JSON.stringify(evtData)}`;
            addSubAgentEvent(id, { type: evtType || "event", content: text });
            if (evtType === "confirm_required") {
              const reqId = String(evtData.id ?? evtData.request_id ?? "");
              const question = String(evtData.question ?? "是否确认执行？");
              const confirmCtx = (evtData.context ?? undefined) as Record<string, unknown> | undefined;
              updateSubAgent(id, {
                status: "awaiting_confirm",
                currentAction: "等待你的确认",
                pendingConfirm: reqId
                  ? { requestId: reqId, question, agentId: id, sessionId: sid, context: confirmCtx }
                  : undefined,
              });
            } else if (evtType === "confirm_response") {
              const approved = !!evtData.approved;
              updateSubAgent(id, {
                status: approved ? "running" : "cancelled",
                currentAction: approved ? "确认通过，继续执行" : "确认拒绝，已取消",
                pendingConfirm: undefined,
              });
            }
          }
        }
      } catch {
        // ignore polling failures
      }
    }

    // Guard against stale "running" badges when SSE stream closed early.
    // Do NOT auto-mark as completed when backend has no record; that's misleading.
    for (const item of subAgentsRef.current) {
      if (item.status !== "running" && item.status !== "pending" && item.status !== "awaiting_confirm") continue;
      if (seenRunningOrPending.has(item.id)) continue;
      const lastRealEvtTs =
        [...item.events].reverse().find((evt) => evt.type !== "sync")?.ts ?? 0;
      if (lastRealEvtTs > 0 && Date.now() - lastRealEvtTs < 15000) {
        // SSE has recent activity; avoid false "lost sync" warnings.
        staleMissCountRef.current[item.id] = 0;
        continue;
      }
      const miss = (staleMissCountRef.current[item.id] ?? 0) + 1;
      staleMissCountRef.current[item.id] = miss;
      if (miss === 5) {
        addSubAgentEvent(item.id, {
          type: "sync",
          content: "轮询暂未发现该任务，可能会话已切换或任务已归档，继续同步中",
        });
      } else if (miss === 10) {
        updateSubAgent(item.id, {
          currentAction: "状态失联：后台暂未返回该任务，建议展开详情并重试同步",
        });
        addSubAgentEvent(item.id, {
          type: "sync",
          content: "连续轮询未找到后台记录，已标记为状态失联提示（不自动改写为完成/失败）",
        });
      }
    }
  }, [apiBase, apiToken, sessionId, panes, addSubAgent, updateSubAgent, addSubAgentEvent]);

  const triggerMetaReport = useCallback(async () => {
    if (autoReportingRef.current) {
      console.debug("[auto-report] skipped: already reporting");
      return;
    }
    const queue = autoReportQueueRef.current;
    if (queue.length === 0) return;
    if (!apiBase || !apiToken) return;

    console.debug("[auto-report] START: %d items in queue", queue.length, queue.map((q) => `${q.agentName}:${q.status}`));
    autoReportingRef.current = true;
    // Snapshot only; dequeue on success to avoid silent message loss.
    const batch = [...queue];

    // Group by session so each session's Meta-Agent gets one message
    const bySession = new Map<string, typeof batch>();
    for (const item of batch) {
      const existing = bySession.get(item.sessionId) ?? [];
      existing.push(item);
      bySession.set(item.sessionId, existing);
    }
    const deliveredAgentIds = new Set<string>();
    const retryAgentIds = new Set<string>();

    try {
      for (const [sid, items] of bySession) {
        const store = useAppStore.getState();
        const matchingPane = resolvePaneForSession(sid, items[0]?.agentId);
        if (!matchingPane) {
          for (const it of items) retryAgentIds.add(it.agentId);
          continue;
        }
        const emitDirectNotice = () => {
          const shouldEmit = items.some(
            (it) => (it.attempts ?? 0) === 0 && !directNoticeSentRef.current.has(it.agentId)
          );
          if (!shouldEmit) return;
          for (const it of items) directNoticeSentRef.current.add(it.agentId);
          const lines = items
            .map((it) => `- ${it.agentName}(${it.agentId}): ${it.summary.slice(0, 220)}`)
            .join("\n");
          store.addPaneMessage(
            matchingPane.id,
            "tool",
            `⚠️ 子智能体已结束，但 ${META_AGENT_DISPLAY_NAME} 自动汇报暂未成功。先给你直接结果：\n${lines}`,
            "meta"
          );
        };

        const agentLines = items
          .map((it) => {
            const state = it.status === "completed" ? "已完成" : it.status === "paused" ? "已暂停" : "失败";
            return `- 【${it.agentName}】(${it.agentId}) [${state}]: ${it.summary.slice(0, 300)}`;
          })
          .join("\n");
        const triggerMsg =
          `[系统通知] 以下子智能体已结束或暂停（可能成功、失败或因限流/轮次触顶暂停），请立即向用户主动汇报：完成情况/暂停原因/失败原因、产出文件列表、下一步建议。\n${agentLines}`;

        const paneProvider = String(matchingPane.modelProvider ?? "").trim();
        const paneModel = String(matchingPane.modelName ?? "").trim();
        const activeProvider = paneProvider || store.activeProvider;
        const activeModel = paneModel || store.activeModel;
        const body: Record<string, unknown> = { session_id: sid, user_input: triggerMsg };
        if (activeProvider) body.provider = activeProvider;
        if (activeModel) body.model = activeModel;

        try {
          const resp = await fetch(`${apiBase}/api/chat`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-agx-desktop-token": apiToken },
            body: JSON.stringify(body),
          });
          if (!resp.ok || !resp.body) {
            emitDirectNotice();
            for (const it of items) retryAgentIds.add(it.agentId);
            continue;
          }

          const reader = resp.body.getReader();
          const decoder = new TextDecoder();
          let full = "";
          let buffer = "";
          let placeholderAdded = false;
          let reportResponded = false;

          while (true) {
            const { value: chunk, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(chunk, { stream: true });
            const frames = buffer.split("\n\n");
            buffer = frames.pop() ?? "";
            for (const frame of frames) {
              const line = frame.split("\n").find((l) => l.startsWith("data: "));
              if (!line) continue;
              try {
                const payload = JSON.parse(line.slice(6));
                if (payload.type === "token") {
                  const tokenText = String(payload.data?.text ?? payload.data?.content ?? "");
                  if (tokenText.length === 0) continue;
                  reportResponded = true;
                  full += tokenText;
                  const s = useAppStore.getState();
                  if (!placeholderAdded) {
                    s.addPaneMessage(matchingPane.id, "assistant", full, "meta");
                    placeholderAdded = true;
                  } else {
                    s.updateLastPaneMessage(matchingPane.id, full);
                  }
                }
                if (payload.type === "final") {
                  const finalText = String(payload.data?.text ?? payload.data?.content ?? "").trim();
                  if (finalText) {
                    reportResponded = true;
                    const s = useAppStore.getState();
                    if (!placeholderAdded) {
                      s.addPaneMessage(matchingPane.id, "assistant", finalText, "meta");
                    } else {
                      s.updateLastPaneMessage(matchingPane.id, finalText);
                    }
                  }
                }
              } catch {
                // ignore malformed frames
              }
            }
          }
          if (reportResponded) {
            console.debug("[auto-report] Meta responded for sid=%s, delivered=%d", sid, items.length);
            for (const it of items) deliveredAgentIds.add(it.agentId);
          } else {
            console.debug("[auto-report] Meta did NOT respond for sid=%s, retrying %d items", sid, items.length);
            emitDirectNotice();
            for (const it of items) retryAgentIds.add(it.agentId);
          }
        } catch {
          // network error on auto-report is non-fatal, retry later.
          emitDirectNotice();
          for (const it of items) retryAgentIds.add(it.agentId);
        }
      }
      if (deliveredAgentIds.size > 0 || retryAgentIds.size > 0) {
        autoReportQueueRef.current = autoReportQueueRef.current
          .filter((it) => !deliveredAgentIds.has(it.agentId))
          .map((it) => {
            if (!retryAgentIds.has(it.agentId)) return it;
            return { ...it, attempts: (it.attempts ?? 0) + 1 };
          })
          .filter((it) => {
            // Avoid endless retries; after several failures, keep one visible notice and drop.
            if ((it.attempts ?? 0) <= 3) return true;
            const s = useAppStore.getState();
            const p = resolvePaneForSession(it.sessionId, it.agentId);
            if (p) {
              s.addPaneMessage(
                p.id,
                "tool",
                `⚠️ 子智能体 ${it.agentName} 已${it.status === "completed" ? "完成" : "失败"}，但自动汇报触发失败。请手动询问一次进展。`,
                "meta"
              );
            }
            return false;
          });
      }
    } finally {
      autoReportingRef.current = false;
    }
  }, [apiBase, apiToken, resolvePaneForSession]);

  useEffect(() => {
    if (!apiBase || !apiToken) return;
    const pollAndReport = async () => {
      await syncSubAgents();
      if (autoReportQueueRef.current.length > 0) {
        console.debug("[auto-report] queue=%d, firing triggerMetaReport", autoReportQueueRef.current.length);
        void triggerMetaReport();
      }
    };
    void pollAndReport();
    // Use a short base interval; the actual poll frequency is fast enough for both
    // active and idle scenarios without needing to tear down on subAgents changes.
    const timer = window.setInterval(() => void pollAndReport(), 2000);
    return () => window.clearInterval(timer);
    // Intentionally exclude subAgents from deps to avoid interval teardown on every
    // status update, which was causing auto-report queue to be reset before firing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiBase, apiToken, syncSubAgents, triggerMetaReport]);

  useEffect(() => {
    try {
      const savedSidebarWidth = window.localStorage.getItem("agx-sidebar-width");
      if (savedSidebarWidth) {
        document.documentElement.style.setProperty("--sidebar-width", savedSidebarWidth);
      }
    } catch {
      // ignore storage failures
    }
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const layout = await window.agenticxDesktop.loadLayout();
        if (!layout.ok) return;
        const saved = parsePersistedThemeMode(layout.theme);
        if (saved) {
          if (useAppStore.getState().theme !== saved) {
            setTheme(saved);
          }
          return;
        }
        // First run after upgrade: seed $AGX_HOME/layout.json from localStorage.
        const current = useAppStore.getState().theme;
        if (current === "light" || current === "dark" || current === "dim") {
          void window.agenticxDesktop.saveUiPrefs({ theme: current });
        }
      } catch {
        // ignore; localStorage fallback from store init remains
      }
    })();
  }, [setTheme]);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    document.documentElement.setAttribute("data-theme-color", themeColor);
    void window.agenticxDesktop.syncTitleBarOverlay(theme);
  }, [theme, themeColor]);

  useEffect(() => {
    void window.agenticxDesktop.platform().then((platform) => {
      document.documentElement.setAttribute("data-platform", platform);
    });
  }, []);

  useEffect(() => {
    // Initial account hydration and subscription to enterprise browser-login events.
    // Topbar and Settings → AccountTab share userAccount via store.
    let cancelled = false;
    let hydrationSeq = 0;
    let pendingAccountEvent: {
      stamp: ReturnType<typeof normalizeDesktopFeedbackAccountStamp>;
    } | null = null;

    const accountStampFromPayload = (payload: {
      scope_id?: string | null;
      auth_generation?: number;
    }) => {
      if (
        !Object.prototype.hasOwnProperty.call(payload, "scope_id") ||
        !Object.prototype.hasOwnProperty.call(payload, "auth_generation")
      ) {
        return null;
      }
      return normalizeDesktopFeedbackAccountStamp(payload.scope_id, payload.auth_generation);
    };

    const applyAccountSnapshot = (snapshot: {
      loggedIn?: boolean;
      email?: string;
      displayName?: string;
      baseUrl?: string;
      scope_id?: string | null;
      auth_generation?: number;
      capabilities?: unknown;
      capabilitySyncStatuses?: unknown;
      capabilityPolicy?: unknown;
      attachmentRouting?: unknown;
    }, expectedStamp = pendingAccountEvent?.stamp): boolean => {
      const current = useAppStore.getState().userAccount;
      const stamp = accountStampFromPayload(snapshot);
      const nextScopeId = stamp?.scopeId ?? null;
      const nextAuthGeneration = stamp?.authGeneration ?? null;
      if (pendingAccountEvent && !stamp) {
        // An account event without a complete trusted stamp cannot authorize
        // a load response or enable feedback for the old pane.
        return false;
      }
      if (
        expectedStamp &&
        !desktopFeedbackAccountStampsEqual(
          nextScopeId,
          nextAuthGeneration,
          expectedStamp.scopeId,
          expectedStamp.authGeneration,
        )
      ) {
        // A load started before the account event may still resolve with A.
        // Do not let that response overwrite the event's complete B stamp.
        return false;
      }
      if (
        !shouldApplyDesktopFeedbackAccountStamp(
          current.feedbackScopeId,
          current.feedbackAuthGeneration,
          nextScopeId,
          nextAuthGeneration,
        )
      ) {
        return false;
      }
      setUserAccount({
        loggedIn: Boolean(snapshot.loggedIn),
        email: String(snapshot.email ?? ""),
        displayName: String(snapshot.displayName ?? ""),
        baseUrl: String(snapshot.baseUrl ?? ""),
        // Keep the account display and complete feedback stamp in one store
        // update. A missing/invalid stamp deliberately disables feedback.
        feedbackScopeId: nextScopeId,
        feedbackAuthGeneration: nextAuthGeneration,
        capabilities: Array.isArray(snapshot.capabilities) ? snapshot.capabilities : [],
        capabilitySyncStatuses: normalizeEnterpriseCapabilitySyncStatuses(
          snapshot.capabilitySyncStatuses,
        ),
        capabilityLocks: readCapabilityLocks(snapshot.capabilityPolicy),
        attachmentRouting: readAttachmentRoutingPolicy(snapshot.attachmentRouting),
      });
      return true;
    };

    const hydrateUserAccount = async (
      expectedStamp: ReturnType<typeof normalizeDesktopFeedbackAccountStamp> = pendingAccountEvent?.stamp ?? null,
    ) => {
      const requestSeq = ++hydrationSeq;
      try {
        const r = await window.agenticxDesktop.loadUserAccount();
        if (cancelled || requestSeq !== hydrationSeq || !r.ok) return;
        if (!applyAccountSnapshot(r, expectedStamp)) return;
        if (
          expectedStamp &&
          desktopFeedbackAccountStampsEqual(
            expectedStamp.scopeId,
            expectedStamp.authGeneration,
            r.scope_id ?? null,
            r.auth_generation,
          )
        ) {
          pendingAccountEvent = null;
        }
      } catch {
        // ignore; account is optional for most local workflows
      }
    };
    void hydrateUserAccount();

    const offChanged = window.agenticxDesktop.onUserAccountChanged((payload) => {
      // The event records the expected complete stamp and starts a full
      // snapshot read. Keep the old account store entry until that read
      // returns, so displayed identity and capability policy switch together.
      pendingAccountEvent = { stamp: accountStampFromPayload(payload) };
      void hydrateUserAccount(pendingAccountEvent.stamp);
    });
    const offCapabilitiesChanged = window.agenticxDesktop.onEnterpriseCapabilitiesChanged(() => {
      // Capability updates can arrive without an identity transition. Always re-read the
      // atomic account snapshot so both marketplaces switch to the new allowlist together.
      void hydrateUserAccount();
      // The same enterprise snapshot may create or withdraw managed experts/groups.
      // Reuse the existing local refresh events so sidebar and gallery update together.
      window.dispatchEvent(
        new CustomEvent("agenticx:avatars:changed", { detail: { openPane: false } }),
      );
      window.dispatchEvent(new CustomEvent("agenticx:groups:changed"));
    });
    const offTimeout = window.agenticxDesktop.onUserAccountLoginTimeout((payload) => {
      const error = String(payload?.error ?? "").trim();
      void window.agenticxDesktop.confirmDialog({
        title: error ? "企业登录失败" : "登录等待超时",
        message: error || "未在有效时间内完成企业登录确认。请打开「设置 → 用户账号」重新登录。",
        confirmText: "确定",
      });
    });
    return () => {
      cancelled = true;
      offChanged();
      offCapabilitiesChanged();
      offTimeout();
    };
  }, [setUserAccount]);

  useEffect(() => {
    const onWindowResize = () => {
      setWindowResizing(true);
      if (windowResizeTimerRef.current !== null) {
        window.clearTimeout(windowResizeTimerRef.current);
      }
      windowResizeTimerRef.current = window.setTimeout(() => {
        setWindowResizing(false);
        windowResizeTimerRef.current = null;
      }, 140);
    };
    window.addEventListener("resize", onWindowResize, { passive: true });
    return () => {
      window.removeEventListener("resize", onWindowResize);
      if (windowResizeTimerRef.current !== null) {
        window.clearTimeout(windowResizeTimerRef.current);
        windowResizeTimerRef.current = null;
      }
    };
  }, []);

  // Responsive auto-collapse: 窗口越窄越先收侧栏面板，最后才收主导航
  // Stage 0: 全展开 (>= STAGE1_BREAK)
  // Stage 1: 自动收起每个 pane 的「工作区 / 历史对话 / 群成员」面板 (< STAGE1_BREAK)
  // Stage 2: 进一步收起左侧主导航栏 (< STAGE2_BREAK)
  // 当窗口重新拉宽并跨回阈值时，恢复进入窄屏前用户原本展开的面板/导航。
  useEffect(() => {
    const STAGE1_BREAK = 1180;
    const STAGE2_BREAK = 820;

    const computeStage = (w: number): 0 | 1 | 2 => {
      if (w < STAGE2_BREAK) return 2;
      if (w < STAGE1_BREAK) return 1;
      return 0;
    };

    const applyStage = (newStage: 0 | 1 | 2) => {
      const prev = responsiveStageRef.current;
      if (prev === newStage) return;
      const state = useAppStore.getState();
      // Focus 模式下完全交给浮窗自身布局，不参与响应式折叠
      if (state.focusMode) {
        responsiveStageRef.current = newStage;
        setResponsiveStage(newStage);
        return;
      }

      if (newStage > prev) {
        const snap = responsiveSnapshotRef.current ?? {};
        if (prev < 1 && newStage >= 1) {
          const panesMap: Record<
            string,
            { taskspace: boolean; history: boolean; members: boolean }
          > = {};
          state.panes.forEach((p) => {
            panesMap[p.id] = {
              taskspace: !!p.taskspacePanelOpen,
              history: !!p.historyOpen,
              members: !!p.membersPanelOpen,
            };
          });
          snap.panes = panesMap;
        }
        if (prev < 2 && newStage === 2) {
          snap.sidebarOpen = !state.sidebarCollapsed;
        }
        responsiveSnapshotRef.current = snap;

        useAppStore.setState((s) => {
          const patch: Partial<typeof s> = {};
          if (newStage >= 1) {
            patch.panes = s.panes.map((p) => ({
              ...p,
              taskspacePanelOpen: false,
              historyOpen: false,
              membersPanelOpen: false,
            }));
          }
          if (newStage === 2 && !s.sidebarCollapsed) {
            patch.sidebarCollapsed = true;
          }
          return patch as typeof s;
        });
      } else {
        const snap = responsiveSnapshotRef.current;
        useAppStore.setState((s) => {
          const patch: Partial<typeof s> = {};
          if (prev === 2 && newStage < 2 && snap?.sidebarOpen !== undefined) {
            patch.sidebarCollapsed = !snap.sidebarOpen;
          }
          if (newStage === 0 && snap?.panes) {
            const map = snap.panes;
            patch.panes = s.panes.map((p) => {
              const rec = map[p.id];
              if (!rec) return p;
              return {
                ...p,
                taskspacePanelOpen: rec.taskspace,
                historyOpen: rec.history,
                membersPanelOpen: rec.members,
              };
            });
          }
          return patch as typeof s;
        });
        if (newStage === 0) {
          responsiveSnapshotRef.current = null;
        } else if (newStage < 2 && responsiveSnapshotRef.current) {
          delete responsiveSnapshotRef.current.sidebarOpen;
        }
      }
      responsiveStageRef.current = newStage;
      setResponsiveStage(newStage);
    };

    const handle = () => applyStage(computeStage(window.innerWidth));
    // 首次挂载与可能的工作区状态恢复后各跑一次，保证窄屏启动也能收起
    handle();
    const settleTimer = window.setTimeout(handle, 250);

    window.addEventListener("resize", handle, { passive: true });
    return () => {
      window.removeEventListener("resize", handle);
      window.clearTimeout(settleTimer);
    };
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setStartupOptimizing(false);
    }, 8000);
    return () => window.clearTimeout(timer);
  }, []);

  /**
   * 切换运行模式：**一次写入，一个字段**。
   *
   * 上一版写两处（桌面端 confirmStrategy + 后端 permissions.mode），失败要回滚，
   * 而「请求报错」并不等于「没写进去」——服务端是先落盘再返回响应，响应丢了就会
   * 出现界面和真实权限相反的状态。补偿逻辑修不好这个，只能去掉第二处写入。
   *
   * 现在失败时不猜：重新拉一次后端的真实值显示出来。
   */
  const handleRunModeChange = useCallback(async (mode: RunMode): Promise<{ ok: boolean; error?: string }> => {
    if (mode !== "auto") autoApproveScopesRef.current.clear();
    const previous = useAppStore.getState().runMode;
    setRunMode(mode);
    try {
      const res = await fetch(`${apiBase}/api/permissions`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", "x-agx-desktop-token": apiToken },
        body: JSON.stringify({ mode }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // 不假设「失败 = 没写入」。回读一次，界面显示后端真正生效的那个值。
      try {
        const check = await fetch(`${apiBase}/api/permissions`, {
          headers: { "x-agx-desktop-token": apiToken },
        });
        const data = (await check.json()) as { ok?: boolean; mode?: unknown };
        setRunMode(data?.ok ? normalizeRunMode(data.mode) : previous);
      } catch {
        setRunMode(previous);
      }
      return { ok: false, error: message };
    }
  }, [apiBase, apiToken, setRunMode]);

  /** Change the security mode owned by one conversation, never the global default. */
  const handleSessionRunModeChange = useCallback(
    async (
      sid: string,
      mode: RunMode,
    ): Promise<{ ok: boolean; error?: string }> => {
      const sessionId = String(sid ?? "").trim();
      if (!sessionId) {
        return { ok: false, error: "当前还没有创建会话" };
      }
      const state = useAppStore.getState();
      const previous = state.sessionRunModes[sessionId] ?? state.runMode;
      setSessionRunMode(sessionId, mode);
      try {
        const res = await fetch(
          `${apiBase}/api/sessions/${encodeURIComponent(sessionId)}/permissions`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json", "x-agx-desktop-token": apiToken },
            body: JSON.stringify({ mode }),
          },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { ok?: boolean; mode?: unknown };
        setSessionRunMode(sessionId, data?.ok ? normalizeRunMode(data.mode) : mode);
        return { ok: true };
      } catch (error) {
        try {
          const check = await fetch(
            `${apiBase}/api/sessions/${encodeURIComponent(sessionId)}/permissions`,
            { headers: { "x-agx-desktop-token": apiToken } },
          );
          const data = (await check.json()) as { ok?: boolean; mode?: unknown };
          setSessionRunMode(
            sessionId,
            data?.ok ? normalizeRunMode(data.mode) : previous,
          );
        } catch {
          setSessionRunMode(sessionId, previous);
        }
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
    [apiBase, apiToken, setSessionRunMode],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      // 内嵌终端要拿到原始按键，一律不抢。
      if (isInsideXterm(event.target)) return;
      const action = matchKeybinding(event);
      if (!action) return;
      // 输入框里只放行应用级动作（见 EDITABLE_SAFE_ACTIONS 的说明）。以前是在匹配
      // **之前**整体跳过，于是光标在输入框时按 Cmd/Ctrl+Shift+P 毫无反应，而用户
      // 以为自己已经切成只读了。
      if (isEditableTarget(event.target) && !EDITABLE_SAFE_ACTIONS.has(action)) return;
      event.preventDefault();
      if (action === "open-global-search") {
        openGlobalSearch();
      } else if (action === "open-settings") {
        openSettings();
      } else if (action === "clear-messages") {
        clearMessages();
      } else if (action === "toggle-plan-mode") {
        // 以前这里翻的是 store 里一个叫 planMode 的布尔值。那个值只有已删掉的 Lite
        // 界面在读——在 Pro 下按 Ctrl/Cmd+Shift+P 什么都不会发生，而用户以为自己
        // 进了只读模式，权限一点没变。现在切的是真正的运行模式上限。
        const state = useAppStore.getState();
        const activePane = state.panes.find((pane) => pane.id === state.activePaneId);
        const sid = String(activePane?.sessionId ?? "").trim();
        const current = sid
          ? state.sessionRunModes[sid] ?? state.runMode
          : state.pendingSessionRunModesByPane[state.activePaneId] ?? state.runMode;
        void (async () => {
          const nextMode = current === "plan" ? "ask" : "plan";
          if (!sid) {
            setPendingSessionRunMode(state.activePaneId, nextMode);
            return;
          }
          const result = await handleSessionRunModeChange(sid, nextMode);
          // 快捷键切换失败以前是静默的——用户按了键、模式弹回去，不知道为什么。
          if (!result.ok) {
            setPermissionError(
              `运行模式切换失败：${result.error ?? "未知原因"}（已按后端实际值显示）`,
            );
          }
        })();
      } else if (action === "open-keybindings") {
        setKeybindingsPanelOpen(true);
      } else if (action === "toggle-focus-mode" && VOICE_UI_ENABLED) {
        // 快捷键场景：把当前 activePaneId 作为目标 pane 传给灵巧模式，
        // 让历史继承 / 写回都对齐用户正在聊的那个会话（非硬编码 pane-meta）。
        toggleFocusMode(useAppStore.getState().activePaneId);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    setKeybindingsPanelOpen,
    openSettings,
    clearMessages,
    handleRunModeChange,
    handleSessionRunModeChange,
    setPendingSessionRunMode,
    toggleFocusMode,
  ]);

  const onOpenConfirm = async (
    requestId: string,
    question: string,
    diff?: string,
    agentId: string = "meta",
    context?: Record<string, unknown>,
    run?: ConfirmRunContext,
  ): Promise<boolean> =>
    await new Promise<boolean>((resolve) => {
      const scope = buildConfirmScope(question, context);
      if (denyScopesRef.current.has(scope)) {
        resolve(false);
        return;
      }
      // 只看「这次运行里已经批准过同一范围」。全局模式由后端裁决——它判过一次了,
      // 事件能走到这里就说明它要求用户看一眼。
      if (
        shouldAutoApproveConfirm(autoApproveScopesRef.current.allows(run, scope), context)
      ) {
        resolve(true);
        return;
      }
      confirmScopeRef.current = scope;
      confirmRunRef.current = run ?? null;
      confirmResolverRef.current = resolve;
      const confirmContext = { ...(context ?? {}) };
      if (run?.sessionId && !confirmContext.session_id) {
        confirmContext.session_id = run.sessionId;
      }
      openConfirm(requestId, question, diff, agentId, confirmContext);
    });

  const endConfirmRun = useCallback((run: ConfirmRunContext) => {
    autoApproveScopesRef.current.end(run);
  }, []);

  /**
   * 「以后都不再问这条命令」的落点。
   *
   * 写的是完整命令 + 命令实际执行的目录,不是命令名、也不是会话挂载的所有根。
   * 同一条命令在两个仓里的含义可以完全不同,所以作用域必须绑到「这条命令现在跑在哪」。
   * 追加动作放在后端(POST 而不是 GET+PUT):渲染层读改写会在多窗口下互相覆盖。
   */
  const persistCommandApproval = useCallback(
    async (context?: Record<string, unknown>) => {
      const command = typeof context?.command === "string" ? context.command.trim() : "";
      const cwd = typeof context?.cwd === "string" ? context.cwd.trim() : "";
      if (!command || !cwd || !apiBase) return;
      // 写失败不回滚这一次执行——用户已经批准过了。但必须说出来:他选的是「以后都不再
      // 问」,静默失败会让他下次再被问时以为是产品出了别的毛病,而不是这次没保存上。
      try {
        const res = await fetch(`${apiBase}/api/permissions/allowed_commands`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-agx-desktop-token": apiToken },
          body: JSON.stringify({ pattern: command, workspace: cwd }),
        });
        if (!res.ok) {
          setPermissionError(`「以后都不再问这条命令」未能保存：HTTP ${res.status}`);
        }
      } catch (e) {
        setPermissionError(
          `「以后都不再问这条命令」未能保存：${e instanceof Error ? e.message : String(e)}`,
        );
      }
    },
    [apiBase, apiToken],
  );

  // 设置页的全局默认值由后端提供。启动时拉一次；已绑定会话的实际值由会话接口
  // 与会话列表单独补齐，否则界面会一直显示默认档，而实际可能是 plan。
  useEffect(() => {
    if (!apiBase || !apiToken) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`${apiBase}/api/permissions`, {
          headers: { "x-agx-desktop-token": apiToken },
        });
        const data = (await res.json()) as { ok?: boolean; mode?: unknown };
        if (!cancelled && data?.ok) setRunMode(normalizeRunMode(data.mode));
      } catch {
        // 拿不到就保持默认档；模式的真正执行在后端,界面显示错了不会放宽任何东西。
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [apiBase, apiToken, setRunMode]);

  // Open-ended clarification must NEVER be auto-approved (NFR-1 / AC-3):
  // confirming with "Run-Everything" only bypasses *permission* confirms,
  // not open-ended questions whose answer would be lost.
  const onOpenClarification = async (
    requestId: string,
    prompt: string,
    options: string[],
    allowFreeText: boolean,
    agentId: string = "meta",
    context?: Record<string, unknown>
  ): Promise<{ answerText: string; selectedOptions: string[] } | null> =>
    await new Promise<{ answerText: string; selectedOptions: string[] } | null>((resolve) => {
      clarifyResolverRef.current = resolve;
      openClarification(requestId, prompt, options, allowFreeText, agentId, context);
    });

  /**
   * Non-blocking submit used by the inline ClarificationCard.
   * Performs POST /api/clarify and, on success, marks the corresponding pane
   * message as answered so a reload/switch doesn't resurrect the question.
   *
   * sessionId is REQUIRED for the meta inline path — we never fall back to the
   * global active sessionId because in multi-pane layouts that may belong to a
   * different pane and would resolve the wrong gate.
   */
  const onSubmitClarification = useCallback(
    async (
      requestId: string,
      answer: { answerText: string; selectedOptions: string[] },
      sessionId?: string,
      agentId = "meta",
    ): Promise<boolean> => {
      // Resolve sessionId from the pane that owns this clarification, not the
      // global active session (avoid cross-pane gate resolution).
      let sid = (sessionId ?? "").trim();
      if (!sid) {
        const state = useAppStore.getState();
        for (const p of state.panes) {
          const hit = (p.messages ?? []).some(
            (m) => m.clarificationPrompt?.requestId === requestId,
          );
          if (hit) {
            sid = (p.sessionId ?? "").trim();
            break;
          }
        }
      }
      if (!sid) {
        // Last-resort fallback to active pane session, but surface a console
        // warning so cross-pane mis-routing is diagnosable.
        const activeSid = useAppStore.getState().sessionId || "";
        console.warn(
          "[clarify] no sessionId resolved for request %s, falling back to active %s",
          requestId,
          activeSid,
        );
        sid = activeSid;
      }

      const res = await fetch(`${apiBase}/api/clarify`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-agx-desktop-token": apiToken },
        body: JSON.stringify({
          session_id: sid,
          request_id: requestId,
          agent_id: agentId,
          answer_text: answer.answerText ?? "",
          selected_options: answer.selectedOptions ?? [],
        }),
      });

      // 404 means the gate is already resolved/missing — treat as "already handled".
      if (res.status === 404) {
        markClarificationAnsweredInStore(requestId, answer);
        // Fulfill a pending Dialog resolver (legacy) so it doesn't hang.
        if (clarifyResolverRef.current) {
          clarifyResolverRef.current(answer);
          clarifyResolverRef.current = null;
          closeClarification();
        }
        return false;
      }
      if (!res.ok) {
        // Non-404 error: surface to caller as a business failure.
        return false;
      }

      markClarificationAnsweredInStore(requestId, answer);
      if (clarifyResolverRef.current) {
        clarifyResolverRef.current(answer);
        clarifyResolverRef.current = null;
        closeClarification();
      }
      return true;
    },
    [apiBase, apiToken, closeClarification],
  );

  /** Mark the pane message carrying this clarification as answered (refresh survival). */
  const markClarificationAnsweredInStore = useCallback(
    (requestId: string, answer: { answerText: string; selectedOptions: string[] }) => {
      useAppStore.getState().markClarificationAnswered(requestId, answer);
    },
    [],
  );

  const handleSettingsSave = async (result: {
    defaultProvider: string;
    providers: Record<string, ProviderEntry>;
  }) => {
    const normalizedProviders = normalizeAllProviders(result.providers);

    for (const [name, entry] of Object.entries(normalizedProviders)) {
      const hasCustomVendorMeta =
        Boolean(entry.displayName?.trim())
        || entry.interface === "openai"
        || entry.interface === "ollama";
      if (
        !hasCustomVendorMeta &&
        !entry.apiKey &&
        !entry.model &&
        !entry.baseUrl &&
        entry.models.length === 0 &&
        entry.enabled !== false
      ) {
        continue;
      }
      await window.agenticxDesktop.saveProvider({
        name,
        apiKey: entry.apiKey || undefined,
        baseUrl: entry.baseUrl || undefined,
        model: entry.model || undefined,
        models: entry.models.length > 0 ? entry.models : undefined,
        enabled: entry.enabled,
        dropParams: entry.dropParams,
        // displayName 未出现在对象上时不传，避免误删 YAML；显式传空串表示用户清空展示名
        ...(entry.displayName !== undefined ? { displayName: entry.displayName.trim() } : {}),
        ...(entry.interface === "openai" || entry.interface === "ollama"
          ? { interface: entry.interface }
          : {}),
        ...(entry.managed === true ? { managed: true } : {}),
      });
    }
    await window.agenticxDesktop.setDefaultProvider(result.defaultProvider);

    const defEntry = normalizedProviders[result.defaultProvider];
    updateSettings({
      defaultProvider: result.defaultProvider,
      providers: normalizedProviders,
      provider: result.defaultProvider,
      model: defEntry?.model ?? "",
      apiKey: defEntry?.apiKey ?? "",
    });

    await persistReconciledPaneModels();
    const nextState = useAppStore.getState();
    await window.agenticxDesktop.saveConfig({
      provider: result.defaultProvider,
      model: defEntry?.model ?? "",
      apiKey: defEntry?.apiKey ?? "",
      ...(nextState.activeProvider && nextState.activeModel
        ? {
            activeProvider: nextState.activeProvider,
            activeModel: nextState.activeModel,
          }
        : {}),
    });
    stopSpeak();
  };

  const avatars = useAppStore((s) => s.avatars);
  const groups = useAppStore((s) => s.groups);
  const addPane = useAppStore((s) => s.addPane);
  const setActiveAvatarId = useAppStore((s) => s.setActiveAvatarId);
  const setActivePaneId = useAppStore((s) => s.setActivePaneId);
  const setPaneMessages = useAppStore((s) => s.setPaneMessages);
  const setForwardAutoReply = useAppStore((s) => s.setForwardAutoReply);

  const resolveForwardTargetForFavorite = useCallback(
    async (payload: ForwardConfirmPayload): Promise<{ paneId: string; sessionId: string }> => {
      return resolveForwardTarget(payload, {
        addPane: (avatarId, avatarName, sessionId) =>
          addPane(avatarId, avatarName, sessionId ?? ""),
        setActivePaneId,
        setActiveAvatarId,
        setPaneSessionId,
      });
    },
    [addPane, setActiveAvatarId, setActivePaneId, setPaneSessionId]
  );

  /** Persist a human reaction against the group/session that owns the pane. */
  const handleToggleGroupReaction = useCallback(
    async (pane: ChatPaneState, message: Message, emoji: string): Promise<void> => {
      const boundAvatarId = String(pane.avatarId ?? "").trim();
      const groupId = boundAvatarId.startsWith("group:")
        ? boundAvatarId.slice("group:".length).trim()
        : String(message.metadata?.group_id ?? "").trim();
      const sid = String(pane.sessionId ?? "").trim();
      const messageId = String(message.groupMessageId ?? "").trim();
      if (!groupId || !sid || !messageId) {
        throw new Error("群消息回应缺少群聊或消息上下文");
      }
      const result = await toggleGroupMessageReaction({
        apiBase,
        apiToken,
        groupId,
        sessionId: sid,
        messageId,
        emoji,
      });
      // The initiating bubble is optimistically updated by ChatPane.  Replace
      // it with the server aggregate once the request succeeds so concurrent
      // toggles or stale local state cannot leave an incorrect count behind.
      useAppStore.getState().updatePaneMessageByGroupMessageId(
        pane.id,
        result.message_id || messageId,
        normalizeGroupReactions(result.reactions, "user"),
        sid,
      );
    },
    [apiBase, apiToken],
  );

  const handleForwardFavorite = useCallback(
    async (
      ctx: { sourceSessionId: string; content: string; role?: string },
      targetPayload: ForwardConfirmPayload,
      followUpNote: string
    ) => {
      const source = ctx.sourceSessionId.trim();
      if (!source) throw new Error("这条收藏缺少来源会话，无法转发");
      const base = apiBase.replace(/\/$/, "");
      if (!base) throw new Error("未连接 Studio");
      const follow = followUpNote.trim();
      const defaultForwardFollowCue = "请阅读刚转发的聊天记录并继续回复。";
      const effectiveFollowNote = follow || defaultForwardFollowCue;
      const rawRole = (ctx.role || "assistant").trim().toLowerCase();
      const roleForForward =
        rawRole === "user" ? "user" : rawRole === "tool" ? "tool" : "assistant";
      const sender =
        roleForForward === "user" ? "我" : roleForForward === "tool" ? "工具" : "AI";
      const { paneId: targetPaneId, sessionId: targetSessionId } =
        await resolveForwardTargetForFavorite(targetPayload);
      const resp = await fetch(`${base}/api/messages/forward`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-agx-desktop-token": apiToken },
        body: JSON.stringify({
          source_session_id: source,
          target_session_id: targetSessionId,
          messages: [{ sender, role: roleForForward, content: ctx.content }],
          follow_up_note: effectiveFollowNote,
        }),
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new Error(text.slice(0, 200) || `转发失败 HTTP ${resp.status}`);
      }
      setActivePaneId(targetPaneId);
      const targetPaneMeta = useAppStore.getState().panes.find((p) => p.id === targetPaneId);
      const aid = targetPaneMeta?.avatarId;
      if (aid?.startsWith("group:")) {
        setActiveAvatarId(null);
      } else {
        setActiveAvatarId(aid ?? null);
      }
      try {
        const result = await window.agenticxDesktop.loadSessionMessages(targetSessionId);
        if (result.ok && Array.isArray(result.messages)) {
          const mapped: Message[] = result.messages.map((item, index) =>
            mapLoadedSessionMessage(item as LoadedSessionMessage, targetSessionId, index)
          );
          setPaneMessages(targetPaneId, mapped);
        }
      } catch {
        // keep server state; pane may refresh on next poll
      }
      setForwardAutoReply({
        paneId: targetPaneId,
        sessionId: targetSessionId,
        text: effectiveFollowNote,
      });
      useAppStore.getState().bumpSessionCatalogRevision();
      window.setTimeout(() => useAppStore.getState().bumpSessionCatalogRevision(), 450);
    },
    [
      apiBase,
      apiToken,
      resolveForwardTargetForFavorite,
      setActiveAvatarId,
      setActivePaneId,
      setForwardAutoReply,
      setPaneMessages,
    ]
  );

  useEffect(() => {
    const refreshSessionMessages = async (targetSessionId: string) => {
      const sid = String(targetSessionId ?? "").trim();
      if (!sid) return;
      const state = useAppStore.getState();
      const sameSid = state.panes.filter((pane) => String(pane.sessionId ?? "").trim() === sid);
      if (sameSid.length === 0) return;
      // 定时任务会话只应刷新 automation:* 窗格，避免与 Near 窗格误绑同一 sessionId 时被错误覆盖
      const autoPanes = sameSid.filter((p) => String(p.avatarId ?? "").startsWith("automation:"));
      const targets = autoPanes.length > 0 ? autoPanes : sameSid;
      try {
        const result = await window.agenticxDesktop.loadSessionMessages(sid);
        if (!result.ok || !Array.isArray(result.messages)) return;
        const mapped = result.messages.map((item, idx) =>
          mapLoadedSessionMessage(item as LoadedSessionMessage, sid, idx)
        );
        for (const pane of targets) {
          setPaneMessages(pane.id, mapped);
        }
      } catch {
        // keep current pane state; next poll may recover
      }
    };

    const ensureAutomationPane = (payload: {
      taskId: string;
      taskName: string;
      sessionId?: string;
    }): string | null => {
      const sid = String(payload.sessionId ?? "").trim();
      if (!sid) return null;
      const avatarId = `automation:${payload.taskId}`;
      const paneTitle = `定时 · ${payload.taskName || "自动化任务"}`;
      const state = useAppStore.getState();
      const existingByAvatar = state.panes.find((pane) => pane.avatarId === avatarId);
      if (existingByAvatar) {
        const prevSid = (existingByAvatar.sessionId || "").trim();
        if (prevSid !== sid) {
          // 新一轮触发切换到新 session：先清掉旧消息，避免视觉上「还在看旧聊天」。
          setPaneMessages(existingByAvatar.id, []);
          setPaneSessionId(existingByAvatar.id, sid);
        }
        return existingByAvatar.id;
      }
      // 必须与当前任务的 automation:<id> 一致，不能把 Near/分身窗格当成定时窗格复用
      const existingBySession = state.panes.find(
        (pane) => (pane.sessionId || "").trim() === sid && pane.avatarId === avatarId
      );
      if (existingBySession) return existingBySession.id;
      const paneId = addPane(avatarId, paneTitle, sid);
      setPaneSessionId(paneId, sid);
      return paneId;
    };

    const startAutomationPoll = () => {
      if (automationPollTimerRef.current !== null) return;
      automationPollTimerRef.current = window.setInterval(() => {
        const runningSessions = Array.from(automationRunningRef.current.keys());
        if (runningSessions.length === 0) return;
        for (const sid of runningSessions) {
          void refreshSessionMessages(sid);
        }
      }, 1400);
    };

    const stopAutomationPollIfIdle = () => {
      if (automationRunningRef.current.size > 0) return;
      if (automationPollTimerRef.current !== null) {
        window.clearInterval(automationPollTimerRef.current);
        automationPollTimerRef.current = null;
      }
    };

    const off = window.agenticxDesktop.onAutomationTaskProgress((payload) => {
      const sid = String(payload.sessionId ?? "").trim();
      const paneId = ensureAutomationPane(payload);
      if (paneId) {
        setActivePaneId(paneId);
        const openedPane = useAppStore.getState().panes.find((pane) => pane.id === paneId);
        const aid = String(openedPane?.avatarId ?? "").trim();
        setActiveAvatarId(aid.startsWith("automation:") ? null : (openedPane?.avatarId ?? null));
      }
      if (!sid) return;
      const taskKey = String(payload.taskId ?? "").trim() || `ts:${Date.now()}`;
      if (payload.phase === "queued" || payload.phase === "running") {
        const runningSet = automationRunningRef.current.get(sid) ?? new Set<string>();
        runningSet.add(taskKey);
        automationRunningRef.current.set(sid, runningSet);
        startAutomationPoll();
        void refreshSessionMessages(sid);
        return;
      }
      const runningSet = automationRunningRef.current.get(sid);
      if (runningSet) {
        runningSet.delete(taskKey);
        if (runningSet.size === 0) {
          automationRunningRef.current.delete(sid);
        } else {
          automationRunningRef.current.set(sid, runningSet);
        }
      }
      void refreshSessionMessages(sid);
      stopAutomationPollIfIdle();
    });

    return () => {
      off();
      if (automationPollTimerRef.current !== null) {
        window.clearInterval(automationPollTimerRef.current);
        automationPollTimerRef.current = null;
      }
      automationRunningRef.current.clear();
    };
  }, [addPane, setActiveAvatarId, setActivePaneId, setPaneMessages, setPaneSessionId]);

  // Watch feishu_binding.json for _desktop key changes — auto-switch pane when /bind fires
  const feishuBindingSidRef = useRef<string>("");
  const feishuBindingHydratedRef = useRef(false);
  useEffect(() => {
    if (!apiBase) return;
    let cancelled = false;

    const check = async () => {
      if (cancelled) return;
      try {
        const r = await window.agenticxDesktop.loadFeishuBinding();
        if (!r.ok || cancelled) return;
        const desk = r.bindings["_desktop"] as { session_id?: string; avatar_id?: string; avatar_name?: string } | undefined;
        const newSid = (desk?.session_id ?? "").trim();
        const deskAvatar = (desk?.avatar_id ?? "").trim();
        if (newSid && deskAvatar.startsWith("automation:")) {
          void window.agenticxDesktop.saveFeishuDesktopBinding({ sessionId: null });
          feishuBindingSidRef.current = "";
          feishuBindingHydratedRef.current = true;
          return;
        }

        const prevSid = feishuBindingSidRef.current;
        // Startup hydration: only sync baseline binding value.
        // Do not auto-switch pane on first successful read, so we keep
        // the last active pane/session restored from workspace snapshot.
        if (!feishuBindingHydratedRef.current) {
          feishuBindingSidRef.current = newSid;
          feishuBindingHydratedRef.current = true;
          return;
        }
        if (newSid === prevSid) return;
        feishuBindingSidRef.current = newSid;

        if (!newSid) {
          // _desktop was cleared (/unbind) — switch back to the Meta/Near pane
          if (!prevSid) return; // was already unbound at startup, nothing to do
          const state = useAppStore.getState();
          // Prefer the pane whose session was previously bound (to deactivate it),
          // then fall back to the first pane with no avatarId (Meta/Near),
          // then fall back to panes[0].
          const metaPane =
            state.panes.find((p) => !p.avatarId || p.avatarId === "") ??
            state.panes[0];
          if (metaPane) {
            setActivePaneId(metaPane.id);
            setActiveAvatarId(null);
          }
          return;
        }

        // New binding: find or create a pane for this session
        const state = useAppStore.getState();
        const existingPane = state.panes.find((p) => p.sessionId === newSid);
        if (existingPane) {
          setActivePaneId(existingPane.id);
          const aid = existingPane.avatarId;
          setActiveAvatarId(aid?.startsWith("group:") ? null : (aid ?? null));
        } else {
          const avatarId = (desk?.avatar_id ?? "").trim() || null;
          const rawName = (desk?.avatar_name ?? "").trim();
          // avatar_id 为空表示飞书默认路由到 Near；勿用专家占位，否则顶栏/气泡会与元智能体不一致且无 meta 头像
          const avatarName = rawName
            ? resolveMetaDisplayName(rawName)
            : avatarId
              ? "专家"
              : META_AGENT_DISPLAY_NAME;
          const reusableMetaPane =
            !avatarId
              ? state.panes.find((pane) => !String(pane.avatarId ?? "").trim())
              : null;
          const paneId = reusableMetaPane
            ? reusableMetaPane.id
            : addPane(avatarId, avatarName, newSid);
          if (reusableMetaPane) {
            setPaneSessionId(reusableMetaPane.id, newSid);
            setPaneMessages(reusableMetaPane.id, []);
          }
          setActivePaneId(paneId);
          setActiveAvatarId(avatarId?.startsWith("group:") ? null : (avatarId ?? null));
          // Load messages for the new pane
          try {
            const msgs = await window.agenticxDesktop.loadSessionMessages(newSid);
            if (msgs.ok && Array.isArray(msgs.messages)) {
              const mapped = msgs.messages.map((item, idx) =>
                mapLoadedSessionMessage(item as LoadedSessionMessage, newSid, idx)
              );
              setPaneMessages(paneId, mapped);
            } else {
              setPaneMessages(paneId, []);
            }
          } catch {
            setPaneMessages(paneId, []);
          }
        }
      } catch {
        /* ignore */
      }
    };

    const timer = window.setInterval(() => void check(), 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [apiBase, addPane, setActivePaneId, setActiveAvatarId, setPaneMessages, setPaneSessionId]);

  const sidebarOverlayMode =
    !!apiBase && !focusMode && responsiveStage === 2 && !sidebarCollapsed;
  const integratedChatToolbar =
    mainView === "chat" && panes.length > 0 && !SHOW_DESKTOP_MULTI_PANE;

  const confirmSessionId = String(confirm.context?.session_id ?? "").trim();
  const confirmRunMode = confirmSessionId
    ? sessionRunModes[confirmSessionId] ?? runMode
    : runMode;

  return (
    <div
      className={`agx-app ${
        sidebarCollapsed || !apiBase ? "sidebar-collapsed" : ""
      } ${windowResizing ? "window-resizing" : ""} ${startupOptimizing ? "startup-optimizing" : ""} ${focusMode ? "agx-voice-focus-app" : ""} ${
        sidebarOverlayMode ? "sidebar-overlay" : ""
      }`}
    >
      {!configLoaded ? (
        <div className="h-full min-h-0 w-full" aria-hidden />
      ) : focusMode && apiBase ? (
        <VoiceFocusMode />
      ) : focusMode ? (
        <div className="flex h-full min-h-0 w-full items-center justify-center px-6 text-center text-sm text-[var(--text-danger,var(--destructive,#ef4444))]">
          {META_AGENT_DISPLAY_NAME} 后端未就绪，无法进入灵巧语音模式。
        </div>
      ) : apiBase ? (
        <>
          {!sidebarCollapsed ? (
            <div className="agx-sidebar-shell">
              <AvatarSidebar onToggleSidebar={() => setSidebarCollapsed((v) => !v)} />
              <SidebarResizer />
            </div>
          ) : null}
          {sidebarOverlayMode ? (
            <div
              className="agx-sidebar-overlay-backdrop"
              onClick={() => setSidebarCollapsed(true)}
              role="presentation"
              aria-hidden
            />
          ) : null}
          <div className={`agx-main-shell${integratedChatToolbar ? " agx-main-shell--integrated-toolbar" : ""}`}>
            {!focusMode && !integratedChatToolbar ? (
              <Topbar
                sidebarCollapsed={sidebarCollapsed}
                onToggleSidebar={() => setSidebarCollapsed((v) => !v)}
              />
            ) : null}
            <div className="agx-content">
              <div className="agx-main-content">
                <Suspense
                  fallback={(
                    <div className="flex h-full min-h-0 items-center justify-center text-sm text-text-faint">
                      正在载入…
                    </div>
                  )}
                >
                  {mainView === "avatars" ? (
                    <AvatarGalleryView />
                  ) : SHOW_DESKTOP_PROJECT_GROUP_CHAT && mainView === "groups" ? (
                    <ProjectsView />
                  ) : mainView === "expert-plaza" ? (
                    <DigitalExpertPlazaView />
                  ) : mainView === "automation" ? (
                    <AutomationView />
                  ) : mainView === "workflow-studio" ? (
                    <WorkflowStudioView />
                  ) : (
                    <PaneManager
                      onOpenConfirm={onOpenConfirm}
                      onConfirmRunEnd={endConfirmRun}
                      onOpenClarification={onOpenClarification}
                      onSubmitClarification={onSubmitClarification}
                      onToggleGroupReaction={handleToggleGroupReaction}
                      integratedToolbar={integratedChatToolbar}
                      sidebarCollapsed={sidebarCollapsed}
                      onToggleSidebar={() => setSidebarCollapsed((v) => !v)}
                    />
                  )}
                </Suspense>
              </div>
            </div>
          </div>
        </>
      ) : (
        <div className="flex-1" aria-hidden />
      )}

      <ConfirmDialog
        open={confirm.open}
        question={confirm.question}
        sourceLabel={confirm.agentId === "meta" ? "主智能体" : `子智能体 ${confirm.agentId}`}
        diff={confirm.diff}
        context={confirm.context}
        defaultPolicy={DEFAULT_CONFIRM_POLICY}
        autoRunMode={confirmRunMode === "auto"}
        onApprove={(policy) => {
          const protectedRequest = isProtectedConfirmContext(confirm.context);
          const scope = confirmScopeRef.current;
          const run = confirmRunRef.current ?? undefined;
          const scopeMayBeReused = !protectedRequest || canReuseProtectedConfirm(confirm.context);
          if (scopeMayBeReused && scope && run && policy !== "once") {
            autoApproveScopesRef.current.allow(run, scope);
            denyScopesRef.current.delete(scope);
          }
          // 「以后都不再问这条命令」写进 permissions.allowed_commands,并绑定到命令
          // 实际执行的目录。后端按工作区判定作用域:在 A 项目按下的批准不该悄悄
          // 放行 B 项目里跑的同一条命令。三类永不豁免的高危由后端拒绝写入。
          if (policy === "always") {
            void persistCommandApproval(confirm.context);
          }
          confirmScopeRef.current = null;
          confirmRunRef.current = null;
          closeConfirm();
          confirmResolverRef.current?.(true);
          confirmResolverRef.current = null;
        }}
        onReject={(policy) => {
          void policy; // reserved for future policy-specific reject handling
          confirmScopeRef.current = null;
          confirmRunRef.current = null;
          closeConfirm();
          confirmResolverRef.current?.(false);
          confirmResolverRef.current = null;
        }}
      />
      <ClarificationDialog
        open={clarification.open}
        prompt={clarification.prompt}
        options={clarification.options}
        allowFreeText={clarification.allowFreeText}
        sourceLabel={clarification.agentId === "meta" ? "主智能体" : `子智能体 ${clarification.agentId}`}
        context={clarification.context}
        onSubmit={async (answer: ClarificationAnswer) => {
          closeClarification();
          clarifyResolverRef.current?.(answer);
          clarifyResolverRef.current = null;
          // Ensure the backend actually receives it even if opened via dialog
          try {
            await onSubmitClarification(
              clarification.requestId,
              answer,
              undefined,
              clarification.agentId
            );
          } catch {
            // best effort; the resolver already fired
          }
        }}
        onSkip={() => {
          closeClarification();
          const empty = { answerText: "", selectedOptions: [] };
          clarifyResolverRef.current?.(empty);
          clarifyResolverRef.current = null;
          // fire-and-forget skip
          void onSubmitClarification(clarification.requestId, empty, undefined, clarification.agentId).catch(() => {});
        }}
      />
      {settings.open ? (
        <Suspense fallback={null}>
          <SettingsPanel
            open
            defaultProvider={settings.defaultProvider}
            providers={settings.providers}
            sessionId={String((activePaneSessionId || sessionId || "").trim())}
            apiBase={apiBase}
            apiToken={apiToken}
            mcpServers={mcpServers}
            onRefreshMcp={refreshMcpStatus}
            runMode={runMode}
            theme={theme}
            chatStyle={chatStyle}
            onThemeChange={setTheme}
            onChatStyleChange={setChatStyle}
            onRunModeChange={handleRunModeChange}
            onClose={() => closeSettings()}
            onSave={handleSettingsSave}
            panes={panes}
            avatars={avatars}
            groups={groups}
            onForwardFavorite={handleForwardFavorite}
          />
        </Suspense>
      ) : null}
      {/* Ctrl/Cmd+/ 一直在 setKeybindingsPanelOpen(true)，但这个面板只在已删掉的
          Lite 界面里渲染过——和 Ctrl/Cmd+Shift+P 是同一类失效：快捷键改了状态，
          没有任何东西读它。 */}
      {keybindingsPanelOpen ? (
        <Suspense fallback={null}>
          <KeybindingsPanel open onClose={() => setKeybindingsPanelOpen(false)} />
        </Suspense>
      ) : null}
      {permissionError ? (
        <div
          role="alert"
          className="fixed bottom-4 left-1/2 z-modal -translate-x-1/2 rounded-lg border border-border bg-surface-panel px-3 py-2 text-xs text-status-error shadow-lg"
          onClick={() => setPermissionError("")}
        >
          {permissionError}（点此关闭）
        </div>
      ) : null}
      {tokenDashboardOpen ? (
        <Suspense fallback={null}>
          <TokenDashboardPanel open onClose={() => closeTokenDashboard()} />
        </Suspense>
      ) : null}
      {deliveryPanelOpen ? (
        <Suspense fallback={null}>
          <DeliveryPanel
            open
            apiBase={apiBase}
            apiToken={apiToken}
            onClose={() => closeDeliveryPanel()}
          />
        </Suspense>
      ) : null}
      {environmentAssistantMounted ? (
        <Suspense fallback={null}>
          <EnvironmentAssistantPanel
            open={environmentAssistantOpen}
            apiBase={apiBase}
            apiToken={apiToken}
            onClose={() => closeEnvironmentAssistant()}
          />
        </Suspense>
      ) : null}
      <GlobalSearchHost />
      <KbDocumentOpenOverlay />
      <Toast
        open={globalSearchToastOpen}
        message={globalSearchToastMessage}
        variant={globalSearchToastVariant}
        onClose={() => setGlobalSearchToastOpen(false)}
      />
    </div>
  );
}
