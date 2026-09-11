import { describe, expect, it } from "vitest";

import {
  capabilityPackVersion,
  nextCapabilityPackUpdatedAt,
  versionedCapabilityPackPatch,
} from "../capability-pack-concurrency";

describe("capability pack optimistic concurrency", () => {
  it("builds the full-set UI payload with the version it was based on", () => {
    expect(
      versionedCapabilityPackPatch("2026-08-28T16:00:00+08:00", {
        capabilityIds: ["feature:web_search"],
        assignmentKeys: ["all"],
        status: "active",
      }),
    ).toEqual({
      expectedUpdatedAt: "2026-08-28T08:00:00.000Z",
      capabilityIds: ["feature:web_search"],
      assignmentKeys: ["all"],
      status: "active",
    });
  });

  it("rejects missing and invalid versions", () => {
    expect(() => capabilityPackVersion(undefined)).toThrow("expectedUpdatedAt is required");
    expect(() => capabilityPackVersion("not-a-date")).toThrow(
      "expectedUpdatedAt must be a valid timestamp",
    );
  });

  it("always advances updatedAt even for two writes in the same millisecond", () => {
    const current = new Date("2026-08-28T08:00:00.000Z");
    expect(nextCapabilityPackUpdatedAt(current, new Date(current))).toEqual(
      new Date("2026-08-28T08:00:00.001Z"),
    );
  });
});
