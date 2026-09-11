"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocale } from "next-intl";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  ScrollArea,
} from "@agenticx/ui";
import {
  Bot,
  ChevronDown,
  LayoutGrid,
  Library,
  List,
  RefreshCcw,
  Search,
  FileText,
  UsersRound,
} from "lucide-react";
import Link from "next/link";

import { adminFetch } from "../../lib/admin-client-auth";
import {
  configMarketActionForStatus,
  configMarketDetailFromPayload,
  configMarketVisibilityLabel,
  filterConfigMarketItems,
  type ConfigMarketAction,
  type ConfigMarketItem,
  type ConfigMarketItemDetail,
  type ConfigMarketStatus,
} from "../../lib/config-market";
import { plainText } from "../../lib/plain-text";

type StatusFilter = ConfigMarketStatus | "all";
type KindFilter = ConfigMarketItem["kind"] | "all";
export type ConfigMarketViewMode = "cards" | "list";
export type ConfigMarketSort =
  | "updated-desc"
  | "updated-asc"
  | "title-asc"
  | "title-desc"
  | "downloads";

function filterOptions(locale: string) {
  const copy = (zh: string, en: string) => (locale === "en" ? en : zh);
  return {
    status: [
      { id: "all" as const, label: copy("全部", "All") },
      { id: "published" as const, label: copy("市场已上架", "Listed") },
      { id: "unlisted" as const, label: copy("市场已下架", "Unlisted") },
    ],
    kind: [
      { id: "all" as const, label: copy("全部类型", "All types") },
      { id: "expert" as const, label: copy("数字专家", "Digital experts") },
      { id: "group" as const, label: copy("项目群聊", "Project groups") },
      { id: "skill" as const, label: "Skill" },
    ],
    sort: [
      { id: "updated-desc" as const, label: copy("更新时间（新到旧）", "Updated (newest first)") },
      { id: "updated-asc" as const, label: copy("更新时间（旧到新）", "Updated (oldest first)") },
      { id: "title-asc" as const, label: copy("名称（A 到 Z）", "Name (A to Z)") },
      { id: "title-desc" as const, label: copy("名称（Z 到 A）", "Name (Z to A)") },
      { id: "downloads" as const, label: copy("下载最多", "Most downloaded") },
    ],
  };
}

const CONFIG_MARKET_VIEW_MODE_KEY = "admin-config-market-view-mode";
const DOWNLOAD_COUNT_HINT_ZH = "同一账号同一版本只计一次，跨版本累计；不含能力包自动下发。";
const MARKET_LIST_GRID_CLASS =
  "grid min-w-[1040px] grid-cols-[minmax(280px,1.65fr)_150px_minmax(170px,0.9fr)_minmax(230px,1.15fr)_104px] items-center gap-4";
const MARKET_LIST_DETAIL_GRID_CLASS =
  "grid min-w-0 grid-cols-[minmax(280px,1.65fr)_150px_minmax(170px,0.9fr)_minmax(230px,1.15fr)] items-center gap-4";

/** Enter and Space are the two standard activation keys for a custom button. */
export function isConfigMarketDetailActivationKey(key: string): boolean {
  return key === "Enter" || key === " ";
}

function formatUpdatedAt(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function compareTitles(left: ConfigMarketItem, right: ConfigMarketItem): number {
  return left.title.localeCompare(right.title, undefined, {
    numeric: true,
    sensitivity: "base",
  }) || left.id.localeCompare(right.id);
}

function compareUpdatedAt(left: ConfigMarketItem, right: ConfigMarketItem, descending: boolean): number {
  const leftTime = Date.parse(left.updatedAt);
  const rightTime = Date.parse(right.updatedAt);
  const leftIsValid = !Number.isNaN(leftTime);
  const rightIsValid = !Number.isNaN(rightTime);

  // Invalid timestamps are kept after valid values in either direction. This makes a
  // malformed server value visible without letting it jump to the top of the shelf.
  if (leftIsValid !== rightIsValid) return leftIsValid ? -1 : 1;
  if (leftIsValid && rightIsValid && leftTime !== rightTime) {
    return descending ? rightTime - leftTime : leftTime - rightTime;
  }
  return compareTitles(left, right);
}

function compareDownloads(left: ConfigMarketItem, right: ConfigMarketItem): number {
  if (left.downloadCount !== right.downloadCount) {
    return left.downloadCount > right.downloadCount ? -1 : 1;
  }
  // Keep equal download counts deterministic as new rows arrive: newest update first,
  // then title/id through compareUpdatedAt's existing tie breakers.
  return compareUpdatedAt(left, right, true);
}

function downloadCountLabel(item: ConfigMarketItem, locale = "zh"): string {
  return locale === "en" ? `${item.downloadCount} downloads` : `${item.downloadCount} 次下载`;
}

function marketKindLabel(item: ConfigMarketItem, locale = "zh"): string {
  if (item.kind === "expert") return locale === "en" ? "Digital expert" : "数字专家";
  if (item.kind === "group") return locale === "en" ? "Project group" : "项目群聊";
  return "Skill";
}

function marketVisibilityLabel(item: ConfigMarketItem, locale = "zh"): string {
  if (locale !== "en") return configMarketVisibilityLabel(item);
  if (item.visibility === "personal") return "Only me";
  if (item.visibility === "departments") return `Selected departments (${item.visibleDepartmentIds.length})`;
  if (item.visibility === "users") return `Selected colleagues (${item.visibleUserIds.length})`;
  if (item.visibility === "admins_only") return "Admins only";
  return "Everyone in the company";
}

function ConfigMarketDetailBody({ detail }: { detail: ConfigMarketItemDetail }) {
  const locale = useLocale();
  const copy = (zh: string, en: string) => (locale === "en" ? en : zh);
  const { item, promptPreview, runtimeReview } = detail;
  return (
    <ScrollArea className="max-h-[62vh] pr-4">
      <div className="space-y-5">
        <div className="flex items-start gap-3 rounded-xl border bg-muted/20 p-4">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
            {item.kind === "expert" ? <Bot className="h-5 w-5" /> : item.kind === "group" ? <UsersRound className="h-5 w-5" /> : <FileText className="h-5 w-5" />}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <h3 className="font-semibold">{item.title}</h3>
              <Badge variant="outline">{marketKindLabel(item, locale)}</Badge>
              <Badge variant={item.status === "published" ? "default" : "secondary"}>
                {item.status === "published"
                  ? item.visibility === "admins_only" ? copy("已提交管理员", "Submitted to admins") : copy("已上架", "Listed")
                  : copy("已下架", "Unlisted")}
              </Badge>
              <Badge variant={item.deliveryState === "revoked" ? "destructive" : "outline"}>
                {item.deliveryState === "revoked" ? copy("已撤回下发", "Delivery withdrawn") : copy("允许能力包下发", "Pack delivery allowed")}
              </Badge>
              <Badge variant="outline">v{item.version}</Badge>
              <Badge variant="outline" title={copy(DOWNLOAD_COUNT_HINT_ZH, "Counted once per account and version; pack auto-delivery is excluded.")}>{downloadCountLabel(item, locale)}</Badge>
            </div>
            <p className="mt-1 break-all font-mono text-xs text-muted-foreground">{item.capabilityId}</p>
          </div>
        </div>

        <p className="whitespace-pre-wrap break-words text-sm leading-6 text-muted-foreground">
          {plainText(item.description) || copy("（无说明）", "(No description)")}
        </p>

        <dl className="grid gap-3 rounded-xl border p-4 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs text-muted-foreground">{copy("分享者", "Shared by")}</dt>
            <dd className="mt-1 font-medium">{item.ownerDisplayName || copy("未知成员", "Unknown member")}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">{copy("市场范围", "Market visibility")}</dt>
            <dd className="mt-1 font-medium">{marketVisibilityLabel(item, locale)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">{copy("发布时间", "Published")}</dt>
            <dd className="mt-1 font-medium">{formatUpdatedAt(item.createdAt)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">{copy("最近更新", "Last updated")}</dt>
            <dd className="mt-1 font-medium">{formatUpdatedAt(item.updatedAt)}</dd>
          </div>
        </dl>

        {item.visibility === "admins_only" ? (
          <p className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-amber-700 dark:text-amber-400">
            {copy("该条目选择了“仅管理员”范围，不会出现在员工自助市场；管理员核对详情后仍可加入能力货架，再通过能力包强制下发。", "This item is visible to admins only. It will not appear in the employee market; admins can review it, add it to the capability shelf, and deliver it through a capability pack.")}
          </p>
        ) : null}

        {promptPreview.kind === "skill" ? (
          <section className="space-y-3">
            <div>
              <h3 className="text-sm font-semibold">SKILL.md</h3>
              <p className="text-xs text-muted-foreground">
                {promptPreview.name} · {promptPreview.description || copy("未设置说明", "No description")}
              </p>
            </div>
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg border bg-muted/40 p-3 font-mono text-xs">
              {promptPreview.skillMd || copy("（空文件）", "(Empty file)")}
            </pre>
            <div className="rounded-lg border p-3 text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">{copy("结构检查", "Structure check")}</span>
                <Badge variant={promptPreview.checkResult.status === "passed" ? "default" : "destructive"}>
                  {promptPreview.checkResult.status === "passed" ? copy("通过", "Passed") : copy("需处理", "Needs attention")}
                </Badge>
              </div>
              <p className="mt-2 text-muted-foreground">
                front matter · name: {promptPreview.checkResult.frontMatter.name || copy("缺失", "missing")} · description: {promptPreview.checkResult.frontMatter.description ? copy("已填写", "provided") : copy("缺失", "missing")}
              </p>
              {promptPreview.checkResult.findings.length > 0 ? (
                <ul className="mt-2 list-disc space-y-1 pl-4 text-destructive">
                  {promptPreview.checkResult.findings.map((finding) => <li key={finding}>{finding}</li>)}
                </ul>
              ) : null}
            </div>
          </section>
        ) : promptPreview.kind === "expert" ? (
          <section className="space-y-2">
            <div>
            <h3 className="text-sm font-semibold">{copy("专家身份", "Expert identity")}</h3>
              <p className="text-xs text-muted-foreground">
                {promptPreview.name} · {promptPreview.role || copy("未设置角色", "No role")}
              </p>
            </div>
            <div>
              <h4 className="mb-1 text-xs font-medium text-muted-foreground">{copy("系统提示词", "System prompt")}</h4>
              <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-lg border bg-muted/40 p-3 font-mono text-xs">
                {promptPreview.systemPrompt || copy("（空提示词）", "(Empty prompt)")}
              </pre>
            </div>
          </section>
        ) : (
          <section className="space-y-2">
            <h3 className="text-sm font-semibold">{copy("群聊成员", "Group members")}</h3>
            <div className="space-y-2">
              {promptPreview.members.map((member, index) => (
                <div key={`${member.name}-${index}`} className="rounded-lg border p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">{member.name}</span>
                    {index === promptPreview.hostMemberIndex ? <Badge variant="secondary">{copy("主持专家", "Host expert")}</Badge> : null}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">{member.role || copy("未设置角色", "No role")}</p>
                  <pre className="mt-2 whitespace-pre-wrap break-words rounded bg-muted/40 p-3 font-mono text-xs">
                    {member.systemPrompt || copy("（空提示词）", "(Empty prompt)")}
                  </pre>
                </div>
              ))}
            </div>
          </section>
        )}

        <section className="space-y-3 border-t pt-4">
          <div>
            <h3 className="text-sm font-semibold">{copy("运行配置", "Runtime configuration")}</h3>
            <p className="mt-1 text-xs text-muted-foreground">{copy("管理员可在这里核对下发前会带上的能力与权限。", "Admins can review the capabilities and permissions included before delivery.")}</p>
          </div>
          <div className="flex items-center justify-between rounded-lg border px-3 py-2 text-sm">
            <span>{copy("建议运行权限", "Recommended runtime permission")}</span>
            <Badge variant="outline">{runtimeReview.recommendedPermissionMode}</Badge>
          </div>
          {runtimeReview.expertPermissions.length > 0 ? <div className="space-y-2">
            <h4 className="text-xs font-medium text-muted-foreground">{copy("各专家默认运行权限", "Default permission per expert")}</h4>
            {runtimeReview.expertPermissions.map((expert, index) => (
              <div key={`${expert.name}-${index}`} className="flex items-center justify-between rounded-lg border px-3 py-2 text-xs">
                <span>{expert.name}</span>
                <Badge variant="outline">{expert.defaultPermissionMode}</Badge>
              </div>
            ))}
          </div> : null}
        </section>

        <section className="space-y-2">
          <h3 className="text-sm font-semibold">{copy("依赖能力", "Required capabilities")}</h3>
          {runtimeReview.dependencies.length > 0 ? (
            <div className="space-y-2">
              {runtimeReview.dependencies.map((dependency) => (
                <div key={dependency.capabilityId} className="rounded-lg border p-3 text-xs">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono font-medium">{dependency.capabilityId}</span>
                    {dependency.required ? <Badge variant="secondary">{copy("必需", "Required")}</Badge> : <Badge variant="outline">{copy("可选", "Optional")}</Badge>}
                  </div>
                  <p className="mt-1 text-muted-foreground">
                    {dependency.kind === "mcp"
                      ? `MCP · ${copy("版本", "version")} ${dependency.version}`
                      : `Skill · ${copy("版本", "version")} ${dependency.version}${dependency.digest ? ` · ${copy("摘要", "digest")} ${dependency.digest}` : ""}`}
                  </p>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">{copy("无 Skill / MCP 依赖", "No Skill / MCP dependencies")}</p>
          )}
        </section>

        <section className="space-y-2">
          <h3 className="text-sm font-semibold">{copy("随包 Markdown 资源", "Bundled Markdown resources")}</h3>
          {runtimeReview.resources.length > 0 ? (
            <div className="space-y-2">
              {runtimeReview.resources.map((resource) => (
                <div key={resource.path} className="rounded-lg border p-3">
                  <p className="font-mono text-xs font-medium">{resource.path}</p>
                  <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/40 p-3 font-mono text-xs">
                    {resource.content}
                  </pre>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">{copy("未附带 Markdown 资源", "No Markdown resources attached")}</p>
          )}
        </section>
      </div>
    </ScrollArea>
  );
}

/** Sort a copy so the cards and list render exactly the same shelf order. */
export function sortConfigMarketItems(
  items: readonly ConfigMarketItem[],
  sort: ConfigMarketSort,
): ConfigMarketItem[] {
  return [...items].sort((left, right) => {
    switch (sort) {
      case "updated-asc":
        return compareUpdatedAt(left, right, false);
      case "title-asc":
        return compareTitles(left, right) || compareUpdatedAt(left, right, true);
      case "title-desc":
        return compareTitles(right, left) || compareUpdatedAt(left, right, true);
      case "downloads":
        return compareDownloads(left, right);
      case "updated-desc":
      default:
        return compareUpdatedAt(left, right, true);
    }
  });
}

/**
 * 企业成员分享出来的专家与项目群聊。
 *
 * 市场上下架与能力货架 membership 是两层状态：员工可以自行发布，管理员查看完整配置后
 * 再决定是否加入能力货架。内容版本、分享者和 capabilityId 都来自服务端；浏览器只发
 * 明确动作，不把整份 metadata 写回去。
 */
export function EnterpriseConfigMarketPanel({
  items,
  loading,
  busyItemId,
  onReload,
  onAction,
  shelfCapabilityIds = [],
  shelfBusy = false,
  onAddToShelf,
  defaultExpanded = false,
  defaultViewMode = "cards",
}: {
  items: readonly ConfigMarketItem[];
  loading: boolean;
  busyItemId?: string | null;
  onReload: () => void;
  onAction: (item: ConfigMarketItem, action: ConfigMarketAction) => void;
  shelfCapabilityIds?: readonly string[];
  shelfBusy?: boolean;
  onAddToShelf?: (detail: ConfigMarketItemDetail) => void;
  defaultExpanded?: boolean;
  defaultViewMode?: ConfigMarketViewMode;
}) {
  const locale = useLocale();
  const copy = (zh: string, en: string) => (locale === "en" ? en : zh);
  const { status: statusFilters, kind: kindFilters, sort: sortOptions } = filterOptions(locale);
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [status, setStatus] = useState<StatusFilter>("all");
  const [kind, setKind] = useState<KindFilter>("all");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<ConfigMarketSort>("updated-desc");
  const [viewMode, setViewMode] = useState<ConfigMarketViewMode>(defaultViewMode);
  const [viewModeHydrated, setViewModeHydrated] = useState(false);
  const [detailTarget, setDetailTarget] = useState<ConfigMarketItem | null>(null);
  const [detail, setDetail] = useState<ConfigMarketItemDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const detailRequestRef = useRef(0);
  const shelfCapabilityIdSet = useMemo(
    () => new Set(shelfCapabilityIds),
    [shelfCapabilityIds],
  );

  useEffect(() => {
    const saved = window.localStorage.getItem(CONFIG_MARKET_VIEW_MODE_KEY);
    if (saved === "cards" || saved === "list") setViewMode(saved);
    setViewModeHydrated(true);
  }, []);

  useEffect(() => {
    if (viewModeHydrated) window.localStorage.setItem(CONFIG_MARKET_VIEW_MODE_KEY, viewMode);
  }, [viewMode, viewModeHydrated]);

  const visible = useMemo(() => {
    const filtered = filterConfigMarketItems(items, status, query).filter(
      (item) => kind === "all" || item.kind === kind,
    );
    return sortConfigMarketItems(filtered, sort);
  }, [items, kind, query, sort, status]);
  const summary = useMemo(() => ({
    published: items.filter((item) => item.status === "published" && item.visibility !== "admins_only").length,
    unlisted: items.filter((item) => item.status === "unlisted").length,
    adminsOnly: items.filter((item) => item.visibility === "admins_only").length,
  }), [items]);

  const itemBadges = (item: ConfigMarketItem) => (
    <>
      <Badge variant="outline">{marketKindLabel(item, locale)}</Badge>
      <Badge variant={item.status === "published" ? "default" : "secondary"}>
        {item.status === "published"
          ? item.visibility === "admins_only" ? copy("已提交管理员", "Submitted to admins") : copy("市场已上架", "Listed")
          : copy("市场已下架", "Unlisted")}
      </Badge>
      {shelfCapabilityIdSet.has(item.capabilityId) ? (
        <Badge variant="outline">{copy("已入货架", "On shelf")}</Badge>
      ) : null}
      {item.deliveryState === "revoked" ? <Badge variant="destructive">{copy("紧急撤回", "Emergency withdrawal")}</Badge> : null}
      {item.visibility === "admins_only" ? <Badge variant="secondary">{copy("仅管理员可见", "Admins only")}</Badge> : null}
      <Badge variant="outline">v{item.version}</Badge>
    </>
  );

  const closeDetail = useCallback(() => {
    detailRequestRef.current += 1;
    setDetailTarget(null);
    setDetail(null);
    setDetailError(null);
    setDetailLoading(false);
  }, []);

  const openDetail = useCallback(async (item: ConfigMarketItem) => {
    const requestId = ++detailRequestRef.current;
    setDetailTarget(item);
    setDetail(null);
    setDetailError(null);
    setDetailLoading(true);
    try {
      const response = await adminFetch(
        `/api/admin/config-market/${encodeURIComponent(item.id)}`,
        { cache: "no-store" },
      );
      const payload = (await response.json().catch(() => ({}))) as unknown;
      const parsed = configMarketDetailFromPayload(payload);
      if (
        !response.ok ||
        !parsed ||
        parsed.item.id.toUpperCase() !== item.id.toUpperCase() ||
        parsed.item.capabilityId !== item.capabilityId
      ) {
        throw new Error(response.ok ? copy("详情格式异常，无法展示", "The detail payload is invalid") : copy("读取详情失败", "Failed to load details"));
      }
      if (requestId !== detailRequestRef.current) return;
      setDetail(parsed);
    } catch (error) {
      if (requestId !== detailRequestRef.current) return;
      setDetailError(error instanceof Error ? error.message : copy("读取详情失败", "Failed to load details"));
    } finally {
      if (requestId === detailRequestRef.current) setDetailLoading(false);
    }
  }, []);

  const handleDetailKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>, item: ConfigMarketItem) => {
      if (!isConfigMarketDetailActivationKey(event.key)) return;
      event.preventDefault();
      void openDetail(item);
    },
    [openDetail],
  );

  const actionButton = (item: ConfigMarketItem) => {
    const action = configMarketActionForStatus(item.status);
    const busy = busyItemId === item.id;
    return (
      <div className="flex flex-wrap justify-end gap-2">
        <Button
          type="button"
          size="sm"
          variant={item.status === "published" ? "outline" : "default"}
          disabled={busy}
          onClick={(event) => {
            event.stopPropagation();
            onAction(item, action);
          }}
        >
          {busy ? copy("处理中…", "Working…") : action === "unlist" ? copy("下架", "Unlist") : copy("恢复上架", "Relist")}
        </Button>
        <Button
          type="button"
          size="sm"
          variant={item.deliveryState === "revoked" ? "secondary" : "destructive"}
          disabled={busy}
          onClick={(event) => {
            event.stopPropagation();
            onAction(item, item.deliveryState === "revoked" ? "restore_delivery" : "revoke_delivery");
          }}
        >
          {busy ? copy("处理中…", "Working…") : item.deliveryState === "revoked" ? copy("恢复下发", "Restore delivery") : copy("紧急撤回下发", "Withdraw delivery")}
        </Button>
      </div>
    );
  };

  const ownerMeta = (item: ConfigMarketItem) => (
    <>
      <Link
        href={`/iam/users?user=${encodeURIComponent(item.ownerUserId)}`}
        className="font-medium text-foreground underline decoration-border underline-offset-2"
        onClick={(event) => event.stopPropagation()}
      >
        {item.ownerDisplayName || copy("未知成员", "Unknown member")}
      </Link>
      <span className="font-mono"> · {item.ownerUserId}</span>
    </>
  );

  return (
    <Card className="overflow-hidden">
      <CardHeader className={expanded ? "border-b bg-muted/10" : "bg-muted/10 py-4"}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 flex-1 items-start gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <Library className="h-5 w-5" />
            </span>
            <div className="min-w-0 space-y-2">
              <div className="space-y-1">
                <CardTitle>{copy("企业专家、群聊与 Skill 市场", "Enterprise experts, groups & Skill market")}</CardTitle>
                <CardDescription>
                  {copy("成员自行发布并选择可见范围；这里负责市场发布管理。市场上架不等于进入能力货架，管理员核对详情后再加入；加入货架后还需在能力包中明确选择才会强制下发。仅管理员条目不会出现在员工自助市场，但管理员仍可核对后加入货架与能力包。", "Members publish items and choose their visibility. This panel manages listings. Being listed does not add an item to the capability shelf; admins review it first, then select it in a capability pack for delivery. Admin-only items stay out of the employee market.")}
                </CardDescription>
              </div>
              <div className="flex flex-wrap gap-1.5" aria-label={copy("企业专家、群聊与 Skill 市场摘要", "Enterprise market summary")}>
                {loading && items.length === 0 ? (
                  <Badge variant="outline">{copy("正在同步…", "Syncing…")}</Badge>
                ) : (
                  <>
                    <Badge variant="outline">{copy("共", "Total")} {items.length}</Badge>
                    <Badge variant="outline">{copy("市场上架", "Listed")} {summary.published}</Badge>
                    <Badge variant="outline">{copy("市场下架", "Unlisted")} {summary.unlisted}</Badge>
                    {summary.adminsOnly > 0 ? <Badge variant="secondary">{copy("仅管理员", "Admins only")} {summary.adminsOnly}</Badge> : null}
                  </>
                )}
              </div>
            </div>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-expanded={expanded}
            aria-controls={expanded ? "enterprise-config-market-content" : undefined}
            onClick={() => setExpanded((current) => !current)}
          >
            {expanded ? copy("收起", "Collapse") : copy("展开管理", "Manage")}
            <ChevronDown className={`h-4 w-4 transition-transform ${expanded ? "rotate-180" : ""}`} />
          </Button>
        </div>
      </CardHeader>
      {expanded ? (
        <CardContent id="enterprise-config-market-content" className="space-y-4 p-4 md:p-5">
          <div
            className="flex min-w-0 flex-nowrap items-center gap-2 overflow-x-auto pb-1"
            role="toolbar"
            aria-label={copy("企业专家、群聊与 Skill 市场筛选和排序", "Filter and sort the enterprise market")}
          >
            <div className="flex shrink-0 rounded-lg border bg-background p-0.5" aria-label={copy("市场类型筛选", "Market type filter")}>
              {kindFilters.map((filter) => (
                <button
                  key={filter.id}
                  type="button"
                  className={`whitespace-nowrap rounded-md px-3 py-1.5 text-sm transition ${
                    kind === filter.id
                      ? "bg-muted font-medium"
                      : "text-muted-foreground hover:bg-muted/60"
                  }`}
                  aria-pressed={kind === filter.id}
                  onClick={() => setKind(filter.id)}
                >
                  {filter.label}
                </button>
              ))}
            </div>
            <div className="flex shrink-0 rounded-lg border bg-background p-0.5" aria-label={copy("市场状态筛选", "Market status filter")}>
              {statusFilters.map((filter) => (
                <button
                  key={filter.id}
                  type="button"
                  className={`whitespace-nowrap rounded-md px-3 py-1.5 text-sm transition ${
                    status === filter.id
                      ? "bg-muted font-medium"
                      : "text-muted-foreground hover:bg-muted/60"
                  }`}
                  aria-pressed={status === filter.id}
                  onClick={() => setStatus(filter.id)}
                >
                  {filter.label}
                </button>
              ))}
            </div>
            <label className="flex h-9 shrink-0 items-center gap-1.5 rounded-lg border bg-background px-2 text-sm">
              <span className="whitespace-nowrap text-xs text-muted-foreground">{copy("排序", "Sort")}</span>
              <select
                value={sort}
                onChange={(event) => setSort(event.target.value as ConfigMarketSort)}
                aria-label={copy("货架排序", "Shelf sort")}
                className="h-8 min-w-[126px] bg-transparent px-0.5 pr-5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {sortOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <div className="relative w-40 shrink-0">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={copy("搜索名称、分享者或说明", "Search by name, owner, or description")}
                aria-label={copy("搜索专家、群聊与 Skill", "Search experts, groups and Skills")}
                className="pl-9"
              />
            </div>
            <div
              className="inline-flex shrink-0 items-center rounded-lg border bg-background p-0.5"
              role="group"
              aria-label={copy("切换专家、群聊与 Skill 市场视图", "Switch market view")}
            >
              <Button
                type="button"
                variant={viewMode === "cards" ? "secondary" : "ghost"}
                size="sm"
                className="h-8 gap-1.5 rounded-md px-2.5"
                aria-pressed={viewMode === "cards"}
                onClick={() => setViewMode("cards")}
              >
                <LayoutGrid className="h-4 w-4" />
                <span className="hidden sm:inline">{copy("卡片", "Cards")}</span>
              </Button>
              <Button
                type="button"
                variant={viewMode === "list" ? "secondary" : "ghost"}
                size="sm"
                className="h-8 gap-1.5 rounded-md px-2.5"
                aria-pressed={viewMode === "list"}
                onClick={() => setViewMode("list")}
              >
                <List className="h-4 w-4" />
                <span className="hidden sm:inline">{copy("列表", "List")}</span>
              </Button>
            </div>
            <Button
              className="shrink-0 whitespace-nowrap"
              variant="outline"
              size="sm"
              onClick={onReload}
              disabled={loading}
            >
              <RefreshCcw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} /> {copy("刷新", "Refresh")}
            </Button>
          </div>

          {loading && items.length === 0 ? (
            <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
              {copy("正在加载企业市场…", "Loading enterprise market…")}
            </div>
          ) : visible.length === 0 ? (
            <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
              {items.length === 0 ? copy("还没有成员分享专家、项目群聊或 Skill。", "No experts, project groups, or Skills have been shared yet.") : copy("没有匹配的条目。", "No matching items.")}
            </div>
          ) : viewMode === "cards" ? (
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3" data-view="cards">
              {visible.map((item) => (
                <Card
                  key={item.id}
                  className="flex h-full cursor-pointer flex-col transition-colors hover:border-primary/40"
                  onClick={() => void openDetail(item)}
                >
                  <CardContent className="flex h-full flex-col p-4">
                    <div
                      role="button"
                      tabIndex={0}
                      data-detail-trigger={item.id}
                      aria-label={`${copy("查看", "View")} ${marketKindLabel(item, locale)}: ${item.title}`}
                      className="flex min-h-0 flex-1 cursor-pointer flex-col gap-3 rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                      onKeyDown={(event) => handleDetailKeyDown(event, item)}
                    >
                      <div className="flex items-start gap-3">
                        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground">
                          {item.kind === "expert" ? <Bot className="h-5 w-5" /> : item.kind === "group" ? <UsersRound className="h-5 w-5" /> : <FileText className="h-5 w-5" />}
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-medium" title={item.title}>{item.title}</p>
                          <p className="mt-1 truncate font-mono text-xs text-muted-foreground">{item.capabilityId}</p>
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-1.5">{itemBadges(item)}</div>
                      <p
                        className="line-clamp-3 min-h-[3.75rem] text-sm text-muted-foreground"
                        title={plainText(item.description) || undefined}
                      >
                        {plainText(item.description) || copy("（无说明）", "(No description)")}
                      </p>
                    </div>
                    <div className="mt-3 space-y-2 border-t pt-3 text-xs text-muted-foreground">
                      <p>{copy("市场", "Market")}: {marketVisibilityLabel(item, locale)}</p>
                      <p className="truncate">{copy("分享者", "Shared by")}: {ownerMeta(item)}</p>
                      <div className="flex items-center justify-between gap-3">
                        <span>{copy("更新于", "Updated")} {formatUpdatedAt(item.updatedAt)}</span>
                        <span className="shrink-0" title={copy(DOWNLOAD_COUNT_HINT_ZH, "Counted once per account and version; pack auto-delivery is excluded.")}>{downloadCountLabel(item, locale)}</span>
                      </div>
                      {actionButton(item)}
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          ) : (
            <div className="overflow-hidden rounded-xl border bg-card" data-view="list">
              <div className="overflow-x-auto">
                <div className="min-w-[1040px]">
                  <div className={`${MARKET_LIST_GRID_CLASS} border-b bg-muted/30 px-4 py-3 text-xs font-medium text-muted-foreground`} role="row">
                    <div role="columnheader">{copy("名称与说明", "Name & description")}</div>
                    <div role="columnheader">{copy("类型与状态", "Type & status")}</div>
                    <div role="columnheader">{copy("市场范围", "Market visibility")}</div>
                    <div role="columnheader">{copy("分享者与更新时间（含下载量）", "Owner, updated time & downloads")}</div>
                    <div role="columnheader" className="text-right">{copy("操作", "Actions")}</div>
                  </div>
                  <div className="divide-y">
                    {visible.map((item) => (
                      <div key={item.id} className={`${MARKET_LIST_GRID_CLASS} px-4 py-3`} role="row">
                        <div
                          role="button"
                          tabIndex={0}
                          data-detail-trigger={item.id}
                          aria-label={`${copy("查看", "View")} ${marketKindLabel(item, locale)}: ${item.title}`}
                          className={`${MARKET_LIST_DETAIL_GRID_CLASS} col-span-4 cursor-pointer rounded-lg py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2`}
                          onClick={() => void openDetail(item)}
                          onKeyDown={(event) => handleDetailKeyDown(event, item)}
                        >
                          <div className="flex min-w-0 items-start gap-3">
                            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                              {item.kind === "expert" ? <Bot className="h-4 w-4" /> : item.kind === "group" ? <UsersRound className="h-4 w-4" /> : <FileText className="h-4 w-4" />}
                            </span>
                            <div className="min-w-0">
                              <p className="truncate font-medium">{item.title}</p>
                              <p className="line-clamp-1 text-xs text-muted-foreground" title={plainText(item.description) || undefined}>
                                {plainText(item.description) || copy("（无说明）", "(No description)")}
                              </p>
                            </div>
                          </div>
                          <div className="flex flex-wrap gap-1.5">{itemBadges(item)}</div>
                          <div className="text-sm">{configMarketVisibilityLabel(item)}</div>
                          <div className="min-w-0 text-xs text-muted-foreground">
                            <p className="truncate">{item.ownerDisplayName || copy("未知成员", "Unknown member")}</p>
                            <p className="mt-1">{formatUpdatedAt(item.updatedAt)}</p>
                            <p className="mt-1" title={copy(DOWNLOAD_COUNT_HINT_ZH, "Counted once per account and version; pack auto-delivery is excluded.")}>{downloadCountLabel(item, locale)}</p>
                          </div>
                        </div>
                        <div className="flex justify-end">{actionButton(item)}</div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}
        </CardContent>
      ) : null}
      <Dialog
        open={detailTarget !== null}
        onOpenChange={(open) => {
          if (!open) closeDetail();
        }}
      >
        <DialogContent className="max-h-[88vh] max-w-3xl overflow-hidden">
          <DialogHeader>
            <DialogTitle>
              {detailTarget ? `${marketKindLabel(detailTarget, locale)} ${copy("详情", "details")}: ${detailTarget.title}` : copy("市场条目详情", "Market item details")}
            </DialogTitle>
            <DialogDescription>
              {copy("市场条目需核对完整配置后加入能力货架；加入货架后，仍需在上方明确选择能力包才会强制下发。", "Review the complete configuration before adding an item to the capability shelf. Then select a capability pack above to deliver it.")}
            </DialogDescription>
          </DialogHeader>
          {detailLoading ? (
            <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
              {copy("正在读取完整详情…", "Loading full details…")}
            </div>
          ) : detailError ? (
            <div className="space-y-3 rounded-xl border border-dashed p-8 text-center">
              <p className="text-sm text-destructive">{detailError}</p>
              {detailTarget ? (
                <Button type="button" variant="outline" onClick={() => void openDetail(detailTarget)}>
                  {copy("重试", "Retry")}
                </Button>
              ) : null}
            </div>
          ) : detail ? (
            <ConfigMarketDetailBody detail={detail} />
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={closeDetail}>
              {copy("关闭", "Close")}
            </Button>
            {detail && onAddToShelf ? (
              <Button
                type="button"
                disabled={
                  detail.item.status !== "published" ||
                  shelfCapabilityIdSet.has(detail.item.capabilityId) ||
                  shelfBusy
                }
                title={
                  detail.item.status !== "published"
                    ? copy("请先恢复上架后再加入能力货架", "Relist this item before adding it to the shelf")
                    : shelfCapabilityIdSet.has(detail.item.capabilityId)
                      ? copy("该条目已经在能力货架中", "This item is already on the capability shelf")
                      : undefined
                }
                onClick={() => {
                  const selectedDetail = detail;
                  closeDetail();
                  onAddToShelf(selectedDetail);
                }}
              >
                {detail.item.status !== "published"
                  ? copy("下架条目不可加入", "Unlisted items cannot be added")
                  : shelfCapabilityIdSet.has(detail.item.capabilityId)
                    ? copy("已在能力货架", "Already on shelf")
                    : shelfBusy
                      ? copy("正在加入…", "Adding…")
                      : copy("核对并加入能力货架", "Review and add to shelf")}
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
