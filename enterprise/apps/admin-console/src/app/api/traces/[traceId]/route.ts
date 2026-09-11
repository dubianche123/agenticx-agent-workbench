import { NextResponse } from "next/server";
import type { AuditEvent } from "@agenticx/core-api";
import { buildAuditActor, queryAudit } from "../../../../lib/audit-service";
import { requireAdminSomeScope } from "../../../../lib/admin-auth";
import { getAgentTraceSpansByTenant } from "../../../../lib/agent-trace-by-tenant";
import { getDeepResearchRunByTrace } from "../../../../lib/deep-research-trace-query";
import { queryPortalLogs } from "../../../../lib/portal-logs-query";
import { assembleTraceTimeline } from "../../../../lib/trace-timeline";

// A full trace joins Portal logs, model metering spans, deep-research state,
// and (when available) audit rows. `audit:read` / `audit:read:dept` alone are
// deliberately not sufficient because those scopes do not authorize the
// tenant-wide runtime stores used by this endpoint.
const TRACE_DETAIL_SCOPES = ["audit:read:all", "audit:manage", "metering:read"];
const AUDIT_ROW_SCOPES = ["audit:read", "audit:read:all", "audit:read:dept", "audit:manage"];

function hasScope(scopes: string[], allowed: string[]): boolean {
  return scopes.some((scope) => scope === "*" || allowed.includes(scope));
}

/** 26-char Crockford Base32 ULID (aligned with portal/sdk-ts isTraceId). */
function isTraceId(value: string): boolean {
  return /^[0-9A-HJKMNP-TV-Z]{26}$/.test(value);
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ traceId: string }> },
) {
  const guard = await requireAdminSomeScope(TRACE_DETAIL_SCOPES);
  if (!guard.ok) {
    return guard.response;
  }
  // Keep the authorization decision local as well as in the shared guard.
  // This is defense in depth for auth adapters and prevents an audit-only
  // visibility result from becoming a runtime-trace capability.
  if (!hasScope(guard.scopes, TRACE_DETAIL_SCOPES)) {
    return NextResponse.json({ code: "40300", message: "forbidden" }, { status: 403 });
  }

  const { traceId: raw } = await context.params;
  const traceId = raw?.trim() ?? "";
  if (!isTraceId(traceId)) {
    return NextResponse.json({ code: "40001", message: "invalid trace_id" }, { status: 400 });
  }

  const tenantId = guard.session.tenantId;

  try {
    // Audit rows retain their own audit-scope visibility. They are supplemental
    // to the full trace and never serve as an authorization gate for runtime
    // data. A metering-only operator therefore receives no audit rows here.
    let auditEvents: AuditEvent[] = [];
    if (hasScope(guard.scopes, AUDIT_ROW_SCOPES)) {
      const actor = await buildAuditActor(guard.session, guard.scopes);
      const auditResult = await queryAudit(actor, {
        tenant_id: tenantId,
        trace_id: traceId,
        limit: 100,
        offset: 0,
      });
      auditEvents = (auditResult.data?.items ?? []).filter(
        (event) => event.tenant_id === tenantId && event.trace_id === traceId,
      );
    }

    const [portalResult, modelSpansResult, deepResearchResult] = await Promise.allSettled([
      queryPortalLogs({
        tenant_id: tenantId,
        trace_id: traceId,
        limit: 100,
        offset: 0,
      }),
      getAgentTraceSpansByTenant(tenantId, traceId),
      getDeepResearchRunByTrace(tenantId, traceId),
    ]);

    // Portal request logging is an optional sink. Keep audit/model failures
    // fatal, but let a broken Portal store degrade to the persisted sources.
    if (modelSpansResult.status === "rejected") throw modelSpansResult.reason;
    if (deepResearchResult.status === "rejected") throw deepResearchResult.reason;
    const portalLogsAvailable = portalResult.status === "fulfilled";

    const data = assembleTraceTimeline({
      traceId,
      portalLogs: portalLogsAvailable
        ? portalResult.value.items.filter(
            (item) => item.tenant_id === tenantId && item.trace_id === traceId,
          )
        : [],
      ...(portalLogsAvailable ? {} : { portalLogsAvailable: false }),
      modelSpans: modelSpansResult.value,
      deepResearchRun: deepResearchResult.value,
      auditEvents,
    });

    return NextResponse.json({ code: "00000", message: "ok", data });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ code: "50002", message, data: undefined }, { status: 500 });
  }
}
