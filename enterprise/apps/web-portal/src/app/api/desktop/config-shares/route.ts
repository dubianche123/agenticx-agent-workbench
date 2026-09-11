import { NextResponse } from "next/server";
import {
  ConfigShareValidationError,
  parseConfigShareCreateRequest,
  toPublicConfigShareSnapshot,
} from "../../../../lib/config-share-types";
import { assertConfigManifestDependenciesResolvable } from "../../../../lib/config-market/dependencies";
import {
  assertConfigMarketManifestSafe,
  ConfigMarketSecurityScanError,
} from "../../../../lib/config-market/security-scan";
import {
  ConfigMarketRequestTooLargeError,
  readConfigMarketRequestJson,
} from "../../../../lib/config-market/request";
import { defaultConfigShareStore } from "../../../../lib/config-shares/store";
import { resolveDesktopIdentity } from "../../../../lib/desktop-auth";
import { buildShareUrl } from "../../../../lib/share-url";

export const runtime = "nodejs";

function errorResponse(status: number, code: string, message: string) {
  return NextResponse.json({ code, message }, { status });
}

/** Create one immutable, unlisted expert/group configuration snapshot. */
export async function POST(request: Request) {
  const identity = await resolveDesktopIdentity(request);
  if (!identity) {
    return errorResponse(401, "40101", "企业登录已失效，请重新登录");
  }
  if (!identity.scopes.includes("desktop:managed")) {
    return errorResponse(403, "40301", "当前令牌不能分享 Desktop 配置");
  }

  let body: unknown;
  try {
    body = await readConfigMarketRequestJson(request);
  } catch (error) {
    if (error instanceof ConfigMarketRequestTooLargeError) {
      return errorResponse(413, "41301", error.message);
    }
    return errorResponse(400, "40001", "invalid json body");
  }

  try {
    const input = parseConfigShareCreateRequest(body);
    assertConfigMarketManifestSafe(input.manifest);
    await assertConfigManifestDependenciesResolvable(identity.tenantId, input.manifest);
    const snapshot = await defaultConfigShareStore.create({
      tenantId: identity.tenantId,
      userId: identity.userId,
      ownerDisplayName: (identity.displayName.trim() || identity.email).slice(0, 160),
      kind: input.kind,
      manifestVersion: input.manifest_version,
      manifest: input.manifest,
    });
    const path = `/config-share/${encodeURIComponent(snapshot.token)}`;
    return NextResponse.json(
      {
        code: "00000",
        message: "ok",
        data: {
          snapshot: toPublicConfigShareSnapshot(snapshot),
          path,
          share_url: buildShareUrl(path, request.url),
        },
      },
      { status: 201, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof ConfigShareValidationError) {
      return errorResponse(400, "40002", error.message);
    }
    if (error instanceof ConfigMarketSecurityScanError) {
      return NextResponse.json(
        {
          code: "40004",
          message: error.message,
          data: { findings: error.findings },
        },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    }
    console.error("[config-shares] create failed:", error);
    return errorResponse(500, "50000", "failed to create configuration share");
  }
}
