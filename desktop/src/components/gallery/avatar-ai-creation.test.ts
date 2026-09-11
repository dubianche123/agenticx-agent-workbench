import { describe, expect, it } from "vitest";

import { buildAiExpertCreationDraft } from "./avatar-ai-creation";

describe("AI expert creation hand-off", () => {
  it("asks the model to complete the profile contract in one confirmed proposal", () => {
    const draft = buildAiExpertCreationDraft("帮我做一个能审查前端代码的专家");

    expect(draft).toContain("帮我做一个能审查前端代码的专家");
    expect(draft).toContain("个性签名");
    expect(draft).toContain("角色定位");
    expect(draft).toContain("专长标签（最多 8 个）");
    expect(draft).toContain("默认运行权限（plan / ask / auto 三选一");
    expect(draft).toContain("IDENTITY.md、SOUL.md、MEMORY.md");
    expect(draft).toContain("专家专属隔离工作区");
    expect(draft).toContain("通过确认卡让我确认");
  });

  it("trims the user's request before handing it to Meta", () => {
    expect(buildAiExpertCreationDraft("  做一个研究专家  ")).toContain("我的需求：\n做一个研究专家\n");
  });
});
