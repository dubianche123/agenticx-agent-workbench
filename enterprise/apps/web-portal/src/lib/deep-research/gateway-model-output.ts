/** Normalize reasoning/content variants returned by OpenAI-compatible gateways. */

const THINK_OPEN = "<" + "think" + ">";
const THINK_CLOSE = "<" + "/" + "think" + ">";

export type GatewayModelDelta = {
  content?: unknown;
  reasoning_content?: unknown;
  reasoning?: unknown;
  reasoning_details?: unknown;
};

function cleanReasoning(raw: string): string {
  return raw.replaceAll(THINK_OPEN, "").replaceAll(THINK_CLOSE, "");
}

function reasoningDetailText(detail: unknown): string {
  if (!detail || typeof detail !== "object") return "";
  const text = (detail as { text?: unknown }).text;
  return typeof text === "string" ? text : "";
}

function reasoningText(delta: GatewayModelDelta | null | undefined): string {
  if (!delta) return "";
  const pieces: string[] = [];
  const canonical =
    typeof delta.reasoning_content === "string" ? delta.reasoning_content : "";
  if (canonical) pieces.push(canonical);
  const alias = typeof delta.reasoning === "string" ? delta.reasoning : "";
  if (alias && alias !== canonical) pieces.push(alias);
  if (Array.isArray(delta.reasoning_details)) {
    for (const detail of delta.reasoning_details) {
      const text = reasoningDetailText(detail);
      if (text) pieces.push(text);
    }
  }
  return cleanReasoning(pieces.join(""));
}

/**
 * The private Qwen3.8 template prefills `<think>` outside generated tokens.
 * Its OpenAI-compatible stream therefore starts with raw reasoning in `content`
 * and exposes only the later `</think>` boundary.
 */
export function usesImplicitThinkPrefix(model: unknown): boolean {
  const slug = String(model ?? "").trim().toLowerCase().split("/").at(-1) ?? "";
  return /^qwen3\.8(?:$|[-_])/.test(slug);
}

/** Stateful normalization for one streamed model completion. */
export class DeepResearchStreamOutput {
  private implicitReasoning: boolean;
  private implicitReasoningOpen = false;
  private implicitReasoningTail = "";

  constructor(model: unknown) {
    this.implicitReasoning = usesImplicitThinkPrefix(model);
  }

  private closeImplicitReasoning(): string {
    this.implicitReasoning = false;
    this.implicitReasoningTail = "";
    if (!this.implicitReasoningOpen) return "";
    this.implicitReasoningOpen = false;
    return THINK_CLOSE;
  }

  private normalizeImplicitContent(content: string): string {
    if (!this.implicitReasoning) return content;

    let output = content;
    if (!this.implicitReasoningOpen) {
      const hasExplicitOpen = content.trimStart().toLowerCase().startsWith(THINK_OPEN);
      output = hasExplicitOpen ? content : `${THINK_OPEN}${content}`;
      this.implicitReasoningOpen = true;
    }

    const combined = this.implicitReasoningTail + content.toLowerCase();
    if (combined.includes(THINK_CLOSE)) {
      this.implicitReasoning = false;
      this.implicitReasoningOpen = false;
      this.implicitReasoningTail = "";
    } else {
      this.implicitReasoningTail = combined.slice(-(THINK_CLOSE.length - 1));
    }
    return output;
  }

  merge(delta: GatewayModelDelta | null | undefined): {
    content: string;
    reasoning: string;
  } {
    if (!delta) return { content: "", reasoning: "" };
    const reasoning = reasoningText(delta);
    let content = typeof delta.content === "string" ? delta.content : "";
    let normalizedContent = "";

    // A provider that exposes an explicit reasoning field has already told us
    // where the boundary is. Close any implicit block before accepting it.
    if (reasoning) {
      const implicitClose = this.closeImplicitReasoning();
      if (implicitClose) normalizedContent += `${implicitClose}\n`;
      content = content.replaceAll(THINK_OPEN, "").replaceAll(THINK_CLOSE, "");
    }
    if (content) normalizedContent += this.normalizeImplicitContent(content);

    return { content: normalizedContent, reasoning };
  }

  /** Fail closed: an unfinished implicit thought must never become report prose. */
  close(): string {
    return this.closeImplicitReasoning();
  }
}

function stripInlineThinkBlocks(raw: string): string {
  return raw
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<\/?think>/gi, "");
}

/** Normalize one non-streaming `choices[0].message` payload. */
export function normalizeGatewayMessageContent(
  model: unknown,
  message: GatewayModelDelta | null | undefined,
): string {
  if (!message) return "";
  const reasoning = reasoningText(message);
  let content = typeof message.content === "string" ? message.content : "";

  if (reasoning) {
    content = stripInlineThinkBlocks(content);
    return `${THINK_OPEN}${reasoning}${THINK_CLOSE}${content ? `\n${content}` : ""}`;
  }

  const lower = content.toLowerCase();
  if (
    usesImplicitThinkPrefix(model) &&
    lower.includes(THINK_CLOSE) &&
    !lower.includes(THINK_OPEN)
  ) {
    content = `${THINK_OPEN}${content}`;
  }
  return content;
}
