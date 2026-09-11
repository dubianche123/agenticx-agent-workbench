import { describe, expect, it } from "vitest";
import {
  applyGraphEvent,
  applyGraphSnapshot,
  buildInterveneBody,
  classifyDirectiveText,
  emptyPaneGraphState,
  graphHasTaskNodes,
  layoutGraphNodes,
  selectGraphStateForOwner,
  withGraphOwner,
} from "./graph-types";

describe("graph-types", () => {
  it("graphHasTaskNodes is false for presence-only agent graphs", () => {
    expect(
      graphHasTaskNodes({
        human: { id: "human", kind: "human", label: "你", status: "ready" },
        "agent:a1": { id: "agent:a1", kind: "agent", label: "架构师·阿析", status: "ready" },
      }),
    ).toBe(false);
  });

  it("graphHasTaskNodes is true when workforce tasks exist", () => {
    expect(
      graphHasTaskNodes({
        t1: { id: "t1", kind: "task", label: "拆解", status: "ready" },
      }),
    ).toBe(true);
  });

  it("classifyDirectiveText detects retract phrases", () => {
    expect(classifyDirectiveText("这个不用做了")).toBe("node_retract");
    expect(classifyDirectiveText("请补充验收清单")).toBe("node_inject");
  });

  it("applyGraphEvent updates node status color path", () => {
    let s = emptyPaneGraphState();
    s = applyGraphEvent(s, {
      type: "graph.run_created",
      run_id: "gr_1",
      version: 1,
      session_id: "session-1",
      group_id: "group-1",
    });
    expect(s.runId).toBe("gr_1");
    expect(s.owner).toEqual({ sessionId: "session-1", groupId: "group-1" });
    s = applyGraphEvent(s, {
      type: "graph.node_updated",
      run_id: "gr_1",
      version: 2,
      node: { id: "n1", kind: "task", label: "实现", status: "running", agent_id: "a1" },
    });
    expect(s.nodes.n1?.status).toBe("running");
    expect(s.version).toBe(2);
  });

  it("fills ownerless live events from the trusted stream scope", () => {
    const trustedOwner = { sessionId: "session-1", groupId: "group-1" };
    const ownerless = {
      type: "graph.run_created",
      run_id: "gr_ownerless",
      version: 1,
    };

    const enriched = withGraphOwner(ownerless, trustedOwner);
    expect(enriched.session_id).toBe("session-1");
    expect(enriched.group_id).toBe("group-1");

    let s = applyGraphEvent(emptyPaneGraphState(), ownerless, {
      trustedOwner,
    });
    expect(s.owner).toEqual(trustedOwner);

    s = applyGraphEvent(
      s,
      {
        type: "graph.node_updated",
        run_id: "gr_ownerless",
        version: 2,
        node: { id: "n1", kind: "task", label: "实时节点", status: "running" },
      },
      { trustedOwner },
    );
    expect(s.nodes.n1?.label).toBe("实时节点");
    expect(s.owner).toEqual(trustedOwner);
  });

  it("does not rewrite or admit an explicit graph owner mismatch", () => {
    const state = emptyPaneGraphState();
    const trustedOwner = { sessionId: "session-1", groupId: "group-1" };
    const mismatched = applyGraphEvent(
      state,
      {
        type: "graph.run_created",
        run_id: "gr_other",
        version: 1,
        session_id: "session-other",
        group_id: "group-other",
      },
      { trustedOwner },
    );

    expect(mismatched).toBe(state);
    expect(withGraphOwner(
      {
        type: "graph.run_created",
        run_id: "gr_other",
        session_id: "session-other",
        group_id: "group-other",
      },
      trustedOwner,
    )).toMatchObject({ session_id: "session-other", group_id: "group-other" });
  });

  it("applyGraphEvent records edge_flow pulse", () => {
    let s = emptyPaneGraphState();
    s = applyGraphEvent(s, { type: "graph.edge_flow", run_id: "gr_1", edge_id: "e1" });
    expect(s.pulseEdges.e1).toBeGreaterThan(0);
  });

  it("applyGraphEvent removes edges on edge_removed", () => {
    let s = emptyPaneGraphState();
    s = {
      ...s,
      edges: [
        { id: "msg_human_agent:a1", kind: "message", source: "human", target: "agent:a1" },
        { id: "msg_human_agent:__meta__", kind: "message", source: "human", target: "agent:__meta__" },
      ],
      projection: {
        agent_nodes: [],
        agent_edges: [
          { id: "msg_human_agent:a1", kind: "message", source: "human", target: "agent:a1" },
        ],
      },
    };
    s = applyGraphEvent(s, {
      type: "graph.edge_removed",
      run_id: "gr_1",
      edge_id: "msg_human_agent:a1",
    });
    expect(s.edges.map((e) => e.id)).toEqual(["msg_human_agent:__meta__"]);
    expect(s.projection?.agent_edges).toEqual([]);
  });

  it("keeps graph version monotonic for interleaved snapshot and SSE events", () => {
    let s = applyGraphSnapshot(emptyPaneGraphState(), {
      run_id: "gr_versioned",
      session_id: "s",
      status: "open",
      version: 5,
      nodes: {
        current: { id: "current", kind: "task", label: "最新", status: "running" },
      },
      edges: [],
    });

    const staleEvent = applyGraphEvent(s, {
      type: "graph.node_updated",
      run_id: "gr_versioned",
      version: 4,
      node: { id: "old", kind: "task", label: "旧事件", status: "done" },
    });
    expect(staleEvent).toBe(s);

    s = applyGraphEvent(s, {
      type: "graph.node_updated",
      run_id: "gr_versioned",
      version: 6,
      node: { id: "next", kind: "task", label: "下一步", status: "done" },
    });
    expect(s.version).toBe(6);
    expect(s.nodes.next?.label).toBe("下一步");

    const staleSnapshot = applyGraphSnapshot(s, {
      run_id: "gr_versioned",
      session_id: "s",
      status: "open",
      version: 5,
      nodes: {
        rollback: { id: "rollback", kind: "task", label: "不应回滚", status: "pending" },
      },
      edges: [],
    });
    expect(staleSnapshot).toBe(s);
    expect(staleSnapshot.nodes.rollback).toBeUndefined();

    const sameVersionSnapshot = applyGraphSnapshot(s, {
      run_id: "gr_versioned",
      session_id: "s",
      status: "open",
      version: 6,
      nodes: {
        next: { id: "next", kind: "task", label: "同版本旧快照", status: "pending" },
      },
      edges: [],
    });
    expect(sameVersionSnapshot.nodes.next?.label).toBe("下一步");
    expect(sameVersionSnapshot.nodes.next?.status).toBe("done");
  });

  it("fills a run_created baseline from an equal-version snapshot", () => {
    let s = applyGraphEvent(emptyPaneGraphState(), {
      type: "graph.run_created",
      run_id: "gr_baseline",
      version: 1,
    });
    s = applyGraphSnapshot(s, {
      run_id: "gr_baseline",
      session_id: "s",
      status: "open",
      version: 1,
      nodes: {
        baseline: { id: "baseline", kind: "task", label: "基线", status: "ready" },
      },
      edges: [{ id: "baseline-edge", kind: "depends", source: "baseline", target: "baseline" }],
    }, {
      agent_nodes: [{ id: "agent-baseline", kind: "agent", label: "基线专家", status: "ready" }],
      agent_edges: [],
    });
    expect(s.nodes.baseline?.label).toBe("基线");
    expect(s.edges[0]?.id).toBe("baseline-edge");
    expect(s.projection?.agent_nodes[0]?.id).toBe("agent-baseline");
  });

  it("hides stale pane graph state during an immediate session switch", () => {
    const previous = applyGraphSnapshot(emptyPaneGraphState(), {
      run_id: "run-a",
      session_id: "session-a",
      group_id: "group-a",
      status: "open",
      version: 1,
      nodes: {
        old: { id: "old", kind: "task", label: "旧会话", status: "running" },
      },
      edges: [],
    });

    const switched = selectGraphStateForOwner(
      previous,
      { sessionId: "session-b", groupId: "group-b" },
      "run-a",
    );
    expect(switched.usable).toBe(false);
    expect(switched.runId).toBe("");
    expect(switched.state.nodes).toEqual({});

    const sameOwner = selectGraphStateForOwner(
      previous,
      { sessionId: "session-a", groupId: "group-a" },
      "run-a",
    );
    expect(sameOwner.usable).toBe(true);
    expect(sameOwner.runId).toBe("run-a");
    expect(sameOwner.state.nodes.old?.label).toBe("旧会话");

    const changedRun = selectGraphStateForOwner(
      previous,
      { sessionId: "session-a", groupId: "group-a" },
      "run-b",
    );
    expect(changedRun.usable).toBe(false);
    expect(changedRun.runId).toBe("");
  });

  it("accepts same-version graph events because one version can have multiple events", () => {
    let s = applyGraphSnapshot(emptyPaneGraphState(), {
      run_id: "gr_equal",
      session_id: "s",
      status: "open",
      version: 2,
      nodes: {},
      edges: [],
    });
    s = applyGraphEvent(s, {
      type: "graph.node_updated",
      run_id: "gr_equal",
      version: 2,
      node: { id: "same-version", kind: "task", label: "同版本事件", status: "running" },
    });
    expect(s.version).toBe(2);
    expect(s.nodes["same-version"]?.label).toBe("同版本事件");
  });

  it("resets run-scoped state on a run switch and requires explicit snapshot permission", () => {
    let s = applyGraphSnapshot(emptyPaneGraphState(), {
      run_id: "gr_old",
      session_id: "s",
      status: "open",
      version: 4,
      nodes: { old: { id: "old", kind: "task", label: "旧", status: "done" } },
      edges: [{ id: "old-edge", kind: "depends", source: "old", target: "old" }],
    }, {
      agent_nodes: [{ id: "agent-old", kind: "agent", label: "旧专家", status: "done" }],
      agent_edges: [],
    });
    s = {
      ...s,
      selectedNodeIds: ["old"],
      pulseEdges: { "old-edge": 1 },
      toolStepsByNode: {
        old: [{ callId: "tool-old", toolName: "旧工具", phase: "done", startedAt: 1, updatedAt: 2 }],
      },
    };

    const rejected = applyGraphSnapshot(s, {
      run_id: "gr_new",
      session_id: "s",
      status: "open",
      version: 1,
      nodes: { fresh: { id: "fresh", kind: "task", label: "新", status: "ready" } },
      edges: [],
    });
    expect(rejected).toBe(s);

    const switched = applyGraphSnapshot(rejected, {
      run_id: "gr_new",
      session_id: "s",
      status: "open",
      version: 1,
      nodes: { fresh: { id: "fresh", kind: "task", label: "新", status: "ready" } },
      edges: [],
    }, null, { allowRunSwitch: true });
    expect(switched.runId).toBe("gr_new");
    expect(switched.projection).toBeNull();
    expect(switched.selectedNodeIds).toEqual([]);
    expect(switched.pulseEdges).toEqual({});
    expect(switched.toolStepsByNode).toEqual({});
    expect(switched.nodes.old).toBeUndefined();

    const eventSwitched = applyGraphEvent(
      {
        ...s,
        selectedNodeIds: ["old"],
        pulseEdges: { "old-edge": 1 },
        toolStepsByNode: {
          old: [{ callId: "tool-old", toolName: "旧工具", phase: "done", startedAt: 1, updatedAt: 2 }],
        },
      },
      { type: "graph.run_created", run_id: "gr_new", version: 1 },
    );
    expect(eventSwitched.runId).toBe("gr_new");
    expect(eventSwitched.nodes).toEqual({});
    expect(eventSwitched.edges).toEqual([]);
    expect(eventSwitched.projection).toBeNull();
    expect(eventSwitched.selectedNodeIds).toEqual([]);
    expect(eventSwitched.toolStepsByNode).toEqual({});
  });

  it("applyGraphSnapshot replaces nodes/edges", () => {
    const s = applyGraphSnapshot(emptyPaneGraphState(), {
      run_id: "gr_2",
      session_id: "s",
      status: "open",
      version: 4,
      nodes: {
        t1: { id: "t1", kind: "task", label: "A", status: "ready" },
      },
      edges: [{ id: "e1", kind: "depends", source: "t1", target: "t1" }],
    }, { agent_nodes: [], agent_edges: [] });
    expect(s.version).toBe(4);
    expect(s.nodes.t1?.label).toBe("A");
    expect(s.projection?.agent_nodes).toEqual([]);
  });

  it("buildInterveneBody shapes edge_reassign", () => {
    const body = buildInterveneBody("edge_reassign", 3, {
      edgeIds: ["e_dep"],
      payload: { edge_id: "e_dep", new_agent_id: "avatar_b" },
    });
    expect(body).toEqual({
      op: "edge_reassign",
      version: 3,
      node_ids: [],
      edge_ids: ["e_dep"],
      payload: { edge_id: "e_dep", new_agent_id: "avatar_b" },
    });
  });

  it("layoutGraphNodes columns by status", () => {
    const pos = layoutGraphNodes([
      { id: "a", kind: "task", label: "a", status: "pending" },
      { id: "b", kind: "task", label: "b", status: "running" },
      { id: "c", kind: "task", label: "c", status: "done" },
    ]);
    expect(pos.a.x).toBeLessThan(pos.b.x);
    expect(pos.b.x).toBeLessThan(pos.c.x);
  });
});
