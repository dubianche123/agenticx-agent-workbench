import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const readSource = (fileName: string) =>
  fs.readFileSync(path.resolve(process.cwd(), "src/components/groups", fileName), "utf8");

const readPortableSource = (fileName: string) =>
  fs.readFileSync(path.resolve(process.cwd(), "src/components/portable", fileName), "utf8");

describe("team template UI contract", () => {
  it("moves template cards out of project management and keeps the provisioning dialog in the plaza", () => {
    const projects = readSource("ProjectsView.tsx");
    const customEditor = readSource("GroupEditorInline.tsx");
    const plaza = readPortableSource("DigitalExpertPlazaView.tsx");

    expect(projects).not.toContain("GROUP_TEMPLATES");
    expect(projects).not.toContain("工作流模板");
    expect(projects).not.toContain("<GroupTemplateCreateDialog");
    expect(plaza).toContain("listOfficialPlazaTemplates");
    expect(plaza).toContain("<GroupTemplateCreateDialog");
    expect(projects).not.toContain("matchTemplateAvatarIds");
    expect(customEditor).not.toContain("initialAvatarIds");
  });

  it("states that existing avatars are untouched and keeps cancellation available", () => {
    const dialog = readSource("GroupTemplateCreateDialog.tsx");

    expect(dialog).toContain("不会使用或修改你已有的专家");
    expect(dialog).toContain("取消创建");
    expect(dialog).toContain("shouldCancel: () => cancelRequestedRef.current");
  });
});
