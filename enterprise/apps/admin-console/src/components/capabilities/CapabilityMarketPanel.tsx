"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocale } from "next-intl";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  Badge,
  Button,
  Card,
  CardContent,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  ScrollArea,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  toast,
} from "@agenticx/ui";
import {
  Bot,
  Boxes,
  Globe,
  GripVertical,
  Info,
  Puzzle,
  Search,
  Server,
  Store,
  UsersRound,
  X,
} from "lucide-react";

import { adminFetch } from "../../lib/admin-client-auth";
import type { CapabilityChoice } from "../../lib/capability-pack-form";
import { versionedCapabilityPackPatch } from "../../lib/capability-pack-concurrency";
import {
  filterCapabilityShelfChoices,
  orderedCapabilityIdsFromPayload,
  reconcileCapabilityShelfOrder,
  reorderCapabilityShelfOrder,
} from "../../lib/capability-shelf-order";
import { plainText } from "../../lib/plain-text";
import {
  configMarketDetailFromPayload,
  type ConfigMarketAction,
  type ConfigMarketItem,
  type ConfigMarketItemDetail,
} from "../../lib/config-market";
import { EnterpriseConfigMarketPanel } from "./EnterpriseConfigMarketPanel";
import {
  useCapabilityCatalog,
  type PackRecord,
  type SkillRecord,
} from "./use-capability-catalog";
import { MarketImportDialog, type MarketSource } from "./MarketImportDialog";

type KindFilter = "all" | "mcp" | "skill" | "feature" | "expert" | "group";

/**
 * 扫描结论的呈现。
 *
 * 只有真的存在结论时才显示。我们自己不扫——218 条正则拦不住想绕的人，而一个绿色的
 * 「扫描通过」会把「规则没匹配上」翻译成一句安全承诺，那个承诺兑现不了。装什么最终
 * 是管理员的决定，我们是软件提供商，不替他判断。
 *
 * 字段和写入接口留着：管理员如果用自己信任的工具扫过，可以把结论记进来，货架上就显示
 * 出来。没记就什么都不显示，而不是给每个技能挂一个「未扫描」。
 */
function scanBadge(verdict: string | null | undefined, findingCount: number, locale: string) {
  const copy = (zh: string, en: string) => (locale === "en" ? en : zh);
  switch (verdict) {
    case "safe":
      return { label: copy("扫描通过", "Scan passed"), variant: "outline" as const, tone: "text-emerald-600" };
    case "caution":
      return {
        label: findingCount > 0 ? `${copy("需警惕", "Review needed")} · ${findingCount}` : copy("需警惕", "Review needed"),
        variant: "outline" as const,
        tone: "text-amber-600",
      };
    case "dangerous":
      return {
        label: findingCount > 0 ? `${copy("高危", "High risk")} · ${findingCount}` : copy("高危", "High risk"),
        variant: "destructive" as const,
        tone: "",
      };
    default:
      return null;
  }
}

function kindTabs(locale: string): { id: KindFilter; label: string }[] {
  const copy = (zh: string, en: string) => (locale === "en" ? en : zh);
  return [
    { id: "all", label: copy("全部", "All") },
    { id: "mcp", label: copy("MCP 服务", "MCP services") },
    { id: "skill", label: "Skill" },
    { id: "feature", label: copy("平台功能", "Platform features") },
    { id: "expert", label: copy("数字专家", "Digital experts") },
    { id: "group", label: copy("项目群聊", "Project groups") },
  ];
}

/** 一项能力已经躺在哪些包里。卡片上要显示这个，否则管理员会重复往包里加。 */
function packsHolding(packs: readonly PackRecord[], capabilityId: string): PackRecord[] {
  return packs.filter((pack) => pack.capabilityIds.includes(capabilityId));
}

/** Market experts/groups are always shelf-managed; only a Skill resolved from
 * config-market carries shelfManaged=true. Legacy enterprise_skills remain ordinary inventory. */
function isMarketPortableChoice(choice: CapabilityChoice): boolean {
  return choice.kind === "expert" || choice.kind === "group" || choice.shelfManaged === true;
}

function SortableCapabilityCard({
  choice,
  skill,
  holders,
  selected,
  busy,
  sortingDisabled,
  marketDownloadCount,
  onToggle,
  onOpenDetail,
}: {
  choice: CapabilityChoice;
  skill: SkillRecord | undefined;
  holders: PackRecord[];
  selected: boolean;
  busy: boolean;
  sortingDisabled: boolean;
  marketDownloadCount?: number;
  onToggle: () => void;
  onOpenDetail?: () => void;
}) {
  const locale = useLocale();
  const copy = (zh: string, en: string) => (locale === "en" ? en : zh);
  const {
    attributes,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: choice.id, disabled: sortingDisabled });
  const holderNames = holders.map((pack) => pack.displayName || pack.slug);
  const primaryHolder = holders[0];
  const primaryHolderName = primaryHolder ? holderNames[0] : "";
  const hiddenHolderNames = holderNames.slice(1);
  const description = plainText(choice.description) || copy("（无说明）", "(No description)");
  const holdersLabel =
    holderNames.length > 0
      ? `${copy("已加入能力包", "Capability packs")}: ${holderNames.join(", ")}`
      : copy("尚未加入任何能力包", "Not in any capability pack");
  const isPortable = isMarketPortableChoice(choice);

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : 1,
        zIndex: isDragging ? 10 : undefined,
      }}
      className="min-w-0 h-full"
    >
      <Card
        role="group"
        aria-label={`${choice.displayName}${selected ? copy("，已选择", ", selected") : ""}`}
        className={`flex h-full flex-col transition-colors ${
          selected ? "border-primary bg-primary/5" : "hover:border-primary/50"
        } ${isDragging ? "shadow-lg ring-2 ring-primary/40" : ""}`}
      >
        <CardContent className="relative flex h-full p-4">
          <div className="flex h-full w-full items-start gap-2">
            <button
              ref={setActivatorNodeRef}
              type="button"
              className="mt-0.5 shrink-0 cursor-grab touch-none rounded-md p-1 text-muted-foreground/60 outline-none transition hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary active:cursor-grabbing disabled:cursor-not-allowed disabled:opacity-40"
              {...attributes}
              {...listeners}
              aria-label={`${copy("拖动排序", "Drag to reorder")}: ${choice.displayName}`}
              aria-roledescription={copy("可排序", "sortable")}
              disabled={sortingDisabled}
              onClick={(event) => event.stopPropagation()}
            >
              <GripVertical className="h-4 w-4" aria-hidden="true" />
            </button>
            <button
              type="button"
              className={`flex h-full min-w-0 flex-1 flex-col rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-primary/60 ${isPortable ? "pb-9" : ""}`}
              aria-pressed={isPortable ? undefined : selected}
              aria-busy={busy}
              aria-label={isPortable ? `${copy("查看能力详情", "View capability details")}: ${choice.displayName}` : undefined}
              onClick={isPortable ? onOpenDetail : onToggle}
            >
              <div className="flex h-full flex-col gap-2">
                <div className="flex items-start justify-between gap-2 pr-8">
                  <div className="flex min-w-0 items-center gap-2">
                    {choice.kind === "mcp" ? (
                      <Server className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    ) : choice.kind === "feature" ? (
                      <Globe className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    ) : choice.kind === "expert" ? (
                      <Bot className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    ) : choice.kind === "group" ? (
                      <UsersRound className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    ) : (
                      <Puzzle className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    )}
                    <span className="truncate font-medium">{choice.displayName}</span>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    {(() => {
                      if (choice.kind !== "skill") return null;
                      const scan = scanBadge(
                        skill?.scanVerdict,
                        skill?.scanFindings?.length ?? 0,
                        locale,
                      );
                      if (!scan) return null;
                      return (
                        <Badge
                          variant={scan.variant}
                          className={`font-normal ${scan.tone}`}
                          title={
                            skill?.scannedAt
                              ? `${copy("扫描于", "Scanned at")} ${new Date(skill.scannedAt).toLocaleString()}`
                              : undefined
                          }
                        >
                          {scan.label}
                        </Badge>
                      );
                    })()}
                    {choice.disabled ? <Badge variant="secondary">{copy("已停用", "Disabled")}</Badge> : null}
                  </div>
                </div>
                <div className="flex min-w-0 items-center justify-between gap-2">
                  <p className="min-w-0 truncate font-mono text-xs text-muted-foreground">{choice.name}</p>
                  {typeof marketDownloadCount === "number" ? (
                    <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">
                      {marketDownloadCount} {copy("次下载", "downloads")}
                    </span>
                  ) : null}
                </div>
                <span className="block h-[3.75rem] min-w-0 overflow-hidden text-sm leading-5 text-muted-foreground line-clamp-3">
                  {description}
                </span>
                <div
                  className="mt-auto flex min-h-6 min-w-0 items-center gap-1.5 overflow-hidden"
                  aria-label={holdersLabel}
                >
                  {primaryHolder ? (
                    <Badge
                      key={primaryHolder.id}
                      variant="outline"
                      className="min-w-0 max-w-[calc(100%_-_3rem)] shrink truncate font-normal"
                    >
                      {primaryHolderName}
                    </Badge>
                  ) : (
                    <span className="text-xs text-muted-foreground">{copy("尚未加入任何能力包", "Not in any capability pack")}</span>
                  )}
                  {hiddenHolderNames.length > 0 ? (
                    <Badge variant="outline" className="shrink-0 font-normal">
                      +{hiddenHolderNames.length}
                    </Badge>
                  ) : null}
                </div>
              </div>
            </button>
            <Popover>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className="absolute right-3 top-3 z-10 rounded-md p-1.5 text-muted-foreground outline-none transition hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/60"
                  aria-label={`${copy("查看完整信息", "View full information")}: ${choice.displayName}`}
                  title={copy("查看完整说明与能力包归属", "View full description and pack membership")}
                  onClick={(event) => event.stopPropagation()}
                >
                  <Info className="h-4 w-4" aria-hidden="true" />
                </button>
              </PopoverTrigger>
              <PopoverContent
                align="end"
                side="top"
                aria-label={`${copy("完整信息", "Full information")}: ${choice.displayName}`}
                className="max-h-[min(70vh,32rem)] w-96 max-w-[calc(100vw-2rem)] space-y-3 overflow-y-auto"
              >
                <div>
                  <p className="text-sm font-medium">{choice.displayName}</p>
                  <p className="mt-1 break-all font-mono text-xs text-muted-foreground">{choice.name}</p>
                </div>
                <div>
                  <p className="text-xs font-medium text-muted-foreground">{copy("完整说明", "Full description")}</p>
                  <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-6">{description}</p>
                </div>
                <div>
                  <p className="text-xs font-medium text-muted-foreground">{copy("能力包归属", "Capability packs")}</p>
                  <p className="mt-1 whitespace-pre-wrap break-words text-sm">
                    {holderNames.length > 0 ? holderNames.join(", ") : copy("尚未加入任何能力包", "Not in any capability pack")}
                  </p>
                </div>
              </PopoverContent>
            </Popover>
            {isPortable ? (
              <button
                type="button"
                className={`absolute bottom-3 right-3 z-10 rounded-md border px-2.5 py-1 text-xs font-medium outline-none transition focus-visible:ring-2 focus-visible:ring-primary/60 ${
                  selected
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border bg-background hover:border-primary/50 hover:bg-muted"
                }`}
                aria-pressed={selected}
                disabled={busy}
                onClick={(event) => {
                  event.stopPropagation();
                  onToggle();
                }}
              >
                {busy ? copy("读取中…", "Loading…") : selected ? copy("取消选择", "Deselect") : copy("选择下发", "Select for delivery")}
              </button>
            ) : null}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * 能力货架。
 *
 * 管理员挑东西时想的是「有哪些能力可以发下去」，不是「这条 MCP 记录的 bundleUri 填了
 * 什么」。注册表那三个面板是维护记录用的，这一页是按货架翻——搜索、按类型筛、卡片上
 * 直接看到它已经在哪些包里，勾一批直接加进某个包。
 *
 * 货架上的东西来自本企业自己的注册表，以及成员分享到企业内部市场并经管理员上架的
 * 专家/项目群聊/Skill。这是有意的：员工能装什么由管理员决定，不从公网目录直接取货。
 * 从 SkillHub 引进新技能是管理员的一次性动作，先进入市场管理，再经核对加入货架。
 */
export function CapabilityMarketPanel() {
  const locale = useLocale();
  const copy = (zh: string, en: string) => (locale === "en" ? en : zh);
  const {
    packs,
    skills,
    configMarketItems,
    choices,
    loading,
    ready: catalogReady,
    loadError: catalogLoadError,
    send,
    load: catalogReload,
  } = useCapabilityCatalog(copy("加载能力失败", "Failed to load capabilities"), copy("操作失败", "Operation failed"));
  const [kind, setKind] = useState<KindFilter>("all");
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [targetPackId, setTargetPackId] = useState("");
  const [saving, setSaving] = useState(false);
  const [marketBusyItemId, setMarketBusyItemId] = useState<string | null>(null);
  const [marketSource, setMarketSource] = useState<MarketSource | null>(null);
  const [reviewedPortableIds, setReviewedPortableIds] = useState<string[]>([]);
  const [reviewLoadingId, setReviewLoadingId] = useState<string | null>(null);
  const [reviewDetail, setReviewDetail] = useState<ConfigMarketItemDetail | null>(null);
  const [reviewIntent, setReviewIntent] = useState<"inspect" | "select">("inspect");
  const reviewRequestRef = useRef(0);
  const [shelfOrder, setShelfOrder] = useState<string[] | null>(null);
  const [shelfOrderLoading, setShelfOrderLoading] = useState(true);
  const [shelfOrderError, setShelfOrderError] = useState<string | null>(null);
  const [shelfReloadNonce, setShelfReloadNonce] = useState(0);
  const [shelfOrderSaving, setShelfOrderSaving] = useState(false);
  const shelfOrderSavingRef = useRef(false);

  useEffect(() => {
    const controller = new AbortController();

    const loadShelfOrder = async () => {
      setShelfOrderLoading(true);
      setShelfOrderError(null);
      try {
        const response = await adminFetch("/api/admin/capability-shelf-order", {
          cache: "no-store",
          signal: controller.signal,
        });
        const payload = (await response.json().catch(() => ({}))) as unknown;
        if (controller.signal.aborted) return;
        if (!response.ok) {
          const message =
            payload && typeof payload === "object" &&
            typeof (payload as { message?: unknown }).message === "string"
              ? (payload as { message: string }).message
              : `${copy("加载能力排序失败", "Failed to load shelf order")} (HTTP ${response.status})`;
          throw new Error(message);
        }
        const orderedCapabilityIds = orderedCapabilityIdsFromPayload(payload);
        if (!orderedCapabilityIds) throw new Error(copy("能力排序返回格式异常", "Invalid shelf order response"));
        setShelfOrder(orderedCapabilityIds);
      } catch (error) {
        if (controller.signal.aborted) return;
        const message = error instanceof Error ? error.message : copy("加载能力货架失败", "Failed to load capability shelf");
        setShelfOrder(null);
        setShelfOrderError(message);
        toast.error(`${message}; ${copy("为避免覆盖已有条目，货架编辑已锁定", "shelf editing is locked to avoid overwriting entries")}`);
      } finally {
        if (!controller.signal.aborted) setShelfOrderLoading(false);
      }
    };

    void loadShelfOrder();
    return () => controller.abort();
  }, [shelfReloadNonce]);

  const shelfReady =
    catalogReady &&
    shelfOrder !== null &&
    shelfOrderError === null &&
    !shelfOrderLoading;

  const skillById = useMemo(
    () => new Map(skills.map((skill) => [`skill:${skill.id.toUpperCase()}`, skill])),
    [skills],
  );

  const shelfChoices = useMemo(
    () => filterCapabilityShelfChoices(choices, shelfOrder),
    [choices, shelfOrder],
  );
  const catalogIds = useMemo(
    () => shelfChoices.map((choice) => choice.id),
    [shelfChoices],
  );
  const completeOrder = useMemo(
    () => reconcileCapabilityShelfOrder(catalogIds, shelfOrder ?? catalogIds),
    [catalogIds, shelfOrder],
  );
  const choicesById = useMemo(
    () => new Map(shelfChoices.map((choice) => [choice.id, choice])),
    [shelfChoices],
  );
  const orderedChoices = useMemo(
    () => completeOrder.map((id) => choicesById.get(id)).filter(Boolean) as CapabilityChoice[],
    [choicesById, completeOrder],
  );
  const visible = useMemo(() => {
    const q = query.trim().toLocaleLowerCase();
    return orderedChoices.filter((choice) => {
      if (kind !== "all" && choice.kind !== kind) return false;
      if (!q) return true;
      return [choice.displayName, choice.name, plainText(choice.description)]
        .filter(Boolean)
        .join(" ")
        .toLocaleLowerCase()
        .includes(q);
    });
  }, [kind, orderedChoices, query]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const shelfAnnouncements = useMemo<Announcements>(() => {
    const labelFor = (id: unknown) => choicesById.get(String(id))?.displayName || String(id);
    return {
      onDragStart({ active }) {
        return `${copy("已抓取", "Picked up")} “${labelFor(active.id)}”. ${copy("使用方向键移动，再按空格放下，按 Esc 取消。", "Use arrow keys to move, Space to drop, or Esc to cancel.")}`;
      },
      onDragOver({ active, over }) {
        return over
          ? `“${labelFor(active.id)}” ${copy("移动到", "moved near")} “${labelFor(over.id)}”.`
          : `“${labelFor(active.id)}” ${copy("已离开能力货架。", "left the capability shelf.")}`;
      },
      onDragEnd({ active, over }) {
        return over
          ? `${copy("已将", "Placed")} “${labelFor(active.id)}” ${copy("放到", "near")} “${labelFor(over.id)}”.`
          : `${copy("已放下", "Dropped")} “${labelFor(active.id)}”.`;
      },
      onDragCancel({ active }) {
        return `${copy("已取消", "Cancelled")} “${labelFor(active.id)}” ${copy("的排序。", "reordering.")}`;
      },
    };
  }, [choicesById]);

  const handleDragEnd = useCallback(
    async ({ active, over }: DragEndEvent) => {
      if (
        !over ||
        active.id === over.id ||
        !shelfReady ||
        shelfOrderSavingRef.current
      ) {
        return;
      }
      const activeId = String(active.id);
      const overId = String(over.id);
      const previousOrder = completeOrder;
      const nextOrder = reorderCapabilityShelfOrder(
        previousOrder,
        visible.map((choice) => choice.id),
        activeId,
        overId,
      );
      if (nextOrder.every((id, index) => id === previousOrder[index])) return;

      shelfOrderSavingRef.current = true;
      setShelfOrder(nextOrder);
      setShelfOrderSaving(true);
      try {
        const response = await adminFetch("/api/admin/capability-shelf-order", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ capabilityIds: nextOrder }),
        });
        const payload = (await response.json().catch(() => ({}))) as unknown;
        if (!response.ok) {
          const message =
            payload && typeof payload === "object" &&
            typeof (payload as { message?: unknown }).message === "string"
              ? (payload as { message: string }).message
              : `${copy("保存能力排序失败", "Failed to save shelf order")} (HTTP ${response.status})`;
          throw new Error(message);
        }
        toast.success(copy("能力货架顺序已保存", "Capability shelf order saved"));
      } catch (error) {
        setShelfOrder(previousOrder);
        toast.error(error instanceof Error ? error.message : copy("保存能力排序失败，已恢复原顺序", "Failed to save shelf order; restored previous order"));
      } finally {
        shelfOrderSavingRef.current = false;
        setShelfOrderSaving(false);
      }
    },
    [completeOrder, shelfReady, visible],
  );

  const addConfigToShelf = useCallback(
    async (detail: ConfigMarketItemDetail) => {
      const capabilityId = detail.item.capabilityId;
      if (completeOrder.includes(capabilityId)) {
        toast.info(`${copy("已经在能力货架中", "is already on the capability shelf")}: ${detail.item.title}`);
        return;
      }
      if (!shelfReady || shelfOrderSavingRef.current) {
        toast.info(copy("能力货架尚未完整加载，暂时不能修改", "The capability shelf is still loading; editing is temporarily disabled"));
        return;
      }

      shelfOrderSavingRef.current = true;
      setShelfOrderSaving(true);
      try {
        const response = await adminFetch("/api/admin/capability-shelf-order", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ capabilityId }),
        });
        const payload = (await response.json().catch(() => ({}))) as unknown;
        const orderedCapabilityIds = orderedCapabilityIdsFromPayload(payload);
        if (!response.ok || !orderedCapabilityIds) {
          const message =
            payload && typeof payload === "object" &&
            typeof (payload as { message?: unknown }).message === "string"
              ? (payload as { message: string }).message
              : `${copy("加入能力货架失败", "Failed to add to capability shelf")} (HTTP ${response.status})`;
          throw new Error(message);
        }
        setShelfOrder(orderedCapabilityIds);
        toast.success(`${copy("已将", "Added")} ${detail.item.title} ${copy("加入能力货架", "to the capability shelf")}`);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : copy("加入能力货架失败", "Failed to add to capability shelf"));
      } finally {
        shelfOrderSavingRef.current = false;
        setShelfOrderSaving(false);
      }
    },
    [completeOrder, shelfReady],
  );

  const toggle = useCallback((id: string) => {
    setPicked((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    );
  }, []);

  const openPortableDetail = useCallback(
    async (choice: CapabilityChoice, intent: "inspect" | "select") => {
      const marketItem = configMarketItems.find(
        (item) =>
          item.capabilityId === choice.id &&
          (item.status === "published" || item.status === "unlisted"),
      );
      if (!marketItem) {
        toast.error(copy("该条目已不在企业市场中，请刷新后重试", "This item is no longer in the enterprise market. Refresh and try again."));
        return;
      }
      const requestId = reviewRequestRef.current + 1;
      reviewRequestRef.current = requestId;
      setReviewLoadingId(choice.id);
      try {
        const response = await adminFetch(
          `/api/admin/config-market/${encodeURIComponent(marketItem.id)}`,
          { cache: "no-store" },
        );
        const payload = (await response.json().catch(() => ({}))) as unknown;
        if (reviewRequestRef.current !== requestId) return;
        const detail = configMarketDetailFromPayload(payload);
        if (
          !response.ok ||
          !detail ||
          detail.item.capabilityId !== choice.id ||
          (detail.item.status !== "published" && detail.item.status !== "unlisted")
        ) {
          throw new Error(
            response.ok ? copy("条目行为指令格式异常，已阻止继续操作", "The item instructions are invalid; the operation was blocked") : copy("读取行为指令失败", "Failed to read item instructions"),
          );
        }
        setReviewIntent(intent);
        setReviewDetail(detail);
      } catch (error) {
        if (reviewRequestRef.current !== requestId) return;
        toast.error(error instanceof Error ? error.message : copy("读取行为指令失败", "Failed to read item instructions"));
      } finally {
        if (reviewRequestRef.current === requestId) setReviewLoadingId(null);
      }
    },
    [configMarketItems],
  );

  const requestToggle = useCallback(
    async (choice: CapabilityChoice) => {
      if (picked.includes(choice.id)) {
        setPicked((current) => current.filter((id) => id !== choice.id));
        setReviewedPortableIds((current) => current.filter((id) => id !== choice.id));
        return;
      }
      if (!shelfReady) {
        toast.info(copy("能力货架尚未完整加载，暂时不能选择下发", "The capability shelf is still loading; delivery selection is temporarily disabled"));
        return;
      }
      if (choice.disabled && isMarketPortableChoice(choice)) {
        const marketItem = configMarketItems.find((item) => item.capabilityId === choice.id);
        if (marketItem?.deliveryState === "revoked") {
          toast.error(copy("该市场条目已紧急撤回下发，恢复前不能加入新的能力包", "This market item has been withdrawn; restore delivery before adding it to a pack"));
        } else {
          toast.error(copy("该市场条目已下架，恢复上架前不能加入新的能力包", "This market item is unlisted; relist it before adding it to a pack"));
        }
        return;
      }
      if (!isMarketPortableChoice(choice)) {
        toggle(choice.id);
        return;
      }
      await openPortableDetail(choice, "select");
    },
    [configMarketItems, openPortableDetail, picked, shelfReady, toggle],
  );

  const confirmPortableReview = useCallback(() => {
    if (!reviewDetail) return;
    if (!shelfReady) {
      toast.info(copy("能力货架尚未完整加载，暂时不能选择下发", "The capability shelf is still loading; delivery selection is temporarily disabled"));
      return;
    }
    if (reviewDetail.item.status !== "published") {
      toast.error(copy("该市场条目已下架，恢复上架前不能加入新的能力包", "This market item is unlisted; relist it before adding it to a pack"));
      setReviewDetail(null);
      return;
    }
    if (reviewDetail.item.deliveryState === "revoked") {
      toast.error(copy("该市场条目已紧急撤回下发，恢复前不能加入新的能力包", "This market item has been withdrawn; restore delivery before adding it to a pack"));
      setReviewDetail(null);
      return;
    }
    const capabilityId = reviewDetail.item.capabilityId;
    setReviewedPortableIds((current) =>
      current.includes(capabilityId) ? current : [...current, capabilityId],
    );
    setPicked((current) => (current.includes(capabilityId) ? current : [...current, capabilityId]));
    setReviewDetail(null);
  }, [reviewDetail, shelfReady]);

  const addToPack = useCallback(async () => {
    if (!shelfReady) {
      toast.info(copy("能力货架尚未完整加载，暂时不能修改能力包", "The capability shelf is still loading; capability packs cannot be edited yet"));
      return;
    }
    const pack = packs.find((item) => item.id === targetPackId);
    if (!pack) return;
    const unreviewedPortable = picked.filter((id) => {
      const choice = choices.find((candidate) => candidate.id === id);
      return Boolean(choice && isMarketPortableChoice(choice) && !reviewedPortableIds.includes(id));
    });
    if (unreviewedPortable.length > 0) {
      toast.error(copy("请先逐项核对市场专家、项目群聊或 Skill 的完整详情", "Review each market expert, project group, or Skill before adding it"));
      return;
    }
    setSaving(true);
    try {
      // 整集写回，且基于当下这份 pack.capabilityIds 求并集——只发新增的话，
      // 接口那边是整体替换语义，会把包里原有的成员抹掉。
      const merged = [...new Set([...pack.capabilityIds, ...picked])];
      const added = merged.length - pack.capabilityIds.length;
      if (added === 0) {
        toast.info(copy("选中的能力都已经在这个包里了", "All selected capabilities are already in this pack"));
        return;
      }
      const ok = await send(
        `/api/admin/capability-packs/${encodeURIComponent(pack.id)}`,
        "PATCH",
        versionedCapabilityPackPatch(pack.updatedAt, { capabilityIds: merged }),
      );
      if (ok) {
        toast.success(`${copy("已向", "Added")} ${added} ${copy("项能力到", "capabilities to")} ${pack.displayName || pack.slug}`);
        setPicked([]);
        setReviewedPortableIds([]);
      }
    } finally {
      setSaving(false);
    }
  }, [choices, packs, picked, reviewedPortableIds, send, shelfReady, targetPackId]);

  const updateConfigMarketItem = useCallback(
    async (item: ConfigMarketItem, action: ConfigMarketAction) => {
      if (action === "revoke_delivery") {
        const affectedPacks = packsHolding(packs, item.capabilityId);
        if (
          affectedPacks.length > 0 &&
          !confirm(
            `${copy("紧急撤回会立即停止以下能力包对该条目的托管下发", "Emergency withdrawal will stop managed delivery to this item from these packs")}: ${affectedPacks
              .map((pack) => pack.displayName || pack.slug)
              .join(", ")}. ${copy("市场上架状态不会改变，是否继续？", "The market listing will not change. Continue?")}`,
          )
        ) {
          return;
        }
      }
      setMarketBusyItemId(item.id);
      try {
        const ok = await send(
          `/api/admin/config-market/${encodeURIComponent(item.id)}`,
          "PATCH",
          { action },
        );
        if (ok) {
          toast.success(
            action === "unlist"
              ? `${copy("已下架", "Unlisted")} “${item.title}”; ${copy("现有能力包下发不受影响", "existing pack delivery is unaffected")}`
              : action === "restore"
                ? `${copy("已恢复", "Relisted")} “${item.title}”`
                : action === "revoke_delivery"
                  ? `${copy("已紧急撤回", "Emergency withdrawal completed for")} “${item.title}”`
                  : `${copy("已恢复", "Delivery restored for")} “${item.title}”`,
          );
          // 下架后它不再是可选能力，清掉底部尚未提交的临时勾选。
          if (action === "unlist" || action === "revoke_delivery") {
            setPicked((current) => current.filter((id) => id !== item.capabilityId));
            setReviewedPortableIds((current) =>
              current.filter((id) => id !== item.capabilityId),
            );
          }
        }
      } finally {
        setMarketBusyItemId(null);
      }
    },
    [packs, send, copy],
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-lg border p-0.5">
          {kindTabs(locale).map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={`rounded-md px-3 py-1.5 text-sm transition ${
                kind === tab.id ? "bg-muted font-medium" : "text-muted-foreground hover:bg-muted/60"
              }`}
              onClick={() => setKind(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <Button variant="outline" size="sm" onClick={() => setMarketSource("skill")}>
          <Store className="h-4 w-4" />
          {copy("从 SkillHub 添加", "Add from SkillHub")}
        </Button>
        <Button variant="outline" size="sm" onClick={() => setMarketSource("mcp")}>
          <Store className="h-4 w-4" />
          {copy("浏览 MCP 市场", "Browse MCP market")}
        </Button>
        <div className="relative min-w-56 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={copy("搜索能力名称或说明", "Search capability name or description")}
            aria-label={copy("搜索能力", "Search capabilities")}
            className="pl-9"
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <p role="status" aria-live="polite">
          {catalogLoadError || shelfOrderError
            ? copy("能力货架未完整加载。为避免覆盖已有专家或群聊，排序、加入货架与下发选择已锁定。", "The capability shelf is incomplete. Reordering, adding, and delivery selection are locked to avoid overwriting experts or groups.")
            : shelfOrderLoading || !catalogReady
              ? copy("正在加载完整能力货架…", "Loading the complete capability shelf…")
              : shelfOrderSaving
                ? copy("正在保存能力货架顺序，暂时无法继续拖动。", "Saving shelf order; dragging is temporarily disabled.")
                : copy("拖动卡片左侧的抓手可调整能力货架顺序。筛选时只调整当前可见能力。", "Drag the handle on the left of a card to reorder the shelf. Filtering only reorders visible items.")}
        </p>
        {catalogLoadError || shelfOrderError ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              void catalogReload();
              setShelfReloadNonce((value) => value + 1);
            }}
          >
            {copy("重新加载", "Reload")}
          </Button>
        ) : null}
      </div>

      {loading && !catalogReady ? (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2, 3, 4, 5].map((key) => (
            <Card key={key}>
              <CardContent className="space-y-2 p-4">
                <Skeleton className="h-5 w-36" />
                <Skeleton className="h-4 w-48" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : visible.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="p-8 text-center text-sm text-muted-foreground">
            {choices.length === 0
              ? copy("货架是空的。点上面的「从 SkillHub 添加」挑技能，或在「MCP 托管」里登记服务。", "The shelf is empty. Add a Skill from SkillHub or register a service in MCP hosting.")
              : copy("没有匹配的能力。", "No matching capabilities.")}
          </CardContent>
        </Card>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={(event) => void handleDragEnd(event)}
          accessibility={{
            announcements: shelfAnnouncements,
            screenReaderInstructions: {
              draggable:
                copy("按空格开始拖动能力；使用方向键调整顺序；再次按空格放下；按 Esc 取消。", "Press Space to drag, use arrow keys to reorder, press Space to drop, or Esc to cancel."),
            },
          }}
        >
          <SortableContext
            items={visible.map((choice) => choice.id)}
            strategy={rectSortingStrategy}
          >
            <div className="grid items-stretch gap-3 md:grid-cols-2 xl:grid-cols-3">
              {visible.map((choice) => (
                <SortableCapabilityCard
                  key={choice.id}
                  choice={choice}
                  skill={skillById.get(choice.id)}
                  holders={packsHolding(packs, choice.id)}
                  selected={picked.includes(choice.id)}
                  busy={reviewLoadingId === choice.id}
                  sortingDisabled={!shelfReady || shelfOrderSaving}
                  marketDownloadCount={configMarketItems.find((item) => item.capabilityId === choice.id)?.downloadCount}
                  onToggle={() => {
                    if (reviewLoadingId !== choice.id) void requestToggle(choice);
                  }}
                  onOpenDetail={
                    isMarketPortableChoice(choice)
                      ? () => {
                          if (reviewLoadingId !== choice.id) {
                            void openPortableDetail(choice, "inspect");
                          }
                        }
                      : undefined
                  }
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}

      {picked.length > 0 ? (
        <div className="sticky bottom-4 z-20 flex flex-wrap items-center gap-2 rounded-xl border bg-card/95 p-3 shadow-lg backdrop-blur">
          <Boxes className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">{copy("已选", "Selected")} {picked.length}</span>
          <Select value={targetPackId} onValueChange={setTargetPackId}>
            <SelectTrigger className="h-8 w-52">
              <SelectValue placeholder={copy("加入哪个能力包", "Add to capability pack")} />
            </SelectTrigger>
            <SelectContent>
              {packs.map((pack) => (
                <SelectItem key={pack.id} value={pack.id}>
                  {pack.displayName || pack.slug}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size="sm"
            disabled={!shelfReady || !targetPackId || saving}
            onClick={() => void addToPack()}
          >
            {copy("加入", "Add")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto"
            onClick={() => {
              setPicked([]);
              setReviewedPortableIds([]);
            }}
          >
            <X className="h-4 w-4" />
            {copy("取消选择", "Clear selection")}
          </Button>
        </div>
      ) : null}

      <EnterpriseConfigMarketPanel
        items={configMarketItems}
        loading={loading}
        busyItemId={marketBusyItemId}
        onReload={() => void catalogReload()}
        onAction={(item, action) => void updateConfigMarketItem(item, action)}
        shelfCapabilityIds={completeOrder}
        shelfBusy={!shelfReady || shelfOrderSaving}
        onAddToShelf={(detail) => void addConfigToShelf(detail)}
      />

      <MarketImportDialog
        source={marketSource ?? "skill"}
        open={marketSource !== null}
        onOpenChange={(open) => setMarketSource(open ? marketSource : null)}
        onImported={() => {
          setMarketSource(null);
          void catalogReload();
        }}
      />

      <Dialog
        open={reviewDetail !== null}
        onOpenChange={(open) => !open && setReviewDetail(null)}
      >
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>
              {reviewIntent === "inspect" ? copy("能力详情", "Capability details") : copy("核对完整行为指令", "Review complete instructions")}:
              {reviewDetail?.item.title ?? ""}
            </DialogTitle>
            <DialogDescription>
              {reviewIntent === "inspect"
                ? copy("查看该能力的角色指令、运行权限、依赖与随包资源；普通查看不会触发下发。", "Review this capability's instructions, runtime permissions, dependencies, and bundled resources. Viewing does not deliver it.")
                : copy("以下内容由企业成员上传，属于不可信配置。确认它符合公司要求后，才能选择加入能力包并下发。", "This content was uploaded by an employee and is untrusted. Confirm it meets company requirements before adding it to a pack for delivery.")}
            </DialogDescription>
          </DialogHeader>
          <ScrollArea className="max-h-[60vh] pr-4">
            {reviewDetail?.promptPreview.kind === "skill" ? (
              <div className="space-y-3">
                <div>
                  <div className="text-sm font-medium">{reviewDetail.promptPreview.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {reviewDetail.promptPreview.description || copy("（未设置说明）", "(No description)")}
                  </div>
                </div>
                <div>
                  <div className="mb-1 text-xs font-medium text-muted-foreground">SKILL.md</div>
                  <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg border bg-muted/40 p-3 font-mono text-xs">
                    {reviewDetail.promptPreview.skillMd || copy("（空文件）", "(Empty file)")}
                  </pre>
                </div>
                <div className="rounded-lg border p-3 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">{copy("结构检查", "Structure check")}</span>
                    <Badge variant={reviewDetail.promptPreview.checkResult.status === "passed" ? "default" : "destructive"}>
                      {reviewDetail.promptPreview.checkResult.status === "passed" ? copy("通过", "Passed") : copy("需处理", "Needs attention")}
                    </Badge>
                  </div>
                  <p className="mt-2 text-muted-foreground">
                    front matter · name: {reviewDetail.promptPreview.checkResult.frontMatter.name || copy("缺失", "missing")} · description: {reviewDetail.promptPreview.checkResult.frontMatter.description ? copy("已填写", "provided") : copy("缺失", "missing")}
                  </p>
                  {reviewDetail.promptPreview.checkResult.findings.length > 0 ? (
                    <ul className="mt-2 list-disc space-y-1 pl-4 text-destructive">
                      {reviewDetail.promptPreview.checkResult.findings.map((finding) => <li key={finding}>{finding}</li>)}
                    </ul>
                  ) : null}
                </div>
              </div>
            ) : reviewDetail?.promptPreview.kind === "expert" ? (
              <div className="space-y-3">
                <div>
                  <div className="text-sm font-medium">{reviewDetail.promptPreview.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {reviewDetail.promptPreview.role || copy("（未设置角色）", "(No role)")}
                  </div>
                </div>
                <div>
                  <div className="mb-1 text-xs font-medium text-muted-foreground">{copy("系统提示词", "System prompt")}</div>
                  <pre className="whitespace-pre-wrap break-words rounded-lg border bg-muted/40 p-3 font-mono text-xs">
                    {reviewDetail.promptPreview.systemPrompt || copy("（空提示词）", "(Empty prompt)")}
                  </pre>
                </div>
              </div>
            ) : reviewDetail?.promptPreview.kind === "group" ? (
              <div className="space-y-4">
                {reviewDetail.promptPreview.members.map((member, index) => (
                  <div key={`${member.name}-${index}`} className="space-y-2 rounded-lg border p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">{member.name}</span>
                      {index ===
                      (reviewDetail.promptPreview.kind === "group"
                        ? reviewDetail.promptPreview.hostMemberIndex
                        : -1) ? (
                        <Badge variant="secondary">{copy("主持专家", "Host expert")}</Badge>
                      ) : null}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {member.role || copy("（未设置角色）", "(No role)")}
                    </div>
                    <pre className="whitespace-pre-wrap break-words rounded-lg bg-muted/40 p-3 font-mono text-xs">
                      {member.systemPrompt || copy("（空提示词）", "(Empty prompt)")}
                    </pre>
                  </div>
                ))}
              </div>
            ) : null}
            {reviewDetail ? (
              <div className="mt-5 space-y-4 border-t pt-4">
                <div>
                  <div className="mb-1 text-xs font-medium text-muted-foreground">{copy("建议运行权限", "Recommended runtime permission")}</div>
                  <Badge variant="outline">{reviewDetail.runtimeReview.recommendedPermissionMode}</Badge>
                </div>
                <div>
                  <div className="mb-2 text-xs font-medium text-muted-foreground">{copy("各专家默认运行权限", "Default permission per expert")}</div>
                  <div className="space-y-2">
                    {reviewDetail.runtimeReview.expertPermissions.map((expert, index) => (
                      <div key={`${expert.name}-${index}`} className="flex items-center justify-between rounded-lg border px-3 py-2 text-xs">
                        <span>{expert.name}</span>
                        <Badge variant="outline">{expert.defaultPermissionMode}</Badge>
                      </div>
                    ))}
                  </div>
                </div>
                <div>
                  <div className="mb-2 text-xs font-medium text-muted-foreground">{copy("必需 Skill / MCP", "Required Skill / MCP")}</div>
                  <div className="space-y-2">
                    {reviewDetail.runtimeReview.dependencies.filter((dependency) => dependency.required).length > 0
                      ? reviewDetail.runtimeReview.dependencies
                          .filter((dependency) => dependency.required)
                          .map((dependency) => (
                            <div key={dependency.capabilityId} className="rounded-lg border p-3 text-xs">
                              <div className="font-mono font-medium">{dependency.capabilityId}</div>
                              <div className="mt-1 text-muted-foreground">
                                {dependency.kind === "mcp"
                                  ? `${copy("声明版本", "Declared version")} ${dependency.version} · ${copy("下发按注册版本精确复核", "delivery is verified against the registered version")}`
                                  : `${copy("版本", "Version")} ${dependency.version} · ${copy("摘要", "digest")} ${dependency.digest}`}
                              </div>
                            </div>
                          ))
                      : <div className="text-xs text-muted-foreground">{copy("无必需 Skill / MCP", "No required Skill / MCP")}</div>}
                  </div>
                </div>
                <div>
                  <div className="mb-2 text-xs font-medium text-muted-foreground">{copy("随包 Markdown 资源", "Bundled Markdown resources")}</div>
                  <div className="space-y-3">
                    {reviewDetail.runtimeReview.resources.length > 0
                      ? reviewDetail.runtimeReview.resources.map((resource) => (
                          <div key={resource.path} className="space-y-1 rounded-lg border p-3">
                            <div className="font-mono text-xs font-medium">{resource.path}</div>
                            <pre className="whitespace-pre-wrap break-words rounded bg-muted/40 p-3 font-mono text-xs">
                              {resource.content}
                            </pre>
                          </div>
                        ))
                      : <div className="text-xs text-muted-foreground">{copy("未附带 Markdown 资源", "No Markdown resources attached")}</div>}
                  </div>
                </div>
              </div>
            ) : null}
          </ScrollArea>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReviewDetail(null)}>
              {reviewIntent === "inspect" ? copy("关闭", "Close") : copy("取消", "Cancel")}
            </Button>
            {reviewIntent === "select" ? (
              <Button onClick={confirmPortableReview}>{copy("我已核对，选择下发", "Reviewed; select for delivery")}</Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>

    </div>
  );
}
