import { describe, expect, it } from "vitest";
import {
  crewPhaseLabel,
  resolveCrewSlots,
  resolveGroupHostAvatarId,
  resolveGroupMemberActivity,
  resolveGroupSenderRoleLabel,
} from "./group-member-activity";

const AVATARS = ["wen", "cheng", "lin"];

describe("resolveGroupMemberActivity", () => {
  it("marks every member idle when only meta has spoken", () => {
    const out = resolveGroupMemberActivity(
      [
        { role: "assistant", agentId: "__meta__", timestamp: 1 },
        { role: "assistant", agentId: "__meta__", timestamp: 2 },
      ],
      AVATARS,
    );
    for (const id of AVATARS) {
      expect(out.get(id)?.state).toBe("idle");
      expect(out.get(id)?.replies).toBe(0);
    }
  });

  it("marks a member replied when they have assistant messages", () => {
    const out = resolveGroupMemberActivity(
      [
        { role: "assistant", agentId: "__meta__", timestamp: 1 },
        { role: "assistant", agentId: "cheng", timestamp: 2 },
        { role: "assistant", agentId: "cheng", timestamp: 3 },
      ],
      AVATARS,
    );
    expect(out.get("cheng")?.state).toBe("replied");
    expect(out.get("cheng")?.replies).toBe(2);
    expect(out.get("wen")?.state).toBe("idle");
    expect(out.get("lin")?.state).toBe("idle");
  });

  it("prefers running over replied when the member is active", () => {
    const out = resolveGroupMemberActivity(
      [{ role: "assistant", agentId: "cheng", timestamp: 1 }],
      AVATARS,
      ["cheng"],
    );
    expect(out.get("cheng")?.state).toBe("running");
    expect(out.get("cheng")?.replies).toBe(1);
  });

  it("does not project meta activity onto a different selected host", () => {
    const out = resolveGroupMemberActivity(
      [
        { role: "assistant", agentId: "__meta__", timestamp: 1 },
        { role: "assistant", agentId: "wen", timestamp: 2 },
      ],
      AVATARS,
      ["__meta__"],
      "wen",
    );
    expect(out.get("wen")).toMatchObject({ state: "replied", replies: 1 });
    expect(out.has("__meta__")).toBe(false);
  });
});

describe("resolveGroupHostAvatarId", () => {
  it("uses the configured member and falls back to the first real member", () => {
    expect(resolveGroupHostAvatarId(["host", "member"], "member")).toBe("member");
    expect(resolveGroupHostAvatarId(["host", "member"], "")).toBe("host");
    expect(resolveGroupHostAvatarId(["host", "member"], "missing")).toBe("host");
  });
});

describe("resolveGroupSenderRoleLabel", () => {
  it("marks only the configured real host", () => {
    expect(resolveGroupSenderRoleLabel("host", "host")).toBe("主持人");
    expect(resolveGroupSenderRoleLabel("member", "host")).toBeUndefined();
    expect(resolveGroupSenderRoleLabel(undefined, "host")).toBeUndefined();
  });
});

describe("resolveCrewSlots", () => {
  it("marks every member idle with empty messages and no active agents", () => {
    const slots = resolveCrewSlots({ avatarIds: AVATARS, messages: [] });
    expect(slots).toHaveLength(3);
    for (const slot of slots) {
      expect(slot.phase).toBe("idle");
      expect(slot.actionText).toBe("");
      expect(slot.elapsedMs).toBe(0);
    }
  });

  it("uses the running tool span for phase, elapsed time, and action text", () => {
    const [slot] = resolveCrewSlots({
      avatarIds: ["a1"],
      messages: [],
      runningToolByAgent: { a1: { toolName: "file_read", startMs: 1_000 } },
      nowMs: 4_000,
    });
    expect(slot?.phase).toBe("running");
    expect(slot?.elapsedMs).toBe(3000);
    expect(slot?.actionText).toContain("file_read");
  });

  it("prefers waiting override over an active/running member", () => {
    const [slot] = resolveCrewSlots({
      avatarIds: ["a1"],
      messages: [],
      activeAgentIds: ["a1"],
      phaseOverrideById: { a1: "waiting" },
    });
    expect(slot?.phase).toBe("waiting");
  });

  it("marks replied from assistant messages and labels the count", () => {
    const [slot] = resolveCrewSlots({
      avatarIds: ["a1"],
      messages: [
        { role: "assistant", agentId: "a1", timestamp: 1 },
        { role: "assistant", agentId: "a1", timestamp: 2 },
      ],
    });
    expect(slot?.phase).toBe("replied");
    expect(slot && crewPhaseLabel(slot)).toBe("已回复 2 次");
  });

  it("uses failed override for action text", () => {
    const [slot] = resolveCrewSlots({
      avatarIds: ["a1"],
      messages: [],
      phaseOverrideById: { a1: "failed" },
    });
    expect(slot?.phase).toBe("failed");
    expect(slot?.actionText).toBe("执行失败");
  });

  it("keeps the visible meta member separate after another member becomes host", () => {
    const slots = resolveCrewSlots({
      avatarIds: ["__meta__", "host", "member"],
      hostAvatarId: "host",
      messages: [
        { role: "assistant", agentId: "__meta__", timestamp: 1 },
        { role: "assistant", agentId: "host", timestamp: 2 },
        { role: "assistant", agentId: "member", timestamp: 3 },
      ],
      activeAgentIds: ["__meta__"],
      activityHintById: { __meta__: "正在组织下一位成员" },
      runningToolByAgent: {
        __meta__: { toolName: "web_search", startMs: 1_000 },
      },
      nowMs: 4_000,
    });

    expect(slots.map((slot) => slot.agentId)).toEqual(["__meta__", "host", "member"]);
    expect(slots[0]).toMatchObject({
      phase: "running",
      replies: 1,
      toolCalls: 0,
      elapsedMs: 3_000,
    });
    expect(slots[0]?.actionText).toContain("web_search");
    expect(slots[1]).toMatchObject({ phase: "replied", replies: 1 });
    expect(slots[2]).toMatchObject({ phase: "replied", replies: 1 });
  });
});
