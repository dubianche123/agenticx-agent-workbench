import { describe, expect, it, vi } from "vitest";
import { createEnterpriseActionDefinitions } from "../actions";
import {
  normalizeQuotaRuleInput,
  parseUsageAnalyticsArgs,
  validateExcludedGroupModelIdsInput,
  validateModelIdsInput,
  type EnterpriseDomain,
} from "../domain";
import type {
  ActionDefinition,
  ActionHandlerContext,
  ActionOperation,
  ActionRequestContext,
  JsonObject,
} from "@agenticx/action-runtime";

const request: ActionRequestContext = {
  tenantId: "tenant-a",
  userId: "user-a",
  agentPrincipalId: "agent-a",
  sessionId: "session-a",
  permissionMode: "ask",
  authorizationVersion: "auth-v1",
  principal: {
    id: "principal-user-a",
    tenantId: "tenant-a",
    kind: "user",
    userId: "user-a",
    displayName: "User A",
    status: "active",
    authzVersion: 1,
    agentProfile: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
};

function fakeDomain(): EnterpriseDomain {
  const quotaPreparation = {
    beforeState: { userId: "member-a", rule: {}, version: "quota-v1" },
    afterState: { userId: "member-a", rule: { monthlyTokens: 100 }, version: "quota-v1" },
    expectedVersions: { quotaUpdatedAt: "quota-v1" },
    proposal: { title: "Change quota", changes: { monthlyTokens: 100 } },
  };
  const modelsPreparation = {
    beforeState: { userId: "member-a", modelIds: [], version: "models-v1" },
    afterState: { userId: "member-a", modelIds: ["provider/model"], version: "models-v1" },
    expectedVersions: { modelVersion: "models-v1" },
    proposal: { title: "Change models", changes: { modelIds: ["provider/model"] } },
  };

  return {
    readSelfProfile: vi.fn(async (ctx) => ({ userId: ctx.userId })),
    searchMembers: vi.fn(async (_ctx, query, limit) => ({ items: [{ query, limit }] })),
    readQuota: vi.fn(async (_ctx, userId) => ({ userId })),
    readModels: vi.fn(async (_ctx, userId) => ({ userId })),
    readGatewayHealth: vi.fn(async () => ({ status: "healthy" })),
    readUsageSummary: vi.fn(async () => ({ total: 0 })),
    readUsageAnalytics: vi.fn(async (_ctx, args) => ({ args })),
    readAuditEvents: vi.fn(async (_ctx, limit) => ({ items: [], limit })),
    readEnterpriseOverview: vi.fn(async () => ({ tenant: "tenant-a" })),
    prepareQuotaMutation: vi.fn(async () => quotaPreparation),
    setQuotaMutation: vi.fn(async (_ctx, args) => ({ applied: args })),
    prepareModelsMutation: vi.fn(async () => modelsPreparation),
    setModelsMutation: vi.fn(async (_ctx, args) => ({ applied: args })),
  };
}

function byId(definitions: readonly ActionDefinition[]): Map<string, ActionDefinition> {
  return new Map(definitions.map((definition) => [definition.id, definition]));
}

const operation: ActionOperation = {
  id: "operation-a",
  tenantId: "tenant-a",
  sessionId: "session-a",
  actorUserId: "user-a",
  agentPrincipalId: "agent-a",
  representedUserId: "user-a",
  actionId: "member.quota.set",
  actionVersion: 1,
  effect: "mutation",
  permissionMode: "ask",
  idempotencyKey: "key-a",
  argumentsHash: "hash-a",
  arguments: {},
  targets: [{ kind: "user", id: "member-a" }],
  beforeState: null,
  afterState: null,
  expectedVersions: null,
  authorizationSnapshot: {},
  authorizationVersion: "auth-v1",
  runId: null,
  status: "executing",
  proposal: null,
  result: null,
  errorCode: null,
  errorMessage: null,
  confirmationExpiresAt: null,
  expiresAt: "2026-09-11T00:00:00.000Z",
  confirmedByUserId: null,
  executedAt: null,
  createdAt: "2026-09-10T00:00:00.000Z",
  updatedAt: "2026-09-10T00:00:00.000Z",
};

function handlerContext(action: ActionDefinition): ActionHandlerContext {
  return { request, action, operation };
}

describe("enterprise action definitions", () => {
  it("requires confirmation for every mutation and never auto-allows a write", () => {
    const definitions = createEnterpriseActionDefinitions(fakeDomain());
    const mutations = definitions.filter((definition) => definition.effect === "mutation");
    const queries = definitions.filter((definition) => definition.effect === "query");

    expect(mutations.map((definition) => definition.id).sort()).toEqual([
      "member.models.set",
      "member.quota.set",
    ]);
    for (const action of mutations) {
      expect(action.policy).toEqual({ requiresConfirmation: true, autoAllowed: false });
    }
    for (const action of queries) {
      expect(action.policy).toEqual({ requiresConfirmation: false, autoAllowed: true });
    }
  });

  it("keeps scopes, schemas, and target resolution explicit for query and write actions", async () => {
    const definitions = createEnterpriseActionDefinitions(fakeDomain());
    const actions = byId(definitions);
    const expectedScopes: Record<string, readonly string[]> = {
      "self.profile.read": ["user:read"],
      "self.quota.read": ["user:read"],
      "member.search": ["user:read"],
      "member.quota.read": ["user:read"],
      "member.models.read": ["user:read"],
      "gateway.health.read": ["gateway:read"],
      "usage.summary.read": ["metering:read"],
      "usage.analytics.read": ["metering:read"],
      "audit.events.read": ["audit:read:all"],
      "enterprise.overview.read": ["user:read", "gateway:read", "metering:read"],
      "member.quota.set": ["user:quota:update"],
      "member.models.set": ["user:models:update"],
    };

    for (const [actionId, scopes] of Object.entries(expectedScopes)) {
      expect(actions.get(actionId)?.requiredScopes).toEqual(scopes);
      expect(actions.get(actionId)?.inputSchema.additionalProperties).toBe(false);
    }

    expect(actions.get("member.search")?.inputSchema).toMatchObject({
      required: ["q"],
      properties: { q: { type: "string", minLength: 1 }, limit: { type: "number" } },
    });
    expect(actions.get("member.quota.set")?.inputSchema).toMatchObject({
      required: ["userId"],
      properties: { userId: { type: "string", minLength: 1 } },
    });
    expect(actions.get("member.models.set")?.inputSchema).toMatchObject({
      required: ["userId", "modelIds"],
      properties: { userId: { type: "string", minLength: 1 }, modelIds: { type: "array" } },
    });
    expect(actions.get("usage.analytics.read")?.inputSchema).toMatchObject({
      properties: { groupBy: { enum: ["user", "department", "model"] }, limit: { minimum: 1, maximum: 100 } },
    });

    const search = actions.get("member.search")!;
    const quotaSet = actions.get("member.quota.set")!;
    const modelsSet = actions.get("member.models.set")!;
    expect(search.capabilityTargets?.(request)).toEqual([{ kind: "user", id: "user-a" }]);
    expect(await search.handler.resolveTargets(request, { q: "alice" })).toEqual([{ kind: "user", id: "user-a" }]);
    expect(await quotaSet.handler.resolveTargets(request, { userId: " member-b", monthlyTokens: 10 })).toEqual([{ kind: "user", id: "member-b" }]);
    expect(await modelsSet.handler.resolveTargets(request, { userId: "member-c", modelIds: [] })).toEqual([{ kind: "user", id: "member-c" }]);
    expect(search.capabilityTargets?.(request)).not.toContainEqual({ kind: "tenant", id: "tenant-a" });
  });

  it("forwards action execution to the tenant-scoped domain with the operation context", async () => {
    const domain = fakeDomain();
    const actions = byId(createEnterpriseActionDefinitions(domain));
    const search = actions.get("member.search")!;
    const quotaSet = actions.get("member.quota.set")!;
    const searchArgs = { q: "alice", limit: 5 };
    const quotaArgs = { userId: "member-a", monthlyTokens: 100 };

    await search.handler.execute(handlerContext(search), searchArgs, [{ kind: "user", id: "user-a" }]);
    await quotaSet.handler.execute(handlerContext(quotaSet), quotaArgs, [{ kind: "user", id: "member-a" }]);

    expect(domain.searchMembers).toHaveBeenCalledWith(request, "alice", 5);
    expect(domain.setQuotaMutation).toHaveBeenCalledWith(expect.objectContaining({ request, action: quotaSet, operation }), quotaArgs, operation);
  });
});

describe("enterprise mutation input boundaries", () => {
  it("normalizes and bounds model identifiers without touching a database", () => {
    expect(validateModelIdsInput({ modelIds: [" provider/a ", "provider/a", ""] })).toEqual(["provider/a"]);
    expect(validateExcludedGroupModelIdsInput({ excludedGroupModelIds: ["group/b", " group/a", "group/b"] })).toEqual(["group/a", "group/b"]);
    expect(validateExcludedGroupModelIdsInput({})).toBeNull();

    expect(() => validateModelIdsInput({})).toThrow("modelIds is required");
    expect(() => validateModelIdsInput({ modelIds: ["provider/a", 1] })).toThrow("modelIds must contain only strings");
    expect(() => validateExcludedGroupModelIdsInput({ excludedGroupModelIds: ["group/a", false] })).toThrow("excludedGroupModelIds must contain only strings");
    expect(() => validateModelIdsInput({ modelIds: Array.from({ length: 501 }, (_, index) => `provider/${index}`) })).toThrow("modelIds exceeds the maximum size");
  });

  it("normalizes quota rules and rejects unsafe values", () => {
    expect(normalizeQuotaRuleInput({ monthlyTokens: 12.9, rpm: "3", poolScope: "dept", action: "warn", ignored: true })).toEqual({
      monthlyTokens: 12,
      rpm: 3,
      poolScope: "dept",
      action: "warn",
    });
    expect(normalizeQuotaRuleInput({ rule: { dailyTokens: 7.8, ignored: "secret" } })).toEqual({ dailyTokens: 7 });

    for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648]) {
      expect(() => normalizeQuotaRuleInput({ monthlyTokens: value })).toThrow("must be a non-negative finite number");
    }
    expect(() => normalizeQuotaRuleInput({ action: "drop" })).toThrow("action must be block, warn, or fallback");
    expect(() => normalizeQuotaRuleInput({ poolScope: "user" })).toThrow("poolScope is invalid");
  });

  it("normalizes bounded usage analytics ranges and dimensions", () => {
    const now = new Date("2026-09-11T12:00:00.000Z");
    expect(parseUsageAnalyticsArgs({ limit: 3, groupBy: "model", metric: "costUsd", order: "asc" }, now)).toEqual({
      start: "2026-09-01T00:00:00.000Z",
      end: now.toISOString(),
      timezone: "UTC",
      groupBy: "model",
      metric: "costUsd",
      order: "asc",
      limit: 3,
    });
    expect(() => parseUsageAnalyticsArgs({ limit: 0 }, now)).toThrow("limit must be an integer");
    expect(() => parseUsageAnalyticsArgs({ groupBy: "provider" }, now)).toThrow("groupBy must be");
    expect(() => parseUsageAnalyticsArgs({ start: "09/01/2026" }, now)).toThrow("start must be an ISO date");
    expect(() => parseUsageAnalyticsArgs({ unsupported: true }, now)).toThrow("arguments.unsupported is not allowed");
    expect(() => parseUsageAnalyticsArgs({ start: "2025-01-01", end: "2026-09-11" }, now)).toThrow("cannot exceed 366 days");
    expect(() => parseUsageAnalyticsArgs({ end: "2026-09-12" }, now)).toThrow("end cannot be in the future");
  });
});
