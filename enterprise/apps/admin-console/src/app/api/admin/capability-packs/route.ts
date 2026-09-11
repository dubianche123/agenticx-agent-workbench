import { NextResponse } from "next/server";
import { insertAuditEvent } from "@agenticx/iam-core";
import { requireAdminScope } from "../../../../lib/admin-auth";
import { createCapabilityPack, listCapabilityPacks } from "../../../../lib/capability-packs-store";
import { assertManagedPortableDeliveryLimit } from "../../../../lib/capability-pack-form";
import { listPublishedConfigMarketCapabilityIds } from "../../../../lib/config-market-store";
import { DEFAULT_PACK_INPUT, DEFAULT_PACK_SLUG } from "../../../../lib/default-capability-pack";
import {
  MissingPortableDependenciesError,
  UnresolvablePortableDependenciesError,
} from "../../../../lib/portable-pack-dependencies";

export async function GET() {
  const auth = await requireAdminScope(["provider:read"]);
  if (!auth.ok) return auth.response;
  try {
    const packs = await ensureDefaultPack(
      auth.session.tenantId,
      await listCapabilityPacks(auth.session.tenantId),
    );
    return NextResponse.json({ code: "00000", message: "ok", data: { packs } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "failed to load capability packs";
    const hint = /enterprise_capability_packs|relation .* does not exist/i.test(message)
      ? "请先执行 pnpm --filter @agenticx/db-schema db:migrate"
      : message;
    return NextResponse.json({ code: "50000", message: hint }, { status: 500 });
  }
}

/**
 * 首次打开能力包列表时补出「基础能力」包。
 *
 * 只在一个包都没有的时候补：管理员如果把它删了，那是明确的意思表示，不该下次刷新
 * 又冒出来；已经有别的包也说明这个租户已经在用能力包管东西了，不该塞一个他没建的。
 *
 * 补失败不影响列表返回。它只是让「全员默认有搜索」这件事在界面上看得见，不是判定依据。
 */
async function ensureDefaultPack(
  tenantId: string,
  packs: Awaited<ReturnType<typeof listCapabilityPacks>>,
): Promise<typeof packs> {
  if (packs.length > 0) return packs;
  try {
    await createCapabilityPack(tenantId, {
      ...DEFAULT_PACK_INPUT,
      capabilityIds: [...DEFAULT_PACK_INPUT.capabilityIds],
      assignmentKeys: [...DEFAULT_PACK_INPUT.assignmentKeys],
    });
    return await listCapabilityPacks(tenantId);
  } catch (error) {
    console.warn(`[capability-packs] could not seed ${DEFAULT_PACK_SLUG}:`, error);
    return packs;
  }
}

export async function POST(request: Request) {
  const auth = await requireAdminScope(["provider:update"]);
  if (!auth.ok) return auth.response;
  try {
    const body = (await request.json()) as {
      slug?: string;
      displayName?: string;
      description?: string;
      status?: "active" | "disabled";
      metadata?: Record<string, unknown>;
      capabilityIds?: string[];
      portableReleasePolicies?: Record<
        string,
        { mode: "pinned" | "track_stable"; pinnedReleaseId?: string | null }
      >;
      assignmentKeys?: string[];
    };
    if (!body.slug?.trim()) {
      return NextResponse.json({ code: "40000", message: "slug required" }, { status: 400 });
    }
    const [existingPacks, publishedPortableIds] = await Promise.all([
      listCapabilityPacks(auth.session.tenantId),
      listPublishedConfigMarketCapabilityIds(auth.session.tenantId),
    ]);
    assertManagedPortableDeliveryLimit([
      ...existingPacks,
      {
        status: body.status ?? "active",
        capabilityIds: body.capabilityIds ?? [],
      },
    ], publishedPortableIds);
    const pack = await createCapabilityPack(auth.session.tenantId, {
      slug: body.slug.trim(),
      displayName: body.displayName,
      description: body.description,
      status: body.status,
      metadata: body.metadata,
      capabilityIds: body.capabilityIds,
      portableReleasePolicies: body.portableReleasePolicies,
      assignmentKeys: body.assignmentKeys,
    });
    try {
      await insertAuditEvent({
        tenantId: auth.session.tenantId,
        actorUserId: auth.session.userId,
        eventType: "capability_pack.create",
        targetKind: "capability_pack",
        targetId: pack.id,
        detail: {
          status: pack.status,
          capabilityIds: pack.capabilityIds,
          portableReleasePolicies: pack.portableReleasePolicies,
          assignmentKeys: pack.assignmentKeys,
        },
      });
    } catch (auditError) {
      console.error("[capability-packs] audit failed after create:", auditError);
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
    return NextResponse.json(
      { code: "40000", message: error instanceof Error ? error.message : "create failed" },
      { status: 400 }
    );
  }
}
