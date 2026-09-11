import {
  getAdminUser,
  listUserOptOuts,
} from "@agenticx/iam-core";
import { modelIdsFromSubjects } from "@agenticx/config";
import {
  computeEffectiveDeptAllowed,
  computeEffectiveUserAllowed,
  mergeAssignedModelIds,
  collectUserAssignmentKeys,
  mergeUserStoredSet,
} from "../effective-models";
import { listProviders, listAllEnabledModelIds } from "../model-providers-store";
import { groupModelSourcesForUser, listUserGroups } from "../user-groups-store";
import { listAllAssignments, readUserEditPayload } from "../user-models-store";
import type { AdminUserDto } from "@agenticx/iam-core";
import type { EffectiveModelState, SupportModelOption } from "./types";

export type SupportModelRecord = SupportModelOption & {
  provider: string;
  model: string;
  isDefault: boolean;
};

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function normalizedSet(values: readonly string[]): string[] {
  return unique(values).sort((a, b) => a.localeCompare(b));
}

export function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  const a = normalizedSet(left);
  const b = normalizedSet(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * Resolve the same cascading department + group + user model policy used by
 * the admin member editor. Every read is tenant-bound to the authenticated
 * administrator instead of relying on DEFAULT_TENANT_ID.
 */
export async function readEffectiveModelState(
  tenantId: string,
  user: Pick<AdminUserDto, "id" | "email" | "deptId">,
): Promise<EffectiveModelState> {
  const tid = tenantId.trim();
  if (!tid) throw new Error("tenant is required");
  const [payload, groups, assignments, optOutSubjects] = await Promise.all([
    readUserEditPayload(user.id, user.email, user.deptId, tid),
    listUserGroups(tid),
    listAllAssignments(tid),
    listUserOptOuts(tid, user.id),
  ]);
  const storedModelIds = mergeUserStoredSet(assignments, collectUserAssignmentKeys(user.id, user.email)) ?? [];
  const personalAssignmentModelIdsByKey = Object.fromEntries(
    collectUserAssignmentKeys(user.id, user.email).map((key) => [key, unique(assignments[key] ?? [])]),
  );
  // A department is a hard upper bound. Match the admin member endpoint by
  // keeping only group grants that can actually reach this member; assignments
  // outside that bound remain visible as individual stale values and are never
  // silently rewritten by a support proposal.
  const parentAllowedSet = new Set(payload.parentAllowedIds);
  const groupSources = groupModelSourcesForUser(groups, user.id).map((group) => ({
    ...group,
    modelIds: group.modelIds.filter((modelId) => parentAllowedSet.has(modelId)),
  }));
  const groupModelIds = unique(groupSources.flatMap((group) => group.modelIds));
  const groupModelSet = new Set(groupModelIds);
  const individualModelIds = storedModelIds.filter((modelId) => !groupModelSet.has(modelId));
  const excludedGroupModelIds = modelIdsFromSubjects(optOutSubjects as string[]).filter((modelId: string) => groupModelSet.has(modelId));
  const effectiveModelIds = computeEffectiveUserAllowed(
    payload.parentAllowedIds,
    mergeAssignedModelIds(storedModelIds.length > 0 ? storedModelIds : null, groupModelIds),
    excludedGroupModelIds,
  );
  return {
    tenantId: tid,
    userId: user.id,
    email: user.email,
    deptId: user.deptId,
    parentAllowedIds: unique(payload.parentAllowedIds),
    parentLabel: payload.parentLabel,
    individualModelIds: unique(individualModelIds),
    personalAssignmentModelIds: unique(storedModelIds),
    personalAssignmentModelIdsByKey,
    groupModelIds,
    excludedGroupModelIds: unique(excludedGroupModelIds),
    effectiveModelIds: unique(effectiveModelIds),
  };
}

export async function listSupportModelsForUser(
  tenantId: string,
  user: Pick<AdminUserDto, "id" | "email" | "deptId">,
): Promise<SupportModelRecord[]> {
  const [providers, state] = await Promise.all([
    listProviders(tenantId),
    readEffectiveModelState(tenantId, user),
  ]);
  const allowed = new Set(state.effectiveModelIds);
  const out: SupportModelRecord[] = [];
  for (const provider of providers) {
    if (!provider.enabled) continue;
    for (const model of provider.models) {
      if (!model.enabled) continue;
      const id = `${provider.id}/${model.name}`;
      if (!allowed.has(id)) continue;
      out.push({
        id,
        label: model.label || model.name,
        provider: provider.id,
        model: model.name,
        isDefault: provider.isDefault,
      });
    }
  }
  return out;
}

export async function listAllSupportModels(tenantId: string): Promise<SupportModelRecord[]> {
  const providers = await listProviders(tenantId);
  const out: SupportModelRecord[] = [];
  for (const provider of providers) {
    if (!provider.enabled) continue;
    for (const model of provider.models) {
      if (!model.enabled) continue;
      out.push({
        id: `${provider.id}/${model.name}`,
        label: model.label || model.name,
        provider: provider.id,
        model: model.name,
        isDefault: provider.isDefault,
      });
    }
  }
  return out;
}

export async function resolveSupportModel(
  tenantId: string,
  user: Pick<AdminUserDto, "id" | "email" | "deptId">,
  requestedModel: string | undefined,
): Promise<{ selected: SupportModelRecord | null; available: SupportModelRecord[] }> {
  const available = await listSupportModelsForUser(tenantId, user);
  if (available.length === 0) return { selected: null, available };
  if (!requestedModel?.trim()) {
    return {
      selected: available.find((model) => model.isDefault) ?? available[0] ?? null,
      available,
    };
  }
  const normalized = requestedModel.trim().toLowerCase();
  const selected = available.find((model) => model.id.toLowerCase() === normalized);
  return { selected: selected ?? null, available };
}

export async function readModelStateForUserId(tenantId: string, userId: string): Promise<EffectiveModelState | null> {
  const user = await getAdminUser(tenantId, userId);
  return user ? readEffectiveModelState(tenantId, user) : null;
}

export function sameEffectiveModelState(left: EffectiveModelState, right: EffectiveModelState): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.userId === right.userId &&
    left.email === right.email &&
    left.deptId === right.deptId &&
    left.parentLabel === right.parentLabel &&
    sameStringSet(left.parentAllowedIds, right.parentAllowedIds) &&
    (right.personalAssignmentModelIds === undefined ||
      sameStringSet(left.personalAssignmentModelIds ?? left.individualModelIds, right.personalAssignmentModelIds)) &&
    (right.personalAssignmentModelIdsByKey === undefined ||
      Object.keys(right.personalAssignmentModelIdsByKey).every((key) =>
        sameStringSet(left.personalAssignmentModelIdsByKey?.[key] ?? [], right.personalAssignmentModelIdsByKey![key] ?? []),
      )) &&
    sameStringSet(left.individualModelIds, right.individualModelIds) &&
    sameStringSet(left.groupModelIds, right.groupModelIds) &&
    sameStringSet(left.excludedGroupModelIds, right.excludedGroupModelIds) &&
    sameStringSet(left.effectiveModelIds, right.effectiveModelIds)
  );
}

export async function currentAllowedModelIdsForUser(tenantId: string, user: Pick<AdminUserDto, "id" | "email" | "deptId">): Promise<string[]> {
  return (await readEffectiveModelState(tenantId, user)).effectiveModelIds;
}

export function modelLabelForId(id: string, available: readonly SupportModelRecord[]): string {
  return available.find((model) => model.id === id)?.label ?? id;
}

export function splitSupportModelId(id: string): { provider: string; model: string } | null {
  const separator = id.indexOf("/");
  if (separator <= 0 || separator === id.length - 1) return null;
  return { provider: id.slice(0, separator), model: id.slice(separator + 1) };
}

export function modelIdsForPrompt(models: readonly SupportModelRecord[]): Array<{ id: string; label: string }> {
  return models.slice(0, 100).map(({ id, label }) => ({ id, label }));
}

export async function modelPolicyForTarget(tenantId: string, userId: string): Promise<{
  user: AdminUserDto;
  state: EffectiveModelState;
  allEnabledIds: string[];
}> {
  const user = await getAdminUser(tenantId, userId);
  if (!user) throw new Error("user not found");
  const [state, allEnabledIds] = await Promise.all([
    readEffectiveModelState(tenantId, user),
    listAllEnabledModelIds(tenantId),
  ]);
  return { user, state, allEnabledIds };
}
