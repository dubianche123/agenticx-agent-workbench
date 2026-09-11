import { describe, expect, it } from "vitest";
import type { Message } from "../store";
import { resolveToolActivitySummary } from "../components/messages/ToolActivityIndicator";
import {
  deferredToolSchemaAutoloadMetadata,
  isDeferredToolSchemaAutoload,
  projectRuntimeToolResult,
} from "./runtime-tool-result";

describe("runtime tool result projection", () => {
  it("keeps deferred schema loading pending and suppresses its internal error notice", () => {
    const data = {
      detector: "tool_schema_autoload",
      action: "retry_next_round",
      tool_executed: false,
      is_error: false,
    };

    expect(isDeferredToolSchemaAutoload(data)).toBe(true);
    expect(projectRuntimeToolResult(data, "done")).toEqual({
      status: "pending",
      executed: false,
      suppressErrorNotice: true,
    });
  });

  it("does not turn a deferred autoload followed by success into a failure", () => {
    const events = [
      {
        type: "error",
        data: {
          detector: "tool_schema_autoload",
          action: "retry_next_round",
          tool_executed: false,
          is_error: true,
        },
      },
      {
        type: "tool_result",
        data: {
          tool_call_id: "autoload-1",
          name: "web_fetch",
          detector: "tool_schema_autoload",
          action: "retry_next_round",
          tool_executed: false,
          is_error: false,
        },
      },
      {
        type: "tool_result",
        data: {
          tool_call_id: "retry-1",
          name: "web_fetch",
          tool_executed: true,
          is_error: false,
        },
      },
    ] as const;

    const results = events
      .filter((event) => event.type === "tool_result")
      .map((event) => projectRuntimeToolResult(event.data, "done"));
    const visibleErrors = events.filter(
      (event) => event.type === "error" && !projectRuntimeToolResult(event.data, "error").suppressErrorNotice,
    );

    expect(results.map((result) => result.status)).toEqual(["pending", "done"]);
    expect(results.filter((result) => result.status === "error")).toHaveLength(0);
    expect(visibleErrors).toHaveLength(0);

    // Project the same SSE tool_result frames into the rows consumed by the
    // activity card. The discovery row retains pending/non-executed metadata;
    // the summary must count only the real retry as completed.
    const toolResultEvents = events.filter(
      (event): event is Extract<(typeof events)[number], { type: "tool_result" }> => event.type === "tool_result",
    );
    const mergedRows: Message[] = toolResultEvents
      .map((event) => {
        const projection = projectRuntimeToolResult(event.data, "done");
        return {
          id: `row-${event.data.tool_call_id}`,
          role: "tool" as const,
          content: String("result" in event.data ? event.data.result ?? "" : ""),
          toolCallId: event.data.tool_call_id,
          toolName: event.data.name,
          toolStatus: projection.status,
          metadata: deferredToolSchemaAutoloadMetadata(event.data),
        };
      });
    const summary = resolveToolActivitySummary(mergedRows);
    expect(summary.active).toBe(false);
    expect(summary.tone).toBe("normal");
    expect(summary.label).toBe("已完成 1 个步骤");
  });

  it("preserves real tool errors", () => {
    expect(projectRuntimeToolResult({ is_error: true }, "error")).toEqual({
      status: "error",
      executed: true,
      suppressErrorNotice: false,
    });
    expect(isDeferredToolSchemaAutoload({ detector: "tool_schema_autoload", tool_executed: true })).toBe(false);
  });
});
