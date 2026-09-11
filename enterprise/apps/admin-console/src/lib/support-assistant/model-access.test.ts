import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAdminUser: vi.fn(),
  listUserOptOuts: vi.fn(),
  modelIdsFromSubjects: vi.fn(),
  listProviders: vi.fn(),
  listAllEnabledModelIds: vi.fn(),
  listUserGroups: vi.fn(),
  groupModelSourcesForUser: vi.fn(),
  listAllAssignments: vi.fn(),
  readUserEditPayload: vi.fn(),
}));

vi.mock("@agenticx/iam-core", () => ({
  getAdminUser: (...args: unknown[]) => mocks.getAdminUser(...args),
  listUserOptOuts: (...args: unknown[]) => mocks.listUserOptOuts(...args),
  modelIdsFromSubjects: (...args: unknown[]) => mocks.modelIdsFromSubjects(...args),
}));
vi.mock("../model-providers-store", () => ({
  listProviders: (...args: unknown[]) => mocks.listProviders(...args),
  listAllEnabledModelIds: (...args: unknown[]) => mocks.listAllEnabledModelIds(...args),
}));
vi.mock("../user-groups-store", () => ({
  listUserGroups: (...args: unknown[]) => mocks.listUserGroups(...args),
  groupModelSourcesForUser: (...args: unknown[]) => mocks.groupModelSourcesForUser(...args),
}));
vi.mock("../user-models-store", () => ({
  listAllAssignments: (...args: unknown[]) => mocks.listAllAssignments(...args),
  readUserEditPayload: (...args: unknown[]) => mocks.readUserEditPayload(...args),
}));

import { listSupportModelsForUser, readEffectiveModelState } from "./model-access";

const user = {
  id: "member-a",
  email: "member@example.com",
  deptId: "dept-a",
};

describe("admin support effective model reads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readUserEditPayload.mockResolvedValue({
      userId: user.id,
      modelIds: ["provider/legacy"],
      parentAllowedIds: ["provider/a", "provider/b", "provider/c"],
      parentLabel: "研发部门",
      prunedModelIds: [],
      inheritedDeptModelIds: ["provider/a", "provider/b", "provider/c"],
    });
    mocks.listUserGroups.mockResolvedValue([
      { id: "group-a", name: "值班组", memberIds: [user.id], modelIds: ["provider/c"] },
    ]);
    mocks.groupModelSourcesForUser.mockImplementation((groups: unknown[], userId: string) =>
      (Array.isArray(groups) ? groups : []).filter((group) =>
        Boolean(group && typeof group === "object" &&
          Array.isArray((group as { memberIds?: unknown }).memberIds) &&
          (group as { memberIds: unknown[] }).memberIds.includes(userId)),
      ),
    );
    mocks.listAllAssignments.mockResolvedValue({
      [user.id]: ["provider/a"],
      "email:member@example.com": ["provider/b"],
    });
    mocks.listUserOptOuts.mockResolvedValue(["model:provider/c"]);
    mocks.modelIdsFromSubjects.mockImplementation((subjects: unknown) =>
      Array.isArray(subjects)
        ? subjects
            .filter((subject): subject is string => typeof subject === "string" && subject.startsWith("model:"))
            .map((subject) => subject.slice("model:".length))
        : [],
    );
  });

  it("keeps tenant, user/email assignments, group grants and opt-outs distinct", async () => {
    const state = await readEffectiveModelState("tenant-a", user);

    expect(state).toMatchObject({
      tenantId: "tenant-a",
      userId: "member-a",
      individualModelIds: ["provider/a", "provider/b"],
      groupModelIds: ["provider/c"],
      excludedGroupModelIds: ["provider/c"],
      effectiveModelIds: ["provider/a", "provider/b"],
      parentLabel: "研发部门",
    });
    expect(mocks.readUserEditPayload).toHaveBeenCalledWith(
      "member-a",
      "member@example.com",
      "dept-a",
      "tenant-a",
    );
    expect(mocks.listAllAssignments).toHaveBeenCalledWith("tenant-a");
    expect(mocks.listUserOptOuts).toHaveBeenCalledWith("tenant-a", "member-a");
  });

  it("filters the bootstrap/model picker through the same effective state and never exposes provider secrets", async () => {
    mocks.listProviders.mockResolvedValue([
      {
        id: "provider",
        displayName: "Provider",
        baseUrl: "https://provider.invalid",
        apiKeyMasked: "sk-••••",
        apiKeyConfigured: true,
        enabled: true,
        isDefault: true,
        route: "third-party",
        models: [
          { name: "a", label: "A", enabled: true },
          { name: "c", label: "C", enabled: true },
          { name: "off", label: "Off", enabled: false },
        ],
        createdAt: "2026-09-09T00:00:00.000Z",
        updatedAt: "2026-09-09T00:00:00.000Z",
      },
    ]);

    const models = await listSupportModelsForUser("tenant-a", user);
    expect(models).toEqual([
      { id: "provider/a", label: "A", provider: "provider", model: "a", isDefault: true },
    ]);
    expect(JSON.stringify(models)).not.toContain("apiKey");
    expect(mocks.listProviders).toHaveBeenCalledWith("tenant-a");
  });
});
