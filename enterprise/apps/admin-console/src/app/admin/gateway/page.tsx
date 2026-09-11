"use client";

import { Suspense, useCallback } from "react";
import { useLocale } from "next-intl";
import { useRouter, useSearchParams } from "next/navigation";
import { Bot, Database, KeyRound, Waypoints } from "lucide-react";
import {
  PageHeader,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@agenticx/ui";

import ModelProvidersPage from "../models/page";
import ChannelsPage from "../channels/page";
import RoutingPage from "../routing/page";
import AdminCachePage from "../cache/page";
import ApiTokensPage from "../api-tokens/page";
import { GatewayWorkspaceProvider } from "../../../components/gateway/GatewayWorkspaceContext";
import {
  gatewayHref,
  resolveGatewaySection,
} from "../../../lib/gateway-navigation";

export default function GatewayWorkspacePage() {
  return (
    <Suspense fallback={null}>
      <GatewayWorkspace />
    </Suspense>
  );
}

function GatewayWorkspace() {
  const locale = useLocale();
  const copy = (zh: string, en: string) => (locale === "en" ? en : zh);
  const router = useRouter();
  const params = useSearchParams();
  const active = resolveGatewaySection(params.get("section"));
  const onChange = useCallback(
    (value: string) => {
      router.replace(gatewayHref(resolveGatewaySection(value)));
    },
    [router],
  );

  return (
    <GatewayWorkspaceProvider>
      <div className="space-y-6">
        <PageHeader
          title={copy("模型与网关", "Models & Gateway")}
          description={copy(
            "统一管理模型接入、调用路径、缓存和调用凭证。",
            "Manage model providers, request routing, caching, and access credentials in one place.",
          )}
        />
        <Tabs value={active} onValueChange={onChange}>
          <TabsList aria-label={copy("模型与网关管理范围", "Models & Gateway scope")}>
            <TabsTrigger value="models">
              <Bot className="h-4 w-4" />
              {copy("模型接入", "Model providers")}
            </TabsTrigger>
            <TabsTrigger value="traffic">
              <Waypoints className="h-4 w-4" />
              {copy("通道与路由", "Channels & routing")}
            </TabsTrigger>
            <TabsTrigger value="cache">
              <Database className="h-4 w-4" />
              {copy("AI 缓存", "AI cache")}
            </TabsTrigger>
            <TabsTrigger value="credentials">
              <KeyRound className="h-4 w-4" />
              {copy("调用凭证", "API credentials")}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="models" className="pt-5">
            <ModelProvidersPage />
          </TabsContent>
          <TabsContent value="traffic" className="space-y-9 pt-5">
            <RoutingPage />
            <div className="border-t border-border pt-9">
              <ChannelsPage />
            </div>
          </TabsContent>
          <TabsContent value="cache" className="pt-5">
            <AdminCachePage />
          </TabsContent>
          <TabsContent value="credentials" className="pt-5">
            <ApiTokensPage />
          </TabsContent>
        </Tabs>
      </div>
    </GatewayWorkspaceProvider>
  );
}
