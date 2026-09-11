import { NextResponse } from "next/server";
import { assistantActionRuntime, assistantErrorResponse, authenticateDesktopAssistantRequest } from "../../../../../../lib/desktop-assistant";

export const runtime = "nodejs";
type Params = Promise<{ id: string }>;

export async function GET(request: Request, segmentData: { params: Params }) {
  const { id } = await segmentData.params;
  if (!id?.trim()) return NextResponse.json({ code: "ACTION_VALIDATION_FAILED", message: "operation id required" }, { status: 400 });
  try {
    const context = await authenticateDesktopAssistantRequest(request);
    const operation = await assistantActionRuntime().getOperation({ request: context.request, operationId: id.trim() });
    return NextResponse.json({ code: "00000", message: "ok", data: operation });
  } catch (error) {
    const response = assistantErrorResponse(error);
    return NextResponse.json(response.body, { status: response.status });
  }
}
