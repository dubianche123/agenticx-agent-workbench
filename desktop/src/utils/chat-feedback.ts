/**
 * Renderer-side contract for per-message assistant feedback.
 *
 * Feedback intentionally lives outside Message.  The preload owns the
 * durable record and exposes only the operations needed by the chat
 * surface.  Keeping the parser here lets the renderer accept either a plain
 * map or the small `{ feedback: [...] }` envelope used by the desktop host.
 */

export type ChatFeedbackValue = "like" | "dislike";

/** A learning mirror retry must not be interpreted as a vote toggle. */
export type ChatFeedbackAction = {
  retryLearning?: boolean;
};

export type ChatFeedbackMap = Record<string, ChatFeedbackValue>;

export type ChatFeedbackWrite = {
  sessionId: string;
  messageId: string;
  value: ChatFeedbackValue;
  /** Opaque scope captured from the authenticated Electron host. */
  expectedScopeId: string;
};

export type ChatFeedbackClear = {
  sessionId: string;
  messageId: string;
  /** Opaque scope captured from the authenticated Electron host. */
  expectedScopeId: string;
};

export type ChatFeedbackScopeGuard = {
  /** Complete account stamp captured from the trusted main-process snapshot. */
  expectedScopeId: string;
  expectedAuthGeneration: number;
};

export type ChatFeedbackApi = {
  scope: (guard: ChatFeedbackScopeGuard) => Promise<unknown>;
  list: (sessionId: string, expectedScopeId?: string) => Promise<unknown>;
  set: (input: ChatFeedbackWrite) => Promise<unknown>;
  clear: (input: ChatFeedbackClear) => Promise<unknown>;
};

export type ChatFeedbackStatus = "success" | "error" | "learning-error";

export type ChatFeedbackUiState = {
  /** Session key that owns every value below. */
  sessionId: string;
  /** Server-authoritative values returned by feedback.list. */
  values: ChatFeedbackMap;
  /** Optimistic values retained until the corresponding write settles. */
  overrides: Record<string, ChatFeedbackValue | null>;
  pending: Record<string, boolean>;
  status: Record<string, ChatFeedbackStatus>;
};

export function createChatFeedbackState(sessionId: string): ChatFeedbackUiState {
  return {
    sessionId,
    values: {},
    overrides: {},
    pending: {},
    status: {},
  };
}

/**
 * Resolve one click into the next persisted value.  The operation is
 * deliberately pure so the UI and tests share exactly the same toggle
 * semantics: click the selected value to clear it, otherwise switch/set it.
 */
export function nextChatFeedbackValue(
  current: ChatFeedbackValue | null | undefined,
  requested: ChatFeedbackValue,
): ChatFeedbackValue | null {
  return current === requested ? null : requested;
}

/**
 * Resolve a feedback button click, keeping a failed learning mirror retryable.
 * The explicit action is consumed by ChatPane; returning the current value for
 * a selected button prevents a learning retry from being mistaken for clear.
 */
export function resolveChatFeedbackClick(
  current: ChatFeedbackValue | null | undefined,
  requested: ChatFeedbackValue,
  status?: ChatFeedbackStatus,
): { value: ChatFeedbackValue | null; action?: ChatFeedbackAction } {
  const retryLearning = status === "learning-error" && current === requested;
  return retryLearning
    ? { value: current ?? null, action: { retryLearning: true } }
    : { value: nextChatFeedbackValue(current, requested) };
}

/** Read a value only when the state belongs to the currently displayed session. */
export function chatFeedbackValueForMessage(
  state: ChatFeedbackUiState,
  sessionId: string,
  messageId: string,
): ChatFeedbackValue | null {
  if (state.sessionId !== sessionId) return null;
  if (Object.prototype.hasOwnProperty.call(state.overrides, messageId)) {
    return state.overrides[messageId] ?? null;
  }
  return state.values[messageId] ?? null;
}

/** Apply an optimistic value and mark the write pending. */
export function beginChatFeedbackWrite(
  state: ChatFeedbackUiState,
  input: { sessionId: string; messageId: string; value: ChatFeedbackValue | null },
): ChatFeedbackUiState {
  if (state.sessionId !== input.sessionId) return state;
  const status = { ...state.status };
  delete status[input.messageId];
  return {
    ...state,
    overrides: { ...state.overrides, [input.messageId]: input.value },
    pending: { ...state.pending, [input.messageId]: true },
    status,
  };
}

/** Commit a successful write into the server-value map and clear its override. */
export function completeChatFeedbackWrite(
  state: ChatFeedbackUiState,
  input: { sessionId: string; messageId: string; value: ChatFeedbackValue | null },
): ChatFeedbackUiState {
  if (state.sessionId !== input.sessionId) return state;
  const values = { ...state.values };
  if (input.value === null) delete values[input.messageId];
  else values[input.messageId] = input.value;
  const overrides = { ...state.overrides };
  delete overrides[input.messageId];
  const pending = { ...state.pending };
  delete pending[input.messageId];
  return {
    ...state,
    values,
    overrides,
    pending,
    status: { ...state.status, [input.messageId]: "success" },
  };
}

/** Restore the value visible before a rejected write. */
export function failChatFeedbackWrite(
  state: ChatFeedbackUiState,
  input: {
    sessionId: string;
    messageId: string;
    previousValue: ChatFeedbackValue | null;
  },
): ChatFeedbackUiState {
  if (state.sessionId !== input.sessionId) return state;
  const pending = { ...state.pending };
  delete pending[input.messageId];
  return {
    ...state,
    overrides: { ...state.overrides, [input.messageId]: input.previousValue },
    pending,
    status: { ...state.status, [input.messageId]: "error" },
  };
}

/** Keep the authoritative vote while making a failed local-learning mirror retryable. */
export function markChatFeedbackLearningError(
  state: ChatFeedbackUiState,
  input: { sessionId: string; messageId: string },
): ChatFeedbackUiState {
  if (state.sessionId !== input.sessionId) return state;
  const pending = { ...state.pending };
  delete pending[input.messageId];
  return {
    ...state,
    pending,
    status: { ...state.status, [input.messageId]: "learning-error" },
  };
}

export function clearChatFeedbackStatus(
  state: ChatFeedbackUiState,
  sessionId: string,
  messageId: string,
): ChatFeedbackUiState {
  if (state.sessionId !== sessionId || !Object.prototype.hasOwnProperty.call(state.status, messageId)) {
    return state;
  }
  const status = { ...state.status };
  delete status[messageId];
  return { ...state, status };
}

function cleanPart(value: unknown): string {
  return String(value ?? "").trim();
}

function isFeedbackValue(value: unknown): value is ChatFeedbackValue {
  return value === "like" || value === "dislike";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Parse the opaque account scope returned by the trusted Desktop host. */
export function parseChatFeedbackScope(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  if (Object.prototype.hasOwnProperty.call(payload, "data")) {
    const nested = parseChatFeedbackScope(payload.data);
    if (nested) return nested;
  }
  const value = cleanPart(payload.scope_id ?? payload.scopeId);
  if (!value || value.length > 512) return null;
  if (Array.from(value).some((char) => char.charCodeAt(0) < 0x20)) return null;
  return value;
}

/** Parse the trusted main-process generation returned with the scope. */
export function parseChatFeedbackAuthGeneration(payload: unknown): number | null {
  if (!isRecord(payload)) return null;
  if (Object.prototype.hasOwnProperty.call(payload, "data")) {
    const nested = parseChatFeedbackAuthGeneration(payload.data);
    if (nested !== null) return nested;
  }
  const value = payload.auth_generation ?? payload.authGeneration;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function feedbackRecord(raw: unknown): { messageId: string; value: ChatFeedbackValue } | null {
  if (!isRecord(raw)) return null;
  const messageId = cleanPart(raw.message_id ?? raw.messageId ?? raw.id);
  const value = raw.value ?? raw.feedback ?? raw.type;
  if (!messageId || !isFeedbackValue(value)) return null;
  return { messageId, value };
}

/** Normalize the small response variants a preload may return. */
export function parseChatFeedbackMap(payload: unknown): ChatFeedbackMap {
  if (Array.isArray(payload)) {
    const result: ChatFeedbackMap = {};
    for (const item of payload) {
      const row = feedbackRecord(item);
      if (row) result[row.messageId] = row.value;
    }
    return result;
  }
  if (!isRecord(payload)) return {};

  // Common IPC envelopes (`{ data: ... }`, `{ feedback: [...] }`).
  if (Object.prototype.hasOwnProperty.call(payload, "data")) {
    return parseChatFeedbackMap(payload.data);
  }
  for (const key of ["feedback", "items", "records"]) {
    if (Object.prototype.hasOwnProperty.call(payload, key)) {
      return parseChatFeedbackMap(payload[key]);
    }
  }

  // A plain map is the most convenient preload return shape.
  const result: ChatFeedbackMap = {};
  for (const [messageId, value] of Object.entries(payload)) {
    if (isFeedbackValue(value) && cleanPart(messageId)) result[messageId] = value;
  }
  return result;
}

/** Desktop preload methods commonly return `{ ok: false, error }` on HTTP failures. */
export function assertChatFeedbackOperationOk(payload: unknown, fallback = "保存反馈失败"): void {
  if (!isRecord(payload) || payload.ok !== false) return;
  const detail = payload.error ?? payload.message ?? payload.detail;
  const message = cleanPart(detail);
  throw new Error(message || fallback);
}

type FeedbackApiShape = {
  scope?: unknown;
  list?: unknown;
  set?: unknown;
  clear?: unknown;
};

function asFeedbackApi(candidate: unknown): ChatFeedbackApi | null {
  if (!isRecord(candidate)) return null;
  if (
    typeof candidate.scope !== "function" ||
    typeof candidate.list !== "function" ||
    typeof candidate.set !== "function" ||
    typeof candidate.clear !== "function"
  ) {
    return null;
  }
  const api = candidate as FeedbackApiShape;
  return {
    scope: api.scope as ChatFeedbackApi["scope"],
    list: api.list as ChatFeedbackApi["list"],
    set: api.set as ChatFeedbackApi["set"],
    clear: api.clear as ChatFeedbackApi["clear"],
  };
}

/**
 * Resolve the narrow API from either desktop preload naming convention.
 * `agenticxDesktop` is the current app convention; `electronAPI` is accepted
 * for newer preload builds and makes the renderer safe during the migration.
 */
export function resolveChatFeedbackApi(): ChatFeedbackApi | null {
  if (typeof window === "undefined") return null;
  const host = window as unknown as {
    agenticxDesktop?: {
      feedback?: unknown;
      feedbackScope?: unknown;
      feedbackList?: unknown;
      feedbackSet?: unknown;
      feedbackClear?: unknown;
    };
    electronAPI?: {
      feedback?: unknown;
      feedbackScope?: unknown;
      feedbackList?: unknown;
      feedbackSet?: unknown;
      feedbackClear?: unknown;
    };
  };

  const candidates = [host.agenticxDesktop, host.electronAPI];
  for (const candidate of candidates) {
    const nested = asFeedbackApi(candidate?.feedback);
    if (nested) return nested;
    const scope = candidate?.feedbackScope;
    const list = candidate?.feedbackList;
    const set = candidate?.feedbackSet;
    const clear = candidate?.feedbackClear;
    if (
      typeof scope === "function" &&
      typeof list === "function" &&
      typeof set === "function" &&
      typeof clear === "function"
    ) {
      return {
        scope: scope as ChatFeedbackApi["scope"],
        list: list as ChatFeedbackApi["list"],
        set: set as ChatFeedbackApi["set"],
        clear: clear as ChatFeedbackApi["clear"],
      };
    }
  }
  return null;
}
