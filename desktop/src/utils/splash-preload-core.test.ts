import { describe, expect, it } from "vitest";
import { mapGroupsFromApi } from "./splash-preload-core";

describe("mapGroupsFromApi", () => {
  it("keeps explicit membership, host, and the group's shared workspace together", () => {
    const [group] = mapGroupsFromApi([
      {
        id: "group-1",
        name: "产品群",
        avatar_ids: ["host", "expert"],
        host_avatar_id: "host",
        workspace_dir: "/tmp/group-1-workspace",
      },
    ]);

    expect(group).toMatchObject({
      id: "group-1",
      avatarIds: ["host", "expert"],
      hostAvatarId: "host",
      workspaceDir: "/tmp/group-1-workspace",
    });
  });

  it("does not synthesize Meta membership while mapping a group", () => {
    const [group] = mapGroupsFromApi([
      {
        id: "group-2",
        name: "研发群",
        avatar_ids: ["engineer"],
        host_avatar_id: "__meta__",
      },
    ]);

    expect(group?.avatarIds).toEqual(["engineer"]);
    expect(group?.hostAvatarId).toBe("engineer");
  });
});
