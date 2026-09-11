import { NextResponse } from "next/server";

import { defaultConfigMarketStore } from "../../../../../lib/config-market/store";
import {
  isValidConfigMarketId,
  toConfigMarketDetail,
} from "../../../../../lib/config-market/types";
import { resolveDesktopIdentity, type DesktopIdentity } from "../../../../../lib/desktop-auth";

export const runtime = "nodejs";

type Params = Promise<{ id: string }>;

function errorResponse(status: number, code: string, message: string) {
  return NextResponse.json({ code, message }, { status });
}

function marketViewer(identity: DesktopIdentity) {
  return {
    ...identity,
    ...(identity.scopes.includes("*") || identity.scopes.includes("admin:enter")
      ? { isAdmin: true }
      : {}),
  };
}

/** Fetch raw package only after live PAT and tenant/status checks. */
export async function GET(request: Request, segmentData: { params: Params }) {
  const identity = await resolveDesktopIdentity(request);
  if (!identity) return errorResponse(401, "40101", "企业登录已失效，请重新登录");
  if (!identity.scopes.includes("desktop:managed")) {
    return errorResponse(403, "40301", "当前令牌不能访问企业广场");
  }

  const { id: rawId } = await segmentData.params;
  const id = rawId.toUpperCase();
  if (!isValidConfigMarketId(id)) {
    return errorResponse(404, "40401", "configuration market item not found");
  }
  try {
    const item = await defaultConfigMarketStore.getVisible(id, marketViewer(identity));
    if (!item) return errorResponse(404, "40401", "configuration market item not found");
    return NextResponse.json(
      { code: "00000", message: "ok", data: toConfigMarketDetail(item) },
      {
        headers: {
          "Cache-Control": "private, no-store",
          "X-Config-Market-Release-Id": item.releaseId,
        },
      },
    );
  } catch (error) {
    console.error("[config-market] get failed:", error);
    return errorResponse(500, "50000", "failed to load configuration package");
  }
}
