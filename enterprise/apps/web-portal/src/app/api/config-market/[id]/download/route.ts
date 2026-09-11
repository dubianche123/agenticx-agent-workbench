import { NextResponse } from "next/server";

import { configShareDownloadFileName } from "../../../../../lib/config-share-types";
import { defaultConfigMarketStore } from "../../../../../lib/config-market/store";
import { isValidConfigMarketId } from "../../../../../lib/config-market/types";
import { resolveLiveConfigMarketViewer } from "../../../../../lib/config-market/visibility";
import {
  getSessionFromCookies,
  passwordChangeRequiredResponse,
} from "../../../../../lib/session";

export const runtime = "nodejs";
type Params = Promise<{ id: string }>;

function contentDisposition(fileName: string): string {
  const encoded = encodeURIComponent(fileName).replace(/['()]/g, escape);
  return `attachment; filename="agenticx-config.json"; filename*=UTF-8''${encoded}`;
}

export async function GET(_request: Request, segmentData: { params: Params }) {
  const session = await getSessionFromCookies();
  if (session?.mustChangePassword) return passwordChangeRequiredResponse();
  if (!session) {
    return NextResponse.json(
      { code: "40101", message: "unauthorized" },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }
  const viewer = await resolveLiveConfigMarketViewer(session);
  if (!viewer) {
    return NextResponse.json(
      { code: "40401", message: "configuration market item not found" },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }

  const { id: rawId } = await segmentData.params;
  const id = rawId.toUpperCase();
  if (!isValidConfigMarketId(id)) {
    return NextResponse.json(
      { code: "40401", message: "configuration market item not found" },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }
  try {
    const item = await defaultConfigMarketStore.getVisible(id, viewer);
    if (!item) {
      return NextResponse.json(
        { code: "40401", message: "configuration market item not found" },
        { status: 404, headers: { "Cache-Control": "no-store" } },
      );
    }
    const fileName = configShareDownloadFileName(item.title, item.kind);
    return new NextResponse(`${JSON.stringify(item.raw, null, 2)}\n`, {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": contentDisposition(fileName),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "X-Config-Market-Release-Id": item.releaseId,
      },
    });
  } catch (error) {
    console.error("[config-market] browser download failed:", error);
    return NextResponse.json(
      { code: "50000", message: "failed to download configuration package" },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
