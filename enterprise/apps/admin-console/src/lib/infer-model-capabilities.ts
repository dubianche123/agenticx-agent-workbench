/** Infer chat model capabilities for the admin provider catalog. */

import { isKnownNonVisionChatModel } from "@agenticx/config";

export { isKnownNonVisionChatModel } from "@agenticx/config";

function modelSlug(modelId: string): string {
  const lower = (modelId || "").trim().toLowerCase();
  return lower.includes("/") ? (lower.split("/").pop() ?? lower) : lower;
}

const REASONING_RE =
  /(?:^|\/)(?:deepseek-r1|.*-r1(?:-|$)|.*reasoner.*|.*-thinking(?:-|$)|qwq(?:-|$))/i;

const EMBEDDING_RE =
  /(?:^|[-_/])(?:text-embedding|multimodal-embedding|embedding|embed)(?:[-_/]|$)/i;

export function isEmbeddingModelId(modelId: string): boolean {
  const slug = modelSlug(modelId);
  if (!slug) return false;
  if (/^text-embedding(?:-|$)/i.test(slug)) return true;
  if (/^(?:multimodal-embedding|qwen[\d.]*-vl-embedding|tongyi-embedding-vision)/i.test(slug)) return true;
  return EMBEDDING_RE.test(slug) && !/chat|coder|vl-plus(?!-embedding)/i.test(slug);
}

export function inferModelCapabilities(providerId: string, modelName: string): string[] {
  if (isEmbeddingModelId(modelName)) {
    return ["embedding"];
  }
  const caps: string[] = ["text"];
  if (REASONING_RE.test(modelName)) {
    caps.push("reasoning");
  }
  if (inferVisionCapability(providerId, modelName)) {
    caps.push("vision");
  }
  return caps;
}

function inferVisionCapability(providerId: string, modelName: string): boolean {
  if (isKnownNonVisionChatModel(providerId, modelName)) return false;
  const slug = modelSlug(modelName);
  return /(?:^|[/_-])(?:gpt-4o(?!-mini)|gpt-4-turbo|gpt-4\.1|o1|o3|o4|claude-3|claude-4|gemini|qwen-vl|qwen2\.5-vl|glm-4v|glm-4\.\d+v|glm-4\.1v|4v|5v|vision|vl-|pixtral|llava|moondream|internvl|doubao-vision)/i.test(
    slug
  );
}
