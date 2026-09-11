import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { GraphNodeSnapshot } from "./graph-types";
import { GraphWorkflowDetails } from "./GraphWorkflowDetails";
import { selectWorkflowTaskNodes } from "./graph-workflow-details";

function buildTask(): GraphNodeSnapshot {
  return {
    id: "task-research",
    kind: "task",
    label: "研究任务",
    status: "failed",
    agent_id: "avatar-research",
    task_text: "请整理一份很长的调研任务说明，保留原始换行和上下文。",
    meta: {
      workflow_attempts: [
        {
          attempt: 1,
          candidate_output: "候选方案一",
          review_output: '{"status":"revise"}',
          review_status: "revise",
          review_feedback: "请补充证据链",
          failure_reason: "本次未通过独立审核",
        },
      ],
    },
  };
}

describe("GraphWorkflowDetails", () => {
  it("renders private task dossier fields in compact closed disclosures", () => {
    const node = buildTask();
    const html = renderToStaticMarkup(
      <GraphWorkflowDetails
        selections={selectWorkflowTaskNodes([node], [node])}
        avatarNames={{ "avatar-research": "研究员" }}
      />,
    );

    expect(html).toContain('data-testid="graph-workflow-details"');
    expect(html).toContain("协作执行详情");
    expect(html).toContain("任务描述");
    expect(html).toContain("研究员");
    expect(html).toContain("候选方案一");
    expect(html).toContain("审核输出");
    expect(html).toContain("审核状态");
    expect(html).toContain("审核反馈");
    expect(html).toContain("请补充证据链");
    expect(html).toContain("失败原因");
    expect(html).toContain("本次未通过独立审核");
    expect(html).toContain("需要修改");
    expect(html).toContain("失败");
    expect(html).not.toContain(">revise<");
    // Native details are closed by default: no disclosure is forced open on selection.
    expect(html).not.toMatch(/<details[^>]*\sopen(?:=|\s|>)/);
  });

  it("summarizes all task_ids for an agent projection selection", () => {
    const taskA = buildTask();
    const taskB: GraphNodeSnapshot = {
      ...taskA,
      id: "task-write",
      task_text: "输出交付稿",
      status: "done",
      meta: { workflow_attempts: [] },
    };
    const agent: GraphNodeSnapshot = {
      id: "agent:avatar-research",
      kind: "agent",
      label: "研究员",
      status: "running",
      task_ids: [taskA.id, taskB.id],
      view_role: "agent",
    };

    const html = renderToStaticMarkup(
      <GraphWorkflowDetails
        selections={selectWorkflowTaskNodes([agent], [taskA, taskB])}
        avatarNames={{ "avatar-research": "研究员" }}
      />,
    );

    expect(html).toContain("2 个任务");
    expect(html).toContain("输出交付稿");
    expect(html).toContain("来自专家汇总");
  });

  it("renders no panel for non-task selections", () => {
    const html = renderToStaticMarkup(
      <GraphWorkflowDetails
        selections={[]}
      />,
    );
    expect(html).toBe("");
  });
});
