import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import {
  PORTAL_LOG_QUERY_TIMEOUT_MS,
  raceWithPortalQueryTimeout,
} from "./PortalLogsPanel";

const portalLogsSource = readFileSync(new URL("./PortalLogsPanel.tsx", import.meta.url), "utf8");
const auditPanelSource = readFileSync(new URL("./AuditPanel.tsx", import.meta.url), "utf8");
const tracePageSource = readFileSync(
  new URL("../../app/traces/[traceId]/page.tsx", import.meta.url),
  "utf8",
);

describe("admin runtime stale-response guards", () => {
  it("aborts a Portal query that never resolves and lets the fallback win", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const pending = new Promise<never>(() => {
        // Simulates a Portal store request that never returns.
      });
      const settled = raceWithPortalQueryTimeout(pending, controller).catch((error: unknown) => error);

      await vi.advanceTimersByTimeAsync(PORTAL_LOG_QUERY_TIMEOUT_MS);

      const result = await settled;
      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).toBe("portal log query timed out");
      expect(controller.signal.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fences trace page, audit error, and session responses by request ownership", () => {
    expect(tracePageSource).toContain("activeLoad.current?.abort()");
    expect(tracePageSource).toContain("signal: controller.signal");
    expect(tracePageSource).toContain("payload.data.trace_id !== requestedTraceId");
    expect(tracePageSource).toContain("if (!isCurrent()) return;");

    expect(auditPanelSource).toContain("const payload = (await response.json().catch(() => ({})))");
    expect(auditPanelSource).toContain("if (!isCurrent()) return;");

    expect(portalLogsSource).toContain("activeSessionLoad.current?.abort()");
    expect(portalLogsSource).toContain("sessionLoadGeneration.current");
    expect(portalLogsSource).toContain("if (!isCurrent()) return;");
  });
});
