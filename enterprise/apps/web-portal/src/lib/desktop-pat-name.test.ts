import { describe, expect, it } from "vitest";
import { DESKTOP_PAT_NAME_PREFIX, formatDesktopPatName } from "./desktop-pat-name";

describe("formatDesktopPatName", () => {
  it("uses the product label for an omitted or blank device name", () => {
    expect(formatDesktopPatName()).toBe(DESKTOP_PAT_NAME_PREFIX);
    expect(formatDesktopPatName("  ")).toBe(DESKTOP_PAT_NAME_PREFIX);
  });

  it("does not repeat the product label when the device default is already branded", () => {
    expect(formatDesktopPatName(DESKTOP_PAT_NAME_PREFIX)).toBe(DESKTOP_PAT_NAME_PREFIX);
    expect(formatDesktopPatName(`${DESKTOP_PAT_NAME_PREFIX} · Mac`)).toBe(
      `${DESKTOP_PAT_NAME_PREFIX} · Mac`,
    );
  });

  it("adds the product label to an unbranded device name", () => {
    expect(formatDesktopPatName("Mac")).toBe(`${DESKTOP_PAT_NAME_PREFIX} · Mac`);
  });
});
