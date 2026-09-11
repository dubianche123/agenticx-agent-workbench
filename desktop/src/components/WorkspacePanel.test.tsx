import { describe, expect, it, vi } from "vitest";

import {
  registerMountedWorkspaceDirectories,
  shouldReconcileActiveTaskspace,
} from "./WorkspacePanel";

describe("workspace catalog registration", () => {
  it("does not let a stale startup snapshot replace a newly selected workspace", () => {
    const cached = [{ id: "default", label: "默认", path: "/session/default" }];

    expect(shouldReconcileActiveTaskspace(cached, "ts-new", false)).toBe(false);
    expect(shouldReconcileActiveTaskspace(cached, "ts-new", true)).toBe(true);
  });

  it("registers successful directories when another selected mount failed", async () => {
    const statLocalPath = vi.fn(async (path: string) => ({
      ok: true,
      isDirectory: path !== "/workspaces/missing",
    }));
    const registerTaskspace = vi.fn(async ({ path }: { path: string }) => ({ ok: true }));

    const registered = await registerMountedWorkspaceDirectories(
      ["/workspaces/project", "/workspaces/missing", "/workspaces/docs"],
      ["/workspaces/missing"],
      { statLocalPath, registerTaskspace },
    );

    expect(registered).toEqual(["/workspaces/project", "/workspaces/docs"]);
    expect(statLocalPath).toHaveBeenCalledTimes(2);
    expect(statLocalPath).toHaveBeenCalledWith("/workspaces/project");
    expect(statLocalPath).toHaveBeenCalledWith("/workspaces/docs");
    expect(registerTaskspace).toHaveBeenCalledTimes(2);
    expect(registerTaskspace.mock.calls.map(([payload]) => payload.path)).toEqual([
      "/workspaces/project",
      "/workspaces/docs",
    ]);
  });

  it("keeps a registration failure local and continues with other directories", async () => {
    const statLocalPath = vi.fn(async () => ({ ok: true, isDirectory: true }));
    const registerTaskspace = vi.fn(async ({ path }: { path: string }) =>
      path === "/workspaces/project"
        ? { ok: false, error: "permission denied" }
        : { ok: true },
    );
    const onRegistrationFailure = vi.fn();

    const registered = await registerMountedWorkspaceDirectories(
      ["/workspaces/project", "/workspaces/docs"],
      [],
      { statLocalPath, registerTaskspace },
      undefined,
      onRegistrationFailure,
    );

    expect(registered).toEqual(["/workspaces/docs"]);
    expect(onRegistrationFailure).toHaveBeenCalledWith("/workspaces/project", "permission denied");
  });
});
