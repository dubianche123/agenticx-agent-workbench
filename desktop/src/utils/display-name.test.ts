import { describe, expect, it } from "vitest";
import { META_AGENT_DISPLAY_NAME } from "../constants/branding";
import {
  isMetaLeaderAgentId,
  isMetaLeaderIdentity,
  resolveMetaDisplayName,
} from "./display-name";

describe("resolveMetaDisplayName", () => {
  it("maps legacy product variants to the current brand", () => {
    expect(resolveMetaDisplayName("Near")).toBe(META_AGENT_DISPLAY_NAME);
    expect(resolveMetaDisplayName("Machi")).toBe(META_AGENT_DISPLAY_NAME);
    expect(resolveMetaDisplayName("machi")).toBe(META_AGENT_DISPLAY_NAME);
    expect(resolveMetaDisplayName("meta")).toBe(META_AGENT_DISPLAY_NAME);
  });

  it("maps empty and avatar placeholder to the current brand", () => {
    expect(resolveMetaDisplayName("")).toBe(META_AGENT_DISPLAY_NAME);
    expect(resolveMetaDisplayName(null)).toBe(META_AGENT_DISPLAY_NAME);
    expect(resolveMetaDisplayName(undefined)).toBe(META_AGENT_DISPLAY_NAME);
    expect(resolveMetaDisplayName("分身")).toBe(META_AGENT_DISPLAY_NAME);
  });

  it("preserves custom display names", () => {
    expect(resolveMetaDisplayName("自定义名")).toBe("自定义名");
    expect(resolveMetaDisplayName("  Research Bot  ")).toBe("Research Bot");
  });
});

describe("isMetaLeaderIdentity", () => {
  it("recognizes meta agent ids and legacy Machi labels", () => {
    expect(isMetaLeaderAgentId("meta")).toBe(true);
    expect(isMetaLeaderAgentId("__meta__")).toBe(true);
    expect(isMetaLeaderAgentId("avatar-1")).toBe(false);
    expect(isMetaLeaderIdentity("__meta__", "Machi")).toBe(true);
    expect(isMetaLeaderIdentity("", "Machi")).toBe(true);
    expect(isMetaLeaderIdentity("avatar-1", "飞坦")).toBe(false);
  });
});
