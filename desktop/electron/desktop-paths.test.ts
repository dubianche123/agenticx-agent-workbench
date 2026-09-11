import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  resolveDesktopAgxHome,
  resolveDesktopMcpConfigPath,
  resolveDesktopUserDataDir,
} from "./desktop-paths";

const originalAgxHome = process.env.AGX_HOME;

afterEach(() => {
  if (originalAgxHome === undefined) {
    delete process.env.AGX_HOME;
  } else {
    process.env.AGX_HOME = originalAgxHome;
  }
});

describe("resolveDesktopAgxHome", () => {
  it("uses the isolated product default when AGX_HOME is empty", () => {
    delete process.env.AGX_HOME;
    expect(resolveDesktopAgxHome()).toBe(path.join(os.homedir(), ".agenticx-ontology"));
  });

  it("keeps a custom absolute AGX_HOME", () => {
    const customRoot = path.join(os.tmpdir(), "agenticx-ontology-test");
    process.env.AGX_HOME = customRoot;
    expect(resolveDesktopAgxHome()).toBe(customRoot);
  });

  it("expands the home shorthand", () => {
    process.env.AGX_HOME = "~";
    expect(resolveDesktopAgxHome()).toBe(os.homedir());
  });

  it("rejects a relative AGX_HOME", () => {
    process.env.AGX_HOME = "relative-ontology-root";
    expect(() => resolveDesktopAgxHome()).toThrow("AGX_HOME must be an absolute path");
  });

  it("places Electron profile data below the resolved product root", () => {
    const customRoot = path.join(os.tmpdir(), "agenticx-ontology-profile-test");
    process.env.AGX_HOME = customRoot;
    expect(resolveDesktopUserDataDir()).toBe(path.join(customRoot, "desktop-user-data"));
  });

  it("places MCP configuration below a custom isolated product root", () => {
    const customRoot = path.join(os.tmpdir(), "agenticx-ontology-mcp-test");
    process.env.AGX_HOME = customRoot;
    expect(resolveDesktopMcpConfigPath()).toBe(path.join(customRoot, "mcp.json"));
  });
});
