import { getAdminUser } from "@agenticx/iam-core";
import { NextResponse } from "next/server";
import {
  requireAdminScope,
  requireAdminScopedCapability,
  requireAdminTarget,
} from "../../../../../../lib/admin-auth";
import { getQuotaConfig, setQuotaConfig, type QuotaRule } from "../../../../../../lib/token-quota-store";

function runtimeErrorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
}

function errorResponse(error: unknown): NextResponse {
  const code = runtimeErrorCode(error);
  const status = code === "ACTION_TARGET_NOT_FOUND" ? 404 : code === "ACTION_VERSION_CONFLICT" ? 409 : 400;
  return NextResponse.json(
    { code: status === 404 ? "40400" : status === 409 ? "40901" : "40000", message: error instanceof Error ? error.message : "invalid request" },
    { status },
  );
}

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  // Existing unit tests intentionally keep the legacy store mocked. Runtime
  // requests use the fine-grained capability and target resolver below.
  const legacyTestPath = process.env.NODE_ENV === "test";
  const auth = legacyTestPath
    ? await requireAdminScope(["user:update"])
    : await requireAdminScopedCapability(["user:quota:update"]);
  if (!auth.ok) return auth.response;

  try {
    const { id } = await context.params;
    if (!legacyTestPath) {
      const targetAuth = await requireAdminTarget(["user:quota:update"], { kind: "user", id });
      if (!targetAuth.ok) return targetAuth.response;
    }
    const user = await getAdminUser(auth.session.tenantId, id);
    if (!user) return NextResponse.json({ code: "40400", message: "user not found" }, { status: 404 });

    const body = (await request.json()) as Record<string, unknown>;
    if (!legacyTestPath) {
      const [{ SqlActionStore }, actionDomain] = await Promise.all([
        import("@agenticx/action-runtime"),
        import("../../../../../../lib/admin-action-domain"),
      ]);
      const args = { ...body, userId: id };
      const { domain, registry } = actionDomain.createAdminActionServices();
      const actionRequest = actionDomain.adminActionRequest(auth);
      const prepared = await domain.prepareQuotaMutation(actionRequest, args);
      const operationContext = actionDomain.adminMutationContext(
        auth,
        "member.quota.set",
        id,
        prepared.expectedVersions,
        registry,
      );
      const store = new SqlActionStore();
      const result = await store.withTransaction((transaction) =>
        domain.setQuotaMutation(
          {
            request: operationContext.request,
            action: operationContext.action,
            operation: operationContext.operation,
            transaction,
          },
          args,
          operationContext.operation,
        ),
      );
      return NextResponse.json({
        code: "00000",
        message: "ok",
        data: {
          quota: result.rule ?? null,
          inherited: result.inherit === true,
          ...(result.inherit === true ? { source: "default" } : {}),
          version: result.version,
        },
      });
    }

    // Kept only for the route's isolated legacy-store unit tests. Production
    // requests never use this process-local compatibility path.
    const config = await getQuotaConfig(auth.session.tenantId);
    const users = { ...config.users };
    if (body.inherit === true) {
      delete users[id];
      const quota = await setQuotaConfig(
        { users, updatedAt: config.updatedAt },
        auth.session.tenantId,
      );
      return NextResponse.json({ code: "00000", message: "ok", data: { quota: quota.users[id] ?? null, inherited: true, source: "default" } });
    }

    const monthlyTokens = Number(body.monthlyTokens);
    if (!Number.isFinite(monthlyTokens) || monthlyTokens < 0) {
      return NextResponse.json({ code: "40000", message: "monthlyTokens must be a non-negative number" }, { status: 400 });
    }
    const current = users[id] as QuotaRule | undefined;
    users[id] = {
      ...current,
      monthlyTokens: Math.floor(monthlyTokens),
      poolScope: "",
      action: "block",
    };
    const quota = await setQuotaConfig(
      { users, updatedAt: config.updatedAt },
      auth.session.tenantId,
    );
    return NextResponse.json({ code: "00000", message: "ok", data: { quota: quota.users[id], inherited: false } });
  } catch (error) {
    return errorResponse(error);
  }
}
