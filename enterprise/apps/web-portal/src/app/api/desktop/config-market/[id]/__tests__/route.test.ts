import { beforeEach, describe, expect, it, vi } from "vitest";
import { v2ExpertManifest } from "../../../../../../lib/config-share-test-fixtures";

const resolveDesktopIdentity = vi.fn();
const getVisible = vi.fn();

vi.mock("../../../../../../lib/desktop-auth", () => ({
  resolveDesktopIdentity: (...args: unknown[]) => resolveDesktopIdentity(...args),
}));
vi.mock("../../../../../../lib/config-market/store", () => ({
  defaultConfigMarketStore: { getVisible: (...args: unknown[]) => getVisible(...args) },
}));

const id = "01JQMZ8K3N4P5Q6R7S8T9VWXYZ";
const manifest = v2ExpertManifest();
const item = {
  id,
  tenantId: "tenant-a",
  userId: "user-a",
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
};

describe("GET /api/desktop/config-market/[id]", () => {
  beforeEach(() => {
    resolveDesktopIdentity.mockReset().mockResolvedValue({
      userId: "user-a",
      tenantId: "tenant-a",
      deptId: "dept-a",
      scopes: ["desktop:managed"],
    });
    getVisible.mockReset().mockResolvedValue(item);
  });

  it("loads raw only through the PAT-derived tenant", async () => {
    const { GET } = await import("../route");
    const response = await GET(
      new Request(`https://portal.example.invalid/api/desktop/config-market/${id}`),
      { params: Promise.resolve({ id }) },
    );
    expect(response.status).toBe(200);
    expect(getVisible).toHaveBeenCalledWith(id, {
      userId: "user-a",
      tenantId: "tenant-a",
      deptId: "dept-a",
      scopes: ["desktop:managed"],
    });
    const json = await response.json();
    expect(json.data.item).not.toHaveProperty("raw");
    expect(json.data.item).toMatchObject({
      visibility: "users",
      visibleDepartmentCount: 0,
      visibleUserCount: 1,
    });
    expect(json.data.item).not.toHaveProperty("visibleUserIds");
    expect(JSON.parse(json.data.raw)).toEqual(manifest);
  });

  it("returns indistinguishable 404 for foreign or unlisted items", async () => {
    getVisible.mockResolvedValue(null);
    const { GET } = await import("../route");
    const response = await GET(
      new Request(`https://portal.example.invalid/api/desktop/config-market/${id}`),
      { params: Promise.resolve({ id }) },
    );
    expect(response.status).toBe(404);
  });
});
