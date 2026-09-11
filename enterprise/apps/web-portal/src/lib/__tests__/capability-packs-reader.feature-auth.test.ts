import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  queryResults: [] as unknown[][],
  listUserOptOuts: vi.fn(),
  resolveAssignmentKeysForUser: vi.fn(),
  resolveAssignmentKeysForManagedDelivery: vi.fn(),
}));

vi.mock("@agenticx/iam-core", () => ({
  listUserOptOuts: (...args: unknown[]) => mocks.listUserOptOuts(...args),
  resolveAssignmentKeysForUser: (...args: unknown[]) =>
    mocks.resolveAssignmentKeysForUser(...args),
  resolveAssignmentKeysForManagedDelivery: (...args: unknown[]) =>
    mocks.resolveAssignmentKeysForManagedDelivery(...args),
}));

vi.mock("../capability-tables", async () => {
  const schema = await vi.importActual<typeof import("@agenticx/db-schema")>(
    "@agenticx/db-schema",
  );
  const nextRows = async () => mocks.queryResults.shift() ?? [];
  const db = {
    select: () => ({
      from: () => ({
        innerJoin: () => ({ where: nextRows }),
        where: nextRows,
      }),
    }),
  };
  return {
    requiredCapabilityTenant: () => "01JQMZ8K3N4P5Q6R7S8T9VWXT1",
    dialectCapabilityTables: async () => ({
      db,
      packs: schema.enterpriseCapabilityPacks,
      assignments: schema.enterpriseCapabilityAssignments,
      members: schema.enterpriseCapabilityPackMembers,
      skills: schema.enterpriseSkills,
      mcp: schema.mcpServers,
    }),
  };
});

const SKILL_ROW_ID = "01JQMZ8K3N4P5Q6R7S8T9VWXY0";
const SKILL_ID = `skill:${SKILL_ROW_ID}`;
const DEEP_RESEARCH_ID = "feature:deep_research";
const TENANT_ID = "01JQMZ8K3N4P5Q6R7S8T9VWXT1";

function mixedPackQueryResults(): unknown[][] {
  return [
    [{ packId: "01JQMZ8K3N4P5Q6R7S8T9VWXP1" }],
    [{ id: "01JQMZ8K3N4P5Q6R7S8T9VWXP1" }],
    [{ capabilityId: SKILL_ID }, { capabilityId: DEEP_RESEARCH_ID }],
    [
      {
        id: SKILL_ROW_ID,
        slug: "research-helper",
        displayName: "Research Helper",
        version: "1.0.0",
        bundleUri: null,
        bundleDigest: null,
        requiredCapabilities: [],
        status: "active",
        updatedAt: "2026-09-11T00:00:00.000Z",
      },
    ],
  ];
}

/** 只放了一项平台功能、没有任何 Skill/MCP 的包——管理员配「深度研究」时最自然的做法。 */
function featureOnlyPackQueryResults(): unknown[][] {
  return [
    [{ packId: "01JQMZ8K3N4P5Q6R7S8T9VWXP1" }],
    [{ id: "01JQMZ8K3N4P5Q6R7S8T9VWXP1" }],
    [{ capabilityId: DEEP_RESEARCH_ID }],
  ];
}

describe("platform feature capability-pack authorization", () => {
  beforeEach(() => {
    mocks.queryResults = [];
    mocks.listUserOptOuts.mockReset().mockResolvedValue([]);
    mocks.resolveAssignmentKeysForUser.mockReset().mockResolvedValue(["all"]);
    mocks.resolveAssignmentKeysForManagedDelivery.mockReset().mockResolvedValue(["all"]);
  });

  it("requires an explicit pack assignment for the public attachment exception", async () => {
    mocks.queryResults = [[]];

    const { isPlatformFeatureAllowedForUser } = await import("../capability-packs-reader");

    await expect(
      isPlatformFeatureAllowedForUser(TENANT_ID, "attachment_public_override", "user-1"),
    ).resolves.toBe(false);
  });

  it("allows deep research when it shares an assigned pack with a skill", async () => {
    // Query order: governed lookup, assigned packs, pack members, active skill rows.
    mocks.queryResults = mixedPackQueryResults();

    const { isPlatformFeatureAllowedForUser } = await import("../capability-packs-reader");

    await expect(
      isPlatformFeatureAllowedForUser(TENANT_ID, "deep_research", "user-1"),
    ).resolves.toBe(true);
    expect(mocks.queryResults).toHaveLength(0);
  });

  it("still denies deep research when the assigned user opted out", async () => {
    mocks.queryResults = mixedPackQueryResults();
    mocks.listUserOptOuts.mockResolvedValue([DEEP_RESEARCH_ID]);

    const { isPlatformFeatureAllowedForUser } = await import("../capability-packs-reader");

    await expect(
      isPlatformFeatureAllowedForUser(TENANT_ID, "deep_research", "user-1"),
    ).resolves.toBe(false);
    expect(mocks.queryResults).toHaveLength(0);
  });

  it("allows deep research from a pack that carries no skill or mcp at all", async () => {
    // 管理员配「深度研究」最自然的做法就是建一个只有这一项的包。这条路径下
    // grouped.skill / grouped.mcp 都是空的，一次 skill/mcp 查询都不会发出——
    // 授权结果只能来自 assignedPlatformFeatures，assigned 在这里必然是空数组。
    mocks.queryResults = featureOnlyPackQueryResults();

    const { isPlatformFeatureAllowedForUser } = await import("../capability-packs-reader");

    await expect(
      isPlatformFeatureAllowedForUser(TENANT_ID, "deep_research", "user-1"),
    ).resolves.toBe(true);
    expect(mocks.queryResults).toHaveLength(0);
  });

  it("denies a governed feature that this user's packs do not carry", async () => {
    // 治理已开启（第一条 governed 查询有行），但这个人拿到的包里只有 Skill。
    mocks.queryResults = [
      [{ packId: "01JQMZ8K3N4P5Q6R7S8T9VWXP1" }],
      [{ id: "01JQMZ8K3N4P5Q6R7S8T9VWXP2" }],
      [{ capabilityId: SKILL_ID }],
      [
        {
          id: SKILL_ROW_ID,
          slug: "research-helper",
          displayName: "Research Helper",
          version: "1.0.0",
          bundleUri: null,
          bundleDigest: null,
          requiredCapabilities: [],
          status: "active",
          updatedAt: "2026-09-11T00:00:00.000Z",
        },
      ],
    ];

    const { isPlatformFeatureAllowedForUser } = await import("../capability-packs-reader");

    await expect(
      isPlatformFeatureAllowedForUser(TENANT_ID, "deep_research", "user-1"),
    ).resolves.toBe(false);
  });

  it("keeps platform features out of what gets pushed to Desktop", async () => {
    // 平台功能只做服务端授权。混进 assigned 就会被 capabilityStatesFromView 当成
    // 一条 Skill/MCP 下发，Desktop 侧会多出一个连不上的能力条目。
    // 直接调 loadUserCapabilityView 时没有 governed 那一次查询，掐掉队首。
    mocks.queryResults = mixedPackQueryResults().slice(1);

    const { loadUserCapabilityView, capabilityStatesFromView } = await import(
      "../capability-packs-reader"
    );
    const view = await loadUserCapabilityView(TENANT_ID, "user-1");

    expect(view.assignedPlatformFeatures.has("deep_research")).toBe(true);
    expect(view.assigned.map((item) => item.id)).toEqual([SKILL_ID]);
    expect(capabilityStatesFromView(view).map((item) => item.id)).toEqual([SKILL_ID]);
  });

  it("does not let disabled or missing portable rows satisfy the pack gate", async () => {
    const missingSkillId = "skill:01JQMZ8K3N4P5Q6R7S8T9VWXY1";
    mocks.queryResults = [
      [{ id: "01JQMZ8K3N4P5Q6R7S8T9VWXP1" }],
      [{ capabilityId: SKILL_ID }, { capabilityId: missingSkillId }],
      [{
        id: SKILL_ROW_ID,
        slug: "research-helper",
        displayName: "Research Helper",
        version: "1.0.0",
        bundleUri: null,
        bundleDigest: null,
        requiredCapabilities: [],
        status: "disabled",
        updatedAt: "2026-09-11T00:00:00.000Z",
      }],
    ];

    const { loadUserCapabilityView } = await import("../capability-packs-reader");
    const view = await loadUserCapabilityView(TENANT_ID, "user-1");

    expect(view.assigned).toEqual([]);
    expect(view.assignedCapabilityIds).toEqual(new Set());
    expect(view.capabilityRevision).toContain(`catalog:skill:${SKILL_ROW_ID}:disabled`);
    expect(view.capabilityRevision).toContain(`catalog:skill:${missingSkillId.slice("skill:".length)}:missing`);
  });

  it("uses strict assignment lookup for the Desktop desired-state snapshot", async () => {
    const timeout = Object.assign(new Error("group lookup timeout"), { code: "ETIMEDOUT" });
    mocks.resolveAssignmentKeysForManagedDelivery.mockRejectedValue(timeout);
    const { listAvailableCapabilitiesForUser } = await import("../capability-packs-reader");

    await expect(
      listAvailableCapabilitiesForUser(TENANT_ID, "user-1", undefined, null, "desktop"),
    ).rejects.toBe(timeout);
    expect(mocks.resolveAssignmentKeysForManagedDelivery).toHaveBeenCalledWith(
      TENANT_ID,
      "user-1",
      undefined,
      null,
    );
    expect(mocks.resolveAssignmentKeysForUser).not.toHaveBeenCalled();
  });
});
