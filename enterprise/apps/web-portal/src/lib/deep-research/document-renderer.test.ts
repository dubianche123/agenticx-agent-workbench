import { describe, expect, it } from "vitest";
import {
  DOCUMENT_RENDER_MAX_CHARS,
  GENERATED_WORD_HTML_MARKER,
  DocumentRenderError,
  isGeneratedWordHtmlDocument,
  renderDocument,
} from "@agenticx/core-api";

describe("shared document renderer", () => {
  it("renders Markdown as UTF-8 text with a safe filename", () => {
    const result = renderDocument({ format: "md", title: "中文/报告", markdown: "# 你好\n\n表格" });
    expect(result.filename).toBe("中文 报告.md");
    expect(result.mimeType).toBe("text/markdown");
    expect(result.content).toContain("你好");
  });

  it("renders escaped Chinese, tables, and code in HTML", () => {
    const result = renderDocument({
      format: "html",
      title: "报告",
      markdown: "# 标题 <危险>\n\n[x](https://example.test/a?x=**foo**&q=`bar`&y=2)\n\n|列|值|\n|---|---|\n|甲|<script>alert(1)</script>|\n\n```ts\nconst x = '<tag>'\n```",
    });
    expect(result.mimeType).toBe("text/html");
    expect(result.content).toContain("标题");
    expect(result.content).toContain('href="https://example.test/a?x=**foo**&amp;q=`bar`&amp;y=2"');
    expect(result.content).not.toContain("&amp;amp;");
    expect(result.content).not.toContain("<strong>foo</strong>");
    expect(result.content).not.toContain("<code>bar</code>");
    expect(result.content).toContain("&lt;script&gt;");
    expect(result.content).toContain("language-ts");
    expect(result.content).not.toContain("<script>alert(1)</script>");
  });

  it("renders ordinary chart documents with offline inline SVG", () => {
    const result = renderDocument({
      format: "html",
      title: "图表",
      markdown: "```chart\n{" +
        '"type":"bar","title":"销量","x":["甲","乙"],"series":[{"name":"本期","data":[3,5]}]}' +
        "\n```",
    });
    expect(result.content).toContain('class="chart-wrap"');
    expect(result.content).toContain("<svg");
    expect(result.content).toContain("销量");
    expect(result.content).not.toContain("xychart-beta");
  });

  it("marks and detects only renderer generated Word HTML", () => {
    const result = renderDocument({ format: "doc", title: "报告", markdown: "# 结论" });
    expect(result.filename).toBe("报告.doc");
    expect(result.mimeType).toBe("application/vnd.ms-word");
    expect(result.content).toContain(GENERATED_WORD_HTML_MARKER);
    expect(isGeneratedWordHtmlDocument(result.content)).toBe(true);
    expect(isGeneratedWordHtmlDocument("\u0000legacy binary doc bytes")).toBe(false);
    expect(isGeneratedWordHtmlDocument("<html><body>arbitrary html</body></html>")).toBe(false);
  });

  it("rejects unknown formats and oversized input without truncation", () => {
    expect(() => renderDocument({ format: "pdf", title: "x", markdown: "x" })).toThrow(DocumentRenderError);
    expect(() => renderDocument({ format: "pdf", title: "x", markdown: "x" })).toThrow(/unsupported/);
    expect(() => renderDocument({ format: "md", title: "x", markdown: "x".repeat(DOCUMENT_RENDER_MAX_CHARS + 1) })).toThrow(/exceeds/);
  });
});
