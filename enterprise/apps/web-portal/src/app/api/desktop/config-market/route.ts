import { NextResponse } from "next/server";
import { insertAuditEvent } from "@agenticx/iam-core";

import {
  ConfigShareValidationError,
  type ConfigShareKind,
} from "../../../../lib/config-share-types";
import { assertConfigMarketAudienceTargets } from "../../../../lib/config-market/audience";
import { assertConfigManifestDependenciesResolvable } from "../../../../lib/config-market/dependencies";
import {
  ConfigMarketRequestTooLargeError,
  parseConfigMarketCreateRequest,
  readConfigMarketRequestJson,
} from "../../../../lib/config-market/request";
import {
  assertConfigMarketManifestSafe,
  assertConfigMarketTextSafe,
  ConfigMarketSecurityScanError,
} from "../../../../lib/config-market/security-scan";
import {
  ConfigMarketAudienceConflictError,
  ConfigMarketCursorError,
  ConfigMarketOwnershipConflictError,
  ConfigMarketPublishBlockedError,
  ConfigMarketReleaseDigestConflictError,
  ConfigMarketReleaseVersionConflictError,
  ConfigMarketTrackStableDependencyConflictError,
  defaultConfigMarketStore,
  MAX_CONFIG_MARKET_LIST_PAGE_SIZE,
} from "../../../../lib/config-market/store";
import {
  toConfigMarketMetadata,
} from "../../../../lib/config-market/types";
import { resolveDesktopIdentity, type DesktopIdentity } from "../../../../lib/desktop-auth";
import { buildShareUrl } from "../../../../lib/share-url";

export const runtime = "nodejs";

function errorResponse(status: number, code: string, message: string) {
  return NextResponse.json({ code, message }, { status });
}

async function authenticate(request: Request): Promise<
  | { ok: true; identity: DesktopIdentity }
  | { ok: false; response: NextResponse }
> {
  const identity = await resolveDesktopIdentity(request);
  if (!identity) {
    return { ok: false, response: errorResponse(401, "40101", "企业登录已失效，请重新登录") };
  }
  if (!identity.scopes.includes("desktop:managed")) {
    return { ok: false, response: errorResponse(403, "40301", "当前令牌不能访问企业广场") };
  }
  return { ok: true, identity };
}

function marketViewer(identity: DesktopIdentity) {
  // PAT scopes are verified server-side.  Only an explicitly admin-scoped PAT may
  // inspect administrator-only submissions; request fields can never opt into this.
  return {
    ...identity,
    ...(identity.scopes.includes("*") || identity.scopes.includes("admin:enter")
      ? { isAdmin: true }
      : {}),
  };
}

/** Publish the first or next immutable release of one stable expert/team artifact. */
export async function POST(request: Request) {
  const auth = await authenticate(request);
  if (!auth.ok) return auth.response;

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
    const input = parseConfigMarketCreateRequest(body);
    assertConfigMarketManifestSafe(input.manifest);
    assertConfigMarketTextSafe(input.releaseNotes, "release_notes");
    await assertConfigManifestDependenciesResolvable(auth.identity.tenantId, input.manifest);
    await assertConfigMarketAudienceTargets(auth.identity.tenantId, input.visibility);
    const item = await defaultConfigMarketStore.create({
      tenantId: auth.identity.tenantId,
      userId: auth.identity.userId,
      ownerDisplayName: (auth.identity.displayName.trim() || auth.identity.email).slice(0, 160),
      manifest: input.manifest,
      audience: input.visibility,
      releaseNotes: input.releaseNotes,
    });
    try {
      await insertAuditEvent({
        tenantId: auth.identity.tenantId,
        actorUserId: auth.identity.userId,
        eventType: "config_market.publish",
        targetKind: "config_market_item",
        targetId: item.id,
        detail: {
          kind: item.kind,
          releaseId: item.releaseId,
          version: item.version,
          digest: item.digest,
          visibility: item.visibility,
          visibleDepartmentCount: item.visibleDepartmentIds.length,
          visibleUserCount: item.visibleUserIds.length,
        },
      });
    } catch (auditError) {
      console.error("[config-market] audit failed after publish:", auditError);
    }
    const path = `/config-market/${encodeURIComponent(item.id)}`;
    return NextResponse.json(
      {
        code: "00000",
        message: "ok",
        data: {
          item: toConfigMarketMetadata(item),
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
    if (error instanceof ConfigMarketPublishBlockedError) {
      return errorResponse(
        409,
        "40901",
        "该配置已被管理员下架；只有管理员恢复原条目后才能重新上架",
      );
    }
    if (error instanceof ConfigMarketOwnershipConflictError) {
      return errorResponse(
        409,
        "40902",
        "相同配置已由另一位员工发布；请分享现有条目，而不是覆盖其可见范围",
      );
    }
    if (error instanceof ConfigMarketAudienceConflictError) {
      return errorResponse(
        409,
        "40903",
        "你已发布过相同配置，但可见范围不同；为避免误扩范围，本次未作任何修改",
      );
    }
    if (error instanceof ConfigMarketReleaseVersionConflictError) {
      return errorResponse(409, "40904", error.message);
    }
    if (error instanceof ConfigMarketReleaseDigestConflictError) {
      return errorResponse(409, "40905", error.message);
    }
    if (error instanceof ConfigMarketTrackStableDependencyConflictError) {
      return NextResponse.json(
        {
          code: "40906",
          message: error.message,
          data: {
            missingCapabilityIds: error.missingCapabilityIds,
            packIds: error.packIds,
          },
        },
        { status: 409, headers: { "Cache-Control": "no-store" } },
      );
    }
    console.error("[config-market] publish failed:", error);
    return errorResponse(500, "50000", "failed to publish configuration package");
  }
}

/** List published metadata only. Raw manifests and system prompts are never in this response. */
export async function GET(request: Request) {
  const auth = await authenticate(request);
  if (!auth.ok) return auth.response;

  const rawKind = new URL(request.url).searchParams.get("kind");
  const url = new URL(request.url);
  const rawLimit = url.searchParams.get("limit");
  const cursor = url.searchParams.get("cursor");
  if (rawKind && rawKind !== "expert" && rawKind !== "group" && rawKind !== "skill") {
    return errorResponse(400, "40003", "kind must be expert, group, or skill");
  }
  if (rawLimit && (!/^\d+$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > MAX_CONFIG_MARKET_LIST_PAGE_SIZE)) {
    return errorResponse(400, "40005", `limit must be 1-${MAX_CONFIG_MARKET_LIST_PAGE_SIZE}`);
  }
  try {
    const page = await defaultConfigMarketStore.listVisibleMetadata(marketViewer(auth.identity), {
      kind: (rawKind || undefined) as ConfigShareKind | undefined,
      limit: rawLimit ? Number(rawLimit) : undefined,
      cursor,
    });
    return NextResponse.json(
      {
        code: "00000",
        message: "ok",
        data: { items: page.items, next_cursor: page.nextCursor },
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    if (error instanceof ConfigMarketCursorError) {
      return errorResponse(400, "40006", error.message);
    }
    console.error("[config-market] list failed:", error);
    return errorResponse(500, "50000", "failed to load configuration market");
  }
}
