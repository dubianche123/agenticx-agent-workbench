export type RuntimeToolResultStatus = "done" | "pending" | "error";

export type RuntimeToolResultProjection = {
  status: RuntimeToolResultStatus;
  executed: boolean;
  suppressErrorNotice: boolean;
};

export const TOOL_SCHEMA_AUTOLOAD_DETECTOR = "tool_schema_autoload";

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * A deferred schema load is an internal retry signal. It did not execute the
 * tool and must not become a user-visible error or a completed tool result.
 */
export function isDeferredToolSchemaAutoload(data: unknown): boolean {
  const record = recordOf(data);
  return record?.detector === TOOL_SCHEMA_AUTOLOAD_DETECTOR && record.tool_executed === false;
}

/** Persist the same structured marker on the local chat row for reloads. */
export function deferredToolSchemaAutoloadMetadata(data: unknown): Record<string, unknown> | undefined {
  if (!isDeferredToolSchemaAutoload(data)) return undefined;
  const record = recordOf(data);
  return {
    severity: "warning",
    detector: TOOL_SCHEMA_AUTOLOAD_DETECTOR,
    action: typeof record?.action === "string" ? record.action : "retry_next_round",
    tool_executed: false,
  };
}

export function isDeferredToolSchemaAutoloadMessage(message: { metadata?: unknown }): boolean {
  return isDeferredToolSchemaAutoload(message.metadata);
}

export function projectRuntimeToolResult(
  data: unknown,
  fallbackStatus: RuntimeToolResultStatus,
): RuntimeToolResultProjection {
  if (isDeferredToolSchemaAutoload(data)) {
    return {
      status: "pending",
      executed: false,
      suppressErrorNotice: true,
    };
  }
  const record = recordOf(data);
  return {
    status: fallbackStatus,
    executed: record?.tool_executed !== false,
    suppressErrorNotice: false,
  };
}
