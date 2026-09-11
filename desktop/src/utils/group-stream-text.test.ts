import { describe, expect, it } from "vitest";
import {
  isGroupStreamMessageId,
  shouldResetGroupStreamOnProgress,
  visibleGroupStreamBody,
} from "./group-stream-text";

describe("group-stream-text", () => {
  it("shows only live answer text", () => {
    expect(visibleGroupStreamBody("许可证是 MIT。")).toBe("许可证是 MIT。");
    expect(visibleGroupStreamBody("<think>先想一下")).toBe("");
    expect(visibleGroupStreamBody("<think>先想</think>许可证是 MIT。")).toBe("许可证是 MIT。");
    expect(visibleGroupStreamBody("__SK")).toBe("");
    expect(visibleGroupStreamBody("__SKIP__")).toBe("");
  });

  it("resets a partial answer before a tool call", () => {
    expect(shouldResetGroupStreamOnProgress("calling")).toBe(true);
    expect(shouldResetGroupStreamOnProgress("done")).toBe(false);
  });

  it("recognizes per-member stream rows", () => {
    expect(isGroupStreamMessageId("__group_stream__:a1")).toBe(true);
    expect(isGroupStreamMessageId("__stream__")).toBe(false);
  });
});
