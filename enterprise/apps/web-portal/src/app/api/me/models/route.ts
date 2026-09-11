import { NextResponse } from "next/server";
import { getSessionFromCookies, passwordChangeRequiredResponse } from "../../../../lib/session";
import { listAvailableModelsForUser } from "../../../../lib/admin-providers-reader";
import { isPlatformFeatureAllowedOnSurface } from "../../../../lib/capability-packs-reader";
import { buildAttachmentRoutingPolicy } from "../../../../lib/attachment-routing-policy";

export async function GET() {
  const session = await getSessionFromCookies();
  if (session?.mustChangePassword) {
    return passwordChangeRequiredResponse();
  }
  if (!session) {
    return NextResponse.json(
      { error: { code: "40101", message: "unauthorized" } },
      { status: 401 }
    );
  }
  const [models, attachmentRoutingAllowed, publicOverrideAllowed] =
    await Promise.all([
      listAvailableModelsForUser(
        session.userId,
        session.email,
        session.deptId ?? undefined,
      ),
      isPlatformFeatureAllowedOnSurface(
        session.tenantId,
        "attachment_routing",
        "web",
        session.userId,
        session.email,
        session.deptId,
      ).catch(() => false),
      isPlatformFeatureAllowedOnSurface(
        session.tenantId,
        "attachment_public_override",
        "web",
        session.userId,
        session.email,
        session.deptId,
      ).catch(() => false),
    ]);
  const attachmentRouting = buildAttachmentRoutingPolicy(models, {
    enabled: attachmentRoutingAllowed,
    allowPublicOverride: publicOverrideAllowed,
  });
  return NextResponse.json({
    code: "00000",
    message: "ok",
    data: { models, attachmentRouting },
  });
}
