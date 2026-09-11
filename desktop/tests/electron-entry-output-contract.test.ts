import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const desktopRoot = process.cwd();

function read(relativePath: string): string {
  return fs.readFileSync(path.join(desktopRoot, relativePath), "utf8");
}

describe("Electron entry output contract", () => {
  it("keeps every runtime import inside electron so tsc emits the configured main entry", () => {
    const pkg = JSON.parse(read("package.json")) as { main?: string };
    const tsconfig = JSON.parse(read("electron/tsconfig.json")) as {
      compilerOptions?: { outDir?: string; rootDir?: string };
      include?: string[];
    };
    const main = read("electron/main.ts");
    const preload = read("electron/preload.ts");

    expect(pkg.main).toBe("dist-electron/main.js");
    expect(tsconfig.compilerOptions?.rootDir).toBe(".");
    expect(tsconfig.compilerOptions?.outDir).toBe("../dist-electron");
    expect(tsconfig.include).toEqual(["*.ts"]);

    expect(main).toContain('from "./enterprise-capability-sync-state"');
    expect(preload).toContain('from "./enterprise-capability-sync-state"');
    expect(main).not.toMatch(/from\s+["']\.\.\/shared\//);
    expect(preload).not.toMatch(/from\s+["']\.\.\/shared\//);
  });
});
