"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Switch,
  toast,
} from "@agenticx/ui";
import { CircleDollarSign, Coins, Save, ShieldAlert } from "lucide-react";
import { useLocale } from "next-intl";

import { adminFetch, readAdminJsonResponse } from "../../lib/admin-client-auth";

export type SpendingLimitUnit = "cost_usd" | "tokens";
export type SpendingLimitPeriod = "day" | "week" | "month";
export type SpendingLimitAction = "warn" | "block" | "fallback";
export type SpendingLimitScope = "defaults" | "tenants" | "departments" | "users";

export type SpendingLimitRule = {
  unit: SpendingLimitUnit;
  period: SpendingLimitPeriod;
  limit: number;
  warnThresholdPct?: number;
  action: SpendingLimitAction;
  fallbackModel?: string;
};

export type SpendingLimitDraft = SpendingLimitRule & { enabled: boolean };

type BudgetConfig = {
  updatedAt: string;
  defaults?: SpendingLimitRule;
  tenants?: Record<string, SpendingLimitRule>;
  departments?: Record<string, SpendingLimitRule>;
  users?: Record<string, SpendingLimitRule>;
};

type BudgetEnvelope = {
  code: string;
  message: string;
  data?: { budget?: BudgetConfig; tenantId?: string };
};

const EMPTY_DRAFT: SpendingLimitDraft = {
  enabled: false,
  unit: "tokens",
  period: "month",
  limit: 0,
  warnThresholdPct: 80,
  action: "block",
};

function normalizedLimit(unit: SpendingLimitUnit, value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return unit === "tokens" ? Math.floor(parsed) : parsed;
}

export function spendingLimitDraft(rule?: SpendingLimitRule | null): SpendingLimitDraft {
  if (!rule) return { ...EMPTY_DRAFT };
  const unit = rule.unit === "cost_usd" ? "cost_usd" : "tokens";
  const limit = normalizedLimit(unit, rule.limit);
  return {
    enabled: limit > 0,
    unit,
    period: rule.period === "day" || rule.period === "week" ? rule.period : "month",
    limit,
    warnThresholdPct: Math.min(100, Math.max(0, Number(rule.warnThresholdPct ?? 80))),
    action: rule.action === "warn" || rule.action === "fallback" ? rule.action : "block",
    ...(rule.fallbackModel ? { fallbackModel: rule.fallbackModel } : {}),
  };
}

export function ruleFromSpendingLimitDraft(draft: SpendingLimitDraft): SpendingLimitRule {
  return {
    unit: draft.unit,
    period: draft.period,
    limit: draft.enabled ? normalizedLimit(draft.unit, draft.limit) : 0,
    warnThresholdPct: Math.min(100, Math.max(0, Math.round(Number(draft.warnThresholdPct ?? 80)))),
    action: draft.action,
    ...(draft.action === "fallback" && draft.fallbackModel?.trim()
      ? { fallbackModel: draft.fallbackModel.trim() }
      : {}),
  };
}

export function SpendingLimitFields({
  draft,
  onChange,
  disabled = false,
  enableLabel,
  inheritDescription,
  limitLabel,
  idPrefix = "spending-limit",
}: {
  draft: SpendingLimitDraft;
  onChange: (draft: SpendingLimitDraft) => void;
  disabled?: boolean;
  enableLabel?: string;
  inheritDescription?: string;
  limitLabel?: string;
  idPrefix?: string;
}) {
  const locale = useLocale();
  const copy = (zh: string, en: string) => (locale === "en" ? en : zh);
  const resolvedEnableLabel = enableLabel ?? copy("单独设置上限", "Set a separate limit");
  const resolvedInheritDescription = inheritDescription ?? copy("关闭后继承上一级规则，不会保留一条看不见的零额度。", "When off, inherit the parent rule instead of keeping a hidden zero limit.");
  const resolvedLimitLabel = limitLabel ?? copy("上限", "Limit");
  const set = (patch: Partial<SpendingLimitDraft>) => onChange({ ...draft, ...patch });
  const unitLabel = draft.unit === "tokens" ? "Token" : "USD";

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4 rounded-xl border border-border bg-muted/20 p-4">
        <div>
          <p className="text-sm font-medium">{resolvedEnableLabel}</p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">{resolvedInheritDescription}</p>
        </div>
        <Switch
          checked={draft.enabled}
          onCheckedChange={(enabled) => set({ enabled })}
          disabled={disabled}
          aria-label={resolvedEnableLabel}
        />
      </div>

      {draft.enabled ? (
        <>
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <Label className="text-xs">{copy("限制单位（二选一）", "Limit unit (choose one)")}</Label>
              <Badge variant="secondary">{copy("当前按", "Billing by")} {unitLabel}</Badge>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <button
                type="button"
                aria-pressed={draft.unit === "tokens"}
                disabled={disabled}
                onClick={() => set({ unit: "tokens", limit: normalizedLimit("tokens", draft.limit) })}
                className={`rounded-xl border p-4 text-left transition-colors ${
                  draft.unit === "tokens"
                    ? "border-primary bg-primary/5 shadow-sm ring-1 ring-primary/20"
                    : "border-border bg-background hover:border-primary/40 hover:bg-muted/30"
                }`}
              >
                <span className="flex items-center gap-2 font-medium">
                  <Coins className="h-4 w-4 text-primary" />{copy("Token 上限", "Token limit")}
                </span>
                <span className="mt-1.5 block text-xs leading-5 text-muted-foreground">
                  {copy("按实际消耗的 Token 数量控制，适合私有部署或固定成本模型。", "Controls actual Token usage; useful for private deployments or fixed-cost models.")}
                </span>
              </button>
              <button
                type="button"
                aria-pressed={draft.unit === "cost_usd"}
                disabled={disabled}
                onClick={() => set({ unit: "cost_usd" })}
                className={`rounded-xl border p-4 text-left transition-colors ${
                  draft.unit === "cost_usd"
                    ? "border-primary bg-primary/5 shadow-sm ring-1 ring-primary/20"
                    : "border-border bg-background hover:border-primary/40 hover:bg-muted/30"
                }`}
              >
                <span className="flex items-center gap-2 font-medium">
                  <CircleDollarSign className="h-4 w-4 text-primary" />{copy("美元上限", "USD limit")}
                </span>
                <span className="mt-1.5 block text-xs leading-5 text-muted-foreground">
                  {copy("按模型价格折算后的成本控制，适合按量付费的云端模型。", "Controls cost based on model pricing; useful for pay-as-you-go cloud models.")}
                </span>
              </button>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label className="text-xs">{copy("统计周期", "Period")}</Label>
              <div className="grid grid-cols-3 rounded-lg border border-border bg-muted/20 p-1">
                {(["day", "week", "month"] as const).map((period) => (
                  <button
                    key={period}
                    type="button"
                    disabled={disabled}
                    aria-pressed={draft.period === period}
                    onClick={() => set({ period })}
                    className={`rounded-md px-2 py-2 text-xs transition-colors ${
                      draft.period === period
                        ? "bg-background font-medium text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {period === "day" ? copy("每日", "Daily") : period === "week" ? copy("每周", "Weekly") : copy("每月", "Monthly")}
                  </button>
                ))}
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor={`${idPrefix}-value`} className="text-xs">
                {resolvedLimitLabel} ({unitLabel})
              </Label>
              <div className="relative">
                <Input
                  id={`${idPrefix}-value`}
                  type="number"
                  min="0"
                  step={draft.unit === "tokens" ? "1" : "0.01"}
                  value={String(draft.limit)}
                  disabled={disabled}
                  onChange={(event) => set({ limit: Number(event.target.value || 0) })}
                  className="pr-20"
                />
                <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
                  {draft.unit === "tokens" ? "Token" : "USD"}
                </span>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor={`${idPrefix}-warning`} className="text-xs">{copy("预警阈值", "Warning threshold")}</Label>
              <div className="relative">
                <Input
                  id={`${idPrefix}-warning`}
                  type="number"
                  min="0"
                  max="100"
                  value={String(draft.warnThresholdPct ?? 80)}
                  disabled={disabled}
                  onChange={(event) => set({ warnThresholdPct: Number(event.target.value || 0) })}
                  className="pr-10"
                />
                <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">%</span>
              </div>
            </div>
            <div className="space-y-2">
              <Label className="text-xs">{copy("达到上限后", "When the limit is reached")}</Label>
              <Select
                value={draft.action}
                disabled={disabled}
                onValueChange={(action) => set({ action: action as SpendingLimitAction })}
              >
                <SelectTrigger aria-label={copy("达到上限后", "When the limit is reached")}><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="block">{copy("停止请求", "Block requests")}</SelectItem>
                  <SelectItem value="warn">{copy("仅告警，继续放行", "Warn only, continue")}</SelectItem>
                  <SelectItem value="fallback">{copy("切换到备用模型", "Use fallback model")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {draft.action === "fallback" ? (
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor={`${idPrefix}-fallback`} className="text-xs">{copy("备用模型", "Fallback model")}</Label>
                <Input
                  id={`${idPrefix}-fallback`}
                  value={draft.fallbackModel ?? ""}
                  disabled={disabled}
                  placeholder="provider/model"
                  onChange={(event) => set({ fallbackModel: event.target.value })}
                />
              </div>
            ) : null}
          </div>

          <div className="flex gap-2 rounded-lg border border-primary/20 bg-primary/5 p-3 text-xs leading-5 text-muted-foreground">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
            <p>
              {copy("这是一条单单位规则：选择 Token 后不会再按美元限制；选择美元后不会再叠加 Token 金额上限。预警阈值只负责提前提醒，是否拦截由“达到上限后”决定。", "This rule uses one unit only: Token limits do not add a USD limit, and USD limits do not add a Token cap. The warning threshold only alerts; the action is controlled by the limit behavior above.")}
            </p>
          </div>
        </>
      ) : null}
    </div>
  );
}

export function SpendingLimitEditor({
  scope,
  id,
  title,
  description,
  enableLabel,
  inheritDescription,
  limitLabel,
  variant = "inline",
  onSaved,
}: {
  scope: SpendingLimitScope;
  id?: string;
  title: string;
  description: string;
  enableLabel?: string;
  inheritDescription?: string;
  limitLabel?: string;
  variant?: "inline" | "card";
  onSaved?: () => void;
}) {
  const locale = useLocale();
  const copy = (zh: string, en: string) => (locale === "en" ? en : zh);
  const [config, setConfig] = useState<BudgetConfig | null>(null);
  const [resolvedId, setResolvedId] = useState(id ?? "");
  const [draft, setDraft] = useState<SpendingLimitDraft>(EMPTY_DRAFT);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await adminFetch("/api/metering/budget", { cache: "no-store" });
      const json = await readAdminJsonResponse<BudgetEnvelope>(response, copy("读取上限设置失败", "Failed to load limit settings"));
      if (!response.ok || json.code !== "00000" || !json.data?.budget) {
        throw new Error(json.message || copy("读取上限设置失败", "Failed to load limit settings"));
      }
      const budget = json.data.budget;
      const nextId = id ?? (scope === "tenants" ? json.data.tenantId ?? "" : "");
      const rule = scope === "defaults" ? budget.defaults : nextId ? budget[scope]?.[nextId] : undefined;
      setConfig(budget);
      setResolvedId(nextId);
      setDraft(spendingLimitDraft(rule));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : copy("读取上限设置失败", "Failed to load limit settings"));
      setConfig(null);
    } finally {
      setLoading(false);
    }
  }, [id, scope]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    if (!config || saving) return;
    if (draft.enabled && normalizedLimit(draft.unit, draft.limit) <= 0) {
      toast.error(copy(`请输入大于 0 的${draft.unit === "tokens" ? " Token" : "美元"}上限`, `Enter a limit greater than 0 ${draft.unit === "tokens" ? "tokens" : "USD"}`));
      return;
    }
    if (scope !== "defaults" && !resolvedId) {
      toast.error(copy("无法识别当前设置对象，请刷新后重试", "The current target could not be identified. Refresh and try again."));
      return;
    }
    setSaving(true);
    try {
      const rule = ruleFromSpendingLimitDraft(draft);
      let patch: Record<string, unknown>;
      if (scope === "defaults") {
        patch = { defaults: rule };
      } else {
        const map = { ...(config[scope] ?? {}) };
        if (draft.enabled) map[resolvedId] = rule;
        else delete map[resolvedId];
        patch = { [scope]: map };
      }
      const response = await adminFetch("/api/metering/budget", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedUpdatedAt: config.updatedAt, ...patch }),
      });
      const json = await readAdminJsonResponse<BudgetEnvelope>(response, copy("保存上限设置失败", "Failed to save limit settings"));
      if (!response.ok || json.code !== "00000" || !json.data?.budget) {
        throw new Error(
          response.status === 409
            ? copy("设置已被其他管理员更新，请刷新后重试", "Another administrator updated this setting. Refresh and try again.")
            : json.message || copy("保存上限设置失败", "Failed to save limit settings"),
        );
      }
      toast.success(draft.enabled ? `${title}${copy("已保存", " saved")}` : `${title}${copy("已改为继承", " now inherits")}`);
      await load();
      onSaved?.();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : copy("保存上限设置失败", "Failed to save limit settings"));
    } finally {
      setSaving(false);
    }
  };

  const body = loading ? (
    <Skeleton className="h-64 w-full" />
  ) : (
    <SpendingLimitFields
      draft={draft}
      onChange={setDraft}
      disabled={saving}
      enableLabel={enableLabel}
      inheritDescription={inheritDescription}
      limitLabel={limitLabel}
      idPrefix={`spending-limit-${scope}-${resolvedId || "default"}`}
    />
  );

  if (variant === "card") {
    return (
      <Card>
        <CardHeader className="flex-row items-start justify-between gap-4 space-y-0">
          <div className="min-w-0">
            <CardTitle>{title}</CardTitle>
            <CardDescription className="mt-1 max-w-2xl leading-6">{description}</CardDescription>
          </div>
          <Button size="sm" onClick={() => void save()} disabled={loading || saving || !config}>
            <Save className="h-4 w-4" />{saving ? "保存中…" : "保存"}
          </Button>
        </CardHeader>
        <CardContent>{body}</CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-sm font-medium">{title}</h2>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">{description}</p>
      </div>
      {body}
      <div className="flex justify-end">
        <Button size="sm" onClick={() => void save()} disabled={loading || saving || !config}>
          <Save className="h-4 w-4" />{saving ? "保存中…" : "保存上限"}
        </Button>
      </div>
    </div>
  );
}
