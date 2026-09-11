import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  compareConfigShareVersions,
  ConfigShareValidationError,
  configShareDownloadFileName,
  isValidConfigShareToken,
  parseConfigShareCreateRequest,
} from "./config-share-types";

function expertPayload(name = "投研专家", description = "分析公司公告") {
  return {
    name,
    role: "研究员",
    description,
    tags: ["投研"],
    system_prompt: "保持审慎",
    color: "blue",
    default_permission_mode: "ask",
  };
}

function expertManifest(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 2,
    artifact_id: "expert:fixture-001",
    release_version: "1.0.0",
    kind: "expert",
    title: "投研专家",
    description: "分析公司公告",
    recommended_permission_mode: "ask",
    dependencies: { skills: [], mcps: [] },
    resources: [],
    workspace_slots: [],
    payload: expertPayload(),
    ...overrides,
  };
}

function skillManifest(overrides: Record<string, unknown> = {}) {
  const name = "public-research";
  const description = "查找并整理公开资料";
  return {
    schema_version: 2,
    artifact_id: "skill:fixture-001",
    release_version: "1.0.0",
    kind: "skill",
    title: name,
    description,
    recommended_permission_mode: "ask",
    dependencies: { skills: [], mcps: [] },
    resources: [],
    workspace_slots: [],
    payload: {
      name,
      description,
      skill_md: `---\nname: ${name}\ndescription: ${description}\n---\n\n# Public research\n\nUse public sources and cite them.\n`,
    },
    ...overrides,
  };
}

const SKILL_ULID = "01JQMZ8K3N4P5Q6R7S8T9VWXY1";
const MCP_ULID = "01JQMZ8K3N4P5Q6R7S8T9VWXY2";

describe("config share v2 envelope validation", () => {
  it("accepts the exact v2 envelope and full SemVer", () => {
    const parsed = parseConfigShareCreateRequest({
      kind: "expert",
      manifest_version: 2,
      manifest: expertManifest({ release_version: "2.1.0-rc.1+build.7" }),
    });
    expect(parsed.manifest.release_version).toBe("2.1.0-rc.1+build.7");
    expect(parsed.manifest.artifact_id).toBe("expert:fixture-001");
    expect(compareConfigShareVersions("9007199254740993.0.0", "9007199254740992.0.0")).toBe(1);
    expect(
      compareConfigShareVersions("1.0.0-9007199254740993", "1.0.0-9007199254740992"),
    ).toBe(1);
  });

  it("rejects legacy v1, unknown fields, and invalid capability ids", () => {
    expect(() =>
      parseConfigShareCreateRequest({
        kind: "expert",
        manifest_version: 1,
        manifest: { schema_version: 1, kind: "expert", title: "旧包", description: "", payload: {} },
      }),
    ).toThrow(ConfigShareValidationError);
    expect(() =>
      parseConfigShareCreateRequest({
        kind: "expert",
        manifest_version: 2,
        manifest: { ...expertManifest(), local_workspace: "/private/project" },
      }),
    ).toThrow(/exactly/);
    expect(() =>
      parseConfigShareCreateRequest({
        kind: "expert",
        manifest_version: 2,
        manifest: expertManifest({
          dependencies: {
            skills: [{ capability_id: "skill:bad/path", version: "1.0.0", digest: "a".repeat(64), required: true }],
            mcps: [],
          },
        }),
      }),
    ).toThrow(/capability_id/);
    expect(() =>
      parseConfigShareCreateRequest({
        kind: "expert",
        manifest_version: 2,
        manifest: expertManifest({
          dependencies: {
            skills: [{ capability_id: "skill:market-data", version: "1.0.0", digest: "a".repeat(64), required: true }],
            mcps: [],
          },
        }),
      }),
    ).toThrow(/canonical skill:<ULID>/);
  });

  it("persists dependency ids in the platform's canonical uppercase ULID form", () => {
    const parsed = parseConfigShareCreateRequest({
      kind: "expert",
      manifest_version: 2,
      manifest: expertManifest({
        dependencies: {
          skills: [{
            capability_id: `skill:${SKILL_ULID.toLowerCase()}`,
            version: "1.0.0",
            digest: "A".repeat(64),
            required: true,
          }],
          mcps: [{ capability_id: `mcp:${MCP_ULID.toLowerCase()}`, version: "2.0.0", required: false }],
        },
      }),
    });
    expect(parsed.manifest.dependencies).toEqual({
      skills: [{
        capability_id: `skill:${SKILL_ULID}`,
        version: "1.0.0",
        digest: "a".repeat(64),
        required: true,
      }],
      mcps: [{ capability_id: `mcp:${MCP_ULID}`, version: "2.0.0", required: false }],
    });
  });

  it("verifies selected markdown bytes and prevents path traversal", () => {
    const content = "# Public project context";
    const digest = createHash("sha256").update(content).digest("hex");
    const parsed = parseConfigShareCreateRequest({
      kind: "expert",
      manifest_version: 2,
      manifest: expertManifest({ resources: [{ path: "docs/CONTEXT.md", content, digest }] }),
    });
    expect(parsed.manifest.resources[0]).toEqual({ path: "docs/CONTEXT.md", content, digest });
    expect(() =>
      parseConfigShareCreateRequest({
        kind: "expert",
        manifest_version: 2,
        manifest: expertManifest({ resources: [{ path: "../USER.md", content, digest }] }),
      }),
    ).toThrow(/safe relative/);
  });

  it("requires canonical NFC POSIX resource paths and rejects case-fold collisions", () => {
    const content = "# Context";
    const digest = createHash("sha256").update(content).digest("hex");
    const requestWithPaths = (paths: string[]) => ({
      kind: "expert",
      manifest_version: 2,
      manifest: expertManifest({
        resources: paths.map((path) => ({ path, content, digest })),
      }),
    });
    expect(() => parseConfigShareCreateRequest(requestWithPaths(["docs/Cafe\u0301.md"]))).toThrow(
      /Unicode NFC/,
    );
    expect(() => parseConfigShareCreateRequest(requestWithPaths(["docs/Café.md"]))).not.toThrow();
    expect(() => parseConfigShareCreateRequest(requestWithPaths(["C:/MEMORY.md"]))).toThrow(
      /safe relative/,
    );
    expect(() =>
      parseConfigShareCreateRequest(requestWithPaths(["docs/Context.md", "docs/context.MD"])),
    ).toThrow(/duplicate path/);
  });

  it("rejects controls, bidi overrides, and lone surrogates in exact resource content", () => {
    for (const content of ["safe\u0001hidden", "safe\u0085hidden", "safe\u202Ehidden", "safe\ud800hidden"]) {
      const digest = createHash("sha256").update(content).digest("hex");
      expect(() => parseConfigShareCreateRequest({
        kind: "expert",
        manifest_version: 2,
        manifest: expertManifest({ resources: [{ path: "SOUL.md", content, digest }] }),
      })).toThrow(/control|Unicode/);
    }
  });

  it("requires exact expert/team payloads and cross-field consistency", () => {
    expect(() =>
      parseConfigShareCreateRequest({
        kind: "expert",
        manifest_version: 2,
        manifest: expertManifest({ title: "误导标题" }),
      }),
    ).toThrow(/must match/);
    expect(() =>
      parseConfigShareCreateRequest({
        kind: "expert",
        manifest_version: 2,
        manifest: expertManifest({
          payload: { ...expertPayload(), tags: ["Straße", "STRASSE"] },
        }),
      }),
    ).toThrow(/duplicates/);
    const group = parseConfigShareCreateRequest({
      kind: "group",
      manifest_version: 2,
      manifest: {
        ...expertManifest(),
        artifact_id: "group:fixture-001",
        kind: "group",
        title: "投研团队",
        description: "协同研究",
        payload: {
          name: "投研团队",
          members: [expertPayload()],
          host_member_index: 0,
          routing: "intelligent",
        },
      },
    });
    expect(group.manifest.payload).toMatchObject({
      routing: "intelligent",
      members: [{ default_permission_mode: "ask" }],
    });
  });

  it("accepts a single standard SKILL.md and rejects extra files or unsafe identifiers", () => {
    const parsed = parseConfigShareCreateRequest({
      kind: "skill",
      manifest_version: 2,
      manifest: skillManifest(),
    });
    expect(parsed.manifest.kind).toBe("skill");
    expect(parsed.manifest.payload).toMatchObject({ name: "public-research" });
    expect(() => parseConfigShareCreateRequest({
      kind: "skill",
      manifest_version: 2,
      manifest: skillManifest({
        payload: {
          ...(skillManifest().payload as Record<string, unknown>),
          name: "Public Research",
        },
        title: "Public Research",
      }),
    })).toThrow(/lowercase Skill identifier/);
    expect(() => parseConfigShareCreateRequest({
      kind: "skill",
      manifest_version: 2,
      manifest: skillManifest({
        resources: [{ path: "README.md", content: "extra", digest: createHash("sha256").update("extra").digest("hex") }],
      }),
    })).toThrow(/only one SKILL.md/);
    expect(() => parseConfigShareCreateRequest({
      kind: "skill",
      manifest_version: 2,
      manifest: skillManifest({
        payload: {
          ...(skillManifest().payload as Record<string, unknown>),
          skill_md: "# no front matter",
        },
      }),
    })).toThrow(/front matter/);
  });

  it("accepts ordinary YAML block descriptions without treating them as a scan rule", () => {
    const manifest = skillManifest({
      payload: {
        ...(skillManifest().payload as Record<string, unknown>),
        skill_md: [
          "---",
          "name: public-research # stable loader identity",
          "description: |",
          "  Search public sources.",
          "  Return cited findings.",
          "---",
          "# Instructions",
        ].join("\n"),
      },
    });
    expect(parseConfigShareCreateRequest({
      kind: "skill",
      manifest_version: 2,
      manifest,
    }).manifest.kind).toBe("skill");
  });

  it("requires a valid default permission mode for every expert and group member", () => {
    expect(() => parseConfigShareCreateRequest({
      kind: "expert",
      manifest_version: 2,
      manifest: expertManifest({
        payload: (() => {
          const payload = expertPayload();
          delete (payload as Record<string, unknown>).default_permission_mode;
          return payload;
        })(),
      }),
    })).toThrow(/default_permission_mode/);

    for (const mode of ["plan", "ask", "auto"] as const) {
      expect(parseConfigShareCreateRequest({
        kind: "expert",
        manifest_version: 2,
        manifest: expertManifest({
          payload: { ...expertPayload(), default_permission_mode: mode },
        }),
      }).manifest.payload).toMatchObject({ default_permission_mode: mode });
    }

    expect(() => parseConfigShareCreateRequest({
      kind: "group",
      manifest_version: 2,
      manifest: {
        ...expertManifest(),
        artifact_id: "group:fixture-002",
        kind: "group",
        title: "投研团队",
        description: "协同研究",
        payload: {
          name: "投研团队",
          members: [{ ...expertPayload(), default_permission_mode: "unsafe" }],
          host_member_index: 0,
          routing: "intelligent",
        },
      },
    })).toThrow(/default_permission_mode/);
  });

  it("accepts only 32-character base64url share tokens and safe extensions", () => {
    expect(isValidConfigShareToken("Ab".repeat(16))).toBe(true);
    expect(isValidConfigShareToken("../same-tenant-is-not-enough".padEnd(32, "x"))).toBe(false);
    expect(configShareDownloadFileName("投研/专家", "expert")).toBe("投研-专家.agx-expert.json");
    expect(configShareDownloadFileName("项目群", "group")).toBe("项目群.agx-group.json");
    expect(configShareDownloadFileName("public-research", "skill")).toBe("public-research.agx-skill.json");
  });
});
