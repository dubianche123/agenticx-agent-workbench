import { describe, expect, it } from "vitest";
import {
  SUPPORT_MAX_MESSAGES,
  SUPPORT_MAX_MESSAGE_CHARS,
  boundSupportMessage,
  parseSupportChatRequest,
  parseSupportExecuteRequest,
  sanitizeSupportMessage,
  supportMessagesForStorage,
} from "./contracts";

describe("support contracts", () => {
  it("accepts the bounded public chat shape and strips surrounding whitespace", () => {
    const parsed = parseSupportChatRequest({
      messages: [
        { role: "user", content: "  模型为什么不可用？  " },
        { role: "assistant", content: "请检查当前账号的模型范围。" },
      ],
      page: { path: "/workspace/", tab: "chat" },
      model: "provider/model",
    });
    expect(parsed).toEqual({
      ok: true,
      value: {
        messages: [
          { role: "user", content: "模型为什么不可用？" },
          { role: "assistant", content: "请检查当前账号的模型范围。" },
        ],
        page: { path: "/workspace/", tab: "chat" },
        model: "provider/model",
      },
    });
  });

  it("rejects unknown fields and oversized conversations", () => {
    expect(parseSupportChatRequest({
      messages: [{ role: "user", content: "help" }],
      page: { path: "/workspace" },
      execute: { operation: "delete" },
    })).toMatchObject({ ok: false });

    expect(parseSupportChatRequest({
      messages: Array.from({ length: SUPPORT_MAX_MESSAGES + 1 }, () => ({ role: "user", content: "help" })),
      page: { path: "/workspace" },
    })).toMatchObject({ ok: false });
  });

  it("accepts only an opaque proposal id for execution", () => {
    expect(parseSupportExecuteRequest({ proposalId: "proposal-1" })).toEqual({
      ok: true,
      value: { proposalId: "proposal-1" },
    });
    expect(parseSupportExecuteRequest({ proposalId: "proposal-1", amount: 10 })).toMatchObject({ ok: false });
  });

  it("bounds model output at the same limit used by parser and storage", () => {
    const answer = boundSupportMessage(`  ${"答".repeat(SUPPORT_MAX_MESSAGE_CHARS + 20)}  `);
    expect(answer).toHaveLength(SUPPORT_MAX_MESSAGE_CHARS);
    expect(parseSupportChatRequest({
      messages: [{ role: "assistant", content: answer }],
      page: { path: "/workspace" },
    })).toMatchObject({ ok: true });
    expect(supportMessagesForStorage([{ role: "assistant", content: answer }])[0]?.content).toBe(answer);
  });

  it("keeps stored support history bounded and drops proposal-like fields", () => {
    const assistantWithProposal = {
      role: "assistant" as const,
      content: "answer",
      proposal: { id: "p" },
    };
    const result = supportMessagesForStorage([
      assistantWithProposal,
      ...Array.from({ length: SUPPORT_MAX_MESSAGES }, (_, index) => ({ role: "user" as const, content: String(index) })),
    ]);
    expect(result).toHaveLength(SUPPORT_MAX_MESSAGES);
    expect(result[0]).toEqual({ role: "user", content: "0" });
    expect(result.every((item) => Object.keys(item).sort().join(",") === "content,role")).toBe(true);
  });

  it("sanitizes legacy assistant reasoning while preserving user-authored tags", () => {
    expect(sanitizeSupportMessage({
      role: "assistant",
      content: "<think>legacy provider reasoning</think>可见回答",
    })).toEqual({ role: "assistant", content: "可见回答" });
    expect(sanitizeSupportMessage({
      role: "user",
      content: "我想了解 <think> 标签的含义",
    })).toEqual({ role: "user", content: "我想了解 <think> 标签的含义" });

    expect(supportMessagesForStorage([
      { role: "assistant", content: "<think>only legacy reasoning" },
      { role: "user", content: "用户原文：<think>这是问题内容</think>" },
      { role: "assistant", content: "<analysis>internal</analysis>保留的回答" },
    ])).toEqual([
      { role: "user", content: "用户原文：<think>这是问题内容</think>" },
      { role: "assistant", content: "保留的回答" },
    ]);
  });
});
