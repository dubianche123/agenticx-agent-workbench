import { NextResponse } from "next/server";
import { assistantActionRuntime, assistantErrorResponse, authenticateDesktopAssistantRequest } from "../../../../../../../lib/desktop-assistant";

export const runtime = "nodejs";
type Params = Promise<{ id: string }>;

export async function POST(request: Request, segmentData: { params: Params }) {
  const { id } = await segmentData.params;
  if (!id?.trim()) return NextResponse.json({ code: "ACTION_VALIDATION_FAILED", message: "operation id required" }, { status: 400 });
  const raw = await request.text();
  if (raw.trim()) {
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return NextResponse.json({ code: "ACTION_VALIDATION_FAILED", message: "确认请求体不是有效 JSON" }, { status: 400 });
    }
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body as Record<string, unknown>).length > 0 || "confirmed" in (body as Record<string, unknown>)) {
      return NextResponse.json({ code: "ACTION_VALIDATION_FAILED", message: "确认接口不接受模型提交的 confirmed 字段" }, { status: 400 });
    }
  }
  try {
    const context = await authenticateDesktopAssistantRequest(request);
    const result = await assistantActionRuntime().confirm({ request: context.request, operationId: id.trim() });
    return NextResponse.json({ code: "00000", message: "ok", data: result });
  } catch (error) {
    const response = assistantErrorResponse(error);
    return NextResponse.json(response.body, { status: response.status });
  }
}
