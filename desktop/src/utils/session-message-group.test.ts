import { describe, expect, it } from "vitest";
import { mapLoadedSessionMessage } from "./session-message-map";

describe("group message history mapping", () => {
  it("maps stable id, reply quote, attachments and reactions", () => {
    const mapped = mapLoadedSessionMessage(
      {
        id: "gmsg_42",
        role: "assistant",
        content: "我建议先拆成两个任务。",
        agent_id: "product",
        avatar_name: "产品策划师",
        quoted_message_id: "gmsg_41",
        quoted_content: "先给一个结论",
        attachments: [
          {
            id: "artifact-1",
            name: "方案.md",
            mime_type: "text/markdown",
            size: 12,
            kind: "context_file",
          },
        ],
        metadata: {
          is_public: true,
          feed_visibility: "feed",
          group_publication_source: "publish_group_message",
          group_reactions: [{ emoji: "👍", actor_ids: ["user", "product"] }],
        },
      },
      "session-1",
      0,
    );

    expect(mapped.groupMessageId).toBe("gmsg_42");
    expect(mapped.quotedMessageId).toBe("gmsg_41");
    expect(mapped.quotedContent).toBe("先给一个结论");
    expect(mapped.attachments?.[0]?.name).toBe("方案.md");
    expect(mapped.attachments?.[0]?.id).toBe("artifact-1");
    expect(mapped.reactions).toEqual([
      { emoji: "👍", actorIds: ["user", "product"], active: true },
    ]);
  });
});
