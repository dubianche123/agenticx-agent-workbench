import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetSupportProposalsForTests,
  consumeSupportProposal,
  createSupportProposal,
  ProposalActorMismatchError,
  ProposalBusyError,
  ProposalNotFoundError,
} from "./proposals";
import type { SupportOperation } from "./types";

const operation: SupportOperation = {
  kind: "quota",
  tenantId: "tenant-a",
  actorUserId: "admin-a",
  targetUserId: "member-a",
  expected: {
    updatedAt: "2026-09-09T00:00:00.000Z",
    personalRule: null,
    targetRoleCodes: ["member"],
    roleCode: "member",
    inheritedRule: null,
  },
  desired: { inherit: false, monthlyTokens: 1_000 },
};

function proposal(now = Date.now()) {
  return createSupportProposal(
    operation,
    {
      title: "调整成员额度",
      changes: [{ label: "月度额度", before: "无个人规则", after: "1000" }],
    },
    now,
  );
}

describe("admin support proposal lifecycle", () => {
  beforeEach(() => {
    __resetSupportProposalsForTests();
    vi.useRealTimers();
  });

  it("binds a preview to its tenant and administrator, then permits one confirmation", async () => {
    const created = proposal();
    const handler = vi.fn(async () => "applied");

    await expect(
      consumeSupportProposal(created.id, { tenantId: "tenant-a", userId: "admin-a" }, handler),
    ).resolves.toBe("applied");
    expect(handler).toHaveBeenCalledWith(operation, expect.objectContaining({ id: created.id }));
    await expect(
      consumeSupportProposal(created.id, { tenantId: "tenant-a", userId: "admin-a" }, handler),
    ).rejects.toBeInstanceOf(ProposalNotFoundError);
  });

  it("rejects cross-tenant or cross-administrator confirmation without consuming the owner's preview", async () => {
    const created = proposal();
    await expect(
      consumeSupportProposal(created.id, { tenantId: "tenant-b", userId: "admin-a" }, async () => "bad"),
    ).rejects.toBeInstanceOf(ProposalActorMismatchError);
    await expect(
      consumeSupportProposal(created.id, { tenantId: "tenant-a", userId: "admin-b" }, async () => "bad"),
    ).rejects.toBeInstanceOf(ProposalActorMismatchError);
    await expect(
      consumeSupportProposal(created.id, { tenantId: "tenant-a", userId: "admin-a" }, async () => "owner"),
    ).resolves.toBe("owner");
  });

  it("serializes concurrent confirmation and consumes the preview even if the write fails", async () => {
    const created = proposal();
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = consumeSupportProposal(
      created.id,
      { tenantId: "tenant-a", userId: "admin-a" },
      async () => {
        await waiting;
        throw new Error("write failed");
      },
    );
    await expect(
      consumeSupportProposal(created.id, { tenantId: "tenant-a", userId: "admin-a" }, async () => "second"),
    ).rejects.toBeInstanceOf(ProposalBusyError);
    release();
    await expect(first).rejects.toThrow("write failed");
    await expect(
      consumeSupportProposal(created.id, { tenantId: "tenant-a", userId: "admin-a" }, async () => "retry"),
    ).rejects.toBeInstanceOf(ProposalNotFoundError);
  });

  it("expires previews after the bounded five-minute lifetime", async () => {
    vi.useFakeTimers();
    const createdAt = new Date("2026-09-09T00:00:00.000Z").getTime();
    vi.setSystemTime(createdAt);
    const created = proposal(createdAt);
    vi.setSystemTime(createdAt + 5 * 60 * 1000 + 1);

    await expect(
      consumeSupportProposal(created.id, { tenantId: "tenant-a", userId: "admin-a" }, async () => "late"),
    ).rejects.toBeInstanceOf(ProposalNotFoundError);
  });
});
