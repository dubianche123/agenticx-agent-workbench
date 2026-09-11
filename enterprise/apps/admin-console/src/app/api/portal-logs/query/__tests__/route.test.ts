import { beforeEach, describe, expect, it, vi } from "vitest";

const requireAdminSomeScopeMock = vi.fn();
const queryPortalLogsMock = vi.fn();

const PORTAL_LOG_SCOPES = ["audit:read:all", "audit:manage"];

vi.mock("server-only", () => ({}));

vi.mock("../../../../../lib/admin-auth", () => ({
  requireAdminSomeScope: (...args: unknown[]) => requireAdminSomeScopeMock(...args),
}));

vi.mock("../../../../../lib/portal-logs-query", async () => {
  const actual = await vi.importActual<typeof import("../../../../../lib/portal-logs-query")>(
    "../../../../../lib/portal-logs-query",
  );
  return {
    ...actual,
    queryPortalLogs: (...args: unknown[]) => queryPortalLogsMock(...args),
  };
});

describe("POST /api/portal-logs/query", () => {
  beforeEach(() => {
    requireAdminSomeScopeMock.mockReset();
    queryPortalLogsMock.mockReset();
  });

  it("allows broad audit scopes to query portal rows", async () => {
    requireAdminSomeScopeMock.mockResolvedValue({
      ok: true,
      session: { tenantId: "t1", userId: "u1", email: "a@example.com" },
      scopes: ["audit:read:all"],
    });
    queryPortalLogsMock.mockResolvedValue({ total: 0, items: [] });

    const { POST } = await import("../route");
    const response = await POST(
      new Request("http://localhost/api/portal-logs/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    expect(response.status).toBe(200);
    expect(requireAdminSomeScopeMock).toHaveBeenCalledWith(PORTAL_LOG_SCOPES);
  });

  it.each([["audit:read"], ["audit:read:dept"]])(
    "rejects scoped audit permission %s before querying Portal rows",
    async (scope) => {
      requireAdminSomeScopeMock.mockResolvedValue({
        ok: true,
        session: { tenantId: "tenant-alpha", userId: "u1", email: "a@example.com" },
        scopes: [scope],
      });

      const { POST } = await import("../route");
      const response = await POST(
        new Request("http://localhost/api/portal-logs/query", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ trace_id: "trace-visible" }),
        }),
      );

      expect(response.status).toBe(403);
      expect(queryPortalLogsMock).not.toHaveBeenCalled();
      expect(requireAdminSomeScopeMock).toHaveBeenCalledWith(PORTAL_LOG_SCOPES);
    },
  );

  it("rejects an unfiltered scoped query even when the adapter reports success", async () => {
    requireAdminSomeScopeMock.mockResolvedValue({
      ok: true,
      session: { tenantId: "tenant-alpha", userId: "u1", email: "a@example.com" },
      scopes: ["audit:read:dept"],
    });

    const { POST } = await import("../route");
    const response = await POST(
      new Request("http://localhost/api/portal-logs/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    );

    expect(response.status).toBe(403);
    expect(queryPortalLogsMock).not.toHaveBeenCalled();
  });

  it("ignores a reused trace header and keeps the requested trace and tenant", async () => {
    requireAdminSomeScopeMock.mockResolvedValue({
      ok: true,
      session: { tenantId: "tenant-alpha", userId: "u1", email: "a@example.com" },
      scopes: ["audit:read:all"],
    });
    queryPortalLogsMock.mockResolvedValue({ total: 0, items: [] });

    const { POST } = await import("../route");
    const response = await POST(
      new Request("http://localhost/api/portal-logs/query", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-agenticx-trace-id": "01K4KZAA000000000000000099",
        },
        body: JSON.stringify({
          trace_id: "01K4KZAA000000000000000001",
          tenant_id: "tenant-other",
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(queryPortalLogsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant_id: "tenant-alpha",
        trace_id: "01K4KZAA000000000000000001",
      }),
    );
  });

  it("returns the auth response when the shared guard rejects the caller", async () => {
    requireAdminSomeScopeMock.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ code: "40300", message: "forbidden" }), {
        status: 403,
      }),
    });

    const { POST } = await import("../route");
    const response = await POST(
      new Request("http://localhost/api/portal-logs/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    );

    expect(response.status).toBe(403);
    expect(queryPortalLogsMock).not.toHaveBeenCalled();
  });

  it("rejects string filters longer than 128 chars with 400", async () => {
    requireAdminSomeScopeMock.mockResolvedValue({
      ok: true,
      session: { tenantId: "t1", userId: "u1", email: "a@example.com" },
      scopes: ["audit:read:all"],
    });

    const { POST } = await import("../route");
    const response = await POST(
      new Request("http://localhost/api/portal-logs/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ trace_id: "x".repeat(129) }),
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "40001", message: "invalid trace_id" });
    expect(queryPortalLogsMock).not.toHaveBeenCalled();
  });

  it("always scopes query to the current tenant", async () => {
    requireAdminSomeScopeMock.mockResolvedValue({
      ok: true,
      session: { tenantId: "tenant-alpha", userId: "u1", email: "a@example.com" },
      scopes: ["audit:manage"],
    });
    queryPortalLogsMock.mockResolvedValue({ total: 0, items: [] });

    const { POST } = await import("../route");
    const response = await POST(
      new Request("http://localhost/api/portal-logs/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ trace_id: "01JTRACEAAAAAAAAAAAAAAAAA", tenant_id: "other" }),
      }),
    );

    expect(response.status).toBe(200);
    expect(queryPortalLogsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant_id: "tenant-alpha",
        trace_id: "01JTRACEAAAAAAAAAAAAAAAAA",
      }),
    );
  });

  it("clamps limit=9999 to 500", async () => {
    requireAdminSomeScopeMock.mockResolvedValue({
      ok: true,
      session: { tenantId: "t1", userId: "u1", email: "a@example.com" },
      scopes: ["audit:read:all"],
    });
    queryPortalLogsMock.mockResolvedValue({ total: 0, items: [] });

    const { POST } = await import("../route");
    await POST(
      new Request("http://localhost/api/portal-logs/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ limit: 9999 }),
      }),
    );

    expect(queryPortalLogsMock).toHaveBeenCalledWith(expect.objectContaining({ limit: 500 }));
  });

  it("accepts mode=deep_research and forwards it to queryPortalLogs", async () => {
    requireAdminSomeScopeMock.mockResolvedValue({
      ok: true,
      session: { tenantId: "t1", userId: "u1", email: "a@example.com" },
      scopes: ["audit:read:all"],
    });
    queryPortalLogsMock.mockResolvedValue({ total: 0, items: [] });

    const { POST } = await import("../route");
    const response = await POST(
      new Request("http://localhost/api/portal-logs/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "deep_research", run_id: "01JRUNAAAAAAAAAAAAAAAAAAA" }),
      }),
    );

    expect(response.status).toBe(200);
    expect(queryPortalLogsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "deep_research",
        run_id: "01JRUNAAAAAAAAAAAAAAAAAAA",
      }),
    );
  });
});
