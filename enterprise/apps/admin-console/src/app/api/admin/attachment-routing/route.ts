import { insertAuditEvent } from "@agenticx/iam-core";
import { NextResponse } from "next/server";

import { requireAdminScope } from "../../../../lib/admin-auth";
import {
  getAttachmentRoutingTenantConfig,
  setAttachmentRoutingTenantConfig,
} from "../../../../../../web-portal/src/lib/attachment-routing-config";

export async function GET() {
  const auth = await requireAdminScope(["provider:read"]);
  if (!auth.ok) return auth.response;
  try {
    const data = await getAttachmentRoutingTenantConfig(auth.session.tenantId);
    return NextResponse.json({ code: "00000", message: "ok", data });
  } catch (error) {
    return NextResponse.json(
      {
        code: "50301",
        message: error instanceof Error ? error.message : "附件路由配置不可用",
      },
      { status: 503 },
    );
  }
}

export async function PUT(request: Request) {
  const auth = await requireAdminScope(["provider:update"]);
  if (!auth.ok) return auth.response;
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ code: "40002", message: "请求格式无效" }, { status: 400 });
  }
  if (typeof body.allowPublicOverride !== "boolean") {
    return NextResponse.json(
      { code: "40002", message: "allowPublicOverride 必须是布尔值" },
      { status: 400 },
    );
  }
  try {
    const before = await getAttachmentRoutingTenantConfig(auth.session.tenantId);
    if (before.allowPublicOverride === body.allowPublicOverride) {
      return NextResponse.json({ code: "00000", message: "ok", data: before });
    }

    const data = await setAttachmentRoutingTenantConfig(auth.session.tenantId, {
      allowPublicOverride: body.allowPublicOverride,
    });
    try {
      await insertAuditEvent({
        tenantId: auth.session.tenantId,
        actorUserId: auth.session.userId,
        eventType: "attachment_routing.update",
        targetKind: "attachment_routing_config",
        targetId: auth.session.tenantId,
        detail: {
          before: { allowPublicOverride: before.allowPublicOverride },
          after: { allowPublicOverride: data.allowPublicOverride },
        },
      });
    } catch (auditError) {
      // 配置已经成功，不能因审计后写失败而返回 500 诱导管理员重复操作。
      console.error("[admin/attachment-routing] audit failed after update:", auditError);
    }
    return NextResponse.json({ code: "00000", message: "ok", data });
  } catch (error) {
    return NextResponse.json(
      {
        code: "50301",
        message: error instanceof Error ? error.message : "附件路由配置保存失败",
      },
      { status: 503 },
    );
  }
}
