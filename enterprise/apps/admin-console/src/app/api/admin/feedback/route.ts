import { NextResponse } from "next/server";

import { buildAuditActor } from "../../../../lib/audit-service";
import { requireAdminSomeScope } from "../../../../lib/admin-auth";
import { queryAdminFeedback, type FeedbackKind, type FeedbackSource } from "../../../../lib/feedback-query";

// Feedback is an authenticated, database-backed endpoint. Never let Next try to
// execute it while collecting static page data (which would require DATABASE_URL
// during `next build`).
export const dynamic = "force-dynamic";

const MAX_FILTER_LENGTH = 160;
const VALID_FEEDBACK_SOURCES = ["web", "desktop"] as const;

function parseDate(value: string | null): Date | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function boundedInteger(value: string | null, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

export async function GET(request: Request) {
  const guard = await requireAdminSomeScope(["audit:read:all", "audit:read:dept", "audit:manage"]);
  if (!guard.ok) return guard.response;

  const url = new URL(request.url);
  const feedbackType = url.searchParams.get("feedback_type");
  if (feedbackType && feedbackType !== "like" && feedbackType !== "dislike") {
    return NextResponse.json({ code: "40001", message: "invalid feedback_type" }, { status: 400 });
  }
  const source = url.searchParams.get("source")?.trim() || undefined;
  if (source && !VALID_FEEDBACK_SOURCES.includes(source as FeedbackSource)) {
    return NextResponse.json({ code: "40001", message: "invalid source" }, { status: 400 });
  }
  const model = url.searchParams.get("model")?.trim() || undefined;
  if (model && model.length > MAX_FILTER_LENGTH) {
    return NextResponse.json({ code: "40001", message: "model filter is too long" }, { status: 400 });
  }
  const provider = url.searchParams.get("provider")?.trim() || undefined;
  if (provider && provider.length > 128) {
    return NextResponse.json({ code: "40001", message: "provider filter is too long" }, { status: 400 });
  }
  const rawStart = url.searchParams.get("start");
  const rawEnd = url.searchParams.get("end");
  const start = parseDate(rawStart);
  const end = parseDate(rawEnd);
  if ((rawStart && !start) || (rawEnd && !end) || (start && end && start > end)) {
    return NextResponse.json({ code: "40001", message: "invalid date range" }, { status: 400 });
  }

  const requestedDepartment = url.searchParams.get("department_id")?.trim() || undefined;
  if (requestedDepartment && requestedDepartment.length > 26) {
    return NextResponse.json({ code: "40001", message: "invalid department_id" }, { status: 400 });
  }

  try {
    const actor = await buildAuditActor(guard.session, guard.scopes);
    const canReadAll = guard.scopes.includes("audit:read:all") || guard.scopes.includes("audit:manage");
    if (!canReadAll && !actor.deptId) {
      return NextResponse.json(
        { code: "40301", message: "department-scoped feedback requires an assigned department" },
        { status: 403 },
      );
    }

    const data = await queryAdminFeedback({
      tenantId: guard.session.tenantId,
      departmentId: canReadAll ? requestedDepartment : actor.deptId ?? undefined,
      feedbackType: feedbackType as FeedbackKind | undefined,
      source: source as FeedbackSource | undefined,
      model,
      provider,
      start,
      end,
      limit: boundedInteger(url.searchParams.get("limit"), 30, 1, 100),
      offset: boundedInteger(url.searchParams.get("offset"), 0, 0, 100_000),
      detailsVisible: canReadAll,
    });
    return NextResponse.json({
      code: "00000",
      message: "ok",
      data: {
        ...data,
        visibility: canReadAll ? "tenant" : "department",
        details_visible: canReadAll,
        department_id: canReadAll ? requestedDepartment ?? null : actor.deptId,
      },
    });
  } catch {
    return NextResponse.json(
      { code: "50002", message: "反馈查询暂时不可用" },
      { status: 500 },
    );
  }
}
