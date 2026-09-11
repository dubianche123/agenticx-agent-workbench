import { NextResponse } from "next/server";
import { insertAuditEvent } from "@agenticx/iam-core";
import { requireAdminScope } from "../../../../../lib/admin-auth";
import {
  deleteCapabilityPack,
  getCapabilityPack,
  listCapabilityPacks,
  updateCapabilityPack,
} from "../../../../../lib/capability-packs-store";
import { assertManagedPortableDeliveryLimit } from "../../../../../lib/capability-pack-form";
import {
  CAPABILITY_PACK_CONFLICT_CODE,
  CAPABILITY_PACK_CONFLICT_MESSAGE,
  CapabilityPackVersionConflictError,
  capabilityPackVersion,
} from "../../../../../lib/capability-pack-concurrency";
import { listPublishedConfigMarketCapabilityIds } from "../../../../../lib/config-market-store";
import {
  MissingPortableDependenciesError,
  UnresolvablePortableDependenciesError,
} from "../../../../../lib/portable-pack-dependencies";

export async function GET(_req: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireAdminScope(["provider:read"]);
  if (!auth.ok) return auth.response;
  const { id } = await context.params;
  const pack = await getCapabilityPack(auth.session.tenantId, id);
  if (!pack) return NextResponse.json({ code: "40400", message: "pack not found" }, { status: 404 });
  return NextResponse.json({ code: "00000", message: "ok", data: { pack } });
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireAdminScope(["provider:update"]);
  if (!auth.ok) return auth.response;
  const { id } = await context.params;
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const expectedUpdatedAt = capabilityPackVersion(body.expectedUpdatedAt).toISOString();
    const before = await getCapabilityPack(auth.session.tenantId, id);
    if (!before) throw new Error("pack not found");
    const status = body.status === "active" || body.status === "disabled" ? body.status : undefined;
    const capabilityIds = Array.isArray(body.capabilityIds)
      ? (body.capabilityIds as string[])
      : undefined;
    const portableReleasePolicies =
      body.portableReleasePolicies &&
      typeof body.portableReleasePolicies === "object" &&
      !Array.isArray(body.portableReleasePolicies)
        ? (body.portableReleasePolicies as Record<
            string,
            { mode: "pinned" | "track_stable"; pinnedReleaseId?: string | null }
          >)
        : undefined;
    if (status !== undefined || capabilityIds !== undefined) {
      const [packs, publishedPortableIds] = await Promise.all([
        listCapabilityPacks(auth.session.tenantId),
        listPublishedConfigMarketCapabilityIds(auth.session.tenantId),
      ]);
      assertManagedPortableDeliveryLimit([
        ...packs.filter((pack) => pack.id !== id),
        {
          status: status ?? before.status,
          capabilityIds: capabilityIds ?? before.capabilityIds,
        },
      ], publishedPortableIds);
    }
    const pack = await updateCapabilityPack(auth.session.tenantId, id, {
      expectedUpdatedAt,
      displayName: typeof body.displayName === "string" ? body.displayName : undefined,
      description: typeof body.description === "string" ? body.description : undefined,
      status,
      metadata:
        body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)
          ? (body.metadata as Record<string, unknown>)
          : undefined,
      capabilityIds,
      portableReleasePolicies,
      assignmentKeys: Array.isArray(body.assignmentKeys) ? (body.assignmentKeys as string[]) : undefined,
    });
    try {
      await insertAuditEvent({
        tenantId: auth.session.tenantId,
        actorUserId: auth.session.userId,
        eventType: "capability_pack.update",
        targetKind: "capability_pack",
        targetId: id,
        detail: {
          before: {
            status: before.status,
            capabilityIds: before.capabilityIds,
            portableReleasePolicies: before.portableReleasePolicies,
            assignmentKeys: before.assignmentKeys,
          },
          after: {
            status: pack.status,
            capabilityIds: pack.capabilityIds,
            portableReleasePolicies: pack.portableReleasePolicies,
            assignmentKeys: pack.assignmentKeys,
          },
        },
      });
    } catch (auditError) {
      console.error("[capability-packs] audit failed after update:", auditError);
    }
    return NextResponse.json({ code: "00000", message: "ok", data: { pack } });
  } catch (error) {
    if (error instanceof MissingPortableDependenciesError) {
      return NextResponse.json(
        {
          code: "40002",
          message: error.message,
          data: { missingCapabilityIds: error.missingCapabilityIds },
        },
        { status: 400 },
      );
    }
    if (error instanceof UnresolvablePortableDependenciesError) {
      return NextResponse.json(
        {
          code: "40003",
          message: error.message,
          data: { dependencyCapabilityIds: error.dependencyCapabilityIds },
        },
        { status: 400 },
      );
    }
    if (error instanceof CapabilityPackVersionConflictError) {
      return NextResponse.json(
        {
          code: CAPABILITY_PACK_CONFLICT_CODE,
          message: CAPABILITY_PACK_CONFLICT_MESSAGE,
        },
        { status: 409 },
      );
    }
    const message = error instanceof Error ? error.message : "update failed";
    const status = message === "pack not found" ? 404 : 400;
    return NextResponse.json({ code: status === 404 ? "40400" : "40000", message }, { status });
  }
}

export async function DELETE(_req: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireAdminScope(["provider:update"]);
  if (!auth.ok) return auth.response;
  const { id } = await context.params;
  const before = await getCapabilityPack(auth.session.tenantId, id);
  if (!before) {
    return NextResponse.json({ code: "40400", message: "pack not found" }, { status: 404 });
  }
  const removed = await deleteCapabilityPack(auth.session.tenantId, id);
  if (!removed) return NextResponse.json({ code: "40400", message: "pack not found" }, { status: 404 });
  try {
    await insertAuditEvent({
      tenantId: auth.session.tenantId,
      actorUserId: auth.session.userId,
      eventType: "capability_pack.delete",
      targetKind: "capability_pack",
      targetId: id,
      detail: {
        status: before.status,
        capabilityIds: before.capabilityIds,
        assignmentKeys: before.assignmentKeys,
      },
    });
  } catch (auditError) {
    console.error("[capability-packs] audit failed after delete:", auditError);
  }
  return NextResponse.json({ code: "00000", message: "ok", data: { id } });
}
