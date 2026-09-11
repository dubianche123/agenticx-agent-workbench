export type GraphSnapshotOwner = {
  paneId: string;
  sessionId: string;
  groupId: string;
  apiBase: string;
  apiToken: string;
  runId: string;
};

export type GraphSnapshotRequest = {
  generation: number;
  owner: GraphSnapshotOwner;
};

export type GraphSnapshotResponse = {
  run_id?: unknown;
  session_id?: unknown;
  group_id?: unknown;
};

/** UI state that must never outlive the pane/session/run that created it. */
export type GraphOwned<T> = {
  ownerKey: string;
  value: T;
};

export function graphOwned<T>(ownerKey: string, value: T): GraphOwned<T> {
  return { ownerKey, value };
}

export function isGraphOwned<T>(
  value: GraphOwned<T> | null | undefined,
  ownerKey: string,
): value is GraphOwned<T> {
  return value != null && value.ownerKey === ownerKey;
}

function normalizeOwner(owner: GraphSnapshotOwner): GraphSnapshotOwner {
  return {
    paneId: String(owner.paneId || "").trim(),
    sessionId: String(owner.sessionId || "").trim(),
    groupId: String(owner.groupId || "").trim(),
    apiBase: String(owner.apiBase || "").trim(),
    apiToken: String(owner.apiToken || "").trim(),
    runId: String(owner.runId || "").trim(),
  };
}

export function graphSnapshotOwnerKey(owner: GraphSnapshotOwner): string {
  return JSON.stringify(normalizeOwner(owner));
}

function sameOwner(a: GraphSnapshotOwner, b: GraphSnapshotOwner): boolean {
  return (
    a.paneId === b.paneId &&
    a.sessionId === b.sessionId &&
    a.groupId === b.groupId &&
    a.apiBase === b.apiBase &&
    a.apiToken === b.apiToken &&
    a.runId === b.runId
  );
}

export function graphSnapshotMatchesOwner(
  owner: GraphSnapshotOwner,
  response: GraphSnapshotResponse,
  expectedRunId: string,
): boolean {
  return (
    String(response.run_id || "").trim() === String(expectedRunId || "").trim() &&
    String(response.session_id || "").trim() === owner.sessionId &&
    String(response.group_id || "").trim() === owner.groupId
  );
}

/**
 * Reject a refresh response that no longer agrees with the live run selected
 * by the pane.  ``requestRunId`` is the run captured when refresh began;
 * ``selectedRunId`` is the candidate chosen from that refresh's list.  When a
 * refresh began with no run, a live ``run_created`` can win while the list or
 * snapshot request is in flight, so an older candidate must not be allowed to
 * replace that live run.  Empty live ids are tolerated because the stream may
 * not have observed a run yet; any observed id must match the request's
 * expected selection.
 */
export function graphRefreshMatchesLiveRun(
  requestRunId: unknown,
  selectedRunId: unknown,
  liveActiveRunId: unknown,
  liveGraphRunId: unknown,
): boolean {
  const request = String(requestRunId || "").trim();
  const selected = String(selectedRunId || "").trim();
  const expected = request || selected;
  const liveIds = [String(liveActiveRunId || "").trim(), String(liveGraphRunId || "").trim()]
    .filter(Boolean);
  if (liveIds.length === 0) return true;
  return Boolean(expected) && liveIds.every((runId) => runId === expected);
}

/**
 * Guards asynchronous graph reads against pane/session/run changes.
 *
 * A selected run can legitimately change after the list response tells us
 * that the previous run is gone. `claimRun` is that one authoritative
 * transition; any other owner change invalidates the request generation.
 */
export class GraphSnapshotOwnership {
  private generation = 0;
  private owner: GraphSnapshotOwner;
  private mounted = true;

  constructor(owner: GraphSnapshotOwner) {
    this.owner = normalizeOwner(owner);
  }

  update(owner: GraphSnapshotOwner): void {
    const next = normalizeOwner(owner);
    if (sameOwner(this.owner, next)) return;
    this.owner = next;
    this.generation += 1;
  }

  begin(): GraphSnapshotRequest {
    // Every read/action gets a fresh lease. This makes overlapping interval
    // and manual refreshes latest-wins even when the owner itself is stable.
    this.generation += 1;
    return {
      generation: this.generation,
      owner: { ...this.owner },
    };
  }

  isCurrent(request: GraphSnapshotRequest): boolean {
    return (
      this.mounted &&
      request.generation === this.generation &&
      sameOwner(request.owner, this.owner)
    );
  }

  isOwnerCurrent(owner: GraphSnapshotOwner): boolean {
    return this.mounted && sameOwner(normalizeOwner(owner), this.owner);
  }

  isOwnerKeyCurrent(ownerKey: string): boolean {
    return this.mounted && graphSnapshotOwnerKey(this.owner) === ownerKey;
  }

  /**
   * Claims the run selected by the current list/detail request and returns a
   * new request token that remains valid for the ensuing store write.
   */
  claimRun(
    request: GraphSnapshotRequest,
    runId: string,
  ): GraphSnapshotRequest | null {
    const nextRunId = String(runId || "").trim();
    if (!nextRunId || !this.isCurrent(request)) return null;
    this.owner = { ...this.owner, runId: nextRunId };
    return this.begin();
  }

  activate(): void {
    // React StrictMode intentionally runs effect cleanup/setup once on mount.
    // Re-activate after that probe while the generation still rejects the
    // request started by the probe's first effect.
    this.mounted = true;
  }

  dispose(): void {
    this.mounted = false;
    this.generation += 1;
  }
}
