import { describe, expect, it } from "vitest";
import {
  buildConfirmScope,
  buildConfirmRunKey,
  canReuseProtectedConfirm,
  isProtectedConfirmContext,
  normalizeConfirmRisk,
  parentPathForConfirmScope,
  protectedConfirmReuseMode,
  protectedConfirmReason,
  RunScopedConfirmApprovals,
  shouldAutoApproveConfirm,
} from "./confirm-scope";

describe("confirmation scope", () => {
  it("binds temporary approvals to an exact session run", () => {
    const first = buildConfirmRunKey({ sessionId: "session-a", runId: "turn-1" });
    expect(first).not.toBe("");
    expect(first).not.toBe(buildConfirmRunKey({ sessionId: "session-a", runId: "turn-2" }));
    expect(first).not.toBe(buildConfirmRunKey({ sessionId: "session-b", runId: "turn-1" }));
    expect(buildConfirmRunKey({ sessionId: "", runId: "turn-1" })).toBe("");

    const approvals = new RunScopedConfirmApprovals();
    const run = { sessionId: "session-a", runId: "turn-1" };
    expect(approvals.allow(run, "git status")).toBe(true);
    expect(approvals.allows(run, "git status")).toBe(true);
    expect(approvals.allows({ ...run, runId: "turn-2" }, "git status")).toBe(false);
    approvals.end(run);
    expect(approvals.allows(run, "git status")).toBe(false);
  });

  it("groups Windows file changes by their parent directory", () => {
    const path = "C:\\Users\\demo\\workspace\\report.md";
    expect(parentPathForConfirmScope(path)).toBe("C:\\Users\\demo\\workspace");
    expect(JSON.parse(buildConfirmScope("write?", { tool: "file_write", path }))).toEqual({
      tool: "file_write",
      parent: "c:/Users/demo/workspace",
      workspaceRoots: [],
      permissions: "workspace-write",
    });
  });

  it("groups POSIX file edits by their parent directory", () => {
    expect(
      JSON.parse(buildConfirmScope("edit?", { tool: "file_edit", path: "/tmp/project/report.md" })),
    ).toMatchObject({ tool: "file_edit", parent: "/tmp/project" });
  });

  it("keys command approvals by prefix, workspace and permission level", () => {
    const base = {
      tool: "bash_exec",
      command: "git status --short",
      command_prefix: "git status",
      workspace_roots: ["C:\\Work\\repo", "D:\\shared"],
      sandbox_permissions: "workspace-write",
    };
    const parsed = JSON.parse(buildConfirmScope("run?", base));
    expect(parsed).toEqual({
      tool: "bash_exec",
      commandPrefix: "git status",
      workspaceRoots: ["c:/Work/repo", "d:/shared"],
      permissions: "workspace-write",
    });
    expect(buildConfirmScope("run?", base)).not.toBe(
      buildConfirmScope("run?", { ...base, command_prefix: "git diff" }),
    );
    expect(buildConfirmScope("run?", base)).not.toBe(
      buildConfirmScope("run?", { ...base, workspace_roots: ["C:\\Work\\other"] }),
    );
    expect(buildConfirmScope("run?", base)).not.toBe(
      buildConfirmScope("run?", { ...base, sandbox_permissions: "danger-full-access" }),
    );
  });

  it("uses a two-token fallback for old command confirmation payloads", () => {
    const parsed = JSON.parse(
      buildConfirmScope("run?", { tool: "bash_exec", command: "git status --short" }),
    );
    expect(parsed.commandPrefix).toBe("git status");
  });

  it("only treats an explicit low-risk marker as auto-approvable", () => {
    expect(normalizeConfirmRisk({ risk: " low " })).toBe("low");
    expect(isProtectedConfirmContext({ risk: "low" })).toBe(false);

    for (const risk of ["high", "destructive", "permission_escalation", "policy", "unknown"]) {
      expect(isProtectedConfirmContext({ risk })).toBe(true);
    }
    expect(isProtectedConfirmContext({})).toBe(true);
    expect(isProtectedConfirmContext()).toBe(true);
  });

  it("does not let an existing scope bypass protected risk", () => {
    expect(shouldAutoApproveConfirm(true, { risk: "high" })).toBe(false);
    expect(shouldAutoApproveConfirm(true, { risk: "destructive" })).toBe(false);
    expect(shouldAutoApproveConfirm(true)).toBe(false);

    // 「本次任务内不再问」记下的 scope 放行——那是用户在这次运行里点过的。
    expect(shouldAutoApproveConfirm(true, { risk: "low" })).toBe(true);
    expect(shouldAutoApproveConfirm(false, { risk: "low" })).toBe(false);
  });

  it("has no global-mode arm left: an unseen low-risk request still asks", () => {
    // 渲染层不再有第二次裁决权。全局「代我批准」由后端的确认闸执行——它在 auto 档
    // 下对低风险请求根本不发 confirm_required 事件,所以事件能走到这里,就说明后端
    // 要求用户看一眼。以前这里读缓存的 runMode 再判一次:缓存过期(另一个窗口刚改过、
    // 启动时那次 GET 失败)就会替用户答应一个后端明确要问的请求,且不留痕迹。
    expect(shouldAutoApproveConfirm(false, { risk: "low" })).toBe(false);
    expect(shouldAutoApproveConfirm(false, { risk: "low", tool: "file_write" })).toBe(false);
  });

  it("reuses a protected approval only for an explicitly exact command scope", () => {
    const context = {
      tool: "bash_exec",
      command: "python -c 'print(1)'",
      command_prefix: "python -c",
      risk: "high",
      approval_reuse: "exact-command",
      risk_categories: [
        { code: "arbitrary_code_execution", evidence: "python -c 可执行任意代码" },
      ],
      workspace_roots: ["C:\\Work\\repo"],
      cwd: "C:\\Work\\repo\\packages\\core",
      sandbox_permissions: "workspace-write",
    };

    expect(protectedConfirmReuseMode(context)).toBe("exact-command");
    expect(canReuseProtectedConfirm(context)).toBe(true);
    expect(shouldAutoApproveConfirm(false, context)).toBe(false);
    expect(shouldAutoApproveConfirm(true, context)).toBe(true);

    const parsed = JSON.parse(buildConfirmScope("run?", context));
    expect(parsed).toEqual({
      tool: "bash_exec",
      exactCommand: "python -c 'print(1)'",
      executionDirectory: "c:/Work/repo/packages/core",
      riskCategories: ["arbitrary_code_execution"],
      workspaceRoots: ["c:/Work/repo"],
      permissions: "workspace-write",
    });
    expect(buildConfirmScope("run?", context)).not.toBe(
      buildConfirmScope("run?", { ...context, command: "python -c 'print(2)'" }),
    );
    expect(buildConfirmScope("run?", context)).not.toBe(
      buildConfirmScope("run?", {
        ...context,
        risk_categories: [{ code: "shell_composition", evidence: "使用管道" }],
      }),
    );
    expect(buildConfirmScope("run?", context)).not.toBe(
      buildConfirmScope("run?", { ...context, workspace_roots: ["C:\\Work\\other"] }),
    );
    expect(buildConfirmScope("run?", context)).not.toBe(
      buildConfirmScope("run?", { ...context, cwd: "C:\\Work\\repo\\packages\\web" }),
    );
    expect(buildConfirmScope("run?", context)).not.toBe(
      buildConfirmScope("run?", { ...context, sandbox_permissions: "danger-full-access" }),
    );
  });

  it("rejects protected reuse unless the backend and tool both opt into exact-command", () => {
    const base = {
      tool: "bash_exec",
      command: "python -c 'print(1)'",
      risk: "high",
      sandbox_permissions: "workspace-write",
      workspace_roots: ["C:\\Work\\repo"],
      cwd: "C:\\Work\\repo",
      risk_categories: [{ code: "arbitrary_code_execution" }],
    };
    expect(canReuseProtectedConfirm(base)).toBe(false);
    expect(canReuseProtectedConfirm({ ...base, approval_reuse: "none" })).toBe(false);
    expect(
      canReuseProtectedConfirm({ ...base, tool: "file_write", approval_reuse: "exact-command" }),
    ).toBe(false);
    expect(
      canReuseProtectedConfirm({ ...base, command: "", approval_reuse: "exact-command" }),
    ).toBe(false);
    expect(
      canReuseProtectedConfirm({
        ...base,
        sandbox_permissions: "danger-full-access",
        approval_reuse: "exact-command",
      }),
    ).toBe(false);
    expect(
      canReuseProtectedConfirm({
        ...base,
        risk_categories: [{ code: "external_publish" }],
        approval_reuse: "exact-command",
      }),
    ).toBe(false);
    expect(
      canReuseProtectedConfirm({ ...base, cwd: "", approval_reuse: "exact-command" }),
    ).toBe(false);
  });

  it("每个受保护请求都说得出为什么，包括没标 risk 的", () => {
    // 后端给了理由就用后端的：理由的唯一出处在那边
    expect(
      protectedConfirmReason({ risk: "high", protected_reason: "后端说的理由" }),
    ).toBe("后端说的理由");

    // 拿不到才回退本地镜像
    expect(protectedConfirmReason({ risk: "non_whitelisted" })).toContain("白名单");
    expect(protectedConfirmReason({ risk: "destructive" })).toContain("删除或覆盖");
    expect(protectedConfirmReason({ risk: "permission_escalation" })).toContain("工作区写入隔离");

    // fail-closed 的那一档也必须有话说 —— 弹了框却不给理由，用户只会当成故障
    expect(protectedConfirmReason({})).not.toBe("");
    expect(protectedConfirmReason({ risk: "某个将来才有的档" })).not.toBe("");

    // 低风险不该有理由：它根本不会弹框
    expect(protectedConfirmReason({ risk: "low" })).toBe("");
  });
});
