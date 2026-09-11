import { describe, expect, it } from "vitest";

import {
  computeFeedbackCoverage,
  feedbackCoverageUnavailableReason,
} from "../feedback-query";

describe("feedback coverage semantics", () => {
  it("uses all feedback values when the visible list is filtered to one type", () => {
    // The selected list may contain two likes, while the cohort has five
    // feedback rows in total. Coverage is 5/10, not the like share 2/10.
    expect(
      computeFeedbackCoverage({
        allFeedbackTotal: 5,
        eligibleMessages: 10,
        unavailableReason: null,
      }),
    ).toEqual({
      eligible_messages: 10,
      feedback_rate: 0.5,
      feedback_rate_reason: null,
    });
  });

  it("marks provider and department-filtered denominators unavailable", () => {
    expect(feedbackCoverageUnavailableReason({ provider: "provider-a" })).toBe("provider_filter");
    expect(feedbackCoverageUnavailableReason({ departmentId: "department-a" })).toBe(
      "department_snapshot_mismatch",
    );

    expect(
      computeFeedbackCoverage({
        allFeedbackTotal: 5,
        eligibleMessages: 10,
        unavailableReason: "provider_filter",
      }),
    ).toEqual({
      eligible_messages: null,
      feedback_rate: null,
      feedback_rate_reason: "provider_filter",
    });
  });

  it("never estimates coverage for desktop or mixed-source cohorts", () => {
    expect(feedbackCoverageUnavailableReason({ source: "desktop" })).toBe("desktop_source");
    expect(
      computeFeedbackCoverage({
        allFeedbackTotal: 3,
        eligibleMessages: 10,
        unavailableReason: "desktop_source",
      }),
    ).toEqual({
      eligible_messages: null,
      feedback_rate: null,
      feedback_rate_reason: "desktop_source",
    });
    expect(
      computeFeedbackCoverage({
        allFeedbackTotal: 3,
        eligibleMessages: 10,
        unavailableReason: "mixed_sources",
      }).feedback_rate,
    ).toBeNull();
  });
});
