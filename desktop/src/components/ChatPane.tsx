import { Component, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  addressForSession,
  ATTACHMENT_ROUTING_OFF,
  decideAttachmentRouting,
  hasRoutedDocument,
  modelPickerLock,
  routingLockReason,
  type RoutingModelRef,
} from "../utils/attachment-routing";
import type { ErrorInfo, ReactNode, MouseEvent as ReactMouseEvent, CSSProperties, RefObject } from "react";
import {
  Bookmark,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Copy,
  Database,
  GripVertical,
  LayoutList,
  ListTree,
  Quote,
  Search,
  TextSearch,
  Forward,
  Sparkles,
  Radar,
  SquarePen,
  Plus,
  Wrench,
  Settings,
  UsersRound,
  X,
  PanelRight,
  ArrowRight,
  Loader2,
  LockKeyhole,
  PhoneCall,
  ShieldAlert,
} from "lucide-react";
import {
  useAppStore,
  EMPTY_SESSION_TOKENS,
  type Avatar,
  type ChatPane as ChatPaneState,
  type Message,
  type MessageAttachment,
  type PendingConfirm,
  type QueuedMessage,
  type SidePanelTab,
  type Taskspace,
} from "../store";
import { VOICE_UI_ENABLED } from "../constants/feature-flags";
import { LOCAL_KNOWLEDGE_ENABLED } from "../constants/desktop-feature-visibility";
import { useGraphRunStore } from "./graph/useGraphRun";
import {
  EMPTY_PANE_GRAPH_STATE,
  graphHasTaskNodes,
  type GraphSsePayload,
} from "./graph/graph-types";
import {
  appendDictationText,
  cancelDictation,
  startDictation,
  type SttPhase,
} from "../voice/stt";
import { useVoicePushToTalk } from "../hooks/useVoicePushToTalk";
import { VoicePttOverlay } from "./VoicePttOverlay";
import { AttachmentRoutingStatusBanner } from "./AttachmentRoutingStatusBanner";
import { SessionHistoryPanel } from "./SessionHistoryPanel";
import { AvatarSettingsPanel } from "./AvatarSettingsPanel";
import { MemoryGraphPanel } from "./memory/MemoryGraphPanel";
import { StickyTaskBar } from "./StickyTaskBar";
import { ContextUsageButton } from "./ContextUsagePopup";
import type { WorkspacePreviewOpenRequest, WorkspacePreviewQuotePayload } from "./workspace/workspace-preview-types";
import {
  NEAR_WORKSPACE_OPEN_PREVIEW,
  NEAR_WORKSPACE_PICK_DIR,
  NEAR_WORKSPACE_PICK_FILE,
  type NearWorkspaceOpenPreviewDetail,
  type NearWorkspacePickDirDetail,
  type NearWorkspacePickFileDetail,
} from "../utils/workspace-sidebar-events";
import { WorkPanel, type WorkPanelFocus } from "./work-panel/WorkPanel";
import { GroupMemberAvatar } from "./groups/GroupMemberAvatar";
import { GroupChatEmptyState } from "./groups/GroupChatEmptyState";
import { ExpertChatEmptyState } from "./gallery/ExpertChatEmptyState";
import { loadPreparedHtmlSrcDoc } from "../utils/html-preview-assets";
import { buildHtmlElementContextSnippet } from "../utils/html-preview-inspect";
import {
  artifactBaseName,
  collectTurnArtifactPaths,
  isInAppArtifactPreviewPath,
  isInAppHtmlPreviewPath,
  looksLikeDirectoryPath,
  pathToFileUrl,
  pickPrimaryTurnArtifact,
} from "../utils/session-artifacts";
import { SubAgentRunDrawer } from "./subagent";
import { MessageRenderer, renderToolMessageExtras } from "./messages/MessageRenderer";
import { TurnChangeCard } from "./messages/TurnChangeCard";
import type { SkillPatchPreviewPayload } from "./messages/skill-manage-preview";
import { extractPartialShowWidgetArgs } from "./messages/show-widget-partial";
import { groupConsecutiveToolMessages, shouldHoldToolGroupProgress, type GroupedChatRow } from "./messages/group-tool-messages";
import {
  applyGroupReactionEvent,
  groupMessageIdFromRecord,
  isPublicGroupMessage,
  toggleGroupReaction,
} from "../utils/group-message-state";
import { resolveProcessFoldRange } from "./messages/react-work-fold";
import {
  isEphemeralStopErrorText,
  isInterruptedAssistantPlaceholder,
} from "../utils/noisy-chat-messages";
import { isStreamToolLabelOnlyText, shouldSkipFormattedToolResultFallback } from "../utils/orphan-formatted-tool";
import { HOOK_BLOCK_RE } from "../utils/hook-block-message";
import {
  collectTurnLinkedIds,
  collectTurnLinkedIdsForBlock,
  countSelectedConversationTurns,
  expandMessagesToTopLevelRows,
  expandSelectionToCompleteTurns,
} from "./messages/react-blocks";
import { isSubAgentLiveStatus, shouldHideStreamOverlay, shouldShowMidTurnStreamActivity } from "../utils/stream-overlay-policy";
import {
  isGroupStreamMessageId,
  shouldResetGroupStreamOnProgress,
  visibleGroupStreamBody,
} from "../utils/group-stream-text";
import {
  formatGroupWorkforceHandoff,
  GROUP_COORDINATOR_AGENT_ID,
  groupCoordinatorActivityText,
  normalizeGroupGraphPayload,
  resolveGroupRunningResumeAction,
  resolveGroupWorkflowDetailEffect,
  shouldHandoffGroupCoordinator,
  withoutGroupAgent,
} from "../utils/group-live-state";
import {
  resolveGroupHostAvatarId,
  resolveGroupSenderRoleLabel,
} from "../utils/group-member-activity";
import { flushSubAgentLiveOutput } from "../utils/subagent-live-output";
import { resolveSubAgentOutputPaths } from "../utils/subagent-output-files";
import { TurnToolGroupCard } from "./messages/TurnToolGroupCard";
import { ReactWorkCollapse } from "./messages/ReactWorkCollapse";
import { StallWaitChip } from "./messages/StallWaitChip";
import { parseStallWaitPayload, type StallWaitInfo } from "../utils/stall-wait-chip";
import { WorkingIndicator } from "./messages/WorkingIndicator";
import { ImBubble } from "./messages/ImBubble";
import { AssistantFeedback } from "./messages/AssistantFeedback";
import { MessageTimestamp } from "./messages/MessageTimestamp";
import {
  ASSISTANT_ACTION_ICON_ROW_CLASS,
  ASSISTANT_ACTION_RHYTHM_END_CLASS,
  ASSISTANT_BODY_TAIL_CLASS,
  ASSISTANT_FOLLOWUP_CHIP_CLASS,
  ASSISTANT_FOLLOWUP_LIST_CLASS,
  getAssistantActionStyle,
} from "./messages/im-layout";
import { TerminalLine } from "./messages/TerminalLine";
import { ProviderIcon } from "./ProviderIcon";
import { CleanBlock } from "./messages/CleanBlock";
import { MessageQueuePanel } from "./messages/MessageQueuePanel";
import { StallRecoveryCard } from "./messages/StallRecoveryCard";
import { ForwardPicker, type ForwardConfirmPayload } from "./ForwardPicker";
import { resolveForwardTarget as resolveForwardTargetPayload } from "../utils/resolve-forward-target";
import { HoverTip } from "./ds/HoverTip";
import { ConnectorsMenuButton } from "./connectors/ConnectorsMenuButton";
import { SkillPuzzleIcon, skillPuzzleIconInnerHtml } from "./icons/SkillPuzzleIcon";
import { filterAndRankSkills } from "../utils/skill-search";
import {
  COMPOSER_INLINE_CHIP_CLASS,
  composerRefIconInnerHtml,
  resolveComposerRefIconKind,
} from "./icons/ComposerRefIcon";
import { composerQuoteIconInnerHtml, formatQuoteChipLabel } from "./icons/ComposerQuoteIcon";
import {
  composerQuotePlaceholder,
  matchComposerQuotePlaceholder,
  normalizeComposerQuotePlaceholdersToIndices,
  serializeQuotedContent,
  stripComposerQuotePlaceholders,
  type QuotePayloadItem,
} from "../utils/user-quote-display";
import {
  AT_MENTION_SEARCH_DEBOUNCE_MS,
  domTextLooksNonEmpty,
  isComposerNonEmpty,
  nextComposerAtMentionState,
  replaceAtMentionAtCaret,
} from "../utils/composer-input-sync";
import { Toast } from "./ds/Toast";
import { TopbarContextControls, TopbarGlobalActions } from "./Topbar";
import { ComposerContextControls } from "./ComposerContextControls";
import {
  normalizeRunMode,
  type RunMode,
} from "../constants/confirm-strategy-options";
import { AtMentionPicker } from "./AtMentionPicker";
import type { AtMentionBrowseState } from "./AtMentionPicker";
import type { AtMentionCandidate } from "../utils/at-mention-display";
import { parentBrowsePath } from "../utils/at-mention-display";
import {
  extractGroupMentionIds,
  groupAllMentionMatchesQuery,
  GROUP_MENTION_ALL_ID,
} from "../utils/group-mentions";
import { GROUP_META_MEMBER_ID, resolveGroupMember } from "../utils/group-meta-member";
import { extractClipboardImageFiles, withClipboardImageNames } from "../utils/clipboard-images";
import { clipboardPlainTextForPaste } from "../utils/clipboard-plain-text";
import { isKnownNonVisionChatModel } from "../utils/model-vision";
import { getVisionFallbackInfo, type VisionFallbackInfo } from "../utils/vision-fallback";
import {
  applySessionFindHighlights,
  clearSessionFindHighlights,
} from "../utils/session-find-highlight";
import { isVideoFile } from "../utils/video-file";
import {
  canStopCurrentRun,
  isDoubleEnterWithinWindow,
  isStreamRunActiveForQueue,
  resolveQueueSessionKey,
  shouldEnqueueOnResend,
  shouldInterruptOnResend,
  shouldShowSessionWorkInProgress,
  shouldShowStopButton,
  type SessionExecutionState,
} from "../utils/streaming-stop-policy";
import { queuedMessagesForSession } from "../utils/pending-message-queue";
import { shouldApplyScrollPinFromEvent, shouldPinScrollOnUserSend } from "../utils/chat-scroll-pin";
import {
  assertChatFeedbackOperationOk,
  beginChatFeedbackWrite,
  chatFeedbackValueForMessage,
  clearChatFeedbackStatus,
  completeChatFeedbackWrite,
  createChatFeedbackState,
  failChatFeedbackWrite,
  markChatFeedbackLearningError,
  nextChatFeedbackValue,
  parseChatFeedbackAuthGeneration,
  parseChatFeedbackMap,
  parseChatFeedbackScope,
  resolveChatFeedbackApi,
  type ChatFeedbackApi,
  type ChatFeedbackAction,
  type ChatFeedbackUiState,
  type ChatFeedbackValue,
} from "../utils/chat-feedback";
import { mirrorFeedbackLearning } from "../utils/feedback-learning";
import {
  desktopFeedbackAccountStampsEqual,
  normalizeDesktopFeedbackAccountStamp,
} from "../../shared/feedback-scope";
import {
  TURN_INTERRUPTED_TOAST,
  isTurnInterruptionNoticeMessage,
  shouldAutoResumeTruncationInterruption,
  shouldShowTurnInterruptedSyncToast,
} from "../utils/turn-interruption-notice";
import {
  CHANNEL_C_GRACE_MS,
  stallDetectSilenceMs,
  isFutileResume,
  lastTurnHasActiveToolActivity,
  lastTurnHasCompletedAssistantReply,
  lastTurnHasToolActivity,
  paneHasPendingHumanGate,
  resolveSessionHealth,
  resolveSilenceTier,
  resolveSilenceTierLabel,
  sessionMessagesHydrated,
  shouldApplyTeamControlDoneEvent,
  shouldAllowStallAutoNudge,
  isTeamControlStallSuppressed,
  shouldResetStallDetectorsOnSessionSwitch,
  shouldSuppressStallDetection,
  shouldTriggerIncompleteEndStall,
  STALL_MODEL_FALLBACKS,
} from "../utils/task-stall-policy";
import {
  budgetExceededInfoFromPayload,
  findBudgetExceededInMessages,
  type BudgetExceededInfo,
} from "../utils/budget-exceeded";
import { buildBudgetResumeDraft } from "../utils/budget-resume-draft";
import {
  getCachedGlobalKbRetrievalMode,
  getKbRetrievalModeForPane,
  migratePaneKbRetrievalModeToSession,
  resolveDisplayKbRetrievalMode,
  resolveEffectiveKbRetrievalMode,
  setCachedGlobalKbRetrievalMode,
  setKbRetrievalModeForPane,
  type KbRetrievalMode,
} from "../utils/kb-retrieval-mode";
import {
  continueSessionUrl,
  inferContinueReason,
  type ContinueReason,
  type ContinueSource,
} from "../utils/session-continue";
import { mergeSessionMessagesTail } from "../utils/session-message-merge";
import {
  FEEDBACK_MESSAGE_ID_METADATA_KEY,
  hasCanonicalFeedbackMessageId,
  feedbackMessageIdForMessage,
} from "../utils/feedback-message-id";
import {
  enqueueFeedbackWrite,
  feedbackWriteKey,
  feedbackWritePrefix,
} from "../utils/feedback-write-queue";
import {
  sessionTurnForAssistantMessage,
} from "../utils/session-turn-binding";
import {
  buildPendingToolFallback,
  buildDeferredToolResultResolution,
  drainPendingToolResults,
  hasMatchingToolCall,
  resolvePendingToolName,
  type PendingToolResult,
} from "../utils/pending-tool-result";
import { injectLiveSubAgentClusterAnchors } from "../utils/subagent-cluster-inline";
import {
  buildSubAgentFromRunRecord,
  hydrateSessionSubAgentsFromDisk,
} from "../utils/subagent-hydrate";
import { fetchRunActivityPage, fetchRunDetail } from "./subagent/run-drawer-api";
import type { SubAgentRunRecord } from "./subagent/badge-vm";
import {
  enrichDiskMessagesWithInMemoryReferences,
  referencesDifferBetweenTails,
} from "../utils/session-reference-reconcile";
import { resolveReferencesForAssistant } from "../utils/turn-reference-context";
import {
  advanceReattachSequence,
  reattachSessionStreamUrl,
  parseSseFrame,
} from "../utils/session-reattach";
import {
  attachmentsFromSessionRow,
  mapLoadedSessionMessage,
  type LoadedSessionMessage,
} from "../utils/session-message-map";
import {
  assistantVisibleBodyForUi,
  buildCommittedAssistantPatch,
  normalizeFinalAssistantPayload,
  reasoningDuplicatesVisibleBody,
} from "../utils/assistant-output";
import {
  buildContextFileKeyFromAttachment,
  canonicalizeUserReferenceMentions,
  findReferenceAttachmentMeta,
  isWorkspaceReferenceAttachment,
  parseLineRangeFromReferenceLabel,
} from "../utils/reference-attachment";
import { NEAR_ARTIFACT_TASKSPACES_SYNCED } from "../utils/workspace-sidebar-events";
import { isLikelyTextFile } from "../utils/text-attachment";
import { isViewImageInjectMessage } from "../utils/view-image-inject";
import { resolveSessionTailForSwitch, invalidateSessionTail } from "../utils/session-tail-cache";
import { visibleMessagesForSession } from "../utils/message-ownership";
import { maxContinuationRound } from "../utils/continuation-notice";
import {
  shouldDropDuplicateUserSend,
  shouldSuppressDuplicatePendingUserEcho,
  type SendDedupeEntry,
} from "../utils/send-dedupe";
import { resolveSendSessionId } from "../utils/send-lock";
import { StreamCommitRegistry } from "../utils/stream-commit-registry";
import { favoriteStorageMessageId } from "../utils/favorite-selection";
import { createResizeRafScheduler } from "../utils/resize-raf";
import { avatarTintBg } from "../utils/avatar-color";
import { formatModelDisplayParts, formatModelOptionLabel } from "../utils/model-display";
import { SettingsSwitch } from "./settings/SettingsSwitch";
import {
  DEFAULT_KIMI_REASONING_EFFORT,
  DEEPSEEK_REASONING_EFFORT_OPTIONS,
  describeModelForPicker,
  KIMI_REASONING_EFFORT_OPTIONS,
  labelForDeepSeekReasoningEffort,
  labelForKimiReasoningEffort,
  normalizeDeepSeekReasoningEffort,
  normalizeKimiReasoningEffort,
  supportsDeepSeekV4Thinking,
  supportsKimiK3ReasoningEffort,
  type DeepSeekReasoningEffort,
  type KimiReasoningEffort,
} from "../utils/model-hover-blurb";
import { getProviderDisplayName } from "../utils/provider-display";
import {
  collectSelectableModelOptions,
  coerceSelectableModel,
  groupManagedModelOptions,
  isModelSelectable,
  isProviderCredentialed,
  resolveDirectModelPickerProvider,
  sortModelOptionsByPrefix,
} from "../utils/model-options";
import { resolveManagedContextWindow } from "../utils/managed-context-window";
import { isAutomationPaneAvatarId } from "../utils/automation-pane";
import {
  shouldAutoApproveConfirm,
  type EndConfirmRunHandler,
  type OpenConfirmHandler,
} from "../utils/confirm-scope";
import { sessionCreateAvatarId } from "../utils/session-create-avatar";
import { NEW_TOPIC_INHERITS_CONTEXT, newTopicTriggerLabel } from "../utils/new-topic-label";
import {
  ccBridgeSendToolProgressLabel,
  parseCcBridgeModeFromPayload,
  type CcBridgeSessionModeHint,
} from "../utils/cc-bridge-ui";
import type { AutomationTask } from "./automation/types";
import { parseReasoningContent } from "./messages/reasoning-parser";
import {
  getCachedReasoningDuration,
  measureReasoningSeconds,
  setCachedReasoningDuration,
} from "./messages/reasoning-duration-cache";
import { messagePlainTextForClipboard } from "../utils/markdown-copy-format";
import { buildMessagesPdfHtml, expandSelectionForCompletePdfExport, messagesForShareExport } from "../utils/export-pdf-html";
import { ShareImagePreviewModal } from "./ShareImagePreviewModal";
import { buildCompactionEventNotice, noticeKindForRuntimeWarning } from "../utils/context-notice";
import {
  deferredToolSchemaAutoloadMetadata,
  isDeferredToolSchemaAutoload,
  projectRuntimeToolResult,
} from "../utils/runtime-tool-result";
import { usePaneSortableHandle } from "./pane-sortable-context";
import { FeishuBadge } from "./FeishuBadge";
import {
  SHOW_DESKTOP_EXTERNAL_IM,
  SHOW_DESKTOP_MULTI_PANE,
  SHOW_DESKTOP_RUN_GRAPH,
} from "../constants/desktop-feature-visibility";
import { APP_DISPLAY_NAME, APP_TAGLINE, META_AGENT_DISPLAY_NAME } from "../constants/branding";
import { DEFAULT_META_AVATAR_URL } from "../constants/meta-avatar";
import { resolveMetaDisplayName } from "../utils/display-name";
import {
  messageForGroupRenderer,
  resolveGroupChatSender,
} from "../utils/group-chat-sender";
import { createKbApi } from "./settings/knowledge/api";
import {
  clearPaneAwaitingFreshSession,
  clearPaneLazyInheritParent,
  clearPanePendingSessionMode,
  isPaneAwaitingFreshSession,
  markPaneAwaitingFreshSession,
  peekPaneLazyInheritParent,
  peekPanePendingSessionMode,
  setPaneLazyInheritParent,
  setPanePendingSessionMode,
  takePaneNewTopicRequest,
  type PaneSessionMode,
} from "../utils/pane-fresh-session";
import { getRememberedSessionForAvatar } from "../utils/avatar-last-session";
import { readScopedLocalStorage, writeScopedLocalStorage } from "../utils/backend-scope";
import {
  COMPOSER_DRAFT_SAVE_DEBOUNCE_MS,
  composerDraftIdentity,
  deleteComposerDraft,
  loadComposerDraft,
  migrateComposerDraft,
  saveComposerDraft,
  type ComposerDraft,
  type ComposerDraftAttachment,
  type ComposerDraftRefMeta,
} from "../utils/composer-draft-storage";
import {
  GLOBAL_SEARCH_REFERENCE_FILE,
  GLOBAL_SEARCH_WORKSPACE_ADDED,
  type GlobalSearchReferenceFileDetail,
} from "./global-search/global-search-events";
import {
  buildFileMentionAppend,
  buildComposerRefPathLookup,
  fileNameFromPath,
  formatReferenceChipLabel,
  formatReferencePathHint,
  lookupComposerRefPath,
  resolveReferenceSourcePath,
} from "../utils/chat-file-mention";
import { absoluteTaskspacePath } from "../utils/workspace-file-path";
import { formatTaskspaceAddError } from "../utils/taskspace-errors";
import {
  bootstrapMarkerForSessionBinding,
  ensureWorkspaceSessionBeforeFirstMessage,
  shouldKeepNewTopicWorkspaceControls,
} from "../utils/workspace-session-visibility";
import {
  composerAcceptsDragTypes,
  decodeNearWorkspaceDragEntry,
  NEAR_WORKSPACE_DRAG_MIME,
  type NearWorkspaceDragEntry,
} from "../utils/workspace-drag";
import {
  accumulateReferenceTurn,
  applyFinalReferencePayload,
  referenceExtrasFromTurn,
} from "../utils/search-reference-sse";
import { mergeSearchedQueries } from "../types/search-references";
import type { SearchReference } from "../types/search-references";
import {
  canOfferSessionTurnUndo,
  fetchSessionTurns,
  isDocumentOnlyTurn,
  SessionTurnConflictError,
  undoSessionTurn,
  type SessionTurn,
  visibleSessionTurnDeliverablePaths,
} from "../utils/session-turns";
import {
  buildClarificationMessageExtras,
  findRunningActionConfirmationToolMessage,
  findRunningClarificationToolMessage,
} from "../utils/clarification-inline";
import { parseClarificationDecisions } from "../utils/clarification-notice";
import {
  buildActionConfirmationAnswer,
  findResolvableActionConfirmation,
  matchActionConfirmationReply,
  parseActionConfirmationContext,
  type ActionConfirmationDecision,
  type PendingActionConfirmation,
} from "../utils/action-confirmation";

const SEARCH_REFERENCE_TOOLS = new Set(["web_search", "knowledge_search"]);

const SESSION_UNATTENDED_STORAGE_KEY = "agx-session-unattended-v1";

/** Shown in the user bubble and sent as user_input when sending attachments without typed text (API min_length=1). */
const ATTACHMENT_ONLY_USER_PROMPT = "（见附件，请结合附件回答。）";
const VISION_UNSUPPORTED_TOAST = "模型不支持该文件类型";

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

const GROUP_PRIVATE_SCOPE_VALUES = new Set(["panel", "private", "direct", "dm", "one_to_one"]);
function isExplicitlyPrivateGroupMessage(message: Pick<Message, "metadata">): boolean {
  const metadata = message.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return false;
  const falseFlag = (value: unknown) => value === false || String(value ?? "").trim().toLowerCase() === "false";
  if (falseFlag(metadata.is_public) || falseFlag(metadata.public) || metadata.is_private === true || metadata.private === true || metadata.skipped === true) {
    return true;
  }
  for (const key of ["feed_visibility", "visibility", "scope", "conversation_scope", "chat_scope"]) {
    if (GROUP_PRIVATE_SCOPE_VALUES.has(String(metadata[key] ?? "").trim().toLowerCase())) return true;
  }
  const publicationSource = String(metadata.publication_source ?? metadata.group_publication_source ?? "").trim().toLowerCase();
  return publicationSource === "workflow_private";
}

export type GroupInterruptedPartial = {
  agentId: string;
  content: string;
  avatarName: string;
  avatarUrl?: string;
};

export type GroupInterruptedHistoryMessage = {
  role: "assistant" | "tool";
  content: string;
  agent_id: string;
  metadata: Record<string, unknown>;
  avatar_name?: string;
  avatar_url?: string;
};

export type GroupInterruptionTrigger = "stop" | "barge-in";

/** Metadata shared by every locally retained assistant interruption row. */
export function buildInterruptedAssistantMetadata(
  source: "interrupted-partial" | "barge-in" | "desktop_group_interrupt" = "interrupted-partial",
): Record<string, unknown> {
  return {
    source,
    partial: true,
    interrupted: true,
    turn_terminal: false,
    terminal_reason: "interrupted",
  };
}

/**
 * Claim only visible group-member output. Reasoning and protocol sentinels are
 * transient UI state and must never be persisted as a user-facing partial.
 */
export function collectGroupInterruptedPartials(
  streamByAgent: Readonly<Record<string, string>>,
  members: ReadonlyArray<Pick<Avatar, "id" | "name" | "avatarUrl">>,
): GroupInterruptedPartial[] {
  const memberById = new Map(members.map((member) => [member.id, member]));
  return Object.entries(streamByAgent)
    .map(([agentId, raw]) => {
      const content = visibleGroupStreamBody(String(raw ?? "")).trim();
      if (!content) return null;
      const member = memberById.get(agentId);
      const avatarName = String(member?.name ?? agentId).trim() || agentId;
      const avatarUrl = String(member?.avatarUrl ?? "").trim();
      return {
        agentId,
        content,
        avatarName,
        ...(avatarUrl ? { avatarUrl } : {}),
      } satisfies GroupInterruptedPartial;
    })
    .filter((partial): partial is GroupInterruptedPartial => partial !== null);
}

/**
 * Build the durable local-history rows for an interrupted group turn.  These
 * rows deliberately have no public-feed id/flag: they remain visible in the
 * desktop transcript but can never be mistaken for a completed room message.
 */
export function buildGroupInterruptedHistoryMessages(
  partials: readonly GroupInterruptedPartial[],
  trigger: GroupInterruptionTrigger,
): GroupInterruptedHistoryMessage[] {
  const triggerLabel = trigger === "barge-in" ? "抢发" : "手动中断";
  const partialRows = partials.map((partial) => ({
    role: "assistant" as const,
    content: partial.content,
    agent_id: partial.agentId,
    ...(partial.avatarName ? { avatar_name: partial.avatarName } : {}),
    ...(partial.avatarUrl ? { avatar_url: partial.avatarUrl } : {}),
    metadata: {
      kind: "group_interrupted_partial",
      ...buildInterruptedAssistantMetadata("desktop_group_interrupt"),
      interruption_trigger: trigger,
    },
  }));
  const noticeContent = partials.length > 0
    ? `本轮群聊已${triggerLabel}，已保留成员已生成的部分内容；可点击“恢复执行”继续。`
    : `本轮群聊已${triggerLabel}，可点击“恢复执行”继续。`;
  return [
    ...partialRows,
    {
      role: "tool",
      content: noticeContent,
      agent_id: GROUP_META_MEMBER_ID,
      metadata: {
        kind: "turn_interrupted",
        cause: "user_interrupt",
        source: "desktop_group_interrupt",
        group_interrupted: true,
        partial_count: partials.length,
        interruption_trigger: trigger,
      },
    },
  ];
}

function resolveQuoteBody(message: Message, selectedText?: string): string {
  const sel = selectedText?.trim() ?? "";
  if (sel.length > 0) return sel;
  if (message.role === "assistant") {
    const parsed = parseReasoningContent(message.content);
    if (parsed.hasReasoningTag) {
      const resp = (parsed.response ?? "").trim();
      if (resp.length > 0) return resp;
    }
  }
  return message.content;
}

function resolveForwardSender(message: Message, userLabel = "我"): string {
  if (message.role !== "assistant") return userLabel.trim() || "我";
  const raw = String(message.avatarName || message.agentId || "AI").trim();
  if (!raw) return "AI";
  return resolveMetaDisplayName(raw.toLowerCase() === "meta" ? null : raw);
}

type ForwardPendingAttachment = {
  id?: string;
  name: string;
  mime_type: string;
  size: number;
  data_url?: string;
  source_path?: string;
};

type ForwardPendingMessage = {
  sender: string;
  role: string;
  content: string;
  avatar_url?: string;
  timestamp?: number;
  attachments?: ForwardPendingAttachment[];
};

function attachmentsForForwardPayload(message: Message): ForwardPendingAttachment[] | undefined {
  const atts = message.attachments;
  if (!Array.isArray(atts) || atts.length === 0) return undefined;
  const out: ForwardPendingAttachment[] = [];
  for (const att of atts) {
    const name = String(att.name || "").trim() || "file";
    const mime = String(att.mimeType || "").trim() || "application/octet-stream";
    const size = Number.isFinite(att.size) ? Number(att.size) : 0;
    const dataUrl = String(att.dataUrl || "").trim();
    const sourcePath = String(att.sourcePath || "").trim();
    if (!dataUrl && !sourcePath && name === "file") continue;
    out.push({
      ...(String(att.id || "").trim() ? { id: String(att.id).trim() } : {}),
      name,
      mime_type: mime,
      size: Math.max(0, size),
      ...(dataUrl ? { data_url: dataUrl } : {}),
      ...(sourcePath ? { source_path: sourcePath } : {}),
    });
  }
  return out.length > 0 ? out : undefined;
}

function buildForwardPendingMessage(
  message: Message,
  userLabel: string,
  selectedText?: string
): ForwardPendingMessage {
  const attachments = attachmentsForForwardPayload(message);
  let content = resolveQuoteBody(message, selectedText).trim();
  if (!content && attachments?.length) {
    content = `（见附件：${attachments.map((a) => a.name).slice(0, 3).join("、")}）`;
  }
  return {
    sender: resolveForwardSender(message, userLabel),
    role: message.role,
    content,
    avatar_url: message.avatarUrl,
    timestamp: message.timestamp,
    ...(attachments ? { attachments } : {}),
  };
}

function shellSingleQuote(input: string): string {
  return `'${input.replace(/'/g, `'\"'\"'`)}'`;
}

/** Accept only a log path explicitly returned by the Studio config API. */
export function ccBridgeLogPathFromConfig(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  if (record.ok !== true) return null;
  const path = typeof record.log_path === "string" ? record.log_path.trim() : "";
  return path || null;
}

/** Build a portable, shell-safe command for following one bridge log. */
export function buildCcBridgeTailCommand(logPath: string): string {
  const resolved = logPath.trim();
  if (!resolved) throw new Error("CC bridge log path is unavailable");
  const quotedPath = shellSingleQuote(resolved);
  return [
    `LOG_FILE=${quotedPath}`,
    `echo "[claude-code] tailing $LOG_FILE"`,
    'if [ ! -f "$LOG_FILE" ]; then echo "[claude-code] waiting for log file..."; fi',
    'while [ ! -f "$LOG_FILE" ]; do sleep 0.5; done',
    'echo "[claude-code] log file detected."',
    'tail -n 200 -f "$LOG_FILE"',
  ].join("; ");
}

const EMPTY_QUEUE: QueuedMessage[] = [];
const EMPTY_TASKSPACES: Taskspace[] = [];
const KB_RETRIEVAL_MODE_OPTIONS: {
  value: "auto" | "always";
  label: string;
  hint: string;
}[] = [
  { value: "auto", label: "智能检索", hint: "由模型判断何时查知识库" },
  { value: "always", label: "始终检索", hint: "回答前优先检索知识库" },
];

/** 多分窗下仅看窗口宽度不可靠：按单窗格可视宽度切换到「侧栏抽屉」模式（对齐左侧主导航 overlay，不并排挤压会话区）。 */
const CHATPANE_SIDE_OVERLAY_BREAK = 760;

/** 程序化展开工作区：窄窗格时与其它侧栏互斥，避免并排挤压。 */
function openWorkspaceSidebarForPane(
  paneId: string,
  paneOuterWidthPx: number,
  openSidePanel: (paneId: string, tab: SidePanelTab) => void,
) {
  const compact =
    paneOuterWidthPx > 0 && paneOuterWidthPx < CHATPANE_SIDE_OVERLAY_BREAK;
  if (!compact) {
    openSidePanel(paneId, "workspace");
    return;
  }
  useAppStore.setState((s) => ({
    panes: s.panes.map((row) =>
      row.id !== paneId
        ? row
        : {
            ...row,
            taskspacePanelOpen: true,
            sidePanelTab: "workspace",
            historyOpen: false,
            memoryGraphOpen: false,
            membersPanelOpen: false,
            graphPanelOpen: false,
            spawnsColumnOpen: false,
          },
    ),
  }));
}

const FALLBACK_PANE: ChatPaneState = {
  id: "fallback-pane",
  avatarId: null,
  avatarName: META_AGENT_DISPLAY_NAME,
  sessionId: "",
  modelProvider: "",
  modelName: "",
  messages: [],
  historyOpen: false,
  memoryGraphOpen: false,
  contextInherited: false,
  taskspacePanelOpen: false,
  membersPanelOpen: false,
  graphPanelOpen: false,
  activeGraphRunId: null,
  sidePanelTab: "workspace",
  activeTaskspaceId: null,
  spawnsColumnOpen: false,
  spawnsColumnSuppressAuto: false,
  spawnsColumnBaselineIds: [],
  terminalTabs: [],
  activeTerminalTabId: null,
  sessionTokens: { ...EMPTY_SESSION_TOKENS },
  historySearchTerms: [],
  historyJumpMessageId: null,
  loadingMessages: false,
  oldestLoadedIndex: 0,
  hasOlderMessages: false,
  loadingOlderMessages: false,
  runDrawerOpen: false,
  runDrawerRunId: null,
};

/** 输入区能力菜单的浮层宽度。 */
const KB_MODE_SUBMENU_WIDTH = 200;

/** 将「更多操作」的二级菜单与一级菜单同顶并排，空间不足时翻到左侧。 */
function positionEmbeddedComposerFlyout(
  triggerEl: HTMLElement,
  flyoutWidth: number,
  preferredMaxHeight?: number,
): { top: number; left: number; maxHeight: number } {
  const parent = triggerEl.closest(".agx-menu-pop");
  const band = (parent ?? triggerEl).getBoundingClientRect();
  const gap = 8;
  let left = band.right + gap;
  if (left + flyoutWidth > window.innerWidth - gap) {
    left = band.left - flyoutWidth - gap;
  }
  left = Math.max(gap, Math.min(left, window.innerWidth - flyoutWidth - gap));
  const viewportMaxHeight = Math.max(120, window.innerHeight - gap * 2);
  const maxHeight = Math.min(
    Math.max(120, preferredMaxHeight ?? band.height),
    viewportMaxHeight,
  );
  return {
    top: Math.max(gap, Math.min(band.top, window.innerHeight - maxHeight - gap)),
    left,
    maxHeight,
  };
}

/** 顶栏单一主操作：始终在当前元智能体、数字专家或群聊下开启全新上下文。 */
function NewTopicButton({
  onNewTopic,
  triggerLabel,
}: {
  onNewTopic: (inherit: boolean, sessionMode?: PaneSessionMode) => void;
  triggerLabel: string;
}) {
  return (
    <HoverTip label={triggerLabel}>
      <button
        type="button"
        className="agx-topbar-btn !px-[5px]"
        aria-label={triggerLabel}
        onClick={() => onNewTopic(NEW_TOPIC_INHERITS_CONTEXT, "daily_office")}
      >
        <SquarePen className="h-[18px] w-[18px]" strokeWidth={1.8} aria-hidden />
      </button>
    </HoverTip>
  );
}

/** 「更多操作」只承载当前消息的附件与能力，不混入会话级的新对话操作。 */
function ComposerMoreActionsButton({
  onPickFile,
  renderSkillPicker,
  renderKbRetrieval,
  renderConnectors,
}: {
  onPickFile: () => void;
  renderSkillPicker: () => ReactNode;
  renderKbRetrieval?: () => ReactNode;
  renderConnectors: () => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [panelPos, setPanelPos] = useState<{ bottom: number; left: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const syncPosition = useCallback(() => {
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPanelPos({ bottom: window.innerHeight - rect.top + 6, left: rect.left });
  }, []);

  const toggleOpen = useCallback(() => {
    setOpen((prev) => {
      const next = !prev;
      if (next) syncPosition();
      return next;
    });
  }, [syncPosition]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (rootRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      for (const id of [
        "agx-skill-picker-dropdown",
        "agx-kb-retrieval-mode-menu",
        "agx-connectors-menu-dropdown",
      ]) {
        if (document.getElementById(id)?.contains(target)) return;
      }
      setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    window.addEventListener("resize", syncPosition);
    window.addEventListener("scroll", syncPosition, true);
    return () => {
      window.removeEventListener("resize", syncPosition);
      window.removeEventListener("scroll", syncPosition, true);
    };
  }, [open, syncPosition]);

  const panel = open && panelPos
    ? createPortal(
        <div
          ref={panelRef}
          style={{ bottom: panelPos.bottom, left: panelPos.left, transformOrigin: "bottom left" }}
          className="agx-menu-pop fixed z-[9999] flex w-56 flex-col gap-0.5 rounded-xl border border-border bg-surface-panel p-1.5 shadow-xl backdrop-blur-xl"
          role="menu"
          aria-label="更多操作"
        >
          <button
            type="button"
            role="menuitem"
            className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] text-text-standard transition-colors hover:bg-surface-hover"
            onClick={() => {
              onPickFile();
              setOpen(false);
            }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="h-[15px] w-[15px] shrink-0 text-text-muted">
              <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
            </svg>
            <span className="flex-1">添加文件</span>
          </button>
          {renderSkillPicker()}
          {renderKbRetrieval?.()}
          {renderConnectors()}
        </div>,
        document.body,
      )
    : null;

  return (
    <>
      <div ref={rootRef} className="flex shrink-0 items-center">
        <button
          type="button"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-text-strong transition hover:bg-surface-hover"
          aria-label="更多操作"
          aria-expanded={open}
          onClick={toggleOpen}
        >
          <Plus className={`h-[17px] w-[17px] transition-transform ${open ? "rotate-45" : ""}`} strokeWidth={1.85} aria-hidden />
        </button>
      </div>
      {panel}
    </>
  );
}

interface SkillItem {
  name: string;
  description: string;
  icon?: string;
  source?: string;
  globally_disabled?: boolean;
}

interface SkillPickerButtonProps {
  apiBase: string;
  apiToken: string;
  onSelect: (skill: SkillItem) => void;
  /** Render as a full-width row inside「更多操作」and open a side flyout. */
  embedded?: boolean;
}

const SKILL_DROPDOWN_WIDTH = 288; // w-72
const SKILL_DROPDOWN_MAX_HEIGHT = 360;

function SkillPickerButton({ apiBase, apiToken, onSelect, embedded = false }: SkillPickerButtonProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [skills, setSkills] = useState<SkillItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [dropdownPos, setDropdownPos] = useState<
    { left: number; top?: number; bottom?: number; maxHeight?: number } | null
  >(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const iconBtn =
    "flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-text-muted transition hover:bg-surface-hover hover:text-text-strong";

  const fetchSkills = useCallback(async () => {
    if (!apiBase) return;
    setLoading(true);
    try {
      const resp = await fetch(`${apiBase}/api/skills`, {
        headers: { "x-agx-desktop-token": apiToken },
      });
      if (resp.ok) {
        const data = (await resp.json()) as { items?: SkillItem[] };
        const items: SkillItem[] = (data.items ?? []).filter((s) => !s.globally_disabled);
        setSkills(items);
      }
    } catch {
      // silently fail
    } finally {
      setLoading(false);
    }
  }, [apiBase, apiToken]);

  useEffect(() => {
    const off = window.agenticxDesktop.onSkillsChanged(() => {
      void fetchSkills();
    });
    return () => off();
  }, [fetchSkills]);

  const handleOpen = () => {
    if (btnRef.current) {
      if (embedded) {
        setDropdownPos(
          positionEmbeddedComposerFlyout(
            btnRef.current,
            SKILL_DROPDOWN_WIDTH,
            SKILL_DROPDOWN_MAX_HEIGHT,
          ),
        );
      } else {
        const rect = btnRef.current.getBoundingClientRect();
        const left = Math.max(8, Math.min(rect.right + 8, window.innerWidth - SKILL_DROPDOWN_WIDTH - 8));
        setDropdownPos({ bottom: window.innerHeight - rect.top + 6, left });
      }
    }
    setOpen(true);
    setQuery("");
    void fetchSkills();
    setTimeout(() => searchRef.current?.focus(), 60);
  };

  const handleClose = () => {
    setOpen(false);
    setQuery("");
  };

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      const btn = btnRef.current;
      const dropdown = document.getElementById("agx-skill-picker-dropdown");
      if (btn && btn.contains(target)) return;
      if (dropdown && dropdown.contains(target)) return;
      handleClose();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const filtered = filterAndRankSkills(skills, query);

  const dropdown =
    open && dropdownPos
      ? createPortal(
          <div
            id="agx-skill-picker-dropdown"
            style={{
              left: dropdownPos.left,
              width: SKILL_DROPDOWN_WIDTH,
              ...(dropdownPos.top != null
                ? { top: dropdownPos.top, maxHeight: dropdownPos.maxHeight }
                : { bottom: dropdownPos.bottom }),
            }}
            className="fixed z-[9999] flex w-72 flex-col overflow-hidden rounded-xl border border-border bg-surface-panel shadow-xl backdrop-blur-md"
          >
            <div className="shrink-0 border-b border-border p-2">
              <input
                ref={searchRef}
                type="text"
                className="w-full rounded-lg border border-border bg-surface-card px-2.5 py-1.5 text-[12px] text-text-strong outline-none placeholder:text-text-faint focus:border-[rgba(var(--theme-color-rgb,59,130,246),0.55)]"
                placeholder="搜索技能…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") handleClose();
                }}
              />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-1">
              {loading && skills.length === 0 ? (
                <div className="px-3 py-4 text-center text-[11px] text-text-faint">加载中…</div>
              ) : filtered.length === 0 ? (
                <div className="px-3 py-4 text-center text-[11px] text-text-faint">
                  {query ? `未找到"${query}"相关技能` : "暂无可用技能"}
                </div>
              ) : (
                filtered.map((skill) => (
                  <button
                    key={skill.name}
                    type="button"
                    className="flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left transition hover:bg-surface-hover"
                    onClick={() => {
                      onSelect(skill);
                      handleClose();
                    }}
                  >
                    <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-[rgba(var(--theme-color-rgb,59,130,246),0.22)] text-[rgb(var(--theme-color-fg-rgb,59,130,246))]">
                      <SkillPuzzleIcon className="h-3 w-3" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[12px] font-medium leading-tight text-text-strong">
                        {skill.name}
                      </div>
                      {skill.description ? (
                        <div className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-text-faint">
                          {skill.description}
                        </div>
                      ) : null}
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>,
          document.body
        )
      : null;

  if (embedded) {
    return (
      <>
        <button
          ref={btnRef}
          type="button"
          role="menuitem"
          className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] text-text-standard transition-colors hover:bg-surface-hover"
          aria-label="技能"
          aria-expanded={open}
          onClick={open ? handleClose : handleOpen}
        >
          <SkillPuzzleIcon className="h-[15px] w-[15px] shrink-0 text-text-muted" />
          <span className="flex-1">技能</span>
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-text-faint" aria-hidden />
        </button>
        {dropdown}
      </>
    );
  }

  return (
    <>
      <HoverTip label="引用技能 · 注入 Skill 上下文">
        <button
          ref={btnRef}
          type="button"
          className={iconBtn}
          aria-label="引用技能"
          onClick={open ? handleClose : handleOpen}
        >
          <SkillPuzzleIcon className="h-[15px] w-[15px]" />
        </button>
      </HoverTip>
      {dropdown}
    </>
  );
}

class HistoryPanelBoundary extends Component<
  { children: ReactNode },
  { hasError: boolean; retryCount: number }
> {
  state = { hasError: false, retryCount: 0 };
  private _retryTimer: ReturnType<typeof setTimeout> | null = null;

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.warn("[HistoryPanelBoundary]", error.message, info.componentStack?.slice(0, 200));
    if (this.state.retryCount < 2) {
      this._retryTimer = setTimeout(() => {
        this.setState((prev) => ({ hasError: false, retryCount: prev.retryCount + 1 }));
      }, 300);
    }
  }

  componentWillUnmount() {
    if (this._retryTimer) clearTimeout(this._retryTimer);
  }

  render() {
    if (this.state.hasError) {
      if (this.state.retryCount < 2) return null;
      return (
        <div className="h-full w-[220px] shrink-0 border-l border-border bg-surface-card flex items-center justify-center">
          <button
            className="rounded px-3 py-2 text-xs text-text-subtle hover:bg-surface-hover hover:text-text-strong"
            onClick={() => this.setState({ hasError: false, retryCount: 0 })}
          >
            历史面板出错，点击重试
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

/** Viewport-safe fixed positioning for pane bottom model pill dropdown (portal). */
const PANE_MODEL_PICKER_MARGIN = 8;
const PANE_MODEL_PICKER_GAP = 4;
const PANE_MODEL_PICKER_MIN_MAX_HEIGHT = 64;
const PANE_MODEL_PICKER_MAX_HEIGHT = 360;
const PANE_MODEL_PICKER_PANEL_WIDTH = 360;

function paneModelPickerPanelStyle(anchor: DOMRect): CSSProperties {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const panelWidth = Math.min(PANE_MODEL_PICKER_PANEL_WIDTH, vw - PANE_MODEL_PICKER_MARGIN * 2);

  let left = anchor.left;
  if (left + panelWidth > vw - PANE_MODEL_PICKER_MARGIN) {
    left = vw - PANE_MODEL_PICKER_MARGIN - panelWidth;
  }
  if (left < PANE_MODEL_PICKER_MARGIN) {
    left = PANE_MODEL_PICKER_MARGIN;
  }

  const spaceAbove = anchor.top - PANE_MODEL_PICKER_MARGIN - PANE_MODEL_PICKER_GAP;
  const spaceBelow = vh - anchor.bottom - PANE_MODEL_PICKER_MARGIN - PANE_MODEL_PICKER_GAP;
  const preferAbove = spaceAbove >= 120 || spaceAbove >= spaceBelow;

  if (preferAbove) {
    const maxHeight = Math.min(
      PANE_MODEL_PICKER_MAX_HEIGHT,
      Math.max(PANE_MODEL_PICKER_MIN_MAX_HEIGHT, Math.floor(spaceAbove)),
    );
    return {
      left,
      width: panelWidth,
      maxHeight,
      bottom: vh - anchor.top + PANE_MODEL_PICKER_GAP,
      top: "auto",
      right: "auto",
    };
  }

  const maxHeight = Math.min(
    PANE_MODEL_PICKER_MAX_HEIGHT,
    Math.max(PANE_MODEL_PICKER_MIN_MAX_HEIGHT, Math.floor(spaceBelow)),
  );
  return {
    left,
    width: panelWidth,
    maxHeight,
    top: anchor.bottom + PANE_MODEL_PICKER_GAP,
    bottom: "auto",
    right: "auto",
  };
}

/** Viewport-safe fixed positioning for the 历史对话 anchored popover (workbuddy-style, not a persistent side column). */
const HISTORY_POPOVER_MARGIN = 8;
const HISTORY_POPOVER_GAP = 6;
const HISTORY_POPOVER_WIDTH = 360;
const HISTORY_POPOVER_MIN_MAX_HEIGHT = 240;
const HISTORY_POPOVER_MAX_HEIGHT_CAP = 560;

function historyPanelPopoverStyle(anchor: DOMRect): CSSProperties {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const panelWidth = Math.min(HISTORY_POPOVER_WIDTH, vw - HISTORY_POPOVER_MARGIN * 2);

  // History button sits at the top-right of the pane toolbar; align the popover's
  // right edge with the button's right edge so it opens toward the pane, not off-screen.
  let left = anchor.right - panelWidth;
  if (left + panelWidth > vw - HISTORY_POPOVER_MARGIN) {
    left = vw - HISTORY_POPOVER_MARGIN - panelWidth;
  }
  if (left < HISTORY_POPOVER_MARGIN) {
    left = HISTORY_POPOVER_MARGIN;
  }

  const spaceAbove = anchor.top - HISTORY_POPOVER_MARGIN - HISTORY_POPOVER_GAP;
  const spaceBelow = vh - anchor.bottom - HISTORY_POPOVER_MARGIN - HISTORY_POPOVER_GAP;
  const preferAbove = spaceAbove >= HISTORY_POPOVER_MIN_MAX_HEIGHT && spaceAbove > spaceBelow;

  // 用 maxHeight（而非确定 height）让浮层按内容自然撑高、内容较少时不留空白；容器本身是
  // flex 列（display:flex + flexDirection:column），标题/搜索区 shrink-0 固定不动，
  // 只有内部会话列表区（flex-1 min-h-0 overflow-y-auto）随内容超限时滚动——flex 的
  // 弹性分配机制在"容器高度来自 max-height clamp"时依然是确定值，不依赖百分比高度解析，
  // 因此不会出现"限高但滚动条不出现"的问题。
  if (preferAbove) {
    const maxHeight = Math.min(
      HISTORY_POPOVER_MAX_HEIGHT_CAP,
      Math.max(HISTORY_POPOVER_MIN_MAX_HEIGHT, Math.floor(spaceAbove))
    );
    return {
      left,
      width: panelWidth,
      maxHeight,
      display: "flex",
      flexDirection: "column",
      bottom: vh - anchor.top + HISTORY_POPOVER_GAP,
      top: "auto",
      right: "auto",
    };
  }

  const maxHeight = Math.min(
    HISTORY_POPOVER_MAX_HEIGHT_CAP,
    Math.max(HISTORY_POPOVER_MIN_MAX_HEIGHT, Math.floor(spaceBelow))
  );
  return {
    left,
    width: panelWidth,
    maxHeight,
    display: "flex",
    flexDirection: "column",
    top: anchor.bottom + HISTORY_POPOVER_GAP,
    bottom: "auto",
    right: "auto",
  };
}

/** Monochrome provider mark: shape carries identity while color follows the active theme. */
function ProviderGlyph({ provider, model }: { provider: string; model?: string }) {
  return (
    <span className="flex h-4 w-4 shrink-0 items-center justify-center text-text-strong" aria-hidden>
      <ProviderIcon provider={provider} model={model} className="h-[15px] w-[15px]" />
    </span>
  );
}

const MODEL_HOVER_TIP_WIDTH = 220;
const MODEL_HOVER_TIP_GAP = 8;
const MODEL_HOVER_TIP_EFFORT_ROW_HEIGHT = 30;

/** Rough height budget for the model hover card (used for first paint before measure). */
function estimateModelHoverTipHeight(args: {
  showDeepSeekThinking: boolean;
  paneThinkingEnabled: boolean;
  effortMenuOpen: boolean;
  showEffortControls: boolean;
  deepSeekEffortCount: number;
  kimiEffortCount: number;
}): number {
  const {
    showDeepSeekThinking,
    paneThinkingEnabled,
    effortMenuOpen,
    showEffortControls,
    deepSeekEffortCount,
    kimiEffortCount,
  } = args;
  if (showDeepSeekThinking) {
    let h = 140;
    if (paneThinkingEnabled) {
      h = 172;
      if (effortMenuOpen) {
        h += 12 + deepSeekEffortCount * MODEL_HOVER_TIP_EFFORT_ROW_HEIGHT + 8;
      }
    }
    return h;
  }
  if (showEffortControls) {
    let h = 148;
    if (effortMenuOpen) {
      h += 12 + kimiEffortCount * MODEL_HOVER_TIP_EFFORT_ROW_HEIGHT + 8;
    }
    return h;
  }
  return 108;
}

function clampFixedPopoverTop(top: number, height: number, margin = PANE_MODEL_PICKER_MARGIN): number {
  const vh = window.innerHeight;
  let nextTop = top;
  if (nextTop + height > vh - margin) {
    nextTop = Math.max(margin, vh - margin - height);
  }
  if (nextTop < margin) nextTop = margin;
  return nextTop;
}

function PaneModelPicker({
  paneId,
  pendingRoutingTarget = null,
  pendingRoutingAllowsPublic = false,
}: {
  paneId: string;
  pendingRoutingTarget?: RoutingModelRef | null;
  pendingRoutingAllowsPublic?: boolean;
}) {
  const settings = useAppStore((s) => s.settings);
  const setPaneModel = useAppStore((s) => s.setPaneModel);
  const setPaneReasoningEffort = useAppStore((s) => s.setPaneReasoningEffort);
  const setPaneThinkingEnabled = useAppStore((s) => s.setPaneThinkingEnabled);
  const paneModel = useAppStore((s) => s.panes.find((pane) => pane.id === paneId));
  const persistedRoutingTarget = useAppStore((s) => {
    const sessionId = String(paneModel?.sessionId ?? "").trim();
    return sessionId ? s.attachmentRoutingLocks[sessionId] ?? null : null;
  });
  const routingPickerLock = pendingRoutingTarget
    ? {
        disabled: true,
        reason: pendingRoutingAllowsPublic
          ? "检测到文档附件，发送时请选择私有模型或继续使用公网模型。"
          : routingLockReason(pendingRoutingTarget),
      }
    : modelPickerLock(persistedRoutingTarget);
  const routingPickerState = persistedRoutingTarget
    ? "private"
    : pendingRoutingTarget
      ? pendingRoutingAllowsPublic
        ? "choice"
        : "private"
      : null;
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const activeModelRowRef = useRef<HTMLButtonElement | null>(null);
  const hoverClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [panelStyle, setPanelStyle] = useState<CSSProperties>({});
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  const [hoverRowTop, setHoverRowTop] = useState(0);
  const [effortMenuOpen, setEffortMenuOpen] = useState(false);
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null);
  const hoverTipRef = useRef<HTMLDivElement>(null);
  const [hoverTipLayout, setHoverTipLayout] = useState<{ top: number; maxHeight: number } | null>(
    null,
  );

  /** Keep tip visible while moving between list row and tip card. */
  const cancelClearHover = useCallback(() => {
    if (hoverClearTimerRef.current != null) {
      clearTimeout(hoverClearTimerRef.current);
      hoverClearTimerRef.current = null;
    }
  }, []);

  const scheduleClearHover = useCallback(() => {
    cancelClearHover();
    hoverClearTimerRef.current = setTimeout(() => {
      setHoverKey(null);
      setEffortMenuOpen(false);
      hoverClearTimerRef.current = null;
    }, 120);
  }, [cancelClearHover]);

  useEffect(() => {
    return () => {
      if (hoverClearTimerRef.current != null) {
        clearTimeout(hoverClearTimerRef.current);
        hoverClearTimerRef.current = null;
      }
    };
  }, []);

  const handleSelect = (provider: string, model: string) => {
    if (routingPickerLock.disabled) return;
    setPaneModel(paneId, provider, model);
    setOpen(false);
    // Persist the current pane model as global fallback for restarts.
    void window.agenticxDesktop.saveConfig({ activeProvider: provider, activeModel: model }).then((result) => {
      if (!result.ok) {
        console.warn("[ChatPane] global model persistence failed", result.error);
      }
    });
    // If this pane is bound to a real session, record the model against that
    // session so a cold restart + jump-back restores the exact pick.
    const sid = String(paneModel?.sessionId ?? "").trim();
    if (sid) {
      void window.agenticxDesktop.setSessionModel({ sessionId: sid, provider, model }).then((result) => {
        if (!result.ok) {
          console.warn("[ChatPane] session model persistence failed", result.error);
        }
      });
    }
  };

  const options = useMemo(
    () => sortModelOptionsByPrefix(collectSelectableModelOptions(settings.providers)),
    [settings.providers],
  );

  /**
   * Group by vendor. Seed every enabled+credentialed provider first so「已启动」渠道
   * (e.g. MOMA with only legacy `model` / empty visible `models`) still gets a section.
   */
  const physicalProviderGroups = useMemo(() => {
    const byProvider = new Map<string, typeof options>();
    for (const [provider, entry] of Object.entries(settings.providers)) {
      if (entry.enabled === false) continue;
      if (!isProviderCredentialed(entry)) continue;
      byProvider.set(provider, []);
    }
    for (const opt of options) {
      const bucket = byProvider.get(opt.provider);
      if (bucket) bucket.push(opt);
      else byProvider.set(opt.provider, [opt]);
    }
    return [...byProvider.entries()].map(([provider, items]) => ({
      provider,
      providerLabel: getProviderDisplayName(provider, settings.providers[provider]),
      items,
    }));
  }, [options, settings.providers]);
  const directProviderId = useMemo(
    () => resolveDirectModelPickerProvider(settings.providers),
    [settings.providers],
  );
  const groups = useMemo(() => {
    if (directProviderId) {
      const entry = settings.providers[directProviderId];
      if (entry) {
        const internalGroups = groupManagedModelOptions(
          entry,
          options.filter((option) => option.provider === directProviderId),
        );
        return internalGroups.map((group) => ({
          key: `${directProviderId}:${group.provider.toLowerCase()}`,
          requestProvider: directProviderId,
          visualProvider: group.provider,
          providerLabel: group.providerLabel,
          items: group.items,
        }));
      }
    }
    return physicalProviderGroups.map((group) => ({
      key: group.provider,
      requestProvider: group.provider,
      visualProvider: group.provider,
      providerLabel: group.providerLabel,
      items: group.items,
    }));
  }, [directProviderId, options, physicalProviderGroups, settings.providers]);
  const explicitlySelectedProviderGroup = selectedProviderId
    ? groups.find((group) => group.key === selectedProviderId) ?? null
    : null;
  const selectedProviderGroup =
    explicitlySelectedProviderGroup ?? (directProviderId && groups.length === 1 ? groups[0] ?? null : null);
  const displayedProviderId = selectedProviderGroup?.requestProvider ?? null;

  /** Same model id served by several vendors — only then does the row need its vendor spelled out. */
  const ambiguousModelNames = useMemo(() => {
    const seen = new Map<string, Set<string>>();
    for (const opt of options) {
      const { modelName } = formatModelDisplayParts(opt.provider, opt.model, settings.providers[opt.provider]);
      const providers = seen.get(modelName) ?? new Set<string>();
      providers.add(opt.provider);
      seen.set(modelName, providers);
    }
    return new Set([...seen.entries()].filter(([, p]) => p.size > 1).map(([name]) => name));
  }, [options, settings.providers]);

  const currentProvider = (paneModel?.modelProvider || "").trim();
  const currentModel = (paneModel?.modelName || "").trim();
  const currentSelectable =
    Boolean(currentModel)
    && Boolean(currentProvider)
    && isModelSelectable(currentProvider, currentModel, settings.providers);
  const currentParts = useMemo(() => {
    if (!currentSelectable) return null;
    return formatModelDisplayParts(currentProvider, currentModel, settings.providers[currentProvider]);
  }, [currentSelectable, currentModel, currentProvider, settings.providers]);
  const currentLabel = useMemo(() => {
    if (!currentModel) return "未选模型";
    if (!currentProvider) return currentModel;
    if (!currentSelectable) return "未选模型";
    const entry = settings.providers[currentProvider];
    return formatModelOptionLabel(currentProvider, currentModel, entry);
  }, [currentModel, currentProvider, currentSelectable, settings.providers]);

  const syncPanelPosition = useCallback(() => {
    const el = anchorRef.current;
    if (!el) return;
    setPanelStyle(paneModelPickerPanelStyle(el.getBoundingClientRect()));
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    syncPanelPosition();
    const onReflow = () => syncPanelPosition();
    window.addEventListener("resize", onReflow);
    window.addEventListener("scroll", onReflow, true);
    return () => {
      window.removeEventListener("resize", onReflow);
      window.removeEventListener("scroll", onReflow, true);
    };
  }, [open, syncPanelPosition, options.length]);

  useEffect(() => {
    if (!open) {
      setHoverKey(null);
      setEffortMenuOpen(false);
      setSelectedProviderId(null);
      cancelClearHover();
    }
  }, [open, cancelClearHover]);

  useEffect(() => {
    if (routingPickerLock.disabled) setOpen(false);
  }, [routingPickerLock.disabled]);

  // 进入当前渠道的模型列表后，把当前模型滚进可视区。
  useLayoutEffect(() => {
    if (!open || displayedProviderId !== currentProvider) return;
    const row = activeModelRowRef.current;
    if (!row) return;
    row.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [open, displayedProviderId, currentProvider, currentModel]);

  const hoverOpt = useMemo(() => {
    if (!hoverKey) return null;
    return options.find((o) => `${o.provider}:${o.model}` === hoverKey) ?? null;
  }, [hoverKey, options]);

  const hoverBlurb = useMemo(() => {
    if (!hoverOpt) return null;
    const providerGroup = groups.find((group) =>
      group.items.some(
        (item) => item.provider === hoverOpt.provider && item.model === hoverOpt.model,
      ),
    );
    const providerLabel =
      providerGroup?.providerLabel
      ?? getProviderDisplayName(hoverOpt.provider, settings.providers[hoverOpt.provider]);
    return describeModelForPicker(
      providerGroup?.visualProvider ?? hoverOpt.provider,
      hoverOpt.model,
      providerLabel,
    );
  }, [groups, hoverOpt, settings.providers]);

  const paneReasoningEffort = normalizeKimiReasoningEffort(paneModel?.reasoningEffort);
  const paneDeepSeekEffort = normalizeDeepSeekReasoningEffort(paneModel?.reasoningEffort);
  const paneThinkingEnabled = paneModel?.thinkingEnabled !== false;
  const showEffortControls = Boolean(hoverBlurb?.supportsReasoningEffort);
  const showDeepSeekThinking = Boolean(hoverBlurb?.supportsDeepSeekThinking);

  const hoverTipStyle = useMemo((): CSSProperties | null => {
    if (!hoverBlurb || !panelRef.current) return null;
    const panel = panelRef.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const tipW = MODEL_HOVER_TIP_WIDTH;
    const spaceRight = vw - panel.right - PANE_MODEL_PICKER_MARGIN;
    const placeRight = spaceRight >= tipW + MODEL_HOVER_TIP_GAP;
    const left = placeRight
      ? panel.right + MODEL_HOVER_TIP_GAP
      : Math.max(PANE_MODEL_PICKER_MARGIN, panel.left - MODEL_HOVER_TIP_GAP - tipW);
    const tipH = estimateModelHoverTipHeight({
      showDeepSeekThinking,
      paneThinkingEnabled,
      effortMenuOpen,
      showEffortControls,
      deepSeekEffortCount: DEEPSEEK_REASONING_EFFORT_OPTIONS.length,
      kimiEffortCount: KIMI_REASONING_EFFORT_OPTIONS.length,
    });
    const top = clampFixedPopoverTop(hoverRowTop, tipH);
    return {
      left,
      top,
      width: tipW,
    };
  }, [hoverBlurb, hoverRowTop, showEffortControls, showDeepSeekThinking, paneThinkingEnabled, effortMenuOpen]);

  useLayoutEffect(() => {
    const el = hoverTipRef.current;
    if (!hoverBlurb || !hoverTipStyle || !el) {
      setHoverTipLayout(null);
      return;
    }
    const height = el.getBoundingClientRect().height;
    const baseTop = typeof hoverTipStyle.top === "number" ? hoverTipStyle.top : PANE_MODEL_PICKER_MARGIN;
    const top = clampFixedPopoverTop(baseTop, height);
    const maxHeight = Math.max(
      MODEL_HOVER_TIP_EFFORT_ROW_HEIGHT,
      window.innerHeight - top - PANE_MODEL_PICKER_MARGIN,
    );
    setHoverTipLayout((prev) =>
      prev && prev.top === top && prev.maxHeight === maxHeight ? prev : { top, maxHeight },
    );
  }, [
    hoverBlurb,
    hoverTipStyle,
    effortMenuOpen,
    paneThinkingEnabled,
    hoverKey,
    showEffortControls,
    showDeepSeekThinking,
  ]);

  return (
    <div className="relative min-w-0 max-w-full" ref={anchorRef}>
      <button
        type="button"
        disabled={routingPickerLock.disabled}
        className={`group flex h-8 min-h-8 max-w-full min-w-0 items-center gap-2 rounded-lg px-1.5 text-[13px] font-medium leading-5 transition-colors focus:outline-none focus-visible:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-100 ${
          open
            ? "bg-surface-hover"
            : routingPickerState === "private"
              ? "bg-cyan-500/10"
              : routingPickerState === "choice"
                ? "bg-amber-500/10"
                : "hover:bg-surface-hover"
        }`}
        onClick={() => {
          if (routingPickerLock.disabled) return;
          setOpen((v) => !v);
        }}
        title={routingPickerLock.reason || currentLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <ProviderGlyph provider={currentProvider} model={currentModel} />
        <span className="flex min-w-0 flex-1 items-baseline gap-1.5 text-left">
          <span className="min-w-0 truncate text-text-strong">
            {currentParts?.modelName ?? currentLabel}
          </span>
          {currentParts && ambiguousModelNames.has(currentParts.modelName) ? (
            <span className="shrink-0 truncate text-[11px] font-normal text-text-muted">{currentParts.providerLabel}</span>
          ) : null}
        </span>
        {routingPickerState ? (
          <span
            className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${
              routingPickerState === "private"
                ? "bg-cyan-500/15 text-cyan-300"
                : "bg-amber-500/15 text-amber-300"
            }`}
          >
            {routingPickerState === "private" ? "私有" : "待确认"}
          </span>
        ) : null}
        {routingPickerLock.disabled ? (
          <LockKeyhole className="h-3.5 w-3.5 shrink-0 text-text-muted" strokeWidth={2} aria-hidden />
        ) : (
          <ChevronDown
            className={`h-3.5 w-3.5 shrink-0 text-text-muted transition-transform duration-fast ease-out ${open ? "rotate-180" : ""}`}
            strokeWidth={2}
            aria-hidden
          />
        )}
      </button>
      {open && !routingPickerLock.disabled &&
        createPortal(
          <>
            <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
            <div
              ref={panelRef}
              className="agx-menu-pop fixed z-40 flex flex-col overflow-hidden rounded-2xl border border-border bg-surface-panel shadow-2xl backdrop-blur-xl"
              style={{
                ...panelStyle,
                display: "flex",
                flexDirection: "column",
              }}
              role="listbox"
              onMouseEnter={cancelClearHover}
              onMouseLeave={scheduleClearHover}
            >
              <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
                {options.length === 0 ? (
                  <div className="px-3 py-4 text-center text-[12px] leading-relaxed text-text-muted">
                    还没有可用模型
                    <span className="mt-1 block text-[11px] text-text-subtle">请先在设置中配置服务商</span>
                  </div>
                ) : !selectedProviderGroup ? (
                  <>
                    <div className="px-2.5 pb-1.5 pt-1 text-[11px] text-text-faint">
                      先选择模型提供商
                    </div>
                    {groups.map((group) => {
                      const isCurrentProvider = group.items.some(
                        (item) => item.provider === currentProvider && item.model === currentModel,
                      );
                      return (
                        <button
                          key={group.key}
                          type="button"
                          className={`flex w-full min-w-0 items-center gap-2.5 rounded-lg px-2.5 py-2.5 text-left transition-colors ${
                            isCurrentProvider
                              ? "bg-surface-cardStrong"
                              : "hover:bg-surface-hover"
                          }`}
                          onClick={() => {
                            setSelectedProviderId(group.key);
                            setHoverKey(null);
                            setEffortMenuOpen(false);
                          }}
                        >
                          <ProviderGlyph
                            provider={group.visualProvider}
                            model={group.items[0]?.model ?? ""}
                          />
                          <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-text-strong">
                            {group.providerLabel}
                          </span>
                          <span className="shrink-0 text-[11px] tabular-nums text-text-faint">
                            {group.items.length} 个模型
                          </span>
                          <span className="text-[14px] text-text-faint" aria-hidden>›</span>
                        </button>
                      );
                    })}
                  </>
                ) : (
                  <>
                    {selectedProviderId ? (
                      <button
                        type="button"
                        className="mb-1 flex w-full min-w-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-left text-[12px] text-text-subtle transition-colors hover:bg-surface-hover hover:text-text-strong"
                        onClick={() => {
                          setSelectedProviderId(null);
                          setHoverKey(null);
                          setEffortMenuOpen(false);
                        }}
                      >
                        <span aria-hidden>‹</span>
                        <span>全部提供商</span>
                      </button>
                    ) : null}
                    <div className="px-2.5 pb-1 text-[11px] font-medium text-text-faint">
                      {selectedProviderId
                        ? `${selectedProviderGroup.providerLabel} · 选择模型`
                        : "选择模型"}
                    </div>
                    {selectedProviderGroup.items.length === 0 ? (
                      <div className="px-2.5 py-2 text-[12px] text-text-faint">
                        暂无可见模型，请在设置中添加
                      </div>
                    ) : (
                      selectedProviderGroup.items.map((opt) => {
                        const rowKey = `${opt.provider}:${opt.model}`;
                        const isActive =
                          opt.provider === currentProvider && opt.model === currentModel;
                        const isHover = hoverKey === rowKey;
                        const { modelName } = formatModelDisplayParts(
                          opt.provider,
                          opt.model,
                          settings.providers[opt.provider],
                        );
                        return (
                          <button
                            key={rowKey}
                            ref={isActive ? activeModelRowRef : undefined}
                            type="button"
                            role="option"
                            aria-selected={isActive}
                            className={`flex w-full min-w-0 items-center gap-2.5 rounded-lg py-2 pl-2.5 pr-2.5 text-left text-[13px] leading-5 transition-colors ${
                              isActive || isHover
                                ? "bg-surface-cardStrong"
                                : "hover:bg-surface-hover"
                            }`}
                            onMouseEnter={(e) => {
                              cancelClearHover();
                              setHoverKey(rowKey);
                              setEffortMenuOpen(false);
                              setHoverRowTop(e.currentTarget.getBoundingClientRect().top);
                            }}
                            onClick={() => handleSelect(opt.provider, opt.model)}
                          >
                            <ProviderGlyph
                              provider={selectedProviderGroup.visualProvider}
                              model={opt.model}
                            />
                            <span className="min-w-0 flex-1 whitespace-normal break-all font-semibold leading-5 text-text-strong">
                              {modelName}
                            </span>
                            <span className="flex w-3.5 shrink-0 justify-end">
                              {isActive ? (
                                <Check
                                  className="h-3.5 w-3.5 text-status-success"
                                  strokeWidth={2.5}
                                />
                              ) : null}
                            </span>
                          </button>
                        );
                      })
                    )}
                  </>
                )}
              </div>
              <div className="shrink-0 border-t border-border p-1.5">
                <button
                  type="button"
                  className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-surface-cardStrong px-2.5 py-2 text-[12.5px] font-medium text-text-strong transition-colors hover:bg-surface-hover"
                  onMouseEnter={() => setHoverKey(null)}
                  onClick={() => {
                    setOpen(false);
                    useAppStore.getState().openSettings("account");
                  }}
                >
                  <SquarePen className="h-3.5 w-3.5 shrink-0 text-text-muted" strokeWidth={2} aria-hidden />
                  企业账号与模型
                </button>
              </div>
            </div>
            {hoverBlurb && hoverTipStyle ? (
              <div
                ref={hoverTipRef}
                className={`agx-menu-pop fixed z-[9999] overflow-x-hidden overflow-y-auto rounded-xl border border-border bg-surface-panel px-3.5 py-3 shadow-2xl backdrop-blur-xl ${
                  showEffortControls || showDeepSeekThinking
                    ? "pointer-events-auto"
                    : "pointer-events-none"
                }`}
                style={{
                  ...hoverTipStyle,
                  ...(hoverTipLayout
                    ? { top: hoverTipLayout.top, maxHeight: hoverTipLayout.maxHeight }
                    : null),
                }}
                role="tooltip"
                onMouseEnter={cancelClearHover}
                onMouseLeave={scheduleClearHover}
              >
                <div className="truncate text-[13px] font-semibold leading-snug text-text-strong">
                  {hoverBlurb.title}
                </div>
                <div className="mt-1 text-[12px] leading-relaxed text-text-muted">
                  {hoverBlurb.description}
                </div>
                <div className="mt-2.5 flex items-center justify-between gap-3 border-t border-border pt-2.5 text-[11px]">
                  <span className="text-text-muted">{hoverBlurb.metaLabel}</span>
                  <span className="truncate font-medium text-text-strong">{hoverBlurb.metaValue}</span>
                </div>
                {showDeepSeekThinking ? (
                  <div className="relative mt-2 border-t border-border pt-2">
                    <div className="flex w-full items-center justify-between gap-3 text-[11px]">
                      <span className="text-text-muted">思考模式</span>
                      <SettingsSwitch
                        checked={paneThinkingEnabled}
                        size="sm"
                        aria-label="思考模式"
                        onChange={(next) => {
                          setPaneThinkingEnabled(paneId, next);
                          if (!next) setEffortMenuOpen(false);
                        }}
                      />
                    </div>
                    {paneThinkingEnabled ? (
                      <>
                        <button
                          type="button"
                          className="mt-2 flex w-full items-center justify-between gap-3 text-[11px] transition-colors hover:text-text-strong"
                          onClick={(e) => {
                            e.stopPropagation();
                            setEffortMenuOpen((v) => !v);
                          }}
                        >
                          <span className="text-text-muted">思考强度</span>
                          <span className="inline-flex items-center gap-0.5 font-medium text-text-strong">
                            {labelForDeepSeekReasoningEffort(paneDeepSeekEffort)}
                            <ChevronRight
                              className={`h-3 w-3 text-text-muted transition-transform ${
                                effortMenuOpen ? "rotate-90" : ""
                              }`}
                              strokeWidth={2}
                              aria-hidden
                            />
                          </span>
                        </button>
                        {effortMenuOpen ? (
                          <div className="mt-1.5 overflow-hidden rounded-lg border border-border bg-surface-cardStrong p-0.5">
                            {DEEPSEEK_REASONING_EFFORT_OPTIONS.map((opt) => {
                              const active = paneDeepSeekEffort === opt.value;
                              return (
                                <button
                                  key={opt.value}
                                  type="button"
                                  className={`flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-[11px] transition-colors ${
                                    active
                                      ? "bg-surface-hover font-medium text-text-strong"
                                      : "text-text-muted hover:bg-surface-hover hover:text-text-strong"
                                  }`}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    const next = opt.value as DeepSeekReasoningEffort;
                                    setPaneReasoningEffort(paneId, next);
                                    setEffortMenuOpen(false);
                                  }}
                                >
                                  <span>{opt.label}</span>
                                  {active ? (
                                    <Check className="h-3 w-3 text-status-success" strokeWidth={2.5} />
                                  ) : null}
                                </button>
                              );
                            })}
                          </div>
                        ) : null}
                      </>
                    ) : null}
                  </div>
                ) : showEffortControls ? (
                  <div className="relative mt-2 border-t border-border pt-2">
                    <button
                      type="button"
                      className="flex w-full items-center justify-between gap-3 text-[11px] transition-colors hover:text-text-strong"
                      onClick={(e) => {
                        e.stopPropagation();
                        setEffortMenuOpen((v) => !v);
                      }}
                    >
                      <span className="text-text-muted">思考强度</span>
                      <span className="inline-flex items-center gap-0.5 font-medium text-text-strong">
                        {labelForKimiReasoningEffort(paneReasoningEffort)}
                        <ChevronRight
                          className={`h-3 w-3 text-text-muted transition-transform ${
                            effortMenuOpen ? "rotate-90" : ""
                          }`}
                          strokeWidth={2}
                          aria-hidden
                        />
                      </span>
                    </button>
                    {effortMenuOpen ? (
                      <div className="mt-1.5 overflow-hidden rounded-lg border border-border bg-surface-cardStrong p-0.5">
                        {KIMI_REASONING_EFFORT_OPTIONS.map((opt) => {
                          const active = paneReasoningEffort === opt.value;
                          return (
                            <button
                              key={opt.value}
                              type="button"
                              className={`flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-[11px] transition-colors ${
                                active
                                  ? "bg-surface-hover font-medium text-text-strong"
                                  : "text-text-muted hover:bg-surface-hover hover:text-text-strong"
                              }`}
                              onClick={(e) => {
                                e.stopPropagation();
                                const next = opt.value as KimiReasoningEffort;
                                setPaneReasoningEffort(paneId, next);
                                setEffortMenuOpen(false);
                              }}
                            >
                              <span>{opt.label}</span>
                              {active ? (
                                <Check className="h-3 w-3 text-status-success" strokeWidth={2.5} />
                              ) : null}
                            </button>
                          );
                        })}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : null}
          </>,
          document.body,
        )}
    </div>
  );
}

function PaneKnowledgeRetrievalModeSwitch({
  apiToken,
  apiBase,
  sessionId,
  paneId,
  globalDefaultMode,
  onNewSessionDefaultChange,
  /** True when rendered as a row inside「更多操作」vertical menu (full-width row + right flyout). */
  embedded = false,
}: {
  apiToken: string;
  apiBase: string;
  sessionId: string;
  paneId: string;
  globalDefaultMode: KbRetrievalMode;
  onNewSessionDefaultChange?: (mode: KbRetrievalMode) => void;
  embedded?: boolean;
}) {
  const resolveApiBase = useCallback(async () => {
    const base = String(apiBase ?? "").trim();
    if (base) return base.replace(/\/+$/, "");
    const raw = String((await window.agenticxDesktop.getApiBase()) || "").trim();
    return raw.replace(/\/+$/, "");
  }, [apiBase]);
  const api = useMemo(() => createKbApi(apiToken, resolveApiBase), [apiToken, resolveApiBase]);
  const [mode, setMode] = useState<KbRetrievalMode>(() =>
    resolveDisplayKbRetrievalMode(sessionId, paneId, globalDefaultMode),
  );
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<
    { left: number; top?: number; bottom?: number; maxHeight?: number } | null
  >(null);
  const rootRef = useRef<HTMLElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const refreshGenRef = useRef(0);

  // Sync toolbar icon immediately when session/pane/global default changes —
  // never wait for async readConfig (avoids 2–3s flash of the previous session mode).
  useLayoutEffect(() => {
    setMode(resolveDisplayKbRetrievalMode(sessionId, paneId, globalDefaultMode));
  }, [sessionId, paneId, globalDefaultMode]);

  const refresh = useCallback(async () => {
    const sid = String(sessionId || "").trim();
    const pid = String(paneId || "").trim();
    const gen = ++refreshGenRef.current;
    try {
      const body = await api.readConfig();
      if (gen !== refreshGenRef.current) return;
      const resolvedDefault =
        body.config.retrieval?.mode === "always" ? "always" : "auto";
      setCachedGlobalKbRetrievalMode(resolvedDefault);
      onNewSessionDefaultChange?.(resolvedDefault);
      setMode(resolveDisplayKbRetrievalMode(sid, pid, resolvedDefault));
    } catch {
      setMode(resolveDisplayKbRetrievalMode(sid, pid, globalDefaultMode));
    }
  }, [api, globalDefaultMode, onNewSessionDefaultChange, paneId, sessionId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const openMenu = useCallback((flyoutRight = false) => {
    if (rootRef.current) {
      if (flyoutRight) {
        setMenuPos(positionEmbeddedComposerFlyout(rootRef.current, KB_MODE_SUBMENU_WIDTH));
      } else {
        const rect = rootRef.current.getBoundingClientRect();
        setMenuPos({
          bottom: window.innerHeight - rect.top + 4,
          left: rect.left,
        });
      }
    }
    setOpen(true);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (rootRef.current?.contains(t)) return;
      if (menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const saveMode = useCallback(
    async (nextMode: KbRetrievalMode) => {
      if (saving) return;
      const sid = String(sessionId || "").trim();
      const pid = String(paneId || "").trim();
      if (!pid && !sid) return;
      const previous = mode;
      // Invalidate any in-flight refresh so global config cannot overwrite
      // the choice the user just made.
      refreshGenRef.current += 1;
      setMode(nextMode);
      setSaving(true);
      try {
        // Bind the choice to this session (or lazy pane pending slot before first send).
        setKbRetrievalModeForPane(sid, pid, nextMode);
      } catch {
        setMode(previous);
      } finally {
        setSaving(false);
      }
    },
    [mode, paneId, saving, sessionId],
  );

  const activeLabel =
    KB_RETRIEVAL_MODE_OPTIONS.find((opt) => opt.value === mode)?.label ?? "智能检索";

  // Portal to document.body — composer toolbar has overflow-hidden and would clip
  // an absolute dropdown.
  const panel =
    open && menuPos
      ? createPortal(
          <div
            id="agx-kb-retrieval-mode-menu"
            ref={menuRef}
            style={{
              left: menuPos.left,
              ...(menuPos.top != null
                ? { top: menuPos.top, maxHeight: menuPos.maxHeight }
                : { bottom: menuPos.bottom }),
            }}
            className="fixed z-[9999] w-[200px] overflow-y-auto overflow-x-hidden rounded-xl border border-border bg-surface-panel p-1.5 shadow-xl backdrop-blur-xl"
            role="listbox"
            aria-label="知识库检索模式"
          >
            {KB_RETRIEVAL_MODE_OPTIONS.map((opt) => {
              const isActive = mode === opt.value;
              const Icon = opt.value === "auto" ? Sparkles : Radar;
              return (
                <button
                  key={opt.value}
                  type="button"
                  role="option"
                  aria-selected={isActive}
                  disabled={saving}
                  className={`group flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors ${
                    isActive ? "bg-surface-hover" : "hover:bg-surface-hover"
                  } ${opt.value === "always" ? "mt-0.5" : ""}`}
                  onClick={() => {
                    setOpen(false);
                    void saveMode(opt.value);
                  }}
                >
                  <Icon
                    className={`h-[15px] w-[15px] shrink-0 ${
                      isActive ? "text-text-strong" : "text-text-muted group-hover:text-text-standard"
                    }`}
                    strokeWidth={2}
                  />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span
                      className={`text-[13px] font-medium leading-none ${
                        isActive ? "text-text-strong" : "text-text-standard"
                      }`}
                    >
                      {opt.label}
                    </span>
                    <span className="text-[11px] leading-none text-text-faint">{opt.hint}</span>
                  </span>
                  <span className="flex w-4 shrink-0 justify-end">
                    {isActive ? (
                      <Check className="h-3.5 w-3.5 text-text-strong" strokeWidth={2.5} />
                    ) : null}
                  </span>
                </button>
              );
            })}
          </div>,
          document.body,
        )
      : null;

  if (embedded) {
    return (
      <>
        <button
          ref={rootRef as unknown as RefObject<HTMLButtonElement>}
          type="button"
          role="menuitem"
          className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] text-text-standard transition-colors hover:bg-surface-hover"
          disabled={saving}
          aria-label="知识库检索"
          aria-expanded={open}
          onClick={() => (open ? setOpen(false) : openMenu(true))}
        >
          {mode === "auto" ? (
            <Sparkles className="h-[15px] w-[15px] shrink-0 text-text-muted" strokeWidth={2} aria-hidden />
          ) : (
            <Radar className="h-[15px] w-[15px] shrink-0 text-text-muted" strokeWidth={2} aria-hidden />
          )}
          <span className="flex-1">知识库检索</span>
          <span className="text-[11px] text-text-faint">{activeLabel}</span>
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-text-faint" aria-hidden />
        </button>
        {panel}
      </>
    );
  }

  return (
    <>
      <div ref={rootRef as unknown as RefObject<HTMLDivElement>} className="relative">
        <HoverTip label={`知识库检索模式：${activeLabel}`}>
          <button
            type="button"
            className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition hover:bg-surface-hover hover:text-text-strong ${
              open ? "bg-surface-hover text-text-strong" : "text-text-muted"
            }`}
            disabled={saving}
            aria-label="知识库检索模式"
            aria-expanded={open}
            onClick={() => (open ? setOpen(false) : openMenu())}
          >
            {mode === "auto" ? (
              <Sparkles className="h-[15px] w-[15px]" strokeWidth={2} aria-hidden />
            ) : (
              <Radar className="h-[15px] w-[15px]" strokeWidth={2} aria-hidden />
            )}
          </button>
        </HoverTip>
      </div>
      {panel}
    </>
  );
}

function SendIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
      <line x1="12" y1="19" x2="12" y2="5" />
      <polyline points="5 12 12 5 19 12" />
    </svg>
  );
}

function MicIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
      <rect x="9" y="2" width="6" height="13" rx="3" />
      <path d="M5 10a7 7 0 0 0 14 0" />
      <line x1="12" y1="17" x2="12" y2="21" />
      <line x1="8" y1="21" x2="16" y2="21" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className="h-3.5 w-3.5">
      <rect x="5" y="5" width="14" height="14" rx="2" />
    </svg>
  );
}

function ResumeIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
      <path d="M5 12a7 7 0 1 0 2-4.9" />
      <polyline points="5 4 5 9 10 9" />
    </svg>
  );
}

type ActionCircleButtonProps = {
  hasInput: boolean;
  streaming: boolean;
  recording: boolean;
  transcribing?: boolean;
  canResume?: boolean;
  resuming?: boolean;
  onSend: () => void;
  onMic: () => void;
  onStop: () => void;
  onResume?: () => void;
};

function ActionCircleButton({
  hasInput,
  streaming,
  recording,
  transcribing = false,
  canResume = false,
  resuming = false,
  onSend,
  onMic,
  onStop,
  onResume,
}: ActionCircleButtonProps) {
  let onClick: () => void;
  let title: string;
  let icon: ReactNode;
  let filled: boolean;

  if (streaming && hasInput) {
    onClick = onSend;
    title = "排队发送";
    icon = <SendIcon />;
    filled = true;
  } else if (streaming) {
    onClick = onStop;
    title = "中断生成";
    icon = <StopIcon />;
    filled = true;
  } else if (hasInput) {
    onClick = onSend;
    title = "发送";
    icon = <SendIcon />;
    filled = true;
  } else if (canResume && onResume) {
    onClick = onResume;
    title = resuming ? "恢复中" : "继续执行";
    icon = resuming ? (
      <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
    ) : (
      <ResumeIcon />
    );
    filled = true;
  } else if (!VOICE_UI_ENABLED) {
    // 语音入口隐藏时仍保留发送键，避免输入区右侧失去主要操作。
    onClick = onSend;
    title = "发送";
    icon = <SendIcon />;
    filled = false;
  } else if (transcribing) {
    onClick = onMic;
    title = "识别中";
    icon = (
      <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
    );
    filled = false;
  } else if (recording) {
    onClick = onMic;
    title = "停止录音";
    icon = (
      <span className="flex gap-0.5 items-end h-4">
        {[0, 1, 2, 3].map((i) => (
          <span
            key={i}
            className="w-0.5 rounded-full animate-pulse"
            style={{
              background: "currentColor",
              height: `${[8, 14, 10, 12][i]}px`,
              animationDelay: `${i * 0.12}s`,
            }}
          />
        ))}
      </span>
    );
    filled = false;
  } else {
    onClick = onMic;
    title = "语音输入";
    icon = <MicIcon />;
    filled = false;
  }

  return (
    <button
      className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full transition-all duration-150 active:scale-95 ${
        filled ? "" : "text-text-muted hover:text-text-strong"
      }`}
      style={
        filled
          ? { background: "var(--ui-btn-primary-bg)", color: "var(--ui-btn-primary-text)" }
          : undefined
      }
      disabled={resuming || (!VOICE_UI_ENABLED && !hasInput && !streaming && !canResume)}
      aria-label={title}
      onClick={onClick}
      title={title}
    >
      {icon}
    </button>
  );
}

function composerFileExt(name: string): string {
  const idx = name.lastIndexOf(".");
  if (idx < 0 || idx === name.length - 1) return "FILE";
  return name.slice(idx + 1).toUpperCase();
}

function composerFileIconKind(name: string, mimeType: string): "spreadsheet" | "document" | "code" | "image" | "generic" {
  const lower = name.toLowerCase();
  const mime = mimeType.toLowerCase();
  if (mime.startsWith("image/") || /\.(png|jpe?g|gif|webp|bmp|svg|heic|avif)$/.test(lower)) return "image";
  if (/\.(xls|xlsx|csv|tsv|ods)$/.test(lower) || mime.includes("spreadsheet") || mime === "text/csv") {
    return "spreadsheet";
  }
  if (/\.(pdf|doc|docx|ppt|pptx|pages|rtf|odt|txt|md)$/.test(lower)) return "document";
  if (/\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|swift|c|cpp|h|hpp|cs|rb|php|sh|json|yaml|yml|toml|xml|html|css|sql)$/.test(lower)) {
    return "code";
  }
  return "generic";
}

function composerIconPalette(kind: ReturnType<typeof composerFileIconKind>): { bg: string; fg: string } {
  switch (kind) {
    case "spreadsheet":
      return { bg: "rgba(34, 197, 94, 0.16)", fg: "rgb(22, 163, 74)" };
    case "document":
      return { bg: "rgba(59, 130, 246, 0.14)", fg: "rgb(37, 99, 235)" };
    case "code":
      return { bg: "rgba(168, 85, 247, 0.14)", fg: "rgb(147, 51, 234)" };
    case "image":
      return { bg: "rgba(236, 72, 153, 0.12)", fg: "rgb(219, 39, 119)" };
    default:
      return { bg: "var(--surface-hover)", fg: "var(--text-faint)" };
  }
}

function ComposerFileGlyph({ kind }: { kind: ReturnType<typeof composerFileIconKind> }) {
  const common = {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    className: "h-[18px] w-[18px]",
  } as const;
  if (kind === "spreadsheet") {
    return (
      <svg {...common}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M4 5.5A1.5 1.5 0 015.5 4h13A1.5 1.5 0 0120 5.5v13a1.5 1.5 0 01-1.5 1.5h-13A1.5 1.5 0 014 18.5v-13z" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M4 9.5h16M4 14.5h16M9.5 4v16" />
      </svg>
    );
  }
  if (kind === "document") {
    return (
      <svg {...common}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M7 3.5h6.5L19 9v11.5A1.5 1.5 0 0117.5 22h-10A1.5 1.5 0 016 20.5v-15A1.5 1.5 0 017.5 4" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 3.5V9H19M9 13h6M9 17h4" />
      </svg>
    );
  }
  if (kind === "code") {
    return (
      <svg {...common}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M8 8l-4 4 4 4M16 8l4 4-4 4M13 5l-2 14" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M8 3.5h5.5L18 8v12.5A1.5 1.5 0 0116.5 22h-8A1.5 1.5 0 017 20.5v-15A1.5 1.5 0 018.5 4" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 3.5V8H18" />
    </svg>
  );
}

/** Trae Work–style composer attachment chip (matches sent-message AttachmentCard). */
function AttachmentChip({ file, onRemove }: { file: AttachedFile; onRemove: () => void }) {
  const isImage = !!file.dataUrl && file.mimeType.startsWith("image/");
  const isReferenceToken = !!file.referenceToken;
  const pathHint =
    isReferenceToken && file.sourcePath ? formatReferencePathHint(file.sourcePath) : "";
  const ext = composerFileExt(file.name);
  const kind = composerFileIconKind(file.name, file.mimeType);
  const palette = composerIconPalette(kind);
  const secondary = isReferenceToken
    ? pathHint
      ? `@ ${pathHint}`
      : "@ 文件引用"
    : file.status === "parsing"
      ? "解析中..."
      : file.status === "error"
        ? file.errorText || "解析失败"
        : ext;

  return (
    <div
      className={`group relative inline-flex min-w-[148px] max-w-[200px] items-center gap-2.5 rounded-2xl px-2.5 py-2 text-left transition-colors ${
        isReferenceToken
          ? "border border-sky-500/40 bg-sky-500/10"
          : "bg-surface-panel hover:bg-surface-hover/80"
      }`}
      title={file.sourcePath ? resolveReferenceSourcePath(file.name, file.sourcePath) : file.name}
    >
      <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-[10px]">
        {isImage && file.dataUrl ? (
          <img src={file.dataUrl} alt={file.name} className="h-full w-full object-cover" />
        ) : isReferenceToken ? (
          <div className="flex h-full w-full items-center justify-center bg-sky-500/20 text-sky-400">
            <span className="text-base leading-none">↘</span>
          </div>
        ) : (
          <div
            className="flex h-full w-full items-center justify-center"
            style={{ background: palette.bg, color: palette.fg }}
          >
            <ComposerFileGlyph kind={kind} />
          </div>
        )}
      </div>
      <div className="min-w-0 flex-1 pr-4">
        <div
          className={`truncate text-[13px] font-medium leading-tight ${
            isReferenceToken ? "text-sky-100" : "text-text-strong"
          }`}
        >
          {file.name}
        </div>
        <div
          className={`mt-0.5 truncate text-[11px] tracking-wide ${
            isReferenceToken
              ? "text-sky-200/80"
              : file.status === "parsing"
                ? "animate-pulse text-text-faint normal-case"
                : file.status === "error"
                  ? "text-status-error normal-case"
                  : "uppercase text-text-faint"
          }`}
        >
          {secondary}
        </div>
      </div>
      <button
        type="button"
        className={`absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full opacity-0 transition-opacity group-hover:opacity-100 ${
          isReferenceToken
            ? "bg-sky-500/20 text-sky-200 hover:bg-sky-500/40 hover:text-sky-100"
            : "bg-surface-panel text-text-muted hover:bg-surface-hover hover:text-text-primary"
        }`}
        onClick={onRemove}
        title="移除附件"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-3 w-3">
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}

type Props = {
  paneId: string;
  focused: boolean;
  onFocus: () => void;
  integratedToolbar?: boolean;
  sidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
  onOpenConfirm: OpenConfirmHandler;
  onConfirmRunEnd: EndConfirmRunHandler;
  onOpenClarification?: (
    requestId: string,
    prompt: string,
    options: string[],
    allowFreeText: boolean,
    agentId?: string,
    context?: Record<string, unknown>
  ) => Promise<{ answerText: string; selectedOptions: string[] } | null>;
  /** Direct inline submit for the clarification card (non-blocking) */
  onSubmitClarification?: (
    requestId: string,
    answer: { answerText: string; selectedOptions: string[] },
    sessionId?: string,
    agentId?: string
  ) => Promise<boolean> | boolean;
  /** Optional host callback for persisting a human's group reaction. */
  onToggleGroupReaction?: (message: Message, emoji: string) => void | Promise<void>;
};

function ModelBadge({ provider, model }: { provider?: string; model?: string }) {
  const providers = useAppStore((s) => s.settings.providers);
  if (!model) return null;
  const entry = provider ? providers[provider] : undefined;
  const label = provider ? formatModelOptionLabel(provider, model, entry) : model;
  return (
    <span className="mb-1 inline-block rounded bg-surface-card-strong px-1.5 py-0.5 text-[10px] text-text-faint">
      {label}
    </span>
  );
}

function isThinkingPlaceholderText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  return /^[\s⏳….·.]+$/.test(trimmed);
}

function normalizeStreamText(text: string): string {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

function isNearBottom(el: HTMLDivElement, thresholdPx = 96): boolean {
  const remain = el.scrollHeight - (el.scrollTop + el.clientHeight);
  return remain <= thresholdPx;
}

function formatToolResultMessage(toolNameRaw: unknown, resultRaw: unknown, providers?: Record<string, import("../utils/provider-display").ProviderDisplayEntry>): { content: string; silent: boolean } {
  const toolName = String(toolNameRaw ?? "").trim() || "tool";
  const resultText = String(resultRaw ?? "");
  if (toolName === "check_resources") {
    return { content: "", silent: true };
  }
  if (toolName === "show_widget") {
    return { content: resultText, silent: false };
  }
  if (toolName === "delegate_to_avatar") {
    try {
      const parsed = JSON.parse(resultText) as Record<string, unknown>;
      const delegated = Boolean(parsed.delegated);
      const avatarName = String(parsed.avatar_name ?? "");
      const delegationId = String(parsed.delegation_id ?? parsed.agent_id ?? "").trim();
      if (delegated) {
        return {
          content: `🤝 已委派给 ${avatarName || "专家"}${delegationId ? `\nID: ${delegationId}` : ""}`,
          silent: false,
        };
      }
    } catch {
      // Fall through to generic formatter.
    }
  }
  if (toolName === "create_avatar") {
    try {
      const parsed = JSON.parse(resultText) as Record<string, unknown>;
      const avatarName = String(parsed.name ?? "").trim();
      const avatarId = String(parsed.avatar_id ?? "").trim();
      if (parsed.ok) {
        return {
          content: `✅ 数字专家「${avatarName || "未命名"}」已创建并加入专家列表${avatarId ? `\nID: ${avatarId}` : ""}`,
          silent: false,
        };
      }
      if (String(parsed.error ?? "") === "avatar_exists") {
        return {
          content: `⚠️ 专家「${avatarName || "同名"}」已存在${avatarId ? `（id=${avatarId}）` : ""}，可直接委派或打开`,
          silent: false,
        };
      }
      const message = String(parsed.message ?? parsed.error ?? "").trim();
      if (message) {
        return { content: `⚠️ 创建专家失败：${message}`, silent: false };
      }
    } catch {
      // Fall through to generic formatter.
    }
  }
  if (toolName === "install_portable_package") {
    try {
      const parsed = JSON.parse(resultText) as Record<string, unknown>;
      const message = String(parsed.message ?? parsed.error ?? "").trim();
      if (parsed.ok) {
        return {
          content: `✅ ${message || "共享配置已导入"}`,
          silent: false,
        };
      }
      if (String(parsed.error ?? "") === "user_cancelled") {
        return { content: "已取消导入共享配置。", silent: false };
      }
      if (message) {
        return { content: `⚠️ 导入共享配置失败：${message}`, silent: false };
      }
    } catch {
      // Fall through to generic formatter.
    }
  }
  if (toolName === "spawn_subagent") {
    try {
      const parsed = JSON.parse(resultText) as Record<string, unknown>;
      const agentId = String(parsed.agent_id ?? "").trim();
      const name = String(parsed.name ?? (agentId || "subagent"));
      const role = String(parsed.role ?? "worker");
      const provider = String(parsed.provider ?? "").trim();
      const model = String(parsed.model ?? "").trim();
      const task = String(parsed.task ?? "").replace(/\s+/g, " ").trim();
      const providerEntry = provider && providers ? providers[provider] : undefined;
      const modelLabel = provider && model
        ? ` · ${formatModelOptionLabel(provider, model, providerEntry)}`
        : "";
      const taskPreview = task ? `\n任务: ${task.slice(0, 140)}${task.length > 140 ? "…" : ""}` : "";
      return {
        content: `🚀 已启动子智能体: ${name} (${role})${modelLabel}${agentId ? `\nID: ${agentId}` : ""}${taskPreview}`,
        silent: false,
      };
    } catch {
      // Fall through to generic formatter.
    }
  }
  if (toolName === "todo_write") {
    const cleaned = resultText.replace(/\s+\n/g, "\n").trim();
    if (/^\[[ xX]\]/m.test(cleaned)) {
      return { content: `🗂 任务清单更新\n${cleaned}`, silent: false };
    }
  }
  if (toolName === "cc_bridge_send") {
    try {
      const parsed = JSON.parse(resultText) as Record<string, unknown>;
      const mode = String(parsed.mode ?? "headless");
      const ok = Boolean(parsed.ok);
      const interactive = Boolean(parsed.interactive);
      const pr = String(parsed.parsed_response ?? "").trim();
      const conf = Number(parsed.parse_confidence ?? 0);
      if (mode === "visible_tui") {
        if (interactive && ok) {
          return {
            content:
              "✅ 已发送到 Claude Code（Visible TUI）。请继续在右侧「claude-code」终端交互；如出现权限提示，直接在终端内按键确认。",
            silent: false,
          };
        }
        if (pr && ok) {
          return {
            content: `✅ Claude Code（Visible TUI，解析置信度 ${Math.round(Math.min(1, conf) * 100)}%）\n\n${pr}`,
            silent: false,
          };
        }
        const tail = String(parsed.tail ?? "").slice(0, 900);
        return {
          content: `⏳ Visible TUI：${ok ? "本轮已结束" : "未完成或解析置信度较低"}。请在右侧「claude-code」内嵌交互终端查看；若未自动连接，请确认 cc-bridge 已启动且配置 token 有效。\n${tail ? `\n---\n${tail}` : ""}`,
          silent: false,
        };
      }
    } catch {
      // fall through
    }
  }
  if (toolName === "query_subagent_status") {
    if (/【已阻止】/.test(resultText)) {
      return { content: "", silent: true };
    }
    try {
      const parsed = JSON.parse(resultText) as Record<string, unknown>;
      const one = parsed?.subagent as Record<string, unknown> | undefined;
      if (one) {
        const name = String(one.name ?? one.agent_id ?? "subagent");
        const status = String(one.status ?? "unknown");
        const action = String(one.current_action ?? "").trim();
        return {
          content: `📡 状态快照: ${name} = ${status}${action ? ` · ${action}` : ""}`,
          silent: false,
        };
      }
      const rows = Array.isArray(parsed?.subagents) ? (parsed.subagents as Array<Record<string, unknown>>) : [];
      if (rows.length > 0) {
        const counts = rows.reduce<Record<string, number>>(
          (acc, row) => {
            const s = String(row.status ?? "unknown");
            acc[s] = (acc[s] ?? 0) + 1;
            return acc;
          },
          {}
        );
        const summary = Object.entries(counts)
          .map(([k, v]) => `${k}:${v}`)
          .join(" ");
        return { content: `📡 状态快照: ${rows.length} 个子智能体 (${summary})`, silent: false };
      }
    } catch {
      // Fall through to generic formatter.
    }
  }
  // Plan-Id: machi-kb-stage1-local-mvp — citation card summary for knowledge_search.
  if (toolName === "knowledge_search") {
    try {
      const parsed = JSON.parse(resultText) as Record<string, unknown>;
      const ok = parsed.ok !== false;
      const disabled = Boolean(parsed.disabled);
      const rawHits = Array.isArray(parsed.hits) ? (parsed.hits as Array<Record<string, unknown>>) : [];
      if (disabled) {
        return {
          content: "📚 知识库未启用（`knowledge_search` 未产生结果）。",
          silent: false,
        };
      }
      if (!ok) {
        const err = String(parsed.error ?? "未知错误");
        return { content: `⚠️ knowledge_search 失败：${err}`, silent: false };
      }
      if (rawHits.length === 0) {
        return {
          content: "📚 知识库未命中相关片段。建议向用户确认是否需要兜底到一般知识。",
          silent: false,
        };
      }
      const lines: string[] = [`📚 知识库命中 ${rawHits.length} 条引用：`];
      rawHits.slice(0, 5).forEach((hit, idx) => {
        const score = typeof hit.score === "number" ? hit.score.toFixed(3) : "?";
        const source = (hit.source as Record<string, unknown>) ?? {};
        const title = String(source.title ?? source.uri ?? "");
        const chunkIdx = source.chunk_index;
        const chunkLabel = chunkIdx !== null && chunkIdx !== undefined ? ` · #${chunkIdx}` : "";
        const textRaw = String(hit.text ?? "").replace(/\s+/g, " ").trim();
        const preview = textRaw.length > 160 ? `${textRaw.slice(0, 160)}…` : textRaw;
        lines.push(`  ${idx + 1}. ${title}${chunkLabel} · score=${score}\n     ${preview}`);
      });
      if (rawHits.length > 5) {
        lines.push(`  …以及 ${rawHits.length - 5} 条更多`);
      }
      return { content: lines.join("\n"), silent: false };
    } catch {
      // Fall through — JSON parse failure is unexpected but shouldn't block output.
    }
  }

  const compact = resultText.slice(0, 500);
  const isError = /^\s*ERROR:/i.test(resultText);
  const isBenignTodoConflict =
    toolName === "todo_write" && /only one task can be in_progress/i.test(resultText);

  if (isBenignTodoConflict) {
    return {
      content: "🧭 任务清单同步中：系统会自动收敛为单一进行中任务，无需操作。",
      silent: false,
    };
  }
  if (isError) {
    return { content: `⚠️ ${toolName} 提示: ${compact}`, silent: false };
  }
  if (!compact.trim()) {
    return { content: "", silent: true };
  }
  return { content: `✅ ${toolName} 结果: ${compact}`, silent: false };
}


function deriveToolStatusFromResult(resultRaw: unknown): "done" | "error" {
  const t =
    typeof resultRaw === "string"
      ? resultRaw
      : (() => {
          try {
            return JSON.stringify(resultRaw ?? "");
          } catch {
            return String(resultRaw ?? "");
          }
        })();
  if (/^\s*ERROR:/i.test(t)) return "error";
  const m = t.match(/exit_code=(\d+)/);
  if (m && m[1] !== "0") return "error";
  // Hook-blocked tool calls should be treated as errors, not done
  if (HOOK_BLOCK_RE.test(t)) return "error";
  return "done";
}

function serializeToolResultRaw(resultRaw: unknown): string {
  if (typeof resultRaw === "string") return resultRaw;
  try {
    return JSON.stringify(resultRaw ?? "", null, 2);
  } catch {
    return String(resultRaw ?? "");
  }
}

function isSetTaskspaceToolSuccess(resultRaw: unknown): boolean {
  if (resultRaw && typeof resultRaw === "object") {
    return (resultRaw as { ok?: unknown }).ok === true;
  }
  if (typeof resultRaw !== "string") return false;
  const text = resultRaw.trim();
  if (!text) return false;
  try {
    const parsed = JSON.parse(text) as { ok?: unknown };
    return parsed?.ok === true;
  } catch {
    return false;
  }
}

function buildToolCallLivePreview(toolNameRaw: unknown, argsRaw: unknown): string | null {
  const toolName = String(toolNameRaw ?? "").trim();
  const args = (argsRaw ?? {}) as Record<string, unknown>;
  if (toolName === "file_write") {
    const path = String(args.path ?? "").trim();
    const content = String(args.content ?? "");
    if (!content.trim()) return null;
    const preview = content.slice(0, 1200);
    return `# file_write: ${path || "(unknown path)"}\n${preview}${content.length > 1200 ? "\n... (truncated)" : ""}`;
  }
  if (toolName === "file_edit") {
    const path = String(args.path ?? "").trim();
    const newText = String(args.new_text ?? "");
    if (!newText.trim()) return null;
    const preview = newText.slice(0, 1200);
    return `# file_edit: ${path || "(unknown path)"}\n${preview}${newText.length > 1200 ? "\n... (truncated)" : ""}`;
  }
  return null;
}

const TASKSPACE_WIDTH_STORAGE_KEY = "agenticx:taskspace-panel-width";
const SPAWNS_WIDTH_STORAGE_KEY = "agenticx:spawns-column-width";
const RUN_DRAWER_WIDTH_STORAGE_KEY = "agenticx:run-drawer-width";
/** Chat column floor while dragging the workbench wider (Trae-like: prefer a large canvas). */
const CHAT_COLUMN_MIN_WIDTH = 240;
/** Workbench may grow up to this share of the pane; chat keeps CHAT_COLUMN_MIN_WIDTH. */
const TASKSPACE_MAX_WIDTH_RATIO = 0.62;
const TEXT_ATTACHMENT_LIMIT = 32000;

type AttachedFileStatus = "parsing" | "ready" | "error";

type AttachedFile = {
  name: string;
  size: number;
  mimeType: string;
  status: AttachedFileStatus;
  content: string;
  dataUrl?: string;
  errorText?: string;
  sourcePath?: string;
  referenceToken?: boolean;
  /** @工作区别名：输入框 @提及文案与 chip 用短名，附件标题仍用 `name`（如 @dir:…） */
  composerRefLabel?: string;
  lineRange?: { start: number; end: number };
  spreadsheetRef?: { sheet: string; a1: string };
  snippetRef?: string;
  snippetContent?: string;
  htmlElementRef?: { tagName: string; selectorHint: string; comment?: string };
};

function isImageFile(file: File): boolean {
  return file.type.startsWith("image/");
}

/** Office/PDF documents the frontend cannot parse inline; backend skills (liteparse/docx) handle them via absolute path. */
function isReferenceableDocumentFile(file: File): boolean {
  const lower = file.name.toLowerCase();
  return [".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx", ".pdf"].some((ext) => lower.endsWith(ext));
}

/** Match composer attachment to parsed contextFiles row for /api/chat context_files body. */
function resolveReadyAttachment(
  file: MessageAttachment,
  readyTuples: [string, AttachedFile][]
): AttachedFile | undefined {
  // Prefer exact resource key (`abs:el-snippet-…`) — multiple HTML element chips share one sourcePath.
  const wantKey = buildContextFileKeyFromAttachment(file);
  if (wantKey) {
    for (const [stateKey, rec] of readyTuples) {
      if (stateKey === wantKey) return rec;
      if (buildContextFileKeyFromAttachment(rec) === wantKey) return rec;
    }
  }
  const wantSnippet = String(file.snippetRef || "").trim();
  if (wantSnippet) {
    for (const [, rec] of readyTuples) {
      if (String(rec.snippetRef || "").trim() === wantSnippet) return rec;
    }
  }
  const byAlias = new Map<string, AttachedFile>();
  for (const [stateKey, rec] of readyTuples) {
    byAlias.set(stateKey, rec);
    const nm = String(rec.name || "").trim();
    if (nm) byAlias.set(nm, rec);
    // Only index bare sourcePath when the row is NOT a snippet/line-range slice.
    const sp = String(rec.sourcePath || "").trim();
    if (sp && !rec.snippetRef && !rec.lineRange) byAlias.set(sp, rec);
  }
  const keys = [file.name, file.sourcePath].map((k) => String(k || "").trim()).filter(Boolean);
  for (const k of keys) {
    const hit = byAlias.get(k);
    if (hit) return hit;
  }
  for (const [, rec] of readyTuples) {
    if (file.name && rec.name === file.name && file.size === rec.size) return rec;
  }
  for (const [, rec] of readyTuples) {
    if (file.name && rec.name === file.name) return rec;
  }
  return undefined;
}

type AtCandidate = AtMentionCandidate;

export type GroupTeamControlState = "idle" | "running" | "paused" | "stopped";

const GROUP_TEAM_CONTROL_STATES = new Set<GroupTeamControlState>([
  "idle",
  "running",
  "paused",
  "stopped",
]);

/** Normalize Workforce lifecycle names from either SSE envelope or payload data. */
export function normalizeGroupTeamControlEvent(
  rawType: unknown,
  rawData?: Record<string, unknown>,
): string {
  const normalize = (value: unknown) =>
    String(value ?? "")
      .trim()
      .toLowerCase()
      .replace(/[\s.-]+/g, "_");
  const envelope = normalize(rawType);
  const dataEvent = normalize(
    rawData?.workflow_event_type ??
      rawData?.workflowEventType ??
      rawData?.workflow_event ??
      rawData?.action,
  );
  // A lifecycle envelope is authoritative even when a bridge includes a
  // task-level workflow_event_type in its data object.
  let event = envelope.startsWith("workforce_")
    ? envelope
    : dataEvent || envelope;
  if (event.startsWith("workforce_")) {
    event = event.replace(/^workforce_workforce_/, "workforce_");
  } else if (["started", "paused", "resumed", "stopped"].includes(event)) {
    event = `workforce_${event}`;
  }
  return event;
}

/** Map a persisted/live Graph status to the Team control state projection. */
export function groupTeamControlStateFromGraph(
  graph: { status?: unknown; nodes?: unknown } | null | undefined,
): GroupTeamControlState {
  if (!graph || !graphHasTaskNodes((graph.nodes ?? {}) as Parameters<typeof graphHasTaskNodes>[0])) {
    return "idle";
  }
  const status = String(graph.status ?? "").trim().toLowerCase();
  if (status === "paused") return "paused";
  if (["open", "running", "active", "resuming"].includes(status)) return "running";
  if (["closed", "stopped", "cancelled", "done", "failed", "finalizing"].includes(status)) {
    return "stopped";
  }
  return "idle";
}

export type GroupTeamControlVisibilityInput = {
  isGroupPane: boolean;
  sessionId: unknown;
  routing?: unknown;
  controlState?: GroupTeamControlState | string | null;
  /** State recovered from a session-scoped Graph/Workforce snapshot. */
  sessionControlState?: GroupTeamControlState | string | null;
  canInterruptCurrentSession?: boolean;
  executionState?: unknown;
  runGuardSessionId?: unknown;
  stallState?: "none" | "stall" | "exhausted" | string;
};

/**
 * Team controls are an activity surface, not a static property of a group.
 * Wait for a server Workforce/Graph state before exposing them: an explicit
 * Team room still spends a short planning window without a registered control
 * plane, and showing clickable actions in that window only produces a 409.
 */
export function shouldShowGroupTeamControls(
  input: GroupTeamControlVisibilityInput,
): boolean {
  const sid = String(input.sessionId ?? "").trim();
  if (!input.isGroupPane || !sid) return false;

  const normalizeState = (value: unknown): GroupTeamControlState => {
    const state = String(value ?? "").trim().toLowerCase();
    return GROUP_TEAM_CONTROL_STATES.has(state as GroupTeamControlState)
      ? (state as GroupTeamControlState)
      : "idle";
  };
  // A local stopped transition is deliberately sticky until the next backend
  // Workforce start/resume event arrives for this exact session.
  const localState = normalizeState(input.controlState);
  const sessionState = normalizeState(input.sessionControlState);
  const state = localState !== "idle" ? localState : sessionState;
  if (state === "stopped") return false;
  if (state === "running" || state === "paused") return true;
  return false;
}

/** Remove internal quote-chip markers before sending a task description. */
export function cleanGroupTeamTaskDescription(value: unknown): string {
  return stripComposerQuotePlaceholders(String(value ?? "")).trim();
}

export type GroupTeamControlsProps = {
  paused: boolean;
  pending?: boolean;
  taskDescription?: unknown;
  onAddTask: (description: string) => void;
  onPauseResume: () => void;
  onStop: () => void;
};

/** Renderable Team controls kept separate so their disabled/empty behavior is testable. */
export function GroupTeamControls({
  paused,
  pending = false,
  taskDescription,
  onAddTask,
  onPauseResume,
  onStop,
}: GroupTeamControlsProps) {
  // React's `disabled` prop is only committed on the next render. Keep a
  // render-local latch as well so two native clicks in the same event turn
  // cannot submit the same task before the parent pending state lands.
  let addTaskPending = false;
  const addTask = () => {
    if (pending || addTaskPending) return;
    const description = cleanGroupTeamTaskDescription(taskDescription);
    if (!description) return;
    addTaskPending = true;
    onAddTask(description);
  };

  return (
    <div className="flex items-center gap-1 mr-1" data-testid="group-team-controls">
      <button
        type="button"
        className="flex h-7 items-center gap-1 rounded-lg px-2 text-[11px] text-text-faint transition hover:bg-indigo-500/10 hover:text-indigo-400 disabled:cursor-not-allowed disabled:opacity-50"
        title="加入本轮协作"
        aria-label="加入本轮协作"
        disabled={pending}
        aria-busy={pending}
        onClick={addTask}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.8}
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-3.5 w-3.5"
          aria-hidden
        >
          <path d="M12 5v14M5 12h14" />
        </svg>
        <span className="hidden sm:inline">插入任务</span>
      </button>
      <button
        type="button"
        className={`flex h-7 items-center gap-1 rounded-lg px-2 text-[11px] transition hover:bg-amber-500/10 disabled:cursor-not-allowed disabled:opacity-50 ${
          paused ? "text-emerald-400 hover:bg-emerald-500/10" : "text-amber-400"
        }`}
        title={paused ? "继续团队任务" : "暂停团队任务"}
        aria-label={paused ? "继续团队任务" : "暂停团队任务"}
        disabled={pending}
        aria-busy={pending}
        onClick={onPauseResume}
      >
        {paused ? (
          <svg viewBox="0 0 24 24" fill="currentColor" className="h-3.5 w-3.5" aria-hidden>
            <path d="M8 5v14l11-7z" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" fill="currentColor" className="h-3.5 w-3.5" aria-hidden>
            <rect x="6" y="4" width="4" height="16" />
            <rect x="14" y="4" width="4" height="16" />
          </svg>
        )}
        <span className="hidden sm:inline">{paused ? "继续" : "暂停"}</span>
      </button>
      <button
        type="button"
        className="flex h-7 items-center gap-1 rounded-lg px-2 text-[11px] text-rose-400 transition hover:bg-rose-500/10 disabled:cursor-not-allowed disabled:opacity-50"
        title="停止团队任务"
        aria-label="停止团队任务"
        disabled={pending}
        aria-busy={pending}
        onClick={onStop}
      >
        <svg viewBox="0 0 24 24" fill="currentColor" className="h-3.5 w-3.5" aria-hidden>
          <rect x="6" y="6" width="12" height="12" rx="1.5" />
        </svg>
        <span className="hidden sm:inline">停止</span>
      </button>
    </div>
  );
}

/** Return only the control state belonging to the displayed session. */
export function groupTeamControlStateForSession(
  states: Record<string, GroupTeamControlState>,
  sessionId: unknown,
): GroupTeamControlState {
  const sid = String(sessionId || "").trim();
  return sid ? states[sid] ?? "idle" : "idle";
}

/**
 * Reject graph updates from another run unless an explicit, authoritative run
 * transition is received.  A stale reader can carry `graph.run_created` too,
 * so the event type alone is never enough to switch the displayed run.
 */
export function shouldApplyGroupGraphEvent(
  currentRunId: unknown,
  incomingRunId: unknown,
  options: {
    allowRunSwitch?: boolean;
    eventType?: unknown;
    /** Explicit proof that this event is from the current owner/control action. */
    authoritative?: boolean;
  } = {},
): boolean {
  const current = String(currentRunId || "").trim();
  const incoming = String(incomingRunId || "").trim();
  if (!incoming) return false;
  if (!current || current === incoming) return true;
  return Boolean(
    options.allowRunSwitch &&
      String(options.eventType || "").trim() === "graph.run_created" &&
      options.authoritative === true,
  );
}

/** Return whether a controller still owns the exact session registry key. */
export function ownsForegroundRequestController(
  registry: Record<string, AbortController>,
  sessionId: string,
  controller: AbortController,
): boolean {
  const sid = sessionId.trim();
  return Boolean(sid) && registry[sid] === controller;
}

/** Rekey a live foreground controller only while its old key is still owned. */
export function rekeyForegroundRequestController(
  registry: Record<string, AbortController>,
  currentSessionId: string,
  nextSessionId: string,
  controller: AbortController,
): boolean {
  const current = currentSessionId.trim();
  const next = nextSessionId.trim();
  if (!current || !next || !ownsForegroundRequestController(registry, current, controller)) {
    return false;
  }
  const existing = registry[next];
  if (existing && existing !== controller) return false;
  if (current !== next) {
    delete registry[current];
    registry[next] = controller;
  }
  return true;
}

export type SessionStreamOwnerKind = "foreground" | "reattach";

export type SessionStreamOwner = {
  kind: SessionStreamOwnerKind;
  generation: number;
  controller: AbortController;
};

/**
 * A pane may keep receiving a session's durable stream after navigation, but
 * only the session currently displayed by that exact pane may write transient
 * component UI. Keep this predicate pure so async stream/stop tests can prove
 * the A→B boundary without mounting the whole desktop surface.
 */
export function isPaneDisplayingSession(
  pane: { id?: unknown; sessionId?: unknown } | null | undefined,
  paneId: unknown,
  sessionId: unknown,
): boolean {
  const expectedPaneId = String(paneId ?? "").trim();
  const expectedSessionId = String(sessionId ?? "").trim();
  return Boolean(
    expectedPaneId &&
      expectedSessionId &&
      String(pane?.id ?? "").trim() === expectedPaneId &&
      String(pane?.sessionId ?? "").trim() === expectedSessionId,
  );
}

export type StopRunLease = {
  generation: number;
  paneId: string;
  sessionId: string;
};

/**
 * A stop may settle only for the foreground run epoch it interrupted. Keep
 * this separate from the shared stream generation because reattach readers
 * are allowed to come and go without constituting a new user turn.
 */
export function isForegroundRunGenerationCurrent(
  currentGeneration: unknown,
  expectedGeneration: unknown,
): boolean {
  const current = Number(currentGeneration ?? 0);
  const expected = Number(expectedGeneration ?? 0);
  return Number.isFinite(current) && Number.isFinite(expected) && current === expected && expected >= 0;
}

/**
 * Verify the exact stop request still owns both the session stop slot and the
 * displayed pane. Object identity prevents a late A request from matching a
 * newer stop with the same session id; the pane check prevents A from
 * repainting B after navigation while interrupt/persistence is in flight.
 */
export function ownsStopRunLease(
  currentLease: StopRunLease | null | undefined,
  expectedLease: StopRunLease,
  pane: { id?: unknown; sessionId?: unknown } | null | undefined,
): boolean {
  return Boolean(
    currentLease === expectedLease &&
      Number.isFinite(expectedLease.generation) &&
      expectedLease.generation > 0 &&
      isPaneDisplayingSession(pane, expectedLease.paneId, expectedLease.sessionId),
  );
}

/** Claim the single stream writer slot for a session. */
export function claimSessionStreamOwner(
  owners: Record<string, SessionStreamOwner>,
  generations: Record<string, number>,
  sessionId: unknown,
  kind: SessionStreamOwnerKind,
  controller: AbortController,
): number {
  const sid = String(sessionId ?? "").trim();
  if (!sid) return 0;
  const previous = Number(generations[sid]);
  const generation = (Number.isFinite(previous) && previous > 0 ? Math.floor(previous) : 0) + 1;
  generations[sid] = generation;
  owners[sid] = { kind, generation, controller };
  return generation;
}

/** Verify that a stream callback still owns the session writer slot. */
export function ownsSessionStreamOwner(
  owners: Record<string, SessionStreamOwner>,
  sessionId: unknown,
  kind: SessionStreamOwnerKind,
  generation: number,
  controller: AbortController,
): boolean {
  const sid = String(sessionId ?? "").trim();
  if (!sid || !Number.isFinite(generation) || generation <= 0) return false;
  const owner = owners[sid];
  return Boolean(
    owner &&
      owner.kind === kind &&
      owner.generation === generation &&
      owner.controller === controller,
  );
}

/** Rekey an owned stream when a stale session id is migrated to a new one. */
export function rekeySessionStreamOwner(
  owners: Record<string, SessionStreamOwner>,
  currentSessionId: string,
  nextSessionId: string,
  kind: SessionStreamOwnerKind,
  controller: AbortController,
): boolean {
  const current = currentSessionId.trim();
  const next = nextSessionId.trim();
  if (!current || !next) return false;
  const owner = owners[current];
  if (
    !owner ||
    owner.kind !== kind ||
    owner.controller !== controller
  ) {
    return false;
  }
  const existing = owners[next];
  if (existing && existing !== owner) return false;
  if (current !== next) {
    delete owners[current];
    owners[next] = owner;
  }
  return true;
}

export function ChatPane({
  paneId,
  focused,
  onFocus,
  onOpenConfirm,
  onConfirmRunEnd,
  onOpenClarification,
  onSubmitClarification,
  onToggleGroupReaction,
  integratedToolbar = false,
  sidebarCollapsed = false,
  onToggleSidebar,
}: Props) {
  const pane = useAppStore((s) => s.panes.find((item) => item.id === paneId) ?? FALLBACK_PANE);
  const feedbackSessionId = String(pane.sessionId || "").trim();
  const feedbackApi = useMemo<ChatFeedbackApi | null>(() => resolveChatFeedbackApi(), []);
  const [feedbackState, setFeedbackState] = useState<ChatFeedbackUiState>(() =>
    createChatFeedbackState(feedbackSessionId),
  );
  /** Store credentials form the backend scope for learning mirrors. */
  const feedbackBackendBase = useAppStore((s) => s.apiBase);
  const feedbackBackendToken = useAppStore((s) => s.apiToken);
  const feedbackAccountLoggedIn = useAppStore((s) => s.userAccount.loggedIn);
  /** Complete trusted account stamp rendered by App's account snapshot. */
  const feedbackRenderedScopeId = useAppStore((s) => s.userAccount.feedbackScopeId);
  const feedbackRenderedAuthGeneration = useAppStore(
    (s) => s.userAccount.feedbackAuthGeneration,
  );
  const [feedbackIdentityEpoch, setFeedbackIdentityEpoch] = useState(0);
  /** Read-side lifecycle is visible to the feedback row even when writes are blocked. */
  const [feedbackHydrationStatus, setFeedbackHydrationStatus] = useState<
    "idle" | "loading" | "ready" | "error"
  >("idle");
  const [feedbackHydrationRetryNonce, setFeedbackHydrationRetryNonce] = useState(0);
  /** Stable authenticated account scope captured from the Electron host. */
  const [feedbackScopeId, setFeedbackScopeId] = useState("");
  /** Guards both hydration and writes when this pane changes sessions in place. */
  const feedbackSessionIdRef = useRef(feedbackSessionId);
  const feedbackSessionGenerationRef = useRef(0);
  /** Bumped for an authenticated account or backend transition. */
  const feedbackScopeEpochRef = useRef(0);
  const feedbackIdentityEpochRef = useRef(0);
  const feedbackScopeIdRef = useRef("");
  /** Main-process auth generation captured with the last successful scope read. */
  const feedbackAuthGenerationRef = useRef<number | null>(null);
  /** Blocks rehydration until App has committed the changed account stamp. */
  const feedbackAccountChangingRef = useRef(false);
  const feedbackPendingAccountStampRef = useRef<{
    scopeId: string | null;
    authGeneration: number;
  } | null>(null);
  const feedbackBackendScopeRef = useRef(
    `${String(feedbackBackendBase ?? "").trim()}\u0000${String(feedbackBackendToken ?? "").trim()}`,
  );
  const feedbackRequestSeqRef = useRef<Record<string, number>>({});
  const feedbackStatusTimersRef = useRef<Record<string, number>>({});
  /** Coalesce rapid clicks per message so an older write cannot finish last. */
  const feedbackWriteChainsRef = useRef<Record<string, Promise<void>>>({});
  /** Desired UI value is updated synchronously between React renders. */
  const feedbackDesiredValuesRef = useRef<Record<string, ChatFeedbackValue | null>>({});
  /** Last Enterprise-authoritative value, used for rollback after a failed write. */
  const feedbackCommittedValuesRef = useRef<Record<string, ChatFeedbackValue | null>>({});

  const ensureFeedbackScope = useCallback(() => {
    const config = useAppStore.getState();
    const nextBackendScope =
      `${String(config.apiBase ?? "").trim()}\u0000${String(config.apiToken ?? "").trim()}`;
    if (feedbackBackendScopeRef.current !== nextBackendScope) {
      feedbackBackendScopeRef.current = nextBackendScope;
      feedbackScopeEpochRef.current += 1;
    }
    return feedbackScopeEpochRef.current;
  }, []);

  const retryFeedbackHydration = useCallback(() => {
    setFeedbackHydrationStatus("loading");
    setFeedbackHydrationRetryNonce((current) => current + 1);
  }, []);

  // Capture the immutable account scope from main before hydrating votes.
  // Queued writes carry this scope so a delayed A request cannot be rebound
  // to account B while the renderer is still waiting for its account event.
  useEffect(() => {
    const accountChanging = window.agenticxDesktop?.onUserAccountChanging;
    const accountChanged = window.agenticxDesktop?.onUserAccountChanged;
    const invalidateFeedbackIdentity = () => {
      feedbackAccountChangingRef.current = true;
      feedbackScopeEpochRef.current += 1;
      feedbackIdentityEpochRef.current += 1;
      feedbackAuthGenerationRef.current = null;
      feedbackScopeIdRef.current = "";
      setFeedbackScopeId("");
      const config = useAppStore.getState();
      feedbackBackendScopeRef.current =
        `${String(config.apiBase ?? "").trim()}\u0000${String(config.apiToken ?? "").trim()}`;
      setFeedbackIdentityEpoch((current) => current + 1);
    };
    const offChanging =
      typeof accountChanging === "function"
        ? accountChanging((payload) => {
            const generation = payload?.generation;
            if (typeof generation === "number" && Number.isSafeInteger(generation) && generation >= 0) {
              feedbackPendingAccountStampRef.current = {
                scopeId: null,
                authGeneration: generation,
              };
            } else {
              feedbackPendingAccountStampRef.current = null;
            }
            invalidateFeedbackIdentity();
          })
        : undefined;
    const offChanged =
      typeof accountChanged === "function"
        ? accountChanged((payload) => {
            const stamp = normalizeDesktopFeedbackAccountStamp(
              payload?.scope_id ?? null,
              payload?.auth_generation,
            );
            // Keep the pane blocked until App has written this exact stamp to
            // the account store. Reading a newly committed main config here
            // would let a stale pane pair its old messages with account B.
            feedbackPendingAccountStampRef.current = stamp;
            invalidateFeedbackIdentity();
          })
        : undefined;
    return () => {
      offChanging?.();
      offChanged?.();
    };
  }, []);

  useEffect(() => {
    const pending = feedbackPendingAccountStampRef.current;
    if (!feedbackAccountChangingRef.current || !pending) return;
    if (
      !desktopFeedbackAccountStampsEqual(
        feedbackRenderedScopeId,
        feedbackRenderedAuthGeneration,
        pending.scopeId,
        pending.authGeneration,
      )
    ) {
      return;
    }
    feedbackPendingAccountStampRef.current = null;
    feedbackAccountChangingRef.current = false;
    feedbackScopeEpochRef.current += 1;
    feedbackIdentityEpochRef.current += 1;
    setFeedbackIdentityEpoch((current) => current + 1);
  }, [feedbackIdentityEpoch, feedbackRenderedAuthGeneration, feedbackRenderedScopeId]);

  const feedbackForMessage = useCallback(
    (messageId: string): ChatFeedbackValue | null => {
      return chatFeedbackValueForMessage(feedbackState, feedbackSessionId, messageId);
    },
    [feedbackSessionId, feedbackState],
  );

  const clearFeedbackStatusTimer = useCallback((key: string) => {
    const timer = feedbackStatusTimersRef.current[key];
    if (timer !== undefined) {
      window.clearTimeout(timer);
      delete feedbackStatusTimersRef.current[key];
    }
  }, []);

  /**
   * Hydrate one session and invalidate all transient state when a pane is
   * redirected to another session.  The sequence/session checks deliberately
   * survive a fast A → B → A switch and prevent an old list response from
   * repainting the currently visible conversation.
   */
  useEffect(() => {
    const sessionId = feedbackSessionId;
    const scopeEpoch = ensureFeedbackScope();
    const identityEpoch = feedbackIdentityEpochRef.current;
    const expectedScopeId = feedbackRenderedScopeId;
    const expectedAuthGeneration = feedbackRenderedAuthGeneration;
    feedbackSessionIdRef.current = sessionId;
    feedbackSessionGenerationRef.current += 1;
    feedbackRequestSeqRef.current = {};
    feedbackDesiredValuesRef.current = {};
    feedbackCommittedValuesRef.current = {};
    feedbackScopeIdRef.current = "";
    setFeedbackScopeId("");
    for (const key of Object.keys(feedbackStatusTimersRef.current)) {
      clearFeedbackStatusTimer(key);
    }
    setFeedbackState(createChatFeedbackState(sessionId));
    setFeedbackHydrationStatus("idle");

    if (
      !feedbackApi ||
      !sessionId ||
      feedbackAccountChangingRef.current ||
      !expectedScopeId ||
      expectedAuthGeneration === null
    ) return;
    setFeedbackHydrationStatus("loading");
    let cancelled = false;
    const isCurrentHydration = () =>
      !cancelled &&
      !feedbackAccountChangingRef.current &&
      feedbackRenderedScopeId === expectedScopeId &&
      feedbackRenderedAuthGeneration === expectedAuthGeneration &&
      feedbackIdentityEpochRef.current === identityEpoch &&
      feedbackScopeEpochRef.current === scopeEpoch &&
      feedbackSessionIdRef.current === sessionId;
    const hydrateFeedback = async () => {
      const scopePayload = await feedbackApi.scope({
        expectedScopeId,
        expectedAuthGeneration,
      });
      if (!isCurrentHydration()) return;
      const scopeId = parseChatFeedbackScope(scopePayload);
      if (!scopeId) throw new Error("反馈身份不可用");
      const authGeneration = parseChatFeedbackAuthGeneration(scopePayload);
      if (authGeneration === null) throw new Error("反馈身份不可用");

      // Bind the read as well as writes to the captured scope.  If the host
      // has already switched accounts but its renderer event is delayed, main
      // rejects this stale list instead of hydrating B's votes into A's pane.
      const payload = await feedbackApi.list(sessionId, scopeId);
      if (!isCurrentHydration()) return;
      // A failed list is a failed identity/read handshake. Do not make the
      // captured scope writable or replace the current values with an empty
      // map when main rejected the stale account response.
      assertChatFeedbackOperationOk(payload, "加载反馈失败");
      const values = parseChatFeedbackMap(payload);
      const sessionRequestPrefix = feedbackWritePrefix(scopeEpoch, sessionId);
      const locallyWrittenMessageIds = new Set<string>(
        Object.keys(feedbackRequestSeqRef.current)
          .filter((key) => key.startsWith(sessionRequestPrefix))
          .map((key) => key.slice(sessionRequestPrefix.length)),
      );
      for (const key of Object.keys(feedbackWriteChainsRef.current)) {
        if (key.startsWith(sessionRequestPrefix)) {
          locallyWrittenMessageIds.add(key.slice(sessionRequestPrefix.length));
        }
      }
      for (const [messageId, value] of Object.entries(values)) {
        const requestKey = feedbackWriteKey(scopeEpoch, sessionId, messageId);
        // A slow initial list must not overwrite a click that already owns
        // this message.  The in-flight sequence remains authoritative until
        // its Enterprise write and learning mirror settle.
        if (
          feedbackRequestSeqRef.current[requestKey] ||
          Object.prototype.hasOwnProperty.call(feedbackWriteChainsRef.current, requestKey)
        ) {
          continue;
        }
        feedbackCommittedValuesRef.current[requestKey] = value;
        feedbackDesiredValuesRef.current[requestKey] = value;
      }
      setFeedbackState((previous) => {
        if (previous.sessionId !== sessionId) return previous;
        const nextValues = { ...values };
        for (const messageId of locallyWrittenMessageIds) {
          if (Object.prototype.hasOwnProperty.call(previous.values, messageId)) {
            nextValues[messageId] = previous.values[messageId];
          } else {
            delete nextValues[messageId];
          }
        }
        return { ...previous, values: nextValues };
      });
      // Commit both guards only after the list response passed its own main
      // process checks. A scope response alone is never writable.
      feedbackAuthGenerationRef.current = authGeneration;
      feedbackScopeIdRef.current = scopeId;
      setFeedbackScopeId(scopeId);
      setFeedbackHydrationStatus("ready");
    };
    void hydrateFeedback().catch(() => {
      // Feedback is supplementary to the conversation, but a failed read must
      // remain visible as a disabled row with a safe retry affordance. Never
      // turn an unverified scope into a writable identity.
      if (isCurrentHydration()) {
        feedbackScopeIdRef.current = "";
        setFeedbackScopeId("");
        setFeedbackHydrationStatus("error");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [
    clearFeedbackStatusTimer,
    ensureFeedbackScope,
    feedbackApi,
    feedbackBackendBase,
    feedbackBackendToken,
    feedbackRenderedAuthGeneration,
    feedbackRenderedScopeId,
    feedbackIdentityEpoch,
    feedbackHydrationRetryNonce,
    feedbackSessionId,
  ]);

  useEffect(
    () => () => {
      for (const key of Object.keys(feedbackStatusTimersRef.current)) {
        clearFeedbackStatusTimer(key);
      }
    },
    [clearFeedbackStatusTimer],
  );

  const handleFeedback = useCallback(
    async (
      messageId: string,
      requestedValue: ChatFeedbackValue | null,
      action?: ChatFeedbackAction,
    ) => {
      const sessionId = feedbackSessionId;
      if (!feedbackApi || !sessionId || feedbackSessionIdRef.current !== sessionId) return;
      const expectedScopeId = feedbackScopeIdRef.current;
      if (!expectedScopeId) return;
      const normalizedMessageId = String(messageId || "").trim();
      if (!normalizedMessageId) return;

      const scopeEpoch = ensureFeedbackScope();
      const requestKey = feedbackWriteKey(scopeEpoch, sessionId, normalizedMessageId);
      const hasDesired = Object.prototype.hasOwnProperty.call(
        feedbackDesiredValuesRef.current,
        requestKey,
      );
      const currentDesired = hasDesired
        ? feedbackDesiredValuesRef.current[requestKey] ?? null
        : feedbackForMessage(normalizedMessageId);
      const hasCommitted = Object.prototype.hasOwnProperty.call(
        feedbackCommittedValuesRef.current,
        requestKey,
      );
      const previousCommitted = hasCommitted
        ? feedbackCommittedValuesRef.current[requestKey] ?? null
        : currentDesired;
      if (!hasCommitted) feedbackCommittedValuesRef.current[requestKey] = previousCommitted;
      // The explicit retry action carries its own meaning.  Preserve the
      // already-selected value even if React has not committed the status
      // repaint yet; a retry must never become an accidental cancellation.
      const retryLearning = action?.retryLearning === true;
      const next = retryLearning
        ? currentDesired
        : requestedValue == null
          ? null
          : nextChatFeedbackValue(currentDesired, requestedValue);
      feedbackDesiredValuesRef.current[requestKey] = next;
      const requestSeq = (feedbackRequestSeqRef.current[requestKey] ?? 0) + 1;
      feedbackRequestSeqRef.current[requestKey] = requestSeq;
      clearFeedbackStatusTimer(requestKey);

      setFeedbackState((current) =>
        beginChatFeedbackWrite(current, {
          sessionId,
          messageId: normalizedMessageId,
          value: next,
        }),
      );

      const sessionGeneration = feedbackSessionGenerationRef.current;
      const isCurrentRequest = () =>
        feedbackSessionGenerationRef.current === sessionGeneration &&
        feedbackScopeEpochRef.current === scopeEpoch &&
        feedbackSessionIdRef.current === sessionId &&
        feedbackRequestSeqRef.current[requestKey] === requestSeq;
      const settleState = (updater: (current: ChatFeedbackUiState) => ChatFeedbackUiState) => {
        if (!isCurrentRequest()) return;
        setFeedbackState((current) =>
          current.sessionId === sessionId ? updater(current) : current,
        );
      };

      const runWrite = async () => {
        // A newer click may already have superseded this operation while it
        // waited behind an older request. Let the newest queued write own the
        // durable side effects instead of replaying a stale value.
        if (!isCurrentRequest()) return;
        let enterpriseCommitted = retryLearning;
        try {
          if (!retryLearning) {
            if (next === null) {
              const result = await feedbackApi.clear({
                sessionId,
                messageId: normalizedMessageId,
                expectedScopeId,
              });
              assertChatFeedbackOperationOk(result, "取消反馈失败");
            } else {
              const result = await feedbackApi.set({
                sessionId,
                messageId: normalizedMessageId,
                value: next,
                expectedScopeId,
              });
              assertChatFeedbackOperationOk(result);
            }
            enterpriseCommitted = true;
            // Keep the rollback base accurate even if a newer click supersedes
            // this request before its mirror finishes.
            feedbackCommittedValuesRef.current[requestKey] = next;
          }
          if (!enterpriseCommitted || !isCurrentRequest()) return;
          try {
            await mirrorFeedbackLearning({
              sessionId,
              messageId: normalizedMessageId,
              value: next,
              expectedScopeId,
              // Keep the Studio transport snapshot from the original click;
              // an account/backend transition must not silently retarget an
              // already queued mirror.
              storeBase: feedbackBackendBase,
              apiToken: feedbackBackendToken,
            });
          } catch {
            // Enterprise is authoritative. Keep its value visible while
            // exposing a retry that mirrors the same value (null included)
            // without issuing a second toggle/clear decision.
            settleState((current) =>
              markChatFeedbackLearningError(current, {
                sessionId,
                messageId: normalizedMessageId,
              }),
            );
            return;
          }
          if (!isCurrentRequest()) return;
          feedbackDesiredValuesRef.current[requestKey] = next;
          settleState((current) =>
            completeChatFeedbackWrite(current, {
              sessionId,
              messageId: normalizedMessageId,
              value: next,
            }),
          );
          feedbackStatusTimersRef.current[requestKey] = window.setTimeout(() => {
            delete feedbackStatusTimersRef.current[requestKey];
            settleState((current) => {
              if (current.status[normalizedMessageId] === "learning-error") return current;
              return clearChatFeedbackStatus(current, sessionId, normalizedMessageId);
            });
          }, 2600);
        } catch {
          if (!isCurrentRequest()) return;
          feedbackDesiredValuesRef.current[requestKey] = previousCommitted;
          settleState((current) =>
            failChatFeedbackWrite(current, {
              sessionId,
              messageId: normalizedMessageId,
              previousValue: previousCommitted,
            }),
          );
        }
      };
      const currentWrite = enqueueFeedbackWrite(feedbackWriteChainsRef.current, requestKey, runWrite);
      await currentWrite;
    },
    [
      clearFeedbackStatusTimer,
      ensureFeedbackScope,
      feedbackApi,
      feedbackBackendBase,
      feedbackBackendToken,
      feedbackForMessage,
      feedbackSessionId,
    ],
  );

  const feedbackEnabled = Boolean(
    feedbackApi &&
      feedbackSessionId &&
      feedbackScopeId &&
      !feedbackAccountChangingRef.current &&
      desktopFeedbackAccountStampsEqual(
        feedbackScopeId,
        feedbackAuthGenerationRef.current,
        feedbackRenderedScopeId,
        feedbackRenderedAuthGeneration,
      ),
  );
  const feedbackUnavailableReason = feedbackAccountChangingRef.current
    ? "正在切换账号"
    : !feedbackAccountLoggedIn
        ? "请先登录企业账号"
        : !feedbackApi
          ? "请重启客户端加载反馈组件"
          : !feedbackSessionId
            ? "等待会话"
            : !feedbackRenderedScopeId || feedbackRenderedAuthGeneration === null
              ? "正在加载账号"
              : feedbackHydrationStatus === "loading"
                ? "正在加载反馈"
                : feedbackHydrationStatus === "error"
                  ? "反馈服务暂时不可用，请重试"
                  : "反馈暂不可用";
  const canRetryFeedbackHydration = Boolean(
    feedbackHydrationStatus === "error" &&
      feedbackApi &&
      feedbackAccountLoggedIn &&
      !feedbackAccountChangingRef.current &&
      feedbackRenderedScopeId &&
      feedbackRenderedAuthGeneration !== null,
  );
  const preloadedComposerTaskspaces = useAppStore((s) => {
    const sid = String(pane.sessionId || "").trim();
    return sid ? s.preloadedTaskspacesBySessionId[sid] ?? EMPTY_TASKSPACES : EMPTY_TASKSPACES;
  });
  const paneSortableListeners = usePaneSortableHandle();
  const panes = useAppStore((s) => s.panes);
  const metaLeaderDisplayName = useMemo(() => {
    const mp = panes.find((p) => p.avatarId === null);
    return resolveMetaDisplayName(mp?.avatarName);
  }, [panes]);
  const removePane = useAppStore((s) => s.removePane);
  const closePaneAndCleanupEmptySession = () => {
    void (async () => {
      const sid = String(pane.sessionId ?? "").trim();
      const hasUser = pane.messages.some(
        (m) => m.role === "user" && String(m.content ?? "").trim().length > 0,
      );
      if (sid && !hasUser && typeof window.agenticxDesktop?.deleteSession === "function") {
        try {
          await window.agenticxDesktop.deleteSession(sid);
        } catch {
          /* ignore */
        }
      }
      removePane(pane.id);
    })();
  };
  const addPane = useAppStore((s) => s.addPane);
  const setActivePaneId = useAppStore((s) => s.setActivePaneId);
  const togglePaneHistory = useAppStore((s) => s.togglePaneHistory);
  const cycleSidePanel = useAppStore((s) => s.cycleSidePanel);
  const toggleFocusMode = useAppStore((s) => s.toggleFocusMode);
  const openSidePanel = useAppStore((s) => s.openSidePanel);
  const addPaneTerminalTab = useAppStore((s) => s.addPaneTerminalTab);
  const setActiveTaskspace = useAppStore((s) => s.setActiveTaskspace);
  const setPreloadedTaskspaces = useAppStore((s) => s.setPreloadedTaskspaces);
  const addPaneMessage = useAppStore((s) => s.addPaneMessage);
  const updatePaneMessageByToolCallId = useAppStore((s) => s.updatePaneMessageByToolCallId);
  const updatePaneMessageByGroupMessageId = useAppStore((s) => s.updatePaneMessageByGroupMessageId);
  const updatePaneMessageByClientTurnId = useAppStore((s) => s.updatePaneMessageByClientTurnId);
  const clearPaneMessages = useAppStore((s) => s.clearPaneMessages);
  const setPaneSessionId = useAppStore((s) => s.setPaneSessionId);
  const setPaneSessionMode = useAppStore((s) => s.setPaneSessionMode);
  const setPaneMessages = useAppStore((s) => s.setPaneMessages);
  const prependPaneMessages = useAppStore((s) => s.prependPaneMessages);
  const setPaneMessagePaging = useAppStore((s) => s.setPaneMessagePaging);
  const setPaneLoadingMessages = useAppStore((s) => s.setPaneLoadingMessages);
  const setPaneHistoryJumpMessageId = useAppStore((s) => s.setPaneHistoryJumpMessageId);
  const setPanePendingQuote = useAppStore((s) => s.setPanePendingQuote);
  const setPaneHistorySearchTerms = useAppStore((s) => s.setPaneHistorySearchTerms);
  const setActiveAvatarId = useAppStore((s) => s.setActiveAvatarId);
  const setPaneContextInherited = useAppStore((s) => s.setPaneContextInherited);
  const globalRunMode = useAppStore((s) => s.runMode);
  const sessionRunModes = useAppStore((s) => s.sessionRunModes);
  const pendingSessionRunModesByPane = useAppStore((s) => s.pendingSessionRunModesByPane);
  const setSessionRunMode = useAppStore((s) => s.setSessionRunMode);
  const setPendingSessionRunMode = useAppStore((s) => s.setPendingSessionRunMode);
  const clearPendingSessionRunMode = useAppStore((s) => s.clearPendingSessionRunMode);
  const boundPermissionSessionId = String(pane.sessionId || "").trim();
  const runMode = boundPermissionSessionId
    ? sessionRunModes[boundPermissionSessionId] ?? globalRunMode
    : pendingSessionRunModesByPane[pane.id] ?? globalRunMode;
  const [composerTaskspaces, setComposerTaskspaces] = useState<Taskspace[]>(
    preloadedComposerTaskspaces,
  );
  const [composerAvailableTaskspaces, setComposerAvailableTaskspaces] = useState<Taskspace[]>([]);
  const [composerWorkspaceLoading, setComposerWorkspaceLoading] = useState(false);
  const [composerWorkspaceActionBusy, setComposerWorkspaceActionBusy] = useState(false);
  const [composerWorkspaceError, setComposerWorkspaceError] = useState("");
  const [composerPermissionSaving, setComposerPermissionSaving] = useState(false);
  const [composerPermissionError, setComposerPermissionError] = useState("");
  const composerWorkspaceRequestRef = useRef(0);
  const composerWorkspaceSessionRef = useRef(String(pane.sessionId || "").trim());

  useEffect(() => {
    const nextSessionId = String(pane.sessionId || "").trim();
    const sessionChanged = composerWorkspaceSessionRef.current !== nextSessionId;
    if (sessionChanged) {
      composerWorkspaceSessionRef.current = nextSessionId;
      composerWorkspaceRequestRef.current += 1;
      setComposerWorkspaceLoading(false);
      setComposerWorkspaceActionBusy(false);
    }
    setComposerTaskspaces(preloadedComposerTaskspaces);
    if (sessionChanged) setComposerAvailableTaskspaces([]);
    setComposerWorkspaceError("");
    const activeTaskspaceId = String(
      useAppStore.getState().panes.find((item) => item.id === pane.id)?.activeTaskspaceId ?? "",
    ).trim();
    if (
      activeTaskspaceId &&
      !preloadedComposerTaskspaces.some((item) => item.id === activeTaskspaceId)
    ) {
      setActiveTaskspace(pane.id, null);
    }
  }, [pane.sessionId, preloadedComposerTaskspaces]);
  const toolRoundCount = useMemo(
    () => (pane.messages ?? []).filter((m) => m.role === "tool" && (m.toolName ?? "").trim()).length,
    [pane.messages]
  );
  /** Hide context usage until the user has actually started chatting. */
  const hasStartedChat = useMemo(
    () =>
      (pane.messages ?? []).some(
        (m) => m.role === "user" && String(m.content ?? "").trim().length > 0,
      ),
    [pane.messages],
  );
  const showNewTopicContext = shouldKeepNewTopicWorkspaceControls(
    hasStartedChat,
    pane.loadingMessages === true,
    composerWorkspaceLoading,
  );
  const toolRoundBudget = 60;
  const paneQueuedMessages = useAppStore((s) => s.pendingMessages[paneId] ?? EMPTY_QUEUE);
  const queuedMessages = useMemo(
    () => queuedMessagesForSession(paneQueuedMessages, pane.sessionId),
    [pane.sessionId, paneQueuedMessages],
  );
  const enqueuePaneMessage = useAppStore((s) => s.enqueuePaneMessage);
  const takePendingMessage = useAppStore((s) => s.takePendingMessage);
  const removePendingMessage = useAppStore((s) => s.removePendingMessage);
  const editPendingMessage = useAppStore((s) => s.editPendingMessage);
  const setSpawnsColumnOpen = useAppStore((s) => s.setSpawnsColumnOpen);
  const closeRunDrawer = useAppStore((s) => s.closeRunDrawer);
  const apiBase = useAppStore((s) => s.apiBase);
  const apiToken = useAppStore((s) => s.apiToken);
  const [sessionTurns, setSessionTurns] = useState<SessionTurn[]>([]);
  const [sessionTurnsLoading, setSessionTurnsLoading] = useState(false);
  const [sessionTurnsLoadError, setSessionTurnsLoadError] = useState("");
  const [undoingTurnId, setUndoingTurnId] = useState("");
  const [sessionTurnErrors, setSessionTurnErrors] = useState<Record<string, string>>({});
  const [sessionTurnsRefreshNonce, setSessionTurnsRefreshNonce] = useState(0);
  const [undoConsumedSessionId, setUndoConsumedSessionId] = useState("");
  const sessionTurnsSessionRef = useRef(String(pane.sessionId || "").trim());
  const sessionTurnsFetchSeqRef = useRef(0);

  useEffect(() => {
    const sid = String(pane.sessionId || "").trim();
    sessionTurnsSessionRef.current = sid;
    sessionTurnsFetchSeqRef.current += 1;
    const sequence = sessionTurnsFetchSeqRef.current;
    setSessionTurns([]);
    setSessionTurnsLoading(Boolean(sid && apiBase && apiToken));
    setSessionTurnsLoadError("");
    setSessionTurnErrors({});
    setUndoingTurnId("");
    setUndoConsumedSessionId("");
    if (!sid || !apiBase || !apiToken) return;
    const controller = new AbortController();
    let retryTimer: number | null = null;
    let retryCount = 0;
    const isCurrent = () => {
      const currentPane = useAppStore.getState().panes.find((row) => row.id === pane.id);
      return (
        !controller.signal.aborted &&
        sessionTurnsFetchSeqRef.current === sequence &&
        sessionTurnsSessionRef.current === sid &&
        isPaneDisplayingSession(currentPane, pane.id, sid)
      );
    };
    const loadTurns = () => {
      void fetchSessionTurns({
        sessionId: sid,
        storeBase: apiBase,
        apiToken,
        signal: controller.signal,
      })
        .then((turns) => {
          if (!isCurrent()) return;
          setSessionTurnsLoading(false);
          setSessionTurns(turns);
          const hasFinalizationPending = turns.some((turn) =>
            ["pending", "running", "processing", "streaming", "active", "in_progress"].includes(
              turn.status.trim().toLowerCase(),
            ),
          );
          if (hasFinalizationPending && retryCount < 3) {
            retryCount += 1;
            retryTimer = window.setTimeout(loadTurns, 350 * retryCount);
          }
        })
        .catch((error) => {
          if (!isCurrent()) return;
          setSessionTurnsLoading(false);
          setSessionTurnsLoadError(error instanceof Error ? error.message : "加载轮次变更失败");
        });
    };
    loadTurns();
    return () => {
      controller.abort();
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      setSessionTurnsLoading(false);
    };
  }, [apiBase, apiToken, pane.id, pane.sessionId, sessionTurnsRefreshNonce]);

  // The sidebar may provide an optimistic mode hint, but the session endpoint
  // is the source of truth whenever a pane is bound to a real conversation.
  useEffect(() => {
    const sid = String(pane.sessionId || "").trim();
    const base = String(apiBase || "").replace(/\/+$/, "");
    if (!sid || !base || !apiToken) return;
    let cancelled = false;
    void fetch(`${base}/api/sessions/${encodeURIComponent(sid)}/permissions`, {
      headers: { "x-agx-desktop-token": apiToken },
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as { ok?: boolean; mode?: unknown };
      })
      .then((data) => {
        if (!cancelled && data?.ok) {
          setSessionRunMode(sid, normalizeRunMode(data.mode));
        }
      })
      .catch(() => {
        // Backend remains authoritative; the global/pane fallback only keeps
        // the control usable while an older server is being upgraded.
      });
    return () => {
      cancelled = true;
    };
  }, [apiBase, apiToken, pane.sessionId, setSessionRunMode]);

  const kbGlobalDefaultInit = getCachedGlobalKbRetrievalMode() ?? "auto";
  const kbNewSessionDefaultRef = useRef<KbRetrievalMode>(kbGlobalDefaultInit);
  const [kbGlobalDefaultMode, setKbGlobalDefaultMode] =
    useState<KbRetrievalMode>(kbGlobalDefaultInit);
  const onKbNewSessionDefaultChange = useCallback((mode: KbRetrievalMode) => {
    kbNewSessionDefaultRef.current = mode;
    setKbGlobalDefaultMode(mode);
    setCachedGlobalKbRetrievalMode(mode);
  }, []);

  useEffect(() => {
    if (!LOCAL_KNOWLEDGE_ENABLED) return;
    if (!apiToken) return;
    const resolveBase = async () => {
      const base = String(apiBase ?? "").trim();
      if (base) return base.replace(/\/+$/, "");
      const raw = String((await window.agenticxDesktop.getApiBase()) || "").trim();
      return raw.replace(/\/+$/, "");
    };
    const kbApi = createKbApi(apiToken, resolveBase);
    let cancelled = false;
    void (async () => {
      try {
        const body = await kbApi.readConfig();
        if (cancelled) return;
        const mode = body.config.retrieval?.mode === "always" ? "always" : "auto";
        kbNewSessionDefaultRef.current = mode;
        setKbGlobalDefaultMode(mode);
        setCachedGlobalKbRetrievalMode(mode);
      } catch {
        // keep cached / auto
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [apiBase, apiToken]);
  const storeActiveProvider = useAppStore((s) => s.activeProvider);
  const storeActiveModel = useAppStore((s) => s.activeModel);
  const settings = useAppStore((s) => s.settings);
  const setPaneModel = useAppStore((s) => s.setPaneModel);
  const reconcilePaneModels = useAppStore((s) => s.reconcilePaneModels);
  const setForwardAutoReply = useAppStore((s) => s.setForwardAutoReply);
  const { chatProvider, chatModel } = useMemo(() => {
    const pp = (pane?.modelProvider ?? "").trim();
    const pm = (pane?.modelName ?? "").trim();
    const rawProvider = pp || storeActiveProvider;
    const rawModel = pm || storeActiveModel;
    const coerced = coerceSelectableModel(
      settings.providers,
      rawProvider,
      rawModel,
      rawProvider,
    );
    if (!coerced) return { chatProvider: "", chatModel: "" };
    return { chatProvider: coerced.provider, chatModel: coerced.model };
  }, [pane?.modelProvider, pane?.modelName, storeActiveProvider, storeActiveModel, settings.providers]);

  useEffect(() => {
    const pp = (pane?.modelProvider ?? "").trim();
    const pm = (pane?.modelName ?? "").trim();
    if (!pp || !pm) return;
    if (isModelSelectable(pp, pm, settings.providers)) return;
    reconcilePaneModels();
  }, [pane?.modelProvider, pane?.modelName, settings.providers, reconcilePaneModels]);
  const selectedSubAgent = useAppStore((s) => s.selectedSubAgent);
  const setSelectedSubAgent = useAppStore((s) => s.setSelectedSubAgent);
  const addSubAgent = useAppStore((s) => s.addSubAgent);
  const updateSubAgent = useAppStore((s) => s.updateSubAgent);
  const addSubAgentEvent = useAppStore((s) => s.addSubAgentEvent);
  const subAgents = useAppStore((s) => s.subAgents);
  const avatars = useAppStore((s) => s.avatars);
  const groups = useAppStore((s) => s.groups);
  const metaAvatarUrl = useAppStore((s) => s.metaAvatarUrl);
  const userAvatarUrl = useAppStore((s) => s.userAvatarUrl);
  const chatStyle = useAppStore((s) => s.chatStyle);
  const showToolCalls = useAppStore((s) => s.showToolCalls);
  const userNickname = useAppStore((s) => s.userNickname);
  const userPreference = useAppStore((s) => s.userPreference);
  const attachmentRoutingPolicy =
    useAppStore((s) => s.userAccount.attachmentRouting) ?? ATTACHMENT_ROUTING_OFF;
  const setAttachmentRoutingLock = useAppStore((s) => s.setAttachmentRoutingLock);
  const [routingPromptTarget, setRoutingPromptTarget] = useState<RoutingModelRef | null>(null);
  const routingPromptResolverRef = useRef<
    ((choice: "private" | "public" | "cancel") => void) | null
  >(null);
  const requestAttachmentRoutingChoice = useCallback(
    (target: RoutingModelRef) =>
      new Promise<"private" | "public" | "cancel">((resolve) => {
        routingPromptResolverRef.current?.("cancel");
        routingPromptResolverRef.current = resolve;
        setRoutingPromptTarget(target);
      }),
    [],
  );
  const settleAttachmentRoutingChoice = useCallback(
    (choice: "private" | "public" | "cancel") => {
      const resolve = routingPromptResolverRef.current;
      routingPromptResolverRef.current = null;
      setRoutingPromptTarget(null);
      resolve?.(choice);
    },
    [],
  );
  useEffect(
    () => () => {
      routingPromptResolverRef.current?.("cancel");
      routingPromptResolverRef.current = null;
    },
    [],
  );
  const userBubbleLabel = useMemo(() => userNickname.trim() || "我", [userNickname]);
  const groupChatUserLabel = useMemo(() => userNickname.trim() || "用户", [userNickname]);
  const isGroupPane = Boolean(pane?.avatarId?.startsWith("group:"));
  /** 元智能体窗格：顶栏已展示当前模型，气泡内不再重复展示模型徽章 */
  const isMachiMetaPane = pane.avatarId === null;
  const isAutomationTaskPane = isAutomationPaneAvatarId(pane?.avatarId);
  /** 单聊分身：对话区不展示「厂商/模型」徽章；群聊保留；定时任务不展示（任务本身已绑定模型，避免干扰） */
  const isDedicatedAvatarPane =
    Boolean(pane?.avatarId) && !isGroupPane && !isAutomationTaskPane;
  const showInlineAssistantModelBadge =
    !isMachiMetaPane && !isDedicatedAvatarPane && !isAutomationTaskPane;
  const groupChatId = isGroupPane && pane?.avatarId ? pane.avatarId.slice("group:".length) : "";
  const activeGroup = useMemo(
    () => (isGroupPane ? groups.find((g) => g.id === groupChatId) : undefined),
    [groups, isGroupPane, groupChatId]
  );
  const groupMembers = useMemo(
    () =>
      (activeGroup?.avatarIds ?? [])
        .map((id) => resolveGroupMember(id, avatars, metaAvatarUrl))
        .filter((a): a is Avatar => Boolean(a)),
    [activeGroup, avatars, metaAvatarUrl]
  );
  const groupHost = useMemo(
    () => {
      const hostId = resolveGroupHostAvatarId(
        activeGroup?.avatarIds ?? [],
        activeGroup?.hostAvatarId,
      );
      return groupMembers.find((member) => member.id === hostId);
    },
    [activeGroup?.avatarIds, activeGroup?.hostAvatarId, groupMembers],
  );
  const resolveGroupSender = useCallback(
    (message: Pick<Message, "role" | "avatarName" | "avatarUrl" | "agentId">) =>
      resolveGroupChatSender(message, {
        groupMembers,
        host: groupHost,
        userLabel: groupChatUserLabel,
        userAvatarUrl: userAvatarUrl || "",
      }),
    [groupHost, groupMembers, groupChatUserLabel, userAvatarUrl]
  );
  const workspacePanelOpen = !!pane?.taskspacePanelOpen;
  const [pendingWorkspacePreviewRequest, setPendingWorkspacePreviewRequest] =
    useState<WorkspacePreviewOpenRequest | null>(null);

  const paneAvatarMeta = useMemo(() => {
    const aid = pane?.avatarId;
    if (!aid) {
      // avatarId 为空即为 Near 窗格；勿依赖 avatarName===「Near」才给 meta 头像（飞书绑定曾错误写入「分身」）
      const paneName = (pane?.avatarName ?? "").trim();
      const name = resolveMetaDisplayName(paneName);
      return { name, url: metaAvatarUrl.trim() || DEFAULT_META_AVATAR_URL };
    }
    if (aid.startsWith("group:")) {
      return { name: activeGroup?.name || pane?.avatarName || "群聊", url: undefined };
    }
    const found = avatars.find((a) => a.id === aid);
    return {
      name: found?.name || pane?.avatarName || "AI",
      url: found?.avatarUrl || undefined,
    };
  }, [activeGroup, pane?.avatarId, pane?.avatarName, avatars, metaAvatarUrl]);
  const newTopicLabel = useMemo(
    () => newTopicTriggerLabel({ displayName: paneAvatarMeta.name, isGroup: isGroupPane }),
    [isGroupPane, paneAvatarMeta.name],
  );
  const [composerHasText, setComposerHasText] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [recording, setRecording] = useState(false);
  const [voiceTranscribing, setVoiceTranscribing] = useState(false);
  const [voiceInputHint, setVoiceInputHint] = useState("");
  const dictationSessionRef = useRef<{ stop: () => void; cancel: () => void } | null>(null);
  const [streamedAssistantText, setStreamedAssistantText] = useState("");
  const [streamReferences, setStreamReferences] = useState<SearchReference[]>([]);
  const [streamSearchedQueries, setStreamSearchedQueries] = useState<string[]>([]);
  const [streamingSessionId, setStreamingSessionId] = useState("");
  const [runGuardSessionId, setRunGuardSessionId] = useState("");
  const [streamingModel, setStreamingModel] = useState<{ provider: string; model: string } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const sessionAbortControllersRef = useRef<Record<string, AbortController>>({});
  const sessionStreamStateRef = useRef<
    Record<string, { active: boolean; text: string; provider: string; model: string }>
  >({});
  /**
   * One writer owns a session's live stream state at a time.  A session id is
   * intentionally reusable (barge-in/retry keeps the same id), so the id alone
   * cannot distinguish an old reattach reader from the newer foreground run.
   */
  const sessionStreamOwnersRef = useRef<Record<string, SessionStreamOwner>>({});
  const sessionStreamGenerationsRef = useRef<Record<string, number>>({});
  /** Monotonic foreground-run epoch per session. Unlike the shared stream
   * generation, reattach readers do not advance this value; stop settlement
   * uses it to reject a late result from an older run after a new send. */
  const foregroundStreamGenerationsRef = useRef<Record<string, number>>({});
  const retryInFlightRef = useRef<Record<string, boolean>>({});
  /** Live-reattach (FR-4): per-session abort controllers for read-only reattach streams. */
  const reattachControllersRef = useRef<Record<string, AbortController>>({});
  /** Last hub sequence rendered for each session, shared by foreground and reattach streams. */
  const reattachLastSeqRef = useRef<Record<string, number>>({});
  /** Debounce timers for mid-reattach group disk merges (keyed by session id). */
  const reattachGroupMergeTimersRef = useRef<Record<string, number>>({});
  /**
   * Invalidate a read-only reattach before aborting it. AbortController does
   * not retract a read() that has already resolved, so the lease must be
   * removed first; otherwise a background reattach can still advance seq or
   * clear a newer foreground run while its abort is unwinding.
   */
  const invalidateReattachStreamForSession = useCallback((sessionKey: string) => {
    const key = sessionKey.trim();
    if (!key) return;
    const owner = sessionStreamOwnersRef.current[key];
    const previousReattachController = reattachControllersRef.current[key];
    const hadReattach = owner?.kind === "reattach" || Boolean(previousReattachController);
    if (owner?.kind === "reattach") {
      // Invalidate before aborting so an already-buffered frame fails its
      // exact owner check even if abort delivery is delayed.
      delete sessionStreamOwnersRef.current[key];
    }
    if (previousReattachController) {
      try {
        previousReattachController.abort();
      } catch {
        /* already aborted */
      }
      delete reattachControllersRef.current[key];
    }
    const mergeTimer = reattachGroupMergeTimersRef.current[key];
    if (mergeTimer != null) {
      window.clearTimeout(mergeTimer);
      delete reattachGroupMergeTimersRef.current[key];
    }
    if (hadReattach) {
      const state = sessionStreamStateRef.current[key];
      if (state) state.active = false;
    }
  }, []);
  // Match the backend's product default so an early disconnect can reattach
  // even before the async runtime-config read completes.  An explicit false
  // config still replaces this value as soon as the desktop returns it.
  const liveReattachEnabledRef = useRef(true);
  /** RAF mirror for the currently displayed session's stream overlay only. */
  const streamTextRef = useRef("");
  const streamCommitRegistryRef = useRef(new StreamCommitRegistry());
  const [stallState, setStallState] = useState<"none" | "stall" | "exhausted">("none");
  // Distinguish a stall caused by an actively-running-but-silent turn ("silent")
  // from one where the turn already ENDED without producing a visible reply
  // ("incomplete", e.g. think-only / degenerate). Drives non-misleading copy so
  // an ended-incomplete turn is never shown as "处理中 · 静默 Ns / 长时间无响应".
  const [stallReason, setStallReason] = useState<"silent" | "incomplete">("silent");
  const [stoppingSessionId, setStoppingSessionId] = useState("");
  // The stop indicator is a projection of the displayed pane, not a global
  // operation. Clear an old A indicator as soon as this pane navigates to B;
  // a late A stop finally must not strand the indicator when A is revisited.
  useEffect(() => {
    const displayedSid = String(pane.sessionId || "").trim();
    setStoppingSessionId((current) =>
      current && current !== displayedSid ? "" : current,
    );
  }, [pane.sessionId]);
  const [exhaustedRounds, setExhaustedRounds] = useState<{ rounds: number; maxRounds: number } | null>(null);
  const [sessionExecutionState, setSessionExecutionState] = useState<SessionExecutionState>("idle");
  /** Per-session previous execution_state — keyed by sid so a running session's
   * "running" never leaks onto a sibling and triggers a false「后台任务已完成」. */
  const prevExecutionStateBySidRef = useRef<Record<string, SessionExecutionState>>({});
  const [stallTick, setStallTick] = useState(0);
  const [bgCompleteToast, setBgCompleteToast] = useState(false);
  const [stallHintToast, setStallHintToast] = useState("");
  const [stallRejectReason, setStallRejectReason] = useState("");
  const [resumeInFlight, setResumeInFlight] = useState(false);
  const resumeInFlightRef = useRef<Record<string, boolean>>({});
  /** Monotonic resume action lease per session; late A/B callbacks cannot settle a newer action. */
  const resumeInFlightGenerationRef = useRef<Record<string, number>>({});
  /** Each session owns its own watchdog; resuming B must not cancel a hung A recovery. */
  const resumeInFlightTimersRef = useRef<Record<string, number>>({});
  /** Mirrors stallState so SSE handlers can tell whether a recovery card is visible. */
  const stallStateRef = useRef<"none" | "stall" | "exhausted">("none");
  const [autoNudgeCount, setAutoNudgeCount] = useState(0);
  const autoNudgeTriggeredRef = useRef<Record<string, number>>({});
  const autoNudgeBucketRef = useRef<Record<string, number>>({});
  /** User clicked stop — do not re-show stall card until the next send/continue. */
  const userStoppedSessionRef = useRef<Record<string, boolean>>({});
  const stopInFlightRef = useRef<Record<string, boolean>>({});
  /** Exact stop request leases; late interrupt/finally callbacks must not clear a newer stop. */
  const stopRunGenerationRef = useRef(0);
  const stopRunLeasesRef = useRef<Record<string, StopRunLease>>({});
  const [lastToolProgress, setLastToolProgress] = useState<{ name: string; sec: number } | null>(null);
  const [stallWait, setStallWait] = useState<StallWaitInfo | null>(null);
  const [contextLoopStats, setContextLoopStats] = useState<{
    round: number;
    tool_result_tokens_session: number;
    archived_tool_calls: number;
  } | null>(null);
  const [stallRuntimeConfig, setStallRuntimeConfig] = useState({
    stall_detect_silence_seconds: 90,
    stall_auto_nudge_enabled: false,
    stall_auto_nudge_after_seconds: 120,
    stall_auto_nudge_max_per_session: 2,
  });
  const [unattendedGlobalEnabled, setUnattendedGlobalEnabled] = useState(false);
  const [unattendedMaxContinuations, setUnattendedMaxContinuations] = useState(20);
  const [unattendedStallContinueAfterSeconds, setUnattendedStallContinueAfterSeconds] = useState(120);
  const [unattendedContinueCount, setUnattendedContinueCount] = useState(0);
  const unattendedContinueTriggeredRef = useRef<Record<string, number>>({});
  const unattendedContinueBucketRef = useRef<Record<string, number>>({});
  /** sid → last auto-resumed turn_interrupted message id (truncation/timeout). */
  const truncationAutoResumeNoticeRef = useRef<Record<string, string>>({});
  /** sid → auto-resume count for truncation detectors (cap 2, no unattended needed). */
  const truncationAutoResumeCountRef = useRef<Record<string, number>>({});
  // Tracks the id of the trailing "无人值守已停止" marker we've already reacted to
  // per session, so the auto-disable effect does not fight a later manual re-enable.
  const unattendedAutoStopAckRef = useRef<Record<string, string>>({});
  const [sessionUnattended, setSessionUnattended] = useState(false);
  const [budgetExceededInfo, setBudgetExceededInfo] = useState<BudgetExceededInfo | null>(null);
  const lastSseEventAtRef = useRef(0);
  const lastProgressAtRef = useRef(0);
  /** Per-session SSE progress timestamps — survive pane display switches. */
  const sessionProgressAtRef = useRef<Record<string, number>>({});
  const sessionEnteredAtRef = useRef<Record<string, number>>({});
  /** Last session id whose transient stall detectors were baselined; used to
   * reset the silence clock / stallState only on a real displayed-session
   * switch (not on every effect re-run). */
  const lastStallBaselineSessionRef = useRef<string>("");
  const deferredSessionMessagesRef = useRef<Record<string, Array<Parameters<typeof addPaneMessage>>>>({});
  const lastComposerEnterAtRef = useRef(0);
  const streamRafRef = useRef<number | null>(null);
  const streamRafGenerationRef = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);
  const autoScrollPinnedRef = useRef(true);
  /** >0 while we assign scrollTop; scroll events in that window must not unpin. */
  const programmaticScrollRef = useRef(0);
  const loadingOlderMessagesRef = useRef(false);
  const sessionBootstrapRef = useRef("");
  const freshlyCreatedSessionRef = useRef("");
  const sessionBootstrapInflightRef = useRef("");
  const sessionBootstrapAttemptRef = useRef(0);
  const [sessionBootstrapRetryNonce, setSessionBootstrapRetryNonce] = useState(0);
  const lastUserSendDedupeRef = useRef<SendDedupeEntry | null>(null);
  const sendChatInFlightRef = useRef<{ paneId: string; sessionId: string } | null>(null);
  const [showJumpToBottomFab, setShowJumpToBottomFab] = useState(false);
  const imeComposingRef = useRef(false);
  const atSearchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchAtCandidatesRef = useRef<
    (queryText: string, browseArg?: AtMentionBrowseState | null) => void | Promise<void>
  >(() => {});
  const [atOpen, setAtOpen] = useState(false);
  const [atQuery, setAtQuery] = useState("");
  const [atCandidates, setAtCandidates] = useState<AtCandidate[]>([]);
  /** Non-null while the `@` picker is drilled into a directory. */
  const [atBrowse, setAtBrowse] = useState<AtMentionBrowseState | null>(null);
  const [groupTyping, setGroupTyping] = useState<Record<string, string>>({});
  /** One-line activity hint per group member (tool progress); not a chat message. */
  const [groupActivityHint, setGroupActivityHint] = useState<Record<string, string>>({});
  /** Ephemeral answer text keyed by member; terminal group replies remain the persisted source of truth. */
  const [groupStreamText, setGroupStreamText] = useState<Record<string, string>>({});
  const [groupTeamControlStateBySession, setGroupTeamControlStateBySession] = useState<
    Record<string, GroupTeamControlState>
  >({});
  const groupGraphRunIdBySessionRef = useRef<Record<string, string>>({});
  const groupGraphSessionRef = useRef("");
  const groupTeamControlState = groupTeamControlStateForSession(
    groupTeamControlStateBySession,
    pane.sessionId,
  );
  const groupTeamControlStateBySessionRef = useRef<Record<string, GroupTeamControlState>>({});
  // Run Graph snapshots are session-scoped backend state. Keep this as a
  // secondary source for smart-routing sessions that were restored after the
  // Workforce lifecycle event itself had already passed.
  const groupGraphState = useGraphRunStore(
    (state) => state.byPane[pane.id] ?? EMPTY_PANE_GRAPH_STATE,
  );
  const displayedSessionId = String(pane.sessionId || "").trim();
  const sessionGraphTeamControlState =
    groupGraphSessionRef.current === displayedSessionId
      ? groupTeamControlStateFromGraph(groupGraphState)
      : "idle";
  const effectiveGroupTeamControlState =
    groupTeamControlState !== "idle"
      ? groupTeamControlState
      : sessionGraphTeamControlState;
  const groupTeamPaused = effectiveGroupTeamControlState === "paused";
  const groupTeamActionGenerationRef = useRef(0);
  const groupTeamActionPendingRef = useRef(false);
  const [groupTeamActionPending, setGroupTeamActionPending] = useState(false);
  const setGroupTeamControlStateForSession = useCallback(
    (sessionId: unknown, next: GroupTeamControlState) => {
      const sid = String(sessionId || "").trim();
      if (!sid) return;
      if (groupTeamControlStateBySessionRef.current[sid] === next) return;
      groupTeamControlStateBySessionRef.current = {
        ...groupTeamControlStateBySessionRef.current,
        [sid]: next,
      };
      setGroupTeamControlStateBySession((previous) => {
        if (previous[sid] === next) return previous;
        return { ...previous, [sid]: next };
      });
    },
    [],
  );
  const currentGroupGraphRunId = useCallback(
    (sessionId: unknown): string => {
      const sid = String(sessionId || "").trim();
      if (!sid) return "";
      if (Object.prototype.hasOwnProperty.call(groupGraphRunIdBySessionRef.current, sid)) {
        return groupGraphRunIdBySessionRef.current[sid] || "";
      }
      // Before the first session-scope effect, the persisted pane id is still
      // safe to use for the initially displayed session only.
      if (!groupGraphSessionRef.current) return String(pane.activeGraphRunId || "").trim();
      return "";
    },
    [pane.activeGraphRunId],
  );
  const rememberGroupGraphRunId = useCallback(
    (sessionId: unknown, runId: unknown) => {
      const sid = String(sessionId || "").trim();
      const rid = String(runId || "").trim();
      if (!sid || !rid) return;
      groupGraphRunIdBySessionRef.current[sid] = rid;
      const currentPane = useAppStore.getState().panes.find((row) => row.id === pane.id);
      if ((currentPane?.sessionId || "").trim() !== sid) return;
      useAppStore.setState((state) => ({
        panes: state.panes.map((row) =>
          row.id === pane.id ? { ...row, activeGraphRunId: rid } : row,
        ),
      }));
    },
    [pane.id],
  );
  const acceptsGroupGraphEvent = useCallback(
    (
      sessionId: unknown,
      payload: GraphSsePayload,
      options: { allowRunSwitch?: boolean; authoritative?: boolean } = {},
    ): boolean => {
      const sid = String(sessionId || "").trim();
      if (!sid) return false;
      const incomingRunId = String(payload.run_id || "").trim();
      const accepted = shouldApplyGroupGraphEvent(
        currentGroupGraphRunId(sid),
        incomingRunId,
        { ...options, eventType: payload.type },
      );
      if (accepted && incomingRunId) {
        groupGraphRunIdBySessionRef.current[sid] = incomingRunId;
      }
      return accepted;
    },
    [currentGroupGraphRunId],
  );
  useEffect(() => {
    const sid = String(pane.sessionId || "").trim();
    if (groupGraphSessionRef.current === sid) return;
    const isInitialSession = !groupGraphSessionRef.current;
    groupGraphSessionRef.current = sid;
    groupTeamActionGenerationRef.current += 1;
    // A pending action belongs to the previous session. Release its local
    // disabled state when navigating, while its late finally remains fenced
    // by the incremented generation and cannot clear a newer action.
    groupTeamActionPendingRef.current = false;
    setGroupTeamActionPending(false);
    if (sid && !Object.prototype.hasOwnProperty.call(groupGraphRunIdBySessionRef.current, sid)) {
      groupGraphRunIdBySessionRef.current[sid] = isInitialSession
        ? String(pane.activeGraphRunId || "").trim()
        : "";
    }
    const restoredRunId = sid ? groupGraphRunIdBySessionRef.current[sid] || null : null;
    // Graph state is pane-keyed, so clear the prior session's projection before
    // restoring the selected session's run id. Its panel can reload the snapshot.
    useGraphRunStore.getState().resetPane(pane.id);
    useAppStore.setState((state) => ({
      panes: state.panes.map((row) =>
        row.id === pane.id ? { ...row, activeGraphRunId: restoredRunId } : row,
      ),
    }));
  }, [pane.activeGraphRunId, pane.id, pane.sessionId]);
  const applyGroupTeamControlEvent = useCallback(
    (rawType: unknown, rawData?: Record<string, unknown>, sessionId?: unknown) => {
      const event = normalizeGroupTeamControlEvent(rawType, rawData);
      const targetSessionId = sessionId ?? pane.sessionId;
      if (event === "workforce_started" || event === "workforce_resumed") {
        setGroupTeamControlStateForSession(targetSessionId, "running");
      } else if (event === "workforce_paused") {
        setGroupTeamControlStateForSession(targetSessionId, "paused");
        setStallState("none");
        setStallWait(null);
        setStallRejectReason("");
      } else if (event === "workforce_stopped") {
        setGroupTeamControlStateForSession(targetSessionId, "stopped");
      }
    },
    [pane.sessionId, setGroupTeamControlStateForSession],
  );
  const groupStreamTextRef = useRef<Record<string, string>>({});
  const groupStreamRafRef = useRef<number | null>(null);
  const groupStreamRafGenerationRef = useRef(0);
  /** 显式相位覆盖：group_blocked → "waiting"，group_error → "failed"。 */
  const [groupMemberPhase, setGroupMemberPhase] = useState<Record<string, "waiting" | "failed">>({});
  const clearGroupStreamForAgent = useCallback((agentId: string) => {
    if (agentId in groupStreamTextRef.current) {
      delete groupStreamTextRef.current[agentId];
    }
    setGroupStreamText((previous) => {
      if (!(agentId in previous)) return previous;
      const next = { ...previous };
      delete next[agentId];
      return next;
    });
  }, []);
  const handoffGroupCoordinatorToMember = useCallback((agentId: string) => {
    if (!shouldHandoffGroupCoordinator(agentId)) return;
    setGroupTyping((previous) => withoutGroupAgent(previous, GROUP_COORDINATOR_AGENT_ID));
    setGroupActivityHint((previous) =>
      withoutGroupAgent(previous, GROUP_COORDINATOR_AGENT_ID),
    );
    setGroupMemberPhase((previous) =>
      withoutGroupAgent(previous, GROUP_COORDINATOR_AGENT_ID),
    );
    clearGroupStreamForAgent(GROUP_COORDINATOR_AGENT_ID);
  }, [clearGroupStreamForAgent]);
  const clearGroupMemberStatus = useCallback(
    (agentId: string) => {
      const normalized = String(agentId || "").trim();
      if (!normalized) return;
      clearGroupStreamForAgent(normalized);
      setGroupTyping((previous) => withoutGroupAgent(previous, normalized));
      setGroupActivityHint((previous) => withoutGroupAgent(previous, normalized));
      setGroupMemberPhase((previous) => withoutGroupAgent(previous, normalized));
    },
    [clearGroupStreamForAgent],
  );
  const clearAllGroupMemberStatus = useCallback(() => {
    groupStreamRafGenerationRef.current += 1;
    if (groupStreamRafRef.current != null) {
      window.cancelAnimationFrame(groupStreamRafRef.current);
      groupStreamRafRef.current = null;
    }
    groupStreamTextRef.current = {};
    setGroupStreamText({});
    setGroupTyping({});
    setGroupActivityHint({});
    setGroupMemberPhase({});
  }, []);
  const displayedGroupSessionRef = useRef("");
  useLayoutEffect(() => {
    const nextSessionId = String(pane.sessionId || "").trim();
    const previousSessionId = displayedGroupSessionRef.current;
    if (previousSessionId === nextSessionId) return;
    displayedGroupSessionRef.current = nextSessionId;

    // These member overlays are pane-level UI, not durable per-session state.
    // Clear them in the layout phase so an A→B navigation cannot paint A's
    // typing/progress for one frame while the passive session effect catches up.
    streamRafGenerationRef.current += 1;
    if (streamRafRef.current != null) {
      window.cancelAnimationFrame(streamRafRef.current);
      streamRafRef.current = null;
    }
    clearAllGroupMemberStatus();
    setStreamedAssistantText("");

    // `resumeInFlight` is a pane projection while the guard map is keyed by
    // session. Clear only the visible projection here; leave A's per-session
    // ref/timer alive so a late A continuation cannot race a second A resume
    // after a quick B→A navigation. A late cleanup is still display-fenced.
    setResumeInFlight(false);
  }, [clearAllGroupMemberStatus, pane.sessionId]);
  const applyGroupWorkflowDetailPayload = useCallback(
    (rawData: unknown): boolean => {
      const effect = resolveGroupWorkflowDetailEffect(rawData);
      if (!effect) return false;
      if (effect.kind === "clear_all") {
        clearAllGroupMemberStatus();
        return true;
      }
      if (effect.kind === "clear_member") {
        clearGroupMemberStatus(effect.agentId);
        return true;
      }
      handoffGroupCoordinatorToMember(effect.agentId);
      setGroupTyping((previous) => ({
        ...previous,
        [effect.agentId]: effect.avatarName,
      }));
      setGroupActivityHint((previous) => ({
        ...previous,
        [effect.agentId]: effect.activity,
      }));
      setGroupMemberPhase((previous) => withoutGroupAgent(previous, effect.agentId));
      return true;
    },
    [
      clearAllGroupMemberStatus,
      clearGroupMemberStatus,
      handoffGroupCoordinatorToMember,
    ],
  );
  useEffect(() => () => {
    groupStreamRafGenerationRef.current += 1;
    if (groupStreamRafRef.current != null) {
      window.cancelAnimationFrame(groupStreamRafRef.current);
    }
    for (const timer of Object.values(resumeInFlightTimersRef.current)) {
      window.clearTimeout(timer);
    }
    resumeInFlightTimersRef.current = {};
  }, []);
  const groupActiveAgentIds = useMemo(
    () => Array.from(new Set([...Object.keys(groupTyping), ...Object.keys(groupActivityHint)])),
    [groupTyping, groupActivityHint],
  );
  const applyGroupReactionPayload = useCallback(
    (sessionId: string, rawData: unknown) => {
      if (!rawData || typeof rawData !== "object") return false;
      const data = rawData as Record<string, unknown>;
      const groupMessageId = groupMessageIdFromRecord(data);
      if (!groupMessageId) return false;
      const currentPane = useAppStore.getState().panes.find((row) => row.id === pane.id);
      const current = currentPane?.messages.find(
        (message) => message.groupMessageId === groupMessageId,
      );
      if (!current || !isPublicGroupMessage(current)) return false;
      const updated = applyGroupReactionEvent(current, data, "user");
      return updatePaneMessageByGroupMessageId(
        pane.id,
        groupMessageId,
        updated.reactions,
        sessionId || undefined,
      );
    },
    [pane.id, updatePaneMessageByGroupMessageId],
  );
  const applyGroupUserAcceptedPayload = useCallback(
    (sessionId: string, rawData: unknown) => {
      if (!rawData || typeof rawData !== "object") return false;
      const data = rawData as Record<string, unknown>;
      const clientTurnId = String(data.client_turn_id ?? "").trim();
      const groupMessageId = groupMessageIdFromRecord(data);
      if (!clientTurnId || !groupMessageId) return false;
      return updatePaneMessageByClientTurnId(
        pane.id,
        clientTurnId,
        groupMessageId,
        sessionId || undefined,
      );
    },
    [pane.id, updatePaneMessageByClientTurnId],
  );
  const handleToggleGroupReaction = useCallback(
    async (message: Message, emoji: string) => {
      const groupMessageId = String(message.groupMessageId ?? "").trim();
      if (!groupMessageId || !isPublicGroupMessage(message)) return;
      const actorId = "user";
      const current = useAppStore.getState().panes
        .find((row) => row.id === pane.id)
        ?.messages.find((row) => row.groupMessageId === groupMessageId) ?? message;
      if (!isPublicGroupMessage(current)) return;
      const prior = current.reactions?.find((reaction) => reaction.emoji === emoji);
      const active = !(prior?.active || prior?.actorIds.includes(actorId));
      const optimistic = toggleGroupReaction(current.reactions ?? [], emoji, active, actorId);
      updatePaneMessageByGroupMessageId(
        pane.id,
        groupMessageId,
        optimistic,
        String(pane.sessionId ?? "").trim() || undefined,
      );
      try {
        await onToggleGroupReaction?.(message, emoji);
      } catch {
        // The host callback owns persistence. Roll back an optimistic pill when
        // it explicitly rejects so the UI does not claim a failed reaction.
        updatePaneMessageByGroupMessageId(
          pane.id,
          groupMessageId,
          current.reactions,
          String(pane.sessionId ?? "").trim() || undefined,
        );
      }
    },
    [onToggleGroupReaction, pane.id, pane.sessionId, updatePaneMessageByGroupMessageId],
  );
  const [crewSettingsAvatarId, setCrewSettingsAvatarId] = useState<string | null>(null);
  const lastGroupProgressRef = useRef<Record<string, string>>({});
  type QuoteTarget = { id: string; message: Message; body: string };
  const [quoteTargets, setQuoteTargets] = useState<QuoteTarget[]>([]);
  const quoteTargetsRef = useRef<QuoteTarget[]>([]);
  quoteTargetsRef.current = quoteTargets;
  /** Newly added quote id — insert at caret once (not prepended to composer start). */
  const pendingCaretQuoteIdRef = useRef<string | null>(null);
  const addQuoteTarget = useCallback((message: Message, body: string) => {
    const cleanBody = String(body || "").trim();
    if (!cleanBody) return;
    setQuoteTargets((prev) => {
      if (prev.some((q) => q.message.id === message.id && q.body === cleanBody)) {
        return prev;
      }
      const id = crypto.randomUUID();
      pendingCaretQuoteIdRef.current = id;
      return [...prev, { id, message, body: cleanBody }];
    });
  }, []);
  const clearQuoteTargets = useCallback(() => {
    pendingCaretQuoteIdRef.current = null;
    quoteTargetsRef.current = [];
    setQuoteTargets([]);
  }, []);
  useEffect(() => {
    const pending = pane.pendingQuote;
    if (!pending) return;
    addQuoteTarget(
      {
        id: pending.messageId,
        role: "assistant",
        content: pending.body,
        avatarName: pending.label,
      },
      pending.body
    );
    setPanePendingQuote(pane.id, null);
  }, [pane.pendingQuote, pane.id, setPanePendingQuote, addQuoteTarget]);
  const [selectedMessageIds, setSelectedMessageIds] = useState<Set<string>>(new Set());
  const [forwardPickerOpen, setForwardPickerOpen] = useState(false);
  const [shareMenuOpen, setShareMenuOpen] = useState(false);
  const [shareImageOpen, setShareImageOpen] = useState(false);
  const shareBtnRef = useRef<HTMLButtonElement | null>(null);
  const shareMenuRef = useRef<HTMLDivElement | null>(null);
  const [pendingForwardMessages, setPendingForwardMessages] = useState<ForwardPendingMessage[]>([]);
  const contextFilesRef = useRef<Record<string, AttachedFile>>({});
  const [contextFiles, setContextFilesState] = useState<Record<string, AttachedFile>>({});
  const setContextFiles = useCallback(
    (
      next:
        | Record<string, AttachedFile>
        | ((previous: Record<string, AttachedFile>) => Record<string, AttachedFile>),
    ) => {
      const resolved =
        typeof next === "function" ? next(contextFilesRef.current) : next;
      contextFilesRef.current = resolved;
      setContextFilesState(resolved);
    },
    [],
  );
  const [attachToastOpen, setAttachToastOpen] = useState(false);
  const [attachToastMessage, setAttachToastMessage] = useState(VISION_UNSUPPORTED_TOAST);
  const [visionFallback, setVisionFallback] = useState<VisionFallbackInfo>({ available: false });
  const fallbackHintedRef = useRef<string>("");

  useEffect(() => {
    let cancelled = false;
    void getVisionFallbackInfo({ apiToken })
      .then((info) => {
        if (!cancelled) setVisionFallback(info);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [apiToken, chatProvider, chatModel]);
  const [debateNudgeText, setDebateNudgeText] = useState("");
  const [favoriteToastOpen, setFavoriteToastOpen] = useState(false);
  const [favoriteToastMsg, setFavoriteToastMsg] = useState("");
  const [feishuDesktopBound, setFeishuDesktopBound] = useState(false);
  const boundSessionIdRef = useRef<{ feishu: string; wechat: string }>({ feishu: "", wechat: "" });
  const ccBridgeVisibleLaunchGuardRef = useRef<Map<string, number>>(new Map());
  const ccBridgeTailGuardRef = useRef<Map<string, number>>(new Map());
  /** Last resolved bridge session mode (cc_bridge_start), not global Settings radio. */
  const ccBridgeLastSessionModeRef = useRef<CcBridgeSessionModeHint>("");
  const [wechatDesktopBound, setWechatDesktopBound] = useState(false);
  const [automationTaskErrorHint, setAutomationTaskErrorHint] = useState<string | null>(null);
  const composerRef = useRef<HTMLDivElement | null>(null);
  /** Last caret inside composer — survives blur when quoting from message context menu. */
  const composerSavedRangeRef = useRef<Range | null>(null);
  const composerRefPathsRef = useRef<Record<string, string>>({});
  /** Chip meta available before setContextFiles re-renders (fixes html-element → index.html flash). */
  const composerRefMetaOverrideRef = useRef<
    Record<
      string,
      {
        sourcePath?: string;
        composerRefLabel?: string;
        htmlElementRef?: { tagName: string; selectorHint: string; comment?: string };
      }
    >
  >({});
  const activeDraftIdentityRef = useRef(
    composerDraftIdentity({
      paneId: pane.id,
      avatarId: pane.avatarId,
      sessionId: pane.sessionId,
    }),
  );
  const hydratedDraftIdentityRef = useRef("");
  const draftSaveTimerRef = useRef<number | null>(null);
  const draftHydratingRef = useRef(false);
  const composerDraftTextRef = useRef("");
  const scheduleComposerDraftSaveRef = useRef<() => void>(() => {});
  const flushComposerDraftNowRef = useRef<(identity?: string) => void>(() => {});
  const composerRefTipTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const composerRefTipTargetRef = useRef<HTMLElement | null>(null);
  const [composerRefTip, setComposerRefTip] = useState<{ path: string; x: number; y: number } | null>(null);
  const [composerExpanded, setComposerExpanded] = useState(false);
  useEffect(() => {
    if (!favoriteToastOpen) return;
    const t = window.setTimeout(() => setFavoriteToastOpen(false), 1800);
    return () => window.clearTimeout(t);
  }, [favoriteToastOpen]);
  useEffect(() => {
    if (!shareMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (shareBtnRef.current?.contains(t) || shareMenuRef.current?.contains(t)) return;
      setShareMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setShareMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [shareMenuOpen]);
  useEffect(() => {
    if (selectedMessageIds.size === 0) setShareMenuOpen(false);
  }, [selectedMessageIds.size]);
  useEffect(() => {
    ccBridgeLastSessionModeRef.current = "";
  }, [pane.sessionId]);
  // ChatPane stays mounted across history jumps; mention UI is pane-local and
  // must not ride into the next session.
  useEffect(() => {
    if (atSearchTimerRef.current != null) {
      clearTimeout(atSearchTimerRef.current);
      atSearchTimerRef.current = null;
    }
    setAtOpen(false);
    setAtQuery("");
    setAtCandidates([]);
    setAtBrowse(null);
  }, [pane.sessionId]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [taskspaceAutoRefreshKey, setTaskspaceAutoRefreshKey] = useState(0);
  const [taskspaceWidth, setTaskspaceWidth] = useState(() => {
    try {
      const raw = window.localStorage.getItem(TASKSPACE_WIDTH_STORAGE_KEY);
      const parsed = Number(raw);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    } catch {
      // ignore storage access failures
    }
    return 340;
  });
  const [spawnsWidth, setSpawnsWidth] = useState(() => {
    try {
      const raw = window.localStorage.getItem(SPAWNS_WIDTH_STORAGE_KEY);
      const parsed = Number(raw);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    } catch {
      // ignore storage access failures
    }
    return 300;
  });
  const [runDrawerWidth, setRunDrawerWidth] = useState(() => {
    try {
      const raw = window.localStorage.getItem(RUN_DRAWER_WIDTH_STORAGE_KEY);
      const parsed = Number(raw);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    } catch {
      // ignore storage access failures
    }
    return 360;
  });
  const [historyWidth, setHistoryWidth] = useState(() => {
    try {
      const raw = window.localStorage.getItem("agx-history-width-v1");
      const parsed = Number(raw);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    } catch {
      // ignore
    }
    return 220;
  });
  /** 历史对话按钮 ref + 打开时的锚点位置，用于渲染 workbuddy 风格的浮层（不复用 historyWidth，浮层宽度固定）。 */
  const historyButtonRef = useRef<HTMLButtonElement | null>(null);
  const [historyAnchorRect, setHistoryAnchorRect] = useState<DOMRect | null>(null);
  /** WorkBuddy-style in-session find bar (toolbar magnifier → highlight + N/M nav). */
  const [sessionFindOpen, setSessionFindOpen] = useState(false);
  /** One-shot focus for WorkPanel tabs (summary / workspace / terminal / browser). */
  const [workPanelFocus, setWorkPanelFocus] = useState<WorkPanelFocus>(null);
  /** Trae-style: enlarge work panel to dominate the chat pane (main content). */
  const [workPanelExpanded, setWorkPanelExpanded] = useState(false);
  const [sessionFindQuery, setSessionFindQuery] = useState("");
  const [sessionFindMatchIndex, setSessionFindMatchIndex] = useState(0);
  const [sessionFindMatchCount, setSessionFindMatchCount] = useState(0);
  const sessionFindInputRef = useRef<HTMLInputElement | null>(null);
  const sessionFindActiveIndexRef = useRef(0);
  /** 数字分身窗格顶栏：直接打开分身设置，无需再切到左侧「数字分身」画廊。 */
  const [avatarSettingsOpen, setAvatarSettingsOpen] = useState(false);
  const paneSettingsAvatar = useMemo(() => {
    if (crewSettingsAvatarId) return avatars.find((a) => a.id === crewSettingsAvatarId);
    if (!isDedicatedAvatarPane || !pane?.avatarId) return undefined;
    return avatars.find((a) => a.id === pane.avatarId);
  }, [crewSettingsAvatarId, isDedicatedAvatarPane, pane?.avatarId, avatars]);
  const paneRef = useRef<HTMLDivElement | null>(null);
  const [paneWidth, setPaneWidth] = useState(0);

  // 会话是否有过真实的用户轮——用于抑制「空会话孤立中断占位」。旧数据里可能残留
  // 一条无用户消息的 turn_interrupted（continuation 误触发在新会话上），不应展示为
  // 「恢复执行」卡，须保持「新会话」中性态（对齐后端 append 守卫）。
  const paneHasUserMessage = useMemo(
    () =>
      (pane?.messages ?? []).some(
        (m) => m.role === "user" && String(m.content ?? "").trim().length > 0
      ),
    [pane?.messages]
  );
  const visibleMessages = useMemo(
    () =>
      // Cross-session ownership invariant: never render a row that belongs to a
      // different session, even if a stray write landed in this pane's array
      // during a session switch. Untagged (legacy / in-flight) rows still show.
      visibleMessagesForSession(pane?.messages ?? [], pane?.sessionId).filter((item) => {
        if (isGroupPane) return !isExplicitlyPrivateGroupMessage(item);
        if (item.role === "assistant" && isThinkingPlaceholderText(item.content || "")) return false;
        if (isInterruptedAssistantPlaceholder(item)) return false;
        if (!paneHasUserMessage && isTurnInterruptionNoticeMessage(item)) return false;
        return !item.agentId || item.agentId === "meta";
      }),
    [isGroupPane, paneHasUserMessage, pane?.messages, pane?.sessionId]
  );
  // Render-only list: inline the sub-agent cluster card into the conversation
  // flow (like the clarification card). Kept separate from `visibleMessages` so
  // selection/counts/last-assistant logic never sees the synthetic anchor row.
  const renderMessages = useMemo(
    () => (isGroupPane ? visibleMessages : injectLiveSubAgentClusterAnchors(visibleMessages)),
    [isGroupPane, visibleMessages]
  );
  const groupedVisibleMessages = useMemo(
    () => groupConsecutiveToolMessages(renderMessages),
    [renderMessages]
  );
  const isStreamingCurrentSession =
    streaming &&
    !isGroupPane &&
    !!streamingSessionId &&
    streamingSessionId === (pane.sessionId || "").trim();
  const streamTextForCurrentSession = isStreamingCurrentSession ? (streamedAssistantText || "") : "";
  const streamAssistantMessage = useMemo((): Message => {
    const sid = (pane.sessionId || "").trim();
    return {
      id: "__stream__",
      role: "assistant",
      content: streamTextForCurrentSession,
      ownerSessionId: sid || undefined,
      references: streamReferences.length > 0 ? streamReferences : undefined,
      searchedQueries: streamSearchedQueries.length > 0 ? streamSearchedQueries : undefined,
      provider: streamingModel?.provider,
      model: streamingModel?.model,
    };
  }, [
    pane.sessionId,
    streamTextForCurrentSession,
    streamReferences,
    streamSearchedQueries,
    streamingModel?.provider,
    streamingModel?.model,
  ]);
  /** Hide __stream__ when it duplicates committed text or is an empty mid-turn tool-gap placeholder. */
  const hideStreamOverlayAsDuplicate = useMemo(
    () =>
      shouldHideStreamOverlay(
        isStreamingCurrentSession,
        streamTextForCurrentSession,
        visibleMessages,
      ),
    [isStreamingCurrentSession, streamTextForCurrentSession, visibleMessages],
  );
  const midTurnStreamActivity = shouldShowMidTurnStreamActivity(
    isStreamingCurrentSession,
    hideStreamOverlayAsDuplicate,
  );
  const useReActImLayout = !isGroupPane && chatStyle === "im";
  const visibleMessagesWithStream = useMemo(() => {
    if (useReActImLayout && isStreamingCurrentSession && !hideStreamOverlayAsDuplicate) {
      return [...renderMessages, streamAssistantMessage];
    }
    return renderMessages;
  }, [
    useReActImLayout,
    renderMessages,
    isStreamingCurrentSession,
    hideStreamOverlayAsDuplicate,
    streamAssistantMessage,
  ]);

  const topLevelRowsIm = useMemo(
    () => (useReActImLayout ? expandMessagesToTopLevelRows(visibleMessagesWithStream) : null),
    [useReActImLayout, visibleMessagesWithStream]
  );
  const syncJumpToBottomFab = useCallback(() => {
    const el = listRef.current;
    if (!el) {
      setShowJumpToBottomFab(false);
      return;
    }
    const overflow = el.scrollHeight > el.clientHeight + 4;
    setShowJumpToBottomFab(overflow && !isNearBottom(el));
  }, []);

  const flushJumpToBottomFab = useCallback(() => {
    const el = listRef.current;
    if (!el) {
      setShowJumpToBottomFab(false);
      return;
    }
    if (shouldApplyScrollPinFromEvent(programmaticScrollRef.current > 0)) {
      autoScrollPinnedRef.current = isNearBottom(el);
    }
    syncJumpToBottomFab();
  }, [syncJumpToBottomFab]);

  const scrollListToBottom = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    programmaticScrollRef.current += 1;
    el.scrollTop = el.scrollHeight;
    programmaticScrollRef.current -= 1;
  }, []);

  const pinChatListToLatestTurn = useCallback(() => {
    autoScrollPinnedRef.current = true;
    scrollListToBottom();
    setShowJumpToBottomFab(false);
  }, [scrollListToBottom]);

  /** 灵巧模式退出后主界面 ChatPane remount，`flushJumpToBottomFab` 会在 scrollTop=0 时误判 unpinned；此处强制滚底一次。 */
  const focusExitScrollTarget = useAppStore((s) =>
    s.focusExitScrollBottomPaneId === paneId ? paneId : null
  );
  useLayoutEffect(() => {
    if (!focusExitScrollTarget) return;
    autoScrollPinnedRef.current = true;
    const el = listRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
    useAppStore.getState().clearFocusExitScrollBottomPaneId();
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        autoScrollPinnedRef.current = true;
        const inner = listRef.current;
        if (inner) {
          inner.scrollTop = inner.scrollHeight;
        }
        flushJumpToBottomFab();
      });
    });
  }, [focusExitScrollTarget, flushJumpToBottomFab]);

  useEffect(() => {
    if (!isAutomationTaskPane || !pane?.avatarId?.startsWith("automation:")) {
      setAutomationTaskErrorHint(null);
      return;
    }
    if (visibleMessages.length > 0) {
      setAutomationTaskErrorHint(null);
      return;
    }
    const taskId = pane.avatarId.slice("automation:".length);
    let cancelled = false;
    const loadErr = async () => {
      try {
        const r = await window.agenticxDesktop.loadAutomationTasks();
        if (!r?.ok || cancelled) return;
        const list = Array.isArray(r.tasks) ? (r.tasks as AutomationTask[]) : [];
        const task = list.find((t) => t.id === taskId);
        if (cancelled) return;
        if (task?.lastRunStatus === "error" && task.lastRunError) {
          setAutomationTaskErrorHint(task.lastRunError);
        } else {
          setAutomationTaskErrorHint(null);
        }
      } catch {
        if (!cancelled) setAutomationTaskErrorHint(null);
      }
    };
    void loadErr();
    const timer = window.setInterval(loadErr, 4000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [isAutomationTaskPane, pane?.avatarId, visibleMessages.length]);

  const paneSubAgents = useMemo(() => {
    const sid = (pane?.sessionId ?? "").trim();
    if (!sid) return [];
    return subAgents.filter((item) => (item.sessionId ?? "").trim() === sid);
  }, [pane?.sessionId, subAgents]);

  // Cold-start: rehydrate WorkPanel「子智能体」from persisted subagent_runs after restart.
  useEffect(() => {
    const sid = (pane?.sessionId ?? "").trim();
    if (!sid || !apiBase || !apiToken) return;
    let cancelled = false;
    void hydrateSessionSubAgentsFromDisk(apiBase, apiToken, sid).then((result) => {
      if (cancelled || !result.ok) return;
    });
    return () => {
      cancelled = true;
    };
  }, [pane?.sessionId, apiBase, apiToken]);

  const anchoredSubAgentRunIds = useMemo(() => {
    const ids = new Set<string>();
    for (const msg of pane.messages ?? []) {
      const anchor = msg.subAgentCluster;
      if (!anchor) continue;
      for (const runId of anchor.runIds) {
        const rid = String(runId ?? "").trim();
        if (rid) ids.add(rid);
      }
    }
    return Array.from(ids);
  }, [pane.messages]);
  const drawerLiveSubAgent = useMemo(() => {
    const rid = String(pane.runDrawerRunId ?? "").trim();
    if (!rid) return undefined;
    return paneSubAgents.find((s) => s.id === rid);
  }, [pane.runDrawerRunId, paneSubAgents]);
  const primaryPaneForSessionId = useMemo(() => {
    const sid = (pane?.sessionId ?? "").trim();
    if (!sid) return null;
    return panes.find((p) => p.sessionId === sid)?.id ?? null;
  }, [panes, pane?.sessionId]);
  const shouldShowBoundFeishuBadge =
    feishuDesktopBound && primaryPaneForSessionId === pane.id && !isAutomationTaskPane;
  const shouldShowFeishuBadge = shouldShowBoundFeishuBadge;
  const shouldShowWechatBadge =
    wechatDesktopBound && primaryPaneForSessionId === pane.id && !isAutomationTaskPane;

  // 集群卡改为内联在对话流展示（对齐 Kimi Work / 澄清卡片语义），Spawns 列不再
  // 随派生自动弹出——仅作为可选的成员控制/明细面板，由工具栏按钮手动开启；这里
  // 只在没有子智能体时收起已开的列，保持整洁。
  useEffect(() => {
    if (paneSubAgents.length === 0 && pane.spawnsColumnOpen) {
      setSpawnsColumnOpen(pane.id, false);
    }
  }, [pane.id, pane.spawnsColumnOpen, paneSubAgents.length, setSpawnsColumnOpen]);
  const attachmentEntries = useMemo(() => Object.entries(contextFiles), [contextFiles]);
  const pendingAttachmentRoutingTarget = useMemo(() => {
    const target = attachmentRoutingPolicy.documentTarget;
    if (!target) return null;
    return hasRoutedDocument(
      attachmentEntries.map(([, file]) => file.name),
      attachmentRoutingPolicy,
    )
      ? target
      : null;
  }, [attachmentEntries, attachmentRoutingPolicy]);
  const activeAttachmentRoutingLock = useAppStore((state) => {
    const sessionId = String(pane?.sessionId ?? "").trim();
    return sessionId ? state.attachmentRoutingLocks[sessionId] ?? null : null;
  });
  const activeModelUsesPublicRoute = useMemo(() => {
    if (chatProvider !== "enterprise") return false;
    const catalog = settings.providers[chatProvider]?.modelCatalog ?? [];
    return catalog.some(
      (item) => item.id === chatModel && item.route === "third-party",
    );
  }, [chatModel, chatProvider, settings.providers]);
  const canChoosePublicAttachmentRoute =
    attachmentRoutingPolicy.allowPublicOverride && activeModelUsesPublicRoute;
  useEffect(() => {
    if (
      !pendingAttachmentRoutingTarget ||
      canChoosePublicAttachmentRoute
    ) {
      return;
    }
    const addressed = addressForSession(
      { provider: chatProvider },
      pendingAttachmentRoutingTarget,
    );
    if (chatProvider === addressed.provider && chatModel === addressed.model) return;
    setPaneModel(pane.id, addressed.provider, addressed.model);
  }, [
    canChoosePublicAttachmentRoute,
    chatModel,
    chatProvider,
    pane.id,
    pendingAttachmentRoutingTarget,
    setPaneModel,
  ]);
  const visibleAttachmentEntries = useMemo(
    () => attachmentEntries.filter(([, file]) => !file.referenceToken),
    [attachmentEntries]
  );
  const readyAttachments = useMemo(
    () => attachmentEntries.filter(([, file]) => file.status === "ready").map(([, file]) => ({ ...file })),
    [attachmentEntries]
  );

  const hasDelegation = useMemo(() => {
    const fromPaneSubs = paneSubAgents.some(
      (sub) =>
        (sub.status === "running" || sub.status === "pending") &&
        (sub.id.startsWith("dlg-") || sub.events?.some((evt) => evt.type.startsWith("delegation")))
    );
    if (fromPaneSubs) return true;
    const paneName = (pane?.avatarName ?? "").trim().toLowerCase();
    if (!paneName) return false;
    return subAgents.some(
      (sub) =>
        (sub.status === "running" || sub.status === "pending") &&
        sub.id.startsWith("dlg-") &&
        (sub.name ?? "").trim().toLowerCase() === paneName
    );
  }, [paneSubAgents, subAgents, pane?.avatarName]);

  const lastPollCountRef = useRef(0);
  const pollSessionSidRef = useRef<string>("");

  useEffect(() => {
    if (!pane?.sessionId) return;
    const sidNow = pane.sessionId;
    if (sidNow !== pollSessionSidRef.current) {
      pollSessionSidRef.current = sidNow;
      lastPollCountRef.current = 0;
    }
    let active = true;
    let timer: number | undefined;

    const isFeishuBoundSession = async (sid: string): Promise<boolean> => {
      try {
        const r = await window.agenticxDesktop.loadFeishuBinding();
        if (!r.ok) return false;
        const desk = r.bindings["_desktop"] as { session_id?: string } | undefined;
        return Boolean(desk && desk.session_id === sid);
      } catch {
        return false;
      }
    };

    const isWechatBoundSession = async (sid: string): Promise<boolean> => {
      try {
        const r = await window.agenticxDesktop.loadWechatBinding();
        if (!r.ok) return false;
        const desk = r.bindings["_desktop"] as { session_id?: string } | undefined;
        return Boolean(desk && desk.session_id === sid);
      } catch {
        return false;
      }
    };

    const poll = async () => {
      if (!active) return;
      const currentSid = pane.sessionId;
      if (!currentSid) return;
      // Never overwrite in-memory state while a foreground SSE stream is live —
      // that stream is the single source of truth and disk lags behind.
      if (sessionStreamStateRef.current[currentSid]?.active) return;
      const otherPaneHasSameSid = panes.some(
        (p) => p.id !== pane.id && p.sessionId === currentSid
      );
      if (otherPaneHasSameSid) {
        console.warn("[ChatPane] poll skipped — session %s is shared with another pane", currentSid);
        return;
      }
      try {
        const result = await window.agenticxDesktop.loadSessionMessages(currentSid);
        if (!active) return;
        // Session may have changed while the load was in flight (e.g. user
        // clicked "新对话" mid-poll). Never overwrite the new session's pane
        // with messages from the previous session.
        const latestSid = String(
          useAppStore.getState().panes.find((p) => p.id === pane.id)?.sessionId ?? ""
        ).trim();
        if (latestSid !== currentSid) return;
        if (result.ok && Array.isArray(result.messages) && result.messages.length > 0) {
          if (result.messages.length <= lastPollCountRef.current) return;
          lastPollCountRef.current = result.messages.length;
          // 增量合并而非整表替换：mergeSessionMessagesTail 以 sid 为 id 前缀并
          // 复用内存行 id，已有气泡的 React key 稳定，不会整列表重挂载闪烁。
          const livePane = useAppStore.getState().panes.find((p) => p.id === pane.id);
          const current = livePane?.messages ?? [];
          const merged = mergeSessionMessagesTail(
            current,
            result.messages as LoadedSessionMessage[],
            currentSid
          );
          const changed =
            merged.length !== current.length ||
            String(merged[merged.length - 1]?.content ?? "") !==
              String(current[current.length - 1]?.content ?? "");
          if (!changed) return;
          setPaneMessages(pane.id, merged);
          // 全量合并后内存已覆盖完整磁盘历史，复位分页游标，避免顶部
          // 「加载更早消息」按旧 oldestLoadedIndex 拉取与内存同 id 的行。
          if (livePane?.hasOlderMessages || (livePane?.oldestLoadedIndex ?? 0) > 0) {
            setPaneMessagePaging(pane.id, {
              oldestLoadedIndex: 0,
              hasOlderMessages: false,
              loadingOlderMessages: false,
            });
          }
        }
      } catch {
        // ignore polling failures
      }
    };

    const setup = async () => {
      if (!active) return;
      const sid = pane.sessionId;
      if (!sid) return;
      const isImSession = sid.startsWith("im-");
      const isFeishuBound = await isFeishuBoundSession(sid);
      const isWechatBound = await isWechatBoundSession(sid);
      if (!active) return;
      const needsExternalPoll = isImSession || isFeishuBound || isWechatBound;
      // Re-read messages length from the store after the async awaits above —
      // the closure snapshot can be stale if addPaneMessage fired in the interim,
      // causing a spurious poll() that duplicates the optimistic user row.
      const freshMsgCount =
        useAppStore.getState().panes.find((p) => p.id === pane.id)?.messages?.length ?? 0;
      if (!hasDelegation && !needsExternalPoll && freshMsgCount > 0) return;
      void poll();
      if (!hasDelegation && !needsExternalPoll) return;
      timer = window.setInterval(() => void poll(), 3000);
    };

    void setup();
    return () => {
      active = false;
      if (timer != null) window.clearInterval(timer);
    };
  }, [
    hasDelegation,
    feishuDesktopBound,
    wechatDesktopBound,
    pane?.sessionId,
    pane?.id,
    pane?.messages?.length,
    panes,
    setPaneMessages,
    setPaneMessagePaging,
  ]);

  useEffect(() => {
    if (isGroupPane || !pane?.sessionId || isAutomationTaskPane) {
      boundSessionIdRef.current.feishu = "";
      boundSessionIdRef.current.wechat = "";
      setFeishuDesktopBound(false);
      setWechatDesktopBound(false);
      return;
    }
    let cancelled = false;
    const sid = pane.sessionId;

    const checkBound = async () => {
      if (cancelled) return;
      try {
        const r = await window.agenticxDesktop.loadFeishuBinding();
        if (cancelled) return;
        if (r.ok) {
          const desk = r.bindings["_desktop"] as { session_id?: string } | undefined;
          const boundSid = typeof desk?.session_id === "string" ? desk.session_id.trim() : "";
          boundSessionIdRef.current.feishu = boundSid;
          setFeishuDesktopBound(
            Boolean(boundSid && boundSid === sid)
          );
        } else {
          boundSessionIdRef.current.feishu = "";
          setFeishuDesktopBound(false);
        }
      } catch {
        if (!cancelled) {
          boundSessionIdRef.current.feishu = "";
          setFeishuDesktopBound(false);
        }
      }
      try {
        const rw = await window.agenticxDesktop.loadWechatBinding();
        if (cancelled) return;
        if (rw.ok) {
          const deskW = rw.bindings["_desktop"] as { session_id?: string } | undefined;
          const boundSidW = typeof deskW?.session_id === "string" ? deskW.session_id.trim() : "";
          boundSessionIdRef.current.wechat = boundSidW;
          setWechatDesktopBound(
            Boolean(boundSidW && boundSidW === sid)
          );
        } else if (!cancelled) {
          boundSessionIdRef.current.wechat = "";
          setWechatDesktopBound(false);
        }
      } catch {
        boundSessionIdRef.current.wechat = "";
        if (!cancelled) setWechatDesktopBound(false);
      }
    };

    void checkBound();
    const timer = window.setInterval(() => void checkBound(), 3000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [isGroupPane, isAutomationTaskPane, pane?.sessionId]);

  const bindingModelSyncRef = useRef<{ feishu: string; wechat: string }>({ feishu: "", wechat: "" });
  useEffect(() => {
    if (isGroupPane || isAutomationTaskPane || !pane?.sessionId) return;
    const currentSid = (pane.sessionId || "").trim();
    const provider = (pane.modelProvider || "").trim();
    const model = (pane.modelName || "").trim();
    const signature = `${pane.sessionId}::${provider}::${model}`;
    const aid = pane.avatarId?.startsWith("group:") ? null : pane.avatarId || null;
    const isFeishuBoundToCurrentSession =
      feishuDesktopBound && boundSessionIdRef.current.feishu === currentSid;
    if (isFeishuBoundToCurrentSession && bindingModelSyncRef.current.feishu !== signature) {
      bindingModelSyncRef.current.feishu = signature;
      void window.agenticxDesktop.saveFeishuDesktopBinding({
        sessionId: pane.sessionId,
        avatarId: aid,
        avatarName: pane.avatarName || null,
        provider: provider || null,
        model: model || null,
      });
    }
    const isWechatBoundToCurrentSession =
      wechatDesktopBound && boundSessionIdRef.current.wechat === currentSid;
    if (isWechatBoundToCurrentSession && bindingModelSyncRef.current.wechat !== signature) {
      bindingModelSyncRef.current.wechat = signature;
      void window.agenticxDesktop.saveWechatDesktopBinding({
        sessionId: pane.sessionId,
        avatarId: aid,
        avatarName: pane.avatarName || null,
        provider: provider || null,
        model: model || null,
      });
    }
    if (!feishuDesktopBound) bindingModelSyncRef.current.feishu = "";
    if (!wechatDesktopBound) bindingModelSyncRef.current.wechat = "";
  }, [
    feishuDesktopBound,
    wechatDesktopBound,
    isAutomationTaskPane,
    isGroupPane,
    pane?.sessionId,
    pane?.avatarId,
    pane?.avatarName,
    pane?.modelProvider,
    pane?.modelName,
  ]);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    // User scroll may unpin. Content-height resize must not unpin; if still
    // pinned, keep the latest turn in view as bubbles/stream grow.
    const onScroll = () => flushJumpToBottomFab();
    const onResize = () => {
      if (autoScrollPinnedRef.current) {
        scrollListToBottom();
      }
      syncJumpToBottomFab();
    };
    flushJumpToBottomFab();
    el.addEventListener("scroll", onScroll, { passive: true });
    const ro = new ResizeObserver(onResize);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", onScroll);
      ro.disconnect();
    };
  }, [paneId, flushJumpToBottomFab, syncJumpToBottomFab, scrollListToBottom]);

  useLayoutEffect(() => {
    if (autoScrollPinnedRef.current) {
      scrollListToBottom();
      // Second frame: markdown/images can grow after the first commit.
      requestAnimationFrame(() => {
        if (autoScrollPinnedRef.current) {
          scrollListToBottom();
        }
        syncJumpToBottomFab();
      });
      return;
    }
    // FAB only — do not recompute pin here. Layout is often still short of the
    // true bottom when a new user bubble mounts, and that used to unpin us.
    syncJumpToBottomFab();
  }, [visibleMessages, streamedAssistantText, scrollListToBottom, syncJumpToBottomFab]);

  const highlightJumpKeyRef = useRef<string>("");
  useEffect(() => {
    // In-session find bar owns scroll/highlight navigation while open.
    if (sessionFindOpen) return;
    const terms = (pane.historySearchTerms ?? []).filter((t) => String(t || "").trim().length > 0);
    if (!pane.sessionId || terms.length === 0) {
      highlightJumpKeyRef.current = "";
      return;
    }
    const key = `${pane.sessionId}::${terms.join("|")}::${visibleMessages.length}`;
    if (highlightJumpKeyRef.current === key) return;
    let cancelled = false;
    const run = (attempt = 0) => {
      if (cancelled) return;
      const root = listRef.current;
      if (!root) return;
      const first = root.querySelector(".agx-keyword-highlight") as HTMLElement | null;
      if (first) {
        highlightJumpKeyRef.current = key;
        first.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
        return;
      }
      if (attempt < 3) {
        window.setTimeout(() => run(attempt + 1), 90);
      }
    };
    requestAnimationFrame(() => {
      window.setTimeout(() => run(0), 20);
    });
    return () => {
      cancelled = true;
    };
  }, [pane.sessionId, pane.historySearchTerms, visibleMessages.length, sessionFindOpen]);

  const closeSessionFind = useCallback(() => {
    const hadQuery = sessionFindQuery.trim().length > 0;
    setSessionFindOpen(false);
    setSessionFindQuery("");
    setSessionFindMatchIndex(0);
    setSessionFindMatchCount(0);
    sessionFindActiveIndexRef.current = 0;
    clearSessionFindHighlights();
    // Only clear highlight terms if this find bar had driven them (preserve global-search jump).
    if (hadQuery) setPaneHistorySearchTerms(paneId, []);
  }, [paneId, sessionFindQuery, setPaneHistorySearchTerms]);

  const openSessionFind = useCallback(() => {
    setSessionFindOpen(true);
    window.setTimeout(() => sessionFindInputRef.current?.focus(), 40);
  }, []);

  const stepSessionFindMatch = useCallback(
    (delta: number) => {
      if (sessionFindMatchCount <= 0) return;
      const next =
        (sessionFindMatchIndex + delta + sessionFindMatchCount) % sessionFindMatchCount;
      sessionFindActiveIndexRef.current = next;
      setSessionFindMatchIndex(next);
      const applied = applySessionFindHighlights(
        listRef.current,
        sessionFindQuery,
        next
      );
      if (applied.count !== sessionFindMatchCount) {
        setSessionFindMatchCount(applied.count);
        setSessionFindMatchIndex(applied.activeIndex);
        sessionFindActiveIndexRef.current = applied.activeIndex;
      }
    },
    [sessionFindMatchCount, sessionFindMatchIndex, sessionFindQuery]
  );

  // Apply mint highlights + expand matching tool cards when the find query changes.
  useEffect(() => {
    if (!sessionFindOpen) {
      clearSessionFindHighlights();
      return;
    }
    const q = sessionFindQuery.trim();
    if (!q) {
      clearSessionFindHighlights();
      setSessionFindMatchCount(0);
      setSessionFindMatchIndex(0);
      sessionFindActiveIndexRef.current = 0;
      return;
    }
    setPaneHistorySearchTerms(paneId, [q]);
    let cancelled = false;
    const run = () => {
      if (cancelled) return;
      const applied = applySessionFindHighlights(
        listRef.current,
        q,
        sessionFindActiveIndexRef.current
      );
      setSessionFindMatchCount(applied.count);
      setSessionFindMatchIndex(applied.activeIndex);
      sessionFindActiveIndexRef.current = applied.activeIndex;
    };
    // Wait a frame so tool cards can expand (historySearchTerms) before ranging text.
    const t = window.setTimeout(() => requestAnimationFrame(run), 40);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [
    sessionFindOpen,
    sessionFindQuery,
    visibleMessages.length,
    streamedAssistantText,
    paneId,
    setPaneHistorySearchTerms,
  ]);

  // ⌘F / Ctrl+F opens in-session find when this pane is active; Esc closes the bar.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const isFindChord =
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === "f";
      if (isFindChord) {
        const activePaneId = useAppStore.getState().activePaneId;
        if (activePaneId !== paneId) return;
        const target = event.target as HTMLElement | null;
        // Allow native find inside true text fields outside the chat pane.
        if (
          target &&
          !paneRef.current?.contains(target) &&
          (target.tagName === "INPUT" ||
            target.tagName === "TEXTAREA" ||
            target.isContentEditable)
        ) {
          return;
        }
        event.preventDefault();
        if (sessionFindOpen) {
          sessionFindInputRef.current?.focus();
          sessionFindInputRef.current?.select();
        } else {
          openSessionFind();
        }
        return;
      }
      if (event.key === "Escape" && sessionFindOpen) {
        const activePaneId = useAppStore.getState().activePaneId;
        if (activePaneId !== paneId) return;
        event.preventDefault();
        closeSessionFind();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [paneId, sessionFindOpen, openSessionFind, closeSessionFind]);

  useEffect(() => {
    return () => {
      clearSessionFindHighlights();
    };
  }, []);

  /** Scroll + flash when history panel jumps to a user query in this session. */
  const historyJumpInFlightRef = useRef<string>("");
  useEffect(() => {
    const targetId = String(pane.historyJumpMessageId ?? "").trim();
    if (!targetId || !pane.sessionId) {
      historyJumpInFlightRef.current = "";
      return;
    }
    const jumpKey = `${pane.sessionId}::${targetId}`;
    if (historyJumpInFlightRef.current === jumpKey) return;
    historyJumpInFlightRef.current = jumpKey;
    let cancelled = false;

    const flashAndClear = (el: HTMLElement) => {
      el.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
      // Keep unpinned so the follow-up stream/auto-scroll effect does not yank us back.
      autoScrollPinnedRef.current = false;
      el.classList.remove("agx-message-jump-flash");
      // Force reflow so re-triggering the same class still animates.
      void el.offsetWidth;
      el.classList.add("agx-message-jump-flash");
      window.setTimeout(() => {
        el.classList.remove("agx-message-jump-flash");
      }, 1300);
      setPaneHistoryJumpMessageId(paneId, null);
      // Allow jumping to the same message id again later.
      historyJumpInFlightRef.current = "";
      window.setTimeout(() => {
        autoScrollPinnedRef.current = false;
        flushJumpToBottomFab();
        autoScrollPinnedRef.current = false;
      }, 350);
    };

    const ensureLoadedThenScroll = async () => {
      const findEl = () =>
        listRef.current?.querySelector(
          `[data-message-id="${CSS.escape(targetId)}"]`
        ) as HTMLElement | null;

      let el = findEl();
      if (!el && pane.hasOlderMessages) {
        try {
          const full = await window.agenticxDesktop.loadSessionMessages(pane.sessionId);
          if (cancelled) return;
          if (full.ok && Array.isArray(full.messages)) {
            const sid = pane.sessionId;
            const mapped = full.messages.map((item, index) =>
              mapLoadedSessionMessage(item as LoadedSessionMessage, sid, index, sid)
            );
            setPaneMessages(paneId, mapped);
            setPaneMessagePaging(paneId, {
              oldestLoadedIndex: 0,
              hasOlderMessages: false,
              loadingOlderMessages: false,
            });
          }
        } catch {
          /* fall through to retry DOM query */
        }
      }

      const run = (attempt = 0) => {
        if (cancelled) return;
        el = findEl();
        if (el) {
          flashAndClear(el);
          return;
        }
        if (attempt < 8) {
          window.setTimeout(() => run(attempt + 1), 60);
          return;
        }
        setPaneHistoryJumpMessageId(paneId, null);
      };
      requestAnimationFrame(() => {
        window.setTimeout(() => run(0), 20);
      });
    };

    void ensureLoadedThenScroll();
    return () => {
      cancelled = true;
    };
  }, [
    pane.historyJumpMessageId,
    pane.sessionId,
    pane.hasOlderMessages,
    paneId,
    setPaneHistoryJumpMessageId,
    setPaneMessages,
    setPaneMessagePaging,
    flushJumpToBottomFab,
  ]);

  useEffect(() => {
    return () => {
      dictationSessionRef.current?.cancel();
      dictationSessionRef.current = null;
      cancelDictation();
    };
  }, []);

  useEffect(() => {
    if (!paneRef.current) return;
    const target = paneRef.current;
    const update = () => setPaneWidth(target.clientWidth);
    const { schedule, cancel } = createResizeRafScheduler(update);
    update();
    const observer = new ResizeObserver(schedule);
    observer.observe(target);
    return () => {
      cancel();
      observer.disconnect();
    };
  }, []);

  const openDelegatedAvatarSession = async (agentId: string): Promise<boolean> => {
    const sub = useAppStore.getState().subAgents.find((item) => item.id === agentId);
    const targetSessionId = (sub?.sessionId ?? "").trim();
    if (!targetSessionId) return false;

    const targetName = String(sub?.name ?? "").trim();
    const existingPane = panes.find((item) => {
      if (!item.avatarId || item.avatarId.startsWith("group:")) return false;
      const found = avatars.find((avatar) => avatar.id === item.avatarId);
      return !!found && found.name === targetName;
    });
    const targetPaneId = existingPane?.id ?? addPane(null, targetName || "Avatar", targetSessionId);
    setPaneSessionId(targetPaneId, targetSessionId);
    setActivePaneId(targetPaneId);
    setSelectedSubAgent(null);

    try {
      const result = await window.agenticxDesktop.loadSessionMessages(targetSessionId);
      if (result.ok && Array.isArray(result.messages)) {
        const mapped: Message[] = result.messages.map((item, index) =>
          mapLoadedSessionMessage(item as LoadedSessionMessage, targetSessionId, index)
        );
        setPaneMessages(targetPaneId, mapped);
      } else {
        setPaneMessages(targetPaneId, []);
      }
    } catch {
      setPaneMessages(targetPaneId, []);
    }
    return true;
  };

  const cancelStreamRenderFrame = () => {
    // Bump both leases even when the browser callback is already queued. A
    // stale A callback must not clear or paint a newer B callback after the
    // pane has switched sessions.
    streamRafGenerationRef.current += 1;
    groupStreamRafGenerationRef.current += 1;
    if (streamRafRef.current !== null) {
      window.cancelAnimationFrame(streamRafRef.current);
      streamRafRef.current = null;
    }
    if (groupStreamRafRef.current !== null) {
      window.cancelAnimationFrame(groupStreamRafRef.current);
      groupStreamRafRef.current = null;
    }
  };

  /** Studio taskspace APIs require an existing session_id; lazy new-topic clears pane.sessionId until first send.
   * For read-only browsing (e.g. `@` mentions, file preview), fall back to the most recently
   * remembered session for this avatar so the user can still browse the same content the
   * WorkspacePanel keeps showing while awaiting a fresh session. */
  const resolveTaskspaceApiSessionId = (): string => {
    const sid = (pane.sessionId || "").trim();
    if (sid) return sid;
    if (!isGroupPane && !isAutomationTaskPane) {
      const lazy = String(peekPaneLazyInheritParent(pane.id) ?? "").trim();
      if (lazy) return lazy;
      const remembered = String(getRememberedSessionForAvatar(pane.avatarId) ?? "").trim();
      if (remembered) return remembered;
    }
    return "";
  };

  const refreshComposerTaskspaces = async (): Promise<Taskspace[] | null> => {
    const apiSessionId = String(
      useAppStore.getState().panes.find((item) => item.id === pane.id)?.sessionId ?? "",
    ).trim();
    const requestId = ++composerWorkspaceRequestRef.current;
    if (!apiSessionId) {
      setComposerTaskspaces([]);
      setComposerAvailableTaskspaces([]);
      setComposerWorkspaceLoading(false);
      setComposerWorkspaceError("");
      return null;
    }
    setComposerWorkspaceLoading(true);
    setComposerWorkspaceError("");
    try {
      const result = await window.agenticxDesktop.listTaskspaces(apiSessionId);
      const currentSessionId = String(
        useAppStore.getState().panes.find((item) => item.id === pane.id)?.sessionId ?? "",
      ).trim();
      if (
        requestId !== composerWorkspaceRequestRef.current ||
        currentSessionId !== apiSessionId
      ) {
        return null;
      }
      if (!result.ok || !Array.isArray(result.workspaces)) {
        setComposerWorkspaceError(result.error ?? "工作区读取失败");
        return null;
      }
      const next = result.workspaces as Taskspace[];
      const available = Array.isArray(result.available_workspaces)
        ? (result.available_workspaces as Taskspace[])
        : [];
      setComposerTaskspaces(next);
      setComposerAvailableTaskspaces(available);
      setPreloadedTaskspaces(apiSessionId, next);
      const currentId = String(
        useAppStore.getState().panes.find((item) => item.id === pane.id)?.activeTaskspaceId ?? "",
      ).trim();
      if (next.length === 0) {
        if (currentId) setActiveTaskspace(pane.id, null);
        return next;
      }
      if (currentId && !next.some((item) => item.id === currentId)) {
        setActiveTaskspace(pane.id, null);
      }
      return next;
    } catch (error) {
      const currentSessionId = String(
        useAppStore.getState().panes.find((item) => item.id === pane.id)?.sessionId ?? "",
      ).trim();
      if (
        requestId === composerWorkspaceRequestRef.current &&
        currentSessionId === apiSessionId
      ) {
        setComposerWorkspaceError(`工作区读取失败：${String(error)}`);
      }
      return null;
    } finally {
      if (requestId === composerWorkspaceRequestRef.current) {
        setComposerWorkspaceLoading(false);
      }
    }
  };

  const prepareComposerWorkspaceMenu = async (): Promise<void> => {
    let sessionId = String(
      useAppStore.getState().panes.find((item) => item.id === pane.id)?.sessionId ?? "",
    ).trim();
    if (!sessionId) {
      setComposerWorkspaceLoading(true);
      setComposerWorkspaceError("");
      sessionId = String(
        await ensureWorkspaceSessionBeforeFirstMessage("", materializeLazySession),
      ).trim();
      if (!sessionId) {
        setComposerWorkspaceLoading(false);
        setComposerWorkspaceError("会话工作区初始化失败，请检查本地服务后重试。");
        return;
      }
    }
    await refreshComposerTaskspaces();
  };

  const addComposerWorkspace = async (
    pathValue: string,
    labelValue: string,
  ): Promise<boolean> => {
    const path = pathValue.trim();
    if (!path) {
      setComposerWorkspaceError("请输入工作区目录路径");
      return false;
    }

    // A workspace may contain local reports or source-controlled documents,
    // but selecting a repo is not itself a reason to force model routing.  Do
    // one bounded filename-only scan and let the user decide.  The server's
    // attachment routing remains the authority when a file is actually sent.
    const privateTarget = attachmentRoutingPolicy.documentTarget;
    const privateTargetLabel = privateTarget?.label?.trim() || "私有化部署模型";
    const workspaceExtensions = attachmentRoutingPolicy.documentExtensions;
    const scanner = window.agenticxDesktop?.scanWorkspaceSensitiveFiles;
    if (
      activeModelUsesPublicRoute &&
      workspaceExtensions.length > 0 &&
      typeof scanner === "function"
    ) {
      setComposerWorkspaceActionBusy(true);
      setComposerWorkspaceError("");
      try {
        const scan = await scanner({
          path,
          extensions: [...workspaceExtensions],
          maxFiles: 2000,
          maxMatches: 8,
        });
        if (scan.ok && scan.matches.length > 0) {
          const examples = scan.matches.slice(0, 8).map((item) => `• ${item}`).join("\n");
          const suffix = scan.truncated
            ? "\n扫描已达到上限，目录中可能还有其他同类文件。"
            : "";
          const detail = [
            "这只是按文件后缀进行的轻量提醒，没有读取或检查文件内容。",
            `如这些文件包含私密信息，建议先切换到「${privateTargetLabel}」（私有化部署）。`,
            "",
            examples,
            suffix,
          ].join("\n");
          const confirmApi = window.agenticxDesktop?.confirmDialog;
          const confirmed =
            typeof confirmApi === "function"
              ? await confirmApi({
                  title: "工作区可能包含私密文件",
                  message: `检测到 ${scan.matches.length}${scan.truncated ? "+" : ""} 个匹配文件`,
                  detail,
                  confirmText: "继续添加",
                  cancelText: "先不添加",
                })
              : { ok: true, confirmed: window.confirm(`${detail}\n\n是否继续添加？`) };
          if (!confirmed.confirmed) return false;
        }
      } catch (error) {
        // This is an advisory filename scan, not a security certification or
        // authorization gate.  An unavailable scanner must not strand a valid
        // local workspace; the real attachment route still runs on send.
        console.warn("[ChatPane] workspace suffix scan skipped", error);
      } finally {
        setComposerWorkspaceActionBusy(false);
      }
    }

    const currentSessionId = String(
      useAppStore.getState().panes.find((item) => item.id === pane.id)?.sessionId ?? "",
    ).trim();
    if (!currentSessionId) {
      setComposerWorkspaceActionBusy(true);
      setComposerWorkspaceError("");
    }
    const sessionId = await ensureWorkspaceSessionBeforeFirstMessage(
      currentSessionId,
      materializeLazySession,
    );
    if (!sessionId) {
      if (!currentSessionId) {
        setComposerWorkspaceActionBusy(false);
        setComposerWorkspaceError("会话初始化失败，请检查本地服务后重试。");
      }
      return false;
    }

    setComposerWorkspaceActionBusy(true);
    setComposerWorkspaceError("");
    try {
      const result = await window.agenticxDesktop.addTaskspace({
        sessionId,
        path,
        label: labelValue.trim() || undefined,
      });
      if (!result.ok) {
        setComposerWorkspaceError(formatTaskspaceAddError(result.error));
        return false;
      }

      const next = await refreshComposerTaskspaces();
      const added = result.workspace as Taskspace | undefined;
      const selected =
        (added?.id ? next?.find((item) => item.id === added.id) : undefined) ??
        next?.find((item) => item.path === path);
      if (selected) setActiveTaskspace(pane.id, selected.id);
      setTaskspaceAutoRefreshKey((value) => value + 1);
      return true;
    } catch (error) {
      setComposerWorkspaceError(`添加工作区失败：${String(error)}`);
      return false;
    } finally {
      setComposerWorkspaceActionBusy(false);
    }
  };

  const openComposerLocalFolder = async (): Promise<boolean> => {
    const picker = window.agenticxDesktop.chooseDirectory;
    if (typeof picker !== "function") {
      setComposerWorkspaceError("当前客户端不支持目录选择，请完全重启桌面端后重试。");
      return false;
    }
    setComposerWorkspaceActionBusy(true);
    setComposerWorkspaceError("");
    try {
      const picked = await picker();
      if (!picked.ok || !picked.path) {
        if (!picked.canceled) {
          setComposerWorkspaceError(picked.error ?? "目录选择失败，请重试。");
        }
        return false;
      }
      const normalized = picked.path.replace(/[\\/]+$/, "");
      const label = normalized.split(/[\\/]/).filter(Boolean).pop() ?? "";
      return await addComposerWorkspace(picked.path, label);
    } catch (error) {
      setComposerWorkspaceError(`目录选择失败：${String(error)}`);
      return false;
    } finally {
      setComposerWorkspaceActionBusy(false);
    }
  };

  /** Change only this pane's session mode; the Settings page owns the global default. */
  const changeComposerRunMode = async (mode: RunMode): Promise<boolean> => {
    const sid = String(pane.sessionId || "").trim();
    const state = useAppStore.getState();
    const previous = sid
      ? state.sessionRunModes[sid] ?? state.runMode
      : state.pendingSessionRunModesByPane[pane.id] ?? state.runMode;
    if (previous === mode) {
      setComposerPermissionError("");
      return true;
    }
    if (!sid) {
      setPendingSessionRunMode(pane.id, mode);
      setComposerPermissionError("");
      return true;
    }
    setComposerPermissionSaving(true);
    setComposerPermissionError("");
    setSessionRunMode(sid, mode);
    try {
      const res = await fetch(
        `${apiBase}/api/sessions/${encodeURIComponent(sid)}/permissions`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json", "x-agx-desktop-token": apiToken },
          body: JSON.stringify({ mode }),
        },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { ok?: boolean; mode?: unknown };
      setSessionRunMode(sid, data?.ok ? normalizeRunMode(data.mode) : mode);
      return true;
    } catch (error) {
      try {
        const check = await fetch(
          `${apiBase}/api/sessions/${encodeURIComponent(sid)}/permissions`,
          { headers: { "x-agx-desktop-token": apiToken } },
        );
        const data = (await check.json()) as { ok?: boolean; mode?: unknown };
        setSessionRunMode(sid, data?.ok ? normalizeRunMode(data.mode) : previous);
      } catch {
        setSessionRunMode(sid, previous);
      }
      setComposerPermissionError(`权限保存失败：${String(error)}`);
      return false;
    } finally {
      setComposerPermissionSaving(false);
    }
  };

  const searchAtCandidates = async (
    queryText: string,
    browseArg?: AtMentionBrowseState | null
  ) => {
    // Callers that just changed directory pass the next state explicitly; the
    // debounced path relies on this render's closure.
    const browse = browseArg === undefined ? atBrowse : browseArg;
    const lowered = queryText.trim().toLowerCase();
    const metaAtAliases = ["主持人", "组长"];
    const metaMatchesQuery =
      !lowered ||
      metaAtAliases.some((alias) => alias.toLowerCase().includes(lowered)) ||
      "群聊协调者".includes(lowered) ||
      "项目经理".includes(lowered);
    const metaCandidate: AtCandidate | null =
      isGroupPane && Boolean(groupHost) && metaMatchesQuery
        ? {
            kind: "avatar",
            avatarId: "__meta__",
            label: "主持人",
            role: `${groupHost?.name || "主持人"} · 主持本群`,
            avatarUrl: groupHost?.avatarUrl || undefined,
          }
        : null;
    const allMembersCandidate: AtCandidate | null =
      isGroupPane && groupMembers.length > 0 && groupAllMentionMatchesQuery(queryText)
        ? {
            kind: "avatar",
            avatarId: GROUP_MENTION_ALL_ID,
            label: "所有人",
            role: "让群成员依次回答",
          }
        : null;
    const memberCandidates: AtCandidate[] = isGroupPane
      ? groupMembers
          .filter((a) => !lowered || a.name.toLowerCase().includes(lowered) || a.role.toLowerCase().includes(lowered))
          .map((a) => ({
            kind: "avatar" as const,
            avatarId: a.id,
            label: a.name,
            role: a.role,
            avatarUrl: a.avatarUrl || undefined,
          }))
      : [];
    // Broadcast and optional host first — explicit routing controls, then real members.
    // Inside a directory the list is purely filesystem, so members drop out.
    const avatarCandidates: AtCandidate[] = browse && !isGroupPane
      ? []
      : [allMembersCandidate, metaCandidate, ...memberCandidates].filter(
          (item): item is AtCandidate => Boolean(item),
        );

    // Group @ is a participant-routing surface, not a filesystem browser.
    if (isGroupPane) {
      if (browse) setAtBrowse(null);
      setAtCandidates(avatarCandidates.slice(0, 24));
      return;
    }

    const apiSessionId = resolveTaskspaceApiSessionId();
    if (!apiSessionId) {
      setAtCandidates(avatarCandidates.slice(0, 24));
      return;
    }
    const wsResp = await window.agenticxDesktop.listTaskspaces(apiSessionId);
    if (!wsResp.ok || !Array.isArray(wsResp.workspaces) || wsResp.workspaces.length === 0) {
      setAtCandidates(avatarCandidates.slice(0, 24));
      return;
    }
    const activeId = browse
      ? browse.taskspaceId
      : pane.activeTaskspaceId && wsResp.workspaces.some((item) => item.id === pane.activeTaskspaceId)
        ? pane.activeTaskspaceId
        : wsResp.workspaces[0].id;
    if (!browse && !pane.activeTaskspaceId) setActiveTaskspace(pane.id, activeId);
    const browseRoot = browse?.path || ".";
    const rootResp = await window.agenticxDesktop.listTaskspaceFiles({
      sessionId: apiSessionId,
      taskspaceId: activeId,
      path: browseRoot,
    });
    if (!rootResp.ok || !Array.isArray(rootResp.files)) {
      setAtCandidates(avatarCandidates.slice(0, 24));
      return;
    }
    // Mounted taskspace roots stay at the top level; inside a directory the
    // breadcrumb owns the location instead.
    const mountRows: Extract<AtCandidate, { kind: "taskspace" }>[] = browse
      ? []
      : wsResp.workspaces.map((item) => ({
          kind: "taskspace",
          taskspaceId: item.id,
          path: item.path,
          label: item.label || item.path.split("/").filter(Boolean).pop() || "taskspace",
          alias: item.label || item.path.split("/").filter(Boolean).pop() || "taskspace",
        }));

    if (!lowered) {
      // No query: list exactly one level so deep trees stay browsable instead of
      // being flattened into a dump the user has to scroll.
      const dirRows: Extract<AtCandidate, { kind: "dir" }>[] = [];
      const fileRows: Extract<AtCandidate, { kind: "file" }>[] = [];
      for (const row of rootResp.files) {
        if (row.type === "dir") {
          dirRows.push({ kind: "dir", taskspaceId: activeId, path: row.path, label: row.name });
        } else if (row.type === "file") {
          fileRows.push({ kind: "file", taskspaceId: activeId, path: row.path, label: row.name });
        }
      }
      setAtCandidates(
        [...avatarCandidates, ...mountRows, ...dirRows.slice(0, 40), ...fileRows.slice(0, 40)].slice(
          0,
          80
        )
      );
      return;
    }

    // With a query, scan recursively under the current location.
    const flatRows: Extract<AtCandidate, { kind: "file" }>[] = [];
    const nestedDirRows: Extract<AtCandidate, { kind: "dir" }>[] = [];
    const queue: string[] = [browseRoot];
    const visited = new Set<string>();
    while (queue.length > 0 && flatRows.length < 200) {
      const current = queue.shift() || browseRoot;
      if (visited.has(current)) continue;
      visited.add(current);
      const listResp =
        current === browseRoot
          ? rootResp
          : await window.agenticxDesktop.listTaskspaceFiles({
              sessionId: apiSessionId,
              taskspaceId: activeId,
              path: current,
            });
      if (!listResp.ok || !Array.isArray(listResp.files)) continue;
      for (const row of listResp.files) {
        if (row.type === "file") {
          flatRows.push({ kind: "file", taskspaceId: activeId, path: row.path, label: row.name });
          continue;
        }
        if (row.type === "dir") {
          nestedDirRows.push({ kind: "dir", taskspaceId: activeId, path: row.path, label: row.name });
          if (!visited.has(row.path) && queue.length < 200) queue.push(row.path);
        }
      }
    }
    const filteredFiles = flatRows
      .filter((item) => item.path.toLowerCase().includes(lowered))
      .slice(0, 20);
    const filteredFolders = [
      ...mountRows.filter(
        (item) =>
          item.alias.toLowerCase().includes(lowered) || item.path.toLowerCase().includes(lowered)
      ),
      ...nestedDirRows.filter((item) => item.path.toLowerCase().includes(lowered)),
    ].slice(0, 8);
    setAtCandidates([...avatarCandidates, ...filteredFolders, ...filteredFiles].slice(0, 28));
  };
  searchAtCandidatesRef.current = searchAtCandidates;

  const triggerCcBridgeVisibleTerminal = useCallback(
    async (toolCallKey: string) => {
      if (!pane.sessionId) return;
      const now = Date.now();
      const last = ccBridgeVisibleLaunchGuardRef.current.get(toolCallKey) ?? 0;
      if (now - last < 20_000) return;
      ccBridgeVisibleLaunchGuardRef.current.set(toolCallKey, now);
      // Keep guard map bounded.
      if (ccBridgeVisibleLaunchGuardRef.current.size > 32) {
        const cutoff = now - 120_000;
        for (const [k, ts] of ccBridgeVisibleLaunchGuardRef.current.entries()) {
          if (ts < cutoff) ccBridgeVisibleLaunchGuardRef.current.delete(k);
        }
      }

      const wsResp = await window.agenticxDesktop.listTaskspaces(pane.sessionId);
      if (!wsResp.ok || !Array.isArray(wsResp.workspaces) || wsResp.workspaces.length === 0) return;
      const activeWorkspace =
        (pane.activeTaskspaceId
          ? wsResp.workspaces.find((item) => item.id === pane.activeTaskspaceId)
          : undefined) ?? wsResp.workspaces[0];
      if (!activeWorkspace?.path) return;
      if (!pane.activeTaskspaceId || pane.activeTaskspaceId !== activeWorkspace.id) {
        setActiveTaskspace(pane.id, activeWorkspace.id);
      }

      openWorkspaceSidebarForPane(pane.id, paneRef.current?.clientWidth ?? paneWidth, openSidePanel);
      addPaneTerminalTab(pane.id, activeWorkspace.path, "cc-bridge");

      let bridgeUrl = "http://127.0.0.1:9742";
      try {
        const headers: Record<string, string> = {};
        if (apiToken) headers["x-agx-desktop-token"] = apiToken;
        const res = await fetch(`${apiBase}/api/cc-bridge/config`, { headers });
        const text = await res.text();
        const data = text ? JSON.parse(text) : {};
        const parsedUrl = typeof data?.url === "string" ? data.url.trim() : "";
        if (parsedUrl) bridgeUrl = parsedUrl;
      } catch {
        // keep fallback URL
      }

      let launchCmd =
        'lsof -nP -iTCP:9742 -sTCP:LISTEN >/dev/null 2>&1 && echo "[cc-bridge] already listening on 127.0.0.1:9742" || agx cc-bridge serve --host 127.0.0.1 --port 9742';
      try {
        const parsed = new URL(bridgeUrl);
        const host = (parsed.hostname || "").trim();
        const lowerHost = host.toLowerCase();
        const loopback = lowerHost === "127.0.0.1" || lowerHost === "localhost" || lowerHost === "::1";
        const parsedPort = parsed.port ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80;
        const safePort = Number.isFinite(parsedPort) && parsedPort > 0 && parsedPort <= 65535 ? parsedPort : 9742;
        if (loopback) {
          launchCmd = [
            `lsof -nP -iTCP:${safePort} -sTCP:LISTEN >/dev/null 2>&1`,
            `&& echo "[cc-bridge] already listening on ${host || "127.0.0.1"}:${safePort}"`,
            `|| agx cc-bridge serve --host ${shellSingleQuote(host || "127.0.0.1")} --port ${safePort}`,
          ].join(" ");
        } else {
          launchCmd = `echo "[cc-bridge] configured remote URL: ${bridgeUrl}. Skip local autostart."`;
        }
      } catch {
        // keep fallback launch command
      }

      const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));
      const latestPane = useAppStore.getState().panes.find((item) => item.id === pane.id);
      const terminalTabId = latestPane?.activeTerminalTabId;
      if (!terminalTabId) return;
      for (let i = 0; i < 20; i += 1) {
        const latestPane = useAppStore.getState().panes.find((item) => item.id === pane.id);
        if (!latestPane) return;
        const writeRes = await window.agenticxDesktop.terminalWriteByTab({
          tabId: terminalTabId,
          data: `${launchCmd}\n`,
        });
        if (writeRes?.ok) return;
        await sleep(180);
      }
    },
    [
      pane.id,
      pane.sessionId,
      pane.activeTaskspaceId,
      apiBase,
      apiToken,
      setActiveTaskspace,
      openSidePanel,
      addPaneTerminalTab,
      paneWidth,
    ]
  );

  const triggerCcBridgeTailTerminal = useCallback(
    async (sessionId: string) => {
      const sid = sessionId.trim();
      if (!/^[0-9a-fA-F-]{36}$/.test(sid) || !pane.sessionId) return;
      const now = Date.now();
      const last = ccBridgeTailGuardRef.current.get(sid) ?? 0;
      if (now - last < 60_000) return;
      ccBridgeTailGuardRef.current.set(sid, now);

      const wsResp = await window.agenticxDesktop.listTaskspaces(pane.sessionId);
      if (!wsResp.ok || !Array.isArray(wsResp.workspaces) || wsResp.workspaces.length === 0) return;
      const activeWorkspace =
        (pane.activeTaskspaceId
          ? wsResp.workspaces.find((item) => item.id === pane.activeTaskspaceId)
          : undefined) ?? wsResp.workspaces[0];
      if (!activeWorkspace?.path) return;
      openWorkspaceSidebarForPane(pane.id, paneRef.current?.clientWidth ?? paneWidth, openSidePanel);

      let bridgeUrl = "http://127.0.0.1:9742";
      let bridgeToken = "";
      let bridgeConfigOk = false;
      let bridgeConfigError = "";
      let canonicalLogPath: string | null = null;
      try {
        const headers: Record<string, string> = {};
        if (apiToken) headers["x-agx-desktop-token"] = apiToken;
        const res = await fetch(
          `${apiBase}/api/cc-bridge/config?session_id=${encodeURIComponent(sid)}`,
          { headers },
        );
        const data = res.ok ? await res.json() : {};
        if (!res.ok || data?.ok !== true) {
          bridgeConfigError =
            typeof data?.error === "string" && data.error.trim()
              ? data.error.trim()
              : `配置请求失败（HTTP ${res.status}）`;
        } else {
          bridgeConfigOk = true;
          const u = typeof data?.url === "string" ? data.url.trim() : "";
          if (u) bridgeUrl = u.replace(/\/$/, "");
          bridgeToken = typeof data?.token === "string" ? data.token : "";
          canonicalLogPath = ccBridgeLogPathFromConfig(data);
          if (!canonicalLogPath) bridgeConfigError = "Studio 未返回 CC bridge 日志路径";
        }
      } catch {
        bridgeConfigError = "无法读取 Studio 的 CC bridge 配置";
      }

      if (bridgeToken) {
        addPaneTerminalTab(pane.id, activeWorkspace.path, "claude-code", {
          sessionId: sid,
          baseUrl: bridgeUrl,
          token: bridgeToken,
        });
        return;
      }

      addPaneTerminalTab(pane.id, activeWorkspace.path, "claude-code");

      const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));
      const latestPane = useAppStore.getState().panes.find((item) => item.id === pane.id);
      const terminalTabId = latestPane?.activeTerminalTabId;
      if (!terminalTabId) return;
      if (!bridgeConfigOk || !canonicalLogPath) {
        const message = bridgeConfigError || "Studio 未返回 CC bridge 日志路径";
        await window.agenticxDesktop.terminalWriteByTab({
          tabId: terminalTabId,
          data: `echo ${shellSingleQuote(`[claude-code] ${message}`)}\n`,
        });
        return;
      }
      const tailCmd = buildCcBridgeTailCommand(canonicalLogPath);
      for (let i = 0; i < 20; i += 1) {
        const writeRes = await window.agenticxDesktop.terminalWriteByTab({
          tabId: terminalTabId,
          data: `${tailCmd}\n`,
        });
        if (writeRes?.ok) return;
        await sleep(180);
      }
    },
    [pane.id, pane.sessionId, pane.activeTaskspaceId, apiBase, apiToken, openSidePanel, addPaneTerminalTab, paneWidth]
  );

  const updateAtStateFromText = useCallback((value: string, caretOffset?: number) => {
    const next = nextComposerAtMentionState(value, caretOffset);
    setAtOpen((prev) => (prev === next.open ? prev : next.open));
    setAtQuery((prev) => (prev === next.query ? prev : next.query));
    // Losing the `@` token ends the browse session, so the next `@` starts at the top.
    if (!next.open) setAtBrowse((prev) => (prev === null ? prev : null));
    if (next.shouldSearch) {
      if (atSearchTimerRef.current != null) clearTimeout(atSearchTimerRef.current);
      atSearchTimerRef.current = setTimeout(() => {
        atSearchTimerRef.current = null;
        void searchAtCandidatesRef.current(next.query);
      }, AT_MENTION_SEARCH_DEBOUNCE_MS);
      return;
    }
    if (atSearchTimerRef.current != null) {
      clearTimeout(atSearchTimerRef.current);
      atSearchTimerRef.current = null;
    }
  }, []);

  const syncComposerFromValue = useCallback(
    (value: string, caretOffset?: number) => {
      setComposerHasText((prev) => {
        const next = isComposerNonEmpty(value);
        return prev === next ? prev : next;
      });
      updateAtStateFromText(value, caretOffset);
    },
    [updateAtStateFromText]
  );

  const serializeComposerRoot = useCallback((root: HTMLElement): string => {
    // Keep visual token text clean (without "@"), but serialize it as "@name" for routing.
    const tokenNodes = root.querySelectorAll<HTMLElement>("[data-ref-token='1']");
    for (const node of tokenNodes) {
      const name = String(node.dataset.refName || node.textContent || "").trim();
      node.textContent = name ? `@${name}` : "";
    }
    // Serialize skill tokens as "@skill://name"
    const skillNodes = root.querySelectorAll<HTMLElement>("[data-skill-token='1']");
    for (const node of skillNodes) {
      const name = String(node.dataset.skillName || "").trim();
      node.textContent = name ? `@skill://${name}` : "";
    }
    // Keep quote chips as positional placeholders so setComposerText / @file round-trips
    // do not yank them back to the start of the composer.
    root.querySelectorAll<HTMLElement>("[data-quote-token='1']").forEach((node) => {
      const id = String(node.getAttribute("data-quote-id") || "").trim();
      node.textContent = id ? composerQuotePlaceholder(id) : "";
    });
    return (root.innerText || "").replace(/\u00a0/g, " ");
  }, []);

  const extractComposerText = useCallback((): string => {
    const el = composerRef.current;
    if (!el) return "";
    const clone = el.cloneNode(true) as HTMLDivElement;
    return serializeComposerRoot(clone);
  }, [serializeComposerRoot]);

  const extractComposerSendText = useCallback((): string => {
    return stripComposerQuotePlaceholders(extractComposerText());
  }, [extractComposerText]);

  /** Display/history text: keeps inline quote placeholders with stable index ids. */
  const buildComposerDisplayText = useCallback((): string => {
    const raw = extractComposerText();
    const el = composerRef.current;
    if (!el) return raw;
    const orderedIds = Array.from(
      el.querySelectorAll<HTMLElement>('[data-quote-token="1"]')
    )
      .map((node) => node.getAttribute("data-quote-id") || "")
      .filter(Boolean);
    if (orderedIds.length === 0) return raw;
    return normalizeComposerQuotePlaceholdersToIndices(raw, orderedIds);
  }, [extractComposerText]);

  const collectComposerDraft = useCallback((): Omit<ComposerDraft, "updatedAt"> => {
    const text = composerRef.current
      ? extractComposerText()
      : composerDraftTextRef.current;
    composerDraftTextRef.current = text;
    const attachments: ComposerDraftAttachment[] = Object.entries(contextFilesRef.current)
      .filter(([, file]) => file.status === "ready")
      .map(([key, file]) => ({
        key,
        name: file.name,
        size: file.size,
        mimeType: file.mimeType,
        status: "ready" as const,
        content: file.content,
        ...(file.dataUrl ? { dataUrl: file.dataUrl } : {}),
        ...(file.sourcePath ? { sourcePath: file.sourcePath } : {}),
        ...(file.referenceToken ? { referenceToken: true } : {}),
        ...(file.composerRefLabel ? { composerRefLabel: file.composerRefLabel } : {}),
        ...(file.lineRange ? { lineRange: file.lineRange } : {}),
        ...(file.spreadsheetRef ? { spreadsheetRef: file.spreadsheetRef } : {}),
        ...(file.snippetRef ? { snippetRef: file.snippetRef } : {}),
        ...(file.snippetContent ? { snippetContent: file.snippetContent } : {}),
        ...(file.htmlElementRef ? { htmlElementRef: file.htmlElementRef } : {}),
      }));
    return {
      text,
      attachments,
      quotes: quoteTargetsRef.current
        .filter((target) => text.includes(composerQuotePlaceholder(target.id)))
        .map((target) => ({
          id: target.id,
          body: target.body,
          message: {
            id: target.message.id,
            role: target.message.role,
            content: target.message.content,
            ...(target.message.avatarName ? { avatarName: target.message.avatarName } : {}),
            ...(target.message.avatarUrl ? { avatarUrl: target.message.avatarUrl } : {}),
            ...(target.message.agentId ? { agentId: target.message.agentId } : {}),
          },
        })),
      refPaths: { ...composerRefPathsRef.current },
      refMetaOverrides: Object.fromEntries(
        Object.entries(composerRefMetaOverrideRef.current).map(([key, value]) => [
          key,
          { ...value },
        ]),
      ),
    };
  }, [extractComposerText]);

  const flushComposerDraftNow = useCallback(
    (identity = activeDraftIdentityRef.current) => {
      if (!identity || draftHydratingRef.current) return;
      if (draftSaveTimerRef.current != null) {
        window.clearTimeout(draftSaveTimerRef.current);
        draftSaveTimerRef.current = null;
      }
      saveComposerDraft(identity, collectComposerDraft());
    },
    [collectComposerDraft],
  );
  flushComposerDraftNowRef.current = flushComposerDraftNow;

  const scheduleComposerDraftSave = useCallback(() => {
    if (draftHydratingRef.current) return;
    if (composerRef.current) {
      composerDraftTextRef.current = extractComposerText();
    }
    if (draftSaveTimerRef.current != null) {
      window.clearTimeout(draftSaveTimerRef.current);
    }
    draftSaveTimerRef.current = window.setTimeout(() => {
      draftSaveTimerRef.current = null;
      flushComposerDraftNowRef.current();
    }, COMPOSER_DRAFT_SAVE_DEBOUNCE_MS);
  }, [extractComposerText]);
  scheduleComposerDraftSaveRef.current = scheduleComposerDraftSave;

  useEffect(() => {
    scheduleComposerDraftSaveRef.current();
  }, [contextFiles, quoteTargets]);

  useEffect(() => {
    const flushOnVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        flushComposerDraftNowRef.current();
      }
    };
    const flushOnUnload = () => flushComposerDraftNowRef.current();
    document.addEventListener("visibilitychange", flushOnVisibilityChange);
    window.addEventListener("beforeunload", flushOnUnload);
    return () => {
      document.removeEventListener("visibilitychange", flushOnVisibilityChange);
      window.removeEventListener("beforeunload", flushOnUnload);
      if (draftSaveTimerRef.current != null) {
        window.clearTimeout(draftSaveTimerRef.current);
        draftSaveTimerRef.current = null;
      }
      draftHydratingRef.current = false;
      flushComposerDraftNowRef.current();
    };
  }, []);

  const focusComposerEnd = useCallback(() => {
    const el = composerRef.current;
    if (!el) return;
    el.focus();
    const selection = window.getSelection();
    if (!selection) return;
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
    composerSavedRangeRef.current = range.cloneRange();
  }, []);

  const handleSkillSelect = useCallback((skill: SkillItem) => {
    const el = composerRef.current;
    if (!el) return;
    const skillToken = createSkillRefToken(skill.name);
    const space = document.createTextNode(" ");
    const selection = window.getSelection();
    if (selection && selection.rangeCount > 0 && el.contains(selection.anchorNode)) {
      const range = selection.getRangeAt(0);
      range.deleteContents();
      range.insertNode(space);
      range.insertNode(skillToken);
      range.setStartAfter(space);
      range.setEndAfter(space);
      selection.removeAllRanges();
      selection.addRange(range);
    } else {
      el.appendChild(skillToken);
      el.appendChild(space);
      focusComposerEnd();
    }
    syncComposerFromValue(extractComposerSendText());
    scheduleComposerDraftSaveRef.current();
  }, [extractComposerSendText, focusComposerEnd, syncComposerFromValue]);

  const saveComposerCaret = useCallback(() => {
    const el = composerRef.current;
    if (!el) return;
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    if (!el.contains(range.commonAncestorContainer)) return;
    composerSavedRangeRef.current = range.cloneRange();
  }, []);

  const readLiveComposerCaretOffset = useCallback((fullText: string): number => {
    const el = composerRef.current;
    if (!el) return fullText.length;
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return fullText.length;
    const range = selection.getRangeAt(0);
    if (!el.contains(range.commonAncestorContainer)) return fullText.length;
    const prefixRange = document.createRange();
    prefixRange.selectNodeContents(el);
    prefixRange.setEnd(range.startContainer, range.startOffset);
    const before = prefixRange.toString().replace(/\u00a0/g, " ");
    if (fullText.startsWith(before)) return before.length;
    const idx = fullText.indexOf(before);
    if (idx >= 0) return idx + before.length;
    return fullText.length;
  }, []);

  const readSerializedComposerAroundCaret = useCallback((): { before: string; after: string } => {
    const el = composerRef.current;
    if (!el) return { before: "", after: "" };
    const selection = window.getSelection();
    const range =
      selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : composerSavedRangeRef.current;
    if (!range || !el.contains(range.commonAncestorContainer)) {
      return { before: extractComposerText(), after: "" };
    }
    const beforeRange = document.createRange();
    beforeRange.selectNodeContents(el);
    beforeRange.setEnd(range.startContainer, range.startOffset);
    const afterRange = document.createRange();
    afterRange.selectNodeContents(el);
    afterRange.setStart(range.endContainer, range.endOffset);
    const beforeWrap = document.createElement("div");
    beforeWrap.appendChild(beforeRange.cloneContents());
    const afterWrap = document.createElement("div");
    afterWrap.appendChild(afterRange.cloneContents());
    return {
      before: serializeComposerRoot(beforeWrap),
      after: serializeComposerRoot(afterWrap),
    };
  }, [extractComposerText, serializeComposerRoot]);

  useEffect(() => {
    const onSelectionChange = () => saveComposerCaret();
    document.addEventListener("selectionchange", onSelectionChange);
    return () => document.removeEventListener("selectionchange", onSelectionChange);
  }, [saveComposerCaret]);

  useEffect(() => {
    return () => {
      if (atSearchTimerRef.current != null) clearTimeout(atSearchTimerRef.current);
    };
  }, []);

  useEffect(() => {
    const root = composerRef.current;
    if (!root) return;

    const clearComposerRefTipTimer = () => {
      if (composerRefTipTimerRef.current != null) {
        clearTimeout(composerRefTipTimerRef.current);
        composerRefTipTimerRef.current = null;
      }
    };

    const resolveComposerRefTipPath = (target: HTMLElement): string => {
      const fromAttr = target.getAttribute("data-source-path")?.trim();
      if (fromAttr) return fromAttr;
      const refName = target.getAttribute("data-ref-name")?.trim() || "";
      if (!refName) return "";
      const fromLookup = lookupComposerRefPath(composerRefPathsRef.current, refName);
      if (fromLookup) return fromLookup;
      const meta = findReferenceAttachmentMeta(
        refName,
        Object.entries(contextFiles).map(([key, file]) => ({
          ...file,
          sourcePath: file.sourcePath || key,
        }))
      );
      return resolveReferenceSourcePath(refName, meta?.sourcePath);
    };

    const showComposerRefTip = (target: HTMLElement) => {
      const path = resolveComposerRefTipPath(target);
      if (!path) return;
      target.setAttribute("data-source-path", path);
      target.title = path;
      composerRefTipTargetRef.current = target;
      const rect = target.getBoundingClientRect();
      setComposerRefTip({ path, x: rect.left + rect.width / 2, y: rect.top });
    };

    const onMouseOver = (event: MouseEvent) => {
      const target = (event.target as HTMLElement | null)?.closest?.(
        '[data-ref-token="1"]'
      ) as HTMLElement | null;
      if (!target || !root.contains(target)) return;
      if (composerRefTipTargetRef.current === target && composerRefTipTimerRef.current != null) {
        return;
      }
      clearComposerRefTipTimer();
      composerRefTipTargetRef.current = target;
      composerRefTipTimerRef.current = setTimeout(() => showComposerRefTip(target), 280);
    };

    const onMouseOut = (event: MouseEvent) => {
      const from = (event.target as HTMLElement | null)?.closest?.(
        '[data-ref-token="1"]'
      ) as HTMLElement | null;
      if (!from) return;
      const to = (event.relatedTarget as HTMLElement | null)?.closest?.(
        '[data-ref-token="1"]'
      ) as HTMLElement | null;
      if (to && from === to) return;
      clearComposerRefTipTimer();
      composerRefTipTargetRef.current = null;
      setComposerRefTip(null);
    };

    root.addEventListener("mouseover", onMouseOver);
    root.addEventListener("mouseout", onMouseOut);
    return () => {
      root.removeEventListener("mouseover", onMouseOver);
      root.removeEventListener("mouseout", onMouseOut);
      clearComposerRefTipTimer();
      composerRefTipTargetRef.current = null;
      setComposerRefTip(null);
    };
  }, [composerExpanded, contextFiles, pane.id]);

  const patchComposerRefTokenPaths = useCallback(() => {
    const root = composerRef.current;
    if (!root) return;
    const lookup = buildComposerRefPathLookup(
      Object.entries(contextFiles).map(([key, file]) => ({
        key,
        name: file.name,
        sourcePath: file.sourcePath,
        composerRefLabel: file.composerRefLabel,
      })),
      composerRefPathsRef.current
    );
    composerRefPathsRef.current = lookup;
    root.querySelectorAll<HTMLElement>('[data-ref-token="1"]').forEach((node) => {
      const refName = String(node.getAttribute("data-ref-name") || "").trim();
      if (!refName) return;
      const sp = lookupComposerRefPath(lookup, refName);
      if (!sp) return;
      node.setAttribute("data-source-path", sp);
      node.title = sp;
    });
  }, [contextFiles]);

  useEffect(() => {
    patchComposerRefTokenPaths();
  }, [patchComposerRefTokenPaths]);

  const resolveRefMetaForLabel = useCallback(
    (label: string) => {
      const rows = Object.entries(contextFiles).map(([key, file]) => ({
        ...file,
        sourcePath: file.sourcePath || key,
      }));
      return findReferenceAttachmentMeta(label, rows);
    },
    [contextFiles]
  );

  const createFileRefToken = useCallback(
    (name: string, explicitSourcePath?: string) => {
      const override = composerRefMetaOverrideRef.current[name];
      const baseMeta = resolveRefMetaForLabel(name);
      const meta = {
        ...baseMeta,
        ...override,
        htmlElementRef: override?.htmlElementRef ?? baseMeta?.htmlElementRef,
        composerRefLabel: override?.composerRefLabel ?? baseMeta?.composerRefLabel,
        sourcePath: override?.sourcePath ?? baseMeta?.sourcePath,
      };
      const resolvedPath = resolveReferenceSourcePath(
        name,
        explicitSourcePath ||
          lookupComposerRefPath(composerRefPathsRef.current, name) ||
          meta?.sourcePath
      );
      const kind = resolveComposerRefIconKind(name, meta);
      const token = document.createElement("span");
      token.setAttribute("contenteditable", "false");
      token.setAttribute("data-ref-token", "1");
      token.setAttribute("data-ref-name", name);
      token.setAttribute("data-ref-kind", kind);
      token.className = COMPOSER_INLINE_CHIP_CLASS;
      if (resolvedPath) {
        token.setAttribute("data-source-path", resolvedPath);
        token.title = resolvedPath;
        composerRefPathsRef.current[name] = resolvedPath;
      }
      const icon = document.createElement("span");
      icon.innerHTML = composerRefIconInnerHtml(kind, 13);
      token.appendChild(icon);
      const label = document.createElement("span");
      label.className = "min-w-0 truncate";
      const lineRange = meta?.lineRange ?? parseLineRangeFromReferenceLabel(name);
      // HTML select-element: [cursor] tag · [bubble] comment — never host HTML filename.
      if (meta?.htmlElementRef) {
        const tag = meta.htmlElementRef.tagName || name;
        const comment = String(meta.htmlElementRef.comment || "").trim();
        label.textContent = tag;
        token.appendChild(label);
        if (comment) {
          token.setAttribute("data-html-element-comment", comment);
          const sep = document.createElement("span");
          sep.className = "mx-0.5 opacity-50";
          sep.textContent = "·";
          token.appendChild(sep);
          const bubble = document.createElement("span");
          bubble.innerHTML =
            '<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" style="width:12px;height:12px;display:inline;vertical-align:-0.1em;margin-right:0.18em;opacity:0.9;color:#059669"><path d="M3 3.5h10a1.5 1.5 0 011.5 1.5v5A1.5 1.5 0 0113 11.5H8l-2.5 2v-2H3A1.5 1.5 0 011.5 10V5A1.5 1.5 0 013 3.5z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><circle cx="11.5" cy="4" r="1" fill="currentColor"/></svg>';
          token.appendChild(bubble);
          const commentEl = document.createElement("span");
          commentEl.className = "min-w-0 truncate";
          commentEl.textContent = comment;
          token.appendChild(commentEl);
        }
      } else {
        label.textContent = formatReferenceChipLabel(name, resolvedPath, lineRange);
        token.appendChild(label);
      }
      return token;
    },
    [resolveRefMetaForLabel]
  );

  const createSkillRefToken = useCallback((name: string) => {
    const token = document.createElement("span");
    token.setAttribute("contenteditable", "false");
    token.setAttribute("data-skill-token", "1");
    token.setAttribute("data-skill-name", name);
    token.className = COMPOSER_INLINE_CHIP_CLASS;
    const icon = document.createElement("span");
    icon.innerHTML = skillPuzzleIconInnerHtml(13);
    token.appendChild(icon);
    const label = document.createElement("span");
    label.className = "min-w-0 truncate";
    label.textContent = name;
    token.appendChild(label);
    return token;
  }, []);

  const createQuoteRefToken = useCallback((target: QuoteTarget) => {
    const sender =
      target.message.avatarName ||
      target.message.agentId ||
      (target.message.role === "user" ? "我" : "AI");
    const token = document.createElement("span");
    token.setAttribute("contenteditable", "false");
    token.setAttribute("data-quote-token", "1");
    token.setAttribute("data-quote-id", target.id);
    token.setAttribute("data-quote-message-id", target.message.id);
    // Keep the exact body on the DOM token as a last-resort recovery path for
    // send/draft races. The visible label is intentionally truncated, but the
    // quote itself must never degrade to only that preview.
    token.setAttribute("data-quote-body", target.body);
    token.setAttribute("aria-label", `引用：${target.body}`);
    // Override shared chip max-width — quote preview must stay compact (Cursor-style).
    token.className = `${COMPOSER_INLINE_CHIP_CLASS} agx-composer-quote-chip`;
    token.title = `${sender}: ${target.body}`;
    const icon = document.createElement("span");
    icon.innerHTML = composerQuoteIconInnerHtml(12);
    token.appendChild(icon);
    const label = document.createElement("span");
    label.className = "agx-composer-quote-chip-label";
    label.textContent = formatQuoteChipLabel(target.body);
    token.appendChild(label);
    return token;
  }, []);

  const removeComposerQuoteTokens = useCallback(() => {
    const el = composerRef.current;
    if (!el) return;
    el.querySelectorAll('[data-quote-token="1"]').forEach((node) => {
      const next = node.nextSibling;
      node.remove();
      if (next?.nodeType === Node.TEXT_NODE && (next.textContent === " " || next.textContent === "\u00a0")) {
        next.remove();
      }
    });
  }, []);

  const focusAfterNode = useCallback((node: Node) => {
    const el = composerRef.current;
    if (!el) return;
    el.focus();
    const selection = window.getSelection();
    if (!selection) return;
    const range = document.createRange();
    const after = node.nextSibling;
    if (after?.nodeType === Node.TEXT_NODE) {
      range.setStart(after, Math.min(1, after.textContent?.length ?? 0));
    } else {
      range.setStartAfter(node);
    }
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
  }, []);

  /** Insert a quote chip at the current caret (Cursor-style inline semantics). */
  const insertQuoteTokenAtCaret = useCallback(
    (target: QuoteTarget) => {
      const el = composerRef.current;
      if (!el) return;
      if (el.querySelector(`[data-quote-id="${target.id}"]`)) return;
      const token = createQuoteRefToken(target);
      const spacer = document.createTextNode(" ");
      const selection = window.getSelection();
      let range: Range | null = null;
      const saved = composerSavedRangeRef.current;
      if (
        saved &&
        el.contains(saved.startContainer) &&
        el.contains(saved.endContainer)
      ) {
        range = saved.cloneRange();
      }
      // Do not el.focus() before resolving range — focus() resets caret to composer start.
      if (!range && selection && selection.rangeCount > 0) {
        const current = selection.getRangeAt(0);
        if (el.contains(current.commonAncestorContainer)) {
          range = current.cloneRange();
        }
      }
      if (!range) {
        range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
      }
      range.deleteContents();
      // insertNode puts the node at the start of the range; insert spacer then token so order is token+spacer.
      range.insertNode(spacer);
      range.insertNode(token);
      focusAfterNode(token);
    },
    [createQuoteRefToken, focusAfterNode]
  );

  const syncQuoteTargetsFromComposer = useCallback(() => {
    const el = composerRef.current;
    if (!el || quoteTargetsRef.current.length === 0) return;
    const remaining = new Set(
      Array.from(el.querySelectorAll('[data-quote-token="1"]')).map(
        (node) => node.getAttribute("data-quote-id") || ""
      )
    );
    setQuoteTargets((prev) => {
      const next = prev.filter((q) => remaining.has(q.id));
      return next.length === prev.length ? prev : next;
    });
  }, []);

  // Insert newly added quotes at caret; clear DOM chips when state empties.
  useEffect(() => {
    if (quoteTargets.length === 0) {
      removeComposerQuoteTokens();
      return;
    }
    const pendingId = pendingCaretQuoteIdRef.current;
    if (!pendingId) return;
    pendingCaretQuoteIdRef.current = null;
    const target = quoteTargets.find((q) => q.id === pendingId);
    if (!target) return;
    insertQuoteTokenAtCaret(target);
    syncComposerFromValue(extractComposerSendText());
    scheduleComposerDraftSaveRef.current();
  }, [
    quoteTargets,
    insertQuoteTokenAtCaret,
    removeComposerQuoteTokens,
    extractComposerSendText,
    syncComposerFromValue,
  ]);

  const buildQuotedPayload = useCallback((): {
    quoteMessageIds?: string[];
    quotedMessageId?: string;
    quotedContent?: string;
  } => {
    // Preserve semantic order as chips appear in the composer (not append order).
    const byId = new Map(quoteTargets.map((q) => [q.id, q]));
    const orderedNodes = Array.from(
      composerRef.current?.querySelectorAll<HTMLElement>('[data-quote-token="1"]') ?? []
    );
    const ordered: QuoteTarget[] = [];
    for (const node of orderedNodes) {
      const id = node.getAttribute("data-quote-id") || "";
      const hit = byId.get(id);
      if (hit) {
        ordered.push(hit);
        byId.delete(id);
        continue;
      }
      // The chip itself carries the exact body so a DOM/state reconciliation
      // race cannot turn a visible quote into an empty request.
      const body = String(node.getAttribute("data-quote-body") || "").trim();
      if (body) {
        ordered.push({
          id: id || crypto.randomUUID(),
          body,
          message: {
            id: String(node.getAttribute("data-quote-message-id") || id || "quote"),
            role: "assistant",
            content: body,
          },
        });
      }
    }
    for (const leftover of byId.values()) ordered.push(leftover);
    if (ordered.length === 0) return {};
    const items: QuotePayloadItem[] = ordered.map((q) => ({
      label:
        q.message.avatarName ||
        q.message.agentId ||
        (q.message.role === "user" ? "我" : "AI"),
      body: q.body,
    }));
    const quoteMessageIds = isGroupPane
      ? ordered
          .map((q) => String(q.message.groupMessageId || "").trim())
          .filter(Boolean)
      : [];
    return {
      // Group replies use the durable feed id; local uid/session-index ids are
      // only a rendering concern and cannot be resolved by the router after a
      // reconnect.
      quotedMessageId: ordered
        .map((q) => q.message.groupMessageId || q.message.id)
        .join(","),
      ...(quoteMessageIds.length > 0 ? { quoteMessageIds } : {}),
      quotedContent: serializeQuotedContent(items),
    };
  }, [isGroupPane, quoteTargets]);

  const setComposerText = useCallback(
    (
      value: string,
      options?: {
        tokenNames?: string[];
        refSourcePaths?: Record<string, string>;
        focus?: boolean;
      },
    ) => {
      composerDraftTextRef.current = value;
      const el = composerRef.current;
      if (!el) {
        syncComposerFromValue(value);
        return;
      }
      composerRefPathsRef.current = buildComposerRefPathLookup(
        Object.entries(contextFiles).map(([key, file]) => ({
          key,
          name: file.name,
          sourcePath: file.sourcePath,
          composerRefLabel: file.composerRefLabel,
        })),
        { ...composerRefPathsRef.current, ...(options?.refSourcePaths ?? {}) }
      );
      const tokenNames = new Set<string>();
      for (const [, file] of Object.entries(contextFiles)) {
        if (file.referenceToken && file.name) tokenNames.add(file.name);
        if (file.composerRefLabel) tokenNames.add(file.composerRefLabel);
        if (file.sourcePath) tokenNames.add(file.sourcePath);
      }
      for (const name of options?.tokenNames ?? []) {
        if (name) tokenNames.add(name);
      }
      el.innerHTML = "";
      const tokenNamesByLength = Array.from(tokenNames).sort((a, b) => b.length - a.length);
      const quoteById = new Map(quoteTargetsRef.current.map((q) => [q.id, q]));
      let cursor = 0;
      let textBuffer = "";
      while (cursor < value.length) {
        const quotePh = matchComposerQuotePlaceholder(value, cursor);
        if (quotePh) {
          if (textBuffer) {
            el.appendChild(document.createTextNode(textBuffer));
            textBuffer = "";
          }
          const target = quoteById.get(quotePh.id);
          if (target) {
            el.appendChild(createQuoteRefToken(target));
          }
          cursor += quotePh.len;
          continue;
        }
        if (value[cursor] !== "@") {
          textBuffer += value[cursor];
          cursor += 1;
          continue;
        }
        const rest = value.slice(cursor + 1);
        // 与 extractComposerText 序列化一致：重建 skill 胶囊，避免仅重建 @file 时把 skill 降级成纯文本
        if (rest.startsWith("skill://")) {
          const afterPrefix = rest.slice("skill://".length);
          const skillMatch = afterPrefix.match(/^([^\s@,，。！？\n]+)/);
          if (skillMatch) {
            const slug = skillMatch[1];
            if (textBuffer) {
              el.appendChild(document.createTextNode(textBuffer));
              textBuffer = "";
            }
            el.appendChild(createSkillRefToken(slug));
            cursor += 1 + "skill://".length + slug.length;
            continue;
          }
        }
        const matched = tokenNamesByLength.find((name) => {
          if (!rest.startsWith(name)) return false;
          const tail = rest.slice(name.length, name.length + 1);
          return tail.length === 0 || /\s/.test(tail);
        });
        if (!matched) {
          textBuffer += value[cursor];
          cursor += 1;
          continue;
        }
        if (textBuffer) {
          el.appendChild(document.createTextNode(textBuffer));
          textBuffer = "";
        }
        el.appendChild(createFileRefToken(matched, lookupComposerRefPath(composerRefPathsRef.current, matched)));
        cursor += matched.length + 1;
      }
      if (textBuffer) {
        el.appendChild(document.createTextNode(textBuffer));
      }
      const visible = stripComposerQuotePlaceholders(value);
      syncComposerFromValue(visible);
      if (options?.focus !== false) focusComposerEnd();
      scheduleComposerDraftSaveRef.current();
    },
    [
      contextFiles,
      createFileRefToken,
      createSkillRefToken,
      createQuoteRefToken,
      focusComposerEnd,
      syncComposerFromValue,
    ]
  );

  const restoreComposerDraft = useCallback(
    (identity: string) => {
      draftHydratingRef.current = true;
      try {
        const restored = loadComposerDraft(identity);
        const restoredText = restored?.text ?? "";
        const restoredQuotes: QuoteTarget[] = (restored?.quotes ?? [])
          .filter((quote) => restoredText.includes(composerQuotePlaceholder(quote.id)))
          .map((quote) => ({
            id: quote.id,
            body: quote.body,
            message: {
              id: quote.message.id,
              role: quote.message.role,
              content: quote.message.content,
              avatarName: quote.message.avatarName,
              avatarUrl: quote.message.avatarUrl,
              agentId: quote.message.agentId,
            },
          }));
        const restoredContextFiles: Record<string, AttachedFile> = Object.fromEntries(
          (restored?.attachments ?? []).map((attachment) => [
            attachment.key,
            {
              name: attachment.name,
              size: attachment.size,
              mimeType: attachment.mimeType,
              status: attachment.status,
              content: attachment.content,
              dataUrl: attachment.dataUrl,
              sourcePath: attachment.sourcePath,
              referenceToken: attachment.referenceToken,
              composerRefLabel: attachment.composerRefLabel,
              lineRange: attachment.lineRange,
              spreadsheetRef: attachment.spreadsheetRef,
              snippetRef: attachment.snippetRef,
              snippetContent: attachment.snippetContent,
              htmlElementRef: attachment.htmlElementRef,
            },
          ]),
        );
        const restoredRefMeta: Record<string, ComposerDraftRefMeta> = {
          ...(restored?.refMetaOverrides ?? {}),
        };
        for (const attachment of restored?.attachments ?? []) {
          const label =
            String(attachment.composerRefLabel || "").trim() ||
            String(attachment.name || "").trim();
          if (!label) continue;
          restoredRefMeta[label] = {
            ...restoredRefMeta[label],
            ...(attachment.sourcePath ? { sourcePath: attachment.sourcePath } : {}),
            ...(attachment.composerRefLabel
              ? { composerRefLabel: attachment.composerRefLabel }
              : {}),
            ...(attachment.htmlElementRef
              ? { htmlElementRef: attachment.htmlElementRef }
              : {}),
          };
        }

        pendingCaretQuoteIdRef.current = null;
        quoteTargetsRef.current = restoredQuotes;
        contextFilesRef.current = restoredContextFiles;
        composerRefPathsRef.current = { ...(restored?.refPaths ?? {}) };
        composerRefMetaOverrideRef.current = restoredRefMeta;
        composerSavedRangeRef.current = null;
        setQuoteTargets(restoredQuotes);
        setContextFiles(restoredContextFiles);
        setComposerText(restoredText, {
          tokenNames: (restored?.attachments ?? [])
            .flatMap((attachment) => [
              attachment.composerRefLabel,
              attachment.name,
              attachment.sourcePath,
            ])
            .filter((value): value is string => Boolean(value))
            .concat(
              Object.keys(restored?.refPaths ?? {}),
              Object.keys(restored?.refMetaOverrides ?? {}),
            ),
          refSourcePaths: restored?.refPaths ?? {},
          focus: false,
        });
        hydratedDraftIdentityRef.current = identity;

        const omitted = restored?.omittedAttachmentNames ?? [];
        if (omitted.length > 0) {
          const summary =
            omitted.length === 1
              ? `草稿已恢复，附件“${omitted[0]}”需重新添加`
              : `草稿已恢复，${omitted.length} 个较大附件需重新添加`;
          setAttachToastMessage(summary);
          setAttachToastOpen(true);
        }

        for (const attachment of restored?.attachments ?? []) {
          if (
            !attachment.mimeType.startsWith("image/") ||
            attachment.dataUrl ||
            !attachment.sourcePath ||
            typeof window.agenticxDesktop?.loadLocalImageDataUrl !== "function"
          ) {
            continue;
          }
          void window.agenticxDesktop
            .loadLocalImageDataUrl(attachment.sourcePath)
            .then((result) => {
              if (activeDraftIdentityRef.current !== identity) return;
              setContextFiles((prev) => {
                const current = prev[attachment.key];
                if (!current) return prev;
                if (result.ok && result.dataUrl) {
                  return {
                    ...prev,
                    [attachment.key]: { ...current, status: "ready", dataUrl: result.dataUrl },
                  };
                }
                return {
                  ...prev,
                  [attachment.key]: {
                    ...current,
                    status: "error",
                    errorText: "草稿附件已失效，请重新添加",
                  },
                };
              });
            })
            .catch(() => {
              if (activeDraftIdentityRef.current !== identity) return;
              setContextFiles((prev) => {
                const current = prev[attachment.key];
                if (!current) return prev;
                return {
                  ...prev,
                  [attachment.key]: {
                    ...current,
                    status: "error",
                    errorText: "草稿附件已失效，请重新添加",
                  },
                };
              });
            });
        }
      } finally {
        draftHydratingRef.current = false;
      }
    },
    [setComposerText],
  );

  useLayoutEffect(() => {
    const nextIdentity = composerDraftIdentity({
      paneId: pane.id,
      avatarId: pane.avatarId,
      sessionId: pane.sessionId,
    });
    const previousIdentity = activeDraftIdentityRef.current;
    if (
      previousIdentity === nextIdentity &&
      hydratedDraftIdentityRef.current === nextIdentity
    ) {
      return;
    }
    if (previousIdentity && previousIdentity !== nextIdentity) {
      flushComposerDraftNowRef.current(previousIdentity);
    }
    activeDraftIdentityRef.current = nextIdentity;
    restoreComposerDraft(nextIdentity);
  }, [pane.id, pane.avatarId, pane.sessionId, restoreComposerDraft]);

  const migrateActiveComposerDraftToSession = useCallback(
    (sessionId: string) => {
      const trimmedSessionId = sessionId.trim();
      if (!trimmedSessionId) return;
      const fromIdentity = activeDraftIdentityRef.current;
      const toIdentity = composerDraftIdentity({
        paneId: pane.id,
        avatarId: pane.avatarId,
        sessionId: trimmedSessionId,
      });
      flushComposerDraftNowRef.current(fromIdentity);
      migrateComposerDraft(fromIdentity, toIdentity);
      activeDraftIdentityRef.current = toIdentity;
      hydratedDraftIdentityRef.current = toIdentity;
    },
    [pane.id, pane.avatarId],
  );

  const activateFreshComposerDraft = useCallback(
    (initialText = "") => {
      const currentIdentity = activeDraftIdentityRef.current;
      flushComposerDraftNowRef.current(currentIdentity);
      if (draftSaveTimerRef.current != null) {
        window.clearTimeout(draftSaveTimerRef.current);
        draftSaveTimerRef.current = null;
      }
      const provisionalIdentity = composerDraftIdentity({
        paneId: pane.id,
        avatarId: pane.avatarId,
        sessionId: "",
      });
      deleteComposerDraft(provisionalIdentity);
      activeDraftIdentityRef.current = provisionalIdentity;
      hydratedDraftIdentityRef.current = provisionalIdentity;
      draftHydratingRef.current = true;
      try {
        pendingCaretQuoteIdRef.current = null;
        quoteTargetsRef.current = [];
        contextFilesRef.current = {};
        composerRefPathsRef.current = {};
        composerRefMetaOverrideRef.current = {};
        composerSavedRangeRef.current = null;
        setQuoteTargets([]);
        setContextFiles({});
        setComposerText(initialText);
      } finally {
        draftHydratingRef.current = false;
      }
      if (initialText.trim()) scheduleComposerDraftSaveRef.current();
    },
    [pane.id, pane.avatarId, setComposerText],
  );

  const applyAtMentionReplacement = useCallback(
    (mention: string, options?: Parameters<typeof setComposerText>[1]) => {
      const { before, after } = readSerializedComposerAroundCaret();
      setComposerText(replaceAtMentionAtCaret(before, after, mention), options);
    },
    [readSerializedComposerAroundCaret, setComposerText]
  );

  const handleCrewAppendDirective = useCallback(
    (agentId: string) => {
      const avatar = avatars.find((a) => a.id === agentId);
      const name = String(avatar?.name || agentId).trim();
      if (!name) return;
      applyAtMentionReplacement(`@${name} `);
      focusComposerEnd();
    },
    [applyAtMentionReplacement, avatars, focusComposerEnd],
  );

  const handleOpenGroupMember = useCallback((agentId: string) => {
    const id = String(agentId || "").trim();
    if (!id || id === GROUP_META_MEMBER_ID) return;
    if (!avatars.some((avatar) => avatar.id === id)) return;
    setCrewSettingsAvatarId(id);
    setAvatarSettingsOpen(true);
  }, [avatars]);

  // Keep the existing workbench action name as an alias: both “换模型” and
  // clicking an expert identity open that expert's own settings surface.
  const handleCrewSwitchModel = handleOpenGroupMember;

  const handleCrewInterrupt = useCallback(() => {
    const sid = pane.sessionId;
    if (!sid) return;
    void window.agenticxDesktop.interruptSession?.(sid);
  }, [pane.sessionId]);

  const addContextFile = async (
    taskspaceId: string,
    relPath: string,
    options?: { referenceToken?: boolean; composerRefLabel?: string }
  ): Promise<string | null> => {
    const apiSessionId = resolveTaskspaceApiSessionId();
    if (!apiSessionId || !relPath) return null;
    const fileResp = await window.agenticxDesktop.readTaskspaceFile({
      sessionId: apiSessionId,
      taskspaceId,
      path: relPath,
    });
    if (!fileResp.ok || typeof fileResp.content !== "string") return null;
    const key = String(fileResp.absolute_path || relPath);
    const content = (fileResp.content ?? "").slice(0, TEXT_ATTACHMENT_LIMIT);
    const composerRefLabel =
      String(options?.composerRefLabel || "").trim() ||
      key.split(/[\\/]/).pop() ||
      key;
    setContextFiles((prev) => ({
      ...prev,
      [key]: {
        name: key.split(/[\\/]/).pop() || key,
        size: content.length,
        mimeType: "text/plain",
        status: "ready",
        content,
        sourcePath: key,
        composerRefLabel: options?.referenceToken ? composerRefLabel : undefined,
        referenceToken: !!options?.referenceToken,
      },
    }));
    return key;
  };

  const addTaskspaceAliasReference = async (
    taskspaceId: string,
    alias: string,
    absolutePath: string,
    startRelPath = "."
  ) => {
    const apiSessionId = resolveTaskspaceApiSessionId();
    if (!apiSessionId) return;
    const queue: string[] = [startRelPath || "."];
    const visited = new Set<string>();
    const lines: string[] = [];
    let fileCount = 0;
    const maxFiles = 160;
    while (queue.length > 0 && fileCount < maxFiles) {
      const current = queue.shift() || ".";
      if (visited.has(current)) continue;
      visited.add(current);
      const listResp = await window.agenticxDesktop.listTaskspaceFiles({
        sessionId: apiSessionId,
        taskspaceId,
        path: current,
      });
      if (!listResp.ok || !Array.isArray(listResp.files)) continue;
      for (const row of listResp.files) {
        if (row.type === "dir") {
          if (!visited.has(row.path)) queue.push(row.path);
          continue;
        }
        lines.push(`- ${row.path}`);
        fileCount += 1;
        if (fileCount >= maxFiles) break;
      }
    }
    const summary = [
      `# directory_alias: ${alias}`,
      `path: ${absolutePath}`,
      "",
      "files:",
      ...lines,
      fileCount >= maxFiles ? "- ... (truncated)" : "",
    ]
      .filter(Boolean)
      .join("\n");
    const key = `@dir:${alias}:${absolutePath}`;
    const content = summary.slice(0, 16000);
    setContextFiles((prev) => ({
      ...prev,
      [key]: {
        name: key,
        size: content.length,
        mimeType: "text/plain",
        status: "ready",
        content,
        composerRefLabel: alias,
        referenceToken: true,
      },
    }));
  };

  const insertAtAutocompleteFileReference = useCallback(
    async (taskspaceId: string, relPath: string, label: string) => {
      const cleanLabel = String(label || relPath.split(/[\\/]/).pop() || "").trim();
      if (!taskspaceId || !relPath || !cleanLabel) return;
      const absKey = await addContextFile(taskspaceId, relPath, {
        referenceToken: true,
        composerRefLabel: cleanLabel,
      });
      const mention = `@${cleanLabel} `;
      applyAtMentionReplacement(mention, {
        tokenNames: [cleanLabel],
        ...(absKey ? { refSourcePaths: { [cleanLabel]: absKey } } : {}),
      });
      focusComposerEnd();
    },
    [addContextFile, applyAtMentionReplacement, focusComposerEnd]
  );

  /** Same as insertWorkspaceDirectoryReference, but replaces the `@` token at the
   * caret instead of appending, and accepts an already-known absolute path. */
  const insertAtAutocompleteDirectoryReference = useCallback(
    async (taskspaceId: string, relPath: string, label: string, absolutePathHint?: string) => {
      const cleanLabel = String(label || relPath.split(/[\\/]/).pop() || "folder").trim();
      if (!taskspaceId || !cleanLabel) return;
      const start = relPath || ".";
      let abs = String(absolutePathHint || "").trim();
      if (!abs) {
        const apiSessionId = resolveTaskspaceApiSessionId();
        if (!apiSessionId) return;
        const wsResp = await window.agenticxDesktop.listTaskspaces(apiSessionId);
        const ts = wsResp.workspaces?.find((item) => item.id === taskspaceId);
        if (!ts?.path) return;
        abs = start === "." ? ts.path : absoluteTaskspacePath(ts.path, start);
      }
      await addTaskspaceAliasReference(taskspaceId, cleanLabel, abs, start);
      applyAtMentionReplacement(`@${cleanLabel} `, { tokenNames: [cleanLabel] });
      focusComposerEnd();
    },
    [addTaskspaceAliasReference, applyAtMentionReplacement, focusComposerEnd]
  );

  /** Drill into a folder row; the typed query (if any) now scopes to that subtree. */
  const enterAtMentionDir = useCallback(
    (item: Extract<AtCandidate, { kind: "taskspace" | "dir" }>) => {
      const next: AtMentionBrowseState =
        item.kind === "taskspace"
          ? { taskspaceId: item.taskspaceId, taskspaceLabel: item.label, path: "." }
          : {
              taskspaceId: item.taskspaceId,
              taskspaceLabel: atBrowse?.taskspaceLabel || item.label,
              path: item.path,
            };
      setAtBrowse(next);
      void searchAtCandidatesRef.current(atQuery, next);
    },
    [atBrowse, atQuery]
  );

  const leaveAtMentionBrowse = useCallback(() => {
    if (!atBrowse) return;
    // Stepping above the taskspace root returns to the top-level list.
    const next: AtMentionBrowseState | null =
      atBrowse.path === "." ? null : { ...atBrowse, path: parentBrowsePath(atBrowse.path) };
    setAtBrowse(next);
    void searchAtCandidatesRef.current(atQuery, next);
  }, [atBrowse, atQuery]);

  const insertAtMentionDir = useCallback(
    (item: Extract<AtCandidate, { kind: "taskspace" | "dir" }>) => {
      setAtOpen(false);
      setAtQuery("");
      setAtBrowse(null);
      void insertAtAutocompleteDirectoryReference(
        item.taskspaceId,
        item.kind === "taskspace" ? "." : item.path,
        item.label,
        item.kind === "taskspace" ? item.path : undefined
      );
    },
    [insertAtAutocompleteDirectoryReference]
  );

  const pickAtMentionCandidate = useCallback(
    (item: AtCandidate) => {
      if (item.kind === "taskspace" || item.kind === "dir") {
        enterAtMentionDir(item);
        return;
      }
      setAtOpen(false);
      setAtQuery("");
      setAtBrowse(null);
      if (item.kind === "avatar") {
        applyAtMentionReplacement(`@${item.label} `);
        return;
      }
      void insertAtAutocompleteFileReference(item.taskspaceId, item.path, item.label);
    },
    [applyAtMentionReplacement, enterAtMentionDir, insertAtAutocompleteFileReference]
  );

  const insertWorkspaceFileReference = useCallback(
    async (taskspaceId: string, relPath: string) => {
      if (!taskspaceId || !relPath) return;
      const absKey = await addContextFile(taskspaceId, relPath, { referenceToken: true });
      const fileName = relPath.split(/[\\/]/).pop() || relPath;
      const { next, tokenNames } = buildFileMentionAppend(extractComposerText(), fileName);
      setComposerText(next, {
        tokenNames,
        ...(absKey ? { refSourcePaths: { [fileName]: absKey } } : {}),
      });
      focusComposerEnd();
    },
    [addContextFile, extractComposerText, focusComposerEnd, setComposerText]
  );

  const insertWorkspaceDirectoryReference = useCallback(
    async (taskspaceId: string, relPath: string, label: string) => {
      const apiSessionId = resolveTaskspaceApiSessionId();
      if (!apiSessionId || !taskspaceId) return;
      const cleanLabel = String(label || relPath.split(/[\\/]/).pop() || "folder").trim();
      const wsResp = await window.agenticxDesktop.listTaskspaces(apiSessionId);
      const ts = wsResp.workspaces?.find((item) => item.id === taskspaceId);
      if (!ts?.path) return;
      const abs = relPath === "." ? ts.path : absoluteTaskspacePath(ts.path, relPath);
      await addTaskspaceAliasReference(taskspaceId, cleanLabel, abs, relPath || ".");
      const { next, tokenNames } = buildFileMentionAppend(extractComposerText(), cleanLabel);
      setComposerText(next, { tokenNames });
      focusComposerEnd();
    },
    [addTaskspaceAliasReference, extractComposerText, focusComposerEnd, setComposerText]
  );

  const insertWorkspaceSnippetReference = useCallback(
    (payload: WorkspacePreviewQuotePayload) => {
      const abs = String(payload.absolutePath || "").trim();
      if (!abs) return;
      const makeSnippetRef = (snippet: string) => {
        let h = 2166136261;
        for (let i = 0; i < snippet.length; i += 1) {
          h ^= snippet.charCodeAt(i);
          h = Math.imul(h, 16777619);
        }
        return `snippet-${(h >>> 0).toString(16).padStart(8, "0")}`;
      };
      if (payload.kind === "html-element") {
        const comment = String(payload.comment || "").trim();
        const content = buildHtmlElementContextSnippet({
          absolutePath: abs,
          tagName: payload.tagName,
          selectorHint: payload.selectorHint,
          outerHTML: payload.outerHTML,
          innerText: payload.innerText,
          comment,
        });
        if (!content.trim()) return;
        const tag = String(payload.tagName || "element").trim() || "element";
        // Key must match buildContextFileKeyFromAttachment → `${abs}:${snippetRef}`.
        const snippetRef = `el-${makeSnippetRef(
          `${payload.selectorHint}\n${payload.outerHTML}\n${comment}`
        )}`;
        // Unique @token per element — bare tag (e.g. "span") is shared across chips and
        // would overwrite composerRefMetaOverrideRef / collapse Trae comment onto every chip.
        // Chip display still uses htmlElementRef.tagName (+ comment), never the token id.
        const tokenLabel = snippetRef;
        const key = `${abs}:${snippetRef}`;
        const htmlElementRef = {
          tagName: tag,
          selectorHint: payload.selectorHint,
          ...(comment ? { comment } : {}),
        };
        // Must set before setComposerText — otherwise chip falls back to folder + index.html.
        composerRefMetaOverrideRef.current[tokenLabel] = {
          sourcePath: abs,
          composerRefLabel: tokenLabel,
          htmlElementRef,
        };
        setContextFiles((prev) => ({
          ...prev,
          [key]: {
            name: key,
            size: content.length,
            mimeType: "text/plain",
            status: "ready",
            content,
            sourcePath: abs,
            referenceToken: true,
            composerRefLabel: tokenLabel,
            snippetRef,
            snippetContent: content,
            htmlElementRef,
          },
        }));
        // Trae: comment lives inside the chip visually; model also gets user_comment in context_files.
        const { next, tokenNames } = buildFileMentionAppend(extractComposerText(), tokenLabel, {
          mentionText: tokenLabel,
        });
        setComposerText(next, {
          tokenNames,
          refSourcePaths: { [tokenLabel]: abs },
        });
        focusComposerEnd();
        return;
      }
      if (payload.kind === "text-range") {
        const content = String(payload.snippet || "").trimEnd();
        if (!content.trim()) return;
        const hasLineRange =
          Number.isFinite(payload.startLine) && Number.isFinite(payload.endLine);
        const startLine = hasLineRange ? Math.max(1, Math.floor(payload.startLine!)) : undefined;
        const endLine =
          hasLineRange && startLine !== undefined
            ? Math.max(startLine, Math.floor(payload.endLine!))
            : undefined;
        const snippetRef = !hasLineRange ? makeSnippetRef(content) : undefined;
        const key =
          hasLineRange && startLine !== undefined && endLine !== undefined
            ? `${abs}:${startLine}-${endLine}`
            : `${abs}:${snippetRef}`;
        setContextFiles((prev) => ({
          ...prev,
          [key]: {
            name: key,
            size: content.length,
            mimeType: "text/plain",
            status: "ready",
            content,
            sourcePath: abs,
            referenceToken: true,
            composerRefLabel: payload.label,
            ...(startLine !== undefined && endLine !== undefined
              ? { lineRange: { start: startLine, end: endLine } }
              : {}),
            ...(snippetRef ? { snippetRef } : {}),
            snippetContent: content,
          },
        }));
        const { next, tokenNames } = buildFileMentionAppend(extractComposerText(), payload.label, {
          mentionText: payload.label,
        });
        setComposerText(next, {
          tokenNames,
          refSourcePaths: { [payload.label]: abs },
        });
        focusComposerEnd();
        return;
      }
      const content = String(payload.snippet || "").trimEnd();
      if (!content.trim()) return;
      const key = `${abs}#${payload.sheet}!${payload.a1}`;
      setContextFiles((prev) => ({
        ...prev,
        [key]: {
          name: key,
          size: content.length,
          mimeType: "text/plain",
          status: "ready",
          content,
          sourcePath: abs,
          referenceToken: true,
          composerRefLabel: payload.label,
          spreadsheetRef: { sheet: payload.sheet, a1: payload.a1 },
          snippetContent: content,
        },
      }));
      const { next, tokenNames } = buildFileMentionAppend(extractComposerText(), payload.label, {
        mentionText: payload.label,
      });
      setComposerText(next, {
        tokenNames,
        refSourcePaths: { [payload.label]: abs },
      });
      focusComposerEnd();
    },
    [extractComposerText, focusComposerEnd, setComposerText]
  );

  const handleWorkspaceDragEntry = useCallback(
    async (entry: NearWorkspaceDragEntry) => {
      if (entry.type === "file") {
        await insertWorkspaceFileReference(entry.taskspaceId, entry.relPath);
      } else {
        await insertWorkspaceDirectoryReference(entry.taskspaceId, entry.relPath, entry.label);
      }
    },
    [insertWorkspaceDirectoryReference, insertWorkspaceFileReference]
  );

  /** Left-sidebar file-manage view dispatches picks; only the owning pane applies them. */
  useEffect(() => {
    const onPickFile = (ev: Event) => {
      const detail = (ev as CustomEvent<NearWorkspacePickFileDetail>).detail;
      if (!detail || detail.paneId !== pane.id) return;
      void insertWorkspaceFileReference(detail.taskspaceId, detail.path);
    };
    const onPickDir = (ev: Event) => {
      const detail = (ev as CustomEvent<NearWorkspacePickDirDetail>).detail;
      if (!detail || detail.paneId !== pane.id) return;
      void insertWorkspaceDirectoryReference(detail.taskspaceId, detail.relPath, detail.label);
    };
    window.addEventListener(NEAR_WORKSPACE_PICK_FILE, onPickFile);
    window.addEventListener(NEAR_WORKSPACE_PICK_DIR, onPickDir);
    return () => {
      window.removeEventListener(NEAR_WORKSPACE_PICK_FILE, onPickFile);
      window.removeEventListener(NEAR_WORKSPACE_PICK_DIR, onPickDir);
    };
  }, [pane.id, insertWorkspaceFileReference, insertWorkspaceDirectoryReference]);

  const openWorkspaceFilePreview = useCallback(
    (request: WorkspacePreviewOpenRequest | string) => {
      const requestPaneId = pane.id;
      const requestSessionId = String(pane.sessionId || "").trim();
      const isDisplayed = () => {
        const currentPane = useAppStore
          .getState()
          .panes.find((row) => row.id === requestPaneId);
        return isPaneDisplayingSession(currentPane, requestPaneId, requestSessionId);
      };
      if (!isDisplayed()) return;
      const normalized: WorkspacePreviewOpenRequest =
        typeof request === "string"
          ? { absolutePath: request.trim() }
          : {
              absolutePath: String(request.absolutePath || "").trim(),
              ...(request.lineRange ? { lineRange: request.lineRange } : {}),
            };
      if (!normalized.absolutePath) return;

      // Open the WorkPanel shell only — never switch to「工作区」file-tree tab.
      // File browsing lives in left-nav「文件管理」; previews are Trae-style tabs.
      if (!pane.taskspacePanelOpen) {
        openWorkspaceSidebarForPane(pane.id, paneRef.current?.clientWidth ?? paneWidth, openSidePanel);
      }

      if (isInAppHtmlPreviewPath(normalized.absolutePath)) {
        void (async () => {
          const prepared = await loadPreparedHtmlSrcDoc(normalized.absolutePath);
          if (!isDisplayed()) return;
          if (prepared.ok) {
            setWorkPanelFocus({
              kind: "browser",
              url: pathToFileUrl(normalized.absolutePath),
              title: artifactBaseName(normalized.absolutePath) || "HTML",
              srcDoc: prepared.srcDoc,
            });
            return;
          }
          setWorkPanelFocus({
            kind: "preview",
            absolutePath: normalized.absolutePath,
            title: artifactBaseName(normalized.absolutePath),
          });
        })();
        return;
      }

      setWorkPanelFocus({
        kind: "preview",
        absolutePath: normalized.absolutePath,
        title: artifactBaseName(normalized.absolutePath),
        ...(normalized.lineRange ? { lineRange: normalized.lineRange } : {}),
      });
    },
    [pane.id, pane.sessionId, pane.taskspacePanelOpen, paneWidth, openSidePanel],
  );

  /** Left-sidebar file-manage → Trae WorkPanel preview tab on the right. */
  useEffect(() => {
    const onOpenPreview = (ev: Event) => {
      const detail = (ev as CustomEvent<NearWorkspaceOpenPreviewDetail>).detail;
      if (!detail || detail.paneId !== pane.id) return;
      const abs = String(detail.absolutePath || "").trim();
      if (!abs) return;
      openWorkspaceFilePreview(abs);
    };
    window.addEventListener(NEAR_WORKSPACE_OPEN_PREVIEW, onOpenPreview);
    return () => window.removeEventListener(NEAR_WORKSPACE_OPEN_PREVIEW, onOpenPreview);
  }, [pane.id, openWorkspaceFilePreview]);

  const openFileReferencePreview = useCallback(
    (request: WorkspacePreviewOpenRequest) => {
      openWorkspaceFilePreview(request);
    },
    [openWorkspaceFilePreview],
  );

  const revealFileInTaskspace = useCallback(async (absPath: string) => {
    const requestPaneId = pane.id;
    const requestSessionId = String(pane.sessionId || "").trim();
    const isDisplayed = () => {
      const currentPane = useAppStore.getState().panes.find((row) => row.id === requestPaneId);
      return isPaneDisplayingSession(currentPane, requestPaneId, requestSessionId);
    };
    if (!isDisplayed()) return;
    const path = String(absPath || "").trim();
    if (!path) return;

    if (!pane.taskspacePanelOpen) {
      openWorkspaceSidebarForPane(pane.id, paneRef.current?.clientWidth ?? paneWidth, openSidePanel);
    }

    // HTML reports: Trae-style in-app browser tab (srcDoc), never shell-open Chrome.
    // Relative <img src="*.svg"> assets are inlined as data URLs for srcDoc.
    if (isInAppHtmlPreviewPath(path)) {
      const prepared = await loadPreparedHtmlSrcDoc(path);
      if (!isDisplayed()) return;
      if (prepared.ok) {
        setWorkPanelFocus({
          kind: "browser",
          url: pathToFileUrl(path),
          title: artifactBaseName(path) || "HTML",
          srcDoc: prepared.srcDoc,
        });
        return;
      }
      console.warn("[ChatPane] read HTML failed:", prepared.error);
    }

    let isDirectory = looksLikeDirectoryPath(path);
    const resolve = window.agenticxDesktop?.resolveLocalPath;
    if (resolve) {
      try {
        const info = await resolve(path);
        if (!isDisplayed()) return;
        if (info.ok) {
          if (info.isDirectory) isDirectory = true;
          else if (info.isFile) isDirectory = false;
        }
      } catch {
        // Keep heuristic fallback.
      }
    }

    if (isDirectory) {
      if (!isDisplayed()) return;
      setWorkPanelFocus({
        kind: "summary",
        section: "artifacts",
        highlightPath: path,
      });
      const open = window.agenticxDesktop?.shellOpenPath;
      if (open) {
        const result = await open(path);
        if (!isDisplayed()) return;
        if (!result.ok) console.warn("[ChatPane] open directory failed:", result.error);
      }
      return;
    }

    // PDF / Office / image / markdown / mermaid / code → Trae-style preview tab (not 工作区).
    if (isInAppArtifactPreviewPath(path)) {
      if (!isDisplayed()) return;
      if (!pane.taskspacePanelOpen) {
        openWorkspaceSidebarForPane(pane.id, paneRef.current?.clientWidth ?? paneWidth, openSidePanel);
      }
      setWorkPanelFocus({
        kind: "preview",
        absolutePath: path,
        title: artifactBaseName(path),
      });
      return;
    }

    // Unknown types: highlight in artifacts + locate in Finder (do not shell-open).
    if (!isDisplayed()) return;
    setWorkPanelFocus({
      kind: "summary",
      section: "artifacts",
      highlightPath: path,
    });
    const reveal = window.agenticxDesktop?.shellShowItemInFolder;
    if (reveal) {
      const result = await reveal(path);
      if (!isDisplayed()) return;
      if (!result.ok) console.warn("[ChatPane] reveal file failed:", result.error);
    }
  }, [pane.id, pane.sessionId, pane.taskspacePanelOpen, paneWidth, openSidePanel, openWorkspaceFilePreview]);

  const openWorkPanelSummary = useCallback(
    (section: "artifacts" | "changes") => {
      if (!pane.taskspacePanelOpen) {
        openWorkspaceSidebarForPane(
          pane.id,
          paneRef.current?.clientWidth ?? paneWidth,
          openSidePanel,
        );
      }
      setWorkPanelFocus({ kind: "summary", section });
    },
    [pane.id, pane.taskspacePanelOpen, paneWidth, openSidePanel],
  );

  const copyMessage = useCallback(async (message: Message) => {
    const raw = messagePlainTextForClipboard(message);
    const textToCopy =
      message.role === "user"
        ? canonicalizeUserReferenceMentions(raw, message.attachments)
        : raw;
    try {
      const firstImage = (message.attachments ?? []).find(
        (attachment) => !!attachment.dataUrl && attachment.mimeType.startsWith("image/")
      );
      if (
        firstImage?.dataUrl &&
        typeof window.ClipboardItem !== "undefined" &&
        typeof navigator.clipboard?.write === "function"
      ) {
        const imageBlob = await fetch(firstImage.dataUrl).then((resp) => resp.blob());
        const imageMime = imageBlob.type || firstImage.mimeType || "image/png";
        await navigator.clipboard.write([
          new ClipboardItem({
            [imageMime]: imageBlob,
            "text/plain": new Blob([textToCopy], { type: "text/plain" }),
          }),
        ]);
        return;
      }
      await navigator.clipboard.writeText(textToCopy);
    } catch {
      // ignore clipboard failures
    }
  }, []);

  /** Copy the full content of a ReAct block: assistant text, reasoning, and tool call results. */
  const copyReActBlock = useCallback(async (messages: Message[]) => {
    const parts: string[] = [];
    for (const msg of messages) {
      if (msg.id === "__stream__") continue;
      if (msg.role === "assistant") {
        const text = messagePlainTextForClipboard(msg);
        if (text.trim()) parts.push(text.trim());
      } else if (msg.role === "tool") {
        const name = msg.toolName || "tool";
        const result = (msg.content || "").trim();
        if (result) {
          parts.push(`[${name}]\n${result}`);
        } else if (name !== "tool") {
          parts.push(`[${name}]`);
        }
      }
    }
    const textToCopy = parts.join("\n\n");
    if (!textToCopy) return;
    try {
      await navigator.clipboard.writeText(textToCopy);
    } catch {
      // ignore clipboard failures
    }
  }, []);

  const favoriteMessage = useCallback(async (message: Message, selectedText?: string) => {
    if (!apiBase || !pane.sessionId) return;
    const trimmedSel = selectedText?.trim() ?? "";
    const content = trimmedSel.length > 0 ? trimmedSel : message.content;
    const messageId = favoriteStorageMessageId(message.id, content, message.content);
    try {
      const res = await fetch(`${apiBase}/api/memory/save`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-agx-desktop-token": apiToken },
        body: JSON.stringify({
          session_id: pane.sessionId,
          message_id: messageId,
          content,
          role: message.role,
        }),
      });
      const data = (await res.json().catch(() => null)) as { already_saved?: boolean } | null;
      if (!res.ok || !data) {
        setFavoriteToastMsg("收藏失败，请稍后重试");
        setFavoriteToastOpen(true);
        return;
      }
      setFavoriteToastMsg(data.already_saved ? "已收藏过" : "已收藏");
      setFavoriteToastOpen(true);
    } catch {
      setFavoriteToastMsg("收藏失败，请稍后重试");
      setFavoriteToastOpen(true);
    }
  }, [apiBase, apiToken, pane.sessionId]);

  const toggleSelectMessage = useCallback((message: Message) => {
    setSelectedMessageIds((prev) => {
      const next = new Set(prev);
      // Pair user question + following ReAct/assistant block as one turn (and vice versa).
      const linkedIds = collectTurnLinkedIds(
        message,
        useReActImLayout ? topLevelRowsIm : null,
        visibleMessages,
      );
      const allSelected = Array.from(linkedIds).every((id) => next.has(id));
      if (allSelected) {
        for (const id of linkedIds) next.delete(id);
      } else {
        for (const id of linkedIds) next.add(id);
      }
      return next;
    });
  }, [topLevelRowsIm, useReActImLayout, visibleMessages]);

  /** Toggle a full conversation turn: ReAct block + preceding user question. */
  const toggleSelectBlock = useCallback((messages: Message[]) => {
    setSelectedMessageIds((prev) => {
      const linkedIds = collectTurnLinkedIdsForBlock(
        messages,
        useReActImLayout ? topLevelRowsIm : null,
      );
      const allSelected = Array.from(linkedIds).every((id) => prev.has(id));
      const next = new Set(prev);
      if (allSelected) {
        for (const id of linkedIds) next.delete(id);
      } else {
        for (const id of linkedIds) next.add(id);
      }
      return next;
    });
  }, [topLevelRowsIm, useReActImLayout]);

  const selectUpTo = useCallback((targetMessage: Message) => {
    setSelectedMessageIds((prev) => {
      if (prev.size === 0) {
        return collectTurnLinkedIds(
          targetMessage,
          useReActImLayout ? topLevelRowsIm : null,
          visibleMessages,
        );
      }
      let lastSelectedIdx = -1;
      for (let i = visibleMessages.length - 1; i >= 0; i--) {
        if (prev.has(visibleMessages[i].id)) { lastSelectedIdx = i; break; }
      }
      const targetIdx = visibleMessages.findIndex((m) => m.id === targetMessage.id);
      if (targetIdx < 0) return prev;
      if (lastSelectedIdx < 0) {
        return collectTurnLinkedIds(
          targetMessage,
          useReActImLayout ? topLevelRowsIm : null,
          visibleMessages,
        );
      }
      const lo = Math.min(lastSelectedIdx, targetIdx);
      const hi = Math.max(lastSelectedIdx, targetIdx);
      const next = new Set(prev);
      for (let i = lo; i <= hi; i++) next.add(visibleMessages[i].id);
      return expandSelectionToCompleteTurns(
        next,
        useReActImLayout ? topLevelRowsIm : null,
        visibleMessages,
      );
    });
  }, [topLevelRowsIm, useReActImLayout, visibleMessages]);

  const selectedMessages = useMemo(
    () => visibleMessages.filter((m) => selectedMessageIds.has(m.id)),
    [visibleMessages, selectedMessageIds]
  );

  const selectedTurnCount = useMemo(
    () =>
      countSelectedConversationTurns(
        useReActImLayout ? topLevelRowsIm : null,
        selectedMessageIds,
        visibleMessages,
      ),
    [selectedMessageIds, topLevelRowsIm, useReActImLayout, visibleMessages],
  );

  const resolveForwardTarget = useCallback(
    async (payload: ForwardConfirmPayload): Promise<{ paneId: string; sessionId: string }> => {
      return resolveForwardTargetPayload(payload, {
        addPane: (avatarId, avatarName, sessionId) =>
          addPane(avatarId, avatarName, sessionId ?? ""),
        setActivePaneId,
        setActiveAvatarId,
        setPaneSessionId,
      });
    },
    [addPane, setActiveAvatarId, setActivePaneId, setPaneSessionId]
  );

  const executeForward = useCallback(
    async (targetPayload: ForwardConfirmPayload, followUpNote: string) => {
      if (!apiBase || !pane.sessionId || pendingForwardMessages.length === 0) return;
      const follow = followUpNote.trim();
      /** 与自动追问一致；空则写入默认提示，保证持久化转发卡片里可见（避免仅 skip_user_history 追问在重载后消失）。 */
      const defaultForwardFollowCue = "请阅读刚转发的聊天记录并继续回复。";
      const effectiveFollowNote = follow || defaultForwardFollowCue;
      try {
        const { paneId: targetPaneId, sessionId: targetSessionId } = await resolveForwardTarget(targetPayload);
        const resp = await fetch(`${apiBase}/api/messages/forward`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-agx-desktop-token": apiToken },
          body: JSON.stringify({
            source_session_id: pane.sessionId,
            target_session_id: targetSessionId,
            messages: pendingForwardMessages,
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
        useAppStore.getState().setForwardAutoReply({
          paneId: targetPaneId,
          sessionId: targetSessionId,
          text: effectiveFollowNote,
        });
        useAppStore.getState().bumpSessionCatalogRevision();
        window.setTimeout(() => useAppStore.getState().bumpSessionCatalogRevision(), 450);
      } catch (err) {
        console.error("[ChatPane] forward failed:", err);
        throw err;
      } finally {
        setPendingForwardMessages([]);
      }
    },
    [
      apiBase,
      apiToken,
      pane.sessionId,
      pendingForwardMessages,
      resolveForwardTarget,
      setActiveAvatarId,
      setActivePaneId,
      setPaneMessages,
    ]
  );

  const forwardOneMessage = useCallback((message: Message, selectedText?: string) => {
    setPendingForwardMessages([buildForwardPendingMessage(message, userBubbleLabel, selectedText)]);
    setForwardPickerOpen(true);
  }, [userBubbleLabel]);

  const forwardSelectedMessages = useCallback(() => {
    if (selectedMessages.length === 0) return;
    setPendingForwardMessages(
      selectedMessages.map((message) => buildForwardPendingMessage(message, userBubbleLabel))
    );
    setForwardPickerOpen(true);
  }, [selectedMessages, userBubbleLabel]);

  const exportSelectedMessagesToPdf = useCallback(async () => {
    if (selectedMessages.length === 0) return;
    try {
      const now = Date.now();
      // Expand partial ReAct multi-select to the full turn so the final answer /
      // show_widget graphic cannot be omitted from the PDF.
      const messagesForExport = expandSelectionForCompletePdfExport(
        selectedMessages,
        visibleMessages,
      );
      const html = await buildMessagesPdfHtml({
        messages: messagesForExport,
        sessionTitle: paneAvatarMeta.name || pane?.avatarName || "对话记录",
        exportedAt: now,
        userBubbleLabel,
        appTheme: document.documentElement.getAttribute("data-theme") || "dark",
      });
      const stamp = new Date(now)
        .toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })
        .replace(":", "-");
      const sessionSlug = (paneAvatarMeta.name || pane?.avatarName || "对话")
        .replace(/[\\/:*?"<>|]/g, "_")
        .slice(0, 32);
      const res = await window.agenticxDesktop.exportMessagesPdf({
        html,
        defaultFileName: `${APP_DISPLAY_NAME}对话_${sessionSlug}_${stamp}.pdf`,
      });
      if (res.canceled) return;
      if (res.ok && res.path) {
        setStallHintToast(`已保存到 ${res.path}`);
        setSelectedMessageIds(new Set());
      } else {
        setStallHintToast(`导出失败：${res.error || "未知错误"}`);
      }
    } catch (e) {
      setStallHintToast(`导出失败：${String(e).slice(0, 120)}`);
    }
  }, [
    pane?.avatarName,
    paneAvatarMeta.name,
    selectedMessages,
    setSelectedMessageIds,
    userBubbleLabel,
    visibleMessages,
  ]);

  const shareSelectedAsText = useCallback(async () => {
    const exportable = messagesForShareExport(selectedMessages, visibleMessages);
    if (exportable.length === 0) return;
    const merged = exportable
      .map((message) => {
        const name = message.role === "user" ? "我" : message.avatarName || message.agentId || "AI";
        const time = message.timestamp
          ? new Date(message.timestamp).toLocaleTimeString("zh-CN", {
              hour: "2-digit",
              minute: "2-digit",
            })
          : "";
        return `[${name}]${time ? ` ${time}` : ""}\n${messagePlainTextForClipboard(message)}`;
      })
      .join("\n\n");
    try {
      await navigator.clipboard.writeText(merged);
      setStallHintToast("已复制文本");
    } catch {
      setStallHintToast("复制失败");
    }
  }, [selectedMessages, userBubbleLabel, visibleMessages]);

  const deleteSelectedMessages = useCallback(async () => {
    if (selectedMessages.length === 0 || !apiBase || !pane.sessionId) return;
    const requestPaneId = pane.id;
    const requestSessionId = String(pane.sessionId || "").trim();
    const selectedSnapshot = selectedMessages.slice();
    const selectedTurnCountAtRequest = selectedTurnCount;
    const isDisplayed = () => {
      const currentPane = useAppStore.getState().panes.find((row) => row.id === requestPaneId);
      return isPaneDisplayingSession(currentPane, requestPaneId, requestSessionId);
    };
    const desktop = window.agenticxDesktop;
    const deleteLabel =
      selectedTurnCountAtRequest > 0
        ? `确认删除已选中的 ${selectedTurnCountAtRequest} 轮对话？`
        : `确认删除已选中的 ${selectedSnapshot.length} 条消息？`;
    const confirmResult =
      typeof desktop.confirmDialog === "function"
        ? await desktop.confirmDialog({
            title: "确认删除消息",
            message: deleteLabel,
            detail: "删除后不可恢复。",
            confirmText: "删除",
            cancelText: "取消",
            destructive: true,
          })
        : {
            ok: true,
            confirmed: window.confirm(`${deleteLabel}删除后不可恢复。`),
          };
    if (!confirmResult.confirmed) return;
    // The confirmation belongs to the captured A pane. Do not carry it into
    // a newly displayed B pane if navigation won while the dialog was open.
    if (!isDisplayed()) return;
    try {
      const resp = await fetch(`${apiBase}/api/session/messages/delete`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-agx-desktop-token": apiToken },
        body: JSON.stringify({
          session_id: requestSessionId,
          messages: selectedSnapshot.map((m) => ({
            role: m.role,
            content: m.content,
            timestamp: m.timestamp,
            agent_id: m.agentId,
          })),
        }),
      });
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}`);
      }
      const data = (await resp.json()) as { ok?: boolean; removed?: number; requested?: number };
      if (!isDisplayed()) return;
      const removed = typeof data.removed === "number" ? data.removed : 0;
      const requested =
        typeof data.requested === "number" ? data.requested : selectedSnapshot.length;
      if (!data.ok || removed < requested) {
        const result = await window.agenticxDesktop.loadSessionMessages(requestSessionId);
        if (!isDisplayed()) return;
        if (result.ok && Array.isArray(result.messages)) {
          const mapped = result.messages.map((item, idx) =>
            mapLoadedSessionMessage(item as LoadedSessionMessage, requestSessionId, idx)
          );
          if (!isDisplayed()) return;
          setPaneMessages(requestPaneId, mapped);
        }
      } else {
        const selectedIds = new Set(selectedSnapshot.map((m) => m.id));
        const currentPane = useAppStore.getState().panes.find((row) => row.id === requestPaneId);
        if (!isDisplayed()) return;
        setPaneMessages(
          requestPaneId,
          (currentPane?.messages ?? []).filter((m) => !selectedIds.has(m.id))
        );
      }
      if (!isDisplayed()) return;
      setSelectedMessageIds(new Set());
    } catch (err) {
      console.error("[ChatPane] delete selected messages failed:", err);
    }
  }, [
    apiBase,
    apiToken,
    pane.id,
    pane.sessionId,
    selectedMessages,
    selectedTurnCount,
    setPaneMessages,
  ]);

  const reloadSessionFromDisk = useCallback(
    async (
      sid: string,
      opts?: {
        /** Optional lease check for an async caller that may be superseded while loading. */
        isCurrentOwner?: () => boolean;
      },
    ) => {
      const requestPaneId = pane.id;
      const isDisplayed = () => {
        const currentPane = useAppStore.getState().panes.find((row) => row.id === requestPaneId);
        return isPaneDisplayingSession(currentPane, requestPaneId, sid);
      };
      if (opts?.isCurrentOwner && !opts.isCurrentOwner()) return;
      if (!isDisplayed()) return;
      try {
        const result = await window.agenticxDesktop.loadSessionMessages(sid);
        if (opts?.isCurrentOwner && !opts.isCurrentOwner()) return;
        if (!isDisplayed()) return;
        if (result.ok && Array.isArray(result.messages)) {
          const mapped = result.messages.map((item, midx) =>
            mapLoadedSessionMessage(item as LoadedSessionMessage, sid, midx)
          );
          if (opts?.isCurrentOwner && !opts.isCurrentOwner()) return;
          if (!isDisplayed()) return;
          setPaneMessages(requestPaneId, mapped);
        }
      } catch (err) {
        console.error("[ChatPane] reload session from disk failed:", err);
      }
    },
    [pane.id, setPaneMessages]
  );

  const handleUndoSessionTurn = useCallback(
    async (turnId: string) => {
      const sid = String(pane.sessionId || "").trim();
      const targetTurnId = String(turnId || "").trim();
      if (!sid || !targetTurnId || !apiBase || !apiToken || undoingTurnId) return;
      const requestPaneId = pane.id;
      const isCurrent = () => {
        const currentPane = useAppStore.getState().panes.find((row) => row.id === requestPaneId);
        return isPaneDisplayingSession(currentPane, requestPaneId, sid);
      };
      sessionTurnsFetchSeqRef.current += 1;
      setUndoingTurnId(targetTurnId);
      setSessionTurnErrors((current) => {
        const next = { ...current };
        delete next[targetTurnId];
        return next;
      });
      try {
        const undoResult = await undoSessionTurn({
          sessionId: sid,
          turnId: targetTurnId,
          storeBase: apiBase,
          apiToken,
        });
        if (!isCurrent()) return;
        // The public contract allows one latest-turn rewind.  Keep the UI
        // closed over older checkpoints until a genuinely new user turn is
        // accepted; the refreshed server manifest remains authoritative after
        // reload as well.
        setUndoConsumedSessionId(sid);
        // The undo response is the durable result. Apply it immediately so a
        // transient reload failure cannot leave the pre-undo transcript on
        // screen; the disk reload below then restores any renderer enrichments.
        if (Array.isArray(undoResult.messages)) {
          const loaded = undoResult.messages.filter(
            (item): item is LoadedSessionMessage =>
              Boolean(item) && typeof item === "object" &&
              typeof (item as Record<string, unknown>).role === "string",
          );
          const mapped = loaded.map((item, index) =>
            mapLoadedSessionMessage(item, sid, index, sid),
          );
          if (!isCurrent()) return;
          setPaneMessages(requestPaneId, mapped);
        }
        await reloadSessionFromDisk(sid, { isCurrentOwner: isCurrent });
        if (!isCurrent()) return;
        // Refresh the WorkPanel's taskspace listing and its derived artifact
        // summary after the chat/file restore has become durable.
        window.dispatchEvent(
          new CustomEvent(NEAR_ARTIFACT_TASKSPACES_SYNCED, {
            detail: { sessionId: sid, added: 0 },
          }),
        );
        setSessionTurnsRefreshNonce((value) => value + 1);
      } catch (error) {
        if (!isCurrent()) return;
        const message = error instanceof Error ? error.message : "撤回轮次失败，请重试";
        const conflictPaths = error instanceof SessionTurnConflictError
          ? error.conflictPaths.slice(0, 3)
          : [];
        setSessionTurnErrors((current) => ({
          ...current,
          [targetTurnId]: conflictPaths.length > 0
            ? `${message}：${conflictPaths.join("、")}`
            : message,
        }));
      } finally {
        if (isCurrent()) setUndoingTurnId("");
      }
    },
    [apiBase, apiToken, pane.id, pane.sessionId, reloadSessionFromDisk, undoingTurnId],
  );

  /**
   * FR-B self-heal: when re-entering a displayed session whose foreground SSE is
   * not active, the in-memory messages may have diverged from disk — either a
   * retry truncation that never got the new reply merged back, or a turn that
   * completed in the background while the user was on another session (the
   * re-entry path only reconciled `running` sessions, so an already-`idle`
   * session showed a stale/empty "已中断" state until restart). Disk is
   * authoritative for completed turns (it already persists suggested_questions /
   * references), so a clean full replace mirrors the restart behavior without
   * losing enrichments. No-op when in-memory already matches disk.
   */
  const reconcileDisplayedSessionFromDisk = useCallback(
    async (sid: string): Promise<void> => {
      if (!sid) return;
      if (sessionStreamStateRef.current[sid]?.active) return;
      try {
        const livePane = useAppStore.getState().panes.find((p) => p.id === pane.id);
        if (livePane?.loadingMessages) return;
        if (
          livePane?.hasOlderMessages ||
          (livePane?.oldestLoadedIndex ?? 0) > 0
        ) {
          return;
        }
        const currentMsgs = livePane?.messages ?? [];
        if (lastTurnHasCompletedAssistantReply(currentMsgs)) return;
        const result = await window.agenticxDesktop.loadSessionMessages(sid);
        if (!result.ok || !Array.isArray(result.messages)) return;
        const latestSid = String(
          useAppStore.getState().panes.find((p) => p.id === pane.id)?.sessionId ?? ""
        ).trim();
        if (latestSid !== sid) return;
        if (sessionStreamStateRef.current[sid]?.active) return;
        const current =
          useAppStore.getState().panes.find((p) => p.id === pane.id)?.messages ?? [];
        const mapped = result.messages.map((item, midx) =>
          mapLoadedSessionMessage(item as LoadedSessionMessage, sid, midx)
        );
        const enriched = enrichDiskMessagesWithInMemoryReferences(current, mapped);
        const differs =
          enriched.length !== current.length ||
          String(enriched[enriched.length - 1]?.content ?? "") !==
            String(current[current.length - 1]?.content ?? "") ||
          referencesDifferBetweenTails(current, enriched);
        if (differs) setPaneMessages(pane.id, enriched);
      } catch {
        /* best effort */
      }
    },
    [pane.id, setPaneMessages]
  );

  const loadOlderSessionMessages = useCallback(async (): Promise<void> => {
    const sid = String(pane.sessionId ?? "").trim();
    if (!sid) return;
    if (loadingOlderMessagesRef.current) return;
    const livePane = useAppStore.getState().panes.find((p) => p.id === pane.id);
    if (!livePane?.hasOlderMessages || livePane.loadingOlderMessages) return;
    const beforeIndex = livePane.oldestLoadedIndex ?? 0;
    if (beforeIndex <= 0) return;

    loadingOlderMessagesRef.current = true;
    setPaneMessagePaging(pane.id, { loadingOlderMessages: true });
    const el = listRef.current;
    const prevScrollHeight = el?.scrollHeight ?? 0;

    try {
      const page = await window.agenticxDesktop.loadSessionMessagesPage(sid, {
        beforeIndex,
        limit: 20,
      });
      const latestSid = String(
        useAppStore.getState().panes.find((p) => p.id === pane.id)?.sessionId ?? ""
      ).trim();
      if (latestSid !== sid) return;
      if (!page.ok || !Array.isArray(page.messages)) {
        setPaneMessagePaging(pane.id, { loadingOlderMessages: false });
        return;
      }
      if (page.messages.length === 0) {
        setPaneMessagePaging(pane.id, {
          hasOlderMessages: Boolean(page.has_older),
          loadingOlderMessages: false,
        });
        return;
      }
      const startIndex = page.start_index ?? 0;
      const mapped = page.messages.map((item, index) =>
        mapLoadedSessionMessage(item as LoadedSessionMessage, sid, startIndex + index, sid)
      );
      prependPaneMessages(pane.id, mapped);
      setPaneMessagePaging(pane.id, {
        oldestLoadedIndex: startIndex,
        hasOlderMessages: Boolean(page.has_older),
        loadingOlderMessages: false,
      });
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const inner = listRef.current;
          if (inner) {
            inner.scrollTop += inner.scrollHeight - prevScrollHeight;
          }
        });
      });
    } catch {
      setPaneMessagePaging(pane.id, { loadingOlderMessages: false });
    } finally {
      loadingOlderMessagesRef.current = false;
    }
  }, [pane.id, pane.sessionId, prependPaneMessages, setPaneMessagePaging]);

  const tryLoadOlderIfNeeded = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    const livePane = useAppStore.getState().panes.find((p) => p.id === pane.id);
    if (!livePane?.hasOlderMessages || livePane.loadingOlderMessages || loadingOlderMessagesRef.current) {
      return;
    }
    const atTop = el.scrollTop <= 64;
    const fitsViewport = el.scrollHeight <= el.clientHeight + 8;
    if (atTop || fitsViewport) {
      void loadOlderSessionMessages();
    }
  }, [pane.id, loadOlderSessionMessages]);

  useEffect(() => {
    loadingOlderMessagesRef.current = false;
    const boundSessionId = String(pane.sessionId ?? "").trim();
    sessionBootstrapRef.current = bootstrapMarkerForSessionBinding(
      boundSessionId,
      freshlyCreatedSessionRef.current,
    );
    if (sessionBootstrapRef.current) {
      freshlyCreatedSessionRef.current = "";
    }
    sessionBootstrapInflightRef.current = "";
    sessionBootstrapAttemptRef.current = 0;
    // 切换会话时收起落盘 drawer：其 runId 属于上一会话，跨会话残留会导致
    // "run not found"（用户点当前会话集群卡成员时再按需打开）。
    if (useAppStore.getState().panes.find((p) => p.id === pane.id)?.runDrawerOpen) {
      closeRunDrawer(pane.id);
    }
  }, [pane.id, pane.sessionId, closeRunDrawer]);

  /** App restore / direct bind / switch-back: ensure the pane shows this session's
   *  complete persisted history. We must NOT trust stray rows already sitting in the
   *  pane — a switch-back can leave either stale owner-mismatched rows (the render
   *  layer filters them to a blank screen) or a partial deferred-stream flush that is
   *  missing the user turn and earlier history. Both previously tripped a
   *  `messages.length > 0` shortcut that skipped the disk load and left the
   *  conversation permanently blank/partial with no self-heal. */
  useEffect(() => {
    const sid = (pane.sessionId || "").trim();
    if (!sid) return;
    const live = useAppStore.getState().panes.find((p) => p.id === pane.id);
    if (!live) return;
    // Actively streaming this session: live + reattach rows are authoritative;
    // never overwrite them mid-stream. Mark bootstrapped so the post-stream
    // effect re-run does not trigger a redundant disk reload.
    const streamActiveForSid = Boolean(sessionStreamStateRef.current[sid]?.active);
    if (streamActiveForSid) {
      if ((live.messages ?? []).length > 0) sessionBootstrapRef.current = sid;
      return;
    }
    // One-shot guard: once this session has been bootstrapped (either by a
    // successful disk load here or by splash/restore hydration), never run the
    // disk load again. This prevents the bootstrap from firing a second disk
    // read after the user sends their first message (which changes
    // pane.messages.length) and producing a duplicate optimistic user row.
    if (sessionBootstrapRef.current === sid) return;
    const ownedCount = visibleMessagesForSession(live.messages ?? [], sid).length;
    // Splash / App restore may hydrate messages before this effect runs — mark
    // bootstrapped without a redundant disk roundtrip.
    if (ownedCount > 0) {
      sessionBootstrapRef.current = sid;
      return;
    }
    if (sessionBootstrapInflightRef.current === sid) return;
    sessionBootstrapInflightRef.current = sid;
    let cancelled = false;
    const paneStillOnSid = () =>
      String(
        useAppStore.getState().panes.find((p) => p.id === pane.id)?.sessionId ?? ""
      ).trim() === sid;
    // 骨架屏只在首次尝试点亮；失败/空会话的退避重试在后台静默进行，
    // 避免「正在加载会话…」与空态来回切换造成频闪。
    const showSkeleton = sessionBootstrapAttemptRef.current === 0;
    void (async () => {
      if (showSkeleton) setPaneLoadingMessages(pane.id, true);
      try {
        const entry = await resolveSessionTailForSwitch(sid);
        if (cancelled || !paneStillOnSid()) return;
        if (entry && entry.messages.length > 0) {
          setPaneMessages(pane.id, entry.messages);
          setPaneMessagePaging(pane.id, {
            oldestLoadedIndex: entry.startIndex,
            hasOlderMessages: entry.hasOlder,
            loadingOlderMessages: false,
          });
          sessionBootstrapRef.current = sid;
          return;
        }
        // Tail succeeded with an empty window and no older pages → session is
        // authoritatively empty (brand-new group / never chatted). Skip the
        // full-load fallback and do not schedule empty-session retries — both
        // previously kept the skeleton up for an extra IPC round-trip (and up
        // to ~8s of silent refetch) even though there was nothing to load.
        if (entry && !entry.hasOlder) {
          setPaneMessagePaging(pane.id, {
            oldestLoadedIndex: 0,
            hasOlderMessages: false,
            loadingOlderMessages: false,
          });
          sessionBootstrapRef.current = sid;
          return;
        }
        // Tail unavailable (null) or suspicious empty-with-older — full load so
        // a transient pagination miss never leaves the pane blank.
        const full = await window.agenticxDesktop.loadSessionMessages(sid);
        if (cancelled || !paneStillOnSid()) return;
        if (full.ok && Array.isArray(full.messages)) {
          if (full.messages.length > 0) {
            const mapped = full.messages.map((item, index) =>
              mapLoadedSessionMessage(item as LoadedSessionMessage, sid, index, sid)
            );
            setPaneMessages(pane.id, mapped);
          }
          setPaneMessagePaging(pane.id, {
            oldestLoadedIndex: 0,
            hasOlderMessages: false,
            loadingOlderMessages: false,
          });
          // Mark bootstrapped on authoritative empty too — otherwise the
          // finally-block retry loop keeps re-fetching an empty session.
          sessionBootstrapRef.current = sid;
        }
      } catch {
        /* schedule retry below */
      } finally {
        if (sessionBootstrapInflightRef.current === sid) {
          sessionBootstrapInflightRef.current = "";
        }
        if (!cancelled && paneStillOnSid()) {
          // Only retry when the load itself failed — not when the session is
          // confirmed empty (sessionBootstrapRef already set above).
          const bootstrapped = sessionBootstrapRef.current === sid;
          if (!bootstrapped && sessionBootstrapAttemptRef.current < 4) {
            sessionBootstrapAttemptRef.current += 1;
            window.setTimeout(() => {
              const stillSid =
                String(
                  useAppStore.getState().panes.find((p) => p.id === pane.id)?.sessionId ?? ""
                ).trim() === sid;
              if (!stillSid) return;
              setSessionBootstrapRetryNonce((n) => n + 1);
            }, 800 * sessionBootstrapAttemptRef.current);
          }
        }
        if (!cancelled && showSkeleton) setPaneLoadingMessages(pane.id, false);
      }
    })();
    return () => {
      cancelled = true;
      if (sessionBootstrapInflightRef.current === sid) {
        sessionBootstrapInflightRef.current = "";
        if (showSkeleton) setPaneLoadingMessages(pane.id, false);
      }
    };
  }, [
    pane.id,
    pane.sessionId,
    streamingSessionId,
    sessionBootstrapRetryNonce,
    setPaneLoadingMessages,
    setPaneMessagePaging,
    setPaneMessages,
  ]);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const onScrollUpLoad = () => tryLoadOlderIfNeeded();
    el.addEventListener("scroll", onScrollUpLoad, { passive: true });
    requestAnimationFrame(() => tryLoadOlderIfNeeded());
    return () => {
      el.removeEventListener("scroll", onScrollUpLoad);
    };
  }, [tryLoadOlderIfNeeded]);

  useEffect(() => {
    if (!pane.hasOlderMessages) return;
    requestAnimationFrame(() => tryLoadOlderIfNeeded());
  }, [pane.messages?.length, pane.hasOlderMessages, tryLoadOlderIfNeeded]);

  const truncateSessionAtUserMessage = useCallback(
    async (
      sid: string,
      userContent: string,
      mode: "after" | "including",
      userOccurrence: number,
      expectRemoved: boolean
    ): Promise<boolean> => {
      try {
        const resp = await fetch(`${apiBase}/api/session/messages/truncate`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-agx-desktop-token": apiToken },
          body: JSON.stringify({
            session_id: sid,
            user_content: userContent,
            mode,
            user_occurrence: userOccurrence,
          }),
        });
        const data = (await resp.json()) as {
          ok?: boolean;
          removed_chat?: number;
          removed_agent?: number;
          matched_chat?: boolean;
          matched_agent?: boolean;
        };
        if (!resp.ok || !data.ok) return false;
        const removedChat = typeof data.removed_chat === "number" ? data.removed_chat : 0;
        const removedAgent = typeof data.removed_agent === "number" ? data.removed_agent : 0;
        const matched = Boolean(data.matched_chat || data.matched_agent);
        if (expectRemoved && removedChat === 0 && removedAgent === 0 && !matched) {
          return false;
        }
        return true;
      } catch (err) {
        console.error("[ChatPane] truncate session failed:", err);
        return false;
      }
    },
    [apiBase, apiToken]
  );

  const countUserOccurrenceThrough = useCallback((msgs: Message[], throughIdx: number, content: string) => {
    let count = 0;
    for (let i = 0; i <= throughIdx; i += 1) {
      const row = msgs[i];
      if (!row || row.role !== "user") continue;
      if (row.content === content) count += 1;
    }
    return count;
  }, []);

  const hasTrailingTurnMessages = useCallback((msgs: Message[], userIdx: number) => {
    return userIdx < msgs.length - 1;
  }, []);

  const editUserMessage = useCallback(
    async (msg: Message, newContent: string) => {
      if (msg.role !== "user") return;
      const requestPaneId = pane.id;
      const sid = (pane.sessionId || "").trim();
      if (!sid || !apiBase) return;
      const isDisplayed = () => {
        const currentPane = useAppStore.getState().panes.find((row) => row.id === requestPaneId);
        return isPaneDisplayingSession(currentPane, requestPaneId, sid);
      };
      if (!isDisplayed()) return;
      const msgs =
        useAppStore.getState().panes.find((row) => row.id === requestPaneId)?.messages ?? [];
      const idx = msgs.findIndex((m) => m.id === msg.id);
      if (idx < 0) return;
      const liveMessage = msgs[idx];
      if (!liveMessage || liveMessage.role !== "user") return;
      const userOccurrence = countUserOccurrenceThrough(msgs, idx, liveMessage.content);
      const expectRemoved = idx < msgs.length - 1 || liveMessage.content !== newContent.trim();
      // Remove the edited user turn and everything after it (both UI history and
      // model context) before resending the new content as a fresh turn.
      const ok = await truncateSessionAtUserMessage(
        sid,
        liveMessage.content,
        "including",
        userOccurrence,
        expectRemoved
      );
      if (!isDisplayed()) return;
      if (!ok) {
        await reloadSessionFromDisk(sid, { isCurrentOwner: isDisplayed });
        return;
      }
      if (!isDisplayed()) return;
      setPaneMessages(requestPaneId, msgs.slice(0, idx));
      if (!isDisplayed()) return;
      await sendChatRef.current(newContent, {
        lockedSessionId: sid,
        retryAttachments: liveMessage.attachments ?? [],
      });
    },
    [
      apiBase,
      pane.id,
      pane.sessionId,
      reloadSessionFromDisk,
      setPaneMessages,
      truncateSessionAtUserMessage,
    ]
  );

  // Group chats also have a real streaming run in flight; only the
  // assistant-text overlay is gated by !isGroupPane (group chats render
  // per-member typing bubbles instead). The stop button + queued follow-ups
  // judgment must work in both modes.
  const canInterruptCurrentSession = canStopCurrentRun({
    streaming,
    streamingSessionId,
    currentSessionId: pane.sessionId || "",
  });
  const isRunGuardCurrentSession =
    !canInterruptCurrentSession &&
    !!pane.sessionId &&
    runGuardSessionId === (pane.sessionId || "").trim();

  const sessionWorkInProgress = useMemo(() => {
    const sid = (pane.sessionId || "").trim();
    return shouldShowSessionWorkInProgress({
      isStreamingCurrentSession,
      executionState: sessionExecutionState,
      stallState,
      sessionUnattended,
      unattendedGlobalEnabled,
      userStopped: sid ? Boolean(userStoppedSessionRef.current[sid]) : false,
      messages: pane.messages ?? [],
      isGroupPane,
    });
  }, [
    isGroupPane,
    isStreamingCurrentSession,
    pane.messages,
    pane.sessionId,
    sessionExecutionState,
    sessionUnattended,
    stallState,
    stallTick,
    unattendedGlobalEnabled,
  ]);

  const showStopButton = shouldShowStopButton({
    streaming,
    streamingSessionId,
    currentSessionId: pane.sessionId || "",
    executionState: sessionExecutionState,
    runGuardSessionId,
    hasDelegation,
    isGroupPane,
    sessionWorkInProgress,
  });
  const teamControlVisible =
    shouldShowGroupTeamControls({
      isGroupPane,
      sessionId: pane.sessionId,
      routing: activeGroup?.routing,
      controlState: groupTeamControlState,
      sessionControlState: sessionGraphTeamControlState,
      canInterruptCurrentSession,
      executionState: sessionExecutionState,
      runGuardSessionId,
      stallState,
    });

  const stallModelOptions = useMemo(
    () => collectSelectableModelOptions(settings.providers),
    [settings.providers],
  );

  const currentModelLabel = useMemo(() => {
    if (!chatModel) return "未选模型";
    if (!chatProvider) return chatModel;
    if (!isModelSelectable(chatProvider, chatModel, settings.providers)) return "未选模型";
    const entry = settings.providers[chatProvider];
    return formatModelOptionLabel(chatProvider, chatModel, entry);
  }, [chatModel, chatProvider, settings.providers]);

  const silentSeconds = useMemo(() => {
    void stallTick;
    const sid = (pane.sessionId || "").trim();
    const sessionT = sid ? sessionProgressAtRef.current[sid] ?? 0 : 0;
    const t = Math.max(lastProgressAtRef.current, sessionT);
    if (!t) return 0;
    return Math.floor((Date.now() - t) / 1000);
  }, [stallTick, stallState, sessionExecutionState, pane.sessionId]);

  const stallThresholdSeconds = stallRuntimeConfig.stall_detect_silence_seconds;
  const awaitingHuman = useMemo(
    () => paneHasPendingHumanGate(pane.messages),
    [pane.messages],
  );
  const silenceTier = useMemo(
    () =>
      awaitingHuman
        ? "thinking"
        : resolveSilenceTier(silentSeconds, stallThresholdSeconds),
    [awaitingHuman, silentSeconds, stallThresholdSeconds],
  );
  const sessionHealth = useMemo(
    () =>
      resolveSessionHealth(
        silentSeconds,
        stallThresholdSeconds,
        sessionExecutionState,
        stallState,
        awaitingHuman,
        effectiveGroupTeamControlState,
      ),
    [
      awaitingHuman,
      effectiveGroupTeamControlState,
      silentSeconds,
      stallThresholdSeconds,
      sessionExecutionState,
      stallState,
    ],
  );

  const taskLiveness = useMemo((): "active" | "stalled" | "idle" => {
    // "exhausted" = stall auto-nudge used up; show as stalled (not active) so that
    // StickyTaskBar can render the "stuck" state and promotePending can eventually fire.
    if (stallState === "stall" || stallState === "exhausted") return "stalled";
    if (sessionWorkInProgress) return "active";
    if (sessionExecutionState === "running") return "active";
    return "idle";
  }, [sessionWorkInProgress, stallState, sessionExecutionState]);

  const sessionBusy = taskLiveness !== "idle" || stallState !== "none";
  const previousSessionBusyRef = useRef(sessionBusy);
  useEffect(() => {
    const wasBusy = previousSessionBusyRef.current;
    previousSessionBusyRef.current = sessionBusy;
    if (wasBusy && !sessionBusy && String(pane.sessionId || "").trim()) {
      setSessionTurnsRefreshNonce((value) => value + 1);
    }
  }, [pane.sessionId, sessionBusy]);

  useEffect(() => {
    stallStateRef.current = stallState;
  }, [stallState]);

  const lastAssistantMessageId = useMemo(() => {
    for (let i = visibleMessages.length - 1; i >= 0; i--) {
      if (visibleMessages[i].role === "assistant") return visibleMessages[i].id;
    }
    return null;
  }, [visibleMessages]);

  const artifactAutoOpenKeyRef = useRef("");
  const artifactTurnBusyRef = useRef(false);
  const artifactPendingOpenRef = useRef(false);

  useEffect(() => {
    artifactTurnBusyRef.current = false;
    artifactAutoOpenKeyRef.current = "";
    artifactPendingOpenRef.current = false;
  }, [pane.sessionId]);

  useEffect(() => {
    const busy = sessionBusy || isStreamingCurrentSession;
    if (artifactTurnBusyRef.current && !busy) {
      artifactPendingOpenRef.current = true;
    }
    artifactTurnBusyRef.current = busy;
    if (busy || !artifactPendingOpenRef.current) return;
    const lastId = lastAssistantMessageId;
    if (!lastId || lastId === "__stream__" || isGroupStreamMessageId(lastId)) return;
    const primary = pickPrimaryTurnArtifact(
      collectTurnArtifactPaths(pane.messages ?? [], lastId, pane.sessionId),
    );
    artifactPendingOpenRef.current = false;
    if (!primary) return;
    const key = `${pane.sessionId}:${lastId}:${primary}`;
    if (artifactAutoOpenKeyRef.current === key) return;
    artifactAutoOpenKeyRef.current = key;
    openWorkspaceFilePreview(primary);
  }, [
    sessionBusy,
    isStreamingCurrentSession,
    lastAssistantMessageId,
    pane.sessionId,
    pane.messages,
    openWorkspaceFilePreview,
  ]);

  // Whether the latest interrupted turn is already complete — used to hide
  // the 恢复执行 button on a turn_interrupted row (futile-resume guard).
  const isFutileResumeFlag = useMemo(
    () => isFutileResume(pane.messages ?? []),
    [pane.messages],
  );

  const clearResumeInFlight = useCallback((sid: string, expectedGeneration?: number) => {
    const key = sid.trim();
    const currentGeneration = resumeInFlightGenerationRef.current[key] ?? 0;
    if (
      expectedGeneration !== undefined &&
      (!Number.isFinite(expectedGeneration) || currentGeneration !== expectedGeneration)
    ) {
      return;
    }
    const timer = resumeInFlightTimersRef.current[key];
    if (timer != null) {
      window.clearTimeout(timer);
      delete resumeInFlightTimersRef.current[key];
    }
    delete resumeInFlightRef.current[key];
    delete resumeInFlightGenerationRef.current[key];
    const currentPane = useAppStore.getState().panes.find((row) => row.id === pane.id);
    if (isPaneDisplayingSession(currentPane, pane.id, key)) {
      setResumeInFlight(false);
    }
  }, [pane.id]);

  const beginResumeInFlight = useCallback(
    (sid: string): number => {
      const key = sid.trim();
      if (!key) return 0;
      const previousGeneration = resumeInFlightGenerationRef.current[key] ?? 0;
      const generation =
        (Number.isFinite(previousGeneration) ? Math.floor(previousGeneration) : 0) + 1;
      resumeInFlightGenerationRef.current[key] = generation;
      resumeInFlightRef.current[key] = true;
      setResumeInFlight(true);
      const previousTimer = resumeInFlightTimersRef.current[key];
      if (previousTimer != null) {
        window.clearTimeout(previousTimer);
      }
      resumeInFlightTimersRef.current[key] = window.setTimeout(() => {
        clearResumeInFlight(key, generation);
      }, 8000);
      return generation;
    },
    [clearResumeInFlight]
  );

  const syncStreamingUiForCurrentSession = useCallback(() => {
    const sid = (pane.sessionId || "").trim();
    const st = sid ? sessionStreamStateRef.current[sid] : undefined;
    const active = Boolean(st?.active);
    setStreaming(active);
    setStreamingSessionId(active ? sid : "");
    setStreamedAssistantText(active ? st?.text || "" : "");
    setStreamingModel(
      active && st ? { provider: st.provider || "", model: st.model || "" } : null
    );
    abortRef.current = active ? sessionAbortControllersRef.current[sid] ?? null : null;
    if (sid) {
      const deferred = deferredSessionMessagesRef.current[sid] ?? [];
      if (deferred.length > 0) {
        const existing = new Set(
          (pane.messages ?? []).map((m) => `${m.role}::${String(m.agentId ?? "")}::${String(m.content ?? "")}`)
        );
        for (const args of deferred) {
          const role = String(args[1] ?? "");
          const content = String(args[2] ?? "");
          const agentId = String(args[3] ?? "");
          const sig = `${role}::${agentId}::${content}`;
          if (existing.has(sig)) continue;
          addPaneMessage(...args);
          existing.add(sig);
        }
        deferredSessionMessagesRef.current[sid] = [];
      }
    }
  }, [addPaneMessage, pane.messages, pane.sessionId]);

  useEffect(() => {
    syncStreamingUiForCurrentSession();
  }, [syncStreamingUiForCurrentSession]);

  const recordProgressActivity = useCallback((sessionKey?: string) => {
    const now = Date.now();
    const key = String(sessionKey || pane.sessionId || "").trim();
    if (key) sessionProgressAtRef.current[key] = now;
    const currentSid = (pane.sessionId || "").trim();
    if (!key || key === currentSid) {
      lastProgressAtRef.current = now;
      lastSseEventAtRef.current = now;
      setStallState((prev) => (prev === "stall" ? "none" : prev));
    }
  }, [pane.sessionId]);

  /** 任一 SSE 帧视为仍有响应：刷新计时并在曾误判 stall 时立即收起提示 */
  const recordSseActivity = useCallback(
    (sessionKey?: string) => {
      const key = String(sessionKey || pane.sessionId || "").trim();
      recordProgressActivity(key);
      if (key && resumeInFlightRef.current[key]) {
        clearResumeInFlight(key);
      }
    },
    [clearResumeInFlight, pane.sessionId, recordProgressActivity],
  );

  useEffect(() => {
    void window.agenticxDesktop.loadRuntimeConfig().then((r) => {
      if (!r?.ok) return;
      const cfg = r as {
        stall_detect_silence_seconds?: number;
        stall_auto_nudge_enabled?: boolean;
        stall_auto_nudge_after_seconds?: number;
        stall_auto_nudge_max_per_session?: number;
        unattended_enabled?: boolean;
        unattended_max_continuations_per_session?: number;
        unattended_stall_continue_after_seconds?: number;
        live_reattach_enabled?: boolean;
      };
      liveReattachEnabledRef.current = Boolean(cfg.live_reattach_enabled);
      const detectSec = Math.max(
        30,
        Math.min(300, Number(cfg.stall_detect_silence_seconds ?? 90) || 90),
      );
      setStallRuntimeConfig({
        stall_detect_silence_seconds: detectSec,
        stall_auto_nudge_enabled: Boolean(cfg.stall_auto_nudge_enabled),
        stall_auto_nudge_after_seconds: Math.max(
          60,
          Math.min(300, Number(cfg.stall_auto_nudge_after_seconds ?? 120) || 120)
        ),
        stall_auto_nudge_max_per_session: Math.max(
          1,
          Math.min(5, Number(cfg.stall_auto_nudge_max_per_session ?? 2) || 2)
        ),
      });
      setUnattendedGlobalEnabled(Boolean(cfg.unattended_enabled));
      setUnattendedMaxContinuations(
        Math.max(1, Math.min(100, Number(cfg.unattended_max_continuations_per_session ?? 20) || 20))
      );
      setUnattendedStallContinueAfterSeconds(
        Math.max(
          30,
          Math.min(600, Number(cfg.unattended_stall_continue_after_seconds ?? 120) || 120),
        ),
      );
    });
  }, []);

  /**
   * Returns the id of a trailing "无人值守已停止" marker — i.e. an auto-stop
   * notice that is the most recent unattended event with no later user message.
   * Used to detect that the supervisor has turned unattended off so the desktop
   * stops re-enabling it. Returns null when no such trailing marker exists.
   */
  const detectTrailingUnattendedStop = useCallback(
    (msgs: Message[]): string | null => {
      for (let i = msgs.length - 1; i >= 0; i -= 1) {
        const m = msgs[i];
        if (m.role === "user") return null;
        if (
          m.role === "tool" &&
          typeof m.content === "string" &&
          m.content.includes("无人值守已停止")
        ) {
          return String(m.id ?? `idx-${i}`);
        }
      }
      return null;
    },
    []
  );

  useEffect(() => {
    const sid = (pane.sessionId || "").trim();
    if (!sid) {
      setSessionUnattended(false);
      return;
    }
    try {
      const raw = readScopedLocalStorage(SESSION_UNATTENDED_STORAGE_KEY);
      const map = raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
      const enabled = Boolean(map[sid]);
      // If the session was already auto-stopped by the supervisor, do not push
      // it back on — that caused the reopen → re-stop loop with repeated ⛔.
      const stopId = detectTrailingUnattendedStop(pane.messages ?? []);
      const autoStopped = stopId !== null && unattendedAutoStopAckRef.current[sid] !== stopId;
      if (enabled && autoStopped) {
        setSessionUnattended(false);
        return;
      }
      setSessionUnattended(enabled);
      if (enabled && apiBase) {
        void fetch(`${apiBase.replace(/\/$/, "")}/api/sessions/${encodeURIComponent(sid)}/unattended`, {
          method: "PUT",
          headers: { "Content-Type": "application/json", "x-agx-desktop-token": apiToken },
          body: JSON.stringify({ enabled: true }),
        }).catch(() => {
          /* best-effort sync after restart */
        });
      }
    } catch {
      setSessionUnattended(false);
    }
  }, [apiBase, apiToken, pane.sessionId, pane.messages, detectTrailingUnattendedStop]);

  // When the supervisor auto-stops unattended (trailing ⛔ marker), reflect that
  // by clearing the local toggle and syncing the backend off, so it stays off.
  useEffect(() => {
    const sid = (pane.sessionId || "").trim();
    if (!sid) return;
    const stopId = detectTrailingUnattendedStop(pane.messages ?? []);
    if (!stopId) return;
    if (unattendedAutoStopAckRef.current[sid] === stopId) return;
    unattendedAutoStopAckRef.current[sid] = stopId;
    let cleared = false;
    try {
      const raw = readScopedLocalStorage(SESSION_UNATTENDED_STORAGE_KEY);
      const map = raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
      if (map[sid]) {
        delete map[sid];
        writeScopedLocalStorage(SESSION_UNATTENDED_STORAGE_KEY, JSON.stringify(map));
        cleared = true;
      }
    } catch {
      /* best effort */
    }
    setSessionUnattended(false);
    if (cleared && apiBase) {
      void fetch(`${apiBase.replace(/\/$/, "")}/api/sessions/${encodeURIComponent(sid)}/unattended`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", "x-agx-desktop-token": apiToken },
        body: JSON.stringify({ enabled: false }),
      }).catch(() => {
        /* best effort */
      });
    }
  }, [apiBase, apiToken, pane.sessionId, pane.messages, detectTrailingUnattendedStop]);

  const toggleSessionUnattended = useCallback(async () => {
    const sid = (pane.sessionId || "").trim();
    if (!sid || !apiBase) return;
    const next = !sessionUnattended;
    try {
      await fetch(`${apiBase.replace(/\/$/, "")}/api/sessions/${encodeURIComponent(sid)}/unattended`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", "x-agx-desktop-token": apiToken },
        body: JSON.stringify({ enabled: next }),
      });
      const raw = readScopedLocalStorage(SESSION_UNATTENDED_STORAGE_KEY);
      const map = raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
      if (next) {
        map[sid] = true;
        // Manual re-enable acknowledges any existing trailing stop marker so the
        // auto-disable effect does not immediately turn it back off.
        const stopId = detectTrailingUnattendedStop(pane.messages ?? []);
        if (stopId) unattendedAutoStopAckRef.current[sid] = stopId;
      } else {
        delete map[sid];
      }
      writeScopedLocalStorage(SESSION_UNATTENDED_STORAGE_KEY, JSON.stringify(map));
      setSessionUnattended(next);
    } catch {
      setStallHintToast("无人值守开关保存失败");
    }
  }, [apiBase, apiToken, pane.sessionId, pane.messages, sessionUnattended, detectTrailingUnattendedStop]);

  /** Returns true only when disk merge actually added/changed rows (used to gate progress timer). */
  const mergeTailFromDisk = useCallback(
    async (
      sid: string,
      opts?: {
        allowDuringStream?: boolean;
        /** Optional lease check for async callers that may be superseded while loading. */
        isCurrentOwner?: () => boolean;
      },
    ): Promise<boolean> => {
      if (opts?.isCurrentOwner && !opts.isCurrentOwner()) return false;
      // A foreground SSE stream is the single source of truth while it runs;
      // disk lags and uses a positional id scheme incompatible with the live
      // `uid()` rows, so merging mid-stream re-introduces the just-truncated
      // old reply (the retry "拼接"). Let the stream own the in-memory state.
      // Reattach may opt in via allowDuringStream for mid-turn group replies.
      if (!opts?.allowDuringStream && sessionStreamStateRef.current[sid]?.active) return false;
      try {
        const msgs = await window.agenticxDesktop.loadSessionMessages(sid);
        if (!msgs.ok || !Array.isArray(msgs.messages)) return false;
        if (opts?.isCurrentOwner && !opts.isCurrentOwner()) return false;
        // The displayed session may have changed while the disk load was in
        // flight (e.g. a background timer for session B resolves after the user
        // switched the pane to session A). Never merge B's disk tail into A's
        // pane — that truncates/corrupts the in-memory messages until restart.
        // Mirrors the same guard in the delegation poll path above.
        const latestSid = String(
          useAppStore.getState().panes.find((p) => p.id === pane.id)?.sessionId ?? ""
        ).trim();
        if (latestSid !== sid) return false;
        const current = useAppStore.getState().panes.find((p) => p.id === pane.id)?.messages ?? [];
        const merged = mergeSessionMessagesTail(
          current,
          msgs.messages as LoadedSessionMessage[],
          sid
        );
        // A disk tail can add only the durable feedback address after the
        // live body has already rendered.  Compare that metadata explicitly;
        // a body/length-only check would leave the live uid wired to IPC.
        const feedbackMetadataChanged = merged.some((row, index) => {
          const currentRow = current[index];
          const nextId = String(row.metadata?.[FEEDBACK_MESSAGE_ID_METADATA_KEY] ?? "").trim();
          const currentId = String(currentRow?.metadata?.[FEEDBACK_MESSAGE_ID_METADATA_KEY] ?? "").trim();
          return nextId !== currentId;
        });
        const changed =
          merged.length !== current.length ||
          String(merged[merged.length - 1]?.content ?? "") !==
            String(current[current.length - 1]?.content ?? "") ||
          feedbackMetadataChanged;
        if (changed) {
          if (opts?.isCurrentOwner && !opts.isCurrentOwner()) return false;
          setPaneMessages(pane.id, merged);
          recordProgressActivity();
        }
        return changed;
      } catch {
        /* best effort */
        return false;
      }
    },
    [pane.id, recordProgressActivity, setPaneMessages]
  );

  /**
   * FR-4 live reattach: when re-entering a still-running session with no active
   * foreground SSE, subscribe to the read-only reattach endpoint to resume
   * token-level streaming in real time. Structured content (tool cards, refs,
   * group progress) is reconciled from disk when the stream ends. Falls back to
   * disk polling on any error or when the feature flag is off.
   */
  const reattachLiveStream = useCallback(
    async (sid: string): Promise<void> => {
      if (!sid || !apiBase) return;
      // A user stop owns the session until its interrupt settles. Do not let
      // the background poller reopen a reader in that interval: it would
      // create a newer stream lease while the stop result is still deciding
      // whether it may update the displayed Team state.
      if (stopInFlightRef.current[sid]) return;
      if (reattachControllersRef.current[sid]) return; // already reattached
      if (sessionStreamStateRef.current[sid]?.active) return; // foreground stream owns it
      if (sessionStreamOwnersRef.current[sid]?.kind === "foreground") return;
      const ctrl = new AbortController();
      const reattachGeneration = claimSessionStreamOwner(
        sessionStreamOwnersRef.current,
        sessionStreamGenerationsRef.current,
        sid,
        "reattach",
        ctrl,
      );
      if (!reattachGeneration) return;
      reattachControllersRef.current[sid] = ctrl;
      const prior = sessionStreamStateRef.current[sid];
      let liveText = prior?.text ?? "";
      sessionStreamStateRef.current[sid] = {
        active: true,
        text: liveText,
        provider: prior?.provider ?? "",
        model: prior?.model ?? "",
      };
      const ownsReattachStream = () =>
        ownsSessionStreamOwner(
          sessionStreamOwnersRef.current,
          sid,
          "reattach",
          reattachGeneration,
          ctrl,
        );
      const isCurrent = () => {
        const currentPane = useAppStore.getState().panes.find((row) => row.id === pane.id);
        return (currentPane?.sessionId || "").trim() === sid;
      };
      const isCurrentOwned = () => ownsReattachStream() && isCurrent();
      if (isCurrentOwned()) syncStreamingUiForCurrentSession();
      let lastSeq = reattachLastSeqRef.current[sid] ?? 0;
      let reachedTerminal = false;
      let replayGap = false;
      try {
        const resp = await fetch(reattachSessionStreamUrl(apiBase, sid, lastSeq), {
          headers: { "x-agx-desktop-token": apiToken },
          signal: ctrl.signal,
        });
        const reader = resp.ok ? resp.body?.getReader() : undefined;
        if (!reader) return;
        const decoder = new TextDecoder();
        let buffer = "";
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split("\n\n");
          buffer = frames.pop() ?? "";
          for (const frame of frames) {
            // The foreground force-send can take over this same session while
            // read() is resolving.  Session id equality is not enough here:
            // stale readers must not advance the shared cursor or write UI.
            if (!ownsReattachStream()) continue;
            const { eventId, payload } = parseSseFrame(frame);
            const sequence = advanceReattachSequence(lastSeq, eventId);
            if (!sequence.accept) continue;
            lastSeq = sequence.nextSeq;
            reattachLastSeqRef.current[sid] = lastSeq;
            if (!payload || typeof payload !== "object") continue;
            const p = payload as {
              type?: string;
              action?: string;
              run_id?: string;
              graph_run_id?: string;
              data?: Record<string, unknown>;
            };
            recordSseActivity(sid);
            if (!p.type && p.action) {
              if (isCurrentOwned()) applyGroupTeamControlEvent(p.action, p.data, sid);
              continue;
            }
            if (p.type === "replay_gap") {
              // The missing prefix cannot be reconstructed token-by-token.
              // Drop overlays and let persisted history be authoritative while
              // still consuming later control/final events from this stream.
              replayGap = true;
              liveText = "";
              const state = sessionStreamStateRef.current[sid];
              if (state) state.text = "";
              if (isCurrentOwned()) {
                setStreamedAssistantText("");
                groupStreamTextRef.current = {};
                setGroupStreamText({});
              }
              continue;
            }
            if (p.type === "done") {
              reachedTerminal = true;
              const current = isCurrentOwned();
              const localControlState = groupTeamControlStateForSession(
                groupTeamControlStateBySessionRef.current,
                sid,
              );
              const liveGraphControlState = current
                ? groupTeamControlStateFromGraph(
                    useGraphRunStore.getState().byPane[pane.id],
                  )
                : "idle";
              const controlState =
                localControlState !== "idle"
                  ? localControlState
                  : current
                    ? liveGraphControlState !== "idle"
                      ? liveGraphControlState
                      : "idle"
                    : "idle";
              const incomingRunId = String(
                p.run_id ?? p.graph_run_id ?? p.data?.run_id ?? p.data?.graph_run_id ?? "",
              ).trim();
              const terminalReason =
                p.data?.terminal_reason ?? p.data?.terminalReason ?? p.data?.reason;
              if (
                current &&
                isGroupPane &&
                shouldApplyTeamControlDoneEvent({
                  controlState,
                  currentRunId: currentGroupGraphRunId(sid),
                  incomingRunId,
                  terminalReason,
                  isCurrentOwner: current,
                })
              ) {
                setGroupTeamControlStateForSession(sid, "stopped");
              }
            }
            if (p.type === "token" && (p.data?.agent_id ?? "meta") === "meta") {
              if (replayGap) continue;
              const t = String(p.data?.text ?? "").replace(/⏳\s*/g, "");
              if (!t) continue;
              liveText += t;
              const st = sessionStreamStateRef.current[sid];
              if (st) st.text = liveText;
              if (isCurrentOwned()) setStreamedAssistantText(liveText);
            }
            const eventAgentId = String(p.data?.agent_id ?? "").trim();
            if (isCurrentOwned() && p.type === "group_typing" && eventAgentId) {
              handoffGroupCoordinatorToMember(eventAgentId);
              const avatarName = String(p.data?.avatar_name ?? eventAgentId);
              setGroupTyping((previous) => ({ ...previous, [eventAgentId]: avatarName }));
              setGroupMemberPhase((previous) => withoutGroupAgent(previous, eventAgentId));
              continue;
            }
            if (isCurrentOwned() && p.type === "group_token" && eventAgentId) {
              if (replayGap) continue;
              handoffGroupCoordinatorToMember(eventAgentId);
              const avatarName = String(p.data?.avatar_name ?? eventAgentId);
              const tokenText = String(p.data?.content ?? p.data?.text ?? "").replace(/⏳\s*/g, "");
              if (tokenText) {
                setGroupTyping((previous) => ({ ...previous, [eventAgentId]: avatarName }));
                groupStreamTextRef.current[eventAgentId] =
                  (groupStreamTextRef.current[eventAgentId] ?? "") + tokenText;
                setGroupStreamText({ ...groupStreamTextRef.current });
              }
              continue;
            }
            if (isCurrentOwned() && p.type === "group_progress" && eventAgentId) {
              handoffGroupCoordinatorToMember(eventAgentId);
              const avatarName = String(p.data?.avatar_name ?? eventAgentId);
              const progressText = String(p.data?.content ?? "").trim();
              const workflowRole = String(p.data?.workflow_role ?? "").trim();
              const workflowPrefix =
                workflowRole === "reviewer" ? "审核中：" : workflowRole === "executor" ? "执行中：" : "";
              setGroupTyping((previous) => ({ ...previous, [eventAgentId]: avatarName }));
              if (shouldResetGroupStreamOnProgress(String(p.data?.tool_phase ?? ""))) {
                clearGroupStreamForAgent(eventAgentId);
              }
              if (
                progressText &&
                !/^开始处理任务/.test(progressText) &&
                !/^已接收任务/.test(progressText)
              ) {
                setGroupActivityHint((previous) => ({
                  ...previous,
                  [eventAgentId]: `${workflowPrefix}${progressText}`,
                }));
              }
              setGroupMemberPhase((previous) => withoutGroupAgent(previous, eventAgentId));
              continue;
            }
            if (p.type === "group_workflow_detail") {
              if (isCurrentOwned()) {
                applyGroupTeamControlEvent(p.type, p.data, sid);
                applyGroupWorkflowDetailPayload(p.data);
              }
              // Private workflow details belong to the project panel lane. They
              // must never be replayed as chat bubbles or durable room rows.
              continue;
            }
            if (
              typeof p.type === "string" &&
              (p.type.startsWith("workforce.") || p.type.startsWith("workforce_"))
            ) {
              if (isCurrentOwned()) applyGroupTeamControlEvent(p.type, p.data, sid);
              continue;
            }
            if (typeof p.type === "string" && p.type.startsWith("graph.")) {
              const normalizedGraphPayload = normalizeGroupGraphPayload(p.type, p.data);
              // The group graph bridge may omit scope on replayed events. The
              // exact reattach owner has already admitted this frame, so stamp
              // the pane's canonical scope before handing it to the store;
              // otherwise RunGraphPanel treats the state as unowned and hides it.
              const graphPayload = {
                ...normalizedGraphPayload,
                session_id:
                  String(normalizedGraphPayload.session_id ?? "").trim() || sid,
                group_id:
                  String(normalizedGraphPayload.group_id ?? "").trim() || groupChatId || "",
              } as GraphSsePayload;
              if (
                isCurrentOwned() &&
                acceptsGroupGraphEvent(sid, graphPayload, {
                  allowRunSwitch: p.type === "graph.run_created",
                  authoritative: isCurrentOwned(),
                })
              ) {
                useGraphRunStore.getState().applyEvent(pane.id, graphPayload, {
                  trustedOwner: { sessionId: sid, groupId: groupChatId || "" },
                });
                const runId = String(graphPayload.run_id ?? "").trim();
                if (p.type === "graph.run_created" && runId) {
                  rememberGroupGraphRunId(sid, runId);
                }
              }
              // Graph events are project-panel state, never chat rows.
              continue;
            }
            if (p.type === "group_reaction") {
              if (isCurrentOwned()) {
                applyGroupReactionPayload(sid, p.data);
                // A human reaction is an out-of-band update and must not clear
                // the coordinator/member status for the active workflow. A
                // member's own reaction action can still terminate that member
                // turn when the backend supplies its concrete agent id.
                const reactionAgentId = String(eventAgentId || "").trim();
                if (reactionAgentId && !["meta", "user"].includes(reactionAgentId)) {
                  clearGroupStreamForAgent(reactionAgentId);
                  setGroupTyping((previous) => withoutGroupAgent(previous, reactionAgentId));
                  setGroupActivityHint((previous) => withoutGroupAgent(previous, reactionAgentId));
                  setGroupMemberPhase((previous) => withoutGroupAgent(previous, reactionAgentId));
                }
              }
              continue;
            }
            if (p.type === "group_user_accepted") {
              if (isCurrentOwned()) {
                applyGroupUserAcceptedPayload(sid, p.data);
              }
              // This is a control event for the optimistic user bubble, not a
              // public message to append to the reattached timeline.
              continue;
            }
            if (p.type === "group_pass") {
              if (isCurrentOwned() && eventAgentId) {
                clearGroupStreamForAgent(eventAgentId);
                setGroupTyping((previous) => withoutGroupAgent(previous, eventAgentId));
                setGroupActivityHint((previous) => withoutGroupAgent(previous, eventAgentId));
                setGroupMemberPhase((previous) => withoutGroupAgent(previous, eventAgentId));
              }
              continue;
            }
            if (p.type === "group_reply" || p.type === "group_skipped") {
              if (isCurrentOwned() && eventAgentId) {
                clearGroupStreamForAgent(eventAgentId);
                setGroupTyping((previous) => withoutGroupAgent(previous, eventAgentId));
                setGroupActivityHint((previous) => withoutGroupAgent(previous, eventAgentId));
                setGroupMemberPhase((previous) => withoutGroupAgent(previous, eventAgentId));
              }
              // Group replies are persisted mid-turn; merge via disk so ids stay
              // aligned instead of minting live rows. Debounce to avoid thrash.
              const prevTimer = reattachGroupMergeTimersRef.current[sid];
              if (prevTimer != null) window.clearTimeout(prevTimer);
              reattachGroupMergeTimersRef.current[sid] = window.setTimeout(() => {
                delete reattachGroupMergeTimersRef.current[sid];
                if (!ownsReattachStream()) return;
                void mergeTailFromDisk(sid, {
                  allowDuringStream: true,
                  isCurrentOwner: ownsReattachStream,
                });
              }, 300);
              continue;
            }
            // done/final/replay_gap/graph.*/group_typing: disk merge in finally.
          }
        }
      } catch {
        /* aborted or network error — disk merge below reconciles state */
      } finally {
        let nextQueued: QueuedMessage | null = null;
        if (reattachControllersRef.current[sid] === ctrl) {
          delete reattachControllersRef.current[sid];
        }
        // A foreground force-send can take over this same session while the
        // old reader is unwinding.  Its finally must not clear the new stream,
        // cursor, Team state, or visible overlays.
        if (!ownsReattachStream()) return;
        const mergeTimer = reattachGroupMergeTimersRef.current[sid];
        if (mergeTimer != null) {
          window.clearTimeout(mergeTimer);
          delete reattachGroupMergeTimersRef.current[sid];
        }
        const st = sessionStreamStateRef.current[sid];
        if (st) {
          st.active = false;
          if (reachedTerminal) st.text = "";
        }
        if (reachedTerminal) delete reattachLastSeqRef.current[sid];
        if (isCurrent()) {
          setStreamedAssistantText("");
          setGroupTyping({});
          setGroupActivityHint({});
          setGroupMemberPhase({});
          groupStreamTextRef.current = {};
          setGroupStreamText({});
          syncStreamingUiForCurrentSession();
        }
        // Keep the lease until the disk reconciliation finishes. If a
        // foreground force-send claims the session while the load is in
        // flight, the guarded merge becomes a no-op and this old finally must
        // not delete the replacement owner.
        await mergeTailFromDisk(sid, { isCurrentOwner: ownsReattachStream });
        if (!ownsReattachStream()) return;
        // A follow-up can be queued while the read-only reattach owns the
        // session. Once a real terminal event is observed, retire exactly one
        // message for this session and hand it to the existing locked send
        // path. If the pane navigated to B before this point, leave A queued;
        // the locked path will also requeue if navigation wins during the RAF.
        if (reachedTerminal) {
          const currentPane = useAppStore.getState().panes.find((row) => row.id === pane.id);
          if (isPaneDisplayingSession(currentPane, pane.id, sid)) {
            nextQueued = useAppStore.getState().dequeuePaneMessageForSession(pane.id, sid) ?? null;
          }
        }
        delete sessionStreamOwnersRef.current[sid];
        if (nextQueued) {
          const queued = nextQueued;
          requestAnimationFrame(() => {
            const currentPane = useAppStore.getState().panes.find((row) => row.id === pane.id);
            if (!isPaneDisplayingSession(currentPane, pane.id, sid)) {
              // The terminal callback can race a navigation between dequeue
              // and RAF. Put the exact item back instead of allowing a hidden
              // A continuation to resolve against B.
              enqueuePaneMessage(pane.id, queued);
              return;
            }
            void sendChatRef.current(queued.text, {
              lockedSessionId: sid,
              retryAttachments: queued.attachments,
              queueDrain: true,
            });
          });
        }
      }
    },
    [
      applyGroupReactionPayload,
      applyGroupTeamControlEvent,
      applyGroupUserAcceptedPayload,
      applyGroupWorkflowDetailPayload,
      acceptsGroupGraphEvent,
      activeGroup?.routing,
      apiBase,
      apiToken,
      clearGroupStreamForAgent,
      currentGroupGraphRunId,
      enqueuePaneMessage,
      groupChatId,
      handoffGroupCoordinatorToMember,
      mergeTailFromDisk,
      isGroupPane,
      rememberGroupGraphRunId,
      pane.id,
      pane.sessionId,
      recordSseActivity,
      setGroupTeamControlStateForSession,
      syncStreamingUiForCurrentSession,
    ]
  );

  useEffect(() => {
    let cancelled = false;
    const enteredAt = Date.now();
    const sid = (pane.sessionId || "").trim();
    const switchKey = sid || `__awaiting_fresh__:${pane.id}`;

    if (shouldResetStallDetectorsOnSessionSwitch(lastStallBaselineSessionRef.current, switchKey)) {
      lastStallBaselineSessionRef.current = switchKey;
      if (sid) prevExecutionStateBySidRef.current[sid] = "idle";
      setStallState("none");
      setStallRejectReason("");
      setStallTick((t) => t + 1);
      setSessionExecutionState("idle");
      setLastToolProgress(null);
      setStallWait(null);
      setContextLoopStats(null);

      if (sid) {
        const streamActive = Boolean(sessionStreamStateRef.current[sid]?.active);
        const priorProgress = sessionProgressAtRef.current[sid] ?? 0;
        if (priorProgress > 0) {
          lastProgressAtRef.current = priorProgress;
          lastSseEventAtRef.current = priorProgress;
        } else {
          lastProgressAtRef.current = enteredAt;
          lastSseEventAtRef.current = enteredAt;
        }
        if (streamActive) {
          setRunGuardSessionId(sid);
        }
      } else {
        lastProgressAtRef.current = enteredAt;
        lastSseEventAtRef.current = enteredAt;
      }
    }

    syncStreamingUiForCurrentSession();

    if (!sid) {
      return () => {
        cancelled = true;
      };
    }

    sessionEnteredAtRef.current[sid] = enteredAt;
    setAutoNudgeCount(autoNudgeTriggeredRef.current[sid] ?? 0);
    const legacyUnattended = (pane.messages ?? []).filter(
      (m) =>
        m.role === "tool" &&
        typeof m.content === "string" &&
        (m.content.includes("无人值守续跑") || m.content.includes("自动续跑提醒")),
    ).length;
    const priorUnattended = Math.max(
      legacyUnattended,
      maxContinuationRound(pane.messages ?? []),
    );
    unattendedContinueTriggeredRef.current[sid] = priorUnattended;
    setUnattendedContinueCount(priorUnattended);
    void window.agenticxDesktop.listSessions(pane.avatarId ?? undefined).then((r) => {
      if (cancelled) return;
      if (!r.ok) return;
      const row = (r.sessions ?? []).find((s) => s.session_id === sid);
      const st = (row?.execution_state ?? "idle") as SessionExecutionState;
      setSessionExecutionState(st);
      prevExecutionStateBySidRef.current[sid] = st;
      if (st === "running") {
        setRunGuardSessionId(sid);
        if (sessionStreamStateRef.current[sid]?.active) {
          syncStreamingUiForCurrentSession();
        } else {
          void mergeTailFromDisk(sid);
          if (liveReattachEnabledRef.current) void reattachLiveStream(sid);
        }
      } else if (!sessionStreamStateRef.current[sid]?.active) {
        void reconcileDisplayedSessionFromDisk(sid);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [
    mergeTailFromDisk,
    reattachLiveStream,
    reconcileDisplayedSessionFromDisk,
    pane.id,
    pane.sessionId,
    pane.avatarId,
    syncStreamingUiForCurrentSession,
  ]);

  useEffect(() => {
    const sid = (pane.sessionId || "").trim();
    if (!sid) return;
    let cancelled = false;
    let timer: number | undefined;

    const syncBackgroundRun = async () => {
      if (cancelled) return;
      const sseActive = Boolean(sessionStreamStateRef.current[sid]?.active);
      if (sseActive) return;
      try {
        const r = await window.agenticxDesktop.listSessions(pane.avatarId ?? undefined);
        if (cancelled || !r.ok) return;
        const row = (r.sessions ?? []).find((s) => s.session_id === sid);
        const execState = (row?.execution_state ?? "idle") as SessionExecutionState;
        if (execState !== "running") return;
        setRunGuardSessionId(sid);
        if (liveReattachEnabledRef.current) {
          // Live reattach takes over: marks the stream active (gating future
          // ticks) and resumes token-level streaming until the run ends.
          void reattachLiveStream(sid);
          return;
        }
        // mergeTailFromDisk only refreshes the progress timer when it actually
        // appends new rows; do NOT unconditionally record activity here, or a
        // backend that has silently hung would never trip the stall card.
        await mergeTailFromDisk(sid);
      } catch {
        /* best effort */
      }
    };

    void syncBackgroundRun();
    timer = window.setInterval(() => void syncBackgroundRun(), 2000);
    return () => {
      cancelled = true;
      if (timer != null) window.clearInterval(timer);
      // Invalidate before aborting so a buffered A frame cannot win the
      // A→B→A hand-off, and the returning A pane can claim a fresh lease
      // immediately instead of waiting for the old reader's finally.
      invalidateReattachStreamForSession(sid);
    };
  }, [
    invalidateReattachStreamForSession,
    mergeTailFromDisk,
    reattachLiveStream,
    pane.avatarId,
    pane.sessionId,
  ]);

  useEffect(() => {
    const sid = (pane.sessionId || "").trim();
    const found = findBudgetExceededInMessages(pane.messages ?? []);
    if (found) {
      setBudgetExceededInfo({ ...found, sessionId: sid || found.sessionId });
    } else {
      setBudgetExceededInfo(null);
    }
  }, [pane.messages, pane.sessionId]);

  useEffect(() => {
    if ((pane.messages ?? []).length > 0) {
      recordProgressActivity();
    }
  }, [pane.messages?.length, recordProgressActivity]);

  /**
   * Atomically claim the live stream buffer into pane.messages before any
   * interrupt/abort clears the overlay. Without this, Stop leaves a blank
   * transcript until the user switches sessions and reloads from disk.
   */
  const preserveUncommittedStreamPartial = useCallback(
    (sid: string, provider?: string, model?: string): boolean => {
      if (!sid) return false;
      const claimedRaw = streamCommitRegistryRef.current.claimUncommittedText(sid);
      let partial = (claimedRaw ?? "").trim().replace(/[：:]\s*$/, "").trimEnd();
      if (!partial && !streamCommitRegistryRef.current.isCommitted(sid)) {
        const fromRef = streamTextRef.current.trim();
        const fromState = String(sessionStreamStateRef.current[sid]?.text ?? "").trim();
        const fallback = (fromRef || fromState)
          .replace(/[：:]\s*$/, "")
          .trimEnd();
        if (
          fallback &&
          fallback !== "⏹ 正在中断..." &&
          !isThinkingPlaceholderText(fallback) &&
          !isStreamToolLabelOnlyText(fallback)
        ) {
          streamCommitRegistryRef.current.markCommitted(sid);
          partial = fallback;
        }
      }
      if (
        !partial ||
        isThinkingPlaceholderText(partial) ||
        isStreamToolLabelOnlyText(partial)
      ) {
        return false;
      }
      const parsed = parseReasoningContent(partial);
      const reasoningText = parsed.reasoning.trim();
      const bodyContent = parsed.response.replace(/[：:]\s*$/, "").trimEnd();
      const commitExtras: Record<string, unknown> = {
        ownerSessionId: sid,
        metadata: buildInterruptedAssistantMetadata(),
      };
      let commitContent = partial;
      if (reasoningText) {
        commitExtras.reasoning = reasoningText.slice(0, 16384);
        commitContent = bodyContent;
      }
      if (!commitContent.trim() || isStreamToolLabelOnlyText(commitContent)) {
        return false;
      }
      addPaneMessage(
        pane.id,
        "assistant",
        commitContent,
        "meta",
        provider,
        model,
        undefined,
        commitExtras,
      );
      streamCommitRegistryRef.current.setMidCommit(sid, partial);
      return true;
    },
    [addPaneMessage, pane.id],
  );

  /**
   * Claim a group's visible member output before Stop/barge-in clears the
   * overlay, then persist the same rows through the authenticated append path.
   * The rows intentionally carry no group feed id/public flag: they are
   * recoverable transcript context, not fake completed public replies.
   */
  const preserveGroupInterruptedPartials = useCallback(
    (
      sid: string,
      trigger: GroupInterruptionTrigger,
      provider?: string,
      model?: string,
    ): Promise<boolean> => {
      if (!isGroupPane || !sid) return Promise.resolve(false);

      const partials = collectGroupInterruptedPartials(groupStreamTextRef.current, groupMembers);
      const historyMessages = buildGroupInterruptedHistoryMessages(partials, trigger);

      // Capture and render synchronously, before the caller aborts the stream.
      clearAllGroupMemberStatus();
      for (const partial of partials) {
        addPaneMessage(
          pane.id,
          "assistant",
          partial.content,
          partial.agentId,
          provider,
          model,
          undefined,
          {
            avatarName: partial.avatarName,
            avatarUrl: partial.avatarUrl,
            ownerSessionId: sid,
            metadata: historyMessages.find(
              (message) => message.role === "assistant" && message.agent_id === partial.agentId,
            )?.metadata,
          },
        );
      }
      const interruptionNotice = historyMessages[historyMessages.length - 1];
      addPaneMessage(
        pane.id,
        "tool",
        interruptionNotice.content,
        interruptionNotice.agent_id,
        provider,
        model,
        undefined,
        {
          ownerSessionId: sid,
          metadata: interruptionNotice.metadata,
        },
      );

      const base = String(apiBase ?? "").replace(/\/+$/, "");
      if (!base || !apiToken) {
        const currentPane = useAppStore.getState().panes.find((row) => row.id === pane.id);
        if (isPaneDisplayingSession(currentPane, pane.id, sid)) {
          setStallHintToast("群聊中断上下文保存失败：后端连接未就绪");
        }
        return Promise.resolve(false);
      }

      return (async () => {
        try {
          const response = await fetch(`${base}/api/session/messages/append`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-agx-desktop-token": apiToken,
            },
            body: JSON.stringify({ session_id: sid, messages: historyMessages }),
          });
          const raw = await response.text().catch(() => "");
          let result: Record<string, unknown> = {};
          try {
            const parsed = raw ? JSON.parse(raw) : null;
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
              result = parsed as Record<string, unknown>;
            }
          } catch {
            // The status/body check below reports malformed success responses.
          }
          const appended = Number(result.appended);
          if (!response.ok || result.ok === false || !Number.isFinite(appended) || appended !== historyMessages.length) {
            const detail = String(result.detail ?? result.error ?? "").trim();
            const countHint = Number.isFinite(appended)
              ? `（已保存 ${appended}/${historyMessages.length} 条）`
              : "";
            throw new Error(
              `HTTP ${response.status}${detail ? `: ${detail.slice(0, 180)}` : ""}${countHint}`,
            );
          }
          return true;
        } catch (err) {
          const reason = String(err instanceof Error ? err.message : err).trim() || "未知错误";
          console.warn("[GroupInterrupt] append interrupted context failed:", err);
          const currentPane = useAppStore.getState().panes.find((row) => row.id === pane.id);
          if (isPaneDisplayingSession(currentPane, pane.id, sid)) {
            setStallHintToast(`群聊中断上下文保存失败：${reason.slice(0, 180)}`);
          }
          return false;
        }
      })();
    },
    [addPaneMessage, apiBase, apiToken, clearAllGroupMemberStatus, groupMembers, isGroupPane, pane.id],
  );

  const stopCurrentRun = useCallback(async () => {
    // Prefer the session currently shown in this pane. `streamingSessionId`
    // can still point at A for one render after navigation to B; stopping from
    // B must never abort or repaint A.
    const sid = (pane.sessionId || streamingSessionId || "").trim();
    if (!sid) return;
    if (stopInFlightRef.current[sid]) return;

    // Capture the foreground epoch before invalidating the old stream. A late
    // interrupt response belongs to this stop only while no newer foreground
    // send has claimed the session. Reattach readers intentionally do not
    // advance this epoch.
    const stopForegroundGeneration =
      foregroundStreamGenerationsRef.current[sid] ?? 0;
    const stopStreamOwner = sessionStreamOwnersRef.current[sid];
    let stopTailMergePending = false;
    let shouldReattachAfterFailure = false;

    const stopLease: StopRunLease = {
      generation: ++stopRunGenerationRef.current,
      paneId: String(pane.id).trim(),
      sessionId: sid,
    };
    stopRunLeasesRef.current[sid] = stopLease;
    const ownsStopEpoch = () =>
      stopRunLeasesRef.current[sid] === stopLease &&
      isForegroundRunGenerationCurrent(
        foregroundStreamGenerationsRef.current[sid],
        stopForegroundGeneration,
      );
    const ownsCurrentStopLease = () => {
      const currentPane = useAppStore.getState().panes.find((row) => row.id === pane.id);
      return ownsStopEpoch() && ownsStopRunLease(stopRunLeasesRef.current[sid], stopLease, currentPane);
    };
    if (!ownsCurrentStopLease()) {
      if (stopRunLeasesRef.current[sid] === stopLease) {
        delete stopRunLeasesRef.current[sid];
      }
      return;
    }

    const previousTeamControlState = isGroupPane
      ? effectiveGroupTeamControlState
      : "idle";
    const previousUserStopped = Boolean(userStoppedSessionRef.current[sid]);
    const previousRunGuardSessionId = runGuardSessionId;

    stopInFlightRef.current[sid] = true;
    setStoppingSessionId(sid);
    userStoppedSessionRef.current[sid] = true;
    setRunGuardSessionId(sid);
    setStallState("none");

    // Commit visible partial BEFORE wiping overlay / aborting SSE — otherwise a stop
    // during streaming loses whatever was already on screen until the next session load.
    const groupInterruptedPersistence = isGroupPane
      ? preserveGroupInterruptedPartials(
          sid,
          "stop",
          streamingModel?.provider || chatProvider || undefined,
          streamingModel?.model || chatModel || undefined,
        )
      : null;
    if (!isGroupPane) {
      preserveUncommittedStreamPartial(
        sid,
        streamingModel?.provider || chatProvider || undefined,
        streamingModel?.model || chatModel || undefined,
      );
    }

    const st = sessionStreamStateRef.current[sid];
    if (st) {
      st.text = "⏹ 正在中断...";
      st.active = false;
      sessionStreamStateRef.current[sid] = st;
    }
    // The global abort ref only points at foreground sends. A session may be
    // active through the read-only reattach path after the user returns to it,
    // so invalidate and abort that owner explicitly before aborting foreground.
    invalidateReattachStreamForSession(sid);
    const targetAbortController = sessionAbortControllersRef.current[sid];
    if (targetAbortController) {
      targetAbortController.abort();
      if (abortRef.current === targetAbortController) abortRef.current = null;
      // Abort delivery does not synchronously run the old reader's finally.
      // Release only the exact owner/controller captured by this stop; a
      // newer foreground claim (if any) must remain untouched.
      if (sessionAbortControllersRef.current[sid] === targetAbortController) {
        delete sessionAbortControllersRef.current[sid];
      }
    }
    if (stopStreamOwner && sessionStreamOwnersRef.current[sid] === stopStreamOwner) {
      delete sessionStreamOwnersRef.current[sid];
    }
    // Stopping is also a local UI action. Mark the exact group session stopped
    // immediately after aborting the foreground stream so a stalled/recovery
    // card cannot leave Team controls mounted while the backend catches up.
    if (isGroupPane) {
      setGroupTeamControlStateForSession(sid, "stopped");
    }
    if (isGroupPane) clearAllGroupMemberStatus();
    if (ownsCurrentStopLease()) {
      setStreamedAssistantText("⏹ 正在中断...");
      setStreaming(false);
      setStreamingSessionId("");
    }

    try {
      const r = await window.agenticxDesktop.interruptSession?.(sid);
      if (groupInterruptedPersistence) await groupInterruptedPersistence;
      if (r?.ok) {
        // The pane may have navigated while interrupt/persistence was in
        // flight. The old stop can finish its durable A work, but it no
        // longer owns any pane/UI projection once A is no longer displayed.
        if (!ownsCurrentStopLease()) return;
        if (isGroupPane) {
          setGroupTeamControlStateForSession(sid, "stopped");
        }
        setSessionExecutionState("interrupted");
        setStallState("none");
        // Stop must clear the optimistic "running" hint immediately so the
        // history sidebar spinner disappears at once instead of waiting for the
        // 1.5s list poll (which can lag behind a bloated session list query).
        useAppStore.getState().clearSessionHistoryHint(sid);
        // Backend persists turn_interrupted asynchronously; retry disk merge so
        // the「已中断 / 恢复执行」card appears without requiring a session switch.
        invalidateSessionTail(sid);
        stopTailMergePending = true;
        void (async () => {
          try {
            for (const delayMs of [150, 450, 1000]) {
              await new Promise((resolve) => window.setTimeout(resolve, delayMs));
              if (!ownsStopEpoch()) return;
              // The interrupted session may be off-screen during a retry. Keep
              // the short-lived lease alive so returning to A within the
              // window can still hydrate its terminal card, while never
              // merging A into the displayed B pane.
              if (!ownsCurrentStopLease()) continue;
              await mergeTailFromDisk(sid, { isCurrentOwner: ownsCurrentStopLease });
            }
          } finally {
            if (stopRunLeasesRef.current[sid] === stopLease) {
              delete stopRunLeasesRef.current[sid];
            }
          }
        })();
      } else {
        if (!ownsCurrentStopLease()) return;
        userStoppedSessionRef.current[sid] = previousUserStopped;
        if (isGroupPane) {
          // `interruptSession` can fail after the local stop projection has
          // already hidden Team controls. Restore the exact Team state that
          // was visible before this attempt; an uncertain stop is not a real
          // stopped terminal state.
          setGroupTeamControlStateForSession(sid, previousTeamControlState);
        }
        setRunGuardSessionId(previousRunGuardSessionId);
        addPaneMessage(
          pane.id,
          "tool",
          `⚠️ 中断失败：${r?.error ?? "未知错误"}`,
          "meta"
        );
        shouldReattachAfterFailure = true;
      }
    } catch (err) {
      if (groupInterruptedPersistence) await groupInterruptedPersistence;
      if (!ownsCurrentStopLease()) return;
      userStoppedSessionRef.current[sid] = previousUserStopped;
      if (isGroupPane) {
        setGroupTeamControlStateForSession(sid, previousTeamControlState);
      }
      setRunGuardSessionId(previousRunGuardSessionId);
      addPaneMessage(pane.id, "tool", `⚠️ 中断失败：${String(err)}`, "meta");
      shouldReattachAfterFailure = true;
    } finally {
      const ownsStopAtFinally = ownsCurrentStopLease();
      if (!stopTailMergePending && stopRunLeasesRef.current[sid] === stopLease) {
        stopInFlightRef.current[sid] = false;
        delete stopRunLeasesRef.current[sid];
      } else if (stopRunLeasesRef.current[sid] === stopLease) {
        // The tail retry owns the lease after this function returns, but the
        // foreground stop slot is no longer blocking a user send.
        stopInFlightRef.current[sid] = false;
      }
      if (ownsStopAtFinally) {
        setStoppingSessionId((current) => (current === sid ? "" : current));
      }
      if (
        shouldReattachAfterFailure &&
        ownsStopAtFinally &&
        !stopInFlightRef.current[sid] &&
        !sessionStreamStateRef.current[sid]?.active &&
        liveReattachEnabledRef.current
      ) {
        // Start only after the stop slot is released. The reattach path itself
        // also checks the slot, so it cannot race this stop's final cleanup.
        void reattachLiveStream(sid);
      }
    }
  }, [
    addPaneMessage,
    chatModel,
    chatProvider,
    mergeTailFromDisk,
    invalidateReattachStreamForSession,
    pane.id,
    pane.sessionId,
    clearAllGroupMemberStatus,
    isGroupPane,
    effectiveGroupTeamControlState,
    preserveGroupInterruptedPartials,
    preserveUncommittedStreamPartial,
    runGuardSessionId,
    setGroupTeamControlStateForSession,
    reattachLiveStream,
    streamingModel?.model,
    streamingModel?.provider,
    streamingSessionId,
  ]);

  const interruptForResume = useCallback(
    async (sid: string) => {
      const requestPaneId = pane.id;
      const isDisplayed = () => {
        const currentPane = useAppStore.getState().panes.find((row) => row.id === requestPaneId);
        return isPaneDisplayingSession(currentPane, requestPaneId, sid);
      };
      // A resume/retry continuation belongs to the pane/session that initiated
      // it. If navigation won the race before the destructive interrupt starts,
      // leave the now-hidden session untouched instead of interrupting A from B.
      if (!isDisplayed()) return;
      // Resume replaces any read-only reattach with a foreground request.
      // Invalidate the lease before aborting so buffered old frames cannot
      // advance the cursor or update Team/UI during the hand-off.
      invalidateReattachStreamForSession(sid);
      const prevAbort = sessionAbortControllersRef.current[sid];
      if (prevAbort) {
        try {
          prevAbort.abort();
        } catch {
          /* already aborted */
        }
        delete sessionAbortControllersRef.current[sid];
      }
      const st = sessionStreamStateRef.current[sid];
      if (st) {
        st.active = false;
        st.text = "";
        sessionStreamStateRef.current[sid] = st;
      }
      if (isDisplayed()) {
        syncStreamingUiForCurrentSession();
      }
      try {
        await window.agenticxDesktop.interruptSession?.(sid);
      } catch {
        /* best effort */
      }
    },
    [invalidateReattachStreamForSession, pane.id, syncStreamingUiForCurrentSession]
  );

  const retryUserMessage = useCallback(
    async (msg: Message) => {
      if (msg.role !== "user") return;
      const requestPaneId = pane.id;
      const sid = (pane.sessionId || "").trim();
      if (!sid || !apiBase) return;
      const isDisplayed = () => {
        const currentPane = useAppStore.getState().panes.find((row) => row.id === requestPaneId);
        return isPaneDisplayingSession(currentPane, requestPaneId, sid);
      };
      if (!isDisplayed()) return;
      if (retryInFlightRef.current[sid]) return;
      retryInFlightRef.current[sid] = true;
      try {
        await interruptForResume(sid);
        if (!isDisplayed()) return;
        await new Promise((resolve) => window.setTimeout(resolve, 60));
        if (!isDisplayed()) return;

        const msgs =
          useAppStore.getState().panes.find((row) => row.id === requestPaneId)?.messages ?? [];
        const idx = msgs.findIndex((m) => m.id === msg.id);
        if (idx < 0) return;
        const liveMessage = msgs[idx];
        if (!liveMessage || liveMessage.role !== "user") return;
        const userOccurrence = countUserOccurrenceThrough(msgs, idx, liveMessage.content);
        const expectRemoved = hasTrailingTurnMessages(msgs, idx);
        const ok = await truncateSessionAtUserMessage(
          sid,
          liveMessage.content,
          "after",
          userOccurrence,
          expectRemoved
        );
        if (!isDisplayed()) return;
        if (!ok) {
          if (isDisplayed()) {
            addPaneMessage(
              requestPaneId,
              "tool",
              "⚠️ 重试失败：无法裁剪会话历史，请稍后再试。",
              "meta"
            );
          }
          await reloadSessionFromDisk(sid, { isCurrentOwner: isDisplayed });
          return;
        }
        if (!isDisplayed()) return;
        setPaneMessages(requestPaneId, msgs.slice(0, idx + 1));
        if (!isDisplayed()) return;
        await sendChatRef.current(liveMessage.content, {
          lockedSessionId: sid,
          retryAttachments: liveMessage.attachments ?? [],
          suppressUserEcho: true,
          skipUserHistory: true,
          forceSend: true,
        });
      } catch (err) {
        console.error("[ChatPane] retry user message failed:", err);
        if (isDisplayed()) {
          addPaneMessage(requestPaneId, "tool", `⚠️ 重试失败：${String(err)}`, "meta");
        }
      } finally {
        retryInFlightRef.current[sid] = false;
      }
    },
    [
      addPaneMessage,
      apiBase,
      countUserOccurrenceThrough,
      hasTrailingTurnMessages,
      interruptForResume,
      pane.id,
      pane.sessionId,
      reloadSessionFromDisk,
      setPaneMessages,
      truncateSessionAtUserMessage,
    ]
  );

  const takeoverSession = useCallback(async () => {
    const sid = (pane.sessionId || "").trim();
    if (!sid) return;
    userStoppedSessionRef.current[sid] = true;
    await stopCurrentRun();
    window.setTimeout(() => composerRef.current?.focus(), 50);
  }, [pane.sessionId, stopCurrentRun]);

  useEffect(() => {
    const sid = (pane.sessionId || "").trim();
    if (!sid) return;
    let cancelled = false;

    const evaluate = async () => {
      // A healthy paused Workforce is expected to be silent. Clear any
      // detector state left by the pre-pause run and freeze re-detection until
      // a resume/start event arrives.
      if (isGroupPane && isTeamControlStallSuppressed(effectiveGroupTeamControlState)) {
        setStallState("none");
        setStallWait(null);
        setStallRejectReason("");
        return;
      }
      if (stallState === "exhausted") return;
      const sseActive = Boolean(sessionStreamStateRef.current[sid]?.active);
      const sessionProgress = sessionProgressAtRef.current[sid] ?? 0;
      const lastProgress = Math.max(lastProgressAtRef.current, sessionProgress);
      const now = Date.now();
      const silentMs = lastProgress > 0 ? now - lastProgress : 0;

      let execState: SessionExecutionState = sessionExecutionState;
      try {
        const r = await window.agenticxDesktop.listSessions(pane.avatarId ?? undefined);
        if (cancelled || !r.ok) return;
        const row = (r.sessions ?? []).find((s) => s.session_id === sid);
        if (row?.execution_state) {
          execState = row.execution_state as SessionExecutionState;
          const prev = prevExecutionStateBySidRef.current[sid] ?? "idle";
          if (prev === "running" && execState === "idle" && runGuardSessionId !== sid) {
            setBgCompleteToast(true);
            addPaneMessage(pane.id, "tool", "后台任务已完成", "meta");
            await mergeTailFromDisk(sid);
            // Re-check after the await: the user may have switched away while the
            // tail merged — never write this session's exec state onto a sibling.
            if (cancelled) return;
          }
          prevExecutionStateBySidRef.current[sid] = execState;
          setSessionExecutionState(execState);
          if (execState === "idle" && runGuardSessionId === sid) {
            setRunGuardSessionId("");
          }
        }
      } catch {
        /* ignore */
      }

      const livePane = useAppStore.getState().panes.find((p) => p.id === pane.id);
      const msgs = livePane?.messages ?? [];
      // Channel C must not fire on the empty window between a session switch
      // (which clears messages: []) and the async re-load completing — otherwise
      // a completed session shows a false「已停滞/已中断」, especially when another
      // running session is slowing the single backend event loop.
      const messagesHydrated = sessionMessagesHydrated({
        loadingMessages: livePane?.loadingMessages,
        messageCount: msgs.length,
      });
      const enteredAt = sessionEnteredAtRef.current[sid] ?? now;
      const graceMs = now - enteredAt;

      const userStopped = Boolean(userStoppedSessionRef.current[sid]);
      if (shouldSuppressStallDetection(runGuardSessionId, sid, userStopped)) {
        setStallState("none");
        if (execState === "interrupted" || execState === "idle") {
          setRunGuardSessionId("");
        }
        return;
      }

      if (isFutileResume(msgs)) {
        setStallState("none");
        setStallRejectReason("");
        return;
      }

      // Parked on an unanswered HITL card: silence is expected, not a stall.
      if (paneHasPendingHumanGate(msgs)) {
        setStallState("none");
        return;
      }

      const stallSilenceMs = stallDetectSilenceMs(stallRuntimeConfig.stall_detect_silence_seconds);
      const channelA = sseActive && lastProgress > 0 && silentMs >= stallSilenceMs;
      const channelB =
        !sseActive &&
        execState === "running" &&
        lastProgress > 0 &&
        silentMs >= stallSilenceMs;
      const channelC =
        graceMs >= CHANNEL_C_GRACE_MS &&
        shouldTriggerIncompleteEndStall(
          execState,
          sseActive,
          msgs,
          graceMs,
          messagesHydrated,
          effectiveGroupTeamControlState,
        );

      if (channelA || channelB || channelC) {
        // channelC = idle session whose last turn produced no visible reply
        // (ended-incomplete); channelA/B = a running turn gone silent.
        setStallReason(channelA || channelB ? "silent" : "incomplete");
        setStallState("stall");
        return;
      }

      if (stallState === "stall") {
        const recovered =
          execState === "idle" && lastTurnHasCompletedAssistantReply(msgs);
        const progressOk = silentMs < stallSilenceMs;
        if (recovered || (progressOk && (sseActive || execState !== "running"))) {
          setStallState("none");
        }
      }
    };

    void evaluate();
    const shouldPollFast =
      sessionExecutionState === "running" ||
      stallState === "stall" ||
      stallState === "exhausted" ||
      runGuardSessionId === sid;
    const intervalMs = shouldPollFast ? 2000 : 8000;
    const timer = window.setInterval(() => {
      setStallTick((t) => t + 1);
      void evaluate();
    }, intervalMs);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [
    addPaneMessage,
    mergeTailFromDisk,
    pane.avatarId,
    pane.id,
    pane.sessionId,
    effectiveGroupTeamControlState,
    isGroupPane,
    runGuardSessionId,
    sessionExecutionState,
    stallRuntimeConfig.stall_detect_silence_seconds,
    stallState,
  ]);

  useEffect(() => {
    if (!stallRuntimeConfig.stall_auto_nudge_enabled) return;
    const sid = (pane.sessionId || "").trim();
    const userStopped = sid ? Boolean(userStoppedSessionRef.current[sid]) : false;
    const sseActive = Boolean(sessionStreamStateRef.current[sid]?.active);
    const runInFlight =
      runGuardSessionId === sid || Boolean(sessionAbortControllersRef.current[sid]);
    if (
      !shouldAllowStallAutoNudge(stallState, sessionExecutionState, Boolean(budgetExceededInfo), {
        sseActive,
        runInFlight,
        teamControlState: effectiveGroupTeamControlState,
        userStopped,
      })
    ) {
      return;
    }
    if (!sid) return;
    if (silentSeconds < stallRuntimeConfig.stall_auto_nudge_after_seconds) return;
    const count = autoNudgeTriggeredRef.current[sid] ?? 0;
    if (count >= stallRuntimeConfig.stall_auto_nudge_max_per_session) return;
    const bucket = Math.floor(
      silentSeconds / Math.max(1, stallRuntimeConfig.stall_auto_nudge_after_seconds)
    );
    if ((autoNudgeBucketRef.current[sid] ?? -1) >= bucket) return;
    autoNudgeBucketRef.current[sid] = bucket;
    autoNudgeTriggeredRef.current[sid] = count + 1;
    setAutoNudgeCount(count + 1);
    const reason: ContinueReason =
      sessionExecutionState === "interrupted"
        ? "interrupted"
        : stallState === "exhausted"
          ? "exhausted"
          : "stall";
    void sendChatRef.current("", {
      lockedSessionId: sid,
      continuation: { reason, source: "desktop_auto_nudge" },
    });
  }, [
    pane.id,
    pane.sessionId,
    runGuardSessionId,
    sessionExecutionState,
    silentSeconds,
    stallRuntimeConfig,
    stallState,
    budgetExceededInfo,
    effectiveGroupTeamControlState,
  ]);

  useEffect(() => {
    if (!sessionUnattended || !unattendedGlobalEnabled) return;
    if (Boolean(budgetExceededInfo)) return;
    const sid = (pane.sessionId || "").trim();
    const userStopped = sid ? Boolean(userStoppedSessionRef.current[sid]) : false;
    const sseActive = Boolean(sessionStreamStateRef.current[sid]?.active);
    const runInFlight =
      runGuardSessionId === sid || Boolean(sessionAbortControllersRef.current[sid]);
    if (
      !shouldAllowStallAutoNudge(stallState, sessionExecutionState, false, {
        sseActive,
        runInFlight,
        teamControlState: effectiveGroupTeamControlState,
        userStopped,
      })
    ) {
      return;
    }
    if (!sid) return;
    if (silentSeconds < unattendedStallContinueAfterSeconds) return;
    const count = unattendedContinueTriggeredRef.current[sid] ?? 0;
    if (count >= unattendedMaxContinuations) return;
    const bucket = Math.floor(
      silentSeconds / Math.max(1, unattendedStallContinueAfterSeconds),
    );
    if ((unattendedContinueBucketRef.current[sid] ?? -1) >= bucket) return;
    unattendedContinueBucketRef.current[sid] = bucket;
    unattendedContinueTriggeredRef.current[sid] = count + 1;
    setUnattendedContinueCount(count + 1);
    const reason: ContinueReason =
      sessionExecutionState === "interrupted"
        ? "interrupted"
        : stallState === "exhausted"
          ? "exhausted"
          : "stall";
    void sendChatRef.current("", {
      lockedSessionId: sid,
      continuation: { reason, source: "supervisor" },
    });
  }, [
    budgetExceededInfo,
    effectiveGroupTeamControlState,
    pane.sessionId,
    sessionExecutionState,
    sessionUnattended,
    silentSeconds,
    stallState,
    unattendedGlobalEnabled,
    unattendedMaxContinuations,
    unattendedStallContinueAfterSeconds,
  ]);

  useEffect(() => {
    if (!bgCompleteToast) return;
    const t = window.setTimeout(() => setBgCompleteToast(false), 3000);
    return () => window.clearTimeout(t);
  }, [bgCompleteToast]);

  useEffect(() => {
    if (!stallHintToast) return;
    const t = window.setTimeout(() => setStallHintToast(""), 2800);
    return () => window.clearTimeout(t);
  }, [stallHintToast]);

  const resumeCurrentTask = useCallback(async (modelOverride?: { provider: string; model: string }) => {
    const requestPaneId = pane.id;
    const sid = (pane.sessionId || "").trim();
    if (!sid || resumeInFlightRef.current[sid]) return;
    const isDisplayed = () => {
      const currentPane = useAppStore.getState().panes.find((row) => row.id === requestPaneId);
      return isPaneDisplayingSession(currentPane, requestPaneId, sid);
    };
    if (!isDisplayed()) return;

    // Guard: skip futile resumes. When the last turn_interrupted follows a
    // complete assistant reply and all todos are done, resuming only makes
    // the model re-announce "task done" and re-verify outputs — a loop.
    const guardMsgs =
      useAppStore.getState().panes.find((p) => p.id === pane.id)?.messages ??
      pane.messages ??
      [];
    if (isFutileResume(guardMsgs)) {
      addPaneMessage(pane.id, "tool", "✅ 任务已全部完成，无需恢复执行。", "meta", undefined, undefined, undefined, {
        metadata: { kind: "futile_resume_guard" },
      });
      setStallState("none");
      setStallRejectReason("");
      return;
    }

    const resumeGeneration = beginResumeInFlight(sid);
    const ownsResumeAction = () =>
      resumeInFlightRef.current[sid] === true &&
      resumeInFlightGenerationRef.current[sid] === resumeGeneration;
    delete userStoppedSessionRef.current[sid];
    let state: SessionExecutionState = sessionExecutionState;
    try {
      const r = await window.agenticxDesktop.listSessions(pane.avatarId ?? undefined);
      if (!isDisplayed() || !ownsResumeAction()) {
        clearResumeInFlight(sid, resumeGeneration);
        return;
      }
      if (r.ok) {
        const row = (r.sessions ?? []).find((s) => s.session_id === sid);
        state = (row?.execution_state ?? "idle") as SessionExecutionState;
        if (!isDisplayed() || !ownsResumeAction()) {
          clearResumeInFlight(sid, resumeGeneration);
          return;
        }
        setSessionExecutionState(state);
      }
    } catch {
      /* ignore */
    }

    if (!isDisplayed() || !ownsResumeAction()) {
      clearResumeInFlight(sid, resumeGeneration);
      return;
    }

    const hasForegroundStream = Boolean(sessionStreamStateRef.current[sid]?.active);
    const groupResumeAction = resolveGroupRunningResumeAction({
      isGroupPane,
      executionState: state,
      hasForegroundStream,
      liveReattachEnabled: liveReattachEnabledRef.current,
    });
    if (groupResumeAction !== "restart") {
      clearResumeInFlight(sid, resumeGeneration);
      if (!isDisplayed()) return;
      setSessionExecutionState("running");
      setRunGuardSessionId(sid);
      setStallRejectReason("");
      setStallState("none");
      if (groupResumeAction === "reattach") {
        setStallHintToast("群聊仍在后台运行，已重新连接");
        if (isDisplayed()) void reattachLiveStream(sid);
      } else {
        setStallHintToast("群聊仍在运行，未重复启动；如需重跑请先中断");
        if (!hasForegroundStream && isDisplayed()) {
          void mergeTailFromDisk(sid, { isCurrentOwner: isDisplayed });
        }
      }
      return;
    }

    if (!isDisplayed() || !ownsResumeAction()) {
      clearResumeInFlight(sid, resumeGeneration);
      return;
    }
    await interruptForResume(sid);
    if (!isDisplayed() || !ownsResumeAction()) {
      clearResumeInFlight(sid, resumeGeneration);
      return;
    }

    // Keep the stall/exhausted card mounted (now in "恢复中…" state) until the
    // continuation succeeds (continuation_notice / first SSE frame) or is
    // rejected. Clearing stallState here would unmount the card and hide the
    // inline reject reason, regressing FR-4.
    if (!isDisplayed() || !ownsResumeAction()) {
      clearResumeInFlight(sid, resumeGeneration);
      return;
    }
    setStallRejectReason("");
    const reason = inferContinueReason({
      stallState,
      executionState: state === "running" ? "interrupted" : state,
    });
    void sendChatRef.current("", {
      lockedSessionId: sid,
      provider: modelOverride?.provider,
      model: modelOverride?.model,
      continuation: { reason, source: "desktop_manual" },
    });
  }, [
    addPaneMessage,
    beginResumeInFlight,
    clearResumeInFlight,
    interruptForResume,
    isGroupPane,
    mergeTailFromDisk,
    pane.avatarId,
    pane.id,
    pane.messages,
    pane.sessionId,
    reattachLiveStream,
    sessionExecutionState,
    stallState,
  ]);

  const resumeWithModel = useCallback(
    async (provider: string, model: string) => {
      setPaneModel(pane.id, provider, model);
      void window.agenticxDesktop.saveConfig({ activeProvider: provider, activeModel: model }).then((result) => {
        if (!result.ok) {
          console.warn("[ChatPane] global model persistence failed", result.error);
        }
      });
      const sid = (pane.sessionId || "").trim();
      if (sid) {
        const persisted = await window.agenticxDesktop.setSessionModel({ sessionId: sid, provider, model });
        if (!persisted.ok) {
          console.warn("[ChatPane] session model persistence failed; continuing with explicit override", persisted.error);
        }
      }
      await resumeCurrentTask({ provider, model });
    },
    [pane.id, pane.sessionId, resumeCurrentTask, setPaneModel]
  );

  // Cursor-like: tool-arg truncation / stream timeout → auto-continue once or twice
  // without requiring「无人值守」. Manual user_interrupt is never auto-resumed.
  useEffect(() => {
    const sid = (pane.sessionId || "").trim();
    if (!sid) return;
    if (resumeInFlightRef.current[sid]) return;
    if (sessionAbortControllersRef.current[sid]) return;
    if (userStoppedSessionRef.current[sid]) return;
    if ((truncationAutoResumeCountRef.current[sid] ?? 0) >= 2) return;
    const msgs = pane.messages ?? [];
    for (let i = msgs.length - 1; i >= 0; i -= 1) {
      const m = msgs[i];
      if (!m || !shouldAutoResumeTruncationInterruption(m)) continue;
      if (truncationAutoResumeNoticeRef.current[sid] === m.id) return;
      truncationAutoResumeNoticeRef.current[sid] = m.id;
      truncationAutoResumeCountRef.current[sid] =
        (truncationAutoResumeCountRef.current[sid] ?? 0) + 1;
      void resumeCurrentTask();
      return;
    }
  }, [pane.messages, pane.sessionId, resumeCurrentTask]);

  const sendFollowupChip = useCallback(
    (text: string, ctx?: { ownerSessionId?: string }) => {
      const t = String(text || "").trim();
      if (!t) return;
      const paneSid = (pane.sessionId || "").trim();
      const ownerSid = String(ctx?.ownerSessionId ?? paneSid).trim();
      if (!ownerSid) return;
      if (paneSid && ownerSid !== paneSid) {
        console.warn(
          "[ChatPane] followup ignored — chip owner %s but pane shows %s",
          ownerSid,
          paneSid,
        );
        return;
      }
      void sendChatRef.current(t, { lockedSessionId: ownerSid });
    },
    [pane.sessionId],
  );

  const sendQueuedMessageNow = useCallback(
    (msgId: string) => {
      const queued = (useAppStore.getState().pendingMessages[paneId] ?? []).find(
        (item) => item.id === msgId,
      );
      const queuedSessionId = String(queued?.sessionId ?? "").trim();
      const currentPane = useAppStore.getState().panes.find((p) => p.id === paneId);
      // Never consume a queued A message from the pane while it is displaying
      // B. Keeping it in the queue lets A's own pane drain it later.
      if (
        queuedSessionId &&
        !isPaneDisplayingSession(currentPane, paneId, queuedSessionId)
      ) {
        return;
      }
      const item = takePendingMessage(paneId, msgId);
      if (!item) return;
      const lockedSessionId = String(item.sessionId ?? "").trim() || (
        useAppStore.getState().panes.find((p) => p.id === paneId)?.sessionId || ""
      ).trim();
      const paneAfterTake = useAppStore.getState().panes.find((p) => p.id === paneId);
      if (
        lockedSessionId &&
        !isPaneDisplayingSession(paneAfterTake, paneId, lockedSessionId)
      ) {
        // Navigation may have won the tiny take→send race. Restore the exact
        // item before handing it to sendChat; queueDrain is also a defensive
        // requeue gate for a switch that lands while sendChat starts.
        enqueuePaneMessage(paneId, item);
        return;
      }
      void sendChatRef.current(item.text, {
        lockedSessionId: lockedSessionId || undefined,
        retryAttachments: item.attachments,
        forceSend: true,
        queueDrain: true,
      });
    },
    [enqueuePaneMessage, paneId, takePendingMessage]
  );

  const applySkillPatchPreview = useCallback(
    (message: Message, payload: SkillPatchPreviewPayload, targetIndex: number | null) => {
      const args = (message.toolArgs ?? {}) as Record<string, unknown>;
      const skillName = String(args.name ?? "").trim();
      const oldString = String(args.old_string ?? "");
      const newString = String(args.new_string ?? "");
      const beforeContext = String(args.before_context ?? "");
      const afterContext = String(args.after_context ?? "");
      const replaceAll = Boolean(args.replace_all);
      const patchToken = String(payload.patch_token ?? "").trim();
      const sid = String(message.ownerSessionId ?? pane.sessionId ?? "").trim();
      if (!sid || !skillName || !oldString) return;
      const applyArgs: Record<string, unknown> = {
        action: "patch",
        name: skillName,
        mode: "apply",
        old_string: oldString,
        new_string: newString,
      };
      if (patchToken) applyArgs.patch_token = patchToken;
      if (beforeContext) applyArgs.before_context = beforeContext;
      if (afterContext) applyArgs.after_context = afterContext;
      if (replaceAll) applyArgs.replace_all = true;
      if (targetIndex !== null && Number.isFinite(targetIndex)) {
        applyArgs.target_index = targetIndex;
      }
      const instruction =
        [
          "请立即且仅执行一次工具调用，不要输出解释文字。",
          "tool_name: skill_manage",
          `arguments: ${JSON.stringify(applyArgs)}`,
          "执行完成后再返回结果。",
        ].join("\n");
      void sendChatRef.current(instruction, {
        lockedSessionId: sid,
        suppressUserEcho: true,
        skipUserHistory: true,
        forceSend: true,
      });
    },
    [pane.sessionId]
  );

  const openSubAgentDetailFromCluster = useCallback(
    async (runId: string) => {
      const rid = String(runId ?? "").trim();
      if (!rid) return;

      const live = paneSubAgents.find((item) => item.id === rid);
      if (live) {
        togglePaneSubAgentChat(rid);
        closeRunDrawer(pane.id);
        return;
      }

      const sid = String(pane.sessionId ?? "").trim();
      if (!sid || !apiBase || !apiToken) return;

      try {
        const [detailResp, activityResp] = await Promise.all([
          fetchRunDetail(apiBase, apiToken, sid, rid),
          fetchRunActivityPage(apiBase, apiToken, sid, rid, 0, 200),
        ]);
        if (!detailResp.ok || !detailResp.run) return;

        const hydrated = buildSubAgentFromRunRecord(
          detailResp.run as SubAgentRunRecord,
          activityResp.entries ?? [],
          sid,
        );
        const store = useAppStore.getState();
        if (store.subAgents.some((item) => item.id === rid)) {
          store.updateSubAgent(rid, hydrated);
        } else {
          store.addSubAgent({
            id: rid,
            name: hydrated.name,
            role: hydrated.role,
            // 历史运行传空 task：避免 SubAgentCard 在历史态回显「详细指令」块
            task: "",
            provider: hydrated.provider,
            model: hydrated.model,
            sessionId: sid,
          });
          store.updateSubAgent(rid, {
            status: hydrated.status,
            currentAction: hydrated.currentAction,
            progress: hydrated.progress,
            resultSummary: hydrated.resultSummary,
            resultFile: hydrated.resultFile,
            outputFiles: hydrated.outputFiles,
            events: hydrated.events,
          });
        }

        closeRunDrawer(pane.id);
        // 任务仍在执行时禁止切入对话（与 togglePaneSubAgentChat 的拦截语义一致）；
        // 明细已写入 store，用户仍可在 Spawns 列看到实时状态，只是不能切到对话态。
        if (isSubAgentLiveStatus(hydrated.status)) {
          setStallHintToast("该智能体任务执行中，完成后才能进入对话");
          return;
        }
        setWorkPanelFocus({ kind: "summary" });
        if (!pane.taskspacePanelOpen) {
          openWorkspaceSidebarForPane(pane.id, paneRef.current?.clientWidth ?? paneWidth, openSidePanel);
        }
        setSelectedSubAgent(rid);
      } catch {
        // Ignore — cluster card stays interactive; user can retry click.
      }
    },
    [
      apiBase,
      apiToken,
      closeRunDrawer,
      openSidePanel,
      pane.id,
      pane.sessionId,
      pane.taskspacePanelOpen,
      paneSubAgents,
      paneWidth,
      setSelectedSubAgent,
      setStallHintToast,
    ],
  );

  const togglePaneSubAgentChat = (agentId: string) => {
    if (selectedSubAgent === agentId) {
      setSelectedSubAgent(null);
      return;
    }
    const sub = paneSubAgents.find((item) => item.id === agentId);
    const isDelegation =
      agentId.startsWith("dlg-") ||
      !!(sub?.events?.some((evt) => evt.type.startsWith("delegation")));
    if (isDelegation) {
      void openDelegatedAvatarSession(agentId);
      return;
    }
    // 任务仍在执行（含等待确认/等待输入）时禁止切入对话：避免上下文被轻易打断；
    // 提醒用户等任务完成后再进入。不影响「关闭对话」（上方已提前 return）。
    if (sub && isSubAgentLiveStatus(sub.status)) {
      setStallHintToast("该智能体任务执行中，完成后才能进入对话");
      return;
    }
    // 选中成员时打开工作台「任务摘要」，子智能体卡片在展开面板内展示。
    setWorkPanelFocus({ kind: "summary" });
    if (!pane.taskspacePanelOpen) {
      openWorkspaceSidebarForPane(pane.id, paneRef.current?.clientWidth ?? paneWidth, openSidePanel);
    }
    setSelectedSubAgent(agentId);
  };

  const renderedMessages = useMemo(() => {
    const reactActionStyle = getAssistantActionStyle({ inReActRow: true });
    const renderGroupedRow = (
      row: GroupedChatRow,
      rowIdx: number,
      opts: {
        reactWorkColumn?: boolean;
        reactFlat?: boolean;
        reactHideBadge?: boolean;
        reactShowActions?: boolean;
        omitSuggestedQuestions?: boolean;
        actionRhythmBodyTail?: boolean;
        holdToolGroupProgress?: boolean;
      }
    ) => {
      const reactCol = opts.reactWorkColumn ?? false;
      const reactFlat = opts.reactFlat ?? false;
      const reactHideBadge = opts.reactHideBadge ?? false;
      const reactShowActions = opts.reactShowActions ?? false;
      const omitSuggestedQuestions = opts.omitSuggestedQuestions ?? false;
      const actionRhythmBodyTail = opts.actionRhythmBodyTail ?? false;
      const holdToolGroupProgress = opts.holdToolGroupProgress ?? false;
      if (row.kind === "message") {
        const message = row.message;
        const canRetryThisUserMessage = message.role === "user" && !isStreamingCurrentSession;
        const isSelecting = selectedMessageIds.size > 0;
        const rowSelectable = isSelecting && !reactCol;
        const isSelected = selectedMessageIds.has(message.id);
        const groupSender = isGroupPane ? resolveGroupSender(message) : null;
        const renderedMessage = groupSender
          ? messageForGroupRenderer(message, groupSender)
          : message;
        const restoreMessageForAction = (candidate: Message) =>
          candidate.id === message.id ? message : candidate;
        const imUserName = isGroupPane ? groupChatUserLabel : userBubbleLabel;
        const imAssistantName = groupSender?.name ?? paneAvatarMeta.name;
        const imAssistantAvatarUrl = groupSender?.url ?? paneAvatarMeta.url;
        const sessionTurn =
          message.role === "assistant"
            ? sessionTurnForAssistantMessage(sessionTurns, message, pane.messages, pane.sessionId)
            : null;
        const undoTurn =
          sessionTurn &&
          undoConsumedSessionId !== String(pane.sessionId ?? "").trim() &&
          canOfferSessionTurnUndo(sessionTurn, sessionTurns)
            ? sessionTurn
            : null;
        const documentTurnHasCard = Boolean(
          sessionTurn &&
            isDocumentOnlyTurn(sessionTurn) &&
            visibleSessionTurnDeliverablePaths(sessionTurn).length > 0,
        );
        const feedbackReady =
          message.role === "assistant" && hasCanonicalFeedbackMessageId(message);
        const feedbackMessageId = feedbackReady ? feedbackMessageIdForMessage(message) : "";
        return (
          <div
            key={message.id}
            data-message-id={message.id}
            className={`group/sel relative${actionRhythmBodyTail ? ` ${ASSISTANT_BODY_TAIL_CLASS}` : ""}`}
          >
            {rowSelectable && !isSelected && (
              <button
                type="button"
                className="absolute -top-1 left-0 z-10 flex items-center gap-1 rounded-full border border-border bg-surface-card px-2 py-0.5 text-[10px] text-text-muted shadow-sm opacity-0 transition-opacity group-hover/sel:opacity-100 hover:!opacity-100 hover:bg-surface-hover hover:text-text-strong"
                onClick={() => selectUpTo(message)}
              >
                ↓ 选择到这里
              </button>
            )}
            <MessageRenderer
              message={renderedMessage}
              highlightTerms={pane.historySearchTerms}
              assistantBadge={
                message.role === "assistant" && !reactHideBadge && showInlineAssistantModelBadge ? (
                  <ModelBadge provider={message.provider} model={message.model} />
                ) : undefined
              }
              imAssistantVisual={
                message.role === "assistant" && reactCol
                  ? reactShowActions ? "compact-inline-with-actions" : "compact-inline"
                  : "default"
              }
              noBubbleBorder={reactFlat}
              toolCardOmitLeadingSpacer={message.role === "tool" && reactCol}
              onRevealPath={(path) => void revealFileInTaskspace(path)}
              onOpenArtifactPreview={(path) => openWorkspaceFilePreview(path)}
              onOpenAllArtifacts={() => openWorkPanelSummary("artifacts")}
              onOpenAllChanges={() => openWorkPanelSummary("changes")}
              onOpenFileReference={(request) => openFileReferencePreview(request)}
              onOpenSubAgentRun={openSubAgentDetailFromCluster}
              assistantName={imAssistantName}
              assistantAvatarUrl={imAssistantAvatarUrl}
              userName={imUserName}
              userAvatarUrl={userAvatarUrl || undefined}
              showSenderIdentity={isGroupPane || isDedicatedAvatarPane}
              senderAvatarVariant="rounded-square"
              senderAvatarId={
                groupSender?.avatarId
                ?? (isDedicatedAvatarPane ? pane.avatarId ?? undefined : undefined)
              }
              senderRoleLabel={
                isGroupPane
                  ? resolveGroupSenderRoleLabel(groupSender?.avatarId, groupHost?.id)
                  : undefined
              }
              onOpenSenderProfile={isGroupPane ? handleOpenGroupMember : undefined}
              enableGroupReactions={isGroupPane}
              onToggleReaction={isGroupPane ? handleToggleGroupReaction : undefined}
              feedbackValue={feedbackReady ? feedbackForMessage(feedbackMessageId) : null}
              feedbackPending={feedbackReady ? Boolean(feedbackState.pending[feedbackMessageId]) : false}
              feedbackStatus={feedbackReady ? feedbackState.status[feedbackMessageId] : undefined}
              onFeedback={
                feedbackEnabled && feedbackReady
                  ? (_messageId, value, action) =>
                      handleFeedback(feedbackMessageId, value, action)
                  : undefined
              }
              feedbackDisabledReason={
                feedbackReady
                  ? feedbackEnabled
                    ? undefined
                    : feedbackUnavailableReason
                  : "等待回答地址"
              }
              onRetryFeedbackLoad={
                feedbackReady && canRetryFeedbackHydration
                  ? retryFeedbackHydration
                  : undefined
              }
              onCopyMessage={(msg) => copyMessage(restoreMessageForAction(msg))}
              onQuoteMessage={(msg, selectedText) =>
                addQuoteTarget(
                  restoreMessageForAction(msg),
                  resolveQuoteBody(restoreMessageForAction(msg), selectedText),
                )
              }
              onWebSearchMessage={(_msg, selectedText) => {
                const q = selectedText.trim();
                if (!q) return;
                if (!pane.taskspacePanelOpen) {
                  openWorkspaceSidebarForPane(
                    pane.id,
                    paneRef.current?.clientWidth ?? paneWidth,
                    openSidePanel,
                  );
                }
                setWorkPanelFocus({
                  kind: "browser",
                  url: `https://www.google.com/search?q=${encodeURIComponent(q)}`,
                  title: `搜索：${q}`,
                });
              }}
              onQuoteToNewPane={(msg, selectedText) => {
                const sourceMessage = restoreMessageForAction(msg);
                const body = resolveQuoteBody(sourceMessage, selectedText);
                const label =
                  sourceMessage.avatarName ||
                  sourceMessage.agentId ||
                  (sourceMessage.role === "user" ? userBubbleLabel || "我" : paneAvatarMeta.name || "AI");
                const newPaneId = addPane(pane.avatarId, pane.avatarName, "");
                markPaneAwaitingFreshSession(newPaneId);
                setPanePendingQuote(newPaneId, {
                  messageId: sourceMessage.id,
                  body,
                  label,
                });
                setActivePaneId(newPaneId);
              }}
              onFavoriteMessage={(msg, selectedText) =>
                favoriteMessage(restoreMessageForAction(msg), selectedText)
              }
              onForwardMessage={(msg, selectedText) =>
                forwardOneMessage(restoreMessageForAction(msg), selectedText)
              }
              onRetryMessage={
                canRetryThisUserMessage
                  ? (msg) => retryUserMessage(restoreMessageForAction(msg))
                  : undefined
              }
              onEditMessage={
                canRetryThisUserMessage
                  ? (msg, newContent) => editUserMessage(restoreMessageForAction(msg), newContent)
                  : undefined
              }
              onToggleSelectMessage={(msg) => toggleSelectMessage(restoreMessageForAction(msg))}
              onResolveInlineConfirm={(confirm, approved) => void resolveGroupInlineConfirm(confirm, approved)}
              selectable={rowSelectable}
              selected={rowSelectable && isSelected}
              onFollowupClick={sendFollowupChip}
              omitSuggestedQuestions={omitSuggestedQuestions}
              actionRhythmBodyTail={actionRhythmBodyTail}
              budgetExceededActive={Boolean(budgetExceededInfo)}
              allMessages={pane.messages ?? []}
              sessionId={(pane.sessionId || "").trim() || undefined}
              sessionTurn={sessionTurn}
              sessionTurnLoading={sessionTurnsLoading}
              undoTurn={undoTurn}
              onUndoTurn={handleUndoSessionTurn}
              undoingTurn={undoTurn ? undoingTurnId === undoTurn.turnId : false}
              undoError={undoTurn ? sessionTurnErrors[undoTurn.turnId] : undefined}
              onResumeInNewSession={() => resumeInNewSessionRef.current()}
              onOpenBudgetSettings={() => useAppStore.getState().openSettings("automation")}
              onResumeTask={() => void resumeCurrentTask()}
              resumeInFlight={resumeInFlight}
              isFutileResume={isFutileResumeFlag}
              sessionBusy={sessionBusy}
              isLastAssistantInPane={
                message.role === "assistant" && message.id === lastAssistantMessageId
              }
              streamStalled={message.id === "__stream__" && stallState === "stall"}
              streamStalledSeconds={message.id === "__stream__" ? silentSeconds : 0}
              onSkillManageApply={(msg, payload, targetIndex) =>
                applySkillPatchPreview(restoreMessageForAction(msg), payload, targetIndex)
              }
              onOpenClarification={onOpenClarification}
              onSubmitClarification={onSubmitClarification}
              onResolveActionConfirmation={(confirmation, decision) =>
                void resolveActionConfirmation(confirmation, decision, "button")
              }
            />
            {undoTurn && !documentTurnHasCard ? (
              <TurnChangeCard
                turn={undoTurn}
                undoing={undoingTurnId === undoTurn.turnId}
                error={sessionTurnErrors[undoTurn.turnId]}
                onUndo={handleUndoSessionTurn}
                onOpenArtifact={(path) => void openWorkspaceFilePreview(path)}
                documentOnly={Boolean(isDocumentOnlyTurn(undoTurn))}
              />
            ) : null}
          </div>
        );
      }
      const groupKey = `tg-${row.messages[0]?.id ?? rowIdx}`;
      const isSelecting = selectedMessageIds.size > 0;
      const groupSelectable = isSelecting && !reactCol;
      const anySelected = row.messages.some((m) => selectedMessageIds.has(m.id));
      const anchorMessage = row.messages[row.messages.length - 1];
      return (
        <div key={groupKey} className="group/sel relative">
          {groupSelectable && !anySelected && (
            <button
              type="button"
              className="absolute -top-1 left-0 z-10 flex items-center gap-1 rounded-full border border-border bg-surface-card px-2 py-0.5 text-[10px] text-text-muted shadow-sm opacity-0 transition-opacity group-hover/sel:opacity-100 hover:!opacity-100 hover:bg-surface-hover hover:text-text-strong"
              onClick={() => selectUpTo(anchorMessage)}
            >
              ↓ 选择到这里
            </button>
          )}
          <TurnToolGroupCard
            messages={row.messages}
            highlightTerms={pane.historySearchTerms}
            holdProgress={holdToolGroupProgress}
            renderExtras={(m) =>
              renderToolMessageExtras(m, {
                onRevealPath: (p) => void revealFileInTaskspace(p),
                onResolveInlineConfirm: (c, a) => void resolveGroupInlineConfirm(c, a),
              })
            }
            selectable={groupSelectable}
            selectedIds={selectedMessageIds}
            onToggleSelectMessage={toggleSelectMessage}
            omitLeadingSpacer={reactCol}
            flat={reactFlat}
            onSkillManageApply={applySkillPatchPreview}
          />
        </div>
      );
    };

    const mainRows =
      topLevelRowsIm !== null
        ? topLevelRowsIm.map((seg, segIdx) => {
            if (seg.kind === "user") {
              return renderGroupedRow({ kind: "message", message: seg.message }, segIdx, {});
            }
            const { workMessages, finalAssistant } = seg.block;
            const groupedWork = groupConsecutiveToolMessages(workMessages);
            const blockKey = `react-${workMessages[0]?.id ?? segIdx}-${finalAssistant?.id ?? ""}`;
            const lastToolGroupIdxInWork = groupedWork.reduce(
              (acc, row, index) => (row.kind === "tool_group" ? index : acc),
              -1,
            );
            const hasTools = groupedWork.some(
              (r) => r.kind === "tool_group" || (r.kind === "message" && r.message.role === "tool")
            );
            const hasStreamingRow = groupedWork.some(
              (r) => r.kind === "message" && r.message.role === "assistant" && r.message.id === "__stream__"
            );
            const hasViewImageInject = workMessages.some(isViewImageInjectMessage);
            const useUnifiedReActCard = hasTools || hasStreamingRow || hasViewImageInject;
            const isSelecting = selectedMessageIds.size > 0;
            const blockAnySelected = workMessages.some((m) => selectedMessageIds.has(m.id));
            const lastAssistantInBlock = [...workMessages].reverse().find(
              (m) => m.role === "assistant" && m.id !== "__stream__"
            ) ?? null;
            let peeledFollowupAssistant: Message | null = null;
            if (useUnifiedReActCard) {
              for (const m of workMessages) {
                if (
                  m.role === "assistant" &&
                  m.id !== "__stream__" &&
                  m.suggestedQuestions &&
                  m.suggestedQuestions.length > 0
                ) {
                  peeledFollowupAssistant = m;
                }
              }
            }
            return (
              <div key={blockKey} className="agx-assistant-action-rhythm mb-6 flex flex-col gap-2.5">
                <div className="flex min-w-0 items-start gap-2">
                  {isSelecting ? (
                    <button
                      type="button"
                      className={`mt-2 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border transition ${
                        blockAnySelected
                          ? "border-[rgb(var(--theme-color-rgb,6,182,212))] bg-[rgb(var(--theme-color-rgb,6,182,212))] text-[var(--theme-color-text)]"
                          : "border-text-faint bg-transparent text-transparent"
                      }`}
                      onClick={() => toggleSelectBlock(workMessages)}
                      aria-label={blockAnySelected ? "取消选择回复块" : "选择回复块"}
                    >
                      <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M3.5 8.5L6.5 11.5L12.5 4.5" />
                      </svg>
                    </button>
                  ) : null}
                  {useUnifiedReActCard ? (
                    (() => {
                      const actionTailReady =
                        !hasStreamingRow && !sessionWorkInProgress && workMessages.length > 0;
                      const rhythmEndIdx =
                        actionTailReady && groupedWork.length > 0
                          ? groupedWork.length - 1
                          : groupedWork.length;
                      const headRows = groupedWork.slice(0, rhythmEndIdx);
                      const tailRow =
                        rhythmEndIdx < groupedWork.length ? groupedWork[rhythmEndIdx] : null;

                      // 过程折叠：见 resolveProcessFoldRange —— 只折工具段，两头的正文不折。
                      const { start: processStart, end: processEnd } =
                        resolveProcessFoldRange(groupedWork);
                      const beforeProcessHeadRows = headRows.slice(0, processStart);
                      const processHeadRows = headRows.slice(processStart, processEnd);
                      const afterProcessHeadRows = headRows.slice(processEnd);
                      const processToolCount = processHeadRows.reduce(
                        (n, r) => n + (r.kind === "tool_group" ? r.messages.length : 0),
                        0,
                      );
                      const isLastBlock =
                        topLevelRowsIm !== null && segIdx === topLevelRowsIm.length - 1;
                      const collapseActive = hasStreamingRow || (isLastBlock && sessionWorkInProgress);

                      const reactFeedbackReady = Boolean(
                        lastAssistantInBlock && hasCanonicalFeedbackMessageId(lastAssistantInBlock),
                      );
                      const reactFeedbackMessageId = reactFeedbackReady
                        ? feedbackMessageIdForMessage(lastAssistantInBlock!)
                        : "";
                      const reactFeedbackControls = lastAssistantInBlock ? (
                        <AssistantFeedback
                          message={lastAssistantInBlock}
                          bodyText={assistantVisibleBodyForUi(String(lastAssistantInBlock.content ?? ""))}
                          value={reactFeedbackReady ? feedbackForMessage(reactFeedbackMessageId) : null}
                          pending={
                            reactFeedbackReady
                              ? Boolean(feedbackState.pending[reactFeedbackMessageId])
                              : false
                          }
                          status={
                            reactFeedbackReady
                              ? feedbackState.status[reactFeedbackMessageId]
                              : undefined
                          }
                          onFeedback={
                            feedbackEnabled && reactFeedbackReady
                              ? (_messageId, value, action) =>
                                  handleFeedback(reactFeedbackMessageId, value, action)
                              : undefined
                          }
                          disabledReason={
                            reactFeedbackReady
                              ? feedbackEnabled
                                ? undefined
                                : feedbackUnavailableReason
                              : "等待回答地址"
                          }
                          onRetryFeedbackLoad={
                            reactFeedbackReady && canRetryFeedbackHydration
                              ? retryFeedbackHydration
                              : undefined
                          }
                        />
                      ) : null;

                      const renderReActBlockActionIcons = () => (
                        <div
                          className={ASSISTANT_ACTION_ICON_ROW_CLASS}
                          style={reactActionStyle}
                          data-message-actions="assistant"
                        >
                          <HoverTip label="复制">
                            <button
                              type="button"
                              className="rounded p-1 hover:bg-surface-hover hover:text-text-strong"
                              onMouseDown={(e) => e.preventDefault()}
                              onClick={() => void copyReActBlock(workMessages)}
                            >
                              <Copy size={13} />
                            </button>
                          </HoverTip>
                          {lastAssistantInBlock ? (
                            <>
                              <HoverTip label="引用">
                                <button
                                  type="button"
                                  className="rounded p-1 hover:bg-surface-hover hover:text-text-strong"
                                  onMouseDown={(e) => e.preventDefault()}
                                  onClick={() =>
                                    addQuoteTarget(
                                      lastAssistantInBlock,
                                      resolveQuoteBody(lastAssistantInBlock, undefined)
                                    )
                                  }
                                >
                                  <Quote size={13} />
                                </button>
                              </HoverTip>
                              <HoverTip label="收藏">
                                <button
                                  type="button"
                                  className="rounded p-1 hover:bg-surface-hover hover:text-text-strong"
                                  onMouseDown={(e) => e.preventDefault()}
                                  onClick={() => void favoriteMessage(lastAssistantInBlock, undefined)}
                                >
                                  <Bookmark size={13} />
                                </button>
                              </HoverTip>
                              <HoverTip label="转发">
                                <button
                                  type="button"
                                  className="rounded p-1 hover:bg-surface-hover hover:text-text-strong"
                                  onMouseDown={(e) => e.preventDefault()}
                                  onClick={() => forwardOneMessage(lastAssistantInBlock, undefined)}
                                >
                                  <Forward size={13} />
                                </button>
                              </HoverTip>
                            </>
                          ) : null}
                          <HoverTip label="多选">
                            <button
                              type="button"
                              className={`rounded p-1 hover:bg-surface-hover ${
                                blockAnySelected
                                  ? "text-[rgb(var(--theme-color-fg-rgb,59,130,246))] hover:opacity-90"
                                  : "hover:text-text-strong"
                              }`}
                              onMouseDown={(e) => e.preventDefault()}
                              onClick={() => toggleSelectBlock(workMessages)}
                            >
                              <LayoutList size={13} />
                            </button>
                          </HoverTip>
                          {reactFeedbackControls}
                          <MessageTimestamp ts={lastAssistantInBlock?.timestamp} align="left" />
                        </div>
                      );

                      const renderReActBlockFollowups = () =>
                        peeledFollowupAssistant?.suggestedQuestions &&
                        peeledFollowupAssistant.suggestedQuestions.length > 0 &&
                        assistantVisibleBodyForUi(
                          String(peeledFollowupAssistant.content ?? ""),
                        ).trim() ? (
                          <div className={ASSISTANT_FOLLOWUP_LIST_CLASS} style={reactActionStyle}>
                            {peeledFollowupAssistant.suggestedQuestions.slice(0, 3).map((q, qi) => (
                              <button
                                key={`${qi}-${q}`}
                                type="button"
                                className={ASSISTANT_FOLLOWUP_CHIP_CLASS}
                                onMouseDown={(e) => e.preventDefault()}
                                onClick={() =>
                                  sendFollowupChip(q, {
                                    ownerSessionId: peeledFollowupAssistant?.ownerSessionId,
                                  })
                                }
                              >
                                <span>{q}</span>
                                <ArrowRight className="h-3 w-3 shrink-0 opacity-50 transition group-hover:opacity-80" />
                              </button>
                            ))}
                          </div>
                        ) : null;

                      const mapGroupedRow = (r: GroupedChatRow, i: number) => {
                        const omitSq = Boolean(
                          peeledFollowupAssistant &&
                            r.kind === "message" &&
                            r.message.role === "assistant" &&
                            r.message.id === peeledFollowupAssistant.id
                        );
                        const bodyTail = Boolean(
                          omitSq &&
                            actionTailReady &&
                            tailRow &&
                            r === tailRow
                        );
                        return renderGroupedRow(r, i, {
                          reactWorkColumn: true,
                          reactFlat: true,
                          reactHideBadge: i > 0,
                          omitSuggestedQuestions: omitSq,
                          actionRhythmBodyTail: bodyTail,
                          holdToolGroupProgress:
                            r.kind === "tool_group" &&
                            i === lastToolGroupIdxInWork &&
                            shouldHoldToolGroupProgress(
                              workMessages,
                              r.messages,
                              isStreamingCurrentSession
                            ),
                        });
                      };

                      return (
                        <div className="min-w-0 flex-1 overflow-hidden">
                          {beforeProcessHeadRows.map((r, i) => mapGroupedRow(r, i))}
                          <ReactWorkCollapse toolCount={processToolCount} active={collapseActive}>
                            {processHeadRows.map((r, i) => mapGroupedRow(r, processStart + i))}
                          </ReactWorkCollapse>
                          {afterProcessHeadRows.map((r, i) => mapGroupedRow(r, processEnd + i))}
                          {actionTailReady && tailRow ? (
                            <div className={ASSISTANT_ACTION_RHYTHM_END_CLASS}>
                              {mapGroupedRow(tailRow, rhythmEndIdx)}
                              {renderReActBlockActionIcons()}
                              {renderReActBlockFollowups()}
                            </div>
                          ) : actionTailReady ? (
                            <>
                              {renderReActBlockActionIcons()}
                              {renderReActBlockFollowups()}
                            </>
                          ) : null}
                        </div>
                      );
                    })()
                  ) : (
                    <div className="flex min-w-0 flex-1 flex-col gap-0">
                      {groupedWork.map((r, i) =>
                        renderGroupedRow(r, i, {
                          reactWorkColumn: true,
                          reactFlat: true,
                          reactShowActions: true,
                        }),
                      )}
                    </div>
                  )}
                </div>
                {finalAssistant
                  ? renderGroupedRow({ kind: "message", message: finalAssistant }, segIdx + 1000, {})
                  : null}
              </div>
            );
          })
        : groupedVisibleMessages.map((row, rowIdx) => {
            const lastToolGroupIdx = groupedVisibleMessages.reduce(
              (acc, groupedRow, index) => (groupedRow.kind === "tool_group" ? index : acc),
              -1,
            );
            return renderGroupedRow(row, rowIdx, {
              holdToolGroupProgress:
                row.kind === "tool_group" &&
                rowIdx === lastToolGroupIdx &&
                shouldHoldToolGroupProgress(pane.messages ?? [], row.messages, isStreamingCurrentSession),
            });
          });

    return (
    <>
      {sessionTurnsLoading ? (
        <div className="px-3 pb-1 text-[11px] text-text-faint" role="status">
          正在加载轮次变更…
        </div>
      ) : sessionTurnsLoadError ? (
        <div className="px-3 pb-1 text-[11px] text-[var(--status-error)]" role="alert">
          {sessionTurnsLoadError}
        </div>
      ) : null}
      {mainRows}
      {Object.entries(groupTyping).map(([agentId, name]) => {
        const typingSender = resolveGroupSender({
          role: "assistant",
          avatarName: name,
          avatarUrl: undefined,
          agentId,
        });
        const activityHint = String(groupActivityHint[agentId] ?? "").trim();
        const streamBody = visibleGroupStreamBody(groupStreamText[agentId] ?? "");
        const transientMessageId = streamBody
          ? `__group_stream__:${agentId}`
          : `typing-${agentId}`;
        return (
          <ImBubble
            key={transientMessageId}
            message={{
              id: transientMessageId,
              role: "assistant",
              content: streamBody || activityHint,
              avatarName: name,
              agentId,
            }}
            assistantName={typingSender.name}
            assistantAvatarUrl={typingSender.url}
            showSenderIdentity={isGroupPane}
            senderAvatarVariant="rounded-square"
            senderAvatarId={typingSender.avatarId}
            senderRoleLabel={resolveGroupSenderRoleLabel(typingSender.avatarId, groupHost?.id)}
            onOpenSenderProfile={handleOpenGroupMember}
            sessionBusy
          />
        );
      })}
      {((sessionWorkInProgress && !isStreamingCurrentSession) || midTurnStreamActivity) &&
      !isGroupPane &&
      (showToolCalls ||
        !(isStreamingCurrentSession
          ? lastTurnHasToolActivity(pane.messages)
          : lastTurnHasActiveToolActivity(pane.messages))) ? (
        <div className={useReActImLayout ? "-mt-2" : undefined}>
          <ImBubble
            key="typing-meta"
            message={{ id: "typing-meta", role: "assistant", content: "" }}
            assistantName={paneAvatarMeta.name}
            assistantAvatarUrl={paneAvatarMeta.url}
            assistantVisual={useReActImLayout ? "compact-inline" : "default"}
            noBubbleBorder={useReActImLayout}
            streamStalled={stallState === "stall"}
            streamStalledSeconds={silentSeconds}
          />
        </div>
      ) : null}
      {isStreamingCurrentSession && !hideStreamOverlayAsDuplicate && !useReActImLayout ? (
        chatStyle === "terminal" ? (
          <TerminalLine
            message={streamAssistantMessage}
            badge={
              showInlineAssistantModelBadge && streamingModel ? (
                <ModelBadge provider={streamingModel.provider} model={streamingModel.model} />
              ) : undefined
            }
          />
        ) : chatStyle === "clean" ? (
          <CleanBlock
            message={streamAssistantMessage}
            badge={
              showInlineAssistantModelBadge && streamingModel ? (
                <ModelBadge provider={streamingModel.provider} model={streamingModel.model} />
              ) : undefined
            }
          />
        ) : (
          <ImBubble
            message={streamAssistantMessage}
            resolvedReferences={resolveReferencesForAssistant(
              streamAssistantMessage,
              visibleMessagesWithStream,
            )}
            highlightTerms={pane.historySearchTerms}
            badge={
              showInlineAssistantModelBadge && streamingModel ? (
                <ModelBadge provider={streamingModel.provider} model={streamingModel.model} />
              ) : undefined
            }
            assistantName={paneAvatarMeta.name}
            assistantAvatarUrl={paneAvatarMeta.url}
            streamStalled={stallState === "stall"}
            streamStalledSeconds={silentSeconds}
          />
        )
      ) : null}
      {stallState === "stall" && (
        <StallRecoveryCard
          kind="stall"
          reason={stallReason}
          currentModelLabel={isAutomationTaskPane ? undefined : currentModelLabel}
          modelOptions={stallModelOptions}
          autoNudgeCount={autoNudgeCount}
          autoNudgeMax={stallRuntimeConfig.stall_auto_nudge_max_per_session}
          resumeInFlight={resumeInFlight}
          rejectReason={stallRejectReason}
          allowResume={
            !(
              stallReason === "incomplete" &&
              lastTurnHasToolActivity(pane.messages)
            )
          }
          onResume={() => void resumeCurrentTask()}
          onResumeWithModel={(provider, model) => void resumeWithModel(provider, model)}
          onStop={() => void stopCurrentRun()}
          stopInFlight={stoppingSessionId === (pane.sessionId || "").trim()}
        />
      )}
      {stallState === "exhausted" && (
        <StallRecoveryCard
          kind="exhausted"
          rounds={exhaustedRounds?.rounds}
          maxRounds={exhaustedRounds?.maxRounds}
          currentModelLabel={isAutomationTaskPane ? undefined : currentModelLabel}
          modelOptions={stallModelOptions}
          resumeInFlight={resumeInFlight}
          rejectReason={stallRejectReason}
          onResume={() => void resumeCurrentTask()}
          onResumeWithModel={(provider, model) => void resumeWithModel(provider, model)}
          onStop={() => void stopCurrentRun()}
          stopInFlight={stoppingSessionId === (pane.sessionId || "").trim()}
          onOpenSettings={() => useAppStore.getState().openSettings()}
        />
      )}
    </>
    );
  }, [autoNudgeCount, budgetExceededInfo, chatStyle, copyMessage, copyReActBlock, currentModelLabel, exhaustedRounds, favoriteMessage, forwardOneMessage, groupChatUserLabel, groupTyping, groupActivityHint, groupStreamText, groupedVisibleMessages, handleOpenGroupMember, handleToggleGroupReaction, openSubAgentDetailFromCluster, hideStreamOverlayAsDuplicate, isDedicatedAvatarPane, isGroupPane, isRunGuardCurrentSession, isStreamingCurrentSession, lastAssistantMessageId, midTurnStreamActivity, openFileReferencePreview, openWorkPanelSummary, openWorkspaceFilePreview, pane.avatarId, pane.historySearchTerms, pane.messages, pane.sessionId, paneAvatarMeta, paneId, readyAttachments.length, resolveGroupInlineConfirm, resolveGroupSender, resolveQuoteBody, resumeCurrentTask, resumeInFlight, resumeWithModel, revealFileInTaskspace, retryUserMessage, selectUpTo, selectedMessageIds, sendFollowupChip, sessionBusy, sessionWorkInProgress, addQuoteTarget, showInlineAssistantModelBadge, showToolCalls, silentSeconds, stallModelOptions, stallRejectReason, stallRuntimeConfig, stallState, stopCurrentRun, streamTextForCurrentSession, streamingModel, toggleSelectBlock, toggleSelectMessage, topLevelRowsIm, undoConsumedSessionId, userAvatarUrl, userBubbleLabel, feedbackAccountLoggedIn, feedbackEnabled, feedbackForMessage, feedbackHydrationStatus, feedbackState, feedbackUnavailableReason, canRetryFeedbackHydration, retryFeedbackHydration, handleFeedback, handleUndoSessionTurn, sessionTurnErrors, sessionTurns, sessionTurnsLoadError, sessionTurnsLoading, undoingTurnId]);

  const removeAttachment = useCallback((key: string) => {
    setContextFiles((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);

  const visionAttachBlocked =
    isKnownNonVisionChatModel(chatProvider, chatModel) && !visionFallback.available;
  const notifyImageAttach = () => {
    if (visionAttachBlocked) {
      setAttachToastMessage(VISION_UNSUPPORTED_TOAST);
      setAttachToastOpen(true);
      return;
    }
    if (isKnownNonVisionChatModel(chatProvider, chatModel) && visionFallback.available) {
      const key = `${paneId}:${chatProvider}/${chatModel}`;
      if (fallbackHintedRef.current !== key) {
        fallbackHintedRef.current = key;
        setAttachToastMessage(`当前模型不支持看图，将由 ${visionFallback.label || "视觉模型"} 解读图片`);
        setAttachToastOpen(true);
      }
    }
  };

  const parseLocalFile = useCallback((file: File, key: string) => {
    if (isImageFile(file) && isKnownNonVisionChatModel(chatProvider, chatModel)) {
      notifyImageAttach();
      if (visionAttachBlocked) return;
    }
    if (isVideoFile(file) && isKnownNonVisionChatModel(chatProvider, chatModel)) {
      setAttachToastOpen(true);
      return;
    }
    setContextFiles((prev) => ({
      ...prev,
      [key]: {
        name: file.name,
        size: file.size,
        mimeType: file.type || "application/octet-stream",
        status: "parsing",
        content: "",
      },
    }));

    if (isImageFile(file)) {
      const absolutePath = window.agenticxDesktop?.getPathForFile?.(file) || "";
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = typeof reader.result === "string" ? reader.result : "";
        setContextFiles((prev) => ({
          ...prev,
          [key]: {
            name: file.name,
            size: file.size,
            mimeType: file.type || "image/*",
            status: "ready",
            content: `[图片: ${file.name}]`,
            dataUrl,
            ...(absolutePath ? { sourcePath: absolutePath } : {}),
          },
        }));
      };
      reader.onerror = () => {
        setContextFiles((prev) => ({
          ...prev,
          [key]: {
            name: file.name,
            size: file.size,
            mimeType: file.type || "image/*",
            status: "error",
            content: "",
            errorText: "图片解析失败",
            ...(absolutePath ? { sourcePath: absolutePath } : {}),
          },
        }));
      };
      reader.readAsDataURL(file);
      return;
    }

    if (isLikelyTextFile(file)) {
      const absolutePath = window.agenticxDesktop?.getPathForFile?.(file) || "";
      const reader = new FileReader();
      reader.onload = () => {
        const text = typeof reader.result === "string" ? reader.result : "";
        setContextFiles((prev) => ({
          ...prev,
          [key]: {
            name: file.name,
            size: file.size,
            mimeType: file.type || "text/plain",
            status: "ready",
            content: text.slice(0, TEXT_ATTACHMENT_LIMIT),
            ...(absolutePath ? { sourcePath: absolutePath } : {}),
          },
        }));
      };
      reader.onerror = () => {
        setContextFiles((prev) => ({
          ...prev,
          [key]: {
            name: file.name,
            size: file.size,
            mimeType: file.type || "text/plain",
            status: "error",
            content: "",
            errorText: "文本解析失败",
            ...(absolutePath ? { sourcePath: absolutePath } : {}),
          },
        }));
      };
      reader.readAsText(file);
      return;
    }

    if (isReferenceableDocumentFile(file)) {
      const absolutePath = window.agenticxDesktop?.getPathForFile?.(file) || "";
      if (absolutePath) {
        setContextFiles((prev) => ({
          ...prev,
          [key]: {
            name: file.name,
            size: file.size,
            mimeType: file.type || "application/octet-stream",
            status: "ready",
            content: `[附件] ${file.name}`,
            sourcePath: absolutePath,
          },
        }));
        return;
      }
    }

    if (isVideoFile(file)) {
      const absolutePath = window.agenticxDesktop?.getPathForFile?.(file) || "";
      if (absolutePath) {
        setContextFiles((prev) => ({
          ...prev,
          [key]: {
            name: file.name,
            size: file.size,
            mimeType: file.type || "video/mp4",
            status: "ready",
            content: `[视频] ${file.name}（可用 video_understand 理解）`,
            sourcePath: absolutePath,
          },
        }));
        return;
      }
    }

    setContextFiles((prev) => ({
      ...prev,
      [key]: {
        name: file.name,
        size: file.size,
        mimeType: file.type || "application/octet-stream",
        status: "error",
        content: "",
        errorText: "不支持的文件格式",
      },
    }));
  }, [chatProvider, chatModel, notifyImageAttach, visionAttachBlocked]);

  useEffect(() => {
    if (!voiceInputHint) return;
    const t = window.setTimeout(() => setVoiceInputHint(""), 4200);
    return () => window.clearTimeout(t);
  }, [voiceInputHint]);

  const applyVoiceTranscript = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      const next = appendDictationText(extractComposerText(), trimmed);
      setComposerText(next);
    },
    [extractComposerText, setComposerText]
  );

  const { pttActive, pttLiveText, cancelPtt } = useVoicePushToTalk({
    enabled: Boolean(pane.sessionId),
    composerEmpty: !composerHasText,
    apiBase,
    apiToken,
    language: "zh-CN",
    onCommit: applyVoiceTranscript,
    onError: (message) => setVoiceInputHint(message),
  });

  useEffect(() => () => cancelPtt(), [cancelPtt]);

  const onMicClick = () => {
    cancelPtt();
    if (recording || voiceTranscribing) {
      dictationSessionRef.current?.stop();
      dictationSessionRef.current = null;
      setRecording(false);
      setVoiceTranscribing(false);
      return;
    }
    setVoiceInputHint("");
    void startDictation(
      {
        onPhase: (phase: SttPhase) => {
          setRecording(phase === "recording");
          setVoiceTranscribing(phase === "transcribing");
        },
        onInterim: (interim) => {
          if (!interim.trim()) return;
          setVoiceInputHint(interim.trim());
        },
        onFinal: (text) => {
          dictationSessionRef.current = null;
          setRecording(false);
          setVoiceTranscribing(false);
          setVoiceInputHint("");
          applyVoiceTranscript(text);
        },
        onError: (message) => {
          setVoiceInputHint(message);
        },
      },
      {
        apiBase,
        apiToken,
        language: "zh",
      }
    ).then((session) => {
      dictationSessionRef.current = session;
    });
  };

  const sendChatRef = useRef<(
    text: string,
    options?: {
      retryAttachments?: MessageAttachment[];
      suppressUserEcho?: boolean;
      skipUserHistory?: boolean;
      forceSend?: boolean;
      queueDrain?: boolean;
      lockedSessionId?: string;
      provider?: string;
      model?: string;
      continuation?: { reason: ContinueReason; source: ContinueSource };
    }
  ) => Promise<void>>(
    async () => {}
  );
  const resumeInNewSessionRef = useRef<() => void>(() => {});

  /** Materialize a lazy session (fresh topic / no sessionId yet) with full create params. */
  const materializeLazySession = useCallback(async (): Promise<string | null> => {
    const existing = (pane.sessionId || "").trim();
    if (existing) return existing;

    try {
      const avatarId = sessionCreateAvatarId(pane.avatarId);
      const inheritFrom = peekPaneLazyInheritParent(pane.id);
      const pendingMode = peekPanePendingSessionMode(pane.id) ?? pane.sessionMode ?? "daily_office";
      const created = await window.agenticxDesktop.createSession({
        avatar_id: avatarId,
        session_mode: pendingMode,
        permission_mode: runMode,
        ...(inheritFrom ? { inherit_from_session_id: inheritFrom } : {}),
        ...(chatProvider && chatModel ? { provider: chatProvider, model: chatModel } : {}),
      });
      if (!created.ok || !created.session_id) {
        console.error("[ChatPane] materializeLazySession failed:", created.error);
        return null;
      }
      const newSessionId = created.session_id;
      // The create call can resolve after this pane has navigated to an
      // existing session. Do not overwrite that session with the old lazy A
      // request's newly-created id.
      const currentPane = useAppStore.getState().panes.find((row) => row.id === pane.id);
      if (String(currentPane?.sessionId ?? "").trim()) return null;
      migrateActiveComposerDraftToSession(newSessionId);
      migratePaneKbRetrievalModeToSession(pane.id, newSessionId);
      clearPaneLazyInheritParent(pane.id);
      clearPanePendingSessionMode(pane.id);
      clearPendingSessionRunMode(pane.id);
      setSessionRunMode(
        newSessionId,
        normalizeRunMode(created.permission_mode ?? runMode),
      );
      setPaneSessionMode(pane.id, created.session_mode ?? pendingMode);
      if (created.inherited) {
        setPaneContextInherited(pane.id, true);
      }
      freshlyCreatedSessionRef.current = newSessionId;
      setPaneSessionId(pane.id, newSessionId, {
        provider: chatProvider || undefined,
        model: chatModel || undefined,
      });
      clearPaneAwaitingFreshSession(pane.id);
      useAppStore.getState().bumpSessionCatalogRevision();
      window.setTimeout(() => useAppStore.getState().bumpSessionCatalogRevision(), 450);
      return newSessionId;
    } catch (err) {
      console.error("[ChatPane] materializeLazySession threw:", err);
      return null;
    }
  }, [
    pane.id,
    pane.avatarId,
    pane.sessionId,
    pane.sessionMode,
    chatProvider,
    chatModel,
    setPaneSessionId,
    setPaneSessionMode,
    setPaneContextInherited,
    setSessionRunMode,
    clearPendingSessionRunMode,
    runMode,
    migrateActiveComposerDraftToSession,
  ]);

  /** Apply a team-mode action to the active server-side GraphRun. */
  const sendGroupTeamAction = async (
    action: string,
    data?: Record<string, unknown>,
  ): Promise<boolean> => {
    const requestSessionId = (pane?.sessionId || "").trim();
    if (!isGroupPane || !groupChatId || !requestSessionId) return false;
    // The ref closes the race between two clicks before React commits the
    // disabled attribute; the state drives the immediate visual disabled UI.
    if (groupTeamActionPendingRef.current) return false;
    groupTeamActionPendingRef.current = true;
    setGroupTeamActionPending(true);
    const requestPaneId = pane.id;
    const actionGeneration = ++groupTeamActionGenerationRef.current;
    const normalizedAction = String(action || "").trim().toLowerCase();
    const previousTeamControlState =
      normalizedAction === "stop" ? effectiveGroupTeamControlState : "idle";
    const previousUserStopped =
      normalizedAction === "stop"
        ? Boolean(userStoppedSessionRef.current[requestSessionId])
        : false;
    const previousRunGuardSessionId =
      normalizedAction === "stop" ? runGuardSessionId : "";
    const isCurrentActionSession = () => {
      const currentPane = useAppStore
        .getState()
        .panes.find((candidate) => candidate.id === requestPaneId);
      return (
        actionGeneration === groupTeamActionGenerationRef.current &&
        (currentPane?.sessionId || "").trim() === requestSessionId
      );
    };
    const restoreFailedTeamStop = () => {
      if (normalizedAction !== "stop" || !isCurrentActionSession()) return;
      // The HTTP action may fail after a lifecycle event has already reached
      // the client. Restore the state that was visible before this user stop
      // attempt instead of leaving a failed optimistic `stopped` projection.
      setGroupTeamControlStateForSession(requestSessionId, previousTeamControlState);
      userStoppedSessionRef.current[requestSessionId] = previousUserStopped;
      setRunGuardSessionId((current) =>
        current === requestSessionId ? previousRunGuardSessionId : current,
      );
      setStallState("none");
      setStallWait(null);
      setStallRejectReason("");
    };
    if (normalizedAction === "stop") {
      // Stop is an explicit user decision. Set the guard before the network
      // round-trip so Channel C/unattended cannot sneak in while the action is
      // pending; restore it if the authoritative action fails below.
      userStoppedSessionRef.current[requestSessionId] = true;
      setRunGuardSessionId(requestSessionId);
      setStallState("none");
      setStallWait(null);
      setStallRejectReason("");
      setGroupTeamControlStateForSession(requestSessionId, "stopped");
    }
    try {
      // Use the same live backend selected by the desktop store as the chat
      // stream. Dev Electron uses an ephemeral local port, so a global/default
      // URL can silently send controls to a different (or absent) runtime.
      const actionApiBase = String(apiBase || "").replace(/\/+$/, "");
      const response = await fetch(`${actionApiBase}/api/groups/${groupChatId}/action`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-agx-desktop-token": apiToken,
        },
        body: JSON.stringify({ action, session_id: requestSessionId, data: data ?? {} }),
      });
      const raw = await response.text().catch(() => "");
      let result: Record<string, unknown> = {};
      try {
        const parsed = raw ? JSON.parse(raw) : null;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          result = parsed as Record<string, unknown>;
        }
      } catch {
        // A non-JSON response is still reported through the status check.
      }
      if (!isCurrentActionSession()) return false;
      if (!response.ok || result.ok === false) {
        const detail = String(result.detail ?? result.error ?? "").trim();
        throw new Error(`HTTP ${response.status}${detail ? `: ${detail.slice(0, 180)}` : ""}`);
      }
      const graphEvent = result.graph_event;
      const responseRunId =
        String(result.run_id || "").trim() ||
        (graphEvent && typeof graphEvent === "object" && !Array.isArray(graphEvent)
          ? String((graphEvent as Record<string, unknown>).run_id || "").trim()
          : "");
      if (
        responseRunId &&
        !shouldApplyGroupGraphEvent(
          currentGroupGraphRunId(requestSessionId),
          responseRunId,
          // This authenticated action response comes from the exact live
          // group/session controller. It may be the first execution Graph id
          // the UI sees when PAUSE landed during planning, before
          // graph.run_created was streamed; replacing the presence graph is
          // therefore an authoritative run transition, not a stale event.
          {
            allowRunSwitch: true,
            eventType: "graph.run_created",
            authoritative: true,
          },
        )
      ) {
        restoreFailedTeamStop();
        return false;
      }
      if (responseRunId) rememberGroupGraphRunId(requestSessionId, responseRunId);
      if (
        graphEvent &&
        typeof graphEvent === "object" &&
        !Array.isArray(graphEvent) &&
        String((graphEvent as Record<string, unknown>).type || "").startsWith("graph.")
      ) {
        const graphPayload = graphEvent as GraphSsePayload;
        if (acceptsGroupGraphEvent(requestSessionId, graphPayload)) {
          useGraphRunStore.getState().applyEvent(pane.id, graphPayload, {
            trustedOwner: {
              sessionId: requestSessionId,
              groupId: groupChatId || "",
            },
          });
        }
      }
      if (normalizedAction === "pause") {
        recordSseActivity(requestSessionId);
        setGroupTeamControlStateForSession(requestSessionId, "paused");
        setStallState("none");
        setStallWait(null);
        setStallRejectReason("");
        setStallHintToast("团队任务已暂停");
      } else if (normalizedAction === "resume") {
        // Paused wall time is intentional waiting, not model silence. Start a
        // fresh liveness window when work resumes so the UI cannot jump
        // straight from “暂停等待” to “响应较慢/卡住”.
        recordSseActivity(requestSessionId);
        setGroupTeamControlStateForSession(requestSessionId, "running");
        setStallHintToast("团队任务已继续");
      } else if (normalizedAction === "stop") {
        // Explicit Team STOP is a user decision, not an ordinary runtime
        // failure. Mark it before the next detector tick so Channel C and
        // unattended continuation cannot restart this run automatically.
        userStoppedSessionRef.current[requestSessionId] = true;
        setRunGuardSessionId(requestSessionId);
        setStallState("none");
        setStallWait(null);
        setStallRejectReason("");
        setGroupTeamControlStateForSession(requestSessionId, "stopped");
        setStallHintToast("团队任务已停止");
      } else if (normalizedAction === "add_task") {
        recordSseActivity(requestSessionId);
        setStallHintToast("任务已加入本轮协作");
      }
      return true;
    } catch (e) {
      if (!isCurrentActionSession()) return false;
      restoreFailedTeamStop();
      console.warn("[GroupTeam] action failed:", e);
      const reason = String(e instanceof Error ? e.message : e).trim() || "未知错误";
      setStallHintToast(`群聊操作失败：${reason.slice(0, 180)}`);
      return false;
    } finally {
      // A session switch can reset the pending ref and a new action can start
      // before this request resolves. Only the generation that claimed the
      // pending slot may release it.
      if (groupTeamActionGenerationRef.current === actionGeneration) {
        groupTeamActionPendingRef.current = false;
        setGroupTeamActionPending(false);
      }
    }
  };

  const sendChat = async (
    userText: string,
    options?: {
      retryAttachments?: MessageAttachment[];
      suppressUserEcho?: boolean;
      skipUserHistory?: boolean;
      forceSend?: boolean;
      queueDrain?: boolean;
      lockedSessionId?: string;
      /** Explicit model for a recovery/retry turn; avoids reading stale pane state. */
      provider?: string;
      model?: string;
      continuation?: { reason: ContinueReason; source: ContinueSource };
    }
  ) => {
    // Normalize the target before any confirmation shortcut. Queue/system
    // sends can be resumed by a newer pane render while their original
    // session is off-screen; they must never consume a confirmation card from
    // the currently displayed session.
    const lockedSessionId = String(options?.lockedSessionId ?? "").trim();
    const isAutomaticSessionSend = Boolean(
      lockedSessionId ||
        options?.queueDrain ||
        options?.suppressUserEcho ||
        options?.skipUserHistory,
    );
    const isLockedSessionDisplayed = () => {
      if (!lockedSessionId) return true;
      const currentPane = useAppStore.getState().panes.find((row) => row.id === pane.id);
      return isPaneDisplayingSession(currentPane, pane.id, lockedSessionId);
    };
    const continuation = options?.continuation;
    const isContinuation = !!continuation;
    const requestProvider = String(options?.provider ?? chatProvider ?? "").trim();
    const requestModel = String(options?.model ?? chatModel ?? "").trim();
    // Freeze the quote payload before any async session materialization or
    // composer cleanup. This keeps the exact selected sentence attached to
    // the request even if React processes clearQuoteTargets meanwhile.
    const quotePayloadAtSend = isContinuation ? {} : buildQuotedPayload();
    const composerDisplayText = buildComposerDisplayText();
    const text = userText.trim();
    const hasQuotePayloadEarly =
      quoteTargetsRef.current.length > 0 || Boolean(quotePayloadAtSend.quotedContent);
    // Quote-only turns: keep user_input empty (chips carry context); avoid "见附件" placeholder.
    const messageText = isContinuation
      ? " "
      : text || (hasQuotePayloadEarly ? "" : ATTACHMENT_ONLY_USER_PROMPT);
    const clientTurnId = isContinuation ? "" : crypto.randomUUID();
    const approvalRunId = clientTurnId || crypto.randomUUID();
    const retryAttachments = options?.retryAttachments;
    let suppressUserEcho = isContinuation || !!options?.suppressUserEcho;
    let skipUserHistory = isContinuation || !!options?.skipUserHistory;
    const readyEntries = attachmentEntries.filter(([, file]) => file.status === "ready");
    const composerAttachments: MessageAttachment[] = readyAttachments.map((file) => ({
      name: file.name,
      mimeType: file.mimeType,
      size: file.size,
      dataUrl: file.dataUrl,
      sourcePath: file.sourcePath,
      referenceToken: file.referenceToken,
      composerRefLabel: file.composerRefLabel,
      lineRange: file.lineRange,
      spreadsheetRef: file.spreadsheetRef,
      snippetRef: file.snippetRef,
      snippetContent: file.snippetContent,
      htmlElementRef: file.htmlElementRef,
    }));
    const rawUserAttachments: MessageAttachment[] =
      retryAttachments && retryAttachments.length > 0
        ? retryAttachments.map((item) => ({ ...item }))
        : composerAttachments;
    // Do not drop reference/workspace attachments when the user asks a short follow-up without @文件名;
    // otherwise context_files never reaches the model and the file looks "invisible".
    const userAttachments: MessageAttachment[] = rawUserAttachments;
    const refAttachments = userAttachments.filter((item) => isWorkspaceReferenceAttachment(item));
    let outboundMessageText =
      refAttachments.length > 0
        ? canonicalizeUserReferenceMentions(messageText, refAttachments)
        : messageText;
    // Trae「评论到对话」: chip shows tag · comment; model must see the comment in user_input too.
    for (const att of refAttachments) {
      const comment = String(att.htmlElementRef?.comment || "").trim();
      if (comment && !outboundMessageText.includes(comment)) {
        outboundMessageText = `${outboundMessageText}\n${comment}`;
      }
    }
    const hasReadyAttachments = userAttachments.length > 0;
    const hasQuotePayload = Boolean(quotePayloadAtSend.quotedContent);
    if (!isContinuation && !text && !hasReadyAttachments && !hasQuotePayload) return;

    // A queued A message may reach this current B render after navigation.
    // Put it back into the pane queue rather than dropping it or resolving a
    // B confirmation card; it will drain when A is displayed again.
    if (options?.queueDrain && lockedSessionId && !isLockedSessionDisplayed()) {
      enqueuePaneMessage(pane.id, {
        id: crypto.randomUUID(),
        text: messageText,
        sessionId: lockedSessionId,
        attachments: userAttachments,
        contextFiles: [],
        timestamp: Date.now(),
      });
      return;
    }
    if (!apiBase) return;

    if (shouldPinScrollOnUserSend({ continuation, queueDrain: options?.queueDrain })) {
      pinChatListToLatestTurn();
    }

    // Exact 「确认/取消」 phrases resolve a unique pending action card without a new LLM turn.
    if (!isContinuation && !isAutomaticSessionSend && text && !hasReadyAttachments) {
      const decision = matchActionConfirmationReply(text);
      if (decision) {
        const found = findResolvableActionConfirmation({
          messages: pane.messages ?? [],
          paneSessionId: (pane.sessionId || "").trim(),
        });
        if (found.kind === "hit") {
          setComposerText("");
          clearQuoteTargets();
          flushComposerDraftNowRef.current();
          await resolveActionConfirmation(found.confirmation, decision, "manual");
          return;
        }
      }
    }

    const sendLockKey = pane.id;
    const targetSendSid = (options?.lockedSessionId || pane.sessionId || "").trim();
    // A stop request owns its session until the interrupt result settles. Do
    // not start or queue a new foreground turn against that session: the
    // backend interrupt and the new turn would otherwise race, and the old
    // stop could still settle over the new run.
    if (targetSendSid && stopInFlightRef.current[targetSendSid]) {
      const currentPane = useAppStore.getState().panes.find((row) => row.id === pane.id);
      if (isPaneDisplayingSession(currentPane, pane.id, targetSendSid)) {
        setStallHintToast("正在停止当前任务，请稍候再发送");
      }
      return;
    }
    const inFlightForPane =
      sendChatInFlightRef.current?.paneId === sendLockKey
        ? (sendChatInFlightRef.current.sessionId || "").trim()
        : "";
    const canQueueFollowUp =
      !isContinuation && !options?.suppressUserEcho && !options?.skipUserHistory;
    const awaitingFreshSession = isPaneAwaitingFreshSession(pane.id);

    const resolveStreamRunActive = (sessionKey: string) =>
      isStreamRunActiveForQueue({
        sessionId: sessionKey,
        streamStateActive: !!sessionStreamStateRef.current[sessionKey]?.active,
        sendInFlightForSession:
          !!inFlightForPane && inFlightForPane === sessionKey.trim(),
        executionState: sessionExecutionState,
        currentSessionId: pane.sessionId || "",
      });

    const tryEnqueueFollowUp = (sessionKey: string): boolean => {
      const sid = sessionKey.trim();
      if (!sid || !canQueueFollowUp) return false;
      if (
        !shouldEnqueueOnResend({
          isStreamRunActive: resolveStreamRunActive(sid),
          forceSend: options?.forceSend,
          queueDrain: options?.queueDrain,
        })
      ) {
        return false;
      }
      enqueuePaneMessage(pane.id, {
        id: crypto.randomUUID(),
        text: messageText,
        sessionId: sid,
        attachments: userAttachments,
        contextFiles: [],
        timestamp: Date.now(),
      });
      setComposerText("");
      clearQuoteTargets();
      contextFilesRef.current = {};
      setContextFiles({});
      flushComposerDraftNowRef.current();
      return true;
    };

    const queueSessionKey = resolveQueueSessionKey({
      currentSessionId: targetSendSid,
      inFlightSessionId: inFlightForPane,
      awaitingFreshSession,
    });
    if (tryEnqueueFollowUp(queueSessionKey)) return;

    // 计算本次发送的目标 session（用于跨 session 并发判断）
    let holdSendLock = false;
    // Keep the exact lock object held by this invocation.  A force-send (or a
    // fresh-session send) can replace the pane lock while an older reader is
    // still unwinding; comparing only paneId lets that old finally clear the
    // newer invocation's lock and admit a duplicate send.
    let heldSendLock: { paneId: string; sessionId: string } | null = null;
    const claimSendLock = (sessionId: string) => {
      const lock = { paneId: sendLockKey, sessionId };
      sendChatInFlightRef.current = lock;
      heldSendLock = lock;
      holdSendLock = true;
    };
    const releaseSendLock = () => {
      if (holdSendLock && heldSendLock && sendChatInFlightRef.current === heldSendLock) {
        sendChatInFlightRef.current = null;
      }
    };
    if (!options?.forceSend) {
      if (sendChatInFlightRef.current?.paneId === sendLockKey) {
        const inFlightSid = sendChatInFlightRef.current.sessionId;
        if (inFlightSid && targetSendSid && inFlightSid !== targetSendSid) {
          // 旧流属于不同 session（用户切换了历史会话后点击 chip）：
          // 不阻断新 session 的发送，也不抢占旧锁（旧流会在 finally 里自行释放）。
          // holdSendLock 保持 false，此次不持锁。
        } else if (isPaneAwaitingFreshSession(pane.id)) {
          // "全新对话" 是显式抢占旧会话：旧流若卡住，必须允许首条消息发送，
          // 否则会表现为输入可见但点击发送无反应。
          sendChatInFlightRef.current = null;
          claimSendLock(targetSendSid);
        } else if (tryEnqueueFollowUp(inFlightSid || targetSendSid)) {
          return;
        } else {
          console.warn("[ChatPane] dropped concurrent sendChat on pane", sendLockKey);
          return;
        }
      } else {
        claimSendLock(targetSendSid);
      }
    }

    let requestSessionId = resolveSendSessionId(options?.lockedSessionId, pane.sessionId);
    // Dev-only invariant: every async/system send (continuation / retry / queued /
    // forward) MUST lock the session id captured at dispatch time. Reading the live
    // pane.sessionId for these paths is the root cause of cross-session leakage.
    const isSystemStyleSend =
      isContinuation || !!options?.suppressUserEcho || !!options?.skipUserHistory;
    if (
      import.meta.env?.DEV &&
      isSystemStyleSend &&
      !String(options?.lockedSessionId ?? "").trim()
    ) {
      console.warn(
        "[ChatPane] system-style send without lockedSessionId — potential cross-session leak source",
        { source: options?.continuation?.source },
      );
    }
    const clearStopSuppressForSession = (sessionKey: string) => {
      const key = sessionKey.trim();
      if (!key) return;
      delete userStoppedSessionRef.current[key];
    };

    if (!requestSessionId) {
      // Meta lazy-creates on first send; group/automation must also materialize
      // here (createNewTopic clears sessionId — previously bailed and looked stuck).
      const materializedSessionId = await materializeLazySession();
      if (!materializedSessionId) {
        addPaneMessage(
          pane.id,
          "tool",
          "⚠️ 无法创建会话：未知错误。请检查后端服务。",
          "meta"
        );
        releaseSendLock();
        return;
      }
      requestSessionId = materializedSessionId;
      const materializedPane = useAppStore.getState().panes.find((row) => row.id === pane.id);
      if (!isPaneDisplayingSession(materializedPane, pane.id, materializedSessionId)) {
        releaseSendLock();
        return;
      }
      // Defensive reset: a brand-new lazy session must never display any
      // residual messages from the previously-running session (which may
      // have been racily restored by poll/sync effects while sessionId
      // was transitioning from "" to the new id).
      useAppStore.getState().setPaneMessages(pane.id, []);
      lastPollCountRef.current = 0;
      pollSessionSidRef.current = requestSessionId;
    }
    if (stopInFlightRef.current[requestSessionId]) {
      releaseSendLock();
      return;
    }
    // A completed stop may keep its short-lived tail-merge lease alive. A
    // genuinely new foreground turn supersedes that lease before it can
    // merge an old interrupted tail into the new turn.
    delete stopRunLeasesRef.current[requestSessionId];
    const isStreamRunActive = resolveStreamRunActive(requestSessionId);
    const isForceSessionStillDisplayed = () => {
      const currentPane = useAppStore.getState().panes.find((row) => row.id === pane.id);
      return isPaneDisplayingSession(currentPane, pane.id, requestSessionId);
    };

    // A forced resend may be queued behind an async session/materialization
    // step. Do not interrupt A or let its cleanup paint B after navigation.
    if (!isForceSessionStillDisplayed()) {
      releaseSendLock();
      return;
    }

    if (
      shouldInterruptOnResend({
        isStreamRunActive,
        forceSend: options?.forceSend,
        queueDrain: options?.queueDrain,
      })
    ) {
      // Force-send while streaming: abort the current run, then start the new round.
      // Claim the visible partial before abort/overlay cleanup (same helper as Stop).
      // Invalidate a read-only reattach before the network interrupt: the old
      // reader may have a buffered token/done/graph frame ready to resolve
      // while this await is in flight.
      invalidateReattachStreamForSession(requestSessionId);
      const groupInterruptedPersistence = isGroupPane
        ? preserveGroupInterruptedPartials(
            requestSessionId,
            "barge-in",
            requestProvider || undefined,
            requestModel || undefined,
          )
        : null;
      const preservedVisiblePartial = isGroupPane
        ? false
        : preserveUncommittedStreamPartial(
            requestSessionId,
            requestProvider || undefined,
            requestModel || undefined,
          );
      try {
        await window.agenticxDesktop.interruptSession?.(requestSessionId);
        if (groupInterruptedPersistence) await groupInterruptedPersistence;
      } catch (err) {
        if (groupInterruptedPersistence) await groupInterruptedPersistence;
        console.warn("[ChatPane] barge-in interrupt failed:", err);
      }
      const prevAbort = sessionAbortControllersRef.current[requestSessionId];
      if (prevAbort) {
        try {
          prevAbort.abort();
        } catch {
          // Already aborted.
        }
        delete sessionAbortControllersRef.current[requestSessionId];
      }
      if (isGroupPane && isForceSessionStillDisplayed()) clearAllGroupMemberStatus();
      const prevState = sessionStreamStateRef.current[requestSessionId];
      if (prevState) {
        prevState.active = false;
        prevState.text = "";
        sessionStreamStateRef.current[requestSessionId] = prevState;
      }
      if (isForceSessionStillDisplayed()) {
        setStreamedAssistantText("");
      }
      if (isForceSessionStillDisplayed()) setStallState("none");

      // Close a turn that produced no visible assistant output. A claimed partial
      // is already in the pane and Studio persists the same interrupted partial
      // while completing the old runtime.
      const tailMsgs = (useAppStore.getState().panes.find((p) => p.id === pane.id)?.messages ?? [])
        .filter((m) => m.role !== "tool");
      const lastNonTool = tailMsgs[tailMsgs.length - 1];
      if (
        isForceSessionStillDisplayed() &&
        !isGroupPane &&
        !preservedVisiblePartial &&
        (!lastNonTool || lastNonTool.role === "user")
      ) {
        const interruptedNote = "（已中断）";
        const interruptedNoteMetadata = buildInterruptedAssistantMetadata("barge-in");
        addPaneMessage(
          pane.id,
          "assistant",
          interruptedNote,
          "meta",
          requestProvider,
          requestModel,
          undefined,
          { metadata: interruptedNoteMetadata },
        );
        try {
          await fetch(`${apiBase}/api/session/messages/append`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-agx-desktop-token": apiToken,
            },
            body: JSON.stringify({
              session_id: requestSessionId,
              messages: [
                {
                  role: "assistant",
                  content: interruptedNote,
                  metadata: interruptedNoteMetadata,
                },
              ],
            }),
          });
        } catch (err) {
          console.warn("[ChatPane] append interrupted placeholder failed:", err);
        }
      }
      // Fall through: proceed with a normal send below.
    }

    if (!isForceSessionStillDisplayed()) {
      releaseSendLock();
      return;
    }

    const otherPanesWithSameSession = panes.filter(
      (p) => p.id !== pane.id && (p.sessionId || "").trim() === requestSessionId && requestSessionId.length > 0
    );
    if (otherPanesWithSameSession.length > 0) {
      console.warn(
        "[ChatPane] session collision detected: pane %s shares session %s with %d other pane(s); creating isolated session",
        pane.id,
        requestSessionId,
        otherPanesWithSameSession.length,
      );
      try {
        const avatarId = sessionCreateAvatarId(pane.avatarId);
        const created = await window.agenticxDesktop.createSession({
          avatar_id: avatarId,
          permission_mode: runMode,
        });
        if (!isForceSessionStillDisplayed()) {
          releaseSendLock();
          return;
        }
        if (created.ok && created.session_id) {
          requestSessionId = created.session_id;
          setSessionRunMode(
            requestSessionId,
            normalizeRunMode(created.permission_mode ?? runMode),
          );
          // Fresh isolated session must start with a clean pane so we do not
          // keep displaying the shared/stale messages from the colliding peer.
          useAppStore.getState().setPaneMessages(pane.id, []);
          lastPollCountRef.current = 0;
          pollSessionSidRef.current = requestSessionId;
          freshlyCreatedSessionRef.current = requestSessionId;
          setPaneSessionId(pane.id, requestSessionId);
          addPaneMessage(pane.id, "tool", "⚠️ 检测到会话冲突，已自动切换到独立会话。", "meta");
        }
      } catch (err) {
        console.error("[ChatPane] failed to create isolated session:", err);
      }
      releaseSendLock();
      return;
    }

    if (
      !isContinuation &&
      !skipUserHistory &&
      !options?.suppressUserEcho &&
      messageText.trim() &&
      requestSessionId &&
      !options?.forceSend
    ) {
      const now = Date.now();
      if (
        shouldDropDuplicateUserSend(
          lastUserSendDedupeRef.current,
          requestSessionId,
          messageText,
          now,
        )
      ) {
        console.warn(
          "[ChatPane] dropped duplicate user send within dedupe window",
          requestSessionId,
          messageText.slice(0, 48),
        );
        releaseSendLock();
        return;
      }
      lastUserSendDedupeRef.current = {
        sessionId: requestSessionId,
        text: messageText,
        at: now,
      };
    }

    // Re-sending the same user text after a completed turn (input box, not the retry
    // button) must truncate the prior assistant/tool tail and strip [compacted] blocks;
    // otherwise run_turn proactive compaction re-summarizes the old answer into context.
    if (
      !isContinuation &&
      !skipUserHistory &&
      !options?.suppressUserEcho &&
      messageText.length > 0 &&
      requestSessionId
    ) {
      const currentMsgs =
        useAppStore.getState().panes.find((p) => p.id === pane.id)?.messages ?? pane.messages ?? [];
      let implicitRetryIdx = -1;
      for (let i = currentMsgs.length - 1; i >= 0; i -= 1) {
        const row = currentMsgs[i];
        if (!row || row.role !== "user" || row.content !== messageText) continue;
        if (hasTrailingTurnMessages(currentMsgs, i)) {
          implicitRetryIdx = i;
          break;
        }
      }
      if (implicitRetryIdx >= 0) {
        const userOccurrence = countUserOccurrenceThrough(
          currentMsgs,
          implicitRetryIdx,
          messageText
        );
        const ok = await truncateSessionAtUserMessage(
          requestSessionId,
          messageText,
          "after",
          userOccurrence,
          true
        );
        if (!isForceSessionStillDisplayed()) {
          releaseSendLock();
          return;
        }
        if (!ok) {
          await reloadSessionFromDisk(requestSessionId, {
            isCurrentOwner: isForceSessionStillDisplayed,
          });
          releaseSendLock();
          return;
        }
        if (!isForceSessionStillDisplayed()) {
          releaseSendLock();
          return;
        }
        setPaneMessages(pane.id, currentMsgs.slice(0, implicitRetryIdx + 1));
        suppressUserEcho = true;
        skipUserHistory = true;
      }
      if (!isForceSessionStillDisplayed()) {
        releaseSendLock();
        return;
      }
    }

    const selectedIsPaneSubagent =
      !!selectedSubAgent && paneSubAgents.some((item) => item.id === selectedSubAgent);
    const targetAgentId = selectedIsPaneSubagent ? selectedSubAgent : "meta";
    const mentionedAvatarIds = isGroupPane
      ? extractGroupMentionIds(text, groupMembers, {
          metaId: groupHost?.id,
          metaLabels: groupHost
            ? [
              "主持人",
              "组长",
            ]
            : [],
        })
      : [];
    if (
      !isContinuation &&
      !options?.forceSend &&
      shouldSuppressDuplicatePendingUserEcho(
        useAppStore.getState().panes.find((p) => p.id === pane.id)?.messages ?? pane.messages ?? [],
        messageText,
        userAttachments,
        clientTurnId,
      )
    ) {
      suppressUserEcho = true;
      skipUserHistory = true;
    }

    // Chat uploads (not workspace @file refs) → real files under <default>/attachments/.
    let sendAttachments: MessageAttachment[] = userAttachments;
    let attachmentRoutingDecision: "private" | "public" | undefined;
    if (
      !isContinuation &&
      requestSessionId &&
      userAttachments.length > 0 &&
      typeof window.agenticxDesktop?.materializeSessionAttachments === "function"
    ) {
      const materializeIdx: number[] = [];
      const filesPayload: Array<{ name?: string; path?: string; dataUrl?: string }> = [];
      userAttachments.forEach((att, idx) => {
        if (isWorkspaceReferenceAttachment(att)) return;
        if (!att.dataUrl && !String(att.sourcePath || "").trim()) return;
        materializeIdx.push(idx);
        filesPayload.push({
          name: att.name,
          path: att.sourcePath,
          dataUrl: att.dataUrl,
        });
      });
      if (filesPayload.length > 0) {
        try {
          const materialized = await window.agenticxDesktop.materializeSessionAttachments({
            sessionId: requestSessionId,
            files: filesPayload,
          });
          if (materialized.ok && Array.isArray(materialized.files)) {
            const next = userAttachments.map((att) => ({ ...att }));
            materialized.files.forEach((row, i) => {
              const at = materializeIdx[i];
              if (at === undefined || !row?.path) return;
              next[at] = { ...next[at], sourcePath: row.path };
            });
            sendAttachments = next;
            if (isForceSessionStillDisplayed()) {
              window.dispatchEvent(
                new CustomEvent(NEAR_ARTIFACT_TASKSPACES_SYNCED, {
                  detail: { sessionId: requestSessionId, added: materialized.files.length },
                }),
              );
            }
          }
        } catch (err) {
          console.warn("[ChatPane] materializeSessionAttachments failed:", err);
        }
      }
    }

    if (!isContinuation && requestSessionId && sendAttachments.length > 0) {
      const attachmentRoutingLock =
        useAppStore.getState().attachmentRoutingLocks[requestSessionId] ?? null;
      const routingDecision = decideAttachmentRouting({
        policy: attachmentRoutingPolicy,
        filenames: sendAttachments.map((attachment) => attachment.name),
        lockedTarget: attachmentRoutingLock,
      });
      if (
        routingDecision.action === "lock" &&
        routingDecision.announce &&
        canChoosePublicAttachmentRoute
      ) {
        const choice = await requestAttachmentRoutingChoice(routingDecision.target);
        if (choice === "cancel") {
          releaseSendLock();
          return;
        }
        attachmentRoutingDecision = choice;
        if (choice === "public") {
          if (isForceSessionStillDisplayed()) setComposerPermissionError("");
          const recordPublicOverride =
            window.agenticxDesktop?.recordAttachmentRoutingPublicOverride;
          if (typeof recordPublicOverride !== "function") {
            if (isForceSessionStillDisplayed()) {
              setComposerPermissionError("当前桌面版本无法记录公网模型例外，请更新后重试");
            }
            releaseSendLock();
            return;
          }
          const audit = await recordPublicOverride({
            sessionId: requestSessionId,
            currentModel: requestModel || requestProvider,
            privateTarget: routingDecision.target.id,
            attachmentNames: sendAttachments.map((attachment) => attachment.name),
          });
          if (!audit.ok) {
            if (isForceSessionStillDisplayed()) {
              setComposerPermissionError(
                audit.error || "公网模型例外暂时无法记录，本轮未发送",
              );
            }
            releaseSendLock();
            return;
          }
        }
      } else if (routingDecision.action === "lock") {
        attachmentRoutingDecision = "private";
      }
    }

    // Several pre-stream steps can await (attachment materialization, routing
    // choice, session creation). If the user navigates this pane during one of
    // those awaits, do not let the old A request start painting into B.
    const paneAtSend = useAppStore.getState().panes.find((row) => row.id === pane.id);
    if (
      !isPaneDisplayingSession(paneAtSend, pane.id, requestSessionId) ||
      stopInFlightRef.current[requestSessionId]
    ) {
      releaseSendLock();
      return;
    }

    if (targetAgentId === "meta") {
      if (!suppressUserEcho) {
        const userEchoContent =
          quoteTargetsRef.current.length > 0 ? composerDisplayText : messageText;
        addPaneMessage(
          pane.id,
          "user",
          userEchoContent,
          "meta",
          undefined,
          undefined,
          sendAttachments,
          {
            ownerSessionId: requestSessionId,
            metadata: { client_turn_id: clientTurnId },
            ...(() => {
              if (!quotePayloadAtSend.quotedContent) return {};
              return {
                quotedMessageId: quotePayloadAtSend.quotedMessageId,
                quotedContent: quotePayloadAtSend.quotedContent,
              };
            })(),
          }
        );
        pinChatListToLatestTurn();
      }
    } else {
      addSubAgentEvent(targetAgentId, { type: "user", content: messageText });
      addPaneMessage(pane.id, "tool", `🗣 发送给 ${targetAgentId}: ${messageText}`, "meta");
    }
    setComposerText("");
    clearQuoteTargets();
    // Clear attachments immediately so chips do not linger until the stream ends (finally also clears).
    contextFilesRef.current = {};
    setContextFiles({});
    flushComposerDraftNowRef.current();
    const abortController = new AbortController();
    const foregroundStreamGeneration = claimSessionStreamOwner(
      sessionStreamOwnersRef.current,
      sessionStreamGenerationsRef.current,
      requestSessionId,
      "foreground",
      abortController,
    );
    if (!foregroundStreamGeneration) {
      releaseSendLock();
      return;
    }
    foregroundStreamGenerationsRef.current[requestSessionId] = foregroundStreamGeneration;
    // A same-session force-send invalidates any read-only reattach reader.  It
    // may still unwind asynchronously, but its lease no longer permits a
    // sequence, stream-state, Team, or UI write.
    invalidateReattachStreamForSession(requestSessionId);
    sessionStreamStateRef.current[requestSessionId] = {
      active: true,
      text: "",
      provider: requestProvider,
      model: requestModel,
    };
    // A foreground send creates a fresh event hub whose sequence starts at 1.
    reattachLastSeqRef.current[requestSessionId] = 0;
    clearStopSuppressForSession(requestSessionId);
    setRunGuardSessionId(requestSessionId);
    setSessionExecutionState("running");
    prevExecutionStateBySidRef.current[requestSessionId] = "running";
    useAppStore.getState().markSessionHistoryActive(requestSessionId);
    useAppStore.getState().bumpSessionCatalogRevision();
    recordSseActivity(requestSessionId);
    setStallState("none");
    setExhaustedRounds(null);
    if ((pane.sessionId || "").trim() === requestSessionId) {
      syncStreamingUiForCurrentSession();
    }
    cancelStreamRenderFrame();
    setStreamedAssistantText("");
    setStreamReferences([]);
    setStreamSearchedQueries([]);
    streamCommitRegistryRef.current.beginSession(requestSessionId);
    const pendingToolResults: Record<string, PendingToolResult> = {};
    const showWidgetDeltaTimers = new Map<string, number>();
    const showWidgetDeltaPending = new Map<
      string,
      { argumentsRaw: string; title?: string; widgetCode?: string }
    >();
    const toolCallMetadata = new Map<
      string,
      Pick<PendingToolResult, "toolName" | "toolArgs" | "toolGroupId">
    >();
    streamTextRef.current = "";
    sessionAbortControllersRef.current[requestSessionId] = abortController;
    if ((pane.sessionId || "").trim() === requestSessionId) {
      abortRef.current = abortController;
    }
    const isTargetSessionStillActive = () => {
      const currentPane = useAppStore.getState().panes.find((p) => p.id === pane.id);
      return isPaneDisplayingSession(currentPane, pane.id, requestSessionId);
    };
    // A force-send can replace the controller while the old reader still has
    // buffered SSE frames.  Session id alone is not enough in that window:
    // both requests intentionally target the same session.
    let foregroundRequestSessionId = requestSessionId;
    const ownsForegroundRequest = () =>
      ownsForegroundRequestController(
        sessionAbortControllersRef.current,
        foregroundRequestSessionId,
        abortController,
      ) &&
      ownsSessionStreamOwner(
        sessionStreamOwnersRef.current,
        foregroundRequestSessionId,
        "foreground",
        foregroundStreamGeneration,
        abortController,
      );
    const rekeyForegroundRequest = (nextSessionId: string) => {
      const next = nextSessionId.trim();
      const current = foregroundRequestSessionId;
      if (
        !rekeySessionStreamOwner(
          sessionStreamOwnersRef.current,
          current,
          next,
          "foreground",
          abortController,
        )
      ) {
        return false;
      }
      if (
        !rekeyForegroundRequestController(
          sessionAbortControllersRef.current,
          current,
          next,
          abortController,
        )
      ) {
        // Keep the ownership lease at its original key if the controller
        // registry was replaced while migration was awaiting createSession.
        rekeySessionStreamOwner(
          sessionStreamOwnersRef.current,
          next,
          current,
          "foreground",
          abortController,
        );
        return false;
      }
      if (current !== next) {
        const foregroundGeneration = foregroundStreamGenerationsRef.current[current];
        if (foregroundGeneration !== undefined) {
          foregroundStreamGenerationsRef.current[next] = foregroundGeneration;
          delete foregroundStreamGenerationsRef.current[current];
        }
        const streamState = sessionStreamStateRef.current[current];
        if (streamState) sessionStreamStateRef.current[next] = streamState;
        delete sessionStreamStateRef.current[current];

        const lastSeq = reattachLastSeqRef.current[current];
        if (lastSeq !== undefined) reattachLastSeqRef.current[next] = lastSeq;
        delete reattachLastSeqRef.current[current];

        const previousExecutionState = prevExecutionStateBySidRef.current[current];
        if (previousExecutionState) {
          prevExecutionStateBySidRef.current[next] = previousExecutionState;
        }
        delete prevExecutionStateBySidRef.current[current];

        const streamText = streamCommitRegistryRef.current.getText(current);
        const streamCommitted = streamCommitRegistryRef.current.isCommitted(current);
        const streamMidCommit = streamCommitRegistryRef.current.getMidCommit(current);
        streamCommitRegistryRef.current.beginSession(next);
        streamCommitRegistryRef.current.setText(next, streamText);
        streamCommitRegistryRef.current.markCommitted(next, streamCommitted);
        streamCommitRegistryRef.current.setMidCommit(next, streamMidCommit);
        streamCommitRegistryRef.current.clearSession(current);
        setRunGuardSessionId(next);
      }
      foregroundRequestSessionId = next;
      return true;
    };
    const isCurrentForegroundRequest = () =>
      !abortController.signal.aborted && ownsForegroundRequest();
    /** Component-level writes require both stream ownership and displayed-pane ownership. */
    const isDisplayedForegroundSession = () =>
      isCurrentForegroundRequest() && isTargetSessionStillActive();
    const addSubAgentForDisplayedSession = (...args: Parameters<typeof addSubAgent>) => {
      if (!isDisplayedForegroundSession()) return;
      addSubAgent(...args);
    };
    const updateSubAgentForDisplayedSession = (...args: Parameters<typeof updateSubAgent>) => {
      if (!isDisplayedForegroundSession()) return;
      updateSubAgent(...args);
    };
    const addSubAgentEventForDisplayedSession = (
      ...args: Parameters<typeof addSubAgentEvent>
    ) => {
      if (!isDisplayedForegroundSession()) return;
      addSubAgentEvent(...args);
    };
    const flushSubAgentLiveOutputForDisplayedSession = (agentId: string) => {
      if (!isDisplayedForegroundSession()) return;
      flushSubAgentLiveOutput(agentId);
    };
    const mergeLastAssistantIfSessionActive = (patch: Partial<Message>) => {
      if (!isCurrentForegroundRequest() || !isTargetSessionStillActive()) return false;
      return useAppStore
        .getState()
        .mergeLastPaneMessageByRole(pane.id, "assistant", patch);
    };
    const addPaneMessageIfSessionActive = (...args: Parameters<typeof addPaneMessage>) => {
      // A replaced foreground request must not defer stale rows for later
      // hydration under the same session id.
      if (!ownsForegroundRequest()) return;
      // Stamp the owning session on every streamed/committed row so the render
      // layer can never surface it under a different conversation, even if this
      // write races a session switch. extras is the 8th positional arg.
      const stamped = [...args] as Parameters<typeof addPaneMessage>;
      stamped[7] = { ...(stamped[7] ?? {}), ownerSessionId: requestSessionId };
      if (!isTargetSessionStillActive()) {
        const bucket = deferredSessionMessagesRef.current[requestSessionId] ?? [];
        bucket.push(stamped);
        deferredSessionMessagesRef.current[requestSessionId] = bucket.slice(-80);
        return;
      }
      addPaneMessage(...stamped);
    };
    const addGroupWorkflowMessage = ({
      content,
      agentId = "__meta__",
      avatarName,
      avatarUrl,
      workflowRole = "leader",
      taskId = "",
      attempt = 0,
      status = "",
      event = "",
    }: {
      content: string;
      agentId?: string;
      avatarName?: string;
      avatarUrl?: string;
      workflowRole?: "leader" | "executor" | "reviewer" | "system";
      taskId?: string;
      attempt?: number;
      status?: string;
      event?: string;
    }) => {
      const text = String(content || "").trim();
      if (!text) return;
      addPaneMessageIfSessionActive(
        pane.id,
        "assistant",
        text,
        agentId,
        chatProvider,
        chatModel,
        undefined,
        {
          avatarName: avatarName || undefined,
          avatarUrl: avatarUrl || undefined,
          metadata: {
            kind: "group_workflow_event",
            workflow_role: workflowRole,
            workflow_task_id: taskId,
            workflow_attempt: Math.max(0, Number(attempt) || 0),
            workflow_status: status,
            workflow_event: event,
          },
        },
      );
    };
    const updatePaneToolMessageForSession = (
      toolCallId: string,
      patch: Parameters<typeof updatePaneMessageByToolCallId>[2],
    ) => {
      if (!isDisplayedForegroundSession()) return false;
      return updatePaneMessageByToolCallId(pane.id, toolCallId, patch, requestSessionId);
    };
    const mergePendingToolResultIntoDeferred = (pending: PendingToolResult): boolean => {
      if (!ownsForegroundRequest()) return false;
      const deferred = deferredSessionMessagesRef.current[requestSessionId] ?? [];
      const resolution = buildDeferredToolResultResolution(
        deferred.map((args) => ({ role: args[1], extras: args[7] })),
        pending,
      );
      if (!resolution) return false;
      const next = [...deferred];
      const merged = [...next[resolution.index]] as Parameters<typeof addPaneMessage>;
      merged[2] = resolution.content;
      merged[7] = {
        ...resolution.extras,
        ownerSessionId: requestSessionId,
      };
      next[resolution.index] = merged;
      deferredSessionMessagesRef.current[requestSessionId] = next;
      return true;
    };
    const flushPendingToolResults = () => {
      if (!ownsForegroundRequest()) return;
      const pendingEntries = drainPendingToolResults(pendingToolResults);
      const sessionActive = isTargetSessionStillActive();
      for (const pending of pendingEntries) {
        if (!pending.patch.content.trim()) continue;
        if (sessionActive) {
          if (updatePaneToolMessageForSession(pending.callId, pending.patch)) continue;
          const currentPane = useAppStore.getState().panes.find((item) => item.id === pane.id);
          if (hasMatchingToolCall(currentPane?.messages ?? [], pending.callId, requestSessionId)) continue;
        } else if (mergePendingToolResultIntoDeferred(pending)) {
          continue;
        }
        addPaneMessageIfSessionActive(
          pane.id,
          "tool",
          pending.patch.content,
          "meta",
          undefined,
          undefined,
          undefined,
          buildPendingToolFallback(pending),
        );
      }
    };
    const flushShowWidgetDelta = (toolCallId: string) => {
      if (!ownsForegroundRequest()) return;
      const pending = showWidgetDeltaPending.get(toolCallId);
      showWidgetDeltaPending.delete(toolCallId);
      const timer = showWidgetDeltaTimers.get(toolCallId);
      if (timer !== undefined) {
        window.clearTimeout(timer);
        showWidgetDeltaTimers.delete(toolCallId);
      }
      if (!pending) return;
      const partialPayload = {
        argumentsRaw: pending.argumentsRaw,
        title: pending.title,
        widgetCode: pending.widgetCode,
      };
      const partialToolArgs = pending.title ? { title: pending.title } : undefined;
      const merged = updatePaneToolMessageForSession(toolCallId, {
        toolName: "show_widget",
        toolStatus: "running",
        ...(partialToolArgs ? { toolArgs: partialToolArgs } : {}),
        toolArgsPartial: partialPayload,
      });
      if (merged) return;
      const pan = useAppStore.getState().panes.find((p) => p.id === pane.id);
      const lastMsg = pan?.messages.length ? pan.messages[pan.messages.length - 1] : undefined;
      const toolGroupId =
        lastMsg?.role === "tool" && lastMsg.toolGroupId
          ? lastMsg.toolGroupId
          : crypto.randomUUID();
      addPaneMessageIfSessionActive(pane.id, "tool", "", "meta", undefined, undefined, undefined, {
        toolCallId,
        toolName: "show_widget",
        toolStatus: "running",
        toolGroupId,
        ...(partialToolArgs ? { toolArgs: partialToolArgs } : {}),
        toolArgsPartial: partialPayload,
      });
    };
    const scheduleShowWidgetDelta = (
      toolCallId: string,
      nextPartial: { argumentsRaw: string; title?: string; widgetCode?: string }
    ) => {
      const prev = showWidgetDeltaPending.get(toolCallId);
      if (prev && nextPartial.argumentsRaw.length < prev.argumentsRaw.length) {
        return;
      }
      showWidgetDeltaPending.set(toolCallId, nextPartial);
      if (showWidgetDeltaTimers.has(toolCallId)) return;
      const timer = window.setTimeout(() => flushShowWidgetDelta(toolCallId), 100);
      showWidgetDeltaTimers.set(toolCallId, timer);
    };
    let streamReasoningStartedAt: number | null = null;
    /**
     * FR-F1 keeps tool-preface body out of chat, but still persist the closed
     * think segment so the streaming ReasoningBlock does not vanish when
     * resetTurnSegment clears the overlay. Does NOT mark the stream committed —
     * the terminal answer still needs its own assistant row.
     */
    const preserveStreamReasoningAtToolBoundary = () => {
      const raw = streamCommitRegistryRef.current.getText(requestSessionId).trim();
      if (!raw || isThinkingPlaceholderText(raw)) return false;
      const parsed = parseReasoningContent(raw);
      const reasoningText = parsed.reasoning.trim();
      if (!reasoningText) return false;
      const bodyContent = parsed.response.replace(/[：:]\s*$/, "").trimEnd();
      // Same-text echo belongs on the final body, not a mid-turn think card.
      if (reasoningDuplicatesVisibleBody(reasoningText, bodyContent)) return false;
      const commitExtras: Record<string, unknown> = {
        reasoning: reasoningText.slice(0, 16384),
      };
      let seconds = getCachedReasoningDuration(reasoningText);
      if (seconds === undefined && streamReasoningStartedAt !== null) {
        seconds = measureReasoningSeconds(streamReasoningStartedAt, Date.now());
        setCachedReasoningDuration(reasoningText, seconds);
      }
      if (seconds !== undefined && seconds >= 1) {
        commitExtras.reasoningSeconds = seconds;
      }
      addPaneMessageIfSessionActive(
        pane.id,
        "assistant",
        "",
        "meta",
        requestProvider,
        requestModel,
        undefined,
        commitExtras,
      );
      streamReasoningStartedAt = null;
      return true;
    };
    const commitCurrentStreamIfNeeded = () => {
      const raw = streamCommitRegistryRef.current.getText(requestSessionId).trim();
      // Trim trailing colon ("：" or ":") that model writes just before calling a tool
      // — prevents orphaned "检查文件：" bubbles before a ToolCallCard.
      const partial = raw.replace(/[：:]\s*$/, "").trimEnd();
      if (
        !partial ||
        isThinkingPlaceholderText(partial) ||
        isStreamToolLabelOnlyText(partial) ||
        streamCommitRegistryRef.current.isCommitted(requestSessionId)
      ) {
        return false;
      }
      const parsed = parseReasoningContent(partial);
      const reasoningText = parsed.reasoning.trim();
      const bodyContent = parsed.response.replace(/[：:]\s*$/, "").trimEnd();
      const commitExtras: Record<string, unknown> = {};
      let commitContent = partial;
      if (reasoningText) {
        if (!reasoningDuplicatesVisibleBody(reasoningText, bodyContent)) {
          commitExtras.reasoning = reasoningText.slice(0, 16384);
          let seconds = getCachedReasoningDuration(reasoningText);
          if (seconds === undefined && streamReasoningStartedAt !== null) {
            seconds = measureReasoningSeconds(streamReasoningStartedAt, Date.now());
            setCachedReasoningDuration(reasoningText, seconds);
          }
          if (seconds !== undefined && seconds >= 1) {
            commitExtras.reasoningSeconds = seconds;
          }
        }
        commitContent = bodyContent;
      }
      if (!commitContent.trim() || isStreamToolLabelOnlyText(commitContent)) {
        return false;
      }
      addPaneMessageIfSessionActive(
        pane.id,
        "assistant",
        commitContent,
        "meta",
        requestProvider,
        requestModel,
        undefined,
        Object.keys(commitExtras).length > 0 ? commitExtras : undefined,
      );
      streamReasoningStartedAt = null;
      streamCommitRegistryRef.current.markCommitted(requestSessionId);
      streamCommitRegistryRef.current.setMidCommit(requestSessionId, partial);
      return true;
    };
    const scheduleStreamTextUpdate = (nextText: string) => {
      if (!ownsForegroundRequest()) return;
      streamCommitRegistryRef.current.setText(requestSessionId, nextText);
      const state = sessionStreamStateRef.current[requestSessionId];
      if (state) {
        state.text = nextText;
        sessionStreamStateRef.current[requestSessionId] = state;
      }
      // `streamTextRef` is the one overlay source for the displayed pane, not
      // a per-session durable buffer. Do not let a background A frame replace
      // B's text before its RAF runs.
      if (!isDisplayedForegroundSession()) return;
      streamTextRef.current = nextText;
      if (abortController.signal.aborted) return;
      if (streamRafRef.current !== null) return;
      const rafGeneration = ++streamRafGenerationRef.current;
      const rafId = window.requestAnimationFrame(() => {
        if (streamRafGenerationRef.current !== rafGeneration) return;
        streamRafRef.current = null;
        if (!abortController.signal.aborted && isTargetSessionStillActive()) {
          setStreamedAssistantText(streamTextRef.current);
        }
      });
      streamRafRef.current = rafId;
    };

    const turnRefsSnapshot = {
      references: [] as SearchReference[],
      queries: [] as string[],
    };
    // Clear the one-rewind fence only once this invocation has passed queue,
    // confirmation, session and duplicate-send guards and is ready to issue a
    // genuinely new user turn.  A cancelled/queued action must not resurrect
    // an older undo button as a side effect.
    if (!isContinuation) setUndoConsumedSessionId("");

    try {
      const body: Record<string, unknown> = { session_id: requestSessionId, user_input: outboundMessageText };
      // Keep backend turn alive across brief SSE drops (network blip / sleep).
      // Without this, streamed tool-arg truncation retries get cancelled mid-flight.
      body.keep_runtime_after_disconnect = true;
      // Idempotency key: backend short-circuits a duplicate POST (double-click /
      // chip burst / retry race) so it never appends a second user row.
      body.client_turn_id = clientTurnId;
      if (skipUserHistory) body.skip_user_history = true;
      const ats = (pane.activeTaskspaceId || "").trim();
      if (ats) body.active_taskspace_id = ats;
      {
        if (quotePayloadAtSend.quotedContent) {
          if (quotePayloadAtSend.quoteMessageIds?.length) {
            body.quote_message_ids = quotePayloadAtSend.quoteMessageIds;
          }
          body.quoted_message_id = quotePayloadAtSend.quotedMessageId;
          body.quoted_content = quotePayloadAtSend.quotedContent;
          body.user_display_content = composerDisplayText;
        }
      }
      if (requestProvider) body.provider = requestProvider;
      if (requestModel) body.model = requestModel;
      // 管理员在企业后台声明的上下文窗口；未声明时不带该字段，由后端按模型名兜底。
      {
        const declaredWindow = resolveManagedContextWindow(
          useAppStore.getState().settings.providers,
          requestProvider,
          requestModel,
        );
        if (declaredWindow) body.context_window = declaredWindow;
      }
      if (requestModel && supportsKimiK3ReasoningEffort(requestModel)) {
        body.reasoning_effort = normalizeKimiReasoningEffort(
          pane.reasoningEffort ?? DEFAULT_KIMI_REASONING_EFFORT,
        );
      } else if (chatModel && supportsDeepSeekV4Thinking(chatModel)) {
        const thinkingOn = pane.thinkingEnabled !== false;
        body.thinking_enabled = thinkingOn;
        if (thinkingOn) {
          body.reasoning_effort = normalizeDeepSeekReasoningEffort(pane.reasoningEffort);
        }
      }
      if (targetAgentId !== "meta") body.agent_id = targetAgentId;
      // Per-session KB retrieval mode: carry the session's explicit choice so the
      // backend prompt honors it instead of the single global config value.
      if (!isGroupPane && targetAgentId === "meta") {
        const kbMode = resolveEffectiveKbRetrievalMode(
          requestSessionId,
          pane.id,
          kbNewSessionDefaultRef.current,
        );
        body.retrieval_mode = kbMode;
      }
      if (isGroupPane && targetAgentId === "meta") {
        body.group_id = groupChatId;
        body.mentioned_avatar_ids = mentionedAvatarIds;
        body.meta_leader_display_name = metaLeaderDisplayName;
        body.user_display_name = groupChatUserLabel;
      }
      // 提到外层：sticky 判定必须**每轮**都跑，包括本轮没带任何附件的时候——否则
      // 已经锁定的会话下一轮就溜回云端模型了。
      const routedAttachmentNames: Record<string, string> = {};
      const outboundUserNickname = isGroupPane ? groupChatUserLabel : userBubbleLabel;
      if (outboundUserNickname && outboundUserNickname !== "我" && outboundUserNickname !== "用户") {
        body.user_nickname = outboundUserNickname;
      }
      if (userPreference.trim()) body.user_preference = userPreference.trim();
      // Extract @skill:// references from message text
      const skillSlugMatches = outboundMessageText.match(/@skill:\/\/([^\s@,，。！？\n]+)/g);
      if (skillSlugMatches && skillSlugMatches.length > 0) {
        const skillSlugs = [...new Set(skillSlugMatches.map((m) => m.replace("@skill://", "")))];
        if (skillSlugs.length > 0) body.skill_slugs = skillSlugs;
      }
      if (sendAttachments.length > 0) {
        const imageInputs = sendAttachments
          .filter((file) => !!file.dataUrl && file.mimeType.startsWith("image/"))
          .map((file) => ({
            name: file.name,
            data_url: file.dataUrl as string,
            mime_type: file.mimeType,
            size: file.size,
          }));
        // Always forward image data (when present as dataUrl) so the backend can:
        // - inject as vision content for the current turn (if the session's active model supports it), and
        // - persist as history_user_attachments (with data_url) for this session's messages.json.
        // This makes uploaded images durable in the session "section" and reconstructible for
        // later vision models or after restart/model switch. The server normalizes/strips
        // current-turn injection for non-vision sessions; the attachment record is still written.
        if (imageInputs.length > 0) {
          body.image_inputs = imageInputs;
        }
        const contextFilePayload: Record<string, string> = routedAttachmentNames;
        for (const file of sendAttachments) {
          const key = buildContextFileKeyFromAttachment(file);
          if (!key) continue;
          const ready = resolveReadyAttachment(file, readyEntries);
          const isImage = !!file.dataUrl || file.mimeType.startsWith("image/") || !!ready?.dataUrl || ready?.mimeType.startsWith("image/");
          // Chat-uploaded images are carried via image_inputs / persisted attachments only.
          // Do not mirror them into context_files (bare filenames like image.png confuse
          // the model into calling view_image on non-existent workspace paths).
          if (isImage) continue;
          // Prefer body already on the MessageAttachment (HTML element chips copy snippetContent).
          const fromFile =
            String(file.snippetContent || "").trim() ||
            String(ready?.snippetContent || "").trim() ||
            String(ready?.content || "").trim();
          if (fromFile) {
            contextFilePayload[key] = fromFile;
          } else {
            // materializeSessionAttachments rewrote sourcePath after parse;
            // resolveReadyAttachment then misses readyEntries and the body is
            // lost. Warn so this silent degradation is observable in devtools.
            console.warn(
              "[ChatPane] attachment body lost after materialize, key=",
              key,
              "sourcePath=",
              file.sourcePath,
            );
            contextFilePayload[key] = `[附件] ${file.name}`;
          }
        }
        if (Object.keys(contextFilePayload).length > 0) {
          body.context_files = contextFilePayload;
        }
      }
      // 附件自动路由：本轮带文档时把会话锁到私有部署的多模态模型。
      //
      // 服务端也会判一遍（那边才是权威，CLI / 定时任务 / 子智能体都只经过它）。这里
      // 判的目的是**即时反馈**：用户一挂上文档，选择器就该灰掉并给出理由，而不是发完
      // 才发现被切走了。两边用同一份下发策略，判定逻辑逐条对齐。
      try {
        const attachmentRoutingLock =
          useAppStore.getState().attachmentRoutingLocks[requestSessionId] ?? null;
        const routingDecision = decideAttachmentRouting({
          policy: attachmentRoutingPolicy,
          filenames: Object.keys(routedAttachmentNames),
          lockedTarget: attachmentRoutingLock,
        });
        if (attachmentRoutingDecision === "public") {
          body.attachment_routing_decision = "public";
        } else if (routingDecision.action === "lock") {
          const addressed = addressForSession(
            { provider: String(body.provider ?? storeActiveProvider ?? "") },
            routingDecision.target,
          );
          body.provider = addressed.provider;
          body.model = addressed.model;
          // 客户端选的窗口是跟着它自己那个模型来的，换了模型就是错的。
          delete (body as Record<string, unknown>).context_window;
          // 每轮都用当前策略刷新目标；管理员替换私有模型后，已锁会话随之迁移。
          setAttachmentRoutingLock(requestSessionId, routingDecision.target);
        }
      } catch (error) {
        // 路由判定不该挡住发送——服务端还会再判一次。
        console.warn("[ChatPane] attachment routing skipped", error);
      }
      const sendChatRequest = (sessionId: string) => {
        if (isContinuation && continuation) {
          return fetch(continueSessionUrl(apiBase, sessionId), {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-agx-desktop-token": apiToken },
            body: JSON.stringify({
              reason: continuation.reason,
              source: continuation.source,
              suppress_user_echo: true,
              ...(requestProvider ? { provider: requestProvider } : {}),
              ...(requestModel ? { model: requestModel } : {}),
            }),
            signal: abortController.signal,
          });
        }
        body.session_id = sessionId;
        return fetch(`${apiBase}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-agx-desktop-token": apiToken },
          body: JSON.stringify(body),
          signal: abortController.signal,
        });
      };

      let resp = await sendChatRequest(requestSessionId);
      if (resp.status === 404) {
        // Recover from stale bound session IDs (e.g. old WeChat binding points to removed session).
        const created = await window.agenticxDesktop.createSession({
          avatar_id: sessionCreateAvatarId(pane.avatarId),
          permission_mode: runMode,
        });
        if (!isForceSessionStillDisplayed()) return;
        if (created.ok && created.session_id) {
          const oldSessionId = requestSessionId;
          const migratedSessionId = String(created.session_id).trim();
          // Keep the controller registry keyed to the session it owns. If a
          // same-session force-send won the race while createSession awaited,
          // the old key no longer points at this controller and this request
          // must not rekey or process the replacement response.
          if (!rekeyForegroundRequest(migratedSessionId)) return;
          requestSessionId = migratedSessionId;
          const oldRoutingLock = useAppStore.getState().attachmentRoutingLocks[oldSessionId];
          if (oldRoutingLock) {
            setAttachmentRoutingLock(requestSessionId, oldRoutingLock);
            setAttachmentRoutingLock(oldSessionId, null);
          }
          freshlyCreatedSessionRef.current = requestSessionId;
          setSessionRunMode(
            requestSessionId,
            normalizeRunMode(created.permission_mode ?? runMode),
          );
          setPaneSessionId(pane.id, requestSessionId);

          try {
            const rw = await window.agenticxDesktop.loadWechatBinding();
            const desk = rw.ok
              ? (rw.bindings["_desktop"] as {
                  session_id?: string;
                  avatar_id?: string;
                  avatar_name?: string;
                  provider?: string;
                  model?: string;
                } | undefined)
              : undefined;
            if (desk?.session_id === oldSessionId) {
              await window.agenticxDesktop.saveWechatDesktopBinding({
                sessionId: requestSessionId,
                avatarId: (desk.avatar_id ?? pane.avatarId ?? null) as string | null,
                avatarName: (desk.avatar_name ?? pane.avatarName ?? null) as string | null,
                provider: (desk.provider ?? pane.modelProvider ?? null) as string | null,
                model: (desk.model ?? pane.modelName ?? null) as string | null,
              });
            }
          } catch {
            // best-effort binding sync
          }

          addPaneMessageIfSessionActive(pane.id, "tool", "⚠️ 会话已失效，已自动迁移到新会话并重试。", "meta");
          resp = await sendChatRequest(requestSessionId);
        }
      }
      // The response may have arrived after a same-session force-send took
      // ownership. Do not reset overlays or start consuming this stale
      // response in that case.
      if (!isCurrentForegroundRequest()) return;

      if (isTargetSessionStillActive()) {
        lastGroupProgressRef.current = {};
        groupStreamRafGenerationRef.current += 1;
        if (groupStreamRafRef.current != null) {
          window.cancelAnimationFrame(groupStreamRafRef.current);
          groupStreamRafRef.current = null;
        }
        groupStreamTextRef.current = {};
        setGroupStreamText({});
      }
      const groupProgressRunId = crypto.randomUUID();
      const setGroupCoordinatorActivity = (text: string) => {
        if (!isDisplayedForegroundSession()) return;
        const activity = String(text || "").trim();
        if (!activity) return;
        setGroupTyping((previous) => ({
          ...previous,
          [GROUP_COORDINATOR_AGENT_ID]: groupHost?.name || "主持人",
        }));
        setGroupActivityHint((previous) => ({
          ...previous,
          [GROUP_COORDINATOR_AGENT_ID]: activity,
        }));
      };
      const clearGroupCoordinatorActivity = () => {
        if (!isDisplayedForegroundSession()) return;
        setGroupTyping((previous) => withoutGroupAgent(previous, GROUP_COORDINATOR_AGENT_ID));
        setGroupActivityHint((previous) =>
          withoutGroupAgent(previous, GROUP_COORDINATOR_AGENT_ID),
        );
        setGroupMemberPhase((previous) =>
          withoutGroupAgent(previous, GROUP_COORDINATOR_AGENT_ID),
        );
        clearGroupStreamForAgent(GROUP_COORDINATOR_AGENT_ID);
      };
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

      const reader = resp.body?.getReader();
      const decoder = new TextDecoder();
      if (!reader) {
        releaseSendLock();
        return;
      }

      let full = "";
      let cumulativeFull = "";
      let receivedFinalEvent = false;
      let receivedDoneEvent = false;
      let receivedGroupTerminalEvent = false;
      let receivedBudgetExceededEvent = false;
      // 本轮是不是只读讨论。workforce.started 带下来之后，后续阶段的旁白都要跟着变，
      // 否则界面会一边说「讨论」一边预告「执行」。
      let groupDiscussionMode = false;
      let pendingSuggestedQuestions: string[] = [];
      let pendingFinalTurnTerminal = false;
      let pendingFinalTerminalReason: string | undefined;
      let pendingReferences: SearchReference[] = [];
      let pendingSearchedQueries: string[] = [];
      let pendingReasoning: string | undefined = undefined;
      let pendingReasoningSeconds: number | undefined = undefined;
      const syncTurnRefsSnapshot = () => {
        turnRefsSnapshot.references = pendingReferences;
        turnRefsSnapshot.queries = pendingSearchedQueries;
      };
      let buffer = "";
      while (true) {
        const { value: chunk, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(chunk, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          // Check controller identity before sequence bookkeeping: a stale
          // frame must not advance the shared reattach cursor or touch any UI.
          if (!isCurrentForegroundRequest()) continue;
          const { eventId, payload: parsedPayload } = parseSseFrame(frame);
          const priorSeq = reattachLastSeqRef.current[requestSessionId] ?? 0;
          const sequence = advanceReattachSequence(priorSeq, eventId);
          if (!sequence.accept) continue;
          reattachLastSeqRef.current[requestSessionId] = sequence.nextSeq;
          if (!parsedPayload || typeof parsedPayload !== "object") continue;
          try {
            const payload = parsedPayload as {
              type?: string;
              action?: string;
              run_id?: string;
              graph_run_id?: string;
              data?: Record<string, unknown>;
            };
            const sessionStillActive = isTargetSessionStillActive();
            recordSseActivity(requestSessionId);
            const eventAgentId = String(payload.data?.agent_id ?? "meta");
            if (!payload.type && payload.action) {
              if (sessionStillActive) applyGroupTeamControlEvent(payload.action, payload.data);
              continue;
            }
            if (payload.type === "done") {
              receivedDoneEvent = true;
              const localControlState = groupTeamControlStateForSession(
                groupTeamControlStateBySessionRef.current,
                requestSessionId,
              );
              const liveGraphControlState = sessionStillActive
                ? groupTeamControlStateFromGraph(
                    useGraphRunStore.getState().byPane[pane.id],
                  )
                : "idle";
              const controlState =
                localControlState !== "idle"
                  ? localControlState
                  : sessionStillActive
                    ? liveGraphControlState !== "idle"
                      ? liveGraphControlState
                      : effectiveGroupTeamControlState
                    : "idle";
              const incomingRunId = String(
                payload.run_id ??
                  payload.graph_run_id ??
                  payload.data?.run_id ??
                  payload.data?.graph_run_id ??
                  "",
              ).trim();
              const terminalReason =
                payload.data?.terminal_reason ??
                payload.data?.terminalReason ??
                payload.data?.reason;
              if (
                sessionStillActive &&
                isGroupPane &&
                shouldApplyTeamControlDoneEvent({
                  controlState,
                  currentRunId: currentGroupGraphRunId(requestSessionId),
                  incomingRunId,
                  terminalReason,
                  isCurrentOwner: isCurrentForegroundRequest(),
                })
              ) {
                setGroupTeamControlStateForSession(requestSessionId, "stopped");
              }
            }
            if (
              payload.type === "group_reply"
              || payload.type === "group_skipped"
              || payload.type === "group_clarification"
              || payload.type === "group_nudge"
              || payload.type === "group_blocked"
              || payload.type === "group_pass"
            ) {
              receivedGroupTerminalEvent = true;
            }
            if (payload.type === "continuation_notice") {
              const noticeText = String(payload.data?.text ?? "").trim();
              const continuationRound = Number(payload.data?.continuation_round ?? 0);
              if (noticeText) {
                addPaneMessageIfSessionActive(
                  pane.id,
                  "tool",
                  noticeText,
                  "meta",
                  undefined,
                  undefined,
                  undefined,
                  {
                    metadata: {
                      kind: "continuation_notice",
                      source: payload.data?.source,
                      reason: payload.data?.reason,
                      continuation_round: payload.data?.continuation_round,
                    },
                  }
                );
              }
              if (Number.isFinite(continuationRound) && continuationRound > 0) {
                const nextRound = Math.max(
                  unattendedContinueTriggeredRef.current[requestSessionId] ?? 0,
                  Math.floor(continuationRound),
                );
                unattendedContinueTriggeredRef.current[requestSessionId] = nextRound;
                if (sessionStillActive) {
                  setUnattendedContinueCount(nextRound);
                }
              }
              clearResumeInFlight(requestSessionId);
              if (sessionStillActive) {
                setStallRejectReason("");
                // Continuation accepted: now safe to dismiss the stall/exhausted card.
                setStallState("none");
              }
              continue;
            }
            if (payload.type === "continuation_rejected") {
              const rejectText = String(payload.data?.text ?? "").trim();
              clearResumeInFlight(requestSessionId);
              if (rejectText && sessionStillActive) {
                setStallRejectReason(rejectText);
                // Inline reject only shows inside a mounted recovery card. Fall
                // back to a toast when the user has left the pane OR no card is
                // currently visible (stallState === "none").
                if (stallStateRef.current === "none") {
                  setStallHintToast(rejectText);
                }
              }
              continue;
            }
            if (payload.type === "group_workflow_detail") {
              if (sessionStillActive) {
                applyGroupTeamControlEvent(payload.type, payload.data);
                applyGroupWorkflowDetailPayload(payload.data);
              }
              // This is the private workflow/project-panel lane. Never create
              // a chat bubble from candidate, review, or runtime detail text.
              continue;
            }
            if (payload.type === "group_reaction") {
              if (!sessionStillActive) continue;
              applyGroupReactionPayload(requestSessionId, payload.data);
              // Human reactions are out-of-band and must not clear the active
              // workflow indicator. Only a concrete member actor can finish
              // its own turn via the public reaction action.
              const reactionAgentId = String(eventAgentId || "").trim();
              if (reactionAgentId && !["meta", "user"].includes(reactionAgentId)) {
                clearGroupStreamForAgent(reactionAgentId);
                setGroupTyping((prev) => withoutGroupAgent(prev, reactionAgentId));
                setGroupActivityHint((prev) => withoutGroupAgent(prev, reactionAgentId));
                setGroupMemberPhase((prev) => withoutGroupAgent(prev, reactionAgentId));
              }
              // Reactions update an existing bubble and deliberately do not
              // create a chat row or trigger another member round.
              continue;
            }
            if (payload.type === "group_user_accepted") {
              if (sessionStillActive) {
                applyGroupUserAcceptedPayload(requestSessionId, payload.data);
              }
              // The optimistic user row already exists locally; this event
              // only fills in its stable public-feed id for later reactions.
              continue;
            }
            if (payload.type === "group_pass") {
              if (!sessionStillActive) continue;
              handoffGroupCoordinatorToMember(eventAgentId);
              clearGroupStreamForAgent(eventAgentId);
              setGroupTyping((prev) => withoutGroupAgent(prev, eventAgentId));
              setGroupActivityHint((prev) => withoutGroupAgent(prev, eventAgentId));
              setGroupMemberPhase((prev) => withoutGroupAgent(prev, eventAgentId));
              continue;
            }
            if (payload.type === "group_typing") {
              if (!sessionStillActive) continue;
              handoffGroupCoordinatorToMember(eventAgentId);
              const avatarName = String(payload.data?.avatar_name ?? eventAgentId);
              setGroupTyping((prev) => ({ ...prev, [eventAgentId]: avatarName }));
              setGroupMemberPhase((prev) => {
                if (!(eventAgentId in prev)) return prev;
                const next = { ...prev };
                delete next[eventAgentId];
                return next;
              });
              continue;
            }
            if (payload.type === "group_token") {
              if (!sessionStillActive) continue;
              handoffGroupCoordinatorToMember(eventAgentId);
              const avatarName = String(payload.data?.avatar_name ?? eventAgentId);
              const rawToken = String(payload.data?.content ?? payload.data?.text ?? "");
              const tokenText = rawToken.replace(/⏳\s*/g, "");
              if (tokenText) {
                setGroupTyping((previous) => ({ ...previous, [eventAgentId]: avatarName }));
                groupStreamTextRef.current[eventAgentId] =
                  (groupStreamTextRef.current[eventAgentId] ?? "") + tokenText;
                if (groupStreamRafRef.current == null) {
                  const rafGeneration = ++groupStreamRafGenerationRef.current;
                  const rafId = window.requestAnimationFrame(() => {
                    if (groupStreamRafGenerationRef.current !== rafGeneration) return;
                    groupStreamRafRef.current = null;
                    if (!isDisplayedForegroundSession()) return;
                    setGroupStreamText({ ...groupStreamTextRef.current });
                  });
                  groupStreamRafRef.current = rafId;
                }
              }
              continue;
            }
            if (payload.type === "group_progress") {
              if (!sessionStillActive) continue;
              handoffGroupCoordinatorToMember(eventAgentId);
              const avatarName = String(payload.data?.avatar_name ?? eventAgentId);
              const workflowRole = String(payload.data?.workflow_role ?? "").trim();
              const nodeId = String(payload.data?.graph_node_id ?? "").trim();
              const callId = String(payload.data?.tool_call_id ?? "").trim();
              const toolName = String(payload.data?.tool_name ?? "").trim();
              const phase = String(payload.data?.tool_phase ?? "").trim();
              const progressText = String(payload.data?.content ?? "").trim();
              const workflowPrefix =
                workflowRole === "reviewer" ? "审核中：" : workflowRole === "executor" ? "执行中：" : "";

              // Light status: one row per member, in-place update (not a chat message).
              setGroupTyping((prev) => ({ ...prev, [eventAgentId]: avatarName }));
              if (shouldResetGroupStreamOnProgress(phase)) {
                clearGroupStreamForAgent(eventAgentId);
              }
              // Round-start chatter is covered by expert label + stream dots.
              if (
                progressText &&
                !/^开始处理任务/.test(progressText) &&
                !/^已接收任务/.test(progressText)
              ) {
                setGroupActivityHint((prev) => ({
                  ...prev,
                  [eventAgentId]: `${workflowPrefix}${progressText}`,
                }));
              }

              // Detail: write graph store for member activity side panel / run graph.
              if (nodeId && callId && (phase === "calling" || phase === "done")) {
                const now = Date.now();
                useGraphRunStore.getState().applyToolStep(pane.id, nodeId, {
                  callId,
                  toolName,
                  phase,
                  startedAt: now,
                  updatedAt: now,
                });
              }
              setGroupMemberPhase((prev) => {
                if (!(eventAgentId in prev)) return prev;
                const next = { ...prev };
                delete next[eventAgentId];
                return next;
              });
              continue;
            }
            if (payload.type === "group_blocked") {
              if (!sessionStillActive) continue;
              handoffGroupCoordinatorToMember(eventAgentId);
              clearGroupStreamForAgent(eventAgentId);
              const avatarName = String(payload.data?.avatar_name ?? eventAgentId);
              const avatarUrl = String(payload.data?.avatar_url ?? "");
              const blockedText =
                String(payload.data?.content ?? "").trim() || "等待确认后继续执行";
              const requestId = String(payload.data?.confirm_request_id ?? "").trim();
              const rawConfirmContext = payload.data?.confirm_context;
              const confirmContext =
                rawConfirmContext &&
                typeof rawConfirmContext === "object" &&
                !Array.isArray(rawConfirmContext)
                  ? (rawConfirmContext as Record<string, unknown>)
                  : undefined;
              setGroupTyping((prev) => {
                const next = { ...prev };
                delete next[eventAgentId];
                return next;
              });
              setGroupActivityHint((prev) => {
                if (!(eventAgentId in prev)) return prev;
                const next = { ...prev };
                delete next[eventAgentId];
                return next;
              });
              setGroupMemberPhase((prev) => ({ ...prev, [eventAgentId]: "waiting" }));
              if (!blockedText) continue;
              const prevText = lastGroupProgressRef.current[eventAgentId] ?? "";
              if (prevText === blockedText) continue;
              lastGroupProgressRef.current[eventAgentId] = blockedText;
              // 群聊这条线上没有会话内复用的记录,所以这里恒为「要问」——
              // 后端的确认闸已经放行过它能放行的部分。
              if (requestId && shouldAutoApproveConfirm(false, confirmContext)) {
                setGroupTyping((prev) => ({ ...prev, [eventAgentId]: avatarName }));
                setGroupActivityHint((prev) => ({ ...prev, [eventAgentId]: "继续执行" }));
                setGroupMemberPhase((prev) => {
                  if (!(eventAgentId in prev)) return prev;
                  const next = { ...prev };
                  delete next[eventAgentId];
                  return next;
                });
                fetch(`${apiBase}/api/confirm`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json", "x-agx-desktop-token": apiToken },
                  body: JSON.stringify({
                    session_id: requestSessionId,
                    request_id: requestId,
                    approved: true,
                    agent_id: eventAgentId,
                  }),
                }).catch(() => {});
                continue;
              }
              addPaneMessageIfSessionActive(
                pane.id,
                "tool",
                `${avatarName}：⏸ ${blockedText}`,
                eventAgentId,
                chatProvider,
                chatModel,
                undefined,
                {
                  avatarName,
                  avatarUrl: avatarUrl || undefined,
                  inlineConfirm: requestId
                    ? {
                        requestId,
                        question: blockedText,
                        agentId: eventAgentId,
                        sessionId: requestSessionId,
                        context: confirmContext,
                      }
                    : undefined,
                }
              );
              continue;
            }
            if (payload.type === "group_clarification") {
              if (!sessionStillActive) continue;
              handoffGroupCoordinatorToMember(eventAgentId);
              clearGroupStreamForAgent(eventAgentId);
              const avatarName = String(payload.data?.avatar_name ?? eventAgentId);
              const avatarUrl = String(payload.data?.avatar_url ?? "");
              const prompt =
                String(payload.data?.content ?? "").trim() || "等待你的输入后继续";
              const requestId = String(payload.data?.confirm_request_id ?? "").trim();
              const rawOptions = payload.data?.clarify_options;
              const options = Array.isArray(rawOptions)
                ? rawOptions.map((o) => String(o)).filter(Boolean)
                : [];
              const allowFreeText = payload.data?.clarify_allow_free_text !== false;
              setGroupTyping((prev) => {
                const next = { ...prev };
                delete next[eventAgentId];
                return next;
              });
              setGroupActivityHint((prev) => {
                if (!(eventAgentId in prev)) return prev;
                const next = { ...prev };
                delete next[eventAgentId];
                return next;
              });
              if (!prompt || !requestId) continue;
              const pan = useAppStore.getState().panes.find((p) => p.id === pane.id);
              const dup = (pan?.messages ?? []).some(
                (m) => m.clarificationPrompt?.requestId === requestId,
              );
              if (dup) continue;
              lastGroupProgressRef.current[eventAgentId] = prompt;
              const promptPayload = {
                requestId,
                prompt,
                options,
                allowFreeText,
                agentId: eventAgentId,
                sessionId: requestSessionId,
              };
              addPaneMessageIfSessionActive(
                pane.id,
                "tool",
                prompt,
                eventAgentId,
                chatProvider,
                chatModel,
                undefined,
                {
                  avatarName,
                  avatarUrl: avatarUrl || undefined,
                  toolName: "request_clarification",
                  toolStatus: "running",
                  clarificationPrompt: promptPayload,
                  metadata: {
                    kind: "clarification",
                    request_id: requestId,
                    prompt,
                    options,
                    allow_free_text: allowFreeText,
                  },
                },
              );
              continue;
            }
            if (payload.type === "group_reply") {
              if (!sessionStillActive) continue;
              handoffGroupCoordinatorToMember(eventAgentId);
              clearGroupStreamForAgent(eventAgentId);
              const avatarName = String(payload.data?.avatar_name ?? eventAgentId);
              const avatarUrl = String(payload.data?.avatar_url ?? "");
              const content = String(payload.data?.content ?? "");
              const errorText = String(payload.data?.error ?? "");
              const workflowRole = String(payload.data?.workflow_role ?? "").trim();
              const workflowTaskId = String(payload.data?.workflow_task_id ?? "").trim();
              const workflowAttempt = Number(payload.data?.workflow_attempt ?? 0);
              const workflowAttemptSafe = Number.isFinite(workflowAttempt) ? workflowAttempt : 0;
              const workflowStatus = String(payload.data?.workflow_status ?? "").trim();
              const groupMessageId = groupMessageIdFromRecord(payload.data);
              const replyToMessageId = String(
                payload.data?.reply_to_message_id ?? payload.data?.quoted_message_id ?? "",
              ).trim();
              const quotedContent = String(
                payload.data?.quoted_content ?? payload.data?.quoted_summary ?? "",
              ).trim();
              const groupAttachments = attachmentsFromSessionRow(payload.data?.attachments);
              const rawReactions = payload.data?.reactions;
              const workflowMetadata = workflowRole
                ? {
                    kind: "group_workflow_event",
                    workflow_role: workflowRole,
                    workflow_task_id: workflowTaskId,
                    workflow_attempt: workflowAttemptSafe,
                    workflow_status: workflowStatus,
                    workflow_event: "group_reply",
                  }
                : {};
              const publicationMetadata = {
                ...workflowMetadata,
                event_type: "group_reply",
                ...(String(payload.data?.group_id ?? "").trim()
                  ? { group_id: String(payload.data?.group_id).trim() }
                  : {}),
                ...(payload.data?.is_public === true ? { is_public: true } : {}),
                ...(String(payload.data?.feed_visibility ?? "").trim()
                  ? { feed_visibility: String(payload.data?.feed_visibility).trim() }
                  : {}),
                ...(String(payload.data?.publication_source ?? "").trim()
                  ? { group_publication_source: String(payload.data?.publication_source).trim() }
                  : {}),
              };
              const groupMessageExtras = {
                avatarName,
                avatarUrl: avatarUrl || undefined,
                ...(groupMessageId ? { groupMessageId } : {}),
                ...(replyToMessageId ? { quotedMessageId: replyToMessageId } : {}),
                ...(quotedContent ? { quotedContent } : {}),
                ...(groupAttachments ? { attachments: groupAttachments } : {}),
                ...(Array.isArray(rawReactions)
                  ? {
                      reactions: rawReactions
                        .map((row) => row)
                        .filter(Boolean)
                        .map((row) => {
                          const reaction = row as Record<string, unknown>;
                          const actorIds = Array.isArray(reaction.actor_ids)
                            ? reaction.actor_ids.map((id) => String(id)).filter(Boolean)
                            : Array.isArray(reaction.actorIds)
                              ? reaction.actorIds.map((id) => String(id)).filter(Boolean)
                              : [];
                          return {
                            emoji: String(reaction.emoji ?? "").trim(),
                            actorIds,
                            ...(reaction.active === true ? { active: true } : {}),
                          };
                        })
                        .filter((reaction) => reaction.emoji),
                    }
                  : {}),
                ...(Object.keys(publicationMetadata).length > 0
                  ? { metadata: publicationMetadata }
                  : {}),
              };
              updatePaneToolMessageForSession(`${groupProgressRunId}:group-progress:${eventAgentId}`, {
                toolStatus: errorText.trim() ? "error" : "done",
              });
              setGroupTyping((prev) => {
                const next = { ...prev };
                delete next[eventAgentId];
                return next;
              });
              setGroupActivityHint((prev) => {
                if (!(eventAgentId in prev)) return prev;
                const next = { ...prev };
                delete next[eventAgentId];
                return next;
              });
              if (errorText.trim()) {
                setGroupMemberPhase((prev) => ({ ...prev, [eventAgentId]: "failed" }));
              } else {
                setGroupMemberPhase((prev) => {
                  if (!(eventAgentId in prev)) return prev;
                  const next = { ...prev };
                  delete next[eventAgentId];
                  return next;
                });
              }
              const isAdmittedPublicReply = isPublicGroupMessage({
                role: "assistant",
                groupMessageId,
                metadata: publicationMetadata,
              });
              if (content.trim() && isAdmittedPublicReply) {
                addPaneMessageIfSessionActive(
                  pane.id,
                  "assistant",
                  content,
                  eventAgentId,
                  chatProvider,
                  chatModel,
                  groupAttachments,
                  groupMessageExtras,
                );
              } else if (errorText.trim() || content.trim()) {
                if (!isAdmittedPublicReply) {
                  // Private/panel failures are diagnostics for the workbench,
                  // never public group-feed bubbles. Keep the text in the
                  // member status lane so the failure remains actionable.
                  const detail = errorText.trim()
                    ? `回复失败：${errorText.trim().slice(0, 320)}`
                    : "成员回复未通过群消息准入，已保留在工作面板";
                  setGroupActivityHint((prev) => ({ ...prev, [eventAgentId]: detail }));
                } else {
                  addPaneMessageIfSessionActive(
                    pane.id,
                    "assistant",
                    `${avatarName} 回复失败：${errorText}`,
                    eventAgentId,
                    chatProvider,
                    chatModel,
                    groupAttachments,
                    groupMessageExtras,
                  );
                }
              }
              if (workflowRole === "reviewer" && workflowStatus.toLowerCase() === "revise") {
                addGroupWorkflowMessage({
                  content: `审核意见已返回：这个工作项需要返工，我安排原执行成员重新处理（第 ${Math.max(1, workflowAttemptSafe + 1)} 轮）。`,
                  avatarName: metaLeaderDisplayName,
                  workflowRole: "leader",
                  taskId: workflowTaskId,
                  attempt: workflowAttemptSafe + 1,
                  status: "rework",
                  event: "review_rework",
                });
              }
              continue;
            }
            if (payload.type === "group_nudge") {
              if (!sessionStillActive) continue;
              handoffGroupCoordinatorToMember(eventAgentId);
              clearGroupStreamForAgent(eventAgentId);
              const avatarName = String(payload.data?.avatar_name ?? metaLeaderDisplayName);
              const avatarUrl = String(payload.data?.avatar_url ?? "");
              const content = String(payload.data?.content ?? "");
              if (content.trim()) {
                addPaneMessageIfSessionActive(
                  pane.id,
                  "assistant",
                  content,
                  eventAgentId,
                  chatProvider,
                  chatModel,
                  undefined,
                  { avatarName, avatarUrl: avatarUrl || undefined }
                );
              }
              continue;
            }
            if (payload.type === "group_skipped") {
              if (!sessionStillActive) continue;
              handoffGroupCoordinatorToMember(eventAgentId);
              clearGroupStreamForAgent(eventAgentId);
              updatePaneToolMessageForSession(`${groupProgressRunId}:group-progress:${eventAgentId}`, {
                toolStatus: "cancelled",
              });
              setGroupTyping((prev) => {
                const next = { ...prev };
                delete next[eventAgentId];
                return next;
              });
              setGroupActivityHint((prev) => {
                if (!(eventAgentId in prev)) return prev;
                const next = { ...prev };
                delete next[eventAgentId];
                return next;
              });
              continue;
            }
            // Graph Runtime events → Run Graph panel store (do not render as chat bubbles).
            // Group SSE wraps graph payloads as { type, data: { content: "<json>" } }.
            if (typeof payload.type === "string" && payload.type.startsWith("graph.")) {
              if (!sessionStillActive) continue;
              const normalizedGraphPayload = normalizeGroupGraphPayload(payload.type, payload.data);
              // Some graph bridge events carry no explicit owner. This stream
              // has passed the exact foreground session lease, so fill the
              // canonical scope before applying it to the pane graph store.
              const graphPayload = {
                ...normalizedGraphPayload,
                session_id:
                  String(normalizedGraphPayload.session_id ?? "").trim() || requestSessionId,
                group_id:
                  String(normalizedGraphPayload.group_id ?? "").trim() || groupChatId || "",
              } as GraphSsePayload;
              if (
                !acceptsGroupGraphEvent(requestSessionId, graphPayload, {
                  allowRunSwitch: payload.type === "graph.run_created",
                  authoritative: isCurrentForegroundRequest(),
                })
              ) {
                continue;
              }
              useGraphRunStore.getState().applyEvent(pane.id, graphPayload, {
                trustedOwner: {
                  sessionId: requestSessionId,
                  groupId: groupChatId || "",
                },
              });
              const rid = String(graphPayload.run_id || "").trim();
              if (payload.type === "graph.run_created" && rid) {
                rememberGroupGraphRunId(requestSessionId, rid);
              }
              // Autopen only when a real task DAG exists — presence-only graphs
              // (human + agent nodes) must not steal focus in ordinary group chat.
              if (
                SHOW_DESKTOP_RUN_GRAPH &&
                (payload.type === "graph.node_updated" || payload.type === "graph.run_created") &&
                graphHasTaskNodes(useGraphRunStore.getState().byPane[pane.id]?.nodes)
              ) {
                try {
                  if (localStorage.getItem("agx-graph-panel-autopen-v1") !== "done") {
                    openWorkspaceSidebarForPane(
                      pane.id,
                      paneRef.current?.clientWidth ?? paneWidth,
                      openSidePanel,
                    );
                    setWorkPanelFocus({ kind: "graph" });
                    localStorage.setItem("agx-graph-panel-autopen-v1", "done");
                  }
                } catch {
                  /* ignore */
                }
              }
              if (payload.type === "graph.debate_nudge") {
                const tip = String(payload.data?.content ?? "").trim();
                if (tip) setDebateNudgeText(tip);
              }
              continue;
            }
            // ── workforce.* events (routing="team") ──────────────────────
            if (
              typeof payload.type === "string" &&
              (payload.type.startsWith("workforce.") || payload.type.startsWith("workforce_"))
            ) {
              if (!sessionStillActive) continue;
              applyGroupTeamControlEvent(payload.type, payload.data);
              const wfAction = normalizeGroupTeamControlEvent(payload.type, payload.data);
              const wfContent = String(payload.data?.content || "").trim();
              const wfData = payload.data || {};
              const wfRole = String(wfData.workflow_role ?? "").trim();
              const wfTaskId = String(
                wfData.workflow_task_id ?? wfData.task_id ?? "",
              ).trim();
              const wfAttempt = Number(wfData.workflow_attempt ?? 0);
              const wfStatus = String(wfData.workflow_status ?? wfAction).trim();
              const memberName = String(wfData.avatar_name ?? eventAgentId).trim() || eventAgentId;
              const memberUrl = String(wfData.avatar_url ?? "").trim();
              const description = String(
                wfData.task_description ?? wfData.description ?? wfData.content ?? "",
              ).trim();

              if (wfAction === "workforce_started") {
                groupDiscussionMode = String(wfData.mode ?? "").trim() === "discussion";
                setGroupCoordinatorActivity(
                  groupCoordinatorActivityText(wfAction, groupDiscussionMode) || "",
                );
              } else if (wfAction === "decompose_start") {
                setGroupCoordinatorActivity(
                  groupCoordinatorActivityText(wfAction, groupDiscussionMode) || "",
                );
              } else if (wfAction === "decompose_complete") {
                setGroupCoordinatorActivity(
                  groupCoordinatorActivityText(wfAction, groupDiscussionMode) || "",
                );
              } else if (wfAction === "decompose_failed") {
                clearGroupCoordinatorActivity();
                const errorText = String(wfData.error || wfContent || "无法拆解").trim();
                addGroupWorkflowMessage({
                  content: `任务拆解失败：${errorText}`,
                  avatarName: metaLeaderDisplayName,
                  workflowRole: "leader",
                  taskId: wfTaskId,
                  attempt: wfAttempt,
                  status: "failed",
                  event: wfAction,
                });
              } else if (wfAction === "task_created") {
                setGroupCoordinatorActivity(
                  groupCoordinatorActivityText(wfAction, groupDiscussionMode) || "",
                );
              } else if (wfAction === "task_assigned") {
                // Assignment is an internal scheduler state.  Wait until the
                // node really starts before showing the visible hand-off, so it
                // sits directly before the member who is about to speak.
                setGroupCoordinatorActivity(
                  groupCoordinatorActivityText(wfAction, groupDiscussionMode) || "",
                );
              } else if (wfAction === "task_started") {
                handoffGroupCoordinatorToMember(eventAgentId);
                addGroupWorkflowMessage({
                  content: formatGroupWorkforceHandoff(memberName, description),
                  avatarName: groupHost?.name || metaLeaderDisplayName,
                  workflowRole: "leader",
                  taskId: wfTaskId,
                  status: wfStatus,
                  event: "visible_handoff",
                });
                setGroupTyping((prev) => ({ ...prev, [eventAgentId]: memberName }));
                setGroupActivityHint((prev) => ({
                  ...prev,
                  [eventAgentId]: "正在处理交接任务…",
                }));
                setGroupMemberPhase((prev) => {
                  if (!(eventAgentId in prev)) return prev;
                  const next = { ...prev };
                  delete next[eventAgentId];
                  return next;
                });
              } else if (wfAction === "task_completed") {
                setGroupTyping((prev) => {
                  const next = { ...prev };
                  delete next[eventAgentId];
                  return next;
                });
                setGroupActivityHint((prev) => {
                  const next = { ...prev };
                  delete next[eventAgentId];
                  return next;
                });
              } else if (wfAction === "task_failed" || wfAction === "task_skipped") {
                setGroupTyping((prev) => {
                  const next = { ...prev };
                  delete next[eventAgentId];
                  return next;
                });
                setGroupActivityHint((prev) => {
                  const next = { ...prev };
                  delete next[eventAgentId];
                  return next;
                });
                const reason = String(wfData.error || wfContent || "未完成").trim();
                addGroupWorkflowMessage({
                  content: `@${memberName} 的工作项${wfAction === "task_skipped" ? "已跳过" : "失败"}：${reason}`,
                  avatarName: metaLeaderDisplayName,
                  workflowRole: "leader",
                  taskId: wfTaskId,
                  attempt: wfAttempt,
                  status: wfAction === "task_skipped" ? "skipped" : "failed",
                  event: wfAction,
                });
              } else if (wfAction === "assistant_message" || wfAction === "message_assistant") {
                setGroupTyping((prev) => {
                  const next = { ...prev };
                  delete next[eventAgentId];
                  return next;
                });
                if (wfContent) {
                  const messageRole =
                    wfRole === "executor" ? "executor" :
                    wfRole === "reviewer" ? "reviewer" :
                    wfRole === "leader" ? "leader" : "system";
                  addGroupWorkflowMessage({
                    content: wfContent,
                    agentId: eventAgentId,
                    avatarName: memberName,
                    avatarUrl: memberUrl,
                    workflowRole: messageRole,
                    taskId: wfTaskId,
                    attempt: wfAttempt,
                    status: wfStatus,
                    event: wfAction,
                  });
                }
              } else if (wfAction === "workforce_stopped") {
                clearGroupCoordinatorActivity();
                setGroupTyping({});
                setGroupActivityHint({});
              }
              continue;
            }
            if (payload.type === "tool_progress") {
              recordProgressActivity(requestSessionId);
              const progressPhase = String(payload.data?.phase ?? "");
              if (progressPhase === "stall_patient_wait") {
                if (sessionStillActive) {
                  const info = parseStallWaitPayload(payload.data, Date.now());
                  if (info) setStallWait(info);
                }
                continue;
              }
              if (progressPhase === "stall_patient_recovered") {
                if (sessionStillActive) setStallWait(null);
                continue;
              }
              const name = String(payload.data?.name ?? "tool");
              const sec = Number(payload.data?.elapsed_seconds ?? 0);
              if (eventAgentId === "meta" && sessionStillActive) {
                setLastToolProgress({ name, sec: Number.isFinite(sec) ? sec : 0 });
              }
              const outputLine = payload.data?.line as string | undefined;
              const progressCallId = String(payload.data?.tool_call_id ?? payload.data?.id ?? "").trim();
              if (eventAgentId === "meta" && progressCallId) {
                const patch: Parameters<typeof updatePaneMessageByToolCallId>[2] = {
                  toolStatus: "running",
                };
                if (Number.isFinite(sec)) patch.toolElapsedSec = sec;
                if (outputLine !== undefined) patch.appendStreamLine = String(outputLine);
                updatePaneToolMessageForSession(progressCallId, patch);
                continue;
              }
              if (outputLine !== undefined && eventAgentId === "meta" && !progressCallId) {
                // Legacy events without tool_call_id: keep liveness on stream (no merged card).
                continue;
              }
              if (eventAgentId === "meta") {
                continue;
              }
              if (name === "cc_bridge_send") {
                updateSubAgentForDisplayedSession(eventAgentId, {
                  currentAction: ccBridgeSendToolProgressLabel(sec, ccBridgeLastSessionModeRef.current),
                });
              } else {
                updateSubAgentForDisplayedSession(eventAgentId, {
                  currentAction: Number.isFinite(sec) ? `${name} 执行中… (${sec}s)` : `${name} 执行中…`,
                });
              }
              continue;
            }
            if (payload.type === "token") {
              if (eventAgentId === "meta") {
                const rawToken = String(payload.data?.text ?? "");
                // Strip backend-emitted ⏳ waiting placeholder — prevents it from appearing
                // in Thought blocks or committed assistant messages.
                const tokenText = rawToken.replace(/⏳\s*/g, "");
                if (!tokenText) continue;
                if (isThinkingPlaceholderText(tokenText) && !full.trim()) {
                  // Ignore other placeholder tokens to prevent ghost answers.
                  continue;
                }
                full += tokenText;
                cumulativeFull += tokenText;
                if (sessionStillActive) setStallWait(null);
                if (/<think>/i.test(full) && streamReasoningStartedAt === null) {
                  streamReasoningStartedAt = Date.now();
                }
                scheduleStreamTextUpdate(full);
              } else {
                const tok = String(payload.data?.text ?? "");
                if (tok) {
                  const sub = useAppStore.getState().subAgents.find((item) => item.id === eventAgentId);
                  const prev = sub?.liveOutput ?? "";
                  // Append token; cap at 8000 chars to avoid unbounded growth.
                  const next = (prev + tok).slice(-8000);
                  updateSubAgentForDisplayedSession(eventAgentId, { liveOutput: next });
                }
              }
            }
            if (payload.type === "tool_call") {
              if (sessionStillActive) setStallWait(null);
              const toolNameStr = String(payload.data?.name ?? "tool");
              const toolArgs = (payload.data?.arguments ?? payload.data?.args ?? {}) as Record<string, unknown>;
              const toolCallId = String(payload.data?.tool_call_id ?? payload.data?.id ?? "").trim();
              if (SEARCH_REFERENCE_TOOLS.has(toolNameStr)) {
                const q = String(toolArgs.query ?? "").trim();
                if (q) pendingSearchedQueries = mergeSearchedQueries(pendingSearchedQueries, [q]);
              }
              if (sessionStillActive && eventAgentId === "meta" && toolNameStr === "cc_bridge_start") {
                const callKey = toolCallId || `${requestSessionId || "session"}:cc_bridge_start`;
                const modeHint = parseCcBridgeModeFromPayload(toolArgs);
                if (modeHint === "headless") {
                  ccBridgeLastSessionModeRef.current = "headless";
                } else if (modeHint === "visible_tui") {
                  ccBridgeLastSessionModeRef.current = "visible_tui";
                }
                if (modeHint !== "headless") {
                  void triggerCcBridgeVisibleTerminal(callKey);
                }
              }
              // Filter out internal housekeeping tools that add no user-visible signal
              const SILENT_TOOLS = new Set(["check_resources"]);
              if (!SILENT_TOOLS.has(toolNameStr)) {
                if (eventAgentId === "meta") {
                  const pan = useAppStore.getState().panes.find((p) => p.id === pane.id);
                  const lastMsg = pan?.messages.length ? pan.messages[pan.messages.length - 1] : undefined;
                  const toolGroupId =
                    lastMsg?.role === "tool" && lastMsg.toolGroupId
                      ? lastMsg.toolGroupId
                      : crypto.randomUUID();
                  if (toolCallId) {
                    toolCallMetadata.set(toolCallId, {
                      toolName: toolNameStr,
                      toolArgs,
                      toolGroupId,
                    });
                  }
                  const rawArgs = JSON.stringify(toolArgs);
                  const content =
                    rawArgs.length > 80_000 ? `${rawArgs.slice(0, 80_000)}\n… (truncated)` : rawArgs;
                  // Clarification: paint the inline card before stream commit so the
                  // card appears on the same SSE frame as tool_call (no extra frame wait).
                  if (toolNameStr === "request_clarification") {
                    const clarifyExtras = toolCallId
                      ? buildClarificationMessageExtras(
                          toolArgs,
                          toolCallId,
                          toolGroupId,
                          requestSessionId,
                        )
                      : null;
                    if (clarifyExtras) {
                      addPaneMessageIfSessionActive(
                        pane.id,
                        "tool",
                        clarifyExtras.clarificationPrompt?.prompt ?? content,
                        "meta",
                        undefined,
                        undefined,
                        undefined,
                        clarifyExtras,
                      );
                      preserveStreamReasoningAtToolBoundary();
                      full = "";
                      streamReasoningStartedAt = null;
                      streamCommitRegistryRef.current.resetTurnSegment(requestSessionId);
                      if (sessionStillActive) cancelStreamRenderFrame();
                      scheduleStreamTextUpdate("");
                      continue;
                    }
                  }
                  preserveStreamReasoningAtToolBoundary();
                  full = "";
                  streamReasoningStartedAt = null;
                  streamCommitRegistryRef.current.resetTurnSegment(requestSessionId);
                  if (sessionStillActive) cancelStreamRenderFrame();
                  scheduleStreamTextUpdate("");
                  if (toolCallId) {
                    const merged = updatePaneToolMessageForSession(toolCallId, {
                      content,
                      toolName: toolNameStr,
                      toolArgs,
                      toolStatus: "running",
                    });
                    if (!merged) {
                      addPaneMessageIfSessionActive(
                        pane.id,
                        "tool",
                        content,
                        "meta",
                        undefined,
                        undefined,
                        undefined,
                        {
                          toolCallId,
                          toolName: toolNameStr,
                          toolArgs,
                          toolStatus: "running",
                          toolGroupId,
                        }
                      );
                    }
                    const pendingPatch = pendingToolResults[toolCallId];
                    if (pendingPatch) {
                      const reconciled = isTargetSessionStillActive()
                        ? updatePaneToolMessageForSession(toolCallId, pendingPatch.patch)
                        : mergePendingToolResultIntoDeferred(pendingPatch);
                      if (reconciled) delete pendingToolResults[toolCallId];
                    }
                  } else {
                    const legacy = `\u{1F527} ${toolNameStr}: ${JSON.stringify(toolArgs).slice(0, 120)}`;
                    addPaneMessageIfSessionActive(pane.id, "tool", legacy, "meta");
                  }
                } else {
                  flushSubAgentLiveOutputForDisplayedSession(eventAgentId);
                  const legacy = `\u{1F527} ${toolNameStr}: ${JSON.stringify(toolArgs).slice(0, 120)}`;
                  addSubAgentEventForDisplayedSession(eventAgentId, { type: "tool_call", content: legacy });
                  const livePreview = buildToolCallLivePreview(toolNameStr, toolArgs);
                  if (livePreview) {
                    const sub = useAppStore.getState().subAgents.find((item) => item.id === eventAgentId);
                    const prev = sub?.liveOutput ?? "";
                    const next = `${prev}${prev ? "\n\n" : ""}${livePreview}`.slice(-12000);
                    updateSubAgentForDisplayedSession(eventAgentId, { liveOutput: next });
                  }
                }
              }
            }
            if (payload.type === "tool_call_delta") {
              if (eventAgentId !== "meta") continue;
              const toolNameStr = String(payload.data?.name ?? "").trim();
              if (toolNameStr !== "show_widget") continue;
              const toolCallId = String(payload.data?.tool_call_id ?? payload.data?.id ?? "").trim();
              if (!toolCallId) continue;
              const argumentsRaw = String(payload.data?.arguments_raw ?? "");
              const partial = extractPartialShowWidgetArgs(argumentsRaw);
              if (!partial) continue;
              scheduleShowWidgetDelta(toolCallId, {
                argumentsRaw,
                title: partial.title || undefined,
                widgetCode: partial.widgetCode || undefined,
              });
              continue;
            }
            if (payload.type === "tool_result") {
              const toolName = String(payload.data?.name ?? payload.data?.tool_name ?? "");
              if (SEARCH_REFERENCE_TOOLS.has(toolName)) {
                const accumulated = accumulateReferenceTurn(
                  pendingReferences,
                  pendingSearchedQueries,
                  payload.data,
                );
                pendingReferences = accumulated.references;
                pendingSearchedQueries = accumulated.queries;
                syncTurnRefsSnapshot();
                if (isTargetSessionStillActive()) {
                  setStreamReferences([...pendingReferences]);
                  setStreamSearchedQueries([...pendingSearchedQueries]);
                }
              }
              if (toolName === "create_avatar") {
                try {
                  const rawResult = payload.data?.result;
                  const parsed =
                    typeof rawResult === "string"
                      ? (JSON.parse(rawResult) as Record<string, unknown>)
                      : (rawResult as Record<string, unknown> | null | undefined);
                  const avatarId = String(parsed?.avatar_id ?? "").trim();
                  if (sessionStillActive && parsed && parsed.ok && avatarId) {
                    window.dispatchEvent(
                      new CustomEvent("agenticx:avatars:changed", {
                        detail: {
                          avatarId,
                          name: String(parsed.name ?? "").trim(),
                          openPane: true,
                        },
                      })
                    );
                  }
                } catch {
                  // Ignore parse errors; tool card still renders via formatter.
                }
              }
              if (toolName === "create_group_chat") {
                try {
                  const rawResult = payload.data?.result;
                  const parsed =
                    typeof rawResult === "string"
                      ? (JSON.parse(rawResult) as Record<string, unknown>)
                      : (rawResult as Record<string, unknown> | null | undefined);
                  if (sessionStillActive && parsed && parsed.ok) {
                    const group = parsed.group as Record<string, unknown> | undefined;
                    window.dispatchEvent(
                      new CustomEvent("agenticx:groups:changed", {
                        detail: { groupId: String(group?.id ?? "").trim() },
                      })
                    );
                  }
                } catch {
                  // Ignore parse errors; tool card still renders via formatter.
                }
              }
              if (toolName === "install_portable_package") {
                try {
                  const rawResult = payload.data?.result;
                  const parsed =
                    typeof rawResult === "string"
                      ? (JSON.parse(rawResult) as Record<string, unknown>)
                      : (rawResult as Record<string, unknown> | null | undefined);
                  if (sessionStillActive && parsed && parsed.ok) {
                    window.dispatchEvent(
                      new CustomEvent("agenticx:avatars:changed", {
                        detail: {
                          avatarId: String(parsed.avatar_id ?? "").trim(),
                          name: String(parsed.name ?? "").trim(),
                          openPane: parsed.kind === "expert",
                        },
                      })
                    );
                    if (parsed.kind === "group") {
                      const group = parsed.group as Record<string, unknown> | undefined;
                      window.dispatchEvent(
                        new CustomEvent("agenticx:groups:changed", {
                          detail: { groupId: String(group?.id ?? "").trim() },
                        })
                      );
                    }
                  }
                } catch {
                  // Ignore parse errors; tool card still renders via formatter.
                }
              }
              const formatted = formatToolResultMessage(toolName, payload.data?.result, settings.providers);
              if (formatted.silent) continue;
              const resultCallId = String(payload.data?.tool_call_id ?? payload.data?.id ?? "").trim();
              const rawContent = serializeToolResultRaw(payload.data?.result);
              const preview = formatted.content.replace(/\s+/g, " ").trim().slice(0, 160);
              const resultProjection = projectRuntimeToolResult(
                payload.data,
                payload.data?.is_error === true ? "error" : deriveToolStatusFromResult(payload.data?.result),
              );
              const mergedStatus = resultProjection.status;
              const autoloadMetadata = deferredToolSchemaAutoloadMetadata(payload.data);
              if (eventAgentId === "meta") {
                const resultPatch = {
                  content: rawContent,
                  toolStatus: mergedStatus,
                  toolResultPreview: preview,
                  toolStreamLines: [],
                  ...(autoloadMetadata ? { metadata: autoloadMetadata } : {}),
                };
                let merged = resultCallId
                  ? updatePaneToolMessageForSession(resultCallId, resultPatch)
                  : false;
                if (!merged) {
                  const pan = useAppStore.getState().panes.find((p) => p.id === pane.id);
                  const fallbackCallId = [...(pan?.messages ?? [])]
                    .reverse()
                    .find(
                      (mm) =>
                        mm.role === "tool" &&
                        Boolean(mm.toolCallId) &&
                        (mm.toolStatus === "running" || mm.toolStatus === "pending") &&
                        (!toolName || (mm.toolName ?? "") === toolName)
                    )?.toolCallId;
                  if (fallbackCallId) {
                    merged = updatePaneToolMessageForSession(fallbackCallId, resultPatch);
                  }
                }
                if (!merged && resultCallId) {
                  const callMetadata = toolCallMetadata.get(resultCallId);
                  pendingToolResults[resultCallId] = {
                    callId: resultCallId,
                    toolName: resolvePendingToolName(
                      callMetadata?.toolName,
                      toolName,
                      resultCallId,
                    ),
                    toolArgs: callMetadata?.toolArgs,
                    toolGroupId: callMetadata?.toolGroupId,
                    patch: resultPatch,
                  };
                  merged = true;
                }
                if (!merged && !shouldSkipFormattedToolResultFallback(formatted.content, rawContent)) {
                  addPaneMessageIfSessionActive(
                    pane.id,
                    "tool",
                    rawContent || formatted.content,
                    "meta",
                    undefined,
                    undefined,
                    undefined,
                    {
                      toolCallId: resultCallId || undefined,
                      toolName: toolName || undefined,
                      toolStatus: mergedStatus,
                      toolResultPreview: preview,
                    },
                  );
                }
              } else {
                addSubAgentEventForDisplayedSession(eventAgentId, { type: "tool_result", content: formatted.content });
                if (toolName === "file_write" || toolName === "file_edit") {
                  const sub = useAppStore.getState().subAgents.find((item) => item.id === eventAgentId);
                  const prev = sub?.liveOutput ?? "";
                  const marker = `\n\n# ${toolName} applied`;
                  updateSubAgentForDisplayedSession(eventAgentId, { liveOutput: `${prev}${marker}`.slice(-12000) });
                }
              }
              if (toolName === "spawn_subagent" && eventAgentId === "meta") {
                try {
                  const spawnResult = typeof payload.data?.result === "string"
                    ? JSON.parse(payload.data.result)
                    : payload.data?.result;
                  const spawnId = spawnResult?.agent_id;
                  if (spawnId) {
                    console.debug("[ChatPane] spawn_subagent tool_result fallback addSubAgent", spawnId);
                  addSubAgentForDisplayedSession({
                      id: spawnId,
                      name: spawnResult.name ?? spawnId,
                      role: spawnResult.role ?? "worker",
                      provider: spawnResult.provider ?? undefined,
                      model: spawnResult.model ?? undefined,
                      task: spawnResult.task ?? "",
                      sessionId: requestSessionId || undefined,
                    });
                  }
                } catch { /* ignore parse errors */ }
              }
              if (
                eventAgentId === "meta" &&
                toolName === "set_taskspace" &&
                isSetTaskspaceToolSuccess(payload.data?.result)
              ) {
                if (sessionStillActive) setTaskspaceAutoRefreshKey((prev) => prev + 1);
              }
              if (sessionStillActive && eventAgentId === "meta" && toolName === "cc_bridge_start") {
                try {
                  const resultRaw = payload.data?.result;
                  const resultObj = typeof resultRaw === "string" ? JSON.parse(resultRaw) : resultRaw;
                  const hint = parseCcBridgeModeFromPayload(resultObj);
                  if (hint) {
                    ccBridgeLastSessionModeRef.current = hint;
                  }
                  const sid = typeof resultObj?.session_id === "string" ? resultObj.session_id : "";
                  if (sid && hint === "visible_tui") {
                    void triggerCcBridgeTailTerminal(sid);
                  }
                } catch {
                  // ignore parse errors
                }
              }
              if (eventAgentId === "meta" && toolName === "cc_bridge_send") {
                try {
                  const resultRaw = payload.data?.result;
                  const resultObj = typeof resultRaw === "string" ? JSON.parse(resultRaw) : resultRaw;
                  if (
                    resultObj?.mode === "visible_tui" &&
                    resultObj?.ok === true &&
                    String(resultObj?.parsed_response ?? "").trim().length > 0
                  ) {
                    addPaneMessageIfSessionActive(
                      pane.id,
                      "assistant",
                      String(resultObj.parsed_response),
                      "meta",
                    );
                  }
                } catch {
                  /* ignore */
                }
              }
            }
            if (payload.type === "confirm_required") {
              const confirmQuestion = String(payload.data?.question ?? "是否确认执行？");
              const confirmContext = objectRecord(payload.data?.context);
              if (eventAgentId !== "meta") {
                const confirmReqId = String(payload.data?.id ?? "");
                updateSubAgentForDisplayedSession(eventAgentId, {
                  status: "awaiting_confirm",
                  currentAction: "等待你的确认",
                  pendingConfirm: confirmReqId
                    ? {
                        requestId: confirmReqId,
                        question: confirmQuestion,
                        agentId: eventAgentId,
                        sessionId: requestSessionId,
                        context: confirmContext,
                      }
                    : undefined,
                });
                addSubAgentEventForDisplayedSession(eventAgentId, {
                  type: "confirm_required",
                  content: confirmQuestion,
                });
              }
              if (!sessionStillActive) continue;
              const ok = await onOpenConfirm(
                String(payload.data?.id ?? ""),
                confirmQuestion,
                typeof confirmContext?.diff === "string" ? confirmContext.diff : undefined,
                eventAgentId,
                confirmContext,
                { sessionId: requestSessionId, runId: approvalRunId },
              );
              await fetch(`${apiBase}/api/confirm`, {
                method: "POST",
                headers: { "Content-Type": "application/json", "x-agx-desktop-token": apiToken },
                body: JSON.stringify({
                  session_id: requestSessionId,
                  request_id: payload.data?.id,
                  approved: ok,
                  agent_id: eventAgentId,
                }),
              });
            }
            if (payload.type === "confirm_response") {
              if (eventAgentId !== "meta") {
                const approved = !!payload.data?.approved;
                updateSubAgentForDisplayedSession(eventAgentId, {
                  status: approved ? "running" : "cancelled",
                  currentAction: approved ? "确认通过，继续执行" : "确认拒绝，执行终止",
                  pendingConfirm: undefined,
                });
                addSubAgentEventForDisplayedSession(eventAgentId, {
                  type: "confirm_response",
                  content: approved ? "确认通过" : "确认拒绝",
                });
              }
            }
            if (payload.type === "clarification_required") {
              const clarifyReqId = String(payload.data?.id ?? "");
              const clarifyPrompt = String(payload.data?.prompt ?? "");
              const clarifyOptions = Array.isArray(payload.data?.options)
                ? (payload.data.options as string[]).map((o) => String(o)).filter(Boolean)
                : [];
              const clarifyAllowFreeText = payload.data?.allow_free_text !== false;
              const clarifyContext = objectRecord(payload.data?.context);
              const clarifyDecisions = parseClarificationDecisions(payload.data?.decisions);
              const actionConfirm =
                clarifyContext && typeof clarifyContext === "object"
                  ? parseActionConfirmationContext({
                      requestId: clarifyReqId,
                      sessionId: requestSessionId,
                      agentId: eventAgentId === "meta" ? "meta" : eventAgentId,
                      context: clarifyContext,
                      status: "pending",
                    })
                  : null;

              // Generic action confirmation: dedicated card, do not open ClarificationDialog.
              if (actionConfirm && eventAgentId === "meta" && clarifyReqId) {
                const pan = useAppStore.getState().panes.find((p) => p.id === pane.id);
                const running = findRunningActionConfirmationToolMessage(pan?.messages ?? []);
                const metaPatch = {
                  content: actionConfirm.title,
                  actionConfirmation: actionConfirm,
                  clarificationPrompt: undefined,
                  metadata: {
                    kind: "clarification",
                    request_id: clarifyReqId,
                    prompt: actionConfirm.title,
                    options: [actionConfirm.approveLabel, actionConfirm.rejectLabel],
                    allow_free_text: true,
                    context: {
                      kind: "action_confirmation",
                      title: actionConfirm.title,
                      summary: actionConfirm.summary,
                      approve_label: actionConfirm.approveLabel,
                      reject_label: actionConfirm.rejectLabel,
                      expires_at_ms: actionConfirm.expiresAtMs,
                      ...(actionConfirm.source ? { source: actionConfirm.source } : {}),
                    },
                  },
                };
                if (running?.toolCallId) {
                  updatePaneToolMessageForSession(running.toolCallId, metaPatch);
                } else {
                  const dup = (pan?.messages ?? []).some(
                    (m) => m.actionConfirmation?.requestId === clarifyReqId,
                  );
                  if (!dup) {
                    addPaneMessageIfSessionActive(
                      pane.id,
                      "tool",
                      actionConfirm.title,
                      "meta",
                      undefined,
                      undefined,
                      undefined,
                      {
                        toolName: "request_action_confirmation",
                        toolStatus: "running",
                        toolArgs: {
                          title: actionConfirm.title,
                          summary: actionConfirm.summary,
                          approve_label: actionConfirm.approveLabel,
                          reject_label: actionConfirm.rejectLabel,
                          source: actionConfirm.source,
                        },
                        actionConfirmation: actionConfirm,
                        metadata: metaPatch.metadata,
                      },
                    );
                  }
                }
                continue;
              }

              if (eventAgentId !== "meta") {
                updateSubAgentForDisplayedSession(eventAgentId, {
                  status: "awaiting_input",
                  currentAction: "等待你的输入",
                  pendingClarification: clarifyReqId
                    ? {
                        requestId: clarifyReqId,
                        prompt: clarifyPrompt,
                        options: clarifyOptions,
                        decisions: clarifyDecisions.length > 0 ? clarifyDecisions : undefined,
                        allowFreeText: clarifyAllowFreeText,
                        agentId: eventAgentId,
                        sessionId: requestSessionId,
                        context: clarifyContext,
                      }
                    : undefined,
                });
                addSubAgentEventForDisplayedSession(eventAgentId, {
                  type: "clarification_required",
                  content: clarifyPrompt || "等待输入",
                });
              }
              // For sub-agents we keep the legacy blocking path (updates pendingClarification on SubAgent).
              // For the main Meta agent we render a non-blocking inline ClarificationCard by
              // writing a tool message that carries `clarificationPrompt` (NFR-2 visibility).
              if (sessionStillActive && eventAgentId !== "meta" && onOpenClarification && clarifyReqId) {
                const answer = await onOpenClarification(
                  clarifyReqId,
                  clarifyPrompt,
                  clarifyOptions,
                  clarifyAllowFreeText,
                  eventAgentId,
                  clarifyContext,
                );
                await fetch(`${apiBase}/api/clarify`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json", "x-agx-desktop-token": apiToken },
                  body: JSON.stringify({
                    session_id: requestSessionId,
                    request_id: clarifyReqId,
                    agent_id: eventAgentId,
                    answer_text: answer?.answerText ?? "",
                    selected_options: answer?.selectedOptions ?? [],
                  }),
                });
              }
              // Meta: inline card — patch the running tool row when possible so the
              // card appears immediately on tool_call and only receives the real
              // request_id here; never nest inside TurnToolGroupCard as raw JSON.
              if (eventAgentId === "meta" && clarifyReqId && clarifyPrompt) {
                const pan = useAppStore.getState().panes.find((p) => p.id === pane.id);
                const running = findRunningClarificationToolMessage(pan?.messages ?? []);
                const promptPayload = {
                  requestId: clarifyReqId,
                  prompt: clarifyPrompt,
                  options: clarifyOptions,
                  decisions: clarifyDecisions.length > 0 ? clarifyDecisions : undefined,
                  allowFreeText: clarifyAllowFreeText,
                  agentId: "meta",
                  sessionId: requestSessionId,
                  context: clarifyContext,
                };
                const metaPatch = {
                  content: clarifyPrompt,
                  clarificationPrompt: promptPayload,
                  metadata: {
                    kind: "clarification",
                    request_id: clarifyReqId,
                    prompt: clarifyPrompt,
                    options: clarifyOptions,
                    decisions: clarifyDecisions.length > 0 ? clarifyDecisions : undefined,
                    allow_free_text: clarifyAllowFreeText,
                    context: clarifyContext,
                  },
                };
                if (running?.toolCallId) {
                  updatePaneToolMessageForSession(running.toolCallId, metaPatch);
                } else {
                  const dup = (pan?.messages ?? []).some(
                    (m) => m.clarificationPrompt?.requestId === clarifyReqId,
                  );
                  if (!dup) {
                    addPaneMessageIfSessionActive(
                      pane.id,
                      "tool",
                      clarifyPrompt,
                      "meta",
                      undefined,
                      undefined,
                      undefined,
                      {
                        toolName: "request_clarification",
                        toolStatus: "running",
                        toolArgs: {
                          prompt: clarifyPrompt,
                          options: clarifyOptions,
                          allow_free_text: clarifyAllowFreeText,
                          context: clarifyContext,
                        },
                        clarificationPrompt: promptPayload,
                        metadata: metaPatch.metadata,
                      },
                    );
                  }
                }
              }
            }
            if (payload.type === "clarification_response") {
              const respId = String(payload.data?.id ?? "").trim();
              const respAnswer = payload.data?.answer;
              if (eventAgentId !== "meta") {
                updateSubAgentForDisplayedSession(eventAgentId, {
                  status: "running",
                  currentAction: "已收到回复，继续执行",
                  pendingClarification: undefined,
                });
                addSubAgentEventForDisplayedSession(eventAgentId, {
                  type: "clarification_response",
                  content: "已收到用户回复",
                });
              }
              // Meta (and sub): mark the inline card as answered in the store so
              // the card flips to the "已回复" state even if the answer came from
              // another client / the legacy Dialog path.
              if (respId && sessionStillActive) {
                const ans =
                  respAnswer && typeof respAnswer === "object"
                    ? {
                        answerText: String((respAnswer as Record<string, unknown>).answer_text ?? ""),
                        selectedOptions: Array.isArray((respAnswer as Record<string, unknown>).selected_options)
                          ? ((respAnswer as Record<string, unknown>).selected_options as unknown[]).map((o) => String(o)).filter(Boolean)
                          : [],
                      }
                    : { answerText: "", selectedOptions: [] };
                useAppStore.getState().markClarificationAnswered(respId, ans);
              }
            }
            if (payload.type === "clarification_suspended") {
              if (eventAgentId !== "meta") {
                updateSubAgentForDisplayedSession(eventAgentId, {
                  status: "running",
                  currentAction: "无人值守，提问已挂起",
                  pendingClarification: undefined,
                });
              }
            }
            if (payload.type === "subagent_started") {
              if (!sessionStillActive) continue;
              const subId = String(payload.data?.agent_id ?? "").trim();
              console.debug("[ChatPane] SSE subagent_started", subId, "sessionId:", requestSessionId);
              if (subId) {
                const isDelegation = Boolean(payload.data?.delegation);
                const isRetry = Boolean(payload.data?.retried);
                const alreadyTracked = subAgents.some((sub) => sub.id === subId);
                const avatarSessionId =
                  (typeof payload.data?.avatar_session_id === "string" && payload.data.avatar_session_id.trim()) || "";
                addSubAgentForDisplayedSession({
                  id: subId,
                  name: String(payload.data?.name ?? subId),
                  role: String(payload.data?.role ?? (isDelegation ? "delegated avatar" : "worker")),
                  provider: payload.data?.provider == null ? undefined : String(payload.data.provider),
                  model: payload.data?.model == null ? undefined : String(payload.data.model),
                  task: String(payload.data?.task ?? ""),
                  sessionId: avatarSessionId || requestSessionId || undefined,
                });
                updateSubAgentForDisplayedSession(subId, {
                  status: "running",
                  currentAction: isDelegation ? "委派执行中" : "执行中",
                  ...(isRetry || alreadyTracked
                    ? { resultSummary: "", liveOutput: "", outputFiles: [] as string[] }
                    : {}),
                });
                addSubAgentEventForDisplayedSession(
                  subId,
                  {
                    type: isRetry || alreadyTracked
                      ? "retry"
                      : isDelegation
                        ? "delegation_started"
                        : "started",
                    content: isRetry || alreadyTracked
                      ? "已重新启动"
                      : isDelegation
                        ? `已委派给 ${String(payload.data?.name ?? subId)}`
                        : "已启动",
                  }
                );
                if (isDelegation && avatarSessionId && !isGroupPane) {
                  const dlgName = String(payload.data?.name ?? "").trim();
                  const dlgAvatarId = typeof payload.data?.avatar_id === "string" ? payload.data.avatar_id.trim() : "";
                  const store = useAppStore.getState();
                  const existingPane = store.panes.find((p) => {
                    if (p.avatarId && dlgAvatarId && p.avatarId === dlgAvatarId) return true;
                    return dlgName && (p.avatarName ?? "").trim().toLowerCase() === dlgName.toLowerCase();
                  });
                  if (existingPane) {
                    // Only sync session if the pane has no session yet (freshly opened).
                    // Never overwrite an active session — the delegation already runs
                    // in _find_or_create_avatar_session which reuses the avatar's existing session.
                  } else {
                    const newPaneId = addPane(dlgAvatarId || null, dlgName || subId, avatarSessionId);
                    setActivePaneId(newPaneId);
                  }
                }
              }
            }
            if (payload.type === "subagent_progress") {
              if (!sessionStillActive) continue;
              const subId = String(payload.data?.agent_id ?? "").trim();
              if (subId) {
                const text = String(payload.data?.text ?? "执行中");
                updateSubAgentForDisplayedSession(subId, { currentAction: text });
                // Keep heartbeat visible in status line, but avoid flooding detail logs.
                if (!/^执行中（\d+s）/.test(text)) {
                  addSubAgentEventForDisplayedSession(subId, { type: "progress", content: text });
                }
              }
            }
            if (payload.type === "subagent_checkpoint") {
              if (!sessionStillActive) continue;
              const subId = String(payload.data?.agent_id ?? "").trim();
              if (subId) {
                const text = String(payload.data?.text ?? "阶段检查点");
                updateSubAgentForDisplayedSession(subId, { status: "running", currentAction: text });
                addSubAgentEventForDisplayedSession(subId, { type: "checkpoint", content: text });
              }
            }
            if (payload.type === "subagent_paused") {
              if (!sessionStillActive) continue;
              // FR-2: tool-rounds saturation must surface as an explicit "paused"
              // state (not "running" or "completed") so the user knows the task
              // halted at a hard limit rather than finishing naturally.
              const subId = String(payload.data?.agent_id ?? "").trim();
              if (subId) {
                const round = Number(payload.data?.round ?? 0) || 0;
                const maxRounds = Number(payload.data?.max_rounds ?? 0) || 0;
                const baseText = String(payload.data?.text ?? "已暂停").trim();
                const roundLabel = round && maxRounds ? `（触顶 ${round}/${maxRounds} 轮）` : "";
                const tools = Array.isArray(payload.data?.executed_tools)
                  ? (payload.data.executed_tools as unknown[]).map((t) => String(t)).filter(Boolean)
                  : [];
                const toolsLabel = tools.length ? ` · 最近工具：${tools.slice(-5).join(", ")}` : "";
                const display = `${baseText}${roundLabel}${toolsLabel}`;
                updateSubAgentForDisplayedSession(subId, {
                  status: "paused",
                  currentAction: display,
                  resultSummary:
                    typeof payload.data?.summary === "string" ? payload.data.summary : undefined,
                  sessionId:
                    (typeof payload.data?.avatar_session_id === "string" && payload.data.avatar_session_id.trim())
                      || undefined,
                });
                addSubAgentEventForDisplayedSession(subId, { type: "paused", content: display });
                // Also drop a visible note into the avatar pane so the user does
                // not need to expand the subagent panel to see why work stopped.
                addPaneMessageIfSessionActive(
                  pane.id,
                  "tool",
                  `⏸ 任务已暂停${roundLabel}。${baseText}${toolsLabel}`,
                  eventAgentId || "meta",
                );
              }
            }
            if (payload.type === "subagent_completed") {
              if (!sessionStillActive) continue;
              const subId = String(payload.data?.agent_id ?? "").trim();
              if (subId) {
                flushSubAgentLiveOutputForDisplayedSession(subId);
                const isDelegation = Boolean(payload.data?.delegation);
                const summary =
                  typeof payload.data?.summary === "string" ? payload.data.summary : undefined;
                const resultFile =
                  typeof payload.data?.result_file === "string" && payload.data.result_file
                    ? payload.data.result_file
                    : undefined;
                updateSubAgentForDisplayedSession(subId, {
                  status: "completed",
                  currentAction: isDelegation ? "委派完成（查看摘要）" : "已完成（查看摘要）",
                  resultSummary: summary,
                  resultFile,
                  outputFiles: resolveSubAgentOutputPaths(summary, { resultFile }),
                  sessionId:
                    (typeof payload.data?.avatar_session_id === "string" && payload.data.avatar_session_id.trim())
                      || undefined,
                });
                addSubAgentEventForDisplayedSession(
                  subId,
                  { type: isDelegation ? "delegation_completed" : "completed", content: String(payload.data?.summary ?? "完成") }
                );
              }
            }
            if (payload.type === "subagent_error") {
              if (!sessionStillActive) continue;
              const subId = String(payload.data?.agent_id ?? "").trim();
              if (subId) {
                flushSubAgentLiveOutputForDisplayedSession(subId);
                const text = String(payload.data?.text ?? "执行异常");
                const isDelegation = Boolean(payload.data?.delegation);
                updateSubAgentForDisplayedSession(subId, {
                  status: payload.data?.status === "cancelled" ? "cancelled" : "failed",
                  currentAction: text,
                  sessionId:
                    (typeof payload.data?.avatar_session_id === "string" && payload.data.avatar_session_id.trim())
                      || undefined,
                });
                addSubAgentEventForDisplayedSession(subId, { type: isDelegation ? "delegation_error" : "error", content: text });
              }
            }
            if (payload.type === "final") {
              receivedFinalEvent = true;
              if (sessionStillActive) setStallWait(null);
              if (eventAgentId === "meta") {
                useAppStore.getState().clearSessionHistoryHint(requestSessionId);
                const normalizedFinal = normalizeFinalAssistantPayload(
                  payload.data?.text,
                  payload.data?.suggested_questions,
                  payload.data?.turn_terminal,
                  payload.data?.terminal_reason,
                );
                const finalText = normalizedFinal.text;
                pendingSuggestedQuestions = normalizedFinal.suggestedQuestions;
                pendingFinalTurnTerminal = normalizedFinal.turnTerminal;
                pendingFinalTerminalReason = normalizedFinal.terminalReason;
                const appliedRefs = applyFinalReferencePayload(
                  pendingReferences,
                  pendingSearchedQueries,
                  payload.data,
                );
                pendingReferences = appliedRefs.references;
                pendingSearchedQueries = appliedRefs.queries;
                const finalReasoningRaw = payload.data?.reasoning;
                if (typeof finalReasoningRaw === "string" && finalReasoningRaw.trim()) {
                  const candidate = finalReasoningRaw.trim().slice(0, 16384);
                  // GLM may echo the public answer into reasoning_content; drop it.
                  if (!reasoningDuplicatesVisibleBody(candidate, finalText)) {
                    pendingReasoning = candidate;
                  }
                }
                const finalReasoningSecondsRaw = payload.data?.reasoning_seconds;
                if (
                  typeof finalReasoningSecondsRaw === "number" &&
                  finalReasoningSecondsRaw >= 1 &&
                  pendingReasoning
                ) {
                  pendingReasoningSeconds = Math.round(finalReasoningSecondsRaw);
                }
                syncTurnRefsSnapshot();
                if (isTargetSessionStillActive()) {
                  setStreamReferences([...pendingReferences]);
                  setStreamSearchedQueries([...pendingSearchedQueries]);
                }
                // Final payload is authoritative. Replacing (instead of merging) avoids
                // duplicate concatenation when token stream shape differs from final text.
                if (finalText.trim() && !isThinkingPlaceholderText(finalText)) {
                  full = finalText;
                  cumulativeFull = finalText;
                } else if (!assistantVisibleBodyForUi(full).trim()) {
                  full = "";
                  cumulativeFull = "";
                  pendingSuggestedQuestions = [];
                  void mergeTailFromDisk(requestSessionId);
                }
                scheduleStreamTextUpdate(full);
              } else {
                flushSubAgentLiveOutputForDisplayedSession(eventAgentId);
                updateSubAgentForDisplayedSession(eventAgentId, { status: "completed", currentAction: "已完成" });
                addSubAgentEventForDisplayedSession(eventAgentId, { type: "final", content: String(payload.data?.text ?? "") });
              }
            }
            if (payload.type === "token_usage") {
              const inp = Number(payload.data?.input_tokens ?? 0);
              const out = Number(payload.data?.output_tokens ?? 0);
              const cached = Number(payload.data?.cached_tokens ?? 0);
              if ((inp > 0 || out > 0 || cached > 0) && isTargetSessionStillActive()) {
                useAppStore.getState().accumulatePaneTokens(pane.id, inp, out, cached);
              }
            }
            if (payload.type === "compaction") {
              // FR-3: surface context compaction so users do not learn about it
              // only when the model later "explains" it as a failure cause.
              const count = Number(payload.data?.compacted_count ?? 0) || 0;
              const reactive = Boolean(payload.data?.reactive);
              const summary = typeof payload.data?.summary === "string" ? payload.data.summary : "";
              const notice = buildCompactionEventNotice(count, reactive, summary);
              addPaneMessageIfSessionActive(pane.id, "tool", notice.text, eventAgentId || "meta", undefined, undefined, undefined, {
                noticeKind: notice.noticeKind,
              });
            }
            if (payload.type === "context_stats") {
              if (!sessionStillActive) continue;
              const round = Number(payload.data?.round ?? 0) || 0;
              const toolSession = Number(payload.data?.tool_result_tokens_session ?? 0) || 0;
              const archived = Number(payload.data?.archived_tool_calls ?? 0) || 0;
              setContextLoopStats({ round, tool_result_tokens_session: toolSession, archived_tool_calls: archived });
            }
            if (payload.type === "error") {
              if (!sessionStillActive) continue;
              setStallWait(null);
              const errText = String(payload.data?.text ?? "未知错误");
              const severity = String(payload.data?.severity ?? "").trim();
              const detector = String(payload.data?.detector ?? "").trim();
              if (isDeferredToolSchemaAutoload(payload.data)) continue;
              if (
                eventAgentId === "meta"
                && detector === "widget_flow_guard"
                && payload.data?.action === "discard_stream"
              ) {
                full = "";
                cumulativeFull = "";
                streamReasoningStartedAt = null;
                cancelStreamRenderFrame();
                scheduleStreamTextUpdate("");
                continue;
              }
              const budgetInfo = budgetExceededInfoFromPayload(
                payload.data as Record<string, unknown> | undefined,
              );
              if (budgetInfo) {
                receivedBudgetExceededEvent = true;
                const sid = (pane.sessionId || "").trim();
                setBudgetExceededInfo({ ...budgetInfo, sessionId: sid || budgetInfo.sessionId });
                addPaneMessageIfSessionActive(
                  pane.id,
                  "tool",
                  errText,
                  eventAgentId || "meta",
                  undefined,
                  undefined,
                  undefined,
                  {
                    noticeKind: "budget_exceeded",
                    budgetSource: budgetInfo.source,
                    budgetCurrent: budgetInfo.current,
                    budgetMax: budgetInfo.maxAllowed,
                  },
                );
              } else if (
                severity === "warning"
                || detector === "token_budget_compress"
                || detector === "compactor_circuit_breaker"
                || detector === "context_budget_compact"
                || detector === "context_window"
              ) {
                const warningLevel = String(payload.data?.warning_level ?? "").trim();
                const noticeKind = noticeKindForRuntimeWarning(detector, warningLevel);
                addPaneMessageIfSessionActive(pane.id, "tool", errText, eventAgentId || "meta", undefined, undefined, undefined, {
                  noticeKind,
                });
              } else if (errText.includes("已达到最大工具调用轮数")) {
                const maxRounds = Number(payload.data?.max_rounds ?? 0) || 30;
                const rounds = Number(payload.data?.round ?? maxRounds);
                setExhaustedRounds({ rounds, maxRounds });
                setStallState("exhausted");
                addPaneMessageIfSessionActive(pane.id, "tool", errText, "meta");
              } else if (!isEphemeralStopErrorText(errText)) {
                // Merge tool-scoped errors into the existing ToolCallCard when possible
                // (hook-block / not-loaded / permission deny all share tool_call_id).
                const errToolCallId = String(payload.data?.tool_call_id ?? "").trim();
                if (errToolCallId) {
                  const merged = updatePaneToolMessageForSession(errToolCallId, {
                    content: errText,
                    toolStatus: "error",
                    toolResultPreview: errText.slice(0, 120),
                    toolStreamLines: [],
                  });
                  if (!merged) {
                    addPaneMessageIfSessionActive(pane.id, "tool", `❌ ${errText}`, "meta");
                  }
                } else {
                  addPaneMessageIfSessionActive(pane.id, "tool", `❌ ${errText}`, "meta");
                }
              }
            }
          } catch {
            // Ignore malformed frame.
          }
        }
      }

      // A replaced reader can finish after the new request starts. Skip the
      // terminal reconciliation/commit path for that old request as well.
      if (!ownsForegroundRequest()) return;

      // Reconcile every tool result before committing the terminal assistant row.
      // This keeps the live message order identical to messages.json after reload.
      flushPendingToolResults();
      const trimmedFull = full.trim();
      syncTurnRefsSnapshot();
      const refExtras = referenceExtrasFromTurn(pendingReferences, pendingSearchedQueries);
      const sugExtras =
        pendingSuggestedQuestions.length > 0
          ? { suggestedQuestions: pendingSuggestedQuestions.slice(0, 3) }
          : undefined;
      const reasoningExtras: Record<string, unknown> = {};
      if (
        pendingReasoning &&
        !reasoningDuplicatesVisibleBody(pendingReasoning, full)
      ) {
        reasoningExtras.reasoning = pendingReasoning;
        if (pendingReasoningSeconds !== undefined)
          reasoningExtras.reasoningSeconds = pendingReasoningSeconds;
      }
      const terminalMetaExtras: Record<string, unknown> = receivedFinalEvent
        ? {
            metadata: {
              turn_terminal: pendingFinalTurnTerminal,
              ...(pendingFinalTerminalReason
                ? { terminal_reason: pendingFinalTerminalReason }
                : {}),
            },
          }
        : { metadata: { turn_terminal: false } };
      const turnExtras =
        refExtras || sugExtras || Object.keys(reasoningExtras).length > 0 || receivedFinalEvent
          ? { ...refExtras, ...sugExtras, ...reasoningExtras, ...terminalMetaExtras }
          : undefined;
      const completedAt = Date.now();
      const stampLastAssistantCompletedAt = () => {
        mergeLastAssistantIfSessionActive({
          timestamp: completedAt,
        });
      };
      if (
        trimmedFull &&
        !isThinkingPlaceholderText(full) &&
        !streamCommitRegistryRef.current.isCommitted(requestSessionId)
      ) {
        const mid = streamCommitRegistryRef.current.getMidCommit(requestSessionId);
        if (mid !== null && trimmedFull === mid) {
          streamCommitRegistryRef.current.markCommitted(requestSessionId);
          mergeLastAssistantIfSessionActive({
            ...(turnExtras ?? {}),
            timestamp: completedAt,
          });
        } else {
          addPaneMessageIfSessionActive(
            pane.id,
            "assistant",
            full,
            "meta",
            chatProvider,
            chatModel,
            undefined,
            { ...(turnExtras ?? {}), timestamp: completedAt },
          );
          streamCommitRegistryRef.current.markCommitted(requestSessionId);
        }
      } else if (
        trimmedFull &&
        !isThinkingPlaceholderText(full) &&
        streamCommitRegistryRef.current.isCommitted(requestSessionId)
      ) {
        const committedPatch = buildCommittedAssistantPatch(
          full,
          turnExtras,
          receivedFinalEvent,
        );
        if (committedPatch) {
          mergeLastAssistantIfSessionActive({
            ...committedPatch,
            timestamp: completedAt,
          });
        } else {
          stampLastAssistantCompletedAt();
        }
      } else if (
        !receivedBudgetExceededEvent &&
        isTargetSessionStillActive() &&
        shouldShowTurnInterruptedSyncToast({
          aborted: abortController.signal.aborted,
          receivedFinalEvent,
          isGroupPane,
          receivedGroupDone: receivedDoneEvent,
          receivedGroupTerminal: receivedGroupTerminalEvent,
        })
      ) {
        // Backend persists turn_interrupted to messages.json; toast is ephemeral.
        setStallHintToast(TURN_INTERRUPTED_TOAST);
        await mergeTailFromDisk(requestSessionId);
      }
    } catch (error) {
      if (!ownsForegroundRequest()) return;
      if (isContinuation) {
        clearResumeInFlight(requestSessionId);
      }
      // Keep terminal ordering stable on exceptional exits as well: any real
      // tool result belongs before the request-level failure notice.
      flushPendingToolResults();
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        addPaneMessageIfSessionActive(pane.id, "tool", `❌ 请求失败: ${String(error)}`, "meta");
      }
    } finally {
      if (ownsForegroundRequest() && isTargetSessionStillActive()) {
        onConfirmRunEnd({ sessionId: requestSessionId, runId: approvalRunId });
      }
      // Safety net for malformed/aborted streams. The normal completion path
      // already drains this before FINAL, so this is an idempotent no-op there.
      flushPendingToolResults();
      for (const timer of showWidgetDeltaTimers.values()) {
        window.clearTimeout(timer);
      }
      showWidgetDeltaTimers.clear();
      showWidgetDeltaPending.clear();
      releaseSendLock();

      // Barge-in replaces this run's AbortController with a newer one for the
      // same session_id. Only the owner of the current controller may clear
      // stream state / registry / queue — otherwise the old finally clobbers
      // the new force-send turn.
      const stillOwnsStream =
        ownsForegroundRequest();

      let nextQueued: QueuedMessage | null = null;
      if (stillOwnsStream) {
        // The final disk merge is asynchronous. Treat the retired owner slot
        // as valid only while it is still empty or still points at this exact
        // foreground lease; a newer reattach/foreground claim during the
        // load must turn the merge into a no-op.
        const ownsForegroundFinalMerge = () => {
          const owner = sessionStreamOwnersRef.current[requestSessionId];
          return (
            !owner ||
            ownsSessionStreamOwner(
              sessionStreamOwnersRef.current,
              requestSessionId,
              "foreground",
              foregroundStreamGeneration,
              abortController,
            )
          );
        };
        delete sessionAbortControllersRef.current[requestSessionId];
        if (
          ownsSessionStreamOwner(
            sessionStreamOwnersRef.current,
            requestSessionId,
            "foreground",
            foregroundStreamGeneration,
            abortController,
          )
        ) {
          delete sessionStreamOwnersRef.current[requestSessionId];
        }
        streamCommitRegistryRef.current.clearSession(requestSessionId);
        const ended = sessionStreamStateRef.current[requestSessionId];
        if (ended) {
          ended.active = false;
          ended.text = "";
          sessionStreamStateRef.current[requestSessionId] = ended;
        }

        // Peek at the queue BEFORE setting idle state: if there is a follow-up
        // message already queued (e.g. unattended-continuation auto-send), the
        // session is NOT truly "done" — setting idle here would cause a one-frame
        // "已结束 关闭" flash that (a) misleads the user into thinking the task
        // finished and (b) triggers the false-promotion heuristic in StickyTaskBar
        // that marks in_progress todos as completed. When the user switches sessions
        // during that flash and returns, they see the continuation run's partial
        // progress and wonder why the state "regressed" from 5/5 → 4/5.
        // Fix: dequeue first, and skip the idle transition when a follow-up will
        // immediately restart the run (within the same requestAnimationFrame).
        nextQueued = useAppStore.getState().dequeuePaneMessageForSession(
          pane.id,
          requestSessionId,
        ) ?? null;

        if (isTargetSessionStillActive()) {
          const refPatch = referenceExtrasFromTurn(
            turnRefsSnapshot.references,
            turnRefsSnapshot.queries,
          );
          if (refPatch && !abortController.signal.aborted) {
            mergeLastAssistantIfSessionActive(refPatch);
          }
          syncStreamingUiForCurrentSession();
          // Only transition to idle if there is no queued continuation. A queued
          // follow-up means the run will restart in the next animation frame; the
          // "running" state must stay set so the StickyTaskBar does not briefly
          // show "已结束" (and incorrectly promote in_progress todos to completed).
          if (!abortController.signal.aborted && !nextQueued) {
            setSessionExecutionState("idle");
          }
          setStreamReferences([]);
          setStreamSearchedQueries([]);
          streamTextRef.current = "";
        }
        if (isTargetSessionStillActive()) {
          setGroupTyping({});
          setGroupActivityHint({});
          setGroupMemberPhase({});
        }
        const displayedSessionId =
          useAppStore.getState().panes.find((item) => item.id === pane.id)?.sessionId?.trim() ?? "";
        if (displayedSessionId === requestSessionId) {
          contextFilesRef.current = {};
          setContextFiles({});
        }
        if (!abortController.signal.aborted) {
          useAppStore.getState().clearSessionHistoryHint(requestSessionId);
        }
        invalidateSessionTail(requestSessionId);
        useAppStore.getState().dropCachedSessionMessages(requestSessionId);
        void mergeTailFromDisk(requestSessionId, {
          isCurrentOwner: ownsForegroundFinalMerge,
        });
      }

      if (stillOwnsStream) {
        if (abortRef.current === abortController) {
          abortRef.current = null;
        }
        if (isTargetSessionStillActive()) cancelStreamRenderFrame();
        useAppStore.getState().bumpSessionCatalogRevision();
        window.setTimeout(() => useAppStore.getState().bumpSessionCatalogRevision(), 500);

        if (nextQueued && isTargetSessionStillActive()) {
          requestAnimationFrame(() => {
            void sendChatRef.current(nextQueued!.text, {
              lockedSessionId: requestSessionId,
              retryAttachments: nextQueued!.attachments,
              queueDrain: true,
            });
          });
        } else if (nextQueued) {
          // A may finish after the user navigates to B. Preserve the queued
          // A message instead of replaying it through B's current pane.
          enqueuePaneMessage(pane.id, nextQueued);
        }
      }
    }
  };

  sendChatRef.current = sendChat;

  const forwardAutoReply = useAppStore((s) => s.forwardAutoReply);
  useEffect(() => {
    if (!forwardAutoReply) return;
    if (forwardAutoReply.paneId !== paneId) return;
    if ((pane.sessionId || "").trim() !== forwardAutoReply.sessionId.trim()) return;
    useAppStore.getState().setForwardAutoReply(null);
    void sendChatRef.current(forwardAutoReply.text, {
      lockedSessionId: forwardAutoReply.sessionId,
      suppressUserEcho: forwardAutoReply.suppressUserEcho ?? true,
      skipUserHistory: forwardAutoReply.skipUserHistory ?? true,
    });
  }, [forwardAutoReply, paneId, pane.sessionId]);

  const initSession = async (inherit = false, prevSessionId?: string) => {
    const avatarId = sessionCreateAvatarId(pane.avatarId);
    const pendingMode = peekPanePendingSessionMode(pane.id) ?? pane.sessionMode ?? "daily_office";
    try {
      const result = await window.agenticxDesktop.createSession({
        avatar_id: avatarId,
        session_mode: pendingMode,
        permission_mode: runMode,
        ...(inherit && prevSessionId ? { inherit_from_session_id: prevSessionId } : {}),
        ...(chatProvider && chatModel ? { provider: chatProvider, model: chatModel } : {}),
      });
      if (result.ok && result.session_id) {
        migrateActiveComposerDraftToSession(result.session_id);
        freshlyCreatedSessionRef.current = result.session_id;
        setSessionRunMode(
          result.session_id,
          normalizeRunMode(result.permission_mode ?? runMode),
        );
        clearPendingSessionRunMode(pane.id);
        setPaneSessionId(pane.id, result.session_id, {
          provider: chatProvider || undefined,
          model: chatModel || undefined,
        });
        setPaneSessionMode(pane.id, result.session_mode ?? pendingMode);
        clearPanePendingSessionMode(pane.id);
        clearPaneAwaitingFreshSession(pane.id);
        if (result.inherited) {
          setPaneContextInherited(pane.id, true);
        }
        useAppStore.getState().bumpSessionCatalogRevision();
        window.setTimeout(() => useAppStore.getState().bumpSessionCatalogRevision(), 450);
        return;
      }
      console.error("[ChatPane] createSession returned error:", result.error);
    } catch (err) {
      console.error("[ChatPane] createSession threw:", err);
    }
    clearPaneAwaitingFreshSession(pane.id);
    if (prevSessionId) {
      setPaneSessionId(pane.id, prevSessionId);
      setPaneContextInherited(pane.id, false);
    }
    addPaneMessage(pane.id, "tool", "⚠️ 会话创建失败，已恢复上一会话。请检查后端服务是否正常。", "meta");
  };

  const createNewTopic = (
    inherit = true,
    sessionMode: PaneSessionMode = "daily_office",
    initialDraft = "",
  ) => {
    const prevSessionId = (pane.sessionId || "").trim();
    activateFreshComposerDraft(initialDraft);
    // 用户主动新建会话时，不应强制中断旧会话流：旧会话允许后台继续执行。
    // 发送锁在 sendChat 里会基于 isPaneAwaitingFreshSession 进行抢占释放。
    clearPaneMessages(pane.id);
    setPaneContextInherited(pane.id, false);
    setPanePendingSessionMode(pane.id, sessionMode);
    setPendingSessionRunMode(pane.id, runMode);
    setPaneSessionMode(pane.id, sessionMode);
    setKbRetrievalModeForPane("", pane.id, kbNewSessionDefaultRef.current);
    // Mark this pane as explicitly awaiting a brand-new session, so
    // WorkspacePanel's auto-restore effect will not snap it back to the
    // previously-running session (which would trap new messages in the
    // running session's queue).
    markPaneAwaitingFreshSession(pane.id);
    setPaneSessionId(pane.id, "");
    setPaneLazyInheritParent(pane.id, inherit && prevSessionId ? prevSessionId : undefined);
    if (isGroupPane || isAutomationTaskPane) {
      // Group/automation UI requires a bound session_id (no lazy empty composer).
      // Eager create with the pane's group:/automation: avatar_id.
      void initSession(inherit, prevSessionId || undefined);
      return;
    }
    // Meta/avatar: defer createSession until the first send so an empty session
    // never appears in the history sidebar with an id-only title.
  };

  resumeInNewSessionRef.current = () => {
    const draft = buildBudgetResumeDraft(pane.messages ?? []);
    createNewTopic(false, pane.sessionMode ?? "daily_office", draft);
    setBudgetExceededInfo(null);
  };

  // "新建任务" nav button dispatches this event to start a fresh conversation
  // in the targeted (meta) pane. Use a ref so the listener always calls the
  // latest createNewTopic closure without re-subscribing each render.
  const createNewTopicRef = useRef(createNewTopic);
  createNewTopicRef.current = createNewTopic;
  useEffect(() => {
    const startNewTopic = (draftText = "") => {
      createNewTopicRef.current(
        false,
        pane.sessionMode ?? "daily_office",
        draftText,
      );
    };
    const onNewTopic = (e: Event) => {
      const detail = (e as CustomEvent).detail as {
        paneId?: string;
        draftText?: string;
        newTopicRequestId?: string;
      } | undefined;
      if (detail?.paneId && detail.paneId !== pane.id) return;
      if (detail?.newTopicRequestId) {
        const pending = takePaneNewTopicRequest(
          pane.id,
          detail.newTopicRequestId,
        );
        if (!pending) return;
        startNewTopic(pending.draftText);
        return;
      }
      startNewTopic(detail?.draftText ?? "");
    };
    window.addEventListener("agenticx:pane:new-topic", onNewTopic);
    // Landing pages unmount PaneManager, so their wake-up event may have fired
    // before this listener existed. Consume the durable one-shot intent now.
    const pending = takePaneNewTopicRequest(pane.id);
    if (pending) startNewTopic(pending.draftText);
    return () => window.removeEventListener("agenticx:pane:new-topic", onNewTopic);
  }, [pane.id, pane.sessionMode]);

  const insertGlobalSearchFileReference = useCallback(
    async (filePath: string, mode: "current" | "new") => {
      const trimmed = filePath.trim();
      if (!trimmed) return;

      if (mode === "new") {
        activateFreshComposerDraft();
        clearPaneMessages(pane.id);
        setPaneContextInherited(pane.id, false);
        setPaneSessionId(pane.id, "");
        clearPaneAwaitingFreshSession(pane.id);
        markPaneAwaitingFreshSession(pane.id);
      }

      const fileName = fileNameFromPath(trimmed);
      let content = `[文件引用] ${trimmed}`;
      try {
        const preview = await window.agenticxDesktop.systemSearchPreview(trimmed);
        if (preview.ok) {
          if (preview.kind === "text" && preview.content) {
            content = preview.content.slice(0, TEXT_ATTACHMENT_LIMIT);
          } else if (preview.kind === "metadata" && preview.content) {
            content = preview.content.slice(0, TEXT_ATTACHMENT_LIMIT);
          } else if (preview.kind === "image") {
            content = `[图片: ${fileName}]`;
          }
        }
      } catch {
        // keep fallback content
      }

      setContextFiles((prev) => ({
        ...prev,
        [trimmed]: {
          name: fileName,
          size: content.length,
          mimeType: "text/plain",
          status: "ready",
          content,
          sourcePath: trimmed,
          composerRefLabel: fileName,
          referenceToken: true,
        },
      }));

      const base = mode === "new" ? "" : extractComposerText();
      const { next, tokenNames } = buildFileMentionAppend(base, fileName);
      setComposerText(next, {
        tokenNames,
        refSourcePaths: { [fileName]: trimmed },
      });
      focusComposerEnd();
    },
    [
      activateFreshComposerDraft,
      clearPaneMessages,
      extractComposerText,
      focusComposerEnd,
      initSession,
      pane.id,
      setComposerText,
      setPaneContextInherited,
      setPaneSessionId,
    ]
  );

  useEffect(() => {
    const onReference = (event: Event) => {
      const detail = (event as CustomEvent<GlobalSearchReferenceFileDetail>).detail;
      if (!detail || detail.paneId !== pane.id) return;
      void insertGlobalSearchFileReference(detail.filePath, detail.mode);
    };
    const onWorkspaceAdded = (event: Event) => {
      const detail = (event as CustomEvent<{ paneId?: string }>).detail;
      if (!detail?.paneId || detail.paneId !== pane.id) return;
      setTaskspaceAutoRefreshKey((k) => k + 1);
    };
    window.addEventListener(GLOBAL_SEARCH_REFERENCE_FILE, onReference);
    window.addEventListener(GLOBAL_SEARCH_WORKSPACE_ADDED, onWorkspaceAdded);
    return () => {
      window.removeEventListener(GLOBAL_SEARCH_REFERENCE_FILE, onReference);
      window.removeEventListener(GLOBAL_SEARCH_WORKSPACE_ADDED, onWorkspaceAdded);
    };
  }, [insertGlobalSearchFileReference, pane.id]);

  const maxTaskspaceWidth =
    paneWidth > 0
      ? Math.max(
          240,
          Math.min(
            Math.floor(paneWidth * TASKSPACE_MAX_WIDTH_RATIO),
            paneWidth - CHAT_COLUMN_MIN_WIDTH,
          ),
        )
      : 720;
  const minTaskspaceWidth = 220;
  /**
   * Trae Work expand: work panel becomes the main canvas (flex-1);
   * chat collapses to a floating bottom composer — not a squeezed left column.
   */
  const workExpandedLayout = workPanelExpanded && workspacePanelOpen;
  const maxSpawnsWidth = paneWidth > 0 ? Math.max(240, Math.floor(paneWidth * 0.42)) : 420;
  const minSpawnsWidth = 220;
  const minRunDrawerWidth = 280;
  const maxRunDrawerWidth = paneWidth > 0 ? Math.max(320, Math.floor(paneWidth * 0.48)) : 480;
  const maxHistoryWidth = paneWidth > 0 ? Math.max(220, Math.floor(paneWidth * 0.35)) : 360;
  const minHistoryWidth = 200;

  const compactSidePanels = paneWidth > 0 && paneWidth < CHATPANE_SIDE_OVERLAY_BREAK;
  const clampOverlayAside = (preferred: number, minPx: number) =>
    paneWidth > 0
      ? Math.min(Math.max(preferred, minPx), Math.max(Math.floor(paneWidth * 0.94), minPx))
      : preferred;
  const overlayTaskspaceWidth = clampOverlayAside(taskspaceWidth, minTaskspaceWidth);
  const overlayHistoryWidth = clampOverlayAside(historyWidth, minHistoryWidth);
  const overlaySpawnsWidth = clampOverlayAside(spawnsWidth, minSpawnsWidth);
  const overlayRunDrawerWidth = clampOverlayAside(runDrawerWidth, minRunDrawerWidth);

  useEffect(() => {
    setTaskspaceWidth((prev) => {
      const next = Math.min(maxTaskspaceWidth, Math.max(minTaskspaceWidth, prev));
      return next === prev ? prev : next;
    });
  }, [maxTaskspaceWidth, minTaskspaceWidth]);

  useEffect(() => {
    setSpawnsWidth((prev) => {
      const next = Math.min(maxSpawnsWidth, Math.max(minSpawnsWidth, prev));
      return next === prev ? prev : next;
    });
  }, [maxSpawnsWidth, minSpawnsWidth]);

  useEffect(() => {
    setRunDrawerWidth((prev) => {
      const next = Math.min(maxRunDrawerWidth, Math.max(minRunDrawerWidth, prev));
      return next === prev ? prev : next;
    });
  }, [maxRunDrawerWidth, minRunDrawerWidth]);

  useEffect(() => {
    setHistoryWidth((prev) => {
      const next = Math.min(maxHistoryWidth, Math.max(minHistoryWidth, prev));
      return next === prev ? prev : next;
    });
  }, [maxHistoryWidth, minHistoryWidth]);

  useEffect(() => {
    try {
      window.localStorage.setItem(TASKSPACE_WIDTH_STORAGE_KEY, String(taskspaceWidth));
    } catch {
      // ignore storage access failures
    }
  }, [taskspaceWidth]);

  useEffect(() => {
    try {
      window.localStorage.setItem(SPAWNS_WIDTH_STORAGE_KEY, String(spawnsWidth));
    } catch {
      // ignore storage access failures
    }
  }, [spawnsWidth]);

  useEffect(() => {
    try {
      window.localStorage.setItem(RUN_DRAWER_WIDTH_STORAGE_KEY, String(runDrawerWidth));
    } catch {
      // ignore storage access failures
    }
  }, [runDrawerWidth]);

  useEffect(() => {
    try {
      window.localStorage.setItem("agx-history-width-v1", String(historyWidth));
    } catch {
      // ignore
    }
  }, [historyWidth]);

  const startResizeHistory = (event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = historyWidth;
    const onMove = (moveEvent: MouseEvent) => {
      const delta = startX - moveEvent.clientX;
      const next = Math.max(minHistoryWidth, Math.min(maxHistoryWidth, startWidth + delta));
      setHistoryWidth(next);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };


  const startResizeTaskspace = (event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = taskspaceWidth;
    const onMove = (moveEvent: MouseEvent) => {
      const delta = startX - moveEvent.clientX;
      const next = Math.max(minTaskspaceWidth, Math.min(maxTaskspaceWidth, startWidth + delta));
      setTaskspaceWidth(next);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const startResizeSpawns = (event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = spawnsWidth;
    const onMove = (moveEvent: MouseEvent) => {
      const delta = startX - moveEvent.clientX;
      const next = Math.max(minSpawnsWidth, Math.min(maxSpawnsWidth, startWidth + delta));
      setSpawnsWidth(next);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const startResizeRunDrawer = (event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = runDrawerWidth;
    const onMove = (moveEvent: MouseEvent) => {
      const delta = startX - moveEvent.clientX;
      const next = Math.max(minRunDrawerWidth, Math.min(maxRunDrawerWidth, startWidth + delta));
      setRunDrawerWidth(next);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const cancelPaneSubAgent = async (agentId: string) => {
    if (!apiBase || !apiToken || !pane.sessionId) return;
    const sub = subAgents.find((item) => item.id === agentId);
    const targetSessionId = (sub?.sessionId ?? pane.sessionId).trim() || pane.sessionId;
    updateSubAgent(agentId, { status: "cancelled", currentAction: "用户请求中断..." });
    try {
      const resp = await fetch(`${apiBase}/api/subagent/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-agx-desktop-token": apiToken },
        body: JSON.stringify({ session_id: targetSessionId, agent_id: agentId }),
      });
      if (!resp.ok) throw new Error(await resp.text());
      addSubAgentEvent(agentId, { type: "cancel", content: "已发送中断请求" });
    } catch (err) {
      updateSubAgent(agentId, { status: "cancelled", currentAction: "中断请求失败（后端未找到该任务）" });
      addSubAgentEvent(agentId, { type: "error", content: `中断请求失败: ${String(err)}` });
    }
  };

  const retryPaneSubAgent = async (agentId: string) => {
    if (!apiBase || !apiToken || !pane.sessionId) return;
    const sub = subAgents.find((item) => item.id === agentId);
    const targetSessionId = (sub?.sessionId ?? pane.sessionId).trim() || pane.sessionId;
    updateSubAgent(agentId, {
      status: "pending",
      currentAction: "正在重试...",
      resultSummary: "",
      resultFile: undefined,
      liveOutput: "",
      outputFiles: [],
      // Reset the activity timeline so the retry run starts from a clean log
      // instead of stacking on top of the previous attempt's events.
      events: [],
    });
    try {
      const resp = await fetch(`${apiBase}/api/subagent/retry`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-agx-desktop-token": apiToken },
        body: JSON.stringify({
          session_id: targetSessionId,
          agent_id: agentId,
          // Send the (possibly edited) task so backend re-runs with the latest
          // instruction instead of the original one.
          ...(sub?.task?.trim() ? { task: sub.task.trim() } : {}),
          ...(sub?.provider ? { provider: sub.provider } : {}),
          ...(sub?.model ? { model: sub.model } : {}),
        }),
      });
      if (!resp.ok) throw new Error(await resp.text());
      addSubAgentEvent(agentId, { type: "retry", content: "已发送重试请求" });
    } catch (err) {
      updateSubAgent(agentId, { status: "failed", currentAction: "重试失败" });
      addSubAgentEvent(agentId, { type: "error", content: `重试失败: ${String(err)}` });
    }
  };

  const changePaneSubAgentModel = async (agentId: string, provider: string, model: string) => {
    if (!apiBase || !apiToken || !pane.sessionId) return;
    const sub = subAgents.find((item) => item.id === agentId);
    const targetSessionId = (sub?.sessionId ?? pane.sessionId).trim() || pane.sessionId;
    updateSubAgent(agentId, { provider, model });
    try {
      const resp = await fetch(`${apiBase}/api/subagent/model`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-agx-desktop-token": apiToken },
        body: JSON.stringify({
          session_id: targetSessionId,
          agent_id: agentId,
          provider,
          model,
        }),
      });
      if (!resp.ok) throw new Error(await resp.text());
      addSubAgentEvent(agentId, {
        type: "model_changed",
        content: `已切换模型：${formatModelOptionLabel(provider, model, settings.providers[provider])}`,
      });
    } catch (err) {
      addSubAgentEvent(agentId, { type: "error", content: `切换模型失败: ${String(err)}` });
    }
  };

  const resolvePaneSubAgentConfirm = async (agentId: string, approved: boolean) => {
    if (!apiBase || !apiToken || !pane.sessionId) return;
    const sub = subAgents.find((item) => item.id === agentId);
    if (!sub?.pendingConfirm) return;
    const targetSessionId = (sub.pendingConfirm.sessionId ?? pane.sessionId).trim() || pane.sessionId;
    updateSubAgent(agentId, {
      status: approved ? "running" : "cancelled",
      currentAction: approved ? "确认通过，继续执行" : "确认拒绝，执行终止",
      pendingConfirm: undefined,
    });
    addSubAgentEvent(agentId, {
      type: "confirm_response",
      content: approved ? "用户确认通过" : "用户确认拒绝",
    });
    try {
      await fetch(`${apiBase}/api/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-agx-desktop-token": apiToken },
        body: JSON.stringify({
          session_id: targetSessionId,
          request_id: sub.pendingConfirm.requestId,
          approved,
          agent_id: agentId,
        }),
      });
    } catch {
      // confirm POST failure is non-fatal for UI
    }
  };

  async function resolveGroupInlineConfirm(confirm: PendingConfirm, approved: boolean) {
    if (!apiBase || !apiToken || !pane.sessionId) return;
    const targetSessionId = (confirm.sessionId ?? pane.sessionId).trim() || pane.sessionId;
    setPaneMessages(
      pane.id,
      visibleMessages.map((msg) => {
        if (msg.inlineConfirm?.requestId !== confirm.requestId) return msg;
        return { ...msg, inlineConfirm: undefined };
      })
    );
    try {
      await fetch(`${apiBase}/api/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-agx-desktop-token": apiToken },
        body: JSON.stringify({
          session_id: targetSessionId,
          request_id: confirm.requestId,
          approved,
          agent_id: confirm.agentId,
        }),
      });
    } catch {
      // confirm POST failure is non-fatal for UI
    }
  }

  async function resolveActionConfirmation(
    confirmation: PendingActionConfirmation,
    decision: ActionConfirmationDecision,
    _source: "button" | "manual" = "button",
  ): Promise<void> {
    if (!apiBase || !apiToken) return;
    const paneSessionId = (pane.sessionId || "").trim();
    if (!paneSessionId || paneSessionId !== String(confirmation.sessionId || "").trim()) return;

    const patchAction = (status: PendingActionConfirmation["status"], error?: string) => {
      const pan = useAppStore.getState().panes.find((p) => p.id === pane.id);
      if (!pan) return;
      setPaneMessages(
        pane.id,
        (pan.messages ?? []).map((msg) => {
          if (msg.actionConfirmation?.requestId !== confirmation.requestId) return msg;
          return {
            ...msg,
            actionConfirmation: {
              ...msg.actionConfirmation!,
              status,
              ...(error !== undefined ? { error } : { error: undefined }),
            },
            ...(status === "approved" || status === "rejected" || status === "expired"
              ? { toolStatus: "done" as const }
              : {}),
          };
        }),
      );
    };

    const current = (useAppStore.getState().panes.find((p) => p.id === pane.id)?.messages ?? []).find(
      (m) => m.actionConfirmation?.requestId === confirmation.requestId,
    )?.actionConfirmation;
    if (!current || current.status === "resolving" || current.status === "approved" || current.status === "rejected") {
      return;
    }
    if (current.status === "uncertain" || current.status === "expired") return;

    patchAction("resolving");
    const answer = buildActionConfirmationAnswer(confirmation, decision);
    try {
      const res = await fetch(`${apiBase}/api/clarify`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-agx-desktop-token": apiToken },
        body: JSON.stringify({
          session_id: confirmation.sessionId,
          request_id: confirmation.requestId,
          agent_id: confirmation.agentId || "meta",
          answer_text: answer.answerText,
          selected_options: answer.selectedOptions,
        }),
      });
      if (res.status === 404) {
        patchAction("expired", "确认请求已失效或不存在");
        return;
      }
      if (!res.ok) {
        patchAction("uncertain", `确认提交失败（HTTP ${res.status}）`);
        return;
      }
      patchAction(decision === "approved" ? "approved" : "rejected");
      useAppStore.getState().markClarificationAnswered(confirmation.requestId, answer);
    } catch {
      patchAction("uncertain", "网络异常，请求可能已送达");
    }
  }

  const paneTint = (() => {
    if (!pane.avatarId) return undefined;
    // Group chat: same as Meta — page surface, no per-group tint wash.
    if (pane.avatarId.startsWith("group:")) return undefined;
    const avatarColor = avatars.find((a) => a.id === pane.avatarId)?.color;
    return avatarTintBg(pane.avatarId, avatarColor);
  })();

  useEffect(() => {
    // 历史面板已改为不挤占布局的锚定浮层（不再计入互斥占位），此处仅在工作区/记忆图谱/
    // 运行图/Spawns/落盘 drawer 之间做单选互斥（窄窗格 overlay 模式）。
    // 群成员已迁入工作台 tab，不再占用独立右侧面板。
    if (!compactSidePanels) return;
    const p = pane;
    const stacked =
      Number(!!p.taskspacePanelOpen) +
      Number(!!p.memoryGraphOpen) +
      Number(!!p.graphPanelOpen) +
      Number(!!p.spawnsColumnOpen) +
      Number(!!p.runDrawerOpen);
    if (stacked <= 1) return;
    let keep:
      | "workspace"
      | "memory-graph"
      | "graph"
      | "spawns"
      | "run-drawer" = "run-drawer";
    if (p.runDrawerOpen) keep = "run-drawer";
    else if (p.graphPanelOpen) keep = "graph";
    else if (p.taskspacePanelOpen) keep = "workspace";
    else if (p.memoryGraphOpen) keep = "memory-graph";
    else keep = "spawns";
    const desired = {
      taskspacePanelOpen: keep === "workspace",
      memoryGraphOpen: keep === "memory-graph",
      graphPanelOpen: keep === "graph",
      spawnsColumnOpen: keep === "spawns",
      runDrawerOpen: keep === "run-drawer",
    };
    useAppStore.setState((s) => {
      const row = s.panes.find((r) => r.id === p.id);
      if (!row) return s;
      if (
        row.taskspacePanelOpen === desired.taskspacePanelOpen &&
        row.memoryGraphOpen === desired.memoryGraphOpen &&
        !!row.graphPanelOpen === desired.graphPanelOpen &&
        row.spawnsColumnOpen === desired.spawnsColumnOpen &&
        row.runDrawerOpen === desired.runDrawerOpen
      ) {
        return s;
      }
      return {
        panes: s.panes.map((r) => (r.id !== p.id ? r : { ...r, ...desired })),
      };
    });
  }, [
    compactSidePanels,
    pane.id,
    pane.taskspacePanelOpen,
    pane.memoryGraphOpen,
    pane.graphPanelOpen,
    pane.spawnsColumnOpen,
    pane.runDrawerOpen,
  ]);

  const dismissAuxiliaryOverlays = () => {
    useAppStore.setState((s) => ({
      panes: s.panes.map((row) =>
        row.id !== pane.id
          ? row
          : {
              ...row,
              taskspacePanelOpen: false,
              historyOpen: false,
              memoryGraphOpen: false,
              membersPanelOpen: false,
              graphPanelOpen: false,
              spawnsColumnOpen: false,
              runDrawerOpen: false,
            }
      ),
    }));
  };

  const closeRunDrawerPanelOnly = () => {
    closeRunDrawer(pane.id);
  };

  const closeMemoryGraphPanelOnly = () => {
    useAppStore.setState((s) => ({
      panes: s.panes.map((row) => (row.id !== pane.id ? row : { ...row, memoryGraphOpen: false })),
    }));
  };

  const closeWorkspacePanelOnly = () => {
    setWorkPanelExpanded(false);
    useAppStore.setState((s) => ({
      panes: s.panes.map((row) => (row.id !== pane.id ? row : { ...row, taskspacePanelOpen: false })),
    }));
  };

  const toggleWorkPanelExpand = () => {
    setWorkPanelExpanded((prev) => !prev);
  };

  const closeHistoryPanelOnly = () => {
    useAppStore.setState((s) => ({
      panes: s.panes.map((row) => (row.id !== pane.id ? row : { ...row, historyOpen: false })),
    }));
    setHistoryAnchorRect(null);
  };

  const toggleWorkspaceSidePanel = () => {
    if (!compactSidePanels) {
      if (!pane.taskspacePanelOpen) closeHistoryPanelOnly();
      else setWorkPanelExpanded(false);
      cycleSidePanel(pane.id, "workspace");
      return;
    }
    const opening = !pane.taskspacePanelOpen;
    if (!opening) setWorkPanelExpanded(false);
    useAppStore.setState((s) => ({
      panes: s.panes.map((p) => {
        if (p.id !== pane.id) return p;
        return opening
          ? {
              ...p,
              taskspacePanelOpen: true,
              sidePanelTab: "workspace",
              historyOpen: false,
              memoryGraphOpen: false,
              membersPanelOpen: false,
              graphPanelOpen: false,
              spawnsColumnOpen: false,
            }
          : { ...p, taskspacePanelOpen: false };
      }),
    }));
  };

  /** Trae-aligned: ⌘⌃B toggles the work expansion panel for the active pane. */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        !(event.key === "b" || event.key === "B") ||
        !event.metaKey ||
        !event.ctrlKey ||
        event.altKey ||
        event.shiftKey
      ) {
        return;
      }
      const activePaneId = useAppStore.getState().activePaneId;
      if (activePaneId !== pane.id) return;
      event.preventDefault();
      const current = useAppStore.getState().panes.find((p) => p.id === pane.id);
      if (!current) return;
      const paneOuter = paneRef.current?.clientWidth ?? 0;
      const compact = paneOuter > 0 && paneOuter < CHATPANE_SIDE_OVERLAY_BREAK;
      if (!compact) {
        if (!current.taskspacePanelOpen) {
          useAppStore.setState((s) => ({
            panes: s.panes.map((row) =>
              row.id !== pane.id ? row : { ...row, historyOpen: false }
            ),
          }));
        } else {
          setWorkPanelExpanded(false);
        }
        useAppStore.getState().cycleSidePanel(pane.id, "workspace");
        return;
      }
      const opening = !current.taskspacePanelOpen;
      if (!opening) setWorkPanelExpanded(false);
      useAppStore.setState((s) => ({
        panes: s.panes.map((p) => {
          if (p.id !== pane.id) return p;
          return opening
            ? {
                ...p,
                taskspacePanelOpen: true,
                sidePanelTab: "workspace" as const,
                historyOpen: false,
                memoryGraphOpen: false,
                membersPanelOpen: false,
                graphPanelOpen: false,
                spawnsColumnOpen: false,
              }
            : { ...p, taskspacePanelOpen: false };
        }),
      }));
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [pane.id]);

  const toggleHistorySidePanel = () => {
    const opening = !pane.historyOpen;
    if (opening && historyButtonRef.current) {
      setHistoryAnchorRect(historyButtonRef.current.getBoundingClientRect());
    } else if (!opening) {
      setHistoryAnchorRect(null);
    }
    togglePaneHistory(pane.id);
  };

  // 窗口尺寸变化后锚点坐标会过期，直接收起浮层比重新定位更简单可靠。
  useEffect(() => {
    if (!pane.historyOpen) return;
    const onResize = () => closeHistoryPanelOnly();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [pane.historyOpen]);

  const integratedToolbarNode = integratedToolbar && focused ? (
    <div className="agx-pane-toolbar agx-pane-toolbar--integrated relative flex shrink-0 items-center justify-between gap-3 px-4">
      <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
        {onToggleSidebar ? (
          <div className="agx-topbar-left shrink-0">
            <TopbarContextControls
              sidebarCollapsed={sidebarCollapsed}
              onToggleSidebar={onToggleSidebar}
            />
          </div>
        ) : null}
        {pane.contextInherited ? (
          <span className="shrink-0 rounded bg-emerald-500/20 px-1 text-[10px] text-emerald-400">
            已继承
          </span>
        ) : null}
      </div>
      <div className="agx-pane-toolbar-actions no-drag flex shrink-0 items-center gap-1">
        {sessionFindOpen ? (
          <div
            className="agx-pane-session-find flex h-8 items-center gap-1 rounded-lg border border-border bg-surface-card px-1.5 shadow-sm"
            role="search"
            aria-label="会话内搜索"
          >
            <TextSearch className="ml-0.5 h-3.5 w-3.5 shrink-0 text-text-faint" strokeWidth={1.8} />
            <input
              ref={sessionFindInputRef}
              type="search"
              value={sessionFindQuery}
              onChange={(event) => {
                sessionFindActiveIndexRef.current = 0;
                setSessionFindMatchIndex(0);
                setSessionFindQuery(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  stepSessionFindMatch(event.shiftKey ? -1 : 1);
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  closeSessionFind();
                }
              }}
              placeholder="搜索…"
              className="w-[112px] bg-transparent text-[12px] text-text-strong outline-none placeholder:text-text-faint"
              aria-label="在当前会话中搜索"
            />
            <span className="min-w-[2.25rem] shrink-0 text-center text-[11px] tabular-nums text-text-faint">
              {sessionFindQuery.trim()
                ? sessionFindMatchCount > 0
                  ? `${sessionFindMatchIndex + 1}/${sessionFindMatchCount}`
                  : "0/0"
                : ""}
            </span>
            <button
              type="button"
              className="rounded p-0.5 text-text-faint transition hover:bg-surface-hover hover:text-text-strong disabled:opacity-30"
              disabled={sessionFindMatchCount <= 0}
              onClick={() => stepSessionFindMatch(-1)}
              title="上一个匹配"
              aria-label="上一个匹配"
            >
              <ChevronUp className="h-3.5 w-3.5" strokeWidth={2} />
            </button>
            <button
              type="button"
              className="rounded p-0.5 text-text-faint transition hover:bg-surface-hover hover:text-text-strong disabled:opacity-30"
              disabled={sessionFindMatchCount <= 0}
              onClick={() => stepSessionFindMatch(1)}
              title="下一个匹配"
              aria-label="下一个匹配"
            >
              <ChevronDown className="h-3.5 w-3.5" strokeWidth={2} />
            </button>
            <button
              type="button"
              className="rounded p-0.5 text-text-faint transition hover:bg-surface-hover hover:text-text-strong"
              onClick={closeSessionFind}
              title="关闭搜索"
              aria-label="关闭搜索"
            >
              <X className="h-3.5 w-3.5" strokeWidth={2} />
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="agx-topbar-btn !px-[5px]"
            onClick={openSessionFind}
            title={
              typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform)
                ? "会话内搜索 (⌘F)"
                : "会话内搜索 (Ctrl+F)"
            }
            aria-label="会话内搜索"
          >
            <TextSearch className="h-[18px] w-[18px]" strokeWidth={1.8} />
          </button>
        )}
        <button
          ref={historyButtonRef}
          type="button"
          className={`agx-topbar-btn !px-[5px] ${pane.historyOpen ? "agx-topbar-btn--active" : ""}`}
          onClick={toggleHistorySidePanel}
          title="本对话提问目录"
          aria-label="本对话提问目录"
        >
          <ListTree className="h-[18px] w-[18px]" strokeWidth={1.8} />
        </button>
        <HoverTip label="工作台 · ⌘⌃B">
          <button
            type="button"
            className={`agx-topbar-btn !px-[5px] ${workspacePanelOpen ? "agx-topbar-btn--active" : ""}`}
            onClick={toggleWorkspaceSidePanel}
            title="工作台"
            aria-label="工作台"
            aria-pressed={workspacePanelOpen}
          >
            <PanelRight className="h-[18px] w-[18px]" strokeWidth={1.8} />
          </button>
        </HoverTip>
        <span className="mx-1 h-4 w-px shrink-0 bg-border" aria-hidden />
        <TopbarGlobalActions showUsageDashboard={false} />
      </div>
    </div>
  ) : null;

  return (
    <div
      ref={paneRef}
      className={`relative agx-chatpane flex h-full min-w-0 flex-1 bg-surface-base ${
        integratedToolbar ? "flex-col" : ""
      } ${
        workExpandedLayout ? "agx-chatpane--work-expanded" : ""
      }`}
      onMouseDown={onFocus}
    >
      {routingPromptTarget && typeof document !== "undefined"
        ? createPortal(
            <div
              className="fixed inset-0 z-[12000] flex items-center justify-center bg-black/60 p-4"
              role="presentation"
              onMouseDown={(event) => {
                if (event.target === event.currentTarget) {
                  settleAttachmentRoutingChoice("cancel");
                }
              }}
            >
              <div
                role="dialog"
                aria-modal="true"
                aria-labelledby="attachment-routing-title"
                className="w-full max-w-lg rounded-2xl border border-border bg-surface-card p-5 shadow-2xl"
              >
                <div className="flex items-start gap-3">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-amber-500/15 text-amber-400">
                    <ShieldAlert className="h-5 w-5" />
                  </div>
                  <div>
                    <h2 id="attachment-routing-title" className="text-base font-semibold text-text-primary">
                      文档将发送到哪里？
                    </h2>
                    <p className="mt-1 text-sm leading-6 text-text-subtle">
                      企业策略建议使用「{routingPromptTarget.label}」。继续使用当前公网模型会把文档内容发送到企业外部模型服务，并留下审计记录。
                    </p>
                  </div>
                </div>
                <div className="mt-5 grid gap-3 sm:grid-cols-2">
                  <button
                    type="button"
                    className="rounded-xl border border-cyan-400/30 bg-cyan-400/10 p-4 text-left transition-colors hover:bg-cyan-400/15"
                    onClick={() => settleAttachmentRoutingChoice("private")}
                  >
                    <LockKeyhole className="h-5 w-5 text-cyan-300" />
                    <span className="mt-3 block text-sm font-semibold text-text-primary">使用私有模型</span>
                    <span className="mt-1 block text-xs leading-5 text-text-subtle">切换并锁定本会话，文档留在私有环境。</span>
                  </button>
                  <button
                    type="button"
                    className="rounded-xl border border-amber-400/30 bg-amber-400/10 p-4 text-left transition-colors hover:bg-amber-400/15"
                    onClick={() => settleAttachmentRoutingChoice("public")}
                  >
                    <ShieldAlert className="h-5 w-5 text-amber-300" />
                    <span className="mt-3 block text-sm font-semibold text-text-primary">仍使用公网模型</span>
                    <span className="mt-1 block text-xs leading-5 text-text-subtle">按当前模型发送，并记录本次例外选择。</span>
                  </button>
                </div>
                <div className="mt-4 flex justify-end">
                  <button
                    type="button"
                    className="rounded-lg px-3 py-1.5 text-xs text-text-subtle transition-colors hover:bg-surface-hover hover:text-text-primary"
                    onClick={() => settleAttachmentRoutingChoice("cancel")}
                  >
                    取消发送
                  </button>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
      {integratedToolbarNode}
      <div className={integratedToolbar ? "relative flex min-h-0 min-w-0 flex-1" : "contents"}>
      <div
        className={
          workExpandedLayout
            ? "pointer-events-none absolute inset-x-0 bottom-0 z-[60] flex justify-center px-3 pb-3 sm:px-6"
            : "agx-chatpane-main-column flex h-full min-w-0 flex-1 flex-col"
        }
        style={workExpandedLayout ? undefined : { minWidth: CHAT_COLUMN_MIN_WIDTH }}
      >
        <div
          className={
            workExpandedLayout
              ? "pointer-events-auto flex w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-border bg-surface-card/95 shadow-[0_16px_48px_rgba(0,0,0,0.38)] backdrop-blur-xl"
              : "contents"
          }
        >
        {!workExpandedLayout && !integratedToolbar ? (
        <div className="agx-pane-toolbar flex h-10 shrink-0 items-center justify-between px-4">
          <div className="no-drag flex min-w-0 items-center gap-1.5 overflow-hidden">
            {paneSortableListeners ? (
              <span
                className="inline-flex cursor-grab touch-none items-center active:cursor-grabbing"
                {...paneSortableListeners}
                title="拖拽以调整窗格顺序"
              >
                <GripVertical
                  className="h-4 w-4 shrink-0 text-text-faint opacity-50 hover:opacity-90"
                  strokeWidth={1.8}
                  aria-hidden
                />
              </span>
            ) : null}
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-sm font-medium text-text-strong">
                {isGroupPane ? (
                  groupMembers.length > 0 ? (
                    <span className="flex shrink-0 -space-x-1" aria-label="群聊成员">
                      {groupMembers.slice(0, 3).map((member) =>
                        member.id === GROUP_META_MEMBER_ID ? (
                          <GroupMemberAvatar
                            key={member.id}
                            avatar={member}
                            size="xs"
                            className="ring-2 ring-surface-base"
                          />
                        ) : (
                          <button
                            key={member.id}
                            type="button"
                            className="rounded-lg transition hover:z-10 hover:ring-2 hover:ring-[rgba(var(--theme-color-rgb,59,130,246),0.55)] focus:outline-none focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-[rgba(var(--theme-color-rgb,59,130,246),0.65)]"
                            aria-label={`打开${member.name}专家详情`}
                            title={`打开${member.name}专家详情`}
                            onClick={() => handleOpenGroupMember(member.id)}
                          >
                            <GroupMemberAvatar
                              avatar={member}
                              size="xs"
                              className="ring-2 ring-surface-base"
                            />
                          </button>
                        ),
                      )}
                    </span>
                  ) : (
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-[rgba(var(--theme-color-rgb,59,130,246),0.14)] text-[rgb(var(--theme-color-fg-rgb,59,130,246))]" aria-hidden>
                      <UsersRound className="h-3.5 w-3.5" strokeWidth={1.8} />
                    </span>
                  )
                ) : isDedicatedAvatarPane && paneSettingsAvatar ? (
                  <GroupMemberAvatar
                    avatar={paneSettingsAvatar}
                    size="xs"
                    className="ring-1 ring-border"
                  />
                ) : null}
                <span className="shrink-0">{paneAvatarMeta.name}</span>
                {isGroupPane && activeGroup ? (
                  <span className="shrink-0 rounded-full bg-surface-card px-1.5 py-0.5 text-[9px] font-normal text-text-faint">
                    {activeGroup.avatarIds.length} 位成员
                  </span>
                ) : null}
                {(pane.sessionId || "").trim() ? (
                  <span
                    className="select-all font-mono text-[9px] font-normal leading-snug text-text-faint"
                    title="会话 ID（便于排查）"
                  >
                    {(pane.sessionId || "").trim()}
                  </span>
                ) : null}
                {SHOW_DESKTOP_EXTERNAL_IM && shouldShowFeishuBadge && (
                  <FeishuBadge variant="topbar" />
                )}
                {SHOW_DESKTOP_EXTERNAL_IM && shouldShowWechatBadge && (
                  <span
                    className="inline-flex shrink-0 items-center rounded-sm px-1 py-px text-[9px] font-medium leading-tight"
                    style={{ backgroundColor: "rgba(37,211,102,0.15)", color: "#25D366" }}
                  >
                    微信
                  </span>
                )}
              </div>
              {isGroupPane && activeGroup ? (
                <div className="flex items-center gap-1.5 truncate text-[10px] text-text-faint">
                  <span className="text-text-subtle">
                    主持人：{groupHost?.name || "首位成员"}
                  </span>
                  <span aria-hidden>·</span>
                  <span className="flex min-w-0 items-center gap-0.5 truncate">
                    {groupMembers.length > 0
                      ? groupMembers.slice(0, 3).map((member, index) => (
                          <span key={member.id} className="inline-flex min-w-0 items-center">
                            {index > 0 ? <span aria-hidden>、</span> : null}
                            {member.id === GROUP_META_MEMBER_ID ? (
                              <span className="truncate">{member.name}</span>
                            ) : (
                              <button
                                type="button"
                                className="truncate text-left hover:text-text-subtle hover:underline focus:outline-none focus-visible:underline"
                                aria-label={`打开${member.name}专家详情`}
                                onClick={() => handleOpenGroupMember(member.id)}
                              >
                                {member.name}
                              </button>
                            )}
                          </span>
                        ))
                      : "等待加入成员"}
                    {groupMembers.length > 3 ? ` 等 ${groupMembers.length} 人` : ""}
                  </span>
                </div>
              ) : null}
              {pane.contextInherited ? (
                <div className="flex items-center gap-1.5 truncate text-[10px] text-text-faint">
                  <span className="rounded bg-emerald-500/20 px-1 text-emerald-400">已继承</span>
                </div>
              ) : null}
            </div>
          </div>
          <div className="no-drag flex shrink-0 items-center gap-1">
            {SHOW_DESKTOP_MULTI_PANE && !isGroupPane ? (
              <NewTopicButton onNewTopic={createNewTopic} triggerLabel={newTopicLabel} />
            ) : null}
            {sessionFindOpen ? (
              <div
                className="flex h-8 items-center gap-1 rounded-lg border border-border bg-surface-card px-1.5 shadow-sm"
                role="search"
                aria-label="会话内搜索"
              >
                <Search className="ml-0.5 h-3.5 w-3.5 shrink-0 text-text-faint" strokeWidth={1.8} />
                <input
                  ref={sessionFindInputRef}
                  type="search"
                  value={sessionFindQuery}
                  onChange={(e) => {
                    sessionFindActiveIndexRef.current = 0;
                    setSessionFindMatchIndex(0);
                    setSessionFindQuery(e.target.value);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      stepSessionFindMatch(e.shiftKey ? -1 : 1);
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      closeSessionFind();
                    }
                  }}
                  placeholder="搜索…"
                  className="w-[112px] bg-transparent text-[12px] text-text-strong outline-none placeholder:text-text-faint"
                  aria-label="在当前会话中搜索"
                />
                <span className="min-w-[2.25rem] shrink-0 text-center text-[11px] tabular-nums text-text-faint">
                  {sessionFindQuery.trim()
                    ? sessionFindMatchCount > 0
                      ? `${sessionFindMatchIndex + 1}/${sessionFindMatchCount}`
                      : "0/0"
                    : ""}
                </span>
                <button
                  type="button"
                  className="rounded p-0.5 text-text-faint transition hover:bg-surface-hover hover:text-text-strong disabled:opacity-30"
                  disabled={sessionFindMatchCount <= 0}
                  onClick={() => stepSessionFindMatch(-1)}
                  title="上一个匹配"
                  aria-label="上一个匹配"
                >
                  <ChevronUp className="h-3.5 w-3.5" strokeWidth={2} />
                </button>
                <button
                  type="button"
                  className="rounded p-0.5 text-text-faint transition hover:bg-surface-hover hover:text-text-strong disabled:opacity-30"
                  disabled={sessionFindMatchCount <= 0}
                  onClick={() => stepSessionFindMatch(1)}
                  title="下一个匹配"
                  aria-label="下一个匹配"
                >
                  <ChevronDown className="h-3.5 w-3.5" strokeWidth={2} />
                </button>
                <button
                  type="button"
                  className="rounded p-0.5 text-text-faint transition hover:bg-surface-hover hover:text-text-strong"
                  onClick={closeSessionFind}
                  title="关闭搜索"
                  aria-label="关闭搜索"
                >
                  <X className="h-3.5 w-3.5" strokeWidth={2} />
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="agx-topbar-btn !px-[5px]"
                onClick={openSessionFind}
                title={
                  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform)
                    ? "会话内搜索 (⌘F)"
                    : "会话内搜索 (Ctrl+F)"
                }
                aria-label="会话内搜索"
              >
                <TextSearch className="h-[18px] w-[18px]" strokeWidth={1.8} />
              </button>
            )}
            {paneSettingsAvatar ? (
              <button
                type="button"
                className="agx-topbar-btn !px-[5px]"
                onClick={() => setAvatarSettingsOpen(true)}
                title="专家设置"
                aria-label="打开专家设置"
              >
                <Settings className="h-[18px] w-[18px]" strokeWidth={1.8} />
              </button>
            ) : null}
            {VOICE_UI_ENABLED && !isGroupPane && (
              <button
                type="button"
                className="agx-topbar-btn !px-[5px]"
                onClick={() => toggleFocusMode(pane.id)}
                title="灵巧模式 · 实时语音 (⇧⌘F)"
                aria-label="进入灵巧模式"
              >
                <PhoneCall className="h-[18px] w-[18px]" strokeWidth={1.8} />
              </button>
            )}
            <button
              ref={historyButtonRef}
              className={`agx-topbar-btn !px-[5px] ${pane.historyOpen ? "agx-topbar-btn--active" : ""}`}
              onClick={toggleHistorySidePanel}
              title="本对话提问目录"
              aria-label="本对话提问目录"
            >
              <ListTree className="h-[18px] w-[18px]" strokeWidth={1.8} />
            </button>
            <HoverTip label="工作台 · ⌘⌃B">
              <button
                type="button"
                className={`agx-topbar-btn !px-[5px] ${workspacePanelOpen ? "agx-topbar-btn--active" : ""}`}
                onClick={toggleWorkspaceSidePanel}
                title="工作台"
                aria-label="工作台"
                aria-pressed={workspacePanelOpen}
              >
                <PanelRight className="h-[18px] w-[18px]" strokeWidth={1.8} />
              </button>
            </HoverTip>
            <button
              className="agx-topbar-btn !px-[5px] hover:text-status-error"
              onClick={closePaneAndCleanupEmptySession}
              title="关闭窗格"
            >
              <X className="h-[18px] w-[18px]" strokeWidth={1.8} />
            </button>
          </div>
        </div>
        ) : null}

        {!workExpandedLayout ? (
        <>
        <div className="relative min-h-0 min-w-0 flex-1">
          <div
            ref={listRef}
            className="agx-pane-message-list relative h-full min-h-0 min-w-0 overflow-y-auto overflow-x-hidden px-4 py-3"
          >
          {!pane.sessionId && (isGroupPane || isAutomationTaskPane) ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-xs text-text-faint">
              <span className="animate-pulse">正在初始化会话...</span>
              <button
                className="rounded-md border border-border px-3 py-1.5 text-xs text-text-subtle transition hover:bg-surface-hover hover:text-text-strong"
                onClick={() => void initSession(false)}
              >
                重试
              </button>
            </div>
          ) : pane.loadingMessages && pane.sessionId ? (
            <div className="mx-auto flex h-full min-h-0 w-full max-w-4xl flex-col justify-center gap-4 px-2 py-6">
              <div className="text-center text-xs text-text-faint animate-pulse">正在加载会话…</div>
              <div className="flex flex-col gap-3">
                {[0, 1, 2].map((row) => (
                  <div key={row} className="flex animate-pulse gap-2.5">
                    <div className="h-8 w-8 shrink-0 rounded-full bg-surface-hover" />
                    <div
                      className="h-14 flex-1 rounded-xl bg-surface-hover"
                      style={{ maxWidth: row === 1 ? "72%" : "84%" }}
                    />
                  </div>
                ))}
              </div>
            </div>
          ) : (!pane.sessionId && !isGroupPane && !isAutomationTaskPane) ||
            (pane.sessionId && visibleMessages.length === 0) ? (
            isGroupPane && activeGroup ? (
              <GroupChatEmptyState
                group={activeGroup}
                members={groupMembers}
                onOpenMember={handleOpenGroupMember}
              />
            ) : isDedicatedAvatarPane && paneSettingsAvatar ? (
              <ExpertChatEmptyState avatar={paneSettingsAvatar} />
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-5 px-4 text-center text-xs">
                <img
                  src={DEFAULT_META_AVATAR_URL}
                  alt={`${APP_DISPLAY_NAME} Empty State`}
                  className="w-[10.5rem] max-w-[36vw] select-none object-contain drop-shadow-[0_18px_44px_rgba(30,166,214,0.36)]"
                  draggable={false}
                />
                <div className="space-y-2 select-none">
                  <div className="text-[22px] font-semibold text-text-primary tracking-[0.14em]">
                    {APP_DISPLAY_NAME}
                  </div>
                  <div className="text-text-faint tracking-[0.22em] uppercase text-[12px]">
                    {APP_TAGLINE}
                  </div>
                </div>
                {isAutomationTaskPane && automationTaskErrorHint ? (
                  <div className="max-w-md rounded-lg border border-rose-500/35 bg-rose-500/10 px-3 py-2 text-left text-[11px] leading-relaxed text-rose-200/95">
                    <div className="mb-1 font-medium text-rose-300">上次定时执行失败</div>
                    {automationTaskErrorHint}
                  </div>
                ) : null}
              </div>
            )
          ) : (
            <div className="mx-auto flex min-w-0 w-full max-w-4xl flex-col gap-3">
              {pane.loadingOlderMessages || (pane.hasOlderMessages && (pane.oldestLoadedIndex ?? 0) > 0) ? (
                <div className="flex justify-center py-2">
                  {pane.loadingOlderMessages ? (
                    <Loader2 className="h-4 w-4 animate-spin text-text-faint" aria-label="加载更早消息" />
                  ) : (
                    <button
                      type="button"
                      className="text-[11px] text-text-faint transition hover:text-text-subtle"
                      onClick={() => void loadOlderSessionMessages()}
                    >
                      向上滚动加载更早消息
                    </button>
                  )}
                </div>
              ) : null}
              {renderedMessages}
            </div>
          )}
          {SHOW_DESKTOP_RUN_GRAPH && debateNudgeText ? (
            <div className="pointer-events-none absolute inset-x-0 bottom-3 z-30 flex justify-center px-4">
              <div className="pointer-events-auto flex max-w-md items-center gap-2 rounded-lg border border-amber-500/35 bg-surface-card-strong/95 px-3 py-2 text-[11px] text-amber-700 shadow-lg backdrop-blur-sm dark:text-amber-200">
                <span className="min-w-0 flex-1 leading-relaxed">{debateNudgeText}</span>
                <button
                  type="button"
                  className="shrink-0 rounded px-2 py-1 text-[11px] text-white"
                  style={{ background: "var(--ui-btn-primary-bg)" }}
                  onClick={() => {
                    setDebateNudgeText("");
                    openWorkspaceSidebarForPane(
                      pane.id,
                      paneRef.current?.clientWidth ?? paneWidth,
                      openSidePanel,
                    );
                    setWorkPanelFocus({ kind: "graph" });
                  }}
                >
                  打开运行图
                </button>
                <button
                  type="button"
                  className="shrink-0 rounded p-1 text-text-faint hover:bg-surface-hover"
                  aria-label="关闭提示"
                  onClick={() => setDebateNudgeText("")}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          ) : null}
          <Toast
            placement="inline-bottom-center"
            variant="warning"
            open={attachToastOpen}
            message={attachToastMessage}
            onClose={() => setAttachToastOpen(false)}
            timeoutMs={3200}
          />
          </div>

          {showJumpToBottomFab ? (
            <div className="pointer-events-none absolute bottom-3 left-0 right-0 z-30 flex justify-center">
              <button
                type="button"
                className="pointer-events-auto flex h-9 w-9 items-center justify-center rounded-full border border-border bg-surface-card-strong/95 text-text-strong shadow-lg backdrop-blur-sm transition hover:bg-surface-hover"
                aria-label="回到底部"
                title="回到底部"
                onClick={() => {
                  pinChatListToLatestTurn();
                }}
              >
                <ChevronDown className="h-5 w-5" strokeWidth={2.25} aria-hidden />
              </button>
            </div>
          ) : null}
        </div>

        {/* 收藏 Toast：位于消息列表与输入框之间，水平居中 */}
        {favoriteToastOpen && (
          <div className="pointer-events-none flex justify-center px-4 pb-1 pt-1">
            <div className="rounded-lg border border-border bg-surface-card/95 px-3 py-2 text-xs text-text-primary shadow-lg backdrop-blur-sm">
              {favoriteToastMsg}
            </div>
          </div>
        )}
        </>
        ) : null}

        {/* 外层 px 与列表 agx-pane-message-list 一致，内层 max-w-4xl 单独一层，避免「padding 吃进 max-width」导致输入框比气泡窄一截 */}
        <div className={`shrink-0 ${workExpandedLayout ? "px-3 pt-2.5 pb-3" : "px-4 pt-2.5 pb-4"}`}>
          <div
            className={`agx-pane-composer-shell mx-auto min-w-0 w-full ${
              workExpandedLayout ? "max-w-none" : "max-w-4xl"
            }`}
          >
          <StickyTaskBar
            messages={pane.messages ?? []}
            liveness={taskLiveness}
            executionState={sessionExecutionState}
            silentSeconds={silentSeconds}
            onResume={() => void resumeCurrentTask()}
            codeDevMode={false}
            phase={undefined}
            toolBudget={{ used: toolRoundCount, total: toolRoundBudget }}
            readFiles={0}
          />
          {bgCompleteToast ? (
            <div className="pointer-events-none mb-1 flex justify-center">
              <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 text-xs text-emerald-200">
                后台任务已完成
              </div>
            </div>
          ) : null}
          {stallHintToast ? (
            <div className="pointer-events-none mb-1 flex justify-center">
              <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-200 [html[data-theme=light]_&]:border-amber-600/50 [html[data-theme=light]_&]:bg-amber-500/15 [html[data-theme=light]_&]:text-amber-900">
                {stallHintToast}
              </div>
            </div>
          ) : null}
          {selectedSubAgent ? (
            <div className="mb-1 inline-flex items-center gap-2 rounded border border-border bg-surface-card px-2 py-0.5 text-xs text-text-muted">
              对话目标: {selectedSubAgent}
              <button
                className="rounded px-1 hover:bg-surface-hover"
                onClick={() => setSelectedSubAgent(null)}
              >
                切回 Meta
              </button>
            </div>
          ) : null}
          {selectedMessageIds.size > 0 ? (
            <div className="mb-1.5 flex items-center gap-1 rounded-2xl border border-transparent bg-surface-card px-3 py-2 text-xs text-text-muted">
              <span className="mr-1 shrink-0">已多选 {selectedTurnCount} 轮</span>
              <button
                type="button"
                className="rounded-xl px-2 py-1 text-text-strong transition-colors hover:bg-surface-hover"
                onClick={forwardSelectedMessages}
              >
                转发
              </button>
              <button
                ref={shareBtnRef}
                type="button"
                className="rounded-xl px-2 py-1 text-text-strong transition-colors hover:bg-surface-hover"
                aria-expanded={shareMenuOpen}
                aria-haspopup="menu"
                onClick={() => setShareMenuOpen((open) => !open)}
              >
                分享
              </button>
              <button
                type="button"
                className="rounded-xl px-2 py-1 text-rose-300 transition-colors hover:bg-surface-hover"
                onClick={() => void deleteSelectedMessages()}
              >
                删除
              </button>
              <button
                type="button"
                className="rounded-xl px-2 py-1 text-text-strong transition-colors hover:bg-surface-hover"
                onClick={() => setSelectedMessageIds(new Set())}
              >
                取消
              </button>
              {shareMenuOpen && shareBtnRef.current
                ? createPortal(
                    <div
                      ref={shareMenuRef}
                      role="menu"
                      aria-label="分享"
                      className="agx-menu-pop fixed z-[9999] flex min-w-[148px] flex-col gap-0.5 rounded-xl border border-border bg-surface-panel p-1.5 shadow-xl backdrop-blur-xl"
                      style={{
                        left: shareBtnRef.current.getBoundingClientRect().left,
                        bottom: window.innerHeight - shareBtnRef.current.getBoundingClientRect().top + 6,
                      }}
                    >
                      <button
                        type="button"
                        role="menuitem"
                        className="rounded-lg px-2.5 py-2 text-left text-[13px] text-text-strong transition-colors hover:bg-surface-hover"
                        onClick={() => {
                          setShareMenuOpen(false);
                          void shareSelectedAsText();
                        }}
                      >
                        复制文本
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        className="rounded-lg px-2.5 py-2 text-left text-[13px] text-text-strong transition-colors hover:bg-surface-hover"
                        onClick={() => {
                          setShareMenuOpen(false);
                          setShareImageOpen(true);
                        }}
                      >
                        分享为图片
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        className="rounded-lg px-2.5 py-2 text-left text-[13px] text-text-strong transition-colors hover:bg-surface-hover"
                        onClick={() => {
                          setShareMenuOpen(false);
                          void exportSelectedMessagesToPdf();
                        }}
                      >
                        保存为 PDF
                      </button>
                    </div>,
                    document.body,
                  )
                : null}
            </div>
          ) : null}
          <MessageQueuePanel
            messages={queuedMessages}
            onEdit={(id, newText) => editPendingMessage(paneId, id, newText)}
            onRemove={(id) => removePendingMessage(paneId, id)}
            onSendNow={sendQueuedMessageNow}
          />
          {(sessionExecutionState === "running" ||
            stallState === "stall" ||
            sessionHealth === "paused" ||
            sessionUnattended ||
            budgetExceededInfo) && (
            <div className="mb-1 flex flex-wrap items-center gap-2 text-[11px] text-text-muted">
              <span className="rounded-full bg-surface-panel/75 px-2 py-0.5">
                {[
                  !isAutomationTaskPane ? currentModelLabel : null,
                  sessionExecutionState === "running"
                    ? "运行中"
                    : stallState === "stall" && stallReason === "incomplete"
                      ? "未完成"
                      : sessionWorkInProgress
                        ? "处理中"
                        : null,
                  // An ended-incomplete turn is not "running" — suppress the silence
                  // timer so it never reads as "still processing / no response".
                  silentSeconds > 0 &&
                  sessionExecutionState === "running" &&
                  effectiveGroupTeamControlState !== "paused" &&
                  !(stallState === "stall" && stallReason === "incomplete")
                    ? silenceTier === "thinking"
                      ? "正在思考…"
                      : resolveSilenceTierLabel(silenceTier, silentSeconds)
                    : null,
                  lastToolProgress?.name
                    ? `${lastToolProgress.name}${lastToolProgress.sec > 0 ? ` ${lastToolProgress.sec}s` : ""}`
                    : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
              {stallWait ? <StallWaitChip info={stallWait} /> : null}
              {sessionHealth !== "normal" ? (
                <span
                  className={`rounded-full px-2 py-0.5 ${
                    sessionHealth === "stuck"
                      ? "bg-amber-500/15 text-amber-200"
                      : sessionHealth === "paused"
                        ? "bg-emerald-500/15 text-emerald-200"
                      : "bg-surface-panel/75 text-text-muted"
                  }`}
                >
                  健康度：{
                    sessionHealth === "stuck"
                      ? "卡住"
                      : sessionHealth === "paused"
                        ? "暂停等待"
                        : "偏慢"
                  }
                </span>
              ) : null}
              {contextLoopStats ? (
                <span className="rounded-full bg-surface-panel/75 px-2 py-0.5 text-text-muted">
                  context: {(contextLoopStats.tool_result_tokens_session / 1000).toFixed(1)}k ·{" "}
                  {contextLoopStats.round} rounds · {contextLoopStats.archived_tool_calls} archived
                </span>
              ) : null}
              {sessionUnattended && unattendedGlobalEnabled && !budgetExceededInfo ? (
                <span className="rounded-full bg-violet-500/10 px-2 py-0.5 text-violet-200 [html[data-theme=light]_&]:bg-violet-500/15 [html[data-theme=light]_&]:text-violet-900">
                  无人值守 · 续跑 {unattendedContinueCount}/{unattendedMaxContinuations}
                </span>
              ) : null}
              {budgetExceededInfo ? (
                <button
                  type="button"
                  onClick={() => resumeInNewSessionRef.current()}
                  className="rounded-full bg-rose-500/15 px-2 py-0.5 text-rose-200 transition hover:bg-rose-500/25"
                >
                  已达预算上限 · 续跑无效
                </button>
              ) : null}
              {unattendedGlobalEnabled ? (
                <button
                  type="button"
                  onClick={() => void toggleSessionUnattended()}
                  className={`rounded-full px-2 py-0.5 transition outline-none focus-visible:outline-none ${
                    sessionUnattended
                      ? "bg-violet-500/15 text-violet-200 [html[data-theme=light]_&]:bg-violet-500/15 [html[data-theme=light]_&]:text-violet-900"
                      : "bg-surface-panel/75 text-text-muted hover:text-text-strong"
                  }`}
                >
                  {sessionUnattended ? "本会话无人值守：开" : "本会话无人值守：关"}
                </button>
              ) : null}
              {!isStreamingCurrentSession && sessionExecutionState === "running" ? (
                <span className="text-amber-300/90">后台运行中</span>
              ) : null}
            </div>
          )}
          {sessionExecutionState === "running" &&
          effectiveGroupTeamControlState !== "paused" &&
          (silenceTier === "slow" || silenceTier === "stuck") &&
          !(stallState === "stall" && stallReason === "incomplete") ? (
            <div className="mb-2 flex justify-center px-1">
              <div
                className={`inline-flex max-w-full flex-wrap items-center justify-center gap-2 rounded-full border px-3 py-1.5 text-[12px] ${
                  silenceTier === "stuck"
                    ? "border-amber-500/35 bg-amber-500/10 text-amber-100/95"
                    : "border-border bg-surface-panel/80 text-text-muted"
                }`}
              >
                <span>{resolveSilenceTierLabel(silenceTier, silentSeconds)}</span>
                <button
                  type="button"
                  className="rounded-full bg-surface-hover px-2 py-0.5 transition hover:bg-surface-card-strong"
                  onClick={() => void resumeCurrentTask()}
                >
                  立即重试
                </button>
                <button
                  type="button"
                  className="rounded-full bg-surface-hover px-2 py-0.5 transition hover:bg-surface-card-strong"
                  onClick={() => {
                    const fb = stallModelOptions[0] ?? STALL_MODEL_FALLBACKS[0];
                    if (fb) void resumeWithModel(fb.provider, fb.model);
                  }}
                >
                  换模型
                </button>
                <button
                  type="button"
                  className="rounded-full bg-surface-hover px-2 py-0.5 transition hover:bg-surface-card-strong"
                  onClick={() => void stopCurrentRun()}
                >
                  停止
                </button>
                {silenceTier === "stuck" ? (
                  <button
                    type="button"
                    className="rounded-full bg-amber-500/20 px-2 py-0.5 text-amber-100 transition hover:bg-amber-500/30"
                    onClick={() => void takeoverSession()}
                  >
                    我来接管
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}
          {voiceInputHint ? (
            <div className="mb-2 flex justify-center px-1">
              <span className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-amber-500/35 bg-amber-500/10 px-3 py-1 text-[12px] text-amber-100/95">
                <span aria-hidden>!</span>
                <span className="truncate">{voiceInputHint}</span>
              </span>
            </div>
          ) : null}
          <AttachmentRoutingStatusBanner
            lockedTarget={activeAttachmentRoutingLock}
            pendingTarget={pendingAttachmentRoutingTarget}
            pendingAllowsPublic={canChoosePublicAttachmentRoute}
            scopeKey={`${pane.id}:${String(pane.sessionId ?? "new").trim() || "new"}`}
          />
          <div className="agx-pane-composer-body agx-theme-focus-ring relative rounded-2xl border border-transparent bg-surface-card transition-[border-color,box-shadow] duration-200 ease-out">
            <VoicePttOverlay text={pttLiveText} visible={pttActive} />
            {visibleAttachmentEntries.length > 0 ? (
              <div className="flex flex-wrap gap-2 px-3 pt-3">
                {visibleAttachmentEntries.map(([key, file]) => (
                  <AttachmentChip key={key} file={file} onRemove={() => removeAttachment(key)} />
                ))}
              </div>
            ) : null}
            <div className="relative">
              <div className="pointer-events-none absolute right-3 top-2 z-10 flex items-center gap-2">
                {composerExpanded ? (
                  <span className="text-xs text-text-faint">↩ 键可用于换行</span>
                ) : null}
                <button
                  type="button"
                  className="pointer-events-auto inline-flex h-8 w-8 items-center justify-center rounded-xl text-text-faint/55 outline-none transition hover:bg-surface-hover hover:text-text-strong focus:outline-none focus-visible:bg-surface-hover focus-visible:text-text-strong"
                  aria-label={composerExpanded ? "收起输入区" : "展开输入区"}
                  title={composerExpanded ? "收起输入区（Enter 发送）" : "展开输入区（Enter 换行）"}
                  onClick={() => setComposerExpanded((prev) => !prev)}
                >
                  {composerExpanded ? (
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className="h-[15px] w-[15px]">
                      <path d="M9 5H5v4M15 5h4v4M5 15v4h4M19 15v4h-4" />
                    </svg>
                  ) : (
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className="h-[15px] w-[15px]">
                      <path d="M15 5h4v4M9 5H5v4M5 15v4h4M19 15v4h-4" />
                    </svg>
                  )}
                </button>
              </div>
              <div
                ref={composerRef}
              contentEditable
              suppressContentEditableWarning
              onInput={() => {
                syncQuoteTargetsFromComposer();
                if (imeComposingRef.current) {
                  setComposerHasText((prev) => {
                    const next = domTextLooksNonEmpty(composerRef.current?.textContent);
                    return prev === next ? prev : next;
                  });
                  saveComposerCaret();
                  return;
                }
                const live = (composerRef.current?.innerText || "").replace(/\u00a0/g, " ");
                syncComposerFromValue(live, readLiveComposerCaretOffset(live));
                saveComposerCaret();
                scheduleComposerDraftSaveRef.current();
              }}
              onKeyUp={() => {
                saveComposerCaret();
                const live = (composerRef.current?.innerText || "").replace(/\u00a0/g, " ");
                updateAtStateFromText(live, readLiveComposerCaretOffset(live));
              }}
              onMouseUp={() => {
                saveComposerCaret();
                const live = (composerRef.current?.innerText || "").replace(/\u00a0/g, " ");
                updateAtStateFromText(live, readLiveComposerCaretOffset(live));
              }}
              onCompositionStart={() => {
                imeComposingRef.current = true;
              }}
              onCompositionEnd={() => {
                const live = (composerRef.current?.innerText || "").replace(/\u00a0/g, " ");
                syncComposerFromValue(live, readLiveComposerCaretOffset(live));
                saveComposerCaret();
                scheduleComposerDraftSaveRef.current();
                window.setTimeout(() => {
                  imeComposingRef.current = false;
                }, 0);
              }}
              onBlur={() => {
                imeComposingRef.current = false;
              }}
              onDragOver={(e) => {
                if (composerAcceptsDragTypes(e.dataTransfer?.types ?? [])) {
                  e.preventDefault();
                  e.stopPropagation();
                  try {
                    e.dataTransfer.dropEffect = "copy";
                  } catch {}
                }
              }}
              onDragEnter={(e) => {
                if (composerAcceptsDragTypes(e.dataTransfer?.types ?? [])) {
                  e.preventDefault();
                  e.stopPropagation();
                }
              }}
              onDrop={(e) => {
                const dt = e.dataTransfer;
                if (!dt) return;
                const workspaceRaw = dt.getData(NEAR_WORKSPACE_DRAG_MIME);
                if (workspaceRaw) {
                  const entry = decodeNearWorkspaceDragEntry(workspaceRaw);
                  if (entry) {
                    e.preventDefault();
                    e.stopPropagation();
                    void handleWorkspaceDragEntry(entry);
                    return;
                  }
                }
                const files = dt.files ? Array.from(dt.files) : [];
                if (files.length === 0) return;
                e.preventDefault();
                e.stopPropagation();
                let showedVisionToast = false;
                for (const file of files) {
                  if (isImageFile(file) && isKnownNonVisionChatModel(chatProvider, chatModel)) {
                    if (!showedVisionToast) {
                      notifyImageAttach();
                      showedVisionToast = true;
                    }
                    if (visionAttachBlocked) continue;
                  }
                  const key = `${file.name}:${file.size}:${file.lastModified}`;
                  parseLocalFile(file, key);
                }
              }}
              onPaste={(e) => {
                const dt = e.clipboardData;
                const raw = extractClipboardImageFiles(dt);
                const plainText = clipboardPlainTextForPaste(dt);

                if (raw.length > 0) {
                  if (isKnownNonVisionChatModel(chatProvider, chatModel)) {
                    e.preventDefault();
                    notifyImageAttach();
                    if (visionAttachBlocked) return;
                  }
                  e.preventDefault();
                  const files = withClipboardImageNames(raw);
                  if (plainText) {
                    document.execCommand("insertText", false, plainText);
                    syncComposerFromValue(extractComposerSendText());
                    scheduleComposerDraftSaveRef.current();
                  }
                  for (const file of files) {
                    const key = `${file.name}:${file.size}:${file.lastModified}`;
                    parseLocalFile(file, key);
                  }
                  return;
                }

                // 无图片：禁止默认 HTML 粘贴，只插入纯文本，避免黑底/字体等富文本样式。
                if (!plainText.trim()) return;
                e.preventDefault();
                document.execCommand("insertText", false, plainText);
                syncComposerFromValue(extractComposerSendText());
                scheduleComposerDraftSaveRef.current();
              }}
              onKeyDown={(e) => {
                const isImeComposing =
                  e.nativeEvent.isComposing ||
                  imeComposingRef.current ||
                  (e.key !== "Enter" && (e.key === "Process" || e.keyCode === 229));
                if (isImeComposing) return;
                if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "n") {
                  e.preventDefault();
                  void createNewTopic(true);
                  return;
                }
                if (e.key === "Enter" && !e.shiftKey) {
                  if (atOpen && atCandidates.length > 0) {
                    e.preventDefault();
                    // Same semantics as clicking the row: folders drill in, others insert.
                    pickAtMentionCandidate(atCandidates[0]);
                    return;
                  }
                  if (composerExpanded) {
                    if (e.metaKey || e.ctrlKey) {
                      e.preventDefault();
                      lastComposerEnterAtRef.current = 0;
                      void sendChat(extractComposerSendText());
                    }
                    return;
                  }
                  e.preventDefault();
                  const composerText = extractComposerSendText();
                  const trimmedComposer = composerText.trim();
                  const hasComposerPayload =
                    !!trimmedComposer || readyAttachments.length > 0 || quoteTargets.length > 0;
                  const sid = (pane.sessionId || "").trim();
                  const inFlightSid =
                    sendChatInFlightRef.current?.paneId === pane.id
                      ? (sendChatInFlightRef.current.sessionId || "").trim()
                      : "";
                  const awaitingFreshSession = isPaneAwaitingFreshSession(pane.id);
                  const queueSid = resolveQueueSessionKey({
                    currentSessionId: sid,
                    inFlightSessionId: inFlightSid,
                    awaitingFreshSession,
                  });
                  const streamActive = isStreamRunActiveForQueue({
                    sessionId: queueSid,
                    streamStateActive: !!sessionStreamStateRef.current[queueSid]?.active,
                    sendInFlightForSession: !!inFlightSid && inFlightSid === queueSid,
                    executionState: sessionExecutionState,
                    currentSessionId: sid,
                  });
                  const queue = queuedMessagesForSession(
                    useAppStore.getState().pendingMessages[paneId] ?? [],
                    sid,
                  );

                  if (streamActive) {
                    const sendQueuedNow =
                      isDoubleEnterWithinWindow(lastComposerEnterAtRef.current) ||
                      (!hasComposerPayload && queue.length > 0 && lastComposerEnterAtRef.current > 0);

                    if (sendQueuedNow) {
                      lastComposerEnterAtRef.current = 0;
                      if (hasComposerPayload) {
                        void sendChat(composerText, { forceSend: true });
                      } else {
                        const latestQueued = queue[queue.length - 1];
                        if (latestQueued) void sendQueuedMessageNow(latestQueued.id);
                      }
                      return;
                    }

                    if (!hasComposerPayload) return;

                    lastComposerEnterAtRef.current = Date.now();
                    void sendChat(composerText);
                    return;
                  }

                  lastComposerEnterAtRef.current = 0;
                  void sendChat(composerText);
                }
              }}
              className={`agx-pane-composer-input block w-full overflow-y-auto whitespace-pre-wrap break-words bg-transparent px-4 pb-0 pt-4 text-[15px] leading-relaxed text-text-primary outline-none ${
                // 收起时右侧留白需覆盖「展开输入」角标（absolute right-3 + w-8），pr-4 会导致首行末字与按钮重叠
                composerExpanded ? "max-h-[62vh] min-h-[260px] pr-40" : "max-h-[220px] min-h-[72px] pr-14"
              }`}
            />
            {!composerHasText && quoteTargets.length === 0 ? (
              <div className="agx-pane-composer-placeholder pointer-events-none absolute left-4 top-4 text-[15px] text-text-faint">
                {isGroupPane ? "发消息，输入 @ 指定成员..." : "发消息..."}
              </div>
            ) : null}
            </div>
            <div className="agx-pane-composer-actions flex min-w-0 items-center justify-between gap-2 px-2.5 pb-2.5 pt-1">
              <div className="flex min-w-0 shrink items-center gap-0.5 overflow-hidden">
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={(e) => {
                    const files = e.target.files;
                    if (!files) return;
                    let showedVisionToast = false;
                    for (const file of Array.from(files)) {
                      if (isImageFile(file) && isKnownNonVisionChatModel(chatProvider, chatModel)) {
                        if (!showedVisionToast) {
                          notifyImageAttach();
                          showedVisionToast = true;
                        }
                        if (visionAttachBlocked) continue;
                      }
                      const key = `${file.name}:${file.size}:${file.lastModified}`;
                      parseLocalFile(file, key);
                    }
                    e.target.value = "";
                  }}
                />
                <ComposerMoreActionsButton
                  onPickFile={() => fileInputRef.current?.click()}
                  renderSkillPicker={() => (
                    <SkillPickerButton apiBase={apiBase} apiToken={apiToken} onSelect={handleSkillSelect} embedded />
                  )}
                  renderKbRetrieval={
                    LOCAL_KNOWLEDGE_ENABLED
                      ? () => (
                          <PaneKnowledgeRetrievalModeSwitch
                            apiToken={apiToken}
                            apiBase={apiBase}
                            sessionId={pane.sessionId}
                            paneId={paneId}
                            globalDefaultMode={kbGlobalDefaultMode}
                            onNewSessionDefaultChange={onKbNewSessionDefaultChange}
                            embedded
                          />
                        )
                      : undefined
                  }
                  renderConnectors={() => (
                    <ConnectorsMenuButton sessionId={pane.sessionId} embedded />
                  )}
                />
                {hasStartedChat || showNewTopicContext ? (
                  <ComposerContextControls
                    active={focused}
                    mode={showNewTopicContext ? "new-topic" : "conversation"}
                    workspaces={composerTaskspaces}
                    availableWorkspaces={composerAvailableTaskspaces}
                    activeTaskspaceId={pane.activeTaskspaceId}
                    workspacePanelOpen={workspacePanelOpen}
                    workspaceLoading={composerWorkspaceLoading}
                    workspaceActionBusy={composerWorkspaceActionBusy}
                    workspaceError={composerWorkspaceError}
                    onWorkspaceMenuOpen={() => {
                      void prepareComposerWorkspaceMenu();
                    }}
                    onWorkspaceSelect={(taskspaceId) => setActiveTaskspace(pane.id, taskspaceId)}
                    onAvailableWorkspaceSelect={(workspace) =>
                      addComposerWorkspace(workspace.path, workspace.label)
                    }
                    onCreateWorkspace={addComposerWorkspace}
                    onOpenLocalFolder={openComposerLocalFolder}
                    runMode={runMode}
                    showRunMode={!isGroupPane}
                    permissionSaving={composerPermissionSaving}
                    permissionError={composerPermissionError}
                    onRunModeChange={changeComposerRunMode}
                  />
                ) : null}
              </div>
              {/* ── Team/Workforce action bar (shown only for an active run) ── */}
              <div className="flex min-w-0 shrink-0 items-center gap-1.5">
                {teamControlVisible && (
                  <GroupTeamControls
                    paused={groupTeamPaused}
                    pending={groupTeamActionPending}
                    taskDescription={extractComposerSendText()}
                    onAddTask={(taskDescription) => {
                      if (groupTeamActionPendingRef.current) return;
                      void sendGroupTeamAction("add_task", { task_description: taskDescription }).then(
                        (accepted) => {
                          if (!accepted) return;
                          setComposerText("");
                          clearQuoteTargets();
                          flushComposerDraftNowRef.current();
                        },
                      );
                    }}
                    onPauseResume={() =>
                      void sendGroupTeamAction(groupTeamPaused ? "resume" : "pause")
                    }
                    onStop={() => void sendGroupTeamAction("stop")}
                  />
                )}
                <div className="flex min-w-0 items-center gap-0.5">
                  {hasStartedChat ? (
                    <ContextUsageButton
                      paneId={pane.id}
                      sessionId={pane.sessionId ?? ""}
                      apiBase={apiBase}
                      apiToken={apiToken}
                    />
                  ) : null}
                  <PaneModelPicker
                    paneId={pane.id}
                    pendingRoutingTarget={pendingAttachmentRoutingTarget}
                    pendingRoutingAllowsPublic={canChoosePublicAttachmentRoute}
                  />
                </div>
                <ActionCircleButton
                  hasInput={
                    (!!composerHasText || readyAttachments.length > 0 || quoteTargets.length > 0)
                  }
                  /* `canInterruptCurrentSession` 只覆盖"当前 pane 自己发起 SSE"的场景。
                   * 分身被 Meta 委派时，分身 pane 自己没有 SSE，但任务确实在跑。
                   * 用 `hasDelegation` 兜底，让分身/Meta 视角下都能看到 stop 按钮，
                   * 后端 `interruptSession` 对任意 session_id 生效。 */
                  streaming={showStopButton}
                  recording={recording}
                  transcribing={voiceTranscribing}
                  canResume={
                    Boolean((pane.sessionId || "").trim()) &&
                    !isFutileResumeFlag &&
                    !budgetExceededInfo &&
                    !composerHasText &&
                    readyAttachments.length === 0 &&
                    quoteTargets.length === 0 &&
                    (sessionExecutionState === "interrupted" ||
                      sessionExecutionState === "failed" ||
                      stallState === "stall" ||
                      stallState === "exhausted")
                  }
                  resuming={resumeInFlight}
                  onSend={() => {
                    lastComposerEnterAtRef.current = 0;
                    void sendChat(extractComposerSendText());
                  }}
                  onMic={onMicClick}
                  onStop={stopCurrentRun}
                  onResume={() => void resumeCurrentTask()}
                />
              </div>
            </div>
            {atOpen ? (
              <AtMentionPicker
                query={atQuery}
                candidates={atCandidates}
                browse={atBrowse}
                onPick={pickAtMentionCandidate}
                onEnterDir={enterAtMentionDir}
                onInsertDir={insertAtMentionDir}
                onLeaveBrowse={leaveAtMentionBrowse}
              />
            ) : null}
          </div>
          {/* AI 免责声明：仅非空会话显示（对齐 Work Buddy，空新建会话不打扰） */}
          {(pane.messages ?? []).some(
            (m) => m.role === "user" || m.role === "assistant"
          ) ? (
            <div className="mt-1.5 flex justify-center px-0.5">
              <p className="select-none text-[11px] leading-none text-text-faint">
                内容由 AI 生成，请核实重要信息
              </p>
            </div>
          ) : null}
          {composerRefTip
            ? createPortal(
                <div
                  role="tooltip"
                  className="pointer-events-none fixed z-[100] w-max max-w-[min(360px,calc(100vw-24px))] break-all rounded-md border border-border bg-surface-panel px-2.5 py-1.5 text-left text-[11px] leading-snug text-text-primary shadow-lg backdrop-blur-xl"
                  style={{
                    left: composerRefTip.x,
                    top: composerRefTip.y,
                    transform: "translate(-50%, calc(-100% - 6px))",
                  }}
                >
                  {composerRefTip.path}
                </div>,
                document.body
              )
            : null}
          </div>
        </div>
        </div>
      </div>

      {!compactSidePanels && workspacePanelOpen ? (
        <div
          className={
            workExpandedLayout
              ? "relative h-full min-w-0 flex-1 overflow-hidden"
              : "relative h-full shrink-0 overflow-hidden"
          }
          style={workExpandedLayout ? undefined : { width: taskspaceWidth }}
        >
          {!workExpandedLayout ? (
            <div
              className="group absolute -left-[3px] top-0 z-20 h-full w-2 cursor-col-resize"
              onMouseDown={startResizeTaskspace}
              title="拖拽调整工作台面板宽度"
            >
              <div className="mx-auto h-full w-px bg-[var(--border-strong)] transition-all duration-200 group-hover:w-[2px] group-hover:bg-[var(--ui-btn-primary-bg)]" />
            </div>
          ) : null}
          <WorkPanel
            paneId={pane.id}
            sessionId={pane.sessionId}
            activeTaskspaceId={pane.activeTaskspaceId}
            onActiveTaskspaceChange={(taskspaceId) => setActiveTaskspace(pane.id, taskspaceId)}
            autoRefreshKey={taskspaceAutoRefreshKey}
            onClose={closeWorkspacePanelOnly}
            expanded={workPanelExpanded}
            onToggleExpand={toggleWorkPanelExpand}
            tintColor={paneTint}
            focusRequest={workPanelFocus}
            onFocusRequestHandled={() => setWorkPanelFocus(null)}
            onPickFileForReference={(taskspaceId, path) => {
              void insertWorkspaceFileReference(taskspaceId, path);
            }}
            onPickDirectoryForReference={({ taskspaceId, relPath, label }) => {
              void insertWorkspaceDirectoryReference(taskspaceId, relPath, label);
            }}
            onQuotePreviewSnippet={insertWorkspaceSnippetReference}
            onQuoteBrowserSelection={(payload) => {
              const text = String(payload.text || "").trim();
              if (!text) return;
              let host = "";
              try {
                host = new URL(payload.url).hostname;
              } catch {
                /* ignore */
              }
              const label = (payload.title || host || "网页").trim().slice(0, 48);
              addQuoteTarget(
                {
                  id: `web-${crypto.randomUUID()}`,
                  role: "assistant",
                  content: text,
                  avatarName: label,
                },
                text,
              );
            }}
            onSearchBrowserSelection={(text) => {
              const q = String(text || "").trim();
              if (!q) return;
              if (!pane.taskspacePanelOpen) {
                openWorkspaceSidebarForPane(
                  pane.id,
                  paneRef.current?.clientWidth ?? paneWidth,
                  openSidePanel,
                );
              }
              setWorkPanelFocus({
                kind: "browser",
                url: `https://www.google.com/search?q=${encodeURIComponent(q)}`,
                title: `搜索：${q}`,
              });
            }}
            previewOpenRequest={pendingWorkspacePreviewRequest}
            onPreviewOpenRequestHandled={() => setPendingWorkspacePreviewRequest(null)}
            onEnsureSessionForWorkspace={materializeLazySession}
            attachmentRoutingDocumentExtensions={[...attachmentRoutingPolicy.documentExtensions]}
            attachmentRoutingPrivateTargetLabel={attachmentRoutingPolicy.documentTarget?.label}
            attachmentRoutingShouldWarn={activeModelUsesPublicRoute}
            subAgents={paneSubAgents}
            selectedSubAgent={selectedSubAgent}
            onCancelSubAgent={(agentId) => void cancelPaneSubAgent(agentId)}
            onRetrySubAgent={(agentId) => void retryPaneSubAgent(agentId)}
            onChatSubAgent={togglePaneSubAgentChat}
            onModelChangeSubAgent={(agentId, provider, model) =>
              void changePaneSubAgentModel(agentId, provider, model)
            }
            onConfirmResolveSubAgent={(agentId, approved) =>
              void resolvePaneSubAgentConfirm(agentId, approved)
            }
            todoLiveness={taskLiveness}
            todoExecutionState={sessionExecutionState}
            groupId={isGroupPane ? groupChatId : null}
            avatarList={avatars}
            metaLeaderLabel={metaLeaderDisplayName}
            groupActiveAgentIds={groupActiveAgentIds}
            groupActivityHint={groupActivityHint}
            groupMemberPhase={groupMemberPhase}
            onCrewAppendDirective={handleCrewAppendDirective}
            onOpenGroupMember={handleOpenGroupMember}
            onCrewSwitchModel={handleCrewSwitchModel}
            onCrewInterrupt={handleCrewInterrupt}
          />
        </div>
      ) : null}
      {!compactSidePanels && pane.runDrawerOpen && pane.runDrawerRunId && pane.sessionId ? (
        <SubAgentRunDrawer
          width={runDrawerWidth}
          sessionId={pane.sessionId}
          runId={pane.runDrawerRunId}
          liveSubAgent={drawerLiveSubAgent}
          apiBase={apiBase}
          apiToken={apiToken}
          onResizeStart={startResizeRunDrawer}
          onClose={closeRunDrawerPanelOnly}
          tintColor={paneTint}
        />
      ) : null}
      {!compactSidePanels && pane.memoryGraphOpen ? (
        <div className="relative h-full shrink-0 overflow-hidden" style={{ width: historyWidth }}>
          <div
            className="group absolute -left-[3px] top-0 z-20 h-full w-2 cursor-col-resize"
            onMouseDown={startResizeHistory}
            title="拖拽调整记忆图谱面板宽度"
          >
            <div className="mx-auto h-full w-px bg-[var(--border-strong)] transition-all duration-200 group-hover:w-[2px] group-hover:bg-[var(--ui-btn-primary-bg)]" />
          </div>
          <MemoryGraphPanel pane={pane} onClose={closeMemoryGraphPanelOnly} tintColor={paneTint} />
        </div>
      ) : null}
      {compactSidePanels &&
      (workspacePanelOpen ||
        pane.memoryGraphOpen ||
        pane.spawnsColumnOpen ||
        pane.runDrawerOpen) ? (
        <>
          <div
            aria-hidden
            role="presentation"
            className={`pointer-events-auto absolute inset-x-0 bottom-0 z-[45] bg-black/35 backdrop-blur-[1px] ${
              integratedToolbar ? "top-0" : "top-10"
            }`}
            style={{ WebkitAppRegion: "no-drag" } as CSSProperties}
            onClick={dismissAuxiliaryOverlays}
          />
          {workspacePanelOpen ? (
            <div
              className={
                workExpandedLayout
                  ? "pointer-events-auto absolute inset-0 z-50 overflow-hidden bg-surface-base"
                  : `pointer-events-auto absolute bottom-0 right-0 z-50 shrink-0 overflow-hidden bg-surface-base shadow-[6px_0_24px_rgba(0,0,0,0.28)] ${
                      integratedToolbar ? "top-0" : "top-10"
                    }`
              }
              style={
                workExpandedLayout
                  ? ({ WebkitAppRegion: "no-drag" } as CSSProperties)
                  : ({ width: overlayTaskspaceWidth, WebkitAppRegion: "no-drag" } as CSSProperties)
              }
            >
              {!workExpandedLayout ? (
                <div
                  className="group absolute -left-[3px] top-0 z-20 h-full w-2 cursor-col-resize"
                  onMouseDown={startResizeTaskspace}
                  title="拖拽调整工作台面板宽度"
                >
                  <div className="mx-auto h-full w-px bg-[var(--border-strong)] transition-all duration-200 group-hover:w-[2px] group-hover:bg-[var(--ui-btn-primary-bg)]" />
                </div>
              ) : null}
              <WorkPanel
                paneId={pane.id}
                sessionId={pane.sessionId}
                activeTaskspaceId={pane.activeTaskspaceId}
                onActiveTaskspaceChange={(taskspaceId) => setActiveTaskspace(pane.id, taskspaceId)}
                autoRefreshKey={taskspaceAutoRefreshKey}
                onClose={closeWorkspacePanelOnly}
                expanded={workPanelExpanded}
                onToggleExpand={toggleWorkPanelExpand}
                tintColor={paneTint}
                focusRequest={workPanelFocus}
                onFocusRequestHandled={() => setWorkPanelFocus(null)}
                onPickFileForReference={(taskspaceId, path) => {
                  void insertWorkspaceFileReference(taskspaceId, path);
                }}
                onPickDirectoryForReference={({ taskspaceId, relPath, label }) => {
                  void insertWorkspaceDirectoryReference(taskspaceId, relPath, label);
                }}
                onQuotePreviewSnippet={insertWorkspaceSnippetReference}
                onQuoteBrowserSelection={(payload) => {
                  const text = String(payload.text || "").trim();
                  if (!text) return;
                  let host = "";
                  try {
                    host = new URL(payload.url).hostname;
                  } catch {
                    /* ignore */
                  }
                  const label = (payload.title || host || "网页").trim().slice(0, 48);
                  addQuoteTarget(
                    {
                      id: `web-${crypto.randomUUID()}`,
                      role: "assistant",
                      content: text,
                      avatarName: label,
                    },
                    text,
                  );
                }}
                onSearchBrowserSelection={(text) => {
                  const q = String(text || "").trim();
                  if (!q) return;
                  if (!pane.taskspacePanelOpen) {
                    openWorkspaceSidebarForPane(
                      pane.id,
                      paneRef.current?.clientWidth ?? paneWidth,
                      openSidePanel,
                    );
                  }
                  setWorkPanelFocus({
                    kind: "browser",
                    url: `https://www.google.com/search?q=${encodeURIComponent(q)}`,
                    title: `搜索：${q}`,
                  });
                }}
                previewOpenRequest={pendingWorkspacePreviewRequest}
                onPreviewOpenRequestHandled={() => setPendingWorkspacePreviewRequest(null)}
                onEnsureSessionForWorkspace={materializeLazySession}
                attachmentRoutingDocumentExtensions={[...attachmentRoutingPolicy.documentExtensions]}
                attachmentRoutingPrivateTargetLabel={attachmentRoutingPolicy.documentTarget?.label}
                attachmentRoutingShouldWarn={activeModelUsesPublicRoute}
                subAgents={paneSubAgents}
                selectedSubAgent={selectedSubAgent}
                onCancelSubAgent={(agentId) => void cancelPaneSubAgent(agentId)}
                onRetrySubAgent={(agentId) => void retryPaneSubAgent(agentId)}
                onChatSubAgent={togglePaneSubAgentChat}
                onModelChangeSubAgent={(agentId, provider, model) =>
                  void changePaneSubAgentModel(agentId, provider, model)
                }
                onConfirmResolveSubAgent={(agentId, approved) =>
                  void resolvePaneSubAgentConfirm(agentId, approved)
                }
                todoLiveness={taskLiveness}
                todoExecutionState={sessionExecutionState}
                groupId={isGroupPane ? groupChatId : null}
                avatarList={avatars}
                metaLeaderLabel={metaLeaderDisplayName}
                groupActiveAgentIds={groupActiveAgentIds}
                groupActivityHint={groupActivityHint}
                groupMemberPhase={groupMemberPhase}
                onCrewAppendDirective={handleCrewAppendDirective}
                onOpenGroupMember={handleOpenGroupMember}
                onCrewSwitchModel={handleCrewSwitchModel}
                onCrewInterrupt={handleCrewInterrupt}
              />
            </div>
          ) : null}
          {pane.runDrawerOpen && pane.runDrawerRunId && pane.sessionId ? (
            <div
              className={`pointer-events-auto absolute bottom-0 right-0 z-50 shrink-0 overflow-hidden shadow-[6px_0_24px_rgba(0,0,0,0.28)] ${
                integratedToolbar ? "top-0" : "top-10"
              }`}
              style={{ width: overlayRunDrawerWidth, WebkitAppRegion: "no-drag" } as CSSProperties}
            >
              <SubAgentRunDrawer
                width={overlayRunDrawerWidth}
                sessionId={pane.sessionId}
                runId={pane.runDrawerRunId}
                liveSubAgent={drawerLiveSubAgent}
                apiBase={apiBase}
                apiToken={apiToken}
                onResizeStart={startResizeRunDrawer}
                onClose={closeRunDrawerPanelOnly}
                tintColor={paneTint}
              />
            </div>
          ) : null}
          {pane.memoryGraphOpen ? (
            <div
              className={`pointer-events-auto absolute bottom-0 right-0 z-50 shrink-0 overflow-hidden bg-surface-base shadow-[6px_0_24px_rgba(0,0,0,0.28)] ${
                integratedToolbar ? "top-0" : "top-10"
              }`}
              style={{ width: overlayHistoryWidth, WebkitAppRegion: "no-drag" } as CSSProperties}
            >
              <div
                className="group absolute -left-[3px] top-0 z-20 h-full w-2 cursor-col-resize"
                onMouseDown={startResizeHistory}
                title="拖拽调整记忆图谱面板宽度"
              >
                <div className="mx-auto h-full w-px bg-[var(--border-strong)] transition-all duration-200 group-hover:w-[2px] group-hover:bg-[var(--ui-btn-primary-bg)]" />
              </div>
              <MemoryGraphPanel pane={pane} onClose={closeMemoryGraphPanelOnly} tintColor={paneTint} />
            </div>
          ) : null}
        </>
      ) : null}
      </div>
      {pane.historyOpen && historyAnchorRect
        ? createPortal(
            <>
              <div
                aria-hidden
                role="presentation"
                className="fixed inset-0 z-[9998]"
                onClick={closeHistoryPanelOnly}
              />
              <div
                className="fixed z-[9999] overflow-hidden rounded-xl border border-border bg-surface-panel shadow-xl backdrop-blur-xl"
                style={historyPanelPopoverStyle(historyAnchorRect)}
              >
                <HistoryPanelBoundary key={`hpb-${pane.id}-${pane.historyOpen}-popover`}>
                  <SessionHistoryPanel pane={pane} tintColor={paneTint} />
                </HistoryPanelBoundary>
              </div>
            </>,
            document.body
          )
        : null}
      <ForwardPicker
        open={forwardPickerOpen}
        currentSessionId={pane.sessionId}
        currentAvatarId={pane.avatarId}
        avatars={avatars}
        groups={groups}
        onClose={() => {
          setForwardPickerOpen(false);
          setPendingForwardMessages([]);
        }}
        onConfirm={async (targetPayload, followUpNote) => {
          await executeForward(targetPayload, followUpNote);
          setSelectedMessageIds(new Set());
        }}
      />
      <ShareImagePreviewModal
        open={shareImageOpen}
        messages={messagesForShareExport(selectedMessages, visibleMessages)}
        sessionTitle={paneAvatarMeta.name || pane?.avatarName || "对话记录"}
        userBubbleLabel={userBubbleLabel}
        onClose={() => setShareImageOpen(false)}
        onToast={(msg) => setStallHintToast(msg)}
      />
      {avatarSettingsOpen && paneSettingsAvatar ? (
        <AvatarSettingsPanel
          mode="avatar"
          avatar={paneSettingsAvatar}
          onClose={() => {
            setAvatarSettingsOpen(false);
            setCrewSettingsAvatarId(null);
          }}
          onSaved={() => {
            window.dispatchEvent(
              new CustomEvent("agenticx:avatars:changed", { detail: { openPane: false } })
            );
          }}
        />
      ) : null}
    </div>
  );
}
