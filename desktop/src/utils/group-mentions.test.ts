import { describe, expect, it } from "vitest";
import { extractGroupMentionIds, groupAllMentionMatchesQuery } from "./group-mentions";

const members = [
  { id: "product", name: "产品需求全流程 · 产品策划师" },
  { id: "tech", name: "技术负责人" },
  { id: "qa", name: "质量专家" },
];

describe("extractGroupMentionIds", () => {
  it("matches a complete expert name containing spaces and punctuation", () => {
    expect(
      extractGroupMentionIds("@产品需求全流程 · 产品策划师 请先梳理需求", members),
    ).toEqual(["product"]);
  });

  it("matches a unique last-segment alias with Chinese punctuation boundaries", () => {
    expect(extractGroupMentionIds("请@产品策划师，继续梳理需求。", members)).toEqual([
      "product",
    ]);
  });

  it("does not route an ambiguous short alias, while complete names remain routable", () => {
    const ambiguousMembers = [
      { id: "product-a", name: "产品需求全流程 · 产品策划师" },
      { id: "product-b", name: "增长方案全流程 • 产品策划师" },
    ];

    expect(extractGroupMentionIds("@产品策划师", ambiguousMembers)).toEqual([]);
    expect(
      extractGroupMentionIds("@增长方案全流程 • 产品策划师", ambiguousMembers),
    ).toEqual(["product-b"]);
  });

  it("preserves visible mention order and removes duplicates", () => {
    expect(
      extractGroupMentionIds("@技术负责人 先说，随后 @质量专家，最后再问 @技术负责人。", members),
    ).toEqual(["tech", "qa"]);
  });

  it("expands @所有人 and @all to the room members in room order", () => {
    expect(extractGroupMentionIds("@所有人 依次给一个观点", members)).toEqual([
      "product",
      "tech",
      "qa",
    ]);
    expect(extractGroupMentionIds("＠all please respond", members)).toEqual([
      "product",
      "tech",
      "qa",
    ]);
  });

  it("keeps the coordinator separate from @所有人", () => {
    expect(
      extractGroupMentionIds("@所有人 先回答，@Near 最后总结", members, {
        metaId: "__meta__",
        metaLabels: ["Near", "组长"],
      }),
    ).toEqual(["product", "tech", "qa", "__meta__"]);
  });

  it("recognizes the explicit host label only when the caller enables it", () => {
    expect(extractGroupMentionIds("@主持人 请编排团队", members)).toEqual([]);
    expect(
      extractGroupMentionIds("@主持人 请编排团队", members, {
        metaId: "__meta__",
        metaLabels: ["主持人"],
      }),
    ).toEqual(["__meta__"]);
  });

  it("does not treat a longer word as an @all mention", () => {
    expect(extractGroupMentionIds("@alliance 不是群发", members)).toEqual([]);
  });
});

describe("groupAllMentionMatchesQuery", () => {
  it("supports both Chinese and English discovery queries", () => {
    expect(groupAllMentionMatchesQuery("所有")).toBe(true);
    expect(groupAllMentionMatchesQuery("all")).toBe(true);
    expect(groupAllMentionMatchesQuery("技术")).toBe(false);
  });
});
