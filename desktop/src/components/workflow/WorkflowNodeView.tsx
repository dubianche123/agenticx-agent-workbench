import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { ArrowDown, ArrowUp, CheckCircle2, CircleDot, GitBranch, HandCoins, ListChecks, MessageSquareText, PlugZap, Waypoints } from "lucide-react";
import type { WorkflowNodeKind } from "./workflow-types";
import type { WorkflowFlowNode } from "./workflow-utils";
import { WORKFLOW_NODE_LABELS } from "./workflow-utils";

const KIND_ICONS: Record<WorkflowNodeKind, typeof CircleDot> = {
  trigger: CircleDot,
  agent_task: MessageSquareText,
  connector_action: PlugZap,
  decision: GitBranch,
  approval_gate: HandCoins,
  review: ListChecks,
  join: Waypoints,
  end: CheckCircle2,
};

const KIND_ACCENTS: Record<WorkflowNodeKind, string> = {
  trigger: "var(--status-success)",
  agent_task: "var(--ui-btn-primary-bg)",
  connector_action: "var(--ui-btn-primary-bg)",
  decision: "var(--status-warning)",
  approval_gate: "var(--status-warning)",
  review: "var(--ui-accent-text)",
  join: "var(--text-subtle)",
  end: "var(--status-success)",
};

function sourceHandleStyle(index: number, count: number): React.CSSProperties {
  const top = count <= 1 ? 50 : 24 + (index * 52) / Math.max(count - 1, 1);
  return { top: `${top}%`, background: "var(--ui-btn-primary-bg)" };
}

export const WorkflowNodeView = memo(function WorkflowNodeView({ data, selected }: NodeProps<WorkflowFlowNode>) {
  const node = data.workflowNode;
  const Icon = KIND_ICONS[node.kind];
  const routes = (data.outgoingRoutes || []).filter(Boolean);
  const accent = KIND_ACCENTS[node.kind];
  const isTrigger = node.kind === "trigger";
  const isEnd = node.kind === "end";
  const isDecision = node.kind === "decision";

  return (
    <div
      className={`agx-workflow-node relative min-w-[174px] max-w-[218px] rounded-xl border bg-surface-card px-3 py-2.5 text-left shadow-lg transition ${selected ? "agx-workflow-node--selected" : "border-border hover:border-border-strong"}`}
      style={{ borderColor: selected ? accent : undefined }}
      data-workflow-node-kind={node.kind}
      data-workflow-node-id={node.id}
    >
      {!isTrigger ? <Handle type="target" position={Position.Left} id="target" className="!h-2.5 !w-2.5 !border-2 !border-surface-base" style={{ background: accent }} /> : null}
      <div className="flex items-start gap-2">
        <span className="agx-workflow-node-icon mt-0.5 rounded-lg p-1.5" style={{ color: accent }}>
          <Icon className="h-3.5 w-3.5" strokeWidth={1.8} aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <p className="min-w-0 flex-1 truncate text-[12px] font-semibold text-text-strong">{node.label || WORKFLOW_NODE_LABELS[node.kind]}</p>
            {node.required && !isTrigger && !isEnd ? <span className="text-[9px] text-status-warning" title="必需节点">必需</span> : null}
          </div>
          <p className="mt-1 truncate text-[10px] text-text-faint">{WORKFLOW_NODE_LABELS[node.kind]}</p>
          {node.objective ? <p className="mt-1 line-clamp-2 text-[10px] leading-4 text-text-muted">{node.objective}</p> : null}
        </div>
      </div>

      {isDecision && routes.length > 0 ? (
        <div className="mt-2 space-y-0.5 border-t border-border pt-1.5">
          {routes.map((route) => <p key={route} className="truncate pl-1 text-[9px] text-text-faint">路线 · {route}</p>)}
        </div>
      ) : null}

      {!isEnd ? (
        isDecision ? <>
          {routes.map((route, index) => (
            <Handle
              key={route}
              type="source"
              position={Position.Right}
              id={`decision-route:${route}`}
              style={sourceHandleStyle(index, routes.length + 1)}
              className="!h-2.5 !w-2.5 !border-2 !border-surface-base"
              title={route}
            />
          ))}
          {/* A blank route handle lets the editor add another branch before its route is named in the inspector. */}
          <Handle type="source" position={Position.Right} id="source" style={sourceHandleStyle(routes.length, routes.length + 1)} className="!h-2.5 !w-2.5 !border-2 !border-surface-base" title="新增路线" />
        </> : (
          <Handle type="source" position={Position.Right} id="source" className="!h-2.5 !w-2.5 !border-2 !border-surface-base" style={{ background: accent }} />
        )
      ) : null}
      {!isTrigger ? <ArrowUp className="pointer-events-none absolute -left-[7px] top-1/2 h-2.5 w-2.5 -translate-y-1/2 text-text-faint" aria-hidden /> : null}
      {!isEnd ? <ArrowDown className="pointer-events-none absolute -right-[7px] top-1/2 h-2.5 w-2.5 -translate-y-1/2 text-text-faint" aria-hidden /> : null}
    </div>
  );
});
