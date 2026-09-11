import { describe, expect, it, vi } from "vitest";
import { SqlActionStore } from "../sql-store";
import type { ActionOperation, ActionStoreTransaction } from "../types";

function operation(status: ActionOperation["status"]): Record<string, unknown> {
  const now = new Date("2026-01-01T00:00:00.000Z");
  return {
    id: "01J00000000000000000000000",
    tenantId: "tenant-a",
    sessionId: "session-a",
    actorUserId: "user-a",
    agentPrincipalId: "agent-a",
    representedUserId: "user-a",
    actionId: "member.write",
    actionVersion: 1,
    effect: "mutation",
    permissionMode: "ask",
    idempotencyKey: "write-1",
    argumentsHash: "hash",
    arguments: {},
    targets: [],
    beforeState: null,
    afterState: null,
    expectedVersions: null,
    authorizationSnapshot: {},
    authorizationVersion: "v1",
    runId: null,
    status,
    proposal: null,
    result: null,
    errorCode: null,
    errorMessage: null,
    confirmationExpiresAt: null,
    expiresAt: new Date(now.getTime() + 60_000),
    confirmedByUserId: null,
    executedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

function transactionWithUpdateResult(affectedRows: number): {
  transaction: ActionStoreTransaction;
  update: ReturnType<typeof vi.fn>;
  select: ReturnType<typeof vi.fn>;
} {
  const update = vi.fn(() => ({
    set: vi.fn(() => ({
      where: vi.fn(async () => [{ affectedRows }, []]),
    })),
  }));
  const select = vi.fn(() => ({
    from: () => ({
      where: () => ({
        limit: async () => [operation("succeeded")],
      }),
    }),
  }));
  const raw = { update, select };
  return { transaction: { dialect: "mysql", raw }, update, select };
}

describe("SqlActionStore MySQL CAS result handling", () => {
  it.each([
    { affectedRows: 0, expected: null },
    { affectedRows: 1, expected: "succeeded" },
  ])("uses ResultSetHeader.affectedRows=$affectedRows as the CAS result", async ({ affectedRows, expected }) => {
    const { transaction, update, select } = transactionWithUpdateResult(affectedRows);
    const result = await new SqlActionStore().updateOperationIfStatus(
      "tenant-a",
      "01J00000000000000000000000",
      ["executing"],
      { status: "succeeded", result: { ok: true } },
      transaction,
    );

    expect(result?.status ?? null).toBe(expected);
    expect(update).toHaveBeenCalledOnce();
    if (affectedRows === 0) expect(select).not.toHaveBeenCalled();
    else expect(select).toHaveBeenCalledOnce();
  });
});
