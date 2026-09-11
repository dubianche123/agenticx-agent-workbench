"use client";

import { adminFetch } from "../../lib/admin-client-auth";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useLocale } from "next-intl";
import {
  Button,
  Card,
  CardContent,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  toast,
} from "@agenticx/ui";

type ComplianceConfig = {
  tenantId: string;
  dataResidency: string | null;
  crossBorderAction: "allow" | "block" | "require_approval";
  auditRetentionYears: number;
  appendOnly: boolean;
  updatedAt: string;
};

export function CompliancePanel() {
  const locale = useLocale();
  const copy = (zh: string, en: string) => (locale === "en" ? en : zh);
  const [config, setConfig] = useState<ComplianceConfig | null>(null);
  const [dataResidency, setDataResidency] = useState("");
  const [crossBorderAction, setCrossBorderAction] = useState<ComplianceConfig["crossBorderAction"]>("allow");
  const [retentionYears, setRetentionYears] = useState("6");
  const [appendOnly, setAppendOnly] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const res = await adminFetch("/api/admin/compliance");
    const payload = (await res.json()) as { data?: { config?: ComplianceConfig } };
    const cfg = payload.data?.config;
    if (!cfg) return;
    setConfig(cfg);
    setDataResidency(cfg.dataResidency ?? "");
    setCrossBorderAction(cfg.crossBorderAction === "allow" ? "allow" : "block");
    setRetentionYears(String(cfg.auditRetentionYears));
    setAppendOnly(cfg.appendOnly);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    setSaving(true);
    try {
      const res = await adminFetch("/api/admin/compliance", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          dataResidency: dataResidency.trim() || null,
          crossBorderAction,
          auditRetentionYears: Number(retentionYears),
          appendOnly,
        }),
      });
      const payload = (await res.json()) as { message?: string };
      if (!res.ok) throw new Error(payload.message ?? "save failed");
      toast.success(copy("合规设置已保存", "Compliance settings saved"));
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : copy("保存失败", "Save failed"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardContent className="grid gap-4 pt-6 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="dataResidency">{copy("数据驻留域（如 cn / us / eu）", "Data residency region (for example, cn / us / eu)")}</Label>
            <Input
              id="dataResidency"
              value={dataResidency}
              onChange={(e) => setDataResidency(e.target.value)}
              placeholder={copy("留空表示不强制驻留判定", "Leave empty to disable residency enforcement")}
            />
          </div>
          <div className="space-y-2">
            <Label>{copy("跨境命中动作", "Cross-border action")}</Label>
            <Select value={crossBorderAction} onValueChange={(v) => setCrossBorderAction(v as ComplianceConfig["crossBorderAction"])}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="allow">{copy("放行并审计打标", "Allow and audit")}</SelectItem>
                <SelectItem value="block">{copy("拦截", "Block")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="retention">{copy("审计留存年限", "Audit retention (years)")}</Label>
            <Input
              id="retention"
              type="number"
              min={1}
              max={99}
              value={retentionYears}
              onChange={(e) => setRetentionYears(e.target.value)}
            />
          </div>
          <div className="flex items-end gap-2">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={appendOnly} onChange={(e) => setAppendOnly(e.target.checked)} />
              {copy("仅追加（哈希链校验）", "Append-only (hash-chain verified)")}
            </label>
          </div>
        </CardContent>
      </Card>

      <div className="flex items-center gap-3">
        <Button onClick={() => void save()} disabled={saving}>
          {saving ? copy("保存中…", "Saving…") : copy("保存", "Save")}
        </Button>
        {config?.updatedAt ? (
          <span className="text-xs text-muted-foreground">
            {copy("上次更新：", "Last updated: ")}{new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en", {
              year: "numeric",
              month: "2-digit",
              day: "2-digit",
              hour: "2-digit",
              minute: "2-digit",
            }).format(new Date(config.updatedAt))}
          </span>
        ) : null}
        <Link href="/admin/governance?cross_border=1" className="text-sm text-primary hover:underline">
          {copy("查看跨境审计 →", "View cross-border audit →")}
        </Link>
      </div>
    </div>
  );
}
