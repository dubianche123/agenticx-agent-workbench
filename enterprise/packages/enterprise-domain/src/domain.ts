import {
  auditEvents,
  departments,
  enterpriseUserGroupMembers,
  enterpriseUserGroups,
  enterpriseRuntimeModelProviders,
  enterpriseRuntimeTokenQuotas,
  enterpriseRuntimeUserVisibleModels,
  enterpriseUserOptOuts,
  gatewayChannels,
  usageRecords,
  users,
} from "@agenticx/db-schema";
import {
  auditEvents as mysqlAuditEvents,
  departments as mysqlDepartments,
  enterpriseUserGroupMembers as mysqlEnterpriseUserGroupMembers,
  enterpriseUserGroups as mysqlEnterpriseUserGroups,
  enterpriseRuntimeModelProviders as mysqlEnterpriseRuntimeModelProviders,
  enterpriseRuntimeTokenQuotas as mysqlEnterpriseRuntimeTokenQuotas,
  enterpriseRuntimeUserVisibleModels as mysqlEnterpriseRuntimeUserVisibleModels,
  enterpriseUserOptOuts as mysqlEnterpriseUserOptOuts,
  gatewayChannels as mysqlGatewayChannels,
  usageRecords as mysqlUsageRecords,
  users as mysqlUsers,
} from "@agenticx/db-schema/mysql";
import type {
  ActionHandlerContext,
  ActionOperation,
  ActionRequestContext,
  ActionStoreTransaction,
  JsonObject,
} from "@agenticx/action-runtime";
import {
  createMysqlDb,
  getAdminUser,
  getIamDb,
  getQuotaSummaryForSession,
  getUserAuthorizationContext,
  listAudienceUsers,
  authorizePrincipalAction,
  effectivePermissionsFromBindings,
  getPrincipal,
  hasDelegatedAgentExplicitCeiling,
  listPrincipalRoleBindings,
  resolveDatabaseConfig,
} from "@agenticx/iam-core";
import type { EffectivePermission } from "@agenticx/iam-core";
import { and, asc, desc, eq, gte, inArray, lt, or, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { ulid } from "ulid";

type AnyDb = any;
type DbTables = {
  users: any;
  departments: any;
  groups: any;
  groupMembers: any;
  quotas: any;
  models: any;
  optOuts: any;
  providers: any;
  channels: any;
  usage: any;
  audit: any;
};

function tablesFor(dialect: "postgresql" | "mysql"): DbTables {
  return dialect === "mysql"
    ? {
      users: mysqlUsers,
        departments: mysqlDepartments,
        groups: mysqlEnterpriseUserGroups,
        groupMembers: mysqlEnterpriseUserGroupMembers,
        quotas: mysqlEnterpriseRuntimeTokenQuotas,
        models: mysqlEnterpriseRuntimeUserVisibleModels,
        optOuts: mysqlEnterpriseUserOptOuts,
        providers: mysqlEnterpriseRuntimeModelProviders,
        channels: mysqlGatewayChannels,
        usage: mysqlUsageRecords,
        audit: mysqlAuditEvents,
      }
    : {
      users,
      departments,
      groups: enterpriseUserGroups,
      groupMembers: enterpriseUserGroupMembers,
        quotas: enterpriseRuntimeTokenQuotas,
        models: enterpriseRuntimeUserVisibleModels,
        optOuts: enterpriseUserOptOuts,
        providers: enterpriseRuntimeModelProviders,
        channels: gatewayChannels,
        usage: usageRecords,
        audit: auditEvents,
      };
}

async function dbFor(transaction?: ActionStoreTransaction): Promise<{ dialect: "postgresql" | "mysql"; raw: AnyDb; tables: DbTables }> {
  if (transaction) return { dialect: transaction.dialect, raw: transaction.raw, tables: tablesFor(transaction.dialect) };
  const config = resolveDatabaseConfig();
  if (config.dialect === "mysql") {
    const db = await createMysqlDb(config);
    return { dialect: "mysql", raw: db.raw, tables: tablesFor("mysql") };
  }
  return { dialect: "postgresql", raw: getIamDb(), tables: tablesFor("postgresql") };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function dateIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? new Date(0).toISOString() : parsed.toISOString();
}

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stable(object[key])}`).join(",")}}`;
}

function errorWithCode(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

export const USAGE_ANALYTICS_GROUPS = ["user", "department", "model"] as const;
export const USAGE_ANALYTICS_METRICS = [
  "totalTokens",
  "inputTokens",
  "outputTokens",
  "cachedTokens",
  "cacheReadInputTokens",
  "cacheCreationInputTokens",
  "reasoningTokens",
  "costUsd",
] as const;
export const USAGE_ANALYTICS_ORDERS = ["asc", "desc"] as const;

export type UsageAnalyticsGroup = (typeof USAGE_ANALYTICS_GROUPS)[number];
export type UsageAnalyticsMetric = (typeof USAGE_ANALYTICS_METRICS)[number];
export type UsageAnalyticsOrder = (typeof USAGE_ANALYTICS_ORDERS)[number];
export type UsageAnalyticsQuery = {
  start: string;
  end: string;
  timezone: "UTC";
  groupBy: UsageAnalyticsGroup;
  metric: UsageAnalyticsMetric;
  order: UsageAnalyticsOrder;
  limit: number;
};

const MAX_USAGE_ANALYTICS_RANGE_MS = 366 * 24 * 60 * 60 * 1000;
const USAGE_ANALYTICS_ARGUMENTS = new Set(["start", "end", "groupBy", "metric", "order", "limit"]);
const ISO_DATE_ARGUMENT = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

function parseDateArgument(value: unknown, name: "start" | "end"): Date | null {
  if (value === undefined || value === null || value === "") return null;
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || !ISO_DATE_ARGUMENT.test(normalized)) throw errorWithCode("ACTION_VALIDATION_FAILED", `${name} must be an ISO date string`);
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) throw errorWithCode("ACTION_VALIDATION_FAILED", `${name} must be a valid ISO date string`);
  return parsed;
}

/** Validate and normalize the bounded server-side usage analytics contract. */
export function parseUsageAnalyticsArgs(args: JsonObject, now = new Date()): UsageAnalyticsQuery {
  for (const key of Object.keys(args)) {
    if (!USAGE_ANALYTICS_ARGUMENTS.has(key)) throw errorWithCode("ACTION_VALIDATION_FAILED", `arguments.${key} is not allowed`);
  }
  const current = new Date(now.getTime());
  if (Number.isNaN(current.getTime())) throw new Error("invalid current time");
  const requestedStart = parseDateArgument(args.start, "start");
  const requestedEnd = parseDateArgument(args.end, "end");
  const end = requestedEnd ?? current;
  const start = requestedStart ?? new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
  if (end.getTime() > current.getTime()) throw errorWithCode("ACTION_VALIDATION_FAILED", "end cannot be in the future");
  if (end.getTime() <= start.getTime()) throw errorWithCode("ACTION_VALIDATION_FAILED", "end must be after start");
  if (end.getTime() - start.getTime() > MAX_USAGE_ANALYTICS_RANGE_MS) throw errorWithCode("ACTION_VALIDATION_FAILED", "usage analytics range cannot exceed 366 days");

  const groupBy = args.groupBy === undefined ? "user" : args.groupBy;
  if (typeof groupBy !== "string" || !(USAGE_ANALYTICS_GROUPS as readonly string[]).includes(groupBy)) {
    throw errorWithCode("ACTION_VALIDATION_FAILED", "groupBy must be user, department, or model");
  }
  const metric = args.metric === undefined ? "totalTokens" : args.metric;
  if (typeof metric !== "string" || !(USAGE_ANALYTICS_METRICS as readonly string[]).includes(metric)) {
    throw errorWithCode("ACTION_VALIDATION_FAILED", "metric is not supported");
  }
  const order = args.order === undefined ? "desc" : args.order;
  if (typeof order !== "string" || !(USAGE_ANALYTICS_ORDERS as readonly string[]).includes(order)) {
    throw errorWithCode("ACTION_VALIDATION_FAILED", "order must be asc or desc");
  }
  const limit = args.limit === undefined ? 10 : args.limit;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw errorWithCode("ACTION_VALIDATION_FAILED", "limit must be an integer from 1 to 100");
  }
  return {
    start: start.toISOString(),
    end: end.toISOString(),
    timezone: "UTC",
    groupBy: groupBy as UsageAnalyticsGroup,
    metric: metric as UsageAnalyticsMetric,
    order: order as UsageAnalyticsOrder,
    limit,
  };
}

async function departmentIdsForUsageScope(
  raw: AnyDb,
  tables: DbTables,
  tenantId: string,
  scopeDeptId: string | null,
): Promise<string[]> {
  if (!scopeDeptId) return [];
  const roots = await raw
    .select({ id: tables.departments.id, path: tables.departments.path })
    .from(tables.departments)
    .where(and(eq(tables.departments.tenantId, tenantId), eq(tables.departments.id, scopeDeptId)))
    .limit(1);
  const root = roots[0] as { id: string; path: string } | undefined;
  if (!root) return [];
  const prefix = root.path.endsWith("/") ? root.path : `${root.path}/`;
  // Department paths are tenant data and may contain SQL LIKE metacharacters.
  // Resolve the tenant's department ids first and compare the trusted path in
  // memory so a name containing `%` or `_` can never widen the data scope.
  const allDepartments = await raw
    .select({ id: tables.departments.id, path: tables.departments.path })
    .from(tables.departments)
    .where(eq(tables.departments.tenantId, tenantId));
  return allDepartments
    .filter((row: { path: string }) => row.path === root.path || row.path.startsWith(prefix))
    .map((row: { id: string }) => row.id);
}

async function usagePermissionPredicate(
  raw: AnyDb,
  tables: DbTables,
  tenantId: string,
  permission: EffectivePermission,
  ownerUserId: string,
): Promise<any> {
  if (permission.dataScope === "tenant") return sql`true`;
  if (permission.dataScope === "self") return eq(tables.usage.userId, ownerUserId);
  if (permission.dataScope === "department") {
    return permission.scopeDeptId ? eq(tables.usage.deptId, permission.scopeDeptId) : sql`false`;
  }
  const ids = await departmentIdsForUsageScope(raw, tables, tenantId, permission.scopeDeptId);
  return ids.length ? inArray(tables.usage.deptId, ids) : sql`false`;
}

async function usageScopePredicate(
  request: ActionRequestContext,
  raw: AnyDb,
  tables: DbTables,
): Promise<any> {
  const context = await getUserAuthorizationContext(request.tenantId, request.userId);
  const userPermissions = context.effectivePermissions.filter((permission) => permission.scope === "metering:read");
  if (!request.agentPrincipalId) {
    const predicates = await Promise.all(userPermissions.map((permission) => usagePermissionPredicate(raw, tables, request.tenantId, permission, request.userId)));
    return predicates.length ? or(...predicates) : sql`false`;
  }

  const agent = await getPrincipal(request.tenantId, request.agentPrincipalId);
  if (!agent || agent.kind !== "agent" || agent.status !== "active" || agent.agentProfile?.mode === "service") return sql`false`;
  const bindings = await listPrincipalRoleBindings({ tenantId: request.tenantId, principalId: agent.id });
  // Keep a revoked/expired explicit assignment as a ceiling marker. Otherwise
  // revoking the last usable row would silently widen the delegated agent to
  // the owner's full metering scope. Legacy personal-assistant templates are
  // excluded by the shared IAM compatibility helper.
  const agentHasExplicitCeiling = hasDelegatedAgentExplicitCeiling(bindings);
  const agentPermissions = agentHasExplicitCeiling
    ? effectivePermissionsFromBindings(bindings).filter((permission) => permission.scope === "metering:read")
    : userPermissions;
  const pairs = agentHasExplicitCeiling
    ? userPermissions.flatMap((userPermission) => agentPermissions
      .filter((agentPermission) => agentPermission.scope === userPermission.scope)
      .map((agentPermission) => ({ userPermission, agentPermission })))
    : userPermissions.map((userPermission) => ({ userPermission, agentPermission: null }));
  const predicates = await Promise.all(pairs.map(async ({ userPermission, agentPermission }) => {
    const userPredicate = await usagePermissionPredicate(raw, tables, request.tenantId, userPermission, request.userId);
    if (!agentPermission) return userPredicate;
    const agentPredicate = await usagePermissionPredicate(raw, tables, request.tenantId, agentPermission, request.userId);
    return and(userPredicate as any, agentPredicate as any);
  }));
  return predicates.length ? or(...predicates) : sql`false`;
}

type UsageAnalyticsGroupLabel = {
  label: string | null;
  displayName: string | null;
  departmentId: string | null;
  departmentName: string | null;
  /** False means the caller receives the stable id as an explicit identifier. */
  identityVisible: boolean;
};

/**
 * Resolve at most the returned Top-N keys in bulk, after the usage predicate
 * has already limited the aggregate.  Identity labels have their own
 * user:read target check; a tenant-wide metering grant must not become a
 * directory read.  When that check fails the stable key is intentionally
 * returned as an explicit identifier.
 */
async function usageAnalyticsGroupLabels(
  request: ActionRequestContext,
  raw: AnyDb,
  tables: DbTables,
  groupBy: UsageAnalyticsGroup,
  groups: Array<{ key: unknown }>,
): Promise<Map<string, UsageAnalyticsGroupLabel>> {
  const keys = [...new Set(groups
    .map((row) => row.key)
    .filter((key): key is string => typeof key === "string" && key.length > 0)
    .map(String))].slice(0, 100);
  const labels = new Map<string, UsageAnalyticsGroupLabel>();
  if (!keys.length || groupBy === "model") return labels;

  const targetKind = groupBy === "user" ? "user" : "department";
  const identityVisibility = new Map<string, boolean>();
  await Promise.all(keys.map(async (key) => {
    const decision = await authorizePrincipalAction({
      tenantId: request.tenantId,
      userId: request.userId,
      agentPrincipalId: request.agentPrincipalId,
      requiredScopes: ["user:read"],
      target: { kind: targetKind, id: key },
    }).catch(() => null);
    identityVisibility.set(key, Boolean(decision?.allowed));
  }));

  const visibleKeys = keys.filter((key) => identityVisibility.get(key) === true);
  if (!visibleKeys.length) return labels;

  if (groupBy === "user") {
    const userRows = await raw
      .select({ id: tables.users.id, displayName: tables.users.displayName, deptId: tables.users.deptId })
      .from(tables.users)
      .where(and(
        eq(tables.users.tenantId, request.tenantId),
        eq(tables.users.isDeleted, false),
        inArray(tables.users.id, visibleKeys),
      )) as Array<{ id: string; displayName: string; deptId: string | null }>;
    const userDepartments = [...new Set(userRows
      .map((row: { deptId: string | null }) => row.deptId)
      .filter((deptId): deptId is string => typeof deptId === "string" && deptId.length > 0))];
    const departmentRows = userDepartments.length
      ? await raw
        .select({ id: tables.departments.id, name: tables.departments.name })
        .from(tables.departments)
        .where(and(eq(tables.departments.tenantId, request.tenantId), inArray(tables.departments.id, userDepartments)))
      : [];
    const departmentNames = new Map<string, string>(departmentRows.map((row: { id: string; name: string }) => [row.id, row.name] as const));
    for (const row of userRows) {
      const departmentName = row.deptId ? departmentNames.get(row.deptId) ?? null : null;
      labels.set(row.id, {
        label: row.displayName,
        displayName: row.displayName,
        departmentId: row.deptId ?? null,
        departmentName,
        identityVisible: true,
      });
    }
    return labels;
  }

  const departmentRows = await raw
    .select({ id: tables.departments.id, name: tables.departments.name })
    .from(tables.departments)
    .where(and(eq(tables.departments.tenantId, request.tenantId), inArray(tables.departments.id, visibleKeys)));
  for (const row of departmentRows as Array<{ id: string; name: string }>) {
    labels.set(row.id, {
      label: row.name,
      displayName: row.name,
      departmentId: row.id,
      departmentName: row.name,
      identityVisible: true,
    });
  }
  return labels;
}

function userIdArg(args: JsonObject): string {
  const userId = typeof args.userId === "string" ? args.userId.trim() : "";
  if (!userId) throw errorWithCode("ACTION_VALIDATION_FAILED", "userId is required");
  return userId;
}

function modelIdsArg(args: JsonObject): string[] {
  if (!Array.isArray(args.modelIds)) throw errorWithCode("ACTION_VALIDATION_FAILED", "modelIds is required");
  const values: unknown[] = args.modelIds;
  if (values.some((value) => typeof value !== "string")) throw errorWithCode("ACTION_VALIDATION_FAILED", "modelIds must contain only strings");
  const modelIds = [...new Set(values.filter((value): value is string => typeof value === "string").map((value) => value.trim()).filter(Boolean))];
  if (modelIds.length > 500) throw errorWithCode("ACTION_VALIDATION_FAILED", "modelIds exceeds the maximum size");
  return modelIds;
}

/** Pure input contract used by the action tests and non-DB callers. */
export function validateModelIdsInput(args: JsonObject): string[] {
  return modelIdsArg(args);
}

function excludedGroupModelIdsArg(args: JsonObject): string[] | null {
  if (args.excludedGroupModelIds === undefined) return null;
  if (!Array.isArray(args.excludedGroupModelIds)) throw errorWithCode("ACTION_VALIDATION_FAILED", "excludedGroupModelIds must be an array");
  const values: unknown[] = args.excludedGroupModelIds;
  if (values.some((value) => typeof value !== "string")) throw errorWithCode("ACTION_VALIDATION_FAILED", "excludedGroupModelIds must contain only strings");
  return uniqueStrings(values);
}

/** Pure input contract used by the action tests and non-DB callers. */
export function validateExcludedGroupModelIdsInput(args: JsonObject): string[] | null {
  return excludedGroupModelIdsArg(args);
}

function expectedVersion(args: JsonObject): string | null {
  const candidate = args.expectedVersion ?? args.expectedUpdatedAt ?? args.expectedModelVersion;
  return typeof candidate === "string" && candidate.trim() ? candidate.trim() : null;
}

function quotaRule(args: JsonObject): JsonObject {
  const source = args.rule && typeof args.rule === "object" && !Array.isArray(args.rule) ? record(args.rule) : args;
  const allowed = ["monthlyTokens", "dailyTokens", "weeklyTokens", "tpm", "rpm", "maxConcurrency", "requestsPerDay", "requestsPerWeek", "requestsPerMonth", "poolScope", "action"];
  const out: JsonObject = {};
  for (const key of allowed) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  const numeric = ["monthlyTokens", "dailyTokens", "weeklyTokens", "tpm", "rpm", "maxConcurrency", "requestsPerDay", "requestsPerWeek", "requestsPerMonth"];
  for (const key of numeric) {
    if (out[key] === undefined) continue;
    const n = Number(out[key]);
    if (!Number.isFinite(n) || n < 0 || n > 2_147_483_647) throw errorWithCode("ACTION_VALIDATION_FAILED", `${key} must be a non-negative finite number`);
    out[key] = Math.floor(n);
  }
  if (out.action !== undefined && out.action !== "block" && out.action !== "warn" && out.action !== "fallback") throw errorWithCode("ACTION_VALIDATION_FAILED", "action must be block, warn, or fallback");
  if (out.poolScope !== undefined && out.poolScope !== "" && out.poolScope !== "dept" && out.poolScope !== "tenant") throw errorWithCode("ACTION_VALIDATION_FAILED", "poolScope is invalid");
  return out;
}

/** Pure input contract used by the action tests and non-DB callers. */
export function normalizeQuotaRuleInput(args: JsonObject): JsonObject {
  return quotaRule(args);
}

const QUOTA_FIELD_LABELS: Record<string, string> = {
  monthlyTokens: "月 Token 上限",
  dailyTokens: "日 Token 上限",
  weeklyTokens: "周 Token 上限",
  tpm: "每分钟 Token 上限",
  rpm: "每分钟请求上限",
  maxConcurrency: "最大并发数",
  requestsPerDay: "每日请求上限",
  requestsPerWeek: "每周请求上限",
  requestsPerMonth: "每月请求上限",
  poolScope: "共享池范围",
  action: "超限动作",
};

function quotaRuleSummary(rule: JsonObject, inherited = false): string {
  if (inherited || Object.keys(rule).length === 0) return "继承上级额度";
  const fields = Object.entries(QUOTA_FIELD_LABELS)
    .filter(([key]) => rule[key] !== undefined)
    .map(([key, label]) => `${label} ${String(rule[key])}`);
  return fields.length ? fields.join("、") : "未设置个人额度";
}

function quotaRuleDiff(before: JsonObject, after: JsonObject): JsonObject {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return Object.fromEntries(keys.map((key) => [key, { before: before[key] ?? null, after: after[key] ?? null }]));
}

function activeModelIds(rows: readonly { providerId: string; enabled: boolean; models: unknown }[]): string[] {
  const values: string[] = [];
  for (const row of rows) {
    if (!row.enabled || !Array.isArray(row.models)) continue;
    for (const item of row.models) {
      const model = record(item);
      if (model.enabled === true && typeof model.name === "string" && model.name.trim()) values.push(`${row.providerId}/${model.name.trim()}`);
    }
  }
  return [...new Set(values)].sort();
}

function uniqueStrings(values: readonly unknown[]): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string").map((value) => value.trim()).filter(Boolean))].sort();
}

function configuredModelSet(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  return uniqueStrings(value);
}

function intersectModelSets(base: readonly string[], allowed: readonly string[]): string[] {
  const allow = new Set(allowed);
  return uniqueStrings(base).filter((value) => allow.has(value));
}

function effectiveDepartmentModels(input: {
  allEnabled: readonly string[];
  assignmentRows: readonly { assignmentKey: string; modelId: string }[];
  chain: readonly string[];
}): string[] {
  const assignments = new Map<string, string[]>();
  for (const row of input.assignmentRows) {
    const values = assignments.get(row.assignmentKey) ?? [];
    values.push(row.modelId);
    assignments.set(row.assignmentKey, values);
  }
  let effective = uniqueStrings(input.allEnabled);
  for (const deptId of [...input.chain].reverse()) {
    const configured = configuredModelSet(assignments.get(`dept:${deptId}`));
    if (configured) effective = intersectModelSets(effective, configured);
  }
  return effective;
}

type ModelsSnapshot = {
  userId: string;
  displayName: string;
  email: string;
  deptId: string | null;
  parentAllowedIds: string[];
  parentLabel: string;
  personalAssignmentModelIds: string[] | null;
  personalAssignmentModelIdsByKey: Record<string, string[]>;
  groupModelIds: string[];
  groupModelSources: Array<{ id: string; name: string; modelIds: string[] }>;
  excludedGroupModelIds: string[];
  individualModelIds: string[];
  effectiveModelIds: string[];
  version: string;
};

async function queryWithOptionalLock(query: any, forUpdate: boolean): Promise<any[]> {
  const locked = forUpdate && typeof query.for === "function" ? query.for("update") : query;
  return locked;
}

/**
 * Read the complete model policy through one connection.  The same helper is
 * used by preview and confirmation; confirmation requests row locks so a
 * concurrent department/group/provider change cannot pass the version check
 * and then silently overwrite a newer policy.
 */
async function readModelsSnapshot(
  tenantId: string,
  userId: string,
  transaction?: ActionStoreTransaction,
  forUpdate = false,
): Promise<ModelsSnapshot> {
  const { raw, tables } = await dbFor(transaction);
  const userQuery = raw
    .select({ id: tables.users.id, displayName: tables.users.displayName, email: tables.users.email, deptId: tables.users.deptId, status: tables.users.status })
    .from(tables.users)
    .where(and(eq(tables.users.tenantId, tenantId), eq(tables.users.id, userId), eq(tables.users.isDeleted, false)))
    .limit(1);
  const userRows = await queryWithOptionalLock(userQuery, forUpdate);
  const user = userRows[0];
  if (!user || user.status !== "active") throw errorWithCode("ACTION_TARGET_NOT_FOUND", "member is not available");

  const providerQuery = raw
    .select({ providerId: tables.providers.providerId, enabled: tables.providers.enabled, models: tables.providers.models })
    .from(tables.providers)
    .where(eq(tables.providers.tenantId, tenantId));
  const providerRows = await queryWithOptionalLock(providerQuery, forUpdate);
  const allEnabled = activeModelIds(providerRows);

  const chainRows: Array<{ id: string; parentId: string | null; name: string; path: string }> = [];
  const seen = new Set<string>();
  let currentDeptId: string | null = user.deptId ?? null;
  while (currentDeptId && !seen.has(currentDeptId)) {
    seen.add(currentDeptId);
    const deptQuery = raw
      .select({ id: tables.departments.id, parentId: tables.departments.parentId, name: tables.departments.name, path: tables.departments.path })
      .from(tables.departments)
      .where(and(eq(tables.departments.tenantId, tenantId), eq(tables.departments.id, currentDeptId)))
      .limit(1);
    const rows = await queryWithOptionalLock(deptQuery, forUpdate);
    const row = rows[0] as { id: string; parentId: string | null; name: string; path: string } | undefined;
    if (!row) break;
    chainRows.push(row);
    currentDeptId = row.parentId ?? null;
  }
  const deptKeys = chainRows.map((row) => `dept:${row.id}`);
  const deptAssignmentQuery = raw
    .select({ assignmentKey: tables.models.assignmentKey, modelId: tables.models.modelId })
    .from(tables.models)
    .where(and(eq(tables.models.tenantId, tenantId), deptKeys.length ? inArray(tables.models.assignmentKey, deptKeys) : sql`false`));
  const deptAssignmentRows = await queryWithOptionalLock(deptAssignmentQuery, forUpdate);
  const parentAllowedIds = effectiveDepartmentModels({ allEnabled, assignmentRows: deptAssignmentRows, chain: chainRows.map((row) => row.id) });
  const parentLabel = chainRows[0] ? `${chainRows[0].name}（${chainRows[0].path}）` : "__ALL_ENABLED__";

  const assignmentKeys = [user.id, `email:${String(user.email).trim().toLowerCase()}`];
  const assignmentQuery = raw
    .select({ assignmentKey: tables.models.assignmentKey, modelId: tables.models.modelId })
    .from(tables.models)
    .where(and(eq(tables.models.tenantId, tenantId), inArray(tables.models.assignmentKey, assignmentKeys)));
  const assignmentRows = await queryWithOptionalLock(assignmentQuery, forUpdate);
  const byKey: Record<string, string[]> = {};
  for (const key of assignmentKeys) byKey[key] = [];
  for (const row of assignmentRows) byKey[row.assignmentKey] = [...(byKey[row.assignmentKey] ?? []), row.modelId];
  for (const key of assignmentKeys) byKey[key] = uniqueStrings(byKey[key] ?? []);
  const personalConfigured = assignmentKeys.some((key) => byKey[key]!.length > 0);
  const personalAssignmentModelIds = personalConfigured ? uniqueStrings(assignmentKeys.flatMap((key) => byKey[key]!)) : null;

  const groupQuery = raw
    .select({ groupId: tables.groupMembers.groupId, groupName: tables.groups.name })
    .from(tables.groupMembers)
    .innerJoin(tables.groups, eq(tables.groupMembers.groupId, tables.groups.id))
    .where(and(eq(tables.groupMembers.userId, user.id), eq(tables.groups.tenantId, tenantId)));
  const groupRows = await queryWithOptionalLock(groupQuery, forUpdate);
  const groupNames = new Map<string, string>();
  for (const row of groupRows as Array<{ groupId: string; groupName: string }>) groupNames.set(row.groupId, row.groupName);
  const groupIds = uniqueStrings(groupRows.map((row: { groupId: string }) => row.groupId));
  const groupKeys = groupIds.map((id) => `group:${id}`);
  const groupAssignmentQuery = raw
    .select({ assignmentKey: tables.models.assignmentKey, modelId: tables.models.modelId })
    .from(tables.models)
    .where(and(eq(tables.models.tenantId, tenantId), groupKeys.length ? inArray(tables.models.assignmentKey, groupKeys) : sql`false`));
  const groupAssignmentRows = await queryWithOptionalLock(groupAssignmentQuery, forUpdate);
  const groupModelIds = uniqueStrings(groupAssignmentRows.map((row: { modelId: string }) => row.modelId)).filter((id) => parentAllowedIds.includes(id));
  const modelsByGroup = new Map<string, string[]>();
  for (const row of groupAssignmentRows as Array<{ assignmentKey: string; modelId: string }>) {
    const groupId = row.assignmentKey.slice("group:".length);
    const models = modelsByGroup.get(groupId) ?? [];
    models.push(row.modelId);
    modelsByGroup.set(groupId, models);
  }
  const groupModelSources = groupIds
    .map((groupId) => ({
      id: groupId,
      name: groupNames.get(groupId) ?? groupId,
      modelIds: uniqueStrings(modelsByGroup.get(groupId) ?? []).filter((id) => parentAllowedIds.includes(id)),
    }))
    .filter((group) => group.modelIds.length > 0);

  const optOutQuery = raw
    .select({ subject: tables.optOuts.subject })
    .from(tables.optOuts)
    .where(and(eq(tables.optOuts.tenantId, tenantId), eq(tables.optOuts.userId, user.id)));
  const optOutRows = await queryWithOptionalLock(optOutQuery, forUpdate);
  const excludedGroupModelIds = uniqueStrings(optOutRows
    .map((row: { subject: string }) => row.subject)
    .filter((subject) => subject.startsWith("model:"))
    .map((subject) => subject.slice("model:".length)))
    .filter((id) => groupModelIds.includes(id));

  const assigned = personalAssignmentModelIds === null && groupModelIds.length === 0
    ? null
    : uniqueStrings([...(personalAssignmentModelIds ?? []), ...groupModelIds]);
  const effectiveModelIds = intersectModelSets(assigned === null ? parentAllowedIds : assigned, parentAllowedIds)
    .filter((id) => !excludedGroupModelIds.includes(id));
  const individualModelIds = personalAssignmentModelIds ?? [];
  const version = versionHash({
    user: { id: user.id, email: user.email, deptId: user.deptId ?? null },
    parentAllowedIds,
    parentLabel,
    personalAssignmentModelIds: personalAssignmentModelIds ?? null,
    personalAssignmentModelIdsByKey: byKey,
    groupModelIds,
    groupModelSources,
    excludedGroupModelIds,
    effectiveModelIds,
  });
  return {
    userId: user.id,
    displayName: user.displayName,
    email: user.email,
    deptId: user.deptId ?? null,
    parentAllowedIds,
    parentLabel,
    personalAssignmentModelIds,
    personalAssignmentModelIdsByKey: byKey,
    groupModelIds,
    groupModelSources,
    excludedGroupModelIds,
    individualModelIds,
    effectiveModelIds,
    version,
  };
}

function versionHash(value: unknown): string {
  return createHash("sha256").update(stable(value), "utf8").digest("hex");
}

async function insertAudit(transaction: ActionStoreTransaction | undefined, input: {
  tenantId: string;
  actorUserId: string;
  eventType: string;
  targetKind: string;
  targetId: string | null;
  detail: JsonObject;
}): Promise<void> {
  const { raw, tables } = await dbFor(transaction);
  const now = new Date();
  await raw.insert(tables.audit).values({
    id: ulid(),
    tenantId: input.tenantId,
    actorUserId: input.actorUserId,
    eventType: input.eventType,
    targetKind: input.targetKind,
    targetId: input.targetId,
    detail: input.detail,
    createdAt: now,
    updatedAt: now,
  });
}

export type QuotaMutationPreparation = {
  beforeState: JsonObject;
  afterState: JsonObject;
  expectedVersions: JsonObject;
  proposal: JsonObject;
};

export type ModelsMutationPreparation = {
  beforeState: JsonObject;
  afterState: JsonObject;
  expectedVersions: JsonObject;
  proposal: JsonObject;
};

/**
 * Domain contract used by action handlers.  Implementations receive explicit
 * tenant and transaction context; this package contains no Next.js imports or
 * process-wide tenant fallback.
 */
export interface EnterpriseDomain {
  readSelfProfile(request: ActionRequestContext): Promise<JsonObject>;
  searchMembers(request: ActionRequestContext, query: string, limit?: number): Promise<JsonObject>;
  readQuota(request: ActionRequestContext, userId: string): Promise<JsonObject>;
  readModels(request: ActionRequestContext, userId: string): Promise<JsonObject>;
  readGatewayHealth(request: ActionRequestContext): Promise<JsonObject>;
  readUsageSummary(request: ActionRequestContext): Promise<JsonObject>;
  readUsageAnalytics(request: ActionRequestContext, args: JsonObject): Promise<JsonObject>;
  readAuditEvents(request: ActionRequestContext, limit?: number): Promise<JsonObject>;
  readEnterpriseOverview(request: ActionRequestContext): Promise<JsonObject>;
  prepareQuotaMutation(request: ActionRequestContext, args: JsonObject): Promise<QuotaMutationPreparation>;
  setQuotaMutation(context: ActionHandlerContext, args: JsonObject, operation: ActionOperation): Promise<JsonObject>;
  prepareModelsMutation(request: ActionRequestContext, args: JsonObject): Promise<ModelsMutationPreparation>;
  setModelsMutation(context: ActionHandlerContext, args: JsonObject, operation: ActionOperation): Promise<JsonObject>;
}

export class SqlEnterpriseDomain implements EnterpriseDomain {
  public async readSelfProfile(request: ActionRequestContext): Promise<JsonObject> {
    const user = await getAdminUser(request.tenantId, request.userId);
    if (!user) throw errorWithCode("ASSISTANT_AUTH_REVOKED", "user is no longer available");
    return {
      id: user.id,
      userId: user.id,
      tenantId: user.tenantId,
      displayName: user.displayName,
      email: user.email,
      deptId: user.deptId,
      status: user.status,
      roleCodes: user.roleCodes,
    };
  }

  public async searchMembers(request: ActionRequestContext, query: string, limit = 20): Promise<JsonObject> {
    const rows = await listAudienceUsers(request.tenantId, {
      q: query.trim(),
      // Fetch a bounded candidate set, then apply the exact target-aware
      // authorization decision to every row before exposing it.  The action
      // result therefore cannot turn a tenant-level search into an
      // unfiltered directory dump for a department-scoped principal.
      limit: Math.max(1, Math.min(Math.max(limit, 1) * 3, 100)),
      offset: 0,
    });
    const visible = [] as typeof rows;
    for (const row of rows) {
      if (visible.length >= Math.max(1, Math.min(limit, 100))) break;
      const decision = await authorizePrincipalAction({
        tenantId: request.tenantId,
        userId: request.userId,
        agentPrincipalId: request.agentPrincipalId,
        requiredScopes: ["user:read"],
        target: { kind: "user", id: row.id },
      });
      if (decision.allowed) visible.push(row);
    }
    return {
      items: visible.map((row) => ({ id: row.id, displayName: row.displayName, email: row.email, deptId: row.deptId, status: "active" })),
      total: visible.length,
    };
  }

  public async readQuota(request: ActionRequestContext, userId: string): Promise<JsonObject> {
    const user = await getAdminUser(request.tenantId, userId);
    if (!user) throw errorWithCode("ACTION_TARGET_NOT_FOUND", "member is not available");
    const summary = await getQuotaSummaryForSession({ tenantId: request.tenantId, userId, deptId: user.deptId, role: user.roleCodes[0] });
    const snapshot = await this.readQuotaConfig(request.tenantId);
    return { userId, version: snapshot.updatedAt, daily: summary.daily, weekly: summary.weekly, monthly: summary.monthly, user: summary.user, dept: summary.dept, unlimited: summary.unlimited };
  }

  public async readModels(request: ActionRequestContext, userId: string, transaction?: ActionStoreTransaction, forUpdate = false): Promise<JsonObject> {
    const snapshot = await readModelsSnapshot(request.tenantId, userId, transaction, forUpdate);
    return {
      userId: snapshot.userId,
      displayName: snapshot.displayName,
      email: snapshot.email,
      deptId: snapshot.deptId,
      parentAllowedIds: snapshot.parentAllowedIds,
      parentLabel: snapshot.parentLabel,
      modelIds: snapshot.individualModelIds,
      individualModelIds: snapshot.individualModelIds,
      personalAssignmentModelIds: snapshot.personalAssignmentModelIds,
      personalAssignmentModelIdsByKey: snapshot.personalAssignmentModelIdsByKey,
      groupModelIds: snapshot.groupModelIds,
      groupModelSources: snapshot.groupModelSources,
      excludedGroupModelIds: snapshot.excludedGroupModelIds,
      effectiveModelIds: snapshot.effectiveModelIds,
      version: snapshot.version,
    };
  }

  public async readGatewayHealth(request: ActionRequestContext): Promise<JsonObject> {
    const base = process.env.GATEWAY_PUBLIC_BASE_URL?.trim() || process.env.GATEWAY_BASE_URL?.trim();
    if (!base) return { status: "unconfigured" };
    const endpoint = `${base.replace(/\/+$/, "")}/healthz`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
      const response = await fetch(endpoint, { method: "GET", signal: controller.signal, headers: { accept: "application/json" } });
      return { status: response.ok ? "healthy" : "unhealthy", httpStatus: response.status, checkedAt: new Date().toISOString() };
    } catch {
      return { status: "unavailable", checkedAt: new Date().toISOString() };
    } finally {
      clearTimeout(timer);
    }
  }

  public async readUsageSummary(request: ActionRequestContext): Promise<JsonObject> {
    const user = await getAdminUser(request.tenantId, request.userId);
    if (!user) throw errorWithCode("ASSISTANT_AUTH_REVOKED", "user is no longer available");
    const summary = await getQuotaSummaryForSession({ tenantId: request.tenantId, userId: request.userId, deptId: user.deptId, role: user.roleCodes[0] });
    return { userId: request.userId, daily: summary.daily, weekly: summary.weekly, monthly: summary.monthly, dept: summary.dept, unlimited: summary.unlimited };
  }

  public async readUsageAnalytics(request: ActionRequestContext, args: JsonObject): Promise<JsonObject> {
    const decision = await authorizePrincipalAction({
      tenantId: request.tenantId,
      userId: request.userId,
      agentPrincipalId: request.agentPrincipalId,
      requiredScopes: ["metering:read"],
      target: { kind: "user", id: request.userId },
    });
    if (!decision.allowed) throw errorWithCode("ACTION_FORBIDDEN", decision.publicReason);

    const queryArgs = parseUsageAnalyticsArgs(args);
    const { raw, tables } = await dbFor();
    // Build the tenant/time predicate first, then append the effective IAM
    // data boundary. No caller supplied SQL fragment or column name reaches
    // the query builder; dimensions and metrics are selected from fixed maps.
    const scope = await usageScopePredicate(request, raw, tables);
    const rangeWhere = and(
      eq(tables.usage.tenantId, request.tenantId),
      gte(tables.usage.timeBucket, new Date(queryArgs.start)),
      lt(tables.usage.timeBucket, new Date(queryArgs.end)),
      scope as any,
    );
    const metricColumn = (tables.usage as Record<string, any>)[queryArgs.metric];
    const groupColumn = ({
      user: tables.usage.userId,
      department: tables.usage.deptId,
      model: tables.usage.model,
    } as const)[queryArgs.groupBy];
    // Both maps are static above; keep the guard in case a future edit adds a
    // parser value without adding its corresponding schema column.
    if (!metricColumn || !groupColumn) throw errorWithCode("ACTION_VALIDATION_FAILED", "usage analytics dimension is not supported");
    const aggregate = sql<string>`coalesce(sum(${metricColumn}), 0)`;
    // Keep NULL groups and equal-valued groups in the same order on PG and
    // MySQL.  Both dialects sort NULL differently for DESC, so make the NULL
    // rank explicit and use the stable key as the final tie breaker.
    const nullRank = sql<number>`case when ${groupColumn} is null then 1 else 0 end`;
    const stableKey = sql<string>`coalesce(${groupColumn}, '')`;
    const [totals, groups] = await Promise.all([
      raw.select({ value: aggregate, recordCount: sql<string>`count(*)` }).from(tables.usage).where(rangeWhere),
      raw
        .select({ key: groupColumn, value: aggregate, recordCount: sql<string>`count(*)` })
        .from(tables.usage)
        .where(rangeWhere)
        .groupBy(groupColumn)
        .orderBy(queryArgs.order === "asc" ? asc(aggregate) : desc(aggregate), asc(nullRank), asc(stableKey))
        .limit(queryArgs.limit),
    ]);
    const total = Number(totals[0]?.value ?? 0);
    const recordCount = Number(totals[0]?.recordCount ?? 0);
    const labels = await usageAnalyticsGroupLabels(request, raw, tables, queryArgs.groupBy, groups);
    return {
      range: { start: queryArgs.start, end: queryArgs.end, timezone: queryArgs.timezone },
      metric: queryArgs.metric,
      groupBy: queryArgs.groupBy,
      order: queryArgs.order,
      limit: queryArgs.limit,
      total: Number.isFinite(total) ? total : 0,
      groups: groups.map((row: { key: unknown; value: unknown; recordCount: unknown }) => {
        const key = row.key === null || row.key === undefined ? null : String(row.key);
        const label = key === null
          ? { label: null, displayName: null, departmentId: null, departmentName: null, identityVisible: false }
          : labels.get(key) ?? {
            label: key,
            displayName: key,
            departmentId: null,
            departmentName: null,
            identityVisible: queryArgs.groupBy === "model",
          };
        return {
          key,
          label: label.label,
          displayName: label.displayName,
          departmentId: label.departmentId,
          departmentName: label.departmentName,
          identityVisible: label.identityVisible,
          value: Number(row.value ?? 0) || 0,
          recordCount: Number(row.recordCount ?? 0) || 0,
        };
      }),
      coverage: {
        recordCount: Number.isFinite(recordCount) ? recordCount : 0,
        returnedGroups: groups.length,
        scope: "current effective metering:read permissions",
      },
    };
  }

  public async readAuditEvents(request: ActionRequestContext, limit = 100): Promise<JsonObject> {
    const { raw, tables } = await dbFor();
    const rows = await raw.select().from(tables.audit).where(eq(tables.audit.tenantId, request.tenantId)).orderBy(desc(tables.audit.createdAt)).limit(Math.max(1, Math.min(limit, 200)));
    return {
      items: rows.map((row: any) => ({
        id: row.id,
        eventType: row.eventType,
        targetKind: row.targetKind,
        targetId: row.targetId ?? null,
        actorUserId: row.actorUserId ?? null,
        detail: redactDetail(record(row.detail)),
        createdAt: dateIso(row.createdAt),
      })),
    };
  }

  public async readEnterpriseOverview(request: ActionRequestContext): Promise<JsonObject> {
    const { raw, tables } = await dbFor();
    // The overview combines tenant-wide directory/configuration counts with
    // usage totals.  Re-authorize the complete action at the domain boundary
    // so a direct domain caller cannot bypass the ActionRuntime target gate,
    // and apply the same effective metering predicate used by analytics.
    const decision = await authorizePrincipalAction({
      tenantId: request.tenantId,
      userId: request.userId,
      agentPrincipalId: request.agentPrincipalId,
      requiredScopes: ["user:read", "gateway:read", "metering:read"],
      target: { kind: "tenant", id: request.tenantId },
    });
    if (!decision.allowed) throw errorWithCode("ACTION_FORBIDDEN", decision.publicReason);
    const usageScope = await usageScopePredicate(request, raw, tables);
    const [memberCount, providerCount, channelCount, usageTotals] = await Promise.all([
      raw.select({ count: sql<number>`count(*)` }).from(tables.users).where(and(eq(tables.users.tenantId, request.tenantId), eq(tables.users.isDeleted, false))),
      raw.select({ count: sql<number>`count(*)` }).from(tables.providers).where(and(eq(tables.providers.tenantId, request.tenantId), eq(tables.providers.enabled, true))),
      raw.select({ count: sql<number>`count(*)` }).from(tables.channels).where(and(eq(tables.channels.tenantId, request.tenantId), eq(tables.channels.status, "active"))),
      raw.select({
        inputTokens: sql<string>`coalesce(sum(${tables.usage.inputTokens}), 0)`,
        outputTokens: sql<string>`coalesce(sum(${tables.usage.outputTokens}), 0)`,
        totalTokens: sql<string>`coalesce(sum(${tables.usage.totalTokens}), 0)`,
        cachedTokens: sql<string>`coalesce(sum(${tables.usage.cachedTokens}), 0)`,
        reasoningTokens: sql<string>`coalesce(sum(${tables.usage.reasoningTokens}), 0)`,
        costUsd: sql<string>`coalesce(sum(${tables.usage.costUsd}), 0)`,
        recordCount: sql<string>`count(*)`,
      }).from(tables.usage).where(and(eq(tables.usage.tenantId, request.tenantId), usageScope as any)),
    ]);
    const usage = usageTotals[0];
    return {
      tenantId: request.tenantId,
      memberCount: Number(memberCount[0]?.count ?? 0),
      enabledProviderCount: Number(providerCount[0]?.count ?? 0),
      activeGatewayChannelCount: Number(channelCount[0]?.count ?? 0),
      usageSummary: {
        inputTokens: Number(usage?.inputTokens ?? 0) || 0,
        outputTokens: Number(usage?.outputTokens ?? 0) || 0,
        totalTokens: Number(usage?.totalTokens ?? 0) || 0,
        cachedTokens: Number(usage?.cachedTokens ?? 0) || 0,
        reasoningTokens: Number(usage?.reasoningTokens ?? 0) || 0,
        costUsd: Number(usage?.costUsd ?? 0) || 0,
        recordCount: Number(usage?.recordCount ?? 0) || 0,
      },
    };
  }

  private async readQuotaConfig(tenantId: string, transaction?: ActionStoreTransaction, forUpdate = false): Promise<{ config: JsonObject; updatedAt: string }> {
    const { raw, tables } = await dbFor(transaction);
    const query = raw.select().from(tables.quotas).where(eq(tables.quotas.tenantId, tenantId)).limit(1);
    const rows = await queryWithOptionalLock(query, forUpdate);
    const row = rows[0];
    if (!row) return { config: { defaults: { role: {}, model: {} }, users: {}, departments: {}, groups: {}, modelExclusions: {}, apiTokens: {} }, updatedAt: new Date(0).toISOString() };
    return { config: record(row.config), updatedAt: dateIso(row.updatedAt) };
  }

  private async writeQuotaConfig(tenantId: string, config: JsonObject, expectedUpdatedAt: string, transaction?: ActionStoreTransaction): Promise<string> {
    const { raw, tables } = await dbFor(transaction);
    const rows = await raw.select().from(tables.quotas).where(eq(tables.quotas.tenantId, tenantId)).limit(1);
    const current = rows[0];
    const updatedAt = new Date();
    if (!current) {
      if (expectedUpdatedAt !== new Date(0).toISOString()) throw errorWithCode("ACTION_VERSION_CONFLICT", "quota config was created after preview");
      await raw.insert(tables.quotas).values({ tenantId, config, updatedAt });
      return updatedAt.toISOString();
    }
    if (dateIso(current.updatedAt) !== expectedUpdatedAt) throw errorWithCode("ACTION_VERSION_CONFLICT", "quota config changed since preview");
    await raw.update(tables.quotas).set({ config, updatedAt }).where(and(eq(tables.quotas.tenantId, tenantId), eq(tables.quotas.updatedAt, current.updatedAt)));
    const after = await raw.select().from(tables.quotas).where(eq(tables.quotas.tenantId, tenantId)).limit(1);
    if (!after[0] || dateIso(after[0].updatedAt) === expectedUpdatedAt) throw errorWithCode("ACTION_VERSION_CONFLICT", "quota config changed concurrently");
    return dateIso(after[0].updatedAt);
  }

  public async prepareQuotaMutation(request: ActionRequestContext, args: JsonObject): Promise<QuotaMutationPreparation> {
    const targetUserId = userIdArg(args);
    const user = await getAdminUser(request.tenantId, targetUserId);
    if (!user) throw errorWithCode("ACTION_TARGET_NOT_FOUND", "member is not available");
    const current = await this.readQuotaConfig(request.tenantId);
    const supplied = expectedVersion(args);
    if (supplied && supplied !== current.updatedAt) throw errorWithCode("ACTION_VERSION_CONFLICT", "quota config changed since preview");
    const currentUsers = record(current.config.users);
    const before = record(currentUsers[targetUserId]);
    const rule = quotaRule(args);
    const inherits = args.inherit === true;
    const after = inherits ? {} : { ...before, ...rule };
    return {
      beforeState: { userId: targetUserId, rule: before, version: current.updatedAt },
      afterState: { userId: targetUserId, rule: after, inherit: inherits, version: current.updatedAt },
      expectedVersions: { quotaUpdatedAt: current.updatedAt },
      proposal: {
        title: `调整成员「${user.displayName}」的额度`,
        changes: {
          member: { displayName: user.displayName, email: user.email },
          summary: `${quotaRuleSummary(before, Object.keys(before).length === 0)} → ${quotaRuleSummary(after, inherits)}`,
          before: { inherited: Object.keys(before).length === 0, quota: before },
          after: { inherited: inherits, quota: after },
          fields: quotaRuleDiff(before, after),
        },
      },
    };
  }

  public async setQuotaMutation(context: ActionHandlerContext, args: JsonObject, operation: ActionOperation): Promise<JsonObject> {
    const targetUserId = userIdArg(args);
    const user = await getAdminUser(context.request.tenantId, targetUserId);
    if (!user) throw errorWithCode("ACTION_TARGET_NOT_FOUND", "member is not available");
    const current = await this.readQuotaConfig(
      context.request.tenantId,
      context.transaction as ActionStoreTransaction | undefined,
      Boolean(context.transaction),
    );
    const expected = String(record(operation.expectedVersions).quotaUpdatedAt ?? "");
    if (current.updatedAt !== expected) throw errorWithCode("ACTION_VERSION_CONFLICT", "quota config changed since preview");
    const config = { ...current.config, users: { ...record(current.config.users) } };
    const usersConfig = config.users as JsonObject;
    if (args.inherit === true) delete usersConfig[targetUserId];
    else usersConfig[targetUserId] = { ...record(usersConfig[targetUserId]), ...quotaRule(args) };
    const updatedAt = await this.writeQuotaConfig(context.request.tenantId, config, current.updatedAt, context.transaction as ActionStoreTransaction | undefined);
    await insertAudit(context.transaction as ActionStoreTransaction | undefined, { tenantId: context.request.tenantId, actorUserId: context.request.userId, eventType: "assistant.action.member.quota.set", targetKind: "user", targetId: targetUserId, detail: { actionId: context.action.id, operationId: operation.id, rule: usersConfig[targetUserId] as JsonObject } });
    const afterRule = (usersConfig[targetUserId] as JsonObject | undefined) ?? {};
    const beforeRule = record(record(operation.beforeState).rule);
    const beforeInherited = Object.keys(beforeRule).length === 0;
    return {
      userId: targetUserId,
      member: { displayName: user.displayName, email: user.email },
      before: { inherited: beforeInherited, quota: beforeRule },
      after: { inherited: args.inherit === true, quota: afterRule },
      changeSummary: `${quotaRuleSummary(beforeRule, beforeInherited)} → ${quotaRuleSummary(afterRule, args.inherit === true)}`,
      changedFields: quotaRuleDiff(beforeRule, afterRule),
      rule: afterRule,
      inherit: args.inherit === true,
      version: updatedAt,
    };
  }

  public async prepareModelsMutation(request: ActionRequestContext, args: JsonObject): Promise<ModelsMutationPreparation> {
    const targetUserId = userIdArg(args);
    const desired = modelIdsArg(args);
    const current = await this.readModels(request, targetUserId);
    const supplied = expectedVersion(args);
    if (supplied && supplied !== current.version) throw errorWithCode("ACTION_VERSION_CONFLICT", "model assignments changed since preview");
    const currentModelIds = Array.isArray(current.modelIds) ? current.modelIds.filter((value): value is string => typeof value === "string") : [];
    const currentExcludedGroupModelIds = Array.isArray(current.excludedGroupModelIds)
      ? current.excludedGroupModelIds.filter((value): value is string => typeof value === "string")
      : [];
    const currentEffectiveModelIds = Array.isArray(current.effectiveModelIds)
      ? current.effectiveModelIds.filter((value): value is string => typeof value === "string")
      : [];
    const parentAllowed = new Set(Array.isArray(current.parentAllowedIds) ? current.parentAllowedIds.map(String) : []);
    const groupIds = new Set(Array.isArray(current.groupModelIds) ? current.groupModelIds.map(String) : []);
    const outsideParent = desired.filter((id) => !parentAllowed.has(id));
    if (outsideParent.length) throw errorWithCode("ACTION_VALIDATION_FAILED", `modelIds exceed the member model ceiling: ${outsideParent.join(", ")}`);
    const groupRequested = desired.filter((id) => groupIds.has(id));
    if (groupRequested.length) throw errorWithCode("ACTION_VALIDATION_FAILED", `modelIds must exclude group grants: ${groupRequested.join(", ")}`);
    const excludedGroupModelIds = excludedGroupModelIdsArg(args);
    const nextExcluded = (excludedGroupModelIds ?? (Array.isArray(current.excludedGroupModelIds) ? current.excludedGroupModelIds.map((id: unknown) => String(id)) : []))
      .filter((id: string) => groupIds.has(id));
    return {
      beforeState: {
        userId: targetUserId,
        modelIds: currentModelIds,
        parentAllowedIds: current.parentAllowedIds,
        groupModelIds: current.groupModelIds,
        excludedGroupModelIds: currentExcludedGroupModelIds,
        version: current.version,
      },
      afterState: { userId: targetUserId, modelIds: desired, excludedGroupModelIds: nextExcluded, version: current.version },
      expectedVersions: { modelVersion: current.version },
      proposal: {
        title: `调整成员「${current.displayName}」的模型权限`,
        changes: {
          member: { displayName: current.displayName, email: current.email },
          summary: `个人模型 ${currentModelIds.length} 个 → ${desired.length} 个；组模型排除 ${currentExcludedGroupModelIds.length} 个 → ${nextExcluded.length} 个`,
          before: {
            individualModelIds: currentModelIds,
            excludedGroupModelIds: currentExcludedGroupModelIds,
            effectiveModelIds: currentEffectiveModelIds,
          },
          after: {
            individualModelIds: desired,
            excludedGroupModelIds: nextExcluded,
          },
        },
      },
    };
  }

  public async setModelsMutation(context: ActionHandlerContext, args: JsonObject, operation: ActionOperation): Promise<JsonObject> {
    const targetUserId = userIdArg(args);
    const transaction = context.transaction as ActionStoreTransaction | undefined;
    const current = await this.readModels(context.request, targetUserId, transaction, Boolean(transaction));
    const user = await getAdminUser(context.request.tenantId, targetUserId);
    if (!user) throw errorWithCode("ACTION_TARGET_NOT_FOUND", "member is not available");
    const expected = String(record(operation.expectedVersions).modelVersion ?? "");
    if (current.version !== expected) throw errorWithCode("ACTION_VERSION_CONFLICT", "model assignments changed since preview");
    const beforeOperation = record(operation.beforeState);
    const beforeModelIds = Array.isArray(beforeOperation.modelIds)
      ? beforeOperation.modelIds.filter((value): value is string => typeof value === "string")
      : [];
    const beforeExcludedGroupModelIds = Array.isArray(beforeOperation.excludedGroupModelIds)
      ? beforeOperation.excludedGroupModelIds.filter((value): value is string => typeof value === "string")
      : [];
    const { raw, tables } = await dbFor(transaction);
    const parentAllowed = new Set(Array.isArray(current.parentAllowedIds) ? current.parentAllowedIds.map(String) : []);
    const groupModelIds = new Set(Array.isArray(current.groupModelIds) ? current.groupModelIds.map(String) : []);
    const desired = modelIdsArg(args);
    const groupRequested = desired.filter((id) => groupModelIds.has(id));
    if (groupRequested.length) throw errorWithCode("ACTION_VALIDATION_FAILED", `modelIds must exclude group grants: ${groupRequested.join(", ")}`);
    const saved = desired.filter((id) => parentAllowed.has(id));
    const prunedModelIds = desired.filter((id) => !parentAllowed.has(id));
    const excludedGroupModelIds = (excludedGroupModelIdsArg(args) ?? (Array.isArray(current.excludedGroupModelIds) ? current.excludedGroupModelIds.map((id: unknown) => String(id)) : []))
      .filter((id: string) => groupModelIds.has(id));
    const keys = [user.id, `email:${user.email.trim().toLowerCase()}`];
    await raw.delete(tables.models).where(and(eq(tables.models.tenantId, context.request.tenantId), inArray(tables.models.assignmentKey, keys)));
    if (saved.length) {
      const rows = keys.flatMap((assignmentKey) => saved.map((modelId) => ({ tenantId: context.request.tenantId, assignmentKey, modelId })));
      if (transaction?.dialect === "mysql") {
        await raw.insert(tables.models).values(rows).onDuplicateKeyUpdate({ set: { modelId: sql`${tables.models.modelId}` } });
      } else {
        await raw.insert(tables.models).values(rows).onConflictDoNothing();
      }
    }
    await raw.delete(tables.optOuts).where(and(eq(tables.optOuts.tenantId, context.request.tenantId), eq(tables.optOuts.userId, targetUserId), sql`${tables.optOuts.subject} like 'model:%'`));
    if (excludedGroupModelIds.length) {
      const now = new Date();
      const rows = excludedGroupModelIds.map((modelId) => ({ tenantId: context.request.tenantId, userId: targetUserId, subject: `model:${modelId}`, createdAt: now, updatedAt: now }));
      if (transaction?.dialect === "mysql") {
        await raw.insert(tables.optOuts).values(rows).onDuplicateKeyUpdate({ set: { subject: sql`${tables.optOuts.subject}` } });
      } else {
        await raw.insert(tables.optOuts).values(rows).onConflictDoNothing();
      }
    }
    const observed = await this.readModels(context.request, targetUserId, transaction, Boolean(transaction));
    await insertAudit(transaction, {
      tenantId: context.request.tenantId,
      actorUserId: context.request.userId,
      eventType: "assistant.action.member.models.set",
      targetKind: "user",
      targetId: targetUserId,
      detail: { actionId: context.action.id, operationId: operation.id, modelIds: saved, excludedGroupModelIds },
    });
    return {
      userId: targetUserId,
      member: { displayName: user.displayName, email: user.email },
      before: {
        individualModelIds: beforeModelIds,
        excludedGroupModelIds: beforeExcludedGroupModelIds,
      },
      after: { individualModelIds: saved, excludedGroupModelIds },
      changeSummary: `个人模型 ${beforeModelIds.length} 个 → ${saved.length} 个；组模型排除 ${beforeExcludedGroupModelIds.length} 个 → ${excludedGroupModelIds.length} 个`,
      modelIds: saved,
      excludedGroupModelIds,
      effectiveModelIds: observed.effectiveModelIds,
      prunedModelIds,
      version: observed.version,
    };
  }
}

function redactDetail(input: JsonObject): JsonObject {
  const output: JsonObject = {};
  const sensitive = /token|secret|password|authorization|api.?key|cipher/i;
  for (const [key, value] of Object.entries(input)) {
    if (sensitive.test(key)) continue;
    output[key] = value && typeof value === "object" && !Array.isArray(value) ? redactDetail(record(value)) : value;
  }
  return output;
}

export function createEnterpriseDomain(): EnterpriseDomain {
  return new SqlEnterpriseDomain();
}
