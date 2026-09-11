import { getAdminUser, listDepartmentAncestorIds } from "@agenticx/iam-core";

import { normalizeConfigMarketAudience, type ConfigMarketItem } from "./types";

export type ConfigMarketViewer = {
  tenantId: string;
  userId: string;
  deptId: string | null;
  /** Set only from trusted server-side IAM data; never accepted from a request body. */
  isAdmin?: boolean;
};

export async function resolveLiveConfigMarketViewer(
  identity: Pick<ConfigMarketViewer, "tenantId" | "userId">,
): Promise<ConfigMarketViewer | null> {
  try {
    const user = await getAdminUser(identity.tenantId, identity.userId);
    if (!user || user.tenantId !== identity.tenantId || user.status !== "active") return null;
    return {
      tenantId: user.tenantId,
      userId: user.id,
      deptId: user.deptId ?? null,
      ...(user.scopes?.includes("*") || user.scopes?.includes("admin:enter")
        ? { isAdmin: true }
        : {}),
    };
  } catch {
    // Restricted market links fail closed when the live directory cannot be checked.
    return null;
  }
}

export async function configMarketViewerDepartmentIds(
  viewer: ConfigMarketViewer,
): Promise<string[]> {
  if (!viewer.deptId) return [];
  return listDepartmentAncestorIds(viewer.tenantId, viewer.deptId);
}

export function isConfigMarketItemVisible(
  item: ConfigMarketItem,
  viewer: ConfigMarketViewer,
  viewerDepartmentIds: readonly string[],
): boolean {
  if (
    item.status !== "published" ||
    item.tenantId !== viewer.tenantId
  ) {
    return false;
  }
  // An administrator-only submission is intentionally invisible to the uploader
  // unless the uploader is also an administrator.  Do this before the normal
  // uploader attribution shortcut below.
  if (item.visibility === "admins_only") return viewer.isAdmin === true;
  // Attribution is immutable, so the original uploader remains able to retrieve a published item.
  if (item.userId === viewer.userId) return true;

  const audience = normalizeConfigMarketAudience(item);
  if (!audience) return false;
  if (audience.visibility === "personal") return false;
  if (audience.visibility === "company") return true;
  if (audience.visibility === "users") {
    return audience.visibleUserIds.includes(viewer.userId);
  }
  const ancestors = new Set(viewerDepartmentIds);
  return audience.visibleDepartmentIds.some((departmentId) => ancestors.has(departmentId));
}
