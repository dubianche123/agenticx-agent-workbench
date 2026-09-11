import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Share2, X, RefreshCw } from "lucide-react";
import type { ChatPane } from "../../store";
import { useAppStore } from "../../store";
import {
  crewPhaseToGraphStatus,
  groupDisplayAgentId,
  resolveCrewSlots,
  type CrewPhase,
} from "../../utils/group-member-activity";
import { GraphInterveneDock } from "./GraphInterveneDock";
import {
  buildInterveneBody,
  EMPTY_PANE_GRAPH_STATE,
  graphHasTaskNodes,
  selectGraphStateForOwner,
  type GraphNodeSnapshot,
  type GraphProjection,
  type InterveneRequest,
  type PaneGraphState,
} from "./graph-types";
import { agentIdFromNode, deriveRunningToolByAgent } from "./span-derive";
import {
  fetchGraphRun,
  listGraphRunsForSession,
  postGraphIntervene,
  useGraphRunStore,
} from "./useGraphRun";
import {
  GraphSnapshotOwnership,
  graphOwned,
  graphRefreshMatchesLiveRun,
  graphSnapshotMatchesOwner,
  graphSnapshotOwnerKey,
  isGraphOwned,
  type GraphOwned,
  type GraphSnapshotOwner,
} from "./graph-snapshot-ownership";

const RunGraphCanvas = lazy(() =>
  import("./RunGraphCanvas").then((m) => ({ default: m.RunGraphCanvas })),
);

type Props = {
  pane: ChatPane;
  onClose: () => void;
  tintColor?: string | null;
  /** WorkPanel tab: hide duplicate title/close; tab bar owns chrome. */
  embedded?: boolean;
  groupAvatarIds?: string[];
  groupHostAvatarId?: string;
  groupActiveAgentIds?: string[];
  groupActivityHint?: Record<string, string>;
  groupMemberPhase?: Record<string, "waiting" | "failed">;
};

function overlayNodeStatus(
  node: GraphNodeSnapshot,
  phaseByAgent: Map<string, CrewPhase>,
  hostAvatarId: string,
): GraphNodeSnapshot {
  const aid = groupDisplayAgentId(
    String(node.agent_id || agentIdFromNode(node.id) || "").trim(),
    hostAvatarId,
  );
  if (!aid) return node;
  const phase = phaseByAgent.get(aid);
  const mapped = crewPhaseToGraphStatus(phase ?? "idle");
  if (!mapped) return node;
  return { ...node, status: mapped };
}

function overlayCrewPhaseOnState(
  state: PaneGraphState,
  phaseByAgent: Map<string, CrewPhase>,
  hostAvatarId: string,
): PaneGraphState {
  if (phaseByAgent.size === 0) return state;
  const nodes: Record<string, GraphNodeSnapshot> = {};
  for (const [id, node] of Object.entries(state.nodes)) {
    nodes[id] = overlayNodeStatus(node, phaseByAgent, hostAvatarId);
  }
  let projection: GraphProjection | null = state.projection;
  if (projection) {
    projection = {
      ...projection,
      agent_nodes: projection.agent_nodes.map((n) =>
        overlayNodeStatus(n, phaseByAgent, hostAvatarId)
      ),
    };
  }
  return { ...state, nodes, projection };
}

export function RunGraphPanel({
  pane,
  onClose,
  tintColor,
  embedded = false,
  groupAvatarIds = [],
  groupHostAvatarId = "",
  groupActiveAgentIds = [],
  groupActivityHint = {},
  groupMemberPhase = {},
}: Props) {
  const apiBase = useAppStore((s) => s.apiBase);
  const apiToken = useAppStore((s) => s.apiToken);
  const avatars = useAppStore((s) => s.avatars);
  // Must use a stable empty object — `?? emptyPaneGraphState()` allocates every
  // snapshot and trips React useSyncExternalStore into an infinite update loop.
  const graphStateFromStore = useGraphRunStore(
    (s) => s.byPane[pane.id] ?? EMPTY_PANE_GRAPH_STATE,
  );
  const applySnapshot = useGraphRunStore((s) => s.applySnapshot);
  const setSelected = useGraphRunStore((s) => s.setSelected);
  const [busy, setBusy] = useState(false);
  const [busyOwnerKey, setBusyOwnerKey] = useState<string | null>(null);
  const [preferAgentView, setPreferAgentView] = useState(true);
  const [forceBody, setForceBody] = useState<GraphOwned<InterveneRequest> | null>(null);
  const [banner, setBanner] = useState<GraphOwned<string> | null>(null);
  const groupId = useMemo(() => {
    const avatarId = String(pane.avatarId || "").trim();
    return avatarId.startsWith("group:") ? avatarId.slice("group:".length).trim() : "";
  }, [pane.avatarId]);

  const avatarNames = useMemo(
    () =>
      Object.fromEntries(
        avatars
          .map((avatar) => [String(avatar.id || "").trim(), String(avatar.name || "").trim()] as const)
          .filter(([id, name]) => Boolean(id && name)),
      ),
    [avatars],
  );

  const graphOwner = useMemo(
    () => ({
      sessionId: String(pane.sessionId || "").trim(),
      groupId,
    }),
    [groupId, pane.sessionId],
  );
  const graphSelection = useMemo(
    () => selectGraphStateForOwner(graphStateFromStore, graphOwner, pane.activeGraphRunId),
    [graphOwner, graphStateFromStore, pane.activeGraphRunId],
  );
  const graphState = graphSelection.state;
  const runId = graphSelection.runId;

  const snapshotOwner: GraphSnapshotOwner = {
    paneId: pane.id,
    sessionId: String(pane.sessionId || "").trim(),
    groupId,
    apiBase,
    apiToken,
    runId: String(runId || "").trim(),
  };
  const snapshotOwnerKey = graphSnapshotOwnerKey(snapshotOwner);
  const currentOwnerKeyRef = useRef(snapshotOwnerKey);
  currentOwnerKeyRef.current = snapshotOwnerKey;
  const previousUiOwnerKeyRef = useRef(snapshotOwnerKey);
  const snapshotOwnershipRef = useRef<GraphSnapshotOwnership | null>(null);
  const actionOwnershipRef = useRef<GraphSnapshotOwnership | null>(null);
  if (!snapshotOwnershipRef.current) {
    snapshotOwnershipRef.current = new GraphSnapshotOwnership(snapshotOwner);
    actionOwnershipRef.current = new GraphSnapshotOwnership(snapshotOwner);
  } else {
    // Keep the owner in sync during render so a response resolving between
    // render and effects cannot write into the newly selected pane/session.
    snapshotOwnershipRef.current.update(snapshotOwner);
    actionOwnershipRef.current!.update(snapshotOwner);
  }
  const snapshotOwnership = snapshotOwnershipRef.current;
  const actionOwnership = actionOwnershipRef.current!;
  const setOwnedBanner = useCallback((message: string | null, ownerKey: string) => {
    setBanner(message === null ? null : graphOwned(ownerKey, message));
  }, []);

  const setActiveGraphRunId = useCallback(
    (paneId: string, rid: string | null) => {
      useAppStore.setState((s) => ({
        panes: s.panes.map((row) =>
          row.id === paneId ? { ...row, activeGraphRunId: rid } : row,
        ),
      }));
    },
    [],
  );

  const refresh = useCallback(async () => {
    const request = snapshotOwnership.begin();
    const {
      paneId,
      sessionId,
      groupId: requestGroupId,
      apiBase: requestApiBase,
      apiToken: requestApiToken,
      runId: requestRunId,
    } = request.owner;
    if (!requestApiBase || !requestApiToken || !sessionId) return;
    try {
      const runs = await listGraphRunsForSession(
        requestApiBase,
        requestApiToken,
        sessionId,
        requestGroupId,
      );
      if (!snapshotOwnership.isCurrent(request)) return;
      const authorizedIds = new Set(runs.map((row) => row.run_id));
      const rid = requestRunId && authorizedIds.has(requestRunId)
        ? requestRunId
        : runs[0]?.run_id || null;
      const currentPane = useAppStore.getState().panes.find((row) => row.id === paneId);
      if (!currentPane || String(currentPane.sessionId || "").trim() !== sessionId) return;
      const liveActiveRunId = String(currentPane.activeGraphRunId || "").trim();
      const liveGraphRunId = String(
        useGraphRunStore.getState().getPane(paneId).runId || "",
      ).trim();
      if (!graphRefreshMatchesLiveRun(requestRunId, rid, liveActiveRunId, liveGraphRunId)) {
        return;
      }
      if (!rid) {
        if (!snapshotOwnership.isCurrent(request)) return;
        actionOwnership.update({ ...request.owner, runId: "" });
        useGraphRunStore.getState().resetPane(paneId);
        setOwnedBanner(null, graphSnapshotOwnerKey(request.owner));
        return;
      }
      const { run, projection } = await fetchGraphRun(
        requestApiBase,
        requestApiToken,
        rid,
        sessionId,
        requestGroupId,
      );
      if (!snapshotOwnership.isCurrent(request)) return;
      if (!graphSnapshotMatchesOwner(request.owner, run, rid)) return;
      const livePaneAfterFetch = useAppStore.getState().panes.find((row) => row.id === paneId);
      if (
        !livePaneAfterFetch ||
        String(livePaneAfterFetch.sessionId || "").trim() !== sessionId
      ) {
        return;
      }
      const liveActiveRunIdAfterFetch = String(
        livePaneAfterFetch.activeGraphRunId || "",
      ).trim();
      const liveGraphRunIdAfterFetch = String(
        useGraphRunStore.getState().getPane(paneId).runId || "",
      ).trim();
      if (
        !graphRefreshMatchesLiveRun(
          requestRunId,
          rid,
          liveActiveRunIdAfterFetch,
          liveGraphRunIdAfterFetch,
        )
      ) {
        return;
      }
      const committedRequest = snapshotOwnership.claimRun(request, rid);
      if (!committedRequest) return;
      // A refresh may discover that the selected run was replaced. Keep the
      // action lease's owner in lockstep before any store/UI write so an
      // in-flight intervention for the old run cannot settle into the new
      // panel between this commit and the next React render. Same-run
      // refreshes leave the independent action lease untouched.
      actionOwnership.update({ ...request.owner, runId: rid });
      if (String(livePaneAfterFetch.activeGraphRunId || "").trim() !== rid) {
        setActiveGraphRunId(paneId, rid);
      }
      applySnapshot(paneId, run, projection, { allowRunSwitch: true });
      if (snapshotOwnership.isCurrent(committedRequest)) {
        setOwnedBanner(null, graphSnapshotOwnerKey(committedRequest.owner));
      }
    } catch (err) {
      if (!snapshotOwnership.isCurrent(request)) return;
      setOwnedBanner(
        err instanceof Error ? err.message : "加载运行图失败",
        graphSnapshotOwnerKey(request.owner),
      );
    }
  }, [
    applySnapshot,
    actionOwnership,
    setActiveGraphRunId,
    setOwnedBanner,
    snapshotOwnership,
    snapshotOwnerKey,
  ]);

  useEffect(() => {
    snapshotOwnership.activate();
    actionOwnership.activate();
    return () => {
      snapshotOwnership.dispose();
      actionOwnership.dispose();
    };
  }, [actionOwnership, snapshotOwnership]);

  useEffect(() => {
    void refresh();
    const t = window.setInterval(() => void refresh(), 4000);
    return () => window.clearInterval(t);
  }, [refresh]);

  useLayoutEffect(() => {
    const previousOwnerKey = previousUiOwnerKeyRef.current;
    previousUiOwnerKeyRef.current = snapshotOwnerKey;
    if (previousOwnerKey === snapshotOwnerKey) return;
    // Render-time owner tags hide stale UI immediately; this layout cleanup
    // physically clears it before the new owner can paint or submit.
    setBusy(false);
    setBusyOwnerKey(null);
    setForceBody(null);
    setBanner(null);
  }, [snapshotOwnerKey]);

  const selectedNodes: GraphNodeSnapshot[] = useMemo(() => {
    const ids = graphState.selectedNodeIds;
    const fromTasks = ids.map((id) => graphState.nodes[id]).filter(Boolean) as GraphNodeSnapshot[];
    const fromAgents = (graphState.projection?.agent_nodes || []).filter((n) => ids.includes(n.id));
    const map = new Map<string, GraphNodeSnapshot>();
    for (const n of [...fromTasks, ...fromAgents]) map.set(n.id, n);
    return [...map.values()];
  }, [graphState.nodes, graphState.projection, graphState.selectedNodeIds]);

  const intervene = useCallback(
    async (body: InterveneRequest): Promise<{ ok: boolean; warnings: string[] }> => {
      if (!actionOwnership.isOwnerKeyCurrent(snapshotOwnerKey)) {
        return { ok: false, warnings: [] };
      }
      const request = actionOwnership.begin();
      const {
        sessionId,
        groupId: requestGroupId,
        apiBase: requestApiBase,
        apiToken: requestApiToken,
        runId: requestRunId,
      } = request.owner;
      if (
        !requestApiBase ||
        !requestApiToken ||
        !requestRunId ||
        !sessionId ||
        graphSnapshotOwnerKey(request.owner) !== snapshotOwnerKey ||
        !actionOwnership.isCurrent(request)
      ) {
        return { ok: false, warnings: [] };
      }
      setBusy(true);
      setBusyOwnerKey(graphSnapshotOwnerKey(request.owner));
      try {
        const res = await postGraphIntervene(
          requestApiBase,
          requestApiToken,
          requestRunId,
          body,
          sessionId,
          requestGroupId,
        );
        if (!actionOwnership.isCurrent(request)) {
          return { ok: false, warnings: [] };
        }
        if (res.status === 409) {
          await refresh();
          if (!actionOwnership.isCurrent(request)) {
            return { ok: false, warnings: ["version_conflict"] };
          }
          setOwnedBanner(
            "版本冲突，已刷新图状态，请重试",
            graphSnapshotOwnerKey(request.owner),
          );
          return { ok: false, warnings: ["version_conflict"] };
        }
        if (!res.ok) {
          setOwnedBanner(res.error || "干预失败", graphSnapshotOwnerKey(request.owner));
          return { ok: false, warnings: [] };
        }
        if (!res.warnings.includes("target_running")) {
          if (!actionOwnership.isCurrent(request)) {
            return { ok: false, warnings: [] };
          }
          await refresh();
        }
        return { ok: res.ok, warnings: res.warnings };
      } finally {
        if (actionOwnership.isCurrent(request)) {
          setBusy(false);
          setBusyOwnerKey(null);
        }
      }
    },
    [actionOwnership, refresh, setOwnedBanner, snapshotOwnerKey],
  );

  const runningToolByAgent = useMemo(
    () => deriveRunningToolByAgent(graphState.toolStepsByNode),
    [graphState.toolStepsByNode],
  );
  const crewPhaseByAgent = useMemo(() => {
    const slots = resolveCrewSlots({
      avatarIds: groupAvatarIds,
      hostAvatarId: groupHostAvatarId,
      messages: pane.messages ?? [],
      activeAgentIds: groupActiveAgentIds,
      activityHintById: groupActivityHint,
      runningToolByAgent,
      phaseOverrideById: groupMemberPhase,
    });
    const map = new Map<string, CrewPhase>();
    for (const slot of slots) map.set(slot.agentId, slot.phase);
    return map;
  }, [
    groupAvatarIds,
    groupActiveAgentIds,
    groupActivityHint,
    groupHostAvatarId,
    groupMemberPhase,
    pane.messages,
    runningToolByAgent,
  ]);
  const displayState = useMemo(
    () => overlayCrewPhaseOnState(graphState, crewPhaseByAgent, groupHostAvatarId),
    [graphState, crewPhaseByAgent, groupHostAvatarId],
  );

  const hasRun = Boolean(runId && (Object.keys(graphState.nodes).length > 0 || graphState.projection));
  // Presence / H2A·A2A social graphs are already expert nodes — hide the
  // 专家/任务 toggle until a real Workforce task DAG exists.
  const hasTaskNodes = useMemo(
    () => graphHasTaskNodes(graphState.nodes),
    [graphState.nodes],
  );
  // No tasks → show raw presence nodes (includes「你」); with tasks → honor toggle.
  const effectivePreferAgentView = hasTaskNodes ? preferAgentView : false;

  return (
    <div
      className="relative flex h-full min-h-0 w-full flex-col bg-surface-base"
      style={tintColor ? { backgroundColor: tintColor } : undefined}
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-2.5 py-2">
        {!embedded ? (
          <>
            <Share2 className="h-4 w-4 shrink-0 text-text-subtle" strokeWidth={1.8} />
            <span className="text-[14px] font-medium text-text-strong">运行图</span>
          </>
        ) : null}
        {hasTaskNodes ? (
          <div
            className={`inline-flex items-center gap-0.5 rounded-lg border border-border bg-surface-base p-0.5 ${
              embedded ? "" : "ml-1"
            }`}
          >
            <button
              type="button"
              className={`rounded-md px-2.5 py-1 text-[13px] font-medium transition ${
                preferAgentView
                  ? "bg-[var(--ui-btn-primary-bg)] text-white shadow-sm"
                  : "text-text-subtle hover:bg-surface-hover hover:text-text-strong"
              }`}
              onClick={() => setPreferAgentView(true)}
              aria-pressed={preferAgentView}
            >
              专家
            </button>
            <button
              type="button"
              className={`rounded-md px-2.5 py-1 text-[13px] font-medium transition ${
                !preferAgentView
                  ? "bg-[var(--ui-btn-primary-bg)] text-white shadow-sm"
                  : "text-text-subtle hover:bg-surface-hover hover:text-text-strong"
              }`}
              onClick={() => setPreferAgentView(false)}
              aria-pressed={!preferAgentView}
            >
              任务
            </button>
          </div>
        ) : null}
        <button
          type="button"
          className={`rounded-md p-1.5 text-text-subtle hover:bg-surface-hover hover:text-text-strong ${
            !hasTaskNodes && !embedded ? "ml-1" : ""
          }`}
          onClick={() => void refresh()}
          title="刷新"
          aria-label="刷新运行图"
        >
          <RefreshCw className="h-4 w-4" strokeWidth={2} />
        </button>
        {!embedded ? (
          <button
            type="button"
            className="ml-auto rounded p-1 text-text-faint hover:bg-surface-hover hover:text-text-strong"
            onClick={onClose}
            title="关闭运行图"
            aria-label="关闭运行图"
          >
            <X className="h-4 w-4" />
          </button>
        ) : (
          <div className="ml-auto" />
        )}
      </div>

      {isGraphOwned(banner, snapshotOwnerKey) ? (
        <div className="shrink-0 border-b border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-700 dark:text-amber-200">
          {banner.value}
        </div>
      ) : null}

      {hasRun && !hasTaskNodes ? (
        <div className="shrink-0 border-b border-border px-2.5 py-1 text-[10px] leading-snug text-text-faint">
          本轮只有「谁在答」的协作关系；出现可拆解的任务时，这里会显示任务分工与依赖，并支持注入 / 改派。
        </div>
      ) : null}

      {!hasRun ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
          <Share2 className="h-8 w-8 text-text-faint" strokeWidth={1.4} />
          <p className="text-[13px] text-text-subtle">暂无运行图</p>
          <p className="text-[11px] leading-relaxed text-text-faint">
            发送复杂任务或群聊协作后会自动生成。可在此观察专家思考、执行与协同，并做注入 / 改派 / 收敛干预。
          </p>
        </div>
      ) : (
        <>
          <div className="min-h-0 flex-1">
            <Suspense
              fallback={
                <div className="flex h-full items-center justify-center text-[12px] text-text-faint">
                  加载画布…
                </div>
              }
            >
              <RunGraphCanvas
                state={displayState}
                preferAgentView={effectivePreferAgentView}
                onSelectIds={(ids) => setSelected(pane.id, ids)}
                onIntervene={intervene}
                onRequestForceReassign={(body) => {
                  if (currentOwnerKeyRef.current !== snapshotOwnerKey) return;
                  setForceBody(graphOwned(snapshotOwnerKey, body));
                }}
              />
            </Suspense>
          </div>
          <GraphInterveneDock
            version={graphState.version}
            selectedNodes={selectedNodes}
            taskNodes={Object.values(graphState.nodes)}
            avatarNames={avatarNames}
            runStatus={graphState.status}
            busy={busy && busyOwnerKey === snapshotOwnerKey}
            onIntervene={async (body) => {
              await intervene(body);
            }}
            onPauseRun={async () => {
              await intervene(buildInterveneBody("pause", graphState.version, { payload: { scope: "run" } }));
            }}
            onResumeRun={async () => {
              await intervene(buildInterveneBody("resume", graphState.version, { payload: { scope: "run" } }));
            }}
          />
        </>
      )}

      {isGraphOwned(forceBody, snapshotOwnerKey) ? (
        <div className="absolute inset-0 z-[70] flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-sm rounded-lg border border-border bg-surface-card p-4 shadow-xl">
            <p className="text-[13px] font-medium text-text-strong">中断并改派？</p>
            <p className="mt-1 text-[12px] text-text-subtle">
              目标节点正在运行。确认后将中断当前执行并改派给新专家。
            </p>
            <div className="mt-3 flex justify-end gap-2">
              <button
                type="button"
                className="rounded px-3 py-1.5 text-[12px] text-text-subtle hover:bg-surface-hover"
                onClick={() => {
                  const current = currentOwnerKeyRef.current;
                  if (current !== snapshotOwnerKey || !isGraphOwned(forceBody, current)) return;
                  setForceBody(null);
                }}
              >
                取消
              </button>
              <button
                type="button"
                className="rounded px-3 py-1.5 text-[12px] text-white"
                style={{ background: "var(--ui-btn-primary-bg)" }}
                onClick={() => {
                  const current = currentOwnerKeyRef.current;
                  if (current !== snapshotOwnerKey || !isGraphOwned(forceBody, current)) return;
                  const body = forceBody.value;
                  setForceBody(null);
                  void intervene(body);
                }}
              >
                确认改派
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
