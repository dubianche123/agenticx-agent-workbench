import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("ChatPane attachment routing status contract", () => {
  it("projects the persistent private lock from the currently displayed session", () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), "src/components/ChatPane.tsx"),
      "utf8",
    );

    expect(source).toContain("const activeAttachmentRoutingLock = useAppStore((state) => {");
    expect(source).toContain('const sessionId = String(pane?.sessionId ?? "").trim();');
    expect(source).toContain("state.attachmentRoutingLocks[sessionId] ?? null");
    expect(source).toContain("<AttachmentRoutingStatusBanner");
    expect(source).toContain("lockedTarget={activeAttachmentRoutingLock}");
    expect(source).toContain('scopeKey={`${pane.id}:${String(pane.sessionId ?? "new").trim() || "new"}`}');
  });

  it("uses the persistent status banner instead of the stale component-level toast", () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), "src/components/ChatPane.tsx"),
      "utf8",
    );

    expect(source).not.toContain("const [routingNotice, setRoutingNotice]");
    expect(source).not.toContain("routingNoticeDismissed()");
    expect(source).not.toContain("不再显示此提示");
    expect(source).toContain('{routingPickerState === "private" ? "私有" : "待确认"}');
    expect(source).toContain("routingPickerLock.disabled ? (");
    expect(source).toContain('<LockKeyhole className="h-3.5 w-3.5 shrink-0 text-text-muted"');
  });
});
