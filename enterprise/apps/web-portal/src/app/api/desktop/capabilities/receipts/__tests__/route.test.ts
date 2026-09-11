import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveDesktopIdentity: vi.fn(),
  listAvailableCapabilitiesForUser: vi.fn(),
  insertCapabilitySyncReceipt: vi.fn(),
  listLatestCapabilitySyncReceipts: vi.fn(),
}));

vi.mock("../../../../../../lib/desktop-auth", () => ({
  resolveDesktopIdentity: (...args: unknown[]) => mocks.resolveDesktopIdentity(...args),
}));
// This route uses only these runtime exports. Avoid importing the complete
// capability reader/IAM packages just to spread their modules into a mock: on
// a cold CI worker that turns the first authorization test into a flaky
// five-second module-load timeout without exercising any additional behavior.
vi.mock("../../../../../../lib/capability-packs-reader", () => ({
  listAvailableCapabilitiesForUser: (...args: unknown[]) =>
    mocks.listAvailableCapabilitiesForUser(...args),
}));
vi.mock("@agenticx/iam-core", () => ({
  desktopDeviceInstanceId: (value: number) => String(value),
  insertCapabilitySyncReceipt: (...args: unknown[]) => mocks.insertCapabilitySyncReceipt(...args),
  listLatestCapabilitySyncReceipts: (...args: unknown[]) =>
    mocks.listLatestCapabilitySyncReceipts(...args),
}));

const SKILL_ID = "skill:01JQMZ8K3N4P5Q6R7S8T9VWXYZ";
const MCP_ID = "mcp:01JQMZ8K3N4P5Q6R7S8T9VWXY0";
const OTHER_ID = "skill:01JQMZ8K3N4P5Q6R7S8T9VWXY1";
const DIGEST = "a".repeat(64);

function identity(overrides: Record<string, unknown> = {}) {
  return {
    userId: "user-a",
    tenantId: "tenant-a",
    deptId: "dept-a",
    email: "a@example.invalid",
    displayName: "A",
    tokenId: 42,
    scopes: ["workspace:chat", "desktop:managed"],
    ...overrides,
  };
}

function capabilities() {
  return [
    {
      id: SKILL_ID,
      kind: "skill" as const,
      name: "research",
      displayName: "Research",
      requires: [],
      version: "2.0.0",
      bundleUri: "https://cdn.example.invalid/research",
      bundleDigest: DIGEST,
      surfaces: ["desktop"],
    },
    {
      id: MCP_ID,
      kind: "mcp" as const,
      name: "tools",
      displayName: "Tools",
      requires: [],
      version: "1.0.0",
      surfaces: ["desktop"],
    },
  ];
}

function receipt(overrides: Record<string, unknown> = {}) {
  return {
    id: "01JQMZ8K3N4P5Q6R7S8T9VWXY2",
    tenantId: "tenant-a",
    userId: "user-a",
    apiTokenId: 42,
    capabilityId: SKILL_ID,
    kind: "skill" as const,
    status: "pending" as const,
    version: "2.0.0",
    digest: DIGEST,
    errorCode: null,
    message: null,
    attemptedAt: new Date().toISOString(),
    appliedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function request(body?: unknown, url = "https://portal.example.invalid/api/desktop/capabilities/receipts") {
  return new Request(url, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("/api/desktop/capabilities/receipts", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.resolveDesktopIdentity.mockReset().mockResolvedValue(identity());
    mocks.listAvailableCapabilitiesForUser.mockReset().mockResolvedValue(capabilities());
    mocks.insertCapabilitySyncReceipt.mockReset().mockImplementation(async (input) => receipt(input));
    mocks.listLatestCapabilitySyncReceipts.mockReset().mockResolvedValue([receipt()]);
  });

  it("requires a managed Desktop PAT scope", async () => {
    mocks.resolveDesktopIdentity.mockResolvedValue(identity({ scopes: ["workspace:chat"] }));
    const { POST } = await import("../route");
    const response = await POST(request({ capabilityId: SKILL_ID, kind: "skill", status: "waiting" }));
    expect(response.status).toBe(403);
    expect(mocks.listAvailableCapabilitiesForUser).not.toHaveBeenCalled();
  });

  it("normalizes waiting/downloading/verifying to pending and derives trusted metadata", async () => {
    const { POST } = await import("../route");
    const response = await POST(request({
      capabilityId: SKILL_ID.toLowerCase(),
      kind: "skill",
      status: "verifying",
      attemptedAt: new Date().toISOString(),
    }));
    expect(response.status).toBe(201);
    expect(mocks.insertCapabilitySyncReceipt).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: "tenant-a",
      userId: "user-a",
      apiTokenId: 42,
      capabilityId: SKILL_ID,
      kind: "skill",
      status: "pending",
      version: "2.0.0",
      digest: DIGEST,
      appliedAt: null,
    }));
    const json = await response.json();
    expect(json.data.receipt.deviceId).toBe("42");
    expect(json.data.receipt).not.toHaveProperty("tenantId");
    expect(json.data.receipt).not.toHaveProperty("userId");
  });

  it("accepts an applied receipt only for the assigned version and digest", async () => {
    const { POST } = await import("../route");
    const response = await POST(request({
      capabilityId: SKILL_ID,
      kind: "skill",
      status: "applied",
      version: "2.0.0",
      digest: DIGEST.toUpperCase(),
      appliedAt: new Date().toISOString(),
    }));
    expect(response.status).toBe(201);
    expect(mocks.insertCapabilitySyncReceipt).toHaveBeenCalledWith(expect.objectContaining({
      status: "applied",
      digest: DIGEST,
      appliedAt: expect.any(Date),
    }));
  });

  it("rejects failed receipts without an error code and rejects digest mismatches", async () => {
    const { POST } = await import("../route");
    const missingError = await POST(request({ capabilityId: SKILL_ID, kind: "skill", status: "failed" }));
    expect(missingError.status).toBe(400);
    const mismatch = await POST(request({
      capabilityId: SKILL_ID,
      kind: "skill",
      status: "failed",
      errorCode: "digest_mismatch",
      digest: "b".repeat(64),
    }));
    expect(mismatch.status).toBe(400);
    expect(mocks.insertCapabilitySyncReceipt).not.toHaveBeenCalled();
  });

  it("rejects unsupported client device fields and unassigned capabilities", async () => {
    const { POST } = await import("../route");
    const unsupported = await POST(request({
      capabilityId: MCP_ID,
      kind: "mcp",
      status: "pending",
      deviceId: "client-controlled",
    }));
    expect(unsupported.status).toBe(400);
    const unassigned = await POST(request({ capabilityId: OTHER_ID, kind: "skill", status: "pending" }));
    expect(unassigned.status).toBe(403);
    expect(mocks.insertCapabilitySyncReceipt).not.toHaveBeenCalled();
  });

  it("returns only current receipts for the effective assigned capability set", async () => {
    mocks.listLatestCapabilitySyncReceipts.mockResolvedValue([
      receipt(),
      receipt({ capabilityId: OTHER_ID }),
    ]);
    const { GET } = await import("../route");
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(mocks.listLatestCapabilitySyncReceipts).toHaveBeenCalledWith({
      tenantId: "tenant-a",
      userId: "user-a",
      apiTokenId: 42,
      capabilityIds: [SKILL_ID, MCP_ID],
    });
    const json = await response.json();
    expect(json.data.receipts).toHaveLength(1);
    expect(json.data.receipts[0].capabilityId).toBe(SKILL_ID);
  });

  it("does not read a receipt for a capability outside the user's assignment", async () => {
    const { GET } = await import("../route");
    const response = await GET(request(undefined, `https://portal.example.invalid/api/desktop/capabilities/receipts?capabilityId=${OTHER_ID}`));
    expect(response.status).toBe(404);
    expect(mocks.listLatestCapabilitySyncReceipts).not.toHaveBeenCalled();
  });

  it("fails closed when assignment resolution is unavailable", async () => {
    mocks.listAvailableCapabilitiesForUser.mockRejectedValue(new Error("database down"));
    const { GET } = await import("../route");
    const response = await GET(request());
    expect(response.status).toBe(503);
    expect(mocks.listLatestCapabilitySyncReceipts).not.toHaveBeenCalled();
  });
});
