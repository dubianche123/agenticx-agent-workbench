import { describe, expect, it } from "vitest";
import { enqueueFeedbackWrite, feedbackWriteKey } from "./feedback-write-queue";

describe("feedback write queue", () => {
  it("keeps an A → B → A mutation ordered until the old mirror settles", async () => {
    const chains: Record<string, Promise<void>> = {};
    const order: string[] = [];
    const remote: { value: "like" | null } = { value: null };
    let releaseA: (() => void) | undefined;
    const oldMirror = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const key = feedbackWriteKey(0, "session-a", "message-a");
    const keyB = feedbackWriteKey(0, "session-b", "message-b");

    const first = enqueueFeedbackWrite(chains, key, async () => {
      await oldMirror;
      order.push("like");
      remote.value = "like";
    });
    const onB = enqueueFeedbackWrite(chains, keyB, async () => {
      order.push("session-b");
    });
    // B has its own message key. Returning to A reuses A's chain rather than
    // clearing it when the pane changes sessions.
    const second = enqueueFeedbackWrite(chains, key, async () => {
      order.push("clear");
      remote.value = null;
    });

    releaseA?.();
    await Promise.all([first, onB, second]);
    expect(order).toContain("session-b");
    expect(order.indexOf("like")).toBeLessThan(order.indexOf("clear"));
    expect(remote.value).toBeNull();
  });

  it("does not join a mutation from a different authenticated scope", async () => {
    const chains: Record<string, Promise<void>> = {};
    const order: string[] = [];
    let releaseOld: (() => void) | undefined;
    const oldMirror = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    const oldKey = feedbackWriteKey(0, "session-a", "message-a");
    const newKey = feedbackWriteKey(1, "session-a", "message-a");

    const old = enqueueFeedbackWrite(chains, oldKey, async () => {
      await oldMirror;
      order.push("old-scope");
    });
    const next = enqueueFeedbackWrite(chains, newKey, async () => {
      order.push("new-scope");
    });
    await next;
    expect(order).toEqual(["new-scope"]);
    releaseOld?.();
    await old;
    expect(order).toEqual(["new-scope", "old-scope"]);
  });
});
