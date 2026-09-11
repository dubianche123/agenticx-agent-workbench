import { describe, expect, it } from "vitest";
import { isCompletedAssistantForFeedback } from "./feedback-message-completion";

describe("feedback assistant completion", () => {
  it("uses the durable completion markers before allowing a vote", () => {
    expect(
      isCompletedAssistantForFeedback({ id: "a", role: "assistant", metadata: { turn_terminal: true } }),
    ).toBe(true);
    expect(
      isCompletedAssistantForFeedback({ id: "a", role: "assistant", metadata: { turn_terminal: false } }),
    ).toBe(false);
    expect(
      isCompletedAssistantForFeedback({ id: "a", role: "assistant", metadata: { source: "interrupted-partial" } }),
    ).toBe(false);
    expect(
      isCompletedAssistantForFeedback({ id: "a", role: "assistant", metadata: { status: "partial" } }),
    ).toBe(false);
    expect(
      isCompletedAssistantForFeedback({ id: "a", role: "assistant", metadata: { status: "completed" } }),
    ).toBe(true);
  });

  it("rejects local stop and group interruption markers after refresh", () => {
    const interruptedMarkers = [
      { partial: true },
      { partial: "partial" },
      { interrupted: true },
      { interrupted: "interrupted" },
      { source: "desktop_group_interrupt" },
      { kind: "group_interrupted_partial" },
      { kind: "turn_interrupted" },
      { source: "barge-in" },
      { cause: "user_interrupt" },
    ];
    for (const metadata of interruptedMarkers) {
      expect(isCompletedAssistantForFeedback({ id: "a", role: "assistant", metadata })).toBe(false);
    }
  });

  it("rejects backend truncated finals even when turn_terminal is true", () => {
    expect(
      isCompletedAssistantForFeedback({
        id: "a",
        role: "assistant",
        metadata: { turn_terminal: true, terminal_reason: "interrupted" },
      }),
    ).toBe(false);
    expect(
      isCompletedAssistantForFeedback({
        id: "a",
        role: "assistant",
        metadata: { turn_terminal: true, kind: "suspected_truncated_final" },
      }),
    ).toBe(false);
    expect(
      isCompletedAssistantForFeedback({
        id: "a",
        role: "assistant",
        metadata: { turn_terminal: true, terminal_reason: "suspected_truncated_final" },
      }),
    ).toBe(false);
  });

  it("keeps ordinary completed reasons eligible", () => {
    expect(
      isCompletedAssistantForFeedback({
        id: "a",
        role: "assistant",
        metadata: { turn_terminal: true, terminal_reason: "completed" },
      }),
    ).toBe(true);
  });
});
