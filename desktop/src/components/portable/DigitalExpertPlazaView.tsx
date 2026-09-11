import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Building2,
  Clock3,
  Download,
  Loader2,
  RefreshCw,
  Search,
  ShieldCheck,
  Store,
} from "lucide-react";

import { useAppStore } from "../../store";
import type { Avatar } from "../../store";
import { mapAvatarsFromApi, mapGroupsFromApi } from "../../utils/splash-preload-core";
import { MainViewShell } from "../ds/MainViewShell";
import { Toast } from "../ds/Toast";
import { GroupTemplateCreateDialog } from "../groups/GroupTemplateCreateDialog";
import {
  nextAvailableTemplateGroupName,
  type GroupTemplateCreationResult,
} from "../groups/group-template-creation";
import type { GroupTemplate } from "../groups/group-templates";
import {
  createExpertFromOfficialTemplate,
  listOfficialPlazaTemplates,
  type OfficialPlazaTemplate,
} from "./plaza-official-templates";
import {
  normalizePortablePackagePreview,
  PortablePackageImportDialog,
  type PortablePackageCandidate,
} from "./PortablePackageImportDialog";
import { buildPlazaAvatarFallbackUrl, PlazaAvatar, type PlazaAvatarKind } from "./PlazaAvatar";

export type PlazaKindFilter = "all" | "expert" | "group";
export type PlazaSourceFilter = "all" | "official" | "enterprise";
export type PlazaSort = "recommended" | "latest" | "downloads" | "name";
export type PortableMarketItemSort = "latest" | "downloads" | "name";

export type PlazaCatalogItem = {
  id: string;
  source: "official" | "market";
  kind: PortablePackageKind;
  title: string;
  description: string;
  ownerDisplayName: string;
  /** Installed portrait, or a stable image fallback for an uninstalled entry. */
  sourceAvatar?: Avatar;
  marketItem?: PortableMarketItem;
  officialTemplate?: OfficialPlazaTemplate;
};

export const PLAZA_MARKET_PAGE_SIZE = 50;
export const PLAZA_MARKET_MAX_PAGES = 100;
export const PLAZA_MARKET_MAX_ITEMS = PLAZA_MARKET_PAGE_SIZE * PLAZA_MARKET_MAX_PAGES;

type PlazaMarketPageRequest = {
  kind: PortablePackageKind;
  limit: number;
  cursor?: string;
};

type PlazaMarketPageResponse = {
  ok: boolean;
  items: PortableMarketItem[];
  nextCursor?: string | null;
  error?: string;
};

type PlazaMarketPageLoader = (
  request: PlazaMarketPageRequest,
) => Promise<PlazaMarketPageResponse>;

/**
 * Read the complete bounded feed for one kind.  The cursor is opaque to the
 * renderer: it is only carried to the next request, with duplicate/cap
 * guards so a broken server cannot make the plaza spin forever.
 */
export async function loadPortableMarketPages(
  kind: PortablePackageKind,
  loadPage: PlazaMarketPageLoader,
  feedLabel = "公司分享",
): Promise<{ items: PortableMarketItem[]; error?: string }> {
  const items: PortableMarketItem[] = [];
  const seenItemIds = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  for (let page = 0; page < PLAZA_MARKET_MAX_PAGES; page += 1) {
    if (cursor) {
      if (seenCursors.has(cursor)) {
        return { items, error: `${feedLabel}分页游标重复，已停止继续加载。` };
      }
      seenCursors.add(cursor);
    }

    let result: PlazaMarketPageResponse;
    try {
      result = await loadPage({
        kind,
        limit: PLAZA_MARKET_PAGE_SIZE,
        ...(cursor ? { cursor } : {}),
      });
    } catch (error) {
      return {
        items,
        error: error instanceof Error ? error.message : `加载${feedLabel}失败。`,
      };
    }
    if (!result.ok) {
      return { items, error: result.error || `加载${feedLabel}失败。` };
    }

    for (const item of result.items) {
      if (seenItemIds.has(item.id)) continue;
      seenItemIds.add(item.id);
      items.push(item);
      if (items.length >= PLAZA_MARKET_MAX_ITEMS) {
        return { items, error: `${feedLabel}内容较多，已显示前 5000 条。` };
      }
    }

    if (result.nextCursor === undefined || result.nextCursor === null || result.nextCursor === "") {
      return { items };
    }
    if (typeof result.nextCursor !== "string") {
      return { items, error: `${feedLabel}分页游标无效，已停止继续加载。` };
    }
    const nextCursor = result.nextCursor.trim();
    if (!nextCursor || seenCursors.has(nextCursor)) {
      return { items, error: `${feedLabel}分页游标重复，已停止继续加载。` };
    }
    cursor = nextCursor;
  }

  return { items, error: `${feedLabel}页数过多，已显示前 5000 条。` };
}

function visibilityLabel(item: PortableMarketItem): string {
  if (item.visibility === "personal") return "仅自己";
  if (item.visibility === "departments") {
    return `指定部门 · ${item.visibleDepartmentCount}`;
  }
  if (item.visibility === "users") return `指定同事 · ${item.visibleUserCount}`;
  return "全公司";
}

function marketKindLabel(kind: PortablePackageKind): string {
  if (kind === "expert") return "单专家";
  if (kind === "group") return "专家团队";
  return "能力包";
}

function plazaAvatarKind(kind: PortablePackageKind): PlazaAvatarKind | null {
  if (kind === "expert" || kind === "group") return kind;
  // Skill packages are valid market entries but do not have an expert/team
  // portrait.  Keep that semantic instead of presenting a skill as a group.
  return null;
}

function catalogKey(item: Pick<PlazaCatalogItem, "kind" | "title">): string {
  return `${item.kind}:${item.title.trim().replace(/\s+/g, " ").toLocaleLowerCase()}`;
}

export function filterPlazaItems(
  items: readonly PlazaCatalogItem[],
  kind: PlazaKindFilter,
  query: string,
  source: PlazaSourceFilter = "all",
  sort: PlazaSort = "recommended",
): PlazaCatalogItem[] {
  const needle = query.trim().toLocaleLowerCase();
  const filtered = items.filter((item) => {
    if (kind !== "all" && item.kind !== kind) return false;
    if (source === "official" && item.source !== "official") return false;
    if (source === "enterprise" && item.source !== "market") return false;
    if (!needle) return true;
    return [item.title, item.description, item.ownerDisplayName]
      .join(" ")
      .toLocaleLowerCase()
      .includes(needle);
  });
  return sortPlazaItems(filtered, sort);
}

function marketItemTimestamp(item: PlazaCatalogItem): number {
  const market = item.marketItem;
  if (!market) return 0;
  const value = market.releasePublishedAt || market.publishedAt || market.createdAt;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function portableMarketTimestamp(item: PortableMarketItem): number {
  const value = item.releasePublishedAt || item.publishedAt || item.createdAt;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Sort a complete market feed after pagination; the server remains cursor-only. */
export function sortPortableMarketItems(
  items: readonly PortableMarketItem[],
  sort: PortableMarketItemSort = "latest",
): PortableMarketItem[] {
  return [...items].sort((left, right) => {
    if (sort === "downloads") {
      const downloadDifference = right.downloadCount - left.downloadCount;
      if (downloadDifference !== 0) return downloadDifference;
    } else if (sort === "name") {
      const titleDifference = left.title.localeCompare(right.title, "zh-Hans");
      if (titleDifference !== 0) return titleDifference;
    } else {
      const timeDifference = portableMarketTimestamp(right) - portableMarketTimestamp(left);
      if (timeDifference !== 0) return timeDifference;
    }
    return left.title.localeCompare(right.title, "zh-Hans") || left.id.localeCompare(right.id);
  });
}

/** Sort the unified catalog without making official templates look like stale market entries. */
export function sortPlazaItems(
  items: readonly PlazaCatalogItem[],
  sort: PlazaSort = "recommended",
): PlazaCatalogItem[] {
  return [...items].sort((left, right) => {
    if (sort === "name") {
      const titleDifference = left.title.localeCompare(right.title, "zh-Hans");
      if (titleDifference !== 0) return titleDifference;
    } else if (sort === "recommended") {
      const sourceDifference = (left.source === "official" ? 0 : 1)
        - (right.source === "official" ? 0 : 1);
      if (sourceDifference !== 0) return sourceDifference;
      const kindDifference = (left.kind === "expert" ? 0 : 1)
        - (right.kind === "expert" ? 0 : 1);
      if (kindDifference !== 0) return kindDifference;
    } else if (sort === "downloads") {
      // Official local templates intentionally have no market statistics. Put
      // them after real market entries for this ordering without displaying a
      // fabricated zero on their cards.
      const leftDownloads = left.marketItem ? left.marketItem.downloadCount : -1;
      const rightDownloads = right.marketItem ? right.marketItem.downloadCount : -1;
      const downloadDifference = rightDownloads - leftDownloads;
      if (downloadDifference !== 0) return downloadDifference;
    } else {
      const timeDifference = marketItemTimestamp(right) - marketItemTimestamp(left);
      if (timeDifference !== 0) return timeDifference;
    }

    const titleDifference = left.title.localeCompare(right.title, "zh-Hans");
    if (titleDifference !== 0) return titleDifference;
    return left.id.localeCompare(right.id);
  });
}

export function mergePlazaItems(
  expertItems: readonly PortableMarketItem[],
  groupItems: readonly PortableMarketItem[],
): PortableMarketItem[] {
  return [...expertItems, ...groupItems].sort((left, right) => {
    const timeDifference = Date.parse(right.createdAt) - Date.parse(left.createdAt);
    if (Number.isFinite(timeDifference) && timeDifference !== 0) return timeDifference;
    return left.title.localeCompare(right.title);
  });
}

function sameExpertName(left: string, right: string): boolean {
  return left.trim().replace(/\s+/g, " ").toLocaleLowerCase()
    === right.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

/** Prefer stable artifact identity, then name for older local records. */
function findInstalledExpertAvatar(
  item: Pick<PortableMarketItem, "sourceArtifactId" | "title">,
  avatars: readonly Avatar[],
): Avatar | undefined {
  const exactArtifact = item.sourceArtifactId
    ? avatars.find((avatar) => avatar.portableArtifactId === item.sourceArtifactId)
    : undefined;
  if (exactArtifact) return exactArtifact;
  return avatars.find((avatar) => sameExpertName(avatar.name, item.title));
}

function ensureExpertPortrait(
  avatar: Avatar | undefined,
  id: string,
  name: string,
  description: string,
  sourceArtifactId: string,
): Avatar {
  if (avatar?.avatarUrl?.trim()) return avatar;
  return {
    ...(avatar ?? {}),
    id: avatar?.id || id,
    name: avatar?.name || name,
    role: avatar?.role || "",
    avatarUrl: buildPlazaAvatarFallbackUrl(
      avatar?.name || name,
      "expert",
      sourceArtifactId || avatar?.portableArtifactId || id,
    ),
    pinned: Boolean(avatar?.pinned),
    createdBy: avatar?.createdBy || "market",
    description: avatar?.description ?? description,
  };
}

export function mergePlazaCatalog(
  officialTemplates: readonly OfficialPlazaTemplate[],
  marketItems: readonly PortableMarketItem[],
  avatars: readonly Avatar[] = [],
): PlazaCatalogItem[] {
  const officialItems: PlazaCatalogItem[] = officialTemplates.map((template) => ({
    id: template.id,
    source: "official",
    kind: template.kind,
    title: template.title,
    description: template.description,
    ownerDisplayName: template.ownerDisplayName,
    sourceAvatar: template.kind === "expert"
      ? ensureExpertPortrait(
        template.expertTemplate?.sourceAvatar,
        template.id,
        template.title,
        template.description,
        template.id,
      )
      : undefined,
    officialTemplate: template,
  }));
  const officialKeys = new Set(officialItems.map(catalogKey));
  const companyItems: PlazaCatalogItem[] = marketItems
    .map((item) => ({
      id: `market:${item.kind}:${item.id}`,
      source: "market" as const,
      kind: item.kind,
      title: item.title,
      description: item.description,
      ownerDisplayName: item.ownerDisplayName,
      sourceAvatar: item.kind === "expert"
        ? ensureExpertPortrait(
          findInstalledExpertAvatar(item, avatars),
          `market:${item.id}`,
          item.title,
          item.description,
          item.sourceArtifactId,
        )
        : undefined,
      marketItem: item,
    }))
    .filter((item) => !officialKeys.has(catalogKey(item)));
  return [...officialItems, ...companyItems];
}

const FILTERS: Array<{ id: PlazaKindFilter; label: string }> = [
  { id: "all", label: "全部" },
  { id: "expert", label: "专家" },
  { id: "group", label: "团队" },
];

const SOURCE_FILTERS: Array<{ id: PlazaSourceFilter; label: string }> = [
  { id: "all", label: "全部来源" },
  { id: "official", label: "官方示范" },
  { id: "enterprise", label: "企业分享" },
];

const SORT_OPTIONS: Array<{ id: PlazaSort; label: string }> = [
  { id: "recommended", label: "推荐" },
  { id: "latest", label: "最新发布" },
  { id: "downloads", label: "下载最多" },
  { id: "name", label: "名称" },
];

export function DigitalExpertPlazaView() {
  const avatars = useAppStore((state) => state.avatars);
  const groups = useAppStore((state) => state.groups);
  const setAvatars = useAppStore((state) => state.setAvatars);
  const setGroups = useAppStore((state) => state.setGroups);
  const enterpriseLoggedIn = useAppStore((state) => state.userAccount.loggedIn);
  const enterpriseEmail = useAppStore((state) => state.userAccount.email);
  const enterpriseBaseUrl = useAppStore((state) => state.userAccount.baseUrl ?? "");
  const enterpriseAccountKey = `${enterpriseEmail}\u0000${enterpriseBaseUrl}`;
  const [marketItems, setMarketItems] = useState<PortableMarketItem[]>([]);
  const [kindFilter, setKindFilter] = useState<PlazaKindFilter>("all");
  const [sourceFilter, setSourceFilter] = useState<PlazaSourceFilter>("all");
  const [sort, setSort] = useState<PlazaSort>("recommended");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [openingId, setOpeningId] = useState("");
  const [notice, setNotice] = useState("");
  const [importCandidate, setImportCandidate] = useState<PortablePackageCandidate | null>(null);
  const [selectedGroupTemplate, setSelectedGroupTemplate] = useState<GroupTemplate | null>(null);

  const officialTemplates = useMemo(() => listOfficialPlazaTemplates(avatars), [avatars]);
  const catalogItems = useMemo(
    () => mergePlazaCatalog(officialTemplates, marketItems, avatars),
    [officialTemplates, marketItems, avatars],
  );

  const load = useCallback(async () => {
    if (!enterpriseLoggedIn) {
      setMarketItems([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setMarketItems([]);
    try {
      const [experts, groupsResult] = await Promise.all([
        loadPortableMarketPages(
          "expert",
          (request) => window.agenticxDesktop.listPortablePackageMarket({ ...request, kind: "expert" }),
        ),
        loadPortableMarketPages(
          "group",
          (request) => window.agenticxDesktop.listPortablePackageMarket({ ...request, kind: "group" }),
        ),
      ]);
      setMarketItems(mergePlazaItems(experts.items, groupsResult.items));
      const errors = [
        experts.error,
        groupsResult.error,
      ].filter(Boolean);
      if (errors.length > 0) setNotice(String(errors[0]));
    } catch (error) {
      setMarketItems([]);
      setNotice(error instanceof Error ? error.message : "加载公司分享失败。");
    } finally {
      setLoading(false);
    }
  }, [enterpriseLoggedIn, enterpriseAccountKey]);

  useEffect(() => {
    void load();
    const refresh = () => void load();
    window.addEventListener("portable-market-changed", refresh);
    return () => window.removeEventListener("portable-market-changed", refresh);
  }, [load]);

  const visibleItems = useMemo(
    () => filterPlazaItems(catalogItems, kindFilter, query, sourceFilter, sort),
    [catalogItems, kindFilter, query, sourceFilter, sort],
  );

  const inspectMarketItem = async (item: PortableMarketItem) => {
    const busyId = `market:${item.kind}:${item.id}`;
    setOpeningId(busyId);
    try {
      const result = await window.agenticxDesktop.inspectPortablePackageMarketItem({
        id: item.id,
        kind: item.kind,
      });
      const preview = normalizePortablePackagePreview(result.preview);
      const raw = typeof result.raw === "string" ? result.raw : "";
      const confirmationToken = String(result.confirmationToken ?? "").trim();
      if (!result.ok || !preview || preview.kind !== item.kind || !raw || !confirmationToken) {
        setNotice(result.error || "无法预览该市场条目。");
        return;
      }
      setImportCandidate({
        raw,
        confirmationToken,
        preview,
        sourceLabel: `${item.ownerDisplayName || "公司成员"} · 企业市场`,
      });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "无法预览该市场条目。");
    } finally {
      setOpeningId("");
    }
  };

  const addOfficialExpert = async (template: OfficialPlazaTemplate) => {
    if (!template.expertTemplate) return;
    setOpeningId(template.id);
    try {
      const result = await createExpertFromOfficialTemplate({
        template: template.expertTemplate,
        existingNames: avatars.map((avatar) => avatar.name),
        api: window.agenticxDesktop,
      });
      const mapped = mapAvatarsFromApi([result.avatar]);
      if (mapped.length > 0) {
        const current = useAppStore.getState().avatars;
        setAvatars([
          ...current.filter((avatar) => avatar.id !== mapped[0].id),
          mapped[0],
        ]);
      }
      window.dispatchEvent(
        new CustomEvent("agenticx:avatars:changed", {
          detail: { avatarId: result.avatar.id, name: result.name, openPane: false },
        }),
      );
      setNotice(`已从官方模板添加数字专家「${result.name}」。`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "添加官方数字专家失败。");
    } finally {
      setOpeningId("");
    }
  };

  const handleOfficialTemplate = (template: OfficialPlazaTemplate) => {
    if (template.kind === "expert") {
      void addOfficialExpert(template);
      return;
    }
    if (template.groupTemplate) setSelectedGroupTemplate(template.groupTemplate);
  };

  const refreshCreatedTeam = async (result: GroupTemplateCreationResult) => {
    const optimisticAvatars = mapAvatarsFromApi(result.avatars);
    if (optimisticAvatars.length > 0) {
      const createdIds = new Set(optimisticAvatars.map((avatar) => avatar.id));
      const current = useAppStore.getState().avatars;
      setAvatars([
        ...current.filter((avatar) => !createdIds.has(avatar.id)),
        ...optimisticAvatars,
      ]);
    }
    if (result.group) {
      const mappedGroup = mapGroupsFromApi([result.group])[0];
      if (mappedGroup) {
        const current = useAppStore.getState().groups;
        setGroups([
          ...current.filter((group) => group.id !== mappedGroup.id),
          mappedGroup,
        ]);
      }
    }
    window.dispatchEvent(
      new CustomEvent("agenticx:avatars:changed", { detail: { openPane: false } }),
    );
    window.dispatchEvent(new Event("agenticx:groups:changed"));
    setNotice(`已从官方模板创建专家团队「${result.groupName}」。`);
  };

  return (
    <MainViewShell>
      <div className="sticky top-0 z-10 -mx-6 -mt-6 border-b border-border bg-surface-base px-6 pb-5 pt-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-[min(100%,30rem)] flex-1 items-start gap-3">
            <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[rgba(var(--theme-color-rgb,59,130,246),0.12)] text-[rgb(var(--theme-color-fg-rgb,59,130,246))]">
              <Store className="h-5 w-5" strokeWidth={1.8} aria-hidden />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-text-strong">专家广场</h2>
              <p className="mt-1 max-w-2xl text-sm leading-relaxed text-text-muted">
                从官方模板或同事分享中添加单专家和专家团队；添加后都是可独立管理的副本。
              </p>
            </div>
          </div>
          <button
            type="button"
            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border bg-surface-card px-3 text-xs font-medium text-text-subtle transition hover:bg-surface-hover hover:text-text-strong disabled:opacity-50"
            onClick={() => void load()}
            disabled={loading || !enterpriseLoggedIn}
            title={enterpriseLoggedIn ? "刷新公司分享" : "登录企业账户后可刷新公司分享"}
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} aria-hidden />
            刷新
          </button>
        </div>

        <div className="mt-5 min-w-0 overflow-x-auto pb-1">
          <div className="flex min-w-max flex-nowrap items-center gap-3">
            <div className="relative min-w-[10rem] flex-[1_1_18rem] max-w-[24rem]">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-faint" aria-hidden />
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="h-9 w-full rounded-lg border border-border bg-surface-card pl-9 pr-3 text-xs text-text-primary outline-none transition placeholder:text-text-faint focus:border-[var(--settings-accent-border-strong)]"
                placeholder="搜索专家、团队或发布者"
                aria-label="搜索专家广场"
              />
            </div>
            <div className="inline-flex shrink-0 whitespace-nowrap rounded-lg bg-surface-card p-1" aria-label="专家类型筛选">
              {FILTERS.map((filter) => {
                const active = kindFilter === filter.id;
                return (
                  <button
                    key={filter.id}
                    type="button"
                    className={`rounded-md px-3 py-1.5 text-xs transition ${
                      active
                        ? "bg-surface-card-strong font-medium text-text-strong shadow-sm"
                        : "text-text-faint hover:text-text-strong"
                    }`}
                    aria-pressed={active}
                    onClick={() => setKindFilter(filter.id)}
                  >
                    {filter.label}
                  </button>
                );
              })}
            </div>
            <label className="inline-flex h-9 shrink-0 items-center gap-2 whitespace-nowrap rounded-lg border border-border bg-surface-card px-2.5 text-xs text-text-faint">
              <span>来源</span>
              <select
                value={sourceFilter}
                onChange={(event) => setSourceFilter(event.target.value as PlazaSourceFilter)}
                className="bg-transparent text-xs text-text-strong outline-none"
                aria-label="按来源筛选"
              >
                {SOURCE_FILTERS.map((filter) => (
                  <option key={filter.id} value={filter.id}>{filter.label}</option>
                ))}
              </select>
            </label>
            <label className="inline-flex h-9 shrink-0 items-center gap-2 whitespace-nowrap rounded-lg border border-border bg-surface-card px-2.5 text-xs text-text-faint">
              <Clock3 className="h-3.5 w-3.5" aria-hidden />
              <span>排序</span>
              <select
                value={sort}
                onChange={(event) => setSort(event.target.value as PlazaSort)}
                className="bg-transparent text-xs text-text-strong outline-none"
                aria-label="专家广场排序方式"
              >
                {SORT_OPTIONS.map((option) => (
                  <option key={option.id} value={option.id}>{option.label}</option>
                ))}
              </select>
            </label>
          </div>
        </div>
      </div>

      <div className="space-y-4 pt-5">
        {!enterpriseLoggedIn ? (
          <div className="flex items-center gap-3 rounded-xl border border-border bg-surface-card/45 px-4 py-3">
            <Building2 className="h-5 w-5 shrink-0 text-text-faint" strokeWidth={1.6} aria-hidden />
            <div>
              <div className="text-xs font-medium text-text-strong">当前显示官方模板</div>
              <p className="mt-0.5 text-[11px] text-text-faint">登录企业账户后，还可以看到同事按公司权限分享的内容。</p>
            </div>
          </div>
        ) : loading ? (
          <div className="flex items-center gap-2 rounded-xl border border-border bg-surface-card/45 px-4 py-3 text-xs text-text-faint">
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            正在同步公司分享，官方模板仍可正常添加…
          </div>
        ) : null}

        {visibleItems.length === 0 ? (
          <div className="flex min-h-56 flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-surface-card/35 px-5 text-center">
            <Store className="h-8 w-8 text-text-faint" strokeWidth={1.6} aria-hidden />
            <div className="mt-3 text-sm font-semibold text-text-strong">没有匹配的内容</div>
            <p className="mt-1 text-xs text-text-faint">试试其他关键词或类型。</p>
          </div>
        ) : (
          <div
            className="grid gap-4 sm:gap-5"
            style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(320px, 100%), 1fr))" }}
          >
            {visibleItems.map((item) => {
              const marketItem = item.marketItem;
              const official = item.officialTemplate;
              const expertAvatar = item.kind === "expert" ? item.sourceAvatar : undefined;
              const avatarKind = plazaAvatarKind(item.kind);
              const busy = openingId === item.id;
              return (
                <article
                  key={item.id}
                  className="flex min-h-[204px] min-w-0 flex-col rounded-2xl border border-border bg-surface-card p-4 transition hover:border-[rgba(var(--theme-color-rgb,59,130,246),0.3)] hover:bg-surface-card-strong sm:p-5"
                >
                  <header className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-3">
                    {avatarKind ? (
                      <PlazaAvatar
                        avatar={expertAvatar}
                        name={item.title}
                        kind={avatarKind}
                        sourceArtifactId={marketItem?.sourceArtifactId}
                      />
                    ) : (
                      <div
                        className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-surface-panel text-[10px] font-medium text-text-faint ring-1 ring-border/70"
                        aria-label="能力包"
                      >
                        能力
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <h3 className="line-clamp-2 break-words text-sm font-semibold leading-5 text-text-strong">{item.title}</h3>
                      <p className="mt-1 truncate text-[11px] leading-4 text-text-faint">
                        {item.source === "official"
                          ? "AgenticX 提供示范"
                          : item.ownerDisplayName
                            ? `${item.ownerDisplayName} 发布`
                            : "公司成员发布"}
                      </p>
                    </div>
                  </header>

                  <div
                    className="mt-3 flex min-w-0 flex-wrap items-center gap-1.5"
                    role="group"
                    aria-label="条目类型与认证状态"
                  >
                    <span className="inline-flex h-5 shrink-0 items-center rounded-full border border-border px-2 text-[10px] leading-none text-text-faint">
                      {marketKindLabel(item.kind)}
                    </span>
                    {official ? (
                      <span
                        className="inline-flex h-5 shrink-0 items-center gap-1 rounded-full bg-[rgba(var(--theme-color-rgb,59,130,246),0.1)] px-2 text-[10px] font-medium leading-none text-[rgb(var(--theme-color-fg-rgb,59,130,246))]"
                        title="官方认证内容"
                      >
                        <ShieldCheck className="h-3 w-3" aria-hidden />
                        官方认证
                      </span>
                    ) : null}
                  </div>

                  <p className="mt-4 line-clamp-2 text-xs leading-5 text-text-muted">
                    {item.description || "未填写说明"}
                  </p>

                  <footer className="mt-auto">
                    {item.source !== "official" ? (
                      <div
                        className="mt-4 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5 border-t border-border-muted pt-3 text-[10px] text-text-faint"
                        role="group"
                        aria-label="市场元数据"
                      >
                        <span className="inline-flex max-w-full min-w-0 items-center gap-1 rounded-full bg-surface-panel px-2 py-1">
                          <Building2 className="h-3 w-3 shrink-0" aria-hidden />
                          <span className="truncate">企业内部</span>
                        </span>
                        {marketItem ? (
                          <span className="inline-flex max-w-full min-w-0 items-center gap-1 rounded-full bg-surface-panel px-2 py-1">
                            <ShieldCheck className="h-3 w-3 shrink-0" aria-hidden />
                            <span className="truncate">{visibilityLabel(marketItem)}</span>
                          </span>
                        ) : null}
                        {marketItem?.version ? (
                          <span className="max-w-full truncate rounded-full bg-surface-panel px-2 py-1 font-mono">
                            v{marketItem.version}
                          </span>
                        ) : null}
                        {marketItem ? (
                          <span title="同一账号同一版本只计一次，跨版本累计；不含能力包自动下发。" className="inline-flex max-w-full min-w-0 items-center gap-1 rounded-full bg-surface-panel px-2 py-1 tabular-nums">
                            <Download className="h-3 w-3 shrink-0" aria-hidden />
                            <span className="truncate">下载 {marketItem.downloadCount} 次</span>
                          </span>
                        ) : null}
                      </div>
                    ) : null}

                    <button
                      type="button"
                      className="mt-3 inline-flex h-10 w-full items-center justify-center gap-1.5 rounded-lg bg-[var(--ui-btn-primary-bg)] px-3 text-xs font-medium text-[var(--ui-btn-primary-text)] transition hover:bg-[var(--ui-btn-primary-bg-hover)] disabled:opacity-60"
                      disabled={Boolean(openingId)}
                      onClick={() => {
                        if (official) handleOfficialTemplate(official);
                        else if (marketItem) void inspectMarketItem(marketItem);
                      }}
                    >
                      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
                      {item.source === "official"
                        ? item.kind === "expert" ? "添加专家" : item.kind === "group" ? "添加团队" : "查看能力包"
                        : "查看并添加"}
                    </button>
                  </footer>
                </article>
              );
            })}
          </div>
        )}
      </div>

      {selectedGroupTemplate ? (
        <GroupTemplateCreateDialog
          key={selectedGroupTemplate.id}
          template={selectedGroupTemplate}
          initialGroupName={nextAvailableTemplateGroupName(
            selectedGroupTemplate.name,
            groups.map((group) => group.name),
          )}
          onClose={() => setSelectedGroupTemplate(null)}
          onCreated={refreshCreatedTeam}
        />
      ) : null}

      <PortablePackageImportDialog
        candidate={importCandidate}
        onClose={() => setImportCandidate(null)}
        onImported={async (result) => {
          const kind = result.kind ?? importCandidate?.preview.kind;
          const name = result.group?.name || result.avatar?.name || importCandidate?.preview.name || "数字专家";
          await load();
          setNotice(`已添加${kind === "group" ? "专家团队" : "数字专家"}「${name}」。`);
        }}
      />

      <Toast open={Boolean(notice)} message={notice} onClose={() => setNotice("")} />
    </MainViewShell>
  );
}
