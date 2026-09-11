import { getAuditMysqlDb } from "./mysql-database";
import type { AuditDigest, AuditPolicyHit } from "@agenticx/core-api";
import { auditEvents, gatewayAuditEvents, users } from "@agenticx/db-schema/mysql";
import { getAuditRetentionCutoff } from "@agenticx/iam-core";
import { and, asc, count, desc, eq, gte, lte, or, sql, type SQL } from "drizzle-orm";
import { ulid } from "ulid";
import type { AuditActor, AuditEvent, AuditQueryInput, AuditQueryResult, AuditStore } from "../types";
import { verifyPersistedChecksum } from "./checksum";

const EXPORT_ROW_HARD_CAP = 100_000;
export const ATTACHMENT_PUBLIC_OVERRIDE_EVENT_TYPE = "attachment_routing.public_override" as const;
const ATTACHMENT_PUBLIC_OVERRIDE_TARGET_KIND = "chat_session" as const;
export const ATTACHMENT_ROUTING_UPDATE_EVENT_TYPE = "attachment_routing.update" as const;
const ATTACHMENT_ROUTING_CONFIG_TARGET_KIND = "attachment_routing_config" as const;

type AuditVisibility =
  | { kind: "all" }
  | { kind: "dept"; deptId: string }
  | { kind: "self"; userId: string };

type IamAuditJoinRow = {
  audit: typeof auditEvents.$inferSelect;
  userEmail: string | null;
  departmentId: string | null;
};

type MergedAuditCandidate = {
  event: AuditEvent;
  gatewayRow?: typeof gatewayAuditEvents.$inferSelect;
};

function resolveVisibility(actor: AuditActor): AuditVisibility {
  const scopes = new Set(actor.scopes);
  if (scopes.has("*") || scopes.has("audit:manage") || scopes.has("audit:read:all")) {
    return { kind: "all" };
  }
  if (scopes.has("audit:read:dept") && actor.deptId) {
    return { kind: "dept", deptId: actor.deptId };
  }
  return { kind: "self", userId: actor.userId };
}

function visibilityPredicates(actor: AuditActor) {
  const visibility = resolveVisibility(actor);
  if (visibility.kind === "all") {
    return undefined;
  }
  if (visibility.kind === "dept") {
    return eq(gatewayAuditEvents.departmentId, visibility.deptId);
  }
  return eq(gatewayAuditEvents.userId, visibility.userId);
}

function iamVisibilityPredicate(actor: AuditActor) {
  const visibility = resolveVisibility(actor);
  if (visibility.kind === "all") {
    return undefined;
  }
  if (visibility.kind === "dept") {
    return eq(users.deptId, visibility.deptId);
  }
  return eq(auditEvents.actorUserId, visibility.userId);
}

function safePolicyId(raw: string): string | null {
  const id = raw.trim();
  if (!id || id.length > 128) return null;
  if (!/^[a-zA-Z0-9._-]+$/.test(id)) return null;
  return id;
}

function rowToAuditEvent(row: typeof gatewayAuditEvents.$inferSelect): AuditEvent {
  const policiesRaw = row.policiesHit as AuditPolicyHit[] | null | undefined;
  const digestRaw = row.digest as AuditDigest | null | undefined;
  const toolsRaw = row.toolsCalled;
  const toolsCalled = Array.isArray(toolsRaw)
    ? toolsRaw.filter((value): value is string => typeof value === "string")
    : undefined;
  return {
    id: row.id,
    tenant_id: row.tenantId,
    event_time: row.eventTime.toISOString(),
    event_type: row.eventType as AuditEvent["event_type"],
    user_id: row.userId ?? null,
    user_email: row.userEmail ?? undefined,
    department_id: row.departmentId ?? undefined,
    session_id: row.sessionId ?? undefined,
    trace_id: row.traceId ?? undefined,
    client_type: row.clientType as AuditEvent["client_type"],
    client_ip: row.clientIp ?? undefined,
    provider: row.provider ?? undefined,
    model: row.model ?? undefined,
    route: row.route as AuditEvent["route"],
    channel_id: row.channelId ?? undefined,
    channel_key_ref: row.channelKeyRef ?? undefined,
    api_token_id: row.apiTokenId ?? undefined,
    input_tokens: row.inputTokens ?? undefined,
    output_tokens: row.outputTokens ?? undefined,
    total_tokens: row.totalTokens ?? undefined,
    cost_usd: undefined,
    latency_ms: row.latencyMs ?? undefined,
    digest: digestRaw ?? undefined,
    tools_called: toolsCalled,
    policies_hit: Array.isArray(policiesRaw) ? policiesRaw : undefined,
    mcp_server: row.mcpServer ?? undefined,
    mcp_tool_name: row.mcpToolName ?? undefined,
    mcp_input_hash: row.mcpInputHash ?? undefined,
    mcp_output_hash: row.mcpOutputHash ?? undefined,
    mcp_status: row.mcpStatus ?? undefined,
    prev_checksum: row.prevChecksum,
    checksum: row.checksum,
    checksum_version: row.checksumVersion,
    signature: row.signature ?? undefined,
    src_region: row.srcRegion ?? undefined,
    dst_region: row.dstRegion ?? undefined,
    cross_border: row.crossBorder ?? undefined,
    residency_rule: row.residencyRule ?? undefined,
  };
}

function normalizeAuditDetail(raw: unknown): Record<string, unknown> | undefined {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function detailString(detail: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = detail?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function rowToIamAuditEvent(row: IamAuditJoinRow): AuditEvent {
  const detail = normalizeAuditDetail(row.audit.detail);
  const surface = detailString(detail, "surface");
  const isAdminRoutingUpdate =
    row.audit.eventType === ATTACHMENT_ROUTING_UPDATE_EVENT_TYPE &&
    row.audit.targetKind === ATTACHMENT_ROUTING_CONFIG_TARGET_KIND;
  return {
    id: row.audit.id,
    tenant_id: row.audit.tenantId,
    event_time: row.audit.createdAt.toISOString(),
    event_type: row.audit.eventType as AuditEvent["event_type"],
    user_id: row.audit.actorUserId ?? null,
    user_email: row.userEmail ?? undefined,
    department_id: row.departmentId ?? undefined,
    session_id:
      row.audit.targetKind === ATTACHMENT_PUBLIC_OVERRIDE_TARGET_KIND
        ? row.audit.targetId ?? undefined
        : undefined,
    client_type: surface === "web" ? "web-portal" : isAdminRoutingUpdate ? "admin-console" : "desktop",
    model: detailString(detail, "requestedModel"),
    route: "third-party",
    detail,
    audit_source: "iam",
    // IAM audit_events is intentionally not part of gateway_audit_events' hash chain.
    prev_checksum: "",
    checksum: "",
    checksum_version: "iam",
  };
}

function compareCandidatesDesc(a: MergedAuditCandidate, b: MergedAuditCandidate): number {
  const timeDiff = Date.parse(b.event.event_time) - Date.parse(a.event.event_time);
  if (timeDiff !== 0) return timeDiff;
  const idDiff = b.event.id.localeCompare(a.event.id);
  if (idDiff !== 0) return idDiff;
  return (b.event.audit_source ?? "gateway").localeCompare(a.event.audit_source ?? "gateway");
}

export function mergeAuditCandidates(
  candidates: MergedAuditCandidate[],
  offset: number,
  limit: number,
): MergedAuditCandidate[] {
  return [...candidates].sort(compareCandidatesDesc).slice(offset, offset + limit);
}

function iamFiltersAreCompatible(input: AuditQueryInput): boolean {
  // IAM attachment-routing events do not carry gateway trace/provider/policy/region fields.
  // Excluding them for these filters avoids making an incomplete IAM row look like a match.
  return !input.trace_id && !input.provider && !input.policy_hit && input.cross_border !== true;
}

function addIamDetailFilters(input: AuditQueryInput, conditions: SQL[]): void {
  if (input.model) {
    conditions.push(
      sql`JSON_UNQUOTE(JSON_EXTRACT(${auditEvents.detail}, '$.requestedModel')) = ${input.model}`,
    );
  }
  if (input.start) {
    const t = new Date(input.start);
    if (!Number.isNaN(t.getTime())) conditions.push(gte(auditEvents.createdAt, t));
  }
  if (input.end) {
    const t = new Date(input.end);
    if (!Number.isNaN(t.getTime())) conditions.push(lte(auditEvents.createdAt, t));
  }
}

function checkChainSlice(rows: Array<typeof gatewayAuditEvents.$inferSelect>): {
  valid: boolean;
  at?: string;
  reason?: string;
  verified: number;
  legacyUnverified: number;
} {
  let prev: string | undefined;
  let verified = 0;
  let legacyUnverified = 0;
  for (const current of rows) {
    if (current.clientType === "admin-console") {
      continue;
    }
    if (prev !== undefined && current.prevChecksum !== prev) {
      return { valid: false, at: current.id, reason: "prev_checksum_mismatch", verified, legacyUnverified };
    }
    const checksum = verifyPersistedChecksum(current);
    if (checksum.status === "invalid") {
      return { valid: false, at: current.id, reason: checksum.reason, verified, legacyUnverified };
    }
    if (checksum.status === "legacy") legacyUnverified += 1;
    else verified += 1;
    prev = current.checksum;
  }
  return { valid: true, verified, legacyUnverified };
}

async function applyRetentionWindow(
  tenantId: string,
  conditions: SQL[],
  iamConditions?: SQL[],
): Promise<void> {
  const cutoff = await getAuditRetentionCutoff(tenantId);
  if (cutoff) {
    conditions.push(gte(gatewayAuditEvents.eventTime, cutoff));
    iamConditions?.push(gte(auditEvents.createdAt, cutoff));
  }
}

export class MysqlAuditStore implements AuditStore {
  public async query(actor: AuditActor, input: AuditQueryInput): Promise<AuditQueryResult> {
    const db = getAuditMysqlDb();
    const gatewayConditions: SQL[] = [eq(gatewayAuditEvents.tenantId, input.tenant_id)];
    const iamConditions: SQL[] = [
      eq(auditEvents.tenantId, input.tenant_id),
      // Keep the event/target pairs explicit so an unrelated IAM event (or a
      // malformed attachment event with the wrong target kind) cannot leak
      // into the attachment-routing audit view.
      or(
        and(
          eq(auditEvents.eventType, ATTACHMENT_PUBLIC_OVERRIDE_EVENT_TYPE),
          eq(auditEvents.targetKind, ATTACHMENT_PUBLIC_OVERRIDE_TARGET_KIND),
        ),
        and(
          eq(auditEvents.eventType, ATTACHMENT_ROUTING_UPDATE_EVENT_TYPE),
          eq(auditEvents.targetKind, ATTACHMENT_ROUTING_CONFIG_TARGET_KIND),
        ),
      )!,
    ];

    const vis = visibilityPredicates(actor);
    if (vis) {
      gatewayConditions.push(vis);
    }
    const iamVis = iamVisibilityPredicate(actor);
    if (iamVis) {
      iamConditions.push(iamVis);
    }

    await applyRetentionWindow(input.tenant_id, gatewayConditions, iamConditions);

    if (input.user_id) {
      gatewayConditions.push(eq(gatewayAuditEvents.userId, input.user_id));
      iamConditions.push(eq(auditEvents.actorUserId, input.user_id));
    }
    if (input.trace_id) {
      gatewayConditions.push(eq(gatewayAuditEvents.traceId, input.trace_id));
    }
    if (input.session_id) {
      gatewayConditions.push(eq(gatewayAuditEvents.sessionId, input.session_id));
      // Config changes are tenant-level records, not chat-session records.
      // Restrict this IAM side of a session query to public-override rows so
      // a coincidentally equal tenant/session identifier cannot match them.
      iamConditions.push(eq(auditEvents.targetKind, ATTACHMENT_PUBLIC_OVERRIDE_TARGET_KIND));
      iamConditions.push(eq(auditEvents.targetId, input.session_id));
    }
    if (input.department_id) {
      gatewayConditions.push(eq(gatewayAuditEvents.departmentId, input.department_id));
      iamConditions.push(eq(users.tenantId, input.tenant_id));
      iamConditions.push(eq(users.deptId, input.department_id));
    }
    if (input.provider) {
      gatewayConditions.push(eq(gatewayAuditEvents.provider, input.provider));
    }
    if (input.model) {
      gatewayConditions.push(eq(gatewayAuditEvents.model, input.model));
    }
    if (input.policy_hit) {
      const pid = safePolicyId(input.policy_hit);
      if (pid) {
        const needle = JSON.stringify([{ policy_id: pid }]);
        gatewayConditions.push(
          sql`JSON_CONTAINS(${gatewayAuditEvents.policiesHit}, CAST(${needle} AS JSON))`,
        );
      }
    }
    if (input.cross_border === true) {
      gatewayConditions.push(eq(gatewayAuditEvents.crossBorder, true));
    }
    if (input.start) {
      const t = new Date(input.start);
      if (!Number.isNaN(t.getTime())) {
        gatewayConditions.push(gte(gatewayAuditEvents.eventTime, t));
      }
    }
    if (input.end) {
      const t = new Date(input.end);
      if (!Number.isNaN(t.getTime())) {
        gatewayConditions.push(lte(gatewayAuditEvents.eventTime, t));
      }
    }
    addIamDetailFilters(input, iamConditions);

    const whereClause = and(...gatewayConditions);
    const iamWhereClause = and(...iamConditions);
    const offset = Math.max(input.offset ?? 0, 0);
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 1000);
    const candidateLimit = offset + limit;
    const includeIam = iamFiltersAreCompatible(input);

    const gatewayCountPromise = db
      .select({ n: count() })
      .from(gatewayAuditEvents)
      .where(whereClause);
    const iamCountPromise = includeIam
      ? db
          .select({ n: count() })
          .from(auditEvents)
          .leftJoin(
            users,
            and(eq(users.id, auditEvents.actorUserId), eq(users.tenantId, auditEvents.tenantId)),
          )
          .where(iamWhereClause)
      : Promise.resolve([] as Array<{ n: number | string }>);
    const gatewayRowsPromise = db
      .select()
      .from(gatewayAuditEvents)
      .where(whereClause)
      .orderBy(desc(gatewayAuditEvents.eventTime), desc(gatewayAuditEvents.id))
      .limit(candidateLimit);
    const iamRowsPromise = includeIam
      ? db
          .select({
            audit: auditEvents,
            userEmail: users.email,
            departmentId: users.deptId,
          })
          .from(auditEvents)
          .leftJoin(
            users,
            and(eq(users.id, auditEvents.actorUserId), eq(users.tenantId, auditEvents.tenantId)),
          )
          .where(iamWhereClause)
          .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id))
          .limit(candidateLimit)
      : Promise.resolve([] as IamAuditJoinRow[]);

    const [[gatewayCountRow], [iamCountRow], gatewayRows, iamRows] = await Promise.all([
      gatewayCountPromise,
      iamCountPromise,
      gatewayRowsPromise,
      iamRowsPromise,
    ]);

    const candidates: MergedAuditCandidate[] = [
      ...gatewayRows.map((row) => ({ event: rowToAuditEvent(row), gatewayRow: row })),
      ...(includeIam ? iamRows.map((row) => ({ event: rowToIamAuditEvent(row) })) : []),
    ];
    const page = mergeAuditCandidates(candidates, offset, limit);
    const pageGatewayRows = page
      .filter((candidate): candidate is MergedAuditCandidate & { gatewayRow: typeof gatewayAuditEvents.$inferSelect } =>
        candidate.gatewayRow !== undefined,
      )
      .map((candidate) => candidate.gatewayRow);

    const ascRows = [...pageGatewayRows].sort((a, b) => {
      const ta = a.eventTime.getTime() - b.eventTime.getTime();
      if (ta !== 0) return ta;
      return a.id.localeCompare(b.id);
    });
    const items = page.map((candidate) => candidate.event);
    const chain = checkChainSlice(ascRows);

    return {
      total: Number(gatewayCountRow?.n ?? 0) + Number(iamCountRow?.n ?? 0),
      items,
      chain_valid: chain.valid,
      chain_error_at: chain.at,
      chain_error_reason: chain.reason,
      chain_verification: chain.legacyUnverified > 0 ? "partial" : "full",
      chain_verified_count: chain.verified,
      chain_legacy_unverified: chain.legacyUnverified,
    };
  }

  public async exportCsv(actor: AuditActor, input: AuditQueryInput): Promise<string> {
    const db = getAuditMysqlDb();
    const conditions = [eq(gatewayAuditEvents.tenantId, input.tenant_id)];

    const vis = visibilityPredicates(actor);
    if (vis) {
      conditions.push(vis);
    }

    await applyRetentionWindow(input.tenant_id, conditions);

    if (input.user_id) conditions.push(eq(gatewayAuditEvents.userId, input.user_id));
    if (input.trace_id) conditions.push(eq(gatewayAuditEvents.traceId, input.trace_id));
    if (input.session_id) conditions.push(eq(gatewayAuditEvents.sessionId, input.session_id));
    if (input.department_id) conditions.push(eq(gatewayAuditEvents.departmentId, input.department_id));
    if (input.provider) conditions.push(eq(gatewayAuditEvents.provider, input.provider));
    if (input.model) conditions.push(eq(gatewayAuditEvents.model, input.model));
    if (input.policy_hit) {
      const pid = safePolicyId(input.policy_hit);
      if (pid) {
        const needle = JSON.stringify([{ policy_id: pid }]);
        conditions.push(
          sql`JSON_CONTAINS(${gatewayAuditEvents.policiesHit}, CAST(${needle} AS JSON))`,
        );
      }
    }
    if (input.cross_border === true) {
      conditions.push(eq(gatewayAuditEvents.crossBorder, true));
    }
    if (input.start) {
      const t = new Date(input.start);
      if (!Number.isNaN(t.getTime())) conditions.push(gte(gatewayAuditEvents.eventTime, t));
    }
    if (input.end) {
      const t = new Date(input.end);
      if (!Number.isNaN(t.getTime())) conditions.push(lte(gatewayAuditEvents.eventTime, t));
    }

    const whereClause = and(...conditions);

    const [countRow] = await db
      .select({ n: count() })
      .from(gatewayAuditEvents)
      .where(whereClause);
    const total = Number(countRow?.n ?? 0);
    if (total > EXPORT_ROW_HARD_CAP) {
      throw new Error(
        `export exceeds hard cap (${EXPORT_ROW_HARD_CAP} rows); narrow filters or add a time range (total matching: ${total})`
      );
    }

    const header = [
      "id",
      "tenant_id",
      "event_time",
      "event_type",
      "user_id",
      "trace_id",
      "department_id",
      "provider",
      "model",
      "route",
      "src_region",
      "dst_region",
      "cross_border",
      "residency_rule",
      "total_tokens",
      "latency_ms",
      "checksum",
    ];

    const lines: string[] = [header.join(",")];
    const batch = 2000;
    for (let off = 0; off < total; off += batch) {
      const rows = await db
        .select()
        .from(gatewayAuditEvents)
        .where(whereClause)
        .orderBy(desc(gatewayAuditEvents.eventTime), desc(gatewayAuditEvents.id))
        .limit(batch)
        .offset(off);

      for (const row of rows) {
        const ev = rowToAuditEvent(row);
        const rowCsv = [
          ev.id,
          ev.tenant_id,
          ev.event_time,
          ev.event_type,
          ev.user_id ?? "",
          ev.trace_id ?? "",
          ev.department_id ?? "",
          ev.provider ?? "",
          ev.model ?? "",
          ev.route,
          ev.src_region ?? "",
          ev.dst_region ?? "",
          ev.cross_border ? "true" : "",
          ev.residency_rule ?? "",
          String(ev.total_tokens ?? 0),
          String(ev.latency_ms ?? 0),
          ev.checksum,
        ]
          .map((value) => `"${String(value).replace(/"/g, '""')}"`)
          .join(",");
        lines.push(rowCsv);
      }
    }

    return lines.join("\n");
  }
}

export type ChainVerifyResult = {
  valid: boolean;
  at?: string;
  reason?: string;
  scanned: number;
  verification: "full" | "partial";
  verified: number;
  legacy_unverified: number;
};

/** Full-table scan (batched) for one tenant; skips admin-console injected rows in chain math. */
export async function verifyMysqlGatewayAuditChain(
  actor: AuditActor,
  tenantId: string
): Promise<ChainVerifyResult> {
  const scopes = new Set(actor.scopes);
  const canVerify =
    scopes.has("*") || scopes.has("audit:manage") || scopes.has("audit:read:all");
  if (!canVerify) {
    return { valid: false, reason: "forbidden", scanned: 0, verification: "full", verified: 0, legacy_unverified: 0 };
  }
  if (actor.tenantId !== tenantId) {
    return { valid: false, reason: "tenant_mismatch", scanned: 0, verification: "full", verified: 0, legacy_unverified: 0 };
  }

  const db = getAuditMysqlDb();
  const batchSize = 5000;
  let offset = 0;
  let prev = "GENESIS";
  let index = 0;
  let scanned = 0;
  let verified = 0;
  let legacyUnverified = 0;

  while (true) {
    const rows = await db
      .select()
      .from(gatewayAuditEvents)
      .where(eq(gatewayAuditEvents.tenantId, tenantId))
      .orderBy(asc(gatewayAuditEvents.eventTime), asc(gatewayAuditEvents.id))
      .limit(batchSize)
      .offset(offset);

    if (rows.length === 0) break;

    for (const row of rows) {
      scanned += 1;
      if (row.clientType === "admin-console") {
        continue;
      }
      if (index === 0 && row.prevChecksum !== "GENESIS") {
        return {
          valid: false,
          at: row.id,
          reason: "unexpected_first_pointer",
          scanned,
          verification: legacyUnverified > 0 ? "partial" : "full",
          verified,
          legacy_unverified: legacyUnverified,
        };
      }
      if (index > 0 && row.prevChecksum !== prev) {
        return {
          valid: false,
          at: row.id,
          reason: "prev_checksum_mismatch",
          scanned,
          verification: legacyUnverified > 0 ? "partial" : "full",
          verified,
          legacy_unverified: legacyUnverified,
        };
      }
      const checksum = verifyPersistedChecksum(row);
      if (checksum.status === "invalid") {
        return {
          valid: false,
          at: row.id,
          reason: checksum.reason,
          scanned,
          verification: legacyUnverified > 0 ? "partial" : "full",
          verified,
          legacy_unverified: legacyUnverified,
        };
      }
      if (checksum.status === "legacy") legacyUnverified += 1;
      else verified += 1;
      prev = row.checksum;
      index += 1;
    }

    offset += batchSize;
  }

  return {
    valid: true,
    scanned,
    verification: legacyUnverified > 0 ? "partial" : "full",
    verified,
    legacy_unverified: legacyUnverified,
  };
}

export async function insertMysqlGatewayAuditExportEvent(
  actor: AuditActor,
  detail: Record<string, unknown>
): Promise<void> {
  const db = getAuditMysqlDb();
  const now = new Date();
  await db.insert(gatewayAuditEvents).values({
    id: ulid(),
    tenantId: actor.tenantId,
    eventTime: now,
    eventType: "audit_export",
    userId: actor.userId,
    departmentId: actor.deptId ?? null,
    sessionId: null,
    clientType: "admin-console",
    clientIp: null,
    provider: null,
    model: null,
    route: "local",
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    latencyMs: null,
    digest: {
      ...detail,
      exported_by: actor.userId,
    },
    policiesHit: null,
    toolsCalled: null,
    prevChecksum: "admin-export",
    checksum: "admin-export",
    signature: null,
    createdAt: now,
    updatedAt: now,
  });
}
