import { createHash } from "node:crypto";
import {
  CONFIG_SHARE_MANIFEST_VERSION,
  type ConfigShareKind,
  type ConfigShareManifest,
  validateConfigShareManifest,
} from "../config-share-types";

export const CONFIG_MARKET_STATUSES = ["published", "unlisted"] as const;
export type ConfigMarketStatus = (typeof CONFIG_MARKET_STATUSES)[number];
export const CONFIG_MARKET_VISIBILITIES = [
  "company",
  "departments",
  "users",
  "personal",
  "admins_only",
] as const;
export type ConfigMarketVisibility = (typeof CONFIG_MARKET_VISIBILITIES)[number];
export const CONFIG_MARKET_DELIVERY_STATES = ["active", "revoked"] as const;
export type ConfigMarketDeliveryState = (typeof CONFIG_MARKET_DELIVERY_STATES)[number];
export const MAX_CONFIG_MARKET_AUDIENCE_IDS = 64;

export type ConfigMarketAudience = {
  visibility: ConfigMarketVisibility;
  visibleDepartmentIds: string[];
  visibleUserIds: string[];
};

export type ConfigMarketItem = {
  /** Stable server-issued artifact id and capability-pack row id. */
  id: string;
  tenantId: string;
  userId: string;
  ownerDisplayName: string;
  kind: ConfigShareKind;
  /** Publisher-owned portable artifact identity from the v2 manifest. */
  sourceArtifactId: string;
  title: string;
  description: string;
  releaseId: string;
  version: string;
  manifestVersion: typeof CONFIG_SHARE_MANIFEST_VERSION;
  digest: string;
  raw: ConfigShareManifest;
  releaseNotes: string;
  releasePublishedAt: string;
  /** Server-authoritative count of unique successful account/release reports. */
  downloadCount: number;
  status: ConfigMarketStatus;
  /** Independent from market visibility: unlisting must not stop an existing pack delivery. */
  deliveryState: ConfigMarketDeliveryState;
  visibility: ConfigMarketVisibility;
  visibleDepartmentIds: string[];
  visibleUserIds: string[];
  publishedAt: string;
  unlistedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

function audienceIds(value: unknown): string[] | null {
  const parsed = typeof value === "string" ? (() => {
    try { return JSON.parse(value) as unknown; } catch { return null; }
  })() : value;
  if (!Array.isArray(parsed) || parsed.length > MAX_CONFIG_MARKET_AUDIENCE_IDS) return null;
  const result: string[] = [];
  for (const raw of parsed) {
    if (typeof raw !== "string") return null;
    const id = raw.trim().toUpperCase();
    if (!ULID_RE.test(id) || result.includes(id)) return null;
    result.push(id);
  }
  return result.sort();
}

export function normalizeConfigMarketAudience(input: {
  visibility: unknown;
  visibleDepartmentIds: unknown;
  visibleUserIds: unknown;
}): ConfigMarketAudience | null {
  const departments = audienceIds(input.visibleDepartmentIds);
  const users = audienceIds(input.visibleUserIds);
  if (!departments || !users) return null;
  if (input.visibility === "personal" && departments.length === 0 && users.length === 0) {
    return { visibility: "personal", visibleDepartmentIds: [], visibleUserIds: [] };
  }
  if (input.visibility === "company" && departments.length === 0 && users.length === 0) {
    return { visibility: "company", visibleDepartmentIds: [], visibleUserIds: [] };
  }
  if (input.visibility === "admins_only" && departments.length === 0 && users.length === 0) {
    return { visibility: "admins_only", visibleDepartmentIds: [], visibleUserIds: [] };
  }
  if (input.visibility === "departments" && departments.length > 0 && users.length === 0) {
    return { visibility: "departments", visibleDepartmentIds: departments, visibleUserIds: [] };
  }
  if (input.visibility === "users" && users.length > 0 && departments.length === 0) {
    return { visibility: "users", visibleDepartmentIds: [], visibleUserIds: users };
  }
  return null;
}

export function sameConfigMarketAudience(left: ConfigMarketAudience, right: ConfigMarketAudience): boolean {
  return (
    left.visibility === right.visibility &&
    left.visibleDepartmentIds.join("\0") === right.visibleDepartmentIds.join("\0") &&
    left.visibleUserIds.join("\0") === right.visibleUserIds.join("\0")
  );
}

export function isValidConfigMarketId(value: string): boolean {
  return ULID_RE.test(String(value ?? "").trim().toUpperCase());
}

export function configMarketCapabilityId(
  kind: ConfigShareKind,
  id: string,
): `expert:${string}` | `group:${string}` | `skill:${string}` {
  return `${kind}:${id.toUpperCase()}`;
}

export function configMarketCanonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(configMarketCanonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${configMarketCanonicalJson(object[key])}`)
    .join(",")}}`;
}

export function configMarketCanonicalRaw(manifest: ConfigShareManifest): string {
  return configMarketCanonicalJson(manifest);
}

export function configMarketManifestDigest(manifest: ConfigShareManifest): string {
  return createHash("sha256").update(configMarketCanonicalRaw(manifest), "utf8").digest("hex");
}

/**
 * Return the required Skill/MCP references carried by a market manifest.
 *
 * This deliberately lives with the market contract instead of importing the
 * portable-runtime helper: that helper models executable expert/group
 * packages and intentionally rejects a single-file market Skill.  Validation
 * remains the same authoritative manifest validation used at publication and
 * delivery boundaries.
 */
export type ConfigMarketRequiredDependency = {
  kind: "skill" | "mcp";
  capabilityId: string;
  version: string;
  digest: string | null;
  required: true;
};

export function requiredConfigMarketDependencies(
  value: unknown,
): ConfigMarketRequiredDependency[] {
  const manifest = validateConfigShareManifest(value);
  return [
    ...manifest.dependencies.skills
      .filter((dependency) => dependency.required)
      .map((dependency) => ({
        kind: "skill" as const,
        capabilityId: dependency.capability_id,
        version: dependency.version,
        digest: dependency.digest,
        required: true as const,
      })),
    ...manifest.dependencies.mcps
      .filter((dependency) => dependency.required)
      .map((dependency) => ({
        kind: "mcp" as const,
        capabilityId: dependency.capability_id,
        version: dependency.version,
        digest: null,
        required: true as const,
      })),
  ];
}

export type ConfigMarketMetadataSource = Pick<
  ConfigMarketItem,
  | "id"
  | "kind"
  | "sourceArtifactId"
  | "manifestVersion"
  | "releaseId"
  | "version"
  | "title"
  | "description"
  | "ownerDisplayName"
  | "status"
  | "deliveryState"
  | "visibility"
  | "visibleDepartmentIds"
  | "visibleUserIds"
  | "digest"
  | "releaseNotes"
  | "releasePublishedAt"
  | "downloadCount"
  | "publishedAt"
  | "createdAt"
  | "updatedAt"
>;

export function toConfigMarketMetadata(item: ConfigMarketMetadataSource) {
  return {
    id: item.id,
    capabilityId: configMarketCapabilityId(item.kind, item.id),
    kind: item.kind,
    source_artifact_id: item.sourceArtifactId,
    manifest_version: item.manifestVersion,
    release_id: item.releaseId,
    version: item.version,
    title: item.title,
    description: item.description,
    ownerDisplayName: item.ownerDisplayName,
    status: item.status,
    deliveryState: item.deliveryState ?? "active",
    visibility: item.visibility,
    visibleDepartmentCount: item.visibleDepartmentIds.length,
    visibleUserCount: item.visibleUserIds.length,
    digest: item.digest,
    release_notes: item.releaseNotes,
    release_published_at: item.releasePublishedAt,
    downloadCount: item.downloadCount,
    publishedAt: item.publishedAt,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

export type ConfigMarketMetadata = ReturnType<typeof toConfigMarketMetadata>;

export function toConfigMarketDetail(item: ConfigMarketItem) {
  return { item: toConfigMarketMetadata(item), raw: configMarketCanonicalRaw(item.raw) };
}

export type ManagedPortablePackage = {
  id: `expert:${string}` | `group:${string}` | `skill:${string}`;
  kind: ConfigShareKind;
  title: string;
  releaseId: string;
  version: string;
  digest: string;
  /** Canonical JSON string; digest is SHA-256 over these exact UTF-8 bytes. */
  raw: string;
};

export function toManagedPortablePackage(item: ConfigMarketItem): ManagedPortablePackage {
  return {
    id: configMarketCapabilityId(item.kind, item.id),
    kind: item.kind,
    title: item.title,
    releaseId: item.releaseId,
    version: item.version,
    digest: item.digest,
    raw: configMarketCanonicalRaw(item.raw),
  };
}
