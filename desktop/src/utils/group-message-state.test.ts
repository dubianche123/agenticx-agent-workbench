import { describe, expect, it } from "vitest";
import type { Message } from "../store";
import {
  applyGroupReactionEvent,
  applyGroupReactionToMessages,
  groupMessageIdFromRecord,
  isPublicGroupMessage,
  normalizeGroupReactions,
  toggleGroupReaction,
} from "./group-message-state";

describe("group-message-state", () => {
  it("normalizes persisted snake_case reaction aggregates", () => {
    expect(
      normalizeGroupReactions([
        { emoji: "👍", actor_ids: ["a1", "a1", "a2"] },
        { emoji: "not-supported", actor_ids: ["bad"] },
      ]),
    ).toEqual([{ emoji: "👍", actorIds: ["a1", "a2"] }]);
  });

  it("resolves stable ids without promoting ordinary session ids", () => {
    expect(groupMessageIdFromRecord({ id: "gmsg_123" })).toBe("gmsg_123");
    expect(groupMessageIdFromRecord({ message_id: "gmsg_live" })).toBe("gmsg_live");
    expect(groupMessageIdFromRecord({ id: "session-index-1" })).toBeUndefined();
    expect(
      groupMessageIdFromRecord({ id: "session-index-1", metadata: { group_publication_source: "router" } }),
    ).toBe("session-index-1");
  });

  it("allows public assistant and user rows but rejects private panel rows", () => {
    expect(isPublicGroupMessage({ groupMessageId: "gmsg-user", metadata: { client_turn_id: "turn-1" } })).toBe(false);
    expect(isPublicGroupMessage({ groupMessageId: "gmsg-a", metadata: { group_publication_source: "router" } })).toBe(false);
    expect(isPublicGroupMessage({ groupMessageId: "gmsg-user", metadata: { is_public: true, feed_visibility: "feed" } })).toBe(true);
    expect(isPublicGroupMessage({ groupMessageId: "gmsg-a", metadata: { feed_visibility: "feed", group_publication_source: "router" } })).toBe(true);
    expect(isPublicGroupMessage({ groupMessageId: "gmsg-private", metadata: { feed_visibility: "panel" } })).toBe(false);
    expect(isPublicGroupMessage({ groupMessageId: "gmsg-private", metadata: { is_public: false } })).toBe(false);
    expect(isPublicGroupMessage({ groupMessageId: "gmsg-private", metadata: { event_type: "group_workflow_detail" } })).toBe(false);
    expect(isPublicGroupMessage({ groupMessageId: "gmsg-tool", role: "tool", metadata: {} })).toBe(false);
  });

  it("toggles a user's reaction while retaining the aggregate count", () => {
    const first = toggleGroupReaction([], "❤️", true, "user");
    expect(first).toEqual([{ emoji: "❤️", actorIds: ["user"], active: true }]);
    const second = toggleGroupReaction(
      toggleGroupReaction(first, "❤️", true, "member-a"),
      "❤️",
      false,
      "user",
    );
    expect(second).toEqual([{ emoji: "❤️", actorIds: ["member-a"] }]);
  });

  it("keeps other active reactions highlighted when one is toggled", () => {
    const current = [
      { emoji: "👍", actorIds: ["user"], active: true },
      { emoji: "😂", actorIds: ["user"], active: true },
    ];
    expect(toggleGroupReaction(current, "👍", false, "user")).toEqual([
      { emoji: "😂", actorIds: ["user"], active: true },
    ]);
  });

  it("does not mark another member's reaction as active for the viewer", () => {
    const message = {
      id: "local",
      role: "assistant",
      content: "收到",
      groupMessageId: "gmsg_1",
      reactions: [],
    } satisfies Message;
    const updated = applyGroupReactionEvent(
      message,
      { message_id: "gmsg_1", emoji: "👀", active: true, actor_id: "member-a" },
      "user",
    );
    expect(updated.reactions).toEqual([{ emoji: "👀", actorIds: ["member-a"] }]);
  });

  it("updates only the target stable group message", () => {
    const messages: Message[] = [
      { id: "a", role: "assistant", content: "same", groupMessageId: "gmsg_a" },
      { id: "b", role: "assistant", content: "same", groupMessageId: "gmsg_b" },
    ];
    const updated = applyGroupReactionToMessages(messages, "gmsg_b", {
      message_id: "gmsg_b",
      reactions: [{ emoji: "🎉", actor_ids: ["user"] }],
    }, "user");
    expect(updated[0].reactions).toBeUndefined();
    expect(updated[1].reactions).toEqual([{ emoji: "🎉", actorIds: ["user"], active: true }]);
  });
});
