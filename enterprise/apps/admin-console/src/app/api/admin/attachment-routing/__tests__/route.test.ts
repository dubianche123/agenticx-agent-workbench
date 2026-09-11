import { beforeEach, describe, expect, it, vi } from "vitest";

const requireAdminScope = vi.fn();
const getAttachmentRoutingTenantConfig = vi.fn();
const setAttachmentRoutingTenantConfig = vi.fn();
const insertAuditEvent = vi.fn();

vi.mock("@agenticx/iam-core", () => ({
  insertAuditEvent: (...args: unknown[]) => insertAuditEvent(...args),
}));

vi.mock("../../../../../lib/admin-auth", () => ({
  requireAdminScope: (...args: unknown[]) => requireAdminScope(...args),
}));
vi.mock(
  "../../../../../../../web-portal/src/lib/attachment-routing-config",
  () => ({
    getAttachmentRoutingTenantConfig: (...args: unknown[]) =>
      getAttachmentRoutingTenantConfig(...args),
    setAttachmentRoutingTenantConfig: (...args: unknown[]) =>
      setAttachmentRoutingTenantConfig(...args),
  }),
);

import { GET, PUT } from "../route";

function put(body: unknown) {
  return PUT(
    new Request("http://localhost/api/admin/attachment-routing", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe("/api/admin/attachment-routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireAdminScope.mockResolvedValue({
      ok: true,
      session: { tenantId: "tenant-1", userId: "admin-1" },
    });
    getAttachmentRoutingTenantConfig.mockResolvedValue({ allowPublicOverride: false });
    setAttachmentRoutingTenantConfig.mockImplementation(
      async (_tenantId: string, value: { allowPublicOverride: boolean }) => value,
    );
    insertAuditEvent.mockResolvedValue(undefined);
  });

  it("loads the tenant switch with provider read scope", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(requireAdminScope).toHaveBeenCalledWith(["provider:read"]);
    expect(getAttachmentRoutingTenantConfig).toHaveBeenCalledWith("tenant-1");
  });

  it("persists the switch with provider update scope", async () => {
    const response = await put({ allowPublicOverride: true });
    expect(response.status).toBe(200);
    expect(requireAdminScope).toHaveBeenCalledWith(["provider:update"]);
    expect(getAttachmentRoutingTenantConfig).toHaveBeenCalledWith("tenant-1");
    expect(setAttachmentRoutingTenantConfig).toHaveBeenCalledWith("tenant-1", {
      allowPublicOverride: true,
    });
    expect(insertAuditEvent).toHaveBeenCalledWith({
      tenantId: "tenant-1",
      actorUserId: "admin-1",
      eventType: "attachment_routing.update",
      targetKind: "attachment_routing_config",
      targetId: "tenant-1",
      detail: {
        before: { allowPublicOverride: false },
        after: { allowPublicOverride: true },
      },
    });
  });

  it("does not write or audit an unchanged switch", async () => {
    const response = await put({ allowPublicOverride: false });
    expect(response.status).toBe(200);
    expect(setAttachmentRoutingTenantConfig).not.toHaveBeenCalled();
    expect(insertAuditEvent).not.toHaveBeenCalled();
  });

  it("audits disabling the public-model exception with the reverse transition", async () => {
    getAttachmentRoutingTenantConfig.mockResolvedValueOnce({ allowPublicOverride: true });
    setAttachmentRoutingTenantConfig.mockResolvedValueOnce({ allowPublicOverride: false });
    const response = await put({ allowPublicOverride: false });
    expect(response.status).toBe(200);
    expect(insertAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: {
          before: { allowPublicOverride: true },
          after: { allowPublicOverride: false },
        },
      }),
    );
  });

  it("keeps the successful mutation response when the follow-up audit fails", async () => {
    insertAuditEvent.mockRejectedValueOnce(new Error("audit unavailable"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const response = await put({ allowPublicOverride: true });
      expect(response.status).toBe(200);
      expect(setAttachmentRoutingTenantConfig).toHaveBeenCalledTimes(1);
      expect(insertAuditEvent).toHaveBeenCalledTimes(1);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("returns the configuration error and does not audit when persistence fails", async () => {
    setAttachmentRoutingTenantConfig.mockRejectedValueOnce(new Error("database unavailable"));
    const response = await put({ allowPublicOverride: true });
    expect(response.status).toBe(503);
    expect(insertAuditEvent).not.toHaveBeenCalled();
  });

  it("does not read, write, or audit when the admin lacks the update scope", async () => {
    requireAdminScope.mockResolvedValueOnce({
      ok: false,
      response: new Response(JSON.stringify({ code: "40300" }), { status: 403 }),
    });
    const response = await put({ allowPublicOverride: true });
    expect(response.status).toBe(403);
    expect(getAttachmentRoutingTenantConfig).not.toHaveBeenCalled();
    expect(setAttachmentRoutingTenantConfig).not.toHaveBeenCalled();
    expect(insertAuditEvent).not.toHaveBeenCalled();
  });

  it.each(["true", 1, null, undefined])(
    "rejects a non-boolean switch value: %s",
    async (allowPublicOverride) => {
      const response = await put({ allowPublicOverride });
      expect(response.status).toBe(400);
      expect(setAttachmentRoutingTenantConfig).not.toHaveBeenCalled();
    },
  );
});
