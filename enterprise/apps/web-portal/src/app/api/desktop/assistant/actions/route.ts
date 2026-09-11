import { NextResponse } from "next/server";
import { assistantActionRuntime, assistantErrorResponse, authenticateDesktopAssistantRequest } from "../../../../../lib/desktop-assistant";

export const runtime = "nodejs";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ code: "ACTION_VALIDATION_FAILED", message: "请求体不是有效 JSON" }, { status: 400 });
  }
  if (!isPlainObject(body)) return NextResponse.json({ code: "ACTION_VALIDATION_FAILED", message: "请求体必须是对象" }, { status: 400 });
  const allowed = new Set(["actionId", "arguments", "idempotencyKey", "runId"]);
  if (Object.keys(body).some((key) => !allowed.has(key)) || "confirmed" in body) {
    return NextResponse.json({ code: "ACTION_VALIDATION_FAILED", message: "actions 不接受 confirmed；确认必须走独立 UI 接口" }, { status: 400 });
  }
  const actionId = typeof body.actionId === "string" ? body.actionId.trim() : "";
  const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey.trim() : "";
  if (!actionId || !idempotencyKey || !isPlainObject(body.arguments)) {
    return NextResponse.json({ code: "ACTION_VALIDATION_FAILED", message: "actionId、arguments、idempotencyKey 必填" }, { status: 400 });
  }
  const runId = body.runId === undefined || body.runId === null ? null : typeof body.runId === "string" ? body.runId.trim() : "";
  if (runId === "") return NextResponse.json({ code: "ACTION_VALIDATION_FAILED", message: "runId 无效" }, { status: 400 });
  try {
    const context = await authenticateDesktopAssistantRequest(request);
    const result = await assistantActionRuntime().run({ request: context.request, actionId, arguments: body.arguments, idempotencyKey, runId });
    return NextResponse.json({ code: "00000", message: "ok", data: result });
  } catch (error) {
    const response = assistantErrorResponse(error);
    return NextResponse.json(response.body, { status: response.status });
  }
}
