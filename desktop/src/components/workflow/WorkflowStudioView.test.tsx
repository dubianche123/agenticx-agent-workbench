import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function source(file: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), "src/components/workflow", file), "utf8");
}

describe("Workflow Studio UI contract", () => {
  it("keeps the editor and runtime trace as separate products", () => {
    const studio = source("WorkflowStudioView.tsx");
    const canvas = source("WorkflowCanvas.tsx");
    expect(studio).toContain("WorkflowCanvas");
    expect(studio).toContain("WorkflowRunPanel");
    expect(canvas).not.toContain("RunGraphCanvas");
    expect(canvas).not.toContain("GraphNodeView");
    expect(source("WorkflowRunPanel.tsx")).toContain("受管执行事实");
    expect(source("WorkflowRunPanel.tsx")).toContain("workflow-execution-state");
  });

  it("uses all eight kinds and refuses a client-side connector fallback", () => {
    const palette = source("WorkflowPalette.tsx");
    const types = source("workflow-types.ts");
    const studio = source("WorkflowStudioView.tsx");
    for (const kind of ["trigger", "agent_task", "connector_action", "decision", "approval_gate", "review", "join", "end"]) {
      expect(types).toContain(`"${kind}"`);
    }
    expect(palette).toContain("WORKFLOW_NODE_KINDS.map");
    expect(studio).toContain("setConnectors([])");
    expect(studio).toContain("setCatalogError");
    expect(studio).toContain("onRetryCatalog");
  });

  it("guards stale responses and preserves local drafts on CAS conflicts", () => {
    const studio = source("WorkflowStudioView.tsx");
    expect(studio).toContain("requestGeneration.current");
    expect(studio).toContain("generation !== requestGeneration.current");
    expect(studio).toContain("status === 409");
    expect(studio).toContain("重新加载服务器版本");
    expect(studio).toContain("复制本地 JSON");
    expect(source("workflow-api.ts")).toContain("expected_head_revision");
  });

  it("labels ready managed work and exposes approval controls", () => {
    const panel = source("WorkflowRunPanel.tsx");
    expect(panel).toContain("受管执行器会自动领取");
    expect(panel).toContain("批准");
    expect(panel).toContain("拒绝");
    expect(panel).toContain("继续运行");
    expect(panel).toContain("只读运行轨迹");
  });

  it("shows bounded executor output and separates waiting blocks from execution errors", () => {
    const panel = source("WorkflowRunPanel.tsx");
    expect(panel).toContain("WORKFLOW_OUTPUT_SUMMARY_MAX_LENGTH");
    expect(panel).toContain("node.meta?.workflow_output_summary ?? node.output_summary");
    expect(panel).toContain("等待依赖或审批");
    expect(panel).toContain("等待前置节点或审批完成。");
    expect(panel).toContain('status === "failed" || (status === "blocked"');
    expect(panel).not.toContain(">{node.output_summary}</p>");
  });

  it("uses the backend approver policy enum", () => {
    const inspector = source("WorkflowInspector.tsx");
    for (const policy of ["any", "user", "role", "group", "session_owner"]) {
      expect(inspector).toContain(`value: "${policy}"`);
    }
    expect(inspector).not.toContain("named_principal");
  });

  it("freezes the editor and runtime when starting a new definition", () => {
    const studio = source("WorkflowStudioView.tsx");
    expect(studio).toContain("beginCreate()");
    expect(studio).toContain("setDocument(null)");
    expect(studio).toContain("setCreatingRun(false)");
    expect(studio).toContain("shouldApplyCreate(createRequest)");
  });
});
