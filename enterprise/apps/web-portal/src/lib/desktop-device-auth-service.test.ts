import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensureDesktopDeviceAuthFresh: vi.fn(),
  verifyDesktopDeviceSecret: vi.fn(),
  claimApprovedDeviceAuth: vi.fn(),
  getDesktopDeviceAuth: vi.fn(),
  getAdminUser: vi.fn(),
  createPat: vi.fn(),
  completeDesktopDeviceAuth: vi.fn(),
  releaseDeviceAuthClaim: vi.fn(),
}));

vi.mock("@agenticx/iam-core", () => ({
  approveDesktopDeviceAuth: vi.fn(),
  cancelDesktopDeviceAuth: vi.fn(),
  initDesktopDeviceAuth: vi.fn(),
  ensureDesktopDeviceAuthFresh: (...args: unknown[]) =>
    mocks.ensureDesktopDeviceAuthFresh(...args),
  verifyDesktopDeviceSecret: (...args: unknown[]) => mocks.verifyDesktopDeviceSecret(...args),
  claimApprovedDeviceAuth: (...args: unknown[]) => mocks.claimApprovedDeviceAuth(...args),
  getDesktopDeviceAuth: (...args: unknown[]) => mocks.getDesktopDeviceAuth(...args),
  getAdminUser: (...args: unknown[]) => mocks.getAdminUser(...args),
  createPat: (...args: unknown[]) => mocks.createPat(...args),
  completeDesktopDeviceAuth: (...args: unknown[]) => mocks.completeDesktopDeviceAuth(...args),
  releaseDeviceAuthClaim: (...args: unknown[]) => mocks.releaseDeviceAuthClaim(...args),
  verifyPat: vi.fn(),
  touchPatLastUsed: vi.fn(),
}));

import { pollDesktopDeviceAuth } from "./desktop-device-auth";

describe("pollDesktopDeviceAuth live user checks", () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
    const approved = {
      deviceId: "device-a",
      deviceName: "Mac",
      status: "approved",
      tenantId: "tenant-a",
      userId: "user-a",
      deptId: "old-dept",
    };
    mocks.ensureDesktopDeviceAuthFresh.mockResolvedValue(approved);
    mocks.verifyDesktopDeviceSecret.mockReturnValue(true);
    mocks.claimApprovedDeviceAuth.mockResolvedValue(approved);
    mocks.getAdminUser.mockResolvedValue({
      id: "user-a",
      tenantId: "tenant-a",
      deptId: "live-dept",
      email: "member@example.com",
      displayName: "成员",
      status: "active",
    });
    mocks.createPat.mockResolvedValue({ token: "agx-pat-token", record: { id: 9 } });
    mocks.completeDesktopDeviceAuth.mockResolvedValue(true);
    mocks.releaseDeviceAuthClaim.mockResolvedValue(undefined);
  });

  it("rejects a locked approved user before creating a PAT", async () => {
    mocks.getAdminUser.mockResolvedValueOnce({ status: "locked" });
    await expect(
      pollDesktopDeviceAuth({ deviceId: "device-a", deviceSecret: "secret" }),
    ).rejects.toThrow("approved user unavailable");
    expect(mocks.createPat).not.toHaveBeenCalled();
  });

  it("issues the PAT against the user's live department", async () => {
    const result = await pollDesktopDeviceAuth({ deviceId: "device-a", deviceSecret: "secret" });
    expect(result.status).toBe("completed");
    expect(mocks.createPat).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: "tenant-a", userId: "user-a", deptId: "live-dept" }),
    );
    if (result.status === "completed") expect(result.user.deptId).toBe("live-dept");
  });

  it("does not repeat the product label when the device uses the default name", async () => {
    const record = {
      deviceId: "device-default",
      deviceName: "AgenticX Ontology Desktop",
      status: "approved" as const,
      tenantId: "tenant-a",
      userId: "user-a",
      deptId: "old-dept",
    };
    mocks.ensureDesktopDeviceAuthFresh.mockResolvedValueOnce(record);
    mocks.claimApprovedDeviceAuth.mockResolvedValueOnce(record);

    const result = await pollDesktopDeviceAuth({
      deviceId: record.deviceId,
      deviceSecret: "secret",
    });

    expect(result.status).toBe("completed");
    expect(mocks.createPat).toHaveBeenCalledWith(
      expect.objectContaining({ name: "AgenticX Ontology Desktop" }),
    );
  });
});
