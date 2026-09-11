import { describe, expect, it } from "vitest";

import {
  attachmentExtensionOf,
  DISABLED_ATTACHMENT_ROUTING,
  DOCUMENT_EXTENSIONS,
  hasRoutedDocument,
  isLockedToRoutingTarget,
  type AttachmentRoutingPolicy,
} from "../attachment-routing";

const ROUTING_TARGET = {
  id: "qwen_local/qwen3.8-27b",
  provider: "qwen_local",
  model: "qwen3.8-27b",
  label: "本地推理/Qwen3.8 27B",
};

const ENABLED_POLICY: AttachmentRoutingPolicy = {
  enabled: true,
  allowPublicOverride: false,
  documentTarget: ROUTING_TARGET,
  documentExtensions: DOCUMENT_EXTENSIONS,
  imageStrategy: "vision-fallback",
  visionFallback: ROUTING_TARGET,
  maxRenderedPages: 20,
};

describe("DOCUMENT_EXTENSIONS", () => {
  it("includes every uploaded text format whose body is sent to the model", () => {
    expect(DOCUMENT_EXTENSIONS).toEqual([
      ".pdf",
      ".doc",
      ".docx",
      ".ppt",
      ".pptx",
      ".xls",
      ".xlsx",
      ".txt",
      ".md",
      ".csv",
      ".json",
    ]);
  });
});

describe("hasRoutedDocument", () => {
  it.each([".txt", ".md", ".csv", ".json"])(
    "routes a text attachment with the %s extension",
    (extension) => {
      expect(hasRoutedDocument([`/tmp/upload${extension}`], ENABLED_POLICY)).toBe(true);
    },
  );

  it("matches text attachments case-insensitively and alongside images", () => {
    expect(
      hasRoutedDocument(["C:\\Users\\alice\\README.MD", "screenshot.png"], ENABLED_POLICY),
    ).toBe(true);
  });

  it("does not treat a similarly named but unsupported suffix as a routed document", () => {
    expect(hasRoutedDocument(["notes.txt.bak", "data.jsonl"], ENABLED_POLICY)).toBe(false);
  });

  it("never fires while routing is disabled", () => {
    expect(hasRoutedDocument(["notes.txt", "README.md", "data.csv", "data.json"], DISABLED_ATTACHMENT_ROUTING)).toBe(
      false,
    );
  });
});

describe("attachmentExtensionOf", () => {
  it.each([
    ["report.pdf:3-5", ".pdf"],
    ["book.xlsx#Sheet1!A1", ".xlsx"],
    ["page.html:snippet-*", ".html"],
    ["/workspace/docs/README.MD#section-2", ".md"],
    ["C:\\workspace\\report.PDF:page-1", ".pdf"],
  ])("extracts %s as %s", (name, extension) => {
    expect(attachmentExtensionOf(name)).toBe(extension);
  });

  it("does not mistake an unsupported reference suffix for a document extension", () => {
    expect(attachmentExtensionOf("notes.txt.bak:snippet-1")).toBe(".bak");
    expect(attachmentExtensionOf("report:3-5")).toBe("");
  });
});

describe("isLockedToRoutingTarget", () => {
  it("recognises a session already pinned to the private target", () => {
    expect(
      isLockedToRoutingTarget(
        { provider: ROUTING_TARGET.provider, model: ROUTING_TARGET.model },
        ENABLED_POLICY,
      ),
    ).toBe(true);
    expect(isLockedToRoutingTarget({ provider: "zhipu", model: "glm-5.2" }, ENABLED_POLICY)).toBe(false);
    expect(isLockedToRoutingTarget(null, ENABLED_POLICY)).toBe(false);
  });
});
