import type { WorkflowDocument, WorkflowJsonValue, WorkflowNode } from "./workflow-types";
import { createWorkflowNode, uniqueWorkflowEdgeId } from "./workflow-utils";

export const FICTIONAL_USAGE_TEMPLATE_ID = "fictional-department-usage-report" as const;

export type WorkflowTemplateInputs = {
  title?: string;
  datasetLabel?: string;
  artifactBaseName?: string;
};

export type WorkflowTemplateSummary = {
  id: typeof FICTIONAL_USAGE_TEMPLATE_ID;
  title: string;
  description: string;
  steps: string[];
  notes: string[];
};

export const WORKFLOW_TEMPLATE_CATALOG: readonly WorkflowTemplateSummary[] = [
  {
    id: FICTIONAL_USAGE_TEMPLATE_ID,
    title: "部门用量分析与报告交付",
    description: "用一份明确标注为虚构的团队用量数据生成分析报告，经审批后写入 Markdown 与 HTML 报告文件。",
    steps: ["虚构团队用量数据", "Agent 分析报告", "审批", "生成 MD / HTML 报告文件", "完成"],
    notes: [
      "示例数据仅用于演示，不计入企业用量。",
      "审批通过后生成 Markdown 和 HTML 报告文件，创建后仍可继续编辑。",
    ],
  },
] as const;

const DEFAULT_TEMPLATE_INPUTS = {
  title: "部门用量分析与报告交付",
  datasetLabel: "2026 Q3 虚构部门用量示例",
  artifactBaseName: "department-usage-report",
};

function boundedText(value: unknown, fallback: string, maxLength: number): string {
  const text = String(value ?? "").trim().slice(0, maxLength);
  return text || fallback;
}

/** Keep a user supplied report-file name safe for the backend's file contract. */
export function sanitizeWorkflowArtifactBaseName(value: unknown): string {
  const candidate = String(value ?? "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[.-]+/, "")
    .slice(0, 80);
  return candidate || DEFAULT_TEMPLATE_INPUTS.artifactBaseName;
}

function cloneFictionalRows(): Array<Record<string, WorkflowJsonValue>> {
  // These values are deliberately fictional and stay inside the workflow
  // definition.  They are never presented as tenant billing/usage facts.
  return [
    { user: "演示·林澄", department: "演示研发部", model: "reasoning-small", period: "2026-Q3", input_tokens: 120000, output_tokens: 46000, total_tokens: 166000, requests: 32 },
    { user: "演示·陈晓", department: "演示运营部", model: "reasoning-small", period: "2026-Q3", input_tokens: 84000, output_tokens: 27000, total_tokens: 111000, requests: 21 },
    { user: "演示·沈岚", department: "演示研发部", model: "general-medium", period: "2026-Q3", input_tokens: 156000, output_tokens: 61000, total_tokens: 217000, requests: 44 },
  ];
}

function edge(source: WorkflowNode, target: WorkflowNode, existingIds: string[]): {
  id: string;
  source: string;
  target: string;
  route: string;
  label: string;
} {
  const id = uniqueWorkflowEdgeId(existingIds);
  existingIds.push(id);
  return { id, source: source.id, target: target.id, route: "", label: "" };
}

/**
 * Build a new, independent draft for the built-in business template.
 *
 * Every invocation creates fresh node/edge IDs and nested config values.  The
 * server still owns workflow ID, digest, revision and timestamps when this
 * draft is posted through createWorkflow.
 */
export function createWorkflowTemplateDocument(inputs: WorkflowTemplateInputs = {}): WorkflowDocument {
  const title = boundedText(inputs.title, DEFAULT_TEMPLATE_INPUTS.title, 120);
  const datasetLabel = boundedText(inputs.datasetLabel, DEFAULT_TEMPLATE_INPUTS.datasetLabel, 120);
  const artifactBaseName = sanitizeWorkflowArtifactBaseName(inputs.artifactBaseName);

  const trigger = createWorkflowNode("trigger", [], { x: 70, y: 220 });
  trigger.label = "接收虚构用量数据";
  trigger.objective = "接收用户提供的、明确标注为虚构的部门用量示例；不得读取真实计费表。";
  trigger.config = {
    template_id: FICTIONAL_USAGE_TEMPLATE_ID,
    // The runtime/compiler promotes this exact `inputs` object to the
    // trigger's bounded workflow_output_summary. Downstream bindings then
    // read it through the executor's standard predecessor `output` path.
    inputs: {
      provenance: "fictional_demo",
      dataset_label: datasetLabel,
      description: "示例数据仅用于演示，不计入企业用量。",
      fields: ["user", "department", "model", "period", "input_tokens", "output_tokens", "total_tokens", "requests"],
      rows: cloneFictionalRows(),
    },
  };

  const analysis = createWorkflowNode("agent_task", [trigger.id], { x: 325, y: 220 });
  analysis.label = "Agent 分析部门用量";
  analysis.objective = "按部门、模型和期间汇总示例数据，指出趋势与异常，并给出可复核的资源建议。报告需说明数据仅用于演示。";
  analysis.deliverable = "受限长度的 Markdown 分析草稿，包含数据来源声明、部门汇总、观察结果和建议。";
  analysis.acceptance_criteria = [
    "报告明确标注数据来源为虚构示例，不声称是真实租户用量。",
    "汇总结果可由输入行按 department、model、period 复核。",
    "输出包含观察与建议，且不包含密钥、令牌或外部凭据。",
  ];
  analysis.config = {
    template_id: FICTIONAL_USAGE_TEMPLATE_ID,
    // The managed executor resolves explicit bindings from the predecessor's
    // bounded `output` payload. The runtime owner maps trigger.config.inputs
    // into that payload before this node runs.
    input_bindings: {
      usage_dataset: { source_node: trigger.id, path: "output" },
    },
    output_contract: {
      schema_version: 1,
      kind: "workflow_analysis_report",
      format: "markdown",
      provenance: "derived_from_fictional_demo_dataset",
      max_chars: 24000,
    },
  };

  const approval = createWorkflowNode("approval_gate", [trigger.id, analysis.id], { x: 590, y: 220 });
  approval.label = "审批报告文件生成";
  approval.objective = "让会话所有者确认分析草稿及其虚构数据来源，再继续写入报告文件。";
  approval.config = {
    summary: "批准根据虚构部门用量分析生成 MD / HTML 报告",
    approver_policy_kind: "session_owner",
    approver_policy_value: "",
    target_action_description: "将审批后的分析草稿写入当前工作区的 Markdown 与 HTML 报告文件",
    ttl_seconds: 3600,
    resource_grantor_ref: null,
  };

  const artifact = createWorkflowNode("agent_task", [trigger.id, analysis.id, approval.id], { x: 855, y: 220 });
  artifact.label = "生成 MD / HTML 报告文件";
  artifact.objective = "使用已审批的分析草稿生成一份 Markdown 和一份 HTML 工作区报告文件，保留虚构数据来源声明。";
  artifact.deliverable = `${artifactBaseName}.md 与 ${artifactBaseName}.html 两个工作区报告文件。`;
  artifact.acceptance_criteria = [
    "同时产出 .md 和 .html，文件名使用已确认的报告文件名。",
    "HTML 内容与 Markdown 报告语义一致，并保留示例数据说明。",
    "文件大小受限且写入当前会话可见的工作区报告文件区域。",
  ];
  artifact.config = {
    template_id: FICTIONAL_USAGE_TEMPLATE_ID,
    input_bindings: {
      report_draft: { source_node: analysis.id, path: "output" },
    },
    artifact_contract: {
      schema_version: 1,
      kind: "workflow_artifact_bundle",
      directory: "workflow-artifacts",
      output_basename: artifactBaseName,
      formats: ["md", "html"],
      provenance: "derived_from_fictional_demo_dataset",
      max_bytes_each: 200000,
    },
  };

  const end = createWorkflowNode("end", [trigger.id, analysis.id, approval.id, artifact.id], { x: 1120, y: 220 });
  end.label = "完成";
  end.objective = "记录报告文件已生成并结束本次工作流。";

  const nodes = [trigger, analysis, approval, artifact, end];
  const edgeIds: string[] = [];
  const edges = [
    edge(trigger, analysis, edgeIds),
    edge(analysis, approval, edgeIds),
    edge(approval, artifact, edgeIds),
    edge(artifact, end, edgeIds),
  ];

  return {
    workflow_id: "",
    revision: 1,
    title,
    description: "一个可编辑、可审批、可真实执行的报告工作流。示例数据仅用于演示，不计入企业用量。",
    objective: "把虚构部门用量示例转成经审批的 Markdown / HTML 报告文件。",
    completion_criteria: [
      "Agent 完成可复核的虚构数据分析。",
      "会话所有者明确批准文件生成。",
      "MD 与 HTML 报告文件均已写入并可在工作区查看。",
    ],
    nodes,
    edges,
    digest: "",
    created_at: "",
  };
}
