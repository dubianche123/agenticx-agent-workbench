import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ENTERPRISE_CAPABILITY_SYNC_ERRORS,
  failPendingEnterpriseCapabilitySyncStatuses,
  finalizeEnterpriseSkillSyncAfterIndexRefresh,
  recordEnterpriseCapabilitySyncStatus,
  stageManagedSkillDirectory,
  writeManagedSkillDirectory,
  type EnterpriseCapabilitySyncConfig,
  type EnterpriseCapabilitySyncConfigStore,
} from "../electron/enterprise-capability-sync";
import type { EnterpriseCapability } from "../electron/enterprise-capabilities";

const desktopRoot = process.cwd();
const temporaryRoots: string[] = [];

function read(relativePath: string): string {
  return fs.readFileSync(path.join(desktopRoot, relativePath), "utf8");
}

/** Return one source region without importing Electron's side-effectful entry. */
function sourceRegion(source: string, start: string, end: string): string {
  const startAt = source.indexOf(start);
  if (startAt < 0) throw new Error(`missing source marker: ${start}`);
  const endAt = source.indexOf(end, startAt + start.length);
  if (endAt < 0) throw new Error(`missing source marker: ${end}`);
  return source.slice(startAt, endAt);
}

function skill(overrides: Partial<EnterpriseCapability> = {}): EnterpriseCapability {
  return {
    id: "skill:contract",
    kind: "skill",
    name: "contract-skill",
    displayName: "Contract Skill",
    requires: [],
    version: "1.0.0",
    bundleUri: "https://portal.example.invalid/skills/contract/SKILL.md",
    bundleDigest: "a".repeat(64),
    ...overrides,
  };
}

function storeWith(
  initial: EnterpriseCapabilitySyncConfig,
): {
  store: EnterpriseCapabilitySyncConfigStore<EnterpriseCapabilitySyncConfig>;
  read: () => EnterpriseCapabilitySyncConfig;
} {
  let config = initial;
  return {
    store: {
      load: () => config,
      save: (next) => {
        config = next;
      },
    },
    read: () => config,
  };
}

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenticx-main-contract-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("enterprise capability main-process wiring contract", () => {
  it("passes staged Skill transactions through index refresh and settles them", () => {
    const main = read("electron/main.ts");
    const sync = sourceRegion(
      main,
      "async function syncEnterpriseCapabilitiesToDisk(",
      "type EnterpriseCapabilityWithdrawalResult",
    );
    const finalize = sourceRegion(
      main,
      "function finalizeEnterpriseSkillSyncAfterIndexRefresh(",
      "function failPendingEnterpriseCapabilitySyncStatuses(",
    );

    expect(sync).toContain("const skillTransactions = beginEnterpriseSkillTransactionRound(token);");
    expect(sync).toMatch(
      /writeManagedSkill\(capability\.id,\s*item\.dirName,\s*fetched\.content,\s*skillTransactions\)/s,
    );
    const market = sourceRegion(
      main,
      "async function reconcileManagedMarketSkills(",
      "async function reconcileManagedPortablePackages(",
    );
    expect(market).toContain("planManagedMarketSkills(packages, previous)");
    expect(market).toContain("stageManagedMarketSkillDirectory(root, item.dirName, item.content)");
    expect(market).toContain("removeManagedMarketSkill(dirName)");
    expect(market).toContain("if (!plan.ok || !plan.desired)");
    expect(market).toContain("assertManagedMarketSkillTarget(target)");
    expect(finalize).toContain("const transactions = pendingEnterpriseSkillTransactions.get(expectedToken);");
    expect(finalize).toContain("settleManagedSkillDirectoryTransactions(");
    expect(finalize).toContain("previousMarketLedger");
    expect(finalize).toMatch(
      /finalizeEnterpriseSkillSyncAfterIndexRefreshHelper\([\s\S]*?transactions,\s*\);/,
    );

    const login = sourceRegion(
      main,
      "async function finishEnterpriseLoginUnlocked(",
      "function finishEnterpriseLogin(",
    );
    const refresh = sourceRegion(
      main,
      "async function refreshEnterpriseFromPortalUnlocked(",
      "function refreshEnterpriseFromPortal(",
    );
    for (const flow of [login, refresh]) {
      expect(flow).toMatch(
        /syncEnterpriseCapabilitiesToDisk\([\s\S]*?refreshSkillIndexAfterEnterpriseChange\(\)/s,
      );
      expect(flow).toContain("loadedEnterpriseSkillCapabilityIds(syncedCapabilities, loadedPaths)");
      expect(flow).toContain("loadedEnterpriseMarketSkillCapabilityIds(");
      expect(flow).toMatch(
        /finalizeEnterpriseSkillSyncAfterIndexRefresh\([\s\S]*?loadedCapabilityIds/s,
      );
    }

    const removal = sourceRegion(
      main,
      "function removeManagedSkill(dirName: string): void",
      "/**\n * 把这次下发的能力落到本机",
    );
    expect(removal).toContain("recoverInterruptedManagedSkillDirectory(");
  });

  it("settles market LKG before rethrowing a legacy finalizer error", () => {
    const main = read("electron/main.ts");
    const finalize = sourceRegion(
      main,
      "function finalizeEnterpriseSkillSyncAfterIndexRefresh(",
      "function failPendingEnterpriseCapabilitySyncStatuses(",
    );

    expect(finalize).toContain("let legacyFinalizeFailed = false;");
    expect(finalize).toContain("legacyFinalizeFailed = true;");
    expect(finalize).toContain("legacyFinalizeError = error;");
    expect(finalize).toContain("ok && !legacyFinalizeFailed");
    const marketSettlement = finalize.indexOf("marketSettlement = settleManagedSkillDirectoryTransactions(");
    const ledgerRepair = finalize.indexOf("cfg.enterprise.managed_market_skills = ledger;");
    const rethrow = finalize.indexOf("if (legacyFinalizeFailed) throw legacyFinalizeError;");
    expect(marketSettlement).toBeGreaterThan(-1);
    expect(ledgerRepair).toBeGreaterThan(marketSettlement);
    expect(rethrow).toBeGreaterThan(ledgerRepair);
  });

  it("keeps voluntary market installation state exact and separate from forced delivery", () => {
    const main = read("electron/main.ts");
    const install = sourceRegion(
      main,
      "async function installPortableMarketSkillRaw(",
      'ipcMain.handle("list-portable-market-installed-skills"',
    );
    const installed = sourceRegion(
      main,
      "function scanInstalledPortableMarketSkills(): InstalledPortableMarketSkill[]",
      "async function inspectPortablePackageRaw(",
    );

    expect(install).toContain("actualDigest");
    expect(install).toContain("item.digest");
    expect(install).toContain("manifest.artifact_id");
    expect(install).toContain("manifest.release_version");
    expect(install).toContain("sameArtifact");
    expect(install).toContain("if (!sameArtifact || !sameItem)");
    expect(install).toContain('item.status !== "published"');
    expect(install).not.toContain("item.deliveryState");
    expect(installed).toContain('PORTABLE_MARKET_SKILL_MARKER');
    expect(installed).toContain('parsed.item_id');
    expect(installed).toContain('marker !== itemId');
    expect(installed).toContain('parsed.version');
    expect(installed).toContain('parsed.digest');
    expect(installed).toContain('parsed.name');
    expect(installed).toContain('lstatSync(path.join(target, "SKILL.md"))');
    expect(main).toContain('ipcMain.handle("list-portable-market-installed-skills"');
    expect(main).toContain('listInstalledPortableMarketSkills()');
    expect(main).toContain('previousCopies.some((installed) => installed.name !== name)');
  });

  it.each([
    ["successful index omits the new directory", true, new Set<string>(), "skill_not_loaded"],
    ["index refresh fails", false, new Set(["skill:contract"]), "index_refresh_failed"],
  ])("rolls a staged replacement back when %s", (_label, refreshOk, loadedIds, errorCode) => {
    const root = temporaryRoot();
    const capability = skill();
    writeManagedSkillDirectory(root, "contract-skill", "last-known-good");
    const transaction = stageManagedSkillDirectory(root, "contract-skill", "candidate");
    const state = storeWith({
      enterprise: {
        enabled: true,
        token: "pat-contract",
        capability_sync_statuses: [
          { capabilityId: capability.id, kind: "skill", status: "verifying" },
        ],
      },
    });

    finalizeEnterpriseSkillSyncAfterIndexRefresh(
      [capability],
      "pat-contract",
      refreshOk,
      state.store,
      refreshOk ? undefined : "index unavailable",
      loadedIds,
      new Map([[capability.id, transaction]]),
    );

    expect(fs.readFileSync(path.join(root, "contract-skill", "SKILL.md"), "utf8")).toBe(
      "last-known-good",
    );
    expect(transaction.state).toBe("rolled_back");
    expect(state.read().enterprise?.capability_sync_statuses?.[0]).toMatchObject({
      status: "failed",
      errorCode,
    });
  });

  it("converges every non-terminal row in an outer catch while preserving terminal rows", () => {
    const capabilities = [
      skill({ id: "skill:waiting" }),
      skill({ id: "skill:downloading" }),
      skill({ id: "skill:verifying" }),
      skill({ id: "skill:applied" }),
      skill({ id: "skill:failed" }),
    ];
    const state = storeWith({
      enterprise: {
        enabled: true,
        token: "pat-contract",
        capability_sync_statuses: [
          { capabilityId: "skill:waiting", kind: "skill", status: "waiting" },
          { capabilityId: "skill:downloading", kind: "skill", status: "downloading" },
          { capabilityId: "skill:verifying", kind: "skill", status: "verifying" },
          { capabilityId: "skill:applied", kind: "skill", status: "applied" },
          {
            capabilityId: "skill:failed",
            kind: "skill",
            status: "failed",
            errorCode: ENTERPRISE_CAPABILITY_SYNC_ERRORS.write_failed,
          },
        ],
      },
    });

    failPendingEnterpriseCapabilitySyncStatuses(
      capabilities,
      "pat-contract",
      state.store,
      {
        errorCode: ENTERPRISE_CAPABILITY_SYNC_ERRORS.sync_incomplete,
        message: "outer catch",
      },
    );

    expect(state.read().enterprise?.capability_sync_statuses).toEqual([
      expect.objectContaining({
        capabilityId: "skill:waiting",
        status: "failed",
        errorCode: "sync_incomplete",
        message: "outer catch",
      }),
      expect.objectContaining({
        capabilityId: "skill:downloading",
        status: "failed",
        errorCode: "sync_incomplete",
        message: "outer catch",
      }),
      expect.objectContaining({
        capabilityId: "skill:verifying",
        status: "failed",
        errorCode: "sync_incomplete",
        message: "outer catch",
      }),
      expect.objectContaining({ capabilityId: "skill:applied", status: "applied" }),
      expect.objectContaining({
        capabilityId: "skill:failed",
        status: "failed",
        errorCode: ENTERPRISE_CAPABILITY_SYNC_ERRORS.write_failed,
      }),
    ]);
  });

  it("converges stale non-terminal rows on every refresh exit path", () => {
    const main = read("electron/main.ts");
    const refresh = sourceRegion(
      main,
      "async function refreshEnterpriseFromPortalUnlocked(",
      "function refreshEnterpriseFromPortal(",
    );

    expect(refresh).toContain("} finally {");
    expect(refresh).toContain("enterpriseManagedDeliveryCapabilities(");
    expect(refresh).toContain("failPendingEnterpriseCapabilitySyncStatuses(managed, token)");
    expect(refresh).toContain("shouldRetryEnterpriseCapabilityReceipt(");
    expect(refresh).toContain("!receiptScheduledThisRefresh");
    expect(refresh).toContain("scheduleEnterpriseCapabilityReceipt(");
    expect(refresh).toContain("emitEnterpriseCapabilitiesChanged();");
  });

  it("recovers interrupted Skill swaps before backend startup and before each sync", () => {
    const main = read("electron/main.ts");
    const sync = sourceRegion(
      main,
      "async function syncEnterpriseCapabilitiesToDisk(",
      "type EnterpriseCapabilityWithdrawalResult",
    );
    const startup = sourceRegion(
      main,
      "app.whenReady().then(async () => {",
      "const startLocalBackendFlow",
    );

    expect(sync).toContain("recoverInterruptedEnterpriseSkillTransactions()");
    expect(startup).toContain("recoverInterruptedEnterpriseSkillTransactions()");
    expect(startup.indexOf("recoverInterruptedEnterpriseSkillTransactions()"))
      .toBeLessThan(startup.indexOf("registerIpc()"));
  });

  it("uses the strict MCP read/write/read-back helper and forwards deletion intent", () => {
    const main = read("electron/main.ts");
    const readMcp = sourceRegion(
      main,
      "async function readMcpDocumentViaStudio(",
      "async function writeMcpDocumentViaStudio(",
    );
    const writeMcp = sourceRegion(
      main,
      "async function writeMcpDocumentViaStudio(",
      "async function fetchSkillBundleDetailed(",
    );

    expect(readMcp).toContain("readEnterpriseMcpDocument(");
    expect(readMcp).not.toContain("proxyAwareFetch(");
    expect(writeMcp).toContain("writeEnterpriseMcpDocumentAndConfirm(");
    expect(writeMcp).toContain("desiredManagedEntries");
    expect(writeMcp).toContain("requestedDeletions");
    expect(writeMcp).not.toMatch(/method:\s*[\"']PUT[\"']/);

    const sync = sourceRegion(
      main,
      "async function syncEnterpriseCapabilitiesToDisk(",
      "type EnterpriseCapabilityWithdrawalResult",
    );
    expect(sync).toContain("mcpCapabilities.length > 0 || removedNames.size > 0");
  });

  it("binds receipts to generation and identity, and logout aborts their controllers", () => {
    const main = read("electron/main.ts");
    expect(main).toMatch(
      /function advanceEnterpriseAuthGeneration\(\): number \{[\s\S]*?enterpriseReceiptAbortControllers\)[\s\S]*?\.abort\(\)/,
    );

    const receipt = sourceRegion(
      main,
      "function scheduleEnterpriseCapabilityReceipt(",
      "function enterpriseSkillsRoot(",
    );
    expect(receipt).toContain("const generation = enterpriseAuthGeneration;");
    expect(receipt).toContain("tenant_id");
    expect(receipt).toContain("user_id");
    expect(receipt).toContain("user?.email");
    expect(receipt).toContain("generation !== enterpriseAuthGeneration");
    expect(receipt).toContain("queueKey");
    expect(receipt).toContain("signal: controller.signal");

    const logout = sourceRegion(
      main,
      "async function logoutEnterpriseAccount(): Promise<{ ok: true; cleanupPending: boolean }>",
      'ipcMain.handle("user-account-logout"',
    );
    expect(logout).toMatch(
      /advanceEnterpriseAuthGeneration\(\);[\s\S]*?return withEnterpriseMutationLock\(/,
    );
  });

  it("retries one transient cold-start reconciliation after Studio becomes ready", () => {
    const main = read("electron/main.ts");
    const startup = sourceRegion(
      main,
      "// Reconcile once after Studio is actually ready.",
      "/**\n   * 定时把撤销捡回来。",
    );
    expect(startup).toContain("const startupDelays = [0, 1_500] as const;");
    expect(startup).toContain("for (const delayMs of startupDelays)");
    expect(startup).toContain("const result = await refreshEnterpriseFromPortal();");
    expect(startup).toContain("if (result.ok || result.unauthorized) return;");
  });

  it("emits main and preload beside the configured package entry", () => {
    const pkg = JSON.parse(read("package.json")) as { main?: string };
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "agenticx-electron-output-"));
    temporaryRoots.push(outputDir);
    const tsc = path.join(desktopRoot, "node_modules", "typescript", "bin", "tsc");

    execFileSync(
      process.execPath,
      [
        tsc,
        "-p",
        "electron/tsconfig.json",
        "--outDir",
        outputDir,
        "--pretty",
        "false",
      ],
      { cwd: desktopRoot, encoding: "utf8", stdio: "pipe" },
    );

    const packageEntry = String(pkg.main ?? "");
    expect(packageEntry).toBe("dist-electron/main.js");
    const mainOutput = path.join(outputDir, packageEntry.replace(/^dist-electron[\\/]/u, ""));
    expect(fs.existsSync(mainOutput)).toBe(true);
    expect(fs.existsSync(path.join(path.dirname(mainOutput), "preload.js"))).toBe(true);
  }, 30_000);
});
