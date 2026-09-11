/**
 * Small, in-memory guards for enterprise market download telemetry.
 *
 * A confirmation token is issued by the local inspect endpoint.  Keeping the
 * market coordinates and enterprise identity beside that token means the
 * renderer cannot turn an arbitrary successful portable-package import into a
 * market download.  The store is deliberately bounded and expiring: this is
 * a hand-off guard, not a durable event queue.
 */

export const PORTABLE_MARKET_DOWNLOAD_CONFIRMATION_TTL_MS = 10 * 60 * 1000;
export const PORTABLE_MARKET_DOWNLOAD_CONFIRMATION_MAX_ENTRIES = 128;
export const PORTABLE_MARKET_DOWNLOAD_REPORT_MAX_ATTEMPTS = 2;

const CONFIRMATION_TOKEN_RE = /^[A-Za-z0-9_-]{32}$/u;
const SHA256_RE = /^[a-f0-9]{64}$/u;

export type PortableMarketDownloadBinding = {
  marketId: string;
  releaseId: string;
  enterpriseIdentity: string;
  rawDigest?: string;
  expiresAt: number;
};

export type PortableMarketDownloadBindingInput = Omit<
  PortableMarketDownloadBinding,
  "expiresAt"
>;

export type PortableMarketDownloadLookup = {
  confirmationToken: string;
  enterpriseIdentity: string;
  rawDigest?: string;
};

export type PortableMarketDownloadReport = {
  marketId: string;
  releaseId: string;
};

export type PortableMarketDownloadReporterResult =
  | { ok: true }
  | { ok: false; error: string; retryable?: boolean };

export type PortableMarketDownloadReporter = (
  report: PortableMarketDownloadReport,
) => Promise<PortableMarketDownloadReporterResult>;

function normalizeToken(value: unknown): string | null {
  const token = typeof value === "string" ? value.trim() : "";
  return CONFIRMATION_TOKEN_RE.test(token) ? token : null;
}

function normalizeRequiredText(value: unknown, maxLength = 512): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  return text && text.length <= maxLength ? text : null;
}

function normalizeRawDigest(value: unknown): string | undefined | null {
  if (value === undefined || value === null || value === "") return undefined;
  const digest = typeof value === "string" ? value.trim().toLowerCase() : "";
  return SHA256_RE.test(digest) ? digest : null;
}

/**
 * Bounded token hand-offs for market imports.  `takeForImport` removes a
 * matching token after a successful import; mismatched identities/digests are
 * also removed so a token cannot survive an account transition.
 */
export class PortableMarketDownloadConfirmationStore {
  private readonly entries = new Map<string, PortableMarketDownloadBinding>();

  private readonly ttlMs: number;

  private readonly maxEntries: number;

  private readonly now: () => number;

  constructor(options: {
    ttlMs?: number;
    maxEntries?: number;
    now?: () => number;
  } = {}) {
    this.ttlMs = Number.isFinite(options.ttlMs) && (options.ttlMs ?? 0) > 0
      ? Math.max(1, Math.trunc(options.ttlMs as number))
      : PORTABLE_MARKET_DOWNLOAD_CONFIRMATION_TTL_MS;
    this.maxEntries = Number.isSafeInteger(options.maxEntries) && (options.maxEntries ?? 0) > 0
      ? Math.max(1, options.maxEntries as number)
      : PORTABLE_MARKET_DOWNLOAD_CONFIRMATION_MAX_ENTRIES;
    this.now = options.now ?? (() => Date.now());
  }

  private prune(now: number): void {
    for (const [token, binding] of this.entries) {
      if (binding.expiresAt <= now) this.entries.delete(token);
    }
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (typeof oldest !== "string") break;
      this.entries.delete(oldest);
    }
  }

  bind(tokenValue: unknown, input: PortableMarketDownloadBindingInput): boolean {
    const token = normalizeToken(tokenValue);
    const marketId = normalizeRequiredText(input.marketId, 128);
    const releaseId = normalizeRequiredText(input.releaseId, 128);
    const enterpriseIdentity = normalizeRequiredText(input.enterpriseIdentity, 1024);
    const rawDigest = normalizeRawDigest(input.rawDigest);
    if (
      !token
      || !marketId
      || !releaseId
      || !enterpriseIdentity
      || rawDigest === null
    ) {
      return false;
    }
    const now = this.now();
    this.prune(now);
    this.entries.delete(token);
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (typeof oldest !== "string") break;
      this.entries.delete(oldest);
    }
    this.entries.set(token, {
      marketId,
      releaseId,
      enterpriseIdentity,
      ...(rawDigest ? { rawDigest } : {}),
      expiresAt: now + this.ttlMs,
    });
    return true;
  }

  /** Remove every pending hand-off, for example after logout or login start. */
  clear(): void {
    this.entries.clear();
  }

  discard(tokenValue: unknown): void {
    const token = normalizeToken(tokenValue);
    if (token) this.entries.delete(token);
  }

  get size(): number {
    this.prune(this.now());
    return this.entries.size;
  }

  takeForImport(lookup: PortableMarketDownloadLookup): PortableMarketDownloadBinding | null {
    const token = normalizeToken(lookup.confirmationToken);
    const enterpriseIdentity = normalizeRequiredText(lookup.enterpriseIdentity, 1024);
    const rawDigest = normalizeRawDigest(lookup.rawDigest);
    if (!token || !enterpriseIdentity || rawDigest === null) return null;
    const now = this.now();
    this.prune(now);
    const binding = this.entries.get(token);
    if (!binding) return null;
    // A token is one hand-off. Once the real import has succeeded, or an
    // account/digest mismatch is observed, it must not be replayed.
    this.entries.delete(token);
    if (
      binding.enterpriseIdentity !== enterpriseIdentity
      || (binding.rawDigest !== undefined && binding.rawDigest !== rawDigest)
    ) {
      return null;
    }
    return binding;
  }
}

/**
 * Best-effort finite retry for telemetry. The caller owns the actual install
 * result; this helper never throws and never asks the caller to roll it back.
 */
export async function reportPortableMarketDownloadWithRetry(
  report: PortableMarketDownloadReporter,
  payload: PortableMarketDownloadReport,
): Promise<{ ok: boolean; attempts: number; error?: string }> {
  let lastError = "下载统计上报失败";
  let attempts = 0;
  for (let attempt = 1; attempt <= PORTABLE_MARKET_DOWNLOAD_REPORT_MAX_ATTEMPTS; attempt += 1) {
    attempts = attempt;
    let result: PortableMarketDownloadReporterResult;
    try {
      result = await report(payload);
    } catch (error) {
      result = {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        retryable: true,
      };
    }
    if (result.ok) return { ok: true, attempts: attempt };
    lastError = result.error || lastError;
    if (result.retryable === false) break;
  }
  return { ok: false, attempts, error: lastError };
}
