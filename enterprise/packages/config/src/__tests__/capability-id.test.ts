import { describe, expect, it } from "vitest";
import {
  canonicalizeCapabilityId,
  ENTERPRISE_ASSISTANT_CAPABILITY_ID,
  formatCapabilityId,
  groupCapabilityIdsByKind,
  isCapabilityId,
  parseCapabilityId,
} from "../capability-id";

const ULID_A = "01JQMZ8K3N4P5Q6R7S8T9VWXYZ";
const ULID_B = "01JQMZ8K3N4P5Q6R7S8T9VWXY0";

describe("formatCapabilityId", () => {
  it("builds the prefixed form used everywhere else", () => {
    expect(formatCapabilityId("mcp", ULID_A)).toBe(`mcp:${ULID_A}`);
    expect(formatCapabilityId("skill", ULID_A)).toBe(`skill:${ULID_A}`);
    expect(formatCapabilityId("expert", ULID_A)).toBe(`expert:${ULID_A}`);
    expect(formatCapabilityId("group", ULID_A)).toBe(`group:${ULID_A}`);
  });

  it("uppercases a lowercase ULID rather than minting a second spelling", () => {
    expect(formatCapabilityId("mcp", ULID_A.toLowerCase())).toBe(`mcp:${ULID_A}`);
  });

  it("refuses anything that is not a ULID", () => {
    // 用 name/slug 当 id 正是这里要挡住的：改名会让所有引用指空。
    expect(() => formatCapabilityId("mcp", "market-data")).toThrow();
    expect(() => formatCapabilityId("mcp", "")).toThrow();
    expect(() => formatCapabilityId("nope" as "mcp", ULID_A)).toThrow();
  });
});

describe("parseCapabilityId", () => {
  it("round-trips what formatCapabilityId produced", () => {
    expect(parseCapabilityId(formatCapabilityId("skill", ULID_B))).toEqual({
      kind: "skill",
      rowId: ULID_B,
    });
  });

  it("returns null for junk instead of inventing a capability", () => {
    for (const bad of ["", "mcp", "mcp:", ":ULID", "mcp:market-data", "other:" + ULID_A, "mcp/" + ULID_A]) {
      expect(parseCapabilityId(bad)).toBeNull();
      expect(isCapabilityId(bad)).toBe(false);
    }
  });

  it("accepts only registry-backed enterprise actions and the assistant entry", () => {
    expect(parseCapabilityId("action:usage.analytics.read")).toEqual({ kind: "action", rowId: "usage.analytics.read" });
    expect(canonicalizeCapabilityId("ACTION:USAGE.ANALYTICS.READ")).toBe("action:usage.analytics.read");
    expect(parseCapabilityId("action:unknown.read")).toBeNull();
    expect(parseCapabilityId(ENTERPRISE_ASSISTANT_CAPABILITY_ID)).toEqual({ kind: "expert", rowId: "enterprise_assistant" });
    expect(canonicalizeCapabilityId(ENTERPRISE_ASSISTANT_CAPABILITY_ID)).toBe(ENTERPRISE_ASSISTANT_CAPABILITY_ID);
  });
});

describe("canonicalizeCapabilityId", () => {
  it("uppercases portable ULIDs and preserves platform feature ids", () => {
    expect(canonicalizeCapabilityId(`expert:${ULID_A.toLowerCase()}`)).toBe(
      `expert:${ULID_A}`,
    );
    expect(canonicalizeCapabilityId(`group:${ULID_B.toLowerCase()}`)).toBe(
      `group:${ULID_B}`,
    );
    expect(canonicalizeCapabilityId(" feature:web_search ")).toBe("feature:web_search");
  });

  it("returns null for an id that must not be persisted", () => {
    expect(canonicalizeCapabilityId("expert:not-a-ulid")).toBeNull();
  });
});

describe("groupCapabilityIdsByKind", () => {
  it("splits ids so each table is queried once, dropping unparseable entries", () => {
    expect(
      groupCapabilityIdsByKind([
        `mcp:${ULID_A}`,
        `skill:${ULID_B}`,
        `expert:${ULID_A}`,
        `group:${ULID_B}`,
        `mcp:${ULID_A}`,
        "garbage",
      ]),
    ).toEqual({
      mcp: [ULID_A],
      skill: [ULID_B],
      feature: [],
      expert: [ULID_A],
      group: [ULID_B],
      action: [],
    });
  });

  it("returns every bucket even when empty", () => {
    expect(groupCapabilityIdsByKind([])).toEqual({
      mcp: [],
      skill: [],
      feature: [],
      expert: [],
      group: [],
      action: [],
    });
  });
});
