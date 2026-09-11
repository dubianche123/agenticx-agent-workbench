import {
  getDepartmentsRepository,
  getPrincipal,
  hasSomeScope,
  listPrincipalRoleBindings,
  listRoles,
  updateAgentPrincipal,
} from "@agenticx/iam-core";
import type { AgentMode, PrincipalDto, PrincipalRoleBindingDto, PrincipalStatus } from "@agenticx/iam-core";
import { NextResponse } from "next/server";
import {
  requireAdminSomeScopedCapability,
  requireAdminScopedCapability,
  requireAdminTarget,
} from "../../../../../lib/admin-auth";
import { errorEnvelope, errorStatus } from "../../iam/authorization";

function isStatus(value: unknown): value is PrincipalStatus {
  return value === "active" || value === "disabled";
}

function targetForPrincipal(principal: PrincipalDto): { kind: "user" | "agent"; id: string } {
  if (principal.kind === "user") {
    if (!principal.userId) throw new Error("user principal is missing backing user");
    return { kind: "user", id: principal.userId };
  }
  return { kind: "agent", id: principal.id };
}

async function withBindingMetadata(tenantId: string, bindings: PrincipalRoleBindingDto[]) {
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

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireAdminSomeScopedCapability(["user:read", "agent:read"]);
  if (!auth.ok) return auth.response;
  const { id } = await context.params;
  try {
    const principal = await getPrincipal(auth.session.tenantId, id);
    if (!principal) return NextResponse.json({ code: "40400", message: "principal not found" }, { status: 404 });
    const readScope = principal.kind === "user" ? "user:read" : "agent:read";
    const targetAuth = await requireAdminTarget([readScope], targetForPrincipal(principal));
    if (!targetAuth.ok) return targetAuth.response;

    // Role binding metadata is a separate capability. A user directory reader
    // can inspect the principal itself without receiving role names, scopes,
    // or binding history for the target.
    const canReadBindings = hasSomeScope(auth.scopes, ["role:read", "role:assign"]);
    if (!canReadBindings) {
      return NextResponse.json({ code: "00000", message: "ok", data: { principal } });
    }
    const roleScope = hasSomeScope(auth.scopes, ["role:read"]) ? "role:read" : "role:assign";
    const roleTargetAuth = await requireAdminTarget([roleScope], targetForPrincipal(principal));
    if (!roleTargetAuth.ok) return roleTargetAuth.response;
    const bindings = await listPrincipalRoleBindings(auth.session.tenantId, principal.id);
    return NextResponse.json({
      code: "00000",
      message: "ok",
      data: { principal, bindings: await withBindingMetadata(auth.session.tenantId, bindings) },
    });
  } catch (error) {
    return NextResponse.json(errorEnvelope(error), { status: errorStatus(error) });
  }
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireAdminScopedCapability(["agent:update"]);
  if (!auth.ok) return auth.response;
  const { id } = await context.params;
  try {
    const principal = await getPrincipal(auth.session.tenantId, id);
    if (!principal || principal.kind !== "agent") {
      return NextResponse.json({ code: "40400", message: "agent principal not found" }, { status: 404 });
    }
    const targetAuth = await requireAdminTarget(["agent:update"], { kind: "agent", id });
    if (!targetAuth.ok) return targetAuth.response;
    const body = (await request.json()) as Record<string, unknown>;
    const patch: {
      displayName?: string;
      mode?: AgentMode;
      ownerUserId?: string | null;
      status?: PrincipalStatus;
      definitionRef?: string | null;
      definitionVersion?: number;
    } = {};
    if (typeof body.displayName === "string") patch.displayName = body.displayName.trim();
    if (isStatus(body.status)) patch.status = body.status;
    if (typeof body.ownerUserId === "string" || body.ownerUserId === null) {
      patch.ownerUserId = typeof body.ownerUserId === "string" ? body.ownerUserId.trim() || null : null;
    }
    if (typeof body.mode === "string" && (body.mode === "delegated" || body.mode === "service")) {
      patch.mode = body.mode;
    }
    if (typeof body.definitionRef === "string" || body.definitionRef === null) {
      patch.definitionRef = typeof body.definitionRef === "string" ? body.definitionRef.trim() || null : null;
    }
    if (typeof body.definitionVersion === "number" && Number.isInteger(body.definitionVersion)) {
      patch.definitionVersion = body.definitionVersion;
    }
    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ code: "40000", message: "no supported changes" }, { status: 400 });
    }
    if (patch.ownerUserId) {
      const ownerAuth = await requireAdminTarget(["agent:update"], { kind: "user", id: patch.ownerUserId });
      if (!ownerAuth.ok) return ownerAuth.response;
    }
    const updated = await updateAgentPrincipal({
      tenantId: auth.session.tenantId,
      principalId: id,
      actorUserId: auth.session.userId,
      ...patch,
    });
    return NextResponse.json({ code: "00000", message: "ok", data: { principal: updated } });
  } catch (error) {
    return NextResponse.json(errorEnvelope(error), { status: errorStatus(error) });
  }
}
