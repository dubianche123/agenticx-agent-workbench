const MAX_ATTACHMENT_HINTS = 64;
const MAX_ATTACHMENT_NAME_CHARS = 512;
const DOCUMENT_MARKER = /^---\s*附件:\s*(.+?)\s*---\s*$/gmu;

function boundedName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim().slice(0, MAX_ATTACHMENT_NAME_CHARS);
  return value || null;
}

function textParts(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => {
    if (!part || typeof part !== "object" || Array.isArray(part)) return [];
    const row = part as Record<string, unknown>;
    return row.type === "text" && typeof row.text === "string" ? [row.text] : [];
  });
}

/** Parse one metadata-only hint array without consulting message text. */
export function attachmentNamesFromMetadataHint(raw: unknown): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  if (!Array.isArray(raw)) return names;
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const name = boundedName((item as Record<string, unknown>).name);
    if (!name || seen.has(name) || names.length >= MAX_ATTACHMENT_HINTS) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

/**
 * Read the metadata-only attachment hint sent by the browser SDK.
 *
 * The marker fallback keeps one-cycle compatibility with already-open tabs:
 * feature-chat has long rendered parsed documents into the prompt as
 * `--- 附件: name ---`, so those clients can still be routed safely until they
 * reload the new SDK bundle.
 */
export function attachmentNamesFromChatRequest(body: Record<string, unknown>): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  const add = (raw: unknown) => {
    const name = boundedName(raw);
    if (!name || seen.has(name) || names.length >= MAX_ATTACHMENT_HINTS) return;
    seen.add(name);
    names.push(name);
  };

  for (const name of attachmentNamesFromMetadataHint(body.agenticx_attachments)) {
    add(name);
  }

  if (names.length < MAX_ATTACHMENT_HINTS && Array.isArray(body.messages)) {
    for (const message of body.messages) {
      if (!message || typeof message !== "object" || Array.isArray(message)) continue;
      for (const text of textParts((message as Record<string, unknown>).content)) {
        DOCUMENT_MARKER.lastIndex = 0;
        for (const match of text.matchAll(DOCUMENT_MARKER)) add(match[1]);
      }
    }
  }

  return names;
}
