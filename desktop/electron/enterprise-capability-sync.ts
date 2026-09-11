import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import { proxyAwareFetch } from "./proxy-fetch";
import { assertManagedSkillDirectory } from "./native-connectors-core";
import type { EnterpriseCapability } from "./enterprise-capabilities";
import {
  convergeEnterpriseCapabilitySyncStatusesToFailed,
  normalizeEnterpriseCapabilitySyncStatuses,
  type EnterpriseCapabilitySyncFailureOptions,
  type EnterpriseCapabilitySyncStatus,
} from "./enterprise-capability-sync-state";

export const ENTERPRISE_PORTAL_FETCH_TIMEOUT_MS = 15_000;

/** Stable, non-sensitive local/receipt error codes. */
export const ENTERPRISE_CAPABILITY_SYNC_ERRORS = {
  missing_bundle: "missing_bundle",
  insecure_uri: "insecure_uri",
  missing_digest: "missing_digest",
  invalid_digest: "invalid_digest",
  download_failed: "download_failed",
  size_exceeded: "size_exceeded",
  load_failed: "load_failed",
  index_refresh_failed: "index_refresh_failed",
  skill_not_loaded: "skill_not_loaded",
  digest_mismatch: "digest_mismatch",
  write_failed: "write_failed",
  remove_failed: "remove_failed",
  mcp_config_read_failed: "mcp_config_read_failed",
  mcp_config_write_failed: "mcp_config_write_failed",
  mcp_config_remove_failed: "mcp_config_remove_failed",
  mcp_conflict: "mcp_conflict",
  mcp_endpoint_unavailable: "mcp_endpoint_unavailable",
  name_collision: "name_collision",
  rollback_failed: "rollback_failed",
  sync_incomplete: "sync_incomplete",
  receipt_not_current: "receipt_not_current",
} as const;

export type EnterpriseCapabilitySyncErrorCode =
  (typeof ENTERPRISE_CAPABILITY_SYNC_ERRORS)[keyof typeof ENTERPRISE_CAPABILITY_SYNC_ERRORS];

export type EnterpriseCapabilitySyncPatch = {
  status: EnterpriseCapabilitySyncStatus["status"];
  version?: string;
  digest?: string;
  errorCode?: EnterpriseCapabilitySyncErrorCode;
  message?: string;
  attemptedAt?: string;
  appliedAt?: string;
};

export type EnterpriseCapabilitySyncConfig = {
  enterprise?: {
    enabled?: boolean;
    token?: string;
    capability_sync_statuses?: EnterpriseCapabilitySyncStatus[];
    capability_sync_last_applied?: Record<string, {
      version?: string;
      digest?: string;
      appliedAt?: string;
    }>;
    capability_receipt_summary?: {
      attempted_at: string;
      sent_count: number;
      failed_count: number;
      error_code?: string;
      message?: string;
    };
  };
};

export type EnterpriseCapabilitySyncConfigStore<T extends EnterpriseCapabilitySyncConfig> = {
  load: () => T;
  save: (config: T) => void;
};

/** A synchronous or asynchronous snapshot guard used by receipt reporting. */
export type EnterpriseCapabilityReceiptCurrentGuard =
  () => boolean | Promise<boolean>;

/**
 * Optional identity scope for receipt serialization.  The Desktop caller can
 * include its portal origin, tenant/user identity, and auth generation here so
 * a new login does not queue behind (or share a queue with) an old identity.
 */
export type EnterpriseCapabilityReceiptOptions = {
  isCurrent?: EnterpriseCapabilityReceiptCurrentGuard;
  queueKey?: string;
  /** Abort in-flight batches immediately when the Desktop auth generation changes. */
  signal?: AbortSignal;
};

export function boundedCapabilityMessage(value: unknown): string {
  const message = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const redacted = message
    .replace(/Bearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/(token|password|secret|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]");
  return redacted.slice(0, 240);
}

function capabilitySyncStatusKey(capabilityId: string, kind: "mcp" | "skill"): string {
  return `${kind}:${capabilityId}`;
}

export function recordEnterpriseCapabilitySyncStatus<T extends EnterpriseCapabilitySyncConfig>(
  capability: EnterpriseCapability,
  patch: EnterpriseCapabilitySyncPatch,
  expectedToken: string,
  store: EnterpriseCapabilitySyncConfigStore<T>,
): EnterpriseCapabilitySyncStatus | null {
  const cfg = store.load();
  const ent = cfg.enterprise;
  const currentToken = String(ent?.token ?? "").trim();
  const requestedToken = expectedToken.trim();
  if (!ent?.enabled || !requestedToken || currentToken !== requestedToken) return null;
  const statuses = normalizeEnterpriseCapabilitySyncStatuses(ent.capability_sync_statuses);
  const key = capabilitySyncStatusKey(capability.id, capability.kind);
  const previous = statuses.find(
    (item) => capabilitySyncStatusKey(item.capabilityId, item.kind) === key,
  );
  const now = new Date().toISOString();
  const version = patch.version ?? capability.version ?? previous?.version;
  const digest = patch.digest ?? capability.bundleDigest ?? previous?.digest;
  const attemptedAt = patch.status === "waiting"
    ? patch.attemptedAt ?? now
    : patch.attemptedAt ?? previous?.attemptedAt;
  const status: EnterpriseCapabilitySyncStatus = {
    capabilityId: capability.id,
    kind: capability.kind,
    status: patch.status,
    ...(version ? { version } : {}),
    ...(digest ? { digest: digest.trim().toLowerCase() } : {}),
    ...(attemptedAt ? { attemptedAt } : {}),
  };
  let lastApplied = ent.capability_sync_last_applied;
  if (patch.status === "applied") {
    const appliedAt = patch.appliedAt ?? now;
    status.appliedAt = appliedAt;
    if (patch.message) status.message = boundedCapabilityMessage(patch.message);
    lastApplied = { ...(ent.capability_sync_last_applied ?? {}) };
    lastApplied[capabilitySyncStatusKey(capability.id, capability.kind)] = {
      ...(status.version ? { version: status.version } : {}),
      ...(status.digest ? { digest: status.digest } : {}),
      appliedAt,
    };
  } else if (patch.status === "failed") {
    if (patch.errorCode) status.errorCode = patch.errorCode;
    if (patch.message) status.message = boundedCapabilityMessage(patch.message);
  }
  const next = statuses.filter(
    (item) => capabilitySyncStatusKey(item.capabilityId, item.kind) !== key,
  );
  next.push(status);
  store.save({
    ...cfg,
    enterprise: {
      ...ent,
      capability_sync_statuses: next,
      ...(patch.status === "applied" ? { capability_sync_last_applied: lastApplied } : {}),
    },
  });
  return status;
}

export function pruneEnterpriseCapabilitySyncState<T extends EnterpriseCapabilitySyncConfig>(
  capabilities: readonly EnterpriseCapability[],
  expectedToken: string,
  store: EnterpriseCapabilitySyncConfigStore<T>,
): void {
  const cfg = store.load();
  const ent = cfg.enterprise;
  const currentToken = String(ent?.token ?? "").trim();
  const requestedToken = expectedToken.trim();
  if (!ent?.enabled || !requestedToken || currentToken !== requestedToken) return;
  const ids = new Set(capabilities.map((capability) => capability.id));
  const capabilitySyncStatuses = normalizeEnterpriseCapabilitySyncStatuses(
    ent.capability_sync_statuses,
  ).filter((status) => ids.has(status.capabilityId));
  const scopedKeys = new Set(
    capabilities.map((capability) => capabilitySyncStatusKey(capability.id, capability.kind)),
  );
  const retainedLastApplied: NonNullable<EnterpriseCapabilitySyncConfig["enterprise"]>["capability_sync_last_applied"] = {};
  for (const [key, value] of Object.entries(ent.capability_sync_last_applied ?? {})) {
    // New rows are discriminator-scoped.  Preserve only currently assigned
    // kind+id pairs so a malformed same-id MCP/Skill row cannot overwrite the
    // other's LKG metadata.
    if (scopedKeys.has(key)) {
      retainedLastApplied[key] = { ...value };
    }
  }
  // Migrate the pre-scope shape (`{ [capabilityId]: metadata }`) once, but only
  // when there is no newer discriminator-scoped value for that capability.
  for (const capability of capabilities) {
    const scopedKey = capabilitySyncStatusKey(capability.id, capability.kind);
    const legacyValue = ent.capability_sync_last_applied?.[capability.id];
    if (!retainedLastApplied[scopedKey] && legacyValue) {
      retainedLastApplied[scopedKey] = { ...legacyValue };
    }
  }
  store.save({
    ...cfg,
    enterprise: {
      ...ent,
      capability_sync_statuses: capabilitySyncStatuses,
      capability_sync_last_applied: retainedLastApplied,
    },
  });
}

export function markEnterpriseCapabilitySyncStatusesWaiting<T extends EnterpriseCapabilitySyncConfig>(
  capabilities: readonly EnterpriseCapability[],
  expectedToken: string,
  store: EnterpriseCapabilitySyncConfigStore<T>,
  attemptedAt = new Date().toISOString(),
): void {
  for (const capability of capabilities) {
    recordEnterpriseCapabilitySyncStatus(
      capability,
      { status: "waiting", attemptedAt },
      expectedToken,
      store,
    );
  }
}

/**
 * Persistently fail every in-flight row for the supplied capabilities.
 *
 * The whole status set is transformed and saved as one snapshot, so an outer
 * catch can close a partially completed sync without exposing a mix of stale
 * rows from several individual writes.  The PAT guard makes late async work a
 * no-op after logout or account replacement.
 */
export function convergeEnterpriseCapabilitySyncStateToFailed<
  T extends EnterpriseCapabilitySyncConfig,
>(
  capabilities: readonly EnterpriseCapability[],
  expectedToken: string,
  store: EnterpriseCapabilitySyncConfigStore<T>,
  options: EnterpriseCapabilitySyncFailureOptions = {},
): EnterpriseCapabilitySyncStatus[] | null {
  const cfg = store.load();
  const ent = cfg.enterprise;
  const currentToken = String(ent?.token ?? "").trim();
  const requestedToken = expectedToken.trim();
  if (!ent?.enabled || !requestedToken || currentToken !== requestedToken) return null;
  const ids = new Set(capabilities.map((capability) => capability.id));
  const current = normalizeEnterpriseCapabilitySyncStatuses(ent.capability_sync_statuses);
  const targeted = current.filter((status) => ids.has(status.capabilityId));
  const converged = convergeEnterpriseCapabilitySyncStatusesToFailed(targeted, options);
  const byKey = new Map(
    converged.map((status) => [capabilitySyncStatusKey(status.capabilityId, status.kind), status]),
  );
  const merged = current.map((status) =>
    byKey.get(capabilitySyncStatusKey(status.capabilityId, status.kind)) ?? status,
  );
  // If a caller asks to converge a capability before its first status write,
  // there is nothing to persist.  Avoid an unnecessary config write.
  if (merged.every((status, index) => status === current[index])) return current;
  store.save({
    ...cfg,
    enterprise: {
      ...ent,
      capability_sync_statuses: merged,
    },
  });
  return merged;
}

/** Alias emphasizing that this helper only closes rows still in flight. */
export const failPendingEnterpriseCapabilitySyncStatuses =
  convergeEnterpriseCapabilitySyncStateToFailed;

export function finalizeEnterpriseSkillSyncAfterIndexRefresh<T extends EnterpriseCapabilitySyncConfig>(
  capabilities: readonly EnterpriseCapability[],
  expectedToken: string,
  ok: boolean,
  store: EnterpriseCapabilitySyncConfigStore<T>,
  message?: string,
  loadedCapabilityIds?: ReadonlySet<string>,
  pendingTransactions?: ReadonlyMap<string, ManagedSkillDirectoryTransaction>,
): void {
  const settlement = pendingTransactions
    ? settleManagedSkillDirectoryTransactions(pendingTransactions, ok, loadedCapabilityIds)
    : undefined;
  const settlementErrors = new Map(
    settlement?.errors.map((item) => [item.capabilityId, item.message]) ?? [],
  );
  for (const capability of capabilities) {
    if (capability.kind !== "skill") continue;
    const current = normalizeEnterpriseCapabilitySyncStatuses(
      store.load().enterprise?.capability_sync_statuses,
    ).find((status) => status.capabilityId === capability.id && status.kind === "skill");
    if (!current || current.status === "applied" || current.status === "failed") continue;
    const loaded = current.status === "verifying"
      && ok
      && (loadedCapabilityIds === undefined || loadedCapabilityIds.has(capability.id))
      && !settlementErrors.has(capability.id);
    const transactionError = settlementErrors.get(capability.id);
    recordEnterpriseCapabilitySyncStatus(
      capability,
      loaded
        ? { status: "applied" }
        : {
            status: "failed",
            errorCode: transactionError
              ? ENTERPRISE_CAPABILITY_SYNC_ERRORS.rollback_failed
              : ok
                ? "skill_not_loaded"
                : "index_refresh_failed",
            message: transactionError || message || (ok
              ? "Skill 索引未加载目标目录，已保留本地版本"
              : "Skill 索引刷新失败，已保留本地版本"),
          },
      expectedToken,
      store,
    );
  }
}

export type EnterpriseSkillBundleFetchResult =
  | { ok: true; content: string; digest: string }
  | { ok: false; errorCode: EnterpriseCapabilitySyncErrorCode; message: string };

export async function fetchSkillBundleDetailed(
  uri: string,
  expectedDigest: string,
  maxBytes: number,
): Promise<EnterpriseSkillBundleFetchResult> {
  let resp: Response;
  try {
    resp = await proxyAwareFetch(uri, {
      redirect: "error",
      signal: AbortSignal.timeout(ENTERPRISE_PORTAL_FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    return {
      ok: false,
      errorCode: ENTERPRISE_CAPABILITY_SYNC_ERRORS.download_failed,
      message: boundedCapabilityMessage(error) || "Skill 下载失败",
    };
  }
  if (!resp.ok) {
    if (resp.body) await resp.body.cancel().catch(() => undefined);
    return {
      ok: false,
      errorCode: ENTERPRISE_CAPABILITY_SYNC_ERRORS.download_failed,
      message: `Skill 下载失败（HTTP ${resp.status}）`,
    };
  }
  const declaredSize = Number(resp.headers.get("content-length") ?? "");
  if (Number.isFinite(declaredSize) && declaredSize > maxBytes) {
    if (resp.body) await resp.body.cancel().catch(() => undefined);
    return {
      ok: false,
      errorCode: ENTERPRISE_CAPABILITY_SYNC_ERRORS.size_exceeded,
      message: `Skill 包超过 ${maxBytes} 字节限制`,
    };
  }
  let body: string;
  try {
    if (!resp.body) {
      body = await resp.text();
      if (Buffer.byteLength(body, "utf8") > maxBytes) {
        return {
          ok: false,
          errorCode: ENTERPRISE_CAPABILITY_SYNC_ERRORS.size_exceeded,
          message: `Skill 包超过 ${maxBytes} 字节限制`,
        };
      }
    } else {
      const reader = resp.body.getReader();
      const chunks: Buffer[] = [];
      let total = 0;
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          if (!part.value) continue;
          const chunk = Buffer.from(part.value);
          total += chunk.byteLength;
          if (total > maxBytes) {
            await reader.cancel().catch(() => undefined);
            return {
              ok: false,
              errorCode: ENTERPRISE_CAPABILITY_SYNC_ERRORS.size_exceeded,
              message: `Skill 包超过 ${maxBytes} 字节限制`,
            };
          }
          chunks.push(chunk);
        }
      } catch (error) {
        await reader.cancel().catch(() => undefined);
        return {
          ok: false,
          errorCode: ENTERPRISE_CAPABILITY_SYNC_ERRORS.load_failed,
          message: boundedCapabilityMessage(error) || "Skill 响应读取失败",
        };
      }
      body = Buffer.concat(chunks, total).toString("utf8");
    }
  } catch (error) {
    return {
      ok: false,
      errorCode: ENTERPRISE_CAPABILITY_SYNC_ERRORS.load_failed,
      message: boundedCapabilityMessage(error) || "Skill 响应读取失败",
    };
  }
  const digest = crypto.createHash("sha256").update(body, "utf8").digest("hex");
  if (digest !== expectedDigest.trim().toLowerCase()) {
    return {
      ok: false,
      errorCode: ENTERPRISE_CAPABILITY_SYNC_ERRORS.digest_mismatch,
      message: "Skill SHA-256 摘要不匹配",
    };
  }
  return { ok: true, content: body, digest };
}

export type ManagedSkillDirectoryTransactionState =
  | "pending"
  | "committed"
  | "rolled_back";

/**
 * A fully read-back-verified replacement which is still waiting for the
 * `/api/skills` index to confirm that the new directory is loadable.
 *
 * `backupDir` intentionally remains hidden beside the target while the
 * transaction is pending.  It is removed only by `commitManagedSkillDirectory`
 * after index confirmation, or moved back into place by
 * `rollbackManagedSkillDirectory` when confirmation fails/is missing.
 */
export type ManagedSkillDirectoryTransaction = {
  readonly root: string;
  readonly dirName: string;
  readonly skillDir: string;
  readonly targetPath: string;
  readonly backupDir: string | null;
  readonly backupPath: string | null;
  readonly hadPrevious: boolean;
  readonly state: ManagedSkillDirectoryTransactionState;
  commit: () => void;
  rollback: () => void;
};

const ENTERPRISE_SKILL_PENDING_MARKER = ".near-managed-pending";

function managedSkillBackupDirectory(root: string, dirName: string): string {
  return path.join(root, `.${dirName}.near-managed.backup`);
}

function assertSafeManagedSkillDirName(dirName: string): void {
  // The directory name is normally derived from a capability slug, but this
  // helper is also called from a filesystem boundary.  Refuse separators and
  // dot components so a malformed server capability cannot escape `root`.
  if (
    !dirName
    || dirName === "."
    || dirName === ".."
    || dirName.includes("/")
    || dirName.includes("\\")
  ) {
    throw new Error("Skill 目录名无效");
  }
}

function removeManagedSkillPath(target: string): void {
  if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
}

/**
 * Recover the one stable transaction slot for a managed Skill.
 *
 * The candidate keeps a pending marker until the Python index confirms it.
 * Therefore a backup plus a marked target means the process died before
 * confirmation and the backup must win. A backup plus an unmarked target is a
 * committed replacement whose old-version cleanup was interrupted.
 */
export function recoverInterruptedManagedSkillDirectory(
  root: string,
  dirName: string,
): "none" | "rolled_back" | "committed_cleanup" | "removed_unverified" {
  assertSafeManagedSkillDirName(dirName);
  const skillDir = path.join(root, dirName);
  const backupDir = managedSkillBackupDirectory(root, dirName);
  const pendingPath = path.join(skillDir, ENTERPRISE_SKILL_PENDING_MARKER);
  const targetExists = fs.existsSync(skillDir);
  const backupExists = fs.existsSync(backupDir);
  const targetManaged = targetExists && fs.existsSync(path.join(skillDir, ".near-managed"));
  const backupManaged = backupExists && fs.existsSync(path.join(backupDir, ".near-managed"));
  const targetPending = targetManaged && fs.existsSync(pendingPath);

  // The stable backup slot is predictable by design so it survives a process
  // restart. Never delete or restore a locally-created directory occupying
  // that slot unless it carries our enterprise marker.
  if (backupExists && !backupManaged) {
    throw new Error("检测到同名非托管 Skill 备份目录，已停止自动恢复");
  }
  if (backupExists && targetExists && !targetManaged) {
    throw new Error("检测到同名用户 Skill 目录，已保留托管备份并停止自动恢复");
  }

  if (backupExists && (!targetExists || targetPending)) {
    if (targetExists) removeManagedSkillPath(skillDir);
    fs.renameSync(backupDir, skillDir);
    return "rolled_back";
  }
  if (backupExists) {
    // Commit removes the pending marker before best-effort backup cleanup. If
    // the process died between those two operations, keep the confirmed target.
    removeManagedSkillPath(backupDir);
    return "committed_cleanup";
  }
  if (targetPending) {
    // A first install has no LKG. It is still unverified after a crash, so it
    // must not become the baseline for the next update attempt.
    removeManagedSkillPath(skillDir);
    return "removed_unverified";
  }
  return "none";
}

/**
 * Stage and install a managed Skill replacement, retaining its old directory.
 * The returned transaction must be committed after `/api/skills` confirms the
 * new directory, or rolled back if refresh fails or omits the directory.
 */
export function stageManagedSkillDirectory(
  root: string,
  dirName: string,
  content: string,
): ManagedSkillDirectoryTransaction {
  assertSafeManagedSkillDirName(dirName);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  recoverInterruptedManagedSkillDirectory(root, dirName);
  const skillDir = path.join(root, dirName);
  const markerPath = path.join(skillDir, ".near-managed");
  const directoryExists = fs.existsSync(skillDir);
  assertManagedSkillDirectory(directoryExists, fs.existsSync(markerPath));
  const tmpSuffix = `${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
  const stagingDir = path.join(root, `.${dirName}.${tmpSuffix}.staging`);
  const backupDir = managedSkillBackupDirectory(root, dirName);
  let oldDirectoryMoved = false;
  let newDirectoryInstalled = false;

  try {
    fs.mkdirSync(stagingDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(stagingDir, "SKILL.md"), content, {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.writeFileSync(
      path.join(stagingDir, ".near-managed"),
      "managed by enterprise capability pack\n",
      {
        encoding: "utf8",
        mode: 0o600,
      },
    );
    fs.writeFileSync(
      path.join(stagingDir, ENTERPRISE_SKILL_PENDING_MARKER),
      "awaiting Python Skill index confirmation\n",
      { encoding: "utf8", mode: 0o600 },
    );
    if (directoryExists) {
      fs.renameSync(skillDir, backupDir);
      oldDirectoryMoved = true;
    }
    fs.renameSync(stagingDir, skillDir);
    newDirectoryInstalled = true;
    const loaded = fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf8");
    if (
      loaded !== content
      || !fs.existsSync(path.join(skillDir, ".near-managed"))
      || !fs.existsSync(path.join(skillDir, ENTERPRISE_SKILL_PENDING_MARKER))
    ) {
      throw new Error("Skill 写入后读取校验失败");
    }
  } catch (error) {
    try {
      if (newDirectoryInstalled && fs.existsSync(skillDir)) {
        removeManagedSkillPath(skillDir);
      }
      if (oldDirectoryMoved && fs.existsSync(backupDir) && !fs.existsSync(skillDir)) {
        fs.renameSync(backupDir, skillDir);
        oldDirectoryMoved = false;
      }
      if (fs.existsSync(stagingDir)) removeManagedSkillPath(stagingDir);
    } catch {
      // Keep the original staging error; a later startup/retry can still
      // inspect the hidden backup instead of masking the useful cause.
    }
    throw error;
  }

  let state: ManagedSkillDirectoryTransactionState = "pending";
  const transaction: ManagedSkillDirectoryTransaction = {
    root,
    dirName,
    skillDir,
    targetPath: skillDir,
    backupDir: directoryExists ? backupDir : null,
    backupPath: directoryExists ? backupDir : null,
    hadPrevious: directoryExists,
    get state() {
      return state;
    },
    commit: () => {
      if (state !== "pending") return;
      // Marker removal is the durable commit point. Recovery keeps an
      // unmarked target and only cleans a leftover backup after a crash.
      fs.rmSync(path.join(skillDir, ENTERPRISE_SKILL_PENDING_MARKER));
      if (directoryExists) {
        // Index confirmation has already established that the new directory is
        // usable.  Never roll it back merely because old-version cleanup is
        // unavailable; leave the backup for a later best-effort cleanup.
        try {
          removeManagedSkillPath(backupDir);
        } catch {
          // Deliberately ignored after the new version is verified/committed.
        }
      }
      state = "committed";
    },
    rollback: () => {
      if (state !== "pending") return;
      if (directoryExists && !fs.existsSync(backupDir)) {
        // Keep the candidate in place when its LKG disappeared unexpectedly;
        // deleting it too would turn a recoverable transaction into data loss.
        throw new Error("Skill 回滚失败：上次可用版本备份缺失");
      }
      // Remove the new directory first, then put the old directory back.  Do
      // not mark the transaction settled until both operations succeed so a
      // caller can retry a transient filesystem failure.
      if (fs.existsSync(skillDir)) removeManagedSkillPath(skillDir);
      if (directoryExists && !fs.existsSync(skillDir)) {
        fs.renameSync(backupDir, skillDir);
      }
      if (!directoryExists && fs.existsSync(skillDir)) {
        throw new Error("Skill 回滚后仍存在新目录");
      }
      state = "rolled_back";
    },
  };
  return transaction;
}

/** Commit a staged replacement after the Skill index confirms it is loaded. */
export function commitManagedSkillDirectory(
  transaction: ManagedSkillDirectoryTransaction,
): void {
  transaction.commit();
}

/** Restore the previous managed version (or remove a new-only directory). */
export function rollbackManagedSkillDirectory(
  transaction: ManagedSkillDirectoryTransaction,
): void {
  transaction.rollback();
}

export type ManagedSkillDirectorySettlementResult = {
  committed: string[];
  rolledBack: string[];
  errors: Array<{ capabilityId: string; action: "commit" | "rollback"; message: string }>;
};

/**
 * Settle all staged replacements after one index refresh.
 *
 * `indexRefreshOk` is deliberately separate from `loadedCapabilityIds`: a
 * successful refresh which omits one capability must still roll that one back,
 * and a failed refresh must roll every staged replacement back even if a stale
 * list happened to contain some of their paths.
 */
export function settleManagedSkillDirectoryTransactions(
  transactions: ReadonlyMap<string, ManagedSkillDirectoryTransaction>,
  indexRefreshOk: boolean,
  loadedCapabilityIds?: ReadonlySet<string>,
): ManagedSkillDirectorySettlementResult {
  const result: ManagedSkillDirectorySettlementResult = {
    committed: [],
    rolledBack: [],
    errors: [],
  };
  for (const [capabilityId, transaction] of transactions) {
    const shouldCommit = indexRefreshOk
      && (loadedCapabilityIds === undefined || loadedCapabilityIds.has(capabilityId));
    try {
      if (shouldCommit) {
        commitManagedSkillDirectory(transaction);
        result.committed.push(capabilityId);
      } else {
        rollbackManagedSkillDirectory(transaction);
        result.rolledBack.push(capabilityId);
      }
    } catch (error) {
      result.errors.push({
        capabilityId,
        action: shouldCommit ? "commit" : "rollback",
        message: boundedCapabilityMessage(error) || "Skill 目录事务收敛失败",
      });
    }
  }
  return result;
}

/** Replace a managed Skill directory immediately (legacy/synchronous caller). */
export function writeManagedSkillDirectory(
  root: string,
  dirName: string,
  content: string,
): void {
  const transaction = stageManagedSkillDirectory(root, dirName, content);
  commitManagedSkillDirectory(transaction);
}

export type EnterpriseCapabilityReceiptResult = {
  ok: boolean;
  attemptedAt: string;
  sentCount: number;
  failedCount: number;
  errorCode?: string;
  message?: string;
  /** True when the caller's identity/auth-generation guard invalidated the round. */
  skipped?: boolean;
};

export type EnterpriseCapabilityReceiptSummary = {
  attempted_at: string;
  sent_count: number;
  failed_count: number;
  error_code?: string;
  message?: string;
};

/**
 * A failed receipt is durable retry intent.  Local application state is the
 * source of truth for the next payload, while this summary only tells a later
 * refresh that the Portal has not acknowledged that truth yet.
 */
export function shouldRetryEnterpriseCapabilityReceipt(
  summary: EnterpriseCapabilityReceiptSummary | null | undefined,
): boolean {
  if (!summary) return false;
  return Number(summary.failed_count) > 0
    || String(summary.error_code ?? "").trim().length > 0;
}

// Keep uploads for one PAT/origin in arrival order.  The Portal treats the
// latest receipt it receives as the current state; overlapping sync rounds can
// otherwise let an older, slower request overwrite a newer result.
const enterpriseCapabilityReceiptQueues = new Map<string, Promise<void>>();

function skippedEnterpriseCapabilityReceiptResult(): EnterpriseCapabilityReceiptResult {
  return {
    ok: false,
    attemptedAt: new Date().toISOString(),
    sentCount: 0,
    failedCount: 0,
    errorCode: ENTERPRISE_CAPABILITY_SYNC_ERRORS.receipt_not_current,
    message: "企业能力回执已跳过：登录身份已变化",
    skipped: true,
  };
}

async function isEnterpriseCapabilityReceiptCurrent(
  guard: EnterpriseCapabilityReceiptCurrentGuard | undefined,
): Promise<boolean> {
  if (!guard) return true;
  try {
    return Boolean(await guard());
  } catch {
    // A guard is intentionally fail-closed.  In particular, a config read
    // failure must not cause an old PAT to be sent after logout/identity swap.
    return false;
  }
}

export function buildEnterpriseCapabilityReceiptPayload(
  capabilities: readonly EnterpriseCapability[],
  statuses: readonly EnterpriseCapabilitySyncStatus[],
  attemptedAt: string,
): EnterpriseCapabilitySyncStatus[] {
  const byId = new Map(
    normalizeEnterpriseCapabilitySyncStatuses(statuses).map((status) => [
      capabilitySyncStatusKey(status.capabilityId, status.kind),
      status,
    ]),
  );
  return capabilities.map((capability) => byId.get(
    capabilitySyncStatusKey(capability.id, capability.kind),
  ) ?? {
    capabilityId: capability.id,
    kind: capability.kind,
    status: "waiting",
    attemptedAt,
  });
}

/** Upload one receipt per capability; all failures are isolated and ignored by local sync. */
export async function postEnterpriseCapabilityReceipts(
  capabilities: readonly EnterpriseCapability[],
  statuses: readonly EnterpriseCapabilitySyncStatus[],
  token: string,
  portalOrigin: string,
  options: EnterpriseCapabilityReceiptOptions = {},
): Promise<EnterpriseCapabilityReceiptResult> {
  if (!(await isEnterpriseCapabilityReceiptCurrent(options.isCurrent))) {
    return skippedEnterpriseCapabilityReceiptResult();
  }
  const attemptedAt = new Date().toISOString();
  const payloads = buildEnterpriseCapabilityReceiptPayload(capabilities, statuses, attemptedAt);
  const url = `${portalOrigin.replace(/\/+$/, "")}/api/desktop/capabilities/receipts`;
  const outcomes: PromiseSettledResult<void>[] = [];
  // Keep receipt reporting bounded.  A large capability pack must not create a
  // thousand simultaneous PAT-authenticated requests or hold sync open for
  // 15s per item.
  const concurrency = 6;
  for (let offset = 0; offset < payloads.length; offset += concurrency) {
    // A round may wait for an earlier batch.  Re-check immediately before
    // starting the next batch so an old auth generation/identity cannot keep
    // sending after the user has logged out or switched tenants.
    if (!(await isEnterpriseCapabilityReceiptCurrent(options.isCurrent))) {
      const failures = outcomes.filter(
        (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
      );
      return {
        ok: false,
        attemptedAt,
        sentCount: payloads.length > 0 ? payloads.slice(0, offset).length - failures.length : 0,
        failedCount: failures.length,
        errorCode: ENTERPRISE_CAPABILITY_SYNC_ERRORS.receipt_not_current,
        message: "企业能力回执已停止：登录身份已变化",
        skipped: true,
      };
    }
    const batch = payloads.slice(offset, offset + concurrency);
    outcomes.push(...await Promise.allSettled(
      batch.map(async (payload) => {
        const response = await proxyAwareFetch(url, {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(payload),
          signal: options.signal
            ? AbortSignal.any([
                options.signal,
                AbortSignal.timeout(ENTERPRISE_PORTAL_FETCH_TIMEOUT_MS),
              ])
            : AbortSignal.timeout(ENTERPRISE_PORTAL_FETCH_TIMEOUT_MS),
        });
        if (!response.ok) {
          if (response.body) await response.body.cancel().catch(() => undefined);
          throw new Error(`HTTP ${response.status}`);
        }
      }),
    ));
  }
  const failures = outcomes.filter(
    (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
  );
  return {
    ok: failures.length === 0,
    attemptedAt,
    sentCount: payloads.length - failures.length,
    failedCount: failures.length,
    ...(failures.length > 0 ? { errorCode: "receipt_upload_failed" } : {}),
    ...(failures.length > 0
      ? { message: boundedCapabilityMessage(failures[0]?.reason) || "企业能力回执上报失败" }
      : {}),
  };
}

/**
 * Serialize receipt rounds for one account while allowing different accounts
 * to report independently.  The returned result is still best-effort and
 * never changes local capability state.
 */
export function enqueueEnterpriseCapabilityReceipts(
  capabilities: readonly EnterpriseCapability[],
  statuses: readonly EnterpriseCapabilitySyncStatus[],
  token: string,
  portalOrigin: string,
  options: EnterpriseCapabilityReceiptOptions = {},
): Promise<EnterpriseCapabilityReceiptResult> {
  // Keep the historical origin+PAT isolation by default, while allowing the
  // caller to add tenant/user/auth-generation identity to the queue scope.
  const normalizedOrigin = portalOrigin.replace(/\/+$/, "");
  const queueScope = String(options.queueKey ?? "").trim();
  const key = `${normalizedOrigin}\u0000${token}\u0000${queueScope}`;
  return (async () => {
    // Guard before claiming a queue slot: a stale auth generation should not
    // delay or occupy a current identity's receipt queue.
    if (!(await isEnterpriseCapabilityReceiptCurrent(options.isCurrent))) {
      return skippedEnterpriseCapabilityReceiptResult();
    }
    const previous = enterpriseCapabilityReceiptQueues.get(key) ?? Promise.resolve();
    const queued = previous
      .catch(() => undefined)
      .then(() => postEnterpriseCapabilityReceipts(
        capabilities,
        statuses,
        token,
        portalOrigin,
        options,
      ));
    const settled = queued.then(
      () => undefined,
      () => undefined,
    );
    enterpriseCapabilityReceiptQueues.set(key, settled);
    void settled.then(() => {
      if (enterpriseCapabilityReceiptQueues.get(key) === settled) {
        enterpriseCapabilityReceiptQueues.delete(key);
      }
    });
    return queued;
  })();
}

export function persistEnterpriseCapabilityReceiptSummary<T extends EnterpriseCapabilitySyncConfig>(
  result: EnterpriseCapabilityReceiptResult,
  expectedToken: string,
  store: EnterpriseCapabilitySyncConfigStore<T>,
  isCurrent?: EnterpriseCapabilityReceiptCurrentGuard,
): void | Promise<void> {
  if (result.skipped || result.errorCode === ENTERPRISE_CAPABILITY_SYNC_ERRORS.receipt_not_current) {
    return;
  }
  if (isCurrent) {
    let verdict: boolean | Promise<boolean>;
    try {
      verdict = isCurrent();
    } catch {
      return;
    }
    if (typeof verdict !== "boolean") {
      return Promise.resolve(verdict).then(
        (current) => {
          if (current) {
            persistEnterpriseCapabilityReceiptSummary(result, expectedToken, store);
          }
        },
        () => undefined,
      );
    }
    if (!verdict) return;
  }
  const cfg = store.load();
  const ent = cfg.enterprise;
  const currentToken = String(ent?.token ?? "").trim();
  const requestedToken = expectedToken.trim();
  if (!ent?.enabled || !requestedToken || currentToken !== requestedToken) return;
  const capabilityReceiptSummary = {
    attempted_at: result.attemptedAt,
    sent_count: result.sentCount,
    failed_count: result.failedCount,
    ...(result.errorCode ? { error_code: result.errorCode } : {}),
    ...(result.message ? { message: boundedCapabilityMessage(result.message) } : {}),
  };
  store.save({
    ...cfg,
    enterprise: {
      ...ent,
      capability_receipt_summary: capabilityReceiptSummary,
    },
  });
}
