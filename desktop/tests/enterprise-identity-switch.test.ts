import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { normalizePortalOrigin } from "../electron/enterprise-browser-login";
import {
  normalizeEnterpriseCapabilities,
  type EnterpriseCapability,
} from "../electron/enterprise-capabilities";

const mainSource = fs.readFileSync(path.resolve(process.cwd(), "electron/main.ts"), "utf8");

type TransitionPlan = {
  previousIdentityKey: string | null;
  nextIdentityKey: string | null;
  cleanupRequired: boolean;
  reason: string;
};

type IdentityHelpers = {
  enterpriseStableIdentityKey: (portal: unknown, user?: Record<string, unknown>) => string | null;
  planEnterpriseIdentityTransition: (
    previous: Record<string, unknown> | undefined,
    nextPortal: string,
    nextUser: Record<string, unknown>,
  ) => TransitionPlan;
  resolveEnterpriseCapabilityBootstrap: (
    previous: Record<string, unknown> | undefined,
    nextPortal: string,
    nextUser: Record<string, unknown>,
    capabilities: unknown,
    unmetDependencies: unknown,
  ) => {
    capabilities: EnterpriseCapability[];
    unmetCapabilityDependencies: string[];
  };
  isEnterpriseCapabilityWithdrawalComplete: (result: {
    remainingMcp: string[];
    remainingSkills: string[];
    portableCleanupPending: boolean;
    errors: string[];
  }) => boolean;
};

function loadIdentityHelpers(): IdentityHelpers {
  const startMarker = "// ENTERPRISE_IDENTITY_TRANSITION_HELPERS_START";
  const endMarker = "// ENTERPRISE_IDENTITY_TRANSITION_HELPERS_END";
  const start = mainSource.indexOf(startMarker);
  const end = mainSource.indexOf(endMarker);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const snippet = mainSource.slice(start + startMarker.length, end);
  const javascript = ts.transpileModule(
    `${snippet}\n;globalThis.__identityHelpers = { enterpriseStableIdentityKey, planEnterpriseIdentityTransition, resolveEnterpriseCapabilityBootstrap, isEnterpriseCapabilityWithdrawalComplete };`,
    { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None } },
  ).outputText;
  const context = vm.createContext({ normalizePortalOrigin, normalizeEnterpriseCapabilities });
  vm.runInContext(javascript, context);
  return (context as typeof context & { __identityHelpers: IdentityHelpers }).__identityHelpers;
}

const helpers = loadIdentityHelpers();

function enterpriseConfig(userId: string, tenantId: string): Record<string, unknown> {
  return {
    enabled: true,
    base_url: "https://portal.example.test/",
    token: "pat-old",
    user: { user_id: userId, tenant_id: tenantId },
    managed_mcp_servers: ["enterprise-old"],
    managed_skills: ["old-skill"],
    capabilities: [
      {
        id: "skill:01JQMZ8K3N4P5Q6R7S8T9VWXY0",
        kind: "skill",
        name: "@finance/report-reader",
        displayName: "报告阅读",
        requires: [],
      },
    ],
    unmet_capability_dependencies: ["mcp:missing"],
  };
}

describe("enterprise identity transition guard", () => {
  it("requires cleanup for A to B even when B omits its managed portable field", () => {
    const plan = helpers.planEnterpriseIdentityTransition(
      enterpriseConfig("user-a", "tenant-a"),
      "https://portal.example.test",
      { user_id: "user-b", tenant_id: "tenant-b" },
    );

    expect(plan.cleanupRequired).toBe(true);
    expect(plan.reason).toBe("identity-changed");
  });

  it("preserves last-known-good for the same stable identity", () => {
    const plan = helpers.planEnterpriseIdentityTransition(
      enterpriseConfig("user-a", "tenant-a"),
      "https://portal.example.test/",
      { user_id: "user-a", tenant_id: "tenant-a" },
    );

    expect(plan.cleanupRequired).toBe(false);
    expect(plan.reason).toBe("same-identity");
  });

  it("keeps the capability LKG when the same identity receives an omitted snapshot", () => {
    const resolved = helpers.resolveEnterpriseCapabilityBootstrap(
      enterpriseConfig("user-a", "tenant-a"),
      "https://portal.example.test/",
      { user_id: "user-a", tenant_id: "tenant-a" },
      undefined,
      undefined,
    );

    expect(resolved.capabilities.map((item) => item.id)).toEqual([
      "skill:01JQMZ8K3N4P5Q6R7S8T9VWXY0",
    ]);
    expect(resolved.unmetCapabilityDependencies).toEqual(["mcp:missing"]);
  });

  it("treats an explicit empty capability snapshot as an authoritative withdrawal", () => {
    const resolved = helpers.resolveEnterpriseCapabilityBootstrap(
      enterpriseConfig("user-a", "tenant-a"),
      "https://portal.example.test",
      { user_id: "user-a", tenant_id: "tenant-a" },
      [],
      [],
    );

    expect(resolved.capabilities).toEqual([]);
    expect(resolved.unmetCapabilityDependencies).toEqual([]);
  });

  it("never carries an omitted capability snapshot across identities", () => {
    const changed = helpers.resolveEnterpriseCapabilityBootstrap(
      enterpriseConfig("user-a", "tenant-a"),
      "https://portal.example.test",
      { user_id: "user-b", tenant_id: "tenant-b" },
      undefined,
      undefined,
    );
    const firstLogin = helpers.resolveEnterpriseCapabilityBootstrap(
      undefined,
      "https://portal.example.test",
      { user_id: "user-a", tenant_id: "tenant-a" },
      undefined,
      undefined,
    );

    expect(changed.capabilities).toEqual([]);
    expect(firstLogin.capabilities).toEqual([]);
  });

  it("treats a token-free cleanup tombstone and a first login as cleanup boundaries", () => {
    const tombstone = helpers.planEnterpriseIdentityTransition(
      {
        enabled: true,
        default_portal_url: "https://portal.example.test",
        managed_portable_cleanup_pending: true,
      },
      "https://portal.example.test",
      { user_id: "user-a", tenant_id: "tenant-a" },
    );
    const firstLogin = helpers.planEnterpriseIdentityTransition(
      undefined,
      "https://portal.example.test",
      { user_id: "user-a", tenant_id: "tenant-a" },
    );

    expect(tombstone.cleanupRequired).toBe(true);
    expect(tombstone.reason).toBe("pending-cleanup");
    expect(firstLogin.cleanupRequired).toBe(true);
    expect(firstLogin.reason).toBe("new-or-unknown-identity");

    const withdrawalStart = mainSource.indexOf(
      "async function withdrawEnterpriseCapabilitiesFromDisk(",
    );
    const withdrawalEnd = mainSource.indexOf(
      "\nlet enterpriseCleanupRetryScheduled",
      withdrawalStart,
    );
    const withdrawalSource = mainSource.slice(withdrawalStart, withdrawalEnd);
    expect(withdrawalSource).toContain("reconcileManagedPortablePackages([])");
    expect(withdrawalSource).not.toContain("if (!ent)");
  });

  it("blocks identity application unless MCP, Skill and portable cleanup all finish", () => {
    expect(helpers.isEnterpriseCapabilityWithdrawalComplete({
      remainingMcp: [],
      remainingSkills: [],
      portableCleanupPending: true,
      errors: ["portable unavailable"],
    })).toBe(false);
    expect(helpers.isEnterpriseCapabilityWithdrawalComplete({
      remainingMcp: [],
      remainingSkills: [],
      portableCleanupPending: false,
      errors: [],
    })).toBe(true);

    const finishStart = mainSource.indexOf("async function finishEnterpriseLoginUnlocked(");
    const finishEnd = mainSource.indexOf("\nfunction finishEnterpriseLogin(", finishStart);
    const finishSource = mainSource.slice(finishStart, finishEnd);
    const withdrawIndex = finishSource.indexOf("await prepareEnterpriseIdentityChange(cfg)");
    const blockIndex = finishSource.indexOf(
      "if (!prepared.ok)",
    );
    const applyIndex = finishSource.indexOf("applyEnterpriseProvider(cfg");

    expect(withdrawIndex).toBeGreaterThanOrEqual(0);
    expect(blockIndex).toBeGreaterThan(withdrawIndex);
    expect(applyIndex).toBeGreaterThan(blockIndex);
    expect(finishSource.slice(blockIndex, applyIndex)).toContain("return {");
    const helperStart = mainSource.indexOf("async function prepareEnterpriseIdentityChange(");
    const helperEnd = mainSource.indexOf("// ENTERPRISE_IDENTITY_TRANSITION_HELPERS_END", helperStart);
    const helperSource = mainSource.slice(helperStart, helperEnd);
    expect(helperSource).toContain("await withdrawEnterpriseCapabilitiesFromDisk(initial)");
    expect(helperSource).toContain("persistEnterpriseCleanupTombstone(cfg, withdrawal)");
    expect(helperSource).toContain("clearEnterpriseFromConfig(cfg)");
  });

  it("applies the same identity cleanup guard during refresh and treats 401 as revocation", () => {
    const refreshStart = mainSource.indexOf(
      "async function refreshEnterpriseFromPortalUnlocked()",
    );
    const refreshEnd = mainSource.indexOf(
      "\n  function refreshEnterpriseFromPortal()",
      refreshStart,
    );
    const refreshSource = mainSource.slice(refreshStart, refreshEnd);

    const transitionIndex = refreshSource.indexOf("planEnterpriseIdentityTransition(");
    const cleanupIndex = refreshSource.indexOf("await prepareEnterpriseIdentityChange(current)");
    const applyIndex = refreshSource.indexOf("applyEnterpriseProvider(current");
    expect(transitionIndex).toBeGreaterThanOrEqual(0);
    expect(cleanupIndex).toBeGreaterThan(transitionIndex);
    expect(applyIndex).toBeGreaterThan(cleanupIndex);
    expect(refreshSource.slice(cleanupIndex, applyIndex)).toContain("if (!prepared.ok)");

    const unauthorizedIndex = refreshSource.indexOf("bootResp.status === 401");
    const revokeIndex = refreshSource.indexOf(
      'await clearEnterpriseAccountUnlocked(cfg, "server-revoked")',
    );
    expect(unauthorizedIndex).toBeGreaterThanOrEqual(0);
    expect(revokeIndex).toBeGreaterThan(unauthorizedIndex);
    expect(refreshSource.slice(unauthorizedIndex, revokeIndex)).toContain(
      "advanceEnterpriseAuthGeneration()",
    );
  });

  it("fails closed on a 503 or malformed bootstrap without replacing the enterprise LKG", () => {
    const finishStart = mainSource.indexOf("async function finishEnterpriseLoginUnlocked(");
    const finishEnd = mainSource.indexOf("\nfunction finishEnterpriseLogin(", finishStart);
    const finishSource = mainSource.slice(finishStart, finishEnd);
    const refreshStart = mainSource.indexOf(
      "async function refreshEnterpriseFromPortalUnlocked()",
    );
    const refreshEnd = mainSource.indexOf(
      "\n  function refreshEnterpriseFromPortal()",
      refreshStart,
    );
    const refreshSource = mainSource.slice(refreshStart, refreshEnd);

    for (const source of [finishSource, refreshSource]) {
      const dataGuard = source.indexOf(
        "const hasUsableBootstrapData = hasUsableEnterpriseBootstrapData(bootJson.data);",
      );
      const fallbackGuard = source.indexOf(
        "if (bootResp.status === 503 && !hasUsableBootstrapData)",
      );
      const inferenceSelection = source.indexOf("selectEnterpriseInferenceBase({");

      expect(dataGuard).toBeGreaterThanOrEqual(0);
      expect(fallbackGuard).toBeGreaterThan(dataGuard);
      expect(inferenceSelection).toBeGreaterThan(fallbackGuard);
      expect(source.slice(fallbackGuard, inferenceSelection)).toContain(
        "已保留本机现有配置",
      );
      expect(source.slice(dataGuard, inferenceSelection)).toContain(
        "if (!hasUsableBootstrapData)",
      );
    }
  });
});
