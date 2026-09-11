/** User-visible product / meta-agent display name. */
export const APP_DISPLAY_NAME = "AgenticX Ontology";
export const ORG_DISPLAY_NAME = "AgenticX";
export const META_AGENT_DISPLAY_NAME = "个人助手";
export const APP_DESCRIPTION = "AgenticX Ontology — 个人智能工作台";
export const APP_TAGLINE = "个人智能工作台";
/** Default isolated data root shown in desktop guidance. */
export const AGX_HOME_DISPLAY = "~/.agenticx-ontology";
export const AGX_CONFIG_DISPLAY_PATH = `${AGX_HOME_DISPLAY}/config.yaml`;
/** Keep in sync with desktop/package.json `version`. */
export const APP_VERSION = "v2.0.0";

/** Legacy product names that should still resolve to the current brand. */
export const LEGACY_META_DISPLAY_NAMES = new Set<string>([
  "Near",
  "near",
  "Machi",
  "machi",
  "meta",
]);
