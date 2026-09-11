import { parseCapabilityId } from "@agenticx/config";
import { and, eq, inArray } from "drizzle-orm";

import { dialectCapabilityTables } from "../capability-tables";
import {
  ConfigShareValidationError,
  type ConfigShareManifest,
} from "../config-share-types";

type SkillDependencyRow = {
  id: string;
  version: string;
  bundleDigest: string | null;
  status: string;
};

type McpDependencyRow = {
  id: string;
  version: string;
  status: string;
};

/**
 * Resolve every manifest dependency inside the authenticated tenant.
 *
 * The portable file contains stable references, not Skill/MCP binaries or credentials.
 * Accepting an absent, disabled, cross-tenant, or mismatched Skill here would publish an
 * artifact that no employee can reproduce. This is therefore authoritative server-side
 * validation, independent of Desktop's local preview checks.
 */
export async function assertConfigManifestDependenciesResolvable(
  tenantId: string,
  manifest: ConfigShareManifest,
): Promise<void> {
  const skillRefs = manifest.dependencies.skills.map((dependency) => {
    const parsed = parseCapabilityId(dependency.capability_id);
    if (parsed?.kind !== "skill") {
      throw new ConfigShareValidationError(`invalid Skill dependency: ${dependency.capability_id}`);
    }
    return { dependency, id: parsed.rowId };
  });
  const mcpRefs = manifest.dependencies.mcps.map((dependency) => {
    const parsed = parseCapabilityId(dependency.capability_id);
    if (parsed?.kind !== "mcp") {
      throw new ConfigShareValidationError(`invalid MCP dependency: ${dependency.capability_id}`);
    }
    return { dependency, id: parsed.rowId };
  });
  if (skillRefs.length === 0 && mcpRefs.length === 0) return;

  const { db, skills, mcp } = await dialectCapabilityTables();
  const queryDb = db as any;
  const [skillRows, mcpRows] = await Promise.all([
    skillRefs.length > 0
      ? queryDb
          .select({
            id: skills.id,
            version: skills.version,
            bundleDigest: skills.bundleDigest,
            status: skills.status,
          })
          .from(skills)
          .where(
            and(
              eq(skills.tenantId, tenantId),
              inArray(skills.id, skillRefs.map((entry) => entry.id)),
            ),
          )
      : Promise.resolve([]),
    mcpRefs.length > 0
      ? queryDb
          .select({ id: mcp.id, version: mcp.version, status: mcp.status })
          .from(mcp)
          .where(
            and(
              eq(mcp.tenantId, tenantId),
              inArray(mcp.id, mcpRefs.map((entry) => entry.id)),
            ),
          )
      : Promise.resolve([]),
  ] as const) as [SkillDependencyRow[], McpDependencyRow[]];

  const registeredSkills = new Map(skillRows.map((row) => [row.id, row] as const));
  for (const { dependency, id } of skillRefs) {
    const row = registeredSkills.get(id);
    if (!row || row.status !== "active") {
      throw new ConfigShareValidationError(
        `Skill dependency is missing, disabled, or belongs to another tenant: ${dependency.capability_id}`,
      );
    }
    if (
      row.version !== dependency.version ||
      !row.bundleDigest ||
      row.bundleDigest.toLowerCase() !== dependency.digest
    ) {
      throw new ConfigShareValidationError(
        `Skill dependency version or digest does not match the tenant registry: ${dependency.capability_id}`,
      );
    }
  }

  const registeredMcps = new Map(mcpRows.map((row) => [row.id, row] as const));
  for (const { dependency, id } of mcpRefs) {
    const row = registeredMcps.get(id);
    if (!row || row.status !== "active") {
      throw new ConfigShareValidationError(
        `MCP dependency is missing, disabled, or belongs to another tenant: ${dependency.capability_id}`,
      );
    }
    if (row.version !== dependency.version) {
      throw new ConfigShareValidationError(
        `MCP dependency version does not match the tenant registry: ${dependency.capability_id}`,
      );
    }
  }
}
