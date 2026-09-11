import { insertAuditEvent } from "@agenticx/iam-core";
import { NextResponse } from "next/server";

import { requireAdminScope } from "../../../../lib/admin-auth";
import {
  addCapabilityToShelf,
  CapabilityShelfMembershipValidationError,
  CapabilityShelfOrderValidationError,
  getCapabilityShelfOrder,
  MAX_CAPABILITY_SHELF_ITEMS,
  normalizeCapabilityShelfOrder,
  removeCapabilityFromShelf,
  replaceCapabilityShelfOrder,
} from "../../../../lib/capability-shelf-order-store";

type CapabilityShelfOrderBody = { capabilityIds?: unknown };
type CapabilityShelfMembershipBody = { capabilityId?: unknown };

function badRequest(message: string): NextResponse {
  return NextResponse.json({ code: "40000", message }, { status: 400 });
}

function parseCapabilityIds(body: unknown): string[] {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new CapabilityShelfOrderValidationError("request body must be an object");
  }
  const capabilityIds = (body as CapabilityShelfOrderBody).capabilityIds;
  if (!Array.isArray(capabilityIds)) {
    throw new CapabilityShelfOrderValidationError("capabilityIds must be an array");
  }
  if (capabilityIds.length > MAX_CAPABILITY_SHELF_ITEMS) {
    throw new CapabilityShelfOrderValidationError(
      `capabilityIds must contain at most ${MAX_CAPABILITY_SHELF_ITEMS} items`,
    );
  }
  return normalizeCapabilityShelfOrder(capabilityIds);
}

function parseCapabilityId(body: unknown): string {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new CapabilityShelfOrderValidationError("request body must be an object");
  }
  const capabilityId = (body as CapabilityShelfMembershipBody).capabilityId;
  if (typeof capabilityId !== "string") {
    throw new CapabilityShelfOrderValidationError("capabilityId must be a string");
  }
  const [normalized] = normalizeCapabilityShelfOrder([capabilityId]);
  if (!normalized) throw new CapabilityShelfOrderValidationError("capabilityId is required");
  return normalized;
}

function changed(before: readonly string[], after: readonly string[]): boolean {
  return before.length !== after.length || before.some((id, index) => id !== after[index]);
}

async function auditShelfMembership(
  tenantId: string,
  actorUserId: string,
  eventType: "capability_shelf.add" | "capability_shelf.remove",
  capabilityId: string,
  before: readonly string[],
  after: readonly string[],
): Promise<void> {
  if (!changed(before, after)) return;
  try {
    await insertAuditEvent({
      tenantId,
      actorUserId,
      eventType,
      targetKind: "capability_shelf_order",
      targetId: tenantId,
      detail: { capabilityId, before, after },
    });
  } catch (auditError) {
    console.error(`[admin/capability-shelf-order] audit failed after ${eventType}:`, auditError);
  }
}

export async function GET() {
  const auth = await requireAdminScope(["provider:read"]);
  if (!auth.ok) return auth.response;
  try {
    const orderedCapabilityIds = await getCapabilityShelfOrder(auth.session.tenantId);
    return NextResponse.json(
      { code: "00000", message: "ok", data: { orderedCapabilityIds } },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    console.error("[admin/capability-shelf-order] load failed:", error);
    return NextResponse.json(
      { code: "50000", message: "failed to load capability shelf order" },
      { status: 500 },
    );
  }
}

export async function PUT(request: Request) {
  const auth = await requireAdminScope(["provider:update"]);
  if (!auth.ok) return auth.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest("request body must be valid JSON");
  }

  try {
    const capabilityIds = parseCapabilityIds(body);
    const result = await replaceCapabilityShelfOrder(auth.session.tenantId, capabilityIds);
    try {
      await insertAuditEvent({
        tenantId: auth.session.tenantId,
        actorUserId: auth.session.userId,
        eventType: "capability_shelf.reorder",
        targetKind: "capability_shelf_order",
        targetId: auth.session.tenantId,
        detail: {
          before: result.previousCapabilityIds,
          after: result.orderedCapabilityIds,
        },
      });
    } catch (auditError) {
      console.error("[admin/capability-shelf-order] audit failed after reorder:", auditError);
    }
    return NextResponse.json(
      {
        code: "00000",
        message: "ok",
        data: { orderedCapabilityIds: result.orderedCapabilityIds },
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    if (error instanceof CapabilityShelfOrderValidationError) {
      return badRequest(error.message);
    }
    console.error("[admin/capability-shelf-order] reorder failed:", error);
    return NextResponse.json(
      { code: "50000", message: "failed to persist capability shelf order" },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  const auth = await requireAdminScope(["provider:update"]);
  if (!auth.ok) return auth.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest("request body must be valid JSON");
  }

  try {
    const capabilityId = parseCapabilityId(body);
    const result = await addCapabilityToShelf(auth.session.tenantId, capabilityId);
    await auditShelfMembership(
      auth.session.tenantId,
      auth.session.userId,
      "capability_shelf.add",
      result.capabilityId,
      result.previousCapabilityIds,
      result.orderedCapabilityIds,
    );
    return NextResponse.json(
      {
        code: "00000",
        message: "ok",
        data: { orderedCapabilityIds: result.orderedCapabilityIds },
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    if (
      error instanceof CapabilityShelfOrderValidationError ||
      error instanceof CapabilityShelfMembershipValidationError
    ) {
      return badRequest(error.message);
    }
    console.error("[admin/capability-shelf-order] add failed:", error);
    return NextResponse.json(
      { code: "50000", message: "failed to add capability to shelf" },
      { status: 500 },
    );
  }
}

export async function DELETE(request: Request) {
  const auth = await requireAdminScope(["provider:update"]);
  if (!auth.ok) return auth.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    // Supporting a query parameter makes this endpoint usable by clients that do not send a
    // body with DELETE, while the documented form remains `{ capabilityId }` JSON.
    const capabilityId = new URL(request.url).searchParams.get("capabilityId");
    body = capabilityId === null ? null : { capabilityId };
  }

  try {
    const capabilityId = parseCapabilityId(body);
    const result = await removeCapabilityFromShelf(auth.session.tenantId, capabilityId);
    await auditShelfMembership(
      auth.session.tenantId,
      auth.session.userId,
      "capability_shelf.remove",
      result.capabilityId,
      result.previousCapabilityIds,
      result.orderedCapabilityIds,
    );
    return NextResponse.json(
      {
        code: "00000",
        message: "ok",
        data: { orderedCapabilityIds: result.orderedCapabilityIds },
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    if (
      error instanceof CapabilityShelfOrderValidationError ||
      error instanceof CapabilityShelfMembershipValidationError
    ) {
      return badRequest(error.message);
    }
    console.error("[admin/capability-shelf-order] remove failed:", error);
    return NextResponse.json(
      { code: "50000", message: "failed to remove capability from shelf" },
      { status: 500 },
    );
  }
}
