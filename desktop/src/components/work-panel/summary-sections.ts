/** WorkPanel summary accordion state, including exclusive focused sections. */

export type SummarySectionId =
  | "todo"
  | "artifacts"
  | "changes"
  | "spawns"
  | "refs"
  | "members";

export const COLLAPSED_SUMMARY_SECTIONS: Record<SummarySectionId, boolean> = {
  todo: false,
  artifacts: false,
  changes: false,
  spawns: false,
  refs: false,
  members: false,
};

export function exclusiveOpenSections(
  section: SummarySectionId,
): Record<SummarySectionId, boolean> {
  return { ...COLLAPSED_SUMMARY_SECTIONS, [section]: true };
}

export function contentDrivenOpenSections(flags: {
  todo: boolean;
  artifacts: boolean;
  changes: boolean;
  spawns: boolean;
  refs: boolean;
  members: boolean;
}): Record<SummarySectionId, boolean> {
  return { ...flags };
}

export function applyPinnedAutoExpand(
  prev: Record<SummarySectionId, boolean>,
  id: SummarySectionId,
  shouldOpen: boolean,
  pinned: SummarySectionId | null,
): Record<SummarySectionId, boolean> {
  if (pinned != null && pinned !== id) return prev;
  if (pinned === id) return prev[id] ? prev : { ...prev, [id]: true };
  if (prev[id] === shouldOpen) return prev;
  return { ...prev, [id]: shouldOpen };
}
