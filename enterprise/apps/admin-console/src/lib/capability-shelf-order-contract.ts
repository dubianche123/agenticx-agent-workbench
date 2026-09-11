import { canonicalizeCapabilityId } from "@agenticx/config";

/** The admin shelf is intentionally bounded to keep a single reorder request small. */
export const MAX_CAPABILITY_SHELF_ITEMS = 1000;

export class CapabilityShelfOrderValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CapabilityShelfOrderValidationError";
  }
}

/** A portable market item may enter the shelf only after an explicit admin action. */
export class CapabilityShelfMembershipValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CapabilityShelfMembershipValidationError";
  }
}

/**
 * Normalize the sequence at the persistence boundary.
 *
 * Capability ids are accepted in their parseable form (including lower-case ULIDs), then
 * stored in the single canonical form. Duplicate ids are harmless for a presentation order,
 * so the first occurrence wins and later occurrences are removed.
 */
export function normalizeCapabilityShelfOrder(input: readonly unknown[]): string[] {
  if (input.length > MAX_CAPABILITY_SHELF_ITEMS) {
    throw new CapabilityShelfOrderValidationError(
      `capabilityIds must contain at most ${MAX_CAPABILITY_SHELF_ITEMS} items`,
    );
  }

  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    if (typeof raw !== "string") {
      throw new CapabilityShelfOrderValidationError("capabilityIds must contain strings");
    }
    const capabilityId = canonicalizeCapabilityId(raw);
    if (!capabilityId) {
      throw new CapabilityShelfOrderValidationError(`invalid capability id: ${raw.trim()}`);
    }
    if (seen.has(capabilityId)) continue;
    seen.add(capabilityId);
    normalized.push(capabilityId);
  }
  return normalized;
}
