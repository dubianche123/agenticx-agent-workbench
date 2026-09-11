/**
 * admin-console · capability shelf order persistence (PostgreSQL)
 *
 * The order is presentation metadata only. Capability ids are therefore intentionally not
 * foreign-keyed to the polymorphic capability sources; built-in ids remain forward-compatible,
 * while portable expert/group/market-Skill ids are checked against the tenant's published market entries.
 */

import {
  enterpriseCapabilityShelfOrder,
  enterpriseConfigMarketItems,
  tenants,
} from "@agenticx/db-schema";
import { parseCapabilityId } from "@agenticx/config";
import { getIamDb } from "@agenticx/iam-core";
import { and, asc, eq, inArray, sql } from "drizzle-orm";

import {
  CapabilityShelfMembershipValidationError,
  MAX_CAPABILITY_SHELF_ITEMS,
  normalizeCapabilityShelfOrder,
  type CapabilityShelfOrderValidationError,
} from "../../capability-shelf-order-contract";

export type CapabilityShelfOrderMutation = {
  previousCapabilityIds: string[];
  orderedCapabilityIds: string[];
};

export type CapabilityShelfMembershipMutation = CapabilityShelfOrderMutation & {
  capabilityId: string;
};

function requireTenantId(input: string): string {
  const tenantId = String(input ?? "").trim();
  if (!tenantId) throw new Error("tenantId is required for capability shelf order persistence.");
  return tenantId;
}

function requirePortableCapabilityId(input: string): string {
  const [capabilityId] = normalizeCapabilityShelfOrder([input]);
  const parsed = capabilityId ? parseCapabilityId(capabilityId) : null;
  if (!capabilityId || (parsed?.kind !== "expert" && parsed?.kind !== "group" && parsed?.kind !== "skill")) {
    throw new CapabilityShelfMembershipValidationError(
      "only a published market expert, group, or Skill can be added to or removed from the capability shelf",
    );
  }
  return capabilityId;
}

async function lockTenant(tx: any, tenantId: string): Promise<void> {
  await tx.execute(
    sql`select ${tenants.id} from ${tenants} where ${tenants.id} = ${tenantId} for update`,
  );
}

async function assertPublishedPortableItems(
  tx: any,
  tenantId: string,
  capabilityIds: readonly string[],
  options: { allowLegacySkills?: boolean; existingCapabilityIds?: ReadonlySet<string> } = {},
): Promise<void> {
  const portable = capabilityIds
    .map((capabilityId) => {
      const parsed = parseCapabilityId(capabilityId);
      return parsed?.kind === "expert" || parsed?.kind === "group" || parsed?.kind === "skill"
        ? { capabilityId, kind: parsed.kind, id: parsed.rowId }
        : null;
    })
    .filter((entry): entry is { capabilityId: string; kind: "expert" | "group" | "skill"; id: string } => entry !== null);
  if (portable.length === 0) return;

  const rows = await tx
    .select({
      id: enterpriseConfigMarketItems.id,
      kind: enterpriseConfigMarketItems.kind,
      status: enterpriseConfigMarketItems.status,
      deliveryState: enterpriseConfigMarketItems.deliveryState,
    })
    .from(enterpriseConfigMarketItems)
    .where(
      and(
        eq(enterpriseConfigMarketItems.tenantId, tenantId),
        inArray(enterpriseConfigMarketItems.id, portable.map((entry) => entry.id)),
      ),
    );
  const valid = new Set(
    (rows as Array<{ id: string; kind: string; status: string; deliveryState?: string | null }>)
      .filter((row) => row.status === "published" && (row.deliveryState ?? "active") === "active")
      .map((row) => `${row.kind}:${row.id.toUpperCase()}`),
  );
  const marketSkillIds = new Set(
    (rows as Array<{ id: string; kind: string }>).filter((row) => row.kind === "skill")
      .map((row) => row.id.toUpperCase()),
  );
  const missing = portable
    .filter((entry) => !options.existingCapabilityIds?.has(entry.capabilityId))
    .filter((entry) =>
      entry.kind !== "skill" ||
      !options.allowLegacySkills ||
      marketSkillIds.has(entry.id.toUpperCase()),
    )
    .filter((entry) => !valid.has(entry.capabilityId))
    .map((entry) => entry.capabilityId);
  if (missing.length > 0) {
    throw new CapabilityShelfMembershipValidationError(
      `portable capability is missing, unlisted, delivery-revoked, or belongs to another tenant: ${missing.join(", ")}`,
    );
  }
}

export async function getCapabilityShelfOrder(tenantIdInput: string): Promise<string[]> {
  const tenantId = requireTenantId(tenantIdInput);
  const db = getIamDb();
  const rows = await db
    .select({ capabilityId: enterpriseCapabilityShelfOrder.capabilityId })
    .from(enterpriseCapabilityShelfOrder)
    .where(eq(enterpriseCapabilityShelfOrder.tenantId, tenantId))
    .orderBy(
      asc(enterpriseCapabilityShelfOrder.position),
      asc(enterpriseCapabilityShelfOrder.capabilityId),
    );
  return rows.map((row) => row.capabilityId);
}

export async function replaceCapabilityShelfOrder(
  tenantIdInput: string,
  capabilityIds: readonly string[],
): Promise<CapabilityShelfOrderMutation> {
  const tenantId = requireTenantId(tenantIdInput);
  const orderedCapabilityIds = normalizeCapabilityShelfOrder(capabilityIds);
  const db = getIamDb();

  return db.transaction(async (tx: any) => {
    await lockTenant(tx, tenantId);
    const previousRows = await tx
      .select({ capabilityId: enterpriseCapabilityShelfOrder.capabilityId })
      .from(enterpriseCapabilityShelfOrder)
      .where(eq(enterpriseCapabilityShelfOrder.tenantId, tenantId))
      .orderBy(
        asc(enterpriseCapabilityShelfOrder.position),
        asc(enterpriseCapabilityShelfOrder.capabilityId),
      );
    const previousCapabilityIds = new Set<string>(previousRows.map((row: { capabilityId: string }) => row.capabilityId));
    await assertPublishedPortableItems(tx, tenantId, orderedCapabilityIds, {
      allowLegacySkills: true,
      existingCapabilityIds: previousCapabilityIds,
    });

    await tx
      .delete(enterpriseCapabilityShelfOrder)
      .where(eq(enterpriseCapabilityShelfOrder.tenantId, tenantId));

    if (orderedCapabilityIds.length > 0) {
      const now = new Date();
      await tx.insert(enterpriseCapabilityShelfOrder).values(
        orderedCapabilityIds.map((capabilityId, position) => ({
          tenantId,
          capabilityId,
          position,
          createdAt: now,
          updatedAt: now,
        })),
      );
    }

    return {
      previousCapabilityIds: previousRows.map((row: { capabilityId: string }) => row.capabilityId),
      orderedCapabilityIds,
    };
  });
}

export async function addCapabilityToShelf(
  tenantIdInput: string,
  capabilityIdInput: string,
): Promise<CapabilityShelfMembershipMutation> {
  const tenantId = requireTenantId(tenantIdInput);
  const capabilityId = requirePortableCapabilityId(capabilityIdInput);
  const db = getIamDb();

  return db.transaction(async (tx: any) => {
    await lockTenant(tx, tenantId);
    const previousRows = await tx
      .select({ capabilityId: enterpriseCapabilityShelfOrder.capabilityId })
      .from(enterpriseCapabilityShelfOrder)
      .where(eq(enterpriseCapabilityShelfOrder.tenantId, tenantId))
      .orderBy(
        asc(enterpriseCapabilityShelfOrder.position),
        asc(enterpriseCapabilityShelfOrder.capabilityId),
      );
    const previousCapabilityIds = previousRows.map((row: { capabilityId: string }) => row.capabilityId);
    await assertPublishedPortableItems(tx, tenantId, [capabilityId], {
      existingCapabilityIds: new Set(previousCapabilityIds),
    });
    if (previousCapabilityIds.includes(capabilityId)) {
      return { capabilityId, previousCapabilityIds, orderedCapabilityIds: previousCapabilityIds };
    }
    if (previousCapabilityIds.length >= MAX_CAPABILITY_SHELF_ITEMS) {
      throw new CapabilityShelfMembershipValidationError(
        `capability shelf already contains ${MAX_CAPABILITY_SHELF_ITEMS} items`,
      );
    }
    const now = new Date();
    await tx.insert(enterpriseCapabilityShelfOrder).values({
      tenantId,
      capabilityId,
      position: previousCapabilityIds.length,
      createdAt: now,
      updatedAt: now,
    });
    return {
      capabilityId,
      previousCapabilityIds,
      orderedCapabilityIds: [...previousCapabilityIds, capabilityId],
    };
  });
}

export async function removeCapabilityFromShelf(
  tenantIdInput: string,
  capabilityIdInput: string,
): Promise<CapabilityShelfMembershipMutation> {
  const tenantId = requireTenantId(tenantIdInput);
  const capabilityId = requirePortableCapabilityId(capabilityIdInput);
  const db = getIamDb();

  return db.transaction(async (tx: any) => {
    await lockTenant(tx, tenantId);
    const previousRows = await tx
      .select({ capabilityId: enterpriseCapabilityShelfOrder.capabilityId })
      .from(enterpriseCapabilityShelfOrder)
      .where(eq(enterpriseCapabilityShelfOrder.tenantId, tenantId))
      .orderBy(
        asc(enterpriseCapabilityShelfOrder.position),
        asc(enterpriseCapabilityShelfOrder.capabilityId),
      );
    const previousCapabilityIds = previousRows.map((row: { capabilityId: string }) => row.capabilityId);
    await assertPublishedPortableItems(tx, tenantId, [capabilityId], {
      existingCapabilityIds: new Set(previousCapabilityIds),
    });
    const orderedCapabilityIds = previousCapabilityIds.filter((id: string) => id !== capabilityId);
    if (orderedCapabilityIds.length === previousCapabilityIds.length) {
      return { capabilityId, previousCapabilityIds, orderedCapabilityIds };
    }

    await tx
      .delete(enterpriseCapabilityShelfOrder)
      .where(eq(enterpriseCapabilityShelfOrder.tenantId, tenantId));
    if (orderedCapabilityIds.length > 0) {
      const now = new Date();
      await tx.insert(enterpriseCapabilityShelfOrder).values(
        orderedCapabilityIds.map((id: string, position: number) => ({
          tenantId,
          capabilityId: id,
          position,
          createdAt: now,
          updatedAt: now,
        })),
      );
    }
    return { capabilityId, previousCapabilityIds, orderedCapabilityIds };
  });
}

export { normalizeCapabilityShelfOrder };
export type { CapabilityShelfOrderValidationError };
