export const CAPABILITY_PACK_CONFLICT_CODE = "40901";
export const CAPABILITY_PACK_CONFLICT_MESSAGE = "能力包已被其他管理员修改，请刷新后重试";

export class CapabilityPackVersionConflictError extends Error {
  constructor(
    readonly expectedUpdatedAt: string,
    readonly actualUpdatedAt: string,
  ) {
    super("capability pack was updated by another request");
    this.name = "CapabilityPackVersionConflictError";
  }
}

export function capabilityPackVersion(value: unknown): Date {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("expectedUpdatedAt is required");
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error("expectedUpdatedAt must be a valid timestamp");
  }
  return parsed;
}

export function nextCapabilityPackUpdatedAt(current: Date, now = new Date()): Date {
  return now.getTime() > current.getTime() ? now : new Date(current.getTime() + 1);
}

/** Every capability-pack PATCH is a whole-record write and must carry the version it was based on. */
export function versionedCapabilityPackPatch<T extends Record<string, unknown>>(
  expectedUpdatedAt: string,
  patch: T,
): T & { expectedUpdatedAt: string } {
  return {
    ...patch,
    expectedUpdatedAt: capabilityPackVersion(expectedUpdatedAt).toISOString(),
  };
}
