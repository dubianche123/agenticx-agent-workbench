import { describe, expect, it, vi } from "vitest";
import { studioFetch } from "./studio-fetch";
import {
  canOfferSessionTurnUndo,
  SessionTurnConflictError,
  fetchSessionTurns,
  isDocumentOnlyTurn,
  normalizeSessionTurns,
  undoSessionTurn,
  visibleSessionTurnDeliverablePaths,
} from "./session-turns";
import { isPrivateSessionArtifactPath } from "./session-artifacts";

vi.mock("./studio-fetch", () => ({
  studioFetch: vi.fn(),
}));

const mockedStudioFetch = vi.mocked(studioFetch);

describe("session turn delivery", () => {
  it("uses the authoritative deliverables list and suppresses superseded/runtime rows", () => {
    const runtimeRoot = "/Users/demo/.agenticx/taskspaces/session-a/default";
    const [turn] = normalizeSessionTurns({
      turns: [{
        turn_id: "t1",
        session_id: "session-a",
        client_turn_id: "client-1",
        status: "completed",
        can_undo: true,
        artifacts: [
          { path: "/workspace/current.docx", title: "当前文档", bytes: 120 },
          { path: "/workspace/old.docx", superseded: true },
          { path: `${runtimeRoot}/IDENTITY.md` },
        ],
        files: [
          { path: "/workspace/current.docx", change: "modified" },
          { path: `${runtimeRoot}/runtime.jsonl`, change: "modified" },
        ],
      }],
    });

    expect(turn).toMatchObject({
      sessionId: "session-a",
      clientTurnId: "client-1",
      deliverablesDeclared: true,
    });
    expect(turn?.artifacts).toEqual([
      expect.objectContaining({ path: "/workspace/current.docx", size: 120 }),
    ]);
    expect(turn?.files).toEqual([
      expect.objectContaining({ path: "/workspace/current.docx" }),
    ]);
    expect(visibleSessionTurnDeliverablePaths(turn!)).toEqual(["/workspace/current.docx"]);
  });

  it("derives an edited supported document when the manifest has no title metadata", () => {
    const [turn] = normalizeSessionTurns({
      turns: [{
        turn_id: "t1",
        can_undo: true,
        files: [{ path: "/workspace/edited.md", change: "modified" }],
      }],
    });
    expect(visibleSessionTurnDeliverablePaths(turn!)).toEqual(["/workspace/edited.md"]);
    expect(isDocumentOnlyTurn(turn!)).toBe(true);
  });

  it("allows undo only for the newest active server turn", () => {
    const [newest, older] = normalizeSessionTurns({
      turns: [
        { turn_id: "new", created_at: 20, can_undo: true },
        { turn_id: "old", created_at: 10, can_undo: true },
      ],
    });
    expect(canOfferSessionTurnUndo(newest!, [newest!, older!])).toBe(true);
    expect(canOfferSessionTurnUndo(older!, [newest!, older!])).toBe(false);
  });

  it("does not expose an older undo after the newest server turn was rewound", () => {
    const [rewound, older] = normalizeSessionTurns({
      turns: [
        { turn_id: "new", status: "rewound", created_at: 20, can_undo: true },
        { turn_id: "old", status: "completed", created_at: 10, can_undo: true },
      ],
    });
    expect(canOfferSessionTurnUndo(older!, [rewound!, older!])).toBe(false);
  });

  it("filters private scratch/log/checkpoint entries while retaining registered outputs", () => {
    expect(isPrivateSessionArtifactPath("~/.agenticx/sessions/s1/turns/t1/scratch/tmp.md")).toBe(true);
    expect(isPrivateSessionArtifactPath("/Users/demo/.agenticx/sessions/s1/turns/t1/logs/runtime.jsonl")).toBe(true);
    expect(isPrivateSessionArtifactPath("/Users/demo/.agenticx/sessions/s1/turns/t1/checkpoint.json")).toBe(true);
    expect(isPrivateSessionArtifactPath("~/.agenticx/sessions/s1/turns/t1/outputs/report.html")).toBe(false);
    expect(isPrivateSessionArtifactPath("/workspace/logs/report.md")).toBe(false);

    const [turn] = normalizeSessionTurns({
      turns: [
        {
          turn_id: "t1",
          status: "complete",
          created_at: "2026-09-09T00:00:00Z",
          can_undo: true,
          files: [
            { path: "~/.agenticx/sessions/s1/turns/t1/scratch/tmp.md", change: "added" },
            { path: "~/.agenticx/sessions/s1/turns/t1/outputs/report.md", change: "modified", added_lines: 3 },
          ],
          artifacts: [
            { path: "~/.agenticx/sessions/s1/turns/t1/logs/runtime.jsonl", title: "runtime" },
            { path: "~/.agenticx/sessions/s1/turns/t1/outputs/report.md", title: "报告", format: "md" },
          ],
        },
      ],
    });
    expect(turn?.files).toHaveLength(1);
    expect(turn?.files[0]?.path).toContain("outputs/report.md");
    expect(turn?.artifacts).toHaveLength(1);
    expect(turn?.artifacts[0]?.title).toBe("报告");
  });

  it("fetches turns by session and parses the server contract", async () => {
    mockedStudioFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ turns: [{ turn_id: "t1", status: "legacy", can_undo: false }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await expect(fetchSessionTurns({ sessionId: "session one", storeBase: "http://studio", apiToken: "token" })).resolves.toEqual([
      expect.objectContaining({ turnId: "t1", status: "legacy", canUndo: false }),
    ]);
    expect(mockedStudioFetch).toHaveBeenCalledWith(
      "/api/session/turns?session_id=session%20one",
      expect.objectContaining({ storeBase: "http://studio", apiToken: "token" }),
    );
  });

  it("surfaces 409 conflicts with conflict paths", async () => {
    mockedStudioFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ detail: "文件已经变化", conflict_paths: ["/workspace/report.md", "~/.agenticx/sessions/s1/turns/t1/logs/x"] }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const error = await undoSessionTurn({ sessionId: "s1", turnId: "t1" }).catch((caught) => caught);
    expect(error).toBeInstanceOf(SessionTurnConflictError);
    expect(error).toMatchObject({
      name: "SessionTurnConflictError",
      status: 409,
      conflictPaths: ["/workspace/report.md"],
    });
  });

  it("localizes the nested FastAPI conflict payload and keeps private paths out of the error", async () => {
    mockedStudioFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({
        detail: {
          code: "conflict",
          message: "workspace changed after the latest recorded turn",
          conflict_paths: [
            "/workspace/report.md",
            "~/.agenticx/sessions/s1/turns/t1/checkpoint/manifest.json",
          ],
        },
      }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const error = await undoSessionTurn({ sessionId: "s1", turnId: "t1" }).catch((caught) => caught);
    expect(error).toBeInstanceOf(SessionTurnConflictError);
    expect(error).toMatchObject({
      message: "文件在本轮后有改动，无法撤回；手工修改已保留",
      status: 409,
      conflictPaths: ["/workspace/report.md"],
    });
  });

  it("keeps non-conflict 409 reasons intact", async () => {
    mockedStudioFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({
        detail: { code: "busy", message: "cannot rewind while a turn is running" },
      }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const error = await undoSessionTurn({ sessionId: "s1", turnId: "t1" }).catch((caught) => caught);
    expect(error).toBeInstanceOf(SessionTurnConflictError);
    expect(error).toMatchObject({
      message: "cannot rewind while a turn is running",
      status: 409,
      conflictPaths: [],
    });
  });
});
