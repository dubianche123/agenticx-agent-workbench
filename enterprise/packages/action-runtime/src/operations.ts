import { createHash } from "node:crypto";
import { ulid } from "ulid";
import { ENTERPRISE_CONTEXT_STALE, staleContextError } from "./sessions";
import type {
  ActionDefinition,
  ActionExecutionResult,
  ActionOperation,
  ActionPrepareResult,
  ActionRequestContext,
  ActionStore,
  ActionStoreTransaction,
  ActionTarget,
  JsonObject,
  ActionAuthorization,
  ActionCapabilityDecision,
  PublicAction,
} from "./types";
import { ActionRegistry } from "./registry";

const MAX_ARGUMENT_BYTES = 64 * 1024;
const CONFIRMATION_TTL_MS = 5 * 60 * 1000;
const OPERATION_TTL_MS = 30 * 60 * 1000;

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function objectArguments(input: unknown): JsonObject {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ActionValidationError("arguments must be a JSON object");
  const serialized = stableJson(input);
  if (Buffer.byteLength(serialized, "utf8") > MAX_ARGUMENT_BYTES) throw new ActionValidationError("arguments exceed the maximum size");
  return input as JsonObject;
}

function validateSchema(schema: JsonObject, value: JsonObject): void {
  const type = schema.type;
  if (type && type !== "object") return;
  const required = Array.isArray(schema.required) ? schema.required.filter((key): key is string => typeof key === "string") : [];
  for (const key of required) if (!(key in value)) throw new ActionValidationError(`arguments.${key} is required`);
  const properties = schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)
    ? schema.properties as Record<string, unknown>
    : {};
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(value)) if (!(key in properties)) throw new ActionValidationError(`arguments.${key} is not allowed`);
  }
  for (const [key, propertySchema] of Object.entries(properties)) {
    if (!(key in value) || !propertySchema || typeof propertySchema !== "object") continue;
    const expected = (propertySchema as Record<string, unknown>).type;
    const actual = Array.isArray(value[key]) ? "array" : value[key] === null ? "null" : typeof value[key];
    if (typeof expected === "string" && expected !== actual) throw new ActionValidationError(`arguments.${key} must be ${expected}`);
    if (expected === "string" && typeof value[key] === "string") {
      const minLength = (propertySchema as Record<string, unknown>).minLength;
      if (typeof minLength === "number" && value[key].length < minLength) throw new ActionValidationError(`arguments.${key} is too short`);
    }
  }
}

function sameJson(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right);
}

function publicErrorCode(error: unknown): string {
  return error instanceof RuntimeActionError ? error.code : "ACTION_EXECUTION_FAILED";
}

function actionCapabilityId(action: ActionDefinition): string {
  return action.capabilityId ?? `action:${action.id}`;
}

export class RuntimeActionError extends Error {
  public readonly code: string;
  public readonly status: number;
  public readonly details: JsonObject | null;

  public constructor(code: string, message: string, status = 400, details: JsonObject | null = null) {
    super(message);
    this.name = "RuntimeActionError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export class ActionValidationError extends RuntimeActionError {
  public constructor(message: string) {
    super("ACTION_VALIDATION_FAILED", message, 400);
    this.name = "ActionValidationError";
  }
}

export class ActionForbiddenError extends RuntimeActionError {
  public constructor(message: string, details: JsonObject | null = null) {
    super("ACTION_FORBIDDEN", message, 403, details);
    this.name = "ActionForbiddenError";
  }
}

export class IdempotencyConflictError extends RuntimeActionError {
  public constructor() {
    super("ACTION_IDEMPOTENCY_CONFLICT", "idempotencyKey was already used with different arguments", 409);
    this.name = "IdempotencyConflictError";
  }
}

export class OperationNotFoundError extends RuntimeActionError {
  public constructor() {
    super("ACTION_OPERATION_NOT_FOUND", "action operation was not found", 404);
    this.name = "OperationNotFoundError";
  }
}

export class OperationStaleError extends RuntimeActionError {
  public constructor(message: string, details: JsonObject | null = null) {
    super("ACTION_OPERATION_STALE", message, 409, details);
    this.name = "OperationStaleError";
  }
}

export class OutcomeUnknownError extends RuntimeActionError {
  public constructor(message = "operation outcome could not be confirmed") {
    super("ACTION_OUTCOME_UNKNOWN", message, 503);
    this.name = "OutcomeUnknownError";
  }
}

export type ActionRunResult = {
  status: "succeeded" | "awaiting_confirmation";
  operationId?: string;
  result?: ActionExecutionResult;
  proposal?: JsonObject;
  authorizationVersion: string;
};

export type ActionOperationView = ActionOperation & { events?: Awaited<ReturnType<ActionStore["listEvents"]>> };

function targetsFrom(value: unknown): ActionTarget[] {
  if (!Array.isArray(value)) return [];
  return value.filter((target): target is ActionTarget => Boolean(target && typeof target === "object" && typeof (target as ActionTarget).kind === "string" && typeof (target as ActionTarget).id === "string"));
}

function authorizationSnapshot(decisions: Awaited<ReturnType<ActionAuthorization["authorize"]>>[]): JsonObject {
  return {
    decisions: decisions.map((decision) => ({
      allowed: decision.allowed,
      reason: decision.reason,
      requiredScopes: decision.requiredScopes,
      deniedScopes: decision.deniedScopes,
      matchedPermissions: decision.matchedPermissions,
      target: decision.target,
    })),
  };
}

function publicProposal(action: ActionDefinition, prepared: ActionPrepareResult, confirmationExpiresAt: Date): JsonObject {
  return {
    title: prepared.proposal?.title ?? `${action.label} requires confirmation`,
    changes: prepared.proposal?.changes ?? prepared.afterState ?? {},
    expiresAt: confirmationExpiresAt.toISOString(),
  };
}

type ConfirmTransactionOutcome =
  | { kind: "succeeded"; operation: ActionOperation; result: ActionExecutionResult }
  | { kind: "error"; error: unknown; handled: true };

/**
 * Durable action orchestration.  It owns validation, authorization snapshots,
 * idempotency, confirmation locking and operation/audit event boundaries;
 * handlers only resolve targets, prepare state and perform one business write.
 */
export class ActionRuntime {
  private readonly registry: ActionRegistry;
  private readonly store: ActionStore;
  private readonly authorization: ActionAuthorization;
  private readonly now: () => Date;
  private readonly confirmationLocks = new Map<string, Promise<unknown>>();

  public constructor(input: {
    registry: ActionRegistry;
    store: ActionStore;
    authorization: ActionAuthorization;
    now?: () => Date;
  }) {
    this.registry = input.registry;
    this.store = input.store;
    this.authorization = input.authorization;
    this.now = input.now ?? (() => new Date());
  }

  public actions(): PublicAction[] {
    return this.registry.publicList();
  }

  public async capabilities(request: ActionRequestContext): Promise<PublicAction[]> {
    const visible: PublicAction[] = [];
    for (const action of this.registry.list()) {
      const targets = action.capabilityTargets
        ? await action.capabilityTargets(request)
        : targetsFrom(await action.handler.resolveTargets(request, {}));
      if (!targets.length) continue;
      const capabilityId = actionCapabilityId(action);
      let capabilityAllowed = true;
      for (const target of targets) {
        try {
          const decision = await this.capabilityDecision(request, action, capabilityId, target);
          if (!decision.allowed) {
            capabilityAllowed = false;
            break;
          }
        } catch {
          // Capability discovery is fail-closed. A pack lookup failure must
          // not disclose an action that cannot be dispatched safely.
          capabilityAllowed = false;
          break;
        }
      }
      if (!capabilityAllowed) continue;
      let allowed = true;
      for (const target of targets) {
        const decision = await this.authorization.authorize({ request, action, target });
        if (!decision.allowed) {
          allowed = false;
          break;
        }
      }
      if (allowed) visible.push({ id: action.id, label: action.label, description: action.description, effect: action.effect, inputSchema: action.inputSchema });
    }
    return visible;
  }

  private async capabilityDecision(
    request: ActionRequestContext,
    action: ActionDefinition,
    capabilityId: string,
    target: ActionTarget,
    transaction?: ActionStoreTransaction,
  ): Promise<ActionCapabilityDecision> {
    if (!this.authorization.capability) return { allowed: true };
    const result = await this.authorization.capability.authorize({ request, action, capabilityId, target, transaction });
    return typeof result === "boolean" ? { allowed: result } : result;
  }

  private async prepareCapabilityDispatch(
    request: ActionRequestContext,
    action: ActionDefinition,
    capabilityId: string,
    targets: ActionTarget[],
    transaction: ActionStoreTransaction,
  ): Promise<ActionCapabilityDecision | null> {
    const capability = this.authorization.capability;
    if (!capability) return null;
    if (capability.requiresTransactionalDispatch && !capability.prepareDispatch) {
      throw new RuntimeActionError(
        "ACTION_CAPABILITY_GATE_UNAVAILABLE",
        "action capability dispatch gate is unavailable",
        503,
      );
    }
    if (!capability.prepareDispatch) return null;
    const result = await capability.prepareDispatch({ request, action, capabilityId, targets, transaction });
    if (typeof result === "boolean") return { allowed: result };
    if (result && typeof result === "object" && typeof result.allowed === "boolean") return result;
    return null;
  }

  private async assertFresh(request: ActionRequestContext, transaction?: ActionStoreTransaction): Promise<string> {
    const current = await this.authorization.authorizationVersion(request, transaction);
    if (current !== request.authorizationVersion) throw staleContextError(current);
    return current;
  }

  private async resolveAndAuthorize(request: ActionRequestContext, action: ActionDefinition, args: JsonObject): Promise<{ targets: ActionTarget[]; decisions: Awaited<ReturnType<ActionAuthorization["authorize"]>>[] }> {
    const targets = targetsFrom(await action.handler.resolveTargets(request, args));
    if (!targets.length) throw new ActionValidationError("action resolved no target");
    const capabilityId = actionCapabilityId(action);
    for (const target of targets) {
      const capability = await this.capabilityDecision(request, action, capabilityId, target);
      if (!capability.allowed) {
        throw new ActionForbiddenError(capability.publicReason ?? "capability is not enabled", {
          reason: capability.reason ?? "capability_denied",
          capabilityId,
          target,
        });
      }
    }
    const decisions = [] as Awaited<ReturnType<ActionAuthorization["authorize"]>>[];
    for (const target of targets) {
      const decision = await this.authorization.authorize({ request, action, target });
      decisions.push(decision);
      if (!decision.allowed) {
        throw new ActionForbiddenError(decision.publicReason, {
          reason: decision.reason,
          deniedScopes: decision.deniedScopes,
          target: decision.target,
        });
      }
    }
    return { targets, decisions };
  }

  private async createPreparedOperation(input: {
    request: ActionRequestContext;
    action: ActionDefinition;
    args: JsonObject;
    targets: ActionTarget[];
    decisions: Awaited<ReturnType<ActionAuthorization["authorize"]>>[];
    idempotencyKey: string;
    runId: string | null;
    prepared: ActionPrepareResult;
    status: ActionOperation["status"];
    proposal: JsonObject | null;
  }, transaction?: ActionStoreTransaction): Promise<ActionOperation> {
    const now = this.now();
    return this.store.createOperation({
      id: ulid(),
      tenantId: input.request.tenantId,
      sessionId: input.request.sessionId,
      actorUserId: input.request.userId,
      agentPrincipalId: input.request.agentPrincipalId,
      representedUserId: input.request.userId,
      actionId: input.action.id,
      actionVersion: input.action.version,
      effect: input.action.effect,
      permissionMode: input.request.permissionMode,
      idempotencyKey: input.idempotencyKey,
      argumentsHash: sha256(stableJson(input.args)),
      arguments: input.args,
      targets: input.targets,
      beforeState: input.prepared.beforeState ?? null,
      afterState: input.prepared.afterState ?? null,
      expectedVersions: input.prepared.expectedVersions ?? null,
      authorizationSnapshot: authorizationSnapshot(input.decisions),
      authorizationVersion: input.request.authorizationVersion,
      runId: input.runId,
      status: input.status,
      proposal: input.proposal,
      result: null,
      errorCode: null,
      errorMessage: null,
      confirmationExpiresAt: input.status === "awaiting_confirmation" ? new Date(now.getTime() + CONFIRMATION_TTL_MS).toISOString() : null,
      expiresAt: new Date(now.getTime() + OPERATION_TTL_MS).toISOString(),
      confirmedByUserId: null,
      executedAt: null,
    }, transaction);
  }

  public async run(input: {
    request: ActionRequestContext;
    actionId: string;
    arguments: unknown;
    idempotencyKey: string;
    runId?: string | null;
  }): Promise<ActionRunResult> {
    const action = this.registry.require(input.actionId);
    const args = objectArguments(input.arguments);
    validateSchema(action.inputSchema, args);
    const idempotencyKey = input.idempotencyKey.trim();
    if (!idempotencyKey || idempotencyKey.length > 160) throw new ActionValidationError("idempotencyKey must be 1-160 characters");
    const runId = input.runId?.trim() || null;
    const argumentsHash = sha256(stableJson(args));
    // Revalidate the live context before consulting idempotency. A replayed
    // key may return the same durable result only while the caller's current
    // authorization context is still valid.
    const authorizationVersion = await this.assertFresh(input.request);
    const prior = await this.store.findOperationByIdempotency({
      tenantId: input.request.tenantId,
      sessionId: input.request.sessionId,
      idempotencyKey,
    });
    if (prior) {
      if (prior.argumentsHash !== argumentsHash || prior.actionId !== action.id || prior.actionVersion !== action.version) throw new IdempotencyConflictError();
      if (prior.status === "succeeded") return { status: "succeeded", operationId: prior.id, result: prior.result ?? {}, authorizationVersion };
      if (prior.status === "awaiting_confirmation" && prior.proposal) return { status: "awaiting_confirmation", operationId: prior.id, proposal: prior.proposal, authorizationVersion };
      if (prior.status === "executing") throw new RuntimeActionError("ACTION_IN_PROGRESS", "action operation is already executing", 409);
      if (prior.status === "failed" || prior.status === "stale" || prior.status === "expired" || prior.status === "cancelled" || prior.status === "outcome_unknown") throw new RuntimeActionError(prior.errorCode ?? "ACTION_OPERATION_CLOSED", prior.errorMessage ?? "action operation is closed", 409);
    }

    if (input.request.permissionMode === "plan" && action.effect === "mutation") throw new RuntimeActionError("PLAN_READ_ONLY", "plan mode cannot execute mutations", 403);
    const { targets, decisions } = await this.resolveAndAuthorize(input.request, action, args);
    const preparedExtra = action.handler.prepare ? await action.handler.prepare(input.request, args, targets) : {};
    const prepared: ActionPrepareResult = { ...preparedExtra, targets };
    const needsConfirmation = action.effect === "mutation" && (action.policy.requiresConfirmation || !(input.request.permissionMode === "auto" && action.policy.autoAllowed === true));
    const status: ActionOperation["status"] = needsConfirmation ? "awaiting_confirmation" : "executing";
    const proposal = needsConfirmation
      ? publicProposal(action, prepared, new Date(this.now().getTime() + CONFIRMATION_TTL_MS))
      : null;
    let operation: ActionOperation;
    try {
      operation = await this.store.withTransaction(async (transaction) => {
        const created = await this.createPreparedOperation({
          request: { ...input.request, authorizationVersion },
          action,
          args,
          targets,
          decisions,
          idempotencyKey,
          runId,
          prepared,
          status,
          proposal,
        }, transaction);
        await this.store.appendEvent({
          operationId: created.id,
          tenantId: created.tenantId,
          sequence: 1,
          eventType: needsConfirmation ? "prepared" : "executing",
          payload: { actionId: created.actionId, actionVersion: created.actionVersion, authorizationVersion },
        }, transaction);
        return created;
      });
    } catch (error) {
      // The unique `(tenant, session, idempotencyKey)` constraint is the
      // serialization point for two concurrent retries. Re-read the winner
      // and return it when its arguments match; a different payload remains a
      // deterministic conflict.
      const winner = await this.store.findOperationByIdempotency({
        tenantId: input.request.tenantId,
        sessionId: input.request.sessionId,
        idempotencyKey,
      }).catch(() => null);
      if (winner) {
        if (winner.argumentsHash !== argumentsHash || winner.actionId !== action.id || winner.actionVersion !== action.version) throw new IdempotencyConflictError();
        if (winner.status === "succeeded") return { status: "succeeded", operationId: winner.id, result: winner.result ?? {}, authorizationVersion };
        if (winner.status === "awaiting_confirmation" && winner.proposal) return { status: "awaiting_confirmation", operationId: winner.id, proposal: winner.proposal, authorizationVersion };
        if (winner.status === "outcome_unknown") throw new RuntimeActionError(winner.errorCode ?? "ACTION_OUTCOME_UNKNOWN", winner.errorMessage ?? "operation outcome could not be confirmed", 409);
      }
      throw error;
    }
    if (needsConfirmation) {
      return { status: "awaiting_confirmation", operationId: operation.id, proposal: operation.proposal ?? {}, authorizationVersion };
    }
    let handledInsideTransaction = false;
    try {
      const completed = await this.store.withTransaction(async (transaction): Promise<ConfirmTransactionOutcome> => {
        // Capability-pack mutations take the tenant delivery lock before the
        // operation row lock.  The lock stays held through the handler and
        // operation/audit commit, so a committed revoke cannot slip between
        // the final check and dispatch.
        const dispatchCapability = await this.prepareCapabilityDispatch(
          input.request,
          action,
          actionCapabilityId(action),
          targets,
          transaction,
        );
        const locked = await this.store.getOperation({
          tenantId: operation.tenantId,
          sessionId: operation.sessionId,
          operationId: operation.id,
          forUpdate: true,
          transaction,
        });
        if (!locked) throw new OperationNotFoundError();
        if (locked.status === "succeeded") {
          return { kind: "succeeded", operation: locked, result: locked.result ?? {} };
        }
        if (locked.status !== "executing") {
          return {
            kind: "error",
            error: new RuntimeActionError("ACTION_OPERATION_CLOSED", "action operation is not executing", 409),
            handled: true,
          };
        }
        if (dispatchCapability && !dispatchCapability.allowed) {
          throw new ActionForbiddenError(dispatchCapability.publicReason ?? "capability is not enabled", {
            reason: dispatchCapability.reason ?? "capability_denied",
            capabilityId: actionCapabilityId(action),
          });
        }
        // Resolve/authorize and operation creation happen in an earlier
        // transaction.  Re-check the live context while this execution lock
        // is held and immediately before dispatch so a revoke that wins the
        // race cannot still reach a query handler (or a no-confirmation
        // mutation handler).
        await this.assertFresh(input.request, transaction);
        const finalCapabilityId = actionCapabilityId(action);
        for (const target of targets) {
          const capability = await this.capabilityDecision(input.request, action, finalCapabilityId, target, transaction);
          if (!capability.allowed) {
            throw new ActionForbiddenError(capability.publicReason ?? "capability is not enabled", {
              reason: capability.reason ?? "capability_denied",
              capabilityId: finalCapabilityId,
              target,
            });
          }
          const decision = await this.authorization.authorize({ request: input.request, action, target });
          if (!decision.allowed) {
            throw new ActionForbiddenError(decision.publicReason, {
              reason: decision.reason,
              deniedScopes: decision.deniedScopes,
              target: decision.target,
            });
          }
        }
        // The handler receives the same transaction that owns the operation
        // state and audit event, so a successful business write commits as one
        // durable unit with its succeeded result.
        const result = await action.handler.execute({
          request: { ...input.request, authorizationVersion },
          action,
          operation: locked,
          transaction,
        }, args, targets);
        const succeeded = await this.store.updateOperationIfStatus(
          locked.tenantId,
          locked.id,
          ["executing"],
          { status: "succeeded", result, executedAt: this.now().toISOString() },
          transaction,
        );
        if (!succeeded) {
          const latest = await this.store.getOperation({
            tenantId: locked.tenantId,
            sessionId: locked.sessionId,
            operationId: locked.id,
            forUpdate: true,
            transaction,
          });
          if (latest?.status === "succeeded") {
            return { kind: "succeeded", operation: latest, result: latest.result ?? {} };
          }
          return {
            kind: "error",
            error: new OutcomeUnknownError("action result was produced but the operation state was already changed"),
            handled: true,
          };
        }
        await this.store.appendEvent({ operationId: succeeded.id, tenantId: succeeded.tenantId, sequence: 2, eventType: "succeeded", payload: { result } }, transaction);
        return { kind: "succeeded", operation: succeeded, result };
      });
      if (completed.kind === "error") {
        handledInsideTransaction = completed.handled;
        throw completed.error;
      }
      return { status: "succeeded", operationId: completed.operation.id, result: completed.result, authorizationVersion };
    } catch (error) {
      if (handledInsideTransaction) throw error;
      const outcomeUnknown = error instanceof OutcomeUnknownError;
      const code = publicErrorCode(error);
      const message = error instanceof Error ? error.message : "action execution failed";
      try {
        const outcome = await this.store.withTransaction<ActionRunResult | null>(async (transaction) => {
          const current = await this.store.getOperation({
            tenantId: operation.tenantId,
            sessionId: operation.sessionId,
            operationId: operation.id,
            forUpdate: true,
            transaction,
          });
          if (!current) return null;
          if (current.status === "succeeded") {
            return { status: "succeeded", operationId: current.id, result: current.result ?? {}, authorizationVersion };
          }
          if (current.status !== "executing") return null;
          const finalized = await this.store.updateOperationIfStatus(
            current.tenantId,
            current.id,
            ["executing"],
            { status: outcomeUnknown ? "outcome_unknown" : "failed", errorCode: code, errorMessage: message },
            transaction,
          );
          if (!finalized) {
            // A test double or a store whose transaction boundary was lost
            // may report a CAS miss after another worker committed success.
            // Re-read before surfacing the original error so cleanup can
            // never hide that winner.
            const latest = await this.store.getOperation({
              tenantId: current.tenantId,
              sessionId: current.sessionId,
              operationId: current.id,
              forUpdate: true,
              transaction,
            });
            if (latest?.status === "succeeded") {
              return { status: "succeeded", operationId: latest.id, result: latest.result ?? {}, authorizationVersion };
            }
            return null;
          }
          await this.store.appendEvent({
            operationId: finalized.id,
            tenantId: finalized.tenantId,
            sequence: 2,
            eventType: outcomeUnknown ? "outcome_unknown" : "failed",
            payload: { code, message },
          }, transaction);
          return null;
        });
        if (outcome) return outcome;
      } catch {
        // Never trade a committed success for a cleanup error.
        const latest = await this.store.getOperation({
          tenantId: operation.tenantId,
          sessionId: operation.sessionId,
          operationId: operation.id,
        }).catch(() => null);
        if (latest?.status === "succeeded") {
          return { status: "succeeded", operationId: latest.id, result: latest.result ?? {}, authorizationVersion };
        }
      }
      throw error;
    }
  }

  private async finalizeConfirmError(
    input: { request: ActionRequestContext; operationId: string },
    error: unknown,
    allowWaitingState: boolean,
  ): Promise<ActionRunResult | null> {
    try {
      const outcome = await this.store.withTransaction<ActionRunResult | null>(async (transaction) => {
        const current = await this.store.getOperation({
          tenantId: input.request.tenantId,
          sessionId: input.request.sessionId,
          operationId: input.operationId,
          forUpdate: true,
          transaction,
        });
        if (!current) return null;
        if (current.status === "succeeded") {
          return { status: "succeeded", operationId: current.id, result: current.result ?? {}, authorizationVersion: input.request.authorizationVersion };
        }

        const waiting = current.status === "awaiting_confirmation" || current.status === "ready";
        if (current.status !== "executing" && (!allowWaitingState || !waiting)) return null;
        const expectedStatuses: ActionOperation["status"][] = current.status === "executing"
          ? ["executing"]
          : ["awaiting_confirmation", "ready"];
        const sequence = current.status === "executing" ? 3 : 2;
        const outcomeUnknown = error instanceof OutcomeUnknownError;
        const code = publicErrorCode(error);
        const message = error instanceof Error ? error.message : "action execution failed";
        const finalized = await this.store.updateOperationIfStatus(
          current.tenantId,
          current.id,
          expectedStatuses,
          { status: outcomeUnknown ? "outcome_unknown" : "failed", errorCode: code, errorMessage: message },
          transaction,
        );
        if (!finalized) {
          const latest = await this.store.getOperation({
            tenantId: current.tenantId,
            sessionId: current.sessionId,
            operationId: current.id,
            forUpdate: true,
            transaction,
          });
          if (latest?.status === "succeeded") {
            return { status: "succeeded", operationId: latest.id, result: latest.result ?? {}, authorizationVersion: input.request.authorizationVersion };
          }
          return null;
        }
        await this.store.appendEvent({
          operationId: finalized.id,
          tenantId: finalized.tenantId,
          sequence,
          eventType: outcomeUnknown ? "outcome_unknown" : "failed",
          payload: { code, message },
        }, transaction);
        return null;
      });
      return outcome;
    } catch {
      // A failed cleanup must never replace a committed success.  If the
      // cleanup transaction itself failed, a fresh read is the only safe
      // outcome we can expose here.
      const latest = await this.store.getOperation({
        tenantId: input.request.tenantId,
        sessionId: input.request.sessionId,
        operationId: input.operationId,
      }).catch(() => null);
      if (latest?.status === "succeeded") {
        return { status: "succeeded", operationId: latest.id, result: latest.result ?? {}, authorizationVersion: input.request.authorizationVersion };
      }
      return null;
    }
  }

  private async confirmUnlocked(input: { request: ActionRequestContext; operationId: string }): Promise<ActionRunResult> {
    // Resolve the immutable action metadata before entering the transaction.
    // The transaction then takes the tenant capability-delivery lock first,
    // followed by the operation row lock.  This ordering is shared with
    // capability-pack create/update/delete and avoids a dispatch/revoke
    // deadlock while still keeping the lock out of the confirmation wait.
    const preview = await this.store.getOperation({
      tenantId: input.request.tenantId,
      sessionId: input.request.sessionId,
      operationId: input.operationId,
    });
    const previewAction = preview ? this.registry.require(preview.actionId) : null;
    const previewTargets = preview ? targetsFrom(preview.targets) : [];
    let executionStarted = false;
    let handledInsideTransaction = false;
    try {
      const completed = await this.store.withTransaction(async (transaction): Promise<ConfirmTransactionOutcome> => {
        let dispatchCapability: ActionCapabilityDecision | null = null;
        if (preview && (preview.status === "awaiting_confirmation" || preview.status === "ready") && previewAction) {
          dispatchCapability = await this.prepareCapabilityDispatch(
            input.request,
            previewAction,
            actionCapabilityId(previewAction),
            previewTargets,
            transaction,
          );
        }
        const locked = await this.store.getOperation({
          tenantId: input.request.tenantId,
          sessionId: input.request.sessionId,
          operationId: input.operationId,
          forUpdate: true,
          transaction,
        });
        if (!locked) throw new OperationNotFoundError();

        const transition = async (
          expectedStatuses: readonly ActionOperation["status"][],
          patch: Partial<ActionOperation>,
          sequence: number,
          eventType: string,
          payload: JsonObject,
        ): Promise<ActionOperation | null> => {
          const updated = await this.store.updateOperationIfStatus(
            locked.tenantId,
            locked.id,
            expectedStatuses,
            patch,
            transaction,
          );
          if (updated) {
            await this.store.appendEvent({
              operationId: updated.id,
              tenantId: updated.tenantId,
              sequence,
              eventType,
              payload,
            }, transaction);
          }
          return updated;
        };

        const latestAfterCasMiss = async (fallback: unknown): Promise<ConfirmTransactionOutcome> => {
          const latest = await this.store.getOperation({
            tenantId: input.request.tenantId,
            sessionId: input.request.sessionId,
            operationId: input.operationId,
            forUpdate: true,
            transaction,
          });
          if (latest?.status === "succeeded") {
            return { kind: "succeeded", operation: latest, result: latest.result ?? {} };
          }
          return { kind: "error", error: fallback, handled: true };
        };

        // This check intentionally happens after the operation lock.  A
        // stale caller may still hold a syntactically valid assistant session.
        const currentVersion = await this.authorization.authorizationVersion(input.request, transaction);
        if (currentVersion !== input.request.authorizationVersion) {
          return { kind: "error", error: staleContextError(currentVersion), handled: true };
        }
        if (locked.status === "succeeded") {
          return { kind: "succeeded", operation: locked, result: locked.result ?? {} };
        }
        if (locked.status !== "awaiting_confirmation" && locked.status !== "ready") {
          return {
            kind: "error",
            error: new RuntimeActionError("ACTION_OPERATION_CLOSED", "action operation is not awaiting confirmation", 409),
            handled: true,
          };
        }
        if (dispatchCapability && !dispatchCapability.allowed) {
          const stale = await transition(
            ["awaiting_confirmation", "ready"],
            { status: "stale", errorCode: "ACTION_FORBIDDEN", errorMessage: dispatchCapability.publicReason ?? "capability is not enabled" },
            2,
            "stale",
            {
              code: "ACTION_FORBIDDEN",
              reason: dispatchCapability.reason ?? "capability_denied",
              capabilityId: actionCapabilityId(previewAction ?? this.registry.require(locked.actionId)),
            },
          );
          if (!stale) return latestAfterCasMiss(new OperationStaleError("capability is no longer enabled"));
          return {
            kind: "error",
            error: new OperationStaleError("capability is no longer enabled"),
            handled: true,
          };
        }

        const now = this.now();
        if (
          new Date(locked.expiresAt).getTime() <= now.getTime() ||
          (locked.confirmationExpiresAt && new Date(locked.confirmationExpiresAt).getTime() <= now.getTime())
        ) {
          const expired = await transition(
            ["awaiting_confirmation", "ready"],
            { status: "expired", errorCode: "ACTION_CONFIRMATION_EXPIRED", errorMessage: "confirmation window expired" },
            2,
            "expired",
            { code: "ACTION_CONFIRMATION_EXPIRED" },
          );
          if (!expired) return latestAfterCasMiss(new RuntimeActionError("ACTION_CONFIRMATION_EXPIRED", "confirmation window expired", 409));
          return { kind: "error", error: new RuntimeActionError("ACTION_CONFIRMATION_EXPIRED", "confirmation window expired", 409), handled: true };
        }
        if (currentVersion !== locked.authorizationVersion) {
          const stale = await transition(
            ["awaiting_confirmation", "ready"],
            { status: "stale", errorCode: ENTERPRISE_CONTEXT_STALE, errorMessage: "authorization context changed" },
            2,
            "stale",
            { code: ENTERPRISE_CONTEXT_STALE },
          );
          if (!stale) return latestAfterCasMiss(staleContextError(currentVersion));
          return { kind: "error", error: staleContextError(currentVersion), handled: true };
        }

        const action = this.registry.require(locked.actionId);
        if (action.version !== locked.actionVersion) {
          const stale = await transition(
            ["awaiting_confirmation", "ready"],
            { status: "stale", errorCode: "ACTION_VERSION_CONFLICT", errorMessage: "action definition changed" },
            2,
            "stale",
            { code: "ACTION_VERSION_CONFLICT" },
          );
          if (!stale) return latestAfterCasMiss(new OperationStaleError("action definition changed"));
          return { kind: "error", error: new OperationStaleError("action definition changed"), handled: true };
        }

        const operationRequest = { ...input.request, authorizationVersion: locked.authorizationVersion };
        const args = objectArguments(locked.arguments);
        validateSchema(action.inputSchema, args);
        const targets = targetsFrom(await action.handler.resolveTargets(operationRequest, args));
        if (
          targets.length !== locked.targets.length ||
          targets.some(
            (target, index) =>
              target.kind !== (locked.targets[index] as ActionTarget)?.kind ||
              target.id !== (locked.targets[index] as ActionTarget)?.id,
          )
        ) {
          const stale = await transition(
            ["awaiting_confirmation", "ready"],
            { status: "stale", errorCode: "ACTION_TARGET_CHANGED", errorMessage: "action target changed" },
            2,
            "stale",
            { code: "ACTION_TARGET_CHANGED" },
          );
          if (!stale) return latestAfterCasMiss(new OperationStaleError("action target changed"));
          return { kind: "error", error: new OperationStaleError("action target changed"), handled: true };
        }

        const capabilityId = actionCapabilityId(action);
        for (const target of targets) {
          const capability = await this.capabilityDecision(operationRequest, action, capabilityId, target, transaction);
          if (!capability.allowed) {
            const stale = await transition(
              ["awaiting_confirmation", "ready"],
              { status: "stale", errorCode: "ACTION_FORBIDDEN", errorMessage: capability.publicReason ?? "capability is not enabled" },
              2,
              "stale",
              { code: "ACTION_FORBIDDEN", reason: capability.reason ?? "capability_denied", capabilityId },
            );
            if (!stale) return latestAfterCasMiss(new OperationStaleError("capability is no longer enabled", { capabilityId }));
            return {
              kind: "error",
              error: new OperationStaleError("capability is no longer enabled", { capabilityId }),
              handled: true,
            };
          }
        }

        const decisions = [] as Awaited<ReturnType<ActionAuthorization["authorize"]>>[];
        for (const target of targets) {
          const decision = await this.authorization.authorize({ request: operationRequest, action, target });
          decisions.push(decision);
          if (!decision.allowed) {
            const stale = await transition(
              ["awaiting_confirmation", "ready"],
              { status: "stale", errorCode: "ACTION_FORBIDDEN", errorMessage: decision.publicReason },
              2,
              "stale",
              { code: "ACTION_FORBIDDEN", reason: decision.reason },
            );
            if (!stale) return latestAfterCasMiss(new OperationStaleError("authorization no longer permits this action", { reason: decision.reason }));
            return {
              kind: "error",
              error: new OperationStaleError("authorization no longer permits this action", { reason: decision.reason }),
              handled: true,
            };
          }
        }

        const preparedExtra = action.handler.prepare ? await action.handler.prepare(operationRequest, args, targets) : {};
        const prepared: ActionPrepareResult = { ...preparedExtra, targets };
        if (!sameJson(prepared.expectedVersions ?? null, locked.expectedVersions ?? null)) {
          const stale = await transition(
            ["awaiting_confirmation", "ready"],
            { status: "stale", errorCode: "ACTION_VERSION_CONFLICT", errorMessage: "target version changed" },
            2,
            "stale",
            { code: "ACTION_VERSION_CONFLICT" },
          );
          if (!stale) return latestAfterCasMiss(new OperationStaleError("target version changed"));
          return { kind: "error", error: new OperationStaleError("target version changed"), handled: true };
        }

        // Authorization can change while target resolution and preparation
        // are running.  Recheck the version immediately before execution,
        // still under the operation lock.
        const beforeExecuteVersion = await this.authorization.authorizationVersion(operationRequest, transaction);
        if (beforeExecuteVersion !== input.request.authorizationVersion || beforeExecuteVersion !== locked.authorizationVersion) {
          const stale = await transition(
            ["awaiting_confirmation", "ready"],
            { status: "stale", errorCode: ENTERPRISE_CONTEXT_STALE, errorMessage: "authorization context changed" },
            2,
            "stale",
            { code: ENTERPRISE_CONTEXT_STALE },
          );
          if (!stale) return latestAfterCasMiss(staleContextError(beforeExecuteVersion));
          return { kind: "error", error: staleContextError(beforeExecuteVersion), handled: true };
        }

        // The version check above closes the context race; repeat both live
        // gates at the dispatch boundary as well.  Capability revocation may
        // be maintained by a pack catalog whose revision is independent of
        // the IAM version, so checking only authorizationVersion is not
        // sufficient.
        for (const target of targets) {
          const finalCapability = await this.capabilityDecision(operationRequest, action, capabilityId, target, transaction);
          if (!finalCapability.allowed) {
            const stale = await transition(
              ["awaiting_confirmation", "ready"],
              { status: "stale", errorCode: "ACTION_FORBIDDEN", errorMessage: finalCapability.publicReason ?? "capability is not enabled" },
              2,
              "stale",
              { code: "ACTION_FORBIDDEN", reason: finalCapability.reason ?? "capability_denied", capabilityId },
            );
            if (!stale) return latestAfterCasMiss(new OperationStaleError("capability is no longer enabled", { capabilityId }));
            return {
              kind: "error",
              error: new OperationStaleError("capability is no longer enabled", { capabilityId }),
              handled: true,
            };
          }
          const finalDecision = await this.authorization.authorize({ request: operationRequest, action, target });
          if (!finalDecision.allowed) {
            const stale = await transition(
              ["awaiting_confirmation", "ready"],
              { status: "stale", errorCode: "ACTION_FORBIDDEN", errorMessage: finalDecision.publicReason },
              2,
              "stale",
              { code: "ACTION_FORBIDDEN", reason: finalDecision.reason },
            );
            if (!stale) return latestAfterCasMiss(new OperationStaleError("authorization no longer permits this action", { reason: finalDecision.reason }));
            return {
              kind: "error",
              error: new OperationStaleError("authorization no longer permits this action", { reason: finalDecision.reason }),
              handled: true,
            };
          }
        }

        const executing = await transition(
          ["awaiting_confirmation", "ready"],
          {
            status: "executing",
            confirmedByUserId: input.request.userId,
            authorizationSnapshot: authorizationSnapshot(decisions),
          },
          2,
          "confirmed",
          { confirmedByUserId: input.request.userId },
        );
        if (!executing) {
          return latestAfterCasMiss(new RuntimeActionError("ACTION_OPERATION_CLOSED", "action operation is not awaiting confirmation", 409));
        }
        executionStarted = true;

        // Let handler failures abort this transaction.  In particular, a
        // handler may have performed a business write before discovering a
        // validation or database error; committing a failed operation here
        // would commit that partial write as well.  The outer catch finalizes
        // the post-rollback waiting state with a CAS.
        const result = await action.handler.execute({ request: operationRequest, action, operation: executing, transaction }, args, targets);
        const succeeded = await this.store.updateOperationIfStatus(
          executing.tenantId,
          executing.id,
          ["executing"],
          { status: "succeeded", result, executedAt: this.now().toISOString() },
          transaction,
        );
        if (!succeeded) return latestAfterCasMiss(new OutcomeUnknownError("action result was produced but the operation state was already changed"));
        await this.store.appendEvent({ operationId: succeeded.id, tenantId: succeeded.tenantId, sequence: 3, eventType: "succeeded", payload: { result } }, transaction);
        return { kind: "succeeded", operation: succeeded, result };
      });

      if (completed.kind === "error") {
        handledInsideTransaction = completed.handled;
        throw completed.error;
      }
      return { status: "succeeded", operationId: completed.operation.id, result: completed.result, authorizationVersion: input.request.authorizationVersion };
    } catch (error) {
      if (handledInsideTransaction) throw error;
      const replay = await this.finalizeConfirmError(input, error, executionStarted);
      if (replay) return replay;
      throw error;
    }
  }

  public async confirm(input: { request: ActionRequestContext; operationId: string }): Promise<ActionRunResult> {
    const previous = this.confirmationLocks.get(input.operationId);
    if (previous) await previous.catch(() => undefined);
    const run = this.confirmUnlocked(input);
    this.confirmationLocks.set(input.operationId, run);
    try {
      return await run;
    } finally {
      if (this.confirmationLocks.get(input.operationId) === run) this.confirmationLocks.delete(input.operationId);
    }
  }

  public async getOperation(input: { request: ActionRequestContext; operationId: string }): Promise<ActionOperationView> {
    await this.assertFresh(input.request);
    const operation = await this.store.getOperation({ tenantId: input.request.tenantId, sessionId: input.request.sessionId, operationId: input.operationId });
    if (!operation) throw new OperationNotFoundError();
    return { ...operation, events: await this.store.listEvents({ tenantId: operation.tenantId, sessionId: operation.sessionId, operationId: operation.id }) };
  }
}

export { stableJson as stableActionJson, sha256 as hashActionArguments };
