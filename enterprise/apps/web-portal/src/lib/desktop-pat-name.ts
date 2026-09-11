export const DESKTOP_PAT_NAME_PREFIX = "AgenticX Ontology Desktop";

const PAT_NAME_SEPARATOR = " · ";
const PAT_NAME_MAX_LENGTH = 128;

/**
 * Format the display name stored with a Desktop PAT. Device authorization
 * records use the product label as their fallback name, so avoid adding that
 * label a second time when composing the PAT name.
 */
export function formatDesktopPatName(deviceName?: string | null): string {
  const normalized = typeof deviceName === "string" ? deviceName.trim() : "";
  if (!normalized || normalized === DESKTOP_PAT_NAME_PREFIX) return DESKTOP_PAT_NAME_PREFIX;

  const prefixed = `${DESKTOP_PAT_NAME_PREFIX}${PAT_NAME_SEPARATOR}`;
  if (normalized.startsWith(prefixed)) {
    return normalized.slice(0, PAT_NAME_MAX_LENGTH);
  }

  const suffixLength = Math.max(0, PAT_NAME_MAX_LENGTH - prefixed.length);
  return `${prefixed}${normalized.slice(0, suffixLength)}`;
}
