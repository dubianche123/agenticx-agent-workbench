import { useState } from "react";
import { ChevronDown, ClipboardList } from "lucide-react";
import type { GraphNodeSnapshot } from "./graph-types";
import {
  formatWorkflowValue,
  readWorkflowAttempts,
  resolveWorkflowExecutor,
  resolveWorkflowFailureReason,
  resolveWorkflowReviewFeedback,
  resolveWorkflowStatus,
  resolveWorkflowTaskText,
  truncateWorkflowText,
  workflowAttemptNumber,
  workflowPreviewText,
  workflowStatusLabel,
  type WorkflowAttemptSnapshot,
  type WorkflowTaskSelection,
  WORKFLOW_PREVIEW_LIMIT,
} from "./graph-workflow-details";

type Props = {
  selections: WorkflowTaskSelection[];
  avatarNames?: Record<string, string>;
};

function statusClasses(status: string): string {
  switch (status) {
    case "running":
      return "bg-[var(--ui-btn-primary-bg)]/12 text-[var(--ui-btn-primary-bg)]";
    case "done":
      return "bg-emerald-500/12 text-emerald-700 [html[data-theme=dark]_&]:text-emerald-300 [html[data-theme=dim]_&]:text-emerald-300";
    case "failed":
      return "bg-rose-500/12 text-rose-700 [html[data-theme=dark]_&]:text-rose-300 [html[data-theme=dim]_&]:text-rose-300";
    case "blocked":
      return "bg-amber-500/12 text-amber-700 [html[data-theme=dark]_&]:text-amber-300 [html[data-theme=dim]_&]:text-amber-300";
    case "paused":
      return "bg-surface-hover text-text-subtle";
    default:
      return "bg-surface-hover text-text-subtle";
  }
}

function displayValue(value: string): string {
  return value.trim() || "—";
}

function WorkflowText({ label, value }: { label: string; value: string }) {
  const [expanded, setExpanded] = useState(false);
  const safeValue = truncateWorkflowText(value);
  const isLong = safeValue.length > WORKFLOW_PREVIEW_LIMIT;
  const shown = !isLong || expanded
    ? safeValue
    : workflowPreviewText(safeValue, WORKFLOW_PREVIEW_LIMIT);

  return (
    <div className="min-w-0">
      <div className="mb-1 flex items-baseline gap-1.5">
        <dt className="shrink-0 text-[11px] font-medium text-text-subtle">
          {label}
        </dt>
      </div>
      <dd
        className={`whitespace-pre-wrap break-words text-[12px] leading-relaxed text-text-strong ${
          expanded ? "max-h-56 overflow-y-auto rounded bg-surface-base/60 px-1.5 py-1" : ""
        }`}
      >
        {displayValue(shown)}
      </dd>
      {isLong ? (
        <button
          type="button"
          className="mt-1 text-[11px] font-medium text-[var(--ui-btn-primary-bg)] hover:underline"
          onClick={() => setExpanded((current) => !current)}
          aria-expanded={expanded}
        >
          {expanded ? "收起" : "展开完整内容"}
        </button>
      ) : null}
    </div>
  );
}

function AttemptDetails({
  attempt,
  index,
  node,
}: {
  attempt: WorkflowAttemptSnapshot;
  index: number;
  node: GraphNodeSnapshot;
}) {
  const attemptNumber = workflowAttemptNumber(attempt, index + 1);
  const candidate = formatWorkflowValue(attempt.candidate_output);
  const review = formatWorkflowValue(attempt.review_output);
  const reviewStatus = formatWorkflowValue(attempt.review_status, 120);
  const reviewFeedback = resolveWorkflowReviewFeedback(attempt);
  const failureReason = resolveWorkflowFailureReason(attempt, node);

  return (
    <details className="group rounded-md border border-border/70 bg-surface-base/45">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-2.5 py-2 [&::-webkit-details-marker]:hidden">
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-text-faint transition-transform group-open:rotate-180" />
        <span className="text-[12px] font-medium text-text-strong">第 {attemptNumber} 次尝试</span>
        <span className={`ml-auto rounded-full px-1.5 py-0.5 text-[10px] font-medium ${statusClasses(reviewStatus)}`}>
          {workflowStatusLabel(reviewStatus)}
        </span>
      </summary>
      <dl className="grid gap-2 border-t border-border/60 px-2.5 py-2">
        <WorkflowText label="候选产出" value={candidate} />
        <WorkflowText label="审核输出" value={review} />
        <WorkflowText label="审核状态" value={workflowStatusLabel(reviewStatus)} />
        <WorkflowText label="审核反馈" value={reviewFeedback} />
        <WorkflowText label="失败原因" value={failureReason} />
      </dl>
    </details>
  );
}

function TaskDetails({ selection, avatarNames }: { selection: WorkflowTaskSelection; avatarNames: Record<string, string> }) {
  const { node, sourceAgent } = selection;
  const taskText = resolveWorkflowTaskText(node);
  const status = resolveWorkflowStatus(node);
  const executor = resolveWorkflowExecutor(node, sourceAgent, avatarNames);
  const attempts = readWorkflowAttempts(node);
  const taskFailureReason = resolveWorkflowFailureReason({}, node);

  return (
    <details className="group rounded-lg border border-border bg-surface-card">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-2.5 py-2 [&::-webkit-details-marker]:hidden">
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-text-faint transition-transform group-open:rotate-180" />
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-text-strong" title={taskText}>
          {workflowPreviewText(taskText, 120) || node.id}
        </span>
        <span className="hidden max-w-[120px] truncate text-[11px] text-text-subtle sm:inline" title={executor}>
          {executor}
        </span>
        <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${statusClasses(status)}`}>
          {workflowStatusLabel(status)}
        </span>
      </summary>
      <div className="space-y-3 border-t border-border/60 px-2.5 py-2.5">
        {sourceAgent ? (
          <p className="text-[11px] text-text-faint">
            来自专家汇总：<span className="text-text-subtle">{sourceAgent.label || sourceAgent.id}</span>
          </p>
        ) : null}
        <dl className="grid gap-2">
          <WorkflowText label="任务描述" value={taskText} />
          <WorkflowText label="执行者" value={executor} />
          <WorkflowText label="状态" value={workflowStatusLabel(status)} />
          {taskFailureReason ? (
            <WorkflowText label="任务失败原因" value={taskFailureReason} />
          ) : null}
        </dl>
        <div>
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <h4 className="text-[11px] font-medium text-text-subtle">执行尝试</h4>
            <span className="text-[10px] text-text-faint">{attempts.length} 次</span>
          </div>
          {attempts.length ? (
            <div className="space-y-1.5">
              {attempts.map((attempt, index) => (
                <AttemptDetails
                  key={`${node.id}:attempt:${index}`}
                  attempt={attempt}
                  index={index}
                  node={node}
                />
              ))}
            </div>
          ) : (
            <p className="rounded-md border border-dashed border-border px-2.5 py-2 text-[11px] text-text-faint">
              暂无审核尝试记录
            </p>
          )}
        </div>
      </div>
    </details>
  );
}

export function GraphWorkflowDetails({ selections, avatarNames = {} }: Props) {
  if (selections.length === 0) return null;

  return (
    <section
      className="max-h-[40vh] shrink-0 overflow-y-auto border-b border-border bg-surface-card/70 px-3 py-2"
      aria-label="协作执行详情"
      data-testid="graph-workflow-details"
    >
      <div className="mb-1.5 flex items-center gap-1.5 text-[12px] font-medium text-text-strong">
        <ClipboardList className="h-3.5 w-3.5 text-text-subtle" strokeWidth={1.8} />
        <span>协作执行详情</span>
        <span className="text-[10px] font-normal text-text-faint">{selections.length} 个任务</span>
      </div>
      <div className="space-y-1.5">
        {selections.map((selection) => (
          <TaskDetails
            key={selection.node.id}
            selection={selection}
            avatarNames={avatarNames}
          />
        ))}
      </div>
    </section>
  );
}
