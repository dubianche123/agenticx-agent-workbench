import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TurnArtifactCard } from "./TurnArtifactCard";

describe("TurnArtifactCard deliverable grid", () => {
  it("renders one artifact as a single card with a typed glyph", () => {
    const html = renderToStaticMarkup(
      <TurnArtifactCard paths={["/tmp/hello.txt"]} onOpenPath={() => undefined} />,
    );

    expect(html).toContain("hello.txt");
    expect(html).toContain('data-file-mark="txt"');
    expect(html).toContain('aria-label="预览 hello.txt"');
    expect(html).toContain('aria-label="另存为 hello.txt"');
    expect(html).toContain('aria-label="复制路径 hello.txt"');
    expect(html).toContain('aria-label="在文件夹中显示 hello.txt"');
    expect(html).toContain("预览");
    expect(html).toContain("h-5 w-5");
    expect(html).toContain("agx-artifact-tile");
    expect(html).toContain("bg-surface-popover");
    expect(html).toContain("agx-artifact-cq");
    expect(html).toContain("agx-artifact-grid--single");
    expect(html).not.toContain("agx-artifact-grid--multi");
    expect(html).toContain("w-max max-w-full");
    expect(html).not.toContain("justify-between");
  });

  it("keeps markdown and spreadsheet marks distinct", () => {
    const html = renderToStaticMarkup(
      <TurnArtifactCard
        paths={["/tmp/report.md", "/tmp/data.csv"]}
        onOpenPath={() => undefined}
      />,
    );

    expect(html).toContain("report.md");
    expect(html).toContain("data.csv");
    expect(html).toContain('data-file-mark="md"');
    expect(html).toContain('data-file-mark="sheet"');
    expect(html).toContain("agx-artifact-grid--multi");
    expect(html).toContain("justify-between");
  });

  it("does not repeat a file format when size metadata is unavailable", () => {
    const html = renderToStaticMarkup(
      <TurnArtifactCard paths={["/tmp/report.md"]} onOpenPath={() => undefined} />,
    );

    expect(html.match(/>MD<\/span>/g)).toHaveLength(1);
  });

  it("collapses past four files behind one expander", () => {
    const html = renderToStaticMarkup(
      <TurnArtifactCard
        paths={[
          "/tmp/a.md",
          "/tmp/b.gd",
          "/tmp/c.tscn",
          "/tmp/d.json",
          "/tmp/e.txt",
        ]}
        onOpenPath={() => undefined}
      />,
    );

    expect(html).toContain("查看全部 5 个产物");
    expect(html).not.toContain("e.txt");
  });

  it("opens the workbench via 查看所有产物 / 变更 when handlers are supplied", () => {
    const html = renderToStaticMarkup(
      <TurnArtifactCard
        paths={["/tmp/a.txt", "/tmp/b.txt", "/tmp/c.txt"]}
        onOpenPath={() => undefined}
        onOpenAllArtifacts={() => undefined}
        onOpenAllChanges={() => undefined}
        changeCount={3}
      />,
    );
    expect(html).toContain("查看所有产物 (3)");
    expect(html).toContain("查看所有变更 (3)");
    expect(html).toContain("flex-wrap items-center");
    expect(html).not.toContain("查看全部");
  });

  it("uses session-wide counts even when this turn has one file", () => {
    const html = renderToStaticMarkup(
      <TurnArtifactCard
        paths={["/tmp/c.txt"]}
        onOpenPath={() => undefined}
        onOpenAllArtifacts={() => undefined}
        onOpenAllChanges={() => undefined}
        artifactCount={3}
        changeCount={3}
      />,
    );
    expect(html).toContain("c.txt");
    expect(html).toContain("查看所有产物 (3)");
    expect(html).toContain("查看所有变更 (3)");
    expect(html).not.toContain("查看所有产物 (1)");
    expect(html).not.toContain("查看所有变更 (1)");
  });

  it("places one latest-turn undo action beside document tiles", () => {
    const html = renderToStaticMarkup(
      <TurnArtifactCard
        paths={["/tmp/report.docx"]}
        onOpenPath={() => undefined}
        undoTurn={{
          turnId: "turn-1",
          clientTurnId: "client-1",
          status: "completed",
          createdAt: "1",
          canUndo: true,
          files: [{ path: "/tmp/report.docx", change: "modified", addedLines: 1, removedLines: 1 }],
          artifacts: [{ path: "/tmp/report.docx", title: "报告", format: "docx" }],
        }}
        onUndoTurn={() => undefined}
      />,
    );
    expect(html).toContain("撤回本轮修改");
    expect(html).toContain('aria-label="撤回本轮修改"');
  });
});
