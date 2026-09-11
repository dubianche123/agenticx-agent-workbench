import { createHash } from "node:crypto";
import { canonicalizeCapabilityId, parseCapabilityId, parseSkillFrontMatter } from "@agenticx/config";

export const CONFIG_SHARE_MANIFEST_VERSION = 2 as const;
export const MAX_CONFIG_SHARE_MANIFEST_BYTES = 256 * 1024;
export const MAX_CONFIG_SHARE_TITLE_CHARS = 120;
export const MAX_CONFIG_SHARE_DESCRIPTION_CHARS = 2_000;
export const MAX_CONFIG_SHARE_EXPERT_NAME_CHARS = 80;
export const MAX_CONFIG_SHARE_SKILL_NAME_CHARS = 128;
/** A market Skill is deliberately a single instruction file, not an arbitrary archive. */
export const MAX_CONFIG_SHARE_SKILL_MD_BYTES = 128 * 1024;
export const MAX_CONFIG_SHARE_ROLE_CHARS = 160;
export const MAX_CONFIG_SHARE_SYSTEM_PROMPT_CHARS = 12_000;
export const MAX_CONFIG_SHARE_TAGS = 8;
export const MAX_CONFIG_SHARE_TAG_CHARS = 24;
export const MAX_CONFIG_SHARE_GROUP_MEMBERS = 12;
export const MAX_CONFIG_SHARE_SKILL_DEPENDENCIES = 32;
export const MAX_CONFIG_SHARE_MCP_DEPENDENCIES = 32;
export const MAX_CONFIG_SHARE_RESOURCES = 24;
export const MAX_CONFIG_SHARE_RESOURCE_BYTES = 64 * 1024;
export const MAX_CONFIG_SHARE_RESOURCE_TOTAL_BYTES = 192 * 1024;
export const MAX_CONFIG_SHARE_WORKSPACE_SLOTS = 8;

export const CONFIG_SHARE_KINDS = ["expert", "group", "skill"] as const;
export type ConfigShareKind = (typeof CONFIG_SHARE_KINDS)[number];
export type ConfigSharePermissionMode = "plan" | "ask" | "auto";
export type ConfigShareGroupRouting =
  | "intelligent"
  | "user-directed"
  | "meta-routed"
  | "round-robin"
  | "team";

export type ConfigShareSkillDependency = {
  capability_id: string;
  version: string;
  digest: string;
  required: boolean;
};
export type ConfigShareMcpDependency = {
  capability_id: string;
  version: string;
  required: boolean;
};
export type ConfigShareResource = { path: string; content: string; digest: string };
export type ConfigShareWorkspaceSlot = {
  name: string;
  access: "read-only" | "read-write";
  required: boolean;
};

/**
 * The expert declaration is intentionally explicit.  It is the portable-v2
 * runtime contract consumed by both the Python importer and enterprise
 * market validation; an omitted default mode must never silently inherit the
 * recipient's global mode.
 */
export type ConfigShareExpertPayload = {
  name: string;
  role: string;
  description: string;
  tags: string[];
  system_prompt: string;
  color: "black" | "blue" | "white";
  default_permission_mode: ConfigSharePermissionMode;
};

export type ConfigShareGroupPayload = {
  name: string;
  members: ConfigShareExpertPayload[];
  host_member_index: number;
  routing: ConfigShareGroupRouting;
};

/**
 * The market Skill payload is intentionally narrow.  A publication carries one
 * standard SKILL.md file only; executable files, archives, and arbitrary paths
 * are not part of this transport contract.
 */
export type ConfigShareSkillPayload = {
  name: string;
  description: string;
  skill_md: string;
};

export type ConfigSharePayload =
  | ConfigShareExpertPayload
  | ConfigShareGroupPayload
  | ConfigShareSkillPayload;

export type ConfigShareManifest = {
  schema_version: typeof CONFIG_SHARE_MANIFEST_VERSION;
  artifact_id: string;
  release_version: string;
  kind: ConfigShareKind;
  title: string;
  description: string;
  recommended_permission_mode: ConfigSharePermissionMode;
  dependencies: {
    skills: ConfigShareSkillDependency[];
    mcps: ConfigShareMcpDependency[];
  };
  resources: ConfigShareResource[];
  workspace_slots: ConfigShareWorkspaceSlot[];
  payload: ConfigSharePayload;
};

export type ConfigShareCreateRequest = {
  kind: ConfigShareKind;
  manifest_version: typeof CONFIG_SHARE_MANIFEST_VERSION;
  manifest: ConfigShareManifest;
};

export type ConfigShareSnapshot = {
  token: string;
  tenantId: string;
  userId: string;
  ownerDisplayName: string;
  kind: ConfigShareKind;
  manifestVersion: typeof CONFIG_SHARE_MANIFEST_VERSION;
  title: string;
  manifest: ConfigShareManifest;
  createdAt: string;
};

export class ConfigShareValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ConfigShareValidationError";
  }
}

const CREATE_REQUEST_KEYS = ["kind", "manifest", "manifest_version"] as const;
const MANIFEST_KEYS = [
  "artifact_id",
  "dependencies",
  "description",
  "kind",
  "payload",
  "recommended_permission_mode",
  "release_version",
  "resources",
  "schema_version",
  "title",
  "workspace_slots",
] as const;
const DEPENDENCY_KEYS = ["mcps", "skills"] as const;
const SKILL_DEPENDENCY_KEYS = ["capability_id", "digest", "required", "version"] as const;
const MCP_DEPENDENCY_KEYS = ["capability_id", "required", "version"] as const;
const RESOURCE_KEYS = ["content", "digest", "path"] as const;
const WORKSPACE_SLOT_KEYS = ["access", "name", "required"] as const;
const EXPERT_PAYLOAD_KEYS = [
  "color",
  "default_permission_mode",
  "description",
  "name",
  "role",
  "system_prompt",
  "tags",
] as const;
const GROUP_PAYLOAD_KEYS = ["host_member_index", "members", "name", "routing"] as const;
const SKILL_PAYLOAD_KEYS = ["description", "name", "skill_md"] as const;
const COLORS = new Set(["black", "blue", "white"]);
const PERMISSION_MODES = new Set(["plan", "ask", "auto"]);
const GROUP_ROUTING = new Set([
  "intelligent",
  "user-directed",
  "meta-routed",
  "round-robin",
  "team",
]);
const BIDI_CONTROL_CODEPOINTS = new Set([
  0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067,
  0x2068, 0x2069,
]);
const TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;
const ARTIFACT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const DIGEST_RE = /^[a-fA-F0-9]{64}$/;
const WORKSPACE_SLOT_RE = /^[a-z][a-z0-9_-]{0,63}$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactlyKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function isConfigShareKind(value: unknown): value is ConfigShareKind {
  return value === "expert" || value === "group" || value === "skill";
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function assertExactTextUnicode(value: string, field: string, singleLine = false): void {
  for (const char of value) {
    const codepoint = char.codePointAt(0) ?? 0;
    if ((codepoint >= 0xd800 && codepoint <= 0xdfff) || BIDI_CONTROL_CODEPOINTS.has(codepoint)) {
      throw new ConfigShareValidationError(`${field} contains unsafe Unicode controls`);
    }
    if (
      (codepoint < 0x20 && char !== "\n" && char !== "\r" && char !== "\t") ||
      (codepoint >= 0x7f && codepoint <= 0x9f)
    ) {
      throw new ConfigShareValidationError(`${field} cannot contain control characters`);
    }
    if (
      singleLine &&
      (char === "\n" || char === "\r" || char === "\t" || codepoint === 0x2028 || codepoint === 0x2029)
    ) {
      throw new ConfigShareValidationError(`${field} must be a single line`);
    }
  }
}

/** Exact-text Unicode guard shared by non-manifest portable envelope fields. */
export function assertConfigShareExactTextUnicode(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string") throw new ConfigShareValidationError(`${field} must be a string`);
  assertExactTextUnicode(value, field);
}

function boundedString(
  value: unknown,
  field: string,
  maxChars: number,
  options: { required?: boolean; singleLine?: boolean } = {},
): string {
  if (typeof value !== "string") throw new ConfigShareValidationError(`${field} must be a string`);
  const normalized = value.trim();
  if (options.required && !normalized) throw new ConfigShareValidationError(`${field} cannot be empty`);
  if ([...normalized].length > maxChars) {
    throw new ConfigShareValidationError(`${field} max ${maxChars} characters`);
  }
  assertExactTextUnicode(normalized, field, options.singleLine);
  return normalized;
}

function semver(value: unknown, field: string): string {
  const version = boundedString(value, field, 64, { required: true, singleLine: true });
  if (!SEMVER_RE.test(version)) {
    throw new ConfigShareValidationError(`${field} must be a valid SemVer 2 version`);
  }
  return version;
}

function dependencyCapabilityId(value: unknown, kind: "skill" | "mcp", field: string): string {
  if (typeof value !== "string") {
    throw new ConfigShareValidationError(`${field} is invalid`);
  }
  const canonical = canonicalizeCapabilityId(value);
  const parsed = canonical ? parseCapabilityId(canonical) : null;
  if (!canonical || parsed?.kind !== kind) {
    throw new ConfigShareValidationError(
      `${field} must be a canonical ${kind}:<ULID> capability reference`,
    );
  }
  // The platform parser deliberately accepts lowercase Crockford input. Persist only
  // its canonical uppercase representation so Desktop and enterprise tables cannot
  // disagree about identity by case.
  return canonical;
}

/**
 * A conservative JavaScript approximation of Unicode default case folding.
 * NFKC only adds collisions (it cannot make two Python-casefold-equal paths distinct),
 * while these two multi-character/context folds cover the gaps in ECMAScript lowercasing.
 */
function unicodeCaseFoldCollisionKey(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("und")
    .replaceAll("ß", "ss")
    .replaceAll("ς", "σ");
}

export function compareConfigShareVersions(left: string, right: string): number {
  const compareDecimal = (a: string, b: string): number => {
    if (a.length !== b.length) return a.length < b.length ? -1 : 1;
    if (a === b) return 0;
    return a < b ? -1 : 1;
  };
  const parse = (value: string) => {
    const match = SEMVER_RE.exec(value);
    if (!match) throw new ConfigShareValidationError("version must be valid SemVer 2");
    return {
      core: [match[1]!, match[2]!, match[3]!],
      prerelease: match[4]?.split(".") ?? null,
    };
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    const order = compareDecimal(a.core[index]!, b.core[index]!);
    if (order !== 0) return order;
  }
  if (a.prerelease === null || b.prerelease === null) {
    if (a.prerelease === b.prerelease) return 0;
    return a.prerelease === null ? 1 : -1;
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const x = a.prerelease[index];
    const y = b.prerelease[index];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    if (x === y) continue;
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) return compareDecimal(x, y);
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

function validateTags(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_CONFIG_SHARE_TAGS) {
    throw new ConfigShareValidationError(`${field} must contain at most ${MAX_CONFIG_SHARE_TAGS} tags`);
  }
  const tags = value.map((item, index) =>
    boundedString(item, `${field}[${index}]`, MAX_CONFIG_SHARE_TAG_CHARS, {
      required: true,
      singleLine: true,
    }),
  );
  if (new Set(tags.map(unicodeCaseFoldCollisionKey)).size !== tags.length) {
    throw new ConfigShareValidationError(`${field} contains duplicates`);
  }
  return tags;
}

function validateExpertPayload(value: unknown, field: string): ConfigShareExpertPayload {
  if (!isPlainObject(value) || !hasExactlyKeys(value, EXPERT_PAYLOAD_KEYS)) {
    throw new ConfigShareValidationError(`${field} must contain exactly: ${EXPERT_PAYLOAD_KEYS.join(", ")}`);
  }
  const color = boundedString(value.color, `${field}.color`, 16, {
    required: true,
    singleLine: true,
  }).toLowerCase();
  if (!COLORS.has(color)) throw new ConfigShareValidationError(`${field}.color must be black, blue, or white`);
  const defaultPermissionMode = boundedString(
    value.default_permission_mode,
    `${field}.default_permission_mode`,
    8,
    { required: true, singleLine: true },
  );
  if (!PERMISSION_MODES.has(defaultPermissionMode)) {
    throw new ConfigShareValidationError(
      `${field}.default_permission_mode must be plan, ask, or auto`,
    );
  }
  return {
    name: boundedString(value.name, `${field}.name`, MAX_CONFIG_SHARE_EXPERT_NAME_CHARS, {
      required: true,
      singleLine: true,
    }),
    role: boundedString(value.role, `${field}.role`, MAX_CONFIG_SHARE_ROLE_CHARS, { singleLine: true }),
    description: boundedString(value.description, `${field}.description`, MAX_CONFIG_SHARE_DESCRIPTION_CHARS),
    tags: validateTags(value.tags, `${field}.tags`),
    system_prompt: boundedString(value.system_prompt, `${field}.system_prompt`, MAX_CONFIG_SHARE_SYSTEM_PROMPT_CHARS),
    color: color as ConfigShareExpertPayload["color"],
    default_permission_mode: defaultPermissionMode as ConfigSharePermissionMode,
  };
}

function validateGroupPayload(value: unknown): ConfigShareGroupPayload {
  if (!isPlainObject(value) || !hasExactlyKeys(value, GROUP_PAYLOAD_KEYS)) {
    throw new ConfigShareValidationError(`manifest.payload must contain exactly: ${GROUP_PAYLOAD_KEYS.join(", ")}`);
  }
  if (!Array.isArray(value.members) || value.members.length < 1 || value.members.length > MAX_CONFIG_SHARE_GROUP_MEMBERS) {
    throw new ConfigShareValidationError(`manifest.payload.members must contain 1-${MAX_CONFIG_SHARE_GROUP_MEMBERS} members`);
  }
  const members = value.members.map((member, index) =>
    validateExpertPayload(member, `manifest.payload.members[${index}]`),
  );
  if (
    typeof value.host_member_index !== "number" ||
    !Number.isInteger(value.host_member_index) ||
    value.host_member_index < 0 ||
    value.host_member_index >= members.length
  ) {
    throw new ConfigShareValidationError("manifest.payload.host_member_index must reference an existing member");
  }
  if (typeof value.routing !== "string" || !GROUP_ROUTING.has(value.routing)) {
    throw new ConfigShareValidationError("manifest.payload.routing is invalid");
  }
  return {
    name: boundedString(value.name, "manifest.payload.name", MAX_CONFIG_SHARE_TITLE_CHARS, {
      required: true,
      singleLine: true,
    }),
    members,
    host_member_index: value.host_member_index,
    routing: value.routing as ConfigShareGroupRouting,
  };
}

function validateSkillPayload(value: unknown): ConfigShareSkillPayload {
  if (!isPlainObject(value) || !hasExactlyKeys(value, SKILL_PAYLOAD_KEYS)) {
    throw new ConfigShareValidationError(
      `manifest.payload must contain exactly: ${SKILL_PAYLOAD_KEYS.join(", ")}`,
    );
  }
  const name = boundedString(value.name, "manifest.payload.name", MAX_CONFIG_SHARE_SKILL_NAME_CHARS, {
    required: true,
    singleLine: true,
  });
  // Skill names are loader-facing identifiers, rather than display labels.  Keeping
  // this narrow prevents a publication from writing outside its managed skill folder.
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(name)) {
    throw new ConfigShareValidationError(
      "manifest.payload.name must be a lowercase Skill identifier",
    );
  }
  const description = boundedString(
    value.description,
    "manifest.payload.description",
    MAX_CONFIG_SHARE_DESCRIPTION_CHARS,
    { required: true },
  );
  if (typeof value.skill_md !== "string") {
    throw new ConfigShareValidationError("manifest.payload.skill_md must be a string");
  }
  if (!value.skill_md.trim()) {
    throw new ConfigShareValidationError("manifest.payload.skill_md cannot be empty");
  }
  assertExactTextUnicode(value.skill_md, "manifest.payload.skill_md");
  if (utf8ByteLength(value.skill_md) > MAX_CONFIG_SHARE_SKILL_MD_BYTES) {
    throw new ConfigShareValidationError(
      `manifest.payload.skill_md max ${MAX_CONFIG_SHARE_SKILL_MD_BYTES} UTF-8 bytes`,
    );
  }

  // Agent Skills are Markdown files with a small YAML front matter block.  This is
  // deliberately a structural check only: the content is not treated as a security
  // policy and we do not claim to detect prompt injection with a regex catalogue.
  const frontMatter = parseSkillFrontMatter(value.skill_md);
  if (!frontMatter) {
    throw new ConfigShareValidationError(
      "manifest.payload.skill_md must contain valid YAML front matter with string name and description",
    );
  }
  if (frontMatter.name !== name) {
    throw new ConfigShareValidationError(
      "manifest.payload.name must match the SKILL.md front matter name",
    );
  }
  return { name, description, skill_md: value.skill_md };
}

function validateDependencies(value: unknown): ConfigShareManifest["dependencies"] {
  if (!isPlainObject(value) || !hasExactlyKeys(value, DEPENDENCY_KEYS)) {
    throw new ConfigShareValidationError(`manifest.dependencies must contain exactly: ${DEPENDENCY_KEYS.join(", ")}`);
  }
  if (!Array.isArray(value.skills) || !Array.isArray(value.mcps)) {
    throw new ConfigShareValidationError("manifest.dependencies skills and mcps must be arrays");
  }
  if (value.skills.length > MAX_CONFIG_SHARE_SKILL_DEPENDENCIES) {
    throw new ConfigShareValidationError(`manifest.dependencies.skills max ${MAX_CONFIG_SHARE_SKILL_DEPENDENCIES} entries`);
  }
  if (value.mcps.length > MAX_CONFIG_SHARE_MCP_DEPENDENCIES) {
    throw new ConfigShareValidationError(`manifest.dependencies.mcps max ${MAX_CONFIG_SHARE_MCP_DEPENDENCIES} entries`);
  }
  const skills = value.skills.map((candidate, index) => {
    if (!isPlainObject(candidate) || !hasExactlyKeys(candidate, SKILL_DEPENDENCY_KEYS)) {
      throw new ConfigShareValidationError(`manifest.dependencies.skills[${index}] has invalid fields`);
    }
    const capabilityId = dependencyCapabilityId(
      candidate.capability_id,
      "skill",
      `manifest.dependencies.skills[${index}].capability_id`,
    );
    if (typeof candidate.digest !== "string" || !DIGEST_RE.test(candidate.digest)) {
      throw new ConfigShareValidationError(`manifest.dependencies.skills[${index}].digest is invalid`);
    }
    if (typeof candidate.required !== "boolean") throw new ConfigShareValidationError(`manifest.dependencies.skills[${index}].required must be boolean`);
    return {
      capability_id: capabilityId,
      version: semver(candidate.version, `manifest.dependencies.skills[${index}].version`),
      digest: candidate.digest.toLowerCase(),
      required: candidate.required,
    };
  });
  const mcps = value.mcps.map((candidate, index) => {
    if (!isPlainObject(candidate) || !hasExactlyKeys(candidate, MCP_DEPENDENCY_KEYS)) {
      throw new ConfigShareValidationError(`manifest.dependencies.mcps[${index}] has invalid fields`);
    }
    const capabilityId = dependencyCapabilityId(
      candidate.capability_id,
      "mcp",
      `manifest.dependencies.mcps[${index}].capability_id`,
    );
    if (typeof candidate.required !== "boolean") throw new ConfigShareValidationError(`manifest.dependencies.mcps[${index}].required must be boolean`);
    return {
      capability_id: capabilityId,
      version: semver(candidate.version, `manifest.dependencies.mcps[${index}].version`),
      required: candidate.required,
    };
  });
  const ids = [...skills, ...mcps].map((item) => item.capability_id);
  if (new Set(ids).size !== ids.length) throw new ConfigShareValidationError("manifest.dependencies contains duplicate capability ids");
  return { skills, mcps };
}

function validateResources(value: unknown): ConfigShareResource[] {
  if (!Array.isArray(value) || value.length > MAX_CONFIG_SHARE_RESOURCES) {
    throw new ConfigShareValidationError(`manifest.resources max ${MAX_CONFIG_SHARE_RESOURCES} entries`);
  }
  const paths = new Set<string>();
  let totalBytes = 0;
  return value.map((candidate, index) => {
    if (!isPlainObject(candidate) || !hasExactlyKeys(candidate, RESOURCE_KEYS)) {
      throw new ConfigShareValidationError(`manifest.resources[${index}] has invalid fields`);
    }
    const path = boundedString(candidate.path, `manifest.resources[${index}].path`, 240, {
      required: true,
      singleLine: true,
    });
    if (path.normalize("NFC") !== path) {
      throw new ConfigShareValidationError(
        `manifest.resources[${index}].path must use Unicode NFC normalization`,
      );
    }
    const segments = path.split("/");
    if (
      path.startsWith("/") ||
      path.includes("\\") ||
      path.includes(":") ||
      !path.toLowerCase().endsWith(".md") ||
      utf8ByteLength(path) > 240 ||
      segments.length > 8 ||
      segments.some((segment) => !segment || segment === "." || segment === "..")
    ) {
      throw new ConfigShareValidationError(`manifest.resources[${index}].path must be a safe relative .md path`);
    }
    const pathKey = unicodeCaseFoldCollisionKey(path);
    if (paths.has(pathKey)) throw new ConfigShareValidationError(`manifest.resources contains duplicate path: ${path}`);
    paths.add(pathKey);
    if (typeof candidate.content !== "string") throw new ConfigShareValidationError(`manifest.resources[${index}].content must be a string`);
    assertExactTextUnicode(candidate.content, `manifest.resources[${index}].content`);
    const contentBytes = utf8ByteLength(candidate.content);
    totalBytes += contentBytes;
    if (contentBytes > MAX_CONFIG_SHARE_RESOURCE_BYTES || totalBytes > MAX_CONFIG_SHARE_RESOURCE_TOTAL_BYTES) {
      throw new ConfigShareValidationError("manifest.resources content exceeds the portable package byte limit");
    }
    if (typeof candidate.digest !== "string" || !DIGEST_RE.test(candidate.digest)) {
      throw new ConfigShareValidationError(`manifest.resources[${index}].digest is invalid`);
    }
    const digest = createHash("sha256").update(candidate.content, "utf8").digest("hex");
    if (digest !== candidate.digest.toLowerCase()) throw new ConfigShareValidationError(`manifest.resources[${index}].digest does not match content`);
    return { path, content: candidate.content, digest };
  });
}

function validateWorkspaceSlots(value: unknown): ConfigShareWorkspaceSlot[] {
  if (!Array.isArray(value) || value.length > MAX_CONFIG_SHARE_WORKSPACE_SLOTS) {
    throw new ConfigShareValidationError(`manifest.workspace_slots max ${MAX_CONFIG_SHARE_WORKSPACE_SLOTS} entries`);
  }
  const names = new Set<string>();
  return value.map((candidate, index) => {
    if (!isPlainObject(candidate) || !hasExactlyKeys(candidate, WORKSPACE_SLOT_KEYS)) {
      throw new ConfigShareValidationError(`manifest.workspace_slots[${index}] has invalid fields`);
    }
    if (typeof candidate.name !== "string" || !WORKSPACE_SLOT_RE.test(candidate.name)) {
      throw new ConfigShareValidationError(`manifest.workspace_slots[${index}].name is invalid`);
    }
    if (names.has(candidate.name)) throw new ConfigShareValidationError(`manifest.workspace_slots contains duplicate name: ${candidate.name}`);
    names.add(candidate.name);
    if (candidate.access !== "read-only" && candidate.access !== "read-write") {
      throw new ConfigShareValidationError(`manifest.workspace_slots[${index}].access is invalid`);
    }
    if (typeof candidate.required !== "boolean") throw new ConfigShareValidationError(`manifest.workspace_slots[${index}].required must be boolean`);
    return { name: candidate.name, access: candidate.access, required: candidate.required };
  });
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (isPlainObject(parsed)) return parsed;
    } catch {
      // Fall through.
    }
  } else if (isPlainObject(value)) {
    return value;
  }
  throw new ConfigShareValidationError("manifest must be a JSON object");
}

export function validateConfigShareManifest(value: unknown): ConfigShareManifest {
  const manifest = parseJsonObject(value);
  if (!hasExactlyKeys(manifest, MANIFEST_KEYS)) {
    throw new ConfigShareValidationError(`manifest must contain exactly: ${MANIFEST_KEYS.join(", ")}`);
  }
  if (manifest.schema_version !== CONFIG_SHARE_MANIFEST_VERSION) {
    throw new ConfigShareValidationError(`manifest.schema_version must be ${CONFIG_SHARE_MANIFEST_VERSION}`);
  }
  if (!isConfigShareKind(manifest.kind)) {
    throw new ConfigShareValidationError("manifest.kind must be expert, group, or skill");
  }
  const artifactId = boundedString(manifest.artifact_id, "manifest.artifact_id", 128, {
    required: true,
    singleLine: true,
  });
  if (!ARTIFACT_ID_RE.test(artifactId)) throw new ConfigShareValidationError("manifest.artifact_id is invalid");
  const title = boundedString(
    manifest.title,
    "manifest.title",
    manifest.kind === "expert"
      ? MAX_CONFIG_SHARE_EXPERT_NAME_CHARS
      : manifest.kind === "skill"
        ? MAX_CONFIG_SHARE_SKILL_NAME_CHARS
        : MAX_CONFIG_SHARE_TITLE_CHARS,
    { required: true, singleLine: true },
  );
  const description = boundedString(manifest.description, "manifest.description", MAX_CONFIG_SHARE_DESCRIPTION_CHARS);
  if (typeof manifest.recommended_permission_mode !== "string" || !PERMISSION_MODES.has(manifest.recommended_permission_mode)) {
    throw new ConfigShareValidationError("manifest.recommended_permission_mode is invalid");
  }
  const payload = manifest.kind === "expert"
    ? validateExpertPayload(manifest.payload, "manifest.payload")
    : manifest.kind === "group"
      ? validateGroupPayload(manifest.payload)
      : validateSkillPayload(manifest.payload);
  if (title !== payload.name) throw new ConfigShareValidationError("manifest.title must match manifest.payload.name");
  if (
    (manifest.kind === "expert" || manifest.kind === "skill") &&
    description !== (payload as ConfigShareExpertPayload | ConfigShareSkillPayload).description
  ) {
    throw new ConfigShareValidationError("manifest.description must match manifest.payload.description");
  }
  const resources = validateResources(manifest.resources);
  const workspaceSlots = validateWorkspaceSlots(manifest.workspace_slots);
  if (manifest.kind === "skill" && (resources.length !== 0 || workspaceSlots.length !== 0)) {
    throw new ConfigShareValidationError("Skill market packages may contain only one SKILL.md file");
  }
  const normalized: ConfigShareManifest = {
    schema_version: CONFIG_SHARE_MANIFEST_VERSION,
    artifact_id: artifactId,
    release_version: semver(manifest.release_version, "manifest.release_version"),
    kind: manifest.kind,
    title,
    description,
    recommended_permission_mode: manifest.recommended_permission_mode as ConfigSharePermissionMode,
    dependencies: validateDependencies(manifest.dependencies),
    resources,
    workspace_slots: workspaceSlots,
    payload,
  };
  if (utf8ByteLength(JSON.stringify(normalized)) > MAX_CONFIG_SHARE_MANIFEST_BYTES) {
    throw new ConfigShareValidationError(`manifest max ${MAX_CONFIG_SHARE_MANIFEST_BYTES} UTF-8 bytes`);
  }
  return normalized;
}

export function parseConfigShareCreateRequest(value: unknown): ConfigShareCreateRequest {
  if (!isPlainObject(value) || !hasExactlyKeys(value, CREATE_REQUEST_KEYS)) {
    throw new ConfigShareValidationError(`request must contain exactly: ${CREATE_REQUEST_KEYS.join(", ")}`);
  }
  if (!isConfigShareKind(value.kind)) {
    throw new ConfigShareValidationError("kind must be expert, group, or skill");
  }
  if (value.manifest_version !== CONFIG_SHARE_MANIFEST_VERSION) {
    throw new ConfigShareValidationError(`manifest_version must be ${CONFIG_SHARE_MANIFEST_VERSION}`);
  }
  const manifest = validateConfigShareManifest(value.manifest);
  if (manifest.kind !== value.kind) throw new ConfigShareValidationError("kind must match manifest.kind");
  return { kind: value.kind, manifest_version: CONFIG_SHARE_MANIFEST_VERSION, manifest };
}

export function isValidConfigShareToken(token: string): boolean {
  return TOKEN_RE.test(token);
}

export function configShareDownloadFileName(title: string, kind: ConfigShareKind): string {
  const safeBase = title
    .normalize("NFKC")
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "shared-config";
  const extension = kind === "expert" ? "agx-expert" : kind === "group" ? "agx-group" : "agx-skill";
  return `${safeBase}.${extension}.json`;
}

export function toPublicConfigShareSnapshot(snapshot: ConfigShareSnapshot) {
  return {
    token: snapshot.token,
    kind: snapshot.kind,
    manifest_version: snapshot.manifestVersion,
    title: snapshot.title,
    description: snapshot.manifest.description,
    owner_display_name: snapshot.ownerDisplayName,
    manifest: snapshot.manifest,
    created_at: snapshot.createdAt,
  };
}
