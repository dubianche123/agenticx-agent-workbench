/**
 * 能力 id 的唯一构造与解析入口：运行能力与 portable 专家/群聊都使用稳定前缀 + ULID。
 *
 * 用不可变的 ULID 而不是 name/slug，因为后者是管理员起的可变标签：改一次名，
 * 分配记录、用户关闭偏好、用量与审计就会全部指空，用量归属错乱对按能力计费
 * 尤其致命。前缀用来判断该去哪张能力或企业广场表查。
 *
 * 各处手拼字符串迟早会拼出 `mcp:` 与 `mcp/` 两种写法，所以只留这一个入口。
 */

export const CAPABILITY_KINDS = ["mcp", "skill", "feature", "expert", "group", "action"] as const;
export type CapabilityKind = (typeof CAPABILITY_KINDS)[number];

/**
 * The enterprise assistant is a platform entry point rather than a row in
 * the portable market.  Keeping the id in the same capability namespace lets
 * an administrator grant/revoke the entry with the same pack controls as a
 * registered action, while the special parser case below prevents it from
 * being mistaken for a market release.
 */
export const ENTERPRISE_ASSISTANT_CAPABILITY_ID = "expert:enterprise_assistant" as const;

/** Registry-backed enterprise actions that can be placed in a capability pack. */
export const ENTERPRISE_ACTION_CAPABILITIES = [
  { id: "action:self.profile.read", displayName: "查看我的资料", description: "查看当前登录企业成员的资料。" },
  { id: "action:self.quota.read", displayName: "查看我的额度", description: "查看当前成员的日、周、月额度和共享额度状态。" },
  { id: "action:member.search", displayName: "搜索企业成员", description: "按公开身份字段搜索当前企业成员，并按授权范围过滤。" },
  { id: "action:member.quota.read", displayName: "查看成员额度", description: "查看指定成员的当前额度和用量窗口。" },
  { id: "action:member.models.read", displayName: "查看成员模型权限", description: "查看指定成员明确分配、继承和排除后的可用模型。" },
  { id: "action:gateway.health.read", displayName: "查看网关状态", description: "查看企业网关的受限健康探测结果。" },
  { id: "action:usage.summary.read", displayName: "查看用量摘要", description: "查看当前成员的用量摘要。" },
  { id: "action:usage.analytics.read", displayName: "分析企业用量", description: "在当前授权数据范围内按用户、部门或模型聚合用量并返回 Top N。" },
  { id: "action:audit.events.read", displayName: "查看审计记录", description: "查看近期企业审计记录，敏感字段会被隐藏。" },
  { id: "action:enterprise.overview.read", displayName: "查看企业概览", description: "查看企业成员、服务商、网关和用量汇总。" },
  { id: "action:member.quota.set", displayName: "调整成员额度", description: "准备并确认一名成员的额度调整。" },
  { id: "action:member.models.set", displayName: "调整成员模型权限", description: "准备并确认一名成员的可用模型权限调整。" },
] as const;

export type EnterpriseActionCapability = (typeof ENTERPRISE_ACTION_CAPABILITIES)[number];

const KNOWN_ENTERPRISE_ACTION_IDS = new Set<string>(
  ENTERPRISE_ACTION_CAPABILITIES.map((item) => item.id),
);

export function actionCapabilityId(actionId: string): string {
  const normalized = String(actionId ?? "").trim().toLowerCase();
  if (!/^[a-z][a-z0-9]*(?:\.[a-z0-9]+)+$/.test(normalized)) {
    throw new Error(`invalid enterprise action id: ${actionId}`);
  }
  return `action:${normalized}`;
}

export function isKnownEnterpriseActionCapabilityId(value: unknown): value is string {
  return typeof value === "string" && KNOWN_ENTERPRISE_ACTION_IDS.has(value.trim().toLowerCase());
}

export function isBuiltinExpertCapabilityId(value: unknown): value is typeof ENTERPRISE_ASSISTANT_CAPABILITY_ID {
  return value === ENTERPRISE_ASSISTANT_CAPABILITY_ID;
}

/** Desktop 当前一次 desired-state 对账可安全接收的受管专家/群聊总数。 */
export const MAX_MANAGED_PORTABLE_PACKAGES = 64;

/**
 * 平台功能不是租户建的行，没有 ULID，用固定标识。
 *
 * 上面那条「必须用 ULID」的理由是「name 是管理员起的可变标签，改名会让分配记录指空」。
 * 这些标识由平台定义，管理员改不了，也不会有第二个租户的同名冲突——所以那条理由在这里
 * 不成立，硬塞一个 ULID 反而要为两个常量建表。
 *
 * 之所以让它们成为能力而不是另一套开关：「谁能用联网搜索」和「谁能用某个 MCP」是同一个
 * 问题。分成两套授权系统的结果是两处分配 UI、两张表、两套判定，而管理员想的只是
 * 「这个人能用什么」。
 */
export const PLATFORM_FEATURES = [
  "web_search",
  "deep_research",
  "attachment_routing",
  "attachment_public_override",
] as const;
export type PlatformFeature = (typeof PLATFORM_FEATURES)[number];

/**
 * 能力生效在哪个客户端。
 *
 * 同一个人在 web portal 和 Desktop 上能用的东西并不一样：附件自动路由要锁 Desktop
 * 的模型选择器，而 portal 的会话模型是另一套；某些 Skill 依赖本机文件系统，下发到
 * portal 只会是一个点不动的条目。以前不分是因为只有 Skill/MCP，两边行为恰好一致。
 *
 * 平台功能的 surface 写死在代码里：它们由平台定义，管理员改不了——和
 * PLATFORM_FEATURES 用固定标识而不是 ULID 是同一条理由。租户自己建的 Skill/MCP 行
 * 暂时视为两端通用（见 capability-packs-reader 的 DEFAULT_CAPABILITY_SURFACES），
 * 等真的出现单端 Skill 时再加列。
 */
export const CAPABILITY_SURFACES = ["web", "desktop"] as const;
export type CapabilitySurface = (typeof CAPABILITY_SURFACES)[number];

const PLATFORM_FEATURE_SURFACES: Record<PlatformFeature, readonly CapabilitySurface[]> = {
  web_search: ["web", "desktop"],
  deep_research: ["web", "desktop"],
  // 路由要锁住会话模型并把选择器灰掉，两端都要做，但表现形式各自实现。
  attachment_routing: ["web", "desktop"],
  // 只决定命中文档后能否选择公网模型；自动路由本身仍由 attachment_routing 授权。
  attachment_public_override: ["web", "desktop"],
};

export function platformFeatureSurfaces(
  feature: PlatformFeature,
): readonly CapabilitySurface[] {
  return PLATFORM_FEATURE_SURFACES[feature];
}

export function isCapabilitySurface(value: unknown): value is CapabilitySurface {
  return (
    typeof value === "string" && (CAPABILITY_SURFACES as readonly string[]).includes(value)
  );
}

export function isPlatformFeature(value: unknown): value is PlatformFeature {
  return typeof value === "string" && (PLATFORM_FEATURES as readonly string[]).includes(value);
}

/** `feature:web_search` / `feature:deep_research`。 */
export function featureCapabilityId(feature: PlatformFeature): string {
  if (!isPlatformFeature(feature)) throw new Error(`unknown platform feature: ${String(feature)}`);
  return `feature:${feature}`;
}

export function parseFeatureCapabilityId(capabilityId: string): PlatformFeature | null {
  const raw = String(capabilityId ?? "").trim();
  if (!raw.startsWith("feature:")) return null;
  const feature = raw.slice("feature:".length);
  return isPlatformFeature(feature) ? feature : null;
}

export type ParsedCapabilityId = {
  kind: CapabilityKind;
  /** 被引用行的主键（ULID）。 */
  rowId: string;
};

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export function isCapabilityKind(value: unknown): value is CapabilityKind {
  return typeof value === "string" && (CAPABILITY_KINDS as readonly string[]).includes(value);
}

/** ULID 的规范形态是大写 Crockford base32；小写输入统一抬成大写。 */
export function normalizeRowId(rowId: string): string {
  return String(rowId ?? "").trim().toUpperCase();
}

export function formatCapabilityId(kind: CapabilityKind, rowId: string): string {
  if (!isCapabilityKind(kind)) throw new Error(`unknown capability kind: ${String(kind)}`);
  // feature 走固定标识，不是 ULID：见 PLATFORM_FEATURES 上的说明。
  if (kind === "feature") return featureCapabilityId(rowId as PlatformFeature);
  if (kind === "action") return actionCapabilityId(rowId);
  if (kind === "expert" && isBuiltinExpertCapabilityId(`${kind}:${String(rowId).trim()}`)) {
    return ENTERPRISE_ASSISTANT_CAPABILITY_ID;
  }
  const normalized = normalizeRowId(rowId);
  if (!ULID_RE.test(normalized)) throw new Error(`capability id requires a ULID, got: ${rowId}`);
  return `${kind}:${normalized}`;
}

/** 解析失败返回 null——脏数据不应该冒充一个能力。 */
export function parseCapabilityId(capabilityId: string): ParsedCapabilityId | null {
  const raw = String(capabilityId ?? "").trim();
  const separator = raw.indexOf(":");
  if (separator <= 0) return null;
  const kind = raw.slice(0, separator).toLowerCase();
  if (!isCapabilityKind(kind)) return null;
  if (kind === "feature") {
    const feature = parseFeatureCapabilityId(`feature:${raw.slice(separator + 1).trim().toLowerCase()}`);
    return feature ? { kind, rowId: feature } : null;
  }
  if (kind === "action") {
    const actionId = raw.slice(separator + 1).trim().toLowerCase();
    return isKnownEnterpriseActionCapabilityId(`action:${actionId}`)
      ? { kind, rowId: actionId }
      : null;
  }
  if (kind === "expert" && raw.slice(separator + 1).trim().toLowerCase() === "enterprise_assistant") {
    return { kind, rowId: "enterprise_assistant" };
  }
  const rowId = normalizeRowId(raw.slice(separator + 1));
  if (!ULID_RE.test(rowId)) return null;
  return { kind, rowId };
}

/**
 * 把一个合法能力 id 收敛成唯一可持久化形态。
 *
 * `parseCapabilityId` 会接受小写 ULID，单靠 `isCapabilityId` 做校验后原样入库仍会让
 * `expert:abc...` 与 `expert:ABC...` 变成两个包成员。所有写库入口应使用本函数的返回值，
 * 而不是只验证后继续保存原字符串。
 */
export function canonicalizeCapabilityId(capabilityId: string): string | null {
  const parsed = parseCapabilityId(capabilityId);
  if (!parsed) return null;
  return formatCapabilityId(parsed.kind, parsed.rowId);
}

export function isCapabilityId(value: unknown): value is string {
  return typeof value === "string" && parseCapabilityId(value) !== null;
}

/** 按类型分组，便于一次性去各自的表里批量取行。 */
export function groupCapabilityIdsByKind(
  capabilityIds: readonly string[],
): Record<CapabilityKind, string[]> {
  const out: Record<CapabilityKind, string[]> = {
    mcp: [],
    skill: [],
    feature: [],
    expert: [],
    group: [],
    action: [],
  };
  for (const id of capabilityIds) {
    const parsed = parseCapabilityId(id);
    if (!parsed) continue;
    if (!out[parsed.kind].includes(parsed.rowId)) out[parsed.kind].push(parsed.rowId);
  }
  return out;
}
