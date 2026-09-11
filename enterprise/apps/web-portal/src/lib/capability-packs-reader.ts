/**
 * web-portal · 只读：当前用户实际可用的企业能力（Skill / MCP）。
 *
 * 分配范围沿用可见模型那套 key（`all` / `dept:<id>` / 用户 ulid），部门链从直属
 * 取到根 —— 上级分配的包，下级成员同样拿得到。
 *
 * 企业停用的包与能力**不会出现在结果里**，而不是带 disabled 标记下发：下发出去
 * 就等于让撤销依赖客户端守规矩，而桌面端把企业配置连同 token 缓存在本机明文
 * 配置文件里，被撤销的客户端手上握着上次拿到的全部东西。
 */

import {
  type CapabilitySurface,
  canonicalizeCapabilityId,
  featureCapabilityId,
  groupCapabilityIdsByKind,
  isPlatformFeature,
  type PlatformFeature,
  parseCapabilityId,
  platformFeatureSurfaces,
  resolveCapabilityState,
  resolveEffectiveCapabilities,
  type CapabilityAssignment,
  type CapabilityState,
} from "@agenticx/config";
import type { ActionStoreTransaction } from "@agenticx/action-runtime";
import {
  getAdminUser,
  listUserOptOuts,
  listUserOptOutsInTransaction,
  resolveAssignmentKeysForManagedDelivery as resolveKeysForManagedDelivery,
  resolveAssignmentKeysForUser as resolveKeysForUser,
} from "@agenticx/iam-core";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";

import {
  capabilityTableDefinitions,
  dialectCapabilityTables,
  type DialectQuery,
} from "./capability-tables";

/** 分配给全员的固定 key。 */
export const ALL_MEMBERS_ASSIGNMENT_KEY = "all";

export type PortalCapability = {
  /** `mcp:<ulid>` / `skill:<ulid>` */
  id: string;
  kind: "mcp" | "skill";
  name: string;
  displayName: string;
  /** Skill 声明的依赖能力；MCP 恒为空。 */
  requires: string[];
  version?: string;
  bundleUri?: string;
  bundleDigest?: string;
  /** MCP 专有：网关反代入口，由 desktop-capability-endpoints 在下发前补上。 */
  endpointUrl?: string;
  /** 这条能力在哪些客户端生效。 */
  surfaces: readonly CapabilitySurface[];
};

/** 租户自建的 Skill/MCP 暂时两端通用；MCP version 随 registry 一并下发。 */
export const DEFAULT_CAPABILITY_SURFACES: readonly CapabilitySurface[] = ["web", "desktop"];

/** 企业已启用并分配给该用户的能力，附上用户自己那一位开关。 */
export type UserCapabilityState = PortalCapability & { state: CapabilityState };

/**
 * 一次查询的结果快照：企业侧认可的全部能力，外加用户关掉了其中哪些。
 *
 * 下发（bootstrap）只要过滤后的结果，而「我的能力」页面还要看见被自己关掉的那些，
 * 否则关掉之后就再也找不到地方打开。两者共用这一份，避免各查一遍各判一套。
 */
export type UserCapabilityView = {
  /** 企业启用且已分配、需要下发到客户端的 Skill/MCP（含被用户关闭的）。 */
  assigned: PortalCapability[];
  /** 平台功能只参与服务端授权，不伪装成 Skill/MCP 下发给 Desktop。 */
  assignedPlatformFeatures: Set<PlatformFeature>;
  /** 其中被用户自己关闭的能力 id。 */
  optOuts: Set<string>;
  /** All pack members, including actions and the built-in enterprise assistant entry. */
  assignedCapabilityIds?: Set<string>;
  /** Stable revision of the active pack/member snapshot used by auth sessions. */
  capabilityRevision?: string;
};

type SkillRow = {
  id: string;
  slug: string;
  displayName: string | null;
  version: string;
  bundleUri: string | null;
  bundleDigest: string | null;
  requiredCapabilities: unknown;
  status?: string | null;
  updatedAt?: unknown;
};
type McpRow = { id: string; name: string; displayName: string | null; version: string; status?: string | null; updatedAt?: unknown };

/**
 * Serialize the capability inputs used by both the ordinary snapshot and the
 * transaction-bound dispatch snapshot. Keeping this in one place is required:
 * the former is stored in a session before prepare, while the latter is read
 * again under the tenant delivery lock during prepare/confirm.
 */
function serializeCapabilityRevision(input: {
  packRows: readonly { id: string; updatedAt: unknown }[];
  capabilityIds: Iterable<string>;
  catalogRevision: readonly string[];
  optOuts: Iterable<string>;
}): string {
  return [
    ...input.packRows.map((row) => `pack:${row.id}:${String(row.updatedAt)}`),
    ...[...new Set(input.capabilityIds)].sort().map((id) => `member:${id}`),
    ...input.catalogRevision,
    ...[...new Set(input.optOuts)].sort().map((id) => `optout:${id}`),
  ].sort().join("|") || "packs:none";
}

/**
 * 该用户名下所有生效的分配 key。
 *
 * 解析规则只有 iam-core 那一份：可见模型、能力包、功能开关、网关撤销判定四处必须
 * 拼出同一组 key，各拼各的就会出现「后台说他有、真去用被拒」这种最难查的不一致。
 */
export const resolveAssignmentKeysForUser = resolveKeysForUser;
export const resolveAssignmentKeysForManagedDelivery = resolveKeysForManagedDelivery;

function requireTenantId(value: string): string {
  const tenantId = String(value ?? "").trim();
  if (!tenantId) throw new Error("tenantId is required to resolve enterprise capabilities");
  return tenantId;
}

function toSkillCapability(row: SkillRow): PortalCapability {
  return {
    surfaces: DEFAULT_CAPABILITY_SURFACES,
    id: `skill:${row.id}`,
    kind: "skill",
    name: row.slug,
    displayName: row.displayName || row.slug,
    requires: Array.isArray(row.requiredCapabilities)
      ? (row.requiredCapabilities as unknown[]).map(String)
      : [],
    version: row.version,
    bundleUri: row.bundleUri ?? "",
    bundleDigest: row.bundleDigest ?? "",
  };
}

function toMcpCapability(row: McpRow): PortalCapability {
  return {
    surfaces: DEFAULT_CAPABILITY_SURFACES,
    id: `mcp:${row.id}`,
    kind: "mcp",
    name: row.name,
    displayName: row.displayName || row.name,
    requires: [],
    version: row.version,
  };
}

/** 企业侧认可的能力 + 用户关闭记录，一次查完。 */
export async function loadUserCapabilityView(
  tenantIdInput: string,
  userId: string,
  email?: string,
  deptId?: string | null,
  options: { strictAssignmentLookup?: boolean } = {},
): Promise<UserCapabilityView> {
  const tenantId = requireTenantId(tenantIdInput);
  const t = await dialectCapabilityTables();
  const query = t.db as unknown as DialectQuery;
  const assignmentKeys = options.strictAssignmentLookup
    ? await resolveAssignmentKeysForManagedDelivery(tenantId, userId, email, deptId)
    : await resolveAssignmentKeysForUser(tenantId, userId, email, deptId);

  // Read opt-outs even when no pack is currently assigned. The transaction
  // snapshot performs the same read before serializing its revision; omitting
  // it on the ordinary no-pack path would make an unchanged session look stale
  // solely because the two paths observed different fields.
  const optOuts = new Set(await listUserOptOuts(tenantId, userId));

  // 只取 active 的包：停用的包在这一步就消失，不进入后续任何环节。
  const packRows = (await query
    .select({ id: t.packs.id, updatedAt: t.packs.updatedAt })
    .from(t.packs)
    .innerJoin(t.assignments, eq(t.assignments.packId, t.packs.id))
    .where(
      and(
        eq(t.packs.tenantId, tenantId),
        eq(t.packs.status, "active"),
        eq(t.assignments.tenantId, tenantId),
        inArray(t.assignments.assignmentKey, assignmentKeys),
      ),
  )) as Array<{ id: string; updatedAt: unknown }>;
  const packIds = [...new Set(packRows.map((row) => row.id))];
  if (packIds.length === 0) {
    return {
      assigned: [],
      assignedPlatformFeatures: new Set(),
      optOuts,
      assignedCapabilityIds: new Set(),
      capabilityRevision: serializeCapabilityRevision({
        packRows,
        capabilityIds: [],
        catalogRevision: [],
        optOuts,
      }),
    };
  }

  const memberRows = (await query
    .select({ capabilityId: t.members.capabilityId })
    .from(t.members)
    .where(inArray(t.members.packId, packIds))) as Array<{ capabilityId: string }>;
  const candidateIds = [...new Set(memberRows.map((row) => row.capabilityId))];
  if (candidateIds.length === 0) {
    return {
      assigned: [],
      assignedPlatformFeatures: new Set(),
      optOuts,
      assignedCapabilityIds: new Set(),
      capabilityRevision: serializeCapabilityRevision({
        packRows,
        capabilityIds: [],
        catalogRevision: [],
        optOuts,
      }),
    };
  }

  const normalizedCandidateIds = [...new Set(
    memberRows
      .map((row) => canonicalizeCapabilityId(String(row.capabilityId)))
      .filter((id): id is string => Boolean(id)),
  )];
  const grouped = groupCapabilityIdsByKind(normalizedCandidateIds);
  // feature 没有租户行可查；能进入 grouped.feature 已经说明 id 通过了平台枚举校验。
  // 单独保留授权结果，避免既把它丢掉，又把它误下发成 Desktop 的 MCP/Skill。
  const assignedPlatformFeatures = new Set(grouped.feature.filter(isPlatformFeature));

  // 成员行只是引用；被引用的那一行自身也可能已停用或已删除，两层都要过。
  // 查询完整的候选 catalog（而不是只查 active）还让 revision 在 active → disabled
  // 或 active → missing 时变化，确保已有 session 重新走实时门控。
  const skillRows = grouped.skill.length
    ? ((await query
        .select()
        .from(t.skills)
        .where(
          and(
            eq(t.skills.tenantId, tenantId),
            inArray(t.skills.id, grouped.skill),
          ),
        )) as SkillRow[])
    : [];
  const mcpRows = grouped.mcp.length
    ? ((await query
        .select()
        .from(t.mcp)
        .where(
          and(
            eq(t.mcp.tenantId, tenantId),
            inArray(t.mcp.id, grouped.mcp),
          ),
        )) as McpRow[])
    : [];

  const activeSkillIds = new Set(
    skillRows.filter((row) => row.status === "active").map((row) => row.id),
  );
  const activeMcpIds = new Set(
    mcpRows.filter((row) => row.status === "active").map((row) => row.id),
  );
  // Platform actions/features and the built-in enterprise assistant are
  // registry entries rather than tenant catalog rows.  Portable Skill/MCP
  // ids, however, are valid only while their tenant registry row exists and
  // is active; a stale pack member must never satisfy an execution gate.
  const assignedCapabilityIds = new Set(
    normalizedCandidateIds.filter((id) => {
      const parsed = parseCapabilityId(id);
      if (!parsed) return false;
      if (parsed.kind === "skill") return activeSkillIds.has(parsed.rowId);
      if (parsed.kind === "mcp") return activeMcpIds.has(parsed.rowId);
      return true;
    }),
  );

  const assigned = [
    ...skillRows.filter((row) => activeSkillIds.has(row.id)).map(toSkillCapability),
    ...mcpRows.filter((row) => activeMcpIds.has(row.id)).map(toMcpCapability),
  ].sort((left, right) => left.id.localeCompare(right.id));

  const catalogRevision = [
    ...grouped.skill.map((id) => {
      const row = skillRows.find((candidate) => candidate.id === id);
      return `catalog:skill:${id}:${row?.status ?? "missing"}:${row?.version ?? ""}:${String(row?.updatedAt ?? "")}`;
    }),
    ...grouped.mcp.map((id) => {
      const row = mcpRows.find((candidate) => candidate.id === id);
      return `catalog:mcp:${id}:${row?.status ?? "missing"}:${row?.version ?? ""}:${String(row?.updatedAt ?? "")}`;
    }),
  ];

  return {
    assigned,
    assignedPlatformFeatures,
    optOuts,
    assignedCapabilityIds,
    capabilityRevision: serializeCapabilityRevision({
      packRows,
      capabilityIds: normalizedCandidateIds,
      catalogRevision,
      optOuts,
    }),
  };
}

/** Live pack gate shared by capability discovery, session entry, and action dispatch. */
export async function isCapabilityAllowedForUser(
  tenantId: string,
  userId: string,
  capabilityIdInput: string,
  email?: string,
  deptId?: string | null,
): Promise<boolean> {
  const capabilityId = canonicalizeCapabilityId(capabilityIdInput);
  if (!capabilityId) return false;
  const view = await loadUserCapabilityView(tenantId, userId, email, deptId);
  return Boolean(view.assignedCapabilityIds?.has(capabilityId) && !view.optOuts.has(capabilityId));
}

type TransactionalCapabilityGateInput = {
  transaction: ActionStoreTransaction;
  tenantId: string;
  userId: string;
  capabilityId: string;
  email?: string;
  deptId?: string | null;
};

/**
 * Re-read one capability under the same transaction used by ActionRuntime's
 * handler. The tenant row is the delivery serialization point shared with
 * capability-pack and IAM ownership mutations. The current user, department
 * chain, group membership, pack, catalog, and opt-out reads all happen after
 * that lock on this transaction, so a committed revoke either waits for this
 * dispatch to commit or wins before it starts.
 */
export async function isCapabilityAllowedForUserInTransaction(
  input: TransactionalCapabilityGateInput,
): Promise<boolean> {
  const tenantId = requireTenantId(input.tenantId);
  const capabilityId = canonicalizeCapabilityId(input.capabilityId);
  if (!capabilityId) return false;

  const raw = input.transaction.raw as {
    execute?: (query: unknown) => Promise<unknown>;
    select?: (fields?: unknown) => unknown;
  } | null;
  if (!raw || typeof raw.execute !== "function" || typeof raw.select !== "function") {
    throw new Error("transactional capability gate unavailable");
  }

  const tables = capabilityTableDefinitions(input.transaction.dialect);
  await raw.execute(
    sql`select ${tables.tenants.id} from ${tables.tenants} where ${tables.tenants.id} = ${tenantId} for update`,
  );

  // The concrete Drizzle dialects expose the same select/from/join/where/
  // limit chain, but their generic builder types are intentionally different.
  // This is the smallest adapter boundary and still leaves every table and
  // column reference statically checked above.
  const tx = raw as any;
  const userId = String(input.userId ?? "").trim();
  if (!userId) return false;
  const userRows = await tx
    .select({
      id: tables.users.id,
      email: tables.users.email,
      deptId: tables.users.deptId,
      status: tables.users.status,
      lockedUntil: tables.users.lockedUntil,
      isDeleted: tables.users.isDeleted,
      deletedAt: tables.users.deletedAt,
    })
    .from(tables.users)
    .where(
      and(
        eq(tables.users.tenantId, tenantId),
        eq(tables.users.id, userId),
        eq(tables.users.status, "active"),
        eq(tables.users.isDeleted, false),
        isNull(tables.users.deletedAt),
      ),
    )
    .for("update")
    .limit(1);
  const currentUser = userRows[0];
  if (!currentUser) return false;
  // `status` stays `active` while a temporary login lock is represented by
  // `lockedUntil`.  Recheck that field from the same locked row so a failed
  // login that wins this row lock cannot leave a capability dispatch running.
  const lockedUntil = currentUser.lockedUntil as Date | string | number | null | undefined;
  const lockedUntilMs = lockedUntil == null ? 0 : new Date(lockedUntil as any).getTime();
  if (!Number.isFinite(lockedUntilMs) || lockedUntilMs > Date.now()) return false;

  // The request may carry a stale token snapshot. Resolve every effective
  // assignment key from rows read after the tenant lock, so a committed user,
  // department, or group change either waits for this dispatch or is visible
  // before the capability decision.
  const assignmentKeys = new Set<string>(["all", userId]);
  const currentEmail = String(currentUser.email ?? "").trim().toLowerCase();
  if (currentEmail) assignmentKeys.add(`email:${currentEmail}`);
  const departmentRows = await tx
    .select({ id: tables.departments.id, parentId: tables.departments.parentId })
    .from(tables.departments)
    .where(eq(tables.departments.tenantId, tenantId));
  const departmentById = new Map(
    (departmentRows as Array<{ id: string; parentId: string | null }>).map((row) => [row.id, row]),
  );
  let currentDeptId = (currentUser.deptId as string | null | undefined) ?? null;
  const seenDepartments = new Set<string>();
  while (currentDeptId && !seenDepartments.has(currentDeptId)) {
    seenDepartments.add(currentDeptId);
    const department = departmentById.get(currentDeptId);
    if (!department) break;
    assignmentKeys.add(`dept:${department.id}`);
    currentDeptId = department.parentId;
  }
  const groupRows = await tx
    .select({ groupId: tables.groupMembers.groupId })
    .from(tables.groupMembers)
    .innerJoin(tables.groups, eq(tables.groups.id, tables.groupMembers.groupId))
    .where(
      and(
        eq(tables.groups.tenantId, tenantId),
        eq(tables.groupMembers.userId, userId),
      ),
    );
  for (const row of groupRows as Array<{ groupId: string }>) assignmentKeys.add(`group:${row.groupId}`);

  const memberRows = (await tx
    .select({ capabilityId: tables.members.capabilityId })
    .from(tables.members)
    .innerJoin(tables.packs, eq(tables.packs.id, tables.members.packId))
    .innerJoin(tables.assignments, eq(tables.assignments.packId, tables.members.packId))
    .where(
      and(
        eq(tables.packs.tenantId, tenantId),
        eq(tables.packs.status, "active"),
        eq(tables.assignments.tenantId, tenantId),
        inArray(tables.assignments.assignmentKey, [...assignmentKeys]),
        eq(tables.members.capabilityId, capabilityId),
      ),
    )
    .limit(1)) as Array<{ capabilityId: string }>;
  if (memberRows.length === 0) return false;

  // Pack members for portable artifacts are references. A disabled or
  // deleted catalog row must not leave a stale member capable of dispatch.
  const parsed = parseCapabilityId(capabilityId);
  if (!parsed) return false;
  if (parsed.kind === "skill") {
    const rows = await tx
      .select({ id: tables.skills.id })
      .from(tables.skills)
      .where(
        and(
          eq(tables.skills.tenantId, tenantId),
          eq(tables.skills.id, parsed.rowId),
          eq(tables.skills.status, "active"),
        ),
      )
      .limit(1);
    if (rows.length === 0) return false;
  } else if (parsed.kind === "mcp") {
    const rows = await tx
      .select({ id: tables.mcp.id })
      .from(tables.mcp)
      .where(
        and(
          eq(tables.mcp.tenantId, tenantId),
          eq(tables.mcp.id, parsed.rowId),
          eq(tables.mcp.status, "active"),
        ),
      )
      .limit(1);
    if (rows.length === 0) return false;
  }

  const optOutRows = await tx
    .select({ subject: tables.optOuts.subject })
    .from(tables.optOuts)
    .where(
      and(
        eq(tables.optOuts.tenantId, tenantId),
        eq(tables.optOuts.userId, userId),
        eq(tables.optOuts.subject, capabilityId),
      ),
    )
    .limit(1);
  return optOutRows.length === 0;
}

/**
 * Build the capability revision from the same transaction used by dispatch.
 * This intentionally reuses the legacy opt-out migration through the caller's
 * transaction, because running the migration on a fresh connection after the
 * tenant delivery lock is held can self-block on the tenant FK.
 */
async function capabilityAuthorizationRevisionInTransaction(input: {
  transaction: ActionStoreTransaction;
  tenantId: string;
  userId: string;
}): Promise<string> {
  const tenantId = requireTenantId(input.tenantId);
  const raw = input.transaction.raw as {
    execute?: (query: unknown) => Promise<unknown>;
    select?: (fields?: unknown) => unknown;
  } | null;
  if (!raw || typeof raw.execute !== "function" || typeof raw.select !== "function") {
    throw new Error("transactional capability revision unavailable");
  }
  const tables = capabilityTableDefinitions(input.transaction.dialect);
  await raw.execute(
    sql`select ${tables.tenants.id} from ${tables.tenants} where ${tables.tenants.id} = ${tenantId} for update`,
  );
  const tx = raw as any;
  const userId = String(input.userId ?? "").trim();
  const userRows = userId
    ? await tx
        .select({
          id: tables.users.id,
          email: tables.users.email,
          deptId: tables.users.deptId,
          status: tables.users.status,
          isDeleted: tables.users.isDeleted,
          deletedAt: tables.users.deletedAt,
        })
        .from(tables.users)
        .where(and(eq(tables.users.tenantId, tenantId), eq(tables.users.id, userId)))
        .for("update")
        .limit(1)
    : [];
  const currentUser = userRows[0] as {
    id?: string;
    email?: string | null;
    deptId?: string | null;
    status?: string | null;
    isDeleted?: boolean | null;
    deletedAt?: unknown;
  } | undefined;

  // This call performs any required legacy modelExclusions migration on tx,
  // then reads the authoritative rows. It must remain strict so a migration
  // failure cannot silently produce an incomplete authorization snapshot.
  const optOuts = userId
    ? await listUserOptOutsInTransaction(tenantId, userId, raw)
    : [];

  const assignmentKeys = new Set<string>(["all"]);
  if (userId) assignmentKeys.add(userId);
  const currentEmail = String(currentUser?.email ?? "").trim().toLowerCase();
  if (currentEmail) assignmentKeys.add(`email:${currentEmail}`);
  const departmentRows = await tx
    .select({ id: tables.departments.id, parentId: tables.departments.parentId })
    .from(tables.departments)
    .where(eq(tables.departments.tenantId, tenantId));
  const departmentById = new Map(
    (departmentRows as Array<{ id: string; parentId: string | null }>).map((row) => [row.id, row]),
  );
  let currentDeptId = (currentUser?.deptId as string | null | undefined) ?? null;
  const seenDepartments = new Set<string>();
  while (currentDeptId && !seenDepartments.has(currentDeptId)) {
    seenDepartments.add(currentDeptId);
    const department = departmentById.get(currentDeptId);
    if (!department) break;
    assignmentKeys.add(`dept:${department.id}`);
    currentDeptId = department.parentId;
  }
  const groupRows = userId
    ? await tx
        .select({ groupId: tables.groupMembers.groupId })
        .from(tables.groupMembers)
        .innerJoin(tables.groups, eq(tables.groups.id, tables.groupMembers.groupId))
        .where(and(eq(tables.groups.tenantId, tenantId), eq(tables.groupMembers.userId, userId)))
    : [];
  for (const row of groupRows as Array<{ groupId: string }>) assignmentKeys.add(`group:${row.groupId}`);

  const packRows = (await tx
    .select({ id: tables.packs.id, updatedAt: tables.packs.updatedAt })
    .from(tables.packs)
    .innerJoin(tables.assignments, eq(tables.assignments.packId, tables.packs.id))
    .where(
      and(
        eq(tables.packs.tenantId, tenantId),
        eq(tables.packs.status, "active"),
        eq(tables.assignments.tenantId, tenantId),
        inArray(tables.assignments.assignmentKey, [...assignmentKeys]),
      ),
    )) as Array<{ id: string; updatedAt: unknown }>;
  const packIds = [...new Set(packRows.map((row) => row.id))];
  const memberRows = packIds.length
    ? (await tx
        .select({ capabilityId: tables.members.capabilityId })
        .from(tables.members)
        .where(inArray(tables.members.packId, packIds))) as Array<{ capabilityId: string }>
    : [];
  const capabilityIds = [...new Set(
    memberRows
      .map((row) => canonicalizeCapabilityId(String(row.capabilityId)))
      .filter((id): id is string => Boolean(id)),
  )];
  const grouped = groupCapabilityIdsByKind(capabilityIds);
  const catalogRevision: string[] = [];
  if (grouped.skill.length) {
    const rows = (await tx
      .select({ id: tables.skills.id, status: tables.skills.status, version: tables.skills.version, updatedAt: tables.skills.updatedAt })
      .from(tables.skills)
      .where(and(eq(tables.skills.tenantId, tenantId), inArray(tables.skills.id, grouped.skill)))) as Array<{ id: string; status: string | null; version: string | null; updatedAt: unknown }>;
    const byId = new Map(rows.map((row) => [row.id, row]));
    for (const id of grouped.skill) {
      const row = byId.get(id);
      catalogRevision.push(`catalog:skill:${id}:${row?.status ?? "missing"}:${row?.version ?? ""}:${String(row?.updatedAt ?? "")}`);
    }
  }
  if (grouped.mcp.length) {
    const rows = (await tx
      .select({ id: tables.mcp.id, status: tables.mcp.status, version: tables.mcp.version, updatedAt: tables.mcp.updatedAt })
      .from(tables.mcp)
      .where(and(eq(tables.mcp.tenantId, tenantId), inArray(tables.mcp.id, grouped.mcp)))) as Array<{ id: string; status: string | null; version: string | null; updatedAt: unknown }>;
    const byId = new Map(rows.map((row) => [row.id, row]));
    for (const id of grouped.mcp) {
      const row = byId.get(id);
      catalogRevision.push(`catalog:mcp:${id}:${row?.status ?? "missing"}:${row?.version ?? ""}:${String(row?.updatedAt ?? "")}`);
    }
  }

  return serializeCapabilityRevision({
    packRows,
    capabilityIds,
    catalogRevision,
    optOuts,
  });
}

export async function capabilityAuthorizationRevision(
  tenantId: string,
  userId: string,
  email?: string,
  deptId?: string | null,
  transaction?: ActionStoreTransaction,
): Promise<string> {
  if (transaction) {
    return capabilityAuthorizationRevisionInTransaction({ transaction, tenantId, userId });
  }
  // The non-transactional session snapshot is still authoritative data, so
  // resolve the current user row before deriving email/department assignment
  // keys. The request's token values may be stale by the time this function is
  // called; using them here would disagree with the transaction snapshot at
  // prepare/confirm and falsely stale an unchanged proposal.
  const currentUser = await getAdminUser(tenantId, userId);
  const view = await loadUserCapabilityView(
    tenantId,
    userId,
    currentUser?.email,
    currentUser?.deptId,
  );
  return view.capabilityRevision ?? "packs:legacy";
}

/**
 * 这项功能有没有被任何能力包引用过。
 *
 * 只看引用，不看包的状态或分配——停用的包同样说明「管理员已经开始用能力包管这项功能了」，
 * 此时谁都拿不到是正确结果；而一个引用都没有才意味着还没纳管，该保持原样。
 */
async function isFeatureGovernedByAnyPack(
  tenantIdInput: string,
  capabilityId: string,
): Promise<boolean> {
  const tenantId = requireTenantId(tenantIdInput);
  const t = await dialectCapabilityTables();
  const query = t.db as unknown as DialectQuery;
  const rows = (await query
    .select({ packId: t.members.packId })
    .from(t.members)
    .innerJoin(t.packs, eq(t.packs.id, t.members.packId))
    .where(
      and(eq(t.packs.tenantId, tenantId), eq(t.members.capabilityId, capabilityId)),
    )) as Array<{ packId: string }>;
  return rows.length > 0;
}

/**
 * 这个人能不能用某项平台功能（联网搜索、深度研究）。
 *
 * 判定和 MCP/Skill 走同一条路：功能是能力包的成员，包分给谁谁就有。原本它有自己的
 * enterprise_feature_assignments 表和自己的分配 UI，等于两套并行的授权系统——管理员想的
 * 只是「这个人能用什么」，不该因为这一项是「平台功能」就换一个地方配。
 *
 * 迁移安全：**没有任何包引用这项功能时，视为还没纳入能力包管理，保持全员可用。**
 * 直接改成「不在包里就不能用」会让所有现存租户的搜索在升级当天静默失效，而现场看到的
 * 现象是「搜索突然不工作了」，查不到是权限在拦。这和网关那边 governed 的处理是同一条：
 * 不被任何包引用的东西保持原有行为。
 */
export async function isPlatformFeatureAllowedForUser(
  tenantId: string,
  feature: PlatformFeature,
  userId: string,
  email?: string,
  deptId?: string | null,
): Promise<boolean> {
  const capabilityId = featureCapabilityId(feature);
  const governed = await isFeatureGovernedByAnyPack(tenantId, capabilityId);
  // 公网例外是新增加的“放宽数据边界”权限，必须显式授予。其余存量功能保留旧租户的
  // fail-open 迁移语义；把这项也 fail-open 会让没有配置任何能力包的租户全员获得例外。
  if (!governed) return feature !== "attachment_public_override";
  const view = await loadUserCapabilityView(tenantId, userId, email, deptId);
  if (view.optOuts.has(capabilityId)) return false;
  return view.assignedPlatformFeatures.has(feature);
}

/** 供下发：用户当下真正能调用的能力。 */
export async function listAvailableCapabilitiesForUser(
  tenantId: string,
  userId: string,
  email?: string,
  deptId?: string | null,
  surface?: CapabilitySurface,
): Promise<PortalCapability[]> {
  // Desktop bootstrap is an authoritative desired-state snapshot. A transient
  // group lookup failure must throw so the route omits the field and Desktop
  // keeps LKG; it must never masquerade as an empty assignment set.
  const view = await loadUserCapabilityView(tenantId, userId, email, deptId, {
    strictAssignmentLookup: true,
  });
  return effectiveFromView(view, surface);
}

/**
 * @param surface 只返回在该客户端生效的能力；不传表示不过滤（管理端「我的能力」
 *   要看到全部，下发路径才需要收窄）。
 */
export function effectiveFromView(
  view: UserCapabilityView,
  surface?: CapabilitySurface,
): PortalCapability[] {
  const byId = new Map(view.assigned.map((item) => [item.id, item] as const));
  // 走同一个策略函数，避免这里与管理端对「生效」有两套判断。
  const assignments: CapabilityAssignment[] = view.assigned.map((item) => ({
    capabilityId: item.id,
    enterpriseEnabled: true,
  }));
  const effective = resolveEffectiveCapabilities(assignments, view.optOuts)
    .map((id) => byId.get(id))
    .filter((item): item is PortalCapability => Boolean(item));
  if (!surface) return effective;
  return effective.filter((item) => item.surfaces.includes(surface));
}

/**
 * 这个人在指定客户端上能不能用某项平台功能。
 *
 * 平台功能的 surface 由平台定义（platformFeatureSurfaces），管理员分配的是「能不能
 * 用」，不是「在哪能用」。附件自动路由两端都要，但比如将来出现只在 Desktop 成立的
 * 功能，portal 侧就该直接判 false 而不是下发一个点不动的开关。
 */
export async function isPlatformFeatureAllowedOnSurface(
  tenantId: string,
  feature: PlatformFeature,
  surface: CapabilitySurface,
  userId: string,
  email?: string,
  deptId?: string | null,
): Promise<boolean> {
  if (!platformFeatureSurfaces(feature).includes(surface)) return false;
  return isPlatformFeatureAllowedForUser(tenantId, feature, userId, email, deptId);
}

/** 供「我的能力」页面：连被自己关掉的一起列出来，否则关掉之后就找不回来了。 */
export function capabilityStatesFromView(view: UserCapabilityView): UserCapabilityState[] {
  return view.assigned.map((item) => ({
    ...item,
    state: resolveCapabilityState(true, view.optOuts.has(item.id)),
  }));
}

/** Skill 声明的依赖若没随包下发，Desktop 装了也调不通；标出来供前端提示。 */
export function findUnmetSkillDependencies(capabilities: readonly PortalCapability[]): string[] {
  const present = new Set(capabilities.map((item) => item.id));
  const missing = new Set<string>();
  for (const item of capabilities) {
    for (const dependency of item.requires) {
      if (!parseCapabilityId(dependency)) continue;
      if (!present.has(dependency)) missing.add(dependency);
    }
  }
  return [...missing].sort();
}
