import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAdminSomeScope: vi.fn(),
  buildAuditActor: vi.fn(),
  queryAdminFeedback: vi.fn(),
}));

vi.mock("../../../../../lib/admin-auth", () => ({
  requireAdminSomeScope: mocks.requireAdminSomeScope,
}));
vi.mock("../../../../../lib/audit-service", () => ({ buildAuditActor: mocks.buildAuditActor }));
vi.mock("../../../../../lib/feedback-query", () => ({
  FEEDBACK_SOURCES: ["web", "desktop"],
  queryAdminFeedback: mocks.queryAdminFeedback,
}));

import { GET } from "../route";

const EMPTY = {
  summary: {
    total: 0,
    likes: 0,
    dislikes: 0,
    positive_rate: null,
    eligible_messages: 0,
    feedback_rate: null,
    feedback_rate_reason: null,
  },
  trends: [],
  by_source: [],
  by_model: [],
  by_department: [],
  items: [],
  total: 0,
};

describe("GET /api/admin/feedback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.queryAdminFeedback.mockResolvedValue(EMPTY);
  });

  it("forces a department reader into their own aggregate-only scope", async () => {
    mocks.requireAdminSomeScope.mockResolvedValue({
      ok: true,
      session: { tenantId: "tenant-a", userId: "admin-a", email: "admin@example.com" },
      scopes: ["audit:read:dept"],
    });
    mocks.buildAuditActor.mockResolvedValue({ tenantId: "tenant-a", userId: "admin-a", deptId: "dept-a", scopes: ["audit:read:dept"] });

    const response = await GET(new Request("http://localhost/api/admin/feedback?department_id=dept-other"));
    expect(response.status).toBe(200);
    expect(mocks.queryAdminFeedback).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: "tenant-a",
      departmentId: "dept-a",
      detailsVisible: false,
    }));
    const body = await response.json();
    expect(body.data).toMatchObject({ visibility: "department", details_visible: false, department_id: "dept-a" });
  });

  it("allows an all-tenant auditor to request safe detail rows", async () => {
    mocks.requireAdminSomeScope.mockResolvedValue({
      ok: true,
      session: { tenantId: "tenant-a", userId: "admin-a", email: "admin@example.com" },
      scopes: ["audit:read:all"],
    });
    mocks.buildAuditActor.mockResolvedValue({ tenantId: "tenant-a", userId: "admin-a", deptId: null, scopes: ["audit:read:all"] });

    const response = await GET(new Request("http://localhost/api/admin/feedback?feedback_type=dislike&model=glm&provider=provider-a&limit=50"));
    expect(response.status).toBe(200);
    expect(mocks.queryAdminFeedback).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: "tenant-a",
      feedbackType: "dislike",
      model: "glm",
      provider: "provider-a",
      limit: 50,
      detailsVisible: true,
    }));
  });

  it("passes a supported feedback source filter to the query", async () => {
    mocks.requireAdminSomeScope.mockResolvedValue({
      ok: true,
      session: { tenantId: "tenant-a", userId: "admin-a", email: "admin@example.com" },
      scopes: ["audit:read:all"],
    });
    mocks.buildAuditActor.mockResolvedValue({ tenantId: "tenant-a", userId: "admin-a", deptId: null, scopes: ["audit:read:all"] });

    const response = await GET(new Request("http://localhost/api/admin/feedback?source=desktop"));
    expect(response.status).toBe(200);
    expect(mocks.queryAdminFeedback).toHaveBeenCalledWith(expect.objectContaining({ source: "desktop" }));
  });

  it("rejects an unsupported feedback source before querying", async () => {
    mocks.requireAdminSomeScope.mockResolvedValue({
      ok: true,
      session: { tenantId: "tenant-a", userId: "admin-a", email: "admin@example.com" },
      scopes: ["audit:read:all"],
    });
    const response = await GET(new Request("http://localhost/api/admin/feedback?source=mobile"));
    expect(response.status).toBe(400);
    expect(mocks.queryAdminFeedback).not.toHaveBeenCalled();
  });

  it("rejects invalid filters before querying", async () => {
    mocks.requireAdminSomeScope.mockResolvedValue({
      ok: true,
      session: { tenantId: "tenant-a", userId: "admin-a", email: "admin@example.com" },
      scopes: ["audit:read:all"],
    });
    const response = await GET(new Request("http://localhost/api/admin/feedback?feedback_type=maybe"));
    expect(response.status).toBe(400);
    expect(mocks.queryAdminFeedback).not.toHaveBeenCalled();
  });

  it("preserves authentication failures", async () => {
    mocks.requireAdminSomeScope.mockResolvedValue({
      ok: false,
      response: new Response(null, { status: 403 }),
    });
    const response = await GET(new Request("http://localhost/api/admin/feedback"));
    expect(response.status).toBe(403);
    expect(mocks.queryAdminFeedback).not.toHaveBeenCalled();
  });

  it("does not expose the raw database error in a 500 response", async () => {
    mocks.requireAdminSomeScope.mockResolvedValue({
      ok: true,
      session: { tenantId: "tenant-a", userId: "admin-a", email: "admin@example.com" },
      scopes: ["audit:read:all"],
    });
    mocks.buildAuditActor.mockResolvedValue({
      tenantId: "tenant-a",
      userId: "admin-a",
      deptId: null,
      scopes: ["audit:read:all"],
    });
    mocks.queryAdminFeedback.mockRejectedValue(new Error("password=super-secret database failure"));

    const response = await GET(new Request("http://localhost/api/admin/feedback"));
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toEqual({ code: "50002", message: "反馈查询暂时不可用" });
    expect(JSON.stringify(body)).not.toContain("super-secret");
  });

  it("also hides actor lookup failures", async () => {
    mocks.requireAdminSomeScope.mockResolvedValue({
      ok: true,
      session: { tenantId: "tenant-a", userId: "admin-a", email: "admin@example.com" },
      scopes: ["audit:read:all"],
    });
    mocks.buildAuditActor.mockRejectedValue(new Error("database password=actor-secret"));

    const response = await GET(new Request("http://localhost/api/admin/feedback"));
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toEqual({ code: "50002", message: "反馈查询暂时不可用" });
    expect(JSON.stringify(body)).not.toContain("actor-secret");
  });
});
