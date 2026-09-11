import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { shouldShowAssistantFollowups, shouldShowAssistantIconButtons } from "../../utils/im-bubble-actions";
import { useAppStore } from "../../store";
import { ImBubble } from "./ImBubble";

const baseVisible = {
  hideActions: false,
  isUser: false,
  isStreaming: false,
  isGroupTyping: false,
  isMetaPendingWork: false,
  hasBody: true,
  sessionBusy: false,
  isLastAssistantInPane: false,
};

describe("shouldShowAssistantIconButtons", () => {
  it("shows actions for a normal assistant message", () => {
    expect(shouldShowAssistantIconButtons(baseVisible)).toBe(true);
  });

  it("hides actions while streaming placeholder is active", () => {
    expect(shouldShowAssistantIconButtons({ ...baseVisible, isStreaming: true })).toBe(false);
  });

  it("suppresses last assistant actions when session is busy", () => {
    expect(
      shouldShowAssistantIconButtons({
        ...baseVisible,
        sessionBusy: true,
        isLastAssistantInPane: true,
      })
    ).toBe(false);
  });

  it("keeps historical assistant actions when session is busy", () => {
    expect(
      shouldShowAssistantIconButtons({
        ...baseVisible,
        sessionBusy: true,
        isLastAssistantInPane: false,
      })
    ).toBe(true);
  });

  it("restores last assistant actions when session is idle", () => {
    expect(
      shouldShowAssistantIconButtons({
        ...baseVisible,
        sessionBusy: false,
        isLastAssistantInPane: true,
      })
    ).toBe(true);
  });
});

const baseFollowups = {
  isUser: false,
  isStreaming: false,
  isGroupTyping: false,
  omitSuggestedQuestions: false,
  hasBody: true,
  hasSuggestedQuestions: true,
  hasFollowupHandler: true,
  sessionBusy: false,
  isLastAssistantInPane: false,
};

describe("shouldShowAssistantFollowups", () => {
  it("shows followups for a completed assistant message", () => {
    expect(shouldShowAssistantFollowups(baseFollowups)).toBe(true);
  });

  it("hides followups while streaming placeholder is active", () => {
    expect(shouldShowAssistantFollowups({ ...baseFollowups, isStreaming: true })).toBe(false);
  });

  it("suppresses last assistant followups when session is busy", () => {
    expect(
      shouldShowAssistantFollowups({
        ...baseFollowups,
        sessionBusy: true,
        isLastAssistantInPane: true,
      })
    ).toBe(false);
  });

  it("keeps historical assistant followups when session is busy", () => {
    expect(
      shouldShowAssistantFollowups({
        ...baseFollowups,
        sessionBusy: true,
        isLastAssistantInPane: false,
      })
    ).toBe(true);
  });

  it("hides followups when assistant body is empty", () => {
    expect(shouldShowAssistantFollowups({ ...baseFollowups, hasBody: false })).toBe(false);
  });
});

describe("ImBubble assistant feedback", () => {
  const feedbackProps = {
    onFeedback: () => undefined,
  };

  it("renders feedback controls only for a completed assistant body", () => {
    const assistant = renderToStaticMarkup(
      <ImBubble
        message={{ id: "assistant-final", role: "assistant", content: "最终回答" }}
        {...feedbackProps}
      />,
    );
    const user = renderToStaticMarkup(
      <ImBubble
        message={{ id: "user-1", role: "user", content: "问题" }}
        {...feedbackProps}
      />,
    );
    const stream = renderToStaticMarkup(
      <ImBubble
        message={{ id: "__stream__", role: "assistant", content: "正在生成" }}
        {...feedbackProps}
      />,
    );

    expect(assistant).toContain('data-feedback-control="like"');
    expect(assistant).toContain('data-feedback-control="dislike"');
    expect(user).not.toContain("data-feedback-control");
    expect(stream).not.toContain("data-feedback-control");
  });

  it("does not expose feedback for a visible interrupted partial", () => {
    const terminalPartial = renderToStaticMarkup(
      <ImBubble
        message={{
          id: "assistant-partial-terminal",
          role: "assistant",
          content: "只生成了一半",
          metadata: { turn_terminal: false },
        }}
        {...feedbackProps}
      />,
    );
    const sourcePartial = renderToStaticMarkup(
      <ImBubble
        message={{
          id: "assistant-partial-source",
          role: "assistant",
          content: "只生成了一半",
          metadata: { source: "interrupted-partial" },
        }}
        {...feedbackProps}
      />,
    );
    const statusPartial = renderToStaticMarkup(
      <ImBubble
        message={{
          id: "assistant-partial-status",
          role: "assistant",
          content: "只生成了一半",
          metadata: { status: "partial" },
        }}
        {...feedbackProps}
      />,
    );

    expect(terminalPartial).not.toContain("data-feedback-control");
    expect(sourcePartial).not.toContain("data-feedback-control");
    expect(statusPartial).not.toContain("data-feedback-control");
  });

  it("shows selected, saving, success, and rollback error states", () => {
    const saving = renderToStaticMarkup(
      <ImBubble
        message={{ id: "assistant-saving", role: "assistant", content: "回答" }}
        feedbackValue="like"
        feedbackPending
        {...feedbackProps}
      />,
    );
    const success = renderToStaticMarkup(
      <ImBubble
        message={{ id: "assistant-success", role: "assistant", content: "回答" }}
        feedbackValue="dislike"
        feedbackStatus="success"
        {...feedbackProps}
      />,
    );
    const cleared = renderToStaticMarkup(
      <ImBubble
        message={{ id: "assistant-cleared", role: "assistant", content: "回答" }}
        feedbackStatus="success"
        {...feedbackProps}
      />,
    );
    const error = renderToStaticMarkup(
      <ImBubble
        message={{ id: "assistant-error", role: "assistant", content: "回答" }}
        feedbackValue="like"
        feedbackStatus="error"
        {...feedbackProps}
      />,
    );
    const learningError = renderToStaticMarkup(
      <ImBubble
        message={{ id: "assistant-learning-error", role: "assistant", content: "回答" }}
        feedbackValue="like"
        feedbackStatus="learning-error"
        {...feedbackProps}
      />,
    );

    expect(saving).toContain('aria-pressed="true"');
    expect(saving).toContain('aria-busy="true"');
    expect(saving).toContain("正在保存反馈");
    expect(saving).toContain('disabled=""');
    expect(success).toContain("反馈已记录");
    expect(cleared).toContain("已取消反馈");
    expect(error).toContain("保存失败，请重试");
    expect(error).toContain('data-feedback-control="like"');
    expect(learningError).toContain("反馈已保存，学习同步失败");
    expect(learningError).toContain('data-feedback-retry="learning"');
    expect(learningError).toContain("重试同步");
  });
});

describe("ImBubble group expert identity", () => {
  it("shows an avatar, prominent expert label, and workflow role when showSenderIdentity", () => {
    const html = renderToStaticMarkup(
      <ImBubble
        message={{
          id: "expert-1",
          role: "assistant",
          content: "收到，按 T1–T5 拆解。\n\n## 结论\n1. T1\n2. T2",
          avatarName: "架构师·阿析",
          metadata: { workflow_role: "reviewer" },
        }}
        showSenderIdentity
        senderAvatarId="avatar-architect"
        assistantName="架构师·阿析"
      />,
    );

    expect(html).toContain("架构师·阿析");
    expect(html).toContain("审核");
    expect(html).toContain("折叠");
    expect(html).toContain("border-color:");
    expect(html).toContain("架构师·阿析 默认图标");
  });

  it("shows the stable host label before the host name without duplicating the workflow label", () => {
    const html = renderToStaticMarkup(
      <ImBubble
        message={{
          id: "host-1",
          role: "assistant",
          content: "我来组织这一轮。",
          metadata: { workflow_role: "leader" },
        }}
        showSenderIdentity
        senderAvatarId="host"
        senderRoleLabel="主持人"
        assistantName="产品策划师"
      />,
    );

    const hostBadgeAt = html.indexOf(">主持人</span>");
    const visibleNameAt = html.indexOf(">产品策划师</span>", hostBadgeAt);
    expect(hostBadgeAt).toBeGreaterThanOrEqual(0);
    expect(visibleNameAt).toBeGreaterThan(hostBadgeAt);
    expect(html.match(/主持人/g)).toHaveLength(1);
  });

  it("keeps expert profile and reply folding as separate controls", () => {
    const previousAvatars = useAppStore.getState().avatars;
    useAppStore.setState({
      avatars: [
        {
          id: "avatar-contact",
          name: "环境配置专家",
          role: "开发环境顾问",
          avatarUrl: "",
          pinned: false,
          createdBy: "manual",
          description: "帮你把本地开发环境一次配好。",
          defaultPermissionMode: "ask",
        },
      ],
    });
    try {
      const html = renderToStaticMarkup(
        <ImBubble
          message={{ id: "contact-1", role: "assistant", content: "我先检查依赖。" }}
          showSenderIdentity
          senderAvatarId="avatar-contact"
          assistantName="环境配置专家"
          onOpenSenderProfile={() => undefined}
        />,
      );

      expect(html).toContain("查看环境配置专家的专家名片");
      expect(html).toContain('aria-haspopup="dialog"');
      expect(html).toContain('title="折叠回复"');
      expect(html.match(/<button/g)?.length).toBeGreaterThanOrEqual(2);
    } finally {
      useAppStore.setState({ avatars: previousAvatars });
    }
  });
});

describe("ImBubble group feed reactions", () => {
  it("renders reactions for a public user message with a stable group id", () => {
    const html = renderToStaticMarkup(
      <ImBubble
        message={{
          id: "group-user-1",
          role: "user",
          content: "我也补充一个观点。",
          groupMessageId: "gmsg-user-1",
          metadata: {
            client_turn_id: "turn-1",
            is_public: true,
            feed_visibility: "feed",
          },
          reactions: [{ emoji: "👍", actorIds: ["user", "member-a"], active: true }],
        }}
        enableGroupReactions
        onToggleReaction={() => undefined}
      />,
    );

    expect(html).toContain('data-group-reaction-pills="1"');
    expect(html).toContain("👍");
    expect(html).toContain("2 个回应");
  });

  it("does not render reactions for a private project-panel row", () => {
    const html = renderToStaticMarkup(
      <ImBubble
        message={{
          id: "group-private-1",
          role: "assistant",
          content: "候选稿只供项目面板查看。",
          groupMessageId: "gmsg-private-1",
          metadata: { feed_visibility: "panel", is_public: false },
          reactions: [{ emoji: "👍", actorIds: ["member-a"] }],
        }}
        enableGroupReactions
        onToggleReaction={() => undefined}
      />,
    );

    expect(html).not.toContain('data-group-reaction-pills="1"');
  });
});

// Ported-ref: fix/glm-stream-common-finalization@5bf63d3e
describe("ImBubble assistant protocol boundary", () => {
  it("does not render an unclosed followups tail from historical messages", () => {
    const raw =
      "全部修复完成。\n\n粒子间距离 < 120px 时自动连线。\n\n<followups>粒子动画太卡了怎么优化\n待办事项能不能按分类筛选\n背景粒子颜色能不能换成其他配色";
    const html = renderToStaticMarkup(
      <ImBubble message={{ id: "historical-assistant", role: "assistant", content: raw }} />,
    );

    expect(html).toContain("全部修复完成。");
    expect(html).not.toContain("followups");
    expect(html).not.toContain("粒子动画太卡了怎么优化");
  });

  it("does not render a MiniMax followflows alias block as markdown body", () => {
    const raw =
      "总结正文\n<followflows>客户追问 Qoder Work 和 Cursor 怎么选 客户想看 Qoder Work 的具体功能演示 客户问 Qoder Work 价格和订阅方案</followflows>";
    const html = renderToStaticMarkup(
      <ImBubble message={{ id: "minimax-followflows", role: "assistant", content: raw }} />,
    );

    expect(html).toContain("总结正文");
    expect(html).not.toContain("followflows");
    expect(html).not.toContain("客户追问 Qoder Work 和 Cursor 怎么选");
  });

  it("does not render a ReasoningBlock when reasoning only echoes the body", () => {
    const body =
      "## 总结\n\n当前目录有两个 .py 文件：\n- `analyze_cursor_cost.py`\n- `simple.py`";
    const html = renderToStaticMarkup(
      <ImBubble
        message={{
          id: "dup-reasoning",
          role: "assistant",
          content: body,
          reasoning: body,
          reasoningSeconds: 5,
        }}
      />,
    );

    expect(html).toContain("总结");
    expect(html).not.toContain("思考了");
    expect(html).not.toContain("Thought");
  });

  it("places copy/quote actions to the right of a deliverable card", () => {
    const html = renderToStaticMarkup(
      <ImBubble
        message={{ id: "with-artifact", role: "assistant", content: "已写入 hello.txt" }}
        afterBody={<span>hello.txt-card</span>}
      />,
    );

    expect(html).toContain("agx-artifact-action-row");
    expect(html).toContain("flex-1");
    expect(html).toContain("hello.txt-card");
    const rowIdx = html.indexOf("agx-artifact-action-row");
    const cardIdx = html.indexOf("hello.txt-card");
    const iconsIdx = html.indexOf("agx-assistant-action-icons");
    expect(rowIdx).toBeGreaterThan(-1);
    expect(cardIdx).toBeGreaterThan(rowIdx);
    expect(iconsIdx).toBeGreaterThan(cardIdx);
  });
});
