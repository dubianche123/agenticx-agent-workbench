import { describe, expect, it } from "vitest";

import {
  COLLAPSED_SUMMARY_SECTIONS,
  applyPinnedAutoExpand,
  contentDrivenOpenSections,
  exclusiveOpenSections,
} from "./summary-sections";

describe("summary section focus", () => {
  it("opens only the explicitly focused section", () => {
    expect(exclusiveOpenSections("changes")).toEqual({
      ...COLLAPSED_SUMMARY_SECTIONS,
      changes: true,
    });
    expect(exclusiveOpenSections("artifacts")).toEqual({
      ...COLLAPSED_SUMMARY_SECTIONS,
      artifacts: true,
    });
  });

  it("restores overview sections from current content", () => {
    expect(contentDrivenOpenSections({
      todo: true,
      artifacts: false,
      changes: true,
      spawns: false,
      refs: true,
      members: false,
    })).toEqual({
      todo: true,
      artifacts: false,
      changes: true,
      spawns: false,
      refs: true,
      members: false,
    });
  });

  it("does not let unrelated content steal a pinned section", () => {
    const focused = exclusiveOpenSections("changes");
    expect(applyPinnedAutoExpand(focused, "todo", true, "changes")).toBe(focused);
    expect(applyPinnedAutoExpand(focused, "artifacts", true, "changes")).toBe(focused);
  });

  it("keeps the pinned section visible even when it is empty", () => {
    const focused = exclusiveOpenSections("changes");
    expect(applyPinnedAutoExpand(focused, "changes", false, "changes")).toBe(focused);
  });
});
