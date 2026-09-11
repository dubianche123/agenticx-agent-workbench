import {
  ConfigShareValidationError,
  MAX_CONFIG_SHARE_MANIFEST_BYTES,
  assertConfigShareExactTextUnicode,
  type ConfigShareManifest,
  validateConfigShareManifest,
} from "../config-share-types";
import {
  normalizeConfigMarketAudience,
  type ConfigMarketAudience,
  type ConfigMarketVisibility,
} from "./types";

export type ConfigMarketCreateRequest = {
  manifest: ConfigShareManifest;
  visibility: ConfigMarketAudience;
  releaseNotes: string;
};

export type ConfigMarketVisibilityRequest = {
  type: ConfigMarketVisibility;
  department_ids: string[];
  user_ids: string[];
};

const REQUEST_KEYS = ["manifest", "visibility"] as const;
const REQUEST_KEYS_WITH_NOTES = ["manifest", "release_notes", "visibility"] as const;
const VISIBILITY_KEYS = ["department_ids", "type", "user_ids"] as const;
const MAX_CONFIG_MARKET_ENVELOPE_BYTES = 16 * 1024;
export const MAX_CONFIG_MARKET_REQUEST_BYTES =
  MAX_CONFIG_SHARE_MANIFEST_BYTES + MAX_CONFIG_MARKET_ENVELOPE_BYTES;

export class ConfigMarketRequestTooLargeError extends Error {
  public constructor() {
    super(`market request max ${MAX_CONFIG_MARKET_REQUEST_BYTES} UTF-8 bytes`);
    this.name = "ConfigMarketRequestTooLargeError";
  }
}

/** Read the actual stream with a hard byte ceiling; Content-Length is only an early rejection hint. */
export async function readConfigMarketRequestJson(request: Request): Promise<unknown> {
  const declaredLength = request.headers.get("content-length");
  if (
    declaredLength &&
    /^\d+$/.test(declaredLength) &&
    Number(declaredLength) > MAX_CONFIG_MARKET_REQUEST_BYTES
  ) {
    throw new ConfigMarketRequestTooLargeError();
  }

  const reader = request.body?.getReader();
  if (!reader) throw new SyntaxError("empty request body");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let totalBytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_CONFIG_MARKET_REQUEST_BYTES) {
        throw new ConfigMarketRequestTooLargeError();
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(text) as unknown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactlyKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

/** Market upload has a separate strict envelope; ordinary point-to-point shares remain unchanged. */
export function parseConfigMarketCreateRequest(value: unknown): ConfigMarketCreateRequest {
  if (
    !isPlainObject(value) ||
    (!hasExactlyKeys(value, REQUEST_KEYS) && !hasExactlyKeys(value, REQUEST_KEYS_WITH_NOTES))
  ) {
    throw new ConfigShareValidationError(
      `market request must contain exactly: ${REQUEST_KEYS.join(", ")} and optional release_notes`,
    );
  }
  if (value.release_notes !== undefined && typeof value.release_notes !== "string") {
    throw new ConfigShareValidationError("release_notes must be a string");
  }
  if (!isPlainObject(value.visibility) || !hasExactlyKeys(value.visibility, VISIBILITY_KEYS)) {
    throw new ConfigShareValidationError(
      `visibility must contain exactly: ${VISIBILITY_KEYS.join(", ")}`,
    );
  }
  const visibility = normalizeConfigMarketAudience({
    visibility: value.visibility.type,
    visibleDepartmentIds: value.visibility.department_ids,
    visibleUserIds: value.visibility.user_ids,
  });
  if (!visibility) {
    throw new ConfigShareValidationError(
      "visibility must be personal, company, or admins_only with empty targets; departments with 1-64 department_ids; or users with 1-64 user_ids",
    );
  }
  const manifest = validateConfigShareManifest(value.manifest);
  if (manifest.workspace_slots.some((slot) => slot.required)) {
    throw new ConfigShareValidationError(
      "market publication workspace slots must be optional; choose a local workspace when installing or running the package",
    );
  }
  const releaseNotes = String(value.release_notes ?? "").trim();
  assertConfigShareExactTextUnicode(releaseNotes, "release_notes");
  if ([...releaseNotes].length > 4_000) {
    throw new ConfigShareValidationError("release_notes max 4000 characters");
  }
  return {
    manifest,
    visibility,
    releaseNotes,
  };
}
