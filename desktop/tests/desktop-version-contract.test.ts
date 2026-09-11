import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const desktopRoot = process.cwd();

function read(relativePath: string): string {
  return fs.readFileSync(path.join(desktopRoot, relativePath), "utf8");
}

describe("desktop version injection contract", () => {
  it("keeps the sandbox preload free of local runtime requires", () => {
    const preload = read("electron/preload.ts");
    expect(preload).not.toContain("./desktop-version");
    expect(preload).not.toMatch(/require\(\s*["']\.\/desktop-version["']\s*\)/);
    expect(preload).toContain('parseArgvFlag("--agx-desktop-version=", "unknown")');
    expect(preload).toContain("version: injectedDesktopVersion");
  });

  it("injects the packaged Electron version from the main process", () => {
    const packageJson = JSON.parse(read("package.json")) as { version?: unknown };
    const main = read("electron/main.ts");

    expect(packageJson.version).toBe("2.0.0");
    expect(main).toContain("app.getVersion()");
    expect(main).toContain('`--agx-desktop-version=${encodeURIComponent(app.getVersion())}`');
  });
});
