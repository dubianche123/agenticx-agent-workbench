/**
 * IAM 端到端冒烟（Playwright）
 *
 * 前提：PostgreSQL 已迁移；`bash enterprise/scripts/start-dev.sh` 或手动起 web-portal:3000 + admin-console:3001
 *
 * 运行：
 *   pnpm -C enterprise e2e:iam
 *
 * 环境变量：
 *   ADMIN_BASE_URL（默认 http://127.0.0.1:3001）
 *   ADMIN_CONSOLE_LOGIN_PASSWORD / AUTH_DEV_OWNER_PASSWORD（与 db:seed 一致）
 */
import { chromium } from "playwright";

const ADMIN_BASE = process.env.ADMIN_BASE_URL ?? "http://127.0.0.1:3001";
const ADMIN_PASSWORD =
  process.env.ADMIN_CONSOLE_LOGIN_PASSWORD?.trim() ||
  process.env.AUTH_DEV_OWNER_PASSWORD?.trim() ||
  "change-me-in-development";

async function adminLogin(page: import("playwright").Page): Promise<void> {
  await page.goto(`${ADMIN_BASE}/login`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  // Let the client-side form hydrate before submitting. A DOMContentLoaded-only
  // click can race React's submit handler in a fresh headless browser.
  const loginButton = page.getByRole("button", { name: /登录并进入控制台|Sign in to console/i });
  await loginButton.waitFor({ state: "visible", timeout: 15_000 });
  await page.waitForTimeout(300);
  
  // Explicitly fill email in case it is not autofilled
  const emailInput = page.locator('input[type="email"]').first();
  await emailInput.fill("admin@agenticx.local");
  
  // Fill password
  const passwordInput = page.locator('input[type="password"]').first();
  await passwordInput.fill(ADMIN_PASSWORD);
  
  // Robustly click login button (matches either Chinese or English locale text)
  await loginButton.click();
  // Dashboard is entered through a client-side route change and keeps polling
  // data endpoints in development. Waiting on a browser load event can time
  // out after the URL is already usable, so poll the authoritative URL.
  const deadline = Date.now() + 20_000;
  while (!page.url().includes("/dashboard") && Date.now() < deadline) {
    await page.waitForTimeout(200);
  }
  if (!page.url().includes("/dashboard")) {
    throw new Error(`dashboard navigation timed out at ${page.url()}`);
  }
}

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await adminLogin(page);

    await page.goto(`${ADMIN_BASE}/iam/users`, { waitUntil: "domcontentloaded" });
    // `/iam/users` is a retained bookmark route; the current organization
    // page owns the member view at `/iam/roles`.
    const usersRedirectDeadline = Date.now() + 15_000;
    while (!page.url().includes("/iam/roles") && Date.now() < usersRedirectDeadline) {
      await page.waitForTimeout(200);
    }
    if (!page.url().includes("/iam/roles")) throw new Error(`users compatibility redirect timed out at ${page.url()}`);
    await page.getByText("组织与成员").first().waitFor({ state: "visible", timeout: 15_000 });

    await page.goto(`${ADMIN_BASE}/iam/departments`, { waitUntil: "domcontentloaded" });
    await page.getByText("部门管理").first().waitFor({ state: "visible", timeout: 15_000 });

    await page.goto(`${ADMIN_BASE}/iam/roles`, { waitUntil: "domcontentloaded" });
    await page.getByText("组织与成员").first().waitFor({ state: "visible", timeout: 15_000 });

    await page.goto(`${ADMIN_BASE}/iam/bulk-import`, { waitUntil: "domcontentloaded" });
    await page.getByText("组织与批量开通").first().waitFor({ state: "visible", timeout: 15_000 });

    console.log("[e2e-iam] ok: users, departments, roles, bulk-import pages visible after login");
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error("[e2e-iam] failed:", e);
  process.exitCode = 1;
});
