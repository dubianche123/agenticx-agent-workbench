import { NextResponse } from "next/server";
import {
  configShareDownloadFileName,
  isValidConfigShareToken,
} from "../../../../../lib/config-share-types";
import { defaultConfigShareStore } from "../../../../../lib/config-shares/store";
import {
  getSessionFromCookies,
  passwordChangeRequiredResponse,
} from "../../../../../lib/session";

export const runtime = "nodejs";

type Params = Promise<{ token: string }>;

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

  const { token } = await segmentData.params;
  if (!isValidConfigShareToken(token)) {
    return NextResponse.json(
      { code: "40401", message: "configuration share not found" },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }
  try {
    const snapshot = await defaultConfigShareStore.get(token, session.tenantId);
    if (!snapshot) {
      return NextResponse.json(
        { code: "40401", message: "configuration share not found" },
        { status: 404, headers: { "Cache-Control": "no-store" } },
      );
    }
    const fileName = configShareDownloadFileName(snapshot.title, snapshot.kind);
    return new NextResponse(`${JSON.stringify(snapshot.manifest, null, 2)}\n`, {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": contentDisposition(fileName),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    console.error("[config-shares] browser download failed:", error);
    return NextResponse.json(
      { code: "50000", message: "failed to download configuration share" },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
