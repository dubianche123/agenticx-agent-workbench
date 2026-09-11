import {
  getDepartmentsRepository,
  getRoleById,
  listPrincipalRoleBindingsForRole,
  listPrincipals,
  listUsersForRole,
} from "@agenticx/iam-core";
import { NextResponse } from "next/server";
import { requireAdminScope } from "../../../../../../lib/admin-auth";
import { errorEnvelope, errorStatus } from "../../../iam/authorization";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireAdminScope(["role:read"]);
  if (!auth.ok) return auth.response;
  const { id } = await context.params;
  try {
    const role = await getRoleById(auth.session.tenantId, id);
    if (!role) return NextResponse.json({ code: "40400", message: "not found" }, { status: 404 });
    const [usersRaw, bindingRows, departments] = await Promise.all([
      listUsersForRole(auth.session.tenantId, id),
      listPrincipalRoleBindingsForRole(auth.session.tenantId, id),
      getDepartmentsRepository().listDepartmentsFlat(auth.session.tenantId),
    ]);
    const principalIds = [...new Set(bindingRows.map((binding) => binding.principalId))];
    const principals = principalIds.length
      ? await listPrincipals(auth.session.tenantId, { principalIds })
      : [];
    const principalById = new Map(principals.map((principal) => [principal.id, principal]));
    const departmentById = new Map(departments.map((department) => [department.id, department]));
    const bindings = bindingRows.map((binding) => ({
      principal: principalById.get(binding.principalId) ?? null,
      binding: {
        ...binding,
        roleName: role.name,
        scopeName: binding.scopeDeptId ? departmentById.get(binding.scopeDeptId)?.name ?? null : null,
      },
    }));
    const users = usersRaw.map((user) => ({ id: user.userId, email: user.email, displayName: user.displayName }));
    const agents = bindings
      .filter(({ principal }) => principal?.kind === "agent")
      .map(({ principal, binding }) => ({
        id: principal!.id,
        principalId: principal!.id,
        displayName: principal!.displayName,
        mode: principal!.agentProfile?.mode,
        ownerUserId: principal!.agentProfile?.ownerUserId ?? null,
        status: principal!.status,
        binding,
      }));
    return NextResponse.json({ code: "00000", message: "ok", data: { role, users, agents, bindings } });
  } catch (error) {
    return NextResponse.json(errorEnvelope(error), { status: errorStatus(error) });
  }
}
