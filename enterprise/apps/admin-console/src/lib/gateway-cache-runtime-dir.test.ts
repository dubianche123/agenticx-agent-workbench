import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("gateway cache legacy runtime directory", () => {
  it("uses the shared runtime resolver when no explicit cache file is configured", () => {
    const source = readFileSync(new URL("./gateway-cache-store.ts", import.meta.url), "utf8");
    expect(source).toContain("resolveRuntimeAdminDir");
    expect(source).toContain('path.join(resolveRuntimeAdminDir(), "cache-config.json")');
    expect(source).not.toContain('path.resolve(process.cwd(), "../../.runtime/admin/cache-config.json")');
  });
});
