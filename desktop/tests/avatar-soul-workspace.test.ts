import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const desktopRoot = fileURLToPath(new URL("../", import.meta.url));

describe("expert SOUL workspace bridge", () => {
  it("delegates expert SOUL reads and writes to Studio", () => {
    const main = fs.readFileSync(path.resolve(desktopRoot, "electron/main.ts"), "utf8");
    const start = main.indexOf('ipcMain.handle("load-avatar-soul"');
    const end = main.indexOf('ipcMain.handle("load-skills"', start);
    const handlers = main.slice(start, end);

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(handlers).toContain("fetchStudioBackend(");
    expect(handlers).toContain("/api/avatars/${encodeURIComponent(avatarId)}/soul");
    expect(handlers).toContain('method: "PUT"');
    expect(handlers).not.toContain("resolveAvatarSoulPath");
    expect(main).not.toContain('const AVATARS_DIR = path.join(CONFIG_DIR, "avatars")');
  });
});
