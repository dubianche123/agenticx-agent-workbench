import { NextResponse } from "next/server";

import { parseConfigMarketDownloadRequest } from "../../../../../lib/config-market/download";
import { defaultConfigMarketStore } from "../../../../../lib/config-market/store";
import { isValidConfigMarketId } from "../../../../../lib/config-market/types";
import { resolveLiveConfigMarketViewer } from "../../../../../lib/config-market/visibility";
import {
  getSessionFromCookies,
  passwordChangeRequiredResponse,
} from "../../../../../lib/session";

export const runtime = "nodejs";

type Params = Promise<{ id: string }>;

function errorResponse(status: number, code: string, message: string) {
  return NextResponse.json(
    { code, message },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

/** Record one successful browser download/import for an immutable release. */
export async function POST(request: Request, segmentData: { params: Params }) {
  const session = await getSessionFromCookies();
  if (session?.mustChangePassword) return passwordChangeRequiredResponse();
  if (!session) return errorResponse(401, "40101", "unauthorized");

  const viewer = await resolveLiveConfigMarketViewer(session);
  if (!viewer) return errorResponse(401, "40101", "unauthorized");

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
    const result = await defaultConfigMarketStore.recordDownload(id, viewer, input.releaseId);
    if (!result) return errorResponse(404, "40401", "configuration market item not found");
    return NextResponse.json(
      { code: "00000", message: "ok", data: result },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("[config-market] browser download report failed:", error);
    return errorResponse(500, "50000", "failed to record configuration package download");
  }
}
