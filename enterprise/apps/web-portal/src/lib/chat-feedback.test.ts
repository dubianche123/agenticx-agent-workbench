import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createMysqlDb: vi.fn(),
  getIamDb: vi.fn(),
  resolveDatabaseConfig: vi.fn(),
}));

vi.mock("@agenticx/iam-core", () => ({
  createMysqlDb: (...args: unknown[]) => mocks.createMysqlDb(...args),
  getIamDb: (...args: unknown[]) => mocks.getIamDb(...args),
  resolveDatabaseConfig: (...args: unknown[]) => mocks.resolveDatabaseConfig(...args),
}));

import {
  ChatFeedbackTargetNotFoundError,
  deleteChatMessageFeedback,
  listChatMessageFeedback,
} from "./chat-feedback";

const actor = {
  tenantId: "01J00000000000000000000001",
  userId: "01J00000000000000000000002",
  departmentId: "01J00000000000000000000003",
};
const sessionId = "01J00000000000000000000004";
const foreignSessionMessageId = "01J00000000000000000000005";
const foreignUserMessageId = "01J00000000000000000000006";
const incompleteMessageId = "01J00000000000000000000007";

function queryDb(results: unknown[][]) {
  const queue = [...results];
  const select = vi.fn(() => {
    const result = queue.shift() ?? [];
    const chain: Record<string, any> = {};
    for (const method of ["from", "where", "orderBy", "groupBy"] as const) {
      chain[method] = vi.fn(() => chain);
    }
    chain.limit = vi.fn(async () => result);
    chain.then = (
      resolve: (value: unknown[]) => unknown,
      reject?: (reason: unknown) => unknown,
    ) => Promise.resolve(result).then(resolve, reject);
    return chain;
  });
  return { select };
}

describe("chat feedback list authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveDatabaseConfig.mockReturnValue({
      dialect: "postgresql",
      url: "postgresql://example.invalid/agenticx",
    });
  });

  it.each([
    ["a message from another session", foreignSessionMessageId],
    ["a message owned by another user", foreignUserMessageId],
  ])("rejects a requested %s before aggregate counts run", async (_label, messageId) => {
    // Session ownership succeeds, but the requested id is not an assistant
    // message owned by this actor in that exact session.
    const db = queryDb([
      [{ id: sessionId }],
      [],
      [],
    ]);
    mocks.getIamDb.mockReturnValue(db);

    await expect(
      listChatMessageFeedback({ actor, sessionId, messageIds: [messageId] }),
    ).rejects.toBeInstanceOf(ChatFeedbackTargetNotFoundError);
    expect(db.select).toHaveBeenCalledTimes(3);
  });

  it.each(["streaming", "failed"] as const)(
    "rejects a %s assistant message as a feedback target",
    async (status) => {
      const db = queryDb([[{
        id: incompleteMessageId,
        role: "assistant",
        status,
      }]]);
      mocks.getIamDb.mockReturnValue(db);

      await expect(
        deleteChatMessageFeedback({ actor, sessionId, messageId: incompleteMessageId }),
      ).rejects.toBeInstanceOf(ChatFeedbackTargetNotFoundError);
    },
  );
});
