import { describe, expect, it } from "vitest";

import {
  filterPlazaItems,
  loadPortableMarketPages,
  mergePlazaCatalog,
  mergePlazaItems,
  PLAZA_MARKET_PAGE_SIZE,
  PLAZA_MARKET_MAX_PAGES,
  sortPortableMarketItems,
  sortPlazaItems,
} from "./DigitalExpertPlazaView";
import {
  listOfficialPlazaTemplates,
  type OfficialPlazaTemplate,
} from "./plaza-official-templates";
import { buildPlazaAvatarFallbackUrl } from "./PlazaAvatar";
import type { Avatar } from "../../store";

const item = (
  id: string,
  kind: PortablePackageKind,
  title: string,
  ownerDisplayName: string,
  createdAt: string,
  downloadCount = 0,
): PortableMarketItem => ({
  id,
  capabilityId: `${kind}:${id}`,
  sourceArtifactId: `${kind}:01JABCDEF0123456789ABCDEFG`,
  manifestVersion: 2,
  releaseId: "01JABCDEF0123456789ABCDEFX",
  version: "1.0.0",
  kind,
  title,
  description: `${title}说明`,
  ownerDisplayName,
  visibility: "company",
  visibleDepartmentCount: 0,
  visibleUserCount: 0,
  downloadCount,
  status: "published",
  digest: "a".repeat(64),
  releaseNotes: "",
  releasePublishedAt: createdAt,
  publishedAt: createdAt,
  createdAt,
  updatedAt: createdAt,
});

describe("DigitalExpertPlazaView helpers", () => {
  const expert = item("expert-1", "expert", "数据专家", "小林", "2026-08-20T00:00:00Z");
  const group = item("group-1", "group", "研究团队", "小周", "2026-08-21T00:00:00Z");

  it("carries personal market entries as valid plaza items", () => {
    const personal = { ...expert, id: "personal-expert", visibility: "personal" as const };
    expect(mergePlazaCatalog([], [personal])[0]?.marketItem?.visibility).toBe("personal");
  });

  it("merges expert and team feeds newest first", () => {
    expect(mergePlazaItems([expert], [group]).map((entry) => entry.id)).toEqual([
      "group-1",
      "expert-1",
    ]);
  });

  it("filters one unified feed by kind and searchable metadata", () => {
    const items = mergePlazaCatalog([], [expert, group]);
    expect(filterPlazaItems(items, "all", "")).toEqual(items);
    expect(filterPlazaItems(items, "expert", "").map((entry) => entry.marketItem)).toEqual([
      expert,
    ]);
    expect(filterPlazaItems(items, "group", "小周").map((entry) => entry.marketItem)).toEqual([
      group,
    ]);
    expect(filterPlazaItems(items, "all", "数据").map((entry) => entry.marketItem)).toEqual([
      expert,
    ]);
  });

  it("keeps the official template when the enterprise market repeats the same kind and title", () => {
    const official: OfficialPlazaTemplate = {
      id: "official:expert:data",
      source: "official",
      kind: "expert",
      title: " 数据专家 ",
      description: "官方模板",
      ownerDisplayName: "AgenticX 官方",
    };

    const catalog = mergePlazaCatalog([official], [expert, group]);

    expect(catalog.map((entry) => [entry.source, entry.kind, entry.title])).toEqual([
      ["official", "expert", " 数据专家 "],
      ["market", "group", "研究团队"],
    ]);
  });

  it("reuses the installed expert portrait for matching company releases", () => {
    const installed: Avatar = {
      id: "local-data-expert",
      name: "数据专家",
      role: "数据分析师",
      avatarUrl: "data:image/svg+xml,portrait",
      pinned: false,
      createdBy: "user",
      portableArtifactId: expert.sourceArtifactId,
    };

    const catalog = mergePlazaCatalog([], [expert], [installed]);

    expect(catalog[0]?.sourceAvatar).toBe(installed);
    expect(catalog[0]?.sourceAvatar?.avatarUrl).toContain("portrait");
  });

  it("prefers an exact artifact portrait over an earlier same-name avatar", () => {
    const older: Avatar = {
      id: "older-data-expert",
      name: "数据专家",
      role: "旧版本",
      avatarUrl: "data:image/svg+xml,older-portrait",
      pinned: false,
      createdBy: "user",
      portableArtifactId: "expert:other-artifact",
    };
    const exact: Avatar = {
      id: "exact-data-expert",
      name: "另一个显示名",
      role: "当前版本",
      avatarUrl: "data:image/svg+xml,exact-portrait",
      pinned: false,
      createdBy: "user",
      portableArtifactId: expert.sourceArtifactId,
    };

    const catalog = mergePlazaCatalog([], [expert], [older, exact]);

    expect(catalog[0]?.sourceAvatar).toBe(exact);
  });

  it("keeps experts and teams image-backed when no local portrait exists", () => {
    const catalog = mergePlazaCatalog([], [expert, group]);
    const expertPortrait = catalog.find((entry) => entry.kind === "expert")?.sourceAvatar?.avatarUrl;

    expect(expertPortrait).toBe(
      buildPlazaAvatarFallbackUrl(expert.title, "expert", expert.sourceArtifactId),
    );
    expect(expertPortrait).toMatch(/expert-[a-z-]+\.png(?:\?.*)?$/);
    expect(expertPortrait).not.toContain("data:image/svg+xml");
    expect(buildPlazaAvatarFallbackUrl(group.title, "group")).toMatch(
      /^data:image\/svg\+xml;charset=utf-8,/,
    );
  });

  it("keeps the official template's portrait in the unified catalog", () => {
    const officialAvatar: Avatar = {
      id: "builtin-writing",
      name: "官方写作专家",
      role: "写作顾问",
      avatarUrl: "data:image/svg+xml,official-portrait",
      pinned: false,
      createdBy: "builtin",
    };
    const official: OfficialPlazaTemplate = {
      id: "official:expert:writing",
      source: "official",
      kind: "expert",
      title: officialAvatar.name,
      description: "官方示范",
      ownerDisplayName: "AgenticX 官方",
      expertTemplate: {
        id: "writing",
        sourceAvatar: officialAvatar,
        name: officialAvatar.name,
        role: officialAvatar.role,
        description: "官方示范",
        systemPrompt: "先澄清目标，再组织表达。",
        tags: ["写作"],
      },
    };

    const catalog = mergePlazaCatalog([official], []);

    expect(catalog[0]?.sourceAvatar).toBe(officialAvatar);
  });

  it("previews every official expert with a stable curated portrait", () => {
    const catalog = mergePlazaCatalog(listOfficialPlazaTemplates([]), []);
    const portraits = catalog
      .filter((entry) => entry.kind === "expert")
      .map((entry) => entry.sourceAvatar?.avatarUrl || "");

    expect(portraits.length).toBeGreaterThan(0);
    expect(portraits.every((portrait) => /expert-[a-z-]+\.png(?:\?.*)?$/.test(portrait))).toBe(true);
    expect(new Set(portraits).size).toBeGreaterThan(1);
  });

  it("filters by official or enterprise source in the unified catalog", () => {
    const official: OfficialPlazaTemplate = {
      id: "official:expert:official-only",
      source: "official",
      kind: "expert",
      title: "官方专家",
      description: "官方示范",
      ownerDisplayName: "AgenticX 官方",
    };
    const catalog = mergePlazaCatalog([official], [expert, group]);

    expect(filterPlazaItems(catalog, "all", "", "official").map((entry) => entry.title)).toEqual([
      "官方专家",
    ]);
    expect(filterPlazaItems(catalog, "all", "", "enterprise").map((entry) => entry.title)).toEqual([
      "数据专家",
      "研究团队",
    ]);
  });

  it("supports recommended, latest, and name ordering", () => {
    const official: OfficialPlazaTemplate = {
      id: "official:group:official-team",
      source: "official",
      kind: "group",
      title: "官方团队",
      description: "官方示范",
      ownerDisplayName: "AgenticX 官方",
    };
    const catalog = mergePlazaCatalog([official], [expert, group]);

    expect(sortPlazaItems(catalog, "recommended").map((entry) => entry.title)).toEqual([
      "官方团队",
      "数据专家",
      "研究团队",
    ]);
    expect(sortPlazaItems(catalog, "latest").map((entry) => entry.title)).toEqual([
      "研究团队",
      "数据专家",
      "官方团队",
    ]);
    expect(sortPlazaItems(catalog, "name").map((entry) => entry.title)).toEqual([
      "官方团队",
      "数据专家",
      "研究团队",
    ]);
  });

  it("sorts complete market feeds by server download count without inventing template stats", () => {
    const popular = item("popular", "expert", "热门专家", "小赵", "2026-08-18T00:00:00Z", 17);
    const quiet = item("quiet", "expert", "安静专家", "小钱", "2026-08-22T00:00:00Z", 2);
    const official: OfficialPlazaTemplate = {
      id: "official:expert:demo",
      source: "official",
      kind: "expert",
      title: "官方示范",
      description: "官方模板",
      ownerDisplayName: "AgenticX 官方",
    };
    const catalog = mergePlazaCatalog([official], [quiet, popular]);

    expect(sortPlazaItems(catalog, "downloads").map((entry) => entry.title)).toEqual([
      "热门专家",
      "安静专家",
      "官方示范",
    ]);
    expect(sortPortableMarketItems([quiet, popular], "downloads").map((entry) => entry.title)).toEqual([
      "热门专家",
      "安静专家",
    ]);
    expect(catalog.find((entry) => entry.source === "official")?.marketItem).toBeUndefined();
  });

  it("consumes every market page, forwards the opaque cursor, and deduplicates ids", async () => {
    const calls: Array<{ kind: PortablePackageKind; limit: number; cursor?: string }> = [];
    const result = await loadPortableMarketPages("expert", async (request) => {
      calls.push(request);
      if (calls.length === 1) {
        return { ok: true, items: [expert], nextCursor: "page-2" };
      }
      return {
        ok: true,
        items: [
          expert,
          {
            ...expert,
            id: "expert-2",
            capabilityId: "expert:expert-2",
            title: "第二专家",
          },
        ],
        nextCursor: null,
      };
    });

    expect(result.error).toBeUndefined();
    expect(result.items.map((entry) => entry.id)).toEqual(["expert-1", "expert-2"]);
    expect(calls).toEqual([
      { kind: "expert", limit: PLAZA_MARKET_PAGE_SIZE },
      { kind: "expert", limit: PLAZA_MARKET_PAGE_SIZE, cursor: "page-2" },
    ]);
  });

  it("stops on a repeated cursor and never loops beyond the page cap", async () => {
    const calls: string[] = [];
    const result = await loadPortableMarketPages("group", async (request) => {
      calls.push(request.cursor ?? "first");
      return { ok: true, items: [], nextCursor: "same-page" };
    });

    expect(calls).toEqual(["first", "same-page"]);
    expect(calls.length).toBeLessThan(PLAZA_MARKET_MAX_PAGES);
    expect(result.error).toMatch(/游标重复/);
  });
});
