import { resolveDatabaseConfig } from "./database/config";
import {
  insertMysqlCapabilitySyncReceipt,
  listMysqlCapabilitySyncReceipts,
} from "./repos/mysql/capability-sync-receipts";
import {
  insertPostgresqlCapabilitySyncReceipt,
  listPostgresqlCapabilitySyncReceipts,
} from "./repos/postgresql/capability-sync-receipts";

export const CAPABILITY_SYNC_RECEIPT_STATUSES = ["pending", "applied", "failed"] as const;
export type CapabilitySyncReceiptStatus = (typeof CAPABILITY_SYNC_RECEIPT_STATUSES)[number];
export type CapabilitySyncReceiptKind = "skill" | "mcp";

export type CapabilitySyncReceiptRecord = {
  id: string;
  tenantId: string;
  userId: string;
  /** The verified PAT id, used as the stable Desktop device instance. */
  apiTokenId: number;
  capabilityId: string;
  kind: CapabilitySyncReceiptKind;
  status: CapabilitySyncReceiptStatus;
  version: string | null;
  digest: string | null;
  errorCode: string | null;
  message: string | null;
  attemptedAt: string;
  appliedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CapabilitySyncReceiptInsert = {
  tenantId: string;
  userId: string;
  apiTokenId: number;
  capabilityId: string;
  kind: CapabilitySyncReceiptKind;
  status: CapabilitySyncReceiptStatus;
  version: string | null;
  digest: string | null;
  errorCode: string | null;
  message: string | null;
  attemptedAt: Date;
  appliedAt: Date | null;
};

export type CapabilitySyncReceiptQuery = {
  tenantId: string;
  userId: string;
  apiTokenId: number;
  capabilityId?: string;
  capabilityIds?: readonly string[];
  /** Optional server-side result cap for internal callers. Omit for the full current-state set. */
  limit?: number;
};

export function desktopDeviceInstanceId(apiTokenId: number): string {
  if (!Number.isSafeInteger(apiTokenId) || apiTokenId <= 0) {
    throw new Error("apiTokenId must be a positive safe integer");
  }
  return String(apiTokenId);
}

export async function insertCapabilitySyncReceipt(
  input: CapabilitySyncReceiptInsert,
): Promise<CapabilitySyncReceiptRecord> {
  if (resolveDatabaseConfig().dialect === "mysql") {
    return insertMysqlCapabilitySyncReceipt(input);
  }
  return insertPostgresqlCapabilitySyncReceipt(input);
}

/**
 * Return the current server-received receipt for each capability. The database
 * unique key makes this a current-state table, so no bounded recent-row slice
 * can hide another capability's latest state. `updatedAt`/ULID are server-side
 * ordering fields; client attemptedAt never controls which state wins.
 */
export async function listLatestCapabilitySyncReceipts(
  input: Omit<CapabilitySyncReceiptQuery, "limit"> & { limit?: number },
): Promise<CapabilitySyncReceiptRecord[]> {
  const query: CapabilitySyncReceiptQuery = {
    ...input,
    ...(input.limit === undefined
      ? {}
      : { limit: Math.max(1, Math.floor(input.limit)) }),
  };
  const rows = resolveDatabaseConfig().dialect === "mysql"
    ? await listMysqlCapabilitySyncReceipts(query)
    : await listPostgresqlCapabilitySyncReceipts(query);
  // The table is a current-state table keyed by identity + capability. Every
  // returned row is therefore already the latest server-received state. Do not
  // slice a recent event window and then deduplicate in memory: a busy
  // capability could otherwise hide another capability's current receipt.
  return rows.sort((left, right) => left.capabilityId.localeCompare(right.capabilityId));
}
