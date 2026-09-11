import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAdminUser: vi.fn(),
  listDepartmentAncestorIds: vi.fn(),
}));

vi.mock("@agenticx/iam-core", () => ({
  getAdminUser: (...args: unknown[]) => mocks.getAdminUser(...args),
  listDepartmentAncestorIds: (...args: unknown[]) => mocks.listDepartmentAncestorIds(...args),
}));

import type { ConfigMarketItem } from "./types";
import { v2ExpertManifest } from "../config-share-test-fixtures";
import {
  isConfigMarketItemVisible,
  resolveLiveConfigMarketViewer,
} from "./visibility";

const OWNER_ID = "01JQMZ8K3N4P5Q6R7S8T9VWXYZ";
const VIEWER_ID = "01JQMZ8K3N4P5Q6R7S8T9VWXY0";
const OTHER_ID = "01JQMZ8K3N4P5Q6R7S8T9VWXY1";
const ROOT_DEPT = "01JQMZ8K3N4P5Q6R7S8T9VWXY2";
const CHILD_DEPT = "01JQMZ8K3N4P5Q6R7S8T9VWXY3";

const base: ConfigMarketItem = {
  id: "01JQMZ8K3N4P5Q6R7S8T9VWXY4",
  tenantId: "tenant-a",
  userId: OWNER_ID,
  ownerDisplayName: "Alice",
  kind: "expert",
  sourceArtifactId: "expert:test-fixture-001",
  manifestVersion: 2,
  releaseId: "01JQMZ8K3N4P5Q6R7S8T9VWX01",
  version: "1.0.0",
  title: "投研专家",
  description: "分析公告",
  digest: "a".repeat(64),
  raw: v2ExpertManifest(),
  releaseNotes: "",
  releasePublishedAt: "2026-08-28T00:00:00.000Z",
  downloadCount: 0,
  status: "published",
  deliveryState: "active",
  visibility: "company",
  visibleDepartmentIds: [],
  visibleUserIds: [],
  publishedAt: "2026-08-28T00:00:00.000Z",
  unlistedAt: null,
  createdAt: "2026-08-28T00:00:00.000Z",
  updatedAt: "2026-08-28T00:00:00.000Z",
};

const viewer = { tenantId: "tenant-a", userId: VIEWER_ID, deptId: CHILD_DEPT };

describe("config market visibility", () => {
  beforeEach(() => {
    mocks.getAdminUser.mockReset();
    mocks.listDepartmentAncestorIds.mockReset();
  });

  it("supports company, personal uploader, explicit user, and department ancestor visibility", () => {
    expect(isConfigMarketItemVisible(base, viewer, [CHILD_DEPT, ROOT_DEPT])).toBe(true);
    expect(
      isConfigMarketItemVisible(
        { ...base, visibility: "personal", visibleDepartmentIds: [], visibleUserIds: [] },
        { ...viewer, userId: OWNER_ID },
        [],
      ),
    ).toBe(true);
    expect(
      isConfigMarketItemVisible(
        { ...base, visibility: "personal", visibleDepartmentIds: [], visibleUserIds: [] },
        viewer,
        [CHILD_DEPT, ROOT_DEPT],
      ),
    ).toBe(false);
    expect(
      isConfigMarketItemVisible(
        { ...base, visibility: "users", visibleUserIds: [VIEWER_ID] },
        viewer,
        [],
      ),
    ).toBe(true);
    expect(
      isConfigMarketItemVisible(
        {
          ...base,
          visibility: "departments",
          visibleDepartmentIds: [ROOT_DEPT],
        },
        viewer,
        [CHILD_DEPT, ROOT_DEPT],
      ),
    ).toBe(true);
    expect(
      isConfigMarketItemVisible(
        { ...base, userId: VIEWER_ID, visibility: "users", visibleUserIds: [OTHER_ID] },
        viewer,
        [],
      ),
    ).toBe(true);
    expect(
      isConfigMarketItemVisible(
        { ...base, visibility: "admins_only", visibleDepartmentIds: [], visibleUserIds: [] },
        viewer,
        [],
      ),
    ).toBe(false);
    expect(
      isConfigMarketItemVisible(
        { ...base, visibility: "admins_only", visibleDepartmentIds: [], visibleUserIds: [] },
        { ...viewer, isAdmin: true },
        [],
      ),
    ).toBe(true);
    expect(
      isConfigMarketItemVisible(
        {
          ...base,
          userId: VIEWER_ID,
          visibility: "admins_only",
          visibleDepartmentIds: [],
          visibleUserIds: [],
        },
        viewer,
        [],
      ),
    ).toBe(false);
  });

  it("fails closed for hidden, foreign, unlisted, and malformed ACLs", () => {
    expect(
      isConfigMarketItemVisible(
        { ...base, visibility: "users", visibleUserIds: [OTHER_ID] },
        viewer,
        [],
      ),
    ).toBe(false);
    expect(
      isConfigMarketItemVisible(
        { ...base, visibility: "personal", visibleDepartmentIds: [ROOT_DEPT] },
        viewer,
        [],
      ),
    ).toBe(false);
    expect(isConfigMarketItemVisible({ ...base, tenantId: "tenant-b" }, viewer, [])).toBe(false);
    expect(isConfigMarketItemVisible({ ...base, status: "unlisted" }, viewer, [])).toBe(false);
    expect(
      isConfigMarketItemVisible(
        {
          ...base,
          visibility: "users",
          visibleDepartmentIds: [ROOT_DEPT],
          visibleUserIds: [VIEWER_ID],
        },
        viewer,
        [],
      ),
    ).toBe(false);
  });

  it("resolves browser viewers from the live active user and never falls back on failure", async () => {
    mocks.getAdminUser.mockResolvedValueOnce({
      id: VIEWER_ID,
      tenantId: "tenant-a",
      deptId: CHILD_DEPT,
      status: "active",
    });
    await expect(
      resolveLiveConfigMarketViewer({ tenantId: "tenant-a", userId: VIEWER_ID }),
    ).resolves.toEqual(viewer);

    mocks.getAdminUser.mockResolvedValueOnce({
      id: VIEWER_ID,
      tenantId: "tenant-a",
      deptId: ROOT_DEPT,
      status: "disabled",
    });
    await expect(
      resolveLiveConfigMarketViewer({ tenantId: "tenant-a", userId: VIEWER_ID }),
    ).resolves.toBeNull();

    mocks.getAdminUser.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(
      resolveLiveConfigMarketViewer({ tenantId: "tenant-a", userId: VIEWER_ID }),
    ).resolves.toBeNull();
  });
});
