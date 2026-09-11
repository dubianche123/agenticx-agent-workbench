import {
  artifactBaseName,
  artifactExt,
  isPrivateSessionArtifactPath,
  isUserVisibleArtifactPath,
} from "./session-artifacts";
import { studioFetch } from "./studio-fetch";

export type SessionTurnChangeKind = "added" | "modified" | "deleted" | "unchanged" | string;

export type SessionTurnFileChange = {
  path: string;
  change: SessionTurnChangeKind;
  addedLines: number;
  removedLines: number;
  /** Optional server flags used to hide superseded/private bookkeeping rows. */
  private?: boolean;
  superseded?: boolean;
  current?: boolean;
};

export type SessionTurnArtifact = {
  path: string;
  title: string;
  format: string;
  size?: number;
  mimeType?: string;
  /** Kept for defensive filtering when a caller constructs a row directly. */
  private?: boolean;
  superseded?: boolean;
  current?: boolean;
};

export type SessionTurn = {
  turnId: string;
  /** Optional server fence; endpoint responses are still scoped by request. */
  sessionId?: string;
  /** Authoritative request id stamped on the preceding user message. */
  clientTurnId?: string;
  status: string;
  createdAt: string;
  canUndo: boolean;
  reason?: string;
  files: SessionTurnFileChange[];
  artifacts: SessionTurnArtifact[];
  /** The server explicitly supplied an artifact/deliverable list. */
  deliverablesDeclared?: boolean;
};

export type SessionTurnUndoResult = {
  ok: boolean;
  turnId: string;
  messages: unknown[];
  artifacts: SessionTurnArtifact[];
};

export type SessionTurnsRequestOptions = {
  sessionId: string;
  storeBase?: string;
  apiToken?: string;
  signal?: AbortSignal;
};

export class SessionTurnRequestError extends Error {
  readonly status: number;
  readonly payload: unknown;

  constructor(message: string, status: number, payload?: unknown) {
    super(message);
    this.name = "SessionTurnRequestError";
    this.status = status;
    this.payload = payload;
  }
}

export class SessionTurnConflictError extends SessionTurnRequestError {
  readonly conflictPaths: string[];

  constructor(message: string, status: number, payload?: unknown) {
    super(message, status, payload);
    this.name = "SessionTurnConflictError";
    this.conflictPaths = conflictPathsFromPayload(payload);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : String(value ?? "").trim();
}

function finiteCount(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
}

function rawList(payload: unknown, key: string): unknown[] {
  if (!isRecord(payload)) return [];
  const value = payload[key];
  return Array.isArray(value) ? value : [];
}

function hasOwn(raw: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(raw, key);
}

function isSupersededOrPrivate(raw: Record<string, unknown>): boolean {
  const status = stringValue(raw.status ?? raw.state).toLowerCase();
  return (
    raw.private === true ||
    raw.is_private === true ||
    raw.superseded === true ||
    raw.is_superseded === true ||
    raw.current === false ||
    raw.is_current === false ||
    raw.visible === false ||
    new Set(["private", "superseded", "archived", "hidden"]).has(status)
  );
}

function rawArtifactRows(raw: Record<string, unknown>): { rows: unknown[]; declared: boolean } {
  // `/api/session/turns` returns the authoritative publication rows under
  // `artifacts`; keep this contract explicit so a future endpoint cannot
  // silently broaden the card source without a coordinated API change.
  return { rows: rawList(raw, "artifacts"), declared: hasOwn(raw, "artifacts") };
}

function normalizeFileChange(raw: unknown): SessionTurnFileChange | null {
  if (!isRecord(raw)) return null;
  const path = stringValue(raw.path ?? raw.file_path ?? raw.filePath ?? raw.output_path ?? raw.outputPath);
  if (!path || !isUserVisibleArtifactPath(path) || isSupersededOrPrivate(raw)) return null;
  return {
    path,
    change: stringValue(raw.change ?? raw.kind ?? raw.status) || "modified",
    addedLines: finiteCount(raw.added_lines ?? raw.addedLines ?? raw.added),
    removedLines: finiteCount(raw.removed_lines ?? raw.removedLines ?? raw.removed),
    ...(raw.private === true || raw.is_private === true ? { private: true } : {}),
    ...(raw.superseded === true || raw.is_superseded === true ? { superseded: true } : {}),
    ...(raw.current === false || raw.is_current === false ? { current: false } : {}),
  };
}

function normalizeArtifact(raw: unknown): SessionTurnArtifact | null {
  if (typeof raw === "string") {
    const path = raw.trim();
    if (!path || !isUserVisibleArtifactPath(path)) return null;
    return { path, title: artifactBaseName(path) || path, format: artifactExt(path) };
  }
  if (!isRecord(raw)) return null;
  const path = stringValue(raw.path ?? raw.file_path ?? raw.filePath ?? raw.output_path ?? raw.outputPath);
  if (!path || !isUserVisibleArtifactPath(path) || isSupersededOrPrivate(raw)) return null;
  const format = (stringValue(raw.format ?? raw.type ?? raw.extension) || artifactExt(path)).toLowerCase();
  const size = Number(raw.size ?? raw.bytes ?? raw.byte_size);
  return {
    path,
    title: stringValue(raw.title ?? raw.name) || artifactBaseName(path) || path,
    format,
    ...(Number.isFinite(size) && size >= 0 ? { size: Math.floor(size) } : {}),
    ...(stringValue(raw.mime_type ?? raw.mimeType) ? { mimeType: stringValue(raw.mime_type ?? raw.mimeType) } : {}),
    ...(raw.private === true || raw.is_private === true ? { private: true } : {}),
    ...(raw.superseded === true || raw.is_superseded === true ? { superseded: true } : {}),
    ...(raw.current === false || raw.is_current === false ? { current: false } : {}),
  };
}

export function normalizeSessionTurn(raw: unknown): SessionTurn | null {
  if (!isRecord(raw)) return null;
  const turnId = stringValue(raw.turn_id ?? raw.turnId ?? raw.id);
  if (!turnId) return null;
  const files = rawList(raw, "files")
    .map(normalizeFileChange)
    .filter((row): row is SessionTurnFileChange => Boolean(row));
  const artifactRows = rawArtifactRows(raw);
  const rawArtifacts = artifactRows.rows;
  const deliverablesDeclared = artifactRows.declared;
  const artifacts = rawArtifacts
    .map(normalizeArtifact)
    .filter((row): row is SessionTurnArtifact => Boolean(row));
  return {
    turnId,
    sessionId: stringValue(raw.session_id ?? raw.sessionId) || undefined,
    clientTurnId: stringValue(raw.client_turn_id ?? raw.clientTurnId) || undefined,
    status: stringValue(raw.status) || "unknown",
    createdAt: stringValue(raw.created_at ?? raw.createdAt),
    canUndo: raw.can_undo === true || raw.canUndo === true,
    reason: stringValue(raw.reason) || undefined,
    files,
    artifacts,
    deliverablesDeclared,
  };
}

export function normalizeSessionTurns(payload: unknown): SessionTurn[] {
  const rows = isRecord(payload)
    ? (Array.isArray(payload.turns)
      ? payload.turns
      : Array.isArray(payload.manifests)
        ? payload.manifests
        : Array.isArray(payload.items)
          ? payload.items
          : payload)
    : payload;
  if (!Array.isArray(rows)) return [];
  return rows.map(normalizeSessionTurn).filter((row): row is SessionTurn => Boolean(row));
}

function payloadRecords(payload: unknown): Record<string, unknown>[] {
  if (!isRecord(payload)) return [];
  const detail = isRecord(payload.detail) ? payload.detail : null;
  return detail ? [detail, payload] : [payload];
}

function conflictPathsFromPayload(payload: unknown): string[] {
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const record of payloadRecords(payload)) {
    const raw = record.conflict_paths ?? record.conflictPaths ?? record.paths ?? record.conflicts;
    if (!Array.isArray(raw)) continue;
    for (const item of raw) {
      const path = stringValue(isRecord(item) ? item.path : item);
      if (!path || seen.has(path) || isPrivateSessionArtifactPath(path)) continue;
      seen.add(path);
      paths.push(path);
    }
  }
  return paths;
}

function isKnownTurnConflictPayload(payload: unknown): boolean {
  const records = payloadRecords(payload);
  const codes = records
    .map((record) => stringValue(record.code).toLowerCase())
    .filter(Boolean);
  if (codes.length > 0) return codes.includes("conflict");
  return records.some((record) =>
    ["conflict_paths", "conflictPaths"].some((key) => Array.isArray(record[key])),
  );
}

function errorMessage(payload: unknown, fallback: string): string {
  if (isRecord(payload)) {
    const rawDetail = payload.detail ?? payload.message ?? payload.error;
    const detail = stringValue(rawDetail);
    if (detail && detail !== "[object Object]") return detail;
    if (isRecord(rawDetail)) {
      const nested = stringValue(rawDetail.message ?? rawDetail.error ?? rawDetail.reason);
      if (nested && nested !== "[object Object]") return nested;
    }
  }
  return fallback;
}

async function readPayload(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export async function fetchSessionTurns(options: SessionTurnsRequestOptions): Promise<SessionTurn[]> {
  const sessionId = stringValue(options.sessionId);
  if (!sessionId) return [];
  const response = await studioFetch(
    `/api/session/turns?session_id=${encodeURIComponent(sessionId)}`,
    {
      storeBase: options.storeBase,
      apiToken: options.apiToken,
      signal: options.signal,
    },
  );
  const payload = await readPayload(response);
  if (!response.ok) {
    throw new SessionTurnRequestError(
      errorMessage(payload, `加载轮次失败（${response.status}）`),
      response.status,
      payload,
    );
  }
  return normalizeSessionTurns(payload);
}

export async function undoSessionTurn(options: SessionTurnsRequestOptions & { turnId: string }): Promise<SessionTurnUndoResult> {
  const sessionId = stringValue(options.sessionId);
  const turnId = stringValue(options.turnId);
  if (!sessionId || !turnId) {
    throw new SessionTurnRequestError("撤回轮次参数无效", 400);
  }
  const response = await studioFetch("/api/session/turns/undo", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: sessionId, turn_id: turnId }),
    storeBase: options.storeBase,
    apiToken: options.apiToken,
    signal: options.signal,
  });
  const payload = await readPayload(response);
  if (!response.ok) {
    const knownConflict = response.status === 409 && isKnownTurnConflictPayload(payload);
    const fallback = knownConflict
      ? "文件在本轮后有改动，无法撤回；手工修改已保留"
      : response.status === 409
        ? "撤回请求无法完成，请稍后重试"
        : `撤回轮次失败（${response.status}）`;
    const message = knownConflict ? fallback : errorMessage(payload, fallback);
    if (response.status === 409) throw new SessionTurnConflictError(message, response.status, payload);
    throw new SessionTurnRequestError(message, response.status, payload);
  }
  const body = isRecord(payload) ? payload : {};
  return {
    ok: body.ok !== false,
    turnId: stringValue(body.turn_id ?? body.turnId) || turnId,
    messages: Array.isArray(body.messages) ? body.messages : [],
    artifacts: rawList(body, "artifacts").map(normalizeArtifact).filter((row): row is SessionTurnArtifact => Boolean(row)),
  };
}

/** Filter a server manifest before showing it in a normal chat surface. */
export function visibleSessionTurnFiles(turn: SessionTurn): SessionTurnFileChange[] {
  return turn.files.filter(
    (file) =>
      !file.private &&
      !file.superseded &&
      file.current !== false &&
      isUserVisibleArtifactPath(file.path),
  );
}

/** Filter a server manifest before showing it in a normal chat surface. */
export function visibleSessionTurnArtifacts(turn: SessionTurn): SessionTurnArtifact[] {
  return turn.artifacts.filter(
    (artifact) =>
      !artifact.private &&
      !artifact.superseded &&
      artifact.current !== false &&
      isUserVisibleArtifactPath(artifact.path),
  );
}

const DOCUMENT_DELIVERY_EXTENSIONS = new Set(["md", "markdown", "html", "htm", "doc", "docx"]);

/** Formats supported by the document revision handoff contract. */
export function isDocumentDeliveryPath(path: string): boolean {
  return DOCUMENT_DELIVERY_EXTENSIONS.has(artifactExt(path));
}

function uniqueVisiblePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of paths) {
    const path = String(raw || "").trim();
    if (!path || seen.has(path) || !isUserVisibleArtifactPath(path)) continue;
    seen.add(path);
    out.push(path);
  }
  return out;
}

/**
 * Current deliverables from the authoritative server turn manifest.
 * Published artifacts take precedence; changed supported documents are also
 * accepted because an in-place edit can be registered as a file change even
 * when the publication helper has no extra title metadata.
 */
export function visibleSessionTurnDeliverablePaths(turn: SessionTurn): string[] {
  const artifacts = visibleSessionTurnArtifacts(turn).map((artifact) => artifact.path);
  const changedDocuments = visibleSessionTurnFiles(turn)
    .filter((file) => file.change.toLowerCase() !== "deleted" && isDocumentDeliveryPath(file.path))
    .map((file) => file.path);
  return uniqueVisiblePaths([...artifacts, ...changedDocuments]);
}

/** A document-only turn gets one compact undo action beside its document tile. */
export function isDocumentOnlyTurn(turn: SessionTurn): boolean {
  const files = visibleSessionTurnFiles(turn);
  const artifacts = visibleSessionTurnArtifacts(turn);
  const paths = [...files.map((file) => file.path), ...artifacts.map((artifact) => artifact.path)];
  return (
    paths.length > 0 &&
    paths.every((path) => isDocumentDeliveryPath(path))
  );
}

function isInactiveTurn(turn: SessionTurn): boolean {
  return new Set(["rewound", "aborted"]).has(turn.status.trim().toLowerCase());
}

function turnTime(value: string): number {
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

/** The API is newest-first; timestamps provide a defensive fallback if a proxy reorders rows. */
export function latestSessionTurn(turns: SessionTurn[]): SessionTurn | null {
  const active = turns.filter((turn) => !isInactiveTurn(turn));
  if (active.length === 0) return null;
  let latest = active[0] ?? null;
  let latestTime = turnTime(latest?.createdAt ?? "");
  for (const candidate of active.slice(1)) {
    const candidateTime = turnTime(candidate.createdAt);
    if (Number.isFinite(candidateTime) && (!Number.isFinite(latestTime) || candidateTime > latestTime)) {
      latest = candidate;
      latestTime = candidateTime;
    }
  }
  return latest;
}

/** Only the server's newest active turn may expose a rollback affordance. */
export function canOfferSessionTurnUndo(turn: SessionTurn, turns: SessionTurn[]): boolean {
  // The server keeps the newest row first. Once that row is rewound or aborted,
  // older rows must stay hidden instead of becoming a second public undo.
  const newestServerTurn = turns[0];
  if (newestServerTurn && isInactiveTurn(newestServerTurn)) return false;
  const latest = latestSessionTurn(turns);
  return Boolean(turn.canUndo && latest && latest.turnId === turn.turnId);
}
