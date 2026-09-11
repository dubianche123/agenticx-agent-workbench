import { describe, expect, it } from "vitest";

import {
  configMarketActionForStatus,
  configMarketCapabilityChoices,
  configMarketDetailFromPayload,
  configMarketItemsFromPayload,
  configMarketVisibilityLabel,
  filterConfigMarketItems,
  type ConfigMarketItem,
} from "../config-market";

const items: ConfigMarketItem[] = [
  {
    id: "entry-expert",
    capabilityId: "expert:01JQMZ8K3N4P5Q6R7S8T9VWXYZ",
    kind: "expert",
    title: "合同审查专家",
    description: "检查合同风险",
    ownerUserId: "user-li-lei",
    ownerDisplayName: "李雷",
    visibility: "company",
    visibleDepartmentIds: [],
    visibleUserIds: [],
    status: "published",
    releaseId: "01JQMZ8K3N4P5Q6R7S8T9VWX01",
    version: "1.0.0",
    downloadCount: 12,
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-21T00:00:00.000Z",
  },
  {
    id: "entry-group",
    capabilityId: "group:01JQMZ8K3N4P5Q6R7S8T9VWXY0",
    kind: "group",
    title: "新品发布项目群",
    description: "发布协同模板",
    ownerUserId: "user-han-meimei",
    ownerDisplayName: "韩梅梅",
    visibility: "departments",
    visibleDepartmentIds: ["dept-product"],
    visibleUserIds: [],
    status: "unlisted",
    releaseId: "01JQMZ8K3N4P5Q6R7S8T9VWX02",
    version: "1.1.0",
    downloadCount: 3,
    createdAt: "2026-08-18T00:00:00.000Z",
    updatedAt: "2026-08-22T00:00:00.000Z",
  },
];

const runtimeReview = {
  recommendedPermissionMode: "ask" as const,
  expertPermissions: [{ name: "合同审查专家", defaultPermissionMode: "auto" as const }],
  dependencies: [{
    kind: "skill" as const,
    capabilityId: "skill:01JQMZ8K3N4P5Q6R7S8T9VWX03",
    version: "1.0.0",
    digest: "a".repeat(64),
    required: true,
  }],
  resources: [{ path: "SOUL.md", content: "不得泄露合同内容", digest: "b".repeat(64) }],
};

describe("config market API payload", () => {
  it("reads the documented data.items response without rewriting capability ids", () => {
    expect(
      configMarketItemsFromPayload({ code: "00000", message: "ok", data: { items } }),
    ).toEqual(items);
  });

  it("drops malformed rows and rows whose capability prefix disagrees with kind", () => {
    expect(
      configMarketItemsFromPayload({
        data: {
          items: [
            items[0],
            { ...items[1], capabilityId: "expert:wrong-kind" },
            { ...items[1], status: "draft" },
            { ...items[1], visibility: undefined },
            { ...items[1], downloadCount: -1 },
            { ...items[1], downloadCount: 1.5 },
            { ...items[1], downloadCount: "3" },
          ],
        },
      }),
    ).toEqual([items[0]]);
  });

  it("accepts personal rows only with empty targets and labels them explicitly", () => {
    const personal: ConfigMarketItem = {
      ...items[0]!,
      id: "personal-entry",
      visibility: "personal",
      visibleDepartmentIds: [],
      visibleUserIds: [],
    };
    expect(configMarketItemsFromPayload({ data: { items: [personal] } })).toEqual([personal]);
    expect(configMarketVisibilityLabel(personal)).toBe("仅自己");
    expect(configMarketItemsFromPayload({
      data: {
        items: [{ ...personal, visibleUserIds: ["user-a"] }],
      },
    })).toEqual([]);
  });

  it("ignores unpublished prototype response shapes", () => {
    expect(configMarketItemsFromPayload({ data: { entries: items } })).toEqual([]);
    expect(configMarketItemsFromPayload({ items })).toEqual([]);
  });

  it("parses the full expert prompt detail used by the admin review gate", () => {
    expect(
      configMarketDetailFromPayload({
        data: {
          item: items[0],
          promptPreview: {
            kind: "expert",
            name: "合同审查专家",
            role: "法务",
            systemPrompt: "先逐条识别风险，再给出引用。",
          },
          runtimeReview,
        },
      }),
    ).toEqual({
      item: items[0],
      promptPreview: {
        kind: "expert",
        name: "合同审查专家",
        role: "法务",
        systemPrompt: "先逐条识别风险，再给出引用。",
      },
      runtimeReview,
    });
  });

  it("parses a Skill detail with SKILL.md structure-check metadata", () => {
    const item: ConfigMarketItem = {
      ...items[0]!,
      id: "skill-entry",
      capabilityId: "skill:01JQMZ8K3N4P5Q6R7S8T9VWX03",
      kind: "skill",
      title: "会议纪要 Skill",
      visibility: "admins_only",
    };
    const skillMd = "---\nname: 会议纪要 Skill\ndescription: |\n  整理会议纪要\n---\n\n提取行动项。";
    expect(
      configMarketDetailFromPayload({
        data: {
          item,
          promptPreview: {
            kind: "skill",
            name: "会议纪要 Skill",
            description: "整理会议纪要",
            skillMd,
            checkResult: {
              status: "passed",
              findings: [],
              frontMatter: { name: "会议纪要 Skill", description: "整理会议纪要" },
            },
          },
          runtimeReview: {
            recommendedPermissionMode: "ask",
            expertPermissions: [],
            dependencies: [],
            resources: [],
          },
        },
      }),
    ).toMatchObject({
      item: { kind: "skill", visibility: "admins_only" },
      promptPreview: { kind: "skill", skillMd },
      runtimeReview: { expertPermissions: [] },
    });
  });

  it("rejects a prompt preview whose kind or group host index is inconsistent", () => {
    expect(
      configMarketDetailFromPayload({
        data: {
          item: items[0],
          promptPreview: { kind: "group", hostMemberIndex: 0, members: [] },
        },
      }),
    ).toBeNull();
    expect(
      configMarketDetailFromPayload({
        data: {
          item: { ...items[1], status: "published" },
          promptPreview: {
            kind: "group",
            hostMemberIndex: 1,
            members: [{ name: "主持人", role: "协调", systemPrompt: "协调讨论" }],
          },
        },
      }),
    ).toBeNull();
  });
});

describe("config market capability choices", () => {
  it("keeps listed and existing unlisted market entries, disabling only the latter", () => {
    expect(configMarketCapabilityChoices(items)).toEqual([
      {
        id: items[0]!.capabilityId,
        kind: "expert",
        name: items[0]!.capabilityId,
        displayName: "合同审查专家",
        disabled: false,
        description: "检查合同风险 · 当前版本：v1.0.0 · 市场可见：全公司；能力包下发范围由管理员另行决定",
      },
      {
        id: items[1]!.capabilityId,
        kind: "group",
        name: items[1]!.capabilityId,
        displayName: "新品发布项目群",
        disabled: true,
        description: "发布协同模板 · 当前版本：v1.1.0 · 市场可见：指定部门（1）；能力包下发范围由管理员另行决定",
      },
    ]);
  });

  it("marks an admins-only market Skill as shelf-managed and keeps it visible after unlisting", () => {
    const skill: ConfigMarketItem = {
      ...items[0]!,
      id: "entry-skill",
      capabilityId: "skill:01JQMZ8K3N4P5Q6R7S8T9VWX03",
      kind: "skill",
      title: "会议纪要 Skill",
      visibility: "admins_only",
      status: "unlisted",
      version: "2.0.0",
    };
    const [choice] = configMarketCapabilityChoices([skill]);
    expect(choice).toMatchObject({
      id: skill.capabilityId,
      kind: "skill",
      shelfManaged: true,
      disabled: true,
    });
    expect(configMarketVisibilityLabel(skill)).toBe("仅管理员");

    const [submitted] = configMarketCapabilityChoices([{ ...skill, status: "published" }]);
    expect(submitted).toMatchObject({
      id: skill.capabilityId,
      shelfManaged: true,
      disabled: false,
    });
  });

  it("maps statuses to the only two allowed PATCH actions", () => {
    expect(configMarketActionForStatus("published")).toBe("unlist");
    expect(configMarketActionForStatus("unlisted")).toBe("restore");
  });

  it("filters the admin shelf by status and human-facing fields", () => {
    expect(filterConfigMarketItems(items, "published", "李雷").map((item) => item.id)).toEqual([
      "entry-expert",
    ]);
    expect(filterConfigMarketItems(items, "all", "新品发布").map((item) => item.id)).toEqual([
      "entry-group",
    ]);
    expect(filterConfigMarketItems(items, "all", "指定部门").map((item) => item.id)).toEqual([
      "entry-group",
    ]);
  });
});
