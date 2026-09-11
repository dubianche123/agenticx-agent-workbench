import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { load } from "js-yaml";
import { describe, expect, it } from "vitest";

type Resource = string | { from?: string; to?: string };
type BuilderConfig = { extraResources?: Resource[] };
type AfterPack = (context: unknown) => Promise<void>;

const CONFIG_FILES = ["electron-builder.yml", "electron-builder.signing.yml"];
const PRODUCT_FILENAME = "AgenticX Ontology";
const RENDERER_RESOURCE = {
  from: "dist-electron/document-renderer-runtime.cjs",
  to: "document-renderer-runtime.cjs",
};
const require = createRequire(import.meta.url);

function readAfterPack(): AfterPack {
  const loaded = require("../scripts/verify-bundled-backend.js") as {
    default?: AfterPack;
  } & AfterPack;
  return loaded.default ?? loaded;
}

describe("document renderer packaging", () => {
  it.each(CONFIG_FILES)("stages the renderer in %s", (fileName) => {
    const config = load(
      fs.readFileSync(path.resolve(process.cwd(), fileName), "utf8"),
    ) as BuilderConfig;
    expect(config.extraResources).toContainEqual(RENDERER_RESOURCE);
  });

  it("verifies a signed macOS app fixture without signing credentials", async () => {
    const appOutDir = fs.mkdtempSync(path.join(os.tmpdir(), "agx-after-pack-"));
    const resources = path.join(appOutDir, `${PRODUCT_FILENAME}.app`, "Contents", "Resources");
    fs.mkdirSync(path.join(resources, "backend"), { recursive: true });
    fs.writeFileSync(path.join(resources, "document-renderer-runtime.cjs"), "bundle");
    fs.writeFileSync(path.join(resources, "backend", "agx-server"), "server");
    try {
      await readAfterPack()({
        electronPlatformName: "darwin",
        appOutDir,
        packager: { appInfo: { productFilename: PRODUCT_FILENAME } },
      });
    } finally {
      fs.rmSync(appOutDir, { recursive: true, force: true });
    }
  });

  it("rejects a macOS app fixture missing the renderer", async () => {
    const appOutDir = fs.mkdtempSync(path.join(os.tmpdir(), "agx-after-pack-"));
    const resources = path.join(appOutDir, `${PRODUCT_FILENAME}.app`, "Contents", "Resources");
    fs.mkdirSync(path.join(resources, "backend"), { recursive: true });
    fs.writeFileSync(path.join(resources, "backend", "agx-server"), "server");
    try {
      await expect(
        readAfterPack()({
          electronPlatformName: "darwin",
          appOutDir,
          packager: { appInfo: { productFilename: PRODUCT_FILENAME } },
        }),
      ).rejects.toThrow("Document renderer runtime missing");
    } finally {
      fs.rmSync(appOutDir, { recursive: true, force: true });
    }
  });
});
