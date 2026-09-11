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

const { useAppStore } = await import("./store");

const PRIVATE_GLM = {
  id: "hc0818-glm-private/glm-5.2",
  provider: "hc0818-glm-private",
  model: "glm-5.2",
  label: "GLM 5.2 私有路由验收",
};

describe("attachment routing lock store", () => {
  beforeEach(() => {
    localStorage.clear();
    useAppStore.setState({ attachmentRoutingLocks: {} });
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it("keeps private routing locks isolated by session and persists both", () => {
    const { setAttachmentRoutingLock } = useAppStore.getState();
    setAttachmentRoutingLock("session-a", PRIVATE_GLM);
    setAttachmentRoutingLock("session-b", { ...PRIVATE_GLM, label: "B 会话私有模型" });

    expect(useAppStore.getState().attachmentRoutingLocks).toEqual({
      "session-a": PRIVATE_GLM,
      "session-b": { ...PRIVATE_GLM, label: "B 会话私有模型" },
    });
    expect(
      JSON.parse(localStorage.getItem("agx-attachment-routing-locks-v1::local") ?? "{}"),
    ).toEqual(useAppStore.getState().attachmentRoutingLocks);
  });

  it("unlocks only the requested session", () => {
    const { setAttachmentRoutingLock } = useAppStore.getState();
    setAttachmentRoutingLock("session-a", PRIVATE_GLM);
    setAttachmentRoutingLock("session-b", PRIVATE_GLM);
    setAttachmentRoutingLock("session-a", null);

    expect(useAppStore.getState().attachmentRoutingLocks).toEqual({
      "session-b": PRIVATE_GLM,
    });
  });

  it("clears every stale session lock when the enterprise policy is disabled", () => {
    const state = useAppStore.getState();
    state.setAttachmentRoutingLock("session-a", PRIVATE_GLM);
    state.setUserAccount({
      ...state.userAccount,
      attachmentRouting: {
        enabled: false,
        allowPublicOverride: false,
        documentTarget: null,
        documentExtensions: [".pdf"],
        imageStrategy: "sticky",
        visionFallback: null,
        maxRenderedPages: 12,
      },
    });

    expect(useAppStore.getState().attachmentRoutingLocks).toEqual({});
    expect(localStorage.getItem("agx-attachment-routing-locks-v1::local")).toBe("{}");
  });
});
