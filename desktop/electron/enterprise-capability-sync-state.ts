export const ENTERPRISE_CAPABILITY_SYNC_STATES = [
  "waiting",
  "downloading",
  "verifying",
  "applied",
  "failed",
] as const;

/** States which represent a completed capability-sync attempt. */
export const ENTERPRISE_CAPABILITY_SYNC_TERMINAL_STATES = [
  "applied",
  "failed",
] as const;

export type EnterpriseCapabilitySyncTerminalState =
  (typeof ENTERPRISE_CAPABILITY_SYNC_TERMINAL_STATES)[number];

export type EnterpriseCapabilitySyncState =
  (typeof ENTERPRISE_CAPABILITY_SYNC_STATES)[number];

export type EnterpriseCapabilitySyncStatus = {
  capabilityId: string;
  kind: "mcp" | "skill";
  status: EnterpriseCapabilitySyncState;
  version?: string;
  digest?: string;
  /** Stable, non-sensitive machine-readable reason. */
  errorCode?: string;
  /** Short user-facing summary. Never include credentials or response bodies. */
  message?: string;
  attemptedAt?: string;
  appliedAt?: string;
};

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isSyncState(value: string): value is EnterpriseCapabilitySyncState {
  return (ENTERPRISE_CAPABILITY_SYNC_STATES as readonly string[]).includes(value);
}

export function isEnterpriseCapabilitySyncTerminalState(
  value: unknown,
): value is EnterpriseCapabilitySyncTerminalState {
  return (ENTERPRISE_CAPABILITY_SYNC_TERMINAL_STATES as readonly string[]).includes(
    typeof value === "string" ? value : "",
  );
}

export type EnterpriseCapabilitySyncFailureOptions = {
  /** Stable, non-sensitive reason used for rows which did not reach a terminal state. */
  errorCode?: string;
  /** Short, non-sensitive summary shown to the user. */
  message?: string;
};

/**
 * Treat persisted and IPC state as untrusted input. Invalid rows are ignored so
 * one corrupt receipt cannot hide every other capability's status.
 */
export function normalizeEnterpriseCapabilitySyncStatuses(
  value: unknown,
): EnterpriseCapabilitySyncStatus[] {
  if (!Array.isArray(value)) return [];
  const byCapability = new Map<string, EnterpriseCapabilitySyncStatus>();
  for (const item of value) {
    if (!isRecord(item)) continue;
    const capabilityId = text(item.capabilityId);
    const kind = text(item.kind);
    const status = text(item.status);
    if (!capabilityId || (kind !== "mcp" && kind !== "skill") || !isSyncState(status)) {
      continue;
    }
    // Keep the discriminator in the key even though current server IDs are
    // normally prefixed (skill:/mcp:). Persisted config is untrusted and must
    // not let a malformed row of one kind replace the other kind's status.
    byCapability.set(`${kind}:${capabilityId}`, {
      capabilityId,
      kind,
      status,
      ...(text(item.version) ? { version: text(item.version) } : {}),
      ...(text(item.digest) ? { digest: text(item.digest).toLowerCase() } : {}),
      ...(text(item.errorCode) ? { errorCode: text(item.errorCode) } : {}),
      ...(text(item.message) ? { message: text(item.message) } : {}),
      ...(text(item.attemptedAt) ? { attemptedAt: text(item.attemptedAt) } : {}),
      ...(text(item.appliedAt) ? { appliedAt: text(item.appliedAt) } : {}),
    });
  }
  return [...byCapability.values()];
}

/**
 * Convert every known in-flight row to a terminal failure.
 *
 * This is intentionally idempotent: already-terminal rows are returned
 * unchanged, and an existing failure's reason/message is retained unless the
 * caller explicitly supplies an override.  Callers can therefore invoke it
 * from both a narrow per-item catch and an outer sync catch without turning a
 * useful error into a later generic one.
 */
export function convergeEnterpriseCapabilitySyncStatusesToFailed(
  value: unknown,
  options: EnterpriseCapabilitySyncFailureOptions = {},
): EnterpriseCapabilitySyncStatus[] {
  const normalized = normalizeEnterpriseCapabilitySyncStatuses(value);
  return normalized.map((status) => {
    if (isEnterpriseCapabilitySyncTerminalState(status.status)) return status;
    return {
      ...status,
      status: "failed",
      ...(options.errorCode || status.errorCode
        ? { errorCode: options.errorCode ?? status.errorCode }
        : { errorCode: "sync_incomplete" }),
      ...(options.message || status.message
        ? { message: options.message ?? status.message }
        : { message: "企业能力同步未完成" }),
    };
  });
}
