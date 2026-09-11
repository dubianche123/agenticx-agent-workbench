#!/usr/bin/env node
/**
 * MySQL seed — same logical rows as db-seed.mjs (default tenant / admin / super_admin).
 */
import mysql from "mysql2/promise";
import bcrypt from "bcryptjs";

const databaseUrl = process.env.DATABASE_URL ?? "mysql://agenticx:agenticx@127.0.0.1:3306/agenticx";

const ids = {
  tenant: "01J00000000000000000000001",
  org: "01J00000000000000000000002",
  dept: "01J00000000000000000000003",
  user: "01J00000000000000000000004",
  role: "01J00000000000000000000005",
  principal: "01J00000000000000000000006",
  binding: "01J00000000000000000000007",
};

function parseMysqlUrl(url) {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 3306,
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: parsed.pathname.replace(/^\//, "") || "agenticx",
    timezone: "Z",
    charset: "utf8mb4",
  };
}

async function main() {
  const conn = await mysql.createConnection(parseMysqlUrl(databaseUrl));
  await conn.query("SET time_zone = '+00:00'");
  const seedPassword = process.env.AUTH_DEV_OWNER_PASSWORD?.trim() || "change-me-in-development";
  const passwordHash = await bcrypt.hash(seedPassword, 12);

  try {
    await conn.beginTransaction();

    await conn.query(
      `INSERT INTO tenants (id, code, name, plan)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE name = VALUES(name), plan = VALUES(plan), updated_at = UTC_TIMESTAMP(6)`,
      [ids.tenant, "default", "Default Tenant", "enterprise"],
    );

    await conn.query(
      `INSERT INTO organizations (id, tenant_id, name)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE updated_at = UTC_TIMESTAMP(6)`,
      [ids.org, ids.tenant, "总部"],
    );

    await conn.query(
      `INSERT INTO departments (id, tenant_id, org_id, parent_id, name, path)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE name = VALUES(name), updated_at = UTC_TIMESTAMP(6)`,
      [ids.dept, ids.tenant, ids.org, null, "平台研发部", "/总部/平台研发部/"],
    );

    await conn.query(
      `INSERT INTO users (id, tenant_id, dept_id, email, display_name, password_hash, status, is_deleted)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0)
       ON DUPLICATE KEY UPDATE
         display_name = VALUES(display_name),
         password_hash = VALUES(password_hash),
         status = VALUES(status),
         is_deleted = 0,
         deleted_at = NULL,
         updated_at = UTC_TIMESTAMP(6)`,
      [ids.user, ids.tenant, ids.dept, "admin@agenticx.local", "Seed Admin", passwordHash, "active"],
    );

    await conn.query(
      `INSERT INTO roles (id, tenant_id, code, name, scopes, immutable)
       VALUES (?, ?, ?, ?, CAST(? AS JSON), ?)
       ON DUPLICATE KEY UPDATE
         name = VALUES(name),
         scopes = VALUES(scopes),
         immutable = VALUES(immutable),
         updated_at = UTC_TIMESTAMP(6)`,
      [ids.role, ids.tenant, "super_admin", "Super Admin", JSON.stringify(["*"]), true],
    );

    const [userRows] = await conn.query(
      `SELECT id FROM users WHERE tenant_id = ? AND email = ? AND is_deleted = 0 AND deleted_at IS NULL LIMIT 1`,
      [ids.tenant, "admin@agenticx.local"],
    );
    const userId = userRows[0]?.id ?? ids.user;
    const [roleRows] = await conn.query(
      `SELECT id FROM roles WHERE tenant_id = ? AND code = ? LIMIT 1`,
      [ids.tenant, "super_admin"],
    );
    const roleId = roleRows[0]?.id ?? ids.role;

    await conn.query(
      `INSERT INTO user_roles (tenant_id, user_id, role_id, scope_org_id, scope_dept_id)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         scope_org_id = VALUES(scope_org_id),
         scope_dept_id = VALUES(scope_dept_id),
         updated_at = UTC_TIMESTAMP(6)`,
      [ids.tenant, userId, roleId, ids.org, ids.dept],
    );

    // Migration 0044 backfills principals that exist when it runs. The seed
    // itself runs afterwards, so bootstrap the seed admin's durable
    // principal and binding inside this transaction; admin authorization
    // intentionally fails closed without them.
    await conn.query(
      `INSERT INTO principals (id, tenant_id, kind, user_id, display_name, status, authz_version)
       VALUES (?, ?, 'user', ?, 'Seed Admin', 'active', 1)
       ON DUPLICATE KEY UPDATE
         display_name = VALUES(display_name),
         status = VALUES(status),
         updated_at = UTC_TIMESTAMP(6)`,
      [ids.principal, ids.tenant, userId],
    );
    const [principalRows] = await conn.query(
      `SELECT id FROM principals WHERE tenant_id = ? AND user_id = ? AND kind = 'user' LIMIT 1`,
      [ids.tenant, userId],
    );
    const principalId = principalRows[0]?.id ?? ids.principal;
    await conn.query(
      `INSERT INTO principal_role_bindings (
         id, tenant_id, principal_id, role_id, data_scope, scope_org_id,
         scope_dept_id, expires_at, granted_by_principal_id, can_delegate,
         grantor_approval_ref, status, resolution, resolution_reason, source,
         created_by_user_id
       ) VALUES (?, ?, ?, ?, 'tenant', NULL, NULL, NULL, NULL, 1, NULL, 'active', 'resolved', NULL, 'legacy', ?)
       ON DUPLICATE KEY UPDATE
         principal_id = VALUES(principal_id),
         role_id = VALUES(role_id),
         data_scope = 'tenant',
         scope_org_id = NULL,
         scope_dept_id = NULL,
         can_delegate = VALUES(can_delegate),
         status = 'active',
         resolution = 'resolved',
         resolution_reason = NULL,
         updated_at = UTC_TIMESTAMP(6)`,
      [ids.binding, ids.tenant, principalId, roleId, userId],
    );

    await conn.commit();
    console.log("Seed complete (mysql): default tenant + admin + super_admin.");
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    await conn.end();
  }
}

main().catch((error) => {
  console.error("Seed failed:", error);
  process.exitCode = 1;
});
