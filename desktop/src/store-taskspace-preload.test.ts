import { beforeEach, describe, expect, it } from "vitest";

import { useAppStore } from "./store";

describe("taskspace preload cache", () => {
  beforeEach(() => {
    useAppStore.setState({ preloadedTaskspacesBySessionId: {} });
  });

  it("replaces a startup snapshot after a live workspace refresh", () => {
    const cached = [{ id: "default", label: "默认", path: "/session/default" }];
    const live = [
      ...cached,
      { id: "ts-repo", label: "项目仓库", path: "/workspaces/repo" },
    ];

    useAppStore.setState({ preloadedTaskspacesBySessionId: { "session-a": cached } });
    useAppStore.getState().setPreloadedTaskspaces("session-a", live);

    expect(useAppStore.getState().preloadedTaskspacesBySessionId["session-a"]).toEqual(live);
  });

  it("does not create an empty cache key for a missing session id", () => {
    useAppStore.getState().setPreloadedTaskspaces(" ", []);
    expect(useAppStore.getState().preloadedTaskspacesBySessionId).toEqual({});
  });
});
