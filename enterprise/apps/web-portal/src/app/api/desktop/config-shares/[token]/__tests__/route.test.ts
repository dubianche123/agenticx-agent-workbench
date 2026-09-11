import { beforeEach, describe, expect, it, vi } from "vitest";
import { v2ExpertManifest } from "../../../../../../lib/config-share-test-fixtures";

const resolveDesktopIdentity = vi.fn();
const get = vi.fn();
const revoke = vi.fn();

vi.mock("../../../../../../lib/desktop-auth", () => ({
  resolveDesktopIdentity: (...args: unknown[]) => resolveDesktopIdentity(...args),
}));

vi.mock("../../../../../../lib/config-shares/store", () => ({
  defaultConfigShareStore: {
    get: (...args: unknown[]) => get(...args),
    revoke: (...args: unknown[]) => revoke(...args),
  },
}));

const token = "B".repeat(32);
const identity = {
  userId: "user-a",
  tenantId: "tenant-a",
  deptId: null,
  email: "alice@example.invalid",
  displayName: "Alice",
  tokenId: 1,
  scopes: ["workspace:chat", "desktop:managed"],
};
const snapshot = {
  token,
  tenantId: "tenant-a",
  userId: "user-a",
  ownerDisplayName: "Alice",
  kind: "expert",
  manifestVersion: 2,
  title: "投研专家",
  manifest: v2ExpertManifest(),
  createdAt: "2026-08-28T00:00:00.000Z",
};

function request(method = "GET") {
  return new Request(`https://portal.example.invalid/api/desktop/config-shares/${token}`, {
    method,
  });
}

describe("/api/desktop/config-shares/[token]", () => {
  beforeEach(() => {
    resolveDesktopIdentity.mockReset().mockResolvedValue(identity);
    get.mockReset().mockResolvedValue(snapshot);
    revoke.mockReset().mockResolvedValue(true);
  });

  it("fetches only with the PAT-derived tenant", async () => {
    const { GET } = await import("../route");
    const response = await GET(request(), { params: Promise.resolve({ token }) });
    expect(response.status).toBe(200);
    expect(get).toHaveBeenCalledWith(token, "tenant-a");
    expect((await response.json()).data.snapshot.manifest).toEqual(snapshot.manifest);
  });

  it("returns the same 404 for absent, revoked, or foreign snapshots", async () => {
    get.mockResolvedValue(null);
    const { GET } = await import("../route");
    const response = await GET(request(), { params: Promise.resolve({ token }) });
    expect(response.status).toBe(404);
  });

  it("revokes only as the PAT-derived author and tenant", async () => {
    const { DELETE } = await import("../route");
    const response = await DELETE(request("DELETE"), { params: Promise.resolve({ token }) });
    expect(response.status).toBe(200);
    expect(revoke).toHaveBeenCalledWith(token, "tenant-a", "user-a");

    revoke.mockResolvedValue(false);
    expect(
      (await DELETE(request("DELETE"), { params: Promise.resolve({ token }) })).status,
    ).toBe(404);
  });

  it("does not consult the store without a valid Desktop identity", async () => {
    resolveDesktopIdentity.mockResolvedValue(null);
    const { GET } = await import("../route");
    expect((await GET(request(), { params: Promise.resolve({ token }) })).status).toBe(401);
    expect(get).not.toHaveBeenCalled();
  });
});
