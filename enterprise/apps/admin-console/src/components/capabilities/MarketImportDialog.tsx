"use client";

import { useCallback, useEffect, useState } from "react";
import { useLocale } from "next-intl";
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Skeleton,
  toast,
} from "@agenticx/ui";
import { ExternalLink, Loader2, Search } from "lucide-react";

import { adminFetch } from "../../lib/admin-client-auth";
import { plainText } from "../../lib/plain-text";

type MarketSkill = {
  name: string;
  displayName: string;
  description: string;
  version: string;
  author: string;
  namespace: string;
  canonicalName: string;
  detailUrl: string;
};

type MarketMcp = {
  id: string;
  name: string;
  description: string;
  publisher: string;
  hosted: boolean;
  verified: boolean;
  detailUrl: string;
};

type McpDetail = {
  id: string;
  name: string;
  description: string;
  suggestedName: string;
  command: string;
  args: string[];
  endpoint: string;
  requiredEnv: { key: string; description: string }[];
  detailUrl: string;
};

type Envelope<T> = { code: string; message: string; data?: T };

export type MarketSource = "skill" | "mcp";

/**
 * 从外部市场挑一个登记进本企业注册表。
 *
 * 这里只把市场身份和展示元数据登记进企业目录，不下载、不执行、不判断安不安全。
 * SkillHub 的详情页不是可校验的 SKILL.md 分发文件，因此不能冒充 bundleUri：没有
 * bundleUri + digest 的条目会进入员工的企业应用市场，由员工按需安装；管理员另行配置
 * 了可校验分发文件后，Desktop 才会把它当作强制下发。
 */
export function MarketImportDialog({
  source,
  open,
  onOpenChange,
  onImported,
}: {
  source: MarketSource;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported: () => void;
}) {
  const locale = useLocale();
  const copy = (zh: string, en: string) => (locale === "en" ? en : zh);
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<(MarketSkill | MarketMcp)[]>([]);
  const [loading, setLoading] = useState(false);
  const [unreachable, setUnreachable] = useState<string | null>(null);
  const [importing, setImporting] = useState<string | null>(null);
  const [detail, setDetail] = useState<McpDetail | null>(null);
  const [mcpName, setMcpName] = useState("");
  const [mcpEnv, setMcpEnv] = useState<Record<string, string>>({});

  const search = useCallback(async () => {
    setLoading(true);
    setUnreachable(null);
    try {
      const res = await adminFetch(
        `/api/admin/registry/search?source=${source}&q=${encodeURIComponent(query)}`,
        { cache: "no-store" },
      );
      const json = (await res.json()) as Envelope<{ items?: (MarketSkill | MarketMcp)[] }>;
      if (res.status === 503) {
        // 连不上市场和搜不到东西是两回事，说清楚，否则管理员会一直换关键词。
        setUnreachable(json.message);
        setItems([]);
        return;
      }
      if (!res.ok || json.code !== "00000") throw new Error(json.message || copy("搜索失败", "Search failed"));
      setItems(json.data?.items ?? []);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : copy("搜索失败", "Search failed"));
    } finally {
      setLoading(false);
    }
  }, [query, source]);

  useEffect(() => {
    if (open) void search();
    // 打开时搜一次空关键词拿热门；关键词变化由按钮和回车触发，不做输入即搜。
  }, [open, source]);

  const importSkill = useCallback(
    async (item: MarketSkill) => {
      setImporting(item.canonicalName);
      try {
        const res = await adminFetch("/api/admin/skills", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            slug: item.canonicalName || item.name,
            displayName: item.displayName || item.name,
            description: item.description,
            version: item.version,
          }),
        });
        const json = (await res.json()) as Envelope<unknown>;
        if (!res.ok || json.code !== "00000") throw new Error(json.message || copy("登记失败", "Registration failed"));
        toast.success(`${copy("已登记", "Registered")} “${item.displayName || item.name}”`);
        onImported();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : copy("登记失败", "Registration failed"));
      } finally {
        setImporting(null);
      }
    },
    [onImported],
  );

  const openMcpDetail = useCallback(async (id: string) => {
    setImporting(id);
    try {
      const res = await adminFetch(
        `/api/admin/registry/search?source=mcp&id=${encodeURIComponent(id)}`,
        { cache: "no-store" },
      );
      const json = (await res.json()) as Envelope<{ detail?: McpDetail }>;
      if (!res.ok || json.code !== "00000" || !json.data?.detail) {
        throw new Error(json.message || copy("读取详情失败", "Failed to load details"));
      }
      const d = json.data.detail;
      setDetail(d);
      setMcpName(d.suggestedName);
      setMcpEnv(Object.fromEntries(d.requiredEnv.map((item) => [item.key, ""])));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : copy("读取详情失败", "Failed to load details"));
    } finally {
      setImporting(null);
    }
  }, []);

  const registerMcp = useCallback(async () => {
    if (!detail) return;
    setImporting(detail.id);
    try {
      // 托管地址优先：有它就不用在企业机器上装运行时。没有就登记 stdio 启动命令。
      const backendConfig = detail.endpoint
        ? { endpoint: detail.endpoint, env: mcpEnv }
        : { command: detail.command, args: detail.args, env: mcpEnv };
      const res = await adminFetch("/api/admin/mcp-servers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: mcpName.trim(),
          displayName: detail.name,
          transport: detail.endpoint ? "streamable-http" : "stdio",
          backendType: "openapi",
          backendConfig,
        }),
      });
      const json = (await res.json()) as Envelope<unknown>;
      if (!res.ok || json.code !== "00000") throw new Error(json.message || copy("登记失败", "Registration failed"));
      toast.success(`${copy("已登记", "Registered")} “${detail.name}”`);
      setDetail(null);
      onImported();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : copy("登记失败", "Registration failed"));
    } finally {
      setImporting(null);
    }
  }, [detail, mcpEnv, mcpName, onImported]);

  const isSkill = source === "skill";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isSkill ? copy("从 SkillHub 添加技能", "Add a Skill from SkillHub") : copy("从 MCP 市场添加服务", "Add an MCP service from the market")}</DialogTitle>
          <DialogDescription>
            {isSkill
              ? copy("搜索并登记进企业目录；放入能力包后员工即可看到。未配置分发文件时由员工按需安装。", "Search and register it in the enterprise catalog. Employees see it after it is added to a capability pack; without a delivery bundle, they install it on demand.")
              : copy("搜索 MCP 服务。选中后会带着名称和地址回到登记表单，凭据仍需你自己填。", "Search MCP services. Select one to bring its name and endpoint into the registration form; enter credentials yourself.")}
          </DialogDescription>
        </DialogHeader>

        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void search();
              }}
              placeholder={isSkill ? copy("搜索技能，如 Excel、财报", "Search Skills, e.g. Excel or financial reports") : copy("搜索 MCP 服务", "Search MCP services")}
              className="pl-9"
            />
          </div>
          <Button variant="outline" onClick={() => void search()} disabled={loading}>
            {copy("搜索", "Search")}
          </Button>
        </div>

        {detail ? (
          <div className="space-y-4 rounded-lg border p-4">
            <div>
              <p className="font-medium">{detail.name}</p>
              {plainText(detail.description) ? (
                <p className="mt-1 line-clamp-3 text-sm text-muted-foreground">
                  {plainText(detail.description)}
                </p>
              ) : null}
              <p className="mt-1 text-xs text-muted-foreground">
                {copy("连接方式已从市场带过来，确认后写进企业注册表。凭据市场不会给，得你自己填。", "The connection details came from the market and will be saved to the enterprise registry. The market does not provide credentials; enter them yourself.")}
              </p>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">{copy("服务名", "Service name")}</Label>
              <Input value={mcpName} onChange={(event) => setMcpName(event.target.value)} />
              <p className="text-[11px] text-muted-foreground">
                {copy("企业内唯一，员工那边按这个名字连。", "Must be unique in this enterprise; employees use this name to connect.")}
              </p>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">{copy("连接", "Connection")}</Label>
              <div className="rounded-md border bg-muted/40 px-3 py-2 font-mono text-xs">
                {detail.endpoint
                  ? detail.endpoint
                  : detail.command
                    ? [detail.command, ...detail.args].join(" ")
                    : copy("市场没有给连接信息，需要你手工补", "The market did not provide connection details; add them manually")}
              </div>
              <p className="text-[11px] text-muted-foreground">
                {detail.endpoint
                  ? copy("托管地址，不需要在企业机器上装运行时。", "Hosted endpoint; no runtime installation is needed on enterprise machines.")
                  : copy("stdio 启动命令，运行时要装在跑网关的机器上。", "stdio launch command; install the runtime on the gateway machine.")}
              </p>
            </div>

            {detail.requiredEnv.length > 0 ? (
              <div className="space-y-2">
                <Label className="text-xs">{copy("凭据", "Credentials")}</Label>
                <p className="text-[11px] text-muted-foreground">
                  {copy("这几项是本服务要访问的第三方系统的账号凭据——公司自己在那边申请的 API Key、Token。市场只声明要哪几项，不会给值。", "These credentials are for third-party systems this service accesses. Your company must obtain the API keys or tokens; the market only declares which fields are required.")}
                </p>
                {detail.requiredEnv.map((item) => (
                  <div key={item.key} className="flex items-start gap-2">
                    <div className="w-52 shrink-0">
                      <p className="truncate font-mono text-xs" title={item.key}>
                        {item.key}
                      </p>
                      {item.description ? (
                        <p className="text-[11px] leading-tight text-muted-foreground">
                          {plainText(item.description)}
                        </p>
                      ) : null}
                    </div>
                    <Input
                      type="password"
                      value={mcpEnv[item.key] ?? ""}
                      onChange={(event) =>
                        setMcpEnv((current) => ({ ...current, [item.key]: event.target.value }))
                      }
                      placeholder={copy("留空则登记后再补", "Leave blank and add it after registration")}
                    />
                  </div>
                ))}
                <p className="text-[11px] text-muted-foreground">
                  {copy("入库时加密，网关代持，不会随能力包下发到员工机器上。全公司共用这一份，所以第三方那边看到的是同一个身份；谁调用了什么只在本平台的审计日志里分得清。", "Encrypted at rest and held by the gateway; it is never delivered to employee machines. The enterprise shares this credential, while audit logs identify each caller.")}
                </p>
              </div>
            ) : null}

            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setDetail(null)}>
                {copy("返回列表", "Back to list")}
              </Button>
              <Button
                size="sm"
                disabled={!mcpName.trim() || importing !== null}
                onClick={() => void registerMcp()}
              >
                {importing ? copy("登记中…", "Registering…") : copy("登记到企业注册表", "Register in enterprise registry")}
              </Button>
            </div>
          </div>
        ) : unreachable ? (
          <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            {unreachable}
          </div>
        ) : loading ? (
          <div className="space-y-2">
            {[0, 1, 2].map((key) => (
              <Skeleton key={key} className="h-16 w-full" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">{copy("没有匹配的结果。", "No matching results.")}</p>
        ) : (
          <div className="space-y-2">
            {items.map((item) => {
              const key = isSkill ? (item as MarketSkill).canonicalName : (item as MarketMcp).id;
              const title = isSkill
                ? (item as MarketSkill).displayName || (item as MarketSkill).name
                : (item as MarketMcp).name;
              const subtitle = isSkill
                ? `${(item as MarketSkill).author} · v${(item as MarketSkill).version}`
                : (item as MarketMcp).publisher;
              return (
                <div key={key} className="flex items-start gap-3 rounded-lg border p-3">
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2 font-medium">
                      <span className="truncate">{title}</span>
                      {!isSkill && (item as MarketMcp).verified ? (
                        <Badge variant="outline" className="font-normal">
                          {copy("已认证", "Verified")}
                        </Badge>
                      ) : null}
                    </p>
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">{subtitle}</p>
                    <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                      {plainText(item.description) || copy("（无说明）", "(No description)")}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {item.detailUrl ? (
                      <Button variant="ghost" size="icon-sm" asChild title={copy("在市场里查看", "View in market")}>
                        <a href={item.detailUrl} target="_blank" rel="noreferrer noopener">
                          <ExternalLink className="h-3.5 w-3.5" />
                        </a>
                      </Button>
                    ) : null}
                    <Button
                      size="sm"
                      disabled={importing !== null}
                      onClick={() =>
                        isSkill
                          ? void importSkill(item as MarketSkill)
                          : void openMcpDetail((item as MarketMcp).id)
                      }
                    >
                      {importing === key ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : isSkill ? (
                        copy("登记", "Register")
                      ) : (
                        copy("登记…", "Register…")
                      )}
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
