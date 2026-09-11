import type {
  ActionOperationStatus,
  ActionOperation as DbActionOperation,
  AssistantPermissionMode,
  AssistantSessionOriginKind,
  AssistantSession as DbAssistantSession,
} from "@agenticx/db-schema";
import type {
  AuthorizationDecision,
  AuthorizationTarget,
  PrincipalDto,
} from "@agenticx/iam-core";

export type { ActionOperationStatus, AssistantPermissionMode, AssistantSessionOriginKind };

export type JsonObject = Record<string, unknown>;

export type ActionEffect = "query" | "mutation";

export type ActionSession = {
  id: string;
  tenantId: string;
  userId: string;
  agentPrincipalId: string;
  originatingPatId: number | null;
  originKind: AssistantSessionOriginKind;
  studioSessionId: string;
  permissionMode: AssistantPermissionMode;
  tokenHash: string;
  authorizationVersion: string;
  expiresAt: string;
  status: "active" | "revoked" | "expired";
  createdAt: string;
  updatedAt: string;
};

export type ActionOperation = {
  id: string;
  tenantId: string;
  sessionId: string;
  actorUserId: string;
  agentPrincipalId: string;
  representedUserId: string;
  actionId: string;
  actionVersion: number;
  effect: ActionEffect;
  permissionMode: AssistantPermissionMode;
  idempotencyKey: string;
  argumentsHash: string;
  arguments: JsonObject;
  targets: JsonObject[];
  beforeState: JsonObject | null;
  afterState: JsonObject | null;
  expectedVersions: JsonObject | null;
  authorizationSnapshot: JsonObject;
  authorizationVersion: string;
  runId: string | null;
  status: ActionOperationStatus;
  proposal: JsonObject | null;
  result: JsonObject | null;
  errorCode: string | null;
  errorMessage: string | null;
  confirmationExpiresAt: string | null;
  expiresAt: string;
  confirmedByUserId: string | null;
  executedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ActionOperationEvent = {
  operationId: string;
  tenantId: string;
  sequence: number;
  eventType: string;
  payload: JsonObject;
  createdAt: string;
};

export type ActionTarget = AuthorizationTarget & {
  /** Trusted server resolved target facts, persisted with the operation. */
  deptId?: string | null;
  ownerUserId?: string | null;
  version?: string | number | null;
};

export type ActionRequestContext = {
  tenantId: string;
  userId: string;
  agentPrincipalId: string;
  sessionId: string;
  permissionMode: AssistantPermissionMode;
  authorizationVersion: string;
  principal: PrincipalDto;
};

export type ActionPrepareResult = {
  targets: ActionTarget[];
  beforeState?: JsonObject | null;
  afterState?: JsonObject | null;
  expectedVersions?: JsonObject | null;
  /** Public proposal details; never include secrets or full internal rows. */
  proposal?: JsonObject | null;
};

export type ActionExecutionResult = JsonObject;

export type ActionHandlerContext = {
  request: ActionRequestContext;
  action: ActionDefinition;
  operation: ActionOperation;
  /** Underlying dialect transaction, supplied by SqlActionStore confirmations. */
  transaction?: unknown;
};

export type ActionHandler = {
  resolveTargets: (request: ActionRequestContext, args: JsonObject) => Promise<ActionTarget[]>;
  prepare?: (
    request: ActionRequestContext,
    args: JsonObject,
    targets: ActionTarget[],
  ) => Promise<Omit<ActionPrepareResult, "targets">>;
  execute: (
    context: ActionHandlerContext,
    args: JsonObject,
    targets: ActionTarget[],
  ) => Promise<ActionExecutionResult>;
};

export type ActionPolicy = {
  requiresConfirmation: boolean;
  /** Only explicitly registered low-impact queries may run in auto mode. */
  autoAllowed?: boolean;
};

export type ActionDefinition = {
  id: string;
  version: number;
  label: string;
  description: string;
  effect: ActionEffect;
  /** Canonical capability id used by discovery and dispatch gates. */
  capabilityId?: string;
  requiredScopes: readonly string[];
  inputSchema: JsonObject;
  policy: ActionPolicy;
  /** Optional trusted target used only when building capability discovery. */
  capabilityTargets?: (request: ActionRequestContext) => Promise<ActionTarget[]> | ActionTarget[];
  handler: ActionHandler;
};

export type ActionCapabilityDecision = {
  allowed: boolean;
  reason?: string;
  publicReason?: string;
};

/**
 * Inputs for the final capability check that guards a handler dispatch.
 * `transaction` is the same transaction that owns the operation state and
 * handler-side business writes.  Production adapters use it to take their
 * tenant delivery lock before reading the current pack assignment.
 */
export type ActionCapabilityDispatchInput = {
  request: ActionRequestContext;
  action: ActionDefinition;
  capabilityId: string;
  targets: ActionTarget[];
  transaction: ActionStoreTransaction;
};

export type ActionCapabilityAuthorization = {
  authorize: (input: {
    request: ActionRequestContext;
    action: ActionDefinition;
    capabilityId: string;
    target: ActionTarget;
    /** Present for checks made inside the final dispatch transaction. */
    transaction?: ActionStoreTransaction;
  }) => Promise<ActionCapabilityDecision | boolean>;
  /**
   * Acquire the tenant capability-delivery lock and evaluate the exact
   * capability in the dispatch transaction.  The lock is held through the
   * handler and operation/audit commit, but never across model/confirmation
   * waits.
   */
  prepareDispatch?: (
    input: ActionCapabilityDispatchInput,
  ) => Promise<void | ActionCapabilityDecision | boolean>;
  /**
   * Set by a production adapter whose capability revocation must be
   * serialized with dispatch.  ActionRuntime fails closed if such an adapter
   * forgets to provide prepareDispatch.
   */
  requiresTransactionalDispatch?: boolean;
};

export type ActionAuthorization = {
  authorize: (input: {
    request: ActionRequestContext;
    action: ActionDefinition;
    target: ActionTarget;
  }) => Promise<AuthorizationDecision>;
  authorizationVersion: (
    request: ActionRequestContext,
    transaction?: ActionStoreTransaction,
  ) => Promise<string>;
  /** Optional application-owned capability pack gate. */
  capability?: ActionCapabilityAuthorization;
};

export interface ActionStoreTransaction {
  readonly dialect: "postgresql" | "mysql";
  readonly raw: unknown;
}

export interface ActionStore {
  withTransaction<T>(fn: (transaction: ActionStoreTransaction) => Promise<T>): Promise<T>;
  createSession(input: Omit<ActionSession, "createdAt" | "updatedAt">): Promise<ActionSession>;
  getSessionByTokenHash(tokenHash: string): Promise<ActionSession | null>;
  findResumableSession(input: {
    tenantId: string;
    userId: string;
    originatingPatId: number | null;
    originKind: AssistantSessionOriginKind;
    studioSessionId: string;
    permissionMode: AssistantPermissionMode;
    now?: Date;
  }): Promise<ActionSession | null>;
  updateSession(
    id: string,
    tenantId: string,
    patch: Partial<Pick<ActionSession, "agentPrincipalId" | "tokenHash" | "authorizationVersion" | "expiresAt" | "status">>,
  ): Promise<ActionSession>;
  revokeSession(id: string, tenantId: string): Promise<void>;
  createOperation(
    input: Omit<ActionOperation, "createdAt" | "updatedAt">,
    transaction?: ActionStoreTransaction,
  ): Promise<ActionOperation>;
  findOperationByIdempotency(input: {
    tenantId: string;
    sessionId: string;
    idempotencyKey: string;
  }): Promise<ActionOperation | null>;
  getOperation(input: {
    tenantId: string;
    sessionId: string;
    operationId: string;
    forUpdate?: boolean;
    transaction?: ActionStoreTransaction;
  }): Promise<ActionOperation | null>;
  updateOperation(
    tenantId: string,
    operationId: string,
    patch: Partial<ActionOperation>,
    transaction?: ActionStoreTransaction,
  ): Promise<ActionOperation>;
  /** Compare-and-set operation state.  Returns null when another worker has
   * already moved the operation out of the expected states. */
  updateOperationIfStatus(
    tenantId: string,
    operationId: string,
    expectedStatuses: readonly ActionOperationStatus[],
    patch: Partial<ActionOperation>,
    transaction?: ActionStoreTransaction,
  ): Promise<ActionOperation | null>;
  appendEvent(
    input: Omit<ActionOperationEvent, "createdAt">,
    transaction?: ActionStoreTransaction,
  ): Promise<ActionOperationEvent>;
  listEvents(input: { tenantId: string; sessionId: string; operationId: string }): Promise<ActionOperationEvent[]>;
}

export type PublicAction = Pick<ActionDefinition, "id" | "label" | "description" | "effect" | "inputSchema">;

export function toPublicAction(action: ActionDefinition): PublicAction {
  return {
    id: action.id,
    label: action.label,
    description: action.description,
    effect: action.effect,
    inputSchema: action.inputSchema,
  };
}

export function fromDbSession(row: DbAssistantSession): ActionSession {
  const iso = (value: Date | string): string => (value instanceof Date ? value.toISOString() : new Date(value).toISOString());
  return {
    ...row,
    permissionMode: row.permissionMode as AssistantPermissionMode,
    status: row.status as ActionSession["status"],
    expiresAt: iso(row.expiresAt),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

export function fromDbOperation(row: DbActionOperation): ActionOperation {
  const iso = (value: Date | string): string => (value instanceof Date ? value.toISOString() : new Date(value).toISOString());
  return {
    ...row,
    effect: row.effect as ActionEffect,
    permissionMode: row.permissionMode as AssistantPermissionMode,
    arguments: row.arguments ?? {},
    targets: row.targets ?? [],
    beforeState: row.beforeState ?? null,
    afterState: row.afterState ?? null,
    expectedVersions: row.expectedVersions ?? null,
    authorizationSnapshot: row.authorizationSnapshot ?? {},
    runId: row.runId ?? null,
    status: row.status as ActionOperationStatus,
    proposal: row.proposal ?? null,
    result: row.result ?? null,
    errorCode: row.errorCode ?? null,
    errorMessage: row.errorMessage ?? null,
    confirmationExpiresAt: row.confirmationExpiresAt ? iso(row.confirmationExpiresAt) : null,
    expiresAt: iso(row.expiresAt),
    confirmedByUserId: row.confirmedByUserId ?? null,
    executedAt: row.executedAt ? iso(row.executedAt) : null,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}
