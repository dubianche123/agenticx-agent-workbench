import { describe, expect, it } from "vitest";

import {
  assertPortablePackRequiredDependencies,
  assertPortableDependencyRegistryMatches,
  MissingPortableDependenciesError,
  requiredDependenciesForPortableReleases,
  UnresolvablePortableDependenciesError,
} from "../portable-pack-dependencies";

const EXPERT_ID = "expert:01JQMZ8K3N4P5Q6R7S8T9VWXYZ";
const SKILL_ID = "skill:01JQMZ8K3N4P5Q6R7S8T9VWXY1";
const MCP_ID = "mcp:01JQMZ8K3N4P5Q6R7S8T9VWXY2";

function manifest() {
  return {
    schema_version: 2,
    kind: "expert",
    recommended_permission_mode: "ask",
    payload: { name: "投研专家", default_permission_mode: "auto" },
    dependencies: {
      skills: [{ capability_id: SKILL_ID, version: "1.0.0", digest: "a".repeat(64), required: true }],
      mcps: [],
    },
    resources: [],
  };
}

function manifestWithMcp() {
  const value = manifest();
  (value.dependencies as { mcps: Array<{ capability_id: string; version: string; required: boolean }> }).mcps = [
    { capability_id: MCP_ID, version: "2.0.0", required: true },
  ];
  return value;
}

describe("portable capability-pack dependency closure", () => {
  it("lists required dependencies that were not explicitly selected", () => {
    expect(() => assertPortablePackRequiredDependencies(
      [EXPERT_ID],
      [{ capabilityId: EXPERT_ID, manifest: manifest() }],
    )).toThrow(MissingPortableDependenciesError);
    try {
      assertPortablePackRequiredDependencies([EXPERT_ID], [{ capabilityId: EXPERT_ID, manifest: manifest() }]);
    } catch (error) {
      expect(error).toMatchObject({ missingCapabilityIds: [SKILL_ID] });
    }
  });

  it("accepts a pack that explicitly contains the dependency", () => {
    expect(() => assertPortablePackRequiredDependencies(
      [EXPERT_ID, SKILL_ID],
      [{ capabilityId: EXPERT_ID, manifest: manifest() }],
    )).not.toThrow();
  });

  it("revalidates active Skill bytes", () => {
    const required = requiredDependenciesForPortableReleases([{ manifest: manifest() }]);
    expect(() => assertPortableDependencyRegistryMatches(required, [{
      capabilityId: SKILL_ID,
      status: "active",
      version: "1.0.1",
      digest: "a".repeat(64),
    }])).toThrow(UnresolvablePortableDependenciesError);
    expect(() => assertPortableDependencyRegistryMatches(required, [{
      capabilityId: SKILL_ID,
      status: "active",
      version: "1.0.0",
      digest: "a".repeat(64),
    }])).not.toThrow();
  });

  it("revalidates the exact MCP registry version", () => {
    const required = requiredDependenciesForPortableReleases([{ manifest: manifestWithMcp() }]);
    const skill = {
      capabilityId: SKILL_ID,
      status: "active",
      version: "1.0.0",
      digest: "a".repeat(64),
    };
    expect(() => assertPortableDependencyRegistryMatches(required, [
      skill,
      { capabilityId: MCP_ID, status: "active", version: "2.0.1", digest: null },
    ])).toThrow(UnresolvablePortableDependenciesError);
    expect(() => assertPortableDependencyRegistryMatches(required, [
      skill,
      { capabilityId: MCP_ID, status: "active", version: "2.0.0", digest: null },
    ])).not.toThrow();
  });
});
