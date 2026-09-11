import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveDesktopIdentity = vi.fn();
const recordDownload = vi.fn();

vi.mock("../../../../../../../lib/desktop-auth", () => ({
  resolveDesktopIdentity: (...args: unknown[]) => resolveDesktopIdentity(...args),
}));
vi.mock("../../../../../../../lib/config-market/store", () => ({
  defaultConfigMarketStore: { recordDownload: (...args: unknown[]) => recordDownload(...args) },
}));

const id = "01JQMZ8K3N4P5Q6R7S8T9VWXYZ";
const releaseId = "01JQMZ8K3N4P5Q6R7S8T9VWXY1";
const identity = {
  userId: "user-a",
  tenantId: "tenant-a",
  deptId: "dept-a",
  email: "alice@example.invalid",
  displayName: "Alice",
  tokenId: 1,
  scopes: ["workspace:chat", "desktop:managed"],
};

function request(body: unknown): Request {
  return new Request(`https://portal.example.invalid/api/desktop/config-market/${id}/downloads`, {
    method: "POST",
    headers: { authorization: "Bearer agx-pat-test", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/desktop/config-market/[id]/downloads", () => {
  beforeEach(() => {
    resolveDesktopIdentity.mockReset().mockResolvedValue(identity);
    recordDownload.mockReset().mockResolvedValue({ counted: true, downloadCount: 1 });
  });

  it("requires a valid managed Desktop identity and scope", async () => {
    const { POST } = await import("../route");
    resolveDesktopIdentity.mockResolvedValueOnce(null);
    await expect(POST(request({ releaseId }), { params: Promise.resolve({ id }) }))
      .resolves.toMatchObject({ status: 401 });
    expect(recordDownload).not.toHaveBeenCalled();

    resolveDesktopIdentity.mockResolvedValueOnce({ ...identity, scopes: ["workspace:chat"] });
    await expect(POST(request({ releaseId }), { params: Promise.resolve({ id }) }))
      .resolves.toMatchObject({ status: 403 });
    expect(recordDownload).not.toHaveBeenCalled();
  });

  it("uses PAT tenant/user only and treats hidden or unknown releases as 404", async () => {
    const { POST } = await import("../route");
    recordDownload.mockResolvedValueOnce(null);
    const hidden = await POST(request({ releaseId }), {
      params: Promise.resolve({ id }),
    });
    expect(hidden.status).toBe(404);
    expect(recordDownload).toHaveBeenCalledWith(id, identity, releaseId);

    const spoof = await POST(request({ releaseId, tenantId: "tenant-b", userId: "attacker" }), {
      params: Promise.resolve({ id }),
    });
    expect(spoof.status).toBe(400);

    recordDownload.mockResolvedValueOnce({ counted: false, downloadCount: 2 });
    const duplicate = await POST(request({ releaseId }), { params: Promise.resolve({ id }) });
    expect(duplicate.status).toBe(200);
    await expect(duplicate.json()).resolves.toMatchObject({
      code: "00000",
      data: { counted: false, downloadCount: 2 },
    });
  });
});
