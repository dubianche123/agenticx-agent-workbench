"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Switch,
  toast,
} from "@agenticx/ui";
import {
  DEFAULT_DESKTOP_CAPABILITY_POLICY,
  normalizeDesktopCapabilityPolicy,
  type DesktopCapabilityPolicy,
} from "@agenticx/config";
import { Loader2, RefreshCcw } from "lucide-react";
import { useLocale } from "next-intl";

import { adminFetch } from "../../lib/admin-client-auth";

type Envelope<T> = { code: string; message: string; data?: T };

const SWITCHES: {
  key: keyof DesktopCapabilityPolicy;
  label: string;
  hint: string;
}[] = [
  {
    key: "allowLocalSkillInstall",
    label: "允许企业目录之外的本地 Skill",
    hint: "关闭后隐藏扫描路径和任意来源安装；能力包批准的技能仍会出现在企业应用市场。",
  },
  {
    key: "allowLocalMcpInstall",
    label: "允许企业目录之外的本地 MCP",
    hint: "关闭后隐藏配置文件路径、远程添加与 JSON 编辑；能力包分配的企业 MCP 仍会自动同步。",
  },
  {
    key: "allowMcpAutoDiscovery",
    label: "允许扫描本机 MCP 配置",
    hint: "桌面端打开 MCP 设置时会读取本机其它 AI 工具的配置路径。关闭后连扫都不扫。",
  },
];

/**
 * 桌面端自助安装的管控开关。
 *
 * 和会话额度同住 enterprise_runtime_budgets 那份配置，所以复用 /api/metering/budget，
 * 不另开接口——这三项和额度一样，都是「这个租户的桌面端受什么约束」。
 */
export function DesktopGovernancePanel() {
  const locale = useLocale();
  const copy = (zh: string, en: string) => (locale === "en" ? en : zh);
  const switches = SWITCHES.map((item) => ({
    ...item,
    label: item.key === "allowLocalSkillInstall"
      ? copy("允许企业目录之外的本地 Skill", "Allow local Skills outside the enterprise catalog")
      : item.key === "allowLocalMcpInstall"
        ? copy("允许企业目录之外的本地 MCP", "Allow local MCP outside the enterprise catalog")
        : copy("允许扫描本机 MCP 配置", "Allow scanning local MCP configuration"),
    hint: item.key === "allowLocalSkillInstall"
      ? copy("关闭后隐藏扫描路径和任意来源安装；能力包批准的技能仍会出现在企业应用市场。", "When off, hide scan paths and installation from arbitrary sources; Skills approved by capability packs remain in the enterprise market.")
      : item.key === "allowLocalMcpInstall"
        ? copy("关闭后隐藏配置文件路径、远程添加与 JSON 编辑；能力包分配的企业 MCP 仍会自动同步。", "When off, hide config paths, remote add, and JSON editing; enterprise MCP assigned by capability packs still syncs automatically.")
        : copy("桌面端打开 MCP 设置时会读取本机其它 AI 工具的配置路径。关闭后连扫都不扫。", "The desktop reads configuration paths from other local AI tools when MCP settings open. When off, it does not scan.")
  }));
  const [policy, setPolicy] = useState<DesktopCapabilityPolicy>(
    DEFAULT_DESKTOP_CAPABILITY_POLICY,
  );
  // 写回时带上读到的版本：这份配置也放着额度规则，盲写会把别人刚改的额度冲掉。
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await adminFetch("/api/metering/budget", { cache: "no-store" });
      const json = (await res.json()) as Envelope<{ budget?: Record<string, unknown> }>;
      if (!res.ok || json.code !== "00000") throw new Error(json.message || copy("读取失败", "Read failed"));
      setPolicy(normalizeDesktopCapabilityPolicy(json.data?.budget?.desktopCapabilityPolicy));
      const version = json.data?.budget?.updatedAt;
      setUpdatedAt(typeof version === "string" ? version : null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : copy("读取桌面管控失败", "Failed to load desktop governance"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const update = useCallback(
    async (key: keyof DesktopCapabilityPolicy, value: boolean) => {
      // 先本地反映，失败再回滚：开关点下去没反应比慢一点更让人怀疑是不是坏了。
      const previous = policy;
      const next = { ...policy, [key]: value };
      setPolicy(next);
      setSaving(true);
      try {
        const res = await adminFetch("/api/metering/budget", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            desktopCapabilityPolicy: next,
            ...(updatedAt ? { expectedUpdatedAt: updatedAt } : {}),
          }),
        });
        const json = (await res.json()) as Envelope<{ budget?: { updatedAt?: string } }>;
        if (!res.ok || json.code !== "00000") throw new Error(json.message || copy("保存失败", "Save failed"));
        const version = json.data?.budget?.updatedAt;
        setUpdatedAt(typeof version === "string" ? version : null);
        toast.success(copy("已保存，桌面端下次同步生效", "Saved; changes apply after the desktop syncs."));
      } catch (error) {
        setPolicy(previous);
        toast.error(error instanceof Error ? error.message : copy("保存桌面管控失败", "Failed to save desktop governance"));
      } finally {
        setSaving(false);
      }
    },
    [policy, updatedAt],
  );

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-4 space-y-0">
        <div>
          <CardTitle>{copy("桌面端自助安装", "Desktop self-service installation")}</CardTitle>
          <CardDescription>
            {copy("能力包决定企业账户应用市场的可见范围与强制下发内容；这些开关只收起官方客户端里的本地自助入口，不是操作系统级文件限制。改动随桌面端下次同步生效。", "Capability packs control enterprise-market visibility and enforced delivery. These switches only hide local self-service entry points in the official client; they are not operating-system file restrictions. Changes apply on the next desktop sync.")}
          </CardDescription>
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading || saving}>
          <RefreshCcw className="mr-2 h-4 w-4" />
          {copy("刷新", "Refresh")}
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        {switches.map((item) => (
          <div key={item.key} className="flex items-start justify-between gap-4 rounded-lg border p-4">
            <div className="min-w-0">
              <p className="font-medium">{item.label}</p>
              <p className="mt-1 text-sm text-muted-foreground">{item.hint}</p>
            </div>
            <Switch
              checked={policy[item.key]}
              disabled={loading || saving}
              onCheckedChange={(checked) => void update(item.key, checked)}
              aria-label={item.label}
            />
          </div>
        ))}
        {loading ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {copy("读取中…", "Loading…")}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
