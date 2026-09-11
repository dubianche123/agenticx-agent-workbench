"use client";

import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  toast,
} from "@agenticx/ui";
import { MessageSquareText, RefreshCcw, ThumbsDown, ThumbsUp } from "lucide-react";
import Link from "next/link";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { adminFetch } from "../../lib/admin-client-auth";
import { useLocale } from "next-intl";

type FeedbackKind = "like" | "dislike";
type FeedbackSource = "web" | "desktop";

type FeedbackSummary = {
  total: number;
  likes: number;
  dislikes: number;
  positive_rate: number | null;
  eligible_messages: number | null;
  feedback_rate: number | null;
  feedback_rate_reason:
    | "provider_filter"
    | "department_snapshot_mismatch"
    | "desktop_source"
    | "mixed_sources"
    | null;
};

type FeedbackTrend = {
  day: string;
  likes: number;
  dislikes: number;
};

type FeedbackModelBreakdown = {
  source: FeedbackSource;
  model: string | null;
  provider: string | null;
  likes: number;
  dislikes: number;
  total: number;
  positive_rate: number | null;
};

type FeedbackItem = {
  id: string;
  source: FeedbackSource;
  feedback_type: FeedbackKind;
  model: string | null;
  provider: string | null;
  department_id: string | null;
  department_name: string | null;
  created_at: string;
  updated_at: string;
  answer_excerpt: string | null;
  trace_id: string | null;
  session_id: string | null;
  message_id: string | null;
};

type FeedbackResult = {
  summary: FeedbackSummary;
  trends: FeedbackTrend[];
  by_source: Array<{
    source: FeedbackSource;
    likes: number;
    dislikes: number;
    total: number;
    positive_rate: number | null;
  }>;
  by_model: FeedbackModelBreakdown[];
  by_department: Array<{
    source: FeedbackSource;
    department_id: string | null;
    department_name: string | null;
    likes: number;
    dislikes: number;
    total: number;
    positive_rate: number | null;
  }>;
  items: FeedbackItem[];
  total: number;
  visibility: "tenant" | "department";
  details_visible: boolean;
  department_id?: string | null;
};

const EMPTY_SUMMARY: FeedbackSummary = {
  total: 0,
  likes: 0,
  dislikes: 0,
  positive_rate: null,
  eligible_messages: 0,
  feedback_rate: null,
  feedback_rate_reason: null,
};

const PAGE_SIZE = 30;

function localDateInput(daysFromToday = 0): string {
  const date = new Date();
  date.setDate(date.getDate() + daysFromToday);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return `${Math.round(value * 100)}%`;
}

function coverageHint(summary: FeedbackSummary, kind: "all" | FeedbackKind, locale = "zh"): string {
  const copy = (zh: string, en: string) => (locale === "en" ? en : zh);
  if (summary.feedback_rate_reason === "desktop_source") {
    return copy("桌面反馈没有服务端回答分母，覆盖率不可用", "Desktop feedback has no server-side answer denominator; coverage is unavailable");
  }
  if (summary.feedback_rate_reason === "mixed_sources") {
    return copy("包含 Web 与桌面反馈；桌面回答分母不可知，覆盖率不可用", "Includes Web and desktop feedback; the desktop denominator is unknown, so coverage is unavailable");
  }
  if (summary.feedback_rate_reason === "provider_filter") {
    return copy("当前供应商只记录在反馈快照中，无法可靠得到对应的回答分母", "The provider exists only in feedback snapshots, so its answer denominator cannot be determined reliably");
  }
  if (summary.feedback_rate_reason === "department_snapshot_mismatch") {
    return copy("部门按反馈提交时快照统计，与当前成员分母口径不同，暂不计算精确覆盖率", "Departments use the submission-time snapshot, so exact coverage is not calculated");
  }
  if (kind !== "all") {
    return copy("全部反馈 / 可反馈回答（覆盖率忽略有用/没用筛选）", "All feedback / eligible answers (coverage ignores the like/dislike filter)");
  }
  return copy("全部反馈 / 可反馈回答", "All feedback / eligible answers");
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false });
}

function FeedbackKindBadge({ value, locale = "zh" }: { value: FeedbackKind; locale?: string }) {
  const label = value === "like" ? (locale === "en" ? "Helpful" : "有用") : (locale === "en" ? "Not helpful" : "没用");
  return value === "like" ? (
    <Badge variant="success" className="gap-1">
      <ThumbsUp className="h-3 w-3" /> {label}
    </Badge>
  ) : (
    <Badge variant="warning" className="gap-1">
      <ThumbsDown className="h-3 w-3" /> {label}
    </Badge>
  );
}

function FeedbackSourceBadge({ value, locale = "zh" }: { value: FeedbackSource; locale?: string }) {
  return <Badge variant="outline">{value === "desktop" ? (locale === "en" ? "Desktop" : "桌面") : "Web"}</Badge>;
}

function StatCard({
  label,
  value,
  hint,
  icon,
}: {
  label: string;
  value: string;
  hint: string;
  icon: React.ReactNode;
}) {
  return (
    <Card>
      <CardContent className="flex items-start justify-between p-5">
        <div>
          <p className="text-sm text-muted-foreground">{label}</p>
          <p className="mt-1 text-2xl font-semibold tracking-tight">{value}</p>
          <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
        </div>
        <div className="rounded-lg bg-muted p-2.5 text-muted-foreground">{icon}</div>
      </CardContent>
    </Card>
  );
}

function TrendBars({ rows, locale = "zh" }: { rows: FeedbackTrend[]; locale?: string }) {
  const copy = (zh: string, en: string) => (locale === "en" ? en : zh);
  const max = Math.max(1, ...rows.map((row) => row.likes + row.dislikes));
  if (rows.length === 0) return <EmptyState title={copy("当前时间范围内暂无反馈趋势", "No feedback trend in this period")} />;

  return (
    <div className="flex h-44 items-end gap-1.5 overflow-x-auto pb-6" aria-label={copy("每日反馈趋势", "Daily feedback trend")}>
      {rows.map((row) => {
        const total = row.likes + row.dislikes;
        const height = Math.max(8, Math.round((total / max) * 132));
        const likeHeight = total === 0 ? 0 : Math.round((row.likes / total) * height);
        const dislikeHeight = Math.max(0, height - likeHeight);
        return (
          <div key={row.day} className="group relative flex min-w-6 flex-1 flex-col justify-end">
            <div
              className="flex w-full flex-col-reverse overflow-hidden rounded-sm bg-muted"
              style={{ height }}
              title={`${row.day}: ${copy("有用", "Helpful")} ${row.likes}, ${copy("没用", "Not helpful")} ${row.dislikes}`}
            >
              <div className="bg-emerald-500/80" style={{ height: likeHeight }} />
              <div className="bg-amber-500/80" style={{ height: dislikeHeight }} />
            </div>
            <span className="absolute -bottom-5 left-1/2 hidden -translate-x-1/2 whitespace-nowrap text-[10px] text-muted-foreground group-last:block sm:group-[&:nth-child(5n+1)]:block">
              {row.day.slice(5)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function FeedbackPanel() {
  const locale = useLocale();
  const copy = (zh: string, en: string) => (locale === "en" ? en : zh);
  const [kind, setKind] = useState<"all" | FeedbackKind>("all");
  const [source, setSource] = useState<"all" | FeedbackSource>("all");
  const [model, setModel] = useState("");
  const [provider, setProvider] = useState("");
  const [department, setDepartment] = useState("all");
  const [departmentOptions, setDepartmentOptions] = useState<FeedbackResult["by_department"]>([]);
  const [start, setStart] = useState(() => localDateInput(-29));
  const [end, setEnd] = useState(() => localDateInput());
  const [offset, setOffset] = useState(0);
  const [result, setResult] = useState<FeedbackResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [forbidden, setForbidden] = useState(false);
  const requestGeneration = useRef(0);
  const activeRequest = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    const generation = requestGeneration.current + 1;
    requestGeneration.current = generation;
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    const isCurrent = () => requestGeneration.current === generation && !controller.signal.aborted;

    setLoading(true);
    setForbidden(false);
    try {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
      if (kind !== "all") params.set("feedback_type", kind);
      if (source !== "all") params.set("source", source);
      if (model.trim()) params.set("model", model.trim());
      if (provider.trim()) params.set("provider", provider.trim());
      if (department !== "all") params.set("department_id", department);
      if (start) params.set("start", new Date(`${start}T00:00:00`).toISOString());
      if (end) params.set("end", new Date(`${end}T23:59:59.999`).toISOString());

      const response = await adminFetch(`/api/admin/feedback?${params.toString()}`, {
        cache: "no-store",
        signal: controller.signal,
      });
      if (!isCurrent()) return;
      if (response.status === 401 || response.status === 403) {
        setForbidden(true);
        setResult(null);
        return;
      }
      const payload = (await response.json()) as {
        data?: FeedbackResult;
        message?: string;
      };
      if (!response.ok || !payload.data) {
        throw new Error(payload.message ?? copy("加载会话反馈失败", "Failed to load feedback"));
      }
      if (!isCurrent()) return;
      setResult(payload.data);
      if (department === "all" && payload.data.visibility === "tenant") {
        setDepartmentOptions(payload.data.by_department);
      }
    } catch (error) {
      if (!isCurrent()) return;
      toast.error(error instanceof Error ? error.message : copy("加载会话反馈失败", "Failed to load feedback"));
    } finally {
      if (isCurrent()) {
        setLoading(false);
        if (activeRequest.current === controller) activeRequest.current = null;
      }
    }
  }, [department, end, kind, model, offset, provider, source, start]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 220);
    return () => {
      window.clearTimeout(timer);
      requestGeneration.current += 1;
      activeRequest.current?.abort();
      activeRequest.current = null;
    };
  }, [load]);

  useEffect(() => {
    return () => {
      requestGeneration.current += 1;
      activeRequest.current?.abort();
      activeRequest.current = null;
    };
  }, []);

  const summary = result?.summary ?? EMPTY_SUMMARY;
  const pageStart = result?.total ? offset + 1 : 0;
  const pageEnd = Math.min(offset + PAGE_SIZE, result?.total ?? 0);
  const hasNext = pageEnd < (result?.total ?? 0);
  const scopeLabel = result?.visibility === "department" ? copy("本部门", "Department") : copy("全公司", "Company");
  const modelRows = useMemo(() => result?.by_model ?? [], [result?.by_model]);

  if (forbidden) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{copy("没有反馈分析权限", "No feedback analytics permission")}</CardTitle>
          <CardDescription>{copy("反馈聚合需要审计读取权限；部门管理员只会看到本部门范围。", "Feedback aggregation requires audit read permission; department admins only see their department.")}</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-muted/30 px-4 py-3">
        <div>
          <p className="text-sm font-medium">{copy("回答质量反馈", "Answer quality feedback")}</p>
          <p className="text-xs text-muted-foreground">
            {copy("默认展示聚合指标与脱敏摘要；完整对话仍受会话审计权限控制。", "Aggregated metrics and redacted excerpts are shown by default; full conversations remain controlled by session audit permissions.")}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline">{scopeLabel} {copy("范围", "scope")}</Badge>
          {result?.visibility === "department" && result.department_id ? (
            <span className="font-mono text-xs text-muted-foreground">{result.department_id}</span>
          ) : null}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <StatCard
          label={copy("反馈总数", "Total feedback")}
          value={String(summary.total)}
          hint={summary.eligible_messages === null ? copy("当前筛选无法可靠得到回答分母", "The current filters cannot determine an answer denominator") : `${copy("分母", "Denominator")} ${summary.eligible_messages} ${copy("条可反馈回答", "eligible answers")}`}
          icon={<MessageSquareText className="h-5 w-5" />}
        />
        <StatCard
          label={copy("有用", "Helpful")}
          value={String(summary.likes)}
          hint={copy("用户标记为有帮助", "Marked helpful by users")}
          icon={<ThumbsUp className="h-5 w-5" />}
        />
        <StatCard
          label={copy("没用", "Not helpful")}
          value={String(summary.dislikes)}
          hint={copy("建议优先抽样复盘", "Prioritize for review")}
          icon={<ThumbsDown className="h-5 w-5" />}
        />
        <StatCard
          label={copy("好评率", "Positive rate")}
          value={formatPercent(summary.positive_rate)}
          hint={copy("有用 / 已反馈", "Helpful / feedback")}
          icon={<ThumbsUp className="h-5 w-5" />}
        />
        <StatCard
          label={copy("反馈覆盖率", "Feedback coverage")}
          value={summary.feedback_rate_reason ? copy("不可用", "Unavailable") : formatPercent(summary.feedback_rate)}
          hint={coverageHint(summary, kind, locale)}
          icon={<MessageSquareText className="h-5 w-5" />}
        />
      </div>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-end gap-3">
            <div className="w-36 space-y-1.5">
              <Label htmlFor="feedback-kind">{copy("反馈类型", "Feedback type")}</Label>
              <Select
                value={kind}
                onValueChange={(value) => {
                  setKind(value as "all" | FeedbackKind);
                  setOffset(0);
                }}
              >
                <SelectTrigger id="feedback-kind"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{copy("全部反馈", "All feedback")}</SelectItem>
                  <SelectItem value="like">{copy("有用", "Helpful")}</SelectItem>
                  <SelectItem value="dislike">{copy("没用", "Not helpful")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="w-36 space-y-1.5">
              <Label htmlFor="feedback-source">{copy("来源", "Source")}</Label>
              <Select
                value={source}
                onValueChange={(value) => {
                  setSource(value as "all" | FeedbackSource);
                  setOffset(0);
                }}
              >
                <SelectTrigger id="feedback-source"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{copy("全部来源", "All sources")}</SelectItem>
                  <SelectItem value="web">Web</SelectItem>
                  <SelectItem value="desktop">{copy("桌面", "Desktop")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="min-w-56 flex-1 space-y-1.5">
              <Label htmlFor="feedback-model">{copy("模型", "Model")}</Label>
              <Input
                id="feedback-model"
                value={model}
                onChange={(event) => setModel(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    setOffset(0);
                    void load();
                  }
                }}
                placeholder={copy("按模型名称筛选", "Filter by model name")}
              />
            </div>
            <div className="w-44 space-y-1.5">
              <Label htmlFor="feedback-provider">{copy("供应商", "Provider")}</Label>
              <Input
                id="feedback-provider"
                value={provider}
                onChange={(event) => setProvider(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    setOffset(0);
                    void load();
                  }
                }}
                placeholder={copy("按供应商筛选", "Filter by provider")}
              />
            </div>
            {result?.visibility === "tenant" && departmentOptions.length > 0 ? (
              <div className="w-52 space-y-1.5">
                <Label htmlFor="feedback-department">{copy("部门", "Department")}</Label>
                <Select
                  value={department}
                  onValueChange={(value) => {
                    setDepartment(value);
                    setOffset(0);
                  }}
                >
                  <SelectTrigger id="feedback-department"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{copy("全部部门", "All departments")}</SelectItem>
                    {departmentOptions
                      .filter((row): row is typeof row & { department_id: string } => Boolean(row.department_id))
                      .map((row) => (
                        <SelectItem key={row.department_id} value={row.department_id}>
                          {row.department_name ?? row.department_id}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}
            <div className="w-40 space-y-1.5">
              <Label htmlFor="feedback-start">{copy("开始日期", "Start date")}</Label>
              <Input id="feedback-start" type="date" value={start} onChange={(event) => { setStart(event.target.value); setOffset(0); }} />
            </div>
            <div className="w-40 space-y-1.5">
              <Label htmlFor="feedback-end">{copy("结束日期", "End date")}</Label>
              <Input id="feedback-end" type="date" value={end} onChange={(event) => { setEnd(event.target.value); setOffset(0); }} />
            </div>
            <Button variant="outline" onClick={() => void load()} disabled={loading}>
              <RefreshCcw className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} />
              {copy("刷新", "Refresh")}
            </Button>
          </div>
        </CardHeader>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{copy("按来源统计", "By source")}</CardTitle>
          <CardDescription>{copy("汇总 Web 与桌面桥接提交的反馈；桌面来源不参与回答覆盖率分母。", "Feedback submitted from Web and desktop; desktop does not contribute to the answer coverage denominator.")}</CardDescription>
        </CardHeader>
        <CardContent>
          {(result?.by_source ?? []).length === 0 ? (
            <EmptyState title={copy("暂无来源反馈", "No source feedback")} />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{copy("来源", "Source")}</TableHead>
                  <TableHead className="text-right">{copy("反馈总数", "Total")}</TableHead>
                  <TableHead className="text-right">{copy("有用", "Helpful")}</TableHead>
                  <TableHead className="text-right">{copy("没用", "Not helpful")}</TableHead>
                  <TableHead className="text-right">{copy("好评率", "Positive rate")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(result?.by_source ?? []).map((row) => (
                  <TableRow key={row.source}>
                    <TableCell><FeedbackSourceBadge value={row.source} locale={locale} /></TableCell>
                    <TableCell className="text-right">{row.total}</TableCell>
                    <TableCell className="text-right">{row.likes}</TableCell>
                    <TableCell className="text-right">{row.dislikes}</TableCell>
                    <TableCell className="text-right">{formatPercent(row.positive_rate)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {loading && !result ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <Skeleton className="h-72" />
          <Skeleton className="h-72" />
        </div>
      ) : (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(440px,0.9fr)]">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{copy("按模型统计", "By model")}</CardTitle>
              <CardDescription>{copy("模型与供应商快照取自用户提交反馈时的真实回答。", "Model and provider snapshots come from the actual answer at feedback time.")}</CardDescription>
            </CardHeader>
            <CardContent>
              {modelRows.length === 0 ? (
                <EmptyState title={copy("暂无模型反馈", "No model feedback")} />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{copy("来源", "Source")}</TableHead>
                      <TableHead>{copy("模型", "Model")}</TableHead>
                      <TableHead>{copy("供应商", "Provider")}</TableHead>
                      <TableHead className="text-right">{copy("有用", "Helpful")}</TableHead>
                      <TableHead className="text-right">{copy("没用", "Not helpful")}</TableHead>
                      <TableHead className="text-right">{copy("好评率", "Positive rate")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {modelRows.map((row) => (
                      <TableRow key={`${row.source}:${row.provider ?? "unknown"}:${row.model ?? "unknown"}`}>
                        <TableCell><FeedbackSourceBadge value={row.source} locale={locale} /></TableCell>
                        <TableCell className="font-medium">{row.model ?? copy("未记录", "Not recorded")}</TableCell>
                        <TableCell className="text-muted-foreground">{row.provider ?? "—"}</TableCell>
                        <TableCell className="text-right">{row.likes}</TableCell>
                        <TableCell className="text-right">{row.dislikes}</TableCell>
                        <TableCell className="text-right">{formatPercent(row.positive_rate)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">{copy("每日趋势", "Daily trend")}</CardTitle>
              <CardDescription>
                <span className="mr-3 text-emerald-600">● {copy("有用", "Helpful")}</span>
                <span className="text-amber-600">● {copy("没用", "Not helpful")}</span>
              </CardDescription>
            </CardHeader>
            <CardContent>
              <TrendBars rows={result?.trends ?? []} locale={locale} />
            </CardContent>
          </Card>
        </div>
      )}

      {result?.visibility === "tenant" ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{copy("按部门统计", "By department")}</CardTitle>
            <CardDescription>{copy("部门信息使用反馈提交时的组织归属快照，避免调岗后历史口径漂移。", "Department data uses the organization snapshot at feedback time to prevent historical drift after transfers.")}</CardDescription>
          </CardHeader>
          <CardContent>
            {result.by_department.length === 0 ? (
              <EmptyState title={copy("暂无部门反馈", "No department feedback")} />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{copy("来源", "Source")}</TableHead>
                    <TableHead>{copy("部门", "Department")}</TableHead>
                    <TableHead className="text-right">{copy("反馈总数", "Total")}</TableHead>
                    <TableHead className="text-right">{copy("有用", "Helpful")}</TableHead>
                    <TableHead className="text-right">{copy("没用", "Not helpful")}</TableHead>
                    <TableHead className="text-right">{copy("好评率", "Positive rate")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {result.by_department.map((row) => (
                    <TableRow key={`${row.source}:${row.department_id ?? "unassigned"}`}>
                      <TableCell><FeedbackSourceBadge value={row.source} locale={locale} /></TableCell>
                      <TableCell>
                        <div className="font-medium">{row.department_name ?? copy("未分配部门", "Unassigned department")}</div>
                        {row.department_id ? (
                          <div className="font-mono text-[10px] text-muted-foreground">{row.department_id}</div>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-right">{row.total}</TableCell>
                      <TableCell className="text-right">{row.likes}</TableCell>
                      <TableCell className="text-right">{row.dislikes}</TableCell>
                      <TableCell className="text-right">{formatPercent(row.positive_rate)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{copy("反馈样本", "Feedback samples")}</CardTitle>
          <CardDescription>
            {result?.details_visible
              ? copy("只显示回答的脱敏摘要；可使用 Trace 或会话编号进入受控审计链路。", "Only redacted answer excerpts are shown; use Trace or a session ID to enter the controlled audit trail.")
              : copy("当前权限只允许查看聚合结果，不展示反馈者、消息或回答内容。", "Your permission only allows aggregate results; feedback users, messages, and answers are hidden.")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!result?.details_visible ? (
            <EmptyState title={copy("当前角色仅可查看聚合指标", "This role can only view aggregate metrics")} />
          ) : (result.items.length === 0 ? (
            <EmptyState title={copy("当前筛选条件下暂无反馈样本", "No feedback samples match the current filters")} />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{copy("时间", "Time")}</TableHead>
                    <TableHead>{copy("来源", "Source")}</TableHead>
                    <TableHead>{copy("反馈", "Feedback")}</TableHead>
                    <TableHead>{copy("模型", "Model")}</TableHead>
                    <TableHead className="min-w-72">{copy("回答摘要", "Answer excerpt")}</TableHead>
                    <TableHead>Trace</TableHead>
                    <TableHead>{copy("部门", "Department")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {result.items.map((item) => (
                    <TableRow key={item.id}>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                        {formatTime(item.updated_at || item.created_at)}
                      </TableCell>
                        <TableCell><FeedbackSourceBadge value={item.source} locale={locale} /></TableCell>
                        <TableCell><FeedbackKindBadge value={item.feedback_type} locale={locale} /></TableCell>
                      <TableCell>
                        <div className="max-w-44 truncate font-medium" title={item.model ?? undefined}>{item.model ?? copy("未记录", "Not recorded")}</div>
                        <div className="text-xs text-muted-foreground">{item.provider ?? "—"}</div>
                      </TableCell>
                      <TableCell>
                        <p className="line-clamp-3 max-w-xl whitespace-pre-wrap text-sm">
                          {item.answer_excerpt || copy("（摘要不可用）", "(Excerpt unavailable)")}
                        </p>
                      </TableCell>
                      <TableCell className="font-mono text-xs" title={item.trace_id ?? undefined}>
                        {item.trace_id ? (
                          <Link
                            href={`/admin/governance?tab=logs&trace_id=${encodeURIComponent(item.trace_id)}`}
                            className="text-primary underline-offset-4 hover:underline"
                          >
                            {item.trace_id.slice(0, 10)}…
                          </Link>
                        ) : "—"}
                      </TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {item.department_name ?? item.department_id ?? "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ))}

          {result?.details_visible && result.total > 0 ? (
            <div className="mt-4 flex items-center justify-between border-t pt-4">
              <span className="text-xs text-muted-foreground">
                {locale === "en" ? `${pageStart}–${pageEnd} of ${result.total}` : `第 ${pageStart}–${pageEnd} 条，共 ${result.total} 条`}
              </span>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" disabled={offset === 0 || loading} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>
                  {copy("上一页", "Previous")}
                </Button>
                <Button variant="outline" size="sm" disabled={!hasNext || loading} onClick={() => setOffset(offset + PAGE_SIZE)}>
                  {copy("下一页", "Next")}
                </Button>
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
