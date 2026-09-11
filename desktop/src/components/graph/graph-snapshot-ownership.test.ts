import { describe, expect, it } from "vitest";
import {
  GraphSnapshotOwnership,
  graphOwned,
  graphRefreshMatchesLiveRun,
  graphSnapshotMatchesOwner,
  graphSnapshotOwnerKey,
  isGraphOwned,
  type GraphSnapshotOwner,
} from "./graph-snapshot-ownership";

function owner(overrides: Partial<GraphSnapshotOwner> = {}): GraphSnapshotOwner {
  return {
    paneId: "pane-1",
    sessionId: "session-a",
    groupId: "group-a",
    apiBase: "http://studio",
    apiToken: "token-a",
    runId: "run-a",
    ...overrides,
  };
}

describe("GraphSnapshotOwnership", () => {
  it("rejects a deferred no-run refresh after a live run is created", async () => {
    let release!: () => void;
    const response = new Promise<void>((resolve) => {
      release = resolve;
    });
    const requestRunId = "";
    const selectedRunId = "run-old";
    let liveActiveRunId = "";
    let liveGraphRunId = "";
    const refreshResult = response.then(() =>
      graphRefreshMatchesLiveRun(
        requestRunId,
        selectedRunId,
        liveActiveRunId,
        liveGraphRunId,
      ),
    );

    // The live graph.run_created arrives while the old list/snapshot request
    // is still deferred. Its response must not switch the pane back to the
    // stale list candidate.
    liveActiveRunId = "run-new";
    liveGraphRunId = "run-new";
    release();

    await expect(refreshResult).resolves.toBe(false);
  });

  it("allows a refresh only while live run ids are empty or equal to its selection", () => {
    expect(graphRefreshMatchesLiveRun("", "", "", "")).toBe(true);
    expect(graphRefreshMatchesLiveRun("", "run-new", "run-new", "run-new")).toBe(true);
    expect(graphRefreshMatchesLiveRun("", "run-old", "run-new", "run-new")).toBe(false);
    expect(graphRefreshMatchesLiveRun("run-old", "run-new", "run-old", "run-old")).toBe(
      true,
    );
    expect(graphRefreshMatchesLiveRun("run-old", "run-new", "run-new", "run-new")).toBe(
      false,
    );
  });

  it("rejects a late response after the pane session changes", () => {
    const guard = new GraphSnapshotOwnership(owner());
    const oldRequest = guard.begin();

    guard.update(owner({ sessionId: "session-b", runId: "run-b" }));

    expect(guard.isCurrent(oldRequest)).toBe(false);
    expect(guard.claimRun(oldRequest, "run-a")).toBeNull();
  });

  it("makes overlapping refresh leases latest-wins for one owner", () => {
    const guard = new GraphSnapshotOwnership(owner());
    const first = guard.begin();
    const second = guard.begin();

    expect(guard.isCurrent(first)).toBe(false);
    expect(guard.isCurrent(second)).toBe(true);
  });

  it("keeps an independent action lease valid while refresh work advances", () => {
    const refreshGuard = new GraphSnapshotOwnership(owner());
    const actionGuard = new GraphSnapshotOwnership(owner());
    const action = actionGuard.begin();

    refreshGuard.begin();
    refreshGuard.begin();

    expect(actionGuard.isCurrent(action)).toBe(true);
  });

  it("invalidates an action when refresh commits a different run", () => {
    const refreshGuard = new GraphSnapshotOwnership(owner({ runId: "run-old" }));
    const actionGuard = new GraphSnapshotOwnership(owner({ runId: "run-old" }));
    const action = actionGuard.begin();
    const refresh = refreshGuard.begin();

    const committed = refreshGuard.claimRun(refresh, "run-new");
    expect(committed).not.toBeNull();

    actionGuard.update(owner({ runId: "run-new" }));
    expect(actionGuard.isCurrent(action)).toBe(false);
  });

  it("invalidates an older action before its response can trigger refresh or banner writes", () => {
    const actionGuard = new GraphSnapshotOwnership(owner());
    const firstAction = actionGuard.begin();
    let oldActionTriggeredRefresh = false;
    let oldActionWroteBanner = false;

    const secondAction = actionGuard.begin();
    if (actionGuard.isCurrent(firstAction)) {
      oldActionTriggeredRefresh = true;
      oldActionWroteBanner = true;
    }

    expect(oldActionTriggeredRefresh).toBe(false);
    expect(oldActionWroteBanner).toBe(false);
    expect(actionGuard.isCurrent(secondAction)).toBe(true);
  });

  it("keeps a newer action cleanup owner-only when an older action settles late", () => {
    const actionGuard = new GraphSnapshotOwnership(owner());
    const firstAction = actionGuard.begin();
    const secondAction = actionGuard.begin();
    let oldActionClearedBusy = false;
    let currentActionClearedBusy = false;

    if (actionGuard.isCurrent(firstAction)) oldActionClearedBusy = true;
    if (actionGuard.isCurrent(secondAction)) currentActionClearedBusy = true;

    expect(oldActionClearedBusy).toBe(false);
    expect(currentActionClearedBusy).toBe(true);
  });

  it("keeps the current request valid and permits its authoritative run selection", () => {
    const guard = new GraphSnapshotOwnership(owner({ runId: "" }));
    const request = guard.begin();

    const committed = guard.claimRun(request, "run-new");

    expect(committed).not.toBeNull();
    expect(guard.isCurrent(committed!)).toBe(true);
    expect(guard.claimRun(request, "run-other")).toBeNull();
  });

  it("uses the latest owner when an old callback starts after a render update", () => {
    const guard = new GraphSnapshotOwnership(owner({ sessionId: "session-a" }));
    const oldCallback = () => guard.begin();

    guard.update(owner({ sessionId: "session-b", runId: "run-b" }));

    const request = oldCallback();
    expect(request.owner.sessionId).toBe("session-b");
    expect(request.owner.runId).toBe("run-b");
  });

  it("rejects an old action lease after a render owner update", () => {
    const guard = new GraphSnapshotOwnership(owner({ sessionId: "session-a" }));
    const oldOwnerKey = JSON.stringify(owner({ sessionId: "session-a" }));

    guard.update(owner({ sessionId: "session-b", runId: "run-b" }));

    expect(guard.isOwnerKeyCurrent(oldOwnerKey)).toBe(false);
  });

  it("rejects owner-tagged modal, banner, and busy state after an owner switch", () => {
    const oldOwnerKey = graphSnapshotOwnerKey(owner({ runId: "run-old" }));
    const newOwnerKey = graphSnapshotOwnerKey(owner({ runId: "run-new" }));
    const oldModal = graphOwned(oldOwnerKey, { op: "edge_reassign" });
    const oldBanner = graphOwned(oldOwnerKey, "旧 run 错误");
    const oldBusy = graphOwned(oldOwnerKey, true);

    expect(isGraphOwned(oldModal, newOwnerKey)).toBe(false);
    expect(isGraphOwned(oldBanner, newOwnerKey)).toBe(false);
    expect(isGraphOwned(oldBusy, newOwnerKey)).toBe(false);
  });

  it("requires exact empty group ownership in the snapshot response", () => {
    const requestOwner = owner({ groupId: "" });

    expect(
      graphSnapshotMatchesOwner(
        requestOwner,
        { run_id: "run-a", session_id: "session-a", group_id: "" },
        "run-a",
      ),
    ).toBe(true);
    expect(
      graphSnapshotMatchesOwner(
        requestOwner,
        { run_id: "run-a", session_id: "session-a", group_id: "group-a" },
        "run-a",
      ),
    ).toBe(false);
  });

  it("rejects writes after unmount", () => {
    const guard = new GraphSnapshotOwnership(owner());
    const request = guard.begin();

    guard.dispose();

    expect(guard.isCurrent(request)).toBe(false);
    expect(guard.claimRun(request, "run-next")).toBeNull();
  });

  it("can reactivate after a development-only effect probe", () => {
    const guard = new GraphSnapshotOwnership(owner());
    const firstRequest = guard.begin();

    guard.dispose();
    guard.activate();

    expect(guard.isCurrent(firstRequest)).toBe(false);
    expect(guard.isCurrent(guard.begin())).toBe(true);
  });
});
