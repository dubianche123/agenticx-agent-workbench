import { NextResponse } from "next/server";
import {
  assistantActionRuntime,
  assistantErrorResponse,
  createDesktopAssistantSession,
} from "../../../../../lib/desktop-assistant";
import type { AssistantPermissionMode } from "@agenticx/action-runtime";

export const runtime = "nodejs";

const MODES = new Set<AssistantPermissionMode>(["plan", "ask", "auto"]);

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
  const keys = Object.keys(body);
  if (keys.some((key) => key !== "sessionId" && key !== "permissionMode")) {
    return NextResponse.json({ code: "ACTION_VALIDATION_FAILED", message: "sessions 只接受 sessionId 和 permissionMode" }, { status: 400 });
  }
  const studioSessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
  const permissionMode = body.permissionMode;
  if (!studioSessionId || studioSessionId.length > 160 || typeof permissionMode !== "string" || !MODES.has(permissionMode as AssistantPermissionMode)) {
    return NextResponse.json({ code: "ACTION_VALIDATION_FAILED", message: "sessionId 或 permissionMode 无效" }, { status: 400 });
  }

  try {
    const context = await createDesktopAssistantSession({ request, studioSessionId, permissionMode: permissionMode as AssistantPermissionMode });
    const actions = await assistantActionRuntime().capabilities(context.request);
    return NextResponse.json({
      code: "00000",
      message: "ok",
      data: {
        sessionToken: context.sessionToken,
        expiresAt: context.session.expiresAt,
        principal: context.principal,
        capabilities: { actions },
        authorizationVersion: context.request.authorizationVersion,
      },
    });
  } catch (error) {
    const response = assistantErrorResponse(error);
    return NextResponse.json(response.body, { status: response.status });
  }
}
