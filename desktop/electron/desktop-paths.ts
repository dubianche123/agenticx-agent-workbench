import os from "node:os";
import path from "node:path";

const DESKTOP_USER_DATA_DIR_NAME = "desktop-user-data";

/** Resolve the product data root used by the Ontology desktop process. */
export function resolveDesktopAgxHome(): string {
  const configured = String(process.env.AGX_HOME ?? "").trim();
  if (!configured) return path.join(os.homedir(), ".agenticx-ontology");
  const expanded = configured === "~"
    ? os.homedir()
    : configured.startsWith("~/")
      ? path.join(os.homedir(), configured.slice(2))
      : configured;
  if (!path.isAbsolute(expanded)) {
    throw new Error("AGX_HOME must be an absolute path");
  }
  return path.normalize(expanded);
}

/** Resolve Electron's profile root inside the product data root. */
export function resolveDesktopUserDataDir(): string {
  return path.join(resolveDesktopAgxHome(), DESKTOP_USER_DATA_DIR_NAME);
}

/** Resolve the MCP document under the same isolated product root. */
export function resolveDesktopMcpConfigPath(): string {
  return path.join(resolveDesktopAgxHome(), "mcp.json");
}
