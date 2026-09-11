"use client";

import { Download } from "lucide-react";
import { useCallback, useState } from "react";

export const CONFIG_MARKET_RELEASE_HEADER = "X-Config-Market-Release-Id";
const DEFAULT_DOWNLOAD_FILENAME = "agenticx-config.json";
const MAX_RECEIPT_RETRIES = 2;
const DOWNLOAD_REQUEST_TIMEOUT_MS = 30_000;
const RECEIPT_REQUEST_TIMEOUT_MS = 5_000;

type FetchLike = typeof fetch;

export type ConfigMarketDownloadReceipt = {
  downloadCount: number;
  counted: boolean;
};

export class ConfigMarketDownloadError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ConfigMarketDownloadError";
  }
}

/** The file was already handed to the browser, but the server receipt was not confirmed. */
export class ConfigMarketReceiptError extends Error {
  public readonly releaseId: string | null;
  public readonly artifactDownloaded = true;

  public constructor(message: string, releaseId: string | null) {
    super(message);
    this.name = "ConfigMarketReceiptError";
    this.releaseId = releaseId;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Parse only the documented receipt shape; an arbitrary response must not change the UI count. */
export function configMarketDownloadReceiptFromPayload(
  payload: unknown,
): ConfigMarketDownloadReceipt | null {
  const root = asRecord(payload);
  const data = asRecord(root?.data);
  if (
    !data ||
    !Number.isSafeInteger(data.downloadCount) ||
    (data.downloadCount as number) < 0 ||
    typeof data.counted !== "boolean"
  ) {
    return null;
  }
  return {
    downloadCount: data.downloadCount as number,
    counted: data.counted as boolean,
  };
}

function filenameFromContentDisposition(value: string | null): string {
  if (!value) return DEFAULT_DOWNLOAD_FILENAME;
  const extended = value.match(/filename\*\s*=\s*UTF-8''([^;]+)/iu)?.[1];
  if (extended) {
    try {
      const decoded = decodeURIComponent(extended.trim());
      if (decoded) return decoded;
    } catch {
      // Fall through to the quoted filename or the safe fallback.
    }
  }
  const quoted = value.match(/filename\s*=\s*"([^"]+)"/iu)?.[1];
  return quoted || DEFAULT_DOWNLOAD_FILENAME;
}

/** Trigger the native browser download only after the response blob has completed. */
export function triggerConfigMarketBrowserDownload(
  blob: Blob,
  filename: string,
): void {
  if (typeof URL.createObjectURL !== "function") {
    throw new ConfigMarketDownloadError("当前浏览器不支持文件下载，请重试");
  }
  const objectUrl = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = filename || DEFAULT_DOWNLOAD_FILENAME;
    anchor.rel = "noopener";
    anchor.click();
  } finally {
    // Keep the URL alive through the click event; release it on the next task.
    if (typeof URL.revokeObjectURL === "function") {
      globalThis.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
    }
  }
}

function marketDownloadUrl(id: string): string {
  return `/api/config-market/${encodeURIComponent(id)}/download`;
}

function marketDownloadsReceiptUrl(id: string): string {
  return `/api/config-market/${encodeURIComponent(id)}/downloads`;
}

async function fetchWithTimeout<T>(
  fetchImpl: FetchLike,
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number,
  consume: (response: Response) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof globalThis.setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = globalThis.setTimeout(() => {
      controller.abort();
      reject(new Error("request timed out"));
    }, timeoutMs);
  });
  try {
    const response = await Promise.race([
      fetchImpl(input, { ...init, signal: controller.signal }),
      timeout,
    ]);
    return await Promise.race([consume(response), timeout]);
  } finally {
    if (timeoutId !== undefined) globalThis.clearTimeout(timeoutId);
  }
}

/** Record a completed browser download using the release id from the download response. */
export async function recordConfigMarketDownload(
  id: string,
  releaseId: string,
  fetchImpl: FetchLike = fetch,
): Promise<ConfigMarketDownloadReceipt> {
  try {
    const { response, payload } = await fetchWithTimeout(
      fetchImpl,
      marketDownloadsReceiptUrl(id),
      {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ releaseId }),
      },
      RECEIPT_REQUEST_TIMEOUT_MS,
      async (nextResponse) => ({
        response: nextResponse,
        payload: (await nextResponse.json().catch(() => null)) as unknown,
      }),
    );
    const receipt = configMarketDownloadReceiptFromPayload(payload);
    if (!response.ok || !receipt) {
      throw new ConfigMarketReceiptError("下载次数统计未确认，请稍后重试", releaseId);
    }
    return receipt;
  } catch (error) {
    if (error instanceof ConfigMarketReceiptError) throw error;
    throw new ConfigMarketReceiptError("下载次数统计未确认，请稍后重试", releaseId);
  }
}

/**
 * Download the complete artifact first, then record the exact release returned by that GET.
 * The page's releaseId is intentionally not accepted as a receipt fallback: a new release can
 * be published between server rendering and the user's click.
 */
export async function downloadConfigMarketArtifact(
  id: string,
  options: { fetchImpl?: FetchLike; downloadUrl?: string } = {},
): Promise<ConfigMarketDownloadReceipt> {
  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  let blob: Blob | null;
  try {
    ({ response, blob } = await fetchWithTimeout(
      fetchImpl,
      options.downloadUrl ?? marketDownloadUrl(id),
      {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
      },
      DOWNLOAD_REQUEST_TIMEOUT_MS,
      async (nextResponse) => ({
        response: nextResponse,
        blob: nextResponse.ok ? await nextResponse.blob() : null,
      }),
    ));
  } catch {
    throw new ConfigMarketDownloadError("配置下载失败，请重试");
  }
  if (!response.ok) {
    throw new ConfigMarketDownloadError("配置下载失败，请重试");
  }
  if (!blob) throw new ConfigMarketDownloadError("配置下载未完成，请重试");

  const releaseId = response.headers.get(CONFIG_MARKET_RELEASE_HEADER)?.trim() || null;
  try {
    triggerConfigMarketBrowserDownload(
      blob,
      filenameFromContentDisposition(response.headers.get("Content-Disposition")),
    );
  } catch (error) {
    if (error instanceof ConfigMarketDownloadError) throw error;
    throw new ConfigMarketDownloadError("当前浏览器不支持文件下载，请重试");
  }

  if (!releaseId) {
    throw new ConfigMarketReceiptError(
      "配置已下载，但未能确认版本；请重试以完成下载统计",
      null,
    );
  }
  return recordConfigMarketDownload(id, releaseId, fetchImpl);
}

export type ConfigMarketDownloadButtonProps = {
  id: string;
  initialDownloadCount: number;
  downloadUrl?: string;
};

type PendingReceipt = { releaseId: string; attempts: number };
type DownloadState = "idle" | "downloading" | "recording" | "success" | "download-error" | "receipt-error";

function initialCount(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

export function ConfigMarketDownloadButton({
  id,
  initialDownloadCount,
  downloadUrl,
}: ConfigMarketDownloadButtonProps) {
  const [downloadCount, setDownloadCount] = useState(() => initialCount(initialDownloadCount));
  const [state, setState] = useState<DownloadState>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [pendingReceipt, setPendingReceipt] = useState<PendingReceipt | null>(null);
  const busy = state === "downloading" || state === "recording";

  const applyReceipt = useCallback((receipt: ConfigMarketDownloadReceipt) => {
    setDownloadCount(receipt.downloadCount);
    setPendingReceipt(null);
    setState("success");
    setMessage(receipt.counted ? "下载完成" : "下载完成（本账号该版本已统计）");
  }, []);

  const download = useCallback(async () => {
    if (busy) return;
    setState("downloading");
    setMessage(null);
    setPendingReceipt(null);
    try {
      const receipt = await downloadConfigMarketArtifact(id, { downloadUrl });
      applyReceipt(receipt);
    } catch (error) {
      if (error instanceof ConfigMarketReceiptError) {
        if (error.releaseId) setPendingReceipt({ releaseId: error.releaseId, attempts: 0 });
        setState("receipt-error");
        setMessage(error.message);
      } else {
        setState("download-error");
        setMessage(error instanceof Error ? error.message : "配置下载失败，请重试");
      }
    }
  }, [applyReceipt, busy, downloadUrl, id]);

  const retryReceipt = useCallback(async () => {
    if (!pendingReceipt || busy) return;
    const attempts = pendingReceipt.attempts + 1;
    setState("recording");
    setMessage(null);
    try {
      const receipt = await recordConfigMarketDownload(id, pendingReceipt.releaseId);
      applyReceipt(receipt);
    } catch (error) {
      setPendingReceipt({ ...pendingReceipt, attempts });
      setState("receipt-error");
      setMessage(
        attempts >= MAX_RECEIPT_RETRIES
          ? "下载已完成，但统计确认仍失败；请稍后重新下载"
          : error instanceof Error ? error.message : "下载次数统计未确认，请稍后重试",
      );
    }
  }, [applyReceipt, busy, id, pendingReceipt]);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => void download()}
          disabled={busy}
          aria-busy={busy}
          className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground shadow-sm transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto"
        >
          <Download className="h-4 w-4" aria-hidden="true" />
          {state === "downloading" ? "准备下载…" : state === "recording" ? "确认统计…" : "下载配置快照"}
        </button>
        <span className="text-sm text-muted-foreground" aria-label="下载量" title="同一账号同一版本只计一次，跨版本累计；不含能力包自动下发。">
          {downloadCount} 次下载
        </span>
      </div>
      {message ? (
        <p
          role="status"
          aria-live="polite"
          className={state === "success" ? "text-xs text-muted-foreground" : "text-xs text-amber-700 dark:text-amber-400"}
        >
          {message}
          {pendingReceipt && pendingReceipt.attempts < MAX_RECEIPT_RETRIES ? (
            <button
              type="button"
              className="ml-2 underline underline-offset-2"
              onClick={() => void retryReceipt()}
              disabled={busy}
            >
              重试记录
            </button>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}

export default ConfigMarketDownloadButton;
