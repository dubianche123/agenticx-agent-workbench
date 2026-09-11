import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CitationMarkdownBody } from "../src/components/messages/CitationMarkdownBody";
import {
  buildEnvironmentConfirmDetails,
  isEnvironmentTurnCurrent,
  isEnvironmentPermissionChangeBlocked,
  parseEnvironmentPermissionMode,
  pendingFirstStatus,
} from "../src/components/EnvironmentAssistantPanel";

describe("environment assistant shared message rendering", () => {
  it("renders assistant Markdown with the shared safe chat pipeline", () => {
    const html = renderToStaticMarkup(
      <CitationMarkdownBody
        content={[
          "## 环境检查",
          "",
          "诊断 **完成**，见 [安全链接](javascript:alert(1))。",
          "",
          "| 项目 | 状态 |",
          "| --- | --- |",
          "| Python | 正常 |",
          "",
          "```ts",
          "const ok = true;",
          "```",
          "",
          "<script>alert(1)</script>",
        ].join("\n")}
      />,
    );

    expect(html).toContain("<h2");
    expect(html).toContain("<strong");
    expect(html).toContain("agx-table-block");
    expect(html).toContain("agx-chat-prism");
    expect(html).toContain("language-ts");
    expect(html).not.toContain("javascript:alert");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("strictly accepts only the three server permission modes", () => {
    expect(parseEnvironmentPermissionMode("plan")).toBe("plan");
    expect(parseEnvironmentPermissionMode(" ASK ")).toBe("ask");
    expect(parseEnvironmentPermissionMode("auto")).toBe("auto");
    expect(parseEnvironmentPermissionMode("default")).toBeNull();
    expect(parseEnvironmentPermissionMode(null)).toBeNull();
  });

  it("keeps permission editing available after stop or an error", () => {
    expect(isEnvironmentPermissionChangeBlocked("loading")).toBe(true);
    expect(isEnvironmentPermissionChangeBlocked("streaming")).toBe(true);
    expect(isEnvironmentPermissionChangeBlocked("awaiting_confirm")).toBe(true);
    expect(isEnvironmentPermissionChangeBlocked("awaiting_input")).toBe(true);
    expect(isEnvironmentPermissionChangeBlocked("stopping")).toBe(true);
    expect(isEnvironmentPermissionChangeBlocked("idle")).toBe(false);
    expect(isEnvironmentPermissionChangeBlocked("stopped")).toBe(false);
    expect(isEnvironmentPermissionChangeBlocked("error")).toBe(false);
  });

  it("keeps the actual confirmation command and execution boundary reviewable", () => {
    const command = "bash -lc 'printf \"%s\\n\" safe > /workspace/out.txt'";
    const details = buildEnvironmentConfirmDetails("需要确认文件写入", {
      command,
      cwd: "/workspace/project",
      summary: "将写入 /workspace/out.txt，不会修改其他文件。",
      risk: "会创建或覆盖目标文件。",
      sandbox_permissions: "workspace-write",
      workspace_roots: ["/workspace/project"],
      command_prefix: "bash",
    });

    expect(details.command).toBe(command);
    expect(details.cwd).toBe("/workspace/project");
    expect(details.summary).toContain("/workspace/out.txt");
    expect(details.risk).toContain("覆盖");
    expect(details.presentation.summary).toContain("完整命令");
    expect(details.presentation.allowlistScope).toContain("bash");
  });

  it("keeps a pending decision ahead of late stream status events", () => {
    expect(pendingFirstStatus(true, false)).toBe("awaiting_confirm");
    expect(pendingFirstStatus(false, true)).toBe("awaiting_input");
    expect(pendingFirstStatus(false, false)).toBe("streaming");
  });

  it("fences a deferred bootstrap before it can POST a chat turn after Stop", async () => {
    const bootstrap = Promise.resolve({ session_id: "sid-after-bootstrap" });
    const controller = new AbortController();
    let currentTurn = 1;
    let postCount = 0;
    const postAfterBootstrap = async () => {
      await bootstrap;
      if (isEnvironmentTurnCurrent(0, 0, 1, currentTurn, controller.signal.aborted)) postCount += 1;
    };

    void postAfterBootstrap();
    controller.abort();
    currentTurn = 2;
    await Promise.resolve();
    expect(isEnvironmentTurnCurrent(0, 0, 1, currentTurn, controller.signal.aborted)).toBe(false);
    expect(postCount).toBe(0);
  });
});
