import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CONFIG_MARKET_RELEASE_HEADER,
  ConfigMarketReceiptError,
  configMarketDownloadReceiptFromPayload,
  downloadConfigMarketArtifact,
} from "../ConfigMarketDownloadButton";

const id = "01JQMZ8K3N4P5Q6R7S8T9VWXYZ";
const releaseId = "01JQMZ8K3N4P5Q6R7S8T9VWX01";

describe("config market browser download", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function installBrowserDownloadSpies(clicks: Array<{ href: string; download: string }>) {
    vi.stubGlobal("document", {
      createElement: () => {
        const anchor = {
          href: "",
          download: "",
          rel: "",
          click: () => clicks.push({ href: anchor.href, download: anchor.download }),
        };
        return anchor;
      },
    });
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn(() => "blob:config-market"),
      revokeObjectURL: vi.fn(),
    });
  }

  it("accepts only the documented receipt shape", () => {
    expect(configMarketDownloadReceiptFromPayload({
      data: { downloadCount: 4, counted: true },
    })).toEqual({ downloadCount: 4, counted: true });
    expect(configMarketDownloadReceiptFromPayload({
      data: { downloadCount: -1, counted: true },
    })).toBeNull();
    expect(configMarketDownloadReceiptFromPayload({
      data: { downloadCount: 4, counted: "true" },
    })).toBeNull();
  });

  it("waits for the complete blob, triggers the file, then receipts the GET release id", async () => {
    const clicks: Array<{ href: string; download: string }> = [];
    installBrowserDownloadSpies(clicks);
    const events: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        events.push(`post:${JSON.parse(String(init.body)).releaseId}`);
        return new Response(JSON.stringify({ data: { downloadCount: 14, counted: true } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      events.push(`get:${String(input)}`);
      const response = new Response(new Blob(["{}"], { type: "application/json" }), {
        status: 200,
        headers: {
          [CONFIG_MARKET_RELEASE_HEADER]: releaseId,
          "content-disposition": "attachment; filename=agenticx-config.json",
        },
      });
      vi.spyOn(response, "blob").mockImplementation(async () => {
        events.push("blob-complete");
        return new Blob(["{}"], { type: "application/json" });
      });
      return response;
    });

    const result = await downloadConfigMarketArtifact(id, { fetchImpl });

    expect(result).toEqual({ downloadCount: 14, counted: true });
    expect(events).toEqual([
      `get:/api/config-market/${id}/download`,
      "blob-complete",
      `post:${releaseId}`,
    ]);
    expect(clicks).toEqual([{ href: "blob:config-market", download: "agenticx-config.json" }]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not use a stale page release id when the GET omits the release header", async () => {
    const clicks: Array<{ href: string; download: string }> = [];
    installBrowserDownloadSpies(clicks);
    const fetchImpl = vi.fn(async () => new Response(new Blob(["{}"]), { status: 200 }));

    await expect(downloadConfigMarketArtifact(id, { fetchImpl })).rejects.toMatchObject({
      name: "ConfigMarketReceiptError",
      releaseId: null,
      artifactDownloaded: true,
    } satisfies Partial<ConfigMarketReceiptError>);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(clicks).toHaveLength(1);
  });

  it("keeps the completed download when receipt recording fails and exposes its release id", async () => {
    const clicks: Array<{ href: string; download: string }> = [];
    installBrowserDownloadSpies(clicks);
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") return new Response("nope", { status: 503 });
      return new Response(new Blob(["{}"]), {
        status: 200,
        headers: { [CONFIG_MARKET_RELEASE_HEADER]: releaseId },
      });
    });

    await expect(downloadConfigMarketArtifact(id, { fetchImpl })).rejects.toMatchObject({
      name: "ConfigMarketReceiptError",
      releaseId,
      artifactDownloaded: true,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(clicks).toHaveLength(1);
  });

  it("applies the GET timeout while consuming a body that never completes", async () => {
    vi.useFakeTimers();
    const clicks: Array<{ href: string; download: string }> = [];
    installBrowserDownloadSpies(clicks);
    const fetchImpl = vi.fn(() => Promise.resolve({
      ok: true,
      headers: new Headers({ [CONFIG_MARKET_RELEASE_HEADER]: releaseId }),
      blob: () => new Promise<Blob>(() => undefined),
    } as unknown as Response));

    const pending = downloadConfigMarketArtifact(id, { fetchImpl });
    const rejection = expect(pending).rejects.toMatchObject({ name: "ConfigMarketDownloadError" });
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(30_000);

    await rejection;
    expect(clicks).toHaveLength(0);
  });

  it("applies the receipt timeout while consuming a JSON body that never completes", async () => {
    vi.useFakeTimers();
    const clicks: Array<{ href: string; download: string }> = [];
    installBrowserDownloadSpies(clicks);
    const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        return Promise.resolve({
          ok: true,
          json: () => new Promise<unknown>(() => undefined),
        } as unknown as Response);
      }
      return Promise.resolve({
        ok: true,
        headers: new Headers({ [CONFIG_MARKET_RELEASE_HEADER]: releaseId }),
        blob: () => Promise.resolve(new Blob(["{}"])),
      } as unknown as Response);
    });

    const pending = downloadConfigMarketArtifact(id, { fetchImpl });
    const rejection = expect(pending).rejects.toMatchObject({
      name: "ConfigMarketReceiptError",
      releaseId,
      artifactDownloaded: true,
    });
    for (let index = 0; index < 4; index += 1) await Promise.resolve();
    await vi.advanceTimersByTimeAsync(5_000);

    await rejection;
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(clicks).toHaveLength(1);
  });
});
