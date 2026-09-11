import { hashPassword } from "@agenticx/auth";
import {
  findOrCreateDepartmentPath,
  getDefaultOrgId,
  getDepartmentsRepository,
  getUsersRepository,
  upsertUserByEmailInTx,
  getIamDb,
  loadAuthUserByEmail,
  assertUserRoleCodesGrantable,
  type GrantabilitySnapshot,
} from "@agenticx/iam-core";
import { NextResponse } from "next/server";
import { requireAdminScopedCapability, requireAdminTarget } from "../../../../../lib/admin-auth";

const MAX_ROWS = 5000;

function normalizeDepartmentSegments(raw: string): string[] {
  return raw
    .split(/\/+/g)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

/** MySQL repository path for auto-creating departments without a PG-only transaction. */
async function ensureDepartmentPathForMysql(input: {
  tenantId: string;
  orgId: string;
  path: string;
  actorUserId?: string | null;
}, dbOrTx?: unknown): Promise<string> {
  const departments = getDepartmentsRepository();
  const existingDepartments = await departments.listDepartmentsFlat(input.tenantId, dbOrTx);
  const byPath = new Map(existingDepartments.map((department) => [department.path, department]));
  const byName = new Map<string, typeof existingDepartments>();
  for (const department of existingDepartments) {
    const sameName = byName.get(department.name) ?? [];
    sameName.push(department);
    byName.set(department.name, sameName);
  }
  let parentId: string | null = null;
  let parentPath = "";
  const segments = normalizeDepartmentSegments(input.path);
  for (const [index, segment] of segments.entries()) {
    const nextPath = parentPath ? `${parentPath.replace(/\/$/, "")}/${segment}/` : `/${segment}/`;
    let department = byPath.get(nextPath);
    // Spreadsheets commonly contain only a leaf department name (for example
    // "平台研发部") while the directory stores the full path
    // ("/总部/平台研发部/"). Reuse an unambiguous existing name instead of
    // attempting a duplicate root insert. Ambiguous names still require the
    // caller to provide the full path.
    if (!department && index === 0 && segments.length === 1) {
      const sameName = byName.get(segment) ?? [];
      if (sameName.length === 1) department = sameName[0];
      if (sameName.length > 1) {
        throw new Error(`部门名称不唯一，请填写完整路径：${segment}`);
      }
    }
    if (!department) {
      department = await departments.createDepartment({
        tenantId: input.tenantId,
        orgId: input.orgId,
        name: segment,
        parentId,
        actorUserId: input.actorUserId,
      }, dbOrTx);
      byPath.set(nextPath, department);
    }
    parentId = department.id;
    parentPath = nextPath;
  }
  if (!parentId) throw new Error("部门路径为空");
  return parentId;
}

type BulkRow = {
  email: string;
  displayName: string;
  deptPath?: string;
  roleCodes?: string[];
  phone?: string | null;
  employeeNo?: string | null;
  jobTitle?: string | null;
  status?: "active" | "disabled";
};

export type BulkImportFailure = {
  index: number;
  email: string;
  reason: string;
  displayName?: string;
  deptPath?: string;
  roleCodes?: string;
  phone?: string;
  employeeNo?: string;
  jobTitle?: string;
  status?: string;
};

function rowSnapshot(row: BulkRow): Pick<
  BulkImportFailure,
  "displayName" | "deptPath" | "roleCodes" | "phone" | "employeeNo" | "jobTitle" | "status"
> {
  return {
    displayName: typeof row.displayName === "string" ? row.displayName : "",
    deptPath: row.deptPath?.trim() || "",
    roleCodes: row.roleCodes?.length ? row.roleCodes.join(";") : "",
    phone: row.phone ?? "",
    employeeNo: row.employeeNo ?? "",
    jobTitle: row.jobTitle ?? "",
    status: row.status ?? "",
  };
}

async function handlePost(request: Request) {
  const auth = await requireAdminScopedCapability(["user:create"]);
  if (!auth.ok) return auth.response;

  const orgId = await getDefaultOrgId(auth.session.tenantId);
  if (!orgId) {
    return NextResponse.json({ code: "40000", message: "no organization for tenant" }, { status: 400 });
  }

  let body: { rows?: BulkRow[]; initialPassword?: string };
  try {
    body = (await request.json()) as { rows?: BulkRow[]; initialPassword?: string };
  } catch {
    return NextResponse.json({ code: "40001", message: "invalid json" }, { status: 400 });
  }
  const initialPassword = typeof body.initialPassword === "string" ? body.initialPassword.trim() : "";
  if (initialPassword.length < 8) {
    return NextResponse.json(
      { code: "40000", message: "initialPassword must be at least 8 chars" },
      { status: 400 },
    );
  }
  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (!rows.length) {
    return NextResponse.json({ code: "40000", message: "rows required" }, { status: 400 });
  }
  if (rows.length > MAX_ROWS) {
    return NextResponse.json(
      { code: "40000", message: `rows exceed limit (${MAX_ROWS})` },
      { status: 400 }
    );
  }

  const failures: BulkImportFailure[] = [];
  const usersRepository = getUsersRepository();
  const mysqlDepartmentsRepository = usersRepository.dialect === "mysql" ? getDepartmentsRepository() : null;
  const directory = await getDepartmentsRepository().listDepartmentsFlat(auth.session.tenantId);
  const byPath = new Map(directory.map((department) => [department.path, department]));
  const byName = new Map<string, typeof directory>();
  for (const department of directory) {
    const sameName = byName.get(department.name) ?? [];
    sameName.push(department);
    byName.set(department.name, sameName);
  }
  const seenEmails = new Set<string>();
  const authorizationSnapshots = new Map<number, GrantabilitySnapshot>();

  // Complete authorization preflight before the first write.  In particular,
  // an out-of-range row must not be reported as one failed row beside rows
  // that were already imported successfully.
  for (let globalIndex = 0; globalIndex < rows.length; globalIndex++) {
    const row = rows[globalIndex]!;
    const email = typeof row.email === "string" ? row.email.trim().toLowerCase() : "";
    const displayName = typeof row.displayName === "string" ? row.displayName.trim() : "";
    const snap = rowSnapshot(row);
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !displayName) {
      failures.push({ index: globalIndex, email, reason: "invalid email or displayName", ...snap });
      continue;
    }
    if (seenEmails.has(email)) {
      failures.push({ index: globalIndex, email, reason: "duplicate email in import", ...snap });
      continue;
    }
    seenEmails.add(email);
    try {
      const segments = row.deptPath?.trim() ? normalizeDepartmentSegments(row.deptPath) : [];
      const canonicalPath = segments.length ? `/${segments.join("/")}/` : null;
      const existingDepartment = canonicalPath
        ? byPath.get(canonicalPath) ?? (segments.length === 1 && (byName.get(segments[0]!)?.length ?? 0) === 1
          ? byName.get(segments[0]!)![0]
          : undefined)
        : undefined;
      const existing = await loadAuthUserByEmail(auth.session.tenantId, email);
      if (existing && !canonicalPath) {
        const existingAuth = await requireAdminTarget(["user:create"], { kind: "user", id: existing.id });
        if (!existingAuth.ok) throw new Error("forbidden: existing user is outside the current range");
      } else if (existingDepartment) {
        const targetAuth = await requireAdminTarget(["user:create"], {
          kind: "department",
          id: existingDepartment.id,
        });
        if (!targetAuth.ok) throw new Error("forbidden: user:create is outside the department range");
      } else if (canonicalPath) {
        const tenantUserAuth = await requireAdminScopedCapability(["user:create"], {
          target: { kind: "tenant", id: auth.session.tenantId },
        });
        const tenantDeptAuth = await requireAdminScopedCapability(["dept:create"], {
          target: { kind: "tenant", id: auth.session.tenantId },
        });
        if (!tenantUserAuth.ok || !tenantDeptAuth.ok) {
          throw new Error("forbidden: creating a department path requires tenant scope");
        }
      } else {
        const tenantUserAuth = await requireAdminScopedCapability(["user:create"], {
          target: { kind: "tenant", id: auth.session.tenantId },
        });
        if (!tenantUserAuth.ok) throw new Error("forbidden: user:create is outside tenant scope");
      }
      if (existing && canonicalPath) {
        const existingAuth = await requireAdminTarget(["user:create"], { kind: "user", id: existing.id });
        if (!existingAuth.ok) throw new Error("forbidden: existing user is outside the current range");
      }
      const roleCodes = row.roleCodes?.length ? row.roleCodes : ["member"];
      const deptId = existingDepartment?.id ?? null;
      const elevatedRoleCodes = roleCodes.filter((code) => code.trim().toLowerCase() !== "member");
      if (elevatedRoleCodes.length) {
        const snapshot = await assertUserRoleCodesGrantable({
          tenantId: auth.session.tenantId,
          actorUserId: auth.session.userId,
          // A new row is created by the repository in the same transaction;
          // the email is only a stable preflight placeholder in this route.
          targetUserId: existing?.id ?? email,
          targetMayBeNew: !existing,
          roleCodes: elevatedRoleCodes,
          defaultOrgId: orgId,
          defaultDeptId: deptId,
        });
        authorizationSnapshots.set(globalIndex, snapshot);
      }
    } catch (e) {
      failures.push({
        index: globalIndex,
        email,
        reason: e instanceof Error ? e.message : "authorization preflight failed",
        ...snap,
      });
    }
  }
  if (failures.length) {
    return NextResponse.json({
      code: "40002",
      message: "import rejected during authorization preflight",
      data: { success: 0, failed: failures.length, failures },
    }, { status: 403 });
  }

  let success = 0;
  // Every imported account shares the admin-selected temporary password. Hash it
  // once for the batch instead of paying the password-hashing cost per row.
  const sharedPasswordHash = await hashPassword(initialPassword);

  for (let globalIndex = 0; globalIndex < rows.length; globalIndex++) {
    const row = rows[globalIndex]!;
    const email = typeof row.email === "string" ? row.email.trim().toLowerCase() : "";
    const displayName = typeof row.displayName === "string" ? row.displayName.trim() : "";
    const snap = rowSnapshot(row);

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !displayName) {
      failures.push({
        index: globalIndex,
        email,
        reason: "invalid email or displayName",
        ...snap,
      });
      continue;
    }

    try {
      const roleCodes = row.roleCodes?.length ? row.roleCodes : ["member"];
      if (usersRepository.dialect === "postgresql") {
        const db = getIamDb();
        await db.transaction(async (tx) => {
          let deptId: string | null = null;
          if (row.deptPath?.trim()) {
            const { leafDeptId } = await findOrCreateDepartmentPath({
              tenantId: auth.session.tenantId,
              orgId,
              path: row.deptPath.trim(),
              actorUserId: auth.session.userId,
              tx,
            });
            deptId = leafDeptId;
          }
          await upsertUserByEmailInTx(tx, {
            tenantId: auth.session.tenantId,
            email,
            displayName,
            deptId,
            phone: row.phone ?? null,
            employeeNo: row.employeeNo ?? null,
            jobTitle: row.jobTitle ?? null,
            passwordHash: sharedPasswordHash,
            mustChangePassword: true,
            status: row.status,
            roleCodes,
            defaultOrgId: orgId,
            actorUserId: auth.session.userId,
          }, authorizationSnapshots.get(globalIndex));
        });
      } else {
        if (!mysqlDepartmentsRepository || !usersRepository.transaction) {
          throw new Error("MySQL transaction repositories unavailable");
        }
        await usersRepository.transaction(async (tx) => {
          let deptId: string | null = null;
          if (row.deptPath?.trim()) {
            deptId = await ensureDepartmentPathForMysql({
              tenantId: auth.session.tenantId,
              orgId,
              path: row.deptPath.trim(),
              actorUserId: auth.session.userId,
            }, tx);
          }
          await usersRepository.upsertUserByEmail({
            tenantId: auth.session.tenantId,
            email,
            displayName,
            deptId,
            phone: row.phone ?? null,
            employeeNo: row.employeeNo ?? null,
            jobTitle: row.jobTitle ?? null,
            passwordHash: sharedPasswordHash,
            mustChangePassword: true,
            status: row.status,
            roleCodes,
            defaultOrgId: orgId,
            actorUserId: auth.session.userId,
          }, tx);
        });
      }
      success += 1;
    } catch (e) {
      failures.push({
        index: globalIndex,
        email,
        reason: e instanceof Error ? e.message : "import error",
        ...snap,
      });
    }
  }

  return NextResponse.json({
    code: failures.length ? "40002" : "00000",
    message: failures.length ? "partial failure" : "ok",
    data: { success, failed: failures.length, failures },
  });
}

export async function POST(request: Request) {
  try {
    return await handlePost(request);
  } catch (error) {
    console.error(
      "[admin/iam/bulk-import] request failed:",
      error instanceof Error ? error.stack ?? error.message : error,
    );
    return NextResponse.json(
      {
        code: "50001",
        message: "批量导入失败，请稍后重试；如持续失败请联系管理员",
      },
      { status: 500 },
    );
  }
}
