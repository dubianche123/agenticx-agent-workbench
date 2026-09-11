import React from "react";
import { readFileSync } from "node:fs";
// The app intentionally does not ship @types/react-dom; Vitest still exercises the real renderer.
// @ts-expect-error react-dom/server is present at runtime but has no declaration in this workspace.
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";

import type { ConfigMarketItem } from "../../lib/config-market";
import {
  EnterpriseConfigMarketPanel,
  isConfigMarketDetailActivationKey,
  sortConfigMarketItems,
} from "./EnterpriseConfigMarketPanel";

const panelSource = readFileSync(
  new URL("./EnterpriseConfigMarketPanel.tsx", import.meta.url),
  "utf8",
);

const items: ConfigMarketItem[] = [
  {
    id: "expert-entry",
    capabilityId: "expert:01JQMZ8K3N4P5Q6R7S8T9VWXYZ",
    kind: "expert",
    title: "合同审查专家",
    description: "检查合同风险",
    ownerUserId: "user-li-lei",
    ownerDisplayName: "李雷",
    visibility: "company",
    visibleDepartmentIds: [],
    visibleUserIds: [],
    status: "published",
    releaseId: "01JQMZ8K3N4P5Q6R7S8T9VWX01",
    version: "1.0.0",
    downloadCount: 12,
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-21T00:00:00.000Z",
  },
  {
    id: "group-entry",
    capabilityId: "group:01JQMZ8K3N4P5Q6R7S8T9VWXY0",
    kind: "group",
    title: "新品发布项目群",
    description: "发布协同模板",
    ownerUserId: "user-han-meimei",
    ownerDisplayName: "韩梅梅",
    visibility: "users",
    visibleDepartmentIds: [],
    visibleUserIds: ["user-a", "user-b"],
    status: "unlisted",
    releaseId: "01JQMZ8K3N4P5Q6R7S8T9VWX02",
    version: "1.1.0",
    downloadCount: 3,
    createdAt: "2026-08-18T00:00:00.000Z",
    updatedAt: "2026-08-22T00:00:00.000Z",
  },
];

function renderPanel(element: React.ReactElement): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="zh" messages={{}}>
      {element}
    </NextIntlClientProvider>,
  );
}

describe("EnterpriseConfigMarketPanel", () => {
  it("uses Enter and Space for detail activation, but not unrelated keys", () => {
    expect(isConfigMarketDetailActivationKey("Enter")).toBe(true);
    expect(isConfigMarketDetailActivationKey(" ")).toBe(true);
    expect(isConfigMarketDetailActivationKey("Escape")).toBe(false);
    expect(isConfigMarketDetailActivationKey("Spacebar")).toBe(false);
  });

  it("sorts a copy by update time or name with deterministic tie breakers", () => {
    expect(sortConfigMarketItems(items, "updated-desc").map((item) => item.id)).toEqual([
      "group-entry",
      "expert-entry",
    ]);
    expect(sortConfigMarketItems(items, "updated-asc").map((item) => item.id)).toEqual([
      "expert-entry",
      "group-entry",
    ]);
    expect(sortConfigMarketItems(items, "title-asc").map((item) => item.id)).toEqual([
      "expert-entry",
      "group-entry",
    ]);
    expect(sortConfigMarketItems(items, "title-desc").map((item) => item.id)).toEqual([
      "group-entry",
      "expert-entry",
    ]);
    expect(sortConfigMarketItems(items, "downloads").map((item) => item.id)).toEqual([
      "expert-entry",
      "group-entry",
    ]);
    expect(sortConfigMarketItems([
      { ...items[0]!, id: "older-high", title: "旧条目", downloadCount: 12, updatedAt: "2026-08-20T00:00:00.000Z" },
      { ...items[1]!, id: "newer-high", title: "新条目", downloadCount: 12, updatedAt: "2026-08-22T00:00:00.000Z" },
      { ...items[0]!, id: "lower", title: "下载较少", downloadCount: 1, updatedAt: "2026-08-23T00:00:00.000Z" },
    ], "downloads").map((item) => item.id)).toEqual([
      "newer-high",
      "older-high",
      "lower",
    ]);
    expect(items.map((item) => item.id)).toEqual(["expert-entry", "group-entry"]);
  });

  it("is collapsed by default and keeps the shelf summary visible", () => {
    const html = renderPanel(
      <EnterpriseConfigMarketPanel
        items={items}
        loading={false}
        onReload={vi.fn()}
        onAction={vi.fn()}
      />,
    );

    expect(html).toContain("企业专家、群聊与 Skill 市场");
    expect(html).toContain("共 2");
    expect(html).toContain("市场上架 1");
    expect(html).toContain("市场下架 1");
    expect(html).toContain("展开管理");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("合同审查专家");
    expect(html).not.toContain("搜索专家、群聊与 Skill");
  });

  it("renders the expanded card view with both shelf states and admin actions", () => {
    const html = renderPanel(
      <EnterpriseConfigMarketPanel
        items={items}
        loading={false}
        onReload={vi.fn()}
        onAction={vi.fn()}
        defaultExpanded
      />,
    );

    expect(html).toContain('data-view="cards"');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("合同审查专家");
    expect(html).toContain("新品发布项目群");
    expect(html).toContain("分享者:");
    expect(html).toContain("李雷</a>");
    expect(html).toContain("user-li-lei");
    expect(html).toContain("市场: 全公司");
    expect(html).toContain("市场: 指定同事（2）");
    expect(html).toContain("下架");
    expect(html).toContain("恢复上架");
    expect(html).toContain('aria-label="货架排序"');
    expect(html).toContain("更新时间（新到旧）");
    expect(html).toContain("更新时间（旧到新）");
    expect(html).toContain("名称（A 到 Z）");
    expect(html).toContain("名称（Z 到 A）");
    expect(html).toContain("下载最多");
    expect(html).toContain("12 次下载");
    expect(html).toContain("flex-nowrap");
    expect(html).toContain("overflow-x-auto");
    expect(html).toContain("w-40 shrink-0");
  });

  it("renders the same entries in the compact list view", () => {
    const html = renderPanel(
      <EnterpriseConfigMarketPanel
        items={items}
        loading={false}
        onReload={vi.fn()}
        onAction={vi.fn()}
        defaultExpanded
        defaultViewMode="list"
      />,
    );

    expect(html).toContain('data-view="list"');
    expect(html).toContain("名称与说明");
    expect(html).toContain("类型与状态");
    expect(html).toContain("市场范围");
    expect(html).toContain("分享者与更新时间");
    expect(html).toContain("含下载量");
    expect(html).toContain("12 次下载");
    expect(html).toContain("合同审查专家");
    expect(html).toContain("新品发布项目群");
    expect(html).toContain("下架");
    expect(html).toContain("恢复上架");
  });

  it("gives card and list bodies an accessible detail trigger without nesting controls", () => {
    const cardHtml = renderPanel(
      <EnterpriseConfigMarketPanel
        items={items}
        loading={false}
        onReload={vi.fn()}
        onAction={vi.fn()}
        defaultExpanded
      />,
    );
    expect(cardHtml).toContain('data-detail-trigger="expert-entry"');
    expect(cardHtml).toContain('role="button"');
    expect(cardHtml).toContain('tabindex="0"');
    expect(cardHtml).toContain('aria-label="查看 数字专家: 合同审查专家"');
    expect(cardHtml).toContain('aria-label="查看 项目群聊: 新品发布项目群"');

    const listHtml = renderPanel(
      <EnterpriseConfigMarketPanel
        items={items}
        loading={false}
        onReload={vi.fn()}
        onAction={vi.fn()}
        defaultExpanded
        defaultViewMode="list"
      />,
    );
    expect(listHtml).toContain('data-detail-trigger="expert-entry"');
    expect(listHtml).toContain('data-detail-trigger="group-entry"');
    expect(listHtml).toContain('aria-label="查看 数字专家: 合同审查专家"');
    expect(listHtml).toContain('aria-label="查看 项目群聊: 新品发布项目群"');
  });

  it("adds a reviewed published market item to the capability shelf, not directly to a pack", () => {
    expect(panelSource).toContain("onAddToShelf?: (detail: ConfigMarketItemDetail) => void");
    expect(panelSource).toContain("市场上架不等于进入能力货架");
    expect(panelSource).toContain("加入货架后，仍需在上方明确选择能力包才会强制下发");
    expect(panelSource).toContain("核对并加入能力货架");
    expect(panelSource).toContain("请先恢复上架后再加入能力货架");
    expect(panelSource).toContain("已经在能力货架中");
    expect(panelSource).toContain("已在能力货架");
    expect(panelSource).toContain("已入货架");
    expect(panelSource).not.toContain("onPrepareForPack");
    expect(panelSource).not.toContain("核对并加入能力包");
    expect(panelSource).not.toContain("请先恢复上架后再加入能力包");
    expect(panelSource).toContain("shelfCapabilityIdSet.has(detail.item.capabilityId)");
  });

  it("renders a personal market scope with the same admin unlist action", () => {
    const personal: ConfigMarketItem = {
      ...items[0]!,
      id: "personal-entry",
      title: "我的合同专家",
      visibility: "personal",
      visibleDepartmentIds: [],
      visibleUserIds: [],
    };
    const html = renderPanel(
      <EnterpriseConfigMarketPanel
        items={[personal]}
        loading={false}
        onReload={vi.fn()}
        onAction={vi.fn()}
        defaultExpanded
      />,
    );

    expect(html).toContain("我的合同专家");
    expect(html).toContain("市场: 仅自己");
    expect(html).toContain("下架");
  });

  it("shows a useful empty state before anyone shares content", () => {
    const html = renderPanel(
      <EnterpriseConfigMarketPanel
        items={[]}
        loading={false}
        onReload={vi.fn()}
        onAction={vi.fn()}
        defaultExpanded
      />,
    );

    expect(html).toContain("还没有成员分享专家、项目群聊或 Skill");
  });
});
