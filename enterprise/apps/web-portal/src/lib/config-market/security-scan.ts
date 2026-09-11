import type { ConfigShareManifest } from "../config-share-types";

export type ConfigMarketSecurityFinding = {
  code: string;
  field: string;
  category: "secret" | "pii";
};

export class ConfigMarketSecurityScanError extends Error {
  public readonly findings: ConfigMarketSecurityFinding[];

  public constructor(findings: ConfigMarketSecurityFinding[]) {
    super("package contains secrets or personal information; remove or exclude the flagged fields");
    this.name = "ConfigMarketSecurityScanError";
    this.findings = findings;
  }
}

const SECRET_PATTERNS: Array<{ code: string; pattern: RegExp }> = [
  { code: "private_key", pattern: /-----BEGIN\s+(?:RSA\s+|EC\s+|OPENSSH\s+|DSA\s+)?PRIVATE\s+KEY-----/i },
  { code: "openai_key", pattern: /(?<![A-Za-z0-9])sk-(?:proj-)?[A-Za-z0-9_-]{20,}/ },
  { code: "anthropic_key", pattern: /(?<![A-Za-z0-9])sk-ant-api\d{2}-[A-Za-z0-9-]{20,}/ },
  { code: "github_token", pattern: /(?<![A-Za-z0-9])(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}/ },
  { code: "stripe_key", pattern: /(?<![A-Za-z0-9])sk_(?:live|test)_[A-Za-z0-9]{24,}/ },
  { code: "slack_token", pattern: /(?<![A-Za-z0-9])xox[baprs]-[A-Za-z0-9-]{10,}/ },
  { code: "slack_webhook", pattern: /https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]+/ },
  { code: "gcp_service_account", pattern: /"type"\s*:\s*"service_account"/ },
  { code: "azure_connection_string", pattern: /DefaultEndpointsProtocol=https;AccountName=[^;]+;AccountKey=[A-Za-z0-9+/=]{20,}/ },
  { code: "aws_access_key", pattern: /(?<![A-Za-z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}/ },
  { code: "google_api_key", pattern: /(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{30,}/ },
  { code: "jwt", pattern: /(?<![A-Za-z0-9])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
  { code: "bearer_token", pattern: /(?<![A-Za-z0-9])Bearer\s+[A-Za-z0-9._~+\/-]{16,}={0,2}/i },
  { code: "basic_auth", pattern: /(?<![A-Za-z0-9])Basic\s+[A-Za-z0-9+/]+=*/ },
  {
    code: "assigned_secret",
    pattern: /(?<![A-Za-z0-9])(?:api[_ -]?key|apikey|api[_ -]?secret|access[_ -]?token|client[_ -]?secret|password|passwd|pwd|aws[_-]?secret[_-]?access[_-]?key|secret[_-]?access[_-]?key)\s*[:=]\s*["']?[^\s"']{8,}/i,
  },
  { code: "credential_url", pattern: /(?<![A-Za-z0-9])[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i },
];

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
  if (!/^\d{17}[\dXx]$/.test(value)) return false;
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const checks = ["1", "0", "X", "9", "8", "7", "6", "5", "4", "3", "2"];
  const sum = weights.reduce((total, weight, index) => total + Number(value[index]) * weight, 0);
  return checks[sum % 11] === value[17]!.toUpperCase();
}

function scanString(value: string, field: string): ConfigMarketSecurityFinding[] {
  const findings: ConfigMarketSecurityFinding[] = [];
  for (const rule of SECRET_PATTERNS) {
    if (rule.pattern.test(value)) findings.push({ code: rule.code, field, category: "secret" });
  }
  if (/(?<![A-Za-z0-9._%+-])[A-Z0-9.!#$%&'*+\/?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+(?![A-Z0-9.-])/i.test(value)) {
    findings.push({ code: "email", field, category: "pii" });
  }
  if (/(?<!\d)(?:\+?86[ -]?)?1[3-9]\d{9}(?!\d)/.test(value)) {
    findings.push({ code: "cn_phone", field, category: "pii" });
  }
  const cnIds = value.match(/\d{17}[\dXx]/g) ?? [];
  if (cnIds.some(validCnId)) {
    findings.push({ code: "cn_identity", field, category: "pii" });
  }
  const cardCandidates = value.match(/(?:^|\D)(?:\d[ -]?){13,19}(?:\D|$)/g) ?? [];
  if (cardCandidates.some(luhn)) findings.push({ code: "bank_card", field, category: "pii" });
  return findings;
}

function collectPayloadStrings(value: unknown, field: string, output: Array<[string, string]>): void {
  if (typeof value === "string") {
    output.push([field, value]);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectPayloadStrings(item, `${field}[${index}]`, output));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      collectPayloadStrings(item, `${field}.${key}`, output);
    }
  }
}

/** Authoritative server-side scan over every uploader-controlled executable/context string. */
export function scanConfigMarketManifest(manifest: ConfigShareManifest): ConfigMarketSecurityFinding[] {
  const strings: Array<[string, string]> = [
    ["manifest.artifact_id", manifest.artifact_id],
    ["manifest.release_version", manifest.release_version],
    ["manifest.title", manifest.title],
    ["manifest.description", manifest.description],
  ];
  collectPayloadStrings(manifest.payload, "manifest.payload", strings);
  manifest.dependencies.skills.forEach((dependency, index) => {
    strings.push([`manifest.dependencies.skills[${index}].capability_id`, dependency.capability_id]);
    strings.push([`manifest.dependencies.skills[${index}].version`, dependency.version]);
  });
  manifest.dependencies.mcps.forEach((dependency, index) => {
    strings.push([`manifest.dependencies.mcps[${index}].capability_id`, dependency.capability_id]);
    strings.push([`manifest.dependencies.mcps[${index}].version`, dependency.version]);
  });
  manifest.resources.forEach((resource, index) => {
    strings.push([`manifest.resources[${index}].path`, resource.path]);
    strings.push([`manifest.resources[${index}].content`, resource.content]);
  });
  const unique = new Map<string, ConfigMarketSecurityFinding>();
  for (const [field, value] of strings) {
    for (const finding of scanString(value, field)) {
      unique.set(`${finding.category}:${finding.code}:${finding.field}`, finding);
      if (unique.size >= 128) return [...unique.values()];
    }
  }
  return [...unique.values()];
}

export function assertConfigMarketManifestSafe(manifest: ConfigShareManifest): void {
  const findings = scanConfigMarketManifest(manifest);
  if (findings.length > 0) throw new ConfigMarketSecurityScanError(findings);
}

export function scanConfigMarketText(value: string, field: string): ConfigMarketSecurityFinding[] {
  return scanString(value, field);
}

export function assertConfigMarketTextSafe(value: string, field: string): void {
  const findings = scanConfigMarketText(value, field);
  if (findings.length > 0) throw new ConfigMarketSecurityScanError(findings);
}
