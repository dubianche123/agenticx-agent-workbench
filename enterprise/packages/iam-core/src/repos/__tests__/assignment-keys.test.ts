import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listDepartmentAncestorIds: vi.fn(),
  listUserGroupIdsForUser: vi.fn(),
}));

vi.mock("../departments", () => ({
  listDepartmentAncestorIds: (...args: unknown[]) =>
    mocks.listDepartmentAncestorIds(...args),
}));

vi.mock("../user-groups", () => ({
  groupAssignmentKey: (id: string) => `group:${id}`,
  listUserGroupIdsForUser: (...args: unknown[]) =>
    mocks.listUserGroupIdsForUser(...args),
}));

import {
  resolveAssignmentKeysForManagedDelivery,
  resolveAssignmentKeysForUser,
} from "../assignment-keys";

describe("assignment key group lookup failure semantics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listDepartmentAncestorIds.mockResolvedValue(["dept-child", "dept-root"]);
    mocks.listUserGroupIdsForUser.mockResolvedValue(["group-a"]);
  });

  it("includes all identity, department, and group keys", async () => {
    await expect(
      resolveAssignmentKeysForManagedDelivery(
        "tenant-a",
        "user-a",
        " USER@Example.COM ",
        "dept-child",
      ),
    ).resolves.toEqual([
      "all",
      "user-a",
      "email:user@example.com",
      "dept:dept-child",
      "dept:dept-root",
      "group:group-a",
    ]);
  });

  it.each([
    Object.assign(new Error('relation "enterprise_user_group_members" does not exist'), {
      code: "42P01",
    }),
    Object.assign(new Error("Table 'agenticx.enterprise_user_groups' doesn't exist"), {
      code: "ER_NO_SUCH_TABLE",
      errno: 1146,
    }),
    Object.assign(new Error("database unavailable"), { code: "ECONNRESET" }),
    Object.assign(new Error("query timed out"), { code: "ETIMEDOUT" }),
    Object.assign(new Error('permission denied for table "enterprise_user_groups"'), {
      code: "42501",
    }),
    Object.assign(new Error('relation "some_other_table" does not exist'), {
      code: "42P01",
    }),
  ])("propagates every group lookup failure for managed delivery", async (error) => {
    mocks.listUserGroupIdsForUser.mockRejectedValue(error);

    await expect(
      resolveAssignmentKeysForManagedDelivery("tenant-a", "user-a"),
    ).rejects.toBe(error);
  });

  it("preserves the ordinary resolver's existing best-effort fallback", async () => {
    mocks.listUserGroupIdsForUser.mockRejectedValue(new Error("database unavailable"));

    await expect(resolveAssignmentKeysForUser("tenant-a", "user-a")).resolves.toEqual([
      "all",
      "user-a",
    ]);
  });
});
