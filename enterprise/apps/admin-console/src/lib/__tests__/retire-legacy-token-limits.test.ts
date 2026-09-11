import { describe, expect, it } from "vitest";

import {
  legacyTokenLimitChanges,
  quotaWithoutRetiredTokenLimits,
} from "../retire-legacy-token-limits";
import type { BudgetConfig } from "../budget-store";
import type { QuotaConfig } from "../token-quota-store";

const BUDGET: BudgetConfig = {
  updatedAt: "2026-08-24T00:00:00.000Z",
  sessionTokenLimits: { warningTokensPerSession: 500_000, maxTokensPerSession: 1_000_000 },
  desktopCapabilityPolicy: {
    allowLocalSkillInstall: false,
    allowLocalMcpInstall: false,
    allowMcpAutoDiscovery: false,
  },
  defaults: { unit: "tokens", period: "month", limit: 1000, action: "block" },
  tenants: {},
  departments: {},
  users: {},
};

const QUOTA = {
  defaults: {
    role: {
      admin: { monthlyTokens: 9000, action: "block" },
      staff: { dailyTokens: 100, weeklyTokens: 500, monthlyTokens: 1000, rpm: 20, action: "block" },
      guest: { monthlyTokens: 500, action: "warn" },
    },
    model: {},
  },
  users: {
    alice: { monthlyTokens: 800, tpm: 50, action: "block" },
  },
  departments: {
    research: { monthlyTokens: 5000, maxConcurrency: 2, action: "block" },
  },
  updatedAt: "2026-08-24T00:00:00.000Z",
} as unknown as QuotaConfig;

describe("retiring legacy token amount limits", () => {
  it("detects only budget scopes whose rule changed", () => {
    const next: BudgetConfig = {
      ...BUDGET,
      defaults: { unit: "cost_usd", period: "month", limit: 20, action: "block" },
      departments: { research: { unit: "tokens", period: "week", limit: 3000, action: "block" } },
      users: { alice: { unit: "cost_usd", period: "month", limit: 5, action: "warn" } },
    };
    expect(legacyTokenLimitChanges(BUDGET, next, "tenant-a")).toEqual({
      defaultMembers: true,
      departmentIds: ["research"],
      userIds: ["alice"],
    });
  });

  it("zeros amount windows but keeps rate and concurrency protection", () => {
    const patch = quotaWithoutRetiredTokenLimits(QUOTA, {
      defaultMembers: true,
      departmentIds: ["research"],
      userIds: ["alice"],
    });
    expect(patch?.defaults?.role.staff).toMatchObject({
      dailyTokens: 0,
      weeklyTokens: 0,
      monthlyTokens: 0,
      rpm: 20,
    });
    expect(patch?.defaults?.role.admin?.monthlyTokens).toBe(9000);
    expect(patch?.users?.alice).toMatchObject({ monthlyTokens: 0, tpm: 50 });
    expect(patch?.departments?.research).toMatchObject({ monthlyTokens: 0, maxConcurrency: 2 });
  });

  it("does nothing when the changed scope had no legacy rule", () => {
    expect(
      quotaWithoutRetiredTokenLimits(QUOTA, {
        defaultMembers: false,
        departmentIds: ["missing"],
        userIds: ["missing"],
      }),
    ).toBeNull();
  });
});
