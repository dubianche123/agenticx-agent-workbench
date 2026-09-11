"use client";

import { Progress } from "@agenticx/ui";
import { useLocale } from "next-intl";

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value % 1_000 === 0 ? 0 : 1)}K`;
  return String(value);
}

export type UsageSnapshot = {
  used: number;
  limit: number;
  remaining: number | null;
  unlimited: boolean;
  shared?: boolean;
};

export function QuotaUsageBar({
  usage,
  loading,
}: {
  usage?: UsageSnapshot | null;
  loading?: boolean;
}) {
  const locale = useLocale();
  const copy = (zh: string, en: string) => (locale === "en" ? en : zh);
  if (loading) {
    return <p className="text-xs text-muted-foreground">{copy("用量加载中…", "Loading usage…")}</p>;
  }
  if (!usage) {
    return <p className="text-xs text-muted-foreground">{copy("池用量：—", "Pool usage: —")}</p>;
  }
  if (usage.unlimited) {
    return <p className="text-xs text-muted-foreground">{copy("不限额", "Unlimited")}</p>;
  }
  const pct = usage.limit > 0 ? Math.min(100, Math.round((usage.used / usage.limit) * 100)) : 0;
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground tabular-nums">
        <span>
          {formatTokens(usage.used)}/{formatTokens(usage.limit)}
          {usage.shared ? ` · ${copy("共享池", "shared pool")}` : ""}
        </span>
        <span>{copy("余", "Remaining")} {formatTokens(usage.remaining ?? 0)}</span>
      </div>
      <Progress value={pct} className="h-1" />
    </div>
  );
}
