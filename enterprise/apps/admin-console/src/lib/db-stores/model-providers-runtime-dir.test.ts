import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const storeSources = [
  "postgresql/model-providers-store.ts",
  "mysql/model-providers-store.ts",
] as const;

describe("model provider legacy runtime directory", () => {
  it.each(storeSources)("uses the shared runtime resolver (%s)", (relativePath) => {
    const source = readFileSync(new URL(`./${relativePath}`, import.meta.url), "utf8");
    expect(source).toContain("resolveRuntimeAdminDir");
    expect(source).toContain("const RUNTIME_DIR = resolveRuntimeAdminDir();");
    expect(source).not.toContain('path.resolve(process.cwd(), "../../.runtime/admin")');
  });
});
