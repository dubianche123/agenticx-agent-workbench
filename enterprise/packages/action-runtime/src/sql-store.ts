import {
  actionOperationEvents,
  actionOperations,
  assistantSessions,
} from "@agenticx/db-schema";
import { actionOperationEvents as mysqlActionOperationEvents, actionOperations as mysqlActionOperations, assistantSessions as mysqlAssistantSessions } from "@agenticx/db-schema/mysql";
import { getIamDb, createMysqlDb, resolveDatabaseConfig } from "@agenticx/iam-core";
import { and, asc, desc, eq, gt, inArray, isNull } from "drizzle-orm";
import type {
  ActionOperation,
  ActionOperationEvent,
  ActionSession,
  ActionStore,
  ActionStoreTransaction,
  AssistantPermissionMode,
} from "./types";
import { fromDbOperation, fromDbSession } from "./types";

type AnyDb = any;
type Tables = {
  sessions: any;
  operations: any;
  events: any;
};

function asDate(value: Date | string | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return new Date(value.getTime());
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error("invalid timestamp");
  return parsed;
}

function requiredDate(value: Date | string): Date {
  const date = asDate(value);
  if (!date) throw new Error("timestamp is required");
  return date;
}

function tablesFor(dialect: "postgresql" | "mysql"): Tables {
  return dialect === "mysql"
    ? { sessions: mysqlAssistantSessions, operations: mysqlActionOperations, events: mysqlActionOperationEvents }
    : { sessions: assistantSessions, operations: actionOperations, events: actionOperationEvents };
}

function rawForTransaction(transaction?: ActionStoreTransaction): AnyDb | null {
  return transaction ? transaction.raw : null;
}

function dateFieldsForSession(input: ActionSession): Record<string, unknown> {
  return {
    id: input.id,
    tenantId: input.tenantId,
    userId: input.userId,
    agentPrincipalId: input.agentPrincipalId,
    originatingPatId: input.originatingPatId,
    originKind: input.originKind,
    studioSessionId: input.studioSessionId,
    permissionMode: input.permissionMode,
    tokenHash: input.tokenHash,
    authorizationVersion: input.authorizationVersion,
    expiresAt: requiredDate(input.expiresAt),
    status: input.status,
    createdAt: requiredDate(input.createdAt),
    updatedAt: requiredDate(input.updatedAt),
  };
}

function dateFieldsForOperation(input: ActionOperation): Record<string, unknown> {
  return {
    id: input.id,
    tenantId: input.tenantId,
    sessionId: input.sessionId,
    actorUserId: input.actorUserId,
    agentPrincipalId: input.agentPrincipalId,
    representedUserId: input.representedUserId,
    actionId: input.actionId,
    actionVersion: input.actionVersion,
    effect: input.effect,
    permissionMode: input.permissionMode,
    idempotencyKey: input.idempotencyKey,
    argumentsHash: input.argumentsHash,
    arguments: input.arguments,
    targets: input.targets,
    beforeState: input.beforeState,
    afterState: input.afterState,
    expectedVersions: input.expectedVersions,
    authorizationSnapshot: input.authorizationSnapshot,
    authorizationVersion: input.authorizationVersion,
    runId: input.runId,
    status: input.status,
    proposal: input.proposal,
    result: input.result,
    errorCode: input.errorCode,
    errorMessage: input.errorMessage,
    confirmationExpiresAt: asDate(input.confirmationExpiresAt),
    expiresAt: requiredDate(input.expiresAt),
    confirmedByUserId: input.confirmedByUserId,
    executedAt: asDate(input.executedAt),
    createdAt: requiredDate(input.createdAt),
    updatedAt: requiredDate(input.updatedAt),
  };
}

function mapSession(row: unknown): ActionSession {
  return fromDbSession(row as Parameters<typeof fromDbSession>[0]);
}

function mapOperation(row: unknown): ActionOperation {
  return fromDbOperation(row as Parameters<typeof fromDbOperation>[0]);
}

function mapEvent(row: any): ActionOperationEvent {
  const createdAt = row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt);
  return {
    operationId: String(row.operationId),
    tenantId: String(row.tenantId),
    sequence: Number(row.sequence),
    eventType: String(row.eventType),
    payload: (row.payload && typeof row.payload === "object" ? row.payload : {}) as Record<string, unknown>,
    createdAt: createdAt.toISOString(),
  };
}

function operationPatchValues(patch: Partial<ActionOperation>): Record<string, unknown> {
  const values: Record<string, unknown> = { updatedAt: new Date() };
  const copy = [
    "status",
    "result",
    "proposal",
    "errorCode",
    "errorMessage",
    "confirmedByUserId",
    "runId",
    "beforeState",
    "afterState",
    "expectedVersions",
    "authorizationSnapshot",
    "authorizationVersion",
  ] as const;
  for (const key of copy) {
    if (patch[key] !== undefined) values[key] = patch[key];
  }
  if (patch.confirmationExpiresAt !== undefined) values.confirmationExpiresAt = asDate(patch.confirmationExpiresAt);
  if (patch.expiresAt !== undefined) values.expiresAt = requiredDate(patch.expiresAt);
  if (patch.executedAt !== undefined) values.executedAt = asDate(patch.executedAt);
  return values;
}

function affectedRowCount(result: unknown): number | null {
  // mysql2/promise returns write results as [ResultSetHeader, FieldPacket[]].
  // Drizzle forwards that tuple for statements without a returning mapper, so
  // inspect the header before looking for affectedRows. PostgreSQL returns an
  // object with rowCount and remains unchanged by this normalization.
  const value = Array.isArray(result) ? result[0] : result;
  if (!value || typeof value !== "object") return null;
  const resultHeader = value as { rowCount?: unknown; affectedRows?: unknown };
  if (typeof resultHeader.rowCount === "number") return resultHeader.rowCount;
  if (typeof resultHeader.affectedRows === "number") return resultHeader.affectedRows;
  return null;
}

/**
 * Drizzle backed action store.  The store deliberately keeps all dialect
 * branching here so handlers and the action runtime never need to import an
 * application DB or choose a tenant from process state.
 */
export class SqlActionStore implements ActionStore {
  private async connection(): Promise<{ dialect: "postgresql" | "mysql"; raw: AnyDb; tables: Tables }> {
    const config = resolveDatabaseConfig();
    if (config.dialect === "mysql") {
      const db = await createMysqlDb(config);
      return { dialect: "mysql", raw: db.raw, tables: tablesFor("mysql") };
    }
    return { dialect: "postgresql", raw: getIamDb(), tables: tablesFor("postgresql") };
  }

  private async connectionFor(transaction?: ActionStoreTransaction): Promise<{ dialect: "postgresql" | "mysql"; raw: AnyDb; tables: Tables }> {
    if (transaction) return { dialect: transaction.dialect, raw: transaction.raw, tables: tablesFor(transaction.dialect) };
    return this.connection();
  }

  private async one(table: any, predicate: unknown, transaction?: ActionStoreTransaction, forUpdate = false): Promise<any | null> {
    const { raw } = await this.connectionFor(transaction);
    let query = raw.select().from(table).where(predicate).limit(1);
    if (forUpdate && typeof query.for === "function") query = query.for("update");
    const rows = await query;
    return rows[0] ?? null;
  }

  public async withTransaction<T>(fn: (transaction: ActionStoreTransaction) => Promise<T>): Promise<T> {
    const { dialect, raw } = await this.connection();
    return raw.transaction(async (tx: AnyDb) => fn({ dialect, raw: tx }));
  }

  public async createSession(input: Omit<ActionSession, "createdAt" | "updatedAt">): Promise<ActionSession> {
    const { raw, tables } = await this.connection();
    const now = new Date();
    const rowInput = { ...input, createdAt: now.toISOString(), updatedAt: now.toISOString() } as ActionSession;
    await raw.insert(tables.sessions).values(dateFieldsForSession(rowInput));
    const row = await this.one(tables.sessions, eq(tables.sessions.id, input.id));
    if (!row) throw new Error("assistant session was not persisted");
    return mapSession(row);
  }

  public async getSessionByTokenHash(tokenHash: string): Promise<ActionSession | null> {
    const { tables } = await this.connection();
    const row = await this.one(tables.sessions, eq(tables.sessions.tokenHash, tokenHash));
    return row ? mapSession(row) : null;
  }

  public async findResumableSession(input: {
    tenantId: string;
    userId: string;
    originatingPatId: number | null;
    originKind: ActionSession["originKind"];
    studioSessionId: string;
    permissionMode: AssistantPermissionMode;
    now?: Date;
  }): Promise<ActionSession | null> {
    const { tables, raw } = await this.connection();
    const now = input.now ?? new Date();
    const rows = await raw
      .select()
      .from(tables.sessions)
      .where(
        and(
          eq(tables.sessions.tenantId, input.tenantId),
          eq(tables.sessions.userId, input.userId),
          input.originatingPatId === null
            ? isNull(tables.sessions.originatingPatId)
            : eq(tables.sessions.originatingPatId, input.originatingPatId),
          eq(tables.sessions.originKind, input.originKind),
          eq(tables.sessions.studioSessionId, input.studioSessionId),
          eq(tables.sessions.permissionMode, input.permissionMode),
          eq(tables.sessions.status, "active"),
          gt(tables.sessions.expiresAt, now),
        ),
      )
      .orderBy(desc(tables.sessions.updatedAt))
      .limit(1);
    return rows[0] ? mapSession(rows[0]) : null;
  }

  public async updateSession(
    id: string,
    tenantId: string,
    patch: Partial<Pick<ActionSession, "agentPrincipalId" | "tokenHash" | "authorizationVersion" | "expiresAt" | "status">>,
  ): Promise<ActionSession> {
    const { raw, tables } = await this.connection();
    const values: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.agentPrincipalId !== undefined) values.agentPrincipalId = patch.agentPrincipalId;
    if (patch.tokenHash !== undefined) values.tokenHash = patch.tokenHash;
    if (patch.authorizationVersion !== undefined) values.authorizationVersion = patch.authorizationVersion;
    if (patch.expiresAt !== undefined) values.expiresAt = requiredDate(patch.expiresAt);
    if (patch.status !== undefined) values.status = patch.status;
    await raw.update(tables.sessions).set(values).where(and(eq(tables.sessions.id, id), eq(tables.sessions.tenantId, tenantId)));
    const row = await this.one(tables.sessions, and(eq(tables.sessions.id, id), eq(tables.sessions.tenantId, tenantId)));
    if (!row) throw new Error("assistant session was not found");
    return mapSession(row);
  }

  public async revokeSession(id: string, tenantId: string): Promise<void> {
    const { raw, tables } = await this.connection();
    await raw
      .update(tables.sessions)
      .set({ status: "revoked", updatedAt: new Date() })
      .where(and(eq(tables.sessions.id, id), eq(tables.sessions.tenantId, tenantId)));
  }

  public async createOperation(
    input: Omit<ActionOperation, "createdAt" | "updatedAt">,
    transaction?: ActionStoreTransaction,
  ): Promise<ActionOperation> {
    const { raw, tables } = await this.connectionFor(transaction);
    const now = new Date().toISOString();
    const rowInput = { ...input, createdAt: now, updatedAt: now } as ActionOperation;
    await raw.insert(tables.operations).values(dateFieldsForOperation(rowInput));
    const row = await this.one(
      tables.operations,
      and(eq(tables.operations.tenantId, input.tenantId), eq(tables.operations.id, input.id)),
      transaction,
    );
    if (!row) throw new Error("action operation was not persisted");
    return mapOperation(row);
  }

  public async findOperationByIdempotency(input: {
    tenantId: string;
    sessionId: string;
    idempotencyKey: string;
  }): Promise<ActionOperation | null> {
    const { tables } = await this.connection();
    const row = await this.one(
      tables.operations,
      and(
        eq(tables.operations.tenantId, input.tenantId),
        eq(tables.operations.sessionId, input.sessionId),
        eq(tables.operations.idempotencyKey, input.idempotencyKey),
      ),
    );
    return row ? mapOperation(row) : null;
  }

  public async getOperation(input: {
    tenantId: string;
    sessionId: string;
    operationId: string;
    forUpdate?: boolean;
    transaction?: ActionStoreTransaction;
  }): Promise<ActionOperation | null> {
    const { tables } = await this.connectionFor(input.transaction);
    const row = await this.one(
      tables.operations,
      and(
        eq(tables.operations.tenantId, input.tenantId),
        eq(tables.operations.sessionId, input.sessionId),
        eq(tables.operations.id, input.operationId),
      ),
      input.transaction,
      input.forUpdate === true,
    );
    return row ? mapOperation(row) : null;
  }

  public async updateOperation(
    tenantId: string,
    operationId: string,
    patch: Partial<ActionOperation>,
    transaction?: ActionStoreTransaction,
  ): Promise<ActionOperation> {
    const { raw, tables } = await this.connectionFor(transaction);
    const values = operationPatchValues(patch);
    await raw.update(tables.operations).set(values).where(and(eq(tables.operations.tenantId, tenantId), eq(tables.operations.id, operationId)));
    const row = await this.one(
      tables.operations,
      and(eq(tables.operations.tenantId, tenantId), eq(tables.operations.id, operationId)),
      transaction,
    );
    if (!row) throw new Error("action operation was not found");
    return mapOperation(row);
  }

  public async updateOperationIfStatus(
    tenantId: string,
    operationId: string,
    expectedStatuses: readonly ActionOperation["status"][],
    patch: Partial<ActionOperation>,
    transaction?: ActionStoreTransaction,
  ): Promise<ActionOperation | null> {
    if (!expectedStatuses.length) return null;
    const { raw, tables } = await this.connectionFor(transaction);
    const result = await raw
      .update(tables.operations)
      .set(operationPatchValues(patch))
      .where(
        and(
          eq(tables.operations.tenantId, tenantId),
          eq(tables.operations.id, operationId),
          inArray(tables.operations.status, [...expectedStatuses]),
        ),
      );

    // A follow-up SELECT alone cannot establish a CAS result: another worker
    // may have committed a different status between the UPDATE and SELECT.
    // Drizzle exposes rowCount for PostgreSQL and affectedRows for MySQL.
    const affected = affectedRowCount(result);
    if (affected === 0) return null;
    const row = await this.one(
      tables.operations,
      and(eq(tables.operations.tenantId, tenantId), eq(tables.operations.id, operationId)),
      transaction,
    );
    if (!row) return null;
    const operation = mapOperation(row);
    // When a driver does not expose an affected-row count, only return a row
    // whose status is still one of the expected values.  Drivers that do
    // expose the count can safely return the post-transition status.
    if (affected === null && !transaction && !expectedStatuses.includes(operation.status)) return null;
    return operation;
  }

  public async appendEvent(
    input: Omit<ActionOperationEvent, "createdAt">,
    transaction?: ActionStoreTransaction,
  ): Promise<ActionOperationEvent> {
    const { raw, tables } = await this.connectionFor(transaction);
    await raw
      .insert(tables.events)
      .values({
        operationId: input.operationId,
        tenantId: input.tenantId,
        sequence: input.sequence,
        eventType: input.eventType,
        payload: input.payload,
        createdAt: new Date(),
      });
    const row = await this.one(
      tables.events,
      and(eq(tables.events.operationId, input.operationId), eq(tables.events.sequence, input.sequence)),
      transaction,
    );
    if (!row) throw new Error("action operation event was not persisted");
    return mapEvent(row);
  }

  public async listEvents(input: { tenantId: string; sessionId: string; operationId: string }): Promise<ActionOperationEvent[]> {
    const { raw, tables } = await this.connection();
    const rows = await raw
      .select({ event: tables.events })
      .from(tables.events)
      .innerJoin(
        tables.operations,
        and(eq(tables.operations.id, tables.events.operationId), eq(tables.operations.tenantId, tables.events.tenantId)),
      )
      .where(
        and(
          eq(tables.events.tenantId, input.tenantId),
          eq(tables.events.operationId, input.operationId),
          eq(tables.operations.sessionId, input.sessionId),
        ),
      )
      .orderBy(asc(tables.events.sequence));
    return rows.map((row: any) => mapEvent(row.event ?? row));
  }
}

type MemoryRecord<T> = T & { createdAt: string; updatedAt: string };

/** Deterministic store used by route/unit tests; production always uses SQL. */
export class MemoryActionStore implements ActionStore {
  public readonly sessions = new Map<string, MemoryRecord<ActionSession>>();
  public readonly operations = new Map<string, MemoryRecord<ActionOperation>>();
  public readonly events = new Map<string, MemoryRecord<ActionOperationEvent>>();
  private transactionTail: Promise<void> = Promise.resolve();

  public async withTransaction<T>(fn: (transaction: ActionStoreTransaction) => Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.transactionTail;
    this.transactionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    const operationsBefore = new Map(
      [...this.operations.entries()].map(([id, row]) => [id, { ...row }]),
    );
    const eventsBefore = new Map(
      [...this.events.entries()].map(([key, row]) => [key, { ...row }]),
    );
    try {
      return await fn({ dialect: "postgresql", raw: this });
    } catch (error) {
      // Keep the in-memory double's transaction behavior aligned with SQL for
      // operation state and audit rows.  Business-domain memory fixtures are
      // outside this store and remain the handler's responsibility.
      this.operations.clear();
      for (const [id, row] of operationsBefore) this.operations.set(id, row);
      this.events.clear();
      for (const [key, row] of eventsBefore) this.events.set(key, row);
      throw error;
    } finally {
      release();
    }
  }

  public async createSession(input: Omit<ActionSession, "createdAt" | "updatedAt">): Promise<ActionSession> {
    const now = new Date().toISOString();
    const row = { ...input, createdAt: now, updatedAt: now } as MemoryRecord<ActionSession>;
    this.sessions.set(row.id, row);
    return { ...row };
  }

  public async getSessionByTokenHash(tokenHash: string): Promise<ActionSession | null> {
    for (const row of this.sessions.values()) if (row.tokenHash === tokenHash) return { ...row };
    return null;
  }

  public async findResumableSession(input: {
    tenantId: string;
    userId: string;
    originatingPatId: number | null;
    originKind: ActionSession["originKind"];
    studioSessionId: string;
    permissionMode: AssistantPermissionMode;
    now?: Date;
  }): Promise<ActionSession | null> {
    const now = (input.now ?? new Date()).getTime();
    return [...this.sessions.values()]
      .filter(
        (row) =>
          row.tenantId === input.tenantId &&
          row.userId === input.userId &&
          row.originatingPatId === input.originatingPatId &&
          row.originKind === input.originKind &&
          row.studioSessionId === input.studioSessionId &&
          row.permissionMode === input.permissionMode &&
          row.status === "active" &&
          new Date(row.expiresAt).getTime() > now,
      )
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null;
  }

  public async updateSession(id: string, tenantId: string, patch: Partial<Pick<ActionSession, "agentPrincipalId" | "tokenHash" | "authorizationVersion" | "expiresAt" | "status">>): Promise<ActionSession> {
    const row = this.sessions.get(id);
    if (!row || row.tenantId !== tenantId) throw new Error("assistant session was not found");
    Object.assign(row, patch, { updatedAt: new Date().toISOString() });
    return { ...row };
  }

  public async revokeSession(id: string, tenantId: string): Promise<void> {
    const row = this.sessions.get(id);
    if (row && row.tenantId === tenantId) Object.assign(row, { status: "revoked", updatedAt: new Date().toISOString() });
  }

  public async createOperation(input: Omit<ActionOperation, "createdAt" | "updatedAt">, _transaction?: ActionStoreTransaction): Promise<ActionOperation> {
    const duplicate = [...this.operations.values()].some(
      (existing) =>
        existing.tenantId === input.tenantId &&
        existing.sessionId === input.sessionId &&
        existing.idempotencyKey === input.idempotencyKey,
    );
    if (duplicate) throw new Error("action operation idempotency key already exists");
    const now = new Date().toISOString();
    const row = { ...input, createdAt: now, updatedAt: now } as MemoryRecord<ActionOperation>;
    this.operations.set(row.id, row);
    return { ...row };
  }

  public async findOperationByIdempotency(input: { tenantId: string; sessionId: string; idempotencyKey: string }): Promise<ActionOperation | null> {
    return [...this.operations.values()].find((row) => row.tenantId === input.tenantId && row.sessionId === input.sessionId && row.idempotencyKey === input.idempotencyKey) ?? null;
  }

  public async getOperation(input: { tenantId: string; sessionId: string; operationId: string; forUpdate?: boolean; transaction?: ActionStoreTransaction }): Promise<ActionOperation | null> {
    const row = this.operations.get(input.operationId);
    return row && row.tenantId === input.tenantId && row.sessionId === input.sessionId ? { ...row } : null;
  }

  public async updateOperation(tenantId: string, operationId: string, patch: Partial<ActionOperation>, _transaction?: ActionStoreTransaction): Promise<ActionOperation> {
    const row = this.operations.get(operationId);
    if (!row || row.tenantId !== tenantId) throw new Error("action operation was not found");
    Object.assign(row, patch, { updatedAt: new Date().toISOString() });
    return { ...row };
  }

  public async updateOperationIfStatus(
    tenantId: string,
    operationId: string,
    expectedStatuses: readonly ActionOperation["status"][],
    patch: Partial<ActionOperation>,
    _transaction?: ActionStoreTransaction,
  ): Promise<ActionOperation | null> {
    const row = this.operations.get(operationId);
    if (!row || row.tenantId !== tenantId || !expectedStatuses.includes(row.status)) return null;
    Object.assign(row, patch, { updatedAt: new Date().toISOString() });
    return { ...row };
  }

  public async appendEvent(input: Omit<ActionOperationEvent, "createdAt">, _transaction?: ActionStoreTransaction): Promise<ActionOperationEvent> {
    const now = new Date().toISOString();
    const key = `${input.operationId}:${input.sequence}`;
    const row = { ...input, createdAt: now, updatedAt: now } as MemoryRecord<ActionOperationEvent>;
    this.events.set(key, row);
    return { ...row };
  }

  public async listEvents(input: { tenantId: string; sessionId: string; operationId: string }): Promise<ActionOperationEvent[]> {
    const operation = await this.getOperation(input);
    if (!operation) return [];
    return [...this.events.values()]
      .filter((row) => row.operationId === input.operationId && row.tenantId === input.tenantId)
      .sort((a, b) => a.sequence - b.sequence)
      .map((row) => ({ ...row }));
  }
}
