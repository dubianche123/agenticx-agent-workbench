import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createWorkflowRun,
  decideWorkflowApproval,
  fetchWorkflow,
  fetchWorkflowRun,
  fetchWorkflows,
  publishWorkflow,
  cancelWorkflowRun,
  resumeWorkflowApproval,
  resumeWorkflowRun,
  retryWorkflowNode,
  resolveWorkflowConfirmation,
  saveWorkflow,
  WorkflowApiError,
} from "./workflow-api";
import { createEmptyWorkflowDocument, workflowDraftPayload } from "./workflow-utils";

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("workflow API contract", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("sends the desktop token, encodes ids, and forwards AbortSignal", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
      expect(init?.headers).toBeInstanceOf(Headers);
      expect((init?.headers as Headers).get("x-agx-desktop-token")).toBe("secret");
      expect(init?.signal).toBe(signal);
      return response({ snapshot: { workflow_id: "wf/a", revision: 1 }, manifest: {} });
    });
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    const signal = controller.signal;
    await fetchWorkflow({ apiBase: "http://127.0.0.1:8000/", apiToken: "secret", signal }, "wf/a", 3);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8000/api/workflows/wf%2Fa?revision=3",
      expect.objectContaining({ signal }),
    );
  });

  it("uses the head CAS field for saves and exact revision for publishing", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body || "{}")) as Record<string, unknown> });
      return response({ snapshot: { workflow_id: "wf_demo", revision: 2 }, manifest: { workflow_id: "wf_demo", head_revision: 2 } });
    }));
    const document = createEmptyWorkflowDocument();
    await saveWorkflow({ apiBase: "http://api", apiToken: "token" }, "wf_demo", workflowDraftPayload({ ...document, workflow_id: "wf_demo" }) as never, 1);
    await publishWorkflow({ apiBase: "http://api", apiToken: "token" }, "wf_demo", 2, 2);
    expect(calls[0]).toMatchObject({ url: "http://api/api/workflows/wf_demo" });
    expect(calls[0]?.body.expected_head_revision).toBe(1);
    expect(calls[1]).toMatchObject({ url: "http://api/api/workflows/wf_demo/publish" });
    expect(calls[1]?.body).toEqual({ revision: 2, expected_head_revision: 2 });
  });

  it("normalizes structured conflicts and validation issues", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => response({ detail: { code: "head_conflict", message: "版本已变化", issues: [{ code: "stale", message: "请重新加载", path: "expected_head_revision" }] } }, 409)));
    await expect(fetchWorkflows({ apiBase: "http://api", apiToken: "token" })).rejects.toMatchObject({
      status: 409,
      code: "head_conflict",
      message: "版本已变化",
      issues: [{ code: "stale", message: "请重新加载", path: "expected_head_revision" }],
    } satisfies Partial<WorkflowApiError>);
  });

  it("reads only the explicit manifest and preserves its publication state", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => response({
      snapshot: { workflow_id: "wf_demo", revision: 7, title: "Draft snapshot", created_at: "now" },
      workflow: { workflow_id: "wf_demo", revision: 99, title: "Historical alias", head_revision: 99, published_revisions: [99] },
      manifest: { workflow_id: "wf_demo", title: "Published workflow", head_revision: 7, published_revisions: [3, 7], active_published_revision: 7, created_at: "then", updated_at: "now" },
    })));
    const result = await fetchWorkflow({ apiBase: "http://api", apiToken: "token" }, "wf_demo");
    expect(result.manifest).toMatchObject({ title: "Published workflow", head_revision: 7, published_revisions: [3, 7], active_published_revision: 7 });
  });

  it("does not promote the snapshot alias to a manifest when the field is absent", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => response({
      snapshot: { workflow_id: "wf_demo", revision: 8, title: "Current snapshot", created_at: "now" },
      workflow: { workflow_id: "wf_demo", title: "Alias with stale metadata", head_revision: 1, published_revisions: [] },
    })));
    const result = await fetchWorkflow(
      { apiBase: "http://api", apiToken: "token" },
      "wf_demo",
      undefined,
      { workflow_id: "wf_demo", title: "Current", head_revision: 7, published_revisions: [3, 7], active_published_revision: 7, created_at: "then", updated_at: "then" },
    );
    expect(result.manifest).toMatchObject({ title: "Current snapshot", head_revision: 8, published_revisions: [3, 7], active_published_revision: 7 });
  });

  it("keeps run, readiness, and approvals together through run mutations", async () => {
    const run = { run_id: "run-1", workflow_id: "wf_demo", session_id: "session-1", workflow_revision: 7, workflow_digest: "digest", status: "blocked", version: 4, nodes: {}, edges: [] };
    const approval = { approval_id: "approval-1", run_id: "run-1", version: 2, status: "pending" };
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (url) => {
      if (String(url).includes("/runs")) return response({ run, ready_node_ids: ["node-1"], approvals: [approval] });
      if (String(url).includes("/decision")) return response({ approval: { ...approval, status: "approved", version: 3 }, run, ready_node_ids: ["node-2"], approvals: [{ ...approval, status: "approved", version: 3 }] });
      return response({ run, ready_node_ids: ["node-3"], approvals: [approval] });
    }));
    const options = { apiBase: "http://api", apiToken: "token" };
    const created = await createWorkflowRun(options, "wf_demo", 7, "session-1");
    expect(created.run.run_id).toBe("run-1");
    expect(created.ready_node_ids).toEqual(["node-1"]);
    expect(created.approvals).toHaveLength(1);
    const decided = await decideWorkflowApproval(options, "approval-1", { session_id: "session-1", expected_version: 2, expected_run_version: 4, decision: "approved" });
    expect(decided.approval?.status).toBe("approved");
    expect(decided.run?.run_id).toBe("run-1");
    const resumed = await resumeWorkflowApproval(options, "approval-1", { session_id: "session-1", expected_version: 3, expected_run_version: 4 });
    expect(resumed.run.run_id).toBe("run-1");
    expect(resumed.ready_node_ids).toEqual(["node-3"]);
    expect(resumed.approvals).toHaveLength(1);
  });

  it("preserves an explicit empty approvals array and distinguishes an omitted field", async () => {
    const run = { run_id: "run-empty", workflow_id: "wf_demo", session_id: "session-1", workflow_revision: 7, status: "ready", version: 1, nodes: {}, edges: [] };
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({ run, ready_node_ids: [], approvals: [] }))
      .mockResolvedValueOnce(response({ run, ready_node_ids: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const options = { apiBase: "http://api", apiToken: "token" };

    const explicitEmpty = await createWorkflowRun(options, "wf_demo", 7, "session-1");
    expect(Object.prototype.hasOwnProperty.call(explicitEmpty, "approvals")).toBe(true);
    expect(explicitEmpty.approvals).toEqual([]);

    const omitted = await createWorkflowRun(options, "wf_demo", 7, "session-1");
    expect(Object.prototype.hasOwnProperty.call(omitted, "approvals")).toBe(false);
    expect(omitted.approvals).toBeUndefined();
  });

  it("keeps the managed execution projection through reads and control mutations", async () => {
    const calls: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
    const run = {
      run_id: "run/execution",
      workflow_id: "wf_demo",
      session_id: "session-1",
      workflow_revision: 7,
      workflow_digest: "digest",
      status: "open",
      version: 4,
      nodes: {},
      edges: [],
    };
    const execution = {
      state: "blocked",
      run_id: run.run_id,
      version: 4,
      active_node_ids: [],
      blocked_node_ids: ["node-a"],
      claims: { "node-a": { attempt_id: "attempt-1", fencing_token: 9 } },
      last_error: "模型未配置",
    };
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (url, init) => {
      calls.push({
        url: String(url),
        method: String(init?.method || "GET"),
        body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined,
      });
      return response({ run, execution, ready_node_ids: [], approvals: [] });
    }));
    const options = { apiBase: "http://api", apiToken: "token" };

    const fetched = await fetchWorkflowRun(options, run.run_id, run.session_id);
    const resumed = await resumeWorkflowRun(options, run.run_id, { session_id: run.session_id, expected_version: 4 });
    const cancelled = await cancelWorkflowRun(options, run.run_id, { session_id: run.session_id, expected_version: 4 });
    const retried = await retryWorkflowNode(options, run.run_id, "node/a", { session_id: run.session_id, expected_version: 4, reconcile: true });

    for (const result of [fetched, resumed, cancelled, retried]) {
      expect(result.execution).toMatchObject({ state: "blocked", run_id: run.run_id, version: 4, blocked_node_ids: ["node-a"] });
      expect(result.run.execution).toEqual(result.execution);
      expect(result.execution?.claims["node-a"]).toMatchObject({ attempt_id: "attempt-1", fencing_token: 9 });
    }
    expect(calls.map((call) => [call.method, call.url])).toEqual([
      ["GET", "http://api/api/workflow-runs/run%2Fexecution?session_id=session-1"],
      ["POST", "http://api/api/workflow-runs/run%2Fexecution/resume"],
      ["POST", "http://api/api/workflow-runs/run%2Fexecution/cancel"],
      ["POST", "http://api/api/workflow-runs/run%2Fexecution/nodes/node%2Fa/retry"],
    ]);
    expect(calls[1]?.body).toMatchObject({ session_id: "session-1", expected_version: 4 });
    expect(calls[2]?.body).toMatchObject({ session_id: "session-1", expected_version: 4 });
    expect(calls[3]?.body).toMatchObject({ session_id: "session-1", expected_version: 4, reconcile: true });
  });

  it("uses the shared confirmation gate for a protected workflow tool event", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      expect(String(url)).toBe("http://api/api/confirm");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({
        session_id: "session-1",
        request_id: "wf-confirm-attempt-1",
        approved: true,
        agent_id: "meta",
      });
      return response({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);
    await resolveWorkflowConfirmation({ apiBase: "http://api", apiToken: "token" }, {
      session_id: "session-1",
      request_id: "wf-confirm-attempt-1",
      approved: true,
      agent_id: "meta",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
