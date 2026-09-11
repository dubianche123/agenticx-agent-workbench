import { enterpriseSkills, mcpServers } from "@agenticx/db-schema";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { v2ExpertManifest } from "../config-share-test-fixtures";

const mocks = vi.hoisted(() => ({
  dialectCapabilityTables: vi.fn(),
}));

vi.mock("../capability-tables", () => ({
  dialectCapabilityTables: (...args: unknown[]) => mocks.dialectCapabilityTables(...args),
}));

import { assertConfigManifestDependenciesResolvable } from "./dependencies";

const TENANT_ID = "01JQMZ8K3N4P5Q6R7S8T9VWXY0";
const SKILL_ID = "01JQMZ8K3N4P5Q6R7S8T9VWXY1";
const MCP_ID = "01JQMZ8K3N4P5Q6R7S8T9VWXY2";
const DIGEST = "a".repeat(64);

function manifestWithDependencies() {
  const manifest = v2ExpertManifest();
  manifest.dependencies = {
    skills: [{
      capability_id: `skill:${SKILL_ID}`,
      version: "1.2.3",
      digest: DIGEST,
      required: true,
    }],
    mcps: [{ capability_id: `mcp:${MCP_ID}`, version: "2.0.0", required: true }],
  };
  return manifest;
}

function installLookup(
  skillRows: unknown[] = [{ id: SKILL_ID, version: "1.2.3", bundleDigest: DIGEST, status: "active" }],
  mcpRows: unknown[] = [{ id: MCP_ID, version: "2.0.0", status: "active" }],
) {
  const db = {
    select: () => ({
      from: (table: unknown) => ({
        where: async () => table === enterpriseSkills ? skillRows : mcpRows,
      }),
    }),
  };
  mocks.dialectCapabilityTables.mockResolvedValue({
    db,
    skills: enterpriseSkills,
    mcp: mcpServers,
  });
}

describe("portable manifest dependency resolution", () => {
  beforeEach(() => mocks.dialectCapabilityTables.mockReset());

  it("accepts active tenant-local Skill/MCP rows with exact versions and Skill digest", async () => {
    installLookup();
    await expect(
      assertConfigManifestDependenciesResolvable(TENANT_ID, manifestWithDependencies()),
    ).resolves.toBeUndefined();
  });

  it("rejects dangling/cross-tenant and disabled capability references", async () => {
    installLookup([], [{ id: MCP_ID, status: "disabled" }]);
    await expect(
      assertConfigManifestDependenciesResolvable(TENANT_ID, manifestWithDependencies()),
    ).rejects.toThrow(/Skill dependency is missing/);

    installLookup(
      [{ id: SKILL_ID, version: "1.2.3", bundleDigest: DIGEST, status: "active" }],
      [{ id: MCP_ID, version: "2.0.0", status: "disabled" }],
    );
    await expect(
      assertConfigManifestDependenciesResolvable(TENANT_ID, manifestWithDependencies()),
    ).rejects.toThrow(/MCP dependency is missing/);
  });

  it("rejects a Skill reference whose immutable version or digest does not match", async () => {
    installLookup([
      { id: SKILL_ID, version: "1.2.4", bundleDigest: "b".repeat(64), status: "active" },
    ]);
    await expect(
      assertConfigManifestDependenciesResolvable(TENANT_ID, manifestWithDependencies()),
    ).rejects.toThrow(/version or digest does not match/);
  });

  it("rejects an MCP reference whose registry version does not match", async () => {
    installLookup(
      [{ id: SKILL_ID, version: "1.2.3", bundleDigest: DIGEST, status: "active" }],
      [{ id: MCP_ID, version: "2.0.1", status: "active" }],
    );
    await expect(
      assertConfigManifestDependenciesResolvable(TENANT_ID, manifestWithDependencies()),
    ).rejects.toThrow(/MCP dependency version does not match/);
  });
});
