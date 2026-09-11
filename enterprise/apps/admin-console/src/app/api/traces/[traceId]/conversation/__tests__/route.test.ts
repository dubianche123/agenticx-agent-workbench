import { beforeEach, describe, expect, it, vi } from "vitest";

const requireAdminSomeScopeMock = vi.fn();
const getTraceConversationTurnMock = vi.fn();

const TRACE_CONVERSATION_SCOPES = ["audit:read:all", "audit:manage", "metering:read"];

vi.mock("server-only", () => ({}));

vi.mock("../../../../../../lib/admin-auth", () => ({
  requireAdminSomeScope: (...args: unknown[]) => requireAdminSomeScopeMock(...args),
}));

vi.mock("../../../../../../lib/trace-conversation-io", () => ({
  getTraceConversationTurn: (...args: unknown[]) => getTraceConversationTurnMock(...args),
}));

const TRACE_ID = "01K4KZAA000000000000000001";

function allow(scopes: string[]) {
  const permitted = scopes.some(
    (scope) => scope === "*" || TRACE_CONVERSATION_SCOPES.includes(scope),
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
}

describe("GET /api/traces/[traceId]/conversation", () => {
  beforeEach(() => {
    requireAdminSomeScopeMock.mockReset();
    getTraceConversationTurnMock.mockReset();
    getTraceConversationTurnMock.mockResolvedValue({ trace_id: TRACE_ID, messages: [] });
  });

  it("allows broad operators to read a trace conversation", async () => {
    allow(["audit:read:all"]);

    const { GET } = await import("../route");
    const response = await GET(
      new Request(`http://localhost/api/traces/${TRACE_ID}/conversation`, {
        headers: { "x-agenticx-trace-id": "01K4KZAA000000000000000099" },
      }),
      { params: Promise.resolve({ traceId: TRACE_ID }) },
    );

    expect(response.status).toBe(200);
    expect(requireAdminSomeScopeMock).toHaveBeenCalledWith(TRACE_CONVERSATION_SCOPES);
    expect(getTraceConversationTurnMock).toHaveBeenCalledWith("tenant-a", TRACE_ID, {
      expand: false,
    });
  });

  it.each([["audit:read"], ["audit:read:dept"]])(
    "blocks %s from reading complete conversation even if a trace audit row exists",
    async (scope) => {
      allow([scope]);

      const { GET } = await import("../route");
      const response = await GET(
        new Request(`http://localhost/api/traces/${TRACE_ID}/conversation`, {
          headers: { "x-agenticx-trace-id": TRACE_ID },
        }),
        { params: Promise.resolve({ traceId: TRACE_ID }) },
      );

      expect(response.status).toBe(403);
      expect(getTraceConversationTurnMock).not.toHaveBeenCalled();
    },
  );

  it("allows metering-only operators and always uses the session tenant", async () => {
    allow(["metering:read"]);

    const { GET } = await import("../route");
    const response = await GET(
      new Request(`http://localhost/api/traces/${TRACE_ID}/conversation?expand=1`, {
        headers: {
          "x-agenticx-trace-id": "01K4KZAA000000000000000099",
        },
      }),
      { params: Promise.resolve({ traceId: TRACE_ID }) },
    );

    expect(response.status).toBe(200);
    expect(getTraceConversationTurnMock).toHaveBeenCalledWith("tenant-a", TRACE_ID, {
      expand: true,
    });
  });

  it("rejects malformed trace ids before reading conversation data", async () => {
    allow(["audit:read:all"]);

    const { GET } = await import("../route");
    const response = await GET(
      new Request("http://localhost/api/traces/not-a-trace/conversation", {
        headers: { "x-agenticx-trace-id": TRACE_ID },
      }),
      { params: Promise.resolve({ traceId: "not-a-trace" }) },
    );

    expect(response.status).toBe(400);
    expect(getTraceConversationTurnMock).not.toHaveBeenCalled();
  });
});
