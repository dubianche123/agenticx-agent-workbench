import { beforeEach, describe, expect, it } from "vitest";
import { ActionRegistry } from "../registry";
import {
  ActionRuntime,
  ENTERPRISE_CONTEXT_STALE,
  MemoryActionStore,
  RuntimeActionError,
} from "../index";
import type { ActionAuthorization, ActionDefinition, ActionRequestContext } from "../types";

const principal = {
  id: "principal-user-a",
  tenantId: "tenant-a",
  kind: "user" as const,
  userId: "user-a",
  displayName: "User A",
  status: "active" as const,
  authzVersion: 1,
  agentProfile: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function request(permissionMode: ActionRequestContext["permissionMode"] = "ask"): ActionRequestContext {
  return {
    tenantId: "tenant-a",
    userId: "user-a",
    agentPrincipalId: "agent-a",
    sessionId: "session-a",
    permissionMode,
    authorizationVersion: "v1",
    principal,
  };
}

function allowedAuthorization(currentVersion: () => string): ActionAuthorization {
  return {
    authorizationVersion: async () => currentVersion(),
    authorize: async ({ action, target }) => ({
      allowed: true,
      reason: "allowed" as const,
      publicReason: "allowed",
      requiredScopes: [...action.requiredScopes],
      deniedScopes: [],
      matchedPermissions: [],
      target,
    }),
  };
}

function definitions(executions: { read: number; write: number } ): ActionDefinition[] {
  return [
    {
      id: "self.read",
      version: 1,
      label: "Read",
      description: "Read a value",
      effect: "query",
      requiredScopes: ["user:read"],
      inputSchema: { type: "object", additionalProperties: false },
      policy: { requiresConfirmation: false, autoAllowed: true },
      handler: {
        resolveTargets: async (ctx) => [{ kind: "user", id: ctx.userId }],
        execute: async () => {
          executions.read += 1;
          return { value: "ok" };
        },
      },
    },
    {
      id: "member.write",
      version: 1,
      label: "Write",
      description: "Write one value",
      effect: "mutation",
      requiredScopes: ["user:quota:update"],
      inputSchema: {
        type: "object",
        required: ["targetId", "value"],
        properties: { targetId: { type: "string", minLength: 1 }, value: { type: "number" } },
        additionalProperties: false,
      },
      policy: { requiresConfirmation: true, autoAllowed: false },
      handler: {
        resolveTargets: async (_ctx, args) => [{ kind: "user", id: String(args.targetId) }],
        prepare: async (_ctx, args) => ({
          beforeState: { value: 1 },
          afterState: { value: args.value },
          expectedVersions: { target: "v1" },
          proposal: { title: "Change value", changes: { value: args.value } },
        }),
        execute: async (_ctx, args) => {
          executions.write += 1;
          return { value: args.value };
        },
      },
    },
  ];
}

describe("ActionRuntime durable lifecycle", () => {
  let store: MemoryActionStore;
  let executions: { read: number; write: number };
  let currentVersion: string;
  let runtime: ActionRuntime;

  beforeEach(() => {
    store = new MemoryActionStore();
    executions = { read: 0, write: 0 };
    currentVersion = "v1";
    runtime = new ActionRuntime({
      registry: new ActionRegistry(definitions(executions)),
      store,
      authorization: allowedAuthorization(() => currentVersion),
    });
  });

  it("executes read actions and replays the same idempotent result", async () => {
    const first = await runtime.run({ request: request("auto"), actionId: "self.read", arguments: {}, idempotencyKey: "read-1" });
    const replay = await runtime.run({ request: request("auto"), actionId: "self.read", arguments: {}, idempotencyKey: "read-1" });

    expect(first).toMatchObject({ status: "succeeded", result: { value: "ok" } });
    expect(replay).toEqual(first);
    expect(executions.read).toBe(1);
    expect([...store.events.values()]).toHaveLength(2);
  });

  it("does not dispatch a query after authorization changes during target resolution", async () => {
    let changed = false;
    const racedStore = new MemoryActionStore();
    const racedRuntime = new ActionRuntime({
      registry: new ActionRegistry(definitions(executions)),
      store: racedStore,
      authorization: {
        authorizationVersion: async () => (changed ? "v2" : "v1"),
        authorize: async ({ action, target }) => {
          changed = true;
          return {
            allowed: true,
            reason: "allowed" as const,
            publicReason: "allowed",
            requiredScopes: [...action.requiredScopes],
            deniedScopes: [],
            matchedPermissions: [],
            target,
          };
        },
      },
    });

    await expect(racedRuntime.run({
      request: request("auto"),
      actionId: "self.read",
      arguments: {},
      idempotencyKey: "query-auth-race",
    })).rejects.toMatchObject({ code: ENTERPRISE_CONTEXT_STALE, stale: true, status: 409 });
    expect(executions.read).toBe(0);
  });

  it("rechecks the live capability immediately before query dispatch", async () => {
    let enabled = true;
    const racedRuntime = new ActionRuntime({
      registry: new ActionRegistry(definitions(executions)),
      store: new MemoryActionStore(),
      authorization: {
        ...allowedAuthorization(() => "v1"),
        capability: {
          authorize: async () => {
            const decision = { allowed: enabled, reason: "capability_not_granted", publicReason: "capability is not enabled" };
            enabled = false;
            return decision;
          },
        },
      },
    });

    await expect(racedRuntime.run({
      request: request("auto"),
      actionId: "self.read",
      arguments: {},
      idempotencyKey: "query-capability-race",
    })).rejects.toMatchObject({ code: "ACTION_FORBIDDEN", status: 403 });
    expect(executions.read).toBe(0);
  });

  it("requires confirmation, persists a proposal, and executes once", async () => {
    const prepared = await runtime.run({
      request: request(),
      actionId: "member.write",
      arguments: { targetId: "member-a", value: 2 },
      idempotencyKey: "write-1",
    });
    expect(prepared.status).toBe("awaiting_confirmation");
    expect(prepared.operationId).toBeTruthy();
    expect(prepared.proposal).toMatchObject({ title: "Change value", changes: { value: 2 } });
    expect(executions.write).toBe(0);

    const replay = await runtime.run({
      request: request(),
      actionId: "member.write",
      arguments: { value: 2, targetId: "member-a" },
      idempotencyKey: "write-1",
    });
    expect(replay).toEqual(prepared);

    const result = await runtime.confirm({ request: request(), operationId: prepared.operationId! });
    expect(result).toMatchObject({ status: "succeeded", result: { value: 2 } });
    expect(executions.write).toBe(1);

    const confirmedReplay = await runtime.confirm({ request: request(), operationId: prepared.operationId! });
    expect(confirmedReplay).toEqual(result);
    expect(executions.write).toBe(1);
  });

  it("rejects changed idempotent arguments and stale confirmation contexts", async () => {
    const prepared = await runtime.run({
      request: request(),
      actionId: "member.write",
      arguments: { targetId: "member-a", value: 2 },
      idempotencyKey: "write-1",
    });
    await expect(runtime.run({
      request: request(),
      actionId: "member.write",
      arguments: { targetId: "member-a", value: 3 },
      idempotencyKey: "write-1",
    })).rejects.toMatchObject({ code: "ACTION_IDEMPOTENCY_CONFLICT", status: 409 });

    currentVersion = "v2";
    await expect(runtime.confirm({ request: request(), operationId: prepared.operationId! }))
      .rejects.toMatchObject({ code: ENTERPRISE_CONTEXT_STALE, stale: true, status: 409 });
    expect(executions.write).toBe(0);
    await expect(runtime.getOperation({ request: request(), operationId: prepared.operationId! }))
      .rejects.toMatchObject({ code: ENTERPRISE_CONTEXT_STALE, stale: true, status: 409 });
  });

  it("keeps plan mode read-only", async () => {
    await expect(runtime.run({
      request: request("plan"),
      actionId: "member.write",
      arguments: { targetId: "member-a", value: 2 },
      idempotencyKey: "write-plan",
    })).rejects.toMatchObject({ code: "PLAN_READ_ONLY", status: 403 });
    expect(executions.write).toBe(0);
    await expect(runtime.run({ request: request("plan"), actionId: "self.read", arguments: {}, idempotencyKey: "read-plan" })).resolves.toMatchObject({ status: "succeeded" });
  });

  it("keeps confirmation-required mutations gated in auto mode", async () => {
    const result = await runtime.run({
      request: request("auto"),
      actionId: "member.write",
      arguments: { targetId: "member-a", value: 2 },
      idempotencyKey: "write-auto-gated",
    });

    expect(result.status).toBe("awaiting_confirmation");
    expect(executions.write).toBe(0);
  });

  it("serializes confirmations across runtime instances and replays the committed result", async () => {
    const sharedStore = new MemoryActionStore();
    const sharedExecutions = { read: 0, write: 0 };
    const sharedDefinitions = definitions(sharedExecutions);
    const writeAction = sharedDefinitions.find((action) => action.id === "member.write")!;
    let firstExecution = true;
    let enteredResolve!: () => void;
    let releaseResolve!: () => void;
    const entered = new Promise<void>((resolve) => {
      enteredResolve = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseResolve = resolve;
    });
    writeAction.handler.execute = async (_ctx, args) => {
      sharedExecutions.write += 1;
      if (firstExecution) {
        firstExecution = false;
        enteredResolve();
        await release;
      }
      return { value: args.value };
    };
    const makeRuntime = () => new ActionRuntime({
      registry: new ActionRegistry(sharedDefinitions),
      store: sharedStore,
      authorization: allowedAuthorization(() => "v1"),
    });
    const firstRuntime = makeRuntime();
    const secondRuntime = makeRuntime();
    const prepared = await firstRuntime.run({
      request: request(),
      actionId: "member.write",
      arguments: { targetId: "member-a", value: 2 },
      idempotencyKey: "write-concurrent",
    });

    const firstConfirm = firstRuntime.confirm({ request: request(), operationId: prepared.operationId! });
    await entered;
    const secondConfirm = secondRuntime.confirm({ request: request(), operationId: prepared.operationId! });
    releaseResolve();
    const [firstResult, secondResult] = await Promise.all([firstConfirm, secondConfirm]);

    expect(firstResult).toMatchObject({ status: "succeeded", result: { value: 2 } });
    expect(secondResult).toEqual(firstResult);
    expect(sharedExecutions.write).toBe(1);
    expect([...sharedStore.events.values()].map((event) => event.eventType)).toEqual(["prepared", "confirmed", "succeeded"]);
  });

  it("does not replace a succeeded operation when a failure CAS loses the race", async () => {
    const prepared = await runtime.run({
      request: request(),
      actionId: "member.write",
      arguments: { targetId: "member-a", value: 2 },
      idempotencyKey: "write-cas",
    });
    const operationId = prepared.operationId!;
    const succeeded = await store.updateOperationIfStatus(
      "tenant-a",
      operationId,
      ["awaiting_confirmation"],
      { status: "succeeded", result: { value: 2 } },
    );
    expect(succeeded?.status).toBe("succeeded");

    const failed = await store.updateOperationIfStatus(
      "tenant-a",
      operationId,
      ["awaiting_confirmation", "ready", "executing"],
      { status: "failed", errorCode: "ACTION_EXECUTION_FAILED", errorMessage: "late failure" },
    );
    expect(failed).toBeNull();
    expect(store.operations.get(operationId)?.status).toBe("succeeded");
    expect(store.operations.get(operationId)?.result).toEqual({ value: 2 });
  });

  it("returns a concurrent success instead of overwriting it after handler failure", async () => {
    const racedStore = new MemoryActionStore();
    const racedExecutions = { read: 0, write: 0 };
    const racedDefinitions = definitions(racedExecutions);
    const originalCas = racedStore.updateOperationIfStatus.bind(racedStore);
    let injected = false;
    racedStore.updateOperationIfStatus = async (...args) => {
      const [tenantId, operationId, expectedStatuses, patch, transaction] = args;
      if (!injected && patch.status === "failed") {
        injected = true;
        const winner = await originalCas(tenantId, operationId, ["awaiting_confirmation", "ready"], { status: "succeeded", result: { value: 9 } }, transaction);
        if (winner) {
          await racedStore.appendEvent({ operationId, tenantId, sequence: 3, eventType: "succeeded", payload: { result: winner.result ?? {} } }, transaction);
        }
        return null;
      }
      return originalCas(tenantId, operationId, expectedStatuses, patch, transaction);
    };
    const racedRuntime = new ActionRuntime({
      registry: new ActionRegistry(racedDefinitions),
      store: racedStore,
      authorization: allowedAuthorization(() => "v1"),
    });
    const writeAction = racedDefinitions.find((action) => action.id === "member.write")!;
    writeAction.handler.execute = async () => {
      racedExecutions.write += 1;
      throw new Error("handler failed after the winner committed");
    };
    const prepared = await racedRuntime.run({
      request: request(),
      actionId: "member.write",
      arguments: { targetId: "member-a", value: 2 },
      idempotencyKey: "write-raced-failure",
    });

    const result = await racedRuntime.confirm({ request: request(), operationId: prepared.operationId! });
    expect(result).toMatchObject({ status: "succeeded", result: { value: 9 } });
    expect(racedStore.operations.get(prepared.operationId!)?.status).toBe("succeeded");
    expect(racedExecutions.write).toBe(1);
  });

  it("rolls back the confirmation transition before CAS-finalizing a handler failure", async () => {
    const failedStore = new MemoryActionStore();
    const failedExecutions = { read: 0, write: 0 };
    const failedDefinitions = definitions(failedExecutions);
    const failedAction = failedDefinitions.find((action) => action.id === "member.write")!;
    failedAction.handler.execute = async () => {
      failedExecutions.write += 1;
      throw new Error("business write failed");
    };
    const failedRuntime = new ActionRuntime({
      registry: new ActionRegistry(failedDefinitions),
      store: failedStore,
      authorization: allowedAuthorization(() => "v1"),
    });
    const prepared = await failedRuntime.run({
      request: request(),
      actionId: "member.write",
      arguments: { targetId: "member-a", value: 2 },
      idempotencyKey: "write-failed",
    });

    await expect(failedRuntime.confirm({ request: request(), operationId: prepared.operationId! }))
      .rejects.toThrow("business write failed");
    expect(failedStore.operations.get(prepared.operationId!)?.status).toBe("failed");
    expect([...failedStore.events.values()].map((event) => event.eventType)).toEqual(["prepared", "failed"]);
    expect(failedExecutions.write).toBe(1);
  });

  it("runs an auto-allowed mutation with the operation and event in one transaction", async () => {
    const autoStore = new MemoryActionStore();
    const autoExecutions = { read: 0, write: 0 };
    const autoDefinitions = definitions(autoExecutions);
    const writeAction = autoDefinitions.find((action) => action.id === "member.write")!;
    writeAction.policy = { requiresConfirmation: false, autoAllowed: true };
    let executionTransaction: unknown;
    writeAction.handler.execute = async (context, args) => {
      executionTransaction = context.transaction;
      autoExecutions.write += 1;
      return { value: args.value };
    };
    const autoRuntime = new ActionRuntime({
      registry: new ActionRegistry(autoDefinitions),
      store: autoStore,
      authorization: allowedAuthorization(() => "v1"),
    });

    const result = await autoRuntime.run({
      request: request("auto"),
      actionId: "member.write",
      arguments: { targetId: "member-a", value: 2 },
      idempotencyKey: "write-auto",
    });
    const operation = autoStore.operations.get(result.operationId!);

    expect(result).toMatchObject({ status: "succeeded", result: { value: 2 } });
    expect(executionTransaction).toMatchObject({ dialect: "postgresql", raw: autoStore });
    expect(operation?.status).toBe("succeeded");
    expect([...autoStore.events.values()].map((event) => event.eventType)).toEqual(["executing", "succeeded"]);
  });

  it("uses the capability gate for discovery and dispatch", async () => {
    let enabled = true;
    const gatedRuntime = new ActionRuntime({
      registry: new ActionRegistry(definitions(executions)),
      store: new MemoryActionStore(),
      authorization: {
        ...allowedAuthorization(() => "v1"),
        capability: {
          authorize: async ({ capabilityId }) => ({
            allowed: enabled,
            reason: enabled ? "allowed" : "capability_not_granted",
            publicReason: enabled ? "allowed" : "capability is not enabled",
          }),
        },
      },
    });

    expect((await gatedRuntime.capabilities(request("auto"))).map((action) => action.id)).toEqual([
      "member.write",
      "self.read",
    ]);
    enabled = false;
    expect(await gatedRuntime.capabilities(request("auto"))).toEqual([]);
    await expect(gatedRuntime.run({
      request: request("auto"),
      actionId: "self.read",
      arguments: {},
      idempotencyKey: "capability-denied",
    })).rejects.toMatchObject({ code: "ACTION_FORBIDDEN", status: 403 });
  });

  it("rechecks a capability before confirming a prepared mutation", async () => {
    let enabled = true;
    const gatedStore = new MemoryActionStore();
    const gatedRuntime = new ActionRuntime({
      registry: new ActionRegistry(definitions(executions)),
      store: gatedStore,
      authorization: {
        ...allowedAuthorization(() => "v1"),
        capability: {
          authorize: async () => ({ allowed: enabled, reason: "capability_not_granted", publicReason: "capability is not enabled" }),
        },
      },
    });
    const prepared = await gatedRuntime.run({
      request: request(),
      actionId: "member.write",
      arguments: { targetId: "member-a", value: 2 },
      idempotencyKey: "capability-confirm-denied",
    });
    enabled = false;

    await expect(gatedRuntime.confirm({ request: request(), operationId: prepared.operationId! }))
      .rejects.toMatchObject({ code: "ACTION_OPERATION_STALE", status: 409 });
    expect(gatedStore.operations.get(prepared.operationId!)?.status).toBe("stale");
    expect(executions.write).toBe(0);
  });

  it("takes the transaction-aware capability gate before a query dispatch", async () => {
    const gatedStore = new MemoryActionStore();
    const executions = { read: 0, write: 0 };
    const definitionsForGate = definitions(executions);
    let gateTransaction: unknown;
    let authorizeTransaction: unknown;
    let handlerTransaction: unknown;
    const readAction = definitionsForGate.find((action) => action.id === "self.read")!;
    readAction.handler.execute = async (context) => {
      handlerTransaction = context.transaction;
      executions.read += 1;
      return { value: "ok" };
    };
    const gatedRuntime = new ActionRuntime({
      registry: new ActionRegistry(definitionsForGate),
      store: gatedStore,
      authorization: {
        ...allowedAuthorization(() => "v1"),
        capability: {
          authorize: async ({ transaction }) => {
            if (transaction) authorizeTransaction = transaction;
            return { allowed: true };
          },
          prepareDispatch: async ({ transaction }) => {
            gateTransaction = transaction;
            return { allowed: true };
          },
          requiresTransactionalDispatch: true,
        },
      },
    });

    await expect(gatedRuntime.run({
      request: request("auto"),
      actionId: "self.read",
      arguments: {},
      idempotencyKey: "query-transactional-gate",
    })).resolves.toMatchObject({ status: "succeeded" });

    expect(gateTransaction).toMatchObject({ dialect: "postgresql", raw: gatedStore });
    expect(authorizeTransaction).toBe(gateTransaction);
    expect(handlerTransaction).toBe(gateTransaction);
    expect(executions.read).toBe(1);
  });

  it("marks a prepared mutation stale when the transaction gate revokes it", async () => {
    let enabled = true;
    const gatedStore = new MemoryActionStore();
    const gatedDefinitions = definitions(executions);
    let gateTransaction: unknown;
    const gatedRuntime = new ActionRuntime({
      registry: new ActionRegistry(gatedDefinitions),
      store: gatedStore,
      authorization: {
        ...allowedAuthorization(() => "v1"),
        capability: {
          authorize: async () => ({ allowed: true }),
          prepareDispatch: async ({ transaction }) => {
            gateTransaction = transaction;
            return enabled
              ? { allowed: true }
              : { allowed: false, reason: "capability_not_granted", publicReason: "capability was revoked" };
          },
          requiresTransactionalDispatch: true,
        },
      },
    });
    const prepared = await gatedRuntime.run({
      request: request(),
      actionId: "member.write",
      arguments: { targetId: "member-a", value: 2 },
      idempotencyKey: "mutation-transactional-gate-revoked",
    });
    enabled = false;

    await expect(gatedRuntime.confirm({ request: request(), operationId: prepared.operationId! }))
      .rejects.toMatchObject({ code: "ACTION_OPERATION_STALE", status: 409 });
    expect(gateTransaction).toMatchObject({ dialect: "postgresql", raw: gatedStore });
    expect(gatedStore.operations.get(prepared.operationId!)?.status).toBe("stale");
    expect(executions.write).toBe(0);
  });

  it("fails closed when a production capability adapter omits its dispatch gate", async () => {
    const gatedStore = new MemoryActionStore();
    const gatedRuntime = new ActionRuntime({
      registry: new ActionRegistry(definitions(executions)),
      store: gatedStore,
      authorization: {
        ...allowedAuthorization(() => "v1"),
        capability: {
          authorize: async () => ({ allowed: true }),
          requiresTransactionalDispatch: true,
        },
      },
    });

    await expect(gatedRuntime.run({
      request: request("auto"),
      actionId: "self.read",
      arguments: {},
      idempotencyKey: "missing-transactional-gate",
    })).rejects.toMatchObject({ code: "ACTION_CAPABILITY_GATE_UNAVAILABLE", status: 503 });
    expect(executions.read).toBe(0);
    const operation = [...gatedStore.operations.values()][0];
    expect(operation?.status).toBe("failed");
  });
});
