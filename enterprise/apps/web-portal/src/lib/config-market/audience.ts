import {
  getAdminUser,
  getDepartment,
  listAudienceUsers,
  listDepartmentsFlat,
} from "@agenticx/iam-core";

import { ConfigShareValidationError } from "../config-share-types";
import type { ConfigMarketAudience } from "./types";

export async function assertConfigMarketAudienceTargets(
  tenantId: string,
  audience: ConfigMarketAudience,
): Promise<void> {
  if (audience.visibility === "departments") {
    const rows = await Promise.all(
      audience.visibleDepartmentIds.map((id) => getDepartment(tenantId, id)),
    );
    if (rows.some((row) => !row || row.tenantId !== tenantId)) {
      throw new ConfigShareValidationError(
        "visible departments must exist in the authenticated tenant",
      );
    }
  }
  if (audience.visibility === "users") {
    const rows = await Promise.all(
      audience.visibleUserIds.map((id) => getAdminUser(tenantId, id)),
    );
    if (rows.some((row) => !row || row.tenantId !== tenantId || row.status !== "active")) {
      throw new ConfigShareValidationError(
        "visible users must be active users in the authenticated tenant",
      );
    }
  }
}

export type ConfigMarketAudienceDirectory = {
  departments: Array<{ id: string; name: string; path: string }>;
  users: Array<{
    id: string;
    displayName: string;
    email: string;
    deptId: string | null;
  }>;
};

export async function listConfigMarketAudienceDirectory(input: {
  tenantId: string;
  q?: string;
  limit: number;
  offset: number;
}): Promise<ConfigMarketAudienceDirectory> {
  const query = input.q?.trim().toLocaleLowerCase() ?? "";
  const [departmentRows, userRows] = await Promise.all([
    listDepartmentsFlat(input.tenantId),
    listAudienceUsers(input.tenantId, {
      ...(query ? { q: query } : {}),
      limit: input.limit,
      offset: input.offset,
    }),
  ]);
  const departments = departmentRows
    .filter((row) => {
      if (!query) return true;
      return row.name.toLocaleLowerCase().includes(query) || row.path.toLocaleLowerCase().includes(query);
    })
    .slice(input.offset, input.offset + input.limit)
    .map((row) => ({ id: row.id, name: row.name, path: row.path }));
  const users = userRows.map((row) => ({ ...row, deptId: row.deptId ?? null }));
  return { departments, users };
}
