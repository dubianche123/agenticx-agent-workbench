import type {
  ActionDefinition,
  ActionHandlerContext,
  ActionRequestContext,
  ActionTarget,
  JsonObject,
} from "@agenticx/action-runtime";
import { createEnterpriseDomain, type EnterpriseDomain } from "./domain";

const EMPTY_SCHEMA: JsonObject = { type: "object", properties: {}, additionalProperties: false };

const USAGE_ANALYTICS_SCHEMA: JsonObject = {
  type: "object",
  properties: {
    start: { type: "string" },
    end: { type: "string" },
    groupBy: { type: "string", enum: ["user", "department", "model"] },
    metric: {
      type: "string",
      enum: [
        "totalTokens",
        "inputTokens",
        "outputTokens",
        "cachedTokens",
        "cacheReadInputTokens",
        "cacheCreationInputTokens",
        "reasoningTokens",
        "costUsd",
      ],
    },
    order: { type: "string", enum: ["asc", "desc"] },
    limit: { type: "number", minimum: 1, maximum: 100 },
  },
  additionalProperties: false,
};

function target(kind: string, id: string): ActionTarget {
  return { kind, id };
}

function contextRequest(context: ActionHandlerContext): ActionRequestContext {
  return context.request;
}

function queryAction(input: {
  id: string;
  label: string;
  description: string;
  requiredScopes: readonly string[];
  inputSchema?: JsonObject;
  capabilityTargets?: (request: ActionRequestContext) => ActionTarget[];
  resolveTargets: (request: ActionRequestContext, args: JsonObject) => Promise<ActionTarget[]>;
  execute: (request: ActionRequestContext, args: JsonObject) => Promise<JsonObject>;
}): ActionDefinition {
  return {
    id: input.id,
    version: 1,
    label: input.label,
    description: input.description,
    effect: "query",
    requiredScopes: input.requiredScopes,
    inputSchema: input.inputSchema ?? EMPTY_SCHEMA,
    capabilityTargets: input.capabilityTargets,
    policy: { requiresConfirmation: false, autoAllowed: true },
    handler: {
      resolveTargets: input.resolveTargets,
      execute: async (context, args) => input.execute(contextRequest(context), args),
    },
  };
}

function mutationAction(input: {
  id: string;
  label: string;
  description: string;
  requiredScopes: readonly string[];
  inputSchema: JsonObject;
  capabilityTargets?: (request: ActionRequestContext) => ActionTarget[];
  resolveTargets: (request: ActionRequestContext, args: JsonObject) => Promise<ActionTarget[]>;
  prepare: (request: ActionRequestContext, args: JsonObject) => Promise<{ beforeState: JsonObject; afterState: JsonObject; expectedVersions: JsonObject; proposal: JsonObject }>;
  execute: (context: ActionHandlerContext, args: JsonObject) => Promise<JsonObject>;
}): ActionDefinition {
  return {
    id: input.id,
    version: 1,
    label: input.label,
    description: input.description,
    effect: "mutation",
    requiredScopes: input.requiredScopes,
    inputSchema: input.inputSchema,
    capabilityTargets: input.capabilityTargets,
    policy: { requiresConfirmation: true, autoAllowed: false },
    handler: {
      resolveTargets: input.resolveTargets,
      prepare: async (request, args, _targets) => input.prepare(request, args),
      execute: async (context, args) => input.execute(context, args),
    },
  };
}

export function createEnterpriseActionDefinitions(domain: EnterpriseDomain = createEnterpriseDomain()): ActionDefinition[] {
  const self = (request: ActionRequestContext): ActionTarget[] => [target("user", request.userId)];
  const tenant = (request: ActionRequestContext): ActionTarget[] => [target("tenant", request.tenantId)];
  const member = (_request: ActionRequestContext, args: JsonObject): ActionTarget[] => [target("user", typeof args.userId === "string" ? args.userId.trim() : "")];

  return [
    queryAction({
      id: "self.profile.read",
      label: "查看我的资料",
      description: "查看当前登录企业成员的资料。",
      requiredScopes: ["user:read"],
      resolveTargets: async (request) => self(request),
      capabilityTargets: self,
      execute: (request) => domain.readSelfProfile(request),
    }),
    queryAction({
      id: "self.quota.read",
      label: "查看我的额度",
      description: "查看当前成员的日、周、月额度和共享额度状态。",
      requiredScopes: ["user:read"],
      resolveTargets: async (request) => self(request),
      capabilityTargets: self,
      execute: (request) => domain.readQuota(request, request.userId),
    }),
    queryAction({
      id: "member.search",
      label: "搜索企业成员",
      description: "按公开身份字段搜索当前企业成员，并按授权范围过滤。",
      requiredScopes: ["user:read"],
      inputSchema: { type: "object", required: ["q"], properties: { q: { type: "string", minLength: 1 }, limit: { type: "number" } }, additionalProperties: false },
      // A tenant target would reject department/self bindings before the
      // domain has a chance to apply the per-member visibility filter.  The
      // actor's own user target is a trusted representative target for
      // capability discovery; searchMembers still authorizes each returned
      // member before projecting it.
      resolveTargets: async (request) => self(request),
      capabilityTargets: self,
      execute: (request, args) => domain.searchMembers(request, String(args.q), typeof args.limit === "number" ? args.limit : 20),
    }),
    queryAction({
      id: "member.quota.read",
      label: "查看成员额度",
      description: "查看指定成员的当前额度和用量窗口。",
      requiredScopes: ["user:read"],
      inputSchema: { type: "object", required: ["userId"], properties: { userId: { type: "string", minLength: 1 } }, additionalProperties: false },
      resolveTargets: async (request, args) => member(request, args),
      capabilityTargets: self,
      execute: (request, args) => domain.readQuota(request, String(args.userId)),
    }),
    queryAction({
      id: "member.models.read",
      label: "查看成员模型权限",
      description: "查看指定成员明确分配、继承和排除后的可用模型。",
      requiredScopes: ["user:read"],
      inputSchema: { type: "object", required: ["userId"], properties: { userId: { type: "string", minLength: 1 } }, additionalProperties: false },
      resolveTargets: async (request, args) => member(request, args),
      capabilityTargets: self,
      execute: (request, args) => domain.readModels(request, String(args.userId)),
    }),
    queryAction({
      id: "gateway.health.read",
      label: "查看网关状态",
      description: "查看企业网关的受限健康探测结果。",
      requiredScopes: ["gateway:read"],
      resolveTargets: async (request) => tenant(request),
      capabilityTargets: tenant,
      execute: (request) => domain.readGatewayHealth(request),
    }),
    queryAction({
      id: "usage.summary.read",
      label: "查看用量摘要",
      description: "查看当前成员的用量摘要。",
      requiredScopes: ["metering:read"],
      resolveTargets: async (request) => self(request),
      capabilityTargets: self,
      execute: (request) => domain.readUsageSummary(request),
    }),
    queryAction({
      id: "usage.analytics.read",
      label: "分析企业用量",
      description: "按用户、部门或模型在当前授权数据范围内聚合指定时间段用量，默认本月 UTC，返回 Top N；不会返回未授权成员或原始 usage 行。示例：本月谁的 Token 最多。",
      requiredScopes: ["metering:read"],
      inputSchema: USAGE_ANALYTICS_SCHEMA,
      resolveTargets: async (request) => self(request),
      capabilityTargets: self,
      execute: (request, args) => domain.readUsageAnalytics(request, args),
    }),
    queryAction({
      id: "audit.events.read",
      label: "查看审计记录",
      description: "查看近期企业审计记录，敏感字段会被隐藏。",
      requiredScopes: ["audit:read:all"],
      inputSchema: { type: "object", properties: { limit: { type: "number" } }, additionalProperties: false },
      resolveTargets: async (request) => tenant(request),
      capabilityTargets: tenant,
      execute: (request, args) => domain.readAuditEvents(request, typeof args.limit === "number" ? args.limit : 100),
    }),
    queryAction({
      id: "enterprise.overview.read",
      label: "查看企业概览",
      description: "查看企业成员、服务商、网关和近期用量汇总。",
      requiredScopes: ["user:read", "gateway:read", "metering:read"],
      resolveTargets: async (request) => tenant(request),
      capabilityTargets: tenant,
      execute: (request) => domain.readEnterpriseOverview(request),
    }),
    mutationAction({
      id: "member.quota.set",
      label: "调整成员额度",
      description: "准备并确认一名成员的额度调整。",
      requiredScopes: ["user:quota:update"],
      inputSchema: {
        type: "object",
        required: ["userId"],
        properties: {
          userId: { type: "string", minLength: 1 },
          rule: { type: "object" },
          inherit: { type: "boolean" },
          expectedVersion: { type: "string" },
          expectedUpdatedAt: { type: "string" },
          monthlyTokens: { type: "number" },
          dailyTokens: { type: "number" },
          weeklyTokens: { type: "number" },
          tpm: { type: "number" },
          rpm: { type: "number" },
          maxConcurrency: { type: "number" },
          requestsPerDay: { type: "number" },
          requestsPerWeek: { type: "number" },
          requestsPerMonth: { type: "number" },
          poolScope: { type: "string" },
          action: { type: "string" },
        },
        additionalProperties: false,
      },
      resolveTargets: async (request, args) => member(request, args),
      capabilityTargets: self,
      prepare: (request, args) => domain.prepareQuotaMutation(request, args),
      execute: (context, args) => domain.setQuotaMutation(context, args, context.operation),
    }),
    mutationAction({
      id: "member.models.set",
      label: "调整成员模型权限",
      description: "准备并确认一名成员的可用模型权限调整。",
      requiredScopes: ["user:models:update"],
      inputSchema: {
        type: "object",
        required: ["userId", "modelIds"],
        properties: { userId: { type: "string", minLength: 1 }, modelIds: { type: "array" }, excludedGroupModelIds: { type: "array" }, expectedVersion: { type: "string" }, expectedModelVersion: { type: "string" } },
        additionalProperties: false,
      },
      resolveTargets: async (request, args) => member(request, args),
      capabilityTargets: self,
      prepare: (request, args) => domain.prepareModelsMutation(request, args),
      execute: (context, args) => domain.setModelsMutation(context, args, context.operation),
    }),
  ];
}
