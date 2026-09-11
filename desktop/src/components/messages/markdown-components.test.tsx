import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import {
  chatMarkdownComponents,
  chatRemarkPlugins,
  chatUrlTransform,
  MarkdownContext,
} from "./markdown-components";

describe("chat markdown local artifact paths", () => {
  it("keeps long clickable paths inside narrow message bubbles", () => {
    const longPath =
      "/workspace/user/.agenticx/groups/370ac7979/2026-08-28-0813-各位-我们想做一个企业用的-agent/gr_606bd56418234.md";
    const html = renderToStaticMarkup(
      <MarkdownContext.Provider value={{ onRevealPath: vi.fn() }}>
        <ReactMarkdown components={chatMarkdownComponents}>{`\`${longPath}\``}</ReactMarkdown>
      </MarkdownContext.Provider>,
    );

    expect(html).toContain("<button");
    expect(html).toContain("max-w-full");
    expect(html).toContain("whitespace-normal");
    expect(html).toContain("break-all");
    expect(html).toContain("text-left");
    expect(html).toContain("[overflow-wrap:anywhere]");
    expect(html).toContain(longPath);
  });
});

describe("chat markdown @mentions", () => {
  it("highlights a visible member handoff in brand blue", () => {
    const html = renderToStaticMarkup(
      <ReactMarkdown
        remarkPlugins={chatRemarkPlugins}
        components={chatMarkdownComponents}
        urlTransform={chatUrlTransform}
      >
        {"需要工程评估。\n\n@产品需求全流程 · 技术负责人：请补充依赖关系。"}
      </ReactMarkdown>,
    );

    expect(html).toContain('data-chat-mention="true"');
    expect(html).toContain("text-[rgb(var(--theme-color-fg-rgb,59,130,246))]");
    expect(html).toContain("@产品需求全流程 · 技术负责人");
  });

  it("does not style email addresses, file mentions, or inline code as members", () => {
    const html = renderToStaticMarkup(
      <ReactMarkdown
        remarkPlugins={chatRemarkPlugins}
        components={chatMarkdownComponents}
        urlTransform={chatUrlTransform}
      >
        {"联系 dev@example.com，打开 @README.md，保留 `@技术负责人`。"}
      </ReactMarkdown>,
    );

    expect(html).not.toContain('data-chat-mention="true"');
  });
});
