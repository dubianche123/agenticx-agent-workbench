import { Children, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  cleanGroupTeamTaskDescription,
  GroupTeamControls,
  groupTeamControlStateFromGraph,
  shouldShowGroupTeamControls,
} from "./ChatPane";

function controlsButton(element: ReactElement, index: number): ReactElement {
  return Children.toArray(element.props.children)[index] as ReactElement;
}

describe("GroupTeamControls", () => {
  it("renders running and paused controls with the correct action affordances", () => {
    const running = renderToStaticMarkup(
      <GroupTeamControls
        paused={false}
        taskDescription="整理执行计划"
        onAddTask={vi.fn()}
        onPauseResume={vi.fn()}
        onStop={vi.fn()}
      />,
    );
    const paused = renderToStaticMarkup(
      <GroupTeamControls
        paused
        taskDescription="整理执行计划"
        onAddTask={vi.fn()}
        onPauseResume={vi.fn()}
        onStop={vi.fn()}
      />,
    );

    expect(running).toContain('data-testid="group-team-controls"');
    expect(running).toContain('title="暂停团队任务"');
    expect(running).toContain('title="停止团队任务"');
    expect(paused).toContain('title="继续团队任务"');
    expect(paused).toContain("继续");
  });

  it("wires pause/resume and stop actions to their callbacks", () => {
    const onPauseResume = vi.fn();
    const onStop = vi.fn();
    const controls = GroupTeamControls({
      paused: true,
      taskDescription: "任务",
      onAddTask: vi.fn(),
      onPauseResume,
      onStop,
    });
    controlsButton(controls, 1).props.onClick();
    controlsButton(controls, 2).props.onClick();
    expect(onPauseResume).toHaveBeenCalledTimes(1);
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("cleans quote markers, rejects empty insertion, and forwards one task description", () => {
    expect(cleanGroupTeamTaskDescription("  [[agx-quote:q1]]  ")).toBe("");
    expect(cleanGroupTeamTaskDescription("部署服务 [[agx-quote:q1]] 到测试环境")).toBe(
      "部署服务 到测试环境",
    );

    const onAddTask = vi.fn();
    const empty = GroupTeamControls({
      paused: false,
      taskDescription: "[[agx-quote:q1]]",
      onAddTask,
      onPauseResume: vi.fn(),
      onStop: vi.fn(),
    });
    controlsButton(empty, 0).props.onClick();
    expect(onAddTask).not.toHaveBeenCalled();

    const withText = GroupTeamControls({
      paused: false,
      taskDescription: "部署服务 [[agx-quote:q1]] 到测试环境",
      onAddTask,
      onPauseResume: vi.fn(),
      onStop: vi.fn(),
    });
    controlsButton(withText, 0).props.onClick();
    expect(onAddTask).toHaveBeenCalledTimes(1);
    expect(onAddTask).toHaveBeenCalledWith("部署服务 到测试环境");
  });

  it("guards a double click before the pending prop can re-render", () => {
    const onAddTask = vi.fn();
    const controls = GroupTeamControls({
      paused: false,
      taskDescription: "只提交一次",
      onAddTask,
      onPauseResume: vi.fn(),
      onStop: vi.fn(),
    });
    const addButton = controlsButton(controls, 0);
    addButton.props.onClick();
    addButton.props.onClick();
    expect(onAddTask).toHaveBeenCalledTimes(1);
  });

  it("renders every action disabled while an action is pending", () => {
    const html = renderToStaticMarkup(
      <GroupTeamControls
        paused={false}
        pending
        taskDescription="任务"
        onAddTask={vi.fn()}
        onPauseResume={vi.fn()}
        onStop={vi.fn()}
      />,
    );
    expect((html.match(/disabled=""/g) ?? []).length).toBe(3);
    expect(html).toContain('aria-busy="true"');
  });

  it("restores Team state from a real task graph, not a presence-only graph", () => {
    const taskNode = { id: "task-1", kind: "task", label: "执行", status: "running" };
    expect(groupTeamControlStateFromGraph({ status: "running", nodes: { "task-1": taskNode } })).toBe(
      "running",
    );
    expect(groupTeamControlStateFromGraph({ status: "paused", nodes: { "task-1": taskNode } })).toBe(
      "paused",
    );
    expect(groupTeamControlStateFromGraph({ status: "done", nodes: { "task-1": taskNode } })).toBe(
      "stopped",
    );
    expect(
      groupTeamControlStateFromGraph({
        status: "running",
        nodes: { human: { id: "human", kind: "human", label: "你", status: "ready" } },
      }),
    ).toBe("idle");
  });
});

describe("shouldShowGroupTeamControls", () => {
  const base = {
    isGroupPane: true,
    sessionId: "session-1",
    routing: "intelligent",
    canInterruptCurrentSession: false,
    executionState: "idle",
    runGuardSessionId: "",
    stallState: "none" as const,
  };

  it.each([
    ["running", true],
    ["paused", true],
    ["stopped", false],
    ["idle", false],
  ] as const)("uses session Team state %s", (sessionControlState, expected) => {
    expect(shouldShowGroupTeamControls({ ...base, sessionControlState })).toBe(expected);
  });

  it("shows a smart-routed room only after a Workforce session upgrade", () => {
    expect(shouldShowGroupTeamControls(base)).toBe(false);
    expect(
      shouldShowGroupTeamControls({ ...base, sessionControlState: "running" }),
    ).toBe(true);
    expect(
      shouldShowGroupTeamControls({ ...base, sessionControlState: "paused" }),
    ).toBe(true);
  });

  it("waits for the server control plane even in an explicit Team room", () => {
    expect(
      shouldShowGroupTeamControls({ ...base, routing: "team", executionState: "running" }),
    ).toBe(false);
    expect(
      shouldShowGroupTeamControls({ ...base, routing: "team", stallState: "stall" }),
    ).toBe(false);
    expect(
      shouldShowGroupTeamControls({ ...base, stallState: "stall" }),
    ).toBe(false);
  });
});
