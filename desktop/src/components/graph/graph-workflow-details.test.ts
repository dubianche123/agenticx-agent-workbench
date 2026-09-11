import { describe, expect, it } from "vitest";
import type { GraphNodeSnapshot } from "./graph-types";
import {
  formatWorkflowValue,
  readWorkflowAttempts,
  resolveWorkflowExecutor,
  resolveWorkflowFailureReason,
  resolveWorkflowReviewFeedback,
  selectWorkflowTaskNodes,
  truncateWorkflowText,
  workflowPreviewText,
  workflowStatusLabel,
} from "./graph-workflow-details";

function task(id: string, meta: Record<string, unknown> = {}): GraphNodeSnapshot {
  return {
    id,
    kind: "task",
    label: id,
    status: "done",
    task_text: `执行 ${id}`,
    agent_id: "avatar-a",
    meta,
  };
}

describe("graph-workflow-details", () => {
  it("reads durable attempt records and keeps malformed entries out", () => {
    const node = task("task-1", {
      workflow_attempts: [
        { attempt: 1, candidate_output: "候选稿" },
        null,
        "not-an-attempt",
        { attempt: 2, review_status: "pass" },
      ],
    });

    expect(readWorkflowAttempts(node)).toEqual([
      { attempt: 1, candidate_output: "候选稿" },
      { attempt: 2, review_status: "pass" },
    ]);
  });

  it("maps selected agent projection nodes back to task snapshots", () => {
    const taskA = task("task-a");
    const taskB = task("task-b");
    const agent = {
      id: "agent:avatar-a",
      kind: "agent",
      label: "分析师",
      status: "running",
      task_ids: ["task-b", "missing", "task-a", "task-a"],
      view_role: "agent",
    } satisfies GraphNodeSnapshot;

    const selections = selectWorkflowTaskNodes([agent], [taskA, taskB]);
    expect(selections.map((item) => item.node.id)).toEqual(["task-b", "task-a"]);
    expect(selections[0].sourceAgent?.label).toBe("分析师");
  });

  it("keeps directly selected task nodes and ignores presence nodes", () => {
    const selected = selectWorkflowTaskNodes(
      [
        { id: "human", kind: "human", label: "你", status: "ready" },
        task("task-1"),
      ],
      [task("task-1")],
    );
    expect(selected.map((item) => item.node.id)).toEqual(["task-1"]);
    expect(selected[0].sourceAgent).toBeUndefined();
  });

  it("resolves executor names from metadata, avatars, and projection labels", () => {
    expect(resolveWorkflowExecutor(task("t", { executor_name: "元数据执行者" }))).toBe("元数据执行者");
    expect(resolveWorkflowExecutor(task("t"), undefined, { "avatar-a": "头像执行者" })).toBe("头像执行者");
    expect(
      resolveWorkflowExecutor(
        { ...task("t"), agent_id: "unknown" },
        { id: "agent:unknown", kind: "agent", label: "投影执行者", status: "running" },
      ),
    ).toBe("投影执行者");
    expect(resolveWorkflowExecutor({ ...task("t"), agent_id: null })).toBe("未分配");
  });

  it("supports review_feedback and the legacy summary/issues shape", () => {
    expect(resolveWorkflowReviewFeedback({ review_feedback: "请补证据" })).toBe("请补证据");
    expect(
      resolveWorkflowReviewFeedback({
        review_summary: "基本可用",
        review_issues: [{ problem: "缺少来源", fix: "补充引用" }],
      }),
    ).toContain("缺少来源");
  });

  it("uses attempt failure first and node failure as the fallback", () => {
    const node = task("task-1", { failure_reason: "节点失败" });
    expect(resolveWorkflowFailureReason({ failure_reason: "本次失败" }, node)).toBe("本次失败");
    expect(resolveWorkflowFailureReason({}, node)).toBe("节点失败");
  });

  it("formats structured values and bounds long preview text", () => {
    expect(formatWorkflowValue({ reason: "缺证据" })).toContain('"reason": "缺证据"');
    expect(formatWorkflowValue(null)).toBe("");
    expect(truncateWorkflowText("abcdef", 3)).toContain("abc");
    expect(truncateWorkflowText("abcdef", 3)).toContain("已截断");
    expect(workflowPreviewText("abcdef", 3)).toBe("abc…");
  });

  it("localizes runtime and review states without hiding unknown values", () => {
    expect(workflowStatusLabel("running")).toBe("进行中");
    expect(workflowStatusLabel("revise")).toBe("需要修改");
    expect(workflowStatusLabel("approved")).toBe("审核通过");
    expect(workflowStatusLabel("custom-state")).toBe("custom-state");
  });
});
