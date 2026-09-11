import { resetUserPassword } from "@agenticx/iam-core";
import { NextResponse } from "next/server";
import { requireAdminScopedCapability, requireAdminTarget } from "../../../../../../lib/admin-auth";
import { errorEnvelope, errorStatus } from "../../../iam/authorization";

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireAdminScopedCapability(["user:update"]);
  if (!auth.ok) return auth.response;
  const { id } = await context.params;
  try {
    const targetAuth = await requireAdminTarget(["user:update"], { kind: "user", id });
    if (!targetAuth.ok) return targetAuth.response;
    const { initialPassword } = await resetUserPassword({
      tenantId: auth.session.tenantId,
      userId: id,
      actorUserId: auth.session.userId,
    });
    return NextResponse.json({
      code: "00000",
      message: "ok",
      data: { initialPassword },
    });
  } catch (error) {
    return NextResponse.json(errorEnvelope(error), { status: errorStatus(error) });
  }
}
