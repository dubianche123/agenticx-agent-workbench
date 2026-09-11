import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ComposerContextControls,
  composerPermissionLabel,
  composerWorkspaceLabel,
  effectiveComposerWorkspaceId,
  filterComposerWorkspaces,
} from "./ComposerContextControls";
import {
  RUN_MODE_OPTIONS,
  normalizeRunMode,
  runModeLabel,
} from "../constants/confirm-strategy-options";
import {
  ensureWorkspaceSessionBeforeFirstMessage,
  shouldKeepNewTopicWorkspaceControls,
} from "../utils/workspace-session-visibility";

describe("ComposerContextControls", () => {
  it("uses a clear label for the session default workspace", () => {
    expect(
      composerWorkspaceLabel(
        [{ id: "default", label: "default", path: "/tmp/workspace" }],
        "default",
      ),
    ).toBe("会话工作区");
  });

  it("shows an explicit workspace label and keeps the implicit default stable", () => {
    expect(
      composerWorkspaceLabel(
        [{ id: "finance", label: "财报分析", path: "/tmp/finance" }],
        "finance",
      ),
    ).toBe("财报分析");
    expect(composerWorkspaceLabel([], null)).toBe("会话工作区");
    expect(
      composerWorkspaceLabel(
        [{ id: "default", label: "default", path: "/tmp/session/default" }],
        null,
      ),
    ).toBe("会话工作区");
  });

  it("uses the session workspace implicitly without persisting a selection", () => {
    const workspaces = [
      { id: "project", label: "项目", path: "/tmp/project" },
      { id: "default", label: "default", path: "/tmp/session/default" },
    ];
    expect(effectiveComposerWorkspaceId(workspaces, null)).toBe("default");
    expect(effectiveComposerWorkspaceId(workspaces, "project")).toBe("project");
    expect(effectiveComposerWorkspaceId([], null)).toBeNull();
  });

  it("filters the compact workspace menu by label or path", () => {
    const workspaces = [
      { id: "alpha", label: "研究资料", path: "/Users/demo/research" },
      { id: "beta", label: "产品代码", path: "/Users/demo/agenticx" },
    ];

    expect(filterComposerWorkspaces(workspaces, "产品")).toEqual([workspaces[1]]);
    expect(filterComposerWorkspaces(workspaces, "RESEARCH")).toEqual([workspaces[0]]);
    expect(filterComposerWorkspaces(workspaces, "  ")).toEqual(workspaces);
  });

  it("materializes a session when workspace is the first new-topic action", async () => {
    const materialize = vi.fn(async () => "sid-workspace-first");
    await expect(ensureWorkspaceSessionBeforeFirstMessage("", materialize)).resolves.toBe(
      "sid-workspace-first",
    );
    expect(materialize).toHaveBeenCalledOnce();
  });

  it("reuses the current session when workspace is selected after materialization", async () => {
    const materialize = vi.fn(async () => "sid-unexpected");
    await expect(
      ensureWorkspaceSessionBeforeFirstMessage("sid-existing", materialize),
    ).resolves.toBe("sid-existing");
    expect(materialize).not.toHaveBeenCalled();
  });

  it("keeps the workspace control mounted while the first session is loading", () => {
    expect(shouldKeepNewTopicWorkspaceControls(false, true, true)).toBe(true);
    expect(shouldKeepNewTopicWorkspaceControls(false, true, false)).toBe(false);
    expect(shouldKeepNewTopicWorkspaceControls(true, true, true)).toBe(false);
  });

  it("uses the same three run modes as settings", () => {
    expect(RUN_MODE_OPTIONS.map((option) => option.value)).toEqual([
      "plan",
      "ask",
      "auto",
    ]);
    expect(composerPermissionLabel("ask")).toBe("每次询问");
    expect(composerPermissionLabel("auto")).toBe(runModeLabel("auto"));
  });

  it("falls back to the stricter mode for anything it does not recognise", () => {
    // 运行模式只有**一个**持久化字段（permissions.mode）。以前拆成两处，
    // 于是要做分布式回滚和对账——那是在给一个不该存在的问题加复杂度。
    for (const option of RUN_MODE_OPTIONS) {
      expect(normalizeRunMode(option.value)).toBe(option.value);
    }
    // 旧取值不再有专门的分支：后端已经不产出它们，到这里就只是「认不出来」的一种。
    // 认不出来的一律往严的方向兜底——落到 auto 会让人在不知情的情况下少收到确认，
    // 而他没有任何迹象可以发现；落到 ask 最坏只是多问几次。
    for (const raw of ["default", "semi-auto", "manual", "full_auto", "yolo", "", undefined, null]) {
      expect(normalizeRunMode(raw)).toBe("ask");
    }
  });

  it("shows workspace and permission controls for a new conversation", () => {
    const html = renderToStaticMarkup(
      <ComposerContextControls
        mode="new-topic"
        workspaces={[{ id: "default", label: "default", path: "/tmp/workspace" }]}
        activeTaskspaceId="default"
        workspacePanelOpen={false}
        onWorkspaceMenuOpen={vi.fn()}
        onWorkspaceSelect={vi.fn()}
        onCreateWorkspace={vi.fn(async () => true)}
        onOpenLocalFolder={vi.fn(async () => true)}
        runMode="auto"
        onRunModeChange={vi.fn(async () => true)}
      />,
    );
    expect(html).toContain("会话工作区");
    expect(html).toContain(runModeLabel("auto"));
    expect(html).toContain('aria-haspopup="menu"');
  });

  it("keeps only the permission control in an existing conversation", () => {
    const html = renderToStaticMarkup(
      <ComposerContextControls
        mode="conversation"
        workspaces={[{ id: "default", label: "default", path: "/tmp/workspace" }]}
        activeTaskspaceId="default"
        workspacePanelOpen={false}
        onWorkspaceMenuOpen={vi.fn()}
        onWorkspaceSelect={vi.fn()}
        onCreateWorkspace={vi.fn(async () => true)}
        onOpenLocalFolder={vi.fn(async () => true)}
        runMode="plan"
        onRunModeChange={vi.fn(async () => true)}
      />,
    );
    expect(html).not.toContain("会话工作区");
    expect(html).toContain("只读调研");
    expect(html).toContain('aria-haspopup="menu"');
  });

  it("keeps the shared workspace but removes run-mode controls for group chats", () => {
    const html = renderToStaticMarkup(
      <ComposerContextControls
        mode="conversation"
        showRunMode={false}
        workspaces={[{ id: "default", label: "default", path: "/tmp/workspace" }]}
        activeTaskspaceId="default"
        workspacePanelOpen={false}
        onWorkspaceMenuOpen={vi.fn()}
        onWorkspaceSelect={vi.fn()}
        onCreateWorkspace={vi.fn(async () => true)}
        onOpenLocalFolder={vi.fn(async () => true)}
        runMode="auto"
        onRunModeChange={vi.fn(async () => true)}
      />,
    );

    expect(html).toContain("会话工作区");
    expect(html).not.toContain("运行模式");
    expect(html).not.toContain(runModeLabel("auto"));
  });

  it("uses a distinct icon for every run mode", () => {
    const renderStrategy = (runMode: "plan" | "ask" | "auto") =>
      renderToStaticMarkup(
        <ComposerContextControls
          mode="conversation"
          workspaces={[]}
          activeTaskspaceId={null}
          workspacePanelOpen={false}
          onWorkspaceMenuOpen={vi.fn()}
          onWorkspaceSelect={vi.fn()}
          onCreateWorkspace={vi.fn(async () => true)}
          onOpenLocalFolder={vi.fn(async () => true)}
          runMode={runMode}
          onRunModeChange={vi.fn(async () => true)}
        />,
      );

    // 三档的图标必须互不相同；具体用哪个图标不钉死——auto 从告警三角换成中性的
    // circle-check，是因为它 fail-closed（见 confirm-strategy-options.ts 顶部说明），
    // 告警配色高估了它。
    const icons = (["plan", "ask", "auto"] as const).map((mode) => {
      const match = /lucide lucide-([a-z-]+)/u.exec(renderStrategy(mode));
      return match?.[1] ?? "";
    });
    expect(icons.every(Boolean)).toBe(true);
    expect(new Set(icons).size).toBe(3);
    expect(icons[2]).not.toBe("triangle-alert");
    // 措辞可以变，但「代我批准不等于全放行」这层意思必须还在——把一个 fail-closed
    // 的档位描述成全放行，会让人不敢用它、退回去逐次点确认，然后点到麻木。
    const autoDescription = RUN_MODE_OPTIONS[2].description;
    expect(autoDescription).toContain("仍然会问");
    // 反向也要钉住。这句话错过两次，方向相反：先是写窄（「低风险操作由我代你批准」），
    // 后来矫枉过正写成「沙箱兜不住的操作由我代你批准」——那正好是机制的反面。沙箱兜得住
    // 的根本不产生确认请求，交上来的**就是**兜不住的，而这一档对它们几乎一律照问不误。
    // 往宽了写更贵：用户以为自己开的是全自动，于是把弹出来的框当噪音随手点掉。
    expect(autoDescription).not.toContain("沙箱兜不住的操作由我");
  });

  it("keeps new-topic controls inline without a second-row padding wrapper", () => {
    const html = renderToStaticMarkup(
      <ComposerContextControls
        mode="new-topic"
        workspaces={[{ id: "default", label: "default", path: "/tmp/workspace" }]}
        activeTaskspaceId="default"
        workspacePanelOpen={false}
        onWorkspaceMenuOpen={vi.fn()}
        onWorkspaceSelect={vi.fn()}
        onCreateWorkspace={vi.fn(async () => true)}
        onOpenLocalFolder={vi.fn(async () => true)}
        runMode="ask"
        onRunModeChange={vi.fn(async () => true)}
      />,
    );

    expect(html).not.toContain("px-2.5 pb-2.5 pt-1");
  });
});
