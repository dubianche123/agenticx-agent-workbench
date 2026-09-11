"use client";

import Link from "next/link";
import { useLocale } from "next-intl";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  DEFAULT_MAX_RENDERED_PAGES,
  DOCUMENT_EXTENSIONS,
  MODEL_CAPABILITY_PRIVATE,
  MODEL_CAPABILITY_VISION,
} from "@agenticx/config";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Skeleton,
  Switch,
  toast,
} from "@agenticx/ui";
import {
  ArrowRight,
  CheckCircle2,
  CircleAlert,
  FileText,
  HardDrive,
  Image as ImageIcon,
  LockKeyhole,
  RefreshCw,
  Server,
  Settings2,
  ShieldCheck,
} from "lucide-react";

import { adminFetch } from "../../../lib/admin-client-auth";
import {
  attachmentRoutingCandidates,
  isLocalProviderRoute,
  withAttachmentCandidateState,
  type RoutingAdminModel,
  type RoutingAdminProvider,
  type RoutingProviderRoute,
} from "../../../lib/attachment-routing-admin";
import {
  GatewayPanelHeader,
  useGatewayWorkspace,
} from "../../../components/gateway/GatewayWorkspaceContext";

type ProviderRecord = RoutingAdminProvider & {
  baseUrl: string;
  apiKeyMasked: string;
  apiKeyConfigured: boolean;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
};

type ApiEnvelope<T> = { code: string; message: string; data?: T };

const ROUTE_COPY: Record<
  RoutingProviderRoute,
  { label: string; description: string }
> = {
  local: { label: "本地 / 内网", description: "企业自有机器或内网服务。" },
  "private-cloud": { label: "私有云", description: "企业隔离的专有云服务。" },
  "third-party": { label: "第三方公网", description: "不会接收受保护附件。" },
};

function modelHasCandidateTags(model: RoutingAdminModel): boolean {
  const normalized = new Set(
    (model.capabilities ?? []).map((item) => String(item).trim().toLowerCase()),
  );
  return normalized.has(MODEL_CAPABILITY_PRIVATE) && normalized.has(MODEL_CAPABILITY_VISION);
}

function StatusMark({ complete }: { complete: boolean }) {
  return complete ? (
    <CheckCircle2 className="h-5 w-5 text-success" />
  ) : (
    <CircleAlert className="h-5 w-5 text-warning" />
  );
}

export default function RoutingPage() {
  const locale = useLocale();
  const copy = (zh: string, en: string) => (locale === "en" ? en : zh);
  const routeLabel = (route: RoutingProviderRoute) => {
    const labels: Record<RoutingProviderRoute, [string, string]> = {
      local: ["本地 / 内网", "Local / private network"],
      "private-cloud": ["私有云", "Private cloud"],
      "third-party": ["第三方公网", "Third-party public cloud"],
    };
    return copy(...labels[route]);
  };
  const embedded = useGatewayWorkspace();
  const [providers, setProviders] = useState<ProviderRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingKey, setSavingKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const providerResponse = await adminFetch("/api/admin/providers", { cache: "no-store" });
      const providerJson = (await providerResponse.json()) as ApiEnvelope<{
        providers?: ProviderRecord[];
      }>;
      if (!providerResponse.ok || providerJson.code !== "00000") {
        throw new Error(providerJson.message || copy("加载模型服务失败", "Failed to load model services"));
      }
      setProviders(providerJson.data?.providers ?? []);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : copy("加载自动路由配置失败", "Failed to load attachment routing configuration"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const candidates = useMemo(() => attachmentRoutingCandidates(providers), [providers]);
  const localProviders = useMemo(
    () => providers.filter((provider) => isLocalProviderRoute(provider.route)),
    [providers],
  );
  const candidateIds = useMemo(() => new Set(candidates.map((item) => item.id)), [candidates]);
  const primaryCandidate = candidates[0] ?? null;
  const routingReady = Boolean(primaryCandidate);

  const replaceProvider = (provider: ProviderRecord) => {
    setProviders((current) => current.map((item) => (item.id === provider.id ? provider : item)));
  };

  const toggleCandidate = async (
    provider: ProviderRecord,
    model: RoutingAdminModel,
    enabled: boolean,
  ) => {
    const key = `model:${provider.id}/${model.name}`;
    setSavingKey(key);
    try {
      const capabilities = withAttachmentCandidateState(model.capabilities, enabled);
      const response = await adminFetch(
        `/api/admin/providers/${encodeURIComponent(provider.id)}/models/${encodeURIComponent(model.name)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ capabilities }),
        },
      );
      const json = (await response.json()) as ApiEnvelope<{ provider?: ProviderRecord }>;
      if (!response.ok || json.code !== "00000" || !json.data?.provider) {
        throw new Error(json.message || copy("更新附件处理模型失败", "Failed to update attachment model"));
      }
      replaceProvider(json.data.provider);
      toast.success(
        enabled
          ? `${model.label || model.name} ${copy("已可用于处理附件", "can now process attachments")}`
          : `${model.label || model.name} ${copy("已停止处理附件", "is no longer used for attachments")}`,
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : copy("更新附件处理模型失败", "Failed to update attachment model"));
    } finally {
      setSavingKey(null);
    }
  };

  const readinessCopy = routingReady
    ? {
        title: copy("附件处理模型已就绪", "Attachment model is ready"),
        description: `${primaryCandidate!.modelLabel} · ${primaryCandidate!.providerLabel}`,
        badge: copy("模型就绪", "Ready"),
      }
    : {
        title: copy("请选择附件处理模型", "Select an attachment model"),
        description: copy("请先在「模型接入」中将模型服务标记为本地。", "Mark a model service as local in Model providers first."),
        badge: copy("未配置", "Not configured"),
      };

  return (
    <div className={embedded ? "space-y-6" : "space-y-6 p-6"}>
      {embedded ? (
        <GatewayPanelHeader
          title={copy("附件自动路由", "Attachment routing")}
          description={copy("让受保护的文档和图片只交给企业本地模型。", "Send protected documents and images only to enterprise-local models.")}
          actions={
            <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading || Boolean(savingKey)}>
              <RefreshCw className={loading ? "animate-spin" : ""} />{copy("刷新配置", "Refresh")}
            </Button>
          }
        />
      ) : (
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{copy("附件自动路由", "Attachment routing")}</h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
              {copy("文档与图片自动交由企业本地模型处理，附件原始内容不发送到公网模型。", "Documents and images are processed by enterprise-local models; raw attachment content is never sent to public models.")}
            </p>
          </div>
          <Button variant="outline" onClick={() => void load()} disabled={loading || Boolean(savingKey)}>
            <RefreshCw className={loading ? "animate-spin" : ""} />{copy("刷新配置", "Refresh")}
          </Button>
        </div>
      )}

      {loading ? (
        <div className="space-y-4">
          <Skeleton className="h-52 w-full rounded-xl" />
          <Skeleton className="h-72 w-full rounded-xl" />
        </div>
      ) : (
        <>
          <Card className="relative overflow-hidden border-primary/25 bg-gradient-to-br from-primary/[0.08] via-background to-cyan-500/[0.06]">
            <div className="pointer-events-none absolute -right-16 -top-24 h-64 w-64 rounded-full bg-primary/10 blur-3xl" />
            <CardHeader className="relative">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="flex items-start gap-3">
                  <span className={`rounded-xl p-2.5 ${routingReady ? "bg-success/10 text-success" : "bg-warning/10 text-warning"}`}>
                    {routingReady ? <ShieldCheck className="h-6 w-6" /> : <CircleAlert className="h-6 w-6" />}
                  </span>
                  <div>
                    <CardTitle className="text-xl">{readinessCopy.title}</CardTitle>
                    <CardDescription className="mt-1 max-w-2xl leading-6">{readinessCopy.description}</CardDescription>
                  </div>
                </div>
                <Badge variant={routingReady ? "success" : "warning"} className="w-fit">
                  {readinessCopy.badge}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="relative space-y-5">
              <div className="grid gap-3 lg:grid-cols-[1fr_auto_1fr_auto_1fr] lg:items-stretch">
                <div className="rounded-xl border border-border/70 bg-background/80 p-4 backdrop-blur">
                  <div className="flex items-center justify-between gap-3">
                    <FileText className="h-5 w-5 text-primary" />
                    <CheckCircle2 className="h-5 w-5 text-success" />
                  </div>
                  <p className="mt-4 font-medium">1. {copy("识别附件", "Detect attachment")}</p>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    {copy("文档或图片", "Document or image")}
                  </p>
                </div>
                <ArrowRight className="mx-auto hidden self-center text-muted-foreground lg:block" />
                <div className="rounded-xl border border-border/70 bg-background/80 p-4 backdrop-blur">
                  <div className="flex items-center justify-between gap-3">
                    <Server className="h-5 w-5 text-primary" />
                    <StatusMark complete={routingReady} />
                  </div>
                  <p className="mt-4 font-medium">2. {copy("私有模型处理", "Private model processing")}</p>
                  <p className="mt-1 truncate text-xs leading-5 text-muted-foreground" title={primaryCandidate?.id}>
                    {primaryCandidate ? `${primaryCandidate.modelLabel} · ${primaryCandidate.providerLabel}` : copy("尚未选择模型", "No model selected")}
                  </p>
                </div>
                <ArrowRight className="mx-auto hidden self-center text-muted-foreground lg:block" />
                <div className="rounded-xl border border-border/70 bg-background/80 p-4 backdrop-blur">
                  <div className="flex items-center justify-between gap-3">
                    <LockKeyhole className="h-5 w-5 text-primary" />
                    <StatusMark complete={routingReady} />
                  </div>
                  <p className="mt-4 font-medium">3. {copy("保护会话", "Protect session")}</p>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    {copy("文档上下文留在私有环境", "Document context stays private")}
                  </p>
                </div>
              </div>
              <div className="grid gap-3 text-sm sm:grid-cols-3">
                <div className="rounded-lg bg-background/60 px-4 py-3">
                  <span className="text-muted-foreground">{copy("当前处理模型", "Current model")}</span>
                  <strong className="ml-2 text-foreground">{primaryCandidate?.modelLabel ?? copy("未选择", "Not selected")}</strong>
                </div>
                <div className="rounded-lg bg-background/60 px-4 py-3">
                  <span className="text-muted-foreground">{copy("运行位置", "Runtime location")}</span>
                  <strong className="ml-2 text-foreground">
                    {primaryCandidate ? routeLabel(primaryCandidate.route) : "—"}
                  </strong>
                </div>
                <div className="rounded-lg bg-background/60 px-4 py-3">
                  <span className="text-muted-foreground">{copy("文档格式", "Document formats")}</span>
                  <strong className="ml-2 text-foreground">{DOCUMENT_EXTENSIONS.length}</strong>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <CardTitle className="flex items-center gap-2 text-lg"><Server className="h-5 w-5 text-primary" />{copy("附件处理模型", "Attachment models")}</CardTitle>
                  <CardDescription className="mt-1 max-w-3xl leading-6">
                    {copy("只显示在「模型接入」中标记为本地的模型服务；私有云与第三方模型不会出现在这里。", "Only services marked Local in Model providers appear here; private-cloud and third-party models are excluded.")}
                  </CardDescription>
                </div>
                <Button asChild variant="outline" size="sm"><Link href="/admin/gateway"><Settings2 />{copy("前往模型接入", "Open model providers")}</Link></Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {localProviders.length === 0 ? (
                <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
                  {copy("还没有本地模型服务。请先到「模型接入」添加服务，或把已有服务的运行位置改为「本地 / 内网」。", "No local model services. Add one in Model providers or change an existing service's runtime location to Local / private network.")}
                </div>
              ) : localProviders.map((provider) => {
                return (
                  <section key={provider.id} className="overflow-hidden rounded-xl border border-border">
                    <div className="flex flex-col gap-3 border-b border-border bg-muted/20 p-4 md:flex-row md:items-center md:justify-between">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <h2 className="truncate font-medium">{provider.displayName}</h2>
                          <Badge variant={provider.enabled ? "success" : "secondary"}>{provider.enabled ? copy("服务启用", "Service enabled") : copy("服务停用", "Service disabled")}</Badge>
                          <Badge variant="outline" className="font-mono text-[10px]">{provider.id}</Badge>
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">{copy("运行位置", "Runtime")}: {routeLabel(provider.route)}. {copy(ROUTE_COPY[provider.route].description, provider.route === "local" ? "Enterprise-owned machine or private network service." : provider.route === "private-cloud" ? "Isolated enterprise private-cloud service." : "Does not receive protected attachments.")}</p>
                      </div>
                      <Badge variant="outline">{copy("本地 / 内网", "Local / private network")}</Badge>
                    </div>
                    <div className="divide-y divide-border">
                      {provider.models.length === 0 ? (
                        <p className="p-4 text-sm text-muted-foreground">{copy("这个服务还没有模型。", "This service has no models.")}</p>
                      ) : provider.models.map((model) => {
                        const id = `${provider.id}/${model.name}`;
                        const effective = candidateIds.has(id);
                        const tagged = modelHasCandidateTags(model);
                        const modelSaving = savingKey === `model:${id}`;
                        // 已有标记时，即便服务后来停用也必须允许管理员清掉；
                        // 新启用时则仅限当前启用的本地服务与模型。
                        const canToggle =
                          tagged ||
                          (provider.enabled &&
                            model.enabled &&
                            isLocalProviderRoute(provider.route));
                        return (
                          <div key={model.name} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
                            <div className="min-w-0">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="font-medium">{model.label || model.name}</span>
                                {primaryCandidate?.id === id ? <Badge variant="success">{copy("当前默认", "Current default")}</Badge> : effective ? <Badge variant="soft">{copy("可用于部分成员", "Available to selected members")}</Badge> : null}
                                {!model.enabled ? <Badge variant="secondary">{copy("模型停用", "Model disabled")}</Badge> : null}
                                {tagged && !effective ? <Badge variant="warning">{copy("配置未生效", "Configuration inactive")}</Badge> : null}
                              </div>
                              <p className="mt-1 truncate font-mono text-xs text-muted-foreground">{id}</p>
                              {tagged && !effective ? (
                                <p className="mt-1 text-xs text-warning">
                                  {provider.route === "third-party" ? copy("公网第三方模型不会接收受保护附件。", "Third-party public models do not receive protected attachments.") : copy("请先启用服务与模型。", "Enable the service and model first.")}
                                </p>
                              ) : null}
                            </div>
                            <div className="flex items-center justify-between gap-3 rounded-lg bg-muted/30 px-3 py-2 sm:min-w-56">
                              <div>
                                <p className="text-sm font-medium">{copy("允许处理附件", "Allow attachment processing")}</p>
                                <p className="text-xs text-muted-foreground">{copy("仅本地模型", "Local models only")}</p>
                              </div>
                              <Switch
                                checked={tagged}
                                disabled={!canToggle || modelSaving || Boolean(savingKey && !modelSaving)}
                                onCheckedChange={(checked) => void toggleCandidate(provider, model, checked)}
                                aria-label={`${model.label || model.name}: ${copy("允许处理附件", "allow attachment processing")}`}
                              />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </section>
                );
              })}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg"><HardDrive className="h-5 w-5 text-primary" />{copy("安全策略", "Security policy")}</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 lg:grid-cols-3">
              <div className="rounded-xl border border-border p-4">
                <FileText className="h-5 w-5 text-primary" />
                <p className="mt-3 font-medium">{copy("文档会话隔离", "Document session isolation")}</p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">{copy("检测到文档后，本次会话持续使用私有模型。", "After a document is detected, this session stays on the private model.")}</p>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {DOCUMENT_EXTENSIONS.map((extension) => <Badge key={extension} variant="outline" className="font-mono">{extension}</Badge>)}
                </div>
              </div>
              <div className="rounded-xl border border-border p-4">
                <ImageIcon className="h-5 w-5 text-primary" />
                <p className="mt-3 font-medium">{copy("图片私有解析", "Private image parsing")}</p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">{copy("图片在私有模型中解析，仅将文字结果返回对话。", "Images are parsed by the private model; only text results return to the conversation.")}</p>
              </div>
              <div className="rounded-xl border border-border p-4">
                <ShieldCheck className="h-5 w-5 text-primary" />
                <p className="mt-3 font-medium">{copy("PDF 单次最多", "PDF limit per request:")} {DEFAULT_MAX_RENDERED_PAGES} {copy("页", "pages")}</p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">{copy("超出部分将截断，并提示继续读取。", "Extra pages are truncated and the user is prompted to continue reading.")}</p>
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
