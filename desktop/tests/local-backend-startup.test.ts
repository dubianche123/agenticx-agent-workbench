import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  getServeStartupTimeoutMs,
  LOCAL_BACKEND_STARTUP_ENV,
  SERVE_READY_PATH,
  SERVE_READY_PROBE_TIMEOUT_MS,
} from "../electron/local-backend-startup";

describe("local backend startup stopgap", () => {
  it("keeps LiteLLM model metadata offline during Desktop boot", () => {
    expect(LOCAL_BACKEND_STARTUP_ENV).toEqual({
      LITELLM_LOCAL_MODEL_COST_MAP: "true",
    });
  });

  it("allows a slower Windows cold start without changing other platforms", () => {
    expect(getServeStartupTimeoutMs("win32")).toBe(90_000);
    expect(getServeStartupTimeoutMs("darwin")).toBe(45_000);
    expect(getServeStartupTimeoutMs("linux")).toBe(45_000);
  });

  it("bounds each readiness request so probes cannot hang indefinitely", () => {
    expect(SERVE_READY_PROBE_TIMEOUT_MS).toBe(2_000);
    expect(SERVE_READY_PATH).toBe("/api/health/ready");
  });

  it("passes the selected workspace to the backend while keeping launch cwd stable", () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), "electron/main.ts"), "utf8");
    const start = source.indexOf("const env: NodeJS.ProcessEnv = {");
    const end = source.indexOf("serveStdoutBuffer =", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    const startup = source.slice(start, end);
    expect(startup).toContain("AGX_WORKSPACE_ROOT: resolveMetaWorkspaceDir(cfg)");
    expect(startup).not.toContain("AGX_WORKSPACE_ROOT: desktopHome");
    expect(startup).toContain("{ cwd: CONFIG_DIR, stdio: [\"ignore\", \"pipe\", \"pipe\"], env }");
  });
});
