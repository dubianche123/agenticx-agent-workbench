import { NextResponse } from "next/server";

import { listConfigMarketAudienceDirectory } from "../../../../../lib/config-market/audience";
import { resolveDesktopIdentity } from "../../../../../lib/desktop-auth";

export const runtime = "nodejs";

function errorResponse(status: number, code: string, message: string) {
  return NextResponse.json({ code, message }, { status });
}

function integerParameter(
  value: string | null,
  fallback: number,
  range: { min: number; max: number },
): number | null {
  if (value === null) return fallback;
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= range.min && parsed <= range.max
    ? parsed
    : null;
}

/** Minimal live tenant directory for Desktop's market visibility picker. */
export async function GET(request: Request) {
  const identity = await resolveDesktopIdentity(request);
  if (!identity) return errorResponse(401, "40101", "企业登录已失效，请重新登录");
  if (!identity.scopes.includes("desktop:managed")) {
    return errorResponse(403, "40301", "当前令牌不能读取企业广场受众");
  }

  const url = new URL(request.url);
  const q = url.searchParams.get("q")?.trim() ?? "";
  const limit = integerParameter(url.searchParams.get("limit"), 50, { min: 1, max: 100 });
  const offset = integerParameter(url.searchParams.get("offset"), 0, { min: 0, max: 10_000 });
  if ([...q].length > 100 || limit === null || offset === null) {
    return errorResponse(400, "40001", "invalid audience search parameters");
  }

  try {
    const data = await listConfigMarketAudienceDirectory({
      tenantId: identity.tenantId,
      ...(q ? { q } : {}),
      limit,
      offset,
    });
    return NextResponse.json(
      { code: "00000", message: "ok", data },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    console.error("[config-market] audience directory failed:", error);
    return errorResponse(500, "50000", "failed to load configuration market audience");
  }
}
