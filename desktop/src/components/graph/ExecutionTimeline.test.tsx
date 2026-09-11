import { afterEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Avatar } from "../../store";
import { emptyPaneGraphState } from "./graph-types";
import { ExecutionTimeline } from "./ExecutionTimeline";
import { useGraphRunStore } from "./useGraphRun";

const avatar: Avatar = {
  id: "tech",
  name: "技术负责人",
  role: "技术负责人",
  description: "",
  color: "green",
  avatarUrl: "",
  pinned: false,
  createdBy: "test",
};

function seedToolStep(owner: { sessionId: string; groupId: string }, runId: string): void {
  const state = emptyPaneGraphState();
  const pane = {
    ...state,
    owner,
    runId,
    toolStepsByNode: {
      "agent:tech": [
        {
          callId: "old-call",
          toolName: "old-tool",
          phase: "calling" as const,
          startedAt: 1,
          updatedAt: 2,
        },
      ],
    },
  };
  useGraphRunStore.setState((current) => ({
    byPane: {
      ...current.byPane,
      "pane-1": pane,
    },
  }));
  // Zustand's SSR snapshot intentionally uses getInitialState(). Keep the
  // fixture visible to renderToStaticMarkup while the browser path continues
  // to exercise the live store above.
  useGraphRunStore.getInitialState().byPane["pane-1"] = pane;
}

function renderTimeline(sessionId: string, activeGraphRunId: string): string {
  return renderToStaticMarkup(
    <ExecutionTimeline
      paneId="pane-1"
      sessionId={sessionId}
      groupId="group-1"
      activeGraphRunId={activeGraphRunId}
      agentIds={["tech"]}
      avatarById={new Map([[avatar.id, avatar]])}
    />,
  );
}

describe("ExecutionTimeline graph ownership", () => {
  afterEach(() => {
    useGraphRunStore.getState().resetPane("pane-1");
    delete useGraphRunStore.getInitialState().byPane["pane-1"];
  });

  it("does not paint the previous session's tool timeline on the first B render", () => {
    seedToolStep({ sessionId: "session-a", groupId: "group-1" }, "run-a");

    const switched = renderTimeline("session-b", "run-b");

    expect(switched).toContain("本轮尚无工具调用");
    expect(switched).not.toContain("old-tool");
  });

  it("keeps the current session's tool timeline visible", () => {
    seedToolStep({ sessionId: "session-a", groupId: "group-1" }, "run-a");

    const current = renderTimeline("session-a", "run-a");

    expect(current).toContain("old-tool");
    expect(current).not.toContain("本轮尚无工具调用");
  });
});
