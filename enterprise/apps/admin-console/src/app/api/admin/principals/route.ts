import {
  createAgentPrincipal,
  hasEveryScope,
  hasSomeScope,
  listPrincipals,
  listRoles,
  type PrincipalDto,
} from "@agenticx/iam-core";
import type { AgentMode, PrincipalStatus } from "@agenticx/iam-core";
import { NextResponse } from "next/server";
import {
  requireAdminScopedCapability,
  requireAdminSomeScopedCapability,
  requireAdminTarget,
  resolveAdminAgentVisibility,
  resolveAdminUserVisibility,
} from "../../../../lib/admin-auth";
import { errorEnvelope, errorStatus } from "../iam/authorization";

type PrincipalKind = "user" | "agent";

function isPrincipalKind(value: string | null): value is PrincipalKind {
  return value === "user" || value === "agent";
}

function isPrincipalStatus(value: unknown): value is PrincipalStatus {
  return value === "active" || value === "disabled";
}

export async function GET(request: Request) {
  const auth = await requireAdminSomeScopedCapability(["user:read", "agent:read"]);
  if (!auth.ok) return auth.response;

  const { searchParams } = new URL(request.url);
  const kindParam = searchParams.get("kind");
  const statusParam = searchParams.get("status");
  if (kindParam && !isPrincipalKind(kindParam)) {
    return NextResponse.json({ code: "40000", message: "invalid principal kind" }, { status: 400 });
  }
  try {
    const canReadUsers = hasSomeScope(auth.scopes, ["user:read"]);
    const canReadAgents = hasSomeScope(auth.scopes, ["agent:read"]);
    if (kindParam === "user" && !canReadUsers) {
      return NextResponse.json({ code: "40300", message: "forbidden" }, { status: 403 });
    }
    if (kindParam === "agent" && !canReadAgents) {
      return NextResponse.json({ code: "40300", message: "forbidden" }, { status: 403 });
    }
    if (!canReadUsers && !canReadAgents) {
      return NextResponse.json({ code: "40300", message: "forbidden" }, { status: 403 });
    }
    const userVisibility = canReadUsers
      ? await resolveAdminUserVisibility(auth.session.tenantId, auth.context)
      : undefined;
    const agentVisibility = canReadAgents
      ? await resolveAdminAgentVisibility(auth.session.tenantId, auth.context)
      : undefined;
    const principalLists: PrincipalDto[][] = [];
    if (canReadUsers && (!kindParam || kindParam === "user")) {
      principalLists.push(await listPrincipals(auth.session.tenantId, {
        kind: "user",
        userIds: userVisibility?.tenantWide ? undefined : userVisibility?.userIds,
        userDepartmentIds: userVisibility?.tenantWide ? undefined : userVisibility?.departmentIds,
      }));
    }
    if (canReadAgents && (!kindParam || kindParam === "agent")) {
      principalLists.push(await listPrincipals(auth.session.tenantId, {
        kind: "agent",
        agentOwnerUserIds: agentVisibility?.tenantWide ? undefined : agentVisibility?.ownerUserIds,
        agentOwnerDepartmentIds: agentVisibility?.tenantWide ? undefined : agentVisibility?.ownerDepartmentIds,
      }));
    }
    const allPrincipals = principalLists.flat();
    const query = searchParams.get("q")?.trim().toLocaleLowerCase() || "";
    const userId = searchParams.get("userId")?.trim() || "";
    const principals = allPrincipals.filter((principal) => {
      if (isPrincipalKind(kindParam) && principal.kind !== kindParam) return false;
      if (isPrincipalStatus(statusParam) && principal.status !== statusParam) return false;
      if (userId && principal.userId !== userId) return false;
      if (query && ![principal.displayName ?? "", principal.userId ?? "", principal.agentProfile?.definitionRef ?? ""].join(" ").toLocaleLowerCase().includes(query)) return false;
      return true;
    });
    const offset = parseNonNegativeInt(searchParams.get("offset"), 0);
    const limit = parsePositiveInt(searchParams.get("limit"), 100);
    // A principal collection is used by the directory and Agent picker.  Keep
    // the role catalogue out of it unless the caller can actually assign a
    // role; role:read still unlocks metadata on one explicitly selected
    // principal through the detail endpoint.
    const canAssign = hasSomeScope(auth.scopes, ["role:assign"]);
    const allRoles = canAssign ? await listRoles(auth.session.tenantId) : undefined;
    const grantableRoles = allRoles?.filter((role) => role.scopes.length === 0 || hasEveryScope(auth.scopes, role.scopes));
    const canCreate = hasSomeScope(auth.scopes, ["agent:create"]);
    const canEdit = hasSomeScope(auth.scopes, ["agent:update"]);
    return NextResponse.json({ code: "00000", message: "ok", data: {
      items: principals.slice(offset, offset + limit),
      total: principals.length,
      grantableRoles,
      // Data-scope choices are returned by the binding endpoint after it has
      // resolved one concrete principal.  A principal collection must not
      // expose an actor's raw capability list as if it were grantable range.
      grantableScopes: canAssign ? [] : undefined,
      permissions: { canAssign, canCreate, canEdit },
    } });
  } catch (error) {
    return NextResponse.json(errorEnvelope(error), { status: errorStatus(error) });
  }
}

export async function POST(request: Request) {
  const auth = await requireAdminScopedCapability(["agent:create"]);
  if (!auth.ok) return auth.response;

  try {
    const body = (await request.json()) as Record<string, unknown>;
    const kind = body.kind;
    if (kind !== "agent") {
      return NextResponse.json({ code: "40000", message: "only enterprise agents can be registered here" }, { status: 400 });
    }
    const displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";
    if (!displayName) {
      return NextResponse.json({ code: "40000", message: "displayName is required" }, { status: 400 });
    }
    const mode: AgentMode = body.mode === "delegated" || body.mode === "service" ? body.mode : "service";
    const ownerUserId = typeof body.ownerUserId === "string" ? body.ownerUserId.trim() || null : null;
    const input = {
      tenantId: auth.session.tenantId,
      displayName,
      mode,
      ownerUserId,
      definitionRef: typeof body.definitionRef === "string" ? body.definitionRef.trim() || null : null,
      definitionVersion: typeof body.definitionVersion === "number" && Number.isInteger(body.definitionVersion)
        ? body.definitionVersion
        : undefined,
      actorUserId: auth.session.userId,
    };
    const target = ownerUserId
      ? { kind: "user", id: ownerUserId }
      : { kind: "tenant", id: auth.session.tenantId };
    const targetAuth = await requireAdminTarget(["agent:create"], target);
    if (!targetAuth.ok) return targetAuth.response;
    const principal = await createAgentPrincipal(input);
    return NextResponse.json({ code: "00000", message: "ok", data: { principal } });
  } catch (error) {
    return NextResponse.json(errorEnvelope(error), { status: errorStatus(error) });
  }
}

function parsePositiveInt(value: string | null, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 500) : fallback;
}

function parseNonNegativeInt(value: string | null, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}
