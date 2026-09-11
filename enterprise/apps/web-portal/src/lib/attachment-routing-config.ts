/** 租户级附件自动路由行为。模型候选仍由 provider 配置决定，成员例外权仍由能力包决定。 */

import { enterpriseRuntimeAttachmentRouting as pgTable } from "@agenticx/db-schema";
import { enterpriseRuntimeAttachmentRouting as mysqlTable } from "@agenticx/db-schema/mysql";
import { createMysqlDb, getIamDb, resolveDatabaseConfig } from "@agenticx/iam-core";
import { eq } from "drizzle-orm";

export type AttachmentRoutingTenantConfig = {
  /** false = 命中文档后强制私有路由；true = 授权成员可以明确选择公网模型。 */
  allowPublicOverride: boolean;
};

export const DEFAULT_ATTACHMENT_ROUTING_TENANT_CONFIG: AttachmentRoutingTenantConfig = {
  allowPublicOverride: false,
};

function normalizeConfig(row: { allowPublicOverride?: unknown } | null | undefined) {
  return {
    allowPublicOverride:
      row?.allowPublicOverride === true || row?.allowPublicOverride === 1,
  } satisfies AttachmentRoutingTenantConfig;
}

export async function getAttachmentRoutingTenantConfig(
  tenantId: string,
): Promise<AttachmentRoutingTenantConfig> {
  const normalizedTenantId = tenantId.trim();
  if (!normalizedTenantId) throw new Error("tenant id is required");
  const config = resolveDatabaseConfig();
  if (config.dialect === "mysql") {
    const db = (await createMysqlDb(config)).raw;
    const rows = await db
      .select({ allowPublicOverride: mysqlTable.allowPublicOverride })
      .from(mysqlTable)
      .where(eq(mysqlTable.tenantId, normalizedTenantId))
      .limit(1);
    return normalizeConfig(rows[0]);
  }
  const rows = await getIamDb()
    .select({ allowPublicOverride: pgTable.allowPublicOverride })
    .from(pgTable)
    .where(eq(pgTable.tenantId, normalizedTenantId))
    .limit(1);
  return normalizeConfig(rows[0]);
}

export async function setAttachmentRoutingTenantConfig(
  tenantId: string,
  input: AttachmentRoutingTenantConfig,
): Promise<AttachmentRoutingTenantConfig> {
  const normalizedTenantId = tenantId.trim();
  if (!normalizedTenantId) throw new Error("tenant id is required");
  const allowPublicOverride = input.allowPublicOverride === true;
  const updatedAt = new Date();
  const config = resolveDatabaseConfig();
  if (config.dialect === "mysql") {
    const db = (await createMysqlDb(config)).raw;
    await db
      .insert(mysqlTable)
      .values({ tenantId: normalizedTenantId, allowPublicOverride, updatedAt })
      .onDuplicateKeyUpdate({ set: { allowPublicOverride, updatedAt } });
  } else {
    await getIamDb()
      .insert(pgTable)
      .values({ tenantId: normalizedTenantId, allowPublicOverride, updatedAt })
      .onConflictDoUpdate({
        target: pgTable.tenantId,
        set: { allowPublicOverride, updatedAt },
      });
  }
  return { allowPublicOverride };
}
