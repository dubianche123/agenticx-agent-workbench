import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const readSource = (fileName: string) =>
  fs.readFileSync(path.resolve(process.cwd(), "src/components/gallery", fileName), "utf8");

describe("digital expert gallery UI contract", () => {
  it("uses the shared viewport-aware management menu", () => {
    const source = readSource("AvatarGalleryView.tsx");

    expect(source).toContain("ContextMenu");
    expect(source).toContain("anchorRect={cardMenu?.anchorRect}");
    expect(source).toContain("管理设置");
    expect(source).toContain("导出分享文件");
    expect(source).toContain("复制公司链接");
    expect(source).toContain("发布到公司市场");
    expect(source).toContain("result.notice || result.warning");
    expect(source).not.toContain('w-[132px]');
  });

  it("opens the same profile panel for local and enterprise-managed experts", () => {
    const source = readSource("AvatarGalleryView.tsx");

    expect(source).toContain("onOpenSettings={() => setSettingsAvatarId(avatar.id)}");
    expect(source).toContain("setSettingsAvatarId(menuAvatar.id)");
    expect(source).not.toContain("不能直接修改。需要定制时请导出并导入为个人副本");
  });

  it("keeps employee-facing cards compact and hides internal tag identifiers", () => {
    const source = readSource("AvatarGalleryView.tsx");

    expect(source).not.toContain("isOfficialExpertTemplateAvatar");
    expect(source).toContain("return [...avatars].sort");
    expect(source).toContain('filter((tag) => !tag.startsWith("builtin:"))');
    expect(source).toContain("publicTags.slice(0, 3)");
    expect(source).toContain("hiddenTagCount");
    expect(source).toContain('gridTemplateColumns: "repeat(auto-fit, minmax(min(300px, 100%), 1fr))"');
    expect(source).toContain("点「立即对话」开始对话");
  });
});
