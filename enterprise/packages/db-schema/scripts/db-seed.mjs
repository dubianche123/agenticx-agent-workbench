import { Client } from "pg";
import bcrypt from "bcryptjs";
import { pgSeedClientOptions } from "./pg-seed-client-config.mjs";

const databaseUrl = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/agenticx";

const ids = {
  tenant: "01J00000000000000000000001",
  org: "01J00000000000000000000002",
  dept: "01J00000000000000000000003",
  user: "01J00000000000000000000004",
  role: "01J00000000000000000000005",
  principal: "01J00000000000000000000006",
  binding: "01J00000000000000000000007",
};

async function main() {
  const client = new Client(pgSeedClientOptions(databaseUrl));
  await client.connect();
  const seedPassword = process.env.AUTH_DEV_OWNER_PASSWORD?.trim() || "change-me-in-development";
  const passwordHash = await bcrypt.hash(seedPassword, 12);

  try {
    await client.query("BEGIN");

    await client.query(
      `
      INSERT INTO tenants (id, code, name, plan)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (code) DO UPDATE SET
        name = EXCLUDED.name,
        plan = EXCLUDED.plan,
        updated_at = now()
      `,
      [ids.tenant, "default", "Default Tenant", "enterprise"]
    );

    await client.query(
      `
      INSERT INTO organizations (id, tenant_id, name)
      VALUES ($1, $2, $3)
      ON CONFLICT (tenant_id, name) DO UPDATE SET
        updated_at = now()
      `,
      [ids.org, ids.tenant, "总部"]
    );

    await client.query(
      `
      INSERT INTO departments (id, tenant_id, org_id, parent_id, name, path)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (tenant_id, path) DO UPDATE SET
        name = EXCLUDED.name,
        updated_at = now()
      `,
      [ids.dept, ids.tenant, ids.org, null, "平台研发部", "/总部/平台研发部/"]
    );

    await client.query(
      `
      INSERT INTO users (id, tenant_id, dept_id, email, display_name, password_hash, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (tenant_id, email) WHERE is_deleted = false AND deleted_at IS NULL DO UPDATE SET
        display_name = EXCLUDED.display_name,
        password_hash = EXCLUDED.password_hash,
        status = EXCLUDED.status,
        updated_at = now()
      `,
      [ids.user, ids.tenant, ids.dept, "admin@agenticx.local", "Seed Admin", passwordHash, "active"]
    );

    await client.query(
      `
      INSERT INTO roles (id, tenant_id, code, name, scopes, immutable)
      VALUES ($1, $2, $3, $4, $5::jsonb, $6)
      ON CONFLICT (tenant_id, code) DO UPDATE SET
        name = EXCLUDED.name,
        scopes = EXCLUDED.scopes,
        immutable = EXCLUDED.immutable,
        updated_at = now()
      `,
      [ids.role, ids.tenant, "super_admin", "Super Admin", JSON.stringify(["*"]), true]
    );

    const userRow = await client.query(
      `SELECT id FROM users WHERE tenant_id = $1 AND email = $2 AND is_deleted = false AND deleted_at IS NULL LIMIT 1`,
      [ids.tenant, "admin@agenticx.local"],
    );
    const userId = userRow.rows[0]?.id ?? ids.user;
    const roleRow = await client.query(
      `SELECT id FROM roles WHERE tenant_id = $1 AND code = $2 LIMIT 1`,
      [ids.tenant, "super_admin"],
    );
    const roleId = roleRow.rows[0]?.id ?? ids.role;

    await client.query(
      `
      INSERT INTO user_roles (tenant_id, user_id, role_id, scope_org_id, scope_dept_id)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (tenant_id, user_id, role_id) DO UPDATE SET
        scope_org_id = EXCLUDED.scope_org_id,
        scope_dept_id = EXCLUDED.scope_dept_id,
        updated_at = now()
      `,
      [ids.tenant, userId, roleId, ids.org, ids.dept]
    );

    // Migration 0044/0070 backfills principals that already exist when the
    // migration runs. Seeds run afterwards, so bootstrap the seed admin's
    // durable principal and effective binding here as part of the same
    // transaction. The auth guards intentionally fail closed without it.
    await client.query(
      `
      INSERT INTO principals (id, tenant_id, kind, user_id, display_name, status, authz_version)
      VALUES ($1, $2, 'user', $3, 'Seed Admin', 'active', 1)
      ON CONFLICT (tenant_id, user_id) DO UPDATE SET
        display_name = EXCLUDED.display_name,
        status = EXCLUDED.status,
        updated_at = now()
      `,
      [ids.principal, ids.tenant, userId],
    );
    const principalRow = await client.query(
      `SELECT id FROM principals WHERE tenant_id = $1 AND user_id = $2 AND kind = 'user' LIMIT 1`,
      [ids.tenant, userId],
    );
    const principalId = principalRow.rows[0]?.id ?? ids.principal;
    await client.query(
      `
      INSERT INTO principal_role_bindings (
        id, tenant_id, principal_id, role_id, data_scope, scope_org_id,
        scope_dept_id, expires_at, granted_by_principal_id, can_delegate,
        grantor_approval_ref, status, resolution, resolution_reason, source,
        created_by_user_id
      )
      VALUES ($1, $2, $3, $4, 'tenant', NULL, NULL, NULL, NULL, true, NULL, 'active', 'resolved', NULL, 'legacy', $5)
      ON CONFLICT (id) DO UPDATE SET
        principal_id = EXCLUDED.principal_id,
        role_id = EXCLUDED.role_id,
        data_scope = EXCLUDED.data_scope,
        scope_org_id = NULL,
        scope_dept_id = NULL,
        can_delegate = EXCLUDED.can_delegate,
        status = 'active',
        resolution = 'resolved',
        resolution_reason = NULL,
        updated_at = now()
      `,
      [ids.binding, ids.tenant, principalId, roleId, userId],
    );

    await client.query("COMMIT");
    console.log("Seed complete: default tenant + admin + super_admin.");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error("Seed failed:", error);
  process.exitCode = 1;
});
