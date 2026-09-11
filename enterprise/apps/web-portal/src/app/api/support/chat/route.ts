import { NextResponse } from "next/server";
import {
  SUPPORT_MAX_BODY_BYTES,
  parseSupportChatRequest,
} from "@agenticx/ui/support/contracts";
import { listAvailableModelsForUser } from "../../../../lib/admin-providers-reader";
import { getSessionAuthFromCookies, passwordChangeRequiredResponse } from "../../../../lib/session";
import {
  answerWithPortalGateway,
  staticSupportResponse,
  supportStorageKey,
  supportLinks,
} from "../../../../lib/support-assistant/server";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const auth = await getSessionAuthFromCookies();
  if (auth?.session.mustChangePassword) return passwordChangeRequiredResponse();
  if (!auth) {
    return NextResponse.json({ code: "40101", message: "unauthorized" }, { status: 401 });
  }

  // A browser-provided scope is only a same-principal consistency fence. The
  // server derives the expected value from the authenticated session and never
  // treats the header as authority.
  const requestedScope = request.headers.get("x-agenticx-support-scope")?.trim();
  if (!requestedScope || requestedScope !== supportStorageKey(auth.session)) {
    return NextResponse.json(
      { code: "40903", message: "support assistant identity changed; refresh bootstrap" },
      { status: 409 },
    );
  }

  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > SUPPORT_MAX_BODY_BYTES) {
    return NextResponse.json({ code: "40000", message: "support request is too large" }, { status: 400 });
  }
  let input: unknown;
  try {
    input = JSON.parse(raw);
  } catch {
    return NextResponse.json({ code: "40000", message: "invalid JSON" }, { status: 400 });
  }
  const parsed = parseSupportChatRequest(input);
  if (!parsed.ok) {
    return NextResponse.json({ code: "40000", message: parsed.reason }, { status: 400 });
  }

  let models;
  try {
    models = await listAvailableModelsForUser(auth.session);
  } catch {
    return NextResponse.json({
      code: "50302",
      message: "模型权限暂时无法校验；页面静态指引仍可用，请稍后重试自然语言回答。",
      data: staticSupportResponse(parsed.value.page, false),
    }, { status: 503 });
  }

  const selected = models.find((model) => model.id === parsed.value.model)
    ?? (parsed.value.model ? null : models.find((model) => model.isDefault) ?? models[0] ?? null);
  if (parsed.value.model && !selected) {
    return NextResponse.json({ code: "40301", message: "该模型已不在当前账号的可见范围内，请刷新后重新选择。" }, { status: 403 });
  }
  if (!selected) {
    return NextResponse.json({ code: "00000", message: "ok", data: staticSupportResponse(parsed.value.page, false) });
  }

  const result = await answerWithPortalGateway(
    request,
    auth.session,
    parsed.value.page,
    parsed.value.messages,
    selected,
    auth.accessToken,
  );
  if (!result.ok) {
    return NextResponse.json({
      code: "50301",
      message: result.message,
      data: { message: result.message, links: supportLinks(parsed.value.page) },
    }, { status: 503, headers: result.traceId ? { "x-agenticx-trace-id": result.traceId } : undefined });
  }
  return NextResponse.json({ code: "00000", message: "ok", data: result.response }, {
    headers: { "x-agenticx-trace-id": result.traceId },
  });
}
