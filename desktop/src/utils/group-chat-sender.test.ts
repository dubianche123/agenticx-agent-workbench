import { describe, expect, it } from "vitest";
import { META_AGENT_DISPLAY_NAME } from "../constants/branding";
import type { Avatar, Message } from "../store";
import {
  HISTORICAL_GROUP_META_RENDER_ID,
  messageForGroupRenderer,
  resolveGroupChatSender,
} from "./group-chat-sender";

function avatar(id: string, name: string): Avatar {
  return {
    id,
    name,
    role: "数字专家",
    avatarUrl: `${id}.png`,
    pinned: false,
    createdBy: "test",
  };
}

describe("group chat sender identity", () => {
  it("keeps a historical Meta author instead of substituting the current host", () => {
    const sender = resolveGroupChatSender(
      {
        role: "assistant",
        agentId: "__meta__",
        avatarName: "历史协调员",
        avatarUrl: "history-meta.png",
      },
      {
        groupMembers: [avatar("current-host", "当前主持人")],
        host: avatar("current-host", "当前主持人"),
        userLabel: "用户",
        userAvatarUrl: "user.png",
      },
    );

    expect(sender).toEqual({ name: "历史协调员", url: "history-meta.png" });
    expect(sender.name).not.toBe("当前主持人");
    expect(sender.avatarId).toBeUndefined();
  });

  it("uses the persisted Meta member identity when Meta is still in the group", () => {
    const meta = avatar("__meta__", META_AGENT_DISPLAY_NAME);
    const sender = resolveGroupChatSender(
      {
        role: "assistant",
        agentId: "__meta__",
        avatarName: "旧名称",
      },
      {
        groupMembers: [meta, avatar("current-host", "当前主持人")],
        host: avatar("current-host", "当前主持人"),
        userLabel: "用户",
        userAvatarUrl: "",
      },
    );

    expect(sender).toMatchObject({ name: META_AGENT_DISPLAY_NAME, avatarId: "__meta__" });
  });

  it("marks only inactive historical Meta messages for render-time identity handling", () => {
    const historical = {
      id: "history-1",
      role: "assistant",
      content: "历史回复",
      agentId: "__meta__",
      avatarName: "历史协调员",
    } satisfies Message;
    const sender = resolveGroupChatSender(historical, {
      groupMembers: [avatar("current-host", "当前主持人")],
      host: avatar("current-host", "当前主持人"),
      userLabel: "用户",
      userAvatarUrl: "",
    });
    const rendered = messageForGroupRenderer(historical, sender);

    expect(rendered).toMatchObject({
      id: historical.id,
      avatarName: historical.avatarName,
      agentId: HISTORICAL_GROUP_META_RENDER_ID,
    });
    expect(historical.agentId).toBe("__meta__");
  });
});
