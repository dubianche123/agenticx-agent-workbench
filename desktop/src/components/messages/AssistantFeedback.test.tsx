import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { useAppStore } from "../../store";
import { AssistantFeedback } from "./AssistantFeedback";
import { AssistantMessageActionBar } from "./AssistantMessageActionBar";
import { CleanBlock } from "./CleanBlock";
import { ImBubble } from "./ImBubble";
import { MessageRenderer } from "./MessageRenderer";
import { TerminalLine } from "./TerminalLine";

const assistant = {
  id: "assistant-final",
  role: "assistant" as const,
  content: "一段已经完成的回答",
};

const feedbackProps = {
  onFeedback: () => undefined,
};

describe("AssistantFeedback rendering", () => {
  it("keeps feedback in the shared operation bar across IM, clean, and terminal layouts", () => {
    const feedback = (
      <AssistantFeedback message={assistant} bodyText={assistant.content} {...feedbackProps} />
    );
    const afterBody = <div data-after-body="deliverable">交付卡片</div>;
    const imWithFollowups = renderToStaticMarkup(
      <ImBubble
        message={{ ...assistant, suggestedQuestions: ["继续追问"] }}
        onFollowupClick={() => undefined}
        feedbackControls={feedback}
      />,
    );
    const layouts = [
      renderToStaticMarkup(
        <ImBubble
          message={assistant}
          afterBody={afterBody}
          feedbackControls={feedback}
        />,
      ),
      renderToStaticMarkup(
        <CleanBlock
          message={assistant}
          afterBody={afterBody}
          actions={
            <AssistantMessageActionBar
              message={assistant}
              onCopyMessage={() => undefined}
              onQuoteMessage={() => undefined}
              feedback={feedback}
            />
          }
        />,
      ),
      renderToStaticMarkup(
        <TerminalLine
          message={assistant}
          afterBody={afterBody}
          actions={
            <AssistantMessageActionBar
              message={assistant}
              onCopyMessage={() => undefined}
              onQuoteMessage={() => undefined}
              feedback={feedback}
            />
          }
        />,
      ),
    ];

    for (const html of layouts) {
      expect(html).toContain('data-after-body="deliverable"');
      expect(html).toContain('data-message-actions="assistant"');
      expect(html.match(/data-message-actions="assistant"/g)).toHaveLength(1);
      expect(html).toContain('data-feedback-controls="assistant"');
      expect(html).toContain('data-feedback-control="like"');
      expect(html).toContain('data-feedback-control="dislike"');
      expect(html.indexOf('data-after-body="deliverable"')).toBeLessThan(
        html.indexOf('data-message-actions="assistant"'),
      );
    }
    for (const html of layouts.slice(1)) {
      expect(html).toContain('data-message-action="copy"');
      expect(html).toContain('data-message-action="quote"');
    }
    expect(imWithFollowups.match(/data-feedback-control="like"/g)).toHaveLength(1);
    expect(imWithFollowups.match(/data-feedback-control="dislike"/g)).toHaveLength(1);
    expect(imWithFollowups.match(/data-message-actions="assistant"/g)).toHaveLength(1);
    expect(imWithFollowups.indexOf('data-feedback-controls="assistant"')).toBeLessThan(
      imWithFollowups.indexOf("继续追问"),
    );
  });

  it("is wired through MessageRenderer for IM, clean, and terminal", () => {
    const previousStyle = useAppStore.getState().chatStyle;
    try {
      for (const chatStyle of ["im", "clean", "terminal"] as const) {
        useAppStore.setState({ chatStyle });
        const html = renderToStaticMarkup(
          <MessageRenderer
            message={assistant}
            feedbackDisabledReason="正在加载账号"
            onFeedback={() => undefined}
            onRetryFeedbackLoad={() => undefined}
            onCopyMessage={() => undefined}
            onQuoteMessage={() => undefined}
          />,
        );
        expect(html).toContain('data-message-actions="assistant"');
        expect(html).toContain('data-feedback-controls="assistant"');
        expect(html).toContain('data-feedback-control="like"');
        expect(html).toContain("正在加载账号");
        expect(html).toContain('data-feedback-retry="load"');
      }
    } finally {
      useAppStore.setState({ chatStyle: previousStyle });
    }
  });

  it("keeps the completed last reply operation bar visible during another active run", () => {
    const html = renderToStaticMarkup(
      <ImBubble
        message={assistant}
        sessionBusy
        isLastAssistantInPane
        feedbackControls={
          <AssistantFeedback message={assistant} disabledReason="正在加载反馈" />
        }
      />,
    );
    expect(html).toContain('data-message-actions="assistant"');
    expect(html).toContain('data-feedback-control="like"');
    expect(html).toContain('data-feedback-control="dislike"');
  });

  it("puts one final ReAct feedback group in the card action bar", () => {
    const compactWorkRow = renderToStaticMarkup(
      <MessageRenderer
        message={assistant}
        imAssistantVisual="compact-inline"
        feedbackDisabledReason="正在加载账号"
        onFeedback={() => undefined}
      />,
    );
    const finalCardActions = renderToStaticMarkup(
      <AssistantMessageActionBar
        message={assistant}
        onCopyMessage={() => undefined}
        onQuoteMessage={() => undefined}
        feedback={<AssistantFeedback message={assistant} disabledReason="正在加载账号" />}
      />,
    );

    expect(compactWorkRow).not.toContain("data-feedback-control");
    expect(finalCardActions).toContain('data-message-actions="assistant"');
    expect(finalCardActions).toContain('data-message-action="copy"');
    expect(finalCardActions).toContain('data-message-action="quote"');
    expect(finalCardActions.match(/data-feedback-control="like"/g)).toHaveLength(1);
    expect(finalCardActions.match(/data-feedback-control="dislike"/g)).toHaveLength(1);
  });

  it("shows disabled controls and a safe retry when feedback loading fails", () => {
    const retry = vi.fn();
    const html = renderToStaticMarkup(
      <AssistantFeedback
        message={assistant}
        disabledReason="反馈服务暂时不可用，请重试"
        onRetryFeedbackLoad={retry}
      />,
    );

    expect(html).toContain('data-feedback-disabled="true"');
    expect(html).toContain('data-feedback-control="like"');
    expect(html).toContain('data-feedback-control="dislike"');
    expect(html).toContain('disabled=""');
    expect(html).toContain("反馈服务暂时不可用，请重试");
    expect(html).toContain('data-feedback-retry="load"');
    expect(html).toContain("重试加载");
    expect(retry).not.toHaveBeenCalled();
  });

  it("keeps an explicit sign-in reason disabled without hiding the entry", () => {
    const html = renderToStaticMarkup(
      <AssistantFeedback message={assistant} disabledReason="请先登录企业账号" />,
    );
    expect(html).toContain('data-feedback-controls="assistant"');
    expect(html).toContain("请先登录企业账号");
    expect(html).toContain('disabled=""');
  });

  it("does not expose controls for streaming or interrupted partial replies", () => {
    const stream = renderToStaticMarkup(
      <AssistantFeedback
        message={{ ...assistant, id: "__stream__", content: "正在生成" }}
        {...feedbackProps}
      />,
    );
    const interrupted = renderToStaticMarkup(
      <AssistantFeedback
        message={{ ...assistant, metadata: { turn_terminal: false } }}
        {...feedbackProps}
      />,
    );
    const groupStream = renderToStaticMarkup(
      <AssistantFeedback
        message={{ ...assistant, id: "__group_stream__:expert", content: "正在生成" }}
        {...feedbackProps}
      />,
    );
    expect(stream).not.toContain("data-feedback-control");
    expect(interrupted).not.toContain("data-feedback-control");
    expect(groupStream).not.toContain("data-feedback-control");
  });
});
