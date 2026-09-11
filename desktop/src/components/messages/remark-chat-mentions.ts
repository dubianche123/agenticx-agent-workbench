import type { Link, PhrasingContent, Root, Text } from "mdast";
import type { Parent } from "unist";
import { visit } from "unist-util-visit";

// Match chat-style mentions while leaving email addresses and file mentions
// alone.  Team display names may contain a spaced middle dot, for example
// `@产品需求全流程 · 技术负责人`.
const CHAT_MENTION_RE =
  /(?<![A-Za-z0-9._%+-])@[\p{L}\p{N}_-]+(?:[ \t]*[·•・][ \t]*[\p{L}\p{N}_-]+)*(?=$|[\s：:，,。！？!、；;）)\]】」』])/gu;

function splitChatMentions(value: string): PhrasingContent[] {
  const nodes: PhrasingContent[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  CHAT_MENTION_RE.lastIndex = 0;

  while ((match = CHAT_MENTION_RE.exec(value))) {
    if (match.index > cursor) {
      nodes.push({ type: "text", value: value.slice(cursor, match.index) } as Text);
    }
    const label = match[0];
    nodes.push({
      type: "link",
      url: `agenticx-mention:${encodeURIComponent(label.slice(1))}`,
      children: [{ type: "text", value: label }],
    } as Link);
    cursor = match.index + label.length;
  }

  if (cursor < value.length) {
    nodes.push({ type: "text", value: value.slice(cursor) } as Text);
  }
  return nodes;
}

/** Turn plain @mentions into semantic nodes so every Markdown layout can style them. */
export default function remarkChatMentions() {
  return (tree: Root) => {
    visit(tree, "text", (node: Text, index, parent: Parent | undefined) => {
      if (index === undefined || !parent || parent.type === "link" || parent.type === "linkReference") {
        return undefined;
      }
      if (!node.value.includes("@")) return undefined;

      const replacement = splitChatMentions(node.value);
      if (replacement.length === 0 || (replacement.length === 1 && replacement[0].type === "text")) {
        return undefined;
      }
      parent.children.splice(index, 1, ...replacement);
      return index + replacement.length;
    });
  };
}
