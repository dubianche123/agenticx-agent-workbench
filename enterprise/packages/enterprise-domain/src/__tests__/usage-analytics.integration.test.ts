import { describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { createRequire } from "node:module";
import { ulid } from "ulid";
import type { ActionRequestContext, JsonObject } from "@agenticx/action-runtime";
import { __resetDatabaseForTests, getPrincipal, getPrincipalForUser } from "@agenticx/iam-core";
import { createEnterpriseDomain } from "../domain";

/**
 * Real SQL acceptance for FR3. Run explicitly with the two disposable URLs:
 *
 *   set -a; source /private/tmp/.../connections.env; set +a
 *   pnpm --dir enterprise/packages/enterprise-domain test -- \
 *     src/__tests__/usage-analytics.integration.test.ts
 *
 * The test is skipped without both variables so the normal package suite never
 * falls back to a developer's DATABASE_URL. It creates and removes only its
 * own ULID tenants in the supplied acceptance databases.
 */

type Dialect = "postgresql" | "mysql";

type FixtureDb = {
  query: (statement: string, params?: unknown[]) => Promise<unknown[]>;
  close: () => Promise<void>;
};

type PgClient = {
  connect: () => Promise<void>;
  query: (statement: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
  end: () => Promise<void>;
};

const require = createRequire(import.meta.url);

type FixtureIds = {
  tenantA: string;
  tenantB: string;
  orgA: string;
  orgB: string;
  deptARoot: string;
  deptAChild: string;
  deptBRoot: string;
  actorUser: string;
  peerUser: string;
  rootUser: string;
  otherTenantUser: string;
  actorPrincipal: string;
  peerPrincipal: string;
  rootPrincipal: string;
  otherTenantPrincipal: string;
  agentPrincipal: string;
  actorRole: string;
  peerRole: string;
  rootRole: string;
  otherTenantRole: string;
  agentRole: string;
  actorBinding: string;
  peerBinding: string;
  rootBinding: string;
  otherTenantBinding: string;
  agentBinding: string;
};

const mysqlUrl = process.env.ONTOLOGY_TEST_MYSQL_URL?.trim();
const postgresUrl = process.env.ONTOLOGY_TEST_PG_URL?.trim();

function postgresPlaceholders(statement: string): string {
  let index = 0;
  return statement.replace(/\?/g, () => `$${++index}`);
}

async function connectFixtureDb(dialect: Dialect, url: string): Promise<FixtureDb> {
  if (dialect === "postgresql") {
    const { Client } = require("pg") as { Client: new (options: { connectionString: string }) => PgClient };
    const client = new Client({ connectionString: url });
    await client.connect();
    return {
      query: async (statement, params = []) => {
        const result = await client.query(postgresPlaceholders(statement), params);
        return result.rows;
      },
      close: async () => client.end(),
    };
  }

  const connection = await mysql.createConnection(url);
  return {
    query: async (statement, params = []) => {
      const [rows] = await connection.execute(statement, params as any[]);
      return Array.isArray(rows) ? rows : [];
    },
    close: async () => connection.end(),
  };
}

function newFixtureIds(): FixtureIds {
  return {
    tenantA: ulid(),
    tenantB: ulid(),
    orgA: ulid(),
    orgB: ulid(),
    deptARoot: ulid(),
    deptAChild: ulid(),
    deptBRoot: ulid(),
    actorUser: ulid(),
    peerUser: ulid(),
    rootUser: ulid(),
    otherTenantUser: ulid(),
    actorPrincipal: ulid(),
    peerPrincipal: ulid(),
    rootPrincipal: ulid(),
    otherTenantPrincipal: ulid(),
    agentPrincipal: ulid(),
    actorRole: ulid(),
    peerRole: ulid(),
    rootRole: ulid(),
    otherTenantRole: ulid(),
    agentRole: ulid(),
    actorBinding: ulid(),
    peerBinding: ulid(),
    rootBinding: ulid(),
    otherTenantBinding: ulid(),
    agentBinding: ulid(),
  };
}

async function seedFixture(db: FixtureDb, dialect: Dialect): Promise<FixtureIds> {
  const ids = newFixtureIds();
  const now = new Date("2026-09-10T12:00:00.000Z");

  await db.query(
    "insert into tenants (id, code, name) values (?, ?, ?), (?, ?, ?)",
    [ids.tenantA, `fixture-${ids.tenantA}`, "Fixture tenant A", ids.tenantB, `fixture-${ids.tenantB}`, "Fixture tenant B"],
  );
  await db.query(
    "insert into organizations (id, tenant_id, name) values (?, ?, ?), (?, ?, ?)",
    [ids.orgA, ids.tenantA, "Fixture org A", ids.orgB, ids.tenantB, "Fixture org B"],
  );
  await db.query(
    "insert into departments (id, tenant_id, org_id, parent_id, name, path) values (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?)",
    [
      ids.deptARoot, ids.tenantA, ids.orgA, null, "A Root", "/a-root",
      ids.deptAChild, ids.tenantA, ids.orgA, ids.deptARoot, "A Child", "/a-root/a-child",
      ids.deptBRoot, ids.tenantB, ids.orgB, null, "B Root", "/b-root",
    ],
  );

  const users = [
    [ids.actorUser, ids.tenantA, ids.deptAChild, "actor@fixture.invalid", "Actor Ada"],
    [ids.peerUser, ids.tenantA, ids.deptAChild, "peer@fixture.invalid", "Peer Bo"],
    [ids.rootUser, ids.tenantA, ids.deptARoot, "root@fixture.invalid", "Root Cy"],
    [ids.otherTenantUser, ids.tenantB, ids.deptBRoot, "other@fixture.invalid", "Other Dee"],
  ] as const;
  for (const [id, tenantId, deptId, email, displayName] of users) {
    await db.query(
      "insert into users (id, tenant_id, dept_id, email, display_name, password_hash, status, is_deleted, deleted_at) values (?, ?, ?, ?, ?, ?, 'active', ?, ?)",
      [id, tenantId, deptId, email, displayName, "fixture-password-hash", false, null],
    );
  }

  await db.query(
    "insert into principals (id, tenant_id, kind, user_id, display_name, status, authz_version) values (?, ?, 'user', ?, ?, 'active', 1), (?, ?, 'user', ?, ?, 'active', 1), (?, ?, 'user', ?, ?, 'active', 1), (?, ?, 'user', ?, ?, 'active', 1), (?, ?, 'agent', ?, ?, 'active', 1)",
    [
      ids.actorPrincipal, ids.tenantA, ids.actorUser, "Actor Ada",
      ids.peerPrincipal, ids.tenantA, ids.peerUser, "Peer Bo",
      ids.rootPrincipal, ids.tenantA, ids.rootUser, "Root Cy",
      ids.otherTenantPrincipal, ids.tenantB, ids.otherTenantUser, "Other Dee",
      ids.agentPrincipal, ids.tenantA, null, "Ada's delegated assistant",
    ],
  );
  await db.query(
    "insert into agent_profiles (principal_id, tenant_id, mode, owner_user_id, definition_ref, definition_version) values (?, ?, 'delegated', ?, ?, 1)",
    [ids.agentPrincipal, ids.tenantA, ids.actorUser, "fixture-agent"],
  );

  const roles = [
    [ids.actorRole, ids.tenantA, "fixture-actor", "Fixture actor", ["metering:read", "user:read", "gateway:read"]],
    [ids.peerRole, ids.tenantA, "fixture-peer", "Fixture peer", ["metering:read", "user:read"]],
    [ids.rootRole, ids.tenantA, "fixture-root", "Fixture root subtree", ["metering:read", "user:read", "gateway:read"]],
    [ids.otherTenantRole, ids.tenantB, "fixture-other", "Fixture other", ["metering:read", "user:read", "gateway:read"]],
    [ids.agentRole, ids.tenantA, "fixture-agent", "Fixture agent child ceiling", ["metering:read"]],
  ] as const;
  for (const [id, tenantId, code, name, scopes] of roles) {
    const statement = dialect === "postgresql"
      ? "insert into roles (id, tenant_id, code, name, scopes, immutable) values (?, ?, ?, ?, ?::jsonb, ?)"
      : "insert into roles (id, tenant_id, code, name, scopes, immutable) values (?, ?, ?, ?, ?, ?)";
    await db.query(statement, [id, tenantId, code, name, JSON.stringify(scopes), false]);
  }

  const bindings = [
    [ids.actorBinding, ids.tenantA, ids.actorPrincipal, ids.actorRole, "tenant", null, null, null, ids.actorPrincipal, true, "explicit", ids.actorUser],
    [ids.peerBinding, ids.tenantA, ids.peerPrincipal, ids.peerRole, "self", null, null, null, ids.actorPrincipal, false, "explicit", ids.actorUser],
    [ids.rootBinding, ids.tenantA, ids.rootPrincipal, ids.rootRole, "department_subtree", null, ids.deptARoot, null, ids.actorPrincipal, false, "explicit", ids.actorUser],
    [ids.otherTenantBinding, ids.tenantB, ids.otherTenantPrincipal, ids.otherTenantRole, "tenant", null, null, null, ids.otherTenantPrincipal, true, "explicit", ids.otherTenantUser],
    [ids.agentBinding, ids.tenantA, ids.agentPrincipal, ids.agentRole, "department", null, ids.deptAChild, null, ids.actorPrincipal, false, "explicit", ids.actorUser],
  ] as const;
  for (const [id, tenantId, principalId, roleId, dataScope, scopeOrgId, scopeDeptId, expiresAt, grantedByPrincipalId, canDelegate, source, createdByUserId] of bindings) {
    await db.query(
      "insert into principal_role_bindings (id, tenant_id, principal_id, role_id, data_scope, scope_org_id, scope_dept_id, expires_at, granted_by_principal_id, can_delegate, status, resolution, source, created_by_user_id) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 'resolved', ?, ?)",
      [id, tenantId, principalId, roleId, dataScope, scopeOrgId, scopeDeptId, expiresAt, grantedByPrincipalId, canDelegate, source, createdByUserId],
    );
  }

  const usage = [
    [ids.tenantA, ids.deptAChild, ids.actorUser, "model-tie", 100],
    [ids.tenantA, ids.deptAChild, ids.peerUser, "model-tie", 100],
    [ids.tenantA, ids.deptARoot, ids.rootUser, "model-root", 50],
    [ids.tenantA, null, null, "model-null", 25],
    [ids.tenantB, ids.deptBRoot, ids.otherTenantUser, "model-other", 999],
  ] as const;
  for (const [tenantId, deptId, userId, model, totalTokens] of usage) {
    await db.query(
      "insert into usage_records (id, tenant_id, dept_id, user_id, provider, model, route, time_bucket, input_tokens, output_tokens, total_tokens, cost_usd) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [ulid(), tenantId, deptId, userId, "fixture-provider", model, "chat", now, Math.floor(totalTokens / 2), totalTokens - Math.floor(totalTokens / 2), totalTokens, "0"],
    );
  }

  return ids;
}

async function cleanupFixture(db: FixtureDb, ids: FixtureIds): Promise<void> {
  const tenantIds = [ids.tenantA, ids.tenantB];
  await db.query("delete from principal_role_bindings where tenant_id in (?, ?)", tenantIds);
  await db.query("delete from agent_profiles where tenant_id in (?, ?)", tenantIds);
  await db.query("delete from principals where tenant_id in (?, ?)", tenantIds);
  await db.query("delete from roles where tenant_id in (?, ?)", tenantIds);
  await db.query("delete from usage_records where tenant_id in (?, ?)", tenantIds);
  await db.query("delete from users where tenant_id in (?, ?)", tenantIds);
  await db.query("delete from departments where tenant_id in (?, ?)", tenantIds);
  await db.query("delete from organizations where tenant_id in (?, ?)", tenantIds);
  await db.query("delete from tenants where id in (?, ?)", tenantIds);
}

async function requestFor(
  tenantId: string,
  userId: string,
  agentPrincipalId = "",
): Promise<ActionRequestContext> {
  const principal = agentPrincipalId
    ? await getPrincipal(tenantId, agentPrincipalId)
    : await getPrincipalForUser(tenantId, userId);
  if (!principal) throw new Error("fixture principal was not created");
  return {
    tenantId,
    userId,
    agentPrincipalId,
    sessionId: `fixture-session-${userId}`,
    permissionMode: "auto",
    authorizationVersion: `fixture-${principal.authzVersion}`,
    principal,
  };
}

function groups(result: JsonObject): Array<Record<string, unknown>> {
  return Array.isArray(result.groups)
    ? result.groups.filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value))
    : [];
}

function analyticsArgs(overrides: JsonObject = {}): JsonObject {
  return {
    start: "2026-09-01T00:00:00.000Z",
    end: "2026-09-11T00:00:00.000Z",
    groupBy: "user",
    metric: "totalTokens",
    order: "desc",
    limit: 100,
    ...overrides,
  };
}

const runIntegration = Boolean(mysqlUrl && postgresUrl) ? it : it.skip;

describe("FR3 usage.analytics.read real SQL acceptance", () => {
  runIntegration("enforces tenant, self, department, subtree, ceiling, labels, and stable Top-N on both dialects", async () => {
    const originalDatabaseUrl = process.env.DATABASE_URL;
    const originalDatabaseDialect = process.env.DATABASE_DIALECT;
    const cases: Array<[Dialect, string]> = [
      ["postgresql", postgresUrl!],
      ["mysql", mysqlUrl!],
    ];

    try {
      for (const [dialect, url] of cases) {
        process.env.DATABASE_URL = url;
        process.env.DATABASE_DIALECT = dialect;
        await __resetDatabaseForTests();
        const db = await connectFixtureDb(dialect, url);
        let ids: FixtureIds | null = null;
        try {
          const fixture = await seedFixture(db, dialect);
          ids = fixture;
          const domain = createEnterpriseDomain();
          const actorRequest = await requestFor(fixture.tenantA, fixture.actorUser);
          const peerRequest = await requestFor(fixture.tenantA, fixture.peerUser);
          const rootRequest = await requestFor(fixture.tenantA, fixture.rootUser);
          const otherRequest = await requestFor(fixture.tenantB, fixture.otherTenantUser);
          const agentRequest = await requestFor(fixture.tenantA, fixture.actorUser, fixture.agentPrincipal);

          const ownerResult = await domain.readUsageAnalytics(actorRequest, analyticsArgs());
          const ownerGroups = groups(ownerResult);
          expect(ownerResult.total).toBe(275);
          expect(ownerResult.coverage).toMatchObject({ recordCount: 4, returnedGroups: 4 });
          expect(ownerGroups.map((group) => group.key)).toEqual(expect.arrayContaining([ids.actorUser, ids.peerUser, ids.rootUser, null]));
          expect(ownerGroups.map((group) => group.key)).not.toContain(ids.otherTenantUser);
          expect(ownerGroups.find((group) => group.key === fixture.actorUser)).toMatchObject({
            label: "Actor Ada",
            displayName: "Actor Ada",
            departmentId: ids.deptAChild,
            departmentName: "A Child",
            identityVisible: true,
          });
          expect(ownerGroups.find((group) => group.key === null)).toMatchObject({ label: null, displayName: null, identityVisible: false });
          const ownerTies = ownerGroups.filter((group) => group.value === 100).map((group) => group.key).sort();
          expect(ownerTies).toEqual([ids.actorUser, ids.peerUser].sort());

          const topTwo = groups(await domain.readUsageAnalytics(actorRequest, analyticsArgs({ limit: 2 })));
          expect(topTwo).toHaveLength(2);
          expect(topTwo.map((group) => group.key).sort()).toEqual([ids.actorUser, ids.peerUser].sort());

          const ascGroups = groups(await domain.readUsageAnalytics(actorRequest, analyticsArgs({ order: "asc" })));
          expect(ascGroups.map((group) => Number(group.value))).toEqual([25, 50, 100, 100]);
          expect(ascGroups.at(-1)?.key).toBe(ids.actorUser > ids.peerUser ? ids.actorUser : ids.peerUser);

          const subtreeGroups = groups(await domain.readUsageAnalytics(rootRequest, analyticsArgs()));
          expect(subtreeGroups.map((group) => group.key)).toEqual(expect.arrayContaining([ids.actorUser, ids.peerUser, ids.rootUser]));
          expect(subtreeGroups.map((group) => group.key)).not.toContain(null);
          expect(subtreeGroups.map((group) => group.key)).not.toContain(ids.otherTenantUser);
          expect(subtreeGroups.reduce((sum, group) => sum + Number(group.value), 0)).toBe(250);

          const selfGroups = groups(await domain.readUsageAnalytics(peerRequest, analyticsArgs()));
          expect(selfGroups).toHaveLength(1);
          expect(selfGroups[0]).toMatchObject({ key: ids.peerUser, value: 100, label: "Peer Bo", identityVisible: true });

          const delegatedGroups = groups(await domain.readUsageAnalytics(agentRequest, analyticsArgs()));
          expect(delegatedGroups.map((group) => group.key).sort()).toEqual([ids.actorUser, ids.peerUser].sort());
          expect(delegatedGroups.reduce((sum, group) => sum + Number(group.value), 0)).toBe(200);
          for (const group of delegatedGroups) {
            expect(group).toMatchObject({ label: group.key, displayName: group.key, identityVisible: false });
          }

          const departmentGroups = groups(await domain.readUsageAnalytics(rootRequest, analyticsArgs({ groupBy: "department" })));
          expect(departmentGroups.map((group) => group.key)).toEqual(expect.arrayContaining([ids.deptARoot, ids.deptAChild]));
          expect(departmentGroups.map((group) => group.key)).not.toContain(ids.deptBRoot);
          expect(departmentGroups.find((group) => group.key === fixture.deptAChild)).toMatchObject({ label: "A Child", departmentName: "A Child", identityVisible: true });

          const modelGroups = groups(await domain.readUsageAnalytics(actorRequest, analyticsArgs({ groupBy: "model", order: "desc" })));
          expect(modelGroups.find((group) => group.key === "model-tie")).toMatchObject({ value: 200, label: "model-tie", displayName: "model-tie", identityVisible: true });
          expect(modelGroups.map((group) => group.key)).not.toContain("model-other");

          const otherTenantResult = await domain.readUsageAnalytics(otherRequest, analyticsArgs());
          expect(otherTenantResult.total).toBe(999);
          expect(groups(otherTenantResult).map((group) => group.key)).toEqual([ids.otherTenantUser]);

          const overview = await domain.readEnterpriseOverview(actorRequest);
          expect(overview).toMatchObject({ tenantId: ids.tenantA, usageSummary: { totalTokens: 275, recordCount: 4 } });
          await expect(domain.readEnterpriseOverview(peerRequest)).rejects.toMatchObject({ code: "ACTION_FORBIDDEN" });

          await db.query("update principal_role_bindings set status = 'revoked' where id = ?", [ids.peerBinding]);
          await expect(domain.readUsageAnalytics(peerRequest, analyticsArgs())).rejects.toMatchObject({ code: "ACTION_FORBIDDEN" });

          await db.query("update principal_role_bindings set expires_at = ? where id = ?", [new Date("2020-01-01T00:00:00.000Z"), ids.agentBinding]);
          await expect(domain.readUsageAnalytics(agentRequest, analyticsArgs())).rejects.toMatchObject({ code: "ACTION_FORBIDDEN" });
        } finally {
          if (ids) await cleanupFixture(db, ids);
          await db.close();
          await __resetDatabaseForTests();
        }
      }
    } finally {
      if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = originalDatabaseUrl;
      if (originalDatabaseDialect === undefined) delete process.env.DATABASE_DIALECT;
      else process.env.DATABASE_DIALECT = originalDatabaseDialect;
      await __resetDatabaseForTests();
    }
  });
});
