import { useCallback, useEffect, useState } from "react";
import { FilePlus2, Plus, X } from "lucide-react";
import { Panel } from "../ds/Panel";
import { TemplateGrid } from "./TemplateGrid";
import { TaskFormPanel } from "./TaskFormPanel";
import { deleteAutomationTaskWithConfirm } from "../../utils/automation-delete";
import { TaskList } from "./TaskList";
import type { AutomationTask, AutomationTemplate } from "./types";
import { useAppStore } from "../../store";
import { META_AGENT_DISPLAY_NAME } from "../../constants/branding";

function PreventSleepToggle() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    let disposed = false;
    const load = async () => {
      setLoading(true);
      setMessage("");
      try {
        const result = await window.agenticxDesktop.loadAutomationConfig();
        if (!disposed && result?.ok && result.config) {
          setEnabled(Boolean(result.config.prevent_sleep));
        }
      } catch {
        if (!disposed) setMessage("读取配置失败。");
      } finally {
        if (!disposed) setLoading(false);
      }
    };
    void load();
    return () => { disposed = true; };
  }, []);

  const persist = async (next: boolean) => {
    setSaving(true);
    setMessage("");
    try {
      const result = await window.agenticxDesktop.saveAutomationConfig({ prevent_sleep: next });
      if (!result?.ok) {
        setMessage(result?.error ? String(result.error) : "保存失败。");
        setEnabled(!next);
        return;
      }
      setEnabled(next);
      setMessage("已保存。");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "保存失败。");
      setEnabled(!next);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex min-h-10 items-center gap-3 rounded-lg border border-border bg-surface-card px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="shrink-0 text-xs font-medium text-text-strong">阻止系统睡眠</span>
          <span className="truncate text-[11px] text-text-faint">长任务运行时保持唤醒，退出应用后失效</span>
        </div>
        {message ? (
          <div className={`mt-0.5 text-[10px] ${message.startsWith("已保存") ? "text-text-faint" : "text-rose-400"}`}>
            {message}
          </div>
        ) : null}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-label={enabled ? "已开启抑制系统睡眠" : "已关闭抑制系统睡眠"}
        disabled={saving || loading}
        onClick={() => { if (!saving && !loading) void persist(!enabled); }}
        className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--settings-accent-focus,rgba(59,130,246,0.5))] ${
          enabled ? "bg-[var(--ui-btn-primary-bg)] shadow-[inset_0_1px_0_rgba(255,255,255,0.2)]" : "bg-text-muted/35"
        } ${saving || loading ? "cursor-not-allowed opacity-50" : ""}`}
      >
        <span
          className={`pointer-events-none absolute left-0.5 top-0.5 h-4 w-4 rounded-full shadow-sm ring-1 ring-black/5 transition-transform duration-200 ease-out ${
            enabled ? "bg-[var(--ui-btn-primary-text)]" : "bg-white"
          } ${enabled ? "translate-x-4" : ""}`}
        />
      </button>
    </div>
  );
}

export function AutomationTab({ showIntro = true }: { showIntro?: boolean } = {}) {
  const [tasks, setTasks] = useState<AutomationTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingTask, setEditingTask] = useState<AutomationTask | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [showCreatePicker, setShowCreatePicker] = useState(false);
  const [runHint, setRunHint] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const loadTasks = useCallback(async () => {
    try {
      const result = await window.agenticxDesktop.loadAutomationTasks();
      if (result?.ok && result.tasks) {
        setTasks(result.tasks as AutomationTask[]);
      }
    } catch { /* silent */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void loadTasks(); }, [loadTasks]);

  useEffect(() => {
    return window.agenticxDesktop.onAutomationTaskProgress((payload) => {
      if (payload.phase === "running" || payload.phase === "success" || payload.phase === "error") {
        void loadTasks();
      }
    });
  }, [loadTasks]);

  useEffect(() => {
    if (!runHint) return;
    const t = window.setTimeout(() => setRunHint(null), 10_000);
    return () => window.clearTimeout(t);
  }, [runHint]);

  const handleSave = useCallback(async (task: AutomationTask) => {
    const toSave: AutomationTask = { ...task };
    const result = await window.agenticxDesktop.saveAutomationTask(toSave);
    if (result?.ok) {
      setShowForm(false);
      setEditingTask(null);
      void loadTasks();
    }
    return {
      ok: Boolean(result?.ok),
      error: result?.error != null ? String(result.error) : undefined,
    };
  }, [loadTasks]);

  const handleDelete = useCallback(async (taskId: string) => {
    const result = await deleteAutomationTaskWithConfirm(taskId);
    if (result.cancelled) return;
    if (result.ok) void loadTasks();
  }, [loadTasks]);

  const handleToggle = useCallback(async (taskId: string, enabled: boolean) => {
    const task = tasks.find((t) => t.id === taskId);
    if (!task) return;
    const updated = { ...task, enabled };
    const result = await window.agenticxDesktop.saveAutomationTask(updated);
    if (result?.ok) void loadTasks();
  }, [tasks, loadTasks]);

  const handleRunNow = useCallback(async (task: AutomationTask) => {
    const r = await window.agenticxDesktop.runAutomationTaskNow({ taskId: task.id });
    setRunHint(
      r.ok
        ? {
            kind: "ok",
            text: "已在新会话中触发执行。展开该任务可查看上次结果；侧栏打开该任务窗格可查看最新一轮对话。",
          }
        : { kind: "err", text: r.error ?? "执行失败" },
    );
    setTimeout(() => void loadTasks(), 1500);
  }, [loadTasks]);

  const handleOpenConversation = useCallback((task: AutomationTask) => {
    const sessionId = String(task.sessionId ?? "").trim();
    if (!sessionId) {
      setRunHint({ kind: "err", text: "该任务还没有执行记录，请先立即执行一次。" });
      return;
    }
    const avatarId = `automation:${task.id}`;
    const state = useAppStore.getState();
    const existing = state.panes.find((pane) => pane.avatarId === avatarId);
    const paneId = existing?.id ?? state.addPane(avatarId, `定时 · ${task.name}`, sessionId);
    if (existing && String(existing.sessionId ?? "").trim() !== sessionId) {
      state.setPaneMessages(existing.id, []);
      state.setPaneSessionId(existing.id, sessionId);
    }
    state.setActivePaneId(paneId);
    state.setActiveAvatarId(null);
    state.setMainView("chat");
  }, []);

  const handleTemplateSelect = useCallback((tpl: AutomationTemplate) => {
    setEditingTask({
      id: "",
      name: tpl.name,
      prompt: tpl.defaultPrompt,
      frequency: { ...tpl.defaultFrequency },
      enabled: true,
      createdAt: "",
      fromTemplate: tpl.id,
    });
    setShowCreatePicker(false);
    setShowForm(true);
  }, []);

  const handleAddManual = useCallback(() => {
    setEditingTask(null);
    setShowCreatePicker(false);
    setShowForm(true);
  }, []);

  const handleEdit = useCallback((task: AutomationTask) => {
    setEditingTask(task);
    setShowForm(true);
  }, []);

  return (
    <div className="space-y-4">
      {/* Header */}
      {showIntro ? (
        <div className="text-sm text-text-subtle">
          管理自动化任务，让{META_AGENT_DISPLAY_NAME}按计划为你工作。
        </div>
      ) : null}

      <PreventSleepToggle />

      {/* Existing automations are the primary object on this page. */}
      <Panel
        title="我的自动化任务"
        actions={
          <button
            type="button"
            aria-expanded={showCreatePicker}
            onClick={() => setShowCreatePicker((open) => !open)}
            className={`flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition ${
              showCreatePicker
                ? "bg-surface-hover text-text-primary"
                : "text-text-muted hover:bg-surface-card hover:text-text-primary"
            }`}
          >
            <Plus className="h-3.5 w-3.5" />
            新建任务
          </button>
        }
      >
        {runHint ? (
          <div
            className={`mb-2 rounded-lg border px-3 py-2 text-xs ${
              runHint.kind === "ok"
                ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
                : "border-rose-500/30 bg-rose-500/10 text-rose-200"
            }`}
          >
            {runHint.text}
          </div>
        ) : null}
        {loading ? (
          <div className="py-4 text-center text-sm text-text-faint">加载中…</div>
        ) : (
          <TaskList
            tasks={tasks}
            onToggle={handleToggle}
            onEdit={handleEdit}
            onDelete={handleDelete}
            onRunNow={handleRunNow}
            onOpenConversation={handleOpenConversation}
          />
        )}
      </Panel>

      {/* Templates belong to creation, so they appear only after the user asks to create. */}
      {showCreatePicker ? (
        <section
          aria-label="新建自动化任务"
          className="rounded-xl border border-[rgba(var(--theme-color-rgb,59,130,246),0.28)] bg-surface-panel/70 p-3 shadow-sm"
        >
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-semibold text-text-strong">新建自动化任务</div>
              <p className="mt-0.5 text-xs text-text-faint">从空白开始，或选择一个模板再修改。</p>
            </div>
            <button
              type="button"
              aria-label="收起新建任务"
              onClick={() => setShowCreatePicker(false)}
              className="rounded-md p-1 text-text-faint transition hover:bg-surface-hover hover:text-text-primary"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <button
            type="button"
            onClick={handleAddManual}
            className="mb-3 flex w-full items-center gap-3 rounded-lg border border-border bg-surface-card px-3 py-2.5 text-left transition hover:border-[rgba(var(--theme-color-rgb,59,130,246),0.4)] hover:bg-surface-card-strong"
          >
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-surface-panel text-text-subtle">
              <FilePlus2 className="h-4 w-4" />
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-medium text-text-strong">空白任务</span>
              <span className="block text-xs text-text-faint">自行填写任务内容、执行模型与运行时间</span>
            </span>
          </button>
          <TemplateGrid onSelect={handleTemplateSelect} title="选择模板" />
        </section>
      ) : null}

      {/* Form modal */}
      {showForm && (
        <TaskFormPanel
          initial={editingTask}
          onSave={handleSave}
          onCancel={() => { setShowForm(false); setEditingTask(null); }}
          onAfterDelete={async () => {
            setShowForm(false);
            setEditingTask(null);
            void loadTasks();
          }}
        />
      )}
    </div>
  );
}
