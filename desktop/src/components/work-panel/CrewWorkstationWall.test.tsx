import { describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { META_AGENT_DISPLAY_NAME } from "../../constants/branding";
import type { Avatar } from "../../store";
import type { CrewSlot } from "../../utils/group-member-activity";
import { createGroupMetaMember } from "../../utils/group-meta-member";
import { CrewWorkstationWall } from "./CrewWorkstationWall";

function slot(partial: Partial<CrewSlot> & Pick<CrewSlot, "agentId" | "phase">): CrewSlot {
  return {
    actionText: "",
    elapsedMs: 0,
    replies: 0,
    toolCalls: 0,
    lastTs: 0,
    ...partial,
  };
}

type ButtonProps = {
  "aria-label"?: string;
  onClick?: (event?: { stopPropagation: () => void }) => void;
  children?: ReactNode;
};

function collectButtons(node: ReactNode): Array<ReactElement<ButtonProps>> {
  if (Array.isArray(node)) return node.flatMap((item) => collectButtons(item));
  if (!isValidElement(node)) return [];
  const props = node.props as { children?: ReactNode };
  const own = node.type === "button" ? [node as ReactElement<ButtonProps>] : [];
  return [...own, ...collectButtons(props.children)];
}

describe("CrewWorkstationWall", () => {
  it("renders running action text with shimmer", () => {
    const html = renderToStaticMarkup(
      <CrewWorkstationWall
        slots={[
          slot({
            agentId: "a1",
            phase: "running",
            actionText: "正在调用 file_read",
            elapsedMs: 12_000,
          }),
        ]}
        avatarById={new Map()}
        metaLeaderLabel={META_AGENT_DISPLAY_NAME}
      />,
    );
    expect(html).toContain("正在调用 file_read");
    expect(html).toContain("agx-working-shimmer");
    expect(html).toContain("12s");
  });

  it("keeps idle slots static without shimmer or duration", () => {
    const html = renderToStaticMarkup(
      <CrewWorkstationWall
        slots={[slot({ agentId: "a1", phase: "idle" })]}
        avatarById={new Map()}
        metaLeaderLabel={META_AGENT_DISPLAY_NAME}
      />,
    );
    expect(html).not.toContain("agx-working-shimmer");
    expect(html).not.toContain("12s");
    expect(html).toContain("未执行");
  });

  it("uses the explicit Meta member label instead of the current host label", () => {
    const meta = createGroupMetaMember();
    const html = renderToStaticMarkup(
      <CrewWorkstationWall
        slots={[slot({ agentId: "__meta__", phase: "idle" })]}
        avatarById={new Map([[meta.id, meta]])}
        metaLeaderLabel="项目经理"
      />,
    );

    expect(html).toContain(`>${META_AGENT_DISPLAY_NAME}</div>`);
    expect(html).not.toContain(">项目经理</div>");
  });

  it("renders nearby actions only when callbacks are provided", () => {
    const withCbs = renderToStaticMarkup(
      <CrewWorkstationWall
        slots={[slot({ agentId: "a1", phase: "waiting", actionText: "等待确认后继续" })]}
        avatarById={new Map()}
        metaLeaderLabel={META_AGENT_DISPLAY_NAME}
        onAppendDirective={vi.fn()}
        onSwitchModel={vi.fn()}
        onInterrupt={vi.fn()}
      />,
    );
    expect(withCbs).toContain("追加指令");
    expect(withCbs).toContain("换模型");
    expect(withCbs).toContain("打断");

    const withoutCbs = renderToStaticMarkup(
      <CrewWorkstationWall
        slots={[slot({ agentId: "a1", phase: "waiting", actionText: "等待确认后继续" })]}
        avatarById={new Map()}
        metaLeaderLabel={META_AGENT_DISPLAY_NAME}
      />,
    );
    expect(withoutCbs).not.toContain("追加指令");
    expect(withoutCbs).not.toContain("换模型");
    expect(withoutCbs).not.toContain("打断");
  });

  it("invokes the detail callback for real members but keeps the meta identity static", () => {
    const onOpenMember = vi.fn();
    const avatar: Avatar = {
      id: "a1",
      name: "项目经理",
      role: "规划",
      avatarUrl: "",
      pinned: false,
      createdBy: "test",
    };
    const tree = CrewWorkstationWall({
      slots: [
        slot({ agentId: "a1", phase: "idle" }),
        slot({ agentId: "__meta__", phase: "idle" }),
      ],
      avatarById: new Map([[avatar.id, avatar]]),
      metaLeaderLabel: META_AGENT_DISPLAY_NAME,
      onOpenMember,
    });
    const buttons = collectButtons(tree);
    const memberButtons = buttons.filter(
      (button) => button.props["aria-label"] === "打开项目经理专家详情",
    );

    expect(memberButtons).toHaveLength(2);
    memberButtons[0]?.props.onClick?.();
    expect(onOpenMember).toHaveBeenCalledTimes(1);
    expect(onOpenMember).toHaveBeenCalledWith("a1");
    expect(
      buttons.some((button) => button.props["aria-label"] === `打开${META_AGENT_DISPLAY_NAME}专家详情`),
    ).toBe(false);
  });

  it("renders a removable action in the same status row when membership editing is enabled", () => {
    const onRemoveMember = vi.fn();
    const tree = CrewWorkstationWall({
      slots: [slot({ agentId: "a1", phase: "replied", replies: 1 })],
      avatarById: new Map(),
      metaLeaderLabel: META_AGENT_DISPLAY_NAME,
      onRemoveMember,
    });
    const buttons = collectButtons(tree);
    const removeButton = buttons.find((button) => button.props["aria-label"] === "移出成员 a1");

    expect(removeButton).toBeDefined();
    removeButton?.props.onClick?.({ stopPropagation: vi.fn() });
    expect(onRemoveMember).toHaveBeenCalledWith("a1");
  });
});
