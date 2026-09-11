import { describe, expect, it } from "vitest";
import {
  GENERATED_WORD_HTML_MARKER,
  isGeneratedWordHtmlDocument,
} from "./generated-doc-preview";

describe("isGeneratedWordHtmlDocument", () => {
  it("accepts the shared renderer marker", () => {
    expect(
      isGeneratedWordHtmlDocument(
        `<html><head><meta name="agx-document-format" content="${GENERATED_WORD_HTML_MARKER}" /></head></html>`,
      ),
    ).toBe(true);
  });

  it("rejects arbitrary HTML and binary legacy DOC content", () => {
    expect(isGeneratedWordHtmlDocument("<html><body>legacy</body></html>")).toBe(false);
    expect(isGeneratedWordHtmlDocument(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]))).toBe(false);
  });
});
