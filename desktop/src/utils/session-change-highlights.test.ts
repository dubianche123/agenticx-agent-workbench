import { describe, expect, it } from "vitest";
import type { Message } from "../store";
import { collectFileChangeHighlight, pathsReferToSameFile } from "./session-change-highlights";

function toolMsg(partial: Partial<Message> & Pick<Message, "id" | "content">): Message {
  return {
    role: "tool",
    timestamp: 1,
    ...partial,
  };
}

describe("collectFileChangeHighlight", () => {
  it("marks every line of a newly written file", () => {
    const abs = "/tmp/hello.py";
    const content = 'print("Hello World")\n';
    const highlight = collectFileChangeHighlight(
      [
        toolMsg({
          id: "w1",
          toolName: "file_write",
          toolArgs: { path: "hello.py", content },
          content: `OK: wrote ${abs}`,
        }),
      ],
      abs,
      content,
    );
    expect(highlight).toEqual({
      added: 1,
      removed: 0,
      addedLines: [1],
    });
  });

  it("paints file_edit new_string lines in the current file", () => {
    const abs = "/tmp/main.go";
    const content = `package main

func main() {
    fmt.Println("Hello World")
}
`;
    const highlight = collectFileChangeHighlight(
      [
        toolMsg({
          id: "e1",
          toolName: "file_edit",
          toolArgs: {
            path: abs,
            old_string: "fmt.Println(\"hi\")",
            new_string: "    fmt.Println(\"Hello World\")",
          },
          content: `OK: edited ${abs} (40 chars)`,
        }),
      ],
      abs,
      content,
    );
    expect(highlight?.addedLines).toEqual([4]);
    expect(highlight?.added).toBe(1);
    expect(highlight?.removed).toBe(1);
  });

  it("counts replacement lines independently instead of using the net delta", () => {
    const abs = "/tmp/replaced.txt";
    const content = "new one\nnew two\nnew three\n";
    const highlight = collectFileChangeHighlight(
      [
        toolMsg({
          id: "e2",
          toolName: "file_edit",
          toolArgs: {
            path: abs,
            old_string: "old one\nold two\n",
            new_string: content,
          },
          content: `OK: edited ${abs}`,
        }),
      ],
      abs,
      content,
    );
    expect(highlight?.added).toBe(3);
    expect(highlight?.removed).toBe(2);
  });

  it("returns null when the path was not written this session", () => {
    expect(
      collectFileChangeHighlight(
        [
          toolMsg({
            id: "w1",
            toolName: "file_write",
            toolArgs: { path: "/tmp/a.txt", content: "a\n" },
            content: "OK: wrote /tmp/a.txt",
          }),
        ],
        "/tmp/other.txt",
        "x\n",
      ),
    ).toBeNull();
  });

  it("matches relative toolArgs.path against an absolute preview path", () => {
    expect(pathsReferToSameFile("/tmp/proj/main.go", "main.go")).toBe(true);
    expect(pathsReferToSameFile("/tmp/proj/main.go", "other.go")).toBe(false);
  });

  it("ignores an explicitly owned write from another session", () => {
    const abs = "/tmp/hello.py";
    const content = 'print("Hello World")\n';
    expect(
      collectFileChangeHighlight(
        [
          toolMsg({
            id: "w-other",
            ownerSessionId: "session-b",
            toolName: "file_write",
            toolArgs: { path: abs, content },
            content: `OK: wrote ${abs}`,
          }),
        ],
        abs,
        content,
        "session-a",
      ),
    ).toBeNull();
  });
});
