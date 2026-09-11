import { describe, expect, it, vi } from "vitest";

import { v2ExpertManifest } from "../config-share-test-fixtures";
import {
  ConfigMarketAudienceConflictError,
  ConfigMarketOwnershipConflictError,
  ConfigMarketPublishBlockedError,
  ConfigMarketReleaseVersionConflictError,
  createMemoryConfigMarketStore,
  type CreateConfigMarketItemInput,
} from "./store";
import type { ConfigMarketAudience } from "./types";

const USER_A = "01JQMZ8K3N4P5Q6R7S8T9VWXYZ";
const USER_B = "01JQMZ8K3N4P5Q6R7S8T9VWXY0";
const USER_C = "01JQMZ8K3N4P5Q6R7S8T9VWXY1";
const DEPT_ROOT = "01JQMZ8K3N4P5Q6R7S8T9VWXY2";
const DEPT_CHILD = "01JQMZ8K3N4P5Q6R7S8T9VWXY3";

const company: ConfigMarketAudience = {
  visibility: "company",
  visibleDepartmentIds: [],
  visibleUserIds: [],
};

function artifactId(name: string): string {
  return `expert:test-${[...name].map((char) => char.codePointAt(0)!.toString(16)).join("-")}`;
}

function manifest(name = "投研专家", version = "1.0.0", prompt = "内部分析指令") {
  return v2ExpertManifest(name, { artifactId: artifactId(name), version, systemPrompt: prompt });
}

function input(
  name: string,
  userId = USER_A,
  audience: ConfigMarketAudience = company,
): CreateConfigMarketItemInput {
  return {
    tenantId: "tenant-a",
    userId,
    ownerDisplayName: userId === USER_A ? "Alice" : "Bob",
    manifest: manifest(name),
    audience,
  };
}

describe("config market store", () => {
  it("publishes immediately and keeps administrative reads tenant scoped but ACL independent", async () => {
    const store = createMemoryConfigMarketStore();
    const item = await store.create(input("投研专家", USER_A, {
      visibility: "users",
      visibleDepartmentIds: [],
      visibleUserIds: [USER_B],
    }));

    expect(item.status).toBe("published");
    expect(await store.list("tenant-a")).toHaveLength(1);
    expect(await store.list("tenant-b")).toEqual([]);
    expect(await store.get(item.id, "tenant-b")).toBeNull();
    expect(await store.setStatus(item.id, "tenant-b", "unlisted")).toBeNull();
    expect((await store.get(item.id, "tenant-a"))?.raw).toEqual(manifest("投研专家"));
  });

  it("applies the same owner/user/department ancestry ACL to employee list and get", async () => {
    const viewerDepartmentIds = vi.fn(async () => [DEPT_CHILD, DEPT_ROOT]);
    const store = createMemoryConfigMarketStore({ viewerDepartmentIds });
    const companyItem = await store.create(input("公司专家"));
    const userItem = await store.create(input("定向专家", USER_A, {
      visibility: "users",
      visibleDepartmentIds: [],
      visibleUserIds: [USER_B],
    }));
    const departmentItem = await store.create(input("部门专家", USER_A, {
      visibility: "departments",
      visibleDepartmentIds: [DEPT_ROOT],
      visibleUserIds: [],
    }));
    const hiddenItem = await store.create(input("隐藏专家", USER_A, {
      visibility: "users",
      visibleDepartmentIds: [],
      visibleUserIds: [USER_C],
    }));
    const ownerItem = await store.create(input("上传人的专家", USER_B, {
      visibility: "users",
      visibleDepartmentIds: [],
      visibleUserIds: [USER_C],
    }));
    const adminsOnlyItem = await store.create(input("仅管理员专家", USER_A, {
      visibility: "admins_only",
      visibleDepartmentIds: [],
      visibleUserIds: [],
    }));
    const viewer = { tenantId: "tenant-a", userId: USER_B, deptId: DEPT_CHILD };

    const visible = await store.listVisible(viewer);
    expect(new Set(visible.map((item) => item.id))).toEqual(
      new Set([companyItem.id, userItem.id, departmentItem.id, ownerItem.id]),
    );
    expect(await store.getVisible(companyItem.id, viewer)).not.toBeNull();
    expect(await store.getVisible(userItem.id, viewer)).not.toBeNull();
    expect(await store.getVisible(departmentItem.id, viewer)).not.toBeNull();
    expect(await store.getVisible(ownerItem.id, viewer)).not.toBeNull();
    expect(await store.getVisible(hiddenItem.id, viewer)).toBeNull();
    expect(await store.getVisible(adminsOnlyItem.id, viewer)).toBeNull();
    expect(await store.listVisible({ ...viewer, isAdmin: true })).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: adminsOnlyItem.id })]),
    );
    expect(await store.getVisible(adminsOnlyItem.id, { ...viewer, isAdmin: true })).not.toBeNull();
    expect(
      await store.getVisible(companyItem.id, { ...viewer, tenantId: "tenant-b" }),
    ).toBeNull();
    expect(viewerDepartmentIds).toHaveBeenCalledWith(viewer);
  });

  it("keeps personal releases visible only to their uploader across list and detail", async () => {
    const store = createMemoryConfigMarketStore();
    const personalItem = await store.create(input("仅自己专家", USER_A, {
      visibility: "personal",
      visibleDepartmentIds: [],
      visibleUserIds: [],
    }));

    expect((await store.listVisible({ tenantId: "tenant-a", userId: USER_A, deptId: null }))
      .map((item) => item.id)).toEqual([personalItem.id]);
    expect(await store.getVisible(personalItem.id, {
      tenantId: "tenant-a",
      userId: USER_B,
      deptId: null,
    })).toBeNull();
    expect(await store.listVisible({ tenantId: "tenant-a", userId: USER_B, deptId: null })).toEqual([]);

    await expect(store.create({
      ...input("仅自己专家", USER_A, {
        visibility: "company",
        visibleDepartmentIds: [],
        visibleUserIds: [],
      }),
      manifest: manifest("仅自己专家", "1.1.0", "不能扩展可见范围"),
    })).rejects.toBeInstanceOf(ConfigMarketAudienceConflictError);
  });

  it("hides unlisted artifacts from the market while keeping delivery state independent", async () => {
    const store = createMemoryConfigMarketStore();
    const item = await store.create(input("投研专家"));
    const viewer = { tenantId: "tenant-a", userId: USER_A, deptId: null };

    const unlisted = await store.setStatus(item.id, "tenant-a", "unlisted");
    expect(unlisted?.status).toBe("unlisted");
    expect(unlisted?.deliveryState).toBe("active");
    expect(await store.getVisible(item.id, viewer)).toBeNull();
    expect(await store.listVisible(viewer)).toEqual([]);
    expect((await store.list("tenant-a", { includeUnlisted: true }))[0]?.id).toBe(item.id);

    const revoked = await store.setDeliveryState(item.id, "tenant-a", "revoked");
    expect(revoked).toMatchObject({ status: "unlisted", deliveryState: "revoked" });
    const restored = await store.setStatus(item.id, "tenant-a", "published");
    expect(restored).toMatchObject({ status: "published", deliveryState: "revoked" });
    await expect(store.setDeliveryState(item.id, "tenant-a", "invalid" as never)).rejects.toThrow(
      /invalid config market delivery state/,
    );

    await store.setDeliveryState(item.id, "tenant-a", "active");
    expect((await store.getVisible(item.id, viewer))?.digest).toBe(item.digest);
  });

  it("keeps retry idempotency, stable ids, immutable releases, and owner-scoped source ids", async () => {
    const store = createMemoryConfigMarketStore();
    const original = input("投研专家");
    const first = await store.create(original);
    const idempotent = await store.create(original);
    expect(idempotent).toMatchObject({ id: first.id, updatedAt: first.updatedAt });

    await expect(
      store.create({
        ...original,
        audience: {
          visibility: "users",
          visibleDepartmentIds: [],
          visibleUserIds: [USER_B],
        },
      }),
    ).rejects.toBeInstanceOf(ConfigMarketAudienceConflictError);
    expect(await store.list("tenant-a")).toHaveLength(1);
    expect(await store.get(first.id, "tenant-a")).toMatchObject({
      visibility: "company",
      visibleDepartmentIds: [],
      visibleUserIds: [],
      updatedAt: first.updatedAt,
    });

    await expect(
      store.create({ ...original, userId: USER_B, ownerDisplayName: "Bob" }),
    ).rejects.toBeInstanceOf(ConfigMarketOwnershipConflictError);

    const next = await store.create({
      ...original,
      manifest: manifest("投研专家", "1.1.0", "新版指令"),
      releaseNotes: "迭代提示词",
    });
    expect(next).toMatchObject({ id: first.id, version: "1.1.0" });
    expect(next.releaseId).not.toBe(first.releaseId);
    await expect(
      store.create({ ...original, manifest: manifest("投研专家", "1.0.1", "倒退版本") }),
    ).rejects.toBeInstanceOf(ConfigMarketReleaseVersionConflictError);
    await store.setStatus(first.id, "tenant-a", "unlisted");
    await expect(
      store.create({ ...original, manifest: manifest("投研专家", "2.0.0") }),
    ).rejects.toBeInstanceOf(
      ConfigMarketPublishBlockedError,
    );
  });

  it("counts only visible successful reports, deduplicates one account/release, and accumulates versions", async () => {
    const store = createMemoryConfigMarketStore();
    const original = input("下载统计专家");
    const first = await store.create(original);
    const viewer = { tenantId: "tenant-a", userId: USER_B, deptId: null };

    await expect(store.recordDownload(first.id, viewer, "unknown-release")).resolves.toBeNull();
    await expect(store.get(first.id, "tenant-a")).resolves.toMatchObject({ downloadCount: 0 });

    await expect(store.recordDownload(first.id, viewer, first.releaseId)).resolves.toEqual({
      counted: true,
      downloadCount: 1,
    });
    await expect(store.recordDownload(first.id, viewer, first.releaseId)).resolves.toEqual({
      counted: false,
      downloadCount: 1,
    });
    await expect(store.recordDownload(first.id, { ...viewer, userId: USER_C }, first.releaseId)).resolves.toEqual({
      counted: true,
      downloadCount: 2,
    });

    const second = await store.create({
      ...original,
      manifest: manifest("下载统计专家", "1.1.0", "新版指令"),
    });
    expect(second.downloadCount).toBe(2);
    await expect(store.recordDownload(second.id, viewer, first.releaseId)).resolves.toEqual({
      counted: false,
      downloadCount: 2,
    });
    await expect(store.recordDownload(second.id, viewer, second.releaseId)).resolves.toEqual({
      counted: true,
      downloadCount: 3,
    });
    await expect(store.listVisibleMetadata(viewer)).resolves.toMatchObject({
      items: [expect.objectContaining({ id: first.id, downloadCount: 3 })],
    });
  });

  it("does not create receipts for foreign, hidden, unlisted, or non-admin viewers", async () => {
    const viewerDepartmentIds = vi.fn(async () => [DEPT_CHILD]);
    const store = createMemoryConfigMarketStore({ viewerDepartmentIds });
    const viewer = { tenantId: "tenant-a", userId: USER_B, deptId: DEPT_CHILD };
    const privateItem = await store.create(input("下载私有专家", USER_A, {
      visibility: "personal",
      visibleDepartmentIds: [],
      visibleUserIds: [],
    }));
    const usersItem = await store.create(input("下载定向专家", USER_A, {
      visibility: "users",
      visibleDepartmentIds: [],
      visibleUserIds: [USER_C],
    }));
    const departmentsItem = await store.create(input("下载部门专家", USER_A, {
      visibility: "departments",
      visibleDepartmentIds: [DEPT_ROOT],
      visibleUserIds: [],
    }));
    const unlistedItem = await store.create(input("下载下架专家"));
    await store.setStatus(unlistedItem.id, "tenant-a", "unlisted");
    const adminsOnlyItem = await store.create(input("下载管理员专家", USER_A, {
      visibility: "admins_only",
      visibleDepartmentIds: [],
      visibleUserIds: [],
    }));
    const foreignItem = await store.create({
      ...input("下载跨租户专家"),
      tenantId: "tenant-b",
    });

    for (const item of [privateItem, usersItem, departmentsItem, unlistedItem, adminsOnlyItem]) {
      await expect(store.recordDownload(item.id, viewer, item.releaseId)).resolves.toBeNull();
    }
    await expect(store.recordDownload(foreignItem.id, viewer, foreignItem.releaseId)).resolves.toBeNull();
    await expect(store.recordDownload(privateItem.id, viewer, "01JQMZ8K3N4P5Q6R7S8T9VWXY9")).resolves.toBeNull();

    await expect(
      store.recordDownload(adminsOnlyItem.id, { ...viewer, isAdmin: true }, adminsOnlyItem.releaseId),
    ).resolves.toEqual({ counted: true, downloadCount: 1 });
    expect(await store.get(privateItem.id, "tenant-a")).toMatchObject({ downloadCount: 0 });
    expect(viewerDepartmentIds).toHaveBeenCalledWith(viewer);
  });
});
