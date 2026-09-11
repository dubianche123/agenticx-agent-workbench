import { useMemo } from "react";
import { AlertTriangle, Info } from "lucide-react";
import type { ConnectorCatalogEntry, WorkflowApproverPolicyKind, WorkflowDocument, WorkflowEdge, WorkflowNode, WorkflowNodeKind, WorkflowJsonValue } from "./workflow-types";
import { WORKFLOW_NODE_LABELS, workflowNodeById } from "./workflow-utils";

type Props = {
  document: WorkflowDocument;
  selectedNodeId: string | null;
  connectors: ConnectorCatalogEntry[];
  catalogLoading: boolean;
  catalogError: string | null;
  onRetryCatalog: () => void;
  onChangeDocument: (document: WorkflowDocument) => void;
  onChangeNode: (nodeId: string, patch: Partial<WorkflowNode>) => void;
};

const inputClass = "mt-1 w-full rounded-md border border-border bg-surface-base px-2.5 py-2 text-[12px] text-text-strong outline-none transition placeholder:text-text-faint focus:border-[var(--ui-btn-primary-bg)]";
const labelClass = "text-[11px] font-medium text-text-muted";

const APPROVER_POLICY_OPTIONS: Array<{ value: WorkflowApproverPolicyKind; label: string; requiresValue?: boolean }> = [
  { value: "any", label: "任一合格审批人" },
  { value: "user", label: "指定用户", requiresValue: true },
  { value: "role", label: "指定角色", requiresValue: true },
  { value: "group", label: "指定群组", requiresValue: true },
  { value: "session_owner", label: "当前会话所有者" },
];

function approverPolicyKind(node: WorkflowNode): WorkflowApproverPolicyKind {
  const value = configText(node, "approver_policy_kind");
  return APPROVER_POLICY_OPTIONS.some((option) => option.value === value)
    ? value as WorkflowApproverPolicyKind
    : "session_owner";
}

function configText(node: WorkflowNode, key: string): string {
  const value = node.config[key];
  return value == null ? "" : String(value);
}

function configRecord(value: unknown): Record<string, WorkflowJsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, WorkflowJsonValue>;
}

function asJsonValue(value: unknown): WorkflowJsonValue {
  if (value === undefined) return null;
  if (value == null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(asJsonValue);
  if (typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, asJsonValue(item)]));
  return String(value);
}

function provenanceLabel(value: unknown): string {
  const provenance = String(value || "").trim();
  return provenance === "fictional_demo" || provenance === "derived_from_fictional_demo_dataset"
    ? "虚构示例数据"
    : provenance || "未声明";
}

function criteriaValue(criteria: string[]): string {
  return criteria.join("\n");
}

function criteriaFromText(value: string): string[] {
  return value.split("\n").map((item) => item.trim()).filter(Boolean);
}

function MetadataInspector({ document, onChangeDocument }: Pick<Props, "document" | "onChangeDocument">) {
  return (
    <div className="space-y-4" data-testid="workflow-metadata-inspector">
      <div>
        <h2 className="text-sm font-semibold text-text-strong">工作流信息</h2>
        <p className="mt-1 text-[11px] leading-4 text-text-faint">这是可版本化的业务定义。运行时会绑定已发布版本。</p>
      </div>
      <label className={labelClass}>名称<input className={inputClass} value={document.title} onChange={(event) => onChangeDocument({ ...document, title: event.target.value })} /></label>
      <label className={labelClass}>说明<textarea className={`${inputClass} min-h-[72px] resize-y`} value={document.description} onChange={(event) => onChangeDocument({ ...document, description: event.target.value })} /></label>
      <label className={labelClass}>工作目标<textarea className={`${inputClass} min-h-[72px] resize-y`} value={document.objective} onChange={(event) => onChangeDocument({ ...document, objective: event.target.value })} /></label>
      <label className={labelClass}>完成标准<textarea className={`${inputClass} min-h-[72px] resize-y`} placeholder="每行一条标准" value={criteriaValue(document.completion_criteria)} onChange={(event) => onChangeDocument({ ...document, completion_criteria: criteriaFromText(event.target.value) })} /></label>
      <div className="rounded-lg border border-border bg-surface-card px-3 py-2.5 text-[11px] text-text-faint">
        <div className="flex items-center gap-1.5 text-text-muted"><Info className="h-3.5 w-3.5" aria-hidden />编辑器保留节点位置和连接关系，保存会追加一个完整版本。</div>
        <p className="mt-1">当前版本 v{document.revision}{document.digest ? ` · ${document.digest.slice(0, 10)}…` : ""}</p>
      </div>
    </div>
  );
}

function ConnectorConfig({ node, connectors, catalogLoading, catalogError, onRetryCatalog, onChangeNode }: Pick<Props, "connectors" | "catalogLoading" | "catalogError" | "onRetryCatalog" | "onChangeNode"> & { node: WorkflowNode }) {
  const connectorId = configText(node, "connector_id");
  const actionId = configText(node, "action_id");
  const connector = connectors.find((item) => item.connector_id === connectorId);
  const actions = connector?.actions || [];
  const updateConfig = (patch: Record<string, unknown>) => onChangeNode(node.id, { config: { ...node.config, ...Object.fromEntries(Object.entries(patch).map(([key, value]) => [key, asJsonValue(value)])) } });
  return (
    <div className="space-y-3 rounded-lg border border-border bg-surface-card p-3">
      <div className="flex items-start gap-2"><PlugGlyph /><div><p className="text-[11px] font-medium text-text-strong">服务端目录动作</p><p className="mt-0.5 text-[10px] leading-4 text-text-faint">连接器与动作只能从 Studio catalog 选择。</p></div></div>
      {catalogLoading ? <p className="text-[11px] text-text-faint">正在加载连接器目录…</p> : null}
      {catalogError ? <div className="agx-workflow-alert agx-workflow-alert--warning rounded-md p-2 text-[11px]" role="alert"><div className="flex items-center gap-1.5"><AlertTriangle className="h-3.5 w-3.5" />目录不可用，无法配置连接器动作。</div><button type="button" className="mt-1 underline underline-offset-2" onClick={onRetryCatalog}>重试</button></div> : null}
      <label className={labelClass}>连接器<select className={inputClass} value={connectorId} disabled={catalogLoading || Boolean(catalogError)} onChange={(event) => { const next = event.target.value; const firstAction = connectors.find((item) => item.connector_id === next)?.actions[0]?.action_id || ""; updateConfig({ connector_id: next, action_id: firstAction }); }}><option value="">选择连接器</option>{connectors.map((item) => <option key={item.connector_id} value={item.connector_id}>{item.label}</option>)}</select></label>
      <label className={labelClass}>动作<select className={inputClass} value={actions.some((item) => item.action_id === actionId) ? actionId : ""} disabled={!connector || catalogLoading || Boolean(catalogError)} onChange={(event) => updateConfig({ action_id: event.target.value })}><option value="">选择动作</option>{actions.map((item) => <option key={item.action_id} value={item.action_id}>{item.label} · {item.risk}</option>)}</select></label>
      {connector && actionId && !actions.some((item) => item.action_id === actionId) ? <p className="text-[10px] text-status-warning">当前动作不在服务端目录中，请重新选择。</p> : null}
      {actions.find((item) => item.action_id === actionId)?.description ? <p className="text-[10px] leading-4 text-text-faint">{actions.find((item) => item.action_id === actionId)?.description}</p> : null}
    </div>
  );
}

function PlugGlyph() {
  return <span className="inline-flex rounded-md bg-[var(--ui-accent-surface)] p-1 text-[var(--ui-accent-text)]" aria-hidden>↗</span>;
}

function WorkflowInputContract({ node, onChangeNode }: { node: WorkflowNode; onChangeNode: Props["onChangeNode"] }) {
  const inputKey = node.config.inputs && typeof node.config.inputs === "object" && !Array.isArray(node.config.inputs) ? "inputs" : "input_contract";
  const contract = configRecord(node.config[inputKey]);
  const rows = Array.isArray(contract.rows) ? contract.rows : Array.isArray(contract.example_rows) ? contract.example_rows : [];
  const isFictional = contract.provenance === "fictional_demo" || contract.kind === "fictional_department_usage_dataset";
  const updateContract = (patch: Record<string, unknown>) => onChangeNode(node.id, {
    config: {
      ...node.config,
      [inputKey]: {
        ...contract,
        ...Object.fromEntries(Object.entries(patch).map(([key, value]) => [key, asJsonValue(value)])),
      },
    },
  });
  if (!isFictional) return null;
  return (
    <div className="agx-workflow-contract-card space-y-3 rounded-lg border border-border bg-surface-card p-3" data-testid="workflow-input-contract">
      <div className="flex items-start gap-2"><span className="agx-workflow-contract-icon" aria-hidden>∑</span><div><p className="text-[11px] font-medium text-text-strong">输入数据设置</p><p className="mt-0.5 text-[10px] leading-4 text-text-faint">这是模板内置的虚构示例数据，执行时不会读取真实计费表。</p></div></div>
      <label className={labelClass}>数据集名称<input className={inputClass} value={String(contract.dataset_label || "")} onChange={(event) => updateContract({ dataset_label: event.target.value })} /></label>
      <div className="rounded-md border border-border-muted bg-surface-base px-2.5 py-2 text-[10px] leading-4 text-text-faint"><p>来源标记：<span className="font-medium text-text-muted">{provenanceLabel(contract.provenance)}</span></p><p className="mt-0.5">示例行：{rows.length} 条 · 字段：{Array.isArray(contract.fields) ? contract.fields.join("、") : "未声明"}</p></div>
    </div>
  );
}

function WorkflowArtifactContract({ node, onChangeNode }: { node: WorkflowNode; onChangeNode: Props["onChangeNode"] }) {
  const contract = configRecord(node.config.artifact_contract);
  const formats = Array.isArray(contract.formats) ? contract.formats.map(String).join(" / ") : "md / html";
  const updateContract = (patch: Record<string, unknown>) => onChangeNode(node.id, {
    config: {
      ...node.config,
      artifact_contract: {
        ...contract,
        ...Object.fromEntries(Object.entries(patch).map(([key, value]) => [key, asJsonValue(value)])),
      },
    },
  });
  if (contract.kind !== "workflow_artifact_bundle") return null;
  return (
    <div className="agx-workflow-contract-card space-y-3 rounded-lg border border-border bg-surface-card p-3" data-testid="workflow-artifact-contract">
      <div className="flex items-start gap-2"><span className="agx-workflow-contract-icon" aria-hidden>↗</span><div><p className="text-[11px] font-medium text-text-strong">报告文件设置</p><p className="mt-0.5 text-[10px] leading-4 text-text-faint">保存时会记录这些设置，运行后返回生成结果。</p></div></div>
      <label className={labelClass}>报告文件名<input className={inputClass} value={String(contract.output_basename || "")} onChange={(event) => updateContract({ output_basename: event.target.value })} /></label>
      <div className="rounded-md border border-border-muted bg-surface-base px-2.5 py-2 text-[10px] leading-4 text-text-faint"><p>格式：<span className="font-medium text-text-muted">{formats}</span></p><p className="mt-0.5">目录：<span className="font-medium text-text-muted">{String(contract.directory || "workflow-artifacts")}</span></p><p className="mt-0.5">来源：<span className="font-medium text-text-muted">{provenanceLabel(contract.provenance)}</span></p></div>
    </div>
  );
}

function NodeInspector({ node, document, connectors, catalogLoading, catalogError, onRetryCatalog, onChangeNode, onChangeDocument }: Props & { node: WorkflowNode }) {
  const outgoing = useMemo(() => document.edges.filter((edge) => edge.source === node.id), [document.edges, node.id]);
  const updateConfig = (patch: Record<string, unknown>) => onChangeNode(node.id, { config: { ...node.config, ...Object.fromEntries(Object.entries(patch).map(([key, value]) => [key, asJsonValue(value)])) } });
  const updateEdge = (edgeId: string, patch: Partial<WorkflowEdge>) => onChangeDocument({ ...document, edges: document.edges.map((edge) => edge.id === edgeId ? { ...edge, ...patch } : edge) });
  return (
    <div className="space-y-4" data-testid="workflow-node-inspector">
      <div><p className="text-[10px] uppercase tracking-[0.08em] text-text-faint">{WORKFLOW_NODE_LABELS[node.kind]}</p><h2 className="mt-1 truncate text-sm font-semibold text-text-strong">{node.label}</h2></div>
      <label className={labelClass}>节点名称<input className={inputClass} value={node.label} onChange={(event) => onChangeNode(node.id, { label: event.target.value })} /></label>
      <label className={labelClass}>目标<textarea className={`${inputClass} min-h-[72px] resize-y`} placeholder="这个节点要完成什么？" value={node.objective} onChange={(event) => onChangeNode(node.id, { objective: event.target.value })} /></label>
      {(["agent_task", "connector_action", "review"] as WorkflowNodeKind[]).includes(node.kind) ? <>
        <label className={labelClass}>交付物<textarea className={`${inputClass} min-h-[64px] resize-y`} placeholder="完成后留下什么？" value={node.deliverable} onChange={(event) => onChangeNode(node.id, { deliverable: event.target.value })} /></label>
        <label className={labelClass}>验收标准<textarea className={`${inputClass} min-h-[82px] resize-y`} placeholder="每行一条标准" value={criteriaValue(node.acceptance_criteria)} onChange={(event) => onChangeNode(node.id, { acceptance_criteria: criteriaFromText(event.target.value) })} /></label>
      </> : null}
      {node.kind === "trigger" ? <WorkflowInputContract node={node} onChangeNode={onChangeNode} /> : null}
      {node.kind === "agent_task" ? <WorkflowArtifactContract node={node} onChangeNode={onChangeNode} /> : null}
      {node.kind !== "trigger" && node.kind !== "end" ? <label className="flex items-center gap-2 text-[11px] text-text-muted"><input type="checkbox" checked={node.required} onChange={(event) => onChangeNode(node.id, { required: event.target.checked })} />必需节点</label> : null}
      {node.kind === "connector_action" ? <ConnectorConfig node={node} connectors={connectors} catalogLoading={catalogLoading} catalogError={catalogError} onRetryCatalog={onRetryCatalog} onChangeNode={onChangeNode} /> : null}
      {node.kind === "decision" ? <div className="space-y-2 rounded-lg border border-border bg-surface-card p-3"><p className="text-[11px] font-medium text-text-strong">决策路线</p><p className="text-[10px] leading-4 text-text-faint">从节点右侧不同 handle 拉线；每条 outgoing 连接都需要唯一路线。</p>{outgoing.length === 0 ? <p className="text-[10px] text-status-warning">至少添加两条路线。</p> : outgoing.map((edge) => <div key={edge.id} className="grid grid-cols-[1fr_1fr] gap-2"><input className="rounded-md border border-border bg-surface-base px-2 py-1.5 text-[11px] text-text-strong" aria-label="决策路线" placeholder="路线" value={edge.route} onChange={(event) => updateEdge(edge.id, { route: event.target.value, label: event.target.value })} /><input className="rounded-md border border-border bg-surface-base px-2 py-1.5 text-[11px] text-text-strong" aria-label="路线说明" placeholder="说明" value={edge.label} onChange={(event) => updateEdge(edge.id, { label: event.target.value })} /></div>)}</div> : null}
      {node.kind === "join" ? <label className={labelClass}>汇聚模式<select className={inputClass} value={configText(node, "mode") || "all"} onChange={(event) => updateConfig({ mode: event.target.value })}><option value="all">等待全部路线</option></select></label> : null}
      {node.kind === "approval_gate" ? (() => {
        const policyKind = approverPolicyKind(node);
        const policyOption = APPROVER_POLICY_OPTIONS.find((option) => option.value === policyKind);
        return <div className="space-y-3 rounded-lg border border-border bg-surface-card p-3"><p className="text-[11px] font-medium text-text-strong">审批意图</p><label className={labelClass}>审批摘要<input className={inputClass} value={configText(node, "summary")} onChange={(event) => updateConfig({ summary: event.target.value })} /></label><label className={labelClass}>审批策略<select className={inputClass} value={policyKind} onChange={(event) => updateConfig({ approver_policy_kind: event.target.value, ...(APPROVER_POLICY_OPTIONS.find((option) => option.value === event.target.value)?.requiresValue ? {} : { approver_policy_value: "" }) })}>{APPROVER_POLICY_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>{policyOption?.requiresValue ? <label className={labelClass}>策略值<input className={inputClass} required value={configText(node, "approver_policy_value")} onChange={(event) => updateConfig({ approver_policy_value: event.target.value })} /></label> : null}<label className={labelClass}>目标动作<input className={inputClass} value={configText(node, "target_action_description")} onChange={(event) => updateConfig({ target_action_description: event.target.value })} /></label><label className={labelClass}>有效期（秒）<input className={inputClass} type="number" min={60} max={604800} value={configText(node, "ttl_seconds") || "3600"} onChange={(event) => updateConfig({ ttl_seconds: Math.max(60, Math.min(604800, Number(event.target.value) || 3600)) })} /></label><p className="text-[10px] leading-4 text-text-faint">外部资源授权暂未开放；resource_grantor_ref 会保持为空。</p></div>;
      })() : null}
      {node.kind === "trigger" ? <p className="rounded-lg border border-border bg-surface-card p-3 text-[11px] leading-4 text-text-faint">触发器是工作流唯一入口，不能有入边。</p> : null}
      {node.kind === "end" ? <p className="rounded-lg border border-border bg-surface-card p-3 text-[11px] leading-4 text-text-faint">结束节点没有出边；所有终态路径都会在这里汇总。</p> : null}
    </div>
  );
}

export function WorkflowInspector(props: Props) {
  const node = workflowNodeById(props.document, props.selectedNodeId);
  return (
    <aside className="h-full min-h-0 overflow-y-auto border-l border-border bg-surface-panel p-4" aria-label="工作流属性检查器">
      {node ? <NodeInspector {...props} node={node} /> : <MetadataInspector document={props.document} onChangeDocument={props.onChangeDocument} />}
    </aside>
  );
}
