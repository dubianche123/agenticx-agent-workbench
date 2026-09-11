import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CSSProperties, ReactNode, MouseEvent as ReactMouseEvent } from "react";
import { AlertTriangle, ArrowRight, ArrowUp, Bookmark, ChevronDown, ChevronRight, Copy, ExternalLink, Forward, LayoutList, MessageSquarePlus, Pencil, Quote, RotateCcw, Search, TextSelect, X } from "lucide-react";
import type { Message, MessageAttachment } from "../../store";
import { useAppStore } from "../../store";
import type {
  ChatFeedbackAction,
  ChatFeedbackStatus,
  ChatFeedbackValue,
} from "../../utils/chat-feedback";
import type { SearchReference } from "../../types/search-references";
import { AttachmentCard } from "./AttachmentCard";
import { isWorkspaceReferenceAttachment, type FileReferenceOpenRequest } from "../../utils/reference-attachment";
import { ReasoningBlock } from "./ReasoningBlock";
import { resolvePersistedReasoningSeconds } from "./reasoning-duration-cache";
import { ReferencesCard } from "./ReferencesCard";
import { parseReasoningContent } from "./reasoning-parser";
import { getContainedSelectionText } from "../../utils/favorite-selection";
import { HoverTip } from "../ds/HoverTip";
import { CitationMarkdownBody } from "./CitationMarkdownBody";
import { renderUserMessageInlineBody, UserQuoteRefChip, renderUserBubbleInlineContent } from "./user-message-inline";
import {
  parseQuotedContentItems,
  resolveUserMessageQuoteDisplay,
} from "../../utils/user-quote-display";
import {
  parseAssistantOutputForUi,
  reasoningDuplicatesVisibleBody,
} from "../../utils/assistant-output";
import {
  ASSISTANT_ACTION_ICON_ONLY_CLASS,
  ASSISTANT_ACTION_ICON_ROW_CLASS,
  ASSISTANT_ACTION_RHYTHM_GAP_CLASS,
  ASSISTANT_FOLLOWUP_CHIP_CLASS,
  ASSISTANT_FOLLOWUP_LIST_CLASS,
  getAssistantActionStyle,
  getAssistantTextClassName,
  getAssistantTextStyle,
} from "./im-layout";
import { resolveMetaDisplayName } from "../../utils/display-name";
import { avatarBgClass, avatarFgClass, expertLabelChipStyle } from "../../utils/avatar-color";
import { shouldShowAssistantFollowups, shouldShowAssistantIconButtons } from "../../utils/im-bubble-actions";
import { isGroupStreamMessageId } from "../../utils/group-stream-text";
import { MessageTimestamp } from "./MessageTimestamp";
import { Shimmer } from "../ds/Shimmer";
import { GroupMemberAvatar } from "../groups/GroupMemberAvatar";
import { GROUP_REACTION_EMOJIS, isPublicGroupMessage } from "../../utils/group-message-state";
import { isCompletedAssistantForFeedback } from "../../utils/feedback-message-completion";
import { AssistantFeedback } from "./AssistantFeedback";

// Re-export the pure transition from the component module as well.  Existing
// message-action tests import helpers from ImBubble, and keeping the export
// here makes the toggle contract easy to discover next to the controls.
export { nextChatFeedbackValue } from "../../utils/chat-feedback";
export type { ChatFeedbackAction, ChatFeedbackStatus, ChatFeedbackValue } from "../../utils/chat-feedback";

type Props = {
  message: Message;
  /** When message.references is empty, inherit from same-turn tool_result / embedded JSON. */
  resolvedReferences?: SearchReference[];
  highlightTerms?: string[];
  badge?: ReactNode;
  assistantName?: string;
  assistantAvatarUrl?: string;
  /**
   * IM assistant layout: compact row aligns with tool cards (spacer only, no avatar/name),
   * used inside a parent ReAct block that renders the primary avatar column.
   */
  assistantVisual?: "default" | "compact-inline" | "compact-inline-with-actions";
  /** When true and compact, remove inner bubble border so parent container provides the single border. */
  noBubbleBorder?: boolean;
  userName?: string;
  userAvatarUrl?: string;
  onCopyMessage?: (message: Message) => void;
  onQuoteMessage?: (message: Message, selectedText?: string) => void;
  onWebSearchMessage?: (message: Message, selectedText: string) => void;
  onQuoteToNewPane?: (message: Message, selectedText?: string) => void;
  onFavoriteMessage?: (message: Message, selectedText?: string) => void;
  onToggleSelectMessage?: (message: Message) => void;
  onForwardMessage?: (message: Message, selectedText?: string) => void;
  onRetryMessage?: (message: Message) => void;
  onEditMessage?: (message: Message, newContent: string) => void;
  selectable?: boolean;
  selected?: boolean;
  /** Clicking a follow-up chip sends this text as the next user message (assistant only). */
  onFollowupClick?: (text: string, ctx?: { ownerSessionId?: string }) => void;
  /** Open absolute file path in workspace preview (assistant markdown paths). */
  onRevealPath?: (path: string) => void;
  /** Open @file reference chip in workspace preview (optionally focused to a line range). */
  onOpenFileReference?: (request: FileReferenceOpenRequest) => void;
  /** Suppress in-bubble chips; used when parent renders them outside a unified ReAct container. */
  omitSuggestedQuestions?: boolean;
  /** Tighten trailing line-box before a peeled block-level action row (ReAct card). */
  actionRhythmBodyTail?: boolean;
  /** Render-only hint when this assistant reply was cut off by session token budget. */
  budgetIncompleteHint?: boolean;
  /** Group chat: show the sender identity row above the assistant bubble. */
  showSenderIdentity?: boolean;
  /** Shape of the sender avatar in the group identity row. */
  senderAvatarVariant?: "circle" | "rounded-square";
  /** Fallback tint when no imageUrl (avatar id for color hash). */
  senderAvatarId?: string;
  /** Stable group role shown before the sender name (for example, 主持人). */
  senderRoleLabel?: string;
  /** Open the sender's full expert details from the lightweight contact card. */
  onOpenSenderProfile?: (avatarId: string) => void;
  /** Render compact group-feed reactions and route toggles to the chat owner. */
  enableGroupReactions?: boolean;
  onToggleReaction?: (message: Message, emoji: string) => void | Promise<void>;
  /** Current user's feedback for a completed assistant reply. */
  feedbackValue?: ChatFeedbackValue | null;
  /** True while the preload persistence request for this reply is pending. */
  feedbackPending?: boolean;
  /** Result of the latest feedback persistence request. */
  feedbackStatus?: ChatFeedbackStatus;
  /** Set, switch, or clear the current user's feedback. */
  onFeedback?: (
    messageId: string,
    value: ChatFeedbackValue | null,
    action?: ChatFeedbackAction,
  ) => void | Promise<void>;
  /** Stable feedback row supplied by MessageRenderer for every visual style. */
  feedbackControls?: ReactNode;
  /** Short reason shown when the trusted feedback handshake is unavailable. */
  feedbackDisabledReason?: string;
  /** Retry only scope/list hydration; never creates a vote. */
  onRetryFeedbackLoad?: () => void | Promise<void>;
  /** When true, suppress action buttons on the last assistant bubble while the session is busy/stalled. */
  sessionBusy?: boolean;
  isLastAssistantInPane?: boolean;
  /** Replace animated streaming dots with a stalled indicator on the __stream__ placeholder. */
  streamStalled?: boolean;
  streamStalledSeconds?: number;
  /** Deliverable cards after the body; copy/quote sit to the right of the cards. */
  afterBody?: ReactNode;
};

function StalledStreamIndicator({ silentSeconds }: { silentSeconds: number }) {
  return (
    <div
      className="inline-flex items-center gap-1.5 py-1.5 text-xs text-amber-300/90"
      aria-live="polite"
      aria-label="任务已停滞"
    >
      <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span>{silentSeconds > 0 ? `已停滞 ${silentSeconds}s` : "已停滞"}</span>
    </div>
  );
}

/** Doubao-style 3-dot bouncing indicator for streaming gaps (reasoning done → tool call → first body token). */
function StreamingDots({ compact = false }: { compact?: boolean }) {
  return (
    <div
      className={`inline-flex items-center gap-1.5 ${compact ? "py-0" : "py-1.5"}`}
      aria-live="polite"
      aria-label="正在处理"
    >
      <span
        className="h-1.5 w-1.5 rounded-full agx-dot-pulse"
        style={{ background: "var(--text-faint)" }}
      />
      <span
        className="h-1.5 w-1.5 rounded-full agx-dot-pulse"
        style={{ background: "var(--text-faint)", animationDelay: "0.2s" }}
      />
      <span
        className="h-1.5 w-1.5 rounded-full agx-dot-pulse"
        style={{ background: "var(--text-faint)", animationDelay: "0.4s" }}
      />
    </div>
  );
}

/** Shared with ReAct block shell so top-of-stack avatar matches IM bubbles. */
export function ChatImAvatar({
  label,
  imageUrl,
  variant = "circle",
  avatarId,
  color,
}: {
  label: string;
  imageUrl?: string;
  variant?: "circle" | "rounded-square";
  avatarId?: string;
  /** Palette key or empty (= Meta / theme). When omitted and avatarId set, looked up from store. */
  color?: string;
}) {
  const storeColor = useAppStore((s) =>
    avatarId ? s.avatars.find((a) => a.id === avatarId)?.color : undefined,
  );
  const memberAvatar = useAppStore((s) =>
    avatarId && avatarId !== "meta" ? s.avatars.find((a) => a.id === avatarId) : undefined,
  );
  const resolvedColor = color ?? storeColor ?? "";
  const char = label.slice(0, 1) || "?";
  const rounded = variant === "rounded-square" ? "rounded-[6px]" : "rounded-full";
  if (imageUrl) {
    return (
      <img
        src={imageUrl}
        alt={label}
        className={`h-8 w-8 shrink-0 object-cover ${rounded}`}
      />
    );
  }
  if (avatarId && avatarId !== "meta") {
    return (
      <GroupMemberAvatar
        avatar={memberAvatar}
        label={label}
        identity={avatarId}
        size="sm"
        className={variant === "circle" ? "rounded-full" : undefined}
      />
    );
  }
  const tintClass = avatarId ? `${avatarBgClass(resolvedColor)} ${avatarFgClass(resolvedColor)}` : "";
  return (
    <div
      className={`flex h-8 w-8 shrink-0 items-center justify-center text-xs font-bold ${rounded} ${tintClass}`}
      style={
        avatarId
          ? undefined
          : {
              background: "var(--chat-im-avatar-bg)",
              color: "var(--chat-im-avatar-fg, var(--text-strong))",
            }
      }
    >
      {char}
    </div>
  );
}

function GroupReactionPills({
  message,
  onToggleReaction,
}: {
  message: Message;
  onToggleReaction?: (message: Message, emoji: string) => void | Promise<void>;
}) {
  const reactions = message.reactions ?? [];
  if (reactions.length === 0) return null;
  return (
    <div
      className="mt-1 flex max-w-full flex-wrap gap-1 px-3"
      data-group-reaction-pills="1"
      aria-label="消息回应"
    >
      {reactions.map((reaction) => (
        <button
          key={reaction.emoji}
          type="button"
          className={`inline-flex h-6 items-center gap-1 rounded-full border px-2 text-[12px] transition ${
            reaction.active
              ? "border-[rgba(var(--theme-color-rgb,59,130,246),0.5)] bg-[rgba(var(--theme-color-rgb,59,130,246),0.12)] text-[rgb(var(--theme-color-fg-rgb,59,130,246))]"
              : "border-border bg-surface-card text-text-muted hover:bg-surface-hover hover:text-text-primary"
          }`}
          aria-label={`${reaction.emoji} ${reaction.actorIds.length} 个回应`}
          title="点击切换回应"
          onClick={(event) => {
            event.stopPropagation();
            onToggleReaction?.(message, reaction.emoji);
          }}
        >
          <span aria-hidden>{reaction.emoji}</span>
          <span>{reaction.actorIds.length}</span>
        </button>
      ))}
    </div>
  );
}

const MESSAGE_CONTEXT_MENU_MARGIN = 8;

export function ImBubble({
  message,
  resolvedReferences,
  highlightTerms,
  badge,
  assistantName,
  assistantAvatarUrl,
  userName,
  userAvatarUrl,
  onCopyMessage,
  onQuoteMessage,
  onWebSearchMessage,
  onQuoteToNewPane,
  onFavoriteMessage,
  onToggleSelectMessage,
  onForwardMessage,
  onRetryMessage,
  onEditMessage,
  selectable,
  selected,
  assistantVisual = "default",
  noBubbleBorder = false,
  onFollowupClick,
  onRevealPath,
  onOpenFileReference,
  omitSuggestedQuestions = false,
  actionRhythmBodyTail = false,
  budgetIncompleteHint = false,
  showSenderIdentity = false,
  senderAvatarVariant: _senderAvatarVariant = "circle",
  senderAvatarId,
  senderRoleLabel,
  onOpenSenderProfile,
  enableGroupReactions = false,
  onToggleReaction,
  feedbackValue = null,
  feedbackPending = false,
  feedbackStatus,
  onFeedback,
  feedbackControls,
  feedbackDisabledReason,
  onRetryFeedbackLoad,
  sessionBusy = false,
  isLastAssistantInPane = false,
  streamStalled = false,
  streamStalledSeconds = 0,
  afterBody,
}: Props) {
  void userAvatarUrl;
  const theme = useAppStore((s) => s.theme);
  const senderStoreColor = useAppStore((s) =>
    senderAvatarId && senderAvatarId !== "meta"
      ? s.avatars.find((a) => a.id === senderAvatarId)?.color
      : undefined,
  );
  const senderAvatar = useAppStore((s) =>
    senderAvatarId && !["meta", "__meta__", "user-self"].includes(senderAvatarId)
      ? s.avatars.find((a) => a.id === senderAvatarId)
      : undefined,
  );
  const isUser = message.role === "user";
  const displayName = isUser ? (userName || "我") : (assistantName || "AI");
  const isStreaming = message.id === "__stream__" || isGroupStreamMessageId(message.id);
  const isMetaPendingWork = !isUser && message.id === "typing-meta";
  const isGroupTyping =
    !isUser &&
    typeof message.id === "string" &&
    message.id.startsWith("typing-") &&
    message.id !== "typing-meta";
  const compactAssistant =
    !isUser &&
    (assistantVisual === "compact-inline" || assistantVisual === "compact-inline-with-actions") &&
    !isGroupTyping &&
    !isMetaPendingWork;
  const workflowRole =
    typeof message.metadata?.workflow_role === "string"
      ? message.metadata.workflow_role.trim()
      : "";
  const workflowRoleLabel = showSenderIdentity
    ? ({
        leader: "主持人",
        executor: "执行",
        reviewer: "审核",
        system: "流程",
      } as Record<string, string>)[workflowRole] ?? ""
    : "";
  const stableSenderRoleLabel = showSenderIdentity
    ? String(senderRoleLabel ?? "").trim()
    : "";
  const trailingWorkflowRoleLabel =
    workflowRoleLabel && workflowRoleLabel !== stableSenderRoleLabel
      ? workflowRoleLabel
      : "";
  const senderProfile = senderAvatar ?? (
    senderAvatarId && !["meta", "__meta__", "user-self"].includes(senderAvatarId)
      ? {
          id: senderAvatarId,
          name: displayName,
          role: stableSenderRoleLabel || trailingWorkflowRoleLabel || "数字专家",
          avatarUrl: assistantAvatarUrl || "",
          pinned: false,
          createdBy: "manual",
          description: "",
          tags: [] as string[],
          defaultPermissionMode: "ask" as const,
        }
      : undefined
  );
  /** Group replies use an explicit identity row and a bordered message bubble. */
  const showExpertLabel = showSenderIdentity && !isUser && !compactAssistant;
  const expertChip = showExpertLabel
    ? expertLabelChipStyle(senderAvatarId, senderStoreColor, theme)
    : null;
  const hideActions = compactAssistant && assistantVisual !== "compact-inline-with-actions";
  const [expertCollapsed, setExpertCollapsed] = useState(false);
  const [profileCardOpen, setProfileCardOpen] = useState(false);
  const [profileCardPosition, setProfileCardPosition] = useState({ left: 12, top: 12 });
  const profileTriggerRef = useRef<HTMLButtonElement | null>(null);
  const profileCardRef = useRef<HTMLDivElement | null>(null);
  const parsed = !isUser ? parseReasoningContent(message.content) : null;
  const protocolParsed = !isUser ? parseAssistantOutputForUi(message.content) : null;
  const hasThinkTag = parsed?.hasReasoningTag ?? false;
  /** True once </think> has arrived in the stream; lets us collapse reasoning and show waiting dots while a tool call runs. */
  const reasoningClosed =
    hasThinkTag && /<\/think>/i.test(String(message.content ?? ""));
  // Messages created in live state do not always pass through the history
  // mapper. Apply the same protocol parser at the final render boundary so a
  // malformed/unclosed <followups> tail can never become Markdown body text.
  const userQuoteDisplay = isUser
    ? resolveUserMessageQuoteDisplay(message.content, message.quotedContent)
    : null;
  const rawBodyText = !isUser
    ? (protocolParsed?.visibleBody ?? (hasThinkTag ? (parsed?.response ?? "") : message.content))
    : (userQuoteDisplay?.body ?? message.content);
  /** Drop leading `---` so Meta/PM reports don't leave a hole under the expert label. */
  const bodyText =
    showExpertLabel && !isUser
      ? String(rawBodyText ?? "").replace(/^(?:\s*---\s*(?:\n|$))+/, "").replace(/^\s+/, "")
      : rawBodyText;
  const displayQuotedItems = isUser
    ? (userQuoteDisplay?.quotedItems ?? [])
    : parseQuotedContentItems(message.quotedContent);
  const citationReferences =
    (resolvedReferences?.length ?? 0) > 0 ? resolvedReferences : message.references;
  const referenceAttachments = isUser
    ? (message.attachments ?? []).filter((attachment) => isWorkspaceReferenceAttachment(attachment))
    : [];
  const displayAttachments = isUser
    ? (message.attachments ?? []).filter((attachment) => !isWorkspaceReferenceAttachment(attachment))
    : message.attachments ?? [];
  const hasBody = !!bodyText?.trim() || displayQuotedItems.length > 0;
  const bubbleStyle: CSSProperties = isUser
    ? {
        background: "var(--chat-im-user-bg)",
        color: "var(--chat-im-user-text)",
      }
    : showExpertLabel
      ? {
          background: "var(--surface-card)",
          borderColor: "var(--border)",
          color: "var(--chat-im-assistant-text)",
        }
      : {
          // Frameless assistant text (e.g. Doubao-style): sit on chat surface; keep semantic text color.
          background: "transparent",
          borderColor: "transparent",
          color: "var(--chat-im-assistant-text)",
        };
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [menuLayout, setMenuLayout] = useState<{ x: number; y: number } | null>(null);
  const [menuHasSelection, setMenuHasSelection] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const msgContentRef = useRef<HTMLDivElement | null>(null);
  // Clicking an action button can collapse the browser selection before the
  // click handler runs. Keep the last selection from this bubble so quoting a
  // sentence remains deterministic instead of silently falling back to the
  // whole message.
  const actionSelectionRef = useRef<string | null>(null);

  const [isEditing, setIsEditing] = useState(false);
  const [editContent, setEditContent] = useState("");
  const editInputRef = useRef<HTMLTextAreaElement | null>(null);

  const canOpenSenderProfile = Boolean(
    senderProfile && senderAvatarId && onOpenSenderProfile,
  );

  const openSenderProfileCard = (target: HTMLButtonElement) => {
    if (!canOpenSenderProfile) return;
    const rect = target.getBoundingClientRect();
    const cardWidth = 320;
    const cardHeight = 270;
    const gap = 8;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const left = Math.min(
      Math.max(12, rect.left),
      Math.max(12, viewportWidth - cardWidth - 12),
    );
    const below = rect.bottom + gap;
    const top = below + cardHeight <= viewportHeight - 12
      ? below
      : Math.max(12, rect.top - cardHeight - gap);
    setProfileCardPosition({ left, top });
    setProfileCardOpen(true);
  };

  useEffect(() => {
    if (!profileCardOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const node = event.target as Node | null;
      if (node && (profileCardRef.current?.contains(node) || profileTriggerRef.current?.contains(node))) {
        return;
      }
      setProfileCardOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setProfileCardOpen(false);
    };
    const closeOnViewportChange = () => setProfileCardOpen(false);
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    window.addEventListener("resize", closeOnViewportChange);
    window.addEventListener("scroll", closeOnViewportChange, true);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("resize", closeOnViewportChange);
      window.removeEventListener("scroll", closeOnViewportChange, true);
    };
  }, [profileCardOpen]);

  useEffect(() => {
    if (isEditing && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.setSelectionRange(editInputRef.current.value.length, editInputRef.current.value.length);
      // Auto-resize initially
      editInputRef.current.style.height = "auto";
      editInputRef.current.style.height = `${Math.min(editInputRef.current.scrollHeight, 200)}px`;
    }
  }, [isEditing]);

  const runFavorite = () => {
    const picked = getContainedSelectionText(msgContentRef.current) ?? actionSelectionRef.current;
    actionSelectionRef.current = null;
    onFavoriteMessage?.(message, picked ?? undefined);
  };

  const runQuote = () => {
    const picked = getContainedSelectionText(msgContentRef.current) ?? actionSelectionRef.current;
    actionSelectionRef.current = null;
    onQuoteMessage?.(message, picked ?? undefined);
  };

  const runWebSearch = () => {
    const picked = getContainedSelectionText(msgContentRef.current) ?? actionSelectionRef.current;
    actionSelectionRef.current = null;
    if (!picked) return;
    onWebSearchMessage?.(message, picked);
  };

  const runQuoteToNewPane = () => {
    const picked = getContainedSelectionText(msgContentRef.current) ?? actionSelectionRef.current;
    actionSelectionRef.current = null;
    onQuoteToNewPane?.(message, picked ?? undefined);
  };

  const preserveActionSelection = () => {
    actionSelectionRef.current = getContainedSelectionText(msgContentRef.current);
  };

  const runSelectAll = () => {
    const root = msgContentRef.current;
    if (!root) return;
    const range = document.createRange();
    range.selectNodeContents(root);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  };

  const runCopy = async () => {
    const picked = getContainedSelectionText(msgContentRef.current);
    if (picked) {
      try {
        await navigator.clipboard.writeText(picked);
      } catch {
        /* clipboard may be unavailable */
      }
      return;
    }
    onCopyMessage?.(message);
  };

  const runForward = () => {
    const picked = getContainedSelectionText(msgContentRef.current);
    onForwardMessage?.(message, picked ?? undefined);
  };

  const formatForwardSender = (sender?: string) => {
    const raw = String(sender || "").trim();
    if (!raw) return "AI";
    return resolveMetaDisplayName(raw.toLowerCase() === "meta" ? null : raw);
  };

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (ev: globalThis.MouseEvent) => {
      // Ignore the right-click that opened the menu (some platforms emit mousedown after contextmenu).
      if (ev.button === 2) return;
      if (menuRef.current && !menuRef.current.contains(ev.target as Node)) {
        setMenuOpen(false);
      }
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") setMenuOpen(false);
    };
    const attach = window.setTimeout(() => {
      window.addEventListener("mousedown", onDown, true);
      window.addEventListener("keydown", onKey);
    }, 0);
    return () => {
      window.clearTimeout(attach);
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  useLayoutEffect(() => {
    if (!menuOpen) {
      setMenuLayout(null);
      return;
    }

    const reposition = () => {
      const menu = menuRef.current;
      if (!menu) return;
      const rect = menu.getBoundingClientRect();
      const maxLeft = Math.max(
        MESSAGE_CONTEXT_MENU_MARGIN,
        window.innerWidth - rect.width - MESSAGE_CONTEXT_MENU_MARGIN,
      );
      const maxTop = Math.max(
        MESSAGE_CONTEXT_MENU_MARGIN,
        window.innerHeight - rect.height - MESSAGE_CONTEXT_MENU_MARGIN,
      );
      const left = Math.min(
        Math.max(menuPos.x, MESSAGE_CONTEXT_MENU_MARGIN),
        maxLeft,
      );
      const top =
        menuPos.y + rect.height <= window.innerHeight - MESSAGE_CONTEXT_MENU_MARGIN
          ? Math.min(Math.max(menuPos.y, MESSAGE_CONTEXT_MENU_MARGIN), maxTop)
          : menuPos.y - rect.height >= MESSAGE_CONTEXT_MENU_MARGIN
            ? menuPos.y - rect.height
            : maxTop;
      setMenuLayout((prev) => (prev?.x === left && prev.y === top ? prev : { x: left, y: top }));
    };

    reposition();
    window.addEventListener("resize", reposition);
    return () => window.removeEventListener("resize", reposition);
  }, [menuOpen, menuPos, menuHasSelection, onEditMessage, onQuoteToNewPane, onRetryMessage]);

  useEffect(() => {
    // NOTE: Keyword highlight used to mutate React-managed DOM nodes directly,
    // which can trigger removeChild/not-a-child crashes during reconciliation.
    // Keep this as a no-op until a fully declarative highlight renderer is added.
  }, [highlightTerms, message.content, message.quotedContent, message.forwardedHistory, isStreaming, isGroupTyping, hasBody]);

  const openContextMenu = (ev: ReactMouseEvent) => {
    ev.preventDefault();
    ev.stopPropagation();
    const picked = getContainedSelectionText(msgContentRef.current);
    actionSelectionRef.current = picked;
    setMenuHasSelection(Boolean(picked));
    setMenuPos({ x: ev.clientX, y: ev.clientY });
    setMenuLayout(null);
    setMenuOpen(true);
  };

  const showAssistantFollowups = shouldShowAssistantFollowups({
    isUser,
    isStreaming,
    isGroupTyping,
    omitSuggestedQuestions,
    hasBody,
    hasSuggestedQuestions: Boolean(message.suggestedQuestions?.length),
    hasFollowupHandler: Boolean(onFollowupClick),
    sessionBusy,
    isLastAssistantInPane,
  });
  const assistantTextClassName = !isUser
    ? getAssistantTextClassName({
        hasReasoning: Boolean(parsed?.reasoning),
        inReActRow: compactAssistant,
      })
    : undefined;
  const assistantTextStyle = !isUser
    ? getAssistantTextStyle({ hasReasoning: Boolean(parsed?.reasoning), inReActRow: compactAssistant })
    : undefined;
  const assistantActionStyle = getAssistantActionStyle({ inReActRow: compactAssistant });
  const USER_BUBBLE_GUTTER_PX = 14;
  const headerBadge = showExpertLabel ? badge : null;
  const contentBadge = headerBadge ? null : badge;
  const userBubbleGutterPx = USER_BUBBLE_GUTTER_PX;
  const canFoldExpertReply =
    showExpertLabel && !isStreaming && !isGroupTyping && !isMetaPendingWork && hasBody;
  // Gutter 挂在 stack 上（非整气泡 margin），保证操作栏与气泡边框同宽、左右缘对齐。
  const userStackStyle = isUser
    ? {
        marginLeft: userBubbleGutterPx,
        marginRight: userBubbleGutterPx,
        maxWidth: `calc(100% - ${userBubbleGutterPx * 2}px)`,
      }
    : undefined;
  const userBubbleStyle = isUser
    ? {
        ...bubbleStyle,
        width: "fit-content",
        maxWidth: "100%",
      }
    : bubbleStyle;
  const canReactToGroupMessage = Boolean(
    enableGroupReactions &&
      !isStreaming &&
      !isGroupTyping &&
      isPublicGroupMessage(message) &&
      onToggleReaction,
  );
  const hasGroupReactions = Boolean(
    enableGroupReactions &&
      isPublicGroupMessage(message) &&
      message.reactions &&
      message.reactions.length > 0,
  );

  // Feedback visibility is independent from the action toolbar's hover gate,
  // but the controls themselves live in that same operation bar. Completed
  // bodies remain represented while scope/list hydration is unavailable;
  // streaming, typing, and partial rows remain ineligible.
  const canShowAssistantFeedback = Boolean(
    !isUser &&
      isCompletedAssistantForFeedback(message) &&
      !isStreaming &&
      !isGroupTyping &&
      !isMetaPendingWork &&
      Boolean(bodyText?.trim()),
  );

  const assistantFeedbackControls = canShowAssistantFeedback
    ? feedbackControls ?? (
        <AssistantFeedback
          message={message}
          bodyText={bodyText}
          value={feedbackValue}
          pending={feedbackPending}
          status={feedbackStatus}
          onFeedback={onFeedback}
          disabledReason={feedbackDisabledReason}
          onRetryFeedbackLoad={onRetryFeedbackLoad}
        />
      )
    : null;

  const showAssistantActionButtons = shouldShowAssistantIconButtons({
    hideActions,
    isUser,
    isStreaming,
    isGroupTyping,
    isMetaPendingWork,
    hasBody,
    sessionBusy,
    isLastAssistantInPane,
  });
  // A completed answer keeps its operation bar even when the normal toolbar
  // suppresses the current last reply during an active run. This prevents the
  // feedback entry from disappearing merely because another action is gated.
  const assistantIconButtons =
    showAssistantActionButtons || (canShowAssistantFeedback && !hideActions) ? (
      <div
        className="inline-flex min-w-0 items-center gap-0.5"
        data-message-actions="assistant"
      >
        <HoverTip label="复制">
          <button
            type="button"
            className="rounded p-1 hover:bg-surface-hover hover:text-text-strong"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onCopyMessage?.(message)}
          >
            <Copy size={13} />
          </button>
        </HoverTip>
        <HoverTip label="引用">
          <button
            type="button"
            className="rounded p-1 hover:bg-surface-hover hover:text-text-strong"
            onMouseDown={(e) => {
              e.preventDefault();
              preserveActionSelection();
            }}
            onClick={runQuote}
          >
            <Quote size={13} />
          </button>
        </HoverTip>
        <HoverTip label="收藏">
          <button type="button" className="rounded p-1 hover:bg-surface-hover hover:text-text-strong" onMouseDown={(e) => e.preventDefault()} onClick={runFavorite}>
            <Bookmark size={13} />
          </button>
        </HoverTip>
        <HoverTip label="转发">
          <button type="button" className="rounded p-1 hover:bg-surface-hover hover:text-text-strong" onMouseDown={(e) => e.preventDefault()} onClick={runForward}>
            <Forward size={13} />
          </button>
        </HoverTip>
        {onRetryMessage ? (
          <HoverTip label="重试">
            <button
              type="button"
              className="rounded p-1 hover:bg-surface-hover hover:text-text-strong"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onRetryMessage(message)}
            >
              <RotateCcw size={13} />
            </button>
          </HoverTip>
        ) : null}
        <HoverTip label="多选">
          <button
            type="button"
            className={`rounded p-1 hover:bg-surface-hover ${
              selected
                ? "text-[rgb(var(--theme-color-fg-rgb,59,130,246))] hover:opacity-90"
                : "hover:text-text-strong"
            }`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onToggleSelectMessage?.(message)}
          >
            <LayoutList size={13} />
          </button>
        </HoverTip>
        {assistantFeedbackControls}
      </div>
    ) : null;

  const assistantFollowupChipButtons =
    showAssistantFollowups && message.suggestedQuestions ? (
      <>
        {message.suggestedQuestions.slice(0, 3).map((q, qi) => (
          <button
            key={`${qi}-${q}`}
            type="button"
            className={ASSISTANT_FOLLOWUP_CHIP_CLASS}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() =>
              onFollowupClick?.(q, { ownerSessionId: message.ownerSessionId })
            }
          >
            <span>{q}</span>
            <ArrowRight className="h-3 w-3 shrink-0 opacity-50 transition group-hover:opacity-80" />
          </button>
        ))}
      </>
    ) : null;

  const pendingWorkCompact = isMetaPendingWork || (compactAssistant && isStreaming && !hasBody);
  // Inside the ReAct rail (compact-inline rows stacked flush with no parent gap),
  // every row must rely solely on its own `py-1` for a uniform 8px rhythm. The
  // streaming `!mt-1` / `-mt-1` nudges are meant for the standalone assistant
  // bubble and, when applied to a streaming reasoning/dots row in the rail, make
  // that row sit 4px higher/lower than the committed rows above it — the uneven
  // line spacing reported in production. Neutralize them for rail rows only.
  const railRow = compactAssistant && noBubbleBorder;
  const assistantActionRhythmStack = !isUser && showAssistantFollowups;
  const tightenAssistantBodyLeading = assistantActionRhythmStack || actionRhythmBodyTail;
  const assistantBodyLeadingClass = tightenAssistantBodyLeading ? "leading-snug" : "leading-relaxed";

  return (
    <div
      className={`group relative flex min-w-0 items-start gap-2${
        !railRow && isStreaming && !pendingWorkCompact ? " !mt-1" : ""
      }${!railRow && pendingWorkCompact ? " -mt-1" : ""}`}
      onContextMenu={openContextMenu}
    >
      {selectable ? (
        <button
          type="button"
          className={`mt-8 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border transition ${
            selected
              ? "border-[rgb(var(--theme-color-rgb,6,182,212))] bg-[rgb(var(--theme-color-rgb,6,182,212))] text-[var(--theme-color-text)]"
              : "border-text-faint bg-transparent text-transparent"
          }`}
          onClick={() => onToggleSelectMessage?.(message)}
          aria-label={selected ? "取消选择消息" : "选择消息"}
        >
          <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M3.5 8.5L6.5 11.5L12.5 4.5" />
          </svg>
        </button>
      ) : null}
      <div
        className={`flex min-w-0 flex-1 flex-col ${isUser ? "items-end" : "items-start"}${assistantActionRhythmStack ? ` agx-assistant-action-rhythm mb-6 ${ASSISTANT_ACTION_RHYTHM_GAP_CLASS}` : ""}`}
      >
        {showExpertLabel && expertChip ? (
          <div className="mb-1 flex max-w-full items-center gap-2 px-3">
            <div
              className="inline-flex max-w-full items-center overflow-hidden rounded-xl border text-[13px] font-semibold"
              style={{
                backgroundColor: expertChip.backgroundColor,
                borderColor: expertChip.borderColor,
              }}
            >
              {canOpenSenderProfile ? (
                <button
                  ref={profileTriggerRef}
                  type="button"
                  className="inline-flex min-w-0 items-center gap-2 px-2 py-1 text-left transition hover:bg-black/[0.035] dark:hover:bg-white/[0.05]"
                  onClick={(event) => openSenderProfileCard(event.currentTarget)}
                  aria-haspopup="dialog"
                  aria-expanded={profileCardOpen}
                  title={`查看${displayName}的专家名片`}
                >
                  <ChatImAvatar
                    label={displayName}
                    imageUrl={assistantAvatarUrl}
                    variant={_senderAvatarVariant}
                    avatarId={senderAvatarId}
                  />
                  {stableSenderRoleLabel ? (
                    <span className="shrink-0 rounded-full border border-border/70 px-1.5 py-0.5 text-[10px] font-medium text-text-muted">
                      {stableSenderRoleLabel}
                    </span>
                  ) : null}
                  <span className="min-w-0 truncate" style={{ color: expertChip.color }}>
                    {displayName}
                  </span>
                  {trailingWorkflowRoleLabel ? (
                    <span className="shrink-0 rounded-full border border-border/70 px-1.5 py-0.5 text-[10px] font-medium text-text-muted">
                      {trailingWorkflowRoleLabel}
                    </span>
                  ) : null}
                  {headerBadge ? (
                    <span className="shrink-0 font-medium" style={{ color: expertChip.color }}>
                      {headerBadge}
                    </span>
                  ) : null}
                </button>
              ) : (
                <span className="inline-flex min-w-0 items-center gap-2 px-2 py-1">
                  <ChatImAvatar
                    label={displayName}
                    imageUrl={assistantAvatarUrl}
                    variant={_senderAvatarVariant}
                    avatarId={senderAvatarId}
                  />
                  {stableSenderRoleLabel ? (
                    <span className="shrink-0 rounded-full border border-border/70 px-1.5 py-0.5 text-[10px] font-medium text-text-muted">
                      {stableSenderRoleLabel}
                    </span>
                  ) : null}
                  <span className="min-w-0 truncate" style={{ color: expertChip.color }}>
                    {displayName}
                  </span>
                  {trailingWorkflowRoleLabel ? (
                    <span className="shrink-0 rounded-full border border-border/70 px-1.5 py-0.5 text-[10px] font-medium text-text-muted">
                      {trailingWorkflowRoleLabel}
                    </span>
                  ) : null}
                  {headerBadge ? (
                    <span className="shrink-0 font-medium" style={{ color: expertChip.color }}>
                      {headerBadge}
                    </span>
                  ) : null}
                </span>
              )}
              {canFoldExpertReply ? (
              <button
                type="button"
                className="inline-flex shrink-0 items-center gap-1 self-stretch border-l border-border/70 px-2 text-[11px] font-medium text-text-subtle transition hover:bg-black/[0.035] hover:text-text-primary dark:hover:bg-white/[0.05]"
                onClick={() => setExpertCollapsed((v) => !v)}
                aria-expanded={!expertCollapsed}
                title={expertCollapsed ? "展开回复" : "折叠回复"}
              >
                {expertCollapsed ? (
                  <ChevronRight className="h-3.5 w-3.5 shrink-0 text-text-subtle" strokeWidth={2.2} />
                ) : (
                  <ChevronDown className="h-3.5 w-3.5 shrink-0 text-text-subtle" strokeWidth={2.2} />
                )}
                {expertCollapsed ? "展开" : "折叠"}
              </button>
              ) : null}
            </div>
          </div>
        ) : null}
        {profileCardOpen && senderProfile && senderAvatarId && onOpenSenderProfile
          ? createPortal(
              <div
                ref={profileCardRef}
                role="dialog"
                aria-label={`${senderProfile.name}专家名片`}
                className="fixed z-[70] w-[320px] overflow-hidden rounded-2xl border border-border bg-surface-panel shadow-2xl"
                style={profileCardPosition}
              >
                <div className="border-b border-border bg-surface-card px-4 py-4">
                  <div className="flex items-start gap-3">
                    <GroupMemberAvatar avatar={senderProfile} size="lg" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <div className="truncate text-[15px] font-semibold text-text-strong">
                          {senderProfile.name}
                        </div>
                        <span className="shrink-0 rounded-full border border-border px-1.5 py-0.5 text-[9px] font-medium text-text-faint">
                          {senderProfile.createdBy === "enterprise_managed" ? "企业专家" : "数字专家"}
                        </span>
                      </div>
                      <div className="mt-1 truncate text-xs text-text-muted">
                        {senderProfile.role || "智能协作伙伴"}
                      </div>
                    </div>
                    <button
                      type="button"
                      className="rounded-lg p-1 text-text-faint transition hover:bg-surface-hover hover:text-text-primary"
                      aria-label="关闭专家名片"
                      onClick={() => setProfileCardOpen(false)}
                    >
                      <X className="h-4 w-4" strokeWidth={1.8} />
                    </button>
                  </div>
                </div>
                <div className="space-y-3 px-4 py-3.5">
                  <div>
                    <div className="text-[10px] font-medium uppercase tracking-[0.08em] text-text-faint">签名</div>
                    <p className="mt-1 line-clamp-3 text-xs leading-relaxed text-text-muted">
                      {senderProfile.description?.trim() || "这个专家还没有填写签名。"}
                    </p>
                  </div>
                  {senderProfile.tags && senderProfile.tags.length > 0 ? (
                    <div className="flex flex-wrap gap-1.5">
                      {senderProfile.tags.slice(0, 4).map((tag) => (
                        <span key={tag} className="rounded-md bg-surface-card px-1.5 py-0.5 text-[10px] text-text-subtle">
                          {tag}
                        </span>
                      ))}
                    </div>
                  ) : null}
                  <div className="flex items-center justify-between gap-3 border-t border-border pt-3 text-[10px] text-text-faint">
                    <span>
                      默认权限：{{ plan: "仅规划", ask: "操作前询问", auto: "自动执行" }[senderProfile.defaultPermissionMode || "ask"]}
                    </span>
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 rounded-lg bg-[rgba(var(--theme-color-rgb,59,130,246),0.12)] px-2.5 py-1.5 text-[11px] font-medium text-[rgb(var(--theme-color-fg-rgb,59,130,246))] transition hover:bg-[rgba(var(--theme-color-rgb,59,130,246),0.2)]"
                      onClick={() => {
                        setProfileCardOpen(false);
                        onOpenSenderProfile(senderAvatarId);
                      }}
                    >
                      查看完整资料
                      <ExternalLink className="h-3 w-3" strokeWidth={1.8} aria-hidden />
                    </button>
                  </div>
                </div>
              </div>,
              document.body,
            )
          : null}
        {isEditing ? (
          <div className="flex w-full max-w-3xl items-end gap-2">
            <button
              type="button"
              className="mb-1 p-1.5 text-text-faint hover:text-text-strong transition"
              onClick={() => setIsEditing(false)}
            >
              <X size={16} />
            </button>
            <div className="flex-1 rounded-xl border border-[rgb(var(--theme-color-rgb,6,182,212))] bg-surface-card flex items-end p-1">
              <textarea
                ref={editInputRef}
                value={editContent}
                onChange={(e) => setEditContent(e.target.value)}
                className="w-full resize-none bg-transparent px-2 py-1.5 text-[var(--agx-chat-im-body-font-size)] text-text-strong outline-none"
                rows={1}
                onKeyDown={(e) => {
                  const isImeComposing = e.nativeEvent.isComposing || e.key === "Process" || e.keyCode === 229;
                  if (isImeComposing) return;
                  
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    e.stopPropagation();
                    if (editContent.trim() && onEditMessage) {
                      onEditMessage(message, editContent);
                      setIsEditing(false);
                    }
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    e.stopPropagation();
                    setIsEditing(false);
                  }
                }}
                onInput={(e) => {
                  const target = e.target as HTMLTextAreaElement;
                  target.style.height = "auto";
                  target.style.height = `${Math.min(target.scrollHeight, 200)}px`;
                }}
              />
              <button
                type="button"
                className="m-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[rgb(var(--theme-color-rgb,6,182,212))] text-white transition hover:opacity-90 disabled:opacity-50"
                disabled={!editContent.trim()}
                onClick={() => {
                  if (editContent.trim() && onEditMessage) {
                    onEditMessage(message, editContent);
                    setIsEditing(false);
                  }
                }}
              >
                <ArrowUp size={16} strokeWidth={2.5} />
              </button>
            </div>
          </div>
        ) : isUser ? (
          <div className="agx-im-user-stack" style={userStackStyle}>
            {/* Trae-style: attachment chips sit above the text bubble, not inside it. */}
            {displayAttachments.length > 0 ? (
              <div className="mb-1.5 flex flex-wrap justify-end gap-2">
                {displayAttachments.map((attachment) => (
                  <AttachmentCard
                    key={`${attachment.name}:${attachment.size}:${attachment.mimeType}`}
                    attachment={attachment}
                  />
                ))}
              </div>
            ) : null}
            {hasBody || message.forwardedHistory || contentBadge ? (
            <div
              className="agx-im-user-bubble relative min-w-0 max-w-full rounded-xl border-0 px-3.5 py-2.5 text-[var(--agx-chat-im-body-font-size)] leading-relaxed rounded-tr-[4px]"
              style={userBubbleStyle}
            >
              <div ref={msgContentRef} className="msg-content min-w-0 break-words">
                {contentBadge}
                {message.forwardedHistory ? (
                  <div className="space-y-2">
                    <div className="rounded-md border border-border bg-surface-panel/70 px-2 py-1 text-xs text-text-faint">
                      {message.forwardedHistory.note ? (
                        <div className="mb-1 break-words text-text-primary">{message.forwardedHistory.note}</div>
                      ) : null}
                      <div className="space-y-1">
                        {message.forwardedHistory.items.slice(0, 2).map((item, index) => (
                          <div
                            key={`${item.sender}-${index}-${item.content.slice(0, 20)}`}
                            className="line-clamp-2 break-words"
                          >
                            {formatForwardSender(item.sender)}: {item.content}
                          </div>
                        ))}
                        {message.forwardedHistory.items.length > 2 ? (
                          <div className="text-[11px] text-text-faint">...</div>
                        ) : null}
                      </div>
                    </div>
                  </div>
                ) : bodyText.trim() || displayQuotedItems.length > 0 ? (
                  <div className="whitespace-pre-wrap break-words">
                    {renderUserBubbleInlineContent(
                      bodyText,
                      displayQuotedItems,
                      referenceAttachments,
                      onOpenFileReference
                    )}
                  </div>
                ) : null}
              </div>
            </div>
            ) : (
              <div ref={msgContentRef} className="hidden" aria-hidden />
            )}
            {hasGroupReactions ? (
              <div className="flex justify-end">
                <GroupReactionPills message={message} onToggleReaction={onToggleReaction} />
              </div>
            ) : null}
            {hideActions ? null : (
              <div className="agx-im-user-actions">
                <div className="agx-im-user-actions-icons">
                  <MessageTimestamp ts={message.timestamp} align="right" />
                  <HoverTip label="复制">
                    <button
                      type="button"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => onCopyMessage?.(message)}
                    >
                      <Copy size={13} strokeWidth={1.5} />
                    </button>
                  </HoverTip>
                  <HoverTip label="引用">
                    <button
                      type="button"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        preserveActionSelection();
                      }}
                      onClick={runQuote}
                    >
                      <Quote size={13} strokeWidth={1.5} />
                    </button>
                  </HoverTip>
                  <HoverTip label="收藏">
                    <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={runFavorite}>
                      <Bookmark size={13} strokeWidth={1.5} />
                    </button>
                  </HoverTip>
                  <HoverTip label="转发">
                    <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={runForward}>
                      <Forward size={13} strokeWidth={1.5} />
                    </button>
                  </HoverTip>
                  {onEditMessage ? (
                    <HoverTip label="修改">
                      <button
                        type="button"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => {
                          setEditContent(message.content);
                          setIsEditing(true);
                        }}
                      >
                        <Pencil size={13} strokeWidth={1.5} />
                      </button>
                    </HoverTip>
                  ) : null}
                  {onRetryMessage ? (
                    <HoverTip label="重试">
                      <button
                        type="button"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => onRetryMessage(message)}
                      >
                        <RotateCcw size={13} strokeWidth={1.5} />
                      </button>
                    </HoverTip>
                  ) : null}
                  <HoverTip label="多选" tooltipAlign="end">
                    <button
                      type="button"
                      className={
                        selected
                          ? "text-[rgb(var(--theme-color-fg-rgb,59,130,246))] hover:opacity-90"
                          : undefined
                      }
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => onToggleSelectMessage?.(message)}
                    >
                      <LayoutList size={13} strokeWidth={1.5} />
                    </button>
                  </HoverTip>
                </div>
              </div>
            )}
          </div>
        ) : expertCollapsed && canFoldExpertReply ? (
          <>
            {/* Body hidden while folded — expand via expert label. Keep root for copy/quote. */}
            <div ref={msgContentRef} className="hidden" aria-hidden>
              {bodyText}
            </div>
            {hideActions || !assistantIconButtons ? null : (
              <div className={ASSISTANT_ACTION_ICON_ONLY_CLASS}>
                <div className={ASSISTANT_ACTION_ICON_ROW_CLASS} style={assistantActionStyle}>
                  {assistantIconButtons}
                  <MessageTimestamp ts={message.timestamp} align="left" />
                </div>
              </div>
            )}
          </>
        ) : (
          <>
            <div
              className={
                compactAssistant && noBubbleBorder
                  ? `relative min-w-0 w-full px-3 py-0 text-[var(--agx-chat-im-body-font-size)] ${assistantBodyLeadingClass}`
                    : isMetaPendingWork
                      ? `relative min-w-0 w-full px-3 py-0 text-[var(--agx-chat-im-body-font-size)] ${assistantBodyLeadingClass}`
                      : showExpertLabel
                      ? `agx-expert-body relative min-w-0 w-full max-w-[min(100%,56rem)] rounded-2xl border px-4 py-3 text-[var(--agx-chat-im-body-font-size)] shadow-sm ${assistantBodyLeadingClass}`
                      : (message.references?.length ?? 0) > 0
                        ? `relative min-w-0 w-full px-3 pt-1 pb-0 text-[var(--agx-chat-im-body-font-size)] ${assistantBodyLeadingClass}`
                        : `relative min-w-0 w-full px-3 pt-3 pb-0 text-[var(--agx-chat-im-body-font-size)] ${assistantBodyLeadingClass}`
              }
              style={compactAssistant && noBubbleBorder ? undefined : userBubbleStyle}
            >
              <div ref={msgContentRef} className="msg-content min-w-0 break-words">
                {displayAttachments.length > 0 ? (
                  <div className="mb-2 flex flex-wrap gap-2">
                    {displayAttachments.map((attachment) => (
                      <AttachmentCard
                        key={`${attachment.name}:${attachment.size}:${attachment.mimeType}`}
                        attachment={attachment}
                      />
                    ))}
                  </div>
                ) : null}
                {contentBadge}
                {displayQuotedItems.length > 0 ? (
                  <div className="mb-1.5">
                    {displayQuotedItems.map((quoted, idx) => (
                      <span key={`aq-${idx}-${quoted.slice(0, 12)}`}>
                        <UserQuoteRefChip quoted={quoted} />
                        {idx < displayQuotedItems.length - 1 ? " " : null}
                      </span>
                    ))}
                  </div>
                ) : null}
                {message.forwardedHistory ? (
                  <div className="space-y-2">
                    <div className="rounded-md border border-border bg-surface-panel/70 px-2 py-1 text-xs text-text-faint">
                      {message.forwardedHistory.note ? (
                        <div className="mb-1 break-words text-text-primary">{message.forwardedHistory.note}</div>
                      ) : null}
                      <div className="space-y-1">
                        {message.forwardedHistory.items.slice(0, 2).map((item, index) => (
                          <div
                            key={`${item.sender}-${index}-${item.content.slice(0, 20)}`}
                            className="line-clamp-2 break-words"
                          >
                            {formatForwardSender(item.sender)}: {item.content}
                          </div>
                        ))}
                        {message.forwardedHistory.items.length > 2 ? (
                          <div className="text-[11px] text-text-faint">...</div>
                        ) : null}
                      </div>
                    </div>
                  </div>
                ) : isMetaPendingWork ? (
                  streamStalled ? (
                    <StalledStreamIndicator silentSeconds={streamStalledSeconds} />
                  ) : (
                    <StreamingDots compact />
                  )
                ) : isGroupTyping ? (
                  bodyText?.trim() ? (
                    <div className="flex min-w-0 items-center gap-2 text-[13px]">
                      <Shimmer
                        variant="status"
                        text={bodyText.trim()}
                        className="min-w-0 break-words leading-[1.65]"
                      />
                      <StreamingDots compact />
                    </div>
                  ) : (
                    <StreamingDots compact />
                  )
                ) : (
                  <>
                    {(citationReferences?.length ?? 0) > 0 ? (
                      <ReferencesCard
                        references={citationReferences ?? []}
                        searchedQueries={message.searchedQueries}
                      />
                    ) : null}
                    {message.reasoning &&
                    !isStreaming &&
                    !reasoningDuplicatesVisibleBody(message.reasoning, bodyText) ? (
                      <ReasoningBlock
                        text={message.reasoning}
                        seconds={resolvePersistedReasoningSeconds(message.reasoning, message.reasoningSeconds)}
                      />
                    ) : null}
                    {!message.reasoning &&
                    parsed?.reasoning &&
                    !reasoningDuplicatesVisibleBody(parsed.reasoning, bodyText) ? (
                      <ReasoningBlock
                        text={parsed.reasoning}
                        seconds={
                          isStreaming
                            ? undefined
                            : resolvePersistedReasoningSeconds(parsed.reasoning, message.reasoningSeconds)
                        }
                        streaming={isStreaming && hasThinkTag && !reasoningClosed}
                      />
                    ) : null}
                    {isStreaming && !hasBody && (!hasThinkTag || reasoningClosed) ? (
                      streamStalled ? (
                        <StalledStreamIndicator silentSeconds={streamStalledSeconds} />
                      ) : (
                        <StreamingDots compact={compactAssistant && noBubbleBorder} />
                      )
                    ) : null}
                    {hasBody ? (
                      <div
                        className={showExpertLabel ? undefined : assistantTextClassName}
                        style={assistantTextStyle}
                      >
                        <CitationMarkdownBody
                          content={bodyText}
                          references={citationReferences}
                          isStreaming={isStreaming}
                          onQuoteText={(text) => onQuoteMessage?.(message, text)}
                          onRevealPath={onRevealPath}
                        />
                      </div>
                    ) : null}
                    {isStreaming && hasBody && (!hasThinkTag || reasoningClosed) ? (
                      streamStalled ? (
                        <StalledStreamIndicator silentSeconds={streamStalledSeconds} />
                      ) : (
                        <StreamingDots compact={compactAssistant && noBubbleBorder} />
                      )
                    ) : null}
                  </>
                )}
              </div>
            </div>
            {hasGroupReactions ? (
              <GroupReactionPills message={message} onToggleReaction={onToggleReaction} />
            ) : null}
            {afterBody ? (
              <div className="agx-artifact-action-row mt-2 flex w-full min-w-0 items-center gap-1.5 px-3">
                <div className="min-w-0 flex-1">{afterBody}</div>
                {assistantIconButtons && !showAssistantFollowups ? (
                  <div className={`${ASSISTANT_ACTION_ICON_ROW_CLASS} shrink-0 self-center`}>
                    {assistantIconButtons}
                    <MessageTimestamp ts={message.timestamp} align="left" />
                  </div>
                ) : null}
              </div>
            ) : null}
            {budgetIncompleteHint ? (
              <p className="-mt-0.5 mb-1 px-3 text-[11px] leading-relaxed text-text-faint">
                此回复因会话预算上限被截停，未完成
              </p>
            ) : null}
            {showAssistantFollowups && assistantIconButtons ? (
              <>
                <div className={ASSISTANT_ACTION_ICON_ROW_CLASS} style={assistantActionStyle}>
                  {assistantIconButtons}
                  <MessageTimestamp ts={message.timestamp} align="left" />
                </div>
                <div className={ASSISTANT_FOLLOWUP_LIST_CLASS} style={assistantActionStyle}>
                  {assistantFollowupChipButtons}
                </div>
              </>
            ) : showAssistantFollowups ? (
              <div className={ASSISTANT_FOLLOWUP_LIST_CLASS} style={assistantActionStyle}>
                {assistantFollowupChipButtons}
              </div>
            ) : null}
            {hideActions || showAssistantFollowups || !assistantIconButtons || afterBody ? null : (
              <div className={ASSISTANT_ACTION_ICON_ONLY_CLASS}>
                <div className={ASSISTANT_ACTION_ICON_ROW_CLASS} style={assistantActionStyle}>
                  {assistantIconButtons}
                  <MessageTimestamp ts={message.timestamp} align="left" />
                </div>
              </div>
            )}
          </>
        )}
      </div>
      {menuOpen ? createPortal(
        <div
          ref={menuRef}
          className="fixed z-[200] max-h-[calc(100vh-1rem)] w-44 overflow-y-auto rounded-lg border border-border bg-surface-base p-1 shadow-2xl"
          style={{
            left: menuLayout?.x ?? menuPos.x,
            top: menuLayout?.y ?? menuPos.y,
            visibility: menuLayout ? "visible" : "hidden",
          }}
          role="menu"
        >
          <button
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-text-primary hover:bg-surface-hover"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => { void runCopy(); setMenuOpen(false); }}
          >
            <Copy size={12} className="shrink-0 text-text-faint" />复制
          </button>
          <button
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-text-primary hover:bg-surface-hover"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => { setMenuOpen(false); runQuote(); }}
          >
            <Quote size={12} className="shrink-0 text-text-faint" />引用至当前对话
          </button>
          <button
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-text-primary hover:bg-surface-hover"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => { setMenuOpen(false); runSelectAll(); }}
          >
            <TextSelect size={12} className="shrink-0 text-text-faint" />全选
          </button>
          <button
            className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-surface-hover ${
              menuHasSelection && onWebSearchMessage
                ? "text-text-primary"
                : "cursor-not-allowed text-text-faint opacity-50"
            }`}
            disabled={!menuHasSelection || !onWebSearchMessage}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => { setMenuOpen(false); runWebSearch(); }}
          >
            <Search size={12} className="shrink-0 text-text-faint" />用网络搜索
          </button>
          {onQuoteToNewPane ? (
            <button
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-text-primary hover:bg-surface-hover"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => { setMenuOpen(false); runQuoteToNewPane(); }}
            >
              <MessageSquarePlus size={12} className="shrink-0 text-text-faint" />引用至新对话
            </button>
          ) : null}
          <button
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-text-primary hover:bg-surface-hover"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => { setMenuOpen(false); runFavorite(); }}
          >
            <Bookmark size={12} className="shrink-0 text-text-faint" />收藏
          </button>
          <button
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-text-primary hover:bg-surface-hover"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => { setMenuOpen(false); runForward(); }}
          >
            <Forward size={12} className="shrink-0 text-text-faint" />转发
          </button>
          {onEditMessage ? (
            <button
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-text-primary hover:bg-surface-hover"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setMenuOpen(false);
                setEditContent(message.content);
                setIsEditing(true);
              }}
            >
              <Pencil size={12} className="shrink-0 text-text-faint" />修改
            </button>
          ) : null}
          {onRetryMessage ? (
            <button
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-text-primary hover:bg-surface-hover"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => { setMenuOpen(false); onRetryMessage(message); }}
            >
              <RotateCcw size={12} className="shrink-0 text-text-faint" />重试
            </button>
          ) : null}
          {canReactToGroupMessage ? (
            <div className="border-t border-border/70 px-2 py-1.5">
              <div className="mb-1 text-[10px] text-text-faint">回应</div>
              <div className="flex items-center gap-0.5">
                {GROUP_REACTION_EMOJIS.map((emoji) => (
                  <button
                    key={emoji}
                    type="button"
                    className="flex h-7 w-7 items-center justify-center rounded-md text-[15px] transition hover:bg-surface-hover"
                    aria-label={`回应 ${emoji}`}
                    title={`回应 ${emoji}`}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      setMenuOpen(false);
                      onToggleReaction?.(message, emoji);
                    }}
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          <button
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-text-primary hover:bg-surface-hover"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => { setMenuOpen(false); onToggleSelectMessage?.(message); }}
          >
            <LayoutList size={12} className="shrink-0 text-text-faint" />多选
          </button>
        </div>,
        document.body,
      ) : null}
    </div>
  );
}
