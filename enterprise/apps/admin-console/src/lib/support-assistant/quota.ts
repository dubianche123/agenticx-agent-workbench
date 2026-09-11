import { getQuotaConfig, type QuotaConfig, type QuotaRule } from "../token-quota-store";
import type { AdminUserDto } from "@agenticx/iam-core";
import type { QuotaSnapshot } from "./types";

function isAdministrator(user: Pick<AdminUserDto, "roleCodes">): boolean {
  return user.roleCodes.some((code) =>
    [
      "super_admin",
      "owner",
      "admin",
      "dept_admin",
      "auditor",
      "sso_admin",
      "policy_admin",
      "policy_publisher",
      "policy_auditor",
    ].includes(code.toLowerCase()),
  );
}

function cloneRule(rule: QuotaRule | undefined): QuotaRule | null {
  if (!rule) return null;
  return {
    monthlyTokens: Math.max(0, Math.floor(Number(rule.monthlyTokens) || 0)),
    // The persisted quota store normalizes omitted optional limits to zero.
    // Canonicalizing here makes the proposal's expected and desired values
    // compare equal after a readback without losing unrelated limits.
    dailyTokens: Math.max(0, Math.floor(Number(rule.dailyTokens) || 0)),
    weeklyTokens: Math.max(0, Math.floor(Number(rule.weeklyTokens) || 0)),
    tpm: Math.max(0, Math.floor(Number(rule.tpm) || 0)),
    rpm: Math.max(0, Math.floor(Number(rule.rpm) || 0)),
    maxConcurrency: Math.max(0, Math.floor(Number(rule.maxConcurrency) || 0)),
    requestsPerDay: Math.max(0, Math.floor(Number(rule.requestsPerDay) || 0)),
    requestsPerWeek: Math.max(0, Math.floor(Number(rule.requestsPerWeek) || 0)),
    requestsPerMonth: Math.max(0, Math.floor(Number(rule.requestsPerMonth) || 0)),
    poolScope: rule.poolScope === "dept" || rule.poolScope === "tenant" ? rule.poolScope : "",
    action: rule.action === "block" || rule.action === "fallback" ? rule.action : "warn",
  };
}

function roleCodeForQuota(user: Pick<AdminUserDto, "roleCodes">): "admin" | "staff" {
  return isAdministrator(user) ? "admin" : "staff";
}

export function quotaSnapshotFromConfig(
  tenantId: string,
  user: Pick<AdminUserDto, "id" | "roleCodes">,
  config: QuotaConfig,
): QuotaSnapshot {
  const roleCode = roleCodeForQuota(user);
  const personalRule = cloneRule(config.users[user.id] as QuotaRule | undefined);
  const effectiveRule = personalRule ?? cloneRule(config.defaults.role[roleCode] as QuotaRule | undefined);
  return {
    tenantId,
    userId: user.id,
    updatedAt: config.updatedAt,
    personalRule,
    effectiveRule,
    inherited: personalRule === null,
    source: personalRule ? "personal" : `role:${roleCode}`,
    roleCode,
  };
}

export async function readQuotaSnapshot(tenantId: string, user: Pick<AdminUserDto, "id" | "roleCodes">): Promise<QuotaSnapshot> {
  return quotaSnapshotFromConfig(tenantId, user, await getQuotaConfig(tenantId));
}

export function sameQuotaRule(left: QuotaRule | null | undefined, right: QuotaRule | null | undefined): boolean {
  return JSON.stringify(cloneRule(left ?? undefined)) === JSON.stringify(cloneRule(right ?? undefined));
}

export function quotaDescription(snapshot: QuotaSnapshot): string {
  const monthly = snapshot.effectiveRule?.monthlyTokens ?? 0;
  const amount = monthly > 0 ? `${monthly.toLocaleString("en-US")} Token/月` : "不限额";
  return snapshot.inherited ? `${amount}（继承 ${snapshot.roleCode} 默认）` : `${amount}（个人规则）`;
}

export function cloneQuotaRule(rule: QuotaRule | null | undefined): QuotaRule | null {
  return cloneRule(rule ?? undefined);
}
