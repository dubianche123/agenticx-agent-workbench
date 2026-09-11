import { describe, expect, it, vi } from "vitest";

import {
  formatEnterpriseSyncTime,
  refreshEnterpriseAccountState,
} from "./AccountTab";

describe("AccountTab enterprise refresh", () => {
  it("reloads the durable account snapshot even when package reconciliation partially fails", async () => {
    const calls: string[] = [];
    const result = await refreshEnterpriseAccountState({
      refresh: vi.fn(async () => {
        calls.push("refresh");
        return { ok: false, error: "企业能力仅部分同步成功" };
      }),
      reload: vi.fn(async () => {
        calls.push("reload");
        return { ok: true as const };
      }),
      onChanged: vi.fn(async () => {
        calls.push("changed");
      }),
    });

    expect(calls).toEqual(["refresh", "reload", "changed"]);
    expect(result.refresh).toEqual({ ok: false, error: "企业能力仅部分同步成功" });
    expect(result.reload).toEqual({ ok: true });
  });

  it("still reloads after the refresh IPC rejects", async () => {
    const reload = vi.fn(async () => ({ ok: true as const }));
    const result = await refreshEnterpriseAccountState({
      refresh: vi.fn(async () => {
        throw new Error("IPC closed");
      }),
      reload,
    });

    expect(reload).toHaveBeenCalledOnce();
    expect(result.refresh.ok).toBe(false);
    expect(result.refresh.error).toContain("IPC closed");
  });

  it("formats the stored ISO timestamp for people instead of exposing raw UTC text", () => {
    const formatted = formatEnterpriseSyncTime("2026-08-31T12:34:56.000Z");
    expect(formatted).toContain("2026");
    expect(formatted).not.toContain("T12:34:56.000Z");
    expect(formatEnterpriseSyncTime("not-a-date")).toBe("not-a-date");
  });
});
