import { describe, expect, it } from "vitest";
import { parseHistoryRows } from "./EnvironmentAssistantPanel";

describe("EnvironmentAssistantPanel history rendering", () => {
  it("removes model reasoning wrappers from assistant history while preserving user text", () => {
    const rows = parseHistoryRows([
      { id: "assistant", role: "assistant", content: "<think>internal plan</think>可见答案" },
      { id: "user", role: "user", content: "用户写的 <think> 标签" },
    ]);

    expect(rows).toEqual([
      { id: "assistant", role: "assistant", content: "可见答案" },
      { id: "user", role: "user", content: "用户写的 <think> 标签" },
    ]);
  });
});
