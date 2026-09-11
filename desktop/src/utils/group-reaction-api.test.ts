import { afterEach, describe, expect, it, vi } from "vitest";
import { toggleGroupMessageReaction } from "./group-reaction-api";

describe("toggleGroupMessageReaction", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts the fixed user actor and returns the server aggregate", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        group_id: "group-1",
        session_id: "session-1",
        message_id: "gmsg-1",
        actor_id: "user",
        emoji: "👍",
        active: true,
        reactions: [{ emoji: "👍", actor_ids: ["user"] }],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      toggleGroupMessageReaction({
        apiBase: "http://localhost:3000/",
        apiToken: "desktop-token",
        groupId: "group-1",
        sessionId: "session-1",
        messageId: "gmsg-1",
        emoji: "👍",
      }),
    ).resolves.toMatchObject({ active: true, message_id: "gmsg-1" });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:3000/api/groups/group-1/messages/gmsg-1/reaction",
      expect.objectContaining({
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-agx-desktop-token": "desktop-token",
        },
        body: JSON.stringify({ session_id: "session-1", actor: "user", emoji: "👍" }),
      }),
    );
  });

  it("surfaces a rejected response so ChatPane can roll back optimistically", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        json: async () => ({ detail: "session is not bound to the requested group" }),
      }),
    );

    await expect(
      toggleGroupMessageReaction({
        apiBase: "http://localhost:3000",
        apiToken: "",
        groupId: "group-1",
        sessionId: "session-1",
        messageId: "gmsg-1",
        emoji: "👍",
      }),
    ).rejects.toThrow("session is not bound to the requested group");
  });

  it("rejects incomplete input before making a request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      toggleGroupMessageReaction({
        apiBase: "",
        apiToken: "",
        groupId: "group-1",
        sessionId: "session-1",
        messageId: "gmsg-1",
        emoji: "👍",
      }),
    ).rejects.toThrow("群消息回应参数不完整");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
