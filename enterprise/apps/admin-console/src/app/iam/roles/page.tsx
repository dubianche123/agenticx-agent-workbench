"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocale } from "next-intl";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  PageHeader,
  Sheet,
  SheetContent,
  SheetTitle,
  Skeleton,
  toast,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@agenticx/ui";
import {
  LayoutGrid,
  List,
  Pencil,
  Plus,
  RefreshCw,
  Upload,
  Search,
  UsersRound,
} from "lucide-react";
import { adminFetch } from "../../../lib/admin-client-auth";
import { CreateUserDialog } from "../../../components/CreateUserDialog";
import { QuotaRing, formatTokenCount } from "../../../components/QuotaRing";
import {
  UserDetailEditor,
  type UserDetailOverview,
} from "../../../components/UserDetailEditor";
import {
  ALL_DEPARTMENTS,
  DepartmentFilterTree,
  NO_DEPARTMENT,
  departmentSubtreeIds,
  type DepartmentFilter,
  type OrganizationNode,
} from "../../../components/DepartmentFilterTree";
import { VisibleModelsEditor } from "../../../components/visible-models-editor";
import { BudgetScopeEditor } from "../../../components/metering/BudgetScopeEditor";
import { BulkImportWizard } from "../../../components/BulkImportWizard";
import { MemberBatchBar } from "../../../components/MemberBatchBar";
import {
  MEMBER_DRAG_MIME,
  dragPayloadIds,
  moveResultText,
  planMove,
} from "../../../lib/member-move";
import { UserGroupsPanel } from "../../../components/iam/UserGroupsPanel";
import { AgentsPanel } from "../../../components/iam/AgentsPanel";
import { RolesPanel } from "../../../components/iam/RolesPanel";
import { DefaultMemberBudgetCard } from "../../../components/DefaultMemberBudgetCard";

type GrantSource = "personal" | "group" | "department" | "all";
type GrantOrigin = { source?: GrantSource; sourceLabel?: string };
type UserModelSummary = {
  model: string;
  tokens: number;
  currentlyAllowed: boolean;
} & GrantOrigin;
type UserPackSummary = { id: string; name: string } & GrantOrigin;
type UserFeatureSummary = { enabled: boolean } & GrantOrigin;
// Omit 掉 models：UserDetailEditor 里另有一个不带来源的同名类型，直接交叉会打架。
type UserQuotaOverview = Omit<UserDetailOverview, "models"> & {
  models: UserModelSummary[];
  packs?: UserPackSummary[];
  features?: { webSearch: UserFeatureSummary; deepResearch: UserFeatureSummary };
};
type ApiEnvelope<T> = { code: string; message: string; data?: T };
type OrganizationSettingsTarget =
  | { kind: "organization" }
  | { kind: "department"; node: OrganizationNode };

/**
 * 来源短标。卡片的意义就在这一句：同样是「能用 Claude」，继承来的和单独特批的，
 * 管理员要做的事完全不同——前者改组就动了一片人，后者只动他一个。
 */
function grantSourceText(origin: GrantOrigin, locale = "zh"): string {
  const copy = (zh: string, en: string) => (locale === "en" ? en : zh);
  switch (origin.source) {
    case "personal":
      return copy("特批", "Personal override");
    case "group":
      return origin.sourceLabel ? `${copy("继承自", "Inherited from")} ${origin.sourceLabel}` : copy("继承自用户组", "Inherited from user group");
    case "department":
      return origin.sourceLabel ? `${copy("继承自", "Inherited from")} ${origin.sourceLabel}` : copy("部门继承", "Inherited from department");
    case "all":
      return copy("全员", "Everyone");
    default:
      return "";
  }
}

function quotaSourceLabel(user: UserQuotaOverview, locale = "zh"): string {
  const copy = (zh: string, en: string) => (locale === "en" ? en : zh);
  if (user.quotaSource === "group") return user.quotaSourceLabel ? `${copy("继承自", "Inherited from")} ${user.quotaSourceLabel}` : copy("继承自用户组", "Inherited from user group");
  if (user.quotaSource === "personal") return copy("个人设置", "Personal settings");
  return copy("默认设置", "Default settings");
}

function modelQuotaStateClass(
  user: Pick<UserQuotaOverview, "usedTokens" | "monthlyTokens" | "unlimited">,
  model: UserModelSummary,
): string {
  if (!model.currentlyAllowed) return "border-border bg-muted/30 text-muted-foreground";
  if (user.unlimited || user.monthlyTokens <= 0) return "border-border bg-background text-foreground";
  const ratio = user.usedTokens / user.monthlyTokens;
  if (ratio >= 1) return "border-destructive/50 bg-destructive/10 text-destructive";
  if (ratio >= 0.8) return "border-amber-400/70 bg-amber-300/30 text-amber-950 dark:border-amber-300/50 dark:bg-amber-400/20 dark:text-amber-100";
  return "border-border bg-background text-foreground";
}

function userStatusMeta(status: UserQuotaOverview["status"], locale = "zh") {
  const copy = (zh: string, en: string) => (locale === "en" ? en : zh);
  if (status === "active") return { label: copy("启用", "Active"), variant: "success" as const };
  if (status === "locked") return { label: copy("锁定", "Locked"), variant: "destructive" as const };
  return { label: copy("停用", "Disabled"), variant: "warning" as const };
}

function MembersPanel() {
  const locale = useLocale();
  const copy = (zh: string, en: string) => (locale === "en" ? en : zh);
  const searchParams = useSearchParams();
  const requestedDeptId = searchParams.get("dept")?.trim() ?? "";
  const createRequested = searchParams.get("create") === "1";
  const [items, setItems] = useState<UserQuotaOverview[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<UserQuotaOverview | null>(null);
  const [createOpen, setCreateOpen] = useState(createRequested);
  const [viewMode, setViewMode] = useState<"cards" | "list">("cards");
  const [viewModeHydrated, setViewModeHydrated] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [organization, setOrganization] = useState<OrganizationNode[]>([]);
  // ?dept= 是从别的页面跳过来时带的定位参数，作为初值；之后由左栏树接管。
  const [deptFilter, setDeptFilter] = useState<DepartmentFilter>(
    requestedDeptId || ALL_DEPARTMENTS,
  );
  const [ceilingTarget, setCeilingTarget] = useState<OrganizationSettingsTarget | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [defaultQuotaOpen, setDefaultQuotaOpen] = useState(false);
  const [checkedIds, setCheckedIds] = useState<string[]>([]);
  const openedFromQueryRef = useRef<string | null>(null);

  useEffect(() => {
    const savedViewMode = window.localStorage.getItem("admin-iam-user-view-mode");
    if (savedViewMode === "cards" || savedViewMode === "list") setViewMode(savedViewMode);
    setViewModeHydrated(true);
  }, []);

  useEffect(() => {
    if (viewModeHydrated) window.localStorage.setItem("admin-iam-user-view-mode", viewMode);
  }, [viewMode, viewModeHydrated]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await adminFetch("/api/admin/users/quota-overview", { cache: "no-store" });
      const json = (await response.json()) as ApiEnvelope<{
        items: UserQuotaOverview[];
        organization: OrganizationNode[];
      }>;
      if (!response.ok || json.code !== "00000") throw new Error(json.message || copy("加载用户失败", "Failed to load users"));
      setItems(json.data?.items ?? []);
      setOrganization(json.data?.organization ?? []);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : copy("加载用户失败", "Failed to load users"));
    } finally {
      setLoading(false);
    }
  }, []);

  const openEditor = useCallback((user: UserQuotaOverview) => {
    setSelected(user);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const userId = searchParams.get("user");
    if (!userId || loading || openedFromQueryRef.current === userId) return;
    const user = items.find((item) => item.id === userId);
    if (!user) return;
    openedFromQueryRef.current = userId;
    openEditor(user);
  }, [items, loading, openEditor, searchParams]);

  useEffect(() => {
    if (createRequested) setCreateOpen(true);
  }, [createRequested]);

  // 选中一个部门时子部门的人也算进来：点「研发中心」要看的是整棵子树。
  const deptScope = useMemo(
    () =>
      deptFilter === ALL_DEPARTMENTS || deptFilter === NO_DEPARTMENT
        ? null
        : departmentSubtreeIds(organization, deptFilter),
    [organization, deptFilter],
  );

  const visibleItems = useMemo(() => {
    const query = searchQuery.trim().toLocaleLowerCase();
    return items.filter((user) => {
      if (deptFilter === NO_DEPARTMENT && user.deptId) return false;
      if (deptScope && !(user.deptId && deptScope.has(user.deptId))) return false;
      if (!query) return true;
      return [
          user.displayName,
          user.email,
          user.departmentName,
          user.departmentPath,
          user.jobTitle,
          user.employeeNo,
          user.phone,
          ...user.groupNames,
        ]
          .filter(Boolean)
          .join(" ")
          .toLocaleLowerCase()
          .includes(query);
    });
  }, [items, deptFilter, deptScope, searchQuery]);

  const selectedIds = useMemo(() => {
    // 换了筛选之后，之前勾的人可能已经不在列表里。批量操作只该作用于看得见的那些，
    // 否则「已选 8 人」里混着屏幕上根本没有的人。
    const visible = new Set(visibleItems.map((user) => user.id));
    return checkedIds.filter((id) => visible.has(id));
  }, [checkedIds, visibleItems]);

  // 拖放和批量条共用这一份待确认的移动请求：两个入口，一个确认框。
  const [moveRequest, setMoveRequest] = useState<{ deptId: string | null; userIds: string[] } | null>(null);
  const [movingMembers, setMovingMembers] = useState(false);
  const [dragging, setDragging] = useState(false);

  const toggleChecked = useCallback((id: string) => {
    setCheckedIds((current) =>
      current.includes(id) ? current.filter((value) => value !== id) : [...current, id],
    );
  }, []);

  const moveTargetName = useMemo(() => {
    if (!moveRequest) return "";
    if (moveRequest.deptId === null) return copy("未归属组织", "Unassigned organization");
    const node = organization.find((item) => item.id === moveRequest.deptId);
    return node?.path || node?.name || copy("该部门", "this department");
  }, [moveRequest, organization, copy]);

  const movePlan = useMemo(() => {
    if (!moveRequest) return null;
    const byId = new Map(items.map((user) => [user.id, user]));
    const members = moveRequest.userIds
      .map((id) => byId.get(id))
      .filter((user): user is UserQuotaOverview => user !== undefined)
      .map((user) => ({ id: user.id, displayName: user.displayName, deptId: user.deptId ?? null }));
    return planMove(members, moveRequest.deptId);
  }, [items, moveRequest]);

  /**
   * 逐个改。没有批量接口，也不假装有：任何一个失败都要说出是谁，因为失败的那几个
   * 还留在原部门，只报个数字管理员得自己回去比对。
   */
  const confirmMove = useCallback(async () => {
    if (!moveRequest || !movePlan) return;
    setMovingMembers(true);
    const failed: string[] = [];
    let moved = 0;
    for (const member of movePlan.move) {
      try {
        const res = await adminFetch(`/api/admin/users/${encodeURIComponent(member.id)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ deptId: moveRequest.deptId }),
        });
        const json = (await res.json().catch(() => ({}))) as { code?: string };
        if (!res.ok || (json.code && json.code !== "00000")) throw new Error("failed");
        moved += 1;
      } catch {
        failed.push(member.displayName);
      }
    }
    setMovingMembers(false);
    setMoveRequest(null);
    const text = moveResultText(moveTargetName, moved, movePlan.alreadyThere.length, failed);
    if (failed.length > 0) toast.error(text);
    else toast.success(text);
    if (moved > 0) {
      setCheckedIds([]);
      void load();
    }
  }, [load, moveRequest, movePlan, moveTargetName]);

  const toolbarButtonClass =
    "h-10 !rounded-xl shadow-sm focus-visible:!rounded-xl focus-visible:!outline-none focus-visible:ring-0";
  const viewSwitcherButtonClass =
    "h-9 !rounded-lg gap-1.5 px-2.5 focus-visible:!rounded-lg focus-visible:!outline-none focus-visible:ring-0";

  const viewSwitcher = (
    <div
      className="inline-flex h-10 shrink-0 items-center rounded-xl border border-border/80 bg-background/95 p-0.5 shadow-sm"
      role="group"
      aria-label={copy("切换用户视图", "Switch user view")}
    >
      <Button
        type="button"
        variant={viewMode === "cards" ? "secondary" : "ghost"}
        size="sm"
        className={viewSwitcherButtonClass}
        aria-pressed={viewMode === "cards"}
        onClick={() => setViewMode("cards")}
      >
        <LayoutGrid />
        <span className="hidden sm:inline">{copy("卡片", "Cards")}</span>
      </Button>
      <Button
        type="button"
        variant={viewMode === "list" ? "secondary" : "ghost"}
        size="sm"
        className={viewSwitcherButtonClass}
        aria-pressed={viewMode === "list"}
        onClick={() => setViewMode("list")}
      >
        <List />
        <span className="hidden sm:inline">{copy("列表", "List")}</span>
      </Button>
    </div>
  );
  const userListGridClass = "grid min-w-[1160px] grid-cols-[minmax(240px,1.55fr)_minmax(220px,1.25fr)_88px_minmax(160px,1fr)_minmax(180px,1.3fr)_148px] items-center gap-4";

  return (
    <div className="space-y-6">
      <div className="flex flex-nowrap items-center justify-end gap-2 overflow-x-auto whitespace-nowrap pb-1">
          <Button
            className={`${toolbarButtonClass} px-5`}
            onClick={() => setCreateOpen(true)}
          >
            <Plus className="h-4 w-4" />{copy("新建用户", "New user")}
          </Button>
          <Button
            type="button"
            variant="outline"
            className={`${toolbarButtonClass} px-4`}
            onClick={() => setImportOpen(true)}
          >
            <Upload className="h-4 w-4" />{copy("导入", "Import")}
          </Button>
          <div className="relative shrink-0 rounded-xl transition-shadow focus-within:shadow-[0_0_0_2px_var(--primary)]">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              name="iam-user-search"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder={copy("搜索姓名、邮箱、组织", "Search name, email, or organization")}
              aria-label={copy("搜索用户", "Search users")}
              className="h-10 w-60 appearance-none !rounded-xl border-border/80 bg-background/95 pl-9 shadow-sm transition-colors placeholder:text-muted-foreground/70 !outline-none focus-visible:border-border/80 focus-visible:!rounded-xl focus-visible:!outline-none focus-visible:ring-0"
            />
          </div>
          {viewSwitcher}
          <Button
            type="button"
            variant="outline"
            size="icon"
            className={`${toolbarButtonClass} w-10 shrink-0`}
            aria-label={copy("刷新用量", "Refresh usage")}
            title={copy("刷新用量", "Refresh usage")}
            onClick={() => void load()}
            disabled={loading}
          >
            <RefreshCw className={loading ? "animate-spin" : ""} />
          </Button>
      </div>

      <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
        <aside className="shrink-0 rounded-xl border border-border bg-card p-2 lg:sticky lg:top-4 lg:w-60">
          <DepartmentFilterTree
            nodes={organization}
            selected={deptFilter}
            onSelect={setDeptFilter}
            onConfigureModels={(node) => setCeilingTarget({ kind: "department", node })}
            onConfigureDefaultMemberQuota={() => setDefaultQuotaOpen(true)}
            onConfigureOrganization={() => setCeilingTarget({ kind: "organization" })}
            onChanged={() => void load()}
            onDropMembers={(deptId, userIds) => setMoveRequest({ deptId, userIds })}
            membersDragging={dragging}
            totalCount={items.length}
            unassignedCount={items.filter((user) => !user.deptId).length}
          />
        </aside>
        <div className="min-w-0 flex-1">
      {viewMode === "cards" ? (
        <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
          {loading && items.length === 0
            ? [1, 2, 3, 4, 5, 6].map((key) => (
                <Card key={key} className="min-h-64">
                  <CardHeader><Skeleton className="h-6 w-36" /><Skeleton className="h-4 w-48" /></CardHeader>
                  <CardContent className="flex gap-5"><Skeleton className="h-28 w-28 rounded-full" /><Skeleton className="h-24 flex-1" /></CardContent>
                </Card>
              ))
            : null}
          {!loading && items.length === 0 ? (
            <Card className="border-dashed md:col-span-2 2xl:col-span-3">
              <CardContent className="flex min-h-64 flex-col items-center justify-center text-center">
                <span className="rounded-full bg-primary/10 p-3 text-primary"><UsersRound className="h-6 w-6" /></span>
                <h2 className="mt-4 font-semibold">{copy("暂无用户", "No users")}</h2>
                <p className="mt-1 text-sm text-muted-foreground">{copy("开通用户后会在这里显示每个人的额度、模型和使用情况。", "Users will appear here with their quotas, models, and usage after provisioning.")}</p>
              </CardContent>
            </Card>
          ) : null}
          {!loading && items.length > 0 && visibleItems.length === 0 ? (
            <Card className="border-dashed md:col-span-2 2xl:col-span-3">
              <CardContent className="flex min-h-48 flex-col items-center justify-center text-center">
                <Search className="h-6 w-6 text-muted-foreground" />
                <h2 className="mt-4 font-semibold">{copy("未找到匹配用户", "No matching users")}</h2>
                <p className="mt-1 text-sm text-muted-foreground">{copy("请尝试姓名、邮箱、组织或职位关键词。", "Try a name, email, organization, or job-title keyword.")}</p>
              </CardContent>
            </Card>
          ) : null}
          {visibleItems.map((user) => {
            const status = userStatusMeta(user.status, locale);
            return (
              <Card
                key={user.id}
                className="group cursor-pointer transition-colors hover:border-primary/50 hover:bg-muted/20"
                onClick={() => void openEditor(user)}
                draggable
                onDragStart={(event) => {
                  const ids = dragPayloadIds(user.id, selectedIds);
                  event.dataTransfer.setData(MEMBER_DRAG_MIME, JSON.stringify(ids));
                  event.dataTransfer.effectAllowed = "move";
                  setDragging(true);
                }}
                onDragEnd={() => setDragging(false)}
              >
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between gap-3">
                    <input
                      type="checkbox"
                      className="mt-1 h-4 w-4 shrink-0 cursor-pointer accent-primary"
                      aria-label={`选择 ${user.displayName}`}
                      checked={selectedIds.includes(user.id)}
                      onClick={(event) => event.stopPropagation()}
                      onChange={() => toggleChecked(user.id)}
                    />
                    <div className="min-w-0 flex-1">
                      <CardTitle className="truncate">{user.displayName}</CardTitle>
                      <CardDescription className="mt-1 truncate">{user.email}</CardDescription>
                      <p className="mt-1 truncate text-xs text-muted-foreground">
                        {user.departmentPath || user.departmentName || copy("未归属组织", "Unassigned organization")}{user.jobTitle ? ` · ${user.jobTitle}` : ""}
                      </p>
                    </div>
                    <div className="flex max-w-44 shrink-0 flex-wrap justify-end gap-1.5">
                      <Badge variant={status.variant}>{status.label}</Badge>
                      <Badge variant={user.inherited ? "secondary" : "outline"} className="truncate">
                        {quotaSourceLabel(user, locale)}
                      </Badge>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex items-center gap-4">
                    <QuotaRing used={user.usedTokens} limit={user.monthlyTokens} unlimited={user.unlimited} size={112} />
                    <div className="min-w-0 space-y-2 text-sm">
                      <p className="text-muted-foreground">{copy("本月个人额度", "Monthly personal quota")}</p>
                      <p className="font-semibold">{user.unlimited ? copy("不限制", "Unlimited") : `${formatTokenCount(user.monthlyTokens)} Token`}</p>
                      <p className="text-xs text-muted-foreground">{copy("已用", "Used")} {formatTokenCount(user.usedTokens)} Token</p>
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                        onClick={(event) => {
                          event.stopPropagation();
                          void openEditor(user);
                        }}
                      >
                        <Pencil className="h-3 w-3" />{copy("详细编辑", "Edit details")}
                      </button>
                    </div>
                  </div>
                  <div className="space-y-2 border-t border-border pt-3">
                    <div className="flex flex-wrap gap-1.5">
                      {user.groupNames.length
                        ? user.groupNames.map((name) => <Badge key={name} variant="outline" className="font-normal">{name}</Badge>)
                        : <span className="text-xs text-muted-foreground">{copy("未加入用户组", "No user group")}</span>}
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {user.models.length
                        ? user.models.map((model) => (
                            <Badge
                              key={`${model.model}:${model.currentlyAllowed}`}
                              variant="outline"
                              title={model.currentlyAllowed ? copy("当前可用模型", "Currently available model") : copy("历史消耗模型，当前不可用", "Previously used model; currently unavailable")}
                              className={`max-w-full truncate font-normal ${modelQuotaStateClass(user, model)}`}
                            >
                              {model.model}
                              {model.tokens > 0 ? ` · ${formatTokenCount(model.tokens)}` : ""}
                              {model.currentlyAllowed
                                ? grantSourceText(model, locale)
                                  ? ` · ${grantSourceText(model, locale)}`
                                  : ""
                                : ` · ${copy("当前不可用", "Unavailable")}`}
                            </Badge>
                          ))
                        : <span className="text-xs text-muted-foreground">{copy("当前未开通模型", "No models enabled")}</span>}
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {user.packs?.length
                        ? user.packs.map((pack) => (
                            <Badge key={pack.id} variant="outline" className="max-w-full truncate font-normal">
                              {pack.name}
                              {grantSourceText(pack) ? ` · ${grantSourceText(pack)}` : ""}
                            </Badge>
                          ))
                        : <span className="text-xs text-muted-foreground">{copy("未分配能力包", "No capability pack")}</span>}
                    </div>
                    {user.features ? (
                      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                        {([
                          [copy("联网搜索", "Web search"), user.features.webSearch],
                          [copy("深度研究", "Deep research"), user.features.deepResearch],
                        ] as const).map(([label, feature]) => (
                          <span key={label}>
                            {label}
                            <span className={feature.enabled ? "ml-1 text-foreground" : "ml-1"}>
                              {feature.enabled ? copy("已开通", "Enabled") : copy("未开通", "Not enabled")}
                            </span>
                            {feature.enabled && grantSourceText(feature)
                              ? `（${grantSourceText(feature)}）`
                              : ""}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border bg-card">
          {loading && items.length === 0 ? (
            <div className="space-y-3 p-4">
              {[1, 2, 3, 4].map((key) => <Skeleton key={key} className="h-16 w-full" />)}
            </div>
          ) : items.length === 0 ? (
            <div className="flex min-h-48 flex-col items-center justify-center text-center">
              <span className="rounded-full bg-primary/10 p-3 text-primary"><UsersRound className="h-6 w-6" /></span>
              <h2 className="mt-4 font-semibold">{copy("暂无用户", "No users")}</h2>
              <p className="mt-1 text-sm text-muted-foreground">{copy("开通用户后会在这里显示每个人的额度、模型和使用情况。", "Users will appear here with their quotas, models, and usage after provisioning.")}</p>
            </div>
          ) : visibleItems.length === 0 ? (
            <div className="flex min-h-48 flex-col items-center justify-center text-center">
              <Search className="h-6 w-6 text-muted-foreground" />
              <h2 className="mt-4 font-semibold">{copy("未找到匹配用户", "No matching users")}</h2>
              <p className="mt-1 text-sm text-muted-foreground">{copy("请尝试姓名、邮箱、组织或职位关键词。", "Try a name, email, organization, or job-title keyword.")}</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <div className="min-w-[1160px]">
                <div className={`${userListGridClass} border-b border-border bg-muted/20 px-4 py-3 text-xs font-medium text-muted-foreground`} role="row">
                  <div role="columnheader">{copy("用户", "User")}</div>
                  <div role="columnheader">{copy("组织与职位", "Organization & role")}</div>
                  <div role="columnheader">{copy("状态", "Status")}</div>
                  <div role="columnheader">Token {copy("额度", "quota")}</div>
                  <div role="columnheader">{copy("可用模型", "Available models")}</div>
                  <div role="columnheader" className="text-right">{copy("操作", "Actions")}</div>
                </div>
                <div className="divide-y divide-border">
                  {visibleItems.map((user) => {
                    const status = userStatusMeta(user.status, locale);
                    return (
                      <div
                        key={user.id}
                        role="button"
                        tabIndex={0}
                        className={`${userListGridClass} cursor-pointer px-4 py-3 transition-colors hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset`}
                        draggable
                        onDragStart={(event) => {
                          const ids = dragPayloadIds(user.id, selectedIds);
                          event.dataTransfer.setData(MEMBER_DRAG_MIME, JSON.stringify(ids));
                          event.dataTransfer.effectAllowed = "move";
                          setDragging(true);
                        }}
                        onDragEnd={() => setDragging(false)}
                        onClick={() => void openEditor(user)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            void openEditor(user);
                          }
                        }}
                      >
                        <div className="flex min-w-0 items-center gap-3">
                          <input
                            type="checkbox"
                            className="h-4 w-4 shrink-0 cursor-pointer accent-primary"
                            aria-label={`选择 ${user.displayName}`}
                            checked={selectedIds.includes(user.id)}
                            onClick={(event) => event.stopPropagation()}
                            onChange={() => toggleChecked(user.id)}
                          />
                          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary">
                            {user.displayName.slice(0, 1)}
                          </span>
                          <div className="min-w-0">
                            <p className="truncate font-medium">{user.displayName}</p>
                            <p className="truncate text-xs text-muted-foreground">{user.email}</p>
                          </div>
                        </div>
                        <div className="min-w-0 text-sm">
                          <p className="truncate">{user.departmentPath || user.departmentName || copy("未归属组织", "Unassigned organization")}</p>
                          <p className="truncate text-xs text-muted-foreground">{user.jobTitle || copy("未填写职位", "No job title")}</p>
                        </div>
                        <Badge variant={status.variant} className="justify-self-start">{status.label}</Badge>
                        <div className="min-w-0 text-sm">
                          <p className="truncate font-medium">{user.unlimited ? copy("不限制", "Unlimited") : `${formatTokenCount(user.monthlyTokens)} Token`}</p>
                          <p className="truncate text-xs text-muted-foreground">{copy("已用", "Used")} {formatTokenCount(user.usedTokens)}</p>
                        </div>
                        <div className="flex min-w-0 flex-wrap gap-1">
                          {user.models.length ? user.models.slice(0, 3).map((model) => (
                            <Badge key={`${user.id}:${model.model}`} variant="outline" className="max-w-full truncate text-xs">
                              {model.model}
                            </Badge>
                          )) : <span className="text-xs text-muted-foreground">{copy("未开通模型", "No models enabled")}</span>}
                          {user.models.length > 3 ? <Badge variant="outline">+{user.models.length - 3}</Badge> : null}
                        </div>
                        <div className="flex justify-end">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="shrink-0"
                            onClick={(event) => {
                              event.stopPropagation();
                              void openEditor(user);
                            }}
                          >
                            <Pencil />{copy("详细编辑", "Edit details")}
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
        </div>
      )}
          <MemberBatchBar
            selectedIds={selectedIds}
            departments={organization}
            onRequestMove={(deptId) => setMoveRequest({ deptId, userIds: [...selectedIds] })}
            onClear={() => setCheckedIds([])}
            onChanged={() => {
              setCheckedIds([]);
              void load();
            }}
          />
        </div>
      </div>

      {/*
        调部门的确认框。拖放和批量条都落到这里——移动会连带换掉这批人继承的模型上限
        和额度，不该是拖一下就生效的动作。
      */}
      <Dialog open={moveRequest !== null} onOpenChange={(open) => (open ? null : setMoveRequest(null))}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{copy("移动到", "Move to")} “{moveTargetName}”</DialogTitle>
            <DialogDescription>
              {copy("部门决定这些人能用哪些模型、有多少额度。换了部门，继承来的那一份跟着换。", "The department determines available models and limits. Moving members changes their inherited settings.")}
            </DialogDescription>
          </DialogHeader>
          {movePlan ? (
            <div className="space-y-2 text-sm">
              <p>
                {copy("将移动", "Moving")} <span className="font-medium">{movePlan.move.length}</span> {copy("人", "members")}
                {movePlan.alreadyThere.length > 0 ? (
                  <span className="text-muted-foreground">
                    ({copy("另有", "")} {movePlan.alreadyThere.length} {copy("人已在此部门，不动", "already in this department; unchanged")})
                  </span>
                ) : null}
              </p>
              <div className="max-h-40 overflow-y-auto rounded-md border border-border bg-muted/30 p-2">
                {movePlan.move.length === 0 ? (
                  <p className="text-xs text-muted-foreground">{copy("这批人已经全在这个部门里了。", "These members are already in this department.")}</p>
                ) : (
                  movePlan.move.map((member) => (
                    <p key={member.id} className="truncate text-xs">
                      {member.displayName}
                    </p>
                  ))
                )}
              </div>
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setMoveRequest(null)} disabled={movingMembers}>
              {copy("取消", "Cancel")}
            </Button>
            <Button
              size="sm"
              disabled={movingMembers || (movePlan?.move.length ?? 0) === 0}
              onClick={() => void confirmMove()}
            >
              {movingMembers ? copy("移动中…", "Moving…") : copy("确认移动", "Confirm move")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 组织 / 部门规则直接挂在左侧组织树上，看到对象的地方就是设置入口。 */}
      <Sheet open={ceilingTarget !== null} onOpenChange={(open) => !open && setCeilingTarget(null)}>
        <SheetContent side="right" className="flex w-full flex-col gap-0 overflow-y-auto sm:max-w-2xl">
          <SheetTitle>
            {ceilingTarget?.kind === "department"
              ? `${ceilingTarget.node.name} · ${copy("部门设置", "Department settings")}`
              : copy("组织设置", "Organization settings")}
          </SheetTitle>
          {ceilingTarget ? (
            <div className="space-y-6 pt-4">
              {ceilingTarget.kind === "department" ? (
                <>
                  <div>
                    <p className="text-sm font-medium">{copy("模型范围", "Model scope")}</p>
                    <p className="mb-3 mt-1 text-xs text-muted-foreground">
                      {copy("这个部门的人最多能看到哪些模型；个人只能在这个范围内再收窄。", "Models visible to this department; individuals can only narrow this scope.")}
                    </p>
                    <VisibleModelsEditor
                      target={{ kind: "dept", id: ceilingTarget.node.id }}
                      variant="sheet"
                      onSaved={load}
                    />
                  </div>
                  <div className="border-t pt-6">
                    <BudgetScopeEditor
                      scope="departments"
                      id={ceilingTarget.node.id}
                      onSaved={load}
                    />
                  </div>
                </>
              ) : (
                <BudgetScopeEditor scope="tenants" onSaved={load} />
              )}
            </div>
          ) : null}
        </SheetContent>
      </Sheet>

      {/* 普通成员默认上限：Token / 美元只能选一种。旧 Token 额度卡不再与预算叠放，
          否则管理员看到的是两个都会生效的上限，和产品语义相反。 */}
      <Dialog
        open={defaultQuotaOpen}
        onOpenChange={(open) => {
          setDefaultQuotaOpen(open);
          if (!open) void load();
        }}
      >
        <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{copy("普通成员默认上限", "Default member limit")}</DialogTitle>
            <DialogDescription>
              {copy("没有单独设置的成员按这里执行。Token 与美元二选一，个人特批在成员详情里修改。", "Members without an individual setting use this limit. Choose Token or USD; personal overrides are edited in member details.")}
            </DialogDescription>
          </DialogHeader>
          <DefaultMemberBudgetCard />
        </DialogContent>
      </Dialog>

      {/* 批量导入是「新环境搭起来那几天」的事，不值得占一级菜单，但补人时要顺手够得到。 */}
      <Dialog
        open={importOpen}
        onOpenChange={(open) => {
          setImportOpen(open);
          // 导入向导自己不回调，关窗时重新拉一次——否则刚导进来的人不出现在列表里。
          if (!open) void load();
        }}
      >
        <DialogContent className="max-h-[85vh] max-w-5xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{copy("批量导入成员", "Bulk import members")}</DialogTitle>
            <DialogDescription>
              {copy("上传 CSV，按列映射后批量建号。导入完成后关闭本窗口即可刷新列表。", "Upload a CSV, map its columns, and create accounts in bulk. Close this window when finished to refresh the list.")}
            </DialogDescription>
          </DialogHeader>
          <BulkImportWizard />
        </DialogContent>
      </Dialog>

      <UserDetailEditor
        target={selected}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
        onChanged={load}
      />

      <CreateUserDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        defaultDeptId={requestedDeptId || undefined}
        onCreated={load}
      />
    </div>
  );
}

/**
 * 组织与成员：成员名册 + 用户组，同一页两个 tab。
 *
 * 用户组原本是一个独立菜单，但它不是一类独立的东西——它是「把一批人一起改」的载体，
 * 和成员名册看的是同一批人。分成两个页面的结果是：想确认某人属于哪个组、组里有谁，
 * 得在两个页面之间来回跳，而两边对「现在有哪些人」还各自加载一次。
 */
export default function IamRolesPage() {
  return (
    <Suspense fallback={null}>
      <OrganizationTabs />
    </Suspense>
  );
}

function OrganizationTabs() {
  const locale = useLocale();
  const copy = (zh: string, en: string) => (locale === "en" ? en : zh);
  const router = useRouter();
  const params = useSearchParams();
  const requestedTab = params.get("tab");
  const active = requestedTab === "groups" || requestedTab === "roles" || requestedTab === "agents"
    ? requestedTab
    : "members";
  const onChange = useCallback(
    (value: string) => {
      router.replace(value === "members" ? "/iam/roles" : `/iam/roles?tab=${encodeURIComponent(value)}`);
    },
    [router],
  );
  return (
    <div className="space-y-6">
      <PageHeader
        title={copy("组织与成员", "Organization & members")}
        description={copy("管理成员、组织结构、用户组与个人使用上限。", "Manage members, organization structure, user groups, and personal limits.")}
      />
      <Tabs value={active} onValueChange={onChange}>
        <TabsList>
          <TabsTrigger value="members">{copy("成员", "Members")}</TabsTrigger>
          <TabsTrigger value="groups">{copy("用户组", "User groups")}</TabsTrigger>
          <TabsTrigger value="roles">{copy("权限角色", "Permission roles")}</TabsTrigger>
          <TabsTrigger value="agents">{copy("企业 Agent", "Enterprise agents")}</TabsTrigger>
        </TabsList>
        <TabsContent value="members" className="pt-4">
          <MembersPanel />
        </TabsContent>
        <TabsContent value="groups" className="pt-4">
          <UserGroupsPanel />
        </TabsContent>
        <TabsContent value="roles" className="pt-4">
          <RolesPanel />
        </TabsContent>
        <TabsContent value="agents" className="pt-4">
          <AgentsPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}
