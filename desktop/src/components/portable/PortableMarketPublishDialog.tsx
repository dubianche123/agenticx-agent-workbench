import { useEffect, useMemo, useState } from "react";
import {
  Building2,
  FileText,
  FolderKanban,
  Loader2,
  LockKeyhole,
  PackageCheck,
  Search,
  ShieldCheck,
  UserRound,
  UsersRound,
  X,
} from "lucide-react";

import type { EnterpriseCapabilityLike } from "../../../shared/enterprise-capability-market";
import { useAppStore } from "../../store";
import { Modal } from "../ds/Modal";

export type PortableMarketPublishTarget = {
  kind: "expert" | "group" | "skill";
  id: string;
  name: string;
  currentVersion?: string;
  /** Exact identity from /api/skills; required when same-name variants exist. */
  skillId?: string;
  contentHash?: string;
};

export type VisibilityType = "company" | "departments" | "users" | "personal" | "admins_only";
type AudienceDepartment = { id: string; name: string; path: string };
type AudienceUser = {
  id: string;
  displayName: string;
  email: string;
  deptId: string | null;
};
type PortableMarketSecurityFinding = {
  code: string;
  field: string;
  category: "secret" | "pii";
  line?: number;
  column?: number;
  severity?: string;
};

type Props = {
  target: PortableMarketPublishTarget | null;
  onClose: () => void;
  onPublished: (
    target: PortableMarketPublishTarget,
    result:
      | Awaited<ReturnType<Window["agenticxDesktop"]["publishPortablePackageToMarket"]>>
      | Awaited<ReturnType<Window["agenticxDesktop"]["publishSkillToMarket"]>>,
  ) => void | Promise<void>;
};

const MAX_AUDIENCE_IDS = 64;
const MAX_RELEASE_NOTES_LENGTH = 4_000;
const MANUAL_ONLY_SECURITY_CODES = new Set(["unclassified_secret", "unclassified_pii"]);
const SEMVER_RE = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const CAPABILITY_ID_RE = /^(skill|mcp):([0-9A-HJKMNP-TV-Z]{26})$/iu;
const SHA256_RE = /^[a-f0-9]{64}$/u;

/** Audience IDs are required only for targeted employee visibility. An
 * admins-only submission is complete without selecting a department/user. */
export function isPortableMarketVisibilityReady(
  visibility: VisibilityType,
  selectedCount: number,
): boolean {
  return visibility === "company"
    || visibility === "personal"
    || visibility === "admins_only"
    || selectedCount > 0;
}

export type PortablePublishDependency = {
  id: string;
  kind: "skill" | "mcp";
  name: string;
  version: string;
  digest?: string;
};

function canonicalSemver(value: unknown): string {
  const version = String(value ?? "").trim();
  return version.length <= 64 && SEMVER_RE.test(version) ? version : "1.0.0";
}

export function listPortablePublishDependencies(
  capabilities: readonly EnterpriseCapabilityLike[],
): PortablePublishDependency[] {
  const dependencies: PortablePublishDependency[] = [];
  const seen = new Set<string>();
  for (const capability of capabilities) {
    const match = CAPABILITY_ID_RE.exec(String(capability.id ?? "").trim());
    if (!match || match[1].toLocaleLowerCase() !== capability.kind) continue;
    const id = `${capability.kind}:${match[2].toUpperCase()}`;
    if (seen.has(id)) continue;
    const digest = String(capability.bundleDigest ?? "").trim().toLocaleLowerCase();
    if (capability.kind === "skill" && !SHA256_RE.test(digest)) continue;
    seen.add(id);
    dependencies.push({
      id,
      kind: capability.kind,
      name: capability.displayName || capability.name || id,
      version: canonicalSemver(capability.version),
      ...(capability.kind === "skill" ? { digest } : {}),
    });
  }
  return dependencies.sort((left, right) => (
    left.kind.localeCompare(right.kind) || left.name.localeCompare(right.name)
  ));
}

export function mergeAudienceOptionsById<T extends { id: string }>(current: T[], incoming: T[]): T[] {
  const merged = new Map(current.map((item) => [item.id, item]));
  for (const item of incoming) merged.set(item.id, item);
  return [...merged.values()];
}

function toggleId(current: string[], id: string): string[] {
  return current.includes(id)
    ? current.filter((candidate) => candidate !== id)
    : current.length < MAX_AUDIENCE_IDS
      ? [...current, id]
      : current;
}

export function PortableMarketPublishDialog({ target, onClose, onPublished }: Props) {
  const enterpriseCapabilities = useAppStore((state) => state.userAccount.capabilities);
  const [visibility, setVisibility] = useState<VisibilityType>("company");
  const [departments, setDepartments] = useState<AudienceDepartment[]>([]);
  const [users, setUsers] = useState<AudienceUser[]>([]);
  const [knownDepartments, setKnownDepartments] = useState<AudienceDepartment[]>([]);
  const [knownUsers, setKnownUsers] = useState<AudienceUser[]>([]);
  const [selectedDepartmentIds, setSelectedDepartmentIds] = useState<string[]>([]);
  const [selectedUserIds, setSelectedUserIds] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [releaseVersion, setReleaseVersion] = useState("1.0.0");
  const [releaseNotes, setReleaseNotes] = useState("");
  const [permissionMode, setPermissionMode] = useState<PortablePackagePermissionMode>("ask");
  const [resourceFiles, setResourceFiles] = useState<Array<"IDENTITY.md" | "SOUL.md" | "MEMORY.md">>([
    "IDENTITY.md",
  ]);
  const [selectedDependencyIds, setSelectedDependencyIds] = useState<string[]>([]);
  const [includeProjectRoot, setIncludeProjectRoot] = useState(false);
  const [projectRootAccess, setProjectRootAccess] = useState<"read-only" | "read-write">("read-only");
  const [loadingAudience, setLoadingAudience] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [securityFindings, setSecurityFindings] = useState<PortableMarketSecurityFinding[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!target) return;
    setVisibility("company");
    setDepartments([]);
    setUsers([]);
    setKnownDepartments([]);
    setKnownUsers([]);
    setSelectedDepartmentIds([]);
    setSelectedUserIds([]);
    setQuery("");
    setReleaseVersion(
      target.kind === "skill" && !target.currentVersion
        ? ""
        : canonicalSemver(target.currentVersion),
    );
    setReleaseNotes("");
    setPermissionMode("ask");
    setResourceFiles(["IDENTITY.md"]);
    setSelectedDependencyIds([]);
    setIncludeProjectRoot(false);
    setProjectRootAccess("read-only");
    setSubmitting(false);
    setSecurityFindings(null);
    setError("");
  }, [target]);

  useEffect(() => {
    if (!target) return;
    let cancelled = false;
    const timeout = window.setTimeout(() => {
      setLoadingAudience(true);
      void window.agenticxDesktop
        .listPortableMarketAudience({ query: query.trim() })
        .then((result) => {
          if (cancelled) return;
          if (!result.ok) {
            setError(result.error || "无法加载企业通讯录。仍可选择全公司发布。");
            return;
          }
          setDepartments(result.departments);
          setUsers(result.users);
          setKnownDepartments((current) => mergeAudienceOptionsById(current, result.departments));
          setKnownUsers((current) => mergeAudienceOptionsById(current, result.users));
          setError("");
        })
        .catch((caught) => {
          if (!cancelled) {
            setError(caught instanceof Error ? caught.message : "无法加载企业通讯录。");
          }
        })
        .finally(() => {
          if (!cancelled) setLoadingAudience(false);
        });
    }, query ? 250 : 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [query, target]);

  const selectedCount = visibility === "departments"
    ? selectedDepartmentIds.length
    : visibility === "users"
      ? selectedUserIds.length
      : 0;
  const releaseVersionValid = target?.kind === "skill"
    ? (!releaseVersion.trim() || (SEMVER_RE.test(releaseVersion.trim()) && releaseVersion.trim().length <= 64))
    : (SEMVER_RE.test(releaseVersion.trim()) && releaseVersion.trim().length <= 64);
  const canPublish = Boolean(target)
    && !submitting
    && releaseVersionValid
    && releaseNotes.length <= MAX_RELEASE_NOTES_LENGTH
    && isPortableMarketVisibilityReady(visibility, selectedCount);

  const availableDependencies = useMemo(
    () => listPortablePublishDependencies(enterpriseCapabilities),
    [enterpriseCapabilities],
  );
  const selectedDependencies = useMemo(
    () => availableDependencies.filter((dependency) => selectedDependencyIds.includes(dependency.id)),
    [availableDependencies, selectedDependencyIds],
  );

  const departmentLabelById = useMemo(
    () => new Map(knownDepartments.map((department) => [department.id, department.path || department.name])),
    [knownDepartments],
  );
  const userLabelById = useMemo(
    () => new Map(knownUsers.map((user) => [user.id, `${user.displayName} · ${user.email}`])),
    [knownUsers],
  );

  if (!target) return null;

  const publish = async (securityAction: "none" | "redact" = "none") => {
    if (!canPublish) return;
    setSubmitting(true);
    if (securityAction === "none") setError("");
    try {
      const audience = {
        type: visibility,
        departmentIds: visibility === "departments" ? selectedDepartmentIds : [],
        userIds: visibility === "users" ? selectedUserIds : [],
      } as const;
      const result = target.kind === "skill"
        ? await window.agenticxDesktop.publishSkillToMarket({
            name: target.id,
            ...(releaseVersion.trim() ? { release_version: releaseVersion.trim() } : {}),
            ...(target.skillId ? { skill_id: target.skillId } : {}),
            ...(target.contentHash ? { content_hash: target.contentHash } : {}),
            release_notes: releaseNotes.trim(),
            ...(securityAction === "redact"
              ? {
                  security_action: "redact" as const,
                  security_findings: securityFindings ?? [],
                }
              : {}),
            visibility: audience,
          })
        : await window.agenticxDesktop.publishPortablePackageToMarket({
            kind: target.kind,
            id: target.id,
            release_version: releaseVersion.trim(),
            release_notes: releaseNotes.trim(),
            recommended_permission_mode: permissionMode,
            dependencies: {
              skills: selectedDependencies
                .filter((dependency) => dependency.kind === "skill")
                .map((dependency) => ({
                  capability_id: dependency.id,
                  version: dependency.version,
                  digest: dependency.digest || "",
                  required: true,
                })),
              mcps: selectedDependencies
                .filter((dependency) => dependency.kind === "mcp")
                .map((dependency) => ({
                  capability_id: dependency.id,
                  version: dependency.version,
                  required: true,
                })),
            },
            resource_files: resourceFiles,
            workspace_slots: includeProjectRoot
              ? [{
                  name: "project_root",
                  access: projectRootAccess,
                  // A published package may describe an optional mount point, but
                  // never carries or requires the publisher's local directory.
                  required: false,
                }]
              : [],
            ...(securityAction === "redact"
              ? {
                  security_action: "redact" as const,
                  security_findings: securityFindings ?? [],
                }
              : {}),
            visibility: audience,
          });
      if (!result.ok) {
        if (result.securityFindings && result.securityFindings.length > 0) {
          setSecurityFindings(result.securityFindings);
          return;
        }
        throw new Error(result.error || "发布到公司市场失败，请稍后重试。");
      }
      await onPublished(target, result);
      setSecurityFindings(null);
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "发布到公司市场失败，请稍后重试。");
    } finally {
      setSubmitting(false);
    }
  };

  const securityFindingLabel = (finding: PortableMarketSecurityFinding): string => {
    const labels: Record<string, string> = {
      private_key: "私钥",
      openai_key: "OpenAI API Key",
      anthropic_key: "Anthropic API Key",
      github_token: "GitHub Token",
      stripe_key: "Stripe Key",
      slack_token: "Slack Token",
      slack_webhook: "Slack Webhook",
      gcp_service_account: "GCP 服务账号",
      azure_connection_string: "Azure 连接字符串",
      aws_access_key: "AWS Access Key",
      google_api_key: "Google API Key",
      jwt: "JWT Token",
      bearer_token: "Bearer Token",
      basic_auth: "Basic 凭据",
      assigned_secret: "配置项密钥",
      credential_url: "带凭据的链接",
      email: "邮箱地址",
      cn_phone: "手机号码",
      cn_identity: "身份证号",
      bank_card: "银行卡号",
      unclassified_secret: "未分类敏感密钥",
      unclassified_pii: "未分类敏感信息",
    };
    return labels[finding.code] || finding.code;
  };

  const securityFieldLabel = (field: string): string => {
    if (field === "release_notes") return "版本说明";
    return field
      .replace(/^manifest\.payload\.members\[(\d+)\]/u, "成员 $1")
      .replace(/^manifest\.payload\./u, "专家配置 · ")
      .replace(/^manifest\.resources\[(\d+)\]\.content$/u, "发布文档 $1 · 内容")
      .replace(/^manifest\.resources\[(\d+)\]\.path$/u, "发布文档 $1 · 文件名")
      .replace(/^manifest\./u, "配置 · ");
  };

  const targetLabel = target.kind === "expert"
    ? "数字专家"
    : target.kind === "group"
      ? "项目群聊"
      : "Skill";
  const hasManualOnlyFinding = (securityFindings ?? [])
    .some((finding) => MANUAL_ONLY_SECURITY_CODES.has(finding.code));

  return (
    <>
      <Modal
        open
        title={`发布${targetLabel}到公司市场`}
        onClose={() => {
          if (!submitting) onClose();
        }}
        panelClassName="w-[min(620px,94vw)] max-h-[calc(100vh-2rem)] overflow-hidden bg-surface-panel"
        footer={
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            disabled={submitting}
            className="rounded-md border border-border px-3 py-2 text-xs text-text-muted transition hover:bg-surface-hover hover:text-text-strong disabled:opacity-50"
            onClick={onClose}
          >
            取消
          </button>
          <button
            type="button"
            disabled={!canPublish}
            className="inline-flex min-w-[112px] items-center justify-center gap-1.5 rounded-md bg-btnPrimary px-4 py-2 text-xs font-medium text-btnPrimary-text transition hover:bg-btnPrimary-hover disabled:cursor-not-allowed disabled:opacity-50"
            onClick={() => void publish()}
          >
            {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
            {submitting ? "正在发布…" : "确认发布"}
          </button>
        </div>
        }
      >
      <div className="max-h-[calc(100vh-13rem)] space-y-4 overflow-y-auto pr-1">
        <div className="rounded-xl border border-border bg-surface-card px-4 py-3">
          <div className="text-sm font-semibold text-text-strong">{target.name}</div>
          <p className="mt-1 text-xs leading-relaxed text-text-muted">
            选择谁能在公司市场中看到并主动导入副本。发布不会自动下发；管理员能力包是独立流程，如需管理员审核后强制下发，可选择“仅提交管理员”。
          </p>
        </div>

        <div className="rounded-xl border border-border bg-surface-card p-3.5">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="text-xs font-medium text-text-strong">发布版本</span>
              <input
                value={releaseVersion}
                onChange={(event) => {
                  setReleaseVersion(event.target.value);
                  setError("");
                }}
                className="mt-1.5 h-9 w-full rounded-lg border border-border bg-surface-panel px-3 font-mono text-xs text-text-primary outline-none"
                placeholder="1.0.0"
                aria-label="发布版本"
                autoCapitalize="off"
                autoCorrect="off"
              />
              <span className="mt-1 block text-[11px] leading-relaxed text-text-faint">
                {target.kind === "skill"
                  ? "可留空自动递增补丁版本；也可输入 SemVer。已有版本不可覆盖。"
                  : "使用 SemVer；已有版本不可覆盖，迭代时请提升版本号。"}
              </span>
            </label>
            <label className="block">
              <span className="text-xs font-medium text-text-strong">建议运行权限</span>
              <select
                value={permissionMode}
                onChange={(event) => setPermissionMode(event.target.value as PortablePackagePermissionMode)}
                className="mt-1.5 h-9 w-full rounded-lg border border-border bg-surface-panel px-3 text-xs text-text-primary outline-none"
                aria-label="建议运行权限"
              >
                <option value="plan">仅规划（Plan）</option>
                <option value="ask">执行前确认（Ask）</option>
                <option value="auto">自动执行（Auto）</option>
              </select>
              <span className="mt-1 block text-[11px] leading-relaxed text-text-faint">
                这只是推荐值，不会授予权限，也不能绕过本机或企业策略。
              </span>
            </label>
          </div>
          {!releaseVersionValid ? (
            <p className="mt-2 text-xs text-amber-400">请输入合法的 SemVer，例如 1.1.0。</p>
          ) : null}
          <label className="mt-3 block">
            <span className="flex items-center justify-between gap-2 text-xs font-medium text-text-strong">
              <span>版本说明</span>
              <span className="font-normal tabular-nums text-text-faint">
                {releaseNotes.length}/{MAX_RELEASE_NOTES_LENGTH}
              </span>
            </span>
            <textarea
              value={releaseNotes}
              onChange={(event) => setReleaseNotes(event.target.value)}
              className="mt-1.5 min-h-20 w-full resize-y rounded-lg border border-border bg-surface-panel px-3 py-2 text-xs leading-relaxed text-text-primary outline-none placeholder:text-text-faint"
              placeholder="说明本次新增、修正或适用场景（可选）"
              aria-label="版本说明"
            />
          </label>
        </div>

        {target.kind !== "skill" ? <details open className="rounded-xl border border-border bg-surface-card p-3.5">
          <summary className="cursor-pointer select-none text-xs font-medium text-text-strong">
            发布内容与运行依赖
          </summary>
          <div className="mt-3 space-y-4">
            <div>
              <div className="flex items-center gap-1.5 text-xs font-medium text-text-strong">
                <FileText className="h-3.5 w-3.5 text-text-subtle" aria-hidden />
                随包发布的专家文档
              </div>
              <p className="mt-1 text-[11px] leading-relaxed text-text-faint">
                Studio 只从该专家的规范工作区读取所选文件，并在发布前扫描 API Key、银行卡号等明显敏感信息。可全部不选。
              </p>
              <div className="mt-2 grid gap-2 sm:grid-cols-3">
                {(["IDENTITY.md", "SOUL.md", "MEMORY.md"] as const).map((file) => (
                  <label key={file} className="flex cursor-pointer items-center gap-2 rounded-lg border border-border bg-surface-panel px-2.5 py-2 text-[11px] text-text-muted">
                    <input
                      type="checkbox"
                      checked={resourceFiles.includes(file)}
                      onChange={(event) => setResourceFiles((current) => (
                        event.target.checked
                          ? [...current.filter((item) => item !== file), file]
                          : current.filter((item) => item !== file)
                      ))}
                    />
                    <span className="font-mono">{file}</span>
                  </label>
                ))}
              </div>
              <p className="mt-1.5 text-[11px] leading-relaxed text-text-faint">
                接收方会把这些内容安装为隔离的只读包基线，不会覆盖其本地 MEMORY。
              </p>
            </div>

            <div className="border-t border-border pt-3">
              <div className="flex items-center gap-1.5 text-xs font-medium text-text-strong">
                <PackageCheck className="h-3.5 w-3.5 text-text-subtle" aria-hidden />
                必需 Skill / MCP
              </div>
              <p className="mt-1 text-[11px] leading-relaxed text-text-faint">
                这里只能引用当前企业能力包已分配给你的规范能力。引用不会携带密钥，也不会自行授予接收方能力。
              </p>
              {availableDependencies.length === 0 ? (
                <p className="mt-2 rounded-lg bg-surface-panel px-3 py-2 text-[11px] text-text-faint">
                  当前没有可发布的企业 Skill / MCP，或其版本与摘要信息不完整。
                </p>
              ) : (
                <div className="mt-2 max-h-40 space-y-1 overflow-y-auto rounded-lg border border-border bg-surface-panel p-1.5">
                  {availableDependencies.map((dependency) => (
                    <label key={dependency.id} className="flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-[11px] hover:bg-surface-hover">
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        checked={selectedDependencyIds.includes(dependency.id)}
                        onChange={() => setSelectedDependencyIds((current) => toggleId(current, dependency.id))}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-text-strong">{dependency.name}</span>
                        <span className="block truncate font-mono text-text-faint">
                          {dependency.kind.toUpperCase()} · {dependency.version} · {dependency.id}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              )}
            </div>

            <div className="border-t border-border pt-3">
              <label className="flex cursor-pointer items-start gap-2">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={includeProjectRoot}
                  onChange={(event) => setIncludeProjectRoot(event.target.checked)}
                />
                <span>
                  <span className="flex items-center gap-1.5 text-xs font-medium text-text-strong">
                    <FolderKanban className="h-3.5 w-3.5 text-text-subtle" aria-hidden />
                    提供项目工作区入口（可选）
                  </span>
                  <span className="mt-1 block text-[11px] leading-relaxed text-text-faint">
                    只声明一个名为 project_root 的逻辑插槽，不上传你的本机目录，也不会自动绑定；接收方在安装或运行时自行选择工作区。
                  </span>
                </span>
              </label>
              {includeProjectRoot ? (
                <div className="mt-2 grid gap-2 pl-6 sm:grid-cols-2">
                  <label className="text-[11px] text-text-muted">
                    建议访问级别
                    <select
                      value={projectRootAccess}
                      onChange={(event) => setProjectRootAccess(event.target.value as "read-only" | "read-write")}
                      className="mt-1 h-8 w-full rounded-lg border border-border bg-surface-panel px-2 text-xs text-text-primary outline-none"
                    >
                      <option value="read-only">只读</option>
                      <option value="read-write">读写</option>
                    </select>
                  </label>
                </div>
              ) : null}
            </div>

            <div className="flex gap-2 rounded-lg border border-emerald-500/25 bg-emerald-500/[0.08] px-3 py-2 text-[11px] leading-relaxed text-text-muted">
              <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400" aria-hidden />
              发布端和服务器都会重新校验结构与敏感信息；管理员下发时仍必须在同一能力包中满足所有必需依赖。
            </div>
          </div>
        </details> : (
          <div className="rounded-xl border border-border bg-surface-card px-3.5 py-3 text-[11px] leading-relaxed text-text-faint">
            Skill 市场只发布这一份经过结构校验的 <span className="font-mono">SKILL.md</span>，不会上传本机目录、密钥或其他文件。
          </div>
        )}

        <fieldset className="space-y-2">
          <legend className="mb-2 text-xs font-medium text-text-strong">市场可见范围</legend>
          {([
            ["personal", LockKeyhole, "仅自己", "只有你可见，其他任何人都不会在市场中看到或导入"],
            ["company", Building2, "全公司", "同企业所有成员都能看到并导入"],
            ["departments", UsersRound, "指定部门", "所选部门及其下级部门成员可见"],
            ["users", UserRound, "指定同事", "只有你和所选同事可见"],
            ["admins_only", ShieldCheck, "仅提交管理员", "只提交给企业管理员审核和强制下发，不会出现在员工市场，也不会自动下发"],
          ] as const).map(([type, Icon, label, description]) => (
            <label
              key={type}
              className={`flex cursor-pointer items-start gap-3 rounded-xl border px-3.5 py-3 transition ${
                visibility === type
                  ? "border-[rgba(var(--theme-color-rgb,59,130,246),0.5)] bg-surface-card-strong ring-1 ring-[rgba(var(--theme-color-rgb,59,130,246),0.18)]"
                  : "border-border bg-surface-card hover:bg-surface-hover"
              }`}
            >
              <input
                type="radio"
                name="portable-market-visibility"
                value={type}
                checked={visibility === type}
                onChange={() => {
                  setVisibility(type);
                  setQuery("");
                  setError("");
                }}
                className="mt-1"
              />
              <Icon className="mt-0.5 h-4 w-4 shrink-0 text-text-subtle" aria-hidden />
              <span>
                <span className="block text-xs font-medium text-text-strong">{label}</span>
                <span className="mt-0.5 block text-[11px] leading-relaxed text-text-faint">
                  {description}
                </span>
              </span>
            </label>
          ))}
        </fieldset>

        {visibility === "departments" ? (
          <div className="rounded-xl border border-border bg-surface-card p-3.5">
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-text-strong">选择部门（包含下级）</span>
              <span className="text-[11px] tabular-nums text-text-faint">
                {selectedDepartmentIds.length}/{MAX_AUDIENCE_IDS}
              </span>
            </div>
            <div className="relative mb-2">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-faint" aria-hidden />
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="h-8 w-full rounded-lg border border-border bg-surface-panel pl-8 pr-3 text-xs text-text-primary outline-none placeholder:text-text-faint"
                placeholder="搜索部门名称或路径"
                aria-label="搜索部门"
              />
              {loadingAudience ? (
                <Loader2 className="absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 animate-spin text-text-faint" aria-hidden />
              ) : null}
            </div>
            {loadingAudience && departments.length === 0 ? (
              <div className="flex items-center gap-2 py-4 text-xs text-text-faint">
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                正在加载部门…
              </div>
            ) : departments.length === 0 ? (
              <p className="py-3 text-xs text-text-faint">没有可选择的部门。</p>
            ) : (
              <div className="max-h-56 space-y-1 overflow-y-auto">
                {departments.map((department) => (
                  <label
                    key={department.id}
                    className="flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-xs text-text-muted hover:bg-surface-hover"
                  >
                    <input
                      type="checkbox"
                      checked={selectedDepartmentIds.includes(department.id)}
                      disabled={
                        !selectedDepartmentIds.includes(department.id)
                        && selectedDepartmentIds.length >= MAX_AUDIENCE_IDS
                      }
                      onChange={() => setSelectedDepartmentIds((current) => toggleId(current, department.id))}
                    />
                    <span className="truncate">{department.path || department.name}</span>
                  </label>
                ))}
              </div>
            )}
            {selectedDepartmentIds.length > 0 ? (
              <div className="mt-3 border-t border-border pt-2.5">
                <div className="mb-1.5 text-[11px] font-medium text-text-faint">全部已选部门</div>
                <div className="flex flex-wrap gap-1.5">
                  {selectedDepartmentIds.map((id) => (
                    <span key={id} className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-full bg-surface-panel px-2 py-1 text-[11px] text-text-muted">
                      <span className="min-w-0 flex-1 truncate" title={departmentLabelById.get(id) || id}>
                        {departmentLabelById.get(id) || id}
                      </span>
                      <button
                        type="button"
                        className="shrink-0 rounded-full p-0.5 text-text-faint hover:bg-surface-hover hover:text-text-strong"
                        aria-label={`移除已选部门 ${departmentLabelById.get(id) || id}`}
                        onClick={() => setSelectedDepartmentIds((current) => current.filter((candidate) => candidate !== id))}
                      >
                        <X className="h-3 w-3" aria-hidden />
                      </button>
                    </span>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        ) : null}

        {visibility === "users" ? (
          <div className="rounded-xl border border-border bg-surface-card p-3.5">
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-text-strong">选择同事</span>
              <span className="text-[11px] tabular-nums text-text-faint">
                {selectedUserIds.length}/{MAX_AUDIENCE_IDS}
              </span>
            </div>
            <div className="relative mb-2">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-faint" aria-hidden />
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="h-8 w-full rounded-lg border border-border bg-surface-panel pl-8 pr-3 text-xs text-text-primary outline-none placeholder:text-text-faint"
                placeholder="搜索姓名或邮箱"
                aria-label="搜索同事"
              />
              {loadingAudience ? (
                <Loader2 className="absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 animate-spin text-text-faint" aria-hidden />
              ) : null}
            </div>
            {users.length === 0 ? (
              <p className="py-3 text-xs text-text-faint">没有匹配的同事。</p>
            ) : (
              <div className="max-h-56 space-y-1 overflow-y-auto">
                {users.map((user) => (
                  <label
                    key={user.id}
                    className="flex cursor-pointer items-start gap-2 rounded-lg px-2.5 py-2 text-xs text-text-muted hover:bg-surface-hover"
                  >
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={selectedUserIds.includes(user.id)}
                      disabled={
                        !selectedUserIds.includes(user.id)
                        && selectedUserIds.length >= MAX_AUDIENCE_IDS
                      }
                      onChange={() => setSelectedUserIds((current) => toggleId(current, user.id))}
                    />
                    <span className="min-w-0">
                      <span className="block truncate text-text-strong">{user.displayName}</span>
                      <span className="block truncate text-[11px] text-text-faint">{user.email}</span>
                    </span>
                  </label>
                ))}
              </div>
            )}
            {selectedUserIds.length > 0 ? (
              <div className="mt-3 border-t border-border pt-2.5">
                <div className="mb-1.5 text-[11px] font-medium text-text-faint">全部已选同事</div>
                <div className="flex flex-wrap gap-1.5">
                  {selectedUserIds.map((id) => (
                    <span key={id} className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-full bg-surface-panel px-2 py-1 text-[11px] text-text-muted">
                      <span className="min-w-0 flex-1 truncate" title={userLabelById.get(id) || id}>
                        {userLabelById.get(id) || id}
                      </span>
                      <button
                        type="button"
                        className="shrink-0 rounded-full p-0.5 text-text-faint hover:bg-surface-hover hover:text-text-strong"
                        aria-label={`移除已选同事 ${userLabelById.get(id) || id}`}
                        onClick={() => setSelectedUserIds((current) => current.filter((candidate) => candidate !== id))}
                      >
                        <X className="h-3 w-3" aria-hidden />
                      </button>
                    </span>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        ) : null}

        {(
          (visibility === "departments" || visibility === "users")
          && selectedCount === 0
        ) ? (
          <p className="text-xs text-amber-400">请至少选择一个部门或一位同事。</p>
        ) : null}
        {error ? (
          <div role="alert" className="rounded-lg border border-rose-500/35 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
            {error}
          </div>
        ) : null}
      </div>
      </Modal>

      <Modal
      open={Boolean(securityFindings)}
      title="发布前发现敏感信息"
      onClose={() => {
        if (!submitting) setSecurityFindings(null);
      }}
      panelClassName="w-[min(520px,94vw)] max-h-[calc(100vh-2rem)] overflow-hidden bg-surface-panel"
      footer={
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            disabled={submitting}
            className="rounded-md border border-border px-3 py-2 text-xs text-text-muted transition hover:bg-surface-hover hover:text-text-strong disabled:opacity-50"
            onClick={() => {
              setSecurityFindings(null);
              onClose();
            }}
          >
            暂不发布
          </button>
          <button
            type="button"
            disabled={submitting || hasManualOnlyFinding}
            className="inline-flex min-w-[148px] items-center justify-center gap-1.5 rounded-md bg-btnPrimary px-4 py-2 text-xs font-medium text-btnPrimary-text transition hover:bg-btnPrimary-hover disabled:cursor-not-allowed disabled:opacity-50"
            onClick={() => void publish("redact")}
          >
            {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
            {hasManualOnlyFinding ? "请手工修改后发布" : "自动去除后发布"}
          </button>
        </div>
      }
    >
      <div className="space-y-3">
        <div className="flex gap-2 rounded-lg border border-amber-500/30 bg-amber-500/[0.08] px-3 py-2.5 text-xs leading-relaxed text-text-muted">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" aria-hidden />
          <p>
            本次没有发布任何内容。以下仅显示检测类型和位置，不展示敏感原文；你可以先返回修改，也可以让系统只去除这些已检测到的值后重新扫描。
          </p>
        </div>
        <div className="max-h-64 space-y-1.5 overflow-y-auto rounded-lg border border-border bg-surface-card p-2">
          {(securityFindings ?? []).map((finding, index) => (
            <div
              key={`${finding.category}:${finding.code}:${finding.field}:${index}`}
              className="flex items-start justify-between gap-3 rounded-md bg-surface-panel px-3 py-2 text-xs"
            >
              <span className="font-medium text-text-strong">{securityFindingLabel(finding)}</span>
              <span className="min-w-0 truncate text-right text-text-faint" title={finding.field}>
                {securityFieldLabel(finding.field)}
                {finding.line ? ` · 第 ${finding.line} 行` : ""}
                {finding.column ? `，第 ${finding.column} 列` : ""}
              </span>
            </div>
          ))}
        </div>
        <p className="text-[11px] leading-relaxed text-text-faint">
          自动去除后会保留包结构并重新计算文档摘要；如果敏感内容出现在无法安全修改的结构标识中，系统会要求你手工修改。
        </p>
        {hasManualOnlyFinding ? (
          <p className="rounded-lg border border-rose-500/30 bg-rose-500/[0.08] px-3 py-2 text-[11px] leading-relaxed text-rose-300">
            检测到扫描器暂未分类的敏感内容，无法安全自动去除；请返回修改对应内容后再发布。
          </p>
        ) : null}
      </div>
      </Modal>
    </>
  );
}
