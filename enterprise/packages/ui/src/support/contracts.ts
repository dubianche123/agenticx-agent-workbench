/**
 * Shared, server-safe contracts for the contextual support assistant.
 *
 * These types intentionally contain no credentials, provider configuration, or
 * executable operation details. Both web applications validate requests at
 * their own BFF boundary before using these shapes.
 */

export const SUPPORT_CONTRACT_VERSION = "2026-09-09" as const;

export const SUPPORT_MAX_MESSAGES = 20;
export const SUPPORT_MAX_MESSAGE_CHARS = 4_000;
export const SUPPORT_MAX_PAGE_PATH_CHARS = 512;
export const SUPPORT_MAX_TAB_CHARS = 128;
export const SUPPORT_MAX_MODEL_CHARS = 200;
export const SUPPORT_MAX_BODY_BYTES = 100 * 1024;

export type SupportSurface = "portal" | "admin";

/** Where the contextual assistant is mounted in its host application. */
export type SupportAssistantPlacement = "floating" | "inline";

export type SupportMessageRole = "user" | "assistant";

export type SupportMessage = {
  role: SupportMessageRole;
  content: string;
};

export type SupportPageContext = {
  path: string;
  tab?: string;
};

export type SupportModelOption = {
  id: string;
  label: string;
};

export type SupportBootstrap = {
  storageKey: string;
  title: string;
  suggestions: string[];
  models?: SupportModelOption[];
};

export type SupportChatRequest = {
  messages: SupportMessage[];
  page: SupportPageContext;
  model?: string;
};

export type SupportLink = {
  label: string;
  href: string;
};

export type SupportProposalChange = {
  label: string;
  before: string;
  after: string;
};

export type SupportProposal = {
  id: string;
  title: string;
  changes: SupportProposalChange[];
  expiresAt: string;
};

export type SupportChatResponse = {
  message: string;
  links?: SupportLink[];
  proposal?: SupportProposal;
};

export type SupportExecuteRequest = {
  proposalId: string;
};

export type SupportExecuteResponse = {
  message: string;
};

export type SupportApiError = {
  code: string;
  message: string;
  traceId?: string;
};

export function isSupportMessageRole(value: unknown): value is SupportMessageRole {
  return value === "user" || value === "assistant";
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function trimBoundedString(value: unknown, maxChars: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxChars) return null;
  return trimmed;
}

/**
 * Bound model replies before they enter the browser state or local history.
 * User input is rejected by the parser, while model output is truncated at
 * the same contract boundary so one long answer cannot make the next turn
 * invalid or disappear during rehydration.
 */
export function boundSupportMessage(value: string): string {
  return value.trim().slice(0, SUPPORT_MAX_MESSAGE_CHARS);
}

const SUPPORT_REASONING_TAG_RE = /<\s*(\/?)\s*(think|analysis)\s*>/gi;

/**
 * Remove provider-internal reasoning before support content is shown or sent
 * back as context on a later turn. An unclosed block drops its tail, while an
 * orphan closing marker drops the prefix emitted by providers that omit the
 * opening tag.
 */
export function sanitizeSupportContent(raw: string): string {
  let visible = "";
  let cursor = 0;
  let reasoningDepth = 0;
  let sawOpeningTag = false;
  for (const match of raw.matchAll(SUPPORT_REASONING_TAG_RE)) {
    const marker = match[0];
    const start = match.index ?? cursor;
    const end = start + marker.length;
    const closing = Boolean(match[1]);
    if (closing) {
      if (reasoningDepth > 0) {
        reasoningDepth -= 1;
      } else if (!sawOpeningTag) {
        visible = "";
      }
      cursor = end;
      continue;
    }

    if (reasoningDepth === 0) visible += raw.slice(cursor, start);
    reasoningDepth += 1;
    sawOpeningTag = true;
    cursor = end;
  }
  if (reasoningDepth === 0) visible += raw.slice(cursor);
  return visible.trim();
}

/**
 * Apply the support content boundary without interpreting user-authored
 * reasoning tags. Only assistant messages are provider output and therefore
 * eligible for reasoning removal.
 */
export function sanitizeSupportMessage(message: SupportMessage): SupportMessage {
  const content = message.role === "assistant"
    ? sanitizeSupportContent(message.content)
    : message.content;
  return { role: message.role, content: boundSupportMessage(content) };
}

/**
 * Parse the public support chat body. Unknown fields are rejected so future
 * executable fields cannot accidentally become accepted by an older server.
 */
export function parseSupportChatRequest(value: unknown):
  | { ok: true; value: SupportChatRequest }
  | { ok: false; reason: string } {
  if (!isPlainObject(value)) return { ok: false, reason: "body must be an object" };

  const keys = Object.keys(value).sort();
  const allowedKeys = ["messages", "model", "page"];
  if (keys.some((key) => !allowedKeys.includes(key))) {
    return { ok: false, reason: "unsupported support field" };
  }

  if (!Array.isArray(value.messages) || value.messages.length === 0) {
    return { ok: false, reason: "messages must be a non-empty array" };
  }
  if (value.messages.length > SUPPORT_MAX_MESSAGES) {
    return { ok: false, reason: `messages must contain at most ${SUPPORT_MAX_MESSAGES} items` };
  }

  const messages: SupportMessage[] = [];
  for (const item of value.messages) {
    if (!isPlainObject(item) || !isSupportMessageRole(item.role)) {
      return { ok: false, reason: "message role must be user or assistant" };
    }
    const content = trimBoundedString(item.content, SUPPORT_MAX_MESSAGE_CHARS);
    if (!content) {
      return { ok: false, reason: `message content must be 1-${SUPPORT_MAX_MESSAGE_CHARS} characters` };
    }
    if (Object.keys(item).some((key) => key !== "role" && key !== "content")) {
      return { ok: false, reason: "unsupported message field" };
    }
    messages.push({ role: item.role, content });
  }

  if (!isPlainObject(value.page)) return { ok: false, reason: "page must be an object" };
  const pageKeys = Object.keys(value.page);
  if (pageKeys.some((key) => key !== "path" && key !== "tab")) {
    return { ok: false, reason: "unsupported page field" };
  }
  const path = trimBoundedString(value.page.path, SUPPORT_MAX_PAGE_PATH_CHARS);
  if (!path || !path.startsWith("/")) return { ok: false, reason: "page.path must be an internal path" };
  const tab = value.page.tab === undefined
    ? undefined
    : trimBoundedString(value.page.tab, SUPPORT_MAX_TAB_CHARS);
  if (value.page.tab !== undefined && !tab) {
    return { ok: false, reason: `page.tab must be at most ${SUPPORT_MAX_TAB_CHARS} characters` };
  }

  const model = value.model === undefined
    ? undefined
    : trimBoundedString(value.model, SUPPORT_MAX_MODEL_CHARS);
  if (value.model !== undefined && !model) {
    return { ok: false, reason: `model must be at most ${SUPPORT_MAX_MODEL_CHARS} characters` };
  }

  return {
    ok: true,
    value: {
      messages,
      page: { path, ...(tab ? { tab } : {}) },
      ...(model ? { model } : {}),
    },
  };
}

export function parseSupportExecuteRequest(value: unknown):
  | { ok: true; value: SupportExecuteRequest }
  | { ok: false; reason: string } {
  if (!isPlainObject(value) || Object.keys(value).some((key) => key !== "proposalId")) {
    return { ok: false, reason: "only proposalId is accepted" };
  }
  const proposalId = trimBoundedString(value.proposalId, 200);
  if (!proposalId) return { ok: false, reason: "proposalId is required" };
  return { ok: true, value: { proposalId } };
}

export function supportMessagesForStorage(messages: readonly SupportMessage[]): SupportMessage[] {
  return messages
    .slice(-SUPPORT_MAX_MESSAGES)
    .map(sanitizeSupportMessage)
    .filter((message) => message.content.length > 0);
}
