"use client";
import { adminFetch } from "../../lib/admin-client-auth";
import { TraceTimelineInline } from "../trace-timeline-tree";
import {
  formatAuditEventLabel,
  formatAuditEventStatusLabel,
  getAuditEventStatus,
} from "../../lib/audit-event-labels";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import type { AuditEvent } from "@agenticx/core-api";
import type { TraceTimeline } from "@agenticx/core-api";
import {
  Badge,
  Button,
  Card,
  CardContent,
  DataTable,
  EmptyState,
  Input,
  Label,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Separator,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  toast,
} from "@agenticx/ui";
import type { ColumnDef } from "@tanstack/react-table";
import { Copy, FileWarning, Filter, Inbox, RefreshCcw, Search, ShieldAlert, ShieldCheck, SlidersHorizontal } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import type { ReactNode } from "react";
import {
  emptyAdminUserDirectory,
  loadAdminUserDirectory,
  resolveAdminUserLabel,
  type AdminUserDirectory,
} from "../../lib/admin-user-directory";
import { getTraceRuntimeCopy } from "../../lib/trace-runtime-copy";

type QueryResult = {
  total: number;
  items: AuditEvent[];
  chain_valid: boolean;
  chain_error_at?: string;
  chain_error_reason?: string;
};

const AUDIT_DISPLAY_TIME_ZONE = "Asia/Shanghai";

function formatAuditTime(value: string, locale = "zh"): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  return new Intl.DateTimeFormat(locale === "en" ? "en-US" : "zh-CN", {
    timeZone: AUDIT_DISPLAY_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  })
    .format(date)
    .replace(/\//g, "-");
}

type TracePanelState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "forbidden" }
  | { status: "not_found" }
  | { status: "error"; message: string }
  | { status: "ok"; traceId: string; timeline: TraceTimeline };

function AuditPageContent() {
  const locale = useLocale();
  const traceCopy = getTraceRuntimeCopy(locale);
  const t = useTranslations("pages.ops.audit");
  const tRuntime = useTranslations("pages.ops.traceRuntime");
  const ts = useTranslations("shell");
  const tc = useTranslations("common");
  const searchParams = useSearchParams();
  const [items, setItems] = useState<AuditEvent[]>([]);
  const [selected, setSelected] = useState<AuditEvent | null>(null);
  const [total, setTotal] = useState(0);
  const [chainValid, setChainValid] = useState(true);
  const [chainError, setChainError] = useState<{ at?: string; reason?: string } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [traceId, setTraceId] = useState(() => searchParams.get("trace_id")?.trim() ?? "");
  const [sessionId, setSessionId] = useState("");
  const [userId, setUserId] = useState("");
  const [model, setModel] = useState("");
  const [policyHit, setPolicyHit] = useState("");
  const [crossBorderOnly, setCrossBorderOnly] = useState(() => searchParams.get("cross_border") === "1");
  const [loading, setLoading] = useState(false);
  const [userDirectory, setUserDirectory] = useState<AdminUserDirectory>(() => emptyAdminUserDirectory());
  const [tracePanel, setTracePanel] = useState<TracePanelState>({ status: "idle" });
  const traceLoadGeneration = useRef(0);

  const [chainFull, setChainFull] = useState<{
    valid: boolean;
    at?: string;
    reason?: string;
    scanned?: number;
    verification?: "full" | "partial";
    verified?: number;
    legacy_unverified?: number;
  } | null>(null);

  const loadChainVerify = useCallback(async () => {
    try {
      const response = await adminFetch("/api/audit/chain-verify");
      const payload = (await response.json()) as {
        code?: string;
        message?: string;
        data?: {
          valid: boolean;
          at?: string;
          reason?: string;
          scanned: number;
          verification?: "full" | "partial";
          verified?: number;
          legacy_unverified?: number;
        };
      };
      if (!response.ok || payload.code !== "00000" || !payload.data) {
        throw new Error(payload.message || `HTTP ${response.status}`);
      }
      setChainFull(payload.data ?? null);
    } catch (error) {
      setChainFull({
        valid: false,
        reason: error instanceof Error ? error.message : "chain verification failed",
        scanned: 0,
        verification: "full",
        verified: 0,
        legacy_unverified: 0,
      });
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const response = await adminFetch("/api/audit/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          trace_id: traceId || undefined,
          session_id: sessionId || undefined,
          user_id: userId || undefined,
          model: model || undefined,
          policy_hit: policyHit || undefined,
          cross_border: crossBorderOnly ? true : undefined,
        }),
      });
      const payload = (await response.json()) as { code?: string; data?: QueryResult; message?: string };
      if (!response.ok || payload.code !== "00000" || !payload.data) {
        throw new Error(payload.message || `HTTP ${response.status}`);
      }
      const data = payload.data;
      setTotal(data.total);
      setItems(data.items);
      const eventId = searchParams.get("event_id")?.trim();
      if (eventId) {
        const matchingEvent = data.items.find((item) => item.id === eventId);
        if (matchingEvent) setSelected(matchingEvent);
      }
      setChainValid(data.chain_valid);
      setChainError(
        data?.chain_valid
          ? null
          : {
              at: data?.chain_error_at,
              reason: data?.chain_error_reason,
            }
      );
      await loadChainVerify();
    } catch (error) {
      const message = error instanceof Error ? error.message : t("toast.loadFailed");
      setLoadError(message);
      toast.error(message);
    } finally {
      setLoading(false);
    }
  }, [traceId, sessionId, userId, model, policyHit, crossBorderOnly, loadChainVerify, searchParams, t]);

  const loadUserDirectory = useCallback(async () => {
    setUserDirectory(await loadAdminUserDirectory());
  }, []);

  useEffect(() => {
    const fromQuery = searchParams.get("trace_id")?.trim() ?? "";
    if (fromQuery) setTraceId(fromQuery);
    setCrossBorderOnly(searchParams.get("cross_border") === "1");
  }, [searchParams]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void loadUserDirectory();
  }, [loadUserDirectory]);

  useEffect(() => {
    traceLoadGeneration.current += 1;
    setTracePanel({ status: "idle" });
  }, [selected?.id]);

  const loadTraceDetail = useCallback(
    async (id: string) => {
      const generation = traceLoadGeneration.current + 1;
      traceLoadGeneration.current = generation;
      const isCurrent = () => traceLoadGeneration.current === generation;
      setTracePanel({ status: "loading" });
      try {
        const response = await adminFetch(`/api/traces/${encodeURIComponent(id)}`, {
          cache: "no-store",
        });
        if (!isCurrent()) return;
        if (response.status === 401 || response.status === 403) {
          setTracePanel({ status: "forbidden" });
          return;
        }
        if (response.status === 404) {
          setTracePanel({ status: "not_found" });
          return;
        }
        if (!response.ok) {
          const payload = (await response.json().catch(() => ({}))) as { message?: string };
          if (!isCurrent()) return;
          setTracePanel({
            status: "error",
            message: payload.message ?? t("detail.traceLoadFailed"),
          });
          return;
        }
        const payload = (await response.json()) as {
          data?: TraceTimeline;
        };
        if (!isCurrent()) return;
        if (!payload.data) {
          setTracePanel({ status: "not_found" });
          return;
        }
        setTracePanel({ status: "ok", traceId: id, timeline: payload.data });
      } catch (error) {
        if (!isCurrent()) return;
        setTracePanel({
          status: "error",
          message: error instanceof Error ? error.message : t("detail.traceLoadFailed"),
        });
      }
    },
    [t],
  );

  const handleExport = async () => {
    const response = await adminFetch("/api/audit/export", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        trace_id: traceId || undefined,
        session_id: sessionId || undefined,
        user_id: userId || undefined,
        model: model || undefined,
        policy_hit: policyHit || undefined,
        cross_border: crossBorderOnly ? true : undefined,
      }),
    });
    const csv = await response.text();
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `audit-${new Date().toISOString().slice(0, 10)}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
    toast.success(t("exportSuccess", { count: items.length }));
  };

  const columns = useMemo<ColumnDef<AuditEvent>[]>(
    () => [
      {
        accessorKey: "event_time",
        header: t("columns.time"),
        cell: ({ row }) => (
          <span className="font-mono text-xs text-muted-foreground">{formatAuditTime(row.original.event_time, locale)}</span>
        ),
      },
      {
        accessorKey: "event_type",
        header: t("columns.event"),
        cell: ({ row }) => (
          <span className="font-medium">{formatAuditEventLabel(row.original.event_type, locale)}</span>
        ),
      },
      {
        accessorKey: "user_id",
        header: t("columns.user"),
        cell: ({ row }) => {
          const userLabel = resolveAdminUserLabel(userDirectory, row.original.user_id, row.original.user_email);
          const userInitial = userLabel.slice(0, 1).toUpperCase();

          return (
            <div className="flex min-w-0 items-center gap-2">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary-soft text-[10px] font-semibold text-primary">
                {userInitial}
              </span>
              <div className="min-w-0">
                <span className="block truncate text-sm">{userLabel}</span>
                {row.original.user_email ? (
                  <span className="block truncate text-[11px] text-muted-foreground">{row.original.user_email}</span>
                ) : null}
              </div>
            </div>
          );
        },
      },
      {
        accessorKey: "model",
        header: t("columns.model"),
        cell: ({ row }) =>
          row.original.model ? (
            <Badge variant="soft" className="font-mono text-[10px]">
              {row.original.model}
            </Badge>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        accessorKey: "cross_border",
        header: locale === "en" ? "Cross-border" : "跨境",
        cell: ({ row }) =>
          row.original.cross_border ? (
            <Badge variant="warning" className="font-mono text-[10px]">
              {row.original.src_region ?? "?"}→{row.original.dst_region ?? "?"}
            </Badge>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        accessorKey: "policies_hit",
        header: t("columns.policy"),
        cell: ({ row }) => {
          const policyHitCount = row.original.policies_hit?.length ?? 0;
          const status = getAuditEventStatus(row.original.event_type, policyHitCount);
          if (status === "public_override") {
            return (
              <Badge variant="warning" className="gap-1">
                <ShieldAlert className="h-3 w-3" />
                {formatAuditEventStatusLabel(status, locale)}
              </Badge>
            );
          }
          if (status === "private_route") {
            return (
              <Badge variant="success" className="gap-1">
                <ShieldCheck className="h-3 w-3" />
                {formatAuditEventStatusLabel(status, locale)}
              </Badge>
            );
          }
          if (status === "rejected") {
            return (
              <Badge variant="destructive" className="gap-1">
                <ShieldAlert className="h-3 w-3" />
                {formatAuditEventStatusLabel(status, locale)}
              </Badge>
            );
          }
          if (status === "compliant") {
            return (
              <Badge variant="success" className="gap-1">
                <ShieldCheck className="h-3 w-3" />
                {formatAuditEventStatusLabel(status, locale)}
              </Badge>
            );
          }
          return (
            <Badge variant="destructive" className="gap-1">
              <ShieldAlert className="h-3 w-3" />
              {t("hit")} {policyHitCount}
            </Badge>
          );
        },
      },
    ],
    [locale, t, userDirectory]
  );

  const activeFilters = useMemo(() => {
    const list = [];
    if (traceId) list.push({ id: "trace", label: `${t("filterLabels.trace")}${traceId}`, onRemove: () => setTraceId("") });
    if (sessionId) list.push({ id: "session", label: `${t("filterLabels.session")}${sessionId}`, onRemove: () => setSessionId("") });
    if (userId) list.push({ id: "user", label: `${t("filterLabels.user")}${userId}`, onRemove: () => setUserId("") });
    if (model) list.push({ id: "model", label: `${t("filterLabels.model")}${model}`, onRemove: () => setModel("") });
    if (policyHit) list.push({ id: "policy", label: `${t("filterLabels.policy")}${policyHit}`, onRemove: () => setPolicyHit("") });
    if (crossBorderOnly) list.push({ id: "cross", label: locale === "en" ? "Cross-border only" : "仅跨境", onRemove: () => setCrossBorderOnly(false) });
    return list;
  }, [traceId, sessionId, userId, model, policyHit, crossBorderOnly, t]);

  const headerChainOk = chainFull != null ? chainFull.valid : chainValid;
  const headerChainPartial = chainFull?.valid === true && chainFull.verification === "partial";
  const headerChainAt =
    chainFull != null && !chainFull.valid ? chainFull.at : chainFull == null && !chainValid ? chainError?.at : undefined;

  const headerDescription = useMemo(() => {
    const prefix = t("description.count", { count: total });
    if (chainFull != null) {
      const chainPart = chainFull.valid
        ? headerChainPartial
          ? t("description.chainPartial", { count: chainFull.legacy_unverified ?? 0 })
          : t("description.chainOk")
        : `${t("description.chainFail")}${chainFull.reason ? `（${chainFull.reason}）` : ""}`;
      return `${prefix} ${chainPart} · ${t("description.scanned", { count: chainFull.scanned ?? 0 })}`;
    }
    if (chainValid) {
      return `${prefix} ${t("description.chainLoading")}`;
    }
    return `${prefix} ${t("description.pageChainFail")}${chainError?.reason ? `（${chainError.reason}）` : ""}`;
  }, [total, chainFull, chainValid, chainError, t]);

  return (
    <div className="space-y-5">

      <Card>
        <CardContent className="pt-5">
          <DataTable
            columns={columns}
            data={items}
            searchPlaceholder={t("searchPlaceholder")}
            activeFilters={activeFilters}
            onClearFilters={() => {
              setTraceId("");
              setSessionId("");
              setUserId("");
              setModel("");
              setPolicyHit("");
              setCrossBorderOnly(false);
            }}
            onRowClick={(row) => setSelected(row.original)}
            onExport={handleExport}
            emptyState={
              <EmptyState
                icon={<FileWarning className="h-5 w-5" />}
                title={loading ? t("emptyLoadingTitle") : loadError ? t("loadErrorTitle") : t("emptyTitle")}
                description={
                  loading
                    ? t("emptyLoadingDescription")
                    : loadError
                      ? t("loadErrorDescription", { error: loadError })
                      : t("emptyDescription")
                }
                size="sm"
                className="border-0"
              />
            }
            toolbarLeft={
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" size="sm" className="gap-1.5">
                    <Filter />
                    {t("advancedFilter")}
                    {activeFilters.length > 0 ? (
                      <Badge variant="default" className="ml-1 h-4 min-w-4 px-1 text-[10px]">
                        {activeFilters.length}
                      </Badge>
                    ) : null}
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-80">
                  <div className="space-y-3">
                    <div className="flex items-center gap-2 text-sm font-semibold">
                      <SlidersHorizontal className="h-4 w-4" />
                      {t("advancedFilter")}
                    </div>
                    <Separator />
                    <div className="space-y-1.5">
                      <Label htmlFor="flt-trace">{t("filterTraceId")}</Label>
                      <Input
                        id="flt-trace"
                        value={traceId}
                        onChange={(event) => setTraceId(event.target.value)}
                        placeholder="01JABCDEFGHJKMNPQRSTVWXYZ"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="flt-session">{t("filterSessionId")}</Label>
                      <Input
                        id="flt-session"
                        value={sessionId}
                        onChange={(event) => setSessionId(event.target.value)}
                        placeholder="sess_..."
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="flt-user">{t("filterUserId")}</Label>
                      <Input
                        id="flt-user"
                        value={userId}
                        onChange={(event) => setUserId(event.target.value)}
                        placeholder="user_demo"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="flt-model">{t("filterModel")}</Label>
                      <Input
                        id="flt-model"
                        value={model}
                        onChange={(event) => setModel(event.target.value)}
                        placeholder="deepseek-chat"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="flt-policy">{t("filterPolicy")}</Label>
                      <Input
                        id="flt-policy"
                        value={policyHit}
                        onChange={(event) => setPolicyHit(event.target.value)}
                        placeholder="finance-keyword-insider"
                      />
                    </div>
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={crossBorderOnly}
                        onChange={(e) => setCrossBorderOnly(e.target.checked)}
                      />
                      {locale === "en" ? "Cross-border events only" : "仅跨境流动事件"}
                    </label>
                    <div className="flex items-center justify-between gap-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setTraceId("");
                          setSessionId("");
                          setUserId("");
                          setModel("");
                          setPolicyHit("");
                          setCrossBorderOnly(false);
                        }}
                      >
                        {t("clearFilters")}
                      </Button>
                      <Button size="sm" onClick={() => void load()}>
                        <Search />
                        {t("applyFilters")}
                      </Button>
                    </div>
                  </div>
                </PopoverContent>
              </Popover>
            }
            getRowId={(row) => row.id}
          />
        </CardContent>
      </Card>

      {/* 详情抽屉 */}
      <Sheet open={!!selected} onOpenChange={(open) => !open && setSelected(null)}>
        <SheetContent className="w-full sm:max-w-2xl">
          {selected ? (
            <div className="flex h-full flex-col gap-4">
              <SheetHeader>
                <div className="flex items-center gap-2">
                  {(() => {
                    const policyHitCount = selected.policies_hit?.length ?? 0;
                    const status = getAuditEventStatus(selected.event_type, policyHitCount);
                    if (status === "public_override") {
                      return (
                        <Badge variant="warning" className="gap-1">
                          <ShieldAlert className="h-3 w-3" />
                          {formatAuditEventStatusLabel(status, locale)}
                        </Badge>
                      );
                    }
                    if (status === "private_route") {
                      return (
                        <Badge variant="success" className="gap-1">
                          <ShieldCheck className="h-3 w-3" />
                          {formatAuditEventStatusLabel(status, locale)}
                        </Badge>
                      );
                    }
                    if (status === "rejected") {
                      return (
                        <Badge variant="destructive" className="gap-1">
                          <ShieldAlert className="h-3 w-3" />
                          {formatAuditEventStatusLabel(status, locale)}
                        </Badge>
                      );
                    }
                    if (status === "compliant") {
                      return (
                        <Badge variant="success" className="gap-1">
                          <ShieldCheck className="h-3 w-3" />
                          {formatAuditEventStatusLabel(status, locale)}
                        </Badge>
                      );
                    }
                    return (
                      <Badge variant="destructive" className="gap-1">
                        <ShieldAlert className="h-3 w-3" />
                        {t("hit")} {policyHitCount}
                      </Badge>
                    );
                  })()}
                  <SheetTitle>{formatAuditEventLabel(selected.event_type, locale)}</SheetTitle>
                </div>
                <SheetDescription className="font-mono text-xs">{selected.id}</SheetDescription>
              </SheetHeader>

              <Tabs defaultValue="summary" className="flex flex-1 flex-col">
                <TabsList>
                  <TabsTrigger value="summary">{t("detail.tabSummary")}</TabsTrigger>
                  <TabsTrigger value="policies">{t("detail.tabPolicies")} ({selected.policies_hit?.length ?? 0})</TabsTrigger>
                  <TabsTrigger value="raw">{t("detail.tabRaw")}</TabsTrigger>
                </TabsList>

                <TabsContent value="summary" className="flex-1 overflow-y-auto pr-1">
                  <dl className="divide-y divide-border text-sm">
                    <DetailField label={t("detail.time")} value={<span className="font-mono text-xs">{formatAuditTime(selected.event_time, locale)}</span>} />
                    <DetailField
                      label={t("detail.user")}
                      value={
                        <div>
                          <div>
                            {resolveAdminUserLabel(userDirectory, selected.user_id, selected.user_email)}
                          </div>
                          {selected.user_email ? <div className="text-xs text-muted-foreground">{selected.user_email}</div> : null}
                          {selected.user_id ? <div className="font-mono text-xs text-muted-foreground">{selected.user_id}</div> : null}
                        </div>
                      }
                    />
                    <DetailField label={t("detail.model")} value={selected.model ?? "—"} />
                    <DetailField label={t("detail.provider")} value={selected.provider ?? "—"} />
                    {selected.audit_source === "iam" ? (
                      <DetailField label={t("detail.source")} value={t("detail.sourceIam")} />
                    ) : null}
                    <DetailField label={t("detail.tenant")} value={<span className="font-mono text-xs">{selected.tenant_id}</span>} />
                    <DetailField label={t("detail.session")} value={<span className="font-mono text-xs">{selected.session_id ?? "—"}</span>} />
                    {selected.trace_id ? (
                      <DetailField
                        label={t("detail.requestId")}
                        value={
                          <div className="space-y-2">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-mono text-xs">{selected.trace_id}</span>
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="h-7 px-2"
                                onClick={() => {
                                  void navigator.clipboard.writeText(selected.trace_id ?? "").then(() => {
                                    toast.success(t("toast.copied"));
                                  });
                                }}
                              >
                                <Copy className="h-3.5 w-3.5" />
                                {t("detail.copyRequestId")}
                              </Button>
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="h-7"
                                disabled={tracePanel.status === "loading"}
                                onClick={() => void loadTraceDetail(selected.trace_id!)}
                              >
                                {t("detail.viewTrace")}
                              </Button>
                              <Button type="button" variant="outline" size="sm" className="h-7" asChild>
                                <Link href={`/admin/governance?tab=logs&trace_id=${encodeURIComponent(selected.trace_id)}`}>
                                  {traceCopy.viewRunRecords}
                                </Link>
                              </Button>
                              <Button type="button" variant="outline" size="sm" className="h-7" asChild>
                                <Link href={`/traces/${encodeURIComponent(selected.trace_id)}`}>
                                  {t("detail.viewRuntime")}
                                </Link>
                              </Button>
                            </div>
                            {tracePanel.status === "loading" ? (
                              <p className="text-xs text-muted-foreground">{t("detail.traceLoading")}</p>
                            ) : null}
                            {tracePanel.status === "forbidden" ? (
                              <p className="text-xs text-muted-foreground">{tRuntime("forbiddenDescription")}</p>
                            ) : null}
                            {tracePanel.status === "not_found" ? (
                              <p className="text-xs text-muted-foreground">{t("detail.traceNotFound")}</p>
                            ) : null}
                            {tracePanel.status === "error" ? (
                              <p className="text-xs text-danger">{tracePanel.message}</p>
                            ) : null}
                            {tracePanel.status === "ok" && tracePanel.traceId === selected.trace_id && tracePanel.timeline.nodes.length === 0 ? (
                              <p className="text-xs text-muted-foreground">{t("detail.traceEmpty")}</p>
                            ) : null}
                            {tracePanel.status === "ok" && tracePanel.traceId === selected.trace_id && tracePanel.timeline.nodes.length > 0 ? (
                              <div className="space-y-2">
                                <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
                                  <span>
                                    {(tracePanel.timeline.sources as { portal_logs_available?: boolean }).portal_logs_available === false ? (
                                      traceCopy.portalLogsUnavailable
                                    ) : (
                                      <>
                                        {traceCopy.portalLogs}: <span className="font-mono text-foreground">{tracePanel.timeline.sources.portal_logs}</span>
                                      </>
                                    )}
                                  </span>
                                  <span>
                                    {traceCopy.gatewayAudit}: <span className="font-mono text-foreground">{(tracePanel.timeline.sources as { audit_events?: number }).audit_events ?? 0}</span>
                                  </span>
                                  <span>
                                    {traceCopy.modelSteps}: <span className="font-mono text-foreground">{tracePanel.timeline.sources.model_steps}</span>
                                  </span>
                                </div>
                                <TraceTimelineInline
                                  traceId={selected.trace_id!}
                                  initialData={tracePanel.timeline}
                                  labels={{
                                    loading: tRuntime("loading"),
                                    empty: tRuntime("emptyDescription"),
                                    loadFailed: tRuntime("toast.loadFailed"),
                                    expand: tRuntime("expand"),
                                    collapse: tRuntime("collapse"),
                                    kind: (kind) => tRuntime(`kind.${kind}`),
                                    totalsSteps: tRuntime("totals.steps"),
                                    totalsTokens: tRuntime("totals.tokens"),
                                    totalsDuration: tRuntime("totals.duration"),
                                    detailTitle: tRuntime("detail.title"),
                                    contentTitle: tRuntime("detail.contentTitle"),
                                    metadataTitle: tRuntime("detail.metadataTitle"),
                                    selectHint: tRuntime("detail.selectHint"),
                                    close: tRuntime("detail.close"),
                                    status: tRuntime("detail.status"),
                                    duration: tRuntime("detail.duration"),
                                    tokens: tRuntime("detail.tokens"),
                                    cost: tRuntime("detail.cost"),
                                    startedAt: tRuntime("detail.startedAt"),
                                    stage: tRuntime("detail.stage"),
                                    errorMessage: tRuntime("detail.errorMessage"),
                                    ioTitle: tRuntime("detail.ioTitle"),
                                    ioPrompt: tRuntime("detail.ioPrompt"),
                                    ioCompletion: tRuntime("detail.ioCompletion"),
                                    noStepIo: tRuntime("detail.noStepIo"),
                                    attributes: tRuntime("detail.attributes"),
                                    sources: tRuntime("detail.sources"),
                                    gatewayAudit: traceCopy.gatewayAudit,
                                    emptyAttrs: tRuntime("detail.emptyAttrs"),
                                    conversation: {
                                      title: tRuntime("conversation.title"),
                                      titleSession: tRuntime("conversation.titleSession"),
                                      loading: tRuntime("conversation.loading"),
                                      empty: tRuntime("conversation.empty"),
                                      loadFailed: tRuntime("conversation.loadFailed"),
                                      expand: tRuntime("conversation.expand"),
                                      collapse: tRuntime("conversation.collapse"),
                                      truncatedHint: tRuntime("conversation.truncatedHint"),
                                      roleUser: tRuntime("conversation.roleUser"),
                                      roleAssistant: tRuntime("conversation.roleAssistant"),
                                      roleTool: tRuntime("conversation.roleTool"),
                                      roleSystem: tRuntime("conversation.roleSystem"),
                                      reasoning: tRuntime("conversation.reasoning"),
                                      reasoningExpand: tRuntime("conversation.reasoningExpand"),
                                      reasoningCollapse: tRuntime("conversation.reasoningCollapse"),
                                      attachments: tRuntime("conversation.attachments"),
                                      chars: tRuntime("conversation.chars"),
                                      scopeTurn: tRuntime("conversation.scopeTurn"),
                                      scopeSession: tRuntime("conversation.scopeSession"),
                                      loadEarlier: tRuntime("conversation.loadEarlier"),
                                      noSession: tRuntime("conversation.noSession"),
                                    },
                                  }}
                                />
                              </div>
                            ) : null}
                          </div>
                        }
                      />
                    ) : null}
                    <DetailField label={t("detail.inputTokens")} value={<span className="font-mono">{selected.input_tokens ?? "—"}</span>} />
                    <DetailField label={t("detail.outputTokens")} value={<span className="font-mono">{selected.output_tokens ?? "—"}</span>} />
                    <DetailField label={t("detail.totalTokens")} value={<span className="font-mono">{selected.total_tokens ?? "—"}</span>} />
                    <DetailField
                      label={t("detail.latency")}
                      value={selected.latency_ms != null ? `${selected.latency_ms} ms` : "—"}
                    />
                    <DetailField label={t("detail.apiToken")} value={<span className="font-mono">{selected.api_token_id ?? "—"}</span>} />
                    <DetailField label={t("detail.promptSummary")} value={selected.digest?.prompt_summary ?? "—"} />
                    <DetailField label={t("detail.responseSummary")} value={selected.digest?.response_summary ?? "—"} />
                    {selected.detail ? (
                      <DetailField
                        label={t("detail.eventDetail")}
                        value={
                          <pre className="whitespace-pre-wrap break-all rounded-md bg-muted/40 p-2 font-mono text-xs">
                            {JSON.stringify(selected.detail, null, 2)}
                          </pre>
                        }
                      />
                    ) : null}
                    <DetailField label={t("detail.toolsCalled")} value={selected.tools_called?.join(", ") || selected.mcp_tool_name || "—"} />
                    <DetailField label={t("detail.toolStatus")} value={selected.mcp_status ?? "—"} />
                    <DetailField
                      label={locale === "en" ? "Data region → upstream" : "数据域 → 上游"}
                      value={
                        selected.cross_border
                          ? `${selected.src_region ?? "?"} → ${selected.dst_region ?? "?"} (${selected.residency_rule ?? "cross_border"})`
                          : "—"
                      }
                    />
                  </dl>
                </TabsContent>

                <TabsContent value="policies" className="flex-1 overflow-y-auto pr-1">
                  {(selected.policies_hit?.length ?? 0) === 0 ? (
                    <EmptyState
                      icon={<ShieldCheck className="h-5 w-5" />}
                      title={t("detail.noPolicyTitle")}
                      description={t("detail.noPolicyDescription")}
                      size="sm"
                      className="border-0"
                    />
                  ) : (
                    <div className="space-y-2">
                      {selected.policies_hit?.map((hit) => (
                        <div
                          key={hit.policy_id}
                          className="rounded-lg border border-danger/30 bg-danger-soft/30 p-3"
                        >
                          <div className="flex items-center gap-2">
                            <ShieldAlert className="h-4 w-4 text-danger" />
                            <span className="text-sm font-medium text-danger">{hit.policy_id}</span>
                            <Badge variant="soft" className="ml-auto text-[10px] uppercase">
                              {hit.severity}
                            </Badge>
                            <Badge
                              variant={hit.action === "block" ? "destructive" : hit.action === "redact" ? "warning" : "soft"}
                              className="text-[10px] uppercase"
                            >
                              {hit.action}
                            </Badge>
                          </div>
                          {hit.matched_rule ? (
                            <div className="mt-1 font-mono text-xs text-muted-foreground">rule: {hit.matched_rule}</div>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  )}
                </TabsContent>

                <TabsContent value="raw" className="flex-1 overflow-y-auto">
                  <pre className="whitespace-pre-wrap break-all rounded-lg border border-border bg-muted/40 p-3 font-mono text-xs">
                    {JSON.stringify(selected, null, 2)}
                  </pre>
                </TabsContent>
              </Tabs>
            </div>
          ) : (
            <EmptyState
              icon={<Inbox className="h-5 w-5" />}
              title={t("detail.selectTitle")}
              description={t("detail.selectDescription")}
              size="sm"
              className="border-0"
            />
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function DetailField({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="grid grid-cols-[120px_1fr] gap-3 py-2.5">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-foreground">{value}</dd>
    </div>
  );
}

export function AuditPanel() {
  const t = useTranslations("pages.ops.audit");
  return (
    <Suspense
      fallback={
        <div className="p-8 text-center text-muted-foreground">{t("emptyLoadingTitle")}</div>
      }
    >
      <AuditPageContent />
    </Suspense>
  );
}
