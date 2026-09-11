/**
 * Shared model-input capability checks for enterprise clients and services.
 *
 * Admin-managed capabilities are authoritative when present. Model-name
 * heuristics are only a compatibility fallback for older rows that have no
 * capability metadata yet.
 */

const KNOWN_TEXT_ONLY_RE =
  /(gpt-3\.5|gpt-35|text-embedding|embedding-3|whisper|davinci|babbage|deepseek-chat|deepseek-coder|deepseek-reasoner)/i;

function modelSlug(modelId: string): string {
  const lower = (modelId || "").trim().toLowerCase();
  return lower.includes("/") ? (lower.split("/").pop() ?? lower) : lower;
}

function minimaxM2TextOnly(slug: string): boolean {
  if (/vl|vision/.test(slug)) return false;
  return slug.startsWith("minimax-m2") || /^m2[.\-_]?\d/.test(slug);
}

function zhipuTextOnly(slug: string): boolean {
  if (/\dv|vision|vl/.test(slug)) return false;
  return /^glm-(5|4\.6|4\.5|4|z1|zero)/.test(slug);
}

function qwenTextOnly(slug: string): boolean {
  if (/vl|vision|omni/.test(slug)) return false;
  return slug.startsWith("qwen");
}

/**
 * Returns true only for model families known to reject image input.
 *
 * Family matching deliberately ignores the provider id: private and custom
 * OpenAI-compatible gateways commonly expose the same GLM/Qwen/MiniMax slugs.
 */
export function isKnownNonVisionChatModel(_provider: string, model: string): boolean {
  const normalized = (model || "").trim().toLowerCase();
  if (!normalized) return false;
  const slug = modelSlug(normalized);

  if (KNOWN_TEXT_ONLY_RE.test(normalized)) return true;
  if (minimaxM2TextOnly(slug)) return true;
  if (zhipuTextOnly(slug)) return true;
  if (qwenTextOnly(slug)) return true;
  return false;
}

export function modelSupportsVision(
  provider: string,
  model: string,
  capabilities?: readonly string[] | null,
): boolean {
  const declared = (capabilities ?? [])
    .map((capability) => String(capability ?? "").trim().toLowerCase())
    .filter(Boolean);

  // A non-empty list is an explicit admin declaration. In particular,
  // `["text"]` must not be treated as "unknown, therefore probably vision".
  if (declared.length > 0) return declared.includes("vision");
  return !isKnownNonVisionChatModel(provider, model);
}
