import { describe, expect, it } from "vitest";

import {
  attachmentNamesFromChatRequest,
  attachmentNamesFromMetadataHint,
} from "./attachment-request-hints";

describe("attachmentNamesFromChatRequest", () => {
  it("reads current-turn metadata independently from history", () => {
    expect(attachmentNamesFromMetadataHint([{ name: "new.docx" }, { name: "new.docx" }]))
      .toEqual(["new.docx"]);
  });
  it("reads and deduplicates explicit SDK hints", () => {
    expect(attachmentNamesFromChatRequest({
      agenticx_attachments: [
        { name: "report.pdf", mime_type: "application/pdf" },
        { name: "report.pdf", mime_type: "application/pdf" },
        { name: "photo.png", mime_type: "image/png" },
      ],
    })).toEqual(["report.pdf", "photo.png"]);
  });

  it("recognises the legacy parsed-document marker in string and text-part content", () => {
    expect(attachmentNamesFromChatRequest({
      messages: [
        { role: "user", content: "问题\n\n--- 附件: 年报.PDF ---\n正文" },
        {
          role: "user",
          content: [{ type: "text", text: "--- 附件: deck.pptx ---\n正文" }],
        },
      ],
    })).toEqual(["年报.PDF", "deck.pptx"]);
  });

  it("ignores user prose that is not an exact attachment marker", () => {
    expect(attachmentNamesFromChatRequest({
      messages: [{ role: "user", content: "请解释 --- 附件: report.pdf --- 这行文字" }],
    })).toEqual([]);
  });
});
