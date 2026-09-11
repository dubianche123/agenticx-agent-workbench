/**
 * Generated `.doc` files are Word-compatible HTML. The marker is emitted by
 * the shared renderer and is intentionally required before routing a DOC to
 * the HTML iframe; arbitrary legacy binary DOC bytes must keep the Office
 * fallback path.
 */
export const GENERATED_WORD_HTML_MARKER = "agx-word-html-v1";

function decodePrefix(value: string | ArrayBuffer | Uint8Array): string {
  if (typeof value === "string") return value.slice(0, 64 * 1024);
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  return new TextDecoder("utf-8").decode(bytes.subarray(0, 64 * 1024));
}

export function isGeneratedWordHtmlDocument(
  value: string | ArrayBuffer | Uint8Array,
): boolean {
  const sample = decodePrefix(value).toLowerCase();
  return /<meta\b[^>]*\bname\s*=\s*["']agx-document-format["'][^>]*>/i.test(sample)
    && sample.includes(GENERATED_WORD_HTML_MARKER);
}
