import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { isMachiChatSessionDisplayed } from "./MachiChatView";

const source = readFileSync(new URL("./MachiChatView.tsx", import.meta.url), "utf8");

describe("MachiChatView attachment send session fence", () => {
  it("recognises only the conversation that was visible at send start", () => {
    expect(isMachiChatSessionDisplayed("session-a", "session-a")).toBe(true);
    expect(isMachiChatSessionDisplayed(" session-a ", "session-a")).toBe(true);
    expect(isMachiChatSessionDisplayed("session-a", "session-b")).toBe(false);
    expect(isMachiChatSessionDisplayed("session-a", null)).toBe(false);
    expect(isMachiChatSessionDisplayed("", "session-a")).toBe(false);
  });

  it("fences attachment awaits and keeps the explicit target session", () => {
    expect(source).toContain(
      'const sendSessionId = String(useChatStore.getState().activeSessionId ?? "").trim();',
    );
    expect(source).toContain("const isSendSessionDisplayed = () =>");
    expect(source).toContain("messageAttachments = await prepareImagesForTextModel(activeModel);");
    expect(source).toContain("targetSessionId: sendSessionId,");
    expect(source).toMatch(
      /messageAttachments = await prepareImagesForTextModel\(activeModel\);\s*if \(!isSendSessionDisplayed\(\)\) return;\s*setVisionWarning\(null\)/,
    );
    expect(source).toMatch(
      /const choice = await requestAttachmentRoutingChoice\(documentTarget\);\s*if \(!isSendSessionDisplayed\(\)\) return;/,
    );
    expect(source).toMatch(/isMachiChatSessionDisplayed\(\s*acceptedSessionId/);
  });
});
