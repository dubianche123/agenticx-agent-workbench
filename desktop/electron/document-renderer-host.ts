import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type DocumentRendererRequest = {
  format: "md" | "html" | "doc";
  title: string;
  markdown: string;
};

export type DocumentRendererResponse = {
  filename: string;
  mimeType: string;
  content: string;
};

export type DocumentRendererIdentity = {
  scope_id: string;
  user_id: string;
  tenant_id: string;
};

export type ResolveDocumentRendererIdentity = () =>
  | DocumentRendererIdentity
  | null
  | Promise<DocumentRendererIdentity | null>;

export type DocumentRendererHost = {
  url: string;
  token: string;
  close: () => Promise<void>;
};

const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
// A rejected request is drained without retaining its body so ordinary clients
// can still receive the 413 response. Cap the discard window for a peer that
// advertises or streams an effectively unbounded body.
const MAX_OVERSIZE_DRAIN_BYTES = MAX_REQUEST_BYTES * 4;
const OVERSIZE_DRAIN_TIMEOUT_MS = 1_000;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 20_000;

type RendererModule = {
  renderDocument: (input: DocumentRendererRequest) => DocumentRendererResponse;
};

function runtimeCandidates(): string[] {
  const bundled = typeof process.resourcesPath === "string" && process.resourcesPath
    ? path.join(process.resourcesPath, "document-renderer-runtime.cjs")
    : "";
  return [
    bundled,
    path.join(__dirname, "document-renderer-runtime.cjs"),
    path.join(__dirname, "..", "dist-electron", "document-renderer-runtime.cjs"),
    path.join(__dirname, "..", "document-renderer-runtime.cjs"),
  ].filter(Boolean);
}

function loadRendererModule(): RendererModule {
  for (const candidate of runtimeCandidates()) {
    if (!fs.existsSync(candidate)) continue;
    try {
      const loaded = require(candidate) as Partial<RendererModule>;
      if (typeof loaded.renderDocument === "function") return loaded as RendererModule;
    } catch (error) {
      throw new Error(`document renderer bundle failed to load: ${String(error)}`);
    }
  }
  throw new Error(
    "document renderer bundle is missing; run `npm run build:document-renderer` before starting Desktop",
  );
}

function writeJson(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(body);
}

function hasValidToken(req: http.IncomingMessage, token: string): boolean {
  const header = String(req.headers["x-agx-document-renderer-token"] ?? "").trim();
  const authorization = String(req.headers.authorization ?? "").trim();
  const bearer = authorization.replace(/^Bearer\s+/i, "").trim();
  // Compare fixed-size buffers so a token never becomes an accidental prefix check.
  const expected = Buffer.from(token, "utf8");
  for (const candidate of [header, bearer]) {
    const actual = Buffer.from(candidate, "utf8");
    if (actual.length === expected.length && crypto.timingSafeEqual(actual, expected)) return true;
  }
  return false;
}

type RequestBodyRead = {
  raw: Buffer;
  oversized: boolean;
  drained: boolean;
};

/** Read a bounded body, draining a rejected body without buffering it. */
function readRequestBody(req: http.IncomingMessage): Promise<RequestBodyRead> {
  const declared = Number(req.headers["content-length"] ?? 0);
  const declaredOversized = Number.isFinite(declared) && declared > MAX_REQUEST_BYTES;
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let drainBytes = 0;
    let oversized = declaredOversized;
    let drained = !declaredOversized;
    let settled = false;
    let drainTimer: NodeJS.Timeout | null = null;

    const cleanup = () => {
      if (drainTimer) clearTimeout(drainTimer);
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("aborted", onAborted);
      req.off("error", onError);
    };
    const finish = (complete: boolean) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ raw: Buffer.concat(chunks), oversized, drained: complete });
    };
    const stopAfterBoundedDrain = () => {
      drained = false;
      req.pause();
      finish(false);
    };
    const beginDrain = () => {
      if (drainTimer) return;
      drainTimer = setTimeout(stopAfterBoundedDrain, OVERSIZE_DRAIN_TIMEOUT_MS);
    };
    const onData = (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      if (oversized) {
        drainBytes += bytes.length;
        if (drainBytes > MAX_OVERSIZE_DRAIN_BYTES) stopAfterBoundedDrain();
        return;
      }
      total += bytes.length;
      if (total > MAX_REQUEST_BYTES) {
        oversized = true;
        drained = true;
        drainBytes = total;
        chunks.length = 0;
        beginDrain();
        if (drainBytes > MAX_OVERSIZE_DRAIN_BYTES) stopAfterBoundedDrain();
        return;
      }
      chunks.push(bytes);
    };
    const onEnd = () => finish(!oversized || drained);
    const onAborted = () => {
      if (settled) return;
      cleanup();
      reject(Object.assign(new Error("document request was aborted"), { statusCode: 400 }));
    };
    const onError = (error: Error) => {
      if (settled) return;
      cleanup();
      reject(Object.assign(error, { statusCode: 400 }));
    };

    if (declaredOversized) beginDrain();
    req.on("data", onData);
    req.once("end", onEnd);
    req.once("aborted", onAborted);
    req.once("error", onError);
    req.resume();
  });
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const body = await readRequestBody(req);
  if (body.oversized) {
    throw Object.assign(new Error("document request is too large"), {
      statusCode: 413,
      closeRequest: !body.drained,
    });
  }
  const raw = body.raw.toString("utf8");
  try {
    return JSON.parse(raw);
  } catch {
    throw Object.assign(new Error("document request must be valid JSON"), { statusCode: 400 });
  }
}

function normalizeRequest(value: unknown): DocumentRendererRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw Object.assign(new Error("document request must be an object"), { statusCode: 400 });
  }
  const row = value as Record<string, unknown>;
  const format = String(row.format ?? "").trim().toLowerCase();
  if (format !== "md" && format !== "html" && format !== "doc") {
    throw Object.assign(new Error(`unsupported document format: ${format || "(empty)"}`), { statusCode: 415 });
  }
  if (typeof row.markdown !== "string") {
    throw Object.assign(new Error("markdown must be a string"), { statusCode: 400 });
  }
  const title = typeof row.title === "string" ? row.title : "";
  return { format, title, markdown: row.markdown };
}

/** Start an authenticated loopback renderer. No request can read or write a file. */
export async function startDocumentRendererHost(
  resolveIdentity?: ResolveDocumentRendererIdentity,
): Promise<DocumentRendererHost> {
  const renderer = loadRendererModule();
  const token = crypto.randomBytes(32).toString("hex");
  let server: http.Server;
  server = http.createServer((req, res) => {
    if (!hasValidToken(req, token)) {
      writeJson(res, 401, { error: "unauthorized" });
      return;
    }
    if (req.method === "GET" && req.url === "/health") {
      writeJson(res, 200, { ok: true });
      return;
    }
    if (req.method === "GET" && req.url === "/identity") {
      void Promise.resolve(resolveIdentity?.() ?? null)
        .then((identity) => writeJson(res, 200, { identity: identity ?? null }))
        .catch(() => writeJson(res, 200, { identity: null }));
      return;
    }
    if (req.method !== "POST" || req.url !== "/render") {
      res.setHeader("Allow", "POST");
      writeJson(res, 404, { error: "not found" });
      return;
    }

    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy());
    void (async () => {
      try {
        const input = normalizeRequest(await readJsonBody(req));
        const output = renderer.renderDocument(input);
        const responseBytes = Buffer.byteLength(JSON.stringify(output), "utf8");
        if (responseBytes > MAX_RESPONSE_BYTES) {
          writeJson(res, 413, { error: "rendered document is too large" });
          return;
        }
        writeJson(res, 200, output);
      } catch (error) {
        const status = Number((error as { statusCode?: unknown })?.statusCode);
        if (status === 413) {
          // Do not leave an oversized request body attached to a reusable
          // keep-alive socket. A fully drained body can close normally; a
          // bounded drain stops reading and closes after the response flushes.
          res.setHeader("Connection", "close");
          if ((error as { closeRequest?: unknown }).closeRequest) {
            res.once("finish", () => req.destroy());
          }
        }
        writeJson(res, Number.isInteger(status) && status >= 400 ? status : 400, {
          error: String(error instanceof Error ? error.message : error),
        });
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("document renderer did not expose a loopback address");
  }
  let closed = false;
  return {
    url: `http://127.0.0.1:${address.port}`,
    token,
    close: async () => {
      if (closed) return;
      closed = true;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
