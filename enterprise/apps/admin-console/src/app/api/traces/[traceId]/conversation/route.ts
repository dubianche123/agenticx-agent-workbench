import { NextResponse } from "next/server";
import { requireAdminSomeScope } from "../../../../../lib/admin-auth";
import { getTraceConversationTurn } from "../../../../../lib/trace-conversation-io";

// Conversation is part of the complete trace view. Audit self/dept scopes
// alone must not pivot through a trace id into tenant-scoped chat content.
const TRACE_CONVERSATION_SCOPES = ["audit:read:all", "audit:manage", "metering:read"];

function hasTraceConversationScope(scopes: string[]): boolean {
  return scopes.some(
    (scope) => scope === "*" || TRACE_CONVERSATION_SCOPES.includes(scope),
  );
}

/** 26-char Crockford Base32 ULID. */
function isTraceId(value: string): boolean {
  return /^[0-9A-HJKMNP-TV-Z]{26}$/.test(value);
}

export async function GET(
  request: Request,
  context: { params: Promise<{ traceId: string }> },
) {
  const guard = await requireAdminSomeScope(TRACE_CONVERSATION_SCOPES);
  if (!guard.ok) {
    return guard.response;
  }
  // Defense in depth: do not trust an adapter that reports success for an
  // audit-only scope which is not in the full-conversation allowlist.
  if (!hasTraceConversationScope(guard.scopes)) {
    return NextResponse.json({ code: "40300", message: "forbidden" }, { status: 403 });
  }

  const { traceId: raw } = await context.params;
  const traceId = raw?.trim() ?? "";
  if (!isTraceId(traceId)) {
    return NextResponse.json({ code: "40001", message: "invalid trace_id" }, { status: 400 });
  }

  const url = new URL(request.url);
  const expand = url.searchParams.get("expand") === "1";

  try {
    const data = await getTraceConversationTurn(guard.session.tenantId, traceId, { expand });
    return NextResponse.json({ code: "00000", message: "ok", data });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ code: "50002", message, data: undefined }, { status: 500 });
  }
}
