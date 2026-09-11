/**
 * Neutral, deterministic document renderer used by Portal deep research and
 * the Desktop ordinary conversation tool.
 *
 * This file deliberately has no framework, filesystem, network, or runtime
 * package dependency. The Desktop build bundles it into the Electron app and
 * the Electron loopback host returns the rendered bytes to Python, which owns
 * the final file placement.
 */

import {
  chartSpecToGfmTable,
  chartSpecToSvg,
  chartSpecToXyChart,
  parseChartSpec,
} from "./document-chart";
export type { ChartSpec } from "./document-chart";

export type DocumentFormat = "md" | "html" | "doc";

export type DocumentRenderInput = {
  format: DocumentFormat | string;
  title: string;
  markdown: string;
};

export type DocumentRenderResult = {
  filename: string;
  mimeType: "text/markdown" | "text/html" | "application/vnd.ms-word";
  content: string;
};

export const DOCUMENT_RENDER_MAX_CHARS = 1_500_000;
export const GENERATED_WORD_HTML_MARKER = "agx-word-html-v1";

export class DocumentRenderError extends Error {
  readonly code: "invalid_input" | "unsupported_format" | "oversized_input";

  constructor(
    code: DocumentRenderError["code"],
    message: string,
  ) {
    super(message);
    this.name = "DocumentRenderError";
    this.code = code;
  }
}

export function escapeHtml(raw: string): string {
  return String(raw)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function safeHref(raw: string): string {
  const trimmed = String(raw).trim();
  if (!trimmed) return "#";
  if (trimmed.startsWith("#")) {
    const id = trimmed.slice(1);
    if (!id || /[\s\0]/.test(id)) return "#";
    return trimmed;
  }
  try {
    const url = new URL(trimmed);
    return url.protocol === "http:" || url.protocol === "https:" ? trimmed : "#";
  } catch {
    return "#";
  }
}

function slugifyHeading(text: string, used: Map<string, number>): string {
  let base = String(text)
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (!base) base = "section";
  const count = used.get(base) ?? 0;
  used.set(base, count + 1);
  return count === 0 ? base : `${base}-${count + 1}`;
}

export type TocEntry = { id: string; text: string; level: number };

function formatInlineText(text: string): string {
  let out = escapeHtml(text);
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
  return out;
}

function inlineMarkdown(text: string): string {
  // Escape the URL exactly once. Keep generated anchor markup out of the
  // following bold/code passes, otherwise markers in query values become
  // `<strong>`/`<code>` elements inside the href attribute.
  const links = /\[([^\]]+)\]\(([^)]+)\)/g;
  let out = "";
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = links.exec(text)) !== null) {
    out += formatInlineText(text.slice(cursor, match.index));
    const label = match[1] ?? "";
    const href = match[2] ?? "";
    out += `<a href="${escapeHtml(safeHref(href))}">${formatInlineText(label)}</a>`;
    cursor = match.index + match[0].length;
  }
  return out + formatInlineText(text.slice(cursor));
}

export type MarkdownToHtmlOptions = {
  /** Render chart fences as inline SVG so standalone HTML works offline. */
  offlineCharts?: boolean;
};

/** Minimal Markdown → HTML shared by ordinary docs and deep-research reports. */
export function markdownToHtml(
  markdown: string,
  options: MarkdownToHtmlOptions = {},
): { html: string; toc: TocEntry[] } {
  const toc: TocEntry[] = [];
  const usedIds = new Map<string, number>();
  const lines = String(markdown).replace(/\r\n/g, "\n").split("\n");
  const blocks: string[] = [];
  let i = 0;

  const flushParagraph = (buf: string[]) => {
    const text = buf.join("\n").trim();
    if (text) blocks.push(`<p>${inlineMarkdown(text).replace(/\n/g, "<br />")}</p>`);
  };

  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.startsWith("```")) {
      const lang = line.slice(3).trim();
      i += 1;
      const codeLines: string[] = [];
      while (i < lines.length && !(lines[i] ?? "").startsWith("```")) {
        codeLines.push(lines[i] ?? "");
        i += 1;
      }
      if (i < lines.length) i += 1;
      const source = codeLines.join("\n");
      const langLower = lang.toLowerCase();
      if (langLower === "mermaid") {
        const escaped = escapeHtml(source);
        blocks.push(`<div class="mermaid-wrap"><pre class="mermaid">${escaped}</pre><pre class="mermaid-fallback" hidden>${escaped}</pre></div>`);
      } else if (langLower === "chart") {
        const spec = parseChartSpec(source);
        const offlineSvg = options.offlineCharts && spec ? chartSpecToSvg(spec) : null;
        if (offlineSvg) {
          blocks.push(`<div class="chart-wrap">${offlineSvg}</div>`);
          continue;
        }
        const xyChart = spec ? chartSpecToXyChart(spec) : null;
        if (xyChart) {
          const escaped = escapeHtml(xyChart);
          blocks.push(`<div class="mermaid-wrap"><pre class="mermaid">${escaped}</pre><pre class="mermaid-fallback" hidden>${escaped}</pre></div>`);
        } else if (spec) {
          const svg = chartSpecToSvg(spec);
          blocks.push(svg ? `<div class="chart-wrap">${svg}</div>` : markdownToHtml(chartSpecToGfmTable(spec)).html);
        } else {
          blocks.push(`<pre><code class="language-chart">${escapeHtml(source)}</code></pre>`);
        }
      } else {
        const langAttr = lang ? ` class="language-${escapeHtml(lang)}"` : "";
        blocks.push(`<pre><code${langAttr}>${escapeHtml(source)}</code></pre>`);
      }
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = heading[1]!.length;
      const text = heading[2]!.trim();
      const id = slugifyHeading(text, usedIds);
      toc.push({ id, text, level });
      blocks.push(`<h${level} id="${escapeHtml(id)}">${inlineMarkdown(text)}</h${level}>`);
      i += 1;
      continue;
    }

    if (/^\|(.+)\|$/.test(line) && i + 1 < lines.length && /^\|[\s|:-]+\|$/.test(lines[i + 1] ?? "")) {
      const headerCells = line.split("|").slice(1, -1).map((cell) => cell.trim());
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\|(.+)\|$/.test(lines[i] ?? "")) {
        rows.push((lines[i] ?? "").split("|").slice(1, -1).map((cell) => cell.trim()));
        i += 1;
      }
      const thead = `<thead><tr>${headerCells.map((cell) => `<th>${inlineMarkdown(cell)}</th>`).join("")}</tr></thead>`;
      const tbody = `<tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${inlineMarkdown(cell)}</td>`).join("")}</tr>`).join("")}</tbody>`;
      blocks.push(`<table>${thead}${tbody}</table>`);
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i] ?? "")) {
        items.push((lines[i] ?? "").replace(/^\s*[-*]\s+/, ""));
        i += 1;
      }
      blocks.push(`<ul>${items.map((item) => `<li>${inlineMarkdown(item)}</li>`).join("")}</ul>`);
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i] ?? "")) {
        items.push((lines[i] ?? "").replace(/^\s*\d+\.\s+/, ""));
        i += 1;
      }
      blocks.push(`<ol>${items.map((item) => `<li>${inlineMarkdown(item)}</li>`).join("")}</ol>`);
      continue;
    }

    if (!line.trim()) {
      i += 1;
      continue;
    }
    const para: string[] = [];
    const paraStart = i;
    while (i < lines.length && (lines[i] ?? "").trim()) {
      const next = lines[i] ?? "";
      if (next.startsWith("#") || next.startsWith("```") || /^\s*[-*]\s+/.test(next) || /^\s*\d+\.\s+/.test(next) || /^\|(.+)\|$/.test(next)) break;
      para.push(next);
      i += 1;
    }
    // A malformed lone pipe row must still advance the scanner.
    if (i === paraStart) {
      para.push(line);
      i += 1;
    }
    flushParagraph(para);
  }
  return { html: blocks.join("\n"), toc };
}

const DOCUMENT_CSS = `
:root { color-scheme: light; --bg: #fff; --fg: #171717; --muted: #64748b; --border: #e2e8f0; --card: #f8fafc; --code-bg: #f1f5f9; }
* { box-sizing: border-box; }
body { margin: 0; padding: 2rem; background: var(--bg); color: var(--fg); font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; line-height: 1.7; }
main { max-width: 960px; margin: 0 auto; }
h1 { line-height: 1.3; margin: 0 0 1.5rem; }
.article h2 { margin-top: 2rem; }
.article a { color: #4f46e5; }
.article code { background: var(--code-bg); padding: .1em .35em; border-radius: 4px; }
.article pre { background: var(--code-bg); border: 1px solid var(--border); border-radius: 8px; padding: 1rem; overflow: auto; }
.article pre code { background: none; padding: 0; }
.article table { width: 100%; border-collapse: collapse; margin: 1rem 0; }
.article th, .article td { border: 1px solid var(--border); padding: .45rem .6rem; text-align: left; }
.article th { background: var(--card); }
.mermaid-wrap, .chart-wrap { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 1rem; overflow: auto; }
.chart-figure { margin: 0; display: flex; flex-direction: column; align-items: center; gap: .5rem; }
.chart-title { font-weight: 600; }
.chart-legend { display: flex; flex-wrap: wrap; gap: .5rem 1rem; color: var(--muted); font-size: .85rem; justify-content: center; }
.chart-legend-item { display: inline-flex; align-items: center; gap: .35rem; }
.chart-dot { display: inline-block; width: .65rem; height: .65rem; border-radius: 9999px; }
`.trim();

const DOCUMENT_FALLBACK_SCRIPT = `document.querySelectorAll('.mermaid').forEach(function(e){e.hidden=true});document.querySelectorAll('.mermaid-fallback').forEach(function(e){e.hidden=false});`;

/** Word-compatible HTML wrapper. Files use `.doc` and are intentionally HTML, not OOXML. */
export function renderWordHtmlDocument(title: string, bodyHtml: string): string {
  const safeTitle = escapeForWord(title);
  return `<!DOCTYPE html>
<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
<head>
<meta charset="utf-8" />
<meta name="agx-document-format" content="${GENERATED_WORD_HTML_MARKER}" />
<title>${safeTitle}</title>
<!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View></w:WordDocument></xml><![endif]-->
<style>body { font-family: "Segoe UI", "Microsoft YaHei", sans-serif; line-height: 1.6; } h1,h2,h3 { color: #3730a3; } a { color: #4f46e5; }</style>
</head><body>${bodyHtml}</body></html>`;
}

function escapeForWord(raw: string): string {
  return String(raw).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Marker-based detection prevents arbitrary legacy binary `.doc` files being parsed as HTML. */
export function isGeneratedWordHtmlDocument(content: string): boolean {
  const sample = String(content ?? "").slice(0, 64 * 1024).toLowerCase();
  return sample.includes(`name="agx-document-format"`) && sample.includes(GENERATED_WORD_HTML_MARKER);
}

function safeFilename(title: string, extension: string): string {
  const clean = String(title ?? "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+|\.+$/g, "")
    .slice(0, 120);
  return `${clean || "research-report"}.${extension}`;
}

export function renderHtmlDocument(title: string, markdown: string): string {
  const safeTitle = escapeHtml(title.trim() || "文档");
  const { html } = markdownToHtml(markdown, { offlineCharts: true });
  const hasMermaid = html.includes('class="mermaid"');
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>${safeTitle}</title><style>${DOCUMENT_CSS}</style></head><body><main><h1>${safeTitle}</h1><article class="article">${html}</article></main>${hasMermaid ? `<script>${DOCUMENT_FALLBACK_SCRIPT}</script>` : ""}</body></html>`;
}

/** Render a bounded document payload into UTF-8 text suitable for transport. */
export function renderDocument(input: DocumentRenderInput): DocumentRenderResult {
  if (!input || typeof input !== "object") {
    throw new DocumentRenderError("invalid_input", "document payload must be an object");
  }
  const format = String(input.format ?? "").trim().toLowerCase();
  if (format !== "md" && format !== "html" && format !== "doc") {
    throw new DocumentRenderError("unsupported_format", `unsupported document format: ${format || "(empty)"}`);
  }
  const markdown = typeof input.markdown === "string" ? input.markdown : "";
  if (markdown.length > DOCUMENT_RENDER_MAX_CHARS) {
    throw new DocumentRenderError("oversized_input", `document exceeds ${DOCUMENT_RENDER_MAX_CHARS} characters`);
  }
  const title = typeof input.title === "string" ? input.title.trim() : "";
  if (format === "md") return { filename: safeFilename(title, "md"), mimeType: "text/markdown", content: markdown };
  if (format === "html") return { filename: safeFilename(title, "html"), mimeType: "text/html", content: renderHtmlDocument(title, markdown) };
  return {
    filename: safeFilename(title, "doc"),
    mimeType: "application/vnd.ms-word",
    content: renderWordHtmlDocument(title || "文档", markdownToHtml(markdown).html),
  };
}

export {
  chartSpecToGfmTable,
  chartSpecToSvg,
  chartSpecToXyChart,
  parseChartSpec,
};
