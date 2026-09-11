import { NextResponse } from "next/server";

import { getSessionFromCookies, passwordChangeRequiredResponse } from "../../../../lib/session";
import {
  ChatFeedbackTargetNotFoundError,
  ChatFeedbackValidationError,
  deleteChatMessageFeedback,
  listChatMessageFeedback,
  upsertChatMessageFeedback,
} from "../../../../lib/chat-feedback";

export const runtime = "nodejs";

const MAX_BODY_CHARS = 16_384;

type SessionContext = NonNullable<Awaited<ReturnType<typeof getSessionFromCookies>>>;
type AuthenticationResult = { response: Response } | { session: SessionContext };

function errorResponse(status: number, code: string, message: string): NextResponse {
  return NextResponse.json({ code, message }, { status, headers: { "Cache-Control": "no-store" } });
}

async function authenticate(): Promise<AuthenticationResult> {
  const session = await getSessionFromCookies();
  if (session?.mustChangePassword) return { response: passwordChangeRequiredResponse() } as const;
  if (!session) return { response: errorResponse(401, "40101", "unauthorized") } as const;
  return { session } as const;
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const raw = await request.text();
  if (raw.length > MAX_BODY_CHARS) throw new ChatFeedbackValidationError("request body too large");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ChatFeedbackValidationError("invalid json body");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ChatFeedbackValidationError("invalid json body");
  }
  return parsed as Record<string, unknown>;
}

async function readBodyOrQuery(request: Request): Promise<Record<string, unknown>> {
  const raw = await request.text();
  if (raw.trim()) {
    if (raw.length > MAX_BODY_CHARS) throw new ChatFeedbackValidationError("request body too large");
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("invalid json body");
      }
      return parsed as Record<string, unknown>;
    } catch {
      throw new ChatFeedbackValidationError("invalid json body");
    }
  }
  const url = new URL(request.url);
  return {
    session_id: url.searchParams.get("session_id") ?? "",
    message_id: url.searchParams.get("message_id") ?? "",
  };
}

function stringField(body: Record<string, unknown>, name: string): string {
  return typeof body[name] === "string" ? body[name].trim() : "";
}

function publicView(view: {
  messageId: string;
  sessionId: string;
  value: "like" | "dislike" | null;
  counts: { like: number; dislike: number; total: number };
}) {
  return {
    message_id: view.messageId,
    session_id: view.sessionId,
    value: view.value,
    counts: view.counts,
  };
}

function handleError(error: unknown): NextResponse {
  if (error instanceof ChatFeedbackValidationError) {
    return errorResponse(400, "40001", error.message);
  }
  if (error instanceof ChatFeedbackTargetNotFoundError) {
    return errorResponse(404, "40401", "assistant message not found");
  }
  console.error("[chat/feedback] request failed:", error);
  return errorResponse(500, "50000", "failed to persist chat feedback");
}

export async function GET(request: Request) {
  const auth = await authenticate();
  if ("response" in auth) return auth.response;
  const url = new URL(request.url);
  const sessionId = url.searchParams.get("session_id")?.trim() ?? "";
  const oneMessageId = url.searchParams.get("message_id")?.trim() ?? "";
  const messageIds = [
    ...url.searchParams
      .getAll("message_id")
      .flatMap((value) => value.split(",")),
    ...((url.searchParams.get("message_ids") ?? "").split(",")),
  ]
    .map((value) => value.trim())
    .filter(Boolean);
  if (!sessionId) return errorResponse(400, "40001", "session_id is required");
  try {
    const items = await listChatMessageFeedback({
      actor: {
        tenantId: auth.session.tenantId,
        userId: auth.session.userId,
        departmentId: auth.session.deptId ?? null,
      },
      sessionId,
      messageIds: messageIds.length > 0 ? messageIds : oneMessageId ? [oneMessageId] : undefined,
    });
    return NextResponse.json(
      { code: "00000", message: "ok", data: { items: items.map(publicView) } },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return handleError(error);
  }
}

async function writeFeedback(request: Request): Promise<Response> {
  const auth = await authenticate();
  if ("response" in auth) return auth.response;
  try {
    const body = await readBody(request);
    const sessionId = stringField(body, "session_id");
    const messageId = stringField(body, "message_id");
    const value = stringField(body, "value");
    const result = await upsertChatMessageFeedback({
      actor: {
        tenantId: auth.session.tenantId,
        userId: auth.session.userId,
        departmentId: auth.session.deptId ?? null,
      },
      sessionId,
      messageId,
      value: value as "like" | "dislike",
    });
    return NextResponse.json(
      {
        code: "00000",
        message: "ok",
        data: {
          feedback: publicView(result.view),
          viewer_value: result.view.value,
        },
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return handleError(error);
  }
}

/** PUT is the canonical idempotent upsert verb. */
export async function PUT(request: Request): Promise<Response> {
  return writeFeedback(request);
}

export async function DELETE(request: Request): Promise<Response> {
  const auth = await authenticate();
  if ("response" in auth) return auth.response;
  try {
    const body = await readBodyOrQuery(request);
    const result = await deleteChatMessageFeedback({
      actor: {
        tenantId: auth.session.tenantId,
        userId: auth.session.userId,
        departmentId: auth.session.deptId ?? null,
      },
      sessionId: stringField(body, "session_id"),
      messageId: stringField(body, "message_id"),
    });
    return NextResponse.json(
      {
        code: "00000",
        message: "ok",
        data: {
          feedback: publicView(result.view),
          viewer_value: null,
        },
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return handleError(error);
  }
}
