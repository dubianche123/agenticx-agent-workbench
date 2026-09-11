import {
  ArrowRight,
  CheckCircle2,
  CircleDot,
  GitBranch,
  HandCoins,
  ListChecks,
  MessageSquareText,
  PlugZap,
  type LucideIcon,
} from "lucide-react";
import { WORKFLOW_NODE_KINDS, type WorkflowNodeKind } from "./workflow-types";
import { WORKFLOW_NODE_LABELS, WORKFLOW_NODE_DESCRIPTIONS } from "./workflow-utils";

type Props = {
  onAdd: (kind: WorkflowNodeKind) => void;
  onRetryCatalog?: () => void;
  catalogError?: string | null;
};

const ICONS: Record<WorkflowNodeKind, LucideIcon> = {
  trigger: CircleDot,
  agent_task: MessageSquareText,
  connector_action: PlugZap,
  decision: GitBranch,
  approval_gate: HandCoins,
  review: ListChecks,
  join: ArrowRight,
  end: CheckCircle2,
};

/** The definition palette intentionally has exactly the eight MVP kinds. */
export function WorkflowPalette({ onAdd, onRetryCatalog, catalogError }: Props) {
  return (
    <section className="flex min-h-0 flex-col" aria-label="工作流节点工具箱">
      <div className="mb-2 flex items-center justify-between px-1">
        <div>
          <h2 className="text-xs font-semibold uppercase tracking-[0.08em] text-text-subtle">节点</h2>
          <p className="mt-1 text-[11px] text-text-faint">拖到画布，或点击添加</p>
        </div>
        <span className="rounded-full border border-border px-2 py-0.5 text-[10px] text-text-faint">8 种</span>
      </div>

      <div className="space-y-1.5 overflow-y-auto pr-1">
        {WORKFLOW_NODE_KINDS.map((kind) => {
          const Icon = ICONS[kind];
          return (
            <button
              key={kind}
              type="button"
              draggable
              data-workflow-kind={kind}
              aria-label={`添加${WORKFLOW_NODE_LABELS[kind]}`}
              className="group flex w-full items-start gap-2 rounded-lg border border-border bg-surface-card px-2.5 py-2 text-left transition hover:border-[var(--ui-btn-primary-bg)] hover:bg-surface-hover active:cursor-grabbing"
              onClick={() => onAdd(kind)}
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = "copy";
                event.dataTransfer.setData("application/x-agenticx-workflow-node", kind);
                event.dataTransfer.setData("text/plain", kind);
              }}
            >
              <span className="mt-0.5 rounded-md bg-[var(--ui-accent-surface)] p-1 text-[var(--ui-accent-text)] transition group-hover:bg-[var(--ui-accent-surface-hover)]">
                <Icon className="h-3.5 w-3.5" strokeWidth={1.8} aria-hidden />
              </span>
              <span className="min-w-0">
                <span className="block truncate text-[12px] font-medium text-text-strong">{WORKFLOW_NODE_LABELS[kind]}</span>
                <span className="mt-0.5 block text-[10px] leading-4 text-text-faint">{WORKFLOW_NODE_DESCRIPTIONS[kind]}</span>
              </span>
            </button>
          );
        })}
      </div>

      {catalogError ? (
        <div className="agx-workflow-alert agx-workflow-alert--warning mt-3 rounded-lg p-2.5 text-[11px]" role="alert">
          <p>连接器目录加载失败。连接器动作需要服务端目录。</p>
          {onRetryCatalog ? (
            <button type="button" className="mt-1.5 font-medium underline underline-offset-2" onClick={onRetryCatalog}>
              重试加载目录
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
