/**
 * Local MySQL + live Portal/Admin acceptance for market download receipts.
 * Run with the local development environment exported and Desktop signed in:
 *   pnpm exec tsx scripts/e2e-market-downloads.ts
 * Uses only localhost, never prints credentials, and removes its own market fixture.
 * With --interactive, verify the Desktop import and then remove that local test
 * expert separately; the script does not have access to Desktop's import result.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import mysql, { type ResultSetHeader } from "mysql2/promise";

const desktopRequire = createRequire(new URL("../../desktop/package.json", import.meta.url));
const yaml = desktopRequire("js-yaml") as { load(raw: string): unknown };
const portal = "http://localhost:3000";
const admin = "http://localhost:3001";
const artifactId = `expert:download-acceptance-${randomUUID()}`;

async function main() {
  const databaseUrl = process.env.DATABASE_URL || "";
  const database = new URL(databaseUrl);
  assert.equal(database.protocol, "mysql:", "acceptance requires MySQL");
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(database.hostname), "local database only");
  const config = yaml.load(readFileSync(resolve(homedir(), ".agenticx/config.yaml"), "utf8")) as {
    enterprise?: { base_url?: string; token?: string; user?: { tenant_id?: string; user_id?: string } };
  };
  const enterprise = config.enterprise;
  assert.equal(new URL(enterprise?.base_url || "").origin, portal, "Desktop must use the local Portal");
  assert.ok(enterprise?.token, "Desktop must be signed in");
  assert.ok(enterprise.user?.tenant_id, "missing local tenant");
  const tenantId = enterprise.user.tenant_id;
  const authorization = `Bearer ${enterprise.token}`;
  const db = await mysql.createConnection(databaseUrl);
  let itemId = "";

  async function request(path: string, init: RequestInit = {}) {
    return fetch(`${portal}${path}`, {
      ...init,
      headers: { authorization, "content-type": "application/json", ...init.headers },
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
  }
  async function publish(version: string) {
    const name = "下载统计验收（自动清理）";
    const response = await request("/api/desktop/config-market", {
      method: "POST",
      body: JSON.stringify({
        manifest: {
          schema_version: 2, artifact_id: artifactId, release_version: version,
          kind: "expert", title: name, description: "仅用于本机下载统计验收。",
          recommended_permission_mode: "ask", dependencies: { skills: [], mcps: [] },
          resources: [], workspace_slots: [],
          payload: {
            name, role: "统计验收", description: "仅用于本机下载统计验收。", tags: [],
            system_prompt: `只回答统计测试。版本 ${version}`, color: "blue", default_permission_mode: "ask",
          },
        },
        visibility: { type: "personal", department_ids: [], user_ids: [] },
      }),
    });
    assert.equal(response.status, 201, "publish fixture");
    const item = (await response.json()).data.item;
    return { id: item.id as string, releaseId: item.release_id as string, downloadCount: item.downloadCount as number };
  }
  async function detail() {
    const response = await request(`/api/desktop/config-market/${itemId}`);
    assert.equal(response.status, 200);
    return (await response.json()).data.item;
  }
  async function receipt(releaseId: string) {
    const response = await request(`/api/desktop/config-market/${itemId}/downloads`, {
      method: "POST", body: JSON.stringify({ releaseId }),
    });
    assert.equal(response.status, 200, "receipt status");
    return (await response.json()).data as { counted: boolean; downloadCount: number };
  }
  async function login(base: string, password: string) {
    const response = await fetch(`${base}/api/auth/login`, {
      method: "POST", headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ email: "admin@agenticx.local", password }),
      redirect: "error", signal: AbortSignal.timeout(30_000),
    });
    assert.equal(response.status, 200, `${base} test login`);
    return response.headers.getSetCookie().map((value) => value.split(";", 1)[0]).join("; ");
  }

  try {
    const first = await publish("1.0.0");
    itemId = first.id;
    assert.equal(first.downloadCount, 0);
    assert.equal((await detail()).downloadCount, 0, "preview must not count");
    const unauthorized = await fetch(`${portal}/api/desktop/config-market/${itemId}/downloads`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ releaseId: first.releaseId }), signal: AbortSignal.timeout(30_000),
    });
    assert.equal(unauthorized.status, 401);
    const wrongRelease = await request(`/api/desktop/config-market/${itemId}/downloads`, {
      method: "POST", body: JSON.stringify({ releaseId: "01J00000000000000000000000" }),
    });
    assert.ok([400, 404, 409].includes(wrongRelease.status), "unknown release must not count");
    assert.equal((await detail()).downloadCount, 0);
    const concurrent = await Promise.all(Array.from({ length: 8 }, () => receipt(first.releaseId)));
    assert.equal(concurrent.filter((value) => value.counted).length, 1, "concurrent retries count once");
    assert.equal((await detail()).downloadCount, 1, "count survives fresh API reads");
    const second = await publish("1.0.1");
    assert.equal(second.id, itemId);
    assert.equal(second.downloadCount, 1, "publishing a release retains historical count");
    assert.equal((await receipt(first.releaseId)).counted, false, "in-flight old-release receipts remain valid");
    assert.equal((await receipt(second.releaseId)).downloadCount, 2);
    assert.equal((await receipt(second.releaseId)).counted, false);

    const password = process.env.AUTH_DEV_OWNER_PASSWORD;
    const adminPassword = process.env.ADMIN_CONSOLE_LOGIN_PASSWORD || password;
    assert.ok(password && adminPassword, "export local test login passwords");
    const cookie = await login(portal, password);
    const download = await fetch(`${portal}/api/config-market/${itemId}/download`, {
      headers: { cookie }, redirect: "error", signal: AbortSignal.timeout(30_000),
    });
    assert.equal(download.status, 200);
    assert.equal(download.headers.get("X-Config-Market-Release-Id"), second.releaseId);
    assert.equal((await download.json()).release_version, "1.0.1");
    assert.equal((await detail()).downloadCount, 2, "download GET alone does not count");
    const webReceipt = await fetch(`${portal}/api/config-market/${itemId}/downloads`, {
      method: "POST", headers: { cookie, origin: portal, "content-type": "application/json" },
      body: JSON.stringify({ releaseId: second.releaseId }), signal: AbortSignal.timeout(30_000),
    });
    assert.equal(webReceipt.status, 200);
    assert.deepEqual((await webReceipt.json()).data, { downloadCount: 2, counted: false });
    const adminCookie = await login(admin, adminPassword);
    const report = await fetch(`${admin}/api/admin/config-market/${itemId}`, {
      headers: { cookie: adminCookie }, signal: AbortSignal.timeout(30_000),
    });
    assert.equal(report.status, 200);
    assert.equal((await report.json()).data.item.downloadCount, 2, "admin sees persisted count");
    console.log("[market-downloads] PASS: MySQL, preview exclusion, auth, release validation, concurrent deduplication, version accumulation, cross-client deduplication, administrator readback");
    if (process.argv.includes("--interactive")) {
      const third = await publish("1.0.2");
      assert.equal(third.downloadCount, 2);
      console.log(`[market-downloads] UI fixture: ${portal}/config-market/${itemId}`);
      const prompt = createInterface({ input: process.stdin, output: process.stdout });
      try {
        await prompt.question("[market-downloads] Import the fixture in Desktop, verify the UI, then press Enter to check count=3 and clean up.\n");
      } finally {
        prompt.close();
      }
      assert.equal((await detail()).downloadCount, 3, "real Desktop import reports third release");
      console.log("[market-downloads] PASS: real Desktop import read back from MySQL");
    }
  } finally {
    // Delete only this run's fixture, even if publication succeeded but response parsing failed.
    const [result] = await db.execute<ResultSetHeader>(
      "DELETE FROM enterprise_config_market_items WHERE tenant_id = ? AND source_artifact_id = ?",
      [tenantId, artifactId],
    );
    console.log(`[market-downloads] removed own fixture: ${result.affectedRows} item(s)`);
    await db.end();
  }
}

main().catch((error) => {
  console.error("[market-downloads] FAIL:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
