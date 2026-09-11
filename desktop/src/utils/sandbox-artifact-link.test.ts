import { describe, expect, it } from "vitest";
import {
  parseLocalArtifactPath,
  parseLocalArtifactPathCandidates,
  resolveLocalArtifactPath,
} from "./sandbox-artifact-link";

describe("sandbox-artifact-link", () => {
  it("parses sandbox: absolute paths", () => {
    expect(parseLocalArtifactPath("sandbox:/workspace/user/a b.html")).toBe("/workspace/user/a b.html");
    expect(parseLocalArtifactPath("sandbox://workspace/user/x.html")).toBe("/workspace/user/x.html");
    expect(parseLocalArtifactPath("sandbox:/workspace/user/a%20b.html")).toBe("/workspace/user/a b.html");
  });

  it("parses file:// URLs", () => {
    expect(parseLocalArtifactPath("file:///workspace/user/a.html")).toBe("/workspace/user/a.html");
    expect(parseLocalArtifactPath("file:///C:/Users/a.html")).toBe("C:/Users/a.html");
  });

  it("rejects non-local or malformed links", () => {
    expect(parseLocalArtifactPath("https://x.com/a")).toBeNull();
    expect(parseLocalArtifactPath("sandbox:")).toBeNull();
    expect(parseLocalArtifactPath("sandbox:relative/x")).toBeNull();
    expect(parseLocalArtifactPath("")).toBeNull();
    expect(parseLocalArtifactPath("  ")).toBeNull();
  });

  it("keeps raw path on malformed percent escapes", () => {
    expect(parseLocalArtifactPath("sandbox:/a%zz")).toBe("/a%zz");
  });

  it("allows filesystem root", () => {
    expect(parseLocalArtifactPath("sandbox:/")).toBe("/");
  });

  it("keeps literal percent paths available before decoded fallback", async () => {
    const candidates = parseLocalArtifactPathCandidates("sandbox:/tmp/report%20v1.md");
    expect(candidates).toEqual({
      rawPath: "/tmp/report%20v1.md",
      decodedPath: "/tmp/report v1.md",
    });
    const seen: string[] = [];
    const result = await resolveLocalArtifactPath(candidates!, async (path) => {
      seen.push(path);
      return { ok: path === "/tmp/report%20v1.md", isDirectory: false, resolvedPath: path };
    });
    expect(seen).toEqual(["/tmp/report%20v1.md"]);
    expect(result?.path).toBe("/tmp/report%20v1.md");
  });

  it("falls back to decoded paths when only the decoded file exists", async () => {
    const candidates = parseLocalArtifactPathCandidates("sandbox:/tmp/report%20v1.md");
    const seen: string[] = [];
    const result = await resolveLocalArtifactPath(candidates!, async (path) => {
      seen.push(path);
      return { ok: path === "/tmp/report v1.md", isDirectory: false, resolvedPath: path };
    });
    expect(seen).toEqual(["/tmp/report%20v1.md", "/tmp/report v1.md"]);
    expect(result?.path).toBe("/tmp/report v1.md");
  });
});
