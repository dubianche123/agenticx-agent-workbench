"use client";

import { useCallback, useEffect, useState } from "react";
import { useLocale } from "next-intl";
import Link from "next/link";
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Skeleton,
  toast,
} from "@agenticx/ui";
import { ArrowRight, RefreshCw } from "lucide-react";

import { adminFetch } from "../../lib/admin-client-auth";
import { CompanyMonthlyLimitsCard } from "../CompanyMonthlyLimitsCard";

type BudgetAlert = {
  id: string;
  dimension: string;
  dimensionKey: string;
  period: string;
  unit: string;
  alertType: string;
  usedValue: string;
  limitValue: string;
  warnThresholdPct: string;
  description: string | null;
  createdAt: string;
};

type BudgetAlertsEnvelope = {
  code?: string;
  message?: string;
  data?: { alerts?: BudgetAlert[] };
};

function unitLabel(unit: string): string {
  return unit === "cost_usd" ? "USD" : unit === "tokens" ? "Token" : unit;
}

function scopeLabel(dimension: string, locale: string): string {
  const copy = (zh: string, en: string) => (locale === "en" ? en : zh);
  if (dimension === "tenant") return copy("组织", "Organization");
  if (dimension === "department") return copy("部门", "Department");
  if (dimension === "user") return copy("成员", "Member");
  if (dimension === "api_token") return copy("访问凭据", "Access credential");
  return dimension;
}

export function BudgetPanel() {
  const locale = useLocale();
  const copy = (zh: string, en: string) => (locale === "en" ? en : zh);
  const [alerts, setAlerts] = useState<BudgetAlert[]>([]);
  const [loading, setLoading] = useState(true);

  const loadAlerts = useCallback(async () => {
    setLoading(true);
    try {
      const response = await adminFetch("/api/metering/budget?view=alerts&limit=50", {
        cache: "no-store",
      });
      const json = (await response.json()) as BudgetAlertsEnvelope;
      if (!response.ok || json.code !== "00000") {
        throw new Error(json.message || copy("加载预算告警失败", "Failed to load budget alerts"));
      }
      setAlerts(json.data?.alerts ?? []);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : copy("加载预算告警失败", "Failed to load budget alerts"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAlerts();
  }, [loadAlerts]);

  return (
    <div className="space-y-5">
      <CompanyMonthlyLimitsCard />

      <Card>
        <CardHeader>
          <CardTitle>{copy("成员使用上限", "Member usage limits")}</CardTitle>
          <CardDescription>
            {copy("普通成员默认规则、部门上限和个人特批统一在「组织与成员」中管理；每条规则只能选择 Token 或美元之一。", "Manage member defaults, department limits, and personal overrides in Organization & Members. Each rule uses either Token or USD.")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild variant="outline" size="sm">
            <Link href="/iam/roles">
              {copy("去组织与成员", "Open Organization & Members")}
              <ArrowRight className="h-4 w-4" />
            </Link>
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-start justify-between gap-4 space-y-0">
          <div>
            <CardTitle>{copy("预算告警", "Budget alerts")}</CardTitle>
            <CardDescription className="mt-1">{copy("查看最近的预警与超限记录。", "Review recent warnings and limit breaches.")}</CardDescription>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void loadAlerts()}
            disabled={loading}
          >
            <RefreshCw className={loading ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
            {copy("刷新", "Refresh")}
          </Button>
        </CardHeader>
        <CardContent className="space-y-2">
          {loading ? (
            <div className="space-y-2">
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          ) : alerts.length === 0 ? (
            <div className="rounded-lg border border-dashed px-4 py-8 text-center">
              <p className="text-sm font-medium">{copy("暂无预算告警", "No budget alerts")}</p>
              <p className="mt-1 text-xs text-muted-foreground">{copy("达到预警或超限阈值后，记录会显示在这里。", "Alerts appear here when a warning or limit threshold is reached.")}</p>
            </div>
          ) : (
            alerts.map((alert) => (
              <div key={alert.id} className="rounded-lg border border-border px-4 py-3 text-sm">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                  <span className="font-medium">{alert.alertType}</span>
                  <span className="text-muted-foreground">
                    {scopeLabel(alert.dimension, locale)} · {alert.dimensionKey}
                  </span>
                  <span className="ml-auto text-xs text-muted-foreground">{alert.createdAt}</span>
                </div>
                <p className="mt-1 text-muted-foreground">
                  {copy("已用", "Used")} {alert.usedValue} / {copy("上限", "limit")} {alert.limitValue} {unitLabel(alert.unit)}
                  {alert.warnThresholdPct ? ` · ${copy("预警", "warning")} ${alert.warnThresholdPct}%` : ""}
                </p>
                {alert.description ? <p className="mt-1">{alert.description}</p> : null}
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}
