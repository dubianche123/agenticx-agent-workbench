import { describe, expect, it } from "vitest";
import { findSupportGuide, linksForSupportPage, suggestionsForSupportPage } from "./guides";

describe("support page guides", () => {
  it("matches the current workspace tab and merges contextual suggestions", () => {
    const match = findSupportGuide({ path: "/workspace/", tab: "settings" });
    expect(match.guide.id).toBe("portal-chat");
    expect(match.tab?.id).toBe("settings");
    expect(match.tab?.summary).toContain("跟随系统");
    expect(match.tab?.summary).toContain("浅色");
    expect(match.tab?.summary).toContain("深色");
    expect(match.tab?.summary).toContain("中文");
    expect(match.tab?.summary).toContain("English");
    expect(suggestionsForSupportPage({ path: "/workspace", tab: "settings" })).toContain("如何切换界面主题（跟随系统、浅色或深色）？");
    expect(linksForSupportPage({ path: "/workspace", tab: "settings" })).toContainEqual(
      { label: "打开工作区设置", href: "/workspace#settings" },
    );
  });

  it("describes the workspace history controls exposed by the shell", () => {
    const match = findSupportGuide({ path: "/workspace", tab: "history" });
    expect(match.tab?.summary).toContain("左侧对话列表");
    expect(match.tab?.summary).toContain("打开此前会话");
    expect(match.tab?.summary).toContain("查看全部");
    expect(match.tab?.summary).toContain("历史管理");
  });

  it("does not attach workspace navigation to the active chat tab", () => {
    expect(linksForSupportPage({ path: "/workspace", tab: "chat" })).toEqual([]);
    expect(linksForSupportPage({ path: "/workspace", tab: "settings" })).toContainEqual(
      { label: "打开工作区设置", href: "/workspace#settings" },
    );
  });

  it("returns only known internal links", () => {
    const links = linksForSupportPage({ path: "/admin/gateway" });
    expect(links.length).toBeGreaterThan(0);
    expect(links.every((link) => link.href.startsWith("/"))).toBe(true);
  });

  it("maps the admin shell query context to the tabs that the pages expose", () => {
    const cases = [
      ["/admin/gateway", "traffic", "admin-gateway"],
      ["/admin/capabilities", "mcp", "admin-capabilities"],
      ["/admin/governance", "policy", "admin-governance"],
      ["/metering", "budget", "admin-metering"],
      ["/iam/roles", "groups", "admin-members"],
    ] as const;
    for (const [path, tab, guideId] of cases) {
      const match = findSupportGuide({ path, tab });
      expect(match.guide.id).toBe(guideId);
      expect(match.tab?.id).toBe(tab);
      expect(match.tab?.links.every((link) => link.href.startsWith("/"))).toBe(true);
    }
  });
});
