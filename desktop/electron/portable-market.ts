import { createHash } from "node:crypto";
import yaml from "js-yaml";

export const PORTABLE_MARKET_PACKAGE_MAX_BYTES = 256 * 1024;
export const PORTABLE_MARKET_PAGE_SIZE = 50;
export const PORTABLE_PACKAGE_SCHEMA_VERSION = 2 as const;
const PORTABLE_PACKAGE_SCANNER_VERSION = "1";

export type PortableMarketKind = "expert" | "group" | "skill";
export type PortableMarketVisibilityType = "company" | "departments" | "users" | "personal" | "admins_only";

export type PortableMarketVisibility = {
  type: PortableMarketVisibilityType;
  departmentIds: string[];
  userIds: string[];
};

export type PortableMarketAudienceDepartment = {
  id: string;
  name: string;
  path: string;
};

export type PortableMarketAudienceUser = {
  id: string;
  displayName: string;
  email: string;
  deptId: string | null;
};

export type PortableMarketItem = {
  id: string;
  capabilityId: string;
  sourceArtifactId: string;
  manifestVersion: typeof PORTABLE_PACKAGE_SCHEMA_VERSION;
  releaseId: string;
  version: string;
  kind: PortableMarketKind;
  title: string;
  description: string;
  ownerDisplayName: string;
  visibility: PortableMarketVisibilityType;
  visibleDepartmentCount: number;
  visibleUserCount: number;
  /** Server-authoritative successful manual install/import count. */
  downloadCount: number;
  status: "published" | "unlisted";
  /** Unlisting controls discovery; revocation independently stops pack delivery. */
  deliveryState?: "active" | "revoked";
  digest: string;
  releaseNotes: string;
  releasePublishedAt: string;
  publishedAt: string;
  createdAt: string;
  updatedAt: string;
};

export type PortableMarketListRequest = {
  kind: PortableMarketKind;
  query?: string;
  limit?: number;
  cursor?: string;
};

export type PortableMarketListResult = {
  ok: boolean;
  items: PortableMarketItem[];
  nextCursor?: string | null;
  error?: string;
};

export type ManagedPortablePackage = {
  id: string;
  kind: PortableMarketKind;
  title: string;
  digest: string;
  raw: string;
};

export type PortablePackageStudioExportRequest = {
  kind: PortableMarketKind;
  id: string;
  /** Only the market publisher may request a package before the final server scan. */
  allow_scan_findings?: boolean;
  release_version?: string;
  recommended_permission_mode?: "plan" | "ask" | "auto";
  dependencies?: {
    skills: Array<{
      capability_id: string;
      version: string;
      digest: string;
      required: boolean;
    }>;
    mcps: Array<{
      capability_id: string;
      version: string;
      required: boolean;
    }>;
  };
  resource_files?: Array<"IDENTITY.md" | "SOUL.md" | "MEMORY.md">;
  workspace_slots?: Array<{
    name: string;
    access: "read-only" | "read-write";
    required: boolean;
  }>;
};

/** Server findings intentionally carry rule/location metadata, never matched values. */
export type PortableMarketSecurityFinding = {
  code: string;
  field: string;
  category: "secret" | "pii";
  line?: number;
  column?: number;
  severity?: string;
};

/** Findings from the local scanner that must be fixed manually.  These are
 * deliberately not accepted as authoritative Portal findings. */
export const PORTABLE_MARKET_MANUAL_ONLY_CODES = new Set([
  "unclassified_secret",
  "unclassified_pii",
]);

type PortablePackageResource = { path: string; content: string; digest?: string };

export type PortablePackagePublication = {
  kind: PortableMarketKind;
  manifest_version: typeof PORTABLE_PACKAGE_SCHEMA_VERSION;
  manifest: Record<string, unknown>;
};

export type ManagedPortableReconcilePayload = {
  packages: Array<Pick<ManagedPortablePackage, "id" | "digest" | "raw">>;
};

const MARKET_ROW_ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/u;
const MARKET_CURSOR_RE = /^[A-Za-z0-9_-]{1,512}$/u;
const CAPABILITY_ID_RE = /^(expert|group|skill):([0-9A-HJKMNP-TV-Z]{26})$/u;
const DEPENDENCY_CAPABILITY_ID_RE = /^(skill|mcp):([0-9A-HJKMNP-TV-Z]{26})$/iu;
const SHA256_RE = /^[a-f0-9]{64}$/u;
const ARTIFACT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;
const SEMVER_RE = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const WORKSPACE_SLOT_RE = /^[a-z][a-z0-9_-]{0,63}$/u;
const SECURITY_FINDING_FIELD_RE = /^(?:release_notes|manifest(?:\.[A-Za-z0-9_]+|\[\d+\])*)$/u;
const SECURITY_FINDING_CODES = new Set([
  "private_key",
  "openai_key",
  "anthropic_key",
  "github_token",
  "stripe_key",
  "slack_token",
  "slack_webhook",
  "gcp_service_account",
  "azure_connection_string",
  "aws_access_key",
  "google_api_key",
  "jwt",
  "bearer_token",
  "basic_auth",
  "assigned_secret",
  "credential_url",
  "email",
  "cn_phone",
  "cn_identity",
  "bank_card",
]);
const PRIVATE_KEY_RE = /-----BEGIN\s+(?:RSA\s+|EC\s+|OPENSSH\s+|DSA\s+)?PRIVATE\s+KEY-----[\s\S]*?(?:-----END\s+(?:RSA\s+|EC\s+|OPENSSH\s+|DSA\s+)?PRIVATE\s+KEY-----|$)/giu;
// Treat `_` as a separator.  Python's package scanner historically matched
// these values without a word boundary, so a strict `\b` here would report a
// finding that the sanitizer and Portal could both miss (for example
// `_sk-proj-...`).  Alphanumeric characters remain excluded as a prefix to
// avoid matching inside ordinary words.
const OPENAI_KEY_RE = /(?<![A-Za-z0-9])sk-(?:proj-)?[A-Za-z0-9_-]{20,}/gu;
const ANTHROPIC_KEY_RE = /(?<![A-Za-z0-9])sk-ant-api\d{2}-[A-Za-z0-9-]{20,}/gu;
const GITHUB_TOKEN_RE = /(?<![A-Za-z0-9])(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}/gu;
const STRIPE_KEY_RE = /(?<![A-Za-z0-9])sk_(?:live|test)_[A-Za-z0-9]{24,}/gu;
const SLACK_TOKEN_RE = /(?<![A-Za-z0-9])xox[baprs]-[A-Za-z0-9-]{10,}/gu;
const SLACK_WEBHOOK_RE = /https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]+/gu;
const GCP_SERVICE_ACCOUNT_RE = /"type"\s*:\s*"service_account"/gu;
const AZURE_CONNECTION_STRING_RE = /DefaultEndpointsProtocol=https;AccountName=[^;]+;AccountKey=[A-Za-z0-9+/=]{20,}/gu;
const BASIC_AUTH_RE = /(?<![A-Za-z0-9])Basic\s+[A-Za-z0-9+/]+=*/gu;
const AWS_ACCESS_KEY_RE = /(?<![A-Za-z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}/gu;
const GOOGLE_API_KEY_RE = /(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{30,}/gu;
const JWT_RE = /(?<![A-Za-z0-9])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/gu;
const BEARER_TOKEN_RE = /(?<![A-Za-z0-9])Bearer\s+[A-Za-z0-9._~+\/-]{16,}={0,2}/giu;
const ASSIGNED_SECRET_RE = /(?<prefix>(?<![A-Za-z0-9])(?:api[_ -]?key|apikey|api[_ -]?secret|access[_ -]?token|client[_ -]?secret|password|passwd|pwd|aws[_-]?secret[_-]?access[_-]?key|secret[_-]?access[_-]?key)\s*[:=]\s*["']?)[^\s"']{8,}/giu;
const CREDENTIAL_URL_RE = /(?<prefix>\b[a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/giu;
const EMAIL_RE = /(?<![A-Za-z0-9._%+-])[A-Z0-9.!#$%&'*+\/?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+(?![A-Z0-9.-])/giu;
// Keep the country-code form in the match so automatic redaction removes
// `86`/`+86` as well as the local number.  This is the same boundary contract
// as the Python scanner and Portal scanner.
const CN_PHONE_RE = /(?<!\d)(?:\+?86[ -]?)?1[3-9]\d{9}(?!\d)/gu;
const CN_ID_RE = /\d{17}[\dXx]/gu;
const CARD_RE = /(?<![A-Za-z0-9_])(?:\d[ -]?){13,19}(?![A-Za-z0-9_])/gu;
const PORTABLE_ENVELOPE_KEYS = [
  "schema_version",
  "artifact_id",
  "release_version",
  "kind",
  "title",
  "description",
  "recommended_permission_mode",
  "dependencies",
  "resources",
  "workspace_slots",
  "payload",
] as const;
const EXPERT_PAYLOAD_KEYS = [
  "name",
  "role",
  "description",
  "tags",
  "system_prompt",
  "color",
  "default_permission_mode",
] as const;
const GROUP_PAYLOAD_KEYS = ["name", "members", "host_member_index", "routing"] as const;
const SKILL_PAYLOAD_KEYS = ["name", "description", "skill_md"] as const;
const PERMISSION_MODES = new Set(["plan", "ask", "auto"]);
const ROUTING_MODES = new Set([
  "intelligent",
  "user-directed",
  "meta-routed",
  "round-robin",
  "team",
]);
const BIDI_CONTROL_CODEPOINTS = new Set([
  0x061c,
  0x200e,
  0x200f,
  0x202a,
  0x202b,
  0x202c,
  0x202d,
  0x202e,
  0x2066,
  0x2067,
  0x2068,
  0x2069,
]);

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function hasOwn(row: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(row, key);
}

function hasExactKeys(
  row: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(row);
  return actual.length === keys.length && keys.every((key) => hasOwn(row, key));
}

function canonicalSemver(value: unknown): string | null {
  const version = text(value);
  return version.length <= 64 && SEMVER_RE.test(version) ? version : null;
}

function canonicalDependencyId(value: unknown, expectedKind: "skill" | "mcp"): string | null {
  const matched = DEPENDENCY_CAPABILITY_ID_RE.exec(text(value));
  if (!matched || matched[1].toLocaleLowerCase() !== expectedKind) return null;
  return `${expectedKind}:${matched[2].toUpperCase()}`;
}

function normalizePortableDependencies(
  value: unknown,
): PortablePackageStudioExportRequest["dependencies"] | null {
  const row = record(value);
  if (!row || !hasExactKeys(row, ["skills", "mcps"])) return null;
  if (!Array.isArray(row.skills) || !Array.isArray(row.mcps)) return null;
  if (row.skills.length > 32 || row.mcps.length > 32) return null;

  const skills: NonNullable<PortablePackageStudioExportRequest["dependencies"]>["skills"] = [];
  const skillIds = new Set<string>();
  for (const candidate of row.skills) {
    const item = record(candidate);
    if (!item || !hasExactKeys(item, ["capability_id", "version", "digest", "required"])) {
      return null;
    }
    const capabilityId = canonicalDependencyId(item.capability_id, "skill");
    const version = canonicalSemver(item.version);
    const digest = text(item.digest).toLocaleLowerCase();
    if (
      !capabilityId
      || !version
      || !SHA256_RE.test(digest)
      || typeof item.required !== "boolean"
      || skillIds.has(capabilityId)
    ) {
      return null;
    }
    skillIds.add(capabilityId);
    skills.push({ capability_id: capabilityId, version, digest, required: item.required });
  }

  const mcps: NonNullable<PortablePackageStudioExportRequest["dependencies"]>["mcps"] = [];
  const mcpIds = new Set<string>();
  for (const candidate of row.mcps) {
    const item = record(candidate);
    if (!item || !hasExactKeys(item, ["capability_id", "version", "required"])) return null;
    const capabilityId = canonicalDependencyId(item.capability_id, "mcp");
    const version = canonicalSemver(item.version);
    if (
      !capabilityId
      || !version
      || typeof item.required !== "boolean"
      || mcpIds.has(capabilityId)
    ) {
      return null;
    }
    mcpIds.add(capabilityId);
    mcps.push({ capability_id: capabilityId, version, required: item.required });
  }
  return { skills, mcps };
}

function hasUnsafeUnicode(value: string): boolean {
  for (const char of value) {
    const codepoint = char.codePointAt(0) ?? 0;
    if (
      (codepoint >= 0xd800 && codepoint <= 0xdfff)
      || (codepoint < 0x20 && char !== "\n" && char !== "\r" && char !== "\t")
      || (codepoint >= 0x7f && codepoint <= 0x9f)
      || BIDI_CONTROL_CODEPOINTS.has(codepoint)
    ) {
      return true;
    }
  }
  return false;
}

export function normalizePortableMarketReleaseNotes(value: unknown): string | null {
  if (value === undefined) return "";
  if (typeof value !== "string") return null;
  const releaseNotes = value.trim();
  if (releaseNotes.length > 4_000 || hasUnsafeUnicode(releaseNotes)) return null;
  return releaseNotes;
}

function normalizePortableResources(
  value: unknown,
  requireDigest: boolean,
): PortablePackageResource[] | null {
  if (!Array.isArray(value) || value.length > 24) return null;
  const resources: PortablePackageResource[] = [];
  const paths = new Set<string>();
  let totalBytes = 0;
  for (const candidate of value) {
    const item = record(candidate);
    if (!item || !hasOwn(item, "path") || !hasOwn(item, "content")) return null;
    const actualKeys = Object.keys(item);
    if (
      actualKeys.some((key) => key !== "path" && key !== "content" && key !== "digest")
      || (requireDigest && !hasOwn(item, "digest"))
    ) {
      return null;
    }
    if (typeof item.path !== "string" || typeof item.content !== "string") return null;
    const resourcePath = item.path.normalize("NFC");
    const pathBytes = Buffer.byteLength(resourcePath, "utf8");
    const parts = resourcePath.split("/");
    if (
      !resourcePath
      || (requireDigest && resourcePath !== item.path)
      || resourcePath.startsWith("/")
      || resourcePath.includes("\\")
      || !resourcePath.toLocaleLowerCase().endsWith(".md")
      || pathBytes > 240
      || hasUnsafeUnicode(resourcePath)
      || parts.some((part) => !part || part === "." || part === "..")
      || paths.has(resourcePath)
    ) {
      return null;
    }
    const contentBytes = Buffer.byteLength(item.content, "utf8");
    totalBytes += contentBytes;
    if (contentBytes > 64 * 1024 || totalBytes > 192 * 1024 || hasUnsafeUnicode(item.content)) {
      return null;
    }
    const actualDigest = createHash("sha256").update(item.content, "utf8").digest("hex");
    const suppliedDigest = hasOwn(item, "digest") ? text(item.digest).toLocaleLowerCase() : "";
    if (suppliedDigest && (!SHA256_RE.test(suppliedDigest) || suppliedDigest !== actualDigest)) {
      return null;
    }
    if (requireDigest && suppliedDigest !== actualDigest) return null;
    paths.add(resourcePath);
    resources.push({
      path: resourcePath,
      content: item.content,
      ...(suppliedDigest ? { digest: suppliedDigest } : {}),
    });
  }
  return resources;
}

function normalizePortableResourceFiles(
  value: unknown,
): NonNullable<PortablePackageStudioExportRequest["resource_files"]> | null {
  if (!Array.isArray(value) || value.length > 3) return null;
  const allowed = new Set(["IDENTITY.md", "SOUL.md", "MEMORY.md"]);
  const files: NonNullable<PortablePackageStudioExportRequest["resource_files"]> = [];
  for (const candidate of value) {
    if (typeof candidate !== "string" || !allowed.has(candidate)) {
      return null;
    }
    const file = candidate as NonNullable<PortablePackageStudioExportRequest["resource_files"]>[number];
    if (files.includes(file)) return null;
    files.push(file);
  }
  return files;
}

function normalizePortableWorkspaceSlots(
  value: unknown,
): PortablePackageStudioExportRequest["workspace_slots"] | null {
  if (!Array.isArray(value) || value.length > 8) return null;
  const slots: NonNullable<PortablePackageStudioExportRequest["workspace_slots"]> = [];
  const names = new Set<string>();
  for (const candidate of value) {
    const item = record(candidate);
    if (!item || !hasExactKeys(item, ["name", "access", "required"])) return null;
    const name = text(item.name);
    if (
      !WORKSPACE_SLOT_RE.test(name)
      || (item.access !== "read-only" && item.access !== "read-write")
      || typeof item.required !== "boolean"
      || names.has(name)
    ) {
      return null;
    }
    names.add(name);
    slots.push({ name, access: item.access, required: item.required });
  }
  return slots;
}

function isStrictExpertPayload(value: unknown): boolean {
  const payload = record(value);
  if (!payload || !hasExactKeys(payload, EXPERT_PAYLOAD_KEYS)) return false;
  return typeof payload.name === "string"
    && Boolean(payload.name.trim())
    && typeof payload.role === "string"
    && typeof payload.description === "string"
    && Array.isArray(payload.tags)
    && payload.tags.length <= 8
    && payload.tags.every((tag) => typeof tag === "string")
    && typeof payload.system_prompt === "string"
    && (payload.color === "blue" || payload.color === "white" || payload.color === "black")
    && typeof payload.default_permission_mode === "string"
    && PERMISSION_MODES.has(payload.default_permission_mode);
}

function isStrictGroupPayload(value: unknown): boolean {
  const payload = record(value);
  if (!payload || !hasExactKeys(payload, GROUP_PAYLOAD_KEYS)) return false;
  if (
    typeof payload.name !== "string"
    || !payload.name.trim()
    || !Array.isArray(payload.members)
    || payload.members.length < 1
    || payload.members.length > 12
    || !payload.members.every(isStrictExpertPayload)
    || !Number.isInteger(payload.host_member_index)
    || typeof payload.host_member_index !== "number"
    || payload.host_member_index < 0
    || payload.host_member_index >= payload.members.length
    || typeof payload.routing !== "string"
    || !ROUTING_MODES.has(payload.routing)
  ) {
    return false;
  }
  return true;
}

/**
 * Skills are deliberately transported as one validated SKILL.md only.  The
 * markdown is still content (not a security policy); this check merely keeps
 * the loader-facing identity and front matter consistent at the renderer/main
 * boundary.  Secret/PII scanning remains a separate review step.
 */
function isStrictSkillPayload(value: unknown): boolean {
  const payload = record(value);
  if (!payload || !hasExactKeys(payload, SKILL_PAYLOAD_KEYS)) return false;
  const name = text(payload.name);
  const description = text(payload.description);
  const skillMd = typeof payload.skill_md === "string" ? payload.skill_md : "";
  if (
    !/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(name)
    || !description
    || !skillMd.trim()
    || Buffer.byteLength(skillMd, "utf8") > 128 * 1024
    || hasUnsafeUnicode(name)
    || hasUnsafeUnicode(description)
    || hasUnsafeUnicode(skillMd)
  ) return false;
  const lines = skillMd.split(/\r?\n/u);
  if (lines[0]?.trim() !== "---") return false;
  const closingIndex = lines.slice(1).findIndex((line) => line.trim() === "---");
  if (closingIndex < 0) return false;
  const frontMatter = lines.slice(1, closingIndex + 1).join("\n");
  try {
    const metadata = yaml.load(frontMatter, { schema: yaml.FAILSAFE_SCHEMA });
    const metadataRecord = record(metadata);
    const declaredName = text(metadataRecord?.name);
    const declaredDescription = text(metadataRecord?.description);
    return declaredName === name && Boolean(declaredDescription);
  } catch {
    return false;
  }
}

export function normalizePortablePackageStudioExportRequest(
  value: unknown,
): PortablePackageStudioExportRequest | null {
  const row = record(value);
  if (!row || !isPortableMarketKind(row.kind)) return null;
  const id = text(row.id);
  if (!id) return null;
  const result: PortablePackageStudioExportRequest = { kind: row.kind, id };

  if (hasOwn(row, "release_version")) {
    const releaseVersion = canonicalSemver(row.release_version);
    if (!releaseVersion) return null;
    result.release_version = releaseVersion;
  }
  if (hasOwn(row, "allow_scan_findings")) {
    if (typeof row.allow_scan_findings !== "boolean") return null;
    result.allow_scan_findings = row.allow_scan_findings;
  }
  if (hasOwn(row, "recommended_permission_mode")) {
    if (typeof row.recommended_permission_mode !== "string"
      || !PERMISSION_MODES.has(row.recommended_permission_mode)) return null;
    result.recommended_permission_mode = row.recommended_permission_mode as "plan" | "ask" | "auto";
  }
  if (hasOwn(row, "dependencies")) {
    const dependencies = normalizePortableDependencies(row.dependencies);
    if (!dependencies) return null;
    result.dependencies = dependencies;
  }
  if (hasOwn(row, "resources")) return null;
  if (hasOwn(row, "resource_files")) {
    const resourceFiles = normalizePortableResourceFiles(row.resource_files);
    if (!resourceFiles) return null;
    result.resource_files = resourceFiles;
  }
  if (hasOwn(row, "workspace_slots")) {
    const workspaceSlots = normalizePortableWorkspaceSlots(row.workspace_slots);
    if (!workspaceSlots) return null;
    result.workspace_slots = workspaceSlots;
  }
  return result;
}

export function normalizePortableMarketSecurityFindings(
  value: unknown,
  options: { allowManualOnly?: boolean } = {},
): PortableMarketSecurityFinding[] | null {
  if (!Array.isArray(value) || value.length > 128) return null;
  const findings: PortableMarketSecurityFinding[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    const item = record(candidate);
    if (!item || typeof item.code !== "string" || typeof item.field !== "string") return null;
    const code = item.code.trim();
    const field = item.field.trim();
    const codeAllowed = SECURITY_FINDING_CODES.has(code)
      || (options.allowManualOnly && PORTABLE_MARKET_MANUAL_ONLY_CODES.has(code));
    if (
      !codeAllowed
      || !SECURITY_FINDING_FIELD_RE.test(field)
      || (field.startsWith("manifest.") && !securityFindingPath(field))
      || (item.category !== "secret" && item.category !== "pii")
    ) {
      return null;
    }
    const key = `${item.category}:${code}:${field}`;
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push({
      code,
      field,
      category: item.category,
      ...(Number.isSafeInteger(item.line) && Number(item.line) > 0 ? { line: Number(item.line) } : {}),
      ...(Number.isSafeInteger(item.column) && Number(item.column) > 0 ? { column: Number(item.column) } : {}),
      ...(typeof item.severity === "string" && item.severity.trim()
        ? { severity: item.severity.trim().slice(0, 32) }
        : {}),
    });
  }
  return findings;
}

function normalizePortablePackageScanField(value: string): string | null {
  if (value === "release_notes" || value.startsWith("manifest.")) return value;
  if (value.startsWith("package.")) return `manifest.${value.slice("package.".length)}`;
  if (value.startsWith("payload")) return `manifest.${value}`;
  if (value.startsWith("resources")) return `manifest.${value}`;
  if (value.startsWith("dependencies")) return `manifest.${value}`;
  return null;
}

function normalizePortablePackageRuleCode(value: string): string | null {
  const raw = value.trim().toLocaleLowerCase();
  if (SECURITY_FINDING_CODES.has(raw)) return raw;
  const suffix = raw.includes(".") ? raw.slice(raw.lastIndexOf(".") + 1) : raw;
  const mapped: Record<string, string> = {
    private_key_pem: "private_key",
    ssh_private_key: "private_key",
    openai_api_key: "openai_key",
    openai_api_key_extended: "openai_key",
    anthropic_api_key: "anthropic_key",
    github_fine_grained: "github_token",
    github_token_extended: "github_token",
    stripe_key: "stripe_key",
    slack_token: "slack_token",
    slack_webhook: "slack_webhook",
    gcp_service_account: "gcp_service_account",
    azure_connection_string: "azure_connection_string",
    aws_access_key_extended: "aws_access_key",
    aws_secret_access_key: "assigned_secret",
    authorization_basic: "basic_auth",
    generic_api_key_param: "assigned_secret",
    password_param: "assigned_secret",
    credential_assignment_case_insensitive: "assigned_secret",
    bearer_token_case_insensitive: "bearer_token",
    payment_card: "bank_card",
    cn_identity_number: "cn_identity",
    cn_phone: "cn_phone",
    email: "email",
  };
  return mapped[suffix] ?? null;
}

/** Adapt the local Studio report to the same safe shape returned by Portal. */
export function normalizePortablePackageScanFindings(value: unknown): PortableMarketSecurityFinding[] {
  const row = record(value);
  if (!row || !Array.isArray(row.findings)) return [];
  const findings: PortableMarketSecurityFinding[] = [];
  const seen = new Set<string>();
  for (const candidate of row.findings) {
    const item = record(candidate);
    if (!item || typeof item.field !== "string") continue;
    const category = item.category === "secret" || item.category === "pii" ? item.category : null;
    if (!category) continue;
    const code = normalizePortablePackageRuleCode(
      typeof item.code === "string" ? item.code : String(item.rule_id ?? ""),
    );
    // File export treats a bare high-entropy hash as a review hint, but the
    // company market intentionally preflights the same PII that Portal would
    // reject.  Keep recognized email/phone findings even when the generic
    // package scanner marks them non-blocking; skip only unmapped review hints.
    if (item.blocking === false && !code) continue;
    const field = normalizePortablePackageScanField(item.field);
    const normalizedCode = code
      ?? (category === "secret" ? "unclassified_secret" : "unclassified_pii");
    if (!field) continue;
    const key = `${category}:${normalizedCode}:${field}`;
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push({
      code: normalizedCode,
      field,
      category,
      ...(Number.isSafeInteger(item.line) && Number(item.line) > 0 ? { line: Number(item.line) } : {}),
      ...(Number.isSafeInteger(item.column) && Number(item.column) > 0 ? { column: Number(item.column) } : {}),
      ...(typeof item.severity === "string" && item.severity.trim()
        ? { severity: item.severity.trim().slice(0, 32) }
        : {}),
    });
  }
  return findings;
}

/**
 * A market preflight is fail-closed when Studio does not return the complete
 * report contract.  `normalizePortablePackageScanFindings` intentionally
 * remains tolerant for display-only callers, so the publish path must call
 * this stricter validator before treating an empty report as clean.
 */
export function isPortablePackageScanReport(value: unknown): boolean {
  const row = record(value);
  if (
    !row
    || !hasExactKeys(row, ["scanner_version", "has_findings", "should_block", "findings"])
    || row.scanner_version !== PORTABLE_PACKAGE_SCANNER_VERSION
    || typeof row.has_findings !== "boolean"
    || typeof row.should_block !== "boolean"
    || !Array.isArray(row.findings)
    || row.findings.length > 128
  ) {
    return false;
  }
  let shouldBlock = false;
  for (const candidate of row.findings) {
    const finding = record(candidate);
    if (
      !finding
      || !hasExactKeys(finding, [
        "rule_id",
        "category",
        "severity",
        "blocking",
        "field",
        "line",
        "column",
      ])
      || typeof finding.rule_id !== "string"
      || !finding.rule_id.trim()
      || finding.rule_id.length > 160
      || (finding.category !== "secret" && finding.category !== "pii")
      || typeof finding.severity !== "string"
      || !finding.severity.trim()
      || typeof finding.blocking !== "boolean"
      || typeof finding.field !== "string"
      || !finding.field.trim()
      || finding.field.length > 512
      || !normalizePortablePackageScanField(finding.field)
      || (finding.field.startsWith("manifest.") && !securityFindingPath(finding.field))
      || !Number.isSafeInteger(finding.line)
      || Number(finding.line) < 1
      || !Number.isSafeInteger(finding.column)
      || Number(finding.column) < 1
    ) {
      return false;
    }
    shouldBlock ||= finding.blocking;
  }
  return row.has_findings === (row.findings.length > 0)
    && row.should_block === shouldBlock;
}

export function mergePortableMarketSecurityFindings(
  ...sources: readonly PortableMarketSecurityFinding[][]
): PortableMarketSecurityFinding[] {
  const findings: PortableMarketSecurityFinding[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    for (const finding of source) {
      const key = `${finding.category}:${finding.code}:${finding.field}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push(finding);
      if (findings.length >= 128) return findings;
    }
  }
  return findings;
}

function luhn(value: string): boolean {
  const digits = value.replace(/\D/g, "");
  if (digits.length < 13 || digits.length > 19 || /^(\d)\1+$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

function validCnId(value: string): boolean {
  if (!/^\d{17}[\dXx]$/u.test(value)) return false;
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const checks = ["1", "0", "X", "9", "8", "7", "6", "5", "4", "3", "2"];
  const sum = weights.reduce((total, weight, index) => total + Number(value[index]) * weight, 0);
  return checks[sum % 11] === value[17]!.toUpperCase();
}

function firstMatchOffset(pattern: RegExp, value: string): number | null {
  pattern.lastIndex = 0;
  const match = pattern.exec(value);
  pattern.lastIndex = 0;
  return match ? match.index : null;
}

function lineColumn(value: string, offset: number): Pick<PortableMarketSecurityFinding, "line" | "column"> {
  const line = value.slice(0, offset).split("\n").length;
  const lastNewline = value.lastIndexOf("\n", offset - 1);
  return { line, column: offset - lastNewline };
}

/**
 * Scan text locally using the same rule vocabulary as the authoritative
 * market scanner.  Only rule/location metadata leaves this process; the
 * matched source value is never returned to the renderer or Portal.
 */
export function scanPortableMarketText(
  value: string,
  field: string,
): PortableMarketSecurityFinding[] {
  if (!value || !field) return [];
  const findings: PortableMarketSecurityFinding[] = [];
  const seen = new Set<string>();
  const add = (code: string, category: PortableMarketSecurityFinding["category"], offset: number) => {
    const key = `${category}:${code}:${field}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({ code, field, category, ...lineColumn(value, offset) });
  };
  const secretRules: Array<[string, RegExp]> = [
    ["private_key", PRIVATE_KEY_RE],
    ["openai_key", OPENAI_KEY_RE],
    ["anthropic_key", ANTHROPIC_KEY_RE],
    ["github_token", GITHUB_TOKEN_RE],
    ["stripe_key", STRIPE_KEY_RE],
    ["slack_token", SLACK_TOKEN_RE],
    ["slack_webhook", SLACK_WEBHOOK_RE],
    ["gcp_service_account", GCP_SERVICE_ACCOUNT_RE],
    ["azure_connection_string", AZURE_CONNECTION_STRING_RE],
    ["basic_auth", BASIC_AUTH_RE],
    ["aws_access_key", AWS_ACCESS_KEY_RE],
    ["google_api_key", GOOGLE_API_KEY_RE],
    ["jwt", JWT_RE],
    ["bearer_token", BEARER_TOKEN_RE],
    ["assigned_secret", ASSIGNED_SECRET_RE],
    ["credential_url", CREDENTIAL_URL_RE],
  ];
  for (const [code, pattern] of secretRules) {
    const offset = firstMatchOffset(pattern, value);
    if (offset !== null) add(code, "secret", offset);
  }
  const emailOffset = firstMatchOffset(EMAIL_RE, value);
  if (emailOffset !== null) add("email", "pii", emailOffset);
  const phoneOffset = firstMatchOffset(CN_PHONE_RE, value);
  if (phoneOffset !== null) add("cn_phone", "pii", phoneOffset);
  CN_ID_RE.lastIndex = 0;
  let identityMatch: RegExpExecArray | null;
  while ((identityMatch = CN_ID_RE.exec(value)) !== null) {
    if (validCnId(identityMatch[0])) {
      add("cn_identity", "pii", identityMatch.index);
      break;
    }
  }
  CN_ID_RE.lastIndex = 0;
  CARD_RE.lastIndex = 0;
  let cardMatch: RegExpExecArray | null;
  while ((cardMatch = CARD_RE.exec(value)) !== null) {
    if (luhn(cardMatch[0])) {
      add("bank_card", "pii", cardMatch.index);
      break;
    }
  }
  CARD_RE.lastIndex = 0;
  return findings;
}

/** Re-scan every uploader-controlled manifest string after local redaction. */
export function scanPortableMarketManifest(value: unknown): PortableMarketSecurityFinding[] {
  const manifest = record(value);
  if (!manifest) return [];
  const findings: PortableMarketSecurityFinding[][] = [];
  const collect = (candidate: unknown, field: string): void => {
    if (typeof candidate === "string") {
      findings.push(scanPortableMarketText(candidate, field));
      return;
    }
    if (Array.isArray(candidate)) {
      candidate.forEach((item, index) => collect(item, `${field}[${index}]`));
      return;
    }
    if (candidate && typeof candidate === "object") {
      for (const [key, item] of Object.entries(candidate as Record<string, unknown>)) {
        collect(item, `${field}.${key}`);
      }
    }
  };
  for (const [key, candidate] of Object.entries(manifest)) {
    collect(candidate, `manifest.${key}`);
  }
  return mergePortableMarketSecurityFindings(...findings);
}

function redaction(code: string): string {
  return `[内容已移除:${code}]`;
}

function redactText(
  value: string,
  codes: readonly string[],
  options: { semverSafe?: boolean } = {},
): { value: string; changed: boolean } {
  const semverSafe = options.semverSafe ?? false;
  let result = value;
  const replacement = (code: string) => semverSafe ? "redacted" : redaction(code);
  for (const code of codes) {
    switch (code) {
      case "private_key":
        result = result.replace(PRIVATE_KEY_RE, replacement(code));
        break;
      case "openai_key":
        result = result.replace(OPENAI_KEY_RE, replacement(code));
        break;
      case "anthropic_key":
        result = result.replace(ANTHROPIC_KEY_RE, replacement(code));
        break;
      case "github_token":
        result = result.replace(GITHUB_TOKEN_RE, replacement(code));
        break;
      case "stripe_key":
        result = result.replace(STRIPE_KEY_RE, replacement(code));
        break;
      case "slack_token":
        result = result.replace(SLACK_TOKEN_RE, replacement(code));
        break;
      case "slack_webhook":
        result = result.replace(SLACK_WEBHOOK_RE, replacement(code));
        break;
      case "gcp_service_account":
        result = result.replace(GCP_SERVICE_ACCOUNT_RE, replacement(code));
        break;
      case "azure_connection_string":
        result = result.replace(AZURE_CONNECTION_STRING_RE, replacement(code));
        break;
      case "aws_access_key":
        result = result.replace(AWS_ACCESS_KEY_RE, replacement(code));
        break;
      case "google_api_key":
        result = result.replace(GOOGLE_API_KEY_RE, replacement(code));
        break;
      case "jwt":
        result = result.replace(JWT_RE, replacement(code));
        break;
      case "bearer_token":
        result = result.replace(BEARER_TOKEN_RE, (match) => (
          semverSafe ? "redacted" : redaction(code)
        ));
        break;
      case "basic_auth":
        result = result.replace(BASIC_AUTH_RE, replacement(code));
        break;
      case "assigned_secret":
        result = result.replace(ASSIGNED_SECRET_RE, (_match, prefix: string) => (
          // Keep the assignment label but use a short marker.  The scanner
          // intentionally requires secret values to be at least eight
          // characters, so a long explanatory marker would immediately
          // trigger the same rule during the mandatory post-redaction scan.
          `${prefix}***`
        ));
        break;
      case "credential_url":
        // A credential URL cannot retain the `user:password@` shape with a
        // redacted password: any non-empty password would still be a finding.
        // Remove the complete credential-bearing URL while leaving the field
        // and surrounding text intact.
        result = result.replace(CREDENTIAL_URL_RE, replacement(code));
        break;
      case "email":
        result = result.replace(EMAIL_RE, replacement(code));
        break;
      case "cn_phone":
        result = result.replace(CN_PHONE_RE, replacement(code));
        break;
      case "cn_identity":
        result = result.replace(CN_ID_RE, replacement(code));
        break;
      case "bank_card":
        result = result.replace(CARD_RE, (match) => luhn(match) ? replacement(code) : match);
        break;
      default:
        break;
    }
  }
  return { value: result, changed: result !== value };
}

function securityFindingPath(field: string): Array<string | number> | null {
  if (!field.startsWith("manifest.")) return null;
  const path = field.slice("manifest.".length);
  const normalized = path.replace(/\[(\d+)\]/gu, ".$1");
  const pieces = normalized.split(".");
  if (
    pieces.length === 0
    || pieces.some((piece) => (
      !piece
      || !/^[A-Za-z0-9_]+$/u.test(piece)
      || piece === "__proto__"
      || piece === "prototype"
      || piece === "constructor"
    ))
  ) {
    return null;
  }
  return pieces.map((piece) => /^\d+$/u.test(piece) ? Number(piece) : piece);
}

function redactManifestField(
  manifest: Record<string, unknown>,
  field: string,
  codes: readonly string[],
): boolean {
  const path = securityFindingPath(field);
  if (!path) return false;
  let current: unknown = manifest;
  for (const segment of path.slice(0, -1)) {
    if (typeof segment === "number") {
      if (!Array.isArray(current) || !current[segment]) return false;
      current = current[segment];
    } else {
      if (
        !current
        || typeof current !== "object"
        || !Object.prototype.hasOwnProperty.call(current, segment)
      ) return false;
      current = (current as Record<string, unknown>)[segment];
    }
  }
  const last = path[path.length - 1]!;
  if (typeof last === "number") {
    if (!Array.isArray(current) || typeof current[last] !== "string") return false;
    const redacted = redactText(current[last] as string, codes);
    if (!redacted.changed) return false;
    current[last] = redacted.value;
    return true;
  }
  if (!current || typeof current !== "object") return false;
  const value = (current as Record<string, unknown>)[last];
  if (typeof value !== "string") return false;
  const semverSafe = field === "manifest.release_version" || /\.version$/u.test(field);
  const redacted = redactText(value, codes, { semverSafe });
  if (!redacted.changed) return false;
  (current as Record<string, unknown>)[last] = redacted.value;
  return true;
}

/**
 * Redact only the server-reported fields/rules.  This is deliberately kept in
 * the main process and returns a new manifest; the renderer never receives the
 * raw package or the matched values.  Resource digests are always recomputed.
 */
export function sanitizePortablePackageManifest(
  value: unknown,
  findings: readonly PortableMarketSecurityFinding[],
): Record<string, unknown> | null {
  const manifest = record(value);
  if (
    !manifest
    || findings.length === 0
    || findings.some((finding) => PORTABLE_MARKET_MANUAL_ONLY_CODES.has(finding.code))
  ) return null;
  const clone = JSON.parse(JSON.stringify(manifest)) as Record<string, unknown>;
  const byField = new Map<string, string[]>();
  for (const finding of findings) {
    if (finding.field === "release_notes") continue;
    const codes = byField.get(finding.field) ?? [];
    if (!codes.includes(finding.code)) codes.push(finding.code);
    byField.set(finding.field, codes);
  }
  for (const [field, codes] of byField) {
    // Artifact/dependency/resource identifiers are part of the package's
    // addressability and digest contract.  Replacing a secret-looking value
    // there would silently point at a different artifact or file, so require
    // the publisher to fix those fields manually.
    if (
      field === "manifest.artifact_id"
      || field.endsWith(".capability_id")
      || field.endsWith(".path")
    ) {
      return null;
    }
    if (!redactManifestField(clone, field, codes)) return null;
  }
  const resources = clone.resources;
  if (Array.isArray(resources)) {
    for (const resource of resources) {
      if (!record(resource) || typeof resource.content !== "string") continue;
      resource.digest = createHash("sha256").update(resource.content, "utf8").digest("hex");
    }
  }
  return clone;
}

export function sanitizePortableMarketReleaseNotes(
  value: string,
  findings: readonly PortableMarketSecurityFinding[],
): string | null {
  const codes = findings
    .filter((finding) => finding.field === "release_notes")
    .map((finding) => finding.code);
  if (codes.length === 0) return value;
  const redacted = redactText(value, [...new Set(codes)]);
  return redacted.changed ? redacted.value : null;
}

export function normalizePortablePackagePublication(
  value: unknown,
  expectedKind: PortableMarketKind,
): PortablePackagePublication | null {
  const envelope = record(value);
  if (!envelope || !hasExactKeys(envelope, PORTABLE_ENVELOPE_KEYS)) return null;
  if (
    envelope.schema_version !== PORTABLE_PACKAGE_SCHEMA_VERSION
    || envelope.kind !== expectedKind
    || !ARTIFACT_ID_RE.test(text(envelope.artifact_id))
    || !canonicalSemver(envelope.release_version)
    || typeof envelope.title !== "string"
    || !envelope.title.trim()
    || typeof envelope.description !== "string"
    || typeof envelope.recommended_permission_mode !== "string"
    || !PERMISSION_MODES.has(envelope.recommended_permission_mode)
    || !normalizePortableDependencies(envelope.dependencies)
    || !normalizePortableResources(envelope.resources, true)
    || !normalizePortableWorkspaceSlots(envelope.workspace_slots)
  ) {
    return null;
  }
  const payload = record(envelope.payload);
  if (!payload) return null;
  if (expectedKind === "expert") {
    if (
      !isStrictExpertPayload(payload)
      || envelope.title !== payload.name
      || envelope.description !== payload.description
    ) {
      return null;
    }
  } else if (expectedKind === "group") {
    if (!isStrictGroupPayload(payload) || envelope.title !== payload.name) return null;
  } else if (
    !isStrictSkillPayload(payload)
    || envelope.title !== payload.name
    || envelope.description !== payload.description
    || (envelope.resources as unknown[]).length !== 0
    || (envelope.workspace_slots as unknown[]).length !== 0
  ) {
    return null;
  }
  return {
    kind: expectedKind,
    manifest_version: envelope.schema_version,
    manifest: envelope,
  };
}

export function isPortableMarketKind(value: unknown): value is PortableMarketKind {
  return value === "expert" || value === "group" || value === "skill";
}

/** Cursor is opaque to Desktop, but still bounded before it crosses the PAT bridge. */
export function normalizePortableMarketCursor(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") return null;
  const cursor = value.trim();
  return MARKET_CURSOR_RE.test(cursor) ? cursor : null;
}

export function isPortableMarketVisibilityType(
  value: unknown,
): value is PortableMarketVisibilityType {
  return value === "company"
    || value === "departments"
    || value === "users"
    || value === "personal"
    || value === "admins_only";
}

function marketAudienceIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > 64) return null;
  const ids: string[] = [];
  for (const raw of value) {
    const id = text(raw).toUpperCase();
    if (!MARKET_ROW_ID_RE.test(id)) return null;
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** Validate untrusted renderer input before it is sent with the enterprise PAT. */
export function normalizePortableMarketVisibility(value: unknown): PortableMarketVisibility | null {
  const row = record(value);
  if (!row || !isPortableMarketVisibilityType(row.type)) return null;
  const departmentIds = marketAudienceIds(row.departmentIds);
  const userIds = marketAudienceIds(row.userIds);
  if (!departmentIds || !userIds) return null;
  if (row.type === "personal") {
    return departmentIds.length === 0 && userIds.length === 0
      ? { type: "personal", departmentIds: [], userIds: [] }
      : null;
  }
  if (row.type === "company") {
    return departmentIds.length === 0 && userIds.length === 0
      ? { type: "company", departmentIds: [], userIds: [] }
      : null;
  }
  if (row.type === "admins_only") {
    return departmentIds.length === 0 && userIds.length === 0
      ? { type: "admins_only", departmentIds: [], userIds: [] }
      : null;
  }
  if (row.type === "departments") {
    return departmentIds.length > 0 && userIds.length === 0
      ? { type: "departments", departmentIds, userIds: [] }
      : null;
  }
  return userIds.length > 0 && departmentIds.length === 0
    ? { type: "users", departmentIds: [], userIds }
    : null;
}

function nonNegativeCount(value: unknown): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= 64 ? parsed : 0;
}

function nonNegativeDownloadCount(value: unknown): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

export function normalizePortableMarketItem(value: unknown): PortableMarketItem | null {
  const row = record(value);
  if (!row) return null;
  const id = text(row.id).toUpperCase();
  const kind = row.kind;
  const title = text(row.title);
  const status = text(row.status);
  const deliveryState = row.deliveryState === undefined
    ? "active"
    : text(row.deliveryState);
  const visibility = row.visibility;
  const sourceArtifactId = text(row.source_artifact_id ?? row.sourceArtifactId);
  const manifestVersion = row.manifest_version ?? row.manifestVersion;
  const releaseId = text(row.release_id ?? row.releaseId).toUpperCase();
  const version = canonicalSemver(row.version);
  const digest = text(row.digest).toLocaleLowerCase();
  const releaseNotes = normalizePortableMarketReleaseNotes(
    row.release_notes ?? row.releaseNotes ?? "",
  );
  if (
    !MARKET_ROW_ID_RE.test(id)
    || !isPortableMarketKind(kind)
    || !title
    || (status !== "published" && status !== "unlisted")
    || (deliveryState !== "active" && deliveryState !== "revoked")
    || !isPortableMarketVisibilityType(visibility)
    || !ARTIFACT_ID_RE.test(sourceArtifactId)
    || manifestVersion !== PORTABLE_PACKAGE_SCHEMA_VERSION
    || !MARKET_ROW_ID_RE.test(releaseId)
    || !version
    || !SHA256_RE.test(digest)
    || releaseNotes === null
  ) {
    return null;
  }
  const capabilityId = text(row.capabilityId);
  const parsedCapability = CAPABILITY_ID_RE.exec(capabilityId);
  if (!parsedCapability || parsedCapability[1] !== kind || parsedCapability[2] !== id) {
    return null;
  }
  return {
    id,
    capabilityId,
    sourceArtifactId,
    manifestVersion: PORTABLE_PACKAGE_SCHEMA_VERSION,
    releaseId,
    version,
    kind,
    title,
    description: text(row.description),
    ownerDisplayName: text(row.ownerDisplayName),
    visibility,
    visibleDepartmentCount: visibility === "departments"
      ? nonNegativeCount(row.visibleDepartmentCount)
      : 0,
    visibleUserCount: visibility === "users" ? nonNegativeCount(row.visibleUserCount) : 0,
    downloadCount: nonNegativeDownloadCount(row.downloadCount ?? row.download_count),
    status,
    deliveryState: deliveryState as "active" | "revoked",
    digest,
    releaseNotes,
    releasePublishedAt: text(row.release_published_at ?? row.releasePublishedAt),
    publishedAt: text(row.publishedAt),
    createdAt: text(row.createdAt),
    updatedAt: text(row.updatedAt),
  };
}

/**
 * A voluntary market installation may only be replaced by a later release of
 * the same market item.  The marker and metadata are both required because a
 * same-name directory can otherwise be left behind by an interrupted or
 * manually copied install.
 */
export function portableMarketInstallItemIdentityMatches(
  metadata: unknown,
  marker: unknown,
  item: Pick<PortableMarketItem, "id">,
): boolean {
  const row = record(metadata);
  const itemId = text(item.id).toUpperCase();
  return Boolean(
    row
    && itemId
    && text(row.item_id).toUpperCase() === itemId
    && text(marker).toUpperCase() === itemId,
  );
}

export function normalizePortableMarketAudienceDepartments(
  value: unknown,
): PortableMarketAudienceDepartment[] {
  if (!Array.isArray(value)) return [];
  const rows: PortableMarketAudienceDepartment[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    const item = record(candidate);
    if (!item) continue;
    const id = text(item.id).toUpperCase();
    const name = text(item.name);
    if (!MARKET_ROW_ID_RE.test(id) || !name || seen.has(id)) continue;
    seen.add(id);
    rows.push({ id, name, path: text(item.path) || name });
  }
  return rows;
}

export function normalizePortableMarketAudienceUsers(
  value: unknown,
): PortableMarketAudienceUser[] {
  if (!Array.isArray(value)) return [];
  const rows: PortableMarketAudienceUser[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    const item = record(candidate);
    if (!item) continue;
    const id = text(item.id).toUpperCase();
    const displayName = text(item.displayName);
    const email = text(item.email);
    const rawDeptId = text(item.deptId).toUpperCase();
    if (!MARKET_ROW_ID_RE.test(id) || !displayName || !email || seen.has(id)) continue;
    if (rawDeptId && !MARKET_ROW_ID_RE.test(rawDeptId)) continue;
    seen.add(id);
    rows.push({ id, displayName, email, deptId: rawDeptId || null });
  }
  return rows;
}

export function normalizePortableMarketItems(
  value: unknown,
  expectedKind?: PortableMarketKind,
): PortableMarketItem[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const items: PortableMarketItem[] = [];
  for (const candidate of value) {
    const item = normalizePortableMarketItem(candidate);
    if (!item || (expectedKind && item.kind !== expectedKind) || seen.has(item.id)) continue;
    seen.add(item.id);
    items.push(item);
  }
  return items;
}

export function normalizeManagedPortablePackages(value: unknown): ManagedPortablePackage[] {
  if (!Array.isArray(value)) return [];
  const packages: ManagedPortablePackage[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    const row = record(candidate);
    if (!row) continue;
    const id = text(row.id);
    const match = CAPABILITY_ID_RE.exec(id);
    const kind = row.kind;
    const digest = text(row.digest).toLowerCase();
    const raw = typeof row.raw === "string" ? row.raw : "";
    if (
      !match
      || !isPortableMarketKind(kind)
      || match[1] !== kind
      || !SHA256_RE.test(digest)
      || !raw
      || Buffer.byteLength(raw, "utf8") > PORTABLE_MARKET_PACKAGE_MAX_BYTES
      || seen.has(id)
    ) {
      continue;
    }
    const actualDigest = createHash("sha256").update(raw, "utf8").digest("hex");
    if (actualDigest !== digest) continue;
    let envelope: Record<string, unknown> | null = null;
    try {
      envelope = record(JSON.parse(raw));
    } catch {
      continue;
    }
    if (!envelope || !normalizePortablePackagePublication(envelope, kind)) continue;
    seen.add(id);
    packages.push({
      id,
      kind,
      title: text(row.title) || text(envelope.title),
      digest,
      raw,
    });
  }
  return packages;
}

export function normalizeManagedPortableReconcilePayload(
  value: unknown,
): ManagedPortableReconcilePayload | null {
  if (!Array.isArray(value)) return null;
  const packages = normalizeManagedPortablePackages(value);
  if (packages.length !== value.length) return null;
  return {
    packages: packages.map(({ id, digest, raw }) => ({ id, digest, raw })),
  };
}
