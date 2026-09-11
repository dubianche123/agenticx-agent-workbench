import { beforeEach, describe, expect, it, vi } from "vitest";

type TestPane = {
  id: string;
  avatarId: string | null;
  avatarName: string;
  sessionId: string;
};

const store = vi.hoisted(() => ({
  state: {
    panes: [] as TestPane[],
    hydrateAttachmentRoutingLocksFromSessions: vi.fn(),
  },
}));

vi.mock("../store", () => ({
  useAppStore: {
    getState: () => store.state,
  },
}));

import { resolveForwardTarget } from "./resolve-forward-target";

describe("resolveForwardTarget persistent groups", () => {
  const createSession = vi.fn();
  const listSessions = vi.fn();
  const setActivePaneId = vi.fn();
  const setActiveAvatarId = vi.fn();
  const setPaneSessionId = vi.fn((paneId: string, sessionId: string) => {
    const pane = store.state.panes.find((item) => item.id === paneId);
    if (pane) pane.sessionId = sessionId;
  });
  const addPane = vi.fn((avatarId: string | null, avatarName: string, sessionId = "") => {
    const id = `pane-${store.state.panes.length + 1}`;
    store.state.panes.push({ id, avatarId, avatarName, sessionId });
    return id;
  });

  beforeEach(() => {
    store.state = {
      panes: [],
      hydrateAttachmentRoutingLocksFromSessions: vi.fn(),
    };
    createSession.mockReset();
    listSessions.mockReset();
    listSessions.mockResolvedValue({ ok: true, sessions: [] });
    setActivePaneId.mockClear();
    setActiveAvatarId.mockClear();
    setPaneSessionId.mockClear();
    addPane.mockClear();
    vi.stubGlobal("window", {
      agenticxDesktop: { createSession, listSessions },
    });
  });

  it("reuses the existing group session instead of creating a conversation branch", async () => {
    store.state.panes.push({
      id: "pane-group",
      avatarId: "group:product",
      avatarName: "群聊 · 产品需求",
      sessionId: "session-persistent",
    });

    const result = await resolveForwardTarget(
      { type: "group", groupId: "product", displayName: "产品需求" },
      { addPane, setActivePaneId, setActiveAvatarId, setPaneSessionId },
    );

    expect(result).toEqual({ paneId: "pane-group", sessionId: "session-persistent" });
    expect(createSession).not.toHaveBeenCalled();
    expect(setActivePaneId).toHaveBeenCalledWith("pane-group");
  });

  it("creates exactly one session when a group has never been opened", async () => {
    createSession.mockResolvedValue({ ok: true, session_id: "session-created" });

    const result = await resolveForwardTarget(
      { type: "group", groupId: "product", displayName: "产品需求" },
      { addPane, setActivePaneId, setActiveAvatarId, setPaneSessionId },
    );

    expect(result).toEqual({ paneId: "pane-1", sessionId: "session-created" });
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(createSession).toHaveBeenCalledWith({
      avatar_id: "group:product",
      name: "产品需求",
    });
    expect(store.state.panes[0]?.sessionId).toBe("session-created");
  });

  it("reuses a persisted group session even when its pane is not open", async () => {
    listSessions.mockResolvedValueOnce({
      ok: true,
      sessions: [
        {
          session_id: "session-persisted",
          avatar_id: "group:product",
          updated_at: 30,
        },
      ],
    });

    const result = await resolveForwardTarget(
      { type: "group", groupId: "product", displayName: "产品需求" },
      { addPane, setActivePaneId, setActiveAvatarId, setPaneSessionId },
    );

    expect(result).toEqual({ paneId: "pane-1", sessionId: "session-persisted" });
    expect(listSessions).toHaveBeenCalledWith("group:product");
    expect(store.state.hydrateAttachmentRoutingLocksFromSessions).toHaveBeenCalledWith(
      expect.objectContaining({
        0: expect.objectContaining({ session_id: "session-persisted" }),
      }),
    );
    expect(createSession).not.toHaveBeenCalled();
    expect(store.state.panes[0]).toMatchObject({
      avatarId: "group:product",
      sessionId: "session-persisted",
    });
  });

  it("does not create a group session when history lookup fails", async () => {
    listSessions.mockRejectedValueOnce(new Error("offline"));

    await expect(
      resolveForwardTarget(
        { type: "group", groupId: "product", displayName: "产品需求" },
        { addPane, setActivePaneId, setActiveAvatarId, setPaneSessionId },
      ),
    ).rejects.toThrow("无法确认群聊历史会话，请重试");
    expect(createSession).not.toHaveBeenCalled();
    expect(addPane).not.toHaveBeenCalled();
  });

  it("serializes concurrent opens for a group without creating sibling sessions", async () => {
    let releaseList!: (value: { ok: boolean; sessions: [] }) => void;
    listSessions.mockReturnValueOnce(
      new Promise((resolve) => {
        releaseList = resolve;
      }),
    );
    createSession.mockResolvedValue({ ok: true, session_id: "session-created" });

    const payload = { type: "group" as const, groupId: "product", displayName: "产品需求" };
    const first = resolveForwardTarget(payload, {
      addPane,
      setActivePaneId,
      setActiveAvatarId,
      setPaneSessionId,
    });
    const second = resolveForwardTarget(payload, {
      addPane,
      setActivePaneId,
      setActiveAvatarId,
      setPaneSessionId,
    });

    expect(listSessions).toHaveBeenCalledTimes(1);
    expect(addPane).not.toHaveBeenCalled();
    releaseList({ ok: true, sessions: [] });

    await expect(Promise.all([first, second])).resolves.toEqual([
      { paneId: "pane-1", sessionId: "session-created" },
      { paneId: "pane-1", sessionId: "session-created" },
    ]);
    expect(addPane).toHaveBeenCalledTimes(1);
    expect(createSession).toHaveBeenCalledTimes(1);
  });

  it("ignores a stale force-new flag at runtime so groups stay persistent", async () => {
    store.state.panes.push({
      id: "pane-group",
      avatarId: "group:product",
      avatarName: "群聊 · 产品需求",
      sessionId: "session-persistent",
    });

    const result = await resolveForwardTarget(
      {
        type: "group",
        groupId: "product",
        displayName: "产品需求",
        forceNewSession: true,
      } as Parameters<typeof resolveForwardTarget>[0],
      { addPane, setActivePaneId, setActiveAvatarId, setPaneSessionId },
    );

    expect(result.sessionId).toBe("session-persistent");
    expect(createSession).not.toHaveBeenCalled();
  });
});
