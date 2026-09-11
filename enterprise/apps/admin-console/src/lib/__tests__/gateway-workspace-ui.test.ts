import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const appShellSource = readFileSync(
  fileURLToPath(new URL("../../components/AppShell.tsx", import.meta.url)),
  "utf8",
);
const workspaceSource = readFileSync(
  fileURLToPath(new URL("../../app/admin/gateway/page.tsx", import.meta.url)),
  "utf8",
);

describe("model and gateway workspace", () => {
  it("exposes one canonical sidebar entry instead of five sibling menus", () => {
    expect(appShellSource).toContain('{ href: "/admin/gateway", labelKey: "gatewayWorkspace"');
    expect(appShellSource).not.toContain('{ href: "/admin/models"');
    expect(appShellSource).not.toContain('{ href: "/admin/channels"');
    expect(appShellSource).not.toContain('{ href: "/admin/routing"');
    expect(appShellSource).not.toContain('{ href: "/admin/cache"');
    expect(appShellSource).not.toContain('{ href: "/admin/api-tokens"');
  });

  it("renders the real management panels instead of a directory of links", () => {
    expect(workspaceSource).not.toContain("next/link");
    expect(workspaceSource).toContain("<ModelProvidersPage />");
    expect(workspaceSource).toContain("<ChannelsPage />");
    expect(workspaceSource).toContain("<RoutingPage />");
    expect(workspaceSource).toContain("<AdminCachePage />");
    expect(workspaceSource).toContain("<ApiTokensPage />");
  });

  it("groups the panels by the administrator's task", () => {
    expect(workspaceSource).toContain("模型接入");
    expect(workspaceSource).toContain("通道与路由");
    expect(workspaceSource).toContain("AI 缓存");
    expect(workspaceSource).toContain("调用凭证");
  });

  it("puts attachment routing before the lower-level channel pool", () => {
    expect(workspaceSource.indexOf("<RoutingPage />")).toBeLessThan(
      workspaceSource.indexOf("<ChannelsPage />"),
    );
  });
});
