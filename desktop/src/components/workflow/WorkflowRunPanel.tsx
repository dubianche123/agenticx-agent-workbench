import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Check, Clock3, ExternalLink, FileText, Loader2, RefreshCw, Settings2, ShieldCheck, X } from "lucide-react";
import { useAppStore } from "../../store";
import type { WorkflowApproval, WorkflowArtifactRef, WorkflowRun, WorkflowRunRefreshContext, WorkflowRuntimeNode } from "./workflow-types";
import {
  cancelWorkflowRun,
  decideWorkflowApproval,
  resumeWorkflowApproval,
  resumeWorkflowRun,
  resolveWorkflowConfirmation,
  retryWorkflowNode,
  WorkflowApiError,
  type WorkflowApiOptions,
} from "./workflow-api";
import {
  workflowApprovalActionability,
  workflowExecutionState,
  workflowExecutionStateLabel,
  workflowNodeBlockedReason,
  workflowNodeErrorCode,
  workflowNodeRequiresReconciliation,
  workflowRuntimeNodes,
  workflowRunIsTerminal,
} from "./workflow-utils";

type Props = {
  run: WorkflowRun | null;
  approvals?: WorkflowApproval[];
  apiBase: string;
  apiToken: string;
  sessionId: string;
  runContextToken: number;
  onRefresh: (context: WorkflowRunRefreshContext) => Promise<void>;
  onClose?: () => void;
};

const POLL_INTERVAL_MS = 1_200;
const POLL_MAX_DURATION_MS = 10 * 60 * 1_000;
const WORKFLOW_OUTPUT_SUMMARY_MAX_LENGTH = 2_000;

const nodeStatusLabels: Record<string, string> = {
  pending: "等待前置节点",
  ready: "已排队",
  running: "执行中",
  blocked: "需要处理",
  paused: "已暂停",
  done: "已完成",
  failed: "失败",
  skipped: "已跳过",
  cancelled: "已取消",
};

const errorCodeLabels: Record<string, string> = {
  agent_model_unavailable: "当前会话没有可用的模型。选择一个已配置的模型后，再重试这个节点。",
  connector_unavailable: "连接器当前不可用，请检查连接器配置或授权后再重试。",
  connector_not_configured: "该连接器尚未配置，请完成连接器设置后再重试。",
  invalid_connector_inputs: "连接器输入未通过校验，请检查节点输入。",
  uncertain_external_side_effect: "外部写入结果不确定。请先核对外部系统的实际结果，再明确确认后重试。",
  execution_timeout: "节点执行超时，当前结果未被确认。请检查原因后再恢复。",
};

function nodeLabel(node: WorkflowRuntimeNode): string {
  return String(node.label || node.meta?.label || node.workflow_node_id || node.meta?.workflow_node_id || node.id || "节点");
}

function nodeKind(node: WorkflowRuntimeNode): string {
  return String(node.workflow_node_kind || node.meta?.workflow_node_kind || node.kind || "");
}

function approvalValue(approval: WorkflowApproval, key: string): string {
  const value = approval[key as keyof WorkflowApproval];
  if (value != null && typeof value !== "object") return String(value);
  const request = approval.request_json?.[key];
  return request == null ? "" : String(request);
}

function friendlyError(error: unknown): string {
  if (error instanceof WorkflowApiError) return error.message;
  return error instanceof Error && error.message ? error.message : "运行操作失败，请稍后重试";
}

function statusTone(status: string): string {
  if (["done", "approved", "consumed", "completed", "closed"].includes(status)) return "text-status-success";
  if (["failed", "rejected", "expired", "cancelled", "canceled"].includes(status)) return "text-status-error";
  if (["blocked", "pending", "ready", "running", "queued"].includes(status)) return "text-status-warning";
  return "text-text-muted";
}

function valuePreview(value: unknown, maxLength = 500): string {
  if (typeof value === "string") return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
  try {
    const text = JSON.stringify(value, null, 2);
    return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
  } catch {
    return String(value ?? "");
  }
}

function artifactPath(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!value || typeof value !== "object") return "";
  const ref = value as WorkflowArtifactRef;
  return String(ref.path || ref.path_or_uri || "").trim();
}

function artifactLabel(value: unknown): string {
  const path = artifactPath(value);
  if (!path) return "文件产物";
  return path.split(/[\\/]/).filter(Boolean).at(-1) || path;
}

function nodeReason(node: WorkflowRuntimeNode): { text: string; code: string } {
  const code = workflowNodeErrorCode(node);
  const raw = workflowNodeBlockedReason(node);
  return {
    text: errorCodeLabels[code] || raw || "节点需要处理后才能继续。",
    code,
  };
}

function nodeOutputSummary(node: WorkflowRuntimeNode): string {
  return valuePreview(
    node.meta?.workflow_output_summary ?? node.output_summary,
    WORKFLOW_OUTPUT_SUMMARY_MAX_LENGTH,
  );
}

function nodeStatusLabel(node: WorkflowRuntimeNode, status: string): string {
  if (status === "blocked" && !workflowNodeErrorCode(node)) return "等待依赖或审批";
  return nodeStatusLabels[status] || status;
}

function nodeEvidence(node: WorkflowRuntimeNode): unknown[] {
  const direct = Array.isArray(node.evidence) ? node.evidence : [];
  const meta = node.meta?.workflow_evidence;
  return direct.length > 0 ? direct : Array.isArray(meta) ? meta : [];
}

function runArtifacts(run: WorkflowRun, nodes: WorkflowRuntimeNode[]): Array<{ path: string; label: string; kind: string }> {
  const refs: unknown[] = [
    ...(Array.isArray(run.artifacts) ? run.artifacts : []),
    ...nodes.flatMap((node) => Array.isArray(node.meta?.workflow_artifacts) ? node.meta.workflow_artifacts : []),
  ];
  const seen = new Set<string>();
  const result: Array<{ path: string; label: string; kind: string }> = [];
  for (const ref of refs) {
    const path = artifactPath(ref);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    const kind = ref && typeof ref === "object" ? String((ref as WorkflowArtifactRef).format || (ref as WorkflowArtifactRef).kind || "文件") : "文件";
    result.push({ path, label: artifactLabel(ref), kind });
  }
  return result;
}

type ActionContext = {
  controller: AbortController;
  generation: number;
  key: string;
  runId: string;
  sessionId: string;
};

type WorkflowConfirmationRequest = {
  requestId: string;
  question: string;
  agentId: string;
  nodeId: string;
  context: Record<string, unknown>;
};

function pendingWorkflowConfirmations(nodes: WorkflowRuntimeNode[], runId: string): WorkflowConfirmationRequest[] {
  const requests = new Map<string, WorkflowConfirmationRequest>();
  const responses = new Set<string>();
  for (const node of nodes) {
    const rows = node.meta?.workflow_events;
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      if (!row || typeof row !== "object" || Array.isArray(row)) continue;
      const event = row as Record<string, unknown>;
      const type = String(event.type || "").trim().toLowerCase();
      const payload = event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
        ? event.payload as Record<string, unknown>
        : null;
      if (!payload) continue;
      const requestId = String(payload.id || payload.request_id || "").trim();
      if (!requestId) continue;
      if (type === "confirmation_response" || type === "confirm_response") {
        responses.add(requestId);
        continue;
      }
      if (type !== "confirmation_required" && type !== "confirm_required") continue;
      const context = payload.context && typeof payload.context === "object" && !Array.isArray(payload.context)
        ? payload.context as Record<string, unknown>
        : {};
      const nodeId = String(node.workflow_node_id || node.id || "");
      requests.set(requestId, {
        requestId,
        question: String(payload.question || "确认执行这个受保护操作？"),
        // WorkflowExecutor currently binds the gate to this deterministic
        // per-node agent id but the persisted confirmation context may come
        // from an older server without agent_id. Prefer the explicit field;
        // derive the legacy value so /api/confirm resolves the right gate.
        agentId: String(context.agent_id || payload.agent_id || (nodeId && runId ? `workflow:${runId}:${nodeId}` : "meta")),
        nodeId,
        context,
      });
    }
  }
  return [...requests.values()].filter((request) => !responses.has(request.requestId));
}

export function WorkflowRunPanel({ run, approvals: suppliedApprovals, apiBase, apiToken, sessionId, runContextToken, onRefresh, onClose }: Props) {
  const openSettings = useAppStore((state) => state.openSettings);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [reconcileNodeId, setReconcileNodeId] = useState<string | null>(null);
  const [pageVisible, setPageVisible] = useState(() => typeof document === "undefined" || document.visibilityState !== "hidden");
  const [pollState, setPollState] = useState<"idle" | "polling" | "paused" | "stopped">("idle");
  const actionGenerationRef = useRef(0);
  const actionAbortRef = useRef<AbortController | null>(null);
  const pollEpochRef = useRef(0);
  const pollStartedRef = useRef<{ key: string; at: number } | null>(null);
  const pollTimerRef = useRef<number | null>(null);
  const pollControllerRef = useRef<AbortController | null>(null);
  const pollInFlightRef = useRef<Promise<void> | null>(null);

  const nodes = useMemo(() => run ? workflowRuntimeNodes(run) : [], [run]);
  const approvals = suppliedApprovals || run?.approvals || [];
  const readyNodeIds = useMemo(() => new Set(run?.ready_node_ids || []), [run?.ready_node_ids]);
  const readyNodes = nodes.filter((node) => (node.status === "ready" || readyNodeIds.has(String(node.workflow_node_id || node.id))) && !["trigger", "join", "end"].includes(nodeKind(node)));
  const artifacts = useMemo(() => run ? runArtifacts(run, nodes) : [], [nodes, run]);
  const pendingConfirmations = useMemo(() => pendingWorkflowConfirmations(nodes, String(run?.run_id || "")), [nodes, run?.run_id]);
  const pendingApprovals = approvals.filter((approval) => String(approval.status || "").toLowerCase() === "pending");
  const executionState = workflowExecutionState(run);
  const terminal = workflowRunIsTerminal(run);
  const apiOptions = useMemo<WorkflowApiOptions>(() => ({ apiBase, apiToken }), [apiBase, apiToken]);

  useEffect(() => {
    const handleVisibility = () => setPageVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, []);

  useEffect(() => {
    actionGenerationRef.current += 1;
    actionAbortRef.current?.abort();
    actionAbortRef.current = null;
    setBusyAction(null);
    setError("");
    setNotice("");
    setReconcileNodeId(null);
    return () => {
      actionGenerationRef.current += 1;
      actionAbortRef.current?.abort();
      actionAbortRef.current = null;
    };
  }, [apiBase, apiToken, run?.run_id, run?.workflow_id, run?.session_id, sessionId, runContextToken]);

  useEffect(() => {
    pollControllerRef.current?.abort();
    if (pollTimerRef.current != null) window.clearTimeout(pollTimerRef.current);
    pollTimerRef.current = null;
    pollEpochRef.current += 1;
    if (!run?.run_id || !sessionId || terminal) {
      setPollState("stopped");
      return;
    }
    if (!pageVisible) {
      setPollState("paused");
      return;
    }
    const key = `${run.workflow_id}\u0000${run.run_id}\u0000${sessionId}\u0000${runContextToken}`;
    if (pollStartedRef.current?.key !== key) pollStartedRef.current = { key, at: Date.now() };
    const startedAt = pollStartedRef.current.at;
    const epoch = pollEpochRef.current;
    let disposed = false;

    const schedule = (delay = POLL_INTERVAL_MS) => {
      if (disposed || epoch !== pollEpochRef.current) return;
      pollTimerRef.current = window.setTimeout(() => void tick(), delay);
    };
    const tick = async () => {
      if (disposed || epoch !== pollEpochRef.current) return;
      if (Date.now() - startedAt >= POLL_MAX_DURATION_MS) {
        setPollState("stopped");
        return;
      }
      if (pollInFlightRef.current) {
        schedule(POLL_INTERVAL_MS);
        return;
      }
      const controller = new AbortController();
      pollControllerRef.current = controller;
      const context: WorkflowRunRefreshContext = {
        workflowId: run.workflow_id,
        sessionId,
        runId: run.run_id,
        requestToken: runContextToken,
        signal: controller.signal,
      };
      setPollState("polling");
      const request = (async () => {
        try {
          await onRefresh(context);
        } catch (cause) {
          if (!controller.signal.aborted && !disposed && epoch === pollEpochRef.current) setError(friendlyError(cause));
        } finally {
          if (pollControllerRef.current === controller) pollControllerRef.current = null;
        }
      })();
      pollInFlightRef.current = request;
      try {
        await request;
      } finally {
        if (pollInFlightRef.current === request) pollInFlightRef.current = null;
        if (!disposed && epoch === pollEpochRef.current) schedule();
      }
    };
    schedule();
    return () => {
      disposed = true;
      pollEpochRef.current += 1;
      pollControllerRef.current?.abort();
      if (pollTimerRef.current != null) window.clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    };
  }, [onRefresh, pageVisible, run?.execution?.state, run?.run_id, run?.session_id, run?.version, run?.workflow_id, runContextToken, sessionId, terminal]);

  const beginAction = useCallback((key: string): ActionContext | null => {
    const runId = String(run?.run_id || "").trim();
    const capturedSessionId = String(run?.session_id || sessionId || "").trim();
    if (!runId || !capturedSessionId || busyAction) return null;
    actionAbortRef.current?.abort();
    const controller = new AbortController();
    const generation = ++actionGenerationRef.current;
    actionAbortRef.current = controller;
    setBusyAction(key);
    setError("");
    setNotice("");
    return { controller, generation, key, runId, sessionId: capturedSessionId };
  }, [busyAction, run?.run_id, run?.session_id, sessionId]);

  const isActionCurrent = useCallback((action: ActionContext) => (
    !action.controller.signal.aborted
    && actionGenerationRef.current === action.generation
    && actionAbortRef.current === action.controller
    && String(run?.run_id || "") === action.runId
    && String(run?.session_id || sessionId || "") === action.sessionId
    && String(sessionId || "") === action.sessionId
  ), [run?.run_id, run?.session_id, sessionId]);

  const finishAction = useCallback((action: ActionContext) => {
    if (!isActionCurrent(action)) return;
    actionAbortRef.current = null;
    setBusyAction(null);
  }, [isActionCurrent]);

  const refreshContext = useCallback((): WorkflowRunRefreshContext | null => {
    if (!run?.run_id || !run.workflow_id || !sessionId) return null;
    return { workflowId: run.workflow_id, sessionId, runId: run.run_id, requestToken: runContextToken };
  }, [run?.run_id, run?.workflow_id, runContextToken, sessionId]);

  const recoverFromConflict = useCallback(async (action: ActionContext) => {
    if (!isActionCurrent(action)) return;
    setError("运行状态已变化，正在刷新当前状态…");
    const context = refreshContext();
    if (context) await onRefresh(context);
    if (isActionCurrent(action)) setError("状态已更新，请根据当前状态继续操作。");
  }, [isActionCurrent, onRefresh, refreshContext]);

  const handleRunMutation = useCallback(async (
    actionKey: string,
    mutate: (action: ActionContext) => Promise<unknown>,
    successMessage: string,
  ) => {
    if (!run) return;
    const action = beginAction(actionKey);
    if (!action) return;
    try {
      await mutate(action);
      if (!isActionCurrent(action)) return;
      const context = refreshContext();
      if (context) await onRefresh(context);
      if (isActionCurrent(action)) setNotice(successMessage);
    } catch (cause) {
      if (!isActionCurrent(action)) return;
      if (cause instanceof WorkflowApiError && cause.isConflict) {
        await recoverFromConflict(action);
      } else if (!action.controller.signal.aborted) {
        setError(friendlyError(cause));
      }
    } finally {
      finishAction(action);
    }
  }, [beginAction, finishAction, isActionCurrent, onRefresh, recoverFromConflict, refreshContext, run]);

  const handleCancel = useCallback(() => {
    if (!run) return;
    void handleRunMutation("cancel-run", (action) => cancelWorkflowRun(apiOptions, action.runId, {
      session_id: action.sessionId,
      expected_version: Number.isInteger(run.version) ? run.version : undefined,
    }), "运行已取消。");
  }, [apiOptions, handleRunMutation, run]);

  const handleResumeRun = useCallback(() => {
    if (!run) return;
    void handleRunMutation("resume-run", (action) => resumeWorkflowRun(apiOptions, action.runId, {
      session_id: action.sessionId,
      expected_version: Number.isInteger(run.version) ? run.version : undefined,
    }), "已请求恢复运行。");
  }, [apiOptions, handleRunMutation, run]);

  const handleRetryNode = useCallback((node: WorkflowRuntimeNode) => {
    if (!run) return;
    const reconcile = workflowNodeRequiresReconciliation(node);
    if (reconcile && reconcileNodeId !== node.id) {
      setError("该节点的外部写入结果不确定。请先勾选“我已核对外部结果”，再执行重试。");
      return;
    }
    void handleRunMutation(`retry-node:${node.id}`, (action) => retryWorkflowNode(apiOptions, action.runId, String(node.workflow_node_id || node.id), {
      session_id: action.sessionId,
      expected_version: Number.isInteger(run.version) ? run.version : 0,
      ...(reconcile ? { reconcile: true } : {}),
    }), "已请求重试节点。");
  }, [apiOptions, handleRunMutation, reconcileNodeId, run]);

  const handleDecision = useCallback((approval: WorkflowApproval, decision: "approved" | "rejected") => {
    if (!run) return;
    const actionability = workflowApprovalActionability(run, approval);
    if (!actionability.canAct) {
      setError(actionability.reason);
      return;
    }
    void handleRunMutation(`approval:${approval.approval_id}:${decision}`, (action) => decideWorkflowApproval(apiOptions, approval.approval_id, {
      session_id: action.sessionId,
      expected_version: approval.version,
      decision,
      ...(run.version != null ? { expected_run_version: run.version } : {}),
    }), decision === "approved" ? "审批已记录，等待继续运行。" : "审批已拒绝，运行将停止。");
  }, [apiOptions, handleRunMutation, run]);

  const handleResumeApproval = useCallback((approval: WorkflowApproval) => {
    if (!run) return;
    const actionability = workflowApprovalActionability(run, approval);
    if (!actionability.canAct) {
      setError(actionability.reason);
      return;
    }
    void handleRunMutation(`approval-resume:${approval.approval_id}`, (action) => resumeWorkflowApproval(apiOptions, approval.approval_id, {
      session_id: action.sessionId,
      expected_version: approval.version,
      ...(run.version != null ? { expected_run_version: run.version } : {}),
    }), "已请求继续运行。");
  }, [apiOptions, handleRunMutation, run]);

  const handleExternalConfirmation = useCallback((confirmation: WorkflowConfirmationRequest, approved: boolean) => {
    if (!run) return;
    void handleRunMutation(
      `external-confirm:${confirmation.requestId}`,
      (action) => resolveWorkflowConfirmation(apiOptions, {
        session_id: action.sessionId,
        request_id: confirmation.requestId,
        approved,
        agent_id: confirmation.agentId || "meta",
      }),
      approved ? "外部操作已确认，节点将继续执行。" : "外部操作已拒绝，节点将停止或等待后续处理。",
    );
  }, [apiOptions, handleRunMutation, run]);

  const openArtifact = useCallback(async (path: string) => {
    const open = window.agenticxDesktop?.shellOpenPath;
    if (!open) {
      setError(`当前环境无法打开文件：${path}`);
      return;
    }
    const result = await open(path);
    if (!result.ok) setError(result.error || `无法打开文件：${path}`);
  }, []);

  const openProviderSettings = useCallback(() => {
    openSettings("provider");
  }, [openSettings]);

  const runVersion = run?.execution?.version || run?.version || 0;
  const canCancel = Boolean(run && !terminal && !busyAction);
  const canResume = Boolean(run && !terminal && pendingApprovals.length === 0 && executionState !== "running" && !busyAction);
  const pollMessage = pollState === "polling"
    ? "自动刷新中"
    : pollState === "paused"
      ? "窗口隐藏时已暂停刷新"
      : pollState === "stopped" && !terminal
        ? "自动刷新已暂停，可手动刷新"
        : "";

  return (
    <section className="flex h-full min-h-0 flex-col border-t border-border bg-surface-panel" aria-label="工作流运行面板" data-testid="workflow-run-panel">
      <header className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div className="flex min-w-0 items-center gap-2"><span className="rounded-md bg-[var(--ui-accent-surface)] p-1.5 text-[var(--ui-accent-text)]"><ShieldCheck className="h-4 w-4" aria-hidden /></span><div className="min-w-0"><h2 className="truncate text-sm font-semibold text-text-strong">运行预览</h2>{run ? <p className="truncate text-[10px] text-text-faint" title={run.run_id}>执行版本 v{runVersion} · {run.run_id}</p> : null}</div></div>
        <div className="flex shrink-0 items-center gap-1"><span className="hidden text-[10px] text-text-faint sm:inline" aria-live="polite">{pollMessage}</span>{run && canResume ? <button type="button" className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1.5 text-[11px] text-text-muted hover:bg-surface-hover disabled:opacity-50" onClick={handleResumeRun} disabled={Boolean(busyAction)}><RefreshCw className={`h-3 w-3 ${busyAction === "resume-run" ? "animate-spin" : ""}`} />恢复运行</button> : null}{run && canCancel ? <button type="button" className="agx-workflow-button--danger inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-[11px] hover:bg-surface-hover disabled:opacity-50" onClick={handleCancel} disabled={Boolean(busyAction)}><X className="h-3 w-3" />取消运行</button> : null}<button type="button" className="rounded-md p-1.5 text-text-muted hover:bg-surface-hover disabled:opacity-50" title="刷新运行" aria-label="刷新运行" onClick={() => { const context = refreshContext(); if (context) void onRefresh(context); }} disabled={!run || Boolean(busyAction)}><RefreshCw className="h-3.5 w-3.5" /></button>{onClose ? <button type="button" className="rounded-md p-1.5 text-text-muted hover:bg-surface-hover" title="关闭运行预览" aria-label="关闭运行预览" onClick={onClose}><X className="h-4 w-4" /></button> : null}</div>
      </header>

      {!run ? <div className="flex min-h-0 flex-1 items-center justify-center p-5 text-center text-sm text-text-faint">创建运行后，这里会显示受管执行进度和结果证据。</div> : <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-lg border border-border bg-surface-card p-2.5"><p className="text-[10px] text-text-faint">运行状态</p><p className={`mt-1 text-sm font-semibold ${statusTone(executionState)}`} data-testid="workflow-execution-state">{workflowExecutionStateLabel(executionState)}</p><p className="mt-0.5 text-[10px] text-text-faint">受管执行状态</p></div>
          <div className="rounded-lg border border-border bg-surface-card p-2.5"><p className="text-[10px] text-text-faint">进度版本</p><p className="mt-1 text-sm font-semibold text-text-strong">v{runVersion}</p><p className="mt-0.5 text-[10px] text-text-faint">用于防止旧操作覆盖新状态</p></div>
        </div>
        <div className="mt-3 rounded-lg border border-border bg-surface-card p-2.5 text-[10px] text-text-faint"><p>发布版本</p><p className="mt-1 break-all text-text-muted">v{run.workflow_revision} · {run.workflow_digest || "未返回摘要"}</p></div>

        {run.execution?.last_error ? <div className="agx-workflow-alert agx-workflow-alert--error mt-3 rounded-lg px-3 py-2.5 text-[11px]" role="alert" data-testid="workflow-run-error"><p className="font-medium">运行需要处理</p><p className="mt-0.5 whitespace-pre-wrap break-words">{run.execution.last_error}</p></div> : null}

        {readyNodes.length > 0 ? <section className="mt-4"><h3 className="mb-2 text-xs font-semibold text-text-strong">下一步</h3><div className="space-y-2">{readyNodes.map((node) => <div key={node.id} className="agx-workflow-alert agx-workflow-alert--warning flex items-start gap-2 rounded-lg px-3 py-2"><Clock3 className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden /><div><p className="text-xs font-medium text-text-strong">{nodeLabel(node)}</p><p className="mt-0.5 text-[11px]">已排队，受管执行器会自动领取</p><p className="mt-1 text-[10px] text-text-faint">窗口关闭后执行仍会在本地服务中继续。</p></div></div>)}</div></section> : null}

        {approvals.length > 0 ? <section className="mt-4"><h3 className="mb-2 text-xs font-semibold text-text-strong">审批门</h3><div className="space-y-2">{approvals.map((approval) => { const summary = approvalValue(approval, "summary") || "需要明确审批后继续"; const actionDescription = approvalValue(approval, "target_action_description"); const actionability = workflowApprovalActionability(run, approval); const approvalStatus = String(approval.status || "").trim().toLowerCase(); const busy = busyAction?.startsWith(`approval:${approval.approval_id}`) || busyAction === `approval-resume:${approval.approval_id}`; return <div key={approval.approval_id} className="rounded-lg border border-border bg-surface-card p-3"><div className="flex items-start justify-between gap-2"><div className="min-w-0"><p className="text-xs font-medium text-text-strong">{summary}</p>{actionDescription ? <p className="mt-1 text-[11px] text-text-muted">{actionDescription}</p> : null}<p className="mt-1 text-[10px] text-text-faint">状态：<span className={statusTone(approvalStatus)}>{approvalStatus}</span> · 审批版本 v{approval.version}</p>{approval.expires_at ? <p className="mt-0.5 text-[10px] text-text-faint">有效至 {approval.expires_at}</p> : null}</div><AlertTriangle className="h-4 w-4 shrink-0 text-status-warning" aria-hidden /></div>{approvalStatus === "pending" && actionability.canAct ? <div className="mt-3 flex gap-2"><button type="button" className="inline-flex items-center gap-1 rounded-md bg-btnPrimary px-2.5 py-1.5 text-[11px] text-btnPrimary-text hover:bg-btnPrimary-hover disabled:opacity-50" disabled={Boolean(busyAction)} onClick={() => handleDecision(approval, "approved")}>{busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}批准</button><button type="button" className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-[11px] text-text-muted hover:bg-surface-hover disabled:opacity-50" disabled={Boolean(busyAction)} onClick={() => handleDecision(approval, "rejected")}><X className="h-3 w-3" />拒绝</button></div> : null}{approvalStatus === "approved" && actionability.canAct ? <button type="button" className="mt-3 inline-flex items-center gap-1 rounded-md bg-btnPrimary px-2.5 py-1.5 text-[11px] text-btnPrimary-text hover:bg-btnPrimary-hover disabled:opacity-50" disabled={Boolean(busyAction)} onClick={() => handleResumeApproval(approval)}>{busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}继续运行</button> : null}{!actionability.canAct ? <p className="mt-3 text-[11px] text-status-warning">{actionability.reason}</p> : null}</div>; })}</div></section> : null}

        {pendingConfirmations.length > 0 ? (
          <section className="agx-workflow-alert agx-workflow-alert--warning mt-4 rounded-lg px-3 py-2.5" data-testid="workflow-external-confirmations">
            <div className="flex items-start gap-2">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-status-warning" aria-hidden />
              <div className="min-w-0 flex-1">
                <h3 className="text-xs font-semibold text-text-strong">需要确认的外部操作</h3>
                <p className="mt-1 text-[11px] leading-4 text-text-muted">受保护工具正在等待你的明确选择。确认前请核对实际操作内容和目标；窗口关闭不会替你批准。</p>
                <div className="mt-2 space-y-2">
                  {pendingConfirmations.map((confirmation) => {
                    const busy = busyAction === `external-confirm:${confirmation.requestId}`;
                    const inputPreview = confirmation.context.input_preview ?? confirmation.context.preview;
                    const hasInputPreview = inputPreview != null && (typeof inputPreview !== "string" || inputPreview.trim().length > 0);
                    const contextRows = [
                      ["操作", String(confirmation.context.action_id || confirmation.context.operation_id || "")],
                      ["目标", String(confirmation.context.resource_ref || "")],
                    ].filter(([, value]) => Boolean(value.trim()));
                    return (
                      <div key={confirmation.requestId} className="rounded-md border border-border bg-surface-card px-2.5 py-2">
                        <p className="text-[11px] font-medium text-text-strong">{confirmation.question}</p>
                        <p className="mt-1 text-[10px] text-text-faint">节点：{confirmation.nodeId || "工作流节点"}</p>
                        {contextRows.length > 0 ? (
                          <dl className="mt-2 space-y-1 text-[10px]">
                            {contextRows.map(([label, value]) => (
                              <div key={label} className="flex gap-2">
                                <dt className="w-14 shrink-0 text-text-faint">{label}</dt>
                                <dd className="min-w-0 break-all text-text-muted">{valuePreview(value, 300)}</dd>
                              </div>
                            ))}
                          </dl>
                        ) : null}
                        {hasInputPreview ? (
                          <details className="mt-2 rounded-md border border-border-muted bg-surface-base px-2 py-1.5" open>
                            <summary className="cursor-pointer text-[10px] text-text-muted">操作内容预览</summary>
                            <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words text-[10px] leading-4 text-text-faint" data-testid="workflow-confirm-input-preview">{valuePreview(inputPreview, 2000)}</pre>
                          </details>
                        ) : (
                          <p className="mt-2 rounded-md border border-status-warning/50 bg-status-warning/10 px-2 py-1.5 text-[10px] leading-4 text-status-warning" data-testid="workflow-confirm-preview-missing">服务端尚未提供实际操作内容预览，已禁止直接确认。请刷新或先核对外部系统。</p>
                        )}
                        <details className="mt-2 rounded-md border border-border-muted bg-surface-base px-2 py-1.5">
                          <summary className="cursor-pointer text-[10px] text-text-muted">请求详情</summary>
                          <dl className="mt-1 space-y-1 text-[10px]">
                            <div className="flex gap-2"><dt className="w-14 shrink-0 text-text-faint">请求 ID</dt><dd className="min-w-0 break-all text-text-faint">{confirmation.requestId}</dd></div>
                            {confirmation.context.intent_digest ? <div className="flex gap-2"><dt className="w-14 shrink-0 text-text-faint">摘要</dt><dd className="min-w-0 break-all text-text-faint">{valuePreview(confirmation.context.intent_digest, 180)}</dd></div> : null}
                          </dl>
                        </details>
                        <div className="mt-2 flex gap-2">
                          <button type="button" className="inline-flex items-center gap-1 rounded-md bg-btnPrimary px-2.5 py-1.5 text-[11px] text-btnPrimary-text hover:bg-btnPrimary-hover disabled:opacity-50" disabled={Boolean(busyAction) || !hasInputPreview} title={hasInputPreview ? "确认执行已展示的操作内容" : "缺少服务端操作内容预览，无法确认"} onClick={() => handleExternalConfirmation(confirmation, true)}>{busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}确认执行</button>
                          <button type="button" className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-[11px] text-text-muted hover:bg-surface-hover disabled:opacity-50" disabled={Boolean(busyAction)} onClick={() => handleExternalConfirmation(confirmation, false)}><X className="h-3 w-3" />拒绝</button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </section>
        ) : null}

        {nodes.some((node) => workflowNodeErrorCode(node) === "agent_model_unavailable") ? <div className="agx-workflow-alert agx-workflow-alert--warning mt-3 rounded-lg px-3 py-2.5 text-[11px]" role="status" data-testid="workflow-model-guidance"><div className="flex items-start gap-2"><Settings2 className="mt-0.5 h-3.5 w-3.5 shrink-0" /><div><p className="font-medium">需要配置模型才能继续</p><p className="mt-0.5 leading-4">请使用已有的模型设置选择一个可用 Provider 和模型。返回这里后，点击“重试节点”即可恢复原运行。</p><button type="button" className="mt-2 inline-flex items-center gap-1 rounded-md border border-border px-2 py-1.5 text-[11px] text-text-muted hover:bg-surface-hover" onClick={openProviderSettings}><Settings2 className="h-3 w-3" />打开模型设置</button></div></div></div> : null}

        {notice ? <div className="agx-workflow-alert agx-workflow-alert--success mt-3 rounded-lg px-3 py-2 text-[11px]" role="status">{notice}</div> : null}
        {error ? <div className="agx-workflow-alert agx-workflow-alert--error mt-3 rounded-lg px-3 py-2 text-[11px]" role="alert">{error}</div> : null}

        <section className="mt-4"><div className="mb-2 flex items-center justify-between"><h3 className="text-xs font-semibold text-text-strong">只读运行轨迹</h3><span className="text-[10px] text-text-faint">受管执行事实</span></div><div className="space-y-1.5">{nodes.map((node) => { const status = String(node.status || "").toLowerCase(); const reason = nodeReason(node); const evidence = nodeEvidence(node); const uncertain = workflowNodeRequiresReconciliation(node); const hasExecutionError = status === "failed" || (status === "blocked" && (Boolean(reason.code) || uncertain)); const retryable = hasExecutionError; const outputSummary = nodeOutputSummary(node); const retryBusy = busyAction === `retry-node:${node.id}`; return <article key={node.id} className="rounded-md border border-border bg-surface-card px-2.5 py-2" data-testid={`workflow-runtime-node-${node.id}`}><div className="flex items-center gap-2"><span className={`h-1.5 w-1.5 shrink-0 rounded-full ${status === "done" ? "bg-status-success" : status === "failed" ? "bg-status-error" : status === "blocked" ? "bg-status-warning" : status === "running" ? "bg-[var(--ui-accent-text)]" : "bg-text-faint"}`} /><span className="min-w-0 flex-1 truncate text-[11px] text-text-muted">{nodeLabel(node)}</span><span className={`text-[10px] ${statusTone(status)}`}>{nodeStatusLabel(node, status)}</span></div>{status === "blocked" && !hasExecutionError ? <p className="mt-2 rounded-md border border-border-muted bg-surface-base px-2 py-1.5 text-[11px] text-text-muted" data-testid={`workflow-node-waiting-${node.id}`}>等待前置节点或审批完成。</p> : null}{hasExecutionError ? <div className="mt-2 rounded-md border border-status-warning/50 bg-status-warning/10 px-2 py-1.5" data-testid={`workflow-node-feedback-${node.id}`}><p className="text-[11px] text-text-primary">原因：{reason.text}</p>{reason.code ? <p className="mt-0.5 text-[10px] text-text-faint">诊断码：{reason.code}</p> : null}{uncertain ? <label className="mt-2 flex items-start gap-1.5 text-[10px] text-text-muted"><input type="checkbox" checked={reconcileNodeId === node.id} onChange={(event) => setReconcileNodeId(event.target.checked ? node.id : null)} /><span>我已核对外部系统，确认可以再次执行，避免重复修改</span></label> : null}{retryable ? <button type="button" className="mt-2 inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[10px] text-text-muted hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-50" data-testid={`workflow-retry-node-${node.id}`} disabled={Boolean(busyAction) || (uncertain && reconcileNodeId !== node.id)} onClick={() => handleRetryNode(node)}>{retryBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}{uncertain ? "已核对，重试节点" : "重试节点"}</button> : null}</div> : null}{outputSummary ? <p className="mt-2 whitespace-pre-wrap break-words text-[10px] leading-4 text-text-faint" data-testid={`workflow-node-output-${node.id}`}>{outputSummary}</p> : null}{evidence.length > 0 ? <details className="mt-2 rounded-md border border-border-muted bg-surface-base px-2 py-1.5"><summary className="cursor-pointer text-[10px] text-text-muted">证据（{evidence.length} 条）</summary><div className="mt-1 space-y-1">{evidence.map((item, index) => <pre key={`${node.id}-evidence-${index}`} className="m-0 whitespace-pre-wrap break-words text-[10px] leading-4 text-text-faint">{valuePreview(item)}</pre>)}</div></details> : null}</article>; })}{nodes.length === 0 ? <p className="rounded-lg border border-border p-3 text-[11px] text-text-faint">运行暂未返回节点。</p> : null}</div><div className="mt-2 flex items-center gap-1 text-[10px] text-text-faint"><ExternalLink className="h-3 w-3" aria-hidden />轨迹来自服务端的不可变运行快照，编辑器节点不会被当作运行状态解释。</div></section>

        {artifacts.length > 0 ? <section className="mt-4" data-testid="workflow-artifacts"><div className="mb-2 flex items-center justify-between"><h3 className="text-xs font-semibold text-text-strong">结果文件</h3><span className="text-[10px] text-text-faint">已由受管执行器记录</span></div><div className="space-y-1.5">{artifacts.map((artifact) => <div key={artifact.path} className="flex items-center gap-2 rounded-md border border-border bg-surface-card px-2.5 py-2"><FileText className="h-3.5 w-3.5 shrink-0 text-text-faint" aria-hidden /><div className="min-w-0 flex-1"><p className="truncate text-[11px] text-text-strong" title={artifact.path}>{artifact.label}</p><p className="truncate text-[10px] text-text-faint" title={artifact.path}>{artifact.kind} · {artifact.path}</p></div><button type="button" className="shrink-0 rounded-md border border-border px-2 py-1 text-[10px] text-text-muted hover:bg-surface-hover" onClick={() => void openArtifact(artifact.path)} data-testid="workflow-open-artifact">打开</button></div>)}</div></section> : null}
      </div>}
    </section>
  );
}
