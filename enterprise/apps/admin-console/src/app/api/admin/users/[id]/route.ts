import {
  getAdminUser,
  softDeleteUser,
  updateAdminUser,
  type AdminUserStatus,
  type UpdateAdminUserInput,
} from "@agenticx/iam-core";
import { NextResponse } from "next/server";
import { requireAdminScopedCapability, requireAdminTarget } from "../../../../../lib/admin-auth";
import { getDefaultOrgId } from "../../../../../lib/admin-pg-auth";
import { removeUserFromAllGroups } from "../../../../../lib/user-groups-store";
import { errorEnvelope, errorStatus } from "../../iam/authorization";

function isStatus(value: unknown): value is AdminUserStatus {
  return value === "active" || value === "disabled" || value === "locked";
}

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireAdminScopedCapability(["user:read"]);
  if (!auth.ok) return auth.response;

  const { id } = await context.params;
  const targetAuth = await requireAdminTarget(["user:read"], { kind: "user", id });
  if (!targetAuth.ok) return targetAuth.response;
  const user = await getAdminUser(auth.session.tenantId, id);
  if (!user) {
    return NextResponse.json({ code: "40400", message: "user not found" }, { status: 404 });
  }
  return NextResponse.json({ code: "00000", message: "ok", data: { user } });
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireAdminScopedCapability(["user:update"]);
  if (!auth.ok) return auth.response;

  const { id } = await context.params;
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const targetAuth = await requireAdminTarget(["user:update"], { kind: "user", id });
    if (!targetAuth.ok) return targetAuth.response;
    // Role changes have their own principal binding endpoint. Keeping this
    // rejection on the old profile route closes the direct roleCodes bypass
    // for API callers and prevents a stale client from silently reassigning
    // roles with only user:update.
    if (Object.prototype.hasOwnProperty.call(body, "roleCodes")) {
      return NextResponse.json(
        { code: "40300", message: "role assignment requires role:assign" },
        { status: 403 },
      );
    }
    const patch: UpdateAdminUserInput = {};
    if (body.email !== undefined) {
      const email = typeof body.email === "string" ? body.email.trim() : "";
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return NextResponse.json({ code: "40000", message: "invalid email" }, { status: 400 });
      }
      patch.email = email;
    }
    if (typeof body.displayName === "string") patch.displayName = body.displayName;
    if (body.deptId === null || typeof body.deptId === "string") {
      patch.deptId = typeof body.deptId === "string" ? body.deptId.trim() || null : null;
      const departmentAuth = await requireAdminTarget(["user:update"], patch.deptId
        ? { kind: "department", id: patch.deptId }
        : { kind: "tenant", id: auth.session.tenantId });
      if (!departmentAuth.ok) return departmentAuth.response;
    }
    if (isStatus(body.status)) patch.status = body.status;
    if (body.phone === null || typeof body.phone === "string") {
      patch.phone = typeof body.phone === "string" ? body.phone.trim() || null : null;
    }
    if (body.employeeNo === null || typeof body.employeeNo === "string") {
      patch.employeeNo = typeof body.employeeNo === "string" ? body.employeeNo.trim() || null : null;
    }
    if (body.jobTitle === null || typeof body.jobTitle === "string") {
      patch.jobTitle = typeof body.jobTitle === "string" ? body.jobTitle.trim() || null : null;
    }
    const defaultOrgId = await getDefaultOrgId(auth.session.tenantId);
    const updated = await updateAdminUser(auth.session.tenantId, id, patch, {
      actorUserId: auth.session.userId,
      defaultOrgId,
    });
    return NextResponse.json({ code: "00000", message: "ok", data: { user: updated } });
  } catch (error) {
    return NextResponse.json(errorEnvelope(error), { status: errorStatus(error) });
  }
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireAdminScopedCapability(["user:delete"]);
  if (!auth.ok) return auth.response;

  const { id } = await context.params;
  try {
    const targetAuth = await requireAdminTarget(["user:delete"], { kind: "user", id });
    if (!targetAuth.ok) return targetAuth.response;
    await softDeleteUser(auth.session.tenantId, id, auth.session.userId);
    let removedFromGroups = 0;
    let groupCleanupPending = false;
    try {
      removedFromGroups = await removeUserFromAllGroups(auth.session.tenantId, id);
    } catch (cleanupError) {
      // The IAM deletion has already succeeded. Do not report the whole delete
      // as failed; group edit/load paths also prune legacy missing members.
      groupCleanupPending = true;
      console.error(
        "[admin/users] deleted user group cleanup failed:",
        cleanupError instanceof Error ? cleanupError.stack ?? cleanupError.message : cleanupError,
      );
    }
    return NextResponse.json({
      code: "00000",
      message: "ok",
      data: { removedFromGroups, groupCleanupPending },
    });
  } catch (error) {
    return NextResponse.json(errorEnvelope(error), { status: errorStatus(error) });
  }
}
