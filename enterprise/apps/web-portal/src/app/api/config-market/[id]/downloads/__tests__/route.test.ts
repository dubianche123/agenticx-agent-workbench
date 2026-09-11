import { beforeEach, describe, expect, it, vi } from "vitest";

const getSessionFromCookies = vi.fn();
const resolveLiveConfigMarketViewer = vi.fn();
const recordDownload = vi.fn();

vi.mock("../../../../../../lib/session", () => ({
  getSessionFromCookies: (...args: unknown[]) => getSessionFromCookies(...args),
  passwordChangeRequiredResponse: () =>
    Response.json({ code: "40302", message: "password_change_required" }, { status: 403 }),
}));
vi.mock("../../../../../../lib/config-market/visibility", () => ({
  resolveLiveConfigMarketViewer: (...args: unknown[]) => resolveLiveConfigMarketViewer(...args),
}));
vi.mock("../../../../../../lib/config-market/store", () => ({
  defaultConfigMarketStore: { recordDownload: (...args: unknown[]) => recordDownload(...args) },
}));

const id = "01JQMZ8K3N4P5Q6R7S8T9VWXYZ";
const releaseId = "01JQMZ8K3N4P5Q6R7S8T9VWXY1";
const session = { tenantId: "tenant-a", userId: "viewer-a", mustChangePassword: false };
const viewer = { tenantId: "tenant-a", userId: "viewer-a", deptId: "dept-live" };

function request(body: unknown): Request {
  return new Request(`https://portal.example.invalid/api/config-market/${id}/downloads`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/config-market/[id]/downloads", () => {
  beforeEach(() => {
    getSessionFromCookies.mockReset().mockResolvedValue(session);
    resolveLiveConfigMarketViewer.mockReset().mockResolvedValue(viewer);
    recordDownload.mockReset().mockResolvedValue({ counted: true, downloadCount: 1 });
  });

  it("requires an active cookie-derived viewer and never trusts body identity fields", async () => {
    const { POST } = await import("../route");
    getSessionFromCookies.mockResolvedValueOnce(null);
    await expect(POST(request({ releaseId }), { params: Promise.resolve({ id }) }))
      .resolves.toMatchObject({ status: 401 });
    expect(recordDownload).not.toHaveBeenCalled();

    resolveLiveConfigMarketViewer.mockResolvedValueOnce(null);
    await expect(POST(request({ releaseId }), { params: Promise.resolve({ id }) }))
      .resolves.toMatchObject({ status: 401 });
    expect(recordDownload).not.toHaveBeenCalled();

    const spoof = await POST(
      request({ releaseId, tenantId: "tenant-b", userId: "attacker" }),
      { params: Promise.resolve({ id }) },
    );
    expect(spoof.status).toBe(400);
    expect(recordDownload).not.toHaveBeenCalled();
  });

  it("passes only credential viewer and release id, returning 404 for ACL or release misses", async () => {
    const { POST } = await import("../route");
    recordDownload.mockResolvedValueOnce(null);
    const hidden = await POST(request({ releaseId }), { params: Promise.resolve({ id }) });
    expect(hidden.status).toBe(404);
    expect(recordDownload).toHaveBeenCalledWith(id, viewer, releaseId);

    recordDownload.mockResolvedValueOnce({ counted: false, downloadCount: 3 });
    const duplicate = await POST(request({ releaseId }), { params: Promise.resolve({ id }) });
    expect(duplicate.status).toBe(200);
    await expect(duplicate.json()).resolves.toMatchObject({
      code: "00000",
      data: { counted: false, downloadCount: 3 },
    });
  });
});
