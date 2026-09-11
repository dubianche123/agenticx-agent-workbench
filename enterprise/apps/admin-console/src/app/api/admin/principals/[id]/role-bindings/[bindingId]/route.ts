import { getPrincipal, listPrincipalRoleBindings, removePrincipalRoleBinding } from "@agenticx/iam-core";
import { NextResponse } from "next/server";
import { requireAdminScopedCapability } from "../../../../../../../lib/admin-auth";
import { errorEnvelope, errorStatus } from "../../../../iam/authorization";

export async function DELETE(_request: Request, context: { params: Promise<{ id: string; bindingId: string }> }) {
  const auth = await requireAdminScopedCapability(["role:assign"]);
  if (!auth.ok) return auth.response;
  const { id, bindingId } = await context.params;
  try {
    const principal = await getPrincipal(auth.session.tenantId, id);
    if (!principal) return NextResponse.json({ code: "40400", message: "principal not found" }, { status: 404 });
    const binding = (await listPrincipalRoleBindings(auth.session.tenantId, id)).find((item) => item.id === bindingId);
    if (!binding) return NextResponse.json({ code: "40400", message: "role binding not found" }, { status: 404 });
    // removePrincipalRoleBinding runs the cleanup guard and carries its
    // actor freshness snapshot into the locked transaction.
    await removePrincipalRoleBinding({
      tenantId: auth.session.tenantId,
      bindingId,
      actorUserId: auth.session.userId,
    });
    return NextResponse.json({ code: "00000", message: "ok", data: { bindingId } });
  } catch (error) {
    return NextResponse.json(errorEnvelope(error), { status: errorStatus(error) });
  }
}
