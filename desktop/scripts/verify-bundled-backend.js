// afterPack hook: fail the build if the embedded agx-server backend is missing
// from the packaged app. Mirrors the CI "Verify bundled backend" guard so that
// LOCAL electron-builder runs (which skip the workflow's verify steps) cannot
// silently ship a backend-less DMG/exe that would fall back to a PATH `agx`
// (possibly a stale pip install) at runtime.
const fs = require("fs");
const path = require("path");

exports.default = async function verifyBundledBackend(context) {
  const platform = context.electronPlatformName; // 'darwin' | 'win32' | 'linux'

  const rendererPath =
    platform === "darwin"
      ? path.join(
          context.appOutDir,
          `${context.packager.appInfo.productFilename}.app`,
          "Contents",
          "Resources",
          "document-renderer-runtime.cjs",
        )
      : path.join(context.appOutDir, "resources", "document-renderer-runtime.cjs");
  if (!fs.existsSync(rendererPath)) {
    throw new Error(
      `[afterPack] Document renderer runtime missing: ${rendererPath}\n` +
        "Run `npm run build:document-renderer` before packaging.",
    );
  }
  console.log(`[afterPack] Verified document renderer runtime: ${rendererPath}`);

  // Linux AppImage target does not bundle the backend (no extraResources/backend);
  // nothing to verify there.
  if (platform === "linux") return;

  const productFilename = context.packager.appInfo.productFilename; // e.g. "AgenticX Ontology"
  const exe = platform === "win32" ? "agx-server.exe" : "agx-server";
  const backendDir =
    platform === "darwin"
      ? path.join(context.appOutDir, `${productFilename}.app`, "Contents", "Resources", "backend")
      : path.join(context.appOutDir, "resources", "backend");

  const requiredBinaries = [path.join(backendDir, exe)];
  if (platform === "win32") {
    requiredBinaries.push(path.join(backendDir, "wxc-exec.exe"));
  }
  const missing = requiredBinaries.filter((binary) => !fs.existsSync(binary));
  if (missing.length > 0) {
    throw new Error(
      `[afterPack] Bundled runtime missing: ${missing.join(", ")}\n` +
        `Run the platform packaging script and stage desktop/bundled-backend/<arch>/ before packaging.`,
    );
  }
  console.log(`[afterPack] Verified bundled runtime: ${requiredBinaries.join(", ")}`);
};
