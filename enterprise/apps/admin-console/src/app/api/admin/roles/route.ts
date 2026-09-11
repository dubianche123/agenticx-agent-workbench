import {
  createCustomRole,
  deleteRole,
  duplicateRole,
  ensureSystemRoles,
  getRoleById,
  hasEveryScope,
  hasSomeScope,
  listRoles,
  updateRole,
} from "@agenticx/iam-core";
import { NextResponse } from "next/server";
import { requireAdminScope } from "../../../../lib/admin-auth";
import { scopeDisplayOptions } from "../../../../lib/iam-scope-display";
import { assertGrantable, errorEnvelope, errorStatus } from "../iam/authorization";

export async function GET() {
  const auth = await requireAdminScope(["role:read"]);
  if (!auth.ok) return auth.response;
  await ensureSystemRoles(auth.session.tenantId);
  const items = await listRoles(auth.session.tenantId);
  const actorScopes = auth.scopes;
  const grantableRoles = items.filter((role) =>
    role.scopes.length === 0 || hasEveryScope(actorScopes, role.scopes),
  );
  const canCreate = hasSomeScope(actorScopes, ["role:create"]);
  const canEdit = hasSomeScope(actorScopes, ["role:update"]);
  const canAssign = hasSomeScope(actorScopes, ["role:assign"]);
  return NextResponse.json({
    code: "00000",
    message: "ok",
    data: {
      items,
      // These are display metadata only. The server still decides every mutation.
      // Candidate metadata is conservative display data. Mutations still go
      // through assertGrantable in IAM core.
      grantableRoles,
      grantableScopes: scopeDisplayOptions(actorScopes),
      permissions: { canCreate, canEdit, canAssign },
    },
  });
}

export async function POST(request: Request) {
  const auth = await requireAdminScope(["role:create"]);
  if (!auth.ok) return auth.response;
  try {
    const body = (await request.json()) as {
      mode?: string;
      sourceId?: string;
      code?: string;
      name?: string;
      scopes?: string[];
      newCode?: string;
      newName?: string;
    };
    await ensureSystemRoles(auth.session.tenantId);
    if (body.mode === "duplicate" && body.sourceId && body.newCode && body.newName) {
      const source = await getRoleById(auth.session.tenantId, body.sourceId);
      if (!source) return NextResponse.json({ code: "40400", message: "source role not found" }, { status: 404 });
      await assertGrantable({
        tenantId: auth.session.tenantId,
        actorUserId: auth.session.userId,
        roleId: body.sourceId,
        requiredScopes: source.scopes,
      });
      const role = await duplicateRole({
        tenantId: auth.session.tenantId,
        sourceId: body.sourceId,
        newCode: body.newCode,
        newName: body.newName,
        actorUserId: auth.session.userId,
      });
      return NextResponse.json({ code: "00000", message: "ok", data: { role } });
    }
    const code = typeof body.code === "string" ? body.code : "";
    const name = typeof body.name === "string" ? body.name : "";
    const scopes = Array.isArray(body.scopes) ? body.scopes.filter((s): s is string => typeof s === "string") : [];
    await assertGrantable({
      tenantId: auth.session.tenantId,
      actorUserId: auth.session.userId,
      requiredScopes: scopes,
    });
    const role = await createCustomRole({
      tenantId: auth.session.tenantId,
      code,
      name,
      scopes,
      actorUserId: auth.session.userId,
    });
    return NextResponse.json({ code: "00000", message: "ok", data: { role } });
  } catch (error) {
    const status = errorStatus(error);
    const envelope = errorEnvelope(error);
    return NextResponse.json(
      envelope,
      { status }
    );
  }
}
