import {
  createAdminUser,
  ensureSystemRoles,
  listAdminUsers,
  type AdminUserStatus,
  type ListUsersFilter,
} from "@agenticx/iam-core";
import { NextResponse } from "next/server";
import {
  requireAdminScopedCapability,
  resolveAdminUserVisibility,
} from "../../../../lib/admin-auth";
import { getDefaultOrgId } from "../../../../lib/admin-pg-auth";
import { assertGrantable } from "../iam/authorization";

function isStatus(value: unknown): value is AdminUserStatus {
  return value === "active" || value === "disabled" || value === "locked";
}

export async function GET(request: Request) {
  const auth = await requireAdminScopedCapability(["user:read"]);
  if (!auth.ok) return auth.response;

  const { searchParams } = new URL(request.url);
  const filter: ListUsersFilter = {};
  const q = searchParams.get("q")?.trim();
  if (q) filter.q = q;
  const status = searchParams.get("status");
  if (isStatus(status)) filter.status = status;
  const deptId = searchParams.get("deptId");
  if (deptId) filter.deptId = deptId;
  const deptScope = searchParams.get("deptScope");
  if (deptScope === "direct" || deptScope === "subtree") filter.deptScope = deptScope;
  const roleCode = searchParams.get("roleCode");
  if (roleCode) filter.roleCode = roleCode;
  const limit = Number(searchParams.get("limit") ?? "");
  if (Number.isFinite(limit) && limit > 0) filter.limit = limit;
  const offset = Number(searchParams.get("offset") ?? "");
  if (Number.isFinite(offset) && offset >= 0) filter.offset = offset;

  const visibility = await resolveAdminUserVisibility(auth.session.tenantId, auth.context);
  const result = await listAdminUsers(auth.session.tenantId, { ...filter, visibility });
  return NextResponse.json({
    code: "00000",
    message: "ok",
    data: result,
  });
}

export async function POST(request: Request) {
  const auth = await requireAdminScopedCapability(["user:create"]);
  if (!auth.ok) return auth.response;

  try {
    const body = (await request.json()) as Record<string, unknown>;
    const email = typeof body.email === "string" ? body.email : "";
    const displayName = typeof body.displayName === "string" ? body.displayName : "";
    const deptId = typeof body.deptId === "string" ? body.deptId : body.deptId === null ? null : null;
    const rawStatus = body.status;
    const status = isStatus(rawStatus) ? rawStatus : undefined;
    const password =
      typeof body.initialPassword === "string"
        ? body.initialPassword
        : typeof body.password === "string"
          ? body.password
          : undefined;
    const phone = typeof body.phone === "string" ? body.phone : null;
    const employeeNo = typeof body.employeeNo === "string" ? body.employeeNo : null;
    const jobTitle = typeof body.jobTitle === "string" ? body.jobTitle : null;
    const requestedRoleCodes = Array.isArray(body.roleCodes)
      ? body.roleCodes.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean)
      : [];
    // Account creation supplies the safe baseline role by default. If a
    // caller explicitly asks for an elevated role, it must pass the same
    // grantability guard used by principal role-bindings; user:create alone
    // cannot smuggle role changes through this route.
    const elevatedRoleCodes = body.isAdmin === true
      ? ["member", "admin"]
      : requestedRoleCodes;
    const defaultOrgId = await getDefaultOrgId(auth.session.tenantId);
    const targetAuthorization = await requireAdminScopedCapability(["user:create"], {
      target: deptId
        ? { kind: "department", id: deptId }
        : { kind: "tenant", id: auth.session.tenantId },
    });
    if (!targetAuthorization.ok) return targetAuthorization.response;
    for (const roleCode of elevatedRoleCodes.filter((code) => code !== "member")) {
      await assertGrantable({
        tenantId: auth.session.tenantId,
        actorUserId: auth.session.userId,
        roleCode,
        requiredScopes: ["role:assign"],
        defaultOrgId,
        defaultDeptId: deptId,
      });
    }
    const roleCodes = elevatedRoleCodes.length ? elevatedRoleCodes : ["member"];

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json({ code: "40000", message: "invalid email" }, { status: 400 });
    }
    if (!displayName.trim()) {
      return NextResponse.json({ code: "40000", message: "displayName is required" }, { status: 400 });
    }
    if (password !== undefined && password.length > 0 && password.length < 8) {
      return NextResponse.json(
        { code: "40000", message: "password must be at least 8 chars" },
        { status: 400 }
      );
    }

    await ensureSystemRoles(auth.session.tenantId);
    const created = await createAdminUser({
      tenantId: auth.session.tenantId,
      email,
      displayName,
      deptId,
      status,
      phone,
      employeeNo,
      jobTitle,
      roleCodes,
      initialPassword: password ?? null,
      defaultOrgId,
      actorUserId: auth.session.userId,
    });

    return NextResponse.json({
      code: "00000",
      message: "ok",
      data: {
        user: created.user,
        initialPassword: created.initialPassword,
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        code: "40000",
        message: error instanceof Error ? error.message : "invalid request",
      },
      { status: 400 }
    );
  }
}
