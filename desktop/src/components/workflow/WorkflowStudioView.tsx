import { useCallback, useEffect, useMemo, useRef, useState, type ButtonHTMLAttributes } from "react";
import { AlertTriangle, Check, Clipboard, FilePlus2, Loader2, PanelLeft, PanelRight, Play, RefreshCw, Save, Send, Sparkles, X } from "lucide-react";
import { useAppStore } from "../../store";
import { normalizeRunMode } from "../../constants/confirm-strategy-options";
import { sessionCreateAvatarId } from "../../utils/session-create-avatar";
import type { ConnectorCatalogEntry, WorkflowDocument, WorkflowDraft, WorkflowManifest, WorkflowNode, WorkflowNodeKind, WorkflowRun, WorkflowRunRefreshContext, WorkflowRunResponse } from "./workflow-types";
import {
  createWorkflow,
  createWorkflowRun,
  fetchWorkflow,
  fetchWorkflowApprovals,
  fetchWorkflowConnectors,
  fetchWorkflowRun,
  fetchWorkflows,
  publishWorkflow,
  saveWorkflow,
  WorkflowApiError,
  type WorkflowApiOptions,
} from "./workflow-api";
import { WorkflowCanvas } from "./WorkflowCanvas";
import { WorkflowInspector } from "./WorkflowInspector";
import { WorkflowPalette } from "./WorkflowPalette";
import { WorkflowRunPanel } from "./WorkflowRunPanel";
import { WorkflowBootstrapGuard, WorkflowRequestCoordinator, type WorkflowRunRequest } from "./workflow-async";
import {
  addWorkflowNode,
  createEmptyWorkflowDocument,
  normalizeManifest,
  normalizeWorkflowDocument,
  updateWorkflowNode,
  workflowDirtyKey,
  workflowDraftPayload,
} from "./workflow-utils";
import { shouldUseWorkflowDrawers } from "./workflow-layout";
import { FICTIONAL_USAGE_TEMPLATE_ID, WORKFLOW_TEMPLATE_CATALOG, createWorkflowTemplateDocument, type WorkflowTemplateInputs } from "./workflow-templates";
import "./workflow.css";

type LoadState = "idle" | "loading" | "ready" | "error";

type ConflictState = {
  workflowId: string;
  serverRevision?: number;
  message: string;
};

type WorkflowSessionBootstrapContext = {
  paneId: string;
  paneGeneration: number;
  workflowId: string;
  apiBase: string;
  apiToken: string;
  authGeneration: number;
  mountedGeneration: number;
  runContextToken: number;
};

function apiErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof WorkflowApiError) {
    if (error.issues.length > 0) return error.issues.map((issue) => `${issue.path ? `${issue.path}：` : ""}${issue.message}`).join("；");
    return error.message;
  }
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

function mergeManifest(manifests: WorkflowManifest[], next: WorkflowManifest): WorkflowManifest[] {
  const normalized = normalizeManifest(next);
  const exists = manifests.some((item) => item.workflow_id === normalized.workflow_id);
  return exists
    ? manifests.map((item) => item.workflow_id === normalized.workflow_id ? normalized : item)
    : [normalized, ...manifests];
}

type ButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className" | "type"> & {
  variant?: "primary" | "ghost" | "danger";
  className?: string;
  type?: ButtonHTMLAttributes<HTMLButtonElement>["type"];
};

function Button({ children, variant = "ghost", className = "", type = "button", ...buttonProps }: ButtonProps) {
  const tone = variant === "primary"
    ? "bg-btnPrimary text-btnPrimary-text hover:bg-btnPrimary-hover"
    : variant === "danger"
      ? "agx-workflow-button--danger border border-status-error text-status-error"
      : "border border-border text-text-muted hover:bg-surface-hover";
  return <button {...buttonProps} type={type} className={`inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1.5 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-45 ${tone} ${className}`}>{children}</button>;
}

type WorkflowTemplateChooserProps = {
  open: boolean;
  onClose: () => void;
  onCreate: (inputs: WorkflowTemplateInputs) => void;
};

function WorkflowTemplateChooser({ open, onClose, onCreate }: WorkflowTemplateChooserProps) {
  const [title, setTitle] = useState("部门用量分析与报告交付");
  const [datasetLabel, setDatasetLabel] = useState("2026 Q3 虚构部门用量示例");
  const [artifactBaseName, setArtifactBaseName] = useState("department-usage-report");
  const template = WORKFLOW_TEMPLATE_CATALOG.find((item) => item.id === FICTIONAL_USAGE_TEMPLATE_ID);

  useEffect(() => {
    if (!open) return;
    setTitle("部门用量分析与报告交付");
    setDatasetLabel("2026 Q3 虚构部门用量示例");
    setArtifactBaseName("department-usage-report");
  }, [open]);

  if (!open || !template) return null;
  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-[var(--workflow-overlay)] p-4" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="agx-workflow-template-dialog flex max-h-full w-[min(540px,100%)] flex-col overflow-hidden rounded-2xl border border-border bg-surface-popover shadow-2xl" role="dialog" aria-modal="true" aria-labelledby="workflow-template-title">
        <header className="flex shrink-0 items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div className="flex min-w-0 items-start gap-3"><span className="rounded-xl bg-[var(--ui-accent-surface)] p-2 text-[var(--ui-accent-text)]"><Sparkles className="h-5 w-5" aria-hidden /></span><div className="min-w-0"><h2 id="workflow-template-title" className="text-sm font-semibold text-text-strong">从模板创建</h2><p className="mt-1 text-[11px] leading-4 text-text-faint">选择一份业务蓝图，创建后仍可编辑、保存、发布和运行。</p></div></div>
          <button type="button" className="shrink-0 rounded-md p-1.5 text-text-muted hover:bg-surface-hover hover:text-text-strong" aria-label="关闭模板选择" title="关闭模板选择" onClick={onClose}><X className="h-4 w-4" /></button>
        </header>
        <form className="min-h-0 overflow-y-auto px-5 py-4" onSubmit={(event) => { event.preventDefault(); onCreate({ title, datasetLabel, artifactBaseName }); }}>
          <div className="rounded-xl border border-[var(--ui-btn-primary-bg)] bg-[var(--ui-accent-surface)] p-3.5"><div className="flex items-start gap-2"><div className="min-w-0"><h3 className="text-sm font-semibold text-text-strong">{template.title}</h3><p className="mt-1 text-[11px] leading-5 text-text-muted">{template.description}</p></div><span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-[10px] text-text-muted">可编辑模板</span></div><div className="mt-3 flex flex-wrap items-center gap-1.5 text-[10px] text-text-subtle">{template.steps.map((step, index) => <span key={step} className="inline-flex items-center gap-1"><span className="rounded-full bg-surface-card-strong px-2 py-1 text-text-muted">{step}</span>{index < template.steps.length - 1 ? <span aria-hidden>→</span> : null}</span>)}</div></div>
          <div className="mt-4 space-y-3">
            <label className="block text-[11px] font-medium text-text-muted">工作流名称<input className="mt-1 w-full rounded-md border border-border bg-surface-base px-2.5 py-2 text-[12px] text-text-strong outline-none transition placeholder:text-text-faint focus:border-[var(--ui-btn-primary-bg)]" value={title} maxLength={120} onChange={(event) => setTitle(event.target.value)} /></label>
            <label className="block text-[11px] font-medium text-text-muted">虚构数据集名称<input className="mt-1 w-full rounded-md border border-border bg-surface-base px-2.5 py-2 text-[12px] text-text-strong outline-none transition placeholder:text-text-faint focus:border-[var(--ui-btn-primary-bg)]" value={datasetLabel} maxLength={120} onChange={(event) => setDatasetLabel(event.target.value)} /><span className="mt-1 block text-[10px] leading-4 text-text-faint">示例数据仅用于演示，不计入企业用量。</span></label>
            <label className="block text-[11px] font-medium text-text-muted">报告文件名<input className="mt-1 w-full rounded-md border border-border bg-surface-base px-2.5 py-2 text-[12px] text-text-strong outline-none transition placeholder:text-text-faint focus:border-[var(--ui-btn-primary-bg)]" value={artifactBaseName} maxLength={80} pattern="[A-Za-z0-9._-]+" onChange={(event) => setArtifactBaseName(event.target.value)} /><span className="mt-1 block text-[10px] leading-4 text-text-faint">将生成同名的 .md 与 .html 报告文件，不能包含路径。</span></label>
          </div>
          <div className="agx-workflow-alert agx-workflow-alert--warning mt-4 rounded-lg px-3 py-2.5 text-[11px] leading-4"><p className="font-medium">模板创建为草稿</p><p className="mt-0.5">不会自动发布、运行或创建用户。创建后请检查节点设置，再自行保存、发布并点击“创建运行”。</p></div>
          <footer className="mt-5 flex justify-end gap-2"><Button onClick={onClose}>取消</Button><Button type="submit" variant="primary"><Sparkles className="h-3.5 w-3.5" />创建模板草稿</Button></footer>
        </form>
      </section>
    </div>
  );
}

type WorkflowListPanelProps = {
  manifests: WorkflowManifest[];
  listState: LoadState;
  listError: string;
  selectedWorkflowId: string | null;
  document: WorkflowDocument | null;
  creating: boolean;
  apiBase: string;
  apiToken: string;
  onCreate: () => void;
  onCreateFromTemplate: () => void;
  onRetry: () => void;
  onSelect: (workflowId: string) => void;
  onAddNode: (kind: WorkflowNodeKind) => void;
  catalogError: string;
  onRetryCatalog: () => void;
  onClose?: () => void;
};

function WorkflowListPanel({
  manifests,
  listState,
  listError,
  selectedWorkflowId,
  document,
  creating,
  apiBase,
  apiToken,
  onCreate,
  onCreateFromTemplate,
  onRetry,
  onSelect,
  onAddNode,
  catalogError,
  onRetryCatalog,
  onClose,
}: WorkflowListPanelProps) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2.5">
        <div>
          <p className="text-xs font-semibold text-text-strong">工作流</p>
          <p className="mt-0.5 text-[10px] text-text-faint">{manifests.length} 个定义</p>
        </div>
        <div className="flex items-center gap-1">
          <Button onClick={onCreateFromTemplate} disabled={creating || !apiBase || !apiToken} aria-label="从模板创建工作流"><Sparkles className="h-3.5 w-3.5" />从模板创建</Button>
          <Button onClick={onCreate} disabled={creating || !apiBase || !apiToken} aria-label="新建工作流"><FilePlus2 className="h-3.5 w-3.5" />新建</Button>
          {onClose ? <button type="button" className="rounded-md p-1.5 text-text-muted hover:bg-surface-hover hover:text-text-strong" aria-label="关闭工作流列表" title="关闭工作流列表" onClick={onClose}><X className="h-4 w-4" /></button> : null}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {listState === "loading" ? <div className="flex items-center gap-2 p-2 text-xs text-text-faint"><Loader2 className="h-3.5 w-3.5 animate-spin" />正在加载工作流…</div> : null}
        {listState === "error" ? <div className="agx-workflow-alert agx-workflow-alert--error rounded-lg p-3 text-[11px]" role="alert"><p>{listError}</p><button type="button" className="mt-2 inline-flex items-center gap-1 underline underline-offset-2" onClick={onRetry}><RefreshCw className="h-3 w-3" />重试</button></div> : null}
        {listState === "ready" && manifests.length === 0 ? <div className="rounded-lg border border-dashed border-border p-3 text-center text-[11px] text-text-faint"><p>还没有工作流</p><div className="mt-2 flex flex-wrap justify-center gap-2"><button type="button" className="inline-flex items-center gap-1 rounded-md bg-btnPrimary px-2.5 py-1.5 text-btnPrimary-text" onClick={onCreateFromTemplate} disabled={creating}><Sparkles className="h-3.5 w-3.5" />从模板创建</button><button type="button" className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-text-muted hover:bg-surface-hover" onClick={onCreate} disabled={creating}><FilePlus2 className="h-3.5 w-3.5" />空白创建</button></div></div> : null}
        <div className="space-y-1.5">{manifests.map((manifest) => <button key={manifest.workflow_id} type="button" onClick={() => onSelect(manifest.workflow_id)} className={`w-full rounded-lg border px-3 py-2 text-left transition ${selectedWorkflowId === manifest.workflow_id ? "border-[var(--ui-btn-primary-bg)] bg-[var(--ui-accent-surface)]" : "border-border bg-surface-card hover:bg-surface-hover"}`} aria-current={selectedWorkflowId === manifest.workflow_id ? "page" : undefined}><p className="truncate text-xs font-medium text-text-strong">{manifest.title}</p><div className="mt-1 flex items-center justify-between text-[10px] text-text-faint"><span>v{manifest.head_revision}</span><span>{manifest.active_published_revision != null ? `已发布 v${manifest.active_published_revision}` : "草稿"}</span></div></button>)}</div>
        {document ? <div className="mt-5 border-t border-border pt-4"><WorkflowPalette onAdd={onAddNode} catalogError={catalogError} onRetryCatalog={onRetryCatalog} /></div> : null}
      </div>
    </div>
  );
}

export function WorkflowStudioView() {
  const apiBase = useAppStore((state) => state.apiBase);
  const apiToken = useAppStore((state) => state.apiToken);
  const activePaneId = useAppStore((state) => state.activePaneId);
  const panes = useAppStore((state) => state.panes);
  const setPaneSessionId = useAppStore((state) => state.setPaneSessionId);
  const setPaneSessionMode = useAppStore((state) => state.setPaneSessionMode);
  const setSessionRunMode = useAppStore((state) => state.setSessionRunMode);
  const setSessionId = useAppStore((state) => state.setSessionId);
  const activePane = useMemo(() => panes.find((pane) => pane.id === activePaneId) || null, [activePaneId, panes]);
  // Workflow runs are scoped to the pane that was captured by the click. Do
  // not fall back to the legacy global session id: it may belong to another
  // pane while the active pane is still a cold lazy topic.
  const activePaneSessionId = String(activePane?.sessionId || "").trim();
  const options = useMemo<WorkflowApiOptions>(() => ({ apiBase, apiToken }), [apiBase, apiToken]);
  const activePaneIdRef = useRef(activePaneId);
  const paneIdentityRef = useRef({ paneId: activePaneId, generation: 0 });
  if (paneIdentityRef.current.paneId !== activePaneId) {
    paneIdentityRef.current = {
      paneId: activePaneId,
      generation: paneIdentityRef.current.generation + 1,
    };
  }
  activePaneIdRef.current = activePaneId;
  const apiBaseRef = useRef(apiBase);
  apiBaseRef.current = apiBase;
  const apiTokenRef = useRef(apiToken);
  apiTokenRef.current = apiToken;
  const authIdentityRef = useRef({ apiBase, apiToken, generation: 0 });
  if (authIdentityRef.current.apiBase !== apiBase || authIdentityRef.current.apiToken !== apiToken) {
    authIdentityRef.current = {
      apiBase,
      apiToken,
      generation: authIdentityRef.current.generation + 1,
    };
  }
  const activePaneSessionIdRef = useRef(activePaneSessionId);
  activePaneSessionIdRef.current = activePaneSessionId;

  const [manifests, setManifests] = useState<WorkflowManifest[]>([]);
  const [listState, setListState] = useState<LoadState>("idle");
  const [listError, setListError] = useState("");
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(null);
  const selectedWorkflowIdRef = useRef(selectedWorkflowId);
  selectedWorkflowIdRef.current = selectedWorkflowId;
  const [document, setDocument] = useState<WorkflowDocument | null>(null);
  const [baselineKey, setBaselineKey] = useState("");
  const [documentState, setDocumentState] = useState<LoadState>("idle");
  const [documentError, setDocumentError] = useState("");
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [connectors, setConnectors] = useState<ConnectorCatalogEntry[]>([]);
  const [catalogState, setCatalogState] = useState<LoadState>("idle");
  const [catalogError, setCatalogError] = useState("");
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [creatingRun, setCreatingRun] = useState(false);
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");
  const [conflict, setConflict] = useState<ConflictState | null>(null);
  const [run, setRun] = useState<WorkflowRun | null>(null);
  const [runApprovals, setRunApprovals] = useState<NonNullable<WorkflowRun["approvals"]>>([]);
  const [showRunPanel, setShowRunPanel] = useState(false);
  const [containerWidth, setContainerWidth] = useState(0);
  const [openDrawer, setOpenDrawer] = useState<"palette" | "inspector" | null>(null);
  const [templateChooserOpen, setTemplateChooserOpen] = useState(false);
  const studioContentRef = useRef<HTMLDivElement>(null);
  const runRef = useRef<WorkflowRun | null>(run);
  runRef.current = run;
  const runSessionBootstrapRef = useRef<{
    key: string;
    promise: Promise<string | null>;
  } | null>(null);
  const bootstrapGuardRef = useRef<WorkflowBootstrapGuard | null>(null);
  if (!bootstrapGuardRef.current) bootstrapGuardRef.current = new WorkflowBootstrapGuard();

  const compactLayout = shouldUseWorkflowDrawers(containerWidth);

  const requestGeneration = useRef(0);
  const listGeneration = useRef(0);
  const catalogGeneration = useRef(0);
  const detailAbortRef = useRef<AbortController | null>(null);
  const saveAbortRef = useRef<AbortController | null>(null);
  const createAbortRef = useRef<AbortController | null>(null);
  const publishAbortRef = useRef<AbortController | null>(null);
  const listAbortRef = useRef<AbortController | null>(null);
  const catalogAbortRef = useRef<AbortController | null>(null);
  const runAbortRef = useRef<AbortController | null>(null);
  const runGeneration = useRef(0);
  const saveBusyTokenRef = useRef(0);
  const createBusyTokenRef = useRef(0);
  const publishBusyTokenRef = useRef(0);
  const runBusyTokenRef = useRef(0);
  const runRefreshTokenRef = useRef(0);
  const requestCoordinatorRef = useRef<WorkflowRequestCoordinator | null>(null);
  if (!requestCoordinatorRef.current) requestCoordinatorRef.current = new WorkflowRequestCoordinator();
  const requestCoordinator = requestCoordinatorRef.current;
  const renderedRunContextToken = requestCoordinator.currentRunContextToken();

  const dirty = Boolean(document && workflowDirtyKey(document) !== baselineKey);
  const selectedManifest = manifests.find((item) => item.workflow_id === selectedWorkflowId) || null;

  const loadWorkflows = useCallback(async () => {
    listAbortRef.current?.abort();
    const controller = new AbortController();
    listAbortRef.current = controller;
    const generation = ++listGeneration.current;
    setListState("loading");
    setListError("");
    if (!apiBase || !apiToken) {
      setListState("error");
      setListError("本地助手后端未就绪，请稍后重试。");
      return;
    }
    try {
      const rows = (await fetchWorkflows({ ...options, signal: controller.signal })).map(normalizeManifest);
      if (controller.signal.aborted || generation !== listGeneration.current) return;
      setManifests(rows);
      setListState("ready");
    } catch (error) {
      if (controller.signal.aborted || generation !== listGeneration.current) return;
      setListState("error");
      setListError(apiErrorMessage(error, "工作流列表加载失败"));
    }
  }, [apiBase, apiToken, options]);

  const loadCatalog = useCallback(async () => {
    catalogAbortRef.current?.abort();
    const controller = new AbortController();
    catalogAbortRef.current = controller;
    const generation = ++catalogGeneration.current;
    setCatalogState("loading");
    setCatalogError("");
    setConnectors([]);
    if (!apiBase || !apiToken) {
      setCatalogState("error");
      setCatalogError("本地助手后端未就绪，无法加载服务目录。");
      return;
    }
    try {
      const rows = await fetchWorkflowConnectors({ ...options, signal: controller.signal });
      if (controller.signal.aborted || generation !== catalogGeneration.current) return;
      setConnectors(rows);
      setCatalogState("ready");
    } catch (error) {
      if (controller.signal.aborted || generation !== catalogGeneration.current) return;
      setCatalogState("error");
      setCatalogError(apiErrorMessage(error, "连接器目录加载失败"));
      setConnectors([]);
    }
  }, [apiBase, apiToken, options]);

  const loadDocument = useCallback(async (workflowId: string, revision?: number, previousManifest?: WorkflowManifest) => {
    const generation = ++requestGeneration.current;
    const documentRequest = requestCoordinator.beginDocument(workflowId);
    detailAbortRef.current?.abort();
    const controller = new AbortController();
    detailAbortRef.current = controller;
    saveAbortRef.current?.abort();
    requestCoordinator.invalidateSave();
    saveBusyTokenRef.current += 1;
    setSaving(false);
    createAbortRef.current?.abort();
    publishAbortRef.current?.abort();
    createBusyTokenRef.current += 1;
    publishBusyTokenRef.current += 1;
    setCreating(false);
    setPublishing(false);
    // Clear the old definition before the new request starts. This freezes
    // the palette, canvas, and inspector so an A response can never be
    // edited or saved through B's URL while B is loading.
    setDocument(null);
    setBaselineKey("");
    setSelectedNodeId(null);
    setDocumentState("loading");
    setDocumentError("");
    setActionError("");
    setConflict(null);
    try {
      const response = await fetchWorkflow({ ...options, signal: controller.signal }, workflowId, revision, previousManifest);
      if (controller.signal.aborted || generation !== requestGeneration.current || !requestCoordinator.isDocumentCurrent(documentRequest)) return;
      const nextDocument = normalizeWorkflowDocument(response.snapshot);
      const nextManifest = normalizeManifest(response.manifest);
      if (nextDocument.workflow_id !== workflowId) {
        setDocumentState("error");
        setDocumentError("服务器返回的工作流与当前选择不一致，请重试。");
        return;
      }
      setSelectedWorkflowId(workflowId);
      setDocument(nextDocument);
      setBaselineKey(workflowDirtyKey(nextDocument));
      setManifests((current) => mergeManifest(current, nextManifest));
      setSelectedNodeId(null);
      setDocumentState("ready");
    } catch (error) {
      if (controller.signal.aborted || generation !== requestGeneration.current || !requestCoordinator.isDocumentCurrent(documentRequest)) return;
      setDocumentState("error");
      setDocumentError(apiErrorMessage(error, "工作流加载失败"));
    }
  }, [options, requestCoordinator]);

  useEffect(() => {
    const mountedGeneration = bootstrapGuardRef.current?.mount() || 0;
    void loadWorkflows();
    void loadCatalog();
    return () => {
      const bootstrapGuard = bootstrapGuardRef.current;
      if (!bootstrapGuard?.isCurrent(mountedGeneration)) return;
      bootstrapGuard.unmount(mountedGeneration);
      // createSession has no AbortSignal. Drop the single-flight reference and
      // invalidate the run context so a late result can only be observed and
      // discarded, never published into a remounted pane.
      runSessionBootstrapRef.current = null;
      requestCoordinator.beginRunContext();
      listAbortRef.current?.abort();
      catalogAbortRef.current?.abort();
      detailAbortRef.current?.abort();
      saveAbortRef.current?.abort();
      createAbortRef.current?.abort();
      publishAbortRef.current?.abort();
      runAbortRef.current?.abort();
      requestCoordinator.invalidateSave();
      requestCoordinator.invalidateRun();
    };
  }, [loadCatalog, loadWorkflows, requestCoordinator]);

  useEffect(() => {
    const element = studioContentRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? element.clientWidth;
      setContainerWidth(width);
    });
    observer.observe(element);
    setContainerWidth(element.clientWidth);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!compactLayout || !openDrawer || (openDrawer === "inspector" && !document)) setOpenDrawer(null);
  }, [compactLayout, document, openDrawer]);

  useEffect(() => {
    if (!compactLayout || !openDrawer) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenDrawer(null);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [compactLayout, openDrawer]);

  useEffect(() => {
    if (!requestCoordinator.setSession(activePaneSessionId)) return;
    runGeneration.current += 1;
    runRefreshTokenRef.current += 1;
    runAbortRef.current?.abort();
    runRef.current = null;
    setRun(null);
    setRunApprovals([]);
    setShowRunPanel(false);
  }, [activePaneSessionId, requestCoordinator]);

  useEffect(() => {
    if (selectedWorkflowId || manifests.length === 0 || documentState === "loading") return;
    const first = manifests[0];
    setSelectedWorkflowId(first.workflow_id);
    void loadDocument(first.workflow_id);
  }, [documentState, loadDocument, manifests, selectedWorkflowId]);

  const updateDocument = useCallback((next: WorkflowDocument) => {
    if (!selectedWorkflowId || next.workflow_id !== selectedWorkflowId) return;
    requestCoordinator.markDraftEdited();
    setDocument(next);
    setActionError("");
    setNotice("");
  }, [requestCoordinator, selectedWorkflowId]);

  const updateNode = useCallback((nodeId: string, patch: Partial<WorkflowNode>) => {
    setDocument((current) => {
      if (!current || current.workflow_id !== selectedWorkflowId) return current;
      requestCoordinator.markDraftEdited();
      return updateWorkflowNode(current, nodeId, patch);
    });
    setActionError("");
    setNotice("");
  }, [requestCoordinator, selectedWorkflowId]);

  const handleAddNode = useCallback((kind: WorkflowNodeKind) => {
    setDocument((current) => {
      if (!current) return current;
      const next = addWorkflowNode(current, kind);
      requestCoordinator.markDraftEdited();
      setSelectedNodeId(next.nodes[next.nodes.length - 1]?.id || null);
      return next;
    });
    setNotice(`${kind === "connector_action" ? "连接器动作" : "节点"}已添加，请在右侧填写属性。`);
  }, [requestCoordinator]);

  const handleSelectWorkflow = useCallback((workflowId: string) => {
    if (workflowId === selectedWorkflowId && documentState !== "error") return;
    if (dirty) {
      setActionError("当前工作流有未保存修改，请先保存或复制本地 JSON，再切换工作流。");
      return;
    }
    // A selection change owns the visible list/detail context. Invalidate a
    // list request that started for the previous context before loading detail.
    listGeneration.current += 1;
    runGeneration.current += 1;
    requestCoordinator.beginRunContext();
    runRefreshTokenRef.current += 1;
    requestCoordinator.selectWorkflow(workflowId);
    requestCoordinator.invalidateRun();
    requestCoordinator.invalidateSave();
    saveAbortRef.current?.abort();
    runAbortRef.current?.abort();
    createAbortRef.current?.abort();
    publishAbortRef.current?.abort();
    saveBusyTokenRef.current += 1;
    createBusyTokenRef.current += 1;
    publishBusyTokenRef.current += 1;
    runBusyTokenRef.current += 1;
    runRef.current = null;
    setSaving(false);
    setCreating(false);
    setPublishing(false);
    setCreatingRun(false);
    setRun(null);
    setRunApprovals([]);
    setShowRunPanel(false);
    setDocument(null);
    setBaselineKey("");
    setSelectedNodeId(null);
    setSelectedWorkflowId(workflowId);
    void loadDocument(workflowId, undefined, manifests.find((item) => item.workflow_id === workflowId));
  }, [dirty, documentState, loadDocument, manifests, requestCoordinator, selectedWorkflowId]);

  const handleCreate = useCallback(async (requestedDraft?: WorkflowDraft, creationNotice = "工作流已创建，可以开始编辑。保存会追加新版本。") => {
    if (creating || !apiBase || !apiToken) return;
    if (dirty) {
      setActionError("当前工作流有未保存修改，请先保存或复制本地 JSON，再新建工作流。");
      return;
    }
    listGeneration.current += 1;
    const generation = ++requestGeneration.current;
    const createRequest = requestCoordinator.beginCreate();
    runRefreshTokenRef.current += 1;
    createAbortRef.current?.abort();
    const controller = new AbortController();
    createAbortRef.current = controller;
    const busyToken = ++createBusyTokenRef.current;
    // A create request has no workflow id to bind to yet. Clear the previous
    // editor and invalidate all old runtime mutations before awaiting it so a
    // late response cannot replace a draft the user starts editing meanwhile.
    detailAbortRef.current?.abort();
    saveAbortRef.current?.abort();
    publishAbortRef.current?.abort();
    runAbortRef.current?.abort();
    saveBusyTokenRef.current += 1;
    publishBusyTokenRef.current += 1;
    runBusyTokenRef.current += 1;
    requestCoordinator.invalidateSave();
    requestCoordinator.invalidateRun();
    setSaving(false);
    setPublishing(false);
    setCreatingRun(false);
    runRef.current = null;
    setRun(null);
    setRunApprovals([]);
    setShowRunPanel(false);
    setDocument(null);
    setBaselineKey("");
    setSelectedNodeId(null);
    setDocumentState("loading");
    setDocumentError("");
    setConflict(null);
    setCreating(true);
    setActionError("");
    setNotice("");
    const draft = requestedDraft || createEmptyWorkflowDocument();
    try {
      const response = await createWorkflow({ ...options, signal: controller.signal }, draft);
      if (
        controller.signal.aborted
        || generation !== requestGeneration.current
        || !requestCoordinator.shouldApplyCreate(createRequest)
      ) return;
      const nextDocument = normalizeWorkflowDocument(response.snapshot);
      const nextManifest = normalizeManifest(response.manifest);
      if (!nextDocument.workflow_id) throw new Error("后端未返回新工作流 ID");
      requestCoordinator.selectWorkflow(nextDocument.workflow_id);
      setManifests((current) => mergeManifest(current, nextManifest));
      setSelectedWorkflowId(nextDocument.workflow_id);
      setDocument(nextDocument);
      setBaselineKey(workflowDirtyKey(nextDocument));
      setSelectedNodeId(null);
      setDocumentState("ready");
      setConflict(null);
      setNotice(creationNotice);
    } catch (error) {
      if (!controller.signal.aborted && generation === requestGeneration.current && requestCoordinator.isCreateCurrent(createRequest)) {
        setDocumentState("error");
        setActionError(apiErrorMessage(error, "创建工作流失败"));
      }
    } finally {
      if (createBusyTokenRef.current === busyToken) setCreating(false);
      if (createAbortRef.current === controller) createAbortRef.current = null;
    }
  }, [apiBase, apiToken, creating, dirty, options, requestCoordinator]);

  const handleCreateFromTemplate = useCallback((inputs: WorkflowTemplateInputs) => {
    if (dirty) {
      setActionError("当前工作流有未保存修改，请先保存或复制本地 JSON，再从模板创建。");
      return;
    }
    setTemplateChooserOpen(false);
    const draft = createWorkflowTemplateDocument(inputs);
    void handleCreate(
      draft,
      "已从模板创建独立草稿。它仍未发布或运行，请检查输入与报告文件设置后继续。",
    );
  }, [dirty, handleCreate]);

  const handleSave = useCallback(async () => {
    if (!document || !selectedManifest || !selectedWorkflowId || saving) return;
    if (document.workflow_id !== selectedWorkflowId) {
      setActionError("当前文档与选择的工作流不一致，请重新加载后再保存。");
      return;
    }
    const workflowId = selectedWorkflowId;
    const generation = requestGeneration.current;
    const draftKey = workflowDirtyKey(document);
    const saveRequest = requestCoordinator.beginSave(workflowId, draftKey);
    saveAbortRef.current?.abort();
    const controller = new AbortController();
    saveAbortRef.current = controller;
    const busyToken = ++saveBusyTokenRef.current;
    setSaving(true);
    setActionError("");
    setNotice("");
    try {
      const response = await saveWorkflow(
        { ...options, signal: controller.signal },
        workflowId,
        document,
        selectedManifest.head_revision,
        selectedManifest,
      );
      if (
        controller.signal.aborted
        || generation !== requestGeneration.current
        || !requestCoordinator.isSaveCurrent(saveRequest)
        || selectedWorkflowIdRef.current !== workflowId
      ) return;
      const nextDocument = normalizeWorkflowDocument(response.snapshot);
      const nextManifest = normalizeManifest(response.manifest);
      if (nextDocument.workflow_id !== workflowId) {
        setActionError("服务器返回的工作流与保存目标不一致，请重新加载后再试。");
        return;
      }
      setManifests((current) => mergeManifest(current, nextManifest));
      setConflict(null);
      if (requestCoordinator.shouldApplySave(saveRequest)) {
        setDocument(nextDocument);
        setBaselineKey(workflowDirtyKey(nextDocument));
        setNotice(`已保存版本 v${nextDocument.revision}。`);
      } else {
        // The server accepted the captured draft while the user kept editing.
        // Keep the newer local document and advance only its server baseline.
        setBaselineKey(workflowDirtyKey(nextDocument));
        setNotice(`已保存版本 v${nextDocument.revision}；期间的新修改仍保留。`);
      }
    } catch (error) {
      if (
        controller.signal.aborted
        || generation !== requestGeneration.current
        || !requestCoordinator.isSaveCurrent(saveRequest)
        || selectedWorkflowIdRef.current !== workflowId
      ) return;
      if (error instanceof WorkflowApiError && error.status === 409) {
        setConflict({ workflowId, serverRevision: selectedManifest.head_revision, message: error.message || "服务器版本已变化" });
      } else {
        setActionError(apiErrorMessage(error, "保存工作流失败"));
      }
    } finally {
      if (saveBusyTokenRef.current === busyToken) setSaving(false);
      if (saveAbortRef.current === controller) saveAbortRef.current = null;
    }
  }, [document, options, requestCoordinator, saving, selectedManifest, selectedWorkflowId]);

  const handlePublish = useCallback(async () => {
    if (!document || !selectedManifest || !selectedWorkflowId || publishing) return;
    if (dirty) {
      setActionError("请先保存当前修改，再发布工作流。");
      return;
    }
    if (document.revision !== selectedManifest.head_revision) {
      setActionError("当前文档不是服务器 head，请重新加载后再发布。");
      return;
    }
    const workflowId = selectedWorkflowId;
    const generation = requestGeneration.current;
    publishAbortRef.current?.abort();
    const controller = new AbortController();
    publishAbortRef.current = controller;
    const busyToken = ++publishBusyTokenRef.current;
    setPublishing(true);
    setActionError("");
    setNotice("");
    try {
      const response = await publishWorkflow({ ...options, signal: controller.signal }, workflowId, document.revision, selectedManifest.head_revision, selectedManifest);
      if (controller.signal.aborted || generation !== requestGeneration.current) return;
      const nextManifest = normalizeManifest(response.manifest);
      setManifests((current) => mergeManifest(current, nextManifest));
      setNotice(`已发布版本 v${document.revision}，现在可以创建运行。`);
    } catch (error) {
      if (!controller.signal.aborted && generation === requestGeneration.current) setActionError(apiErrorMessage(error, "发布工作流失败"));
    } finally {
      if (publishBusyTokenRef.current === busyToken) setPublishing(false);
      if (publishAbortRef.current === controller) publishAbortRef.current = null;
    }
  }, [dirty, document, options, publishing, selectedManifest, selectedWorkflowId]);

  const handleCopyLocalJson = useCallback(async () => {
    if (!document) return;
    const value = JSON.stringify(workflowDraftPayload(document), null, 2);
    try {
      if (!navigator.clipboard) throw new Error("clipboard_unavailable");
      await navigator.clipboard.writeText(value);
      setNotice("本地草稿 JSON 已复制。可以保存到安全位置后再处理版本冲突。");
    } catch {
      setActionError("无法访问剪贴板，请使用开发者工具复制当前草稿。\n" + value.slice(0, 160));
    }
  }, [document]);

  const handleReloadServer = useCallback(() => {
    if (!selectedWorkflowId) return;
    void loadDocument(selectedWorkflowId, undefined, selectedManifest || undefined);
  }, [loadDocument, selectedManifest, selectedWorkflowId]);

  const applyRunResponse = useCallback(async (
    response: WorkflowRunResponse,
    runId: string,
    context: {
      workflowId: string;
      sessionId: string;
      request?: WorkflowRunRequest;
      generation: number;
      runContextToken: number;
      refreshToken?: number;
      expectedCurrentRunId: string | null;
      signal?: AbortSignal;
    },
  ): Promise<boolean> => {
    const responseRun = response.run;
    if (
      !responseRun
      || String(responseRun.run_id || "") !== runId
      || String(responseRun.workflow_id || "") !== context.workflowId
      || String(responseRun.session_id || "") !== context.sessionId
    ) return false;
    const isContextCurrent = () => !context.signal?.aborted
        && requestCoordinator.isRunContextCurrent(context.runContextToken)
        && (context.refreshToken == null || context.refreshToken === runRefreshTokenRef.current)
        && selectedWorkflowIdRef.current === context.workflowId
        && activePaneSessionIdRef.current === context.sessionId
        && (context.request
          ? requestCoordinator.isRunCurrent(context.request)
          : context.generation === runGeneration.current);
    if (!isContextCurrent() || String(runRef.current?.run_id || "") !== (context.expectedCurrentRunId || "")) return false;
    const hasAuthoritativeApprovals = Object.prototype.hasOwnProperty.call(response, "approvals")
      || Object.prototype.hasOwnProperty.call(responseRun, "approvals");
    const approvals = hasAuthoritativeApprovals
      ? (Array.isArray(response.approvals) ? response.approvals : Array.isArray(responseRun.approvals) ? responseRun.approvals : [])
      : [];
    const readyNodeIds = response.ready_node_ids || responseRun.ready_node_ids || [];
    const nextRun: WorkflowRun = { ...responseRun, ready_node_ids: readyNodeIds, approvals };
    // Update the identity synchronously before React commits state so the
    // post-apply check recognizes an accepted replacement as current.
    runRef.current = nextRun;
    setRun(nextRun);
    setRunApprovals(approvals);
    if (context.sessionId && !hasAuthoritativeApprovals) {
      try {
        const fetchedApprovals = await fetchWorkflowApprovals(
          { ...options, ...(context.signal ? { signal: context.signal } : {}) },
          runId,
          context.sessionId,
        );
        // Older routes may omit approvals. A current route's explicit [] is
        // authoritative and never triggers this fallback request.
        if (fetchedApprovals.length > 0 && isContextCurrent() && String(runRef.current?.run_id || "") === runId) setRunApprovals(fetchedApprovals);
      } catch {
        // The run envelope already carries approvals when the route supports it.
      }
    }
    return isContextCurrent() && String(runRef.current?.run_id || "") === runId;
  }, [activePaneSessionId, options, requestCoordinator, selectedWorkflowId]);

  const ensureRunSession = useCallback(async (context: WorkflowSessionBootstrapContext): Promise<string | null> => {
    const contextIdentityIsCurrent = () => paneIdentityRef.current.paneId === context.paneId
      && paneIdentityRef.current.generation === context.paneGeneration
      && authIdentityRef.current.apiBase === context.apiBase
      && authIdentityRef.current.apiToken === context.apiToken
      && authIdentityRef.current.generation === context.authGeneration
      && Boolean(bootstrapGuardRef.current?.isCurrent(context.mountedGeneration))
      && activePaneIdRef.current === context.paneId
      && apiBaseRef.current === context.apiBase
      && apiTokenRef.current === context.apiToken
      && selectedWorkflowIdRef.current === context.workflowId
      && requestCoordinator.isRunContextCurrent(context.runContextToken);
    const currentState = useAppStore.getState();
    const currentPane = currentState.panes.find((pane) => pane.id === context.paneId);
    const existing = String(currentPane?.sessionId || "").trim();
    if (existing) {
      if (contextIdentityIsCurrent() && requestCoordinator.adoptBootstrapSession(existing, context.runContextToken)) {
        activePaneSessionIdRef.current = existing;
      }
      return existing;
    }

    const key = [context.paneId, context.paneGeneration, context.workflowId, context.apiBase, context.apiToken, context.authGeneration, context.mountedGeneration, context.runContextToken].join("\u0000");
    const inFlight = runSessionBootstrapRef.current;
    if (inFlight?.key === key) return inFlight.promise;

    const promise = (async (): Promise<string | null> => {
      const state = useAppStore.getState();
      const pane = state.panes.find((item) => item.id === context.paneId);
      if (!pane || !contextIdentityIsCurrent()) return null;
      const alreadyBound = String(pane.sessionId || "").trim();
      if (alreadyBound) return alreadyBound;

      const permissionMode = normalizeRunMode(
        state.pendingSessionRunModesByPane[context.paneId] ?? state.runMode,
      );
      const sessionMode = pane.sessionMode === "code_dev" ? "code_dev" : "daily_office";
      const provider = String(pane.modelProvider || "").trim();
      const model = String(pane.modelName || "").trim();
      const created = await window.agenticxDesktop.createSession({
        ...(sessionCreateAvatarId(pane.avatarId) ? { avatar_id: sessionCreateAvatarId(pane.avatarId) } : {}),
        session_mode: sessionMode,
        permission_mode: permissionMode,
        ...(provider && model ? { provider, model } : {}),
      });
      const createdSessionId = String(created.session_id || "").trim();
      if (!created.ok || !createdSessionId) return null;

      // createSession has no AbortSignal. Check every captured identity before
      // publishing its result so a late A response cannot bind pane B, a new
      // workflow, or a different authenticated backend.
      const latestState = useAppStore.getState();
      const latestPane = latestState.panes.find((item) => item.id === context.paneId);
      const currentSession = String(latestPane?.sessionId || "").trim();
      const contextIsCurrent = latestState.activePaneId === context.paneId && contextIdentityIsCurrent();
      if (!contextIsCurrent) return currentSession || null;
      if (currentSession) {
        if (requestCoordinator.adoptBootstrapSession(currentSession, context.runContextToken)) {
          activePaneSessionIdRef.current = currentSession;
        }
        return currentSession;
      }

      if (!requestCoordinator.adoptBootstrapSession(createdSessionId, context.runContextToken)) return null;
      // Zustand publishes synchronously, while React may commit the selector
      // update on the next turn. Keep guards in this in-flight run aligned with
      // the adopted session until that render lands.
      activePaneSessionIdRef.current = createdSessionId;
      setPaneSessionId(context.paneId, createdSessionId, { provider, model });
      setPaneSessionMode(context.paneId, created.session_mode ?? sessionMode);
      setSessionRunMode(createdSessionId, normalizeRunMode(created.permission_mode ?? permissionMode));
      if (latestState.activePaneId === context.paneId) setSessionId(createdSessionId);
      return createdSessionId;
    })().catch((error) => {
      console.error("[WorkflowStudio] lazy run session bootstrap failed:", error);
      return null;
    });
    runSessionBootstrapRef.current = { key, promise };
    void promise.finally(() => {
      if (runSessionBootstrapRef.current?.promise === promise) runSessionBootstrapRef.current = null;
    });
    return promise;
  }, [requestCoordinator, setPaneSessionId, setPaneSessionMode, setSessionId, setSessionRunMode]);

  const handleCreateRun = useCallback(async () => {
    if (!document || !selectedManifest || !selectedWorkflowId || creatingRun) return;
    if (document.workflow_id !== selectedWorkflowId) {
      setActionError("当前文档与选择的工作流不一致，请重新加载后再创建运行。");
      return;
    }
    const workflowId = selectedWorkflowId;
    const paneIdForRun = activePaneId;
    const paneGenerationForRun = paneIdentityRef.current.generation;
    const authGenerationForRun = authIdentityRef.current.generation;
    const mountedGenerationForRun = bootstrapGuardRef.current?.currentGeneration() || 0;
    const publishedRevision = selectedManifest.active_published_revision;
    if (dirty) {
      setActionError("请先保存当前修改，再创建运行。");
      return;
    }
    if (publishedRevision == null) {
      setActionError("请先发布一个版本，再创建运行。");
      return;
    }
    const runContextToken = requestCoordinator.beginRunContext();
    runRefreshTokenRef.current += 1;
    runGeneration.current += 1;
    // A new run owns a fresh panel context. Clear the previous run
    // synchronously so an old approval handler cannot receive run 2's token or
    // abort its controller while run 2 is still pending.
    runRef.current = null;
    setRun(null);
    setRunApprovals([]);
    setShowRunPanel(false);
    runAbortRef.current?.abort();
    const controller = new AbortController();
    runAbortRef.current = controller;
    const busyToken = ++runBusyTokenRef.current;
    setCreatingRun(true);
    setActionError("");
    setNotice("");
    let runRequest: WorkflowRunRequest | null = null;
    try {
      const sessionIdForRun = await ensureRunSession({
        paneId: paneIdForRun,
        paneGeneration: paneGenerationForRun,
        workflowId,
        apiBase,
        apiToken,
        authGeneration: authGenerationForRun,
        mountedGeneration: mountedGenerationForRun,
        runContextToken,
      });
      if (
        controller.signal.aborted
        || !sessionIdForRun
        || activePaneIdRef.current !== paneIdForRun
        || paneIdentityRef.current.generation !== paneGenerationForRun
        || selectedWorkflowIdRef.current !== workflowId
        || apiBaseRef.current !== apiBase
        || apiTokenRef.current !== apiToken
        || authIdentityRef.current.generation !== authGenerationForRun
        || !bootstrapGuardRef.current?.isCurrent(mountedGenerationForRun)
        || !requestCoordinator.isRunContextCurrent(runContextToken)
      ) {
        if (!controller.signal.aborted && !sessionIdForRun && requestCoordinator.isRunContextCurrent(runContextToken)) {
          setActionError("会话初始化失败，请检查本地服务后重试。");
        }
        return;
      }
      runRequest = requestCoordinator.beginRun(workflowId, sessionIdForRun);
      const response = await createWorkflowRun({ ...options, signal: controller.signal }, workflowId, publishedRevision, sessionIdForRun);
      if (
        controller.signal.aborted
        || !runRequest
        || !requestCoordinator.isRunCurrent(runRequest)
        || activePaneIdRef.current !== paneIdForRun
        || paneIdentityRef.current.generation !== paneGenerationForRun
        || selectedWorkflowIdRef.current !== workflowId
        || activePaneSessionIdRef.current !== sessionIdForRun
        || apiBaseRef.current !== apiBase
        || apiTokenRef.current !== apiToken
        || authIdentityRef.current.generation !== authGenerationForRun
        || !bootstrapGuardRef.current?.isCurrent(mountedGenerationForRun)
        || document.workflow_id !== workflowId
      ) return;
      const createdRun = response.run;
      if (!createdRun?.run_id) throw new Error("后端未返回运行 ID");
      runGeneration.current += 1;
      const applied = await applyRunResponse(response, createdRun.run_id, {
        workflowId,
        sessionId: sessionIdForRun,
        request: runRequest,
        generation: runGeneration.current,
        runContextToken,
        expectedCurrentRunId: null,
        signal: controller.signal,
      });
      if (!applied || !requestCoordinator.isRunCurrent(runRequest)) return;
      setShowRunPanel(true);
      setNotice(`运行已准备，状态由受管执行器推进。`);
    } catch (error) {
      if (
        !controller.signal.aborted
        && runRequest !== null
        && requestCoordinator.isRunCurrent(runRequest)
        && activePaneIdRef.current === paneIdForRun
        && paneIdentityRef.current.generation === paneGenerationForRun
        && selectedWorkflowIdRef.current === workflowId
        && activePaneSessionIdRef.current === runRequest.sessionId
        && authIdentityRef.current.generation === authGenerationForRun
        && Boolean(bootstrapGuardRef.current?.isCurrent(mountedGenerationForRun))
      ) {
        setActionError(apiErrorMessage(error, "创建运行失败"));
      }
    } finally {
      if (runBusyTokenRef.current === busyToken) setCreatingRun(false);
      if (runAbortRef.current === controller) runAbortRef.current = null;
    }
  }, [activePaneId, apiBase, apiToken, applyRunResponse, creatingRun, dirty, document, ensureRunSession, options, requestCoordinator, selectedManifest, selectedWorkflowId]);

  const refreshRun = useCallback(async (requestedContext: WorkflowRunRefreshContext) => {
    const currentRun = runRef.current;
    const sessionIdForRefresh = activePaneSessionIdRef.current;
    const workflowId = selectedWorkflowIdRef.current;
    if (!currentRun?.run_id || !workflowId || !sessionIdForRefresh) return;
    const runId = String(requestedContext.runId || "");
    const contextToken = requestedContext.requestToken;
    if (
      !runId
      || requestedContext.workflowId !== workflowId
      || requestedContext.sessionId !== sessionIdForRefresh
      || requestedContext.runId !== String(currentRun.run_id)
      || String(currentRun.workflow_id || "") !== workflowId
      || String(currentRun.session_id || "") !== sessionIdForRefresh
      || contextToken !== renderedRunContextToken
      || !requestCoordinator.isRunContextCurrent(contextToken)
    ) return;
    const refreshToken = ++runRefreshTokenRef.current;
    const generation = runGeneration.current;
    // Only abort after the captured run identity and context token are still
    // current. A delayed callback from run 1 must never abort run 2's request.
    runAbortRef.current?.abort();
    const controller = new AbortController();
    runAbortRef.current = controller;
    let detachExternalAbort: (() => void) | null = null;
    try {
      const externalSignal = requestedContext.signal;
      if (externalSignal) {
        if (externalSignal.aborted) return;
        const abortRefresh = () => controller.abort();
        externalSignal.addEventListener("abort", abortRefresh, { once: true });
        detachExternalAbort = () => externalSignal.removeEventListener("abort", abortRefresh);
      }
      const response = await fetchWorkflowRun({ ...options, signal: controller.signal }, runId, sessionIdForRefresh);
      if (
        controller.signal.aborted
        || generation !== runGeneration.current
        || selectedWorkflowIdRef.current !== workflowId
        || activePaneSessionIdRef.current !== sessionIdForRefresh
        || runRefreshTokenRef.current !== refreshToken
        || !requestCoordinator.isRunContextCurrent(contextToken)
        || String(runRef.current?.run_id || "") !== runId
      ) return;
      await applyRunResponse(response, runId, {
        workflowId,
        sessionId: sessionIdForRefresh,
        generation,
        runContextToken: contextToken,
        refreshToken,
        expectedCurrentRunId: runId,
        signal: controller.signal,
      });
    } catch (error) {
      if (!controller.signal.aborted && generation === runGeneration.current && selectedWorkflowIdRef.current === workflowId && activePaneSessionIdRef.current === sessionIdForRefresh && runRefreshTokenRef.current === refreshToken && requestCoordinator.isRunContextCurrent(contextToken) && String(runRef.current?.run_id || "") === runId) {
        setActionError(apiErrorMessage(error, "刷新运行失败"));
      }
    } finally {
      detachExternalAbort?.();
      if (runAbortRef.current === controller) runAbortRef.current = null;
    }
  }, [applyRunResponse, options, renderedRunContextToken, requestCoordinator]);

  const handleCloseRunPanel = useCallback(() => {
    // Closing owns the visible panel context. Invalidate it before unmounting
    // so a mutation that settles on the same tick cannot refresh a later run.
    requestCoordinator.beginRunContext();
    runRefreshTokenRef.current += 1;
    runGeneration.current += 1;
    runAbortRef.current?.abort();
    setShowRunPanel(false);
  }, [requestCoordinator]);

  const canPublish = Boolean(document && selectedManifest && !dirty && document.revision === selectedManifest.head_revision);
  // A cold pane is valid: handleCreateRun lazily creates and binds an ordinary
  // session only after the explicit click.
  const canRun = Boolean(document && selectedManifest?.active_published_revision != null && !dirty);

  return (
    <div className="agx-workflow-studio relative flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden bg-surface-base text-text-primary" data-testid="workflow-studio">
      <header className="flex shrink-0 flex-wrap items-start justify-between gap-3 border-b border-border bg-surface-panel px-5 py-3">
        <div className="flex min-w-0 flex-1 items-center gap-3"><span className="rounded-lg bg-[var(--ui-accent-surface)] p-2 text-[var(--ui-accent-text)]"><Sparkles className="h-4 w-4" aria-hidden /></span><div className="min-w-0"><h1 className="truncate text-base font-semibold text-text-strong">工作流 Studio</h1><p className="mt-0.5 truncate text-[11px] text-text-faint">把业务意图编排为可版本化、可审批的执行蓝图</p></div></div>
        <div className="flex min-w-0 max-w-full flex-1 flex-wrap items-center justify-end gap-2" role="toolbar" aria-label="工作流操作">
          {compactLayout && document ? <><Button onClick={() => setOpenDrawer((current) => current === "palette" ? null : "palette")} aria-expanded={openDrawer === "palette"} aria-controls="workflow-palette-drawer"><PanelLeft className="h-3.5 w-3.5" aria-hidden />列表</Button><Button onClick={() => setOpenDrawer((current) => current === "inspector" ? null : "inspector")} aria-expanded={openDrawer === "inspector"} aria-controls="workflow-inspector-drawer"><PanelRight className="h-3.5 w-3.5" aria-hidden />属性</Button></> : null}
          <span className={`text-[11px] ${compactLayout ? "hidden" : "hidden sm:inline"} ${dirty ? "text-status-warning" : "text-text-faint"}`}>{dirty ? "有未保存修改" : document ? `已保存 · v${document.revision}` : ""}</span><Button onClick={() => void loadCatalog()} disabled={catalogState === "loading"}><RefreshCw className={`h-3.5 w-3.5 ${catalogState === "loading" ? "animate-spin" : ""}`} />目录</Button><Button onClick={() => void handleSave()} disabled={!document || !dirty || saving || !selectedManifest}>{saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}保存</Button><Button variant="primary" onClick={() => void handlePublish()} disabled={!canPublish || publishing}>{publishing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}发布</Button><Button onClick={() => void handleCreateRun()} disabled={!canRun || creatingRun}>{creatingRun ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}创建运行</Button>
        </div>
      </header>

      {actionError ? <div className="agx-workflow-alert agx-workflow-alert--error mx-4 mt-3 flex shrink-0 items-start gap-2 rounded-lg px-3 py-2 text-xs" role="alert"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /><span className="whitespace-pre-wrap">{actionError}</span><button type="button" className="ml-auto shrink-0" aria-label="关闭错误" onClick={() => setActionError("")}><X className="h-3.5 w-3.5" /></button></div> : null}
      {notice ? <div className="agx-workflow-alert agx-workflow-alert--success mx-4 mt-3 flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-xs" role="status"><Check className="h-3.5 w-3.5" />{notice}</div> : null}
      {conflict ? <div className="agx-workflow-alert agx-workflow-alert--warning mx-4 mt-3 flex shrink-0 flex-wrap items-center gap-2 rounded-lg px-3 py-2 text-xs" role="alert"><AlertTriangle className="h-3.5 w-3.5" /><span>{conflict.message}（服务器 head v{conflict.serverRevision || "?"}）</span><Button className="ml-auto" onClick={handleReloadServer}>重新加载服务器版本</Button><Button onClick={() => void handleCopyLocalJson()}><Clipboard className="h-3.5 w-3.5" />复制本地 JSON</Button></div> : null}

      <div ref={studioContentRef} className="relative flex min-h-0 min-w-0 flex-1">
        <aside className={compactLayout ? "hidden" : "flex w-[246px] shrink-0 flex-col overflow-hidden border-r border-border bg-surface-panel"} aria-label="工作流列表与节点工具箱">
          <WorkflowListPanel manifests={manifests} listState={listState} listError={listError} selectedWorkflowId={selectedWorkflowId} document={document} creating={creating} apiBase={apiBase} apiToken={apiToken} onCreate={() => void handleCreate()} onCreateFromTemplate={() => setTemplateChooserOpen(true)} onRetry={() => void loadWorkflows()} onSelect={handleSelectWorkflow} onAddNode={handleAddNode} catalogError={catalogError} onRetryCatalog={() => void loadCatalog()} />
        </aside>

        {!document && listState === "ready" && manifests.length === 0 ? <main className="flex min-w-0 flex-1 items-center justify-center p-8"><div className="max-w-md text-center"><div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-[var(--ui-accent-surface)] text-[var(--ui-accent-text)]"><Sparkles className="h-7 w-7" /></div><h2 className="mt-4 text-lg font-semibold text-text-strong">从一个工作流开始</h2><p className="mt-2 text-sm leading-6 text-text-muted">使用八类语义节点描述责任、交付物、验收、决策和审批。运行时会生成独立的只读轨迹。</p><div className="mt-5 flex flex-wrap justify-center gap-2"><Button variant="primary" onClick={() => setTemplateChooserOpen(true)} disabled={creating || !apiBase || !apiToken}><Sparkles className="h-3.5 w-3.5" />从模板创建</Button><Button onClick={() => void handleCreate()} disabled={creating || !apiBase || !apiToken}>{creating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FilePlus2 className="h-3.5 w-3.5" />}空白创建</Button></div></div></main> : <main className="flex min-w-0 flex-1 flex-col"><div className="flex min-h-0 min-w-0 flex-1"><div className={`min-h-0 flex-1 ${compactLayout ? "min-w-[320px]" : "min-w-0"}`}>{documentState === "loading" ? <div className="flex h-full items-center justify-center text-sm text-text-faint"><Loader2 className="mr-2 h-4 w-4 animate-spin" />正在加载工作流…</div> : documentState === "error" ? <div className="flex h-full items-center justify-center p-8 text-center"><div><AlertTriangle className="mx-auto h-7 w-7 text-status-error" /><p className="mt-3 text-sm text-status-error">{documentError}</p><Button className="mt-3" onClick={() => selectedWorkflowId && void loadDocument(selectedWorkflowId)}><RefreshCw className="h-3.5 w-3.5" />重试</Button></div></div> : document ? <WorkflowCanvas document={document} selectedNodeId={selectedNodeId} onSelectNode={setSelectedNodeId} onChange={updateDocument} onConnectRejected={setActionError} /> : <div className="flex h-full items-center justify-center text-sm text-text-faint">选择一个工作流开始编辑</div>}</div>{document && !compactLayout ? <div className="min-h-0 w-[318px] shrink-0"><WorkflowInspector document={document} selectedNodeId={selectedNodeId} connectors={connectors} catalogLoading={catalogState === "loading"} catalogError={catalogError || null} onRetryCatalog={() => void loadCatalog()} onChangeDocument={updateDocument} onChangeNode={updateNode} /></div> : null}</div>{showRunPanel ? <div className="h-[306px] shrink-0"><WorkflowRunPanel run={run} approvals={runApprovals} apiBase={apiBase} apiToken={apiToken} sessionId={activePaneSessionId} runContextToken={renderedRunContextToken} onRefresh={refreshRun} onClose={handleCloseRunPanel} /></div> : <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-2 text-[10px] text-text-faint"><span>{selectedManifest ? `当前 head v${selectedManifest.head_revision}` : ""}{selectedManifest?.active_published_revision != null ? ` · 已发布 v${selectedManifest.active_published_revision}` : " · 尚未发布"}</span><button type="button" className="text-text-muted hover:text-text-strong" onClick={() => setShowRunPanel(true)} disabled={!run}>打开运行预览</button></div>}</main>}

        {compactLayout && openDrawer ? <>
          <button type="button" className="absolute inset-0 z-20 border-0 bg-black/35 p-0" aria-label="关闭工作流侧栏" title="关闭工作流侧栏" onClick={() => setOpenDrawer(null)} />
          {openDrawer === "palette" ? <aside id="workflow-palette-drawer" className="absolute inset-y-0 left-0 z-30 flex min-h-0 max-w-full flex-col overflow-hidden border-r border-border bg-surface-panel shadow-2xl" style={{ width: "min(246px, calc(100% - 1rem))" }} aria-label="工作流列表与节点工具箱"><WorkflowListPanel manifests={manifests} listState={listState} listError={listError} selectedWorkflowId={selectedWorkflowId} document={document} creating={creating} apiBase={apiBase} apiToken={apiToken} onCreate={() => void handleCreate()} onCreateFromTemplate={() => setTemplateChooserOpen(true)} onRetry={() => void loadWorkflows()} onSelect={handleSelectWorkflow} onAddNode={handleAddNode} catalogError={catalogError} onRetryCatalog={() => void loadCatalog()} onClose={() => setOpenDrawer(null)} /></aside> : <aside id="workflow-inspector-drawer" className="absolute inset-y-0 right-0 z-30 flex min-h-0 max-w-full flex-col overflow-hidden border-l border-border bg-surface-panel shadow-2xl" style={{ width: "min(318px, calc(100% - 1rem))" }} aria-label="工作流属性检查器"><div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-2.5"><p className="text-xs font-semibold text-text-strong">属性</p><button type="button" className="rounded-md p-1.5 text-text-muted hover:bg-surface-hover hover:text-text-strong" aria-label="关闭工作流属性" title="关闭工作流属性" onClick={() => setOpenDrawer(null)}><X className="h-4 w-4" /></button></div><div className="min-h-0 flex-1 overflow-hidden"><WorkflowInspector document={document!} selectedNodeId={selectedNodeId} connectors={connectors} catalogLoading={catalogState === "loading"} catalogError={catalogError || null} onRetryCatalog={() => void loadCatalog()} onChangeDocument={updateDocument} onChangeNode={updateNode} /></div></aside>}
        </> : null}

      </div>
      <WorkflowTemplateChooser open={templateChooserOpen} onClose={() => setTemplateChooserOpen(false)} onCreate={handleCreateFromTemplate} />
    </div>
  );
}
