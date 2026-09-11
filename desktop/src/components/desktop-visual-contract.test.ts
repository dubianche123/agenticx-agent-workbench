import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function readDesktopSource(relativePath: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

describe("desktop visual contracts", () => {
  it("keeps the personal assistant floating surface opaque and uses generated theme utilities", () => {
    const panel = readDesktopSource("src/components/EnvironmentAssistantPanel.tsx");
    const render = panel.slice(panel.indexOf("return ("));

    expect(render).toContain("agx-environment-assistant-panel");
    expect(render).not.toContain("bg-surface-card/");
    expect(render).not.toContain("border-border/");
    expect(render).not.toContain("text-text-secondary");
    expect(render).not.toContain("text-rose-300");
    expect(render).toContain("agx-environment-assistant-error");
    expect(render).toContain("theme-color-fg-rgb");
    expect(render).toContain("theme-color-outline-rgb");
  });

  it("keeps compact assistant layouts and a deterministic brand title fallback", () => {
    const sidebar = readDesktopSource("src/components/AvatarSidebar.tsx");
    const styles = readDesktopSource("src/index.css");

    expect(sidebar).toContain("agx-brand-title");
    expect(styles).toContain("background-color: var(--agx-assistant-panel-bg) !important");
    expect(styles).toContain("color: var(--agx-assistant-error-text)");
    expect(styles).toContain("@media (max-height: 520px)");
    expect(styles).toContain("@media (max-width: 560px)");
    expect(styles).toContain("font-family: ui-sans-serif");
    expect(styles).toContain("-apple-system");
    expect(styles).toContain("Segoe UI");
  });
});
