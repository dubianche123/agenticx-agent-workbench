import { beforeEach, describe, expect, it, vi } from "vitest";

const requireAdminSomeScopeMock = vi.fn();
const buildAuditActorMock = vi.fn();
const queryAuditMock = vi.fn();
const queryPortalLogsMock = vi.fn();
const getAgentTraceSpansByTenantMock = vi.fn();
const getDeepResearchRunByTraceMock = vi.fn();
const assembleTraceTimelineMock = vi.fn();

const TRACE_DETAIL_SCOPES = ["audit:read:all", "audit:manage", "metering:read"];

vi.mock("server-only", () => ({}));

vi.mock("../../../../../lib/admin-auth", () => ({
  requireAdminSomeScope: (...args: unknown[]) => requireAdminSomeScopeMock(...args),
}));

vi.mock("../../../../../lib/audit-service", () => ({
  buildAuditActor: (...args: unknown[]) => buildAuditActorMock(...args),
  queryAudit: (...args: unknown[]) => queryAuditMock(...args),
}));

vi.mock("../../../../../lib/portal-logs-query", () => ({
  queryPortalLogs: (...args: unknown[]) => queryPortalLogsMock(...args),
}));

vi.mock("../../../../../lib/agent-trace-by-tenant", () => ({
  getAgentTraceSpansByTenant: (...args: unknown[]) => getAgentTraceSpansByTenantMock(...args),
}));

vi.mock("../../../../../lib/deep-research-trace-query", () => ({
  getDeepResearchRunByTrace: (...args: unknown[]) => getDeepResearchRunByTraceMock(...args),
}));

vi.mock("../../../../../lib/trace-timeline", () => ({
  assembleTraceTimeline: (...args: unknown[]) => assembleTraceTimelineMock(...args),
}));

const TRACE_ID = "01K4KZAA000000000000000001";

function allow(scopes: string[]) {
  const permitted = scopes.some(
    (scope) => scope === "*" || TRACE_DETAIL_SCOPES.includes(scope),
  );
  if (!permitted) {
    requireAdminSomeScopeMock.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ code: "40300", message: "forbidden" }), {
        status: 403,
      }),
    });
    return;
  }
  requireAdminSomeScopeMock.mockResolvedValue({
    ok: true,
    session: { tenantId: "tenant-a", userId: "admin-a", email: "admin@example.com" },
    scopes,
  });
  buildAuditActorMock.mockResolvedValue({
    tenantId: "tenant-a",
    userId: "admin-a",
    deptId: "dept-a",
    scopes,
  });
}

function requestFor(traceId = TRACE_ID, headerTraceId = "01K4KZAA000000000000000099") {
  return new Request(`http://localhost/api/traces/${traceId}`, {
    headers: { "x-agenticx-trace-id": headerTraceId },
  });
}

describe("GET /api/traces/[traceId]", () => {
  beforeEach(() => {
    requireAdminSomeScopeMock.mockReset();
    buildAuditActorMock.mockReset();
    queryAuditMock.mockReset();
    queryPortalLogsMock.mockReset();
    getAgentTraceSpansByTenantMock.mockReset();
    getDeepResearchRunByTraceMock.mockReset();
    assembleTraceTimelineMock.mockReset();
    queryPortalLogsMock.mockResolvedValue({ total: 0, items: [] });
    getAgentTraceSpansByTenantMock.mockResolvedValue([]);
    getDeepResearchRunByTraceMock.mockResolvedValue(null);
    assembleTraceTimelineMock.mockReturnValue({
      trace_id: TRACE_ID,
      nodes: [],
      totals: { steps: 0, tokens: 0, cost_usd: 0, duration_ms: null },
      sources: { portal_logs: 0, model_steps: 0, deep_research_run: false, audit_events: 0 },
    });
  });

  it("requires broad audit or metering permission for complete trace data", async () => {
    allow(["audit:read"]);

    const { GET } = await import("../route");
    const response = await GET(requestFor(), { params: Promise.resolve({ traceId: TRACE_ID }) });

    expect(response.status).toBe(403);
    expect(requireAdminSomeScopeMock).toHaveBeenCalledWith(TRACE_DETAIL_SCOPES);
    expect(buildAuditActorMock).not.toHaveBeenCalled();
    expect(queryAuditMock).not.toHaveBeenCalled();
    expect(queryPortalLogsMock).not.toHaveBeenCalled();
    expect(getAgentTraceSpansByTenantMock).not.toHaveBeenCalled();
    expect(getDeepResearchRunByTraceMock).not.toHaveBeenCalled();
  });

  it.each([["audit:read:dept"], ["audit:read"]])(
    "does not pivot from a visible %s audit row into a complete trace",
    async (scope) => {
      allow([scope]);
      queryAuditMock.mockResolvedValue({
        code: "00000",
        message: "ok",
        data: {
          total: 1,
          items: [{ id: "audit-visible", tenant_id: "tenant-a", trace_id: TRACE_ID }],
        },
      });

      const { GET } = await import("../route");
      const response = await GET(requestFor(), {
        params: Promise.resolve({ traceId: TRACE_ID }),
      });

      expect(response.status).toBe(403);
      expect(queryAuditMock).not.toHaveBeenCalled();
      expect(queryPortalLogsMock).not.toHaveBeenCalled();
      expect(getAgentTraceSpansByTenantMock).not.toHaveBeenCalled();
      expect(getDeepResearchRunByTraceMock).not.toHaveBeenCalled();
      expect(assembleTraceTimelineMock).not.toHaveBeenCalled();
    },
  );

  it("passes only same-tenant audit rows into the timeline", async () => {
    allow(["audit:read:all"]);
    const visibleAuditEvent = { id: "audit-1", trace_id: TRACE_ID, tenant_id: "tenant-a" };
    const crossTenantAuditEvent = { id: "audit-2", trace_id: TRACE_ID, tenant_id: "tenant-b" };
    queryAuditMock.mockResolvedValue({
      code: "00000",
      message: "ok",
      data: { total: 2, items: [visibleAuditEvent, crossTenantAuditEvent] },
    });

    const { GET } = await import("../route");
    const response = await GET(requestFor(), {
      params: Promise.resolve({ traceId: TRACE_ID }),
    });

    expect(response.status).toBe(200);
    expect(buildAuditActorMock).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: "tenant-a", userId: "admin-a" }),
      ["audit:read:all"],
    );
    expect(queryAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: "tenant-a", userId: "admin-a" }),
      { tenant_id: "tenant-a", trace_id: TRACE_ID, limit: 100, offset: 0 },
    );
    expect(queryPortalLogsMock).toHaveBeenCalledWith({
      tenant_id: "tenant-a",
      trace_id: TRACE_ID,
      limit: 100,
      offset: 0,
    });
    expect(getAgentTraceSpansByTenantMock).toHaveBeenCalledWith("tenant-a", TRACE_ID);
    expect(getDeepResearchRunByTraceMock).toHaveBeenCalledWith("tenant-a", TRACE_ID);
    expect(assembleTraceTimelineMock).toHaveBeenCalledWith({
      traceId: TRACE_ID,
      portalLogs: [],
      modelSpans: [],
      deepResearchRun: null,
      auditEvents: [visibleAuditEvent],
    });
  });

  it("filters cross-tenant Portal rows before assembling a trace", async () => {
    allow(["audit:manage"]);
    queryAuditMock.mockResolvedValue({
      code: "00000",
      message: "ok",
      data: { total: 0, items: [] },
    });
    const visiblePortalRow = { id: "portal-1", tenant_id: "tenant-a", trace_id: TRACE_ID };
    const crossTenantPortalRow = { id: "portal-2", tenant_id: "tenant-b", trace_id: TRACE_ID };
    queryPortalLogsMock.mockResolvedValue({
      total: 2,
      items: [visiblePortalRow, crossTenantPortalRow],
    });

    const { GET } = await import("../route");
    const response = await GET(requestFor(), {
      params: Promise.resolve({ traceId: TRACE_ID }),
    });

    expect(response.status).toBe(200);
    expect(queryPortalLogsMock).toHaveBeenCalledWith({
      tenant_id: "tenant-a",
      trace_id: TRACE_ID,
      limit: 100,
      offset: 0,
    });
    expect(assembleTraceTimelineMock).toHaveBeenCalledWith(
      expect.objectContaining({ portalLogs: [visiblePortalRow] }),
    );
  });

  it("allows metering-only operators to inspect runtime sources without audit rows", async () => {
    allow(["metering:read"]);
    getAgentTraceSpansByTenantMock.mockResolvedValue([{ id: "span-1" }]);

    const { GET } = await import("../route");
    const response = await GET(requestFor(), {
      params: Promise.resolve({ traceId: TRACE_ID }),
    });

    expect(response.status).toBe(200);
    expect(buildAuditActorMock).not.toHaveBeenCalled();
    expect(queryAuditMock).not.toHaveBeenCalled();
    expect(assembleTraceTimelineMock).toHaveBeenCalledWith(
      expect.objectContaining({ auditEvents: [], modelSpans: [{ id: "span-1" }] }),
    );
  });

  it("degrades a failed Portal source while preserving audit and model data", async () => {
    allow(["audit:read:all"]);
    const auditEvent = { id: "audit-1", trace_id: TRACE_ID, tenant_id: "tenant-a" };
    queryAuditMock.mockResolvedValue({
      code: "00000",
      message: "ok",
      data: { total: 1, items: [auditEvent] },
    });
    queryPortalLogsMock.mockRejectedValue(new Error("portal store unavailable"));
    getAgentTraceSpansByTenantMock.mockResolvedValue([{ id: "span-1" }]);

    const { GET } = await import("../route");
    const response = await GET(requestFor(), {
      params: Promise.resolve({ traceId: TRACE_ID }),
    });

    expect(response.status).toBe(200);
    expect(assembleTraceTimelineMock).toHaveBeenCalledWith({
      traceId: TRACE_ID,
      portalLogs: [],
      portalLogsAvailable: false,
      modelSpans: [{ id: "span-1" }],
      deepResearchRun: null,
      auditEvents: [auditEvent],
    });
  });

  it("keeps model source failures fatal when Portal is also unavailable", async () => {
    allow(["audit:read:all"]);
    queryPortalLogsMock.mockRejectedValue(new Error("portal store unavailable"));
    getAgentTraceSpansByTenantMock.mockRejectedValue(new Error("model store unavailable"));

    const { GET } = await import("../route");
    const response = await GET(requestFor(), {
      params: Promise.resolve({ traceId: TRACE_ID }),
    });

    expect(response.status).toBe(500);
    expect(assembleTraceTimelineMock).not.toHaveBeenCalled();
  });

  it("keeps deep-research source failures fatal", async () => {
    allow(["audit:read:all"]);
    getDeepResearchRunByTraceMock.mockRejectedValue(new Error("deep store unavailable"));

    const { GET } = await import("../route");
    const response = await GET(requestFor(), {
      params: Promise.resolve({ traceId: TRACE_ID }),
    });

    expect(response.status).toBe(500);
    expect(assembleTraceTimelineMock).not.toHaveBeenCalled();
  });

  it("rejects malformed trace ids before reading any source", async () => {
    allow(["audit:read:all"]);

    const { GET } = await import("../route");
    const response = await GET(
      new Request("http://localhost/api/traces/not-a-trace", {
        headers: { "x-agenticx-trace-id": TRACE_ID },
      }),
      { params: Promise.resolve({ traceId: "not-a-trace" }) },
    );

    expect(response.status).toBe(400);
    expect(queryAuditMock).not.toHaveBeenCalled();
    expect(queryPortalLogsMock).not.toHaveBeenCalled();
    expect(getAgentTraceSpansByTenantMock).not.toHaveBeenCalled();
  });
});
