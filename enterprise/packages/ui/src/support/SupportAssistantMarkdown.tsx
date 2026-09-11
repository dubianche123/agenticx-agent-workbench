"use client";

import * as React from "react";
import { cn } from "../lib/cn";

type MarkdownBlock =
  | { kind: "paragraph"; lines: string[] }
  | { kind: "ul" | "ol"; items: string[] }
  | { kind: "heading"; level: number; text: string }
  | { kind: "code"; text: string };

const LINK_RE = /^\[([^\]\n]+)\]\(([^)\s]+)(?:\s+[^)]*)?\)$/;
const INLINE_TOKEN_RE = /(\[[^\]\n]+\]\((?:\/|https?:\/\/)[^)\s]+(?:\s+[^)]*)?\)|\*\*[^*\n]+\*\*|__[^_\n]+__|`[^`\n]+`|(?<!\*)\*[^*\n]+\*(?!\*)|(?<!_)_[^_\n]+_(?!_))/g;

function safeHref(value: string): string | null {
  const href = value.trim();
  if ((href.startsWith("/") && !href.startsWith("//")) || /^https?:\/\//i.test(href)) return href;
  return null;
}

function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  return text.split(INLINE_TOKEN_RE).filter((part) => part !== undefined && part !== "").map((part, index) => {
    const key = `${keyPrefix}-${index}`;
    const link = part.match(LINK_RE);
    if (link) {
      const label = link[1] ?? "";
      const href = safeHref(link[2] ?? "");
      if (href) {
        return (
          <a key={key} href={href} className="text-primary underline underline-offset-2 hover:text-primary/80">
            {label}
          </a>
        );
      }
      return <React.Fragment key={key}>{label}</React.Fragment>;
    }
    if ((part.startsWith("**") && part.endsWith("**")) || (part.startsWith("__") && part.endsWith("__"))) {
      return <strong key={key} className="font-semibold">{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith("`") && part.endsWith("`")) {
      return <code key={key} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.9em]">{part.slice(1, -1)}</code>;
    }
    if ((part.startsWith("*") && part.endsWith("*")) || (part.startsWith("_") && part.endsWith("_"))) {
      return <em key={key}>{part.slice(1, -1)}</em>;
    }
    return <React.Fragment key={key}>{part}</React.Fragment>;
  });
}

function renderInlineWithBreaks(text: string, keyPrefix: string): React.ReactNode[] {
  return text.split("\n").flatMap((line, index) => [
    ...(index > 0 ? [<br key={`${keyPrefix}-br-${index}`} />] : []),
    ...renderInline(line, `${keyPrefix}-${index}`),
  ]);
}

function parseBlocks(content: string): MarkdownBlock[] {
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let paragraph: string[] = [];
  let list: Extract<MarkdownBlock, { kind: "ul" | "ol" }> | null = null;
  let code: string[] | null = null;

  const flushParagraph = () => {
    if (paragraph.length) blocks.push({ kind: "paragraph", lines: paragraph });
    paragraph = [];
  };
  const flushList = () => {
    if (list) blocks.push(list);
    list = null;
  };
  const flushCode = () => {
    if (code) blocks.push({ kind: "code", text: code.join("\n") });
    code = null;
  };

  for (const line of lines) {
    if (code) {
      if (/^\s*```/.test(line)) flushCode();
      else code.push(line);
      continue;
    }
    if (/^\s*```/.test(line)) {
      flushParagraph();
      flushList();
      code = [];
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }
    const heading = line.match(/^\s*(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      flushParagraph();
      flushList();
      const hashes = heading[1] ?? "#";
      blocks.push({ kind: "heading", level: hashes.length, text: heading[2] ?? "" });
      continue;
    }
    const unordered = line.match(/^\s*[-+*]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (unordered || ordered) {
      flushParagraph();
      const kind = unordered ? "ul" : "ol";
      if (!list || list.kind !== kind) {
        flushList();
        list = { kind, items: [] };
      }
      const item = unordered?.[1] ?? ordered?.[1] ?? "";
      if (item) list.items.push(item);
      continue;
    }
    if (list) flushList();
    paragraph.push(line);
  }
  flushParagraph();
  flushList();
  flushCode();
  return blocks;
}

export function SupportAssistantMarkdown({ content, className }: { content: string; className?: string }) {
  const blocks = React.useMemo(() => parseBlocks(content), [content]);
  return (
    <div className={cn("support-assistant-markdown space-y-2 break-words text-sm leading-6", className)}>
      {blocks.map((block, index) => {
        const key = `block-${index}`;
        if (block.kind === "heading") {
          const headingTag = `h${Math.min(block.level, 6)}` as keyof React.JSX.IntrinsicElements;
          return React.createElement(
            headingTag,
            { key, className: "font-semibold leading-6" },
            renderInline(block.text, key),
          );
        }
        if (block.kind === "code") {
          return <pre key={key} className="overflow-x-auto rounded-lg bg-background/80 px-3 py-2 font-mono text-xs leading-5"><code>{block.text}</code></pre>;
        }
        if (block.kind === "ul" || block.kind === "ol") {
          const List = block.kind;
          return (
            <List key={key} className={cn("space-y-1 pl-5", block.kind === "ul" ? "list-disc" : "list-decimal")}>
              {block.items.map((item, itemIndex) => <li key={`${key}-${itemIndex}`}>{renderInlineWithBreaks(item, `${key}-${itemIndex}`)}</li>)}
            </List>
          );
        }
        if (block.kind === "paragraph") {
          return <p key={key}>{renderInlineWithBreaks(block.lines.join("\n"), key)}</p>;
        }
        return null;
      })}
    </div>
  );
}

export default SupportAssistantMarkdown;
