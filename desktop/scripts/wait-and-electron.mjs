#!/usr/bin/env node
/**
 * Wait for the Vite dev server and compiled main process, then launch Electron.
 * Keeps wait-on port aligned with vite.config.ts / electron/main.ts via AGX_DEV_PORT.
 *
 * Author: Damon Li
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const DEFAULT_DEV_PORT = "5713";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = process.env.AGX_DEV_PORT || DEFAULT_DEV_PORT;
process.env.AGX_DEV_PORT = port;

function run(label, command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) {
    console.error(`[dev] ${label} failed:`, result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

const waitOnEntry = require.resolve("wait-on/bin/wait-on");
run("wait-on", process.execPath, [
  waitOnEntry,
  `tcp:${port}`,
  "dist-electron/main.js",
]);

const electronPath = require("electron");
const debugPortRaw = String(process.env.AGX_DEV_DEBUG_PORT || "").trim();
let debugArgs = [];
if (debugPortRaw) {
  if (!/^\d+$/.test(debugPortRaw)) {
    console.error("[dev] AGX_DEV_DEBUG_PORT must be a numeric TCP port");
    process.exit(1);
  }
  const debugPort = Number(debugPortRaw);
  if (!Number.isInteger(debugPort) || debugPort < 1 || debugPort > 65535) {
    console.error("[dev] AGX_DEV_DEBUG_PORT must be between 1 and 65535");
    process.exit(1);
  }
  // Explicit opt-in only. Keep Chromium's DevTools endpoint on loopback so
  // a local E2E harness can attach without exposing the desktop remotely.
  debugArgs = [
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${debugPort}`,
  ];
}
run("electron", electronPath, [...debugArgs, "."]);
