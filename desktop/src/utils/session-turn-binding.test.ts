import { describe, expect, it } from "vitest";
import type { Message } from "../store";
import { sessionTurnForAssistantMessage } from "./session-turn-binding";
import type { SessionTurn } from "./session-turns";

const turn = (turnId: string, clientTurnId?: string): SessionTurn => ({
  turnId,
  clientTurnId,
  status: "completed",
  createdAt: "",
  canUndo: true,
  files: [],
  artifacts: [],
});

const user = (id: string, clientTurnId?: string): Message => ({
  id,
  role: "user",
  content: id,
  metadata: clientTurnId ? { client_turn_id: clientTurnId } : undefined,
});

const assistant = (id: string, content: string): Message => ({
  id,
  role: "assistant",
  content,
});

describe("session turn binding", () => {
  it("binds each answer to the preceding user's client turn id despite newest-first turns", () => {
    const messages = [
      user("u1", "ctid-1"),
      assistant("a1", "answer one"),
      user("u2", "ctid-2"),
      assistant("a2", "answer two"),
      user("u3", "ctid-3"),
      assistant("a3", "answer three"),
    ];
    const turns = [turn("t3", "ctid-3"), turn("t2", "ctid-2"), turn("t1", "ctid-1")];

    expect(sessionTurnForAssistantMessage(turns, messages[1], messages)?.turnId).toBe("t1");
    expect(sessionTurnForAssistantMessage(turns, messages[3], messages)?.turnId).toBe("t2");
    expect(sessionTurnForAssistantMessage(turns, messages[5], messages)?.turnId).toBe("t3");
  });

  it("does not guess an ordinal target for legacy rows without a client turn id", () => {
    const messages = [
      user("u1"),
      assistant("a1", "legacy answer"),
      user("u2", "ctid-2"),
      assistant("a2", "new answer"),
    ];
    const turns = [turn("t2", "ctid-2"), turn("legacy-turn")];

    expect(sessionTurnForAssistantMessage(turns, messages[1], messages)).toBeNull();
    expect(sessionTurnForAssistantMessage(turns, messages[3], messages)?.turnId).toBe("t2");
  });

  it("does not treat a generic turn id as the authoritative client turn id", () => {
    const messages = [
      {
        ...user("u1"),
        metadata: { turn_id: "t1" },
      },
      assistant("a1", "legacy answer"),
    ];
    expect(sessionTurnForAssistantMessage(
      [turn("t1", "ctid-1")],
      messages[1],
      messages,
    )).toBeNull();
  });

  it("only attaches a card to the final assistant row before the next user", () => {
    const messages = [
      user("u1", "ctid-1"),
      assistant("a1", "tool preface"),
      assistant("a2", "final answer"),
    ];
    const turns = [turn("t1", "ctid-1")];

    expect(sessionTurnForAssistantMessage(turns, messages[1], messages)).toBeNull();
    expect(sessionTurnForAssistantMessage(turns, messages[2], messages)?.turnId).toBe("t1");
  });

  it("rejects a matching client turn from a different displayed session", () => {
    const messages = [
      {
        ...user("u1", "ctid-1"),
        ownerSessionId: "session-a",
      },
      {
        ...assistant("a1", "answer"),
        ownerSessionId: "session-a",
      },
    ];
    expect(sessionTurnForAssistantMessage(
      [{ ...turn("t1", "ctid-1"), sessionId: "session-a" }],
      messages[1],
      messages,
      "session-b",
    )).toBeNull();
    expect(sessionTurnForAssistantMessage(
      [{ ...turn("t1", "ctid-1"), sessionId: "session-a" }],
      messages[1],
      messages,
      "session-a",
    )?.turnId).toBe("t1");
  });
});
