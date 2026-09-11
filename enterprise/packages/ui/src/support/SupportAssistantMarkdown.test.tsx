import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SupportAssistantMarkdown } from "./SupportAssistantMarkdown";

describe("SupportAssistantMarkdown", () => {
  it("renders the common assistant emphasis and list syntax as elements", () => {
    const html = renderToStaticMarkup(
      <SupportAssistantMarkdown
        content={["你好", "", "**1. 先确认额度**", "", "- 今日：不限额", "- 本月：剩余 100"].join("\n")}
      />,
    );

    expect(html).toContain("<strong");
    expect(html).toContain("<ul");
    expect(html).toContain("今日：不限额");
    expect(html).not.toContain("**1.");
  });
});
