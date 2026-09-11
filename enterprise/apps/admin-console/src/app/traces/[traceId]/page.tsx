"use client";

import { adminFetch } from "../../../lib/admin-client-auth";
import { TraceExplorer } from "../../../components/trace-timeline-tree";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import type { TraceTimeline } from "@agenticx/core-api";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
  Button,
  Card,
  CardContent,
  EmptyState,
  PageHeader,
  toast,
} from "@agenticx/ui";
import { Copy, GitBranch, Inbox } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { getTraceRuntimeCopy } from "../../../lib/trace-runtime-copy";

export default function TraceRuntimePage() {
  const locale = useLocale();
  const t = useTranslations("pages.ops.traceRuntime");
  const traceCopy = getTraceRuntimeCopy(locale);
  const ts = useTranslations("shell");
  const params = useParams<{ traceId: string }>();
  const traceId = useMemo(() => String(params.traceId ?? "").trim(), [params.traceId]);

  const [data, setData] = useState<TraceTimeline | null>(null);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const loadGeneration = useRef(0);
  const activeLoad = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    activeLoad.current?.abort();
    const controller = new AbortController();
    activeLoad.current = controller;
    const generation = loadGeneration.current + 1;
    loadGeneration.current = generation;
    const requestedTraceId = traceId;
    const isCurrent = () =>
      loadGeneration.current === generation &&
      activeLoad.current === controller &&
      !controller.signal.aborted;

    setLoading(true);
    setForbidden(false);
    setInvalid(false);
    setData(null);
    try {
      if (!requestedTraceId) {
        if (isCurrent()) setInvalid(true);
        return;
      }
      const response = await adminFetch(`/api/traces/${encodeURIComponent(requestedTraceId)}`, {
        cache: "no-store",
        signal: controller.signal,
      });
      if (!isCurrent()) return;
      if (response.status === 401 || response.status === 403) {
        setForbidden(true);
        setData(null);
        return;
      }
      if (response.status === 400) {
        setInvalid(true);
        setData(null);
        return;
      }
      const payload = (await response.json()) as {
        code?: string;
        data?: TraceTimeline;
        message?: string;
      };
      if (!isCurrent()) return;
      if (!response.ok) {
        throw new Error(payload.message ?? t("toast.loadFailed"));
      }
      // Never render a server response for a different route param under the
      // current trace page, even if the request itself was not aborted.
      if (payload.data && payload.data.trace_id !== requestedTraceId) return;
      setData(payload.data ?? null);
    } catch (error) {
      if (!isCurrent() || controller.signal.aborted) return;
      toast.error(error instanceof Error ? error.message : t("toast.loadFailed"));
      setData(null);
    } finally {
      if (isCurrent()) {
        setLoading(false);
        activeLoad.current = null;
      }
    }
  }, [traceId, t]);

  useEffect(() => {
    void load();
    return () => {
      loadGeneration.current += 1;
      activeLoad.current?.abort();
      activeLoad.current = null;
    };
  }, [load]);

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink asChild>
              <Link href="/admin/governance?tab=traces">{ts("nav.items.governance")}</Link>
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>{t("breadcrumb")}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      <PageHeader
        title={t("title")}
        description={t("description")}
        actions={
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" asChild>
              <Link href={`/admin/governance?tab=logs&trace_id=${encodeURIComponent(traceId)}`}>
                {t("backPortalLogs")}
              </Link>
            </Button>
            <Button type="button" variant="outline" size="sm" asChild>
              <Link href={`/admin/governance?trace_id=${encodeURIComponent(traceId)}`}>{t("backAudit")}</Link>
            </Button>
          </div>
        }
      />

      <Card>
        <CardContent className="flex flex-wrap items-center gap-3 pt-4">
          <GitBranch className="h-4 w-4 text-muted-foreground" />
          <span className="font-mono text-sm">{traceId || "—"}</span>
          {traceId ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2"
              onClick={() => {
                void navigator.clipboard.writeText(traceId).then(() => {
                  toast.success(t("toast.copied"));
                });
              }}
            >
              <Copy className="mr-1 h-3.5 w-3.5" />
              {t("copyTraceId")}
            </Button>
          ) : null}
          {data ? (
            <div className="ml-auto flex flex-wrap gap-3 text-xs text-muted-foreground">
              <span>
                {t("totals.steps")}: <span className="font-mono text-foreground">{data.totals.steps}</span>
              </span>
              <span>
                {t("totals.tokens")}:{" "}
                <span className="font-mono text-foreground">{data.totals.tokens}</span>
              </span>
              <span>
                {t("totals.cost")}:{" "}
                <span className="font-mono text-foreground">{data.totals.cost_usd.toFixed(6)}</span>
              </span>
              <span>
                {t("totals.duration")}:{" "}
                <span className="font-mono text-foreground">
                  {data.totals.duration_ms != null ? `${data.totals.duration_ms}ms` : "—"}
                </span>
              </span>
              <span>
                {(data.sources as { portal_logs_available?: boolean }).portal_logs_available === false
                  ? traceCopy.portalLogsUnavailable
                  : `${traceCopy.portalLogs}: ${data.sources.portal_logs}`} · {traceCopy.modelSteps}:{" "}
                {data.sources.model_steps} · {t("sources.deepResearch")}:{" "}
                {data.sources.deep_research_run ? "yes" : "no"}
                {(data.sources as { audit_events?: number }).audit_events != null ? (
                  <> · {traceCopy.gatewayAudit}: {(data.sources as { audit_events?: number }).audit_events}</>
                ) : null}
              </span>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {forbidden ? (
        <EmptyState
          icon={<Inbox className="h-8 w-8" />}
          title={t("forbiddenTitle")}
          description={t("forbiddenDescription")}
        />
      ) : invalid ? (
        <EmptyState
          icon={<Inbox className="h-8 w-8" />}
          title={t("invalidTitle")}
          description={t("invalidDescription")}
        />
      ) : loading ? (
        <EmptyState
          icon={<GitBranch className="h-8 w-8" />}
          title={t("loading")}
          description={t("description")}
        />
      ) : !data || data.nodes.length === 0 ? (
        <EmptyState
          icon={<Inbox className="h-8 w-8" />}
          title={t("emptyTitle")}
          description={t("emptyDescription")}
        />
      ) : (
        <TraceExplorer
          data={data}
          labels={{
            expand: t("expand"),
            collapse: t("collapse"),
            kind: (kind) => t(`kind.${kind}`),
            detailTitle: t("detail.title"),
            contentTitle: t("detail.contentTitle"),
            metadataTitle: t("detail.metadataTitle"),
            selectHint: t("detail.selectHint"),
            close: t("detail.close"),
            status: t("detail.status"),
            duration: t("detail.duration"),
            tokens: t("detail.tokens"),
            cost: t("detail.cost"),
            startedAt: t("detail.startedAt"),
            stage: t("detail.stage"),
            errorMessage: t("detail.errorMessage"),
            ioTitle: t("detail.ioTitle"),
            ioPrompt: t("detail.ioPrompt"),
            ioCompletion: t("detail.ioCompletion"),
            noStepIo: t("detail.noStepIo"),
            attributes: t("detail.attributes"),
            sources: t("detail.sources"),
            emptyAttrs: t("detail.emptyAttrs"),
            conversation: {
              title: t("conversation.title"),
              titleSession: t("conversation.titleSession"),
              loading: t("conversation.loading"),
              empty: t("conversation.empty"),
              loadFailed: t("conversation.loadFailed"),
              expand: t("conversation.expand"),
              collapse: t("conversation.collapse"),
              truncatedHint: t("conversation.truncatedHint"),
              roleUser: t("conversation.roleUser"),
              roleAssistant: t("conversation.roleAssistant"),
              roleTool: t("conversation.roleTool"),
              roleSystem: t("conversation.roleSystem"),
              reasoning: t("conversation.reasoning"),
              reasoningExpand: t("conversation.reasoningExpand"),
              reasoningCollapse: t("conversation.reasoningCollapse"),
              attachments: t("conversation.attachments"),
              chars: t("conversation.chars"),
              scopeTurn: t("conversation.scopeTurn"),
              scopeSession: t("conversation.scopeSession"),
              loadEarlier: t("conversation.loadEarlier"),
              noSession: t("conversation.noSession"),
            },
          }}
          className="min-h-[480px] bg-card"
        />
      )}
    </div>
  );
}
