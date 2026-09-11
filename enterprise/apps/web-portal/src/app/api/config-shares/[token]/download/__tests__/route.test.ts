import { beforeEach, describe, expect, it, vi } from "vitest";
import { v2ExpertManifest } from "../../../../../../lib/config-share-test-fixtures";

const getSessionFromCookies = vi.fn();
const get = vi.fn();

vi.mock("../../../../../../lib/session", () => ({
  getSessionFromCookies: (...args: unknown[]) => getSessionFromCookies(...args),
  passwordChangeRequiredResponse: () =>
    Response.json({ code: "40302", message: "password_change_required" }, { status: 403 }),
}));

vi.mock("../../../../../../lib/config-shares/store", () => ({
  defaultConfigShareStore: { get: (...args: unknown[]) => get(...args) },
}));

const token = "C".repeat(32);
const manifest = v2ExpertManifest();

describe("browser config share download", () => {
  beforeEach(() => {
    getSessionFromCookies.mockReset().mockResolvedValue({
      tenantId: "tenant-a",
      userId: "viewer-a",
      mustChangePassword: false,
    });
    get.mockReset().mockResolvedValue({
      token,
      tenantId: "tenant-a",
      userId: "author-a",
      ownerDisplayName: "Alice",
      kind: "expert",
      manifestVersion: 2,
      title: "投研专家",
      manifest,
      createdAt: "2026-08-28T00:00:00.000Z",
    });
  });

  it("downloads only the manifest using the cookie-derived tenant", async () => {
    const { GET } = await import("../route");
    const response = await GET(new Request(`https://portal.example.invalid/x/${token}`), {
      params: Promise.resolve({ token }),
    });
    expect(response.status).toBe(200);
    expect(get).toHaveBeenCalledWith(token, "tenant-a");
    expect(JSON.parse(await response.text())).toEqual(manifest);
    expect(response.headers.get("content-disposition")).toContain(".agx-expert.json");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("requires login and returns 404 for inaccessible tenant snapshots", async () => {
    const { GET } = await import("../route");
    getSessionFromCookies.mockResolvedValue(null);
    expect(
      (
        await GET(new Request("https://portal.example.invalid/x"), {
          params: Promise.resolve({ token }),
        })
      ).status,
    ).toBe(401);
    expect(get).not.toHaveBeenCalled();

    getSessionFromCookies.mockResolvedValue({
      tenantId: "tenant-b",
      userId: "viewer-b",
      mustChangePassword: false,
    });
    get.mockResolvedValue(null);
    expect(
      (
        await GET(new Request("https://portal.example.invalid/x"), {
          params: Promise.resolve({ token }),
        })
      ).status,
    ).toBe(404);
    expect(get).toHaveBeenCalledWith(token, "tenant-b");
  });
});
