import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../electron/proxy-fetch", () => ({
  proxyAwareFetch: vi.fn(),
}));

import { proxyAwareFetch } from "../electron/proxy-fetch";

import {
  ENTERPRISE_CAPABILITY_SYNC_ERRORS,
  enqueueEnterpriseCapabilityReceipts,
  fetchSkillBundleDetailed,
  finalizeEnterpriseSkillSyncAfterIndexRefresh,
  markEnterpriseCapabilitySyncStatusesWaiting,
  persistEnterpriseCapabilityReceiptSummary,
  postEnterpriseCapabilityReceipts,
  pruneEnterpriseCapabilitySyncState,
  recordEnterpriseCapabilitySyncStatus,
  settleManagedSkillDirectoryTransactions,
  shouldRetryEnterpriseCapabilityReceipt,
  stageManagedSkillDirectory,
  writeManagedSkillDirectory,
  type EnterpriseCapabilitySyncConfig,
  type EnterpriseCapabilitySyncConfigStore,
} from "../electron/enterprise-capability-sync";
import {
  convergeEnterpriseCapabilitySyncStatusesToFailed,
  normalizeEnterpriseCapabilitySyncStatuses,
} from "../shared/enterprise-capability-sync";
import type { EnterpriseCapability } from "../electron/enterprise-capabilities";

const fetchMock = vi.mocked(proxyAwareFetch);
const temporaryRoots: string[] = [];

function skill(overrides: Partial<EnterpriseCapability> = {}): EnterpriseCapability {
  return {
    id: "skill:one",
    kind: "skill",
    name: "research",
    displayName: "Research",
    requires: [],
    version: "1.0.0",
    bundleUri: "https://portal.example.invalid/skills/research/SKILL.md",
    bundleDigest: "a".repeat(64),
    ...overrides,
  };
}

function mcp(overrides: Partial<EnterpriseCapability> = {}): EnterpriseCapability {
  return {
    id: "mcp:one",
    kind: "mcp",
    name: "market-data",
    displayName: "Market Data",
    requires: [],
    version: "2.0.0",
    endpointUrl: "https://gateway.example.invalid/mcp",
    ...overrides,
  };
}

function memoryStore(
  initial: EnterpriseCapabilitySyncConfig = {
    enterprise: { enabled: true, token: "pat-test" },
  },
): { store: EnterpriseCapabilitySyncConfigStore<EnterpriseCapabilitySyncConfig>; read: () => EnterpriseCapabilitySyncConfig } {
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

afterEach(() => {
  vi.restoreAllMocks();
  fetchMock.mockReset();
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("normalizeEnterpriseCapabilitySyncStatuses", () => {
  it("keeps only valid capability-scoped rows and normalizes digests", () => {
    expect(
      normalizeEnterpriseCapabilitySyncStatuses([
        {
          capabilityId: "skill:one",
          kind: "skill",
          status: "failed",
          digest: "ABCD",
          errorCode: "digest_mismatch",
        },
        { capabilityId: "mcp:one", kind: "mcp", status: "applied" },
        { capabilityId: "skill:bad", kind: "skill", status: "installed" },
        { capabilityId: "", kind: "mcp", status: "waiting" },
      ]),
    ).toEqual([
      {
        capabilityId: "skill:one",
        kind: "skill",
        status: "failed",
        digest: "abcd",
        errorCode: "digest_mismatch",
      },
      { capabilityId: "mcp:one", kind: "mcp", status: "applied" },
    ]);
  });

  it("uses the latest row for a capability", () => {
    expect(
      normalizeEnterpriseCapabilitySyncStatuses([
        { capabilityId: "skill:one", kind: "skill", status: "waiting" },
        { capabilityId: "skill:one", kind: "skill", status: "applied" },
      ]),
    ).toEqual([{ capabilityId: "skill:one", kind: "skill", status: "applied" }]);
  });

  it("does not collapse different capability kinds that reuse an id", () => {
    expect(
      normalizeEnterpriseCapabilitySyncStatuses([
        { capabilityId: "shared-id", kind: "skill", status: "applied" },
        { capabilityId: "shared-id", kind: "mcp", status: "failed" },
      ]),
    ).toEqual([
      { capabilityId: "shared-id", kind: "skill", status: "applied" },
      { capabilityId: "shared-id", kind: "mcp", status: "failed" },
    ]);
  });

  it("converges every in-flight row to failed without changing terminal rows", () => {
    const statuses = [
      { capabilityId: "skill:one", kind: "skill" as const, status: "waiting" as const },
      { capabilityId: "skill:two", kind: "skill" as const, status: "downloading" as const },
      { capabilityId: "skill:three", kind: "skill" as const, status: "verifying" as const },
      { capabilityId: "skill:good", kind: "skill" as const, status: "applied" as const },
      { capabilityId: "skill:bad", kind: "skill" as const, status: "failed" as const, errorCode: "write_failed" },
    ];
    const failed = convergeEnterpriseCapabilitySyncStatusesToFailed(statuses, {
      errorCode: "index_refresh_failed",
      message: "index unavailable",
    });
    expect(failed).toEqual([
      { capabilityId: "skill:one", kind: "skill", status: "failed", errorCode: "index_refresh_failed", message: "index unavailable" },
      { capabilityId: "skill:two", kind: "skill", status: "failed", errorCode: "index_refresh_failed", message: "index unavailable" },
      { capabilityId: "skill:three", kind: "skill", status: "failed", errorCode: "index_refresh_failed", message: "index unavailable" },
      { capabilityId: "skill:good", kind: "skill", status: "applied" },
      { capabilityId: "skill:bad", kind: "skill", status: "failed", errorCode: "write_failed" },
    ]);
    expect(convergeEnterpriseCapabilitySyncStatusesToFailed(failed)).toEqual(failed);
  });
});

describe("enterprise capability status ledger", () => {
  it("guards writes by PAT, starts a fresh attempt, and retains LKG metadata", () => {
    const { store, read } = memoryStore();
    const capability = skill();
    const appliedAt = "2026-09-02T01:00:00.000Z";

    recordEnterpriseCapabilitySyncStatus(
      capability,
      { status: "waiting", attemptedAt: "2026-09-02T00:00:00.000Z" },
      "pat-test",
      store,
    );
    recordEnterpriseCapabilitySyncStatus(
      capability,
      { status: "applied", appliedAt },
      "pat-test",
      store,
    );
    recordEnterpriseCapabilitySyncStatus(
      capability,
      { status: "waiting", attemptedAt: "2026-09-02T02:00:00.000Z" },
      "pat-test",
      store,
    );
    recordEnterpriseCapabilitySyncStatus(
      capability,
      {
        status: "failed",
        errorCode: ENTERPRISE_CAPABILITY_SYNC_ERRORS.digest_mismatch,
        message: "digest mismatch",
      },
      "pat-test",
      store,
    );

    expect(read().enterprise?.capability_sync_statuses).toEqual([
      {
        capabilityId: capability.id,
        kind: "skill",
        status: "failed",
        version: "1.0.0",
        digest: "a".repeat(64),
        errorCode: "digest_mismatch",
        message: "digest mismatch",
        attemptedAt: "2026-09-02T02:00:00.000Z",
      },
    ]);
    expect(read().enterprise?.capability_sync_last_applied).toEqual({
      [`skill:${capability.id}`]: {
        version: "1.0.0",
        digest: "a".repeat(64),
        appliedAt,
      },
    });

    const beforeUnauthorized = JSON.stringify(read());
    expect(
      recordEnterpriseCapabilitySyncStatus(
        capability,
        { status: "applied" },
        "stale-token",
        store,
      ),
    ).toBeNull();
    expect(JSON.stringify(read())).toBe(beforeUnauthorized);
  });

  it("uses one attempt timestamp and prunes revoked capabilities", () => {
    const { store, read } = memoryStore({
      enterprise: {
        enabled: true,
        token: "pat-test",
        capability_sync_statuses: [
          { capabilityId: "skill:one", kind: "skill", status: "applied" },
          { capabilityId: "mcp:one", kind: "mcp", status: "failed" },
          { capabilityId: "skill:revoked", kind: "skill", status: "failed" },
        ],
        capability_sync_last_applied: {
          "skill:one": { appliedAt: "2026-09-01T00:00:00.000Z" },
          "skill:revoked": { appliedAt: "2026-09-01T00:00:00.000Z" },
        },
      },
    });
    const capabilities = [skill(), mcp()];
    markEnterpriseCapabilitySyncStatusesWaiting(
      capabilities,
      "pat-test",
      store,
      "2026-09-02T03:00:00.000Z",
    );
    const waiting = normalizeEnterpriseCapabilitySyncStatuses(
      read().enterprise?.capability_sync_statuses,
    );
    expect(
      waiting
        .filter((item) => item.capabilityId === "skill:one" || item.capabilityId === "mcp:one")
        .map((item) => item.attemptedAt),
    ).toEqual([
      "2026-09-02T03:00:00.000Z",
      "2026-09-02T03:00:00.000Z",
    ]);

    pruneEnterpriseCapabilitySyncState([skill()], "pat-test", store);
    expect(
      normalizeEnterpriseCapabilitySyncStatuses(read().enterprise?.capability_sync_statuses),
    ).toEqual([
      expect.objectContaining({ capabilityId: "skill:one", status: "waiting" }),
    ]);
    expect(Object.keys(read().enterprise?.capability_sync_last_applied ?? {})).toEqual([
      "skill:skill:one",
    ]);
  });

  it("scopes LKG metadata by capability kind", () => {
    const { store, read } = memoryStore();
    const sharedSkill = skill({ id: "shared-id" });
    const sharedMcp = mcp({ id: "shared-id" });
    recordEnterpriseCapabilitySyncStatus(sharedSkill, { status: "applied" }, "pat-test", store);
    recordEnterpriseCapabilitySyncStatus(sharedMcp, { status: "applied" }, "pat-test", store);
    expect(read().enterprise?.capability_sync_last_applied).toEqual({
      "skill:shared-id": expect.objectContaining({ version: "1.0.0" }),
      "mcp:shared-id": expect.objectContaining({ version: "2.0.0" }),
    });
  });

  it("only marks a Skill applied when refreshed index includes its directory", () => {
    const { store, read } = memoryStore();
    const capability = skill();
    recordEnterpriseCapabilitySyncStatus(capability, { status: "verifying" }, "pat-test", store);
    finalizeEnterpriseSkillSyncAfterIndexRefresh(
      [capability],
      "pat-test",
      true,
      store,
      undefined,
      new Set(),
    );
    expect(read().enterprise?.capability_sync_statuses?.[0]).toMatchObject({
      status: "failed",
      errorCode: "skill_not_loaded",
    });
  });

  it("persists receipt summary only for the current PAT", () => {
    const { store, read } = memoryStore();
    persistEnterpriseCapabilityReceiptSummary(
      {
        ok: false,
        attemptedAt: "2026-09-02T04:00:00.000Z",
        sentCount: 1,
        failedCount: 1,
        errorCode: "receipt_upload_failed",
        message: "Bearer top-secret-token",
      },
      "pat-test",
      store,
    );
    expect(read().enterprise?.capability_receipt_summary).toEqual({
      attempted_at: "2026-09-02T04:00:00.000Z",
      sent_count: 1,
      failed_count: 1,
      error_code: "receipt_upload_failed",
      message: "Bearer [redacted]",
    });
  });

  it("keeps a failed persisted receipt as retry intent for a later refresh", () => {
    expect(shouldRetryEnterpriseCapabilityReceipt(undefined)).toBe(false);
    expect(shouldRetryEnterpriseCapabilityReceipt({
      attempted_at: "2026-09-02T04:00:00.000Z",
      sent_count: 2,
      failed_count: 0,
    })).toBe(false);
    expect(shouldRetryEnterpriseCapabilityReceipt({
      attempted_at: "2026-09-02T04:01:00.000Z",
      sent_count: 1,
      failed_count: 1,
      error_code: "receipt_upload_failed",
    })).toBe(true);
    expect(shouldRetryEnterpriseCapabilityReceipt({
      attempted_at: "2026-09-02T04:02:00.000Z",
      sent_count: 0,
      failed_count: 0,
      error_code: "unexpected_transport_failure",
    })).toBe(true);
  });
});

describe("managed Skill bundle fetch", () => {
  it("uses redirect:error and rejects a declared oversized response", async () => {
    fetchMock.mockResolvedValue(
      new Response("too large", {
        status: 200,
        headers: { "content-length": "9" },
      }),
    );
    const result = await fetchSkillBundleDetailed(
      "https://portal.example.invalid/skills/a/SKILL.md",
      "a".repeat(64),
      8,
    );
    expect(result).toMatchObject({
      ok: false,
      errorCode: ENTERPRISE_CAPABILITY_SYNC_ERRORS.size_exceeded,
    });
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ redirect: "error" });
  });

  it("bounds a stream without Content-Length and cancels after the limit", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("1234"));
        controller.enqueue(new TextEncoder().encode("5678"));
      },
      cancel() {
        cancelled = true;
      },
    });
    fetchMock.mockResolvedValue(new Response(stream, { status: 200 }));
    const result = await fetchSkillBundleDetailed(
      "https://portal.example.invalid/skills/a/SKILL.md",
      "a".repeat(64),
      5,
    );
    expect(result).toMatchObject({
      ok: false,
      errorCode: ENTERPRISE_CAPABILITY_SYNC_ERRORS.size_exceeded,
    });
    expect(cancelled).toBe(true);
  });

  it("reports digest mismatch after a bounded successful read", async () => {
    fetchMock.mockResolvedValue(new Response("hello", { status: 200 }));
    const result = await fetchSkillBundleDetailed(
      "https://portal.example.invalid/skills/a/SKILL.md",
      "b".repeat(64),
      100,
    );
    expect(result).toMatchObject({
      ok: false,
      errorCode: ENTERPRISE_CAPABILITY_SYNC_ERRORS.digest_mismatch,
    });
  });
});

describe("atomic managed Skill install", () => {
  function temporaryRoot(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenticx-enterprise-sync-"));
    temporaryRoots.push(root);
    return root;
  }

  it("installs a new Skill and leaves no target after a staged write failure", () => {
    const root = temporaryRoot();
    const writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementationOnce(() => {
      throw new Error("injected write failure");
    });
    expect(() => writeManagedSkillDirectory(root, "new-skill", "new content")).toThrow(
      "injected write failure",
    );
    writeSpy.mockRestore();
    expect(fs.existsSync(path.join(root, "new-skill"))).toBe(false);
    expect(fs.readdirSync(root).filter((entry) => entry.includes("staging"))).toEqual([]);
  });

  it("keeps the verified previous version when replacing an existing Skill fails", () => {
    const root = temporaryRoot();
    writeManagedSkillDirectory(root, "existing", "last known good");
    const renameSpy = vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
      throw new Error("injected rename failure");
    });
    expect(() => writeManagedSkillDirectory(root, "existing", "new content")).toThrow(
      "injected rename failure",
    );
    renameSpy.mockRestore();
    expect(fs.readFileSync(path.join(root, "existing", "SKILL.md"), "utf8")).toBe(
      "last known good",
    );
    expect(fs.existsSync(path.join(root, "existing", ".near-managed"))).toBe(true);
  });

  it("does not roll back a verified new version when backup cleanup fails", () => {
    const root = temporaryRoot();
    writeManagedSkillDirectory(root, "existing", "last known good");
    const realRemove = fs.rmSync;
    const removeSpy = vi.spyOn(fs, "rmSync").mockImplementation((target, options) => {
      if (String(target).includes(".backup")) throw new Error("injected cleanup failure");
      return realRemove(target, options);
    });
    writeManagedSkillDirectory(root, "existing", "new verified content");
    removeSpy.mockRestore();
    expect(fs.readFileSync(path.join(root, "existing", "SKILL.md"), "utf8")).toBe(
      "new verified content",
    );
  });

  it("retains the old version in a hidden backup until index confirmation", () => {
    const root = temporaryRoot();
    writeManagedSkillDirectory(root, "existing", "last known good");
    const transaction = stageManagedSkillDirectory(root, "existing", "candidate");
    expect(fs.readFileSync(path.join(root, "existing", "SKILL.md"), "utf8")).toBe("candidate");
    expect(transaction.state).toBe("pending");
    expect(transaction.backupDir).toBeTruthy();
    expect(fs.readFileSync(String(transaction.backupDir) + "/SKILL.md", "utf8")).toBe(
      "last known good",
    );

    transaction.rollback();
    expect(transaction.state).toBe("rolled_back");
    expect(fs.readFileSync(path.join(root, "existing", "SKILL.md"), "utf8")).toBe(
      "last known good",
    );
    expect(transaction.backupDir && fs.existsSync(transaction.backupDir)).toBe(false);
  });

  it("commits only loaded replacements and rolls missing index entries back", () => {
    const root = temporaryRoot();
    writeManagedSkillDirectory(root, "one", "one old");
    writeManagedSkillDirectory(root, "two", "two old");
    const one = stageManagedSkillDirectory(root, "one", "one new");
    const two = stageManagedSkillDirectory(root, "two", "two new");
    const settled = settleManagedSkillDirectoryTransactions(
      new Map([
        ["skill:one", one],
        ["skill:two", two],
      ]),
      true,
      new Set(["skill:one"]),
    );
    expect(settled).toMatchObject({ committed: ["skill:one"], rolledBack: ["skill:two"], errors: [] });
    expect(fs.readFileSync(path.join(root, "one", "SKILL.md"), "utf8")).toBe("one new");
    expect(fs.readFileSync(path.join(root, "two", "SKILL.md"), "utf8")).toBe("two old");
    expect(one.state).toBe("committed");
    expect(two.state).toBe("rolled_back");
  });

  it("removes a new-only Skill when index refresh cannot confirm it", () => {
    const root = temporaryRoot();
    const transaction = stageManagedSkillDirectory(root, "new-only", "candidate");
    const settled = settleManagedSkillDirectoryTransactions(
      new Map([["skill:new-only", transaction]]),
      false,
    );
    expect(settled).toMatchObject({ committed: [], rolledBack: ["skill:new-only"], errors: [] });
    expect(fs.existsSync(path.join(root, "new-only"))).toBe(false);
  });

  it("restores the original LKG before retrying an update interrupted by process exit", () => {
    const root = temporaryRoot();
    writeManagedSkillDirectory(root, "existing", "last known good");

    // Leave the first transaction pending exactly as a killed Desktop process
    // would: candidate in the target and the verified version in the stable
    // backup slot. A new process has no in-memory handle to this transaction.
    stageManagedSkillDirectory(root, "existing", "interrupted candidate");
    const retry = stageManagedSkillDirectory(root, "existing", "retry candidate");
    retry.rollback();

    expect(fs.readFileSync(path.join(root, "existing", "SKILL.md"), "utf8")).toBe(
      "last known good",
    );
  });

  it("does not promote an interrupted first install to the next retry baseline", () => {
    const root = temporaryRoot();
    stageManagedSkillDirectory(root, "new-only", "interrupted candidate");
    const retry = stageManagedSkillDirectory(root, "new-only", "retry candidate");
    retry.rollback();

    expect(fs.existsSync(path.join(root, "new-only"))).toBe(false);
  });

  it("keeps a committed candidate when only old-backup cleanup was interrupted", () => {
    const root = temporaryRoot();
    writeManagedSkillDirectory(root, "existing", "old");
    const realRemove = fs.rmSync;
    const removeSpy = vi.spyOn(fs, "rmSync").mockImplementation((target, options) => {
      if (String(target).includes(".backup")) throw new Error("injected cleanup failure");
      return realRemove(target, options);
    });
    writeManagedSkillDirectory(root, "existing", "committed");
    removeSpy.mockRestore();

    const retry = stageManagedSkillDirectory(root, "existing", "later candidate");
    retry.rollback();
    expect(fs.readFileSync(path.join(root, "existing", "SKILL.md"), "utf8")).toBe(
      "committed",
    );
  });

  it("does not delete a user directory that occupies the target during recovery", () => {
    const root = temporaryRoot();
    writeManagedSkillDirectory(root, "existing", "old");
    const interrupted = stageManagedSkillDirectory(root, "existing", "candidate");
    fs.rmSync(path.join(root, "existing"), { recursive: true, force: true });
    fs.mkdirSync(path.join(root, "existing"));
    fs.writeFileSync(path.join(root, "existing", "SKILL.md"), "user owned");

    expect(() => stageManagedSkillDirectory(root, "existing", "retry")).toThrow(
      "检测到同名用户 Skill 目录",
    );
    expect(fs.readFileSync(path.join(root, "existing", "SKILL.md"), "utf8")).toBe(
      "user owned",
    );
    expect(interrupted.backupDir && fs.existsSync(interrupted.backupDir)).toBe(true);
  });
});

describe("per-capability receipts", () => {
  it("emits the Portal contract one capability at a time with bounded concurrency", async () => {
    const capabilities = Array.from({ length: 10 }, (_, index) => skill({
      id: `skill:${index}`,
      name: `skill-${index}`,
    }));
    const statuses = capabilities.map((capability) => ({
      capabilityId: capability.id,
      kind: capability.kind,
      status: "applied" as const,
      version: capability.version,
    }));
    let active = 0;
    let maximumActive = 0;
    fetchMock.mockImplementation(async (_url, init) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      return new Response("", { status: 200 });
    });
    const result = await postEnterpriseCapabilityReceipts(
      capabilities,
      statuses,
      "pat-test",
      "https://portal.example.invalid/",
    );
    expect(result).toMatchObject({ ok: true, sentCount: 10, failedCount: 0 });
    expect(maximumActive).toBeGreaterThan(1);
    expect(maximumActive).toBeLessThanOrEqual(6);
    expect(fetchMock).toHaveBeenCalledTimes(10);
    for (const [url, init] of fetchMock.mock.calls) {
      expect(url).toBe("https://portal.example.invalid/api/desktop/capabilities/receipts");
      expect(init).toMatchObject({
        method: "POST",
        headers: expect.objectContaining({ authorization: "Bearer pat-test" }),
      });
      const body = JSON.parse(String(init?.body));
      expect(body).toHaveProperty("capabilityId");
      expect(body).not.toHaveProperty("receiptId");
      expect(body).not.toHaveProperty("capabilitySyncStatuses");
    }
  });

  it("isolates one failed upload and serializes successive rounds", async () => {
    const first = skill({ id: "skill:first", name: "first" });
    const second = skill({ id: "skill:second", name: "second" });
    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    fetchMock.mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { capabilityId: string };
      order.push(body.capabilityId);
      if (body.capabilityId === first.id && order.length === 1) {
        await firstStarted;
        throw new Error("Bearer old-secret");
      }
      return new Response("", { status: 200 });
    });
    const firstRound = enqueueEnterpriseCapabilityReceipts(
      [first],
      [{ capabilityId: first.id, kind: "skill", status: "failed" }],
      "pat-test",
      "https://portal.example.invalid",
    );
    const secondRound = enqueueEnterpriseCapabilityReceipts(
      [second],
      [{ capabilityId: second.id, kind: "skill", status: "applied" }],
      "pat-test",
      "https://portal.example.invalid",
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual([first.id]);
    releaseFirst?.();
    await expect(firstRound).resolves.toMatchObject({
      ok: false,
      sentCount: 0,
      failedCount: 1,
    });
    await expect(secondRound).resolves.toMatchObject({
      ok: true,
      sentCount: 1,
      failedCount: 0,
    });
    expect(order).toEqual([first.id, second.id]);
    expect(String((await firstRound).message)).not.toContain("old-secret");
  });

  it("does not start a stale auth-generation receipt queue", async () => {
    const authGeneration = 8;
    const isCurrent = () => authGeneration === 7;
    const result = await enqueueEnterpriseCapabilityReceipts(
      [skill()],
      [{ capabilityId: "skill:one", kind: "skill", status: "applied" }],
      "pat-test",
      "https://portal.example.invalid",
      { isCurrent, queueKey: "tenant-a/user-a/generation-6" },
    );
    // The scope is intentionally stale even before any request is queued.
    expect(result).toMatchObject({
      ok: false,
      skipped: true,
      sentCount: 0,
      failedCount: 0,
      errorCode: ENTERPRISE_CAPABILITY_SYNC_ERRORS.receipt_not_current,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stops sending after a tenant/auth identity changes between batches", async () => {
    let identity = "tenant-a/user-a/generation-1";
    const capabilities = Array.from({ length: 8 }, (_, index) => skill({
      id: `skill:receipt-${index}`,
      name: `receipt-${index}`,
    }));
    let calls = 0;
    fetchMock.mockImplementation(async () => {
      calls += 1;
      if (calls === 6) identity = "tenant-b/user-b/generation-2";
      return new Response("", { status: 200 });
    });
    const result = await enqueueEnterpriseCapabilityReceipts(
      capabilities,
      capabilities.map((capability) => ({
        capabilityId: capability.id,
        kind: capability.kind,
        status: "applied" as const,
      })),
      "pat-test",
      "https://portal.example.invalid",
      {
        queueKey: "tenant-a/user-a/generation-1",
        isCurrent: () => identity === "tenant-a/user-a/generation-1",
      },
    );
    expect(result).toMatchObject({
      ok: false,
      skipped: true,
      sentCount: 6,
      failedCount: 0,
      errorCode: ENTERPRISE_CAPABILITY_SYNC_ERRORS.receipt_not_current,
    });
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });
});
