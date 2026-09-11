import YAML from "yaml";

export type SkillFrontMatter = {
  name: string;
  description: string;
};

/**
 * Read only the small YAML header used to identify a SKILL.md.
 *
 * This is a format check, not a security verdict. Using the YAML parser keeps
 * ordinary quoted values, comments and block-scalar descriptions valid while
 * malformed or duplicate-key documents fail closed.
 */
export function parseSkillFrontMatter(markdown: string): SkillFrontMatter | null {
  if (typeof markdown !== "string") return null;
  const lines = markdown.split(/\r?\n/u);
  if (lines[0]?.trim() !== "---") return null;
  const closingOffset = lines.slice(1).findIndex((line) => line.trim() === "---");
  if (closingOffset < 0) return null;

  const source = lines.slice(1, closingOffset + 1).join("\n");
  try {
    const document = YAML.parseDocument(source, { uniqueKeys: true });
    if (document.errors.length > 0) return null;
    const value = document.toJS({ maxAliasCount: 0 }) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const row = value as Record<string, unknown>;
    if (typeof row.name !== "string" || typeof row.description !== "string") return null;
    const name = row.name.trim();
    const description = row.description.trim();
    return name && description ? { name, description } : null;
  } catch {
    return null;
  }
}
