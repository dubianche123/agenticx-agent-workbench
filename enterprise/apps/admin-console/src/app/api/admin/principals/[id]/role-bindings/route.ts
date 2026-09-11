import {
  getDepartmentsRepository,
  getGrantableRoleOptions,
  getPrincipal,
  hasSomeScope,
  listPrincipalRoleBindings,
  listRoles,
  assignPrincipalRoleBinding,
} from "@agenticx/iam-core";
import type { DataScope, PrincipalDto, PrincipalRoleBindingDto } from "@agenticx/iam-core";
import { NextResponse } from "next/server";
import {
  requireAdminSomeScopedCapability,
  requireAdminScopedCapability,
  requireAdminTarget,
} from "../../../../../../lib/admin-auth";
import { assertGrantable, errorEnvelope, errorStatus } from "../../../iam/authorization";

const DATA_SCOPE_VALUES: readonly DataScope[] = ["self", "department", "department_subtree", "tenant"];
const DATA_SCOPE_OPTIONS = [
  { value: "self", label: "本人", labelEn: "Self", description: "仅主体自身", descriptionEn: "The principal itself" },
  { value: "department", label: "部门", labelEn: "Department", description: "直属部门成员", descriptionEn: "Members of one department" },
  { value: "department_subtree", label: "部门及下属", labelEn: "Department subtree", description: "部门与所有下属部门", descriptionEn: "A department and its descendants" },
  { value: "tenant", label: "企业", labelEn: "Enterprise", description: "整个企业", descriptionEn: "The whole tenant" },
] as const;

function targetForPrincipal(principal: PrincipalDto): { kind: "user" | "agent"; id: string } {
  if (principal.kind === "user") {
    if (!principal.userId) throw new Error("user principal is missing backing user");
    return { kind: "user", id: principal.userId };
  }
  return { kind: "agent", id: principal.id };
}

function parseDataScope(value: unknown): value is DataScope {
  return typeof value === "string" && DATA_SCOPE_VALUES.includes(value as DataScope);
}

function parseExpiry(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string" || !value.trim()) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) || date.getTime() <= Date.now() ? undefined : date.toISOString();
}

async function decorateBindings(tenantId: string, bindings: PrincipalRoleBindingDto[]) {
  if (!bindings.length) return bindings;
  const [roles, departments] = await Promise.all([
    listRoles(tenantId),
    getDepartmentsRepository().listDepartmentsFlat(tenantId),
  ]);
  const roleById = new Map(roles.map((role) => [role.id, role]));
  const departmentById = new Map(departments.map((department) => [department.id, department]));
  return bindings.map((binding) => ({
    ...binding,
    roleName: roleById.get(binding.roleId)?.name ?? binding.roleCode,
    scopeName: binding.scopeDeptId ? departmentById.get(binding.scopeDeptId)?.name ?? null : null,
  }));
}

async function grantableScopes(
  principal: PrincipalDto,
  auth: { session: { tenantId: string; userId: string }; context: { effectivePermissions: Array<{ scope: string; dataScope: DataScope; resolution: string }> } },
) {
  const roleAssignPermissions = auth.context.effectivePermissions.filter(
    (permission) => permission.scope === "role:assign" && permission.resolution === "resolved",
  );
  if (!roleAssignPermissions.length) return [];
  const serviceAgent = principal.kind === "agent" && principal.agentProfile?.mode === "service";
  const values = new Set<DataScope>();
  if (roleAssignPermissions.some((permission) => permission.dataScope === "tenant")) {
    for (const option of DATA_SCOPE_OPTIONS) values.add(option.value);
  } else {
    if (!serviceAgent) {
      try {
        await assertGrantable({
          tenantId: auth.session.tenantId,
          actorUserId: auth.session.userId,
          targetPrincipalId: principal.id,
          requiredScopes: ["role:assign"],
          dataScope: "self",
        });
        values.add("self");
      } catch {
        // The range list is advisory. The POST guard remains authoritative.
      }
    }
    for (const permission of roleAssignPermissions) {
      if (permission.dataScope === "department") values.add("department");
      if (permission.dataScope === "department_subtree") values.add("department_subtree");
    }
  }
  return DATA_SCOPE_OPTIONS.filter((option) => values.has(option.value));
}

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireAdminSomeScopedCapability(["user:read", "agent:read", "role:read", "role:assign"]);
  if (!auth.ok) return auth.response;
  const { id } = await context.params;
  try {
    const principal = await getPrincipal(auth.session.tenantId, id);
    if (!principal) return NextResponse.json({ code: "40400", message: "principal not found" }, { status: 404 });
    const readScope = principal.kind === "user" ? "user:read" : "agent:read";
    const targetAuth = await requireAdminTarget([readScope], targetForPrincipal(principal));
    if (!targetAuth.ok) return targetAuth.response;
    const roleScope = hasSomeScope(auth.scopes, ["role:assign"])
      ? "role:assign"
      : hasSomeScope(auth.scopes, ["role:read"])
        ? "role:read"
        : null;
    if (!roleScope) return NextResponse.json({ code: "40300", message: "role metadata requires role:read or role:assign" }, { status: 403 });
    const roleTargetAuth = await requireAdminTarget([roleScope], targetForPrincipal(principal));
    if (!roleTargetAuth.ok) return roleTargetAuth.response;
    const bindings = await listPrincipalRoleBindings(auth.session.tenantId, id);
    const roleDefinitions = roleScope === "role:assign" ? await listRoles(auth.session.tenantId) : [];
    const roleById = new Map(roleDefinitions.map((role) => [role.id, role]));
    const hasTenantRoleAssign = auth.context.effectivePermissions.some(
      (permission) => permission.scope === "role:assign" && permission.resolution === "resolved" && permission.dataScope === "tenant",
    );
    const roles = roleScope === "role:assign"
      ? (await getGrantableRoleOptions({
        tenantId: auth.session.tenantId,
        actorUserId: auth.session.userId,
        targetPrincipalId: id,
        ...(hasTenantRoleAssign ? {} : {
          dataScope: principal.kind === "agent" && principal.agentProfile?.mode === "service" ? "tenant" : "self",
        }),
      })).filter((role) => role.grantable).map((role) => ({
        ...role,
        name: roleById.get(role.id)?.name ?? role.code,
      }))
      : [];
    return NextResponse.json({
      code: "00000",
      message: "ok",
      data: {
        bindings: await decorateBindings(auth.session.tenantId, bindings),
        grantableRoles: roles,
        grantableScopes: await grantableScopes(principal, auth),
        permissions: { canAssign: roleScope === "role:assign" },
      },
    });
  } catch (error) {
    return NextResponse.json(errorEnvelope(error), { status: errorStatus(error) });
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireAdminScopedCapability(["role:assign"]);
  if (!auth.ok) return auth.response;
  const { id } = await context.params;
  try {
    const principal = await getPrincipal(auth.session.tenantId, id);
    if (!principal) return NextResponse.json({ code: "40400", message: "principal not found" }, { status: 404 });
    const targetAuth = await requireAdminTarget(["role:assign"], targetForPrincipal(principal));
    if (!targetAuth.ok) return targetAuth.response;
    const body = (await request.json()) as Record<string, unknown>;
    const roleId = typeof body.roleId === "string" ? body.roleId.trim() : "";
    const dataScope = body.dataScope;
    const scopeDeptId = typeof body.scopeDeptId === "string" ? body.scopeDeptId.trim() || null : null;
    const scopeOrgId = typeof body.scopeOrgId === "string" ? body.scopeOrgId.trim() || null : null;
    if (!roleId || !parseDataScope(dataScope)) {
      return NextResponse.json({ code: "40000", message: "roleId and a valid dataScope are required" }, { status: 400 });
    }
    if ((dataScope === "department" || dataScope === "department_subtree") && !scopeDeptId) {
      return NextResponse.json({ code: "40000", message: "scopeDeptId is required for department ranges" }, { status: 400 });
    }
    if (principal.kind === "agent" && principal.agentProfile?.mode === "service" && dataScope === "self") {
      return NextResponse.json({ code: "40000", message: "service agents cannot use self range" }, { status: 400 });
    }
    const expiryInput = body.expiresAt;
    const expiresAt = parseExpiry(expiryInput);
    if (expiryInput !== undefined && expiresAt === undefined) {
      return NextResponse.json({ code: "40000", message: "invalid binding validity" }, { status: 400 });
    }
    // Resource-side approval is intentionally not an HTTP assertion.  A
    // future connector may call the IAM service with a verified grantor hook;
    // accepting an id plus an opaque string here would let the operator name
    // a more privileged principal and self-approve it.
    if ("grantedByPrincipalId" in body || "grantorApprovalRef" in body) {
      return NextResponse.json({ code: "40000", message: "resource grantor approval is not verified" }, { status: 400 });
    }
    const canDelegateInput = body.canDelegate;
    const canDelegate = canDelegateInput === undefined ? undefined : canDelegateInput;
    if (canDelegate !== undefined && typeof canDelegate !== "boolean") {
      return NextResponse.json({ code: "40000", message: "canDelegate must be a boolean" }, { status: 400 });
    }
    const grantorFields = {
      ...(canDelegateInput !== undefined ? { canDelegate } : {}),
    };
    await assertGrantable({
      tenantId: auth.session.tenantId,
      actorUserId: auth.session.userId,
      targetPrincipalId: id,
      roleId,
      dataScope,
      scopeOrgId,
      scopeDeptId,
      expiresAt,
      ...grantorFields,
    });
    const binding = await assignPrincipalRoleBinding({
      tenantId: auth.session.tenantId,
      principalId: id,
      roleId,
      dataScope,
      scopeOrgId,
      scopeDeptId,
      expiresAt,
      actorUserId: auth.session.userId,
      ...grantorFields,
    });
    const [decorated] = await decorateBindings(auth.session.tenantId, [binding]);
    return NextResponse.json({ code: "00000", message: "ok", data: { binding: decorated } });
  } catch (error) {
    return NextResponse.json(errorEnvelope(error), { status: errorStatus(error) });
  }
}
