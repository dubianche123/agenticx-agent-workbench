import fs from "node:fs";
import path from "node:path";

import { load } from "js-yaml";
import { describe, expect, it } from "vitest";

type BuilderConfig = {
  win?: { target?: string[] };
  nsis?: {
    oneClick?: boolean;
    allowToChangeInstallationDirectory?: boolean;
  };
};

type DesktopPackage = {
  devDependencies?: Record<string, string>;
};

const CONFIG_FILES = ["electron-builder.yml", "electron-builder.signing.yml"];

describe("Windows installer configuration", () => {
  it.each(CONFIG_FILES)("offers an installation directory in %s", (fileName) => {
    const filePath = path.resolve(process.cwd(), fileName);
    const config = load(fs.readFileSync(filePath, "utf8")) as BuilderConfig;

    expect(config.win?.target).toContain("nsis");
    expect(config.nsis).toMatchObject({
      oneClick: false,
      allowToChangeInstallationDirectory: true,
    });
  });

  it("pins and stages the Microsoft MXC workspace sandbox", () => {
    const packageJson = JSON.parse(
      fs.readFileSync(path.resolve(process.cwd(), "package.json"), "utf8")
    ) as DesktopPackage;
    const packagingScript = fs.readFileSync(
      path.resolve(process.cwd(), "../packaging/build_windows_installer.ps1"),
      "utf8"
    );
    const afterPack = fs.readFileSync(
      path.resolve(process.cwd(), "scripts/verify-bundled-backend.js"),
      "utf8"
    );

    expect(packageJson.devDependencies?.["@microsoft/mxc-sdk"]).toBe("0.8.0");
    expect(packagingScript).toContain("mxc-sdk\\bin\\x64\\wxc-exec.exe");
    expect(packagingScript).toContain("BundledDir 'wxc-exec.exe'");
    expect(afterPack).toContain('path.join(backendDir, "wxc-exec.exe")');
  });
});
