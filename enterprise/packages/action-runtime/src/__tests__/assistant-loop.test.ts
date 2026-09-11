import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_ASSISTANT_LOOP_LIMITS,
  isUnverifiedMutationClaim,
  runAssistantActionLoop,
  type AssistantLoopMessage,
  type AssistantModelResponse,
} from "../assistant-loop";
import type { PublicAction } from "../types";

const analytics: PublicAction = {
  id: "usage.analytics.read",
  label: "分析企业用量",
  description: "按授权范围聚合企业用量。",
  effect: "query",
  inputSchema: {
    type: "object",
    required: ["groupBy", "metric"],
    properties: {
      groupBy: { type: "string", enum: ["user", "department", "model"] },
      metric: { type: "string", enum: ["totalTokens"] },
    },
    additionalProperties: false,
  },
};

const quotaWrite: PublicAction = {
  id: "member.quota.set",
  label: "调整成员额度",
  description: "准备成员额度调整。",
  effect: "mutation",
  inputSchema: { type: "object", required: ["userId"], additionalProperties: false },
};

const quotaRead: PublicAction = {
  id: "member.quota.read",
  label: "读取成员额度",
  description: "读取成员当前额度配置。",
  effect: "query",
  inputSchema: { type: "object", additionalProperties: false },
};

const emptyReadA: PublicAction = {
  id: "config.first.read",
  label: "读取第一项配置",
  description: "读取第一项配置。",
  effect: "query",
  inputSchema: { type: "object", additionalProperties: false },
};

const emptyReadB: PublicAction = {
  id: "config.second.read",
  label: "读取第二项配置",
  description: "读取第二项配置。",
  effect: "query",
  inputSchema: { type: "object", additionalProperties: false },
};

const scopedRead: PublicAction = {
  id: "config.scoped.read",
  label: "按范围读取配置",
  description: "按范围读取配置。",
  effect: "query",
  inputSchema: {
    type: "object",
    required: ["scope"],
    properties: { scope: { type: "string", minLength: 1 } },
    additionalProperties: false,
  },
};

function message(content: string): AssistantLoopMessage {
  return { role: "user", content };
}

describe("bounded enterprise action assistant loop", () => {
  it("discovers analytics, feeds its observation back, and returns a grounded answer", async () => {
    const requests: Array<{ messages: readonly AssistantLoopMessage[]; maxOutputTokens: number; tools: readonly unknown[] }> = [];
    let modelTurn = 0;
    const result = await runAssistantActionLoop({
      messages: [message("本月哪个部门的 Token 最多？")],
      discover: async () => [analytics],
      invoke: async ({ actionId, arguments: args }) => {
        expect(actionId).toBe(analytics.id);
        expect(args).toEqual({ groupBy: "department", metric: "totalTokens" });
        return { status: "succeeded", output: { rows: [{ department: "演示研发部", totalTokens: 1200 }] } };
      },
      requestModel: async (input): Promise<AssistantModelResponse> => {
        requests.push(input);
        modelTurn += 1;
        if (modelTurn === 1) {
          return {
            toolCalls: [{
              id: "analytics-1",
              name: "enterprise_action",
              arguments: {
                actionId: analytics.id,
                arguments: { groupBy: "department", metric: "totalTokens" },
              },
            }],
          };
        }
        expect(input.messages.at(-1)?.role).toBe("tool");
        return { content: "本月演示研发部用量最高，共 1200 Token。" };
      },
    });

    expect(result.status).toBe("completed");
    expect(result.message).toContain("演示研发部");
    expect(result.actionsInvoked).toBe(1);
    expect(result.turns).toBe(2);
    expect(requests[0]?.maxOutputTokens).toBe(DEFAULT_ASSISTANT_LOOP_LIMITS.maxOutputTokens);
    const firstTool = requests[0]?.tools[0] as { function?: { name?: string } } | undefined;
    expect(firstTool?.function?.name).toBe("enterprise_action");
  });

  it("binds each advertised action id to its argument schema in a valid envelope", async () => {
    let parameters: Record<string, unknown> | undefined;
    await runAssistantActionLoop({
      messages: [message("读取配置")],
      discover: async () => [emptyReadA, emptyReadB, scopedRead],
      invoke: async () => ({ status: "succeeded", output: {} }),
      requestModel: async ({ tools }) => {
        parameters = (tools[0] as { function?: { parameters?: Record<string, unknown> } } | undefined)?.function?.parameters;
        return { content: "配置读取完成。" };
      },
    });

    expect(parameters).toBeDefined();
    const validate = new Ajv().compile(parameters as object);
    expect(validate({ actionId: emptyReadA.id, arguments: {} })).toBe(true);
    expect(validate({ actionId: emptyReadB.id, arguments: {} })).toBe(true);
    expect(validate({ actionId: scopedRead.id, arguments: { scope: "member" } })).toBe(true);
    expect(validate({ actionId: emptyReadA.id, arguments: { scope: "member" } })).toBe(false);
    expect(validate({ actionId: scopedRead.id, arguments: {} })).toBe(false);
    expect(validate({ actionId: "config.unknown", arguments: {} })).toBe(false);
  });

  it("returns validation feedback and lets the model repair malformed arguments", async () => {
    let modelTurn = 0;
    let invoked = 0;
    const result = await runAssistantActionLoop({
      messages: [message("看一下用量")],
      discover: async () => [analytics],
      invoke: async () => {
        invoked += 1;
        return { status: "succeeded", output: { rows: [] } };
      },
      requestModel: async (input) => {
        modelTurn += 1;
        if (modelTurn === 1) return { toolCalls: [{ id: "bad-1", name: "enterprise_action", arguments: "{" }] };
        if (modelTurn === 3) return { content: "用量查询完成。" };
        expect(input.messages.some((item) => item.role === "tool" && item.content?.includes("valid JSON"))).toBe(true);
        return {
          toolCalls: [{
            id: "fixed-1",
            name: "enterprise_action",
            arguments: { actionId: analytics.id, arguments: { groupBy: "department", metric: "totalTokens" } },
          }],
        };
      },
      limits: { maxTurns: 3 },
    });

    expect(result.status).toBe("completed");
    expect(result.actionsInvoked).toBe(2);
    expect(invoked).toBe(1);
    expect(result.observations[0]).toMatchObject({ status: "invalid", code: "ACTION_VALIDATION_FAILED" });
  });

  it("does not expose a forbidden action as executed and stops at a confirmation proposal", async () => {
    let modelTurn = 0;
    const forbidden = await runAssistantActionLoop({
      messages: [message("把额度改成 1")],
      discover: async () => [analytics],
      invoke: async () => ({ status: "succeeded", output: {} }),
      requestModel: async () => {
        modelTurn += 1;
        return modelTurn === 1
          ? { toolCalls: [{ id: "forbidden-1", name: "enterprise_action", arguments: { actionId: quotaWrite.id, arguments: { userId: "u" } } }] }
          : { content: "已完成额度修改。" };
      },
    });

    expect(forbidden.status).toBe("completed");
    expect(forbidden.message).toContain("未完成");
    expect(forbidden.message).not.toContain("已完成额度修改");

    let calls = 0;
    const awaiting = await runAssistantActionLoop({
      messages: [message("调整额度")],
      discover: async () => [quotaWrite],
      invoke: async () => {
        calls += 1;
        return { status: "awaiting_confirmation", operationId: "op-1", proposal: { title: "额度调整", changes: { monthlyTokens: 1 } } };
      },
      requestModel: async () => ({
        toolCalls: [{ id: "write-1", name: "enterprise_action", arguments: { actionId: quotaWrite.id, arguments: { userId: "u" } } }],
      }),
    });

    expect(awaiting.status).toBe("awaiting_confirmation");
    expect(awaiting.operationId).toBe("op-1");
    expect(awaiting.proposal).toMatchObject({ title: "额度调整" });
    expect(awaiting.message).not.toContain("已执行");
    expect(calls).toBe(1);
  });

  it("feeds an ActionRuntime schema error back before accepting repaired arguments", async () => {
    let turn = 0;
    let invocation = 0;
    const result = await runAssistantActionLoop({
      messages: [message("看一下部门用量")],
      discover: async () => [analytics],
      invoke: async () => {
        invocation += 1;
        if (invocation === 1) {
          return {
            status: "invalid",
            error: { code: "ACTION_VALIDATION_FAILED", message: "arguments.metric is required" },
          };
        }
        return { status: "succeeded", output: { groups: [{ key: "演示研发部", value: 1200 }] } };
      },
      requestModel: async (input) => {
        turn += 1;
        if (turn === 1) {
          return {
            toolCalls: [{
              id: "invalid-schema",
              name: "enterprise_action",
              arguments: { actionId: analytics.id, arguments: { groupBy: "department" } },
            }],
          };
        }
        if (turn === 2) {
          expect(input.messages.at(-1)?.content).toContain("arguments.metric is required");
          return {
            toolCalls: [{
              id: "repaired-schema",
              name: "enterprise_action",
              arguments: { actionId: analytics.id, arguments: { groupBy: "department", metric: "totalTokens" } },
            }],
          };
        }
        return { content: "演示研发部用量最高。" };
      },
    });

    expect(result.status).toBe("completed");
    expect(result.message).toContain("演示研发部");
    expect(result.observations[0]).toMatchObject({ status: "invalid", code: "ACTION_VALIDATION_FAILED" });
    expect(invocation).toBe(2);
  });

  it("bounds the loop with an overall abort deadline", async () => {
    const result = await runAssistantActionLoop({
      messages: [message("查询")],
      discover: async () => [analytics],
      invoke: async () => ({ status: "succeeded", output: {} }),
      requestModel: async ({ signal }) => {
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", () => resolve(), { once: true });
        });
        throw new Error("aborted");
      },
      limits: { overallTimeoutMs: 5 },
    });
    expect(result.status).toBe("timed_out");
  });

  it("does not project unverified mutation prose as a completed change", async () => {
    const result = await runAssistantActionLoop({
      messages: [message("把额度改成 1")],
      discover: async () => [quotaWrite],
      invoke: async () => ({ status: "succeeded", output: {} }),
      requestModel: async () => ({ content: "已把额度改为 1，配置已生效。" }),
    });

    expect(result.status).toBe("completed");
    expect(result.message).toContain("未执行任何写入");
    expect(result.message).not.toContain("已把额度改为 1");
  });

  it("allows an evidence-backed current-state description while rejecting a mutation claim", async () => {
    expect(isUnverifiedMutationClaim("当前额度已设置为1000。")).toBe(false);
    expect(isUnverifiedMutationClaim("我已为你修改额度为1000。")).toBe(true);
    expect(isUnverifiedMutationClaim("预览已生成。")).toBe(true);

    let modelTurn = 0;
    const grounded = await runAssistantActionLoop({
      messages: [message("查看当前额度")],
      discover: async () => [quotaRead],
      invoke: async () => ({ status: "succeeded", output: { monthlyTokens: 1000 } }),
      requestModel: async () => {
        modelTurn += 1;
        return modelTurn === 1
          ? { toolCalls: [{ id: "quota-read", name: "enterprise_action", arguments: { actionId: quotaRead.id, arguments: {} } }] }
          : { content: "当前额度已设置为1000。" };
      },
    });

    expect(grounded.message).toBe("当前额度已设置为1000。");

    const ungrounded = await runAssistantActionLoop({
      messages: [message("查看当前额度")],
      discover: async () => [quotaRead],
      invoke: async () => ({ status: "succeeded", output: { monthlyTokens: 1000 } }),
      requestModel: async () => ({ content: "当前额度已设置为1000。" }),
    });

    expect(ungrounded.message).toContain("未执行任何写入");
    expect(ungrounded.message).not.toContain("当前额度已设置为1000");

    modelTurn = 0;
    const fabricated = await runAssistantActionLoop({
      messages: [message("查看并修改当前额度")],
      discover: async () => [quotaRead],
      invoke: async () => ({ status: "succeeded", output: { monthlyTokens: 1000 } }),
      requestModel: async () => {
        modelTurn += 1;
        return modelTurn === 1
          ? { toolCalls: [{ id: "quota-read", name: "enterprise_action", arguments: { actionId: quotaRead.id, arguments: {} } }] }
          : { content: "我已为你修改额度为1000。" };
      },
    });

    expect(fabricated.message).toContain("未执行任何写入");
    expect(fabricated.message).not.toContain("我已为你修改额度");
  });

  it("does not accept a current-state claim after a failed observation", async () => {
    let modelTurn = 0;
    const result = await runAssistantActionLoop({
      messages: [message("查看当前额度")],
      discover: async () => [quotaRead],
      invoke: async () => ({ status: "failed", error: { code: "QUOTA_READ_FAILED", message: "quota unavailable" } }),
      requestModel: async () => {
        modelTurn += 1;
        return modelTurn === 1
          ? { toolCalls: [{ id: "quota-read-failed", name: "enterprise_action", arguments: { actionId: quotaRead.id, arguments: {} } }] }
          : { content: "当前额度已设置为1000。" };
      },
    });

    expect(result.message).toContain("服务端未完成请求中的一项操作");
    expect(result.message).not.toContain("当前额度已设置为1000");
  });
});
