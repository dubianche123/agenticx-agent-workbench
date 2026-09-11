export type ExternalDraftReloadDecision =
  | "accept"
  | "mark-conflict"
  | "keep-local";

type ExternalDraftReloadState = {
  hydrated: boolean;
  draft: string;
  saved: string;
  disk: string;
};

/**
 * Reconcile a local-file-backed editor with a fresh disk snapshot.
 * Read failures are handled by the caller and must never be represented as an
 * empty file here.
 */
export function decideExternalDraftReload({
  hydrated,
  draft,
  saved,
  disk,
}: ExternalDraftReloadState): ExternalDraftReloadDecision {
  if (!hydrated) return "accept";
  if (draft === saved) return "accept";
  return disk === saved ? "keep-local" : "mark-conflict";
}
