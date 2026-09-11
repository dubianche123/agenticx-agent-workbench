import { beforeEach, describe, expect, it, vi } from "vitest";
import { v2ExpertManifest } from "../../../../../lib/config-share-test-fixtures";
import { MAX_CONFIG_MARKET_REQUEST_BYTES } from "../../../../../lib/config-market/request";

const resolveDesktopIdentity = vi.fn();
const create = vi.fn();

vi.mock("../../../../../lib/desktop-auth", () => ({
  resolveDesktopIdentity: (...args: unknown[]) => resolveDesktopIdentity(...args),
}));

vi.mock("../../../../../lib/config-shares/store", () => ({
  defaultConfigShareStore: { create: (...args: unknown[]) => create(...args) },
}));

const manifest = v2ExpertManifest();

function identity() {
  return {
    userId: "user-a",
    tenantId: "tenant-from-pat",
    deptId: null,
    email: "alice@example.invalid",
    displayName: "Alice",
    tokenId: 1,
    scopes: ["workspace:chat", "desktop:managed"],
  };
}

function request(body: unknown) {
  return new Request("https://portal.example.invalid/api/desktop/config-shares", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/desktop/config-shares", () => {
  beforeEach(() => {
    resolveDesktopIdentity.mockReset().mockResolvedValue(identity());
    create.mockReset().mockResolvedValue({
      token: "A".repeat(32),
      tenantId: "tenant-from-pat",
      userId: "user-a",
      ownerDisplayName: "Alice",
      kind: "expert",
      manifestVersion: 2,
      title: "投研专家",
      manifest,
      createdAt: "2026-08-28T00:00:00.000Z",
    });
  });

  it("creates an unlisted snapshot using tenant and author from the PAT", async () => {
    const { POST } = await import("../route");
    const response = await POST(
      request({ kind: "expert", manifest_version: 2, manifest }),
    );
    expect(response.status).toBe(201);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "tenant-from-pat",
        userId: "user-a",
        ownerDisplayName: "Alice",
      }),
    );
    const json = await response.json();
    expect(json.data.path).toBe(`/config-share/${"A".repeat(32)}`);
    expect(json.data.share_url).toBe(
      `https://portal.example.invalid/config-share/${"A".repeat(32)}`,
    );
  });

  it("rejects a client-supplied tenant field", async () => {
    const { POST } = await import("../route");
    const response = await POST(
      request({ kind: "expert", manifest_version: 2, manifest, tenant_id: "tenant-b" }),
    );
    expect(response.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it("requires a managed Desktop PAT", async () => {
    const { POST } = await import("../route");
    resolveDesktopIdentity.mockResolvedValue(null);
    expect((await POST(request({ kind: "expert", manifest_version: 2, manifest }))).status).toBe(
      401,
    );

    resolveDesktopIdentity.mockResolvedValue({ ...identity(), scopes: ["workspace:chat"] });
    expect((await POST(request({ kind: "expert", manifest_version: 2, manifest }))).status).toBe(
      403,
    );
  });

  it("blocks secrets and PII before an immutable share snapshot is written", async () => {
    const unsafe = v2ExpertManifest("凭据专家", {
      systemPrompt: "api_key = sk-proj-abcdefghijklmnopqrstuvwxyz123456",
    });
    const { POST } = await import("../route");
    const response = await POST(
      request({ kind: "expert", manifest_version: 2, manifest: unsafe }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "40004",
      data: {
        findings: expect.arrayContaining([
          expect.objectContaining({
            category: "secret",
            field: "manifest.payload.system_prompt",
          }),
        ]),
      },
    });
    expect(create).not.toHaveBeenCalled();
  });

  it("returns 413 when the actual request stream exceeds the shared package limit", async () => {
    const { POST } = await import("../route");
    const response = await POST(
      new Request("https://portal.example.invalid/api/desktop/config-shares", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ padding: "x".repeat(MAX_CONFIG_MARKET_REQUEST_BYTES) }),
      }),
    );
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ code: "41301" });
    expect(create).not.toHaveBeenCalled();
  });
});
