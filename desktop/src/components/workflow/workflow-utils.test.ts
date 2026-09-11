import { describe, expect, it } from "vitest";
import {
  canConnectWorkflow,
  connectionToWorkflowEdge,
  createEmptyWorkflowDocument,
  createWorkflowNode,
  routeFromHandle,
  serializeWorkflowDraft,
  uniqueWorkflowNodeId,
  workflowApprovalActionability,
  workflowToFlowEdges,
  workflowToFlowNodes,
} from "./workflow-utils";
import type { WorkflowApproval, WorkflowRun } from "./workflow-types";

describe("workflow editor utilities", () => {
  it("creates collision-resistant ids and preserves the eight kind palette contract", () => {
    const first = uniqueWorkflowNodeId(["node_agent_task_fixed"], "agent_task");
    const second = uniqueWorkflowNodeId([first], "agent_task");
    expect(first).not.toBe(second);
    expect(first).toMatch(/^node_agent_task_/);
    expect(createWorkflowNode("join").config).toEqual({ mode: "all" });
  });

  it("maps decision routes to distinct source handles and back to edges", () => {
    const document = createEmptyWorkflowDocument();
    const decision = createWorkflowNode("decision", document.nodes.map((node) => node.id));
    const left = createWorkflowNode("end", [...document.nodes.map((node) => node.id), decision.id]);
    const right = createWorkflowNode("end", [...document.nodes.map((node) => node.id), decision.id, left.id]);
    const next = {
      ...document,
      nodes: [...document.nodes, decision, left, right],
      edges: [
        ...document.edges,
        { id: "route-a", source: decision.id, target: left.id, route: "approve", label: "通过" },
        { id: "route-b", source: decision.id, target: right.id, route: "reject", label: "拒绝" },
      ],
    };
    const flowNodes = workflowToFlowNodes(next);
    const flowEdges = workflowToFlowEdges(next);
    expect(flowNodes.find((node) => node.id === decision.id)?.data.outgoingRoutes).toEqual(["approve", "reject"]);
    expect(flowEdges.find((edge) => edge.id === "route-a")?.sourceHandle).toBe("decision-route:approve");
    expect(routeFromHandle("decision-route:reject")).toBe("reject");
    const edge = connectionToWorkflowEdge({ source: decision.id, target: left.id, sourceHandle: "decision-route:review" }, []);
    expect(edge).toMatchObject({ source: decision.id, target: left.id, route: "review", label: "review" });
  });

  it("rejects self and duplicate connections and serializes dirty state deterministically", () => {
    const document = createEmptyWorkflowDocument();
    const trigger = document.nodes[0]!;
    const end = document.nodes[1]!;
    expect(canConnectWorkflow({ source: trigger.id, target: trigger.id }, document.edges)).toMatchObject({ ok: false });
    expect(canConnectWorkflow({ source: trigger.id, target: end.id }, document.edges)).toMatchObject({ ok: false });
    const first = serializeWorkflowDraft(document);
    const second = serializeWorkflowDraft({ ...document, config: undefined } as never);
    expect(first).not.toBe("");
    expect(first).toBe(second);
  });

  it("only exposes approval actions for an open run with a blocked gate", () => {
    const run = {
      status: "open",
      nodes: [{ id: "gate-a", workflow_node_id: "gate-a", status: "BLOCKED" }],
    } as WorkflowRun;
    const pending = { status: "pending", gate_node_id: "gate-a" } as WorkflowApproval;
    const approved = { status: "approved", gate_node_id: "gate-a" } as WorkflowApproval;

    expect(workflowApprovalActionability(run, pending)).toEqual({ canAct: true, reason: "" });
    expect(workflowApprovalActionability(run, approved)).toEqual({ canAct: true, reason: "" });
    expect(workflowApprovalActionability({ ...run, status: "failed" }, approved)).toMatchObject({ canAct: false });
    expect(workflowApprovalActionability({ ...run, nodes: [{ id: "gate-a", status: "done" }] }, approved)).toMatchObject({ canAct: false });
    expect(workflowApprovalActionability({ ...run, nodes: [{ id: "gate-a", status: "skipped" }] }, approved).reason).toContain("审批门当前状态");
  });
});
