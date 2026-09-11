import type { WorkspacePreview } from "../workspace/workspace-preview-types";

/** Snappier than the 3s workspace listing poll — agent file_write is usually atomic. */
export const PREVIEW_LIVE_RELOAD_MS = 1000;

type TextualPreview = Extract<WorkspacePreview, { kind: "text" | "markdown" | "code" }>;

export function isTextualWorkspacePreview(
  preview: WorkspacePreview | null | undefined,
): preview is TextualPreview {
  return (
    preview != null &&
    (preview.kind === "text" || preview.kind === "markdown" || preview.kind === "code")
  );
}

export function previewKnownMtimeMs(
  preview: WorkspacePreview | null | undefined,
): number | undefined {
  if (!isTextualWorkspacePreview(preview)) return undefined;
  return typeof preview.mtimeMs === "number" ? preview.mtimeMs : undefined;
}

export function isLiveReloadablePreview(
  preview: WorkspacePreview | null | undefined,
): boolean {
  return isTextualWorkspacePreview(preview);
}

export function shouldReloadPreviewFromStat(opts: {
  dirty: boolean;
  loading: boolean;
  knownMtimeMs?: number;
  diskMtimeMs?: number;
}): boolean {
  if (opts.dirty || opts.loading) return false;
  if (typeof opts.diskMtimeMs !== "number") return false;
  if (typeof opts.knownMtimeMs !== "number") return true;
  return Math.abs(opts.diskMtimeMs - opts.knownMtimeMs) > 1;
}

/**
 * Decide whether an async preview reload is still allowed to commit.
 *
 * A reload starts from a clean snapshot, but both the pane session and the
 * editor can change while the file read is in flight.  Keeping this predicate
 * pure makes the post-await fence explicit and easy to regression-test.
 */
export function canCommitPreviewReload(opts: {
  capturedSessionId: string;
  currentSessionId: string;
  capturedSessionGeneration: number;
  currentSessionGeneration: number;
  capturedEditGeneration: number;
  currentEditGeneration: number;
  dirty: boolean;
  activeTabMatches: boolean;
}): boolean {
  if (opts.capturedSessionId !== opts.currentSessionId) return false;
  if (opts.capturedSessionGeneration !== opts.currentSessionGeneration) return false;
  if (opts.capturedEditGeneration !== opts.currentEditGeneration) return false;
  if (opts.dirty && opts.activeTabMatches) return false;
  return true;
}

export function textualPreviewUnchanged(
  current: WorkspacePreview | null | undefined,
  next: WorkspacePreview,
): boolean {
  if (!isTextualWorkspacePreview(current) || !isTextualWorkspacePreview(next)) {
    return false;
  }
  return (
    current.absolutePath === next.absolutePath &&
    current.content === next.content &&
    current.mtimeMs === next.mtimeMs
  );
}
