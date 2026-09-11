import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class CapabilityShelfOrderValidationError extends Error {}
  class CapabilityShelfMembershipValidationError extends Error {}
  return {
    requireAdminScope: vi.fn(),
    getCapabilityShelfOrder: vi.fn(),
    replaceCapabilityShelfOrder: vi.fn(),
    addCapabilityToShelf: vi.fn(),
    removeCapabilityFromShelf: vi.fn(),
    normalizeCapabilityShelfOrder: vi.fn((ids: readonly unknown[]) => [...ids] as string[]),
    insertAuditEvent: vi.fn(),
    CapabilityShelfOrderValidationError,
    CapabilityShelfMembershipValidationError,
  };
});

vi.mock("@agenticx/iam-core", () => ({
  insertAuditEvent: (...args: unknown[]) => mocks.insertAuditEvent(...args),
}));
vi.mock("../../../../../lib/admin-auth", () => ({
  requireAdminScope: (...args: unknown[]) => mocks.requireAdminScope(...args),
}));
vi.mock("../../../../../lib/capability-shelf-order-store", () => ({
  MAX_CAPABILITY_SHELF_ITEMS: 1000,
  CapabilityShelfOrderValidationError: mocks.CapabilityShelfOrderValidationError,
  CapabilityShelfMembershipValidationError: mocks.CapabilityShelfMembershipValidationError,
  getCapabilityShelfOrder: (...args: unknown[]) => mocks.getCapabilityShelfOrder(...args),
  normalizeCapabilityShelfOrder: (ids: readonly unknown[]) =>
    mocks.normalizeCapabilityShelfOrder(ids),
  replaceCapabilityShelfOrder: (...args: unknown[]) => mocks.replaceCapabilityShelfOrder(...args),
  addCapabilityToShelf: (...args: unknown[]) => mocks.addCapabilityToShelf(...args),
  removeCapabilityFromShelf: (...args: unknown[]) => mocks.removeCapabilityFromShelf(...args),
}));

function request(body: unknown, method = "PUT"): Request {
  return new Request("https://admin.example.invalid/api/admin/capability-shelf-order", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("/api/admin/capability-shelf-order", () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => {
      if (typeof mock === "function" && "mockReset" in mock) mock.mockReset();
    });
    mocks.requireAdminScope.mockResolvedValue({
      ok: true,
      session: { tenantId: "tenant-session", userId: "admin-a" },
    });
    mocks.getCapabilityShelfOrder.mockResolvedValue(["feature:web_search"]);
    mocks.normalizeCapabilityShelfOrder.mockImplementation(
      (ids: readonly unknown[]) => [...ids] as string[],
    );
    mocks.replaceCapabilityShelfOrder.mockResolvedValue({
      previousCapabilityIds: ["feature:web_search"],
      orderedCapabilityIds: ["mcp:01JQMZ8K3N4P5Q6R7S8T9VWX01"],
    });
    mocks.addCapabilityToShelf.mockResolvedValue({
      capabilityId: "expert:01JQMZ8K3N4P5Q6R7S8T9VWX01",
      previousCapabilityIds: ["feature:web_search"],
      orderedCapabilityIds: [
        "feature:web_search",
        "expert:01JQMZ8K3N4P5Q6R7S8T9VWX01",
      ],
    });
    mocks.removeCapabilityFromShelf.mockResolvedValue({
      capabilityId: "expert:01JQMZ8K3N4P5Q6R7S8T9VWX01",
      previousCapabilityIds: [
        "feature:web_search",
        "expert:01JQMZ8K3N4P5Q6R7S8T9VWX01",
      ],
      orderedCapabilityIds: ["feature:web_search"],
    });
    mocks.insertAuditEvent.mockResolvedValue(undefined);
  });

  it("loads only through the authenticated tenant with provider read scope", async () => {
    const { GET } = await import("../route");
    const response = await GET();

    expect(response.status).toBe(200);
    expect(mocks.requireAdminScope).toHaveBeenCalledWith(["provider:read"]);
    expect(mocks.getCapabilityShelfOrder).toHaveBeenCalledWith("tenant-session");
    await expect(response.json()).resolves.toMatchObject({
      data: { orderedCapabilityIds: ["feature:web_search"] },
    });
  });

  it("replaces the order with provider update scope and audits the transition", async () => {
    const { PUT } = await import("../route");
    const response = await PUT(
      request({ capabilityIds: ["mcp:01JQMZ8K3N4P5Q6R7S8T9VWX01"] }),
    );

    expect(response.status).toBe(200);
    expect(mocks.requireAdminScope).toHaveBeenCalledWith(["provider:update"]);
    expect(mocks.replaceCapabilityShelfOrder).toHaveBeenCalledWith("tenant-session", [
      "mcp:01JQMZ8K3N4P5Q6R7S8T9VWX01",
    ]);
    expect(mocks.insertAuditEvent).toHaveBeenCalledWith({
      tenantId: "tenant-session",
      actorUserId: "admin-a",
      eventType: "capability_shelf.reorder",
      targetKind: "capability_shelf_order",
      targetId: "tenant-session",
      detail: {
        before: ["feature:web_search"],
        after: ["mcp:01JQMZ8K3N4P5Q6R7S8T9VWX01"],
      },
    });
    await expect(response.json()).resolves.toMatchObject({
      data: { orderedCapabilityIds: ["mcp:01JQMZ8K3N4P5Q6R7S8T9VWX01"] },
    });
  });

  it("adds a reviewed portable item to the shelf without touching a capability pack", async () => {
    const { POST } = await import("../route");
    const response = await POST(
      request(
        { capabilityId: "expert:01JQMZ8K3N4P5Q6R7S8T9VWX01" },
        "POST",
      ),
    );

    expect(response.status).toBe(200);
    expect(mocks.requireAdminScope).toHaveBeenCalledWith(["provider:update"]);
    expect(mocks.addCapabilityToShelf).toHaveBeenCalledWith(
      "tenant-session",
      "expert:01JQMZ8K3N4P5Q6R7S8T9VWX01",
    );
    expect(mocks.insertAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "capability_shelf.add" }),
    );
    await expect(response.json()).resolves.toMatchObject({
      data: {
        orderedCapabilityIds: [
          "feature:web_search",
          "expert:01JQMZ8K3N4P5Q6R7S8T9VWX01",
        ],
      },
    });
  });

  it("removes a shelf item atomically and accepts a query-string DELETE", async () => {
    const { DELETE } = await import("../route");
    const response = await DELETE(
      new Request(
        "https://admin.example.invalid/api/admin/capability-shelf-order?capabilityId=expert%3A01JQMZ8K3N4P5Q6R7S8T9VWX01",
        { method: "DELETE" },
      ),
    );

    expect(response.status).toBe(200);
    expect(mocks.removeCapabilityFromShelf).toHaveBeenCalledWith(
      "tenant-session",
      "expert:01JQMZ8K3N4P5Q6R7S8T9VWX01",
    );
    expect(mocks.insertAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "capability_shelf.remove" }),
    );
    await expect(response.json()).resolves.toMatchObject({
      data: { orderedCapabilityIds: ["feature:web_search"] },
    });
  });

  it.each(["POST", "DELETE"])(
    "maps %s membership validation failures to 400 without auditing",
    async (method) => {
      const validationError = new mocks.CapabilityShelfMembershipValidationError(
        "portable item is not published",
      );
      if (method === "POST") mocks.addCapabilityToShelf.mockRejectedValueOnce(validationError);
      else mocks.removeCapabilityFromShelf.mockRejectedValueOnce(validationError);
      const { POST, DELETE } = await import("../route");
      const response = method === "POST"
        ? await POST(request({ capabilityId: "feature:web_search" }, "POST"))
        : await DELETE(request({ capabilityId: "feature:web_search" }, "DELETE"));

      expect(response.status).toBe(400);
      expect(mocks.insertAuditEvent).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["missing capabilityIds", {}],
    ["non-array capabilityIds", { capabilityIds: "feature:web_search" }],
    ["non-string id", { capabilityIds: [1] }],
  ])("rejects %s without writing or auditing", async (_label, body) => {
    const validationError = new mocks.CapabilityShelfOrderValidationError("invalid order");
    mocks.normalizeCapabilityShelfOrder.mockImplementationOnce(() => {
      throw validationError;
    });
    const { PUT } = await import("../route");
    const response = await PUT(request(body));

    expect(response.status).toBe(400);
    expect(mocks.replaceCapabilityShelfOrder).not.toHaveBeenCalled();
    expect(mocks.insertAuditEvent).not.toHaveBeenCalled();
  });

  it("rejects an order larger than the server limit", async () => {
    const { PUT } = await import("../route");
    const response = await PUT(
      request({ capabilityIds: Array.from({ length: 1001 }, () => "feature:web_search") }),
    );

    expect(response.status).toBe(400);
    expect(mocks.normalizeCapabilityShelfOrder).not.toHaveBeenCalled();
    expect(mocks.replaceCapabilityShelfOrder).not.toHaveBeenCalled();
  });

  it("does not read or write when the admin lacks the required scope", async () => {
    mocks.requireAdminScope
      .mockResolvedValueOnce({
        ok: false,
        response: new Response(JSON.stringify({ code: "40300" }), { status: 403 }),
      })
      .mockResolvedValueOnce({
        ok: false,
        response: new Response(JSON.stringify({ code: "40300" }), { status: 403 }),
      });
    const { GET, PUT } = await import("../route");

    expect((await GET()).status).toBe(403);
    expect((await PUT(request({ capabilityIds: [] }))).status).toBe(403);
    expect(mocks.getCapabilityShelfOrder).not.toHaveBeenCalled();
    expect(mocks.replaceCapabilityShelfOrder).not.toHaveBeenCalled();
    expect(mocks.insertAuditEvent).not.toHaveBeenCalled();
  });

  it("keeps a successful response when the follow-up audit fails", async () => {
    mocks.insertAuditEvent.mockRejectedValueOnce(new Error("audit unavailable"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const { PUT } = await import("../route");
      const response = await PUT(request({ capabilityIds: [] }));
      expect(response.status).toBe(200);
      expect(mocks.replaceCapabilityShelfOrder).toHaveBeenCalledOnce();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("returns a server error and skips audit when persistence fails", async () => {
    mocks.replaceCapabilityShelfOrder.mockRejectedValueOnce(new Error("database unavailable"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const { PUT } = await import("../route");
      const response = await PUT(request({ capabilityIds: [] }));
      expect(response.status).toBe(500);
      expect(mocks.insertAuditEvent).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });
});
