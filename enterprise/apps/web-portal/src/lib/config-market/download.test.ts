import { describe, expect, it } from "vitest";

import { parseConfigMarketDownloadRequest } from "./download";

const RELEASE_ID = "01JQMZ8K3N4P5Q6R7S8T9VWX01";

describe("config market download report body", () => {
  it("accepts exactly one ULID releaseId and normalizes casing/whitespace", () => {
    expect(parseConfigMarketDownloadRequest({ releaseId: ` ${RELEASE_ID.toLowerCase()} ` })).toEqual({
      releaseId: RELEASE_ID,
    });
  });

  it("rejects missing, malformed, or extra fields", () => {
    expect(parseConfigMarketDownloadRequest(null)).toBeNull();
    expect(parseConfigMarketDownloadRequest({})).toBeNull();
    expect(parseConfigMarketDownloadRequest({ releaseId: "not-a-release" })).toBeNull();
    expect(parseConfigMarketDownloadRequest({ releaseId: RELEASE_ID, counted: true })).toBeNull();
    expect(parseConfigMarketDownloadRequest({ releaseId: 42 })).toBeNull();
  });
});
