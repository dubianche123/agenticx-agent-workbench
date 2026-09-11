import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { META_AGENT_DISPLAY_NAME } from "../../constants/branding";
import type { Avatar } from "../../store";
import { emptyPaneGraphState } from "../graph/graph-types";
import { useGraphRunStore } from "../graph/useGraphRun";
import { GroupMembersSummaryList } from "./GroupMembersSummaryList";

const { storeState } = vi.hoisted(() => ({
  storeState: {
    groups: [
      {
        id: "g1",
        name: "产品群",
        avatarIds: ["host", "tech"],
        hostAvatarId: "host",
        routing: "intelligent",
      },
    ],
    setGroups: vi.fn(),
  },
}));

vi.mock("../../store", () => ({
  useAppStore: (selector: (state: typeof storeState) => unknown) => selector(storeState),
}));

const avatars: Avatar[] = [
  {
    id: "host",
    name: "产品策划师",
    role: "产品经理",
    description: "",
    color: "blue",
    avatarUrl: "",
    pinned: false,
    createdBy: "test",
  },
  {
    id: "tech",
    name: "技术负责人",
    role: "技术负责人",
    description: "",
    color: "green",
    avatarUrl: "",
    pinned: false,
    createdBy: "test",
  },
];

function seedToolStep(toolName: string, sessionId = "session-a", runId = "run-a"): void {
  const pane = {
    ...emptyPaneGraphState(),
    owner: { sessionId, groupId: "g1" },
    runId,
    toolStepsByNode: {
      "agent:tech": [
        {
          callId: `${toolName}-call`,
          toolName,
          phase: "calling" as const,
          startedAt: 1,
          updatedAt: 2,
        },
      ],
    },
  };
  useGraphRunStore.setState((current) => ({
    byPane: { ...current.byPane, "pane-1": pane },
  }));
  // Zustand's SSR snapshot intentionally uses getInitialState(). Mirror the
  // fixture there so renderToStaticMarkup exercises the real selector path.
  useGraphRunStore.getInitialState().byPane["pane-1"] = pane;
}

describe("GroupMembersSummaryList", () => {
  afterEach(() => {
    useGraphRunStore.getState().resetPane("pane-1");
    delete useGraphRunStore.getInitialState().byPane["pane-1"];
  });

  it("counts coordinator activity only when meta is an explicit visible member", () => {
    const html = renderToStaticMarkup(
      <GroupMembersSummaryList
        groupId="g1"
        paneId="pane-1"
        sessionId="session-1"
        avatarList={avatars}
        messages={[
          { role: "assistant", agentId: "__meta__", timestamp: 1 },
          { role: "assistant", agentId: "tech", timestamp: 2 },
        ]}
      />,
    );

    expect(html).toContain("本轮已执行 1/2 位成员 · 主持人：产品策划师");
    expect(html).not.toContain("Meta-Agent");
    expect(html).not.toContain(META_AGENT_DISPLAY_NAME);
    expect(html).toContain("产品策划师");
    expect(html).toContain("技术负责人");
  });

  it("renders each member once with execution status and membership action in the same row", () => {
    const html = renderToStaticMarkup(
      <GroupMembersSummaryList
        groupId="g1"
        paneId="pane-1"
        sessionId="session-1"
        avatarList={avatars}
      />,
    );

    expect(html.match(/aria-label="移出成员 产品策划师"/g)).toHaveLength(1);
    expect(html.match(/aria-label="移出成员 技术负责人"/g)).toHaveLength(1);
    expect(html).toContain("未执行");
    expect(html).toContain("移出");
    expect(html).not.toContain("成员管理");
  });

  it("exposes each real member's expert detail entry point", () => {
    const html = renderToStaticMarkup(
      <GroupMembersSummaryList
        groupId="g1"
        paneId="pane-1"
        sessionId="session-1"
        avatarList={avatars}
        onOpenMember={() => undefined}
      />,
    );

    expect(html).toContain("打开产品策划师专家详情");
    expect(html).toContain("打开技术负责人专家详情");
  });

  it("renders managed group members as read-only and hides membership actions", () => {
    const group = storeState.groups[0];
    const previousCreatedBy = (group as { createdBy?: string }).createdBy;
    Object.assign(group, { createdBy: "enterprise_managed" });

    try {
      const html = renderToStaticMarkup(
        <GroupMembersSummaryList
          groupId="g1"
          paneId="pane-1"
          sessionId="session-1"
          avatarList={avatars}
          onOpenMember={() => undefined}
        />,
      );

      expect(html).toContain("成员列表");
      expect(html).toContain("成员由管理员通过能力包统一维护");
      expect(html).not.toContain(">添加</button>");
      expect(html).not.toContain("移出成员");
    } finally {
      if (previousCreatedBy === undefined) {
        delete (group as { createdBy?: string }).createdBy;
      } else {
        Object.assign(group, { createdBy: previousCreatedBy });
      }
    }
  });

  it("does not show the previous session's live tool on the first B render", () => {
    seedToolStep("old-tool");

    const switched = renderToStaticMarkup(
      <GroupMembersSummaryList
        groupId="g1"
        paneId="pane-1"
        sessionId="session-b"
        activeGraphRunId="run-b"
        avatarList={avatars}
      />,
    );

    expect(switched).toContain("本轮已执行 0/2");
    expect(switched).not.toContain("old-tool");
  });

  it("shows the current session's live tool on the same-owner render", () => {
    seedToolStep("current-tool");

    const current = renderToStaticMarkup(
      <GroupMembersSummaryList
        groupId="g1"
        paneId="pane-1"
        sessionId="session-a"
        activeGraphRunId="run-a"
        avatarList={avatars}
      />,
    );

    expect(current).toContain("正在调用 current-tool");
    expect(current).toContain("本轮已执行 1/2");
  });
});
