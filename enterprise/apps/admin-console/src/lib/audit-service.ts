import {
  AuditApi,
  type AuditActor,
  type AuditQueryInput,
  createAuditStore,
  insertGatewayAuditExportEvent,
  verifyGatewayAuditChain,
} from "@agenticx/feature-audit";
import { getUsersRepository } from "@agenticx/iam-core";
import type { AdminSession } from "./admin-auth";

// Do not resolve the database or create an audit store while Next is importing
// route modules during `next build`. The first authenticated operation is the
// earliest point at which the runtime configuration is needed.
let api: AuditApi | null = null;

function getAuditApi(): AuditApi {
  return (api ??= new AuditApi(createAuditStore()));
}

export async function buildAuditActor(session: AdminSession, scopes: string[]): Promise<AuditActor> {
  const user = await getUsersRepository().getAdminUser(session.tenantId, session.userId);
  return {
    tenantId: session.tenantId,
    userId: session.userId,
    deptId: user?.deptId ?? null,
    scopes,
  };
}

export async function queryAudit(actor: AuditActor, input: AuditQueryInput) {
  return getAuditApi().query(actor, input);
}

export async function exportAuditCsv(actor: AuditActor, input: AuditQueryInput) {
  return getAuditApi().exportCsv(actor, input);
}

export { insertGatewayAuditExportEvent, verifyGatewayAuditChain };
export type { AuditActor };
