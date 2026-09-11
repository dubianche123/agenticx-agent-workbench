import { describe, expect, it } from "vitest";

import { ConfigShareValidationError } from "../config-share-types";
import { v2ExpertManifest } from "../config-share-test-fixtures";
import { parseConfigMarketCreateRequest } from "./request";

const DEPT_ID = "01JQMZ8K3N4P5Q6R7S8T9VWXYZ";
const USER_ID = "01JQMZ8K3N4P5Q6R7S8T9VWXY0";

function request(visibility: unknown) {
  return { manifest: v2ExpertManifest(), visibility };
}

describe("config market create request", () => {
  it("accepts the strict company/department/user wire contract", () => {
    expect(
      parseConfigMarketCreateRequest(
        request({ type: "personal", department_ids: [], user_ids: [] }),
      ).visibility,
    ).toEqual({ visibility: "personal", visibleDepartmentIds: [], visibleUserIds: [] });
    expect(
      parseConfigMarketCreateRequest(
        request({ type: "company", department_ids: [], user_ids: [] }),
      ).visibility,
    ).toEqual({ visibility: "company", visibleDepartmentIds: [], visibleUserIds: [] });
    expect(
      parseConfigMarketCreateRequest(
        request({ type: "admins_only", department_ids: [], user_ids: [] }),
      ).visibility,
    ).toEqual({ visibility: "admins_only", visibleDepartmentIds: [], visibleUserIds: [] });
    expect(
      parseConfigMarketCreateRequest(
        request({ type: "departments", department_ids: [DEPT_ID], user_ids: [] }),
      ).visibility,
    ).toEqual({
      visibility: "departments",
      visibleDepartmentIds: [DEPT_ID],
      visibleUserIds: [],
    });
    expect(
      parseConfigMarketCreateRequest(
        request({ type: "users", department_ids: [], user_ids: [USER_ID] }),
      ).visibility,
    ).toEqual({ visibility: "users", visibleDepartmentIds: [], visibleUserIds: [USER_ID] });
  });

  it("rejects missing, mixed, duplicate, oversized, or unexpected audience fields", () => {
    const invalid = [
      { type: "personal", department_ids: [], user_ids: [USER_ID] },
      { type: "personal", department_ids: [DEPT_ID], user_ids: [] },
      { type: "departments", department_ids: [], user_ids: [] },
      { type: "users", department_ids: [DEPT_ID], user_ids: [USER_ID] },
      { type: "company", department_ids: [], user_ids: [USER_ID] },
      { type: "users", department_ids: [], user_ids: [USER_ID, USER_ID] },
      { type: "users", department_ids: [], user_ids: Array(65).fill(USER_ID) },
      { type: "company", department_ids: [], user_ids: [], tenant_id: "tenant-b" },
    ];
    for (const visibility of invalid) {
      expect(() => parseConfigMarketCreateRequest(request(visibility))).toThrow(
        ConfigShareValidationError,
      );
    }
  });

  it("does not widen the point-to-point share envelope or accept top-level identity fields", () => {
    expect(() =>
      parseConfigMarketCreateRequest({
        ...request({ type: "company", department_ids: [], user_ids: [] }),
        tenant_id: "tenant-b",
      }),
    ).toThrow(/exactly/);
    expect(() =>
      parseConfigMarketCreateRequest({
        manifest: v2ExpertManifest(),
      }),
    ).toThrow(/exactly/);
  });

  it("rejects unsafe Unicode controls in release notes", () => {
    expect(() => parseConfigMarketCreateRequest({
      ...request({ type: "company", department_ids: [], user_ids: [] }),
      release_notes: "looks safe\u202Ehidden",
    })).toThrow(/unsafe Unicode controls/);
  });

  it("does not let a market package require the publisher's local workspace", () => {
    expect(() => parseConfigMarketCreateRequest({
      ...request({ type: "company", department_ids: [], user_ids: [] }),
      manifest: {
        ...v2ExpertManifest(),
        workspace_slots: [{ name: "project_root", access: "read-only", required: true }],
      },
    })).toThrow(/workspace slots must be optional/);
  });
});
