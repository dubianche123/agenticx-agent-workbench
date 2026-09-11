import { useEffect, useState } from "react";
import { AlertTriangle, ShieldCheck } from "lucide-react";
import { Button } from "./ds/Button";
import { Modal } from "./ds/Modal";
import {
  CONFIRM_POLICY_OPTIONS,
  DEFAULT_CONFIRM_POLICY,
  type ConfirmPolicy,
} from "../constants/confirm-strategy-options";
import {
  canReuseProtectedConfirm,
  isProtectedConfirmContext,
  parentPathForConfirmScope,
  protectedConfirmReuseMode,
  protectedConfirmReason,
} from "../utils/confirm-scope";
import {
  buildConfirmRiskAssessment,
  type ConfirmRiskSeverity,
} from "../utils/confirm-risk";

type Props = {
  open: boolean;
  question: string;
  sourceLabel?: string;
  diff?: string;
  context?: Record<string, unknown>;
  defaultPolicy?: ConfirmPolicy;
  /** 用户当前是否处于「代我批准」。用来解释「我不是开了自动吗，这个怎么还问我」。 */
  autoRunMode?: boolean;
  onApprove: (policy: ConfirmPolicy) => void;
  onReject: (policy: ConfirmPolicy) => void;
};

export type ConfirmRequestPresentation = {
  operationLabel: string;
  summary: string;
  targetLabel?: string;
  target?: string;
  allowlistScope: string;
  riskNotice?: string;
};

function textValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function textList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => textValue(item))
    .filter(Boolean);
}

function riskTone(severity: ConfirmRiskSeverity): {
  card: string;
  badge: string;
} {
  if (severity === "critical") {
    return {
      card: "border-red-500/30 bg-red-500/5",
      badge: "bg-red-500/10 text-[var(--status-error)]",
    };
  }
  if (severity === "high") {
    return {
      card: "border-amber-500/30 bg-amber-500/5",
      badge: "bg-amber-500/10 text-[var(--status-warning)]",
    };
  }
  return {
    card: "border-sky-500/30 bg-sky-500/5",
    badge: "bg-sky-500/10 text-sky-600 dark:text-sky-300",
  };
}

function executionBoundaryRows(context?: Record<string, unknown>): Array<{
  label: string;
  value: string;
  code?: boolean;
}> {
  const command = textValue(context?.command);
  const path = textValue(context?.path);
  if (!command && !path) return [];

  const permissions = textValue(context?.sandbox_permissions) || "workspace-write";
  const roots = textList(context?.workspace_roots);
  const cwd = textValue(context?.cwd);
  const commandPrefix = textValue(context?.command_prefix);
  const rows: Array<{ label: string; value: string; code?: boolean }> = [
    {
      label: "写入权限",
      value:
        permissions === "danger-full-access"
          ? "主机完全访问（不套沙箱，路径拒绝规则本次不生效）"
          : "工作区写入隔离",
    },
  ];
  if (roots.length > 0) {
    rows.push({ label: "可写工作区", value: roots.join("\n"), code: true });
  }
  if (cwd) rows.push({ label: "运行目录", value: cwd, code: true });
  if (commandPrefix) rows.push({ label: "命令类别", value: commandPrefix, code: true });
  return rows;
}

function executionBoundarySummary(context?: Record<string, unknown>): string {
  const permissions = textValue(context?.sandbox_permissions) || "workspace-write";
  if (permissions === "danger-full-access") {
    return "整台电脑 · 不受文件沙箱和路径拒绝规则保护";
  }
  if (permissions === "read-only") return "只读 · 不允许修改文件";

  const cwd = textValue(context?.cwd);
  if (cwd) return `工作区内 · ${cwd}`;

  const roots = textList(context?.workspace_roots);
  if (roots.length === 1) return `工作区内 · ${roots[0]}`;
  if (roots.length > 1) return `${roots.length} 个可写工作区内`;
  return "工作区写入隔离内";
}

function fallbackPathFromQuestion(question: string): {
  operationLabel: string;
  path: string;
} | null {
  const normalized = question.trim();
  const candidates = [
    { prefix: "Write changes to ", operationLabel: "写入文件" },
    { prefix: "Apply edit to ", operationLabel: "修改文件" },
  ] as const;
  for (const candidate of candidates) {
    if (!normalized.startsWith(candidate.prefix) || !normalized.endsWith("?")) continue;
    const path = normalized.slice(candidate.prefix.length, -1).trim();
    if (path) return { operationLabel: candidate.operationLabel, path };
  }
  return null;
}

function fallbackCommandFromQuestion(question: string): string {
  const normalized = question.trim();
  const prefix = "Command '";
  const suffix = "' is not in SAFE_COMMANDS. Execute anyway?";
  if (!normalized.startsWith(prefix) || !normalized.endsWith(suffix)) return "";
  return normalized.slice(prefix.length, -suffix.length).trim();
}

/**
 * Build a human-readable view from the structured confirmation context.
 * Unknown requests remain unclassified instead of being translated or guessed.
 */
export function buildConfirmRequestPresentation(
  question: string,
  context?: Record<string, unknown>,
): ConfirmRequestPresentation {
  const command = textValue(context?.command) || fallbackCommandFromQuestion(question);
  const contextPath = textValue(context?.path);
  const fallbackPath = contextPath ? null : fallbackPathFromQuestion(question);
  const path = contextPath || fallbackPath?.path || "";
  const skill = textValue(context?.skill);
  const tool = textValue(context?.tool);
  const action = textValue(context?.action);
  const risk = textValue(context?.risk);

  if (command) {
    const commandType = command.split(/\s+/u)[0] || command;
    const exactCommandReuse = protectedConfirmReuseMode(context) === "exact-command";
    return {
      operationLabel: risk === "high" ? "运行高风险命令" : "运行命令",
      summary: "智能体准备运行以下命令。请核对完整命令是否符合你的要求。",
      targetLabel: "完整命令",
      target: command,
      allowlistScope: exactCommandReuse
        ? "当前任务内，完整命令、运行目录、权限级别、工作区范围和风险类别完全一致的请求"
        : `本次运行内，以「${commandType}」发起的同类命令`,
      riskNotice:
        risk === "high"
          ? "系统已将这条命令标记为高风险。确认前请仔细核对命令内容。"
          : "该命令不在默认可直接执行范围内，因此需要你的许可。",
    };
  }

  if (path) {
    const operationLabel =
      tool === "file_edit"
        ? "修改文件"
        : tool === "codegen"
          ? "生成文件"
          : fallbackPath?.operationLabel ?? "写入文件";
    const parentPath = parentPathForConfirmScope(path);
    return {
      operationLabel,
      summary: "智能体准备更改这个文件。请核对文件路径，并按需查看下方改动预览。",
      targetLabel: "文件路径",
      target: path,
      allowlistScope: parentPath
        ? `本次运行内，对「${parentPath}」目录中文件的同类更改`
        : `本次运行内，与「${path}」目标相同的文件更改`,
      riskNotice:
        risk === "destructive"
          ? "此操作可能删除或覆盖内容，请确认目标文件无误。"
          : undefined,
    };
  }

  if (skill) {
    const operationLabel =
      action === "install" ? "安装技能" : action === "delete" ? "删除技能" : "管理技能";
    return {
      operationLabel,
      summary: "智能体准备更改你的技能配置。请确认技能名称与操作符合预期。",
      targetLabel: "技能",
      target: skill,
      allowlistScope: `本次运行内，其他由「${tool || "技能管理"}」发起的同类操作`,
      riskNotice:
        risk === "high"
          ? "安全扫描已将该技能标记为高风险，请确认来源与内容可信。"
          : undefined,
    };
  }

  return {
    operationLabel: "需要授权的操作",
    summary: tool
      ? "智能体准备调用一个需要授权的工具。系统不会猜测或改写其含义，请展开原始请求核对。"
      : "系统无法可靠归类这个请求。请展开原始请求详情，确认后再执行。",
    targetLabel: tool ? "工具标识" : undefined,
    target: tool || undefined,
    allowlistScope: tool
      ? `本次运行内，其他由「${tool}」发起的同类操作`
      : "本次运行内，与这次请求完全相同的操作",
  };
}

export function ConfirmDialog({
  open,
  question,
  sourceLabel,
  diff,
  context,
  defaultPolicy = DEFAULT_CONFIRM_POLICY,
  autoRunMode = false,
  onApprove,
  onReject,
}: Props) {
  const [policy, setPolicy] = useState<ConfirmPolicy>(DEFAULT_CONFIRM_POLICY);
  const presentation = buildConfirmRequestPresentation(question, context);
  const protectedRequest = isProtectedConfirmContext(context);
  const reusableProtectedRequest = canReuseProtectedConfirm(context);
  const protectedReason = protectedConfirmReason(context);
  const riskAssessment = buildConfirmRiskAssessment(context);
  const exactCommandReuse = protectedConfirmReuseMode(context) === "exact-command";
  const approvalWorkspace = textValue(context?.cwd);
  const tone = riskTone(riskAssessment.severity);
  const boundaryRows = executionBoundaryRows(context);
  const boundarySummary = executionBoundarySummary(context);
  // 用户开着「代我批准」，这个框还是弹了出来。先回答他的第一个问题——
  // 「我不是开了自动吗，这个怎么还问我」——再谈允许范围，否则只会被当成故障。
  const autoModeInterrupted = protectedRequest && autoRunMode;
  // 「以后都不再问这条命令」只在能锁死到一条完整命令时才给:后端的
  // protectedConfirmReuseMode 已经判过——必须是 bash 工具、workspace-write 档、
  // 有执行目录和工作区范围,且不含三类永不豁免的高危类别。判不到那个精度就不该
  // 提供长期豁免,否则用户以为自己放行了一条命令,实际放行了一类。
  const policyOptions = CONFIRM_POLICY_OPTIONS.filter((option) => {
    if (option.value === "once") return true;
    if (option.value === "this-run") return !protectedRequest || reusableProtectedRequest;
    return exactCommandReuse;
  });

  const effectivePolicy = policyOptions.some((option) => option.value === policy)
    ? policy
    : "once";
  const selectedPolicy =
    policyOptions.find((option) => option.value === effectivePolicy) ?? policyOptions[0];
  const selectedPolicyDescription =
    selectedPolicy?.value === "once"
      ? "只执行这一次，不记住本次许可。"
      : selectedPolicy?.value === "this-run"
        ? exactCommandReuse
          ? "仅完全相同的命令；任务结束后自动失效。"
          : "同类操作在当前任务内直接执行；任务结束后自动失效。"
        : "仅当前工作区内的完全相同命令；可随时在设置中撤销。";
  const riskSummary =
    riskAssessment.categories.map((category) => category.label).join(" · ")
    || presentation.operationLabel;

  const modalTitle =
    riskAssessment.severity === "critical" || riskAssessment.severity === "high"
      ? "确认高危操作"
      : protectedRequest
        ? "确认受保护操作"
        : "需要确认";
  const approveLabel =
    effectivePolicy === "once"
      ? "允许这一次"
      : effectivePolicy === "this-run"
        ? "允许本任务"
        : "保存并允许";

  useEffect(() => {
    if (!open) return;
    const nextPolicy =
      defaultPolicy === "always" && !exactCommandReuse
        ? "once"
        : defaultPolicy === "this-run" && protectedRequest && !reusableProtectedRequest
          ? "once"
          : defaultPolicy;
    setPolicy(nextPolicy);
  }, [defaultPolicy, exactCommandReuse, open, protectedRequest, question, reusableProtectedRequest]);

  return (
    <Modal
      open={open}
      title={modalTitle}
      panelClassName="w-[620px] max-w-[92vw] bg-surface-panel"
      footer={(
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onReject(effectivePolicy)}>
            取消
          </Button>
          <Button variant="primary" onClick={() => onApprove(effectivePolicy)}>
            {approveLabel}
          </Button>
        </div>
      )}
    >
      <div className="max-h-[calc(92vh-8.5rem)] space-y-3 overflow-y-auto pr-1">
        <section className={`rounded-xl border p-4 ${tone.card}`}>
          <div className="flex items-start gap-3">
            <div className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${tone.badge}`}>
              {protectedRequest ? <AlertTriangle size={18} /> : <ShieldCheck size={18} />}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${tone.badge}`}>
                  {riskAssessment.levelLabel}
                </span>
                {sourceLabel ? (
                  <span className="text-[11px] text-text-subtle">由 {sourceLabel} 发起</span>
                ) : null}
              </div>
              <h3 className="mt-2 text-base font-semibold text-text-strong">{riskSummary}</h3>
              <p className="mt-1 text-xs leading-5 text-text-muted">{presentation.summary}</p>
            </div>
          </div>

          {autoModeInterrupted ? (
            <p className="mt-3 rounded-md bg-amber-500/10 px-3 py-2 text-xs leading-5 text-[var(--status-warning)]">
              “代我批准”已开启，但高风险操作仍需你确认。
            </p>
          ) : null}

          {presentation.target ? (
            <div className="mt-3 rounded-lg border border-border/70 bg-surface-panel px-3 py-2.5">
              <div className="text-[11px] text-text-subtle">{presentation.targetLabel}</div>
              <code className="mt-1 block max-h-28 overflow-auto whitespace-pre-wrap break-all text-xs leading-5 text-text-strong">
                {presentation.target}
              </code>
            </div>
          ) : null}

          {boundaryRows.length > 0 ? (
            <div className="mt-3 flex items-start gap-2 text-xs leading-5">
              <span className="shrink-0 text-text-subtle">执行范围</span>
              <code
                className={`break-all ${
                  textValue(context?.sandbox_permissions) === "danger-full-access"
                    ? "font-sans font-semibold text-[var(--status-error)]"
                    : "text-text-strong"
                }`}
              >
                {boundarySummary}
              </code>
            </div>
          ) : null}

          {presentation.riskNotice && !protectedRequest ? (
            <p className="mt-2 text-xs leading-5 text-[var(--status-warning)]">
              {presentation.riskNotice}
            </p>
          ) : null}
        </section>

        {diff ? (
          <details className="rounded-lg border border-border px-3 py-2 text-xs text-text-muted">
            <summary className="cursor-pointer select-none font-medium text-text-primary">
              查看文件改动
            </summary>
            <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-surface-panel p-3 text-xs text-text-strong">
              {diff}
            </pre>
          </details>
        ) : null}

        <section className="rounded-xl border border-border bg-surface-card p-3">
          <div className="mb-2 text-sm font-semibold text-text-primary">允许范围</div>
          {policyOptions.length === 1 ? (
            <div className="flex items-center justify-between gap-3 rounded-lg border border-[rgba(var(--theme-color-rgb,59,130,246),0.35)] bg-[rgba(var(--theme-color-rgb,59,130,246),0.08)] px-3 py-2.5">
              <span className="text-sm font-medium text-text-primary">仅这一次</span>
              <span className="text-xs text-text-subtle">此操作不会被记住</span>
            </div>
          ) : (
            <div className="space-y-1.5" role="radiogroup" aria-label="允许范围">
              {policyOptions.map((option) => {
                const selected = effectivePolicy === option.value;
                const scopeHint =
                  option.value === "once"
                    ? "单次"
                    : option.value === "this-run"
                      ? exactCommandReuse
                        ? "相同命令 · 当前任务"
                        : "同类操作 · 当前任务"
                      : "相同命令 · 当前工作区";
                return (
                  <label
                    key={option.value}
                    className={`flex cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2.5 transition-colors ${
                      selected
                        ? "border-[rgba(var(--theme-color-rgb,59,130,246),0.4)] bg-[rgba(var(--theme-color-rgb,59,130,246),0.08)]"
                        : "border-transparent hover:border-border hover:bg-surface-hover"
                    }`}
                  >
                    <input
                      type="radio"
                      name="confirm-policy"
                      checked={selected}
                      onChange={() => setPolicy(option.value)}
                      className={`h-4 w-4 shrink-0 border-border bg-surface-panel ${
                        option.value === "always" ? "accent-amber-500" : "accent-emerald-500"
                      }`}
                    />
                    <span className="min-w-0 flex-1 text-sm font-medium text-text-primary">
                      {option.label}
                    </span>
                    <span className="shrink-0 text-[11px] text-text-subtle">{scopeHint}</span>
                  </label>
                );
              })}
            </div>
          )}
          <p className="mt-2 px-1 text-xs leading-5 text-text-muted">
            {selectedPolicyDescription}
          </p>
        </section>

        <details className="rounded-lg border border-border px-3 py-2 text-xs text-text-muted">
          <summary className="cursor-pointer select-none font-medium text-text-primary">
            查看技术详情
          </summary>
          <div className="mt-3 space-y-3 border-t border-border pt-3">
            {protectedRequest ? (
              <div>
                <div className="font-medium text-text-primary">为什么需要确认</div>
                {protectedReason ? <p className="mt-1 leading-5">{protectedReason}。</p> : null}
                <div className="mt-2 space-y-2">
                  {riskAssessment.categories.map((category) => (
                    <div key={category.code}>
                      <div className="font-medium text-text-primary">{category.label}</div>
                      <p className="mt-0.5 leading-5">{category.description}</p>
                      {category.evidence.length > 0 ? (
                        <p className="mt-1 break-all text-[11px] leading-4 text-text-subtle">
                          触发依据：{category.evidence.join("；")}
                        </p>
                      ) : null}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {boundaryRows.length > 0 ? (
              <div>
                <div className="font-medium text-text-primary">完整执行边界</div>
                <dl className="mt-1.5 space-y-1.5">
                  {boundaryRows.map((row) => (
                    <div key={row.label} className="grid grid-cols-[5rem_minmax(0,1fr)] gap-2">
                      <dt className="text-text-subtle">{row.label}</dt>
                      <dd className={`whitespace-pre-wrap break-all text-text-strong ${row.code ? "font-mono" : ""}`}>
                        {row.value}
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
            ) : null}

            {reusableProtectedRequest ? (
              <div>
                <div className="font-medium text-text-primary">授权匹配范围</div>
                <p className="mt-1 leading-5">{presentation.allowlistScope}</p>
                {exactCommandReuse ? (
                  <p className="mt-1 leading-5">
                    只有完整命令、运行目录、权限级别、工作区范围和风险类别都一致时才会复用。
                  </p>
                ) : null}
                {approvalWorkspace && exactCommandReuse ? (
                  <p className="mt-1 break-all leading-5">
                    长期许可仅在此工作区生效：<code>{approvalWorkspace}</code>
                  </p>
                ) : null}
              </div>
            ) : null}

            <div>
              <div className="font-medium text-text-primary">原始请求</div>
              <pre className="mt-1.5 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded bg-surface-panel p-2 text-xs text-text-strong">
                {question}
              </pre>
            </div>
          </div>
        </details>
      </div>
    </Modal>
  );
}
