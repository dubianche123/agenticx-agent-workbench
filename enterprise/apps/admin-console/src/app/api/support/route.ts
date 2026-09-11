import { NextResponse } from "next/server";
import { requireAdminScope } from "../../../lib/admin-auth";
import { getSupportBootstrap } from "../../../lib/support-assistant/assistant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Return only the authenticated administrator's support namespace and model options. */
export async function GET() {
  const guard = await requireAdminScope(["admin:enter"]);
  if (!guard.ok) return guard.response;

  try {
    const bootstrap = await getSupportBootstrap(guard.session);
    return NextResponse.json({ code: "00000", message: "ok", data: bootstrap });
  } catch (error) {
    console.error("[support-assistant] bootstrap failed:", error instanceof Error ? error.message : error);
    return NextResponse.json(
      { code: "50300", message: "支持助手暂时无法读取当前账号范围，请稍后重试。" },
      { status: 503 },
    );
  }
}
