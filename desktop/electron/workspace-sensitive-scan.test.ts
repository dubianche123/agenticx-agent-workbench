import * as fs from "node:fs/promises";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { scanWorkspaceSensitiveFiles, type WorkspaceScanFileSystem } from "./workspace-sensitive-scan";

const temporaryRoots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "agx-workspace-scan-"));
  temporaryRoots.push(root);
  return root;
}

describe("workspace sensitive filename scan", () => {
  it("matches suffixes without entering generated directories or reading content", async () => {
    const root = await makeRoot();
    await mkdir(path.join(root, "src", "nested"), { recursive: true });
    await mkdir(path.join(root, ".git"), { recursive: true });
    await mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
    await writeFile(path.join(root, "README.md"), "not read by this scanner");
    await writeFile(path.join(root, "src", "nested", "spec.PDF"), "also not read");
    await writeFile(path.join(root, ".git", "config.md"), "ignored");
    await writeFile(path.join(root, "node_modules", "pkg", "package.md"), "ignored");
    await writeFile(path.join(root, "src", "main.ts"), "not selected");

    const result = await scanWorkspaceSensitiveFiles({
      path: root,
      extensions: ["md", ".pdf"],
    });

    expect(result.ok).toBe(true);
    expect(result.matches.sort()).toEqual(["README.md", "src/nested/spec.PDF"].sort());
    expect(result.scanned).toBe(3);
    expect(result.truncated).toBe(false);
  });

  it("never calls a content-reading API", async () => {
    const root = await makeRoot();
    await writeFile(path.join(root, "notes.md"), "this content must not be opened");
    const readFile = vi.fn();
    const fileSystem: WorkspaceScanFileSystem & { readFile: typeof readFile } = {
      stat: fs.stat,
      readdir: fs.readdir,
      readFile,
    };

    const result = await scanWorkspaceSensitiveFiles(
      { path: root, extensions: [".md"] },
      fileSystem,
    );

    expect(result.matches).toEqual(["notes.md"]);
    expect(readFile).not.toHaveBeenCalled();
  });

  it("is bounded by file and match budgets", async () => {
    const root = await makeRoot();
    for (let index = 0; index < 5; index += 1) {
      await writeFile(path.join(root, `file-${index}.md`), "content");
    }
    const result = await scanWorkspaceSensitiveFiles({
      path: root,
      extensions: [".md"],
      maxFiles: 3,
      maxMatches: 2,
    });

    expect(result.ok).toBe(true);
    expect(result.scanned).toBe(3);
    expect(result.matches).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });

  it("continues through other branches when one branch exceeds the depth budget", async () => {
    const root = await makeRoot();
    await mkdir(path.join(root, "a-deep", "one", "two"), { recursive: true });
    await mkdir(path.join(root, "z-shallow"), { recursive: true });
    await writeFile(path.join(root, "z-shallow", "report.pdf"), "content");

    const result = await scanWorkspaceSensitiveFiles({
      path: root,
      extensions: [".pdf"],
      maxDepth: 1,
    });

    expect(result.ok).toBe(true);
    expect(result.matches).toContain("z-shallow/report.pdf");
    expect(result.truncated).toBe(true);
  });

  it("does not create or accept a file as a workspace root", async () => {
    const root = await makeRoot();
    const missing = path.join(root, "missing");
    const missingResult = await scanWorkspaceSensitiveFiles({ path: missing, extensions: [".md"] });
    expect(missingResult.ok).toBe(false);
    expect(missingResult.matches).toEqual([]);
    expect(missingResult.scanned).toBe(0);

    const file = path.join(root, "note.md");
    await writeFile(file, "content");
    const fileResult = await scanWorkspaceSensitiveFiles({ path: file, extensions: [".md"] });
    expect(fileResult.ok).toBe(false);
    expect(fileResult.error).toBe("path is not a directory");
  });
});
