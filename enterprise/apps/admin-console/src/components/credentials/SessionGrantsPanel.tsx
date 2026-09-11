"use client";
import { adminFetch } from "../../lib/admin-client-auth";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Label,
  toast,
} from "@agenticx/ui";
import { Plus, Trash2 } from "lucide-react";
import { useLocale } from "next-intl";

type GrantRow = {
  id: string;
  sessionId: string;
  scopes: string[];
  expiresAt: string;
  revokedAt: string | null;
  description: string | null;
};

const SCOPE_LABELS_ZH: Record<string, string> = {
  "workspace:chat": "发起对话",
  "workspace:read": "读取工作区",
  "workspace:manage": "管理工作区",
  "metering:read": "查看用量",
};

function formatDateTime(value: string, locale: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function compactSessionId(value: string): string {
  if (value.length <= 28) return value;
  return `${value.slice(0, 10)}…${value.slice(-8)}`;
}

function grantTitle(value: string | null, locale = "zh"): string {
  const copy = (zh: string, en: string) => (locale === "en" ? en : zh);
  const description = value?.trim();
  if (!description) return copy("临时会话授权", "Temporary session grant");
  if (description === "web-portal session access") return copy("Web 门户会话", "Web portal session");
  return description;
}

export function SessionGrantsPanel() {
  const locale = useLocale();
  const copy = (zh: string, en: string) => (locale === "en" ? en : zh);
  const [grants, setGrants] = useState<GrantRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [visibleCount, setVisibleCount] = useState(20);
  const [form, setForm] = useState({ sessionId: "", scopes: "metering:read", ttlMinutes: "10", description: "" });

  const activeGrants = useMemo(() => {
    const now = Date.now();
    return grants.filter((grant) => !grant.revokedAt && new Date(grant.expiresAt).getTime() > now);
  }, [grants]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await adminFetch("/api/admin/session-grants");
      const json = (await res.json()) as { code?: string; data?: { grants?: GrantRow[] }; message?: string };
      if (!res.ok || json.code !== "00000") throw new Error(json.message || copy("加载失败", "Failed to load"));
      setGrants(json.data?.grants ?? []);
      setVisibleCount(20);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : copy("加载失败", "Failed to load"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const onCreate = async () => {
    const sessionId = form.sessionId.trim();
    const scopes = form.scopes.split(",").map((scope) => scope.trim()).filter(Boolean);
    const ttlMinutes = Number(form.ttlMinutes);
    if (!sessionId) {
      toast.error(copy("请填写会话 ID", "Enter a session ID"));
      return;
    }
    if (!scopes.length) {
      toast.error(copy("请至少填写一项权限", "Enter at least one scope"));
      return;
    }
    if (!Number.isFinite(ttlMinutes) || ttlMinutes <= 0) {
      toast.error(copy("有效期必须大于 0 分钟", "TTL must be greater than 0 minutes"));
      return;
    }
    try {
      const res = await adminFetch("/api/admin/session-grants", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionId,
          scopes,
          ttlSeconds: Math.round(ttlMinutes * 60),
          description: form.description || undefined,
        }),
      });
      const json = (await res.json()) as { code?: string; message?: string };
      if (!res.ok || json.code !== "00000") throw new Error(json.message || copy("签发失败", "Failed to issue grant"));
      toast.success(copy("会话临时授权已签发", "Temporary session grant issued"));
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : copy("签发失败", "Failed to issue grant"));
    }
  };

  const onRevoke = async (id: string) => {
    if (!window.confirm(copy("确认吊销这条会话授权？", "Revoke this session grant?"))) return;
    try {
      const res = await adminFetch(`/api/admin/session-grants?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      const json = (await res.json()) as { code?: string; message?: string };
      if (!res.ok || json.code !== "00000") throw new Error(json.message || copy("吊销失败", "Failed to revoke"));
      toast.success(copy("已吊销", "Revoked"));
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : copy("吊销失败", "Failed to revoke"));
    }
  };

  return (
    <div className="space-y-5">

      <Card>
        <CardHeader><CardTitle>{copy("签发临时授权", "Issue temporary grant")}</CardTitle></CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-2">
          <div className="space-y-1">
            <Label>Session ID</Label>
            <Input value={form.sessionId} onChange={(e) => setForm((p) => ({ ...p, sessionId: e.target.value }))} />
          </div>
          <div className="space-y-1">
            <Label>{copy("有效期（分钟）", "TTL (minutes)")}</Label>
            <Input type="number" min="1" value={form.ttlMinutes} onChange={(e) => setForm((p) => ({ ...p, ttlMinutes: e.target.value }))} />
          </div>
          <div className="space-y-1 md:col-span-2">
            <Label>Scopes ({copy("逗号分隔", "comma separated")})</Label>
            <Input value={form.scopes} onChange={(e) => setForm((p) => ({ ...p, scopes: e.target.value }))} />
          </div>
          <div className="space-y-1 md:col-span-2">
            <Label>{copy("说明", "Description")}</Label>
            <Input value={form.description} onChange={(e) => setForm((p) => ({ ...p, description: e.target.value }))} />
          </div>
          <Button type="button" onClick={onCreate} disabled={loading || !form.sessionId.trim()}>
            <Plus className="h-4 w-4" /> {copy("签发", "Issue")}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{copy("有效授权", "Active grants")} ({activeGrants.length})</CardTitle>
          <p className="text-sm text-muted-foreground">{copy("仅显示尚未到期且未吊销的授权。", "Only unexpired, non-revoked grants are shown.")}</p>
        </CardHeader>
        <CardContent className="max-h-[32rem] space-y-2 overflow-y-auto">
          {activeGrants.length === 0 ? (
            <p className="text-sm text-muted-foreground">{copy("暂无有效授权", "No active grants")}</p>
          ) : (
            activeGrants.slice(0, visibleCount).map((g) => (
              <div key={g.id} className="flex items-start justify-between gap-3 rounded-md border border-border px-3 py-2 text-sm">
                <div className="min-w-0 space-y-1">
                  <div className="font-medium">{grantTitle(g.description, locale)}</div>
                  <code className="block text-xs text-muted-foreground" title={g.sessionId}>
                    {compactSessionId(g.sessionId)}
                  </code>
                  <div className="flex flex-wrap gap-1">
                    {g.scopes.map((scope) => (
                      <Badge key={scope} variant="secondary">{locale === "en" ? scope : SCOPE_LABELS_ZH[scope] ?? scope}</Badge>
                    ))}
                  </div>
                  <div className="text-xs text-muted-foreground">{copy("有效至", "Expires")} {formatDateTime(g.expiresAt, locale)}</div>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="shrink-0 text-destructive"
                  aria-label={`${copy("吊销", "Revoke")} ${grantTitle(g.description, locale)}`}
                  onClick={() => void onRevoke(g.id)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))
          )}
          {activeGrants.length > visibleCount ? (
            <Button
              type="button"
              variant="outline"
              className="w-full"
              onClick={() => setVisibleCount((count) => count + 20)}
            >
              {copy("显示更多", "Show more")} ({copy("剩余", "remaining")} {activeGrants.length - visibleCount})
            </Button>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
