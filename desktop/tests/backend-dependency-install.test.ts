import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildDesktopRuntimeInstallPlan,
  buildSocksioInstallPlan,
  findBackendWheelhouse,
  isOfflineInstallRequested,
} from "../electron/backend-dependency-install";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeWheelhouse(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agenticx-wheelhouse-"));
  tempDirs.push(dir);
  fs.writeFileSync(path.join(dir, "agenticx-0.0.0-py3-none-any.whl"), "placeholder");
  return dir;
}

describe("backend dependency installation policy", () => {
  it("recognizes explicit offline flags without treating proxy variables as offline", () => {
    expect(isOfflineInstallRequested({ HTTP_PROXY: "http://proxy.local" })).toBe(false);
    expect(isOfflineInstallRequested({ AGX_OFFLINE_INSTALL: "1" })).toBe(true);
    expect(isOfflineInstallRequested({ AGX_NO_NETWORK: "true" })).toBe(true);
    expect(isOfflineInstallRequested({ PIP_NO_INDEX: "yes" })).toBe(true);
  });

  it("finds an installable wheelhouse from the configured environment", () => {
    const wheelhouse = makeWheelhouse();
    expect(
      findBackendWheelhouse({
        env: { AGX_BACKEND_WHEELHOUSE: wheelhouse },
        cwd: path.join(os.tmpdir(), "missing-agenticx-cwd"),
      }),
    ).toBe(path.resolve(wheelhouse));
  });

  it("builds a no-index plan for offline source checkouts and never upgrades pip", () => {
    const wheelhouse = makeWheelhouse();
    const plan = buildDesktopRuntimeInstallPlan({
      sourceRoot: "/workspace/AgenticX",
      wheelhouse,
      offline: true,
    });
    expect(plan.source).toBe("wheelhouse");
    expect(plan.networkRequired).toBe(false);
    expect(plan.args).toEqual([
      "-m",
      "pip",
      "install",
      "--no-index",
      "--find-links",
      wheelhouse,
      "--prefer-binary",
      "-e",
      "/workspace/AgenticX[desktop-runtime]",
    ]);
    expect(plan.args).not.toContain("-U");
  });

  it("fails fast when offline repair has no local package source", () => {
    const plan = buildDesktopRuntimeInstallPlan({ offline: true });
    expect(plan.source).toBe("unavailable");
    expect(plan.args).toEqual([]);
    expect(plan.networkRequired).toBe(true);
    expect(buildSocksioInstallPlan({ offline: true }).source).toBe("unavailable");
  });

  it("keeps the online fallback available when no wheelhouse is present", () => {
    const plan = buildDesktopRuntimeInstallPlan({ sourceRoot: null, offline: false });
    expect(plan.source).toBe("pypi");
    expect(plan.networkRequired).toBe(true);
    expect(plan.args).toEqual(["-m", "pip", "install", "--prefer-binary", "agenticx[desktop-runtime]"]);
  });
});
