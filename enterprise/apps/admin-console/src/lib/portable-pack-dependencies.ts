import {
  canonicalizeCapabilityId,
  parseCapabilityId,
  requiredPortableDependencies,
  type PortableRuntimeDependency,
} from "@agenticx/config";

function record(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try { return record(JSON.parse(value) as unknown); } catch { return null; }
  }
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** The generic portable-runtime contract intentionally excludes single-file market Skills. */
function requiredDependencies(value: unknown): PortableRuntimeDependency[] {
  const manifest = record(value);
  if (manifest?.kind !== "skill") return requiredPortableDependencies(value);
  const dependencies = record(manifest.dependencies);
  if (!dependencies || !Array.isArray(dependencies.skills) || !Array.isArray(dependencies.mcps)) {
    throw new Error("stored market Skill dependencies are inconsistent");
  }
  const parse = (candidate: unknown, kind: "skill" | "mcp", index: number): PortableRuntimeDependency => {
    const item = record(candidate);
    const canonical = typeof item?.capability_id === "string"
      ? canonicalizeCapabilityId(item.capability_id)
      : null;
    const parsed = canonical ? parseCapabilityId(canonical) : null;
    if (!item || !canonical || parsed?.kind !== kind || typeof item.version !== "string" || typeof item.required !== "boolean") {
      throw new Error(`stored market ${kind} dependency ${index} is inconsistent`);
    }
    const digest = kind === "skill" ? item.digest : null;
    if (kind === "skill" && (typeof digest !== "string" || !/^[a-f0-9]{64}$/iu.test(digest))) {
      throw new Error(`stored market Skill dependency ${index} digest is inconsistent`);
    }
    return {
      kind,
      capabilityId: canonical,
      version: item.version,
      digest: typeof digest === "string" ? digest.toLowerCase() : null,
      required: item.required,
    };
  };
  const parsed = [
    ...dependencies.skills.map((item, index) => parse(item, "skill", index)),
    ...dependencies.mcps.map((item, index) => parse(item, "mcp", index)),
  ];
  if (new Set(parsed.map((item) => item.capabilityId)).size !== parsed.length) {
    throw new Error("stored market Skill dependencies are duplicated");
  }
  return parsed.filter((item) => item.required);
}

export class MissingPortableDependenciesError extends Error {
  public readonly missingCapabilityIds: string[];

  public constructor(missingCapabilityIds: readonly string[]) {
    const missing = [...new Set(missingCapabilityIds)].sort();
    super(`portable package required dependencies missing from capability pack: ${missing.join(", ")}`);
    this.name = "MissingPortableDependenciesError";
    this.missingCapabilityIds = missing;
  }
}

export function assertPortablePackRequiredDependencies(
  selectedCapabilityIds: readonly string[],
  portableReleases: ReadonlyArray<{ capabilityId: string; manifest: unknown }>,
): void {
  const selected = new Set(selectedCapabilityIds);
  const missing: string[] = [];
  for (const release of portableReleases) {
    for (const dependency of requiredDependencies(release.manifest)) {
      if (!selected.has(dependency.capabilityId)) missing.push(dependency.capabilityId);
    }
  }
  if (missing.length > 0) throw new MissingPortableDependenciesError(missing);
}

export class UnresolvablePortableDependenciesError extends Error {
  public readonly dependencyCapabilityIds: string[];

  public constructor(dependencyCapabilityIds: readonly string[]) {
    const ids = [...new Set(dependencyCapabilityIds)].sort();
    super(`portable package dependencies are missing, disabled, or mismatched in the tenant registry: ${ids.join(", ")}`);
    this.name = "UnresolvablePortableDependenciesError";
    this.dependencyCapabilityIds = ids;
  }
}

export type PortableDependencyRegistryRow = {
  capabilityId: string;
  status: string;
  version: string | null;
  digest: string | null;
};

export function requiredDependenciesForPortableReleases(
  portableReleases: ReadonlyArray<{ manifest: unknown }>,
): PortableRuntimeDependency[] {
  return portableReleases.flatMap((release) => requiredDependencies(release.manifest));
}

export function assertPortableDependencyRegistryMatches(
  required: readonly PortableRuntimeDependency[],
  registryRows: readonly PortableDependencyRegistryRow[],
): void {
  const registry = new Map(registryRows.map((row) => [row.capabilityId, row] as const));
  const invalid: string[] = [];
  for (const dependency of required) {
    const row = registry.get(dependency.capabilityId);
    if (!row || row.status !== "active") {
      invalid.push(dependency.capabilityId);
      continue;
    }
    if (
      dependency.kind === "skill" &&
      (row.version !== dependency.version || row.digest?.toLowerCase() !== dependency.digest)
    ) {
      invalid.push(dependency.capabilityId);
    }
    if (dependency.kind === "mcp" && row.version !== dependency.version) {
      invalid.push(dependency.capabilityId);
    }
  }
  if (invalid.length > 0) throw new UnresolvablePortableDependenciesError(invalid);
}
