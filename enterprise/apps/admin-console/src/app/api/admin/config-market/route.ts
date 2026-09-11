import { NextResponse } from "next/server";

import { requireAdminScope } from "../../../../lib/admin-auth";
import {
  AdminConfigMarketCursorError,
  listConfigMarketItemsPage,
  MAX_ADMIN_CONFIG_MARKET_PAGE_SIZE,
} from "../../../../lib/config-market-store";

export async function GET(request: Request) {
  const auth = await requireAdminScope(["provider:read"]);
  if (!auth.ok) return auth.response;
  try {
    const url = new URL(request.url);
    const rawLimit = url.searchParams.get("limit");
    if (rawLimit && (!/^\d+$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > MAX_ADMIN_CONFIG_MARKET_PAGE_SIZE)) {
      return NextResponse.json(
        { code: "40000", message: `limit must be 1-${MAX_ADMIN_CONFIG_MARKET_PAGE_SIZE}` },
        { status: 400 },
      );
    }
    const page = await listConfigMarketItemsPage(auth.session.tenantId, {
      limit: rawLimit ? Number(rawLimit) : undefined,
      cursor: url.searchParams.get("cursor"),
    });
    return NextResponse.json(
      { code: "00000", message: "ok", data: { items: page.items, next_cursor: page.nextCursor } },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    if (error instanceof AdminConfigMarketCursorError) {
      return NextResponse.json({ code: "40001", message: error.message }, { status: 400 });
    }
    console.error("[admin/config-market] list failed:", error);
    return NextResponse.json(
      { code: "50000", message: "failed to load configuration market" },
      { status: 500 },
    );
  }
}
