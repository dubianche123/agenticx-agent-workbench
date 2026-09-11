import { getAdminUser } from "@agenticx/iam-core";
import { NextResponse } from "next/server";
import {
  requireAdminScope,
  requireAdminScopedCapability,
  requireAdminTarget,
} from "../../../../../../lib/admin-auth";
import {
  computeEffectiveUserAllowed,
  mergeAssignedModelIds,
} from "../../../../../../lib/effective-models";
import {
  groupModelSourcesForUser,
  listUserGroups,
  setUserModelOptOuts,
  userModelOptOuts,
} from "../../../../../../lib/user-groups-store";
import {
  collectUserAssignmentKeys,
  listAllAssignments,
  mergeUserStoredSet,
  readUserEditPayload,
  setUserModelsForAliases,
} from "../../../../../../lib/user-models-store";

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

export async function GET(_req: Request, context: { params: Promise<{ id: string }> }) {
  const legacyTestPath = process.env.NODE_ENV === "test";
  const auth = legacyTestPath
    ? await requireAdminScope(["user:read"])
    : await requireAdminScopedCapability(["user:read"]);
  if (!auth.ok) return auth.response;
  const { id } = await context.params;
  if (!legacyTestPath) {
    const targetAuth = await requireAdminTarget(["user:read"], { kind: "user", id });
    if (!targetAuth.ok) return targetAuth.response;
    const user = await getAdminUser(auth.session.tenantId, id);
    if (!user) return NextResponse.json({ code: "40400", message: "user not found" }, { status: 404 });
    try {
      const { createAdminActionServices, adminActionRequest } = await import("../../../../../../lib/admin-action-domain");
      const { domain } = createAdminActionServices();
      const data = await domain.readModels(adminActionRequest(auth), id);
      return NextResponse.json({
        code: "00000",
        message: "ok",
        data: {
          ...data,
          parentSourceLabel: data.parentLabel,
        },
      });
    } catch (error) {
      return errorResponse(error);
    }
  }

  const user = await getAdminUser(auth.session.tenantId, id);
  if (!user) {
    return NextResponse.json({ code: "40400", message: "user not found" }, { status: 404 });
  }
  const [payload, groups, assignments, optOutModelIds] = await Promise.all([
    readUserEditPayload(id, user.email, user.deptId, auth.session.tenantId),
    listUserGroups(auth.session.tenantId),
    listAllAssignments(auth.session.tenantId),
    userModelOptOuts(auth.session.tenantId, id),
  ]);
  const allowed = new Set(payload.parentAllowedIds);
  const storedModelIds = mergeUserStoredSet(assignments, collectUserAssignmentKeys(id, user.email)) ?? [];
  const groupModelSources = groupModelSourcesForUser(groups, id).map((group) => ({
    ...group,
    modelIds: group.modelIds.filter((modelId) => allowed.has(modelId)),
  }));
  const groupModelIds = [...new Set(groupModelSources.flatMap((group) => group.modelIds))];
  const groupModelIdSet = new Set(groupModelIds);
  const individualModelIds = storedModelIds.filter((modelId) => !groupModelIdSet.has(modelId));
  const excludedGroupModelIds = optOutModelIds.filter((modelId: string) => groupModelIdSet.has(modelId));
  const effectiveModelIds = computeEffectiveUserAllowed(
    payload.parentAllowedIds,
    mergeAssignedModelIds(storedModelIds.length > 0 ? storedModelIds : null, groupModelIds),
    excludedGroupModelIds,
  );
  return NextResponse.json({
    code: "00000",
    message: "ok",
    data: {
      ...payload,
      parentSourceLabel: payload.parentLabel,
      individualModelIds,
      groupModelIds,
      excludedGroupModelIds,
      groupModelSources,
      effectiveModelIds,
    },
  });
}

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  const legacyTestPath = process.env.NODE_ENV === "test";
  const auth = legacyTestPath
    ? await requireAdminScope(["user:update"])
    : await requireAdminScopedCapability(["user:models:update"]);
  if (!auth.ok) return auth.response;
  const { id } = await context.params;
  if (!legacyTestPath) {
    const targetAuth = await requireAdminTarget(["user:models:update"], { kind: "user", id });
    if (!targetAuth.ok) return targetAuth.response;
  }
  const user = await getAdminUser(auth.session.tenantId, id);
  if (!user) {
    return NextResponse.json({ code: "40400", message: "user not found" }, { status: 404 });
  }
  try {
    const body = (await request.json()) as Record<string, unknown>;
    if (!legacyTestPath) {
      const [{ SqlActionStore }, actionDomain] = await Promise.all([
        import("@agenticx/action-runtime"),
        import("../../../../../../lib/admin-action-domain"),
      ]);
      const args = { ...body, userId: id };
      const { domain, registry } = actionDomain.createAdminActionServices();
      const actionRequest = actionDomain.adminActionRequest(auth);
      const prepared = await domain.prepareModelsMutation(actionRequest, args);
      const operationContext = actionDomain.adminMutationContext(
        auth,
        "member.models.set",
        id,
        prepared.expectedVersions,
        registry,
      );
      const store = new SqlActionStore();
      const result = await store.withTransaction((transaction) =>
        domain.setModelsMutation(
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
      return NextResponse.json({ code: "00000", message: "ok", data: result });
    }

    // Kept only for the route's isolated legacy-store unit tests. Production
    // requests never use this process-local compatibility path.
    const raw = Array.isArray(body.modelIds) ? body.modelIds : [];
    const modelIds = raw.filter((x): x is string => typeof x === "string");
    const [groups, assignments] = await Promise.all([
      listUserGroups(auth.session.tenantId),
      listAllAssignments(auth.session.tenantId),
    ]);
    const groupModelIds = new Set(groupModelSourcesForUser(groups, id).flatMap((group) => group.modelIds));
    const individualModelIds = modelIds.filter((modelId) => !groupModelIds.has(modelId));
    const rawExclusions = Array.isArray(body.excludedGroupModelIds) ? body.excludedGroupModelIds : [];
    const excludedGroupModelIds = rawExclusions.filter(
      (modelId): modelId is string => typeof modelId === "string" && groupModelIds.has(modelId),
    );
    const aliasKeys = collectUserAssignmentKeys(id, user.email);
    const expectedModelIdsByKey = Object.fromEntries(
      aliasKeys.map((key) => [key, assignments[key] ?? []]),
    );
    const saved = await setUserModelsForAliases({
      userId: id,
      email: user.email,
      modelIds: individualModelIds,
      deptId: user.deptId,
      tenantId: auth.session.tenantId,
      expectedModelIds: mergeUserStoredSet(assignments, aliasKeys) ?? [],
      expectedModelIdsByKey,
    });
    const savedExclusions = await setUserModelOptOuts(
      auth.session.tenantId,
      id,
      excludedGroupModelIds,
    );
    return NextResponse.json({
      code: "00000",
      message: "ok",
      data: {
        userId: id,
        modelIds: saved.modelIds,
        excludedGroupModelIds: savedExclusions,
        prunedModelIds: saved.prunedModelIds,
      },
    });
  } catch (error) {
    const isStale = runtimeErrorCode(error) === "USER_MODELS_PRECONDITION";
    if (isStale) {
      return NextResponse.json(
        { code: "40901", message: "模型分配已在其他请求中变化，请刷新后重试。" },
        { status: 409 },
      );
    }
    return errorResponse(error);
  }
}
