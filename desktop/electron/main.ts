import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  MenuItemConstructorOptions,
  nativeImage,
  powerSaveBlocker,
  screen,
  session,
  shell,
  Tray
} from "electron";
import { spawn, ChildProcess, execFile, execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// Before app.ready: mitigate Chromium paint corruption (smearing/ghosting) on
// some Windows + NVIDIA (or hybrid GPU) stacks.
// Policy: disable GPU by default on Windows; AGX_DISABLE_GPU=1 also forces it on other OSes.
if (process.platform === "win32" || process.env.AGX_DISABLE_GPU === "1") {
  app.commandLine.appendSwitch("disable-gpu");
  app.disableHardwareAcceleration();
}

// 渲染进程 fetch → 本机 agx（127.0.0.1）若走系统 HTTP/SOCKS 代理，常表现为 TypeError: network error；
// 主进程直连公网的健康检测仍可能成功。Chromium：对环回地址绕过代理。
app.commandLine.appendSwitch("proxy-bypass-list", "<-loopback>");
import path from "node:path";
import net from "node:net";
import os from "node:os";
import fs from "node:fs";
import crypto from "node:crypto";
import http from "node:http";
import https from "node:https";
import yaml from "js-yaml";
import { extract as extractTar } from "tar";
import {
  closeSplash,
  configureSplashLayoutThemeReader,
  createSplashWindow,
  onMainWindowDidFinishLoad,
  registerSplashIpcHandlers,
  scheduleSplashForceShowFallback,
  updateSplashStage,
} from "./splash";
import {
  getSystemSearchInfo,
  openSystemSearchPath,
  openSystemSearchWith,
  previewSystemSearchFile,
  revealSystemSearchPath,
  runSystemSearch,
  type SystemSearchCategory,
} from "./system-search";
import { proxyAwareFetch, logProxyConfig } from "./proxy-fetch";
import { pickLocalFsPathCandidate } from "./local-fs-path";
import { fetchFaviconDataUrl } from "./fetch-favicon";
import { classifyModelHealthFailure } from "./model-health";
import { isRealpathUnder, safeRealpath } from "./path-guard";
import {
  getServeStartupTimeoutMs,
  LOCAL_BACKEND_STARTUP_ENV,
  SERVE_READY_PATH,
  SERVE_READY_PROBE_TIMEOUT_MS,
} from "./local-backend-startup";
import {
  buildDesktopRuntimeInstallPlan,
  buildSocksioInstallPlan,
  findBackendWheelhouse,
  isOfflineInstallRequested,
} from "./backend-dependency-install";
import {
  startDocumentRendererHost,
  type DocumentRendererIdentity,
  type DocumentRendererHost,
} from "./document-renderer-host";
import {
  startEnterpriseActionBroker,
  type EnterpriseActionAuth,
  type EnterpriseActionBinding,
  type EnterpriseActionBroker,
} from "./enterprise-action-broker";
import {
  readSessionMessagesFromDisk,
  readSessionMessagesTailFromDisk,
} from "./session-messages-disk";
import {
  normalizeDesktopFeedbackMessageId,
  normalizeDesktopFeedbackScopeId,
  normalizeDesktopFeedbackSessionId,
  normalizeDesktopFeedbackValue,
  desktopFeedbackListScopeMatches,
  rendererMessageIdForCanonicalExternalId,
  resolveDesktopAssistantMessage,
  type DesktopFeedbackTarget,
  type DesktopFeedbackValue,
} from "./enterprise-feedback";
import {
  desktopFeedbackScopeHandshakeMatches,
} from "./feedback-scope";
import { writeLocalTextFileAtomic } from "./write-local-text-file";
import {
  scanWorkspaceSensitiveFiles,
  type WorkspaceSensitiveScanPayload,
} from "./workspace-sensitive-scan";
import {
  resolveDesktopAgxHome,
  resolveDesktopMcpConfigPath,
  resolveDesktopUserDataDir,
} from "./desktop-paths";
import { selectEnterpriseInferenceBase } from "./enterprise-routing";
import { redactManagedProviderSecrets } from "./managed-provider-redaction";
import {
  normalizeManagedPortableReconcilePayload,
  normalizePortablePackagePublication,
  normalizePortablePackageStudioExportRequest,
  normalizePortableMarketSecurityFindings,
  normalizePortablePackageScanFindings,
  isPortablePackageScanReport,
  mergePortableMarketSecurityFindings,
  PORTABLE_MARKET_MANUAL_ONLY_CODES,
  normalizePortableMarketReleaseNotes,
  normalizePortableMarketAudienceDepartments,
  normalizePortableMarketAudienceUsers,
  normalizePortableMarketItem,
  normalizePortableMarketItems,
  normalizePortableMarketCursor,
  normalizePortableMarketVisibility,
  portableMarketInstallItemIdentityMatches,
  sanitizePortableMarketReleaseNotes,
  sanitizePortablePackageManifest,
  scanPortableMarketManifest,
  scanPortableMarketText,
  PORTABLE_MARKET_PAGE_SIZE,
  type PortableMarketListResult,
} from "./portable-market";
import {
  normalizeEnterpriseModelCatalog,
  resolveEnterpriseModelSelection,
  type EnterpriseModelCatalogEntry,
} from "./enterprise-model-catalog";
import {
  isEnterpriseSkillMarketplaceApproved,
  normalizeEnterpriseCapabilities,
  planEnterpriseSkills,
  removeEnterpriseMcpDocument,
  syncEnterpriseMcpDocument,
  enterpriseMcpEntryName,
  enterpriseSkillDirName,
  hasManagedSkillDelivery,
  findEnterpriseCapabilityNameCollisions,
  normalizeManagedSkillLedger,
  resolveManagedSkillDirectory,
  type EnterpriseCapability,
  type McpDocument,
} from "./enterprise-capabilities";
import {
  normalizeEnterpriseCapabilitySyncStatuses,
  type EnterpriseCapabilitySyncStatus,
} from "./enterprise-capability-sync-state";
import {
  ENTERPRISE_CAPABILITY_SYNC_ERRORS,
  boundedCapabilityMessage as boundedCapabilityMessageHelper,
  enqueueEnterpriseCapabilityReceipts,
  fetchSkillBundleDetailed as fetchSkillBundleDetailedHelper,
  failPendingEnterpriseCapabilitySyncStatuses as failPendingEnterpriseCapabilitySyncStatusesHelper,
  finalizeEnterpriseSkillSyncAfterIndexRefresh as finalizeEnterpriseSkillSyncAfterIndexRefreshHelper,
  markEnterpriseCapabilitySyncStatusesWaiting as markEnterpriseCapabilitySyncStatusesWaitingHelper,
  persistEnterpriseCapabilityReceiptSummary as persistEnterpriseCapabilityReceiptSummaryHelper,
  pruneEnterpriseCapabilitySyncState as pruneEnterpriseCapabilitySyncStateHelper,
  recoverInterruptedManagedSkillDirectory,
  recordEnterpriseCapabilitySyncStatus as recordEnterpriseCapabilitySyncStatusHelper,
  settleManagedSkillDirectoryTransactions,
  shouldRetryEnterpriseCapabilityReceipt,
  stageManagedSkillDirectory,
  type EnterpriseCapabilitySyncConfigStore,
  type EnterpriseCapabilitySyncPatch,
  type EnterpriseCapabilityReceiptResult,
  type EnterpriseSkillBundleFetchResult as EnterpriseSkillBundleFetchResultHelper,
  type ManagedSkillDirectoryTransaction,
} from "./enterprise-capability-sync";
import {
  readEnterpriseMcpDocument,
  writeEnterpriseMcpDocumentAndConfirm,
} from "./enterprise-mcp-sync";
import {
  enterpriseMarketSkillDirName as managedMarketSkillDirNameHelper,
  enterpriseMarketSkillsRoot as managedMarketSkillsRootHelper,
  normalizeManagedMarketSkillLedger as normalizeManagedMarketSkillLedgerHelper,
  planManagedMarketSkills,
  recoverInterruptedManagedMarketSkillDirectory,
  removeManagedMarketSkillDirectory,
  resolveManagedMarketSkillDirectory,
  stageManagedMarketSkillDirectory,
  type ManagedMarketSkillPackage as ManagedMarketSkillPackageHelper,
} from "./managed-market-skills";
import { sanitizeModelContextWindowOverrides } from "./model-context-window-overrides";
import {
  computePollMaxTicks,
  DEFAULT_ENTERPRISE_PORTAL_ORIGIN,
  enterpriseFetchErrorMessage,
  isVerificationUrlSameOrigin,
  normalizeVerificationUrlForPortalOrigin,
  normalizePortalOrigin,
  parseDeviceInitPayload,
  validatePortalOriginForBrowserLogin,
} from "./enterprise-browser-login";
import {
  applySessionWorkspaceCopy,
  copySourceIntoWorkspace,
  createWorkspaceLink,
  diffSessionWorkspaceCopy,
  findCoveringNonLinkMount,
  findMountForSource,
  type MountMode,
  upsertMount,
  uniqueLinkName as uniqueMountName,
} from "./workspace-mounts";
import {
  PortableMarketDownloadConfirmationStore,
  reportPortableMarketDownloadWithRetry,
  type PortableMarketDownloadBinding,
  type PortableMarketDownloadReport,
  type PortableMarketDownloadReporterResult,
} from "./market-downloads";
import {
  listMetaWorkspaceHistory,
  parseMetaWorkspaceHistoryKind,
  restoreMetaWorkspaceHistory,
  resolveMetaWorkspaceMainPath,
  snapshotMetaWorkspaceBeforeSave,
  type MetaWorkspaceHistoryKind,
} from "./meta-workspace-history";
import {
  assertManagedSkillDirectory,
  buildQqmailManagedSkill,
  buildTapdMcpEntry,
  extractAuthorizationUrl,
  extractFeishuDeviceFlow,
  extractGithubDeviceCode,
  extractGithubDeviceUrl,
  extractQqmailAuthUrl,
  isTapdValidationSuccess,
  isWecomProbeSuccessful,
  mergeTapdMcpDocument,
  parseFeishuAuthStatus,
  parseGithubAuthStatus,
  parseQqmailAuthStatus,
  parseQqmailMeAccount,
  parseTmeetAuthStatus,
  qqmailNpmPlatformPackage,
  readBodyWithLimit,
  wecomNpmPlatformPackage,
} from "./native-connectors-core";

const DESKTOP_PRODUCT_NAME = "AgenticX Ontology";
const DESKTOP_PRODUCT_LABEL = `${DESKTOP_PRODUCT_NAME} Desktop`;

// Keep Electron's lock, cookies, localStorage, and window state isolated from
// the former customer-branded desktop.  This is intentionally configured
// before any lock or BrowserWindow/session API is touched.
const DESKTOP_USER_DATA_DIR = resolveDesktopUserDataDir();
app.setName(DESKTOP_PRODUCT_NAME);
app.setPath("userData", DESKTOP_USER_DATA_DIR);
app.setPath("sessionData", path.join(DESKTOP_USER_DATA_DIR, "session"));

function resolveDesktopAppIconPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "assets", "icon.png")
    : path.resolve(process.cwd(), "assets", "icon.png");
}

/** Node fetch honors HTTP_PROXY; localhost cc-bridge POSTs then fail (e.g. 502) and PTY input never reaches Claude. */
function ccBridgeUrlIsLoopback(urlStr: string): boolean {
  try {
    const u = new URL(urlStr);
    const h = (u.hostname || "").toLowerCase();
    return h === "127.0.0.1" || h === "localhost" || h === "::1";
  } catch {
    return false;
  }
}

async function ccBridgeHttpPostJson(
  fullUrl: string,
  token: string,
  jsonBody: Record<string, unknown>,
  signal?: AbortSignal
): Promise<boolean> {
  const payload = JSON.stringify(jsonBody);
  if (!ccBridgeUrlIsLoopback(fullUrl)) {
    try {
      const resp = await fetch(fullUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: payload,
        signal,
      });
      return resp.ok;
    } catch {
      return false;
    }
  }
  const buf = Buffer.from(payload, "utf8");
  let u: URL;
  try {
    u = new URL(fullUrl);
  } catch {
    return false;
  }
  return await new Promise((resolve) => {
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + u.search,
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Content-Length": String(buf.length),
        },
      },
      (res) => {
        res.resume();
        const c = res.statusCode || 0;
        resolve(c >= 200 && c < 300);
      }
    );
    req.on("error", () => resolve(false));
    if (signal) {
      const onAbort = () => {
        req.destroy();
        resolve(false);
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
    req.write(buf);
    req.end();
  });
}

async function ccBridgeHttpGetStreamLoopback(
  fullUrl: string,
  token: string,
  signal: AbortSignal,
  onData: (chunk: Buffer) => void
): Promise<boolean> {
  let u: URL;
  try {
    u = new URL(fullUrl);
  } catch {
    return false;
  }
  return await new Promise((resolve, reject) => {
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + u.search,
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      },
      (res) => {
        const code = res.statusCode || 0;
        if (code < 200 || code >= 300) {
          res.resume();
          resolve(false);
          return;
        }
        res.on("data", (chunk: Buffer) => {
          onData(chunk);
        });
        res.on("end", () => resolve(true));
        res.on("error", reject);
      }
    );
    req.on("error", reject);
    const onAbort = () => {
      req.destroy();
      reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    req.end();
  });
}

type ProviderConfig = {
  api_key?: string;
  base_url?: string;
  model?: string;
  models?: string[];
  enabled?: boolean;
  drop_params?: boolean;
  display_name?: string;
  interface?: "openai" | "ollama";
  /** Set by enterprise login; UI treats as read-only managed provider. */
  managed?: boolean;
};

type EnterpriseTokenBudgetPolicy = {
  /** First (yellow) conversation-usage alert. */
  warning_tokens_per_session: number;
  /** Wire-compatible name for the second (red) alert; it is not a blocking cap. */
  max_tokens_per_session: number;
};

type EnterpriseTokenBudgetBootstrapPolicy = {
  warningTokensPerSession?: unknown;
  maxTokensPerSession?: unknown;
};

const DEFAULT_ENTERPRISE_TOKEN_BUDGET_POLICY: EnterpriseTokenBudgetPolicy = {
  warning_tokens_per_session: 500_000,
  max_tokens_per_session: 1_000_000,
};

/**
 * 企业对「员工能不能自己装东西」的管控。
 *
 * 默认全开：这三项是后加的，bootstrap 没下发时必须维持加它们之前的行为，否则老租户
 * 升上来员工突然装不了东西，而管理员根本没配过这一项。
 */
export type EnterpriseCapabilityPolicy = {
  allow_local_skill_install: boolean;
  allow_local_mcp_install: boolean;
  allow_mcp_auto_discovery: boolean;
};

const DEFAULT_ENTERPRISE_CAPABILITY_POLICY: EnterpriseCapabilityPolicy = {
  allow_local_skill_install: true,
  allow_local_mcp_install: true,
  allow_mcp_auto_discovery: true,
};

/** 只认真正的 false；配歪了当「没配过」。读成「关闭」会静默锁死一整个租户。 */
export function normalizeEnterpriseCapabilityPolicy(raw: unknown): EnterpriseCapabilityPolicy {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ...DEFAULT_ENTERPRISE_CAPABILITY_POLICY };
  }
  const src = raw as Record<string, unknown>;
  return {
    allow_local_skill_install:
      src.allowLocalSkillInstall !== false && src.allow_local_skill_install !== false,
    allow_local_mcp_install:
      src.allowLocalMcpInstall !== false && src.allow_local_mcp_install !== false,
    allow_mcp_auto_discovery:
      src.allowMcpAutoDiscovery !== false && src.allow_mcp_auto_discovery !== false,
  };
}

function normalizeEnterpriseTokenBudgetPolicy(
  value?: EnterpriseTokenBudgetBootstrapPolicy | EnterpriseTokenBudgetPolicy | null,
): EnterpriseTokenBudgetPolicy {
  const row = value && typeof value === "object"
    ? (value as EnterpriseTokenBudgetBootstrapPolicy & Partial<EnterpriseTokenBudgetPolicy>)
    : {};
  const hardRaw = Number(
    row.maxTokensPerSession
      ?? row.max_tokens_per_session
      ?? DEFAULT_ENTERPRISE_TOKEN_BUDGET_POLICY.max_tokens_per_session,
  );
  const hard = Number.isFinite(hardRaw)
    ? Math.max(100_000, Math.min(5_000_000, Math.round(hardRaw)))
    : DEFAULT_ENTERPRISE_TOKEN_BUDGET_POLICY.max_tokens_per_session;
  const warningRaw = Number(
    row.warningTokensPerSession
      ?? row.warning_tokens_per_session
      ?? DEFAULT_ENTERPRISE_TOKEN_BUDGET_POLICY.warning_tokens_per_session,
  );
  const warning = Number.isFinite(warningRaw)
    ? Math.max(50_000, Math.min(hard - 1, Math.round(warningRaw)))
    : Math.min(
        DEFAULT_ENTERPRISE_TOKEN_BUDGET_POLICY.warning_tokens_per_session,
        hard - 1,
      );
  return {
    warning_tokens_per_session: warning,
    max_tokens_per_session: hard,
  };
}

type EnterpriseConfig = {
  enabled?: boolean;
  /** Portal origin remembered for employees; survives logout. */
  default_portal_url?: string;
  base_url?: string;
  inference_base_url?: string;
  transport?: "gateway-direct-v1" | "portal-proxy-v1";
  reauth_required_for_direct?: boolean;
  token?: string;
  user?: {
    user_id?: string;
    email?: string;
    display_name?: string;
    tenant_id?: string;
    dept_id?: string | null;
  };
  policy?: {
    strict?: boolean;
    token_budget?: EnterpriseTokenBudgetPolicy;
    /** 企业是否允许本机自行安装 Skill/MCP、以及扫描本机 MCP 配置。 */
    capability_policy?: EnterpriseCapabilityPolicy;
  };
  models?: string[];
  /** Structured catalog from Portal; `models` remains for runtime compatibility. */
  model_catalog?: EnterpriseModelCatalogEntry[];
  /** 企业下发的 MCP / Skill；没出现在这里就等于已撤销。 */
  capabilities?: EnterpriseCapability[];
  /** Skill 声明了依赖但依赖没随包下发，装了也调不通，留给前端提示。 */
  unmet_capability_dependencies?: string[];
  /**
   * 附件自动路由策略。原样落盘，供 Python 运行时读取——它不经过渲染进程，CLI、定时
   * 任务、子智能体都只能从这里拿到策略（agenticx/studio/attachment_routing.py）。
   */
  attachment_routing?: Record<string, unknown> | null;
  /** 上次由本机写进 mcp.json 的条目名；撤销时据此精确删除，不按前缀猜。 */
  managed_mcp_servers?: string[];
  /** 同上，指 $AGX_HOME/skills/enterprise 下由本机安装的目录名。 */
  managed_skills?: string[];
  /**
   * 能力包强制下发的市场 Skill 账本。它使用独立根目录和稳定的 market
   * item ID，不与注册表 Skill 或员工按需安装的 market Skill 共用目录。
   */
  managed_market_skills?: Record<string, {
    dirName: string;
    digest: string;
  }>;
  /** 每一条企业能力最近一次本地同步结果；仅保存非敏感摘要。 */
  capability_sync_statuses?: EnterpriseCapabilitySyncStatus[];
  /** 最近一次成功应用的 Skill/MCP 元数据，用于失败时明确标出 LKG。 */
  capability_sync_last_applied?: Record<string, {
    version?: string;
    digest?: string;
    appliedAt?: string;
  }>;
  /** Receipt 上报只读汇总；上报失败不得回滚本地能力。 */
  capability_receipt_summary?: {
    attempted_at: string;
    sent_count: number;
    failed_count: number;
    error_code?: string;
    message?: string;
  };
  /** 当前企业账号下发的托管专家/群聊数量；只保存数量，不保存包内容。 */
  managed_portable_package_count?: number;
  /** 退出时 Studio 未能撤回企业托管专家/群聊；下次就绪后用空 desired-state 重试。 */
  managed_portable_cleanup_pending?: boolean;
  synced_at?: string;
};

/** Resolve org portal URL for employee login without asking them to type it. */
function resolveEnterprisePortalDefault(cfg: AgxConfig): string {
  const fromEnv = String(process.env.AGX_ENTERPRISE_PORTAL_URL ?? "").trim();
  const fromDefault = String(cfg.enterprise?.default_portal_url ?? "").trim();
  const fromLast = String(cfg.enterprise?.base_url ?? "").trim();
  const candidate = fromEnv || fromDefault || fromLast || DEFAULT_ENTERPRISE_PORTAL_ORIGIN;
  const validated = validatePortalOriginForBrowserLogin(candidate);
  return validated.ok ? validated.origin : "";
}

type RemoteServerConfig = {
  enabled?: boolean;
  url?: string;
  token?: string;
};

type ResolvedRemoteConfig = {
  url: string;
  token: string;
};

type AgxConfig = {
  version?: string;
  default_provider?: string;
  providers?: Record<string, ProviderConfig>;
  onboarding_completed?: boolean;
  /**
   * 历史字段，**已彻底退休**：读写两侧都不再看它，连迁移也没有。
   *
   * 它是上一轮那个 bug 的全部内容——确认闸先读它，设置接口读 `permissions.mode`，
   * 于是界面显示「每次询问」而执行路径仍在自动批准，用户改不掉也看不到。
   * 保留声明只为让旧配置文件里残留的这一行不至于变成类型错误。
   */
  confirm_strategy?: "manual" | "semi-auto" | "auto" | "";
  active_provider?: string;
  active_model?: string;
  remote_server?: RemoteServerConfig;
  gateway?: {
    enabled?: boolean;
    url?: string;
    device_id?: string;
    token?: string;
    studio_base_url?: string;
  };
  feishu_longconn?: {
    enabled?: boolean;
    app_id?: string;
    app_secret?: string;
  };
  runtime?: Record<string, unknown>;
  notifications?: {
    email?: {
      enabled?: boolean;
      smtp_host?: string;
      smtp_port?: number;
      smtp_username?: string;
      smtp_password?: string;
      smtp_use_tls?: boolean;
      from_email?: string;
      default_to_email?: string;
    };
  };
  agent_harness_trinity?: {
    skill_protocol?: boolean;
    session_summary?: boolean;
    learning_enabled?: boolean;
    skill_manage_enabled?: boolean;
    learning_nudge_interval?: number;
    learning_min_tool_calls?: number;
  };
  automation?: { prevent_sleep?: boolean };
  skills?: { non_high_risk_auto_install?: boolean };
  /** Meta-agent default workspace root (supports ~); mirrors config.yaml workspace_dir */
  workspace_dir?: string;
  /** @deprecated Ignored; enterprise login is the only account source. */
  agx_account?: {
    user_email?: string;
    user_display_name?: string;
    access_token?: string;
    refresh_token?: string;
    supabase_url?: string;
    updated_at?: string;
  };
  /** Enterprise portal managed login (PAT + hosted models). Never log token. */
  enterprise?: EnterpriseConfig;
  /** Stable local identities for Skill market iterations; paths and IDs only, never content. */
  skill_market_artifacts?: Record<string, {
    artifact_id: string;
    base_dir: string;
    last_version?: string;
  }>;
};

/** Enterprise portal login/bootstrap — avoid infinite spinner when proxy/network stalls. */
const ENTERPRISE_PORTAL_FETCH_TIMEOUT_MS = 15_000;

/**
 * A bootstrap response is only safe to apply when it carries the model list.
 *
 * Older Portal deployments use HTTP 503 when the direct Gateway address is not
 * configured.  Some of those responses have no usable body at all.  Treating
 * that response as a proxy fallback would apply an empty model list and reset
 * policy defaults over the last-known-good enterprise snapshot.
 */
function hasUsableEnterpriseBootstrapData(value: unknown): boolean {
  return isPlainJsonObject(value) && Array.isArray(value.models);
}

function applyEnterpriseProvider(
  cfg: AgxConfig,
  opts: {
    portalOrigin: string;
    inferenceBaseUrl: string;
    transport: "gateway-direct-v1" | "portal-proxy-v1";
    reauthRequiredForDirect?: boolean;
    token: string;
    modelCatalog: EnterpriseModelCatalogEntry[];
    capabilities?: unknown;
    unmetCapabilityDependencies?: unknown;
    managedPortablePackages?: unknown;
    attachmentRouting?: unknown;
    user: NonNullable<EnterpriseConfig["user"]>;
    strict: boolean;
    tokenBudget?: EnterpriseTokenBudgetBootstrapPolicy;
    capabilityPolicy?: unknown;
  },
): void {
  const modelCatalog = normalizeEnterpriseModelCatalog(opts.modelCatalog);
  const models = modelCatalog.map((entry) => entry.id);
  const inferenceBase = opts.inferenceBaseUrl.replace(/\/+$/, "");
  const previous = cfg.enterprise;
  const capabilityBootstrap = resolveEnterpriseCapabilityBootstrap(
    previous,
    opts.portalOrigin,
    opts.user,
    opts.capabilities,
    opts.unmetCapabilityDependencies,
  );
  const previousManagedModel =
    cfg.providers?.enterprise?.model
    ?? (cfg.active_provider === "enterprise" ? cfg.active_model : "");
  const selectedModel = resolveEnterpriseModelSelection(models, previousManagedModel);
  cfg.enterprise = {
    enabled: true,
    default_portal_url: opts.portalOrigin,
    base_url: opts.portalOrigin,
    inference_base_url: inferenceBase,
    transport: opts.transport,
    reauth_required_for_direct: Boolean(opts.reauthRequiredForDirect),
    token: opts.token,
    user: opts.user,
    policy: {
      strict: opts.strict,
      token_budget: normalizeEnterpriseTokenBudgetPolicy(opts.tokenBudget),
      capability_policy: normalizeEnterpriseCapabilityPolicy(opts.capabilityPolicy),
    },
    models,
    model_catalog: modelCatalog,
    capabilities: capabilityBootstrap.capabilities,
    unmet_capability_dependencies: capabilityBootstrap.unmetCapabilityDependencies,
    managed_portable_package_count: resolveManagedPortablePackageCount(
      previous,
      opts.managedPortablePackages,
    ),
    // 原样存，不在这里解释：解释的规则只有一处出处（后端），客户端只负责搬运。
    // 后端没下发时写 null 而不是保留旧值——策略被撤销后必须真的失效。
    attachment_routing:
      opts.attachmentRouting && typeof opts.attachmentRouting === "object"
        ? (opts.attachmentRouting as Record<string, unknown>)
        : null,
    // 这两份是本机的安装账本，不是后端下发的内容，刷新时必须原样带过去，
    // 否则撤销时就不知道该删哪些了。
    managed_mcp_servers: [...(previous?.managed_mcp_servers ?? [])],
    managed_skills: normalizeManagedSkillLedger(previous?.managed_skills),
    managed_market_skills: normalizeManagedMarketSkillLedger(previous?.managed_market_skills),
    capability_sync_statuses: normalizeEnterpriseCapabilitySyncStatuses(
      previous?.capability_sync_statuses,
    ),
    capability_sync_last_applied: previous?.capability_sync_last_applied
      ? { ...previous.capability_sync_last_applied }
      : undefined,
    capability_receipt_summary: previous?.capability_receipt_summary
      ? { ...previous.capability_receipt_summary }
      : undefined,
    synced_at: new Date().toISOString(),
  };
  cfg.providers = cfg.providers ?? {};
  cfg.providers.enterprise = {
    display_name: "企业模型",
    interface: "openai",
    base_url: inferenceBase,
    api_key: opts.token,
    models,
    model: selectedModel,
    enabled: true,
    managed: true,
    drop_params: true,
  };
  cfg.default_provider = "enterprise";
  cfg.active_provider = "enterprise";
  cfg.active_model = selectedModel;
}

function clearEnterpriseFromConfig(cfg: AgxConfig): void {
  const rememberedPortal =
    String(cfg.enterprise?.default_portal_url ?? "").trim() ||
    String(cfg.enterprise?.base_url ?? "").trim() ||
    String(process.env.AGX_ENTERPRISE_PORTAL_URL ?? "").trim();
  const validated = validatePortalOriginForBrowserLogin(rememberedPortal);
  if (validated.ok) {
    cfg.enterprise = { default_portal_url: validated.origin };
  } else {
    delete cfg.enterprise;
  }
  if (cfg.providers?.enterprise) {
    const next = { ...cfg.providers };
    delete next.enterprise;
    cfg.providers = next;
  }
  if (cfg.default_provider === "enterprise") cfg.default_provider = "";
  if (cfg.active_provider === "enterprise") {
    cfg.active_provider = "";
    cfg.active_model = "";
  }
}

type EnterpriseTokenUser = {
  userId?: string;
  email?: string;
  displayName?: string;
  tenantId?: string;
  deptId?: string | null;
};

type EnterpriseLoginResult =
  | {
      ok: true;
      user: { email: string; displayName: string };
      models: string[];
      transport: "gateway-direct-v1" | "portal-proxy-v1";
      reauthRequiredForDirect: boolean;
    }
  | { ok: false; error: string };

// ENTERPRISE_IDENTITY_TRANSITION_HELPERS_START
type EnterpriseIdentityTransitionReason =
  | "same-identity"
  | "pending-cleanup"
  | "new-or-unknown-identity"
  | "identity-changed";

type EnterpriseIdentityTransitionPlan = {
  previousIdentityKey: string | null;
  nextIdentityKey: string | null;
  cleanupRequired: boolean;
  reason: EnterpriseIdentityTransitionReason;
};

/**
 * 企业托管能力的稳定归属。PAT/email/display name 都可能变化，不能拿来判断是否仍是
 * 同一份 desired state；只有门户 origin + tenant + user 三者完整且一致才允许保留 LKG。
 */
function enterpriseStableIdentityKey(
  portalOrigin: unknown,
  user?: {
    tenant_id?: unknown;
    user_id?: unknown;
    tenantId?: unknown;
    userId?: unknown;
  } | null,
): string | null {
  const origin = normalizePortalOrigin(String(portalOrigin ?? ""));
  const tenantId = String(user?.tenant_id ?? user?.tenantId ?? "").trim();
  const userId = String(user?.user_id ?? user?.userId ?? "").trim();
  if (!origin || !tenantId || !userId) return null;
  return JSON.stringify([origin, tenantId, userId]);
}

/**
 * Resolve the current authenticated Desktop identity for local renderer
 * clients. This reads the persisted enterprise auth snapshot on every request
 * through the host callback, so logout and account switches take effect
 * immediately instead of leaving a stale startup value in the environment.
 */
function resolveDocumentRendererIdentity(): DocumentRendererIdentity | null {
  const cfg = loadAgxConfig();
  const enterprise = cfg.enterprise;
  const token = String(enterprise?.token ?? "").trim();
  const origin = normalizePortalOrigin(
    String(enterprise?.base_url ?? enterprise?.default_portal_url ?? ""),
  );
  const userId = String(enterprise?.user?.user_id ?? "").trim();
  const tenantId = String(enterprise?.user?.tenant_id ?? "").trim();
  if (!token || !origin || !userId || !tenantId) return null;
  const scopeId = enterpriseStableIdentityKey(origin, {
    user_id: userId,
    tenant_id: tenantId,
  });
  if (!scopeId) return null;
  return { scope_id: scopeId, user_id: userId, tenant_id: tenantId };
}

type EnterpriseCapabilityBootstrapState = {
  capabilities: EnterpriseCapability[];
  unmetCapabilityDependencies: string[];
};

function normalizedManagedPortablePackageCount(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/**
 * Keep the managed expert/group count in the same last-known-good boundary as
 * the Skill/MCP capability snapshot: an omitted or malformed list is unknown,
 * while an explicit empty list is an authoritative withdrawal.
 */
function resolveManagedPortablePackageCount(
  previous: EnterpriseConfig | undefined,
  bootstrapPackages: unknown,
): number {
  if (Array.isArray(bootstrapPackages)) {
    const payload = normalizeManagedPortableReconcilePayload(bootstrapPackages);
    if (payload) return payload.packages.length;
  }
  return normalizedManagedPortablePackageCount(previous?.managed_portable_package_count);
}

/**
 * `capabilities: []` is an authoritative revoke. An omitted (or malformed) field means the
 * Portal could not produce a desired-state snapshot, so only the same stable identity may keep
 * its last-known-good list. Never carry that list across tenant/user boundaries.
 */
function resolveEnterpriseCapabilityBootstrap(
  previous: EnterpriseConfig | undefined,
  nextPortalOrigin: string,
  nextUser: NonNullable<EnterpriseConfig["user"]>,
  bootstrapCapabilities: unknown,
  bootstrapUnmetDependencies: unknown,
): EnterpriseCapabilityBootstrapState {
  if (Array.isArray(bootstrapCapabilities)) {
    return {
      capabilities: normalizeEnterpriseCapabilities(bootstrapCapabilities),
      unmetCapabilityDependencies: Array.isArray(bootstrapUnmetDependencies)
        ? bootstrapUnmetDependencies.map(String).filter(Boolean)
        : [],
    };
  }

  const previousIdentityKey = enterpriseStableIdentityKey(
    previous?.base_url ?? previous?.default_portal_url,
    previous?.user,
  );
  const nextIdentityKey = enterpriseStableIdentityKey(nextPortalOrigin, nextUser);
  const sameStableIdentity = previousIdentityKey !== null
    && nextIdentityKey !== null
    && previousIdentityKey === nextIdentityKey;
  if (!sameStableIdentity) {
    return { capabilities: [], unmetCapabilityDependencies: [] };
  }
  return {
    capabilities: normalizeEnterpriseCapabilities(previous?.capabilities),
    unmetCapabilityDependencies: Array.isArray(previous?.unmet_capability_dependencies)
      ? previous.unmet_capability_dependencies.map(String).filter(Boolean)
      : [],
  };
}

function planEnterpriseIdentityTransition(
  previous: EnterpriseConfig | undefined,
  nextPortalOrigin: string,
  nextUser: NonNullable<EnterpriseConfig["user"]>,
): EnterpriseIdentityTransitionPlan {
  const previousIdentityKey = enterpriseStableIdentityKey(
    previous?.base_url ?? previous?.default_portal_url,
    previous?.user,
  );
  const nextIdentityKey = enterpriseStableIdentityKey(nextPortalOrigin, nextUser);
  const tokenFreePendingCleanup = Boolean(
    previous
      && !String(previous.token ?? "").trim()
      && (
        (previous.managed_mcp_servers?.length ?? 0) > 0
        || (previous.managed_skills?.length ?? 0) > 0
        || Object.keys(previous.managed_market_skills ?? {}).length > 0
        || previous.managed_portable_cleanup_pending === true
      ),
  );
  if (tokenFreePendingCleanup) {
    return {
      previousIdentityKey,
      nextIdentityKey,
      cleanupRequired: true,
      reason: "pending-cleanup",
    };
  }
  if (
    previousIdentityKey !== null
    && nextIdentityKey !== null
    && previousIdentityKey === nextIdentityKey
  ) {
    return {
      previousIdentityKey,
      nextIdentityKey,
      cleanupRequired: false,
      reason: "same-identity",
    };
  }
  return {
    previousIdentityKey,
    nextIdentityKey,
    cleanupRequired: true,
    reason: previousIdentityKey === null
      ? "new-or-unknown-identity"
      : "identity-changed",
  };
}

function isEnterpriseCapabilityWithdrawalComplete(
  result: EnterpriseCapabilityWithdrawalResult,
): boolean {
  return result.errors.length === 0
    && result.remainingMcp.length === 0
    && result.remainingSkills.length === 0
    && (result.remainingMarketSkills?.length ?? 0) === 0
    && !result.portableCleanupPending;
}

type EnterpriseIdentityPreparationResult =
  | { ok: true; cfg: AgxConfig }
  | { ok: false; cfg: AgxConfig; error: string };

/**
 * Remove the previous identity's managed state before a different tenant/user
 * can become current. Both login and periodic/manual refresh must use this;
 * otherwise a server-side PAT reassignment can bypass the login-only guard.
 */
async function prepareEnterpriseIdentityChange(
  initial: AgxConfig,
): Promise<EnterpriseIdentityPreparationResult> {
  const withdrawal = await withdrawEnterpriseCapabilitiesFromDisk(initial);
  const cfg = loadAgxConfig();
  persistEnterpriseCleanupTombstone(cfg, withdrawal);
  saveAgxConfig(cfg);
  if (!isEnterpriseCapabilityWithdrawalComplete(withdrawal)) {
    return {
      ok: false,
      cfg,
      error: `未能完整撤回旧托管能力：${withdrawal.errors.join("；") || "仍有待清理项目"}`,
    };
  }
  clearEnterpriseFromConfig(cfg);
  return { ok: true, cfg };
}
// ENTERPRISE_IDENTITY_TRANSITION_HELPERS_END

// Login, refresh and logout all rewrite the same config plus the same managed
// MCP/Skill files. Serializing the whole mutation (including remote bootstrap)
// prevents an older response from landing after a newer revoke/logout.
let enterpriseMutationTail: Promise<void> = Promise.resolve();
let enterpriseAuthGeneration = 0;
const enterpriseReceiptAbortControllers = new Set<AbortController>();

/**
 * Return the complete trusted account stamp exposed to the renderer. The
 * stable scope includes origin, tenant and user; email is intentionally not a
 * component because the same address may exist in multiple tenants.
 */
function currentEnterpriseFeedbackAccountStamp(config: AgxConfig = loadAgxConfig()): {
  scope_id: string | null;
  auth_generation: number;
} {
  const enterprise = config.enterprise;
  const token = String(enterprise?.token ?? "").trim();
  const portalOrigin = normalizePortalOrigin(
    String(enterprise?.base_url ?? enterprise?.default_portal_url ?? ""),
  );
  return {
    scope_id:
      enterprise?.enabled && token
        ? enterpriseStableIdentityKey(portalOrigin, enterprise?.user)
        : null,
    auth_generation: enterpriseAuthGeneration,
  };
}

function advanceEnterpriseAuthGeneration(): number {
  enterpriseAuthGeneration += 1;
  // A token inspected under the previous enterprise identity must never be
  // reused after login/logout starts, even if the short in-memory TTL has not
  // elapsed yet.
  portableMarketDownloadConfirmations.clear();
  for (const controller of enterpriseReceiptAbortControllers) controller.abort();
  enterpriseReceiptAbortControllers.clear();
  return enterpriseAuthGeneration;
}

/**
 * Close the renderer's feedback scope before the corresponding trusted config
 * write. This event is intentionally separate from `user-account-changed`,
 * which is emitted only after capability synchronization and therefore cannot
 * protect the short config-commit window.
 */
function notifyEnterpriseAuthChanging(): void {
  mainWindow?.webContents.send("user-account-changing", {
    generation: enterpriseAuthGeneration,
  });
}

function withEnterpriseMutationLock<T>(work: () => Promise<T>): Promise<T> {
  const run = enterpriseMutationTail.then(() => work(), () => work());
  enterpriseMutationTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function finishEnterpriseLoginUnlocked(
  baseUrl: string,
  pat: string,
  expectedGeneration: number,
  fallbackUser?: EnterpriseTokenUser,
): Promise<EnterpriseLoginResult> {
  if (expectedGeneration !== enterpriseAuthGeneration) {
    return { ok: false, error: "登录请求已取消" };
  }
  const bootResp = await proxyAwareFetch(`${baseUrl}/api/desktop/bootstrap`, {
    method: "GET",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${pat}`,
    },
    signal: AbortSignal.timeout(ENTERPRISE_PORTAL_FETCH_TIMEOUT_MS),
  });
  const bootJson = (await bootResp.json().catch(() => ({}))) as {
    code?: string;
    message?: string;
    data?: {
      user?: EnterpriseTokenUser;
      models?: unknown[];
      capabilities?: unknown[];
      managedPortablePackages?: unknown[];
      unmetCapabilityDependencies?: unknown[];
      attachmentRouting?: unknown;
      policy?: {
        strict?: boolean;
        tokenBudget?: EnterpriseTokenBudgetBootstrapPolicy;
        capabilities?: unknown;
      };
      apiBaseUrl?: string;
      inferenceApiBaseUrl?: string;
      inferenceTransport?: string;
      reauthRequiredForDirect?: boolean;
    };
  };
  const hasUsableBootstrapData = hasUsableEnterpriseBootstrapData(bootJson.data);
  if (!bootResp.ok) {
    if (bootResp.status === 401) {
      return { ok: false, error: "企业登录已失效，请重新登录" };
    }
    // 503 = inference base not configured.  The old proxy fallback is safe only
    // when the response still carries a complete enough bootstrap snapshot.
    // Never replace a last-known-good model/policy snapshot with empty defaults.
    if (bootResp.status === 503 && !hasUsableBootstrapData) {
      return {
        ok: false,
        error: "企业配置暂不可用（HTTP 503），已保留本机现有配置，请稍后重试",
      };
    }
    if (bootResp.status !== 503) {
      return {
        ok: false,
        error: bootJson.message || `拉取模型失败（HTTP ${bootResp.status}）`,
      };
    }
  }
  if (!hasUsableBootstrapData) {
    return {
      ok: false,
      error: bootJson.message || "企业配置响应无有效数据，已保留本机现有配置，请稍后重试",
    };
  }
  const inference = selectEnterpriseInferenceBase({
    apiBaseUrl: `${baseUrl}/api/desktop/v1`,
    portalApiBaseUrl: `${baseUrl}/api/desktop/v1`,
    inferenceApiBaseUrl: bootJson.data?.inferenceApiBaseUrl,
    inferenceTransport: bootJson.data?.inferenceTransport,
    reauthRequiredForDirect: bootJson.data?.reauthRequiredForDirect,
  });
  if (!inference.ok) {
    return { ok: false, error: inference.error };
  }
  const modelCatalog = normalizeEnterpriseModelCatalog(bootJson.data?.models ?? []);
  const models = modelCatalog.map((entry) => entry.id);
  const user = bootJson.data?.user ?? fallbackUser ?? {};
  const nextEnterpriseUser: NonNullable<EnterpriseConfig["user"]> = {
    user_id: user.userId ?? fallbackUser?.userId ?? "",
    email: user.email ?? fallbackUser?.email ?? "",
    display_name: user.displayName ?? fallbackUser?.displayName ?? "",
    tenant_id: user.tenantId ?? fallbackUser?.tenantId ?? "",
    dept_id: user.deptId ?? fallbackUser?.deptId ?? null,
  };
  // Logout/cancel increments the generation synchronously, even while this
  // request is awaiting bootstrap. Never let that stale response revive PATs.
  if (expectedGeneration !== enterpriseAuthGeneration) {
    return { ok: false, error: "登录请求已取消" };
  }
  let cfg = loadAgxConfig();
  const identityTransition = planEnterpriseIdentityTransition(
    cfg.enterprise,
    baseUrl,
    nextEnterpriseUser,
  );
  if (identityTransition.cleanupRequired) {
    // Invalidate feedback before prepareEnterpriseIdentityChange writes its
    // cleanup snapshot. `user-account-changed` is intentionally later.
    notifyEnterpriseAuthChanging();
    const prepared = await prepareEnterpriseIdentityChange(cfg);
    cfg = prepared.cfg;
    if (!prepared.ok) {
      return {
        ok: false,
        error: `应用新的企业身份前${prepared.error}`,
      };
    }
    if (expectedGeneration !== enterpriseAuthGeneration) {
      return { ok: false, error: "登录请求已取消" };
    }
    // Cleanup completed, so the new identity starts from the blank state
    // returned by prepareEnterpriseIdentityChange. Omitted snapshots cannot
    // inherit the old tenant/user's LKG.
  }
  delete cfg.agx_account;
  applyEnterpriseProvider(cfg, {
    portalOrigin: baseUrl,
    inferenceBaseUrl: inference.baseUrl,
    transport: inference.transport,
    reauthRequiredForDirect: inference.reauthRequiredForDirect,
    token: pat,
    modelCatalog,
    capabilities: bootJson.data?.capabilities,
    managedPortablePackages: bootJson.data?.managedPortablePackages,
    capabilityPolicy: bootJson.data?.policy?.capabilities,
    attachmentRouting: bootJson.data?.attachmentRouting,
    unmetCapabilityDependencies: bootJson.data?.unmetCapabilityDependencies,
    user: nextEnterpriseUser,
    strict: bootJson.data?.policy?.strict !== false,
    tokenBudget: bootJson.data?.policy?.tokenBudget,
  });
  saveAgxConfig(cfg);
  // 登录已经算成功了，能力同步失败不该把人挡在门外。
  const syncedCapabilities = normalizeEnterpriseCapabilities(cfg.enterprise?.capabilities);
  try {
    const sync = await syncEnterpriseCapabilitiesToDisk(
      bootJson.data?.managedPortablePackages,
    );
    const loadedPaths = await refreshSkillIndexAfterEnterpriseChange();
    const loadedCapabilityIds = loadedEnterpriseSkillCapabilityIds(syncedCapabilities, loadedPaths);
    for (const id of loadedEnterpriseMarketSkillCapabilityIds(pat, loadedPaths)) {
      loadedCapabilityIds.add(id);
    }
    const rolledBack = finalizeEnterpriseSkillSyncAfterIndexRefresh(
      syncedCapabilities,
      pat,
      true,
      undefined,
      loadedCapabilityIds,
    );
    if (rolledBack) await refreshSkillIndexAfterEnterpriseChange();
    failPendingEnterpriseCapabilitySyncStatuses(syncedCapabilities, pat);
    scheduleEnterpriseCapabilityReceipt(syncedCapabilities, pat, baseUrl);
    emitEnterpriseCapabilitiesChanged();
    if (!sync.ok) {
      console.warn(`[enterprise] 能力同步部分失败：${sync.errors.join("；")}`);
    }
  } catch (error) {
    finalizeEnterpriseSkillSyncAfterIndexRefresh(
      syncedCapabilities,
      pat,
      false,
      `Skill 索引刷新失败：${boundedCapabilityMessage(error)}`,
    );
    failPendingEnterpriseCapabilitySyncStatuses(syncedCapabilities, pat);
    scheduleEnterpriseCapabilityReceipt(syncedCapabilities, pat, baseUrl);
    emitEnterpriseCapabilitiesChanged();
    console.warn(`[enterprise] 能力同步失败：${boundedCapabilityMessage(error)}`);
  }
  return {
    ok: true,
    user: {
      email: cfg.enterprise?.user?.email ?? "",
      displayName: cfg.enterprise?.user?.display_name ?? "",
    },
    models,
    transport: inference.transport,
    reauthRequiredForDirect: inference.reauthRequiredForDirect,
  };
}

function finishEnterpriseLogin(
  baseUrl: string,
  pat: string,
  expectedGeneration: number,
  fallbackUser?: EnterpriseTokenUser,
): Promise<EnterpriseLoginResult> {
  return withEnterpriseMutationLock(() =>
    finishEnterpriseLoginUnlocked(baseUrl, pat, expectedGeneration, fallbackUser),
  );
}

/** 企业下发的 Skill 落在这个组下，与员工自己装的技能分开。 */
const ENTERPRISE_SKILL_GROUP = "enterprise";
const ENTERPRISE_SKILL_MARKER = ".near-managed";
const ENTERPRISE_SKILL_MAX_BYTES = 512 * 1024;
const ENTERPRISE_MCP_JSON_PATH = resolveDesktopMcpConfigPath();

function boundedCapabilityMessage(value: unknown): string {
  return boundedCapabilityMessageHelper(value);
}

/**
 * Persist one status transition against a fresh config snapshot.  Sync I/O can
 * overlap an account refresh or a settings save, so this never writes the
 * stale config captured at the beginning of a sync.  A token guard also keeps
 * a late download from reviving status after logout.
 */
function recordEnterpriseCapabilitySyncStatus(
  capability: EnterpriseCapability,
  patch: EnterpriseCapabilitySyncPatch,
  expectedToken: string,
): EnterpriseCapabilitySyncStatus | null {
  return recordEnterpriseCapabilitySyncStatusHelper(
    capability,
    patch,
    expectedToken,
    enterpriseCapabilitySyncConfigStore(),
  );
}

function markEnterpriseCapabilitySyncStatusesWaiting(
  capabilities: readonly EnterpriseCapability[],
  expectedToken: string,
  attemptedAt = new Date().toISOString(),
): void {
  markEnterpriseCapabilitySyncStatusesWaitingHelper(
    capabilities,
    expectedToken,
    enterpriseCapabilitySyncConfigStore(),
    attemptedAt,
  );
}

function pruneEnterpriseCapabilitySyncState(
  capabilities: readonly EnterpriseCapability[],
  expectedToken: string,
): void {
  pruneEnterpriseCapabilitySyncStateHelper(
    capabilities,
    expectedToken,
    enterpriseCapabilitySyncConfigStore(),
  );
}

const pendingEnterpriseSkillTransactions = new Map<
  string,
  Map<string, ManagedSkillDirectoryTransaction>
>();
const pendingEnterpriseMarketSkillTransactions = new Map<
  string,
  Map<string, ManagedSkillDirectoryTransaction>
>();
const pendingEnterpriseMarketSkillPreviousLedgers = new Map<
  string,
  Record<string, { dirName: string; digest: string }>
>();

function beginEnterpriseSkillTransactionRound(
  expectedToken: string,
): Map<string, ManagedSkillDirectoryTransaction> {
  const previous = pendingEnterpriseSkillTransactions.get(expectedToken);
  if (previous) {
    // A previous round should always have been finalized by its caller. If an
    // unexpected continuation escaped, restore its LKG before staging another
    // replacement under the same account.
    for (const transaction of previous.values()) {
      try { transaction.rollback(); } catch { /* next sync reports the new failure */ }
    }
  }
  const round = new Map<string, ManagedSkillDirectoryTransaction>();
  pendingEnterpriseSkillTransactions.set(expectedToken, round);
  return round;
}

function beginEnterpriseMarketSkillTransactionRound(
  expectedToken: string,
): Map<string, ManagedSkillDirectoryTransaction> {
  const previous = pendingEnterpriseMarketSkillTransactions.get(expectedToken);
  if (previous) {
    for (const transaction of previous.values()) {
      try { transaction.rollback(); } catch { /* next sync reports the new failure */ }
    }
  }
  pendingEnterpriseMarketSkillPreviousLedgers.set(
    expectedToken,
    normalizeManagedMarketSkillLedger(loadAgxConfig().enterprise?.managed_market_skills),
  );
  const round = new Map<string, ManagedSkillDirectoryTransaction>();
  pendingEnterpriseMarketSkillTransactions.set(expectedToken, round);
  return round;
}

function finalizeEnterpriseSkillSyncAfterIndexRefresh(
  capabilities: readonly EnterpriseCapability[],
  expectedToken: string,
  ok: boolean,
  message?: string,
  loadedCapabilityIds?: ReadonlySet<string>,
): boolean {
  const transactions = pendingEnterpriseSkillTransactions.get(expectedToken);
  const marketTransactions = pendingEnterpriseMarketSkillTransactions.get(expectedToken);
  const previousMarketLedger = pendingEnterpriseMarketSkillPreviousLedgers.get(expectedToken) ?? {};
  let marketSettlement: ReturnType<typeof settleManagedSkillDirectoryTransactions> = {
    committed: [],
    rolledBack: [],
    errors: [],
  };
  let legacyFinalizeFailed = false;
  let legacyFinalizeError: unknown;
  try {
    finalizeEnterpriseSkillSyncAfterIndexRefreshHelper(
      capabilities,
      expectedToken,
      ok,
      enterpriseCapabilitySyncConfigStore(),
      message,
      loadedCapabilityIds,
      transactions,
    );
  } catch (error) {
    // The registry/legacy finalizer can fail after it has staged or partially
    // settled its own rows.  Do not let that exception bypass the independent
    // market-Skill transaction below: a staged market candidate must still be
    // rolled back and its ledger restored before the original error escapes.
    legacyFinalizeFailed = true;
    legacyFinalizeError = error;
  } finally {
    pendingEnterpriseSkillTransactions.delete(expectedToken);
  }
  try {
    // The caller adds market item IDs to the same loaded-ID set after checking
    // their dedicated `enterprise-market/<dir>` paths.  An omitted set means
    // index refresh did not complete, so no staged market Skill may commit.
    const loaded = loadedCapabilityIds ?? new Set<string>();
    marketSettlement = settleManagedSkillDirectoryTransactions(
      marketTransactions ?? new Map(),
      ok && !legacyFinalizeFailed,
      loaded,
    );
  } catch (error) {
    // The settlement helper currently reports per-directory failures, but keep
    // this boundary fail-closed if a future implementation throws globally.
    // Treat every pending market item as failed so its previous ledger entry
    // is restored below, then preserve the first error for the caller.
    const action: "commit" | "rollback" = ok && !legacyFinalizeFailed
      ? "commit"
      : "rollback";
    marketSettlement = {
      committed: [],
      rolledBack: [],
      errors: [...(marketTransactions?.keys() ?? [])].map((capabilityId) => ({
        capabilityId,
        action,
        message: boundedCapabilityMessage(error) || "Skill 目录事务收敛失败",
      })),
    };
    if (!legacyFinalizeFailed) {
      legacyFinalizeFailed = true;
      legacyFinalizeError = error;
    }
  } finally {
    pendingEnterpriseMarketSkillTransactions.delete(expectedToken);
    pendingEnterpriseMarketSkillPreviousLedgers.delete(expectedToken);
  }
  const rolledBack = [...(transactions?.values() ?? [])]
    .filter((transaction) => transaction.state === "rolled_back");
  const rolledBackNewDirs = new Set(
    rolledBack.filter((transaction) => !transaction.hadPrevious).map((transaction) => transaction.dirName),
  );
  if (rolledBackNewDirs.size > 0) {
    const cfg = loadAgxConfig();
    if (
      cfg.enterprise?.enabled
      && String(cfg.enterprise.token ?? "").trim() === expectedToken.trim()
    ) {
      cfg.enterprise.managed_skills = (cfg.enterprise.managed_skills ?? [])
        .filter((dirName) => !rolledBackNewDirs.has(dirName));
      saveAgxConfig(cfg);
    }
  }
  const marketSettlementFailures = new Set(
    (marketSettlement?.rolledBack ?? []).concat(
      (marketSettlement?.errors ?? []).map((entry) => entry.capabilityId),
    ),
  );
  if (marketSettlementFailures.size > 0) {
    const cfg = loadAgxConfig();
    if (
      cfg.enterprise?.enabled
      && String(cfg.enterprise.token ?? "").trim() === expectedToken.trim()
    ) {
      const ledger = normalizeManagedMarketSkillLedger(cfg.enterprise.managed_market_skills);
      for (const capabilityId of marketSettlementFailures) {
        const previous = previousMarketLedger[capabilityId];
        if (previous) ledger[capabilityId] = previous;
        else delete ledger[capabilityId];
      }
      cfg.enterprise.managed_market_skills = ledger;
      saveAgxConfig(cfg);
    }
  }
  if (legacyFinalizeFailed) throw legacyFinalizeError;
  return rolledBack.length > 0 || marketSettlement.rolledBack.length > 0 || marketSettlement.errors.length > 0;
}

function failPendingEnterpriseCapabilitySyncStatuses(
  capabilities: readonly EnterpriseCapability[],
  expectedToken: string,
  message = "企业能力同步未完成，请重试",
): boolean {
  const targetedIds = new Set(capabilities.map((capability) => capability.id));
  const hadPending = normalizeEnterpriseCapabilitySyncStatuses(
    loadAgxConfig().enterprise?.capability_sync_statuses,
  ).some((status) =>
    targetedIds.has(status.capabilityId)
    && status.status !== "applied"
    && status.status !== "failed",
  );
  const result = failPendingEnterpriseCapabilitySyncStatusesHelper(
    capabilities,
    expectedToken,
    enterpriseCapabilitySyncConfigStore(),
    {
      errorCode: ENTERPRISE_CAPABILITY_SYNC_ERRORS.sync_incomplete,
      message,
    },
  );
  return result !== null && hadPending;
}

async function postEnterpriseCapabilityReceipt(
  capabilities: readonly EnterpriseCapability[],
  token: string,
  portalOrigin: string,
  options?: Parameters<typeof enqueueEnterpriseCapabilityReceipts>[4],
): Promise<EnterpriseCapabilityReceiptResult> {
  const cfg = loadAgxConfig();
  const statuses = normalizeEnterpriseCapabilitySyncStatuses(
    cfg.enterprise?.capability_sync_statuses,
  );
  return enqueueEnterpriseCapabilityReceipts(
    capabilities,
    statuses,
    token,
    portalOrigin,
    options,
  );
}

function persistEnterpriseCapabilityReceiptResult(
  result: EnterpriseCapabilityReceiptResult,
  expectedToken: string,
  isCurrent?: () => boolean,
): void | Promise<void> {
  return persistEnterpriseCapabilityReceiptSummaryHelper(
    result,
    expectedToken,
    enterpriseCapabilitySyncConfigStore(),
    isCurrent,
  );
}

function enterpriseManagedDeliveryCapabilities(
  capabilities: readonly EnterpriseCapability[],
): EnterpriseCapability[] {
  return capabilities.filter((capability) =>
    capability.kind === "mcp"
      // A Skill with a bundle URI is a managed-delivery item even when its
      // digest is missing/invalid: that failure must be visible in the ledger
      // and receipt.  Only a no-bundle Skill is self-service.
      || hasManagedSkillDelivery(capability),
  );
}

function scheduleEnterpriseCapabilityReceipt(
  capabilities: readonly EnterpriseCapability[],
  token: string,
  portalOrigin: string,
): void {
  const managed = enterpriseManagedDeliveryCapabilities(capabilities);
  if (managed.length === 0 || !token || !portalOrigin) return;
  const snapshot = loadAgxConfig().enterprise;
  const generation = enterpriseAuthGeneration;
  const normalizedOrigin = portalOrigin.replace(/\/+$/, "");
  const tenantId = String(snapshot?.user?.tenant_id ?? "").trim();
  const userId = String(snapshot?.user?.user_id ?? "").trim();
  const email = String(snapshot?.user?.email ?? "").trim().toLowerCase();
  const controller = new AbortController();
  const isCurrent = (): boolean => {
    if (controller.signal.aborted || generation !== enterpriseAuthGeneration) return false;
    const current = loadAgxConfig().enterprise;
    return Boolean(
      current?.enabled
      && String(current.token ?? "").trim() === token
      && String(current.base_url ?? "").trim().replace(/\/+$/, "") === normalizedOrigin
      && String(current.user?.tenant_id ?? "").trim() === tenantId
      && String(current.user?.user_id ?? "").trim() === userId
      && String(current.user?.email ?? "").trim().toLowerCase() === email
    );
  };
  if (!isCurrent()) return;
  enterpriseReceiptAbortControllers.add(controller);
  const queueKey = [normalizedOrigin, tenantId, userId || email, generation].join("\u0000");
  void postEnterpriseCapabilityReceipt(managed, token, portalOrigin, {
    isCurrent,
    queueKey,
    signal: controller.signal,
  })
    .then(async (result) => {
      await persistEnterpriseCapabilityReceiptResult(result, token, isCurrent);
      if (!result.ok) {
        if (!result.skipped) {
          console.warn(`[enterprise] 能力回执上报失败：${result.errorCode || "unknown"}`);
        }
      }
    })
    .catch((error) => {
      console.warn(`[enterprise] 能力回执上报失败：${boundedCapabilityMessage(error)}`);
    })
    .finally(() => {
      enterpriseReceiptAbortControllers.delete(controller);
    });
}

function enterpriseSkillsRoot(): string {
  return path.join(resolveDesktopAgxHome(), "skills", ENTERPRISE_SKILL_GROUP);
}

/**
 * Market Skills delivered by a capability pack have a separate namespace from
 * registry-managed Skills.  The item ID (not the mutable release content) is
 * the directory identity, so publishing v1.1 never creates a second copy and
 * revoking one item cannot remove another item. A desired snapshot containing
 * duplicate runtime Skill names is rejected before any directory is staged.
 */
const ENTERPRISE_MARKET_SKILL_GROUP = "enterprise-market";
const ENTERPRISE_MARKET_SKILL_DIR_RE = /^market-[0-9A-HJKMNP-TV-Z]{26}$/u;

function enterpriseMarketSkillsRoot(): string {
  return managedMarketSkillsRootHelper();
}

function normalizeManagedMarketSkillLedger(
  value: unknown,
): Record<string, { dirName: string; digest: string }> {
  return normalizeManagedMarketSkillLedgerHelper(value);
}

function enterpriseMarketSkillDirName(capabilityId: string): string | null {
  return managedMarketSkillDirNameHelper(capabilityId);
}

type ManagedMarketSkillPackage = ManagedMarketSkillPackageHelper;

function assertManagedMarketSkillTarget(target: string): void {
  const stat = fs.lstatSync(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("检测到非托管市场 Skill 目录，已停止覆盖");
  }
}

/**
 * Recover durable Skill transactions before Python can index the enterprise
 * directory. Use both the ledger and current assigned capabilities: a process
 * may have died after the directory swap but before saving the new ledger.
 */
function recoverInterruptedEnterpriseSkillTransactions(): string[] {
  const cfg = loadAgxConfig();
  const capabilities = normalizeEnterpriseCapabilities(cfg.enterprise?.capabilities);
  const dirNames = new Set([
    ...normalizeManagedSkillLedger(cfg.enterprise?.managed_skills),
    ...capabilities
      .filter((capability) => capability.kind === "skill" && hasManagedSkillDelivery(capability))
      .map((capability) => enterpriseSkillDirName(capability)),
  ]);
  const errors: string[] = [];
  for (const dirName of dirNames) {
    try {
      recoverInterruptedManagedSkillDirectory(enterpriseSkillsRoot(), dirName);
    } catch (error) {
      errors.push(`Skill ${dirName} 启动恢复失败：${boundedCapabilityMessage(error)}`);
    }
  }
  const marketDirNames = Object.values(
    normalizeManagedMarketSkillLedger(cfg.enterprise?.managed_market_skills),
  ).map((entry) => entry.dirName);
  for (const dirName of marketDirNames) {
    try {
      recoverInterruptedManagedMarketSkillDirectory(enterpriseMarketSkillsRoot(), dirName);
    } catch (error) {
      errors.push(`市场 Skill ${dirName} 启动恢复失败：${boundedCapabilityMessage(error)}`);
    }
  }
  return errors;
}

async function readMcpDocumentViaStudio(): Promise<McpDocument | null> {
  if (!isRemoteMode() && !(await waitForStudio(60_000))) return null;
  const result = await readEnterpriseMcpDocument({
    endpoint: `${getStudioUrl()}/api/mcp/raw`,
    path: ENTERPRISE_MCP_JSON_PATH,
    headers: { "x-agx-desktop-token": getStudioToken() },
    signal: AbortSignal.timeout(ENTERPRISE_PORTAL_FETCH_TIMEOUT_MS),
  });
  if (!result.ok) {
    console.warn(`[enterprise] MCP 配置读取失败（${result.errorCode}）`);
    return null;
  }
  return result.document;
}

async function writeMcpDocumentViaStudio(
  document: McpDocument,
  managedNames: readonly string[],
  requestedDeletions: readonly string[],
): Promise<boolean> {
  if (!isRemoteMode() && !(await waitForStudio(60_000))) return false;
  const servers = document.mcpServers && typeof document.mcpServers === "object"
    && !Array.isArray(document.mcpServers)
    ? document.mcpServers
    : {};
  const desiredManagedEntries = Object.fromEntries(
    managedNames.map((name) => [name, servers[name]]),
  );
  const result = await writeEnterpriseMcpDocumentAndConfirm({
    endpoint: `${getStudioUrl()}/api/mcp/raw`,
    path: ENTERPRISE_MCP_JSON_PATH,
    headers: { "x-agx-desktop-token": getStudioToken() },
    signal: AbortSignal.timeout(ENTERPRISE_PORTAL_FETCH_TIMEOUT_MS),
    document,
    desiredManagedEntries,
    requestedDeletions,
  });
  if (!result.ok) {
    console.warn(`[enterprise] MCP 配置写后确认失败（${result.errorCode}）`);
  }
  return result.ok;
}

async function fetchSkillBundleDetailed(
  uri: string,
  expectedDigest: string,
): Promise<EnterpriseSkillBundleFetchResultHelper> {
  return fetchSkillBundleDetailedHelper(uri, expectedDigest, ENTERPRISE_SKILL_MAX_BYTES);
}

function writeManagedSkill(
  capabilityId: string,
  dirName: string,
  content: string,
  transactions: Map<string, ManagedSkillDirectoryTransaction>,
): void {
  transactions.set(
    capabilityId,
    stageManagedSkillDirectory(enterpriseSkillsRoot(), dirName, content),
  );
}

function removeManagedSkill(dirName: string): void {
  // A revoke can be the first operation after a process died mid-update. Put
  // the directory back into a known state before deleting the managed target,
  // otherwise the durable LKG backup would be stranded as a hidden orphan.
  recoverInterruptedManagedSkillDirectory(enterpriseSkillsRoot(), dirName);
  const skillDir = resolveManagedSkillDirectory(enterpriseSkillsRoot(), dirName);
  if (!skillDir) return;
  // 没有标记就不是我们装的，不碰。
  if (!fs.existsSync(path.join(skillDir, ENTERPRISE_SKILL_MARKER))) return;
  fs.rmSync(skillDir, { recursive: true, force: true });
}

function removeManagedMarketSkill(dirName: string): void {
  if (!ENTERPRISE_MARKET_SKILL_DIR_RE.test(dirName)) {
    throw new Error("市场 Skill 目录名无效");
  }
  removeManagedMarketSkillDirectory(enterpriseMarketSkillsRoot(), dirName);
}

/**
 * 把这次下发的能力落到本机，并撤走上次装过、这次没下发的。
 *
 * 尽力而为：失败不影响登录本身，但会在日志里说清楚哪一条没成功——静默失败会让
 * 「后台明明分配了，员工那边就是没有」变成一个查不动的问题。
 */
type EnterpriseCapabilityDiskSyncResult = {
  ok: boolean;
  errors: string[];
};

type ManagedMarketSkillReconcileResult = {
  ok: boolean;
  errors: string[];
  managedSkillLedger: Record<string, { dirName: string; digest: string }>;
};

/**
 * Apply market Skills locally instead of sending them to the Studio portable
 * expert/group reconciler.  The latter owns avatar/group entities and must
 * never receive a Skill-shaped package.  A dedicated root + capability-ID
 * ledger gives market Skills their own lifecycle and makes revocation unable
 * to touch a voluntary `skills/market/<name>` installation.
 */
async function reconcileManagedMarketSkills(
  packages: readonly ManagedMarketSkillPackage[],
): Promise<ManagedMarketSkillReconcileResult> {
  const cfg = loadAgxConfig();
  const previous = normalizeManagedMarketSkillLedger(cfg.enterprise?.managed_market_skills);
  const errors: string[] = [];
  const root = enterpriseMarketSkillsRoot();
  const transactions = pendingEnterpriseMarketSkillTransactions.get(String(cfg.enterprise?.token ?? "").trim())
    ?? new Map<string, ManagedSkillDirectoryTransaction>();

  try {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  } catch (error) {
    return {
      ok: false,
      errors: [`企业市场 Skill 目录创建失败：${boundedCapabilityMessage(error)}`],
      managedSkillLedger: previous,
    };
  }

  // Normalize and plan the complete snapshot before touching disk. A malformed
  // or duplicate package must never be interpreted as an omitted item (which
  // would otherwise turn a bad response into an accidental revoke).
  const plan = planManagedMarketSkills(packages, previous);
  if (!plan.ok || !plan.desired) {
    return {
      ok: false,
      errors: [`企业市场 Skill 清单未通过完整校验，已保留可用版本${plan.rejected.length ? `：${plan.rejected.join("、")}` : ""}`],
      managedSkillLedger: previous,
    };
  }

  const next = { ...previous };
  const desiredIds = new Set(plan.desired.map((item) => item.id));
  for (const item of plan.desired) {
    const target = resolveManagedMarketSkillDirectory(root, item.dirName);
    if (!target) {
      errors.push(`市场 Skill ${item.id} 目录名无效，已保留可用版本`);
      continue;
    }
    try {
      if (fs.existsSync(target)) {
        assertManagedMarketSkillTarget(target);
        // A directory with our marker is ours, but a missing/invalid marker
        // still fails closed; never overwrite a user's file silently.
        if (!fs.existsSync(path.join(target, ENTERPRISE_SKILL_MARKER))) {
          throw new Error("检测到未标记目录");
        }
        const current = fs.readFileSync(path.join(target, "SKILL.md"), "utf8");
        const previousEntry = previous[item.id];
        if (
          previousEntry?.dirName === item.dirName
          && previousEntry.digest === item.digest
          && current === item.content
        ) {
          next[item.id] = { dirName: item.dirName, digest: item.digest };
          continue;
        }
      }
      const transaction = stageManagedMarketSkillDirectory(root, item.dirName, item.content);
      transactions.set(item.id, transaction);
      next[item.id] = { dirName: item.dirName, digest: item.digest };
    } catch (error) {
      errors.push(`市场 Skill ${item.id} 安装失败，已保留可用版本：${boundedCapabilityMessage(error)}`);
      // An update failure keeps the old ledger/target. A first install has no
      // LKG and therefore is deliberately absent from the resulting ledger.
      if (!previous[item.id]) delete next[item.id];
    }
  }

  for (const dirName of plan.remove) {
    const capabilityId = Object.entries(previous).find(([, entry]) => entry.dirName === dirName)?.[0];
    if (!capabilityId || desiredIds.has(capabilityId)) continue;
    try {
      removeManagedMarketSkill(dirName);
      delete next[capabilityId];
    } catch (error) {
      errors.push(`市场 Skill ${capabilityId} 撤回失败，保留重试：${boundedCapabilityMessage(error)}`);
    }
  }
  return { ok: errors.length === 0, errors, managedSkillLedger: next };
}

async function reconcileManagedPortablePackages(
  value: unknown,
): Promise<{ ok: boolean; errors: string[]; managedSkillLedger: Record<string, { dirName: string; digest: string }> }> {
  const currentLedger = normalizeManagedMarketSkillLedger(
    loadAgxConfig().enterprise?.managed_market_skills,
  );
  if (!Array.isArray(value)) {
    return {
      ok: false,
      errors: ["企业专家/群聊下发清单格式无效，已保留本机现状"],
      managedSkillLedger: currentLedger,
    };
  }
  const reconcilePayload = normalizeManagedPortableReconcilePayload(value);
  // Silently dropping one malformed desired item would make it indistinguishable
  // from a real revoke. Refuse the entire snapshot so last-known-good survives.
  if (!reconcilePayload) {
    return {
      ok: false,
      errors: ["企业专家/群聊下发清单包含无效条目，已保留本机现状"],
      managedSkillLedger: currentLedger,
    };
  }
  const skillPackages = reconcilePayload.packages.filter((item) => item.id.startsWith("skill:"));
  const runtimePackages = reconcilePayload.packages.filter((item) => !item.id.startsWith("skill:"));
  const skillResult = await reconcileManagedMarketSkills(skillPackages);
  const runtimePayload = { packages: runtimePackages };
  let runtimeResult: { ok: boolean; errors: string[] } = { ok: true, errors: [] };
  try {
    const response = await fetchStudioBackend("/api/portable-packages/managed/reconcile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(runtimePayload),
    });
    const body = (await response.json().catch(() => ({}))) as {
      ok?: unknown;
      errors?: unknown;
      detail?: unknown;
    };
    if (!response.ok) {
      runtimeResult = {
        ok: false,
        errors: [String(body.detail ?? `企业专家/群聊同步失败（HTTP ${response.status}）`)],
      };
    } else {
      const packageErrors = Array.isArray(body.errors)
        ? body.errors.map((entry) => {
            if (!isPlainJsonObject(entry)) return String(entry);
            const id = String(entry.id ?? "").trim();
            const message = String(entry.message ?? "同步失败").trim();
            return id ? `${id}: ${message}` : message;
          })
        : [];
      if (body.ok !== true && packageErrors.length === 0) {
        packageErrors.push("企业专家/群聊同步未完成，已保留可用版本");
      }
      runtimeResult = { ok: body.ok === true && packageErrors.length === 0, errors: packageErrors };
    }
  } catch (error) {
    runtimeResult = { ok: false, errors: [`企业专家/群聊同步失败：${String(error)}`] };
  }
  return {
    ok: runtimeResult.ok && skillResult.ok,
    errors: [...runtimeResult.errors, ...skillResult.errors],
    managedSkillLedger: skillResult.managedSkillLedger,
  };
}

async function syncEnterpriseCapabilitiesToDisk(
  managedPortablePackages?: unknown,
): Promise<EnterpriseCapabilityDiskSyncResult> {
  const cfg = loadAgxConfig();
  const ent = cfg.enterprise;
  if (!ent?.enabled) return { ok: true, errors: [] };
  const capabilities = normalizeEnterpriseCapabilities(ent.capabilities);
  const token = String(ent.token ?? "").trim();
  const errors: string[] = [];
  errors.push(...recoverInterruptedEnterpriseSkillTransactions());
  const skillTransactions = beginEnterpriseSkillTransactionRound(token);
  beginEnterpriseMarketSkillTransactionRound(token);

  const managedCapabilities = enterpriseManagedDeliveryCapabilities(capabilities);

  // A successful bootstrap is the desired-state boundary.  Do not leave rows
  // for capabilities which the portal has revoked; LKG metadata is retained
  // only while that capability is still assigned and an update is failing.
  pruneEnterpriseCapabilitySyncState(managedCapabilities, token);
  markEnterpriseCapabilitySyncStatusesWaiting(managedCapabilities, token);

  let managedMcpNames = [...(ent.managed_mcp_servers ?? [])];

  // MCP config errors are itemized but isolated.  A failed MCP read/write must
  // never prevent the Skill loop below from completing.
  const mcpCapabilities = capabilities.filter((item) => item.kind === "mcp");
  let document: McpDocument | null = null;
  try {
    document = await readMcpDocumentViaStudio();
  } catch (error) {
    console.warn(`[enterprise] MCP 配置读取失败：${boundedCapabilityMessage(error)}`);
  }
  if (!document) {
    for (const capability of mcpCapabilities) {
      recordEnterpriseCapabilitySyncStatus(
        capability,
        {
          status: "failed",
          errorCode: ENTERPRISE_CAPABILITY_SYNC_ERRORS.mcp_config_read_failed,
          message: "MCP 配置读取失败，已保留上次可用配置",
        },
        token,
      );
    }
    if (mcpCapabilities.length > 0) errors.push("MCP 配置读取失败");
  } else {
    let result: ReturnType<typeof syncEnterpriseMcpDocument>;
    try {
      result = syncEnterpriseMcpDocument(
        document,
        capabilities,
        token,
        ent.managed_mcp_servers ?? [],
      );
    } catch (error) {
      result = {
        document,
        managedNames: [...(ent.managed_mcp_servers ?? [])],
        conflicts: [],
        unavailable: [],
      };
      for (const capability of mcpCapabilities) {
        recordEnterpriseCapabilitySyncStatus(
          capability,
          {
            status: "failed",
            errorCode: ENTERPRISE_CAPABILITY_SYNC_ERRORS.mcp_config_read_failed,
            message: `MCP 配置解析失败：${boundedCapabilityMessage(error)}`,
          },
          token,
        );
      }
      errors.push("MCP 配置解析失败");
    }

    const conflictNames = new Set(result.conflicts);
    const unavailableNames = new Set(result.unavailable);
    const desiredCapabilities = mcpCapabilities.filter((capability) => {
      const name = enterpriseMcpEntryName(capability);
      if (unavailableNames.has(name)) {
        recordEnterpriseCapabilitySyncStatus(
          capability,
          {
            status: "failed",
            errorCode: ENTERPRISE_CAPABILITY_SYNC_ERRORS.mcp_endpoint_unavailable,
            message: "MCP 尚无可用网关地址",
          },
          token,
        );
        console.warn(`[enterprise] MCP 条目 ${name} 缺少网关地址，本次未下发`);
        errors.push(`MCP ${name} 尚无可用网关地址`);
        return false;
      }
      if (conflictNames.has(name)) {
        recordEnterpriseCapabilitySyncStatus(
          capability,
          {
            status: "failed",
            errorCode: ENTERPRISE_CAPABILITY_SYNC_ERRORS.mcp_conflict,
            message: "MCP 条目与本机已有条目冲突",
          },
          token,
        );
        console.warn(`[enterprise] MCP 条目 ${name} 已被本机占用，本次未下发`);
        errors.push(`MCP ${name} 与本机已有条目冲突`);
        return false;
      }
      recordEnterpriseCapabilitySyncStatus(capability, { status: "verifying" }, token);
      return true;
    });
    const removedNames = new Set(
      (ent.managed_mcp_servers ?? []).filter((name) => !result.managedNames.includes(name)),
    );
    let writeSucceeded = false;
    try {
      writeSucceeded = await writeMcpDocumentViaStudio(
        result.document,
        result.managedNames,
        [...removedNames],
      );
    } catch (error) {
      console.warn(`[enterprise] MCP 配置写入失败：${boundedCapabilityMessage(error)}`);
    }
    if (writeSucceeded) {
      managedMcpNames = result.managedNames;
      for (const capability of desiredCapabilities) {
        recordEnterpriseCapabilitySyncStatus(capability, { status: "applied" }, token);
      }
      // Removal rows are intentionally not synthesized: the desired snapshot
      // no longer contains those capability IDs and the ledger is pruned above.
    } else if (mcpCapabilities.length > 0 || removedNames.size > 0) {
      for (const capability of desiredCapabilities) {
        recordEnterpriseCapabilitySyncStatus(
          capability,
          {
            status: "failed",
            errorCode: removedNames.has(enterpriseMcpEntryName(capability))
              ? ENTERPRISE_CAPABILITY_SYNC_ERRORS.mcp_config_remove_failed
              : ENTERPRISE_CAPABILITY_SYNC_ERRORS.mcp_config_write_failed,
            message: removedNames.has(enterpriseMcpEntryName(capability))
              ? "MCP 配置撤回失败，已保留上次可用配置"
              : "MCP 配置落盘失败，已保留上次可用配置",
          },
          token,
        );
      }
      errors.push(
        removedNames.size > 0
          ? "MCP 配置写入或撤回失败"
          : "MCP 配置写入失败",
      );
    }
  }

  const managedSkillLedger = normalizeManagedSkillLedger(ent.managed_skills);
  const skillCollisions = findEnterpriseCapabilityNameCollisions(capabilities)
    .filter((collision) => collision.kind === "skill");
  const collidingSkillIds = new Set(skillCollisions.flatMap((collision) => collision.capabilityIds));
  const collidingSkillDirs = new Set(skillCollisions.map((collision) => collision.derivedName));
  const baseSkillPlan = planEnterpriseSkills(
    capabilities.filter((capability) => !collidingSkillIds.has(capability.id)),
    managedSkillLedger,
  );
  const plan = {
    ...baseSkillPlan,
    preserve: [...new Set([
      ...baseSkillPlan.preserve,
      ...managedSkillLedger.filter((dirName) => collidingSkillDirs.has(dirName)),
    ])],
    remove: baseSkillPlan.remove.filter((dirName) => !collidingSkillDirs.has(dirName)),
  };
  const previouslyManagedSkills = new Set(managedSkillLedger);
  const installed = new Set<string>();
  const preserveExistingManagedSkill = (dirName: string): boolean => {
    if (!previouslyManagedSkills.has(dirName)) return false;
    const skillDir = resolveManagedSkillDirectory(enterpriseSkillsRoot(), dirName);
    try {
      if (!skillDir) return false;
      if (!fs.existsSync(path.join(skillDir, ENTERPRISE_SKILL_MARKER))) return false;
      fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf8");
      installed.add(dirName);
      return true;
    } catch {
      return false;
    }
  };
  for (const collision of skillCollisions) {
    for (const capabilityId of collision.capabilityIds) {
      const capability = capabilities.find((item) => item.id === capabilityId && item.kind === "skill");
      if (!capability) continue;
      recordEnterpriseCapabilitySyncStatus(
        capability,
        {
          status: "failed",
          errorCode: ENTERPRISE_CAPABILITY_SYNC_ERRORS.name_collision,
          message: "多个企业 Skill 映射到同一本机目录，已保留上次可用版本",
        },
        token,
      );
    }
    errors.push(`Skill 本机目录 ${collision.derivedName} 存在名称冲突`);
  }
  for (const item of plan.install) {
    const capability = item.capability;
    recordEnterpriseCapabilitySyncStatus(capability, { status: "downloading" }, token);
    if (!/^[0-9a-f]{64}$/i.test(item.bundleDigest)) {
      recordEnterpriseCapabilitySyncStatus(
        capability,
        {
          status: "failed",
          errorCode: ENTERPRISE_CAPABILITY_SYNC_ERRORS.invalid_digest,
          message: "Skill 下发摘要不是有效的 SHA-256",
        },
        token,
      );
      errors.push(`Skill ${capability.name} 的下发摘要无效`);
      if (!preserveExistingManagedSkill(item.dirName)) {
        // There is no LKG to retain, so keep the failed status as-is.
      }
      continue;
    }
    try {
      const fetched = await fetchSkillBundleDetailed(item.bundleUri, item.bundleDigest);
      if (!fetched.ok) {
        console.warn(`[enterprise] Skill ${capability.name} ${fetched.message}`);
        recordEnterpriseCapabilitySyncStatus(
          capability,
          {
            status: "failed",
            errorCode: fetched.errorCode,
            digest: item.bundleDigest,
            message: fetched.message,
          },
          token,
        );
        errors.push(`Skill ${capability.name} ${fetched.message}`);
        preserveExistingManagedSkill(item.dirName);
        continue;
      }
      recordEnterpriseCapabilitySyncStatus(
        capability,
        { status: "verifying", digest: fetched.digest },
        token,
      );
      writeManagedSkill(capability.id, item.dirName, fetched.content, skillTransactions);
      installed.add(item.dirName);
      // Keep verifying until the Python Skill index confirms the directory is
      // loadable.  The caller finalizes this to applied after refresh succeeds.
    } catch (error) {
      console.warn(`[enterprise] Skill ${capability.name} 安装失败：${boundedCapabilityMessage(error)}`);
      recordEnterpriseCapabilitySyncStatus(
        capability,
        {
          status: "failed",
          errorCode: ENTERPRISE_CAPABILITY_SYNC_ERRORS.write_failed,
          message: "Skill 写入失败，已保留上次可用版本",
        },
        token,
      );
      errors.push(`Skill ${capability.name} 安装失败`);
      preserveExistingManagedSkill(item.dirName);
    }
  }
  for (const dirName of plan.preserve) {
    const skip = plan.skipped.find((item) => item.dirName === dirName);
    if (!preserveExistingManagedSkill(dirName) && skip) {
      const capability = capabilities.find((item) => item.id === skip.id);
      if (capability) {
        recordEnterpriseCapabilitySyncStatus(
          capability,
          {
            status: "failed",
            errorCode: ENTERPRISE_CAPABILITY_SYNC_ERRORS.load_failed,
            message: "Skill 上次可用版本读取失败",
          },
          token,
        );
        errors.push(`Skill ${capability.name} 上次可用版本读取失败`);
      }
    }
  }
  for (const skip of plan.skipped) {
    console.warn(`[enterprise] Skill ${skip.name} 未安装：${skip.reason}`);
    const capability = capabilities.find((item) => item.id === skip.id);
    if (skip.reason === "no-bundle") {
      // No bundle means approved self-service rather than managed delivery;
      // keep it out of the local sync ledger and receipt entirely.
    } else if (capability) {
      const errorCode = skip.reason === "insecure-uri"
        ? ENTERPRISE_CAPABILITY_SYNC_ERRORS.insecure_uri
        : skip.reason === "invalid-digest"
          ? ENTERPRISE_CAPABILITY_SYNC_ERRORS.invalid_digest
          : ENTERPRISE_CAPABILITY_SYNC_ERRORS.missing_digest;
      const message = skip.reason === "insecure-uri"
        ? "Skill 强制下发地址不安全（仅允许 HTTPS）"
        : skip.reason === "invalid-digest"
          ? "Skill 强制下发摘要不是有效的 SHA-256"
          : "Skill 强制下发缺少摘要";
      recordEnterpriseCapabilitySyncStatus(
        capability,
        { status: "failed", errorCode, message },
        token,
      );
      if (skip.reason === "insecure-uri") {
        errors.push(`Skill ${skip.name} 的强制下发地址不安全（仅允许 HTTPS）`);
      } else if (skip.reason === "no-digest") {
        errors.push(`Skill ${skip.name} 的强制下发缺少摘要`);
      } else if (skip.reason === "invalid-digest") {
        errors.push(`Skill ${skip.name} 的强制下发摘要无效`);
      }
    }
  }
  for (const dirName of plan.remove) {
    try {
      removeManagedSkill(dirName);
    } catch (error) {
      console.warn(`[enterprise] Skill 目录 ${dirName} 清理失败：${String(error)}`);
      errors.push(`Skill ${dirName} 撤回失败`);
      // 留在账本里，下次定时同步继续尝试；否则一次失败会把它变成永久孤儿。
      installed.add(dirName);
    }
  }
  let managedMarketSkills = normalizeManagedMarketSkillLedger(ent.managed_market_skills);
  if (managedPortablePackages !== undefined) {
    const portable = await reconcileManagedPortablePackages(managedPortablePackages);
    errors.push(...portable.errors);
    managedMarketSkills = portable.managedSkillLedger;
  }
  // 新装失败的不记账；原来已托管但本轮更新失败的保留账本，确保后续仍能更新或撤回。
  // I/O may take several seconds; reload before saving so an unrelated settings
  // IPC cannot be overwritten by this function's old whole-config snapshot.
  const latest = loadAgxConfig();
  if (
    !latest.enterprise?.enabled
    || String(latest.enterprise.token ?? "").trim() !== token
  ) {
    errors.push("企业登录状态已变化，未写入旧能力账本");
    return { ok: false, errors };
  }
  latest.enterprise = {
    ...latest.enterprise,
    managed_mcp_servers: [...managedMcpNames].sort(),
    managed_skills: [...installed].sort(),
    managed_market_skills: managedMarketSkills,
    managed_portable_cleanup_pending: false,
  };
  saveAgxConfig(latest);
  return { ok: errors.length === 0, errors };
}

type EnterpriseCapabilityWithdrawalResult = {
  remainingMcp: string[];
  remainingSkills: string[];
  remainingMarketSkills?: string[];
  portableCleanupPending: boolean;
  errors: string[];
};

function hasPendingEnterpriseCleanup(cfg: AgxConfig): boolean {
  const ent = cfg.enterprise;
  return Boolean(
    (ent?.managed_mcp_servers?.length ?? 0) > 0
      || (ent?.managed_skills?.length ?? 0) > 0
      || Object.keys(ent?.managed_market_skills ?? {}).length > 0
      || ent?.managed_portable_cleanup_pending === true,
  );
}

/** Keep failed cleanup entries as a token-free tombstone for the next retry/startup. */
function persistEnterpriseCleanupTombstone(
  cfg: AgxConfig,
  result: EnterpriseCapabilityWithdrawalResult,
): void {
  const enterprise = { ...(cfg.enterprise ?? {}) };
  if (result.remainingMcp.length > 0) {
    enterprise.managed_mcp_servers = [...new Set(result.remainingMcp)].sort();
  } else {
    delete enterprise.managed_mcp_servers;
  }
  if (result.remainingSkills.length > 0) {
    enterprise.managed_skills = [...new Set(result.remainingSkills)].sort();
  } else {
    delete enterprise.managed_skills;
  }
  if ((result.remainingMarketSkills?.length ?? 0) > 0) {
    const existing = normalizeManagedMarketSkillLedger(enterprise.managed_market_skills);
    const keep = new Set(result.remainingMarketSkills);
    enterprise.managed_market_skills = Object.fromEntries(
      Object.entries(existing).filter(([, entry]) => keep.has(entry.dirName)),
    );
  } else {
    delete enterprise.managed_market_skills;
  }
  if (result.portableCleanupPending) {
    enterprise.managed_portable_cleanup_pending = true;
  } else {
    delete enterprise.managed_portable_cleanup_pending;
  }
  if (Object.keys(enterprise).length > 0) cfg.enterprise = enterprise;
  else delete cfg.enterprise;
}

/** 退出企业账户：撤走本机装过的企业 MCP 与 Skill，并返回尚未清掉的精确账本。 */
async function withdrawEnterpriseCapabilitiesFromDisk(
  cfg: AgxConfig,
): Promise<EnterpriseCapabilityWithdrawalResult> {
  const ent = cfg.enterprise;
  const managedMcp = [...new Set(ent?.managed_mcp_servers ?? [])];
  const managedMarketSkills = normalizeManagedMarketSkillLedger(ent?.managed_market_skills);
  const remainingMcp: string[] = [];
  const remainingSkills: string[] = [];
  const remainingMarketSkills: string[] = [];
  let portableCleanupPending = false;
  const errors: string[] = [];
  if (managedMcp.length > 0) {
    try {
      const document = await readMcpDocumentViaStudio();
      if (!document) {
        remainingMcp.push(...managedMcp);
        errors.push("MCP 配置读取失败");
      } else if (
        !(await writeMcpDocumentViaStudio(
          removeEnterpriseMcpDocument(document, managedMcp),
          [],
          managedMcp,
        ))
      ) {
        remainingMcp.push(...managedMcp);
        errors.push("MCP 配置撤回写入失败");
      }
    } catch (error) {
      remainingMcp.push(...managedMcp);
      errors.push(`MCP 配置撤回失败：${String(error)}`);
    }
  }
  for (const dirName of normalizeManagedSkillLedger(ent?.managed_skills)) {
    try {
      removeManagedSkill(dirName);
    } catch (error) {
      remainingSkills.push(dirName);
      errors.push(`Skill ${dirName} 撤回失败：${String(error)}`);
    }
  }
  try {
    const portable = await reconcileManagedPortablePackages([]);
    if (!portable.ok) {
      portableCleanupPending = true;
      errors.push(...portable.errors);
    }
    remainingMarketSkills.push(
      ...Object.values(portable.managedSkillLedger).map((entry) => entry.dirName),
    );
  } catch (error) {
    portableCleanupPending = true;
    remainingMarketSkills.push(...Object.values(managedMarketSkills).map((entry) => entry.dirName));
    errors.push(`企业专家/群聊撤回失败：${String(error)}`);
  }
  return { remainingMcp, remainingSkills, remainingMarketSkills, portableCleanupPending, errors };
}

let enterpriseCleanupRetryScheduled = false;
let enterpriseCleanupRetryTimer: ReturnType<typeof setTimeout> | null = null;
const ENTERPRISE_CLEANUP_RETRY_MS = 30_000;

/** Retry token-free cleanup until it succeeds; a tombstone also survives restart. */
function schedulePendingEnterpriseCleanupRetry(): void {
  if (enterpriseCleanupRetryScheduled || enterpriseCleanupRetryTimer) return;
  const snapshot = loadAgxConfig();
  if (
    snapshot.enterprise?.enabled
    || String(snapshot.enterprise?.token ?? "").trim()
    || !hasPendingEnterpriseCleanup(snapshot)
  ) {
    return;
  }
  enterpriseCleanupRetryScheduled = true;
  void (async () => {
    let removedSkill = false;
    try {
      if (!(await waitForStudio(60_000))) return;
      await withEnterpriseMutationLock(async () => {
        const latest = loadAgxConfig();
        if (
          latest.enterprise?.enabled
          || String(latest.enterprise?.token ?? "").trim()
          || !hasPendingEnterpriseCleanup(latest)
        ) {
          return;
        }
        const beforeSkills = latest.enterprise?.managed_skills?.length ?? 0;
        const beforeMarketSkills = Object.keys(latest.enterprise?.managed_market_skills ?? {}).length;
        const result = await withdrawEnterpriseCapabilitiesFromDisk(latest);
        // The Studio round-trip above can overlap a normal settings save. Only
        // merge the enterprise cleanup result into a fresh config snapshot.
        const current = loadAgxConfig();
        if (current.enterprise?.enabled || String(current.enterprise?.token ?? "").trim()) {
          return;
        }
        persistEnterpriseCleanupTombstone(current, result);
        saveAgxConfig(current);
        removedSkill = result.remainingSkills.length < beforeSkills
          || (result.remainingMarketSkills?.length ?? 0) < beforeMarketSkills;
        if (result.errors.length > 0) {
          console.warn(`[enterprise] 退出后能力清理仍未完成：${result.errors.join("；")}`);
        }
      });
      if (removedSkill) {
        void refreshSkillIndexAfterEnterpriseChange().catch((error) => {
          console.warn(`[enterprise] 退出后刷新 Skill 索引失败：${String(error)}`);
        });
      }
    } finally {
      enterpriseCleanupRetryScheduled = false;
      const latest = loadAgxConfig();
      if (
        !latest.enterprise?.enabled
        && !String(latest.enterprise?.token ?? "").trim()
        && hasPendingEnterpriseCleanup(latest)
      ) {
        enterpriseCleanupRetryTimer = setTimeout(() => {
          enterpriseCleanupRetryTimer = null;
          schedulePendingEnterpriseCleanupRetry();
        }, ENTERPRISE_CLEANUP_RETRY_MS);
        // A retry watchdog must not keep Electron alive during a normal quit.
        enterpriseCleanupRetryTimer.unref?.();
      }
    }
  })();
}

type EmailConfig = {
  enabled: boolean;
  smtp_host: string;
  smtp_port: number;
  smtp_username: string;
  smtp_password: string;
  smtp_use_tls: boolean;
  from_email: string;
  default_to_email: string;
};

type TrinityConfig = {
  skill_protocol: boolean;
  session_summary: boolean;
  learning_enabled: boolean;
  skill_manage_enabled: boolean;
  learning_nudge_interval: number;
  learning_min_tool_calls: number;
};

type AutomationConfig = {
  prevent_sleep: boolean;
};

type TurnArchiveConfig = {
  enabled: boolean;
  min_chunk_chars: number;
  max_chunks_per_turn: number;
  recall_turns_limit: number;
  halflife_days: number;
};

type SkillInstallPolicyConfig = {
  non_high_risk_auto_install: boolean;
};

const CONFIG_DIR = resolveDesktopAgxHome();
// Make the isolated home explicit for every Python/CLI child process. This
// keeps subprocesses aligned with the Electron-side path resolver while still
// honoring an explicit AGX_HOME supplied by development or test harnesses.
process.env.AGX_HOME = CONFIG_DIR;
const SESSIONS_DIR = path.join(CONFIG_DIR, "sessions");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.yaml");
const DEFAULT_META_WORKSPACE_DIR = path.join(CONFIG_DIR, "workspace");

function expandDesktopLocalPath(input: string): string {
  const raw = String(input || "").trim();
  if (!raw) return "";
  const decoded = raw.startsWith("file://") ? decodeURIComponent(raw.replace(/^file:\/\//, "")) : raw;
  if (decoded === "~") return os.homedir();
  if (decoded.startsWith("~/")) return path.join(os.homedir(), decoded.slice(2));
  return path.normalize(decoded);
}

function resolveConfigWorkspaceDirRaw(cfg?: AgxConfig): string {
  const raw = String(cfg?.workspace_dir ?? "").trim();
  if (raw && !["none", "null"].includes(raw.toLowerCase())) return raw;
  return path.join(CONFIG_DIR, "workspace");
}

function resolveMetaWorkspaceDir(cfg?: AgxConfig): string {
  const expanded = expandDesktopLocalPath(resolveConfigWorkspaceDirRaw(cfg ?? loadAgxConfig()));
  if (!expanded) return DEFAULT_META_WORKSPACE_DIR;
  return path.resolve(expanded);
}

function metaWorkspaceMarkdownPath(filename: string, cfg?: AgxConfig): string {
  return path.join(resolveMetaWorkspaceDir(cfg), filename);
}

const AUTOMATION_TASKS_PATH = path.join(CONFIG_DIR, "automation_tasks.json");
const AUTOMATION_LOGS_DIR = path.join(CONFIG_DIR, "logs", "automation");

function automationLogPath(taskId: string): string {
  const id = String(taskId ?? "").trim() || "unknown";
  return path.join(AUTOMATION_LOGS_DIR, `${id}.log`);
}

/** Append a line to the task's persistent log file. Rotates when >2 MB. */
function appendAutomationLog(taskId: string, line: string): void {
  try {
    fs.mkdirSync(AUTOMATION_LOGS_DIR, { recursive: true });
    const file = automationLogPath(taskId);
    try {
      const st = fs.statSync(file);
      if (st.size > 2 * 1024 * 1024) {
        fs.renameSync(file, `${file}.1`);
      }
    } catch { /* first write */ }
    const ts = new Date().toISOString();
    fs.appendFileSync(file, `[${ts}] ${line.replace(/\s+$/,"")}\n`, "utf-8");
  } catch { /* best-effort */ }
}
/** 默认定时任务根目录：$AGX_HOME/crontask/<taskId>/，与用户指定 workspace 二选一；venv/脚本均应落在任务根下 */
const AUTOMATION_CRONTASK_DIR = path.join(CONFIG_DIR, "crontask");

function defaultAutomationCrontaskPath(taskId: string): string {
  return path.join(AUTOMATION_CRONTASK_DIR, String(taskId ?? "").trim());
}
const FEISHU_BINDING_PATH = path.join(CONFIG_DIR, "feishu_binding.json");
const LAYOUT_PATH = path.join(CONFIG_DIR, "layout.json");

type LayoutBounds = {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  isMaximized?: boolean;
};

type LayoutPaneSnapshot = {
  id: string;
  avatarId: string | null;
  sessionId: string;
  modelProvider: string;
  modelName: string;
};

type LayoutTheme = "dark" | "light" | "dim";

function normalizeLayoutTheme(raw: unknown): LayoutTheme | undefined {
  return raw === "light" || raw === "dark" || raw === "dim" ? raw : undefined;
}

type LayoutFile = {
  mainWindow?: LayoutBounds;
  panes?: LayoutPaneSnapshot[];
  activePaneId?: string;
  theme?: LayoutTheme;
};

/** Disk read for the pane/window layout. Returns an empty object on any error
 *  so first-launch / corrupted-file paths fall back to defaults. */
function loadLayoutData(): LayoutFile {
  try {
    const raw = fs.readFileSync(LAYOUT_PATH, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as LayoutFile;
  } catch {
    return {};
  }
}

/** Partial save that preserves fields we don't manage in this call. */
function saveLayoutData(patch: Partial<LayoutFile>): void {
  try {
    const prev = loadLayoutData();
    const merged: LayoutFile = { ...prev, ...patch };
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(LAYOUT_PATH, JSON.stringify(merged, null, 2), "utf-8");
  } catch {
    // best effort; layout persistence is not critical enough to crash the app
  }
}
const FEISHU_DESKTOP_BINDING_KEY = "_desktop";
const WECHAT_BINDING_PATH = path.join(CONFIG_DIR, "wechat_binding.json");
const WECHAT_DESKTOP_BINDING_KEY = "_desktop";

function clearWechatDesktopBindingIfDeleted(sessionIds: string[]): void {
  const deletedIds = new Set(sessionIds.map((sid) => String(sid || "").trim()).filter(Boolean));
  if (deletedIds.size === 0) return;
  let data: Record<string, unknown> = {};
  try {
    const raw = fs.readFileSync(WECHAT_BINDING_PATH, "utf-8");
    data = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return;
  }
  const desktopBinding = data[WECHAT_DESKTOP_BINDING_KEY];
  if (!desktopBinding || typeof desktopBinding !== "object" || Array.isArray(desktopBinding)) {
    return;
  }
  const boundSid = String((desktopBinding as { session_id?: unknown }).session_id ?? "").trim();
  if (!boundSid || !deletedIds.has(boundSid)) return;
  delete data[WECHAT_DESKTOP_BINDING_KEY];
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(WECHAT_BINDING_PATH, JSON.stringify(data, null, 2), "utf-8");
}
const EMAIL_CONFIG_KEYS = new Set([
  "enabled",
  "smtp_host",
  "smtp_port",
  "smtp_username",
  "smtp_password",
  "smtp_use_tls",
  "from_email",
  "default_to_email",
]);
const DEFAULT_EMAIL_CONFIG: EmailConfig = {
  enabled: true,
  smtp_host: "",
  smtp_port: 587,
  smtp_username: "",
  smtp_password: "",
  smtp_use_tls: true,
  from_email: "",
  default_to_email: "bingzhenli@hotmail.com",
};
const TRINITY_CONFIG_KEYS = new Set([
  "skill_protocol",
  "session_summary",
  "learning_enabled",
  "skill_manage_enabled",
  "learning_nudge_interval",
  "learning_min_tool_calls",
]);
const DEFAULT_TRINITY_CONFIG: TrinityConfig = {
  skill_protocol: true,
  session_summary: false,
  learning_enabled: false,
  skill_manage_enabled: false,
  learning_nudge_interval: 10,
  learning_min_tool_calls: 5,
};

const DEFAULT_AUTOMATION_CONFIG: AutomationConfig = {
  prevent_sleep: false,
};

const TURN_ARCHIVE_CONFIG_KEYS = new Set([
  "enabled",
  "min_chunk_chars",
  "max_chunks_per_turn",
  "recall_turns_limit",
  "halflife_days",
]);

const DEFAULT_TURN_ARCHIVE_CONFIG: TurnArchiveConfig = {
  enabled: false,
  min_chunk_chars: 40,
  max_chunks_per_turn: 3,
  recall_turns_limit: 3,
  halflife_days: 7,
};

const DEFAULT_SKILL_INSTALL_POLICY: SkillInstallPolicyConfig = {
  non_high_risk_auto_install: true,
};

let preventSleepBlockerId: number | null = null;

function loadAutomationConfigFromAgx(cfg: AgxConfig): AutomationConfig {
  const raw = cfg.automation;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ...DEFAULT_AUTOMATION_CONFIG };
  }
  const row = raw as Record<string, unknown>;
  return {
    prevent_sleep: parseBooleanLoose(row.prevent_sleep, DEFAULT_AUTOMATION_CONFIG.prevent_sleep),
  };
}

function loadSkillInstallPolicyFromAgx(cfg: AgxConfig): SkillInstallPolicyConfig {
  const raw = cfg.skills;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ...DEFAULT_SKILL_INSTALL_POLICY };
  }
  const row = raw as Record<string, unknown>;
  return {
    non_high_risk_auto_install: parseBooleanLoose(
      row.non_high_risk_auto_install,
      DEFAULT_SKILL_INSTALL_POLICY.non_high_risk_auto_install
    ),
  };
}

function applyPreventSleepFromConfig(cfg: AgxConfig): void {
  const enabled = loadAutomationConfigFromAgx(cfg).prevent_sleep;
  if (enabled) {
    if (preventSleepBlockerId === null) {
      preventSleepBlockerId = powerSaveBlocker.start("prevent-app-suspension");
    }
  } else if (preventSleepBlockerId !== null) {
    powerSaveBlocker.stop(preventSleepBlockerId);
    preventSleepBlockerId = null;
  }
}

// ── Automation Tasks ──

type AutomationFrequency =
  | { type: "daily"; time: string; days: number[] }
  | { type: "interval"; hours: number; days: number[] }
  | { type: "once"; time: string; date: string };

interface AutomationTaskData {
  id: string;
  name: string;
  prompt: string;
  workspace?: string;
  sessionId?: string;
  /** 与 ChatRequest 对齐；两者都非空时用于创建会话与每次 /api/chat */
  provider?: string;
  model?: string;
  frequency: AutomationFrequency;
  effectiveDateRange?: { start?: string; end?: string };
  enabled: boolean;
  createdAt: string;
  lastRunAt?: string;
  lastRunStatus?: "success" | "error";
  lastRunError?: string;
  fromTemplate?: string;
}

function sanitizeAutomationRunError(raw: unknown): string | undefined {
  const s = String(raw ?? "")
    .trim()
    .replace(/\s+/g, " ");
  if (!s) return undefined;
  return s.length > 280 ? `${s.slice(0, 277)}...` : s;
}

type AutomationTaskProgressPayload = {
  taskId: string;
  taskName: string;
  trigger: "schedule" | "manual";
  phase: "queued" | "running" | "success" | "error";
  sessionId?: string;
  message?: string;
  ts: number;
};

function loadAutomationTasks(): AutomationTaskData[] {
  try {
    if (!fs.existsSync(AUTOMATION_TASKS_PATH)) return [];
    const raw = fs.readFileSync(AUTOMATION_TASKS_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveAutomationTasks(tasks: AutomationTaskData[]): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(AUTOMATION_TASKS_PATH, JSON.stringify(tasks, null, 2), "utf-8");
}

/** Max wait for one automation /api/chat SSE (ms). Prevents sidebar spinner stuck if stream never closes. */
function resolveAutomationChatTimeoutMs(): number {
  const raw = String(process.env.AGX_AUTOMATION_CHAT_TIMEOUT_MS ?? "").trim();
  if (!raw) return 1_800_000; // 30 min
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 60_000 ? n : 1_800_000;
}

/** In-flight automation run (scheduled or「立即执行」) — user can abort via IPC. */
const automationRunControllers = new Map<string, AbortController>();
const automationRunUserCancelled = new Set<string>();

function resolveAutomationSessionId(task: AutomationTaskData, override?: string): string {
  const o = String(override ?? "").trim();
  if (o) return o;
  return String(task.sessionId ?? "").trim();
}

async function drainSseChatResponse(
  resp: Response,
  taskId?: string,
): Promise<{ ok: boolean; error?: string }> {
  const tid = String(taskId ?? "").trim();
  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    const msg = `HTTP ${resp.status}: ${t.slice(0, 400)}`;
    if (tid) appendAutomationLog(tid, `[chat.http_error] ${msg}`);
    return { ok: false, error: msg };
  }
  const reader = resp.body?.getReader();
  if (!reader) return { ok: true };
  const dec = new TextDecoder();
  let buffer = "";
  let sseEvents = 0;
  let toolCalls = 0;
  let assistantChars = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += dec.decode(value, { stream: true });
      while (true) {
        const sep = buffer.indexOf("\n\n");
        if (sep === -1) break;
        const chunk = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        for (const line of chunk.split("\n")) {
          const m = line.match(/^data:\s*(.+)$/);
          if (!m) continue;
          sseEvents += 1;
          try {
            const obj = JSON.parse(m[1]) as {
              type?: string;
              data?: { text?: string; name?: string };
            };
            if (tid) {
              const t = String(obj.type ?? "");
              if (t === "tool_call" || t === "tool_result") {
                toolCalls += 1;
                const nm = String(obj.data?.name ?? "");
                if (nm) appendAutomationLog(tid, `[chat.sse] ${t} name=${nm}`);
              } else if (t === "token") {
                assistantChars += String(obj.data?.text ?? "").length;
              } else if (t === "assistant_delta" || t === "assistant_text") {
                assistantChars += String(obj.data?.text ?? "").length;
              } else if (t && t !== "done") {
                // Keep a compact record for other event types.
                appendAutomationLog(tid, `[chat.sse] ${t}`);
              }
            }
            if (obj.type === "error") {
              const msg = String(obj.data?.text ?? "Agent 流式错误");
              if (tid) appendAutomationLog(tid, `[chat.sse.error] ${msg.slice(0, 1200)}`);
              return { ok: false, error: msg.slice(0, 800) };
            }
            if (obj.type === "done") {
              if (tid) {
                appendAutomationLog(
                  tid,
                  `[chat.done] events=${sseEvents} tool_calls=${toolCalls} assistant_chars=${assistantChars}`,
                );
              }
              return { ok: true };
            }
          } catch {
            /* ignore non-JSON sse lines */
          }
        }
      }
      if (buffer.length > 4_000_000) break;
    }
  } finally {
    reader.releaseLock();
  }
  if (tid) {
    appendAutomationLog(
      tid,
      `[chat.stream_ended_without_done] events=${sseEvents} tool_calls=${toolCalls}`,
    );
  }
  return { ok: true };
}

async function invokeAutomationUserTurnWithSignal(
  base: string,
  token: string,
  sessionId: string,
  task: AutomationTaskData,
  userInput: string,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<{ ok: boolean; error?: string }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["x-agx-desktop-token"] = token;
  const pathTrim = String(task.workspace ?? "").trim();
  if (pathTrim) {
    try {
      const wsResp = await fetch(`${base}/api/taskspace/workspaces`, {
        method: "POST",
        headers,
        body: JSON.stringify({ session_id: sessionId, path: pathTrim }),
      });
      if (!wsResp.ok) {
        const t = await wsResp.text().catch(() => "");
        console.warn(
          `[automation] taskspace attach failed: HTTP ${wsResp.status} ${t.slice(0, 240)} (session=${sessionId})`,
        );
      }
    } catch (e) {
      console.warn("[automation] taskspace attach error:", e);
    }
  }
  const tid = String(task.id ?? "").trim();
  const prov = String(task.provider ?? "").trim();
  const mod = String(task.model ?? "").trim();
  const chatBody: Record<string, unknown> = {
    session_id: sessionId,
    user_input: userInput,
    // interactive：不把任务提示词包进 AutoSolve 长模板写入历史；避免与飞书/AgenticX Ontology 会话混淆且便于删除持久化
    mode: "interactive",
  };
  if (prov && mod) {
    chatBody.provider = prov;
    chatBody.model = mod;
  }
  try {
    appendAutomationLog(
      tid,
      `[chat.request] session=${sessionId.slice(0, 8)}… provider=${prov || "default"} model=${mod || "default"} prompt_chars=${userInput.length} workspace=${pathTrim || "(default)"}`,
    );
    const resp = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers,
      body: JSON.stringify(chatBody),
      signal,
    });
    return await drainSseChatResponse(resp, tid);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    const name = e instanceof Error ? e.name : "";
    const cause =
      e && typeof e === "object" && "cause" in (e as Record<string, unknown>)
        ? String((e as { cause?: unknown }).cause ?? "")
        : "";
    appendAutomationLog(
      tid,
      `[chat.exception] name=${name} msg=${msg.slice(0, 400)}${cause ? ` cause=${cause.slice(0, 400)}` : ""}`,
    );
    const aborted =
      name === "AbortError" || /aborted|AbortError/i.test(msg);
    if (aborted) {
      if (automationRunUserCancelled.has(tid)) {
        return { ok: false, error: "已手动终止本次自动化执行。" };
      }
      const mins = Math.max(1, Math.round(timeoutMs / 60_000));
      return {
        ok: false,
        error: `自动化执行超时（>${mins} 分钟）。侧栏已停止转圈；可缩短提示词、换模型或设置环境变量 AGX_AUTOMATION_CHAT_TIMEOUT_MS 调大上限。`,
      };
    }
    return { ok: false, error: msg.slice(0, 800) };
  }
}

async function createAutomationTaskSession(
  base: string,
  token: string,
  task: AutomationTaskData,
): Promise<string | undefined> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["x-agx-desktop-token"] = token;
  const prov = String(task.provider ?? "").trim();
  const mod = String(task.model ?? "").trim();
  const body: Record<string, unknown> = {
    avatar_id: `automation:${task.id}`,
    name: task.name,
  };
  if (prov && mod) {
    body.provider = prov;
    body.model = mod;
  }
  const resp = await fetch(`${base}/api/sessions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!resp.ok) return undefined;
  const data = (await resp.json()) as { session_id?: unknown };
  const sid = String(data.session_id ?? "").trim();
  return sid || undefined;
}

function persistAutomationTaskSession(taskId: string, sessionId: string): void {
  const tid = String(taskId ?? "").trim();
  const sid = String(sessionId ?? "").trim();
  if (!tid || !sid) return;
  const tasks = loadAutomationTasks();
  const found = tasks.find((t) => t.id === tid);
  if (!found) return;
  found.sessionId = sid;
  saveAutomationTasks(tasks);
}

type AutomationSessionBindCheck =
  | { kind: "match" }
  | { kind: "mismatch"; avatarLabel: string }
  | { kind: "unknown" };

async function checkAutomationSessionBinding(
  base: string,
  token: string,
  taskId: string,
  sessionId: string,
): Promise<AutomationSessionBindCheck> {
  const tid = String(taskId ?? "").trim();
  if (!tid) return { kind: "unknown" };
  const expected = `automation:${tid}`;
  try {
    const headers: Record<string, string> = {};
    if (token) headers["x-agx-desktop-token"] = token;

    // IMPORTANT: never call /api/session here.
    // /api/session has "get-or-create" semantics, which can accidentally create
    // a brand-new unbound(meta) session when the old sessionId has expired.
    // That side effect is exactly what pollutes Meta history with short-id rows.
    const matchResp = await fetch(
      `${base}/api/sessions?avatar_id=${encodeURIComponent(expected)}`,
      { headers },
    );
    if (!matchResp.ok) return { kind: "unknown" };
    const matchData = (await matchResp.json()) as {
      sessions?: Array<{ session_id?: string | null }>;
    };
    const boundRows = Array.isArray(matchData.sessions) ? matchData.sessions : [];
    const sid = String(sessionId ?? "").trim();
    if (
      boundRows.some((row) => String(row?.session_id ?? "").trim() === sid)
    ) {
      return { kind: "match" };
    }

    // Not in expected automation bucket. Check global list once to infer label.
    const allResp = await fetch(`${base}/api/sessions`, { headers });
    if (!allResp.ok) return { kind: "unknown" };
    const allData = (await allResp.json()) as {
      sessions?: Array<{ session_id?: string | null; avatar_id?: string | null }>;
    };
    const allRows = Array.isArray(allData.sessions) ? allData.sessions : [];
    const current = allRows.find((row) => String(row?.session_id ?? "").trim() === sid);
    if (!current) return { kind: "unknown" };
    const avs = String(current.avatar_id ?? "").trim();
    const label = avs.length > 0 ? avs : "（空/元智能体会话）";
    return { kind: "mismatch", avatarLabel: label };
  } catch {
    return { kind: "unknown" };
  }
}

async function runAutomationTaskHttp(
  task: AutomationTaskData,
  options?: {
    sessionIdOverride?: string;
    reusePersistedSession?: boolean;
    /** Fires once the session id that will actually be used has been determined. */
    onSessionReady?: (sessionId: string) => void;
  },
): Promise<{ ok: boolean; error?: string; sessionId?: string }> {
  const portFile = path.join(CONFIG_DIR, "serve.port");
  const tokenFile = path.join(CONFIG_DIR, "serve.token");
  if (!fs.existsSync(portFile)) {
    return { ok: false, error: "agx serve 未运行（缺少 serve.port）" };
  }
  const port = fs.readFileSync(portFile, "utf-8").trim();
  const token = fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, "utf-8").trim() : "";
  const base = `http://127.0.0.1:${port}`;
  const override = String(options?.sessionIdOverride ?? "").trim();
  const reusePersisted = Boolean(options?.reusePersistedSession);
  let sessionId = "";
  if (override) {
    sessionId = override;
  } else if (reusePersisted) {
    sessionId = String(task.sessionId ?? "").trim();
  }
  const tidEarly = String(task.id ?? "").trim();
  appendAutomationLog(
    tidEarly || "unknown",
    `[run.begin] task=${task.name} reuse_persisted=${reusePersisted} override_provided=${Boolean(override)}`,
  );
  if (!sessionId) {
    const newSid = await createAutomationTaskSession(base, token, task);
    if (!newSid) {
      appendAutomationLog(
        tidEarly || "unknown",
        "[run.session_create_failed] agx serve 可能未运行或 /api/sessions 拒绝请求",
      );
      return {
        ok: false,
        error:
          "无法自动创建定时任务专属会话：请确认本机 agx serve 已启动。若仍失败，可在侧栏「定时」中点击该任务打开聊天窗格后再试。",
      };
    }
    task.sessionId = newSid;
    persistAutomationTaskSession(task.id, newSid);
    sessionId = newSid;
    appendAutomationLog(
      tidEarly || "unknown",
      `[run.session_created] new=${newSid}`,
    );
  } else {
    appendAutomationLog(
      tidEarly || "unknown",
      `[run.session_reused] existing=${sessionId.slice(0, 8)}…`,
    );
  }
  if (options?.onSessionReady) {
    try {
      options.onSessionReady(sessionId);
    } catch {
      /* best-effort notifier */
    }
  }
  const bind = await checkAutomationSessionBinding(base, token, task.id, sessionId);
  if (bind.kind === "mismatch") {
    const repairedSid = await createAutomationTaskSession(base, token, task);
    if (!repairedSid) {
      return {
        ok: false,
        sessionId,
        error: `会话与定时任务不匹配（当前绑定：${bind.avatarLabel}），自动创建 automation 专属会话失败。请在侧栏「定时」中打开该任务后再试。`,
      };
    }
    task.sessionId = repairedSid;
    persistAutomationTaskSession(task.id, repairedSid);
    sessionId = repairedSid;
  }
  const prompt = String(task.prompt ?? "").trim();
  if (!prompt) return { ok: false, error: "任务提示词为空" };
  const tid = String(task.id ?? "").trim();
  if (!tid) return { ok: false, error: "任务 id 无效" };

  const ac = new AbortController();
  automationRunControllers.set(tid, ac);
  const timeoutMs = resolveAutomationChatTimeoutMs();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const first = await invokeAutomationUserTurnWithSignal(
      base,
      token,
      sessionId,
      task,
      prompt,
      ac.signal,
      timeoutMs,
    );
    if (first.ok) return { ...first, sessionId };

    const firstErr = String(first.error ?? "");
    if (!/HTTP\s*404/i.test(firstErr) && !/session not found/i.test(firstErr)) {
      return { ...first, sessionId };
    }

    const repairedSid = await createAutomationTaskSession(base, token, task);
    if (!repairedSid) {
      return {
        ok: false,
        sessionId,
        error: `会话失效且自动重建失败：${sanitizeAutomationRunError(firstErr) ?? "session not found"}`,
      };
    }

    task.sessionId = repairedSid;
    persistAutomationTaskSession(task.id, repairedSid);
    const second = await invokeAutomationUserTurnWithSignal(
      base,
      token,
      repairedSid,
      task,
      prompt,
      ac.signal,
      timeoutMs,
    );
    if (second.ok) return { ...second, sessionId: repairedSid };
    return {
      ...second,
      sessionId: repairedSid,
      error: `会话已自动重建，但执行失败：${sanitizeAutomationRunError(second.error) ?? "未知错误"}`,
    };
  } finally {
    clearTimeout(timer);
    automationRunControllers.delete(tid);
    automationRunUserCancelled.delete(tid);
    appendAutomationLog(tid, "[run.end]");
  }
}

class AutomationScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastCheckMinute = "";

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), 30_000);
    this.tick();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  reload(): void {
    /* no-op: we load from disk each tick */
  }

  private tick(): void {
    const now = new Date();
    const minuteKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}T${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    if (minuteKey === this.lastCheckMinute) return;
    this.lastCheckMinute = minuteKey;

    const tasks = loadAutomationTasks();
    const dayOfWeek = now.getDay() === 0 ? 7 : now.getDay(); // 1=Mon..7=Sun
    const currentTime = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    const currentDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

    let dirty = false;
    for (const task of tasks) {
      if (!task.enabled) continue;
      if (!this.isWithinDateRange(task, currentDate)) continue;
      if (!this.shouldRun(task, currentTime, currentDate, dayOfWeek)) continue;
      if (task.lastRunAt && task.lastRunAt.startsWith(minuteKey)) continue;

      task.lastRunAt = now.toISOString();
      dirty = true;
      // queued phase intentionally emits without sessionId:
      // a new automation session is created inside executeTask (每次触发新开 session)，
      // 若此处就用 task.sessionId 打开窗格，会先显示上一轮的旧会话历史。
      emitAutomationTaskProgress({
        taskId: task.id,
        taskName: task.name,
        trigger: "schedule",
        phase: "queued",
        sessionId: undefined,
        ts: Date.now(),
      });
      void this.executeTask(task);
    }
    if (dirty) saveAutomationTasks(tasks);
  }

  private isWithinDateRange(task: AutomationTaskData, currentDate: string): boolean {
    const range = task.effectiveDateRange;
    if (!range) return true;
    if (range.start && currentDate < range.start) return false;
    if (range.end && currentDate > range.end) return false;
    return true;
  }

  private shouldRun(task: AutomationTaskData, currentTime: string, currentDate: string, dayOfWeek: number): boolean {
    const freq = task.frequency;
    switch (freq.type) {
      case "daily":
        return freq.time === currentTime && freq.days.includes(dayOfWeek);
      case "interval": {
        if (!freq.days.includes(dayOfWeek)) return false;
        const hour = new Date().getHours();
        return hour % freq.hours === 0 && currentTime.endsWith(":00");
      }
      case "once":
        return freq.date === currentDate && freq.time === currentTime;
      default:
        return false;
    }
  }

  private async executeTask(task: AutomationTaskData): Promise<void> {
    try {
      const result = await runAutomationTaskHttp(task, {
        reusePersistedSession: false,
        onSessionReady: (newSid) => {
          emitAutomationTaskProgress({
            taskId: task.id,
            taskName: task.name,
            trigger: "schedule",
            phase: "running",
            sessionId: newSid,
            ts: Date.now(),
          });
        },
      });
      const tasks = loadAutomationTasks();
      const found = tasks.find((t) => t.id === task.id);
      if (found) {
        found.lastRunStatus = result.ok ? "success" : "error";
        found.lastRunAt = new Date().toISOString();
        if (result.ok) {
          delete found.lastRunError;
        } else {
          found.lastRunError = sanitizeAutomationRunError(result.error) ?? "执行失败";
        }
        saveAutomationTasks(tasks);
      }
      emitAutomationTaskProgress({
        taskId: task.id,
        taskName: task.name,
        trigger: "schedule",
        phase: result.ok ? "success" : "error",
        sessionId: result.sessionId || resolveAutomationSessionId(task) || undefined,
        message: result.error,
        ts: Date.now(),
      });
    } catch (err) {
      const tasks = loadAutomationTasks();
      const found = tasks.find((t) => t.id === task.id);
      if (found) {
        found.lastRunStatus = "error";
        found.lastRunAt = new Date().toISOString();
        found.lastRunError = sanitizeAutomationRunError(err) ?? "执行异常";
        saveAutomationTasks(tasks);
      }
      emitAutomationTaskProgress({
        taskId: task.id,
        taskName: task.name,
        trigger: "schedule",
        phase: "error",
        sessionId: resolveAutomationSessionId(task) || undefined,
        message: String(err),
        ts: Date.now(),
      });
    }
  }
}

const automationScheduler = new AutomationScheduler();

const KNOWN_BASE_URLS: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
  volcengine: "https://ark.cn-beijing.volces.com/api/v3",
  zhipu: "https://open.bigmodel.cn/api/paas/v4",
  bailian: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  qianfan: "https://aip.baidubce.com/rpc/2.0/ai_custom/v1",
  minimax: "https://api.minimax.chat/v1",
  kimi: "https://api.moonshot.cn/v1",
  deepseek: "https://api.deepseek.com/v1",
};

/** Treat UI placeholders as empty so we do not send `Bearer sk-...` to intranet gateways. */
function normalizeProviderApiKey(apiKey: string | undefined): string {
  const key = (apiKey ?? "").trim();
  if (!key) return "";
  if (/^sk-\.{2,}$/i.test(key)) return "";
  if (key === "sk-" || key.toLowerCase() === "your-api-key") return "";
  return key;
}

/** Omit Authorization when key is empty — intranet OpenAI-compatible gateways often need no auth. */
function openAiCompatAuthHeaders(apiKey: string | undefined): Record<string, string> {
  const key = normalizeProviderApiKey(apiKey);
  if (!key) return {};
  return { Authorization: `Bearer ${key}` };
}

function isModelsCatalogMissing(status: number, body: string): boolean {
  if (status === 404 || status === 405) return true;
  if (status !== 400 && status !== 422) return false;
  const lower = body.toLowerCase();
  return (
    lower.includes("not found")
    || lower.includes("not_found")
    || lower.includes("no route")
    || lower.includes("unknown path")
    || lower.includes("不存在")
  );
}

function isChatProbeTokenLimitFalseNegative(status: number, body: string): boolean {
  if (status !== 400) return false;
  const lower = body.toLowerCase();
  return (
    lower.includes("max_tokens")
    && (
      lower.includes("model output limit")
      || lower.includes("was reached")
      || lower.includes("too small")
      || lower.includes("must be")
    )
  );
}

function usesCustomBaseUrl(provider: string, baseUrl?: string): boolean {
  const custom = (baseUrl ?? "").trim().replace(/\/+$/, "");
  if (!custom) return false;
  const known = (KNOWN_BASE_URLS[provider] ?? "").replace(/\/+$/, "");
  return custom !== known;
}

/** Many enterprise gateways only expose /chat/completions (no GET /models). */
async function probeOpenAiCompatChatReachable(
  base: string,
  apiKey: string,
): Promise<{ ok: boolean; error?: string }> {
  const url = `${base}/chat/completions`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    const resp = await proxyAwareFetch(url, {
      method: "POST",
      headers: {
        ...openAiCompatAuthHeaders(apiKey),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "__near_connectivity_probe__",
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (resp.ok) return { ok: true };
    const body = await resp.text().catch(() => "");
    if (resp.status === 401 || resp.status === 403) {
      return { ok: false, error: `HTTP ${resp.status}: ${body.slice(0, 200)}` };
    }
    if (resp.status >= 500) {
      return { ok: false, error: `HTTP ${resp.status}: ${body.slice(0, 200)}` };
    }
    // Model/route validation errors still prove the chat endpoint is reachable.
    if (resp.status >= 400 && resp.status < 500) return { ok: true };
    return { ok: false, error: `HTTP ${resp.status}: ${body.slice(0, 200)}` };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

// Bailian/DashScope vector models. The OpenAI-compatible `/models` endpoint
// does not list embedding SKUs, so we merge this catalog into fetch-models for
// the bailian provider (and any base URL pointing at dashscope). Keep in sync
// with desktop/src/utils/model-kind.ts.
const BAILIAN_TEXT_EMBEDDING_MODELS = [
  "text-embedding-v4",
  "text-embedding-v3",
  "text-embedding-v2",
  "text-embedding-v1",
];

const BAILIAN_MULTIMODAL_EMBEDDING_MODELS = [
  "multimodal-embedding-v1",
  "qwen3-vl-embedding",
  "qwen2.5-vl-embedding",
  "tongyi-embedding-vision-plus",
  "tongyi-embedding-vision-flash",
  "tongyi-embedding-vision-plus-2026-03-06",
  "tongyi-embedding-vision-flash-2026-03-06",
];

const BAILIAN_EMBEDDING_MODELS = [
  ...BAILIAN_TEXT_EMBEDDING_MODELS,
  ...BAILIAN_MULTIMODAL_EMBEDDING_MODELS,
];

// Zhipu OpenAI-compatible GET /models omits VLM chat SKUs (e.g. glm-4.6v).
const ZHIPU_DOCUMENTED_VLM_MODELS = [
  "glm-4.6v",
  "glm-5v-turbo",
  "glm-4.1v-thinking",
  "glm-4.6v-flash",
  "glm-4.1v-thinking-flash",
  "glm-4v-flash",
];

function isBailianLikeRequest(provider: string, base: string): boolean {
  return provider === "bailian" || provider === "dashscope" || /dashscope\.aliyuncs\.com/i.test(base);
}

function isZhipuLikeRequest(provider: string, base: string): boolean {
  return provider === "zhipu" || /open\.bigmodel\.cn/i.test(base);
}

function isOllamaLikeProvider(provider: string): boolean {
  return provider === "ollama" || provider.startsWith("custom_ollama_");
}

function normalizeOllamaApiBase(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "").replace(/\/v\d+$/i, "");
}

/** OpenAI-compatible API root; append /v1 when absent. Keep in sync with provider-display.ts */
function resolveOpenAiCompatApiBase(provider: string, baseUrl?: string): string {
  const raw = (baseUrl || KNOWN_BASE_URLS[provider] || "").trim().replace(/\/+$/, "");
  if (!raw) return raw;
  return /\/v\d(\/|$)/.test(raw) ? raw : `${raw}/v1`;
}

async function fetchOllamaModelNames(baseUrl: string): Promise<{
  ok: boolean;
  models?: string[];
  error?: string;
}> {
  const base = normalizeOllamaApiBase(baseUrl);
  if (!base) return { ok: false, error: "未知 API 地址" };
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const resp = await proxyAwareFetch(`${base}/api/tags`, { signal: controller.signal });
    clearTimeout(timer);
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      return { ok: false, error: `HTTP ${resp.status}: ${body.slice(0, 200)}` };
    }
    const data = await resp.json() as { models?: Array<{ name?: string }> };
    const models = (data.models ?? [])
      .map((m) => String(m.name ?? "").trim())
      .filter(Boolean);
    return { ok: true, models };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/** Heuristic: does a model id look like an embedding SKU (text or multimodal)? */
function isEmbeddingModelId(model: string): boolean {
  const slug = (model || "").trim().toLowerCase();
  if (!slug) return false;
  const tail = slug.includes("/") ? (slug.split("/").pop() ?? slug) : slug;
  if (BAILIAN_EMBEDDING_MODELS.includes(tail)) return true;
  if (/(vl|vision|multimodal)[-_]?embedding|embedding[-_]?vision/.test(tail)) return true;
  return /embedding|bge-|gte-|e5-|text-embedding/.test(tail);
}

const PROVIDER_FALLBACK_MODELS: Record<string, string[]> = {
  minimax: [
    "MiniMax-M2.7",
    "MiniMax-M2.7-highspeed",
    "MiniMax-M2.5",
    "MiniMax-M2.5-highspeed",
    "MiniMax-M2.5-lightning",
    "MiniMax-M2.1",
    "MiniMax-M2.1-highspeed",
    "MiniMax-M2.1-lightning",
    "MiniMax-M2",
  ],
  deepseek: [
    "deepseek-v4-pro",
    "deepseek-v4-flash",
  ],
};

function loadAgxConfig(): AgxConfig {
  if (!fs.existsSync(CONFIG_PATH)) {
    return { version: "1", providers: {}, onboarding_completed: true };
  }
  try {
    const raw = yaml.load(fs.readFileSync(CONFIG_PATH, "utf-8")) as AgxConfig;
    return raw ?? { version: "1", providers: {}, onboarding_completed: true };
  } catch {
    return { version: "1", providers: {}, onboarding_completed: true };
  }
}

function saveAgxConfig(cfg: AgxConfig): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const content = yaml.dump(cfg, { lineWidth: -1 });
  const tmpPath = path.join(
    CONFIG_DIR,
    `.config.yaml.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  try {
    fs.writeFileSync(tmpPath, content, { encoding: "utf-8", mode: 0o600 });
    fs.renameSync(tmpPath, CONFIG_PATH);
  } catch (error) {
    try {
      if (fs.existsSync(tmpPath)) fs.rmSync(tmpPath, { force: true });
    } catch {
      // Preserve the original write error.
    }
    throw error;
  }
}

function enterpriseCapabilitySyncConfigStore(): EnterpriseCapabilitySyncConfigStore<AgxConfig> {
  return { load: loadAgxConfig, save: saveAgxConfig };
}

function enterpriseCapabilityPolicyForConfig(cfg: AgxConfig): EnterpriseCapabilityPolicy {
  const ent = cfg.enterprise;
  if (!ent?.enabled || !String(ent.token ?? "").trim()) {
    return { ...DEFAULT_ENTERPRISE_CAPABILITY_POLICY };
  }
  return normalizeEnterpriseCapabilityPolicy(ent.policy?.capability_policy);
}

function currentEnterpriseCapabilityPolicy(): EnterpriseCapabilityPolicy {
  return enterpriseCapabilityPolicyForConfig(loadAgxConfig());
}

function enterpriseRegistrySkillInstallAllowed(
  cfg: AgxConfig,
  name: string,
  namespace = "",
): boolean {
  if (enterpriseCapabilityPolicyForConfig(cfg).allow_local_skill_install) return true;
  return isEnterpriseSkillMarketplaceApproved(
    normalizeEnterpriseCapabilities(cfg.enterprise?.capabilities),
    name,
    namespace,
  );
}

function enterpriseCapabilityDeniedError(capability: "Skill" | "MCP"): { ok: false; error: string } {
  return {
    ok: false,
    error: `企业管理员已关闭员工本地${capability}安装与修改`,
  };
}

function loadSoulFile(pathName: string): string {
  try {
    return fs.readFileSync(pathName, "utf-8");
  } catch {
    return "";
  }
}

function saveSoulFile(pathName: string, content: string): void {
  fs.mkdirSync(path.dirname(pathName), { recursive: true });
  fs.writeFileSync(pathName, content, "utf-8");
}

function normalizeLocalFsPath(raw: string): string {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return "";
  let expanded = "";
  if (trimmed.startsWith("file://")) {
    try {
      expanded = fileURLToPath(trimmed);
    } catch {
      expanded = decodeURIComponent(trimmed.replace(/^file:\/\//, ""));
    }
  } else {
    // Expand ~/… so renderer callers (e.g. WorkPanel agent_messages.json) resolve.
    expanded = expandDesktopLocalPath(trimmed);
  }
  return pickLocalFsPathCandidate(expanded, (candidate) => fs.existsSync(candidate));
}

function decodeLocalTextBuffer(buf: Buffer): { content: string; encodingError?: string } {
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    return { content: decoder.decode(buf) };
  } catch {
    return {
      content: "",
      encodingError:
        "文件不是有效的 UTF-8 编码（中文 SVG/文本可能显示乱码），请用 UTF-8 重新保存",
    };
  }
}

function prepareSvgMarkupForEmbed(raw: string): string {
  let s = String(raw ?? "").replace(/^\uFEFF/, "");
  s = s.replace(/^\s*<\?xml[^>]*\?>\s*/i, "");
  s = s.replace(/^\s*<!DOCTYPE[^>]*>\s*/i, "");
  return s.trim();
}

function buildSvgCharsetDataUrlFromBuffer(buf: Buffer): string {
  const decoded = decodeLocalTextBuffer(buf);
  const content = decoded.encodingError ? buf.toString("utf8") : decoded.content;
  const markup = prepareSvgMarkupForEmbed(content);
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
}

function saveMetaWorkspaceMarkdown(kind: MetaWorkspaceHistoryKind, content: string): void {
  const workspaceDir = resolveMetaWorkspaceDir();
  snapshotMetaWorkspaceBeforeSave(workspaceDir, kind, content);
  saveSoulFile(resolveMetaWorkspaceMainPath(workspaceDir, kind), content);
}

function normalizeEmailConfig(input: unknown): EmailConfig {
  if (!input || typeof input !== "object") return { ...DEFAULT_EMAIL_CONFIG };
  const row = input as Partial<EmailConfig>;
  return {
    enabled: Boolean(row.enabled ?? true),
    smtp_host: String(row.smtp_host ?? "").trim(),
    smtp_port: Number(row.smtp_port ?? 587) || 587,
    smtp_username: String(row.smtp_username ?? "").trim(),
    smtp_password: String(row.smtp_password ?? ""),
    smtp_use_tls: Boolean(row.smtp_use_tls ?? true),
    from_email: String(row.from_email ?? "").trim(),
    default_to_email: String(row.default_to_email ?? "bingzhenli@hotmail.com").trim() || "bingzhenli@hotmail.com",
  };
}

function parseBooleanStrict(value: unknown, field: string): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const lowered = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(lowered)) return true;
    if (["false", "0", "no", "off"].includes(lowered)) return false;
  }
  throw new Error(`${field} must be boolean`);
}

function loadEmailConfigFromAgx(cfg: AgxConfig): EmailConfig {
  const email = cfg.notifications?.email;
  return normalizeEmailConfig(email);
}

function parseBooleanLoose(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const lowered = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(lowered)) return true;
    if (["false", "0", "no", "off"].includes(lowered)) return false;
  }
  return fallback;
}

function loadTrinityConfig(cfg: AgxConfig): TrinityConfig {
  const raw = (cfg as Record<string, unknown>).agent_harness_trinity;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...DEFAULT_TRINITY_CONFIG };
  const row = raw as Record<string, unknown>;
  const rawNudge = Number(row.learning_nudge_interval);
  const rawMinCalls = Number(row.learning_min_tool_calls);
  const learningNudgeInterval =
    Number.isInteger(rawNudge) && rawNudge > 0 ? rawNudge : DEFAULT_TRINITY_CONFIG.learning_nudge_interval;
  const learningMinToolCalls =
    Number.isInteger(rawMinCalls) && rawMinCalls > 0 ? rawMinCalls : DEFAULT_TRINITY_CONFIG.learning_min_tool_calls;
  return {
    skill_protocol: parseBooleanLoose(row.skill_protocol, DEFAULT_TRINITY_CONFIG.skill_protocol),
    session_summary: parseBooleanLoose(row.session_summary, DEFAULT_TRINITY_CONFIG.session_summary),
    learning_enabled: parseBooleanLoose(row.learning_enabled, DEFAULT_TRINITY_CONFIG.learning_enabled),
    skill_manage_enabled: parseBooleanLoose(row.skill_manage_enabled, DEFAULT_TRINITY_CONFIG.skill_manage_enabled),
    learning_nudge_interval: learningNudgeInterval,
    learning_min_tool_calls: learningMinToolCalls,
  };
}

function validateEmailConfigPayload(input: unknown): { ok: true; config: EmailConfig } | { ok: false; error: string } {
  if (!input || typeof input !== "object") return { ok: false, error: "invalid payload: object required" };
  const payload = input as Record<string, unknown>;
  for (const key of Object.keys(payload)) {
    if (!EMAIL_CONFIG_KEYS.has(key)) {
      return { ok: false, error: `invalid field: ${key}` };
    }
  }
  let enabled: boolean;
  let smtpUseTls: boolean;
  try {
    enabled = parseBooleanStrict(payload.enabled, "enabled");
    smtpUseTls = parseBooleanStrict(payload.smtp_use_tls, "smtp_use_tls");
  } catch (err) {
    return { ok: false, error: String(err) };
  }
  let smtpPort = 587;
  try {
    smtpPort = intValue(payload.smtp_port, "smtp_port");
  } catch (err) {
    return { ok: false, error: String(err) };
  }
  const normalized: EmailConfig = {
    enabled,
    smtp_host: String(payload.smtp_host ?? "").trim(),
    smtp_port: smtpPort,
    smtp_username: String(payload.smtp_username ?? "").trim(),
    smtp_password: String(payload.smtp_password ?? ""),
    smtp_use_tls: smtpUseTls,
    from_email: String(payload.from_email ?? "").trim(),
    default_to_email: String(payload.default_to_email ?? "bingzhenli@hotmail.com").trim() || "bingzhenli@hotmail.com",
  };
  if (!normalized.smtp_host.trim()) return { ok: false, error: "smtp_host is required" };
  if (!normalized.smtp_username.trim()) return { ok: false, error: "smtp_username is required" };
  if (!normalized.smtp_password.trim()) return { ok: false, error: "smtp_password is required" };
  if (!normalized.from_email.trim()) return { ok: false, error: "from_email is required" };
  if (!normalized.default_to_email.trim()) return { ok: false, error: "default_to_email is required" };
  return { ok: true, config: normalized };
}

function intValue(raw: unknown, field: string): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) throw new Error(`${field} must be integer`);
  return parsed;
}

function floatValue(raw: unknown, field: string, min?: number, max?: number): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(`${field} must be number`);
  if (min !== undefined && parsed < min) throw new Error(`${field} must be >= ${min}`);
  if (max !== undefined && parsed > max) throw new Error(`${field} must be <= ${max}`);
  return parsed;
}

function loadTurnArchiveConfig(cfg: AgxConfig): TurnArchiveConfig {
  const root = cfg as Record<string, unknown>;
  const memory = root.memory;
  if (!memory || typeof memory !== "object" || Array.isArray(memory)) {
    return { ...DEFAULT_TURN_ARCHIVE_CONFIG };
  }
  const section = (memory as Record<string, unknown>).turn_archive;
  if (!section || typeof section !== "object" || Array.isArray(section)) {
    return { ...DEFAULT_TURN_ARCHIVE_CONFIG };
  }
  const row = section as Record<string, unknown>;
  const rawMinChunk = Number(row.min_chunk_chars);
  const rawMaxChunks = Number(row.max_chunks_per_turn);
  const rawRecallLimit = Number(row.recall_turns_limit);
  const rawHalflife = Number(row.halflife_days);
  return {
    enabled: parseBooleanLoose(row.enabled, DEFAULT_TURN_ARCHIVE_CONFIG.enabled),
    min_chunk_chars:
      Number.isInteger(rawMinChunk) && rawMinChunk >= 1
        ? rawMinChunk
        : DEFAULT_TURN_ARCHIVE_CONFIG.min_chunk_chars,
    max_chunks_per_turn:
      Number.isInteger(rawMaxChunks) && rawMaxChunks >= 1
        ? rawMaxChunks
        : DEFAULT_TURN_ARCHIVE_CONFIG.max_chunks_per_turn,
    recall_turns_limit:
      Number.isInteger(rawRecallLimit) && rawRecallLimit >= 1
        ? rawRecallLimit
        : DEFAULT_TURN_ARCHIVE_CONFIG.recall_turns_limit,
    halflife_days:
      Number.isFinite(rawHalflife) && rawHalflife > 0
        ? rawHalflife
        : DEFAULT_TURN_ARCHIVE_CONFIG.halflife_days,
  };
}

function validateTurnArchiveConfigPayload(
  input: unknown,
): { ok: true; config: TurnArchiveConfig } | { ok: false; error: string } {
  if (!input || typeof input !== "object") return { ok: false, error: "invalid payload: object required" };
  const payload = input as Record<string, unknown>;
  for (const key of Object.keys(payload)) {
    if (!TURN_ARCHIVE_CONFIG_KEYS.has(key)) {
      return { ok: false, error: `invalid field: ${key}` };
    }
  }
  let enabled: boolean;
  let minChunkChars: number;
  let maxChunksPerTurn: number;
  let recallTurnsLimit: number;
  let halflifeDays: number;
  try {
    enabled = parseBooleanStrict(payload.enabled, "enabled");
    minChunkChars = intValue(payload.min_chunk_chars, "min_chunk_chars");
    maxChunksPerTurn = intValue(payload.max_chunks_per_turn, "max_chunks_per_turn");
    recallTurnsLimit = intValue(payload.recall_turns_limit, "recall_turns_limit");
    halflifeDays = floatValue(payload.halflife_days, "halflife_days", 0.1, 365);
  } catch (err) {
    return { ok: false, error: String(err) };
  }
  if (minChunkChars < 1) return { ok: false, error: "min_chunk_chars must be >= 1" };
  if (maxChunksPerTurn < 1) return { ok: false, error: "max_chunks_per_turn must be >= 1" };
  if (recallTurnsLimit < 1) return { ok: false, error: "recall_turns_limit must be >= 1" };
  return {
    ok: true,
    config: {
      enabled,
      min_chunk_chars: minChunkChars,
      max_chunks_per_turn: maxChunksPerTurn,
      recall_turns_limit: recallTurnsLimit,
      halflife_days: halflifeDays,
    },
  };
}

function validateTrinityConfigPayload(input: unknown): { ok: true; config: TrinityConfig } | { ok: false; error: string } {
  if (!input || typeof input !== "object") return { ok: false, error: "invalid payload: object required" };
  const payload = input as Record<string, unknown>;
  for (const key of Object.keys(payload)) {
    if (!TRINITY_CONFIG_KEYS.has(key)) {
      return { ok: false, error: `invalid field: ${key}` };
    }
  }
  let skillProtocol: boolean;
  let sessionSummary: boolean;
  let learningEnabled: boolean;
  let skillManageEnabled: boolean;
  let learningNudgeInterval: number;
  let learningMinToolCalls: number;
  try {
    skillProtocol = parseBooleanStrict(payload.skill_protocol, "skill_protocol");
    sessionSummary = parseBooleanStrict(payload.session_summary, "session_summary");
    learningEnabled = parseBooleanStrict(payload.learning_enabled, "learning_enabled");
    skillManageEnabled = parseBooleanStrict(payload.skill_manage_enabled, "skill_manage_enabled");
    learningNudgeInterval = intValue(payload.learning_nudge_interval, "learning_nudge_interval");
    learningMinToolCalls = intValue(payload.learning_min_tool_calls, "learning_min_tool_calls");
  } catch (err) {
    return { ok: false, error: String(err) };
  }
  if (learningNudgeInterval < 1) {
    return { ok: false, error: "learning_nudge_interval must be >= 1" };
  }
  if (learningMinToolCalls < 1) {
    return { ok: false, error: "learning_min_tool_calls must be >= 1" };
  }
  return {
    ok: true,
    config: {
      skill_protocol: skillProtocol,
      session_summary: sessionSummary,
      learning_enabled: learningEnabled,
      skill_manage_enabled: skillManageEnabled,
      learning_nudge_interval: learningNudgeInterval,
      learning_min_tool_calls: learningMinToolCalls,
    },
  };
}

let mainWindow: BrowserWindow | null = null;
let mainWindowReadyToShow = false;
let mainWindowRevealPending = false;

function showMainWindowSafely(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindowRevealPending = true;
  if (!mainWindowReadyToShow) return;
  mainWindowRevealPending = false;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

async function revealMainWindowAfterSplash(options?: { fade?: boolean }): Promise<void> {
  await closeSplash({ fade: options?.fade ?? true });
  showMainWindowSafely();
}
let tray: Tray | null = null;
const WIN_TITLE_BAR_OVERLAY_HEIGHT = 44;
type WinTitleBarTheme = "dark" | "light" | "dim";
let winTitleBarOverlayTheme: WinTitleBarTheme = "dark";

function winTitleBarOverlayForTheme(theme: WinTitleBarTheme = "dark") {
  switch (theme) {
    case "light":
      return { color: "#ffffff", symbolColor: "#111827", height: WIN_TITLE_BAR_OVERLAY_HEIGHT };
    case "dim":
      return { color: "#1e1e1e", symbolColor: "#f6f7f9", height: WIN_TITLE_BAR_OVERLAY_HEIGHT };
    default:
      return { color: "#26262a", symbolColor: "#ffffff", height: WIN_TITLE_BAR_OVERLAY_HEIGHT };
  }
}

function applyWinTitleBarOverlay(theme: WinTitleBarTheme = winTitleBarOverlayTheme): void {
  if (process.platform !== "win32" || !mainWindow || mainWindow.isDestroyed() || focusModeActive) return;
  try {
    mainWindow.setTitleBarOverlay(winTitleBarOverlayForTheme(theme));
    winTitleBarOverlayTheme = theme;
  } catch {
    // ignore unsupported builds
  }
}

/** When true, the scheduled bounds save is skipped so focus-mode's tiny
 *  capsule size is never persisted to layout.json. */
let focusModeActive = false;
/** Saved bounds captured right before entering focus mode; restored on exit. */
let focusModePreviousBounds: { x: number; y: number; width: number; height: number } | null = null;
let focusModeWasMaximized = false;
let apiPort = 8000;
const apiToken = crypto.randomBytes(16).toString("hex");
let serveProcess: ChildProcess | null = null;
let documentRendererHost: DocumentRendererHost | null = null;
/** Local-only bridge for authenticated Desktop assistant enterprise actions. */
let enterpriseActionBroker: EnterpriseActionBroker | null = null;
let feishuProcess: ChildProcess | null = null;
let wechatSidecarProcess: ChildProcess | null = null;
let wechatSidecarPort = 0;
let tmeetAuthProcess: ChildProcess | null = null;
let tmeetAuthBusy = false;
let tmeetInstallPromise: Promise<string> | null = null;
/** Active Tencent Meeting Device Flow canceller — resolves login and kills the CLI process. */
let cancelActiveTmeetLogin: ((reason?: string) => Promise<void>) | null = null;
let tmeetBinaryValidationCache: {
  path: string;
  size: number;
  mtimeMs: number;
  valid: boolean;
} | null = null;
let githubAuthProcess: ChildProcess | null = null;
let githubAuthBusy = false;
let githubInstallPromise: Promise<string> | null = null;
/** Active Device Flow canceller — closes login promise and kills gh process. */
let cancelActiveGithubLogin: ((reason?: string) => void) | null = null;
let githubBinaryValidationCache: {
  path: string;
  size: number;
  mtimeMs: number;
  valid: boolean;
} | null = null;
let feishuAuthProcess: ChildProcess | null = null;
let feishuAuthBusy = false;
let feishuInstallPromise: Promise<string> | null = null;
/** Active Feishu Device Flow canceller — closes login promise and kills lark-cli process. */
let cancelActiveFeishuLogin: ((reason?: string) => void) | null = null;
let feishuBinaryValidationCache: {
  path: string;
  size: number;
  mtimeMs: number;
  valid: boolean;
} | null = null;
let wecomAuthPty: import("node-pty").IPty | null = null;
let wecomAuthBusy = false;
let wecomInstallPromise: Promise<string> | null = null;
/** Active WeCom init canceller — closes login promise and kills wecom-cli PTY. */
let cancelActiveWecomLogin: ((reason?: string) => void) | null = null;
let wecomBinaryValidationCache: {
  path: string;
  size: number;
  mtimeMs: number;
  valid: boolean;
} | null = null;
let qqmailAuthProcess: ChildProcess | null = null;
let qqmailAuthBusy = false;
let qqmailInstallPromise: Promise<string> | null = null;
let cancelActiveQqmailLogin: ((reason?: string) => void) | null = null;
let qqmailBinaryValidationCache: {
  path: string;
  size: number;
  mtimeMs: number;
  valid: boolean;
} | null = null;
let isQuitting = false;
let serveStdoutBuffer = "";
let serveStderrBuffer = "";
let remoteConfig: ResolvedRemoteConfig | null = null;
let skillsDirWatchers: fs.FSWatcher[] = [];
let skillsChangedDebounceTimer: NodeJS.Timeout | null = null;
let userAccountLoginPollTimer: NodeJS.Timeout | null = null;
let userAccountLoginPollTicks = 0;
let userAccountLoginContext: {
  baseUrl: string;
  deviceId: string;
  deviceSecret: string;
  authGeneration: number;
  pollIntervalMs: number;
  maxTicks: number;
} | null = null;

function clearUserAccountLoginPoll(): void {
  if (userAccountLoginPollTimer) {
    clearInterval(userAccountLoginPollTimer);
    userAccountLoginPollTimer = null;
  }
  userAccountLoginPollTicks = 0;
  userAccountLoginContext = null;
}

function loadRemoteConfig(): ResolvedRemoteConfig | null {
  const cfg = loadAgxConfig();
  const rs = cfg.remote_server;
  if (!rs?.enabled) return null;
  const url = (rs.url || "").trim().replace(/\/+$/, "");
  if (!url) return null;
  return { url, token: (rs.token || "").trim() };
}

/** Stable localStorage namespace key for renderer (host:port, lowercased). */
function backendScopeFromRemoteConfig(cfg: ResolvedRemoteConfig | null): string {
  if (!cfg) return "local";
  const url = cfg.url.trim().replace(/\/+$/, "");
  if (!url) return "local";
  try {
    const withProto = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url) ? url : `http://${url}`;
    const u = new URL(withProto);
    const host = u.hostname.toLowerCase();
    const port = u.port || (u.protocol === "https:" ? "443" : "80");
    return `${host}:${port}`;
  } catch {
    return url.toLowerCase();
  }
}

function getInjectedConnectionMode(): "local" | "remote" {
  return remoteConfig ? "remote" : "local";
}

function getInjectedBackendScope(): string {
  return backendScopeFromRemoteConfig(remoteConfig);
}

function notifyRendererConnectionModeChanged(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("agx-connection-mode-changed");
}

function notifyRendererStudioReady(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("agx-studio-ready");
}

async function pingRemoteServer(config: ResolvedRemoteConfig, timeoutMs = 10000): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(`${config.url}/api/session`, {
      headers: { "x-agx-desktop-token": config.token },
      signal: controller.signal,
    });
    return resp.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function getStudioUrl(): string {
  if (remoteConfig) return remoteConfig.url;
  let port = apiPort;
  if (!Number.isFinite(port) || port <= 0) {
    try {
      const portFile = path.join(CONFIG_DIR, "serve.port");
      const text = fs.existsSync(portFile) ? fs.readFileSync(portFile, "utf-8").trim() : "";
      const parsed = Number.parseInt(text, 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        port = parsed;
      }
    } catch {
      // best-effort fallback only
    }
  }
  return `http://127.0.0.1:${port}`;
}

function getStudioToken(): string {
  return remoteConfig ? remoteConfig.token : apiToken;
}

/**
 * Opaque scope for the dedicated environment assistant session.  Enterprise
 * tenant/user identity comes from the host's persisted authenticated snapshot;
 * the renderer never supplies an actor id.  Include the selected backend and
 * workspace so a remote account or local project cannot inherit another
 * assistant's context after restart.
 */
function getEnvironmentAssistantScope(): string {
  const cfg = loadAgxConfig();
  const enterprise = cfg.enterprise;
  const portalOrigin = normalizePortalOrigin(
    String(enterprise?.base_url ?? enterprise?.default_portal_url ?? ""),
  );
  const stableIdentity = enterpriseStableIdentityKey(portalOrigin, enterprise?.user);
  const backend = getInjectedBackendScope();
  let workspace = "";
  try {
    // Scope the physical selected workspace, rather than the spelling in
    // config.yaml (for example ``~/repo`` vs ``/Users/me/repo``).  The local
    // backend component is deliberately the stable literal ``local`` so a
    // dynamic Studio port after restart does not strand the assistant session.
    workspace = resolveMetaWorkspaceDir(cfg);
  } catch {
    // A missing workspace config is still safely scoped by identity/backend.
  }
  const enterpriseToken = String(enterprise?.token ?? "").trim();
  const tokenFallback = enterpriseToken
    ? `enterprise-token:${crypto.createHash("sha256").update(enterpriseToken, "utf8").digest("hex")}`
    : "";
  const identity = stableIdentity
    ? `enterprise:${stableIdentity}`
    : tokenFallback || "local-user";
  return crypto
    .createHash("sha256")
    .update(`${identity}\u0000${backend}\u0000${workspace}`, "utf8")
    .digest("hex");
}

function isRemoteMode(): boolean {
  return Boolean(remoteConfig);
}

/**
 * Fetch JSON from the studio backend (local or remote depending on mode) with
 * the Desktop auth token attached. Used by remote-mode provider IPC bridges.
 */
async function studioFetchJson(
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<{ ok: boolean; status: number; data?: any; error?: string }> {
  const headers: Record<string, string> = {
    "x-agx-desktop-token": getStudioToken(),
  };
  let body: BodyInit | undefined;
  if (init?.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(init.body);
  }
  try {
    const resp = await fetchStudioBackend(path, {
      method: init?.method ?? "GET",
      headers,
      body,
    });
    let data: any = undefined;
    try {
      data = await resp.json();
    } catch {
      // ignore body decode errors
    }
    if (!resp.ok) {
      return {
        ok: false,
        status: resp.status,
        data,
        error: `HTTP ${resp.status}${data?.detail ? `: ${data.detail}` : ""}`,
      };
    }
    return { ok: true, status: resp.status, data };
  } catch (err) {
    return { ok: false, status: 0, error: String(err) };
  }
}

// ── Studio readiness barrier ─────────────────────────────────────
// Background:
// On macOS `app.on("activate")` may fire while we are still inside
// `await startStudioServe()` / `await waitServeReady()`. The window
// then opens early, the renderer mounts, and the AvatarSidebar /
// SessionHistoryPanel immediately invoke list-avatars / list-groups /
// list-sessions / load-automation-tasks. Without a barrier those
// fetches hit a not-yet-listening 127.0.0.1 port, get caught and
// returned as `{ ok: false, ... empty list }`, and the renderer
// silently treats them as "no data" — the user sees "暂无分身" until
// some unrelated re-render triggers another fetch (issue #11).
//
// `studioReady` flips to true once the local serve has answered a
// real request (or once a remote ping succeeded). Any IPC handler
// that hits the studio API can `await waitForStudio(timeoutMs)`
// before its first attempt so the cold-start window is hidden from
// the renderer instead of producing a misleading empty list.
let studioReady = false;
const studioReadyWaiters: Array<() => void> = [];

function markStudioReady(): void {
  if (studioReady) return;
  studioReady = true;
  const queued = studioReadyWaiters.splice(0);
  for (const cb of queued) {
    try { cb(); } catch { /* noop */ }
  }
  notifyRendererStudioReady();
  schedulePendingEnterpriseCleanupRetry();
  // Only arm splash force-show after backend is ready so the main window
  // does not appear with empty avatars/sessions during cold start.
  scheduleSplashForceShowFallback(showMainWindowSafely);
}

function resetStudioReady(): void {
  studioReady = false;
}

function waitForStudio(timeoutMs = 30000): Promise<boolean> {
  if (studioReady) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const onReady = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const idx = studioReadyWaiters.indexOf(onReady);
      if (idx >= 0) studioReadyWaiters.splice(idx, 1);
      resolve(false);
    }, timeoutMs);
    studioReadyWaiters.push(onReady);
  });
}

/** Keep in sync with `desktop/src/utils/splash-preload-core.ts`. */
const PRELOAD_READY_BUDGET_MS = 40_000;
const PRELOAD_FETCH_TIMEOUT_MS = 10_000;
const SESSION_MESSAGES_FETCH_TIMEOUT_MS = 30_000;

function withFetchTimeout<T>(
  promise: Promise<T>,
  fallback: T,
  timeoutMs = PRELOAD_FETCH_TIMEOUT_MS
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => {
      setTimeout(() => resolve(fallback), timeoutMs);
    }),
  ]);
}

const STUDIO_BACKEND_FETCH_TIMEOUT_MS = 20_000;
const PORTABLE_SHARE_FETCH_TIMEOUT_MS = 15_000;
const PORTABLE_MARKET_FETCH_TIMEOUT_MS = 15_000;
const PORTABLE_MARKET_DOWNLOAD_REPORT_TIMEOUT_MS = 4_000;
const portableMarketDownloadConfirmations = new PortableMarketDownloadConfirmationStore();

type PortablePackageKind = "expert" | "group" | "skill";

const PORTABLE_PACKAGE_MAX_BYTES = 256 * 1024;
const PORTABLE_PACKAGE_SUFFIX: Record<PortablePackageKind, string> = {
  expert: ".agx-expert.json",
  group: ".agx-group.json",
  skill: ".agx-skill.json",
};

function isPortablePackageKind(value: unknown): value is PortablePackageKind {
  return value === "expert" || value === "group" || value === "skill";
}

/** Skills have a dedicated local-index/market path; file/share flows are only
 * for portable experts and project groups. Keep this guard in main as well as
 * in preload/types because renderer IPC calls are not a trust boundary. */
function isPortableRuntimePackageKind(
  value: unknown,
): value is Exclude<PortablePackageKind, "skill"> {
  return value === "expert" || value === "group";
}

function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function portablePackageKindFromPath(filePath: string): PortablePackageKind | null {
  const lower = String(filePath || "").toLocaleLowerCase();
  if (lower.endsWith(PORTABLE_PACKAGE_SUFFIX.expert)) return "expert";
  if (lower.endsWith(PORTABLE_PACKAGE_SUFFIX.group)) return "group";
  return null;
}

function safePortablePackageFileStem(value: unknown, fallback: string): string {
  const cleaned = String(value ?? "")
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, "-")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim()
    .slice(0, 80);
  return cleaned || fallback;
}

async function portablePackageApiError(resp: Response): Promise<string> {
  const text = await resp.text().catch(() => "");
  if (!text) return `HTTP ${resp.status}`;
  try {
    const body = JSON.parse(text) as { detail?: unknown; error?: unknown };
    const detail = String(body?.detail ?? body?.error ?? "").trim();
    if (detail) return detail;
  } catch {
    // Fall back to the bounded response text below.
  }
  return `HTTP ${resp.status}: ${text.slice(0, 300)}`;
}

function trustedPortableShareUrl(value: unknown, portalOrigin: string): string | null {
  try {
    const sharePath = String(value ?? "").trim();
    if (!/^\/config-share\/[A-Za-z0-9_-]{32}$/.test(sharePath)) return null;
    const portal = new URL(portalOrigin);
    const candidate = new URL(sharePath, portal);
    if (candidate.origin !== portal.origin) return null;
    if (candidate.username || candidate.password) return null;
    if (candidate.search || candidate.hash) return null;
    return candidate.toString();
  } catch {
    return null;
  }
}

function trustedPortableMarketUrl(value: unknown, portalOrigin: string): string | null {
  try {
    const marketPath = String(value ?? "").trim();
    if (!/^\/config-market\/[0-9A-HJKMNP-TV-Z]{26}$/.test(marketPath)) return null;
    const portal = new URL(portalOrigin);
    const candidate = new URL(marketPath, portal);
    if (candidate.origin !== portal.origin) return null;
    if (candidate.username || candidate.password || candidate.search || candidate.hash) return null;
    return candidate.toString();
  } catch {
    return null;
  }
}

type EnterprisePortalAuth =
  | {
      ok: true;
      portalOrigin: string;
      token: string;
      identityKey: string;
      /** Stable JSON [origin, tenant, user] identity, if available. */
      scopeId: string | null;
    }
  | { ok: false; error: string };

/**
 * Keep telemetry hand-offs tied to the tenant/user, while using a token hash
 * for older sessions whose bootstrap did not include stable identity fields.
 * The raw PAT never enters the hand-off map or logs.
 */
function enterpriseMarketIdentityKey(portalOrigin: string, token: string): string {
  const enterprise = loadAgxConfig().enterprise;
  const stable = enterpriseStableIdentityKey(portalOrigin, enterprise?.user);
  if (stable) return `stable:${stable}`;
  return `token:${crypto.createHash("sha256").update(token, "utf8").digest("hex")}`;
}

function currentEnterprisePortalAuth(): EnterprisePortalAuth {
  const enterprise = loadAgxConfig().enterprise;
  const validatedPortal = validatePortalOriginForBrowserLogin(enterprise?.base_url ?? "");
  const portalOrigin = validatedPortal.ok ? validatedPortal.origin : "";
  const token = String(enterprise?.token ?? "").trim();
  if (!enterprise?.enabled || !portalOrigin || !token) {
    return { ok: false, error: "请先登录企业账户，再使用公司市场。" };
  }
  return {
    ok: true,
    portalOrigin,
    token,
    identityKey: enterpriseMarketIdentityKey(portalOrigin, token),
    scopeId: enterpriseStableIdentityKey(portalOrigin, enterprise?.user),
  };
}

/**
 * Resolve broker credentials from the trusted main-process config on every
 * request.  The renderer and Python backend receive neither this PAT nor the
 * Portal origin; the auth generation makes a login/tenant/role transition
 * invalidate all broker operation bindings immediately.
 */
function resolveEnterpriseActionAuth(): EnterpriseActionAuth | null {
  const auth = currentEnterprisePortalAuth();
  if (!auth.ok) return null;
  return {
    portalOrigin: auth.portalOrigin,
    token: auth.token,
    identityKey: auth.identityKey,
    scopeId: auth.scopeId,
    authGeneration: enterpriseAuthGeneration,
  };
}

/**
 * Ask the local Studio server to authenticate the binding supplied by Python.
 * The server validates the purpose marker and the host-owned opaque scope;
 * this callback also reads the persisted session permission mode so a stale
 * `auto`/`ask` value from a caller cannot widen the Portal delegation.
 */
async function resolveEnterpriseAssistantSession(
  sessionId: string,
): Promise<{
  sessionId: string;
  purpose: "environment-assistant";
  purposeScope: string;
  permissionMode: "plan" | "ask" | "auto";
} | null> {
  const sid = String(sessionId ?? "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(sid)) return null;
  const scope = getEnvironmentAssistantScope();
  if (!scope) return null;
  try {
    const response = await fetch(
      `${getStudioUrl()}/api/sessions/${encodeURIComponent(sid)}/permissions`,
      {
        headers: {
          accept: "application/json",
          "x-agx-desktop-token": getStudioToken(),
          "x-agx-session-purpose": "environment-assistant",
          "x-agx-session-scope": scope,
        },
        signal: AbortSignal.timeout(5_000),
      },
    );
    if (!response.ok) return null;
    const body = await response.json().catch(() => ({})) as { mode?: unknown };
    const mode = String(body.mode ?? "").trim().toLowerCase();
    if (mode !== "plan" && mode !== "ask" && mode !== "auto") return null;
    return {
      sessionId: sid,
      purpose: "environment-assistant",
      purposeScope: scope,
      permissionMode: mode,
    };
  } catch {
    return null;
  }
}

type SuccessfulEnterprisePortalAuth = Extract<EnterprisePortalAuth, { ok: true }>;

async function postPortableMarketDownload(
  auth: SuccessfulEnterprisePortalAuth,
  report: PortableMarketDownloadReport,
): Promise<PortableMarketDownloadReporterResult> {
  try {
    const response = await proxyAwareFetch(
      `${auth.portalOrigin}/api/desktop/config-market/${encodeURIComponent(report.marketId)}/downloads`,
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          authorization: `Bearer ${auth.token}`,
        },
        body: JSON.stringify({ releaseId: report.releaseId }),
        redirect: "error",
        // Telemetry must not make an otherwise successful install wait on a
        // slow portal. It is retried only a finite number of times below.
        signal: AbortSignal.timeout(PORTABLE_MARKET_DOWNLOAD_REPORT_TIMEOUT_MS),
      },
    );
    const result = (await response.json().catch(() => ({}))) as {
      message?: unknown;
      error?: unknown;
      data?: { downloadCount?: unknown };
    };
    if (!response.ok) {
      const detail = String(
        result.message
        ?? result.error
        ?? `下载统计上报失败（HTTP ${response.status}）`,
      ).slice(0, 240);
      return {
        ok: false,
        error: detail,
        retryable: response.status === 408
          || response.status === 429
          || response.status >= 500,
      };
    }
    const count = Number(result.data?.downloadCount);
    if (!Number.isSafeInteger(count) || count < 0) {
      return { ok: false, error: "企业门户返回了无效的下载统计", retryable: false };
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: enterpriseFetchErrorMessage(error),
      retryable: true,
    };
  }
}

async function reportPortableMarketDownloadForAuth(
  auth: SuccessfulEnterprisePortalAuth,
  binding: Pick<PortableMarketDownloadBinding, "marketId" | "releaseId">,
): Promise<void> {
  const result = await reportPortableMarketDownloadWithRetry(
    (report) => postPortableMarketDownload(auth, report),
    { marketId: binding.marketId, releaseId: binding.releaseId },
  );
  if (!result.ok) {
    console.warn(
      `[enterprise-market] 下载统计上报失败（${result.attempts} 次）：${String(result.error ?? "未知错误").slice(0, 240)}`,
    );
  }
}

type DesktopFeedbackIpcResult = {
  ok: boolean;
  error?: string;
  unauthorized?: boolean;
  items?: unknown[];
  /** Stable authenticated scope for renderer stale-request fencing. */
  scope_id?: string;
  /** Main-process auth generation captured with the scope handshake. */
  auth_generation?: number;
};

function desktopFeedbackErrorForStatus(status: number): string {
  if (status === 401) return "企业登录已失效，请重新登录";
  if (status === 403) return "当前企业账号不能提交桌面反馈";
  if (status === 400) return "桌面反馈请求无效";
  return `企业反馈暂时不可用（HTTP ${status}）`;
}

async function readDesktopFeedbackJson(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => "");
  if (Buffer.byteLength(text, "utf8") > 64 * 1024) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

async function desktopFeedbackPortalRequest(
  auth: Extract<EnterprisePortalAuth, { ok: true }>,
  method: "GET" | "PUT" | "DELETE",
  query?: { sessionId: string },
  body?: Record<string, unknown>,
): Promise<{ ok: true; json: unknown } | { ok: false; error: string; unauthorized?: boolean }> {
  // currentEnterprisePortalAuth has already reduced the configured URL to a
  // validated origin.  Keep the endpoint path literal so renderer input can
  // never redirect this request to an arbitrary host/path.
  const url = new URL("/api/desktop/chat/feedback", auth.portalOrigin);
  if (query) url.searchParams.set("external_session_id", query.sessionId);
  try {
    const response = await proxyAwareFetch(url.toString(), {
      method,
      headers: {
        accept: "application/json",
        ...(body ? { "content-type": "application/json" } : {}),
        authorization: `Bearer ${auth.token}`,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      redirect: "error",
      signal: AbortSignal.timeout(ENTERPRISE_PORTAL_FETCH_TIMEOUT_MS),
    });
    const json = await readDesktopFeedbackJson(response);
    if (!response.ok) {
      return {
        ok: false,
        error: desktopFeedbackErrorForStatus(response.status),
        ...(response.status === 401 ? { unauthorized: true } : {}),
      };
    }
    if (!isPlainJsonObject(json) || json.code !== "00000") {
      return { ok: false, error: "企业反馈返回了无效结果" };
    }
    return { ok: true, json };
  } catch (error) {
    return { ok: false, error: enterpriseFetchErrorMessage(error) };
  }
}

async function loadDesktopFeedbackLocalMessages(sessionId: string): Promise<unknown[]> {
  const disk = readSessionMessagesFromDisk(SESSIONS_DIR, sessionId);
  if (disk) return disk.messages;
  // A just-completed remote session may not have a local snapshot yet.  Use
  // the existing Studio endpoint (with the local Studio token) as a bounded
  // fallback; this request never carries the enterprise PAT.
  const loaded = await withFetchTimeout(
    fetchSessionMessagesCore(sessionId),
    { ok: false, messages: [] },
    SESSION_MESSAGES_FETCH_TIMEOUT_MS,
  );
  return loaded.ok && Array.isArray(loaded.messages) ? loaded.messages : [];
}

function desktopFeedbackItemsFromResponse(json: unknown): unknown[] {
  if (!isPlainJsonObject(json)) return [];
  const data = isPlainJsonObject(json.data) ? json.data : json;
  const items = isPlainJsonObject(data) ? data.items : undefined;
  return Array.isArray(items) ? items : [];
}

async function normalizeDesktopFeedbackListResponse(
  sessionId: string,
  json: unknown,
): Promise<unknown[]> {
  const messages = await loadDesktopFeedbackLocalMessages(sessionId);
  const items: unknown[] = [];
  for (const raw of desktopFeedbackItemsFromResponse(json)) {
    if (!isPlainJsonObject(raw)) continue;
    const externalMessageId = normalizeDesktopFeedbackMessageId(
      raw.external_message_id ?? raw.message_id ?? raw.messageId,
    );
    const value = normalizeDesktopFeedbackValue(raw.value ?? raw.feedback);
    if (!externalMessageId || !value) continue;
    // Only hydrate records that still correspond to a local completed
    // assistant row.  This avoids letting stale/guessed portal records alter
    // another visible row after a session switch.
    const rendererId = rendererMessageIdForCanonicalExternalId(
      sessionId,
      externalMessageId,
      messages,
    );
    if (!rendererId) continue;
    items.push({ message_id: rendererId, session_id: sessionId, value });
  }
  return items;
}

function parseDesktopFeedbackSessionId(value: unknown): string | null {
  return normalizeDesktopFeedbackSessionId(value);
}

type DesktopFeedbackScopeRequest = {
  /** Complete account stamp captured from the trusted main-process snapshot. */
  expectedScopeId: string;
  expectedAuthGeneration: number;
};

function parseDesktopFeedbackScopeRequest(value: unknown): DesktopFeedbackScopeRequest | null {
  if (!isPlainJsonObject(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes("expectedScopeId") || !keys.includes("expectedAuthGeneration")) {
    return null;
  }
  const expectedScopeId = normalizeDesktopFeedbackScopeId(value.expectedScopeId);
  const expectedAuthGeneration = value.expectedAuthGeneration;
  if (
    !expectedScopeId ||
    typeof expectedAuthGeneration !== "number" ||
    !Number.isSafeInteger(expectedAuthGeneration) ||
    expectedAuthGeneration < 0
  ) {
    return null;
  }
  return { expectedScopeId, expectedAuthGeneration };
}

type DesktopFeedbackListRequest = {
  sessionId: string;
  expectedScopeId?: string;
};

function parseDesktopFeedbackListRequest(value: unknown): DesktopFeedbackListRequest | null {
  if (typeof value === "string") {
    const sessionId = parseDesktopFeedbackSessionId(value);
    return sessionId ? { sessionId } : null;
  }
  if (!isPlainJsonObject(value)) return null;
  const keys = Object.keys(value);
  if (keys.some((key) => !["sessionId", "expectedScopeId"].includes(key))) return null;
  const sessionId = parseDesktopFeedbackSessionId(value.sessionId);
  if (!sessionId) return null;
  if (!Object.prototype.hasOwnProperty.call(value, "expectedScopeId")) {
    return { sessionId };
  }
  const expectedScopeId = normalizeDesktopFeedbackScopeId(value.expectedScopeId);
  return expectedScopeId ? { sessionId, expectedScopeId } : null;
}

function parseDesktopFeedbackWritePayload(
  payload: unknown,
): { sessionId: string; messageId: string; value?: DesktopFeedbackValue; expectedScopeId: string } | null {
  if (!isPlainJsonObject(payload)) return null;
  const keys = Object.keys(payload);
  if (keys.some((key) => !["sessionId", "messageId", "value", "expectedScopeId"].includes(key))) return null;
  const sessionId = parseDesktopFeedbackSessionId(payload.sessionId);
  const messageId = normalizeDesktopFeedbackMessageId(payload.messageId);
  const expectedScopeId = normalizeDesktopFeedbackScopeId(payload.expectedScopeId);
  if (!sessionId || !messageId || !expectedScopeId) return null;
  if (Object.prototype.hasOwnProperty.call(payload, "value")) {
    const value = normalizeDesktopFeedbackValue(payload.value);
    return value ? { sessionId, messageId, value, expectedScopeId } : null;
  }
  return { sessionId, messageId, expectedScopeId };
}

/**
 * Compare a renderer-captured scope with the current trusted main-process
 * identity.  The renderer value is only a stale-request guard; the auth
 * snapshot and its token still come from currentEnterprisePortalAuth().
 */
function desktopFeedbackScopeError(
  auth: SuccessfulEnterprisePortalAuth,
  expectedScopeId: string,
): DesktopFeedbackIpcResult | null {
  if (!auth.scopeId) {
    return { ok: false, error: "当前企业账号缺少稳定身份，请重新登录" };
  }
  if (auth.scopeId !== expectedScopeId) {
    return { ok: false, error: "企业账号已切换，请刷新后重试" };
  }
  return null;
}

function desktopFeedbackListScopeError(
  capturedAuth: SuccessfulEnterprisePortalAuth,
  currentAuth: SuccessfulEnterprisePortalAuth,
  expectedScopeId?: string,
): DesktopFeedbackIpcResult | null {
  if (!currentAuth.scopeId) {
    return { ok: false, error: "当前企业账号缺少稳定身份，请重新登录" };
  }
  if (!desktopFeedbackListScopeMatches(capturedAuth.scopeId, currentAuth.scopeId, expectedScopeId)) {
    return { ok: false, error: "企业账号已切换，请刷新后重试" };
  }
  return null;
}

async function resolveDesktopFeedbackTarget(
  sessionId: string,
  messageId: string,
): Promise<DesktopFeedbackTarget | null> {
  const messages = await loadDesktopFeedbackLocalMessages(sessionId);
  return resolveDesktopAssistantMessage(sessionId, messageId, messages);
}

function portableMarketItemId(value: unknown): string | null {
  const id = String(value ?? "").trim().toUpperCase();
  return /^[0-9A-HJKMNP-TV-Z]{26}$/.test(id) ? id : null;
}

const PORTABLE_SKILL_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const PORTABLE_MARKET_SEMVER_RE = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const PORTABLE_MARKET_SKILL_MAX_BYTES = 128 * 1024;
const PORTABLE_MARKET_SKILL_MARKER = ".near-market";

type InstalledPortableMarketSkill = {
  itemId: string;
  version: string;
  digest: string;
  name: string;
  artifactId: string;
  targetPath: string;
};

type LocalSkillMarketSource = {
  name: string;
  description: string;
  baseDir: string;
  skillMd: string;
};

function skillMarketInstallRoot(): string {
  return path.join(CONFIG_DIR, "skills", "market");
}

function skillMarketArtifactKey(baseDir: string): string {
  return path.resolve(baseDir);
}

function stableSkillMarketArtifactId(baseDir: string, name: string): string {
  const key = `${skillMarketArtifactKey(baseDir)}\0${name}`;
  const digest = crypto.createHash("sha256").update(`agenticx.skill\0${key}`, "utf8").digest("hex");
  return `skill:${digest}`;
}

function rememberSkillMarketArtifact(baseDir: string, artifactId: string): void {
  if (!/^skill:[A-Za-z0-9._:-]{7,127}$/u.test(artifactId)) return;
  const cfg = loadAgxConfig();
  const current = cfg.skill_market_artifacts ?? {};
  const key = skillMarketArtifactKey(baseDir);
  const previous = current[key];
  const next = {
    ...current,
    [key]: {
      artifact_id: artifactId,
      base_dir: key,
      ...(previous?.last_version ? { last_version: previous.last_version } : {}),
    },
  };
  saveAgxConfig({ ...cfg, skill_market_artifacts: next });
}

function rememberSkillMarketArtifactVersion(
  baseDir: string,
  artifactId: string,
  version: string,
): void {
  if (!/^skill:[A-Za-z0-9._:-]{7,127}$/u.test(artifactId)) return;
  if (!PORTABLE_MARKET_SEMVER_RE.test(version)) return;
  const cfg = loadAgxConfig();
  const current = cfg.skill_market_artifacts ?? {};
  const key = skillMarketArtifactKey(baseDir);
  saveAgxConfig({
    ...cfg,
    skill_market_artifacts: {
      ...current,
      [key]: { artifact_id: artifactId, base_dir: key, last_version: version },
    },
  });
}

function rememberedSkillMarketArtifact(baseDir: string, name: string): string {
  const key = skillMarketArtifactKey(baseDir);
  const saved = loadAgxConfig().skill_market_artifacts?.[key];
  if (
    saved
    && saved.base_dir === key
    && /^skill:[A-Za-z0-9._:-]{7,127}$/u.test(saved.artifact_id)
  ) {
    return saved.artifact_id;
  }
  return stableSkillMarketArtifactId(key, name);
}

function rememberedSkillMarketVersion(baseDir: string): string | null {
  const key = skillMarketArtifactKey(baseDir);
  const saved = loadAgxConfig().skill_market_artifacts?.[key]?.last_version;
  return typeof saved === "string" && PORTABLE_MARKET_SEMVER_RE.test(saved)
    ? saved
    : null;
}

function nextSkillMarketVersion(baseDir: string): string {
  const last = rememberedSkillMarketVersion(baseDir);
  if (!last) return "1.0.0";
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/u.exec(last);
  if (!match) return "1.0.0";
  const patch = Number(match[3]);
  if (!Number.isSafeInteger(patch) || patch >= Number.MAX_SAFE_INTEGER) return "1.0.0";
  return `${match[1]}.${match[2]}.${patch + 1}`;
}

function parseSkillFrontMatter(skillMd: string): { name: string; description: string } | null {
  const lines = skillMd.split(/\r?\n/u);
  if (lines[0]?.trim() !== "---") return null;
  const closingIndex = lines.slice(1).findIndex((line) => line.trim() === "---");
  if (closingIndex < 0) return null;
  const frontMatter = lines.slice(1, closingIndex + 1).join("\n");
  try {
    const metadata = yaml.load(frontMatter, { schema: yaml.FAILSAFE_SCHEMA });
    if (!isPlainJsonObject(metadata)) return null;
    const name = String(metadata.name ?? "").trim();
    const description = String(metadata.description ?? "").trim();
    return name && description ? { name, description } : null;
  } catch {
    return null;
  }
}

/**
 * Resolve a Skill by the server-provided index, never by an arbitrary renderer
 * path.  The realpath/root checks also prevent publishing a symlink that
 * escapes one of the configured Skill roots.
 */
type LocalSkillMarketSourceRequest = {
  name: string;
  skillId?: string;
  contentHash?: string;
};

async function loadLocalSkillMarketSource(
  request: LocalSkillMarketSourceRequest,
): Promise<LocalSkillMarketSource> {
  const name = request.name.trim();
  const skillId = request.skillId?.trim() || "";
  const contentHash = request.contentHash?.trim().toLowerCase() || "";
  if (!PORTABLE_SKILL_NAME_RE.test(name)) {
    throw new Error("只能发布名称为小写字母、数字、点、下划线或短横线的 Skill");
  }
  if (skillId && (skillId.length > 256 || /[\u0000-\u001f\u007f]/u.test(skillId))) {
    throw new Error("Skill 索引标识无效，已拒绝发布。");
  }
  if (contentHash && !/^[a-f0-9]{64}$/u.test(contentHash)) {
    throw new Error("Skill 内容摘要无效，已拒绝发布。");
  }
  const response = await fetchStudioBackend("/api/skills");
  const body = (await response.json().catch(() => ({}))) as {
    ok?: unknown;
    items?: unknown;
    error?: unknown;
  };
  if (!response.ok || body.ok !== true || !Array.isArray(body.items)) {
    throw new Error(String(body.error ?? `本机 Skill 列表加载失败（HTTP ${response.status}）`));
  }
  type SkillIndexRow = {
    skill_id?: unknown;
    name?: unknown;
    description?: unknown;
    base_dir?: unknown;
    skill_md_path?: unknown;
    content_hash?: unknown;
    source?: unknown;
    variants?: unknown;
  };
  const rows = body.items.filter((item): item is SkillIndexRow => isPlainJsonObject(item));
  const candidates: SkillIndexRow[] = [];
  for (const row of rows) {
    if (String(row.name ?? "").trim() === name && String(row.base_dir ?? "").trim()) {
      candidates.push(row);
    }
    if (Array.isArray(row.variants)) {
      // Variants retain the parent name/description when the API omits those
      // fields. Keep every variant so a same-name install can be selected only
      // by the server-provided skill_id/content_hash, never by array order.
      if (String(row.name ?? "").trim() === name) {
        for (const variant of row.variants) {
          if (!isPlainJsonObject(variant) || !String(variant.base_dir ?? "").trim()) continue;
          candidates.push({
            ...row,
            ...variant,
            name: variant.name ?? row.name,
            description: variant.description ?? row.description,
          });
        }
      }
    }
  }
  const uniqueCandidates = [...new Map(candidates.map((candidate) => {
    const key = `${String(candidate.skill_id ?? "").trim()}\u0000${String(candidate.base_dir ?? "").trim()}`;
    return [key, candidate] as const;
  })).values()];
  const matchingCandidates = uniqueCandidates.filter((candidate) => (
    String(candidate.name ?? "").trim() === name
    && (!skillId || String(candidate.skill_id ?? "").trim() === skillId)
    && (!contentHash || String(candidate.content_hash ?? "").trim().toLowerCase() === contentHash)
  ));
  if (matchingCandidates.length > 1) {
    throw new Error(`本机存在多个同名 Skill「${name}」，请使用精确的 skill_id/content_hash 发布。`);
  }
  const selected = matchingCandidates[0] ?? null;
  if (!selected) throw new Error(`本机未找到 Skill「${name}」，请先刷新技能索引。`);

  const baseDir = path.resolve(expandDesktopLocalPath(String(selected.base_dir ?? "")));
  const skillMdPath = path.resolve(
    expandDesktopLocalPath(String(selected.skill_md_path ?? "")) || path.join(baseDir, "SKILL.md"),
  );
  if (!baseDir || path.basename(skillMdPath) !== "SKILL.md") {
    throw new Error("Skill 文件路径无效，已拒绝发布。");
  }
  const [baseStat, fileStat] = await Promise.all([
    fs.promises.lstat(baseDir),
    fs.promises.lstat(skillMdPath),
  ]).catch(() => [null, null] as const);
  if (!baseStat || !fileStat || !baseStat.isDirectory() || !fileStat.isFile()
    || baseStat.isSymbolicLink() || fileStat.isSymbolicLink()) {
    throw new Error("Skill 必须来自本机安全目录中的普通 SKILL.md 文件。");
  }
  const baseReal = await safeRealpath(baseDir);
  const skillReal = await safeRealpath(skillMdPath);
  if (skillReal !== path.join(baseReal, "SKILL.md")) {
    throw new Error("SKILL.md 不在 Skill 目录内，已拒绝发布。");
  }
  const forbiddenRootChecks = await Promise.all(
    [enterpriseSkillsRoot(), enterpriseMarketSkillsRoot(), skillMarketInstallRoot()]
      .map((root) => isRealpathUnder(baseReal, root)),
  );
  if (forbiddenRootChecks.some(Boolean)) {
    throw new Error("不能从企业托管或市场安装目录重新发布 Skill。");
  }
  const allowedRoot = await Promise.all(
    buildSkillWatchRoots().map((root) => isRealpathUnder(baseReal, root)),
  );
  if (!allowedRoot.some(Boolean)) throw new Error("Skill 目录不在允许的本机 Skill 根目录内。");
  const skillMd = await fs.promises.readFile(skillReal, "utf8");
  if (!skillMd.trim() || Buffer.byteLength(skillMd, "utf8") > PORTABLE_MARKET_SKILL_MAX_BYTES) {
    throw new Error("SKILL.md 为空或超过 128 KiB，无法发布。");
  }
  const actualContentHash = crypto.createHash("sha256").update(skillMd, "utf8").digest("hex");
  if (contentHash && actualContentHash !== contentHash) {
    throw new Error("Skill 内容已变化，请刷新技能索引后重试。");
  }
  const indexedContentHash = String(selected.content_hash ?? "").trim().toLowerCase();
  if (indexedContentHash && actualContentHash !== indexedContentHash) {
    throw new Error("Skill 索引摘要已过期，请刷新技能索引后重试。");
  }
  const frontMatter = parseSkillFrontMatter(skillMd);
  if (!frontMatter || frontMatter.name !== name) {
    throw new Error("SKILL.md front matter 的 name 必须与本机 Skill 名称一致。");
  }
  const description = String(selected.description ?? "").trim() || frontMatter.description;
  if (!description) throw new Error("Skill 缺少描述，无法发布。");
  return { name, description, baseDir: baseReal, skillMd };
}

function buildSkillMarketManifest(
  source: LocalSkillMarketSource,
  releaseVersion: string,
): Record<string, unknown> {
  const artifactId = rememberedSkillMarketArtifact(source.baseDir, source.name);
  return {
    schema_version: 2,
    artifact_id: artifactId,
    release_version: releaseVersion,
    kind: "skill",
    title: source.name,
    description: source.description,
    recommended_permission_mode: "ask",
    dependencies: { skills: [], mcps: [] },
    resources: [],
    workspace_slots: [],
    payload: {
      name: source.name,
      description: source.description,
      skill_md: source.skillMd,
    },
  };
}

async function installPortableMarketSkillRaw(
  item: import("./portable-market").PortableMarketItem,
  raw: string,
): Promise<{ ok: true; name: string; version: string; digest: string } | { ok: false; error: string }> {
  const actualDigest = crypto.createHash("sha256").update(raw, "utf8").digest("hex");
  if (actualDigest !== item.digest) {
    return { ok: false, error: "市场 Skill 摘要与服务器记录不一致，已拒绝安装。" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: "市场 Skill 配置不是有效 JSON" };
  }
  const publication = normalizePortablePackagePublication(parsed, "skill");
  if (!publication) return { ok: false, error: "市场 Skill 包未通过严格校验" };
  const manifest = publication.manifest;
  if (
    String(manifest.artifact_id ?? "").trim() !== item.sourceArtifactId
    || String(manifest.release_version ?? "").trim() !== item.version
  ) {
    return { ok: false, error: "市场 Skill 元数据与内容版本不一致，已拒绝安装。" };
  }
  const payload = isPlainJsonObject(manifest.payload) ? manifest.payload : null;
  const name = String(payload?.name ?? "").trim();
  const skillMd = typeof payload?.skill_md === "string" ? payload.skill_md : "";
  if (!PORTABLE_SKILL_NAME_RE.test(name) || !skillMd) {
    return { ok: false, error: "市场 Skill 名称或内容无效" };
  }
  const root = skillMarketInstallRoot();
  const target = path.join(root, name);
  if (path.dirname(target) !== path.resolve(root)) {
    return { ok: false, error: "市场 Skill 名称包含非法路径" };
  }
  const previousCopies = scanInstalledPortableMarketSkills().filter(
    (installed) => installed.itemId === item.id,
  );
  if (previousCopies.some((installed) => installed.name !== name)) {
    // A market item's immutable identity must keep one stable local Skill
    // name.  Refusing a rename is safer than leaving an old marker directory
    // behind (or guessing whether it is safe to delete user files).
    return { ok: false, error: `市场 Skill「${name}」与已安装版本名称不同，暂不支持改名升级。` };
  }
  const markerPath = path.join(target, PORTABLE_MARKET_SKILL_MARKER);
  const staging = path.join(
    root,
    `.${name}.${process.pid}.${Date.now()}.staging`,
  );
  const backup = path.join(root, `.${name}.${process.pid}.${Date.now()}.backup`);
  let movedExisting = false;
  let installedNew = false;
  try {
    await fs.promises.mkdir(root, { recursive: true, mode: 0o700 });
    if (fs.existsSync(target)) {
      const existingStat = await fs.promises.lstat(target).catch(() => null);
      if (!existingStat || !existingStat.isDirectory() || existingStat.isSymbolicLink()) {
        return { ok: false, error: `本机已有非普通市场 Skill 路径「${name}」，为避免覆盖，未导入。` };
      }
      if (!fs.existsSync(markerPath)) {
        return { ok: false, error: `本机已有同名 Skill「${name}」，为避免覆盖已安装内容，未导入。` };
      }
      const metadataPath = path.join(target, `${PORTABLE_MARKET_SKILL_MARKER}.json`);
      let existingMetadata: Record<string, unknown> | null = null;
      try {
        const parsedMetadata: unknown = JSON.parse(await fs.promises.readFile(metadataPath, "utf8"));
        existingMetadata = isPlainJsonObject(parsedMetadata) ? parsedMetadata : null;
      } catch {
        existingMetadata = null;
      }
      const existingMarker = String(await fs.promises.readFile(markerPath, "utf8").catch(() => "")).trim();
      const sameArtifact = existingMetadata?.artifact_id === item.sourceArtifactId;
      const sameItem = portableMarketInstallItemIdentityMatches(existingMetadata, existingMarker, item);
      if (!sameArtifact || !sameItem) {
        return { ok: false, error: `本机同名市场 Skill「${name}」来源不同，已拒绝覆盖。` };
      }
    }
    await fs.promises.mkdir(staging, { recursive: true, mode: 0o700 });
    await fs.promises.writeFile(path.join(staging, "SKILL.md"), skillMd, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await fs.promises.writeFile(path.join(staging, PORTABLE_MARKET_SKILL_MARKER), `${item.id}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await fs.promises.writeFile(path.join(staging, `${PORTABLE_MARKET_SKILL_MARKER}.json`), JSON.stringify({
      item_id: item.id,
      artifact_id: item.sourceArtifactId,
      release_id: item.releaseId,
      version: item.version,
      digest: item.digest,
      name,
    }), { encoding: "utf8", mode: 0o600, flag: "wx" });
    if (fs.existsSync(target)) {
      await fs.promises.rename(target, backup);
      movedExisting = true;
    }
    await fs.promises.rename(staging, target);
    installedNew = true;
    if (movedExisting) await fs.promises.rm(backup, { recursive: true, force: true });
    await refreshSkillIndexAfterEnterpriseChange();
    emitSkillsChanged();
    return { ok: true, name, version: item.version, digest: item.digest };
  } catch (error) {
    try {
      if (fs.existsSync(staging)) await fs.promises.rm(staging, { recursive: true, force: true });
      if (installedNew && fs.existsSync(target)) {
        await fs.promises.rm(target, { recursive: true, force: true });
      }
      if (movedExisting && !fs.existsSync(target) && fs.existsSync(backup)) {
        await fs.promises.rename(backup, target);
      }
    } catch {
      // Keep the original failure; the old directory is preferable when possible.
    }
    return { ok: false, error: `市场 Skill 安装失败：${String(error)}` };
  } finally {
    if (fs.existsSync(backup)) {
      await fs.promises.rm(backup, { recursive: true, force: true }).catch(() => undefined);
    }
    if (fs.existsSync(staging)) {
      await fs.promises.rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

/**
 * Recover voluntary market installs from their marker metadata.  The renderer
 * must not infer installation from a same-name Skill: a local Skill and a
 * market release can intentionally share a name, and the exact market item ID
 * plus release digest is the only durable identity we can safely show after a
 * restart.
 */
function scanInstalledPortableMarketSkills(): InstalledPortableMarketSkill[] {
  const root = skillMarketInstallRoot();
  if (!fs.existsSync(root)) return [];
  const installed: InstalledPortableMarketSkill[] = [];
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const target = path.join(root, entry.name);
    const markerPath = path.join(target, PORTABLE_MARKET_SKILL_MARKER);
    const metadataPath = path.join(root, entry.name, PORTABLE_MARKET_SKILL_MARKER + ".json");
    try {
      const marker = String(fs.readFileSync(markerPath, "utf8")).trim();
      const parsed: unknown = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
      if (!isPlainJsonObject(parsed)) continue;
      const itemId = portableMarketItemId(parsed.item_id);
      if (!itemId || marker !== itemId) continue;
      const version = String(parsed.version ?? "").trim();
      const digest = String(parsed.digest ?? "").trim().toLowerCase();
      const artifactId = String(parsed.artifact_id ?? "").trim();
      const metadataName = String(parsed.name ?? "").trim();
      const name = metadataName || entry.name;
      if (
        !PORTABLE_MARKET_SEMVER_RE.test(version)
        || !/^[a-f0-9]{64}$/u.test(digest)
        || !/^skill:[A-Za-z0-9._:-]{7,127}$/u.test(artifactId)
        || !PORTABLE_SKILL_NAME_RE.test(name)
        || name !== entry.name
      ) continue;
      const skillStat = fs.lstatSync(path.join(target, "SKILL.md"));
      if (!skillStat.isFile() || skillStat.isSymbolicLink()) continue;
      installed.push({
        itemId,
        version,
        digest,
        name,
        artifactId,
        targetPath: target,
      });
    } catch {
      // Ignore incomplete/corrupt voluntary installs; the next explicit
      // install can report the actionable collision instead of guessing.
    }
  }
  return installed.sort((left, right) => (
    left.itemId.localeCompare(right.itemId)
      || left.name.localeCompare(right.name)
  ));
}

function listInstalledPortableMarketSkills(): Array<{
  itemId: string;
  version: string;
  digest: string;
  name: string;
}> {
  return scanInstalledPortableMarketSkills().map(({ itemId, version, digest, name }) => ({
    itemId,
    version,
    digest,
    name,
  }));
}

async function inspectPortablePackageRaw(
  rawText: string,
  expectedKind: PortablePackageKind,
): Promise<
  | { ok: true; raw: string; confirmationToken: string; preview: Record<string, unknown> }
  | { ok: false; error: string }
> {
  if (!rawText || Buffer.byteLength(rawText, "utf8") > PORTABLE_PACKAGE_MAX_BYTES) {
    return { ok: false, error: "分享包为空或超过 256 KiB" };
  }
  try {
    if (!isPlainJsonObject(JSON.parse(rawText))) {
      return { ok: false, error: "分享包顶层必须是 JSON 对象" };
    }
  } catch {
    return { ok: false, error: "分享包不是有效的 JSON" };
  }
  const resp = await fetchStudioBackend("/api/portable-packages/inspect", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ raw: rawText }),
  });
  if (!resp.ok) return { ok: false, error: await portablePackageApiError(resp) };
  const inspected = (await resp.json()) as {
    ok?: unknown;
    preview?: unknown;
    confirmation_token?: unknown;
    error?: unknown;
  };
  if (inspected.ok !== true || !isPlainJsonObject(inspected.preview)) {
    return { ok: false, error: String(inspected.error ?? "服务端无法预览该分享包") };
  }
  if (inspected.preview.kind !== expectedKind) {
    return { ok: false, error: "分享包类型与市场条目不一致" };
  }
  const confirmationToken = String(inspected.confirmation_token ?? "").trim();
  if (!/^[A-Za-z0-9_-]{32}$/.test(confirmationToken)) {
    return { ok: false, error: "服务端没有返回有效的一次性确认票据" };
  }
  return {
    ok: true,
    raw: rawText,
    confirmationToken,
    preview: inspected.preview,
  };
}

/** Settings-tab and studio IPC: wait for local serve readiness, then fetch with timeout. */
async function fetchStudioBackend(path: string, init?: RequestInit): Promise<Response> {
  if (!isRemoteMode()) {
    await waitForStudio(60_000);
  }
  const normalized = path.startsWith("/") ? path : `/${path}`;
  const url = `${getStudioUrl()}${normalized}`;
  const headers = new Headers(init?.headers ?? undefined);
  if (!headers.has("x-agx-desktop-token")) {
    headers.set("x-agx-desktop-token", getStudioToken());
  }
  return fetch(url, {
    ...init,
    headers,
    signal: init?.signal ?? AbortSignal.timeout(STUDIO_BACKEND_FETCH_TIMEOUT_MS),
  });
}

async function fetchListAvatarsOnce(): Promise<{ ok: boolean; avatars: unknown[] }> {
  try {
    const resp = await fetch(`${getStudioUrl()}/api/avatars`, {
      headers: { "x-agx-desktop-token": getStudioToken() },
    });
    if (!resp.ok) return { ok: false, avatars: [] };
    const data = (await resp.json()) as { ok?: boolean; avatars?: unknown[] };
    return { ok: Boolean(data.ok), avatars: Array.isArray(data.avatars) ? data.avatars : [] };
  } catch {
    return { ok: false, avatars: [] };
  }
}

async function fetchListGroupsOnce(): Promise<{ ok: boolean; groups: unknown[] }> {
  try {
    const resp = await fetch(`${getStudioUrl()}/api/groups`, {
      headers: { "x-agx-desktop-token": getStudioToken() },
    });
    if (!resp.ok) return { ok: false, groups: [] };
    const data = (await resp.json()) as { ok?: boolean; groups?: unknown[] };
    return { ok: Boolean(data.ok), groups: Array.isArray(data.groups) ? data.groups : [] };
  } catch {
    return { ok: false, groups: [] };
  }
}

async function fetchListSessionsOnce(
  avatarId?: string
): Promise<{ ok: boolean; sessions: unknown[] }> {
  try {
    const params = avatarId ? `?avatar_id=${encodeURIComponent(avatarId)}` : "";
    const resp = await fetch(`${getStudioUrl()}/api/sessions${params}`, {
      headers: { "x-agx-desktop-token": getStudioToken() },
    });
    if (!resp.ok) return { ok: false, sessions: [] };
    const data = (await resp.json()) as { ok?: boolean; sessions?: unknown[] };
    return { ok: Boolean(data.ok), sessions: Array.isArray(data.sessions) ? data.sessions : [] };
  } catch {
    return { ok: false, sessions: [] };
  }
}

async function fetchListAvatarsCore(): Promise<{ ok: boolean; avatars: unknown[] }> {
  await waitForStudio();
  return fetchListAvatarsOnce();
}

async function fetchListSessionsCore(avatarId?: string): Promise<{ ok: boolean; sessions: unknown[] }> {
  await waitForStudio();
  return fetchListSessionsOnce(avatarId);
}

async function fetchListTaskspacesCore(
  sessionId: string
): Promise<{ ok: boolean; workspaces: unknown[]; error?: string }> {
  const sid = String(sessionId || "").trim();
  if (!sid) return { ok: false, workspaces: [], error: "sessionId is required" };
  try {
    const resp = await fetch(
      `${getStudioUrl()}/api/taskspace/workspaces?session_id=${encodeURIComponent(sid)}`,
      { headers: { "x-agx-desktop-token": getStudioToken() } }
    );
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      return { ok: false, workspaces: [], error: `HTTP ${resp.status}: ${body.slice(0, 300)}` };
    }
    const data = (await resp.json()) as { ok?: boolean; workspaces?: unknown[] };
    return {
      ok: Boolean(data.ok),
      workspaces: Array.isArray(data.workspaces) ? data.workspaces : [],
    };
  } catch (err) {
    return { ok: false, workspaces: [], error: String(err) };
  }
}

async function fetchSessionMessagesCore(
  sessionId: string
): Promise<{ ok: boolean; messages: unknown[]; error?: string }> {
  const sid = String(sessionId || "").trim();
  if (!sid) return { ok: false, messages: [], error: "sessionId is required" };
  try {
    const resp = await fetch(
      `${getStudioUrl()}/api/session/messages?session_id=${encodeURIComponent(sid)}`,
      { headers: { "x-agx-desktop-token": getStudioToken() } }
    );
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      return { ok: false, messages: [], error: `HTTP ${resp.status}: ${body.slice(0, 300)}` };
    }
    const data = (await resp.json()) as { ok?: boolean; messages?: unknown[] };
    return {
      ok: Boolean(data.ok),
      messages: Array.isArray(data.messages) ? data.messages : [],
    };
  } catch (err) {
    return { ok: false, messages: [], error: String(err) };
  }
}

type SessionMessagesPageOptions = {
  tailRounds?: number;
  tailLimit?: number;
  beforeIndex?: number;
  limit?: number;
};

type SessionMessagesPageResult = {
  ok: boolean;
  messages: unknown[];
  start_index?: number;
  total_count?: number;
  has_older?: boolean;
  error?: string;
};

async function fetchSessionMessagesPageCore(
  sessionId: string,
  options: SessionMessagesPageOptions = {}
): Promise<SessionMessagesPageResult> {
  const sid = String(sessionId || "").trim();
  if (!sid) {
    return { ok: false, messages: [], error: "sessionId is required" };
  }
  const params = new URLSearchParams({ session_id: sid });
  if (typeof options.tailRounds === "number" && Number.isFinite(options.tailRounds)) {
    params.set("tail_rounds", String(Math.max(1, Math.floor(options.tailRounds))));
    if (typeof options.tailLimit === "number" && Number.isFinite(options.tailLimit)) {
      params.set("tail_limit", String(Math.max(1, Math.floor(options.tailLimit))));
    }
  } else if (typeof options.beforeIndex === "number" && Number.isFinite(options.beforeIndex)) {
    params.set("before_index", String(Math.max(0, Math.floor(options.beforeIndex))));
    params.set("limit", String(Math.max(1, Math.floor(options.limit ?? 20))));
  } else {
    return { ok: false, messages: [], error: "tailRounds or beforeIndex is required" };
  }
  try {
    const resp = await fetch(`${getStudioUrl()}/api/session/messages?${params.toString()}`, {
      headers: { "x-agx-desktop-token": getStudioToken() },
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      return { ok: false, messages: [], error: `HTTP ${resp.status}: ${body.slice(0, 300)}` };
    }
    const data = (await resp.json()) as SessionMessagesPageResult & { ok?: boolean };
    return {
      ok: Boolean(data.ok),
      messages: Array.isArray(data.messages) ? data.messages : [],
      start_index: typeof data.start_index === "number" ? data.start_index : undefined,
      total_count: typeof data.total_count === "number" ? data.total_count : undefined,
      has_older: typeof data.has_older === "boolean" ? data.has_older : undefined,
    };
  } catch (err) {
    return { ok: false, messages: [], error: String(err) };
  }
}

function emitSkillsChanged(): void {
  if (skillsChangedDebounceTimer) {
    clearTimeout(skillsChangedDebounceTimer);
  }
  skillsChangedDebounceTimer = setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("skills-changed");
    }
  }, 300);
}

function emitEnterpriseCapabilitiesChanged(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("enterprise-capabilities-changed");
  }
}

async function refreshSkillIndexAfterEnterpriseChange(): Promise<string[]> {
  const resp = await fetchStudioBackend("/api/skills/refresh", { method: "POST" });
  const data = (await resp.json().catch(() => ({}))) as { ok?: boolean; error?: string };
  if (!resp.ok || data.ok !== true) {
    throw new Error(data.error || `Skill 索引刷新失败（HTTP ${resp.status}）`);
  }
  // The refresh endpoint only returns a count.  Verify the resulting list
  // contains each managed directory before marking a Skill applied; a parser
  // rejection must remain visible as skill_not_loaded.
  const listResp = await fetchStudioBackend("/api/skills");
  const listData = (await listResp.json().catch(() => ({}))) as {
    ok?: boolean;
    items?: Array<{ base_dir?: unknown; skill_md_path?: unknown }>;
    error?: string;
  };
  if (!listResp.ok || listData.ok !== true) {
    throw new Error(listData.error || `Skill 列表加载失败（HTTP ${listResp.status}）`);
  }
  const loadedPaths = (listData.items ?? [])
    .flatMap((item) => [item.base_dir, item.skill_md_path])
    .map((value) => String(value ?? "").trim())
    .filter(Boolean);
  // 先让 Python 丢掉 20 秒列表缓存，再通知渲染进程重新读取，避免 A→B 后仍看到 A。
  emitSkillsChanged();
  return loadedPaths;
}

function loadedEnterpriseSkillCapabilityIds(
  capabilities: readonly EnterpriseCapability[],
  loadedPaths: readonly string[],
): Set<string> {
  const loaded = new Set(loadedPaths.map((value) => path.resolve(expandDesktopLocalPath(value))));
  const ids = new Set<string>();
  for (const capability of capabilities) {
    if (capability.kind !== "skill") continue;
    const expected = path.resolve(
      path.join(enterpriseSkillsRoot(), enterpriseSkillDirName(capability)),
    );
    if (loaded.has(expected)) ids.add(capability.id);
  }
  return ids;
}

function loadedEnterpriseMarketSkillCapabilityIds(
  expectedToken: string,
  loadedPaths: readonly string[],
): Set<string> {
  const loaded = new Set(loadedPaths.map((value) => path.resolve(expandDesktopLocalPath(value))));
  const ids = new Set<string>();
  const transactions = pendingEnterpriseMarketSkillTransactions.get(expectedToken);
  for (const [capabilityId, transaction] of transactions ?? []) {
    const expected = path.resolve(transaction.targetPath);
    if (loaded.has(expected)) ids.add(capabilityId);
  }
  return ids;
}

function emitAutomationTaskProgress(payload: AutomationTaskProgressPayload): void {
  const wins = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
  for (const win of wins) {
    win.webContents.send("automation-task-progress", payload);
  }
}

function buildSkillWatchRoots(): string[] {
  const roots = [
    path.join(CONFIG_DIR, "skills"),
    path.join(os.homedir(), ".agents", "skills"),
    path.join(os.homedir(), ".agent", "skills"),
    path.join(os.homedir(), ".claude", "skills"),
    path.join(os.homedir(), ".cursor", "skills"),
  ];
  // Project-local skill roots are useful in dev only. In packaged apps, cwd can
  // be "/" or app bundle internals; forcing mkdir there causes ENOENT/EACCES.
  if (!app.isPackaged) {
    roots.push(
      path.join(process.cwd(), ".agents", "skills"),
      path.join(process.cwd(), ".agent", "skills"),
      path.join(process.cwd(), ".claude", "skills"),
    );
  }
  const dedup = new Set<string>();
  for (const root of roots) {
    dedup.add(path.resolve(root));
  }
  return Array.from(dedup);
}

function startSkillsDirWatcher(): void {
  if (skillsDirWatchers.length > 0) return;
  const managedSkillsRoot = path.resolve(path.join(CONFIG_DIR, "skills"));
  for (const watchRoot of buildSkillWatchRoots()) {
    // Only create AgenticX-managed root. External roots should be watched iff present.
    if (watchRoot === managedSkillsRoot) {
      fs.mkdirSync(watchRoot, { recursive: true });
    } else if (!fs.existsSync(watchRoot)) {
      continue;
    }
    try {
      const one = fs.watch(
        watchRoot,
        { recursive: true },
        (_eventType, filename) => {
          const name = String(filename || "");
          if (!name || !name.endsWith("SKILL.md")) return;
          emitSkillsChanged();
        },
      );
      skillsDirWatchers.push(one);
    } catch (err) {
      console.warn("[main] skills watcher start failed:", watchRoot, err);
    }
  }
}

function stopSkillsDirWatcher(): void {
  if (skillsChangedDebounceTimer) {
    clearTimeout(skillsChangedDebounceTimer);
    skillsChangedDebounceTimer = null;
  }
  if (skillsDirWatchers.length > 0) {
    try {
      for (const one of skillsDirWatchers) {
        one.close();
      }
    } catch {
      /* noop */
    }
    skillsDirWatchers = [];
  }
}

// Suppress noisy Chromium network diagnostics
// (e.g. chunked upload stream warnings during aborted renderer requests).
// Set AGX_CHROMIUM_QUIET=0 to re-enable Chromium internals logs for debugging.
if (process.env.AGX_CHROMIUM_QUIET !== "0") {
  app.commandLine.appendSwitch("log-level", "3");
  app.commandLine.appendSwitch("disable-logging");
}

function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("failed to pick free port"));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

function buildMenuTemplate(): MenuItemConstructorOptions[] {
  if (process.platform === "darwin") {
    return [
      {
        label: DESKTOP_PRODUCT_NAME,
        submenu: [
          { role: "about" },
          { type: "separator" },
          { label: "设置", click: () => mainWindow?.webContents.send("open-settings") },
          { type: "separator" },
          { role: "quit" }
        ]
      },
      {
        label: "Edit",
        submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }]
      },
      {
        label: "Window",
        submenu: [{ role: "minimize" }, { role: "close" }]
      }
    ];
  }
  return [
    { role: "fileMenu" },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" }
  ];
}

function pathListSeparator(): string {
  return process.platform === "win32" ? ";" : ":";
}

/** Monorepo root when running `npm run dev` from desktop/ (has pyproject name=agenticx). */
function findAgenticxSourceRoot(): string | null {
  const cwd = process.cwd();
  const candidates = [cwd, path.resolve(cwd, ".."), path.resolve(cwd, "../..")];
  for (const root of candidates) {
    const pp = path.join(root, "pyproject.toml");
    try {
      const text = fs.readFileSync(pp, "utf-8");
      if (/name\s*=\s*["']agenticx["']/m.test(text)) {
        return root;
      }
    } catch {
      /* noop */
    }
  }
  return null;
}

/** Editable / venv installs: agx lives under repo `.venv` while `npm run dev` cwd is usually `desktop/`. */
function repoAdjacentVenvBinDirs(): string[] {
  const cwd = process.cwd();
  const sub = process.platform === "win32" ? "Scripts" : "bin";
  const roots = [cwd, path.resolve(cwd, "..")];
  const out: string[] = [];
  for (const root of roots) {
    for (const name of [".venv", "venv"]) {
      const p = path.join(root, name, sub);
      try {
        if (fs.statSync(p).isDirectory()) {
          out.push(p);
        }
      } catch {
        /* noop */
      }
    }
  }
  return out;
}

/**
 * User-level managed venv at $AGX_HOME/.venv. Created/repaired via the
 * "repair backend deps" IPC (one-click fix). Used for end-users who run AgenticX Ontology
 * without a bundled backend and without a repo-adjacent dev `.venv`.
 */
function userManagedVenvBinDir(): string {
  const sub = process.platform === "win32" ? "Scripts" : "bin";
  return path.join(resolveDesktopAgxHome(), ".venv", sub);
}

/** Same as above but only returned when it actually exists on disk. */
function existingUserManagedVenvBinDirs(): string[] {
  const dir = userManagedVenvBinDir();
  try {
    if (fs.statSync(dir).isDirectory()) return [dir];
  } catch {
    /* not present */
  }
  return [];
}

/** Python interpreter inside the user-managed venv (may not exist yet). */
function userManagedVenvPython(): string {
  const exe = process.platform === "win32" ? "python.exe" : "python";
  return path.join(userManagedVenvBinDir(), exe);
}

function pythonForVenvDir(venvDir: string): string {
  const sub = process.platform === "win32" ? "Scripts" : "bin";
  const exe = process.platform === "win32" ? "python.exe" : "python";
  return path.join(venvDir, sub, exe);
}

/**
 * Development checkouts own their Python environment. Never repair one source
 * tree by overwriting the shared end-user venv, otherwise another checkout's
 * editable install can become the Desktop backend.
 */
function backendRepairVenvDir(): string {
  if (!app.isPackaged) {
    const repoBinDir = repoAdjacentVenvBinDirs()[0];
    if (repoBinDir) return path.dirname(repoBinDir);
    const sourceRoot = findAgenticxSourceRoot();
    if (sourceRoot) return path.join(sourceRoot, ".venv");
  }
  return path.join(resolveDesktopAgxHome(), ".venv");
}

/** Find an executable by candidate names across the augmented PATH dirs. */
function findExecOnPath(augmentedPath: string, names: string[]): string | null {
  const dirs = augmentedPath.split(pathListSeparator());
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      try {
        fs.accessSync(candidate, process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
        return candidate;
      } catch {
        /* not here */
      }
    }
  }
  return null;
}

/**
 * Resolve the Python interpreter the backend currently uses, for dependency
 * diagnosis. Follow the resolved agx executable first so a development
 * checkout cannot diagnose a different checkout's shared managed venv.
 */
function resolveBackendPython(augmentedPath: string): string | null {
  const agx = findAgxBinaryOnPath(augmentedPath);
  if (agx) {
    const dir = path.dirname(agx);
    const names = process.platform === "win32" ? ["python.exe", "python3.exe"] : ["python", "python3"];
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  const venvPy = userManagedVenvPython();
  if (fs.existsSync(venvPy)) return venvPy;
  return findExecOnPath(augmentedPath, process.platform === "win32" ? ["python.exe", "python3.exe"] : ["python3", "python"]);
}

/**
 * Find a base Python (>=3.10) to bootstrap a runtime venv. Skips the target
 * and other internal venvs to avoid a chicken-and-egg dependency.
 */
function findBasePython(augmentedPath: string, excludedVenvBinDirs: string[] = [userManagedVenvBinDir()]): string | null {
  const excluded = new Set(excludedVenvBinDirs.map((dir) => path.normalize(dir)));
  const dirs = augmentedPath.split(pathListSeparator()).filter((d) => !excluded.has(path.normalize(d)));
  const names = process.platform === "win32" ? ["python.exe", "python3.exe"] : ["python3", "python"];
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      try {
        fs.accessSync(candidate, process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
        return candidate;
      } catch {
        /* not here */
      }
    }
  }
  return null;
}

function nvmNodeBinDirs(home: string): string[] {
  if (process.platform === "win32") return [];
  const root = path.join(home, ".nvm", "versions", "node");
  const out: string[] = [];
  const currentBin = path.join(home, ".nvm", "current", "bin");
  try {
    if (fs.statSync(currentBin).isDirectory()) out.push(currentBin);
  } catch {
    /* noop */
  }
  try {
    const entries = fs.readdirSync(root, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory())
      .map((e) => path.join(root, e.name, "bin"))
      .filter((p) => {
        try {
          return fs.statSync(p).isDirectory();
        } catch {
          return false;
        }
      });
    // Prefer newer versions first while keeping deterministic order.
    out.push(...dirs.sort().reverse());
    return out;
  } catch {
    return out;
  }
}

function buildAugmentedPath(): string {
  const home = os.homedir();
  const sep = pathListSeparator();
  const basePath =
    process.env.PATH ?? (process.platform === "win32" ? "" : "/usr/bin:/bin");

  // Source checkouts must run their own repo-local backend. The shared managed
  // venv is an end-user fallback and may contain an editable install belonging
  // to another checkout (for example a parallel experimental repository).
  const userVenvDirs = existingUserManagedVenvBinDirs();
  const repoVenvDirs = repoAdjacentVenvBinDirs();
  const preferredVenvDirs = app.isPackaged
    ? [...userVenvDirs, ...repoVenvDirs]
    : [...repoVenvDirs, ...userVenvDirs];
  let extraPaths: string[];
  let trailingPaths: string[] = [];
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA || "";
    const appDataRoaming = process.env.APPDATA || "";
    const pyWinFolders = ["Python313", "Python312", "Python311", "Python310", "Python39", "Python38"];
    const programsPythonScripts = localAppData
      ? pyWinFolders.map((folder) => path.join(localAppData, "Programs", "Python", folder, "Scripts"))
      : [];
    const userSiteScripts = appDataRoaming
      ? pyWinFolders.map((folder) => path.join(appDataRoaming, "Python", folder, "Scripts"))
      : [];
    extraPaths = [
      ...preferredVenvDirs,
      ...programsPythonScripts,
      ...userSiteScripts,
      path.join(home, "miniconda3", "Scripts"),
      path.join(home, "miniconda3", "condabin"),
      path.join(home, "anaconda3", "Scripts"),
      path.join(home, "mambaforge", "Scripts"),
      path.join(home, "micromamba", "bin"),
      localAppData ? path.join(localAppData, "miniconda3", "Scripts") : "",
      localAppData ? path.join(localAppData, "anaconda3", "Scripts") : "",
      path.join(home, "scoop", "shims"),
    ].filter(Boolean);
  } else {
    // macOS pip --user installs to ~/Library/Python/X.Y/bin; enumerate common versions
    const pyUserBins = ["3.13", "3.12", "3.11", "3.10", "3.9"].map(
      (v) => `${home}/Library/Python/${v}/bin`
    );
    extraPaths = [
      ...preferredVenvDirs,
      ...pyUserBins,
      ...nvmNodeBinDirs(home),
      "/opt/miniconda3/bin",
      "/opt/miniconda3/condabin",
      `${home}/miniconda3/bin`,
      `${home}/opt/miniconda3/bin`,
      `${home}/.volta/bin`,
      "/opt/homebrew/bin",
      "/usr/local/bin",
      `${home}/.local/bin`,
      `${home}/bin`,
    ];
    // Keep shim-based managers as fallback (after base PATH) to avoid shadowing healthy system binaries.
    trailingPaths = [
      `${home}/.fnm`,
      `${home}/.asdf/shims`,
      `${home}/.nodenv/shims`,
      `${home}/.pyenv/shims`,
      `${home}/.rye/shims`,
    ];
  }
  const prefix = extraPaths.filter(Boolean).join(sep);
  const suffix = trailingPaths.filter(Boolean).join(sep);
  if (prefix && suffix) return `${prefix}${sep}${basePath}${sep}${suffix}`;
  if (prefix) return `${prefix}${sep}${basePath}`;
  if (suffix) return `${basePath}${sep}${suffix}`;
  return basePath;
}

/**
 * Spawn `agx` without a login shell.
 * macOS: `zsh -l -c` runs `/etc/zprofile` → `path_helper` rebuilds PATH and drops
 * conda/venv paths inherited from the parent Electron process, so `agx` vanishes.
 * Windows: prefer a resolved `agx.exe` path; bare `agx` can fail to spawn from Electron
 * when only `agx.cmd` exists or PATHEXT resolution differs from the login shell.
 */
function spawnAgx(
  resolvedExecutable: string | null,
  args: string[],
  options: { cwd?: string; stdio: ("ignore" | "pipe")[]; env: NodeJS.ProcessEnv }
): ChildProcess {
  const cmd = resolvedExecutable ?? "agx";
  return spawn(cmd, args, { ...options, shell: false });
}

/**
 * In an unpackaged checkout, make the Python source tree authoritative for
 * the CLI discovered on PATH. This prevents `npm run dev` from importing an
 * unrelated globally installed/customer build while retaining the caller's
 * existing module search path.
 */
function sourceCheckoutPythonEnv(): NodeJS.ProcessEnv {
  if (app.isPackaged) return {};
  const sourceRoot = findAgenticxSourceRoot();
  if (!sourceRoot) return {};
  const current = String(process.env.PYTHONPATH ?? "").trim();
  return { PYTHONPATH: current ? `${sourceRoot}${pathListSeparator()}${current}` : sourceRoot };
}

/** Packaged app: embedded PyInstaller binary under resources/backend (agx-server or agx-server.exe). */
function resolveBundledBackend(): string | null {
  if (!app.isPackaged) return null;
  if (process.platform === "darwin") {
    const binary = path.join(process.resourcesPath, "backend", "agx-server");
    return fs.existsSync(binary) ? binary : null;
  }
  if (process.platform === "win32") {
    const binary = path.join(process.resourcesPath, "backend", "agx-server.exe");
    return fs.existsSync(binary) ? binary : null;
  }
  return null;
}

/** Windows commands use the native MXC ProcessContainer runner for workspace-write. */
function resolveWindowsCommandSandboxRunner(): string | null {
  if (process.platform !== "win32") return null;
  const configured = String(process.env.AGX_WINDOWS_SANDBOX_EXECUTABLE || "").trim();
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const candidates = [
    configured,
    ...(app.isPackaged
      ? [path.join(process.resourcesPath, "backend", "wxc-exec.exe")]
      : [
          path.join(
            app.getAppPath(),
            "node_modules",
            "@microsoft",
            "mxc-sdk",
            "bin",
            arch,
            "wxc-exec.exe"
          ),
          path.resolve(
            process.cwd(),
            "node_modules",
            "@microsoft",
            "mxc-sdk",
            "bin",
            arch,
            "wxc-exec.exe"
          ),
        ]),
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

function spawnBundledServer(
  binaryPath: string,
  args: string[],
  options: { cwd?: string; stdio: ("ignore" | "pipe")[]; env: NodeJS.ProcessEnv }
): ChildProcess {
  try {
    fs.chmodSync(binaryPath, 0o755);
  } catch {
    /* noop */
  }
  return spawn(binaryPath, args, { ...options, shell: false });
}

function findAgxBinaryOnPath(augmentedPath: string): string | null {
  const dirs = augmentedPath.split(pathListSeparator());
  const names = process.platform === "win32" ? ["agx.exe", "agx.cmd", "agx"] : ["agx"];
  const mode = process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK;
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      try {
        fs.accessSync(candidate, mode);
        return candidate;
      } catch { /* not here */ }
    }
  }
  return null;
}

async function checkAgxCli(): Promise<boolean> {
  const augmentedPath = buildAugmentedPath();
  const binaryPath = findAgxBinaryOnPath(augmentedPath);

  return new Promise((resolve) => {
    const proc = spawnAgx(binaryPath, ["--version"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...sourceCheckoutPythonEnv(), AGX_HOME: CONFIG_DIR, PATH: augmentedPath },
    });
    let resolved = false;
    const done = (ok: boolean) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      try { proc.kill(); } catch { /* noop */ }
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), 30_000);
    proc.on("close", (code) => done(code === 0));
    proc.on("error", () => done(false));
  });
}

async function startStudioServe(): Promise<void> {
  stopStudioServe();
  apiPort = await pickFreePort();
  fs.mkdirSync(CONFIG_DIR, { recursive: true });

  // Persist actual port & token so in-process adapters (WeChat, Feishu) and
  // sibling processes discover the live agx serve instance, not a stale one.
  try {
    const portFile = path.join(CONFIG_DIR, "serve.port");
    const tokenFile = path.join(CONFIG_DIR, "serve.token");
    fs.mkdirSync(path.dirname(portFile), { recursive: true });
    fs.writeFileSync(portFile, String(apiPort));
    fs.writeFileSync(tokenFile, apiToken);
  } catch { /* best-effort */ }

  const augmentedPath = buildAugmentedPath();
  const bundledPath = resolveBundledBackend();
  const windowsCommandSandboxRunner = resolveWindowsCommandSandboxRunner();
  const cfg = loadAgxConfig();
  const trinity = loadTrinityConfig(cfg);
  const enterpriseCapabilities = enterpriseCapabilityPolicyForConfig(cfg);

  const devPort = process.env.AGX_DEV_PORT || "5713";
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...sourceCheckoutPythonEnv(),
    ...LOCAL_BACKEND_STARTUP_ENV,
    PATH: augmentedPath,
    AGX_HOME: CONFIG_DIR,
    AGX_DEV_PORT: devPort,
    AGX_DESKTOP_TOKEN: apiToken,
    // Launch from the isolated product directory. Launching from OS HOME
    // would treat another product's ~/.agenticx/config.yaml as a project
    // overlay. Keep the actual user-selected workspace explicit.
    AGX_WORKSPACE_ROOT: resolveMetaWorkspaceDir(cfg),
    ...(documentRendererHost
      ? {
          AGX_DOCUMENT_RENDERER_URL: documentRendererHost.url,
          AGX_DOCUMENT_RENDERER_TOKEN: documentRendererHost.token,
        }
      : {}),
    ...(enterpriseActionBroker
      ? {
          // This is a per-process loopback credential.  The Python worker must
          // use the broker instead of reading the enterprise PAT from config.
          AGX_ENTERPRISE_ACTION_BROKER_URL: enterpriseActionBroker.url,
          AGX_ENTERPRISE_ACTION_BROKER_TOKEN: enterpriseActionBroker.token,
        }
      : {}),
    ...(windowsCommandSandboxRunner
      ? { AGX_WINDOWS_SANDBOX_EXECUTABLE: windowsCommandSandboxRunner }
      : {}),
    AGX_LOCAL_KNOWLEDGE_ENABLED: "0",
    // Intentionally NOT setting AGX_DESKTOP_UNRESTRICTED_FS — path access is
    // gated by session workspace roots + mount modes (see agent_tools.py).
    AGX_SKILL_PROTOCOL: trinity.skill_protocol ? "true" : "false",
    AGX_SESSION_SUMMARY: trinity.session_summary ? "true" : "false",
    AGX_LEARNING_ENABLED: trinity.learning_enabled ? "true" : "false",
    AGX_SKILL_MANAGE:
      trinity.skill_manage_enabled && enterpriseCapabilities.allow_local_skill_install
        ? "1"
        : "0",
    AGX_LEARNING_NUDGE_INTERVAL: String(trinity.learning_nudge_interval),
    AGX_LEARNING_MIN_TOOL_CALLS: String(trinity.learning_min_tool_calls),
  };

  const agxResolved = findAgxBinaryOnPath(augmentedPath);

  if (bundledPath) {
    serveProcess = spawnBundledServer(
      bundledPath,
      ["--host", "127.0.0.1", "--port", String(apiPort)],
      { cwd: CONFIG_DIR, stdio: ["ignore", "pipe", "pipe"], env }
    );
  } else {
    serveProcess = spawnAgx(
      agxResolved,
      ["serve", "--host", "127.0.0.1", "--port", String(apiPort)],
      { cwd: CONFIG_DIR, stdio: ["ignore", "pipe", "pipe"], env }
    );
  }
  serveStdoutBuffer = "";
  serveStderrBuffer = "";
  if (serveProcess.stdout) {
    serveProcess.stdout.on("data", (chunk: Buffer) => {
      serveStdoutBuffer = (serveStdoutBuffer + chunk.toString("utf-8")).slice(-4000);
    });
  }
  if (serveProcess.stderr) {
    serveProcess.stderr.on("data", (chunk: Buffer) => {
      serveStderrBuffer = (serveStderrBuffer + chunk.toString("utf-8")).slice(-4000);
    });
  }
}

async function waitServeReady(timeoutMs = getServeStartupTimeoutMs()): Promise<void> {
  if (!serveProcess || !serveProcess.stdout || !serveProcess.stderr) {
    throw new Error("agx serve process not started");
  }
  const currentProcess = serveProcess;
  const currentStdout = currentProcess.stdout!;
  const currentStderr = currentProcess.stderr!;
  const pingReady = async (): Promise<boolean> => {
    let parsed: URL;
    try {
      parsed = new URL(`${getStudioUrl()}${SERVE_READY_PATH}`);
    } catch {
      return false;
    }
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const done = (ok: boolean) => {
        if (settled) return;
        settled = true;
        resolve(ok);
      };
      const req = http.request(
        {
          protocol: parsed.protocol,
          hostname: parsed.hostname,
          port: parsed.port || undefined,
          path: `${parsed.pathname}${parsed.search}`,
          method: "GET",
          headers: { "x-agx-desktop-token": getStudioToken() },
          agent: false,
        },
        (resp) => {
          let body = "";
          resp.setEncoding("utf8");
          resp.on("data", (chunk: string) => {
            body = (body + chunk).slice(-512);
          });
          resp.on("end", () => {
            if (resp.statusCode !== 200) {
              done(false);
              return;
            }
            try {
              const payload = JSON.parse(body) as { ok?: unknown; status?: unknown };
              done(payload.ok === true && payload.status === "ready");
            } catch {
              done(false);
            }
          });
          resp.on("error", () => done(false));
        },
      );
      req.setTimeout(SERVE_READY_PROBE_TIMEOUT_MS, () => {
        req.destroy();
        done(false);
      });
      req.on("error", () => done(false));
      req.end();
    });
  };
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let probeInFlight = false;
    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      const stderrTail = serveStderrBuffer.trim().slice(-1200);
      const stdoutTail = serveStdoutBuffer.trim().slice(-1200);
      const detail = [message, stderrTail && `stderr:\n${stderrTail}`, stdoutTail && `stdout:\n${stdoutTail}`]
        .filter(Boolean)
        .join("\n\n");
      reject(new Error(detail));
    };
    const markReady = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      resolve();
    };
    const timer = setTimeout(() => {
      void (async () => {
        if (await pingReady()) {
          markReady();
          return;
        }
        fail(`agx serve startup timeout after ${Math.ceil(timeoutMs / 1000)}s`);
      })();
    }, timeoutMs);
    const probeOnce = async () => {
      if (settled || probeInFlight) return;
      probeInFlight = true;
      try {
        if (await pingReady()) {
          markReady();
        }
      } finally {
        probeInFlight = false;
      }
    };
    const probeTimer = setInterval(() => void probeOnce(), 500);
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      fail(`agx serve exited before ready (code=${String(code)}, signal=${String(signal)})`);
    };
    const onError = (err: Error) => {
      fail(`agx serve failed to start: ${err.message}`);
    };
    const cleanup = () => {
      clearTimeout(timer);
      clearInterval(probeTimer);
      currentProcess.off("exit", onExit);
      currentProcess.off("error", onError);
    };
    currentProcess.on("exit", onExit);
    currentProcess.on("error", onError);
    void probeOnce();
  });
}

function stopStudioServe(): void {
  if (!serveProcess) {
    return;
  }
  try {
    serveProcess.kill("SIGTERM");
  } catch {
    // noop
  } finally {
    serveProcess = null;
    serveStdoutBuffer = "";
    serveStderrBuffer = "";
    resetStudioReady();
  }
}

function startFeishuProcess(): void {
  const cfg = loadAgxConfig();
  const lc = cfg.feishu_longconn;
  if (!lc?.enabled || !lc.app_id || !lc.app_secret) return;
  if (feishuProcess && !feishuProcess.killed) return;
  const augmentedPath = buildAugmentedPath();
  const agxResolved = findAgxBinaryOnPath(augmentedPath);
  feishuProcess = spawnAgx(
    agxResolved,
    ["feishu", "--app-id", lc.app_id, "--app-secret", lc.app_secret],
    { cwd: os.homedir(), stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PATH: augmentedPath } }
  );
  feishuProcess.on("exit", (code) => {
    if (!isQuitting) {
      console.info(`[feishu] process exited (code=${String(code)}), will not auto-restart`);
    }
    feishuProcess = null;
  });
}

function stopFeishuProcess(): void {
  if (!feishuProcess) return;
  try { feishuProcess.kill("SIGTERM"); } catch { /* noop */ }
  feishuProcess = null;
}

type NativeConnectorStatusResult = {
  ok: boolean;
  available: boolean;
  connected: boolean;
  label: string;
  error?: string;
  account?: string;
};

const TMEET_PACKAGE_VERSION = "1.0.15";
const TMEET_PACKAGE_URL =
  "https://registry.npmjs.org/@tencentcloud/tmeet/-/tmeet-1.0.15.tgz";
const TMEET_PACKAGE_SHA512 =
  "lMvcaNgEujhYk7RNakghdyjk5VukEeHrJOlpTenNhyiNuBcCEa9XtW8pYMQQDcxltAQpT9omGogkaXXAakN10w==";
const TMEET_PACKAGE_MAX_BYTES = 20 * 1024 * 1024;
const NATIVE_CONNECTOR_STATUS_PATH = path.join(
  resolveDesktopAgxHome(),
  "connectors",
  "native-status.json",
);

function persistTmeetConnectorStatus(connected: boolean): void {
  const parentDir = path.dirname(NATIVE_CONNECTOR_STATUS_PATH);
  fs.mkdirSync(parentDir, { recursive: true, mode: 0o700 });
  if (
    fs.existsSync(NATIVE_CONNECTOR_STATUS_PATH) &&
    fs.lstatSync(NATIVE_CONNECTOR_STATUS_PATH).isSymbolicLink()
  ) {
    throw new Error("原生连接器状态文件不能是符号链接");
  }
  let current: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(NATIVE_CONNECTOR_STATUS_PATH, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      current = parsed as Record<string, unknown>;
    }
  } catch {
    current = {};
  }
  const connectors =
    current.connectors &&
    typeof current.connectors === "object" &&
    !Array.isArray(current.connectors)
      ? current.connectors as Record<string, unknown>
      : {};
  const next = {
    ...current,
    version: 1,
    connectors: {
      ...connectors,
      "tencent-meeting": {
        connected,
        capability: "skill",
        skill_name: "tencent-meeting",
        updated_at: new Date().toISOString(),
      },
    },
  };
  const tempPath = `${NATIVE_CONNECTOR_STATUS_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(next, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.renameSync(tempPath, NATIVE_CONNECTOR_STATUS_PATH);
}

function tryPersistTmeetConnectorStatus(connected: boolean): void {
  try {
    persistTmeetConnectorStatus(connected);
  } catch (error) {
    console.warn("[native-connectors] failed to persist Tencent Meeting status:", String(error));
  }
}

/**
 * Read cached connector statuses from disk (instant, no CLI spawn).
 * Used to show immediate UI state while real status refreshes in background.
 */
function readCachedConnectorStatuses(): Record<string, { connected: boolean; updated_at?: string }> {
  try {
    const raw = fs.readFileSync(NATIVE_CONNECTOR_STATUS_PATH, "utf8");
    const parsed = JSON.parse(raw);
    const connectors = parsed?.connectors;
    if (!connectors || typeof connectors !== "object" || Array.isArray(connectors)) return {};
    const result: Record<string, { connected: boolean; updated_at?: string }> = {};
    for (const [id, val] of Object.entries(connectors)) {
      if (val && typeof val === "object" && typeof (val as any).connected === "boolean") {
        result[id] = { connected: (val as any).connected, updated_at: (val as any).updated_at };
      }
    }
    return result;
  } catch {
    return {};
  }
}

function tmeetBinaryFileName(): string {
  const key = `${process.platform}-${process.arch}`;
  const fileNames: Record<string, string> = {
    "darwin-arm64": "tmeet-macOS-AppleSilicon",
    "darwin-x64": "tmeet-macOS-Intel",
    "linux-arm64": "tmeet-Linux-ARM64",
    "linux-x64": "tmeet-Linux-x86_64",
    "win32-x64": "tmeet-Windows-x86_64.exe",
  };
  const fileName = fileNames[key];
  if (!fileName) throw new Error(`当前平台暂不支持腾讯会议连接器：${key}`);
  return fileName;
}

function tmeetBinarySha256(): string {
  const hashes: Record<string, string> = {
    "tmeet-Linux-ARM64": "789cf1643957c5e6e4cccfcc6e60fdb237fb2c94222316a3a4c2dd05ebdd8bd9",
    "tmeet-Linux-x86_64": "ef76a60fe2dc630b3b87c1e2e8c0f46b5e065c69dc9441f67d0bdb916116084f",
    "tmeet-Windows-x86_64.exe": "755ca8d8328a9217b2e3c681b2bf9204b4a725079a1a0339e62eea0c984348e8",
    "tmeet-macOS-AppleSilicon": "f245226550cda8e1ea8b6e6bafbead2fb91e6e823b52905f5bb1cae485ec3914",
    "tmeet-macOS-Intel": "f0f954345fca981f8834f2e6d7fa2329e87960ce068310dcabbdd42642b3e71a",
  };
  return hashes[tmeetBinaryFileName()];
}

function tmeetInstallDir(): string {
  return path.join(
    resolveDesktopAgxHome(),
    "connectors",
    "tencent-meeting",
    TMEET_PACKAGE_VERSION,
  );
}

async function resolveTmeetBinaryPath(): Promise<string | null> {
  const binaryPath = path.join(tmeetInstallDir(), "dist", tmeetBinaryFileName());
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(binaryPath);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  if (
    tmeetBinaryValidationCache?.path === binaryPath &&
    tmeetBinaryValidationCache.size === stat.size &&
    tmeetBinaryValidationCache.mtimeMs === stat.mtimeMs
  ) {
    return tmeetBinaryValidationCache.valid ? binaryPath : null;
  }
  const digest = crypto
    .createHash("sha256")
    .update(await fs.promises.readFile(binaryPath))
    .digest("hex");
  const valid = digest === tmeetBinarySha256();
  tmeetBinaryValidationCache = {
    path: binaryPath,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    valid,
  };
  if (!valid) return null;
  if (process.platform !== "win32") fs.chmodSync(binaryPath, 0o755);
  return binaryPath;
}

async function installTmeetBinary(): Promise<string> {
  const installed = await resolveTmeetBinaryPath();
  if (installed) return installed;
  sendTmeetProgress("installing");
  const parentDir = path.dirname(tmeetInstallDir());
  fs.mkdirSync(parentDir, { recursive: true, mode: 0o700 });
  const partialDir = path.join(parentDir, `.partial-${crypto.randomUUID()}`);
  const archivePath = path.join(parentDir, `.download-${crypto.randomUUID()}.tgz`);
  try {
    const response = await proxyAwareFetch(TMEET_PACKAGE_URL, {
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error(`下载腾讯会议 CLI 失败：HTTP ${response.status}`);
    const declaredSize = Number(response.headers.get("content-length") || "0");
    if (declaredSize > TMEET_PACKAGE_MAX_BYTES) throw new Error("腾讯会议 CLI 下载包超过安全限制");
    const archive = Buffer.from(
      await readBodyWithLimit(response.body, TMEET_PACKAGE_MAX_BYTES),
    );
    if (archive.length === 0 || archive.length > TMEET_PACKAGE_MAX_BYTES) {
      throw new Error("腾讯会议 CLI 下载包大小异常");
    }
    const digest = crypto.createHash("sha512").update(archive).digest("base64");
    if (digest !== TMEET_PACKAGE_SHA512) throw new Error("腾讯会议 CLI 完整性校验失败");
    fs.mkdirSync(partialDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(archivePath, archive, { mode: 0o600 });
    const binaryMember = `package/dist/${tmeetBinaryFileName()}`;
    await extractTar({
      file: archivePath,
      cwd: partialDir,
      strip: 1,
      filter: (memberPath) => memberPath === binaryMember || memberPath === "package/LICENSE",
    });
    const extractedBinary = path.join(partialDir, "dist", tmeetBinaryFileName());
    const stat = fs.lstatSync(extractedBinary);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("腾讯会议 CLI 运行文件无效");
    if (process.platform !== "win32") fs.chmodSync(extractedBinary, 0o755);
    if (fs.existsSync(tmeetInstallDir())) fs.rmSync(tmeetInstallDir(), { recursive: true, force: true });
    fs.renameSync(partialDir, tmeetInstallDir());
    const result = await resolveTmeetBinaryPath();
    if (!result) throw new Error("腾讯会议 CLI 安装未完成");
    return result;
  } finally {
    fs.rmSync(archivePath, { force: true });
    fs.rmSync(partialDir, { recursive: true, force: true });
  }
}

async function ensureTmeetBinaryInstalled(): Promise<string> {
  const installed = await resolveTmeetBinaryPath();
  if (installed) return installed;
  if (tmeetInstallPromise) return await tmeetInstallPromise;
  tmeetInstallPromise = installTmeetBinary().finally(() => {
    tmeetInstallPromise = null;
  });
  return await tmeetInstallPromise;
}

async function runTmeetCommand(args: string[], timeoutMs = 15000): Promise<string> {
  const binaryPath = await resolveTmeetBinaryPath();
  if (!binaryPath) throw new Error("腾讯会议 CLI 尚未安装");
  return await new Promise((resolve, reject) => {
    execFile(
      binaryPath,
      args,
      {
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024,
        env: {
          ...process.env,
          TMEET_AGENT: DESKTOP_PRODUCT_NAME,
          TMEET_MODEL: "user-selected",
        },
      },
      (error, stdout, stderr) => {
        const output = `${stdout ?? ""}\n${stderr ?? ""}`.trim();
        if (error) {
          reject(new Error("腾讯会议 CLI 命令执行失败"));
          return;
        }
        resolve(output);
      },
    );
  });
}

function tmeetSkillDir(): string {
  return path.join(
    resolveDesktopAgxHome(),
    "skills",
    "near-connectors",
    "tencent-meeting",
  );
}

function ensureTmeetSkill(binaryPath: string): void {
  const skillDir = tmeetSkillDir();
  const skillPath = path.join(skillDir, "SKILL.md");
  const markerPath = path.join(skillDir, ".near-managed");
  const directoryExists = fs.existsSync(skillDir);
  const markerExists = fs.existsSync(markerPath);
  assertManagedSkillDirectory(directoryExists, markerExists);
  const quotedBinary = binaryPath.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const content = `---
name: tencent-meeting
description: 使用腾讯会议官方 CLI 查询和管理会议、录制、纪要与参会报告。
---

# 腾讯会议

仅在用户要求操作腾讯会议时使用。通过 bash_exec 调用以下官方 CLI：

\`\`\`bash
"${quotedBinary}" --format json <command> [arguments]
\`\`\`

常用命令可先执行 \`"${quotedBinary}" --help\` 查看。读取操作可以直接执行；创建、更新、取消会议以及导出录制等写入或敏感操作，必须先向用户展示参数并确认。不得输出或读取腾讯会议本地凭证文件。若命令提示未登录，引导用户前往「设置 → 连接器 → 腾讯会议」扫码连接。
`;
  if (!directoryExists) {
    const parentDir = path.dirname(skillDir);
    const partialDir = path.join(parentDir, `.tencent-meeting.partial-${crypto.randomUUID()}`);
    fs.mkdirSync(parentDir, { recursive: true, mode: 0o700 });
    try {
      fs.mkdirSync(partialDir, { mode: 0o700 });
      fs.writeFileSync(path.join(partialDir, "SKILL.md"), content, {
        encoding: "utf8",
        mode: 0o600,
      });
      fs.writeFileSync(path.join(partialDir, ".near-managed"), "managed by AgenticX Ontology\n", {
        encoding: "utf8",
        mode: 0o600,
      });
      fs.renameSync(partialDir, skillDir);
    } catch (error) {
      fs.rmSync(partialDir, { recursive: true, force: true });
      throw error;
    }
    return;
  }
  const tempPath = `${skillPath}.tmp`;
  fs.writeFileSync(tempPath, content, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tempPath, skillPath);
}

function removeTmeetSkill(): void {
  const skillDir = tmeetSkillDir();
  const markerPath = path.join(skillDir, ".near-managed");
  if (!fs.existsSync(markerPath)) return;
  fs.rmSync(skillDir, { recursive: true, force: true });
}

async function getTmeetStatus(): Promise<NativeConnectorStatusResult> {
  try {
    let binaryPath = await resolveTmeetBinaryPath();
    const managedSkillMarker = path.join(tmeetSkillDir(), ".near-managed");
    if (!binaryPath && fs.existsSync(managedSkillMarker)) {
      binaryPath = await ensureTmeetBinaryInstalled();
    }
    if (!binaryPath) {
      tryPersistTmeetConnectorStatus(false);
      return {
        ok: true,
        available: true,
        connected: false,
        label: "可用",
      };
    }
    const status = parseTmeetAuthStatus(await runTmeetCommand(["auth", "status"]));
    if (status.connected && binaryPath) {
      try {
        ensureTmeetSkill(binaryPath);
      } catch (error) {
        tryPersistTmeetConnectorStatus(false);
        return {
          ok: false,
          available: true,
          connected: false,
          label: "连接异常",
          error: error instanceof Error ? error.message : String(error),
        };
      }
    } else if (!status.connected) {
      removeTmeetSkill();
    }
    tryPersistTmeetConnectorStatus(status.connected && !status.error);
    return {
      ok: !status.error,
      available: !status.error,
      connected: status.connected,
      label: status.label,
      error: status.error,
    };
  } catch (error) {
    tryPersistTmeetConnectorStatus(false);
    return {
      ok: false,
      available: false,
      connected: false,
      label: "暂不可用",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

type TmeetProgressPhase =
  | "installing"
  | "opening_browser"
  | "waiting"
  | "success"
  | "disconnected"
  | "error";

type TmeetProgressDetails = {
  authorizationUrl?: string;
  browserOpenFailed?: boolean;
};

function sendTmeetProgress(
  phase: TmeetProgressPhase,
  details: TmeetProgressDetails = {},
): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("native-connector-tmeet-progress", { phase, ...details });
}

function startTmeetLogin(): Promise<NativeConnectorStatusResult> {
  if (tmeetAuthBusy) {
    return Promise.resolve({
      ok: false,
      available: true,
      connected: false,
      label: "连接中",
      error: "腾讯会议正在等待扫码授权",
    });
  }
  tmeetAuthBusy = true;
  return new Promise((resolve) => {
    let opened = false;
    let output = "";
    let settled = false;
    let proc: ChildProcess | null = null;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const finish = async (result?: NativeConnectorStatusResult, terminate = false) => {
      if (settled) return;
      settled = true;
      cancelActiveTmeetLogin = null;
      if (timeout) clearTimeout(timeout);
      const currentProc = proc;
      if (terminate && currentProc && currentProc.exitCode === null) {
        await new Promise<void>((done) => {
          const fallback = setTimeout(done, 2000);
          currentProc.once("close", () => {
            clearTimeout(fallback);
            done();
          });
          try { currentProc.kill("SIGTERM"); } catch { done(); }
        });
      }
      if (proc && tmeetAuthProcess === proc) tmeetAuthProcess = null;
      tmeetAuthBusy = false;
      const status = result ?? (await getTmeetStatus());
      if (status.error === "已取消") {
        sendTmeetProgress("disconnected");
      } else {
        sendTmeetProgress(status.connected ? "success" : "error");
      }
      resolve(status);
    };
    cancelActiveTmeetLogin = async (reason) => {
      await finish(
        {
          ok: false,
          available: true,
          connected: false,
          label: "可用",
          error: reason || "已取消",
        },
        true,
      );
    };
    const consume = (chunk: Buffer) => {
      output = `${output}${chunk.toString("utf8")}`.slice(-32768);
      const authorizationUrl = extractAuthorizationUrl(output);
      if (!opened && authorizationUrl) {
        opened = true;
        sendTmeetProgress("opening_browser", { authorizationUrl });
        void shell
          .openExternal(authorizationUrl)
          .then(() => {
            if (!settled) sendTmeetProgress("waiting", { authorizationUrl });
          })
          .catch((error) => {
            if (settled) return;
            console.warn("[native-connectors] failed to open Tencent Meeting auth page:", String(error));
            sendTmeetProgress("waiting", {
              authorizationUrl,
              browserOpenFailed: true,
            });
          });
      }
    };
    void ensureTmeetBinaryInstalled().then((binaryPath) => {
      // Cancellation may happen while the first-use CLI download is pending.
      // Never spawn an authorization process after that login attempt settled.
      if (settled) return;
      proc = spawn(binaryPath, ["auth", "login", "--no-browser"], {
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          TMEET_AGENT: DESKTOP_PRODUCT_NAME,
          TMEET_MODEL: "user-selected",
        },
      });
      tmeetAuthProcess = proc;
      timeout = setTimeout(() => {
        void finish({
          ok: false,
          available: true,
          connected: false,
          label: "连接超时",
          error: "扫码授权已超时，请重试",
        }, true);
      }, 5 * 60 * 1000);
      proc.stdout?.on("data", consume);
      proc.stderr?.on("data", consume);
      proc.on("error", () => {
        void finish({
          ok: false,
          available: true,
          connected: false,
          label: "连接失败",
          error: "无法启动腾讯会议授权",
        }, true);
      });
      proc.on("exit", (code) => {
        if (code === 0) {
          void finish();
          return;
        }
        void finish({
          ok: false,
          available: true,
          connected: false,
          label: "连接失败",
          error: opened ? "腾讯会议授权未完成或已取消" : "未能获取腾讯会议授权地址",
        });
      });
    }).catch((error) => {
      void finish({
        ok: false,
        available: true,
        connected: false,
        label: "安装失败",
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });
}

const GH_CLI_VERSION = "2.63.2";
const GH_RELEASE_BASE = `https://github.com/cli/cli/releases/download/v${GH_CLI_VERSION}`;
const GH_ARCHIVE_MAX_BYTES = 40 * 1024 * 1024;

function persistGithubConnectorStatus(connected: boolean): void {
  const parentDir = path.dirname(NATIVE_CONNECTOR_STATUS_PATH);
  fs.mkdirSync(parentDir, { recursive: true, mode: 0o700 });
  if (
    fs.existsSync(NATIVE_CONNECTOR_STATUS_PATH) &&
    fs.lstatSync(NATIVE_CONNECTOR_STATUS_PATH).isSymbolicLink()
  ) {
    throw new Error("原生连接器状态文件不能是符号链接");
  }
  let current: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(NATIVE_CONNECTOR_STATUS_PATH, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      current = parsed as Record<string, unknown>;
    }
  } catch {
    current = {};
  }
  const connectors =
    current.connectors &&
    typeof current.connectors === "object" &&
    !Array.isArray(current.connectors)
      ? (current.connectors as Record<string, unknown>)
      : {};
  const next = {
    ...current,
    version: 1,
    connectors: {
      ...connectors,
      github: {
        connected,
        capability: "skill",
        skill_name: "github",
        updated_at: new Date().toISOString(),
      },
    },
  };
  const tempPath = `${NATIVE_CONNECTOR_STATUS_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(next, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.renameSync(tempPath, NATIVE_CONNECTOR_STATUS_PATH);
}

function tryPersistGithubConnectorStatus(connected: boolean): void {
  try {
    persistGithubConnectorStatus(connected);
  } catch (error) {
    console.warn("[native-connectors] failed to persist GitHub status:", String(error));
  }
}

function resolveSystemGhPath(): string | null {
  const candidates: string[] = [];
  if (process.platform === "win32") {
    candidates.push(path.join("C:\\Program Files\\GitHub CLI", "gh.exe"));
  } else {
    candidates.push("/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/usr/bin/gh");
  }
  try {
    const whichCmd = process.platform === "win32" ? "where" : "which";
    const found = execFileSync(whichCmd, ["gh"], {
      encoding: "utf8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
      env: process.env,
    })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    if (found) candidates.unshift(found);
  } catch {
    // PATH lookup is best-effort
  }
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // continue
    }
  }
  return null;
}

function ghArchiveInfo(): { archiveName: string; binaryMember: string; binaryName: string } {
  const key = `${process.platform}-${process.arch}`;
  const ver = GH_CLI_VERSION;
  const table: Record<string, { archiveName: string; binaryMember: string; binaryName: string }> = {
    "darwin-arm64": {
      archiveName: `gh_${ver}_macOS_arm64.zip`,
      binaryMember: `gh_${ver}_macOS_arm64/bin/gh`,
      binaryName: "gh",
    },
    "darwin-x64": {
      archiveName: `gh_${ver}_macOS_amd64.zip`,
      binaryMember: `gh_${ver}_macOS_amd64/bin/gh`,
      binaryName: "gh",
    },
    "linux-x64": {
      archiveName: `gh_${ver}_linux_amd64.tar.gz`,
      binaryMember: `gh_${ver}_linux_amd64/bin/gh`,
      binaryName: "gh",
    },
    "linux-arm64": {
      archiveName: `gh_${ver}_linux_arm64.tar.gz`,
      binaryMember: `gh_${ver}_linux_arm64/bin/gh`,
      binaryName: "gh",
    },
    "win32-x64": {
      archiveName: `gh_${ver}_windows_amd64.zip`,
      binaryMember: "bin/gh.exe",
      binaryName: "gh.exe",
    },
  };
  const info = table[key];
  if (!info) throw new Error(`当前平台暂不支持 GitHub 连接器：${key}`);
  return info;
}

function ghArchiveSha256(): string {
  const hashes: Record<string, string> = {
    [`gh_${GH_CLI_VERSION}_macOS_arm64.zip`]:
      "0a53c536c8cc7d1c72c75ff836b018bb7f4351dd1c1c87711da4adf6b36824ee",
    [`gh_${GH_CLI_VERSION}_macOS_amd64.zip`]:
      "a5f80b98819d753449224288fd089405b19cabd128c1cbc92922fd6b44e5ee5b",
    [`gh_${GH_CLI_VERSION}_linux_amd64.tar.gz`]:
      "912fdb1ca29cb005fb746fc5d2b787a289078923a29d0f9ec19a0b00272ded00",
    [`gh_${GH_CLI_VERSION}_linux_arm64.tar.gz`]:
      "0f31e2a8549c64b5c1679f0b99ce5e0dac7c91da9e86f6246adb8805b0f0b4bb",
    [`gh_${GH_CLI_VERSION}_windows_amd64.zip`]:
      "da7eaeb29cd9251cc477402681efc72ac2283ced94e63a69c1e3bc9aca99eb9b",
  };
  const { archiveName } = ghArchiveInfo();
  const digest = hashes[archiveName];
  if (!digest) throw new Error(`缺少 GitHub CLI 校验值：${archiveName}`);
  return digest;
}

function ghInstallDir(): string {
  return path.join(resolveDesktopAgxHome(), "connectors", "github", GH_CLI_VERSION);
}

async function resolveInstalledGhBinaryPath(): Promise<string | null> {
  const { binaryName } = ghArchiveInfo();
  const binaryPath = path.join(ghInstallDir(), "bin", binaryName);
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(binaryPath);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  if (
    githubBinaryValidationCache?.path === binaryPath &&
    githubBinaryValidationCache.size === stat.size &&
    githubBinaryValidationCache.mtimeMs === stat.mtimeMs
  ) {
    return githubBinaryValidationCache.valid ? binaryPath : null;
  }
  const digest = crypto
    .createHash("sha256")
    .update(await fs.promises.readFile(binaryPath))
    .digest("hex");
  // Installed binary itself is not in checksums.txt (archive hashes are).
  // Trust presence after archive-level verification at install time; mark valid if file exists and is executable-sized.
  const valid = stat.size > 1024 * 100;
  githubBinaryValidationCache = {
    path: binaryPath,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    valid,
  };
  void digest;
  if (!valid) return null;
  if (process.platform !== "win32") fs.chmodSync(binaryPath, 0o755);
  return binaryPath;
}

async function resolveGhBinaryPath(): Promise<string | null> {
  const systemPath = resolveSystemGhPath();
  if (systemPath) return systemPath;
  return await resolveInstalledGhBinaryPath();
}

async function extractGithubArchive(
  archivePath: string,
  partialDir: string,
  archiveName: string,
  binaryMember: string,
): Promise<string> {
  if (archiveName.endsWith(".tar.gz")) {
    await extractTar({
      file: archivePath,
      cwd: partialDir,
      filter: (memberPath) => memberPath === binaryMember || memberPath.endsWith("/LICENSE"),
    });
  } else if (archiveName.endsWith(".zip")) {
    if (process.platform === "win32") {
      await new Promise<void>((resolve, reject) => {
        execFile(
          "powershell.exe",
          [
            "-NoProfile",
            "-Command",
            `Expand-Archive -LiteralPath '${archivePath.replace(/'/g, "''")}' -DestinationPath '${partialDir.replace(/'/g, "''")}' -Force`,
          ],
          { timeout: 120000, maxBuffer: 4 * 1024 * 1024 },
          (error) => {
            if (error) reject(new Error("解压 GitHub CLI 失败"));
            else resolve();
          },
        );
      });
    } else {
      await new Promise<void>((resolve, reject) => {
        execFile(
          "unzip",
          ["-o", archivePath, "-d", partialDir],
          { timeout: 120000, maxBuffer: 4 * 1024 * 1024 },
          (error) => {
            if (error) reject(new Error("解压 GitHub CLI 失败"));
            else resolve();
          },
        );
      });
    }
  } else {
    throw new Error(`不支持的 GitHub CLI 归档格式：${archiveName}`);
  }
  const extractedBinary = path.join(partialDir, binaryMember);
  if (!fs.existsSync(extractedBinary)) {
    throw new Error("GitHub CLI 运行文件提取失败");
  }
  return extractedBinary;
}

async function installGhBinary(): Promise<string> {
  const installed = await resolveInstalledGhBinaryPath();
  if (installed) return installed;
  sendGithubProgress("installing");
  const { archiveName, binaryMember, binaryName } = ghArchiveInfo();
  const parentDir = path.dirname(ghInstallDir());
  fs.mkdirSync(parentDir, { recursive: true, mode: 0o700 });
  const partialDir = path.join(parentDir, `.partial-${crypto.randomUUID()}`);
  const archivePath = path.join(parentDir, `.download-${crypto.randomUUID()}-${archiveName}`);
  try {
    const response = await proxyAwareFetch(`${GH_RELEASE_BASE}/${archiveName}`, {
      signal: AbortSignal.timeout(60000),
    });
    if (!response.ok) throw new Error(`下载 GitHub CLI 失败：HTTP ${response.status}`);
    const declaredSize = Number(response.headers.get("content-length") || "0");
    if (declaredSize > GH_ARCHIVE_MAX_BYTES) throw new Error("GitHub CLI 下载包超过安全限制");
    const archive = Buffer.from(await readBodyWithLimit(response.body, GH_ARCHIVE_MAX_BYTES));
    if (archive.length === 0 || archive.length > GH_ARCHIVE_MAX_BYTES) {
      throw new Error("GitHub CLI 下载包大小异常");
    }
    const digest = crypto.createHash("sha256").update(archive).digest("hex");
    if (digest !== ghArchiveSha256()) throw new Error("GitHub CLI 完整性校验失败");
    fs.mkdirSync(partialDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(archivePath, archive, { mode: 0o600 });
    const extractedBinary = await extractGithubArchive(
      archivePath,
      partialDir,
      archiveName,
      binaryMember,
    );
    const stat = fs.lstatSync(extractedBinary);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("GitHub CLI 运行文件无效");
    if (process.platform !== "win32") fs.chmodSync(extractedBinary, 0o755);
    const stagedBinDir = path.join(partialDir, "bin");
    fs.mkdirSync(stagedBinDir, { recursive: true, mode: 0o700 });
    const stagedBinary = path.join(stagedBinDir, binaryName);
    if (path.resolve(extractedBinary) !== path.resolve(stagedBinary)) {
      fs.renameSync(extractedBinary, stagedBinary);
    }
    if (fs.existsSync(ghInstallDir())) fs.rmSync(ghInstallDir(), { recursive: true, force: true });
    fs.renameSync(partialDir, ghInstallDir());
    const result = await resolveInstalledGhBinaryPath();
    if (!result) throw new Error("GitHub CLI 安装未完成");
    return result;
  } finally {
    fs.rmSync(archivePath, { force: true });
    fs.rmSync(partialDir, { recursive: true, force: true });
  }
}

async function ensureGhBinaryInstalled(): Promise<string> {
  const existing = await resolveGhBinaryPath();
  if (existing) return existing;
  if (githubInstallPromise) return await githubInstallPromise;
  githubInstallPromise = installGhBinary().finally(() => {
    githubInstallPromise = null;
  });
  return await githubInstallPromise;
}

async function runGhCommand(args: string[], timeoutMs = 15000): Promise<string> {
  const binaryPath = await resolveGhBinaryPath();
  if (!binaryPath) throw new Error("GitHub CLI 尚未安装");
  return await new Promise((resolve, reject) => {
    execFile(
      binaryPath,
      args,
      {
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024,
        env: {
          ...process.env,
          NO_COLOR: "1",
        },
      },
      (error, stdout, stderr) => {
        const output = `${stdout ?? ""}\n${stderr ?? ""}`.trim();
        // gh auth status returns non-zero when not logged in; still return output for parsing.
        if (error && !output) {
          reject(new Error("GitHub CLI 命令执行失败"));
          return;
        }
        resolve(output);
      },
    );
  });
}

function githubSkillDir(): string {
  return path.join(resolveDesktopAgxHome(), "skills", "near-connectors", "github");
}

function ensureGithubSkill(binaryPath: string): void {
  const skillDir = githubSkillDir();
  const skillPath = path.join(skillDir, "SKILL.md");
  const markerPath = path.join(skillDir, ".near-managed");
  const directoryExists = fs.existsSync(skillDir);
  const markerExists = fs.existsSync(markerPath);
  assertManagedSkillDirectory(directoryExists, markerExists);
  const quotedBinary = binaryPath.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const content = `---
name: github
description: 使用 GitHub 官方 CLI (gh) 查询与管理仓库、Issue、Pull Request 与 Actions。
---

# GitHub

仅在用户要求操作 GitHub 时使用。通过 bash_exec 调用官方 CLI（已在本机登录）：

\`\`\`bash
"${quotedBinary}" <command> [flags]        # 例：gh issue list、gh pr view、gh repo view
"${quotedBinary}" api <endpoint>           # 需要原始 API 时
\`\`\`

读取类命令（list/view/status/search）可直接执行；创建/编辑/合并/删除等写操作（pr create/merge、issue close、release create、repo delete 等）必须先向用户展示参数并确认。不得输出或读取 gh 本地凭证。若提示未登录，引导用户前往「设置 → 连接器 → GitHub」重新连接。
`;
  if (!directoryExists) {
    const parentDir = path.dirname(skillDir);
    const partialDir = path.join(parentDir, `.github.partial-${crypto.randomUUID()}`);
    fs.mkdirSync(parentDir, { recursive: true, mode: 0o700 });
    try {
      fs.mkdirSync(partialDir, { mode: 0o700 });
      fs.writeFileSync(path.join(partialDir, "SKILL.md"), content, {
        encoding: "utf8",
        mode: 0o600,
      });
      fs.writeFileSync(path.join(partialDir, ".near-managed"), "managed by AgenticX Ontology\n", {
        encoding: "utf8",
        mode: 0o600,
      });
      fs.renameSync(partialDir, skillDir);
    } catch (error) {
      fs.rmSync(partialDir, { recursive: true, force: true });
      throw error;
    }
    return;
  }
  const tempPath = `${skillPath}.tmp`;
  fs.writeFileSync(tempPath, content, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tempPath, skillPath);
}

function removeGithubSkill(): void {
  const skillDir = githubSkillDir();
  const markerPath = path.join(skillDir, ".near-managed");
  if (!fs.existsSync(markerPath)) return;
  fs.rmSync(skillDir, { recursive: true, force: true });
}

async function getGithubStatus(): Promise<NativeConnectorStatusResult> {
  try {
    let binaryPath = await resolveGhBinaryPath();
    const managedSkillMarker = path.join(githubSkillDir(), ".near-managed");
    if (!binaryPath && fs.existsSync(managedSkillMarker)) {
      binaryPath = await ensureGhBinaryInstalled();
    }
    if (!binaryPath) {
      tryPersistGithubConnectorStatus(false);
      return {
        ok: true,
        available: true,
        connected: false,
        label: "可用",
      };
    }
    const status = parseGithubAuthStatus(
      await runGhCommand(["auth", "status", "--hostname", "github.com"]),
    );
    if (status.connected && binaryPath) {
      try {
        ensureGithubSkill(binaryPath);
      } catch (error) {
        tryPersistGithubConnectorStatus(false);
        return {
          ok: false,
          available: true,
          connected: false,
          label: "连接异常",
          error: error instanceof Error ? error.message : String(error),
        };
      }
    } else if (!status.connected) {
      removeGithubSkill();
    }
    tryPersistGithubConnectorStatus(status.connected && !status.error);
    return {
      ok: !status.error,
      available: !status.error,
      connected: status.connected,
      label: status.label,
      error: status.error,
      account: status.account,
    };
  } catch (error) {
    tryPersistGithubConnectorStatus(false);
    return {
      ok: false,
      available: false,
      connected: false,
      label: "暂不可用",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function sendGithubProgress(
  phase: "installing" | "code_ready" | "opening_browser" | "waiting" | "success" | "disconnected" | "error",
  extra?: { oneTimeCode?: string },
): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("native-connector-github-progress", {
    phase,
    ...(extra?.oneTimeCode ? { oneTimeCode: extra.oneTimeCode } : {}),
  });
}

function startGithubLogin(): Promise<NativeConnectorStatusResult> {
  if (githubAuthBusy) {
    return Promise.resolve({
      ok: false,
      available: true,
      connected: false,
      label: "连接中",
      error: "GitHub 正在等待浏览器授权",
    });
  }
  githubAuthBusy = true;
  return new Promise((resolve) => {
    let opened = false;
    let codeSent = false;
    let output = "";
    let settled = false;
    let proc: ChildProcess | null = null;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const finish = async (result?: NativeConnectorStatusResult, terminate = false) => {
      if (settled) return;
      settled = true;
      cancelActiveGithubLogin = null;
      if (timeout) clearTimeout(timeout);
      const currentProc = proc;
      if (terminate && currentProc && currentProc.exitCode === null) {
        await new Promise<void>((done) => {
          const fallback = setTimeout(done, 2000);
          currentProc.once("close", () => {
            clearTimeout(fallback);
            done();
          });
          try {
            currentProc.kill("SIGTERM");
          } catch {
            done();
          }
        });
      }
      if (proc && githubAuthProcess === proc) githubAuthProcess = null;
      githubAuthBusy = false;
      const status = result ?? (await getGithubStatus());
      if (status.error === "已取消") {
        sendGithubProgress("disconnected");
      } else {
        sendGithubProgress(status.connected ? "success" : "error");
      }
      resolve(status);
    };
    cancelActiveGithubLogin = (reason) => {
      void finish(
        {
          ok: false,
          available: true,
          connected: false,
          label: "可用",
          error: reason || "已取消",
        },
        true,
      );
    };
    const consume = (chunk: Buffer) => {
      output = `${output}${chunk.toString("utf8")}`.slice(-32768);
      if (/Press Enter to open/i.test(output) && proc?.stdin && !proc.stdin.destroyed) {
        try {
          proc.stdin.write("\n");
        } catch {
          // ignore
        }
      }
      const oneTimeCode = extractGithubDeviceCode(output);
      if (!codeSent && oneTimeCode) {
        codeSent = true;
        sendGithubProgress("code_ready", { oneTimeCode });
      }
      const deviceUrl = extractGithubDeviceUrl(output);
      if (!opened && deviceUrl) {
        opened = true;
        sendGithubProgress("opening_browser");
        void shell
          .openExternal(deviceUrl)
          .then(() => sendGithubProgress("waiting"))
          .catch(() =>
            finish(
              {
                ok: false,
                available: true,
                connected: false,
                label: "连接失败",
                error: "无法打开 GitHub 授权页面",
              },
              true,
            ),
          );
      }
    };
    void ensureGhBinaryInstalled()
      .then((binaryPath) => {
        proc = spawn(
          binaryPath,
          ["auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--web"],
          {
            stdio: ["pipe", "pipe", "pipe"],
            env: {
              ...process.env,
              NO_COLOR: "1",
              // Prefer AgenticX Ontology-controlled browser open when gh respects BROWSER.
              BROWSER: process.platform === "win32" ? "echo" : "/bin/true",
              GH_PROMPT: "disabled",
            },
          },
        );
        githubAuthProcess = proc;
        timeout = setTimeout(() => {
          void finish(
            {
              ok: false,
              available: true,
              connected: false,
              label: "连接超时",
              error: "浏览器授权已超时，请重试",
            },
            true,
          );
        }, 5 * 60 * 1000);
        proc.stdout?.on("data", consume);
        proc.stderr?.on("data", consume);
        proc.on("error", () => {
          void finish(
            {
              ok: false,
              available: true,
              connected: false,
              label: "连接失败",
              error: "无法启动 GitHub 授权",
            },
            true,
          );
        });
        proc.on("exit", (code) => {
          if (code === 0) {
            void finish();
            return;
          }
          void finish({
            ok: false,
            available: true,
            connected: false,
            label: "连接失败",
            error: opened || codeSent ? "GitHub 授权未完成或已取消" : "未能获取 GitHub 授权码",
          });
        });
      })
      .catch((error) => {
        void finish({
          ok: false,
          available: true,
          connected: false,
          label: "安装失败",
          error: error instanceof Error ? error.message : String(error),
        });
      });
  });
}

const LARK_CLI_VERSION = "1.0.68";
const LARK_CLI_RELEASE_BASE = `https://github.com/larksuite/cli/releases/download/v${LARK_CLI_VERSION}`;
const LARK_CLI_ARCHIVE_MAX_BYTES = 60 * 1024 * 1024;

function persistFeishuConnectorStatus(connected: boolean): void {
  const parentDir = path.dirname(NATIVE_CONNECTOR_STATUS_PATH);
  fs.mkdirSync(parentDir, { recursive: true, mode: 0o700 });
  if (
    fs.existsSync(NATIVE_CONNECTOR_STATUS_PATH) &&
    fs.lstatSync(NATIVE_CONNECTOR_STATUS_PATH).isSymbolicLink()
  ) {
    throw new Error("原生连接器状态文件不能是符号链接");
  }
  let current: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(NATIVE_CONNECTOR_STATUS_PATH, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      current = parsed as Record<string, unknown>;
    }
  } catch {
    current = {};
  }
  const connectors =
    current.connectors &&
    typeof current.connectors === "object" &&
    !Array.isArray(current.connectors)
      ? (current.connectors as Record<string, unknown>)
      : {};
  const next = {
    ...current,
    version: 1,
    connectors: {
      ...connectors,
      feishu: {
        connected,
        capability: "skill",
        skill_name: "feishu",
        updated_at: new Date().toISOString(),
      },
    },
  };
  const tempPath = `${NATIVE_CONNECTOR_STATUS_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(next, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.renameSync(tempPath, NATIVE_CONNECTOR_STATUS_PATH);
}

function tryPersistFeishuConnectorStatus(connected: boolean): void {
  try {
    persistFeishuConnectorStatus(connected);
  } catch (error) {
    console.warn("[native-connectors] failed to persist Feishu status:", String(error));
  }
}

function resolveSystemLarkCliPath(): string | null {
  const candidates: string[] = [];
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || "";
    if (appData) {
      candidates.push(path.join(appData, "npm", "lark-cli.cmd"));
      candidates.push(path.join(appData, "npm", "lark-cli.exe"));
    }
  } else {
    candidates.push(
      "/opt/homebrew/bin/lark-cli",
      "/usr/local/bin/lark-cli",
      "/usr/bin/lark-cli",
      path.join(os.homedir(), ".npm-global", "bin", "lark-cli"),
    );
  }
  try {
    const whichCmd = process.platform === "win32" ? "where" : "which";
    const found = execFileSync(whichCmd, ["lark-cli"], {
      encoding: "utf8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
      env: process.env,
    })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    if (found) candidates.unshift(found);
  } catch {
    // PATH lookup is best-effort
  }
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // continue
    }
  }
  return null;
}

function larkCliArchiveInfo(): { archiveName: string; binaryMember: string; binaryName: string } {
  const key = `${process.platform}-${process.arch}`;
  const ver = LARK_CLI_VERSION;
  const table: Record<string, { archiveName: string; binaryMember: string; binaryName: string }> = {
    "darwin-arm64": {
      archiveName: `lark-cli-${ver}-darwin-arm64.tar.gz`,
      binaryMember: "lark-cli",
      binaryName: "lark-cli",
    },
    "darwin-x64": {
      archiveName: `lark-cli-${ver}-darwin-amd64.tar.gz`,
      binaryMember: "lark-cli",
      binaryName: "lark-cli",
    },
    "linux-x64": {
      archiveName: `lark-cli-${ver}-linux-amd64.tar.gz`,
      binaryMember: "lark-cli",
      binaryName: "lark-cli",
    },
    "linux-arm64": {
      archiveName: `lark-cli-${ver}-linux-arm64.tar.gz`,
      binaryMember: "lark-cli",
      binaryName: "lark-cli",
    },
    "win32-x64": {
      archiveName: `lark-cli-${ver}-windows-amd64.zip`,
      binaryMember: "lark-cli.exe",
      binaryName: "lark-cli.exe",
    },
    "win32-arm64": {
      archiveName: `lark-cli-${ver}-windows-arm64.zip`,
      binaryMember: "lark-cli.exe",
      binaryName: "lark-cli.exe",
    },
  };
  const info = table[key];
  if (!info) throw new Error(`当前平台暂不支持飞书连接器：${key}`);
  return info;
}

function larkCliArchiveSha256(): string {
  const hashes: Record<string, string> = {
    [`lark-cli-${LARK_CLI_VERSION}-darwin-amd64.tar.gz`]:
      "c6406dcd19cf4398138f8143e1097926d13d0fe22d1fa79b27ffb48a137d0be8",
    [`lark-cli-${LARK_CLI_VERSION}-darwin-arm64.tar.gz`]:
      "5a8bab26cd6ad135c39960c8ed30cf0a91f202853bb74e2bfb80f0f9bcdea3d5",
    [`lark-cli-${LARK_CLI_VERSION}-linux-amd64.tar.gz`]:
      "8daaeb11b7cadcc77f07fd9ae7948f6c370e8305337888cb930ac7362a05cad8",
    [`lark-cli-${LARK_CLI_VERSION}-linux-arm64.tar.gz`]:
      "86d7d94dead5be7a9d16ec28f363792b0abf0e5e4e1475148e8585c1802a6165",
    [`lark-cli-${LARK_CLI_VERSION}-windows-amd64.zip`]:
      "d593f658151a0de1ab26b89ee8ff1d93a216777b8120db0b048013468ff63a1d",
    [`lark-cli-${LARK_CLI_VERSION}-windows-arm64.zip`]:
      "c86eccf8b2f94652c3fd35c49dac9644ea152edd3248cb986b7efdd995d236e7",
  };
  const { archiveName } = larkCliArchiveInfo();
  const digest = hashes[archiveName];
  if (!digest) throw new Error(`缺少飞书 CLI 校验值：${archiveName}`);
  return digest;
}

function larkCliInstallDir(): string {
  return path.join(resolveDesktopAgxHome(), "connectors", "feishu", LARK_CLI_VERSION);
}

async function resolveInstalledLarkCliBinaryPath(): Promise<string | null> {
  const { binaryName } = larkCliArchiveInfo();
  const binaryPath = path.join(larkCliInstallDir(), "bin", binaryName);
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(binaryPath);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  if (
    feishuBinaryValidationCache?.path === binaryPath &&
    feishuBinaryValidationCache.size === stat.size &&
    feishuBinaryValidationCache.mtimeMs === stat.mtimeMs
  ) {
    return feishuBinaryValidationCache.valid ? binaryPath : null;
  }
  const valid = stat.size > 1024 * 100;
  feishuBinaryValidationCache = {
    path: binaryPath,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    valid,
  };
  if (!valid) return null;
  if (process.platform !== "win32") fs.chmodSync(binaryPath, 0o755);
  return binaryPath;
}

async function resolveLarkCliBinaryPath(): Promise<string | null> {
  const systemPath = resolveSystemLarkCliPath();
  if (systemPath) return systemPath;
  return await resolveInstalledLarkCliBinaryPath();
}

async function extractLarkCliArchive(
  archivePath: string,
  partialDir: string,
  archiveName: string,
  binaryMember: string,
): Promise<string> {
  if (archiveName.endsWith(".tar.gz")) {
    await extractTar({
      file: archivePath,
      cwd: partialDir,
      filter: (memberPath) =>
        memberPath === binaryMember ||
        memberPath.endsWith(`/${binaryMember}`) ||
        memberPath.endsWith("/LICENSE") ||
        memberPath === "LICENSE",
    });
  } else if (archiveName.endsWith(".zip")) {
    if (process.platform === "win32") {
      await new Promise<void>((resolve, reject) => {
        execFile(
          "powershell.exe",
          [
            "-NoProfile",
            "-Command",
            `Expand-Archive -LiteralPath '${archivePath.replace(/'/g, "''")}' -DestinationPath '${partialDir.replace(/'/g, "''")}' -Force`,
          ],
          { timeout: 120000, maxBuffer: 4 * 1024 * 1024 },
          (error) => {
            if (error) reject(new Error("解压飞书 CLI 失败"));
            else resolve();
          },
        );
      });
    } else {
      await new Promise<void>((resolve, reject) => {
        execFile(
          "unzip",
          ["-o", archivePath, "-d", partialDir],
          { timeout: 120000, maxBuffer: 4 * 1024 * 1024 },
          (error) => {
            if (error) reject(new Error("解压飞书 CLI 失败"));
            else resolve();
          },
        );
      });
    }
  } else {
    throw new Error(`不支持的飞书 CLI 归档格式：${archiveName}`);
  }
  const direct = path.join(partialDir, binaryMember);
  if (fs.existsSync(direct)) return direct;
  // Windows zip may nest under a top-level folder; search one level.
  try {
    for (const entry of fs.readdirSync(partialDir)) {
      const nested = path.join(partialDir, entry, binaryMember);
      if (fs.existsSync(nested)) return nested;
    }
  } catch {
    // fall through
  }
  throw new Error("飞书 CLI 运行文件提取失败");
}

async function installLarkCliBinary(): Promise<string> {
  const installed = await resolveInstalledLarkCliBinaryPath();
  if (installed) return installed;
  sendFeishuProgress("installing");
  const { archiveName, binaryMember, binaryName } = larkCliArchiveInfo();
  const parentDir = path.dirname(larkCliInstallDir());
  fs.mkdirSync(parentDir, { recursive: true, mode: 0o700 });
  const partialDir = path.join(parentDir, `.partial-${crypto.randomUUID()}`);
  const archivePath = path.join(parentDir, `.download-${crypto.randomUUID()}-${archiveName}`);
  try {
    const response = await proxyAwareFetch(`${LARK_CLI_RELEASE_BASE}/${archiveName}`, {
      signal: AbortSignal.timeout(90000),
    });
    if (!response.ok) throw new Error(`下载飞书 CLI 失败：HTTP ${response.status}`);
    const declaredSize = Number(response.headers.get("content-length") || "0");
    if (declaredSize > LARK_CLI_ARCHIVE_MAX_BYTES) throw new Error("飞书 CLI 下载包超过安全限制");
    const archive = Buffer.from(await readBodyWithLimit(response.body, LARK_CLI_ARCHIVE_MAX_BYTES));
    if (archive.length === 0 || archive.length > LARK_CLI_ARCHIVE_MAX_BYTES) {
      throw new Error("飞书 CLI 下载包大小异常");
    }
    const digest = crypto.createHash("sha256").update(archive).digest("hex");
    if (digest !== larkCliArchiveSha256()) throw new Error("飞书 CLI 完整性校验失败");
    fs.mkdirSync(partialDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(archivePath, archive, { mode: 0o600 });
    const extractedBinary = await extractLarkCliArchive(
      archivePath,
      partialDir,
      archiveName,
      binaryMember,
    );
    const stat = fs.lstatSync(extractedBinary);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("飞书 CLI 运行文件无效");
    if (process.platform !== "win32") fs.chmodSync(extractedBinary, 0o755);
    const stagedBinDir = path.join(partialDir, "bin");
    fs.mkdirSync(stagedBinDir, { recursive: true, mode: 0o700 });
    const stagedBinary = path.join(stagedBinDir, binaryName);
    if (path.resolve(extractedBinary) !== path.resolve(stagedBinary)) {
      fs.renameSync(extractedBinary, stagedBinary);
    }
    if (fs.existsSync(larkCliInstallDir())) {
      fs.rmSync(larkCliInstallDir(), { recursive: true, force: true });
    }
    fs.renameSync(partialDir, larkCliInstallDir());
    const result = await resolveInstalledLarkCliBinaryPath();
    if (!result) throw new Error("飞书 CLI 安装未完成");
    return result;
  } finally {
    fs.rmSync(archivePath, { force: true });
    fs.rmSync(partialDir, { recursive: true, force: true });
  }
}

async function ensureLarkCliBinaryInstalled(): Promise<string> {
  const existing = await resolveLarkCliBinaryPath();
  if (existing) return existing;
  if (feishuInstallPromise) return await feishuInstallPromise;
  feishuInstallPromise = installLarkCliBinary().finally(() => {
    feishuInstallPromise = null;
  });
  return await feishuInstallPromise;
}

async function runLarkCliCommand(
  args: string[],
  timeoutMs = 15000,
  binaryPathOverride?: string,
): Promise<string> {
  const binaryPath = binaryPathOverride || (await resolveLarkCliBinaryPath());
  if (!binaryPath) throw new Error("飞书 CLI 尚未安装");
  return await new Promise((resolve, reject) => {
    execFile(
      binaryPath,
      args,
      {
        timeout: timeoutMs,
        maxBuffer: 2 * 1024 * 1024,
        env: {
          ...process.env,
          NO_COLOR: "1",
        },
      },
      (error, stdout, stderr) => {
        const output = `${stdout ?? ""}\n${stderr ?? ""}`.trim();
        // auth status may exit non-zero when not logged in / not configured.
        if (error && !output) {
          reject(new Error("飞书 CLI 命令执行失败"));
          return;
        }
        resolve(output);
      },
    );
  });
}

function feishuSkillDir(): string {
  return path.join(resolveDesktopAgxHome(), "skills", "near-connectors", "feishu");
}

function ensureFeishuSkill(binaryPath: string): void {
  const skillDir = feishuSkillDir();
  const skillPath = path.join(skillDir, "SKILL.md");
  const markerPath = path.join(skillDir, ".near-managed");
  const directoryExists = fs.existsSync(skillDir);
  const markerExists = fs.existsSync(markerPath);
  assertManagedSkillDirectory(directoryExists, markerExists);
  const quotedBinary = binaryPath.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const content = `---
name: feishu
description: 使用飞书官方 CLI (lark-cli) 操作消息、文档、多维表格、日历、任务、邮件等飞书能力。
---

# 飞书 (Lark)

仅在用户要求操作飞书/Lark 时使用。通过 bash_exec 调用官方 CLI（本机已登录）：

\`\`\`bash
"${quotedBinary}" <service> --help          # 发现某业务域的快捷命令，如 im/docs/base/calendar/task/mail
"${quotedBinary}" <service> +<shortcut> ...  # 人/AI 友好的快捷命令（带智能默认与表格输出）
"${quotedBinary}" schema <method>            # 自省某 API 的参数/请求体/返回结构/所需 scope
"${quotedBinary}" api GET|POST <endpoint>    # 需要原始 OpenAPI 时
\`\`\`

读取类命令（+agenda、+messages 查询、list/view/status/search、auth status）可直接执行；
写操作（发消息、建/改文档、建/删记录、发邮件、任务创建/完成、审批处理等）必须先向用户展示参数、
优先用 \`--dry-run\` 预览并确认后再执行。默认输出 \`--format json\`，判断成功以返回体 \`ok === true\`（或退出码）为准。
不得输出或读取 lark-cli 本地凭证。若提示未登录/未配置，引导用户前往「设置 → 连接器 → 飞书」重新连接。
`;
  if (!directoryExists) {
    const parentDir = path.dirname(skillDir);
    const partialDir = path.join(parentDir, `.feishu.partial-${crypto.randomUUID()}`);
    fs.mkdirSync(parentDir, { recursive: true, mode: 0o700 });
    try {
      fs.mkdirSync(partialDir, { mode: 0o700 });
      fs.writeFileSync(path.join(partialDir, "SKILL.md"), content, {
        encoding: "utf8",
        mode: 0o600,
      });
      fs.writeFileSync(path.join(partialDir, ".near-managed"), "managed by AgenticX Ontology\n", {
        encoding: "utf8",
        mode: 0o600,
      });
      fs.renameSync(partialDir, skillDir);
    } catch (error) {
      fs.rmSync(partialDir, { recursive: true, force: true });
      throw error;
    }
    return;
  }
  const tempPath = `${skillPath}.tmp`;
  fs.writeFileSync(tempPath, content, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tempPath, skillPath);
}

function removeFeishuSkill(): void {
  const skillDir = feishuSkillDir();
  const markerPath = path.join(skillDir, ".near-managed");
  if (!fs.existsSync(markerPath)) return;
  fs.rmSync(skillDir, { recursive: true, force: true });
}

async function getFeishuStatus(): Promise<NativeConnectorStatusResult> {
  try {
    let binaryPath = await resolveLarkCliBinaryPath();
    const managedSkillMarker = path.join(feishuSkillDir(), ".near-managed");
    if (!binaryPath && fs.existsSync(managedSkillMarker)) {
      binaryPath = await ensureLarkCliBinaryInstalled();
    }
    if (!binaryPath) {
      tryPersistFeishuConnectorStatus(false);
      return {
        ok: true,
        available: true,
        connected: false,
        label: "可用",
      };
    }
    const status = parseFeishuAuthStatus(await runLarkCliCommand(["auth", "status"], 15000, binaryPath));
    if (status.connected && binaryPath) {
      try {
        ensureFeishuSkill(binaryPath);
      } catch (error) {
        tryPersistFeishuConnectorStatus(false);
        return {
          ok: false,
          available: true,
          connected: false,
          label: "连接异常",
          error: error instanceof Error ? error.message : String(error),
        };
      }
    } else if (!status.connected) {
      removeFeishuSkill();
    }
    tryPersistFeishuConnectorStatus(status.connected && !status.error);
    return {
      ok: !status.error,
      available: !status.error,
      connected: status.connected,
      label: status.label,
      error: status.error,
      account: status.account,
    };
  } catch (error) {
    tryPersistFeishuConnectorStatus(false);
    return {
      ok: false,
      available: false,
      connected: false,
      label: "暂不可用",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

type FeishuProgressPhase =
  | "installing"
  | "config_setup"
  | "config_done"
  | "auth_setup"
  | "waiting"
  | "success"
  | "disconnected"
  | "error";

function sendFeishuProgress(
  phase: FeishuProgressPhase,
  extra?: { verificationUrl?: string },
): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("native-connector-feishu-progress", {
    phase,
    ...(extra?.verificationUrl ? { verificationUrl: extra.verificationUrl } : {}),
  });
}

function spawnFeishuPhase(
  binaryPath: string,
  args: string[],
  progressPhase: "config_setup" | "waiting",
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    let output = "";
    let opened = false;
    const proc = spawn(binaryPath, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        NO_COLOR: "1",
        BROWSER: process.platform === "win32" ? "echo" : "/bin/true",
      },
    });
    feishuAuthProcess = proc;
    const timeout = setTimeout(() => {
      try {
        proc.kill("SIGTERM");
      } catch {
        // ignore
      }
      reject(new Error("浏览器授权已超时，请重试"));
    }, 5 * 60 * 1000);

    const consume = (chunk: Buffer) => {
      output = `${output}${chunk.toString("utf8")}`.slice(-65536);
      if (/Press Enter to open/i.test(output) && proc.stdin && !proc.stdin.destroyed) {
        try {
          proc.stdin.write("\n");
        } catch {
          // ignore
        }
      }
      const flow = extractFeishuDeviceFlow(output);
      if (!opened && flow?.verificationUrl) {
        opened = true;
        sendFeishuProgress(progressPhase, { verificationUrl: flow.verificationUrl });
        void shell.openExternal(flow.verificationUrl).catch(() => {
          // Modal still shows the URL as fallback
        });
      }
    };

    proc.stdout?.on("data", consume);
    proc.stderr?.on("data", consume);
    proc.on("error", (error) => {
      clearTimeout(timeout);
      if (feishuAuthProcess === proc) feishuAuthProcess = null;
      reject(error);
    });
    proc.on("exit", (code) => {
      clearTimeout(timeout);
      if (feishuAuthProcess === proc) feishuAuthProcess = null;
      resolve({ code, output });
    });
  });
}

function startFeishuLogin(): Promise<NativeConnectorStatusResult> {
  if (feishuAuthBusy) {
    return Promise.resolve({
      ok: false,
      available: true,
      connected: false,
      label: "连接中",
      error: "飞书正在等待浏览器授权",
    });
  }
  feishuAuthBusy = true;
  return new Promise((resolve) => {
    let settled = false;
    const finish = async (result?: NativeConnectorStatusResult, terminate = false) => {
      if (settled) return;
      settled = true;
      cancelActiveFeishuLogin = null;
      const currentProc = feishuAuthProcess;
      if (terminate && currentProc && currentProc.exitCode === null) {
        await new Promise<void>((done) => {
          const fallback = setTimeout(done, 2000);
          currentProc.once("close", () => {
            clearTimeout(fallback);
            done();
          });
          try {
            currentProc.kill("SIGTERM");
          } catch {
            done();
          }
        });
      }
      feishuAuthProcess = null;
      feishuAuthBusy = false;
      const status = result ?? (await getFeishuStatus());
      if (status.error === "已取消") {
        sendFeishuProgress("disconnected");
      } else {
        sendFeishuProgress(status.connected ? "success" : "error");
      }
      resolve(status);
    };

    cancelActiveFeishuLogin = (reason) => {
      void finish(
        {
          ok: false,
          available: true,
          connected: false,
          label: "可用",
          error: reason || "已取消",
        },
        true,
      );
    };

    void (async () => {
      try {
        sendFeishuProgress("installing");
        const binaryPath = await ensureLarkCliBinaryInstalled();
        if (settled) return;

        // Probe whether app credentials already exist.
        let configured = false;
        try {
          const probe = parseFeishuAuthStatus(
            await runLarkCliCommand(["auth", "status"], 15000, binaryPath),
          );
          configured = probe.configured;
        } catch {
          configured = false;
        }
        if (settled) return;

        if (!configured) {
          const configResult = await spawnFeishuPhase(
            binaryPath,
            ["config", "init", "--new"],
            "config_setup",
          );
          if (settled) return;
          if (configResult.code !== 0) {
            await finish({
              ok: false,
              available: true,
              connected: false,
              label: "连接失败",
              error: "飞书应用创建未完成或已取消",
            });
            return;
          }
          sendFeishuProgress("config_done");
        }

        const noWaitOutput = await runLarkCliCommand(
          ["auth", "login", "--recommend", "--no-wait"],
          30000,
          binaryPath,
        );
        if (settled) return;
        const flow = extractFeishuDeviceFlow(noWaitOutput);
        if (!flow?.verificationUrl || !flow.deviceCode) {
          await finish({
            ok: false,
            available: true,
            connected: false,
            label: "连接失败",
            error: "未能获取飞书授权链接",
          });
          return;
        }
        sendFeishuProgress("auth_setup", { verificationUrl: flow.verificationUrl });
        void shell.openExternal(flow.verificationUrl).catch(() => {
          // Modal fallback button still available
        });

        const authResult = await spawnFeishuPhase(
          binaryPath,
          ["auth", "login", "--device-code", flow.deviceCode],
          "waiting",
        );
        if (settled) return;
        if (authResult.code !== 0) {
          await finish({
            ok: false,
            available: true,
            connected: false,
            label: "连接失败",
            error: "飞书授权未完成或已取消",
          });
          return;
        }
        await finish();
      } catch (error) {
        if (settled) return;
        await finish({
          ok: false,
          available: true,
          connected: false,
          label: "连接失败",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();
  });
}

/*
 * FR-0 wecom-cli init interaction record (wecom-cli 0.1.9, PTY probe 2026-07-14):
 *
 * Source: https://github.com/WecomTeam/wecom-cli/blob/main/src/cmd/init.rs
 *
 * Non-TTY stderr rejects interactive init ("请使用 --noninteractive") — --noninteractive
 * is the QR-code path, NOT credential stdin. Manual Bot ID/Secret requires a real PTY.
 *
 * Interactive sequence (cliclack):
 *   1) intro "企业微信机器人初始化"
 *   2) select "请选择企微机器人接入方式："
 *        - qrcode: 扫码接入（推荐）
 *        - manual: 手动输入 Bot ID 和 Secret   ← AgenticX Ontology sends Down+Enter
 *   3) input  "企业微信机器人 Bot ID"  → write botId + CR
 *   4) password "企业微信机器人 Secret" → write botSecret + CR
 *   5) spinner verify → "企业微信机器人凭证验证成功" / "初始化完成 ✅"
 *      or fail → "初始化失败 ❌" + rollback bot.enc
 *
 * Credentials: ~/.config/wecom/bot.enc (no logout subcommand; delete config dir).
 * npm binary member: package/bin/wecom-cli(.exe)
 */
const WECOM_CLI_VERSION = "0.1.9";
const WECOM_CLI_ARCHIVE_MAX_BYTES = 30 * 1024 * 1024;
const WECOM_NPM_REGISTRY = "https://registry.npmjs.org";

function wecomConfigDir(): string {
  return path.join(os.homedir(), ".config", "wecom");
}

function wecomBotEncPath(): string {
  return path.join(wecomConfigDir(), "bot.enc");
}

function wecomInstallDir(version = WECOM_CLI_VERSION): string {
  return path.join(resolveDesktopAgxHome(), "connectors", "wecom", version);
}

function wecomBinaryName(): string {
  return process.platform === "win32" ? "wecom-cli.exe" : "wecom-cli";
}

function wecomSkillDir(): string {
  return path.join(resolveDesktopAgxHome(), "skills", "near-connectors", "wecom");
}

function persistWecomConnectorStatus(connected: boolean): void {
  const parentDir = path.dirname(NATIVE_CONNECTOR_STATUS_PATH);
  fs.mkdirSync(parentDir, { recursive: true, mode: 0o700 });
  if (
    fs.existsSync(NATIVE_CONNECTOR_STATUS_PATH) &&
    fs.lstatSync(NATIVE_CONNECTOR_STATUS_PATH).isSymbolicLink()
  ) {
    throw new Error("原生连接器状态文件不能是符号链接");
  }
  let current: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(NATIVE_CONNECTOR_STATUS_PATH, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      current = parsed as Record<string, unknown>;
    }
  } catch {
    current = {};
  }
  const connectors =
    current.connectors &&
    typeof current.connectors === "object" &&
    !Array.isArray(current.connectors)
      ? (current.connectors as Record<string, unknown>)
      : {};
  const next = {
    ...current,
    version: 1,
    connectors: {
      ...connectors,
      wecom: {
        connected,
        capability: "skill",
        skill_name: "wecom",
        updated_at: new Date().toISOString(),
      },
    },
  };
  const tempPath = `${NATIVE_CONNECTOR_STATUS_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(next, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.renameSync(tempPath, NATIVE_CONNECTOR_STATUS_PATH);
}

function tryPersistWecomConnectorStatus(connected: boolean): void {
  try {
    persistWecomConnectorStatus(connected);
  } catch (error) {
    console.warn("[native-connectors] failed to persist WeCom status:", String(error));
  }
}

function clearWecomLocalCredentials(): void {
  const dir = wecomConfigDir();
  if (!fs.existsSync(dir)) return;
  fs.rmSync(dir, { recursive: true, force: true });
}

function resolveSystemWecomCliPath(): string | null {
  const candidates: string[] = [];
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || "";
    if (appData) {
      candidates.push(path.join(appData, "npm", "wecom-cli.cmd"));
      candidates.push(path.join(appData, "npm", "wecom-cli.exe"));
    }
  } else {
    candidates.push(
      "/opt/homebrew/bin/wecom-cli",
      "/usr/local/bin/wecom-cli",
      "/usr/bin/wecom-cli",
      path.join(os.homedir(), ".npm-global", "bin", "wecom-cli"),
    );
  }
  try {
    const whichCmd = process.platform === "win32" ? "where" : "which";
    const found = execFileSync(whichCmd, ["wecom-cli"], {
      encoding: "utf8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
      env: process.env,
    })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    if (found) candidates.unshift(found);
  } catch {
    // PATH lookup is best-effort
  }
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // continue
    }
  }
  return null;
}

async function resolveInstalledWecomCliBinaryPath(): Promise<string | null> {
  const binaryPath = path.join(wecomInstallDir(), "bin", wecomBinaryName());
  try {
    if (!fs.existsSync(binaryPath)) return null;
    const stat = fs.lstatSync(binaryPath);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    if (
      wecomBinaryValidationCache &&
      wecomBinaryValidationCache.path === binaryPath &&
      wecomBinaryValidationCache.size === stat.size &&
      wecomBinaryValidationCache.mtimeMs === stat.mtimeMs
    ) {
      return wecomBinaryValidationCache.valid ? binaryPath : null;
    }
    await new Promise<void>((resolve, reject) => {
      execFile(
        binaryPath,
        ["--help"],
        { timeout: 8000, maxBuffer: 1024 * 1024, env: { ...process.env, NO_COLOR: "1" } },
        (error) => {
          if (error) reject(error);
          else resolve();
        },
      );
    });
    wecomBinaryValidationCache = {
      path: binaryPath,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      valid: true,
    };
    return binaryPath;
  } catch {
    wecomBinaryValidationCache = {
      path: binaryPath,
      size: 0,
      mtimeMs: 0,
      valid: false,
    };
    return null;
  }
}

async function resolveWecomCliBinaryPath(): Promise<string | null> {
  return resolveSystemWecomCliPath() || (await resolveInstalledWecomCliBinaryPath());
}

function verifyNpmSriIntegrity(archive: Buffer, integrity: string): boolean {
  const match = integrity.match(/^sha512-([A-Za-z0-9+/=]+)$/);
  if (!match) return false;
  const digest = crypto.createHash("sha512").update(archive).digest("base64");
  return digest === match[1];
}

async function installWecomCliBinary(): Promise<string> {
  const installed = await resolveInstalledWecomCliBinaryPath();
  if (installed) return installed;
  sendWecomProgress("installing");
  const pkgName = wecomNpmPlatformPackage(process.platform, process.arch);
  if (!pkgName) throw new Error("当前平台暂不支持企业微信连接器");
  const parentDir = path.dirname(wecomInstallDir());
  fs.mkdirSync(parentDir, { recursive: true, mode: 0o700 });
  const partialDir = path.join(parentDir, `.partial-${crypto.randomUUID()}`);
  const archivePath = path.join(parentDir, `.download-${crypto.randomUUID()}.tgz`);
  try {
    const metaResponse = await proxyAwareFetch(
      `${WECOM_NPM_REGISTRY}/${pkgName.replace("/", "%2F")}`,
      { signal: AbortSignal.timeout(30000) },
    );
    if (!metaResponse.ok) {
      throw new Error(`读取企业微信 CLI 包元数据失败：HTTP ${metaResponse.status}`);
    }
    const meta = (await metaResponse.json()) as {
      "dist-tags"?: { latest?: string };
      versions?: Record<string, { dist?: { tarball?: string; integrity?: string } }>;
    };
    let version = WECOM_CLI_VERSION;
    let dist = meta.versions?.[version]?.dist;
    if (!dist?.tarball || !dist.integrity) {
      const latest = meta.versions?.[meta["dist-tags"]?.latest || ""]?.dist;
      const latestTag = meta["dist-tags"]?.latest;
      if (!latestTag || !latest?.tarball || !latest.integrity) {
        throw new Error("企业微信 CLI 包元数据缺少 tarball/integrity");
      }
      version = latestTag;
      dist = latest;
      console.warn(`[native-connectors] wecom-cli pinned ${WECOM_CLI_VERSION} missing; using ${version}`);
    }
    const response = await proxyAwareFetch(dist.tarball!, {
      signal: AbortSignal.timeout(90000),
    });
    if (!response.ok) throw new Error(`下载企业微信 CLI 失败：HTTP ${response.status}`);
    const declaredSize = Number(response.headers.get("content-length") || "0");
    if (declaredSize > WECOM_CLI_ARCHIVE_MAX_BYTES) {
      throw new Error("企业微信 CLI 下载包超过安全限制");
    }
    const archive = Buffer.from(await readBodyWithLimit(response.body, WECOM_CLI_ARCHIVE_MAX_BYTES));
    if (archive.length === 0 || archive.length > WECOM_CLI_ARCHIVE_MAX_BYTES) {
      throw new Error("企业微信 CLI 下载包大小异常");
    }
    if (!verifyNpmSriIntegrity(archive, dist.integrity!)) {
      throw new Error("企业微信 CLI 完整性校验失败");
    }
    fs.mkdirSync(partialDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(archivePath, archive, { mode: 0o600 });
    const binaryMember = `package/bin/${wecomBinaryName()}`;
    await extractTar({
      file: archivePath,
      cwd: partialDir,
      filter: (memberPath) =>
        memberPath === binaryMember ||
        memberPath === "package/bin/wecom-cli" ||
        memberPath === "package/bin/wecom-cli.exe" ||
        memberPath.endsWith("/LICENSE"),
    });
    const extractedBinary = path.join(partialDir, binaryMember);
    if (!fs.existsSync(extractedBinary)) {
      throw new Error("企业微信 CLI 运行文件提取失败");
    }
    const stat = fs.lstatSync(extractedBinary);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("企业微信 CLI 运行文件无效");
    if (process.platform !== "win32") fs.chmodSync(extractedBinary, 0o755);
    const stagedBinDir = path.join(partialDir, "bin");
    fs.mkdirSync(stagedBinDir, { recursive: true, mode: 0o700 });
    const stagedBinary = path.join(stagedBinDir, wecomBinaryName());
    if (path.resolve(extractedBinary) !== path.resolve(stagedBinary)) {
      fs.renameSync(extractedBinary, stagedBinary);
    }
    const finalDir = wecomInstallDir();
    if (fs.existsSync(finalDir)) fs.rmSync(finalDir, { recursive: true, force: true });
    fs.renameSync(partialDir, finalDir);
    const result = await resolveInstalledWecomCliBinaryPath();
    if (!result) throw new Error("企业微信 CLI 安装未完成");
    return result;
  } finally {
    fs.rmSync(archivePath, { force: true });
    fs.rmSync(partialDir, { recursive: true, force: true });
  }
}

async function ensureWecomCliBinaryInstalled(): Promise<string> {
  const existing = await resolveWecomCliBinaryPath();
  if (existing) return existing;
  if (wecomInstallPromise) return await wecomInstallPromise;
  wecomInstallPromise = installWecomCliBinary().finally(() => {
    wecomInstallPromise = null;
  });
  return await wecomInstallPromise;
}

async function runWecomCliCommand(
  args: string[],
  timeoutMs = 15000,
  binaryPathOverride?: string,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const binaryPath = binaryPathOverride || (await resolveWecomCliBinaryPath());
  if (!binaryPath) throw new Error("企业微信 CLI 尚未安装");
  return await new Promise((resolve) => {
    execFile(
      binaryPath,
      args,
      {
        timeout: timeoutMs,
        maxBuffer: 2 * 1024 * 1024,
        env: {
          ...process.env,
          NO_COLOR: "1",
        },
      },
      (error, stdout, stderr) => {
        const execErr = error as (NodeJS.ErrnoException & { status?: number | null }) | null;
        const status =
          typeof execErr?.status === "number"
            ? execErr.status
            : typeof execErr?.code === "number"
              ? execErr.code
              : error
                ? 1
                : 0;
        resolve({
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
          code: status,
        });
      },
    );
  });
}

function ensureWecomSkill(binaryPath: string): void {
  const skillDir = wecomSkillDir();
  const skillPath = path.join(skillDir, "SKILL.md");
  const markerPath = path.join(skillDir, ".near-managed");
  const directoryExists = fs.existsSync(skillDir);
  const markerExists = fs.existsSync(markerPath);
  assertManagedSkillDirectory(directoryExists, markerExists);
  const quotedBinary = binaryPath.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const content = `---
name: wecom
description: 使用企业微信官方 CLI (wecom-cli) 操作消息、文档、智能表格、通讯录、待办、会议、日程。
---

# 企业微信

仅在用户要求操作企业微信时使用。通过 bash_exec 调用官方 CLI（本机已配置机器人凭据）：

\`\`\`bash
"${quotedBinary}" <category> --help              # 列出该品类下支持的工具
"${quotedBinary}" <category> <method> --help     # 查看某工具所需参数
"${quotedBinary}" <category> <method> '<json_args>'  # 执行调用
\`\`\`

category 取值：contact（通讯录）/ doc（文档、智能表格）/ meeting（会议）/ msg（消息）/ schedule（日程）/ todo（待办）。

读取类调用（get_*、list、query）可直接执行；写操作（发消息、创建/删除文档或记录、创建/取消会议或日程、创建/更新/删除待办）必须先向用户展示参数并确认后再执行。不得输出或读取本机凭据文件。若调用返回 error 字段，引导用户前往「设置 → 连接器 → 企业微信」重新连接。
`;
  if (!directoryExists) {
    const parentDir = path.dirname(skillDir);
    const partialDir = path.join(parentDir, `.wecom.partial-${crypto.randomUUID()}`);
    fs.mkdirSync(parentDir, { recursive: true, mode: 0o700 });
    try {
      fs.mkdirSync(partialDir, { mode: 0o700 });
      fs.writeFileSync(path.join(partialDir, "SKILL.md"), content, {
        encoding: "utf8",
        mode: 0o600,
      });
      fs.writeFileSync(path.join(partialDir, ".near-managed"), "managed by AgenticX Ontology\n", {
        encoding: "utf8",
        mode: 0o600,
      });
      fs.renameSync(partialDir, skillDir);
    } catch (error) {
      fs.rmSync(partialDir, { recursive: true, force: true });
      throw error;
    }
    return;
  }
  const tempPath = `${skillPath}.tmp`;
  fs.writeFileSync(tempPath, content, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tempPath, skillPath);
}

function removeWecomSkill(): void {
  const skillDir = wecomSkillDir();
  const markerPath = path.join(skillDir, ".near-managed");
  if (!fs.existsSync(markerPath)) return;
  fs.rmSync(skillDir, { recursive: true, force: true });
}

async function getWecomStatus(): Promise<NativeConnectorStatusResult> {
  try {
    let binaryPath = await resolveWecomCliBinaryPath();
    const managedSkillMarker = path.join(wecomSkillDir(), ".near-managed");
    if (!binaryPath && fs.existsSync(managedSkillMarker)) {
      binaryPath = await ensureWecomCliBinaryInstalled();
    }
    if (!binaryPath) {
      tryPersistWecomConnectorStatus(false);
      return { ok: true, available: true, connected: false, label: "可用" };
    }
    const configured = fs.existsSync(wecomBotEncPath());
    if (!configured) {
      removeWecomSkill();
      tryPersistWecomConnectorStatus(false);
      return { ok: true, available: true, connected: false, label: "可用" };
    }
    const probe = await runWecomCliCommand(
      ["contact", "get_userlist", "{}"],
      10000,
      binaryPath,
    );
    const connected = isWecomProbeSuccessful(probe.stdout.trim() || probe.stderr.trim());
    if (connected) {
      try {
        ensureWecomSkill(binaryPath);
      } catch (error) {
        tryPersistWecomConnectorStatus(false);
        return {
          ok: false,
          available: true,
          connected: false,
          label: "连接异常",
          error: error instanceof Error ? error.message : String(error),
        };
      }
      tryPersistWecomConnectorStatus(true);
      return { ok: true, available: true, connected: true, label: "已连接" };
    }
    removeWecomSkill();
    tryPersistWecomConnectorStatus(false);
    return {
      ok: true,
      available: true,
      connected: false,
      label: "待登录",
      error: "企业微信凭据已存在但校验未通过，请重新连接",
    };
  } catch (error) {
    tryPersistWecomConnectorStatus(false);
    return {
      ok: false,
      available: false,
      connected: false,
      label: "暂不可用",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

type WecomProgressPhase =
  | "installing"
  | "initializing"
  | "probing"
  | "success"
  | "disconnected"
  | "error";

function sendWecomProgress(phase: WecomProgressPhase): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("native-connector-wecom-progress", { phase });
}

function stripAnsiForWecom(text: string): string {
  return text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r/g, "");
}

/**
 * Drive wecom-cli init over a PTY (required — cliclack needs a TTY).
 * See FR-0 comment block above for the exact prompt sequence.
 */
function runWecomInitViaPty(
  binaryPath: string,
  botId: string,
  botSecret: string,
): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    const ptyMod = requireNodePty();
    if (!ptyMod) {
      reject(new Error("本机无法启动伪终端（node-pty），无法完成企业微信交互式初始化"));
      return;
    }
    let output = "";
    let selectedManual = false;
    let sentBotId = false;
    let sentSecret = false;
    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (wecomAuthPty === pty) wecomAuthPty = null;
      resolve({ code, output });
    };
    const pty = ptyMod.spawn(binaryPath, ["init"], {
      name: "xterm-256color",
      cols: 100,
      rows: 30,
      cwd: os.homedir(),
      env: {
        ...process.env,
        NO_COLOR: "1",
        TERM: "xterm-256color",
      } as Record<string, string>,
    });
    wecomAuthPty = pty;
    const timeout = setTimeout(() => {
      try {
        pty.kill();
      } catch {
        // ignore
      }
      if (!settled) {
        settled = true;
        wecomAuthPty = null;
        reject(new Error("企业微信初始化已超时，请重试"));
      }
    }, 5 * 60 * 1000);

    pty.onData((chunk: string) => {
      output = `${output}${chunk}`.slice(-65536);
      const plain = stripAnsiForWecom(output);
      if (!selectedManual && /请选择企微机器人接入方式/.test(plain)) {
        selectedManual = true;
        // Select second item: 手动输入 Bot ID 和 Secret
        pty.write("\x1b[B");
        setTimeout(() => {
          try {
            pty.write("\r");
          } catch {
            // ignore
          }
        }, 120);
        return;
      }
      if (
        selectedManual &&
        !sentBotId &&
        /◆\s*企业微信机器人 Bot ID/.test(plain)
      ) {
        sentBotId = true;
        setTimeout(() => {
          try {
            pty.write(`${botId}\r`);
          } catch {
            // ignore
          }
        }, 150);
        return;
      }
      if (
        sentBotId &&
        !sentSecret &&
        /◆\s*企业微信机器人 Secret/.test(plain)
      ) {
        sentSecret = true;
        setTimeout(() => {
          try {
            pty.write(`${botSecret}\r`);
          } catch {
            // ignore
          }
        }, 150);
      }
    });

    pty.onExit(({ exitCode }) => {
      finish(typeof exitCode === "number" ? exitCode : 1);
    });
  });
}

function startWecomLogin(botId: string, botSecret: string): Promise<NativeConnectorStatusResult> {
  const id = botId.trim();
  const secret = botSecret.trim();
  if (!id || !secret) {
    return Promise.resolve({
      ok: false,
      available: true,
      connected: false,
      label: "连接失败",
      error: "请填写 Bot ID 与 Secret",
    });
  }
  if (wecomAuthBusy) {
    return Promise.resolve({
      ok: false,
      available: true,
      connected: false,
      label: "连接中",
      error: "企业微信正在连接中",
    });
  }
  wecomAuthBusy = true;
  return new Promise((resolve) => {
    let settled = false;
    const finish = async (result?: NativeConnectorStatusResult, terminate = false) => {
      if (settled) return;
      settled = true;
      cancelActiveWecomLogin = null;
      const currentPty = wecomAuthPty;
      if (terminate && currentPty) {
        try {
          currentPty.kill();
        } catch {
          // ignore
        }
      }
      wecomAuthPty = null;
      wecomAuthBusy = false;
      const status = result ?? (await getWecomStatus());
      if (status.error === "已取消") {
        sendWecomProgress("disconnected");
      } else {
        sendWecomProgress(status.connected ? "success" : "error");
      }
      resolve(status);
    };

    cancelActiveWecomLogin = (reason) => {
      void finish(
        {
          ok: false,
          available: true,
          connected: false,
          label: "可用",
          error: reason || "已取消",
        },
        true,
      );
    };

    void (async () => {
      try {
        sendWecomProgress("installing");
        const binaryPath = await ensureWecomCliBinaryInstalled();
        if (settled) return;
        sendWecomProgress("initializing");
        const initResult = await runWecomInitViaPty(binaryPath, id, secret);
        if (settled) return;
        const plain = stripAnsiForWecom(initResult.output);
        if (initResult.code !== 0 || /初始化失败/.test(plain)) {
          clearWecomLocalCredentials();
          await finish({
            ok: false,
            available: true,
            connected: false,
            label: "连接失败",
            error: /初始化失败/.test(plain)
              ? "企业微信机器人凭证验证失败，请检查 Bot ID / Secret"
              : `企业微信初始化失败（退出码 ${initResult.code}）`,
          });
          return;
        }
        sendWecomProgress("probing");
        const probe = await runWecomCliCommand(
          ["contact", "get_userlist", "{}"],
          10000,
          binaryPath,
        );
        if (settled) return;
        const probeText = probe.stdout.trim() || probe.stderr.trim();
        if (!isWecomProbeSuccessful(probeText)) {
          clearWecomLocalCredentials();
          removeWecomSkill();
          tryPersistWecomConnectorStatus(false);
          await finish({
            ok: false,
            available: true,
            connected: false,
            label: "连接失败",
            error: "企业微信凭据校验未通过，请确认 Bot ID / Secret 正确",
          });
          return;
        }
        ensureWecomSkill(binaryPath);
        tryPersistWecomConnectorStatus(true);
        await finish({
          ok: true,
          available: true,
          connected: true,
          label: "已连接",
        });
      } catch (error) {
        if (settled) return;
        await finish({
          ok: false,
          available: true,
          connected: false,
          label: "连接失败",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();
  });
}

/**
 * Agent Mail connector (agently-cli / Agently Mail)
 * Product: QQ 邮箱团队为 Agent 打造的专属邮箱（与个人邮箱隔离），官网 agent.qq.com
 * S0 (2026-07-14): auth login stderr prints
 *   https://agent.qq.com/page/oauth?oauth_type=device&user_code=uc_...
 * auth status JSON: { ok, data:{ logged_in, status, ... } }; +me exit 3 when unauthorized.
 * npm binary member: package/bin/agently-cli(.exe)
 */
const AGENTLY_CLI_VERSION = "1.0.9";
const AGENTLY_CLI_ARCHIVE_MAX_BYTES = 40 * 1024 * 1024;
const AGENTLY_NPM_REGISTRY = "https://registry.npmjs.org";

function qqmailInstallDir(version = AGENTLY_CLI_VERSION): string {
  return path.join(resolveDesktopAgxHome(), "connectors", "qqmail", version);
}

function qqmailBinaryName(): string {
  return process.platform === "win32" ? "agently-cli.exe" : "agently-cli";
}

function qqmailSkillDir(): string {
  return path.join(resolveDesktopAgxHome(), "skills", "near-connectors", "qqmail");
}

function persistQqmailConnectorStatus(connected: boolean, account?: string): void {
  const parentDir = path.dirname(NATIVE_CONNECTOR_STATUS_PATH);
  fs.mkdirSync(parentDir, { recursive: true, mode: 0o700 });
  if (
    fs.existsSync(NATIVE_CONNECTOR_STATUS_PATH) &&
    fs.lstatSync(NATIVE_CONNECTOR_STATUS_PATH).isSymbolicLink()
  ) {
    throw new Error("原生连接器状态文件不能是符号链接");
  }
  let current: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(NATIVE_CONNECTOR_STATUS_PATH, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      current = parsed as Record<string, unknown>;
    }
  } catch {
    current = {};
  }
  const connectors =
    current.connectors &&
    typeof current.connectors === "object" &&
    !Array.isArray(current.connectors)
      ? (current.connectors as Record<string, unknown>)
      : {};
  const next = {
    ...current,
    version: 1,
    connectors: {
      ...connectors,
      qqmail: {
        connected,
        ...(account ? { account } : {}),
        capability: "skill",
        skill_name: "qqmail",
        updated_at: new Date().toISOString(),
      },
    },
  };
  const tempPath = `${NATIVE_CONNECTOR_STATUS_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(next, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.renameSync(tempPath, NATIVE_CONNECTOR_STATUS_PATH);
}

function tryPersistQqmailConnectorStatus(connected: boolean, account?: string): void {
  try {
    persistQqmailConnectorStatus(connected, account);
  } catch (error) {
    console.warn("[native-connectors] failed to persist QQ Mail status:", String(error));
  }
}

function resolveSystemAgentlyCliPath(): string | null {
  const candidates: string[] = [];
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || "";
    if (appData) {
      candidates.push(path.join(appData, "npm", "agently-cli.cmd"));
      candidates.push(path.join(appData, "npm", "agently-cli.exe"));
    }
  } else {
    candidates.push(
      "/opt/homebrew/bin/agently-cli",
      "/usr/local/bin/agently-cli",
      "/usr/bin/agently-cli",
      path.join(os.homedir(), ".npm-global", "bin", "agently-cli"),
    );
  }
  try {
    const whichCmd = process.platform === "win32" ? "where" : "which";
    const found = execFileSync(whichCmd, ["agently-cli"], {
      encoding: "utf8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
      env: process.env,
    })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    if (found) candidates.unshift(found);
  } catch {
    // PATH lookup is best-effort
  }
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // continue
    }
  }
  return null;
}

async function resolveInstalledAgentlyCliBinaryPath(): Promise<string | null> {
  const binaryPath = path.join(qqmailInstallDir(), "bin", qqmailBinaryName());
  try {
    if (!fs.existsSync(binaryPath)) return null;
    const stat = fs.lstatSync(binaryPath);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    if (
      qqmailBinaryValidationCache &&
      qqmailBinaryValidationCache.path === binaryPath &&
      qqmailBinaryValidationCache.size === stat.size &&
      qqmailBinaryValidationCache.mtimeMs === stat.mtimeMs
    ) {
      return qqmailBinaryValidationCache.valid ? binaryPath : null;
    }
    await new Promise<void>((resolve, reject) => {
      execFile(
        binaryPath,
        ["--help"],
        { timeout: 8000, maxBuffer: 1024 * 1024, env: { ...process.env, NO_COLOR: "1" } },
        (error) => {
          if (error) reject(error);
          else resolve();
        },
      );
    });
    qqmailBinaryValidationCache = {
      path: binaryPath,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      valid: true,
    };
    return binaryPath;
  } catch {
    qqmailBinaryValidationCache = {
      path: binaryPath,
      size: 0,
      mtimeMs: 0,
      valid: false,
    };
    return null;
  }
}

async function resolveAgentlyCliBinaryPath(): Promise<string | null> {
  return resolveSystemAgentlyCliPath() || (await resolveInstalledAgentlyCliBinaryPath());
}

async function installAgentlyCliBinary(): Promise<string> {
  const installed = await resolveInstalledAgentlyCliBinaryPath();
  if (installed) return installed;
  sendQqmailProgress("installing");
  const pkgName = qqmailNpmPlatformPackage(process.platform, process.arch);
  if (!pkgName) throw new Error("当前平台暂不支持 Agent Mail 连接器");
  const parentDir = path.dirname(qqmailInstallDir());
  fs.mkdirSync(parentDir, { recursive: true, mode: 0o700 });
  const partialDir = path.join(parentDir, `.partial-${crypto.randomUUID()}`);
  const archivePath = path.join(parentDir, `.download-${crypto.randomUUID()}.tgz`);
  try {
    const metaResponse = await proxyAwareFetch(
      `${AGENTLY_NPM_REGISTRY}/${pkgName.replace("/", "%2F")}`,
      { signal: AbortSignal.timeout(30000) },
    );
    if (!metaResponse.ok) {
      throw new Error(`读取 Agent Mail CLI 包元数据失败：HTTP ${metaResponse.status}`);
    }
    const meta = (await metaResponse.json()) as {
      "dist-tags"?: { latest?: string };
      versions?: Record<string, { dist?: { tarball?: string; integrity?: string } }>;
    };
    let version = AGENTLY_CLI_VERSION;
    let dist = meta.versions?.[version]?.dist;
    if (!dist?.tarball || !dist.integrity) {
      const latest = meta.versions?.[meta["dist-tags"]?.latest || ""]?.dist;
      const latestTag = meta["dist-tags"]?.latest;
      if (!latestTag || !latest?.tarball || !latest.integrity) {
        throw new Error("Agent Mail CLI 包元数据缺少 tarball/integrity");
      }
      version = latestTag;
      dist = latest;
      console.warn(
        `[native-connectors] agently-cli pinned ${AGENTLY_CLI_VERSION} missing; using ${version}`,
      );
    }
    const response = await proxyAwareFetch(dist.tarball!, {
      signal: AbortSignal.timeout(90000),
    });
    if (!response.ok) throw new Error(`下载 Agent Mail CLI 失败：HTTP ${response.status}`);
    const declaredSize = Number(response.headers.get("content-length") || "0");
    if (declaredSize > AGENTLY_CLI_ARCHIVE_MAX_BYTES) {
      throw new Error("Agent Mail CLI 下载包超过安全限制");
    }
    const archive = Buffer.from(
      await readBodyWithLimit(response.body, AGENTLY_CLI_ARCHIVE_MAX_BYTES),
    );
    if (archive.length === 0 || archive.length > AGENTLY_CLI_ARCHIVE_MAX_BYTES) {
      throw new Error("Agent Mail CLI 下载包大小异常");
    }
    if (!verifyNpmSriIntegrity(archive, dist.integrity!)) {
      throw new Error("Agent Mail CLI 完整性校验失败");
    }
    fs.mkdirSync(partialDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(archivePath, archive, { mode: 0o600 });
    const binaryMember = `package/bin/${qqmailBinaryName()}`;
    await extractTar({
      file: archivePath,
      cwd: partialDir,
      filter: (memberPath) =>
        memberPath === binaryMember ||
        memberPath === "package/bin/agently-cli" ||
        memberPath === "package/bin/agently-cli.exe" ||
        memberPath.endsWith("/LICENSE"),
    });
    const extractedBinary = path.join(partialDir, binaryMember);
    if (!fs.existsSync(extractedBinary)) {
      throw new Error("Agent Mail CLI 运行文件提取失败");
    }
    const stat = fs.lstatSync(extractedBinary);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Agent Mail CLI 运行文件无效");
    if (process.platform !== "win32") fs.chmodSync(extractedBinary, 0o755);
    const stagedBinDir = path.join(partialDir, "bin");
    fs.mkdirSync(stagedBinDir, { recursive: true, mode: 0o700 });
    const stagedBinary = path.join(stagedBinDir, qqmailBinaryName());
    if (path.resolve(extractedBinary) !== path.resolve(stagedBinary)) {
      fs.renameSync(extractedBinary, stagedBinary);
    }
    const finalDir = qqmailInstallDir();
    if (fs.existsSync(finalDir)) fs.rmSync(finalDir, { recursive: true, force: true });
    fs.renameSync(partialDir, finalDir);
    const result = await resolveInstalledAgentlyCliBinaryPath();
    if (!result) throw new Error("Agent Mail CLI 安装未完成");
    return result;
  } finally {
    fs.rmSync(archivePath, { force: true });
    fs.rmSync(partialDir, { recursive: true, force: true });
  }
}

async function ensureAgentlyCliBinaryInstalled(): Promise<string> {
  const existing = await resolveAgentlyCliBinaryPath();
  if (existing) return existing;
  if (qqmailInstallPromise) return await qqmailInstallPromise;
  qqmailInstallPromise = installAgentlyCliBinary().finally(() => {
    qqmailInstallPromise = null;
  });
  return await qqmailInstallPromise;
}

async function runAgentlyCliCommand(
  args: string[],
  timeoutMs = 15000,
  binaryPathOverride?: string,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const binaryPath = binaryPathOverride || (await resolveAgentlyCliBinaryPath());
  if (!binaryPath) throw new Error("Agent Mail CLI 尚未安装");
  return await new Promise((resolve) => {
    execFile(
      binaryPath,
      args,
      {
        timeout: timeoutMs,
        maxBuffer: 2 * 1024 * 1024,
        env: {
          ...process.env,
          NO_COLOR: "1",
        },
      },
      (error, stdout, stderr) => {
        const execErr = error as (NodeJS.ErrnoException & { status?: number | null }) | null;
        const status =
          typeof execErr?.status === "number"
            ? execErr.status
            : typeof execErr?.code === "number"
              ? execErr.code
              : error
                ? 1
                : 0;
        resolve({
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
          code: status,
        });
      },
    );
  });
}

function ensureQqmailSkill(binaryPath: string): void {
  const skillDir = qqmailSkillDir();
  const skillPath = path.join(skillDir, "SKILL.md");
  const markerPath = path.join(skillDir, ".near-managed");
  const directoryExists = fs.existsSync(skillDir);
  const markerExists = fs.existsSync(markerPath);
  assertManagedSkillDirectory(directoryExists, markerExists);
  const content = buildQqmailManagedSkill(binaryPath);
  if (!directoryExists) {
    const parentDir = path.dirname(skillDir);
    const partialDir = path.join(parentDir, `.qqmail.partial-${crypto.randomUUID()}`);
    fs.mkdirSync(parentDir, { recursive: true, mode: 0o700 });
    try {
      fs.mkdirSync(partialDir, { mode: 0o700 });
      fs.writeFileSync(path.join(partialDir, "SKILL.md"), content, {
        encoding: "utf8",
        mode: 0o600,
      });
      fs.writeFileSync(path.join(partialDir, ".near-managed"), "managed by AgenticX Ontology\n", {
        encoding: "utf8",
        mode: 0o600,
      });
      fs.renameSync(partialDir, skillDir);
    } catch (error) {
      fs.rmSync(partialDir, { recursive: true, force: true });
      throw error;
    }
    return;
  }
  const tempPath = `${skillPath}.tmp`;
  fs.writeFileSync(tempPath, content, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tempPath, skillPath);
}

function removeQqmailSkill(): void {
  const skillDir = qqmailSkillDir();
  const markerPath = path.join(skillDir, ".near-managed");
  if (!fs.existsSync(markerPath)) return;
  fs.rmSync(skillDir, { recursive: true, force: true });
}

async function getQqmailStatus(): Promise<NativeConnectorStatusResult> {
  try {
    let binaryPath = await resolveAgentlyCliBinaryPath();
    const managedSkillMarker = path.join(qqmailSkillDir(), ".near-managed");
    if (!binaryPath && fs.existsSync(managedSkillMarker)) {
      binaryPath = await ensureAgentlyCliBinaryInstalled();
    }
    if (!binaryPath) {
      tryPersistQqmailConnectorStatus(false);
      return { ok: true, available: true, connected: false, label: "可用" };
    }
    const statusResult = await runAgentlyCliCommand(["auth", "status"], 10000, binaryPath);
    const combined = `${statusResult.stdout}\n${statusResult.stderr}`;
    const parsed = parseQqmailAuthStatus(combined);
    if (!parsed.connected) {
      removeQqmailSkill();
      tryPersistQqmailConnectorStatus(false);
      return {
        ok: true,
        available: true,
        connected: false,
        label: parsed.label || "可用",
        error: parsed.error,
      };
    }
    const meResult = await runAgentlyCliCommand(["+me"], 10000, binaryPath);
    const account =
      parseQqmailMeAccount(`${meResult.stdout}\n${meResult.stderr}`) || undefined;
    try {
      ensureQqmailSkill(binaryPath);
    } catch (error) {
      tryPersistQqmailConnectorStatus(false);
      return {
        ok: false,
        available: true,
        connected: false,
        label: "连接异常",
        error: error instanceof Error ? error.message : String(error),
      };
    }
    tryPersistQqmailConnectorStatus(true, account);
    return {
      ok: true,
      available: true,
      connected: true,
      label: "已连接",
      account,
    };
  } catch (error) {
    tryPersistQqmailConnectorStatus(false);
    return {
      ok: false,
      available: false,
      connected: false,
      label: "暂不可用",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

type QqmailProgressPhase =
  | "installing"
  | "opening_browser"
  | "waiting"
  | "success"
  | "disconnected"
  | "error";

function sendQqmailProgress(
  phase: QqmailProgressPhase,
  extra?: { authUrl?: string },
): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("native-connector-qqmail-progress", {
    phase,
    ...(extra?.authUrl ? { authUrl: extra.authUrl } : {}),
  });
}

function startQqmailLogin(): Promise<NativeConnectorStatusResult> {
  if (qqmailAuthBusy) {
    return Promise.resolve({
      ok: false,
      available: true,
      connected: false,
      label: "连接中",
      error: "Agent Mail 正在等待浏览器授权",
    });
  }
  qqmailAuthBusy = true;
  return new Promise((resolve) => {
    let opened = false;
    let output = "";
    let settled = false;
    let proc: ChildProcess | null = null;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const finish = async (result?: NativeConnectorStatusResult, terminate = false) => {
      if (settled) return;
      settled = true;
      cancelActiveQqmailLogin = null;
      if (timeout) clearTimeout(timeout);
      const currentProc = proc;
      if (terminate && currentProc && currentProc.exitCode === null) {
        await new Promise<void>((done) => {
          const fallback = setTimeout(done, 2000);
          currentProc.once("close", () => {
            clearTimeout(fallback);
            done();
          });
          try {
            currentProc.kill("SIGTERM");
          } catch {
            done();
          }
        });
      }
      if (proc && qqmailAuthProcess === proc) qqmailAuthProcess = null;
      qqmailAuthBusy = false;
      const status = result ?? (await getQqmailStatus());
      if (status.error === "已取消") {
        sendQqmailProgress("disconnected");
      } else {
        sendQqmailProgress(status.connected ? "success" : "error");
      }
      resolve(status);
    };
    cancelActiveQqmailLogin = (reason) => {
      void finish(
        {
          ok: false,
          available: true,
          connected: false,
          label: "可用",
          error: reason || "已取消",
        },
        true,
      );
    };
    const consume = (chunk: Buffer) => {
      output = `${output}${chunk.toString("utf8")}`.slice(-32768);
      const authUrl = extractQqmailAuthUrl(output);
      if (!opened && authUrl) {
        opened = true;
        sendQqmailProgress("opening_browser", { authUrl });
        void shell
          .openExternal(authUrl)
          .then(() => sendQqmailProgress("waiting", { authUrl }))
          .catch(() =>
            finish(
              {
                ok: false,
                available: true,
                connected: false,
                label: "连接失败",
                error: "无法打开 Agent Mail 授权页面",
              },
              true,
            ),
          );
      }
    };
    void ensureAgentlyCliBinaryInstalled()
      .then((binaryPath) => {
        if (settled) return;
        proc = spawn(binaryPath, ["auth", "login"], {
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...process.env,
            NO_COLOR: "1",
            // Prefer AgenticX Ontology-controlled browser open.
            BROWSER: process.platform === "win32" ? "echo" : "/bin/true",
          },
        });
        qqmailAuthProcess = proc;
        timeout = setTimeout(() => {
          void finish(
            {
              ok: false,
              available: true,
              connected: false,
              label: "连接失败",
              error: "Agent Mail 授权已超时，请重试",
            },
            true,
          );
        }, 10 * 60 * 1000);
        proc.stdout?.on("data", consume);
        proc.stderr?.on("data", consume);
        proc.on("error", (error) => {
          void finish({
            ok: false,
            available: true,
            connected: false,
            label: "连接失败",
            error: error.message || String(error),
          });
        });
        proc.on("close", (code) => {
          if (settled) return;
          if (code === 0) {
            void getQqmailStatus().then((status) => {
              if (status.connected) {
                void finish(status);
              } else {
                void finish({
                  ok: false,
                  available: true,
                  connected: false,
                  label: "连接失败",
                  error: status.error || "授权完成但未检测到登录状态",
                });
              }
            });
            return;
          }
          // Official docs: do not retry on failure.
          void finish({
            ok: false,
            available: true,
            connected: false,
            label: "连接失败",
            error:
              code == null
                ? "Agent Mail 授权未完成"
                : `Agent Mail 授权失败（退出码 ${code}）`,
          });
        });
      })
      .catch((error) => {
        void finish({
          ok: false,
          available: true,
          connected: false,
          label: "连接失败",
          error: error instanceof Error ? error.message : String(error),
        });
      });
  });
}

async function configureTapdConnector(
  sessionId: string,
  accessToken: string,
): Promise<{ ok: boolean; error?: string }> {
  const token = accessToken.trim();
  if (!sessionId.trim()) return { ok: false, error: "请先打开一个会话" };
  if (!token || token.length > 4096) return { ok: false, error: "请填写有效的 TAPD Access Token" };
  try {
    const validationController = new AbortController();
    const validationTimeout = setTimeout(() => validationController.abort(), 15000);
    let validationResponse: Response;
    try {
      validationResponse = await proxyAwareFetch("https://api.tapd.cn/workspaces/projects", {
        headers: { Authorization: `Bearer ${token}` },
        signal: validationController.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return { ok: false, error: "TAPD Token 校验超时，请检查网络后重试" };
      }
      throw error;
    } finally {
      clearTimeout(validationTimeout);
    }
    const validationPayload = await validationResponse.json().catch(() => null);
    if (!validationResponse.ok || !isTapdValidationSuccess(validationPayload)) {
      return { ok: false, error: "TAPD Token 校验失败，请确认令牌有效且具备项目访问权限" };
    }
    const rawResponse = await fetch(`${getStudioUrl()}/api/mcp/raw`, {
      headers: { "x-agx-desktop-token": getStudioToken() },
    });
    if (!rawResponse.ok && rawResponse.status !== 404) {
      return { ok: false, error: `读取 MCP 配置失败：HTTP ${rawResponse.status}` };
    }
    const rawResult = rawResponse.ok
      ? await rawResponse.json() as { text?: string }
      : { text: "{}" };
    const document = JSON.parse(rawResult.text || "{}") as Record<string, unknown>;
    const disconnectResponse = await fetch(`${getStudioUrl()}/api/mcp/disconnect`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-agx-desktop-token": getStudioToken(),
      },
      body: JSON.stringify({ session_id: sessionId.trim(), name: "tapd" }),
    });
    if (!disconnectResponse.ok) {
      return { ok: false, error: `更新 TAPD 前断开旧连接失败：HTTP ${disconnectResponse.status}` };
    }
    const entrypoint = require.resolve("@xihe-lab/tapd-mcp-server");
    const nextDocument = mergeTapdMcpDocument(
      document,
      buildTapdMcpEntry(process.execPath, entrypoint, token),
    );
    const saveResponse = await fetch(`${getStudioUrl()}/api/mcp/raw`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "x-agx-desktop-token": getStudioToken(),
      },
      body: JSON.stringify({
        path: ENTERPRISE_MCP_JSON_PATH,
        text: `${JSON.stringify(nextDocument, null, 2)}\n`,
      }),
    });
    if (!saveResponse.ok) return { ok: false, error: `保存 MCP 配置失败：HTTP ${saveResponse.status}` };
    const connectResponse = await fetch(`${getStudioUrl()}/api/mcp/connect`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-agx-desktop-token": getStudioToken(),
      },
      body: JSON.stringify({ session_id: sessionId.trim(), name: "tapd" }),
    });
    if (!connectResponse.ok) {
      const body = await connectResponse.text().catch(() => "");
      return { ok: false, error: `TAPD MCP 连接失败：HTTP ${connectResponse.status} ${body.slice(0, 160)}` };
    }
    const result = await connectResponse.json() as { ok?: boolean; error?: string };
    return result.ok ? { ok: true } : { ok: false, error: result.error || "TAPD MCP 连接失败" };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// ── WeChat iLink Sidecar ──────────────────────────────────────────

function getWechatSidecarPath(): string {
  if (app.isPackaged) {
    // electron-builder: mac/win extraResources map bundled-backend/... -> resources/backend/
    const backendExe = path.join(process.resourcesPath, "backend", "agx-wechat-sidecar.exe");
    if (fs.existsSync(backendExe)) return backendExe;
    const backendPath = path.join(process.resourcesPath, "backend", "agx-wechat-sidecar");
    if (fs.existsSync(backendPath)) return backendPath;
    const resExe = path.join(process.resourcesPath, "agx-wechat-sidecar.exe");
    if (fs.existsSync(resExe)) return resExe;
    const resPath = path.join(process.resourcesPath, "agx-wechat-sidecar");
    if (fs.existsSync(resPath)) return resPath;
    const arch = process.arch === "x64" ? "x64" : "arm64";
    const bundledExe = path.join(process.resourcesPath, "bundled-backend", arch, "agx-wechat-sidecar.exe");
    if (fs.existsSync(bundledExe)) return bundledExe;
    const bundled = path.join(process.resourcesPath, "bundled-backend", arch, "agx-wechat-sidecar");
    if (fs.existsSync(bundled)) return bundled;
    return process.platform === "win32" ? backendExe : backendPath;
  }
  const sidecarDir = path.join(__dirname, "..", "..", "packaging", "wechat-sidecar");
  const devExe = path.join(sidecarDir, "agx-wechat-sidecar.exe");
  if (fs.existsSync(devExe)) return devExe;
  const devPath = path.join(sidecarDir, "agx-wechat-sidecar");
  if (fs.existsSync(devPath)) return devPath;
  return process.platform === "win32" ? "agx-wechat-sidecar.exe" : "agx-wechat-sidecar";
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

let wechatRestartCount = 0;
const WECHAT_MAX_RESTARTS = 3;
let wechatHealthTimer: ReturnType<typeof setInterval> | null = null;

async function startWechatSidecar(): Promise<void> {
  if (wechatSidecarProcess && !wechatSidecarProcess.killed) return;
  const binaryPath = getWechatSidecarPath();
  if (!fs.existsSync(binaryPath)) {
    console.info("[wechat-sidecar] binary not found:", binaryPath);
    return;
  }
  try {
    const port = await findFreePort();
    const dataDir = resolveDesktopAgxHome();
    const args = ["--port", String(port), "--data-dir", dataDir];
    // Minimal spawn context for diagnosing unknown runtime flags.
    console.info("[wechat-sidecar] spawn command", {
      binaryPath,
      args,
      nodeOptions: process.env.NODE_OPTIONS ?? "",
      electronRunAsNode: process.env.ELECTRON_RUN_AS_NODE ?? "",
    });
    wechatSidecarProcess = spawn(binaryPath, args, {
      cwd: os.homedir(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    wechatSidecarPort = port;
    wechatSidecarProcess.stdout?.on("data", (chunk: Buffer) => {
      const line = chunk.toString().trim();
      if (line) console.info("[wechat-sidecar]", line);
    });
    wechatSidecarProcess.stderr?.on("data", (chunk: Buffer) => {
      const line = chunk.toString().trim();
      if (line) console.warn("[wechat-sidecar:err]", line);
    });
    wechatSidecarProcess.on("exit", (code) => {
      if (!isQuitting) {
        console.info(`[wechat-sidecar] exited (code=${String(code)})`);
        if (wechatRestartCount < WECHAT_MAX_RESTARTS) {
          wechatRestartCount++;
          console.info(`[wechat-sidecar] auto-restart attempt ${wechatRestartCount}/${WECHAT_MAX_RESTARTS}`);
          setTimeout(() => void startWechatSidecar(), 2000);
        }
      }
      wechatSidecarProcess = null;
      wechatSidecarPort = 0;
    });
    wechatRestartCount = 0;
    startWechatHealthCheck();
    console.info("[wechat-sidecar] started on port", port);
  } catch (err) {
    console.error("[wechat-sidecar] start failed:", err);
  }
}

function stopWechatSidecar(): void {
  stopWechatHealthCheck();
  if (!wechatSidecarProcess) return;
  try { wechatSidecarProcess.kill("SIGTERM"); } catch { /* noop */ }
  wechatSidecarProcess = null;
  wechatSidecarPort = 0;
}

function startWechatHealthCheck(): void {
  stopWechatHealthCheck();
  wechatHealthTimer = setInterval(async () => {
    if (!wechatSidecarPort || !wechatSidecarProcess) return;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const resp = await fetch(`http://127.0.0.1:${wechatSidecarPort}/health`, { signal: controller.signal });
      clearTimeout(timeout);
      if (!resp.ok) throw new Error(`health check: ${resp.status}`);
    } catch {
      console.warn("[wechat-sidecar] health check failed");
    }
  }, 30_000);
}

function stopWechatHealthCheck(): void {
  if (wechatHealthTimer) {
    clearInterval(wechatHealthTimer);
    wechatHealthTimer = null;
  }
}

type PtyTerminalSession = {
  kind: "pty";
  pty: import("node-pty").IPty;
  wc: Electron.WebContents;
};

type BridgeTerminalSession = {
  kind: "bridge";
  wc: Electron.WebContents;
  baseUrl: string;
  token: string;
  sessionId: string;
  abort: AbortController;
};

type TerminalSession = PtyTerminalSession | BridgeTerminalSession;

const terminalSessions = new Map<string, TerminalSession>();

/**
 * node-pty's Unix spawn path execs `prebuilds/<plat>-<arch>/spawn-helper`.
 * Some npm/mirror extracts drop the execute bit (mode 644), which surfaces as
 * `Error: posix_spawnp failed` even though `/bin/zsh` itself is fine.
 */
function ensureNodePtySpawnHelperExecutable(): void {
  if (process.platform === "win32") return;
  const platArch = `${process.platform}-${process.arch}`;
  const candidates = [
    path.join(__dirname, "..", "node_modules", "node-pty", "prebuilds", platArch, "spawn-helper"),
    path.join(process.cwd(), "node_modules", "node-pty", "prebuilds", platArch, "spawn-helper"),
    path.join(__dirname, "..", "node_modules", "node-pty", "build", "Release", "spawn-helper"),
    path.join(process.cwd(), "node_modules", "node-pty", "build", "Release", "spawn-helper"),
  ];
  for (const helper of candidates) {
    try {
      if (!fs.existsSync(helper)) continue;
      const st = fs.statSync(helper);
      if ((st.mode & 0o111) !== 0) return;
      fs.chmodSync(helper, st.mode | 0o755);
      console.warn("[terminal] restored execute bit on node-pty spawn-helper:", helper);
      return;
    } catch (err) {
      console.warn("[terminal] failed to chmod node-pty spawn-helper:", helper, err);
    }
  }
}

function requireNodePty(): typeof import("node-pty") | null {
  try {
    ensureNodePtySpawnHelperExecutable();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("node-pty") as typeof import("node-pty");
  } catch (err) {
    console.error("[terminal] failed to load node-pty:", err);
    return null;
  }
}

function killTerminalSession(id: string): void {
  const sess = terminalSessions.get(id);
  if (!sess) return;
  terminalSessions.delete(id);
  if (sess.kind === "bridge") {
    try {
      sess.abort.abort();
    } catch {
      // noop
    }
    return;
  }
  try {
    sess.pty.kill();
  } catch {
    // noop
  }
}

function killAllTerminalSessions(): void {
  for (const id of [...terminalSessions.keys()]) {
    killTerminalSession(id);
  }
}

/** Escape minimal HTML for inline error pages (load failures). */
function escapeHtmlText(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function parseHttpUrl(value: string): URL | null {
  try {
    const u = new URL(value);
    if (u.protocol === "http:" || u.protocol === "https:") return u;
    return null;
  } catch {
    return null;
  }
}

function shouldOpenInExternalBrowser(targetUrl: string, appUrl: string): boolean {
  const target = parseHttpUrl(targetUrl);
  if (!target) return false;
  const appParsed = parseHttpUrl(appUrl);
  if (!appParsed) return true;
  return target.origin !== appParsed.origin;
}

/** Prefer WorkPanel in-app browser over system Chrome for http(s) navigations. */
function shouldRouteToInAppBrowser(targetUrl: string, appUrl: string): boolean {
  return shouldOpenInExternalBrowser(targetUrl, appUrl);
}

/**
 * WorkPanel remote browser uses <webview> (not iframe) so sites with
 * X-Frame-Options / CSP frame-ancestors still load. Guest window.open /
 * target=_blank stays inside the same webview instead of system Chrome.
 */
app.on("web-contents-created", (_event, contents) => {
  if (contents.getType() !== "webview") return;
  contents.setWindowOpenHandler(({ url }) => {
    if (!parseHttpUrl(url)) return { action: "deny" };
    // Single navigation path: tell renderer to update the WorkPanel tab + loadURL
    // once. Calling contents.loadURL here races redirects and floods
    // GUEST_VIEW_MANAGER_CALL / ERR_ABORTED in the console.
    const host = contents.hostWebContents;
    if (host && !host.isDestroyed()) {
      host.send("in-app-browser-open", url);
    } else if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("in-app-browser-open", url);
    }
    return { action: "deny" };
  });
});

function createWindow(): void {
  // Idempotent guard: `whenReady.then` awaits `startStudioServe()` /
  // `waitServeReady()` for ~5s on cold start. During that await the macOS
  // `activate` event can fire first (initial Dock/Finder activation) and
  // hit our `app.on("activate")` handler, which sees `mainWindow === null`
  // and calls `createWindow()` — spawning window A. When the whenReady
  // awaits later resolve, the whenReady callback calls `createWindow()`
  // again, which used to unconditionally `new BrowserWindow(...)` and
  // overwrite the `mainWindow` pointer, leaving window A orphaned but
  // still visible. That's the "two AgenticX Ontology windows on DMG launch" bug.
  // Bail out early when a live main window already exists.
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    return;
  }
  mainWindowReadyToShow = false;
  mainWindowRevealPending = false;
  const vibrancyEnabled = process.env.AGX_ENABLE_VIBRANCY === "1";
  const devPort = process.env.AGX_DEV_PORT || "5713";
  const devUrl =
    process.env.VITE_DEV_SERVER_URL ?? `http://localhost:${devPort}`;
  const appEntryUrl = app.isPackaged
    ? `file://${path.join(__dirname, "..", "dist", "index.html")}`
    : devUrl;
  const savedBounds = loadLayoutData().mainWindow ?? {};
  // Reject bounds that fell outside all displays (e.g. the external monitor
  // that held the window last time was unplugged). We can't use
  // screen.getAllDisplays() before app.whenReady on some platforms, so we
  // simply clamp obviously-bad coordinates; the OS otherwise handles clipping.
  const boundsOverride: {
    x?: number;
    y?: number;
    width: number;
    height: number;
  } = {
    width:
      typeof savedBounds.width === "number" && savedBounds.width >= 680
        ? Math.floor(savedBounds.width)
        : 900,
    height:
      typeof savedBounds.height === "number" && savedBounds.height >= 480
        ? Math.floor(savedBounds.height)
        : 700,
  };
  if (
    typeof savedBounds.x === "number" &&
    typeof savedBounds.y === "number" &&
    Number.isFinite(savedBounds.x) &&
    Number.isFinite(savedBounds.y) &&
    savedBounds.x > -20000 &&
    savedBounds.y > -20000 &&
    savedBounds.x < 20000 &&
    savedBounds.y < 20000
  ) {
    boundsOverride.x = Math.floor(savedBounds.x);
    boundsOverride.y = Math.floor(savedBounds.y);
  }
  if (typeof boundsOverride.x === "number" && typeof boundsOverride.y === "number") {
    const candidate = {
      x: boundsOverride.x,
      y: boundsOverride.y,
      width: boundsOverride.width,
      height: boundsOverride.height,
    };
    const minVisibleWidth = 120;
    const minVisibleHeight = 80;
    const hasVisibleIntersection = screen.getAllDisplays().some((display) => {
      const area = display.workArea;
      const overlapWidth = Math.max(
        0,
        Math.min(candidate.x + candidate.width, area.x + area.width) - Math.max(candidate.x, area.x),
      );
      const overlapHeight = Math.max(
        0,
        Math.min(candidate.y + candidate.height, area.y + area.height) - Math.max(candidate.y, area.y),
      );
      return overlapWidth >= minVisibleWidth && overlapHeight >= minVisibleHeight;
    });
    if (!hasVisibleIntersection) {
      const primaryArea = screen.getPrimaryDisplay().workArea;
      boundsOverride.x = Math.round(primaryArea.x + (primaryArea.width - boundsOverride.width) / 2);
      boundsOverride.y = Math.round(primaryArea.y + Math.max(20, (primaryArea.height - boundsOverride.height) / 6));
    }
  }
  const transparentMainWindow = process.platform !== "win32";
  const mainWindowBackgroundColor = transparentMainWindow ? "#00000000" : "#14141c";
  mainWindow = new BrowserWindow({
    ...boundsOverride,
    title: DESKTOP_PRODUCT_NAME,
    icon: resolveDesktopAppIconPath(),
    minWidth: 680,
    minHeight: 480,
    show: false,
    alwaysOnTop: false,
    skipTaskbar: false,
    transparent: transparentMainWindow,
    autoHideMenuBar: true,
    ...(process.platform === "darwin"
      ? {
          titleBarStyle: "hiddenInset" as const,
          trafficLightPosition: { x: 14, y: 14 },
        }
      : process.platform === "win32"
        ? {
            titleBarStyle: "hidden" as const,
            titleBarOverlay: winTitleBarOverlayForTheme("dark"),
          }
        : {}),
    ...(vibrancyEnabled ? { vibrancy: "under-window" as const, visualEffectState: "followWindow" as const } : {}),
    backgroundColor: mainWindowBackgroundColor,
    roundedCorners: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      // WorkPanel in-app browser (baidu etc. block iframes via X-Frame-Options).
      webviewTag: true,
      additionalArguments: [
        `--agx-backend-scope=${encodeURIComponent(getInjectedBackendScope())}`,
        `--agx-connection-mode=${getInjectedConnectionMode()}`,
        `--agx-desktop-version=${encodeURIComponent(app.getVersion())}`,
      ],
    }
  });
  if (savedBounds.isMaximized) {
    mainWindow.maximize();
  }

  // Debounced bounds persistence. Resize/move fire at very high frequency
  // on drag; collapsing to 400ms reduces JSON rewrites during a single drag.
  let boundsSaveTimer: NodeJS.Timeout | null = null;
  const scheduleBoundsSave = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    // Focus mode forces a tiny capsule size; never persist that to disk —
    // otherwise the next cold start would launch as a tiny 560x120 window.
    if (focusModeActive) return;
    if (boundsSaveTimer) clearTimeout(boundsSaveTimer);
    boundsSaveTimer = setTimeout(() => {
      boundsSaveTimer = null;
      if (!mainWindow || mainWindow.isDestroyed()) return;
      const isMax = mainWindow.isMaximized();
      // When maximized, getBounds() returns the maximized (screen-filling)
      // size. Use getNormalBounds() so the "restored" size survives a cycle.
      const normal = mainWindow.getNormalBounds();
      saveLayoutData({
        mainWindow: {
          x: normal.x,
          y: normal.y,
          width: normal.width,
          height: normal.height,
          isMaximized: isMax,
        },
      });
    }, 400);
  };
  mainWindow.on("move", scheduleBoundsSave);
  mainWindow.on("resize", scheduleBoundsSave);
  mainWindow.on("maximize", scheduleBoundsSave);
  mainWindow.on("unmaximize", scheduleBoundsSave);
  updateSplashStage("loading-ui");

  const tryRouteToInAppBrowser = (targetUrl: string): boolean => {
    if (!shouldRouteToInAppBrowser(targetUrl, appEntryUrl)) return false;
    // Deny popup / top-level nav and let WorkPanel navigate the current browser tab.
    // Chat/settings still open system browser via explicit `open-external` IPC.
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("in-app-browser-open", targetUrl);
    }
    return true;
  };
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (tryRouteToInAppBrowser(url)) return { action: "deny" };
    return { action: "allow" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!tryRouteToInAppBrowser(url)) return;
    event.preventDefault();
  });
  mainWindow.once("ready-to-show", () => {
    mainWindowReadyToShow = true;
    if (mainWindowRevealPending) {
      showMainWindowSafely();
    }
  });
  mainWindow.webContents.once("did-finish-load", () => {
    onMainWindowDidFinishLoad();
  });
  if (app.isPackaged) {
    const indexPath = path.join(__dirname, "..", "dist", "index.html");
    void mainWindow.loadFile(indexPath).catch((err) => {
      const detail = escapeHtmlText(String(err));
      void mainWindow
        ?.loadURL(
          `data:text/html;charset=utf-8,${encodeURIComponent(
            `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;font-family:SF Pro Text,PingFang SC,sans-serif;background:#14141c;color:rgba(255,255,255,.7);padding:1.5rem;box-sizing:border-box;-webkit-app-region:drag"><div style="text-align:center;max-width:36rem"><h3 style="margin:0">无法加载${DESKTOP_PRODUCT_NAME}界面</h3><p style="margin-top:.75rem;font-size:.85rem;opacity:.85;white-space:pre-wrap;word-break:break-all">${detail}</p><p style="margin-top:.5rem;font-size:.8rem;opacity:.6">请重新安装应用或从源码构建。</p></div></body></html>`
          )}`
        )
        .then(() => {
          void revealMainWindowAfterSplash({ fade: false });
        });
    });
  } else {
    const swallow = (_err: unknown) => {
      // Window may be destroyed mid-load when user picks "退出" from the
      // startup dialog; ignore those rejections rather than crashing.
    };
    void mainWindow.loadURL(devUrl).catch(() => {
      const distFallback = path.join(__dirname, "..", "dist", "index.html");
      if (fs.existsSync(distFallback)) {
        void mainWindow?.loadFile(distFallback).catch(() => {
          void mainWindow
            ?.loadURL(
              `data:text/html;charset=utf-8,${encodeURIComponent(
                `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;font-family:SF Pro Text,PingFang SC,sans-serif;background:#14141c;color:rgba(255,255,255,.7);-webkit-app-region:drag"><div style="text-align:center"><h3 style="margin:0">无法连接到开发服务器</h3><p style="margin-top:.5rem;font-size:.85rem;opacity:.6">请确保已运行 <code>npm run dev</code></p></div></body></html>`
              )}`
            )
            .then(() => {
              void revealMainWindowAfterSplash({ fade: false });
            })
            .catch(swallow);
        });
      } else {
        void mainWindow
          ?.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(
            `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;font-family:SF Pro Text,PingFang SC,sans-serif;background:#14141c;color:rgba(255,255,255,.7);-webkit-app-region:drag"><div style="text-align:center"><h3 style="margin:0">无法连接到开发服务器</h3><p style="margin-top:.5rem;font-size:.85rem;opacity:.6">请确保已运行 <code>npm run dev</code></p></div></body></html>`
          )}`)
          .then(() => {
            void revealMainWindowAfterSplash({ fade: false });
          })
          .catch(swallow);
      }
    });
  }
  mainWindow.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });
}

function createTray(): void {
  const isMac = process.platform === "darwin";
  const isWin = process.platform === "win32";
  const iconName = isMac ? "trayTemplate.png" : (isWin ? "icon.ico" : "icon.png");
  const iconPath =
    process.env.NODE_ENV === "development"
      ? path.resolve(process.cwd(), "assets", iconName)
      : path.join(process.resourcesPath, "assets", iconName);
  if (!fs.existsSync(iconPath)) {
    return;
  }
  const icon = nativeImage.createFromPath(iconPath);
  if (process.platform === "darwin") {
    icon.setTemplateImage(true);
  }
  tray = new Tray(icon);
  const menu = Menu.buildFromTemplate([
    {
      label: "打开/隐藏窗口",
      click: () => {
        if (!mainWindow) return;
        if (mainWindow.isVisible()) {
          mainWindow.hide();
        } else {
          mainWindow.show();
          mainWindow.focus();
        }
      }
    },
    { label: "设置", click: () => mainWindow?.webContents.send("open-settings") },
    { type: "separator" },
    { label: "退出", click: () => app.quit() }
  ]);
  tray.setContextMenu(menu);
  tray.on("click", () => {
    if (!mainWindow) return;
    if (mainWindow.isVisible()) {
      mainWindow.hide();
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
  });
  tray.setToolTip(DESKTOP_PRODUCT_NAME);
}

/**
 * Register IPC handlers that must be available before agx serve starts.
 * The renderer may invoke these immediately on load (before the backend is ready),
 * so they need to be registered as early as possible in app.whenReady().
 */
function registerEarlyIpc(): void {
  ipcMain.handle("open-external", async (_event, url: unknown) => {
    const href = String(url ?? "").trim();
    if (!/^https?:\/\//i.test(href)) {
      return { ok: false, error: "Only http(s) URLs are allowed" };
    }
    await shell.openExternal(href);
    return { ok: true };
  });

  ipcMain.handle("clipboard-write-png", async (_event, buffer: unknown) => {
    let nodeBuf: Buffer | null = null;
    if (Buffer.isBuffer(buffer)) {
      nodeBuf = buffer;
    } else if (buffer instanceof ArrayBuffer) {
      nodeBuf = Buffer.from(buffer);
    } else if (ArrayBuffer.isView(buffer)) {
      nodeBuf = Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    }
    if (!nodeBuf || nodeBuf.length === 0) {
      return { ok: false, error: "invalid buffer" };
    }
    try {
      const image = nativeImage.createFromBuffer(nodeBuf);
      if (image.isEmpty()) {
        return { ok: false, error: "empty image" };
      }
      clipboard.writeImage(image);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: String(error) };
    }
  });

  ipcMain.handle("download-png-to-downloads", async (_event, payload: unknown) => {
    const p =
      payload && typeof payload === "object"
        ? (payload as { buffer?: unknown; defaultFileName?: unknown })
        : {};
    const defaultFileName = String(p.defaultFileName ?? "widget.png").trim() || "widget.png";

    let nodeBuf: Buffer | null = null;
    const buffer = p.buffer;
    if (Buffer.isBuffer(buffer)) {
      nodeBuf = buffer;
    } else if (buffer instanceof ArrayBuffer) {
      nodeBuf = Buffer.from(buffer);
    } else if (ArrayBuffer.isView(buffer)) {
      nodeBuf = Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    }
    if (!nodeBuf || nodeBuf.length === 0) {
      return { ok: false, error: "invalid buffer" };
    }

    try {
      const downloadsDir = app.getPath("downloads");
      const parsed = path.parse(defaultFileName);
      const baseName = parsed.name || "widget";
      const ext = parsed.ext || ".png";
      let targetPath = path.join(downloadsDir, `${baseName}${ext}`);
      let suffix = 1;
      while (fs.existsSync(targetPath)) {
        targetPath = path.join(downloadsDir, `${baseName}-${suffix}${ext}`);
        suffix += 1;
      }
      fs.writeFileSync(targetPath, nodeBuf);
      return { ok: true, path: targetPath };
    } catch (error) {
      return { ok: false, error: String(error) };
    }
  });

  ipcMain.handle("get-api-base", async () => {
    if (!isRemoteMode()) {
      await waitForStudio(60_000);
    }
    return getStudioUrl();
  });
  ipcMain.handle("wait-for-studio", async (_event, timeoutMs?: number) => {
    const ms =
      typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
        ? timeoutMs
        : 60_000;
    const ok = await waitForStudio(ms);
    return { ok };
  });
  ipcMain.handle("get-api-auth-token", async () => getStudioToken());
  ipcMain.handle("get-environment-assistant-scope", async () => getEnvironmentAssistantScope());
  ipcMain.handle(
    "enterprise-assistant-preflight",
    async (event, payload: unknown) => {
      if (!mainWindow
        || event.sender !== mainWindow.webContents
        || !event.senderFrame
        || event.senderFrame !== event.sender.mainFrame) {
        return { ok: false, error: "企业助手权限核验请求来源无效" };
      }
      const row = payload && typeof payload === "object"
        ? payload as { sessionId?: unknown; permissionMode?: unknown }
        : {};
      const sessionId = String(row.sessionId ?? "").trim();
      const permissionMode = String(row.permissionMode ?? "").trim().toLowerCase();
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(sessionId)
        || !["plan", "ask", "auto"].includes(permissionMode)) {
        return { ok: false, error: "企业助手权限核验参数无效" };
      }
      const broker = enterpriseActionBroker;
      if (!broker) return { ok: false, error: "企业助手桥接尚未就绪，请稍后重试" };
      try {
        return await broker.preflightAuthorization(
          sessionId,
          permissionMode as "plan" | "ask" | "auto",
        );
      } catch (error) {
        const code = error instanceof Error
          && typeof (error as Error & { code?: unknown }).code === "string"
          ? (error as Error & { code: string }).code
          : undefined;
        return {
          ok: false,
          ...(code ? { code } : {}),
          error: String(error instanceof Error ? error.message : error),
        };
      }
    },
  );
  ipcMain.handle(
    "enterprise-assistant-confirm-operation",
    async (event, payload: unknown) => {
      if (!mainWindow
        || event.sender !== mainWindow.webContents
        || !event.senderFrame
        || event.senderFrame !== event.sender.mainFrame) {
        return { ok: false, error: "企业助手确认请求来源无效" };
      }
      const row = payload && typeof payload === "object"
        ? payload as { operationId?: unknown; sessionId?: unknown; permissionMode?: unknown; authGeneration?: unknown }
        : {};
      const operationId = String(row.operationId ?? "").trim();
      const sessionId = String(row.sessionId ?? "").trim();
      const permissionMode = String(row.permissionMode ?? "").trim().toLowerCase();
      const authGeneration = typeof row.authGeneration === "number"
        && Number.isInteger(row.authGeneration)
        ? row.authGeneration
        : Number.NaN;
      if (!operationId || !sessionId || !["plan", "ask", "auto"].includes(permissionMode) || !Number.isInteger(authGeneration)) {
        return { ok: false, error: "企业操作确认参数无效" };
      }
      if (authGeneration !== enterpriseAuthGeneration) {
        return { ok: false, error: "企业登录身份已变化，请重新发起操作", stale: true };
      }
      const broker = enterpriseActionBroker;
      if (!broker) {
        return { ok: false, error: "企业助手桥接尚未就绪，请稍后重试" };
      }
      try {
        const result = await broker.confirmOperation(operationId, {
          sessionId,
          permissionMode: permissionMode as "plan" | "ask" | "auto",
          authGeneration,
        } satisfies EnterpriseActionBinding);
        return result;
      } catch (error) {
        const code = error instanceof Error
          && typeof (error as Error & { code?: unknown }).code === "string"
          ? (error as Error & { code: string }).code
          : undefined;
        return {
          ok: false,
          ...(code ? { code } : {}),
          error: String(error instanceof Error ? error.message : error),
        };
      }
    },
  );
  ipcMain.handle(
    "enterprise-assistant-get-operation",
    async (event, payload: unknown) => {
      if (!mainWindow
        || event.sender !== mainWindow.webContents
        || !event.senderFrame
        || event.senderFrame !== event.sender.mainFrame) {
        return { ok: false, error: "企业助手状态请求来源无效" };
      }
      const row = payload && typeof payload === "object"
        ? payload as { operationId?: unknown; sessionId?: unknown; permissionMode?: unknown; authGeneration?: unknown }
        : {};
      const operationId = String(row.operationId ?? "").trim();
      const sessionId = String(row.sessionId ?? "").trim();
      const permissionMode = String(row.permissionMode ?? "").trim().toLowerCase();
      const authGeneration = typeof row.authGeneration === "number"
        && Number.isInteger(row.authGeneration)
        ? row.authGeneration
        : Number.NaN;
      if (!operationId || !sessionId || !["plan", "ask", "auto"].includes(permissionMode) || !Number.isInteger(authGeneration)) {
        return { ok: false, error: "企业操作状态参数无效" };
      }
      if (authGeneration !== enterpriseAuthGeneration) {
        return { ok: false, error: "企业登录身份已变化，请重新发起操作", stale: true };
      }
      const broker = enterpriseActionBroker;
      if (!broker) return { ok: false, error: "企业助手桥接尚未就绪，请稍后重试" };
      try {
        return await broker.getOperation(operationId, {
          sessionId,
          permissionMode: permissionMode as "plan" | "ask" | "auto",
          authGeneration,
        } satisfies EnterpriseActionBinding);
      } catch (error) {
        const code = error instanceof Error
          && typeof (error as Error & { code?: unknown }).code === "string"
          ? (error as Error & { code: string }).code
          : undefined;
        return {
          ok: false,
          ...(code ? { code } : {}),
          error: String(error instanceof Error ? error.message : error),
        };
      }
    },
  );
  ipcMain.handle("get-platform", async () => process.platform);
  ipcMain.handle("get-connection-mode", async () => getInjectedConnectionMode());
  ipcMain.handle("get-backend-scope-sync", async () => getInjectedBackendScope());
  ipcMain.handle("get-connection-mode-sync", async () => getInjectedConnectionMode());
  ipcMain.on("agx-query-backend-scope", (event) => {
    event.returnValue = getInjectedBackendScope();
  });
  ipcMain.on("agx-query-connection-mode", (event) => {
    event.returnValue = getInjectedConnectionMode();
  });
  ipcMain.handle("sync-title-bar-overlay", async (_event, theme: unknown) => {
    if (process.platform !== "win32") return { ok: true, skipped: true };
    const mode: WinTitleBarTheme =
      theme === "light" || theme === "dim" || theme === "dark" ? theme : "dark";
    applyWinTitleBarOverlay(mode);
    return { ok: true };
  });

  /**
   * 「灵巧模式」胶囊窗口：右上角圆形语音 HUD（VoiceFocus）。Enter 会快照 bounds、无边框置顶透明背景；
   * Exit 恢复最小尺寸 / 缩放 / vibrancy / 红黄绿按钮。
   */
  ipcMain.handle("focus-mode-enter", async () => {
    if (!mainWindow || mainWindow.isDestroyed()) return { ok: false };
    if (focusModeActive) return { ok: true, alreadyActive: true };
    try {
      focusModeWasMaximized = mainWindow.isMaximized();
      const baseBounds = focusModeWasMaximized
        ? mainWindow.getNormalBounds()
        : mainWindow.getBounds();
      focusModePreviousBounds = {
        x: baseBounds.x,
        y: baseBounds.y,
        width: baseBounds.width,
        height: baseBounds.height,
      };
      focusModeActive = true;
      if (focusModeWasMaximized) {
        // unmaximize() emits resize which we skip via focusModeActive guard
        mainWindow.unmaximize();
      }
      mainWindow.setResizable(true);
      mainWindow.setMinimumSize(160, 40);
      mainWindow.setMaximumSize(2000, 200);
      mainWindow.setResizable(false);
      if (process.platform === "win32") {
        try {
          mainWindow.setTitleBarOverlay({ color: "#14141c", symbolColor: "#ffffff", height: 0 });
        } catch {
          // ignore
        }
      }
      // macOS 专属：隐藏红绿黄；关闭系统阴影，让 CSS 自己绘制圆角+阴影。
      if (process.platform === "darwin") {
        try {
          mainWindow.setWindowButtonVisibility(false);
        } catch {
          // older Electron builds may not have it on non-standard titlebar
        }
        try {
          // Focus mode: DO NOT use macOS vibrancy. Any vibrancy material
          // (sidebar/under-window/hud/…) paints a translucent gray under the
          // window which makes our CSS look "wrapped in a dark frame".
          // We want the window truly transparent so our CSS frosted layer is
          // the ONLY visible shell.
          mainWindow.setVibrancy(null);
        } catch {
          // ignore
        }
      }
      try {
        mainWindow.setBackgroundColor(process.platform === "win32" ? "#14141c" : "#00000000");
      } catch {
        // ignore
      }
      mainWindow.setHasShadow(false);
      mainWindow.setMovable(true);
      mainWindow.setAlwaysOnTop(true, "floating");
      const capsuleWidth = 192;
      const capsuleHeight = 60;
      const { screen } = await import("electron");
      const display = screen.getDisplayMatching(baseBounds) ?? screen.getPrimaryDisplay();
      const area = display.workArea;
      // 锚定在屏幕右上角，右边距 / 上边距 各留 24px。
      const nextX = Math.round(area.x + area.width - capsuleWidth - 24);
      const nextY = Math.round(area.y + 24);
      mainWindow.setBounds({
        x: nextX,
        y: nextY,
        width: capsuleWidth,
        height: capsuleHeight,
      });
      // Belt + suspenders: some macOS builds clamp setBounds height to the
      // previous minimum; explicitly setSize after also seems to win.
      try {
        mainWindow.setSize(capsuleWidth, capsuleHeight, false);
      } catch {
        /* ignore */
      }
      return { ok: true };
    } catch (error) {
      // Best-effort rollback to avoid leaving focus-mode state half-applied.
      focusModeActive = false;
      try {
        mainWindow.setMinimumSize(680, 480);
        // Enter focus-mode sets setMaximumSize(2000, 200) for the capsule; must reset
        // or the main window stays vertically capped after exit / rollback.
        mainWindow.setMaximumSize(0, 0);
        mainWindow.setResizable(true);
        mainWindow.setAlwaysOnTop(false);
        mainWindow.setHasShadow(true);
        if (process.platform === "darwin") {
          try {
            mainWindow.setWindowButtonVisibility(true);
          } catch {
            // ignore
          }
          try {
            const defaultVibrancyEnabled = process.env.AGX_ENABLE_VIBRANCY === "1";
            if (defaultVibrancyEnabled) {
              mainWindow.setVibrancy("under-window");
            } else {
              mainWindow.setVibrancy(null);
            }
          } catch {
            // ignore
          }
        }
        if (focusModePreviousBounds) {
          mainWindow.setBounds(focusModePreviousBounds);
        }
        if (focusModeWasMaximized) {
          mainWindow.maximize();
        }
        if (process.platform === "win32") {
          applyWinTitleBarOverlay(winTitleBarOverlayTheme);
        }
      } catch {
        // ignore rollback failures
      }
      focusModePreviousBounds = null;
      focusModeWasMaximized = false;
      return { ok: false, error: String(error) };
    }
  });

  ipcMain.handle("focus-mode-exit", async () => {
    if (!mainWindow || mainWindow.isDestroyed()) return { ok: false };
    if (!focusModeActive) return { ok: true, alreadyInactive: true };
    try {
      mainWindow.setMinimumSize(680, 480);
      // Clears focus-mode capsule cap (setMaximumSize(2000, 200)); otherwise height stays locked ~200.
      mainWindow.setMaximumSize(0, 0);
      mainWindow.setResizable(true);
      if (process.platform === "darwin") {
        try {
          mainWindow.setWindowButtonVisibility(true);
        } catch {
          // ignore
        }
        try {
          // Restore the app-level vibrancy behavior when leaving focus mode.
          const defaultVibrancyEnabled = process.env.AGX_ENABLE_VIBRANCY === "1";
          if (defaultVibrancyEnabled) {
            mainWindow.setVibrancy("under-window");
          } else {
            mainWindow.setVibrancy(null);
          }
        } catch {
          // ignore
        }
      }
      try {
        mainWindow.setBackgroundColor(process.platform === "win32" ? "#14141c" : "#00000000");
      } catch {
        // ignore
      }
      mainWindow.setHasShadow(true);
      mainWindow.setAlwaysOnTop(false);
      if (focusModePreviousBounds) {
        mainWindow.setBounds(focusModePreviousBounds);
      }
      if (focusModeWasMaximized) {
        mainWindow.maximize();
      }
      focusModePreviousBounds = null;
      focusModeWasMaximized = false;
      // Flip the flag LAST so any resize events above are still suppressed.
      focusModeActive = false;
      if (process.platform === "win32") {
        applyWinTitleBarOverlay(winTitleBarOverlayTheme);
      }
      return { ok: true };
    } catch (error) {
      focusModeActive = false;
      return { ok: false, error: String(error) };
    }
  });

  ipcMain.handle("load-config", async () => {
    const cfg = loadAgxConfig();
    // Lite / 首次 Pro-Lite 选择已废弃：旧配置里若仍为「未完成 onboarding」，
    // 一次性写回 true，避免偶发 loadConfig 失败或竞态时反复出现欢迎页。
    if (cfg.onboarding_completed === false) {
      cfg.onboarding_completed = true;
      saveAgxConfig(cfg);
    }
    // Provider/active model fields: in remote mode, read from the connected
    // backend so the UI reflects the actually-used config (the local file is
    // not what the remote model loader sees). Other fields — onboarding,
    // userAccount — remain Desktop-local concerns.
    let defaultProvider = cfg.default_provider ?? "";
    let providers: Record<string, ProviderConfig> = cfg.providers ?? {};
    let activeProvider = cfg.active_provider ?? "";
    let activeModel = cfg.active_model ?? "";
    if (isRemoteMode()) {
      try {
        await waitForStudio();
      } catch {
        // best-effort
      }
      const r = await studioFetchJson("/api/config/providers");
      if (r.ok && r.data && r.data.ok !== false) {
        defaultProvider = String(r.data.defaultProvider ?? "");
        const p = r.data.providers;
        providers = p && typeof p === "object" ? (p as Record<string, ProviderConfig>) : {};
        activeProvider = String(r.data.activeProvider ?? "");
        activeModel = String(r.data.activeModel ?? "");
      }
    }
    const ent = cfg.enterprise;
    return {
      defaultProvider,
      providers: redactManagedProviderSecrets(providers),
      onboardingCompleted: true,
      activeProvider,
      activeModel,
      userAccount: {
        loggedIn: Boolean(ent?.enabled && ent?.token),
        email: ent?.user?.email ?? "",
        displayName: ent?.user?.display_name ?? "",
        baseUrl: ent?.base_url ?? "",
        managedPortablePackageCount: normalizedManagedPortablePackageCount(
          ent?.managed_portable_package_count,
        ),
      },
      enterprise: {
        enabled: Boolean(ent?.enabled && ent?.token),
        baseUrl: ent?.base_url ?? "",
        email: ent?.user?.email ?? "",
        displayName: ent?.user?.display_name ?? "",
        strict: ent?.policy?.strict !== false,
        models: Array.isArray(ent?.models) ? ent.models : [],
        modelCatalog: normalizeEnterpriseModelCatalog(
          Array.isArray(ent?.model_catalog) && ent.model_catalog.length > 0
            ? ent.model_catalog
            : ent?.models ?? [],
        ),
        managedPortablePackageCount: normalizedManagedPortablePackageCount(
          ent?.managed_portable_package_count,
        ),
        syncedAt: ent?.synced_at ?? "",
      },
    };
  });

  // Session list: renderer may call this as soon as the window loads; register before agx serve / registerIpc().
  // Wait for the studio backend to finish booting so the renderer doesn't get
  // a misleading empty list during the cold-start window (issue #11).
  ipcMain.handle("list-sessions", async (_event, avatarId?: string) => {
    try {
      await waitForStudio();
      const params = avatarId ? `?avatar_id=${encodeURIComponent(avatarId)}` : "";
      const resp = await fetch(`${getStudioUrl()}/api/sessions${params}`, {
        headers: { "x-agx-desktop-token": getStudioToken() },
      });
      if (!resp.ok) return { ok: false, sessions: [] };
      return await resp.json();
    } catch {
      return { ok: false, sessions: [] };
    }
  });

  ipcMain.handle("get-session-loop-review", async (_event, sessionId: string, refresh?: boolean) => {
    try {
      await waitForStudio();
      const sid = String(sessionId ?? "").trim();
      if (!sid) return { ok: false, error: "sessionId is required" };
      const q = refresh ? "?refresh=true" : "";
      const resp = await fetch(
        `${getStudioUrl()}/api/sessions/${encodeURIComponent(sid)}/loop-review${q}`,
        { headers: { "x-agx-desktop-token": getStudioToken() } },
      );
      if (!resp.ok) return { ok: false };
      return await resp.json();
    } catch {
      return { ok: false };
    }
  });

  ipcMain.handle(
    "interrupt-session",
    async (
      _event,
      payload: string | { sessionId?: unknown; purpose?: unknown; scope?: unknown },
      legacyPurpose?: string,
    ) => {
    try {
      const isObjectPayload = payload !== null && typeof payload === "object";
      const sid = String(isObjectPayload ? payload.sessionId ?? "" : payload ?? "").trim();
      if (!sid) return { ok: false, error: "sessionId is required" };
      const purposeHeader = String(
        isObjectPayload ? payload.purpose ?? "" : legacyPurpose ?? "",
      ).trim();
      const requestedScope = String(isObjectPayload ? payload.scope ?? "" : "").trim();
      const safeScope = /^[A-Za-z0-9._:-]{1,160}$/.test(requestedScope)
        ? requestedScope
        : getEnvironmentAssistantScope();
      const resp = await fetch(`${getStudioUrl()}/api/session/interrupt`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-agx-desktop-token": getStudioToken(),
          ...(purposeHeader ? { "x-agx-session-purpose": purposeHeader } : {}),
          ...(purposeHeader === "environment-assistant"
            ? { "x-agx-session-scope": safeScope }
            : {}),
        },
        body: JSON.stringify({ session_id: sid }),
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        return { ok: false, error: `HTTP ${resp.status}: ${body.slice(0, 300)}` };
      }
      return await resp.json();
    } catch (err) {
      return { ok: false, error: String(err) };
    }
    },
  );

  ipcMain.handle(
    "system-search",
    async (_event, payload: { query?: string; category?: SystemSearchCategory }) => {
      const query = String(payload?.query ?? "");
      const category = (payload?.category ?? "all") as SystemSearchCategory;
      return runSystemSearch(query, category);
    }
  );

  ipcMain.handle("system-search:preview", async (_event, filePath: unknown) => {
    return previewSystemSearchFile(String(filePath ?? ""));
  });

  ipcMain.handle("system-search:open", async (_event, filePath: unknown) => {
    return openSystemSearchPath(String(filePath ?? ""));
  });

  ipcMain.handle("system-search:reveal", async (_event, filePath: unknown) => {
    return revealSystemSearchPath(String(filePath ?? ""));
  });

  ipcMain.handle("system-search:get-info", async (_event, filePath: unknown) => {
    return getSystemSearchInfo(String(filePath ?? ""));
  });

  ipcMain.handle("system-search:open-with", async (_event, filePath: unknown) => {
    return openSystemSearchWith(String(filePath ?? ""));
  });
}

function registerIpc(): void {
  // get-api-base, get-api-auth-token, get-platform, get-connection-mode, load-config
  // are registered early in registerEarlyIpc() — skip here to avoid duplicate handler errors.

  ipcMain.handle("load-remote-server", async () => {
    const cfg = loadAgxConfig();
    const rs = cfg.remote_server;
    return {
      enabled: rs?.enabled ?? false,
      url: rs?.url ?? "",
      token: rs?.token ?? "",
    };
  });

  ipcMain.handle("save-remote-server", async (_event, payload: {
    enabled: boolean;
    url: string;
    token: string;
  }) => {
    const cfg = loadAgxConfig();
    const prev = cfg.remote_server ?? {};
    const prevEnabled = Boolean(prev.enabled);
    const prevUrl = String(prev.url ?? "").trim().replace(/\/+$/, "");
    const nextEnabled = Boolean(payload.enabled);
    const nextUrl = String(payload.url || "").trim().replace(/\/+$/, "");
    const modeChanged = prevEnabled !== nextEnabled || (nextEnabled && prevUrl !== nextUrl);
    cfg.remote_server = {
      enabled: nextEnabled,
      url: nextUrl,
      token: (payload.token || "").trim(),
    };
    saveAgxConfig(cfg);
    return { ok: true, restart_required: true, mode_changed: modeChanged };
  });

  ipcMain.handle("app-relaunch", async () => {
    app.relaunch();
    app.exit(0);
    return { ok: true };
  });

  ipcMain.handle("test-remote-server", async (_event, payload: {
    url: string;
    token: string;
  }) => {
    const url = (payload.url || "").trim().replace(/\/+$/, "");
    if (!url) return { ok: false, error: "URL is required" };
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      const resp = await fetch(`${url}/api/session`, {
        headers: { "x-agx-desktop-token": (payload.token || "").trim() },
        signal: controller.signal,
      });
      clearTimeout(timer);
      return { ok: resp.ok, status: resp.status };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle(
    "user-account-login-start",
    async (_event, payload: { baseUrl?: string }) => {
      const cfg = loadAgxConfig();
      const requested = String(payload?.baseUrl ?? "").trim();
      const resolved = requested || resolveEnterprisePortalDefault(cfg);
      const validated = validatePortalOriginForBrowserLogin(resolved);
      if (!validated.ok) {
        return {
          ok: false,
          error: requested
            ? validated.error
            : "尚未配置组织地址。请由管理员预置，或点击「更换组织地址」填写。",
        };
      }
      const baseUrl = validated.origin;
      const authGeneration = advanceEnterpriseAuthGeneration();
      if (userAccountLoginContext) {
        const prev = userAccountLoginContext;
        clearUserAccountLoginPoll();
        void proxyAwareFetch(`${prev.baseUrl}/api/desktop/auth/device/cancel`, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({
            deviceId: prev.deviceId,
            deviceSecret: prev.deviceSecret,
          }),
          signal: AbortSignal.timeout(ENTERPRISE_PORTAL_FETCH_TIMEOUT_MS),
        }).catch(() => undefined);
      }
      try {
        const initResp = await proxyAwareFetch(`${baseUrl}/api/desktop/auth/device/init`, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ deviceName: os.hostname() || DESKTOP_PRODUCT_LABEL }),
          signal: AbortSignal.timeout(ENTERPRISE_PORTAL_FETCH_TIMEOUT_MS),
        });
        const initJson = (await initResp.json().catch(() => ({}))) as {
          message?: string;
          data?: unknown;
        };
        const parsed = parseDeviceInitPayload(initJson.data);
        if (!initResp.ok || !parsed) {
          return {
            ok: false,
            error: initJson.message || `无法开始企业登录（HTTP ${initResp.status}）`,
          };
        }
        const verificationUrl = normalizeVerificationUrlForPortalOrigin(
          baseUrl,
          parsed.verificationUrl,
        );
        if (!verificationUrl || !isVerificationUrlSameOrigin(baseUrl, verificationUrl)) {
          return { ok: false, error: "组织返回的登录地址无效，请检查组织地址" };
        }
        void shell.openExternal(verificationUrl);
        const maxTicks = computePollMaxTicks(parsed.expiresIn, parsed.pollIntervalMs);
        userAccountLoginContext = {
          baseUrl,
          deviceId: parsed.deviceId,
          deviceSecret: parsed.deviceSecret,
          authGeneration,
          pollIntervalMs: parsed.pollIntervalMs,
          maxTicks,
        };
        userAccountLoginPollTicks = 0;
        userAccountLoginPollTimer = setInterval(() => {
          void (async () => {
            const ctx = userAccountLoginContext;
            if (!ctx) return;
            userAccountLoginPollTicks += 1;
            if (userAccountLoginPollTicks > ctx.maxTicks) {
              const timedOut = userAccountLoginContext;
              clearUserAccountLoginPoll();
              if (timedOut) {
                void proxyAwareFetch(`${timedOut.baseUrl}/api/desktop/auth/device/cancel`, {
                  method: "POST",
                  headers: { "content-type": "application/json", accept: "application/json" },
                  body: JSON.stringify({
                    deviceId: timedOut.deviceId,
                    deviceSecret: timedOut.deviceSecret,
                  }),
                  signal: AbortSignal.timeout(ENTERPRISE_PORTAL_FETCH_TIMEOUT_MS),
                }).catch(() => undefined);
              }
              mainWindow?.webContents.send("user-account-login-timeout", {});
              return;
            }
            try {
              const pollRes = await proxyAwareFetch(
                `${ctx.baseUrl}/api/desktop/auth/device/poll`,
                {
                  method: "POST",
                  headers: { "content-type": "application/json", accept: "application/json" },
                  body: JSON.stringify({
                    deviceId: ctx.deviceId,
                    deviceSecret: ctx.deviceSecret,
                  }),
                  signal: AbortSignal.timeout(ENTERPRISE_PORTAL_FETCH_TIMEOUT_MS),
                },
              );
              const pollJson = (await pollRes.json().catch(() => ({}))) as {
                data?: {
                  status?: string;
                  token?: string;
                  user?: EnterpriseTokenUser;
                };
              };
              const status = String(pollJson.data?.status ?? "");
              if (pollRes.status === 410 || status === "expired" || status === "cancelled" || status === "consumed") {
                clearUserAccountLoginPoll();
                mainWindow?.webContents.send("user-account-login-timeout", {});
                return;
              }
              if (!pollRes.ok || status !== "completed" || !pollJson.data?.token) return;
              const pat = String(pollJson.data.token);
              clearUserAccountLoginPoll();
              const finished = await finishEnterpriseLogin(
                ctx.baseUrl,
                pat,
                ctx.authGeneration,
                pollJson.data.user,
              );
              if (!finished.ok) {
                mainWindow?.webContents.send("user-account-login-timeout", {
                  error: finished.error,
                });
                return;
              }
              const feedbackStamp = currentEnterpriseFeedbackAccountStamp();
              mainWindow?.webContents.send("user-account-changed", {
                email: finished.user.email,
                displayName: finished.user.displayName,
                loggedIn: true,
                baseUrl: ctx.baseUrl,
                ...feedbackStamp,
              });
            } catch {
              // ignore transient network errors while polling
            }
          })();
        }, Math.max(1000, parsed.pollIntervalMs));
        return {
          ok: true,
          deviceId: parsed.deviceId,
          openUrl: verificationUrl,
        };
      } catch (err) {
        clearUserAccountLoginPoll();
        return { ok: false, error: enterpriseFetchErrorMessage(err) };
      }
    },
  );

  ipcMain.handle("user-account-login-cancel", async () => {
    advanceEnterpriseAuthGeneration();
    const ctx = userAccountLoginContext;
    clearUserAccountLoginPoll();
    if (ctx) {
      void proxyAwareFetch(`${ctx.baseUrl}/api/desktop/auth/device/cancel`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          deviceId: ctx.deviceId,
          deviceSecret: ctx.deviceSecret,
        }),
        signal: AbortSignal.timeout(ENTERPRISE_PORTAL_FETCH_TIMEOUT_MS),
      }).catch(() => undefined);
    }
    return { ok: true };
  });

  async function clearEnterpriseAccountUnlocked(
    snapshot: AgxConfig,
    reason: "user-logout" | "server-revoked",
  ): Promise<{ cleanupPending: boolean; errors: string[] }> {
    const managedMcp = [...(snapshot.enterprise?.managed_mcp_servers ?? [])];
    const managedSkills = normalizeManagedSkillLedger(snapshot.enterprise?.managed_skills);
    const managedMarketSkills = normalizeManagedMarketSkillLedger(
      snapshot.enterprise?.managed_market_skills,
    );
    let withdrawal: EnterpriseCapabilityWithdrawalResult;
    try {
      withdrawal = await withdrawEnterpriseCapabilitiesFromDisk(snapshot);
    } catch (error) {
      withdrawal = {
        remainingMcp: managedMcp,
        remainingSkills: managedSkills,
        remainingMarketSkills: Object.values(managedMarketSkills).map((entry) => entry.dirName),
        portableCleanupPending: true,
        errors: [`能力撤回失败：${String(error)}`],
      };
    }
    // Token/login is always cleared. Failed removals survive only as a
    // token-free tombstone, so startup can retry without retaining authority.
    const current = loadAgxConfig();
    clearEnterpriseFromConfig(current);
    delete current.agx_account;
    persistEnterpriseCleanupTombstone(current, withdrawal);
    saveAgxConfig(current);
    if (withdrawal.errors.length > 0) {
      const label = reason === "server-revoked" ? "企业身份失效" : "退出";
      console.warn(`[enterprise] ${label}时能力未完全撤回：${withdrawal.errors.join("；")}`);
    }
    void refreshSkillIndexAfterEnterpriseChange().catch((error) => {
      console.warn(`[enterprise] 退出时刷新 Skill 索引失败：${String(error)}`);
    });
    emitEnterpriseCapabilitiesChanged();
    const remembered = resolveEnterprisePortalDefault(current);
    const feedbackStamp = currentEnterpriseFeedbackAccountStamp(current);
    mainWindow?.webContents.send("user-account-changed", {
      email: "",
      displayName: "",
      loggedIn: false,
      baseUrl: remembered,
      ...feedbackStamp,
    });
    const cleanupPending = hasPendingEnterpriseCleanup(current);
    if (cleanupPending) schedulePendingEnterpriseCleanupRetry();
    return { cleanupPending, errors: withdrawal.errors };
  }

  async function logoutEnterpriseAccount(): Promise<{ ok: true; cleanupPending: boolean }> {
    // Invalidate device/direct login and in-flight bootstrap responses before
    // waiting for the mutation lock, so none can commit after this logout.
    advanceEnterpriseAuthGeneration();
    notifyEnterpriseAuthChanging();
    clearUserAccountLoginPoll();
    return withEnterpriseMutationLock(async () => {
      const cfg = loadAgxConfig();
      const { cleanupPending } = await clearEnterpriseAccountUnlocked(cfg, "user-logout");
      return { ok: true, cleanupPending };
    });
  }

  ipcMain.handle("user-account-logout", logoutEnterpriseAccount);

  ipcMain.handle("load-user-account", async () => {
    const cfg = loadAgxConfig();
    const ent = cfg.enterprise;
    const defaultBaseUrl = resolveEnterprisePortalDefault(cfg);
    const feedbackStamp = currentEnterpriseFeedbackAccountStamp(cfg);
    return {
      ok: true,
      loggedIn: Boolean(ent?.enabled && ent?.token),
      email: ent?.user?.email ?? "",
      displayName: ent?.user?.display_name ?? "",
      baseUrl: ent?.base_url || defaultBaseUrl,
      ...feedbackStamp,
      defaultBaseUrl,
      inferenceBaseUrl: ent?.inference_base_url ?? "",
      transport: ent?.transport ?? "",
      reauthRequiredForDirect: Boolean(ent?.reauth_required_for_direct),
      strict: ent?.policy?.strict !== false,
      // 没登录企业就不受管控：本地用户装什么是自己的事。
      capabilityPolicy: Boolean(ent?.enabled && ent?.token)
        ? normalizeEnterpriseCapabilityPolicy(
            ent?.policy?.capability_policy
              ? {
                  allowLocalSkillInstall: ent.policy.capability_policy.allow_local_skill_install,
                  allowLocalMcpInstall: ent.policy.capability_policy.allow_local_mcp_install,
                  allowMcpAutoDiscovery: ent.policy.capability_policy.allow_mcp_auto_discovery,
                }
              : undefined,
          )
        : normalizeEnterpriseCapabilityPolicy(undefined),
      // 没登录企业就没有策略。原样透传，解释交给渲染进程的
      // readAttachmentRoutingPolicy —— 规则只有后端一处出处。
      attachmentRouting: Boolean(ent?.enabled && ent?.token)
        ? (ent?.attachment_routing ?? null)
        : null,
      models: Array.isArray(ent?.models) ? ent.models : [],
      modelCatalog: normalizeEnterpriseModelCatalog(
        Array.isArray(ent?.model_catalog) && ent.model_catalog.length > 0
          ? ent.model_catalog
          : ent?.models ?? [],
      ),
      managedPortablePackageCount: normalizedManagedPortablePackageCount(
        ent?.managed_portable_package_count,
      ),
      capabilities: normalizeEnterpriseCapabilities(ent?.capabilities),
      capabilitySyncStatuses: normalizeEnterpriseCapabilitySyncStatuses(
        ent?.capability_sync_statuses,
      ),
      syncedAt: ent?.synced_at ?? "",
    };
  });

  ipcMain.handle("load-enterprise", async () => {
    const cfg = loadAgxConfig();
    const ent = cfg.enterprise;
    return {
      ok: true,
      capabilities: normalizeEnterpriseCapabilities(ent?.capabilities),
      capabilitySyncStatuses: normalizeEnterpriseCapabilitySyncStatuses(
        ent?.capability_sync_statuses,
      ),
      managedPortablePackageCount: normalizedManagedPortablePackageCount(
        ent?.managed_portable_package_count,
      ),
      unmetCapabilityDependencies: Array.isArray(ent?.unmet_capability_dependencies)
        ? ent.unmet_capability_dependencies
        : [],
      enabled: Boolean(ent?.enabled && ent?.token),
      baseUrl: ent?.base_url ?? "",
      inferenceBaseUrl: ent?.inference_base_url ?? "",
      transport: ent?.transport ?? "",
      reauthRequiredForDirect: Boolean(ent?.reauth_required_for_direct),
      email: ent?.user?.email ?? "",
      displayName: ent?.user?.display_name ?? "",
      strict: ent?.policy?.strict !== false,
      models: Array.isArray(ent?.models) ? ent.models : [],
      modelCatalog: normalizeEnterpriseModelCatalog(
        Array.isArray(ent?.model_catalog) && ent.model_catalog.length > 0
          ? ent.model_catalog
          : ent?.models ?? [],
      ),
      syncedAt: ent?.synced_at ?? "",
    };
  });

  ipcMain.handle("load-enterprise-capability-sync-statuses", async () => {
    const cfg = loadAgxConfig();
    return {
      ok: true,
      capabilitySyncStatuses: normalizeEnterpriseCapabilitySyncStatuses(
        cfg.enterprise?.capability_sync_statuses,
      ),
    };
  });

  ipcMain.handle(
    "record-attachment-routing-public-override",
    async (
      _event,
      payload: {
        sessionId?: string;
        currentModel?: string;
        privateTarget?: string;
        attachmentNames?: string[];
      },
    ): Promise<{ ok: boolean; error?: string; unauthorized?: boolean }> => {
      const cfg = loadAgxConfig();
      const ent = cfg.enterprise;
      const baseUrl = normalizePortalOrigin(ent?.base_url ?? "");
      const token = String(ent?.token ?? "").trim();
      if (!baseUrl || !token) {
        return { ok: false, error: "企业登录已失效，请重新登录", unauthorized: true };
      }
      const sessionId = String(payload?.sessionId ?? "").trim();
      const currentModel = String(payload?.currentModel ?? "").trim();
      const privateTarget = String(payload?.privateTarget ?? "").trim();
      if (!sessionId || !currentModel || !privateTarget) {
        return { ok: false, error: "缺少会话或模型信息" };
      }
      try {
        const response = await proxyAwareFetch(
          `${baseUrl}/api/desktop/attachment-routing/override`,
          {
            method: "POST",
            headers: {
              accept: "application/json",
              "content-type": "application/json",
              authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
              sessionId,
              currentModel,
              privateTarget,
              attachmentNames: Array.isArray(payload?.attachmentNames)
                ? payload.attachmentNames.map(String).slice(0, 64)
                : [],
            }),
            signal: AbortSignal.timeout(ENTERPRISE_PORTAL_FETCH_TIMEOUT_MS),
          },
        );
        const json = (await response.json().catch(() => ({}))) as {
          message?: string;
        };
        if (!response.ok) {
          return {
            ok: false,
            error: json.message || `记录公网模型例外失败（HTTP ${response.status}）`,
            unauthorized: response.status === 401,
          };
        }
        return { ok: true };
      } catch (error) {
        return { ok: false, error: enterpriseFetchErrorMessage(error) };
      }
    },
  );

  /**
   * Desktop feedback is deliberately a separate IPC/API path.  The renderer
   * supplies a local session/message key plus an opaque scope captured from
   * this host. The main process resolves the persisted assistant row, checks
   * the scope against its current authenticated account, and adds the answer
   * snapshot/trace metadata before sending the already-stored enterprise PAT
   * to the fixed Portal origin.
   */
  ipcMain.handle(
    "enterprise-feedback-scope",
    async (_event, requestInput: unknown): Promise<DesktopFeedbackIpcResult> => {
      const request = parseDesktopFeedbackScopeRequest(requestInput);
      if (!request) return { ok: false, error: "无效的反馈账号状态" };
      const auth = currentEnterprisePortalAuth();
      if (!auth.ok) return auth;
      if (!auth.scopeId) {
        return { ok: false, error: "当前企业账号缺少稳定身份，请重新登录" };
      }
      // The renderer fields are stale-request evidence only. The token and
      // scope below still come from currentEnterprisePortalAuth(), so a caller
      // cannot select or impersonate another account by supplying these values.
      if (
        !desktopFeedbackScopeHandshakeMatches(
          request.expectedScopeId,
          auth.scopeId,
          request.expectedAuthGeneration,
          enterpriseAuthGeneration,
        )
      ) {
        return { ok: false, error: "企业账号状态已变更，请刷新后重试" };
      }
      return {
        ok: true,
        scope_id: auth.scopeId,
        auth_generation: enterpriseAuthGeneration,
      };
    },
  );

  ipcMain.handle(
    "enterprise-feedback-list",
    async (_event, sessionIdInput: unknown): Promise<DesktopFeedbackIpcResult> => {
      const parsed = parseDesktopFeedbackListRequest(sessionIdInput);
      if (!parsed) return { ok: false, error: "无效的本地会话" };
      const auth = currentEnterprisePortalAuth();
      if (!auth.ok) return auth;
      if (parsed.expectedScopeId) {
        const scopeError = desktopFeedbackScopeError(auth, parsed.expectedScopeId);
        if (scopeError) return scopeError;
      }
      const result = await desktopFeedbackPortalRequest(auth, "GET", { sessionId: parsed.sessionId });
      if (!result.ok) return result;
      // The GET may have been delayed while login/account config changed. A
      // renderer account-change event is asynchronous, so re-read trusted
      // main-process identity before exposing the response to the pane.
      const currentAuth = currentEnterprisePortalAuth();
      if (!currentAuth.ok) return currentAuth;
      const scopeError = desktopFeedbackListScopeError(
        auth,
        currentAuth,
        parsed.expectedScopeId,
      );
      if (scopeError) return scopeError;
      const items = await normalizeDesktopFeedbackListResponse(parsed.sessionId, result.json);
      // Local message normalization can await disk/Studio state. Re-check at
      // the return boundary so a switch during that await cannot leak stale
      // rows either.
      const finalAuth = currentEnterprisePortalAuth();
      if (!finalAuth.ok) return finalAuth;
      const finalScopeError = desktopFeedbackListScopeError(
        auth,
        finalAuth,
        parsed.expectedScopeId,
      );
      if (finalScopeError) return finalScopeError;
      return {
        ok: true,
        ...(finalAuth.scopeId ? { scope_id: finalAuth.scopeId } : {}),
        auth_generation: enterpriseAuthGeneration,
        items,
      };
    },
  );

  ipcMain.handle(
    "enterprise-feedback-set",
    async (_event, payload: unknown): Promise<DesktopFeedbackIpcResult> => {
      const parsed = parseDesktopFeedbackWritePayload(payload);
      if (!parsed || !parsed.value) return { ok: false, error: "无效的反馈请求" };
      const auth = currentEnterprisePortalAuth();
      if (!auth.ok) return auth;
      const scopeError = desktopFeedbackScopeError(auth, parsed.expectedScopeId);
      if (scopeError) return scopeError;
      const target = await resolveDesktopFeedbackTarget(parsed.sessionId, parsed.messageId);
      if (!target) return { ok: false, error: "只能反馈已完成的助手消息" };
      // Keep the original verified auth snapshot for the Portal request.  A
      // later account switch cannot rebind this in-flight operation to B.
      const currentAuth = currentEnterprisePortalAuth();
      if (!currentAuth.ok) return currentAuth;
      const currentScopeError = desktopFeedbackScopeError(currentAuth, parsed.expectedScopeId);
      if (currentScopeError) return currentScopeError;
      const result = await desktopFeedbackPortalRequest(auth, "PUT", undefined, {
        external_session_id: target.sessionId,
        external_message_id: target.externalMessageId,
        value: parsed.value,
        ...(target.answerExcerpt ? { answer_excerpt: target.answerExcerpt } : {}),
        ...(target.provider ? { provider: target.provider } : {}),
        ...(target.model ? { model: target.model } : {}),
        ...(target.traceId ? { trace_id: target.traceId } : {}),
      });
      if (!result.ok) return result;
      return { ok: true };
    },
  );

  ipcMain.handle(
    "enterprise-feedback-clear",
    async (_event, payload: unknown): Promise<DesktopFeedbackIpcResult> => {
      const parsed = parseDesktopFeedbackWritePayload(payload);
      if (!parsed || parsed.value !== undefined) return { ok: false, error: "无效的反馈请求" };
      const auth = currentEnterprisePortalAuth();
      if (!auth.ok) return auth;
      const scopeError = desktopFeedbackScopeError(auth, parsed.expectedScopeId);
      if (scopeError) return scopeError;
      const target = await resolveDesktopFeedbackTarget(parsed.sessionId, parsed.messageId);
      if (!target) return { ok: false, error: "只能反馈已完成的助手消息" };
      const currentAuth = currentEnterprisePortalAuth();
      if (!currentAuth.ok) return currentAuth;
      const currentScopeError = desktopFeedbackScopeError(currentAuth, parsed.expectedScopeId);
      if (currentScopeError) return currentScopeError;
      const result = await desktopFeedbackPortalRequest(auth, "DELETE", undefined, {
        external_session_id: target.sessionId,
        external_message_id: target.externalMessageId,
      });
      if (!result.ok) return result;
      return { ok: true };
    },
  );

  ipcMain.handle(
    "enterprise-login",
    async (
      _event,
      payload: { baseUrl?: string; email?: string; password?: string },
    ) => {
      // Compatibility path for automation/smoke; Desktop UI uses browser device login.
      const validated = validatePortalOriginForBrowserLogin(payload?.baseUrl ?? "");
      if (!validated.ok) {
        return { ok: false, error: validated.error };
      }
      const baseUrl = validated.origin;
      const email = String(payload?.email ?? "").trim();
      const password = String(payload?.password ?? "");
      if (!email || !password) {
        return { ok: false, error: "请填写邮箱和密码" };
      }
      const authGeneration = advanceEnterpriseAuthGeneration();
      try {
        const tokenResp = await proxyAwareFetch(`${baseUrl}/api/desktop/auth/token`, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({
            email,
            password,
            deviceName: os.hostname() || DESKTOP_PRODUCT_LABEL,
          }),
          signal: AbortSignal.timeout(ENTERPRISE_PORTAL_FETCH_TIMEOUT_MS),
        });
        const tokenJson = (await tokenResp.json().catch(() => ({}))) as {
          code?: string;
          message?: string;
          data?: {
            token?: string;
            user?: EnterpriseTokenUser;
          };
        };
        if (!tokenResp.ok || !tokenJson.data?.token) {
          const msg =
            tokenResp.status === 401
              ? "邮箱或密码错误"
              : tokenJson.message || `登录失败（HTTP ${tokenResp.status}）`;
          return { ok: false, error: msg };
        }
        const finished = await finishEnterpriseLogin(
          baseUrl,
          tokenJson.data.token,
          authGeneration,
          tokenJson.data.user,
        );
        if (!finished.ok) return finished;
        const feedbackStamp = currentEnterpriseFeedbackAccountStamp();
        mainWindow?.webContents.send("user-account-changed", {
          email: finished.user.email,
          displayName: finished.user.displayName,
          loggedIn: true,
          baseUrl,
          ...feedbackStamp,
        });
        return finished;
      } catch (err) {
        return { ok: false, error: enterpriseFetchErrorMessage(err) };
      }
    },
  );

  ipcMain.handle("enterprise-logout", logoutEnterpriseAccount);

  /**
   * 从门户重新拉一次配置，并把能力落到本机磁盘。
   *
   * 手动「刷新」和后台定时都走这一个：撤销一个 Skill 之后，员工机器上那份要真的被删掉，
   * 而删除只发生在这次同步里。两条路径各写一份的话，迟早只有一条记得删。
   */
  type EnterpriseRefreshResult = {
    ok: boolean;
    error?: string;
    unauthorized?: boolean;
    models?: string[];
    transport?: string;
    reauthRequiredForDirect?: boolean;
  };

  async function refreshEnterpriseFromPortalUnlocked(): Promise<EnterpriseRefreshResult> {
    let refreshGeneration = enterpriseAuthGeneration;
    const cfg = loadAgxConfig();
    const ent = cfg.enterprise;
    const baseUrl = normalizePortalOrigin(ent?.base_url ?? "");
    const token = String(ent?.token ?? "").trim();
    if (!baseUrl || !token) {
      return { ok: false, error: "尚未登录用户账号" };
    }
    let receiptScheduledThisRefresh = false;
    try {
      const bootResp = await proxyAwareFetch(`${baseUrl}/api/desktop/bootstrap`, {
        method: "GET",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${token}`,
        },
        signal: AbortSignal.timeout(ENTERPRISE_PORTAL_FETCH_TIMEOUT_MS),
      });
      const bootJson = (await bootResp.json().catch(() => ({}))) as {
        message?: string;
        data?: {
          user?: {
            userId?: string;
            email?: string;
            displayName?: string;
            tenantId?: string;
            deptId?: string | null;
          };
          models?: unknown[];
          capabilities?: unknown[];
          managedPortablePackages?: unknown[];
          unmetCapabilityDependencies?: unknown[];
          attachmentRouting?: unknown;
          policy?: {
            strict?: boolean;
            tokenBudget?: EnterpriseTokenBudgetBootstrapPolicy;
            capabilities?: unknown;
          };
          apiBaseUrl?: string;
          inferenceApiBaseUrl?: string;
          inferenceTransport?: string;
          reauthRequiredForDirect?: boolean;
        };
      };
      const hasUsableBootstrapData = hasUsableEnterpriseBootstrapData(bootJson.data);
      if (!bootResp.ok) {
        if (bootResp.status === 401) {
          // A real 401 is authoritative revocation, not a transient desired-state
          // failure. Clear authority and withdraw managed content immediately;
          // preserving LKG here would leave revoked packages usable forever.
          advanceEnterpriseAuthGeneration();
          notifyEnterpriseAuthChanging();
          clearUserAccountLoginPoll();
          const revoked = await clearEnterpriseAccountUnlocked(cfg, "server-revoked");
          return {
            ok: false,
            error: revoked.cleanupPending
              ? "企业登录已失效；本机托管能力仍在后台清理，请重新登录后重试"
              : "企业登录已失效，请重新登录",
            unauthorized: true,
          };
        }
        // Keep the local last-known-good snapshot when an older Portal returns
        // a body-less 503.  Applying this response would otherwise clear the
        // model catalog and restore default policy values.
        if (bootResp.status === 503 && !hasUsableBootstrapData) {
          return {
            ok: false,
            error: "企业配置暂不可用（HTTP 503），已保留本机现有配置，请稍后重试",
          };
        }
        if (bootResp.status !== 503) {
          return {
            ok: false,
            error: bootJson.message || `刷新失败（HTTP ${bootResp.status}）`,
          };
        }
      }
      if (!hasUsableBootstrapData) {
        return {
          ok: false,
          error: bootJson.message || "企业配置响应无有效数据，已保留本机现有配置，请稍后重试",
        };
      }
      const inference = selectEnterpriseInferenceBase({
        apiBaseUrl: bootJson.data?.apiBaseUrl || `${baseUrl}/api/desktop/v1`,
        portalApiBaseUrl: `${baseUrl}/api/desktop/v1`,
        inferenceApiBaseUrl: bootJson.data?.inferenceApiBaseUrl,
        inferenceTransport: bootJson.data?.inferenceTransport,
        reauthRequiredForDirect: bootJson.data?.reauthRequiredForDirect,
      });
      if (!inference.ok) {
        return { ok: false, error: inference.error };
      }
      const modelCatalog = normalizeEnterpriseModelCatalog(bootJson.data?.models ?? []);
      const models = modelCatalog.map((entry) => entry.id);
      const user = bootJson.data?.user ?? ent?.user ?? {};
      const nextEnterpriseUser: NonNullable<EnterpriseConfig["user"]> = {
        user_id: (user as { userId?: string }).userId ?? ent?.user?.user_id ?? "",
        email: (user as { email?: string }).email ?? ent?.user?.email ?? "",
        display_name:
          (user as { displayName?: string }).displayName ?? ent?.user?.display_name ?? "",
        tenant_id: (user as { tenantId?: string }).tenantId ?? ent?.user?.tenant_id ?? "",
        dept_id:
          (user as { deptId?: string | null }).deptId ?? ent?.user?.dept_id ?? null,
      };
      if (refreshGeneration !== enterpriseAuthGeneration) {
        return { ok: false, error: "企业登录状态已变更，本次刷新已取消" };
      }
      // The bootstrap request can overlap a normal settings save. Apply only
      // enterprise/provider selection fields to a fresh config snapshot.
      let current = loadAgxConfig();
      const currentEnt = current.enterprise;
      if (
        refreshGeneration !== enterpriseAuthGeneration
        || String(currentEnt?.token ?? "").trim() !== token
        || normalizePortalOrigin(currentEnt?.base_url ?? "") !== baseUrl
      ) {
        return { ok: false, error: "企业登录状态已变更，本次刷新已取消" };
      }
      const identityTransition = planEnterpriseIdentityTransition(
        current.enterprise,
        baseUrl,
        nextEnterpriseUser,
      );
      if (identityTransition.cleanupRequired) {
        // Refresh can discover a server-side tenant/user reassignment while
        // the renderer still displays the previous account. Advance the same
        // trusted generation and invalidate before any cleanup/config write.
        refreshGeneration = advanceEnterpriseAuthGeneration();
        notifyEnterpriseAuthChanging();
        const prepared = await prepareEnterpriseIdentityChange(current);
        current = prepared.cfg;
        if (!prepared.ok) {
          return {
            ok: false,
            error: `刷新到新的企业身份前${prepared.error}`,
          };
        }
        if (refreshGeneration !== enterpriseAuthGeneration) {
          return { ok: false, error: "企业登录状态已变更，本次刷新已取消" };
        }
      }
      applyEnterpriseProvider(current, {
        portalOrigin: baseUrl,
        inferenceBaseUrl: inference.baseUrl,
        transport: inference.transport,
        reauthRequiredForDirect: inference.reauthRequiredForDirect,
        token,
        modelCatalog,
        capabilities: bootJson.data?.capabilities,
        managedPortablePackages: bootJson.data?.managedPortablePackages,
        capabilityPolicy: bootJson.data?.policy?.capabilities,
        attachmentRouting: bootJson.data?.attachmentRouting,
        unmetCapabilityDependencies: bootJson.data?.unmetCapabilityDependencies,
        user: nextEnterpriseUser,
        strict: bootJson.data?.policy?.strict !== false,
        tokenBudget: bootJson.data?.policy?.tokenBudget,
      });
      saveAgxConfig(current);
      // 能力列表落盘后立即通知市场；Skill 列表则必须等 Python 丢掉 20 秒缓存后再通知，
      // 否则 A→B 会在技能列表上短暂继续显示 A。
      const syncedCapabilities = normalizeEnterpriseCapabilities(current.enterprise?.capabilities);
      let sync: EnterpriseCapabilityDiskSyncResult;
      try {
        sync = await syncEnterpriseCapabilitiesToDisk(
          bootJson.data?.managedPortablePackages,
        );
      } catch (error) {
        // Keep the refresh/finalize/receipt path alive even if an unexpected
        // local I/O error escapes the per-capability guards above.
        sync = {
          ok: false,
          errors: [`企业能力落盘失败：${boundedCapabilityMessage(error)}`],
        };
      }
      const refreshed = loadAgxConfig().enterprise;
      const feedbackStamp = currentEnterpriseFeedbackAccountStamp();
      mainWindow?.webContents.send("user-account-changed", {
        email: refreshed?.user?.email ?? "",
        displayName: refreshed?.user?.display_name ?? "",
        loggedIn: Boolean(refreshed?.enabled && refreshed?.token),
        baseUrl: refreshed?.base_url ?? baseUrl,
        ...feedbackStamp,
      });
      const syncErrors = [...sync.errors];
      try {
        const loadedPaths = await refreshSkillIndexAfterEnterpriseChange();
        const loadedCapabilityIds = loadedEnterpriseSkillCapabilityIds(syncedCapabilities, loadedPaths);
        for (const id of loadedEnterpriseMarketSkillCapabilityIds(token, loadedPaths)) {
          loadedCapabilityIds.add(id);
        }
        const rolledBack = finalizeEnterpriseSkillSyncAfterIndexRefresh(
          syncedCapabilities,
          token,
          true,
          undefined,
          loadedCapabilityIds,
        );
        if (rolledBack) await refreshSkillIndexAfterEnterpriseChange();
      } catch (error) {
        finalizeEnterpriseSkillSyncAfterIndexRefresh(
          syncedCapabilities,
          token,
          false,
          `Skill 索引刷新失败：${boundedCapabilityMessage(error)}`,
        );
        syncErrors.push("Skill 索引刷新失败");
      }
      failPendingEnterpriseCapabilitySyncStatuses(syncedCapabilities, token);
      scheduleEnterpriseCapabilityReceipt(syncedCapabilities, token, baseUrl);
      receiptScheduledThisRefresh = true;
      emitEnterpriseCapabilitiesChanged();
      if (syncErrors.length > 0) {
        return {
          ok: false,
          // Detailed, stable per-item errors are already present in the local
          // sync ledger. Do not surface raw fetch/filesystem messages (which
          // may contain paths or URL query secrets) through this shared toast.
          error: "企业能力仅部分同步成功，请在 Skill 或 MCP 目录查看单项状态后重试",
        };
      }
      return {
        ok: true,
        models,
        transport: inference.transport,
        reauthRequiredForDirect: inference.reauthRequiredForDirect,
      };
    } catch (err) {
      return { ok: false, error: enterpriseFetchErrorMessage(err) };
    } finally {
      // A process can be interrupted after persisting waiting/downloading/
      // verifying. Every early bootstrap/network/inference return above must
      // close those stale rows on the next attempt; otherwise the settings UI
      // can show a spinner forever even though no sync is still running.
      const current = loadAgxConfig().enterprise;
      if (
        current?.enabled
        && String(current.token ?? "").trim() === token
      ) {
        const managed = enterpriseManagedDeliveryCapabilities(
          normalizeEnterpriseCapabilities(current.capabilities),
        );
        const convergedPendingStatuses = failPendingEnterpriseCapabilitySyncStatuses(managed, token);
        const retryFailedReceipt = shouldRetryEnterpriseCapabilityReceipt(
          current.capability_receipt_summary,
        );
        if (
          !receiptScheduledThisRefresh
          && (convergedPendingStatuses || retryFailedReceipt)
        ) {
          scheduleEnterpriseCapabilityReceipt(
            managed,
            token,
            String(current.base_url ?? baseUrl),
          );
        }
        if (convergedPendingStatuses) {
          emitEnterpriseCapabilitiesChanged();
        }
      }
    }
  }

  function refreshEnterpriseFromPortal(): Promise<EnterpriseRefreshResult> {
    return withEnterpriseMutationLock(refreshEnterpriseFromPortalUnlocked);
  }

  ipcMain.handle("enterprise-refresh", refreshEnterpriseFromPortal);

  // Reconcile once after Studio is actually ready. Persisted `applied` rows
  // are only a receipt from a previous process; the Skill directory or MCP
  // file may have been changed while Desktop was closed. The mutation lock
  // keeps this initial pass ordered with login/logout/manual refresh.
  void waitForStudio(60_000).then(async (ready) => {
    if (!ready) return;
    // The serve readiness probe and the first settings API calls are adjacent
    // during a cold start. A local socket can still be replaced/rebound in that
    // narrow window, so retry one failed background reconciliation before
    // exposing a stable failure. Manual refresh continues to run exactly once.
    const startupDelays = [0, 1_500] as const;
    for (const delayMs of startupDelays) {
      if (delayMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      }
      const ent = loadAgxConfig().enterprise;
      if (!ent?.enabled || !String(ent.token ?? "").trim()) return;
      try {
        const result = await refreshEnterpriseFromPortal();
        if (result.ok || result.unauthorized) return;
      } catch (error) {
        if (delayMs === startupDelays[startupDelays.length - 1]) {
          console.warn(`[enterprise] 启动能力复核失败：${boundedCapabilityMessage(error)}`);
        }
      }
    }
  });

  /**
   * 定时把撤销捡回来。
   *
   * MCP 每次调用都过网关，管理员一收回立刻就断了。Skill 不是——它是落到本机的一份代码，
   * 后端从下发清单里拿掉之后，员工机器上那个目录还在，照样能用；真正的删除只发生在
   * syncEnterpriseCapabilitiesToDisk 里，而它此前只在登录和「刷新」按钮上跑。
   *
   * 也就是说：不重新登录、不去设置页点一下，撤销可以一直不生效。企业管理员在后台点了
   * 「移出能力包」，看到的是已经收回了。这个定时就是把那个窗口从「无限长」压到一个周期。
   *
   * 15 分钟：这是治理动作，不是实时通道，再密只是白拉接口。失败不重试也不提示——下一轮
   * 自然会再来一次，而后台弹窗只会教会用户忽略它。
   */
  const ENTERPRISE_REVOCATION_SWEEP_MS = 15 * 60 * 1000;
  let enterpriseSweepRunning = false;
  setInterval(() => {
    void (async () => {
      // 手动刷新正在跑时跳过这一轮：两次同时写同一份 config 和同一批技能目录，
      // 账本会对不上，之后就不知道该删哪些了。
      if (enterpriseSweepRunning) return;
      const ent = loadAgxConfig().enterprise;
      if (!ent?.enabled || !String(ent.token ?? "").trim()) return;
      enterpriseSweepRunning = true;
      try {
        const result = await refreshEnterpriseFromPortal();
        // 401 说明这台机器的登录已经失效，再定时拉只会一直 401。停下来等用户重新登录，
        // 那条路径自己会同步一次。
        if (!result.ok && result.unauthorized) return;
      } catch (error) {
        console.warn(`[enterprise] 定时同步失败：${String(error)}`);
      } finally {
        enterpriseSweepRunning = false;
      }
    })();
  }, ENTERPRISE_REVOCATION_SWEEP_MS);

  ipcMain.handle("load-gateway-im", async () => {
    const cfg = loadAgxConfig();
    const gw = cfg.gateway;
    return {
      enabled: gw?.enabled ?? false,
      url: gw?.url ?? "",
      deviceId: gw?.device_id ?? "",
      token: gw?.token ?? "",
      studioBaseUrl: gw?.studio_base_url ?? "",
    };
  });

  ipcMain.handle("save-gateway-im", async (_event, payload: {
    enabled: boolean;
    url: string;
    deviceId: string;
    token: string;
    studioBaseUrl: string;
  }) => {
    const cfg = loadAgxConfig();
    cfg.gateway = {
      enabled: payload.enabled,
      url: (payload.url || "").trim().replace(/\/+$/, ""),
      device_id: (payload.deviceId || "").trim(),
      token: (payload.token || "").trim(),
      studio_base_url: (payload.studioBaseUrl || "").trim().replace(/\/+$/, ""),
    };
    saveAgxConfig(cfg);
    return { ok: true, restart_required: true };
  });

  ipcMain.handle("load-feishu-config", async () => {
    const cfg = loadAgxConfig();
    const lc = cfg.feishu_longconn;
    return {
      enabled: lc?.enabled ?? false,
      appId: lc?.app_id ?? "",
      appSecret: lc?.app_secret ?? "",
    };
  });

  ipcMain.handle("save-feishu-config", async (_event, payload: {
    enabled: boolean;
    appId: string;
    appSecret: string;
  }) => {
    const cfg = loadAgxConfig();
    cfg.feishu_longconn = {
      enabled: payload.enabled,
      app_id: (payload.appId || "").trim(),
      app_secret: (payload.appSecret || "").trim(),
    };
    saveAgxConfig(cfg);
    // Restart feishu process with new config
    stopFeishuProcess();
    if (payload.enabled) startFeishuProcess();
    return { ok: true };
  });

  ipcMain.handle("load-feishu-binding", async () => {
    try {
      const raw = fs.readFileSync(FEISHU_BINDING_PATH, "utf-8");
      const data = JSON.parse(raw) as Record<string, unknown>;
      return { ok: true, bindings: data };
    } catch {
      return { ok: true, bindings: {} as Record<string, unknown> };
    }
  });

  ipcMain.handle("save-feishu-desktop-binding", async (_event, payload: {
    sessionId: string | null;
    avatarId?: string | null;
    avatarName?: string | null;
    provider?: string | null;
    model?: string | null;
  }) => {
    let data: Record<string, unknown> = {};
    try {
      const raw = fs.readFileSync(FEISHU_BINDING_PATH, "utf-8");
      data = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      /* empty */
    }
    const sid = (payload.sessionId || "").trim();
    if (!sid) {
      delete data[FEISHU_DESKTOP_BINDING_KEY];
    } else {
      const aid = (payload.avatarId ?? "").toString().trim();
      const aname = (payload.avatarName ?? "").toString().trim();
      const provider = (payload.provider ?? "").toString().trim();
      const model = (payload.model ?? "").toString().trim();
      data[FEISHU_DESKTOP_BINDING_KEY] = {
        session_id: sid,
        avatar_id: aid || null,
        avatar_name: aname || null,
        provider: provider || null,
        model: model || null,
        bound_at: new Date().toISOString(),
      };
    }
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(FEISHU_BINDING_PATH, JSON.stringify(data, null, 2), "utf-8");
    return { ok: true };
  });

  ipcMain.handle("native-connector-status", async (_event, payload: { id?: string }) => {
    const id = String(payload?.id || "").trim();
    if (id === "tencent-meeting") return await getTmeetStatus();
    if (id === "github") return await getGithubStatus();
    if (id === "feishu") return await getFeishuStatus();
    if (id === "wecom") return await getWecomStatus();
    if (id === "qqmail") return await getQqmailStatus();
    if (id === "tapd") {
      return { ok: true, available: true, connected: false, label: "可用" };
    }
    return { ok: true, available: false, connected: false, label: "暂不可用" };
  });

  ipcMain.handle("native-connector-cached-status", async () => {
    const cached = readCachedConnectorStatuses();
    return { ok: true, connectors: cached };
  });

  ipcMain.handle("native-connector-tmeet-login", async () => {
    try {
      return await startTmeetLogin();
    } catch (error) {
      return {
        ok: false,
        available: false,
        connected: false,
        label: "连接失败",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  ipcMain.handle("native-connector-tmeet-cancel", async () => {
    if (cancelActiveTmeetLogin) {
      await cancelActiveTmeetLogin("已取消");
      return { ok: true, available: true, connected: false, label: "可用" };
    }
    if (tmeetAuthProcess && tmeetAuthProcess.exitCode === null) {
      try {
        tmeetAuthProcess.kill("SIGTERM");
      } catch {
        // ignore
      }
      tmeetAuthProcess = null;
      tmeetAuthBusy = false;
    }
    sendTmeetProgress("disconnected");
    return { ok: true, available: true, connected: false, label: "可用" };
  });

  ipcMain.handle("native-connector-tmeet-logout", async () => {
    try {
      await runTmeetCommand(["auth", "logout"]);
      const status = await getTmeetStatus();
      if (!status.ok || status.connected) {
        return {
          ...status,
          ok: false,
          error: status.error || "腾讯会议仍处于登录状态，断开未生效",
        };
      }
      removeTmeetSkill();
      sendTmeetProgress("disconnected");
      return status;
    } catch (error) {
      const status = await getTmeetStatus();
      return {
        ...status,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  ipcMain.handle("native-connector-github-login", async () => {
    try {
      return await startGithubLogin();
    } catch (error) {
      return {
        ok: false,
        available: false,
        connected: false,
        label: "连接失败",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  ipcMain.handle("native-connector-github-cancel", async () => {
    if (cancelActiveGithubLogin) {
      cancelActiveGithubLogin("已取消");
      return { ok: true, available: true, connected: false, label: "可用" };
    }
    if (githubAuthProcess && githubAuthProcess.exitCode === null) {
      try {
        githubAuthProcess.kill("SIGTERM");
      } catch {
        // ignore
      }
      githubAuthProcess = null;
      githubAuthBusy = false;
    }
    sendGithubProgress("disconnected");
    return { ok: true, available: true, connected: false, label: "可用" };
  });

  ipcMain.handle("native-connector-github-logout", async () => {
    try {
      const before = await getGithubStatus();
      const logoutArgs = ["auth", "logout", "--hostname", "github.com"];
      if (before.account) logoutArgs.push("--user", before.account);
      const binaryPath = await resolveGhBinaryPath();
      if (!binaryPath) throw new Error("GitHub CLI 尚未安装");
      await new Promise<void>((resolve, reject) => {
        const proc = spawn(binaryPath, logoutArgs, {
          stdio: ["pipe", "pipe", "pipe"],
          env: { ...process.env, NO_COLOR: "1" },
        });
        let settled = false;
        const done = (error?: Error) => {
          if (settled) return;
          settled = true;
          if (error) reject(error);
          else resolve();
        };
        // Some gh versions confirm logout interactively; send newline to accept default.
        proc.stdin?.write("y\n");
        proc.stdin?.end();
        proc.on("error", (error) => done(error));
        proc.on("exit", (code) => {
          if (code === 0) done();
          else done(new Error("GitHub CLI 登出失败"));
        });
      });
      const status = await getGithubStatus();
      if (!status.ok || status.connected) {
        return {
          ...status,
          ok: false,
          error: status.error || "GitHub 仍处于登录状态，断开未生效",
        };
      }
      removeGithubSkill();
      sendGithubProgress("disconnected");
      return status;
    } catch (error) {
      const status = await getGithubStatus();
      return {
        ...status,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  ipcMain.handle("native-connector-feishu-login", async () => {
    try {
      return await startFeishuLogin();
    } catch (error) {
      return {
        ok: false,
        available: false,
        connected: false,
        label: "连接失败",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  ipcMain.handle("native-connector-feishu-cancel", async () => {
    if (cancelActiveFeishuLogin) {
      cancelActiveFeishuLogin("已取消");
      return { ok: true, available: true, connected: false, label: "可用" };
    }
    if (feishuAuthProcess && feishuAuthProcess.exitCode === null) {
      try {
        feishuAuthProcess.kill("SIGTERM");
      } catch {
        // ignore
      }
      feishuAuthProcess = null;
      feishuAuthBusy = false;
    }
    sendFeishuProgress("disconnected");
    return { ok: true, available: true, connected: false, label: "可用" };
  });

  ipcMain.handle("native-connector-feishu-logout", async () => {
    try {
      const binaryPath = await resolveLarkCliBinaryPath();
      if (!binaryPath) throw new Error("飞书 CLI 尚未安装");
      await new Promise<void>((resolve, reject) => {
        const proc = spawn(binaryPath, ["auth", "logout"], {
          stdio: ["pipe", "pipe", "pipe"],
          env: { ...process.env, NO_COLOR: "1" },
        });
        let settled = false;
        const done = (error?: Error) => {
          if (settled) return;
          settled = true;
          if (error) reject(error);
          else resolve();
        };
        proc.stdin?.write("y\n");
        proc.stdin?.end();
        proc.on("error", (error) => done(error));
        proc.on("exit", (code) => {
          if (code === 0) done();
          else done(new Error("飞书 CLI 登出失败"));
        });
      });
      const status = await getFeishuStatus();
      if (!status.ok || status.connected) {
        return {
          ...status,
          ok: false,
          error: status.error || "飞书仍处于登录状态，断开未生效",
        };
      }
      removeFeishuSkill();
      sendFeishuProgress("disconnected");
      return status;
    } catch (error) {
      const status = await getFeishuStatus();
      return {
        ...status,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  ipcMain.handle(
    "native-connector-wecom-login",
    async (_event, payload: { botId?: string; botSecret?: string }) => {
      try {
        return await startWecomLogin(String(payload?.botId || ""), String(payload?.botSecret || ""));
      } catch (error) {
        return {
          ok: false,
          available: false,
          connected: false,
          label: "连接失败",
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  );

  ipcMain.handle("native-connector-wecom-cancel", async () => {
    if (cancelActiveWecomLogin) {
      cancelActiveWecomLogin("已取消");
      return { ok: true, available: true, connected: false, label: "可用" };
    }
    if (wecomAuthPty) {
      try {
        wecomAuthPty.kill();
      } catch {
        // ignore
      }
      wecomAuthPty = null;
      wecomAuthBusy = false;
    }
    sendWecomProgress("disconnected");
    return { ok: true, available: true, connected: false, label: "可用" };
  });

  ipcMain.handle("native-connector-wecom-logout", async () => {
    try {
      clearWecomLocalCredentials();
      removeWecomSkill();
      tryPersistWecomConnectorStatus(false);
      sendWecomProgress("disconnected");
      const status = await getWecomStatus();
      if (status.connected) {
        return {
          ...status,
          ok: false,
          error: status.error || "企业微信仍处于连接状态，断开未生效",
        };
      }
      return status;
    } catch (error) {
      const status = await getWecomStatus();
      return {
        ...status,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  ipcMain.handle("native-connector-qqmail-login", async () => {
    try {
      return await startQqmailLogin();
    } catch (error) {
      return {
        ok: false,
        available: false,
        connected: false,
        label: "连接失败",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  ipcMain.handle("native-connector-qqmail-cancel", async () => {
    if (cancelActiveQqmailLogin) {
      cancelActiveQqmailLogin("已取消");
      return { ok: true, available: true, connected: false, label: "可用" };
    }
    if (qqmailAuthProcess) {
      try {
        qqmailAuthProcess.kill("SIGTERM");
      } catch {
        // ignore
      }
      qqmailAuthProcess = null;
      qqmailAuthBusy = false;
    }
    sendQqmailProgress("disconnected");
    return { ok: true, available: true, connected: false, label: "可用" };
  });

  ipcMain.handle("native-connector-qqmail-logout", async () => {
    try {
      const binaryPath = await resolveAgentlyCliBinaryPath();
      if (binaryPath) {
        await runAgentlyCliCommand(["auth", "logout"], 15000, binaryPath);
      }
      removeQqmailSkill();
      tryPersistQqmailConnectorStatus(false);
      sendQqmailProgress("disconnected");
      const status = await getQqmailStatus();
      if (status.connected) {
        return {
          ...status,
          ok: false,
          error: status.error || "Agent Mail 仍处于连接状态，断开未生效",
        };
      }
      return status;
    } catch (error) {
      const status = await getQqmailStatus();
      return {
        ...status,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  ipcMain.handle(
    "native-connector-tapd-configure",
    async (_event, payload: { sessionId?: string; accessToken?: string }) =>
      await configureTapdConnector(
        String(payload?.sessionId || ""),
        String(payload?.accessToken || ""),
      ),
  );

  // ── WeChat iLink Sidecar IPC ──────────────────────────────────

  ipcMain.handle("wechat-sidecar-start", async () => {
    await startWechatSidecar();
    return { ok: true, port: wechatSidecarPort };
  });

  ipcMain.handle("wechat-sidecar-stop", async () => {
    stopWechatSidecar();
    return { ok: true };
  });

  ipcMain.handle("wechat-sidecar-port", async () => {
    return { port: wechatSidecarPort, running: !!wechatSidecarProcess && !wechatSidecarProcess.killed };
  });

  ipcMain.handle("wechat-clear-credentials", async () => {
    try {
      const credsPath = path.join(CONFIG_DIR, "wechat_credentials.json");
      if (fs.existsSync(credsPath)) fs.unlinkSync(credsPath);
      return { ok: true };
    } catch {
      return { ok: false };
    }
  });

  ipcMain.handle("load-wechat-binding", async () => {
    try {
      const raw = fs.readFileSync(WECHAT_BINDING_PATH, "utf-8");
      const data = JSON.parse(raw) as Record<string, unknown>;
      return { ok: true, bindings: data };
    } catch {
      return { ok: true, bindings: {} as Record<string, unknown> };
    }
  });

  ipcMain.handle("save-wechat-desktop-binding", async (_event, payload: {
    sessionId: string | null;
    avatarId?: string | null;
    avatarName?: string | null;
    provider?: string | null;
    model?: string | null;
  }) => {
    let data: Record<string, unknown> = {};
    try {
      const raw = fs.readFileSync(WECHAT_BINDING_PATH, "utf-8");
      data = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      /* empty */
    }
    const sid = (payload.sessionId || "").trim();
    if (!sid) {
      delete data[WECHAT_DESKTOP_BINDING_KEY];
    } else {
      const aid = (payload.avatarId ?? "").toString().trim();
      const aname = (payload.avatarName ?? "").toString().trim();
      const provider = (payload.provider ?? "").toString().trim();
      const model = (payload.model ?? "").toString().trim();
      data[WECHAT_DESKTOP_BINDING_KEY] = {
        session_id: sid,
        avatar_id: aid || null,
        avatar_name: aname || null,
        provider: provider || null,
        model: model || null,
        bound_at: new Date().toISOString(),
      };
    }
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(WECHAT_BINDING_PATH, JSON.stringify(data, null, 2), "utf-8");
    return { ok: true };
  });

  ipcMain.handle("list-avatars", async () => fetchListAvatarsCore());

  ipcMain.handle(
    "preload-core-data",
    async (
      _event,
      payload: { avatarId?: string; sessionId?: string }
    ): Promise<{
      ok: boolean;
      avatars: { ok: boolean; avatars: unknown[] };
      sessions: { ok: boolean; sessions: unknown[] };
      groups: { ok: boolean; groups: unknown[] };
      taskspaces: { ok: boolean; workspaces: unknown[]; error?: string };
      messages: { ok: boolean; messages: unknown[]; error?: string };
    }> => {
      const avatarId = String(payload?.avatarId ?? "").trim() || undefined;
      const sessionId = String(payload?.sessionId ?? "").trim() || undefined;

      const studioOk = await waitForStudio(PRELOAD_READY_BUDGET_MS);
      if (!studioOk) {
        return {
          ok: false,
          avatars: { ok: false, avatars: [] },
          sessions: { ok: false, sessions: [] },
          groups: { ok: false, groups: [] },
          taskspaces: { ok: false, workspaces: [], error: "studio_not_ready" },
          messages: { ok: false, messages: [], error: "studio_not_ready" },
        };
      }

      const [avatars, sessions, groups, taskspaces, messages] = await Promise.all([
        withFetchTimeout(fetchListAvatarsOnce(), { ok: false, avatars: [] }),
        withFetchTimeout(fetchListSessionsOnce(avatarId), { ok: false, sessions: [] }),
        withFetchTimeout(fetchListGroupsOnce(), { ok: false, groups: [] }),
        sessionId
          ? withFetchTimeout(fetchListTaskspacesCore(sessionId), {
              ok: false,
              workspaces: [],
              error: "timeout",
            })
          : Promise.resolve({ ok: false, workspaces: [] as unknown[], error: "skipped" }),
        sessionId
          ? withFetchTimeout(fetchSessionMessagesCore(sessionId), {
              ok: false,
              messages: [],
              error: "timeout",
            })
          : Promise.resolve({ ok: false, messages: [] as unknown[], error: "skipped" }),
      ]);

      const anyOk =
        avatars.ok || sessions.ok || groups.ok || taskspaces.ok || messages.ok;
      return { ok: anyOk, avatars, sessions, groups, taskspaces, messages };
    }
  );

  ipcMain.handle("create-avatar", async (_event, payload: {
    name: string;
    role?: string;
    avatar_url?: string;
    system_prompt?: string;
    description?: string;
    tags?: string[];
    created_by?: string;
    tools_enabled?: Record<string, boolean>;
    skills_enabled?: Record<string, boolean> | null;
    default_provider?: string;
    default_model?: string;
    default_permission_mode?: "plan" | "ask" | "auto";
    workspace_dir?: string;
  }) => {
    try {
      const resp = await fetch(`${getStudioUrl()}/api/avatars`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-agx-desktop-token": getStudioToken() },
        body: JSON.stringify(payload),
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        return { ok: false, error: `HTTP ${resp.status}: ${body.slice(0, 300)}` };
      }
      return await resp.json();
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  // ── Backend Python dependency diagnose + one-click repair ──────────
  // For end-users running AgenticX Ontology without a bundled backend: detect missing
  // desktop-runtime pieces (document readers, MCP, …) and
  // install agenticx[desktop-runtime] into $AGX_HOME/.venv on user action.
  const DESKTOP_RUNTIME_DIAGNOSE_PY = [
    "import importlib, json, os, sys",
    "missing = []",
    'for n in ("numpy",):',
    "    try:",
    "        importlib.import_module(n)",
    "    except Exception:",
    "        missing.append(n)",
    "pdf_ok = False",
    'for n in ("fitz", "pypdf"):',
    "    try:",
    "        importlib.import_module(n)",
    "        pdf_ok = True",
    "        break",
    "    except Exception:",
    "        pass",
    'if not pdf_ok:',
    '    missing.append("pdf (PyMuPDF or pypdf)")',
    "proxy_blob = ''.join(",
    '    str(os.environ.get(k, "")) for k in ("ALL_PROXY", "all_proxy", "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy")',
    ").lower()",
    "if 'socks' in proxy_blob:",
    "    try:",
    "        importlib.import_module('socksio')",
    "    except Exception:",
    '        missing.append("socksio (SOCKS 网络代理需要)")',
    'print(json.dumps({"executable": sys.executable, "missing": missing}))',
  ].join("\n");

  ipcMain.handle("diagnose-backend-deps", async () => {
    const augmentedPath = buildAugmentedPath();
    const bundled = resolveBundledBackend();
    const sourceRoot = findAgenticxSourceRoot();
    const wheelhouse = findBackendWheelhouse({
      sourceRoot,
      resourcesPath: process.resourcesPath,
    });
    if (bundled) {
      // Packaged build: deps are bundled. Report healthy unless the binary check fails.
      return new Promise((resolve) => {
        const proc = spawnBundledServer(bundled, ["--check-desktop-runtime"], {
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, PATH: augmentedPath },
        });
        let err = "";
        proc.stderr?.on("data", (c: Buffer) => { err += c.toString("utf-8"); });
        proc.on("close", (code) => {
          resolve({
            ok: true,
            usingBundled: true,
            pythonPath: bundled,
            missing: code === 0 ? [] : ["(bundled backend dependency check failed)"],
            detail: err.slice(-2000),
            offlineInstallReady: true,
            networkRequiredForRepair: false,
          });
        });
        proc.on("error", () => resolve({
          ok: true,
          usingBundled: true,
          pythonPath: bundled,
          missing: ["(could not run bundled check)"],
          offlineInstallReady: true,
          networkRequiredForRepair: false,
        }));
      });
    }
    const py = resolveBackendPython(augmentedPath);
    if (!py) {
      return {
        ok: false,
        error: "未找到可用的 Python 解释器（检测后端依赖需要）",
        missing: ["numpy", "pdf (PyMuPDF or pypdf)", "socksio (SOCKS 代理)"],
        offlineInstallReady: Boolean(wheelhouse),
        networkRequiredForRepair: !wheelhouse,
        wheelhouse: wheelhouse ?? undefined,
      };
    }
    return new Promise((resolve) => {
      const proc = spawn(py, ["-c", DESKTOP_RUNTIME_DIAGNOSE_PY], {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, PATH: augmentedPath },
        shell: false,
      });
      let out = "";
      let err = "";
      proc.stdout?.on("data", (c: Buffer) => { out += c.toString("utf-8"); });
      proc.stderr?.on("data", (c: Buffer) => { err += c.toString("utf-8"); });
      proc.on("close", () => {
        try {
          const parsed = JSON.parse(out.trim().split("\n").pop() || "{}");
          resolve({
            ok: true,
            usingBundled: false,
            pythonPath: String(parsed.executable || py),
            missing: Array.isArray(parsed.missing) ? parsed.missing : [],
            offlineInstallReady: Boolean(wheelhouse),
            networkRequiredForRepair: !wheelhouse,
            wheelhouse: wheelhouse ?? undefined,
          });
        } catch {
          resolve({
            ok: false,
            usingBundled: false,
            pythonPath: py,
            error: (err || out).slice(-2000),
            missing: ["numpy", "pdf (PyMuPDF or pypdf)", "socksio (SOCKS 代理)"],
            offlineInstallReady: Boolean(wheelhouse),
            networkRequiredForRepair: !wheelhouse,
            wheelhouse: wheelhouse ?? undefined,
          });
        }
      });
      proc.on("error", (e) =>
        resolve({
          ok: false,
          pythonPath: py,
          error: String(e),
          missing: ["numpy", "pdf (PyMuPDF or pypdf)", "socksio (SOCKS 代理)"],
          offlineInstallReady: Boolean(wheelhouse),
          networkRequiredForRepair: !wheelhouse,
          wheelhouse: wheelhouse ?? undefined,
        }),
      );
    });
  });

  ipcMain.handle("repair-backend-deps", async (event) => {
    const augmentedPath = buildAugmentedPath();
    const sourceRoot = findAgenticxSourceRoot();
    const wheelhouse = findBackendWheelhouse({
      sourceRoot,
      resourcesPath: process.resourcesPath,
    });
    const offline = isOfflineInstallRequested();
    const runtimeInstallPlan = buildDesktopRuntimeInstallPlan({
      sourceRoot,
      wheelhouse,
      offline,
    });
    const socksioInstallPlan = buildSocksioInstallPlan({ wheelhouse, offline });
    const venvDir = backendRepairVenvDir();
    const venvPy = pythonForVenvDir(venvDir);
    const venvBinDir = path.dirname(venvPy);
    const send = (phase: string, line?: string, pct?: number) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send("backend-deps-progress", { phase, line, pct });
      }
    };
    const runStep = (cmd: string, args: string[], phase: string): Promise<number> =>
      new Promise((resolve) => {
        send(phase, `$ ${path.basename(cmd)} ${args.join(" ")}`);
        const proc = spawn(cmd, args, {
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...process.env,
            PATH: augmentedPath,
            PIP_DISABLE_PIP_VERSION_CHECK: "1",
            PIP_DEFAULT_TIMEOUT: "10",
            PIP_RETRIES: "1",
            PIP_NO_INPUT: "1",
          },
          shell: false,
        });
        proc.stdout?.on("data", (c: Buffer) => { c.toString("utf-8").split("\n").forEach((l) => l.trim() && send(phase, l.trim())); });
        proc.stderr?.on("data", (c: Buffer) => { c.toString("utf-8").split("\n").forEach((l) => l.trim() && send(phase, l.trim())); });
        proc.on("close", (code) => resolve(code ?? 1));
        proc.on("error", (e) => { send(phase, String(e)); resolve(1); });
      });

    try {
      if (runtimeInstallPlan.source === "unavailable" || socksioInstallPlan.source === "unavailable") {
        send(
          "error",
          "当前处于离线模式，但没有找到可用的 wheelhouse。请把 desktop-runtime wheelhouse 放到 packaging/wheelhouse，或让 Agent 在联网时配置依赖。",
        );
        return {
          ok: false,
          error: "offline wheelhouse missing",
          offline: true,
          networkRequiredForRepair: true,
        };
      }
      if (!fs.existsSync(venvPy)) {
        const basePy = findBasePython(augmentedPath, [userManagedVenvBinDir(), venvBinDir]);
        if (!basePy) {
          send("error", "未找到 Python 3.10+，无法创建虚拟环境。请先安装 Python。");
          return { ok: false, error: "no base python found" };
        }
        send("creating-venv", `使用 ${basePy} 创建 ${venvDir}`, 5);
        const code = await runStep(basePy, ["-m", "venv", venvDir], "creating-venv");
        if (code !== 0 || !fs.existsSync(venvPy)) {
          send("error", "创建虚拟环境失败");
          return { ok: false, error: "venv creation failed" };
        }
      }
      // Never upgrade pip while using a local wheelhouse. The upgrade itself
      // is an unnecessary index request and used to make offline repair hang.
      if (runtimeInstallPlan.source === "pypi") {
        send("upgrading-pip", "升级 pip...", 20);
        await runStep(venvPy, ["-m", "pip", "install", "-q", "-U", "pip"], "upgrading-pip");
      } else {
        send("upgrading-pip", "使用随包离线依赖包，跳过 pip 联网升级。", 20);
      }
      const installLabel = runtimeInstallPlan.source === "wheelhouse"
        ? `从本地 wheelhouse 安装 agenticx[desktop-runtime]（${wheelhouse}）…`
        : sourceRoot
          ? `从本地源码安装 agenticx[desktop-runtime]（${sourceRoot}）…`
          : "从 PyPI 安装 agenticx[desktop-runtime]（文档解析、MCP 等）…";
      send("installing", installLabel, 35);
      const installCode = await runStep(venvPy, runtimeInstallPlan.args, "installing");
      if (installCode !== 0) {
        send("error", "依赖安装失败，请查看上方日志");
        return { ok: false, error: "pip install failed" };
      }
      // Older published desktop-runtime builds may not include socksio.
      send(
        "installing",
        socksioInstallPlan.source === "wheelhouse"
          ? "从本地 wheelhouse 安装 SOCKS 网络代理依赖 socksio…"
          : "安装 SOCKS 网络代理依赖 socksio…",
        72,
      );
      const socksCode = await runStep(venvPy, socksioInstallPlan.args, "installing");
      if (socksCode !== 0) {
        send("error", "socksio 安装失败");
        return { ok: false, error: "socksio install failed" };
      }
      const verifySocks = await runStep(
        venvPy,
        ["-c", "import importlib; importlib.import_module('socksio')"],
        "installing",
      );
      if (verifySocks !== 0) {
        send("error", "socksio 安装后仍无法导入，请查看上方 pip 日志");
        return { ok: false, error: "socksio verify failed" };
      }
      send("done", `后端依赖修复完成。请完全退出并重启${DESKTOP_PRODUCT_NAME}使其生效。`, 100);
      return {
        ok: true,
        venvPython: venvPy,
        offline: runtimeInstallPlan.source === "wheelhouse",
        wheelhouse: wheelhouse ?? undefined,
      };
    } catch (err) {
      send("error", String(err));
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle("update-avatar", async (_event, payload: {
    id: string;
    name?: string;
    role?: string;
    avatar_url?: string;
    pinned?: boolean;
    system_prompt?: string;
    description?: string;
    tags?: string[];
    tools_enabled?: Record<string, boolean>;
    skills_enabled?: Record<string, boolean> | null;
    default_provider?: string;
    default_model?: string;
    default_permission_mode?: "plan" | "ask" | "auto";
    workspace_dir?: string;
    color?: string;
  }) => {
    const { id, ...body } = payload;
    try {
      const resp = await fetch(`${getStudioUrl()}/api/avatars/${encodeURIComponent(id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", "x-agx-desktop-token": getStudioToken() },
        body: JSON.stringify(body),
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        return { ok: false, error: `HTTP ${resp.status}: ${text.slice(0, 300)}` };
      }
      return await resp.json();
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle("delete-avatar", async (_event, id: string) => {
    try {
      const resp = await fetch(`${getStudioUrl()}/api/avatars/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: { "x-agx-desktop-token": getStudioToken() },
      });
      if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}` };
      return await resp.json();
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle("reorder-avatars", async (_event, orders: Record<string, number>) => {
    try {
      const resp = await fetch(`${getStudioUrl()}/api/avatars/reorder`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-agx-desktop-token": getStudioToken(),
        },
        body: JSON.stringify({ orders }),
      });
      if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}` };
      return await resp.json();
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle("get-tools-status", async () => {
    try {
      const resp = await fetchStudioBackend("/api/tools/status");
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        return { ok: false, tools: [], error: `HTTP ${resp.status}: ${body.slice(0, 300)}` };
      }
      return await resp.json();
    } catch (err) {
      return { ok: false, tools: [], error: String(err) };
    }
  });

  ipcMain.handle("get-tools-registry", async () => {
    try {
      const resp = await fetchStudioBackend("/api/tools/registry");
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        return { ok: false, tools: [], error: `HTTP ${resp.status}: ${body.slice(0, 300)}` };
      }
      return await resp.json();
    } catch (err) {
      return { ok: false, tools: [], error: String(err) };
    }
  });

  ipcMain.handle("get-tools-policy", async () => {
    try {
      const resp = await fetchStudioBackend("/api/tools/policy");
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        return { ok: false, tools_enabled: {}, tools_options: {}, error: `HTTP ${resp.status}: ${body.slice(0, 300)}` };
      }
      return await resp.json();
    } catch (err) {
      return { ok: false, tools_enabled: {}, tools_options: {}, error: String(err) };
    }
  });

  ipcMain.handle(
    "save-tools-policy",
    async (
      _event,
      payload: {
        tools_enabled?: Record<string, boolean>;
        tools_options?: Record<string, unknown>;
      },
    ) => {
    try {
      const body: Record<string, unknown> = { tools_enabled: payload?.tools_enabled ?? {} };
      if (payload && "tools_options" in payload) {
        body.tools_options = payload.tools_options;
      }
      const resp = await fetch(`${getStudioUrl()}/api/tools/policy`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "x-agx-desktop-token": getStudioToken(),
        },
        body: JSON.stringify(body),
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        return { ok: false, error: `HTTP ${resp.status}: ${body.slice(0, 300)}` };
      }
      return await resp.json();
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle("install-tool", async (event, payload: { requestId: string; toolId: string }) => {
    const requestId = String(payload?.requestId || "").trim();
    const toolId = String(payload?.toolId || "").trim();
    if (!requestId) return { ok: false, error: "requestId is required" };
    if (!toolId) return { ok: false, error: "toolId is required" };
    try {
      const resp = await fetch(`${getStudioUrl()}/api/tools/install`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-agx-desktop-token": getStudioToken(),
        },
        body: JSON.stringify({ tool_id: toolId }),
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        event.sender.send("tool-install-progress", {
          requestId,
          tool_id: toolId,
          phase: "error",
          percent: 0,
          message: `HTTP ${resp.status}: ${body.slice(0, 300)}`,
        });
        return { ok: false, error: `HTTP ${resp.status}` };
      }
      if (!resp.body) {
        event.sender.send("tool-install-progress", {
          requestId,
          tool_id: toolId,
          phase: "error",
          percent: 0,
          message: "Empty stream body",
        });
        return { ok: false, error: "Empty stream body" };
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buffer = "";

      const flushChunk = (rawChunk: string) => {
        const lines = rawChunk.split("\n");
        let eventName = "message";
        const dataLines: string[] = [];
        for (const line of lines) {
          if (line.startsWith("event:")) eventName = line.slice(6).trim();
          if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
        }
        if (eventName !== "progress" || dataLines.length === 0) return;
        const jsonText = dataLines.join("\n");
        try {
          const payloadData = JSON.parse(jsonText) as Record<string, unknown>;
          event.sender.send("tool-install-progress", {
            requestId,
            ...payloadData,
          });
        } catch (err) {
          event.sender.send("tool-install-progress", {
            requestId,
            tool_id: toolId,
            phase: "error",
            percent: 0,
            message: `Failed to parse install stream: ${String(err)}`,
          });
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split("\n\n");
        buffer = chunks.pop() ?? "";
        for (const chunk of chunks) flushChunk(chunk);
      }
      const tail = buffer.trim();
      if (tail) flushChunk(tail);
      return { ok: true };
    } catch (err) {
      event.sender.send("tool-install-progress", {
        requestId,
        tool_id: toolId,
        phase: "error",
        percent: 0,
        message: String(err),
      });
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle(
    "create-session",
    async (
      _event,
      payload: {
        avatar_id?: string;
        name?: string;
        inherit_from_session_id?: string;
        session_mode?: "code_dev" | "daily_office";
        permission_mode?: "plan" | "ask" | "auto";
        provider?: string;
        model?: string;
      }
    ) => {
    try {
      const resp = await fetch(`${getStudioUrl()}/api/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-agx-desktop-token": getStudioToken() },
        body: JSON.stringify(payload),
      });
      if (!resp.ok) {
        const b = await resp.text().catch(() => "");
        return { ok: false, error: `HTTP ${resp.status}: ${b.slice(0, 300)}` };
      }
      return await resp.json();
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle("rename-session", async (_event, payload: { sessionId: string; name: string }) => {
    try {
      const resp = await fetch(`${getStudioUrl()}/api/sessions/${encodeURIComponent(payload.sessionId)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", "x-agx-desktop-token": getStudioToken() },
        body: JSON.stringify({ name: payload.name }),
      });
      if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}` };
      return await resp.json();
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle("delete-session", async (_event, sessionId: string) => {
    const sid = String(sessionId || "").trim();
    if (!sid) return { ok: false, error: "sessionId is required" };
    try {
      const resp = await fetch(
        `${getStudioUrl()}/api/session?session_id=${encodeURIComponent(sid)}`,
        {
          method: "DELETE",
          headers: { "x-agx-desktop-token": getStudioToken() },
        }
      );
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        return { ok: false, error: `HTTP ${resp.status}: ${body.slice(0, 300)}` };
      }
      const result = await resp.json();
      if (result?.ok !== false) {
        clearWechatDesktopBindingIfDeleted([sid]);
      }
      return result;
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle("delete-sessions-batch", async (_event, sessionIds: string[]) => {
    const ids = Array.isArray(sessionIds)
      ? Array.from(new Set(sessionIds.map((id) => String(id || "").trim()).filter(Boolean)))
      : [];
    if (ids.length === 0) return { ok: true, deleted: [], failed: [] };
    try {
      const resp = await fetch(`${getStudioUrl()}/api/sessions/batch-delete`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-agx-desktop-token": getStudioToken() },
        body: JSON.stringify({ session_ids: ids }),
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        return { ok: false, error: `HTTP ${resp.status}: ${body.slice(0, 300)}`, deleted: [], failed: ids };
      }
      const result = (await resp.json()) as {
        ok?: boolean;
        deleted?: string[];
        failed?: string[];
      };
      if (result?.ok !== false) {
        const deleted =
          Array.isArray(result?.deleted) && result.deleted.length > 0
            ? result.deleted
            : ids.filter((sid) => !new Set((result?.failed ?? []).map((x) => String(x || "").trim())).has(sid));
        clearWechatDesktopBindingIfDeleted(deleted);
      }
      return result;
    } catch (err) {
      return { ok: false, error: String(err), deleted: [], failed: ids };
    }
  });

  ipcMain.handle("pin-session", async (_event, payload: { sessionId: string; pinned: boolean }) => {
    const sid = String(payload?.sessionId || "").trim();
    if (!sid) return { ok: false, error: "sessionId is required" };
    try {
      const resp = await fetch(`${getStudioUrl()}/api/sessions/${encodeURIComponent(sid)}/pin`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-agx-desktop-token": getStudioToken() },
        body: JSON.stringify({ pinned: !!payload.pinned }),
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        return { ok: false, error: `HTTP ${resp.status}: ${body.slice(0, 300)}` };
      }
      return await resp.json();
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle("layout-get", async () => {
    const data = loadLayoutData();
    const theme = normalizeLayoutTheme(data.theme);
    return {
      ok: true,
      panes: Array.isArray(data.panes) ? data.panes : [],
      activePaneId: typeof data.activePaneId === "string" ? data.activePaneId : "",
      theme: theme ?? "",
    };
  });

  ipcMain.handle("ui-prefs-set", async (_event, payload: { theme?: unknown }) => {
    try {
      const theme = normalizeLayoutTheme(payload?.theme);
      if (!theme) return { ok: false, error: "invalid theme" };
      saveLayoutData({ theme });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle("layout-set", async (_event, payload: { panes?: LayoutPaneSnapshot[]; activePaneId?: string }) => {
    try {
      const panes = Array.isArray(payload?.panes)
        ? payload.panes
            .map((p) => ({
              id: String(p?.id ?? "").trim(),
              avatarId: typeof p?.avatarId === "string" ? p.avatarId : null,
              sessionId: String(p?.sessionId ?? "").trim(),
              modelProvider: String(p?.modelProvider ?? "").trim(),
              modelName: String(p?.modelName ?? "").trim(),
            }))
            .filter((p) => p.id)
        : undefined;
      const activePaneId = String(payload?.activePaneId ?? "").trim();
      const patch: Partial<LayoutFile> = {};
      if (panes !== undefined) patch.panes = panes;
      if (activePaneId) patch.activePaneId = activePaneId;
      saveLayoutData(patch);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle("set-session-model", async (_event, payload: { sessionId: string; provider: string; model: string }) => {
    const sid = String(payload?.sessionId || "").trim();
    if (!sid) return { ok: false, error: "sessionId is required" };
    try {
      const resp = await fetch(`${getStudioUrl()}/api/sessions/${encodeURIComponent(sid)}/model`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-agx-desktop-token": getStudioToken() },
        body: JSON.stringify({
          provider: String(payload?.provider || "").trim(),
          model: String(payload?.model || "").trim(),
        }),
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        return { ok: false, error: `HTTP ${resp.status}: ${body.slice(0, 300)}` };
      }
      return await resp.json();
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle("fork-session", async (_event, payload: { sessionId: string }) => {
    const sid = String(payload?.sessionId || "").trim();
    if (!sid) return { ok: false, error: "sessionId is required" };
    try {
      const resp = await fetch(`${getStudioUrl()}/api/sessions/${encodeURIComponent(sid)}/fork`, {
        method: "POST",
        headers: { "x-agx-desktop-token": getStudioToken() },
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        return { ok: false, error: `HTTP ${resp.status}: ${body.slice(0, 300)}` };
      }
      return await resp.json();
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle("archive-sessions", async (_event, payload: { sessionId: string; avatarId?: string | null }) => {
    const sid = String(payload?.sessionId || "").trim();
    const avatarId = String(payload?.avatarId || "").trim();
    if (!sid) return { ok: false, error: "sessionId is required" };
    try {
      const resp = await fetch(`${getStudioUrl()}/api/sessions/archive-before`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-agx-desktop-token": getStudioToken() },
        body: JSON.stringify({ session_id: sid, avatar_id: avatarId || undefined }),
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        return { ok: false, error: `HTTP ${resp.status}: ${body.slice(0, 300)}` };
      }
      return await resp.json();
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle("list-taskspaces", async (_event, sessionId: string) => {
    const sid = String(sessionId || "").trim();
    if (!sid) return { ok: false, workspaces: [], error: "sessionId is required" };
    try {
      const resp = await fetch(
        `${getStudioUrl()}/api/taskspace/workspaces?session_id=${encodeURIComponent(sid)}`,
        {
          headers: { "x-agx-desktop-token": getStudioToken() },
        }
      );
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        return { ok: false, workspaces: [], error: `HTTP ${resp.status}: ${body.slice(0, 300)}` };
      }
      return await resp.json();
    } catch (err) {
      return { ok: false, workspaces: [], error: String(err) };
    }
  });

  ipcMain.handle("add-taskspace", async (_event, payload: { sessionId: string; path?: string; label?: string }) => {
    const sid = String(payload?.sessionId || "").trim();
    const dirPath = String(payload?.path || "").trim();
    const label = String(payload?.label || "").trim();
    if (!sid) return { ok: false, error: "sessionId is required" };
    try {
      const resp = await fetch(`${getStudioUrl()}/api/taskspace/workspaces`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-agx-desktop-token": getStudioToken() },
        body: JSON.stringify({ session_id: sid, path: dirPath || undefined, label: label || undefined }),
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        return { ok: false, error: `HTTP ${resp.status}: ${body.slice(0, 300)}` };
      }
      return await resp.json();
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle("remove-taskspace", async (_event, payload: { sessionId: string; taskspaceId: string }) => {
    const sid = String(payload?.sessionId || "").trim();
    const taskspaceId = String(payload?.taskspaceId || "").trim();
    if (!sid || !taskspaceId) return { ok: false, error: "sessionId and taskspaceId are required" };
    try {
      const resp = await fetch(`${getStudioUrl()}/api/taskspace/workspaces`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json", "x-agx-desktop-token": getStudioToken() },
        body: JSON.stringify({ session_id: sid, taskspace_id: taskspaceId }),
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        return { ok: false, error: `HTTP ${resp.status}: ${body.slice(0, 300)}` };
      }
      return await resp.json();
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle("choose-directory", async () => {
    if (remoteConfig) {
      return { ok: false, error: "远程模式不支持本地目录选择" };
    }
    const focused = BrowserWindow.getFocusedWindow() ?? mainWindow ?? null;
    try {
      const result = focused
        ? await dialog.showOpenDialog(focused, { properties: ["openDirectory"] })
        : await dialog.showOpenDialog({ properties: ["openDirectory"] });
      if (result.canceled || result.filePaths.length === 0) {
        return { ok: false, canceled: true };
      }
      return { ok: true, path: result.filePaths[0] };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle("choose-files", async () => {
    if (remoteConfig) {
      return { ok: false, error: "远程模式不支持本地文件选择" };
    }
    const focused = BrowserWindow.getFocusedWindow() ?? mainWindow ?? null;
    try {
      const result = focused
        ? await dialog.showOpenDialog(focused, { properties: ["openFile", "multiSelections"] })
        : await dialog.showOpenDialog({ properties: ["openFile", "multiSelections"] });
      if (result.canceled || result.filePaths.length === 0) {
        return { ok: false, canceled: true, paths: [] as string[] };
      }
      return { ok: true, paths: result.filePaths };
    } catch (err) {
      return { ok: false, paths: [] as string[], error: String(err) };
    }
  });

  ipcMain.handle("list-taskspace-files", async (_event, payload: { sessionId: string; taskspaceId: string; path?: string }) => {
    const sid = String(payload?.sessionId || "").trim();
    const taskspaceId = String(payload?.taskspaceId || "").trim();
    const relPath = String(payload?.path || ".").trim() || ".";
    if (!sid || !taskspaceId) return { ok: false, files: [], error: "sessionId and taskspaceId are required" };
    try {
      const query = `session_id=${encodeURIComponent(sid)}&taskspace_id=${encodeURIComponent(taskspaceId)}&path=${encodeURIComponent(relPath)}`;
      const resp = await fetch(`${getStudioUrl()}/api/taskspace/files?${query}`, {
        headers: { "x-agx-desktop-token": getStudioToken() },
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        return { ok: false, files: [], error: `HTTP ${resp.status}: ${body.slice(0, 300)}` };
      }
      return await resp.json();
    } catch (err) {
      return { ok: false, files: [], error: String(err) };
    }
  });

  ipcMain.handle("read-taskspace-file", async (_event, payload: { sessionId: string; taskspaceId: string; path: string }) => {
    const sid = String(payload?.sessionId || "").trim();
    const taskspaceId = String(payload?.taskspaceId || "").trim();
    const relPath = String(payload?.path || "").trim();
    if (!sid || !taskspaceId || !relPath) {
      return { ok: false, error: "sessionId, taskspaceId and path are required" };
    }
    try {
      const query = `session_id=${encodeURIComponent(sid)}&taskspace_id=${encodeURIComponent(taskspaceId)}&path=${encodeURIComponent(relPath)}`;
      const resp = await fetch(`${getStudioUrl()}/api/taskspace/file?${query}`, {
        headers: { "x-agx-desktop-token": getStudioToken() },
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        return { ok: false, error: `HTTP ${resp.status}: ${body.slice(0, 300)}` };
      }
      return await resp.json();
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle("load-session-messages", async (_event, sessionId: string) => {
    const sid = String(sessionId || "").trim();
    if (!sid) return { ok: false, messages: [], error: "sessionId is required" };
    const diskFull = readSessionMessagesFromDisk(SESSIONS_DIR, sid);
    if (diskFull) return diskFull;
    await waitForStudio(PRELOAD_READY_BUDGET_MS);
    return withFetchTimeout(
      (async () => {
        try {
          const resp = await fetch(
            `${getStudioUrl()}/api/session/messages?session_id=${encodeURIComponent(sid)}`,
            {
              headers: { "x-agx-desktop-token": getStudioToken() },
            }
          );
          if (!resp.ok) {
            const body = await resp.text().catch(() => "");
            return { ok: false, messages: [], error: `HTTP ${resp.status}: ${body.slice(0, 300)}` };
          }
          return await resp.json();
        } catch (err) {
          return { ok: false, messages: [], error: String(err) };
        }
      })(),
      { ok: false, messages: [], error: "timeout" },
      SESSION_MESSAGES_FETCH_TIMEOUT_MS
    );
  });

  ipcMain.handle(
    "load-session-messages-page",
    async (
      _event,
      sessionId: string,
      options: SessionMessagesPageOptions = {}
    ) => {
      const sid = String(sessionId || "").trim();
      if (!sid) return { ok: false, messages: [], error: "sessionId is required" };
      const wantTail =
        typeof options.tailRounds === "number" && Number.isFinite(options.tailRounds);
      if (wantTail) {
        const diskTail = readSessionMessagesTailFromDisk(SESSIONS_DIR, sid);
        if (diskTail) return diskTail;
      }
      await waitForStudio(PRELOAD_READY_BUDGET_MS);
      return withFetchTimeout(
        fetchSessionMessagesPageCore(sid, options),
        { ok: false, messages: [], error: "timeout" },
        SESSION_MESSAGES_FETCH_TIMEOUT_MS
      );
    }
  );

  ipcMain.handle("fork-avatar", async (_event, payload: { sessionId: string; name: string; role?: string }) => {
    try {
      const resp = await fetch(`${getStudioUrl()}/api/avatars/fork`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-agx-desktop-token": getStudioToken() },
        body: JSON.stringify({ session_id: payload.sessionId, name: payload.name, role: payload.role }),
      });
      if (!resp.ok) {
        const b = await resp.text().catch(() => "");
        return { ok: false, error: `HTTP ${resp.status}: ${b.slice(0, 300)}` };
      }
      return await resp.json();
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle("generate-avatar", async (_event, payload: { description: string }) => {
    try {
      const resp = await fetch(`${getStudioUrl()}/api/avatars/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-agx-desktop-token": getStudioToken() },
        body: JSON.stringify(payload),
      });
      if (!resp.ok) {
        const b = await resp.text().catch(() => "");
        return { ok: false, error: `HTTP ${resp.status}: ${b.slice(0, 300)}` };
      }
      return await resp.json();
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle("export-portable-package", async (_event, payload: unknown) => {
    const request = isPlainJsonObject(payload) ? payload : {};
    const studioExportRequest = normalizePortablePackageStudioExportRequest(request);
    if (!studioExportRequest) {
      return { ok: false, canceled: false, error: "invalid portable package export request" };
    }
    const { kind } = studioExportRequest;
    if (!isPortableRuntimePackageKind(kind)) {
      return { ok: false, canceled: false, error: "Skill 请从企业 Skill 市场发布，不支持导出为通用分享包" };
    }
    // On-disk exports remain fail-closed.  Only the explicit market publish
    // flow may receive a reviewable package containing scan findings.
    const safeExportRequest = { ...studioExportRequest, allow_scan_findings: false };

    try {
      const resp = await fetchStudioBackend("/api/portable-packages/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(safeExportRequest),
      });
      if (!resp.ok) {
        return { ok: false, canceled: false, error: await portablePackageApiError(resp) };
      }
      const body = (await resp.json()) as { ok?: unknown; package?: unknown; error?: unknown };
      if (body.ok !== true || !isPlainJsonObject(body.package)) {
        return {
          ok: false,
          canceled: false,
          error: String(body.error ?? "服务端没有返回可导出的分享包"),
        };
      }
      if (!normalizePortablePackagePublication(body.package, kind)) {
        return {
          ok: false,
          canceled: false,
          error: "服务端返回的分享包不是严格 v2 格式",
        };
      }

      // Share files contain the portable envelope only. The API's `{ok, package}`
      // transport wrapper must never become part of the on-disk format.
      const encoded = `${JSON.stringify(body.package, null, 2)}\n`;
      const size = Buffer.byteLength(encoded, "utf8");
      if (size > PORTABLE_PACKAGE_MAX_BYTES) {
        return {
          ok: false,
          canceled: false,
          error: `分享包超过 256 KiB，无法导出（${size} bytes）`,
        };
      }

      const suffix = PORTABLE_PACKAGE_SUFFIX[kind];
      const fallback = kind === "expert" ? "数字专家" : "项目群聊";
      const stem = safePortablePackageFileStem(request.name, fallback);
      const defaultPath = path.join(app.getPath("downloads"), `${stem}${suffix}`);
      const focused = BrowserWindow.getFocusedWindow() ?? mainWindow ?? null;
      const options: Electron.SaveDialogOptions = {
        defaultPath,
        filters: [{
          name: kind === "expert" ? "数字专家分享包" : "项目群聊分享包",
          extensions: [suffix.slice(1)],
        }],
      };
      const saveResult = focused
        ? await dialog.showSaveDialog(focused, options)
        : await dialog.showSaveDialog(options);
      if (saveResult.canceled || !saveResult.filePath) {
        return { ok: true, canceled: true };
      }
      const targetPath = saveResult.filePath.toLocaleLowerCase().endsWith(suffix)
        ? saveResult.filePath
        : `${saveResult.filePath}${suffix}`;
      await fs.promises.writeFile(targetPath, encoded, { encoding: "utf8", flag: "w" });
      return { ok: true, canceled: false, filePath: targetPath };
    } catch (err) {
      return { ok: false, canceled: false, error: String(err) };
    }
  });

  ipcMain.handle("create-portable-package-share-link", async (_event, payload: unknown) => {
    const request = isPlainJsonObject(payload) ? payload : {};
    const studioExportRequest = normalizePortablePackageStudioExportRequest(request);
    if (!studioExportRequest) {
      return { ok: false, error: "invalid portable package share request" };
    }
    const { kind } = studioExportRequest;
    if (!isPortableRuntimePackageKind(kind)) {
      return { ok: false, error: "Skill 请从企业 Skill 市场发布，不支持创建通用分享链接" };
    }
    // Point-to-point links use the same fail-closed export contract as files;
    // the market review dialog is the only path that can request findings.
    const safeExportRequest = { ...studioExportRequest, allow_scan_findings: false };

    const cfg = loadAgxConfig();
    const enterprise = cfg.enterprise;
    const validatedPortal = validatePortalOriginForBrowserLogin(
      enterprise?.base_url ?? "",
    );
    const portalOrigin = validatedPortal.ok ? validatedPortal.origin : "";
    const token = String(enterprise?.token ?? "").trim();
    if (!enterprise?.enabled || !portalOrigin || !token) {
      return { ok: false, error: "请先登录企业账户，再创建公司内部分享链接。" };
    }

    try {
      // Studio is the only exporter. The renderer can request only canonical
      // MD filenames and declarative references; Studio resolves, scans, and
      // validates their content before anything reaches the enterprise PAT.
      const exportResp = await fetchStudioBackend("/api/portable-packages/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(safeExportRequest),
      });
      if (!exportResp.ok) {
        return { ok: false, error: await portablePackageApiError(exportResp) };
      }
      const exported = (await exportResp.json()) as { ok?: unknown; package?: unknown };
      if (exported.ok !== true || !isPlainJsonObject(exported.package)) {
        return { ok: false, error: "服务端没有返回可分享的配置包" };
      }
      const publication = normalizePortablePackagePublication(exported.package, kind);
      if (!publication) {
        return { ok: false, error: "服务端返回的配置包不是严格 v2 格式" };
      }
      const encoded = JSON.stringify(exported.package);
      if (Buffer.byteLength(encoded, "utf8") > PORTABLE_PACKAGE_MAX_BYTES) {
        return { ok: false, error: "分享包超过 256 KiB，无法创建链接" };
      }

      // The enterprise PAT never crosses the contextBridge into the renderer.
      const response = await proxyAwareFetch(
        `${portalOrigin}/api/desktop/config-shares`,
        {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(publication),
          redirect: "error",
          signal: AbortSignal.timeout(PORTABLE_SHARE_FETCH_TIMEOUT_MS),
        },
      );
      const result = (await response.json().catch(() => ({}))) as {
        message?: unknown;
        data?: { path?: unknown; share_url?: unknown };
      };
      if (!response.ok) {
        if (response.status === 401) {
          return { ok: false, error: "企业登录已失效，请重新登录。" };
        }
        return {
          ok: false,
          error: String(result.message ?? `创建公司链接失败（HTTP ${response.status}）`),
        };
      }
      // Construct from the authenticated portal origin and the server-issued
      // opaque path. Public/CDN base URL settings may legitimately differ.
      const shareUrl = trustedPortableShareUrl(result.data?.path, portalOrigin);
      if (!shareUrl) {
        return { ok: false, error: "企业门户返回了不可信的分享链接，已拒绝复制。" };
      }
      clipboard.writeText(shareUrl);
      return { ok: true, shareUrl };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle("publish-portable-package-to-market", async (_event, payload: unknown) => {
    const request = isPlainJsonObject(payload) ? payload : {};
    const studioExportRequest = normalizePortablePackageStudioExportRequest(request);
    const visibility = normalizePortableMarketVisibility(request.visibility);
    const releaseNotes = normalizePortableMarketReleaseNotes(request.release_notes);
    const securityAction = request.security_action;
    const securityFindings = request.security_findings === undefined
      ? []
      : normalizePortableMarketSecurityFindings(request.security_findings, { allowManualOnly: true });
    if (
      !studioExportRequest
      || !visibility
      || releaseNotes === null
      || (securityAction !== undefined && securityAction !== "none" && securityAction !== "redact")
      || securityFindings === null
      || (securityAction === "redact" && securityFindings.length === 0)
    ) {
      return { ok: false, error: "invalid portable package market request" };
    }
    if (studioExportRequest.workspace_slots?.some((slot) => slot.required)) {
      return {
        ok: false,
        error: "发布到市场的工作区入口必须是可选的，请让接收方在安装或运行时选择工作区。",
      };
    }
    const { kind, id } = studioExportRequest;
    if (!isPortableRuntimePackageKind(kind)) {
      return { ok: false, error: "Skill 请使用独立的企业 Skill 市场发布流程" };
    }
    // The package is held only in the main process during this reviewable
    // attempt.  Final persistence remains fail-closed on the enterprise API.
    const marketExportRequest = { ...studioExportRequest, allow_scan_findings: true };
    const auth = currentEnterprisePortalAuth();
    if (!auth.ok) return auth;

    try {
      const exportResponse = await fetchStudioBackend("/api/portable-packages/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(marketExportRequest),
      });
      if (!exportResponse.ok) {
        return { ok: false, error: await portablePackageApiError(exportResponse) };
      }
      const exported = (await exportResponse.json()) as {
        ok?: unknown;
        package?: unknown;
        scan_report?: unknown;
      };
      if (exported.ok !== true || !isPlainJsonObject(exported.package)) {
        return { ok: false, error: "服务端没有返回可发布的配置包" };
      }
      if (!isPortablePackageScanReport(exported.scan_report)) {
        // An empty/malformed report must never be treated as a clean package:
        // the local scanner is the first privacy boundary before Portal.
        return {
          ok: false,
          error: "本地敏感信息扫描报告缺失或无效，已停止发布，请重试。",
        };
      }
      const localFindings = mergePortableMarketSecurityFindings(
        normalizePortablePackageScanFindings(exported.scan_report),
        scanPortableMarketText(releaseNotes, "release_notes"),
      );
      if (securityAction !== "redact" && localFindings.length > 0) {
        // Do not send the original package to Portal.  The publisher must
        // explicitly choose whether to cancel or redact after seeing this
        // metadata-only report.
        return {
          ok: false,
          error: "发布前发现敏感信息",
          securityFindings: localFindings,
        };
      }
      let packageValue = exported.package;
      let outgoingReleaseNotes = releaseNotes;
      if (securityAction === "redact") {
        const findingsForRedaction = [
          ...localFindings,
          ...(securityFindings ?? []),
        ];
        if (findingsForRedaction.some((finding) => PORTABLE_MARKET_MANUAL_ONLY_CODES.has(finding.code))) {
          return {
            ok: false,
            error: "扫描到暂不支持自动去除的敏感内容，请先手工修改后再发布。",
            securityFindings: findingsForRedaction,
          };
        }
        const sanitized = sanitizePortablePackageManifest(packageValue, findingsForRedaction);
        if (!sanitized) {
          return {
            ok: false,
            error: "无法安全自动去除结构标识中的敏感信息，请先修改后再发布。",
            securityFindings: findingsForRedaction,
          };
        }
        packageValue = sanitized;
        const sanitizedReleaseNotes = sanitizePortableMarketReleaseNotes(
          releaseNotes,
          findingsForRedaction,
        );
        if (sanitizedReleaseNotes === null) {
          return {
            ok: false,
            error: "自动去除未能替换全部检测到的版本说明敏感信息，请先手工修改后再发布。",
            securityFindings: findingsForRedaction,
          };
        }
        outgoingReleaseNotes = sanitizedReleaseNotes;
        const residualFindings = mergePortableMarketSecurityFindings(
          scanPortableMarketManifest(packageValue),
          scanPortableMarketText(outgoingReleaseNotes, "release_notes"),
        );
        if (residualFindings.length > 0) {
          const residualManualOnly = residualFindings.some((finding) => (
            PORTABLE_MARKET_MANUAL_ONLY_CODES.has(finding.code)
          ));
          return {
            ok: false,
            error: residualManualOnly
              ? "自动去除后仍发现未分类敏感内容，请先手工修改后再发布。"
              : "自动去除后仍发现敏感信息，请先手工修改后再发布。",
            securityFindings: residualFindings,
          };
        }
      }
      const publication = normalizePortablePackagePublication(packageValue, kind);
      if (!publication) {
        return {
          ok: false,
          error: securityAction === "redact"
            ? "自动去除后配置包结构不再有效，请先修改后再发布。"
            : "服务端返回的配置包不是严格 v2 格式",
        };
      }
      const raw = JSON.stringify(packageValue);
      if (Buffer.byteLength(raw, "utf8") > PORTABLE_PACKAGE_MAX_BYTES) {
        return { ok: false, error: "配置包超过 256 KiB，无法发布" };
      }
      const response = await proxyAwareFetch(
        `${auth.portalOrigin}/api/desktop/config-market`,
        {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            authorization: `Bearer ${auth.token}`,
          },
          body: JSON.stringify({
            // The market endpoint has its own strict envelope.  The generic
            // publication wrapper's kind/manifest_version fields belong to
            // Studio and point-to-point share exports, not market requests.
            manifest: publication.manifest,
            ...(outgoingReleaseNotes ? { release_notes: outgoingReleaseNotes } : {}),
            visibility: {
              type: visibility.type,
              department_ids: visibility.departmentIds,
              user_ids: visibility.userIds,
            },
          }),
          redirect: "error",
          signal: AbortSignal.timeout(PORTABLE_MARKET_FETCH_TIMEOUT_MS),
        },
      );
      const result = (await response.json().catch(() => ({}))) as {
        message?: unknown;
        data?: { item?: unknown; path?: unknown; findings?: unknown };
      };
      if (!response.ok) {
        const findings = response.status === 400
          ? normalizePortableMarketSecurityFindings(result.data?.findings)
          : null;
        return {
          ok: false,
          error: response.status === 401
            ? "企业登录已失效，请重新登录。"
            : String(result.message ?? `发布失败（HTTP ${response.status}）`),
          ...(findings && findings.length > 0 ? { securityFindings: findings } : {}),
        };
      }
      const item = normalizePortableMarketItem(result.data?.item);
      if (!item || item.kind !== kind || item.status !== "published") {
        return { ok: false, error: "企业门户返回了无效的市场条目" };
      }
      const marketUrl = trustedPortableMarketUrl(result.data?.path, auth.portalOrigin) ?? undefined;
      let warning = "";
      try {
        const markResponse = await fetchStudioBackend("/api/portable-packages/mark-published", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            kind,
            id,
            release_version: publication.manifest.release_version,
          }),
        });
        const marked = (await markResponse.json().catch(() => ({}))) as {
          ok?: unknown;
          error?: unknown;
          detail?: unknown;
        };
        if (!markResponse.ok || marked.ok !== true) {
          warning = String(
            marked.error
            ?? marked.detail
            ?? `本地版本记录失败（HTTP ${markResponse.status}）`,
          );
        }
      } catch (error) {
        warning = `本地版本记录失败：${String(error)}`;
      }
      const adminsOnlyNotice = visibility.type === "admins_only"
        ? "已提交给管理员；不会出现在员工市场，也不会自动下发。"
        : "";
      const successWarning = [
        warning ? `市场发布已成功，但${warning}` : "",
      ].filter(Boolean).join(" ");
      return {
        ok: true,
        item,
        marketUrl,
        ...(adminsOnlyNotice ? { notice: adminsOnlyNotice } : {}),
        ...(successWarning ? { warning: successWarning } : {}),
      };
    } catch (error) {
      return { ok: false, error: enterpriseFetchErrorMessage(error) };
    }
  });

  /**
   * Publish one locally indexed SKILL.md.  This path intentionally does not
   * accept a renderer-supplied filesystem path and never calls the external
   * SkillHub; the main process resolves the named local index entry, validates
   * its root, and sends only the authenticated enterprise market request.
   */
  ipcMain.handle("publish-skill-to-market", async (_event, payload: unknown) => {
    const request = isPlainJsonObject(payload) ? payload : {};
    const name = String(request.name ?? "").trim();
    const requestedReleaseVersion = String(request.release_version ?? "").trim();
    // An omitted version means “next patch” for this local artifact. The
    // renderer may still pass an explicit SemVer when a larger/minor release
    // is intentional; never silently rewrite an explicit value.
    const releaseVersion = requestedReleaseVersion;
    const skillId = String(request.skill_id ?? "").trim();
    const contentHash = String(request.content_hash ?? "").trim().toLowerCase();
    const releaseNotes = normalizePortableMarketReleaseNotes(request.release_notes);
    const visibility = normalizePortableMarketVisibility(request.visibility);
    const securityAction = request.security_action;
    const securityFindings = request.security_findings === undefined
      ? []
      : normalizePortableMarketSecurityFindings(request.security_findings, { allowManualOnly: true });
    if (
      !PORTABLE_SKILL_NAME_RE.test(name)
      || (releaseVersion !== "" && !PORTABLE_MARKET_SEMVER_RE.test(releaseVersion))
      || (skillId.length > 256 || /[\u0000-\u001f\u007f]/u.test(skillId))
      || (contentHash !== "" && !/^[a-f0-9]{64}$/u.test(contentHash))
      || releaseNotes === null
      || !visibility
      || (securityAction !== undefined && securityAction !== "none" && securityAction !== "redact")
      || securityFindings === null
      || (securityAction === "redact" && securityFindings.length === 0)
    ) {
      return { ok: false, error: "invalid skill market request" };
    }
    const auth = currentEnterprisePortalAuth();
    if (!auth.ok) return auth;
    try {
      const source = await loadLocalSkillMarketSource({ name, skillId, contentHash });
      const resolvedReleaseVersion = releaseVersion || nextSkillMarketVersion(source.baseDir);
      let manifestValue: Record<string, unknown> = buildSkillMarketManifest(source, resolvedReleaseVersion);
      let outgoingReleaseNotes = releaseNotes;
      const localFindings = mergePortableMarketSecurityFindings(
        scanPortableMarketManifest(manifestValue),
        scanPortableMarketText(releaseNotes, "release_notes"),
      );
      if (securityAction !== "redact" && localFindings.length > 0) {
        return {
          ok: false,
          error: "发布前发现敏感信息",
          securityFindings: localFindings,
        };
      }
      if (securityAction === "redact") {
        const findingsForRedaction = mergePortableMarketSecurityFindings(
          localFindings,
          securityFindings,
        );
        if (findingsForRedaction.some((finding) => PORTABLE_MARKET_MANUAL_ONLY_CODES.has(finding.code))) {
          return {
            ok: false,
            error: "扫描到暂不支持自动去除的敏感内容，请先手工修改后再发布。",
            securityFindings: findingsForRedaction,
          };
        }
        const sanitized = sanitizePortablePackageManifest(manifestValue, findingsForRedaction);
        const sanitizedNotes = sanitizePortableMarketReleaseNotes(releaseNotes, findingsForRedaction);
        if (!sanitized || sanitizedNotes === null) {
          return {
            ok: false,
            error: "无法安全自动去除检测到的敏感内容，请先手工修改后再发布。",
            securityFindings: findingsForRedaction,
          };
        }
        manifestValue = sanitized;
        outgoingReleaseNotes = sanitizedNotes;
        const residualFindings = mergePortableMarketSecurityFindings(
          scanPortableMarketManifest(manifestValue),
          scanPortableMarketText(outgoingReleaseNotes, "release_notes"),
        );
        if (residualFindings.length > 0) {
          return {
            ok: false,
            error: "自动去除后仍发现敏感信息，请先手工修改后再发布。",
            securityFindings: residualFindings,
          };
        }
      }
      const publication = normalizePortablePackagePublication(manifestValue, "skill");
      if (!publication) return { ok: false, error: "Skill 包未通过严格结构校验" };
      const encoded = JSON.stringify(publication.manifest);
      if (Buffer.byteLength(encoded, "utf8") > PORTABLE_PACKAGE_MAX_BYTES) {
        return { ok: false, error: "Skill 发布包超过 256 KiB，无法发布" };
      }
      const response = await proxyAwareFetch(
        `${auth.portalOrigin}/api/desktop/config-market`,
        {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            authorization: `Bearer ${auth.token}`,
          },
          body: JSON.stringify({
            manifest: publication.manifest,
            ...(outgoingReleaseNotes ? { release_notes: outgoingReleaseNotes } : {}),
            visibility: {
              type: visibility.type,
              department_ids: visibility.departmentIds,
              user_ids: visibility.userIds,
            },
          }),
          redirect: "error",
          signal: AbortSignal.timeout(PORTABLE_MARKET_FETCH_TIMEOUT_MS),
        },
      );
      const result = (await response.json().catch(() => ({}))) as {
        message?: unknown;
        data?: { item?: unknown; path?: unknown; findings?: unknown };
      };
      if (!response.ok) {
        const findings = response.status === 400
          ? normalizePortableMarketSecurityFindings(result.data?.findings)
          : null;
        return {
          ok: false,
          error: response.status === 401
            ? "企业登录已失效，请重新登录。"
            : String(result.message ?? `Skill 发布失败（HTTP ${response.status}）`),
          ...(findings && findings.length > 0 ? { securityFindings: findings } : {}),
        };
      }
      const item = normalizePortableMarketItem(result.data?.item);
      if (
        !item
        || item.kind !== "skill"
        || item.status !== "published"
        || item.sourceArtifactId !== String(manifestValue.artifact_id)
        || item.version !== resolvedReleaseVersion
      ) {
        return { ok: false, error: "企业门户返回了无效的 Skill 市场条目" };
      }
      // Persist identity only after the server has accepted this release. The
      // map contains no Skill content or token and lets later versions keep the
      // same publisher-owned artifact address.
      rememberSkillMarketArtifactVersion(
        source.baseDir,
        String(manifestValue.artifact_id),
        resolvedReleaseVersion,
      );
      const marketUrl = trustedPortableMarketUrl(result.data?.path, auth.portalOrigin) ?? undefined;
      const notice = visibility.type === "admins_only"
        ? "已提交给管理员；不会出现在员工市场，也不会自动下发。"
        : "";
      return { ok: true, item, marketUrl, ...(notice ? { notice } : {}) };
    } catch (error) {
      return { ok: false, error: enterpriseFetchErrorMessage(error) };
    }
  });

  ipcMain.handle("install-portable-market-skill", async (_event, payload: unknown) => {
    const request = isPlainJsonObject(payload) ? payload : {};
    const id = portableMarketItemId(request.id);
    if (!id) return { ok: false, error: "invalid market Skill id" };
    const auth = currentEnterprisePortalAuth();
    if (!auth.ok) return auth;
    try {
      const response = await proxyAwareFetch(
        `${auth.portalOrigin}/api/desktop/config-market/${encodeURIComponent(id)}`,
        {
          method: "GET",
          headers: { accept: "application/json", authorization: `Bearer ${auth.token}` },
          redirect: "error",
          signal: AbortSignal.timeout(PORTABLE_MARKET_FETCH_TIMEOUT_MS),
        },
      );
      const result = (await response.json().catch(() => ({}))) as {
        message?: unknown;
        data?: { item?: unknown; raw?: unknown; manifest?: unknown };
      };
      if (!response.ok) {
        return { ok: false, error: String(result.message ?? `读取市场 Skill 失败（HTTP ${response.status}）`) };
      }
      const item = normalizePortableMarketItem(result.data?.item);
      if (!item || item.id !== id || item.kind !== "skill" || item.status !== "published") {
        return { ok: false, error: "市场 Skill 条目类型或状态无效" };
      }
      const raw = typeof result.data?.raw === "string"
        ? result.data.raw
        : isPlainJsonObject(result.data?.manifest)
          ? JSON.stringify(result.data.manifest)
          : "";
      if (!raw || Buffer.byteLength(raw, "utf8") > PORTABLE_PACKAGE_MAX_BYTES) {
        return { ok: false, error: "市场 Skill 内容为空或超过大小限制" };
      }
      const installed = await installPortableMarketSkillRaw(item, raw);
      if (installed.ok) {
        const currentAuth = currentEnterprisePortalAuth();
        if (!currentAuth.ok) {
          console.warn("[enterprise-market] Skill 已安装，但当前企业身份不可用，跳过下载统计上报。");
        } else if (currentAuth.identityKey !== auth.identityKey) {
          console.warn("[enterprise-market] Skill 已安装，但企业账号已切换，跳过下载统计上报。");
        } else {
          await reportPortableMarketDownloadForAuth(currentAuth, {
            marketId: item.id,
            releaseId: item.releaseId,
          });
        }
      }
      return installed;
    } catch (error) {
      return { ok: false, error: enterpriseFetchErrorMessage(error) };
    }
  });

  ipcMain.handle("list-portable-market-installed-skills", async () => {
    const auth = currentEnterprisePortalAuth();
    if (!auth.ok) return { ok: false, installed: [], error: auth.error };
    return { ok: true, installed: listInstalledPortableMarketSkills() };
  });

  ipcMain.handle("list-portable-market-audience", async (_event, payload: unknown) => {
    const request = isPlainJsonObject(payload) ? payload : {};
    const auth = currentEnterprisePortalAuth();
    if (!auth.ok) return { ...auth, departments: [], users: [] };
    const query = String(request.query ?? "").trim().slice(0, 120);
    const url = new URL("/api/desktop/config-market/audience", auth.portalOrigin);
    if (query) url.searchParams.set("q", query);
    try {
      const response = await proxyAwareFetch(url.toString(), {
        method: "GET",
        headers: { accept: "application/json", authorization: `Bearer ${auth.token}` },
        redirect: "error",
        signal: AbortSignal.timeout(PORTABLE_MARKET_FETCH_TIMEOUT_MS),
      });
      const result = (await response.json().catch(() => ({}))) as {
        message?: unknown;
        data?: { departments?: unknown; users?: unknown };
      };
      if (!response.ok) {
        return {
          ok: false,
          departments: [],
          users: [],
          error: response.status === 401
            ? "企业登录已失效，请重新登录。"
            : String(result.message ?? `加载企业通讯录失败（HTTP ${response.status}）`),
        };
      }
      return {
        ok: true,
        departments: normalizePortableMarketAudienceDepartments(result.data?.departments),
        users: normalizePortableMarketAudienceUsers(result.data?.users),
      };
    } catch (error) {
      return {
        ok: false,
        departments: [],
        users: [],
        error: enterpriseFetchErrorMessage(error),
      };
    }
  });

  ipcMain.handle("list-portable-package-market", async (_event, payload: unknown) => {
    const request = isPlainJsonObject(payload) ? payload : {};
    const kind = request.kind;
    if (!isPortablePackageKind(kind)) {
      return { ok: false, items: [], error: "invalid market kind" };
    }
    const rawLimit = request.limit;
    const limit = rawLimit === undefined
      ? PORTABLE_MARKET_PAGE_SIZE
      : typeof rawLimit === "number"
        && Number.isSafeInteger(rawLimit)
        && rawLimit >= 1
        && rawLimit <= PORTABLE_MARKET_PAGE_SIZE
        ? rawLimit
        : null;
    if (limit === null) {
      return { ok: false, items: [], error: `invalid market page size (1-${PORTABLE_MARKET_PAGE_SIZE})` };
    }
    const cursor = normalizePortableMarketCursor(request.cursor);
    if (request.cursor !== undefined && request.cursor !== null && request.cursor !== "" && !cursor) {
      return { ok: false, items: [], error: "invalid market page cursor" };
    }
    const auth = currentEnterprisePortalAuth();
    if (!auth.ok) return { ...auth, items: [] };
    const query = String(request.query ?? "").trim().slice(0, 120);
    const url = new URL("/api/desktop/config-market", auth.portalOrigin);
    url.searchParams.set("kind", kind);
    url.searchParams.set("limit", String(limit));
    if (cursor) url.searchParams.set("cursor", cursor);
    if (query) url.searchParams.set("q", query);
    try {
      const response = await proxyAwareFetch(url.toString(), {
        method: "GET",
        headers: { accept: "application/json", authorization: `Bearer ${auth.token}` },
        redirect: "error",
        signal: AbortSignal.timeout(PORTABLE_MARKET_FETCH_TIMEOUT_MS),
      });
      const result = (await response.json().catch(() => ({}))) as {
        message?: unknown;
        data?: { items?: unknown; next_cursor?: unknown };
      };
      if (!response.ok) {
        return {
          ok: false,
          items: [],
          error: response.status === 401
            ? "企业登录已失效，请重新登录。"
            : String(result.message ?? `加载公司市场失败（HTTP ${response.status}）`),
        };
      }
      const rawNextCursor = result.data?.next_cursor;
      const nextCursor = rawNextCursor === undefined || rawNextCursor === null
        ? null
        : normalizePortableMarketCursor(rawNextCursor);
      if (rawNextCursor !== undefined && rawNextCursor !== null && !nextCursor) {
        return { ok: false, items: [], error: "企业市场返回了无效的分页游标" };
      }
      return {
        ok: true,
        items: normalizePortableMarketItems(result.data?.items, kind),
        nextCursor,
      } satisfies PortableMarketListResult;
    } catch (error) {
      return { ok: false, items: [], error: enterpriseFetchErrorMessage(error) };
    }
  });

  ipcMain.handle("inspect-portable-package-market-item", async (_event, payload: unknown) => {
    const request = isPlainJsonObject(payload) ? payload : {};
    const id = portableMarketItemId(request.id);
    const expectedKind = request.kind;
    if (!id || !isPortablePackageKind(expectedKind)) {
      return { ok: false, error: "invalid market item request" };
    }
    const auth = currentEnterprisePortalAuth();
    if (!auth.ok) return auth;
    try {
      const response = await proxyAwareFetch(
        `${auth.portalOrigin}/api/desktop/config-market/${encodeURIComponent(id)}`,
        {
          method: "GET",
          headers: { accept: "application/json", authorization: `Bearer ${auth.token}` },
          redirect: "error",
          signal: AbortSignal.timeout(PORTABLE_MARKET_FETCH_TIMEOUT_MS),
        },
      );
      const result = (await response.json().catch(() => ({}))) as {
        message?: unknown;
        data?: { item?: unknown; raw?: unknown; manifest?: unknown };
      };
      if (!response.ok) {
        return {
          ok: false,
          error: String(result.message ?? `读取市场条目失败（HTTP ${response.status}）`),
        };
      }
      const item = normalizePortableMarketItem(result.data?.item);
      if (!item || item.id !== id || item.kind !== expectedKind || item.status !== "published") {
        return { ok: false, error: "市场条目类型或状态无效" };
      }
      const raw = typeof result.data?.raw === "string"
        ? result.data.raw
        : isPlainJsonObject(result.data?.manifest)
          ? JSON.stringify(result.data.manifest)
          : "";
      const inspected = await inspectPortablePackageRaw(raw, expectedKind);
      if (!inspected.ok) return inspected;
      const rawDigest = crypto.createHash("sha256").update(raw, "utf8").digest("hex");
      if (rawDigest !== item.digest) {
        return { ok: false, error: "市场条目摘要与内容不一致，已拒绝导入" };
      }
      if (!portableMarketDownloadConfirmations.bind(inspected.confirmationToken, {
        marketId: item.id,
        releaseId: item.releaseId,
        enterpriseIdentity: auth.identityKey,
        rawDigest,
      })) {
        return { ok: false, error: "市场导入确认已失效，请重新打开条目" };
      }
      return { ...inspected, item };
    } catch (error) {
      return { ok: false, error: enterpriseFetchErrorMessage(error) };
    }
  });

  ipcMain.handle("inspect-portable-package-file", async (_event, payload: unknown) => {
    const request = isPlainJsonObject(payload) ? payload : {};
    const expectedKind = isPortableRuntimePackageKind(request.kind) ? request.kind : null;
    try {
      const focused = BrowserWindow.getFocusedWindow() ?? mainWindow ?? null;
      const extensions = expectedKind
        ? [PORTABLE_PACKAGE_SUFFIX[expectedKind].slice(1)]
        : [PORTABLE_PACKAGE_SUFFIX.expert.slice(1), PORTABLE_PACKAGE_SUFFIX.group.slice(1)];
      const options: Electron.OpenDialogOptions = {
        properties: ["openFile"],
        filters: [{ name: "AgenticX 分享包", extensions }],
      };
      const openResult = focused
        ? await dialog.showOpenDialog(focused, options)
        : await dialog.showOpenDialog(options);
      if (openResult.canceled || openResult.filePaths.length !== 1) {
        return { ok: true, canceled: true };
      }

      const filePath = openResult.filePaths[0];
      const fileKind = portablePackageKindFromPath(filePath);
      if (!fileKind || (expectedKind && fileKind !== expectedKind)) {
        const expectedSuffix = expectedKind
          ? PORTABLE_PACKAGE_SUFFIX[expectedKind]
          : `${PORTABLE_PACKAGE_SUFFIX.expert} 或 ${PORTABLE_PACKAGE_SUFFIX.group}`;
        return { ok: false, canceled: false, error: `请选择 ${expectedSuffix} 文件` };
      }

      const stat = await fs.promises.lstat(filePath);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        return { ok: false, canceled: false, error: "只能导入普通文件，不能导入目录或符号链接" };
      }
      if (stat.size <= 0) {
        return { ok: false, canceled: false, error: "分享包文件为空" };
      }
      if (stat.size > PORTABLE_PACKAGE_MAX_BYTES) {
        return { ok: false, canceled: false, error: "分享包超过 256 KiB，无法导入" };
      }

      const fileHandle = await fs.promises.open(filePath, "r");
      let fileBuffer: Buffer;
      try {
        const openedStat = await fileHandle.stat();
        if (!openedStat.isFile()) {
          return { ok: false, canceled: false, error: "只能导入普通文件" };
        }
        const bounded = Buffer.alloc(PORTABLE_PACKAGE_MAX_BYTES + 1);
        let totalBytesRead = 0;
        while (totalBytesRead < bounded.length) {
          const { bytesRead } = await fileHandle.read(
            bounded,
            totalBytesRead,
            bounded.length - totalBytesRead,
            totalBytesRead,
          );
          if (bytesRead === 0) break;
          totalBytesRead += bytesRead;
        }
        if (totalBytesRead > PORTABLE_PACKAGE_MAX_BYTES) {
          return { ok: false, canceled: false, error: "分享包超过 256 KiB，无法导入" };
        }
        fileBuffer = bounded.subarray(0, totalBytesRead);
      } finally {
        await fileHandle.close();
      }
      let rawText = "";
      try {
        rawText = new TextDecoder("utf-8", { fatal: true }).decode(fileBuffer);
      } catch {
        return { ok: false, canceled: false, error: "分享包必须是有效的 UTF-8 文本" };
      }
      let packageEnvelope: unknown;
      try {
        // Parse locally for a fast syntax/top-level check, but retain and send
        // the original UTF-8 text so Studio can reject duplicate JSON keys.
        packageEnvelope = JSON.parse(rawText);
      } catch {
        return { ok: false, canceled: false, error: "分享包不是有效的 JSON 文件" };
      }
      if (!isPlainJsonObject(packageEnvelope)) {
        return { ok: false, canceled: false, error: "分享包顶层必须是 JSON 对象" };
      }

      const resp = await fetchStudioBackend("/api/portable-packages/inspect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ raw: rawText }),
      });
      if (!resp.ok) {
        return { ok: false, canceled: false, error: await portablePackageApiError(resp) };
      }
      const inspected = (await resp.json()) as {
        ok?: unknown;
        preview?: unknown;
        confirmation_token?: unknown;
        error?: unknown;
      };
      if (inspected.ok !== true || !isPlainJsonObject(inspected.preview)) {
        return {
          ok: false,
          canceled: false,
          error: String(inspected.error ?? "服务端无法预览该分享包"),
        };
      }
      const previewKind = inspected.preview.kind;
      if (!isPortablePackageKind(previewKind) || previewKind !== fileKind) {
        return { ok: false, canceled: false, error: "分享包类型与文件后缀不一致" };
      }
      const confirmationToken = String(inspected.confirmation_token ?? "").trim();
      if (!/^[A-Za-z0-9_-]{32}$/.test(confirmationToken)) {
        return { ok: false, canceled: false, error: "服务端没有返回有效的一次性确认票据" };
      }
      return {
        ok: true,
        canceled: false,
        filePath,
        raw: rawText,
        confirmationToken,
        preview: inspected.preview,
      };
    } catch (err) {
      return { ok: false, canceled: false, error: String(err) };
    }
  });

  ipcMain.handle("import-portable-package", async (_event, payload: unknown) => {
    const request = isPlainJsonObject(payload) ? payload : {};
    const rawText = typeof request.raw === "string" ? request.raw : "";
    const confirmationToken = String(request.confirmationToken ?? "").trim();
    if (!rawText) return { ok: false, error: "缺少分享包原始 JSON" };
    if (!/^[A-Za-z0-9_-]{32}$/.test(confirmationToken)) {
      return { ok: false, error: "导入确认已失效，请重新选择文件并预览" };
    }
    if (Buffer.byteLength(rawText, "utf8") > PORTABLE_PACKAGE_MAX_BYTES) {
      return { ok: false, error: "分享包超过 256 KiB，无法导入" };
    }
    try {
      if (!isPlainJsonObject(JSON.parse(rawText))) {
        return { ok: false, error: "分享包顶层必须是 JSON 对象" };
      }
    } catch {
      return { ok: false, error: "分享包不是有效的 JSON 文件" };
    }
    try {
      const resp = await fetchStudioBackend("/api/portable-packages/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          raw: rawText,
          confirmation_token: confirmationToken,
        }),
      });
      if (!resp.ok) {
        const detail = await portablePackageApiError(resp);
        return {
          ok: false,
          error: resp.status === 409
            ? "导入确认已失效或已使用，请关闭窗口并重新选择文件。"
            : detail,
        };
      }
      const result = (await resp.json()) as Record<string, unknown>;
      if (result.ok !== true || !isPortableRuntimePackageKind(result.kind)) {
        return { ok: false, error: String(result.error ?? "导入失败") };
      }
      // Only a successful local import can consume a market confirmation. A
      // regular file/share import has no matching binding and therefore never
      // emits market telemetry.
      const currentAuth = currentEnterprisePortalAuth();
      const rawDigest = crypto.createHash("sha256").update(rawText, "utf8").digest("hex");
      if (!currentAuth.ok) {
        portableMarketDownloadConfirmations.discard(confirmationToken);
      } else {
        const binding = portableMarketDownloadConfirmations.takeForImport({
          confirmationToken,
          enterpriseIdentity: currentAuth.identityKey,
          rawDigest,
        });
        if (binding) await reportPortableMarketDownloadForAuth(currentAuth, binding);
      }
      return result;
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle("list-groups", async () => {
    await waitForStudio();
    return fetchListGroupsOnce();
  });

  ipcMain.handle("create-group", async (_event, payload: { name: string; avatar_ids: string[]; description?: string; avatar_url?: string; workspace_dir?: string; routing?: string; host_avatar_id: string }) => {
    try {
      const resp = await fetch(`${getStudioUrl()}/api/groups`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-agx-desktop-token": getStudioToken() },
        body: JSON.stringify(payload),
      });
      if (!resp.ok) {
        const b = await resp.text().catch(() => "");
        return { ok: false, error: `HTTP ${resp.status}: ${b.slice(0, 300)}` };
      }
      return await resp.json();
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle("update-group", async (_event, payload: { id: string; name?: string; avatar_ids?: string[]; description?: string; avatar_url?: string; workspace_dir?: string; routing?: string; host_avatar_id?: string }) => {
    const { id, ...body } = payload;
    try {
      const resp = await fetch(`${getStudioUrl()}/api/groups/${encodeURIComponent(id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", "x-agx-desktop-token": getStudioToken() },
        body: JSON.stringify(body),
      });
      if (!resp.ok) {
        const b = await resp.text().catch(() => "");
        return { ok: false, error: `HTTP ${resp.status}: ${b.slice(0, 300)}` };
      }
      return await resp.json();
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle("delete-group", async (_event, id: string) => {
    try {
      const resp = await fetch(`${getStudioUrl()}/api/groups/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: { "x-agx-desktop-token": getStudioToken() },
      });
      if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}` };
      return await resp.json();
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle("load-email-config", async () => {
    const cfg = loadAgxConfig();
    return { ok: true, config: loadEmailConfigFromAgx(cfg) };
  });

  ipcMain.handle("load-trinity-config", async () => {
    const cfg = loadAgxConfig();
    return { ok: true, config: loadTrinityConfig(cfg) };
  });

  ipcMain.handle("save-trinity-config", async (_event, payload: unknown) => {
    const checked = validateTrinityConfigPayload(payload);
    if (!checked.ok) return { ok: false, error: checked.error };
    try {
      const cfg = loadAgxConfig();
      const root = cfg as Record<string, unknown>;
      root.agent_harness_trinity = { ...checked.config };
      saveAgxConfig(cfg);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle("load-turn-archive-config", async () => {
    const cfg = loadAgxConfig();
    return { ok: true, config: loadTurnArchiveConfig(cfg) };
  });

  ipcMain.handle("save-turn-archive-config", async (_event, payload: unknown) => {
    const checked = validateTurnArchiveConfigPayload(payload);
    if (!checked.ok) return { ok: false, error: checked.error };
    try {
      const cfg = loadAgxConfig();
      const root = cfg as Record<string, unknown>;
      const prevMemory = root.memory;
      const mergedMemory =
        prevMemory && typeof prevMemory === "object" && !Array.isArray(prevMemory)
          ? { ...(prevMemory as Record<string, unknown>) }
          : {};
      mergedMemory.turn_archive = { ...checked.config };
      root.memory = mergedMemory;
      saveAgxConfig(cfg);
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[save-turn-archive-config]", err);
      return { ok: false, error: msg || "config_write_failed" };
    }
  });

  ipcMain.handle("load-automation-config", async () => {
    const cfg = loadAgxConfig();
    return { ok: true, config: loadAutomationConfigFromAgx(cfg) };
  });

  ipcMain.handle("save-automation-config", async (_event, payload: unknown) => {
    if (!payload || typeof payload !== "object") return { ok: false, error: "invalid payload: object required" };
    const p = payload as { prevent_sleep?: unknown };
    let preventSleep: boolean;
    try {
      preventSleep = parseBooleanStrict(p.prevent_sleep, "prevent_sleep");
    } catch (err) {
      return { ok: false, error: String(err) };
    }
    try {
      const cfg = loadAgxConfig();
      const root = cfg as Record<string, unknown>;
      const prev = root.automation;
      const merged =
        prev && typeof prev === "object" && !Array.isArray(prev)
          ? { ...(prev as Record<string, unknown>) }
          : {};
      merged.prevent_sleep = preventSleep;
      root.automation = merged;
      saveAgxConfig(cfg);
      applyPreventSleepFromConfig(cfg);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  const clampStallDetectSeconds = (raw: unknown) => {
    const envDetect = process.env.AGX_STALL_DETECT_SILENCE_SECONDS;
    const n =
      envDetect !== undefined ? Number(envDetect) : Number(raw ?? 90);
    if (!Number.isFinite(n)) return 90;
    return Math.max(30, Math.min(300, Math.round(n)));
  };

  const readUnattendedRuntime = (raw: Record<string, unknown>) => {
    const nested =
      raw.unattended && typeof raw.unattended === "object" && !Array.isArray(raw.unattended)
        ? (raw.unattended as Record<string, unknown>)
        : {};
    const pick = (key: string, flatKey: string, fallback: unknown) =>
      nested[key] ?? raw[flatKey] ?? fallback;
    const maxCont = Number(pick("max_continuations_per_session", "unattended_max_continuations_per_session", 20));
    const maxHours = Number(pick("max_wall_clock_hours", "unattended_max_wall_clock_hours", 6));
    const stallAfter = Number(pick("stall_continue_after_seconds", "unattended_stall_continue_after_seconds", 120));
    return {
      unattended_enabled: Boolean(pick("enabled", "unattended_enabled", false)),
      unattended_max_continuations_per_session: Number.isFinite(maxCont)
        ? Math.max(1, Math.min(100, Math.round(maxCont)))
        : 20,
      unattended_max_wall_clock_hours: Number.isFinite(maxHours)
        ? Math.max(0.5, Math.min(48, maxHours))
        : 6,
      unattended_stall_continue_after_seconds: Number.isFinite(stallAfter)
        ? Math.max(30, Math.min(600, Math.round(stallAfter)))
        : 120,
      unattended_auto_resume_exhausted: Boolean(
        pick("auto_resume_exhausted", "unattended_auto_resume_exhausted", true),
      ),
      unattended_auto_resume_interrupted: Boolean(
        pick("auto_resume_interrupted", "unattended_auto_resume_interrupted", true),
      ),
    };
  };

  const readStallNudgeRuntime = (raw: Record<string, unknown>) => {
    const detectSec = clampStallDetectSeconds(raw.stall_detect_silence_seconds);
    const envEnabled = process.env.AGX_STALL_AUTO_NUDGE_ENABLED;
    const envAfter = process.env.AGX_STALL_AUTO_NUDGE_AFTER_SECONDS;
    const envMax = process.env.AGX_STALL_AUTO_NUDGE_MAX_PER_SESSION;
    const enabledFromEnv =
      envEnabled === "1" ? true : envEnabled === "0" ? false : undefined;
    const afterRaw = envAfter !== undefined ? Number(envAfter) : Number(raw.stall_auto_nudge_after_seconds ?? 120);
    const maxRaw = envMax !== undefined ? Number(envMax) : Number(raw.stall_auto_nudge_max_per_session ?? 2);
    let afterSec = Number.isFinite(afterRaw)
      ? Math.max(60, Math.min(300, Math.round(afterRaw)))
      : 120;
    if (afterSec < detectSec) afterSec = detectSec;
    return {
      stall_detect_silence_seconds: detectSec,
      stall_auto_nudge_enabled:
        enabledFromEnv !== undefined
          ? enabledFromEnv
          : Boolean(raw.stall_auto_nudge_enabled ?? false),
      stall_auto_nudge_after_seconds: afterSec,
      stall_auto_nudge_max_per_session: Number.isFinite(maxRaw)
        ? Math.max(1, Math.min(5, Math.round(maxRaw)))
        : 2,
    };
  };

  // LLM round-timeout patience mode (patient wait + auto resume).
  // The backend honors AGX_LLM_STALL_PATIENCE_* env overrides at call time;
  // these keys are the persisted config.yaml runtime.* source.
  const readStallPatienceRuntime = (raw: Record<string, unknown>) => {
    const maxRaw = Number(raw.llm_stall_patience_max_attempts ?? 3);
    const budgetRaw = Number(raw.llm_stall_patience_budget_seconds ?? 900);
    return {
      llm_stall_patience_enabled: Boolean(raw.llm_stall_patience_enabled ?? true),
      llm_stall_patience_max_attempts: Number.isFinite(maxRaw)
        ? Math.max(1, Math.min(10, Math.round(maxRaw)))
        : 3,
      llm_stall_patience_budget_seconds: Number.isFinite(budgetRaw)
        ? Math.max(60, Math.min(3600, Math.round(budgetRaw)))
        : 900,
    };
  };

  const readTokenBudgetRuntime = (raw: Record<string, unknown>) => {
    const nested =
      raw.token_budget && typeof raw.token_budget === "object" && !Array.isArray(raw.token_budget)
        ? (raw.token_budget as Record<string, unknown>)
        : {};
    const warningCandidate = nested.warning_tokens_per_session;
    const hasWarning =
      warningCandidate !== undefined
      && warningCandidate !== null
      && Number.isFinite(Number(warningCandidate));
    const sessionRaw = Number(
      nested.max_tokens_per_session ?? raw.max_tokens_per_session ?? 1_000_000,
    );
    const warningRaw = Number(hasWarning ? warningCandidate : 500_000);
    const turnRaw = Number(nested.max_tokens_per_turn ?? raw.max_tokens_per_turn ?? 100_000);
    const maxTokensPerSession = Number.isFinite(sessionRaw)
        ? Math.max(100_000, Math.min(5_000_000, Math.round(sessionRaw)))
        : 1_000_000;
    return {
      max_tokens_per_session: maxTokensPerSession,
      warning_tokens_per_session: Number.isFinite(warningRaw)
        ? Math.max(50_000, Math.min(maxTokensPerSession - 1, Math.round(warningRaw)))
        : Math.min(500_000, maxTokensPerSession - 1),
      max_tokens_per_turn: Number.isFinite(turnRaw)
        ? Math.max(50_000, Math.min(1_000_000, Math.round(turnRaw)))
        : 100_000,
    };
  };

  const readEffectiveTokenBudget = (
    cfg: AgxConfig,
    raw: Record<string, unknown>,
  ) => {
    const local = readTokenBudgetRuntime(raw);
    const enterpriseManaged = Boolean(cfg.enterprise?.enabled && cfg.enterprise?.token);
    if (!enterpriseManaged) {
      return { ...local, token_budget_managed: false };
    }
    const managed = normalizeEnterpriseTokenBudgetPolicy(
      cfg.enterprise?.policy?.token_budget,
    );
    return {
      ...local,
      ...managed,
      token_budget_managed: true,
    };
  };

  ipcMain.handle("load-runtime-config", async () => {
    try {
      const cfg = loadAgxConfig();
      const rt = cfg.runtime;
      const raw = rt && typeof rt === "object" && !Array.isArray(rt)
        ? (rt as Record<string, unknown>)
        : {};
      const val = Number(raw.max_tool_rounds ?? 30);
      const taskspacesVal = Number(raw.max_taskspaces ?? 20);
      const toolSearchRaw =
        raw.tool_search && typeof raw.tool_search === "object" && !Array.isArray(raw.tool_search)
          ? (raw.tool_search as Record<string, unknown>)
          : {};
      let toolSearchMode = String(toolSearchRaw.mode ?? "off").trim().toLowerCase();
      if (toolSearchMode !== "off" && toolSearchMode !== "auto" && toolSearchMode !== "always") {
        toolSearchMode = "off";
      }
      const thresholdRaw = Number(toolSearchRaw.auto_schema_token_threshold ?? 6000);
      const toolSearchThreshold = Number.isFinite(thresholdRaw)
        ? Math.max(1000, Math.min(50000, Math.round(thresholdRaw)))
        : 6000;
      let toolSearchStrategy = String(toolSearchRaw.threshold_strategy ?? "adaptive")
        .trim()
        .toLowerCase();
      if (toolSearchStrategy !== "adaptive" && toolSearchStrategy !== "manual") {
        toolSearchStrategy = "adaptive";
      }
      const ratioRaw = Number(toolSearchRaw.context_budget_ratio ?? 0.05);
      const toolSearchRatio = Number.isFinite(ratioRaw)
        ? Math.max(0.01, Math.min(0.25, ratioRaw))
        : 0.05;
      const tokenBudgetRuntime = readEffectiveTokenBudget(cfg, raw);
      return {
        ok: true,
        max_tool_rounds: Number.isFinite(val) ? Math.max(10, Math.min(120, val)) : 30,
        max_taskspaces: Number.isFinite(taskspacesVal)
          ? Math.max(5, Math.min(100, Math.round(taskspacesVal)))
          : 20,
        auto_resume_on_exhaustion: Boolean(raw.auto_resume_on_exhaustion ?? false),
        max_auto_resumes: Math.max(0, Math.min(10, Number(raw.max_auto_resumes ?? 3))),
        tool_search_mode: toolSearchMode,
        tool_search_auto_schema_token_threshold: toolSearchThreshold,
        tool_search_threshold_strategy: toolSearchStrategy,
        tool_search_context_budget_ratio: toolSearchRatio,
        ...readStallNudgeRuntime(raw),
        ...readStallPatienceRuntime(raw),
        ...readUnattendedRuntime(raw),
        ...tokenBudgetRuntime,
        model_context_windows: sanitizeModelContextWindowOverrides(raw.model_context_windows),
        live_reattach_enabled: Boolean(raw.live_reattach_enabled ?? true),
      };
    } catch (err) {
      return {
        ok: false,
        error: String(err),
        max_tool_rounds: 30,
        max_taskspaces: 20,
        tool_search_mode: "off",
        tool_search_auto_schema_token_threshold: 6000,
        tool_search_threshold_strategy: "adaptive",
        tool_search_context_budget_ratio: 0.05,
        auto_resume_on_exhaustion: false,
        max_auto_resumes: 3,
        stall_detect_silence_seconds: 90,
        stall_auto_nudge_enabled: false,
        stall_auto_nudge_after_seconds: 120,
        stall_auto_nudge_max_per_session: 2,
        llm_stall_patience_enabled: true,
        llm_stall_patience_max_attempts: 3,
        llm_stall_patience_budget_seconds: 900,
        unattended_enabled: false,
        unattended_max_continuations_per_session: 20,
        unattended_max_wall_clock_hours: 6,
        unattended_stall_continue_after_seconds: 120,
        unattended_auto_resume_exhausted: true,
        unattended_auto_resume_interrupted: true,
        max_tokens_per_session: 1_000_000,
        warning_tokens_per_session: 500_000,
        max_tokens_per_turn: 100_000,
        token_budget_managed: false,
        model_context_windows: {},
        live_reattach_enabled: true,
      };
    }
  });

  ipcMain.handle("save-runtime-config", async (_event, payload: unknown) => {
    if (!payload || typeof payload !== "object") return { ok: false, error: "invalid payload" };
    const p = payload as Record<string, unknown>;
    try {
      const cfg = loadAgxConfig();
      const tokenBudgetManaged = Boolean(cfg.enterprise?.enabled && cfg.enterprise?.token);
      const managedTokenFieldsRequested =
        p.max_tokens_per_session !== undefined
        || p.warning_tokens_per_session !== undefined;
      const hasNonManagedTokenFields = Object.keys(p).some(
        (key) => key !== "max_tokens_per_session" && key !== "warning_tokens_per_session",
      );
      if (tokenBudgetManaged && managedTokenFieldsRequested && !hasNonManagedTokenFields) {
        return { ok: false, error: "会话 Token 提醒阈值由组织统一管理" };
      }
      const root = cfg as Record<string, unknown>;
      const prev = root.runtime;
      const merged = prev && typeof prev === "object" && !Array.isArray(prev)
        ? { ...(prev as Record<string, unknown>) }
        : {};
      if (p.max_tool_rounds !== undefined) {
        const v = Number(p.max_tool_rounds);
        if (!Number.isFinite(v)) return { ok: false, error: "max_tool_rounds must be a number" };
        merged.max_tool_rounds = Math.max(10, Math.min(120, Math.round(v)));
      }
      if (p.max_taskspaces !== undefined) {
        const v = Number(p.max_taskspaces);
        if (!Number.isFinite(v)) return { ok: false, error: "max_taskspaces must be a number" };
        merged.max_taskspaces = Math.max(5, Math.min(100, Math.round(v)));
      }
      if (p.auto_resume_on_exhaustion !== undefined) {
        merged.auto_resume_on_exhaustion = Boolean(p.auto_resume_on_exhaustion);
      }
      if (p.model_context_windows !== undefined) {
        // 整表替换：面板清空某一行就是删除该覆盖，回到自动识别。
        merged.model_context_windows = sanitizeModelContextWindowOverrides(p.model_context_windows);
      }
      if (p.max_auto_resumes !== undefined) {
        const v = Number(p.max_auto_resumes);
        if (Number.isFinite(v)) merged.max_auto_resumes = Math.max(0, Math.min(10, Math.round(v)));
      }
      if (p.stall_detect_silence_seconds !== undefined) {
        merged.stall_detect_silence_seconds = clampStallDetectSeconds(
          p.stall_detect_silence_seconds,
        );
      }
      const detectSec = clampStallDetectSeconds(merged.stall_detect_silence_seconds);
      merged.stall_detect_silence_seconds = detectSec;
      if (p.stall_auto_nudge_enabled !== undefined) {
        merged.stall_auto_nudge_enabled = Boolean(p.stall_auto_nudge_enabled);
      }
      if (p.stall_auto_nudge_after_seconds !== undefined) {
        const v = Number(p.stall_auto_nudge_after_seconds);
        if (Number.isFinite(v)) {
          let after = Math.max(60, Math.min(300, Math.round(v)));
          if (after < detectSec) after = detectSec;
          merged.stall_auto_nudge_after_seconds = after;
        }
      } else if (
        Number(merged.stall_auto_nudge_after_seconds) > 0 &&
        Number(merged.stall_auto_nudge_after_seconds) < detectSec
      ) {
        merged.stall_auto_nudge_after_seconds = detectSec;
      }
      if (p.stall_auto_nudge_max_per_session !== undefined) {
        const v = Number(p.stall_auto_nudge_max_per_session);
        if (Number.isFinite(v)) {
          merged.stall_auto_nudge_max_per_session = Math.max(1, Math.min(5, Math.round(v)));
        }
      }
      if (p.llm_stall_patience_enabled !== undefined) {
        merged.llm_stall_patience_enabled = Boolean(p.llm_stall_patience_enabled);
      }
      if (p.llm_stall_patience_max_attempts !== undefined) {
        const v = Number(p.llm_stall_patience_max_attempts);
        if (Number.isFinite(v)) {
          merged.llm_stall_patience_max_attempts = Math.max(1, Math.min(10, Math.round(v)));
        }
      }
      if (p.llm_stall_patience_budget_seconds !== undefined) {
        const v = Number(p.llm_stall_patience_budget_seconds);
        if (Number.isFinite(v)) {
          merged.llm_stall_patience_budget_seconds = Math.max(60, Math.min(3600, Math.round(v)));
        }
      }
      const unattendedPrev =
        merged.unattended && typeof merged.unattended === "object" && !Array.isArray(merged.unattended)
          ? { ...(merged.unattended as Record<string, unknown>) }
          : {};
      const unattendedMerged: Record<string, unknown> = { ...unattendedPrev };
      if (p.unattended_enabled !== undefined) {
        unattendedMerged.enabled = Boolean(p.unattended_enabled);
      }
      if (p.unattended_max_continuations_per_session !== undefined) {
        const v = Number(p.unattended_max_continuations_per_session);
        if (Number.isFinite(v)) {
          unattendedMerged.max_continuations_per_session = Math.max(1, Math.min(100, Math.round(v)));
        }
      }
      if (p.unattended_max_wall_clock_hours !== undefined) {
        const v = Number(p.unattended_max_wall_clock_hours);
        if (Number.isFinite(v)) {
          unattendedMerged.max_wall_clock_hours = Math.max(0.5, Math.min(48, v));
        }
      }
      if (p.unattended_stall_continue_after_seconds !== undefined) {
        const v = Number(p.unattended_stall_continue_after_seconds);
        if (Number.isFinite(v)) {
          unattendedMerged.stall_continue_after_seconds = Math.max(30, Math.min(600, Math.round(v)));
        }
      }
      if (p.unattended_auto_resume_exhausted !== undefined) {
        unattendedMerged.auto_resume_exhausted = Boolean(p.unattended_auto_resume_exhausted);
      }
      if (p.unattended_auto_resume_interrupted !== undefined) {
        unattendedMerged.auto_resume_interrupted = Boolean(p.unattended_auto_resume_interrupted);
      }
      if (Object.keys(unattendedMerged).length > 0) {
        merged.unattended = unattendedMerged;
      }
      const tokenBudgetPrev =
        merged.token_budget && typeof merged.token_budget === "object" && !Array.isArray(merged.token_budget)
          ? { ...(merged.token_budget as Record<string, unknown>) }
          : {};
      const tokenBudgetMerged: Record<string, unknown> = { ...tokenBudgetPrev };
      if (
        !tokenBudgetManaged
        && (
          p.max_tokens_per_session !== undefined
          || p.warning_tokens_per_session !== undefined
        )
      ) {
        const currentTokenBudget = readTokenBudgetRuntime(merged);
        const sessionValue = Number(
          p.max_tokens_per_session ?? currentTokenBudget.max_tokens_per_session,
        );
        const warningValue = Number(
          p.warning_tokens_per_session ?? currentTokenBudget.warning_tokens_per_session,
        );
        if (!Number.isFinite(sessionValue)) {
          return { ok: false, error: "会话 Token 红色提醒阈值必须是数字" };
        }
        if (!Number.isFinite(warningValue)) {
          return { ok: false, error: "会话 Token 黄色提醒阈值必须是数字" };
        }
        const sessionLimit = Math.round(sessionValue);
        const warningLimit = Math.round(warningValue);
        if (sessionLimit < 100_000 || sessionLimit > 5_000_000) {
          return { ok: false, error: "会话 Token 红色提醒阈值须在 100,000–5,000,000 之间" };
        }
        if (warningLimit < 50_000 || warningLimit >= 5_000_000) {
          return { ok: false, error: "会话 Token 黄色提醒阈值须在 50,000–4,999,999 之间" };
        }
        if (warningLimit >= sessionLimit) {
          return { ok: false, error: "黄色提醒阈值必须低于红色提醒阈值" };
        }
        tokenBudgetMerged.warning_tokens_per_session = warningLimit;
        tokenBudgetMerged.max_tokens_per_session = sessionLimit;
      }
      if (p.max_tokens_per_turn !== undefined) {
        const v = Number(p.max_tokens_per_turn);
        if (!Number.isFinite(v)) return { ok: false, error: "max_tokens_per_turn must be a number" };
        tokenBudgetMerged.max_tokens_per_turn = Math.max(50_000, Math.min(1_000_000, Math.round(v)));
      }
      if (Object.keys(tokenBudgetMerged).length > 0) {
        merged.token_budget = tokenBudgetMerged;
      }
      if (
        p.tool_search_mode !== undefined ||
        p.tool_search_auto_schema_token_threshold !== undefined ||
        p.tool_search_threshold_strategy !== undefined ||
        p.tool_search_context_budget_ratio !== undefined
      ) {
        const prevTs =
          merged.tool_search && typeof merged.tool_search === "object" && !Array.isArray(merged.tool_search)
            ? { ...(merged.tool_search as Record<string, unknown>) }
            : {};
        if (p.tool_search_mode !== undefined) {
          const mode = String(p.tool_search_mode).trim().toLowerCase();
          if (mode !== "off" && mode !== "auto" && mode !== "always") {
            return { ok: false, error: "tool_search_mode must be off|auto|always" };
          }
          prevTs.mode = mode;
        }
        if (p.tool_search_auto_schema_token_threshold !== undefined) {
          const v = Number(p.tool_search_auto_schema_token_threshold);
          if (!Number.isFinite(v)) {
            return { ok: false, error: "tool_search_auto_schema_token_threshold must be a number" };
          }
          prevTs.auto_schema_token_threshold = Math.max(1000, Math.min(50000, Math.round(v)));
        }
        if (p.tool_search_threshold_strategy !== undefined) {
          const strategy = String(p.tool_search_threshold_strategy).trim().toLowerCase();
          if (strategy !== "adaptive" && strategy !== "manual") {
            return { ok: false, error: "tool_search_threshold_strategy must be adaptive|manual" };
          }
          prevTs.threshold_strategy = strategy;
        }
        if (p.tool_search_context_budget_ratio !== undefined) {
          const r = Number(p.tool_search_context_budget_ratio);
          if (!Number.isFinite(r)) {
            return { ok: false, error: "tool_search_context_budget_ratio must be a number" };
          }
          prevTs.context_budget_ratio = Math.max(0.01, Math.min(0.25, r));
        }
        if (prevTs.mode === undefined) prevTs.mode = "off";
        if (prevTs.auto_schema_token_threshold === undefined) {
          prevTs.auto_schema_token_threshold = 6000;
        }
        if (prevTs.threshold_strategy === undefined) prevTs.threshold_strategy = "adaptive";
        if (prevTs.context_budget_ratio === undefined) prevTs.context_budget_ratio = 0.05;
        merged.tool_search = prevTs;
      }
      root.runtime = merged;
      saveAgxConfig(cfg);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  // ── Automation Tasks CRUD ──

  ipcMain.handle("confirm-dialog", async (_event, payload: unknown) => {
    const p = (payload && typeof payload === "object")
      ? (payload as {
          title?: unknown;
          message?: unknown;
          detail?: unknown;
          confirmText?: unknown;
          cancelText?: unknown;
          destructive?: unknown;
        })
      : {};
    const title = String(p.title ?? "").trim() || "确认操作";
    const message = String(p.message ?? "").trim() || "请确认是否继续";
    const detail = String(p.detail ?? "").trim();
    const confirmText = String(p.confirmText ?? "").trim() || "确认";
    const cancelText = String(p.cancelText ?? "").trim() || "取消";
    const destructive = Boolean(p.destructive);
    try {
      const focused = BrowserWindow.getFocusedWindow() ?? mainWindow ?? null;
      const iconPath = app.isPackaged
        ? path.join(process.resourcesPath, "assets", "icon.png")
        : path.resolve(process.cwd(), "assets", "icon.png");
      // Destructive: use OS warning style (yellow triangle + exclamation on Windows/Linux; NSAlert
      // warning on macOS). Do not pass app icon — custom SVG rasterization often fails and falls
      // back to the app logo.
      const options: Electron.MessageBoxOptions = {
        type: destructive ? "warning" : "question",
        title,
        message,
        detail: detail || undefined,
        buttons: [cancelText, confirmText],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      };
      if (!destructive && fs.existsSync(iconPath)) {
        options.icon = nativeImage.createFromPath(iconPath);
      }
      const { response } = focused
        ? await dialog.showMessageBox(focused, options)
        : await dialog.showMessageBox(options);
      return { ok: true, confirmed: response === 1 };
    } catch (err) {
      return { ok: false, confirmed: false, error: String(err) };
    }
  });

  ipcMain.handle("export-messages-pdf", async (_event, payload: unknown) => {
    const p =
      payload && typeof payload === "object"
        ? (payload as { html?: unknown; defaultFileName?: unknown })
        : {};
    const html = typeof p.html === "string" ? p.html : "";
    const brandedPdfName = `${DESKTOP_PRODUCT_NAME}对话.pdf`;
    const defaultFileName = String(p.defaultFileName ?? brandedPdfName).trim() || brandedPdfName;
    if (!html) return { ok: false, canceled: false, error: "empty html" };

    const focused = BrowserWindow.getFocusedWindow() ?? mainWindow ?? null;
    const defaultPath = path.join(app.getPath("downloads"), defaultFileName);
    const saveRes = focused
      ? await dialog.showSaveDialog(focused, {
          defaultPath,
          filters: [{ name: "PDF", extensions: ["pdf"] }],
        })
      : await dialog.showSaveDialog({
          defaultPath,
          filters: [{ name: "PDF", extensions: ["pdf"] }],
        });
    if (saveRes.canceled || !saveRes.filePath) return { ok: true, canceled: true };

    const targetPath = saveRes.filePath;
    let tmpHtmlPath = "";
    let offscreen: BrowserWindow | null = null;
    try {
      tmpHtmlPath = path.join(
        os.tmpdir(),
        `agx-export-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.html`,
      );
      fs.writeFileSync(tmpHtmlPath, html, "utf-8");
      offscreen = new BrowserWindow({
        show: false,
        webPreferences: { javascript: false, sandbox: true, contextIsolation: true },
      });
      await offscreen.loadFile(tmpHtmlPath);
      // Give Chromium time to lay out tall markdown / inlined SVG before print.
      // 150ms was too short for large show_widget graphics and could drop trailing pages.
      await new Promise((resolve) => setTimeout(resolve, 400));
      const pdfBuffer = await offscreen.webContents.printToPDF({
        pageSize: "A4",
        printBackground: true,
        margins: { marginType: "default" },
      });
      fs.writeFileSync(targetPath, pdfBuffer);
      return { ok: true, canceled: false, path: targetPath };
    } catch (err) {
      return { ok: false, canceled: false, error: String(err).slice(0, 200) };
    } finally {
      if (offscreen && !offscreen.isDestroyed()) offscreen.destroy();
      if (tmpHtmlPath) {
        try {
          fs.unlinkSync(tmpHtmlPath);
        } catch {
          // ignore cleanup failures
        }
      }
    }
  });

  ipcMain.handle("load-automation-tasks", async () => {
    try {
      return { ok: true, tasks: loadAutomationTasks() };
    } catch (err) {
      return { ok: false, error: String(err), tasks: [] };
    }
  });

  ipcMain.handle("save-automation-task", async (_event, payload: unknown) => {
    if (!payload || typeof payload !== "object") return { ok: false, error: "invalid payload" };
    const task = payload as AutomationTaskData;
    const id = String(task.id ?? "").trim();
    const name = String(task.name ?? "").trim();
    if (!id || !name) return { ok: false, error: "task must have id and name" };
    task.id = id;
    task.name = name;
    const wsTrim = String(task.workspace ?? "").trim();
    // 未指定 workspace → 独占目录 crontask/<id>；指定 → 用户目录。执行时 task.workspace 会挂到会话 taskspace。
    if (!wsTrim) {
      const dir = defaultAutomationCrontaskPath(id);
      task.workspace = dir;
      try {
        fs.mkdirSync(AUTOMATION_CRONTASK_DIR, { recursive: true });
        fs.mkdirSync(dir, { recursive: true });
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    } else {
      try {
        fs.mkdirSync(wsTrim, { recursive: true });
      } catch {
        /* best-effort */
      }
    }
    try {
      const tasks = loadAutomationTasks();
      const idx = tasks.findIndex((t) => t.id === task.id);
      if (idx >= 0) {
        tasks[idx] = task;
      } else {
        tasks.unshift(task);
      }
      saveAutomationTasks(tasks);
      automationScheduler.reload();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle("delete-automation-task", async (_event, payload: unknown) => {
    let taskId = "";
    let removeCrontaskDir = false;
    if (typeof payload === "string") {
      taskId = payload.trim();
    } else if (payload && typeof payload === "object") {
      const p = payload as { taskId?: unknown; removeCrontaskDir?: unknown };
      taskId = String(p.taskId ?? "").trim();
      removeCrontaskDir = Boolean(p.removeCrontaskDir);
    }
    if (!taskId) return { ok: false, error: "taskId required" };
    try {
      if (removeCrontaskDir) {
        const crontaskPath = path.resolve(defaultAutomationCrontaskPath(taskId));
        const root = path.resolve(AUTOMATION_CRONTASK_DIR);
        if (fs.existsSync(crontaskPath) && crontaskPath !== root && crontaskPath.startsWith(root + path.sep)) {
          fs.rmSync(crontaskPath, { recursive: true, force: true });
        }
      }
      const tasks = loadAutomationTasks().filter((t) => t.id !== taskId);
      saveAutomationTasks(tasks);
      automationScheduler.reload();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle("automation-crontask-dir-info", async (_event, taskId: unknown) => {
    const id = typeof taskId === "string" ? taskId.trim() : "";
    if (!id) return { ok: false, path: "", exists: false };
    const p = defaultAutomationCrontaskPath(id);
    try {
      return { ok: true, path: p, exists: fs.existsSync(p) };
    } catch {
      return { ok: true, path: p, exists: false };
    }
  });

  ipcMain.handle("read-automation-task-log", async (_event, payload: unknown) => {
    let id = "";
    let tail = 200;
    if (typeof payload === "string") {
      id = payload.trim();
    } else if (payload && typeof payload === "object") {
      const p = payload as { taskId?: unknown; tail?: unknown };
      id = String(p.taskId ?? "").trim();
      const t = Number(p.tail ?? 200);
      if (Number.isFinite(t) && t > 0) tail = Math.min(2000, Math.floor(t));
    }
    if (!id) return { ok: false, error: "taskId required", path: "", lines: [] };
    const file = automationLogPath(id);
    try {
      if (!fs.existsSync(file)) {
        return { ok: true, path: file, lines: [], empty: true };
      }
      const raw = fs.readFileSync(file, "utf-8");
      const all = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
      const slice = all.slice(Math.max(0, all.length - tail));
      return { ok: true, path: file, lines: slice, truncated: all.length > slice.length };
    } catch (err) {
      return { ok: false, error: String(err), path: file, lines: [] };
    }
  });

  ipcMain.handle("cancel-automation-task-run", async (_event, taskId: unknown) => {
    const id = typeof taskId === "string" ? taskId.trim() : "";
    if (!id) return { ok: false, error: "taskId required" };
    automationRunUserCancelled.add(id);
    const c = automationRunControllers.get(id);
    if (c) {
      try {
        c.abort();
      } catch {
        /* ignore */
      }
    }
    return { ok: true };
  });

  ipcMain.handle("run-automation-task-now", async (_event, payload: unknown) => {
    let taskId = "";
    let sessionOverride = "";
    if (typeof payload === "string") {
      taskId = payload.trim();
    } else if (payload && typeof payload === "object") {
      const p = payload as { taskId?: unknown; sessionId?: unknown };
      taskId = String(p.taskId ?? "").trim();
      sessionOverride = String(p.sessionId ?? "").trim();
    }
    if (!taskId) return { ok: false, error: "taskId 无效" };
    try {
      const tasks = loadAutomationTasks();
      const task = tasks.find((t) => t.id === taskId);
      if (!task) return { ok: false, error: "未找到任务" };

      emitAutomationTaskProgress({
        taskId: task.id,
        taskName: task.name,
        trigger: "manual",
        phase: "queued",
        sessionId: undefined,
        ts: Date.now(),
      });
      const result = await runAutomationTaskHttp(task, {
        sessionIdOverride: sessionOverride || undefined,
        reusePersistedSession: Boolean(sessionOverride),
        onSessionReady: (newSid) => {
          emitAutomationTaskProgress({
            taskId: task.id,
            taskName: task.name,
            trigger: "manual",
            phase: "running",
            sessionId: newSid,
            ts: Date.now(),
          });
        },
      });

      task.lastRunAt = new Date().toISOString();
      task.lastRunStatus = result.ok ? "success" : "error";
      if (result.ok) {
        delete task.lastRunError;
      } else {
        task.lastRunError = sanitizeAutomationRunError(result.error) ?? "执行失败";
      }
      saveAutomationTasks(tasks);
      emitAutomationTaskProgress({
        taskId: task.id,
        taskName: task.name,
        trigger: "manual",
        phase: result.ok ? "success" : "error",
        sessionId: result.sessionId || resolveAutomationSessionId(task, sessionOverride) || undefined,
        message: result.error,
        ts: Date.now(),
      });

      return {
        ok: result.ok,
        error: result.ok ? undefined : (result.error ?? "执行失败"),
      };
    } catch (err) {
      const tasks = loadAutomationTasks();
      const task = tasks.find((t) => t.id === taskId);
      if (task) {
        task.lastRunStatus = "error";
        task.lastRunAt = new Date().toISOString();
        task.lastRunError = sanitizeAutomationRunError(err) ?? "执行异常";
        saveAutomationTasks(tasks);
      }
      const sidFromTask = task ? resolveAutomationSessionId(task, sessionOverride) : "";
      emitAutomationTaskProgress({
        taskId: taskId,
        taskName: task?.name ?? "自动化任务",
        trigger: "manual",
        phase: "error",
        sessionId: sidFromTask || undefined,
        message: String(err),
        ts: Date.now(),
      });
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle("load-skill-install-policy", async () => {
    const cfg = loadAgxConfig();
    return { ok: true, config: loadSkillInstallPolicyFromAgx(cfg) };
  });

  ipcMain.handle("save-skill-install-policy", async (_event, payload: unknown) => {
    if (!currentEnterpriseCapabilityPolicy().allow_local_skill_install) {
      return enterpriseCapabilityDeniedError("Skill");
    }
    if (!payload || typeof payload !== "object") return { ok: false, error: "invalid payload: object required" };
    const p = payload as { non_high_risk_auto_install?: unknown };
    let flag: boolean;
    try {
      flag = parseBooleanStrict(p.non_high_risk_auto_install, "non_high_risk_auto_install");
    } catch (err) {
      return { ok: false, error: String(err) };
    }
    try {
      const cfg = loadAgxConfig();
      const root = cfg as Record<string, unknown>;
      const prev = root.skills;
      const merged =
        prev && typeof prev === "object" && !Array.isArray(prev)
          ? { ...(prev as Record<string, unknown>) }
          : {};
      merged.non_high_risk_auto_install = flag;
      root.skills = merged;
      saveAgxConfig(cfg);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle("save-email-config", async (_event, payload: unknown) => {
    const checked = validateEmailConfigPayload(payload);
    if (!checked.ok) return { ok: false, error: checked.error };
    try {
      const cfg = loadAgxConfig();
      const nextNotifications = { ...(cfg.notifications ?? {}) };
      nextNotifications.email = { ...checked.config };
      cfg.notifications = nextNotifications;
      saveAgxConfig(cfg);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: "config_write_failed" };
    }
  });

  ipcMain.handle("test-email-config", async (_event, payload: { config?: unknown; toEmail?: string }) => {
    const checked = validateEmailConfigPayload(payload?.config ?? {});
    if (!checked.ok) return { ok: false, error: checked.error };
    const toEmail = String(payload?.toEmail ?? checked.config.default_to_email).trim() || checked.config.default_to_email;
    try {
      const resp = await fetch(`${getStudioUrl()}/api/test-email`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-agx-desktop-token": getStudioToken(),
        },
        body: JSON.stringify({
          config: checked.config,
          to_email: toEmail,
        }),
      });
      if (!resp.ok) {
        return { ok: false, error: `HTTP ${resp.status}: email_test_failed` };
      }
      return await resp.json();
    } catch {
      return { ok: false, error: "email_test_request_failed" };
    }
  });

  ipcMain.handle("load-mcp-status", async (_event, sessionId: string) => {
    const sid = String(sessionId || "").trim();
    // Empty sid is allowed: backend falls back to process-level configs so the
    // Settings panel can render before any session is bound (FR-2).
    try {
      const resp = await fetch(
        `${getStudioUrl()}/api/mcp/servers?session_id=${encodeURIComponent(sid)}`,
        {
          headers: { "x-agx-desktop-token": getStudioToken() },
        }
      );
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        return { ok: false, error: `HTTP ${resp.status}: ${body.slice(0, 300)}`, servers: [] };
      }
      return await resp.json();
    } catch (err) {
      return { ok: false, error: String(err), servers: [] };
    }
  });

  ipcMain.handle("import-mcp-config", async (_event, payload: { sessionId: string; sourcePath: string }) => {
    if (!currentEnterpriseCapabilityPolicy().allow_local_mcp_install) {
      return enterpriseCapabilityDeniedError("MCP");
    }
    const sid = String(payload?.sessionId || "").trim();
    const sourcePath = String(payload?.sourcePath || "").trim();
    if (!sid || !sourcePath) return { ok: false, error: "sessionId and sourcePath are required" };
    try {
      const resp = await fetch(`${getStudioUrl()}/api/mcp/import`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-agx-desktop-token": getStudioToken(),
        },
        body: JSON.stringify({ session_id: sid, source_path: sourcePath }),
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        return { ok: false, error: `HTTP ${resp.status}: ${body.slice(0, 300)}` };
      }
      return await resp.json();
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle("connect-mcp", async (_event, payload: { sessionId: string; name: string }) => {
    const sid = String(payload?.sessionId || "").trim();
    const name = String(payload?.name || "").trim();
    if (!sid || !name) return { ok: false, error: "sessionId and name are required" };
    try {
      const resp = await fetch(`${getStudioUrl()}/api/mcp/connect`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-agx-desktop-token": getStudioToken(),
        },
        body: JSON.stringify({ session_id: sid, name }),
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        return { ok: false, error: `HTTP ${resp.status}: ${body.slice(0, 300)}` };
      }
      return await resp.json();
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle("get-mcp-settings", async () => {
    try {
      const resp = await fetch(`${getStudioUrl()}/api/mcp/settings`, {
        headers: { "x-agx-desktop-token": getStudioToken() },
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        return { ok: false, error: `HTTP ${resp.status}: ${body.slice(0, 300)}` };
      }
      return await resp.json();
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle(
    "put-mcp-settings",
    async (
      _event,
      payload: {
        extraSearchPaths: string[];
        disabledTools?: Record<string, string[]>;
        skipDefaultNames?: string[];
      },
    ) => {
    const policy = currentEnterpriseCapabilityPolicy();
    const body: Record<string, unknown> = {};
    if (policy.allow_local_mcp_install) {
      body.extra_search_paths = Array.isArray(payload?.extraSearchPaths)
        ? payload.extraSearchPaths
        : [];
    }
    if (payload?.disabledTools !== undefined) {
      body.disabled_tools = payload.disabledTools;
    }
    if (policy.allow_local_mcp_install && payload?.skipDefaultNames !== undefined) {
      body.skip_default_names = payload.skipDefaultNames;
    }
    try {
      const resp = await fetch(`${getStudioUrl()}/api/mcp/settings`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "x-agx-desktop-token": getStudioToken(),
        },
        body: JSON.stringify(body),
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        return { ok: false, error: `HTTP ${resp.status}: ${body.slice(0, 300)}` };
      }
      return await resp.json();
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  },
  );

  ipcMain.handle("mcp-discover", async () => {
    if (!currentEnterpriseCapabilityPolicy().allow_mcp_auto_discovery) {
      return { ok: false, error: "企业管理员已关闭本机 MCP 自动发现", items: [], count: 0 };
    }
    try {
      const resp = await fetch(`${getStudioUrl()}/api/mcp/discover`, {
        headers: { "x-agx-desktop-token": getStudioToken() },
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        return { ok: false, error: `HTTP ${resp.status}: ${body.slice(0, 300)}` };
      }
      return await resp.json();
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle("mcp-get-raw", async (_event, payload?: { path?: string }) => {
    const path = String(payload?.path || "").trim();
    const q = path ? `?path=${encodeURIComponent(path)}` : "";
    try {
      const resp = await fetch(`${getStudioUrl()}/api/mcp/raw${q}`, {
        headers: { "x-agx-desktop-token": getStudioToken() },
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        return { ok: false, error: `HTTP ${resp.status}: ${body.slice(0, 300)}` };
      }
      return await resp.json();
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle("mcp-put-raw", async (_event, payload: { path: string; text: string }) => {
    if (!currentEnterpriseCapabilityPolicy().allow_local_mcp_install) {
      return enterpriseCapabilityDeniedError("MCP");
    }
    try {
      const resp = await fetch(`${getStudioUrl()}/api/mcp/raw`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "x-agx-desktop-token": getStudioToken(),
        },
        body: JSON.stringify({
          path: String(payload?.path || "").trim(),
          text: String(payload?.text || ""),
        }),
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        return { ok: false, error: `HTTP ${resp.status}: ${body.slice(0, 300)}` };
      }
      return await resp.json();
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle(
    "mcp-gateway-registry",
    async (_event, payload: { baseUrl: string; token: string }) => {
      const base = String(payload?.baseUrl || "")
        .trim()
        .replace(/\/+$/, "");
      const token = String(payload?.token || "").trim();
      if (!base) return { ok: false, error: "missing baseUrl" };
      if (!token) return { ok: false, error: "missing token" };
      try {
        const resp = await proxyAwareFetch(`${base}/mcp/registry`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const text = await resp.text();
        if (!resp.ok) {
          return { ok: false, error: `HTTP ${resp.status}: ${text.slice(0, 300)}` };
        }
        let data: unknown;
        try {
          data = JSON.parse(text);
        } catch {
          return { ok: false, error: "registry response is not JSON" };
        }
        return { ok: true, data };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    },
  );

  ipcMain.handle(
    "mcp-marketplace-list",
    async (
      _event,
      payload?: {
        category?: string;
        search?: string;
        page?: number;
        pageSize?: number;
        isHosted?: boolean;
        isVerified?: boolean;
      },
    ) => {
      const qs = new URLSearchParams();
      if (payload?.category) qs.set("category", String(payload.category));
      if (payload?.search) qs.set("search", String(payload.search));
      if (payload?.page != null) qs.set("page", String(payload.page));
      if (payload?.pageSize != null) qs.set("page_size", String(payload.pageSize));
      if (payload?.isHosted != null) qs.set("is_hosted", String(payload.isHosted));
      if (payload?.isVerified != null) qs.set("is_verified", String(payload.isVerified));
      const suffix = qs.toString() ? `?${qs.toString()}` : "";
      try {
        const resp = await fetch(`${getStudioUrl()}/api/mcp/marketplace${suffix}`, {
          headers: { "x-agx-desktop-token": getStudioToken() },
        });
        if (!resp.ok) {
          const body = await resp.text().catch(() => "");
          return { ok: false, error: `HTTP ${resp.status}: ${body.slice(0, 300)}` };
        }
        return await resp.json();
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    },
  );

  ipcMain.handle("mcp-marketplace-detail", async (_event, payload: { serverId: string }) => {
    const sid = String(payload?.serverId || "").trim();
    if (!sid) return { ok: false, error: "serverId is required" };
    try {
      const resp = await fetch(`${getStudioUrl()}/api/mcp/marketplace/${encodeURIComponent(sid)}`, {
        headers: { "x-agx-desktop-token": getStudioToken() },
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        return { ok: false, error: `HTTP ${resp.status}: ${body.slice(0, 300)}` };
      }
      return await resp.json();
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle(
    "mcp-marketplace-install",
    async (_event, payload: { serverId: string; env?: Record<string, string> }) => {
      if (!currentEnterpriseCapabilityPolicy().allow_local_mcp_install) {
        return enterpriseCapabilityDeniedError("MCP");
      }
      const sid = String(payload?.serverId || "").trim();
      if (!sid) return { ok: false, error: "serverId is required" };
      try {
        const resp = await fetch(`${getStudioUrl()}/api/mcp/marketplace/install`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-agx-desktop-token": getStudioToken(),
          },
          body: JSON.stringify({
            server_id: sid,
            env: payload?.env ?? {},
          }),
        });
        if (!resp.ok) {
          const body = await resp.text().catch(() => "");
          return { ok: false, error: `HTTP ${resp.status}: ${body.slice(0, 300)}` };
        }
        return await resp.json();
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    },
  );

  ipcMain.handle("resolve-local-path", async (_event, inputPath: string) => {
    try {
      const resolvedPath = expandDesktopLocalPath(inputPath);
      if (!resolvedPath) return { ok: false, error: "empty path" };
      if (!fs.existsSync(resolvedPath)) {
        return { ok: false, error: "path not found", resolvedPath };
      }
      const stat = await fs.promises.stat(resolvedPath);
      return {
        ok: true,
        resolvedPath,
        isDirectory: stat.isDirectory(),
        isFile: stat.isFile(),
      };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle("shell-open-path", async (_event, pathValue: string) => {
    const target = expandDesktopLocalPath(pathValue);
    if (!target) return { ok: false, error: "path is required" };
    try {
      const err = await shell.openPath(target);
      if (err) return { ok: false, error: err };
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  });

  /**
   * Trae-style「打开开发者工具」for local HTML preview (iframe srcDoc cannot host
   * guest DevTools). Loads the file in a dedicated window and opens detached DevTools.
   */
  let htmlPreviewInspectWindow: BrowserWindow | null = null;
  ipcMain.handle("html-preview-open-devtools", async (_event, payload: unknown) => {
    const body =
      payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
    const rawPath = String(body.path ?? "").trim();
    const rawUrl = String(body.url ?? "").trim();
    let targetUrl = "";
    if (rawPath) {
      const fsPath = expandDesktopLocalPath(rawPath);
      if (!fsPath || !fs.existsSync(fsPath)) {
        return { ok: false, error: "file not found" };
      }
      targetUrl = pathToFileURL(fsPath).href;
    } else if (/^https?:\/\//i.test(rawUrl)) {
      targetUrl = rawUrl;
    } else {
      return { ok: false, error: "path or http(s) url required" };
    }

    try {
      if (htmlPreviewInspectWindow && !htmlPreviewInspectWindow.isDestroyed()) {
        const current = htmlPreviewInspectWindow.webContents.getURL();
        if (current !== targetUrl) {
          await htmlPreviewInspectWindow.loadURL(targetUrl);
        }
        if (!htmlPreviewInspectWindow.webContents.isDevToolsOpened()) {
          htmlPreviewInspectWindow.webContents.openDevTools({ mode: "detach" });
        }
        htmlPreviewInspectWindow.show();
        htmlPreviewInspectWindow.focus();
        return { ok: true };
      }

      htmlPreviewInspectWindow = new BrowserWindow({
        width: 1100,
        height: 800,
        show: true,
        title: "HTML Preview",
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
        },
      });
      htmlPreviewInspectWindow.on("closed", () => {
        htmlPreviewInspectWindow = null;
      });
      await htmlPreviewInspectWindow.loadURL(targetUrl);
      htmlPreviewInspectWindow.webContents.openDevTools({ mode: "detach" });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  });

  ipcMain.handle("shell-show-item-in-folder", async (_event, fullPath: string) => {
    const fsPath = expandDesktopLocalPath(fullPath);
    if (!fsPath) return { ok: false, error: "path is required" };
    try {
      shell.showItemInFolder(fsPath);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  });

  ipcMain.handle("copy-local-file-as", async (_event, payload: unknown) => {
    const body =
      payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
    const source = normalizeLocalFsPath(String(body.sourcePath ?? ""));
    if (!source) return { ok: false, error: "source is required" };
    try {
      if (!fs.existsSync(source)) return { ok: false, error: "source is not a file" };
      const stat = await fs.promises.stat(source);
      if (!stat.isFile()) return { ok: false, error: "source is not a file" };
    } catch (error) {
      return { ok: false, error: String(error) };
    }

    const focused = BrowserWindow.getFocusedWindow() ?? mainWindow ?? null;
    const defaultPath = path.join(app.getPath("downloads"), path.basename(source));
    const saveResult = focused
      ? await dialog.showSaveDialog(focused, { defaultPath })
      : await dialog.showSaveDialog({ defaultPath });
    if (saveResult.canceled || !saveResult.filePath) {
      return { ok: true, canceled: true };
    }
    try {
      await fs.promises.copyFile(source, saveResult.filePath);
      return { ok: true, canceled: false, path: saveResult.filePath };
    } catch (error) {
      return { ok: false, canceled: false, error: String(error) };
    }
  });

  ipcMain.handle("get-skill-settings", async () => {
    try {
      const resp = await fetchStudioBackend("/api/skills/settings");
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        return { ok: false, error: `HTTP ${resp.status}: ${body.slice(0, 300)}` };
      }
      return await resp.json();
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle("get-guard-settings", async () => {
    try {
      const resp = await fetchStudioBackend("/api/skills/guard-settings");
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        return { ok: false, error: `HTTP ${resp.status}: ${body.slice(0, 300)}` };
      }
      return await resp.json();
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle(
    "put-guard-settings",
    async (_event, payload: { version?: number; scan_mode?: string; llm_verify?: boolean }) => {
      try {
        const resp = await fetch(`${getStudioUrl()}/api/skills/guard-settings`, {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            "x-agx-desktop-token": getStudioToken(),
          },
          body: JSON.stringify(payload ?? {}),
        });
        if (!resp.ok) {
          const body = await resp.text().catch(() => "");
          return { ok: false, error: `HTTP ${resp.status}: ${body.slice(0, 300)}` };
        }
        return await resp.json();
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    },
  );

  ipcMain.handle(
    "guard-scan-skill",
    async (
      _event,
      payload: { skill_path?: string; markdown?: string; skill_name?: string; mode?: string },
    ) => {
      try {
        const resp = await fetch(`${getStudioUrl()}/api/skills/guard-scan`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-agx-desktop-token": getStudioToken(),
          },
          body: JSON.stringify({ ...payload, html_report: false }),
        });
        if (!resp.ok) {
          const body = await resp.text().catch(() => "");
          return { ok: false, error: `HTTP ${resp.status}: ${body.slice(0, 300)}` };
        }
        return await resp.json();
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    },
  );

  ipcMain.handle(
    "guard-scan-all",
    async (_event, payload?: { include_ignored?: boolean }) => {
      try {
        const resp = await fetch(`${getStudioUrl()}/api/skills/guard-scan-all`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-agx-desktop-token": getStudioToken(),
          },
          body: JSON.stringify(payload ?? {}),
        });
        if (!resp.ok) {
          const body = await resp.text().catch(() => "");
          return { ok: false, error: `HTTP ${resp.status}: ${body.slice(0, 300)}` };
        }
        return await resp.json();
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    },
  );

  ipcMain.handle(
    "skill-snapshot",
    async (
      _event,
      payload: { base_dir?: string; trigger?: string; skill_name?: string },
    ) => {
      try {
        const resp = await fetch(`${getStudioUrl()}/api/skills/snapshot`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-agx-desktop-token": getStudioToken(),
          },
          body: JSON.stringify(payload ?? {}),
        });
        if (!resp.ok) {
          const body = await resp.text().catch(() => "");
          return { ok: false, error: `HTTP ${resp.status}: ${body.slice(0, 300)}` };
        }
        return await resp.json();
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    },
  );

  ipcMain.handle(
    "skill-snapshots-list",
    async (_event, payload: { base_dir?: string }) => {
      try {
        const base = encodeURIComponent(String(payload?.base_dir ?? ""));
        const resp = await fetch(
          `${getStudioUrl()}/api/skills/snapshots?base_dir=${base}`,
          {
            headers: { "x-agx-desktop-token": getStudioToken() },
          },
        );
        if (!resp.ok) {
          const body = await resp.text().catch(() => "");
          return { ok: false, error: `HTTP ${resp.status}: ${body.slice(0, 300)}` };
        }
        return await resp.json();
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    },
  );

  ipcMain.handle(
    "skill-snapshot-restore",
    async (_event, payload: { base_dir?: string; snapshot_id?: string }) => {
      try {
        const resp = await fetch(`${getStudioUrl()}/api/skills/snapshot/restore`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-agx-desktop-token": getStudioToken(),
          },
          body: JSON.stringify(payload ?? {}),
        });
        if (!resp.ok) {
          const body = await resp.text().catch(() => "");
          return { ok: false, error: `HTTP ${resp.status}: ${body.slice(0, 300)}` };
        }
        return await resp.json();
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    },
  );

  ipcMain.handle(
    "put-skill-settings",
    async (
      _event,
      payload: {
        presetPaths: Array<{ id: string; enabled: boolean }>;
        customPaths: Array<{ path: string; enabled: boolean } | string>;
        preferredSources?: Record<string, string>;
        disabledSkills?: string[];
      },
    ) => {
      const preset_paths = Array.isArray(payload?.presetPaths) ? payload.presetPaths : [];
      const custom_paths = Array.isArray(payload?.customPaths) ? payload.customPaths : [];
      const preferred_sources =
        payload?.preferredSources && typeof payload.preferredSources === "object"
          ? payload.preferredSources
          : {};
      const body: Record<string, unknown> = { preset_paths, custom_paths, preferred_sources };
      if (Array.isArray(payload?.disabledSkills)) {
        body.disabled_skills = payload.disabledSkills;
      }
      try {
        const resp = await fetch(`${getStudioUrl()}/api/skills/settings`, {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            "x-agx-desktop-token": getStudioToken(),
          },
          body: JSON.stringify(body),
        });
        if (!resp.ok) {
          const body = await resp.text().catch(() => "");
          return { ok: false, error: `HTTP ${resp.status}: ${body.slice(0, 300)}` };
        }
        return await resp.json();
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    },
  );

  ipcMain.handle("disconnect-mcp", async (_event, payload: { sessionId: string; name: string }) => {
    const sid = String(payload?.sessionId || "").trim();
    const name = String(payload?.name || "").trim();
    if (!sid || !name) return { ok: false, error: "sessionId and name are required" };
    try {
      const resp = await fetch(`${getStudioUrl()}/api/mcp/disconnect`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-agx-desktop-token": getStudioToken(),
        },
        body: JSON.stringify({ session_id: sid, name }),
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        return { ok: false, error: `HTTP ${resp.status}: ${body.slice(0, 300)}` };
      }
      return await resp.json();
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle("save-onboarding-completed", async (_event, completed: boolean) => {
    const cfg = loadAgxConfig();
    cfg.onboarding_completed = completed;
    saveAgxConfig(cfg);
    return { ok: true };
  });

  ipcMain.handle("save-provider", async (_event, payload: {
    name: string;
    apiKey?: string;
    baseUrl?: string;
    model?: string;
    models?: string[];
    enabled?: boolean;
    dropParams?: boolean;
    displayName?: string;
    interface?: "openai" | "ollama";
    managed?: boolean;
  }) => {
    if (isRemoteMode()) {
      const r = await studioFetchJson(
        `/api/config/providers/${encodeURIComponent(payload.name)}`,
        { method: "PUT", body: payload },
      );
      return r.ok ? { ok: true } : { ok: false, error: r.error || "remote save-provider failed" };
    }
    const cfg = loadAgxConfig();
    if (!cfg.providers) cfg.providers = {};
    const prev = cfg.providers[payload.name] ?? {};
    // Managed enterprise provider: keep credential/base_url/models owned by enterprise-login/refresh.
    if (prev.managed === true || payload.managed === true) {
      const managedModels = Array.isArray(prev.models) ? prev.models : [];
      const requestedModel = String(payload.model ?? "").trim();
      if (requestedModel && !managedModels.includes(requestedModel)) {
        return { ok: false, error: "所选企业模型不在组织下发的可用列表中" };
      }
      const selectedModel = resolveEnterpriseModelSelection(
        managedModels,
        requestedModel || prev.model,
      );
      const nextManaged: ProviderConfig = {
        ...prev,
        managed: true,
        interface: prev.interface ?? "openai",
        display_name: prev.display_name ?? "企业模型",
        enabled: payload.enabled === false ? false : true,
        model: selectedModel,
      };
      if (payload.dropParams === true) nextManaged.drop_params = true;
      else if (payload.dropParams === false) delete nextManaged.drop_params;
      cfg.providers[payload.name] = nextManaged;
      if (cfg.active_provider === payload.name && selectedModel) {
        cfg.active_model = selectedModel;
      }
      saveAgxConfig(cfg);
      return { ok: true };
    }
    const next: ProviderConfig = {
      ...prev,
      api_key: payload.apiKey ?? prev.api_key,
      base_url: payload.baseUrl ?? prev.base_url,
      model: payload.model ?? prev.model,
      models: payload.models ?? prev.models,
    };
    if (payload.enabled === true || payload.enabled === false) {
      next.enabled = payload.enabled;
    } else if (typeof next.enabled !== "boolean") {
      next.enabled = true;
    }
    if (payload.dropParams === true) {
      next.drop_params = true;
    } else if (payload.dropParams === false) {
      delete next.drop_params;
    }
    if (payload.displayName !== undefined) {
      if (payload.displayName) next.display_name = payload.displayName;
      else delete next.display_name;
    }
    if (payload.interface !== undefined) {
      if (payload.interface === "openai" || payload.interface === "ollama") {
        next.interface = payload.interface;
      } else {
        delete next.interface;
      }
    }
    cfg.providers[payload.name] = next;
    saveAgxConfig(cfg);
    return { ok: true };
  });

  ipcMain.handle("set-default-provider", async (_event, name: string) => {
    if (isRemoteMode()) {
      const r = await studioFetchJson("/api/config/default-provider", {
        method: "PUT",
        body: { name },
      });
      return r.ok ? { ok: true } : { ok: false, error: r.error || "remote set-default failed" };
    }
    const cfg = loadAgxConfig();
    cfg.default_provider = name;
    saveAgxConfig(cfg);
    return { ok: true };
  });

  ipcMain.handle("delete-provider", async (_event, name: string) => {
    if (isRemoteMode()) {
      const r = await studioFetchJson(
        `/api/config/providers/${encodeURIComponent(name)}`,
        { method: "DELETE" },
      );
      return r.ok ? { ok: true } : { ok: false, error: r.error || "remote delete-provider failed" };
    }
    const cfg = loadAgxConfig();
    if (cfg.providers?.[name]?.managed === true) {
      return { ok: false, error: "企业托管模型不可删除，请先退出企业登录" };
    }
    if (cfg.providers) delete cfg.providers[name];
    if (cfg.default_provider === name) cfg.default_provider = Object.keys(cfg.providers ?? {})[0] ?? "";
    saveAgxConfig(cfg);
    return { ok: true };
  });

  ipcMain.handle("validate-key", async (_event, payload: {
    provider: string;
    apiKey: string;
    baseUrl?: string;
  }) => {
    if (isOllamaLikeProvider(payload.provider)) {
      const rawBase = payload.baseUrl || "http://localhost:11434";
      const tags = await fetchOllamaModelNames(rawBase);
      return tags.ok ? { ok: true } : { ok: false, error: tags.error ?? "Ollama 连通性检测失败" };
    }
    const apiKey = normalizeProviderApiKey(payload.apiKey);
    const base = resolveOpenAiCompatApiBase(payload.provider, payload.baseUrl);
    if (!base) return { ok: false, error: "未知 provider，请填写 API 地址" };
    const isMinimax = payload.provider === "minimax";
    const customBase = usesCustomBaseUrl(payload.provider, payload.baseUrl);
    if (isMinimax) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10000);
        const resp = await proxyAwareFetch(`${base}/chat/completions`, {
          method: "POST",
          headers: {
            ...openAiCompatAuthHeaders(apiKey),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "MiniMax-M2.5",
            messages: [{ role: "user", content: "hi" }],
            max_tokens: 1,
          }),
          signal: controller.signal,
        });
        clearTimeout(timer);
        if (resp.ok) return { ok: true, status: resp.status };
        const body = await resp.text().catch(() => "");
        return { ok: false, error: `HTTP ${resp.status}: ${body.slice(0, 200)}` };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    }
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      const resp = await proxyAwareFetch(`${base}/models`, {
        headers: openAiCompatAuthHeaders(apiKey),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (resp.ok) return { ok: true, status: resp.status };
      const body = await resp.text().catch(() => "");
      if (isModelsCatalogMissing(resp.status, body) || (customBase && !apiKey)) {
        const probe = await probeOpenAiCompatChatReachable(base, apiKey);
        if (probe.ok) {
          return {
            ok: true,
            status: resp.status,
            warning: "网关未提供 /models 列表，连通性正常；请用 + 手动添加模型 ID",
          };
        }
        return { ok: false, error: probe.error ?? `HTTP ${resp.status}: ${body.slice(0, 200)}` };
      }
      return { ok: false, error: `HTTP ${resp.status}: ${body.slice(0, 200)}` };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle(
    "fetch-favicon",
    async (
      _event,
      payload: { url?: string; domain?: string; size?: number },
    ) => fetchFaviconDataUrl(payload ?? {}),
  );

  ipcMain.handle("fetch-models", async (_event, payload: {
    provider: string;
    apiKey: string;
    baseUrl?: string;
  }) => {
    if (isOllamaLikeProvider(payload.provider)) {
      const rawBase = payload.baseUrl || "http://localhost:11434";
      const tags = await fetchOllamaModelNames(rawBase);
      if (!tags.ok) {
        return { ok: false, models: [], error: tags.error ?? "拉取 Ollama 模型失败" };
      }
      return { ok: true, models: (tags.models ?? []).sort() };
    }
    const apiKey = normalizeProviderApiKey(payload.apiKey);
    const base = resolveOpenAiCompatApiBase(payload.provider, payload.baseUrl);
    if (!base) return { ok: false, models: [], error: "未知 API 地址" };
    const url = `${base}/models`;
    // DashScope/Bailian compatible-mode `/models` omits embedding SKUs; merge
    // the documented vector models so they show up (and get an "嵌入" badge).
    const embeddingExtras = isBailianLikeRequest(payload.provider, base)
      ? BAILIAN_EMBEDDING_MODELS
      : [];
    const vlmExtras = isZhipuLikeRequest(payload.provider, base) ? ZHIPU_DOCUMENTED_VLM_MODELS : [];
    const catalogExtras = [...embeddingExtras, ...vlmExtras];
    const mergeCatalogExtras = (models: string[]): string[] =>
      Array.from(new Set([...models, ...catalogExtras]));
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      const resp = await proxyAwareFetch(url, {
        headers: openAiCompatAuthHeaders(apiKey),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        const fallback = PROVIDER_FALLBACK_MODELS[payload.provider];
        if (resp.status === 404 && Array.isArray(fallback) && fallback.length > 0) {
          return { ok: true, models: mergeCatalogExtras(fallback) };
        }
        if (catalogExtras.length > 0) {
          // Even if the catalog endpoint fails, expose known extras so users can configure them.
          return { ok: true, models: mergeCatalogExtras([]) };
        }
        if (isModelsCatalogMissing(resp.status, body)) {
          return {
            ok: true,
            models: [],
            warning: "该网关未提供 /models 接口，请使用 + 手动添加模型 ID",
          };
        }
        return { ok: false, models: [], error: `HTTP ${resp.status}` };
      }
      const bodyText = await resp.text().catch(() => "");
      let data: { data?: Array<{ id?: string; model?: string; name?: string }>; has_more?: boolean; last_id?: string };
      try {
        data = JSON.parse(bodyText) as typeof data;
      } catch {
        const hint = bodyText.trimStart().startsWith("<")
          ? "API 返回了 HTML 而非 JSON，请确认 API 地址（多数 OpenAI 兼容网关需以 /v1 结尾）"
          : `响应解析失败: ${bodyText.slice(0, 120)}`;
        return { ok: false, models: [], error: hint };
      }
      const models = (data.data ?? [])
        .map((m) => String(m.id ?? m.model ?? m.name ?? "").trim())
        .filter(Boolean);
      return { ok: true, models: mergeCatalogExtras(models).sort() };
    } catch (err) {
      return { ok: false, models: [], error: String(err) };
    }
  });

  ipcMain.handle("health-check-model", async (_event, payload: {
    provider: string;
    apiKey: string;
    baseUrl?: string;
    model: string;
  }) => {
    const apiKey = normalizeProviderApiKey(payload.apiKey);
    const base = resolveOpenAiCompatApiBase(payload.provider, payload.baseUrl);
    if (!base) return { ok: false, error: "未知 API 地址" };
    // Embedding models reject /chat/completions; probe them via /embeddings so
    // health check does not falsely report failure for vector models.
    const isEmbedding = isEmbeddingModelId(payload.model);
    const url = isEmbedding ? `${base}/embeddings` : `${base}/chat/completions`;
    const body = isEmbedding
      ? JSON.stringify({ model: payload.model, input: "hi" })
      : JSON.stringify({
          model: payload.model,
          messages: [{ role: "user", content: "hi" }],
          // `max_tokens: 1` triggers false negatives on some OpenAI-compatible
          // GPT-5 gateways; use a small but safe floor for probe requests.
          max_tokens: 16,
        });
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      const t0 = performance.now();
      const resp = await proxyAwareFetch(url, {
        method: "POST",
        headers: {
          ...openAiCompatAuthHeaders(apiKey),
          "Content-Type": "application/json",
        },
        body,
        signal: controller.signal,
      });
      clearTimeout(timer);
      const latencyMs = Math.round(performance.now() - t0);
      if (resp.ok) return { ok: true, latencyMs };
      const errBody = await resp.text().catch(() => "");
      if (!isEmbedding && isChatProbeTokenLimitFalseNegative(resp.status, errBody)) {
        return { ok: true, latencyMs };
      }
      const reason = classifyModelHealthFailure(resp.status, errBody);
      return {
        ok: false,
        error: `HTTP ${resp.status}: ${errBody.slice(0, 200)}`,
        reason,
      };
    } catch (err) {
      return { ok: false, error: String(err), reason: "error" as const };
    }
  });

  // Legacy compatibility
  ipcMain.handle("save-config", async (_event, payload: { provider?: string; model?: string; apiKey?: string; activeProvider?: string; activeModel?: string }) => {
    if (isRemoteMode()) {
      const name = (payload.provider || "").trim();
      if (name && (payload.apiKey || payload.model)) {
        const providerResult = await studioFetchJson(`/api/config/providers/${encodeURIComponent(name)}`, {
          method: "PUT",
          body: {
            apiKey: payload.apiKey,
            model: payload.model,
          },
        });
        if (!providerResult.ok) {
          return { ok: false, path: "remote", error: providerResult.error ?? `HTTP ${providerResult.status}` };
        }
        const defaultProviderResult = await studioFetchJson("/api/config/default-provider", {
          method: "PUT",
          body: { name },
        });
        if (!defaultProviderResult.ok) {
          return { ok: false, path: "remote", error: defaultProviderResult.error ?? `HTTP ${defaultProviderResult.status}` };
        }
      }
      if (payload.activeProvider || payload.activeModel) {
        const activeModelResult = await studioFetchJson("/api/config/active-model", {
          method: "PUT",
          body: { provider: payload.activeProvider, model: payload.activeModel },
        });
        if (!activeModelResult.ok) {
          return { ok: false, path: "remote", error: activeModelResult.error ?? `HTTP ${activeModelResult.status}` };
        }
      }
      return { ok: true, path: "remote" };
    }
    const cfg = loadAgxConfig();
    const name = payload.provider || cfg.default_provider || "openai";
    if (!cfg.providers) cfg.providers = {};
    const prev = cfg.providers[name] ?? {};
    cfg.providers[name] = { ...prev };
    if (payload.apiKey) cfg.providers[name].api_key = payload.apiKey;
    if (payload.model) cfg.providers[name].model = payload.model;
    cfg.default_provider = name;
    if (payload.activeProvider) cfg.active_provider = payload.activeProvider;
    if (payload.activeModel) cfg.active_model = payload.activeModel;
    saveAgxConfig(cfg);
    return { ok: true, path: CONFIG_PATH };
  });

  ipcMain.handle("native-say", async (_event, text: string) => {
    if (process.platform !== "darwin") {
      return { ok: false, reason: "not-macos" };
    }
    await new Promise<void>((resolve) => {
      execFile("say", ["-v", "Ting-Ting", text], () => resolve());
    });
    return { ok: true };
  });

  ipcMain.handle("load-workspace-config", async () => {
    try {
      const cfg = loadAgxConfig();
      return {
        ok: true,
        workspaceDir: resolveConfigWorkspaceDirRaw(cfg),
        resolvedPath: resolveMetaWorkspaceDir(cfg),
      };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle("save-workspace-config", async (_event, payload: { workspaceDir?: string }) => {
    try {
      const trimmed = String(payload?.workspaceDir ?? "").trim();
      if (!trimmed) return { ok: false, error: "工作区路径不能为空" };
      const resolved = path.resolve(expandDesktopLocalPath(trimmed));
      if (!resolved) return { ok: false, error: "无效路径" };
      await fs.promises.mkdir(resolved, { recursive: true });
      const cfg = loadAgxConfig();
      const previous = resolveConfigWorkspaceDirRaw(cfg);
      cfg.workspace_dir = trimmed;
      saveAgxConfig(cfg);
      return {
        ok: true,
        workspaceDir: trimmed,
        resolvedPath: resolved,
        changed: previous !== trimmed,
      };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle("load-meta-soul", async () => {
    try {
      return { ok: true, content: loadSoulFile(metaWorkspaceMarkdownPath("SOUL.md")) };
    } catch (err) {
      return { ok: false, content: "", error: String(err) };
    }
  });

  ipcMain.handle("save-meta-soul", async (_event, payload: { content?: string }) => {
    try {
      saveMetaWorkspaceMarkdown("soul", String(payload?.content ?? ""));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle("load-meta-identity", async () => {
    try {
      return { ok: true, content: loadSoulFile(metaWorkspaceMarkdownPath("IDENTITY.md")) };
    } catch (err) {
      return { ok: false, content: "", error: String(err) };
    }
  });

  ipcMain.handle("save-meta-identity", async (_event, payload: { content?: string }) => {
    try {
      saveMetaWorkspaceMarkdown("identity", String(payload?.content ?? ""));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle(
    "ai-assist-complete",
    async (
      _event,
      payload: {
        systemPrompt: string;
        userPrompt: string;
        provider?: string;
        apiKey?: string;
        baseUrl?: string;
        model?: string;
      },
    ) => {
      const provider = String(payload?.provider ?? "").trim();
      const apiKey = normalizeProviderApiKey(payload?.apiKey);
      const baseUrl = (payload?.baseUrl ?? "").trim().replace(/\/+$/, "");
      const model = String(payload?.model ?? "").trim();
      const base =
        baseUrl || (provider ? (KNOWN_BASE_URLS[provider] ?? "") : "") || "";
      if (!base) return { ok: false, error: "未配置 API 地址，请先在设置中完成模型提供商配置。" };
      const url = `${base}/chat/completions`;
      const body = JSON.stringify({
        model: model || "gpt-4o-mini",
        messages: [
          { role: "system", content: String(payload?.systemPrompt ?? "") },
          { role: "user", content: String(payload?.userPrompt ?? "") },
        ],
        max_tokens: 1024,
        stream: false,
      });
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 60000);
        const resp = await proxyAwareFetch(url, {
          method: "POST",
          headers: {
            ...openAiCompatAuthHeaders(apiKey),
            "Content-Type": "application/json",
          },
          body,
          signal: controller.signal,
        });
        clearTimeout(timer);
        const text = await resp.text();
        if (!resp.ok) {
          return { ok: false, error: `HTTP ${resp.status}: ${text.slice(0, 200)}` };
        }
        let data: { choices?: Array<{ message?: { content?: string } }>; content?: string; response?: string };
        try {
          data = JSON.parse(text) as typeof data;
        } catch {
          return { ok: false, error: "响应格式错误" };
        }
        const content =
          data.choices?.[0]?.message?.content ??
          (data as { content?: string }).content ??
          (data as { response?: string }).response ??
          "";
        if (!content.trim()) return { ok: false, error: "模型未返回有效内容" };
        return { ok: true, content: content.trim() };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    },
  );

  ipcMain.handle("list-meta-workspace-history", async (_event, payload: { kind?: string }) => {
    const kind = parseMetaWorkspaceHistoryKind(payload?.kind);
    if (!kind) return { ok: false, items: [], error: "invalid kind" };
    try {
      return { ok: true, items: listMetaWorkspaceHistory(resolveMetaWorkspaceDir(), kind) };
    } catch (err) {
      return { ok: false, items: [], error: String(err) };
    }
  });

  ipcMain.handle(
    "restore-meta-workspace-history",
    async (_event, payload: { kind?: string; id?: string }) => {
      const kind = parseMetaWorkspaceHistoryKind(payload?.kind);
      const id = String(payload?.id ?? "").trim();
      if (!kind) return { ok: false, error: "invalid kind" };
      if (!id) return { ok: false, error: "id is required" };
      try {
        const result = restoreMetaWorkspaceHistory(resolveMetaWorkspaceDir(), kind, id);
        if (!result.ok) return { ok: false, error: result.error };
        return { ok: true, content: result.content };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    },
  );

  ipcMain.handle("open-meta-workspace-file", async (_event, payload: { kind?: string }) => {
    const kind = parseMetaWorkspaceHistoryKind(payload?.kind);
    if (!kind) return { ok: false, error: "invalid kind" };
    const target = resolveMetaWorkspaceMainPath(resolveMetaWorkspaceDir(), kind);
    try {
      if (!fs.existsSync(target)) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, "", "utf-8");
      }
      const err = await shell.openPath(target);
      if (err) return { ok: false, error: err };
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  });

  ipcMain.handle("load-user-md", async () => {
    try {
      return { ok: true, content: loadSoulFile(metaWorkspaceMarkdownPath("USER.md")) };
    } catch (err) {
      return { ok: false, content: "", error: String(err) };
    }
  });

  ipcMain.handle("save-user-md", async (_event, payload: { content?: string }) => {
    try {
      saveSoulFile(metaWorkspaceMarkdownPath("USER.md"), String(payload?.content ?? ""));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle("load-avatar-soul", async (_event, payload: { avatarId?: string }) => {
    const avatarId = String(payload?.avatarId ?? "").trim();
    if (!avatarId) return { ok: false, content: "", error: "avatarId is required" };
    try {
      const resp = await fetchStudioBackend(
        `/api/avatars/${encodeURIComponent(avatarId)}/soul`,
      );
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        return {
          ok: false,
          content: "",
          error: `HTTP ${resp.status}: ${body.slice(0, 300)}`,
        };
      }
      return await resp.json();
    } catch (err) {
      return { ok: false, content: "", error: String(err) };
    }
  });

  ipcMain.handle(
    "save-avatar-soul",
    async (_event, payload: { avatarId?: string; content?: string }) => {
      const avatarId = String(payload?.avatarId ?? "").trim();
      if (!avatarId) return { ok: false, error: "avatarId is required" };
      try {
        const resp = await fetchStudioBackend(
          `/api/avatars/${encodeURIComponent(avatarId)}/soul`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content: String(payload?.content ?? "") }),
          },
        );
        if (!resp.ok) {
          const body = await resp.text().catch(() => "");
          return { ok: false, error: `HTTP ${resp.status}: ${body.slice(0, 300)}` };
        }
        return await resp.json();
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    },
  );

  const AVATAR_CORE_MEMORY_FILENAMES = new Set([
    "IDENTITY.md",
    "SOUL.md",
    "MEMORY.md",
  ]);
  const AVATAR_CORE_MEMORY_MAX_BYTES = 64 * 1024;

  ipcMain.handle("load-avatar-core-memory", async (_event, payload: { avatarId?: string }) => {
    const avatarId = String(payload?.avatarId ?? "").trim();
    if (!avatarId) return { ok: false, documents: {}, error: "avatarId is required" };
    try {
      const resp = await fetchStudioBackend(
        `/api/avatars/${encodeURIComponent(avatarId)}/core-memory`,
      );
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        return {
          ok: false,
          documents: {},
          error: `HTTP ${resp.status}: ${body.slice(0, 300)}`,
        };
      }
      return await resp.json();
    } catch (err) {
      return { ok: false, documents: {}, error: String(err) };
    }
  });

  ipcMain.handle(
    "save-avatar-core-memory",
    async (
      _event,
      payload: {
        avatarId?: string;
        documents?: Record<string, unknown>;
      },
    ) => {
      const avatarId = String(payload?.avatarId ?? "").trim();
      if (!avatarId) return { ok: false, error: "avatarId is required" };
      const rawDocuments = payload?.documents;
      if (!isPlainJsonObject(rawDocuments)) {
        return { ok: false, error: "documents must be an object" };
      }
      const documents: Record<string, string> = {};
      for (const [filename, rawContent] of Object.entries(rawDocuments)) {
        if (!AVATAR_CORE_MEMORY_FILENAMES.has(filename)) {
          return {
            ok: false,
            error: "only IDENTITY.md, SOUL.md, and MEMORY.md may be edited",
          };
        }
        if (typeof rawContent !== "string") {
          return { ok: false, error: `${filename} content must be text` };
        }
        if (Buffer.byteLength(rawContent, "utf8") > AVATAR_CORE_MEMORY_MAX_BYTES) {
          return {
            ok: false,
            error: `${filename} exceeds the ${AVATAR_CORE_MEMORY_MAX_BYTES} byte limit`,
          };
        }
        if (rawContent.includes("\u0000")) {
          return { ok: false, error: `${filename} contains an invalid NUL character` };
        }
        documents[filename] = rawContent;
      }
      try {
        const resp = await fetchStudioBackend(
          `/api/avatars/${encodeURIComponent(avatarId)}/core-memory`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ documents }),
          },
        );
        if (!resp.ok) {
          const body = await resp.text().catch(() => "");
          return { ok: false, error: `HTTP ${resp.status}: ${body.slice(0, 300)}` };
        }
        return await resp.json();
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    },
  );

  ipcMain.handle("load-skills", async () => {
    try {
      const resp = await fetchStudioBackend("/api/skills");
      return await resp.json();
    } catch (err) {
      return { ok: false, error: String(err), items: [], count: 0 };
    }
  });

  ipcMain.handle("load-skill-detail", async (_event, args: { name: string }) => {
    try {
      const resp = await fetchStudioBackend(`/api/skills/${encodeURIComponent(args.name)}`);
      return await resp.json();
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle("refresh-skills", async () => {
    try {
      const resp = await fetchStudioBackend("/api/skills/refresh", { method: "POST" });
      const data = await resp.json();
      if (data?.ok) emitSkillsChanged();
      return data;
    } catch (err) {
      return { ok: false, error: String(err), count: 0 };
    }
  });

  ipcMain.handle("load-bundles", async () => {
    const studioUrl = getStudioUrl();
    try {
      const resp = await fetch(`${studioUrl}/api/bundles`, {
        headers: { "x-agx-desktop-token": getStudioToken() },
      });
      return await resp.json();
    } catch (err) {
      return { ok: false, error: String(err), items: [], count: 0 };
    }
  });

  ipcMain.handle(
    "install-bundle",
    async (
      _event,
      args: {
        sourcePath: string;
        acknowledgeHighRisk?: boolean;
        confirmNonHighRisk?: boolean;
      }
    ) => {
      if (!currentEnterpriseCapabilityPolicy().allow_local_skill_install) {
        return enterpriseCapabilityDeniedError("Skill");
      }
      const studioUrl = getStudioUrl();
      try {
        const resp = await fetch(`${studioUrl}/api/bundles/install`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-agx-desktop-token": getStudioToken() },
          body: JSON.stringify({
            source_path: args.sourcePath,
            acknowledge_high_risk: Boolean(args.acknowledgeHighRisk),
            confirm_non_high_risk: Boolean(args.confirmNonHighRisk),
          }),
        });
        return await resp.json();
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    }
  );

  ipcMain.handle("install-bundle-preview", async (_event, args: { sourcePath: string }) => {
    const studioUrl = getStudioUrl();
    try {
      const resp = await fetch(`${studioUrl}/api/bundles/install-preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-agx-desktop-token": getStudioToken() },
        body: JSON.stringify({ source_path: args.sourcePath }),
      });
      return await resp.json();
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle("uninstall-bundle", async (_event, args: { name: string }) => {
    if (!currentEnterpriseCapabilityPolicy().allow_local_skill_install) {
      return enterpriseCapabilityDeniedError("Skill");
    }
    const studioUrl = getStudioUrl();
    try {
      const resp = await fetch(`${studioUrl}/api/bundles/${encodeURIComponent(args.name)}`, {
        method: "DELETE",
        headers: { "x-agx-desktop-token": getStudioToken() },
      });
      return await resp.json();
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle("search-registry", async (_event, args: { q: string }) => {
    const studioUrl = getStudioUrl();
    try {
      const params = new URLSearchParams({ q: args.q || "" });
      const resp = await fetch(`${studioUrl}/api/registry/search?${params.toString()}`, {
        headers: { "x-agx-desktop-token": getStudioToken() },
      });
      return await resp.json();
    } catch (err) {
      return { ok: false, error: String(err), items: [], count: 0 };
    }
  });

  ipcMain.handle("search-skillhub", async (_event, args: { q: string }) => {
    const studioUrl = getStudioUrl();
    try {
      const params = new URLSearchParams({ q: args.q || "" });
      const resp = await fetch(`${studioUrl}/api/registry/skillhub/search?${params.toString()}`, {
        headers: { "x-agx-desktop-token": getStudioToken() },
        signal: AbortSignal.timeout(35_000),
      });
      return await resp.json();
    } catch (err) {
      return { ok: false, error: String(err), items: [], count: 0 };
    }
  });

  ipcMain.handle("load-local-image-data-url", async (_event, inputPath: string) => {
    const LOCAL_IMAGE_MAX_BYTES = 100 * 1024 * 1024;
    try {
      const normalized = normalizeLocalFsPath(inputPath);
      if (!normalized) return { ok: false, error: "empty path" };
      if (!fs.existsSync(normalized)) {
        return { ok: false, error: `file not found: ${normalized}` };
      }
      const stat = await fs.promises.stat(normalized);
      if (stat.size > LOCAL_IMAGE_MAX_BYTES) {
        return {
          ok: false,
          error: `图片超过 ${Math.round(LOCAL_IMAGE_MAX_BYTES / 1024 / 1024)}MB，无法预览`,
        };
      }
      const buf = await fs.promises.readFile(normalized);
      const ext = path.extname(normalized).toLowerCase();
      if (ext === ".svg") {
        return { ok: true, dataUrl: buildSvgCharsetDataUrlFromBuffer(buf) };
      }
      const mime =
        ext === ".png"
          ? "image/png"
          : ext === ".jpg" || ext === ".jpeg"
            ? "image/jpeg"
            : ext === ".gif"
              ? "image/gif"
              : ext === ".webp"
                ? "image/webp"
                : "application/octet-stream";
      return { ok: true, dataUrl: `data:${mime};base64,${buf.toString("base64")}` };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  const READ_LOCAL_TEXT_MAX_BYTES = 512 * 1024;

  ipcMain.handle("read-local-text-file", async (_event, inputPath: string) => {
    try {
      const normalized = normalizeLocalFsPath(inputPath);
      if (!normalized) return { ok: false, error: "empty path" };
      if (!fs.existsSync(normalized)) {
        return { ok: false, error: `file not found: ${normalized}` };
      }
      const stat = await fs.promises.stat(normalized);
      if (stat.isDirectory()) {
        return { ok: false, error: "path is a directory" };
      }
      if (stat.size > READ_LOCAL_TEXT_MAX_BYTES) {
        return { ok: false, error: `file too large to read (${stat.size} bytes)` };
      }
      const buf = await fs.promises.readFile(normalized);
      const decoded = decodeLocalTextBuffer(buf);
      if (decoded.encodingError) {
        return { ok: false, error: decoded.encodingError };
      }
      return { ok: true, content: decoded.content, size: stat.size };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  /** Lightweight path metadata (size only) — for artifact list UI, not file contents. */
  ipcMain.handle("stat-local-path", async (_event, inputPath: string) => {
    try {
      const normalized = normalizeLocalFsPath(inputPath);
      if (!normalized) return { ok: false, error: "empty path" };
      const stat = await fs.promises.stat(normalized);
      return {
        ok: true,
        size: stat.size,
        isDirectory: stat.isDirectory(),
        mtimeMs: stat.mtimeMs,
      };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle(
    "scan-workspace-sensitive-files",
    async (_event, payload: WorkspaceSensitiveScanPayload) => {
      try {
        return await scanWorkspaceSensitiveFiles(payload ?? ({} as WorkspaceSensitiveScanPayload));
      } catch (err) {
        return {
          ok: false,
          matches: [],
          scanned: 0,
          truncated: false,
          error: String(err),
        };
      }
    },
  );

  ipcMain.handle(
    "write-local-text-file",
    async (
      _event,
      payload: {
        path?: string;
        content?: string;
        expectedMtimeMs?: number;
        eol?: "lf" | "crlf";
      },
    ) => {
      try {
        return await writeLocalTextFileAtomic(payload ?? {}, normalizeLocalFsPath);
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    },
  );

  /** Resolve the session's default TaskSpace, preserving the selected workspace. */
  const resolveSessionDefaultWorkspaceDir = async (sid: string): Promise<string> => {
    const fallback = path.join(resolveDesktopAgxHome(), "taskspaces", sid, "default");
    try {
      const resp = await fetch(
        `${getStudioUrl()}/api/taskspace/workspaces?session_id=${encodeURIComponent(sid)}`,
        { headers: { "x-agx-desktop-token": getStudioToken() } },
      );
      if (resp.ok) {
        const data = (await resp.json()) as {
          ok?: boolean;
          workspaces?: Array<{ id?: string; path?: string }>;
        };
        const row = (data.workspaces || []).find((w) => String(w.id || "") === "default");
        const p = String(row?.path || "").trim();
        if (p) return normalizeLocalFsPath(p) || fallback;
      }
    } catch {
      // fall through
    }
    return fallback;
  };

  const uniqueLinkName = (destDir: string, sourcePath: string, used: Set<string>): string => {
    const base = path.basename(sourcePath) || "item";
    if (!used.has(base) && !fs.existsSync(path.join(destDir, base))) {
      used.add(base);
      return base;
    }
    const parent = path.basename(path.dirname(sourcePath)) || "dir";
    const alt = `${parent}_${base}`;
    if (!used.has(alt) && !fs.existsSync(path.join(destDir, alt))) {
      used.add(alt);
      return alt;
    }
    let i = 2;
    while (used.has(`${i}_${base}`) || fs.existsSync(path.join(destDir, `${i}_${base}`))) {
      i += 1;
    }
    const finalName = `${i}_${base}`;
    used.add(finalName);
    return finalName;
  };

  /**
   * Mount external files/folders into the session default workspace.
   * mode=link (default): symlink/junction; mode=reference: metadata only;
   * mode=copy: sandboxed copy. Paths already under default are skipped.
   */
  ipcMain.handle(
    "link-into-session-workspace",
    async (
      _event,
      payload: {
        sessionId?: string;
        sources?: string[];
        mode?: MountMode;
        /** User-initiated: skip covering-reference guard for mode=link. */
        explicit?: boolean;
      },
    ) => {
      try {
        const sid = String(payload?.sessionId || "").trim();
        if (!sid || !/^[A-Za-z0-9._-]+$/.test(sid)) {
          return { ok: false, error: "invalid sessionId" };
        }
        const modeRaw = String(payload?.mode || "link").trim().toLowerCase();
        const mode: MountMode =
          modeRaw === "reference" || modeRaw === "copy" || modeRaw === "link"
            ? modeRaw
            : "link";
        const explicit = Boolean(payload?.explicit);
        const rawSources = Array.isArray(payload?.sources) ? payload.sources : [];
        const defaultDir = await resolveSessionDefaultWorkspaceDir(sid);
        await fs.promises.mkdir(defaultDir, { recursive: true });
        const usedNames = new Set<string>();
        try {
          for (const name of await fs.promises.readdir(defaultDir)) {
            usedNames.add(name);
          }
        } catch {
          // ignore
        }
        const seen = new Set<string>();
        let linked = 0;
        const created: string[] = [];
        const failed: string[] = [];

        for (const raw of rawSources) {
          const source = normalizeLocalFsPath(String(raw || ""));
          if (!source || !fs.existsSync(source)) {
            if (source) failed.push(source);
            continue;
          }
          let st: fs.Stats;
          try {
            st = await fs.promises.lstat(source);
          } catch {
            failed.push(source);
            continue;
          }
          const sourceReal = await safeRealpath(source);
          if (seen.has(sourceReal)) continue;
          seen.add(sourceReal);
          if (await isRealpathUnder(source, defaultDir)) {
            continue;
          }
          // Never silently upgrade an existing reference/copy mount to link
          // (artifact auto-linker calls this IPC with default mode=link).
          const existing = await findMountForSource(defaultDir, sourceReal);
          if (existing) {
            if (mode === "link" && existing.mode !== "link") {
              continue;
            }
            if (existing.mode === mode) {
              linked += 1;
              created.push(path.join(defaultDir, existing.name));
              continue;
            }
          }
          // Block auto-link of a file already covered by a parent reference/copy mount.
          // User-initiated mounts pass explicit:true to opt out.
          if (mode === "link" && !explicit) {
            const covering = await findCoveringNonLinkMount(defaultDir, sourceReal);
            if (covering) {
              continue;
            }
          }
          const name = existing?.name || uniqueMountName(defaultDir, source, usedNames);
          const dest = path.join(defaultDir, name);
          const linkedAt = Date.now() / 1000;

          if (mode === "reference") {
            await upsertMount(defaultDir, {
              name,
              mode: "reference",
              source_path: sourceReal,
              linked_at: linkedAt,
            });
            linked += 1;
            created.push(dest);
            continue;
          }

          if (mode === "copy") {
            if (fs.existsSync(dest)) {
              // Keep existing copy; refresh metadata only.
              await upsertMount(defaultDir, {
                name,
                mode: "copy",
                source_path: sourceReal,
                linked_at: linkedAt,
                copy_rel: name,
              });
              linked += 1;
              created.push(dest);
              continue;
            }
            const copied = await copySourceIntoWorkspace({
              defaultDir,
              source: sourceReal,
              destName: name,
            });
            if (!copied.ok) {
              failed.push(source);
              console.warn("[link-into-session-workspace] copy failed:", source, copied.error);
              continue;
            }
            await upsertMount(defaultDir, {
              name,
              mode: "copy",
              source_path: sourceReal,
              linked_at: linkedAt,
              copy_rel: name,
            });
            linked += 1;
            created.push(copied.dest || dest);
            continue;
          }

          // mode === "link"
          if (!fs.existsSync(dest)) {
            const linkResult = await createWorkspaceLink({
              source: sourceReal,
              dest,
              isDirectory: st.isDirectory(),
            });
            if (!linkResult.ok) {
              failed.push(source);
              console.warn("[link-into-session-workspace] symlink failed:", dest, linkResult.error);
              continue;
            }
          }
          await upsertMount(defaultDir, {
            name,
            mode: "link",
            source_path: sourceReal,
            linked_at: linkedAt,
          });
          linked += 1;
          created.push(dest);
        }

        return {
          ok: true,
          defaultDir,
          homeDir: os.homedir(),
          linked,
          created,
          failed,
          mode,
        };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    },
  );

  ipcMain.handle(
    "copy-into-session-workspace",
    async (
      _event,
      payload: { sessionId?: string; sources?: string[] },
    ) => {
      try {
        const sid = String(payload?.sessionId || "").trim();
        if (!sid || !/^[A-Za-z0-9._-]+$/.test(sid)) {
          return { ok: false, error: "invalid sessionId" };
        }
        const rawSources = Array.isArray(payload?.sources) ? payload.sources : [];
        const defaultDir = await resolveSessionDefaultWorkspaceDir(sid);
        await fs.promises.mkdir(defaultDir, { recursive: true });
        const usedNames = new Set<string>();
        try {
          for (const name of await fs.promises.readdir(defaultDir)) usedNames.add(name);
        } catch {
          // ignore
        }
        let linked = 0;
        const created: string[] = [];
        const failed: string[] = [];
        for (const raw of rawSources) {
          const source = normalizeLocalFsPath(String(raw || ""));
          if (!source || !fs.existsSync(source)) {
            if (source) failed.push(source);
            continue;
          }
          if (await isRealpathUnder(source, defaultDir)) continue;
          const sourceReal = await safeRealpath(source);
          const name = uniqueMountName(defaultDir, source, usedNames);
          const copied = await copySourceIntoWorkspace({
            defaultDir,
            source: sourceReal,
            destName: name,
          });
          if (!copied.ok) {
            failed.push(source);
            continue;
          }
          await upsertMount(defaultDir, {
            name,
            mode: "copy",
            source_path: sourceReal,
            linked_at: Date.now() / 1000,
            copy_rel: name,
          });
          linked += 1;
          created.push(copied.dest || path.join(defaultDir, name));
        }
        return { ok: true, defaultDir, linked, created, failed };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    },
  );

  ipcMain.handle(
    "diff-session-workspace-copy",
    async (
      _event,
      payload: { sessionId?: string; name?: string },
    ) => {
      try {
        const sid = String(payload?.sessionId || "").trim();
        const name = String(payload?.name || "").trim();
        if (!sid || !/^[A-Za-z0-9._-]+$/.test(sid) || !name) {
          return { ok: false, error: "invalid sessionId or name" };
        }
        const defaultDir = await resolveSessionDefaultWorkspaceDir(sid);
        return await diffSessionWorkspaceCopy({ defaultDir, name });
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    },
  );

  ipcMain.handle(
    "apply-session-workspace-copy",
    async (
      _event,
      payload: { sessionId?: string; name?: string; force?: boolean },
    ) => {
      try {
        const sid = String(payload?.sessionId || "").trim();
        const name = String(payload?.name || "").trim();
        if (!sid || !/^[A-Za-z0-9._-]+$/.test(sid) || !name) {
          return { ok: false, error: "invalid sessionId or name", applied: [] };
        }
        const defaultDir = await resolveSessionDefaultWorkspaceDir(sid);
        return await applySessionWorkspaceCopy({
          defaultDir,
          name,
          force: !!payload?.force,
        });
      } catch (err) {
        return { ok: false, error: String(err), applied: [] };
      }
    },
  );

  /**
   * Materialize chat attachments as real files under <default>/attachments/.
   */
  ipcMain.handle(
    "materialize-session-attachments",
    async (
      _event,
      payload: {
        sessionId?: string;
        files?: Array<{
          name?: string;
          path?: string;
          dataBase64?: string;
          dataUrl?: string;
        }>;
      },
    ) => {
      try {
        const sid = String(payload?.sessionId || "").trim();
        if (!sid || !/^[A-Za-z0-9._-]+$/.test(sid)) {
          return { ok: false, error: "invalid sessionId", files: [] };
        }
        const files = Array.isArray(payload?.files) ? payload.files : [];
        const defaultDir = await resolveSessionDefaultWorkspaceDir(sid);
        const attachDir = path.join(defaultDir, "attachments");
        await fs.promises.mkdir(attachDir, { recursive: true });
        const used = new Set<string>();
        try {
          for (const name of await fs.promises.readdir(attachDir)) used.add(name);
        } catch {
          // ignore
        }
        const written: Array<{ name: string; path: string }> = [];

        for (const file of files) {
          const rawName = String(file?.name || path.basename(String(file?.path || "")) || "file").trim();
          const safeBase = rawName.replace(/[\\/:\0]/g, "_") || "file";
          let destName = safeBase;
          if (used.has(destName) || fs.existsSync(path.join(attachDir, destName))) {
            const ext = path.extname(safeBase);
            const stem = ext ? safeBase.slice(0, -ext.length) : safeBase;
            let i = 2;
            while (
              used.has(`${stem}_${i}${ext}`) ||
              fs.existsSync(path.join(attachDir, `${stem}_${i}${ext}`))
            ) {
              i += 1;
            }
            destName = `${stem}_${i}${ext}`;
          }
          used.add(destName);
          const dest = path.join(attachDir, destName);

          const srcPath = normalizeLocalFsPath(String(file?.path || ""));
          if (srcPath && fs.existsSync(srcPath)) {
            await fs.promises.copyFile(srcPath, dest);
            written.push({ name: destName, path: dest });
            continue;
          }

          let b64 = String(file?.dataBase64 || "").trim();
          const dataUrl = String(file?.dataUrl || "").trim();
          if (!b64 && dataUrl.startsWith("data:") && dataUrl.includes(",")) {
            b64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
          }
          if (!b64) continue;
          const buf = Buffer.from(b64, "base64");
          await fs.promises.writeFile(dest, buf);
          written.push({ name: destName, path: dest });
        }

        return { ok: true, defaultDir, attachDir, files: written };
      } catch (err) {
        return { ok: false, error: String(err), files: [] };
      }
    },
  );

  /**
   * Legacy alias: symlink artifact paths into the session default workspace
   * (no longer copies into sessions/<sid>/task_artifacts).
   */
  ipcMain.handle(
    "stage-session-artifacts",
    async (
      _event,
      payload: { sessionId?: string; paths?: string[] },
    ) => {
      try {
        const sid = String(payload?.sessionId || "").trim();
        if (!sid || !/^[A-Za-z0-9._-]+$/.test(sid)) {
          return { ok: false, error: "invalid sessionId" };
        }
        const rawPaths = Array.isArray(payload?.paths) ? payload.paths : [];
        const result = (await (async () => {
          // Reuse the same handler body via direct invoke pattern:
          const defaultDir = await resolveSessionDefaultWorkspaceDir(sid);
          await fs.promises.mkdir(defaultDir, { recursive: true });
          const defaultResolved = path.resolve(defaultDir);
          const usedNames = new Set<string>();
          try {
            for (const name of await fs.promises.readdir(defaultDir)) usedNames.add(name);
          } catch {
            // ignore
          }
          const seen = new Set<string>();
          let linked = 0;
          for (const raw of rawPaths) {
            const source = normalizeLocalFsPath(String(raw || ""));
            if (!source || !fs.existsSync(source)) continue;
            let st: fs.Stats;
            try {
              st = await fs.promises.lstat(source);
            } catch {
              continue;
            }
            const resolvedSource = path.resolve(source);
            if (seen.has(resolvedSource)) continue;
            seen.add(resolvedSource);
            if (
              resolvedSource === defaultResolved ||
              resolvedSource.startsWith(defaultResolved + path.sep)
            ) {
              continue;
            }
            const name = uniqueLinkName(defaultDir, source, usedNames);
            const dest = path.join(defaultDir, name);
            try {
              await fs.promises.symlink(
                resolvedSource,
                dest,
                st.isDirectory() ? "dir" : "file",
              );
              linked += 1;
            } catch {
              try {
                await fs.promises.symlink(resolvedSource, dest);
                linked += 1;
              } catch {
                // skip failed link
              }
            }
          }
          return { ok: true as const, stagingDir: defaultDir, homeDir: os.homedir(), linked };
        })());
        return result;
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    },
  );

  const PREVIEW_MAX_BYTES = 25 * 1024 * 1024;
  const PREVIEW_FILE_MIME_BY_EXT: Record<string, string> = {
    ".pdf": "application/pdf",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".xls": "application/vnd.ms-excel",
  };

  ipcMain.handle("load-local-file-data-url", async (_event, inputPath: string) => {
    try {
      const normalized = normalizeLocalFsPath(inputPath);
      if (!normalized) return { ok: false, error: "empty path" };
      if (!fs.existsSync(normalized)) {
        return { ok: false, error: "file not found" };
      }
      const stat = await fs.promises.stat(normalized);
      if (stat.isDirectory()) {
        return { ok: false, error: "path is a directory" };
      }
      if (stat.size > PREVIEW_MAX_BYTES) {
        return { ok: false, error: `file exceeds preview limit (${PREVIEW_MAX_BYTES} bytes)` };
      }
      const ext = path.extname(normalized).toLowerCase();
      const mime = PREVIEW_FILE_MIME_BY_EXT[ext];
      if (!mime) {
        return { ok: false, error: `preview not allowed for extension: ${ext || "(none)"}` };
      }
      const buf = await fs.promises.readFile(normalized);
      return {
        ok: true,
        dataUrl: `data:${mime};base64,${buf.toString("base64")}`,
        mime,
        size: stat.size,
      };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle(
    "install-from-registry",
    async (
      _event,
      args: {
        source: string;
        name: string;
        namespace?: string;
        originSource?: string;
        previewToken?: string;
        acknowledgeHighRisk?: boolean;
        confirmNonHighRisk?: boolean;
        provenanceSource?: "registry" | "skillhub";
      }
    ) => {
      if (!enterpriseRegistrySkillInstallAllowed(loadAgxConfig(), args.name, args.namespace ?? "")) {
        return {
          ok: false,
          error: "企业应用市场仅允许安装当前能力包批准的 Skill",
        };
      }
      const studioUrl = getStudioUrl();
      try {
        const resp = await fetch(`${studioUrl}/api/registry/install`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-agx-desktop-token": getStudioToken() },
          body: JSON.stringify({
            source: args.source,
            name: args.name,
            namespace: args.namespace ?? "",
            origin_source: args.originSource ?? "",
            preview_token: args.previewToken ?? "",
            acknowledge_high_risk: Boolean(args.acknowledgeHighRisk),
            confirm_non_high_risk: Boolean(args.confirmNonHighRisk),
            provenance_source: args.provenanceSource ?? "registry",
          }),
        });
        return await resp.json();
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    }
  );

  ipcMain.handle(
    "uninstall-registry-skill",
    async (_event, args: { name: string }) => {
      // Removing a registry-owned Skill does not expand capability. Keep this
      // available so an employee can undo an approved self-service install
      // even while arbitrary new installs are locked.
      const studioUrl = getStudioUrl();
      try {
        const resp = await fetch(`${studioUrl}/api/registry/install`, {
          method: "DELETE",
          headers: { "Content-Type": "application/json", "x-agx-desktop-token": getStudioToken() },
          body: JSON.stringify({ name: args.name }),
        });
        return await resp.json();
      } catch (err) {
        return { ok: false, removed: false, error: String(err) };
      }
    }
  );

  ipcMain.handle("install-from-registry-preview", async (_event, args: {
    source: string;
    name: string;
    namespace?: string;
    originSource?: string;
  }) => {
    const studioUrl = getStudioUrl();
    try {
      const resp = await fetch(`${studioUrl}/api/registry/install-preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-agx-desktop-token": getStudioToken() },
        body: JSON.stringify({
          source: args.source,
          name: args.name,
          namespace: args.namespace ?? "",
          origin_source: args.originSource ?? "",
        }),
      });
      return await resp.json();
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle("discard-registry-install-preview", async (_event, args: {
    source: string;
    name: string;
    namespace?: string;
    previewToken?: string;
  }) => {
    const studioUrl = getStudioUrl();
    try {
      const resp = await fetch(`${studioUrl}/api/registry/install-preview/discard`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-agx-desktop-token": getStudioToken() },
        body: JSON.stringify({
          source: args.source,
          name: args.name,
          namespace: args.namespace ?? "",
          preview_token: args.previewToken ?? "",
        }),
      });
      return await resp.json();
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle(
    "terminal-spawn",
    async (event, payload: { id: string; cwd: string; cols?: number; rows?: number }) => {
      const ptyMod = requireNodePty();
      if (!ptyMod) return { ok: false as const, error: "node-pty unavailable" };
      // Fall back to home dir if the requested cwd no longer exists
      const rawCwd = (payload.cwd || "").trim();
      const cwd = (rawCwd && fs.existsSync(rawCwd)) ? rawCwd : os.homedir();
      const id = (payload.id || "").trim();
      if (!id) return { ok: false as const, error: "missing id" };
      if (terminalSessions.has(id)) {
        killTerminalSession(id);
      }
      const cols = Math.max(40, Math.min(300, Number(payload.cols) || 80));
      const rows = Math.max(10, Math.min(200, Number(payload.rows) || 24));
      const wc = event.sender;

      let shellPath: string;
      let shellArgs: string[];
      if (process.platform === "win32") {
        shellPath = "powershell.exe";
        shellArgs = ["-NoLogo"];
      } else {
        // Prefer the user's login shell; fall back to zsh then bash.
        // Use -i (interactive) so PS1 / rcfiles load, but avoid -l (login)
        // which re-runs /etc/zprofile and can clobber PATH or call `exit`.
        const candidate = process.env.SHELL || "";
        shellPath = (candidate && fs.existsSync(candidate)) ? candidate
          : (fs.existsSync("/bin/zsh") ? "/bin/zsh" : "/bin/bash");
        shellArgs = ["-i"];
      }

      try {
        const ptyProcess = ptyMod.spawn(shellPath, shellArgs, {
          name: "xterm-256color",
          cols,
          rows,
          cwd,
          env: (() => {
            // Prevent any rc-file from reading a stale PS1/ENV that calls exit
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            const { BASH_ENV: _ignored, ...rest } = process.env;
            return { ...rest, TERM: "xterm-256color" } as Record<string, string>;
          })(),
        });
        terminalSessions.set(id, { kind: "pty", pty: ptyProcess, wc });
        ptyProcess.onData((data) => {
          if (!wc.isDestroyed()) {
            wc.send("terminal-data", { id, data });
          }
        });
        ptyProcess.onExit(() => {
          terminalSessions.delete(id);
          if (!wc.isDestroyed()) {
            wc.send("terminal-exit", { id });
          }
        });
        return { ok: true as const, id };
      } catch (err) {
        return { ok: false as const, error: String(err) };
      }
    }
  );

  ipcMain.handle("terminal-write", async (_event, payload: { id: string; data: string }) => {
    const sess = terminalSessions.get(payload.id);
    if (!sess) return { ok: false };
    if (sess.kind === "bridge") {
      const url = `${sess.baseUrl}/v1/sessions/${encodeURIComponent(sess.sessionId)}/write`;
      const ok = await ccBridgeHttpPostJson(url, sess.token, { data: payload.data });
      return { ok };
    }
    try {
      sess.pty.write(payload.data);
      return { ok: true };
    } catch {
      return { ok: false };
    }
  });

  ipcMain.handle("terminal-write-by-tab", async (_event, payload: { tabId: string; data: string }) => {
    const tabId = (payload.tabId || "").trim();
    if (!tabId) return { ok: false };
    const prefix = `${tabId}:`;
    for (const [id, sess] of terminalSessions.entries()) {
      if (!id.startsWith(prefix)) continue;
      if (sess.kind === "bridge") {
        const url = `${sess.baseUrl}/v1/sessions/${encodeURIComponent(sess.sessionId)}/write`;
        const ok = await ccBridgeHttpPostJson(url, sess.token, { data: payload.data });
        return { ok, id };
      }
      try {
        sess.pty.write(payload.data);
        return { ok: true, id };
      } catch {
        return { ok: false };
      }
    }
    return { ok: false };
  });

  ipcMain.handle("terminal-resize", async (_event, payload: { id: string; cols: number; rows: number }) => {
    const sess = terminalSessions.get(payload.id);
    if (!sess) return { ok: false };
    const cols = Math.max(2, Math.min(300, Math.floor(payload.cols)));
    const rows = Math.max(2, Math.min(200, Math.floor(payload.rows)));
    if (sess.kind === "bridge") {
      const url = `${sess.baseUrl}/v1/sessions/${encodeURIComponent(sess.sessionId)}/resize`;
      const ok = await ccBridgeHttpPostJson(url, sess.token, { cols, rows });
      return { ok };
    }
    try {
      sess.pty.resize(cols, rows);
      return { ok: true };
    } catch {
      return { ok: false };
    }
  });

  ipcMain.handle(
    "terminal-bridge-attach",
    async (
      event,
      payload: {
        id: string;
        sessionId: string;
        baseUrl: string;
        token: string;
        cols?: number;
        rows?: number;
      }
    ) => {
      const id = (payload.id || "").trim();
      const sessionId = (payload.sessionId || "").trim();
      const baseUrl = (payload.baseUrl || "").trim().replace(/\/$/, "");
      const token = (payload.token || "").trim();
      if (!id || !sessionId || !baseUrl || !token) {
        return { ok: false as const, error: "missing id, sessionId, baseUrl, or token" };
      }
      const wc = event.sender;
      killTerminalSession(id);
      const cols = Math.max(40, Math.min(300, Number(payload.cols) || 80));
      const rows = Math.max(10, Math.min(200, Number(payload.rows) || 24));
      const abort = new AbortController();
      const streamUrl = `${baseUrl}/v1/sessions/${encodeURIComponent(sessionId)}/stream`;
      const resizeUrl = `${baseUrl}/v1/sessions/${encodeURIComponent(sessionId)}/resize`;

      terminalSessions.set(id, { kind: "bridge", wc, baseUrl, token, sessionId, abort });

      void (async () => {
        try {
          await ccBridgeHttpPostJson(resizeUrl, token, { cols, rows }, abort.signal).catch(() => {
            /* best-effort */
          });
          const utf8Decoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });
          if (ccBridgeUrlIsLoopback(streamUrl)) {
            const streamOk = await ccBridgeHttpGetStreamLoopback(streamUrl, token, abort.signal, (chunk) => {
              if (wc.isDestroyed()) return;
              const s = utf8Decoder.decode(chunk, { stream: true });
              if (s) {
                wc.send("terminal-data", { id, data: s });
              }
            });
            if (!streamOk) {
              return;
            }
            const tail = utf8Decoder.decode();
            if (tail && !wc.isDestroyed()) {
              wc.send("terminal-data", { id, data: tail });
            }
          } else {
            const resp = await fetch(streamUrl, {
              headers: { Authorization: `Bearer ${token}` },
              signal: abort.signal,
            });
            if (!resp.ok || !resp.body) {
              return;
            }
            const reader = resp.body.getReader();
            while (true) {
              const { done, value } = await reader.read();
              if (done) {
                const tailRemote = utf8Decoder.decode();
                if (tailRemote && !wc.isDestroyed()) {
                  wc.send("terminal-data", { id, data: tailRemote });
                }
                break;
              }
              if (value && value.length > 0 && !wc.isDestroyed()) {
                const s = utf8Decoder.decode(value, { stream: true });
                if (s) {
                  wc.send("terminal-data", { id, data: s });
                }
              }
            }
          }
        } catch (err) {
          const name = err && typeof err === "object" && "name" in err ? String((err as { name?: string }).name) : "";
          if (name !== "AbortError") {
            console.error("[terminal-bridge-attach] stream error:", err);
          }
        } finally {
          terminalSessions.delete(id);
          if (!wc.isDestroyed()) {
            wc.send("terminal-exit", { id });
          }
        }
      })();

      return { ok: true as const, id };
    }
  );

  ipcMain.handle("terminal-kill", (_event, id: string) => {
    killTerminalSession((id || "").trim());
    return { ok: true };
  });
}

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    try {
      logProxyConfig();
      // Recover unconfirmed enterprise Skill swaps before `agx serve` starts
      // and builds its Python index. This does not depend on Portal reachability.
      const recoveryErrors = recoverInterruptedEnterpriseSkillTransactions();
      if (recoveryErrors.length > 0) {
        console.warn(`[enterprise] ${recoveryErrors.join("；")}`);
      }
      if (process.platform === "win32" || process.platform === "linux") {
        Menu.setApplicationMenu(null);
      } else {
        Menu.setApplicationMenu(Menu.buildFromTemplate(buildMenuTemplate()));
      }
      if (process.platform === "darwin") {
        const iconPath = resolveDesktopAppIconPath();
        if (fs.existsSync(iconPath)) {
          app.dock.setIcon(iconPath);
        }
      }

      configureSplashLayoutThemeReader(() => {
        const theme = loadLayoutData().theme;
        return theme === "light" ? "light" : "dark";
      });
      registerSplashIpcHandlers({
        showMainWindow: showMainWindowSafely,
        quitApp: () => app.quit(),
      });
      createSplashWindow();

      // Register basic IPC handlers immediately so the renderer never hits
      // "No handler registered" errors during the agx serve startup delay.
      registerEarlyIpc();

      remoteConfig = loadRemoteConfig();

      // Register the FULL IPC handler set BEFORE the long
      // `await startStudioServe()` below. On macOS `app.on("activate")`
      // fires during that await and — together with the idempotent
      // `createWindow()` guard — opens the window early. The renderer
      // then boots and a burst of invoke("load-user-account"),
      // invoke("list-avatars"), invoke("list-groups"),
      // invoke("load-automation-tasks"), invoke("load-feishu-binding"),
      // invoke("load-mcp-status") etc. fires on mount. If those handlers
      // are still inside the deferred `registerIpc()` call, every one
      // rejects with "No handler registered for 'X'" and each affected
      // panel falls into its empty-state fallback — the user sees
      // "account logged out / 0 agents / no history / settings reset"
      // even though all of that data is safely on disk. A second launch
      // "fixes" it only because the backend warms up faster and the
      // timing lands differently.
      //
      // Moving registration up is safe: handlers either read local files
      // ($AGX_HOME, SQLite) that don't depend on the backend, or proxy
      // to `getStudioUrl()` at invoke time — in the latter case early
      // registration just means the renderer sees the same graceful
      // "fetch failed while serve is still booting" response it would
      // see a few seconds later. No handler references state that's
      // only created inside startStudioServe / waitServeReady.
      registerIpc();

      const startLocalBackendFlow = async (): Promise<boolean> => {
        const bundledPath = resolveBundledBackend();
        if (!bundledPath && app.isPackaged) {
          await closeSplash({ fade: false });
          await dialog.showMessageBox({
            type: "error",
            title: `${DESKTOP_PRODUCT_NAME}后端缺失`,
            message: "发布版安装包未包含内嵌后端，已拒绝复用系统 agx CLI。",
            detail: "请重新安装由 packaging/build_dmg.sh 或 packaging/build_windows_installer.ps1 生成的完整安装包。",
            buttons: ["退出"],
          });
          app.quit();
          return false;
        }
        if (!bundledPath) {
          const agxOk = await checkAgxCli();
          if (!agxOk) {
            const installDocsUrl = "https://agenticx.example.com/docs/getting-started/installation";
            const ctxHint = app.isPackaged
              ? "当前为发布版安装包但未内嵌后端，且未检测到 agx 命令。可选："
              : "当前为开发构建，且未检测到 agx 命令。可选：";
            await closeSplash({ fade: false });
            const { response } = await dialog.showMessageBox({
              type: "warning",
              title: "缺少 agx 命令行工具",
              message: `${DESKTOP_PRODUCT_NAME}需要本地 agx CLI 或内嵌后端才能启动`,
              detail: [
                ctxHint,
                "",
                "1) 安装 agx（终端）：",
                "   pip install agenticx",
                "   或见官方安装脚本说明",
                "",
                "2) 在「设置」中启用远程服务器模式，连接已部署的 agx serve",
                "",
                "3) 发布版安装包会内嵌 agx-server：macOS 使用 packaging/build_dmg.sh；Windows 使用 packaging/build_windows_installer.ps1",
              ].join("\n"),
              buttons: ["查看安装说明", "退出"],
              defaultId: 0,
              cancelId: 1,
            });
            if (response === 0) {
              void shell.openExternal(installDocsUrl);
            }
            app.quit();
            return false;
          }
        }

        updateSplashStage("backend-starting");
        // The renderer must be listening before the embedded Python process
        // starts so its document_generate tool receives stable authenticated
        // loopback coordinates from the very first request.
        if (!documentRendererHost) {
          documentRendererHost = await startDocumentRendererHost(
            resolveDocumentRendererIdentity,
          );
        }
        if (!enterpriseActionBroker) {
          enterpriseActionBroker = await startEnterpriseActionBroker(
            resolveEnterpriseActionAuth,
            resolveEnterpriseAssistantSession,
          );
        }
        await startStudioServe();
        updateSplashStage("backend-waiting");
        await waitServeReady();
        markStudioReady();
        startFeishuProcess();
        void startWechatSidecar();
        return true;
      };

      // Persist `remote_server.enabled = false` so subsequent launches stay
      // on local mode after the user falls back from an unreachable remote.
      const disableRemoteInConfig = (): void => {
        try {
          const cfg = loadAgxConfig();
          if (cfg.remote_server) {
            cfg.remote_server = { ...cfg.remote_server, enabled: false };
            saveAgxConfig(cfg);
          }
        } catch (err) {
          console.warn("[main] failed to disable remote_server in config:", err);
        }
      };

      if (remoteConfig) {
        updateSplashStage("pinging-remote");
        let connected = await pingRemoteServer(remoteConfig);
        while (!connected) {
          await closeSplash({ fade: false });
          const { response } = await dialog.showMessageBox({
            type: "warning",
            title: "无法连接远程服务器",
            message: `无法连接到 ${remoteConfig.url}`,
            detail: [
              "你之前配置了远程后端（公司/云服务器），现在似乎不可达。",
              "",
              "请检查：",
              "1. 云主机上 agx serve 是否已启动",
              "2. URL 和端口是否正确（是否需要在内网/VPN 环境）",
              "3. 防火墙是否放行",
              "4. Token 是否匹配",
              "",
              "或者切换回本地模式：使用本机内嵌/本地安装的 agx serve 启动。",
            ].join("\n"),
            buttons: ["重试", "切换到本地模式", "退出"],
            defaultId: 0,
            cancelId: 2,
          });
          if (response === 0) {
            connected = await pingRemoteServer(remoteConfig);
            continue;
          }
          if (response === 1) {
            disableRemoteInConfig();
            remoteConfig = null;
            notifyRendererConnectionModeChanged();
            const ok = await startLocalBackendFlow();
            if (!ok) return;
            break;
          }
          app.quit();
          return;
        }
        if (remoteConfig && connected) {
          markStudioReady();
        }
      } else {
        const ok = await startLocalBackendFlow();
        if (!ok) return;
      }

      // registerIpc() was moved above the backend-await block so the
      // renderer can't hit "No handler registered" when `app.on("activate")`
      // races with the studio-serve cold start.
      applyPreventSleepFromConfig(loadAgxConfig());
      automationScheduler.start();
      // 与 commandLine proxy-bypass-list 互补：部分 Chromium/Electron 版本下仅 appendSwitch 仍会让
      // 渲染进程 fetch(127.0.0.1) 走系统代理 → TypeError: network error；显式声明环回绕过。
      await session.defaultSession.setProxy({
        proxyBypassRules: "<-loopback>,127.0.0.1,localhost,[::1]",
      });
      createWindow();
      startSkillsDirWatcher();
      createTray();
    } catch (error) {
      await closeSplash({ fade: false });
      if (documentRendererHost) {
        const host = documentRendererHost;
        documentRendererHost = null;
        await host.close().catch(() => undefined);
      }
      if (enterpriseActionBroker) {
        const broker = enterpriseActionBroker;
        enterpriseActionBroker = null;
        await broker.close().catch(() => undefined);
      }
      await dialog.showErrorBox(
        `${DESKTOP_PRODUCT_NAME}启动失败`,
        remoteConfig
          ? `无法连接远程服务器。\n\n${String(error)}`
          : `无法启动本地服务，请检查 agx 是否可用。\n\n${String(error)}`
      );
      app.quit();
    }
  });

  app.on("activate", () => {
    // Avoid creating the window before backend mode is resolved — otherwise
    // preload argv bakes in stale remote scope until a full reload.
    if (!studioReady) return;
    if (!mainWindow) {
      createWindow();
      return;
    }
    mainWindow.show();
    mainWindow.focus();
  });

  app.on("before-quit", () => {
    isQuitting = true;
    automationScheduler.stop();
    stopSkillsDirWatcher();
    killAllTerminalSessions();
    stopFeishuProcess();
    if (tmeetAuthProcess) {
      try { tmeetAuthProcess.kill("SIGTERM"); } catch { /* noop */ }
      tmeetAuthProcess = null;
    }
    stopWechatSidecar();
    stopStudioServe();
    if (documentRendererHost) {
      const host = documentRendererHost;
      documentRendererHost = null;
      void host.close();
    }
    if (enterpriseActionBroker) {
      const broker = enterpriseActionBroker;
      enterpriseActionBroker = null;
      void broker.close();
    }
  });
}
