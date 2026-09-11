import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const treeSource = readFileSync(
  new URL("./DepartmentFilterTree.tsx", import.meta.url),
  "utf8",
);
const membersPageSource = readFileSync(
  new URL("../app/iam/roles/page.tsx", import.meta.url),
  "utf8",
);

describe("organization-level action placement", () => {
  it("groups member limits and organization Token controls in the organization menu", () => {
    expect(treeSource).toContain("DropdownMenuLabel");
    // The label is localized at render time; keep the source contract aligned
    // with the bilingual copy helper rather than a pre-localization literal.
    expect(treeSource).toContain('aria-label={copy("更多组织设置", "More organization settings")}');
    expect(treeSource).toContain("设置成员上限");
    expect(treeSource).toContain("管理 Token");
    expect(treeSource).toContain("onSelect={onConfigureDefaultMemberQuota}");
    expect(treeSource).toContain("onSelect={onConfigureOrganization}");
    expect(treeSource).not.toContain('aria-label="设置组织共享上限"');
  });

  it("reuses the existing dialogs without leaving a duplicate toolbar action", () => {
    expect(membersPageSource).toContain(
      "onConfigureDefaultMemberQuota={() => setDefaultQuotaOpen(true)}",
    );
    expect(membersPageSource).toContain(
      'onConfigureOrganization={() => setCeilingTarget({ kind: "organization" })}',
    );
    expect(membersPageSource).not.toContain("全员默认上限");
  });
});
