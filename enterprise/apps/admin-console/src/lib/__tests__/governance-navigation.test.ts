import { describe, expect, it } from "vitest";

import { governanceHref } from "../governance-navigation";

describe("governanceHref", () => {
  it("preserves legacy filters while selecting the unified tab", () => {
    expect(governanceHref("logs", { trace_id: "trace-a", level: ["error", "warn"] })).toBe(
      "/admin/governance?trace_id=trace-a&level=error&level=warn&tab=logs",
    );
  });

  it("keeps the audit tab as the canonical base route", () => {
    expect(governanceHref("audit", { event_id: "event-a", tab: "logs" })).toBe(
      "/admin/governance?event_id=event-a",
    );
  });
});
