import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAdminScope: vi.fn(),
  getAdminUser: vi.fn(),
  listUserGroups: vi.fn(),
  groupModelSourcesForUser: vi.fn(),
  listAllAssignments: vi.fn(),
  setUserModelsForAliases: vi.fn(),
  setUserModelOptOuts: vi.fn(),
}));

vi.mock("server-only", () => ({}));

vi.mock("@agenticx/iam-core", () => ({
  getAdminUser: (...args: unknown[]) => mocks.getAdminUser(...args),
}));

vi.mock("../../../../../../../lib/admin-auth", () => ({
  requireAdminScope: (...args: unknown[]) => mocks.requireAdminScope(...args),
}));

vi.mock("../../../../../../../lib/user-groups-store", () => ({
  groupModelSourcesForUser: (...args: unknown[]) => mocks.groupModelSourcesForUser(...args),
  listUserGroups: (...args: unknown[]) => mocks.listUserGroups(...args),
  setUserModelOptOuts: (...args: unknown[]) => mocks.setUserModelOptOuts(...args),
}));

vi.mock("../../../../../../../lib/user-models-store", () => ({
  collectUserAssignmentKeys: (userId: string, email?: string) => {
    const keys = userId ? [userId] : [];
    const normalized = email?.trim().toLowerCase();
    if (normalized) keys.push(`email:${normalized}`);
    return keys;
  },
  listAllAssignments: (...args: unknown[]) => mocks.listAllAssignments(...args),
  mergeUserStoredSet: (map: Record<string, string[]>, keys: string[]) => {
    const merged = [...new Set(keys.flatMap((key) => map[key] ?? []))];
    return merged.length ? merged : null;
  },
  setUserModelsForAliases: (...args: unknown[]) => mocks.setUserModelsForAliases(...args),
}));

describe("admin user model route", () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
    mocks.requireAdminScope.mockResolvedValue({
      ok: true,
      session: { tenantId: "tenant-a", userId: "admin-a" },
    });
    mocks.getAdminUser.mockResolvedValue({
      id: "user-a",
      tenantId: "tenant-a",
      email: "member@example.com",
      deptId: null,
      status: "active",
    });
    mocks.listUserGroups.mockResolvedValue([]);
    mocks.groupModelSourcesForUser.mockReturnValue([]);
    mocks.listAllAssignments.mockResolvedValue({
      "user-a": ["provider/old"],
      "email:member@example.com": ["provider/old"],
    });
    mocks.setUserModelsForAliases.mockResolvedValue({ modelIds: ["provider/new"], prunedModelIds: [] });
    mocks.setUserModelOptOuts.mockResolvedValue([]);
  });

  it("uses one tenant-scoped alias CAS and reports a stale preview as 409", async () => {
    mocks.setUserModelsForAliases.mockRejectedValue(
      Object.assign(new Error("alias changed"), { code: "USER_MODELS_PRECONDITION" }),
    );
    const { PUT } = await import("../route");
    const response = await PUT(
      new Request("https://admin.example.com/api/admin/users/user-a/models", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ modelIds: ["provider/new"] }),
      }),
      { params: Promise.resolve({ id: "user-a" }) },
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: "40901" });
    expect(mocks.setUserModelsForAliases).toHaveBeenCalledWith({
      userId: "user-a",
      email: "member@example.com",
      modelIds: ["provider/new"],
      deptId: null,
      tenantId: "tenant-a",
      expectedModelIds: ["provider/old"],
      expectedModelIdsByKey: {
        "user-a": ["provider/old"],
        "email:member@example.com": ["provider/old"],
      },
    });
    expect(mocks.setUserModelOptOuts).not.toHaveBeenCalled();
  });
});
