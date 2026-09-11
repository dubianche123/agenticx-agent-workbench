import { NextResponse } from "next/server";
import {
  parseSupportChatRequest,
  SUPPORT_MAX_BODY_BYTES,
} from "@agenticx/ui/support/contracts";
import { requireAdminScope } from "../../../../lib/admin-auth";
import {
  handleSupportChat,
  supportStorageKey,
  supportErrorResponseMessage,
} from "../../../../lib/support-assistant/assistant";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const guard = await requireAdminScope(["admin:enter"]);
  if (!guard.ok) return guard.response;

  const supportScope = request.headers.get("x-agenticx-support-scope")?.trim();
  if (!supportScope || supportScope !== supportStorageKey(guard.session)) {
    return NextResponse.json(
      { code: "40903", message: "支持助手身份已变化，请刷新后重试。" },
      { status: 409 },
    );
  }

  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > SUPPORT_MAX_BODY_BYTES) {
    return NextResponse.json(
      { code: "40000", message: "support request is too large" },
      { status: 400 },
    );
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ code: "40000", message: "invalid JSON" }, { status: 400 });
  }
  const parsed = parseSupportChatRequest(body);
  if (!parsed.ok) {
    return NextResponse.json({ code: "40000", message: parsed.reason }, { status: 400 });
  }

  try {
    const response = await handleSupportChat({
      actor: guard.session,
      scopes: guard.scopes,
      storageKey: supportScope,
      messages: parsed.value.messages,
      page: parsed.value.page,
      ...(parsed.value.model ? { model: parsed.value.model } : {}),
      signal: request.signal,
    });
    return NextResponse.json({ code: "00000", message: "ok", data: response });
  } catch (error) {
    const mapped = supportErrorResponseMessage(error);
    if (mapped.status >= 500) {
      console.error("[support-assistant] chat failed:", error instanceof Error ? error.message : error);
    }
    return NextResponse.json(
      { code: mapped.code, message: mapped.message },
      { status: mapped.status },
    );
  }
}
