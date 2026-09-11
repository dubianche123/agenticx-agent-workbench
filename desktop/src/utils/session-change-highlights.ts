/**
 * Line-level decorations for files that appear in WorkPanel「变更」.
 *
 * A change row is derived from successful file_write/file_edit tool rows. The
 * optional session owner keeps a pane's preview decorations scoped when a
 * late tool row from another session is still present in the in-memory list.
 */

import type { Message } from "../store";
import {
  firstWritePathFromToolMessage,
  isFailedWriteToolMessage,
  normalizeArtifactPathKey,
} from "./session-artifacts";

export type FileChangeHighlight = {
  added: number;
  removed: number;
  /** 1-based line numbers to paint as added. */
  addedLines: number[];
};

function countLines(text: string): number {
  const body = String(text || "").replace(/\r\n/g, "\n");
  if (!body) return 0;
  const parts = body.split("\n");
  if (parts.length > 0 && parts[parts.length - 1] === "") return parts.length - 1;
  return parts.length;
}

export function pathsReferToSameFile(left: string, right: string): boolean {
  const a = normalizeArtifactPathKey(left);
  const b = normalizeArtifactPathKey(right);
  if (!a || !b) return false;
  if (a === b) return true;
  return a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

function findNeedleLineRange(
  haystack: string,
  needle: string,
): { start: number; end: number } | null {
  const hay = String(haystack || "").replace(/\r\n/g, "\n");
  const pin = String(needle || "").replace(/\r\n/g, "\n");
  if (!pin) return null;
  const idx = hay.indexOf(pin);
  if (idx < 0) return null;
  const start = hay.slice(0, idx).split("\n").length;
  const span = countLines(pin);
  return { start, end: Math.max(start, start + span - 1) };
}

function addLineSpan(into: Set<number>, start: number, end: number): void {
  for (let i = start; i <= end; i += 1) {
    if (i > 0) into.add(i);
  }
}

/**
 * Resolve added-line decorations for one file from this session's write/edit
 * tools. `file_write` treats the current file as newly created (all lines
 * added); `file_edit` paints the `new_string` span when it still exists in
 * `currentContent`.
 *
 * The fourth argument is intentionally optional for compatibility with the
 * upstream three-argument helper. When supplied, rows carrying an explicit
 * ownerSessionId for a different session are ignored. Legacy rows without an
 * owner are retained because their session cannot be proven from the row.
 */
export function collectFileChangeHighlight(
  messages: Message[] | undefined | null,
  path: string,
  currentContent?: string,
  ownerSessionId?: string | null,
): FileChangeHighlight | null {
  const target = String(path || "").trim();
  if (!target) return null;

  let added = 0;
  let removed = 0;
  let saw = false;
  const lineSet = new Set<number>();
  const current = currentContent != null ? String(currentContent).replace(/\r\n/g, "\n") : "";
  const sid = String(ownerSessionId || "").trim();

  for (const message of messages ?? []) {
    if (sid && message.ownerSessionId && message.ownerSessionId !== sid) continue;
    if (message.role !== "tool") continue;
    const toolName = String(message.toolName || "").trim();
    if (toolName !== "file_write" && toolName !== "file_edit") continue;
    if (isFailedWriteToolMessage(message)) continue;
    const writePath = firstWritePathFromToolMessage(message);
    if (!writePath || !pathsReferToSameFile(writePath, target)) continue;
    saw = true;
    const args = message.toolArgs ?? {};

    if (toolName === "file_write") {
      const written = String(args.content ?? "");
      added += countLines(written);
      if (current) {
        const hit = findNeedleLineRange(current, written);
        if (hit) addLineSpan(lineSet, hit.start, hit.end);
        else addLineSpan(lineSet, 1, countLines(current));
      } else {
        addLineSpan(lineSet, 1, countLines(written));
      }
      continue;
    }

    const oldText = String(args.old_string ?? args.oldString ?? args.old_str ?? "");
    const newText = String(args.new_string ?? args.newString ?? args.new_str ?? args.content ?? "");
    const oldLines = countLines(oldText);
    const newLines = countLines(newText);
    // A replacement contributes both spans.  Do not report only the net
    // delta: replacing two lines with one is +1/-2, not 0/-1.
    added += newLines;
    removed += oldLines;
    const hay = current || newText;
    const hit = findNeedleLineRange(hay, newText);
    if (hit) addLineSpan(lineSet, hit.start, hit.end);
  }

  if (!saw) return null;
  return {
    added,
    removed,
    addedLines: [...lineSet].sort((a, b) => a - b),
  };
}
