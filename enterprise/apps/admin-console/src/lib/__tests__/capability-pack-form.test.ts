import { describe, expect, it } from "vitest";
import {
  assertManagedPortableDeliveryLimit,
  ALL_MEMBERS_ASSIGNMENT_KEY,
  capabilityLabel,
  danglingCapabilityIds,
  disabledMemberIds,
  fromAssignmentKeys,
  groupCapabilityChoices,
  mcpCapabilityId,
  toAssignmentKeys,
  type CapabilityChoice,
} from "../capability-pack-form";

const MCP_ROW = "01JQMZ8K3N4P5Q6R7S8T9VWXYZ";
const MCP_ID = `mcp:${MCP_ROW}`;
const SKILL_ID = "skill:01JQMZ8K3N4P5Q6R7S8T9VWXY0";
const EXPERT_ID = "expert:01JQMZ8K3N4P5Q6R7S8T9VWXY1";
const GROUP_ID = "group:01JQMZ8K3N4P5Q6R7S8T9VWXY2";

const choices: CapabilityChoice[] = [
  { id: MCP_ID, kind: "mcp", name: "market-data", displayName: "行情数据", disabled: false },
  { id: SKILL_ID, kind: "skill", name: "research", displayName: "研究", disabled: true },
  { id: EXPERT_ID, kind: "expert", name: EXPERT_ID, displayName: "合同专家", disabled: false },
  { id: GROUP_ID, kind: "group", name: GROUP_ID, displayName: "项目群", disabled: false },
];

describe("assignment drafts", () => {
  it("sends only the all-members key when all members is checked", () => {
    // 叠加部门/个人不会让范围变小，只会在取消全员后留下没人记得勾过的残留分配。
    expect(
      toAssignmentKeys({ allMembers: true, deptIds: ["d1"], groupIds: ["g1"], userIds: ["u1"] }),
    ).toEqual([ALL_MEMBERS_ASSIGNMENT_KEY]);
  });

  it("prefixes departments and groups but leaves user ids bare, matching the portal", () => {
    expect(
      toAssignmentKeys({ allMembers: false, deptIds: ["d1"], groupIds: ["g1"], userIds: ["u1"] }),
    ).toEqual(["dept:d1", "group:g1", "u1"]);
  });

  it("round-trips a stored key list back into checkboxes", () => {
    expect(fromAssignmentKeys(["dept:d1", "group:g1", "u1", "all"])).toEqual({
      allMembers: true,
      deptIds: ["d1"],
      groupIds: ["g1"],
      userIds: ["u1"],
    });
  });

  it("drops blank entries instead of writing an empty assignment key", () => {
    expect(
      toAssignmentKeys({ allMembers: false, deptIds: ["  "], groupIds: [""], userIds: [""] }),
    ).toEqual([]);
  });
});

describe("capability ids", () => {
  it("builds ids from the row primary key, never from a name", () => {
    expect(mcpCapabilityId(MCP_ROW)).toBe(MCP_ID);
  });

  it("refuses a non-ULID row id rather than storing an id nothing can resolve", () => {
    expect(() => mcpCapabilityId("market-data")).toThrow();
  });
});

describe("member diagnostics", () => {
  it("reports a member whose underlying row no longer exists", () => {
    // 界面上这条什么都不显示，不标出来管理员会以为包里就剩下的那些。
    expect(danglingCapabilityIds([MCP_ID, "mcp:01JQMZ8K3N4P5Q6R7S8T9VWXY1"], choices)).toEqual([
      "mcp:01JQMZ8K3N4P5Q6R7S8T9VWXY1",
    ]);
  });

  it("reports a member that is disabled, since employees will not receive it", () => {
    expect(disabledMemberIds([MCP_ID, SKILL_ID], choices)).toEqual([SKILL_ID]);
  });

  it("falls back to the raw id when labelling an unknown capability", () => {
    expect(capabilityLabel("mcp:01JQMZ8K3N4P5Q6R7S8T9VWXY1", choices)).toBe(
      "mcp:01JQMZ8K3N4P5Q6R7S8T9VWXY1",
    );
  });

  it("groups executable and shared-config choices into separate picker sections", () => {
    const grouped = groupCapabilityChoices(choices);
    expect(grouped.mcp.map((i) => i.id)).toEqual([MCP_ID]);
    expect(grouped.skill.map((i) => i.id)).toEqual([SKILL_ID]);
    expect(grouped.expert.map((i) => i.id)).toEqual([EXPERT_ID]);
    expect(grouped.group.map((i) => i.id)).toEqual([GROUP_ID]);
  });
});

describe("managed portable delivery ceiling", () => {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const portableId = (index: number) =>
    `expert:${"0".repeat(24)}${alphabet[Math.floor(index / 32)]}${alphabet[index % 32]}`;

  it("allows 64 unique active expert/group entries and rejects the 65th", () => {
    expect(() =>
      assertManagedPortableDeliveryLimit([
        { status: "active", capabilityIds: Array.from({ length: 64 }, (_, index) => portableId(index)) },
      ]),
    ).not.toThrow();
    expect(() =>
      assertManagedPortableDeliveryLimit([
        { status: "active", capabilityIds: Array.from({ length: 65 }, (_, index) => portableId(index)) },
      ]),
    ).toThrow(/65\/64/);
  });

  it("counts unique ids across active packs but ignores disabled packs", () => {
    expect(() =>
      assertManagedPortableDeliveryLimit([
        { status: "active", capabilityIds: Array.from({ length: 64 }, (_, index) => portableId(index)) },
        { status: "active", capabilityIds: [portableId(0)] },
        { status: "disabled", capabilityIds: [portableId(64)] },
      ]),
    ).not.toThrow();
  });

  it("does not count an unlisted market reference until restore", () => {
    const ids = Array.from({ length: 65 }, (_, index) => portableId(index));
    expect(() =>
      assertManagedPortableDeliveryLimit(
        [{ status: "active", capabilityIds: ids }],
        new Set(ids.slice(0, 64)),
      ),
    ).not.toThrow();
    expect(() =>
      assertManagedPortableDeliveryLimit(
        [{ status: "active", capabilityIds: ids }],
        new Set(ids),
      ),
    ).toThrow(/65\/64/);
  });
});
