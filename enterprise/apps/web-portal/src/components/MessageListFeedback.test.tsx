import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "@agenticx/core-api";
import { TooltipProvider } from "@agenticx/ui";
import { MessageList, nextChatFeedbackValue } from "@agenticx/feature-chat";

function assistantMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "01J00000000000000000000004",
    session_id: "01J00000000000000000000005",
    tenant_id: "01J00000000000000000000002",
    user_id: "01J00000000000000000000003",
    role: "assistant",
    content: "这是一条助手回复",
    created_at: "2026-08-31T00:00:00.000Z",
    ...overrides,
  };
}

describe("MessageList feedback controls", () => {
  it("uses a mutually exclusive toggle and supports cancellation", () => {
    expect(nextChatFeedbackValue(undefined, "like")).toBe("like");
    expect(nextChatFeedbackValue("like", "like")).toBeNull();
    expect(nextChatFeedbackValue("like", "dislike")).toBe("dislike");
    expect(nextChatFeedbackValue("dislike", "like")).toBe("like");
    expect(nextChatFeedbackValue("dislike", "dislike")).toBeNull();
  });

  it("does not render an optimistic control without a persistence callback", () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <MessageList messages={[assistantMessage()]} />
      </TooltipProvider>,
    );

    expect(html).not.toContain('aria-label="有帮助"');
    expect(html).not.toContain('aria-label="没帮助"');
    expect(html).not.toContain("反馈已记录");
  });

  it("hydrates a selected value and exposes accessible pressed state", () => {
    const onFeedback = vi.fn();
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <MessageList
          messages={[assistantMessage()]}
          feedbackByMessageId={{ "01J00000000000000000000004": "like" }}
          onFeedback={onFeedback}
        />
      </TooltipProvider>,
    );

    expect(html).toContain('aria-label="取消有帮助反馈"');
    expect(html).toContain('aria-label="没帮助"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('aria-pressed="false"');
    expect(html).not.toContain("正在保存反馈");
    expect(onFeedback).not.toHaveBeenCalled();
  });

  it("does not leak a selected value when the host hydrates another session", () => {
    const nextSessionMessage = assistantMessage({
      id: "01J00000000000000000000006",
      session_id: "01J00000000000000000000007",
    });
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <MessageList
          messages={[nextSessionMessage]}
          feedbackByMessageId={{ "01J00000000000000000000004": "like" }}
          onFeedback={vi.fn()}
        />
      </TooltipProvider>,
    );

    expect(html).toContain('aria-label="有帮助"');
    expect(html).toContain('aria-label="没帮助"');
    expect(html).not.toContain('aria-label="取消有帮助反馈"');
    expect(html).not.toContain('aria-label="取消没帮助反馈"');
  });
});
