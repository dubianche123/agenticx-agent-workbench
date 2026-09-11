import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  verifyPat: vi.fn(),
  getAdminUser: vi.fn(),
  touchPatLastUsed: vi.fn(),
}));

vi.mock("@agenticx/iam-core", () => ({
  verifyPat: (...args: unknown[]) => mocks.verifyPat(...args),
  getAdminUser: (...args: unknown[]) => mocks.getAdminUser(...args),
  touchPatLastUsed: (...args: unknown[]) => mocks.touchPatLastUsed(...args),
}));

import { DESKTOP_MANAGED_PAT_SCOPES, resolveDesktopIdentity } from "./desktop-auth";

describe("DESKTOP_MANAGED_PAT_SCOPES", () => {
  it("includes workspace:chat and desktop:managed for device tokens", () => {
    expect([...DESKTOP_MANAGED_PAT_SCOPES]).toEqual(["workspace:chat", "desktop:managed"]);
  });
});

describe("resolveDesktopIdentity live revocation", () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
    mocks.verifyPat.mockResolvedValue({
      id: 7,
      tenantId: "tenant-a",
      userId: "user-a",
      deptId: "old-dept",
      scopes: ["desktop:managed"],
    });
    mocks.getAdminUser.mockResolvedValue({
      id: "user-a",
      tenantId: "tenant-a",
      deptId: "live-dept",
      email: "member@example.com",
      displayName: "成员",
      status: "active",
    });
    mocks.touchPatLastUsed.mockResolvedValue(undefined);
  });

  function request() {
    return new Request("https://portal.example.invalid/api/desktop/bootstrap", {
      headers: { authorization: "Bearer agx-pat-valid" },
    });
  }

  it("uses the employee's live department rather than the PAT issuance snapshot", async () => {
    const identity = await resolveDesktopIdentity(request());
    expect(identity?.deptId).toBe("live-dept");
  });

  it.each(["locked", "disabled"])("rejects a %s employee's existing PAT", async (status) => {
    mocks.getAdminUser.mockResolvedValueOnce({
      id: "user-a",
      tenantId: "tenant-a",
      deptId: "live-dept",
      email: "member@example.com",
      displayName: "成员",
      status,
    });
    expect(await resolveDesktopIdentity(request())).toBeNull();
    expect(mocks.touchPatLastUsed).not.toHaveBeenCalled();
  });
});
