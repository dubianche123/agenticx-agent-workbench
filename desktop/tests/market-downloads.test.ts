import { describe, expect, it, vi } from "vitest";

import {
  PortableMarketDownloadConfirmationStore,
  reportPortableMarketDownloadWithRetry,
} from "../electron/market-downloads";

const TOKEN = "A".repeat(32);
const RAW_DIGEST = "a".repeat(64);

describe("portable market download telemetry guards", () => {
  it("binds an inspect token to the exact market release and identity", () => {
    const store = new PortableMarketDownloadConfirmationStore({ now: () => 1_000 });
    expect(store.bind(TOKEN, {
      marketId: "01JABCDEF0123456789ABCDEFG",
      releaseId: "01JABCDEF0123456789ABCDEFX",
      enterpriseIdentity: "stable:tenant/user",
      rawDigest: RAW_DIGEST,
    })).toBe(true);

    expect(store.takeForImport({
      confirmationToken: TOKEN,
      enterpriseIdentity: "stable:other/user",
      rawDigest: RAW_DIGEST,
    })).toBeNull();
    expect(store.size).toBe(0);
  });

  it("allows one matching successful import and rejects replay or changed content", () => {
    const store = new PortableMarketDownloadConfirmationStore({ now: () => 1_000 });
    expect(store.bind(TOKEN, {
      marketId: "market-1",
      releaseId: "release-1",
      enterpriseIdentity: "identity-1",
      rawDigest: RAW_DIGEST,
    })).toBe(true);

    expect(store.takeForImport({
      confirmationToken: TOKEN,
      enterpriseIdentity: "identity-1",
      rawDigest: "b".repeat(64),
    })).toBeNull();
    expect(store.size).toBe(0);

    expect(store.bind(TOKEN, {
      marketId: "market-1",
      releaseId: "release-1",
      enterpriseIdentity: "identity-1",
      rawDigest: RAW_DIGEST,
    })).toBe(true);
    expect(store.takeForImport({
      confirmationToken: TOKEN,
      enterpriseIdentity: "identity-1",
      rawDigest: RAW_DIGEST,
    })).toMatchObject({ marketId: "market-1", releaseId: "release-1" });
    expect(store.takeForImport({
      confirmationToken: TOKEN,
      enterpriseIdentity: "identity-1",
      rawDigest: RAW_DIGEST,
    })).toBeNull();
  });

  it("expires and bounds pending inspect hand-offs", () => {
    let now = 1_000;
    const store = new PortableMarketDownloadConfirmationStore({
      ttlMs: 100,
      maxEntries: 2,
      now: () => now,
    });
    const binding = (id: string) => ({
      marketId: id,
      releaseId: `${id}-release`,
      enterpriseIdentity: "identity-1",
    });
    expect(store.bind("A".repeat(32), binding("one"))).toBe(true);
    expect(store.bind("B".repeat(32), binding("two"))).toBe(true);
    expect(store.bind("C".repeat(32), binding("three"))).toBe(true);
    expect(store.size).toBe(2);
    expect(store.takeForImport({
      confirmationToken: "A".repeat(32),
      enterpriseIdentity: "identity-1",
    })).toBeNull();
    now = 1_101;
    expect(store.size).toBe(0);
  });

  it("retries transient reporting failures but stops on permanent failures", async () => {
    const transientThenSuccess = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: "网络暂时不可用", retryable: true })
      .mockResolvedValueOnce({ ok: true });
    await expect(reportPortableMarketDownloadWithRetry(
      transientThenSuccess,
      { marketId: "market-1", releaseId: "release-1" },
    )).resolves.toMatchObject({ ok: true, attempts: 2 });
    expect(transientThenSuccess).toHaveBeenCalledTimes(2);

    const permanent = vi.fn().mockResolvedValue({
      ok: false,
      error: "无权限",
      retryable: false,
    });
    await expect(reportPortableMarketDownloadWithRetry(
      permanent,
      { marketId: "market-1", releaseId: "release-1" },
    )).resolves.toMatchObject({ ok: false, attempts: 1 });
    expect(permanent).toHaveBeenCalledTimes(1);
  });
});
