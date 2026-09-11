import { canonicalizeCapabilityId, parseCapabilityId } from "./capability-id";

export type PortableRuntimeDependency = {
  kind: "skill" | "mcp";
  capabilityId: string;
  version: string;
  digest: string | null;
  required: boolean;
};

export type PortableRuntimeResource = {
  path: string;
  content: string;
  digest: string;
};

export type PortableRuntimePermissionMode = "plan" | "ask" | "auto";

/** Runtime permission declared by one expert in a portable-v2 package. */
export type PortableRuntimeExpertPermission = {
  name: string;
  defaultPermissionMode: PortableRuntimePermissionMode;
};

export type PortableRuntimeContract = {
  recommendedPermissionMode: PortableRuntimePermissionMode;
  /** One entry for an expert package, or one entry for every group member. */
  expertPermissions: PortableRuntimeExpertPermission[];
  dependencies: PortableRuntimeDependency[];
  resources: PortableRuntimeResource[];
};

const DIGEST_RE = /^[0-9a-f]{64}$/i;
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

function record(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try {
      return record(JSON.parse(value) as unknown);
    } catch {
      return null;
    }
  }
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function dependency(
  value: unknown,
  kind: "skill" | "mcp",
  index: number,
): PortableRuntimeDependency {
  const item = record(value);
  const canonical = typeof item?.capability_id === "string"
    ? canonicalizeCapabilityId(item.capability_id)
    : null;
  const parsed = canonical ? parseCapabilityId(canonical) : null;
  if (!item || !canonical || parsed?.kind !== kind) {
    throw new Error(`stored portable ${kind} dependency ${index} is inconsistent`);
  }
  if (typeof item.version !== "string" || !SEMVER_RE.test(item.version)) {
    throw new Error(`stored portable ${kind} dependency ${index} version is inconsistent`);
  }
  if (typeof item.required !== "boolean") {
    throw new Error(`stored portable ${kind} dependency ${index} required flag is inconsistent`);
  }
  const digest = kind === "skill" ? item.digest : null;
  if (kind === "skill" && (typeof digest !== "string" || !DIGEST_RE.test(digest))) {
    throw new Error(`stored portable skill dependency ${index} digest is inconsistent`);
  }
  return {
    kind,
    capabilityId: canonical,
    version: item.version,
    digest: typeof digest === "string" ? digest.toLowerCase() : null,
    required: item.required,
  };
}

function expertPermissions(value: unknown, kind: unknown): PortableRuntimeExpertPermission[] {
  const payload = record(value);
  const declarations = kind === "expert"
    ? (payload ? [payload] : null)
    : kind === "group" && Array.isArray(payload?.members)
      ? payload.members
      : null;
  if (!declarations || declarations.length === 0) {
    throw new Error("stored portable expert declarations are inconsistent");
  }
  return declarations.map((value, index) => {
    const declaration = record(value);
    const name = declaration?.name;
    const permission = declaration?.default_permission_mode;
    if (
      !declaration ||
      typeof name !== "string" ||
      !name.trim() ||
      (permission !== "plan" && permission !== "ask" && permission !== "auto")
    ) {
      throw new Error(`stored portable expert declaration ${index} permission is inconsistent`);
    }
    return { name, defaultPermissionMode: permission };
  });
}

/**
 * Extract the runtime-affecting portion of an already validated portable-v2 manifest.
 * Persisted rows are still treated as untrusted: malformed rows fail closed at review/delivery.
 */
export function portableRuntimeContractFromManifest(value: unknown): PortableRuntimeContract {
  const manifest = record(value);
  const dependencies = record(manifest?.dependencies);
  const permission = manifest?.recommended_permission_mode;
  if (
    !manifest ||
    manifest.schema_version !== 2 ||
    (manifest.kind !== "expert" && manifest.kind !== "group") ||
    !dependencies ||
    !Array.isArray(dependencies.skills) ||
    !Array.isArray(dependencies.mcps) ||
    !Array.isArray(manifest.resources) ||
    (permission !== "plan" && permission !== "ask" && permission !== "auto")
  ) {
    throw new Error("stored portable runtime contract is inconsistent");
  }

  const expertPermissionDeclarations = expertPermissions(manifest.payload, manifest.kind);

  const parsedDependencies = [
    ...dependencies.skills.map((item, index) => dependency(item, "skill", index)),
    ...dependencies.mcps.map((item, index) => dependency(item, "mcp", index)),
  ];
  const seen = new Set<string>();
  for (const item of parsedDependencies) {
    if (seen.has(item.capabilityId)) {
      throw new Error(`stored portable dependency is duplicated: ${item.capabilityId}`);
    }
    seen.add(item.capabilityId);
  }

  const resources = manifest.resources.map((value, index): PortableRuntimeResource => {
    const item = record(value);
    if (
      !item ||
      typeof item.path !== "string" ||
      typeof item.content !== "string" ||
      typeof item.digest !== "string" ||
      !DIGEST_RE.test(item.digest)
    ) {
      throw new Error(`stored portable resource ${index} is inconsistent`);
    }
    return { path: item.path, content: item.content, digest: item.digest.toLowerCase() };
  });

  return {
    recommendedPermissionMode: permission,
    expertPermissions: expertPermissionDeclarations,
    dependencies: parsedDependencies,
    resources,
  };
}

export function requiredPortableDependencies(value: unknown): PortableRuntimeDependency[] {
  return portableRuntimeContractFromManifest(value).dependencies.filter((item) => item.required);
}
