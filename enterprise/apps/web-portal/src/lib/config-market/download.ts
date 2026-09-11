import { isValidConfigMarketId } from "./types";

export type ConfigMarketDownloadRequest = { releaseId: string };

/**
 * Parse the intentionally narrow download-report body.  The report is sent
 * only after a client has completed a real download/import, so accepting extra
 * fields here would make it too easy for callers to accidentally widen the
 * event contract.
 */
export function parseConfigMarketDownloadRequest(value: unknown): ConfigMarketDownloadRequest | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const keys = Object.keys(value as Record<string, unknown>);
  if (keys.length !== 1 || keys[0] !== "releaseId") return null;
  const rawReleaseId = (value as { releaseId?: unknown }).releaseId;
  if (typeof rawReleaseId !== "string") return null;
  const releaseId = rawReleaseId.trim().toUpperCase();
  return isValidConfigMarketId(releaseId) ? { releaseId } : null;
}
