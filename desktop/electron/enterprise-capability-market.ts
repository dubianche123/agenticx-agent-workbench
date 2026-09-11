import {
  normalizeEnterpriseCapabilitySyncStatuses,
  type EnterpriseCapabilitySyncState,
  type EnterpriseCapabilitySyncStatus,
} from "./enterprise-capability-sync-state";

export type EnterpriseCapabilityLike = {
  id: string;
  kind: "mcp" | "skill";
  name: string;
  displayName?: string;
  version?: string;
  bundleUri?: string;
  bundleDigest?: string;
  endpointUrl?: string;
};

/** Enterprise MCP entries are kept in a namespace separate from user config. */
export const ENTERPRISE_MCP_NAME_PREFIX = "enterprise-";

/**
 * Ledger names are path components, not arbitrary display names.  Keep the
 * bound deliberately conservative so a malformed portal snapshot cannot turn
 * a ledger value into a path traversal or an unexpectedly long component.
 */
export const ENTERPRISE_SKILL_DIRECTORY_NAME_MAX_LENGTH = 128;
const SAFE_ENTERPRISE_SKILL_DIRECTORY_NAME_RE = new RegExp(
  `^[a-z0-9][a-z0-9_-]{0,${ENTERPRISE_SKILL_DIRECTORY_NAME_MAX_LENGTH - 1}}$`,
  "u",
);

export type EnterpriseSkillCoordinate = {
  slug: string;
  namespace: string;
  canonicalName: string;
};

function normalized(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function normalizedCapabilityId(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function safeDerivedSlug(value: unknown, fallback: string): string {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  const fallbackRaw = typeof fallback === "string" ? fallback.trim().toLowerCase() : "";
  const sanitize = (input: string): string => input
    .replace(/[^a-z0-9_-]+/gu, "-")
    // A leading underscore is legal in a lot of config formats but is not a
    // safe standalone ledger component.  Require an alphanumeric first char.
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/gu, "");
  const result = sanitize(raw) || sanitize(fallbackRaw) || "capability";
  return result.slice(0, ENTERPRISE_SKILL_DIRECTORY_NAME_MAX_LENGTH).replace(/[^a-z0-9]+$/u, "") || "capability";
}

/** Derive the exact key used by the MCP config or managed Skill directory. */
export function enterpriseCapabilityDerivedName(
  capability: Pick<EnterpriseCapabilityLike, "id" | "kind" | "name">,
): string {
  const fallback = normalizedCapabilityId(capability.id).replace(/[^a-z0-9_-]+/giu, "-");
  const slug = safeDerivedSlug(capability.name, fallback);
  return capability.kind === "mcp" ? `${ENTERPRISE_MCP_NAME_PREFIX}${slug}` : slug;
}

export function enterpriseMcpEntryName(
  capability: Pick<EnterpriseCapabilityLike, "id" | "kind" | "name">,
): string {
  return enterpriseCapabilityDerivedName({ ...capability, kind: "mcp" });
}

export function enterpriseSkillDirectoryName(
  capability: Pick<EnterpriseCapabilityLike, "id" | "kind" | "name">,
): string {
  return enterpriseCapabilityDerivedName({ ...capability, kind: "skill" });
}

export function isSafeEnterpriseSkillDirectoryName(value: unknown): value is string {
  return typeof value === "string" && SAFE_ENTERPRISE_SKILL_DIRECTORY_NAME_RE.test(value);
}

/** Filter untrusted persisted managed-Skill ledger rows to safe components. */
export function normalizeEnterpriseManagedSkillLedger(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(isSafeEnterpriseSkillDirectoryName))];
}

export type EnterpriseCapabilityNameCollision = {
  kind: "mcp" | "skill";
  /** MCP config key or managed Skill directory name. */
  derivedName: string;
  capabilityIds: string[];
  capabilityNames: string[];
};

function compareCodePoint(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Find capabilities which would address the same local resource after
 * sanitization.  Collisions are reported per kind: an MCP config key and a
 * Skill directory are different namespaces, while two publishers of the same
 * Skill slug are not.
 */
export function findEnterpriseCapabilityNameCollisions(
  capabilities: readonly Pick<EnterpriseCapabilityLike, "id" | "kind" | "name">[] | null | undefined,
): EnterpriseCapabilityNameCollision[] {
  const groups = new Map<string, {
    kind: "mcp" | "skill";
    derivedName: string;
    items: Array<{ id: string; name: string }>;
  }>();
  for (const capability of capabilities ?? []) {
    if (!capability || (capability.kind !== "mcp" && capability.kind !== "skill")) continue;
    const derivedName = enterpriseCapabilityDerivedName(capability);
    const key = `${capability.kind}:${derivedName}`;
    const group = groups.get(key) ?? { kind: capability.kind, derivedName, items: [] };
    const id = normalizedCapabilityId(capability.id);
    // A duplicated row for one capability is a malformed snapshot, but it is
    // not a name collision between two identities and should not hide a real
    // collision involving another capability.
    if (!group.items.some((item) => item.id === id)) {
      group.items.push({ id, name: typeof capability.name === "string" ? capability.name.trim() : "" });
    }
    groups.set(key, group);
  }
  return [...groups.values()]
    .filter((group) => group.items.length > 1)
    .map((group) => ({
      kind: group.kind,
      derivedName: group.derivedName,
      capabilityIds: group.items.map((item) => item.id).sort(compareCodePoint),
      capabilityNames: group.items.map((item) => item.name).sort(compareCodePoint),
    }))
    .sort((left, right) => compareCodePoint(
      `${left.kind}:${left.derivedName}`,
      `${right.kind}:${right.derivedName}`,
    ));
}

/** Short form useful at call sites which only need to gate a sync. */
export function hasEnterpriseCapabilityNameCollisions(
  capabilities: readonly Pick<EnterpriseCapabilityLike, "id" | "kind" | "name">[] | null | undefined,
): boolean {
  return findEnterpriseCapabilityNameCollisions(capabilities).length > 0;
}

// Keep descriptive aliases available to callers while retaining one source of
// truth for the collision semantics.
export const detectEnterpriseCapabilityNameCollisions = findEnterpriseCapabilityNameCollisions;
export const enterpriseCapabilityNameCollisions = findEnterpriseCapabilityNameCollisions;

/** Parse either `slug` or SkillHub's stable `@publisher/slug` coordinate. */
export function enterpriseSkillCoordinate(value: string): EnterpriseSkillCoordinate {
  const raw = String(value ?? "").trim();
  // Coordinates are one optional namespace plus one slug.  Do not silently
  // reinterpret nested paths as a different identity.
  const scoped = raw.match(/^@([^/\s]+)\/([^/\s]+)$/u);
  if (scoped) {
    const namespace = scoped[1].trim().replace(/^@/u, "");
    const slug = scoped[2].trim();
    return {
      slug,
      namespace,
      canonicalName: namespace && slug ? `@${namespace}/${slug}` : slug,
    };
  }
  const slug = raw.replace(/^\/+|\/+$/gu, "");
  return { slug, namespace: "", canonicalName: slug };
}

/**
 * A locked enterprise Desktop may still install a Skill explicitly approved by
 * its current capability list. Scoped approvals only match the same publisher;
 * a bare approval intentionally applies to that bare registry slug.
 */
export function isEnterpriseSkillMarketplaceApproved(
  capabilities: readonly EnterpriseCapabilityLike[] | null | undefined,
  requestedName: string,
  requestedNamespace = "",
): boolean {
  const requested = enterpriseSkillCoordinate(requestedName);
  const namespace = normalized(requestedNamespace || requested.namespace).replace(/^@/u, "");
  const slug = normalized(requested.slug);
  if (!slug) return false;
  const canonical = namespace ? `@${namespace}/${slug}` : "";

  return (capabilities ?? []).some((capability) => {
    if (capability.kind !== "skill") return false;
    const approved = enterpriseSkillCoordinate(capability.name);
    const approvedSlug = normalized(approved.slug);
    const approvedNamespace = normalized(approved.namespace);
    if (!approvedSlug || approvedSlug !== slug) return false;
    if (approvedNamespace) return Boolean(canonical) && `@${approvedNamespace}/${approvedSlug}` === canonical;
    // A bare allowlist entry is only an approval for the bare registry slug.
    // Matching it against `@other/<slug>` would let any publisher take over a
    // centrally approved name.
    return !namespace;
  });
}

/**
 * Return whether a URL host is an IPv4 address and, when it is, its octets.
 * WHATWG URL normalizes integer/hex/short IPv4 spellings before this function
 * sees them, which closes common SSRF representations as well.
 */
function parseIpv4(value: string): [number, number, number, number] | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => Number(part));
  if (octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return octets as [number, number, number, number];
}

function isPrivateOrSpecialIpv4(value: string): boolean {
  const octets = parseIpv4(value);
  if (!octets) return false;
  const [a, b, c] = octets;
  return a === 0 // "this" network / unspecified
    || a === 10
    || a === 100 && b >= 64 && b <= 127 // RFC 6598 shared address space
    || a === 127
    || a === 169 && b === 254 // link-local / cloud metadata range
    || a === 172 && b >= 16 && b <= 31
    || a === 192 && (b === 0 || b === 168)
    || a === 192 && b === 0 && c === 2 // TEST-NET-1
    || a === 198 && (b === 18 || b === 19) // benchmarking
    || a === 198 && b === 51 && c === 100 // TEST-NET-2
    || a === 203 && b === 0 && c === 113 // TEST-NET-3
    || a >= 224; // multicast/reserved
}

function parseIpv6(value: string): number[] | null {
  let raw = value.toLowerCase().replace(/^\[|\]$/gu, "");
  if (!raw || raw.includes("%")) return null;
  const dotted = raw.match(/^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/u);
  if (dotted) {
    const octets = parseIpv4(dotted[2]);
    if (!octets) return null;
    raw = `${dotted[1]}${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const halves = raw.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if ([...left, ...right].some((part) => !/^[0-9a-f]{1,4}$/u.test(part))) return null;
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  const groups = [
    ...left.map((part) => Number.parseInt(part, 16)),
    ...Array(Math.max(0, missing)).fill(0),
    ...right.map((part) => Number.parseInt(part, 16)),
  ];
  return groups.length === 8 ? groups : null;
}

function ipv4FromIpv6(groups: readonly number[]): string | null {
  // IPv4-mapped and IPv4-compatible addresses carry the IPv4 in the last
  // 32 bits.  The latter is deprecated but still worth classifying safely.
  const mapped = groups.slice(0, 5).every((part) => part === 0) && groups[5] === 0xffff;
  const compatible = groups.slice(0, 6).every((part) => part === 0);
  if (!mapped && !compatible) return null;
  return [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff].join(".");
}

function normalizedHost(hostname: string): string {
  const host = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  // DNS absolute names may carry a terminal dot; it must not bypass `.local`
  // or `localhost` checks.
  return host.includes(":") ? host : host.replace(/\.+$/u, "");
}

function isLoopbackHost(host: string): boolean {
  if (host === "localhost") return true;
  const ipv4 = parseIpv4(host);
  if (ipv4 && ipv4[0] === 127) return true;
  const groups = parseIpv6(host);
  if (!groups) return false;
  if (groups.slice(0, 7).every((part) => part === 0) && groups[7] === 1) return true;
  const mapped = ipv4FromIpv6(groups);
  return mapped !== null && parseIpv4(mapped)?.[0] === 127;
}

function isPrivateOrSpecialHost(host: string): boolean {
  if (host === "localhost" || host === "local" || host.endsWith(".localhost") || host.endsWith(".local")) {
    return true;
  }
  if (isLoopbackHost(host)) return true;
  const ipv4 = parseIpv4(host);
  if (ipv4) return isPrivateOrSpecialIpv4(host);
  const groups = parseIpv6(host);
  if (!groups) return false;
  if (groups.every((part) => part === 0)) {
    return true;
  }
  const first = groups[0];
  if ((first & 0xfe00) === 0xfc00 // RFC 4193 unique local
    || (first & 0xffc0) === 0xfe80 // link-local
    || (first & 0xff00) === 0xff00) { // multicast
    return true;
  }
  const mapped = ipv4FromIpv6(groups);
  return mapped !== null && isPrivateOrSpecialIpv4(mapped);
}

/**
 * Managed Skill bundles must use an authenticated public HTTPS endpoint.
 * Loopback HTTP remains available for the repository's local fixture only.
 * Credentials and fragments are always rejected: credentials are not part of
 * the Desktop auth contract, and a fragment is never sent to the server.
 */
export function isAcceptableEnterpriseSkillBundleUri(uri: string): boolean {
  const raw = String(uri ?? "").trim();
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (!raw || raw.includes("#") || parsed.username || parsed.password) return false;
  const host = normalizedHost(parsed.hostname);
  const privateOrSpecial = !host || isPrivateOrSpecialHost(host);
  if (parsed.protocol === "https:") return !privateOrSpecial;
  // Local development may use plain HTTP, but only for an actual loopback
  // host (not `attacker.localhost` or a private LAN address).
  return parsed.protocol === "http:" && isLoopbackHost(host);
}

export function hasManagedSkillDelivery(capability: EnterpriseCapabilityLike): boolean {
  return capability.kind === "skill" && Boolean(String(capability.bundleUri ?? "").trim());
}

/** Whether the declared managed-delivery metadata is safe and verifiable. */
export function hasValidManagedSkillDelivery(capability: EnterpriseCapabilityLike): boolean {
  if (!hasManagedSkillDelivery(capability)) return false;
  const bundleUri = String(capability.bundleUri ?? "").trim();
  const bundleDigest = String(capability.bundleDigest ?? "").trim();
  return Boolean(
    /^[a-f0-9]{64}$/iu.test(bundleDigest)
    && isAcceptableEnterpriseSkillBundleUri(bundleUri),
  );
}

export function filterEnterpriseCapabilities(
  capabilities: readonly EnterpriseCapabilityLike[] | null | undefined,
  kind: "mcp" | "skill",
  query = "",
): EnterpriseCapabilityLike[] {
  const needle = normalized(query);
  return (capabilities ?? []).filter((capability) => {
    if (capability.kind !== kind) return false;
    if (!needle) return true;
    return [capability.name, capability.displayName, capability.version]
      .map(normalized)
      .some((value) => value.includes(needle));
  });
}

export type EnterpriseMcpMarketplaceItem = {
  id: string;
  name: string;
  chinese_name: string;
  description: string;
  is_verified: true;
  is_hosted: true;
  enterprise_managed: true;
  /** Endpoint presence only means the capability can be delivered; it is not an applied receipt. */
  endpoint_ready: boolean;
  /** Local sync receipt state, when the account snapshot includes one. */
  sync_status?: EnterpriseCapabilitySyncState;
  sync_error_code?: string;
  sync_message?: string;
};

export function findEnterpriseCapabilitySyncStatus(
  statuses: readonly EnterpriseCapabilitySyncStatus[] | null | undefined,
  capabilityId: string,
  kind?: "mcp" | "skill",
): EnterpriseCapabilitySyncStatus | undefined {
  const id = String(capabilityId ?? "").trim();
  if (!id) return undefined;
  return normalizeEnterpriseCapabilitySyncStatuses(statuses).find(
    (status) => status.capabilityId === id && (!kind || status.kind === kind),
  );
}

type EnterpriseCapabilitySyncFailureInput = Pick<
  EnterpriseCapabilitySyncStatus,
  "errorCode" | "message"
>;

/**
 * Map only stable error signals to user-facing copy. The raw portal/transport
 * message can contain URLs, local paths, or response bodies, so it is never
 * rendered directly in the settings UI.
 */
export function enterpriseCapabilitySyncFailureReason(
  status: EnterpriseCapabilitySyncFailureInput | null | undefined,
): string {
  const errorCode = String(status?.errorCode ?? "").trim().toLowerCase().replace(/[ -]+/gu, "_");
  const exactReasons: Record<string, string> = {
    missing_bundle: "管理员尚未提供技能包。",
    insecure_uri: "技能包地址不安全，未应用此版本。",
    missing_digest: "SHA 摘要缺失，未应用此版本。",
    invalid_digest: "SHA 摘要无效，未应用此版本。",
    download_failed: "资源地址不可达，请检查网络后重试。",
    load_failed: "技能内容读取失败，请重试。",
    size_exceeded: "包体积超过限制，请联系管理员。",
    digest_mismatch: "SHA 校验不匹配，未应用此版本。",
    write_failed: "写入本机失败，请检查权限或磁盘空间。",
    remove_failed: "移除本机旧版本失败，请重试。",
    mcp_config_read_failed: "读取本机 MCP 配置失败，请检查权限后重试。",
    mcp_config_write_failed: "写入本机 MCP 配置失败，请检查权限或磁盘空间。",
    mcp_config_remove_failed: "移除本机 MCP 配置失败，请重试。",
    mcp_conflict: "本机已有同名 MCP 配置，未覆盖。",
    mcp_endpoint_unavailable: "企业网关地址不可用，请联系管理员。",
    index_refresh_failed: "技能索引校验失败，已保留上次可用版本。",
    skill_not_loaded: "技能文件已下载，但本机索引未能加载该技能，已保留上次可用版本。",
  };
  if (exactReasons[errorCode]) return exactReasons[errorCode];

  // Compatibility for older clients that supplied only a short message.
  const signal = `${errorCode} ${String(status?.message ?? "")}`.toLowerCase();
  if (
    /(sha|digest|checksum|hash).*(mismatch|不匹配|invalid|invalidated)/u.test(signal)
    || /(mismatch|不匹配).*(sha|digest|checksum|hash)/u.test(signal)
  ) {
    return "SHA 校验不匹配，未应用此版本。";
  }
  if (
    /(too[_ -]?large|oversize|size[_ -]?limit|package[_ -]?limit|包.*过大|体积.*限制)/u.test(signal)
  ) {
    return "包体积超过限制，请联系管理员。";
  }
  if (
    /(write[_ -]?(failed|error)|persist[_ -]?(failed|error)|permission[_ -]?denied|disk[_ -]?(full|error)|写入.*失败|磁盘空间)/u.test(signal)
  ) {
    return "写入本机失败，请检查权限或磁盘空间。";
  }
  if (
    /(url|uri|endpoint|address|resource|bundle|fetch|network|connect|连接|地址|网络).*(unreach|unavailable|timeout|refused|failed|error|不可达|超时|失败)/u.test(signal)
    || /(unreach|unavailable|timeout|refused|不可达|超时).*(url|uri|endpoint|address|resource|bundle|网络)/u.test(signal)
  ) {
    return "资源地址不可达，请检查网络后重试。";
  }
  return "原因未明，请重试或联系管理员。";
}

export function enterpriseCapabilitySyncStatusLabel(
  status: EnterpriseCapabilitySyncState | null | undefined,
): string {
  switch (status) {
    case "waiting":
      return "等待应用";
    case "downloading":
      return "下载中";
    case "verifying":
      return "校验中";
    case "applied":
      return "已应用";
    case "failed":
      return "同步失败";
    default:
      return "状态待刷新";
  }
}

export function enterpriseMcpMarketplaceItems(
  capabilities: readonly EnterpriseCapabilityLike[] | null | undefined,
  query = "",
  syncStatuses: readonly EnterpriseCapabilitySyncStatus[] | null | undefined = undefined,
): EnterpriseMcpMarketplaceItem[] {
  const statuses = normalizeEnterpriseCapabilitySyncStatuses(syncStatuses);
  const statusById = new Map(
    statuses
      .filter((status) => status.kind === "mcp")
      .map((status) => [status.capabilityId, status] as const),
  );
  return filterEnterpriseCapabilities(capabilities, "mcp", query).map((capability) => {
    const status = statusById.get(capability.id);
    return {
      id: capability.id,
      name: capability.name,
      chinese_name: capability.displayName || capability.name,
      description: "由企业管理员通过能力包分配，本机根据同步回执展示状态。",
      is_verified: true,
      is_hosted: true,
      enterprise_managed: true,
      endpoint_ready: Boolean(String(capability.endpointUrl ?? "").trim()),
      ...(status
        ? {
            sync_status: status.status,
            ...(status.errorCode ? { sync_error_code: status.errorCode } : {}),
            ...(status.message ? { sync_message: status.message } : {}),
          }
        : {}),
    };
  });
}
