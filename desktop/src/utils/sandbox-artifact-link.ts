/**
 * Parse sandbox:/abs or file:///abs links into a plain absolute filesystem path.
 *
 * Models sometimes emit Claude-style `sandbox:` artifact links that the desktop
 * cannot open; parsing them here lets the chat renderer open the real file or
 * flag the link as a likely hallucination when the file does not exist.
 */
import { decodePercentEncodedLocalPath } from "./local-fs-path";

export type LocalArtifactPathCandidates = {
  /** Path exactly as encoded in the markdown destination (for IPC lookup). */
  rawPath: string;
  /** Human/open-preview fallback after one safe segment decode. */
  decodedPath: string;
};

export type LocalArtifactResolveResult = {
  ok: boolean;
  isDirectory?: boolean;
  resolvedPath?: string;
};

function rawPathFromArtifactUrl(url: string): string | null {
  const raw = String(url ?? "").trim();
  if (!raw) return null;
  let p = "";
  if (raw.startsWith("sandbox:")) {
    p = raw.slice("sandbox:".length);
    if (p.startsWith("//")) p = p.replace(/^\/+/, "/");
  } else if (/^file:\/\//i.test(raw)) {
    p = raw.replace(/^file:\/\//i, "");
    if (/^\/[a-zA-Z]:\//.test(p)) p = p.slice(1); // file:///C:/... → C:/...
  } else {
    return null;
  }
  p = p.trim();
  if (!p) return null;
  if (p.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(p)) return p;
  return null;
}

/**
 * Keep both URL forms.  The raw form lets the Electron boundary prefer a
 * literal `%xx` filename when it exists; the decoded form supports the usual
 * markdown URL-encoded CJK/space path.
 */
export function parseLocalArtifactPathCandidates(
  url: string,
): LocalArtifactPathCandidates | null {
  const rawPath = rawPathFromArtifactUrl(url);
  if (!rawPath) return null;
  return {
    rawPath,
    decodedPath: decodePercentEncodedLocalPath(rawPath),
  };
}

/** Return the literal URL path first, then the usual percent-decoded fallback. */
export function localArtifactPathCandidates(
  candidates: LocalArtifactPathCandidates | null | undefined,
): string[] {
  if (!candidates) return [];
  return [...new Set([candidates.rawPath, candidates.decodedPath].filter(Boolean))];
}

/**
 * Resolve a local artifact without losing literal percent characters.
 * A file literally named `report%20v1.md` must win over the decoded
 * `report v1.md`, while normal URL-encoded paths still use the decoded form.
 */
export async function resolveLocalArtifactPath(
  candidates: LocalArtifactPathCandidates,
  resolve: (path: string) => Promise<LocalArtifactResolveResult>,
): Promise<{ path: string; result: LocalArtifactResolveResult } | null> {
  for (const candidate of localArtifactPathCandidates(candidates)) {
    try {
      const result = await resolve(candidate);
      if (result.ok && !result.isDirectory) {
        return { path: result.resolvedPath || candidate, result };
      }
    } catch {
      // A malformed/literal candidate should not prevent the decoded fallback.
    }
  }
  return null;
}

export function parseLocalArtifactPath(url: string): string | null {
  return parseLocalArtifactPathCandidates(url)?.decodedPath ?? null;
}
