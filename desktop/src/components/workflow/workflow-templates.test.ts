import { describe, expect, it } from "vitest";
import {
  FICTIONAL_USAGE_TEMPLATE_ID,
  createWorkflowTemplateDocument,
  sanitizeWorkflowArtifactBaseName,
} from "./workflow-templates";

describe("workflow template drafts", () => {
  it("builds an executable fictional usage report graph with the approval boundary", () => {
    const document = createWorkflowTemplateDocument({
      title: "团队报告草稿",
      datasetLabel: "演示数据集 A",
      artifactBaseName: "team-report",
    });

    expect(document.workflow_id).toBe("");
    expect(document.nodes.map((node) => node.kind)).toEqual([
      "trigger",
      "agent_task",
      "approval_gate",
      "agent_task",
      "end",
    ]);
    expect(document.edges).toHaveLength(4);
    expect(document.nodes[0].config.template_id).toBe(FICTIONAL_USAGE_TEMPLATE_ID);
    expect(document.nodes[0].config.inputs).toMatchObject({
      provenance: "fictional_demo",
      dataset_label: "演示数据集 A",
      rows: expect.arrayContaining([
        expect.objectContaining({ user: "演示·林澄", department: "演示研发部" }),
        expect.objectContaining({ user: "演示·陈晓", department: "演示运营部" }),
        expect.objectContaining({ user: "演示·沈岚", department: "演示研发部", total_tokens: 217000 }),
      ]),
    });
    expect(document.nodes[2].config).toMatchObject({
      approver_policy_kind: "session_owner",
      target_action_description: expect.stringContaining("Markdown 与 HTML"),
    });
    expect(document.nodes[3].config.artifact_contract).toMatchObject({
      kind: "workflow_artifact_bundle",
      output_basename: "team-report",
      formats: ["md", "html"],
      provenance: "derived_from_fictional_demo_dataset",
    });
    expect(document.nodes[3].config.artifact_contract).not.toHaveProperty("optional_connector_delivery");
    expect(document.nodes[3].deliverable).toContain("team-report.md");
    expect(document.nodes[3].deliverable).toContain("team-report.html");
  });

  it("creates independent nested drafts so editing one template cannot alter another", () => {
    const first = createWorkflowTemplateDocument();
    const second = createWorkflowTemplateDocument();
    const firstInput = first.nodes[0].config.inputs as Record<string, unknown>;
    const firstRows = firstInput.rows as Array<Record<string, unknown>>;

    expect(first.nodes.map((node) => node.id)).not.toEqual(second.nodes.map((node) => node.id));
    expect(first.edges.map((edge) => edge.id)).not.toEqual(second.edges.map((edge) => edge.id));
    firstRows[0].department = "Edited Demo Team";
    firstInput.dataset_label = "Edited dataset";

    const secondInput = second.nodes[0].config.inputs as Record<string, unknown>;
    const secondRows = secondInput.rows as Array<Record<string, unknown>>;
    expect(secondInput.dataset_label).toBe("2026 Q3 虚构部门用量示例");
    expect(secondRows[0].user).toBe("演示·林澄");
    expect(secondRows[0].department).toBe("演示研发部");
  });

  it("bounds artifact names to a safe basename while retaining readable defaults", () => {
    expect(sanitizeWorkflowArtifactBaseName(" ../部门 usage/report ")).toBe("usage-report");
    expect(sanitizeWorkflowArtifactBaseName("   ")).toBe("department-usage-report");
    expect(sanitizeWorkflowArtifactBaseName("report.md")).toBe("report.md");
  });
});
