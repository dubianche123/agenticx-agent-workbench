import { describe, expect, it } from "vitest";

import { withMemberRuleBatch } from "../user-group-member-rules";

describe("withMemberRuleBatch", () => {
  it("writes the same personal rule to each selected member without a group rule", () => {
    const current = { untouched: { limit: 10 }, alice: { limit: 20 } };
    const next = withMemberRuleBatch(current, ["alice", "bob", "bob"], { limit: 100 });

    expect(next).toEqual({
      untouched: { limit: 10 },
      alice: { limit: 100 },
      bob: { limit: 100 },
    });
    expect(current.alice.limit).toBe(20);
  });

  it("removes selected personal rules to restore inheritance", () => {
    expect(
      withMemberRuleBatch(
        { alice: { limit: 20 }, bob: { limit: 30 }, untouched: { limit: 10 } },
        ["alice", "bob"],
        null,
      ),
    ).toEqual({ untouched: { limit: 10 } });
  });
});
