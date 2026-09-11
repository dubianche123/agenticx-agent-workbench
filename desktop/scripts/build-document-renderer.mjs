#!/usr/bin/env node
/** Bundle the neutral document renderer for the Electron main process. */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(desktopRoot, "..");
const entry = path.join(repoRoot, "enterprise", "packages", "core-api", "src", "document-renderer.ts");
const outfile = path.join(desktopRoot, "dist-electron", "document-renderer-runtime.cjs");

await build({
  entryPoints: [entry],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  outfile,
  sourcemap: false,
  minify: false,
  legalComments: "none",
  logLevel: "info",
});
