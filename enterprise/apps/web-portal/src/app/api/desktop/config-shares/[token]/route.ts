import { NextResponse } from "next/server";
import {
  isValidConfigShareToken,
  toPublicConfigShareSnapshot,
} from "../../../../../lib/config-share-types";
import { defaultConfigShareStore } from "../../../../../lib/config-shares/store";
import {
  resolveDesktopIdentity,
  type DesktopIdentity,
} from "../../../../../lib/desktop-auth";

export const runtime = "nodejs";

type Params = Promise<{ token: string }>;

function errorResponse(status: number, code: string, message: string) {
  return NextResponse.json({ code, message }, { status });
}

type DesktopAuthResult =
  | { ok: true; identity: DesktopIdentity }
  | { ok: false; response: NextResponse };

async function authenticatedRequest(request: Request): Promise<DesktopAuthResult> {
  const identity = await resolveDesktopIdentity(request);
  if (!identity) {
    return {
      ok: false,
      response: errorResponse(401, "40101", "企业登录已失效，请重新登录"),
    };
  }
  if (!identity.scopes.includes("desktop:managed")) {
    return {
      ok: false,
      response: errorResponse(403, "40301", "当前令牌不能读取 Desktop 配置分享"),
    };
  }
  return { ok: true, identity };
}

/** Fetch by opaque token. There is intentionally no collection/list endpoint. */
export async function GET(request: Request, segmentData: { params: Params }) {
  const auth = await authenticatedRequest(request);
  if (!auth.ok) return auth.response;

  const { token } = await segmentData.params;
  if (!isValidConfigShareToken(token)) {
    return errorResponse(404, "40401", "configuration share not found");
  }
  try {
    const snapshot = await defaultConfigShareStore.get(token, auth.identity.tenantId);
    if (!snapshot) return errorResponse(404, "40401", "configuration share not found");
    return NextResponse.json(
      {
        code: "00000",
        message: "ok",
        data: { snapshot: toPublicConfigShareSnapshot(snapshot) },
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("[config-shares] get failed:", error);
    return errorResponse(500, "50000", "failed to load configuration share");
  }
}

/** Revoke a snapshot. Only its author in the same tenant can do this. */
export async function DELETE(request: Request, segmentData: { params: Params }) {
  const auth = await authenticatedRequest(request);
  if (!auth.ok) return auth.response;

  const { token } = await segmentData.params;
  if (!isValidConfigShareToken(token)) {
    return errorResponse(404, "40401", "configuration share not found");
  }
  try {
    const revoked = await defaultConfigShareStore.revoke(
      token,
      auth.identity.tenantId,
      auth.identity.userId,
    );
    if (!revoked) return errorResponse(404, "40401", "configuration share not found");
    return NextResponse.json(
      { code: "00000", message: "ok", data: { revoked: true } },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("[config-shares] revoke failed:", error);
    return errorResponse(500, "50000", "failed to revoke configuration share");
  }
}
