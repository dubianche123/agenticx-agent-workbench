"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, Input, Label, Switch, toast } from "@agenticx/ui";
import { Loader2 } from "lucide-react";
import { useLocale } from "next-intl";

import { adminFetch } from "../../lib/admin-client-auth";

export type QuotaScope = "departments" | "apiTokens";

type QuotaRule = {
  monthlyTokens: number;
  dailyTokens?: number;
  weeklyTokens?: number;
  poolScope?: "" | "dept" | "tenant";
  action?: string;
};

type QuotaConfig = Record<string, unknown> & {
  departments?: Record<string, QuotaRule>;
  apiTokens?: Record<string, QuotaRule>;
};

type Envelope<T> = { code: string; message: string; data?: T };

const EMPTY: QuotaRule = { monthlyTokens: 0, action: "block" };

/**
 * 某个具体对象的额度规则。
 *
 * 原来这些规则在一个「把 ID 贴进输入框」的表里改——想给某个部门配额度，得先去别处找到
 * 那串 ULID 再粘回来。编辑器放回对象自己的上下文里（部门树上的部门、凭据页上的令牌），
 * ID 就不必出现在界面上，也不用人去记。
 *
 * 写回时只改自己这一条，其余原样带回：这份配置里还躺着别的作用域的规则，整份覆盖会把
 * 别人刚配的抹掉。
 */
export function QuotaScopeEditor({
  scope,
  id,
  onSaved,
}: {
  scope: QuotaScope;
  id: string;
  onSaved?: () => void;
}) {
  const locale = useLocale();
  const copy = (zh: string, en: string) => (locale === "en" ? en : zh);
  const [config, setConfig] = useState<QuotaConfig | null>(null);
  const [rule, setRule] = useState<QuotaRule>(EMPTY);
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await adminFetch("/api/metering/quota", { cache: "no-store" });
      const json = (await res.json()) as Envelope<{ quota?: QuotaConfig }>;
      if (!res.ok || json.code !== "00000") throw new Error(json.message || copy("读取额度失败", "Failed to load quota"));
      const quota = json.data?.quota ?? {};
      setConfig(quota);
      const existing = (quota[scope] ?? {})[id];
      setEnabled(Boolean(existing));
      setRule(existing ?? EMPTY);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : copy("读取额度失败", "Failed to load quota"));
    } finally {
      setLoading(false);
    }
  }, [id, scope]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(async () => {
    if (!config) return;
    setSaving(true);
    try {
      const map = { ...(config[scope] ?? {}) };
      // Turning the switch off removes this rule and falls back to the parent scope.
      if (enabled) map[id] = rule;
      else delete map[id];
      const res = await adminFetch("/api/metering/quota", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...config, [scope]: map }),
      });
      const json = (await res.json()) as Envelope<unknown>;
      if (!res.ok || json.code !== "00000") throw new Error(json.message || copy("保存失败", "Failed to save"));
      toast.success(enabled ? copy("额度已保存", "Quota saved") : copy("已改为继承上一级", "Now inheriting from the parent scope"));
      await load();
      onSaved?.();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : copy("保存额度失败", "Failed to save quota"));
    } finally {
      setSaving(false);
    }
  }, [config, enabled, id, load, onSaved, rule, scope]);

  if (loading) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        {copy("读取中…", "Loading…")}
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4 rounded-lg border p-3">
        <div>
          <p className="text-sm font-medium">{copy("单独设置额度", "Set a custom quota")}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {copy(
              "关闭则继承上一级（部门继承租户默认，令牌继承持有人）。",
              "When off, inherit from the parent scope (departments inherit the tenant default; tokens inherit from their holder).",
            )}
          </p>
        </div>
        <Switch checked={enabled} onCheckedChange={setEnabled} aria-label={copy("单独设置额度", "Set a custom quota")} />
      </div>

      {enabled ? (
        <div className="grid gap-3 sm:grid-cols-3">
          {(
            [
              ["monthlyTokens", copy("每月 Token", "Monthly tokens")],
              ["weeklyTokens", copy("每周 Token", "Weekly tokens")],
              ["dailyTokens", copy("每日 Token", "Daily tokens")],
            ] as const
          ).map(([field, label]) => (
            <div key={field} className="space-y-1.5">
              <Label className="text-xs">{label}</Label>
              <Input
                inputMode="numeric"
                value={String(rule[field] ?? 0)}
                onChange={(event) => {
                  const next = Number(event.target.value.replace(/[^\d]/g, "")) || 0;
                  setRule((current) => ({ ...current, [field]: next }));
                }}
              />
              <p className="text-[11px] text-muted-foreground">{copy("0 表示不限制", "0 means unlimited")}</p>
            </div>
          ))}
        </div>
      ) : null}

      <div className="flex justify-end">
        <Button size="sm" onClick={() => void save()} disabled={saving}>
          {saving ? copy("保存中…", "Saving…") : copy("保存", "Save")}
        </Button>
      </div>
    </div>
  );
}
