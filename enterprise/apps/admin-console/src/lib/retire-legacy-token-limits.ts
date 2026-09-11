import {
  getQuotaConfig,
  QuotaConfigConflictError,
  setQuotaConfig,
  type QuotaConfig,
  type QuotaRule,
} from "./token-quota-store";
import type { BudgetConfig, BudgetRule } from "./budget-store";

export type LegacyTokenLimitChanges = {
  defaultMembers: boolean;
  departmentIds: string[];
  userIds: string[];
};

function sameRule(left: BudgetRule | undefined, right: BudgetRule | undefined): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function changedKeys(
  before: Record<string, BudgetRule> | undefined,
  after: Record<string, BudgetRule> | undefined,
): string[] {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  return [...keys].filter((key) => !sameRule(before?.[key], after?.[key]));
}

/**
 * 新预算规则接管金额上限后，旧 quota 里的日/周/月 Token 金额不能继续叠加。
 * TPM、RPM、并发数等技术保护仍然保留；这里只退休会与 Token/USD 二选一冲突的三项。
 */
export function legacyTokenLimitChanges(
  before: BudgetConfig,
  after: BudgetConfig,
  tenantId: string,
): LegacyTokenLimitChanges {
  return {
    defaultMembers:
      !sameRule(before.defaults, after.defaults) ||
      !sameRule(before.tenants?.[tenantId], after.tenants?.[tenantId]),
    departmentIds: changedKeys(before.departments, after.departments),
    userIds: changedKeys(before.users, after.users),
  };
}

type WindowedQuotaRule = QuotaRule & { dailyTokens?: number; weeklyTokens?: number };

function withoutAmountLimits(rule: QuotaRule | undefined): WindowedQuotaRule | undefined {
  if (!rule) return undefined;
  return {
    ...rule,
    dailyTokens: 0,
    weeklyTokens: 0,
    monthlyTokens: 0,
  };
}

export function quotaWithoutRetiredTokenLimits(
  config: QuotaConfig,
  changes: LegacyTokenLimitChanges,
): Partial<QuotaConfig> | null {
  let changed = false;
  const patch: Partial<QuotaConfig> = {};

  if (changes.defaultMembers) {
    const role = { ...config.defaults.role };
    for (const code of ["staff", "guest"] as const) {
      if (!role[code]) continue;
      role[code] = withoutAmountLimits(role[code])!;
      changed = true;
    }
    if (changed) patch.defaults = { ...config.defaults, role };
  }

  if (changes.departmentIds.length > 0) {
    const departments = { ...config.departments };
    for (const id of changes.departmentIds) {
      const next = withoutAmountLimits(departments[id]);
      if (!next) continue;
      departments[id] = next;
      changed = true;
    }
    patch.departments = departments;
  }

  if (changes.userIds.length > 0) {
    const users = { ...config.users };
    for (const id of changes.userIds) {
      const next = withoutAmountLimits(users[id]);
      if (!next) continue;
      users[id] = next;
      changed = true;
    }
    patch.users = users;
  }

  return changed ? patch : null;
}

export async function retireLegacyTokenLimits(
  tenantId: string,
  changes: LegacyTokenLimitChanges,
): Promise<void> {
  if (!changes.defaultMembers && changes.departmentIds.length === 0 && changes.userIds.length === 0) return;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const config = await getQuotaConfig(tenantId);
    const patch = quotaWithoutRetiredTokenLimits(config, changes);
    if (!patch) return;
    try {
      await setQuotaConfig(patch, tenantId, config.updatedAt);
      return;
    } catch (error) {
      if (error instanceof QuotaConfigConflictError && attempt < 3) continue;
      throw error;
    }
  }
}
