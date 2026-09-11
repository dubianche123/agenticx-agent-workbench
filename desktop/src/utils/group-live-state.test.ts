import { describe, expect, it } from "vitest";
import {
  formatGroupWorkforceHandoff,
  GROUP_COORDINATOR_AGENT_ID,
  groupCoordinatorActivityText,
  normalizeGroupGraphPayload,
  resolveGroupWorkflowDetailEffect,
  resolveGroupRunningResumeAction,
  shouldHandoffGroupCoordinator,
  withoutGroupAgent,
} from "./group-live-state";

describe("group live state", () => {
  it("unwraps graph replay payloads without changing their graph lane", () => {
    expect(
      normalizeGroupGraphPayload("graph.node_updated", {
        content: JSON.stringify({
          run_id: "run-1",
          node: { id: "task-1", kind: "task", status: "running" },
        }),
      }),
    ).toEqual({
      type: "graph.node_updated",
      run_id: "run-1",
      node: { id: "task-1", kind: "task", status: "running" },
    });
    expect(
      normalizeGroupGraphPayload("graph.run_status", { status: "completed" }),
    ).toEqual({ type: "graph.run_status", status: "completed" });
    expect(
      normalizeGroupGraphPayload("graph.edge_updated", { content: "{not-json" }),
    ).toEqual({ type: "graph.edge_updated", content: "{not-json" });
  });

  it("hands the room from the coordinator to a real member", () => {
    expect(shouldHandoffGroupCoordinator("member-1")).toBe(true);
    expect(shouldHandoffGroupCoordinator(GROUP_COORDINATOR_AGENT_ID)).toBe(false);
    expect(shouldHandoffGroupCoordinator("")).toBe(false);
    expect(withoutGroupAgent({ __meta__: "组织中", a1: "发言中" }, "__meta__")).toEqual({
      a1: "发言中",
    });
  });

  it("never restarts a group turn that is still running", () => {
    expect(
      resolveGroupRunningResumeAction({
        isGroupPane: true,
        executionState: "running",
        hasForegroundStream: true,
        liveReattachEnabled: true,
      }),
    ).toBe("keep-running");
    expect(
      resolveGroupRunningResumeAction({
        isGroupPane: true,
        executionState: "running",
        hasForegroundStream: false,
        liveReattachEnabled: true,
      }),
    ).toBe("reattach");
  });

  it("keeps planning chatter ephemeral and renders one complete @ handoff", () => {
    expect(groupCoordinatorActivityText("workforce_started", false)).toBe("正在规划团队任务…");
    expect(groupCoordinatorActivityText("decompose_start", false)).toBe("正在拆解任务…");
    expect(groupCoordinatorActivityText("decompose_complete", false)).toBe("正在安排合适的成员…");

    const longTask = `梳理产品边界：${"完整要求".repeat(180)}`;
    const handoff = formatGroupWorkforceHandoff("产品策划师", longTask);
    expect(handoff).toBe(`按职责分工，@产品策划师：${longTask}`);
    expect(handoff.endsWith(longTask)).toBe(true);
  });

  it("maps private workflow details to member status effects without exposing content", () => {
    expect(
      resolveGroupWorkflowDetailEffect({
        agent_id: "executor",
        avatar_name: "执行者",
        workflow_event_type: "task_started",
        content: "内部任务描述不应成为气泡",
      }),
    ).toEqual({
      kind: "show_processing",
      agentId: "executor",
      avatarName: "执行者",
      activity: "正在处理…",
    });
    expect(
      resolveGroupWorkflowDetailEffect({
        agent_id: "reviewer",
        avatar_name: "审核员",
        detail_kind: "runtime_progress",
        workflow_role: "reviewer",
        content: "正在检查证据",
      }),
    ).toEqual({
      kind: "show_processing",
      agentId: "reviewer",
      avatarName: "审核员",
      activity: "审核中：正在检查证据",
    });
    expect(
      resolveGroupWorkflowDetailEffect({
        agent_id: "executor",
        detail_kind: "candidate_output",
        candidate_output: "私有候选稿",
      }),
    ).toEqual({ kind: "clear_member", agentId: "executor" });
    expect(
      resolveGroupWorkflowDetailEffect({
        workflow_event_type: "task_completed",
        agent_id: "executor",
      }),
    ).toEqual({ kind: "clear_member", agentId: "executor" });
    expect(
      resolveGroupWorkflowDetailEffect({
        detail_kind: "review_output",
        agent_id: "reviewer",
      }),
    ).toEqual({ kind: "clear_member", agentId: "reviewer" });
    expect(
      resolveGroupWorkflowDetailEffect({
        workflow_event_type: "task_failed",
        agent_id: "executor",
      }),
    ).toEqual({ kind: "clear_member", agentId: "executor" });
    expect(
      resolveGroupWorkflowDetailEffect({
        workflow_event_type: "task_skipped",
        agent_id: "executor",
      }),
    ).toEqual({ kind: "clear_member", agentId: "executor" });
    expect(resolveGroupWorkflowDetailEffect({ workflow_event_type: "workforce_stopped" })).toEqual({
      kind: "clear_all",
    });
    expect(resolveGroupWorkflowDetailEffect({ detail_kind: "unknown", agent_id: "a1" })).toBeNull();
  });

  it("keeps ordinary and stopped-session recovery unchanged", () => {
    expect(
      resolveGroupRunningResumeAction({
        isGroupPane: false,
        executionState: "running",
        hasForegroundStream: true,
        liveReattachEnabled: true,
      }),
    ).toBe("restart");
    expect(
      resolveGroupRunningResumeAction({
        isGroupPane: true,
        executionState: "interrupted",
        hasForegroundStream: false,
        liveReattachEnabled: true,
      }),
    ).toBe("restart");
  });
});
