import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  isPortableMarketVisibilityReady,
  listPortablePublishDependencies,
  mergeAudienceOptionsById,
  PortableMarketPublishDialog,
} from "./PortableMarketPublishDialog";

describe("portable market publish scope", () => {
  it("does not require an audience for admins-only submissions", () => {
    expect(isPortableMarketVisibilityReady("admins_only", 0)).toBe(true);
    expect(isPortableMarketVisibilityReady("company", 0)).toBe(true);
    expect(isPortableMarketVisibilityReady("personal", 0)).toBe(true);
    expect(isPortableMarketVisibilityReady("departments", 0)).toBe(false);
    expect(isPortableMarketVisibilityReady("users", 0)).toBe(false);
  });

  it("requires an explicit market visibility choice and separates it from managed delivery", () => {
    const html = renderToStaticMarkup(
      <PortableMarketPublishDialog
        target={{ kind: "expert", id: "avatar-1", name: "环境配置专家" }}
        onClose={() => undefined}
        onPublished={() => undefined}
      />,
    );

    expect(html).toContain("发布数字专家到公司市场");
    expect(html).toContain("仅自己");
    expect(html).toContain("其他任何人都不会在市场中看到或导入");
    expect(html).toContain("全公司");
    expect(html).toContain("指定部门");
    expect(html).toContain("所选部门及其下级部门成员可见");
    expect(html).toContain("指定同事");
    expect(html).toContain("只有你和所选同事可见");
    expect(html).toContain("发布不会自动下发；管理员能力包是独立流程");
    expect(html).toContain("发布版本");
    expect(html).toContain("建议运行权限");
    expect(html).toContain("IDENTITY.md");
    expect(html).toContain("SOUL.md");
    expect(html).toContain("MEMORY.md");
    expect(html).toContain("提供项目工作区入口（可选）");
    expect(html).toContain("不会自动绑定");
    expect(html).not.toContain("请求绑定项目工作区");
    expect(html).toContain("不会授予权限");
    expect(html).toContain("扫描 API Key、银行卡号等明显敏感信息");
    expect(html).toContain("确认发布");
  });

  it.each([
    ["expert", "数字专家"],
    ["group", "项目群聊"],
    ["skill", "Skill"],
  ] as const)("offers admins-only submission for %s", (kind, label) => {
    const html = renderToStaticMarkup(
      <PortableMarketPublishDialog
        target={{ kind, id: kind === "skill" ? "environment-check" : `${kind}-1`, name: `${label}示例` }}
        onClose={() => undefined}
        onPublished={() => undefined}
      />,
    );

    expect(html).toContain(`发布${label}到公司市场`);
    expect(html).toContain("仅提交管理员");
    expect(html).toContain("不会出现在员工市场，也不会自动下发");
  });

  it("renders nothing without a selected local package", () => {
    expect(renderToStaticMarkup(
      <PortableMarketPublishDialog
        target={null}
        onClose={() => undefined}
        onPublished={() => undefined}
      />,
    )).toBe("");
  });

  it("keeps previously selected directory options identifiable across searches", () => {
    expect(mergeAudienceOptionsById(
      [{ id: "dept-1", name: "研发" }],
      [{ id: "dept-2", name: "销售" }, { id: "dept-1", name: "研发中心" }],
    )).toEqual([
      { id: "dept-1", name: "研发中心" },
      { id: "dept-2", name: "销售" },
    ]);
  });

  it("offers only canonical assigned capabilities with reproducible Skill metadata", () => {
    const skillId = "01JABCDEF0123456789ABCDEGH";
    const mcpId = "01JABCDEF0123456789ABCDEGJ";
    expect(listPortablePublishDependencies([
      {
        id: `skill:${skillId.toLowerCase()}`,
        kind: "skill",
        name: "env-check",
        displayName: "环境检查",
        version: "2.1.0",
        bundleDigest: "a".repeat(64),
      },
      {
        id: `mcp:${mcpId}`,
        kind: "mcp",
        name: "docs",
        version: "not-semver",
      },
      {
        id: "skill:INVALID",
        kind: "skill",
        name: "invalid",
        version: "1.0.0",
        bundleDigest: "b".repeat(64),
      },
      {
        id: `skill:${mcpId}`,
        kind: "skill",
        name: "missing-digest",
        version: "1.0.0",
      },
    ])).toEqual([
      {
        id: `mcp:${mcpId}`,
        kind: "mcp",
        name: "docs",
        version: "1.0.0",
      },
      {
        id: `skill:${skillId}`,
        kind: "skill",
        name: "环境检查",
        version: "2.1.0",
        digest: "a".repeat(64),
      },
    ]);
  });
});
