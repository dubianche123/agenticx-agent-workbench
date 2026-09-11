import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAdminScope: vi.fn(),
  createSkill: vi.fn(),
  listSkills: vi.fn(),
  preflightSkillBundle: vi.fn(),
}));

vi.mock("../../../../../lib/admin-auth", () => ({
  requireAdminScope: (...args: unknown[]) => mocks.requireAdminScope(...args),
}));
vi.mock("../../../../../lib/capability-packs-store", () => ({
  createSkill: (...args: unknown[]) => mocks.createSkill(...args),
  listSkills: (...args: unknown[]) => mocks.listSkills(...args),
}));
vi.mock("@agenticx/iam-core", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    preflightSkillBundle: (...args: unknown[]) => mocks.preflightSkillBundle(...args),
  };
});

import { POST } from "../route";

const DIGEST = "a".repeat(64);

function request(body: unknown): Request {
  return new Request("https://admin.example.com/api/admin/skills", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/admin/skills", () => {
  beforeEach(() => {
    mocks.requireAdminScope.mockReset().mockResolvedValue({
      ok: true,
      session: { tenantId: "tenant-a", userId: "admin-a" },
    });
    mocks.preflightSkillBundle.mockReset().mockResolvedValue({
      bundleUri: "https://cdn.example.invalid/research.tgz",
      bundleDigest: DIGEST,
      size: 12,
      contentType: "text/plain",
    });
    mocks.createSkill.mockReset().mockResolvedValue({ id: "skill-a" });
  });

  it("preflights the bundle before writing and stores normalized metadata", async () => {
    const response = await POST(request({
      slug: "research",
      bundleUri: "https://cdn.example.invalid/research.tgz",
      bundleDigest: DIGEST.toUpperCase(),
    }));
    expect(response.status).toBe(200);
    expect(mocks.preflightSkillBundle).toHaveBeenCalledWith(
      {
        bundleUri: "https://cdn.example.invalid/research.tgz",
        bundleDigest: DIGEST,
      },
      expect.objectContaining({ nodeEnv: expect.any(String) }),
    );
    expect(mocks.createSkill).toHaveBeenCalledWith("tenant-a", expect.objectContaining({
      bundleUri: "https://cdn.example.invalid/research.tgz",
      bundleDigest: DIGEST,
    }));
  });

  it("does not write when preflight reports a dead URL, digest mismatch, or oversize bundle", async () => {
    for (const error of [
      Object.assign(new Error("dead URL"), { status: 502, code: "unreachable" }),
      Object.assign(new Error("digest mismatch"), { status: 422, code: "digest_mismatch" }),
      Object.assign(new Error("too large"), { status: 413, code: "body_too_large" }),
    ]) {
      mocks.preflightSkillBundle.mockRejectedValueOnce(error);
      const response = await POST(request({
        slug: "research",
        bundleUri: "https://cdn.example.invalid/research.tgz",
        bundleDigest: DIGEST,
      }));
      expect(response.status).toBe(400);
    }
    expect(mocks.createSkill).not.toHaveBeenCalled();
  });

  it("rejects an invalid pair before calling preflight or the store", async () => {
    const response = await POST(request({
      slug: "research",
      bundleUri: "https://cdn.example.invalid/research.tgz",
      bundleDigest: "not-a-sha",
    }));
    expect(response.status).toBe(400);
    expect(mocks.preflightSkillBundle).not.toHaveBeenCalled();
    expect(mocks.createSkill).not.toHaveBeenCalled();
  });
});
