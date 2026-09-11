/**
 * Strict transport and read-back checks for enterprise-managed MCP config.
 *
 * This module deliberately does not know about Electron globals, config stores,
 * or capability ledgers.  The main process supplies the request function and
 * can therefore keep the helper unit-testable without importing `main.ts`.
 * Every failure is represented by a stable code; response bodies and thrown
 * transport errors are never returned to callers.
 */

import type { McpDocument } from "./enterprise-capabilities";

export const ENTERPRISE_MCP_SYNC_ERROR_CODES = {
  invalid_request: "mcp_sync_invalid_request",
  invalid_endpoint: "mcp_sync_invalid_endpoint",
  read_transport: "mcp_sync_read_transport",
  read_http: "mcp_sync_read_http",
  read_response: "mcp_sync_read_response",
  read_text: "mcp_sync_read_text",
  read_document: "mcp_sync_read_document",
  write_transport: "mcp_sync_write_transport",
  write_http: "mcp_sync_write_http",
  write_ack: "mcp_sync_write_ack",
  readback_missing: "mcp_sync_readback_missing",
  readback_transport: "mcp_sync_readback_transport",
  readback_http: "mcp_sync_readback_http",
  readback_response: "mcp_sync_readback_response",
  readback_text: "mcp_sync_readback_text",
  readback_document: "mcp_sync_readback_document",
  readback_mismatch: "mcp_sync_readback_mismatch",
} as const;

export type EnterpriseMcpSyncErrorCode =
  (typeof ENTERPRISE_MCP_SYNC_ERROR_CODES)[keyof typeof ENTERPRISE_MCP_SYNC_ERROR_CODES];

export type EnterpriseMcpFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export type EnterpriseMcpApiOptions = {
  /** Full `/api/mcp/raw` endpoint, without the `path` query parameter. */
  endpoint: string;
  /** MCP config path sent to the local Studio API. */
  path: string;
  /** Desktop/Studio authentication headers. */
  headers?: HeadersInit;
  /** Injected transport; defaults to the process global fetch. */
  fetcher?: EnterpriseMcpFetch;
  /** Optional caller-owned timeout signal. */
  signal?: AbortSignal;
};

export type EnterpriseMcpReadResult =
  | { ok: true; document: McpDocument; empty: boolean }
  | { ok: false; errorCode: EnterpriseMcpSyncErrorCode };

export type EnterpriseMcpWriteResult =
  | { ok: true }
  | { ok: false; errorCode: EnterpriseMcpSyncErrorCode };

export type EnterpriseMcpReadBackExpectation = {
  /** Names and exact JSON values that the managed sync asked to retain/write. */
  desiredManagedEntries: Readonly<Record<string, unknown>>;
  /** Names that the managed sync explicitly asked the API to remove. */
  requestedDeletions?: readonly string[];
};

export type EnterpriseMcpReadBackResult =
  | { ok: true; document: McpDocument }
  | { ok: false; errorCode: EnterpriseMcpSyncErrorCode };

export type EnterpriseMcpWriteAndConfirmOptions = EnterpriseMcpApiOptions & {
  /** Complete document sent to PUT. Unmanaged entries are preserved by caller. */
  document: McpDocument;
} & EnterpriseMcpReadBackExpectation;

const EMPTY_DOCUMENT: McpDocument = {};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isValidDocument(value: unknown): value is McpDocument {
  if (!isRecord(value)) return false;
  if (value.mcpServers !== undefined && !isRecord(value.mcpServers)) return false;
  return true;
}

function getFetcher(fetcher?: EnterpriseMcpFetch): EnterpriseMcpFetch {
  // Keep the default lazy so importing this module in a unit test does not
  // access a missing global fetch until the test actually invokes a request.
  return fetcher ?? ((input, init) => globalThis.fetch(input, init));
}

function makeHeaders(headers?: HeadersInit, contentType = false): Headers {
  const merged = new Headers(headers);
  if (!merged.has("accept")) merged.set("accept", "application/json");
  if (contentType && !merged.has("content-type")) {
    merged.set("content-type", "application/json");
  }
  return merged;
}

function requestSignal(options: EnterpriseMcpApiOptions): AbortSignal | undefined {
  return options.signal;
}

function validatedEndpoint(value: unknown): URL | null {
  const endpoint = String(value ?? "").trim();
  if (!endpoint) return null;
  try {
    const url = new URL(endpoint);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url;
  } catch {
    return null;
  }
}

function readUrl(options: EnterpriseMcpApiOptions): string | null {
  const url = validatedEndpoint(options.endpoint);
  const path = String(options.path ?? "").trim();
  if (!url || !path) return null;
  url.searchParams.set("path", path);
  return url.toString();
}

async function parseJsonBody(response: Response): Promise<unknown | null> {
  try {
    return await response.json() as unknown;
  } catch {
    return null;
  }
}

async function discardResponseBody(response: Response): Promise<void> {
  if (!response.body) return;
  try {
    await response.body.cancel();
  } catch {
    // The response is already being discarded; cancellation failure must not
    // replace the stable protocol error we are about to return.
  }
}

/**
 * Read the raw MCP document.
 *
 * A missing file is the only empty-state response: HTTP 404 maps to `{}`. A
 * successful HTTP 200 must contain a string `text` field containing a JSON
 * object; malformed/missing fields are failures and never silently become an
 * empty document.
 */
export async function readEnterpriseMcpDocument(
  options: EnterpriseMcpApiOptions,
): Promise<EnterpriseMcpReadResult> {
  if (!String(options.path ?? "").trim()) {
    return { ok: false, errorCode: ENTERPRISE_MCP_SYNC_ERROR_CODES.invalid_request };
  }
  if (!validatedEndpoint(options.endpoint)) {
    return { ok: false, errorCode: ENTERPRISE_MCP_SYNC_ERROR_CODES.invalid_endpoint };
  }
  const url = readUrl(options);
  if (!url) {
    return { ok: false, errorCode: ENTERPRISE_MCP_SYNC_ERROR_CODES.invalid_request };
  }

  let response: Response;
  try {
    response = await getFetcher(options.fetcher)(url, {
      method: "GET",
      headers: makeHeaders(options.headers),
      signal: requestSignal(options),
    });
  } catch {
    return { ok: false, errorCode: ENTERPRISE_MCP_SYNC_ERROR_CODES.read_transport };
  }

  if (response.status === 404) {
    await discardResponseBody(response);
    return { ok: true, document: { ...EMPTY_DOCUMENT }, empty: true };
  }
  // Do not use `response.ok` here: 201/204 are not valid read responses, even
  // though a generic HTTP client may classify them as successful.
  if (response.status !== 200) {
    await discardResponseBody(response);
    return { ok: false, errorCode: ENTERPRISE_MCP_SYNC_ERROR_CODES.read_http };
  }

  const payload = await parseJsonBody(response);
  if (!isRecord(payload)) {
    return { ok: false, errorCode: ENTERPRISE_MCP_SYNC_ERROR_CODES.read_response };
  }
  if (typeof payload.text !== "string") {
    return { ok: false, errorCode: ENTERPRISE_MCP_SYNC_ERROR_CODES.read_text };
  }

  let document: unknown;
  try {
    document = JSON.parse(payload.text) as unknown;
  } catch {
    return { ok: false, errorCode: ENTERPRISE_MCP_SYNC_ERROR_CODES.read_document };
  }
  if (!isValidDocument(document)) {
    return { ok: false, errorCode: ENTERPRISE_MCP_SYNC_ERROR_CODES.read_document };
  }
  return { ok: true, document, empty: false };
}

/**
 * PUT one complete MCP document and require an explicit JSON `{ ok: true }`
 * acknowledgement. HTTP success alone is intentionally insufficient.
 */
export async function writeEnterpriseMcpDocument(
  options: EnterpriseMcpApiOptions & { document: McpDocument },
): Promise<EnterpriseMcpWriteResult> {
  const path = String(options.path ?? "").trim();
  if (!path || !isValidDocument(options.document)) {
    return { ok: false, errorCode: ENTERPRISE_MCP_SYNC_ERROR_CODES.invalid_request };
  }
  const url = validatedEndpoint(options.endpoint);
  if (!url) {
    return { ok: false, errorCode: ENTERPRISE_MCP_SYNC_ERROR_CODES.invalid_endpoint };
  }

  let response: Response;
  try {
    response = await getFetcher(options.fetcher)(url.toString(), {
      method: "PUT",
      headers: makeHeaders(options.headers, true),
      body: JSON.stringify({
        path,
        text: `${JSON.stringify(options.document, null, 2)}\n`,
      }),
      signal: requestSignal(options),
    });
  } catch {
    return { ok: false, errorCode: ENTERPRISE_MCP_SYNC_ERROR_CODES.write_transport };
  }

  if (response.ok !== true) {
    await discardResponseBody(response);
    return { ok: false, errorCode: ENTERPRISE_MCP_SYNC_ERROR_CODES.write_http };
  }
  const payload = await parseJsonBody(response);
  if (!isRecord(payload) || payload.ok !== true) {
    return { ok: false, errorCode: ENTERPRISE_MCP_SYNC_ERROR_CODES.write_ack };
  }
  return { ok: true };
}

function deepEqualJson(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => deepEqualJson(value, right[index]));
  }
  if (isRecord(left) || isRecord(right)) {
    if (!isRecord(left) || !isRecord(right)) return false;
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every((key, index) =>
      key === rightKeys[index] && deepEqualJson(left[key], right[key]));
  }
  return false;
}

function managedServers(document: McpDocument): Record<string, unknown> | null {
  if (document.mcpServers === undefined) return {};
  return isRecord(document.mcpServers) ? document.mcpServers : null;
}

function isValidExpectation(expectation: EnterpriseMcpReadBackExpectation): boolean {
  if (!expectation || !isRecord(expectation.desiredManagedEntries)) return false;
  const deletions = expectation.requestedDeletions ?? [];
  if (!Array.isArray(deletions)) return false;
  return deletions.every((name) => typeof name === "string" && name.length > 0);
}

/**
 * Verify only the managed portion of a read-back document. Unmanaged local MCP
 * entries are deliberately ignored, while managed values are compared
 * recursively and deletion requests must be absent by exact key.
 */
export function confirmEnterpriseMcpReadBack(
  document: McpDocument,
  expectation: EnterpriseMcpReadBackExpectation,
): EnterpriseMcpReadBackResult {
  if (!isValidDocument(document)) {
    return { ok: false, errorCode: ENTERPRISE_MCP_SYNC_ERROR_CODES.readback_document };
  }
  const servers = managedServers(document);
  if (!servers) {
    return { ok: false, errorCode: ENTERPRISE_MCP_SYNC_ERROR_CODES.readback_document };
  }

  const desiredEntries = expectation.desiredManagedEntries;
  if (!isRecord(desiredEntries)) {
    return { ok: false, errorCode: ENTERPRISE_MCP_SYNC_ERROR_CODES.invalid_request };
  }
  const deletions = expectation.requestedDeletions ?? [];
  const deletionSet = new Set<string>();
  for (const name of deletions) {
    if (typeof name !== "string" || !name) {
      return { ok: false, errorCode: ENTERPRISE_MCP_SYNC_ERROR_CODES.invalid_request };
    }
    deletionSet.add(name);
  }

  for (const [name, expected] of Object.entries(desiredEntries)) {
    if (deletionSet.has(name) || !hasOwn(servers, name) || !deepEqualJson(servers[name], expected)) {
      return { ok: false, errorCode: ENTERPRISE_MCP_SYNC_ERROR_CODES.readback_mismatch };
    }
  }
  for (const name of deletionSet) {
    if (hasOwn(servers, name)) {
      return { ok: false, errorCode: ENTERPRISE_MCP_SYNC_ERROR_CODES.readback_mismatch };
    }
  }
  return { ok: true, document };
}

/**
 * PUT, require an explicit acknowledgement, then GET and verify the exact
 * managed desired state. A 404 on this read-back is not confirmation that a
 * successful write happened, even though a first read may treat 404 as empty.
 */
export async function writeEnterpriseMcpDocumentAndConfirm(
  options: EnterpriseMcpWriteAndConfirmOptions,
): Promise<EnterpriseMcpReadBackResult> {
  if (!isValidExpectation(options)) {
    return { ok: false, errorCode: ENTERPRISE_MCP_SYNC_ERROR_CODES.invalid_request };
  }
  const write = await writeEnterpriseMcpDocument(options);
  if (!write.ok) return write;

  const read = await readEnterpriseMcpDocument(options);
  if (!read.ok) {
    const code = read.errorCode;
    if (code === ENTERPRISE_MCP_SYNC_ERROR_CODES.read_transport) {
      return { ok: false, errorCode: ENTERPRISE_MCP_SYNC_ERROR_CODES.readback_transport };
    }
    if (code === ENTERPRISE_MCP_SYNC_ERROR_CODES.read_http) {
      return { ok: false, errorCode: ENTERPRISE_MCP_SYNC_ERROR_CODES.readback_http };
    }
    if (code === ENTERPRISE_MCP_SYNC_ERROR_CODES.read_response) {
      return { ok: false, errorCode: ENTERPRISE_MCP_SYNC_ERROR_CODES.readback_response };
    }
    if (code === ENTERPRISE_MCP_SYNC_ERROR_CODES.read_text) {
      return { ok: false, errorCode: ENTERPRISE_MCP_SYNC_ERROR_CODES.readback_text };
    }
    if (code === ENTERPRISE_MCP_SYNC_ERROR_CODES.read_document) {
      return { ok: false, errorCode: ENTERPRISE_MCP_SYNC_ERROR_CODES.readback_document };
    }
    return { ok: false, errorCode: ENTERPRISE_MCP_SYNC_ERROR_CODES.readback_response };
  }
  if (read.empty) {
    return { ok: false, errorCode: ENTERPRISE_MCP_SYNC_ERROR_CODES.readback_missing };
  }
  return confirmEnterpriseMcpReadBack(read.document, options);
}

// Short aliases keep the helper easy to discover for callers that use
// "managed" terminology. The explicit Enterprise names above remain the
// canonical API for main-process wiring.
export const readManagedMcpDocument = readEnterpriseMcpDocument;
export const writeManagedMcpDocument = writeEnterpriseMcpDocument;
export const writeManagedMcpDocumentWithReadBack = writeEnterpriseMcpDocumentAndConfirm;
