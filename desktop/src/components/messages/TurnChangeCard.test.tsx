import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TurnChangeCard } from "./TurnChangeCard";

const baseTurn = {
  turnId: "turn-1",
  status: "completed",
  createdAt: "2026-09-09T09:00:00Z",
  reason: undefined,
  files: [],
  artifacts: [],
};

describe("TurnChangeCard visibility", () => {
  it("does not render when the turn has no undo checkpoint", () => {
    const html = renderToStaticMarkup(
      <TurnChangeCard
        turn={{ ...baseTurn, canUndo: false }}
        onUndo={() => undefined}
      />,
    );

    expect(html).toBe("");
  });

  it("does not render an empty card when no visible file or artifact exists", () => {
    const html = renderToStaticMarkup(
      <TurnChangeCard
        turn={{ ...baseTurn, canUndo: true }}
        onUndo={() => undefined}
      />,
    );

    expect(html).toBe("");
  });

  it("renders an undo card when a visible file change exists", () => {
    const html = renderToStaticMarkup(
      <TurnChangeCard
        turn={{
          ...baseTurn,
          canUndo: true,
          files: [{ path: "src/app.ts", change: "modified", addedLines: 2, removedLines: 1 }],
        }}
        onUndo={() => undefined}
      />,
    );

    expect(html).toContain("文件变更");
    expect(html).toContain("src/app.ts");
    expect(html).toContain("撤回到此轮之前");
  });

  it("keeps document-only undo compact instead of repeating a diff table", () => {
    const html = renderToStaticMarkup(
      <TurnChangeCard
        turn={{
          ...baseTurn,
          canUndo: true,
          files: [{ path: "/tmp/report.docx", change: "modified", addedLines: 2, removedLines: 1 }],
        }}
        documentOnly
        onUndo={() => undefined}
      />,
    );

    expect(html).toContain("文档变更");
    expect(html).toContain("撤回本轮修改");
    expect(html).not.toContain("/tmp/report.docx");
    expect(html).not.toContain("撤回到此轮之前");
  });
});
