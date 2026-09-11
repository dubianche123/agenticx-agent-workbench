import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Bot,
  FileText,
  FolderKanban,
  Loader2,
  PackageCheck,
  ShieldCheck,
  UsersRound,
} from "lucide-react";

import { Modal } from "../ds/Modal";

export type PortablePackagePreviewModel = {
  schemaVersion: 2;
  artifactId: string;
  releaseVersion: string;
  kind: "expert" | "group";
  name: string;
  description: string;
  summary: string;
  byteSize: number;
  recommendedPermissionMode: "plan" | "ask" | "auto";
  skillDependencies: string[];
  mcpDependencies: string[];
  resourcePaths: string[];
  workspaceSlots: string[];
  scanReport: {
    scannerVersion: string;
    hasFindings: boolean;
    shouldBlock: boolean;
    findings: Array<{
      ruleId: string;
      category: string;
      severity: string;
      blocking: boolean;
      field: string;
      line: number;
      column: number;
    }>;
  };
  systemPrompt: string;
  memberCount: number;
  members: Array<{ name: string; role: string; systemPrompt: string }>;
};

export type PortablePackageCandidate = {
  raw: string;
  confirmationToken: string;
  filePath?: string;
  sourceLabel?: string;
  preview: PortablePackagePreviewModel;
};

export type PortablePackageSelection =
  | { status: "selected"; candidate: PortablePackageCandidate }
  | { status: "canceled" }
  | { status: "error"; error: string };

export type PortablePackageImportOutcome = Awaited<
  ReturnType<Window["agenticxDesktop"]["importPortablePackage"]>
>;

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeScanReport(value: unknown): PortablePackagePreviewModel["scanReport"] | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    typeof row.scanner_version !== "string"
    || typeof row.has_findings !== "boolean"
    || typeof row.should_block !== "boolean"
    || !Array.isArray(row.findings)
  ) return null;
  const findings = row.findings.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const finding = value as Record<string, unknown>;
    const ruleId = String(finding.rule_id ?? "").trim();
    const field = String(finding.field ?? "").trim();
    if (!ruleId || !field) return null;
    return {
      ruleId,
      category: String(finding.category ?? "").trim(),
      severity: String(finding.severity ?? "").trim(),
      blocking: finding.blocking === true,
      field,
      line: Math.max(1, Math.trunc(Number(finding.line) || 1)),
      column: Math.max(1, Math.trunc(Number(finding.column) || 1)),
    };
  }).filter((finding): finding is NonNullable<typeof finding> => Boolean(finding));
  if (findings.length !== row.findings.length) return null;
  return {
    scannerVersion: row.scanner_version,
    hasFindings: row.has_findings,
    shouldBlock: row.should_block,
    findings,
  };
}

export function normalizePortablePackagePreview(value: unknown): PortablePackagePreviewModel | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const kind = row.kind;
  const name = String(row.title ?? "").trim();
  const artifactId = String(row.artifact_id ?? "").trim();
  const releaseVersion = String(row.release_version ?? "").trim();
  const permissionMode = row.recommended_permission_mode;
  const scanReport = normalizeScanReport(row.scan_report);
  if (
    row.schema_version !== 2
    || (kind !== "expert" && kind !== "group")
    || !name
    || !artifactId
    || !releaseVersion
    || (permissionMode !== "plan" && permissionMode !== "ask" && permissionMode !== "auto")
    || !scanReport
  ) return null;
  const memberNames = stringList(row.member_names);
  const memberRoles = Array.isArray(row.member_roles) ? row.member_roles.map((item) => String(item ?? "").trim()) : [];
  const memberPrompts = Array.isArray(row.member_system_prompts)
    ? row.member_system_prompts.map((item) => String(item ?? "").trim())
    : [];
  const rawCount = Number(row.member_count);
  const memberCount = Number.isSafeInteger(rawCount) ? rawCount : -1;
  if (
    (kind === "expert" && (memberCount !== 0 || memberNames.length > 0))
    || (kind === "group" && (
      memberCount < 1
      || memberNames.length !== memberCount
      || memberRoles.length !== memberCount
      || memberPrompts.length !== memberCount
    ))
  ) return null;
  const members = memberNames.map((memberName, index) => ({
    name: memberName,
    role: memberRoles[index] || "",
    systemPrompt: memberPrompts[index] || "",
  }));
  return {
    schemaVersion: 2,
    artifactId,
    releaseVersion,
    kind,
    name,
    description: String(row.description ?? "").trim(),
    summary: String(row.summary ?? "").trim(),
    byteSize: Math.max(0, Math.trunc(Number(row.byte_size) || 0)),
    recommendedPermissionMode: permissionMode,
    skillDependencies: stringList(row.skill_dependencies),
    mcpDependencies: stringList(row.mcp_dependencies),
    resourcePaths: stringList(row.resource_paths),
    workspaceSlots: stringList(row.workspace_slots),
    scanReport,
    systemPrompt: String(row.system_prompt ?? "").trim(),
    memberCount,
    members,
  };
}

export async function choosePortablePackageFile(
  kind: "expert" | "group",
): Promise<PortablePackageSelection> {
  try {
    const result = await window.agenticxDesktop.inspectPortablePackageFile({ kind });
    if (result.canceled) return { status: "canceled" };
    if (!result.ok) {
      return { status: "error", error: result.error || "无法读取分享包。" };
    }
    const preview = normalizePortablePackagePreview(result.preview);
    const raw = typeof result.raw === "string" ? result.raw : "";
    const confirmationToken = String(result.confirmationToken ?? "").trim();
    if (!preview || preview.kind !== kind || !raw || !confirmationToken) {
      return { status: "error", error: "分享包预览信息不完整或类型不匹配。" };
    }
    return {
      status: "selected",
      candidate: { raw, confirmationToken, preview, filePath: result.filePath },
    };
  } catch (error) {
    return {
      status: "error",
      error: error instanceof Error ? error.message : "无法读取分享包。",
    };
  }
}

function displayFileName(filePath?: string): string {
  return String(filePath ?? "").split(/[\\/]/).filter(Boolean).at(-1) ?? "";
}

function permissionModeLabel(mode: PortablePackagePreviewModel["recommendedPermissionMode"]): string {
  if (mode === "plan") return "仅规划（Plan）";
  if (mode === "auto") return "自动执行（Auto）";
  return "执行前确认（Ask）";
}

export function PortablePackageImportDialog({
  candidate,
  onClose,
  onImported,
}: {
  candidate: PortablePackageCandidate | null;
  onClose: () => void;
  onImported?: (result: PortablePackageImportOutcome) => void | Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const preview = candidate?.preview;
  const fileName = useMemo(() => displayFileName(candidate?.filePath), [candidate?.filePath]);
  const sourceLabel = candidate?.sourceLabel || fileName || "共享配置包";

  useEffect(() => {
    setBusy(false);
    setError("");
  }, [candidate]);

  if (!candidate || !preview) return null;

  const handleImport = async () => {
    if (busy || preview.scanReport.shouldBlock) return;
    setBusy(true);
    setError("");
    try {
      const result = await window.agenticxDesktop.importPortablePackage({
        raw: candidate.raw,
        confirmationToken: candidate.confirmationToken,
      });
      if (!result.ok) throw new Error(result.error || "导入失败，请稍后重试。");
      const importedKind = result.kind ?? preview.kind;
      window.dispatchEvent(
        new CustomEvent("agenticx:avatars:changed", { detail: { openPane: false } }),
      );
      if (importedKind === "group") {
        window.dispatchEvent(new CustomEvent("agenticx:groups:changed"));
      }
      await onImported?.(result);
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "导入失败，请稍后重试。");
    } finally {
      setBusy(false);
    }
  };

  const isGroup = preview.kind === "group";
  const Icon = isGroup ? UsersRound : Bot;
  const dependencyCount = preview.skillDependencies.length + preview.mcpDependencies.length;

  return (
    <Modal
      open
      title={isGroup ? "导入项目群聊" : "导入数字专家"}
      onClose={() => {
        if (!busy) onClose();
      }}
      panelClassName="w-[min(620px,94vw)] max-h-[calc(100vh-2rem)] overflow-hidden bg-surface-panel"
      footer={
        <div className="flex justify-end gap-2">
          <button
            type="button"
            disabled={busy}
            className="rounded-md border border-border px-3 py-2 text-xs text-text-muted transition hover:bg-surface-hover hover:text-text-strong disabled:opacity-50"
            onClick={onClose}
          >
            取消
          </button>
          <button
            type="button"
            disabled={busy || preview.scanReport.shouldBlock}
            className="inline-flex min-w-[104px] items-center justify-center gap-1.5 rounded-md bg-btnPrimary px-4 py-2 text-xs font-medium text-btnPrimary-text transition hover:bg-btnPrimary-hover disabled:cursor-not-allowed disabled:opacity-50"
            onClick={() => void handleImport()}
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
            {busy ? "正在导入…" : "确认导入"}
          </button>
        </div>
      }
    >
      <div className="max-h-[calc(100vh-13rem)] space-y-4 overflow-y-auto pr-1">
        <div className="flex items-start gap-3 rounded-xl border border-border bg-surface-card p-4">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-surface-panel text-text-muted">
            <Icon className="h-5 w-5" aria-hidden />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <div className="break-words text-sm font-semibold text-text-strong">{preview.name}</div>
              <span className="rounded-full border border-border bg-surface-panel px-2 py-0.5 font-mono text-[10px] text-text-faint">
                v{preview.releaseVersion}
              </span>
            </div>
            {preview.description ? (
              <p className="mt-1 break-words text-xs leading-relaxed text-text-muted">{preview.description}</p>
            ) : null}
            <div className="mt-2 text-[11px] text-text-faint">
              {isGroup
                ? `将创建 1 个项目群聊和 ${preview.memberCount} 个全新数字专家`
                : "将创建 1 个全新数字专家"}
              {` · ${sourceLabel}`}
            </div>
            <div className="mt-1 break-all font-mono text-[10px] text-text-faint">
              {preview.artifactId}
            </div>
          </div>
        </div>

        {isGroup && preview.members.length > 0 ? (
          <div>
            <div className="mb-2 text-xs font-medium text-text-strong">将创建的群成员</div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {preview.members.map((member, index) => (
                <div
                  key={`${member.name}-${index}`}
                  className="rounded-lg border border-border bg-surface-card px-3 py-2.5"
                >
                  <div className="truncate text-xs font-medium text-text-strong">{member.name}</div>
                  {member.role ? (
                    <div className="mt-0.5 truncate text-[11px] text-text-faint">{member.role}</div>
                  ) : null}
                  <details className="mt-2 text-[11px] text-text-muted">
                    <summary className="cursor-pointer select-none text-text-faint hover:text-text-strong">
                      查看行为指令
                    </summary>
                    <div className="mt-1.5 max-h-32 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-surface-panel p-2 font-mono leading-relaxed">
                      {member.systemPrompt || "未设置额外行为指令"}
                    </div>
                  </details>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {!isGroup ? (
          <details className="rounded-lg border border-border bg-surface-card px-3 py-2.5 text-xs text-text-muted">
            <summary className="cursor-pointer select-none font-medium text-text-strong">
              查看将导入的行为指令
            </summary>
            <div className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-surface-panel p-2.5 font-mono text-[11px] leading-relaxed">
              {preview.systemPrompt || "未设置额外行为指令"}
            </div>
          </details>
        ) : null}

        <div className="grid gap-2 sm:grid-cols-2">
          <div className="rounded-lg border border-border bg-surface-card px-3 py-2.5">
            <div className="flex items-center gap-1.5 text-xs font-medium text-text-strong">
              <ShieldCheck className="h-3.5 w-3.5 text-text-subtle" aria-hidden />
              建议运行权限
            </div>
            <div className="mt-1.5 text-[11px] text-text-muted">
              {permissionModeLabel(preview.recommendedPermissionMode)}
            </div>
            <p className="mt-1 text-[10px] leading-relaxed text-text-faint">
              仅供参考；导入不会授予 Auto，也不会绕过确认闸和企业策略。
            </p>
          </div>
          <div className="rounded-lg border border-border bg-surface-card px-3 py-2.5">
            <div className="flex items-center gap-1.5 text-xs font-medium text-text-strong">
              <PackageCheck className="h-3.5 w-3.5 text-text-subtle" aria-hidden />
              Skill / MCP 依赖
            </div>
            <div className="mt-1.5 text-[11px] text-text-muted">
              {dependencyCount > 0 ? `${dependencyCount} 项必需能力引用` : "未声明额外能力"}
            </div>
            <p className="mt-1 text-[10px] leading-relaxed text-text-faint">
              依赖只作校验与绑定，不包含密钥，也不会自动授予能力。
            </p>
          </div>
        </div>

        {dependencyCount > 0 ? (
          <details className="rounded-lg border border-border bg-surface-card px-3 py-2.5 text-xs text-text-muted">
            <summary className="cursor-pointer select-none font-medium text-text-strong">
              查看必需 Skill / MCP
            </summary>
            <div className="mt-2 space-y-2">
              {preview.skillDependencies.length > 0 ? (
                <div>
                  <div className="text-[10px] font-medium uppercase tracking-wide text-text-faint">Skills</div>
                  <div className="mt-1 space-y-1">
                    {preview.skillDependencies.map((dependency) => (
                      <div key={dependency} className="break-all rounded bg-surface-panel px-2 py-1 font-mono text-[10px]">
                        {dependency}
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
              {preview.mcpDependencies.length > 0 ? (
                <div>
                  <div className="text-[10px] font-medium uppercase tracking-wide text-text-faint">MCP</div>
                  <div className="mt-1 space-y-1">
                    {preview.mcpDependencies.map((dependency) => (
                      <div key={dependency} className="break-all rounded bg-surface-panel px-2 py-1 font-mono text-[10px]">
                        {dependency}
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          </details>
        ) : null}

        {(preview.resourcePaths.length > 0 || preview.workspaceSlots.length > 0) ? (
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="rounded-lg border border-border bg-surface-card px-3 py-2.5">
              <div className="flex items-center gap-1.5 text-xs font-medium text-text-strong">
                <FileText className="h-3.5 w-3.5 text-text-subtle" aria-hidden />
                包内专家文档
              </div>
              {preview.resourcePaths.length > 0 ? (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {preview.resourcePaths.map((path) => (
                    <span key={path} className="rounded bg-surface-panel px-2 py-1 font-mono text-[10px] text-text-muted">
                      {path}
                    </span>
                  ))}
                </div>
              ) : (
                <p className="mt-1.5 text-[11px] text-text-faint">未包含专家文档</p>
              )}
              <p className="mt-2 text-[10px] leading-relaxed text-text-faint">
                将安装到隔离的 package_resources，作为只读包基线注入；不会覆盖本机 MEMORY。
              </p>
            </div>
            <div className="rounded-lg border border-border bg-surface-card px-3 py-2.5">
              <div className="flex items-center gap-1.5 text-xs font-medium text-text-strong">
                <FolderKanban className="h-3.5 w-3.5 text-text-subtle" aria-hidden />
                工作区绑定请求
              </div>
              {preview.workspaceSlots.length > 0 ? (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {preview.workspaceSlots.map((slot) => (
                    <span key={slot} className="rounded bg-surface-panel px-2 py-1 font-mono text-[10px] text-text-muted">
                      {slot}
                    </span>
                  ))}
                </div>
              ) : (
                <p className="mt-1.5 text-[11px] text-text-faint">无需绑定工作区</p>
              )}
              <p className="mt-2 text-[10px] leading-relaxed text-text-faint">
                分享包不携带发布者路径；逻辑插槽必须由你或管理员另行绑定。
              </p>
            </div>
          </div>
        ) : null}

        {preview.scanReport.hasFindings ? (
          <div className={`rounded-lg border px-3 py-2.5 ${
            preview.scanReport.shouldBlock
              ? "border-rose-500/35 bg-rose-500/10"
              : "border-amber-500/30 bg-amber-500/10"
          }`}>
            <div className="flex items-start gap-2">
              <AlertTriangle className={`mt-0.5 h-4 w-4 shrink-0 ${
                preview.scanReport.shouldBlock ? "text-rose-300" : "text-amber-300"
              }`} aria-hidden />
              <div className="min-w-0">
                <div className="text-xs font-medium text-text-strong">
                  {preview.scanReport.shouldBlock ? "敏感信息扫描已阻止导入" : "敏感信息扫描有待核对项"}
                </div>
                <div className="mt-1 space-y-1 font-mono text-[10px] text-text-muted">
                  {preview.scanReport.findings.slice(0, 12).map((finding, index) => (
                    <div key={`${finding.ruleId}-${finding.field}-${index}`} className="break-all">
                      {finding.ruleId} · {finding.field}:{finding.line}
                    </div>
                  ))}
                </div>
                <p className="mt-1.5 text-[10px] leading-relaxed text-text-faint">
                  扫描报告只显示规则和位置，不回显命中的敏感原文。
                </p>
              </div>
            </div>
          </div>
        ) : null}

        <div className="flex gap-2.5 rounded-lg border border-emerald-500/25 bg-emerald-500/[0.08] px-3 py-2.5">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" aria-hidden />
          <div className="text-xs leading-relaxed text-text-muted">
            <div className="font-medium text-text-strong">导入受控的可复用配置</div>
            <p className="mt-0.5">
              不会导入聊天记录、发布者绝对路径、模型凭据或 Skill/MCP 密钥。本地标识与工作区会重新创建；
              所选 MD 只作为隔离的只读包基线，能力依赖不会自行安装或授权。行为指令来自分享者，请在导入前核对。
            </p>
          </div>
        </div>

        {error ? (
          <div
            role="alert"
            className="rounded-lg border border-rose-500/35 bg-rose-500/10 px-3 py-2 text-xs leading-relaxed text-rose-300"
          >
            {error}
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
