import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  normalizeManagedPortablePackages,
  normalizeManagedPortableReconcilePayload,
  normalizePortablePackagePublication,
  normalizePortablePackageStudioExportRequest,
  normalizePortableMarketReleaseNotes,
  normalizePortableMarketAudienceDepartments,
  normalizePortableMarketAudienceUsers,
  normalizePortableMarketSecurityFindings,
  normalizePortablePackageScanFindings,
  isPortablePackageScanReport,
  PORTABLE_MARKET_MANUAL_ONLY_CODES,
  scanPortableMarketText,
  scanPortableMarketManifest,
  normalizePortableMarketItems,
  normalizePortableMarketVisibility,
  normalizePortableMarketCursor,
  portableMarketInstallItemIdentityMatches,
  PORTABLE_MARKET_PAGE_SIZE,
  sanitizePortableMarketReleaseNotes,
  sanitizePortablePackageManifest,
} from "../electron/portable-market";

const ROW_ID = "01JABCDEF0123456789ABCDEFG";
const OTHER_ROW_ID = "01JABCDEF0123456789ABCDEFX";
const SKILL_ID = "01JABCDEF0123456789ABCDEGH";
const MCP_ID = "01JABCDEF0123456789ABCDEGJ";

function strictV2GroupManifest() {
  return {
    schema_version: 2,
    artifact_id: `group:${ROW_ID}`,
    release_version: "1.2.0",
    kind: "group",
    title: "交付群",
    description: "负责交付验收",
    recommended_permission_mode: "ask",
    dependencies: {
      skills: [
        {
          capability_id: `skill:${SKILL_ID}`,
          version: "2.0.0",
          digest: "a".repeat(64),
          required: true,
        },
      ],
      mcps: [
        {
          capability_id: `mcp:${MCP_ID}`,
          version: "1.4.0-beta.1",
          required: false,
        },
      ],
    },
    resources: [],
    workspace_slots: [
      { name: "project_root", access: "read-only", required: true },
    ],
    payload: {
      name: "交付群",
      members: [
        {
          name: "交付专家",
          role: "项目交付",
          description: "核对交付标准",
          tags: ["交付"],
          system_prompt: "先核对验收标准。",
          color: "blue",
          default_permission_mode: "auto",
        },
      ],
      host_member_index: 0,
      routing: "intelligent",
    },
  };
}

describe("portable enterprise market contracts", () => {
  it("keeps market pagination cursors opaque and bounded", () => {
    expect(PORTABLE_MARKET_PAGE_SIZE).toBe(50);
    expect(normalizePortableMarketCursor("eyJ1cGRhdGVkQXQiOiIyMDI2LTA4LTI4IiwiaWQiOiIxIn0")).toBe(
      "eyJ1cGRhdGVkQXQiOiIyMDI2LTA4LTI4IiwiaWQiOiIxIn0",
    );
    expect(normalizePortableMarketCursor(" ")).toBeNull();
    expect(normalizePortableMarketCursor("bad cursor")).toBeNull();
    expect(normalizePortableMarketCursor("x".repeat(513))).toBeNull();
    expect(normalizePortableMarketCursor(42)).toBeNull();
  });

  it("normalizes tenant-market metadata without accepting malformed capability ids", () => {
    expect(normalizePortableMarketItems([
      {
        id: ROW_ID.toLowerCase(),
        capabilityId: `expert:${ROW_ID}`,
        source_artifact_id: `expert:${OTHER_ROW_ID}`,
        manifest_version: 2,
        release_id: OTHER_ROW_ID,
        version: "1.2.0",
        kind: "expert",
        title: "环境配置专家",
        description: "检查本机环境",
        ownerDisplayName: "同事 A",
        visibility: "departments",
        visibleDepartmentCount: 2,
        visibleUserCount: 0,
        downloadCount: 42,
        status: "published",
        digest: "c".repeat(64),
        release_notes: "补充环境诊断说明",
        release_published_at: "2026-08-28T00:00:00.000Z",
        publishedAt: "2026-08-28T00:00:00.000Z",
        createdAt: "2026-08-28T00:00:00.000Z",
        updatedAt: "2026-08-28T00:00:00.000Z",
      },
      {
        id: ROW_ID,
        capabilityId: `group:${ROW_ID}`,
        kind: "expert",
        title: "类型伪造",
        status: "published",
      },
      {
        id: ROW_ID,
        capabilityId: `expert:${ROW_ID}`,
        kind: "expert",
        title: "缺少可见范围",
        status: "published",
      },
      {
        id: ROW_ID,
        kind: "expert",
        title: "缺少能力标识",
        visibility: "company",
        status: "published",
      },
    ])).toEqual([
      expect.objectContaining({
        id: ROW_ID,
        capabilityId: `expert:${ROW_ID}`,
        kind: "expert",
        title: "环境配置专家",
        version: "1.2.0",
        releaseNotes: "补充环境诊断说明",
        downloadCount: 42,
        visibility: "departments",
        visibleDepartmentCount: 2,
      }),
    ]);
  });

  it("accepts only strict mutually-exclusive market visibility", () => {
    const departmentId = "01JABCDEF0123456789ABCDEGH";
    expect(normalizePortableMarketVisibility({
      type: "personal",
      departmentIds: [],
      userIds: [],
    })).toEqual({ type: "personal", departmentIds: [], userIds: [] });
    expect(normalizePortableMarketVisibility({
      type: "personal",
      departmentIds: [departmentId],
      userIds: [],
    })).toBeNull();
    expect(normalizePortableMarketVisibility({
      type: "departments",
      departmentIds: [departmentId.toLowerCase(), departmentId],
      userIds: [],
    })).toEqual({ type: "departments", departmentIds: [departmentId], userIds: [] });
    expect(normalizePortableMarketVisibility({
      type: "users",
      departmentIds: [departmentId],
      userIds: [ROW_ID],
    })).toBeNull();
    expect(normalizePortableMarketVisibility({
      type: "company",
      departmentIds: [],
      userIds: [ROW_ID],
    })).toBeNull();
    expect(normalizePortableMarketVisibility({
      type: "users",
      departmentIds: [],
      userIds: [],
    })).toBeNull();
  });

  it("requires both the market marker and metadata to identify the same item", () => {
    const item = { id: ROW_ID };
    expect(portableMarketInstallItemIdentityMatches(
      { item_id: ROW_ID },
      ROW_ID,
      item,
    )).toBe(true);
    expect(portableMarketInstallItemIdentityMatches(
      { item_id: OTHER_ROW_ID },
      ROW_ID,
      item,
    )).toBe(false);
    expect(portableMarketInstallItemIdentityMatches(
      { item_id: ROW_ID },
      OTHER_ROW_ID,
      item,
    )).toBe(false);
    expect(portableMarketInstallItemIdentityMatches(
      { item_id: ROW_ID, artifact_id: "source-a" },
      ROW_ID,
      { id: OTHER_ROW_ID },
    )).toBe(false);
  });

  it("keeps only minimal, well-formed audience directory fields", () => {
    expect(normalizePortableMarketAudienceDepartments([
      { id: ROW_ID.toLowerCase(), name: "研发", path: "总部 / 研发", secret: "no" },
      { id: "bad", name: "伪造" },
    ])).toEqual([{ id: ROW_ID, name: "研发", path: "总部 / 研发" }]);
    expect(normalizePortableMarketAudienceUsers([
      {
        id: ROW_ID,
        displayName: "李雷",
        email: "lilei@example.invalid",
        deptId: null,
        phone: "must-not-cross-the-bridge",
      },
      { id: "bad", displayName: "伪造", email: "x@example.invalid" },
    ])).toEqual([
      {
        id: ROW_ID,
        displayName: "李雷",
        email: "lilei@example.invalid",
        deptId: null,
      },
    ]);
  });

  it("accepts only bounded, kind-matched strict v2 managed packages", () => {
    const manifest = strictV2GroupManifest();
    const raw = JSON.stringify(manifest);
    const digest = createHash("sha256").update(raw, "utf8").digest("hex");
    const desired = [
      {
        id: `group:${ROW_ID}`,
        kind: "group",
        title: "交付群",
        digest,
        raw,
      },
      {
        id: `expert:${ROW_ID}`,
        kind: "group",
        digest,
        raw,
      },
      {
        id: `group:${ROW_ID}`,
        kind: "group",
        digest: "not-a-digest",
        raw,
      },
      {
        id: `group:${OTHER_ROW_ID}`,
        kind: "group",
        digest: "a".repeat(64),
        raw,
      },
    ];
    const packages = normalizeManagedPortablePackages(desired);
    expect(packages).toEqual([
      expect.objectContaining({ id: `group:${ROW_ID}`, kind: "group", raw }),
    ]);

    expect(normalizeManagedPortableReconcilePayload([desired[0]])).toEqual({
      packages: [{ id: `group:${ROW_ID}`, digest, raw }],
    });
    expect(normalizeManagedPortableReconcilePayload(desired)).toBeNull();

    const v1Raw = JSON.stringify({ ...manifest, schema_version: 1 });
    const v1Digest = createHash("sha256").update(v1Raw, "utf8").digest("hex");
    expect(normalizeManagedPortablePackages([
      {
        id: `group:${OTHER_ROW_ID}`,
        kind: "group",
        title: "旧版群聊",
        digest: v1Digest,
        raw: v1Raw,
      },
    ])).toEqual([]);
  });

  it("builds publication metadata from the validated v2 package version", () => {
    const manifest = strictV2GroupManifest();

    expect(normalizePortablePackagePublication(manifest, "group")).toEqual({
      kind: "group",
      manifest_version: 2,
      manifest,
    });
    expect(normalizePortablePackagePublication({ ...manifest, schema_version: 1 }, "group"))
      .toBeNull();
    expect(normalizePortablePackagePublication(manifest, "expert")).toBeNull();
    expect(normalizePortablePackagePublication({ ...manifest, unexpected: true }, "group"))
      .toBeNull();
  });

  it("redacts only server-reported sensitive fields and recomputes resource digests", () => {
    const manifest = strictV2GroupManifest();
    const content = "客户邮箱 alice@example.com，卡号 4111 1111 1111 1111";
    manifest.payload.members[0].system_prompt = "api_key = sk-proj-abcdefghijklmnopqrstuvwxyz123456";
    manifest.resources = [{
      path: "docs/CONTEXT.md",
      content,
      digest: createHash("sha256").update(content).digest("hex"),
    }];
    const findings = normalizePortableMarketSecurityFindings([
      { code: "openai_key", category: "secret", field: "manifest.payload.members[0].system_prompt" },
      { code: "email", category: "pii", field: "manifest.resources[0].content" },
      { code: "bank_card", category: "pii", field: "manifest.resources[0].content" },
      { code: "openai_key", category: "secret", field: "release_notes" },
    ]);
    expect(findings).not.toBeNull();
    const sanitized = sanitizePortablePackageManifest(manifest, findings!);
    expect(sanitized).not.toBeNull();
    expect(JSON.stringify(sanitized)).not.toContain("sk-proj-");
    expect(JSON.stringify(sanitized)).not.toContain("alice@example.com");
    expect(JSON.stringify(sanitized)).not.toContain("4111 1111 1111 1111");
    const resource = (sanitized!.resources as Array<Record<string, unknown>>)[0]!;
    expect(resource.digest).toBe(createHash("sha256").update(resource.content as string).digest("hex"));
    expect(normalizePortablePackagePublication(sanitized, "group")).not.toBeNull();
    expect(sanitizePortableMarketReleaseNotes(
      "本次发布使用 sk-proj-abcdefghijklmnopqrstuvwxyz123456",
      findings!,
    )).not.toContain("sk-proj-");
    expect(normalizePortableMarketSecurityFindings([
      { code: "unknown_rule", category: "secret", field: "manifest.title" },
    ])).toBeNull();
    const structuralFinding = normalizePortableMarketSecurityFindings([
      { code: "email", category: "pii", field: "manifest.resources[0].path" },
    ]);
    expect(sanitizePortablePackageManifest(manifest, structuralFinding!)).toBeNull();
    expect(normalizePortableMarketSecurityFindings([
      { code: "email", category: "pii", field: "manifest.__proto__.polluted" },
    ])).toBeNull();
  });

  it("maps local preflight reports and scans release notes without exposing values", () => {
    const token = "sk-proj-abcdefghijklmnopqrstuvwxyz123456";
    const local = normalizePortablePackageScanFindings({
      findings: [
        {
          rule_id: "secret.openai_api_key_extended",
          category: "secret",
          field: "package.release_version",
          line: 2,
          column: 4,
        },
        {
          rule_id: "pii.email",
          category: "pii",
          blocking: false,
          field: "resources[0].content",
          line: 3,
          column: 8,
        },
      ],
    });
    expect(local).toEqual([
      expect.objectContaining({
        code: "openai_key",
        field: "manifest.release_version",
        line: 2,
        column: 4,
      }),
      expect.objectContaining({
        code: "email",
        field: "manifest.resources[0].content",
        line: 3,
        column: 8,
      }),
    ]);
    const findings = scanPortableMarketText(
      `第一行\nrelease notes: ${token}`,
      "release_notes",
    );
    expect(findings).toEqual([expect.objectContaining({
      code: "openai_key",
      category: "secret",
      field: "release_notes",
      line: 2,
    })]);
    expect(JSON.stringify(findings)).not.toContain(token);
    const unknownReleaseSecret = scanPortableMarketText(
      "third-party token: " + ["sk", "live", "abcdefghijklmnopqrstuvwxyz123456"].join("_"),
      "release_notes",
    );
    expect(unknownReleaseSecret).toEqual([expect.objectContaining({
      code: "stripe_key",
      field: "release_notes",
    })]);
    expect(JSON.stringify(unknownReleaseSecret)).not.toContain("sk_live_");

    const manualOnly = normalizePortablePackageScanFindings({
      findings: [
        {
          rule_id: "secret.custom_vendor_secret",
          category: "secret",
          blocking: true,
          field: "resources[0].content",
        },
        {
          rule_id: "secret.high_entropy_hex",
          category: "secret",
          blocking: false,
          field: "resources[0].content",
        },
      ],
    });
    expect(manualOnly).toEqual([expect.objectContaining({
      code: "unclassified_secret",
      field: "manifest.resources[0].content",
    })]);
    expect(PORTABLE_MARKET_MANUAL_ONLY_CODES.has(manualOnly[0]!.code)).toBe(true);
    expect(normalizePortableMarketSecurityFindings(manualOnly)).toBeNull();
    expect(normalizePortableMarketSecurityFindings(manualOnly, { allowManualOnly: true }))
      .toEqual(manualOnly);
  });

  it("aligns boundary forms and rejects an incomplete local scan report", () => {
    const boundaryCases = [
      ["_api_key=abcdefghijklmnopqrst", "assigned_secret"],
      ["_sk-proj-abcdefghijklmnopqrstuvwxyz123456", "openai_key"],
      ["_Bearer abcdefghijklmnop", "bearer_token"],
      ["_AKIA1234567890ABCDEF", "aws_access_key"],
      ["_ghp_abcdefghijklmnopqrstuvwxyz1234567890", "github_token"],
      ["8613812345679", "cn_phone"],
      ["+8613812345679", "cn_phone"],
    ] as const;
    for (const [value, code] of boundaryCases) {
      const findings = scanPortableMarketText(value, "release_notes");
      expect(findings).toEqual([expect.objectContaining({ code })]);
      const sanitized = sanitizePortableMarketReleaseNotes(value, findings);
      expect(sanitized).not.toBeNull();
      expect(sanitized).not.toContain(value);
      expect(scanPortableMarketText(sanitized!, "release_notes")).toEqual([]);
    }

    const credentialUrl = "connect https://user:password@example.com now";
    const credentialFindings = scanPortableMarketText(credentialUrl, "release_notes");
    expect(credentialFindings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "credential_url" }),
    ]));
    const redactedCredentialUrl = sanitizePortableMarketReleaseNotes(
      credentialUrl,
      credentialFindings,
    );
    expect(redactedCredentialUrl).not.toBeNull();
    expect(scanPortableMarketText(redactedCredentialUrl!, "release_notes")).toEqual([]);

    expect(isPortablePackageScanReport(undefined)).toBe(false);
    expect(isPortablePackageScanReport({
      scanner_version: "1",
      has_findings: false,
      should_block: false,
      findings: [],
    })).toBe(true);
    expect(isPortablePackageScanReport({
      scanner_version: "1",
      has_findings: true,
      should_block: true,
      findings: [{
        rule_id: "secret.openai_api_key",
        category: "secret",
        severity: "critical",
        blocking: true,
        field: "package.payload.system_prompt",
        line: 1,
        column: 1,
      }],
    })).toBe(true);
    expect(isPortablePackageScanReport({
      scanner_version: "1",
      has_findings: false,
      should_block: false,
      findings: [{
        rule_id: "secret.openai_api_key",
        category: "secret",
        severity: "critical",
        blocking: true,
        field: "package.payload.system_prompt",
        line: 1,
        column: 1,
      }],
    })).toBe(false);
    expect(isPortablePackageScanReport({
      scanner_version: "1",
      has_findings: false,
      should_block: false,
      findings: [],
      unexpected: true,
    })).toBe(false);
  });

  it("re-scans every manifest string after redaction", () => {
    const manifest = strictV2GroupManifest();
    manifest.payload.members[0].system_prompt = "_api_key=abcdefghijklmnopqrst";
    const findings = normalizePortableMarketSecurityFindings([
      {
        code: "assigned_secret",
        category: "secret",
        field: "manifest.payload.members[0].system_prompt",
      },
    ]);
    const sanitized = sanitizePortablePackageManifest(manifest, findings!);
    expect(sanitized).not.toBeNull();
    expect(scanPortableMarketManifest(sanitized)).toEqual([]);
  });

  it("whitelists v2 export options and never accepts inline resources or dependency credentials", () => {
    const request = normalizePortablePackageStudioExportRequest({
      kind: "expert",
      id: "expert-local-id",
      release_version: "2.3.0-rc.1+desktop.5",
      recommended_permission_mode: "plan",
      dependencies: {
        skills: [
          {
            capability_id: `skill:${SKILL_ID.toLocaleLowerCase()}`,
            version: "2.0.0",
            digest: "b".repeat(64),
            required: true,
          },
        ],
        mcps: [
          {
            capability_id: `mcp:${MCP_ID.toLocaleLowerCase()}`,
            version: "1.0.0",
            required: false,
          },
        ],
      },
      resource_files: ["IDENTITY.md", "SOUL.md", "MEMORY.md"],
      workspace_slots: [
        { name: "project_root", access: "read-only", required: true },
      ],
      visibility: { type: "company" },
      release_notes: "  第二版：补充项目记忆。  ",
    });

    expect(request).toEqual({
      kind: "expert",
      id: "expert-local-id",
      release_version: "2.3.0-rc.1+desktop.5",
      recommended_permission_mode: "plan",
      dependencies: {
        skills: [
          {
            capability_id: `skill:${SKILL_ID}`,
            version: "2.0.0",
            digest: "b".repeat(64),
            required: true,
          },
        ],
        mcps: [
          {
            capability_id: `mcp:${MCP_ID}`,
            version: "1.0.0",
            required: false,
          },
        ],
      },
      resource_files: ["IDENTITY.md", "SOUL.md", "MEMORY.md"],
      workspace_slots: [
        { name: "project_root", access: "read-only", required: true },
      ],
    });
    expect(normalizePortablePackageStudioExportRequest({
      kind: "expert",
      id: "expert-local-id",
      resources: [{ path: "MEMORY.md", content: "renderer supplied" }],
    })).toBeNull();
    expect(normalizePortablePackageStudioExportRequest({
      kind: "expert",
      id: "expert-local-id",
      dependencies: {
        skills: [],
        mcps: [{
          capability_id: `mcp:${MCP_ID}`,
          version: "1.0.0",
          required: true,
          headers: { Authorization: "secret" },
        }],
      },
    })).toBeNull();
  });

  it("bounds and trims market release notes without passing them to Studio export", () => {
    expect(normalizePortableMarketReleaseNotes("  第二版：补充项目记忆。  ")).toBe(
      "第二版：补充项目记忆。",
    );
    expect(normalizePortableMarketReleaseNotes("x".repeat(4_001))).toBeNull();
    expect(normalizePortableMarketReleaseNotes("看似正常\u202e反向")).toBeNull();
    expect(normalizePortableMarketReleaseNotes({ text: "不能隐式转字符串" })).toBeNull();
  });

  it("rejects bidi controls from package resources with the same boundary as Studio", () => {
    const manifest = strictV2GroupManifest();
    const content = "普通内容\u2066隐藏方向\u2069";
    const unsafe = {
      ...manifest,
      resources: [{
        path: "SOUL.md",
        content,
        digest: createHash("sha256").update(content, "utf8").digest("hex"),
      }],
    };

    expect(normalizePortablePackagePublication(unsafe, "group")).toBeNull();
  });
});
