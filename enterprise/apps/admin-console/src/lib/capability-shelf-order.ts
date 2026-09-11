/**
 * Custom capability shelf ordering helpers.
 *
 * The API stores one complete order for the catalog.  A filtered grid only
 * exposes a subset of that order, so moving a visible item must put the
 * reordered visible ids back into their original slots and leave hidden ids
 * untouched.
 */

function normalizedIds(ids: readonly string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const raw of ids) {
    const id = String(raw ?? "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

function isPortableCapabilityId(id: string, choice?: { shelfManaged?: boolean }): boolean {
  return id.startsWith("expert:") || id.startsWith("group:") ||
    (id.startsWith("skill:") && choice?.shelfManaged === true);
}

/**
 * The persisted shelf order is also the explicit membership list for portable
 * experts and group chats. Built-in features, registered Skills, and MCPs are
 * administrator-owned inventory and remain on the shelf by default; employee
 * market uploads only enter after an administrator reviews and adds them.
 */
export function filterCapabilityShelfChoices<T extends { id: string; shelfManaged?: boolean }>(
  catalog: readonly T[],
  orderedCapabilityIds: readonly string[] | null | undefined,
): T[] {
  const membership = new Set(normalizedIds(orderedCapabilityIds ?? []));
  return catalog.filter(
    (choice) => !isPortableCapabilityId(choice.id, choice) || membership.has(choice.id),
  );
}

/**
 * Reconcile an API order with the currently available catalog ids.
 *
 * Existing ids retain their server order; newly discovered ids are appended
 * in catalog order; ids that disappeared are removed.  Duplicate or blank
 * ids from a stale/malformed response are ignored.
 */
export function reconcileCapabilityShelfOrder(
  catalogIds: readonly string[],
  orderedCapabilityIds: readonly string[] | null | undefined,
): string[] {
  const catalog = normalizedIds(catalogIds);
  const available = new Set(catalog);
  const result: string[] = [];
  const seen = new Set<string>();

  for (const raw of orderedCapabilityIds ?? []) {
    const id = String(raw ?? "").trim();
    if (!id || !available.has(id) || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }

  for (const id of catalog) {
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }

  return result;
}

/**
 * Move one visible item and merge that movement into the complete order.
 * Hidden items keep both their relative order and their original slots.
 */
export function reorderCapabilityShelfOrder(
  completeOrder: readonly string[],
  visibleIds: readonly string[],
  activeId: string,
  overId: string,
): string[] {
  const order = normalizedIds(completeOrder);
  if (activeId === overId) return order;

  const orderSet = new Set(order);
  const visibleOrder = normalizedIds(visibleIds).filter((id) => orderSet.has(id));
  const visibleSet = new Set(visibleOrder);
  const oldIndex = visibleOrder.indexOf(activeId);
  const newIndex = visibleOrder.indexOf(overId);
  if (oldIndex < 0 || newIndex < 0) return order;

  const movedVisible = [...visibleOrder];
  const [moved] = movedVisible.splice(oldIndex, 1);
  if (moved === undefined) return order;
  movedVisible.splice(newIndex, 0, moved);

  let visibleIndex = 0;
  return order.map((id) => {
    if (!visibleSet.has(id)) return id;
    const replacement = movedVisible[visibleIndex];
    visibleIndex += 1;
    return replacement ?? id;
  });
}

/** Parse the GET response without trusting arbitrary API data. */
export function orderedCapabilityIdsFromPayload(payload: unknown): string[] | null {
  if (!payload || typeof payload !== "object") return null;
  const data = (payload as { data?: unknown }).data;
  if (!data || typeof data !== "object") return null;
  const orderedCapabilityIds = (data as { orderedCapabilityIds?: unknown }).orderedCapabilityIds;
  if (!Array.isArray(orderedCapabilityIds)) return null;
  return orderedCapabilityIds
    .filter((id): id is string => typeof id === "string")
    .map((id) => id.trim())
    .filter(Boolean);
}
