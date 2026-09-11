import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAdminUser: vi.fn(),
  getDepartment: vi.fn(),
  listAudienceUsers: vi.fn(),
  listDepartmentsFlat: vi.fn(),
}));

vi.mock("@agenticx/iam-core", () => ({
  getAdminUser: (...args: unknown[]) => mocks.getAdminUser(...args),
  getDepartment: (...args: unknown[]) => mocks.getDepartment(...args),
  listAudienceUsers: (...args: unknown[]) => mocks.listAudienceUsers(...args),
  listDepartmentsFlat: (...args: unknown[]) => mocks.listDepartmentsFlat(...args),
}));

import { ConfigShareValidationError } from "../config-share-types";
import {
  assertConfigMarketAudienceTargets,
  listConfigMarketAudienceDirectory,
} from "./audience";

const TARGET_ID = "01JQMZ8K3N4P5Q6R7S8T9VWXYZ";

describe("config market audience validation", () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
  });

  it("accepts only departments from the authenticated tenant", async () => {
    mocks.getDepartment.mockResolvedValueOnce({ id: TARGET_ID, tenantId: "tenant-a" });
    await expect(
      assertConfigMarketAudienceTargets("tenant-a", {
        visibility: "departments",
        visibleDepartmentIds: [TARGET_ID],
        visibleUserIds: [],
      }),
    ).resolves.toBeUndefined();
    expect(mocks.getDepartment).toHaveBeenCalledWith("tenant-a", TARGET_ID);

    mocks.getDepartment.mockResolvedValueOnce(null);
    await expect(
      assertConfigMarketAudienceTargets("tenant-a", {
        visibility: "departments",
        visibleDepartmentIds: [TARGET_ID],
        visibleUserIds: [],
      }),
    ).rejects.toBeInstanceOf(ConfigShareValidationError);
  });

  it("accepts only active users from the authenticated tenant", async () => {
    mocks.getAdminUser.mockResolvedValueOnce({
      id: TARGET_ID,
      tenantId: "tenant-a",
      status: "active",
    });
    await expect(
      assertConfigMarketAudienceTargets("tenant-a", {
        visibility: "users",
        visibleDepartmentIds: [],
        visibleUserIds: [TARGET_ID],
      }),
    ).resolves.toBeUndefined();

    mocks.getAdminUser.mockResolvedValueOnce({
      id: TARGET_ID,
      tenantId: "tenant-a",
      status: "disabled",
    });
    await expect(
      assertConfigMarketAudienceTargets("tenant-a", {
        visibility: "users",
        visibleDepartmentIds: [],
        visibleUserIds: [TARGET_ID],
      }),
    ).rejects.toBeInstanceOf(ConfigShareValidationError);
  });

  it("returns only minimal, active, tenant-scoped directory DTOs", async () => {
    mocks.listDepartmentsFlat.mockResolvedValue([
      { id: "dept-a", tenantId: "tenant-a", name: "Alice 团队", path: "/Alice 团队" },
      { id: "dept-b", tenantId: "tenant-a", name: "财务", path: "/财务" },
    ]);
    mocks.listAudienceUsers.mockResolvedValue([
      {
        id: "user-a",
        displayName: "Alice",
        email: "alice@example.invalid",
        deptId: "dept-a",
      },
    ]);

    await expect(
      listConfigMarketAudienceDirectory({
        tenantId: "tenant-a",
        q: "Alice",
        limit: 20,
        offset: 0,
      }),
    ).resolves.toEqual({
      departments: [{ id: "dept-a", name: "Alice 团队", path: "/Alice 团队" }],
      users: [
        {
          id: "user-a",
          displayName: "Alice",
          email: "alice@example.invalid",
          deptId: "dept-a",
        },
      ],
    });
    expect(mocks.listAudienceUsers).toHaveBeenCalledWith("tenant-a", {
      q: "alice",
      limit: 20,
      offset: 0,
    });
  });
});
