export const GROUP_MENTION_ALL_ID = "__all__";

export type GroupMentionMember = {
  id: string;
  name: string;
};

type GroupMentionOptions = {
  metaId?: string;
  metaLabels?: string[];
};

const ALL_MEMBER_LABELS = ["所有人", "全体成员", "全部成员", "all", "everyone"];
const DISPLAY_NAME_ALIAS_SEPARATOR = /[·•・|｜/／]/;
const MENTION_BOUNDARY_PUNCTUATION =
  "，,。！？、；;：:．.（）()【】[]「」『』《》〈〉<>}{·•・|｜/／-";
const MENTION_PREFIX_WORD = /[A-Za-z0-9._%+@-]/;

function isMentionBoundary(char: string | undefined): boolean {
  return !char || /\s/.test(char) || MENTION_BOUNDARY_PUNCTUATION.includes(char);
}

function isMentionPrefixBoundary(char: string | undefined): boolean {
  // Keep Chinese prose such as `请@产品策划师` valid, while avoiding matches
  // embedded in email-like or otherwise word-like tokens.
  return !char || !MENTION_PREFIX_WORD.test(char);
}

function getDisplayNameAlias(name: string): string {
  const cleanName = String(name || "").trim();
  if (!cleanName || !DISPLAY_NAME_ALIAS_SEPARATOR.test(cleanName)) return "";

  const fragments = cleanName
    .split(DISPLAY_NAME_ALIAS_SEPARATOR)
    .map((fragment) => fragment.trim())
    .filter(Boolean);
  return fragments[fragments.length - 1] || "";
}

function pushUnique(out: string[], value: string): void {
  const id = String(value || "").trim();
  if (id && !out.includes(id)) out.push(id);
}

/**
 * Resolve visible group-chat @mentions in textual order.
 *
 * Names are matched as complete known labels instead of as a whitespace token,
 * because expert display names commonly contain spaces and separators. `@所有人`
 * expands to the room's real members only; the coordinator remains separately
 * addressable by name.
 */
export function extractGroupMentionIds(
  text: string,
  members: GroupMentionMember[],
  options: GroupMentionOptions = {},
): string[] {
  const raw = String(text || "").replace(/＠/g, "@");
  const lowered = raw.toLocaleLowerCase();
  const memberIds = members
    .map((member) => String(member.id || "").trim())
    .filter(Boolean);
  const matches: Array<{ start: number; length: number; ids: string[] }> = [];

  const addLabelMatches = (label: string, ids: string[]) => {
    const cleanLabel = String(label || "").trim();
    if (!cleanLabel || ids.length === 0) return;
    const needle = `@${cleanLabel.toLocaleLowerCase()}`;
    let from = 0;
    while (from < lowered.length) {
      const start = lowered.indexOf(needle, from);
      if (start < 0) break;
      const end = start + needle.length;
      if (isMentionPrefixBoundary(raw[start - 1]) && isMentionBoundary(raw[end])) {
        matches.push({ start, length: needle.length, ids });
      }
      from = start + 1;
    }
  };

  for (const label of ALL_MEMBER_LABELS) addLabelMatches(label, memberIds);
  for (const member of members) {
    addLabelMatches(member.name, [member.id]);
  }

  const aliases = new Map<string, Array<{ label: string; id: string }>>();
  for (const member of members) {
    const id = String(member.id || "").trim();
    const label = getDisplayNameAlias(member.name);
    if (!id || !label) continue;
    const key = label.toLocaleLowerCase();
    const candidates = aliases.get(key) || [];
    candidates.push({ label, id });
    aliases.set(key, candidates);
  }
  for (const candidates of aliases.values()) {
    // A short label shared by multiple members is intentionally not routable;
    // callers can still use either member's complete display name.
    if (candidates.length === 1) {
      addLabelMatches(candidates[0].label, [candidates[0].id]);
    }
  }

  const metaId = String(options.metaId || "").trim();
  if (metaId) {
    for (const label of options.metaLabels || []) addLabelMatches(label, [metaId]);
  }

  matches.sort((a, b) => a.start - b.start || b.length - a.length);
  const out: string[] = [];
  let consumedThrough = -1;
  for (const match of matches) {
    if (match.start < consumedThrough) continue;
    for (const id of match.ids) pushUnique(out, id);
    consumedThrough = match.start + match.length;
  }
  return out;
}

export function groupAllMentionMatchesQuery(query: string): boolean {
  const lowered = String(query || "").trim().toLocaleLowerCase();
  return (
    !lowered ||
    ALL_MEMBER_LABELS.some((label) => label.toLocaleLowerCase().includes(lowered))
  );
}
