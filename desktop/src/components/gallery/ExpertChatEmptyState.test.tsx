import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ExpertChatEmptyState } from "./ExpertChatEmptyState";

describe("ExpertChatEmptyState", () => {
  it("keeps the selected expert visible before the first message", () => {
    const markup = renderToStaticMarkup(
      <ExpertChatEmptyState
        avatar={{
          id: "reviewer",
          name: "专业审核官",
          role: "专业审核专家",
          avatarUrl: "reviewer.png",
          color: "blue",
          description: "负责复核方案与交付质量。",
        }}
      />,
    );

    expect(markup).toContain("reviewer.png");
    expect(markup).toContain("专业审核官");
    expect(markup).toContain("专业审核专家");
    expect(markup).toContain("开始一对一对话");
    expect(markup).not.toContain("企业智能工作台");
  });
});
