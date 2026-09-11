import * as fs from "node:fs/promises";
import * as path from "node:path";

export type WorkspaceSensitiveScanPayload = {
  path: string;
  extensions: string[];
  maxFiles?: number;
  maxMatches?: number;
  maxDepth?: number;
};

export type WorkspaceSensitiveScanResult = {
  ok: boolean;
  matches: string[];
  scanned: number;
  truncated: boolean;
  error?: string;
};

const DEFAULT_MAX_FILES = 2000;
const DEFAULT_MAX_MATCHES = 100;
const DEFAULT_MAX_DEPTH = 8;
const MAX_FILES = 2000;
const MAX_MATCHES = 200;
const MAX_DEPTH = 12;

export type WorkspaceScanFileSystem = Pick<typeof fs, "stat" | "readdir">;

// These directories are either VCS/dependency/build output or commonly contain
// a very large number of generated files.  The scan only checks names, never
// opens file contents.
const IGNORED_DIRECTORY_NAMES = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  ".venv",
  "venv",
  "dist",
  "build",
  "out",
  ".next",
  "coverage",
  ".cache",
  ".turbo",
  "__pycache__",
]);

function normalizedExtensions(raw: unknown): Set<string> {
  if (!Array.isArray(raw)) return new Set();
  const values = raw
    .map((value) => String(value ?? "").trim().toLowerCase())
    .filter(Boolean)
    .map((value) => (value.startsWith(".") ? value : `.${value}`));
  return new Set(values);
}

function boundedInteger(value: unknown, fallback: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(parsed)));
}

/**
 * Scan a local directory by filename suffix only.
 *
 * This deliberately does not read file contents and has hard bounds so a
 * repository cannot turn a routing reminder into an unbounded filesystem job.
 */
export async function scanWorkspaceSensitiveFiles(
  payload: WorkspaceSensitiveScanPayload,
  fileSystem: WorkspaceScanFileSystem = fs,
): Promise<WorkspaceSensitiveScanResult> {
  const rawPath = String(payload?.path ?? "").trim();
  const extensions = normalizedExtensions(payload?.extensions);
  const maxFiles = boundedInteger(payload?.maxFiles, DEFAULT_MAX_FILES, MAX_FILES);
  const maxMatches = boundedInteger(payload?.maxMatches, DEFAULT_MAX_MATCHES, MAX_MATCHES);
  const maxDepth = boundedInteger(payload?.maxDepth, DEFAULT_MAX_DEPTH, MAX_DEPTH);
  if (!rawPath) {
    return { ok: false, matches: [], scanned: 0, truncated: false, error: "path is required" };
  }
  if (extensions.size === 0) {
    return { ok: true, matches: [], scanned: 0, truncated: false };
  }

  let root: string;
  try {
    root = path.resolve(rawPath);
    // The folder picker may return a user-created symlink to a directory.  It
    // is a valid root, while nested symlinks remain skipped below.
    const rootStat = await fileSystem.stat(root);
    if (!rootStat.isDirectory()) {
      return { ok: false, matches: [], scanned: 0, truncated: false, error: "path is not a directory" };
    }
  } catch (error) {
    return { ok: false, matches: [], scanned: 0, truncated: false, error: String(error) };
  }

  const matches: string[] = [];
  let scanned = 0;
  let truncated = false;
  let stop = false;
  const pending: Array<{ absolute: string; relative: string; depth: number }> = [
    { absolute: root, relative: "", depth: 0 },
  ];

  while (pending.length > 0 && !stop) {
    const current = pending.pop();
    if (!current) break;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fileSystem.readdir(current.absolute, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORY_NAMES.has(entry.name)) continue;
        if (current.depth >= maxDepth) {
          truncated = true;
          continue;
        }
        pending.push({
          absolute: path.join(current.absolute, entry.name),
          relative: current.relative ? `${current.relative}/${entry.name}` : entry.name,
          depth: current.depth + 1,
        });
        continue;
      }
      // Do not follow symlinked files/directories into another tree.
      if (!entry.isFile()) continue;
      if (scanned >= maxFiles) {
        truncated = true;
        stop = true;
        break;
      }
      scanned += 1;
      const suffix = path.extname(entry.name).toLowerCase();
      if (!extensions.has(suffix)) continue;
      const relative = current.relative ? `${current.relative}/${entry.name}` : entry.name;
      if (matches.length < maxMatches) {
        matches.push(relative.split(path.sep).join("/"));
      } else {
        truncated = true;
        stop = true;
        break;
      }
    }
  }

  return { ok: true, matches, scanned, truncated };
}
