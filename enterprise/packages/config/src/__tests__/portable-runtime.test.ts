import { describe, expect, it } from "vitest";

import { portableRuntimeContractFromManifest, requiredPortableDependencies } from "../portable-runtime";

const SKILL_ID = "skill:01JQMZ8K3N4P5Q6R7S8T9VWXYZ";
const MCP_ID = "mcp:01JQMZ8K3N4P5Q6R7S8T9VWXY1";

function manifest() {
  return {
    schema_version: 2,
    kind: "expert",
    recommended_permission_mode: "ask",
    payload: {
      name: "投研专家",
      default_permission_mode: "auto",
    },
    dependencies: {
      skills: [{ capability_id: SKILL_ID, version: "1.2.3", digest: "a".repeat(64), required: true }],
      mcps: [{ capability_id: MCP_ID.toLowerCase(), version: "2.0.0", required: false }],
    },
    resources: [{ path: "SOUL.md", content: "规则", digest: "b".repeat(64) }],
  };
}

describe("portable runtime contract", () => {
  it("normalizes capability ids and exposes every runtime-affecting field", () => {
    expect(portableRuntimeContractFromManifest(manifest())).toEqual({
      recommendedPermissionMode: "ask",
      expertPermissions: [{ name: "投研专家", defaultPermissionMode: "auto" }],
      dependencies: [
        { kind: "skill", capabilityId: SKILL_ID, version: "1.2.3", digest: "a".repeat(64), required: true },
        { kind: "mcp", capabilityId: MCP_ID, version: "2.0.0", digest: null, required: false },
      ],
      resources: [{ path: "SOUL.md", content: "规则", digest: "b".repeat(64) }],
    });
    expect(requiredPortableDependencies(manifest())).toHaveLength(1);
  });

  it("fails closed on malformed dependency metadata", () => {
    const value = manifest();
    value.dependencies.skills[0]!.digest = "bad";
    expect(() => portableRuntimeContractFromManifest(value)).toThrow(/digest is inconsistent/);
  });

  it("fails closed when an expert declaration omits its default permission mode", () => {
    const value = manifest();
    delete (value.payload as Record<string, unknown>).default_permission_mode;
    expect(() => portableRuntimeContractFromManifest(value)).toThrow(/permission is inconsistent/);
  });

  it("returns one independent permission entry for every group member", () => {
    const value = {
      ...manifest(),
      kind: "group",
      payload: {
        members: [
          { name: "研究专家", default_permission_mode: "plan" },
          { name: "复核专家", default_permission_mode: "ask" },
        ],
      },
    };
    expect(portableRuntimeContractFromManifest(value).expertPermissions).toEqual([
      { name: "研究专家", defaultPermissionMode: "plan" },
      { name: "复核专家", defaultPermissionMode: "ask" },
    ]);
  });
});
