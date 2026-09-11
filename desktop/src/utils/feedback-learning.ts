import { studioFetch } from "./studio-fetch";

export type FeedbackLearningValue = "like" | "dislike" | null;

export type FeedbackLearningRequest = {
  sessionId: string;
  messageId: string;
  value: FeedbackLearningValue;
  /** Opaque scope captured from the authenticated Desktop host. */
  expectedScopeId: string;
  storeBase?: string;
  apiToken?: string;
  signal?: AbortSignal;
};

export class FeedbackLearningSyncError extends Error {
  readonly status: number;
  readonly payload: unknown;

  constructor(message: string, status: number, payload?: unknown) {
    super(message);
    this.name = "FeedbackLearningSyncError";
    this.status = status;
    this.payload = payload;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function messageFromPayload(payload: unknown, fallback: string): string {
  if (!isRecord(payload)) return fallback;
  const detail = payload.detail ?? payload.message ?? payload.error;
  if (typeof detail === "string" && detail.trim()) return detail.trim();
  if (isRecord(detail)) {
    const nested = detail.message ?? detail.error ?? detail.reason;
    if (typeof nested === "string" && nested.trim()) return nested.trim();
  }
  return fallback;
}

export async function mirrorFeedbackLearning(request: FeedbackLearningRequest): Promise<unknown> {
  const sessionId = String(request.sessionId || "").trim();
  const messageId = String(request.messageId || "").trim();
  const expectedScopeId = String(request.expectedScopeId || "").trim();
  if (!sessionId || !messageId || !expectedScopeId) {
    throw new FeedbackLearningSyncError("反馈学习身份或参数无效", 400);
  }
  const response = await studioFetch("/api/session/feedback-learning", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      session_id: sessionId,
      message_id: messageId,
      value: request.value,
      expected_scope_id: expectedScopeId,
    }),
    storeBase: request.storeBase,
    apiToken: request.apiToken,
    signal: request.signal,
  });
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    /* Keep the HTTP status as the useful failure detail. */
  }
  if (!response.ok) {
    throw new FeedbackLearningSyncError(
      messageFromPayload(payload, `反馈学习同步失败（${response.status}）`),
      response.status,
      payload,
    );
  }
  return payload;
}
