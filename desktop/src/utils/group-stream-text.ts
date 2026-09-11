import { parseReasoningContent } from "../components/messages/reasoning-parser";
import { isThinkingPlaceholderText } from "./stream-overlay-policy";

const SKIP_SENTINEL = "__SKIP__";

export function isGroupStreamMessageId(id: string | undefined): boolean {
  return typeof id === "string" && id.startsWith("__group_stream__:");
}

/** Keep reasoning and skip sentinels out of the live expert bubble. */
export function visibleGroupStreamBody(raw: string): string {
  const parsed = parseReasoningContent(raw);
  const body = String(parsed.response ?? "").trim();
  if (!body || isThinkingPlaceholderText(body)) return "";
  if (SKIP_SENTINEL.startsWith(body) || body === SKIP_SENTINEL) return "";
  if (body.startsWith(SKIP_SENTINEL)) {
    return body.slice(SKIP_SENTINEL.length).trim();
  }
  return body;
}

export function shouldResetGroupStreamOnProgress(toolPhase: string): boolean {
  return toolPhase === "calling";
}
