import { LoaderCircle, ThumbsDown, ThumbsUp } from "lucide-react";
import type { Message } from "../../store";
import {
  resolveChatFeedbackClick,
  type ChatFeedbackAction,
  type ChatFeedbackStatus,
  type ChatFeedbackValue,
} from "../../utils/chat-feedback";
import { isCompletedAssistantForFeedback } from "../../utils/feedback-message-completion";
import { isGroupStreamMessageId } from "../../utils/group-stream-text";

export type AssistantFeedbackProps = {
  message: Message;
  /** Parsed body text. This prevents reasoning-only or protocol-only rows from being votable. */
  bodyText?: string;
  value?: ChatFeedbackValue | null;
  pending?: boolean;
  status?: ChatFeedbackStatus;
  /** Undefined means that the answer is visible but the trusted write handshake is unavailable. */
  onFeedback?: (
    messageId: string,
    value: ChatFeedbackValue | null,
    action?: ChatFeedbackAction,
  ) => void | Promise<void>;
  /** Short reason shown beside disabled controls while the read/write path is unavailable. */
  disabledReason?: string;
  /** Retry only the trusted scope/list hydration; it never creates or changes a vote. */
  onRetryFeedbackLoad?: () => void | Promise<void>;
};

/**
 * The one feedback affordance used by IM, clean, and terminal message layouts.
 * Visibility is deliberately independent from the action toolbar: the controls
 * stay in a stable inline segment of the message operation bar and remain
 * present while the account handshake is loading or unavailable.
 */
export function AssistantFeedback({
  message,
  bodyText,
  value = null,
  pending = false,
  status,
  onFeedback,
  disabledReason,
  onRetryFeedbackLoad,
}: AssistantFeedbackProps) {
  const visibleBody = String(bodyText ?? message.content ?? "").trim();
  const syntheticStreamingRow =
    message.id === "__stream__" ||
    isGroupStreamMessageId(message.id) ||
    message.id === "typing-meta" ||
    message.id.startsWith("typing-");
  if (
    message.role !== "assistant" ||
    !visibleBody ||
    syntheticStreamingRow ||
    !isCompletedAssistantForFeedback(message)
  ) {
    return null;
  }

  const writeUnavailable = !onFeedback || Boolean(disabledReason);
  const controlsDisabled = pending || writeUnavailable;
  const reason = disabledReason || (!onFeedback ? "反馈暂不可用" : "");

  const handleFeedback = (requested: ChatFeedbackValue) => {
    if (!onFeedback || controlsDisabled) return;
    const click = resolveChatFeedbackClick(value, requested, status);
    void onFeedback(message.id, click.value, click.action);
  };

  return (
    <span
      className="ml-1 inline-flex min-w-0 items-center gap-0.5 border-l border-border/70 pl-1.5 text-xs"
      data-feedback-controls="assistant"
      data-feedback-disabled={writeUnavailable ? "true" : undefined}
    >
      <button
        type="button"
        data-feedback-control="like"
        className={`rounded p-1 text-text-faint transition hover:bg-surface-hover hover:text-text-strong disabled:cursor-not-allowed disabled:opacity-45 ${
          value === "like" ? "text-[var(--status-success)] hover:text-[var(--status-success)]" : ""
        }`}
        aria-label={value === "like" ? "取消有帮助反馈" : "有帮助"}
        aria-pressed={value === "like"}
        aria-busy={pending}
        disabled={controlsDisabled}
        title={reason || (value === "like" ? "取消有帮助反馈" : "有帮助")}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => handleFeedback("like")}
      >
        <ThumbsUp size={13} className={value === "like" ? "fill-current" : undefined} aria-hidden />
      </button>
      <button
        type="button"
        data-feedback-control="dislike"
        className={`rounded p-1 text-text-faint transition hover:bg-surface-hover hover:text-text-strong disabled:cursor-not-allowed disabled:opacity-45 ${
          value === "dislike" ? "text-[var(--status-error)] hover:text-[var(--status-error)]" : ""
        }`}
        aria-label={value === "dislike" ? "取消没帮助反馈" : "没帮助"}
        aria-pressed={value === "dislike"}
        aria-busy={pending}
        disabled={controlsDisabled}
        title={reason || (value === "dislike" ? "取消没帮助反馈" : "没帮助")}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => handleFeedback("dislike")}
      >
        <ThumbsDown size={13} className={value === "dislike" ? "fill-current" : undefined} aria-hidden />
      </button>
      {pending ? (
        <span className="ml-1 inline-flex items-center gap-1 text-[11px] text-text-faint" role="status" aria-live="polite">
          <LoaderCircle className="h-3 w-3 animate-spin" aria-hidden />
          正在保存反馈…
        </span>
      ) : status === "success" ? (
        <span className="ml-1 text-[11px] text-[var(--status-success)]" role="status" aria-live="polite">
          {value ? "反馈已记录" : "已取消反馈"}
        </span>
      ) : status === "error" ? (
        <span className="ml-1 text-[11px] text-[var(--status-error)]" role="status" aria-live="assertive">
          保存失败，请重试
        </span>
      ) : status === "learning-error" ? (
        <span className="ml-1 inline-flex items-center gap-2 text-[11px] text-[var(--status-error)]" role="status" aria-live="assertive">
          <span>反馈已保存，学习同步失败</span>
          <button
            type="button"
            data-feedback-retry="learning"
            className="underline underline-offset-2 hover:text-text-strong"
            aria-label="重试学习同步"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              if (onFeedback) void onFeedback(message.id, value, { retryLearning: true });
            }}
          >
            重试同步
          </button>
        </span>
      ) : reason ? (
        <span className="ml-1 text-[11px] text-text-muted" role="status" aria-live="polite">
          {reason}
        </span>
      ) : null}
      {onRetryFeedbackLoad ? (
        <button
          type="button"
          data-feedback-retry="load"
          className="ml-1 text-[11px] text-text-muted underline underline-offset-2 hover:text-text-strong"
          aria-label="重试加载反馈"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => void onRetryFeedbackLoad()}
        >
          重试加载
        </button>
      ) : null}
    </span>
  );
}
