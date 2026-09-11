import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAdminScope: vi.fn(),
  getSkill: vi.fn(),
  preflightSkillBundle: vi.fn(),
  updateSkill: vi.fn(),
}));

vi.mock("../../../../../../lib/admin-auth", () => ({
  requireAdminScope: (...args: unknown[]) => mocks.requireAdminScope(...args),
}));
vi.mock("../../../../../../lib/capability-packs-store", () => ({
  getSkill: (...args: unknown[]) => mocks.getSkill(...args),
  updateSkill: (...args: unknown[]) => mocks.updateSkill(...args),
}));
vi.mock("@agenticx/iam-core", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    preflightSkillBundle: (...args: unknown[]) => mocks.preflightSkillBundle(...args),
  };
});

import { PATCH } from "../route";

const SKILL_ID = "01JQMZ8K3N4P5Q6R7S8T9VWXY2";
const params = Promise.resolve({ id: SKILL_ID });

function request(body: unknown): Request {
  return new Request(`https://admin.example.com/api/admin/skills/${SKILL_ID}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("PATCH /api/admin/skills/:id", () => {
  beforeEach(() => {
    mocks.requireAdminScope.mockReset().mockResolvedValue({
      ok: true,
      session: { tenantId: "tenant-a", userId: "admin-a" },
    });
    mocks.getSkill.mockReset().mockResolvedValue({
      id: SKILL_ID,
      tenantId: "tenant-a",
      bundleUri: "https://cdn.example.invalid/research-1.0.0.tgz",
      bundleDigest: "a".repeat(64),
      version: "1.0.0",
    });
    mocks.preflightSkillBundle.mockReset().mockResolvedValue({
      bundleUri: "https://cdn.example.invalid/research-2.0.0.tgz",
      bundleDigest: "b".repeat(64),
      size: 20,
      contentType: "text/plain",
    });
    mocks.updateSkill.mockReset().mockResolvedValue({ id: SKILL_ID, scanVerdict: null });
  });

  it("passes bundle identity fields to the store and never accepts scan metadata", async () => {
    const response = await PATCH(
      request({
        version: "2.0.0",
        bundleUri: "https://cdn.example.invalid/research-2.0.0.tgz",
        bundleDigest: "b".repeat(64),
        requiredCapabilities: ["mcp:01JQMZ8K3N4P5Q6R7S8T9VWXYZ"],
        scanVerdict: "safe",
        scanFindings: [{ rule: "ignored" }],
      }),
      { params },
    );

    expect(response.status).toBe(200);
    expect(mocks.updateSkill).toHaveBeenCalledWith(
      "tenant-a",
      SKILL_ID,
      expect.objectContaining({
        version: "2.0.0",
        bundleUri: "https://cdn.example.invalid/research-2.0.0.tgz",
        bundleDigest: "b".repeat(64),
        requiredCapabilities: ["mcp:01JQMZ8K3N4P5Q6R7S8T9VWXYZ"],
      }),
    );
    const forwarded = mocks.updateSkill.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(forwarded).not.toHaveProperty("scanVerdict");
    expect(forwarded).not.toHaveProperty("scanFindings");
    expect(mocks.preflightSkillBundle).toHaveBeenCalledWith(
      {
        bundleUri: "https://cdn.example.invalid/research-2.0.0.tgz",
        bundleDigest: "b".repeat(64),
      },
      expect.objectContaining({ nodeEnv: expect.any(String) }),
    );
  });

  it("does not write when the merged bundle fails preflight", async () => {
    mocks.preflightSkillBundle.mockRejectedValue(new Error("bundle unreachable"));
    const response = await PATCH(
      request({ bundleUri: "https://cdn.example.invalid/research-2.0.0.tgz" }),
      { params },
    );
    expect(response.status).toBe(400);
    expect(mocks.updateSkill).not.toHaveBeenCalled();
  });

  it("validates the existing half when only the digest is patched", async () => {
    const response = await PATCH(
      request({ bundleDigest: "b".repeat(64) }),
      { params },
    );
    expect(response.status).toBe(200);
    expect(mocks.preflightSkillBundle).toHaveBeenCalledWith(
      {
        bundleUri: "https://cdn.example.invalid/research-1.0.0.tgz",
        bundleDigest: "b".repeat(64),
      },
      expect.any(Object),
    );
  });

  it("does not fetch the existing bundle for unrelated metadata updates", async () => {
    const response = await PATCH(request({ description: "updated description" }), { params });
    expect(response.status).toBe(200);
    expect(mocks.preflightSkillBundle).not.toHaveBeenCalled();
  });

  it("does not re-fetch an unchanged bundle included by a full draft save", async () => {
    const response = await PATCH(
      request({
        displayName: "Research",
        description: "updated description",
        version: "1.0.0",
        bundleUri: "https://cdn.example.invalid/research-1.0.0.tgz",
        bundleDigest: "a".repeat(64),
        status: "active",
      }),
      { params },
    );
    expect(response.status).toBe(200);
    expect(mocks.preflightSkillBundle).not.toHaveBeenCalled();
    expect(mocks.updateSkill).toHaveBeenCalledWith(
      "tenant-a",
      SKILL_ID,
      expect.objectContaining({
        bundleUri: "https://cdn.example.invalid/research-1.0.0.tgz",
        bundleDigest: "a".repeat(64),
      }),
    );
  });
});
