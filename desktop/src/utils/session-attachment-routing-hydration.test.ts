import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

class MemoryStorage {
  private values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, String(value));
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  clear(): void {
    this.values.clear();
  }
}

const localStorage = new MemoryStorage();
vi.stubGlobal("window", {
  localStorage,
  agenticxDesktop: {
    getBackendScopeSync: () => "local",
  },
});

const { useAppStore } = await import("../store");

const CACHED_TARGET = {
  id: "cached/private-model",
  provider: "cached",
  model: "private-model",
  label: "缓存模型",
};
const SERVER_TARGET = {
  id: "server/private-model",
  provider: "server",
  model: "private-model",
  label: "服务端私有模型",
};

describe("session attachment routing hydration", () => {
  beforeEach(() => {
    localStorage.clear();
    useAppStore.setState({ attachmentRoutingLocks: {} });
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it("uses the detail/list response as authority over the warm local cache", () => {
    const state = useAppStore.getState();
    state.setAttachmentRoutingLock("session-a", CACHED_TARGET);
    state.setAttachmentRoutingLock("session-b", CACHED_TARGET);

    state.hydrateAttachmentRoutingLocksFromSessions([
      { session_id: "session-a", attachment_routing_lock: SERVER_TARGET },
      { session_id: "session-b", attachment_routing_lock: null },
    ]);

    expect(useAppStore.getState().attachmentRoutingLocks).toEqual({
      "session-a": SERVER_TARGET,
    });
  });

  it("keeps sessions outside a filtered list while reconciling explicit nulls", () => {
    const state = useAppStore.getState();
    state.setAttachmentRoutingLock("session-a", CACHED_TARGET);
    state.setAttachmentRoutingLock("session-b", CACHED_TARGET);

    state.hydrateAttachmentRoutingLocksFromSessions([
      { session_id: "session-a", attachment_routing_lock: null },
    ]);

    expect(useAppStore.getState().attachmentRoutingLocks).toEqual({
      "session-b": CACHED_TARGET,
    });
  });

  it("rejects malformed server markers instead of displaying arbitrary metadata", () => {
    useAppStore.getState().setAttachmentRoutingLock("session-a", CACHED_TARGET);
    useAppStore.getState().hydrateAttachmentRoutingLocksFromSessions([
      {
        session_id: "session-a",
        attachment_routing_lock: {
          provider: "",
          model: "private-model",
          label: "should not display",
          api_key: "secret",
        },
      },
    ]);

    expect(useAppStore.getState().attachmentRoutingLocks).toEqual({});
  });
});
