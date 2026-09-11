import { describe, expect, it } from "vitest";
import type { Message, SubAgent } from "../store";
import {
  appendMissingImageMarkdown,
  artifactBaseName,
  artifactHomeRelativeKey,
  collectSessionFileChanges,
  collectArtifactPathsFromAgentMessages,
  collectArtifactPathsFromChatMessages,
  collectArtifactPathsFromPersistedSessionFiles,
  collectSessionArtifactPaths,
  collectTurnArtifactPaths,
  collectTurnFileChanges,
  parseSessionMessageFilePayload,
  collectTurnPreviewImagePaths,
  collectWorkspaceListingArtifactPaths,
  displayChatLocalPath,
  expandArtifactHomePath,
  isInAppArtifactPreviewPath,
  isInAppHtmlPreviewPath,
  isPrivateSessionArtifactPath,
  isRuntimeArtifactPath,
  isSessionArtifactPathVisible,
  isWalkableWorkspaceArtifactDir,
  looksLikeDirectoryPath,
  matchesHandoffAncestor,
  matchesHandoffPath,
  orderTurnArtifactsForCard,
  pathToFileUrl,
  pickPrimaryTurnArtifact,
  preferAnimatedPreviewImages,
  selectSessionDeliverablePaths,
} from "./session-artifacts";

function toolMsg(partial: Partial<Message> & Pick<Message, "id" | "content">): Message {
  return {
    role: "tool",
    timestamp: 1,
    ...partial,
  };
}

function assistantMsg(partial: Partial<Message> & Pick<Message, "id" | "content">): Message {
  return {
    role: "assistant",
    timestamp: 1,
    ...partial,
  };
}

describe("collectSessionArtifactPaths", () => {
  it("collects file_write path from toolArgs and OK: wrote body", () => {
    const messages: Message[] = [
      toolMsg({
        id: "t1",
        toolName: "file_write",
        toolArgs: { path: "/workspace/.agenticx/avatars/x/workspace/charts/a.svg" },
        content: "✅ file_write 结果: OK: wrote /workspace/.agenticx/avatars/x/workspace/charts/a.svg",
      }),
      toolMsg({
        id: "t2",
        toolName: "file_edit",
        toolArgs: { path: "/workspace/.agenticx/avatars/x/workspace/charts/b.mmd" },
        content: "OK: edited /workspace/.agenticx/avatars/x/workspace/charts/b.mmd (120 chars)",
      }),
    ];
    expect(collectSessionArtifactPaths(messages)).toEqual([
      "/workspace/.agenticx/avatars/x/workspace/charts/a.svg",
      "/workspace/.agenticx/avatars/x/workspace/charts/b.mmd",
    ]);
  });

  it("skips directory-only 保存路径 labels (join base, not an artifact row)", () => {
    const messages: Message[] = [
      assistantMsg({
        id: "a1",
        content: "保存路径：`/workspace/.agenticx/avatars/x/workspace/charts/`",
      }),
    ];
    expect(collectSessionArtifactPaths(messages)).toEqual([]);
  });

  it("joins markdown table filenames under 保存路径 directory", () => {
    const messages: Message[] = [
      assistantMsg({
        id: "a1",
        content: [
          "| 文件 | 大小 |",
          "| --- | --- |",
          "| A股科技股后续走势分析框架.mmd | 1.9 KB |",
          "| A股科技股三种情景对比.svg | 8.8 KB |",
          "",
          "保存路径：`/workspace/.agenticx/avatars/x/workspace/charts/`",
        ].join("\n"),
      }),
    ];
    expect(collectSessionArtifactPaths(messages)).toEqual([
      "/workspace/.agenticx/avatars/x/workspace/charts/A股科技股后续走势分析框架.mmd",
      "/workspace/.agenticx/avatars/x/workspace/charts/A股科技股三种情景对比.svg",
    ]);
  });

  it("collects absolute bash redirect targets", () => {
    const messages: Message[] = [
      toolMsg({
        id: "t1",
        toolName: "bash_exec",
        toolArgs: {
          command: "cat > /workspace/.agenticx/avatars/x/workspace/charts/c.svg <<'EOF'\n<svg/>\nEOF",
        },
        content: "✅ bash_exec 结果: ok",
      }),
    ];
    expect(collectSessionArtifactPaths(messages)).toEqual([
      "/workspace/.agenticx/avatars/x/workspace/charts/c.svg",
    ]);
  });

  it("collects bash_exec JSON stdout output file path (openpyxl-style save)", () => {
    const path =
      "/workspace/demo/售前/DemoAuto/demo-platform-cost-review.xlsx";
    const messages: Message[] = [
      toolMsg({
        id: "t1",
        toolName: "bash_exec",
        toolArgs: {
          command: "python3 - <<'PY'\nwb.save(out)\nprint(json.dumps({'output': str(out)}))\nPY",
        },
        content: [
          "exit_code=0",
          "stdout:",
          "{",
          '  "ok": true,',
          `  "output": "${path}",`,
          '  "repo_facts": [',
          '    { "path": "/workspace/demo/projects/gateway/richinfo-code" }',
          "  ]",
          "}",
        ].join("\n"),
      }),
    ];
    expect(collectSessionArtifactPaths(messages)).toEqual([path]);
  });

  it("collects a registered document_generate JSON path and filters turn internals", () => {
    const paths = [
      "/workspace/user/Desktop/generated-report.md",
      "/workspace/user/Desktop/generated-report.html",
      "/workspace/user/Desktop/generated-report.doc",
    ];
    const sessionOutput = "~/.agenticx/sessions/s1/turns/t1/outputs/generated.md";
    const messages: Message[] = [
      ...paths.map((path, index) => toolMsg({
        id: `t-document-${index}`,
        toolName: "document_generate",
        content: JSON.stringify({ ok: true, path, title: "生成成品", format: path.split(".").pop() }),
      })),
      toolMsg({
        id: "t-document-session-output",
        toolName: "document_generate",
        content: JSON.stringify({ ok: true, path: sessionOutput, title: "会话成品", format: "md" }),
      }),
      toolMsg({
        id: "t-private",
        toolName: "document_generate",
        content: JSON.stringify({ ok: true, path: "~/.agenticx/sessions/s1/turns/t1/checkpoint.json", format: "json" }),
      }),
    ];
    expect(collectSessionArtifactPaths(messages)).toEqual([...paths, sessionOutput]);
    expect(isPrivateSessionArtifactPath("~/.agenticx/sessions/s1/turns/t1/checkpoint.json")).toBe(true);
  });

  it("collects path after 新 Excel 已保存 / 路径： multiline prose", () => {
    const path =
      "/workspace/demo/售前/DemoAuto/demo-platform-cost-review.xlsx";
    const messages: Message[] = [
      assistantMsg({
        id: "a1",
        content: [
          "团长，已完成。",
          "",
          "## 1. 新 Excel 已保存",
          "",
          "路径：",
          "",
          `\`${path}\``,
          "",
          "---",
          "",
          "## 2. 口径",
        ].join("\n"),
      }),
    ];
    expect(collectSessionArtifactPaths(messages)).toEqual([path]);
  });

  it("collects same-line 路径： absolute file", () => {
    const path = "/workspace/user/out/quote.xlsx";
    const messages: Message[] = [
      assistantMsg({
        id: "a1",
        content: `路径：\`${path}\``,
      }),
    ];
    expect(collectSessionArtifactPaths(messages)).toEqual([path]);
  });

  it("does not treat prose「…路径」+ hidden dir ~/.codewiki as an artifact", () => {
    const messages: Message[] = [
      assistantMsg({
        id: "a1",
        content: [
          "**关键发现：CodeWiki 自身不生成任何文档内容。** 它只是一个**元数据管理器**：",
          "- `config.rs`：管理 `~/.codewiki/<project>/` 路径",
          "- 实际的 Wiki 文档生成完全依赖外部 AI agent",
        ].join("\n"),
      }),
    ];
    expect(collectSessionArtifactPaths(messages)).toEqual([]);
  });

  it("rejects placeholder paths with <> and pure hidden-dir basenames", () => {
    const messages: Message[] = [
      assistantMsg({
        id: "a1",
        content: "路径：`~/.codewiki/<project>/notes.md`",
      }),
      assistantMsg({
        id: "a2",
        content: "路径：`~/.codewiki`",
      }),
    ];
    expect(collectSessionArtifactPaths(messages)).toEqual([]);
  });

  it("merges sub-agent outputs and extra paths with dedupe", () => {
    const path = "/workspace/user/out/report.md";
    const messages: Message[] = [
      toolMsg({
        id: "t1",
        toolName: "file_write",
        toolArgs: { path },
        content: `OK: wrote ${path}`,
      }),
    ];
    const subAgents: SubAgent[] = [
      {
        id: "s1",
        name: "worker",
        role: "worker",
        status: "completed",
        task: "x",
        resultFile: path,
        outputFiles: ["/workspace/user/out/extra.csv"],
        events: [],
      },
    ];
    expect(collectSessionArtifactPaths(messages, subAgents, [path, "/tmp/pin.bin"])).toEqual([
      path,
      "/workspace/user/out/extra.csv",
      "/tmp/pin.bin",
    ]);
  });

  it("only exposes completed sub-agent outputs", () => {
    const failedPath = "/workspace/user/out/failed.md";
    const cancelledPath = "/workspace/user/out/cancelled.md";
    const pendingPath = "/workspace/user/out/pending.md";
    const completedPath = "/workspace/user/out/completed.md";
    const subAgents: SubAgent[] = [
      {
        id: "failed",
        name: "failed",
        role: "worker",
        status: "failed",
        task: "x",
        resultFile: failedPath,
        outputFiles: [failedPath],
        events: [],
      },
      {
        id: "cancelled",
        name: "cancelled",
        role: "worker",
        status: "cancelled",
        task: "x",
        resultFile: cancelledPath,
        outputFiles: [cancelledPath],
        events: [],
      },
      {
        id: "pending",
        name: "pending",
        role: "worker",
        status: "pending",
        task: "x",
        resultFile: pendingPath,
        outputFiles: [pendingPath],
        events: [],
      },
      {
        id: "completed",
        name: "completed",
        role: "worker",
        status: "completed",
        task: "x",
        resultFile: completedPath,
        outputFiles: [completedPath],
        events: [],
      },
    ];
    expect(collectSessionArtifactPaths([], subAgents)).toEqual([completedPath]);
  });

  it("filters by ownerSessionId when provided", () => {
    const messages: Message[] = [
      toolMsg({
        id: "t1",
        ownerSessionId: "sess-a",
        toolName: "file_write",
        toolArgs: { path: "/tmp/a.txt" },
        content: "OK: wrote /tmp/a.txt",
      }),
      toolMsg({
        id: "t2",
        ownerSessionId: "sess-b",
        toolName: "file_write",
        toolArgs: { path: "/tmp/b.txt" },
        content: "OK: wrote /tmp/b.txt",
      }),
    ];
    expect(collectSessionArtifactPaths(messages, null, null, "sess-a")).toEqual(["/tmp/a.txt"]);
  });

  it("keeps legacy untagged rows but rejects an explicit foreign owner", () => {
    const messages: Message[] = [
      toolMsg({
        id: "t-legacy",
        toolName: "file_write",
        toolArgs: { path: "/tmp/legacy.txt" },
        content: "OK: wrote /tmp/legacy.txt",
      }),
      toolMsg({
        id: "t-other",
        ownerSessionId: "sess-b",
        toolName: "file_write",
        toolArgs: { path: "/tmp/other.txt" },
        content: "OK: wrote /tmp/other.txt",
      }),
    ];
    expect(collectSessionArtifactPaths(messages, null, null, "sess-a")).toEqual([
      "/tmp/legacy.txt",
    ]);
  });

  it("dedupes ~/Desktop/file and /Users/<name>/Desktop/file as one artifact", () => {
    const abs = "/workspace/user/Desktop/harness_ai_security_proposal.md";
    const tilde = "~/Desktop/harness_ai_security_proposal.md";
    const messages: Message[] = [
      toolMsg({
        id: "t1",
        toolName: "file_write",
        toolArgs: { path: abs },
        content: `OK: wrote ${abs}`,
      }),
      assistantMsg({
        id: "a1",
        content: `报告已保存至 \`${tilde}\``,
      }),
    ];
    const paths = collectSessionArtifactPaths(messages);
    expect(paths).toEqual([abs]);
  });

  it("upgrades tilde path to absolute when absolute form arrives later", () => {
    const abs = "/workspace/user/Desktop/attack_chain.svg";
    const tilde = "~/Desktop/attack_chain.svg";
    const messages: Message[] = [
      assistantMsg({
        id: "a1",
        content: `已保存至 \`${tilde}\``,
      }),
      toolMsg({
        id: "t1",
        toolName: "file_write",
        toolArgs: { path: abs },
        content: `OK: wrote ${abs}`,
      }),
    ];
    expect(collectSessionArtifactPaths(messages)).toEqual([abs]);
  });
});

describe("collectArtifactPathsFromAgentMessages", () => {
  it("collects HTML from agent_messages tool name + OK: wrote (chat pane gap)", () => {
    const html = "/workspace/user/cursor_billing_report.html";
    const rows = [
      {
        role: "assistant",
        content: " ",
        tool_calls: [
          {
            id: "functions.file_write:24",
            type: "function",
            function: {
              name: "file_write",
              arguments: JSON.stringify({ path: html, content: "<!DOCTYPE html>" }),
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "functions.file_write:24",
        name: "file_write",
        content: `OK: wrote ${html}`,
      },
      {
        role: "assistant",
        content: `## 分析完成\n报告路径：\`${html}\``,
      },
    ];
    expect(collectArtifactPathsFromAgentMessages(rows)).toEqual([html]);
  });

  it("does not collect path when paired tool result is ERROR / path escapes", () => {
    const p = "/workspace/research-agent/requirements.txt";
    const rows = [
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call-edit-1",
            type: "function",
            function: {
              name: "file_edit",
              arguments: JSON.stringify({ path: p, old_str: "a", new_str: "b" }),
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call-edit-1",
        name: "file_edit",
        content: `ERROR: path escapes workspace: ${p}`,
      },
    ];
    expect(collectArtifactPathsFromAgentMessages(rows)).toEqual([]);
  });

  it("collects path when paired tool result is OK: edited", () => {
    const p = "/workspace/user/x/a.txt";
    const rows = [
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call-edit-ok",
            type: "function",
            function: {
              name: "file_edit",
              arguments: JSON.stringify({ path: p, old_str: "a", new_str: "b" }),
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call-edit-ok",
        name: "file_edit",
        content: `OK: edited ${p}`,
      },
    ];
    expect(collectArtifactPathsFromAgentMessages(rows)).toEqual([p]);
  });
});

describe("collectSessionArtifactPaths — successful write only", () => {
  it("skips toolArgs.path when toolStatus is error + ERROR body", () => {
    const p = "/workspace/research-agent/requirements.txt";
    const messages: Message[] = [
      toolMsg({
        id: "t-err",
        toolName: "file_edit",
        toolStatus: "error",
        toolArgs: { path: p },
        content: `ERROR: path escapes workspace: ${p}`,
      }),
    ];
    expect(collectSessionArtifactPaths(messages)).toEqual([]);
  });

  it("collects toolArgs.path when OK: edited and no failure status", () => {
    const p = "/workspace/user/x/a.txt";
    const messages: Message[] = [
      toolMsg({
        id: "t-ok",
        toolName: "file_edit",
        toolStatus: "done",
        toolArgs: { path: p },
        content: `OK: edited ${p}`,
      }),
    ];
    expect(collectSessionArtifactPaths(messages)).toEqual([p]);
  });

  it("still collects when toolStatus is undefined and body is OK: edited", () => {
    const p = "/workspace/user/x/a.txt";
    const messages: Message[] = [
      toolMsg({
        id: "t-legacy",
        toolName: "file_edit",
        toolArgs: { path: p },
        content: `OK: edited ${p}`,
      }),
    ];
    expect(collectSessionArtifactPaths(messages)).toEqual([p]);
  });

  it("skips redirect targets from failed bash_exec calls", () => {
    const p = "/workspace/.agenticx/taskspaces/session/default/game/index.html";
    const messages: Message[] = [
      toolMsg({
        id: "bash-err",
        toolName: "bash_exec",
        toolStatus: "error",
        toolArgs: { command: "cat > " + p + " <<'EOF'\n<html></html>\nEOF" },
        content: "工具 'bash_exec' 不在当前允许列表中，已拒绝执行。",
      }),
    ];
    expect(collectSessionArtifactPaths(messages)).toEqual([]);
  });

  it.each([
    ["cancelled status", { toolStatus: "cancelled" as const, content: "redirect was cancelled" }],
    ["nonzero numeric exit", { content: "exit_code=1\nstdout: /workspace/user/out/failed.md" }],
    ["nonzero text exit", { content: '{"exit_code":"130","output":"/workspace/user/out/failed.md"}' }],
    ["preview nonzero exit", { content: "stdout: /workspace/user/out/failed.md", toolResultPreview: "exit_code: 2" }],
    ["permission denied", { content: "permission denied: /workspace/user/out/failed.md" }],
    ["refused", { content: "command refused by policy: /workspace/user/out/failed.md" }],
  ])("fails closed for bash_exec %s", (_label, partial) => {
    const target = "/workspace/user/out/failed.md";
    const messages: Message[] = [
      toolMsg({
        id: "bash-failed-shape",
        toolName: "bash_exec",
        toolArgs: { command: `cat > ${target}` },
        ...partial,
      }),
    ];
    expect(collectSessionArtifactPaths(messages)).toEqual([]);
  });

  it("keeps legacy bash_exec redirect paths when no failure signal exists", () => {
    const target = "/workspace/user/out/legacy.md";
    expect(
      collectSessionArtifactPaths([
        toolMsg({
          id: "bash-legacy",
          toolName: "bash_exec",
          toolArgs: { command: `cat > ${target}` },
          content: "stdout: wrote file",
        }),
      ]),
    ).toEqual([target]);
  });

  it("does not collect in-flight bash_exec redirects", () => {
    const target = "/workspace/user/out/running.md";
    expect(
      collectSessionArtifactPaths([
        toolMsg({
          id: "bash-running",
          toolName: "bash_exec",
          toolStatus: "running",
          toolArgs: { command: `cat > ${target}` },
          content: "partial stdout",
        }),
      ]),
    ).toEqual([]);
  });
});

describe("collectArtifactPathsFromChatMessages (messages.json)", () => {
  it("collects file_write from snake_case chat history rows", () => {
    const svg = "/workspace/user/myWork/research-project/assets/fig2-open-source-landscape.svg";
    const rows = [
      {
        role: "tool",
        tool_name: "file_write",
        tool_status: "done",
        tool_args: { path: svg, content: "<svg xmlns='huge-payload'/>" },
        content: `OK: wrote ${svg}`,
      },
    ];
    expect(collectArtifactPathsFromChatMessages(rows)).toEqual([svg]);
  });

  it("collects bash_exec absolute path from stdout and labeled assistant save", () => {
    const pdf = "/workspace/user/myWork/research-project/ontology-landscape-report.pdf";
    const rows = [
      {
        role: "tool",
        tool_name: "bash_exec",
        tool_args: { command: `ls -la "${pdf}"` },
        content: `exit_code=0\nstdout:\n-rw-r--r-- 1 damon staff 2686051 ${pdf}\n`,
      },
      {
        role: "assistant",
        content: `路径：\n\`${pdf}\``,
      },
    ];
    expect(collectArtifactPathsFromChatMessages(rows)).toEqual([pdf]);
  });

  it("does not collect denied file_edit from chat history", () => {
    const p = "/workspace/research-agent/requirements.txt";
    const rows = [
      {
        role: "tool",
        tool_name: "file_edit",
        tool_status: "done",
        tool_args: { path: p },
        content: `ERROR: path escapes workspace: ${p}`,
      },
    ];
    expect(collectArtifactPathsFromChatMessages(rows)).toEqual([]);
  });

  it("accepts { messages: [...] } wrapper payload", () => {
    const md = "/workspace/user/report.md";
    const payload = {
      messages: [
        {
          role: "tool",
          tool_name: "file_write",
          tool_args: { path: md },
          content: `OK: wrote ${md}`,
        },
      ],
    };
    expect(collectArtifactPathsFromChatMessages(parseSessionMessageFilePayload(payload))).toEqual([
      md,
    ]);
  });
});

describe("collectArtifactPathsFromPersistedSessionFiles — tail vs full history", () => {
  it("keeps older writes when agent_messages tail has no file_write", () => {
    const svg = "/workspace/user/myWork/research-project/assets/fig1-palantir-product-shape.svg";
    const pdf = "/workspace/user/myWork/research-project/ontology-landscape-report.pdf";
    const chatHistoryRows = [
      {
        role: "tool",
        tool_name: "file_write",
        tool_args: { path: svg },
        content: `OK: wrote ${svg}`,
      },
    ];
    const agentMessageRows = [
      { role: "user", content: "飞书文档也同步改了吗" },
      {
        role: "assistant",
        content: `路径：\n\`${pdf}\``,
      },
    ];
    expect(
      collectArtifactPathsFromPersistedSessionFiles({
        chatHistoryRows,
        agentMessageRows,
      }),
    ).toEqual([svg, pdf]);
  });
});

describe("denied write must not become an artifact", () => {
  it("reproduces privilege-escalation accident: denied file_edit is not collected", () => {
    const p = "/workspace/research-agent/requirements.txt";
    const rows = [
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "functions.file_edit:denied",
            type: "function",
            function: {
              name: "file_edit",
              arguments: JSON.stringify({
                path: p,
                old_str: "langchain>=0.1.0",
                new_str: "langchain>=0.1.0\ntorch==2.2.0",
              }),
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "functions.file_edit:denied",
        name: "file_edit",
        content: `ERROR: path escapes workspace: ${p}`,
      },
    ];
    expect(collectArtifactPathsFromAgentMessages(rows)).toEqual([]);

    const paneMessages: Message[] = [
      toolMsg({
        id: "pane-denied",
        toolName: "file_edit",
        toolStatus: "error",
        toolArgs: { path: p },
        content: `ERROR: path escapes workspace: ${p}`,
      }),
    ];
    expect(collectSessionArtifactPaths(paneMessages)).toEqual([]);
  });

  it("preserves persisted tool status and blocks cancelled or nonzero bash rows", () => {
    const cancelled = "/workspace/user/out/cancelled.md";
    const failed = "/workspace/user/out/failed.md";
    const ok = "/workspace/user/out/ok.md";
    expect(
      collectArtifactPathsFromChatMessages([
        {
          role: "tool",
          tool_name: "bash_exec",
          tool_status: "cancelled",
          tool_args: { command: `cat > ${cancelled}` },
          content: "cancelled",
        },
      ]),
    ).toEqual([]);
    expect(
      collectArtifactPathsFromChatMessages([
        {
          role: "tool",
          tool_name: "bash_exec",
          tool_status: "done",
          tool_args: { command: `cat > ${failed}` },
          content: `exit_code: "1"\nstdout: ${failed}`,
        },
      ]),
    ).toEqual([]);
    expect(
      collectArtifactPathsFromChatMessages([
        {
          role: "tool",
          tool_name: "bash_exec",
          tool_status: "done",
          tool_args: { command: `cat > ${ok}` },
          content: `exit_code=0\nstdout: ${ok}`,
        },
      ]),
    ).toEqual([ok]);
  });

  it("maps persisted failure and success status aliases before collecting bash paths", () => {
    const failedStatuses = ["failed", "rejected", "canceled"];
    for (const status of failedStatuses) {
      const target = `/workspace/user/out/${status}.md`;
      expect(
        collectArtifactPathsFromChatMessages([
          {
            role: "tool",
            tool_name: "bash_exec",
            tool_status: status,
            tool_args: { command: `cat > ${target}` },
            content: "legacy output without an exit code",
          },
        ]),
      ).toEqual([]);
    }

    const success = "/workspace/user/out/success-alias.md";
    expect(
      collectArtifactPathsFromChatMessages([
        {
          role: "tool",
          tool_name: "bash_exec",
          tool_status: "success",
          tool_args: { command: `cat > ${success}` },
          content: "legacy output without an exit code",
        },
      ]),
    ).toEqual([success]);
  });
});

describe("artifact helpers", () => {
  it("scopes identity and runtime bookkeeping filtering to trusted taskspaces", () => {
    const runtimeRoot = "/workspace/.agenticx/taskspaces/s1/default";
    const isolatedRuntimeRoot = "/tmp/agenticx-workflow-home/taskspaces/s2/default";
    expect(isRuntimeArtifactPath(`${runtimeRoot}/IDENTITY.md`)).toBe(true);
    expect(isRuntimeArtifactPath(`${runtimeRoot}/MEMORY.md`)).toBe(true);
    expect(isRuntimeArtifactPath(`${runtimeRoot}/memory/2026-09-11.md`)).toBe(true);
    expect(isRuntimeArtifactPath(`${runtimeRoot}/agent_messages.json`)).toBe(true);
    expect(isRuntimeArtifactPath("/workspace/IDENTITY.md")).toBe(false);
    expect(isRuntimeArtifactPath("/workspace/MEMORY.md")).toBe(false);
    expect(isRuntimeArtifactPath("/workspace/agent_messages.json")).toBe(false);
    expect(isRuntimeArtifactPath(`${runtimeRoot}/reports/MEMORY.md`)).toBe(false);
    expect(isRuntimeArtifactPath(`${isolatedRuntimeRoot}/IDENTITY.md`)).toBe(true);
    expect(isRuntimeArtifactPath(`${isolatedRuntimeRoot}/memory/today.md`)).toBe(true);
    expect(isRuntimeArtifactPath("/workspace/customer-report.md")).toBe(false);
    expect(isSessionArtifactPathVisible("/workspace/IDENTITY.md")).toBe(true);
    expect(isSessionArtifactPathVisible("/workspace/MEMORY.md")).toBe(true);
    expect(isSessionArtifactPathVisible("/workspace/customer-report.md")).toBe(true);
    expect(
      isSessionArtifactPathVisible("~/.agenticx/sessions/s1/turns/t1/logs/runtime.jsonl"),
    ).toBe(false);
  });
  it("hides legacy sibling superseded archives without hiding user memory folders", () => {
    expect(
      isPrivateSessionArtifactPath(
        "~/.agenticx/sessions/s1/turns/t1/superseded/report.docx",
      ),
    ).toBe(true);
    expect(
      isPrivateSessionArtifactPath(
        "/workspace/.agenticx/sessions/s1/turns/t1/checkpoint/superseded/report.docx",
      ),
    ).toBe(true);
    expect(isPrivateSessionArtifactPath("/workspace/memory/report.md")).toBe(false);
    expect(isPrivateSessionArtifactPath("/workspace/superseded/report.docx")).toBe(false);
  });
  it("expandArtifactHomePath and artifactHomeRelativeKey", () => {
    expect(expandArtifactHomePath("~/Desktop/a.md", "/workspace/user")).toBe(
      "/workspace/user/Desktop/a.md",
    );
    expect(artifactHomeRelativeKey("/workspace/user/Desktop/a.md")).toBe("~/Desktop/a.md");
    expect(artifactHomeRelativeKey("~/Desktop/a.md")).toBe("~/Desktop/a.md");
    expect(artifactHomeRelativeKey("/tmp/a.md")).toBeNull();
  });

  it("artifactBaseName", () => {
    expect(artifactBaseName("/a/b/c.svg")).toBe("c.svg");
    expect(artifactBaseName("/a/b/charts/")).toBe("charts");
  });

  it("looksLikeDirectoryPath", () => {
    expect(looksLikeDirectoryPath("/Users/x/charts/")).toBe(true);
    expect(looksLikeDirectoryPath("/Users/x/charts")).toBe(true);
    expect(looksLikeDirectoryPath("/Users/x/charts/a.svg")).toBe(false);
  });

  it("isInAppHtmlPreviewPath", () => {
    expect(isInAppHtmlPreviewPath("/tmp/report.html")).toBe(true);
    expect(isInAppHtmlPreviewPath("/tmp/Report.HTM")).toBe(true);
    expect(isInAppHtmlPreviewPath("/tmp/a.svg")).toBe(false);
  });

  it("isInAppArtifactPreviewPath", () => {
    expect(isInAppArtifactPreviewPath("/tmp/a.svg")).toBe(true);
    expect(isInAppArtifactPreviewPath("/tmp/a.mmd")).toBe(true);
    expect(isInAppArtifactPreviewPath("/tmp/a.pdf")).toBe(true);
    expect(isInAppArtifactPreviewPath("/tmp/a.docx")).toBe(true);
    expect(isInAppArtifactPreviewPath("/tmp/report.html")).toBe(false);
    expect(isInAppArtifactPreviewPath("/tmp/charts/")).toBe(false);
  });

  it("pathToFileUrl", () => {
    expect(pathToFileUrl("/workspace/user/a.html")).toBe("file:///workspace/user/a.html");
    expect(pathToFileUrl("C:/workspace/user/a.html")).toBe("file:///C:/workspace/user/a.html");
  });
});

describe("collectSessionArtifactPaths — bash stdout + table cells", () => {
  const gif =
    "/workspace/.agenticx/taskspaces/35ca2867-f843-4013-bfc2-d328c35d2427/default/archscribe-login/login-swimlane.gif";
  const png =
    "/workspace/.agenticx/taskspaces/35ca2867-f843-4013-bfc2-d328c35d2427/default/archscribe-login/login-swimlane.png";
  const svg =
    "/workspace/.agenticx/taskspaces/35ca2867-f843-4013-bfc2-d328c35d2427/default/archscribe-login/login-swimlane.svg";

  it("collects absolute image paths echoed in bash_exec stdout (no redirect / no JSON output)", () => {
    const messages: Message[] = [
      toolMsg({
        id: "t-ls",
        toolName: "bash_exec",
        toolArgs: {
          command:
            'OUTPUT_DIR="/workspace/.agenticx/taskspaces/35ca2867-f843-4013-bfc2-d328c35d2427/default/archscribe-login"\necho "GIF: $OUTPUT_DIR/login-swimlane.gif"',
        },
        content: [
          "exit_code=0",
          "stdout:",
          "=== 文件路径 ===",
          `PNG: ${png}`,
          `GIF: ${gif}`,
          `SVG: ${svg}`,
          "stderr:",
          "(empty)",
        ].join("\n"),
      }),
    ];
    expect(collectSessionArtifactPaths(messages)).toEqual([png, gif, svg]);
  });

  it("does not collect skill source files listed by find/ls in bash stdout", () => {
    const messages: Message[] = [
      toolMsg({
        id: "t-find",
        toolName: "bash_exec",
        toolArgs: { command: "find ~/.agenticx/skills/registry/archscribe -type f" },
        content: [
          "exit_code=0",
          "stdout:",
          "/workspace/.agenticx/skills/registry/archscribe/SKILL.md",
          "/workspace/.agenticx/skills/registry/archscribe/scripts/render_animated_diagram.py",
        ].join("\n"),
      }),
    ];
    expect(collectSessionArtifactPaths(messages)).toEqual([]);
  });

  it("joins table filenames in any column under 路径： directory", () => {
    const messages: Message[] = [
      assistantMsg({
        id: "a-final",
        content: [
          "### 产出文件",
          "",
          "| 格式 | 文件名 | 大小 |",
          "|---|---|---|",
          "| PNG（静态） | `login-swimlane.png` | 274 KB |",
          "| GIF（动画） | `login-swimlane.gif` | 702 KB |",
          "| SVG（矢量） | `login-swimlane.svg` | 2.8 MB |",
          "",
          "路径：`/workspace/.agenticx/taskspaces/35ca2867-f843-4013-bfc2-d328c35d2427/default/archscribe-login/`",
        ].join("\n"),
      }),
    ];
    expect(collectSessionArtifactPaths(messages)).toEqual([png, gif, svg]);
  });
});

describe("turn preview images", () => {
  it("prefers animated gif over png/svg with the same stem", () => {
    const dir =
      "/workspace/.agenticx/taskspaces/s/default/archscribe-login";
    expect(
      preferAnimatedPreviewImages([
        `${dir}/login-swimlane.png`,
        `${dir}/login-swimlane.gif`,
        `${dir}/login-swimlane.svg`,
        `${dir}/login-swimlane-spec.json`,
      ]),
    ).toEqual([`${dir}/login-swimlane.gif`]);
  });

  it("appends markdown images only for paths not already in the body", () => {
    const gif = "/workspace/user/out/login-swimlane.gif";
    const png = "/workspace/user/out/other.png";
    const body = `已生成\n\n![已有](${gif})`;
    expect(appendMissingImageMarkdown(body, [gif, png])).toBe(
      `${body}\n\n![other.png](${png})`,
    );
  });

  it("collectTurnPreviewImagePaths only embeds on the last assistant of the turn", () => {
    const gif =
      "/workspace/.agenticx/taskspaces/s/default/archscribe-login/login-swimlane.gif";
    const messages: Message[] = [
      assistantMsg({ id: "mid", content: "渲染中" }),
      toolMsg({
        id: "t-out",
        toolName: "bash_exec",
        toolArgs: { command: "ls" },
        content: `GIF: ${gif}`,
      }),
      assistantMsg({ id: "final", content: "完成" }),
    ];
    expect(collectTurnPreviewImagePaths(messages, "mid")).toEqual([]);
    expect(collectTurnPreviewImagePaths(messages, "final")).toEqual([gif]);
  });
});

describe("turn artifacts + primary pick", () => {
  it("collects deliverables from the latest assistant turn and picks html first", () => {
    const html = "/workspace/user/out/report.html";
    const py = "/workspace/user/out/notes.py";
    const messages: Message[] = [
      { id: "u1", role: "user", content: "写一份报告", timestamp: 1 },
      toolMsg({
        id: "t-html",
        toolName: "file_write",
        toolArgs: { path: html },
        content: `OK: wrote ${html}`,
      }),
      toolMsg({
        id: "t-py",
        toolName: "file_write",
        toolArgs: { path: py },
        content: `OK: wrote ${py}`,
      }),
      assistantMsg({ id: "final", content: `路径：\`${html}\`` }),
    ];

    expect(collectTurnArtifactPaths(messages, "final")).toEqual([html, py]);
    expect(pickPrimaryTurnArtifact([py, html])).toBe(html);
    expect(orderTurnArtifactsForCard([py, html, py])).toEqual([html, py]);
  });

  it("scopes turn artifacts and turn changes to the requested owner session", () => {
    const messages: Message[] = [
      { id: "u-a", role: "user", content: "a", timestamp: 1, ownerSessionId: "sess-a" },
      toolMsg({
        id: "t-a",
        ownerSessionId: "sess-a",
        toolName: "file_write",
        toolArgs: { path: "/tmp/a.txt", content: "a\n" },
        content: "OK: wrote /tmp/a.txt",
      }),
      { id: "as-a", role: "assistant", content: "a done", timestamp: 2, ownerSessionId: "sess-a" },
      { id: "u-b", role: "user", content: "b", timestamp: 3, ownerSessionId: "sess-b" },
      toolMsg({
        id: "t-b",
        ownerSessionId: "sess-b",
        toolName: "file_write",
        toolArgs: { path: "/tmp/b.txt", content: "b\n" },
        content: "OK: wrote /tmp/b.txt",
      }),
      { id: "as-b", role: "assistant", content: "b done", timestamp: 4, ownerSessionId: "sess-b" },
    ];
    expect(collectTurnArtifactPaths(messages, "as-a", "sess-a")).toEqual(["/tmp/a.txt"]);
    expect(collectTurnArtifactPaths(messages, "as-a", "sess-b")).toEqual([]);
    expect(collectTurnFileChanges(messages, "as-a", "sess-a")).toEqual([
      { path: "/tmp/a.txt", added: 1, removed: 0 },
    ]);
  });

  it("counts file_edit replacement spans independently as new lines and old lines", () => {
    const path = "/tmp/replaced.txt";
    const messages: Message[] = [
      toolMsg({
        id: "edit-1",
        toolName: "file_edit",
        toolArgs: {
          path,
          old_string: "one\ntwo\n",
          new_string: "new one\nnew two\nnew three\n",
        },
        content: `OK: edited ${path}`,
      }),
    ];
    expect(collectSessionFileChanges(messages)).toEqual([
      { path, added: 3, removed: 2 },
    ]);
  });

  it("returns no artifacts for an earlier assistant in the same turn", () => {
    const html = "/workspace/user/out/report.html";
    const messages: Message[] = [
      assistantMsg({ id: "mid", content: "写着" }),
      toolMsg({ id: "t-html", toolName: "file_write", toolArgs: { path: html }, content: `OK: wrote ${html}` }),
      assistantMsg({ id: "final", content: "完成" }),
    ];
    expect(collectTurnArtifactPaths(messages, "mid")).toEqual([]);
    expect(collectTurnArtifactPaths(messages, "final")).toEqual([html]);
  });

  it("accumulates session changes while keeping turn-local rows", () => {
    const a = "/tmp/a.txt";
    const b = "/tmp/b.txt";
    const c = "/tmp/c.txt";
    const messages: Message[] = [
      { id: "u1", role: "user", content: "先写两个", timestamp: 1 },
      toolMsg({ id: "t-a", toolName: "file_write", toolArgs: { path: a, content: "a\n" }, content: `OK: wrote ${a}` }),
      toolMsg({ id: "t-b", toolName: "file_write", toolArgs: { path: b, content: "b\n" }, content: `OK: wrote ${b}` }),
      assistantMsg({ id: "a1", content: "写了两个" }),
      { id: "u2", role: "user", content: "再写一个", timestamp: 2 },
      toolMsg({ id: "t-c", toolName: "file_write", toolArgs: { path: c, content: "c\n" }, content: `OK: wrote ${c}` }),
      assistantMsg({ id: "a2", content: "又写了一个" }),
    ];

    expect(collectTurnArtifactPaths(messages, "a2")).toEqual([c]);
    expect(collectTurnFileChanges(messages, "a2")).toEqual([{ path: c, added: 1, removed: 0 }]);
    expect(collectSessionFileChanges(messages)).toHaveLength(3);
  });

  it("ignores source/config files when choosing a primary deliverable", () => {
    expect(pickPrimaryTurnArtifact(["/tmp/notes.py", "/tmp/meta.json"])).toBeNull();
  });
});

describe("handoff path display", () => {
  it("matches slash-normalized handoff paths and parent directories", () => {
    expect(matchesHandoffPath("/tmp/hello.txt/", ["/tmp/hello.txt"])).toBe(true);
    expect(matchesHandoffPath("/tmp/other.txt", ["/tmp/hello.txt"])).toBe(false);
    const file = "/workspace/.agenticx/taskspaces/abc/default/a.txt";
    const root = "/workspace/.agenticx/taskspaces/abc/default/";
    expect(matchesHandoffAncestor(root, [file])).toBe(true);
    expect(matchesHandoffAncestor("/tmp/other", [file])).toBe(false);
  });

  it("hides taskspace UUID roots while retaining useful labels", () => {
    const root = "/workspace/.agenticx/taskspaces/abc/default/";
    const nested = `${root}reports/Hello World.txt`;
    expect(displayChatLocalPath(root, [nested])).toBe("当前工作区");
    expect(displayChatLocalPath(`${root}reports/`, [nested])).toBe("reports");
    expect(displayChatLocalPath(nested, [nested])).toBe("Hello World.txt");
    expect(displayChatLocalPath("/tmp/notes.txt", ["/tmp/other.txt"])).toBeNull();
  });
});

describe("spaced write paths", () => {
  it("keeps spaces with and without a chars suffix", () => {
    const withSpaces = "/tmp/Hello World第三方技能点.txt";
    const messages: Message[] = [
      toolMsg({
        id: "t-space",
        toolName: "file_write",
        toolArgs: { path: withSpaces, content: "line\n" },
        content: `OK: wrote ${withSpaces} (82 chars)`,
      }),
      toolMsg({
        id: "t-space-no-size",
        toolName: "file_write",
        toolArgs: { path: "/tmp/Another Name.txt", content: "line\n" },
        content: "OK: wrote /tmp/Another Name.txt",
      }),
    ];
    expect(collectSessionArtifactPaths(messages)).toEqual([withSpaces, "/tmp/Another Name.txt"]);
    expect(collectSessionFileChanges(messages)).toEqual([
      { path: withSpaces, added: 1, removed: 0 },
      { path: "/tmp/Another Name.txt", added: 1, removed: 0 },
    ]);
  });
});

describe("default workspace listing → 任务产物", () => {
  const root =
    "/workspace/.agenticx/taskspaces/33a3bc2a-d494-493f-a62a-e29a3b4f027d/default";

  it("keeps root files like parent-kid-games.html and skips memory/", () => {
    expect(
      collectWorkspaceListingArtifactPaths({
        workspaceRoot: root,
        entries: [
          { name: "memory", type: "dir", path: "memory" },
          { name: "parent-kid-games.html", type: "file", path: "parent-kid-games.html" },
        ],
      }),
    ).toEqual([`${root}/parent-kid-games.html`]);
  });

  it("hides trusted runtime core files while retaining same names in business paths", () => {
    expect(
      collectWorkspaceListingArtifactPaths({
        workspaceRoot: root,
        entries: [
          { name: "IDENTITY.md", type: "file" },
          { name: "MEMORY.md", type: "file" },
          { name: "agent_messages.json", type: "file" },
        ],
      }),
    ).toEqual([]);
    expect(
      collectWorkspaceListingArtifactPaths({
        workspaceRoot: "/workspace/reports",
        entries: [
          { name: "IDENTITY.md", type: "file" },
          { name: "MEMORY.md", type: "file" },
          { name: "agent_messages.json", type: "file" },
        ],
      }),
    ).toEqual([
      "/workspace/reports/IDENTITY.md",
      "/workspace/reports/MEMORY.md",
      "/workspace/reports/agent_messages.json",
    ]);
  });

  it("skips hidden files and extensionless names", () => {
    expect(
      collectWorkspaceListingArtifactPaths({
        workspaceRoot: root,
        entries: [
          { name: ".DS_Store", type: "file", path: ".DS_Store" },
          { name: "README", type: "file", path: "README" },
          { name: "notes.md", type: "file", path: "notes.md" },
        ],
      }),
    ).toEqual([`${root}/notes.md`]);
  });

  it("does not walk memory, hidden, or mounted dirs", () => {
    expect(isWalkableWorkspaceArtifactDir({ name: "memory", type: "dir" })).toBe(false);
    expect(isWalkableWorkspaceArtifactDir({ name: ".git", type: "dir" })).toBe(false);
    expect(
      isWalkableWorkspaceArtifactDir({
        name: "external-repo",
        type: "dir",
        mount_mode: "reference",
      }),
    ).toBe(false);
    expect(isWalkableWorkspaceArtifactDir({ name: "output", type: "dir" })).toBe(true);
    expect(isWalkableWorkspaceArtifactDir({ name: "docxenv", type: "dir" })).toBe(false);
    expect(isWalkableWorkspaceArtifactDir({ name: "venv", type: "dir" })).toBe(false);
    expect(isWalkableWorkspaceArtifactDir({ name: ".env", type: "dir" })).toBe(false);
    expect(isWalkableWorkspaceArtifactDir({ name: ".venv", type: "dir" })).toBe(false);
  });

  it("skips virtual-environment files from nested workspace listings", () => {
    expect(
      collectWorkspaceListingArtifactPaths({
        workspaceRoot: root,
        entries: [
          { name: "pyvenv.cfg", type: "file", path: "docxenv/pyvenv.cfg" },
          { name: "activate.fish", type: "file", path: "docxenv/bin/activate.fish" },
          { name: "pyvenv.cfg", type: "file", path: ".venv/pyvenv.cfg" },
          { name: "activate", type: "file", path: ".env/bin/activate" },
          { name: "report.md", type: "file", path: "output/report.md" },
        ],
      }),
    ).toEqual([root + "/output/report.md"]);
  });
});

describe("session deliverable selection", () => {
  it("does not resurrect collected paths after an explicit empty handoff", () => {
    const oldPath = "/workspace/user/out/old-report.md";
    expect(
      selectSessionDeliverablePaths(
        [assistantMsg({ id: "final", content: "本轮产出文件：无。" })],
        [oldPath],
      ),
    ).toEqual([]);
  });

  it("uses the final handoff list instead of helper scripts and virtualenv internals", () => {
    const outputDir = "/workspace/user/myWork/project/脱敏输出";
    const backtick = String.fromCharCode(96);
    const messages: Message[] = [
      toolMsg({
        id: "helper",
        toolName: "bash_exec",
        toolArgs: { command: "cat > /tmp/session/default/convert.py <<'EOF" },
        content: "exit_code=0",
      }),
      assistantMsg({
        id: "final",
        content: [
          "完成。产物在 " + backtick + outputDir + "/" + backtick + "：",
          "",
          "| 产物 | 路径 |",
          "|---|---|",
          "| 脱敏 Markdown | " + backtick + "脱敏输出/可研-脱敏.md" + backtick + " |",
          "| 图片 | " + backtick + "脱敏输出/assets/image_001.png" + backtick + "、" + backtick + "image_002.png" + backtick + " |",
        ].join("\n"),
      }),
    ];

    expect(
      selectSessionDeliverablePaths(messages, [
        "/tmp/session/default/convert.py",
        "/tmp/session/default/docxenv/pyvenv.cfg",
        outputDir + "/可研-脱敏.md",
        outputDir + "/assets/image_001.png",
        outputDir + "/assets/image_002.png",
      ]),
    ).toEqual([
      outputDir + "/可研-脱敏.md",
      outputDir + "/assets/image_001.png",
      outputDir + "/assets/image_002.png",
    ]);
    expect(collectTurnArtifactPaths(messages, "final")).toEqual([
      outputDir + "/可研-脱敏.md",
      outputDir + "/assets/image_001.png",
      outputDir + "/assets/image_002.png",
    ]);
  });

  it("uses only the latest assistant handoff and ignores stale historical manifests", () => {
    const oldPath = "/workspace/user/out/old-report.md";
    const currentPath = "/workspace/user/out/current-report.md";
    const messages: Message[] = [
      assistantMsg({ id: "old-final", content: `产出文件：\`${oldPath}\`` }),
      { id: "new-user", role: "user", content: "继续处理当前文件", timestamp: 2 },
      assistantMsg({ id: "new-final", content: "已完成当前任务，见上方结果。" }),
    ];
    expect(selectSessionDeliverablePaths(messages, [currentPath])).toEqual([currentPath]);
    expect(selectSessionDeliverablePaths(messages.slice(0, 2), [currentPath])).toEqual([currentPath]);
  });

  it("recognizes the neutral 产出文件 handoff cue", () => {
    const output = "/workspace/.agenticx/taskspaces/session/default/脱敏输出/可研报告-脱敏.md";
    const messages = [
      assistantMsg({
        id: "final-audited",
        content: [
          "## 产出文件（已验证）",
          "",
          `\`${output}\``,
          "",
          "- 内容脱敏校验通过",
        ].join("\n"),
      }),
    ];
    expect(selectSessionDeliverablePaths(messages, ["/tmp/example.docx", output])).toEqual([output]);
    expect(collectTurnArtifactPaths(messages, "final-audited")).toEqual([output]);
  });

  it("falls back to collected candidates when no explicit handoff list exists", () => {
    const candidates = ["/tmp/convert.py", "/tmp/report.md", "/tmp/report.md"];
    expect(
      selectSessionDeliverablePaths(
        [assistantMsg({ id: "final", content: "完成，未列出交付清单。" })],
        candidates,
      ),
    ).toEqual(["/tmp/convert.py", "/tmp/report.md"]);
  });
});
