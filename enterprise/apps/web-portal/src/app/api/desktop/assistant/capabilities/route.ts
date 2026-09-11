import { NextResponse } from "next/server";
import { assistantActionRuntime, assistantErrorResponse, authenticateDesktopAssistantRequest } from "../../../../../lib/desktop-assistant";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const context = await authenticateDesktopAssistantRequest(request);
    const actions = await assistantActionRuntime().capabilities(context.request);
    return NextResponse.json({
      code: "00000",
      message: "ok",
      data: { principal: context.principal, actions, authorizationVersion: context.request.authorizationVersion },
    });
  } catch (error) {
    const response = assistantErrorResponse(error);
    return NextResponse.json(response.body, { status: response.status });
  }
}
