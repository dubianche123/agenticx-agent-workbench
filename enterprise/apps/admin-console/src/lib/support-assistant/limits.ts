import { SUPPORT_MAX_MODEL_CHARS } from "@agenticx/ui/support/contracts";

export function sanitizeSupportText(value: unknown, maxChars = 12_000): string {
  const text = typeof value === "string" ? value : "";
  return text
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .trim()
    .slice(0, maxChars);
}

export function safeModelId(value: unknown): string | null {
  const model = sanitizeSupportText(value, SUPPORT_MAX_MODEL_CHARS);
  if (!model || !/^[A-Za-z0-9._:/@+-]+$/.test(model)) return null;
  return model;
}

export function safeTargetQuery(value: unknown): string | null {
  const query = sanitizeSupportText(value, 128);
  if (!query || query.length < 1) return null;
  return query;
}

export function safeTargetId(value: unknown): string | null {
  const id = sanitizeSupportText(value, 128);
  if (!id || !/^[A-Za-z0-9._:-]+$/.test(id)) return null;
  return id;
}

export function boundedNumber(value: unknown, max = 9_000_000_000_000_000): number | null {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  if (!Number.isSafeInteger(number) || number < 0 || number > max) return null;
  return number;
}

export function normalizeStringList(value: unknown, maxItems = 100): string[] | null {
  if (!Array.isArray(value) || value.length > maxItems) return null;
  const out: string[] = [];
  for (const item of value) {
    const id = safeModelId(item);
    if (!id) return null;
    if (!out.includes(id)) out.push(id);
  }
  return out;
}
