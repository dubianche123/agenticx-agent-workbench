import { describe, expect, it, vi } from "vitest";

import type { Avatar } from "../../store";
import {
  createExpertFromOfficialTemplate,
  isOfficialExpertTemplateAvatar,
  listOfficialGroupMemberTemplates,
  listOfficialExpertTemplates,
  listOfficialPlazaTemplates,
  nextAvailableOfficialExpertName,
} from "./plaza-official-templates";

const avatar = (overrides: Partial<Avatar> = {}): Avatar => ({
  id: "builtin-env",
  name: "环境配置专家",
  role: "环境配置顾问",
  avatarUrl: "",
  pinned: false,
  createdBy: "builtin",
  description: "帮助配置本地开发环境。",
  systemPrompt: "先检查环境，再给出最小修改建议。",
  tags: ["builtin:env-setup", "内置", "开发环境"],
  ...overrides,
});

describe("official plaza expert templates", () => {
  it("recognizes builtin experts and removes internal-only tags from the plaza template", () => {
    const builtin = avatar();
    const regular = avatar({
      id: "user-expert",
      name: "用户专家",
      createdBy: "user",
      tags: ["研发"],
    });

    expect(isOfficialExpertTemplateAvatar(builtin)).toBe(true);
    expect(isOfficialExpertTemplateAvatar(regular)).toBe(false);
    expect(listOfficialExpertTemplates([regular, builtin])).toEqual([
      expect.objectContaining({
        id: "env-setup",
        name: "环境配置专家",
        tags: ["开发环境"],
      }),
    ]);
  });

  it("creates an independent expert through the existing API without copying local privileges", async () => {
    const createAvatar = vi.fn(
      async (payload: Parameters<Window["agenticxDesktop"]["createAvatar"]>[0]) => ({
        ok: true,
        avatar: {
          id: "created-env",
          name: payload.name,
          role: payload.role,
          created_by: payload.created_by,
        },
      }),
    );
    const template = listOfficialExpertTemplates([avatar()])[0];

    const result = await createExpertFromOfficialTemplate({
      template,
      existingNames: ["环境配置专家"],
      api: { createAvatar },
    });

    expect(result.name).toBe("环境配置专家 2");
    expect(createAvatar).toHaveBeenCalledWith({
      name: "环境配置专家 2",
      role: "环境配置顾问",
      description: "帮助配置本地开发环境。",
      system_prompt: "先检查环境，再给出最小修改建议。",
      tags: ["官方模板", "开发环境"],
      created_by: "official_template:env-setup",
    });
    expect(createAvatar.mock.calls[0][0]).not.toHaveProperty("workspace_dir");
    expect(createAvatar.mock.calls[0][0]).not.toHaveProperty("tools_enabled");
    expect(createAvatar.mock.calls[0][0]).not.toHaveProperty("skills_enabled");
    expect(createAvatar.mock.calls[0][0]).not.toHaveProperty("default_model");
  });

  it("allocates deterministic copy names", () => {
    expect(nextAvailableOfficialExpertName("数据专家", [])).toBe("数据专家");
    expect(nextAvailableOfficialExpertName("数据专家", ["数据专家", "数据专家 2"])).toBe(
      "数据专家 3",
    );
  });

  it("promotes unique group-template members into standalone official experts", () => {
    const templates = listOfficialGroupMemberTemplates();
    const names = templates.map((template) => template.name.trim().toLocaleLowerCase());

    expect(templates.length).toBeGreaterThan(20);
    expect(new Set(names).size).toBe(names.length);
    expect(new Set(templates.map((template) => template.id)).size).toBe(templates.length);
    expect(templates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "产品策划师",
          description: "负责把模糊想法转化为边界清晰、可实施、可验收的产品需求。",
        }),
        expect.objectContaining({
          name: "代码审查官",
          tags: expect.arrayContaining(["代码评审"]),
        }),
      ]),
    );

    const productPlanner = templates.find((template) => template.name === "产品策划师");
    expect(productPlanner?.systemPrompt).toContain("你是「产品策划师」");
    expect(productPlanner?.systemPrompt).not.toContain("团队中的");
    expect(productPlanner?.systemPrompt).toContain("核心职责：");
    expect(productPlanner?.systemPrompt).toContain("默认交付物：");
  });

  it("keeps the builtin expert and group-member examples unique in the plaza", () => {
    const plaza = listOfficialPlazaTemplates([avatar()]);
    const experts = plaza.filter((item) => item.kind === "expert");
    const names = experts.map((item) => item.title.trim().toLocaleLowerCase());

    expect(experts.some((item) => item.title === "环境配置专家")).toBe(true);
    expect(new Set(names).size).toBe(names.length);
    expect(experts.some((item) => item.title === "产品策划师")).toBe(true);
  });

  it("surfaces an API failure instead of reporting a successful add", async () => {
    const template = listOfficialExpertTemplates([avatar()])[0];

    await expect(
      createExpertFromOfficialTemplate({
        template,
        existingNames: [],
        api: {
          createAvatar: vi.fn(async () => ({ ok: false, error: "服务不可用" })),
        },
      }),
    ).rejects.toThrow("服务不可用");
  });
});
