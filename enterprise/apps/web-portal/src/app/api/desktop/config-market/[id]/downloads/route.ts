import { NextResponse } from "next/server";

import {
  defaultConfigMarketStore,
} from "../../../../../../lib/config-market/store";
import { parseConfigMarketDownloadRequest } from "../../../../../../lib/config-market/download";
import { isValidConfigMarketId } from "../../../../../../lib/config-market/types";
import { resolveDesktopIdentity, type DesktopIdentity } from "../../../../../../lib/desktop-auth";

export const runtime = "nodejs";

type Params = Promise<{ id: string }>;

function errorResponse(status: number, code: string, message: string) {
  return NextResponse.json(
    { code, message },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

function marketViewer(identity: DesktopIdentity) {
  return {
    ...identity,
    ...(identity.scopes.includes("*") || identity.scopes.includes("admin:enter")
      ? { isAdmin: true }
      : {}),
  };
}

/** Record one successful Desktop download/import for an immutable release. */
export async function POST(request: Request, segmentData: { params: Params }) {
  const identity = await resolveDesktopIdentity(request);
  if (!identity) return errorResponse(401, "40101", "企业登录已失效，请重新登录");
  if (!identity.scopes.includes("desktop:managed")) {
    return errorResponse(403, "40301", "当前令牌不能访问企业广场");
  }

  const { id: rawId } = await segmentData.params;
  const id = rawId.trim().toUpperCase();
  if (!isValidConfigMarketId(id)) {
    return errorResponse(404, "40401", "configuration market item not found");
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, "40001", "invalid json body");
  }
  const input = parseConfigMarketDownloadRequest(body);
  if (!input) return errorResponse(400, "40001", "body must contain only releaseId");

  try {
    const result = await defaultConfigMarketStore.recordDownload(
      id,
      marketViewer(identity),
      input.releaseId,
    );
    if (!result) return errorResponse(404, "40401", "configuration market item not found");
    return NextResponse.json(
      { code: "00000", message: "ok", data: result },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("[config-market] desktop download report failed:", error);
    return errorResponse(500, "50000", "failed to record configuration package download");
  }
}
