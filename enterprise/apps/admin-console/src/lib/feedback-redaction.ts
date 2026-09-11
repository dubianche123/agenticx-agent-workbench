const SECRET_PATTERNS: RegExp[] = [
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{16,}\b/g,
  /\b(?:npm|pypi)_[A-Za-z0-9_-]{16,}\b/g,
  /\b(?:sk|pk|ak)[-_][A-Za-z0-9_-]{16,}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi,
  /\b(?:api[_ -]?key|api[_ -]?secret|access[_ -]?token|client[_ -]?secret|github[_ -]?token|aws[_ -]?(?:access[_ -]?)?key(?:[_ -]?id)?|password|passwd|pwd)\s*[:=]\s*["']?[^\s"']{6,}/gi,
];

const PII_PATTERNS: RegExp[] = [
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
  /(?<!\d)1[3-9]\d{9}(?!\d)/g,
  /(?<!\d)\d{17}[\dXx](?!\d)/g,
  /(?<!\d)(?:\d[ -]?){13,19}(?!\d)/g,
];

function stripReasoning(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, " ").replace(/<think>[\s\S]*$/gi, " ");
}

/** Admin feedback samples are previews, never a second copy of the full answer. */
export function redactFeedbackExcerpt(raw: string, limit = 320): string {
  let value = stripReasoning(raw ?? "");
  for (const pattern of SECRET_PATTERNS) value = value.replace(pattern, "[敏感信息已脱敏]");
  for (const pattern of PII_PATTERNS) value = value.replace(pattern, "[个人信息已脱敏]");
  value = value.replace(/\s+/g, " ").trim();
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}
