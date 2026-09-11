import { NextResponse } from "next/server";
import { DOCUMENT_EXTENSIONS } from "@agenticx/config";
import { insertAuditEvent } from "@agenticx/iam-core";

import { resolveDesktopIdentity } from "../../../../../lib/desktop-auth";
import { isPlatformFeatureAllowedOnSurface } from "../../../../../lib/capability-packs-reader";

function extensionOf(filename: string): string {
  const normalized = filename.trim().toLowerCase().replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  let base = slash >= 0 ? normalized.slice(slash + 1) : normalized;
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return "";

  // Desktop context-file keys may carry line, spreadsheet, or snippet
  // references after the filename.  Audit the actual extension rather than
  // recording `.pdf:3-5`/`.xlsx#Sheet1!A1` as an unknown extension.
  const referencePositions = [base.indexOf(":", dot + 1), base.indexOf("#", dot + 1)].filter(
    (index) => index >= 0,
  );
  if (referencePositions.length > 0) {
    base = base.slice(0, Math.min(...referencePositions));
  }
  const extensionDot = base.lastIndexOf(".");
  return extensionDot > 0 && extensionDot < base.length - 1
    ? base.slice(extensionDot)
    : "";
}

export async function POST(request: Request) {
  const identity = await resolveDesktopIdentity(request);
  if (!identity) {
    return NextResponse.json(
      { code: "40101", message: "企业登录已失效，请重新登录" },
      { status: 401 },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ code: "40002", message: "请求格式无效" }, { status: 400 });
  }
  const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
  const currentModel = typeof body.currentModel === "string" ? body.currentModel.trim() : "";
  const privateTarget = typeof body.privateTarget === "string" ? body.privateTarget.trim() : "";
  const attachmentNames = Array.isArray(body.attachmentNames)
    ? body.attachmentNames
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean)
        .slice(0, 64)
    : [];
  if (!sessionId || sessionId.length > 64 || !currentModel || !privateTarget) {
    return NextResponse.json(
      { code: "40002", message: "缺少会话或模型信息" },
      { status: 400 },
    );
  }

  const [routingAllowed, overrideAllowed] = await Promise.all([
    isPlatformFeatureAllowedOnSurface(
      identity.tenantId,
      "attachment_routing",
      "desktop",
      identity.userId,
      identity.email,
      identity.deptId,
    ).catch(() => false),
    isPlatformFeatureAllowedOnSurface(
      identity.tenantId,
      "attachment_public_override",
      "desktop",
      identity.userId,
      identity.email,
      identity.deptId,
    ).catch(() => false),
  ]);
  if (!routingAllowed || !overrideAllowed) {
    return NextResponse.json(
      { code: "40301", message: "当前账号没有使用公网模型处理附件的权限" },
      { status: 403 },
    );
  }

  const attachmentExtensions = [
    ...new Set(
      attachmentNames
        .map(extensionOf)
        .filter((extension) => DOCUMENT_EXTENSIONS.includes(extension)),
    ),
  ];
  try {
    await insertAuditEvent({
      tenantId: identity.tenantId,
      actorUserId: identity.userId,
      eventType: "attachment_routing.public_override",
      targetKind: "chat_session",
      targetId: sessionId,
      detail: {
        surface: "desktop",
        decision: "public",
        recommendedRoute: "private",
        privateRouteAccepted: false,
        requestedModel: currentModel.slice(0, 512),
        privateTarget: privateTarget.slice(0, 512),
        attachmentCount: attachmentNames.length,
        attachmentExtensions,
      },
    });
  } catch (error) {
    console.error("[attachment-routing] desktop public override audit failed:", error);
    return NextResponse.json(
      { code: "50302", message: "公网模型例外暂时无法记录，本轮未发送" },
      { status: 503 },
    );
  }

  return NextResponse.json({ code: "00000", message: "ok" });
}
