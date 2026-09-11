import { insertAuditEvent } from "@agenticx/iam-core";
import { NextResponse } from "next/server";

import { requireAdminScope } from "../../../../../lib/admin-auth";
import {
  getConfigMarketItemDetail,
  listPublishedConfigMarketCapabilityIds,
  setConfigMarketDeliveryState,
  setConfigMarketStatus,
} from "../../../../../lib/config-market-store";
import { listCapabilityPacks } from "../../../../../lib/capability-packs-store";
import { assertManagedPortableDeliveryLimit } from "../../../../../lib/capability-pack-form";

type Params = Promise<{ id: string }>;
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

function marketId(rawId: string): string | null {
  const id = rawId.toUpperCase();
  return ULID_RE.test(id) ? id : null;
}

export async function GET(_request: Request, context: { params: Params }) {
  const auth = await requireAdminScope(["provider:read"]);
  if (!auth.ok) return auth.response;

  const { id: rawId } = await context.params;
  const id = marketId(rawId);
  if (!id) {
    return NextResponse.json({ code: "40400", message: "item not found" }, { status: 404 });
  }
  try {
    const detail = await getConfigMarketItemDetail(auth.session.tenantId, id);
    if (!detail) {
      return NextResponse.json({ code: "40400", message: "item not found" }, { status: 404 });
    }
    return NextResponse.json(
      { code: "00000", message: "ok", data: detail },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    console.error("[admin/config-market] detail failed:", error);
    return NextResponse.json(
      { code: "50000", message: "failed to load configuration market item" },
      { status: 500 },
    );
  }
}

export async function PATCH(request: Request, context: { params: Params }) {
  const auth = await requireAdminScope(["provider:update"]);
  if (!auth.ok) return auth.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ code: "40000", message: "invalid json body" }, { status: 400 });
  }
  const action =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as { action?: unknown }).action
      : null;
  if (
    action !== "unlist" &&
    action !== "restore" &&
    action !== "revoke_delivery" &&
    action !== "restore_delivery"
  ) {
    return NextResponse.json(
      { code: "40000", message: "action must be unlist, restore, revoke_delivery, or restore_delivery" },
      { status: 400 },
    );
  }

  const { id: rawId } = await context.params;
  const id = marketId(rawId);
  if (!id) {
    return NextResponse.json({ code: "40400", message: "item not found" }, { status: 404 });
  }
  try {
    if (action === "restore" || action === "restore_delivery") {
      const [detail, packs, publishedPortableIds] = await Promise.all([
        getConfigMarketItemDetail(auth.session.tenantId, id),
        listCapabilityPacks(auth.session.tenantId),
        listPublishedConfigMarketCapabilityIds(auth.session.tenantId),
      ]);
      if (!detail) {
        return NextResponse.json({ code: "40400", message: "item not found" }, { status: 404 });
      }
      // Restoring the listing does not restore a delivery that was separately
      // revoked. Restoring delivery, however, must reserve the item in the
      // managed-package limit before the state mutation is attempted.
      if (
        action === "restore_delivery" ||
        detail.item.deliveryState !== "revoked"
      ) {
        publishedPortableIds.add(detail.item.capabilityId);
      }
      assertManagedPortableDeliveryLimit(packs, publishedPortableIds);
    }
    const item = action === "revoke_delivery" || action === "restore_delivery"
      ? await setConfigMarketDeliveryState(
          auth.session.tenantId,
          id,
          action === "revoke_delivery" ? "revoked" : "active",
        )
      : await setConfigMarketStatus(
          auth.session.tenantId,
          id,
          action === "unlist" ? "unlisted" : "published",
        );
    if (!item) {
      return NextResponse.json({ code: "40400", message: "item not found" }, { status: 404 });
    }
    try {
      await insertAuditEvent({
        tenantId: auth.session.tenantId,
        actorUserId: auth.session.userId,
        eventType: `config_market.${action}`,
        targetKind: "config_market_item",
        targetId: id,
        detail: {
          kind: item.kind,
          status: item.status,
          deliveryState: item.deliveryState,
        },
      });
    } catch (auditError) {
      // 状态更新已经成功，不能因审计后写失败而返回 500 诱导管理员重复操作。
      console.error("[admin/config-market] audit failed after update:", auditError);
    }
    return NextResponse.json({ code: "00000", message: "ok", data: { item } });
  } catch (error) {
    console.error("[admin/config-market] update failed:", error);
    return NextResponse.json(
      { code: "50000", message: "failed to update configuration market" },
      { status: 500 },
    );
  }
}
