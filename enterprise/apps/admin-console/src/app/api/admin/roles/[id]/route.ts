import { deleteRole, updateRole } from "@agenticx/iam-core";
import { NextResponse } from "next/server";
import { requireAdminScope } from "../../../../../lib/admin-auth";
import { assertGrantable, errorEnvelope, errorStatus } from "../../iam/authorization";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireAdminScope(["role:update"]);
  if (!auth.ok) return auth.response;
  const { id } = await context.params;
  try {
    const body = (await request.json()) as { name?: string; scopes?: string[] };
    const scopes = Array.isArray(body.scopes) ? body.scopes.filter((s): s is string => typeof s === "string") : undefined;
    await assertGrantable({
      tenantId: auth.session.tenantId,
      actorUserId: auth.session.userId,
      roleId: id,
      requiredScopes: scopes,
    });
    const role = await updateRole({
      tenantId: auth.session.tenantId,
      id,
      name: body.name,
      scopes,
      actorUserId: auth.session.userId,
    });
    return NextResponse.json({ code: "00000", message: "ok", data: { role } });
  } catch (error) {
    return NextResponse.json(errorEnvelope(error), { status: errorStatus(error) });
  }
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireAdminScope(["role:delete"]);
  if (!auth.ok) return auth.response;
  const { id } = await context.params;
  try {
    await assertGrantable({
      tenantId: auth.session.tenantId,
      actorUserId: auth.session.userId,
      roleId: id,
    });
    await deleteRole({ tenantId: auth.session.tenantId, id, actorUserId: auth.session.userId });
    return NextResponse.json({ code: "00000", message: "ok", data: { roleId: id } });
  } catch (error) {
    return NextResponse.json(errorEnvelope(error), { status: errorStatus(error) });
  }
}
