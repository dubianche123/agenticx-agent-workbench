import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GroupChatEmptyState } from "./GroupChatEmptyState";

describe("GroupChatEmptyState", () => {
  it("identifies the active team and its members before the first message", () => {
    const markup = renderToStaticMarkup(
      <GroupChatEmptyState
        group={{
          id: "group-alpha",
          name: "产品交付组",
          avatarIds: ["planner", "reviewer"],
          routing: "team",
          hostAvatarId: "planner",
        }}
        members={[
          {
            id: "planner",
            name: "项目经理",
            role: "规划",
            avatarUrl: "",
            pinned: false,
            createdBy: "test",
          },
          {
            id: "reviewer",
            name: "审核官",
            role: "审核",
            avatarUrl: "",
            pinned: false,
            createdBy: "test",
          },
        ]}
      />,
    );

    expect(markup).toContain("产品交付组");
    expect(markup).toContain("2 位成员 · 主持人：项目经理");
    expect(markup).toContain("项目经理 默认图标");
    expect(markup).toContain("审核官 默认图标");
    expect(markup).toContain(
      "直接发消息由主持人先回应；成员可通过 @ 自然接力，你也可以直接 @指定成员。",
    );
  });

  it("exposes expert details from the empty group state", () => {
    const html = renderToStaticMarkup(
      <GroupChatEmptyState
        group={{
          id: "group-alpha",
          name: "产品交付组",
          avatarIds: ["planner"],
          routing: "intelligent",
          hostAvatarId: "planner",
        }}
        members={[{
          id: "planner",
          name: "项目经理",
          role: "规划",
          avatarUrl: "",
          pinned: false,
          createdBy: "test",
        }]}
        onOpenMember={() => undefined}
      />,
    );

    expect(html).toContain("打开项目经理专家详情");
  });
});
