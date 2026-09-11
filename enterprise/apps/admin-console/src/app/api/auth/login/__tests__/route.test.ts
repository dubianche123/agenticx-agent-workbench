import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ADMIN_LOGIN_FAILURE_MESSAGE } from "../../../../../lib/admin-login-failure-message";
import { POST } from "../route";

const originalEnv = { ...process.env };

function request(email: string, password: string): Request {
  return new Request("https://admin.example.invalid/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
}

async function read(response: Response): Promise<{ status: number; body: unknown }> {
  return { status: response.status, body: await response.json() };
}

describe("POST /api/auth/login", () => {
  beforeEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
    (process.env as Record<string, string | undefined>).NODE_ENV = "test";
    delete process.env.DATABASE_URL;
    process.env.DEFAULT_TENANT_ID = "tenant-a";
    process.env.ADMIN_CONSOLE_LOGIN_EMAIL = "admin@example.invalid";
    process.env.ADMIN_CONSOLE_LOGIN_PASSWORD = "correct-password";
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  });

  it("returns one identical generic response for unknown, wrong-password, and locked attempts", async () => {
    const existing = await read(await POST(request("admin@example.invalid", "wrong-password")));
    const unknown = await read(await POST(request("missing@example.invalid", "wrong-password")));

    expect(existing).toEqual({
      status: 401,
      body: { code: "40100", message: ADMIN_LOGIN_FAILURE_MESSAGE },
    });
    expect(unknown).toEqual(existing);

    for (let attempt = 1; attempt < 10; attempt += 1) {
      await POST(request("admin@example.invalid", "wrong-password"));
    }
    const locked = await read(await POST(request("admin@example.invalid", "wrong-password")));
    const unknownAfterLock = await read(await POST(request("missing@example.invalid", "wrong-password")));

    expect(locked).toEqual(existing);
    expect(unknownAfterLock).toEqual(existing);
    expect(locked.body).not.toHaveProperty("data");
  });
});
