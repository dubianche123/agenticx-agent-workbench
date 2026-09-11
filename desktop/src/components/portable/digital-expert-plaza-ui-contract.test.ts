import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

function readSource(relativePath: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

describe("digital expert plaza UI contract", () => {
  it("places the plaza below project groups and before automation", () => {
    const sidebar = readSource("src/components/AvatarSidebar.tsx");
    const groupsAt = sidebar.indexOf('id: "groups"');
    const plazaAt = sidebar.indexOf('id: "expert-plaza"');
    const automationAt = sidebar.indexOf('id: "automation"');

    expect(groupsAt).toBeGreaterThan(-1);
    expect(plazaAt).toBeGreaterThan(groupsAt);
    expect(automationAt).toBeGreaterThan(plazaAt);
  });

  it("routes the sidebar view to an independent lazy page", () => {
    const store = readSource("src/store.ts");
    const app = readSource("src/App.tsx");

    expect(store).toContain('"expert-plaza"');
    expect(app).toContain("DigitalExpertPlazaView");
    expect(app).toContain('mainView === "expert-plaza"');
  });

  it("removes duplicate market feeds from management pages", () => {
    const experts = readSource("src/components/gallery/AvatarGalleryView.tsx");
    const groups = readSource("src/components/groups/ProjectsView.tsx");

    expect(experts).not.toContain("PortablePackageMarketSection");
    expect(groups).not.toContain("PortablePackageMarketSection");
    expect(experts).toContain("导入专家");
    expect(groups).toContain("导入群聊");
  });

  it("hosts official expert and team templates in the unified plaza", () => {
    const experts = readSource("src/components/gallery/AvatarGalleryView.tsx");
    const groups = readSource("src/components/groups/ProjectsView.tsx");
    const plaza = readSource("src/components/portable/DigitalExpertPlazaView.tsx");
    const portraits = readSource("src/components/portable/PlazaAvatar.tsx");

    expect(experts).not.toContain("filter((avatar) => !isOfficialExpertTemplateAvatar(avatar))");
    expect(experts).toContain("return [...avatars].sort");
    expect(groups).not.toContain("GROUP_TEMPLATES");
    expect(groups).not.toContain("工作流模板");
    expect(plaza).toContain("listOfficialPlazaTemplates");
    expect(plaza).toContain("createExpertFromOfficialTemplate");
    expect(plaza).toContain("<GroupTemplateCreateDialog");
    expect(plaza).toContain("官方认证");
    expect(plaza).toContain("<PlazaAvatar");
    expect(plaza).toContain("buildPlazaAvatarFallbackUrl");
    expect(portraits).toContain("CURATED_EXPERT_PORTRAITS");
    expect(portraits).toContain("<img");
    expect(portraits).not.toContain("slice(0, 2)");
  });

  it("uses the four-character plaza label and exposes source and sort controls", () => {
    const sidebar = readSource("src/components/AvatarSidebar.tsx");
    const plaza = readSource("src/components/portable/DigitalExpertPlazaView.tsx");

    expect(sidebar).toContain('label: "专家广场"');
    expect(sidebar).not.toContain('label: "数字专家广场"');
    expect(plaza).toContain('type PlazaSourceFilter = "all" | "official" | "enterprise"');
    expect(plaza).toContain('type PlazaSort = "recommended" | "latest" | "downloads" | "name"');
    expect(plaza).toContain('label: "下载最多"');
    expect(plaza).toContain("下载 {marketItem.downloadCount} 次");
    expect(plaza).toContain("onImported={async (result) => {");
    expect(plaza).toContain("await load();");
    expect(plaza).toContain('aria-label="按来源筛选"');
    expect(plaza).toContain('aria-label="专家广场排序方式"');
  });

  it("keeps market cards readable at narrow widths with separated content bands", () => {
    const plaza = readSource("src/components/portable/DigitalExpertPlazaView.tsx");

    expect(plaza).toContain('minmax(min(320px, 100%), 1fr)');
    expect(plaza).toMatch(/<header className="grid min-w-0 grid-cols-\[auto_minmax\(0,1fr\)\]/);
    expect(plaza).toContain('aria-label="条目类型与认证状态"');
    expect(plaza).toContain('aria-label="市场元数据"');
    expect(plaza).toMatch(/className="mt-3 inline-flex h-10 w-full[^"]*"/);
    expect(plaza).not.toContain('min-h-[188px]');
  });

  it("keeps search, type, source, and sort controls in one scrollable toolbar row", () => {
    const plaza = readSource("src/components/portable/DigitalExpertPlazaView.tsx");

    expect(plaza).toContain('className="mt-5 min-w-0 overflow-x-auto pb-1"');
    expect(plaza).toContain('className="flex min-w-max flex-nowrap items-center gap-3"');
    expect(plaza).toContain('min-w-[10rem] flex-[1_1_18rem] max-w-[24rem]');
    expect(plaza).toContain('shrink-0 whitespace-nowrap rounded-lg bg-surface-card p-1');
    expect(plaza).toContain('shrink-0 items-center gap-2 whitespace-nowrap rounded-lg');
    expect(plaza).not.toContain('mt-5 flex flex-wrap items-center gap-3');
  });
});
