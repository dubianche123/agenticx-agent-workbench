import { describe, expect, it } from "vitest";
import { buildCcBridgeTailCommand, ccBridgeLogPathFromConfig } from "./ChatPane";

describe("CC bridge log path handoff", () => {
  it("accepts a log path only from a successful Studio response", () => {
    expect(
      ccBridgeLogPathFromConfig({ ok: true, log_path: "/tmp/custom-root/logs/cc-bridge/id.log" }),
    ).toBe("/tmp/custom-root/logs/cc-bridge/id.log");
    expect(ccBridgeLogPathFromConfig({ ok: false, log_path: "/tmp/should-not-use.log" })).toBeNull();
    expect(ccBridgeLogPathFromConfig({ ok: true, log_path: "   " })).toBeNull();
  });

  it("quotes server paths before passing them to the terminal shell", () => {
    const command = buildCcBridgeTailCommand("/tmp/custom root/o'log.log");
    expect(command).toContain(`LOG_FILE='/tmp/custom root/o'\"'\"'log.log'`);
    expect(command).toContain('tail -n 200 -f "$LOG_FILE"');
    expect(command).not.toContain("$HOME/.agenticx");
  });

  it("does not build a tail command without a trusted path", () => {
    expect(() => buildCcBridgeTailCommand(" ")).toThrow("log path is unavailable");
  });
});
