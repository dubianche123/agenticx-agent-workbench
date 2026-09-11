import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function read(relativePath: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

describe("workflow navigation contract", () => {
  it("registers a dedicated main view, sidebar entry, and lazy editor branch", () => {
    const store = read("src/store.ts");
    const sidebar = read("src/components/AvatarSidebar.tsx");
    const app = read("src/App.tsx");
    expect(store).toContain('"workflow-studio"');
    expect(sidebar).toContain('id: "workflow-studio"');
    expect(sidebar).toContain('label: "工作流"');
    expect(app).toContain('import("./components/workflow/WorkflowStudioView")');
    expect(app).toContain('mainView === "workflow-studio"');
  });
});
