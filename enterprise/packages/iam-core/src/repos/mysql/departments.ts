import { departments, organizations, tenants, users } from "@agenticx/db-schema/mysql";
import { and, asc, eq, isNull, like, ne, sql } from "drizzle-orm";
import { ulid } from "ulid";

import type { DepartmentRow } from "../departments";
import type { DepartmentsRepository } from "../contracts";
import { insertMysqlAuditEvent } from "./audit";
import { getMysqlRepositoryDb } from "./db";
import type { MySqlDrizzleDb } from "../../database/mysql";

async function lockTenantRow(db: any, tenantId: string): Promise<void> {
  await db.execute(sql`select ${tenants.id} from ${tenants} where ${tenants.id} = ${tenantId} for update`);
}

function mapRow(r: typeof departments.$inferSelect): DepartmentRow {
  return {
    id: r.id,
    tenantId: r.tenantId,
    orgId: r.orgId,
    parentId: r.parentId,
    name: r.name,
    path: r.path,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

async function memberCountsByDept(tenantId: string, dbOrTx?: unknown): Promise<Map<string, number>> {
  const db = (dbOrTx as MySqlDrizzleDb | undefined) ?? (await getMysqlRepositoryDb());
  const rows = await db
    .select({
      deptId: users.deptId,
      c: sql<number>`cast(count(*) as signed)`,
    })
    .from(users)
    .where(
      and(
        eq(users.tenantId, tenantId),
        eq(users.isDeleted, false),
        isNull(users.deletedAt),
        sql`${users.deptId} is not null`,
      ),
    )
    .groupBy(users.deptId);
  const m = new Map<string, number>();
  for (const r of rows) {
    if (r.deptId) m.set(r.deptId, r.c);
  }
  return m;
}

async function getDepartmentInternal(tenantId: string, id: string, dbOrTx?: unknown): Promise<DepartmentRow | null> {
  const db = (dbOrTx as MySqlDrizzleDb | undefined) ?? (await getMysqlRepositoryDb());
  const [row] = await db
    .select()
    .from(departments)
    .where(and(eq(departments.tenantId, tenantId), eq(departments.id, id)))
    .limit(1);
  if (!row) return null;
  const counts = await memberCountsByDept(tenantId, db);
  return { ...mapRow(row), memberCount: counts.get(row.id) ?? 0 };
}

export const mysqlDepartmentsRepository: DepartmentsRepository = {
  dialect: "mysql",
  async getDefaultOrgId(tenantId) {
    const db = await getMysqlRepositoryDb();
    const [row] = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.tenantId, tenantId))
      .orderBy(organizations.createdAt)
      .limit(1);
    return row?.id ?? null;
  },
  async listDepartmentsFlat(tenantId, dbOrTx) {
    const db = (dbOrTx as MySqlDrizzleDb | undefined) ?? (await getMysqlRepositoryDb());
    const rows = await db
      .select()
      .from(departments)
      .where(eq(departments.tenantId, tenantId))
      .orderBy(asc(departments.path));
    const counts = await memberCountsByDept(tenantId, db);
    return rows.map((r) => ({ ...mapRow(r), memberCount: counts.get(r.id) ?? 0 }));
  },
  async listDepartmentsTree(tenantId) {
    const flat = await mysqlDepartmentsRepository.listDepartmentsFlat(tenantId);
    const byParent = new Map<string | null, DepartmentRow[]>();
    for (const d of flat) {
      const key = d.parentId;
      const list = byParent.get(key) ?? [];
      list.push({ ...d, children: [] });
      byParent.set(key, list);
    }
    function attachChildren(node: DepartmentRow): DepartmentRow {
      const kids = byParent.get(node.id) ?? [];
      return {
        ...node,
        children: kids.map(attachChildren).sort((a, b) => a.name.localeCompare(b.name)),
      };
    }
    return (byParent.get(null) ?? []).map(attachChildren).sort((a, b) => a.name.localeCompare(b.name));
  },
  getDepartment: getDepartmentInternal,
  async createDepartment(input, dbOrTx) {
    const name = input.name.trim();
    if (!name) throw new Error("部门名称不能为空");

    const id = ulid();
    const now = new Date();
    const parentId: string | null = input.parentId ?? null;
    const apply = async (db: any): Promise<DepartmentRow> => {
      await lockTenantRow(db, input.tenantId);
      const parentPath = parentId
        ? (await db
            .select({ path: departments.path })
            .from(departments)
            .where(and(eq(departments.tenantId, input.tenantId), eq(departments.id, parentId)))
            .for("update")
            .limit(1))[0]?.path
        : "";
      if (parentId && !parentPath) throw new Error("父部门不存在");
      const path = parentPath === "" ? `/${name}/` : `${parentPath!.replace(/\/$/, "")}/${name}/`;
      const [exists] = await db
        .select({ id: departments.id })
        .from(departments)
        .where(and(eq(departments.tenantId, input.tenantId), eq(departments.path, path)))
        .limit(1);
      if (exists) throw new Error("同路径部门已存在");
      await db.insert(departments).values({
        id,
        tenantId: input.tenantId,
        orgId: input.orgId,
        parentId,
        name,
        path,
        createdAt: now,
        updatedAt: now,
      });

      await insertMysqlAuditEvent({
        tenantId: input.tenantId,
        actorUserId: input.actorUserId ?? null,
        eventType: "iam.dept.create",
        targetKind: "dept",
        targetId: id,
        detail: { name, path, parentId },
      }, db);

      const created = await getDepartmentInternal(input.tenantId, id, db);
      if (!created) throw new Error("dept create failed");
      return created;
    };
    if (dbOrTx) return apply(dbOrTx as MySqlDrizzleDb);
    const db = await getMysqlRepositoryDb();
    return db.transaction((tx) => apply(tx));
  },
  async updateDepartmentName(input) {
    const name = input.name.trim();
    if (!name) throw new Error("部门名称不能为空");
    const db = await getMysqlRepositoryDb();
    let oldPath = "";
    let oldName = "";
    let newPath = "";
    await db.transaction(async (tx) => {
      await lockTenantRow(tx, input.tenantId);
      const [current] = await tx
        .select()
        .from(departments)
        .where(and(eq(departments.tenantId, input.tenantId), eq(departments.id, input.id)))
        .for("update")
        .limit(1);
      if (!current) throw new Error("部门不存在");
      oldPath = current.path;
      oldName = current.name;
      const parentPath = current.parentId === null
        ? ""
        : (await tx
            .select({ path: departments.path })
            .from(departments)
            .where(and(eq(departments.tenantId, input.tenantId), eq(departments.id, current.parentId)))
            .for("update")
            .limit(1))[0]?.path?.replace(/\/$/, "") ?? "";
      newPath = current.parentId === null ? `/${name}/` : `${parentPath}/${name}/`;
      await tx
        .update(departments)
        .set({ name, path: newPath, updatedAt: new Date() })
        .where(and(eq(departments.tenantId, input.tenantId), eq(departments.id, input.id)));

      const descend = await tx
        .select({ id: departments.id, path: departments.path })
        .from(departments)
        .where(
          and(
            eq(departments.tenantId, input.tenantId),
            like(departments.path, `${oldPath}%`),
            ne(departments.id, input.id),
          ),
        );

      for (const d of descend) {
        if (!d.path.startsWith(oldPath)) continue;
        const suffix = d.path.slice(oldPath.length);
        const nextPath = `${newPath.replace(/\/$/, "")}/${suffix.replace(/^\//, "")}`;
        await tx
          .update(departments)
          .set({
            path: nextPath.endsWith("/") ? nextPath : `${nextPath}/`,
            updatedAt: new Date(),
          })
          .where(and(eq(departments.tenantId, input.tenantId), eq(departments.id, d.id)));
      }
    });

    await insertMysqlAuditEvent({
      tenantId: input.tenantId,
      actorUserId: input.actorUserId ?? null,
      eventType: "iam.dept.update",
      targetKind: "dept",
      targetId: input.id,
      detail: { before: { name: oldName, path: oldPath }, after: { name, path: newPath } },
    });

    const updated = await getDepartmentInternal(input.tenantId, input.id);
    if (!updated) throw new Error("dept update failed");
    return updated;
  },
  async moveDepartment(input) {
    const db = await getMysqlRepositoryDb();
    let oldPath = "";
    let newPath = "";
    await db.transaction(async (tx) => {
      await lockTenantRow(tx, input.tenantId);
      const [current] = await tx
        .select()
        .from(departments)
        .where(and(eq(departments.tenantId, input.tenantId), eq(departments.id, input.id)))
        .for("update")
        .limit(1);
      if (!current) throw new Error("部门不存在");
      if (input.newParentId === input.id) throw new Error("不能将部门设为自己的子节点");
      oldPath = current.path;
      if (input.newParentId) {
        const allDesc = await tx
          .select({ id: departments.id })
          .from(departments)
          .where(and(eq(departments.tenantId, input.tenantId), like(departments.path, `${current.path}%`)));
        const descIds = new Set(allDesc.map((r) => r.id));
        if (descIds.has(input.newParentId)) throw new Error("不能移动到子部门下");
      }

      const newParent = input.newParentId
        ? (await tx
            .select({ path: departments.path })
            .from(departments)
            .where(and(eq(departments.tenantId, input.tenantId), eq(departments.id, input.newParentId)))
            .for("update")
            .limit(1))[0]
        : null;
      if (input.newParentId && !newParent) throw new Error("目标父部门不存在");
      newPath = input.newParentId === null
        ? `/${current.name}/`
        : `${newParent!.path.replace(/\/$/, "")}/${current.name}/`;
      await tx
        .update(departments)
        .set({
          parentId: input.newParentId,
          path: newPath,
          updatedAt: new Date(),
        })
        .where(and(eq(departments.tenantId, input.tenantId), eq(departments.id, input.id)));

      const descend = await tx
        .select({ id: departments.id, path: departments.path })
        .from(departments)
        .where(
          and(
            eq(departments.tenantId, input.tenantId),
            like(departments.path, `${oldPath}%`),
            ne(departments.id, input.id),
          ),
        );

      for (const d of descend) {
        const suffix = d.path.slice(oldPath.length);
        const merged = `${newPath.replace(/\/$/, "")}/${suffix.replace(/^\//, "")}`;
        const finalPath = merged.endsWith("/") ? merged : `${merged}/`;
        await tx
          .update(departments)
          .set({ path: finalPath, updatedAt: new Date() })
          .where(and(eq(departments.tenantId, input.tenantId), eq(departments.id, d.id)));
      }
    });

    await insertMysqlAuditEvent({
      tenantId: input.tenantId,
      actorUserId: input.actorUserId ?? null,
      eventType: "iam.dept.move",
      targetKind: "dept",
      targetId: input.id,
      detail: { oldPath, newPath, newParentId: input.newParentId },
    });

    const moved = await getDepartmentInternal(input.tenantId, input.id);
    if (!moved) throw new Error("dept move failed");
    return moved;
  },
  async deleteDepartment(input) {
    const db = await getMysqlRepositoryDb();
    let oldPath = "";
    let oldName = "";
    await db.transaction(async (tx) => {
      await lockTenantRow(tx, input.tenantId);
      const [current] = await tx
        .select()
        .from(departments)
        .where(and(eq(departments.tenantId, input.tenantId), eq(departments.id, input.id)))
        .for("update")
        .limit(1);
      if (!current) throw new Error("部门不存在");
      oldPath = current.path;
      oldName = current.name;

      const [children] = await tx
        .select({ id: departments.id })
        .from(departments)
        .where(and(eq(departments.tenantId, input.tenantId), eq(departments.parentId, input.id)))
        .limit(1);
      if (children) {
        const err = new Error("dept_has_children");
        (err as Error & { code?: string }).code = "409";
        throw err;
      }

      const [members] = await tx
        .select({ id: users.id })
        .from(users)
        .where(
          and(
            eq(users.tenantId, input.tenantId),
            eq(users.deptId, input.id),
            eq(users.isDeleted, false),
            isNull(users.deletedAt),
          ),
        )
        .limit(1);
      if (members) {
        const err = new Error("dept_has_members");
        (err as Error & { code?: string }).code = "409";
        throw err;
      }

      await tx.delete(departments).where(and(eq(departments.tenantId, input.tenantId), eq(departments.id, input.id)));
    });

    await insertMysqlAuditEvent({
      tenantId: input.tenantId,
      actorUserId: input.actorUserId ?? null,
      eventType: "iam.dept.delete",
      targetKind: "dept",
      targetId: input.id,
      detail: { path: oldPath, name: oldName },
    });
  },
  async listDepartmentAncestorIds(tenantId, deptId) {
    const ids: string[] = [];
    let currentId: string | null = deptId;
    const seen = new Set<string>();
    while (currentId && !seen.has(currentId)) {
      seen.add(currentId);
      const dept = await getDepartmentInternal(tenantId, currentId);
      if (!dept) break;
      ids.push(dept.id);
      currentId = dept.parentId;
    }
    return ids;
  },
  async listDepartmentSubtreeIds(tenantId, deptId) {
    const self = await getDepartmentInternal(tenantId, deptId);
    if (!self) return [];
    const db = await getMysqlRepositoryDb();
    const rows = await db
      .select({ id: departments.id })
      .from(departments)
      .where(and(eq(departments.tenantId, tenantId), like(departments.path, `${self.path}%`)));
    return rows.map((r) => r.id);
  },
};
