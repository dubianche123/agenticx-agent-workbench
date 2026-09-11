"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import {
  DeepResearchFilesPanel,
  type DeepResearchPanelLane,
  DeepResearchRecoverBanner,
  AttachmentContentPanel,
  DOCUMENT_ACCEPT,
  InputArea,
  MessageList,
  MessageQueuePanel,
  classifyAttachment,
  STREAM_UPDATE_DEPTH_ERROR,
  probeNote,
  useChatStore,
  useComposerAttachments,
  extractClipboardImageFiles,
  withClipboardImageNames,
  modelSupportsVision,
  appendDeepResearchEvent,
  shouldShowHistorySyncAlert,
  startDeepResearchReconnect,
  abortAllDeepResearchReconnects,
  isSessionStreaming,
  getDeepResearchInteractionPref,
  setDeepResearchInteractionPref,
  labelForDeepResearchInteractionPref,
  DEEP_RESEARCH_INTERACTION_OPTIONS,
  findActivePlanChatGate,
  createPortalChatFeedbackClient,
  type ChatFeedbackValue,
  type DeepResearchInteractionPref,
  type ActiveDeepResearchRun,
} from "@agenticx/feature-chat";
import { type ChatClient } from "@agenticx/sdk-ts";
import type { ChatMessageAttachment } from "@agenticx/core-api";
import {
  DISABLED_ATTACHMENT_ROUTING,
  hasRoutedDocument,
  type AttachmentRoutingPolicy,
  type RoutingModelRef,
} from "@agenticx/config";
import {
  Activity,
  Check,
  ChevronDown,
  Cpu,
  Hash,
  LockKeyhole,
  Microscope,
  Paperclip,
  Pencil,
  Share,
  ShieldAlert,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  cn,
} from "@agenticx/ui";
import { NearEmptyWordmark } from "./NearEmptyWordmark";
import { QuotaLimitNotice } from "./QuotaLimitNotice";
import { AttachmentRoutingStatusAlert } from "./AttachmentRoutingStatusAlert";
import { ShareDialog } from "./share/ShareDialog";
import { downloadShareImage } from "./share/share-image";
import { navigateToExternalLink } from "../lib/external-link";
import { buildBrowserShareUrl } from "../lib/share-url";
import {
  CapabilityHoverTip,
  ComposerPlusMenu,
  hintLines,
  type DeepResearchMode,
  type WebSearchMode,
} from "./ComposerPlusMenu";
import { ENTERPRISE_PRODUCT_NAME } from "./EnterpriseBrandMark";
import {
  readDefaultModelPreference,
  resolveAvailableDefaultModel,
  writeDefaultModelPreference,
} from "../lib/default-model-preference";
import {
  expandChatShareTurnSelection,
  toChatShareMessage,
  type ChatShareMessage,
  type ChatShareSnapshot,
} from "../lib/chat-share-types";

// 模型清单从 /api/me/models 动态获取（admin 配置 + 用户可见性）。
// 没有任何分配时为空，UI 会提示「请联系管理员分配模型」。
type PortalModelOption = {
  id: string;
  provider: string;
  providerLabel: string;
  model: string;
  label: string;
  route: "local" | "private-cloud" | "third-party";
  isDefault: boolean;
  capabilities?: string[];
};

/** 会话 active_model（provider/model）在可见列表为空时的展示兜底。 */
function formatActiveModelFallback(modelId: string): string {
  const slash = modelId.indexOf("/");
  if (slash <= 0) return modelId;
  const provider = modelId.slice(0, slash);
  const model = modelId.slice(slash + 1);
  if (!model) return modelId;
  return `${model} · ${provider}`;
}

type MachiChatViewProps = {
  client: ChatClient;
  deepResearchMode?: DeepResearchMode;
  onDeepResearchModeChange?: (next: DeepResearchMode, sessionId?: string) => void;
  supportAssistant?: React.ReactNode;
};

function isComplianceError(message: string): boolean {
  return (/合规|策略|compliance|policy/i.test(message) && !/Gateway/i.test(message));
}

export function isLegacyEnterpriseQuotaError(message: string | null): boolean {
  if (!message) return false;
  return /^(?:Token 配额已用尽，请联系管理员调整额度|当前账号的 Token 配额已用尽|Token quota exhausted)(?:[。.!].*)?$/i.test(
    message,
  );
}

/**
 * A send started from one conversation must keep that conversation as its
 * owner across attachment-preprocessing awaits.  Keep this tiny predicate
 * exported so the session fence has a direct regression contract without
 * needing a browser renderer.
 */
export function isMachiChatSessionDisplayed(
  targetSessionId: string,
  activeSessionId: string | null | undefined,
): boolean {
  const target = targetSessionId.trim();
  return target.length > 0 && target === String(activeSessionId ?? "").trim();
}

export function MachiChatView({
  client,
  deepResearchMode = "off",
  onDeepResearchModeChange,
  supportAssistant,
}: MachiChatViewProps) {
  const t = useTranslations("chat");
  const tw = useTranslations("workspace");
  // Selector split: avoid bare useChatStore() so stream message/token ticks do not
  // re-run model-menu / switchModel fallback logic on every delta.
  const sessions = useChatStore((s) => s.sessions);
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const messages = useChatStore((s) => s.messages);
  const status = useChatStore((s) => s.status);
  const planChatRevising = useChatStore((s) => s.planChatRevising);
  const activeModel = useChatStore((s) => s.activeModel);
  const errorMessage = useChatStore((s) => s.errorMessage);
  const structuredQuotaError = useChatStore((s) => s.quotaError);
  const responseVersionsByUserMessageId = useChatStore((s) => s.responseVersionsByUserMessageId);
  const hydrateSessions = useChatStore((s) => s.hydrateSessions);
  const historyError = useChatStore((s) => s.historyError);
  const historySyncBySessionId = useChatStore((s) => s.historySyncBySessionId);
  const retryHistorySync = useChatStore((s) => s.retryHistorySync);
  const sessionMessagesLoading = useChatStore((s) => s.sessionMessagesLoading);
  const renameSession = useChatStore((s) => s.renameSession);
  const deleteSession = useChatStore((s) => s.deleteSession);
  const switchModel = useChatStore((s) => s.switchModel);
  const sendMessage = useChatStore((s) => s.sendMessage);
  const resumePlanChatFromComposer = useChatStore((s) => s.resumePlanChatFromComposer);
  const sendQueuedMessageNow = useChatStore((s) => s.sendQueuedMessageNow);
  const removePendingMessage = useChatStore((s) => s.removePendingMessage);
  const editPendingMessage = useChatStore((s) => s.editPendingMessage);
  const pendingMessages = useChatStore((s) => s.pendingMessages);
  const editUserMessageAndResend = useChatStore((s) => s.editUserMessageAndResend);
  const regenerateAssistantResponse = useChatStore((s) => s.regenerateAssistantResponse);
  const showPreviousResponseVersion = useChatStore((s) => s.showPreviousResponseVersion);
  const showNextResponseVersion = useChatStore((s) => s.showNextResponseVersion);
  const showPreviousRetryVersion = useChatStore((s) => s.showPreviousRetryVersion);
  const showNextRetryVersion = useChatStore((s) => s.showNextRetryVersion);
  const cancel = useChatStore((s) => s.cancel);
  const [feedbackByMessageId, setFeedbackByMessageId] = React.useState<
    Record<string, ChatFeedbackValue>
  >({});
  const feedbackClient = React.useMemo(() => createPortalChatFeedbackClient(), []);
  const feedbackHydrationSeqRef = React.useRef(0);
  const feedbackSessionId = String(activeSessionId ?? "").trim();
  const displayErrorMessage =
    errorMessage === STREAM_UPDATE_DEPTH_ERROR ? t("updateDepthError") : errorMessage;
  const quotaError = Boolean(structuredQuotaError) || isLegacyEnterpriseQuotaError(errorMessage);
  const [draft, setDraft] = React.useState("");
  /** Default auto (on) — aligned with product expectation for portal chat. */
  const [webSearchMode, setWebSearchMode] = React.useState<WebSearchMode>("auto");
  /** 深度研究确认方式偏好（localStorage 持久化；auto = 交给服务端 policy）。 */
  const [interactionPref, setInteractionPref] =
    React.useState<DeepResearchInteractionPref>(() => getDeepResearchInteractionPref());
  const [prefMenuOpen, setPrefMenuOpen] = React.useState(false);
  const prefMenuRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!prefMenuOpen) return;
    const onDocMouseDown = (event: MouseEvent) => {
      if (prefMenuRef.current && !prefMenuRef.current.contains(event.target as Node)) {
        setPrefMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [prefMenuOpen]);
  const [filesPanelSessionId, setFilesPanelSessionId] = React.useState<string | null>(null);
  const [filesPanelFocusId, setFilesPanelFocusId] = React.useState<string | null>(null);
  const [filesPanelLane, setFilesPanelLane] = React.useState<DeepResearchPanelLane | null>(
    null,
  );
  const [attachmentPreview, setAttachmentPreview] = React.useState<ChatMessageAttachment | null>(null);
  const [shareDialogOpen, setShareDialogOpen] = React.useState(false);
  const [shareInitialSelectedIds, setShareInitialSelectedIds] = React.useState<string[]>([]);

  // Stable identities: MessageList folds these into memo dependencies that decide whether
  // the assistant markdown component map is rebuilt, so inline arrows here would rebuild
  // (and visibly re-mount) every rendered citation chip on each composer keystroke.
  const requestDeepResearchFiles = React.useCallback(
    (sessionId: string, focusArtifactId?: string | null) => {
      setAttachmentPreview(null);
      setFilesPanelSessionId(sessionId);
      setFilesPanelLane(null);
      setFilesPanelFocusId(focusArtifactId ?? null);
    },
    [],
  );
  const requestDeepResearchLaneSources = React.useCallback(
    (sessionId: string, lane: DeepResearchPanelLane) => {
      setAttachmentPreview(null);
      setFilesPanelSessionId(sessionId);
      setFilesPanelFocusId(null);
      setFilesPanelLane(lane);
    },
    [],
  );
  const requestAttachmentPreview = React.useCallback((attachment: ChatMessageAttachment) => {
    setFilesPanelSessionId(null);
    setFilesPanelFocusId(null);
    setFilesPanelLane(null);
    setAttachmentPreview(attachment);
  }, []);
  const requestExternalLink = React.useCallback((url: string, title?: string) => {
    navigateToExternalLink(url, title);
  }, []);

  React.useEffect(() => {
    const sessionId = feedbackSessionId;
    const requestSeq = ++feedbackHydrationSeqRef.current;
    let cancelled = false;
    setFeedbackByMessageId({});
    if (!sessionId) return () => {
      cancelled = true;
    };

    void feedbackClient
      .list(sessionId)
      .then((next) => {
        if (
          cancelled ||
          requestSeq !== feedbackHydrationSeqRef.current ||
          useChatStore.getState().activeSessionId !== sessionId
        ) {
          return;
        }
        setFeedbackByMessageId(next);
      })
      .catch(() => {
        // Feedback is supplementary to chat history. Keep the actions usable;
        // a failed read must not turn a normal conversation into an error page.
      });

    return () => {
      cancelled = true;
    };
  }, [feedbackClient, feedbackSessionId]);

  const handleFeedback = React.useCallback(
    async (messageId: string, value: ChatFeedbackValue | null) => {
      const sessionId = String(activeSessionId ?? "").trim();
      const normalizedMessageId = String(messageId ?? "").trim();
      const message = useChatStore
        .getState()
        .messages.find((item) => item.id === normalizedMessageId);
      if (!sessionId || !normalizedMessageId || !message || message.session_id !== sessionId) {
        throw new Error("反馈消息已失效，请刷新后重试");
      }
      if (message.role !== "assistant") {
        throw new Error("只有助手回复可以反馈");
      }

      if (value === null) {
        await feedbackClient.clear({ sessionId, messageId: normalizedMessageId });
      } else {
        await feedbackClient.set({
          sessionId,
          messageId: normalizedMessageId,
          value,
        });
      }

      // A response from a previous session must never repaint the current one.
      if (useChatStore.getState().activeSessionId !== sessionId) return;
      setFeedbackByMessageId((prev) => {
        if (value === null) {
          if (!Object.prototype.hasOwnProperty.call(prev, normalizedMessageId)) return prev;
          const next = { ...prev };
          delete next[normalizedMessageId];
          return next;
        }
        return { ...prev, [normalizedMessageId]: value };
      });
    },
    [activeSessionId, feedbackClient],
  );

  React.useEffect(() => {
    setFilesPanelSessionId(null);
    setFilesPanelFocusId(null);
  }, [activeSessionId]);

  // 切换会话时必须停掉所有重连流：否则旧流继续轮询并把事件追加到别条消息上。
  React.useEffect(() => {
    return () => {
      abortAllDeepResearchReconnects();
    };
  }, [activeSessionId]);

  const handleDeepResearchRecover = React.useCallback((run: ActiveDeepResearchRun) => {
    const sessionId = run.sessionId;
    const state = useChatStore.getState();
    // 原始聊天流仍活着时，它就是事件的唯一来源；此时再走重连回放会把同一批
    // live 事件追加两遍（撰写报告卡片翻倍的根因之一）。只把视图带回去即可。
    if (isSessionStreaming(state, sessionId)) {
      console.info("[deep-research] recover skipped: original stream still live for", run.runId);
      return;
    }
    const existing = [...state.messages]
      .reverse()
      .find(
        (m) =>
          m.session_id === sessionId &&
          m.role === "assistant" &&
          m.deep_research?.runId === run.runId,
      );
    const targetId = existing?.id;
    if (!targetId) {
      // No matching bubble yet — stream still reconnects into a local placeholder via content only.
      console.info("[deep-research] reconnect: no assistant bubble for", run.runId);
    } else {
      useChatStore.setState((prev) => ({
        messages: prev.messages.map((m) =>
          m.id === targetId
            ? {
                ...m,
                content: "",
                deep_research: {
                  runId: run.runId,
                  status: run.status === "awaiting_clarify" ? "awaiting_clarify" : "running",
                  events: [],
                  artifactIds: [],
                  clarifyAnswers: m.deep_research?.clarifyAnswers,
                },
              }
            : m,
        ),
      }));
    }

    void startDeepResearchReconnect(run.runId, {
      onEvent: (event) => {
        if (!targetId) return;
        useChatStore.setState((prev) => ({
          messages: prev.messages.map((m) => {
            if (m.id !== targetId) return m;
            const prevDr = m.deep_research;
            let status: NonNullable<typeof prevDr>["status"] = prevDr?.status ?? "running";
            if (event.type === "clarify" || event.type === "clarify_chat") status = "awaiting_clarify";
            else if (event.type === "research_plan" && event.action === "proposed") {
              status = "awaiting_clarify";
            } else if (event.type === "research_plan" && event.action === "approved") {
              status = "running";
            } else if (event.type === "research_plan" && event.action === "updated") {
              const visibility =
                prevDr?.profile?.planVisibility ??
                [...(prevDr?.events ?? [])]
                  .reverse()
                  .find((item) => item.type === "research_profile")?.planVisibility;
              status = visibility === "chat_editable" ? "awaiting_clarify" : "running";
            } else if (event.type === "phase" && event.phase === "done") status = "completed";
            else if (status === "awaiting_clarify") {
              const eventsSoFar = [...(prevDr?.events ?? []), event];
              const latestPlan = [...eventsSoFar]
                .reverse()
                .find((e) => e.type === "research_plan");
              const visibility =
                prevDr?.profile?.planVisibility ??
                [...(prevDr?.events ?? [])]
                  .reverse()
                  .find((item) => item.type === "research_profile")?.planVisibility;
              const planGateOpen =
                latestPlan?.type === "research_plan" &&
                (latestPlan.action === "proposed" ||
                  (visibility === "chat_editable" && latestPlan.action === "updated"));
              const laneId = event.type === "lane_started" ? event.laneId : "";
              const reconLane =
                event.type === "lane_started" &&
                (laneId === "recon-cold-start" || laneId.startsWith("recon-"));
              if (
                !reconLane &&
                (!planGateOpen ||
                  event.type === "clarify_timeout" ||
                  (event.type === "lane_started" && !reconLane))
              ) {
                status = "running";
              }
            }
            const events = appendDeepResearchEvent(prevDr?.events ?? [], event, 400);
            const artifactIds = [...(prevDr?.artifactIds ?? [])];
            if (event.type === "artifact" && !artifactIds.includes(event.id)) {
              artifactIds.push(event.id);
            }
            const nextProfile =
              event.type === "research_profile"
                ? {
                    researchDepth: event.researchDepth,
                    clarifyMode: event.clarifyMode,
                    clarifyBudget: event.clarifyBudget,
                    planVisibility: event.planVisibility,
                    assumptions: event.assumptions,
                  }
                : prevDr?.profile;
            const nextPlan = event.type === "research_plan" ? event.plan : prevDr?.plan;
            const nextPlanVersion =
              event.type === "research_plan" ? event.version : prevDr?.planVersion;
            return {
              ...m,
              deep_research: {
                runId: run.runId,
                status,
                events,
                artifactIds,
                clarifyAnswers: prevDr?.clarifyAnswers,
                ...(nextProfile ? { profile: nextProfile } : {}),
                ...(nextPlan ? { plan: nextPlan } : {}),
                ...(nextPlanVersion ? { planVersion: nextPlanVersion } : {}),
                ...(nextProfile?.assumptions?.length
                  ? { assumptions: nextProfile.assumptions }
                  : {}),
              },
            };
          }),
        }));
      },
      onDelta: (text) => {
        if (!targetId) return;
        useChatStore.setState((prev) => ({
          messages: prev.messages.map((m) =>
            m.id === targetId ? { ...m, content: `${m.content ?? ""}${text}` } : m,
          ),
        }));
      },
      onDone: () => {
        if (!targetId) return;
        useChatStore.setState((prev) => ({
          messages: prev.messages.map((m) =>
            m.id === targetId && m.deep_research
              ? {
                  ...m,
                  deep_research: {
                    ...m.deep_research,
                    status:
                      m.deep_research.status === "awaiting_clarify"
                        ? "awaiting_clarify"
                        : "completed",
                  },
                }
              : m,
          ),
        }));
      },
    }).catch((error) => {
      console.warn("[deep-research] reconnect failed:", error);
    });
  }, []);

  // 计划确认提交后（含进程重启后的孤儿续跑）：若原 SSE 已死，拉起 reconnect 吃 run-store 事件。
  React.useEffect(() => {
    const onPlanResumed = (event: Event) => {
      const runId = (event as CustomEvent<{ runId?: string }>).detail?.runId?.trim();
      const sessionId = useChatStore.getState().activeSessionId?.trim();
      if (!runId || !sessionId) return;
      if (isSessionStreaming(useChatStore.getState(), sessionId)) return;
      handleDeepResearchRecover({
        runId,
        sessionId,
        status: "running",
        phase: "lanes",
        topic: "",
        updatedAt: new Date().toISOString(),
      });
    };
    window.addEventListener("agx-deep-research-plan-resumed", onPlanResumed);
    return () => {
      window.removeEventListener("agx-deep-research-plan-resumed", onPlanResumed);
    };
  }, [handleDeepResearchRecover]);

  const filesPanelSources = React.useMemo(() => {
    if (!filesPanelSessionId) return [];
    const sessionMsgs = messages.filter((m) => m.session_id === filesPanelSessionId);
    for (let i = sessionMsgs.length - 1; i >= 0; i -= 1) {
      const sources = sessionMsgs[i]?.web_search_sources;
      if (sources && sources.length > 0) return sources;
    }
    return [];
  }, [messages, filesPanelSessionId]);

  const setDeepResearchMode = React.useCallback(
    (next: DeepResearchMode) => {
      onDeepResearchModeChange?.(next);
    },
    [onDeepResearchModeChange],
  );
  const [visionWarning, setVisionWarning] = React.useState<string | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const {
    attachments,
    attachmentError,
    addFiles,
    removeAttachment,
    clearAttachments,
    toMessageAttachments,
    prepareImagesForTextModel,
  } = useComposerAttachments();
  const [modelMenuOpen, setModelMenuOpen] = React.useState(false);
  const modelMenuRef = React.useRef<HTMLDivElement>(null);
  const modelTriggerRef = React.useRef<HTMLButtonElement>(null);
  const [modelMenuPosition, setModelMenuPosition] = React.useState<{
    top: number;
    left: number;
    width: number;
    maxHeight: number;
  }>({
    top: 0,
    left: 0,
    width: 320,
    maxHeight: 320,
  });

  // 动态拉取当前用户可见的模型清单。
  // 管理员随时可能改变部门/用户的可见模型分配，因此这里不能只在挂载时拉一次：
  // 定期轮询 + 页面重新可见/聚焦时立即刷新，让列表与实际权限自动保持同步，无需用户手动刷新整页。
  const [availableModels, setAvailableModels] = React.useState<PortalModelOption[]>([]);
  const [modelsLoaded, setModelsLoaded] = React.useState(false);
  const [attachmentRouting, setAttachmentRouting] = React.useState<AttachmentRoutingPolicy>(
    DISABLED_ATTACHMENT_ROUTING,
  );
  const [routingPromptTarget, setRoutingPromptTarget] = React.useState<RoutingModelRef | null>(null);
  const routingPromptResolverRef = React.useRef<
    ((choice: "private" | "public" | "cancel") => void) | null
  >(null);

  const requestAttachmentRoutingChoice = React.useCallback(
    (target: RoutingModelRef) =>
      new Promise<"private" | "public" | "cancel">((resolve) => {
        routingPromptResolverRef.current?.("cancel");
        routingPromptResolverRef.current = resolve;
        setRoutingPromptTarget(target);
      }),
    [],
  );
  const settleAttachmentRoutingChoice = React.useCallback(
    (choice: "private" | "public" | "cancel") => {
      const resolve = routingPromptResolverRef.current;
      routingPromptResolverRef.current = null;
      setRoutingPromptTarget(null);
      resolve?.(choice);
    },
    [],
  );
  React.useEffect(
    () => () => {
      routingPromptResolverRef.current?.("cancel");
      routingPromptResolverRef.current = null;
    },
    [],
  );

  const composerAttachmentNames = React.useMemo(
    () => Object.values(attachments).map((attachment) => attachment.name),
    [attachments],
  );
  const composerHasRoutedDocument = React.useMemo(
    () => hasRoutedDocument(composerAttachmentNames, attachmentRouting),
    [attachmentRouting, composerAttachmentNames],
  );

  const activeSessionAttachmentNames = React.useMemo(
    () =>
      messages.flatMap((message) =>
        message.session_id === activeSessionId
          ? (message.attachments ?? []).map((attachment) => attachment.name)
          : [],
      ),
    [activeSessionId, messages],
  );
  const attachmentRoutingLocked = React.useMemo(
    () => hasRoutedDocument(activeSessionAttachmentNames, attachmentRouting),
    [activeSessionAttachmentNames, attachmentRouting],
  );
  const attachmentRoutingTarget = attachmentRouting.documentTarget;
  const activeModelUsesPublicRoute = availableModels.some(
    (model) => model.id === activeModel && model.route === "third-party",
  );
  const canChoosePublicAttachmentRoute =
    attachmentRouting.allowPublicOverride && activeModelUsesPublicRoute;
  const privateAttachmentSessionLocked = Boolean(
    attachmentRoutingLocked &&
      attachmentRoutingTarget &&
      activeModel === attachmentRoutingTarget.id,
  );
  const attachmentRoutingPickerLocked = Boolean(
      composerHasRoutedDocument ||
      privateAttachmentSessionLocked ||
      (attachmentRoutingLocked && !canChoosePublicAttachmentRoute),
  );

  const refreshAvailableModels = React.useCallback(async () => {
    try {
      const res = await fetch("/api/me/models", { cache: "no-store" });
      if (!res.ok) return;
      const json = (await res.json()) as {
        data?: {
          models?: PortalModelOption[];
          attachmentRouting?: AttachmentRoutingPolicy;
        };
      };
      setAvailableModels(json.data?.models ?? []);
      setAttachmentRouting(
        json.data?.attachmentRouting ?? DISABLED_ATTACHMENT_ROUTING,
      );
    } catch {
      // 开发服过载 / 本机代理劫持 localhost 时 fetch 会抛 TypeError: Failed to fetch。
      // 轮询失败不应打到 Next 运行时错误浮层；保留上一份 models，等下次轮询。
    } finally {
      setModelsLoaded(true);
    }
  }, []);

  React.useEffect(() => {
    void refreshAvailableModels();
    const intervalId = window.setInterval(() => void refreshAvailableModels(), 20_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") void refreshAvailableModels();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      window.clearInterval(intervalId);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [refreshAvailableModels]);

  // 收到模型列表后兜底选默认：优先 isDefault，否则首项。
  // 依赖模型 id 序列而非 availableModels 数组引用，避免轮询刷新单独触发无意义 switchModel。
  const availableModelIdsKey = availableModels.map((m) => m.id).join("|");
  React.useEffect(() => {
    if (!modelsLoaded) return;
    if (!availableModelIdsKey) return;
    const exists = availableModels.some((m) => m.id === activeModel);
    if (exists) return;
    const next = resolveAvailableDefaultModel(
      availableModels,
      readDefaultModelPreference(),
      activeModel,
    );
    if (!next) return;
    writeDefaultModelPreference(next.id);
    if (useChatStore.getState().activeModel === next.id) return;
    probeNote("MachiChatView.switchModelFallback", { from: activeModel, to: next.id });
    switchModel(next.id);
    // availableModels read from latest render when ids key / activeModel changes
  }, [modelsLoaded, availableModelIdsKey, activeModel, switchModel]);

  // 强制模式在附件进入输入框时就切换；有例外权的成员要先在发送时作出明确选择。
  // 服务端仍会独立判一次，这里只负责让选择器和实际数据流向保持一致。
  React.useEffect(() => {
    const target = attachmentRouting.documentTarget;
    const mustForcePrivate =
      !canChoosePublicAttachmentRoute &&
      (attachmentRoutingLocked || composerHasRoutedDocument);
    if (!mustForcePrivate || !target || activeModel === target.id) return;
    if (!availableModels.some((model) => model.id === target.id)) return;
    setModelMenuOpen(false);
    switchModel(target.id);
  }, [
    activeModel,
    attachmentRouting.documentTarget,
    attachmentRoutingLocked,
    availableModels,
    canChoosePublicAttachmentRoute,
    composerHasRoutedDocument,
    switchModel,
  ]);

  // 若发送因「模型已不在可见范围内」被服务端拒绝（管理员刚收窄了权限，轮询尚未来得及刷新），
  // 立即补拉一次最新列表，让下拉框与兜底选择马上纠正，不必等下一个轮询周期或用户手动刷新整页。
  React.useEffect(() => {
    if (errorMessage && errorMessage.includes("不在您的可见范围内")) {
      void refreshAvailableModels();
    }
  }, [errorMessage, refreshAvailableModels]);

  React.useEffect(() => {
    void hydrateSessions();
  }, [hydrateSessions]);

  React.useEffect(() => {
    if (!modelMenuOpen) return;
    const updatePosition = () => {
      const trigger = modelTriggerRef.current;
      if (!trigger) return;
      const margin = 8;
      const minMaxHeight = 120;
      const rect = trigger.getBoundingClientRect();
      const width = Math.min(360, Math.max(280, rect.width + 88));
      const left = Math.min(window.innerWidth - width - margin, Math.max(margin, rect.right - width));
      // 菜单向上展开（translateY(-100%)），CSS top 即视觉底边；上方可用高度 = top - margin
      const top = Math.max(margin, rect.top - margin);
      const maxHeight = Math.max(minMaxHeight, top - margin);
      setModelMenuPosition({ top, left, width, maxHeight });
    };
    updatePosition();

    const onClickOutside = (event: MouseEvent) => {
      const el = modelMenuRef.current;
      if (!el) return;
      if (!el.contains(event.target as Node)) setModelMenuOpen(false);
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setModelMenuOpen(false);
    };
    document.addEventListener("mousedown", onClickOutside);
    document.addEventListener("keydown", onEscape);
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      document.removeEventListener("mousedown", onClickOutside);
      document.removeEventListener("keydown", onEscape);
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [modelMenuOpen]);

  const activeOption = React.useMemo(
    () => availableModels.find((m) => m.id === activeModel) ?? null,
    [availableModels, activeModel],
  );

  const modelTriggerLabel = React.useMemo(() => {
    if (activeOption) return activeOption.label;
    if (!modelsLoaded) return t("loading");
    if (activeModel && activeModel !== "mock-model-v1") {
      return formatActiveModelFallback(activeModel);
    }
    return availableModels.length === 0 ? t("noAvailableModel") : t("selectModel");
  }, [activeOption, modelsLoaded, activeModel, availableModels.length, t]);

  const modelMenuEmptyHint = React.useMemo(() => {
    if (availableModels.length > 0) return null;
    if (activeModel && activeModel !== "mock-model-v1") {
      return t("modelNotAssignedHint", { model: formatActiveModelFallback(activeModel) });
    }
    return t("noModelsHint");
  }, [availableModels.length, activeModel, t]);

  const visibleMessages = React.useMemo(() => {
    if (!activeSessionId) return [];
    return messages.filter((message) => message.session_id === activeSessionId);
  }, [messages, activeSessionId]);

  const shareableMessages = React.useMemo(
    () => visibleMessages.map(toChatShareMessage).filter((message): message is ChatShareMessage => message !== null),
    [visibleMessages],
  );

  const openShareDialog = React.useCallback(
    (messageSelection?: string) => {
      const allIds = shareableMessages.map((message) => message.id);
      const requestedIds = (messageSelection ?? "")
        .split(",")
        .map((id) => id.trim())
        .filter((id) => allIds.includes(id));
      if (requestedIds.length === 0) {
        setShareInitialSelectedIds(allIds);
      } else {
        const selectedIds = new Set<string>();
        requestedIds.forEach((id) => {
          expandChatShareTurnSelection(shareableMessages, id).forEach((selectedId) => selectedIds.add(selectedId));
        });
        setShareInitialSelectedIds(allIds.filter((id) => selectedIds.has(id)));
      }
      setShareDialogOpen(true);
    },
    [shareableMessages],
  );

  /** 工作台已有事件的 run：用户正在看，不必再挂「继续查看」。空壳（刷新未回放）仍要露出横条。 */
  const visibleDeepResearchRunIds = React.useMemo(() => {
    const ids = new Set<string>();
    for (const message of visibleMessages) {
      if (message.role !== "assistant" || !message.deep_research?.runId) continue;
      const runId = message.deep_research.runId;
      if (runId === "pending") continue;
      if ((message.deep_research.events?.length ?? 0) > 0) ids.add(runId);
    }
    return ids;
  }, [visibleMessages]);

  const streamStateBySessionId = useChatStore((s) => s.streamStateBySessionId);
  const suppressRecoverWhileStreaming = isSessionStreaming(
    { streamStateBySessionId },
    activeSessionId,
  );

  const userIdsInActiveSession = React.useMemo(() => {
    return new Set(visibleMessages.filter((message) => message.role === "user").map((message) => message.id));
  }, [visibleMessages]);

  const isEmpty = visibleMessages.length === 0;
  React.useEffect(() => {
    setModelMenuOpen(false);
  }, [isEmpty]);
  const { responseVersionMetaByUserMessageId, retryVersionMetaByUserMessageId } = React.useMemo(() => {
    const queryMeta: Record<string, { activeIndex: number; total: number }> = {};
    const retryMeta: Record<string, { activeIndex: number; total: number }> = {};

    Object.entries(responseVersionsByUserMessageId).forEach(([userMessageId, versionState]) => {
      if (!userIdsInActiveSession.has(userMessageId)) return;
      const versions = versionState.versions ?? [];
      if (versions.length === 0) {
        queryMeta[userMessageId] = { activeIndex: 0, total: 0 };
        retryMeta[userMessageId] = { activeIndex: 0, total: 0 };
        return;
      }

      const queryVersionIndices = Array.from(new Set(versions.map((version) => version.queryVersionIndex ?? 0))).sort((a, b) => a - b);
      const activeVersion = versions[versionState.activeIndex] ?? versions[versions.length - 1];
      const activeQueryVersionIndex = activeVersion?.queryVersionIndex ?? 0;
      const activeQueryPosition = Math.max(0, queryVersionIndices.indexOf(activeQueryVersionIndex));
      queryMeta[userMessageId] = {
        activeIndex: activeQueryPosition,
        total: queryVersionIndices.length,
      };

      const activeRetryVersions = versions
        .map((version, index) => ({ version, index }))
        .filter(({ version }) => (version.queryVersionIndex ?? 0) === activeQueryVersionIndex)
        .sort((a, b) => ((a.version.retryAttempt ?? 0) - (b.version.retryAttempt ?? 0)) || (a.index - b.index));
      const activeRetryIndices = activeRetryVersions.map(({ index }) => index);
      const activeRetryPosition = Math.max(0, activeRetryIndices.indexOf(versionState.activeIndex));
      retryMeta[userMessageId] = {
        activeIndex: activeRetryPosition,
        total: activeRetryIndices.length,
      };
    });

    return {
      responseVersionMetaByUserMessageId: queryMeta,
      retryVersionMetaByUserMessageId: retryMeta,
    };
  }, [responseVersionsByUserMessageId, userIdsInActiveSession]);
  const activeSession = React.useMemo(
    () => sessions.find((session) => session.id === activeSessionId),
    [sessions, activeSessionId],
  );
  const [sessionTitle, setSessionTitle] = React.useState(t("newConversation"));
  const [isEditingTitle, setIsEditingTitle] = React.useState(false);
  const [copiedSessionId, setCopiedSessionId] = React.useState(false);
  const titleInputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    setIsEditingTitle(false);
    if (activeSession) {
      setSessionTitle(activeSession.title);
      return;
    }
    setSessionTitle(t("newConversation"));
  }, [activeSession?.id, activeSession?.title, activeSessionId, t]);

  const createShareLink = React.useCallback(
    async (messageIds: string[]) => {
      if (!activeSessionId) throw new Error(t("shareFailed"));
      const response = await fetch("/api/chat/shares", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: activeSessionId, message_ids: messageIds }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        data?: { path?: string; share_url?: string };
        error?: { message?: string };
      };
      if (!response.ok || !payload.data?.path) {
        const message = payload.error?.message;
        if (message === "select at least one message to share") {
          throw new Error(t("shareSyncError"));
        }
        throw new Error(message ?? t("shareFailed"));
      }
      return buildBrowserShareUrl(payload.data.path, window.location.origin);
    },
    [activeSessionId, t],
  );

  const generateShareImage = React.useCallback(
    async (selectedMessages: ChatShareMessage[]) => {
      const snapshot: ChatShareSnapshot = {
        token: "preview",
        session_id: activeSessionId ?? "preview",
        title: sessionTitle,
        messages: selectedMessages,
        created_at: new Date().toISOString(),
      };
      const safeTitle = (sessionTitle || t("newConversation"))
        .replace(/[\\/:*?"<>|]+/g, "_")
        .slice(0, 80);
      await downloadShareImage(snapshot, `${safeTitle}.png`);
    },
    [activeSessionId, sessionTitle, t],
  );

  const deleteCurrentSession = React.useCallback(() => {
    if (!activeSessionId) return;
    if (!window.confirm(tw("deleteSessionConfirm"))) return;
    void deleteSession(activeSessionId);
  }, [activeSessionId, deleteSession, tw]);

  const activeModelOption = React.useMemo(
    () => availableModels.find((item) => item.id === activeModel),
    [availableModels, activeModel],
  );

  const visionSupported = React.useMemo(
    () =>
      modelSupportsVision(
        activeModelOption?.provider ?? "",
        activeModelOption?.model ?? activeModel,
        activeModelOption?.capabilities,
      ),
    [activeModelOption, activeModel],
  );

  const notifyVisionFallback = React.useCallback(() => {
    if (visionSupported) return;
    setVisionWarning("当前模型不支持原生图片，发送时将由私有视觉模型解析（含 OCR 兜底）");
    window.setTimeout(() => setVisionWarning(null), 3200);
  }, [visionSupported]);

  const handleAddFiles = React.useCallback(
    (files: File[]) => {
      if (files.length === 0) return;
      const hasImages = files.some((file) => classifyAttachment(file) === "image");
      if (hasImages) notifyVisionFallback();
      addFiles(files);
    },
    [addFiles, notifyVisionFallback],
  );

  const handlePaste = React.useCallback(
    (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const raw = extractClipboardImageFiles(event.clipboardData);
      if (raw.length === 0) return;
      event.preventDefault();
      handleAddFiles(withClipboardImageNames(raw));
    },
    [handleAddFiles],
  );

  const handleSend = React.useCallback(
    (opts?: { forceSend?: boolean }) => {
      const trimmed = draft.trim();
      const initialAttachments = toMessageAttachments();
      if (!trimmed && initialAttachments.length === 0) return;
      // Capture the conversation before any attachment preprocessing.  A
      // user can switch conversations while image parsing or the routing
      // choice is awaiting; without this owner, sendMessage would default to
      // whichever conversation happens to be visible when the await settles.
      const sendSessionId = String(useChatStore.getState().activeSessionId ?? "").trim();
      if (!sendSessionId) return;
      const isSendSessionDisplayed = () =>
        isMachiChatSessionDisplayed(
          sendSessionId,
          useChatStore.getState().activeSessionId,
        );
      const manuallyActivatedDeepResearch = deepResearchMode === "manual";
      // 计划卡仍在时：主输入只改方案，绝不排队 / forceSend 开新对话。
      void (async () => {
        const store = useChatStore.getState();
        const sid = sendSessionId;
        if (!isSendSessionDisplayed()) return;
        if (findActivePlanChatGate(store.messages, sid)) {
          const handled = await resumePlanChatFromComposer(trimmed);
          if (handled && isSendSessionDisplayed()) {
            setDraft("");
          }
          return;
        }
        if (!isSendSessionDisplayed()) return;
        let messageAttachments = initialAttachments;
        const hasImages = messageAttachments.some(
          (attachment) =>
            attachment.kind === "image" || attachment.mime_type.startsWith("image/"),
        );
        if (!visionSupported && hasImages) {
          setVisionWarning("正在由私有视觉模型解析图片（含 OCR 兜底）…");
          try {
            messageAttachments = await prepareImagesForTextModel(activeModel);
            if (!isSendSessionDisplayed()) return;
            setVisionWarning(null);
          } catch (error) {
            if (!isSendSessionDisplayed()) return;
            const message = error instanceof Error ? error.message : "图片解析失败";
            setVisionWarning(message);
            window.setTimeout(() => setVisionWarning(null), 4200);
            return;
          }
        }
        const documentTarget = attachmentRouting.documentTarget;
        const currentTurnHasRoutedDocument = Boolean(
          documentTarget &&
            hasRoutedDocument(
              messageAttachments.map((attachment) => attachment.name),
              attachmentRouting,
            ),
        );
        let attachmentRoutingDecision: "private" | "public" | undefined;
        if (documentTarget && currentTurnHasRoutedDocument) {
          if (canChoosePublicAttachmentRoute && activeModel !== documentTarget.id) {
            if (!isSendSessionDisplayed()) return;
            const choice = await requestAttachmentRoutingChoice(documentTarget);
            if (!isSendSessionDisplayed()) return;
            if (choice === "cancel") return;
            attachmentRoutingDecision = choice;
          } else {
            attachmentRoutingDecision = "private";
          }
          if (attachmentRoutingDecision === "private" && activeModel !== documentTarget.id) {
            // Zustand updates synchronously, so sendMessage below reads the private target
            // immediately rather than the model from this render.
            switchModel(documentTarget.id);
          }
        }
        if (!isSendSessionDisplayed()) return;
        await sendMessage(
          client,
          {
            content: trimmed,
            attachments: messageAttachments,
            webSearch: webSearchMode === "auto",
            deepResearch: deepResearchMode === "manual",
            deepResearchAuto: deepResearchMode === "auto",
            attachmentRoutingDecision,
          },
          {
            ...(opts?.forceSend ? { forceSend: true } : {}),
            targetSessionId: sendSessionId,
            onAccepted: (acceptedSessionId) => {
              if (
                isMachiChatSessionDisplayed(
                  acceptedSessionId,
                  useChatStore.getState().activeSessionId,
                )
              ) {
                setDraft("");
                clearAttachments();
                if (manuallyActivatedDeepResearch) {
                  onDeepResearchModeChange?.("auto", acceptedSessionId);
                }
              }
            },
          },
        );
      })();
    },
    [
      clearAttachments,
      client,
      activeModel,
      attachmentRouting,
      canChoosePublicAttachmentRoute,
      deepResearchMode,
      draft,
      prepareImagesForTextModel,
      requestAttachmentRoutingChoice,
      resumePlanChatFromComposer,
      sendMessage,
      switchModel,
      toMessageAttachments,
      visionSupported,
      webSearchMode,
      onDeepResearchModeChange,
    ],
  );

  const queuedForSession = React.useMemo(() => {
    if (!activeSessionId) return [];
    return pendingMessages.filter((message) => message.sessionId === activeSessionId);
  }, [activeSessionId, pendingMessages]);

  const planChatGateActive = React.useMemo(() => {
    if (!activeSessionId) return false;
    return Boolean(findActivePlanChatGate(messages, activeSessionId));
  }, [activeSessionId, messages]);

  const activeHistorySync = activeSessionId
    ? historySyncBySessionId[activeSessionId]
    : undefined;
  const showSessionHistorySync = shouldShowHistorySyncAlert(activeHistorySync);

  const composer = (
    <div className={cn("mx-auto w-full space-y-3", isEmpty ? "max-w-[46rem]" : "max-w-4xl")}>
      <QuotaLimitNotice
        forceOpen={quotaError && !structuredQuotaError}
        quotaError={structuredQuotaError}
      />
      {historyError && (
        <Alert variant="warning" className="border-warning/30 bg-warning-soft/80 shadow-sm">
          <ShieldAlert className="h-5 w-5" />
          <div>
            <AlertTitle>{t("historySyncTitle")}</AlertTitle>
            <AlertDescription>{historyError}</AlertDescription>
          </div>
        </Alert>
      )}
      {showSessionHistorySync && activeHistorySync && (
        <Alert
          variant="warning"
          className="border-warning/30 bg-warning-soft/80 shadow-sm"
          aria-live={
            activeHistorySync.state === "dead_letter" || activeHistorySync.state === "paused"
              ? "assertive"
              : "polite"
          }
        >
          <ShieldAlert className="h-5 w-5" />
          <div className="flex flex-1 items-start justify-between gap-3">
            <div>
              <AlertTitle>{t("historySyncTitle")}</AlertTitle>
              <AlertDescription>
                {activeHistorySync.message || t("historySyncPending")}
              </AlertDescription>
            </div>
            {activeHistorySync.state === "dead_letter" &&
              activeHistorySync.pendingCount > 0 &&
              activeSessionId && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="shrink-0"
                onClick={() => {
                  void retryHistorySync(activeSessionId);
                }}
              >
                {t("historySyncRetry")}
              </Button>
            )}
          </div>
        </Alert>
      )}
      {displayErrorMessage && !quotaError && (
        <Alert variant="warning" className="border-warning/30 bg-warning-soft/80 shadow-sm">
          <ShieldAlert className="h-5 w-5" />
          <div>
            <AlertTitle>
              {errorMessage === STREAM_UPDATE_DEPTH_ERROR
                ? t("updateDepthTitle")
                : isComplianceError(errorMessage ?? "")
                  ? t("complianceTitle")
                  : t("chatErrorTitle")}
            </AlertTitle>
            <AlertDescription>{displayErrorMessage}</AlertDescription>
          </div>
        </Alert>
      )}
      {(visionWarning || attachmentError) && (
        <Alert variant="warning" className="border-amber-300/60 bg-amber-50/90 text-amber-950 shadow-sm dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100">
          <ShieldAlert className="h-5 w-5" />
          <AlertDescription>{visionWarning ?? attachmentError}</AlertDescription>
        </Alert>
      )}
      <AttachmentRoutingStatusAlert
        target={attachmentRoutingTarget}
        composerHasRoutedDocument={composerHasRoutedDocument}
        sessionHasRoutedDocument={attachmentRoutingLocked}
        privateSessionLocked={privateAttachmentSessionLocked}
        canChoosePublicRoute={canChoosePublicAttachmentRoute}
        scopeKey={activeSessionId || "new-session"}
      />

      <input
        ref={fileInputRef}
        type="file"
        accept={DOCUMENT_ACCEPT}
        multiple
        className="hidden"
        onChange={(event) => {
          const files = event.target.files ? Array.from(event.target.files) : [];
          if (files.length > 0) handleAddFiles(files);
          event.target.value = "";
        }}
      />

      <MessageQueuePanel
        messages={queuedForSession}
        onEdit={editPendingMessage}
        onRemove={removePendingMessage}
        onSendNow={(id) => void sendQueuedMessageNow(client, id)}
      />

      <InputArea
        value={draft}
        // 计划对齐：空闲时隐藏停止钮；正在改计划时显示 sending，避免「发出去没反应」。
        status={
          planChatRevising ? "sending" : planChatGateActive ? "idle" : status
        }
        onChange={setDraft}
        onSend={() => handleSend()}
        onForceSend={() => handleSend({ forceSend: true })}
        onCancel={() => void cancel(client)}
        appearance="portal"
        minTextareaHeight={isEmpty ? 96 : undefined}
        className={
          isEmpty
            ? "min-h-[9.75rem] !rounded-[1.75rem] !px-4 !pb-3 !pt-3.5 shadow-[0_10px_40px_-18px_rgba(15,23,42,0.18)]"
            : undefined
        }
        placeholder={
          planChatGateActive
            ? "修改研究计划，例如：侧重性能 / 增加成本分析 / 去掉某方向…"
            : deepResearchMode !== "off"
              ? tw("deepResearchPlaceholder")
              : `发送消息给${ENTERPRISE_PRODUCT_NAME}...`
        }
        attachments={Object.values(attachments)}
        onAddFiles={handleAddFiles}
        onRemoveAttachment={removeAttachment}
        onPaste={handlePaste}
        leftToolbar={
          <>
            <ComposerPlusMenu
              key="composer-plus"
              webSearchMode={webSearchMode}
              onWebSearchModeChange={setWebSearchMode}
              deepResearchMode={deepResearchMode}
              onDeepResearchModeChange={onDeepResearchModeChange ?? (() => undefined)}
              onPickFiles={() => fileInputRef.current?.click()}
              showFileEntry={false}
              menuSide={isEmpty ? "bottom" : "top"}
            />
            <CapabilityHoverTip
              key="composer-upload"
              label={t("filesAndImages")}
              lines={hintLines(t("filesAndImagesHint"))}
            >
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t("filesAndImages")}
                className="h-8 w-8 rounded-full text-muted-foreground hover:bg-primary-soft hover:text-primary"
                onClick={() => fileInputRef.current?.click()}
              >
                <Paperclip className="h-4 w-4" />
              </Button>
            </CapabilityHoverTip>
            {deepResearchMode !== "off" || planChatGateActive ? (
              <>
              <span
                key="deep-research-chip"
                className="group/dr-chip inline-flex h-8 max-w-full items-center gap-1.5 rounded-full bg-primary-soft/70 px-2.5 text-xs font-medium text-primary"
                aria-label={`${tw("deepResearchChip")} · ${labelForDeepResearchInteractionPref(interactionPref)}`}
              >
                <button
                  type="button"
                  onClick={() => {
                    // 计划对齐等待中不允许关掉标签，否则后续输入会误开成普通对话。
                    if (planChatGateActive) return;
                    setDeepResearchMode("off");
                  }}
                  className="relative flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary transition-colors hover:bg-primary hover:text-primary-foreground"
                  aria-label={tw("exitDeepResearch")}
                  title={
                    planChatGateActive
                      ? "请先确认或继续修改研究计划"
                      : tw("exitDeepResearch")
                  }
                >
                  <Microscope className="h-3.5 w-3.5 group-hover/dr-chip:hidden" />
                  <X className="hidden h-3.5 w-3.5 group-hover/dr-chip:block" strokeWidth={2.5} />
                </button>
                <span className="shrink-0">{tw("deepResearchChip")}</span>
                <div ref={prefMenuRef} className="relative min-w-0">
                  <button
                    type="button"
                    onClick={() => setPrefMenuOpen((v) => !v)}
                    className="inline-flex h-5 max-w-[7.5rem] items-center gap-0.5 rounded-full bg-primary/12 px-1.5 text-[11px] font-medium text-primary transition-colors hover:bg-primary/20"
                    aria-label={`确认方式：${labelForDeepResearchInteractionPref(interactionPref)}`}
                    title={`澄清与计划确认方式：${labelForDeepResearchInteractionPref(interactionPref)}（点击切换）`}
                    data-testid="deep-research-pref-trigger"
                  >
                    <span className="truncate" data-testid="deep-research-pref-tag">
                      {labelForDeepResearchInteractionPref(interactionPref)}
                    </span>
                    <ChevronDown className="h-3 w-3 shrink-0 opacity-70" />
                  </button>
                  {prefMenuOpen ? (
                    <div
                      className="absolute left-0 top-7 z-50 w-64 rounded-xl border border-border bg-popover p-1.5 text-popover-foreground shadow-xl"
                      data-testid="deep-research-pref-menu"
                    >
                      <div className="px-2.5 pb-1.5 pt-1 text-[11px] font-medium text-muted-foreground">
                        澄清与计划确认方式
                      </div>
                      {DEEP_RESEARCH_INTERACTION_OPTIONS.map((opt) => (
                        <button
                          key={opt.id}
                          type="button"
                          onClick={() => {
                            setInteractionPref(opt.id);
                            setDeepResearchInteractionPref(opt.id);
                            setPrefMenuOpen(false);
                          }}
                          className={`flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left hover:bg-muted ${
                            interactionPref === opt.id ? "bg-muted" : ""
                          }`}
                        >
                          <span className="flex flex-col">
                            <span className="text-xs font-medium text-foreground">
                              {opt.label}
                            </span>
                            <span className="text-[11px] text-muted-foreground">{opt.hint}</span>
                          </span>
                          {interactionPref === opt.id ? (
                            <Check className="h-3.5 w-3.5 shrink-0 text-primary" />
                          ) : null}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              </span>
              <span className="max-w-[12rem] text-[10px] leading-tight text-amber-700/90 dark:text-amber-300/90">
                {tw("deepResearchTokenHint")}
              </span>
              </>
            ) : null}
          </>
        }
        rightToolbar={
          <div ref={modelMenuRef} className="relative">
            {modelMenuOpen ? (
              <div
                className="fixed z-[80] overflow-y-auto overscroll-contain rounded-2xl border border-border/70 bg-popover/95 p-1 shadow-2xl backdrop-blur"
                style={{
                  width: modelMenuPosition.width,
                  left: modelMenuPosition.left,
                  top: modelMenuPosition.top,
                  maxHeight: modelMenuPosition.maxHeight,
                  transform: "translateY(-100%)",
                }}
              >
                {availableModels.length === 0 ? (
                  <div className="px-3 py-3 text-xs leading-relaxed text-muted-foreground">
                    {modelMenuEmptyHint}
                  </div>
                ) : (
                  availableModels.map((opt) => {
                    const isSelected = opt.id === activeModel;
                    const icon = opt.route === "local"
                      ? <Cpu className="h-4 w-4" />
                      : opt.route === "private-cloud"
                        ? <Microscope className="h-4 w-4" />
                        : <Sparkles className="h-4 w-4" />;
                    return (
                      <button
                        key={opt.id}
                        type="button"
                        onClick={() => {
                          switchModel(opt.id);
                          setModelMenuOpen(false);
                        }}
                        className={`flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left transition-colors ${isSelected ? "bg-primary-soft/70" : "hover:bg-muted/70"}`}
                      >
                        <span className="flex h-5 w-5 shrink-0 items-center justify-center pt-0.5 text-primary">{icon}</span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-semibold leading-5 text-foreground">
                            {opt.label}
                          </span>
                          <span className="block truncate text-[11px] leading-4 text-muted-foreground mt-0.5">
                            {opt.providerLabel} · <span className="font-mono">{opt.model}</span>
                          </span>
                        </span>
                        {isSelected && <Check className="h-4 w-4 shrink-0 text-primary mt-0.5" />}
                      </button>
                    );
                  })
                )}
              </div>
            ) : null}
            <button
              ref={modelTriggerRef}
              type="button"
              onClick={() => setModelMenuOpen((prev) => !prev)}
              disabled={attachmentRoutingPickerLocked}
              title={
                attachmentRoutingPickerLocked
                  ? composerHasRoutedDocument && canChoosePublicAttachmentRoute
                    ? "发送时确认附件使用私有模型或公网模型"
                    : "本会话包含文档，已锁定到私有模型"
                  : "切换模型"
              }
              className="flex h-8 items-center gap-1.5 rounded-full px-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/80 hover:text-foreground disabled:cursor-not-allowed disabled:bg-primary-soft/50 disabled:text-primary"
            >
              {attachmentRoutingPickerLocked ? <LockKeyhole className="h-3.5 w-3.5" /> : null}
              <span>{modelTriggerLabel}</span>
              <ChevronDown className={`h-3.5 w-3.5 transition-transform ${modelMenuOpen ? "rotate-180" : ""}`} />
            </button>
          </div>
        }
      />
    </div>
  );

  return (
    <TooltipProvider delayDuration={200}>
      <div className="relative flex h-full min-h-0 flex-1 overflow-hidden">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {/* 顶部 - 对话标题 */}
        <div className="flex shrink-0 items-center justify-between px-6 py-4 pl-14 lg:pl-6">
          <div className="flex items-center gap-2">
            {isEditingTitle ? (
              <input
                ref={titleInputRef}
                type="text"
                value={sessionTitle}
                onChange={(e) => setSessionTitle(e.target.value)}
                onBlur={() => {
                  setIsEditingTitle(false);
                  if (activeSessionId) {
                    void renameSession(activeSessionId, sessionTitle.trim() || tw("newChat"));
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  if (e.key === "Escape") {
                    if (activeSession) setSessionTitle(activeSession.title);
                    setIsEditingTitle(false);
                  }
                }}
                className="rounded-md border border-border bg-background px-2 py-1 text-sm font-medium outline-none focus:border-ring"
                autoFocus
              />
            ) : (
              <button
                type="button"
                onClick={() => setIsEditingTitle(true)}
                className="group flex items-center gap-2 rounded-md px-2 py-1 hover:bg-muted"
              >
                <span className="text-base font-semibold tracking-tight">{sessionTitle}</span>
                <Pencil className="h-3.5 w-3.5 text-muted-foreground opacity-0 group-hover:opacity-100" />
              </button>
            )}
          </div>
          <div className="flex items-center gap-1">
            {activeSessionId ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 rounded-full text-muted-foreground hover:text-foreground"
                    aria-label={copiedSessionId ? tw("sessionIdCopied") : tw("copySessionId")}
                    title={copiedSessionId ? tw("sessionIdCopied") : tw("copySessionId")}
                    onClick={() => {
                      void navigator.clipboard.writeText(activeSessionId).then(
                        () => {
                          setCopiedSessionId(true);
                          window.setTimeout(() => setCopiedSessionId(false), 1600);
                        },
                        () => {},
                      );
                    }}
                  >
                    {copiedSessionId ? <Check className="h-3.5 w-3.5 text-success" /> : <Hash className="h-3.5 w-3.5" />}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  {copiedSessionId ? tw("sessionIdCopied") : tw("copySessionId")}
                </TooltipContent>
              </Tooltip>
            ) : null}
            <Badge variant="success" className="mr-2 gap-1 px-2.5 py-0.5 text-[11px] font-medium">
              <Activity className="h-3 w-3" />
              <span className="hidden sm:inline">{t("gatewayOnline")}</span>
              <span className="sm:hidden">{t("gatewayOnlineShort")}</span>
            </Badge>
            {!isEmpty && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 rounded-full text-muted-foreground hover:text-foreground"
                    aria-label={t("shareConversation")}
                    onClick={() => openShareDialog()}
                  >
                    <Share className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t("shareConversation")}</TooltipContent>
              </Tooltip>
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 rounded-full text-muted-foreground hover:text-foreground"
                  aria-label={t("deleteConversation")}
                  disabled={!activeSessionId}
                  onClick={deleteCurrentSession}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t("deleteConversation")}</TooltipContent>
            </Tooltip>
          </div>
        </div>

        {/* 主对话区 */}
        <div className="relative min-h-0 flex-1 overflow-hidden">
          {isEmpty ? (
            /* 空态：品牌字标靠上 + 收窄加高输入区（深度研究入口暂走侧栏） */
            <div className="relative flex h-full flex-col items-center justify-start gap-10 overflow-y-auto px-4 pt-14 pb-10 md:gap-12 md:pt-16 md:pb-16">
              {supportAssistant ? (
                <div className="relative flex w-full max-w-[46rem] justify-end">
                  {supportAssistant}
                </div>
              ) : null}
              <NearEmptyWordmark
                badgeLabel={t("beta")}
              />

              <div className="w-full max-w-[46rem]">{composer}</div>
            </div>
          ) : (
            <div className="relative h-full min-h-0">
              {sessionMessagesLoading && (
                <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/60 text-sm text-muted-foreground backdrop-blur-[1px]">
                  {t("loadingMessages")}
                </div>
              )}
              <div className="flex h-full min-h-0 flex-col">
                <div className="shrink-0 px-4 pt-2">
                  <DeepResearchRecoverBanner
                    sessionId={activeSessionId}
                    onRecover={handleDeepResearchRecover}
                    visibleRunIds={visibleDeepResearchRunIds}
                    suppressWhileStreaming={suppressRecoverWhileStreaming}
                  />
                </div>
                <MessageList
                  messages={visibleMessages}
                  topContent={supportAssistant}
                  className="min-h-0 flex-1"
                  styleVariant="im"
                  assistantFrameless
                  scrollToBottomLabel={t("scrollToBottom")}
                  webSearchGeneratingLabel={t("webSearchGenerating")}
                  responseVersionMetaByUserMessageId={responseVersionMetaByUserMessageId}
                  retryVersionMetaByUserMessageId={retryVersionMetaByUserMessageId}
                  onShowPreviousResponseVersion={showPreviousResponseVersion}
                  onShowNextResponseVersion={showNextResponseVersion}
                  onShowPreviousRetryVersion={showPreviousRetryVersion}
                  onShowNextRetryVersion={showNextRetryVersion}
                  onRequestDeepResearchFiles={requestDeepResearchFiles}
                  onRequestDeepResearchLaneSources={requestDeepResearchLaneSources}
                  onOpenExternalUrl={requestExternalLink}
                  onRequestAttachmentPreview={requestAttachmentPreview}
                  onCopy={(content) => {
                    console.log("Copied:", content);
                  }}
                  onRetry={(messageId) => {
                    void regenerateAssistantResponse(client, messageId, {
                      webSearch: webSearchMode === "auto",
                      deepResearch: deepResearchMode === "manual",
                      deepResearchAuto: deepResearchMode === "auto",
                    });
                  }}
                  onUserEditResend={(messageId, content) => {
                    if (!content.trim()) return;
                    void editUserMessageAndResend(client, {
                      messageId,
                      content,
                      webSearch: webSearchMode === "auto",
                      deepResearch: deepResearchMode === "manual",
                      deepResearchAuto: deepResearchMode === "auto",
                    });
                  }}
                  onShare={(messageId) => {
                    openShareDialog(messageId);
                  }}
                  feedbackByMessageId={feedbackByMessageId}
                  onFeedback={handleFeedback}
                />
              </div>
            </div>
          )}
        </div>

        {!isEmpty && (
          <div className="relative z-10 shrink-0 bg-gradient-to-t from-background via-background/95 to-transparent px-4 pb-6 pt-4 sm:px-6 sm:pb-8">
            {composer}
          </div>
        )}
      </div>
      <DeepResearchFilesPanel
        open={filesPanelSessionId != null}
        onOpenChange={(open) => {
          if (!open) {
            setFilesPanelSessionId(null);
            setFilesPanelFocusId(null);
            setFilesPanelLane(null);
          }
        }}
        sessionId={filesPanelSessionId}
        focusArtifactId={filesPanelFocusId}
        focusLane={filesPanelLane}
        sources={filesPanelSources}
        onOpenExternalUrl={requestExternalLink}
      />
      <AttachmentContentPanel
        open={attachmentPreview != null}
        onOpenChange={(open) => {
          if (!open) setAttachmentPreview(null);
        }}
        attachment={attachmentPreview}
      />
      <Dialog
        open={routingPromptTarget != null}
        onOpenChange={(open) => {
          if (!open) settleAttachmentRoutingChoice("cancel");
        }}
      >
        <DialogContent className="max-w-lg gap-5">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldAlert className="h-5 w-5 text-warning" />
              文档将发送到哪里？
            </DialogTitle>
            <DialogDescription className="leading-6">
              企业策略建议使用「{routingPromptTarget?.label ?? "私有模型"}」。继续使用当前公网模型会把文档内容发送到企业外部模型服务，并留下审计记录。
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            <button
              type="button"
              className="rounded-xl border border-primary/30 bg-primary-soft/70 p-4 text-left transition-colors hover:bg-primary-soft"
              onClick={() => settleAttachmentRoutingChoice("private")}
            >
              <LockKeyhole className="h-5 w-5 text-primary" />
              <span className="mt-3 block font-semibold">使用私有模型</span>
              <span className="mt-1 block text-xs leading-5 text-muted-foreground">切换并锁定本会话，文档留在私有环境。</span>
            </button>
            <button
              type="button"
              className="rounded-xl border border-warning/40 bg-warning-soft/50 p-4 text-left transition-colors hover:bg-warning-soft"
              onClick={() => settleAttachmentRoutingChoice("public")}
            >
              <ShieldAlert className="h-5 w-5 text-warning" />
              <span className="mt-3 block font-semibold">仍使用公网模型</span>
              <span className="mt-1 block text-xs leading-5 text-muted-foreground">按当前模型发送，并记录本次例外选择。</span>
            </button>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => settleAttachmentRoutingChoice("cancel")}>取消发送</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ShareDialog
        open={shareDialogOpen}
        onOpenChange={setShareDialogOpen}
        title={sessionTitle}
        messages={visibleMessages}
        initialSelectedIds={shareInitialSelectedIds}
        onCreateLink={createShareLink}
        onGenerateImage={generateShareImage}
      />
      </div>
    </TooltipProvider>
  );
}
