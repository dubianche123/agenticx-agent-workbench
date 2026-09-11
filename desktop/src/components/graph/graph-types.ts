/** Types + pure helpers for Run Graph God-View (SP2 API contract). */

export type GraphNodeStatus =
  | "pending"
  | "ready"
  | "running"
  | "blocked"
  | "paused"
  | "done"
  | "failed"
  | "cancelled"
  | "skipped";

export type GraphEdgeKind = "depends" | "message" | "artifact" | string;

export type GraphNodeSnapshot = {
  id: string;
  kind: string;
  label: string;
  status: GraphNodeStatus | string;
  agent_id?: string | null;
  task_text?: string;
  directives?: string[];
  view_role?: "task" | "agent";
  task_ids?: string[];
  meta?: Record<string, unknown>;
};

export type GraphEdgeSnapshot = {
  id: string;
  kind: GraphEdgeKind;
  source: string;
  target: string;
  label?: string;
  meta?: Record<string, unknown>;
};

export type GraphProjection = {
  agent_nodes: GraphNodeSnapshot[];
  agent_edges: GraphEdgeSnapshot[];
};

export type ToolStep = {
  callId: string;
  toolName: string;
  phase: "calling" | "done";
  /** epoch ms of first observation */
  startedAt: number;
  updatedAt: number;
};

export type GraphRunSnapshot = {
  run_id: string;
  session_id: string;
  group_id?: string | null;
  status: string;
  version: number;
  nodes: Record<string, GraphNodeSnapshot>;
  edges: GraphEdgeSnapshot[];
  meta?: Record<string, unknown>;
};

export type GraphSsePayload = {
  type: string;
  run_id?: string;
  version?: number;
  status?: string;
  node?: GraphNodeSnapshot;
  edge?: GraphEdgeSnapshot;
  edge_id?: string;
  intensity?: number;
  summary?: string;
  node_ids?: string[];
  [key: string]: unknown;
};

export type InterveneOp =
  | "node_inject"
  | "node_retract"
  | "edge_reassign"
  | "selection_rule"
  | "pause"
  | "resume"
  | "cancel_node";

export type InterveneRequest = {
  op: InterveneOp;
  version: number;
  node_ids?: string[];
  edge_ids?: string[];
  payload?: Record<string, unknown>;
};

/** Session/group scope that owns a pane's graph state. */
export type GraphStateOwner = {
  sessionId: string;
  groupId: string;
};

/** Optional scope proof supplied by the stream that admitted a graph event. */
export type GraphEventApplyOptions = {
  trustedOwner?: GraphStateOwner | null;
};

export type PaneGraphState = {
  runId: string | null;
  /** Backend scope of the run currently stored in this pane. */
  owner?: GraphStateOwner | null;
  version: number;
  status: string;
  nodes: Record<string, GraphNodeSnapshot>;
  edges: GraphEdgeSnapshot[];
  projection: GraphProjection | null;
  /** edge ids that recently pulsed (for short dash animation) */
  pulseEdges: Record<string, number>;
  selectedNodeIds: string[];
  lastError: string | null;
  /** Live tool steps keyed by graph node id (e.g. agent:<avatar_id>). */
  toolStepsByNode: Record<string, ToolStep[]>;
};

export type GraphSnapshotApplyOptions = {
  /** Permit a deliberate new-run transition selected by the current panel lease. */
  allowRunSwitch?: boolean;
};

export function emptyPaneGraphState(): PaneGraphState {
  return {
    runId: null,
    owner: null,
    version: 0,
    status: "",
    nodes: {},
    edges: [],
    projection: null,
    pulseEdges: {},
    selectedNodeIds: [],
    lastError: null,
    toolStepsByNode: {},
  };
}

function normalizeGraphStateOwner(owner: GraphStateOwner | null | undefined): GraphStateOwner | null {
  if (!owner) return null;
  return {
    sessionId: String(owner.sessionId || "").trim(),
    groupId: String(owner.groupId || "").trim(),
  };
}

/** Exact scope check used by the panel before rendering pane-keyed state. */
export function graphStateMatchesOwner(
  state: PaneGraphState | null | undefined,
  owner: GraphStateOwner,
): boolean {
  const stateOwner = normalizeGraphStateOwner(state?.owner);
  const expected = normalizeGraphStateOwner(owner);
  return Boolean(
    stateOwner &&
      expected &&
      stateOwner.sessionId === expected.sessionId &&
      stateOwner.groupId === expected.groupId,
  );
}

/**
 * Select only graph state belonging to the currently displayed session/group.
 * A stale active run id is treated as part of the same ownership boundary so
 * the first render after an A→B navigation cannot paint A's graph or request A's
 * run before ChatPane's session-reset effect runs.
 */
export function selectGraphStateForOwner(
  state: PaneGraphState | null | undefined,
  owner: GraphStateOwner,
  activeRunId?: string | null,
): { state: PaneGraphState; runId: string; usable: boolean } {
  const candidate = state ?? EMPTY_PANE_GRAPH_STATE;
  const selectedRunId = String(activeRunId || "").trim();
  const storedRunId = String(candidate.runId || "").trim();
  if (!graphStateMatchesOwner(candidate, owner)) {
    return { state: EMPTY_PANE_GRAPH_STATE, runId: "", usable: false };
  }
  if (selectedRunId && storedRunId && selectedRunId !== storedRunId) {
    return { state: EMPTY_PANE_GRAPH_STATE, runId: "", usable: false };
  }
  return {
    state: candidate,
    runId: selectedRunId || storedRunId,
    usable: true,
  };
}

export function applyToolStepToState(
  state: PaneGraphState,
  nodeId: string,
  step: ToolStep,
): PaneGraphState {
  if (!nodeId || !step.callId) return state;
  const byNode = state.toolStepsByNode ?? {};
  const prev = byNode[nodeId] ?? [];
  const idx = prev.findIndex((s) => s.callId === step.callId);
  const next =
    idx >= 0
      ? prev.map((s, i) =>
          i === idx
            ? {
                ...s,
                phase: step.phase,
                toolName: step.toolName || s.toolName,
                updatedAt: step.updatedAt,
              }
            : s,
        )
      : [...prev, step];
  return { ...state, toolStepsByNode: { ...byNode, [nodeId]: next } };
}

/**
 * Stable empty snapshot for zustand selectors.
 * Never allocate a new object inside `useStore(s => ... ?? …)` — that breaks
 * useSyncExternalStore and causes "Maximum update depth exceeded".
 * Do not mutate this object; copy before writing.
 */
export const EMPTY_PANE_GRAPH_STATE: PaneGraphState = emptyPaneGraphState();

/** True when the run contains Workforce task nodes (not presence-only agent/human). */
export function graphHasTaskNodes(
  nodes: Record<string, GraphNodeSnapshot> | GraphNodeSnapshot[] | null | undefined,
): boolean {
  const list = Array.isArray(nodes) ? nodes : Object.values(nodes || {});
  return list.some((n) => String(n?.kind || "").toLowerCase() === "task");
}

/** Heuristic: retract vs inject from dock free text. */
export function classifyDirectiveText(text: string): "node_retract" | "node_inject" {
  const t = text.trim();
  if (/不用做|取消|别做|跳过/.test(t)) return "node_retract";
  return "node_inject";
}

export function buildInterveneBody(
  op: InterveneOp,
  version: number,
  opts: {
    nodeIds?: string[];
    edgeIds?: string[];
    payload?: Record<string, unknown>;
  } = {},
): InterveneRequest {
  return {
    op,
    version,
    node_ids: opts.nodeIds ?? [],
    edge_ids: opts.edgeIds ?? [],
    payload: opts.payload ?? {},
  };
}

function graphStateOwnerFromPayload(payload: GraphSsePayload): GraphStateOwner | null {
  const hasSessionId = Object.prototype.hasOwnProperty.call(payload, "session_id");
  const hasGroupId = Object.prototype.hasOwnProperty.call(payload, "group_id");
  if (!hasSessionId && !hasGroupId) return null;
  return {
    sessionId: String(payload.session_id || "").trim(),
    groupId: String(payload.group_id || "").trim(),
  };
}

/**
 * Fill missing graph scope from a trusted foreground stream owner.
 *
 * Bridge/replay events predating the scope fields are still valid when the
 * stream has already been admitted for the current session/group. Preserve
 * any non-empty scope carried by the event, though: an explicit mismatch must
 * remain visible to the reducer and never be silently rewritten into the
 * current pane's scope.
 */
export function withGraphOwner(
  payload: GraphSsePayload,
  owner: GraphStateOwner,
): GraphSsePayload {
  const expected = normalizeGraphStateOwner(owner) ?? { sessionId: "", groupId: "" };
  const sessionId = String(payload.session_id ?? "").trim();
  const groupId = String(payload.group_id ?? "").trim();
  return {
    ...payload,
    session_id: sessionId || expected.sessionId,
    group_id: groupId || expected.groupId,
  };
}

function graphStateOwnersEqual(
  left: GraphStateOwner | null | undefined,
  right: GraphStateOwner | null | undefined,
): boolean {
  const a = normalizeGraphStateOwner(left);
  const b = normalizeGraphStateOwner(right);
  return Boolean(a && b && a.sessionId === b.sessionId && a.groupId === b.groupId);
}

export function applyGraphEvent(
  state: PaneGraphState,
  payload: GraphSsePayload,
  options: GraphEventApplyOptions = {},
): PaneGraphState {
  const trustedOwner = options.trustedOwner
    ? normalizeGraphStateOwner(options.trustedOwner)
    : null;
  const scopedPayload = trustedOwner ? withGraphOwner(payload, trustedOwner) : payload;
  const type = String(scopedPayload.type || "");
  if (!type.startsWith("graph.")) return state;

  const currentRunId = String(state.runId || "").trim();
  const incomingRunId =
    typeof scopedPayload.run_id === "string" ? scopedPayload.run_id.trim() : "";
  const incomingOwner = graphStateOwnerFromPayload(scopedPayload);
  if (trustedOwner && incomingOwner && !graphStateOwnersEqual(incomingOwner, trustedOwner)) {
    return state;
  }
  const isNewRunCreated =
    type === "graph.run_created" &&
    Boolean(incomingRunId) &&
    incomingRunId !== currentRunId;
  if (
    incomingOwner &&
    state.owner &&
    !graphStateOwnersEqual(state.owner, incomingOwner) &&
    !isNewRunCreated
  ) {
    return state;
  }
  const incomingVersion =
    typeof scopedPayload.version === "number" && Number.isFinite(scopedPayload.version)
      ? scopedPayload.version
      : null;
  // A graph event from another run cannot mutate this pane. A run_created
  // event is the sole explicit transition point for a new run.
  if (
    currentRunId &&
    incomingRunId &&
    incomingRunId !== currentRunId &&
    type !== "graph.run_created"
  ) {
    return state;
  }
  // Multiple events may share one version (for example run_created followed
  // by the first node update), so reject only strictly older events.
  if (
    incomingVersion !== null &&
    currentRunId &&
    (!incomingRunId || incomingRunId === currentRunId) &&
    incomingVersion < state.version
  ) {
    return state;
  }

  const runChanged =
    type === "graph.run_created" &&
    Boolean(incomingRunId) &&
    incomingRunId !== currentRunId;
  let next: PaneGraphState = runChanged
    ? emptyPaneGraphState()
    : { ...state, lastError: null };
  if (incomingOwner) next = { ...next, owner: incomingOwner };
  const runId = incomingRunId || next.runId;
  if (runId) next = { ...next, runId };

  if (incomingVersion !== null) {
    next = { ...next, version: Math.max(next.version, incomingVersion) };
  }

  if (type === "graph.run_created") {
    return {
      ...next,
      status: "open",
      runId: runId || next.runId,
    };
  }

  if (type === "graph.run_status" && typeof scopedPayload.status === "string") {
    return { ...next, status: scopedPayload.status };
  }

  if (
    type === "graph.node_updated" &&
    scopedPayload.node &&
    typeof scopedPayload.node === "object"
  ) {
    const node = scopedPayload.node as GraphNodeSnapshot;
    const nodes = { ...next.nodes, [node.id]: { ...next.nodes[node.id], ...node } };
    return { ...next, nodes };
  }

  if (
    type === "graph.edge_updated" &&
    scopedPayload.edge &&
    typeof scopedPayload.edge === "object"
  ) {
    const edge = scopedPayload.edge as GraphEdgeSnapshot;
    const edges = next.edges.map((e) => (e.id === edge.id ? { ...e, ...edge } : e));
    if (!edges.some((e) => e.id === edge.id)) edges.push(edge);
    return { ...next, edges };
  }

  if (type === "graph.edge_removed") {
    const eid = String(
      scopedPayload.edge_id || (scopedPayload.edge as GraphEdgeSnapshot | undefined)?.id || "",
    ).trim();
    if (!eid) return next;
    return {
      ...next,
      edges: next.edges.filter((e) => e.id !== eid),
      projection: next.projection
        ? {
            ...next.projection,
            agent_edges: (next.projection.agent_edges || []).filter((e) => e.id !== eid),
          }
        : next.projection,
    };
  }

  if (type === "graph.edge_flow") {
    const eid = String(
      scopedPayload.edge_id ||
        (scopedPayload.edge as GraphEdgeSnapshot | undefined)?.id ||
        "",
    );
    if (!eid) return next;
    return {
      ...next,
      pulseEdges: { ...next.pulseEdges, [eid]: Date.now() },
    };
  }

  if (type === "graph.intervention_applied") {
    return next;
  }

  return next;
}

export function applyGraphSnapshot(
  state: PaneGraphState,
  run: GraphRunSnapshot,
  projection?: GraphProjection | null,
  options: GraphSnapshotApplyOptions = {},
): PaneGraphState {
  const incomingRunId = String(run.run_id || "").trim();
  const currentRunId = String(state.runId || "").trim();
  const incomingVersion = Number(run.version);
  const incomingOwner: GraphStateOwner = {
    sessionId: String(run.session_id || "").trim(),
    groupId: String(run.group_id || "").trim(),
  };
  if (!incomingRunId) return state;
  if (
    currentRunId &&
    currentRunId !== incomingRunId &&
    !options.allowRunSwitch
  ) {
    return state;
  }
  if (
    currentRunId === incomingRunId &&
    (!Number.isFinite(incomingVersion) || incomingVersion < state.version)
  ) {
    return state;
  }
  if (
    currentRunId === incomingRunId &&
    state.owner &&
    !graphStateOwnersEqual(state.owner, incomingOwner)
  ) {
    return state;
  }
  const nodesRaw = run.nodes || {};
  const nodes: Record<string, GraphNodeSnapshot> = {};
  for (const [id, n] of Object.entries(nodesRaw)) {
    nodes[id] = { ...n, id: n.id || id };
  }
  if (currentRunId === incomingRunId && incomingVersion === state.version) {
    // A run_created event can arrive before the first full snapshot, so an
    // equal-version snapshot still needs to fill an empty baseline. Once SSE
    // has contributed fields, preserve those fields over a late snapshot at
    // the same version; snapshots add missing nodes/edges/projection only.
    const mergedNodes: Record<string, GraphNodeSnapshot> = { ...nodes };
    for (const [id, current] of Object.entries(state.nodes)) {
      mergedNodes[id] = { ...mergedNodes[id], ...current };
    }
    const mergedEdges = [...state.edges];
    const knownEdgeIds = new Set(state.edges.map((edge) => edge.id));
    for (const edge of Array.isArray(run.edges) ? run.edges : []) {
      if (!knownEdgeIds.has(edge.id)) {
        mergedEdges.push(edge);
        knownEdgeIds.add(edge.id);
      }
    }
    let mergedProjection: GraphProjection | null = null;
    if (projection === null) {
      // An explicit null means this run has no projection; do not retain a
      // projection belonging to a prior snapshot.
      mergedProjection = null;
    } else if (projection === undefined) {
      mergedProjection = state.projection;
    } else if (!state.projection) {
      mergedProjection = projection;
    } else {
      const mergeById = <T extends { id: string }>(current: T[], incoming: T[]): T[] => {
        const result = [...current];
        const knownIds = new Set(current.map((item) => item.id));
        for (const item of incoming) {
          if (!knownIds.has(item.id)) {
            result.push(item);
            knownIds.add(item.id);
          }
        }
        return result;
      };
      mergedProjection = {
        agent_nodes: mergeById(state.projection.agent_nodes, projection.agent_nodes),
        agent_edges: mergeById(state.projection.agent_edges, projection.agent_edges),
      };
    }
    return {
      ...state,
      owner: state.owner ?? incomingOwner,
      status: state.status || String(run.status || ""),
      nodes: mergedNodes,
      edges: mergedEdges,
      projection: mergedProjection,
      lastError: null,
    };
  }
  const baseState =
    currentRunId !== incomingRunId
      ? emptyPaneGraphState()
      : state;
  return {
    ...baseState,
    runId: incomingRunId,
    owner: incomingOwner,
    version: Number.isFinite(incomingVersion) ? Math.max(0, incomingVersion) : 0,
    status: String(run.status || ""),
    nodes,
    edges: Array.isArray(run.edges) ? run.edges : [],
    projection: projection ?? null,
    lastError: null,
  };
}

/** Simple column layout: pending | ready | running | blocked | done-ish */
export function layoutGraphNodes(
  nodes: GraphNodeSnapshot[],
): Record<string, { x: number; y: number }> {
  const columns: Record<string, number> = {
    pending: 0,
    ready: 1,
    running: 2,
    blocked: 2,
    paused: 2,
    done: 3,
    failed: 3,
    cancelled: 3,
    skipped: 3,
  };
  const counters: Record<number, number> = {};
  const out: Record<string, { x: number; y: number }> = {};
  for (const n of nodes) {
    const col = columns[String(n.status)] ?? 0;
    const row = counters[col] ?? 0;
    counters[col] = row + 1;
    out[n.id] = { x: col * 220 + 24, y: row * 96 + 24 };
  }
  return out;
}

export const SELECTION_RULE_PRESETS = [
  { id: "fast", label: "快速出结论", text: "快速出结论，先收敛为一版可交付结论。" },
  { id: "draft", label: "先做一版", text: "先做一版，不必完美，优先可评审草稿。" },
  { id: "no-at", label: "停止互相 @", text: "停止互相 @，各自输出结论后由 Meta 汇总。" },
] as const;
