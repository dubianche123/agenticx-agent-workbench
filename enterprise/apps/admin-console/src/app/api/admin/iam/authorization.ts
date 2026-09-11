/**
 * Thin adapter between Admin Console routes and the shared IAM authorization
 * service.  The console must not grow an in-process authorization store: the
 * package owns tenant checks, binding ranges, and the last-admin safeguards.
 *
 * The console imports the shared contract statically. This keeps missing
 * exports visible to the build and prevents a rolling deploy from silently
 * falling back to the legacy roleCodes path.
 */

import {
  assertBindingManageable as coreAssertBindingManageable,
  assertGrantable as coreAssertGrantable,
  type GrantabilityInput,
  type GrantabilitySnapshot,
} from "@agenticx/iam-core";

/**
 * Every role/principal mutation goes through this shared guard. The payload
 * carries only the typed grantability facts; the package resolves the
 * operator's live bindings and target range.
 */
export type { GrantabilityInput };

export async function assertGrantable(input: GrantabilityInput): Promise<GrantabilitySnapshot> {
  return coreAssertGrantable(input);
}

export async function assertBindingManageable(input: {
  tenantId: string;
  bindingId: string;
  actorUserId: string;
}): Promise<void> {
  await coreAssertBindingManageable(input);
}

export function errorStatus(error: unknown): number {
  const message = error instanceof Error ? error.message : "";
  if (/not found|不存在|unknown principal|unknown role/i.test(message)) return 404;
  if (/forbidden|not grantable|grantable|grant_scope_exceeded|cross.?tenant|tenant|immutable|system role|last.*admin|last.*super|grantor|approval|actor_inactive/i.test(message)) return 403;
  if (/in use|already exists|duplicate|conflict|active binding|authorization context is stale/i.test(message)) return 409;
  return 400;
}

export function errorEnvelope(error: unknown): { code: string; message: string } {
  const status = errorStatus(error);
  const message = error instanceof Error ? error.message : "invalid request";
  return { code: status === 404 ? "40400" : status === 403 ? "40300" : status === 409 ? "40900" : "40000", message };
}
