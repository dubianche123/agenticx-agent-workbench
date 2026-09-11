import type { ReactNode } from "react";
import { Bookmark, Copy, Forward, LayoutList, Quote } from "lucide-react";
import type { Message } from "../../store";
import { HoverTip } from "../ds/HoverTip";
import { MessageTimestamp } from "./MessageTimestamp";
import {
  ASSISTANT_ACTION_ICON_ROW_CLASS,
  getAssistantActionStyle,
} from "./im-layout";

type Props = {
  message: Message;
  feedback?: ReactNode;
  onCopyMessage?: (message: Message) => void;
  onQuoteMessage?: (message: Message, selectedText?: string) => void;
  onFavoriteMessage?: (message: Message, selectedText?: string) => void;
  onForwardMessage?: (message: Message, selectedText?: string) => void;
  onToggleSelectMessage?: (message: Message) => void;
  selected?: boolean;
};

/**
 * The shared operation bar for completed assistant messages.  Feedback is an
 * inline segment of this bar so every message layout exposes the same actions
 * without creating a second persistent feedback row.
 */
export function AssistantMessageActionBar({
  message,
  feedback,
  onCopyMessage,
  onQuoteMessage,
  onFavoriteMessage,
  onForwardMessage,
  onToggleSelectMessage,
  selected = false,
}: Props) {
  const selectedText = () =>
    typeof window === "undefined" ? undefined : window.getSelection()?.toString().trim() || undefined;

  return (
    <div className="mt-2 min-w-0 self-stretch" data-message-actions="assistant">
      <div className={ASSISTANT_ACTION_ICON_ROW_CLASS} style={getAssistantActionStyle()}>
        {onCopyMessage ? (
          <HoverTip label="复制">
            <button
              type="button"
              data-message-action="copy"
              aria-label="复制"
              className="rounded p-1 hover:bg-surface-hover hover:text-text-strong"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onCopyMessage(message)}
            >
              <Copy size={13} aria-hidden />
            </button>
          </HoverTip>
        ) : null}
        {onQuoteMessage ? (
          <HoverTip label="引用">
            <button
              type="button"
              data-message-action="quote"
              aria-label="引用"
              className="rounded p-1 hover:bg-surface-hover hover:text-text-strong"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onQuoteMessage(message, selectedText())}
            >
              <Quote size={13} aria-hidden />
            </button>
          </HoverTip>
        ) : null}
        {onFavoriteMessage ? (
          <HoverTip label="收藏">
            <button
              type="button"
              data-message-action="favorite"
              aria-label="收藏"
              className="rounded p-1 hover:bg-surface-hover hover:text-text-strong"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onFavoriteMessage(message, selectedText())}
            >
              <Bookmark size={13} aria-hidden />
            </button>
          </HoverTip>
        ) : null}
        {onForwardMessage ? (
          <HoverTip label="转发">
            <button
              type="button"
              data-message-action="forward"
              aria-label="转发"
              className="rounded p-1 hover:bg-surface-hover hover:text-text-strong"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onForwardMessage(message, selectedText())}
            >
              <Forward size={13} aria-hidden />
            </button>
          </HoverTip>
        ) : null}
        {onToggleSelectMessage ? (
          <HoverTip label="多选" tooltipAlign="end">
            <button
              type="button"
              data-message-action="select"
              aria-label={selected ? "取消选择消息" : "多选"}
              className={`rounded p-1 hover:bg-surface-hover ${
                selected
                  ? "text-[rgb(var(--theme-color-fg-rgb,59,130,246))] hover:opacity-90"
                  : "hover:text-text-strong"
              }`}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onToggleSelectMessage(message)}
            >
              <LayoutList size={13} aria-hidden />
            </button>
          </HoverTip>
        ) : null}
        {feedback}
        <MessageTimestamp ts={message.timestamp} align="left" />
      </div>
    </div>
  );
}
