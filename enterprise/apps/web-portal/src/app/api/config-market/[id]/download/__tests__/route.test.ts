import { beforeEach, describe, expect, it, vi } from "vitest";
import { v2ExpertManifest } from "../../../../../../lib/config-share-test-fixtures";

const getSessionFromCookies = vi.fn();
const resolveLiveConfigMarketViewer = vi.fn();
const getVisible = vi.fn();

vi.mock("../../../../../../lib/session", () => ({
  getSessionFromCookies: (...args: unknown[]) => getSessionFromCookies(...args),
  passwordChangeRequiredResponse: () =>
    Response.json({ code: "40302", message: "password_change_required" }, { status: 403 }),
}));
vi.mock("../../../../../../lib/config-market/store", () => ({
  defaultConfigMarketStore: { getVisible: (...args: unknown[]) => getVisible(...args) },
}));
vi.mock("../../../../../../lib/config-market/visibility", () => ({
  resolveLiveConfigMarketViewer: (...args: unknown[]) => resolveLiveConfigMarketViewer(...args),
}));

const id = "01JQMZ8K3N4P5Q6R7S8T9VWXYZ";
const manifest = v2ExpertManifest();

describe("browser config market download", () => {
  beforeEach(() => {
    getSessionFromCookies.mockReset().mockResolvedValue({
      tenantId: "tenant-a",
      userId: "viewer-a",
      mustChangePassword: false,
    });
    resolveLiveConfigMarketViewer.mockReset().mockResolvedValue({
      tenantId: "tenant-a",
      userId: "viewer-a",
      deptId: "dept-live",
    });
    getVisible.mockReset().mockResolvedValue({
      id,
      tenantId: "tenant-a",
      userId: "author-a",
      ownerDisplayName: "Alice",
      kind: "expert",
      sourceArtifactId: manifest.artifact_id,
      manifestVersion: 2,
      releaseId: "01JQMZ8K3N4P5Q6R7S8T9VWXY1",
      version: manifest.release_version,
      title: "投研专家",
      description: "分析公告",
      digest: "a".repeat(64),
      raw: manifest,
      releaseNotes: "首次发布",
      releasePublishedAt: "2026-08-28T00:00:00.000Z",
      status: "published",
      visibility: "users",
      visibleDepartmentIds: [],
      visibleUserIds: ["01JQMZ8K3N4P5Q6R7S8T9VWXY0"],
      publishedAt: "2026-08-28T00:00:00.000Z",
      unlistedAt: null,
      createdAt: "2026-08-28T00:00:00.000Z",
      updatedAt: "2026-08-28T00:00:00.000Z",
    });
  });

  it("downloads only raw after cookie tenant and live published checks", async () => {
    const { GET } = await import("../route");
    const response = await GET(new Request(`https://portal.example.invalid/config-market/${id}`), {
      params: Promise.resolve({ id }),
    });
    expect(response.status).toBe(200);
    expect(getVisible).toHaveBeenCalledWith(id, {
      tenantId: "tenant-a",
      userId: "viewer-a",
      deptId: "dept-live",
    });
    expect(JSON.parse(await response.text())).toEqual(manifest);
    expect(response.headers.get("content-disposition")).toContain(".agx-expert.json");
  });

  it("returns 401 without login and 404 for foreign or unlisted items", async () => {
    const { GET } = await import("../route");
    getSessionFromCookies.mockResolvedValue(null);
    expect(
      (await GET(new Request("https://portal.example.invalid/x"), { params: Promise.resolve({ id }) }))
        .status,
    ).toBe(401);

    getSessionFromCookies.mockResolvedValue({
      tenantId: "tenant-b",
      userId: "viewer-b",
      mustChangePassword: false,
    });
    resolveLiveConfigMarketViewer.mockResolvedValue({
      tenantId: "tenant-b",
      userId: "viewer-b",
      deptId: null,
    });
    getVisible.mockResolvedValue(null);
    expect(
      (await GET(new Request("https://portal.example.invalid/x"), { params: Promise.resolve({ id }) }))
        .status,
    ).toBe(404);
    expect(getVisible).toHaveBeenCalledWith(id, {
      tenantId: "tenant-b",
      userId: "viewer-b",
      deptId: null,
    });
  });

  it("fails closed when the cookie is valid but the live user cannot be loaded", async () => {
    resolveLiveConfigMarketViewer.mockResolvedValueOnce(null);
    const { GET } = await import("../route");
    const response = await GET(new Request("https://portal.example.invalid/x"), {
      params: Promise.resolve({ id }),
    });
    expect(response.status).toBe(404);
    expect(getVisible).not.toHaveBeenCalled();
  });
});
