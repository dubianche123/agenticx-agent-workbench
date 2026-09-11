import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveDesktopIdentity: vi.fn(),
  isPlatformFeatureAllowedOnSurface: vi.fn(),
  insertAuditEvent: vi.fn(),
}));

vi.mock("../../../../../../lib/desktop-auth", () => ({
  resolveDesktopIdentity: mocks.resolveDesktopIdentity,
}));
vi.mock("../../../../../../lib/capability-packs-reader", () => ({
  isPlatformFeatureAllowedOnSurface: mocks.isPlatformFeatureAllowedOnSurface,
}));
vi.mock("@agenticx/iam-core", () => ({
  insertAuditEvent: mocks.insertAuditEvent,
}));

import { POST } from "../route";

function request(body: Record<string, unknown>) {
  return new Request("https://portal.example.invalid/api/desktop/attachment-routing/override", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/desktop/attachment-routing/override", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveDesktopIdentity.mockResolvedValue({
      userId: "user-1",
      tenantId: "tenant-1",
      deptId: "dept-1",
      email: "user@example.invalid",
    });
    mocks.isPlatformFeatureAllowedOnSurface.mockResolvedValue(true);
    mocks.insertAuditEvent.mockResolvedValue(undefined);
  });

  it("records the authorized public choice without storing filenames", async () => {
    const response = await POST(request({
      sessionId: "session-1",
      currentModel: "cloud/glm-5.2",
      privateTarget: "qwen-local/qwen3.8",
      attachmentNames: ["secret-budget.DOCX", "deck.pptx"],
    }));

    expect(response.status).toBe(200);
    expect(mocks.insertAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "tenant-1",
        actorUserId: "user-1",
        eventType: "attachment_routing.public_override",
        targetId: "session-1",
        detail: {
          surface: "desktop",
          decision: "public",
          recommendedRoute: "private",
          privateRouteAccepted: false,
          requestedModel: "cloud/glm-5.2",
          privateTarget: "qwen-local/qwen3.8",
          attachmentCount: 2,
          attachmentExtensions: [".docx", ".pptx"],
        },
      }),
    );
    expect(JSON.stringify(mocks.insertAuditEvent.mock.calls[0]?.[0])).not.toContain(
      "secret-budget",
    );
  });

  it("audits base extensions for referenced attachment keys", async () => {
    const response = await POST(request({
      sessionId: "session-1",
      currentModel: "cloud/glm-5.2",
      privateTarget: "hc0818-glm-private/glm-5.2",
      attachmentNames: [
        "/tmp/report.PDF:3-5",
        "C:\\Users\\demo\\book.XLSX#Sheet1!A1",
        "page.html:snippet-*",
      ],
    }));

    expect(response.status).toBe(200);
    expect(mocks.insertAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.objectContaining({
          attachmentExtensions: [".pdf", ".xlsx"],
        }),
      }),
    );
  });

  it("rejects the request unless both capability-pack grants are enabled", async () => {
    mocks.isPlatformFeatureAllowedOnSurface.mockImplementation(
      async (_tenantId: string, feature: string) => feature === "attachment_routing",
    );
    const response = await POST(request({
      sessionId: "session-1",
      currentModel: "cloud/glm-5.2",
      privateTarget: "qwen-local/qwen3.8",
      attachmentNames: ["report.docx"],
    }));
    expect(response.status).toBe(403);
    expect(mocks.insertAuditEvent).not.toHaveBeenCalled();
  });

  it("fails closed when the audit event cannot be written", async () => {
    mocks.insertAuditEvent.mockRejectedValue(new Error("database unavailable"));
    const response = await POST(request({
      sessionId: "session-1",
      currentModel: "cloud/glm-5.2",
      privateTarget: "qwen-local/qwen3.8",
      attachmentNames: ["report.docx"],
    }));
    expect(response.status).toBe(503);
  });

  it("requires an authenticated desktop identity", async () => {
    mocks.resolveDesktopIdentity.mockResolvedValue(null);
    const response = await POST(request({
      sessionId: "session-1",
      currentModel: "cloud/glm-5.2",
      privateTarget: "qwen-local/qwen3.8",
    }));
    expect(response.status).toBe(401);
  });
});
