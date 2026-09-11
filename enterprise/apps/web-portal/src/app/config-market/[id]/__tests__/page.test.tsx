import { beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.stubGlobal("React", React);

const mocks = vi.hoisted(() => ({
  getSessionFromCookies: vi.fn(),
  resolveLiveConfigMarketViewer: vi.fn(),
  getVisible: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  redirect: vi.fn((path: string) => {
    throw new Error(`NEXT_REDIRECT:${path}`);
  }),
}));

vi.mock("next/navigation", () => ({
  notFound: mocks.notFound,
  redirect: mocks.redirect,
}));
vi.mock("next-intl/server", () => ({
  getLocale: async () => "zh-CN",
  getTranslations: async () => (key: string) => key,
}));
vi.mock("../../../../lib/session", () => ({
  getSessionFromCookies: (...args: unknown[]) => mocks.getSessionFromCookies(...args),
}));
vi.mock("../../../../lib/config-market/visibility", () => ({
  resolveLiveConfigMarketViewer: (...args: unknown[]) =>
    mocks.resolveLiveConfigMarketViewer(...args),
}));
vi.mock("../../../../lib/config-market/store", () => ({
  defaultConfigMarketStore: {
    getVisible: (...args: unknown[]) => mocks.getVisible(...args),
  },
}));

const id = "01JQMZ8K3N4P5Q6R7S8T9VWXYZ";
const session = {
  tenantId: "tenant-a",
  userId: "viewer-a",
  mustChangePassword: false,
};
const viewer = { tenantId: "tenant-a", userId: "viewer-a", deptId: "dept-live" };

describe("browser config market page", () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockClear());
    mocks.getSessionFromCookies.mockResolvedValue(session);
    mocks.resolveLiveConfigMarketViewer.mockResolvedValue(viewer);
    mocks.getVisible.mockResolvedValue({
      id,
      title: "投研专家",
      description: "分析公告",
      ownerDisplayName: "Alice",
      kind: "expert",
      createdAt: "2026-08-28T00:00:00.000Z",
    });
  });

  it("uses the live viewer and the same ACL-aware detail lookup", async () => {
    const { default: ConfigMarketPage } = await import("../page");
    const page = await ConfigMarketPage({ params: Promise.resolve({ id }) });
    expect(page).toBeTruthy();
    expect(mocks.resolveLiveConfigMarketViewer).toHaveBeenCalledWith(session);
    expect(mocks.getVisible).toHaveBeenCalledWith(id, viewer);
  });

  it("fails closed before lookup when the live directory user cannot be loaded", async () => {
    mocks.resolveLiveConfigMarketViewer.mockResolvedValueOnce(null);
    const { default: ConfigMarketPage } = await import("../page");
    await expect(ConfigMarketPage({ params: Promise.resolve({ id }) })).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
    expect(mocks.getVisible).not.toHaveBeenCalled();
  });

  it("uses the same not-found response for hidden, foreign, or unlisted items", async () => {
    mocks.getVisible.mockResolvedValueOnce(null);
    const { default: ConfigMarketPage } = await import("../page");
    await expect(ConfigMarketPage({ params: Promise.resolve({ id }) })).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
  });

  it("labels a Skill market link as Skill instead of a group chat", async () => {
    mocks.getVisible.mockResolvedValueOnce({
      id,
      title: "public-research",
      description: "Search public sources",
      ownerDisplayName: "Alice",
      kind: "skill",
      createdAt: "2026-08-28T00:00:00.000Z",
    });
    const { default: ConfigMarketPage } = await import("../page");
    const html = renderToStaticMarkup(await ConfigMarketPage({ params: Promise.resolve({ id }) }));
    expect(html).toContain("skillKind");
    expect(html).not.toContain("groupKind");
  });
});
