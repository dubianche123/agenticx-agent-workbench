import { describe, expect, it } from "vitest";
import { META_AGENT_DISPLAY_NAME } from "../constants/branding";

import {
  GROUP_META_MEMBER_ID,
  groupMemberCandidates,
  resolveGroupMember,
} from "./group-meta-member";

describe("visible group meta member", () => {
  const expert = {
    id: "expert-1",
    name: "技术负责人",
    role: "技术方案",
    avatarUrl: "",
    pinned: false,
    createdBy: "manual",
  };

  it("offers the product meta-agent as an add candidate without implying membership", () => {
    const candidates = groupMemberCandidates([
      expert,
      { ...expert, id: GROUP_META_MEMBER_ID, name: "stale meta" },
    ]);

    expect(candidates.map((item) => item.id)).toEqual([GROUP_META_MEMBER_ID, "expert-1"]);
    expect(candidates[0]?.name).toBe(META_AGENT_DISPLAY_NAME);
    expect(groupMemberCandidates([expert]).map((item) => item.id)).toEqual([
      GROUP_META_MEMBER_ID,
      "expert-1",
    ]);
  });

  it("resolves meta like a normal visible group member", () => {
    expect(resolveGroupMember(GROUP_META_MEMBER_ID, [expert])?.role).toContain("主持");
    expect(resolveGroupMember("expert-1", [expert])).toBe(expert);
  });
});
