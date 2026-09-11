import { describe, expect, it } from "vitest";
import { stripThinkBlocks } from "./content-clean";
import {
  DeepResearchStreamOutput,
  normalizeGatewayMessageContent,
  usesImplicitThinkPrefix,
} from "./gateway-model-output";

describe("deep research gateway model output", () => {
  it("restores Qwen3.8's omitted opening think marker across stream chunks", () => {
    const output = new DeepResearchStreamOutput("examplecloud/qwen3.8");
    const chunks = [
      output.merge({ content: "先检查证据" }).content,
      output.merge({ content: "，再组织结论。</thi" }).content,
      output.merge({ content: "nk>\n最终正文" }).content,
      output.close(),
    ].join("");

    expect(chunks).toBe("<think>先检查证据，再组织结论。</think>\n最终正文");
    expect(stripThinkBlocks(chunks)).toBe("最终正文");
  });

  it("fails closed when an implicit Qwen thought never reaches visible content", () => {
    const output = new DeepResearchStreamOutput("qwen3.8");
    const chunks = output.merge({ content: "只有内部推理" }).content + output.close();

    expect(chunks).toBe("<think>只有内部推理</think>");
    expect(stripThinkBlocks(chunks)).toBe("");
  });

  it("keeps other Qwen versions on the ordinary content path", () => {
    expect(usesImplicitThinkPrefix("moma/Qwen/Qwen3.7-Max")).toBe(false);
    const output = new DeepResearchStreamOutput("moma/Qwen/Qwen3.7-Max");
    expect(output.merge({ content: "普通正文" })).toEqual({
      content: "普通正文",
      reasoning: "",
    });
    expect(output.close()).toBe("");
  });

  it("keeps explicit reasoning separate and deduplicates provider aliases", () => {
    const output = new DeepResearchStreamOutput("qwen3.8");
    expect(
      output.merge({
        reasoning_content: "<think>先规划</think>",
        reasoning: "<think>先规划</think>",
      }),
    ).toEqual({ content: "", reasoning: "先规划" });
    expect(output.merge({ content: "最终正文" })).toEqual({
      content: "最终正文",
      reasoning: "",
    });
  });

  it("normalizes non-streaming Qwen and split-field messages before JSON parsing", () => {
    expect(
      normalizeGatewayMessageContent("examplecloud/qwen3.8", {
        content: '先判断结构</think>{"ok":true}',
      }),
    ).toBe('<think>先判断结构</think>{"ok":true}');

    expect(
      normalizeGatewayMessageContent("another-model", {
        content: '{"ok":true}',
        reasoning_content: "先判断结构",
      }),
    ).toBe('<think>先判断结构</think>\n{"ok":true}');
  });
});
