import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MCPMarketplacePanel } from "./MCPMarketplacePanel";

function makeItems(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `service-${index + 1}`,
    name: `服务 ${index + 1}`,
    description: "用于处理企业数据",
    is_verified: true,
    is_hosted: true,
  }));
}

describe("MCPMarketplacePanel", () => {
  it("uses the same directory hierarchy as the skill marketplace", () => {
    const html = renderToStaticMarkup(
      <MCPMarketplacePanel
        loading={false}
        items={makeItems(13)}
        search=""
        onSearchChange={vi.fn()}
        onRefresh={vi.fn(async () => undefined)}
        onInstall={vi.fn(async () => undefined)}
      />,
    );

    expect(html).toContain("MCP 服务目录");
    expect(html).toContain('aria-label="刷新 MCP 服务目录"');
    expect(html).toContain('aria-label="搜索 MCP 服务"');
    expect(html).toContain('aria-label="搜索 MCP 市场"');
    expect(html).toContain("查看全部 13 个服务");
    expect(html).toContain("服务 6</span>");
    expect(html).not.toContain("服务 7</span>");
    expect(html).not.toContain("服务 13</span>");
  });

  it("keeps installed status on the card instead of offering add again", () => {
    const html = renderToStaticMarkup(
      <MCPMarketplacePanel
        loading={false}
        items={makeItems(1)}
        search=""
        onSearchChange={vi.fn()}
        onRefresh={vi.fn(async () => undefined)}
        onInstall={vi.fn(async () => undefined)}
        installedIds={new Set(["service-1"])}
      />,
    );

    expect(html).toContain("已添加");
    expect(html).not.toContain(">添加<");
  });

  it("uses the applied receipt for enterprise state and keeps the card read-only", () => {
    const html = renderToStaticMarkup(
      <MCPMarketplacePanel
        enterpriseManaged
        loading={false}
        items={makeItems(1).map((item) => ({
          ...item,
          endpoint_ready: true,
          sync_status: "applied" as const,
        }))}
        search=""
        onSearchChange={vi.fn()}
        onRefresh={vi.fn(async () => undefined)}
        onInstall={vi.fn(async () => undefined)}
      />,
    );

    expect(html).toContain("企业 MCP 目录");
    expect(html).toContain("配置已应用");
    expect(html).not.toContain("已同步");
    expect(html).not.toContain(">添加<");
    expect(html).not.toContain("确认安装");
  });

  it("does not treat a populated endpoint as an applied receipt", () => {
    const html = renderToStaticMarkup(
      <MCPMarketplacePanel
        enterpriseManaged
        loading={false}
        items={makeItems(1).map((item) => ({ ...item, endpoint_ready: true }))}
        search=""
        onSearchChange={vi.fn()}
        onRefresh={vi.fn(async () => undefined)}
        onInstall={vi.fn(async () => undefined)}
      />,
    );

    expect(html).toContain("状态待刷新");
    expect(html).not.toContain("已同步");
  });

  it("shows the receipt state while an assigned MCP waits to be applied", () => {
    const html = renderToStaticMarkup(
      <MCPMarketplacePanel
        enterpriseManaged
        loading={false}
        items={makeItems(1).map((item) => ({
          ...item,
          endpoint_ready: false,
          sync_status: "waiting" as const,
        }))}
        search=""
        onSearchChange={vi.fn()}
        onRefresh={vi.fn(async () => undefined)}
        onInstall={vi.fn(async () => undefined)}
      />,
    );

    expect(html).toContain("等待应用");
    expect(html).not.toContain("已同步");
  });

  it("shows a safe reason and retry entry for failed enterprise sync", () => {
    const html = renderToStaticMarkup(
      <MCPMarketplacePanel
        enterpriseManaged
        loading={false}
        items={makeItems(1).map((item) => ({
          ...item,
          endpoint_ready: true,
          sync_status: "failed" as const,
          sync_error_code: "mcp_config_write_failed",
          sync_message: "Bearer secret and /Users/private/config",
        }))}
        search=""
        onSearchChange={vi.fn()}
        onRefresh={vi.fn(async () => undefined)}
        onInstall={vi.fn(async () => undefined)}
        onRetrySync={vi.fn()}
      />,
    );

    expect(html).toContain("同步失败");
    expect(html).toContain("写入本机 MCP 配置失败");
    expect(html).toContain("重试");
    expect(html).not.toContain("Bearer secret");
    expect(html).not.toContain("/Users/private/config");
  });

  it("shows a prominent waiting-gateway status when an assigned endpoint is unavailable", () => {
    const html = renderToStaticMarkup(
      <MCPMarketplacePanel
        enterpriseManaged
        loading={false}
        items={makeItems(1).map((item) => ({ ...item, endpoint_ready: false }))}
        search=""
        onSearchChange={vi.fn()}
        onRefresh={vi.fn(async () => undefined)}
        onInstall={vi.fn(async () => undefined)}
      />,
    );

    expect(html).toContain("等待网关");
    expect(html).toContain("企业网关地址尚未就绪");
    expect(html).not.toContain("已同步");
    expect(html).not.toContain(">添加<");
  });

  it("keeps an empty enterprise allowlist empty", () => {
    const html = renderToStaticMarkup(
      <MCPMarketplacePanel
        enterpriseManaged
        loading={false}
        items={[]}
        search=""
        onSearchChange={vi.fn()}
        onRefresh={vi.fn(async () => undefined)}
        onInstall={vi.fn(async () => undefined)}
      />,
    );

    expect(html).toContain("管理员尚未向你分配 MCP 服务");
    expect(html).not.toContain("暂无可展示的服务");
  });
});
