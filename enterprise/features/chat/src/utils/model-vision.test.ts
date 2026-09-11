import { describe, expect, it } from "vitest";
import { isKnownNonVisionChatModel, modelSupportsVision } from "./model-vision";

describe("model-vision", () => {
  it("treats zhipu GLM-5.1 as text-only", () => {
    expect(isKnownNonVisionChatModel("zhipu", "GLM-5.1")).toBe(true);
    expect(modelSupportsVision("zhipu", "GLM-5.1")).toBe(false);
  });

  it("matches text-only model families behind custom providers", () => {
    expect(isKnownNonVisionChatModel("custom_openai_moma", "ZHIPU/GLM-5.2")).toBe(true);
    expect(modelSupportsVision("custom_openai_moma", "ZHIPU/GLM-5.2")).toBe(false);
    expect(isKnownNonVisionChatModel("enterprise", "qwen3.7-max")).toBe(true);
  });

  it("treats zhipu glm-4v as vision-capable", () => {
    expect(isKnownNonVisionChatModel("zhipu", "glm-4v")).toBe(false);
    expect(modelSupportsVision("zhipu", "glm-4v")).toBe(true);
  });

  it("respects explicit vision capability flag", () => {
    expect(modelSupportsVision("zhipu", "GLM-5.1", ["vision"])).toBe(true);
  });

  it("treats a non-empty capability list as authoritative", () => {
    expect(modelSupportsVision("custom", "future-model", ["text"])).toBe(false);
    expect(modelSupportsVision("custom", "future-model", ["TEXT", "VISION"])).toBe(true);
  });
});
