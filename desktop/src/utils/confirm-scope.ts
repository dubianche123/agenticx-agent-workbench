import { confirmRiskCategoryCodes } from "./confirm-risk";

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export type ConfirmRunContext = {
  sessionId: string;
  runId: string;
};

export type OpenConfirmHandler = (
  requestId: string,
  question: string,
  diff?: string,
  agentId?: string,
  context?: Record<string, unknown>,
  run?: ConfirmRunContext,
) => Promise<boolean>;

export type EndConfirmRunHandler = (run: ConfirmRunContext) => void;

export function buildConfirmRunKey(run?: ConfirmRunContext): string {
  const sessionId = text(run?.sessionId);
  const runId = text(run?.runId);
  if (!sessionId || !runId) return "";
  return JSON.stringify([sessionId, runId]);
}

export class RunScopedConfirmApprovals {
  private readonly scopesByRun = new Map<string, Set<string>>();

  allows(run: ConfirmRunContext | undefined, scope: string): boolean {
    const runKey = buildConfirmRunKey(run);
    return Boolean(runKey && this.scopesByRun.get(runKey)?.has(scope));
  }

  allow(run: ConfirmRunContext | undefined, scope: string): boolean {
    const runKey = buildConfirmRunKey(run);
    if (!runKey || !scope) return false;
    const scopes = this.scopesByRun.get(runKey) ?? new Set<string>();
    scopes.add(scope);
    this.scopesByRun.set(runKey, scopes);
    return true;
  }

  end(run: ConfirmRunContext | undefined): void {
    const runKey = buildConfirmRunKey(run);
    if (runKey) this.scopesByRun.delete(runKey);
  }

  clear(): void {
    this.scopesByRun.clear();
  }
}

export type NormalizedConfirmRisk = "low" | "protected";

/**
 * Mirror the backend's fail-closed confirmation policy. Only an explicit
 * `risk: "low"` may be auto-approved; missing and future values stay protected.
 */
export function normalizeConfirmRisk(
  context?: Record<string, unknown>,
): NormalizedConfirmRisk {
  return text(context?.risk).toLowerCase() === "low" ? "low" : "protected";
}

export function isProtectedConfirmContext(
  context?: Record<string, unknown>,
): boolean {
  return normalizeConfirmRisk(context) === "protected";
}

export type ProtectedConfirmReuseMode = "none" | "exact-command";

export function protectedConfirmReuseMode(
  context?: Record<string, unknown>,
): ProtectedConfirmReuseMode {
  if (!isProtectedConfirmContext(context)) return "none";
  const tool = text(context?.tool);
  const mode = text(context?.approval_reuse).toLowerCase();
  const permissions = text(context?.sandbox_permissions);
  const cwd = text(context?.cwd);
  const workspaceRoots = Array.isArray(context?.workspace_roots)
    ? context.workspace_roots.map(text).filter(Boolean)
    : [];
  const riskCategories = confirmRiskCategoryCodes(context);
  // 必须与后端 NEVER_AUTO_APPROVED_CATEGORIES 逐字一致（有对账测试）。
  const neverReusableCategories = new Set([
    "destructive_filesystem",
    "external_publish",
    "host_full_access",
    "system_disruption",
  ]);
  if (
    mode === "exact-command" &&
    (tool === "bash_exec" || tool === "bash_bg_start") &&
    text(context?.command) &&
    permissions === "workspace-write" &&
    cwd &&
    workspaceRoots.length > 0 &&
    Array.isArray(context?.risk_categories) &&
    riskCategories.length > 0 &&
    !riskCategories.some((category) => neverReusableCategories.has(category))
  ) {
    return "exact-command";
  }
  return "none";
}

export function canReuseProtectedConfirm(
  context?: Record<string, unknown>,
): boolean {
  return protectedConfirmReuseMode(context) !== "none";
}

/**
 * 后端在受保护请求的 context 里带 `protected_reason`。这里优先用它，取不到才回退到
 * 本地镜像的一张表——理由的唯一出处在后端，risk 将来加一档不用记得同步改两处文案。
 */
const LOCAL_PROTECTED_REASONS: Record<string, string> = {
  high: "这条操作被标记为高风险",
  destructive: "这条操作会删除或覆盖已有内容",
  non_whitelisted: "这条命令不在默认可直接执行的白名单里",
  permission_escalation: "这条命令申请退出工作区写入隔离，可改动主机上的任意文件",
  policy: "这条操作会改动技能或长期记忆等配置",
};
const UNKNOWN_PROTECTED_REASON = "系统无法判定这步的风险，按受保护处理";

export function protectedConfirmReason(
  context?: Record<string, unknown>,
): string {
  if (!isProtectedConfirmContext(context)) return "";
  const fromBackend = text(context?.protected_reason);
  if (fromBackend) return fromBackend;
  return LOCAL_PROTECTED_REASONS[text(context?.risk).toLowerCase()] ?? UNKNOWN_PROTECTED_REASON;
}

/**
 * 这个确认框能不能不弹出来。
 *
 * **只判「本次运行内已经批准过同一范围」这一件事。**「代我批准」这类会话策略不在
 * 这里判——它以前在:这个函数收一个 ``autoApproves``,由渲染层缓存的 runMode 推出来。
 * 于是同一个请求有两次裁决:后端的确认闸判过一次,前端再判一次。
 *
 * 两次裁决只会在**不一致**的时候显出来,而不一致恰好是危险的那一侧:后端处在
 * 「每次询问」而前端缓存还停在「代我批准」(另一个窗口刚改过、启动时那次 GET 失败、
 * 用户在 CLI 改的),前端就会替用户答应一个后端明确要求他看一眼的请求——而且不留
 * 痕迹。反过来后端在 auto 时,低风险请求根本不会发出 ``confirm_required`` 事件,
 * 前端这一层什么也没多做。所以它没有正确的一侧,只有错误的一侧。
 *
 * 会话内复用留在前端,因为它本来就只属于这一个窗口的这一次运行,没有第二个持有者。
 */
export function shouldAutoApproveConfirm(
  scopeAlreadyAllowed: boolean,
  context?: Record<string, unknown>,
): boolean {
  if (isProtectedConfirmContext(context)) {
    return scopeAlreadyAllowed && canReuseProtectedConfirm(context);
  }
  return scopeAlreadyAllowed;
}

export function parentPathForConfirmScope(pathValue: unknown): string {
  const path = text(pathValue).replace(/[\\/]+$/, "");
  if (!path) return "";
  const separator = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (separator < 0) return path;
  if (separator === 0) return path.slice(0, 1);
  if (separator === 2 && /^[A-Za-z]:[\\/]/u.test(path)) return path.slice(0, 3);
  return path.slice(0, separator);
}

function normalizeScopePath(value: unknown): string {
  const raw = text(value).replace(/\\/gu, "/").replace(/\/+$/u, "");
  if (/^[A-Za-z]:/u.test(raw)) {
    return `${raw.slice(0, 1).toLowerCase()}${raw.slice(1)}`;
  }
  return raw || "/";
}

function workspaceRootsForConfirmScope(context?: Record<string, unknown>): string[] {
  const rawRoots = context?.workspace_roots;
  const values = Array.isArray(rawRoots)
    ? rawRoots
    : [context?.workspace_root ?? context?.cwd];
  return Array.from(
    new Set(values.map(normalizeScopePath).filter((value) => value && value !== "/")),
  ).sort();
}

function commandPrefixForConfirmScope(context?: Record<string, unknown>): string {
  const fromBackend = text(context?.command_prefix);
  if (fromBackend) return fromBackend.replace(/\s+/gu, " ");

  // Compatibility fallback for old backends. New backends always send a
  // structured prefix; taking two tokens is intentionally narrower than the
  // previous executable-only scope ("git"), without pretending to parse a
  // complete shell grammar in the renderer.
  const command = text(context?.command).replace(/\s+/gu, " ");
  return command.split(" ").filter(Boolean).slice(0, 2).join(" ") || "unknown";
}

export function buildConfirmScope(
  question: string,
  context?: Record<string, unknown>,
): string {
  const tool = text(context?.tool);
  const workspaceRoots = workspaceRootsForConfirmScope(context);
  const permissions = text(context?.sandbox_permissions) || "workspace-write";
  if (tool === "bash_exec" || tool === "bash_bg_start") {
    if (protectedConfirmReuseMode(context) === "exact-command") {
      return JSON.stringify({
        tool,
        exactCommand: text(context?.command),
        executionDirectory: normalizeScopePath(context?.cwd ?? workspaceRoots[0] ?? ""),
        riskCategories: confirmRiskCategoryCodes(context),
        workspaceRoots,
        permissions,
      });
    }
    return JSON.stringify({
      tool,
      commandPrefix: commandPrefixForConfirmScope(context),
      workspaceRoots,
      permissions,
    });
  }
  if (tool === "file_write" || tool === "file_edit") {
    const path = text(context?.path);
    const folder = parentPathForConfirmScope(path);
    return JSON.stringify({
      tool,
      parent: normalizeScopePath(folder || "/"),
      workspaceRoots,
      permissions,
    });
  }
  if (tool) return JSON.stringify({ tool, workspaceRoots, permissions });
  return JSON.stringify({ question, workspaceRoots, permissions });
}
