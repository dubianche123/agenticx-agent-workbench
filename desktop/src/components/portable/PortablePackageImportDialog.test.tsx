import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  choosePortablePackageFile,
  normalizePortablePackagePreview,
  PortablePackageImportDialog,
} from "./PortablePackageImportDialog";

function groupPreview(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 2,
    artifact_id: "group:01JABCDEF0123456789ABCDEFG",
    release_version: "1.2.0",
    kind: "group",
    title: "市场洞察小组",
    description: "研究竞品和用户反馈",
    summary: "2 位成员，主持专家：研究员",
    byte_size: 2_048,
    recommended_permission_mode: "ask",
    skill_dependencies: ["skill:01JABCDEF0123456789ABCDEGH"],
    mcp_dependencies: ["mcp:01JABCDEF0123456789ABCDEGJ"],
    resource_paths: ["SOUL.md", "MEMORY.md"],
    workspace_slots: ["project_root"],
    scan_report: {
      scanner_version: "1",
      has_findings: false,
      should_block: false,
      findings: [],
    },
    role: "",
    tags: [],
    system_prompt: "",
    member_count: 2,
    member_names: ["研究员", "访谈专家"],
    member_roles: ["竞品分析", "用户研究"],
    member_system_prompts: ["核对数据来源", "保护受访者隐私"],
    host_member_name: "研究员",
    routing: "intelligent",
    ...overrides,
  };
}

describe("portable package import preview", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("normalizes the strict v2 group preview and its package metadata", () => {
    expect(normalizePortablePackagePreview(groupPreview())).toEqual({
      schemaVersion: 2,
      artifactId: "group:01JABCDEF0123456789ABCDEFG",
      releaseVersion: "1.2.0",
      kind: "group",
      name: "市场洞察小组",
      description: "研究竞品和用户反馈",
      summary: "2 位成员，主持专家：研究员",
      byteSize: 2_048,
      recommendedPermissionMode: "ask",
      skillDependencies: ["skill:01JABCDEF0123456789ABCDEGH"],
      mcpDependencies: ["mcp:01JABCDEF0123456789ABCDEGJ"],
      resourcePaths: ["SOUL.md", "MEMORY.md"],
      workspaceSlots: ["project_root"],
      scanReport: {
        scannerVersion: "1",
        hasFindings: false,
        shouldBlock: false,
        findings: [],
      },
      systemPrompt: "",
      memberCount: 2,
      members: [
        { name: "研究员", role: "竞品分析", systemPrompt: "核对数据来源" },
        { name: "访谈专家", role: "用户研究", systemPrompt: "保护受访者隐私" },
      ],
    });
  });

  it("rejects legacy, unnamed, and inconsistent previews", () => {
    expect(normalizePortablePackagePreview({ ...groupPreview(), schema_version: 1 })).toBeNull();
    expect(normalizePortablePackagePreview({ ...groupPreview(), title: "  " })).toBeNull();
    expect(normalizePortablePackagePreview({ ...groupPreview(), member_count: 3 })).toBeNull();
  });

  it("keeps the inspected raw text intact until the user confirms", async () => {
    const raw = '{\n  "schema_version": 2,\n  "kind": "expert"\n}\n';
    const preview = groupPreview({
      artifact_id: "expert:01JABCDEF0123456789ABCDEFG",
      kind: "expert",
      title: "研究员",
      member_count: 0,
      member_names: [],
      member_roles: [],
      member_system_prompts: [],
    });
    const inspectPortablePackageFile = vi.fn().mockResolvedValue({
      ok: true,
      canceled: false,
      filePath: "/tmp/研究员.agx-expert.json",
      raw,
      confirmationToken: "A".repeat(32),
      preview,
    });
    vi.stubGlobal("window", {
      agenticxDesktop: { inspectPortablePackageFile },
    });

    const result = await choosePortablePackageFile("expert");

    expect(inspectPortablePackageFile).toHaveBeenCalledWith({ kind: "expert" });
    expect(result).toMatchObject({
      status: "selected",
      candidate: {
        raw,
        confirmationToken: "A".repeat(32),
        filePath: "/tmp/研究员.agx-expert.json",
        preview: {
          schemaVersion: 2,
          kind: "expert",
          name: "研究员",
          releaseVersion: "1.2.0",
        },
      },
    });
  });

  it("shows versioned resources, dependencies, workspace requests, and accurate safeguards", () => {
    const preview = normalizePortablePackagePreview(groupPreview());
    expect(preview).not.toBeNull();
    const html = renderToStaticMarkup(
      <PortablePackageImportDialog
        candidate={{
          raw: '{"kind":"group"}',
          confirmationToken: "B".repeat(32),
          sourceLabel: "同事 A · 企业市场",
          preview: preview!,
        }}
        onClose={() => undefined}
      />,
    );

    expect(html).toContain("v1.2.0");
    expect(html).toContain("同事 A · 企业市场");
    expect(html).toContain("将创建 1 个项目群聊和 2 个全新数字专家");
    expect(html).toContain("研究员");
    expect(html).toContain("访谈专家");
    expect(html).toContain("Skill / MCP 依赖");
    expect(html).toContain("SOUL.md");
    expect(html).toContain("MEMORY.md");
    expect(html).toContain("project_root");
    expect(html).toContain("package_resources");
    expect(html).toContain("不会覆盖本机 MEMORY");
    expect(html).toContain("不会自行安装或授权");
    expect(html).toContain("不会授予 Auto");
    expect(html).toContain("确认导入");
  });

  it("surfaces sanitized blocking findings and disables import", () => {
    const preview = normalizePortablePackagePreview(groupPreview({
      scan_report: {
        scanner_version: "1",
        has_findings: true,
        should_block: true,
        findings: [{
          rule_id: "secret.api_key",
          category: "secret",
          severity: "high",
          blocking: true,
          field: "resources[0].content",
          line: 3,
          column: 1,
        }],
      },
    }));
    expect(preview).not.toBeNull();
    const html = renderToStaticMarkup(
      <PortablePackageImportDialog
        candidate={{
          raw: "{}",
          confirmationToken: "C".repeat(32),
          preview: preview!,
        }}
        onClose={() => undefined}
      />,
    );

    expect(html).toContain("敏感信息扫描已阻止导入");
    expect(html).toContain("secret.api_key");
    expect(html).toContain("resources[0].content:3");
    expect(html).not.toContain("matched_text");
    expect(html).toMatch(/disabled=""[^>]*>确认导入/);
  });
});
