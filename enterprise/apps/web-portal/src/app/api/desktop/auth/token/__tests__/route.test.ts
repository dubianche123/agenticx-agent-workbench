import { beforeEach, describe, expect, it, vi } from "vitest";

const createPat = vi.fn();
const loginAndGetIdentity = vi.fn();

vi.mock("@agenticx/iam-core", () => ({
  createPat: (...args: unknown[]) => createPat(...args),
}));

vi.mock("../../../../../../lib/auth-runtime", () => ({
  loginAndGetIdentity: (...args: unknown[]) => loginAndGetIdentity(...args),
}));

describe("POST /api/desktop/auth/token", () => {
  beforeEach(() => {
    createPat.mockReset();
    loginAndGetIdentity.mockReset();
  });

  it("issues a least-privilege assistant PAT for the authenticated device", async () => {
    loginAndGetIdentity.mockResolvedValue({
      tenantId: "tenant-1",
      userId: "user-1",
      deptId: "dept-1",
      email: "alice@example.invalid",
      displayName: "Alice",
    });
    createPat.mockResolvedValue({
      token: "agx-pat-test",
      record: { id: 9 },
    });

    const { POST } = await import("../route");
    const res = await POST(
      new Request("http://localhost/api/desktop/auth/token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "alice@example.invalid",
          password: "secret",
          deviceName: "Near",
        }),
      }),
    );
    expect(res.status).toBe(200);
    expect(createPat).toHaveBeenCalledTimes(1);

    const [patInput] = createPat.mock.calls[0] as [
      {
        tenantId: string;
        userId: string;
        deptId: string;
        name: string;
        createdBy: string;
        expireDays: number;
        scopes: string[];
      },
    ];
    expect(patInput).toMatchObject({
      tenantId: "tenant-1",
      userId: "user-1",
      deptId: "dept-1",
      name: "AgenticX Ontology Desktop · Near",
      createdBy: "user-1",
      expireDays: 90,
      scopes: ["workspace:chat", "desktop:managed", "assistant:delegate"],
    });
    expect(patInput.scopes.filter((scope) => scope.endsWith(":manage"))).toEqual([]);
    expect(patInput.scopes).not.toContain("admin:enter");
  });

  it("keeps the product label single when the default device name is already branded", async () => {
    loginAndGetIdentity.mockResolvedValue({
      tenantId: "tenant-1",
      userId: "user-1",
      deptId: "dept-1",
      email: "alice@example.invalid",
      displayName: "Alice",
    });
    createPat.mockResolvedValue({ token: "agx-pat-test", record: { id: 10 } });

    const { POST } = await import("../route");
    const res = await POST(
      new Request("http://localhost/api/desktop/auth/token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "alice@example.invalid",
          password: "secret",
          deviceName: "AgenticX Ontology Desktop",
        }),
      }),
    );

    expect(res.status).toBe(200);
    expect(createPat).toHaveBeenCalledWith(
      expect.objectContaining({ name: "AgenticX Ontology Desktop" }),
    );
  });
});
