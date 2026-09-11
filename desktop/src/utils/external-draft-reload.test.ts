import { describe, expect, it } from "vitest";

import { decideExternalDraftReload } from "./external-draft-reload";

describe("decideExternalDraftReload", () => {
  it("accepts the first successful disk snapshot as the editor baseline", () => {
    expect(
      decideExternalDraftReload({
        hydrated: false,
        draft: "",
        saved: "",
        disk: "# IDENTITY",
      }),
    ).toBe("accept");
  });

  it("does not report the same snapshot as an external edit", () => {
    expect(
      decideExternalDraftReload({
        hydrated: true,
        draft: "# IDENTITY",
        saved: "# IDENTITY",
        disk: "# IDENTITY",
      }),
    ).toBe("accept");
  });

  it("accepts a real disk change when the editor has no local draft", () => {
    expect(
      decideExternalDraftReload({
        hydrated: true,
        draft: "old",
        saved: "old",
        disk: "new",
      }),
    ).toBe("accept");
  });

  it("marks a conflict when both the editor and disk changed", () => {
    expect(
      decideExternalDraftReload({
        hydrated: true,
        draft: "local",
        saved: "old",
        disk: "external",
      }),
    ).toBe("mark-conflict");
  });

  it("keeps a local draft when the disk still matches its saved baseline", () => {
    expect(
      decideExternalDraftReload({
        hydrated: true,
        draft: "local",
        saved: "old",
        disk: "old",
      }),
    ).toBe("keep-local");
  });
});
