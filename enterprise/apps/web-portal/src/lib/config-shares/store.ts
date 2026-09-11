import { randomBytes } from "node:crypto";
import { enterpriseConfigShareSnapshots as pgTable } from "@agenticx/db-schema";
import { enterpriseConfigShareSnapshots as mysqlTable } from "@agenticx/db-schema/mysql";
import { createMysqlDb, getIamDb, resolveDatabaseConfig } from "@agenticx/iam-core";
import { and, eq, isNull } from "drizzle-orm";
import {
  CONFIG_SHARE_MANIFEST_VERSION,
  type ConfigShareKind,
  type ConfigShareManifest,
  type ConfigShareSnapshot,
  validateConfigShareManifest,
} from "../config-share-types";

const SHARE_TOKEN_BYTES = 24;

export type CreateConfigShareInput = {
  tenantId: string;
  userId: string;
  ownerDisplayName: string;
  kind: ConfigShareKind;
  manifestVersion: typeof CONFIG_SHARE_MANIFEST_VERSION;
  manifest: ConfigShareManifest;
};

export type ConfigShareStore = {
  create(input: CreateConfigShareInput): Promise<ConfigShareSnapshot>;
  get(token: string, tenantId: string): Promise<ConfigShareSnapshot | null>;
  revoke(token: string, tenantId: string, userId: string): Promise<boolean>;
};

type StoredRow = {
  token: string;
  tenantId: string;
  userId: string;
  ownerDisplayName: string;
  kind: string;
  manifestVersion: number;
  title: string;
  manifest: unknown;
  createdAt: Date | string;
};

function newShareToken(): string {
  return randomBytes(SHARE_TOKEN_BYTES).toString("base64url");
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapRow(row: StoredRow): ConfigShareSnapshot {
  const manifest = validateConfigShareManifest(row.manifest);
  if (
    row.manifestVersion !== CONFIG_SHARE_MANIFEST_VERSION ||
    row.manifestVersion !== manifest.schema_version ||
    row.kind !== manifest.kind ||
    row.title !== manifest.title
  ) {
    throw new Error("stored config share envelope is inconsistent");
  }
  return {
    token: row.token,
    tenantId: row.tenantId,
    userId: row.userId,
    ownerDisplayName: row.ownerDisplayName,
    kind: manifest.kind,
    manifestVersion: CONFIG_SHARE_MANIFEST_VERSION,
    title: row.title,
    manifest,
    createdAt: toIsoString(row.createdAt),
  };
}

function cloneManifest(manifest: ConfigShareManifest): ConfigShareManifest {
  return JSON.parse(JSON.stringify(manifest)) as ConfigShareManifest;
}

function createSqlStore(): ConfigShareStore {
  return {
    async create(input) {
      const token = newShareToken();
      const createdAt = new Date();
      const values = {
        token,
        tenantId: input.tenantId,
        userId: input.userId,
        ownerDisplayName: input.ownerDisplayName,
        kind: input.kind,
        manifestVersion: input.manifestVersion,
        title: input.manifest.title,
        manifest: input.manifest,
        createdAt,
        revokedAt: null,
      };
      const config = resolveDatabaseConfig();
      if (config.dialect === "mysql") {
        const { raw: db } = await createMysqlDb(config);
        await db.insert(mysqlTable).values(values);
      } else {
        const db = getIamDb();
        await db.insert(pgTable).values(values);
      }
      return mapRow(values);
    },

    async get(token, tenantId) {
      const config = resolveDatabaseConfig();
      if (config.dialect === "mysql") {
        const { raw: db } = await createMysqlDb(config);
        const rows = await db
          .select()
          .from(mysqlTable)
          .where(
            and(
              eq(mysqlTable.token, token),
              eq(mysqlTable.tenantId, tenantId),
              isNull(mysqlTable.revokedAt),
            ),
          )
          .limit(1);
        return rows[0] ? mapRow(rows[0]) : null;
      }
      const db = getIamDb();
      const rows = await db
        .select()
        .from(pgTable)
        .where(
          and(
            eq(pgTable.token, token),
            eq(pgTable.tenantId, tenantId),
            isNull(pgTable.revokedAt),
          ),
        )
        .limit(1);
      return rows[0] ? mapRow(rows[0]) : null;
    },

    async revoke(token, tenantId, userId) {
      const revokedAt = new Date();
      const config = resolveDatabaseConfig();
      if (config.dialect === "mysql") {
        const { raw: db } = await createMysqlDb(config);
        const result = await db
          .update(mysqlTable)
          .set({ revokedAt })
          .where(
            and(
              eq(mysqlTable.token, token),
              eq(mysqlTable.tenantId, tenantId),
              eq(mysqlTable.userId, userId),
              isNull(mysqlTable.revokedAt),
            ),
          );
        const header = Array.isArray(result) ? result[0] : result;
        return Number((header as { affectedRows?: unknown }).affectedRows ?? 0) > 0;
      }
      const db = getIamDb();
      const rows = await db
        .update(pgTable)
        .set({ revokedAt })
        .where(
          and(
            eq(pgTable.token, token),
            eq(pgTable.tenantId, tenantId),
            eq(pgTable.userId, userId),
            isNull(pgTable.revokedAt),
          ),
        )
        .returning({ token: pgTable.token });
      return rows.length > 0;
    },
  };
}

/** Test-only in-memory implementation with the same tenant/author boundaries. */
export function createMemoryConfigShareStore(): ConfigShareStore {
  const rows = new Map<string, ConfigShareSnapshot & { revokedAt: string | null }>();
  return {
    async create(input) {
      const snapshot: ConfigShareSnapshot = {
        token: newShareToken(),
        tenantId: input.tenantId,
        userId: input.userId,
        ownerDisplayName: input.ownerDisplayName,
        kind: input.kind,
        manifestVersion: input.manifestVersion,
        title: input.manifest.title,
        manifest: cloneManifest(input.manifest),
        createdAt: new Date().toISOString(),
      };
      rows.set(snapshot.token, { ...snapshot, revokedAt: null });
      return { ...snapshot, manifest: cloneManifest(snapshot.manifest) };
    },
    async get(token, tenantId) {
      const row = rows.get(token);
      if (!row || row.tenantId !== tenantId || row.revokedAt) return null;
      return { ...row, manifest: cloneManifest(row.manifest) };
    },
    async revoke(token, tenantId, userId) {
      const row = rows.get(token);
      if (!row || row.tenantId !== tenantId || row.userId !== userId || row.revokedAt) {
        return false;
      }
      row.revokedAt = new Date().toISOString();
      return true;
    },
  };
}

export const defaultConfigShareStore = createSqlStore();
